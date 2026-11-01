// Checks crown history matching without connecting to Discord or changing storage.
const assert = require('node:assert/strict');
const test = require('node:test');
const { findCrownHistoryMessage } = require('../commands/pvp-king/utils/pvpHistoryMessages.js');

const eventTime = Date.parse('2026-10-19T12:00:00Z');
const history = { king_id: '123456789012345678', type: 'crown', streak_after: 1,
    total_wins_after: 7, created_at: '2026-10-19 12:00:00' };

function crownMessage(id, { server = 'Gold', legacy = false, type = 'crown', time = eventTime + 5000 } = {}) {
    return { id, author: { id: 'bot' }, createdTimestamp: time, embeds: [{
        description: `### 👑\u2002<@${history.king_id}> ${type === 'defense' ? 'defended' : 'conquered'} the PvP Throne${legacy ? '' : ` in ${server}`}!\u2002${type === 'defense' ? '🛡️' : '⚔️'}`,
        footer: { text: `CC PvP King System${legacy ? '' : ` • ${server}`}` },
        fields: [{ name: `🔥\u2002Current Win Streak: ${history.streak_after}` }, { name: `🏆\u2002Total Wins: ${history.total_wins_after}` }],
        timestamp: new Date(time).toISOString()
    }] };
}

function threadWith(messages) {
    const requests = [];
    return { requests, messages: { fetch: async options => {
        requests.push(options);
        const start = options.before ? messages.findIndex(message => message.id === options.before) + 1 : 0;
        return new Map(messages.slice(start, start + options.limit).map(message => [message.id, message]));
    } } };
}

const find = (thread, options = {}) => findCrownHistoryMessage(thread, { history, botUserId: 'bot', serverName: 'Gold', ...options });

test('finds the crown among moderator posts, other bots, webhooks and unrelated crown entries', async () => {
    const target = crownMessage('target');
    const moderator = { ...crownMessage('moderator'), author: { id: 'moderator' } };
    const otherBot = { ...crownMessage('other-bot'), author: { id: 'other-bot' } };
    const webhook = { ...crownMessage('webhook'), webhookId: 'hook' };
    const differentWins = crownMessage('different-wins');
    differentWins.embeds[0].fields[1].name = '🏆 Total Wins: 6';
    const otherKing = crownMessage('other-king');
    otherKing.embeds[0].description = otherKing.embeds[0].description.replace(history.king_id, '987654321012345678');
    const thread = threadWith([moderator, otherBot, webhook, differentWins, otherKing,
        crownMessage('wrong-server', { server: 'Silver' }), crownMessage('wrong-type', { type: 'defense' }), target]);
    assert.deepEqual(await find(thread), { status: 'found', message: target });
    assert.deepEqual(thread.requests, [{ limit: 100, cache: false }]);
});

test('recognizes defenses separately from new crowns', async () => {
    const target = crownMessage('defense', { type: 'defense' });
    assert.equal((await find(threadWith([crownMessage('crown'), target]), { history: { ...history, type: 'defense' } })).message, target);
});

test('history posted before the rebrand remains identifiable for both servers', async () => {
    for (const serverName of ['Gold', 'Silver']) {
        const target = crownMessage('old-brand', { server: serverName });
        target.embeds[0].footer.text = `WW PvP King System • ${serverName}`;
        assert.equal((await find(threadWith([target]), { serverName })).message, target);
    }
});

test('legacy unlabeled history is accepted only for Gold', async () => {
    const legacy = crownMessage('legacy', { legacy: true });
    assert.equal((await find(threadWith([legacy]))).message, legacy);
    assert.equal((await find(threadWith([legacy]), { serverName: 'Silver' })).status, 'missing');
    legacy.embeds[0].footer.text = 'CC PvP King Dominion';
    assert.equal((await find(threadWith([legacy]))).message, legacy);
});

test('compares stored SQL UTC strings, ISO UTC timestamps and Dates as the same instant', async () => {
    const target = crownMessage('target');
    for (const created_at of [history.created_at, '2026-10-19T12:00:00.000Z', new Date(eventTime)]) {
        assert.equal((await find(threadWith([target]), { history: { ...history, created_at } })).message, target);
    }
});

test('does not match malformed dates, wrong stats or missing bot identity', async () => {
    for (const options of [{ history: { ...history, created_at: '2026-02-31 12:00:00' } },
        { history: { ...history, created_at: null } }, { history: { ...history, streak_after: undefined } },
        { history: { ...history, type: 'unknown' } }, { botUserId: '' }]) {
        const thread = threadWith([crownMessage('target')]);
        assert.equal((await find(thread, options)).status, 'missing');
        assert.equal(thread.requests.length, 0);
    }
});

test('rejects similar entries outside the event delivery window or with mismatched embed time', async () => {
    const early = crownMessage('earlier', { time: eventTime - 1 });
    const late = crownMessage('later', { time: eventTime + 15 * 60 * 1000 + 1 });
    const wrongStamp = crownMessage('wrong-stamp');
    wrongStamp.embeds[0].timestamp = new Date(eventTime - 1).toISOString();
    assert.equal((await find(threadWith([late, wrongStamp, early]))).status, 'missing');
});

test('refuses two plausible entries instead of choosing the newest', async () => {
    assert.equal((await find(threadWith([crownMessage('newer'), crownMessage('older')]))).status, 'ambiguous');
});

test('paginates sequentially past newer moderator posts and checks the rest of the event window', async () => {
    const moderators = Array.from({ length: 150 }, (_, index) => ({ id: `moderator-${index}`,
        author: { id: 'moderator' }, createdTimestamp: eventTime + 6000 }));
    const target = crownMessage('target');
    const thread = threadWith([...moderators, target]);
    assert.equal((await find(thread)).message, target);
    assert.deepEqual(thread.requests, [{ limit: 100, cache: false }, { limit: 100, cache: false, before: 'moderator-99' }]);
});

test('does not accept a first-page match when another plausible entry is on the next page', async () => {
    const filler = Array.from({ length: 99 }, (_, index) => ({ id: `moderator-${index}`, createdTimestamp: eventTime + 6000 }));
    const thread = threadWith([crownMessage('first'), ...filler, crownMessage('second')]);
    assert.equal((await find(thread)).status, 'ambiguous');
    assert.equal(thread.requests.length, 2);
});

test('deduplicates overlapping pages without treating one message as two matches', async () => {
    const target = crownMessage('target');
    const page = [target, ...Array.from({ length: 99 }, (_, index) => ({ id: `moderator-${index}`, createdTimestamp: eventTime + 6000 }))];
    let requests = 0;
    const thread = { messages: { fetch: async () => new Map((++requests === 1 ? page : [target]).map(message => [message.id, message])) } };
    assert.equal((await find(thread)).message, target);
    assert.equal(requests, 2);
});

test('a stalled page or scan limit cannot be mistaken for a unique match', async () => {
    const target = crownMessage('target');
    const page = [target, ...Array.from({ length: 99 }, (_, index) => ({ id: `moderator-${index}`, createdTimestamp: eventTime + 6000 }))];
    let requests = 0;
    const stalled = { messages: { fetch: async () => { requests++; return new Map(page.map(message => [message.id, message])); } } };
    assert.equal((await find(stalled)).status, 'incomplete');
    assert.equal(requests, 2);
    const bounded = threadWith([target, ...Array.from({ length: 1000 }, (_, index) => ({ id: `message-${index}`, createdTimestamp: eventTime + 6000 }))]);
    assert.equal((await find(bounded)).status, 'incomplete');
    assert.equal(bounded.requests.length, 10);
});

test('stops after messages older than the event and propagates Discord fetch errors', async () => {
    const target = crownMessage('target');
    const thread = threadWith([target, ...Array.from({ length: 199 }, (_, index) => ({ id: `older-${index}`, createdTimestamp: eventTime - 1000 }))]);
    assert.equal((await find(thread)).message, target);
    assert.equal(thread.requests.length, 1);
    const error = Object.assign(new Error('Missing permissions'), { code: 50013 });
    await assert.rejects(find({ messages: { fetch: async () => { throw error; } } }), error);
});
