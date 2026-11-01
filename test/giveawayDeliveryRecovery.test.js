'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGiveawayStore, endGiveaway } = require('../events/giveaways');

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-giveaway-delivery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dataFile = path.join(directory, 'giveaways.json');
    const initial = {
        giveaway_id: 'delivery-recovery', guild_id: 'guild', channel_id: 'channel', message_id: null,
        prize: 'Prize', winners_total: 2, status: 'active', winner_user_ids: [],
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        ends_at: new Date(Date.now() - 60000).toISOString()
    };
    const makeStore = () => createGiveawayStore({ storageMode: 'json', dataFile,
        db: { async query() { assert.fail('JSON delivery recovery must not query MySQL'); } } });
    const store = makeStore();
    store.localSaveGiveaway(initial.giveaway_id, initial, false);
    for (let index = 0; index < 6; index++) {
        const userId = `10000000000000000${index}`;
        store.localSaveEntry(initial.giveaway_id, userId, {
            user_id: userId, joined_at: initial.starts_at, left_at: null
        }, false);
    }
    const attempts = [], delivered = new Map();
    const channel = { messages: { fetch: async () => null }, async send(payload) {
        attempts.push(payload);
        if (payload.enforceNonce && delivered.has(payload.nonce)) return delivered.get(payload.nonce);
        const message = { id: `delivery-${delivered.size + 1}` };
        delivered.set(payload.nonce || message.id, message);
        return message;
    } };
    const client = { channels: { cache: { get: () => channel }, fetch: async () => channel } };
    const finish = (activeStore = store, options = {}) => endGiveaway(client, { giveawayStore: activeStore }, initial,
        { drawType: 'end', ...options });
    const restart = async () => {
        const restored = makeStore();
        await restored.restore();
        return restored;
    };
    const snapshot = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return { initial, store, channel, finish, restart, snapshot, attempts, delivered };
}

test('failed JSON end delivery keeps its complete draw through restart and durably acknowledges recovery', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    f.channel.send = async () => { throw new Error('Discord unavailable'); };

    const [pending, winners] = await f.finish();
    const saved = f.snapshot();
    assert.equal(pending.status, 'ended');
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(winners.length, 2);
    assert.equal(Object.keys(saved.draws).length, 1);
    assert.deepEqual(saved.draws[pending.end_draw_id].winner_user_ids, winners);

    const restored = await f.restart();
    assert.deepEqual((await restored.listDueGiveaways()).map(item => item.giveaway_id), [f.initial.giveaway_id]);
    // Recovery must keep the recorded draw even if the entry snapshot has changed.
    for (const entry of await restored.listEntries(f.initial.giveaway_id)) {
        restored.localSaveEntry(f.initial.giveaway_id, entry.user_id, { ...entry, left_at: f.initial.starts_at }, false);
    }
    f.channel.send = send;
    const [ended, recoveredWinners] = await f.finish(restored);
    assert.deepEqual(recoveredWinners, winners);
    assert.deepEqual(f.snapshot().draws, saved.draws);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(ended.end_announcement_message_id, 'delivery-1');
    assert.deepEqual(f.attempts[0].allowedMentions, { users: winners });

    const acknowledged = await f.restart();
    assert.deepEqual(await acknowledged.listDueGiveaways(), []);
    assert.equal(await acknowledged.nextDueAt(), null);
    assert.equal((await acknowledged.getGiveaway(f.initial.giveaway_id)).end_announcement_pending, false);
    await f.finish(acknowledged);
    assert.equal(f.attempts.length, 1);
    assert.deepEqual(f.snapshot().draws, saved.draws);
});

test('JSON delivery with a lost response retries the saved draw and nonce after restart', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    f.channel.send = async payload => {
        await send(payload);
        throw new Error('Discord response lost after delivery');
    };
    const [pending, winners] = await f.finish();
    const savedDraws = f.snapshot().draws;
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.delivered.size, 1);

    f.channel.send = send;
    const restored = await f.restart();
    const [ended, recoveredWinners] = await f.finish(restored);
    assert.deepEqual(recoveredWinners, winners);
    assert.deepEqual(f.snapshot().draws, savedDraws);
    assert.equal(f.attempts.length, 2);
    assert.equal(f.attempts[0].nonce, f.attempts[1].nonce);
    assert.equal(f.attempts[1].enforceNonce, true);
    assert.equal(f.delivered.size, 1);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(ended.end_announcement_message_id, 'delivery-1');
});

test('an expired manual end response remains pending and recovers through channel delivery after restart', async t => {
    const f = fixture(t);
    const replies = [];
    const interaction = { deferred: true, replied: false, async editReply(payload) {
        replies.push(payload);
        throw new Error('interaction expired');
    } };
    const [pending, winners] = await f.finish(f.store, { announceInteraction: interaction });
    const savedDraws = f.snapshot().draws;
    assert.equal(replies.length, 1);
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.attempts.length, 0);
    assert.deepEqual(replies[0].allowedMentions, { users: winners });

    const restored = await f.restart();
    const [ended, recoveredWinners] = await f.finish(restored);
    assert.equal(f.attempts.length, 1);
    assert.deepEqual(recoveredWinners, winners);
    assert.deepEqual(f.snapshot().draws, savedDraws);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.snapshot().giveaways[f.initial.giveaway_id].end_announcement_message_id, 'delivery-1');
});
