// Track outage alerts and recovery messages without repeating the same incident.
'use strict';

const { createHash } = require('node:crypto');

// Delivery state is separate from console logging and service retry schedules.
class DiagnosticIncidents {
    constructor({ send, now = Date.now, schedule = setTimeout, cancel = clearTimeout,
        retryMs = 30_000, maxRetryMs = 5 * 60_000, maxIncidents = 100 } = {}) {
        Object.assign(this, { send, now, schedule, cancel, retryMs, maxRetryMs, maxIncidents });
        this.active = new Map();
        this.pending = new Set();
        this.timer = null;
        this.ready = false;
        this.stopped = false;
        this.sequence = 0;
        this.flushing = false;
    }

    fail({ key, source = key, delayMs = 0, ...event }) {
        if (this.stopped) return;
        let incident = this.active.get(key);
        const now = this.now();
        if (!incident) {
            if (this.pending.size >= this.maxIncidents) return;
            incident = { key, sources: new Set(), startedAt: Math.min(event.startedAt ?? now, now),
                delayMs, event, resolvedAt: null, messageId: null, sending: false,
                retryAt: 0, retryDelay: this.retryMs, detectedAt: now, sequence: ++this.sequence };
            this.active.set(key, incident);
            this.pending.add(incident);
        }
        incident.sources.add(source);
        if (Number.isFinite(event.startedAt)) incident.startedAt = Math.min(incident.startedAt, event.startedAt);
        incident.event = event;
        void this.flush();
    }

    recover({ key, source = key, message }) {
        if (this.stopped) return;
        const incident = this.active.get(key);
        if (!incident) return;
        incident.sources.delete(source);
        if (incident.sources.size) return;
        incident.resolvedAt = this.now();
        incident.recoveryMessage = message;
        this.active.delete(key);
        // A brief interruption never creates a Discord incident, even if Discord
        // itself was unavailable throughout that interruption.
        if (!incident.sending && !incident.messageId && incident.resolvedAt - incident.startedAt < incident.delayMs) {
            this.pending.delete(incident);
        }
        void this.flush();
    }

    nonce(incident, recovery) {
        return 'di:' + createHash('sha256').update(`${incident.key}:${incident.detectedAt}:${incident.sequence}:${recovery}`)
            .digest('hex').slice(0, 22);
    }

    async deliver(incident) {
        // An outage that ended before its alert could be sent, for example while Discord was unreachable,
        // is reported once as a recovery with its duration, without a separate warning or ping.
        const recovery = Boolean(incident.messageId) || incident.resolvedAt !== null;
        const event = { ...incident.event, status: recovery ? 'recovered' : 'unavailable', statusKey: incident.key,
            timestamp: new Date(recovery ? incident.resolvedAt : incident.startedAt).toISOString(),
            nonce: this.nonce(incident, recovery), repeats: 0 };
        delete event.startedAt;
        if (recovery) Object.assign(event, { level: 'log', message: incident.recoveryMessage,
            replyTo: incident.messageId, durationMs: Math.max(0, incident.resolvedAt - incident.startedAt) });
        incident.sending = true;
        try {
            const message = await this.send(event);
            if (this.stopped || !this.pending.has(incident)) return;
            if (!message?.id) throw new Error('Diagnostic message delivery was not confirmed.');
            incident.retryAt = 0;
            incident.retryDelay = this.retryMs;
            if (recovery) this.pending.delete(incident);
            else incident.messageId = String(message.id);
        } catch {
            if (!this.stopped && this.pending.has(incident)) {
                incident.retryAt = this.now() + incident.retryDelay;
                incident.retryDelay = Math.min(this.maxRetryMs, incident.retryDelay * 2);
            }
        } finally {
            incident.sending = false;
            if (!this.stopped) void this.flush();
        }
    }

    flush() {
        // A synchronous send failure or a logging hook can update another
        // incident during delivery. Rescan without leaving an orphaned timer.
        if (this.flushing) { this.flushRequested = true; return; }
        this.flushing = true;
        try {
            do {
                this.flushRequested = false;
                this.schedulePending();
            } while (this.flushRequested);
        } finally { this.flushing = false; }
    }

    schedulePending() {
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        if (!this.ready || this.stopped) return;
        const now = this.now();
        let next = Infinity;
        for (const incident of this.pending) {
            if (incident.sending || (incident.messageId && incident.resolvedAt === null)) continue;
            const due = Math.max(incident.startedAt + incident.delayMs, incident.retryAt);
            if (due <= now) void this.deliver(incident);
            else next = Math.min(next, due);
        }
        if (Number.isFinite(next)) {
            this.timer = this.schedule(() => { this.timer = null; this.flush(); }, Math.max(0, next - now));
            this.timer?.unref?.();
        }
    }

    start() {
        if (this.stopped) return;
        this.ready = true;
        this.flush();
    }

    stop() {
        this.stopped = true;
        this.ready = false;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        this.active.clear();
        this.pending.clear();
    }
}

module.exports = { DiagnosticIncidents };
