const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NotificationStore = require('../features/pro-notifications/NotificationStore.js');
const { NOTIFICATION_DEFINITIONS } = require('../features/pro-notifications/notificationCatalog.js');

test('corrupt notification state is preserved instead of replaced with default subscriptions', async t => {
    const dataFile = tempDataFile();
    t.after(() => fs.rmSync(path.dirname(dataFile), { recursive: true, force: true }));
    fs.writeFileSync(dataFile, '{pending subscriptions');
    const store = makeStore({ dataFile, storageMode: 'json' });
    await assert.rejects(store.restore(), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(dataFile, 'utf8'), '{pending subscriptions');
    assert.ok(fs.readdirSync(path.dirname(dataFile)).some(name => name.includes('.corrupt-')));
});

for (const kind of ['settings', 'subscriptions']) {
    for (const storageMode of ['json', 'auto']) {
        test(`failed ${storageMode} notification persistence leaves ${kind} unchanged`, async t => {
            const dataFile = tempDataFile();
            t.after(() => fs.rmSync(path.dirname(dataFile), { recursive: true, force: true }));
            const store = makeStore({ dataFile, db: new FakeDb(), storageMode });
            await store.restore();
            await store.setUserSubscriptions('member', ['alto_mare']);
            const previous = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            const originalWrite = store.writeJsonData.bind(store);
            store.writeJsonData = () => { throw new Error('disk full'); };
            await assert.rejects(kind === 'settings'
                ? store.setGuildNotificationEnabled('alto_mare', false)
                : store.setUserSubscriptions('member', []), /disk full/);
            assert.equal(store.getSetting('alto_mare').enabled, true);
            assert.deepEqual(store.getUserSubscriptionKeys('member'), ['alto_mare']);
            assert.deepEqual(store.local, previous);
            assert.deepEqual(JSON.parse(fs.readFileSync(dataFile, 'utf8')), previous);
            store.writeJsonData = originalWrite;
            await store.syncPending();
            assert.deepEqual(store.local, previous);
        });
    }

    test(`notification recovery retains newer ${kind} while an older write is in flight`, async t => {
        const dataFile = tempDataFile();
        t.after(() => fs.rmSync(path.dirname(dataFile), { recursive: true, force: true }));
        const store = makeStore({ dataFile, db: new FakeDb(), storageMode: 'auto' });
        await store.restore();
        const key = 'alto_mare';
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        const method = kind === 'settings' ? 'mysqlSaveSetting' : 'mysqlSaveSubscription';
        const pendingCollection = kind === 'settings' ? 'pendingSettings' : 'pendingSubscriptions';
        const pendingId = kind === 'settings' ? key : `${key}:member`;
        const saved = [];
        let blocked = true;
        store[method] = async value => {
            if (blocked) { blocked = false; entered(); await gate; }
            saved.push(value);
        };
        const mutate = enabled => kind === 'settings'
            ? store.setGuildNotificationEnabled(key, enabled)
            : store.setUserSubscriptions('member', enabled ? [key] : []);
        const first = mutate(true);
        await started;
        const second = mutate(false);
        release();
        await Promise.all([first, second]);
        assert.ok(store.local[pendingCollection].includes(pendingId));
        assert.ok(JSON.parse(fs.readFileSync(dataFile, 'utf8'))[pendingCollection].includes(pendingId));
        await store.syncPending();
        assert.ok(!store.local[pendingCollection].includes(pendingId));
        assert.equal(saved.at(-1).enabled, false);
    });
}

function tempDataFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notifications-'));
    return path.join(directory, 'notifications.json');
}

class FakeDb {
    constructor() {
        this.hasRequiredConfig = true;
        this.fail = false;
        this.settings = new Map();
        this.subscriptions = new Map();
    }

    async query(sql, params = []) {
        if (this.fail) {
            throw Object.assign(new Error('database unavailable'), { code: 'ECONNRESET' });
        }

        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.startsWith('select guild_id, notification_key, enabled')) {
            return [[...this.settings.values()].filter(row => row.guild_id === params[0])];
        }
        if (normalized.startsWith('select guild_id, notification_key, user_id')) {
            return [[...this.subscriptions.values()].filter(row => row.guild_id === params[0])];
        }
        if (normalized.startsWith('insert into guild_notification_settings')) {
            const [guildId, key, enabled, createdAt, updatedAt] = params;
            const id = `${guildId}:${key}`;
            const existing = this.settings.get(id);
            this.settings.set(id, {
                guild_id: guildId,
                notification_key: key,
                enabled,
                created_at: existing?.created_at || createdAt,
                updated_at: updatedAt
            });
            return [{ affectedRows: 1 }];
        }
        if (normalized.startsWith('insert into user_notification_subscriptions')) {
            const [guildId, key, userId, enabled, createdAt, updatedAt] = params;
            const id = `${guildId}:${key}:${userId}`;
            const existing = this.subscriptions.get(id);
            this.subscriptions.set(id, {
                guild_id: guildId,
                notification_key: key,
                user_id: userId,
                enabled,
                created_at: existing?.created_at || createdAt,
                updated_at: updatedAt
            });
            return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected SQL: ${normalized}`);
    }
}

function makeStore(options = {}) {
    return new NotificationStore({
        guildId: 'guild-1',
        definitions: NOTIFICATION_DEFINITIONS,
        dataFile: tempDataFile(),
        ...options
    });
}

test('notification JSON mode defaults guild notifications on and user subscriptions off', async () => {
    const store = makeStore({ storageMode: 'json' });
    await store.restore();

    assert.deepEqual(
        store.listNotificationStates().map(state => [state.key, state.enabled]),
        [
            ['alto_mare', true],
            ['bug_catching_contest', true],
            ['fish_catching_contest', true]
        ]
    );
    assert.deepEqual(store.getUserSubscriptionKeys('user-1'), []);

    await store.setUserSubscriptions('user-1', ['bug_catching_contest']);
    assert.deepEqual(store.getUserSubscriptionKeys('user-1'), ['bug_catching_contest']);
    assert.deepEqual(store.getEnabledUserIds('bug_catching_contest'), ['user-1']);
    assert.deepEqual(store.getEnabledUserIds('fish_catching_contest'), []);
});

test('notification store preserves changes in JSON while MySQL is unavailable and later syncs them', async () => {
    const db = new FakeDb();
    const file = tempDataFile();
    const store = new NotificationStore({
        db,
        guildId: 'guild-1',
        definitions: NOTIFICATION_DEFINITIONS,
        dataFile: file
    });

    await store.restore();
    db.fail = true;

    await store.setGuildNotificationEnabled('alto_mare', false);
    await store.setUserSubscriptions('user-2', ['fish_catching_contest']);

    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(pending.pendingSync, true);
    assert.equal(store.getSetting('alto_mare').enabled, false);
    assert.deepEqual(store.getEnabledUserIds('fish_catching_contest'), ['user-2']);

    db.fail = false;
    await store.syncPending();

    const synced = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(synced.pendingSync, false);
    assert.equal(db.settings.get('guild-1:alto_mare').enabled, 0);
    assert.equal(db.subscriptions.get('guild-1:fish_catching_contest:user-2').enabled, 1);
});

test('contest settings and subscriptions keep their independent values after restore', async () => {
    const file = tempDataFile();
    fs.writeFileSync(file, JSON.stringify({
        version: 1,
        source: 'json_only',
        pendingSync: false,
        settings: {
            bug_catching_contest: {
                guild_id: 'guild-1',
                notification_key: 'bug_catching_contest',
                enabled: 0,
                created_at: '2026-08-18T00:30:00.000Z',
                updated_at: '2026-08-18T00:30:00.000Z'
            },
            fish_catching_contest: {
                guild_id: 'guild-1',
                notification_key: 'fish_catching_contest',
                enabled: 1,
                created_at: '2026-08-18T00:30:00.000Z',
                updated_at: '2026-08-18T00:30:00.000Z'
            }
        },
        subscriptions: {
            'bug_catching_contest:user-3': {
                guild_id: 'guild-1',
                notification_key: 'bug_catching_contest',
                user_id: 'user-3',
                enabled: 1,
                created_at: '2026-08-18T00:30:00.000Z',
                updated_at: '2026-08-18T00:30:00.000Z'
            },
            'fish_catching_contest:user-3': {
                guild_id: 'guild-1',
                notification_key: 'fish_catching_contest',
                user_id: 'user-3',
                enabled: 0,
                created_at: '2026-08-18T00:30:00.000Z',
                updated_at: '2026-08-18T00:30:00.000Z'
            }
        }
    }));

    const store = new NotificationStore({
        guildId: 'guild-1',
        definitions: NOTIFICATION_DEFINITIONS,
        storageMode: 'json',
        dataFile: file
    });
    await store.restore();

    assert.equal(store.getSetting('bug_catching_contest').enabled, false);
    assert.equal(store.getSetting('fish_catching_contest').enabled, true);
    assert.deepEqual(store.getUserSubscriptionKeys('user-3'), ['bug_catching_contest']);
    const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(restored.subscriptions['fish_catching_contest:user-3'].enabled, false);
    assert.equal(restored.pendingSync, false);
});
