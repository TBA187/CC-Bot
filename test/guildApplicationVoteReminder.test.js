'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const {
    GuildApplicationVoteReminder
} = require('../features/guild-applications/discord/GuildApplicationVoteReminder.js');

function collection(items) {
    return new Collection(items.map(item => [item.id, item]));
}

function applicationRecord(overrides = {}) {
    return {
        postId: '100',
        ign: 'ApplicantIGN',
        pollMessageId: 'poll-message',
        pollMessageUrl: 'https://discord.com/channels/guild/court/poll-message',
        officerMessageUrl: 'https://discord.com/channels/guild/officer/application-message',
        pollCreatedAt: '2026-07-13T00:00:00.000Z',
        voteReminder12hCheckedAt: null,
        voteReminder12hMessageId: null,
        voteReminder18hCheckedAt: null,
        voteReminder18hMessageId: null,
        ...overrides
    };
}

function createFixture({ now, record, officerCount = 5, voterIds = [], voterError = null, existingReminder = null }) {
    const saved = [];
    const sent = [];
    let candidateCalls = 0;
    const officers = Array.from({ length: officerCount }, (_, index) => ({
        id: `officer-${index + 1}`,
        user: { id: `officer-${index + 1}`, bot: false },
        roles: { cache: new Set(['officer-role']) }
    }));
    const guild = {
        members: {
            list: async () => collection(officers)
        }
    };
    const answerOneUsers = voterIds.map(id => ({ id, bot: false }));
    const answerTwoUsers = voterIds.length ? [{ id: voterIds[0], bot: false }, { id: 'outsider', bot: false }] : [];
    const pollMessage = {
        id: 'poll-message',
        poll: {
            answers: new Collection([
                [1, { voters: { fetch: async () => {
                    if (voterError) throw voterError;
                    return collection(answerOneUsers);
                } } }],
                [2, { voters: { fetch: async () => collection(answerTwoUsers) } }]
            ])
        }
    };
    const court = {
        id: 'court',
        isTextBased: () => true,
        messages: {
            fetch: async input => typeof input === 'string'
                ? pollMessage
                : new Collection(existingReminder ? [[existingReminder.id, existingReminder]] : [])
        },
        async send(payload) {
            sent.push(payload);
            return { id: `reminder-${sent.length}` };
        }
    };
    const store = {
        async voteReminderCandidates() {
            candidateCalls++;
            return [record];
        },
        async saveRecord(updated) {
            saved.push({ ...updated });
            return updated;
        }
    };
    const reminder = new GuildApplicationVoteReminder({
        client: {
            user: { id: 'bot-id' },
            guilds: { cache: new Map([['guild', guild]]), fetch: async () => guild },
            channels: { cache: new Map([['court', court]]), fetch: async () => court }
        },
        store,
        guildId: 'guild',
        courtHouseChannelID: 'court',
        officerRoleID: 'officer-role',
        clock: () => new Date(now)
    });

    return { reminder, saved, sent, getCandidateCalls: () => candidateCalls };
}

test('sends the 12-hour reminder when fewer than half of Officers have voted', async () => {
    const fixture = createFixture({
        now: '2026-07-13T12:00:00.000Z',
        record: applicationRecord(),
        officerCount: 5,
        voterIds: ['officer-1', 'officer-2']
    });

    await fixture.reminder.runOnce();

    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].content, /### \u{1F514} Vote Reminder/u);
    assert.match(fixture.sent[0].content, /It has been \*\*12 hours\*\*/);
    assert.match(fixture.sent[0].content, /application for \*\*ApplicantIGN\*\*/);
    assert.match(fixture.sent[0].content, /View Application: \[Click Here!\]/);
    assert.match(fixture.sent[0].content, /Cast your vote: \[Click Here!\]/);
    assert.deepEqual(fixture.sent[0].allowedMentions, { parse: [], roles: ['officer-role'], repliedUser: false });
    assert.deepEqual(fixture.sent[0].reply, { messageReference: 'poll-message' });
    assert.equal(fixture.saved[0].voteReminder12hMessageId, 'reminder-1');
    assert.equal(fixture.saved[0].voteReminder12hCheckedAt, '2026-07-13T12:00:00.000Z');
});

test('marks the stage checked without pinging when the rounded-up threshold is met', async () => {
    const fixture = createFixture({
        now: '2026-07-13T12:05:00.000Z',
        record: applicationRecord(),
        officerCount: 5,
        voterIds: ['officer-1', 'officer-2', 'officer-3']
    });

    await fixture.reminder.runOnce();

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.saved[0].voteReminder12hMessageId, null);
});

test('a late restart sends only the 18-hour reminder and closes the missed 12-hour stage', async () => {
    const fixture = createFixture({
        now: '2026-07-13T19:00:00.000Z',
        record: applicationRecord(),
        officerCount: 4,
        voterIds: ['officer-1']
    });

    await fixture.reminder.runOnce();

    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].content, /It has been \*\*18 hours\*\*/);
    assert.equal(fixture.saved[0].voteReminder12hCheckedAt, '2026-07-13T19:00:00.000Z');
    assert.equal(fixture.saved[0].voteReminder18hCheckedAt, '2026-07-13T19:00:00.000Z');
    assert.equal(fixture.saved[0].voteReminder18hMessageId, 'reminder-1');
});

test('poll fetch failures leave the reminder stage unchecked for a later retry', async () => {
    const fixture = createFixture({
        now: '2026-07-13T12:00:00.000Z',
        record: applicationRecord(),
        voterError: new Error('Discord unavailable')
    });

    await fixture.reminder.runOnce();

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.saved.length, 0);
});

test('recovers an already-sent vote reminder after a crash without pinging twice', async () => {
    const record = applicationRecord();
    const existingReminder = {
        id: 'existing-reminder',
        author: { id: 'bot-id' },
        content: `It has been **12 hours** ${record.pollMessageUrl}`,
        embeds: []
    };
    const fixture = createFixture({
        now: '2026-07-13T12:00:00.000Z',
        record,
        officerCount: 5,
        voterIds: ['officer-1'],
        existingReminder
    });

    await fixture.reminder.runOnce();

    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.saved[0].voteReminder12hMessageId, 'existing-reminder');
    assert.equal(fixture.saved[0].voteReminder12hCheckedAt, '2026-07-13T12:00:00.000Z');
});

test('overlapping runs share the running guard', async () => {
    const fixture = createFixture({
        now: '2026-07-13T12:00:00.000Z',
        record: applicationRecord(),
        voterIds: ['officer-1', 'officer-2', 'officer-3']
    });

    await Promise.all([fixture.reminder.runOnce(), fixture.reminder.runOnce()]);

    assert.equal(fixture.getCandidateCalls(), 1);
});
