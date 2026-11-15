'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { createGiveawayStore, endGiveaway, startGiveawayLoop } = require('../events/giveaways');
const Giveaways = require('../commands/giveaways');

// Pending-delivery logging is deduplicated per giveaway for the whole process, so log tests use their own IDs.
function fixture(t, { winners = 2, entries = 6, giveawayId = 'delivery-recovery' } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-giveaway-delivery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dataFile = path.join(directory, 'giveaways.json');
    const initial = {
        giveaway_id: giveawayId, guild_id: 'guild', channel_id: 'channel', message_id: null,
        prize: 'Prize', winners_total: winners, status: 'active', winner_user_ids: [],
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        ends_at: new Date(Date.now() - 60000).toISOString()
    };
    const makeStore = () => createGiveawayStore({ storageMode: 'json', dataFile,
        db: { async query() { assert.fail('JSON delivery recovery must not query MySQL'); } } });
    const store = makeStore();
    store.localSaveGiveaway(initial.giveaway_id, initial, false);
    for (let index = 0; index < entries; index++) {
        const userId = String(100000000000000000n + BigInt(index));
        store.localSaveEntry(initial.giveaway_id, userId, {
            user_id: userId, joined_at: initial.starts_at, left_at: null
        }, false);
    }
    const attempts = [], delivered = new Map();
    const channel = { messages: { fetch: async query => typeof query === 'object' ? [...delivered.values()].reverse() : null }, async send(payload) {
        attempts.push(payload);
        if (payload.enforceNonce && delivered.has(payload.nonce)) return delivered.get(payload.nonce);
        const message = { id: `delivery-${delivered.size + 1}`, content: payload.content, author: { id: 'bot' }, createdTimestamp: Date.now() };
        delivered.set(payload.nonce || message.id, message);
        return message;
    } };
    const client = { user: { id: 'bot' }, channels: { cache: { get: () => channel }, fetch: async () => channel } };
    const finish = (activeStore = store, options = {}) => endGiveaway(client, { giveawayStore: activeStore }, initial,
        { drawType: 'end', ...options });
    const restart = async () => {
        const restored = makeStore();
        await restored.restore();
        return restored;
    };
    const snapshot = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return { initial, store, channel, client, finish, restart, snapshot, attempts, delivered };
}

function mockHistory(f, messages) {
    const requests = [];
    f.channel.messages.fetch = async query => {
        if (typeof query !== 'object') return messages.find(message => message.id === query) || null;
        requests.push(query);
        const start = query.before ? messages.findIndex(message => message.id === query.before) + 1 : 0;
        assert.ok(!query.before || start > 0, 'The history cursor must refer to the preceding page');
        return new Map(messages.slice(start, start + query.limit).map(message => [message.id, message]));
    };
    return requests;
}

function traffic(count, createdTimestamp = Date.now() + 1000) {
    return Array.from({ length: count }, (_, index) => ({
        id: `traffic-${index}`, content: 'Unrelated message', author: { id: 'other-user' }, createdTimestamp
    }));
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
    assert.deepEqual(f.attempts[0].allowedMentions, { parse: [], users: winners, roles: [], repliedUser: false });

    const acknowledged = await f.restart();
    assert.deepEqual(await acknowledged.listDueGiveaways(), []);
    assert.equal(await acknowledged.nextDueAt(), null);
    assert.equal((await acknowledged.getGiveaway(f.initial.giveaway_id)).end_announcement_pending, false);
    await f.finish(acknowledged);
    assert.equal(f.attempts.length, 1);
    assert.deepEqual(f.snapshot().draws, saved.draws);
});

test('JSON delivery with a lost response waits for history before confirming the saved draw after restart', async t => {
    const f = fixture(t);
    const fetch = f.channel.messages.fetch;
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
    f.channel.messages.fetch = async () => null;
    const restored = await f.restart();
    const [waiting] = await f.finish(restored);
    assert.equal(waiting.end_announcement_pending, true);
    assert.equal(f.attempts.length, 1);
    f.channel.messages.fetch = fetch;
    const [ended, recoveredWinners] = await f.finish(restored);
    assert.deepEqual(recoveredWinners, winners);
    assert.deepEqual(f.snapshot().draws, savedDraws);
    assert.equal(f.attempts.length, 1);
    assert.equal(f.attempts[0].enforceNonce, true);
    assert.equal(f.delivered.size, 1);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(ended.end_announcement_message_id, 'delivery-1');
});

test('an unsent notification retries with the same nonce after history confirms its absence', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    let nonce;
    f.channel.send = async payload => { nonce = payload.nonce; throw new Error('Discord unavailable'); };
    const [pending] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    f.channel.send = send;
    const [finished] = await f.finish(await f.restart());
    assert.equal(finished.end_announcement_pending, false);
    assert.equal(f.attempts[0].nonce, nonce);
    assert.equal(f.attempts[0].enforceNonce, true);
});

test('recovery finds a delivered notification beyond the latest 100 messages', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    f.channel.send = async payload => { await send(payload); throw new Error('Discord response lost'); };
    await f.finish();
    const delivered = [...f.delivered.values()][0];
    const requests = mockHistory(f, [...traffic(230), delivered, ...traffic(100, delivered.createdTimestamp - 120000)]);
    f.channel.send = send;
    const [finished] = await f.finish(await f.restart());
    assert.equal(finished.end_announcement_pending, false);
    assert.equal(finished.end_announcement_message_id, delivered.id);
    assert.equal(f.attempts.length, 1);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(query => query.limit === 100 && query.cache === false));
    assert.equal(requests[1].before, 'traffic-99');
    assert.equal(requests[2].before, 'traffic-199');
});

test('a failed later history page keeps an uncertain notification pending without sending again', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    f.channel.send = async payload => { await send(payload); throw new Error('Discord response lost'); };
    await f.finish();
    const messages = [...traffic(150), ...f.delivered.values()];
    mockHistory(f, messages);
    const fetch = f.channel.messages.fetch;
    f.channel.messages.fetch = async query => {
        if (query.before) throw new Error('History unavailable');
        return fetch(query);
    };
    f.channel.send = send;
    const restored = await f.restart();
    const [pending] = await f.finish(restored);
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.attempts.length, 1);
    f.channel.messages.fetch = fetch;
    const [finished] = await f.finish(restored);
    assert.equal(finished.end_announcement_pending, false);
    assert.equal(f.attempts.length, 1);
});

test('the 5000-message cap preserves found receipts and leaves unconfirmed batches pending', async t => {
    const f = fixture(t, { winners: 100, entries: 100 });
    const send = f.channel.send;
    f.channel.send = async payload => { await send(payload); throw new Error('Discord response lost'); };
    await f.finish();
    const delivered = [...f.delivered.values()][0];
    const requests = mockHistory(f, [delivered, ...traffic(5100)]);
    f.channel.send = send;
    const [pending] = await f.finish(await f.restart());
    assert.equal(pending.end_announcement_pending, true);
    assert.deepEqual(pending.end_notification_receipts, { 0: delivered.id });
    assert.equal(f.attempts.length, 1);
    assert.equal(requests.length, 50);
});

test('a slow history lookup stops between pages without authorizing a send', async t => {
    const f = fixture(t);
    let now = Date.now(), lookups = 0;
    t.mock.method(Date, 'now', () => now);
    f.channel.messages.fetch = async () => {
        lookups++;
        now += 20001;
        return traffic(100, now);
    };
    const [pending] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(lookups, 1);
    assert.equal(f.attempts.length, 0);
});

test('history stops before the draw and does not reuse an older identical announcement', async t => {
    const f = fixture(t);
    const send = f.channel.send;
    let content;
    f.channel.send = async payload => { content = payload.content; throw new Error('Discord unavailable'); };
    const [pending] = await f.finish();
    const oldTimestamp = Date.parse(pending.ended_at) - 120000;
    const oldMessage = { id: 'old-announcement', author: { id: 'bot' }, content, createdTimestamp: oldTimestamp };
    const messages = [...traffic(100), oldMessage, ...traffic(200, oldTimestamp).map(message => ({ ...message, id: `old-${message.id}` }))];
    const requests = mockHistory(f, messages);
    f.channel.send = send;
    const [finished] = await f.finish(await f.restart());
    assert.equal(finished.end_announcement_pending, false);
    assert.equal(finished.end_announcement_message_id, 'delivery-1');
    assert.equal(requests.length, 2);
    assert.equal(f.attempts.length, 1);
});

test('history with a repeated cursor cannot authorize an uncertain send', async t => {
    const f = fixture(t);
    f.channel.messages.fetch = async () => traffic(100);
    const [pending] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.attempts.length, 0);
});

test('missing history permission keeps delivery pending even when Discord would return an empty page', async t => {
    const f = fixture(t);
    f.channel.permissionsFor = () => ({ has: () => false });
    const [pending] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.attempts.length, 0);
});

test('a partial 100-winner announcement resumes after restart without repeating confirmed pings', async t => {
    const f = fixture(t, { winners: 100, entries: 100 });
    const send = f.channel.send;
    let calls = 0;
    f.channel.send = async payload => {
        if (++calls === 2) throw new Error('Discord unavailable');
        return send(payload);
    };
    const [pending, winners] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(Object.keys(pending.end_notification_receipts).length, 1);
    assert.equal(f.delivered.size, 1);
    f.channel.send = send;
    const restored = await f.restart();
    const [ended, recovered] = await f.finish(restored);
    assert.deepEqual(recovered, winners);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.delivered.size, 2);
    assert.deepEqual(f.attempts.flatMap(payload => payload.allowedMentions.users), winners);
});

test('a partial 500-winner announcement resumes all remaining batches after restart', async t => {
    const f = fixture(t, { winners: 500, entries: 500 });
    const send = f.channel.send;
    let calls = 0;
    f.channel.send = async payload => { if (++calls === 3) throw new Error('Discord unavailable'); return send(payload); };
    const [pending, winners] = await f.finish();
    assert.equal(winners.length, 500);
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(Object.keys(pending.end_notification_receipts).length, 2);
    f.channel.send = send;
    const [finished, recovered] = await f.finish(await f.restart());
    assert.equal(finished.end_announcement_pending, false);
    assert.deepEqual(recovered, winners);
    assert.deepEqual(f.attempts.flatMap(payload => payload.allowedMentions.users), winners);
    assert.ok(f.attempts.every(payload => payload.content.length <= 2000 && payload.allowedMentions.users.length <= 100));
});

test('a delivered batch with a failed receipt is found before retrying', async t => {
    const f = fixture(t, { winners: 100, entries: 100 });
    const update = f.store.updateGiveaway.bind(f.store);
    f.store.updateGiveaway = async (id, fields, options) => {
        if (fields.end_notification_receipts) throw new Error('receipt unavailable');
        return update(id, fields, options);
    };
    const [pending, winners] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(f.delivered.size, 1);
    const restored = await f.restart();
    const [ended] = await f.finish(restored);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.delivered.size, 2);
    assert.deepEqual(f.attempts.flatMap(payload => payload.allowedMentions.users), winners);
});

test('a partial reroll resumes its saved draw after restart', async t => {
    const f = fixture(t, { winners: 100, entries: 200 });
    await f.finish();
    const send = f.channel.send;
    let calls = 0;
    f.channel.send = async payload => {
        if (++calls === 2) throw new Error('Discord unavailable');
        return send(payload);
    };
    const [pending, winners, draw] = await f.finish(f.store, { drawType: 'reroll', winnerCount: 100 });
    assert.equal(pending.reroll_announcement.draw_id, draw.draw_id);
    assert.equal(Object.keys(pending.reroll_announcement.receipts).length, 1);
    f.channel.send = send;
    const restored = await f.restart();
    const [ended, recovered] = await f.finish(restored, { drawType: 'reroll-recovery' });
    assert.deepEqual(recovered, winners);
    assert.equal(ended.reroll_announcement, null);
    assert.equal(f.delivered.size, 4);
    assert.deepEqual(f.attempts.slice(2).flatMap(payload => payload.allowedMentions.users), winners);
});

test('a small reroll with a lost delivery response is found before retrying', async t => {
    const f = fixture(t, { winners: 2, entries: 4 });
    await f.finish();
    const send = f.channel.send;
    f.channel.send = async payload => { await send(payload); throw new Error('Discord response lost'); };
    const [pending, winners] = await f.finish(f.store, { drawType: 'reroll', winnerCount: 2 });
    assert.ok(pending.reroll_announcement);
    f.channel.send = send;
    const restored = await f.restart();
    const [finished, recovered] = await f.finish(restored, { drawType: 'reroll-recovery' });
    assert.deepEqual(recovered, winners);
    assert.equal(finished.reroll_announcement, null);
    assert.equal(f.delivered.size, 2);
    assert.equal(f.attempts.length, 2);
});

test('reroll recovery scans older history once for all remaining winner batches', async t => {
    const f = fixture(t, { winners: 100, entries: 200 });
    await f.finish();
    const send = f.channel.send;
    f.channel.send = async payload => { await send(payload); throw new Error('Discord response lost'); };
    const [pending, winners] = await f.finish(f.store, { drawType: 'reroll', winnerCount: 100 });
    assert.ok(pending.reroll_announcement);
    const requests = mockHistory(f, [...traffic(220), ...[...f.delivered.values()].reverse()]);
    f.channel.send = send;
    const [finished, recovered] = await f.finish(await f.restart(), { drawType: 'reroll-recovery' });
    assert.equal(finished.reroll_announcement, null);
    assert.deepEqual(recovered, winners);
    assert.deepEqual(f.attempts.slice(2).flatMap(payload => payload.allowedMentions.users), winners);
    assert.equal(requests.length, 3);
});

test('a reserved reroll survives a draw write failure and resumes without choosing again', async t => {
    const f = fixture(t, { winners: 26, entries: 52 });
    await f.finish();
    const save = f.store.saveDraw.bind(f.store);
    f.store.saveDraw = async (id, draw, options) => {
        if (draw.draw_type === 'reroll') throw new Error('draw write failed');
        return save(id, draw, options);
    };
    await assert.rejects(f.finish(f.store, { drawType: 'reroll', winnerCount: 26 }), /draw write failed/);
    const pending = (await f.store.getGiveaway(f.initial.giveaway_id)).reroll_announcement;
    assert.equal(pending.draw.winner_user_ids.length, 26);
    const restored = await f.restart();
    const edits = [];
    const source = { id: 'reserved-reroll-source', channelId: f.initial.channel_id,
        async reply(payload) { return f.channel.send(payload); }, async edit(payload) { edits.push(payload); } };
    await restored.updateGiveaway(f.initial.giveaway_id, { message_id: source.id });
    f.channel.messages.fetch = async target => typeof target === 'object' ? [...f.delivered.values()] : source;
    const [finished, winners] = await f.finish(restored, { drawType: 'reroll-recovery' });
    assert.deepEqual(winners, pending.draw.winner_user_ids);
    assert.equal(finished.reroll_announcement, null);
    assert.deepEqual(f.attempts.at(-1).allowedMentions.users, winners);
    assert.equal(edits.length, 1);
    const buttons = edits[0].components.flatMap(row => row.toJSON().components);
    const key = crypto.createHash('sha256').update(pending.draw_id).digest('hex').slice(0, 16);
    assert.equal(buttons[1].custom_id, `cc_giveaway:winners:${f.initial.giveaway_id}:${key}`);
});

test('the scheduler resumes a pending reroll after a restart', async t => {
    const f = fixture(t, { winners: 21, entries: 42 });
    await f.finish();
    const send = f.channel.send;
    f.channel.send = async () => { throw new Error('Discord unavailable'); };
    const [pending, winners] = await f.finish(f.store, { drawType: 'reroll', winnerCount: 21 });
    assert.ok(pending.reroll_announcement);
    const restored = await f.restart();
    f.channel.send = send;
    let complete;
    const delivered = new Promise(resolve => { complete = resolve; });
    const update = restored.updateGiveaway.bind(restored);
    restored.updateGiveaway = async (...args) => {
        const result = await update(...args);
        if (result?.reroll_announcement === null) complete(result);
        return result;
    };
    t.after(() => f.client.giveawayLoop?.stop());
    startGiveawayLoop(f.client, { giveawayStore: restored });
    let timer;
    const finished = await Promise.race([delivered, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Pending reroll was not recovered')), 3000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(finished.reroll_announcement, null);
    assert.deepEqual(f.attempts.at(-1).allowedMentions.users, winners);
});

function officerInteraction(f, changes = {}) {
    const replies = [], deferrals = [];
    const interaction = { client: f.client, user: { id: 'staff', username: 'Officer' },
        member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
        options: { getString: () => f.initial.giveaway_id, getInteger: () => null },
        async deferReply(options) { deferrals.push(options); this.deferred = true; },
        async editReply(payload) { replies.push(payload); return { id: 'private-reply' }; },
        async followUp() { assert.fail('The private command response must be edited in place'); },
        ...changes };
    return { interaction, replies, deferrals };
}

function captureLogs(t) {
    const warnings = [], logs = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    t.mock.method(console, 'log', message => logs.push(message));
    return { warnings, logs };
}

test('an identical reroll inside the clock-skew allowance is announced instead of reusing the previous reroll', async t => {
    const f = fixture(t, { winners: 1, entries: 1, giveawayId: 'identical-rerolls' });
    // Discord message IDs grow over time; the previous reroll's newest ID bounds the next lookup.
    const send = f.channel.send;
    f.channel.send = async payload => {
        const message = await send(payload);
        message.id = String(1300000000000000000n + BigInt(f.delivered.size));
        return message;
    };
    await f.finish();
    const [first, firstWinners] = await f.finish(f.store, { drawType: 'reroll' });
    assert.equal(first.last_reroll_announcement_message_id, '1300000000000000002');
    const restored = await f.restart();
    const [second, secondWinners] = await f.finish(restored, { drawType: 'reroll' });
    assert.deepEqual(secondWinners, firstWinners);
    assert.equal(f.attempts.length, 3);
    assert.equal(f.attempts[2].content, f.attempts[1].content);
    assert.equal(second.reroll_announcement, null);
    assert.equal(second.last_reroll_announcement_message_id, '1300000000000000003');
    assert.deepEqual(f.attempts[2].allowedMentions.users, secondWinners);
});

test('a manual end of an unversioned pending announcement pings every winner in one channel message', async t => {
    const f = fixture(t, { winners: 60, entries: 60, giveawayId: 'unversioned-manual-end' });
    const winners = Array.from({ length: 60 }, (_, index) => String(100000000000000000n + BigInt(index)));
    const drawnAt = new Date(Date.now() - 30000).toISOString();
    const drawId = `${f.initial.giveaway_id}:end`;
    // Neither record has a notification version field; every pending announcement uses the current layout.
    f.store.localSaveDraw(drawId, { draw_id: drawId, giveaway_id: f.initial.giveaway_id, draw_type: 'end',
        drawn_at: drawnAt, eligible_count: 60, winner_user_ids: winners }, false);
    f.store.localSaveGiveaway(f.initial.giveaway_id, { ...f.initial, status: 'ended', ended_at: drawnAt,
        winner_user_ids: winners, end_draw_id: drawId, end_announcement_pending: true }, false);
    const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
    const { interaction, replies, deferrals } = officerInteraction(f);
    await command.end(interaction);
    assert.deepEqual(deferrals, [{ flags: MessageFlags.Ephemeral }]);
    assert.equal(f.attempts.length, 1);
    assert.ok(f.attempts[0].content.startsWith('### 🎉  Giveaway ended!\n- **60 winners** won **Prize**!\n\n<@'));
    assert.deepEqual(f.attempts[0].allowedMentions, { parse: [], users: winners, roles: [], repliedUser: false });
    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /^Ended Giveaway:/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
    const saved = await f.store.getGiveaway(f.initial.giveaway_id);
    assert.equal(saved.end_announcement_pending, false);
    assert.equal(saved.end_announcement_message_id, 'delivery-1');
});

test('a stuck announcement logs each new coded reason once and then its delivery, without error payloads', async t => {
    const f = fixture(t, { giveawayId: 'stuck-delivery' });
    const { warnings, logs } = captureLogs(t);
    const pending = reason => `[CC LOG] Giveaway stuck-delivery winner announcement is pending (${reason}). Delivery will retry automatically.`;
    f.channel.permissionsFor = () => ({ has: flag => flag !== PermissionFlagsBits.ReadMessageHistory });
    await f.finish();
    await f.finish();
    assert.deepEqual(warnings, [pending('missing Read Message History permission')]);
    delete f.channel.permissionsFor;
    const send = f.channel.send;
    f.channel.send = async () => {
        throw Object.assign(new Error('Missing Permissions {"content":"private request body"}'), { code: 50013, status: 403 });
    };
    const [stillPending] = await f.finish();
    assert.equal(stillPending.end_announcement_pending, true);
    assert.deepEqual(warnings.slice(1), [pending('Discord error 50013 Missing Permissions')]);
    f.channel.send = async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    };
    await f.finish();
    assert.deepEqual(warnings.slice(2), [pending('ECONNRESET')]);
    assert.ok(warnings.every(message => !/private request body|socket hang up/.test(message)));
    f.channel.send = send;
    const [delivered] = await f.finish();
    assert.equal(delivered.end_announcement_pending, false);
    assert.equal(warnings.length, 3);
    assert.deepEqual(logs.filter(message => message.includes('winner announcement')),
        ['[CC LOG] Giveaway stuck-delivery winner announcement delivered.']);
});

test('a programming error during delivery surfaces and leaves the saved draw pending for recovery', async t => {
    const f = fixture(t, { giveawayId: 'delivery-bug' });
    const { warnings } = captureLogs(t);
    const send = f.channel.send;
    f.channel.send = async () => { throw new TypeError('Cannot read properties of undefined'); };
    await assert.rejects(f.finish(), TypeError);
    const saved = await f.store.getGiveaway(f.initial.giveaway_id);
    assert.equal(saved.status, 'ended');
    assert.equal(saved.end_announcement_pending, true);
    assert.deepEqual(warnings, []);
    f.channel.send = send;
    const [ended, winners] = await f.finish(await f.restart());
    assert.equal(ended.end_announcement_pending, false);
    assert.deepEqual(winners, saved.winner_user_ids);
});

test('deleting a giveaway with a pending announcement clears its delivery alert', async t => {
    const f = fixture(t, { giveawayId: 'deleted-while-pending' });
    const { warnings, logs } = captureLogs(t);
    f.channel.send = async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); };
    const [pending] = await f.finish();
    assert.equal(pending.end_announcement_pending, true);
    assert.equal(warnings.length, 1);
    const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
    const { interaction, replies } = officerInteraction(f);
    await command.delete(interaction);
    assert.match(replies[0], /^Deleted \*\*/);
    assert.deepEqual(logs.filter(message => message.includes('winner announcement')),
        ['[CC LOG] Giveaway deleted-while-pending winner announcement cancelled because the giveaway was deleted.']);
    assert.deepEqual(await f.store.listDueGiveaways(), []);
});
