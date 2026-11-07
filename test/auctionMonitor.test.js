// Verifies auction discovery, announcement updates, restart recovery, and shutdown.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuctionStore } = require('../features/auctions/AuctionStore.js');
const { AuctionMonitor, ended } = require('../features/auctions/AuctionMonitor.js');
const { AuctionForumRequestError } = require('../features/auctions/AuctionForumClient.js');
const { AuctionFollowService } = require('../features/auctions/AuctionFollowService.js');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-monitor-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store = new AuctionStore({ dataFile: path.join(dir, 'state.json'), storageMode: 'json' });
    const pages = new Map();
    const inactivePages = new Map([[1, []]]);
    const auctions = new Map();
    const sent = [];
    const edited = [];
    const forumClient = {
        async fetchListing(page, status = 'active') {
            const selected = status === 'inactive' ? inactivePages : pages;
            const ids = selected.get(page);
            if (!ids) throw new Error('Page unavailable');
            return { auctions: ids.map(id => ({ id, url: `https://example.test/${id}` })), lastPage: selected.size };
        },
        async fetchAuction(id) {
            if (!auctions.has(id)) throw new Error('Auction unavailable');
            return auctions.get(id);
        }
    };
    const notifier = {
        async send(auction) { sent.push(auction.id); return { id: `message-${auction.id}` }; },
        async edit(messageId, auction) { edited.push([messageId, auction]); }
    };
    const monitor = new AuctionMonitor({ store, forumClient, notifier, requestSpacingMs: 0, activity: { begin: () => () => {} } });
    return { store, pages, inactivePages, auctions, sent, edited, monitor };
}

test('baselines existing listings and discovers new listings across pages', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10', '9']);
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, []);
    f.pages.set(1, ['13', '12']);
    f.pages.set(2, ['11', '10']);
    for (const id of ['11', '12', '13']) f.auctions.set(id, { id, status: 'Active', bids: [] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11', '12', '13']);
    assert.deepEqual(Object.keys((await f.store.getState()).pending), []);
    assert.equal((await f.store.getAuctionRecord('12')).auction.id, '12');
});

test('a fresh process skips downtime listings and the previous queue before announcing new auctions', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10', '9']);
    await f.monitor.runOnce();
    await f.store.update(data => {
        data.pending['11'] = { id: '11', queuedAt: '2026-11-02T00:00:00Z' };
        data.pendingOrder = ['11'];
    });
    f.pages.set(1, ['90', '89']);
    f.pages.set(2, ['88', '87']);
    f.inactivePages.set(1, ['91', '8']);
    const restarted = new AuctionMonitor({ store: f.store, forumClient: f.monitor.forumClient,
        notifier: f.monitor.notifier, requestSpacingMs: 0, activity: { begin: () => () => {} } });
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent, []);
    const state = await f.store.getState();
    assert.equal(state.inactiveWatermark, '91');
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.pendingOrder, []);
    f.pages.set(1, ['92', '90']);
    f.auctions.set('92', { id: '92', status: 'Active' });
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent, ['92']);
});

test('a startup listing failure sends nothing and keeps the old queue until a baseline can be saved', async t => {
    const f = fixture(t);
    await f.store.update(data => { data.pending['11'] = { id: '11' }; data.pendingOrder = ['11']; });
    f.pages.set(1, ['20']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    f.inactivePages.clear();
    assert.equal(await f.monitor.runOnce(), false);
    assert.deepEqual(f.sent, []);
    assert.ok((await f.store.getState()).pending['11']);
    assert.equal(f.monitor.needsStartupBaseline, true);
    f.inactivePages.set(1, ['19']);
    f.monitor.nextAttemptAt = 0;
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, []);
    assert.deepEqual((await f.store.getState()).pending, {});
});

test('a saved startup baseline is required before any queued notification can be delivered', async t => {
    const f = fixture(t);
    f.pages.set(1, ['20']);
    await f.store.update(data => { data.pending['11'] = { id: '11' }; data.pendingOrder = ['11']; });
    const write = f.store.write.bind(f.store);
    f.store.write = () => { throw Object.assign(new Error('disk failure'), { auctionStorage: true }); };
    assert.equal(await f.monitor.runOnce(), false);
    assert.deepEqual(f.sent, []);
    assert.equal(f.monitor.needsStartupBaseline, true);
    assert.ok((await f.store.getState()).pending['11']);
    f.store.write = write;
});

test('startup retains a higher saved checkpoint when listing pages are stale', async t => {
    const f = fixture(t);
    await f.store.update(data => { data.initialized = true; data.inactiveWatermark = '50'; });
    f.pages.set(1, ['40', '39']);
    f.inactivePages.set(1, ['38']);
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal((await f.store.getState()).inactiveWatermark, '50');
    assert.deepEqual(f.sent, []);
});

test('startup refreshes already-announced auctions without reposting them', async t => {
    const f = fixture(t);
    await f.store.update(data => { data.initialized = true; data.inactiveWatermark = '10';
        data.tracked['10'] = { messageId: 'old-message', auction: { id: '10', status: 'Active' } }; });
    f.pages.set(1, ['20', '19']);
    f.auctions.set('10', { id: '10', status: 'Ended', endPrice: '500' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, []);
    assert.equal(f.edited[0][0], 'old-message');
    assert.equal((await f.store.getAuctionRecord('10')).auction.status, 'Ended');
});

test('stopping and starting the same monitor skips the new downtime backlog', async t => {
    const f = fixture(t);
    f.monitor.schedule = () => {};
    f.pages.set(1, ['10']);
    await f.monitor.start();
    await f.monitor.runOnce();
    await f.monitor.stop();
    f.pages.set(1, ['20', '19']);
    await f.monitor.start();
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, []);
    assert.equal((await f.store.getState()).inactiveWatermark, '20');
    await f.monitor.stop();
});

test('large batches are durably queued and share one delivery limit across a scan', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['18', '17', '16', '15', '14', '13', '12', '11', '10']);
    for (let id = 11; id <= 18; id++) f.auctions.set(String(id), { id: String(id), status: 'Active' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11', '12', '13', '14', '15']);
    assert.deepEqual((await f.store.getState()).pendingOrder, ['16', '17', '18']);
    f.pages.set(1, ['21', '20', '19', '18', '17', '16', '15', '14', '13', '12', '11', '10']);
    for (let id = 19; id <= 21; id++) f.auctions.set(String(id), { id: String(id), status: 'Active' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20']);
    assert.deepEqual((await f.store.getState()).pendingOrder, ['21']);
});

test('retains the checkpoint when an inactive listing page fails', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10', '9']);
    await f.monitor.runOnce();
    f.pages.set(1, ['12', '11']);
    f.inactivePages.set(1, ['13']);
    f.inactivePages.set(3, ['1']);
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal((await f.store.getState()).inactiveWatermark, '10');
    assert.deepEqual(f.sent, []);
});

test('discovers a listing that ended between scans without announcing old inactive listings', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10', '9']);
    f.inactivePages.set(1, ['8', '7']);
    await f.monitor.runOnce();
    f.pages.set(1, ['10', '9']);
    f.inactivePages.set(1, ['11', '8', '7']);
    f.auctions.set('11', { id: '11', status: 'Ended', bids: [] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11']);
    await f.monitor.runOnce();
    assert.deepEqual(f.sent, ['11']);
});

test('a disappeared tracked auction is marked unavailable and recovers when it returns', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [] });
    await f.monitor.runOnce();
    const fetchAuction = f.monitor.forumClient.fetchAuction;
    f.monitor.forumClient.fetchAuction = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };
    await f.monitor.runOnce();
    assert.equal(f.edited[0][1].status, 'Unavailable');
    assert.equal((await f.store.getAuctionRecord('11')).auction.sourceUnavailable, true);
    f.monitor.forumClient.fetchAuction = fetchAuction;
    f.monitor.itemFailures.clear();
    await f.monitor.runOnce();
    assert.equal(f.edited[1][1].status, 'Active');
    assert.equal((await f.store.getAuctionRecord('11')).auction.sourceUnavailable, undefined);
});

test('missing tracked auction pages retry quietly and unexpected later failures still warn', async t => {
    const f = fixture(t), warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    let now = Date.now();
    f.monitor.clock = () => now;
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [] });
    await f.monitor.runOnce();
    const fetchAuction = f.monitor.forumClient.fetchAuction;
    for (const status of [404, 410]) {
        f.monitor.forumClient.fetchAuction = async () => { throw new AuctionForumRequestError('page missing', { status }); };
        await f.monitor.runOnce();
        assert.equal(warnings.length, 0);
        assert.equal((await f.store.getAuctionRecord('11')).auction.sourceUnavailable, true);
        now = f.monitor.itemFailures.get('refresh 11').nextAttemptAt;
    }
    assert.equal(f.edited.length, 1);
    f.monitor.forumClient.fetchAuction = async () => { throw new Error('unexpected parsing failure'); };
    await f.monitor.runOnce();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /refresh 11 failed; retrying separately/u);
    now = f.monitor.itemFailures.get('refresh 11').nextAttemptAt;
    f.monitor.forumClient.fetchAuction = fetchAuction;
    await f.monitor.runOnce();
    assert.equal((await f.store.getAuctionRecord('11')).auction.status, 'Active');
    assert.equal(f.monitor.itemFailures.has('refresh 11'), false);
});

test('missing pending auction pages retain their queue without hiding Discord delivery errors', async t => {
    const f = fixture(t), warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    let now = Date.now();
    f.monitor.clock = () => now;
    await f.store.update(data => { data.pending['11'] = { id: '11' }; data.pendingOrder = ['11']; });
    f.monitor.forumClient.fetchAuction = async () => { throw new AuctionForumRequestError('page missing', { status: 404 }); };
    await f.monitor.deliverPending(new Set(), new Set());
    assert.equal(warnings.length, 0);
    assert.ok((await f.store.getState()).pending['11']);
    now = f.monitor.itemFailures.get('delivery 11').nextAttemptAt;
    f.monitor.forumClient.fetchAuction = async () => ({ id: '11', status: 'Active' });
    f.monitor.notifier.send = async () => { throw Object.assign(new Error('Discord channel unavailable'), { status: 404, code: 10003 }); };
    await f.monitor.deliverPending(new Set(), new Set());
    assert.equal(warnings.length, 1);
    assert.ok((await f.store.getState()).pending['11']);
});

test('auctions waiting for a retry do not consume healthy refresh slots', async t => {
    const f = fixture(t), fetched = [];
    f.monitor.refreshBatchSize = 2;
    f.monitor.clock = () => 1000;
    await f.store.update(data => {
        for (const id of ['11', '12', '13', '14', '15']) {
            data.tracked[id] = { messageId: `message-${id}`, auction: { id, status: 'Active' } };
        }
    });
    f.monitor.forumClient.fetchAuction = async id => { fetched.push(id); return { id, status: 'Active' }; };
    for (const id of ['11', '13']) f.monitor.itemFailures.set(`refresh ${id}`, { nextAttemptAt: 5000 });
    await f.monitor.refreshTracked(new Set());
    assert.deepEqual(fetched, ['12', '14']);
    await f.monitor.refreshTracked(new Set());
    assert.deepEqual(fetched, ['12', '14', '15', '12']);
    for (const id of ['12', '14', '15']) f.monitor.itemFailures.set(`refresh ${id}`, { nextAttemptAt: 5000 });
    await f.monitor.refreshTracked(new Set());
    assert.equal(fetched.length, 4);
});

test('scheduled refresh batches update a large rotation without idle gaps or repeated discovery requests', async t => {
    const f = fixture(t), timers = [], fetched = [];
    let now = 1000, listings = 0;
    f.monitor.clock = () => now;
    const listing = f.monitor.forumClient.fetchListing;
    f.monitor.forumClient.fetchListing = async (...args) => { listings++; now += 750; return listing(...args); };
    f.monitor.forumClient.fetchAuction = async id => {
        fetched.push(id); now += 750;
        return { id, status: 'Active', bids: id === '70' ? [newBid('400'), newBid('300'), newBid('200'), newBid('100')] : [] };
    };
    f.pages.set(1, ['70']);
    await f.store.update(data => {
        for (let id = 1; id <= 70; id++) data.tracked[String(id)] = {
            messageId: `message-${id}`, auction: { id: String(id), status: 'Active', bids: [] }
        };
    });
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => { timer.cancelled = true; });
    t.after(() => f.monitor.stop());
    await f.monitor.start();
    for (let batch = 0; batch < 7; batch++) {
        const timer = timers.shift();
        assert.equal(timer.delay, 0, 'due refreshes continue immediately, using the shared request pacing');
        const before = fetched.length;
        await timer.callback();
        assert.equal(fetched.length - before, 10);
    }
    assert.equal(new Set(fetched).size, 70);
    assert.equal(listings, 2, 'the active and inactive lists are each fetched once during the rotation');
    assert.equal((await f.store.getAuctionRecord('70')).auction.bids.length, 4);
    assert.equal(f.edited.at(-1)[0], 'message-70');
    assert.ok(now - 1000 < 90000, 'the simulated paced rotation finishes within one discovery interval');
    const next = timers.shift();
    assert.ok(next.delay > 0, 'healthy auctions are not polled again before their next due time');
    now += next.delay;
    await next.callback();
    assert.equal(listings, 4, 'discovery resumes when its independent deadline arrives');
    const pending = timers.at(-1);
    await f.monitor.stop();
    assert.equal(pending.cancelled, true);
    assert.equal(f.monitor.timer, null);
});

test('scheduled discovery does not immediately refetch newly announced auctions', async t => {
    const f = fixture(t), fetched = [];
    let now = 1000;
    f.monitor.clock = () => now;
    f.pages.set(1, ['10']);
    await f.monitor.runOnce({ scheduled: true });
    f.pages.set(1, ['11', '10']);
    f.monitor.forumClient.fetchAuction = async id => { fetched.push(id); return { id, status: 'Active' }; };
    now += f.monitor.intervalMs;
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(fetched, ['11']);
    assert.deepEqual(f.sent, ['11']);
    assert.equal(f.monitor.nextRefreshAttemptAt, now + f.monitor.intervalMs);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(fetched, ['11']);
});

test('the scheduler preserves server retry waits while refresh work is due', async t => {
    const f = fixture(t), timers = [];
    let now = 1000;
    f.monitor.clock = () => now;
    f.pages.set(1, ['10']);
    await f.store.update(data => { data.tracked['11'] = { messageId: 'message-11', auction: { id: '11', status: 'Active' } }; });
    f.monitor.forumClient.fetchAuction = async () => { throw new AuctionForumRequestError('rate limited', { status: 429, retryAfterMs: 300000 }); };
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    t.after(() => f.monitor.stop());
    await f.monitor.start();
    await timers.shift().callback();
    const retry = timers.shift();
    assert.equal(retry.delay, 300000);
    now += retry.delay;
    f.monitor.forumClient.fetchAuction = async id => ({ id, status: 'Active', bids: [] });
    await retry.callback();
    assert.equal(f.monitor.failureCount, 0);
    assert.equal(timers[0].delay, f.monitor.intervalMs);
});

test('a scheduled tick waits for an overlapping direct run without repeatedly scheduling immediate ticks', async t => {
    const f = fixture(t), timers = [];
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.monitor.clock = () => 1000;
    f.monitor.scan = async () => { entered.resolve(); await release.promise; };
    const direct = f.monitor.runOnce();
    await entered.promise;
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', () => {});
    t.after(() => f.monitor.stop());
    f.monitor.started = true;
    f.monitor.schedule(0);
    const tick = timers.shift().callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.length, 0);
    release.resolve();
    await direct;
    await tick;
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, f.monitor.intervalMs);
});

test('a listing created between the two page requests is not skipped by the checkpoint', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    f.inactivePages.set(1, ['8']);
    await f.monitor.runOnce();
    f.pages.set(1, ['12', '10']);
    f.inactivePages.set(1, ['14', '8']);
    f.auctions.set('12', { id: '12', status: 'Active' });
    f.auctions.set('14', { id: '14', status: 'Ended' });
    await f.monitor.runOnce();
    assert.equal((await f.store.getState()).inactiveWatermark, '12');
    f.pages.set(1, ['13', '12', '10']);
    f.auctions.set('13', { id: '13', status: 'Active' });
    await f.monitor.runOnce();
    assert.deepEqual(f.sent, ['12', '14', '13']);
});

test('changed forum ordering retains the checkpoint and queues no unverified listings', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    f.inactivePages.set(1, ['8']);
    await f.monitor.runOnce();
    f.pages.set(1, ['12', '14', '10']);
    assert.equal(await f.monitor.runOnce(), false);
    const state = await f.store.getState();
    assert.equal(state.inactiveWatermark, '10');
    assert.deepEqual(state.pending, {});
});

test('a missing Discord message does not mark the forum listing unavailable', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.auctions.set('11', { id: '11', status: 'Ended' });
    f.monitor.notifier.edit = async () => { throw Object.assign(new Error('Unknown Message'), { status: 404 }); };
    await f.monitor.runOnce();
    assert.equal((await f.store.getAuctionRecord('11')).auction.status, 'Active');
});

test('a confirmed missing Discord message stops retries across restarts without reposting', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.auctions.set('11', { id: '11', status: 'Active', bids: [{ amount: '500' }] });
    let edits = 0;
    f.monitor.notifier.edit = async () => { edits++; throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 }); };
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal((await f.store.getAuctionRecord('11')).messageMissing, true);
    assert.equal((await f.store.getAuctionRecord('11')).auction.status, 'Active');
    assert.equal(f.monitor.itemFailures.has('refresh 11'), false);
    const restarted = new AuctionMonitor({ store: f.store, forumClient: f.monitor.forumClient,
        notifier: f.monitor.notifier, requestSpacingMs: 0, activity: { begin: () => () => {} } });
    assert.equal(await restarted.runOnce(), true);
    assert.equal(edits, 1);
    assert.deepEqual(f.sent, ['11']);
});

test('a missing Discord message is handled when the forum page is also unavailable', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.monitor.forumClient.fetchAuction = async () => { throw Object.assign(new Error('forum missing'), { status: 404 }); };
    f.monitor.notifier.edit = async () => { throw Object.assign(new Error('Unknown Message'), { status: 404, rawError: { code: 10008 } }); };
    assert.equal(await f.monitor.runOnce(), true);
    const record = await f.store.getAuctionRecord('11');
    assert.equal(record.messageMissing, true);
    assert.equal(record.auction.sourceUnavailable, true);
    assert.equal(f.monitor.itemFailures.has('refresh 11'), false);
});

test('other Discord errors do not mark the message missing', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.auctions.set('11', { id: '11', status: 'Ended' });
    f.monitor.notifier.edit = async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 }); };
    await f.monitor.runOnce();
    assert.equal((await f.store.getAuctionRecord('11')).messageMissing, undefined);
    assert.equal(f.monitor.itemFailures.has('refresh 11'), true);
});

test('failure to persist a missing-message marker keeps the update retryable', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.auctions.set('11', { id: '11', status: 'Ended' });
    f.monitor.notifier.edit = async () => { throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 }); };
    const write = f.store.write.bind(f.store);
    f.store.write = () => { throw Object.assign(new Error('disk failure'), { auctionStorage: true }); };
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal((await f.store.getAuctionRecord('11')).messageMissing, undefined);
    f.store.write = write;
    f.monitor.nextAttemptAt = 0;
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal((await f.store.getAuctionRecord('11')).messageMissing, true);
});

test('a temporary forum failure does not mark a tracked auction unavailable', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    await f.monitor.runOnce();
    f.monitor.forumClient.fetchAuction = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
    await f.monitor.runOnce();
    assert.equal(f.edited.length, 0);
    assert.equal((await f.store.getAuctionRecord('11')).auction.status, 'Active');
});

test('persists pending deliveries, retries failures, and edits changed auctions', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    assert.equal(await f.monitor.runOnce(), true);
    assert.ok((await f.store.getState()).pending['11']);
    f.monitor.itemFailures.clear();
    f.auctions.set('11', { id: '11', status: 'Active', bids: [] });
    assert.equal(await f.monitor.runOnce(), true);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [{ amount: '500' }] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal(f.edited.length, 1);
    assert.deepEqual((await f.store.getAuctionRecord('11')).auction.bids, [{ amount: '500' }]);
});

test('keeps a known auction duration when the forum stops showing it after bidding starts', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active', auctionDuration: '38 hours after auction start' });
    await f.monitor.runOnce();
    f.auctions.set('11', { id: '11', status: 'Active', auctionDuration: null, bids: [{ amount: '500' }] });
    await f.monitor.runOnce();
    assert.equal((await f.store.getAuctionRecord('11')).auction.auctionDuration, '38 hours after auction start');
    f.auctions.set('11', { id: '11', status: 'Ended', auctionDuration: null });
    await f.monitor.runOnce();
    assert.equal((await f.store.getAuctionRecord('11')).auction.auctionDuration, '38 hours after auction start');
});

test('one unavailable auction retries separately without delaying newer listings', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['12', '11', '10']);
    f.auctions.set('12', { id: '12', status: 'Active' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['12']);
    assert.ok((await f.store.getState()).pending['11']);
    assert.equal(f.monitor.nextAttemptAt, 0);
    f.pages.set(1, ['13', '12', '11', '10']);
    f.auctions.set('13', { id: '13', status: 'Active' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['12', '13']);
    assert.ok((await f.store.getState()).pending['11']);
});

test('rate limiting stops the scan and applies global retry delay', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.monitor.forumClient.fetchAuction = async () => { throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 300000 }); };
    assert.equal(await f.monitor.runOnce(), false);
    assert.ok(f.monitor.nextAttemptAt >= Date.now() + 299000);
    assert.ok((await f.store.getState()).pending['11']);
});

test('forum timeouts retain queued auctions, respect backoff and report one outage followed by confirmed recovery', async t => {
    const warnings = [], logs = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    t.mock.method(console, 'log', (...args) => logs.push(args));
    const f = fixture(t);
    let now = 1000, requests = 0;
    f.monitor.clock = () => now;
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    const fetchAuction = f.monitor.forumClient.fetchAuction;
    f.monitor.forumClient.fetchAuction = async () => {
        requests++;
        throw new AuctionForumRequestError('PRO auction request timed out (auction 11).', { code: 'ETIMEDOUT' });
    };
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal(f.monitor.nextAttemptAt, now + 90000);
    assert.equal(f.monitor.forumUnavailable, true);
    assert.equal((await f.store.getState()).inactiveWatermark, '11');
    assert.deepEqual((await f.store.getState()).pendingOrder, ['11']);
    assert.deepEqual(f.sent, []);
    assert.match(warnings[0][0], /PRO auction monitor is unavailable\. Retrying in 2 minute\(s\)/);
    assert.deepEqual(warnings[0][2], { code: 'ETIMEDOUT' });
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal(requests, 1, 'no request is sent during the retry wait');
    now = f.monitor.nextAttemptAt;
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal(f.monitor.nextAttemptAt, now + 180000);
    assert.equal(warnings.length, 1, 'repeated failures do not re-announce the same outage');
    f.monitor.forumClient.fetchAuction = fetchAuction;
    f.auctions.set('11', { id: '11', status: 'Active', bids: [] });
    now = f.monitor.nextAttemptAt;
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11']);
    assert.deepEqual((await f.store.getState()).pending, {});
    assert.equal((await f.store.getAuctionRecord('11')).messageId, 'message-11');
    assert.equal(f.monitor.forumUnavailable, false);
    assert.equal(f.monitor.failureCount, 0);
    assert.equal(f.monitor.nextAttemptAt, 0);
    assert.equal(logs.filter(args => args[0] === '[CC LOG] PRO auction monitor connection restored.').length, 1);
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11'], 'recovery cannot duplicate a confirmed announcement');
});

test('a storage failure during a forum outage is still reported immediately as a monitor failure', async t => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    const f = fixture(t);
    f.monitor.scan = async () => { throw new AuctionForumRequestError('Timed out.', { code: 'ETIMEDOUT' }); };
    await f.monitor.runOnce();
    f.monitor.store.reconcile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC', auctionStorage: true }); };
    f.monitor.nextAttemptAt = 0;
    await f.monitor.runOnce();
    assert.equal(warnings.length, 2);
    assert.equal(warnings[1][0], '[CC LOG] PRO auction monitor failed; retaining pending work:');
    assert.equal(warnings[1][1], 'disk full');
});

test('non-forum network errors and invalid forum responses do not become delayed connection outages', async t => {
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    for (const error of [Object.assign(new Error('MySQL timed out'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('Discord unavailable'), { status: 503 }),
        new AuctionForumRequestError('PRO auction response was not HTML.', { code: 'UNKNOWN' })]) {
        const f = fixture(t);
        f.monitor.scan = async () => { throw error; };
        await f.monitor.runOnce();
        assert.equal(f.monitor.forumUnavailable, false);
        assert.equal(warnings.at(-1)[0], '[CC LOG] PRO auction monitor failed; retaining pending work:');
    }
});

test('persists a completed send even when shutdown happens during delivery', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    f.monitor.notifier.send = async () => { f.monitor.stop(); return { id: 'message-11' }; };
    await f.monitor.runOnce();
    const state = await f.store.getState();
    assert.equal(state.tracked['11'].messageId, 'message-11');
    assert.equal(state.pending['11'], undefined);
});

test('restart recreates the abort controller and inactive listings are terminal', async t => {
    const f = fixture(t);
    await f.monitor.start();
    f.monitor.stop();
    assert.equal(f.monitor.controller.signal.aborted, true);
    await f.monitor.start();
    assert.equal(f.monitor.controller.signal.aborted, false);
    f.monitor.stop();
    assert.equal(ended({ status: 'Inactive' }), true);
    assert.equal(ended({ status: 'Instant Price' }), false);
});

test('an inactive-only forum can establish a silent baseline', async t => {
    const f = fixture(t);
    f.pages.set(1, []);
    f.inactivePages.set(1, ['10', '9']);
    assert.equal(await f.monitor.runOnce(), true);
    const state = await f.store.getState();
    assert.equal(state.initialized, true);
    assert.equal(state.inactiveWatermark, '10');
    assert.deepEqual(f.sent, []);
});

test('shutdown waits for an in-flight delivery to be saved before completing', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.monitor.notifier.send = async () => { entered.resolve(); await release.promise; return { id: 'message-11' }; };
    const running = f.monitor.runOnce();
    await entered.promise;
    let stopped = false;
    const stopping = f.monitor.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release.resolve();
    await stopping;
    await running;
    assert.equal((await f.store.getAuctionRecord('11')).messageId, 'message-11');
});

test('shutdown aborts a pending forum fetch and does not advance the baseline', async t => {
    const f = fixture(t);
    const entered = Promise.withResolvers();
    f.monitor.forumClient.fetchListing = async (_page, _status, { signal }) => {
        entered.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('shutdown'), { code: 'BOT_SHUTTING_DOWN' })), { once: true }));
    };
    const running = f.monitor.runOnce();
    await entered.promise;
    await f.monitor.stop();
    assert.equal(await running, false);
    assert.equal((await f.store.getState()).initialized, false);
    assert.equal(f.monitor.failureCount, 0);
});

test('an old scheduled run cannot rearm polling while a restart is initializing', async t => {
    const f = fixture(t);
    const keepAlive = setTimeout(() => {}, 2000);
    t.after(() => clearTimeout(keepAlive));
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const initializing = Promise.withResolvers();
    let initializations = 0;
    f.store.initialize = async () => { if (++initializations > 1) await initializing.promise; };
    f.monitor.scan = async () => { entered.resolve(); await release.promise; };
    await f.monitor.start();
    await entered.promise;
    const stopping = f.monitor.stop();
    const restarting = f.monitor.start();
    release.resolve();
    await stopping;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.monitor.timer, null);
    initializing.resolve();
    await restarting;
    await f.monitor.stop();
});

async function followedFixture(t) {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [] });
    await f.monitor.runOnce();
    const dms = [];
    f.monitor.notifier.sendBidUpdate = async (userId, key, job) => { dms.push({ userId, key, job }); return { id: '555' }; };
    f.monitor.followService = new AuctionFollowService({ store: f.store, notifier: f.monitor.notifier,
        fetchAuction: id => f.monitor.fetchAuction(id), checkRunning: () => f.monitor.checkRunning() });
    await f.monitor.followService.follow('11', '111', 'message-11');
    return { ...f, dms };
}

const newBid = amount => ({ bidder: { name: 'Bidder' }, amount, time: `bid-${amount}`, invalid: false });

test('refreshing a followed auction groups a bid burst and cleans up at auction end', async t => {
    const f = await followedFixture(t);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('200'), newBid('100')] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.dms.map(item => item.job.bids.map(bid => bid.amount)), [['200', '100']]);
    await f.monitor.runOnce();
    assert.equal(f.dms.length, 1);
    f.auctions.set('11', { id: '11', status: 'Ended', bids: [newBid('300'), newBid('200'), newBid('100')] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal((await f.store.getAuctionRecord('11')).follow, undefined);
    assert.equal(f.dms.length, 1);
});

test('followers keep receiving bids if the original announcement is deleted', async t => {
    const f = await followedFixture(t);
    let edits = 0;
    f.monitor.notifier.edit = async () => { edits++; throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('100')] });
    assert.equal(await f.monitor.runOnce(), true);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('200'), newBid('100')] });
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal(edits, 1);
    assert.deepEqual(f.dms.map(item => item.job.bid.amount), ['100', '200']);
    assert.deepEqual(f.sent, ['11']);
});

test('shutdown waits for a completed bid DM receipt before finishing', async t => {
    const f = await followedFixture(t);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('100')] });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.monitor.notifier.sendBidUpdate = async () => { entered.resolve(); await release.promise; return { id: '555' }; };
    const running = f.monitor.runOnce();
    await entered.promise;
    let stopped = false;
    const stopping = f.monitor.stop().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    release.resolve(); await stopping; await running;
    assert.deepEqual((await f.store.getAuctionRecord('11')).follow.pending, {});
});

test('simultaneous Follow and monitor reads share one current auction request', async t => {
    const f = fixture(t);
    let calls = 0;
    f.monitor.forumClient.fetchAuction = async id => { calls++; return { id, status: 'Active' }; };
    const first = f.monitor.fetchAuction('11'), second = f.monitor.fetchAuction('11');
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    await f.monitor.fetchAuction('11');
    assert.equal(calls, 2);
});

test('forum rate limits stop queued and interactive requests until the server wait expires', async t => {
    const f = fixture(t);
    let now = 1000, requests = 0, listings = 0;
    f.monitor.clock = () => now;
    f.monitor.forumClient.fetchAuction = async () => {
        requests++;
        throw new AuctionForumRequestError('rate limited', { status: 429, code: 'HTTP_429', retryAfterMs: 300000 });
    };
    f.monitor.forumClient.fetchListing = async () => { listings++; return { auctions: [], lastPage: 1 }; };
    const results = await Promise.allSettled([f.monitor.fetchAuction('11'), f.monitor.fetchAuction('12'), f.monitor.listing(1)]);
    for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason.status, 429);
        assert.equal(result.reason.retryAfterMs, 300000);
    }
    assert.equal(requests, 1);
    assert.equal(listings, 0);
    now += 299999;
    await assert.rejects(f.monitor.fetchAuction('12'), error => error.status === 429 && error.retryAfterMs === 1);
    assert.equal(requests, 1);
    now++;
    f.monitor.forumClient.fetchAuction = async id => { requests++; return { id, status: 'Active' }; };
    assert.equal((await f.monitor.fetchAuction('12')).id, '12');
    assert.equal(requests, 2);
    assert.equal(f.monitor.forumRateLimit, null);
    await f.monitor.stop();
    await assert.rejects(f.monitor.fetchAuction('11'), error => error.code === 'BOT_SHUTTING_DOWN');
    assert.equal(requests, 2);
});

test('repeated rate limits increase the shared wait and a late shutdown response cannot restart it', async t => {
    const f = fixture(t);
    let now = 1000;
    f.monitor.clock = () => now;
    f.monitor.forumClient.fetchAuction = async () => { throw new AuctionForumRequestError('rate limited', { status: 429 }); };
    for (const delay of [90000, 180000]) {
        await assert.rejects(f.monitor.fetchAuction('11'), error => error.status === 429);
        assert.equal(f.monitor.forumRateLimit.retryAt, now + delay);
        now += delay;
    }
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.monitor.forumClient.fetchAuction = async () => {
        entered.resolve();
        await release.promise;
        throw new AuctionForumRequestError('late response', { status: 429 });
    };
    const pending = assert.rejects(f.monitor.fetchAuction('11'), error => error.code === 'BOT_SHUTTING_DOWN');
    await entered.promise;
    const previousLimit = f.monitor.forumRateLimit;
    const stopping = f.monitor.stop();
    release.resolve();
    await pending;
    await stopping;
    assert.equal(f.monitor.forumRateLimit, previousLimit);
    assert.equal(f.monitor.timer, null);
});

test('an unavailable followed auction keeps its backoff after its Discord message disappears and recovers without duplicate DMs', async t => {
    const f = await followedFixture(t);
    let now = Date.now(), requests = 0, edits = 0;
    f.monitor.clock = () => now;
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('100')] });
    await f.monitor.followService.observe('11', f.auctions.get('11'));
    const fetchAuction = f.monitor.forumClient.fetchAuction;
    f.monitor.forumClient.fetchAuction = async () => {
        requests++;
        throw new AuctionForumRequestError('page missing', { status: 404 });
    };
    f.monitor.notifier.edit = async () => { edits++; throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
    assert.equal(await f.monitor.runOnce(), true);
    let record = await f.store.getAuctionRecord('11');
    assert.equal(record.messageMissing, true);
    assert.equal(record.auction.sourceUnavailable, true);
    assert.equal(Object.keys(record.follow.pending).length, 1);
    assert.equal(f.dms.length, 0);
    await f.monitor.runOnce();
    assert.equal(requests, 1);
    now = f.monitor.itemFailures.get('refresh 11').nextAttemptAt;
    await f.monitor.runOnce();
    assert.equal(requests, 2);
    assert.equal(edits, 1);
    now = f.monitor.itemFailures.get('refresh 11').nextAttemptAt;
    f.monitor.forumClient.fetchAuction = fetchAuction;
    f.auctions.set('11', { id: '11', status: 'Active', bids: [newBid('200'), newBid('100')] });
    await f.monitor.runOnce();
    record = await f.store.getAuctionRecord('11');
    assert.equal(record.auction.sourceUnavailable, undefined);
    assert.deepEqual(record.follow.pending, {});
    assert.deepEqual(f.dms.map(item => item.job.bid.amount), ['100', '200']);
    await f.monitor.runOnce();
    assert.equal(f.dms.length, 2);
    assert.deepEqual(f.sent, ['11']);
});
