// Measure initial acknowledgements without logging REST URLs, tokens or payloads.
'use strict';

const { performance } = require('node:perf_hooks');

const states = new WeakMap();
const INITIAL_RESPONSES = ['reply', 'deferReply', 'update', 'deferUpdate', 'showModal', 'respond'];

function setInteractionContext(interaction, context) {
    const state = states.get(interaction);
    if (state) Object.assign(state.context, context);
}

function interactionErrorCode(error) {
    return error?.code || error?.rawError?.code || error?.name || 'UNKNOWN';
}

class InteractionDiagnostics {
    constructor({ rest, consoleObject = console, now = () => Date.now(), clock = () => performance.now(),
        eventLoopUtilization = (...args) => performance.eventLoopUtilization(...args), slowAgeMs = 2000 } = {}) {
        this.rest = rest;
        this.console = consoleObject;
        this.now = now;
        this.clock = clock;
        this.eventLoopUtilization = eventLoopUtilization;
        this.slowAgeMs = slowAgeMs;
        this.active = new Map();
        this.onResponse = (request, response) => {
            // Extract only the ID. Never retain or print the token-bearing path.
            const id = /^\/interactions\/(\d+)\/[^/]+\/callback(?:\?|$)/u.exec(request.path || '')?.[1];
            const acknowledgement = this.active.get(id);
            if (!acknowledgement) return;
            acknowledgement.responses++;
            acknowledgement.retries = Math.max(acknowledgement.retries, Number(request.retries) || 0);
            acknowledgement.httpStatus = response.status;
            if (response.status === 429) {
                acknowledgement.rateLimits++;
                acknowledgement.retryAfterMs += Math.max(0, Number(response.headers?.get('retry-after')) || 0) * 1000;
            }
        };
    }

    track(interaction) {
        if (states.has(interaction)) return;
        const receivedAt = this.now();
        const state = { receivedAt, receivedTick: this.clock(),
            receivedAge: Math.max(0, receivedAt - (interaction.createdTimestamp || receivedAt)), context: {} };
        states.set(interaction, state);
        for (const method of INITIAL_RESPONSES) {
            const original = interaction[method];
            if (typeof original !== 'function') continue;
            interaction[method] = async (...args) => {
                // Later replies are not initial acknowledgements.
                if (interaction.deferred || interaction.replied || state.acknowledged) {
                    return original.apply(interaction, args);
                }
                const start = this.clock();
                const acknowledgement = { method, startedTick: start, localDelayMs: Math.max(0, start - state.receivedTick),
                    startAge: state.receivedAge + Math.max(0, start - state.receivedTick),
                    responses: 0, retries: 0, rateLimits: 0, retryAfterMs: 0 };
                state.acknowledgement = acknowledgement;
                const loopStart = this.eventLoopUtilization();
                if (!this.active.size) this.rest?.on('response', this.onResponse);
                this.active.set(interaction.id, acknowledgement);
                try {
                    const result = await original.apply(interaction, args);
                    state.acknowledged = true;
                    return result;
                } catch (error) {
                    acknowledgement.errorCode = interactionErrorCode(error);
                    acknowledgement.httpStatus ??= error?.status;
                    throw error;
                } finally {
                    acknowledgement.durationMs = Math.max(0, this.clock() - start);
                    acknowledgement.endAge = acknowledgement.startAge + acknowledgement.durationMs;
                    acknowledgement.eventLoopActiveMs = Math.max(0, this.eventLoopUtilization(loopStart).active);
                    this.active.delete(interaction.id);
                    if (!this.active.size) this.rest?.off('response', this.onResponse);
                    if (state.acknowledged && acknowledgement.endAge >= this.slowAgeMs) {
                        // A successful but slow response needs investigation before it starts expiring.
                        try { this.console.warn(this.describe(interaction, 'acknowledgement was slow')); }
                        catch { /* Diagnostics must not turn a successful acknowledgement into a failure. */ }
                    }
                }
            };
        }
    }

    recordTransportTiming(event) {
        const ack = this.active.get(event.interactionId);
        if (!ack) return;
        if (event.stage === 'created') {
            ack.transport = {
                dispatchDelayMs: ack.transport?.dispatchDelayMs ?? Math.max(0, this.clock() - ack.startedTick),
                attempts: (ack.transport?.attempts || 0) + 1,
                createdElapsedMs: Math.max(0, Number(event.elapsedMs) || 0)
            };
        }
        const transport = ack.transport;
        if (!transport) return;
        if (event.stage === 'sent') {
            transport.sentElapsedMs = Math.max(0, Number(event.elapsedMs) || 0);
            transport.socketWaitMs = Math.max(0, transport.sentElapsedMs - transport.createdElapsedMs);
            transport.reusedConnection = event.reusedConnection;
            transport.family = ['IPv4', 'IPv6'].includes(event.family) ? event.family : undefined;
        } else if (event.stage === 'headers' && transport.socketWaitMs !== undefined) {
            transport.headersWaitMs = Math.max(0, (Number(event.elapsedMs) || 0) - transport.sentElapsedMs);
        }
        if (event.pool) transport.pending = Math.max(0, Number(event.pool.pending) || 0);
    }

    describe(interaction, reason) {
        const state = states.get(interaction);
        const ack = state?.acknowledgement;
        const context = state?.context || {};
        const transport = ack?.transport;
        const ms = value => Math.round(value || 0);
        const fields = [
            `id ${interaction.id}`, `channel ${interaction.channelId || 'unknown'}`, `caller ${interaction.user?.id || 'unknown'}`,
            ...(context.server ? [`server ${context.server}`] : []), ...(context.targetId ? [`target ${context.targetId}`] : []),
            `${ms(state?.receivedAge)} ms old on arrival`,
            ...(ack ? [`${ms(ack.localDelayMs)} ms before ${ack.method}`, `${ms(ack.durationMs)} ms awaiting acknowledgement`,
                `${ms(ack.endAge)} ms old after acknowledgement`, `${ms(ack.eventLoopActiveMs)} ms event loop active while awaiting`,
                `HTTP ${ack.httpStatus || 'unknown'}`, `${ack.responses} HTTP response(s)`, `${ack.retries} transport/server retry(s)`,
                `${ack.rateLimits} rate limit(s)`, `${ms(ack.retryAfterMs)} ms requested rate-limit wait`] : []),
            ...(transport ? [`${ms(transport.dispatchDelayMs)} ms preparing initial HTTP request`,
                ...(transport.attempts > 1 ? [`socket/response timings from HTTP attempt ${transport.attempts}`] : []),
                ...(transport.socketWaitMs !== undefined ? [`${ms(transport.socketWaitMs)} ms waiting for HTTP socket`] : ['HTTP request not sent']),
                ...(transport.headersWaitMs !== undefined ? [`${ms(transport.headersWaitMs)} ms awaiting HTTP headers`] : []),
                ...(transport.reusedConnection !== undefined ? [`${transport.reusedConnection ? 'reused' : 'new'} ${transport.family || 'HTTP'} connection`] : []),
                ...(transport.pending !== undefined ? [`${transport.pending} queued callback request(s)`] : [])] : []),
            ...(ack?.errorCode ? [`code ${ack.errorCode}`] : []),
            ...(context.phase ? [`phase ${context.phase}`] : [])
        ];
        let outcome = '';
        if (reason !== 'acknowledgement was slow') {
            if (context.crownSaved === false) outcome = ' No crown or defense was recorded by this request.'
                + (reason === 'expired before acknowledgement' ? ' Retry the command if the battle result still needs recording.' : ' Check /pvp_history before retrying.');
            else if (context.crownSaved === true) outcome = ' The crown or defense is saved. Do not repeat /pvp_crown for this battle.';
            else if (context.phase === 'saving crown') outcome = ' Crown save status is uncertain. Check /pvp_history before retrying.';
        }
        return `[CC LOG] Discord interaction ${reason}: ${interaction.customId || interaction.commandName || 'unknown'} (${fields.join(', ')}).${outcome}`;
    }

    errorReason(interaction, code) {
        if (code === 40060) return 'was already acknowledged';
        return states.get(interaction)?.acknowledged ? 'was rejected after acknowledgement' : 'expired before acknowledgement';
    }

    canAcknowledge(interaction) {
        const state = states.get(interaction);
        if (state?.acknowledged || interaction.deferred || interaction.replied) return false;
        return !state || state.receivedAge + Math.max(0, this.clock() - state.receivedTick) < 3000;
    }

    stop() {
        this.rest?.off('response', this.onResponse);
        this.active.clear();
    }
}

module.exports = { InteractionDiagnostics, setInteractionContext, interactionErrorCode };
