// Spaces automated edits of bot messages so a burst of edits stays within Discord's channel limits.
'use strict';

const { performance } = require('node:perf_hooks');
const { abortableDelay, shutdownError } = require('./abortable.js');

const MAX_TRACKED_MESSAGES = 512;

// Edits run one at a time in call order. Each one waits until the route delay has passed since the
// previous edit finished and the same-message delay since that message's own last edit. Only edits
// that are sent use up a slot, including ones Discord rejects; a stopped wait or a skipped payload
// leaves the timing unchanged. The clock is monotonic so a system clock change cannot stretch a wait.
class DiscordEditPacer {
    constructor({ routeDelayMs, sameMessageDelayMs, clock = () => performance.now(), delay = abortableDelay } = {}) {
        this.routeDelayMs = routeDelayMs;
        this.sameMessageDelayMs = sameMessageDelayMs;
        this.clock = clock;
        this.delay = delay;
        this.queue = Promise.resolve();
        this.lastEditAt = -Infinity;
        this.lastMessageEditAt = new Map();
    }

    // load() runs when the edit's turn comes, before the wait, and returns the message to edit.
    // payload(message) runs after the wait; returning null skips the edit. An aborted signal, or
    // isCurrent() returning false, rejects with BOT_SHUTTING_DOWN without editing.
    edit({ key, load, payload, signal = null, isCurrent = null }) {
        const run = this.queue.then(() => this.editInTurn(String(key), load, payload, signal, isCurrent));
        this.queue = run.then(() => {}, () => {});
        return run;
    }

    async editInTurn(key, load, payload, signal, isCurrent) {
        const ensureCurrent = () => {
            if (signal?.aborted || isCurrent?.() === false) throw shutdownError();
        };
        ensureCurrent();
        const message = await load();
        ensureCurrent();
        const now = this.clock();
        const wait = Math.max(0, this.routeDelayMs - (now - this.lastEditAt),
            this.sameMessageDelayMs - (now - (this.lastMessageEditAt.get(key) ?? -Infinity)));
        if (wait > 0) await this.delay(wait, signal);
        ensureCurrent();
        const body = await payload(message);
        if (!body) return null;
        try {
            return await message.edit(body);
        } finally {
            this.recordEdit(key);
        }
    }

    recordEdit(key) {
        const finishedAt = this.clock();
        this.lastEditAt = finishedAt;
        this.lastMessageEditAt.set(key, finishedAt);
        if (this.lastMessageEditAt.size <= MAX_TRACKED_MESSAGES) return;
        const cutoff = finishedAt - Math.max(60_000, this.sameMessageDelayMs * 4);
        for (const [messageKey, editedAt] of this.lastMessageEditAt) {
            if (editedAt < cutoff) this.lastMessageEditAt.delete(messageKey);
        }
    }
}

module.exports = { DiscordEditPacer };
