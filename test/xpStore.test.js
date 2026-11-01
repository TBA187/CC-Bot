const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const { XpStore } = require('../utils/xpStore');
const { processXp, configureXpRecovery } = require('../utils/xpEngine');
const { recordRawActivity, fetchSpecialTracks } = require('../utils/xpDbHelper');
const { getTotalXpForLevel, getLevelFromTotalXp } = require('../utils/xpMath');
const xpSettings = require('../config/xpConfig');

const clone = value => structuredClone(value);
const fail = code => Object.assign(new Error(code), { code });
const KEY = 'guild/user/global';
const emptyRow = () => ({ xp_amount: 0, level: 0, xp_date: null,
    message_xp: 0, reaction_xp: 0, command_xp: 0, voice_xp: 0,
    messages_sent: 0, reactions_added: 0, commands_used: 0, voice_minutes: 0,
    total_messages_sent: 0, total_reactions_added: 0, total_commands_used: 0, total_voice_minutes: 0 });
const trackRow = () => ({ id: 7, name: 'PvP XP', role_ids: ['eligible-role'], channel_ids: ['channel'],
    level_rewards: [1, 2], cooldown_overrides: { message: 30 }, send_level_up_msg: 1,
    tag_user_level_up_msg: 1, color: '#C0C0C0', created_at: '2026-01-01 00:00:00' });

// Transactions have isolated working copies and a shared lock, including between two stores.
class Database {
    constructor() {
        this.users = new Map();
        this.receipts = new Map();
        this.schema = true;
        this.offline = false;
        this.fault = null;
        this.calls = [];
        this.tail = Promise.resolve();
    }
    isDatabaseUnavailableError(error) { return error.code === 'ECONNRESET'; }
    check(stage) {
        if (this.offline) throw fail('ECONNRESET');
        if (this.fault === stage) { this.fault = null; throw fail('ECONNRESET'); }
    }
    async query(sql, params = []) {
        this.calls.push({ sql, params });
        this.check('pool');
        if (/FROM xp_channel_tracks/u.test(sql)) { this.check('track-read'); return [[trackRow()]]; }
        if (/FROM xp_rewards/u.test(sql)) {
            this.check('reward-read');
            return [[{ id: 1, level: 1, role_id: 'reward-one', description: 'First reward' },
                { id: 2, level: 2, role_id: 'reward-two', description: 'Second reward' }]];
        }
        throw new Error(`Unexpected pool SQL: ${sql}`);
    }
    async getConnection() {
        this.check('connection');
        const database = this;
        let users, receipts, unlock, committed = false;
        return {
            async beginTransaction() {
                const previous = database.tail;
                database.tail = new Promise(resolve => { unlock = resolve; });
                await previous;
                database.check('begin');
                users = clone(database.users); receipts = clone(database.receipts);
            },
            async query(sql, params) {
                database.check('query');
                database.calls.push({ sql, params });
                if (/xp_applied_operations/u.test(sql) && !database.schema) throw fail('ER_NO_SUCH_TABLE');
                if (/INSERT INTO xp_applied_operations/u.test(sql)) {
                    if (receipts.has(params[0])) throw fail('ER_DUP_ENTRY');
                    receipts.set(params[0], null);
                    return [{ affectedRows: 1 }];
                }
                if (/SELECT result_json/u.test(sql)) return [[{ result_json: receipts.get(params[0]) }]];
                if (/INSERT INTO xp_user_levels/u.test(sql)) {
                    database.check('increment');
                    const columns = sql.match(/xp_user_levels \(([^)]+)\)/u)[1].split(',').map(column => column.trim());
                    let parameterIndex = 0;
                    const values = Object.fromEntries(columns.map(column => [column, column === 'level' ? 0 : params[parameterIndex++]]));
                    const key = `${values.guild_id}/${values.user_id}/${values.xp_type}`;
                    const row = users.get(key) || emptyRow();
                    for (const [column, value] of Object.entries(values)) {
                        if (['user_id', 'guild_id', 'xp_type', 'level'].includes(column)) continue;
                        if (column === 'username') row[column] = value;
                        else if (column === 'xp_date') row[column] ??= new Date(value * 1000).toISOString();
                        else row[column] += value;
                    }
                    users.set(key, row);
                    return [{ affectedRows: 1 }];
                }
                if (/SELECT xp_amount, level/u.test(sql)) {
                    const row = users.get(`${params[1]}/${params[0]}/${params[2]}`);
                    return [row ? [{ xp_amount: row.xp_amount, level: row.level }] : []];
                }
                if (/UPDATE xp_user_levels SET level/u.test(sql)) {
                    database.check('level');
                    users.get(`${params[2]}/${params[1]}/${params[3]}`).level = params[0];
                    return [{ affectedRows: 1 }];
                }
                if (/UPDATE xp_applied_operations/u.test(sql)) {
                    database.check('receipt'); receipts.set(params[1], params[0]); return [{ affectedRows: 1 }];
                }
                throw new Error(`Unexpected transaction SQL: ${sql}`);
            },
            async commit() {
                database.check('commit-before');
                database.users = users; database.receipts = receipts; committed = true;
                database.check('commit-after');
            },
            async rollback() { if (!committed) { users = null; receipts = null; } },
            release() { unlock?.(); }
        };
    }
}

function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-xp-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('cc-xp-test-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const db = options.db || new Database();
    const filePath = path.join(directory, 'xp.json');
    const messages = [], roles = [], logs = [];
    const logger = { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) };
    const store = new XpStore({ db, filePath, logger, ...options });
    db.xpStore = store;
    const member = { id: 'user', displayName: 'Player / Alt',
        user: { username: 'Player', displayAvatarURL: () => 'https://example.com/avatar.png' },
        roles: { cache: new Collection([['eligible-role', { id: 'eligible-role' }]]),
            add: async id => { roles.push(id); member.roles.cache.set(id, { id }); } } };
    const guild = { id: 'guild', members: { cache: new Collection([['user', member]]), fetch: async () => member },
        channels: { cache: new Collection([['log', { send: async payload => messages.push(payload) }]]) } };
    const config = { db, botChannelID: 'log',
        client: { guilds: { cache: new Collection([['guild', guild]]), fetch: async () => guild } } };
    configureXpRecovery(config);
    t.after(() => store.stopSyncLoop());
    return { db, store, filePath, messages, roles, logs, member, guild, config };
}
const globalTrack = () => ({ type: 'global', xpType: 'global', dbTrackName: 'global', color: '#5865F2' });
const award = (f, amount = 20, track = globalTrack(), action = 'message', count = 1) =>
    processXp('user', f.guild, 'channel', f.member, amount, track, f.config, action, count);
async function recover(store) { store.nextAttemptAt = 0; await store.flush(); }

for (const action of ['message', 'reaction', 'command', 'voice']) {
    test(`${action} awards and raw activity keep their existing independent counters`, async t => {
        const f = fixture(t);
        const count = action === 'voice' ? 12 : 1;
        await recordRawActivity(f.db, 'user', 'guild', 'Player / Alt', 'global', action, count);
        await award(f, 20, globalTrack(), action, count);
        const row = f.db.users.get(KEY);
        const stat = { message: 'messages_sent', reaction: 'reactions_added', command: 'commands_used', voice: 'voice_minutes' }[action];
        assert.equal(row.xp_amount, 20);
        assert.equal(row[`${action}_xp`], 20);
        assert.equal(row[stat], count);
        assert.equal(row[`total_${stat}`], count);
        assert.equal(row.username, 'Player / Alt');
        assert.equal(row.level, getLevelFromTotalXp(20));
        assert.equal(f.store.pendingCount, 0);
        assert.equal(f.messages.length, 0);
        assert.equal(f.db.receipts.size, 2);
        assert.equal(JSON.parse(fs.readFileSync(f.filePath)).operations.length, 0);
    });
}

test('outage saves original amounts, tracks, counters and time; a restarted store replays them once', async t => {
    const f = fixture(t);
    f.db.offline = true;
    for (const track of [globalTrack(), { ...globalTrack(), xpType: '7', dbTrackName: '7' }]) {
        await recordRawActivity(f.db, 'user', 'guild', 'Player / Alt', track.xpType, 'voice', 7);
        await award(f, 29, track, 'voice', 7);
    }
    const saved = JSON.parse(fs.readFileSync(f.filePath));
    assert.equal(saved.operations.length, 4);
    assert.deepEqual(saved.operations.map(operation => operation.xpGained), [0, 29, 0, 29]);
    assert.equal(f.db.users.size, 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.store.hasPending('guild', '7', 'user'), true);
    const restarted = new XpStore({ db: f.db, filePath: f.filePath, logger: { log() {}, warn() {} } });
    f.db.offline = false;
    await restarted.flush();
    await restarted.flush();
    assert.equal(restarted.pendingCount, 0);
    for (const track of ['global', '7']) {
        const row = f.db.users.get(`guild/user/${track}`);
        assert.equal(row.voice_xp, 29);
        assert.equal(row.voice_minutes, 7);
        assert.equal(row.total_voice_minutes, 7);
        assert.equal(row.xp_date, saved.operations.find(operation => operation.xpType === track).occurredAt);
    }
    assert.equal(f.db.receipts.size, 4);
});

for (const stage of ['increment', 'level', 'receipt', 'commit-before', 'commit-after']) {
    test(`failure at ${stage} can recover without lost or duplicated XP/level-ups`, async t => {
        const f = fixture(t);
        f.db.fault = stage;
        const amount = getTotalXpForLevel(1);
        await award(f, amount);
        assert.equal(f.store.pendingCount, 1);
        assert.equal(f.messages.length, 0);
        assert.equal(f.db.users.get(KEY)?.xp_amount || 0, stage === 'commit-after' ? amount : 0);
        await recover(f.store);
        await recover(f.store);
        assert.equal(f.db.users.get(KEY).xp_amount, amount);
        assert.equal(f.db.users.get(KEY).level, 1);
        assert.equal(f.db.receipts.size, 1);
        assert.equal(f.store.pendingCount, 0);
        assert.equal(f.messages.length, Number(xpSettings.global.sendLevelUpMsg));
    });
}

test('an uncertain committed award survives restart and retains its original level-up result', async t => {
    const f = fixture(t);
    f.db.fault = 'commit-after';
    await award(f, getTotalXpForLevel(1));
    const restarted = new XpStore({ db: f.db, filePath: f.filePath, logger: { log() {}, warn() {} } });
    f.db.xpStore = restarted;
    configureXpRecovery(f.config);
    await restarted.flush();
    assert.equal(f.db.users.get(KEY).xp_amount, getTotalXpForLevel(1));
    assert.equal(f.messages.length, Number(xpSettings.global.sendLevelUpMsg));
    assert.equal(restarted.pendingCount, 0);
});

test('two stores replaying the same saved operation share one receipt and increment', async t => {
    const f = fixture(t);
    f.db.offline = true;
    await award(f);
    const secondFile = path.join(path.dirname(f.filePath), 'second.json');
    fs.copyFileSync(f.filePath, secondFile);
    const second = new XpStore({ db: f.db, filePath: secondFile, logger: { log() {}, warn() {} } });
    f.db.offline = false;
    await Promise.all([recover(f.store), second.flush()]);
    assert.equal(f.db.users.get(KEY).xp_amount, 20);
    assert.equal(f.db.receipts.size, 1);
    assert.equal(f.store.pendingCount, 0);
    assert.equal(second.pendingCount, 0);
});

test('concurrent awards cannot overwrite pending JSON or lose counters', async t => {
    const f = fixture(t);
    await Promise.all(Array.from({ length: 18 }, () => award(f, 1)));
    await recover(f.store);
    assert.equal(f.db.users.get(KEY).xp_amount, 18);
    assert.equal(f.db.users.get(KEY).messages_sent, 18);
    assert.equal(f.db.receipts.size, 18);
    assert.equal(f.store.pendingCount, 0);
});

test('special-track level rewards and embed text keep their existing behavior', async t => {
    const f = fixture(t);
    const tracks = await fetchSpecialTracks(f.db);
    await award(f, getTotalXpForLevel(2), { ...tracks[0], dbTrackName: '7' });
    assert.deepEqual(f.roles, ['reward-one', 'reward-two']);
    assert.equal(f.db.users.get('guild/user/7').level, 2);
    assert.equal(f.messages.length, 1);
    const payload = f.messages[0], embed = payload.embeds[0].toJSON();
    assert.equal(payload.content, '<@user>  🎉');
    assert.equal(embed.title, '🏆\u2002Level Up!');
    assert.equal(embed.color, 0xC0C0C0);
    assert.match(embed.description, /PvP XP/u);
    assert.match(embed.description, /<@&eligible-role>/u);
    assert.match(embed.description, /<#channel>/u);
    assert.match(embed.description, /Level \*\*1\*\*: <@&reward-one>/u);
    assert.match(embed.description, /First reward/u);
    assert.match(embed.description, /Second reward/u);
    assert.equal(embed.fields[0].value, `${getTotalXpForLevel(2)} / ${getTotalXpForLevel(3)} XP`);
    assert.equal(embed.fields[1].value, `${getTotalXpForLevel(3) - getTotalXpForLevel(2)} XP`);
    assert.equal(payload.files[0].name, 'cc_logo.webp');
});

for (const stage of ['track-read', 'reward-read']) {
    test(`a ${stage} outage postpones rewards without losing or re-awarding committed XP`, async t => {
        const f = fixture(t);
        const tracks = await fetchSpecialTracks(f.db);
        f.db.fault = stage;
        await award(f, getTotalXpForLevel(1), { ...tracks[0], dbTrackName: '7' });
        assert.equal(f.store.pendingCount, 1);
        assert.equal(f.db.users.get('guild/user/7').level, 1);
        assert.equal(f.messages.length, 0);
        assert.equal(f.roles.length, 0);
        await recover(f.store);
        assert.equal(f.db.users.get('guild/user/7').xp_amount, getTotalXpForLevel(1));
        assert.deepEqual(f.roles, ['reward-one']);
        assert.equal(f.messages.length, 1);
        assert.equal(f.store.pendingCount, 0);
    });
}

test('saved special-track settings survive an offline restart and keep role/channel eligibility', async t => {
    const f = fixture(t);
    const tracks = await fetchSpecialTracks(f.db);
    assert.equal(tracks.length, 1);
    const offlineDb = new Database(); offlineDb.offline = true;
    offlineDb.xpStore = new XpStore({ db: offlineDb, filePath: f.filePath });
    t.mock.method(console, 'warn', () => {});
    const { getXPTracksForUser } = require('../utils/xpHelper');
    const eligible = await getXPTracksForUser(f.member, 'channel', offlineDb);
    assert.ok(eligible.some(track => track.dbTrackName === '7'));
    assert.ok(!(await getXPTracksForUser(f.member, 'other-channel', offlineDb)).some(track => track.dbTrackName === '7'));
    assert.ok(!(await getXPTracksForUser({ ...f.member, roles: { cache: new Collection() } }, 'channel', offlineDb))
        .some(track => track.dbTrackName === '7'));
    assert.deepEqual(offlineDb.xpStore.getSpecialTracks(), tracks);
});

test('backoff prevents every offline message from attempting MySQL or spamming logs', async t => {
    const f = fixture(t);
    f.db.offline = true;
    await Promise.all(Array.from({ length: 5 }, () => award(f)));
    const calls = f.db.calls.length;
    await award(f);
    await f.store.flush();
    assert.equal(f.db.calls.length, calls);
    assert.equal(f.store.pendingCount, 6);
    assert.equal(f.logs.length, 1);
});

test('a missing receipt table preserves the journal and does not attempt runtime schema changes', async t => {
    const f = fixture(t);
    f.db.schema = false;
    await award(f);
    assert.equal(f.store.pendingCount, 1);
    assert.equal(f.db.users.size, 0);
    assert.equal(f.db.receipts.size, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.filePath)).operations.length, 1);
    assert.ok(f.db.calls.every(call => !/CREATE TABLE|ALTER TABLE|LIMIT 0/u.test(call.sql)));
    f.db.schema = true;
    await recover(f.store);
    assert.equal(f.db.users.get(KEY).xp_amount, 20);
    assert.equal(f.store.pendingCount, 0);
});

test('a full disk cannot acknowledge or apply an operation that was not safely journaled', async t => {
    const f = fixture(t);
    t.mock.method(f.store, 'persist', () => { throw fail('ENOSPC'); });
    await assert.rejects(f.store.record({ kind: 'award', userId: 'user', guildId: 'guild', username: 'Player',
        xpType: 'global', actionType: 'message', xpGained: 20, statCount: 1 }), { code: 'ENOSPC' });
    assert.equal(f.db.receipts.size, 0);
    assert.equal(f.db.users.size, 0);
    assert.equal(f.store.pendingCount, 0);
});

test('corrupt recovery JSON is preserved and never silently replaced', t => {
    const f = fixture(t);
    fs.writeFileSync(f.filePath, '{broken');
    assert.throws(() => f.store.restore(), SyntaxError);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), '{broken');
});

test('shutdown leaves queued awards on disk and prevents later database or Discord work', async t => {
    const signal = new AbortController();
    const f = fixture(t, { shutdownSignal: signal.signal });
    f.db.offline = true;
    await award(f);
    signal.abort(); f.store.stopSyncLoop();
    f.db.offline = false;
    await recover(f.store);
    await award(f);
    assert.equal(f.store.pendingCount, 1);
    assert.equal(f.db.users.size, 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.store.startSyncLoop(), undefined);
});
for (const action of ['message', 'reaction', 'command', 'voice']) {
    test(`uncertain ${action} activity saves cannot double-count raw activity`, async t => {
        const f = fixture(t);
        f.db.fault = 'commit-after';
        await recordRawActivity(f.db, 'user', 'guild', 'Player', 'global', action, 3);
        assert.equal(f.store.pendingCount, 1);
        await recover(f.store);
        const stat = { message: 'messages_sent', reaction: 'reactions_added', command: 'commands_used', voice: 'voice_minutes' }[action];
        assert.equal(f.db.users.get(KEY)[`total_${stat}`], 3);
        assert.equal(f.db.users.get(KEY).xp_amount, 0);
        assert.equal(f.store.pendingCount, 0);
        assert.equal(f.db.receipts.size, 1);
    });
}

test('global level-up embed retains its title, congratulation, progress and mention settings', async t => {
    const original = xpSettings.global.sendLevelUpMsg;
    xpSettings.global.sendLevelUpMsg = true;
    t.after(() => { xpSettings.global.sendLevelUpMsg = original; });
    const f = fixture(t);
    await award(f, getTotalXpForLevel(1));
    assert.equal(f.messages.length, 1);
    const payload = f.messages[0], embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, '🏆\u2002Level Up!');
    assert.equal(embed.description, 'Congratulations <@user>! You reached level **1**\u2002🎉');
    assert.equal(embed.fields[0].value, `${getTotalXpForLevel(1)} / ${getTotalXpForLevel(2)} XP`);
    assert.equal(embed.fields[1].value, `${getTotalXpForLevel(2) - getTotalXpForLevel(1)} XP`);
    assert.equal(payload.content, xpSettings.global.tagUserLevelUpMsg ? '<@user>  🎉' : undefined);
});

test('message cooldowns, raw counts and role/channel eligibility remain unchanged during an outage', async t => {
    const f = fixture(t);
    await fetchSpecialTracks(f.db);
    const onCooldown = new Set();
    f.config.onCooldown = (user, key) => {
        if (onCooldown.has(key)) return true;
        onCooldown.add(key); return false;
    };
    f.db.offline = true;
    t.mock.method(Math, 'random', () => 0);
    const message = { author: { id: 'user', bot: false }, guild: f.guild, member: f.member,
        channelId: 'channel', content: 'hello', attachments: new Collection(),
        channel: { isThread: () => false, isVoiceBased: () => false } };
    const handler = require('../events/levels/xpMessageHandler');
    await handler.execute(message, f.config);
    await handler.execute(message, f.config);
    const pending = JSON.parse(fs.readFileSync(f.filePath)).operations;
    const awards = pending.filter(operation => operation.kind === 'award');
    assert.equal(awards.length, 2);
    assert.deepEqual(awards.map(operation => operation.xpType).sort(), ['7', 'global']);
    assert.equal(pending.filter(operation => operation.kind === 'activity').length, 4);
    f.member.roles.cache.delete('eligible-role');
    t.mock.method(Math, 'random', () => { throw new Error('Replay must not recalculate random XP'); });
    f.db.offline = false;
    await recover(f.store);
    assert.equal(f.store.pendingCount, 0);
    for (const operation of awards) {
        const row = f.db.users.get(`guild/user/${operation.xpType}`);
        assert.equal(row.xp_amount, operation.xpGained);
        assert.equal(row.messages_sent, 1);
        assert.equal(row.total_messages_sent, 2);
    }
});

test('shutdown during a database commit preserves the result and sends no late level-up', async t => {
    const f = fixture(t);
    const originalGetConnection = f.db.getConnection.bind(f.db);
    let resume, entered;
    const committed = new Promise(resolve => { entered = resolve; });
    const pause = new Promise(resolve => { resume = resolve; });
    f.db.getConnection = async () => {
        const connection = await originalGetConnection();
        const commit = connection.commit.bind(connection);
        connection.commit = async () => { await commit(); entered(); await pause; };
        return connection;
    };
    const work = award(f, getTotalXpForLevel(1));
    await committed;
    f.store.stopSyncLoop();
    resume();
    await work;
    assert.equal(f.db.users.get(KEY).xp_amount, getTotalXpForLevel(1));
    assert.equal(f.messages.length, 0);
    assert.equal(f.store.pendingCount, 1);
    const pending = JSON.parse(fs.readFileSync(f.filePath)).operations[0];
    assert.equal(pending.result.correctLevel, 1);
});

function commandInteraction() {
    const payloads = [];
    const user = { id: 'user', username: 'Player', displayAvatarURL: () => 'https://example.com/avatar.png' };
    return { payloads, user, member: { displayName: 'Player' }, guild: { id: 'guild', name: 'Crow Control' },
        options: { getUser: () => null, getMember: () => null, getString: () => null },
        async deferReply() { this.deferred = true; }, async editReply(payload) { payloads.push(payload); },
        async reply(payload) { payloads.push(payload); }, async update(payload) { payloads.push(payload); } };
}

for (const [label, Command] of [['rank', require('../commands/levels/rank')], ['leaderboard', require('../commands/levels/leaderboard')]]) {
    for (const pending of [false, true]) {
        test(`${label} only adds a synchronization note when its totals have pending activity`, async () => {
            const db = { query: async () => [[{ ...emptyRow(), user_id: 'user', xp_amount: 20 }]],
                xpStore: { hasPending: () => pending } };
            const command = new Command({ db });
            const interaction = commandInteraction();
            await command.execute(interaction);
            const embed = interaction.payloads.at(-1).embeds[0].toJSON();
            assert.equal(embed.fields.some(field => field.name === 'XP synchronization'), pending);
        });
    }
    test(`${label} explains a MySQL outage and preserves existing non-outage error handling`, async t => {
        t.mock.method(console, 'error', () => {});
        for (const unavailable of [false, true]) {
            const command = new Command({ db: { query: async () => { throw fail('ECONNRESET'); },
                isDatabaseUnavailableError: () => unavailable } });
            const interaction = commandInteraction();
            await command.execute(interaction);
            const content = interaction.payloads.at(-1).content;
            if (unavailable) assert.match(content, /saved locally.*sync automatically/u);
            else assert.equal(content, label === 'rank' ? 'Error fetching rank data.' : 'Error fetching leaderboard data.');
        }
    });
}
