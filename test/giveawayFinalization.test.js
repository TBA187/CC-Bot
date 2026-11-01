'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    createGiveawayStore, endGiveaway, giveawayEntryCutoff, giveawayHasEnded, makeDrawId,
    startGiveawayLoop, giveawayEndedWithinRerollWindow, giveawayAutocomplete, handleGiveawayButton
} = require('../events/giveaways');
const Giveaways = require('../commands/giveaways');
const { MessageFlags } = require('discord.js');

const copy = value => JSON.parse(JSON.stringify(value));
const outage = () => Object.assign(new Error('test database disconnected'), { code: 'ECONNRESET' });
const iso = delta => new Date(Date.now() + delta).toISOString();
function record(changes = {}) {
    return { giveaway_id: 'g1', guild_id: 'guild', channel_id: 'channel', message_id: null,
        prize: 'Prize', winners_total: 1, color_hex: '#39FF14', status: 'active',
        starts_at: iso(-3600000), ends_at: iso(-60000), winner_user_ids: [], ...changes };
}
function draw(changes = {}) {
    return { draw_id: 'g1:end', giveaway_id: 'g1', draw_type: 'end', drawn_at: iso(-1000),
        eligible_count: 1, winner_user_ids: ['original'], ...changes };
}

// Offline contract model: validates generated SQL's guards, then models their
// atomic effect. It deliberately has no connection to MySQL or Discord.
class SharedDb {
    constructor(giveaway) {
        this.giveaways = new Map([[giveaway.giveaway_id, copy(giveaway)]]);
        this.entries = new Map();
        this.draws = new Map();
        this.claims = new Map();
        this.sql = [];
        this.before = null;
        this.after = null;
        this.fail = false;
    }
    isDatabaseUnavailableError(err) { return err?.code === 'ECONNRESET'; }
    live(id, token) {
        const claim = this.claims.get(id);
        return claim && claim.expires > Date.now() && (token === undefined || claim.token === token);
    }
    async getConnection() {
        if (this.fail) throw outage();
        let savedDraws, committed = false, released = false;
        return {
            beginTransaction: async () => { savedDraws = new Map(this.draws); },
            query: (sql, params) => this.query(sql, params),
            commit: async () => {
                committed = true;
                this.after?.('COMMIT GIVEAWAY DRAW', []);
            },
            rollback: async () => { if (!committed && savedDraws) this.draws = savedDraws; },
            release: () => { assert.equal(released, false); released = true; }
        };
    }
    async query(sql, params = [], retries) {
        const text = sql.replace(/\s+/g, ' ').trim();
        this.sql.push({ text, params, retries });
        if (this.fail) throw outage();
        this.before?.(text, params);
        let result;
        if (text.startsWith('SELECT giveaway_id FROM giveaways')) {
            assert.match(text, /FOR UPDATE$/);
            const id = params[0];
            const valid = this.giveaways.has(id) && (params.length > 1
                ? this.live(id, params[1]) && ['active', 'ended'].includes(this.giveaways.get(id).status)
                : !this.live(id));
            result = [valid ? [{ giveaway_id: id }] : []];
        } else if (text.startsWith('SELECT giveaway_json FROM giveaways')) {
            const rows = text.includes('WHERE giveaway_id = ?') ? [this.giveaways.get(params[0])]
                : [...this.giveaways.values()].filter(g => text.includes('end_lease_expires_at IS NULL')
                    ? !this.live(g.giveaway_id) && (g.status === 'ended' && g.end_announcement_pending
                        || g.status === 'active' && (giveawayHasEnded(g)
                            || [...this.draws.values()].some(d => d.giveaway_id === g.giveaway_id && d.draw_type === 'end')))
                    : !params.length || g.status === params[0]);
            result = [rows.filter(Boolean).map(g => ({ giveaway_json: JSON.stringify(g) }))];
        } else if (text.startsWith('SELECT DATE_FORMAT(MIN(CASE')) {
            assert.match(text, /LEAST\(giveaways.ends_at, COALESCE/);
            const dates = [...this.giveaways.values()].filter(g => g.status === 'active'
                || g.status === 'ended' && g.end_announcement_pending).map(g => {
                const due = giveawayHasEnded(g) || [...this.draws.values()].some(d => d.giveaway_id === g.giveaway_id && d.draw_type === 'end');
                if (due && this.live(g.giveaway_id)) return this.claims.get(g.giveaway_id).expires;
                return due ? Date.now() : giveawayEntryCutoff(g).getTime();
            });
            result = [[{ due_at: dates.length ? new Date(Math.min(...dates)).toISOString() : null }]];
        } else if (text.startsWith('SELECT draw_json FROM giveaway_draws')) {
            result = [[...this.draws.values()].filter(d => d.giveaway_id === params[0])
                .sort((a, b) => a.drawn_at.localeCompare(b.drawn_at) || a.draw_id.localeCompare(b.draw_id))
                .map(d => ({ draw_json: JSON.stringify(d) }))];
        } else if (text.startsWith('SELECT entry_json FROM giveaway_entries')) {
            result = [[...this.entries.values()].filter(e => e.giveaway_id === params[0]
                && (!text.includes('left_at IS NULL') || !e.left_at)).map(e => ({ entry_json: JSON.stringify(e) }))];
        } else if (text.startsWith('UPDATE giveaways SET end_lease_token = ?')) {
            assert.equal(retries, 0);
            assert.match(text, /end_announcement_pending/);
            const g = this.giveaways.get(params[1]);
            const due = g && (g.status === 'active' && (!text.includes('LEAST(')
                || giveawayHasEnded(g) || [...this.draws.values()].some(d => d.giveaway_id === params[1] && d.draw_type === 'end'))
                || g.status === 'ended' && g.end_announcement_pending);
            const acquired = due && !this.live(params[1]);
            if (acquired) this.claims.set(params[1], { token: params[0], expires: Date.now() + 300000 });
            result = [{ affectedRows: acquired ? 1 : 0 }];
        } else if (text.startsWith('UPDATE giveaways SET end_lease_expires_at =')) {
            assert.match(text, /end_lease_token = \? AND end_lease_expires_at > UTC_TIMESTAMP/);
            const renewed = this.live(params[0], params[1])
                && ['active', 'ended'].includes(this.giveaways.get(params[0])?.status);
            if (renewed) this.claims.get(params[0]).expires = Date.now() + 300000;
            result = [{ affectedRows: renewed ? 1 : 0 }];
        } else if (text.startsWith('UPDATE giveaways SET end_lease_token = NULL')) {
            assert.match(text, /WHERE giveaway_id = \? AND end_lease_token = \?/);
            const released = this.claims.get(params[0])?.token === params[1];
            if (released) this.claims.delete(params[0]);
            result = [{ affectedRows: released ? 1 : 0 }];
        } else if (text.startsWith('INSERT INTO giveaways')) {
            assert.equal(text.match(/\?/g).length, params.length);
            const incoming = JSON.parse(params[20]);
            const id = params[0], remote = this.giveaways.get(id);
            const shared = text.includes('FROM giveaways AS claimed');
            if (shared) {
                assert.match(text, /claimed.end_lease_token = \? AND claimed.end_lease_expires_at > UTC_TIMESTAMP/);
                assert.equal((text.match(/COALESCE\(giveaways.end_lease_token/g) || []).length, 20);
                assert.match(text, /giveaway_json = IF[\s\S]+, status = IF/);
            } else if (incoming.status === 'active') {
                assert.equal((text.match(/status IN \('ended', 'deleted'\)/g) || []).length, 20);
                assert.match(text, /EXISTS \(SELECT 1 FROM giveaway_draws/);
            }
            const endDraw = [...this.draws.values()].find(d => d.giveaway_id === id && d.draw_type === 'end');
            let blocked = shared ? !remote || !this.live(id, params[22]) || remote.status === 'deleted' : false;
            if (!shared && remote) {
                if (incoming.status === 'active') blocked = remote.status !== 'active' || !!endDraw || !!remote.end_requested_at;
                else if (incoming.status === 'ended') blocked = remote.status !== 'active' || !!endDraw
                    && (endDraw.draw_id !== incoming.end_draw_id || JSON.stringify(endDraw.winner_user_ids) !== JSON.stringify(incoming.winner_user_ids));
                else blocked = remote.status === 'deleted';
            }
            if (!shared && incoming.status === 'deleted' && remote) {
                this.giveaways.set(id, { ...remote, status: 'deleted', deleted_at: incoming.deleted_at, end_announcement_pending: false });
            } else if (!blocked) {
                if (remote?.end_requested_at) {
                    for (const field of ['ends_at', 'end_requested_at', 'end_requested_by_id', 'end_requested_by_name']) incoming[field] = remote[field] ?? null;
                }
                this.giveaways.set(id, incoming);
            }
            result = [{ affectedRows: blocked ? 0 : 1 }];
        } else if (text.startsWith('INSERT INTO giveaway_draws')) {
            assert.equal(text.match(/\?/g).length, params.length);
            const incoming = JSON.parse(params[7]);
            if (incoming.draw_type === 'end') {
                assert.match(text, /ON DUPLICATE KEY UPDATE draw_id = giveaway_draws.draw_id$/);
                assert.match(text, /LEFT JOIN giveaway_draws AS existing/);
                assert.match(text, /existing.draw_id IS NULL/);
                assert.doesNotMatch(text, /SELECT 1 FROM giveaway_draws/);
                const shared = text.includes('claimed.end_lease_token = ?');
                if (shared) assert.match(text, /claimed.end_lease_expires_at > UTC_TIMESTAMP/);
                const canWrite = shared ? this.live(incoming.giveaway_id, params[9]) : !this.live(incoming.giveaway_id);
                const exists = [...this.draws.values()].some(d => d.giveaway_id === incoming.giveaway_id && d.draw_type === 'end');
                if (canWrite && !exists) this.draws.set(incoming.draw_id, incoming);
            } else if (this.draws.get(incoming.draw_id)?.draw_type !== 'end') {
                this.draws.set(incoming.draw_id, incoming);
            }
            result = [{ affectedRows: 1 }];
        } else if (text.startsWith('INSERT INTO giveaway_entries')) {
            this.entries.set(`${params[0]}:${params[1]}`, JSON.parse(params[5]));
            result = [{ affectedRows: 1 }];
        } else if (text.startsWith('UPDATE giveaways SET winner_user_ids = ?')) {
            assert.match(text, /status = 'ended'/);
            assert.match(text, /end_announcement_pending/);
            const g = this.giveaways.get(params[3]);
            if (g?.status === 'ended' && !g.end_announcement_pending && (g.last_rerolled_at || '') < params[2]) {
                g.winner_user_ids = JSON.parse(params[0]);
                g.last_rerolled_at = params[2];
            }
            result = [{ affectedRows: 1 }];
        } else {
            throw new Error(`Unsupported offline SQL: ${text}`);
        }
        this.after?.(text, params);
        return result;
    }
}

function fixture(t, changes = {}, { jsonOnly = false, db = null } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-giveaway-finalize-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const g = record(changes);
    db ||= new SharedDb(g);
    const file = path.join(directory, 'giveaways.json');
    const makeStore = () => {
        const store = createGiveawayStore({ db, storageMode: jsonOnly ? 'json' : 'mysql', dataFile: file });
        store.canUseMysql = () => !jsonOnly;
        store.noteMysqlFailure = () => {};
        store.noteMysqlRestored = () => {};
        return store;
    };
    const store = makeStore();
    store.localSaveGiveaway(g.giveaway_id, g, false);
    const messages = new Map(), sends = [];
    const channel = { messages: { fetch: async () => null }, async send(payload) {
        sends.push(payload);
        if (payload.enforceNonce && messages.has(payload.nonce)) return messages.get(payload.nonce);
        const message = { id: `announcement-${messages.size + 1}` };
        messages.set(payload.nonce || message.id, message);
        return message;
    } };
    const client = { channels: { cache: { get: () => channel }, fetch: async () => channel } };
    const finish = (activeStore = store, options = {}) => endGiveaway(client, { giveawayStore: activeStore }, g,
        { drawType: 'end', ...options });
    const entry = (id, changes = {}) => {
        const e = { giveaway_id: 'g1', user_id: id, joined_at: g.starts_at, left_at: null, ...changes };
        db.entries.set(`g1:${id}`, e);
        if (jsonOnly) store.localSaveEntry('g1', id, e, false);
        return e;
    };
    return { store, db, g, file, makeStore, client, channel, sends, messages, finish, entry };
}

test('a healthy active giveaway announces at its deadline with all 70 original participants eligible', async t => {
    const f = fixture(t, { ends_at: iso(120) });
    for (let index = 0; index < 70; index++) f.entry(`eligible-${index}`);
    f.entry('too-late', { joined_at: iso(60000) });
    f.entry('withdrawn', { left_at: f.g.starts_at });
    let complete;
    const announcement = new Promise(resolve => { complete = resolve; });
    const update = f.store.updateGiveaway.bind(f.store);
    f.store.updateGiveaway = async (...args) => {
        const saved = await update(...args);
        if (saved.end_announcement_pending === false) complete(saved);
        return saved;
    };
    t.after(() => f.client.giveawayLoop?.stop());
    startGiveawayLoop(f.client, { giveawayStore: f.store });
    let timer;
    const ended = await Promise.race([announcement, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('healthy deadline missed')), 2000);
    })]).finally(() => clearTimeout(timer));
    assert.ok(Date.now() >= Date.parse(f.g.ends_at));
    assert.ok(Date.now() - Date.parse(f.g.ends_at) < 1500);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.db.draws.get('g1:end').eligible_count, 70);
    assert.match(ended.winner_user_ids[0], /^eligible-/);
    assert.equal(f.messages.size, 1);
    assert.equal(f.db.entries.size, 72, 'finalization must not delete or rewrite entries');
});

test('a controlled restart preserves an active giveaway and its participants without ending it early', async t => {
    for (const jsonOnly of [false, true]) {
        const f = fixture(t, { ends_at: iso(3600000) }, { jsonOnly });
        for (let index = 0; index < 18; index++) f.entry(`participant-${index}`);
        const restarted = f.makeStore(); await restarted.restore();
        let complete, timer;
        const firstSweep = new Promise(resolve => { complete = resolve; });
        const nextDueAt = restarted.nextDueAt.bind(restarted);
        restarted.nextDueAt = async () => {
            const deadline = await nextDueAt();
            f.client.giveawayLoop?.stop();
            complete(deadline);
            return deadline;
        };
        t.after(() => f.client.giveawayLoop?.stop());
        startGiveawayLoop(f.client, { giveawayStore: restarted });
        const deadline = await Promise.race([firstSweep, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('restart sweep did not complete')), 2000);
        })]).finally(() => clearTimeout(timer));
        assert.equal(deadline.toISOString(), f.g.ends_at);
        assert.equal((await restarted.getGiveaway('g1')).status, 'active');
        assert.equal((await restarted.listEntries('g1')).length, 18);
        assert.deepEqual(await restarted.listDraws('g1'), []);
        assert.equal(f.db.claims.size, 0);
        assert.equal(f.sends.length, 0);
    }
});

test('startup recovers three-day-overdue 70-participant giveaways and replaces the stale Enter button', async t => {
    for (const jsonOnly of [false, true]) {
        for (const state of ['active', 'saved-draw', 'pending-announcement']) {
            const f = fixture(t, { starts_at: iso(-96 * 3600000), ends_at: iso(-72 * 3600000),
                message_id: `overdue-${jsonOnly}-${state}`,
                ...(state === 'pending-announcement' ? { status: 'ended', ended_at: iso(-71 * 3600000),
                    winner_user_ids: ['eligible-0'], end_draw_id: 'g1:end', end_announcement_pending: true } : {})
            }, { jsonOnly });
            for (let index = 0; index < 70; index++) f.entry(`eligible-${index}`);
            const saved = draw({ drawn_at: iso(-71 * 3600000), eligible_count: 70, winner_user_ids: ['eligible-0'] });
            if (state !== 'active') {
                if (jsonOnly) f.store.localSaveDraw(saved.draw_id, saved, false);
                else f.db.draws.set(saved.draw_id, saved);
            }
            let publicPayload;
            const message = { id: f.g.message_id, channelId: 'channel', reply: payload => f.channel.send(payload),
                async edit(payload) { publicPayload = payload; } };
            f.channel.messages.fetch = async () => message;
            const restarted = f.makeStore(); await restarted.restore();
            assert.equal((await restarted.listEntries('g1')).length, 70);
            assert.equal((await restarted.listDueGiveaways()).length, 1);
            let complete, timer;
            const completed = new Promise(resolve => { complete = resolve; });
            const release = restarted.releaseEndClaim.bind(restarted);
            restarted.releaseEndClaim = async (...args) => {
                await release(...args);
                const current = await restarted.getGiveaway('g1');
                if (current.end_announcement_pending === false) {
                    f.client.giveawayLoop?.stop();
                    complete(current);
                }
            };
            t.after(() => f.client.giveawayLoop?.stop());
            startGiveawayLoop(f.client, { giveawayStore: restarted });
            const ended = await Promise.race([completed, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`overdue recovery failed: ${jsonOnly}/${state}`)), 4000);
            })]).finally(() => clearTimeout(timer));
            assert.equal(ended.status, 'ended');
            assert.equal(ended.end_announcement_pending, false);
            const draws = await restarted.listDraws('g1');
            assert.equal(draws.length, 1);
            assert.equal(draws[0].eligible_count, 70);
            if (state !== 'active') assert.deepEqual(draws[0], saved);
            assert.equal((await restarted.listEntries('g1')).length, 70);
            assert.equal(f.messages.size, 1);
            const controls = publicPayload.components.flatMap(row => row.toJSON().components);
            assert.ok(controls.every(control => control.custom_id !== 'cc_giveaway:join_leave'));
            assert.equal(publicPayload.content, '**🎉  Giveaway Ended!**');
        }
    }
});

test('clicking Enter on a three-day-overdue 70-participant giveaway finishes it without adding an entry', async t => {
    const f = fixture(t, { starts_at: iso(-96 * 3600000), ends_at: iso(-72 * 3600000), message_id: 'overdue-click' });
    for (let index = 0; index < 70; index++) f.entry(`eligible-${index}`);
    let publicPayload;
    const message = { id: f.g.message_id, channelId: 'channel', reply: payload => f.channel.send(payload),
        async edit(payload) { publicPayload = payload; } };
    f.channel.messages.fetch = async () => message;
    const restarted = f.makeStore(); await restarted.restore();
    const replies = [], deferrals = [];
    await handleGiveawayButton({ customId: 'cc_giveaway:join_leave', client: f.client,
        user: { id: 'late-clicker', bot: false }, message,
        member: { id: 'late-clicker', roles: { cache: { some: () => false } } },
        async deferReply(options) { deferrals.push(options); }, async editReply(payload) { replies.push(payload); }
    }, { giveawayStore: restarted });
    assert.equal(deferrals[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(replies, ['This giveaway has ended.']);
    assert.equal(f.db.entries.size, 70);
    assert.equal(f.db.draws.get('g1:end').eligible_count, 70);
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, false);
    assert.equal(f.messages.size, 1);
    assert.ok(publicPayload.components.flatMap(row => row.toJSON().components)
        .every(control => control.custom_id !== 'cc_giveaway:join_leave'));
});

test('stopping during scheduler reads cannot start a late draw or announcement', async t => {
    for (const phase of ['listDueGiveaways', 'getGiveaway']) {
        const f = fixture(t);
        f.entry('winner');
        let completeRead;
        f.store[phase] = () => new Promise(resolve => { completeRead = resolve; });
        startGiveawayLoop(f.client, { giveawayStore: f.store });
        while (!completeRead) await new Promise(resolve => setImmediate(resolve));
        f.client.giveawayLoop.stop();
        completeRead(phase === 'listDueGiveaways' ? [f.g] : f.g);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.db.draws.size, 0, phase);
        assert.equal(f.db.claims.size, 0, phase);
        assert.equal(f.messages.size, 0, phase);
        assert.equal(f.client.giveawayLoop, null, phase);
    }
});

test('a saved 70-participant draw survives a failed status update and recovery never chooses again', async t => {
    const f = fixture(t);
    for (let index = 0; index < 70; index++) f.entry(`eligible-${index}`);
    let failStatus = true;
    f.db.before = text => { if (failStatus && text.startsWith('INSERT INTO giveaways')) throw outage(); };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    const saved = copy(f.db.draws.get('g1:end'));
    assert.equal(saved.eligible_count, 70);
    assert.equal(f.db.giveaways.get('g1').status, 'active');
    assert.equal(f.sends.length, 0);
    assert.equal(f.db.claims.size, 1);
    failStatus = false;
    f.db.claims.get('g1').expires = Date.now() - 1;
    const restarted = f.makeStore(); await restarted.restore();
    const [ended, winners] = await f.finish(restarted);
    assert.deepEqual(winners, saved.winner_user_ids);
    assert.deepEqual(f.db.draws.get('g1:end'), saved);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.db.entries.size, 70);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.messages.size, 1);
});

test('the announcement and receipt are confirmed before a blocked cosmetic refresh', async t => {
    const f = fixture(t, { message_id: 'original-message' });
    f.entry('winner');
    let unblock, editing;
    const held = new Promise(resolve => { unblock = resolve; });
    const editStarted = new Promise(resolve => { editing = resolve; });
    const message = { id: 'original-message', channelId: 'channel',
        reply: payload => f.channel.send(payload), async edit() { editing(); await held; } };
    f.channel.messages.fetch = async () => message;
    const finishing = f.finish();
    try {
        await editStarted;
        assert.equal(f.messages.size, 1);
        assert.equal(f.db.giveaways.get('g1').end_announcement_pending, false);
        assert.ok(f.db.giveaways.get('g1').end_announced_at);
    } finally { unblock(); await finishing; }
});

test('delayed initial delivery starts a full reroll window and retains recovery entries and draws', async t => {
    const f = fixture(t, { status: 'ended', ends_at: iso(-5 * 86400000), ended_at: iso(-4 * 86400000),
        end_draw_id: 'g1:end', end_announcement_pending: true, winner_user_ids: ['original'] });
    f.db.draws.set('g1:end', draw({ drawn_at: f.g.ended_at }));
    f.entry('original'); f.entry('another', { joined_at: iso(-6 * 86400000) });
    assert.equal(giveawayEndedWithinRerollWindow(f.g), false);
    const deliveredAt = iso(-1000);
    f.channel.send = async () => ({ id: 'delayed-announcement', createdTimestamp: Date.parse(deliveredAt) });
    const [ended] = await f.finish();
    assert.equal(ended.end_announced_at, deliveredAt);
    assert.equal(ended.ended_at, f.g.ended_at);
    assert.equal(giveawayEndedWithinRerollWindow(ended), true);
    assert.equal(giveawayEndedWithinRerollWindow(ended, new Date(Date.parse(deliveredAt) + 48 * 3600000)), true);
    assert.equal(giveawayEndedWithinRerollWindow(ended, new Date(Date.parse(deliveredAt) + 48 * 3600000 + 1)), false);
    const restarted = f.makeStore(); await restarted.restore();
    assert.equal((await restarted.listEntries('g1')).length, 2);
    assert.equal((await restarted.listDraws('g1')).length, 1);
    const choices = await giveawayAutocomplete({ options: { getFocused: () => '' } }, { giveawayStore: restarted },
        { status: 'ended', recentEndedOnly: true });
    assert.deepEqual(choices.map(choice => choice.value), ['g1']);
    await f.finish(restarted, { drawType: 'reroll' });
    assert.equal(f.db.giveaways.get('g1').end_announced_at, deliveredAt, 'rerolls must not extend the window');
});

test('rerolls preserve original cutoff eligibility and reject expired or pending access at the service boundary', async t => {
    const f = fixture(t, { status: 'ended', ended_at: iso(-1000), end_announcement_pending: false, winner_user_ids: ['old'] });
    f.db.draws.set('g1:end', draw({ winner_user_ids: ['old'] }));
    f.entry('old');
    f.entry('eligible-at-cutoff', { left_at: iso(-1000) });
    f.entry('late-entry', { joined_at: iso(-1000) });
    const [, winners] = await f.finish(f.store, { drawType: 'reroll' });
    assert.deepEqual(winners, ['eligible-at-cutoff']);
    const count = f.db.draws.size;
    f.db.giveaways.get('g1').end_announced_at = iso(-49 * 3600000);
    await assert.rejects(f.finish(f.store, { drawType: 'reroll' }), /48-hour reroll window/);
    f.db.giveaways.get('g1').end_announcement_pending = true;
    await assert.rejects(f.finish(f.store, { drawType: 'reroll' }), /announcement is still pending/);
    assert.equal(f.db.draws.size, count);
});

test('a lost announcement receipt preserves the original delivery time without logging false finalization', async t => {
    const f = fixture(t);
    f.entry('winner');
    const logs = [];
    t.mock.method(console, 'log', text => logs.push(text));
    const deliveredAt = iso(-2 * 3600000);
    const send = f.channel.send;
    f.channel.send = async payload => ({ ...await send(payload), createdTimestamp: Date.parse(deliveredAt) });
    let failReceipt = true;
    f.db.before = (text, params) => {
        if (failReceipt && text.startsWith('INSERT INTO giveaways') && JSON.parse(params[20]).end_announcement_pending === false) throw outage();
    };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(logs.some(text => text.includes('finalized; initial announcement confirmed')), false);
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, true);
    assert.equal(f.messages.size, 1);
    failReceipt = false;
    f.db.claims.get('g1').expires = Date.now() - 1;
    const [ended] = await f.finish(f.makeStore());
    assert.equal(ended.end_announced_at, deliveredAt);
    assert.equal(f.messages.size, 1, 'recovery retains the original Discord nonce');
    assert.equal(logs.filter(text => text.includes('finalized; initial announcement confirmed')).length, 1);
});

test('the reroll command allows delayed confirmed announcements and rejects pending or expired records', async t => {
    const f = fixture(t, { status: 'ended', ends_at: iso(-80 * 3600000), ended_at: iso(-72 * 3600000),
        end_announced_at: iso(-3600000), end_announcement_pending: false, winner_user_ids: ['old'] });
    f.db.draws.set('g1:end', draw({ drawn_at: f.g.ended_at, winner_user_ids: ['old'] }));
    f.entry('new', { joined_at: iso(-90 * 3600000) });
    const config = { giveawayStore: f.store, officerRoleID: 'officer', giveawayChannelID: 'channel' };
    const command = new Giveaways(config);
    const messages = [];
    const interaction = () => ({ client: f.client, channelId: 'channel', user: { id: 'staff' },
        member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
        options: { getString: () => 'g1', getInteger: () => null },
        async deferReply() { this.deferred = true; },
        async editReply(payload) { this.replied = true; messages.push(payload); return { id: 'reroll-reply' }; },
        async followUp(payload) { messages.push(payload); } });
    await command.reroll(interaction());
    assert.equal(f.db.draws.size, 2);
    assert.ok(messages.some(payload => payload.content?.includes('Giveaway rerolled!')));
    const announcedAt = f.db.giveaways.get('g1').end_announced_at;
    assert.equal(announcedAt, f.g.end_announced_at);
    for (const [changes, expected] of [
        [{ end_announcement_pending: true }, /announcement is still pending/],
        [{ end_announcement_pending: false, end_announced_at: iso(-49 * 3600000) }, /48-hour reroll window/]
    ]) {
        Object.assign(f.db.giveaways.get('g1'), changes);
        messages.length = 0;
        await command.reroll(interaction());
        assert.match(messages[0], expected);
        assert.equal(f.db.draws.size, 2);
    }
});

test('manual outage requests survive restart and finish before the original deadline with the requesting staff identity', async t => {
    const f = fixture(t, { ends_at: iso(3600000) });
    f.entry('eligible');
    f.db.fail = true;
    await assert.rejects(f.finish(f.store, { actor: { id: 'staff', username: 'Officer' } }), { code: 'ECONNRESET' });
    const saved = JSON.parse(fs.readFileSync(f.file)).giveaways.g1;
    assert.equal(saved.ends_at, f.g.ends_at);
    assert.equal(saved.end_requested_by_id, 'staff');
    assert.equal(giveawayHasEnded(saved), true);
    f.entry('late', { joined_at: new Date(Date.parse(saved.end_requested_at) + 1).toISOString() });
    f.db.fail = false;
    const restarted = f.makeStore();
    await restarted.restore();
    const [ended, winners] = await f.finish(restarted);
    assert.equal(ended.status, 'ended');
    assert.deepEqual(winners, ['eligible']);
    assert.equal(f.db.draws.get('g1:end').drawn_by_id, 'staff');
    assert.equal(ended.ends_at, f.g.ends_at);
    assert.equal(ended.end_announcement_pending, false);
});

test('the earlier original deadline wins over a later manual request, with eligibility measured at closure', async t => {
    const f = fixture(t, { end_requested_at: iso(-1000), end_requested_by_id: 'staff' });
    assert.equal(giveawayEntryCutoff(f.g).toISOString(), f.g.ends_at);
    f.entry('left-later', { left_at: iso(-1000) });
    f.entry('left-before', { left_at: iso(-120000) });
    f.entry('late', { joined_at: iso(-1000) });
    const [, winners] = await f.finish();
    assert.deepEqual(winners, ['left-later']);
    assert.equal(f.db.draws.get('g1:end').eligible_count, 1);
});

test('read failures after claiming release only their own claim and never select a draw', async t => {
    for (const prefix of ['SELECT giveaway_json', 'SELECT draw_json', 'SELECT entry_json']) {
        const f = fixture(t);
        f.db.before = text => { if (text.startsWith(prefix) && f.db.claims.has('g1')) throw outage(); };
        await assert.rejects(f.finish(), { code: 'ECONNRESET' });
        assert.equal(f.db.claims.has('g1'), false);
        assert.equal(f.db.draws.size, 0);
        assert.equal(f.sends.length, 0);
    }
});

test('a queued entry sync failure prevents the claim and keeps the entry queue intact', async t => {
    const f = fixture(t);
    f.store.localSaveEntry('g1', 'queued', f.entry('queued'), true);
    f.db.before = text => { if (text.startsWith('INSERT INTO giveaway_entries')) throw outage(); };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.claims.has('g1'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).pendingSyncEntryIds, ['g1:queued']);
    assert.equal(f.db.draws.size, 0);
});

test('a draw commit with a lost response reuses its immutable result after read-back', async t => {
    const f = fixture(t);
    f.entry('winner');
    f.db.after = text => { if (text === 'COMMIT GIVEAWAY DRAW') { f.db.after = null; throw outage(); } };
    const [, winners] = await f.finish();
    assert.deepEqual(winners, ['winner']);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.messages.size, 1);
    assert.equal(f.db.claims.size, 0);
});

test('an uncertain draw retains its claim; recovery after expiry never redraws', async t => {
    const f = fixture(t);
    f.entry('winner');
    f.db.after = text => { if (text === 'COMMIT GIVEAWAY DRAW') { f.db.fail = true; throw outage(); } };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.claims.size, 1);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.messages.size, 0);
    f.db.fail = false;
    f.db.after = null;
    f.db.claims.get('g1').expires = Date.now() - 1;
    f.db.entries.clear();
    const restarted = f.makeStore();
    await restarted.restore();
    const [, winners] = await f.finish(restarted);
    assert.deepEqual(winners, ['winner']);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.messages.size, 1);
});

test('ended commit with a lost response is confirmed and announced without a redraw', async t => {
    const f = fixture(t);
    f.entry('winner');
    f.db.after = (text, params) => {
        if (text.startsWith('INSERT INTO giveaways') && JSON.parse(params[20]).status === 'ended') {
            f.db.after = null;
            throw outage();
        }
    };
    const [ended] = await f.finish();
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.messages.size, 1);
});

test('unreadable ended commit remains pending across restart and is claimed for announcement', async t => {
    const f = fixture(t);
    f.entry('winner');
    f.db.after = (text, params) => {
        if (text.startsWith('INSERT INTO giveaways') && JSON.parse(params[20]).status === 'ended') {
            f.db.fail = true;
            throw outage();
        }
    };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.giveaways.get('g1').status, 'ended');
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, true);
    assert.equal(f.sends.length, 0);
    f.db.fail = false;
    f.db.after = null;
    f.db.claims.get('g1').expires = Date.now() - 1;
    const restarted = f.makeStore();
    await restarted.restore();
    await f.finish(restarted);
    assert.equal(f.messages.size, 1);
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, false);
});

test('a lost announcement response stays pending and retries with Discord nonce enforcement', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    let loseResponse = true;
    f.channel.send = async payload => {
        const result = await send(payload);
        if (loseResponse) { loseResponse = false; throw new Error('Discord response lost'); }
        return result;
    };
    const [first] = await f.finish();
    assert.equal(first.end_announcement_pending, true);
    await f.finish();
    assert.equal(f.sends.length, 2);
    assert.equal(f.messages.size, 1);
    assert.equal(f.sends[0].nonce, f.sends[1].nonce);
    assert.equal(f.sends[0].nonce.length <= 25, true);
    assert.equal(f.sends[0].enforceNonce, true);
    assert.deepEqual(f.sends[0].allowedMentions, { users: [] });
});

test('a receipt commit with a lost response confirms delivery rather than sending again', async t => {
    const f = fixture(t);
    f.db.after = (text, params) => {
        if (text.startsWith('INSERT INTO giveaways') && JSON.parse(params[20]).end_announcement_pending === false) {
            f.db.after = null;
            throw outage();
        }
    };
    await f.finish();
    await f.finish();
    assert.equal(f.sends.length, 1);
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, false);
});

test('an expired or competing lease prevents writes and announcements without clearing the new owner', async t => {
    for (const mode of ['expired', 'competing']) {
        const f = fixture(t);
        f.db.after = text => {
            if (!text.startsWith('SELECT entry_json')) return;
            f.db.after = null;
            const claim = f.db.claims.get('g1');
            if (mode === 'expired') claim.expires = Date.now() - 1;
            else claim.token = 'other-host';
        };
        await assert.rejects(f.finish(), { code: 'GIVEAWAY_FINALIZATION_DEFERRED' });
        assert.equal(f.db.draws.size, 0);
        assert.equal(f.messages.size, 0);
        assert.equal(f.db.claims.size, 1);
        if (mode === 'competing') assert.equal(f.db.claims.get('g1').token, 'other-host');
    }
});

test('lease loss between renewal and a draw or status write is fenced by SQL', async t => {
    for (const table of ['giveaway_draws', 'giveaways']) {
        const f = fixture(t);
        f.db.before = text => {
            if (text.startsWith(table === 'giveaway_draws' ? 'SELECT giveaway_id FROM giveaways' : `INSERT INTO ${table} (`)) {
                f.db.before = null;
                f.db.claims.get('g1').token = 'new-host';
            }
        };
        await assert.rejects(f.finish(), { code: 'GIVEAWAY_FINALIZATION_DEFERRED' });
        assert.equal(f.db.giveaways.get('g1').status, 'active');
        assert.equal(f.db.draws.size, table === 'giveaways' ? 1 : 0);
        assert.equal(f.messages.size, 0);
        assert.equal(f.db.claims.get('g1').token, 'new-host');
    }
});

test('lease loss before announcement leaves pending work for the next host', async t => {
    const f = fixture(t);
    f.db.after = (text, params) => {
        if (text.startsWith('INSERT INTO giveaways') && JSON.parse(params[20]).status === 'ended') {
            f.db.after = null;
            f.db.claims.get('g1').token = 'other-host';
        }
    };
    await assert.rejects(f.finish(), { code: 'GIVEAWAY_FINALIZATION_DEFERRED' });
    assert.equal(f.db.giveaways.get('g1').end_announcement_pending, true);
    assert.equal(f.messages.size, 0);
    assert.equal(f.db.claims.get('g1').token, 'other-host');
});

test('overlapping and legacy end draws remain immutable and authoritative over stale local winners', async t => {
    for (const id of ['g1:end', 'g1:end:legacy']) {
        const f = fixture(t);
        const saved = draw({ draw_id: id });
        f.db.draws.set(id, saved);
        f.store.localSaveDraw('g1:end:stale', draw({ draw_id: 'g1:end:stale', winner_user_ids: ['stale'] }), false);
        const claim = await f.store.claimEnd('g1');
        const overlapping = await f.store.saveDraw('g1:end:new', draw({ winner_user_ids: ['replacement'] }), { requireMysql: true, claim });
        assert.deepEqual(overlapping.winner_user_ids, ['original']);
        assert.deepEqual(f.db.draws.get(id), saved);
        assert.equal(f.db.draws.size, 1);
        assert.deepEqual((await f.store.listDraws('g1', { requireMysql: true })).map(d => d.draw_id), [id]);
        await f.store.releaseEndClaim('g1', claim);
        const [, winners] = await f.finish();
        assert.deepEqual(winners, ['original']);
    }
});

test('stale synchronization cannot reopen or replace a result that ends between read and write', async t => {
    for (const status of ['active', 'ended']) {
        const f = fixture(t);
        f.store.localSaveGiveaway('g1', record({ status, winner_user_ids: ['stale'], ended_at: status === 'ended' ? iso(-1000) : null }), true);
        const confirmed = record({ status: 'ended', winner_user_ids: ['confirmed'], ended_at: iso(-1000), end_announcement_pending: false });
        f.db.before = text => {
            if (text.startsWith('INSERT INTO giveaways')) { f.db.before = null; f.db.giveaways.set('g1', confirmed); }
        };
        await f.store.syncPending();
        assert.deepEqual(f.db.giveaways.get('g1'), confirmed);
        assert.deepEqual(f.store.local.giveaways.g1, confirmed);
        assert.equal(f.store.hasPendingSync(), false);
    }
});

test('stale active synchronization cannot overwrite the interval between draw and ended status', async t => {
    const f = fixture(t);
    f.db.draws.set('g1:end', draw());
    f.store.localSaveGiveaway('g1', record({ prize: 'stale prize', ends_at: iso(3600000) }), true);
    await f.store.syncPending();
    assert.deepEqual(f.db.giveaways.get('g1'), f.g);
    const [, winners] = await f.finish();
    assert.deepEqual(winners, ['original']);
});

test('first manual request and its original deadline survive stale queued edits and a second staff request', async t => {
    const f = fixture(t, { ends_at: iso(3600000) });
    const first = await f.store.requestEnd('g1', { id: 'first', username: 'First' });
    f.store.localSaveGiveaway('g1', record({ ends_at: iso(7200000), end_requested_at: iso(10000), end_requested_by_id: 'second' }), true);
    await f.store.syncPending();
    const second = await f.store.requestEnd('g1', { id: 'second', username: 'Second' });
    assert.equal(second.end_requested_at, first.end_requested_at);
    assert.equal(second.end_requested_by_id, 'first');
    assert.equal(second.ends_at, f.g.ends_at);
    assert.equal(f.db.giveaways.get('g1').end_requested_by_id, 'first');
});

test('queued deletion preserves confirmed draws and metadata, and cancels pending delivery', async t => {
    const f = fixture(t, { status: 'ended', ended_at: iso(-1000), winner_user_ids: ['original'], end_announcement_pending: true });
    f.db.draws.set('g1:end', draw());
    f.store.localSaveGiveaway('g1', record({ status: 'deleted', winner_user_ids: ['stale'], deleted_at: iso(0) }), true);
    await f.store.syncPending();
    const deleted = f.db.giveaways.get('g1');
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.end_announcement_pending, false);
    assert.deepEqual(deleted.winner_user_ids, ['original']);
    assert.equal(f.db.draws.size, 1);
});

test('a queued saved end draw is synchronized immutably and later finalized', async t => {
    const f = fixture(t);
    f.store.localSaveDraw('g1:end:old', draw({ draw_id: 'g1:end:old' }), true);
    await f.store.syncPending();
    assert.equal(f.db.draws.size, 1);
    assert.equal(f.store.hasPendingSync(), false);
    assert.deepEqual((await f.finish())[1], ['original']);
});

test('rerolls retain separate IDs, eligibility rules, and narrowly synchronize queued winners', async t => {
    const f = fixture(t, { status: 'ended', ended_at: iso(-1000), winner_user_ids: ['old'], end_announcement_pending: false });
    f.db.draws.set('g1:end', draw({ winner_user_ids: ['old'] }));
    f.entry('old'); f.entry('new');
    const [, winners] = await f.finish(f.store, { drawType: 'reroll' });
    assert.deepEqual(winners, ['new']);
    assert.equal(f.db.draws.size, 2);
    assert.deepEqual(f.db.draws.get('g1:end').winner_user_ids, ['old']);
    assert.notEqual(makeDrawId('g1', 'reroll'), makeDrawId('g1', 'reroll'));
    const rerolledAt = iso(1000);
    f.store.localSaveGiveaway('g1', { ...f.g, prize: 'stale', winner_user_ids: ['queued'], last_rerolled_at: rerolledAt }, true);
    f.store.localSaveDraw('reroll:queued', draw({ draw_id: 'reroll:queued', draw_type: 'reroll', drawn_at: rerolledAt, winner_user_ids: ['queued'] }), true);
    await f.store.syncPending();
    assert.deepEqual(f.db.giveaways.get('g1').winner_user_ids, ['queued']);
    assert.equal(f.db.giveaways.get('g1').prize, 'Prize');
});

test('manual end uses the deferred public interaction and acknowledges delivery without channel fallback', async t => {
    const f = fixture(t, { ends_at: iso(3600000) });
    f.entry('winner');
    const replies = [];
    const interaction = { user: { id: 'staff', username: 'Officer' }, deferred: true,
        async editReply(payload) { replies.push(payload); return { id: 'interaction-reply' }; } };
    const [ended] = await f.finish(f.store, { actor: interaction.user, announceInteraction: interaction });
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /Giveaway ended!/);
    assert.deepEqual(replies[0].allowedMentions, { users: ['winner'] });
    assert.equal(ended.end_announcement_message_id, 'interaction-reply');
    assert.equal(f.sends.length, 0);
});

test('manual slash command reports a durably queued request publicly during an outage', async t => {
    const f = fixture(t, { ends_at: iso(3600000) });
    f.db.fail = true;
    const replies = [], deferrals = [];
    const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
    await command.end({ client: f.client, user: { id: 'staff', username: 'Officer' },
        member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
        options: { getString: () => 'g1' },
        async deferReply(options) { deferrals.push(options); }, async editReply(payload) { replies.push(payload); } });
    assert.deepEqual(deferrals, [undefined]);
    assert.match(replies[0], /end request was saved/);
    assert.equal(f.store.local.giveaways.g1.end_requested_by_id, 'staff');
    assert.notEqual(deferrals[0]?.flags, MessageFlags.Ephemeral);
});

test('JSON-only finalization and pending announcement survive restart without any database queries', async t => {
    const f = fixture(t, {}, { jsonOnly: true });
    f.db.query = async () => assert.fail('JSON-only mode must never query MySQL');
    f.entry('winner');
    f.channel.send = async () => { throw new Error('Discord unavailable'); };
    const [first] = await f.finish();
    assert.equal(first.end_announcement_pending, true);
    const restarted = f.makeStore();
    await restarted.restore();
    f.channel.send = async () => ({ id: 'recovered' });
    const [ended, winners] = await f.finish(restarted);
    assert.deepEqual(winners, ['winner']);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal((await restarted.listDraws('g1')).length, 1);
});

test('scheduler handles already-ended pending announcement work after restart', async t => {
    const f = fixture(t, { status: 'ended', ended_at: iso(-1000), end_announcement_pending: true, winner_user_ids: ['original'] });
    f.db.draws.set('g1:end', draw());
    let delivered;
    const complete = new Promise(resolve => { delivered = resolve; });
    const update = f.store.updateGiveaway.bind(f.store);
    f.store.updateGiveaway = async (...args) => {
        const saved = await update(...args);
        if (!saved.end_announcement_pending) delivered();
        return saved;
    };
    t.after(() => f.client.giveawayLoop?.stop());
    startGiveawayLoop(f.client, { giveawayStore: f.store });
    await Promise.race([complete, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('pending announcement was not recovered')), 1500);
        timer.unref();
    })]);
    assert.equal(f.messages.size, 1);
    assert.equal(f.db.draws.size, 1);
});

test('scheduler deadlines include early requests, saved draws and pending delivery, and respect a live lease', async t => {
    const f = fixture(t, { ends_at: iso(3600000) });
    assert.deepEqual(await f.store.listDueGiveaways(), []);
    assert.equal((await f.store.nextDueAt()).toISOString(), f.g.ends_at);
    await f.store.requestEnd('g1', { id: 'staff' });
    assert.equal((await f.store.listDueGiveaways()).length, 1);
    const claim = await f.store.claimEnd('g1');
    assert.deepEqual(await f.store.listDueGiveaways(), []);
    assert.equal((await f.store.nextDueAt()).getTime(), f.db.claims.get('g1').expires);
    await f.store.releaseEndClaim('g1', claim);
    assert.equal((await f.store.nextDueAt()).getTime() <= Date.now(), true);
});

test('failed synchronization of an entry queued after the claim releases it without saving a draw', async t => {
    const f = fixture(t);
    f.db.after = text => {
        if (text.startsWith('UPDATE giveaways SET end_lease_token = ?')) {
            f.db.after = null;
            f.store.localSaveEntry('g1', 'queued', f.entry('queued'), true);
        }
    };
    f.db.before = text => { if (text.startsWith('INSERT INTO giveaway_entries')) throw outage(); };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.claims.size, 0);
    assert.equal(f.db.draws.size, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).pendingSyncEntryIds, ['g1:queued']);
});

test('an uncertain claim write retains its token until expiry without attempting finalization', async t => {
    const f = fixture(t);
    f.db.after = text => {
        if (text.startsWith('UPDATE giveaways SET end_lease_token = ?')) { f.db.after = null; throw outage(); }
    };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.claims.size, 1);
    assert.equal(f.db.draws.size, 0);
    assert.equal(f.sends.length, 0);
    f.db.claims.get('g1').expires = Date.now() - 1;
    await f.finish();
    assert.equal(f.db.draws.size, 1);
});

test('a queued reroll status recovers from its saved draw even with no pending draw queue', async t => {
    const f = fixture(t, { status: 'ended', ended_at: iso(-1000), end_announcement_pending: false });
    const savedReroll = draw({ draw_id: 'saved-reroll', draw_type: 'reroll', winner_user_ids: ['rerolled'] });
    f.db.draws.set(savedReroll.draw_id, savedReroll);
    f.store.localSaveGiveaway('g1', { ...f.g, prize: 'stale prize', winner_user_ids: ['rerolled'], last_rerolled_at: savedReroll.drawn_at }, true);
    await f.store.syncPending();
    assert.deepEqual(f.db.giveaways.get('g1').winner_user_ids, ['rerolled']);
    assert.equal(f.db.giveaways.get('g1').prize, 'Prize');
    assert.equal(f.store.hasPendingSync(), false);
});

test('uncommitted draw failures roll back and release the connection without losing the claim', async t => {
    const f = fixture(t);
    f.db.after = text => { if (text.startsWith('INSERT INTO giveaway_draws')) { f.db.after = null; throw outage(); } };
    await assert.rejects(f.finish(), { code: 'ECONNRESET' });
    assert.equal(f.db.draws.size, 0);
    assert.equal(f.db.claims.size, 1);
    assert.equal(f.sends.length, 0);
    f.db.claims.get('g1').expires = Date.now() - 1;
    await f.finish();
    assert.equal(f.db.draws.size, 1);
});

test('corrupt recovery data blocks restore and subsequent replacement even in JSON-only mode', async t => {
    const f = fixture(t, {}, { jsonOnly: true });
    const bytes = '{"pendingSyncDrawIds":["valuable"],broken';
    fs.writeFileSync(f.file, bytes);
    const restarted = f.makeStore();
    const originalError = console.error;
    console.error = () => {};
    try { await assert.rejects(restarted.restore(), { code: 'JSON_STORE_CORRUPT' }); }
    finally { console.error = originalError; }
    assert.throws(() => restarted.writeJsonStore(), /recovery is paused/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
    assert.equal(fs.readdirSync(path.dirname(f.file)).filter(name => name.includes('.corrupt-')).length, 1);
});

test('legacy pending queues remain intact in JSON-only mode and are derived if older snapshots omitted IDs', async t => {
    const f = fixture(t, {}, { jsonOnly: true });
    f.store.localSaveEntry('g1', 'queued', f.entry('queued'), true);
    f.store.localSaveDraw('g1:end', draw(), true);
    f.store.localSaveGiveaway('g1', f.g, true);
    const data = JSON.parse(fs.readFileSync(f.file));
    for (const key of ['pendingSyncGiveawayIds', 'pendingSyncEntryIds', 'pendingSyncDrawIds']) delete data[key];
    fs.writeFileSync(f.file, JSON.stringify(data));
    const restarted = f.makeStore();
    await restarted.restore();
    assert.deepEqual(restarted.local.pendingSyncGiveawayIds, ['g1']);
    assert.deepEqual(restarted.local.pendingSyncEntryIds, ['g1:queued']);
    assert.deepEqual(restarted.local.pendingSyncDrawIds, ['g1:end']);
});
