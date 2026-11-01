'use strict';

// Checks both shop topics and sends the owner a DM for each new customer message.
const {
    IGNORED_FORUM_USERNAME,
    MAX_BACKOFF_MS,
    MONITOR_INTERVAL_MS
} = require('./constants.js');
const { TbaForumRequestError } = require('./TbaForumShopClient.js');
const { runtimeActivity } = require('../../utils/runtimeActivity.js');
const { shutdownError } = require('../../utils/abortable.js');
const { uniqueForumPosts } = require('../../utils/forumPagination.js');
const { forumRetryDelay } = require('../../utils/forumRetry.js');

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function postNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function uniquePosts(pages) {
    return uniqueForumPosts(pages).sort((a, b) => postNumber(a.postId) - postNumber(b.postId));
}

class TbaForumShopMonitor {
    constructor(options = {}) {
        this.shops = options.shops || [];
        this.activity = options.activity || runtimeActivity;
        this.store = options.store;
        this.notifier = options.notifier;
        this.enabled = Number(options.enabled) === 1;
        this.ignoredUsername = String(options.ignoredUsername || IGNORED_FORUM_USERNAME).trim().toLowerCase();
        this.intervalMs = options.intervalMs || MONITOR_INTERVAL_MS;
        this.maxBackoffMs = options.maxBackoffMs || MAX_BACKOFF_MS;
        this.clock = options.clock || (() => Date.now());
        this.timers = new Map();
        this.shopStates = new Map();
        this.started = false;
        this.stopped = false;
    }

    stateFor(shop) {
        if (!this.shopStates.has(shop.key)) {
            this.shopStates.set(shop.key, {
                failureCount: 0,
                forumUnavailable: false,
                nextAttemptAt: 0,
                running: false
            });
        }
        return this.shopStates.get(shop.key);
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        try {
            await this.store.initialize(this.shops);
            if (this.stopped) return;
            if (!this.enabled) return;
            if (this.shops.length !== 2) throw new Error('Both TBA PRO Forum shop URLs must be configured.');

            for (const shop of this.shops) {
                this.scheduleShop(shop, Math.max(0, Number(shop.startDelayMs) || 0));
            }
        } catch (error) {
            this.started = false;
            throw error;
        }
    }

    stop() {
        this.stopped = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.started = false;
    }

    checkRunning() {
        if (this.stopped) throw shutdownError();
    }

    scheduleShop(shop, delayMs) {
        if (this.stopped) return;
        const existing = this.timers.get(shop.key);
        if (existing) clearTimeout(existing);

        // Longer waits are checked again when this timer expires; Node overflows them to 1ms.
        const timer = setTimeout(async () => {
            this.timers.delete(shop.key);
            if (!this.started) return;

            await this.runShopOnce(shop);
            if (!this.started) return;

            const state = this.stateFor(shop);
            const retryDelay = Math.max(0, state.nextAttemptAt - this.clock());
            this.scheduleShop(shop, retryDelay || this.intervalMs);
        }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
        timer.unref?.();
        this.timers.set(shop.key, timer);
    }

    forumRestored(shop, state) {
        if (state.forumUnavailable) console.log(`[CC LOG] ${shop.name} monitor connection restored.`);
        state.forumUnavailable = false;
        state.failureCount = 0;
        state.nextAttemptAt = 0;
    }

    forumFailed(shop, state, error) {
        state.failureCount++;
        const delay = forumRetryDelay(this.intervalMs, state.failureCount, this.maxBackoffMs, error.retryAfterMs);
        state.nextAttemptAt = this.clock() + delay;
        if (!state.forumUnavailable) {
            console.warn(`[CC LOG] ${shop.name} monitor is unavailable. Retrying in ${Math.ceil(delay / 60000)} minute(s):`, error.message);
        }
        state.forumUnavailable = true;
    }

    async runShopOnce(shop) {
        const state = this.stateFor(shop);
        if (this.stopped || state.running || this.clock() < state.nextAttemptAt) return false;

        state.running = true;
        const finishActivity = this.activity.begin(`${shop.name} monitoring`);
        try {
            await this.scanShop(shop);
            this.checkRunning();
            this.forumRestored(shop, state);
            return true;
        } catch (error) {
            if (error.code === 'BOT_SHUTTING_DOWN') return false;
            if (error instanceof TbaForumRequestError) this.forumFailed(shop, state, error);
            else console.error(`[CC LOG] ${shop.name} monitor failed:`, error);
            return false;
        } finally {
            state.running = false;
            finishActivity();
        }
    }

    async runOnce() {
        if (!this.enabled) return false;
        const results = [];
        for (const shop of this.shops) results.push(await this.runShopOnce(shop));
        return results.every(Boolean);
    }

    async readablePage(shop, firstPage, page) {
        this.checkRunning();
        const result = page === 1 ? firstPage : await shop.forumClient.fetchPage(page);
        this.checkRunning();
        if (!(result.posts || []).length) {
            throw new TbaForumRequestError(`${shop.name} page ${page} did not contain any readable forum posts.`);
        }
        return result;
    }

    async fetchPages(shop, firstPage, startPage, lastPage, lastSeenPostId) {
        const pages = new Map();
        for (let page = startPage; page <= lastPage; page++) {
            pages.set(page, await this.readablePage(shop, firstPage, page));
        }

        // Page sizes can change. Walk backward until the saved post boundary is visible again.
        const boundary = postNumber(lastSeenPostId);
        let earliestPage = startPage;
        const boundaryFound = () => [...pages.values()].some(result =>
            (result.posts || []).some(post => postNumber(post.postId) <= boundary)
        );
        while (boundary > 0 && earliestPage > 1 && !boundaryFound()) {
            earliestPage--;
            pages.set(earliestPage, await this.readablePage(shop, firstPage, earliestPage));
        }

        return [...pages.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, result]) => result);
    }

    async setBaseline(shop, firstPage, lastPage) {
        this.checkRunning();
        const pages = [firstPage];
        if (lastPage > 1) {
            const finalPage = await shop.forumClient.fetchPage(lastPage);
            this.checkRunning();
            if (!(finalPage.posts || []).length) {
                throw new TbaForumRequestError(`The final page of ${shop.name} did not contain any readable forum posts.`);
            }
            pages.push(finalPage);
        }
        const latest = uniquePosts(pages).at(-1);
        if (!latest) throw new TbaForumRequestError(`No forum posts were found while baselining ${shop.name}.`);
        await this.store.updateShop(shop.key, {
            initialized: true,
            lastSeenPostId: latest?.postId || null,
            lastPage
        });
        console.log(`[CC LOG] ${shop.name} baseline set at forum post ${latest?.postId || 'none'}.`);
    }

    async scanShop(shop) {
        this.checkRunning();
        const state = await this.store.getShop(shop.key);
        this.checkRunning();
        const firstPage = await shop.forumClient.fetchPage(1);
        this.checkRunning();
        const lastPage = Math.max(1, Number(firstPage.lastPage) || 1);

        if (!state?.initialized || state.topicUrl !== shop.topicUrl) {
            await this.setBaseline(shop, firstPage, lastPage);
            return;
        }

        const startPage = Math.max(1, Math.min(Number(state.lastPage) || 1, lastPage));
        const pages = await this.fetchPages(shop, firstPage, startPage, lastPage, state.lastSeenPostId);
        const unseen = uniquePosts(pages).filter(post => postNumber(post.postId) > postNumber(state.lastSeenPostId));

        for (const post of unseen) {
            this.checkRunning();
            if (String(post.forumUsername || '').trim().toLowerCase() !== this.ignoredUsername) {
                const downloadedImages = await shop.forumClient.downloadPostImages(post);
                this.checkRunning();
                await this.notifier.notify(shop, post, downloadedImages);
            }
            // A delivery already in flight must keep its checkpoint even if stop() was called.
            await this.store.updateShop(shop.key, {
                lastSeenPostId: post.postId,
                lastPage
            });
        }

        if (!unseen.length && Number(state.lastPage) !== lastPage) {
            await this.store.updateShop(shop.key, { lastPage });
        }
    }
}

module.exports = {
    TbaForumShopMonitor,
    postNumber,
    uniquePosts
};
