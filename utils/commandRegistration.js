'use strict';

// A temporary REST outage must not prevent the bot from connecting to Discord,
// where it can report a persistent registration failure and its recovery.
class CommandRegistration {
    constructor({ register, signal, consoleObject = console, schedule = setTimeout, cancel = clearTimeout,
        retryMs = 60_000, maxRetryMs = 5 * 60_000 } = {}) {
        Object.assign(this, { register, signal, console: consoleObject, schedule, cancel, retryMs, maxRetryMs });
        this.timer = null;
        this.stopped = Boolean(signal?.aborted);
        this.running = false;
        this.complete = false;
        this.retryDelay = retryMs;
        this.onAbort = () => this.stop();
        if (!this.stopped) signal?.addEventListener('abort', this.onAbort, { once: true });
    }

    async start() {
        if (this.stopped || this.running || this.complete) return;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        this.running = true;
        try {
            this.console.log('[CC LOG] Registering Guild slash commands...');
            await this.register();
            if (!this.stopped) {
                this.complete = true;
                this.console.log('[CC LOG] ✅ Guild slash commands registered to Discord');
                this.signal?.removeEventListener('abort', this.onAbort);
            }
        } catch (error) {
            if (this.stopped) return;
            this.console.error('[CC LOG] ❌ ERROR: Command registration failed:', error);
            this.timer = this.schedule(() => { this.timer = null; void this.start(); }, this.retryDelay);
            this.timer?.unref?.();
            this.retryDelay = Math.min(this.maxRetryMs, this.retryDelay * 2);
        } finally { this.running = false; }
    }

    stop() {
        this.stopped = true;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        this.signal?.removeEventListener('abort', this.onAbort);
    }
}

module.exports = { CommandRegistration };
