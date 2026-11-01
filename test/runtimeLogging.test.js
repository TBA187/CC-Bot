/**
 * @fileoverview Verify console/file mirroring, UTC timestamps, buffering, maintenance and shutdown flushing.
 * Use isolated streams and temporary files so tests do not alter the bot runtime log.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const {
    DEFAULT_LOG_PATH, DEFAULT_LOG_RETENTION_MONTHS, DEFAULT_LOG_MAX_TOTAL_MIB,
    DEFAULT_LOG_MIN_FREE_MIB, DEFAULT_LOG_CLEANUP_TARGET_FREE_MIB, LOG_MAINTENANCE_CHECK_MS,
    formatTimestamp, createFileLogHandler, TimestampedConsole,
    installTimestampedConsole, installRuntimeLogging
} = require('../utils/runtimeLogging.js');

const now = () => new Date(Date.UTC(2026, 9, 8, 13, 4, 5));
const timestamp = '[2026-10-08 13:04:05]';

function stream({ backpressure = true } = {}) {
    return {
        calls: [],
        text: '',
        write(chunk, encoding, callback) {
            this.calls.push({ chunk, encoding, callback });
            this.text += String(chunk);
            const done = typeof encoding === 'function' ? encoding : callback;
            done?.();
            return backpressure;
        }
    };
}

function fileHandler() {
    return {
        baseFilename: path.resolve('data/logs/cc-2026-10.log'),
        lines: [],
        maintenanceCalls: 0,
        closeCalls: 0,
        write(text) { this.lines.push(text); },
        enforceLimits() { this.maintenanceCalls++; return []; },
        close() { this.closeCalls++; }
    };
}

function runtime(options = {}) {
    const stdout = options.stdout || stream();
    const stderr = options.stderr || stream();
    const handler = Object.hasOwn(options, 'fileHandler') ? options.fileHandler : fileHandler();
    const processImpl = new EventEmitter();
    const scheduled = [];
    const cleared = [];
    const logging = installRuntimeLogging({
        stdout, stderr, fileHandler: handler, processImpl, now,
        setIntervalImpl(callback, delay) {
            const timer = { callback, delay, unrefCalls: 0, unref() { this.unrefCalls++; } };
            scheduled.push(timer);
            return timer;
        },
        clearIntervalImpl(timer) { cleared.push(timer); },
        ...options
    });
    return { logging, stdout, stderr, handler, processImpl, scheduled, cleared };
}

function fakeFs(overrides = {}) {
    return {
        mkdirSync() {},
        openSync() { return 77; },
        readdirSync() { return []; },
        statfsSync() { return { bavail: 1000n, bsize: 1024n * 1024n }; },
        closeSync() {},
        ...overrides
    };
}

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runtime-log-test-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.match(path.basename(resolved), /^cc-runtime-log-test-/u);
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return directory;
}

test('runtime log defaults use the configured storage limits and Crow Control filename', () => {
    assert.equal(DEFAULT_LOG_PATH, 'data/logs/cc.log');
    assert.equal(DEFAULT_LOG_RETENTION_MONTHS, 12);
    assert.equal(DEFAULT_LOG_MAX_TOTAL_MIB, 100);
    assert.equal(DEFAULT_LOG_MIN_FREE_MIB, 100);
    assert.equal(DEFAULT_LOG_CLEANUP_TARGET_FREE_MIB, 150);
    assert.equal(LOG_MAINTENANCE_CHECK_MS, 3_600_000);
    assert.equal(formatTimestamp(now()), timestamp);
    const handler = createFileLogHandler({ env: {}, now, fsImpl: fakeFs() });
    assert.equal(handler.baseFilename, path.resolve('data/logs/cc-2026-10.log'));
    assert.equal(handler.retentionMonths, 12);
    assert.equal(handler.maxTotalBytes, 100 * 1024 * 1024);
    assert.equal(handler.minFreeBytes, 100 * 1024 * 1024);
    assert.equal(handler.cleanupTargetFreeBytes, 150 * 1024 * 1024);
    handler.close();
});

test('numeric environment settings accept Python-style signs, whitespace and digit underscores', () => {
    const handler = createFileLogHandler({
        env: {
            BOT_LOG_PATH: 'data/other/crow-control.txt',
            BOT_LOG_RETENTION_MONTHS: ' +2 ',
            BOT_LOG_MAX_TOTAL_MIB: '1_00',
            BOT_LOG_MIN_FREE_MIB: '0',
            BOT_LOG_CLEANUP_TARGET_FREE_MIB: '175'
        },
        now, fsImpl: fakeFs()
    });
    assert.equal(handler.baseFilename, path.resolve('data/other/crow-control-2026-10.txt'));
    assert.equal(handler.retentionMonths, 2);
    assert.equal(handler.maxTotalBytes, 100 * 1024 * 1024);
    assert.equal(handler.minFreeBytes, 0);
    assert.equal(handler.cleanupTargetFreeBytes, 175 * 1024 * 1024);
    handler.close();
});

test('invalid env integers use defaults while zero and negative values respect limits', () => {
    const invalid = createFileLogHandler({
        env: {
            BOT_LOG_RETENTION_MONTHS: '1.5', BOT_LOG_MAX_TOTAL_MIB: '25MiB',
            BOT_LOG_MIN_FREE_MIB: '', BOT_LOG_CLEANUP_TARGET_FREE_MIB: '2e2'
        },
        now, fsImpl: fakeFs()
    });
    assert.equal(invalid.retentionMonths, 12);
    assert.equal(invalid.maxTotalBytes, 100 * 1024 * 1024);
    assert.equal(invalid.minFreeBytes, 100 * 1024 * 1024);
    assert.equal(invalid.cleanupTargetFreeBytes, 150 * 1024 * 1024);
    invalid.close();
    const clamped = createFileLogHandler({
        env: {
            BOT_LOG_RETENTION_MONTHS: '0', BOT_LOG_MAX_TOTAL_MIB: '-5',
            BOT_LOG_MIN_FREE_MIB: '-10', BOT_LOG_CLEANUP_TARGET_FREE_MIB: '-15'
        },
        now, fsImpl: fakeFs()
    });
    assert.equal(clamped.retentionMonths, 1);
    assert.equal(clamped.maxTotalBytes, 0);
    assert.equal(clamped.minFreeBytes, 0);
    assert.equal(clamped.cleanupTargetFreeBytes, 0);
    clamped.close();
});

test('explicit log settings override environment and raise cleanup target to minimum free space', () => {
    const handler = createFileLogHandler({
        path: 'data/explicit/bot.log', retentionMonths: 3, maxTotalMib: 0,
        minFreeMib: 80, cleanupTargetFreeMib: 25,
        env: { BOT_LOG_PATH: 'ignored.log', BOT_LOG_RETENTION_MONTHS: '9', BOT_LOG_MAX_TOTAL_MIB: '500' },
        now, fsImpl: fakeFs()
    });
    assert.equal(handler.baseFilename, path.resolve('data/explicit/bot-2026-10.log'));
    assert.equal(handler.retentionMonths, 3);
    assert.equal(handler.maxTotalBytes, 0);
    assert.equal(handler.minFreeBytes, 80 * 1024 * 1024);
    assert.equal(handler.cleanupTargetFreeBytes, 80 * 1024 * 1024);
    handler.close();
});

test('unavailable file logging returns null but programming errors remain visible', () => {
    const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assert.equal(createFileLogHandler({
        env: {}, fsImpl: fakeFs({ mkdirSync() { throw accessError; } })
    }), null);
    assert.throws(() => createFileLogHandler({
        env: {}, fsImpl: fakeFs({ mkdirSync() { throw new TypeError('invalid test operation'); } })
    }), /invalid test operation/u);
    assert.throws(() => createFileLogHandler({
        env: {}, fsImpl: fakeFs({ mkdirSync() {
            throw Object.assign(new TypeError('invalid path type'), { code: 'ERR_INVALID_ARG_TYPE' });
        } })
    }), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('split console writes receive one timestamp and one mirrored line', () => {
    const output = stream();
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    output.write('Hello');
    output.write(' world');
    assert.deepEqual(handler.lines, []);
    output.write('\n');
    assert.equal(output.text, timestamp + ' Hello world\n');
    assert.deepEqual(handler.lines, [timestamp + ' Hello world']);
    consoleStream.restore();
});

test('blank console lines stay blank and every file line receives its timestamp', () => {
    const output = stream();
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    output.write('\n\r\n\rVisible\n\n');
    assert.equal(output.text, '\n\r\n\r' + timestamp + ' Visible\n\n');
    assert.deepEqual(handler.lines, [
        timestamp + ' ', timestamp + ' ', timestamp + ' ',
        timestamp + ' Visible', timestamp + ' '
    ]);
    consoleStream.restore();
});

test('carriage return and CRLF terminate console and file lines', () => {
    const output = stream();
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    output.write('First\rSecond\r\nThird\n');
    assert.equal(output.text, timestamp + ' First\r' + timestamp + ' Second\r\n' + timestamp + ' Third\n');
    assert.deepEqual(handler.lines, [timestamp + ' First', timestamp + ' Second', timestamp + ' Third']);
    consoleStream.restore();
});

test('normal output and errors are timestamped and mirrored without duplicate installation', () => {
    const stdout = stream();
    const stderr = stream();
    const handler = fileHandler();
    const first = installTimestampedConsole({ stdout, stderr, fileHandler: handler, now });
    const second = installTimestampedConsole({ stdout, stderr, fileHandler: handler, now });
    assert.equal(first[0], second[0]);
    assert.equal(first[1], second[1]);
    stdout.write('Normal output\n');
    stderr.write('Unexpected error\n');
    assert.equal(stdout.text, timestamp + ' Normal output\n');
    assert.equal(stderr.text, timestamp + ' Unexpected error\n');
    assert.deepEqual(handler.lines, [timestamp + ' Normal output', timestamp + ' Unexpected error']);
    first.forEach(item => item.restore());
});

test('using a shared stdout/stderr stream installs only one wrapper', () => {
    const output = stream();
    const handler = fileHandler();
    const installed = installTimestampedConsole({ stdout: output, stderr: output, fileHandler: handler, now });
    assert.equal(installed.length, 1);
    output.write('Shared output\n');
    assert.deepEqual(handler.lines, [timestamp + ' Shared output']);
    installed[0].restore();
});

test('console error stacks and long multiline output retain all text', () => {
    const output = stream();
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    const largeMessage = 'x'.repeat(12_000);
    const error = new Error('temporary DNS failure');
    const text = largeMessage + '\n' + error.stack + '\n';
    output.write(text);
    const originalLines = text.trimEnd().split('\n');
    assert.deepEqual(handler.lines, originalLines.map(line => timestamp + ' ' + line));
    assert.equal(handler.lines[0].length, timestamp.length + 1 + largeMessage.length);
    assert.match(output.text, /temporary DNS failure/u);
    assert.ok(handler.lines.some(line => line.includes('runtimeLogging.test.js')));
    consoleStream.restore();
});

test('UTF-8 buffer chunks split inside multibyte characters retain complete output', () => {
    const output = stream();
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    const bytes = Buffer.from('❄️ Crow Control – Pokémon\n');
    for (let index = 0; index < bytes.length; index++) output.write(bytes.subarray(index, index + 1));
    assert.equal(output.text, timestamp + ' ❄️ Crow Control – Pokémon\n');
    assert.deepEqual(handler.lines, [timestamp + ' ❄️ Crow Control – Pokémon']);
    consoleStream.restore();
});

test('write overloads preserve callbacks, stream receiver and backpressure', () => {
    const output = stream({ backpressure: false });
    const consoleStream = new TimestampedConsole(output, { now }).install();
    let callbacks = 0;
    const callback = () => { callbacks++; };
    assert.equal(output.write('One\n', callback), false);
    assert.equal(output.write('Two\n', 'utf8', callback), false);
    assert.equal(output.write(Buffer.from('Three\n'), callback), false);
    assert.equal(callbacks, 3);
    assert.equal(output.calls[0].encoding, callback);
    assert.equal(output.calls[1].encoding, 'utf8');
    assert.equal(output.calls[1].callback, callback);
    assert.equal(output.text, timestamp + ' One\n' + timestamp + ' Two\n' + timestamp + ' Three\n');
    consoleStream.restore();
});

test('flush persists the final incomplete line exactly once and restore returns original write', () => {
    const output = stream();
    const originalWrite = output.write;
    const handler = fileHandler();
    const consoleStream = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    output.write('Final partial');
    assert.deepEqual(handler.lines, []);
    consoleStream.flush();
    consoleStream.flush();
    assert.deepEqual(handler.lines, [timestamp + ' Final partial']);
    consoleStream.restore();
    assert.equal(output.write, originalWrite);
    output.write(' original output');
    assert.equal(output.text, timestamp + ' Final partial original output');
    assert.deepEqual(handler.lines, [timestamp + ' Final partial']);
});

test('logging starts maintenance immediately, checks hourly and unreferences its timer', () => {
    const instance = runtime();
    assert.equal(instance.handler.maintenanceCalls, 1);
    assert.equal(instance.scheduled.length, 1);
    assert.equal(instance.scheduled[0].delay, 3_600_000);
    assert.equal(instance.scheduled[0].unrefCalls, 1);
    assert.equal(instance.stdout.text, timestamp + ' Detailed logs are being saved to ' + instance.handler.baseFilename + '\n');
    instance.scheduled[0].callback();
    assert.equal(instance.handler.maintenanceCalls, 2);
    instance.logging.stop();
});

test('maintenance notices use consistent text in both console and file', () => {
    const handler = fileHandler();
    const notice = 'Log maintenance deleted 2 completed monthly log file(s) to enforce retention/storage limits.';
    handler.enforceLimits = function() { this.maintenanceCalls++; return [notice]; };
    const instance = runtime({ fileHandler: handler });
    assert.equal(instance.stderr.text, timestamp + ' ' + notice + '\n');
    assert.ok(handler.lines.includes(timestamp + ' ' + notice));
    instance.logging.stop();
});

test('file-open failure keeps timestamped console output and installs no maintenance timer', () => {
    const instance = runtime({ fileHandler: null });
    assert.equal(instance.stderr.text, timestamp + ' File logging could not be enabled; console logging will continue normally.\n');
    assert.equal(instance.scheduled.length, 0);
    instance.stdout.write('Still running\n');
    assert.equal(instance.stdout.text, timestamp + ' Still running\n');
    instance.logging.stop();
});

test('file write failures are reported once without recursive mirroring or lost console output', () => {
    const handler = fileHandler();
    handler.write = () => { throw new Error('test disk failure'); };
    const instance = runtime({ fileHandler: handler });
    assert.match(instance.stdout.text, /Detailed logs are being saved/u);
    assert.match(instance.stderr.text, /File logging failed: Error: test disk failure/u);
    const before = instance.stderr.text;
    instance.stdout.write('Still running\n');
    assert.match(instance.stdout.text, /Still running/u);
    assert.equal((instance.stderr.text.slice(before.length).match(/File logging failed:/gu) || []).length, 1);
    instance.logging.stop();
});

test('maintenance errors leave future console output and maintenance checks operational', () => {
    const handler = fileHandler();
    handler.enforceLimits = function() { this.maintenanceCalls++; throw new Error('test maintenance failure'); };
    const instance = runtime({ fileHandler: handler });
    assert.match(instance.stderr.text, /File logging failed: Error: test maintenance failure/u);
    instance.scheduled[0].callback();
    assert.equal(handler.maintenanceCalls, 2);
    instance.stdout.write('Recovered operation\n');
    assert.ok(handler.lines.includes(timestamp + ' Recovered operation'));
    instance.logging.stop();
});

test('stop flushes both streams, closes once and removes maintenance and process listeners', () => {
    const stdout = stream();
    const stderr = stream();
    const originalOut = stdout.write;
    const originalErr = stderr.write;
    const instance = runtime({ stdout, stderr });
    stdout.write('Partial stdout');
    stderr.write('Partial stderr');
    instance.logging.stop();
    instance.logging.stop();
    assert.equal(instance.handler.closeCalls, 1);
    assert.deepEqual(instance.cleared, [instance.scheduled[0]]);
    assert.ok(instance.handler.lines.includes(timestamp + ' Partial stdout'));
    assert.ok(instance.handler.lines.includes(timestamp + ' Partial stderr'));
    assert.equal(stdout.write, originalOut);
    assert.equal(stderr.write, originalErr);
    assert.equal(instance.processImpl.listenerCount('exit'), 0);
    assert.equal(instance.processImpl.listenerCount('uncaughtExceptionMonitor'), 0);
    instance.scheduled[0].callback();
    assert.equal(instance.handler.maintenanceCalls, 1);
});

test('process exit flushes unterminated output and closes monthly log', () => {
    const instance = runtime();
    instance.stdout.write('Final shutdown output');
    instance.processImpl.emit('exit', 0);
    assert.ok(instance.handler.lines.includes(timestamp + ' Final shutdown output'));
    assert.equal(instance.handler.closeCalls, 1);
    assert.equal(instance.cleared.length, 1);
});

test('fatal exception monitor preserves pending output and full error stack without installing a handler', () => {
    const instance = runtime();
    const error = new Error('fatal test error');
    instance.stdout.write('Before fatal error');
    assert.equal(instance.processImpl.listenerCount('uncaughtException'), 0);
    instance.processImpl.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
    assert.ok(instance.handler.lines.includes(timestamp + ' Before fatal error'));
    assert.equal(instance.handler.lines.at(-1), timestamp + ' ' + error.stack);
    assert.equal(instance.handler.closeCalls, 0);
    instance.logging.stop();
});

test('uncaught fatal exception exits unsuccessfully and writes its full traceback to the monthly file', t => {
    const directory = temporaryDirectory(t);
    const basePath = path.join(directory, 'cc.log');
    const modulePath = path.resolve(__dirname, '../utils/runtimeLogging.js');
    const script = 'require(' + JSON.stringify(modulePath) + ').installRuntimeLogging();'
        + 'process.stdout.write("Before native fatal error");'
        + 'setImmediate(() => { throw new Error("controlled native fatal error"); });';
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: directory,
        env: { ...process.env, BOT_LOG_PATH: basePath, BOT_LOG_MIN_FREE_MIB: '0' },
        encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /controlled native fatal error/u);
    const filename = fs.readdirSync(directory).find(name => /^cc-\d{4}-\d{2}\.log$/u.test(name));
    assert.ok(filename);
    const saved = fs.readFileSync(path.join(directory, filename), 'utf8');
    assert.match(saved, /Before native fatal error/u);
    assert.match(saved, /Error: controlled native fatal error/u);
    assert.match(saved, /at Immediate/u);
});

test('hourly maintenance timer does not keep a finished process alive', t => {
    const directory = temporaryDirectory(t);
    const modulePath = path.resolve(__dirname, '../utils/runtimeLogging.js');
    const result = spawnSync(process.execPath, ['-e',
        'require(' + JSON.stringify(modulePath) + ').installRuntimeLogging();'
        + 'process.stdout.write("Clean exit");'
    ], {
        cwd: directory,
        env: { ...process.env, BOT_LOG_PATH: path.join(directory, 'cc.log'), BOT_LOG_MIN_FREE_MIB: '0' },
        encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const filename = fs.readdirSync(directory).find(name => /^cc-\d{4}-\d{2}\.log$/u.test(name));
    const saved = fs.readFileSync(path.join(directory, filename), 'utf8');
    assert.match(saved, /Clean exit/u);
});

test('timestamps use UTC across offsets and calendar boundaries', () => {
    assert.equal(formatTimestamp(new Date('2026-11-01T00:04:05+02:00')), '[2026-10-31 22:04:05]');
    assert.equal(formatTimestamp(new Date('2026-10-08T01:02:03-05:00')), '[2026-10-08 06:02:03]');
});

test('console and file logs remove CC tags and preserve useful component prefixes', () => {
    const instance = runtime();
    instance.stdout.write('[CC LOG] Started.\n');
    instance.stderr.write('[DB LOG] MySQL connection restored.\n[PRO NOTIFICATIONS] Poll complete.\n');
    assert.ok(instance.stdout.text.endsWith(timestamp + ' Started.\n'));
    assert.equal(instance.stderr.text, timestamp + ' [DB LOG] MySQL connection restored.\n'
        + timestamp + ' [PRO NOTIFICATIONS] Poll complete.\n');
    assert.ok(instance.handler.lines.includes(timestamp + ' Started.'));
    assert.ok(instance.handler.lines.includes(timestamp + ' [DB LOG] MySQL connection restored.'));
    assert.ok(instance.handler.lines.includes(timestamp + ' [PRO NOTIFICATIONS] Poll complete.'));
    assert.equal(instance.handler.lines.some(line => line.startsWith(timestamp + ' [CC LOG]')), false);
    instance.logging.stop();
});

test('split bot prefixes are removed once while quoted tags and component labels remain intact', () => {
    for (const prefix of ['CC', 'WW']) {
        const output = stream();
        const handler = fileHandler();
        const wrapped = new TimestampedConsole(output, { fileHandler: handler, now }).install();
        for (const chunk of ['[' + prefix, ' LOG', ']', ' ', 'Message mentions [CC LOG] here.\n', '[D', 'B LOG] Query complete.\n']) {
            output.write(chunk);
        }
        assert.equal(output.text, timestamp + ' Message mentions [CC LOG] here.\n'
            + timestamp + ' [DB LOG] Query complete.\n');
        assert.deepEqual(handler.lines, [timestamp + ' Message mentions [CC LOG] here.',
            timestamp + ' [DB LOG] Query complete.']);
        wrapped.restore();
    }
});

test('flush retains an unfinished possible tag instead of dropping output', () => {
    const output = stream();
    const handler = fileHandler();
    const wrapped = new TimestampedConsole(output, { fileHandler: handler, now }).install();
    output.write('[CC');
    wrapped.flush();
    assert.equal(output.text, timestamp + ' [CC');
    assert.deepEqual(handler.lines, [timestamp + ' [CC']);
    wrapped.restore();
});


test('command inventory blocks timestamp only their header in console and file output', () => {
    const { buildCommandSummary } = require('../utils/commandSummary.js');
    const instance = runtime({ stdout: stream({ backpressure: false }) });
    instance.stdout.text = '';
    instance.handler.lines = [];
    const summary = buildCommandSummary([
        { name: 'ping' }, { name: 'Edit Example', type: 3 }
    ], [{ name: 'write', prefixes: ['!', '?'] }]);
    const block = timestamp + ' ' + summary.lines.join('\n');
    instance.stdout.write('Before inventory\n');
    assert.equal(instance.logging.logBlock(summary.lines), false);
    instance.stdout.write('After inventory\n');
    instance.stderr.write('Other component error\n');
    assert.equal(instance.stdout.text, timestamp + ' Before inventory\n' + block + '\n'
        + timestamp + ' After inventory\n');
    assert.equal(instance.stderr.text, timestamp + ' Other component error\n');
    assert.deepEqual(instance.handler.lines, [
        timestamp + ' Before inventory', block, timestamp + ' After inventory',
        timestamp + ' Other component error'
    ]);
    assert.ok(block.split('\n').slice(1).every(line => line.startsWith(' - ') && !line.includes(timestamp)));
    instance.logging.stop();
});

test('command inventory blocks preserve pending output and work without file logging', () => {
    const instance = runtime({ fileHandler: null });
    instance.stdout.text = '';
    instance.stdout.write('Partial previous log');
    instance.logging.logBlock(['Loaded inventory:', ' - Example']);
    instance.stdout.write('Next log\n');
    assert.equal(instance.stdout.text, timestamp + ' Partial previous log\n'
        + timestamp + ' Loaded inventory:\n - Example\n' + timestamp + ' Next log\n');
    instance.logging.stop();
});
