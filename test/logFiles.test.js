/**
 * @fileoverview Verify monthly rollover, retention and storage cleanup with isolated temporary log files.
 * Ensure maintenance preserves the active log and leaves unrelated files untouched.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MonthlyFileHandler, createMonthlyFileHandler, MIB } = require('../utils/logFiles');

const KEPT_ACTIVE = 'Log maintenance could not reach its configured storage target without deleting the active monthly log; the active log was kept.';
const deletedMessage = count => 'Log maintenance deleted ' + count + ' completed monthly log file(s) to enforce retention/storage limits.';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-monthly-logs-'));
    const handlers = [];
    t.after(() => {
        for (const handler of handlers) handler.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return {
        directory,
        seed(name, content = '1234') {
            fs.writeFileSync(path.join(directory, name), content);
        },
        read(name) {
            return fs.readFileSync(path.join(directory, name), 'utf8');
        },
        names() {
            return fs.readdirSync(directory).sort();
        },
        handler(options = {}, retention = 12, name = 'cc.log') {
            const handler = new MonthlyFileHandler(path.join(directory, name), retention, {
                now: () => new Date(2026, 9, 8, 12, 30),
                ...options
            });
            handlers.push(handler);
            return handler;
        }
    };
}

function fsWithFreeBytes(getFreeBytes) {
    const fsImpl = Object.create(fs);
    fsImpl.statfsSync = () => ({ bavail: BigInt(getFreeBytes()), bsize: 1n });
    return fsImpl;
}

test('monthly logs append complete UTF-8 and multiline output without truncating prior output', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-10.log', 'previous run\n');
    const handler = logs.handler();
    handler.write('[2026-10-08 12:30:00] Crow Control ❄️');
    handler.write('Error: failed\n    at example.js:12:3');
    assert.equal(handler.baseFilename, path.join(logs.directory, 'cc-2026-10.log'));
    assert.equal(logs.read('cc-2026-10.log'), 'previous run\n[2026-10-08 12:30:00] Crow Control ❄️\nError: failed\n    at example.js:12:3\n');
    handler.close();
    handler.close();
    const nextRun = logs.handler();
    nextRun.write('next run');
    assert.ok(logs.read('cc-2026-10.log').endsWith('next run\n'));
});

test('writes roll over using the local calendar month and run retention cleanup', t => {
    const logs = fixture(t);
    let now = new Date(2026, 9, 31, 23, 59);
    const handler = logs.handler({ now: () => now }, 1);
    handler.write('October');
    now = new Date(2026, 10, 1, 0, 0);
    handler.write('November');
    assert.deepEqual(logs.names(), ['cc-2026-11.log']);
    assert.equal(logs.read('cc-2026-11.log'), 'November\n');
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(1)]);
    assert.deepEqual(handler.enforceLimits(), []);
});

test('retention counts existing monthly files, protects active even with future logs, and ignores unrelated data', t => {
    const logs = fixture(t);
    for (const name of ['cc-2020-01.log', 'cc-2025-01.log', 'cc-2026-09.log', 'cc-2027-01.log', 'other-2020-01.log', 'cc-2025-01.log.bak', 'cc-2025-1.log', 'cc.log', 'orders.json']) logs.seed(name);
    const handler = logs.handler({}, 2);
    assert.deepEqual(logs.names(), [
        'cc-2025-01.log.bak', 'cc-2025-1.log', 'cc-2026-10.log', 'cc-2027-01.log',
        'cc.log', 'orders.json', 'other-2020-01.log'
    ]);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(3)]);
});

test('retention preserves the newest existing files rather than applying a calendar age cutoff', t => {
    const logs = fixture(t);
    logs.seed('cc-2010-01.log');
    logs.seed('cc-2011-01.log');
    const handler = logs.handler({}, 3);
    assert.deepEqual(handler.enforceLimits(), []);
    assert.deepEqual(logs.names(), ['cc-2010-01.log', 'cc-2011-01.log', 'cc-2026-10.log']);
});

test('total storage limit deletes completed months oldest first including active log bytes', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-07.log');
    logs.seed('cc-2026-08.log');
    logs.seed('cc-2026-09.log');
    logs.seed('cc-2026-10.log');
    const handler = logs.handler({ maxTotalBytes: 9 });
    assert.deepEqual(logs.names(), ['cc-2026-09.log', 'cc-2026-10.log']);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(2)]);
});

test('storage cap never truncates or deletes an oversized active monthly log', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-09.log', 'old');
    logs.seed('cc-2026-10.log', 'active log is bigger than the cap');
    const handler = logs.handler({ maxTotalBytes: 1 });
    assert.deepEqual(logs.names(), ['cc-2026-10.log']);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(1), KEPT_ACTIVE, KEPT_ACTIVE]);
    handler.write('logging continues');
    assert.equal(logs.read('cc-2026-10.log'), 'active log is bigger than the caplogging continues\n');
});

test('zero storage and free disk thresholds disable their corresponding cleanup', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-08.log');
    logs.seed('cc-2026-09.log');
    const handler = logs.handler({ maxTotalBytes: 0, minFreeBytes: 0, cleanupTargetFreeBytes: 150, fsImpl: fsWithFreeBytes(() => 0) });
    assert.deepEqual(handler.enforceLimits(), []);
    assert.deepEqual(logs.names(), ['cc-2026-08.log', 'cc-2026-09.log', 'cc-2026-10.log']);
});

test('low free disk recovery starts below the minimum and continues to the higher target', t => {
    const logs = fixture(t);
    for (const month of ['07', '08', '09']) logs.seed('cc-2026-' + month + '.log');
    const freeReadings = [80, 140, 160];
    const handler = logs.handler({
        minFreeBytes: 100,
        cleanupTargetFreeBytes: 150,
        fsImpl: fsWithFreeBytes(() => freeReadings.length ? freeReadings.shift() : 160)
    });
    assert.deepEqual(logs.names(), ['cc-2026-09.log', 'cc-2026-10.log']);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(2)]);
});

test('free disk above or exactly at the minimum does not try to reach the recovery target', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-09.log');
    const handler = logs.handler({
        minFreeBytes: 100,
        cleanupTargetFreeBytes: 150,
        fsImpl: fsWithFreeBytes(() => 100)
    });
    assert.deepEqual(handler.enforceLimits(), []);
    assert.deepEqual(logs.names(), ['cc-2026-09.log', 'cc-2026-10.log']);
});

test('low disk target is clamped to the minimum and active logs survive unrecoverable disk pressure', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-09.log');
    const handler = logs.handler({
        minFreeBytes: 100,
        cleanupTargetFreeBytes: 50,
        fsImpl: fsWithFreeBytes(() => 10)
    });
    assert.equal(handler.cleanupTargetFreeBytes, 100);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(1), KEPT_ACTIVE, KEPT_ACTIVE]);
    assert.deepEqual(logs.names(), ['cc-2026-10.log']);
});

test('unavailable disk usage does not invent a low-disk cleanup condition', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-09.log');
    const fsImpl = Object.create(fs);
    fsImpl.statfsSync = () => { throw new Error('unsupported'); };
    const handler = logs.handler({ minFreeBytes: 100, cleanupTargetFreeBytes: 150, fsImpl });
    assert.deepEqual(handler.enforceLimits(), []);
    assert.deepEqual(logs.names(), ['cc-2026-09.log', 'cc-2026-10.log']);
});

test('only exact escaped stem and suffix matches are eligible and missing suffix defaults to .log', t => {
    const logs = fixture(t);
    logs.seed('cc.bot-2026-09.txt');
    logs.seed('ccXbot-2026-09.txt');
    const handler = logs.handler({}, 1, 'cc.bot.txt');
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(1)]);
    assert.deepEqual(logs.names(), ['cc.bot-2026-10.txt', 'ccXbot-2026-09.txt']);
    const suffixless = logs.handler({}, 1, 'custom');
    suffixless.write('custom');
    assert.equal(suffixless.baseFilename, path.join(logs.directory, 'custom-2026-10.log'));
});

test('cleanup failures stay harmless and never recursively remove matching directories', t => {
    const logs = fixture(t);
    const matchingDirectory = path.join(logs.directory, 'cc-2025-01.log');
    fs.mkdirSync(matchingDirectory);
    fs.writeFileSync(path.join(matchingDirectory, 'keep.json'), '{}');
    const handler = logs.handler({}, 1);
    assert.deepEqual(handler.enforceLimits(), []);
    assert.equal(fs.readFileSync(path.join(matchingDirectory, 'keep.json'), 'utf8'), '{}');
    handler.write('still logging');
    assert.equal(logs.read('cc-2026-10.log'), 'still logging\n');
});

test('a failed completed-log deletion does not prevent subsequent capacity cleanup', t => {
    const logs = fixture(t);
    for (const month of ['07', '08', '09']) logs.seed('cc-2026-' + month + '.log');
    const fsImpl = Object.create(fs);
    fsImpl.unlinkSync = filename => {
        if (filename.endsWith('cc-2026-07.log')) throw new Error('locked');
        fs.unlinkSync(filename);
    };
    const handler = logs.handler({ maxTotalBytes: 4, fsImpl });
    assert.deepEqual(logs.names(), ['cc-2026-07.log', 'cc-2026-10.log']);
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(2)]);
});

test('periodic enforcement catches a growing active file and safely expires completed logs', t => {
    const logs = fixture(t);
    logs.seed('cc-2026-09.log', '1234');
    const handler = logs.handler({ maxTotalBytes: 12 });
    handler.write('12345678');
    assert.deepEqual(handler.enforceLimits(), [deletedMessage(1)]);
    assert.deepEqual(logs.names(), ['cc-2026-10.log']);
    assert.equal(logs.read('cc-2026-10.log'), '12345678\n');
});

test('factory uses MiB units and handler surfaces write errors for the runtime logger', t => {
    const logs = fixture(t);
    const handler = createMonthlyFileHandler(path.join(logs.directory, 'cc.log'), {
        retentionMonths: 12,
        maxTotalMib: 100,
        minFreeMib: 100,
        cleanupTargetFreeMib: 150,
        now: () => new Date(2026, 9, 8)
    });
    assert.equal(handler.maxTotalBytes, 100 * MIB);
    assert.equal(handler.minFreeBytes, 100 * MIB);
    assert.equal(handler.cleanupTargetFreeBytes, 150 * MIB);
    handler.close();
    const fsImpl = Object.create(fs);
    fsImpl.writeFileSync = () => { throw new Error('disk full'); };
    const broken = logs.handler({ fsImpl });
    assert.throws(() => broken.write('failure'), /disk full/);
});
