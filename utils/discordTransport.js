'use strict';

// Keeps interaction callbacks responsive and records Discord request timings.
const { AsyncLocalStorage } = require('node:async_hooks');
const diagnostics = require('node:diagnostics_channel');
const { performance } = require('node:perf_hooks');
const { DefaultRestOptions, DefaultUserAgent } = require('@discordjs/rest');
const { Pool } = require('undici');
const { networkErrorCode: safeErrorCode, isTransientDiscordError } = require('./networkErrors.js');
const CALLBACK_CONNECTIONS = 4;
const SLOW_REUSED_RESPONSE_MS = 1500;
const CONNECTION_REFRESH_INTERVAL_MS = 30_000;

// Initial callbacks have a three-second deadline. Give them a small, separate
// connection pool so uploads and ordinary REST traffic cannot occupy its sockets.
// Keep the installed discord.js request strategy, body handling and retry policy.
function createDiscordTransport({
    origin = 'https://discord.com',
    request = (...args) => DefaultRestOptions.makeRequest(...args),
    pool,
    poolFactory,
    onTiming = () => {},
    consoleObject = console,
    clock = () => performance.now(),
    warmupIntervalMs = 30_000,
    warmupTimeoutMs = 5_000,
    slowReusedResponseMs = SLOW_REUSED_RESPONSE_MS,
    refreshIntervalMs = CONNECTION_REFRESH_INTERVAL_MS
} = {}) {
    const createPool = poolFactory || (!pool ? () => new Pool(origin, {
        connections: CALLBACK_CONNECTIONS, pipelining: 1, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000
    }) : null);
    pool ||= createPool();
    const scope = new AsyncLocalStorage();
    const requests = new WeakMap();
    const usedSockets = new WeakSet();
    const subscriptions = [];
    const retiredPools = new Set();
    const closingPools = new WeakSet();
    const poolRequests = new Map();
    let stopped = false, warmupTimer, warmupPromise, warmupController;
    let warmupFailed = false;
    let pooledCallbacks = 0;
    let lastRefreshAt = -Infinity;

    const poolStats = (dispatcher = pool) => {
        const stats = dispatcher.stats;
        return { connected: Number(stats?.connected) || 0, running: Number(stats?.running) || 0,
            pending: Number(stats?.pending) || 0 };
    };
    const notify = (state, stage, extra = {}) => {
        if (stopped || !state?.interactionId) return;
        try {
            onTiming({ interactionId: state.interactionId, stage,
                elapsedMs: Math.max(0, clock() - state.startedAt),
                ...(state.dedicatedPool ? { pool: poolStats(state.dispatcher) } : {}), ...extra });
        } catch { /* Instrumentation must never interrupt an acknowledgement. */ }
    };
    const subscribe = (name, listener) => {
        const channel = diagnostics.channel(name);
        const safeListener = event => {
            try { listener(event); } catch { /* Diagnostic payloads may change between undici versions. */ }
        };
        channel.subscribe(safeListener);
        subscriptions.push([channel, safeListener]);
    };

    function closeRetiredPool(dispatcher) {
        if (stopped || !retiredPools.has(dispatcher) || poolRequests.has(dispatcher) || closingPools.has(dispatcher)) return;
        closingPools.add(dispatcher);
        // Wait for reservations that are still preparing request bodies before
        // closing. Undici can only drain requests already dispatched to it.
        try {
            Promise.resolve(dispatcher.close()).then(() => retiredPools.delete(dispatcher), () => {
                if (dispatcher.destroyed) retiredPools.delete(dispatcher);
            });
        } catch { /* Keep the retired pool tracked for forced shutdown cleanup. */ }
    }

    function retainPool(dispatcher) {
        poolRequests.set(dispatcher, (poolRequests.get(dispatcher) || 0) + 1);
    }

    function releasePool(dispatcher) {
        const remaining = poolRequests.get(dispatcher) - 1;
        if (remaining > 0) poolRequests.set(dispatcher, remaining);
        else poolRequests.delete(dispatcher);
        closeRetiredPool(dispatcher);
    }

    function refreshConnections(previous) {
        if (stopped || previous !== pool || !createPool || retiredPools.size >= 2
            || clock() - lastRefreshAt < refreshIntervalMs) return;
        let replacement;
        try { replacement = createPool(); }
        catch { return; }
        if (!replacement || replacement === previous) return;
        pool = replacement;
        lastRefreshAt = clock();
        retiredPools.add(previous);
        closeRetiredPool(previous);
        try { consoleObject.log('[CC LOG] Discord interaction connections refreshed after a slow response or connection failure; active callbacks are finishing normally.'); } catch {}
        if (!warmupPromise && !pooledCallbacks) void warmup();
    }

    subscribe('undici:request:create', ({ request: outgoing }) => {
        const state = scope.getStore();
        if (!state || stopped) return;
        requests.set(outgoing, { ...state, owner: state });
        notify(state, 'created');
    });
    subscribe('undici:client:sendHeaders', ({ request: outgoing, socket }) => {
        const state = requests.get(outgoing);
        if (!state) return;
        state.sentAt = clock();
        state.reusedConnection = usedSockets.has(socket);
        state.family = ['IPv4', 'IPv6'].includes(socket.remoteFamily) ? socket.remoteFamily : 'unknown';
        usedSockets.add(socket);
        notify(state, 'sent', { dispatchToSendMs: Math.max(0, state.sentAt - state.startedAt),
            reusedConnection: state.reusedConnection, family: state.family });
    });
    const complete = (outgoing, stage, extra) => {
        const state = requests.get(outgoing);
        if (!state) return;
        if (stage === 'headers' && state.dedicatedPool && state.reusedConnection
            && clock() - state.sentAt >= slowReusedResponseMs) state.owner.refreshNeeded = true;
        notify(state, stage, { ...(state.sentAt !== undefined ? {
            dispatchToSendMs: Math.max(0, state.sentAt - state.startedAt),
            sendToHeadersMs: Math.max(0, clock() - state.sentAt),
            reusedConnection: state.reusedConnection, family: state.family
        } : {}), ...extra });
    };
    subscribe('undici:request:headers', ({ request: outgoing, response }) =>
        complete(outgoing, 'headers', { status: response.statusCode }));
    subscribe('undici:request:error', ({ request: outgoing, error }) =>
        complete(outgoing, 'error', { errorCode: safeErrorCode(error) }));

    function makeRequest(url, init) {
        const parsed = new URL(url);
        const interactionId = parsed.origin === origin && String(init.method).toUpperCase() === 'POST'
            ? /^\/api\/v\d+\/interactions\/(\d+)\/[^/?]+\/callback$/u.exec(parsed.pathname)?.[1] : null;
        if (!interactionId) return request(url, init);
        if (stopped) return Promise.reject(Object.assign(new Error('Discord interaction transport stopped'),
            { code: 'DISCORD_TRANSPORT_STOPPED' }));
        // Reserve a slot before the async request strategy resolves its body.
        // Overflow uses the existing strategy instead of adding a callback queue.
        // Preserve explicitly supplied dispatchers (for example a configured proxy).
        const stats = poolStats();
        const occupied = Math.max(pooledCallbacks + (warmupPromise ? 1 : 0), stats.running + stats.pending);
        const usePool = !init.dispatcher && occupied < CALLBACK_CONNECTIONS;
        const requestPool = pool;
        const options = usePool ? { ...init, dispatcher: requestPool } : init;
        const state = { interactionId, startedAt: clock(), dedicatedPool: usePool, dispatcher: requestPool };
        if (usePool) { pooledCallbacks++; retainPool(requestPool); }
        const finished = () => {
            if (usePool) { pooledCallbacks--; releasePool(requestPool); }
            if (usePool && state.refreshNeeded) refreshConnections(requestPool);
        };
        return scope.run(state, () => {
            try {
                return Promise.resolve(request(url, options)).catch(error => {
                    if (isTransientDiscordError(error)) state.refreshNeeded = true;
                    throw error;
                }).finally(finished);
            } catch (error) {
                if (isTransientDiscordError(error)) state.refreshNeeded = true;
                finished();
                throw error;
            }
        });
    }

    async function warmup() {
        if (stopped || pooledCallbacks || poolStats().running || poolStats().pending) return false;
        if (warmupPromise) return warmupPromise;
        const warmupPool = pool;
        retainPool(warmupPool);
        warmupController = new AbortController();
        const timeout = setTimeout(() => warmupController?.abort(Object.assign(new Error('Discord warmup deadline exceeded.'),
            { code: 'ETIMEDOUT' })), warmupTimeoutMs);
        timeout.unref?.();
        warmupPromise = Promise.resolve().then(async () => {
            try {
                // GET /gateway is public and performs no Discord or database writes.
                // Consume its small body so the socket is eligible for reuse.
                const response = await scope.run({ startedAt: clock() }, () => request(`${origin}/api/v10/gateway`, {
                    method: 'GET', dispatcher: warmupPool, signal: warmupController.signal,
                    headers: { 'User-Agent': DefaultUserAgent }
                }));
                await response.arrayBuffer();
                // Undici schedules the pool's drain notification separately from
                // body consumption. Let that run before reporting the socket ready.
                await new Promise(resolve => setImmediate(resolve));
                if (!response.ok) throw Object.assign(new Error('Gateway warmup rejected'), { code: `HTTP_${response.status}` });
                if (warmupFailed && !stopped) {
                    try { consoleObject.log('[CC LOG] Discord interaction connection warmup recovered.'); } catch {}
                }
                warmupFailed = false;
                return true;
            } catch (error) {
                if (!warmupFailed && !stopped) {
                    try { consoleObject.warn(`[CC LOG] Discord interaction connection warmup failed (${safeErrorCode(error)}). Initial responses may need a new connection.`); } catch {}
                }
                warmupFailed = true;
                return false;
            } finally {
                clearTimeout(timeout);
                warmupController = undefined;
                warmupPromise = undefined;
                releasePool(warmupPool);
            }
        });
        return warmupPromise;
    }

    function startWarmup() {
        if (stopped) return Promise.resolve(false);
        if (!warmupTimer && warmupIntervalMs > 0) {
            warmupTimer = setInterval(() => { void warmup(); }, warmupIntervalMs);
            warmupTimer.unref?.();
        }
        return warmup();
    }

    async function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(warmupTimer);
        warmupController?.abort();
        for (const [channel, listener] of subscriptions) channel.unsubscribe(listener);
        const results = await Promise.allSettled([pool, ...retiredPools].map(dispatcher =>
            Promise.resolve().then(() => dispatcher.destroy())));
        retiredPools.clear();
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
    }

    return { makeRequest, startWarmup, stop };
}

module.exports = { createDiscordTransport };
