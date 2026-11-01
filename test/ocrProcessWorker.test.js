'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createOcrProcessWorker } = require('../utils/ocrProcessWorker');
const { OcrWorkerPool } = require('../utils/runtimeMemoryOcr');

function fixture({ failInit = false, exitOnRecognize = false, failScan = false, sendError = false } = {}) {
    const child = new EventEmitter();
    child.pid = 12345;
    const messages = [], kills = [];
    let options;
    child.send = (message, callback) => {
        messages.push(message);
        if (sendError) return callback(new Error('IPC write failed'));
        callback();
        queueMicrotask(() => {
            if (message.action === 'recognize' && exitOnRecognize) return child.emit('exit', 1, null);
            const error = message.action === 'initialize' && failInit ? 'Language load failed'
                : message.action === 'recognize' && failScan ? 'Bad image' : null;
            child.emit('message', { id: message.id, error, result: message.action === 'recognize'
                ? { data: { text: 'Vegeta111', confidence: 92, blocks: [{ paragraphs: [{ lines: [{ text: 'Vegeta111', bbox: { x0: 1, y0: 2, x1: 20, y1: 10 } }] }] }] } }
                : { ready: true } });
        });
    };
    child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('exit', null, signal || 'SIGTERM')); };
    const forkProcess = (script, args, opts) => { options = opts; return child; };
    return { create: () => createOcrProcessWorker({ cachePath: 'cache', forkProcess }), child, messages, kills, options: () => options };
}

test('isolated OCR preserves image bytes, per-call settings, confidence and bounding boxes', async () => {
    const f = fixture();
    const worker = await f.create();
    const bytes = Buffer.from([0, 1, 128, 255]);
    const params = { tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'abc' };
    const output = { text: true, blocks: true };
    const result = await worker.recognize(bytes, params, output);
    assert.deepEqual(f.messages[1].args, [bytes, params, output]);
    assert.equal(result.data.text, 'Vegeta111');
    assert.equal(result.data.confidence, 92);
    assert.equal(result.data.blocks[0].paragraphs[0].lines[0].bbox.x1, 20);
    assert.equal(f.options().serialization, 'advanced');
    assert.equal(f.options().windowsHide, true);
    assert.deepEqual(f.options().execArgv, []);
    await worker.terminate();
    await worker.terminate();
    assert.equal(f.kills.length, 1);
    await assert.rejects(worker.recognize(bytes), /closed/u);
});

test('helper initialization and IPC failures clean up the process', async () => {
    for (const options of [{ failInit: true }, { sendError: true }]) {
        const f = fixture(options);
        await assert.rejects(f.create(), /Language load failed|IPC write failed/u);
        assert.equal(f.kills.length, 1);
    }
});

test('helper termination waits for actual exit rather than reporting idle too early', async () => {
    const f = fixture();
    f.child.kill = () => {};
    const worker = await f.create();
    let stopped = false;
    const closing = worker.terminate().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    f.child.emit('exit', 0, null);
    await closing;
    assert.equal(stopped, true);
});

test('a crashed or failed helper rejects its scan and the shared queue can recreate it', async () => {
    for (const failure of [{ exitOnRecognize: true }, { failScan: true }]) {
        const bad = fixture(failure), good = fixture();
        let creates = 0;
        const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: () => (++creates === 1 ? bad : good).create() });
        await assert.rejects(pool.run(() => pool.recognize(Buffer.from('a'))), /OCR helper exited|Bad image/u);
        const result = await pool.run(() => pool.recognize(Buffer.from('b')));
        assert.equal(result.data.text, 'Vegeta111');
        assert.equal(creates, 2);
        assert.equal(pool.snapshot().processId, 12345);
        await pool.close();
        assert.equal(pool.snapshot().workers, 0);
    }
});

test('disconnect and job timeout reject pending requests and end the helper', async () => {
    for (const disconnect of [true, false]) {
        const f = fixture();
        const worker = await createOcrProcessWorker({ cachePath: 'cache', timeoutMs: 30,
            forkProcess: () => f.child });
        f.child.send = (message, cb) => { cb(); if (disconnect) queueMicrotask(() => f.child.emit('disconnect')); };
        // The fake child has no OS handle to keep the event loop alive for this timer.
        const keepAlive = setTimeout(() => {}, 1000);
        try { await assert.rejects(worker.recognize(Buffer.from('a')), /disconnected|timed out/u); }
        finally { clearTimeout(keepAlive); await worker.terminate(); }
        assert.equal(f.kills.length, 1);
    }
});

const cachePath = path.join(__dirname, '..', 'data', 'tesseract-cache');
test('real offline OCR returns identical results through IPC and releases its child', {
    skip: !fs.existsSync(path.join(cachePath, 'eng.traineddata')), timeout: 90_000
}, async () => {
    const sharp = require('sharp');
    const { createWorker } = require('tesseract.js');
    const workerOptions = { langPath: cachePath, gzip: false, cacheMethod: 'readOnly' };
    const image = await sharp(Buffer.from('<svg width="700" height="160"><rect width="100%" height="100%" fill="white"/><text x="20" y="95" font-family="Arial" font-size="56" fill="black">Vegeta111</text></svg>')).png().toBuffer();
    const args = [image, { tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.- ' }, { text: true, blocks: true }];
    const direct = await createWorker('eng', 1, { cachePath, ...workerOptions, logger: () => {} });
    let expected;
    try { expected = (await direct.recognize(...args)).data; }
    finally {
        const exited = new Promise(resolve => direct.worker.once('exit', resolve));
        await direct.terminate(); await exited;
    }
    const child = await createOcrProcessWorker({ cachePath, workerOptions });
    try {
        const actual = (await child.recognize(...args)).data;
        assert.match(actual.text, /Vegeta111/u);
        for (const field of ['text', 'confidence', 'blocks']) assert.deepEqual(actual[field], expected[field], field);
    } finally { await child.terminate(); }
    assert.throws(() => process.kill(child.processId, 0), { code: 'ESRCH' });
});

test('full scout and guild image pipelines return identical results inside the helper', {
    skip: !fs.existsSync(path.join(cachePath, 'eng.traineddata')), timeout: 90_000
}, async () => {
    const os = require('node:os');
    const sharp = require('sharp');
    const { createWorker } = require('tesseract.js');
    const { PvpScoutOcr } = require('../features/pvp-scouting/PvpScoutOcr');
    const { GuildApplicationOcr } = require('../features/guild-applications/parsing/GuildApplicationOcr');
    const image = await sharp(Buffer.from('<svg width="800" height="300"><rect width="100%" height="100%" fill="white"/><text x="20" y="70" font-family="Arial" font-size="38" fill="black">Name: Vegeta111</text></svg>')).png().toBuffer();
    const workerOptions = { langPath: cachePath, gzip: false, cacheMethod: 'readOnly' };
    const pool = new OcrWorkerPool({ idleTimeoutMs: 0, workerFactory: async () => {
        const engine = await createWorker('eng', 1, { cachePath, ...workerOptions, logger() {} });
        return { recognize: (...args) => engine.recognize(...args), async terminate() {
            const exited = new Promise(resolve => engine.worker.once('exit', resolve));
            await engine.terminate(); await exited;
        } };
    } });
    const attachment = { id: '123', name: 'card.png', url: 'https://cdn.discordapp.com/attachments/card.png' };
    const post = { forumUsername: 'Vegeta111', profileSlug: 'vegeta111' }, parsed = { fields: {} };
    const images = [{ buffer: image, url: attachment.url }];
    let expectedScout, expectedGuild;
    try {
        const scout = new PvpScoutOcr({ workerPool: pool, fetch: async () => new Response(image, { headers: { 'content-type': 'image/png' } }) });
        expectedScout = await scout.analyzeAttachment(attachment, 'message', 'Vegeta111');
        expectedGuild = await new GuildApplicationOcr({ workerPool: pool }).resolveIgn(post, parsed, images);
    } finally { await pool.close(); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ocr-pipeline-test-'));
    const scriptPath = path.join(dir, 'helper.cjs');
    fs.writeFileSync(scriptPath, `globalThis.fetch = async () => new Response(Buffer.from(${JSON.stringify(image.toString('base64'))}, 'base64'), {headers: {'content-type': 'image/png'}});\nrequire(${JSON.stringify(require.resolve('../utils/ocrProcessEntry'))}).serveOcrProcess();\n`);
    let child;
    try {
        child = await createOcrProcessWorker({ cachePath, workerOptions, scriptPath });
        const actualScout = await child.analyzeScout(attachment, 'message', 'Vegeta111', {}, {});
        const actualGuild = await child.resolveGuild(post, parsed, images, {});
        assert.equal(actualScout.error, null);
        assert.deepEqual(actualScout, expectedScout);
        assert.deepEqual(actualGuild, expectedGuild);
    } finally {
        await child?.terminate();
        fs.unlinkSync(scriptPath);
        fs.rmdirSync(dir);
    }
});
