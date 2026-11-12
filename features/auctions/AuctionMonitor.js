// Discovers new PRO auctions and refreshes tracked announcements and bid notifications.
'use strict';

const { runtimeActivity } = require('../../utils/runtimeActivity.js');
const { shutdownError, abortableDelay } = require('../../utils/abortable.js');
const { forumRetryDelay } = require('../../utils/forumRetry.js');
const { AuctionForumRequestError } = require('./AuctionForumClient.js');
const { ended, active } = require('./AuctionStatus.js');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_INTERVAL_MS = 90 * 1000;
const MAX_BACKOFF_MS = 30 * MINUTE_MS;
const REFRESH_BATCH_SIZE = 10;
const DELIVERY_BATCH_SIZE = 5;
const MAX_PAGES = 1000;
const CATCH_UP_LIMIT = 10;
const RETENTION_MS = 30 * DAY_MS;
const RECEIPT_PRUNE_INTERVAL_MS = HOUR_MS;
const SWEEP_INTERVAL_MS = 10 * MINUTE_MS;
const FULL_SWEEP_INTERVAL_MS = DAY_MS;
const SWEEP_PAGES_PER_RUN = 10;
const RECENT_SWEEP_PAGE_LIMIT = 50;
const FRESH_MS = 7 * DAY_MS;
const FRESH_SAFETY_MS = 6 * HOUR_MS;
const OLD_SAFETY_MS = 7 * DAY_MS;
const COUNTDOWN_REFRESH_MS = 10 * MINUTE_MS;
const END_GRACE_MS = MINUTE_MS;
const UNAVAILABLE_RETRY_MS = 30 * MINUTE_MS;
const DISCORD_EPOCH_MS = 1420070400000n;
const EARLIEST_ANNOUNCEMENT_MS = Date.UTC(2020, 0, 1);
const RETRYABLE_NETWORK_CODES = /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/;
const CERTIFICATE_CODES = /^(?:CERT_|ERR_TLS_|UNABLE_TO_VERIFY_LEAF_SIGNATURE$|SELF_SIGNED_CERT_IN_CHAIN$|DEPTH_ZERO_SELF_SIGNED_CERT$)|_CERT_/;

function unknownMessage(error) {
    return Number(error?.code) === 10008 || Number(error?.rawError?.code) === 10008;
}

function timeMs(value) {
    const ms = Date.parse(value || '');
    return Number.isFinite(ms) ? ms : null;
}

function pastMs(value, now) {
    const ms = timeMs(value);
    return ms !== null && ms <= now ? ms : null;
}

function endedAtMs(auction, now) {
    return pastMs(auction.endedAt, now) ?? pastMs(auction.endsAt, now) ?? pastMs(auction.endedObservedAt, now);
}

// Discord message IDs contain their creation time, which dates an announcement without extra storage.
function announcedAtMs(messageId, now) {
    if (!/^\d{17,20}$/.test(String(messageId || ''))) return null;
    const ms = Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH_MS);
    return ms >= EARLIEST_ANNOUNCEMENT_MS && ms <= now + MINUTE_MS ? ms : null;
}

function withoutSignature({ listingSignature: _signature, ...auction }) { return auction; }

function plural(count, noun) { return `${count} ${noun}${count === 1 ? '' : 's'}`; }

function formatDelay(ms) {
    return ms < 2 * MINUTE_MS ? `${Math.max(1, Math.ceil(ms / 1000))} seconds` : `${Math.ceil(ms / MINUTE_MS)} minutes`;
}

function highestId(ids) {
    return ids.reduce((value, id) => /^\d+$/.test(String(id)) && BigInt(id) > value ? BigInt(id) : value, 0n);
}

const byIdAscending = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

// Retention removes a record 30 days after it ended or its forum page disappeared. A missing
// or invalid time is stamped first, so the 30 days start when the monitor sees that state.
function retentionAction(auction, now) {
    if (ended(auction)) {
        const since = endedAtMs(auction, now);
        return since === null ? 'endedObservedAt' : now - since >= RETENTION_MS ? 'remove' : null;
    }
    if (auction.sourceUnavailable) {
        const since = pastMs(auction.unavailableSince, now);
        return since === null ? 'unavailableSince' : now - since >= RETENTION_MS ? 'remove' : null;
    }
    return null;
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
        this.random = options.random || Math.random;
        this.started = false;
        this.stopped = false;
        this.running = false;
        this.timer = null;
        this.failureCount = 0;
        this.forumUnavailable = false;
        this.lastFailureWasForum = false;
        this.nextAttemptAt = 0;
        this.nextDiscoveryAt = 0;
        this.nextRefreshAttemptAt = Infinity;
        this.nextReceiptPruneAt = 0;
        this.itemFailures = new Map();
        this.runFinished = null;
        this.generation = 0;
        this.needsStartupBaseline = true;
        this.requestQueue = Promise.resolve();
        this.auctionRequests = new Map();
        this.forumRateLimit = null;
        this.resetRefreshSchedule();
    }

    // Refresh timing lives in memory. After a restart the regular checks start at random
    // points in their interval, and saved listing signatures avoid a burst of page requests.
    resetRefreshSchedule() {
        this.refreshedAt = new Map();
        this.refreshBase = new Map();
        this.sweepFlags = new Map();
        this.cardSignatures = new Map();
        this.discoverySignatures = new Map();
        this.activeSweep = null;
        this.nextSweepAt = 0;
        this.nextFullSweepAt = this.clock() + this.random() * FULL_SWEEP_INTERVAL_MS;
        this.sweepLimitWarned = false;
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
            this.nextDiscoveryAt = 0;
            this.nextRefreshAttemptAt = Infinity;
            this.resetRefreshSchedule();
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
            await this.runOnce({ scheduled: true });
            if (this.running) await this.runFinished;
            if (!this.started || this.stopped || generation !== this.generation) return;
            const now = this.clock();
            const sweepAt = this.activeSweep ? now : Infinity;
            const wakeAt = Math.max(this.nextAttemptAt, Math.min(this.nextDiscoveryAt, this.nextRefreshAttemptAt, sweepAt));
            this.schedule(Math.max(0, wakeAt - now));
        }, Math.min(delay, 2_147_483_647));
        this.timer.unref?.();
    }

    // Direct runs perform a full scan and check every tracked auction; scheduled runs follow
    // the refresh schedule between discovery scans without repeating the listing requests.
    async runOnce({ scheduled = false } = {}) {
        if (!this.enabled || this.stopped || this.running || this.clock() < this.nextAttemptAt) return false;
        this.running = true;
        let finishRun;
        this.runFinished = new Promise(resolve => { finishRun = resolve; });
        const finish = this.activity.begin('PRO auction monitoring');
        try {
            await this.store.reconcile?.();
            await this.followService?.cleanupEnded();
            await this.pruneStale();
            this.checkRunning();
            let discovery = null;
            if (!scheduled || this.needsStartupBaseline || this.clock() >= this.nextDiscoveryAt) {
                this.nextDiscoveryAt = this.clock() + this.intervalMs;
                discovery = await this.scan();
            }
            this.checkRunning();
            await this.sweepListings(discovery?.first || null);
            await this.refreshTracked(discovery?.delivered || new Set(), { onlyDue: scheduled });
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
                    if (!this.forumUnavailable) console.warn(`[CC LOG] PRO auction monitor is unavailable. Retrying in ${formatDelay(delay)}; pending work retained:`, error.message, { code: error.code });
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

    // Reads new listings down to the checkpoint. The total page count is not a limit because
    // the inactive listing keeps growing; only the pages that actually need reading count.
    async listingsSince(first, status, watermark, limit = Infinity) {
        const found = new Map();
        const lastPage = Math.max(1, Number(first.lastPage) || 1);
        let previous = null;
        for (let page = 1; page <= lastPage; page++) {
            if (page > MAX_PAGES) throw new Error(`Auction ${status} listing has more than ${MAX_PAGES} new pages; checkpoint retained.`);
            const result = page === 1 ? first : await this.listing(page, status);
            if (!result.auctions.length && page > 1) throw new Error(`Auction ${status} page ${page} was empty.`);
            for (const item of result.auctions) {
                const id = String(item.id);
                const number = BigInt(id);
                if (previous !== null && number > previous) throw new Error(`Auction ${status} ordering changed; checkpoint retained.`);
                previous = number;
                if (number <= watermark || found.size >= limit) return found;
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

    // A single connection reset or timeout is common on the forum host; one retry after the
    // normal spacing avoids pausing the whole monitor for it. A certificate failure does not
    // clear up that quickly, so it is not retried.
    retryableNetworkError(error) {
        if (!(error instanceof AuctionForumRequestError) || error.status) return false;
        for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++) {
            if (CERTIFICATE_CODES.test(String(current.code || ''))) return false;
        }
        return RETRYABLE_NETWORK_CODES.test(String(error.code || error.cause?.code || ''))
            || /fetch failed/i.test(String(error.message || ''));
    }

    request(work) {
        const generation = this.generation;
        const signal = this.controller.signal;
        const pending = this.requestQueue.then(async () => {
            for (let attempt = 1; ; attempt++) {
                if (signal.aborted || generation !== this.generation) throw shutdownError();
                const remaining = (this.forumRateLimit?.retryAt || 0) - this.clock();
                if (remaining > 0) {
                    throw new AuctionForumRequestError('PRO auction requests are waiting for the forum rate limit to expire.', {
                        code: 'HTTP_429', status: 429, retryAfterMs: remaining
                    });
                }
                await this.pace();
                let result;
                try { result = await work(signal); }
                catch (error) {
                    if (signal.aborted || generation !== this.generation) throw shutdownError();
                    if (attempt === 1 && this.retryableNetworkError(error)) continue;
                    if (error instanceof AuctionForumRequestError && Number(error.status) === 429) {
                        const count = (this.forumRateLimit?.count || 0) + 1;
                        this.forumRateLimit = { count, retryAt: this.clock()
                            + forumRetryDelay(this.intervalMs, count, MAX_BACKOFF_MS, error.retryAfterMs) };
                    } else this.forumRateLimit = null;
                    throw error;
                }
                if (signal.aborted || generation !== this.generation) throw shutdownError();
                this.forumRateLimit = null;
                return result;
            }
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

    itemFailed(key, error, { sourceUnavailable = false } = {}) {
        const previous = this.itemFailures.get(key);
        const count = (previous?.count || 0) + 1;
        const delay = forumRetryDelay(this.intervalMs, count, MAX_BACKOFF_MS, error.retryAfterMs);
        this.itemFailures.set(key, { count, nextAttemptAt: this.clock() + delay, sourceUnavailable });
        if (!previous || Boolean(previous.sourceUnavailable) !== sourceUnavailable) {
            if (sourceUnavailable) console.log(`[CC LOG] PRO auction ${key} is unavailable (HTTP ${error.status || error.statusCode}); retrying separately.`);
            else console.warn(`[CC LOG] PRO auction ${key} failed; retrying separately:`, error.message);
        }
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

    async markPendingUnavailable(id, since) {
        await this.store.update(data => {
            const entry = data.pending[id];
            if (!entry) return;
            if (since === null) delete entry.unavailableSince;
            else entry.unavailableSince = since;
        });
    }

    batchFailure(error) {
        const status = Number(error.status || error.statusCode);
        const code = String(error.code || error.cause?.code || '');
        return error.code === 'BOT_SHUTTING_DOWN' || status === 429 || status >= 500
            || /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)
            || /fetch failed/i.test(String(error.message || ''));
    }

    forgetAuction(id) {
        for (const map of [this.refreshedAt, this.refreshBase, this.sweepFlags, this.cardSignatures]) map.delete(id);
        this.itemFailures.delete(`refresh ${id}`);
    }

    async pruneStale() {
        const now = this.clock();
        const actions = await this.store.readTracked((record, id) => retentionAction(record.auction, now) ? id : undefined);
        const dropped = Object.entries((await this.store.getMeta()).pending)
            .filter(([, entry]) => {
                const since = pastMs(entry.unavailableSince, now);
                return since !== null && now - since >= RETENTION_MS;
            })
            .map(([id]) => id);
        if (actions.length || dropped.length) {
            const removed = [];
            const stamped = new Date(now).toISOString();
            await this.store.update(data => {
                for (const id of actions) {
                    const record = data.tracked[id];
                    const action = record && retentionAction(record.auction, now);
                    if (action === 'remove') {
                        delete data.tracked[id];
                        removed.push(id);
                    } else if (action) record.auction[action] = stamped;
                }
                for (const id of dropped) {
                    delete data.pending[id];
                    data.pendingOrder = data.pendingOrder.filter(item => item !== id);
                }
            });
            for (const id of removed) this.forgetAuction(id);
            for (const id of dropped) this.itemFailures.delete(`delivery ${id}`);
            if (removed.length) console.log(`[CC LOG] Removed ${plural(removed.length, 'stale PRO auction record')} (ended or unavailable for more than 30 days).`);
            if (dropped.length) console.log(`[CC LOG] Dropped ${plural(dropped.length, 'queued PRO auction announcement')} whose forum page stayed unavailable for 30 days.`);
        }
        if (now >= this.nextReceiptPruneAt && this.store.pruneReceipts) {
            this.nextReceiptPruneAt = now + RECEIPT_PRUNE_INTERVAL_MS;
            const receipts = await this.store.pruneReceipts(now - RETENTION_MS);
            if (receipts) console.log(`[CC LOG] Removed ${plural(receipts, 'PRO auction change receipt')} older than 30 days.`);
        }
    }

    async deliverPending(delivered, attempted) {
        const state = await this.store.getMeta();
        const ids = [...new Set([...(state.pendingOrder || []), ...Object.keys(state.pending)])];
        for (const id of ids) {
            if (attempted.size >= this.deliveryBatchSize) break;
            const entry = state.pending[id];
            if (!entry || attempted.has(id)) continue;
            const key = `delivery ${id}`;
            if (!this.itemReady(key)) continue;
            attempted.add(id);
            this.checkRunning();
            let auction;
            let message;
            let fetched = false;
            try {
                auction = await this.fetchAuction(id);
                fetched = true;
                this.checkRunning();
                message = await this.notifier.send(auction, { queuedAt: entry.queuedAt });
                if (!message?.id) throw new Error(`Auction ${id} delivery returned no Discord message ID.`);
            } catch (error) {
                if (this.batchFailure(error)) throw error;
                const sourceUnavailable = error instanceof AuctionForumRequestError && [404, 410].includes(Number(error.status));
                this.itemFailed(key, error, { sourceUnavailable });
                if (sourceUnavailable && !entry.unavailableSince) await this.markPendingUnavailable(id, new Date(this.clock()).toISOString());
                else if (fetched && entry.unavailableSince) await this.markPendingUnavailable(id, null);
                continue;
            }
            const signature = this.discoverySignatures.get(id);
            const stored = signature ? { ...auction, listingSignature: signature } : auction;
            // Save completed delivery even when stop() occurred during the send.
            await this.store.update(data => {
                data.tracked[id] = { ...data.tracked[id], messageId: String(message.id), auction: stored };
                delete data.pending[id];
                data.pendingOrder = (data.pendingOrder || []).filter(item => item !== id);
            });
            this.refreshedAt.set(id, this.clock());
            this.itemRestored(key);
            delivered.add(id);
        }
    }

    // Queues only the newest auctions posted while the bot was offline, so a restart cannot flood the channel.
    async queueStartupCatchUp(state, first, inactive, watermark, trackedIds) {
        if (!/^\d+$/.test(String(state.inactiveWatermark))) throw new Error('Invalid auction recovery checkpoint.');
        const previous = BigInt(state.inactiveWatermark);
        // One extra entry per listing shows whether older auctions are being skipped, without reading every page.
        const activeFound = await this.listingsSince(first, 'active', previous, CATCH_UP_LIMIT + 1);
        const inactiveFound = await this.listingsSince(inactive, 'inactive', previous, CATCH_UP_LIMIT + 1);
        const queuedAt = new Date(this.clock()).toISOString();
        const candidates = new Map(Object.entries(state.pending));
        for (const [id, item] of [...activeFound, ...inactiveFound]) if (!candidates.has(id)) candidates.set(id, { ...item, queuedAt });
        const newest = [...candidates.keys()].filter(id => !trackedIds.has(id)).sort(byIdAscending).reverse();
        const queued = newest.slice(0, CATCH_UP_LIMIT);
        const skipped = newest.slice(CATCH_UP_LIMIT);
        await this.store.update(data => {
            data.inactiveWatermark = String(watermark);
            data.pending = Object.fromEntries(queued.map(id => [id, candidates.get(id)]));
            data.pendingOrder = [...queued].sort(byIdAscending);
        });
        this.needsStartupBaseline = false;
        for (const id of skipped) this.itemFailures.delete(`delivery ${id}`);
        console.log(`[CC LOG] PRO auction startup catch-up queued ${plural(queued.length, 'auction')} posted while the bot was offline${skipped.length ? '; older ones were skipped' : ''}.`);
    }

    async scan() {
        const state = await this.store.getMeta();
        this.checkRunning();
        const delivered = new Set();
        const attempted = new Set();
        if (!this.needsStartupBaseline && state.initialized) await this.deliverPending(delivered, attempted);
        const first = await this.listing(1);
        this.discoverySignatures = new Map(first.auctions.filter(item => item.signature).map(item => [String(item.id), item.signature]));
        const firstIds = [...new Set(first.auctions.map(item => String(item.id)))];
        const inactive = await this.listing(1, 'inactive');
        const inactiveIds = [...new Set(inactive.auctions.map(item => String(item.id)))];
        const activeTop = highestId(firstIds);
        if (this.needsStartupBaseline || !state.initialized) {
            if (!firstIds.length && !inactiveIds.length) throw new Error('Cannot establish an auction baseline without any listings.');
            const trackedIds = await this.store.readTracked((_record, id) => id);
            const watermark = highestId([...firstIds, ...inactiveIds, ...Object.keys(state.pending),
                ...trackedIds, state.inactiveWatermark || '0']);
            if (state.initialized) {
                await this.queueStartupCatchUp(state, first, inactive, watermark, new Set(trackedIds));
                await this.deliverPending(delivered, attempted);
                return { delivered, first };
            }
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
            return { delivered, first };
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
            const items = [...found.values()].sort((a, b) => byIdAscending(a.id, b.id));
            for (const item of items) {
                if (!data.pending[item.id] && !data.tracked[item.id]) {
                    data.pending[item.id] = { ...item, queuedAt: new Date(this.clock()).toISOString() };
                    data.pendingOrder.push(item.id);
                }
            }
            if (safeTop > watermark) data.inactiveWatermark = String(safeTop);
        });
        await this.deliverPending(delivered, attempted);
        return { delivered, first };
    }

    isFresh(record, now) {
        const announcedAt = announcedAtMs(record.messageId, now);
        return announcedAt === null || now - announcedAt < FRESH_MS;
    }

    // The regular sweep reads active pages down to the oldest auction announced in the last
    // 7 days, so its size stays flat while old listings without bids accumulate further down.
    // The ceiling is the newest auction tracked when the sweep starts. Auctions tracked later
    // can be newer than the pages the sweep read, so the sweep does not cover them.
    async sweepBounds() {
        const now = this.clock();
        let boundary = null, ceiling = null;
        await this.store.readTracked((record, id) => {
            const value = BigInt(id);
            if (ceiling === null || value > ceiling) ceiling = value;
            if (!ended(record.auction) && !record.auction.sourceUnavailable && this.isFresh(record, now)
                && (boundary === null || value < boundary)) boundary = value;
        });
        return { boundary, ceiling };
    }

    async listingPage(page) {
        this.checkRunning();
        const result = await this.request(signal => this.forumClient.fetchListing(page, 'active', { signal }));
        this.checkRunning();
        if (!Array.isArray(result?.auctions) || result.auctions.some(item => !/^\d+$/.test(String(item.id || '')))) {
            throw new Error(`Auction listing page ${page} is unreadable.`);
        }
        return result;
    }

    // Reads the active listing to find tracked auctions whose card changed or that left the
    // list. Recent pages are read every 10 minutes and every page once a day, a few pages per run.
    async sweepListings(first) {
        let sweep = this.activeSweep;
        if (!sweep) {
            if (!first || this.needsStartupBaseline || this.clock() < this.nextSweepAt) return;
            sweep = this.activeSweep = { full: this.clock() >= this.nextFullSweepAt, ...await this.sweepBounds(),
                nextPage: 1, lastPage: Math.max(1, Number(first.lastPage) || 1), seen: new Set(), signatures: new Map(),
                lowestSeen: null, covered: false, complete: false, startedAt: this.clock() };
        }
        let pages = 0;
        while (!sweep.complete && pages < SWEEP_PAGES_PER_RUN) {
            let result;
            if (sweep.nextPage === 1 && first) result = first;
            else {
                try { result = await this.listingPage(sweep.nextPage); }
                catch (error) {
                    if (this.batchFailure(error)) throw error;
                    console.log(`[CC LOG] PRO auction listing check stopped at page ${sweep.nextPage}: ${error.message}`);
                    sweep.complete = true;
                    break;
                }
            }
            pages++;
            this.readSweepPage(sweep, result);
        }
        if (sweep.complete) await this.finishSweep(sweep);
    }

    readSweepPage(sweep, result) {
        const items = result.auctions || [];
        for (const item of items) {
            const id = String(item.id);
            sweep.seen.add(id);
            if (sweep.lowestSeen === null || BigInt(id) < sweep.lowestSeen) sweep.lowestSeen = BigInt(id);
            if (typeof item.signature === 'string' && item.signature) sweep.signatures.set(id, item.signature);
        }
        sweep.lastPage = Math.max(1, Number(result.lastPage) || sweep.lastPage);
        sweep.nextPage++;
        const reachedBoundary = !sweep.full && (sweep.boundary === null || sweep.lowestSeen !== null && sweep.lowestSeen < sweep.boundary);
        if (!items.length || reachedBoundary || sweep.nextPage > sweep.lastPage) {
            sweep.complete = true;
            sweep.covered = true;
        } else if (sweep.nextPage > (sweep.full ? MAX_PAGES : RECENT_SWEEP_PAGE_LIMIT)) {
            sweep.complete = true;
            if (!sweep.full && !this.sweepLimitWarned) {
                this.sweepLimitWarned = true;
                console.warn(`[CC LOG] PRO auction recent listing check reached its ${RECENT_SWEEP_PAGE_LIMIT}-page limit; older recent auctions are checked by the daily full check.`);
            }
        }
    }

    async finishSweep(sweep) {
        const now = this.clock();
        // A complete sweep covered every auction above its floor; a shortened one only what it read.
        const floor = sweep.covered ? (sweep.full ? 0n : sweep.boundary) : sweep.lowestSeen;
        const flagged = await this.store.readTracked((record, id) => {
            if (ended(record.auction) || record.auction.sourceUnavailable) return undefined;
            if (!sweep.seen.has(id)) {
                return floor !== null && BigInt(id) >= floor && sweep.ceiling !== null && BigInt(id) <= sweep.ceiling ? id : undefined;
            }
            const signature = sweep.signatures.get(id);
            if (!signature) return undefined;
            this.cardSignatures.set(id, signature);
            const watched = !record.messageMissing || Object.keys(record.follow?.users || {}).length > 0;
            return watched && signature !== record.auction.listingSignature ? id : undefined;
        });
        for (const id of flagged) if (!this.sweepFlags.has(id)) this.sweepFlags.set(id, now);
        this.activeSweep = null;
        this.nextSweepAt = now + SWEEP_INTERVAL_MS;
        if (sweep.full) this.nextFullSweepAt = sweep.startedAt + FULL_SWEEP_INTERVAL_MS;
    }

    refreshInfo(record, id, now) {
        const followers = Object.keys(record.follow?.users || {}).length;
        return { id, followers, fresh: this.isFresh(record, now),
            unattended: Boolean(record.messageMissing) && !followers,
            endsAt: timeMs(record.auction.endsAt),
            unavailableSince: record.auction.sourceUnavailable ? timeMs(record.auction.unavailableSince) ?? now : null };
    }

    // The earliest rule wins: followed auctions every interval, ended countdowns shortly after
    // their end, flagged cards now, running countdowns outside the recent sweep every 10 minutes,
    // and a safety refresh for every auction (6 hours when recent, 7 days when older).
    refreshDue(info, now) {
        const safety = info.unattended || !info.fresh ? OLD_SAFETY_MS : FRESH_SAFETY_MS;
        const interval = info.unavailableSince !== null ? UNAVAILABLE_RETRY_MS : info.followers ? this.intervalMs : safety;
        if (!this.refreshBase.has(info.id)) this.refreshBase.set(info.id, now - this.random() * interval);
        const last = this.refreshedAt.get(info.id) ?? this.refreshBase.get(info.id);
        let due = this.sweepFlags.get(info.id) ?? Infinity;
        if (info.unavailableSince !== null) {
            due = Math.min(due, last + (now - info.unavailableSince < DAY_MS ? UNAVAILABLE_RETRY_MS : DAY_MS));
        } else {
            if (info.followers) due = Math.min(due, last + this.intervalMs);
            if (info.endsAt !== null && info.endsAt <= now) {
                due = Math.min(due, Math.max(info.endsAt + END_GRACE_MS,
                    last + (now - info.endsAt < HOUR_MS ? this.intervalMs : COUNTDOWN_REFRESH_MS)));
            } else if (info.endsAt !== null && !info.fresh && !info.unattended) {
                due = Math.min(due, last + COUNTDOWN_REFRESH_MS);
            }
            due = Math.min(due, last + safety);
        }
        return Math.max(due, this.itemFailures.get(`refresh ${info.id}`)?.nextAttemptAt || 0);
    }

    async refreshTracked(delivered = new Set(), { onlyDue = false } = {}) {
        const now = this.clock();
        const infos = await this.store.readTracked((record, id) => ended(record.auction) ? undefined : this.refreshInfo(record, id, now));
        const candidates = new Set(infos.map(info => info.id));
        for (const map of [this.refreshedAt, this.refreshBase, this.sweepFlags, this.cardSignatures]) {
            for (const id of map.keys()) if (!candidates.has(id)) map.delete(id);
        }
        if (!infos.length) {
            this.nextRefreshAttemptAt = Infinity;
            return;
        }
        // Direct runs check the least recently refreshed auctions first, as before; deleted posts
        // without followers are only checked by the schedule, which watches for their end.
        const queue = infos.filter(info => onlyDue || !info.unattended)
            .map(info => ({ info, due: onlyDue ? this.refreshDue(info, now) : this.refreshedAt.get(info.id) ?? -Infinity }))
            .sort((a, b) => a.due === b.due ? 0 : a.due - b.due);
        const eligible = new Set();
        let attempted = 0;
        for (const { info, due } of queue) {
            if (attempted >= this.refreshBatchSize) break;
            this.checkRunning();
            const key = `refresh ${info.id}`;
            if (delivered.has(info.id) || !this.itemReady(key) || onlyDue && due > this.clock()) continue;
            attempted++;
            this.refreshedAt.set(info.id, this.clock());
            if (await this.refreshAuction(info.id, key)) eligible.add(info.id);
        }
        const later = this.clock();
        this.nextRefreshAttemptAt = infos.reduce((next, info) => Math.min(next, this.refreshDue(info, later)), Infinity);
        await this.followService?.drain(eligible);
    }

    // Returns whether the refreshed auction is active, so queued bid DMs can be delivered.
    async refreshAuction(id, key) {
        const record = await this.store.getAuctionRecord(id);
        if (!record || ended(record.auction)) return false;
        let auction;
        try {
            auction = { ...await this.fetchAuction(id) };
            this.checkRunning();
            if (!auction.auctionDuration && record.auction.auctionDuration) {
                auction.auctionDuration = record.auction.auctionDuration;
            }
            const signature = this.cardSignatures.get(id) ?? record.auction.listingSignature;
            if (signature) auction.listingSignature = signature;
        } catch (error) {
            if (this.batchFailure(error)) throw error;
            if ([404, 410].includes(Number(error.status || error.statusCode))) {
                await this.followService?.pause(id);
                if (!record.auction.sourceUnavailable) {
                    const unavailable = { ...record.auction, status: 'Unavailable', sourceUnavailable: true, endsAt: null, timeLeft: null,
                        unavailableSince: new Date(this.clock()).toISOString() };
                    if (!record.messageMissing) {
                        try { await this.notifier.edit(record.messageId, unavailable); }
                        catch (editError) {
                            if (editError.auctionStorage || editError.code === 'AUCTION_STORE_CONFLICT' || this.batchFailure(editError)) throw editError;
                            if (unknownMessage(editError)) await this.markMessageMissing(id, record, key);
                            else {
                                this.itemFailed(key, editError);
                                return false;
                            }
                        }
                    }
                    await this.store.update(data => { if (data.tracked[id]) data.tracked[id].auction = unavailable; });
                    this.sweepFlags.delete(id);
                    const updated = await this.store.getAuctionRecord(id);
                    if (updated?.messageMissing && !Object.keys(updated.follow?.users || {}).length) {
                        this.itemFailures.delete(key);
                        return false;
                    }
                }
                this.itemFailed(key, error, { sourceUnavailable: true });
                return false;
            }
            this.itemFailed(key, error);
            return false;
        }
        await this.followService?.observe(id, auction);
        this.sweepFlags.delete(id);
        const observedActive = active(auction);
        if (record.messageMissing) {
            await this.store.update(data => { if (data.tracked[id]) data.tracked[id].auction = auction; });
            this.itemRestored(key);
            return observedActive;
        }
        if (JSON.stringify(withoutSignature(auction)) === JSON.stringify(withoutSignature(record.auction))) {
            if (auction.listingSignature !== record.auction.listingSignature) {
                await this.store.update(data => { if (data.tracked[id]) data.tracked[id].auction.listingSignature = auction.listingSignature; });
            }
            this.itemRestored(key);
            return observedActive;
        }
        try {
            await this.notifier.edit(record.messageId, auction);
        } catch (error) {
            if (this.batchFailure(error)) throw error;
            if (unknownMessage(error)) {
                await this.markMessageMissing(id, record, key);
                return observedActive;
            }
            this.itemFailed(key, error);
            return observedActive;
        }
        await this.store.update(data => { if (data.tracked[id]) data.tracked[id].auction = auction; });
        this.itemRestored(key);
        return observedActive;
    }
}

module.exports = { AuctionMonitor, ended };
