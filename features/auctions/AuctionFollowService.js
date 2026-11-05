// Manages auction subscriptions and durable bid notification delivery.
'use strict';

const { createHash } = require('node:crypto');
const { active, ended } = require('./AuctionStatus.js');
const { forumRetryDelay } = require('../../utils/forumRetry.js');

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^\d+$/.test(value);
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function bidKey(bid) {
    return createHash('sha256').update(JSON.stringify([
        bid.bidder?.url || String(bid.bidder?.name || '').toLowerCase(),
        String(bid.amount || '').replace(/[.,\s]/g, ''), bid.timestamp || bid.time || '',
        (bid.labels || []).some(label => /^price offer$/i.test(label)) ? 'offer' : 'bid'
    ])).digest('hex');
}

function validFollowState(value, auctionId) {
    return object(value) && Array.isArray(value.seenBids) && value.seenBids.every(validKey)
        && (value.currentAuction === undefined || object(value.currentAuction) && value.currentAuction.id === auctionId)
        && object(value.users) && Object.keys(value.users).length > 0
        && Object.entries(value.users).every(([id, user]) => validId(id) && object(user) && validDate(user.followedAt))
        && object(value.pending) && Object.entries(value.pending).every(([key, job]) => validKey(key) && object(job)
            && object(job.bid) && object(job.bid.bidder) && typeof job.bid.bidder.name === 'string' && typeof job.bid.amount === 'string'
            && key === bidKey(job.bid) && object(job.auction) && job.auction.id === auctionId
            && validDate(job.queuedAt) && Array.isArray(job.recipients) && job.recipients.every(id => validId(id) && Object.hasOwn(value.users, id)));
}

function snapshot(auction) {
    const fields = ['id', 'url', 'title', 'status', 'server', 'currentOffer', 'highestBidder', 'minimumBid', 'endsAt', 'timeLeft', 'imageUrls', 'sourceUnavailable'];
    return Object.fromEntries(fields.filter(key => auction[key] !== undefined).map(key => [key, auction[key]]));
}

function observeRecord(record, auction, now) {
    if (!record.follow) return;
    if (ended(auction)) { delete record.follow; return; }
    record.follow.currentAuction = snapshot(auction);
    if (!active(auction)) return;
    const seen = new Set(record.follow.seenBids);
    // Forum history is newest first; notifications retain the order bids were made.
    for (const bid of [...(auction.bids || [])].reverse()) {
        const key = bidKey(bid);
        if (bid.invalid) delete record.follow.pending[key];
        if (seen.has(key)) continue;
        seen.add(key);
        const recipients = Object.keys(record.follow.users);
        if (!bid.invalid && recipients.length) {
            record.follow.pending[key] = { bid, auction: snapshot(auction), recipients, queuedAt: new Date(now).toISOString() };
        }
    }
    record.follow.seenBids = [...seen];
}

class AuctionFollowService {
    constructor({ store, fetchAuction, notifier, checkRunning = () => {}, clock = () => Date.now(), batchSize = 20 }) {
        this.store = store;
        this.fetchAuction = fetchAuction;
        this.notifier = notifier;
        this.checkRunning = checkRunning;
        this.clock = clock;
        this.batchSize = batchSize;
        this.failures = new Map();
    }

    async follow(id, userId, messageId) {
        id = String(id); userId = String(userId);
        if (!validId(id) || !validId(userId)) throw new Error('Invalid auction or subscriber.');
        this.checkRunning();
        const saved = await this.store.getAuctionRecord(id);
        if (!saved || saved.messageMissing || String(saved.messageId) !== String(messageId)) return { unavailable: true };
        if (ended(saved.auction)) return { ended: true, auction: saved.auction };
        const auction = await this.fetchAuction(id);
        this.checkRunning();
        let result;
        await this.store.update(data => {
            this.checkRunning();
            const record = data.tracked[id];
            if (!record || record.messageMissing || String(record.messageId) !== String(messageId)) { result = { unavailable: true }; return; }
            if (ended(record.auction) || ended(auction)) { delete record.follow; result = { ended: true, auction }; return; }
            if (!active(auction)) { result = { unavailable: true }; return; }
            record.follow ||= { seenBids: (record.auction.bids || []).map(bidKey), users: {}, pending: {} };
            // Observe before adding a new follower, so existing bids only reach
            // members who were already subscribed when those bids were detected.
            observeRecord(record, auction, this.clock());
            const alreadyFollowing = Object.hasOwn(record.follow.users, userId);
            record.follow.users[userId] ||= { followedAt: new Date(this.clock()).toISOString() };
            result = { alreadyFollowing, auction };
        });
        if (result.ended) this.clearFailures(id);
        return result;
    }

    async unfollow(id, userId) {
        let removed = false;
        await this.store.update(data => {
            const record = data.tracked[String(id)];
            if (!record?.follow?.users[String(userId)]) return;
            removed = true;
            delete record.follow.users[String(userId)];
            for (const [key, job] of Object.entries(record.follow.pending)) {
                job.recipients = job.recipients.filter(id => id !== String(userId));
                if (!job.recipients.length) delete record.follow.pending[key];
            }
            if (!Object.keys(record.follow.users).length) delete record.follow;
        });
        this.clearFailures(String(id), String(userId));
        return removed;
    }

    clearFailures(id, userId) {
        for (const key of this.failures.keys()) if (key.startsWith(`${id}:`) && (!userId || key.endsWith(`:${userId}`))) this.failures.delete(key);
    }

    async observe(id, auction) {
        await this.store.update(data => {
            const record = data.tracked[String(id)];
            if (record) observeRecord(record, auction, this.clock());
        });
        if (ended(auction)) this.clearFailures(String(id));
    }

    async pause(id) {
        await this.store.update(data => {
            const follow = data.tracked[String(id)]?.follow;
            if (follow?.currentAuction) follow.currentAuction.status = 'Unavailable';
        });
    }

    async cleanupEnded() {
        const state = await this.store.update(data => {
            for (const record of Object.values(data.tracked)) if (ended(record.auction)) delete record.follow;
        });
        for (const key of this.failures.keys()) {
            const [id, bid, userId] = key.split(':');
            if (!state.tracked[id]?.follow?.pending[bid]?.recipients.includes(userId)) this.failures.delete(key);
        }
    }

    async drain(eligibleIds) {
        const state = await this.store.getState();
        let attempts = 0;
        for (const id of eligibleIds) {
            const pending = state.tracked[id]?.follow?.pending || {};
            for (const [key, job] of Object.entries(pending)) for (const userId of job.recipients) {
                if (attempts >= this.batchSize) return;
                this.checkRunning();
                const retryKey = `${id}:${key}:${userId}`;
                const failure = this.failures.get(retryKey);
                if (failure && this.clock() < failure.nextAttemptAt) continue;
                const record = await this.store.getAuctionRecord(id);
                if (!active(record?.follow?.currentAuction) || !record.follow.pending[key]?.recipients.includes(userId)) continue;
                const deadline = Date.parse(record.follow.currentAuction.endsAt || '');
                // A fresh extension can resume the queue on a later scan. Do not
                // deliver past the currently known deadline while waiting for it.
                if (Number.isFinite(deadline) && this.clock() >= deadline) continue;
                attempts++;
                try {
                    await this.notifier.sendBidUpdate(userId, key, { ...job, auction: record.follow.currentAuction,
                        auctionMessageId: record.messageMissing ? null : record.messageId });
                } catch (error) {
                    if ([50007, 10013].includes(Number(error.code || error.rawError?.code))) {
                        await this.unfollow(id, userId);
                        this.failures.delete(retryKey);
                        console.log(`[CC LOG] PRO auction ${id} follower ${userId} removed because Discord DMs are unavailable.`);
                    } else {
                        const count = (failure?.count || 0) + 1;
                        this.failures.set(retryKey, { count, nextAttemptAt: this.clock()
                            + forumRetryDelay(120_000, count, 30 * 60_000, error.retryAfterMs) });
                        if (!failure) console.warn(`[CC LOG] PRO auction ${id} bid DM to ${userId} failed; notification retained:`, error.code || error.message);
                    }
                    continue;
                }
                // Persist a completed DM even if shutdown started during delivery.
                await this.store.update(data => {
                    const follow = data.tracked[id]?.follow;
                    const saved = follow?.pending[key];
                    if (!saved) return;
                    saved.recipients = saved.recipients.filter(id => id !== userId);
                    if (!saved.recipients.length) delete follow.pending[key];
                });
                this.failures.delete(retryKey);
            }
        }
    }
}

module.exports = { AuctionFollowService, validFollowState, bidKey };
