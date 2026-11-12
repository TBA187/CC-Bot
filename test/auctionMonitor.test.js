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
    const signatures = new Map();
    const sent = [];
    const edited = [];
    const forumClient = {
        async fetchListing(page, status = 'active') {
            const selected = status === 'inactive' ? inactivePages : pages;
            const ids = selected.get(page);
            if (!ids) throw new Error('Page unavailable');
            return { auctions: ids.map(id => ({ id, url: `https://example.test/${id}`,
                ...(signatures.has(id) ? { signature: signatures.get(id) } : {}) })), lastPage: selected.size };
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
    return { store, pages, inactivePages, auctions, signatures, sent, edited, monitor };
}

const restartedMonitor = (f, options = {}) => new AuctionMonitor({ store: f.store, forumClient: f.monitor.forumClient,
    notifier: f.monitor.notifier, requestSpacingMs: 0, activity: { begin: () => () => {} }, ...options });

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

test('a restart announces auctions posted while offline together with the previous queue, oldest first', async t => {
    const f = fixture(t), logs = [];
    f.pages.set(1, ['10', '9']);
    await f.monitor.runOnce();
    await f.store.update(data => {
        data.pending['11'] = { id: '11', queuedAt: '2026-11-02T00:00:00Z' };
        data.pendingOrder = ['11'];
    });
    f.pages.set(1, ['90', '89']);
    f.pages.set(2, ['88', '87']);
    f.inactivePages.set(1, ['91', '8']);
    for (const id of ['11', '87', '88', '89', '90', '91']) f.auctions.set(id, { id, status: 'Active' });
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    const restarted = restartedMonitor(f);
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent, ['11', '87', '88', '89', '90'], 'the oldest five are delivered in the first scan');
    const state = await f.store.getState();
    assert.equal(state.inactiveWatermark, '91');
    assert.deepEqual(state.pendingOrder, ['91']);
    assert.ok(logs.some(line => line === '[CC LOG] PRO auction startup catch-up queued 6 auctions posted while the bot was offline.'));
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent, ['11', '87', '88', '89', '90', '91']);
    f.pages.set(1, ['92', '90']);
    f.auctions.set('92', { id: '92', status: 'Active' });
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent.at(-1), '92');
});

test('a restart queues only the ten newest offline auctions and skips older ones', async t => {
    const f = fixture(t), logs = [];
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    await f.store.update(data => { data.pending['11'] = { id: '11', queuedAt: '2026-11-02T00:00:00Z' }; data.pendingOrder = ['11']; });
    f.pages.set(1, Array.from({ length: 15 }, (_, index) => String(40 - index)));
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    assert.equal(await restartedMonitor(f).runOnce(), true);
    const state = await f.store.getState();
    assert.deepEqual(state.pendingOrder, ['31', '32', '33', '34', '35', '36', '37', '38', '39', '40']);
    assert.equal(state.pending['11'], undefined);
    assert.equal(state.inactiveWatermark, '40');
    assert.ok(logs.some(line => line === '[CC LOG] PRO auction startup catch-up queued 10 auctions posted while the bot was offline; older ones were skipped.'));
});

test('a restart without new auctions keeps the queued announcements and their original queue time', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    await f.store.update(data => { data.pending['11'] = { id: '11', queuedAt: '2026-11-02T00:00:00Z' }; data.pendingOrder = ['11']; });
    const restarted = restartedMonitor(f);
    assert.equal(await restarted.runOnce(), true);
    const state = await f.store.getState();
    assert.deepEqual(state.pending['11'], { id: '11', queuedAt: '2026-11-02T00:00:00Z' });
    assert.deepEqual(state.pendingOrder, ['11']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    restarted.itemFailures.clear();
    assert.equal(await restarted.runOnce(), true);
    assert.deepEqual(f.sent, ['11']);
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

test('stopping and starting the same monitor announces the downtime backlog once', async t => {
    const f = fixture(t);
    f.monitor.schedule = () => {};
    f.pages.set(1, ['10']);
    await f.monitor.start();
    await f.monitor.runOnce();
    await f.monitor.stop();
    f.pages.set(1, ['20', '19']);
    for (const id of ['19', '20']) f.auctions.set(id, { id, status: 'Active' });
    await f.monitor.start();
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['19', '20']);
    assert.equal((await f.store.getState()).inactiveWatermark, '20');
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['19', '20']);
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

test('scheduled refreshes open only auctions whose listing card changed, continuing without idle gaps', async t => {
    const f = fixture(t), timers = [], fetched = [];
    let now = 1000, listings = 0;
    f.monitor.clock = () => now;
    f.monitor.random = () => 0.5;
    const listing = f.monitor.forumClient.fetchListing;
    f.monitor.forumClient.fetchListing = async (...args) => { listings++; now += 750; return listing(...args); };
    f.monitor.forumClient.fetchAuction = async id => {
        fetched.push(id); now += 750;
        return { id, status: 'Active', bids: id === '70' ? [newBid('400'), newBid('300')] : [] };
    };
    for (let page = 1; page <= 4; page++) {
        f.pages.set(page, Array.from({ length: 20 }, (_, index) => String(70 - (page - 1) * 20 - index)).filter(id => Number(id) > 0));
    }
    await f.store.update(data => {
        data.initialized = true;
        data.inactiveWatermark = '70';
        for (let id = 1; id <= 70; id++) data.tracked[String(id)] = {
            messageId: `message-${id}`, auction: { id: String(id), status: 'Active', bids: [], listingSignature: `card-${id}` }
        };
    });
    for (let id = 1; id <= 70; id++) f.signatures.set(String(id), id >= 59 ? `changed-${id}` : `card-${id}`);
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => { timer.cancelled = true; });
    t.after(() => f.monitor.stop());
    await f.monitor.start();
    let timer = timers.shift();
    assert.equal(timer.delay, 0);
    await timer.callback();
    assert.equal(listings, 5, 'discovery reads both first pages and the listing check reads the other three active pages');
    assert.deepEqual(fetched, ['59', '60', '61', '62', '63', '64', '65', '66', '67', '68']);
    timer = timers.shift();
    assert.equal(timer.delay, 0, 'remaining changed auctions continue immediately with the shared request pacing');
    await timer.callback();
    assert.deepEqual(fetched.slice(10), ['69', '70']);
    assert.equal(listings, 5);
    const updated = await f.store.getAuctionRecord('70');
    assert.equal(updated.auction.bids.length, 2);
    assert.equal(updated.auction.listingSignature, 'changed-70');
    assert.equal((await f.store.getAuctionRecord('60')).auction.listingSignature, 'changed-60');
    assert.deepEqual(f.edited.map(([messageId]) => messageId), ['message-70'], 'only a real auction change edits Discord');
    timer = timers.shift();
    assert.ok(timer.delay > 0, 'unchanged auctions are not polled');
    now += timer.delay;
    await timer.callback();
    assert.equal(listings, 7, 'the next discovery reads only the first pages');
    assert.equal(fetched.length, 12);
    f.signatures.set('30', 'changed-30');
    timer = timers.shift();
    now += 10 * 60 * 1000;
    await timer.callback();
    assert.deepEqual(fetched.slice(12), ['30'], 'the next listing check finds the one changed card');
    assert.equal(listings, 12);
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
    assert.equal(f.monitor.nextRefreshAttemptAt, now + 6 * 60 * 60 * 1000, 'a new unfollowed auction waits for the listing check or its safety refresh');
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
    assert.match(warnings[0][0], /PRO auction monitor is unavailable\. Retrying in 90 seconds/);
    assert.deepEqual(warnings[0][2], { code: 'ETIMEDOUT' });
    assert.equal(requests, 2, 'a timeout is retried once before the monitor pauses');
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal(requests, 2, 'no request is sent during the retry wait');
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

const DAY = 24 * 60 * 60 * 1000;
const snowflakeAt = ms => String((BigInt(ms) - 1420070400000n) << 22n);

function scheduleFixture(t, now) {
    const f = fixture(t);
    let clock = now;
    f.monitor.clock = () => clock;
    f.monitor.random = () => 0.5;
    f.monitor.nextFullSweepAt = Infinity;
    f.setNow = value => { clock = value; };
    f.now = () => clock;
    f.fetched = [];
    f.listings = [];
    const listing = f.monitor.forumClient.fetchListing;
    f.monitor.forumClient.fetchListing = async (page, status = 'active') => { f.listings.push(`${status}:${page}`); return listing(page, status); };
    f.monitor.forumClient.fetchAuction = async id => {
        f.fetched.push(id);
        if (!f.auctions.has(id)) throw new Error('Auction unavailable');
        return structuredClone(f.auctions.get(id));
    };
    return f;
}

async function track(f, records) {
    await f.store.update(data => {
        data.initialized = true;
        data.inactiveWatermark = '100';
        for (const [id, record] of Object.entries(records)) data.tracked[id] = record;
    });
}

test('the regular listing check stops at auctions older than seven days and the daily check covers older ones', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    const record = (id, announcedAt) => ({ messageId: snowflakeAt(announcedAt),
        auction: { id, status: 'Active', bids: [], listingSignature: `card-${id}` } });
    const records = {};
    for (let id = 60; id <= 70; id++) records[id] = record(String(id), now - DAY);
    for (let id = 1; id <= 10; id++) records[id] = record(String(id), now - 30 * DAY);
    await track(f, records);
    for (let page = 1; page <= 4; page++) {
        f.pages.set(page, Array.from({ length: 20 }, (_, index) => String(70 - (page - 1) * 20 - index)).filter(id => Number(id) > 0));
    }
    for (const id of Object.keys(records)) f.signatures.set(id, `card-${id}`);
    assert.equal(await f.monitor.runOnce({ scheduled: true }), true);
    assert.deepEqual(f.listings, ['active:1', 'inactive:1'], 'the recent check reuses page 1 and stops at the seven-day boundary');
    assert.deepEqual(f.fetched, []);
    f.pages.set(4, ['10', '9', '8', '7', '6', '4', '3', '2', '1']);
    f.auctions.set('5', { id: '5', status: 'Ended', bids: [] });
    f.setNow(now + 10 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, [], 'the recent check does not read the older pages');
    f.monitor.nextFullSweepAt = f.now();
    f.setNow(f.now() + 10 * 60 * 1000);
    f.listings.length = 0;
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.listings, ['active:1', 'inactive:1', 'active:2', 'active:3', 'active:4']);
    assert.deepEqual(f.fetched, ['5'], 'an older auction that left the listing is checked once');
    assert.equal((await f.store.getAuctionRecord('5')).auction.status, 'Ended');
    assert.ok(f.monitor.nextFullSweepAt >= f.now() + DAY - 60 * 1000);
});

test('followed auctions are checked every interval while unfollowed recent auctions wait for the listing check', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    const follow = { seenBids: [], users: { 111: { followedAt: '2026-11-11T00:00:00.000Z' } }, pending: {} };
    await track(f, {
        11: { messageId: snowflakeAt(now - DAY), auction: { id: '11', status: 'Active', bids: [] }, follow },
        12: { messageId: snowflakeAt(now - DAY), auction: { id: '12', status: 'Active', bids: [] } }
    });
    f.pages.set(1, ['12', '11']);
    for (const id of ['11', '12']) f.auctions.set(id, { id, status: 'Active', bids: [] });
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, [], 'after a restart the first followed check starts within one interval');
    for (const seconds of [46, 136, 226]) {
        f.setNow(now + seconds * 1000);
        await f.monitor.runOnce({ scheduled: true });
    }
    assert.deepEqual(f.fetched, ['11', '11', '11']);
});

test('an auction is checked one minute after its countdown ends and again until the forum shows the end', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    const endsAt = new Date(now + 5 * 60 * 1000).toISOString();
    await track(f, { 11: { messageId: snowflakeAt(now - DAY), auction: { id: '11', status: 'Active', bids: [], endsAt } } });
    f.pages.set(1, ['11']);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [], endsAt });
    await f.monitor.runOnce({ scheduled: true });
    f.setNow(now + 5.5 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, [], 'not before the one-minute grace period');
    f.setNow(now + 6 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11']);
    f.auctions.set('11', { id: '11', status: 'Ended', bids: [], endsAt });
    f.setNow(now + 6 * 60 * 1000 + 91 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11', '11'], 'the forum still showed it as active, so it is checked again shortly');
    f.setNow(now + 20 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.equal(f.fetched.length, 2, 'an ended auction is no longer checked');
});

test('older countdowns are checked every ten minutes and other older auctions are spread across their weekly check', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    f.monitor.random = () => 0.25;
    const old = snowflakeAt(now - 30 * DAY);
    const endsAt = new Date(now + 2 * DAY).toISOString();
    await track(f, {
        11: { messageId: old, auction: { id: '11', status: 'Active', bids: [], endsAt } },
        12: { messageId: old, auction: { id: '12', status: 'Active', bids: [] } }
    });
    f.pages.set(1, ['12', '11']);
    f.auctions.set('11', { id: '11', status: 'Active', bids: [], endsAt });
    f.auctions.set('12', { id: '12', status: 'Active', bids: [] });
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11'], 'a running countdown outside the recent check is due right after a restart');
    f.setNow(now + 5 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11']);
    f.setNow(now + 10 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11', '11']);
    f.setNow(now + 5 * DAY);
    await f.monitor.runOnce({ scheduled: true });
    assert.ok(!f.fetched.includes('12'), 'restart spreading delays the first weekly check');
    f.setNow(now + 5.3 * DAY);
    await f.monitor.runOnce({ scheduled: true });
    assert.ok(f.fetched.includes('12'));
});

test('a deleted post without followers ignores card changes but is checked when it leaves the listing', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    await track(f, {
        11: { messageId: snowflakeAt(now - DAY), messageMissing: true, auction: { id: '11', status: 'Active', bids: [], listingSignature: 'card-11' } },
        12: { messageId: snowflakeAt(now - DAY), auction: { id: '12', status: 'Active', bids: [], listingSignature: 'card-12' } }
    });
    f.pages.set(1, ['12', '11']);
    f.signatures.set('11', 'changed-11');
    f.signatures.set('12', 'card-12');
    f.auctions.set('11', { id: '11', status: 'Ended', bids: [] });
    f.auctions.set('12', { id: '12', status: 'Active', bids: [] });
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, [], 'a changed card without a post or followers is not opened');
    f.pages.set(1, ['12']);
    f.setNow(now + 10 * 60 * 1000);
    await f.monitor.runOnce({ scheduled: true });
    assert.deepEqual(f.fetched, ['11']);
    assert.equal((await f.store.getAuctionRecord('11')).auction.status, 'Ended');
    assert.deepEqual(f.edited, []);
});

test('ended and unavailable records leave storage 30 days later, active ones stay, and Discord is untouched', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    const daysAgo = days => new Date(now - days * DAY).toISOString();
    await track(f, {
        11: { messageId: '1', auction: { id: '11', status: 'Ended', endedAt: daysAgo(30) } },
        12: { messageId: '2', auction: { id: '12', status: 'Ended', endedAt: daysAgo(29) } },
        13: { messageId: '3', auction: { id: '13', status: 'Ended', endsAt: daysAgo(31) } },
        14: { messageId: '4', auction: { id: '14', status: 'Ended' } },
        15: { messageId: '5', auction: { id: '15', status: 'Unavailable', sourceUnavailable: true, unavailableSince: daysAgo(30) } },
        16: { messageId: '6', auction: { id: '16', status: 'Unavailable', sourceUnavailable: true } },
        17: { messageId: '7', auction: { id: '17', status: 'Active', bids: [] } },
        18: { messageId: '8', auction: { id: '18', status: 'Ended', endedAt: daysAgo(-100), endedObservedAt: 'invalid' } }
    });
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    await f.monitor.pruneStale();
    let state = await f.store.getState();
    assert.deepEqual(Object.keys(state.tracked), ['12', '14', '16', '17', '18']);
    assert.equal(state.tracked['14'].auction.endedObservedAt, new Date(now).toISOString());
    assert.equal(state.tracked['16'].auction.unavailableSince, new Date(now).toISOString());
    assert.equal(state.tracked['18'].auction.endedObservedAt, new Date(now).toISOString(), 'invalid or future times are replaced');
    assert.ok(logs.includes('[CC LOG] Removed 3 stale PRO auction records (ended or unavailable for more than 30 days).'));
    f.setNow(now + DAY);
    await f.monitor.pruneStale();
    state = await f.store.getState();
    assert.deepEqual(Object.keys(state.tracked), ['14', '16', '17', '18'], 'a record ended 29 days ago leaves one day later');
    assert.equal(state.tracked['14'].auction.endedObservedAt, new Date(now).toISOString(), 'a stamp is set only once');
    f.setNow(now + 30 * DAY);
    await f.monitor.pruneStale();
    assert.deepEqual(Object.keys((await f.store.getState()).tracked), ['17'], 'active auctions are never removed');
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.edited, []);
});

test('a missing forum page records when it became unavailable and a returning page clears it', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    await track(f, { 11: { messageId: 'message-11', auction: { id: '11', status: 'Active', bids: [] } } });
    f.pages.set(1, ['11']);
    f.monitor.forumClient.fetchAuction = async () => { throw new AuctionForumRequestError('page missing', { status: 404 }); };
    await f.monitor.runOnce();
    let auction = (await f.store.getAuctionRecord('11')).auction;
    assert.equal(auction.sourceUnavailable, true);
    assert.equal(auction.unavailableSince, new Date(now).toISOString());
    f.monitor.forumClient.fetchAuction = async id => ({ id, status: 'Active', bids: [] });
    f.monitor.itemFailures.clear();
    await f.monitor.runOnce();
    auction = (await f.store.getAuctionRecord('11')).auction;
    assert.equal(auction.sourceUnavailable, undefined);
    assert.equal(auction.unavailableSince, undefined);
});

test('a queued announcement whose forum page stays missing is dropped after 30 days without posting', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    await f.store.update(data => {
        data.initialized = true;
        data.inactiveWatermark = '11';
        data.pending['11'] = { id: '11', queuedAt: new Date(now).toISOString() };
        data.pendingOrder = ['11'];
    });
    const missing = async () => { throw new AuctionForumRequestError('page missing', { status: 404 }); };
    const deliver = async () => { f.monitor.itemFailures.clear(); await f.monitor.deliverPending(new Set(), new Set()); };
    f.monitor.forumClient.fetchAuction = missing;
    await deliver();
    assert.equal((await f.store.getState()).pending['11'].unavailableSince, new Date(now).toISOString());
    f.setNow(now + DAY);
    await deliver();
    assert.equal((await f.store.getState()).pending['11'].unavailableSince, new Date(now).toISOString(), 'the first time is kept');
    f.monitor.forumClient.fetchAuction = async id => ({ id, status: 'Active' });
    f.monitor.notifier.send = async () => { throw Object.assign(new Error('Missing Access'), { status: 403, code: 50001 }); };
    t.mock.method(console, 'warn', () => {});
    await deliver();
    assert.equal((await f.store.getState()).pending['11'].unavailableSince, undefined, 'a page that loads again clears the mark');
    f.monitor.forumClient.fetchAuction = missing;
    await deliver();
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    f.setNow(now + 30 * DAY);
    await f.monitor.pruneStale();
    assert.ok((await f.store.getState()).pending['11'], 'kept until 30 days after the latest mark');
    f.setNow(now + 31 * DAY);
    await f.monitor.pruneStale();
    const state = await f.store.getState();
    assert.deepEqual(state.pending, {});
    assert.deepEqual(state.pendingOrder, []);
    assert.ok(logs.includes('[CC LOG] Dropped 1 queued PRO auction announcement whose forum page stayed unavailable for 30 days.'));
    assert.deepEqual(f.sent, []);
});

test('old change receipts are pruned at most once an hour with a 30-day cutoff', async t => {
    const now = Date.UTC(2026, 10, 12);
    const f = scheduleFixture(t, now);
    const calls = [];
    f.store.pruneReceipts = async cutoff => { calls.push(cutoff); return 3; };
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    await f.monitor.pruneStale();
    await f.monitor.pruneStale();
    f.setNow(now + 60 * 60 * 1000);
    await f.monitor.pruneStale();
    assert.deepEqual(calls, [now - 30 * DAY, now + 60 * 60 * 1000 - 30 * DAY]);
    assert.equal(logs.filter(line => line === '[CC LOG] Removed 3 PRO auction change receipts older than 30 days.').length, 2);
});

test('one connection reset is retried before the monitor pauses, while HTTP errors are not', async t => {
    const f = fixture(t), warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    f.pages.set(1, ['10']);
    await f.monitor.runOnce();
    f.pages.set(1, ['11', '10']);
    let attempts = 0;
    f.monitor.forumClient.fetchAuction = async id => {
        attempts++;
        if (attempts === 1) throw new AuctionForumRequestError('fetch failed (auction 11).', { code: 'ECONNRESET' });
        return { id, status: 'Active' };
    };
    assert.equal(await f.monitor.runOnce(), true);
    assert.equal(attempts, 2);
    assert.deepEqual(f.sent, ['11']);
    assert.equal(f.monitor.forumUnavailable, false);
    assert.deepEqual(warnings, []);
    attempts = 0;
    f.pages.set(1, ['12', '11', '10']);
    f.monitor.forumClient.fetchAuction = async () => { attempts++; throw new AuctionForumRequestError('busy', { status: 503, code: 'HTTP_503' }); };
    assert.equal(await f.monitor.runOnce(), false);
    assert.equal(attempts, 1);
});

test('a listing with more than 1,000 pages is scanned normally when the checkpoint is on its first page', async t => {
    const f = fixture(t);
    f.pages.set(1, ['10']);
    f.inactivePages.set(1, ['5']);
    await f.monitor.runOnce();
    const listing = f.monitor.forumClient.fetchListing;
    f.monitor.forumClient.fetchListing = async (page, status) => ({ ...await listing(page, status), lastPage: 1500 });
    f.pages.set(1, ['11', '10']);
    f.auctions.set('11', { id: '11', status: 'Active' });
    assert.equal(await f.monitor.runOnce(), true);
    assert.deepEqual(f.sent, ['11']);
});
