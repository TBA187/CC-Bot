const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    GIVEAWAY_ACTIVE,
    GIVEAWAY_ENDED,
    createGiveawayStore,
    endGiveaway,
    giveawayEndedWithinRerollWindow,
    handleGiveawayButton,
    mergeGiveawaySyncState,
    startGiveawayLoop,
    wakeGiveawayLoop
} = require('../events/giveaways.js');
const Giveaways = require('../commands/giveaways.js');
const { ChannelType } = require('discord.js');

function tempDataFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-giveaways-'));
    return path.join(directory, 'giveaways.json');
}

function giveaway(overrides = {}) {
    return {
        giveaway_id: 'giveaway-1',
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        message_id: null,
        prize: 'Prize',
        winners_total: 1,
        status: GIVEAWAY_ACTIVE,
        starts_at: '2026-08-18T00:00:00.000Z',
        ends_at: '2026-08-18T01:00:00.000Z',
        ended_at: null,
        winner_user_ids: [],
        ...overrides
    };
}

function emptyClient() {
    return {
        channels: {
            cache: { get: () => null },
            fetch: async () => null
        }
    };
}

function lifecycleStore(initialGiveaway, { entries = [], draws = [] } = {}) {
    let current = { ...initialGiveaway };
    const savedDraws = [...draws];
    return {
        savedDraws,
        async getGiveaway() {
            return { ...current };
        },
        async listEntries() {
            return entries.map(entry => ({ ...entry }));
        },
        async listDraws() {
            return savedDraws.map(draw => ({ ...draw }));
        },
        async saveDraw(_, draw) {
            savedDraws.push({ ...draw });
            return { ...draw };
        },
        async updateGiveaway(_, updates) {
            current = { ...current, ...updates };
            return { ...current };
        }
    };
}

test('concurrent end attempts create one draw and keep the same winners', async () => {
    const initial = giveaway();
    const store = lifecycleStore(initial, {
        entries: [
            { giveaway_id: initial.giveaway_id, user_id: 'user-1', joined_at: initial.starts_at, left_at: null },
            { giveaway_id: initial.giveaway_id, user_id: 'user-2', joined_at: initial.starts_at, left_at: null }
        ]
    });
    const config = { giveawayStore: store };

    const [first, second] = await Promise.all([
        endGiveaway(emptyClient(), config, initial, { drawType: 'end' }),
        endGiveaway(emptyClient(), config, initial, { drawType: 'end' })
    ]);

    assert.equal(store.savedDraws.length, 1);
    assert.equal(first[0].status, GIVEAWAY_ENDED);
    assert.equal(second[0].status, GIVEAWAY_ENDED);
    assert.deepEqual(first[1], second[1]);
});

test('an unfinished end draw is resumed instead of selecting a second winner', async () => {
    const initial = giveaway();
    const previousDraw = {
        draw_id: 'giveaway-1:end:previous',
        giveaway_id: initial.giveaway_id,
        draw_type: 'end',
        drawn_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-2']
    };
    const store = lifecycleStore(initial, { draws: [previousDraw] });

    const [ended, winnerIds] = await endGiveaway(emptyClient(), { giveawayStore: store }, initial, {
        drawType: 'end'
    });

    assert.equal(store.savedDraws.length, 1);
    assert.equal(ended.status, GIVEAWAY_ENDED);
    assert.deepEqual(winnerIds, ['user-2']);
});

test('a saved new-version end draw keeps its notification plan after recovery', async () => {
    const initial = giveaway({ message_id: null });
    const ids = Array.from({ length: 25 }, (_, index) => String(100000000000000000n + BigInt(index)));
    const saved = { giveaway_id: initial.giveaway_id, draw_id: `${initial.giveaway_id}:end`, draw_type: 'end',
        drawn_at: initial.ends_at, winner_user_ids: ids, notification_version: 2 };
    const store = lifecycleStore(initial, { draws: [saved] });
    let delivered;
    const channel = { messages: { async fetch() { return null; } }, async send(payload) { delivered = payload; return { id: 'announcement' }; } };
    const client = { channels: { cache: { get: () => channel }, async fetch() { return channel; } } };
    const [ended, winners] = await endGiveaway(client, { giveawayStore: store }, initial, { drawType: 'end' });
    assert.equal(ended.end_notification_version, 2);
    assert.deepEqual(winners, ids);
    assert.deepEqual(delivered.allowedMentions.users, ids);
    assert.deepEqual(delivered.allowedMentions.parse, []);
});

test('a stale Join button cannot add an entry after the giveaway has ended', async () => {
    const ended = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-1']
    });
    let savedEntries = 0;
    const store = {
        async getByMessageId() {
            // Discord can hand us an interaction from the old, still-visible button.
            return [ended.giveaway_id, { ...giveaway(), message_id: 'message-1' }];
        },
        async getGiveaway() {
            return { ...ended };
        },
        async saveEntry() {
            savedEntries += 1;
        }
    };
    const replies = [];
    const interaction = {
        customId: 'ww_giveaway:join_leave',
        user: { id: 'user-2', bot: false },
        message: { id: 'message-1' },
        member: { id: 'user-2', roles: { cache: { some: () => false } } },
        deferReply: async () => {},
        editReply: async content => replies.push(content)
    };

    await handleGiveawayButton(interaction, { giveawayStore: store });

    assert.equal(savedEntries, 0);
    assert.deepEqual(replies, ['This giveaway is no longer active.']);
});

test('a Join button completes its deferred ephemeral reply without a follow-up', async () => {
    const active = giveaway({ ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    let savedEntry;
    const store = {
        async getByMessageId() { return [active.giveaway_id, active]; },
        async getGiveaway() { return active; },
        async getEntry() { return null; },
        async saveEntry(_giveawayId, _userId, entry) { savedEntry = entry; }
    };
    const replies = [];
    const interaction = {
        customId: 'cc_giveaway:join_leave',
        user: { id: 'user-2', bot: false },
        message: { id: 'message-1' },
        member: { id: 'user-2', roles: { cache: { some: () => false } } },
        client: emptyClient(),
        deferReply: async () => {},
        editReply: async payload => replies.push(payload),
        followUp: async () => assert.fail('deferred reply must be edited')
    };

    await handleGiveawayButton(interaction, { giveawayStore: store });

    assert.equal(savedEntry.user_id, 'user-2');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds.length, 1);
});

test('a stale active JSON fallback cannot reopen an ended MySQL giveaway', () => {
    const local = giveaway({ status: GIVEAWAY_ACTIVE });
    const remote = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-1']
    });

    assert.deepEqual(mergeGiveawaySyncState(local, remote), remote);
});

test('a terminal fallback update can still close an active MySQL giveaway', () => {
    const local = giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-18T01:00:00.000Z',
        winner_user_ids: ['user-2']
    });
    const remote = giveaway({ status: GIVEAWAY_ACTIVE });

    assert.deepEqual(mergeGiveawaySyncState(local, remote), local);
});

test('a manual end sends the winner announcement independently of an expired slash response', async () => {
    const initial = giveaway({ message_id: null });
    const store = lifecycleStore(initial, {
        entries: [{ giveaway_id: initial.giveaway_id, user_id: 'user-1', joined_at: initial.starts_at, left_at: null }]
    });
    let sentToChannel = 0;
    const client = {
        channels: {
            cache: {
                get: () => ({
                    send: async () => { sentToChannel += 1; return { id: 'announcement' }; }
                })
            },
            fetch: async () => null
        }
    };
    const interaction = {
        deferred: true,
        replied: false,
        editReply: async () => {
            throw new Error('interaction expired');
        }
    };

    await endGiveaway(client, { giveawayStore: store }, initial, {
        drawType: 'end',
        announceInteraction: interaction
    });

    assert.equal(sentToChannel, 1);
});

class MirrorDb {
    constructor(records) {
        this.records = records;
        this.fail = false;
    }

    async query(sql, params = []) {
        if (this.fail) throw Object.assign(new Error('database unavailable'), { code: 'ECONNRESET' });
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.startsWith('select giveaway_json from giveaways')) {
            return [this.records.giveaways.map(record => ({ giveaway_json: JSON.stringify(record) }))];
        }
        if (normalized.startsWith('select entry_json from giveaway_entries')) {
            const giveawayId = String(params[0]);
            return [(this.records.entries[giveawayId] || []).map(record => ({ entry_json: JSON.stringify(record) }))];
        }
        if (normalized.startsWith('select draw_json from giveaway_draws')) {
            const giveawayId = String(params[0]);
            return [(this.records.draws[giveawayId] || []).map(record => ({ draw_json: JSON.stringify(record) }))];
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
    }
}

test('the recovery mirror keeps active and recent giveaway entries and draws available during an outage', async () => {
    const active = giveaway({ giveaway_id: 'active' });
    const recent = giveaway({
        giveaway_id: 'recent',
        status: GIVEAWAY_ENDED,
        ended_at: new Date().toISOString(),
        winner_user_ids: ['user-2']
    });
    const old = giveaway({
        giveaway_id: 'old',
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-01T00:00:00.000Z',
        winner_user_ids: ['user-3']
    });
    const db = new MirrorDb({
        giveaways: [active, recent, old],
        entries: {
            active: [{ giveaway_id: 'active', user_id: 'user-1', joined_at: active.starts_at, left_at: null }],
            recent: [{ giveaway_id: 'recent', user_id: 'user-2', joined_at: recent.starts_at, left_at: null }],
            old: [{ giveaway_id: 'old', user_id: 'user-3', joined_at: old.starts_at, left_at: null }]
        },
        draws: {
            active: [],
            recent: [{ draw_id: 'recent:end', giveaway_id: 'recent', draw_type: 'end', drawn_at: recent.ended_at, winner_user_ids: ['user-2'] }],
            old: [{ draw_id: 'old:end', giveaway_id: 'old', draw_type: 'end', drawn_at: old.ended_at, winner_user_ids: ['user-3'] }]
        }
    });
    const file = tempDataFile();
    const savedEnvironment = {
        DB_HOST: process.env.DB_HOST,
        DB_USER: process.env.DB_USER,
        DB_NAME: process.env.DB_NAME
    };
    process.env.DB_HOST = 'localhost';
    process.env.DB_USER = 'bot';
    process.env.DB_NAME = 'cc_bot';

    try {
        const store = createGiveawayStore({ db, dataFile: file });
        await store.restore();

        const mirror = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(Object.keys(mirror.giveaways).sort(), ['active', 'old', 'recent']);
        assert.deepEqual(Object.keys(mirror.entries).sort(), ['active', 'recent']);
        assert.deepEqual(Object.keys(mirror.draws).sort(), ['recent:end']);

        db.fail = true;
        assert.deepEqual((await store.listEntries('active', { activeOnly: true })).map(entry => entry.user_id), ['user-1']);
        assert.deepEqual((await store.listDraws('recent')).map(draw => draw.draw_id), ['recent:end']);
    } finally {
        for (const [key, value] of Object.entries(savedEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('rerolls reject giveaways that ended more than 48 hours ago', () => {
    assert.equal(giveawayEndedWithinRerollWindow(giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-15T00:00:00.000Z'
    }), new Date('2026-08-18T01:00:00.000Z')), false);
    assert.equal(giveawayEndedWithinRerollWindow(giveaway({
        status: GIVEAWAY_ENDED,
        ended_at: '2026-08-17T01:00:00.000Z'
    }), new Date('2026-08-18T01:00:00.000Z')), true);
});

test('reroll access remains compatible with legacy timestamps and hides pending initial announcements', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const ended = giveaway({ status: GIVEAWAY_ENDED, ended_at: '2026-10-31T12:00:00Z' });
    assert.equal(giveawayEndedWithinRerollWindow(ended, now), true);
    assert.equal(giveawayEndedWithinRerollWindow({ ...ended, ended_at: null, ends_at: ended.ended_at }, now), true);
    assert.equal(giveawayEndedWithinRerollWindow({ ...ended, end_announced_at: 'invalid' }, now), true);
    assert.equal(giveawayEndedWithinRerollWindow({ ...ended, end_announcement_pending: true }, now), false);
    assert.equal(giveawayEndedWithinRerollWindow({ ...ended, status: GIVEAWAY_ACTIVE }, now), false);
});

test('expired giveaway clicks stop before changing entries and log briefly', async () => {
    let reads = 0;
    const originalInfo = console.info;
    const logs = [];
    console.info = message => logs.push(message);
    try {
        await handleGiveawayButton({
            customId: 'cc_giveaway:join_leave',
            user: { bot: false },
            message: { id: 'message-1' },
            deferReply: async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); }
        }, { giveawayStore: { async getByMessageId() { reads++; } } });
    } finally {
        console.info = originalInfo;
    }
    assert.equal(reads, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /expired/i);
});

test('pin option is between thumbnail and ping_roles and defaults to No in create', () => {
    const command = new Giveaways({ giveawayStore: {} });
    const create = command.data.toJSON().options.find(option => option.name === 'create');
    const names = create.options.map(option => option.name);
    assert.deepEqual(names.slice(names.indexOf('thumbnail'), names.indexOf('ping_roles') + 1),
        ['thumbnail', 'pin_giveaway', 'ping_roles']);
    const pin = create.options.find(option => option.name === 'pin_giveaway');
    assert.deepEqual(pin.choices.map(choice => [choice.name, choice.value]), [['Yes', 'yes'], ['No', 'no']]);
    assert.equal(pin.required, false);
});

test('create pins only when Yes is selected and reports a pin permission failure', async () => {
    for (const choice of [null, 'yes']) {
        let record;
        let pinCalls = 0;
        const followUps = [];
        const store = {
            async createGiveaway(value) { record = { ...value }; return record; },
            async updateGiveaway(_id, changes) { record = { ...record, ...changes }; return record; },
            async listEntries() { return []; }
        };
        const command = new Giveaways({ giveawayStore: store });
        const message = {
            id: 'message-1', url: 'https://discord.com/channels/1/2/3',
            async pin() { pinCalls++; throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); }
        };
        const interaction = {
            client: {},
            channelId: 'channel-1', guildId: 'guild-1',
            channel: { type: ChannelType.GuildText, send() {} },
            user: { id: 'user-1', username: 'Host', toString: () => '<@user-1>' },
            deferred: false, replied: false,
            options: {
                getInteger: () => 1,
                getString: name => ({ duration: '1h', prize: 'Prize', pin_giveaway: choice })[name] ?? null,
                getAttachment: () => null
            },
            async deferReply() { this.deferred = true; },
            async editReply() {},
            async fetchReply() { return message; },
            async followUp(payload) { followUps.push(payload); }
        };
        const originalWarn = console.warn;
        console.warn = () => {};
        try { await command.create(interaction); }
        finally { console.warn = originalWarn; }
        assert.equal(record.pin_giveaway, choice === 'yes');
        assert.equal(pinCalls, choice === 'yes' ? 1 : 0);
        assert.equal(followUps.length, 1);
        assert.equal(followUps[0].content.includes('could not pin'), choice === 'yes');
    }
});

test('a shared MySQL end claim is atomic and released only with its token', async () => {
    let owner = null;
    const db = {
        async query(sql, params, retries) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim().toUpperCase();
            if (normalized.startsWith('UPDATE GIVEAWAYS SET END_LEASE_TOKEN = NULL')) {
                assert.equal(retries, 1);
                if (owner === params[1]) { owner = null; return [{ affectedRows: 1 }]; }
                return [{ affectedRows: 0 }];
            }
            if (normalized.startsWith('UPDATE GIVEAWAYS SET END_LEASE_TOKEN = ?')) {
                assert.equal(retries, 0);
                assert.match(normalized, /END_LEASE_EXPIRES_AT IS NULL OR END_LEASE_EXPIRES_AT <= UTC_TIMESTAMP/);
                if (owner) return [{ affectedRows: 0 }];
                owner = params[0];
                return [{ affectedRows: 1 }];
            }
            throw new Error(`Unexpected SQL: ${normalized}`);
        }
    };
    const makeStore = () => {
        const store = createGiveawayStore({ db, storageMode: 'mysql', dataFile: tempDataFile() });
        store.canUseMysql = () => true;
        return store;
    };
    const first = makeStore();
    const second = makeStore();
    const firstClaim = await first.claimEnd('giveaway-1');
    assert.ok(firstClaim?.shared);
    assert.equal(await second.claimEnd('giveaway-1'), null);
    await second.releaseEndClaim('giveaway-1', { shared: true, token: 'wrong-token' });
    assert.equal(await second.claimEnd('giveaway-1'), null);
    await first.releaseEndClaim('giveaway-1', firstClaim);
    assert.ok((await second.claimEnd('giveaway-1'))?.shared);
});

test('an uncertain end draw keeps its shared claim until expiry', async () => {
    let releases = 0;
    let strictWrite = false;
    const initial = giveaway();
    const store = {
        async claimEnd() { return { shared: true, token: 'claimed' }; },
        async renewEndClaim() { return true; },
        async releaseEndClaim() { releases++; },
        async getGiveaway() { return initial; },
        async listDraws() { return []; },
        async listEntries() { return []; },
        async saveDraw(_id, _draw, options) {
            strictWrite = options.requireMysql;
            throw Object.assign(new Error('connection lost while saving draw'), { code: 'ECONNRESET' });
        }
    };
    await assert.rejects(endGiveaway(emptyClient(), { giveawayStore: store }, initial, { drawType: 'end' }),
        { code: 'ECONNRESET' });
    assert.equal(strictWrite, true);
    assert.equal(releases, 0);
});

test('a failed read releases the shared claim because no draw write was attempted', async () => {
    let releases = 0;
    const initial = giveaway();
    const store = {
        async claimEnd() { return { shared: true, token: 'claimed' }; },
        async releaseEndClaim() { releases++; },
        async getGiveaway(_id, options) {
            assert.equal(options.requireMysql, true);
            throw Object.assign(new Error('connection lost while reading'), { code: 'ECONNRESET' });
        }
    };
    await assert.rejects(endGiveaway(emptyClient(), { giveawayStore: store }, initial, { drawType: 'end' }),
        { code: 'ECONNRESET' });
    assert.equal(releases, 1);
});

test('a shared end does not announce a draw without a saved giveaway state', async () => {
    let releases = 0;
    const initial = giveaway();
    const store = {
        async claimEnd() { return { shared: true, token: 'claimed' }; },
        async renewEndClaim() { return true; },
        async releaseEndClaim() { releases++; },
        async getGiveaway() { return initial; },
        async listDraws() { return []; },
        async listEntries() { return []; },
        async saveDraw(_id, draw) { return draw; },
        async updateGiveaway() { return null; }
    };
    await assert.rejects(endGiveaway(emptyClient(), { giveawayStore: store }, initial, { drawType: 'end' }),
        /disappeared before its end was saved/);
    assert.equal(releases, 0);
});

test('a shared end refuses cached giveaway, entry, and draw reads after MySQL fails', async () => {
    const db = {
        async query() { throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }); }
    };
    const store = createGiveawayStore({ db, storageMode: 'mysql', dataFile: tempDataFile() });
    store.canUseMysql = () => true;
    store.cacheGiveaway(giveaway());
    store.cacheEntry({ giveaway_id: 'giveaway-1', user_id: 'user-1', joined_at: giveaway().starts_at, left_at: null });
    store.cacheDraw({ draw_id: 'draw-1', giveaway_id: 'giveaway-1', draw_type: 'end' });
    await assert.rejects(store.getGiveaway('giveaway-1', { requireMysql: true }), { code: 'ECONNRESET' });
    await assert.rejects(store.listEntries('giveaway-1', { activeOnly: true, requireMysql: true }), { code: 'ECONNRESET' });
    await assert.rejects(store.listDraws('giveaway-1', { requireMysql: true }), { code: 'ECONNRESET' });
});

test('giveaway scheduler wakes at the next end and on explicit changes', async () => {
    const client = {};
    const calls = [];
    let resolveSecond;
    const second = new Promise(resolve => { resolveSecond = resolve; });
    const store = {
        async syncPending() {},
        async listDueGiveaways() {
            calls.push(Date.now());
            if (calls.length === 2) resolveSecond();
            return [];
        },
        async nextDueAt() {
            return calls.length === 1 ? new Date(calls[0] + 80) : null;
        }
    };
    try {
        startGiveawayLoop(client, { giveawayStore: store });
        await Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('scheduler did not wake')), 1000))]);
        assert.ok(calls[1] - calls[0] < 500);
        wakeGiveawayLoop(client);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(calls.length >= 3);
    } finally {
        client.giveawayLoop?.stop();
    }
});

test('safe giveaway SQL retries once, while end claims do not', async () => {
    const attempts = new Map();
    const db = {
        async query(sql, _params, retries = 2) {
            const key = String(sql).trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase();
            for (let attempt = 0; attempt <= retries; attempt++) {
                attempts.set(key, (attempts.get(key) || 0) + 1);
                if (attempt === 0) {
                    const err = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
                    if (retries === 0) throw err;
                    continue;
                }
                if (key === 'SELECT DRAW_JSON FROM') return [[{ draw_json: JSON.stringify({
                    draw_id: 'giveaway-1:end', giveaway_id: 'giveaway-1', draw_type: 'end', winner_user_ids: []
                }) }]];
                if (key.startsWith('SELECT')) return [[{ giveaway_json: JSON.stringify(giveaway()) }]];
                return [{ affectedRows: 1 }];
            }
        }
    };
    const store = createGiveawayStore({ db, storageMode: 'mysql', dataFile: tempDataFile() });
    store.canUseMysql = () => true;
    assert.equal((await store.mysqlGetGiveaway('giveaway-1')).giveaway_id, 'giveaway-1');
    await store.mysqlSaveGiveaway('giveaway-1', giveaway());
    await store.mysqlSaveEntry('giveaway-1', 'user-1', { joined_at: giveaway().starts_at });
    await store.mysqlSaveDraw('draw-1', { giveaway_id: 'giveaway-1', draw_type: 'reroll', drawn_at: giveaway().ends_at });
    await store.releaseEndClaim('giveaway-1', { shared: true, token: 'exact-token' });
    assert.equal(attempts.get('SELECT GIVEAWAY_JSON FROM'), 4);
    assert.equal(attempts.get('INSERT INTO GIVEAWAYS'), 2);
    assert.equal(attempts.get('INSERT INTO GIVEAWAY_ENTRIES'), 2);
    assert.equal(attempts.get('INSERT INTO GIVEAWAY_DRAWS'), 2);
    assert.equal(attempts.get('UPDATE GIVEAWAYS SET'), 2);
    await assert.rejects(store.claimEnd('giveaway-1'), { code: 'ECONNRESET' });
    assert.equal(attempts.get('UPDATE GIVEAWAYS SET'), 3);
});
