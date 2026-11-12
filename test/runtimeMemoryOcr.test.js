'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { OcrWorkerPool, sharedOcrWorkerPool, configureImageMemory } = require('../utils/runtimeMemoryOcr.js');
const { PvpScoutOcr } = require('../features/pvp-scouting/PvpScoutOcr.js');
const { GuildApplicationOcr } = require('../features/guild-applications/parsing/GuildApplicationOcr.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function timers() {
    const active = new Map();
    return {
        active,
        setTimeout(callback, delay) {
            const timer = { unref() {} };
            active.set(timer, { callback, delay });
            return timer;
        },
        clearTimeout(timer) { active.delete(timer); },
        expire() {
            const [timer, { callback }] = active.entries().next().value;
            active.delete(timer);
            callback();
        }
    };
}

test('OCR health retains short-lived worker peaks and counts jobs without counting cleanup as work', async () => {
    const worker = { recognize: async () => 'recognized', terminate: async () => {},
        memorySnapshot: () => ({ rss: 100, peakRss: 250 }) };
    const pool = new OcrWorkerPool({ worker, idleTimeoutMs: 0 });
    await pool.run(() => pool.recognize('image'));
    await assert.rejects(pool.run(async () => { throw new Error('controlled failure'); }), /controlled failure/);
    await pool.close();
    const snapshot = pool.healthSnapshot();
    assert.equal(snapshot.workers, 0); assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.tasksStarted, 2); assert.equal(snapshot.tasksCompleted, 1);
    assert.equal(snapshot.tasksFailed, 1); assert.equal(snapshot.peakProcessRss, 250);
});

test('Gold, Silver and guild OCR share one production pool while injected factories remain isolated', () => {
    const gold = new PvpScoutOcr();
    const silver = new PvpScoutOcr();
    const guild = new GuildApplicationOcr();
    for (const ocr of [gold, silver, guild]) assert.equal(ocr.workerPool, sharedOcrWorkerPool);
    const custom = new GuildApplicationOcr({ workerFactory: async () => ({}) });
    assert.notEqual(custom.workerPool, sharedOcrWorkerPool);
});

test('OCR tasks across features cannot overlap and share a single worker', async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    let creates = 0;
    let activeRecognizes = 0;
    let maxRecognizes = 0;
    let calls = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        creates++;
        return {
            async recognize() {
                calls++;
                activeRecognizes++;
                maxRecognizes = Math.max(maxRecognizes, activeRecognizes);
                if (calls === 1) {
                    firstStarted.resolve();
                    await firstRelease.promise;
                }
                activeRecognizes--;
                return { data: { text: 'Name: Rega', confidence: 90 } };
            },
            async terminate() {}
        };
    } });
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const gold = new PvpScoutOcr({ workerPool: pool });
    const silver = new PvpScoutOcr({ workerPool: pool });
    gold.download = silver.download = async () => ({ buffer: image });
    const guild = new GuildApplicationOcr({ workerPool: pool });
    const first = gold.analyzeAttachment({ id: 'first', url: 'image' }, 'message');
    await firstStarted.promise;
    const second = silver.analyzeAttachment({ id: 'second', url: 'image' }, 'message');
    const third = guild.resolveIgn({ forumUsername: 'Rega' }, { fields: {} }, [{ buffer: image, url: 'card' }]);
    assert.equal(pool.snapshot().pending, 3);
    assert.equal(calls, 1);
    firstRelease.resolve();
    const [goldResult, silverResult, guildResult] = await Promise.all([first, second, third]);
    assert.equal(goldResult.error, null);
    assert.equal(silverResult.error, null);
    assert.equal(guildResult.ign, 'Rega');
    assert.equal(maxRecognizes, 1);
    assert.equal(creates, 1);
    assert.deepEqual(pool.snapshot(), { workers: 1, creating: false, pending: 0 });
    await pool.close();
});

test('idle workers terminate and the next request recreates them', async () => {
    const clock = timers();
    let creates = 0;
    let terminates = 0;
    const pool = new OcrWorkerPool({ ...clock, idleTimeoutMs: 100, workerFactory: async () => {
        creates++;
        return { async terminate() { terminates++; } };
    } });
    const first = await pool.run(() => pool.getWorker());
    assert.equal(clock.active.size, 1);
    assert.equal([...clock.active.values()][0].delay, 100);
    clock.expire();
    await pool.queue;
    assert.equal(terminates, 1);
    assert.equal(pool.snapshot().workers, 0);
    assert.equal(clock.active.size, 0);
    const second = await pool.run(() => pool.getWorker());
    assert.notEqual(first, second);
    assert.equal(creates, 2);
    await pool.close();
    assert.equal(terminates, 2);
    assert.equal(clock.active.size, 0);
});

test('a queued or active task cancels idle termination and shutdown waits for it', async () => {
    const clock = timers();
    const release = deferred();
    let terminates = 0;
    const pool = new OcrWorkerPool({ ...clock, workerFactory: async () => ({ async terminate() { terminates++; } }) });
    await pool.run(() => pool.getWorker());
    const task = pool.run(async () => { await pool.getWorker(); await release.promise; });
    assert.equal(clock.active.size, 0);
    const closing = pool.close();
    await Promise.resolve();
    assert.equal(terminates, 0);
    release.resolve();
    await Promise.all([task, closing]);
    assert.equal(terminates, 1);
    assert.equal(clock.active.size, 0);
});

test('worker creation failure and OCR rejection do not poison the shared queue', async () => {
    let attempts = 0;
    const worker = { async terminate() {} };
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        if (++attempts === 1) throw new Error('initialization failed');
        return worker;
    } });
    await assert.rejects(pool.run(() => pool.getWorker()), /initialization failed/u);
    assert.equal(await pool.run(() => pool.getWorker()), worker);
    await assert.rejects(pool.run(() => { throw new Error('scan failed'); }), /scan failed/u);
    assert.equal(await pool.run(() => 'next scan'), 'next scan');
    assert.equal(await pool.queue, undefined);
    assert.equal(pool.snapshot().pending, 0);
    await pool.close();
});

test('directly injected workers stay available until explicit close', async () => {
    const clock = timers();
    let terminates = 0;
    const worker = { async terminate() { terminates++; } };
    const pool = new OcrWorkerPool({ ...clock, worker });
    assert.equal(await pool.run(() => pool.getWorker()), worker);
    assert.equal(clock.active.size, 0);
    await pool.close();
    assert.equal(terminates, 1);
});

test('a failed recognition discards its worker before the next feature reuses the pool', async () => {
    let creates = 0;
    const terminated = [];
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        const id = ++creates;
        return {
            async recognize() {
                if (id === 1) throw new Error('failed with a temporary whitelist');
                return { data: { text: 'Name: Rega' } };
            },
            async terminate() { terminated.push(id); }
        };
    } });
    await assert.rejects(pool.run(() => pool.recognize(Buffer.from('image'))), /temporary whitelist/u);
    assert.deepEqual(terminated, [1]);
    assert.equal(pool.snapshot().workers, 0);
    const result = await pool.run(() => pool.recognize(Buffer.from('image')));
    assert.equal(result.data.text, 'Name: Rega');
    assert.equal(creates, 2);
    await pool.close();
    assert.deepEqual(terminated, [1, 2]);
});

test('image memory limits configure each sharp implementation once', () => {
    const calls = [];
    const fakeSharp = { cache: value => calls.push(value), concurrency: value => calls.push(value) };
    configureImageMemory(fakeSharp);
    configureImageMemory(fakeSharp);
    assert.deepEqual(calls, [{ memory: 16, files: 0, items: 32 }, 1]);
});

test('Tesseract string rejections retain their message for contextual error reporting', async () => {
    let terminated = false;
    const pool = new OcrWorkerPool({ worker: {
        async recognize() { throw 'decoder could not read the image'; },
        async terminate() { terminated = true; }
    } });
    await assert.rejects(pool.run(() => pool.recognize(Buffer.from('invalid'))),
        error => error instanceof Error && error.message === 'decoder could not read the image');
    assert.equal(terminated, true);
    assert.equal(pool.snapshot().workers, 0);
});

test('a burst of thirty Gold/Silver scout images queues downloads and image processing one at a time', async () => {
    const firstStarted = deferred(), release = deferred();
    let creates = 0, activeImages = 0, maxActiveImages = 0, downloads = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        creates++;
        return { async recognize() { return { data: { text: 'Name: Rega', confidence: 90 } }; }, async terminate() {} };
    } });
    const image = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const servers = [new PvpScoutOcr({ workerPool: pool }), new PvpScoutOcr({ workerPool: pool })];
    for (const ocr of servers) {
        const analyze = ocr.analyzeAttachmentQueued.bind(ocr);
        ocr.analyzeAttachmentQueued = async (...args) => {
            activeImages++;
            maxActiveImages = Math.max(maxActiveImages, activeImages);
            try { return await analyze(...args); }
            finally { activeImages--; }
        };
        ocr.download = async () => {
            if (++downloads === 1) { firstStarted.resolve(); await release.promise; }
            return { buffer: image };
        };
    }
    const jobs = Array.from({ length: 30 }, (_, i) => servers[i % 2].analyzeAttachment({ id: String(i), url: 'image' }, String(i)));
    await firstStarted.promise;
    assert.equal(downloads, 1, 'waiting reports must not predownload their images');
    assert.equal(pool.snapshot().pending, 30);
    release.resolve();
    try {
        const results = await Promise.all(jobs);
        assert.equal(results.length, 30);
        assert.equal(new Set(results.map(result => result.attachmentId)).size, 30);
        assert.ok(results.every(result => result.error === null));
        assert.equal(downloads, 30);
        assert.equal(maxActiveImages, 1);
        assert.equal(creates, 1);
        assert.equal(pool.snapshot().pending, 0);
    } finally { await pool.close(); }
});

test('thirty complete image jobs reuse helpers in batches without routine sleeps or losing order', async () => {
    let created = 0, active = 0, peak = 0, terminated = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, containerMemory: async () => null,
        pause: async () => { throw new Error('Normal load must not sleep'); }, workerFactory: async () => {
            created++;
            return { async analyzeScout(id) {
                active++; peak = Math.max(peak, active);
                await new Promise(resolve => setImmediate(resolve));
                active--; return id;
            }, async terminate() { assert.equal(active, 0); terminated++; } };
        } });
    const results = await Promise.all(Array.from({ length: 30 }, (_, id) => pool.run(() => pool.processImage('analyzeScout', id))));
    assert.deepEqual(results, Array.from({ length: 30 }, (_, id) => id));
    assert.equal(peak, 1); assert.equal(created, 2); assert.equal(terminated, 1);
    await pool.close(); assert.equal(terminated, 2);
});

test('memory pressure releases the old helper before checking whether a short pause is needed', async () => {
    const calls = []; let high = false;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0,
        containerMemory: async () => ({ used: (high ? 440 : 250) * 1048576, limit: 512 * 1048576 }),
        pause: async () => { throw new Error('Recycling already relieved pressure'); },
        workerFactory: async () => { calls.push('create'); return {
            async analyzeScout(id) { calls.push('scan'); return id; },
            async terminate() { calls.push('terminate'); high = false; }
        }; } });
    await pool.run(() => pool.processImage('analyzeScout', 1));
    high = true;
    assert.equal(await pool.run(() => pool.processImage('analyzeScout', 2)), 2);
    assert.deepEqual(calls, ['create', 'scan', 'terminate', 'create', 'scan']);
    await pool.close();
});

test('inactive file cache does not pause OCR or recycle its helper', async () => {
    let created = 0, terminated = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0,
        containerMemory: async () => ({ used: 490 * 1048576, limit: 512 * 1048576,
            fileCache: 290 * 1048576, inactiveFile: 270 * 1048576, workingSet: 220 * 1048576 }),
        pause: async () => assert.fail('Reclaimable cache must not delay OCR'),
        workerFactory: async () => { created++; return {
            async analyzeScout(id) { return id; }, async terminate() { terminated++; }
        }; } });
    try {
        assert.equal(await pool.run(() => pool.processImage('analyzeScout', 1)), 1);
        assert.equal(await pool.run(() => pool.processImage('analyzeScout', 2)), 2);
        assert.equal(created, 1);
        assert.equal(terminated, 0);
    } finally { await pool.close(); }
});

test('missing cgroups still recycle OCR using live parent and helper RSS', async () => {
    let high = false, creates = 0, terminated = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, containerMemory: async () => null,
        rssUsage: () => 200 * 1048576, processRss: async () => (high ? 250 : 100) * 1048576,
        pause: async () => assert.fail('recycling relieved the pressure'),
        workerFactory: async () => {
            creates++;
            return { processId: 123, async analyzeScout(id) { return id; }, async terminate() { terminated++; high = false; } };
        } });
    try {
        assert.equal(await pool.run(() => pool.processImage('analyzeScout', 1)), 1);
        high = true;
        assert.equal(await pool.run(() => pool.processImage('analyzeScout', 2)), 2);
        assert.equal(creates, 2);
        assert.equal(terminated, 1);
    } finally { await pool.close(); }
});

test('OCR fallback retains a smaller known container limit after accounting becomes unavailable', async () => {
    const pool = new OcrWorkerPool({ containerMemory: async () => ({ used: 100 * 1048576, limit: 256 * 1048576 }),
        rssUsage: () => 220 * 1048576 });
    assert.equal(await pool.memoryPressure(), false);
    pool.containerMemory = async () => null;
    assert.equal(await pool.memoryPressure(), true);
    await pool.close();
});

test('genuine working-set pressure still recycles OCR and preserves the bounded delay', async () => {
    const delays = [], logs = [];
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0,
        containerMemory: async () => ({ used: 490 * 1048576, limit: 512 * 1048576,
            inactiveFile: 40 * 1048576, workingSet: 450 * 1048576 }),
        pause: async ms => delays.push(ms), log: text => logs.push(text),
        workerFactory: async () => ({ async analyzeScout() { return 'done'; }, async terminate() {} }) });
    try {
        assert.equal(await pool.run(() => pool.processImage('analyzeScout')), 'done');
        assert.deepEqual(delays, [1000, 1000, 1000, 1000, 1000]);
        assert.equal(logs.length, 1);
        assert.equal(pool.snapshot().workers, 0);
    } finally { await pool.close(); }
});

test('sustained pressure adds at most five seconds and still processes the report', async () => {
    const delays = [], logs = [];
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0,
        containerMemory: async () => ({ used: 450 * 1048576, limit: 588.8 * 1048576 }),
        pause: async ms => { delays.push(ms); }, log: text => logs.push(text),
        workerFactory: async () => ({ async analyzeScout() { return 'completed'; }, async terminate() {} }) });
    assert.equal(await pool.run(() => pool.processImage('analyzeScout')), 'completed');
    assert.deepEqual(delays, [1000, 1000, 1000, 1000, 1000]);
    assert.equal(logs.length, 1);
    assert.equal(pool.snapshot().workers, 0, 'release immediately after a high-memory job');
    await pool.close();
});

test('pressure pauses end early and unavailable metrics never prevent processing', async () => {
    let high = true, pauses = 0;
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0,
        containerMemory: async () => ({ used: (high ? 360 : 200) * 1048576, limit: 400 * 1048576 }),
        pause: async () => { pauses++; high = false; }, log() {},
        workerFactory: async () => ({ async analyzeScout() { return 'done'; }, async terminate() {} }) });
    assert.equal(await pool.run(() => pool.processImage('analyzeScout')), 'done');
    assert.equal(pauses, 1);
    pool.containerMemory = async () => { throw new Error('Cannot read cgroup'); };
    assert.equal(await pool.run(() => pool.processImage('analyzeScout')), 'done');
    assert.equal(pauses, 1);
    await pool.close();
});

test('production scout pipeline sends only attachment metadata and keeps download/decoding out of the parent', async () => {
    const ocr = new PvpScoutOcr();
    let request;
    ocr.download = async () => { throw new Error('Parent must not download'); };
    ocr.workerPool = { run: task => task(), processImage: async (...args) => { request = args; return { text: 'same result' }; } };
    const attachment = { id: 'id', name: 'image.png', url: 'https://cdn.discordapp.com/image.png', client: { large: true } };
    assert.deepEqual(await ocr.analyzeAttachment(attachment, 'message', 'Rega', { memberNames: [] }), { text: 'same result' });
    assert.equal(request[0], 'analyzeScout');
    assert.deepEqual(request[1], { id: 'id', name: 'image.png', url: attachment.url });
    assert.equal(request[2], 'message');
    assert.equal(request[3], 'Rega');
});

test('OCR tasks name their feature in the job list only while they run', async () => {
    const { RuntimeActivity } = require('../utils/runtimeActivity.js');
    const activity = new RuntimeActivity();
    const pool = new OcrWorkerPool({ worker: { async recognize() { return {}; }, async terminate() {} }, activity });
    const gate = deferred();
    const first = pool.run(async () => { await gate.promise; }, { label: 'PvP Scout Silver' });
    const second = pool.run(async () => {}, { label: 'Guild application' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(activity.snapshot().active.map(job => job.name), ['OCR: PvP Scout Silver'], 'a queued task is not listed as running');
    gate.resolve();
    await first;
    await second;
    assert.deepEqual(activity.snapshot().active, []);
    assert.deepEqual(activity.snapshot().recent.map(job => job.name), ['OCR: PvP Scout Silver', 'OCR: Guild application']);
    await pool.close();
});
