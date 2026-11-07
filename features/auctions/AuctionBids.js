// Shares bid identity, source times and burst grouping between delivery and display.
'use strict';

const { createHash } = require('node:crypto');

function bidKey(bid) {
    return createHash('sha256').update(JSON.stringify([
        bid.bidder?.url || String(bid.bidder?.name || '').toLowerCase(),
        String(bid.amount || '').replace(/[.,\s]/g, ''), bid.timestamp || bid.time || '',
        (bid.labels || []).some(label => /^price offer$/i.test(label)) ? 'offer' : 'bid'
    ])).digest('hex');
}

function bidTimestamp(bid) {
    const forum = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?: UTC)?$/i.exec(String(bid.time || '').trim());
    const instant = forum ? Date.parse(`${forum[1]}T${forum[2]}Z`) : NaN;
    return Number.isFinite(instant) ? instant : bid.timestamp ? Date.parse(bid.timestamp) : NaN;
}

function notificationBids(job) { return job.bids || [job.bid]; }

function notificationKey(keys) {
    return keys.length === 1 ? keys[0] : createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

function burstGroups(bids, observedAt, windowMs = 90_000) {
    const groups = [];
    for (const bid of bids) {
        const timestamp = bidTimestamp(bid);
        const time = Number.isFinite(timestamp) ? timestamp : observedAt;
        const offer = (bid.labels || []).some(label => /^price offer$/i.test(label));
        const previous = groups.at(-1);
        if (previous && previous.offer === offer && Math.abs(time - previous.startedAt) <= windowMs) previous.bids.unshift(bid);
        else groups.push({ startedAt: time, offer, bids: [bid] });
    }
    return groups.map(group => group.bids);
}

module.exports = { bidKey, bidTimestamp, notificationBids, notificationKey, burstGroups };
