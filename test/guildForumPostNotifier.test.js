'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    GuildForumPostNotifier,
    handleGuildForumFeedbackButton
} = require('../features/guild-applications/discord/GuildForumPostNotifier.js');

test('mentions only the owner for a newly observed non-application forum post', async () => {
    const sent = [];
    const officerChannel = {
        id: 'officer-channel',
        isTextBased: () => true,
        async send(payload) {
            sent.push(payload);
            return { id: 'owner-alert' };
        }
    };
    const notifier = new GuildForumPostNotifier({
        client: { channels: { cache: new Map([[officerChannel.id, officerChannel]]), fetch: async () => officerChannel } },
        officerChannelID: officerChannel.id,
        ownerID: 'owner-id',
        botTimezone: 'Etc/UTC'
    });
    const record = {
        postId: '100',
        postUrl: 'https://example.com/forum/#findComment-100',
        forumUsername: 'ForumApplicant',
        postedAt: '2026-07-14T12:34:56.000Z',
        rawBodyText: 'Is there still room in the guild?',
        classificationConfidence: 0.35
    };

    const result = await notifier.notify(record);
    const embed = sent[0].embeds[0].toJSON();

    assert.match(sent[0].content, /<@owner-id>/);
    assert.match(sent[0].content, /\*\*Crow Control guild application forum page\*\*/);
    assert.doesNotMatch(sent[0].content, /Application likelihood|View Forum Application/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['owner-id'] });
    const feedbackRow = sent[0].components[0].toJSON();
    assert.equal(feedbackRow.components[0].custom_id, 'guild_application_feedback:100');
    assert.equal(feedbackRow.components[0].label, 'AI Training Feedback');
    assert.equal(feedbackRow.components[0].style, 1);
    assert.equal(feedbackRow.components[0].emoji.name, '⭐');
    assert.doesNotMatch(sent[0].content, /officer-role/i);
    assert.equal(embed.color, 0xe63b50);
    assert.equal(embed.title, undefined);
    assert.equal(embed.url, undefined);
    assert.equal(embed.footer.text, 'Forum Post Created: July 14, 2026 12:34');
    assert.deepEqual(embed.fields.map(field => field.name), [
        'Probability Score',
        'Posted by Vangogsan',
        'View Forum Application',
        'Forum Username',
        'Message Content'
    ]);
    assert.equal(embed.fields[0].value, '**35%**');
    assert.equal(embed.fields[1].value, '**No**');
    assert.equal(embed.fields[2].value, '[**Click Here!**](<https://example.com/forum/#findComment-100>)');
    assert.equal(embed.fields.slice(0, 3).every(field => field.inline), true);
    assert.equal(result.record.notificationStatus, 'non_application_alert_sent');
});

test('recovers an existing non-application alert instead of sending it twice', async () => {
    let sends = 0;
    const postUrl = 'https://example.com/forum/#findComment-101';
    const existing = {
        id: 'existing-alert',
        url: 'https://discord.com/existing-alert',
        author: { id: 'bot-id' },
        content: `**not** classified as a valid guild application ${postUrl}`,
        embeds: []
    };
    const officerChannel = {
        id: 'officer-channel',
        isTextBased: () => true,
        messages: { fetch: async () => new Map([[existing.id, existing]]) },
        async send() { sends += 1; }
    };
    const notifier = new GuildForumPostNotifier({
        client: {
            user: { id: 'bot-id' },
            channels: { cache: new Map([[officerChannel.id, officerChannel]]), fetch: async () => officerChannel }
        },
        officerChannelID: officerChannel.id,
        ownerID: 'owner-id'
    });

    const result = await notifier.notify({ postId: '101', postUrl });

    assert.equal(sends, 0);
    assert.equal(result.record.notificationStatus, 'non_application_alert_sent');
    assert.equal(result.record.officerMessageId, 'existing-alert');
});

test('feedback button is restricted to the configured owner', async () => {
    const replies = [];
    const interaction = {
        customId: 'guild_application_feedback:100',
        user: { id: 'someone-else' },
        async reply(payload) { replies.push(payload); }
    };

    const handled = await handleGuildForumFeedbackButton(interaction, { ownerID: 'owner-id' });

    assert.equal(handled, true);
    assert.equal(
        replies[0].content,
        'Feedback for improving the detection algorithm and training database can only be submitted by <@owner-id>'
    );
    assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});

test('feedback button shows the placeholder response to the owner', async () => {
    const replies = [];
    const interaction = {
        customId: 'guild_application_feedback:100',
        user: { id: 'owner-id' },
        async reply(payload) { replies.push(payload); }
    };

    const handled = await handleGuildForumFeedbackButton(interaction, { ownerID: 'owner-id' });

    assert.equal(handled, true);
    assert.equal(replies[0].content, 'Coming soon...');
});
