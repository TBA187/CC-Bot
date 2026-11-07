// Verifies subscription changes, bid delivery retries, and cleanup when auctions end.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const { AuctionStore } = require('../features/auctions/AuctionStore.js');
const { AuctionFollowService, bidKey } = require('../features/auctions/AuctionFollowService.js');
const { AuctionDiscordNotifier } = require('../features/auctions/AuctionDiscord.js');
const { AuctionForumRequestError } = require('../features/auctions/AuctionForumClient.js');

function bid(amount, time = amount, overrides = {}) {
    return { bidder: { name: 'Bidder', url: 'https://pokemonrevolution.net/forum/profile/2-bidder/' },
        amount: String(amount), time: String(time), timestamp: null, labels: [], invalid: false, ...overrides };
}

async function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-follow-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new AuctionStore({ dataFile: path.join(directory, 'state.json'), storageMode: 'json' });
    const auctions = new Map(['101', '202'].map(id => [id, { id, title: `Auction ${id}`,
        url: `https://pokemonrevolution.net/forum/trade/${id}/`, status: 'Active', server: 'Silver', bids: [] }]));
    await store.update(data => {
        data.initialized = true; data.inactiveWatermark = '202';
        for (const [id, auction] of auctions) data.tracked[id] = { messageId: `message-${id}`, auction };
    });
    let now = Date.parse('2026-11-04T00:00:00Z');
    const sent = [];
    const notifier = { async sendBidUpdate(userId, key, job) { sent.push({ userId, key, job }); return { id: `dm-${sent.length}` }; } };
    const make = () => new AuctionFollowService({ store, fetchAuction: async id => structuredClone(auctions.get(id)), notifier,
        clock: () => now, ...options });
    const service = make();
    const follow = (id = '101', userId = '111') => service.follow(id, userId, `message-${id}`);
    const observe = id => service.observe(id, auctions.get(id));
    const record = id => store.getAuctionRecord(id);
    return { store, auctions, sent, notifier, service, make, follow, observe, record, advance: ms => { now += ms; } };
}

test('multiple auctions and followers receive every new bid once, oldest first', async t => {
    const f = await fixture(t);
    await f.follow();
    assert.equal((await f.follow()).alreadyFollowing, true);
    await f.follow('101', '222');
    await f.follow('202', '111');
    f.auctions.get('101').bids = [bid('300'), bid('200')];
    f.auctions.get('202').bids = [bid('900')];
    await f.observe('101'); await f.observe('202');
    await f.service.drain(new Set(['101', '202']));
    assert.deepEqual(f.sent.map(item => [item.userId, item.job.auction.id, item.job.bid.amount]),
        [['111', '101', '200'], ['222', '101', '200'], ['111', '101', '300'], ['222', '101', '300'], ['111', '202', '900']]);
    await f.observe('101'); await f.service.drain(new Set(['101', '202']));
    assert.equal(f.sent.length, 5);
});

test('bid DMs retain their auction image and link to the stored announcement after restart', async t => {
    const f = await fixture(t);
    await f.store.update(data => { data.tracked['101'].messageId = '123'; });
    await f.service.follow('101', '111', '123');
    f.auctions.get('101').bids = [bid('200')];
    f.auctions.get('101').imageUrls = ['https://example.com/main.png', 'https://example.com/second.png'];
    await f.observe('101');
    const restored = new AuctionStore({ dataFile: f.store.dataFile, storageMode: 'json' });
    await restored.initialize();
    const payloads = [];
    const dmChannel = { messages: { async fetch() { return new Collection(); } }, async send(payload) { payloads.push(payload); return { id: '999' }; } };
    const notifier = new AuctionDiscordNotifier({ channelId: '555', config: { guildId: '444' },
        client: { user: { id: 'bot' }, users: { cache: new Map([['111', { dmChannel }]]) } } });
    const service = new AuctionFollowService({ store: restored, notifier, fetchAuction: async id => f.auctions.get(id) });
    await service.drain(new Set(['101']));
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0].embeds[0].toJSON().fields.at(-1), { name: 'Discord message',
        value: '[**Jump to message** ↗️](<https://discord.com/channels/444/555/123>)', inline: false });
    assert.equal(payloads[0].embeds[0].toJSON().thumbnail.url, 'https://example.com/main.png');
    assert.deepEqual((await restored.getAuctionRecord('101')).follow.pending, {});
});

test('subscribing uses fresh history and does not send earlier bids to new followers', async t => {
    const f = await fixture(t);
    f.auctions.get('101').bids = [bid('100')];
    await f.follow('101', '111');
    f.auctions.get('101').bids.unshift(bid('200'));
    await f.follow('101', '222');
    await f.observe('101');
    await f.service.drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => [item.userId, item.job.bid.amount]), [['111', '200']]);
});

test('simultaneous subscriptions do not overwrite each other or listing updates', async t => {
    const f = await fixture(t);
    await Promise.all(Array.from({ length: 10 }, (_, index) => f.follow('101', String(index + 1000))));
    await Promise.all([f.store.update(data => { data.tracked['101'].auction.title = 'Updated title'; }), f.follow('202', '111')]);
    assert.equal(Object.keys((await f.record('101')).follow.users).length, 10);
    assert.equal((await f.record('101')).auction.title, 'Updated title');
    assert.ok((await f.record('202')).follow.users['111']);
});

test('Follow saves subscriptions during forum failures and starts new followers after a fresh baseline', async t => {
    const f = await fixture(t);
    await f.follow();
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    const before = await f.record('101');
    const fetchAuction = f.service.fetchAuction;
    for (const [index, status] of [404, 410, 429, 503].entries()) {
        f.service.fetchAuction = async () => { throw new AuctionForumRequestError('page unavailable', { status }); };
        const result = await f.follow('101', '222');
        assert.equal(result.waitingForSource, true);
        assert.equal(result.alreadyFollowing, index > 0);
        const record = await f.record('101');
        assert.deepEqual(record.follow.baselinePendingUsers, ['222']);
        assert.deepEqual(record.follow.pending, before.follow.pending);
        assert.equal(record.follow.currentAuction.status, 'Unavailable');
    }
    const unexpected = new Error('unexpected parser failure');
    f.service.fetchAuction = async () => { throw unexpected; };
    await assert.rejects(f.follow('101', '222'), error => error === unexpected);
    f.service.fetchAuction = fetchAuction;
    assert.equal((await f.follow('101', '222')).alreadyFollowing, true);
    await f.service.drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => item.userId), ['111']);
    assert.equal((await f.record('101')).follow.baselinePendingUsers, undefined);
    f.auctions.get('101').bids.unshift(bid('300'));
    await f.observe('101');
    await f.service.drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => [item.userId, item.job.bid.amount]), [['111', '200'], ['111', '300'], ['222', '300']]);
});

test('a first follower can subscribe during an outage and unfollow before the page returns', async t => {
    const f = await fixture(t);
    f.service.fetchAuction = async () => { throw new AuctionForumRequestError('timeout', { code: 'ETIMEDOUT' }); };
    assert.equal((await f.follow()).waitingForSource, true);
    assert.deepEqual((await f.record('101')).follow.baselinePendingUsers, ['111']);
    await f.follow('101', '222');
    await f.service.unfollow('101', '111');
    assert.deepEqual((await f.record('101')).follow.baselinePendingUsers, ['222']);
    await f.service.unfollow('101', '222');
    assert.equal((await f.record('101')).follow, undefined);
    await f.follow();
    f.auctions.get('101').status = 'Ended';
    await f.observe('101');
    assert.equal((await f.record('101')).follow, undefined);
    f.service.fetchAuction = async () => f.auctions.get('101');
    assert.equal((await f.follow()).ended, true);
});

test('an outage Follow is not confirmed when its subscription cannot be saved', async t => {
    const f = await fixture(t);
    f.service.fetchAuction = async () => { throw new AuctionForumRequestError('page missing', { status: 404 }); };
    f.store.write = () => { throw Object.assign(new Error('disk full'), { auctionStorage: true }); };
    await assert.rejects(f.follow(), error => error.auctionStorage && /disk full/u.test(error.message));
    assert.equal((await f.record('101')).follow, undefined);
});

test('auction end removes its subscriptions and queued DMs while other auctions keep working', async t => {
    const f = await fixture(t);
    await f.follow('101'); await f.follow('202');
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    f.auctions.get('101').status = 'Ended';
    await f.observe('101');
    await f.service.drain(new Set(['101']));
    assert.equal((await f.record('101')).follow, undefined);
    assert.equal(f.sent.length, 0);
    assert.equal((await f.follow('101')).ended, true);
    f.auctions.get('202').bids = [bid('500')];
    await f.observe('202'); await f.service.drain(new Set(['202']));
    assert.deepEqual(f.sent.map(item => item.job.auction.id), ['202']);
});

test('Unfollow removes only that user and auction, including outstanding recipients', async t => {
    const f = await fixture(t);
    await f.follow('101', '111'); await f.follow('101', '222'); await f.follow('202', '111');
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    assert.equal(await f.service.unfollow('101', '111'), true);
    await f.service.drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => item.userId), ['222']);
    assert.ok((await f.record('202')).follow.users['111']);
    await f.service.unfollow('101', '222');
    assert.equal((await f.record('101')).follow, undefined);
});

test('invalid bids and price-offer status edits do not produce duplicate bid notifications', async t => {
    const f = await fixture(t);
    await f.follow();
    const offer = bid('500', 'offer', { labels: ['Price offer'] });
    f.auctions.get('101').bids = [bid('300', 'invalid', { invalid: true }), offer];
    await f.observe('101'); await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 1);
    offer.labels.push('Accepted');
    f.auctions.get('101').bids.reverse();
    await f.observe('101'); await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 1);
    assert.equal(bidKey(bid('500.000')), bidKey(bid('500,000', '500.000')));
});

test('a queued bid invalidated before delivery is removed without notifying its followers', async t => {
    const f = await fixture(t);
    await f.follow('101', '111');
    await f.follow('101', '222');
    const pendingBid = bid('200');
    f.auctions.get('101').bids = [pendingBid];
    await f.observe('101');
    assert.equal(Object.keys((await f.record('101')).follow.pending).length, 1);
    pendingBid.invalid = true;
    await f.observe('101');
    const restarted = f.make();
    await restarted.drain(new Set(['101']));
    assert.deepEqual(f.sent, []);
    assert.deepEqual((await f.record('101')).follow.pending, {});
    assert.deepEqual(Object.keys((await f.record('101')).follow.users), ['111', '222']);
});

test('temporary failures retain notifications for recovery without duplicating completed recipients', async t => {
    const f = await fixture(t);
    await f.follow('101', '111'); await f.follow('101', '222');
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    const send = f.notifier.sendBidUpdate;
    f.notifier.sendBidUpdate = async (userId, ...args) => {
        if (userId === '222') throw Object.assign(new Error('temporary failure'), { code: 'ETIMEDOUT' });
        return send(userId, ...args);
    };
    t.mock.method(console, 'warn', () => {});
    await f.service.drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => item.userId), ['111']);
    const queued = Object.values((await f.record('101')).follow.pending);
    assert.deepEqual(queued[0].recipients, ['222']);
    f.notifier.sendBidUpdate = send;
    await f.make().drain(new Set(['101']));
    assert.deepEqual(f.sent.map(item => item.userId), ['111', '222']);
    assert.deepEqual((await f.record('101')).follow.pending, {});
});

test('blocked DMs remove that auction subscription and do not block other followers', async t => {
    const f = await fixture(t);
    await f.follow('101', '111'); await f.follow('101', '222');
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    const send = f.notifier.sendBidUpdate;
    f.notifier.sendBidUpdate = async (userId, ...args) => {
        if (userId === '111') throw Object.assign(new Error('Cannot send messages'), { code: 50007 });
        return send(userId, ...args);
    };
    await f.service.drain(new Set(['101']));
    assert.equal((await f.record('101')).follow.users['111'], undefined);
    assert.deepEqual(f.sent.map(item => item.userId), ['222']);
});

test('DM batches remain bounded and do not lose queued recipients', async t => {
    const f = await fixture(t, { batchSize: 2 });
    for (const userId of ['111', '222', '333']) await f.follow('101', userId);
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101'); await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 2);
    assert.equal(Object.values((await f.record('101')).follow.pending)[0].recipients.length, 1);
    await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 3);
});

test('unavailable sources pause queued notifications until a fresh active snapshot is observed', async t => {
    const f = await fixture(t);
    await f.follow();
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101'); await f.service.pause('101');
    await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 0);
    await f.observe('101'); await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 1);
});

test('new subscribers cannot use a replaced or missing announcement', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.service.follow('101', '111', 'other-message'), { unavailable: true });
    await f.store.update(data => { data.tracked['101'].messageMissing = true; });
    assert.deepEqual(await f.follow(), { unavailable: true });
    assert.equal((await f.record('101')).follow, undefined);
});

test('a saved DM is recovered after its local receipt write fails', async t => {
    const f = await fixture(t);
    await f.follow();
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    const history = new Collection();
    let sends = 0;
    const write = f.store.write.bind(f.store);
    const channel = { messages: { async fetch() { return history; } }, async send(payload) {
        sends++;
        const message = { id: '555', author: { id: 'bot' }, embeds: payload.embeds.map(embed => embed.toJSON()),
            components: payload.components.map(row => row.toJSON()) };
        history.set(message.id, message);
        f.store.write = () => { throw Object.assign(new Error('disk full'), { auctionStorage: true }); };
        return message;
    } };
    f.service.notifier = new AuctionDiscordNotifier({ client: { user: { id: 'bot' },
        users: { cache: new Map([['111', { dmChannel: channel }]]) } } });
    await assert.rejects(f.service.drain(new Set(['101'])), { auctionStorage: true });
    f.store.write = write;
    await f.service.drain(new Set(['101']));
    assert.equal(sends, 1);
    assert.deepEqual((await f.record('101')).follow.pending, {});
});

test('a user removed or an auction ended during a DM stops further recipients', async t => {
    const f = await fixture(t);
    await f.follow('101', '111'); await f.follow('101', '222');
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    f.notifier.sendBidUpdate = async userId => { f.sent.push(userId); entered.resolve(); await release.promise; return { id: '555' }; };
    const pending = f.service.drain(new Set(['101']));
    await entered.promise;
    f.auctions.get('101').status = 'Ended';
    await f.observe('101');
    release.resolve(); await pending;
    assert.deepEqual(f.sent, ['111']);
    assert.equal((await f.record('101')).follow, undefined);
});

test('a known end deadline pauses DMs and a confirmed extension can resume them', async t => {
    const f = await fixture(t);
    await f.follow();
    f.auctions.get('101').endsAt = '2026-11-04T00:01:00Z';
    f.auctions.get('101').bids = [bid('200')];
    await f.observe('101');
    f.advance(60_000);
    await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 0);
    assert.ok((await f.record('101')).follow);
    f.auctions.get('101').endsAt = '2026-11-04T00:10:00Z';
    await f.observe('101'); await f.service.drain(new Set(['101']));
    assert.equal(f.sent.length, 1);
});
