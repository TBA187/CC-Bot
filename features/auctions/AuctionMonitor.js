// Discovers new PRO auctions and refreshes tracked announcements and bid notifications.
'use strict';

const { runtimeActivity } = require('../../utils/runtimeActivity.js');
const { shutdownError, abortableDelay } = require('../../utils/abortable.js');
const { forumRetryDelay } = require('../../utils/forumRetry.js');
const { AuctionForumRequestError } = require('./AuctionForumClient.js');
const { ended, active } = require('./AuctionStatus.js');

const DEFAULT_INTERVAL_MS = 90 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const REFRESH_BATCH_SIZE = 10;
const DELIVERY_BATCH_SIZE = 5;
const MAX_PAGES = 1000;

function unknownMessage(error) {
    return Number(error?.code) === 10008 || Number(error?.rawError?.code) === 10008;
}

class AuctionMonitor {
    constructor(options = {}) {
        this.store = options.store;
        this.forumClient = options.forumClient;
        this.notifier = options.notifier;
        this.followService = options.followService;
        this.enabled = options.enabled !== false;
        this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
        this.refreshBatchSize = options.refreshBatchSize || REFRESH_BATCH_SIZE;
        this.deliveryBatchSize = options.deliveryBatchSize || DELIVERY_BATCH_SIZE;
        this.requestSpacingMs = options.requestSpacingMs ?? 750;
        this.lastRequestAt = 0;
        this.controller = new AbortController();
        this.activity = options.activity || runtimeActivity;
        this.clock = options.clock || (() => Date.now());
        this.started = false;
        this.stopped = false;
        this.running = false;
        this.timer = null;
        this.failureCount = 0;
        this.forumUnavailable = false;
        this.lastFailureWasForum = false;
        this.nextAttemptAt = 0;
        this.refreshCursor = 0;
        this.itemFailures = new Map();
        this.runFinished = null;
        this.generation = 0;
        this.needsStartupBaseline = true;
        this.requestQueue = Promise.resolve();
        this.auctionRequests = new Map();
    }

    async start() {
        if (this.started) return;
        this.started = true;
        const generation = ++this.generation;
        await this.runFinished;
        await this.requestQueue;
        if (generation !== this.generation) return;
        this.stopped = false;
        this.controller = new AbortController();
        try {
            await this.store.initialize();
            if (generation !== this.generation) return;
            this.needsStartupBaseline = true;
            if (this.enabled && !this.stopped && generation === this.generation) this.schedule(0);
        } catch (error) {
            if (generation === this.generation) this.started = false;
            throw error;
        }
    }

    stop() {
        this.generation++;
        this.stopped = true;
        this.controller.abort();
        this.started = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        return Promise.all([this.runFinished, this.requestQueue]).then(() => this.store.waitForWrites?.());
    }

    checkRunning() {
        if (this.stopped) throw shutdownError();
    }

    schedule(delay) {
        if (!this.started || this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        const generation = this.generation;
        this.timer = setTimeout(async () => {
            this.timer = null;
            if (!this.started || this.stopped || generation !== this.generation) return;
            await this.runOnce();
            if (!this.started || this.stopped || generation !== this.generation) return;
            this.schedule(Math.max(this.intervalMs, this.nextAttemptAt - this.clock()));
        }, Math.min(delay, 2_147_483_647));
        this.timer.unref?.();
    }

    async runOnce() {
        if (!this.enabled || this.stopped || this.running || this.clock() < this.nextAttemptAt) return false;
        this.running = true;
        let finishRun;
        this.runFinished = new Promise(resolve => { finishRun = resolve; });
        const finish = this.activity.begin('PRO auction monitoring');
        try {
            await this.store.reconcile?.();
            await this.followService?.cleanupEnded();
            this.checkRunning();
            await this.scan();
            this.checkRunning();
            if (this.forumUnavailable) console.log('[CC LOG] PRO auction monitor connection restored.');
            else if (this.failureCount) console.log('[CC LOG] PRO auction monitor restored.');
            this.failureCount = 0;
            this.forumUnavailable = false;
            this.lastFailureWasForum = false;
            this.nextAttemptAt = 0;
            return true;
        } catch (error) {
            if (error.code !== 'BOT_SHUTTING_DOWN') {
                this.failureCount++;
                const delay = forumRetryDelay(this.intervalMs, this.failureCount, MAX_BACKOFF_MS, error.retryAfterMs);
                this.nextAttemptAt = this.clock() + delay;
                const forumFailure = error instanceof AuctionForumRequestError && this.batchFailure(error);
                if (forumFailure) {
                    if (!this.forumUnavailable) console.warn(`[CC LOG] PRO auction monitor is unavailable. Retrying in ${Math.ceil(delay / 60000)} minute(s); pending work retained:`, error.message, { code: error.code });
                    this.forumUnavailable = true;
                } else if (this.failureCount === 1 || this.lastFailureWasForum) {
                    console.warn('[CC LOG] PRO auction monitor failed; retaining pending work:', error.message);
                }
                this.lastFailureWasForum = forumFailure;
            }
            return false;
        } finally {
            this.running = false;
            finish();
            this.runFinished = null;
            finishRun();
        }
    }

    async listing(page, status = 'active') {
        this.checkRunning();
        const result = await this.request(signal => this.forumClient.fetchListing(page, status, { signal }));
        this.checkRunning();
        if (!Array.isArray(result?.auctions) || (!result.auctions.length && Number(result.lastPage) > 1)
            || result.auctions.some(item => !/^\d+$/.test(String(item.id || '')))) {
            throw new Error(`Auction listing page ${page} is empty or unreadable.`);
        }
        return result;
    }

    async listingsSince(first, status, watermark) {
        const found = new Map();
        const lastPage = Math.max(1, Number(first.lastPage) || 1);
        if (lastPage > MAX_PAGES) throw new Error('Auction listing has too many pages to scan safely.');
        let previous = null;
        for (let page = 1; page <= lastPage; page++) {
            const result = page === 1 ? first : await this.listing(page, status);
            if (!result.auctions.length && page > 1) throw new Error(`Auction ${status} page ${page} was empty.`);
            for (const item of result.auctions) {
                const id = String(item.id);
                const number = BigInt(id);
                if (previous !== null && number > previous) throw new Error(`Auction ${status} ordering changed; checkpoint retained.`);
                previous = number;
                if (number <= watermark) return found;
                found.set(id, { id, url: item.url });
            }
        }
        return found;
    }

    async pace() {
        const wait = Math.max(0, this.lastRequestAt + this.requestSpacingMs - Date.now());
        if (wait) await abortableDelay(wait, this.controller.signal);
        this.checkRunning();
        this.lastRequestAt = Date.now();
    }

    request(work) {
        const generation = this.generation;
        const signal = this.controller.signal;
        const pending = this.requestQueue.then(async () => {
            if (signal.aborted || generation !== this.generation) throw shutdownError();
            await this.pace();
            const result = await work(signal);
            if (signal.aborted || generation !== this.generation) throw shutdownError();
            return result;
        });
        this.requestQueue = pending.catch(() => {});
        return pending;
    }

    fetchAuction(id) {
        const key = String(id);
        if (this.auctionRequests.has(key)) return this.auctionRequests.get(key);
        const pending = this.request(signal => this.forumClient.fetchAuction(key, { signal }))
            .finally(() => { if (this.auctionRequests.get(key) === pending) this.auctionRequests.delete(key); });
        this.auctionRequests.set(key, pending);
        return pending;
    }

    itemReady(key) {
        return this.clock() >= (this.itemFailures.get(key)?.nextAttemptAt || 0);
    }

    itemFailed(key, error) {
        const previous = this.itemFailures.get(key);
        const count = (previous?.count || 0) + 1;
        const delay = forumRetryDelay(this.intervalMs, count, MAX_BACKOFF_MS, error.retryAfterMs);
        this.itemFailures.set(key, { count, nextAttemptAt: this.clock() + delay });
        if (!previous) console.warn(`[CC LOG] PRO auction ${key} failed; retrying separately:`, error.message);
    }

    itemRestored(key) {
        if (this.itemFailures.delete(key)) console.log(`[CC LOG] PRO auction ${key} recovered.`);
    }

    async markMessageMissing(id, record, key) {
        let marked = false;
        await this.store.update(data => {
            const tracked = data.tracked[id];
            if (!tracked || String(tracked.messageId) !== String(record.messageId)) return;
            tracked.messageMissing = true;
            marked = true;
        });
        this.itemFailures.delete(key);
        if (marked) console.log(`[CC LOG] PRO auction ${id} message was not found in the configured channel; embed updates stopped.`);
    }

    batchFailure(error) {
        const status = Number(error.status || error.statusCode);
        const code = String(error.code || error.cause?.code || '');
        return error.code === 'BOT_SHUTTING_DOWN' || status === 429 || status >= 500
            || /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)
            || /fetch failed/i.test(String(error.message || ''));
    }

    async deliverPending(delivered, attempted) {
        const state = await this.store.getState();
        const ids = [...new Set([...(state.pendingOrder || []), ...Object.keys(state.pending)])];
        for (const id of ids) {
            if (attempted.size >= this.deliveryBatchSize) break;
            if (!state.pending[id]) continue;
            if (attempted.has(id)) continue;
            const key = `delivery ${id}`;
            if (!this.itemReady(key)) continue;
            attempted.add(id);
            this.checkRunning();
            let auction;
            let message;
            try {
                auction = await this.fetchAuction(id);
                this.checkRunning();
                message = await this.notifier.send(auction, { queuedAt: state.pending[id].queuedAt });
                if (!message?.id) throw new Error(`Auction ${id} delivery returned no Discord message ID.`);
            } catch (error) {
                if (this.batchFailure(error)) throw error;
                this.itemFailed(key, error);
                continue;
            }
            // Save completed delivery even when stop() occurred during the send.
            await this.store.update(data => {
                data.tracked[id] = { ...data.tracked[id], messageId: String(message.id), auction };
                delete data.pending[id];
                data.pendingOrder = (data.pendingOrder || []).filter(item => item !== id);
            });
            this.itemRestored(key);
            delivered.add(id);
        }
    }

    async scan() {
        const state = await this.store.getState();
        this.checkRunning();
        const delivered = new Set();
        const attempted = new Set();
        if (!this.needsStartupBaseline && state.initialized) await this.deliverPending(delivered, attempted);
        const first = await this.listing(1);
        const firstIds = [...new Set(first.auctions.map(item => String(item.id)))];
        const inactive = await this.listing(1, 'inactive');
        const inactiveIds = [...new Set(inactive.auctions.map(item => String(item.id)))];
        const highest = ids => ids.reduce((value, id) => BigInt(id) > value ? BigInt(id) : value, 0n);
        const activeTop = highest(firstIds);
        if (this.needsStartupBaseline || !state.initialized) {
            if (!firstIds.length && !inactiveIds.length) throw new Error('Cannot establish an auction baseline without any listings.');
            const watermark = highest([...firstIds, ...inactiveIds, ...Object.keys(state.pending),
                ...Object.keys(state.tracked), state.inactiveWatermark || '0']);
            const skipped = Object.keys(state.pending).length;
            await this.store.update(data => {
                data.initialized = true;
                data.inactiveWatermark = String(watermark);
                data.pending = {};
                data.pendingOrder = [];
            });
            this.needsStartupBaseline = false;
            for (const id of Object.keys(state.pending)) this.itemFailures.delete(`delivery ${id}`);
            console.log(`[CC LOG] PRO auction startup baseline recorded; existing listings and ${skipped} queued announcement${skipped === 1 ? '' : 's'} will not be posted.`);
            return this.refreshTracked(delivered);
        }

        if (!/^\d+$/.test(String(state.inactiveWatermark))) throw new Error('Invalid auction recovery checkpoint.');
        const watermark = BigInt(state.inactiveWatermark);
        const activeFound = await this.listingsSince(first, 'active', watermark);
        const inactiveFound = await this.listingsSince(inactive, 'inactive', watermark);
        const found = new Map([...activeFound, ...inactiveFound]);
        // The active page was fetched first. A higher ID appearing afterward in either
        // list must remain eligible for the next scan, even if the inactive scan sees it.
        const safeTop = activeTop || watermark;
        await this.store.update(data => {
            const items = [...found.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            for (const item of items) {
                if (!data.pending[item.id] && !data.tracked[item.id]) {
                    data.pending[item.id] = { ...item, queuedAt: new Date(this.clock()).toISOString() };
                    data.pendingOrder.push(item.id);
                }
            }
            if (safeTop > watermark) data.inactiveWatermark = String(safeTop);
        });
        await this.deliverPending(delivered, attempted);
        return this.refreshTracked(delivered);
    }

    async refreshTracked(delivered) {
        const state = await this.store.getState();
        const ids = Object.keys(state.tracked).filter(id => (!state.tracked[id].messageMissing || Object.keys(state.tracked[id].follow?.users || {}).length)
            && !ended(state.tracked[id].auction) && !delivered.has(id));
        if (!ids.length) {
            this.refreshCursor = 0;
            return;
        }
        const count = Math.min(ids.length, this.refreshBatchSize);
        const start = this.refreshCursor % ids.length;
        const eligible = new Set();
        for (let index = 0; index < count; index++) {
            this.checkRunning();
            const id = ids[(start + index) % ids.length];
            const key = `refresh ${id}`;
            if (!this.itemReady(key)) continue;
            const record = state.tracked[id];
            let auction;
            try {
                auction = await this.fetchAuction(id);
                this.checkRunning();
                if (!auction.auctionDuration && record.auction.auctionDuration) {
                    auction.auctionDuration = record.auction.auctionDuration;
                }
            } catch (error) {
                if (this.batchFailure(error)) throw error;
                if ([404, 410].includes(Number(error.status || error.statusCode))) {
                    await this.followService?.pause(id);
                    if (!record.auction.sourceUnavailable) {
                        const unavailable = { ...record.auction, status: 'Unavailable', sourceUnavailable: true, endsAt: null, timeLeft: null };
                        try {
                            await this.notifier.edit(record.messageId, unavailable);
                            await this.store.update(data => { data.tracked[id].auction = unavailable; });
                        } catch (editError) {
                            if (editError.auctionStorage || editError.code === 'AUCTION_STORE_CONFLICT' || this.batchFailure(editError)) throw editError;
                            if (unknownMessage(editError)) {
                                await this.markMessageMissing(id, record, key);
                                continue;
                            }
                            this.itemFailed(key, editError);
                            continue;
                        }
                    }
                    this.itemFailed(key, error);
                    continue;
                }
                this.itemFailed(key, error);
                continue;
            }
            await this.followService?.observe(id, auction);
            if (active(auction)) eligible.add(id);
            if (record.messageMissing) {
                await this.store.update(data => { data.tracked[id].auction = auction; });
                this.itemRestored(key);
                continue;
            }
            if (JSON.stringify(auction) === JSON.stringify(record.auction)) {
                this.itemRestored(key);
                continue;
            }
            try {
                await this.notifier.edit(record.messageId, auction);
            } catch (error) {
                if (this.batchFailure(error)) throw error;
                if (unknownMessage(error)) {
                    await this.markMessageMissing(id, record, key);
                    continue;
                }
                this.itemFailed(key, error);
                continue;
            }
            await this.store.update(data => { data.tracked[id].auction = auction; });
            this.itemRestored(key);
        }
        this.refreshCursor = (start + count) % ids.length;
        await this.followService?.drain(eligible);
    }
}

module.exports = { AuctionMonitor, ended };
