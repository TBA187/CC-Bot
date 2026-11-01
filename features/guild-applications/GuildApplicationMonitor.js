'use strict';

// Checks the PRO forum for new posts, records how each one was classified, and sends the matching Discord alert.
const crypto = require('crypto');
const { runtimeActivity } = require('../../utils/runtimeActivity.js');
const { shutdownError } = require('../../utils/abortable.js');
const { uniqueForumPosts } = require('../../utils/forumPagination.js');
const { forumRetryDelay } = require('../../utils/forumRetry.js');
const {
    CLASSIFICATIONS,
    MAX_BACKOFF_MS,
    MONITOR_INTERVAL_MS,
    TOPIC_ID,
    TOPIC_URL
} = require('./constants.js');
const { ForumRequestError } = require('./forum/ProForumClient.js');
const { prioritizeImagesFromOcr } = require('./parsing/GuildApplicationOcr.js');
const { normalizeUserKey } = require('./storage/GuildApplicationStore.js');

const HOUR_MS = 60 * 60 * 1000;

function comparePosts(a, b) {
    const aTime = Date.parse(a.postedAt || '') || 0;
    const bTime = Date.parse(b.postedAt || '') || 0;
    if (aTime !== bTime) return aTime - bTime;
    return Number(a.postId) - Number(b.postId);
}

function applicationKey(post) {
    return normalizeUserKey(post.forumUserId, post.forumUsername || post.profileSlug);
}

function cooldownHours(value) {
    const hours = Number(value);
    return Number.isInteger(hours) && hours > 0 ? hours : 0;
}

function latestPostId(posts, fallback = null) {
    return posts.reduce((latest, post) => (
        Number(post.postId) > Number(latest || 0) ? String(post.postId) : latest
    ), fallback);
}

function postNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function topicIdFromUrl(url) {
    return String(url || '').match(/\/topic\/(\d+)/i)?.[1] || TOPIC_ID;
}

class GuildApplicationMonitor {
    constructor(options = {}) {
        this.client = options.client;
        this.activity = options.activity || runtimeActivity;
        this.forum = options.forumClient;
        this.parser = options.parser;
        this.ocr = options.ocr;
        this.store = options.store;
        this.notifier = options.notifier;
        this.nonApplicationNotifier = options.nonApplicationNotifier || null;
        this.voteReminder = options.voteReminder || null;
        this.staffFilter = options.staffFilter || null;
        this.topicUrl = options.topicUrl || this.forum?.topicUrl || TOPIC_URL;
        this.topicId = topicIdFromUrl(this.topicUrl);
        this.reapplicationCooldownHours = cooldownHours(options.reapplicationCooldownHours);
        this.reapplicationCooldownMs = this.reapplicationCooldownHours * HOUR_MS;
        this.clock = options.clock || (() => new Date());
        this.intervalMs = options.intervalMs || MONITOR_INTERVAL_MS;
        this.interval = null;
        this.running = false;
        this.started = false;
        this.stopped = false;
        this.forumUnavailable = false;
        this.failureCount = 0;
        this.nextAttemptAt = 0;
        this.cleanedTemplateImageUrls = new Set();
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        try {
            await this.store.initialize();
            if (this.stopped) return;
            this.store.startSyncLoop();
            await this.voteReminder?.start();
            if (this.stopped) return;
            await this.runOnce();
            if (this.stopped) return;
            this.interval = setInterval(() => {
                this.runOnce().catch(error => console.error('[CC LOG] Guild Application monitor failed:', error));
            }, this.intervalMs);
            this.interval.unref?.();
        } catch (error) {
            this.started = false;
            throw error;
        }
    }

    async stop() {
        this.stopped = true;
        this.started = false;
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.voteReminder?.stop();
        this.store.stopSyncLoop();
        await this.ocr.close();
    }

    checkRunning() {
        if (this.stopped) throw shutdownError();
    }

    forumRestored() {
        if (this.forumUnavailable) console.log('[CC LOG] PRO Forum application monitor connection restored.');
        this.forumUnavailable = false;
        this.failureCount = 0;
        this.nextAttemptAt = 0;
    }

    forumFailed(error) {
        this.failureCount++;
        const delay = forumRetryDelay(this.intervalMs, this.failureCount, MAX_BACKOFF_MS, error.retryAfterMs);
        this.nextAttemptAt = Date.now() + delay;
        if (!this.forumUnavailable) {
            console.warn(`[CC LOG] PRO Forum application monitor is unavailable. Retrying in ${Math.ceil(delay / 60000)} minute(s):`, error.message);
        }
        this.forumUnavailable = true;
    }

    async runOnce() {
        if (this.stopped || this.running || Date.now() < this.nextAttemptAt) return false;
        this.running = true;
        const finishActivity = this.activity.begin('Guild application monitoring');
        try {
            this.staffFilter?.beginScan();
            const initialized = await this.store.isInitialized();
            this.checkRunning();
            if (!initialized) await this.buildSilentBaseline();
            else {
                await this.retryPendingNotifications();
                this.checkRunning();
                await this.scanForNewPosts();
            }
            this.checkRunning();
            this.forumRestored();
            return true;
        } catch (error) {
            if (error.code === 'BOT_SHUTTING_DOWN') return false;
            if (error instanceof ForumRequestError) this.forumFailed(error);
            else if (error.guildApplicationStorage) this.store.noteLocalStorageFailure(error);
            else console.error('[CC LOG] Guild Application monitor cycle failed:', error);
            return false;
        } finally {
            this.running = false;
            finishActivity();
        }
    }

    async readablePage(pageNumber, firstPage = null) {
        this.checkRunning();
        const page = pageNumber === 1 && firstPage ? firstPage : await this.forum.fetchPage(pageNumber);
        this.checkRunning();
        if (!(page.posts || []).length) {
            throw new ForumRequestError(`PRO Forum page ${pageNumber} did not contain any readable posts.`);
        }
        return page;
    }

    async fetchPages(pageNumbers, firstPage = null, boundaryPostId = null) {
        const requested = [...new Set(pageNumbers)].sort((a, b) => a - b);
        const pages = new Map();
        for (const pageNumber of requested) {
            pages.set(pageNumber, await this.readablePage(pageNumber, firstPage));
        }

        // If the forum changes its page size, the saved post can move several pages backward.
        const boundary = postNumber(boundaryPostId);
        let earliestPage = requested[0] || 1;
        const boundaryFound = () => [...pages.values()].some(page =>
            (page.posts || []).some(post => postNumber(post.postId) <= boundary)
        );
        while (boundary > 0 && earliestPage > 1 && !boundaryFound()) {
            earliestPage--;
            pages.set(earliestPage, await this.readablePage(earliestPage, firstPage));
        }

        return [...pages.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, page]) => page);
    }

    async buildSilentBaseline() {
        this.checkRunning();
        const firstPage = await this.forum.fetchPage(1);
        this.checkRunning();
        await this.removeStoredTemplateImages();
        const lastPage = Math.max(1, Number(firstPage.lastPage) || 1);
        const pages = await this.fetchPages(Array.from({ length: lastPage }, (_, index) => index + 1), firstPage);
        const posts = uniqueForumPosts(pages).sort(comparePosts);
        const latestApplications = {};
        const records = [];

        // A fresh install learns the whole topic first; historical posts must never ping officers.
        for (const post of posts) {
            this.checkRunning();
            records.push(await this.createRecord(post, {
                baseline: true,
                latestApplications,
                skipDatabaseHistoryLookup: true
            }));
        }

        this.checkRunning();
        if (records.length) await this.store.saveRecords(records);
        await this.store.markInitialized({
            lastPage,
            lastPostId: latestPostId(posts),
            lastScanAt: this.clock().toISOString(),
            latestApplications
        });
        console.log(`[CC LOG] Guild Application baseline stored ${records.length} forum post(s) without notifications.`);
    }

    pagesToInspect(lastPage, checkpoint) {
        const previousLastPage = Math.max(1, Number(checkpoint.lastPage || 1));
        const pages = new Set([
            Math.max(1, lastPage - 1),
            lastPage,
            Math.min(previousLastPage, lastPage)
        ]);
        if (lastPage > previousLastPage) {
            for (let page = previousLastPage; page <= lastPage; page++) pages.add(page);
        }
        return [...pages].sort((a, b) => a - b);
    }

    async scanForNewPosts() {
        this.checkRunning();
        const checkpoint = this.store.getCheckpoint();
        const firstPage = await this.forum.fetchPage(1);
        this.checkRunning();
        await this.removeStoredTemplateImages();
        const lastPage = Math.max(1, Number(firstPage.lastPage) || 1);
        const pages = await this.fetchPages(
            this.pagesToInspect(lastPage, checkpoint),
            firstPage,
            checkpoint.lastPostId
        );
        const posts = uniqueForumPosts(pages).sort(comparePosts);
        const knownIds = await this.store.knownPostIds(posts.map(post => post.postId));
        const unseen = posts.filter(post => !knownIds.has(String(post.postId)));
        const latestApplications = { ...(checkpoint.latestApplications || {}) };

        for (const post of unseen) {
            this.checkRunning();
            const record = await this.createRecord(post, { baseline: false, latestApplications });
            this.checkRunning();
            const saved = await this.store.saveRecord(record);
            if (saved.classification === CLASSIFICATIONS.APPLICATION) {
                await this.notifyStoredApplication(saved, post);
            } else if (saved.classification === CLASSIFICATIONS.NON_APPLICATION) {
                await this.notifyStoredNonApplication(saved);
            }
        }

        this.checkRunning();
        await this.store.updateCheckpoint({
            lastPage,
            lastPostId: latestPostId(posts, checkpoint.lastPostId),
            lastScanAt: this.clock().toISOString(),
            latestApplications
        });
    }

    async acceptedApplicationWithinWindow(post, latestApplications, skipDatabaseHistoryLookup) {
        if (!this.reapplicationCooldownMs) return null;
        const key = applicationKey(post);
        if (!key) return null;
        let latest = latestApplications[key] || null;
        if (!latest && !skipDatabaseHistoryLookup) latest = await this.store.latestApplicationFor(post);
        if (!latest?.postedAt) return null;

        const currentMs = Date.parse(post.postedAt || '') || this.clock().getTime();
        const previousMs = Date.parse(latest.postedAt);
        if (Number.isNaN(previousMs)) return null;
        return currentMs - previousMs < this.reapplicationCooldownMs ? latest : null;
    }

    rememberAcceptedApplication(post, latestApplications) {
        const key = applicationKey(post);
        if (!key) return;
        latestApplications[key] = {
            postId: String(post.postId),
            postedAt: post.postedAt || this.clock().toISOString(),
            forumUsername: post.forumUsername || null
        };
    }

    async createRecord(post, options) {
        this.checkRunning();
        const parsed = this.parser.parse(post);
        const staff = await this.staffFilter?.matchAuthor(post.forumUsername);
        this.checkRunning();
        if (staff) {
            parsed.classification = CLASSIFICATIONS.IGNORED_AUTHOR;
            parsed.confidence = 1;
            parsed.reasons.push(`discord_staff_author:${staff.id}`);
        }
        let downloadedForOcr = [];
        let ocrResult = { ign: parsed.fields.ign, source: parsed.ignSource, confidence: parsed.ignConfidence, output: null };

        if (parsed.classification === CLASSIFICATIONS.APPLICATION && !parsed.fields.ign && post.imageUrls.length) {
            // Read images only when the application text does not identify the player.
            downloadedForOcr = await this.forum.downloadPostImages(post, 2);
            this.checkRunning();
            ocrResult = await this.ocr.resolveIgn(post, parsed, downloadedForOcr);
        }

        let classification = parsed.classification;
        const parserReasons = [...parsed.reasons];
        if (classification === CLASSIFICATIONS.APPLICATION) {
            const recent = await this.acceptedApplicationWithinWindow(
                post,
                options.latestApplications,
                options.skipDatabaseHistoryLookup
            );
            if (recent) {
                classification = CLASSIFICATIONS.DUPLICATE_USER;
                parserReasons.push(`previous_application:${recent.postId}`);
            } else {
                this.rememberAcceptedApplication(post, options.latestApplications);
            }
        }

        const structuredFieldCount = [
            ocrResult.ign || parsed.fields.ign,
            parsed.fields.age,
            parsed.fields.country,
            parsed.fields.interests
        ].filter(Boolean).length;
        const orderedImageUrls = prioritizeImagesFromOcr(post.imageUrls, ocrResult.output);

        return {
            postId: String(post.postId),
            topicId: this.topicId,
            topicUrl: this.topicUrl,
            postUrl: post.postUrl,
            pageNumber: post.page,
            forumUserId: post.forumUserId,
            forumUsername: post.forumUsername,
            forumProfileUrl: post.profileUrl,
            forumProfileSlug: post.profileSlug,
            postedAt: post.postedAt || this.clock().toISOString(),
            observedAt: this.clock().toISOString(),
            contentHash: crypto.createHash('sha256').update(post.bodyText || '').digest('hex'),
            rawBodyText: post.bodyText || '',
            imageUrls: orderedImageUrls,
            classification,
            classificationConfidence: parsed.confidence,
            parserReasons: [...parserReasons, `structured_fields:${structuredFieldCount}`],
            ocrOutput: ocrResult.output,
            ign: ocrResult.ign || parsed.fields.ign,
            ignSource: ocrResult.source || parsed.ignSource,
            ignConfidence: ocrResult.confidence || parsed.ignConfidence,
            age: parsed.fields.age,
            country: parsed.fields.country,
            interests: parsed.fields.interests,
            extraInformation: parsed.fields.extraInformation,
            isBaseline: options.baseline,
            notificationStatus: options.baseline
                ? 'not_required'
                : classification === CLASSIFICATIONS.APPLICATION
                    ? 'pending'
                    : classification === CLASSIFICATIONS.NON_APPLICATION
                        ? 'non_application_alert_pending'
                        : 'not_required',
            officerMessageId: null,
            officerMessageUrl: null,
            pollMessageId: null,
            pollMessageUrl: null,
            pollCreatedAt: null,
            voteReminder12hCheckedAt: null,
            voteReminder12hMessageId: null,
            voteReminder18hCheckedAt: null,
            voteReminder18hMessageId: null,
            lastError: null,
            notifiedAt: null
        };
    }

    postFromRecord(record) {
        return {
            postId: record.postId,
            page: record.pageNumber,
            postUrl: record.postUrl,
            forumUserId: record.forumUserId,
            forumUsername: record.forumUsername,
            profileUrl: record.forumProfileUrl,
            profileSlug: record.forumProfileSlug,
            postedAt: record.postedAt,
            bodyText: record.rawBodyText,
            imageUrls: record.imageUrls || []
        };
    }

    structuredFieldCount(record) {
        return [record.ign, record.age, record.country, record.interests].filter(Boolean).length;
    }

    async removeStoredTemplateImages() {
        const urls = this.forum.getTemplateImageUrls?.() || [];
        const newUrls = urls.filter(url => !this.cleanedTemplateImageUrls.has(url));
        if (!newUrls.length) return;
        await this.store.removeStoredImageUrls?.(newUrls);
        newUrls.forEach(url => this.cleanedTemplateImageUrls.add(url));
    }

    async suppressStaffNotification(record) {
        const staff = await this.staffFilter?.matchAuthor(record.forumUsername);
        if (!staff) return false;
        record.classification = CLASSIFICATIONS.IGNORED_AUTHOR;
        record.notificationStatus = 'not_required';
        record.lastError = null;
        const reason = `discord_staff_author:${staff.id}`;
        record.parserReasons = [...new Set([...(record.parserReasons || []), reason])];
        await this.store.saveRecord(record);
        return true;
    }

    async notifyStoredApplication(record, originalPost = null) {
        this.checkRunning();
        if (await this.suppressStaffNotification(record)) return record;
        this.checkRunning();
        const post = originalPost || this.postFromRecord(record);
        const downloadedImages = await this.forum.downloadPostImages(post);
        this.checkRunning();

        try {
            const updated = await this.notifier.notify(record, {
                downloadedImages,
                useRawApplicationFallback: this.structuredFieldCount(record) < 2,
                // Save the first Discord ID before creating the immutable poll so retries cannot duplicate the alert.
                onOfficerMessage: async partialRecord => {
                    await this.store.saveRecord(partialRecord);
                },
                onPollMessage: async partialRecord => {
                    await this.store.saveRecord(partialRecord);
                }
            });
            return this.store.saveRecord(updated);
        } catch (error) {
            record.notificationStatus = 'error';
            record.lastError = error.message;
            await this.store.saveRecord(record);
            console.error(`[CC LOG] Guild Application notification ${record.postId} failed:`, error);
            return record;
        }
    }

    async notifyStoredNonApplication(record) {
        this.checkRunning();
        if (await this.suppressStaffNotification(record)) return record;
        this.checkRunning();
        if (!this.nonApplicationNotifier) return record;
        try {
            const { record: updated } = await this.nonApplicationNotifier.notify(record);
            return this.store.saveRecord(updated);
        } catch (error) {
            record.notificationStatus = 'non_application_alert_error';
            record.lastError = error.message;
            await this.store.saveRecord(record);
            console.error(`[CC LOG] Guild Application non-application alert ${record.postId} failed:`, error);
            return record;
        }
    }

    async retryPendingNotifications() {
        this.checkRunning();
        const pending = await this.store.pendingNotifications();
        for (const record of pending) await this.notifyStoredApplication(record);
        this.checkRunning();
        const nonApplications = await this.store.pendingNonApplicationAlerts();
        for (const record of nonApplications) await this.notifyStoredNonApplication(record);
    }
}

module.exports = {
    GuildApplicationMonitor,
    applicationKey,
    comparePosts,
    latestPostId,
    postNumber,
    topicIdFromUrl
};
