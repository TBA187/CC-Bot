// Verifies auction state persistence, outage replay, host changes, and recovery safety.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuctionStore } = require('../features/auctions/AuctionStore.js');
const { AuctionMonitor } = require('../features/auctions/AuctionMonitor.js');
const { projectOperation, conflict } = require('../features/auctions/AuctionSqlRepository.js');
const { AuctionFollowService } = require('../features/auctions/AuctionFollowService.js');
const { AuctionForumRequestError } = require('../features/auctions/AuctionForumClient.js');
const { buildBidNotificationPayload, handleAuctionButton } = require('../features/auctions/AuctionDiscord.js');
const { ComponentType, MessageFlags } = require('discord.js');

function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auction-store-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const server = { row: null, down: false, calls: 0 };
    const receipts = new Map();
    const repository = {
        async load() {
            server.calls++;
            if (server.down) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
            if (!server.row) return null;
            try { return { revision: server.row.revision, data: JSON.parse(server.row.payload) }; }
            catch { throw conflict(); }
        },
        async apply(op) {
            server.calls++;
            if (server.down) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
            if (receipts.has(op.id)) return;
            if ((server.row?.revision || 0) !== op.baseRevision) throw conflict();
            const data = server.row ? JSON.parse(server.row.payload) : { version: 1, initialized: false, pendingOrder: [], pending: {}, tracked: {} };
            server.row = { revision: op.revision, payload: JSON.stringify(projectOperation(data, op)) };
            receipts.set(op.id, op.revision);
            server.operations ||= []; server.operations.push(structuredClone(op));
            if (server.loseAck) { server.loseAck = false; throw Object.assign(new Error('commit acknowledgement lost'), {code:'ECONNRESET'}); }
        }
    };
    const db = { hasRequiredConfig: true };
    return { dir, server, db, repository, make: (name, options = {}) => new AuctionStore({ dataFile: path.join(dir, name), db, repository, ...options }) };
}

test('local pending changes replay to MySQL after an outage and restore on another host', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    f.server.down = true;
    await store.update(data => { data.initialized = true; data.inactiveWatermark = '10'; data.pending['11'] = { id: '11' }; });
    assert.ok((await store.getState()).pending['11']);
    f.server.down = false;
    await store.reconcile();
    const restored = f.make('second.json');
    await restored.initialize();
    assert.equal((await restored.getState()).initialized, true);
    assert.ok((await restored.getState()).pending['11']);
});

test('a subscription waiting for a forum baseline survives an outage, restart and host change', async t => {
    const f = setup(t), store = f.make('local.json'), sent = [];
    await store.initialize();
    await store.update(data => { data.tracked['11'] = { messageId: '123', auction: { id: '11', status: 'Active' } }; });
    const options = { notifier: { async sendBidUpdate(userId, key, job) { sent.push({ userId, job }); } },
        fetchAuction: async () => { throw new AuctionForumRequestError('missing page', { status: 404 }); } };
    f.server.down = true;
    const service = new AuctionFollowService({ store, ...options });
    assert.equal((await service.follow('11', '111', '123')).waitingForSource, true);
    const restarted = f.make('local.json');
    await restarted.initialize();
    assert.deepEqual((await restarted.getAuctionRecord('11')).follow.baselinePendingUsers, ['111']);
    f.server.down = false;
    await restarted.reconcile();
    const remote = f.make('remote.json');
    await remote.initialize();
    assert.deepEqual((await remote.getAuctionRecord('11')).follow.baselinePendingUsers, ['111']);
    const restored = new AuctionFollowService({ store: remote, ...options });
    const auction = { id: '11', status: 'Active', bids: [{ bidder: { name: 'Bidder' }, amount: '100', time: 'first' }] };
    await restored.observe('11', auction);
    await restored.drain(new Set(['11']));
    assert.equal(sent.length, 0);
    auction.bids.unshift({ bidder: { name: 'Bidder' }, amount: '200', time: 'second' });
    await restored.observe('11', auction);
    await restored.drain(new Set(['11']));
    assert.deepEqual(sent.map(item => [item.userId, item.job.bid.amount]), [['111', '200']]);
    const final = f.make('final.json');
    await final.initialize();
    assert.equal((await final.getAuctionRecord('11')).follow.baselinePendingUsers, undefined);
});

test('conflicting remote state does not overwrite unsynchronized local work', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    f.server.down = true;
    await store.update(data => { data.pending['11'] = { id: '11' }; });
    f.server.down = false;
    f.server.row = { revision: 2, payload: JSON.stringify({ version: 1, initialized: true, inactiveWatermark: '99', pendingOrder: [], pending: {}, tracked: {} }) };
    await assert.rejects(store.initialize(), { code: 'AUCTION_STORE_CONFLICT' });
    assert.ok((await store.getState()).pending['11']);
    assert.equal(f.server.row.revision, 2);
});

test('json mode never connects to MySQL, and corrupt recovery data is preserved', async t => {
    const f = setup(t);
    const store = f.make('local.json', { storageMode: 'json' });
    await store.initialize();
    await store.update(data => { data.initialized = true; data.inactiveWatermark = '1'; });
    assert.equal(f.server.calls, 0);
    fs.writeFileSync(store.dataFile, '{broken');
    await assert.rejects(store.getState(), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(store.dataFile, 'utf8'), '{broken');
    assert.ok(fs.readdirSync(f.dir).some(name => name.startsWith('local.json.corrupt-')));
});

test('unchanged state does not create new revisions or query MySQL', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    const calls = f.server.calls;
    const revision = (await store.getState()).revision;
    await store.update(() => {});
    assert.equal((await store.getState()).revision, revision);
    assert.equal(f.server.calls, calls);
});

test('missing-message state survives a database outage and host recovery', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    await store.update(data => { data.tracked['11'] = { messageId: '123', auction: { id: '11' } }; });
    f.server.down = true;
    await store.update(data => { data.tracked['11'].messageMissing = true; });
    f.server.down = false;
    await store.reconcile();
    const restored = f.make('second.json');
    await restored.initialize();
    assert.equal((await restored.getAuctionRecord('11')).messageMissing, true);
    assert.equal((await restored.getAuctionRecord('11')).messageId, '123');
});

test('equivalent database JSON with reordered keys does not create a recovery conflict', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    const payload = JSON.parse(f.server.row.payload);
    f.server.row.payload = JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()));
    await store.initialize();
    assert.equal((await store.getState()).revision, 0);
});

test('invalid revision metadata and malformed database records stop recovery safely', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    const data = await store.getState();
    fs.writeFileSync(store.dataFile, JSON.stringify({ ...data, revision: -1 }));
    await assert.rejects(store.initialize(), { code: 'JSON_STORE_CORRUPT' });
    fs.writeFileSync(store.dataFile, JSON.stringify(data));
    f.server.row.payload = JSON.stringify({ ...store.payload(data), tracked: [] });
    await assert.rejects(store.initialize(), { code: 'AUCTION_STORE_CONFLICT' });
    assert.deepEqual((await store.getState()).tracked, {});
});

test('an initialized snapshot without its checkpoint is rejected without resetting it', async t => {
    const f = setup(t);
    const store = f.make('local.json', { storageMode: 'json' });
    await store.initialize();
    const saved = JSON.stringify({ ...await store.getState(), initialized: true });
    fs.writeFileSync(store.dataFile, saved);
    await assert.rejects(store.initialize(), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(store.dataFile, 'utf8'), saved);
});

test('switching hosts loads shared state instead of a stale synchronized JSON snapshot', async t => {
    const f = setup(t);
    const local = f.make('local.json');
    await local.initialize();
    await local.update(data => { data.initialized = true; data.inactiveWatermark = '10'; });
    const oldSnapshot = fs.readFileSync(local.dataFile);
    const remote = f.make('remote.json');
    await remote.initialize();
    await remote.update(data => { data.inactiveWatermark = '20'; data.tracked['20'] = { messageId: '123', auction: { id: '20' } }; });
    fs.writeFileSync(local.dataFile, oldSnapshot);
    await local.initialize();
    assert.equal((await local.getState()).inactiveWatermark, '20');
    assert.equal((await local.getAuctionRecord('20')).messageId, '123');
});

test('a cleared MySQL state cannot be repopulated by an old synchronized host file', async t => {
    const f = setup(t);
    const local = f.make('local.json');
    await local.initialize();
    await local.update(data => { data.initialized = true; data.inactiveWatermark = '10';
        data.tracked['10'] = { messageId: '123', auction: { id: '10' } }; });
    f.server.row = null;
    await local.initialize();
    const state = await local.getState();
    assert.equal(state.initialized, false);
    assert.deepEqual(state.tracked, {});
    assert.deepEqual(JSON.parse(f.server.row.payload).tracked, {});
});

test('a lower shared revision after a reset replaces a clean stale host cache', async t => {
    const f = setup(t);
    const local = f.make('local.json');
    await local.initialize();
    await local.update(data => { data.initialized = true; data.inactiveWatermark = '10'; });
    const cleared = local.emptyState();
    f.server.row = { revision: 0, payload: JSON.stringify(local.payload(cleared)) };
    await local.initialize();
    assert.equal((await local.getState()).revision, 0);
    assert.equal((await local.getState()).initialized, false);
});

test('local to remote and back skips downtime auctions while preserving posted messages', async t => {
    const f = setup(t);
    let newest = '10';
    const sent = [];
    const forumClient = {
        async fetchListing(_page, status) {
            return { auctions: status === 'inactive' ? [] : [{ id: newest, url: `https://example.test/${newest}` }], lastPage: 1 };
        },
        async fetchAuction(id) { return { id, status: 'Active' }; }
    };
    const notifier = { async send(auction) { sent.push(auction.id); return { id: `message-${auction.id}` }; }, async edit() {} };
    const monitor = store => new AuctionMonitor({ store, forumClient, notifier, requestSpacingMs: 0, activity: { begin: () => () => {} } });
    const local = f.make('local.json');
    await local.initialize();
    await monitor(local).runOnce();
    newest = '20';
    const remote = f.make('remote.json');
    await remote.initialize();
    const remoteMonitor = monitor(remote);
    assert.equal(await remoteMonitor.runOnce(), true);
    assert.deepEqual(sent, []);
    newest = '21';
    assert.equal(await remoteMonitor.runOnce(), true);
    assert.deepEqual(sent, ['21']);
    await remoteMonitor.stop();
    newest = '30';
    await local.initialize();
    const localMonitor = monitor(local);
    assert.equal(await localMonitor.runOnce(), true);
    assert.deepEqual(sent, ['21']);
    assert.equal((await local.getAuctionRecord('21')).messageId, 'message-21');
    newest = '31';
    assert.equal(await localMonitor.runOnce(), true);
    assert.deepEqual(sent, ['21', '31']);
});

test('followers and partially delivered bids recover through JSON and MySQL on another host', async t => {
    const f = setup(t);
    const store = f.make('local.json');
    await store.initialize();
    const auction = { id: '101', title: 'Pokemon', status: 'Active', bids: [] };
    await store.update(data => { data.tracked['101'] = { messageId: '123', auction }; });
    const service = new AuctionFollowService({ store, fetchAuction: async () => auction, notifier: {} });
    await service.follow('101', '111', '123');
    f.server.down = true;
    auction.bids = [{ bidder: { name: 'Bidder' }, amount: '100', time: '2026-11-04 00:01:00' }];
    await service.observe('101', auction);
    await service.follow('101', '222', '123');
    f.server.down = false;
    await store.reconcile();
    const restored = f.make('remote.json');
    await restored.initialize();
    const record = await restored.getAuctionRecord('101');
    assert.deepEqual(Object.keys(record.follow.users), ['111', '222']);
    assert.deepEqual(Object.values(record.follow.pending)[0].recipients, ['111']);
    const sent = [];
    const remoteService = new AuctionFollowService({ store: restored, fetchAuction: async () => auction,
        notifier: { async sendBidUpdate(userId) { sent.push(userId); return { id: '555' }; } } });
    await remoteService.observe('101', auction);
    await remoteService.drain(new Set(['101']));
    assert.deepEqual(sent, ['111']);
    assert.deepEqual(JSON.parse(f.server.row.payload).tracked['101'].follow.pending, {});
    await remoteService.observe('101', { ...auction, status: 'Ended' });
    assert.equal(JSON.parse(f.server.row.payload).tracked['101'].follow, undefined);
});

test('failed queued writes cannot overwrite later successful subscription changes', async t => {
    const f = setup(t);
    const store = f.make('local.json', { storageMode: 'json' });
    const results = await Promise.allSettled([
        store.update(() => { throw new Error('invalid operation'); }),
        store.update(data => { data.pending['101'] = { id: '101' }; })
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.ok((await store.getState()).pending['101']);
});

test('healthy MySQL storage keeps only a small journal and subscription changes do not rewrite auction snapshots', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    await store.update(data => { data.tracked['101'] = { messageId: '123', auction: { id: '101', status: 'Active', bids: [] },
        follow: { users: { '111': { followedAt: '2026-11-04T00:00:00Z' } }, seenBids: [], pending: {} } }; });
    await store.update(data => { data.tracked['101'].follow.users['222'] = { followedAt: '2026-11-04T01:00:00Z' }; });
    assert.deepEqual(f.server.operations.at(-1).changes.map(change => change.name), ['subscriptions']);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.dataFile)), { version: 2, operations: [] });
    const calls = f.server.calls;
    for (let i = 0; i < 10; i++) await store.getAuctionRecord('101');
    assert.equal(f.server.calls, calls, 'ordinary reads use the in-memory state');
});

test('a committed write with a lost acknowledgement replays once after restart', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    f.server.loseAck = true;
    await store.update(data => { data.pending['101'] = { id: '101' }; });
    const operations = f.server.operations.length;
    assert.ok(JSON.parse(fs.readFileSync(store.dataFile)).operations.length);
    const restarted = f.make('local.json');
    await restarted.initialize();
    assert.equal(f.server.operations.length, operations);
    assert.ok((await restarted.getState()).pending['101']);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.dataFile)), { version: 2, operations: [] });
});

test('an outage snapshot resumes locally after restart and clears only after synchronization', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    await store.update(data => { data.tracked['101'] = { messageId: '123', auction: { id: '101' } }; });
    f.server.down = true;
    await store.update(data => { data.tracked['101'].messageMissing = true; });
    const restarted = f.make('local.json');
    await restarted.initialize();
    assert.equal((await restarted.getAuctionRecord('101')).messageMissing, true);
    await restarted.update(data => { data.pending['102'] = { id: '102' }; });
    f.server.down = false;
    await restarted.reconcile();
    const otherHost = f.make('other.json');
    await otherHost.initialize();
    assert.ok((await otherHost.getState()).pending['102']);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.dataFile)), { version: 2, operations: [] });
});

test('a cold startup with no snapshot waits for MySQL without creating a silent empty baseline', async t => {
    const f = setup(t), store = f.make('local.json');
    f.server.down = true;
    await store.initialize();
    await assert.rejects(store.getState(), { code: 'AUCTION_STORAGE_UNAVAILABLE' });
    await assert.rejects(store.update(data => { data.initialized = true; data.inactiveWatermark = '9'; }), { code: 'AUCTION_STORAGE_UNAVAILABLE' });
    assert.equal(fs.existsSync(store.dataFile), false);
    f.server.down = false;
    await store.reconcile();
    assert.equal((await store.getState()).initialized, false);
});

test('failed journal writes preserve the prior state and never reach MySQL', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    const calls = f.server.calls, write = store.write.bind(store);
    store.write = () => { throw Object.assign(new Error('disk full'), { auctionStorage: true }); };
    await assert.rejects(store.update(data => { data.pending['101'] = { id: '101' }; }), { auctionStorage: true });
    assert.deepEqual((await store.getState()).pending, {});
    assert.equal(f.server.calls, calls);
    store.write = write;
});

test('a failed journal cleanup retains the receipt for a safe restart', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    const write = store.write.bind(store);
    store.write = data => { if (data.version === 2 && data.operations.length === 0) throw Object.assign(new Error('disk full'), { auctionStorage: true }); write(data); };
    await assert.rejects(store.update(data => { data.pending['101'] = { id: '101' }; }), { auctionStorage: true });
    const restarted = f.make('local.json');
    await restarted.initialize();
    assert.ok((await restarted.getState()).pending['101']);
});

test('unfollowing deletes only that subscription and ending removes the remaining subscription and queued DMs', async t => {
    const f = setup(t), store = f.make('local.json');
    await store.initialize();
    const auction = { id: '101', status: 'Active', bids: [] };
    await store.update(data => { data.tracked['101'] = { messageId: '123', auction }; });
    const service = new AuctionFollowService({ store, fetchAuction: async () => auction, notifier: {} });
    await service.follow('101', '111', '123');
    await service.follow('101', '222', '123');
    auction.bids = [{ bidder: { name: 'Bidder' }, amount: '100', time: '2026-11-04 00:01:00' }];
    await service.observe('101', auction);
    await service.unfollow('101', '111');
    let saved = JSON.parse(f.server.row.payload).tracked['101'];
    assert.deepEqual(Object.keys(saved.follow.users), ['222']);
    assert.deepEqual(Object.values(saved.follow.pending)[0].recipients, ['222']);
    assert.deepEqual(f.server.operations.at(-1).changes.map(change => change.name).sort(), ['outbox', 'subscriptions']);
    await service.observe('101', { ...auction, status: 'Ended' });
    saved = JSON.parse(f.server.row.payload).tracked['101'];
    assert.equal(saved.follow, undefined);
    assert.equal(saved.messageId, '123');
    assert.deepEqual(f.server.operations.at(-1).changes.find(change => change.name === 'records').columns, ['follow_details']);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.dataFile)), { version: 2, operations: [] });
});

test('unsupported legacy snapshots are preserved without automatic MySQL imports', async t => {
    const f = setup(t), store = f.make('local.json');
    const snapshot = { ...store.emptyState(), initialized: true, inactiveWatermark: '100' };
    const text = JSON.stringify(snapshot);
    fs.writeFileSync(store.dataFile, text);
    await assert.rejects(store.initialize(), { code: 'AUCTION_STORE_CONFLICT' });
    assert.equal(f.server.calls, 0);
    assert.equal(fs.readFileSync(store.dataFile, 'utf8'), text);
});

test('malformed partial-update journal columns are preserved and never sent to MySQL', async t => {
    const f = setup(t), store = f.make('local.json');
    const text = JSON.stringify({ version: 2, operations: [{ id: 'a'.repeat(36), baseRevision: 0, revision: 1,
        metadata: { initialized: false, pendingOrder: [] },
        changes: [{ name: 'records', keys: ['101'], columns: ['details, message_id'], values: ['{}'] }] }] });
    fs.writeFileSync(store.dataFile, text);
    await assert.rejects(store.initialize(), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(f.server.calls, 0);
    assert.equal(fs.readFileSync(store.dataFile, 'utf8'), text);
});

test('old auction controls use durable subscriptions and auction details after successive restarts', async t => {
    for (const mode of ['auto', 'json']) await t.test(mode, async t => {
        const f = setup(t);
        let store = f.make('state.json', { storageMode: mode });
        await store.initialize();
        const auction = { id: '101', url: 'https://pokemonrevolution.net/forum/trade/101/', title: 'Pokemon', status: 'Active',
            imageUrls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`), bids: [] };
        await store.update(data => { data.tracked['101'] = { messageId: '123', auction }; });
        const service = () => new AuctionFollowService({ store, fetchAuction: async () => auction, notifier: {} });
        let followService = service();
        await followService.follow('101', '111', '123');
        const bid = { bidder: { name: 'Bidder' }, amount: '100', time: '2026-11-04 00:01:00' };
        auction.bids = [bid];
        await followService.observe('101', auction);
        await store.update(data => { data.tracked['101'].auction = structuredClone(auction); });
        const oldDm = buildBidNotificationPayload({ auction, bid }, '111');
        store = f.make(mode === 'json' ? 'state.json' : 'restarted.json', { storageMode: mode });
        await store.initialize();
        followService = service();
        assert.equal(Object.keys((await store.getAuctionRecord('101')).follow.pending).length, 1);
        let response;
        const interaction = { customId: 'auction:dm-unfollow:101:111', guildId: null, channel: null, user: { id: '111' },
            client: { user: { id: '222' }, guilds: { async fetch() { return {
                members: { async fetch() { return { id: '111' }; } },
                channels: { async fetch() { return { permissionsFor: () => ({ has: () => true }) }; } }
            }; } } }, message: { author: { id: '222' }, components: oldDm.components },
            async deferUpdate() {}, async editReply(payload) { response = payload; this.message.components = payload.components; },
            async followUp() {}, async reply() { assert.fail('An old valid control must not be rejected'); } };
        const options = () => ({ guildId: '555', channelId: '444', followService, getAuctionRecord: id => store.getAuctionRecord(id) });
        await handleAuctionButton(interaction, options());
        assert.equal((await store.getAuctionRecord('101')).follow, undefined);
        interaction.customId = response.components[0].toJSON().components[1].custom_id;
        store = f.make(mode === 'json' ? 'state.json' : 'restarted-again.json', { storageMode: mode });
        await store.initialize();
        followService = service();
        await handleAuctionButton(interaction, options());
        const restored = await store.getAuctionRecord('101');
        assert.equal(restored.messageId, '123');
        assert.deepEqual(Object.keys(restored.follow.users), ['111']);
        assert.deepEqual(restored.follow.pending, {}, 're-following after restart does not queue older bids');
        const privateControl = { ...interaction, guildId: '555', channelId: '444',
            message: { flags: { has: flag => flag === MessageFlags.Ephemeral } } };
        await handleAuctionButton({ ...privateControl, customId: 'auction:images:101:1' }, options());
        const gallery = response.components[0].toJSON().components.find(component => component.type === ComponentType.MediaGallery);
        assert.deepEqual(gallery.items.map(item => item.media.url), ['https://example.com/10.png']);
        assert.equal(response.components[0].toJSON().components.at(-2).content,
            '**Auction Message: [Jump to message ↗️](<https://discord.com/channels/555/444/123>)**');
        await handleAuctionButton({ ...privateControl, customId: 'auction:bids:101:0' }, options());
        assert.match(response.embeds[0].toJSON().description, /Bidder.*100/);
        assert.match(response.embeds[0].toJSON().fields[0].value, /https:\/\/discord.com\/channels\/555\/444\/123/);
    });
});
