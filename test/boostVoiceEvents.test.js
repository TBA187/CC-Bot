'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageType } = require('discord.js');
const boost = require('../events/boostThanks.js');
const voice = require('../events/voiceActivityLogs.js');

function fixture() {
    const sent = [];
    const channel = id => ({ isTextBased: () => true, send: async payload => sent.push({ id, ...payload }) });
    const guild = { id: 'guild', channels: { cache: new Map([['welcome', channel('welcome')], ['bot', channel('bot')], ['log', channel('log')]]) },
        voiceStates: { cache: new Map() }, fetch: async () => ({ premiumSubscriptionCount: 20 }) };
    const user = { id: '123', displayAvatarURL: () => 'https://example.com/avatar.png' };
    const member = { id: user.id, user, guild, displayAvatarURL: user.displayAvatarURL };
    return { sent, guild, user, member, config: { guildId: 'guild', welcomeChannelID: 'welcome', botChannelID: 'bot', logChannelID: 'log' } };
}

test('boost system messages including tier boosts produce a branded thank-you', async () => {
    for (const type of [MessageType.UserPremiumGuildSubscription, MessageType.UserPremiumGuildSubscriptionTier1,
        MessageType.UserPremiumGuildSubscriptionTier2, MessageType.UserPremiumGuildSubscriptionTier3]) {
        const f = fixture();
        await boost.execute({ type, guild: f.guild, author: f.user }, f.config);
        assert.equal(f.sent.length, 1);
        const embed = f.sent[0].embeds[0].toJSON();
        assert.match(embed.description, /<@123>/u);
        assert.equal(embed.thumbnail.url, 'https://example.com/avatar.png');
        assert.equal(embed.footer.text, 'Server Boosts: 20');
        assert.doesNotMatch(embed.description, /Server boosts/iu);
        assert.equal(embed.color, 0xF47FFF);
        assert.equal(f.sent[0].id, 'welcome');
        assert.equal(f.sent[0].content, '<@123>');
        assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: ['123'] });
    }
});

test('unrelated messages and other guilds do not produce boost thanks', async () => {
    const f = fixture();
    await boost.execute({ type: MessageType.Default, guild: f.guild, author: f.user }, f.config);
    await boost.execute({ type: MessageType.UserPremiumGuildSubscription, guild: { ...f.guild, id: 'other' }, author: f.user }, f.config);
    assert.equal(f.sent.length, 0);
});

test('boost thanks still send without a count when fetching it fails', async () => {
    const f = fixture();
    f.guild.fetch = async () => { throw new Error('unavailable'); };
    const original = console.error;
    console.error = () => {};
    try { await boost.execute({ type: MessageType.UserPremiumGuildSubscription, guild: f.guild, author: f.user }, f.config); }
    finally { console.error = original; }
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].embeds[0].toJSON().footer.text, 'Server Boosts: Unavailable');
});

test('voice joins, leaves and moves each produce one log with the member and channels', async () => {
    const f = fixture();
    for (const [before, after, states, expected, footer] of [
        [null, 'one', ['one', 'one'], /joined <#one>/u, 'Members in Voice Channel: 2'],
        ['one', null, [], /left <#one>/u, 'Members in Voice Channel: 0'],
        ['one', 'two', ['one', 'two', 'two'], /moved from <#one> to <#two>/u, 'Members in Voice Channels: Previous 1 • New 2']
    ]) {
        f.guild.voiceStates.cache = new Map(states.map((channelId, index) => [index, { channelId }]));
        await voice.execute({ channelId: before, guild: f.guild, member: f.member },
            { channelId: after, guild: f.guild, member: f.member }, f.config);
        const payload = f.sent.at(-1), embed = payload.embeds[0].toJSON();
        assert.equal(payload.id, 'bot');
        assert.match(embed.description, /<@123>/u);
        assert.match(embed.description, expected);
        assert.equal(embed.footer.text, footer);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
    assert.equal(f.sent.length, 3);
});

test('voice counts are captured before an asynchronous channel lookup', async () => {
    const f = fixture();
    f.guild.voiceStates.cache = new Map([['123', { channelId: 'one' }]]);
    let resolve;
    f.guild.channels.cache.delete('bot');
    f.guild.channels.fetch = () => new Promise(r => { resolve = r; });
    const pending = voice.execute({ channelId: null }, { channelId: 'one', guild: f.guild, member: f.member }, f.config);
    f.guild.voiceStates.cache.set('456', { channelId: 'one' });
    resolve({ isTextBased: () => true, send: async payload => f.sent.push(payload) });
    await pending;
    assert.equal(f.sent[0].embeds[0].toJSON().footer.text, 'Members in Voice Channel: 1');
});

test('voice state updates without channel changes and other guilds are ignored', async () => {
    const f = fixture();
    await voice.execute({ channelId: 'one' }, { channelId: 'one', guild: f.guild, member: f.member }, f.config);
    await voice.execute({ channelId: null }, { channelId: 'one', guild: { ...f.guild, id: 'other' }, member: f.member }, f.config);
    assert.equal(f.sent.length, 0);
});
