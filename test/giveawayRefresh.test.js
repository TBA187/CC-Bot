'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handleGiveawayButton, refreshGiveawayMessage } = require('../events/giveaways');

const copy = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
let fixtureNumber = 0;

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t) {
    fixtureNumber += 1;
    let now = Date.UTC(2026, 9, 17) + fixtureNumber * 1000000;
    const timers = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { callback, due: now + delay };
        timers.push(timer);
        return timer;
    });
    const active = {
        giveaway_id: `refresh-${fixtureNumber}`,
        guild_id: 'guild', channel_id: 'channel', message_id: `message-${fixtureNumber}`,
        prize: 'Prize', winners_total: 1, status: 'active',
        starts_at: '2026-10-16T00:00:00.000Z', ends_at: '2026-10-18T00:00:00.000Z',
        winner_user_ids: []
    };
    let current = copy(active);
    const edits = [];
    const store = {
        async getGiveaway(id) {
            assert.equal(id, active.giveaway_id);
            return copy(current);
        },
        async listEntries(id, options) {
            assert.equal(id, active.giveaway_id);
            assert.deepEqual(options, { activeOnly: true });
            return [{ user_id: '123456789012345678' }];
        }
    };
    const message = {
        id: active.message_id, channelId: active.channel_id,
        async edit(payload) {
            edits.push({ at: now, payload });
            return message;
        }
    };
    const channel = { messages: { fetch: async id => {
        assert.equal(id, message.id);
        return message;
    } } };
    const client = { channels: { cache: { get: () => channel } } };
    const advance = async milliseconds => {
        now += milliseconds;
        const due = timers.filter(timer => timer.due <= now);
        for (const timer of due) {
            timers.splice(timers.indexOf(timer), 1);
            timer.callback();
        }
        await turn();
    };
    const drain = async promise => {
        let finished = false;
        promise.then(() => { finished = true; }, () => { finished = true; });
        for (let attempt = 0; attempt < 20 && !finished; attempt += 1) {
            await turn();
            if (timers.length) await advance(Math.max(0, Math.min(...timers.map(timer => timer.due)) - now));
        }
        assert.equal(finished, true, 'refresh should finish without unbounded retries');
        return promise;
    };
    const end = (winner = '123456789012345678') => {
        current = { ...current, status: 'ended', ended_at: new Date(now).toISOString(), winner_user_ids: [winner] };
        return copy(current);
    };
    return {
        active, store, message, channel, edits, timers, advance, drain, end,
        refresh: (giveaway = active, options = {}) => refreshGiveawayMessage(client, { giveawayStore: store }, giveaway, options),
        update: changes => { current = { ...current, ...changes }; },
        remove: () => { current = null; }
    };
}

function assertEnded(payload, winner = '123456789012345678') {
    assert.equal(payload.content, '**🎉  Giveaway Ended!**');
    const controls = payload.components.flatMap(row => row.toJSON().components);
    assert.deepEqual(controls.map(control => control.custom_id), ['cc_giveaway:participants']);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    const embed = payload.embeds[0].toJSON();
    assert.ok(embed.fields.some(field => field.name === '❌ Giveaway ended!'));
    assert.ok(embed.fields.some(field => field.value.includes(`<@${winner}>`)));
}

test('a late Join/Leave refresh renders the saved end instead of its active snapshot', async t => {
    const f = fixture(t);
    f.end();
    await f.drain(f.refresh(f.active, { disabled: false }));
    assert.equal(f.edits.length, 1);
    assertEnded(f.edits[0].payload);
});

test('coalesced end and stale entry refreshes stay ended after a delayed message fetch', async t => {
    const f = fixture(t);
    const fetch = deferred();
    f.channel.messages.fetch = async () => { await fetch.promise; return f.message; };
    const first = f.refresh();
    await turn();
    const final = f.refresh(f.end(), { disabled: true });
    const stale = f.refresh(f.active);
    assert.equal(final, first);
    assert.equal(stale, first);
    fetch.resolve();
    await f.drain(first);
    assert.equal(f.edits.length, 2);
    f.edits.forEach(edit => assertEnded(edit.payload));
    assert.equal(f.edits[1].at - f.edits[0].at, 6500);
});

test('an in-flight active edit finishes before the final ended edit, preserving edit pacing', async t => {
    const f = fixture(t);
    const sent = deferred();
    const completed = deferred();
    const originalEdit = f.message.edit;
    let inFlight = 0;
    f.message.edit = async payload => {
        inFlight += 1;
        assert.equal(inFlight, 1, 'edits must not overlap');
        await originalEdit(payload);
        if (f.edits.length === 1) {
            sent.resolve();
            await completed.promise;
        }
        inFlight -= 1;
        return f.message;
    };
    const first = f.refresh();
    await turn();
    await f.advance(0);
    await sent.promise;
    assert.match(f.edits[0].payload.content, /Active Giveaway/);
    const final = f.refresh(f.end(), { disabled: true });
    f.refresh(f.active);
    completed.resolve();
    await f.drain(final);
    await first;
    assert.equal(f.edits.length, 2);
    assertEnded(f.edits[1].payload);
    assert.equal(f.edits[1].at - f.edits[0].at, 6500);
});

test('refresh reads stored state after the edit delay and uses the latest reroll winners', async t => {
    const f = fixture(t);
    await f.drain(f.refresh());
    const waiting = f.refresh();
    await turn();
    assert.equal(f.timers.length, 1);
    f.end('223456789012345678');
    await f.advance(6499);
    assert.equal(f.edits.length, 1);
    await f.advance(1);
    await waiting;
    assert.equal(f.edits.length, 2);
    assertEnded(f.edits[1].payload, '223456789012345678');
    assert.equal(f.edits[1].at - f.edits[0].at, 6500);
});

test('a delayed participant read cannot resurrect active controls after the stored end', async t => {
    const f = fixture(t);
    const entries = deferred();
    f.store.listEntries = () => entries.promise;
    const waiting = f.refresh();
    await turn();
    await f.advance(0);
    f.end();
    entries.resolve([]);
    await waiting;
    assert.equal(f.edits.length, 1);
    assertEnded(f.edits[0].payload);
});

test('a removed stored giveaway is not recreated by an old refresh snapshot', async t => {
    const f = fixture(t);
    f.remove();
    await f.drain(f.refresh());
    assert.equal(f.edits.length, 0);
});

test('a reroll completed during participant lookup updates the winner button and count', async t => {
    const f = fixture(t);
    f.end('123456789012345678');
    const firstTime = '2026-10-17T00:01:00.000Z', latestTime = '2026-10-17T00:02:00.000Z';
    const firstWinners = Array.from({ length: 26 }, (_, index) => String(123456789012345678n + BigInt(index)));
    const latestWinners = Array.from({ length: 26 }, (_, index) => String(223456789012345678n + BigInt(index)));
    f.update({ end_draw_id: 'saved-end', last_rerolled_at: firstTime, winner_user_ids: firstWinners });
    const lookup = deferred();
    f.store.listEntries = () => lookup.promise;
    const waiting = f.refresh();
    await turn();
    await f.advance(0);
    f.end('223456789012345678');
    f.update({ last_rerolled_at: latestTime, winner_user_ids: latestWinners });
    f.store.listDraws = async () => [
        { draw_id: 'first-reroll', draw_type: 'reroll', drawn_at: firstTime, winner_user_ids: firstWinners },
        { draw_id: 'latest-reroll', draw_type: 'reroll', drawn_at: latestTime, winner_user_ids: latestWinners }
    ];
    lookup.resolve([{ user_id: '123456789012345678' }]);
    await waiting;
    assert.equal(f.edits.length, 1);
    const payload = f.edits[0].payload;
    assert.match(payload.content, /Giveaway Ended/);
    assert.equal(payload.embeds[0].toJSON().fields.find(field => field.name === '🏆 Winners (26)').value,
        '**26 winners!**');
    const buttons = payload.components.flatMap(row => row.toJSON().components);
    assert.equal(buttons.length, 2);
    assert.equal(buttons[1].label, 'View Winners');
    const latestKey = crypto.createHash('sha256').update('latest-reroll').digest('hex').slice(0, 16);
    assert.equal(buttons[1].custom_id, `cc_giveaway:winners:${f.active.giveaway_id}:${latestKey}`);
    const drawKey = crypto.createHash('sha256').update('first-reroll').digest('hex').slice(0, 16);
    let winnerPage;
    await handleGiveawayButton({
        customId: `cc_giveaway:winners:${f.active.giveaway_id}:${drawKey}`, guildId: 'guild', user: { id: 'viewer' }, message: { id: f.message.id },
        async deferReply() {}, async editReply(result) { winnerPage = result; }
    }, { giveawayStore: f.store });
    assert.equal(winnerPage.embeds[0].toJSON().title, 'Rerolled Winners (26) — Page 1/1');
    assert.match(winnerPage.embeds[0].toJSON().description, /<@223456789012345678>/);
});
