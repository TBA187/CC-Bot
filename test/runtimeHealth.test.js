'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeHealth, readContainerMemory, discordCacheCounts } = require('../utils/runtimeHealth.js');
const { RuntimeActivity } = require('../utils/runtimeActivity.js');
const MIB = 1024 * 1024;

function readFixture(values) {
    return async file => {
        if (!(file in values)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return values[file];
    };
}

test('container memory supports v2 and v1 accounting, separately showing file cache', async () => {
    assert.deepEqual(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory.current': '450887680\n', '/sys/fs/cgroup/memory.max': '536870912\n',
        '/sys/fs/cgroup/memory.stat': 'anon 360000000\nfile 90000000\ninactive_file 80000000\n'
    })), { used: 450887680, limit: 536870912, fileCache: 90000000, inactiveFile: 80000000, workingSet: 370887680 });
    assert.deepEqual(await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '100',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '200',
        '/sys/fs/cgroup/memory/memory.stat': 'cache 10\ntotal_cache 15\ninactive_file 5\ntotal_inactive_file 12\n'
    })), { used: 100, limit: 200, fileCache: 15, inactiveFile: 12, workingSet: 88 });
});

test('panel estimates require valid inactive cache accounting and accept zero cache', async () => {
    for (const [stat, expected] of [['file 90\n', null], ['inactive_file 101\n', null], ['inactive_file 0\n', 100]]) {
        const container = await readContainerMemory(readFixture({
            '/sys/fs/cgroup/memory.current': '100', '/sys/fs/cgroup/memory.max': '200',
            '/sys/fs/cgroup/memory.stat': stat
        }));
        assert.equal(container.workingSet, expected);
    }
});

test('job tracking distinguishes overlapping runs and bounds its completed history without timers', () => {
    let now = 0;
    const activity = new RuntimeActivity({ now: () => now, recentMs: 100, maxRecent: 2 });
    const first = activity.begin('scan'), second = activity.begin('scan');
    now = 20;
    first(); first();
    assert.equal(activity.snapshot().active.length, 1);
    assert.deepEqual(activity.snapshot().recent, [{ name: 'scan', elapsedMs: 20, endedAgoMs: 0 }]);
    second(); activity.begin('third')();
    assert.equal(activity.snapshot().recent.length, 2);
    now = 121;
    assert.deepEqual(activity.snapshot(), { active: [], recent: [] });
});

test('warnings and recoveries include panel estimates, heap and jobs without full reads on every tick', async () => {
    let now = 0, used = 300 * MIB, fullReads = 0;
    const warnings = [], reports = [];
    const activity = new RuntimeActivity({ now: () => now });
    const health = new RuntimeHealth({ now: () => now, intervalMs: 30000,
        consoleObject: { warn: line => warnings.push(line), log: line => reports.push(line) },
        memoryUsage: () => { fullReads++; return { rss: 180 * MIB, heapUsed: 60 * MIB, heapTotal: 90 * MIB, external: 0 }; },
        rssUsage: () => 180 * MIB, heapLimit: () => 340 * MIB, containerPeak: async () => null, processPeak: () => 0,
        containerMemory: async () => ({ used, limit: 512 * MIB, fileCache: 83 * MIB, inactiveFile: 76 * MIB, workingSet: used - 76 * MIB }),
        activitySnapshot: () => activity.snapshot() });
    await health.sample();
    const finish = activity.begin('WW server-tag verification');
    now = 5000; used = 490 * MIB; await health.sample({ report: false });
    assert.equal(fullReads, 2);
    assert.match(warnings[0], /WARNING: 414.0\/512.0 MiB .*container working set; inactive file cache excluded/);
    assert.match(warnings[0], /container total including cache 490.0 MiB/);
    assert.match(warnings[0], /inactive file cache 76.0 MiB; panel-equivalent estimate 414.0 MiB/);
    assert.match(warnings[0], /bot RSS 180.0 MiB; main heap 60.0\/90.0 MiB/);
    assert.match(warnings[0], /active jobs: WW server-tag verification \(5.0s\)/);
    now = 6000; await health.sample({ report: false });
    assert.equal(fullReads, 2);
    finish();
    now = 7000; used = 443.9 * MIB; await health.sample({ report: false });
    assert.equal(fullReads, 3);
    assert.match(reports.at(-1), /Recovered below 75%: 367.9\/512.0/);
    assert.match(reports.at(-1), /panel-equivalent estimate 367.9 MiB/);
    assert.match(reports.at(-1), /active jobs: none; recent jobs: WW server-tag verification \(6.0s, ended 1.0s ago\)/);
    now = 30000; await health.sample({ report: false });
    assert.equal(reports.length, 2, 'healthy sampling must not add a periodic report');
});

test('unlimited cgroups retain usage for the bot budget and unavailable cgroups use the fallback', async () => {
    assert.equal((await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory.current': '100', '/sys/fs/cgroup/memory.max': 'max'
    }))).used, 100);
    assert.equal((await readContainerMemory(readFixture({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '100',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712'
    }))).limit, null);
    assert.equal(await readContainerMemory(readFixture({})), null);
});

test('runtime samples count caches without fetching Discord or treating buffers as extra RSS', async () => {
    const client = { channels: { cache: new Map([['a', { messages: { cache: new Map([['x', {}], ['y', {}]]) } }], ['b', {}]]) },
        guilds: { cache: new Map([['g', { members: { cache: new Map([['u', {}]]) } }]]) },
        users: { cache: new Map([['u', {}], ['v', {}]]) } };
    assert.deepEqual(discordCacheCounts(client), { messages: 2, members: 1, users: 2 });
    const lines = [];
    let rss = 100 * MIB;
    const health = new RuntimeHealth({ client, consoleObject: { log: line => lines.push(line) },
        memoryUsage: () => ({ rss, heapUsed: 20 * MIB, heapTotal: 40 * MIB, external: 10 * MIB, arrayBuffers: 5 * MIB }),
        heapLimit: () => 256 * MIB, containerMemory: async () => ({ used: 400 * MIB, limit: 512 * MIB, fileCache: 80 * MIB }),
        ocrSnapshot: () => ({ workers: 1, pending: 2, creating: false }) });
    await health.sample();
    rss = 90 * MIB; await health.sample();
    assert.match(lines[0], /RSS 100.0 MiB/);
    assert.match(lines[0], /main heap 20.0\/40.0 MiB/);
    assert.match(lines[0], /container total including cache 400.0\/512.0 MiB \(78.1%\)/);
    assert.match(lines[0], /container file cache 80.0 MiB/);
    assert.match(lines[0], /2 messages, 1 members, 2 users/);
    assert.match(lines[0], /OCR: 1 worker\(s\), 2 queued\/active task\(s\)/);
    assert.match(lines[1], /peak sampled 100.0 MiB/);
});

test('memory reporting has one unreferenced timer and suppresses late output after shutdown', async () => {
    let complete, scheduled = 0, cancelled = 0, unreferenced = 0;
    const lines = [];
    const timer = { unref() { unreferenced++; } };
    const health = new RuntimeHealth({ consoleObject: { log: line => lines.push(line) },
        containerMemory: () => new Promise(resolve => { complete = resolve; }),
        schedule: () => { scheduled++; return timer; }, cancel: value => { assert.equal(value, timer); cancelled++; } });
    health.start(); health.start();
    assert.equal(scheduled, 1); assert.equal(unreferenced, 1);
    await health.sample();
    health.stop(); health.stop(); complete(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1); assert.deepEqual(lines, []);
});

test('memory pressure uses the 512 MiB budget, suppresses repeat warnings, and reports recovery', async () => {
    let now = 1000, used = 409.6 * MIB;
    const warnings = [], reports = [];
    const health = new RuntimeHealth({ now: () => now,
        consoleObject: { warn: line => warnings.push(line), log: line => reports.push(line) },
        containerMemory: async () => ({ used, limit: 588.8 * MIB, fileCache: null }),
        containerPeak: async () => null, processPeak: () => 0 });
    await health.sample();
    assert.match(warnings[0], /WARNING: 409.6\/512.0 MiB \(80.0%/);
    now += 1000; await health.sample(); assert.equal(warnings.length, 1);
    used = 460.8 * MIB; await health.sample();
    assert.match(warnings[1], /CRITICAL: 460.8\/512.0 MiB \(90.0%/);
    now += 600000; await health.sample(); assert.equal(warnings.length, 3);
    used = 380 * MIB; await health.sample();
    assert.ok(reports.some(line => /Recovered below 75%/.test(line)));
    used = 410 * MIB; await health.sample(); assert.equal(warnings.length, 4);
    health.stop();
});

test('the reported cache-heavy startup sequence produces neither warnings nor false recoveries', async () => {
    let sample;
    const warnings = [], reports = [];
    const health = new RuntimeHealth({ consoleObject: { warn: line => warnings.push(line), log: line => reports.push(line) },
        containerMemory: async () => sample, containerPeak: async () => null, processPeak: () => 0 });
    for (const [used, inactive, cache] of [[411.9, 197.6, 207.0], [370.2, 197.3, 206.9], [412.0, 197.3, 206.8]]) {
        sample = await readContainerMemory(readFixture({
            '/sys/fs/cgroup/memory.current': String(Math.round(used * MIB)),
            '/sys/fs/cgroup/memory.max': String(512 * MIB),
            '/sys/fs/cgroup/memory.stat': `file ${Math.round(cache * MIB)}\ninactive_file ${Math.round(inactive * MIB)}\n`
        }));
        await health.sample();
    }
    assert.deepEqual(warnings, []);
    assert.equal(health.alertLevel, 0);
    assert.ok(reports.every(line => !line.includes('Recovered below')));
    assert.match(reports.at(-1), /panel-equivalent estimate 214.7 MiB/);
    assert.match(reports.at(-1), /container total including cache 412.0\/512.0 MiB/);
});

test('working-set warnings, critical pressure and recovery respect a smaller container limit', async () => {
    let used = 240 * MIB, inactiveFile = 16 * MIB;
    const warnings = [], reports = [];
    const health = new RuntimeHealth({ consoleObject: { warn: line => warnings.push(line), log: line => reports.push(line) },
        containerMemory: async () => ({ used, limit: 256 * MIB, inactiveFile, workingSet: used - inactiveFile }),
        containerPeak: async () => null, processPeak: () => 0 });
    await health.sample();
    assert.match(warnings[0], /WARNING: 224.0\/256.0 MiB \(87.5%/);
    used = 250 * MIB; await health.sample();
    assert.match(warnings[1], /CRITICAL: 234.0\/256.0 MiB \(91.4%/);
    used = 210 * MIB; inactiveFile = 30 * MIB; await health.sample();
    assert.match(reports.find(line => line.includes('Recovered below')), /180.0\/256.0 MiB/);
});

test('unavailable or invalid working sets retain raw-total protection and zero remains valid', async () => {
    for (const workingSet of [undefined, null, NaN, -1, 421 * MIB, 0]) {
        const warnings = [];
        const health = new RuntimeHealth({ consoleObject: { warn: line => warnings.push(line), log() {} },
            containerMemory: async () => ({ used: 420 * MIB, limit: 512 * MIB, fileCache: 300 * MIB, workingSet }),
            containerPeak: async () => null, processPeak: () => 0 });
        await health.sample();
        assert.equal(warnings.length, workingSet === 0 ? 0 : 1);
        if (warnings.length) assert.match(warnings[0], /420.0\/512.0 MiB .*inactive file cache unavailable/);
    }
    const warnings = [];
    const health = new RuntimeHealth({ consoleObject: { warn: line => warnings.push(line), log() {} },
        containerMemory: async () => null, containerPeak: async () => null, processPeak: () => 0,
        memoryUsage: () => ({ rss: 420 * MIB, heapUsed: MIB, heapTotal: MIB, external: 0 }) });
    await health.sample();
    assert.match(warnings[0], /420.0\/512.0 MiB .*bot RSS only; isolated OCR excluded/);
});

test('idle sampling is cheap, active OCR samples each second, and short OCR jobs appear in the next report', async () => {
    let now = 0, reads = 0, fullReads = 0, rssReads = 0, pending = 0, tasksStarted = 0, tasksCompleted = 0;
    const reports = [];
    const health = new RuntimeHealth({ now: () => now, intervalMs: 30000,
        consoleObject: { warn() {}, log: line => reports.push(line) },
        containerMemory: async () => { reads++; return null; }, containerPeak: async () => null, processPeak: () => 0,
        memoryUsage: () => { fullReads++; return { rss: 100 * MIB, heapUsed: MIB, heapTotal: MIB, external: 0 }; },
        rssUsage: () => { rssReads++; return 100 * MIB; },
        ocrSnapshot: () => ({ pending, tasksStarted, tasksCompleted, workers: 0 }) });
    await health.sample();
    now = 1000; await health.sample({ report: false }); assert.equal(reads, 1);
    now = 5000; await health.sample({ report: false }); assert.equal(reads, 2);
    pending = 1; tasksStarted = 1;
    now = 6000; await health.sample({ report: false }); assert.equal(reads, 3);
    pending = 0; tasksCompleted = 1;
    now = 7000; await health.sample({ report: false }); assert.equal(reads, 3);
    now = 29999; await health.sample();
    assert.equal(reads, 4); assert.equal(fullReads, 2); assert.equal(rssReads, 2);
    assert.match(reports.at(-1), /1 task\(s\) queued, 1 completed, 0 failed/);
    assert.match(reports.at(-1), /budget 512.0 MiB/);
    const count = reports.length;
    now = 60000; await health.sample({ report: false });
    assert.equal(reports.length, count);
    health.stop();
});

test('normal startup and ongoing OCR sampling stay silent while pressure and recovery remain visible', async () => {
    let tick, used = 200 * MIB, now = 0;
    const lines = [];
    const health = new RuntimeHealth({ now: () => now,
        consoleObject: { warn: text => lines.push(text), log: text => lines.push(text) },
        containerMemory: async () => ({ used, limit: 512 * MIB }),
        ocrSnapshot: () => ({ pending: 1, workers: 1 }),
        schedule: callback => { tick = callback; return { unref() {} }; }, cancel() {} });
    health.start();
    await new Promise(resolve => setImmediate(resolve));
    for (const time of [1000, 5000, 1800000, 3600000]) {
        now = time; tick(); await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(lines, []);
    now += 1000; used = 420 * MIB; tick(); await new Promise(resolve => setImmediate(resolve));
    assert.match(lines[0], /WARNING/);
    now += 1000; used = 380 * MIB; tick(); await new Promise(resolve => setImmediate(resolve));
    assert.match(lines[1], /Recovered below 75%/);
    health.stop();
});

test('Linux accounting loss is reported once, includes live OCR RSS in protection, and does not falsely recover', async () => {
    let container = { used: 420 * MIB, limit: 512 * MIB }, childRss = 240 * MIB;
    const warnings = [], reports = [];
    const health = new RuntimeHealth({ platform: 'linux',
        consoleObject: { warn: line => warnings.push(line), log: line => reports.push(line) },
        containerMemory: async () => container, containerPeak: async () => null,
        processRss: async pid => { assert.equal(pid, 123); return childRss; },
        ocrSnapshot: () => ({ workers: 1, processId: 123 }),
        memoryUsage: () => ({ rss: 200 * MIB, heapUsed: MIB, heapTotal: MIB, external: 0 }) });
    await health.sample();
    container = null; await health.sample(); await health.sample();
    assert.equal(warnings.filter(line => line.includes('Container accounting unavailable')).length, 1);
    childRss = 300 * MIB; await health.sample();
    assert.match(warnings.at(-1), /CRITICAL: 500.0\/512.0 MiB .*bot and OCR process RSS estimate/);
    childRss = 20 * MIB; await health.sample();
    assert.equal(reports.some(line => line.includes('Recovered below')), false);
    container = { used: 230 * MIB, limit: 512 * MIB }; await health.sample();
    assert.equal(reports.filter(line => line.includes('Container accounting restored')).length, 1);
    assert.equal(reports.filter(line => line.includes('Recovered below')).length, 1);
});

test('fallback protection retains smaller limits and an unreadable active helper cannot claim recovery', async () => {
    let container = { used: 100 * MIB, limit: 256 * MIB }, childRss = 100 * MIB, processId = 123;
    const warnings = [], logs = [];
    const health = new RuntimeHealth({ platform: 'linux',
        consoleObject: { warn: line => warnings.push(line), log: line => logs.push(line) },
        containerMemory: async () => container, containerPeak: async () => null,
        memoryUsage: () => ({ rss: 140 * MIB, heapUsed: MIB, heapTotal: MIB, external: 0 }),
        processRss: async () => childRss, ocrSnapshot: () => ({ processId }) });
    await health.sample();
    container = null; await health.sample();
    assert.match(warnings.at(-1), /CRITICAL: 240.0\/256.0 MiB/);
    childRss = null; await health.sample();
    assert.equal(logs.some(line => line.includes('Recovered below')), false);
    processId = undefined; await health.sample();
    assert.equal(logs.filter(line => line.includes('Recovered below')).length, 1);
});
