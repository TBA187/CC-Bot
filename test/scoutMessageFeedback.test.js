// Exercises public parsing feedback, edit retries, and cleanup after a bot restart.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutMessageFeedback, completeSingleMessage, feedbackOutcome, reviewFeedbackText } = require('../features/pvp-scouting/ScoutMessageFeedback.js');
const { PvpScoutIngestor, canArchiveMessage, buildGroupLinks } = require('../features/pvp-scouting/PvpScoutIngestor.js');
const { PvpScoutStore, MISSING_TEAM_REASON } = require('../features/pvp-scouting/PvpScoutStore.js');
const { extractScoutData } = require('../features/pvp-scouting/PvpScoutParser.js');

const ID = '1554691886654955681';
const ROOT = '1554691886654955600';
const BOT = '999999999999999999';
const CHANNEL = '1180559470435246132';

function scout(patch = {}) {
    return { message_id: ID, root_message_id: ID, channel_id: CHANNEL, author_id: 'member',
        created_at: new Date(), classification: 'scout', review_status: 'not_required',
        opponent_ign: 'Blacku', ign_normalized: 'blacku', attachments: [],
        team_text: '- Gliscor: Toxic', ...patch };
}

function fixture(patch = {}) {
    const rows = new Map([[ID, scout(patch)]]);
    const states = new Map();
    const windows = new Map();
    const jobs = new Map();
    const messages = new Map();
    const sent = [], removed = [], edited = [], deleted = [], reacted = [];
    let nextReply = 100, pendingEdit = null;
    function source(id = ID) {
        const value = { id, channelId: CHANNEL, author: { id: 'member', bot: false }, reactions: { cache: new Map() },
            async react(emoji) { reacted.push({ id, emoji }); value.reactions.cache.set(emoji, { me: true }); },
            async reply(payload) {
                sent.push(payload);
                const reply = { id: String(nextReply++), author: { id: BOT, bot: true }, content: payload.content,
                    reference: { messageId: id }, async edit(change) { edited.push(change); reply.content = change.content; },
                    async delete() { deleted.push(reply.id); messages.delete(reply.id); } };
                messages.set(reply.id, reply);
                return reply;
            } };
        messages.set(id, value);
        return value;
    }
    const message = source();
    const channel = { messages: { async fetch(id) {
        if (!messages.has(String(id))) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return messages.get(String(id));
    } } };
    const client = { user: { id: BOT }, channels: { cache: new Map([[CHANNEL, channel]]) },
        rest: { async delete(route) {
            removed.push(route);
            for (const msg of messages.values()) {
                if (route.includes(`/messages/${msg.id}/`)) {
                    const emoji = decodeURIComponent(route.split('/').at(-2));
                    msg.reactions?.cache.delete(emoji);
                }
            }
        } } };
    const store = {
        async reserveCorrectionWindow(id, _channelId, { reopenResolved = false } = {}) {
            if (!windows.has(String(id)) || reopenResolved && windows.get(String(id)).status === 'resolved') {
                windows.set(String(id), { message_id: String(id), channel_id: CHANNEL,
                    started_at_ms: null, due_at_ms: null, status: 'waiting' });
            }
        },
        async startCorrectionWindow(id, started, duration) {
            await this.reserveCorrectionWindow(id); const window = windows.get(String(id));
            if (window.status === 'waiting' && window.started_at_ms == null) {
                window.started_at_ms = started; window.due_at_ms = started + duration;
            }
            return { ...window };
        },
        async getCorrectionWindow(id) { return windows.get(String(id)) || null; },
        async pendingCorrectionWindows() { return [...windows.values()].filter(w => w.status !== 'resolved'); },
        async resolveCorrectionWindow(id) { const w = windows.get(String(id)); if (w) w.status = 'resolved'; },
        async escalateCorrectionWindow(id, now) {
            const w = windows.get(String(id)), row = rows.get(String(id));
            if (!w || w.status !== 'waiting' || w.due_at_ms > now || row?.review_status !== 'pending' || row.is_deleted) return false;
            w.status = 'escalated'; return true;
        },
        async getMessage(id) { return rows.get(String(id)) || null; },
        async sourcesForRoots(ids) {
            return [...rows.values()].filter(row => ids.includes(row.root_message_id) && !row.is_deleted)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || (BigInt(a.message_id) > BigInt(b.message_id) ? 1 : -1));
        },
        async scheduleMessageFeedback(root, author, id, due) {
            const key = `${root}:${author}`, before = jobs.get(key);
            const job = { channel_id: CHANNEL, root_message_id: root, author_id: author,
                latest_message_id: id, due_at_ms: due, revision: (before?.revision || 0) + 1,
                publication_notified: before && BigInt(id) <= BigInt(before.latest_message_id) ? before.publication_notified : 0 };
            if (before && BigInt(id) < BigInt(before.latest_message_id)) {
                job.latest_message_id = before.latest_message_id; job.due_at_ms = before.due_at_ms;
            }
            jobs.set(key, job); return { ...job };
        },
        async getMessageFeedbackJob(root, author) { return jobs.get(`${root}:${author}`) || null; },
        async pendingMessageFeedback() { return [...jobs.values()]; },
        async clearMessageFeedbackJob(job) {
            const key = `${job.root_message_id}:${job.author_id}`;
            if (jobs.get(key)?.revision === job.revision) jobs.delete(key);
        },
        async claimPublicationLog(job) {
            const current = jobs.get(`${job.root_message_id}:${job.author_id}`);
            if (!current || current.revision !== job.revision || current.publication_notified) return false;
            current.publication_notified = 1; return true;
        },
        async ensureReportTeamPresence(id, hasInformation) {
            const root = rows.get(id);
            if (!root || root.reviewed_by_id || root.staffOverrides?.locked) return;
            if (hasInformation && root.review_reason === MISSING_TEAM_REASON) {
                root.review_status = 'not_required'; root.review_reason = null;
            } else if (!hasInformation && root.review_status === 'not_required') {
                root.review_status = 'pending'; root.review_reason = MISSING_TEAM_REASON;
            }
        },
        async getEditReview() { return pendingEdit; },
        async getMessageFeedback(id) { return states.get(String(id)) || null; },
        async saveMessageFeedback(id, state) { states.set(String(id), { message_id: String(id), ...state }); },
        async clearMessageFeedback(id) { states.delete(String(id)); },
        async messageFeedbackForReport(root) {
            return [...states.values()].filter(state => rows.get(state.message_id)?.root_message_id === root);
        }
    };
    const makeFeedback = options => new ScoutMessageFeedback({ client, store, channelId: CHANNEL, ...options });
    return { rows, states, jobs, windows, messages, sent, removed, edited, deleted, reacted, message, source, client, store,
        feedback: makeFeedback(), makeFeedback, setEdit: value => { pendingEdit = value; } };
}

test('a successfully parsed live scout receives thumbs up without a reply', async () => {
    const f = fixture();
    await f.feedback.refreshReport(ID, f.message, true);
    assert.deepEqual(f.reacted, [{ id: ID, emoji: '👍' }]);
    assert.equal(f.sent.length, 0);
    assert.equal(f.states.get(ID).reaction, '👍');
});

test('an unresolved scout gets one public reply with its reason and original-message edit instructions', async () => {
    const f = fixture({ classification: 'review', review_status: 'pending', opponent_ign: null,
        review_reason: 'Could not identify the opponent IGN in the message or screenshot.' });
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.sent.length, 1);
    const payload = f.sent[0];
    assert.match(payload.content, /Could not identify the opponent IGN/u);
    assert.match(payload.content, /Opponent IGN: PlayerName/u);
    assert.match(payload.content, /original scout message/u);
    assert.match(payload.content, /don’t need to reply/u);
    assert.match(payload.content, /^⚠️ \*\*This Scout Report needs review\.\*\*/u);
    assert.match(payload.content, /The scout message couldn't be confidently verified/u);
    assert.match(payload.content, /Please edit \*\*your original scout message\*\* with these changes, and your scout report will be processed again/u);
    assert.match(payload.content, /this reply will be deleted and the 👎 reaction will be replaced with 👍/u);
    assert.doesNotMatch(payload.content, /\bI(?:’ll| couldn’t|\s)|\bmy\b/u);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
    assert.equal(payload.flags, undefined, 'the reply is a regular public message');
    assert.equal(payload.enforceNonce, true);
    assert.ok(payload.nonce.length <= 25);
    assert.equal(f.states.get(ID).feedback_message_id, '100');
});

test('repeated failures edit the existing reply instead of sending another', async () => {
    const f = fixture({ review_status: 'pending', review_reason: 'Opponent IGN was inferred from an unlabeled line.' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.rows.get(ID).review_reason = 'Check Pokémon spelling: Glissor.';
    await f.feedback.refreshReport(ID, f.message, true);
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.edited.length, 1);
    assert.match(f.edited[0].content, /Check Pokémon spelling/u);
});

test('a successful retry removes only the bot thumbs down and deletes its feedback reply', async () => {
    const f = fixture({ review_status: 'pending', review_reason: 'Opponent IGN was inferred from an unlabeled line.' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.rows.set(ID, scout());
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.removed.length, 1);
    assert.match(f.removed[0], /%F0%9F%91%8E\/@me$/u);
    assert.deepEqual(f.deleted, ['100']);
    assert.equal(f.states.get(ID).feedback_message_id, null);
    assert.equal(f.states.get(ID).reaction, '👍');
});

test('feedback survives a helper restart and can be cleaned up after officer approval', async () => {
    const f = fixture({ review_status: 'pending' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.rows.get(ID).review_status = 'confirmed';
    const restarted = f.makeFeedback();
    await restarted.refreshReport(ID);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.deleted, ['100']);
    assert.equal(f.states.get(ID).reaction, '👍');
});

test('a missing feedback reply is recreated once, while unrelated saved IDs are protected', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture({ review_status: 'pending' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.messages.delete('100');
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.sent.length, 2);
    const reply = f.messages.get('101');
    reply.author.id = 'another-member';
    f.rows.get(ID).review_status = 'confirmed';
    await f.feedback.refreshReport(ID);
    assert.equal(f.deleted.length, 0, 'never delete another member’s message');
});

test('deleting the source removes the public reply and its persisted state', async () => {
    const f = fixture({ review_status: 'pending' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.messages.delete(ID);
    await f.feedback.remove(ID);
    assert.deepEqual(f.deleted, ['100']);
    assert.equal(f.states.has(ID), false);
});

test('off-topic messages and old history receive no new parsing feedback', async () => {
    const offTopic = fixture({ classification: 'ignored', opponent_ign: null, ign_normalized: null });
    await offTopic.feedback.refreshReport(ID, offTopic.message, true);
    assert.equal(offTopic.sent.length, 0);
    assert.equal(offTopic.reacted.length, 0);
    const historical = fixture({ created_at: new Date(Date.now() - 90 * 86400000), review_status: 'pending' });
    await historical.feedback.refreshReport(ID, historical.message, true);
    assert.equal(historical.sent.length, 0);
    assert.equal(historical.reacted.length, 0);
    await historical.feedback.refreshReport(ID);
    assert.equal(historical.states.size, 0);
});

test('accepted nameless supplements use their grouped report status', () => {
    const root = scout({ message_id: ROOT, root_message_id: ROOT });
    const supplement = scout({ root_message_id: ROOT, opponent_ign: null, ign_normalized: null,
        classification: 'review', review_status: 'pending',
        review_reason: 'Message looks like scouting information but the opponent IGN is unclear.' });
    assert.equal(feedbackOutcome(supplement, root).reaction, '👍');
    root.review_status = 'pending';
    root.review_reason = 'Opponent IGN was inferred from an unlabeled line.';
    assert.equal(feedbackOutcome(supplement, root).reaction, '👎');
    supplement.review_reason = 'Check Pokémon spelling: Glissor.';
    root.review_status = 'confirmed';
    assert.equal(feedbackOutcome(supplement, root).reaction, '👎');
});

function parsedRow(id, content, patch = {}) {
    const parsed = extractScoutData({ content, attachments: patch.attachments || [] });
    return scout({ message_id: id, root_message_id: id, message_content: content,
        classification: parsed.classification, review_status: parsed.reviewStatus, review_reason: parsed.reviewReason,
        opponent_ign: parsed.ign, ign_normalized: parsed.ignNormalized, team_text: parsed.teamText, ...patch });
}

function feedbackClock(t) {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    t.mock.timers.enable(['setTimeout']);
    return { async advance(ms, feedback) {
        now += ms; t.mock.timers.tick(ms); await feedback.drain();
        await Promise.allSettled([...feedback.corrections.running.values()]);
    } };
}

test('five same-author messages stay quiet until a minute after the last, then receive one reaction', async t => {
    const clock = feedbackClock(t);
    for (const gap of [15_000, 45_000]) {
        const f = fixture();
        const texts = ['Opponent IGN: Blacku', 'Gliscor: Toxic, Protect', 'Slowbro: Scald, Teleport',
            'Tyranitar: Stone Edge', 'Kommo-o z'];
        f.rows.clear();
        const rows = [];
        for (let index = 0; index < texts.length; index++) {
            if (index) await clock.advance(gap, f.feedback);
            const row = parsedRow(String(BigInt(ID) + BigInt(index)), texts[index], { created_at: new Date(Date.now()) });
            rows.push(row);
            const groups = buildGroupLinks(rows);
            for (const link of groups.links) rows.find(source => source.message_id === link.messageId).root_message_id = link.rootMessageId;
            f.rows.set(row.message_id, row);
            await f.feedback.observeMessage(f.source(row.message_id));
            assert.equal(f.reacted.length, 0);
            assert.equal(f.sent.length, 0);
        }
        await clock.advance(59_999, f.feedback);
        assert.equal(f.reacted.length, 0);
        await clock.advance(1, f.feedback);
        assert.deepEqual(f.reacted, [{ id: rows.at(-1).message_id, emoji: '👍' }]);
        assert.equal(f.states.size, 1);
        assert.equal(f.jobs.size, 0);
        assert.equal(f.sent.length, 0);
        await f.feedback.stop();
    }
});

test('valid reports with two, four or six Pokémon work with or without screenshots', () => {
    const team = ['Gliscor: Toxic', 'Slowbro: Scald', 'Tyranitar: Stone Edge', 'Kommo-o z',
        'Magneton: Flash Cannon', 'Hoopa: Hyperspace Fury'];
    for (const count of [2, 4, 6]) {
        for (const attachments of [[], [{ name: 'team.png', contentType: 'image/png' }]]) {
            const row = parsedRow(ID, `Opponent IGN: Blacku\n${team.slice(0, count).join('\n')}`, { attachments });
            assert.equal(feedbackOutcome(row).reaction, '👍', `${count} Pokémon, ${attachments.length} screenshots`);
            assert.equal(completeSingleMessage(row), count === 6 || attachments.length > 0);
        }
    }
});

test('complete six-Pokémon scouts and named screenshots receive immediate feedback', async () => {
    const team = ['Gliscor: Toxic', 'Slowbro: Scald', 'Tyranitar: Stone Edge', 'Kommo-o z',
        'Magneton: Flash Cannon', 'Hoopa: Hyperspace Fury'];
    for (const patch of [{ team_text: team.map(line => `- ${line}`).join('\n') },
        { attachments: [{ name: 'scout.png', contentType: 'image/png' }] }]) {
        const f = fixture(patch);
        await f.feedback.observeMessage(f.message);
        assert.deepEqual(f.reacted, [{ id: ID, emoji: '👍' }]);
        assert.equal(f.jobs.size, 0);
        assert.equal(f.feedback.timers.size, 0);
    }
});

test('partial scouts without a screenshot can succeed after the quiet minute', async t => {
    const clock = feedbackClock(t), f = fixture();
    await f.feedback.observeMessage(f.message);
    assert.equal(f.reacted.length, 0);
    await clock.advance(60_000, f.feedback);
    assert.deepEqual(f.reacted, [{ id: ID, emoji: '👍' }]);
});

test('a bare IGN waits, then explains the missing team; a follow-up removes that warning', async t => {
    const clock = feedbackClock(t), f = fixture({ team_text: null });
    const alerts = [];
    f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message);
    assert.equal(f.reacted.length, 0);
    assert.equal(alerts.length, 0);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.get(ID).reaction, '👎');
    assert.match(f.sent[0].content, /contains no Pokémon team information/u);
    assert.deepEqual(alerts, []);
    const replyId = String(BigInt(ID) + 1n);
    const row = parsedRow(replyId, 'Gliscor: Toxic', { root_message_id: ID, created_at: new Date(Date.now()) });
    f.rows.set(replyId, row);
    await f.feedback.observeMessage(f.source(replyId));
    assert.equal(f.states.size, 0);
    assert.deepEqual(f.deleted, ['100']);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.size, 1);
    assert.equal(f.states.get(replyId).reaction, '👍');
    assert.equal(f.rows.get(ID).review_status, 'not_required');
});

test('an earlier failed fragment makes the final message fail, rather than approving only its own text', async t => {
    const clock = feedbackClock(t), f = fixture();
    const badId = String(BigInt(ID) + 1n), lastId = String(BigInt(ID) + 2n);
    f.rows.set(badId, scout({ message_id: badId, root_message_id: ID, opponent_ign: null,
        review_status: 'pending', review_reason: 'Check Pokémon spelling: Glissor.' }));
    f.rows.set(lastId, parsedRow(lastId, 'Slowbro: Scald', { root_message_id: ID }));
    const alerts = [];
    f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.source(lastId));
    assert.equal(f.reacted.length, 0);
    await clock.advance(60_000, f.feedback);
    assert.deepEqual(f.reacted, [{ id: lastId, emoji: '👎' }]);
    assert.match(f.sent[0].content, /Check Pokémon spelling: Glissor/u);
    assert.deepEqual(alerts, []);
    f.rows.get(badId).review_status = 'confirmed';
    await f.feedback.refreshReport(badId);
    assert.equal(f.states.get(lastId).reaction, '👍', 'officer action on an earlier fragment refreshes the final reaction');
    assert.deepEqual(f.deleted, ['100']);
});

test('a new same-author supplement removes an earlier reaction and gives feedback only on its final message', async t => {
    const clock = feedbackClock(t), f = fixture({ attachments: [{ name: 'scout.png' }] });
    await f.feedback.observeMessage(f.message);
    assert.equal(f.states.get(ID).reaction, '👍');
    await clock.advance(10_000, f.feedback);
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, created_at: new Date(Date.now()) }));
    await f.feedback.observeMessage(f.source(replyId));
    assert.equal(f.states.size, 0);
    assert.equal(f.message.reactions.cache.has('👍'), false);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.size, 1);
    assert.equal(f.states.get(replyId).reaction, '👍');
});

test('another member’s supplements wait separately and retain the original reporter’s reaction', async t => {
    const clock = feedbackClock(t), f = fixture({ attachments: [{ name: 'scout.png' }] });
    await f.feedback.observeMessage(f.message);
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, author_id: 'contributor' }));
    const reply = f.source(replyId); reply.author.id = 'contributor';
    await f.feedback.observeMessage(reply);
    assert.equal(f.states.get(ID).reaction, '👍');
    assert.equal(f.states.has(replyId), false);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.get(replyId).reaction, '👍');
    assert.equal(f.states.get(ID).reaction, '👍');
});

test('a contributor’s feedback about a pending officer edit does not create a new-report staff alert', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending',
        review_reason: 'The author edited this Scout Report; an officer must approve the changes.' });
    const alerts = [];
    f.feedback.onReview = async id => { alerts.push(id); };
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, author_id: 'contributor' }));
    const message = f.source(replyId); message.author.id = 'contributor';
    await f.feedback.observeMessage(message);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.get(replyId).reaction, '👎');
    assert.match(f.sent[0].content, /awaiting officer approval/u);
    assert.deepEqual(alerts, []);
});

test('pending waits resume after restart without treating archived reports as new feedback', async t => {
    const clock = feedbackClock(t), f = fixture();
    await f.feedback.observeMessage(f.message);
    await clock.advance(30_000, f.feedback);
    await f.feedback.stop();
    assert.equal(f.jobs.size, 1);
    const restarted = f.makeFeedback();
    await restarted.restorePending();
    await clock.advance(29_999, restarted);
    assert.equal(f.reacted.length, 0);
    await clock.advance(1, restarted);
    assert.deepEqual(f.reacted, [{ id: ID, emoji: '👍' }]);
    assert.equal(f.jobs.size, 0);
});

test('failed edits reuse the same public explanation, and a successful retry deletes it', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', opponent_ign: null, ign_normalized: null,
        review_reason: 'Could not identify the opponent IGN in the message or screenshot.' });
    await f.feedback.observeMessage(f.message);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.sent.length, 1);
    f.rows.get(ID).review_reason = 'Check Pokémon spelling: Glissor.';
    await f.feedback.observeMessage(f.message);
    assert.equal(f.message.reactions.cache.has('👎'), false);
    assert.equal(f.deleted.length, 0);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.sent.length, 1);
    assert.equal(f.edited.length, 1);
    assert.match(f.edited[0].content, /Check Pokémon spelling/u);
    f.rows.set(ID, scout({ attachments: [{ name: 'scout.png' }] }));
    await f.feedback.observeMessage(f.message);
    assert.equal(f.sent.length, 1);
    assert.equal(f.states.get(ID).reaction, '👍');
    assert.deepEqual(f.deleted, ['100']);
});

test('a grouped live scout produces one publication log with the root ID and final source', async t => {
    const clock = feedbackClock(t), f = fixture();
    const publications = [];
    f.feedback.onPublished = async event => { publications.push(event); };
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Slowbro: Scald', { root_message_id: ID }));
    await f.feedback.observeMessage(f.source(replyId));
    assert.equal(publications.length, 0);
    await clock.advance(60_000, f.feedback);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].reportId, ID);
    assert.equal(publications[0].messageId, replyId);
    assert.equal(publications[0].ign, 'Blacku');
    assert.equal(publications[0].sources.length, 2);
    await f.feedback.refreshReport(replyId);
    assert.equal(publications.length, 1);
});

test('publication logs survive reaction failures without repeating after feedback helper restart', async t => {
    t.mock.method(console, 'warn', () => {});
    const clock = feedbackClock(t), f = fixture({ attachments: [{ name: 'scout.png' }] });
    const publications = [], callback = async event => { publications.push(event); };
    f.feedback.onPublished = callback;
    const react = f.message.react;
    f.message.react = async () => { throw new Error('Missing reaction permission'); };
    await f.feedback.observeMessage(f.message);
    assert.equal(publications.length, 1, 'a saved valid scout is logged even when reacting fails');
    assert.equal([...f.jobs.values()][0].publication_notified, 1);
    await f.feedback.stop();
    f.message.react = react;
    const restarted = f.makeFeedback({ onPublished: callback });
    await restarted.restorePending();
    await clock.advance(60_000, restarted);
    assert.equal(publications.length, 1);
    assert.equal(f.states.get(ID).reaction, '👍');
});

test('failed scouts and archived historical rows never generate publication notifications', async t => {
    const clock = feedbackClock(t);
    for (const patch of [{ review_status: 'pending', review_reason: 'Opponent IGN was inferred from an unlabeled line.' },
        { created_at: new Date(Date.now() - 90 * 86400000) }]) {
        const f = fixture(patch), publications = [];
        f.feedback.onPublished = async event => { publications.push(event); };
        await f.feedback.observeMessage(f.message);
        await clock.advance(60_000, f.feedback);
        assert.equal(publications.length, 0);
    }
});

test('a stale timer cannot react before a newer message’s quiet period has elapsed', async t => {
    const clock = feedbackClock(t), f = fixture();
    await f.feedback.observeMessage(f.message);
    const oldJob = { ...[...f.jobs.values()][0] };
    await clock.advance(45_000, f.feedback);
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, created_at: new Date(Date.now()) }));
    await f.feedback.observeMessage(f.source(replyId));
    await f.feedback.finishJob(oldJob);
    await clock.advance(59_999, f.feedback);
    assert.equal(f.reacted.length, 0);
    await clock.advance(1, f.feedback);
    assert.deepEqual(f.reacted, [{ id: replyId, emoji: '👍' }]);
});

test('a failed Discord reaction retains its pending job and retries without losing the scout', async t => {
    t.mock.method(console, 'warn', () => {});
    const clock = feedbackClock(t), f = fixture({ attachments: [{ name: 'scout.png' }] });
    const react = f.message.react;
    f.message.react = async () => { throw new Error('temporary Discord failure'); };
    await f.feedback.observeMessage(f.message);
    assert.equal(f.jobs.size, 1);
    assert.equal(f.rows.get(ID).review_status, 'not_required');
    f.message.react = react;
    await clock.advance(60_000, f.feedback);
    assert.equal(f.states.get(ID).reaction, '👍');
    assert.equal(f.jobs.size, 0);
});

test('slow parsing of an incoming follow-up prevents feedback on the earlier incomplete message', async t => {
    const clock = feedbackClock(t), f = fixture();
    await f.feedback.observeMessage(f.message);
    await clock.advance(30_000, f.feedback);
    const replyId = String(BigInt(ID) + 1n), message = f.source(replyId);
    f.feedback.beginMessage(message);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.reacted.length, 0, 'do not react while the next screenshot is still being parsed');
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, created_at: new Date(Date.now()) }));
    f.feedback.endMessage(message);
    await f.feedback.observeMessage(message);
    await clock.advance(60_000, f.feedback);
    assert.deepEqual(f.reacted, [{ id: replyId, emoji: '👍' }]);
    assert.equal(f.feedback.inFlight.size, 0);
});

test('timers inspect newer saved fragments even before their feedback observation finishes', async t => {
    const clock = feedbackClock(t), f = fixture();
    await f.feedback.observeMessage(f.message);
    const replyId = String(BigInt(ID) + 1n);
    f.rows.set(replyId, parsedRow(replyId, 'Gliscor: Substitute', { root_message_id: ID, created_at: new Date(Date.now()) }));
    f.source(replyId);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.reacted.length, 0);
    assert.equal([...f.jobs.values()][0].latest_message_id, replyId);
    await clock.advance(60_000, f.feedback);
    assert.deepEqual(f.reacted, [{ id: replyId, emoji: '👍' }]);
});

test('standalone off-topic messages, historical rows and bot replies do not create feedback jobs', async t => {
    const clock = feedbackClock(t);
    for (const patch of [
        { classification: 'ignored', opponent_ign: null, ign_normalized: null, team_text: null },
        { created_at: new Date(Date.now() - 90 * 86400000) }
    ]) {
        const f = fixture(patch);
        await f.feedback.observeMessage(f.message);
        await clock.advance(60_000, f.feedback);
        assert.equal(f.reacted.length, 0);
        assert.equal(f.sent.length, 0);
        assert.equal(f.jobs.size, 0);
    }
    const f = fixture(); f.message.author.bot = true;
    await f.feedback.observeMessage(f.message);
    assert.equal(f.jobs.size, 0);
});

test('feedback job writes scope the author and report, and stale completions cannot clear newer jobs', async () => {
    const calls = [], job = { channel_id: CHANNEL, root_message_id: ID, author_id: 'member', revision: 3 };
    const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql, params) {
        calls.push({ sql, params }); return sql.trim().startsWith('SELECT') ? [[job]] : [{ affectedRows: 0 }];
    } } });
    store.schemaReady = true;
    await store.scheduleMessageFeedback(ID, 'member', ID, 123456);
    assert.deepEqual(calls[0].params, [CHANNEL, ID, 'member', ID, 123456]);
    assert.match(calls[0].sql, /revision = revision \+ 1/u);
    assert.match(calls[0].sql, /CAST\(VALUES\(latest_message_id\) AS UNSIGNED\) >= CAST\(latest_message_id AS UNSIGNED\)/u);
    assert.deepEqual(calls[1].params, [CHANNEL, ID, 'member']);
    await store.pendingMessageFeedback();
    assert.deepEqual(calls[2].params, [CHANNEL]);
    await store.clearMessageFeedbackJob(job);
    assert.deepEqual(calls[3].params, [CHANNEL, ID, 'member', 3]);
    assert.match(calls[3].sql, /AND revision = \?/u);
    await store.ensureReportTeamPresence(ID, false);
    assert.deepEqual(calls[4].params, [MISSING_TEAM_REASON, CHANNEL, ID]);
    assert.match(calls[4].sql, /review_status = 'not_required'/u);
    assert.match(calls[4].sql, /reviewed_by_id IS NULL/u);
    assert.match(calls[4].sql, /\$\.locked/u);
    await store.ensureReportTeamPresence(ID, true);
    assert.deepEqual(calls[5].params, [CHANNEL, ID, MISSING_TEAM_REASON]);
    assert.match(calls[5].sql, /review_reason = \?/u);
    assert.equal(await store.claimPublicationLog(job), false);
    assert.deepEqual(calls[6].params, [CHANNEL, ID, 'member', 3]);
    assert.match(calls[6].sql, /AND revision = \? AND publication_notified = 0/u);
});

test('startup keeps an unfinished IGN-only live report in review rather than publishing its header', async () => {
    const raw = scout({ message_content: 'Opponent IGN: Blacku', attachments_json: '[]',
        ocr_json: '[]', team_text: null, review_status: 'pending', review_reason: MISSING_TEAM_REASON,
        content_hash: 'header', ign_confidence: 0.99, ign_source: 'text_label' });
    let reads = 0;
    const updates = [];
    const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql, params) {
        if (sql.includes('SELECT m.*')) return [reads++ ? [] : [raw]];
        if (sql.includes('SET classification')) updates.push({ sql, params });
        return [{ affectedRows: 1 }];
    } } });
    store.schemaReady = true;
    store.knownIgnEvidence = async () => [];
    store.staffReviewLearning = async () => null;
    await store.refreshAutomaticRecords();
    assert.equal(updates.length, 1);
    for (const update of updates) {
        assert.equal(update.params[8], 'pending');
        assert.equal(update.params[9], MISSING_TEAM_REASON);
    }
});

test('catch-up imports and groups missed messages before resuming saved feedback timers', async () => {
    const order = [];
    const { RuntimeActivity } = require('../utils/runtimeActivity.js');
    const activity = new RuntimeActivity();
    const ingestor = new PvpScoutIngestor({ client: {}, store: {}, channelId: CHANNEL, ocr: {}, activity,
        feedback: { async restorePending() { order.push('feedback'); } } });
    ingestor.catchUpMessages = async () => {
        assert.equal(activity.snapshot().active[0].name, 'PvP Scout gold: catch-up');
        order.push('catchup');
    };
    await ingestor.startCatchup();
    assert.deepEqual(order, ['catchup', 'feedback']);
    assert.equal(activity.snapshot().active.length, 0);
    assert.equal(activity.snapshot().recent.length, 1);
});

test('an idle ingestion queue releases its last result while returning it to the caller', async () => {
    const ingestor = new PvpScoutIngestor({ client: {}, store: {}, ocr: {}, feedback: {} });
    const result = { archived: 'payload' };
    assert.equal(await ingestor.enqueue(async () => result), result);
    assert.equal(await ingestor.queue, undefined);
});

test('a clear same-author IGN follow-up resolves nameless team text without overriding officer decisions', async () => {
    for (const protectedRoot of [false, true]) {
        const calls = [];
        const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql, params) {
            calls.push({ sql, params }); return [{ affectedRows: 1 }];
        } } });
        store.schemaReady = true;
        store.getMessage = async id => id === ROOT ? scout({ message_id: ROOT, root_message_id: ROOT,
            opponent_ign: null, ign_normalized: null, review_status: 'pending',
            review_reason: 'Message looks like scouting information but the opponent IGN is unclear.',
            reviewed_by_id: protectedRoot ? 'officer' : null }) : scout({ ign_confidence: 0.99 });
        await store.promoteRootIgn(ROOT, ID);
        assert.equal(calls[0].params[4], !protectedRoot);
        assert.equal(calls[0].params[5], !protectedRoot);
    }
});

test('another member’s valid reply gets thumbs up, while an unresolved reply gets public feedback', async () => {
    const f = fixture();
    const replyId = String(BigInt(ID) + 1n);
    const root = f.rows.get(ID);
    const reply = parsedRow(replyId, 'Gliscor: Substitute', { author_id: 'another-member', reply_to_id: ID });
    const groups = buildGroupLinks([root, reply]);
    assert.deepEqual(groups.links.map(link => link.rootMessageId), [ID]);
    reply.root_message_id = ID;
    f.rows.set(replyId, reply);
    const message = f.source(replyId);
    message.author.id = 'another-member';
    await f.feedback.refreshReport(replyId, message, true);
    assert.equal(f.states.get(replyId).reaction, '👍');
    assert.equal(f.sent.length, 0);
    reply.review_reason = 'Check Pokémon spelling: Glissor.';
    await f.feedback.refreshReport(replyId, message, true);
    assert.equal(f.states.get(replyId).reaction, '👎');
    assert.match(f.sent[0].content, /Check Pokémon spelling/u);
    assert.match(f.sent[0].content, /^⚠️/u);
});

test('a named follow-up clears earlier screenshot feedback when the grouped report becomes valid', async () => {
    const f = fixture({ message_id: ID, root_message_id: ID, review_status: 'pending' });
    await f.feedback.refreshReport(ID, f.message, true);
    f.rows.get(ID).review_status = 'not_required';
    const followId = '1554691886654955699';
    f.rows.set(followId, scout({ message_id: followId, root_message_id: ID }));
    await f.feedback.refreshReport(followId, f.source(followId), true);
    assert.equal(f.states.get(ID).reaction, '👍');
    assert.deepEqual(f.deleted, ['100']);
    assert.equal(f.sent.length, 1);
});

test('pending edits describe the approval requirement instead of promising automatic publication', async () => {
    const f = fixture({ review_status: 'pending',
        review_reason: 'The author edited this Scout Report; an officer must approve the changes.' });
    f.setEdit({ status: 'pending', after: { reviewReason: null } });
    await f.feedback.refreshReport(ID, f.message, true);
    assert.match(f.sent[0].content, /awaiting officer approval/u);
    assert.match(f.sent[0].content, /required officer review has been completed/u);
    assert.doesNotMatch(f.sent[0].content, /exact IGN on the first line/u);
});

test('feedback text stays within the public message limit and suppresses unwanted mentions', () => {
    const content = reviewFeedbackText({ reason: 'different multiple author guild member IGN screenshot Pokémon spam '.repeat(50) });
    assert.ok(content.length <= 2000, `feedback was ${content.length} characters`);
});

test('a reply retained after a failed state write is reused on retry', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture({ review_status: 'pending' });
    const save = f.store.saveMessageFeedback;
    f.store.saveMessageFeedback = async () => { throw new Error('MySQL unavailable'); };
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.sent.length, 1);
    f.store.saveMessageFeedback = save;
    await f.feedback.refreshReport(ID, f.message, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.states.get(ID).feedback_message_id, '100');
    assert.equal(f.feedback.unsaved.size, 0);
});

test('bot feedback is excluded from ingestion while valid /scout submissions remain supported', async () => {
    const message = { id: ID, channelId: CHANNEL, author: { id: BOT, bot: true },
        content: '👎 Could not identify IGN. Gliscor: Toxic', embeds: [] };
    assert.equal(canArchiveMessage(message, BOT), false);
    assert.equal(canArchiveMessage({ ...message, author: { id: 'another-bot', bot: true } }, BOT), false);
    assert.equal(canArchiveMessage({ ...message, author: { id: 'member', bot: false } }, BOT), true);
    const ingestor = new PvpScoutIngestor({ client: { user: { id: BOT } }, store: {}, channelId: CHANNEL, ocr: {} });
    ingestor.buildRecord = async () => assert.fail('Feedback messages must never reach the parser');
    assert.equal(await ingestor.saveMessage(message), null);
    assert.equal(await ingestor.handleUpdate(message), null);
    await ingestor.handleDelete(message);
    message.embeds.push({ title: 'PvP Scout Report — Blacku', description: '- Gliscor: Toxic',
        author: { url: 'https://discord.com/users/12345', name: 'Member' } });
    assert.equal(canArchiveMessage(message, BOT), true);
});

test('Add Scout Report submissions keep officer alerts without reacting to the bot’s submitted embed', async () => {
    const f = fixture({ ign_source: 'member_submission', review_status: 'pending' });
    f.message.author = { id: BOT, bot: true };
    const ingestor = new PvpScoutIngestor({ client: f.client, store: f.store, channelId: CHANNEL, ocr: {}, feedback: f.feedback });
    ingestor.saveMessage = async () => f.rows.get(ID);
    const alerts = [];
    ingestor.notifyNewReview = async row => { alerts.push(row.message_id); };
    await ingestor.handleCreate(f.message);
    assert.deepEqual(alerts, [ID]);
    assert.equal(f.reacted.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.jobs.size, 0);
});

function editFixture(row, pendingEdit = null) {
    let currentRow = scout(row), saves = 0, staged = 0, grouped = 0, feedback = 0;
    const store = { async getMessage() { return currentRow; }, async getCorrectionWindow() { return null; }, async getEditReview() { return pendingEdit; },
        async saveMessage(proposal) { saves++; currentRow = scout({ review_status: proposal.reviewStatus }); return currentRow; },
        async stageEditReview() { staged++; return { message_id: ID, revision: 1 }; } };
    const ingestor = new PvpScoutIngestor({ client: { user: { id: BOT } }, store, channelId: CHANNEL, ocr: {},
        feedback: { async observeMessage() { feedback++; }, async refreshReport() { feedback++; }, async drain() {} } });
    ingestor.rebuildGroups = async () => { grouped++; };
    ingestor.notifyEditReview = async () => {};
    ingestor.buildRecord = async () => ({ messageId: ID, channelId: CHANNEL, authorId: 'member', reviewStatus: 'not_required' });
    const message = { id: ID, channelId: CHANNEL, author: { id: 'member', bot: false } };
    return { ingestor, store, message, counts: () => ({ saves, staged, grouped, feedback }) };
}

test('editing an unreviewed parse failure retries and publishes without staging an officer edit', async () => {
    const f = editFixture({ classification: 'review', review_status: 'pending' });
    f.message.content = 'Opponent IGN: Blacku\nGliscor: Toxic, Protect';
    f.ingestor.buildRecord = async message => ({ messageId: ID, channelId: CHANNEL, authorId: 'member',
        ...extractScoutData({ content: message.content, attachments: [] }) });
    const saved = await f.ingestor.handleUpdate(f.message);
    assert.equal(saved.review_status, 'not_required');
    assert.deepEqual(f.counts(), { saves: 1, staged: 0, grouped: 1, feedback: 1 });
});

test('a recent pending nameless source in an unreviewed report can be corrected automatically', async () => {
    const f = editFixture({ root_message_id: ROOT, review_status: 'pending', opponent_ign: null, ign_normalized: null });
    const getMessage = f.store.getMessage;
    f.store.getMessage = async id => id === ROOT ? scout({ message_id: ROOT, root_message_id: ROOT }) : getMessage(id);
    await f.ingestor.handleUpdate(f.message);
    assert.deepEqual(f.counts(), { saves: 1, staged: 0, grouped: 1, feedback: 1 });
});

test('feedback reaction errors cannot undo a successfully archived live scout', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture();
    f.message.react = async () => { throw new Error('Missing reaction permission'); };
    const ingestor = new PvpScoutIngestor({ client: f.client, store: f.store, channelId: CHANNEL, ocr: {}, feedback: f.feedback });
    ingestor.saveMessage = async () => f.rows.get(ID);
    assert.equal((await ingestor.handleCreate(f.message)).opponent_ign, 'Blacku');
    assert.equal(f.rows.get(ID).review_status, 'not_required');
    assert.equal(f.sent.length, 0);
});

test('an unsuccessful edit remains in review and refreshes feedback', async () => {
    const f = editFixture({ classification: 'review', review_status: 'pending' });
    f.ingestor.buildRecord = async () => ({ messageId: ID, channelId: CHANNEL, authorId: 'member', reviewStatus: 'pending' });
    const saved = await f.ingestor.handleUpdate(f.message);
    assert.equal(saved.review_status, 'pending');
    assert.deepEqual(f.counts(), { saves: 1, staged: 0, grouped: 1, feedback: 1 });
});

test('edits after 24 hours, officer decisions, and pending proposals keep officer approval', async () => {
    for (const [patch, proposal] of [
        [{ review_status: 'not_required', created_at: new Date(Date.now() - 25 * 3600000) }, null],
        [{ review_status: 'confirmed', reviewed_by_id: 'officer' }, null],
        [{ review_status: 'pending', reviewed_by_id: 'officer' }, null],
        [{ review_status: 'pending', staffOverrides: { locked: true } }, null],
        [{ review_status: 'pending' }, { status: 'pending' }]
    ]) {
        const f = editFixture(patch, proposal);
        await f.ingestor.handleUpdate(f.message);
        assert.deepEqual(f.counts(), { saves: 0, staged: 1, grouped: 0, feedback: 1 });
    }
});

test('feedback database queries are scoped to the source and channel', async () => {
    const calls = [];
    const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql, params) {
        calls.push({ sql, params }); return [[{ message_id: ID, reaction: '👎' }]];
    } } });
    store.schemaReady = true;
    await store.getMessageFeedback(ID);
    await store.saveMessageFeedback(ID, { reaction: '👎', feedback_message_id: '100' });
    await store.messageFeedbackForReport(ID);
    await store.clearMessageFeedback(ID);
    assert.deepEqual(calls[0].params, [ID, CHANNEL]);
    assert.deepEqual(calls[1].params, [ID, CHANNEL, '👎', '100']);
    assert.deepEqual(calls[2].params, [CHANNEL, ID]);
    assert.deepEqual(calls[3].params, [ID, CHANNEL]);
    await assert.rejects(store.saveMessageFeedback(ID, { reaction: '❓' }), /Invalid scout feedback reaction/u);
});


test('failed reports get thumbs down now and enter staff review only one hour later', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', review_reason: 'Verify the opponent IGN.',
        attachments: [{ id: 'image', contentType: 'image/png' }] });
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    const started = Date.now();
    await f.feedback.observeMessage(f.message);
    assert.equal(f.states.get(ID).reaction, '👎');
    assert.equal(f.windows.get(ID).status, 'waiting');
    assert.equal(f.windows.get(ID).due_at_ms, started + 3_600_000);
    assert.deepEqual(alerts, []);
    assert.match(f.sent[0].content, /1 hour after the first 👎/u);
    assert.doesNotMatch(f.sent[0].content, /so it was sent to the review queue/u);
    await clock.advance(3_599_999, f.feedback); assert.deepEqual(alerts, []);
    await clock.advance(1, f.feedback);
    assert.deepEqual(alerts, [ID]); assert.equal(f.windows.get(ID).status, 'escalated');
    await f.feedback.stop();
});

test('failed edits keep the original deadline and a successful edit cancels escalation', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message); const deadline = f.windows.get(ID).due_at_ms;
    await clock.advance(30 * 60_000, f.feedback);
    f.rows.get(ID).review_reason = 'Check Pokémon spelling: Glissor.';
    await f.feedback.observeMessage(f.message);
    assert.equal(f.windows.get(ID).due_at_ms, deadline); assert.equal(f.sent.length, 1);
    assert.match(f.edited.at(-1).content, /Check Pokémon spelling/u);
    f.rows.get(ID).review_status = 'not_required'; f.rows.get(ID).review_reason = null;
    await f.feedback.observeMessage(f.message);
    assert.equal(f.states.get(ID).reaction, '👍'); assert.equal(f.windows.get(ID).status, 'resolved');
    await clock.advance(31 * 60_000, f.feedback); assert.deepEqual(alerts, []);
    await f.feedback.stop();
});

test('correction windows survive restarts without resetting their deadline', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = [];
    await f.feedback.observeMessage(f.message); const deadline = f.windows.get(ID).due_at_ms;
    await clock.advance(40 * 60_000, f.feedback); await f.feedback.stop();
    const restarted = f.makeFeedback({ onReview: async id => { alerts.push(id); } });
    await restarted.restorePending(); assert.equal(f.windows.get(ID).due_at_ms, deadline);
    await clock.advance(20 * 60_000 - 1, restarted); assert.deepEqual(alerts, []);
    await clock.advance(1, restarted); assert.deepEqual(alerts, [ID]);
    await restarted.stop();
});

test('an offline successful edit is reread before the overdue report can reach officers', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = [];
    await f.feedback.observeMessage(f.message); await f.feedback.stop();
    let reread = 0;
    const restarted = f.makeFeedback({ onReview: async id => { alerts.push(id); }, recheck: async () => {
        reread++; f.rows.get(ID).review_status = 'not_required';
    } });
    await restarted.restorePending(); await clock.advance(25 * 60 * 60_000, restarted);
    assert.equal(reread, 1); assert.deepEqual(alerts, []); assert.equal(f.windows.get(ID).status, 'resolved');
    await restarted.stop();
});

test('a crash before the first feedback reaction resumes the reserved correction window', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    await f.store.reserveCorrectionWindow(ID);
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.restorePending();
    assert.equal(f.states.get(ID).reaction, '👎'); assert.equal(f.windows.get(ID).due_at_ms, Date.now() + 3_600_000);
    await clock.advance(3_600_000, f.feedback); assert.deepEqual(alerts, [ID]);
    await f.feedback.stop();
});

test('deleted reports cancel their correction window without notifying officers', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message); f.rows.get(ID).is_deleted = true;
    await f.feedback.remove(ID); await clock.advance(3_600_000, f.feedback);
    assert.deepEqual(alerts, []); assert.equal(f.windows.get(ID).status, 'resolved');
    await f.feedback.stop();
});

test('a database outage at the deadline retries and does not lose the review', async t => {
    t.mock.method(console, 'warn', () => {});
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message);
    const get = f.store.getCorrectionWindow; f.store.getCorrectionWindow = async () => { throw new Error('MySQL offline'); };
    await clock.advance(3_600_000, f.feedback); assert.deepEqual(alerts, []);
    f.store.getCorrectionWindow = get;
    await clock.advance(60_000, f.feedback); assert.deepEqual(alerts, [ID]);
    await f.feedback.stop();
});

test('the correction deadline waits for an in-flight edit before escalating', async t => {
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    const alerts = []; f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message); f.feedback.beginMessage(f.message);
    await clock.advance(3_600_000, f.feedback); assert.deepEqual(alerts, []);
    f.rows.get(ID).review_status = 'not_required'; f.feedback.endMessage(f.message);
    await clock.advance(60_000, f.feedback); assert.deepEqual(alerts, []);
    assert.equal(f.windows.get(ID).status, 'resolved'); await f.feedback.stop();
});


function memberEditLogFixture() {
    let row = scout({ message_content: 'original bad report', review_status: 'pending',
        review_reason: 'Verify the opponent IGN.', ign_confidence: 0.4, ign_source: 'first_line' }), proposal = null;
    const logs = [];
    const store = { auditLogger: { memberEdited(event) { logs.push(structuredClone(event)); } },
        async getMessage() { return { ...row }; }, async getCorrectionWindow() { return null; },
        async getEditReview() { return proposal; }, async sourcesForRoots() { return [{ ...row }]; },
        async saveMessage(record) {
            row = { ...row, message_content: record.content, review_status: record.reviewStatus,
                review_reason: record.reviewReason, classification: record.classification,
                opponent_ign: record.ign, ign_normalized: record.ignNormalized, team_text: record.teamText,
                ign_confidence: record.ignConfidence, ign_source: record.ignSource };
            return { ...row };
        },
        async stageEditReview(before, after) {
            proposal = { message_id: ID, status: 'pending', after };
            row.review_status = 'pending'; row.review_reason = 'An officer must approve the changes.';
            return proposal;
        } };
    const ingestor = new PvpScoutIngestor({ client: { user: { id: BOT } }, store, channelId: CHANNEL, server: 'silver', ocr: {},
        feedback: { async observeMessage() {}, async refreshReport() {}, async drain() {} } });
    ingestor.rebuildGroups = async () => {}; ingestor.notifyEditReview = async () => {};
    ingestor.buildRecord = async message => ({ messageId: ID, channelId: CHANNEL, authorId: 'member', authorUsername: 'Member',
        content: message.content, sourceUrl: 'https://discord.com/channels/1/2/' + ID,
        attachments: [], teamText: 'Gliscor: Toxic', ign: 'Blacku', ignNormalized: 'blacku',
        ignConfidence: message.content.startsWith('bad') ? 0.5 : 0.98, ignSource: 'first_line',
        classification: 'scout', reviewStatus: message.content.startsWith('bad') ? 'pending' : 'not_required',
        reviewReason: message.content.startsWith('bad') ? 'Verify the opponent IGN.' : null });
    const message = { id: ID, channelId: CHANNEL, author: { id: 'member', bot: false }, attachments: new Map(), content: 'bad first edit' };
    return { ingestor, store, logs, message };
}

test('every failed member edit and the final successful correction log their own reason, confidence and before/after', async () => {
    const f = memberEditLogFixture();
    await f.ingestor.handleUpdate(f.message);
    f.message.content = 'bad second edit'; await f.ingestor.handleUpdate(f.message);
    f.message.content = 'good final edit'; await f.ingestor.handleUpdate(f.message);
    assert.equal(f.logs.length, 3); assert.deepEqual(f.logs.map(log => log.failed), [true, true, false]);
    assert.deepEqual(f.logs.map(log => log.after.content), ['bad first edit', 'bad second edit', 'good final edit']);
    assert.equal(f.logs[1].before.content, 'bad first edit');
    assert.equal(f.logs[0].after.reviewReason, 'Verify the opponent IGN.');
    assert.equal(f.logs[2].after.ignConfidence, .98); assert.equal(f.logs[2].server, 'silver');
});

test('rapid edits to Discord’s mutable cached message retain each gateway revision', async () => {
    const f = memberEditLogFixture(), build = f.ingestor.buildRecord;
    let release; const wait = new Promise(resolve => { release = resolve; });
    f.ingestor.buildRecord = async message => { await wait; return build(message); };
    const first = f.ingestor.handleUpdate(f.message);
    f.message.content = 'good second edit'; const second = f.ingestor.handleUpdate(f.message);
    release(); await Promise.all([first, second]);
    assert.deepEqual(f.logs.map(log => log.after.content), ['bad first edit', 'good second edit']);
    assert.equal(f.logs[1].before.content, 'bad first edit');
});

test('successive edits after the window closes compare against the previous proposal and suppress duplicate events', async t => {
    const f = memberEditLogFixture(); f.message.content = 'good published report';
    await f.ingestor.handleUpdate(f.message);
    const later = Date.now() + 25 * 3600000;
    t.mock.method(Date, 'now', () => later);
    f.message.content = 'good first proposed edit'; await f.ingestor.handleUpdate(f.message);
    f.message.content = 'good second proposed edit'; await f.ingestor.handleUpdate(f.message);
    await f.ingestor.handleUpdate(f.message);
    assert.equal(f.logs.length, 3); assert.equal(f.logs[2].before.content, 'good first proposed edit');
    assert.equal(f.logs[2].after.content, 'good second proposed edit'); assert.equal(f.logs[2].awaitingApproval, true);
    assert.equal(f.logs[2].failed, false);
});

test('live parser failures reserve a hidden correction window before the archive row can enter the queue', async () => {
    const queries = []; const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql) { queries.push(sql); return [{ affectedRows: 1 }]; } } });
    store.schemaReady = true; store.getMessage = async () => null;
    await store.saveMessage({ messageId: ID, channelId: CHANNEL, content: 'bad report', reviewStatus: 'pending', deferReview: true });
    assert.match(queries[0], /INSERT IGNORE INTO pvp_scout_correction_windows/u);
    assert.match(queries[1], /INSERT INTO pvp_scout_messages/u);
});

test('a fresh failed edit reopens only a resolved correction window before saving, while repeated failures keep their deadline', async () => {
    for (const status of ['not_required', 'pending']) {
        const calls = [];
        const store = new PvpScoutStore({ channelId: CHANNEL, db: { async query(sql, params) {
            calls.push({ sql, params }); return [{ affectedRows: 1 }];
        } } });
        store.schemaReady = true;
        store.getMessage = async () => scout({ review_status: status });
        await store.saveMessage({ messageId: ID, channelId: CHANNEL, authorId: 'member', content: 'bad edit',
            classification: 'review', reviewStatus: 'pending', deferReview: true });
        assert.match(calls[0].sql, /INSERT IGNORE INTO pvp_scout_correction_windows/u);
        assert.deepEqual(calls[0].params, [ID, CHANNEL, ID, CHANNEL]);
        if (status === 'not_required') {
            assert.match(calls[0].sql, /started_at_ms = IF\(status = 'resolved', NULL, started_at_ms\)/u);
            assert.match(calls[0].sql, /due_at_ms = IF\(status = 'resolved', NULL, due_at_ms\)/u);
            assert.match(calls[0].sql, /status = IF\(status = 'resolved', 'waiting', status\)/u);
        } else assert.doesNotMatch(calls[0].sql, /ON DUPLICATE KEY UPDATE/u);
        assert.match(calls[1].sql, /INSERT INTO pvp_scout_messages/u);
        calls.length = 0;
        await store.ensureReportTeamPresence(ID, false, CHANNEL, true);
        assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE/u);
        assert.match(calls[0].sql, /review_status = 'not_required'/u);
        assert.match(calls[1].sql, /UPDATE pvp_scout_messages/u);
    }
});

test('an edited successful report gets a new warning before officer escalation and repeated failed edits keep that deadline', async t => {
    const clock = feedbackClock(t), f = fixture({ attachments: [{ contentType: 'image/png' }] });
    const alerts = [];
    f.windows.set(ID, { message_id: ID, channel_id: CHANNEL, status: 'resolved',
        started_at_ms: Date.now() - 2 * 3600000, due_at_ms: Date.now() - 3600000 });
    f.feedback.onReview = async id => { alerts.push(id); };
    await f.feedback.observeMessage(f.message);
    await clock.advance(60_000, f.feedback);
    const row = f.rows.get(ID);
    row.review_status = 'pending'; row.review_reason = 'Message text and screenshot identify different opponents.';
    await f.store.reserveCorrectionWindow(ID, CHANNEL, { reopenResolved: true });
    await f.feedback.observeMessage(f.message);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].content, /different opponents/u);
    assert.match(f.sent[0].content, /What to improve/u);
    assert.deepEqual(alerts, []);
    const deadline = f.windows.get(ID).due_at_ms;
    await clock.advance(30 * 60_000, f.feedback);
    await f.feedback.observeMessage(f.message);
    await clock.advance(60_000, f.feedback);
    assert.equal(f.windows.get(ID).due_at_ms, deadline);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(alerts, []);
    await clock.advance(deadline - Date.now(), f.feedback);
    assert.deepEqual(alerts, [ID]);
    await f.feedback.stop();
});


test('timer recovery retries if MySQL is temporarily unavailable on startup', async t => {
    t.mock.method(console, 'warn', () => {});
    const clock = feedbackClock(t), f = fixture({ review_status: 'pending', attachments: [{ contentType: 'image/png' }] });
    await f.feedback.observeMessage(f.message); await f.feedback.stop();
    const pending = f.store.pendingCorrectionWindows;
    f.store.pendingCorrectionWindows = async () => { throw new Error('Database restarting'); };
    const alerts = [], restarted = f.makeFeedback({ onReview: async id => { alerts.push(id); } });
    await restarted.restorePending(); f.store.pendingCorrectionWindows = pending;
    await clock.advance(60_000, restarted); await restarted.corrections.restore();
    await clock.advance(59 * 60_000, restarted); assert.deepEqual(alerts, [ID]);
    await restarted.stop();
});
