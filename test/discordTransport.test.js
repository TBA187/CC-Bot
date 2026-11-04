'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('node:diagnostics_channel');
const http = require('node:http');
const { once } = require('node:events');
const { createDiscordTransport } = require('../utils/discordTransport.js');

function fakePool() {
    return { stats: { connected: 1, running: 0, pending: 0 }, destroyed: false, closed: false,
        async close() { this.closed = true; },
        async destroy() { this.destroyed = true; } };
}

function publishResponse(socket, beforeHeaders = () => {}) {
    const outgoing = {};
    diagnostics.channel('undici:request:create').publish({ request: outgoing });
    diagnostics.channel('undici:client:sendHeaders').publish({ request: outgoing, socket });
    beforeHeaders();
    diagnostics.channel('undici:request:headers').publish({ request: outgoing, response: { statusCode: 204 } });
}

const callback = 'https://discord.com/api/v10/interactions/123/fake-private-token/callback';

test('only Discord initial POST callbacks use the dedicated pool; ordinary traffic and explicit proxies keep their strategy', async () => {
    const calls = [], pool = fakePool();
    const transport = createDiscordTransport({ pool, request: async (url, init) => { calls.push({ url, init }); return 'response'; } });
    try {
        const callback = 'https://discord.com/api/v10/interactions/123/fake-private-token/callback?with_response=false';
        const body = { method: 'POST', body: '{"type":5}', signal: new AbortController().signal,
            headers: { Authorization: 'fake-authorization' } };
        assert.equal(await transport.makeRequest(callback, body), 'response');
        assert.equal(calls[0].init.dispatcher, pool);
        assert.equal(calls[0].init.body, body.body);
        assert.equal(calls[0].init.signal, body.signal);
        assert.equal(calls[0].init.headers, body.headers);
        assert.equal(body.dispatcher, undefined);
        const proxy = {};
        const proxied = { ...body, dispatcher: proxy };
        await transport.makeRequest(callback, proxied);
        assert.equal(calls[1].init, proxied);
        for (const url of ['https://discord.com/api/v10/channels/123/messages',
            'https://discord.com/api/v10/webhooks/123/fake-private-token/messages/@original',
            'https://other.example/api/v10/interactions/123/fake-private-token/callback']) {
            await transport.makeRequest(url, body);
            assert.equal(calls.at(-1).init, body);
        }
        const get = { method: 'GET' };
        await transport.makeRequest(callback, get);
        assert.equal(calls.at(-1).init, get);
    } finally { await transport.stop(); }
});

test('stage samples distinguish waiting to send from awaiting headers without exporting sensitive diagnostics', async () => {
    const timings = [], socket = { remoteFamily: 'IPv4' };
    let elapsed = 0;
    const transport = createDiscordTransport({ pool: fakePool(), clock: () => elapsed, onTiming: value => timings.push(value),
        request: async () => {
            const outgoing = { path: '/api/v10/interactions/123/fake-private-token/callback', headers: 'fake-authorization' };
            diagnostics.channel('undici:request:create').publish({ request: outgoing });
            elapsed += 120;
            diagnostics.channel('undici:client:sendHeaders').publish({ request: outgoing, socket, headers: 'fake-authorization' });
            elapsed += 3400;
            diagnostics.channel('undici:request:headers').publish({ request: outgoing, response: { statusCode: 404 } });
            return 'result';
        } });
    try {
        await transport.makeRequest('https://discord.com/api/v10/interactions/123/fake-private-token/callback', { method: 'POST' });
        assert.deepEqual(timings.map(value => value.stage), ['created', 'sent', 'headers']);
        assert.equal(timings[2].dispatchToSendMs, 120);
        assert.equal(timings[2].sendToHeadersMs, 3400);
        assert.equal(timings[2].elapsedMs, 3520);
        assert.equal(timings[2].reusedConnection, false);
        assert.equal(timings[2].family, 'IPv4');
        assert.equal(timings[2].status, 404);
        assert.doesNotMatch(JSON.stringify(timings), /private|authorization|callback|https/u);
        await transport.makeRequest('https://discord.com/api/v10/interactions/123/fake-private-token/callback', { method: 'POST' });
        assert.equal(timings.at(-1).reusedConnection, true);
    } finally { await transport.stop(); }
});

test('simultaneous callbacks reserve slots before async dispatch and overflow keeps the default strategy', async () => {
    const calls = [], completions = [], pool = fakePool();
    const transport = createDiscordTransport({ pool, request: (url, init) => {
        calls.push(init);
        return new Promise(resolve => completions.push(resolve));
    } });
    const body = { method: 'POST', body: '{"type":5}' };
    const callback = 'https://discord.com/api/v10/interactions/123/token/callback';
    try {
        const pending = Array.from({ length: 7 }, () => transport.makeRequest(callback, body));
        assert.equal(pool.stats.running, 0, 'the mock mirrors async body resolution before pool dispatch');
        assert.ok(calls.slice(0, 4).every(init => init.dispatcher === pool));
        assert.ok(calls.slice(4).every(init => init === body));
        assert.equal(await transport.startWarmup(), false, 'warmup must respect reserved callback slots');
        completions[0]('first accepted');
        await pending[0];
        const next = transport.makeRequest(callback, body);
        assert.equal(calls.at(-1).dispatcher, pool, 'settled callbacks release their reservations');
        for (const complete of completions) complete('accepted');
        await Promise.all([...pending, next]);
    } finally { await transport.stop(); }
});

test('warmup reserves a pool socket while its asynchronous request is starting', async () => {
    const calls = [], completions = [], pool = fakePool();
    const transport = createDiscordTransport({ pool, warmupIntervalMs: 0, request: (url, init) => {
        calls.push(init);
        return new Promise(resolve => completions.push(resolve));
    } });
    try {
        const warm = transport.startWarmup();
        const body = { method: 'POST' };
        const callback = 'https://discord.com/api/v10/interactions/123/token/callback';
        const pending = Array.from({ length: 4 }, () => transport.makeRequest(callback, body));
        assert.ok(calls.slice(0, 3).every(init => init.dispatcher === pool));
        assert.equal(calls[3], body, 'one warmup and three callbacks fill the four sockets');
        await Promise.resolve();
        assert.equal(calls[4].method, 'GET');
        for (const complete of completions) complete({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
        await Promise.all([...pending, warm]);
    } finally { await transport.stop(); }
});

test('throwing timing sinks cannot fail callbacks and shutdown removes diagnostic subscriptions', async () => {
    let notifications = 0;
    const channel = diagnostics.channel('undici:request:create');
    const transport = createDiscordTransport({ pool: fakePool(), onTiming: () => { notifications++; throw new Error('sink failure'); },
        request: async () => {
            channel.publish({ request: {} });
            return 'accepted';
        } });
    assert.equal(await transport.makeRequest('https://discord.com/api/v10/interactions/123/token/callback', { method: 'POST' }), 'accepted');
    assert.equal(notifications, 1);
    await transport.stop();
    channel.publish({ request: {} });
    assert.equal(notifications, 1);
    await assert.rejects(transport.makeRequest('https://discord.com/api/v10/interactions/123/token/callback', { method: 'POST' }),
        error => error.code === 'DISCORD_TRANSPORT_STOPPED');
});

test('warmup is public, consumes the response, skips busy pools and reports outage transitions without credentials', async () => {
    const pool = fakePool(), warnings = [], logs = [], calls = [];
    let fail = true;
    const transport = createDiscordTransport({ pool, warmupIntervalMs: 0,
        consoleObject: { warn: value => warnings.push(value), log: value => logs.push(value) },
        request: async (url, init) => {
            calls.push({ url, init });
            if (fail) throw Object.assign(new Error('https://example.invalid/private-token'), { code: 'ENETUNREACH' });
            return { ok: true, arrayBuffer: async () => { calls.at(-1).consumed = true; } };
        } });
    try {
        assert.equal(await transport.startWarmup(), false);
        assert.equal(await transport.startWarmup(), false);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /ENETUNREACH/u);
        assert.doesNotMatch(warnings[0], /https|private/u);
        fail = false;
        assert.equal(await transport.startWarmup(), true);
        assert.equal(logs.length, 1);
        assert.equal(calls.at(-1).consumed, true);
        assert.equal(calls.at(-1).url, 'https://discord.com/api/v10/gateway');
        assert.equal(calls.at(-1).init.dispatcher, pool);
        assert.equal(calls.at(-1).init.headers.Authorization, undefined);
        pool.stats.running = 1;
        const before = calls.length;
        assert.equal(await transport.startWarmup(), false);
        assert.equal(calls.length, before);
    } finally { await transport.stop(); }
    assert.equal(pool.destroyed, true);
    assert.equal(await transport.startWarmup(), false);
});

test('warmup deadlines report ETIMEDOUT instead of the numeric AbortError code', async () => {
    const warnings = [];
    const keepAlive = setInterval(() => {}, 1000);
    const transport = createDiscordTransport({ pool: fakePool(), warmupIntervalMs: 0, warmupTimeoutMs: 5,
        consoleObject: { warn: text => warnings.push(text), log() {} },
        request: (_, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }) });
    try {
        assert.equal(await transport.startWarmup(), false);
        assert.match(warnings[0], /failed \(ETIMEDOUT\)/u);
    } finally { clearInterval(keepAlive); await transport.stop(); }
});

test('a slow reused connection is replaced without replaying callbacks or closing requests still preparing their body', async () => {
    const pools = [fakePool(), fakePool()], calls = [], logs = [];
    const sockets = pools.map(() => ({ remoteFamily: 'IPv4' }));
    let elapsed = 0, created = 0, finishReserved;
    const transport = createDiscordTransport({ poolFactory: () => pools[created++], clock: () => elapsed,
        consoleObject: { log: text => logs.push(text) }, request: (url, init) => {
            calls.push({ url, init });
            if (init.body === 'reserved') return new Promise(resolve => { finishReserved = () => {
                assert.equal(init.dispatcher.closed, false);
                publishResponse(sockets[0]);
                resolve('reserved accepted');
            }; });
            publishResponse(sockets[pools.indexOf(init.dispatcher)], () => { elapsed += init.body === 'slow' ? 1600 : 10; });
            return 'accepted';
        } });
    try {
        await transport.makeRequest(callback, { method: 'POST' });
        const reserved = transport.makeRequest(callback, { method: 'POST', body: 'reserved' });
        assert.equal(await transport.makeRequest(callback, { method: 'POST', body: 'slow' }), 'accepted');
        assert.equal(created, 2);
        assert.equal(pools[0].closed, false, 'a reserved request has not dispatched yet');
        await transport.makeRequest(callback, { method: 'POST' });
        assert.equal(calls.at(-1).init.dispatcher, pools[1]);
        assert.equal(pools[0].destroyed, false);
        finishReserved();
        assert.equal(await reserved, 'reserved accepted');
        assert.equal(pools[0].closed, true);
        assert.equal(calls.length, 4, 'each callback is sent exactly once');
        assert.equal(logs.length, 1);
        assert.doesNotMatch(logs.join(''), /fake-private-token|https|123/u);
    } finally { await transport.stop(); }
});

test('connection failures propagate unchanged while refresh cooldown and retired-pool bounds prevent churn', async () => {
    const pools = [], calls = [], failure = new Error('private request', { cause: { code: 'ECONNRESET' } });
    let elapsed = 0;
    const transport = createDiscordTransport({ clock: () => elapsed, consoleObject: { log() {} }, poolFactory: () => {
        const pool = fakePool();
        pool.close = () => new Promise(() => {});
        pools.push(pool);
        return pool;
    }, request: async (_, init) => {
        calls.push(init);
        if (init.method === 'POST') throw failure;
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    } });
    try {
        await assert.rejects(transport.makeRequest(callback, { method: 'POST' }), error => error === failure);
        assert.equal(pools.length, 2);
        await assert.rejects(transport.makeRequest(callback, { method: 'POST' }), error => error === failure);
        assert.equal(pools.length, 2, 'the cooldown prevents repeated refreshes during one network incident');
        elapsed += 30_000;
        await assert.rejects(transport.makeRequest(callback, { method: 'POST' }), error => error === failure);
        assert.equal(pools.length, 3);
        elapsed += 30_000;
        await assert.rejects(transport.makeRequest(callback, { method: 'POST' }), error => error === failure);
        assert.equal(pools.length, 3, 'at most two retired pools may wait for cleanup');
        assert.equal(calls.filter(init => init.method === 'POST').length, 4, 'recovery does not retry acknowledgements');
    } finally { await transport.stop(); }
    assert.ok(pools.every(pool => pool.destroyed), 'shutdown includes retired pools whose close is still pending');
});

test('slow new connections, fast reused connections, explicit proxies and ordinary REST errors do not refresh the pool', async () => {
    const pool = fakePool(), socket = { remoteFamily: 'IPv4' };
    let elapsed = 0, created = 0;
    const transport = createDiscordTransport({ poolFactory: () => { created++; return pool; }, clock: () => elapsed,
        request: async (_, init) => {
            if (init.body === 'failure') throw Object.assign(new Error('failure'), { code: 'ECONNRESET' });
            publishResponse(socket, () => { elapsed += init.body === 'slow' ? 2000 : 100; });
            return 'accepted';
        } });
    try {
        await transport.makeRequest(callback, { method: 'POST', body: 'slow' });
        await transport.makeRequest(callback, { method: 'POST' });
        await transport.makeRequest(callback, { method: 'POST', body: 'slow', dispatcher: {} });
        await assert.rejects(transport.makeRequest(callback, { method: 'POST', body: 'failure', dispatcher: {} }));
        await assert.rejects(transport.makeRequest('https://discord.com/api/v10/channels/123/messages',
            { method: 'POST', body: 'failure' }));
        assert.equal(created, 1);
    } finally { await transport.stop(); }
});

test('a warmup already starting on a retired pool finishes before that pool is closed', async () => {
    const pools = [fakePool(), fakePool()], socket = { remoteFamily: 'IPv4' };
    let created = 0, elapsed = 0, finishWarmup;
    const transport = createDiscordTransport({ poolFactory: () => pools[created++], clock: () => elapsed, warmupIntervalMs: 0,
        consoleObject: { log() {} }, request: (url, init) => {
            if (init.method === 'GET') return new Promise(resolve => { finishWarmup = () => {
                assert.equal(init.dispatcher, pools[0]);
                assert.equal(init.dispatcher.closed, false);
                resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
            }; });
            publishResponse(socket, () => { elapsed += init.body === 'slow' ? 2000 : 1; });
            return 'accepted';
        } });
    try {
        await transport.makeRequest(callback, { method: 'POST' });
        const warming = transport.startWarmup();
        await transport.makeRequest(callback, { method: 'POST', body: 'slow' });
        assert.equal(created, 2);
        assert.equal(pools[0].closed, false);
        finishWarmup();
        assert.equal(await warming, true);
        assert.equal(pools[0].closed, true);
    } finally { await transport.stop(); }
});

test('refresh factory, cleanup and logging failures cannot change an accepted callback result', async () => {
    const pools = [fakePool(), fakePool()], socket = { remoteFamily: 'IPv4' };
    let elapsed = 0, attempts = 0;
    pools[0].close = () => { throw new Error('close failure'); };
    const transport = createDiscordTransport({ poolFactory: () => {
        if (++attempts === 2) throw new Error('factory failure');
        return attempts === 1 ? pools[0] : pools[1];
    }, clock: () => elapsed, consoleObject: { log() { throw new Error('log failure'); } }, request: async (_, init) => {
        if (init.method === 'GET') return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
        publishResponse(socket, () => { elapsed += 2000; });
        return 'accepted';
    } });
    try {
        for (let i = 0; i < 3; i++) assert.equal(await transport.makeRequest(callback, { method: 'POST' }), 'accepted');
        assert.equal(attempts, 3);
    } finally { await transport.stop(); }
    assert.ok(pools.every(pool => pool.destroyed));
});

test('shutdown prevents an outstanding callback failure from creating a replacement or restarting warmup', async () => {
    const pools = [], calls = [];
    let rejectCallback;
    const transport = createDiscordTransport({ poolFactory: () => { const pool = fakePool(); pools.push(pool); return pool; },
        request: (_, init) => { calls.push(init); return new Promise((resolve, reject) => { rejectCallback = reject; }); } });
    const pending = transport.makeRequest(callback, { method: 'POST' });
    const rejected = assert.rejects(pending, error => error.code === 'ECONNRESET');
    await transport.stop();
    rejectCallback(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }));
    await rejected;
    assert.equal(pools.length, 1);
    assert.equal(calls.length, 1);
});

test('shutdown still reports destruction failures after cleaning up every pool', async () => {
    const pools = [], failure = new Error('destroy failed');
    const transport = createDiscordTransport({ consoleObject: { log() {} }, poolFactory: () => {
        const pool = fakePool();
        pool.close = async () => { throw new Error('close failed'); };
        if (!pools.length) pool.destroy = () => { throw failure; };
        pools.push(pool);
        return pool;
    }, request: async (_, init) => {
        if (init.method === 'POST') throw Object.assign(new Error('network failure'), { code: 'ECONNRESET' });
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    } });
    await assert.rejects(transport.makeRequest(callback, { method: 'POST' }));
    await assert.rejects(transport.stop(), error => error === failure);
    assert.equal(pools[1].destroyed, true);
});

test('installed REST strategy reuses the warmed socket for an actual local callback and emits its timing stages', async () => {
    const timings = [], seen = [];
    const server = http.createServer((req, res) => {
        seen.push({ path: req.url, socket: req.socket });
        req.resume();
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"url":"wss://fake-gateway.invalid"}');
        } else { res.writeHead(204); res.end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = createDiscordTransport({ origin, warmupIntervalMs: 0, onTiming: value => timings.push(value) });
    try {
        assert.equal(await transport.startWarmup(), true);
        const response = await transport.makeRequest(`${origin}/api/v10/interactions/123/fake-token/callback`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":5}' });
        await response.arrayBuffer();
        assert.equal(response.status, 204);
        assert.equal(seen.length, 2);
        assert.ok(seen[0].socket === seen[1].socket, 'callback should use the warmed connection');
        assert.deepEqual(timings.map(value => value.stage), ['created', 'sent', 'headers']);
        assert.equal(timings.at(-1).reusedConnection, true);
        assert.equal(timings.at(-1).family, 'IPv4');
        assert.ok(timings.at(-1).dispatchToSendMs >= 0);
        assert.ok(timings.at(-1).sendToHeadersMs >= 0);
        assert.doesNotMatch(JSON.stringify(timings), /fake-token|Content-Type/u);
    } finally {
        await transport.stop();
        await new Promise(resolve => server.close(resolve));
    }
});

test('installed REST strategy replaces a slow reused socket for the next callback without interrupting either response', async () => {
    let elapsed = 0;
    const seen = [], logs = [];
    const server = http.createServer((req, res) => {
        req.resume();
        if (req.method === 'GET') { res.writeHead(200); res.end('{}'); return; }
        seen.push(req.socket);
        if (seen.length === 1) elapsed += 2000;
        res.writeHead(204);
        res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = createDiscordTransport({ origin, warmupIntervalMs: 0, clock: () => elapsed,
        consoleObject: { log: text => logs.push(text), warn() {} } });
    try {
        await transport.startWarmup();
        for (let i = 0; i < 2; i++) {
            const response = await transport.makeRequest(`${origin}/api/v10/interactions/123/fake-token/callback`, { method: 'POST' });
            assert.equal(response.status, 204);
            await response.arrayBuffer();
        }
        assert.equal(logs.length, 1);
        assert.equal(seen.length, 2);
        assert.notEqual(seen[0], seen[1]);
    } finally {
        await transport.stop();
        await new Promise(resolve => server.close(resolve));
    }
});
