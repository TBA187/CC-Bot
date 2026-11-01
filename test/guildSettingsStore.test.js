// Exercise guild settings recovery and concurrent writes without touching runtime files or MySQL.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GuildSettingsStore } = require('../features/guild-settings/GuildSettingsStore.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guild-settings-'));
    const store = new GuildSettingsStore({ guildId: '123456789012345678', storageMode: 'json',
        filePath: path.join(directory, 'settings.json'), consoleObject: { log() {}, warn() {}, error() {} }, ...options });
    t.after(async () => { await store.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
    return store;
}

test('JSON mode retains existing defaults and new guild settings without querying MySQL', async t => {
    const store = fixture(t, { db: { hasRequiredConfig: true, query: () => assert.fail('JSON mode queried MySQL') } });
    assert.equal(await store.sync(), false);
    assert.deepEqual(store.cache.get('123456789012345678'), {
        xpEnabled: true, xpDateEnabled: '2026-05-11 04:56:00', loggingEnabled: true
    });
    await store.addGuild({ id: '987654321098765432', name: 'Another Guild' });
    assert.deepEqual(store.cache.get('987654321098765432'), { xpEnabled: false, xpDateEnabled: null, loggingEnabled: false });
    assert.equal(store.readMirror().pendingSync, true);
    assert.equal(store.readMirror().settings.length, 2);
});

test('corrupt recovery files are preserved and block SQL rather than being replaced with defaults', async t => {
    const store = fixture(t, { storageMode: 'auto', db: { hasRequiredConfig: true, query: () => assert.fail('SQL before recovery') } });
    const bytes = '{"pendingSync":true,"settings":[';
    fs.writeFileSync(store.filePath, bytes);
    await assert.rejects(store.sync(), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(store.filePath, 'utf8'), bytes);
    const backup = fs.readdirSync(path.dirname(store.filePath)).find(name => name.includes('.corrupt-'));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(path.dirname(store.filePath), backup), 'utf8'), bytes);
});

test('pending guild changes replay before SQL snapshots and remain pending after partial failure', async t => {
    const calls = [];
    let failSecond = true;
    const store = fixture(t, { storageMode: 'auto', db: { hasRequiredConfig: true,
        async query(sql, values) {
            if (sql.includes('INSERT')) {
                calls.push(values[0]);
                if (failSecond && values[0] === 'other') throw new Error('Database unavailable');
            }
            if (sql.startsWith('SELECT')) return [store.readMirror().settings];
            return [[]];
        }
    } });
    const rows = [...store.defaultRows(), { guild_id: 'other', xp_enabled: 0, logging_enabled: 1 }];
    store.writeMirror(rows, true);
    assert.equal(await store.sync(), false);
    assert.equal(store.readMirror().pendingSync, true);
    failSecond = false;
    assert.equal(await store.sync(), true);
    assert.equal(store.readMirror().pendingSync, false);
    assert.deepEqual(calls, ['123456789012345678', 'other', '123456789012345678', 'other']);
});

test('overlapping syncs share work and a guild join cannot be overwritten by an older snapshot', async t => {
    const selected = deferred(), result = deferred();
    let selects = 0;
    const store = fixture(t, { storageMode: 'auto', db: { hasRequiredConfig: true,
        async query(sql) {
            if (sql.startsWith('SELECT')) { selects++; selected.resolve(); return result.promise; }
            return [[]];
        }
    } });
    const first = store.sync();
    const second = store.sync();
    assert.equal(first, second);
    await selected.promise;
    const joined = store.addGuild({ id: 'new-guild', name: 'New Guild' });
    result.resolve([store.defaultRows()]);
    await Promise.all([first, joined]);
    assert.equal(selects, 1);
    assert.equal(store.cache.has('new-guild'), true);
    assert.equal(store.readMirror().settings.some(row => row.guild_id === 'new-guild'), true);
});

test('a failed local write prevents a new guild from being reported or written to SQL', async t => {
    const store = fixture(t, { storageMode: 'mysql', db: { hasRequiredConfig: true,
        query: () => assert.fail('No SQL write may precede durable storage') } });
    store.loadMirror();
    t.mock.method(store, 'writeMirror', () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); });
    await assert.rejects(store.addGuild({ id: 'new', name: 'New' }), { code: 'ENOSPC' });
    assert.equal(store.cache.has('new'), false);
});

test('an uncertain SQL outcome preserves replayable new guild settings', async t => {
    const store = fixture(t, { storageMode: 'mysql', db: { hasRequiredConfig: true,
        async query() { throw Object.assign(new Error('Connection lost after commit'), { code: 'ECONNRESET' }); }
    } });
    await store.addGuild({ id: 'new', name: 'New' });
    assert.equal(store.readMirror().pendingSync, true);
    assert.equal(store.cache.has('new'), true);
});

test('shutdown ignores late snapshots and cannot restart the sync timer', async t => {
    const selected = deferred(), result = deferred();
    const scheduled = [], cancelled = [];
    const store = fixture(t, { storageMode: 'mysql', schedule: fn => { scheduled.push(fn); return 42; },
        cancel: timer => cancelled.push(timer), db: { hasRequiredConfig: true, async query(sql) {
            if (sql.startsWith('SELECT')) { selected.resolve(); return result.promise; }
            return [[]];
        } }
    });
    store.loadMirror();
    const sync = store.sync();
    await selected.promise;
    store.startSyncLoop();
    store.startSyncLoop();
    const stopped = store.stop();
    store.startSyncLoop();
    result.resolve([[{ guild_id: 'late', xp_enabled: 1 }]]);
    assert.equal(await sync, false);
    await stopped;
    assert.equal(store.cache.has('late'), false);
    assert.equal(store.readMirror().settings.some(row => row.guild_id === 'late'), false);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(cancelled, [42]);
    assert.equal(await store.sync(), false);
});
