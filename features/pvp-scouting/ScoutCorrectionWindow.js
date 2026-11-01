// Durable one-hour correction windows for new, unreviewed scout reports.
'use strict';

const CORRECTION_WINDOW_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

class ScoutCorrectionWindow {
    constructor({ store, onReview, recheck = async () => {}, recover = async () => {}, needsReview = async () => true, busy = () => false, stopped = () => false }) {
        this.store = store; this.onReview = onReview; this.recheck = recheck;
        this.recover = recover; this.needsReview = needsReview;
        this.busy = busy; this.stopped = stopped; this.timers = new Map(); this.running = new Map();
        this.restoreTimer = null;
    }

    cancel(id) {
        const timer = this.timers.get(String(id));
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(String(id));
    }

    arm(window, delay = null) {
        const id = String(window.message_id);
        this.cancel(id);
        if (this.stopped()) return;
        const timer = setTimeout(() => { this.timers.delete(id); void this.finish(id); },
            delay ?? Math.max(0, Number(window.due_at_ms) - Date.now()));
        timer.unref?.(); this.timers.set(id, timer);
    }

    async start(id) {
        const window = await this.store.startCorrectionWindow(id, Date.now(), CORRECTION_WINDOW_MS);
        if (window?.status === 'waiting') this.arm(window);
        return window;
    }

    async resolve(id) { this.cancel(id); await this.store.resolveCorrectionWindow(id); }

    async restore() {
        if (this.stopped()) return;
        try {
            const windows = await this.store.pendingCorrectionWindows();
            for (const window of windows) {
                if (window.due_at_ms != null) this.arm(window);
                else await this.finish(window.message_id);
            }
        } catch (error) {
            console.warn(`[CC LOG] Scout correction timer recovery will retry: ${error.message}`);
            if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
            if (!this.stopped()) {
                this.restoreTimer = setTimeout(() => { this.restoreTimer = null; void this.restore(); }, RETRY_MS);
                this.restoreTimer.unref?.();
            }
        }
    }

    finish(id) {
        id = String(id);
        if (this.running.has(id)) return this.running.get(id);
        const work = this.expire(id).catch(error => {
            console.warn(`[CC LOG] Scout correction deadline ${id} will retry: ${error.message}`);
            this.arm({ message_id: id }, RETRY_MS);
        }).finally(() => this.running.delete(id));
        this.running.set(id, work); return work;
    }

    async expire(id) {
        if (this.stopped()) return;
        let window = await this.store.getCorrectionWindow(id);
        if (!window || window.status === 'resolved') return;
        if (window.due_at_ms == null) {
            // Resume a crash between reserving the archive row and posting feedback.
            await this.recheck(id);
            await this.recover(id);
            return;
        }
        if (Number(window.due_at_ms) > Date.now()) { this.arm(window); return; }
        if (this.busy()) { this.arm(window, RETRY_MS); return; }
        // Refresh the Discord source before escalation, including edits missed offline.
        await this.recheck(id);
        if (this.stopped() || this.busy()) { this.arm(window, RETRY_MS); return; }
        const row = await this.store.getMessage(id);
        const root = row?.root_message_id && row.root_message_id !== row.message_id
            ? await this.store.getMessage(row.root_message_id) : row;
        if (!row || row.is_deleted || row.staffOverrides?.hidden || row.review_status !== 'pending'
            || row.reviewed_by_id || root?.is_deleted || root?.staffOverrides?.hidden
            || root?.review_status === 'not_scout' || !await this.needsReview(id)) { await this.resolve(id); return; }
        window = await this.store.getCorrectionWindow(id);
        if (window?.status === 'waiting') {
            if (!await this.store.escalateCorrectionWindow(id, Date.now())) return;
        } else if (window?.status !== 'escalated') return;
        await this.onReview(id);
    }

    async stop() {
        if (this.restoreTimer !== null) clearTimeout(this.restoreTimer);
        this.restoreTimer = null;
        for (const id of this.timers.keys()) this.cancel(id);
        await Promise.allSettled([...this.running.values()]);
    }
}

module.exports = { ScoutCorrectionWindow, CORRECTION_WINDOW_MS };
