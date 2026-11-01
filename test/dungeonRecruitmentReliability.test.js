// Dungeon clicks and recovery must survive overlapping requests and failed storage.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const DungeonRecruitment = require('../commands/dungeon_recruitment.js');

function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    const command = Object.assign(Object.create(DungeonRecruitment.prototype), {
        activeRuns: new Map(), runButtonQueues: new Map(), pendingStorageWrite: Promise.resolve(),
        stopped: false, client: new EventEmitter(), storageMode: 'json', restoreOnReady() {}
    });
    const run = { id: 'run', guildId: 'guild', channelId: 'channel', messageId: 'message',
        dungeonName: 'Forlorn', location: 'Forlorn Court', closed: false,
        roles: [{ key: 'room1', label: 'Room 1' }, { key: 'room2', label: 'Room 2' }],
        assignments: {}, memberNames: {}, joinOrder: [], multipleAssignments: false };
    command.activeRuns.set(run.id, run);
    command.saveRuns = async () => {};
    command.sendJoinNotification = async () => {};
    command.buildEmbed = value => ({ closed: value.closed, assignments: { ...value.assignments } });
    command.buildComponents = () => [];
    command.closeRunNow = async () => { run.closed = true; command.activeRuns.delete(run.id); };
    function interaction(user = 'member', role = 'room1') {
        const replies = [];
        return { customId: `dgn:run:${role}`, user: { id: user, username: user }, client: command.client,
            message: { async edit() {} }, replies,
            async deferReply() {}, async reply(payload) { replies.push(payload); },
            async editReply(payload) { replies.push(payload); } };
    }
    return { command, run, interaction };
}

test('dungeon clicks cannot change a run closed during acknowledgement', async () => {
    const { command, run, interaction } = fixture();
    const click = interaction();
    click.deferReply = async () => { run.closed = true; };
    await command.handleButton(click);
    assert.deepEqual(run.assignments, {});
    assert.match(click.replies[0].content, /already closed/);
});

test('the final dungeon join completes before a concurrent leave can mutate the team', async () => {
    const { command, run, interaction } = fixture();
    const entered = gate(), notification = gate();
    run.assignments.room1 = 'first';
    command.isFull = candidate => candidate.roles.every(role => candidate.assignments[role.key]);
    command.sendJoinNotification = async () => { entered.resolve(); await notification.promise; };
    const joined = command.handleButton(interaction('last', 'room2'));
    await entered.promise;
    const leave = interaction('first');
    const left = command.handleButton(leave);
    notification.resolve();
    await Promise.all([joined, left]);
    assert.deepEqual(run.assignments, { room1: 'first', room2: 'last' });
    assert.equal(run.closed, true);
    assert.match(leave.replies[0].content, /already closed/);
    assert.equal(command.runButtonQueues.size, 0);
});

test('failed dungeon persistence rolls back a role change before notifying members', async () => {
    const { command, run, interaction } = fixture();
    let notifications = 0;
    command.saveRuns = async () => { throw new Error('disk full'); };
    command.sendJoinNotification = async () => { notifications++; };
    await assert.rejects(command.handleButton(interaction()), /disk full/);
    assert.deepEqual(run.assignments, {});
    assert.deepEqual(run.joinOrder, []);
    assert.equal(notifications, 0);
    assert.equal(command.runButtonQueues.size, 0);
});

test('stopping dungeon recruitment clears deadlines and prevents late restoration from starting timers', async () => {
    const { command, run } = fixture();
    const loaded = gate(), entered = gate();
    command.storageMode = 'auto';
    command.loadMysqlRuns = async () => { entered.resolve(); await loaded.promise; };
    command.loadPersistedRuns = () => assert.fail('Restoration continued after shutdown');
    run.registrationEndTime = new Date(Date.now() + 60_000);
    command.scheduleDeadline(run);
    command.startStorageSyncLoop();
    command.restorePromise = command.restorePersistedRuns();
    await entered.promise;
    const stopped = command.stop();
    assert.equal(command.storageSyncInterval, null);
    assert.equal(run.deadlineTimeout, null);
    loaded.resolve();
    await stopped;
    command.scheduleDeadline(run);
    command.startStorageSyncLoop();
    assert.equal(command.storageSyncInterval, null);
    assert.equal(run.deadlineTimeout, null);
});

test('corrupt dungeon recovery is preserved and cannot become an empty snapshot', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dungeon-corrupt-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storageFile = path.join(dir, 'runs.json');
    fs.writeFileSync(storageFile, '{unsent run');
    assert.throws(() => new DungeonRecruitment({ dungeonRunsFile: storageFile, client: new EventEmitter() }),
        { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(storageFile, 'utf8'), '{unsent run');
    const backup = fs.readdirSync(dir).find(name => name.includes('.corrupt-'));
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{unsent run');
});

test('dungeon storage keeps the current snapshot before waiting on MySQL', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dungeon-pending-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { command, run } = fixture();
    Object.assign(command, { storageFile: path.join(dir, 'runs.json'), storageTempFile: path.join(dir, 'runs.tmp'), storageMode: 'auto' });
    command.canUseMysql = () => true;
    const entered = gate(), query = gate();
    command.upsertMysqlRun = async () => { entered.resolve(); await query.promise; };
    const saved = command.saveRunsNow();
    await entered.promise;
    const recovery = JSON.parse(fs.readFileSync(command.storageFile, 'utf8'));
    assert.equal(recovery.pendingSync, true);
    assert.equal(recovery.runs[0].id, run.id);
    query.resolve();
    await saved;
    assert.equal(JSON.parse(fs.readFileSync(command.storageFile, 'utf8')).pendingSync, false);
});

test('dungeon saves each current and pending closed run once', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dungeon-once-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { command, run } = fixture();
    Object.assign(command, { storageFile: path.join(dir, 'runs.json'), storageTempFile: path.join(dir, 'runs.tmp'), storageMode: 'auto' });
    command.canUseMysql = () => true;
    const closed = { ...command.serializeRun(run), id: 'older', status: 'closed_deadline', closed: true };
    command.writeJsonStore([closed], 'mysql_fallback', true);
    const writes = [];
    command.upsertMysqlRun = async (storedRun, origin) => { writes.push([storedRun.id, storedRun.status, origin]); };
    await command.saveRunsNow();
    assert.deepEqual(writes, [['older', 'closed_deadline', 'json_fallback'], ['run', 'open', 'mysql']]);
    assert.deepEqual(command.readJsonStore().runs, []);
});

test('a failed dungeon database batch keeps the entire snapshot for replay', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dungeon-partial-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { command, run } = fixture();
    Object.assign(command, { storageFile: path.join(dir, 'runs.json'), storageTempFile: path.join(dir, 'runs.tmp'), storageMode: 'auto' });
    command.activeRuns.set('second', { ...run, id: 'second' });
    command.canUseMysql = () => true;
    const failures = [];
    command.noteMysqlFailure = error => { failures.push(error.message); };
    command.upsertMysqlRun = async storedRun => {
        if (storedRun.id === 'second') throw new Error('connection lost');
    };
    await command.saveRunsNow();
    const recovery = command.readJsonStore();
    assert.equal(recovery.pendingSync, true);
    assert.deepEqual(recovery.runs.map(value => value.id), ['run', 'second']);
    assert.deepEqual(failures, ['connection lost']);
});

test('failure to clear a synced dungeon snapshot does not reject the saved change', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dungeon-cleanup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    t.mock.method(console, 'error', () => {});
    const { command } = fixture();
    Object.assign(command, { storageFile: path.join(dir, 'runs.json'), storageTempFile: path.join(dir, 'runs.tmp'), storageMode: 'auto' });
    command.canUseMysql = () => true;
    command.upsertMysqlRun = async () => {};
    const write = command.writeJsonStore.bind(command);
    command.writeJsonStore = (runs, source, pending) => {
        if (!pending) throw new Error('disk full');
        return write(runs, source, pending);
    };
    fs.writeFileSync(command.storageFile, JSON.stringify({ runs: [], source: 'mysql_fallback', pendingSync: false }));
    await assert.doesNotReject(command.saveRunsNow());
    assert.equal(command.readJsonStore().pendingSync, true);
    assert.equal(command.readJsonStore().runs[0].id, 'run');
});

for (const status of ['closed_full', 'closed_deadline', 'closed_missing_message']) {
    test(`pending ${status} recovery overrides an older open dungeon loaded from MySQL`, () => {
        const { command, run } = fixture();
        command.storageMode = 'auto';
        command.readJsonStore = () => ({ source: 'mysql_fallback', runs: [{ id: run.id, status, closed: true }] });
        command.loadPersistedRuns();
        assert.equal(command.activeRuns.has(run.id), false);
    });
}

test('dungeon write failures reach callers and do not poison later queued writes', async t => {
    const { command } = fixture();
    const failures = [];
    t.mock.method(console, 'error', (...args) => failures.push(args));
    const error = new Error('disk full');
    await assert.rejects(command.queueStorageWrite(() => { throw error; }), error);
    assert.equal(await command.queueStorageWrite(() => 'saved'), 'saved');
    assert.equal(failures.length, 1);
});

for (const reason of ['full', 'deadline']) {
    test(`a failed dungeon ${reason} close leaves the run open without announcing a result`, async () => {
        const { command, run } = fixture();
        command.closeRunNow = DungeonRecruitment.prototype.closeRunNow;
        command.saveRuns = async () => { throw new Error('disk full'); };
        command.fetchRunMessage = async () => assert.fail('An unconfirmed close reached Discord');
        await assert.rejects(command.closeRun(run.id, reason, command.client), /disk full/);
        assert.equal(command.activeRuns.get(run.id), run);
        assert.equal(run.closed, false);
        assert.equal(run.closeReason, undefined);
        assert.equal(command.runButtonQueues.size, 0);
    });
}

test('an expired dungeon deadline retries a failed close without spinning', async t => {
    const { command, run } = fixture();
    t.mock.method(console, 'error', () => {});
    const timers = [];
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
    });
    run.registrationEndTime = new Date(Date.now() - 1);
    let attempts = 0;
    command.closeRun = async () => {
        if (++attempts === 1) throw new Error('disk full');
        run.closed = true;
    };
    command.scheduleDeadline(run);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 60_000);
    timers[0].callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.equal(run.closed, true);
    assert.equal(run.deadlineTimeout, null);
});

test('a dungeon close failing during shutdown does not schedule a retry', async t => {
    const { command, run } = fixture();
    t.mock.method(console, 'error', () => {});
    t.mock.method(global, 'setTimeout', () => assert.fail('A deadline restarted after shutdown'));
    const closing = gate();
    command.closeRun = async () => { await closing.promise; throw new Error('disk full'); };
    command.closeRunAtDeadline(run);
    await command.stop();
    closing.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(run.deadlineTimeout, null);
});

test('a restored dungeon with an expired deadline keeps a retry after failed persistence', async t => {
    const { command, run } = fixture();
    t.mock.method(console, 'error', () => {});
    const timers = [];
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
    });
    run.registrationEndTime = new Date(Date.now() - 1);
    command.fetchRunMessage = async () => ({});
    command.closeRun = async () => { throw new Error('disk full'); };
    await command.restorePersistedRuns();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 60_000);
    assert.equal(run.deadlineTimeout, timers[0]);
});
