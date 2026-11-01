'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('node:diagnostics_channel');
const http = require('node:http');
const { once } = require('node:events');
const { createDiscordTransport } = require('../utils/discordTransport.js');

function fakePool() {
    return { stats: { connected: 1, running: 0, pending: 0 }, destroyed: false,
        async destroy() { this.destroyed = true; } };
}

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
