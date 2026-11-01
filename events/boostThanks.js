'use strict';

const path = require('node:path');
const { AttachmentBuilder, EmbedBuilder, MessageType } = require('discord.js');

const boostTypes = new Set([
    MessageType.UserPremiumGuildSubscription,
    MessageType.UserPremiumGuildSubscriptionTier1,
    MessageType.UserPremiumGuildSubscriptionTier2,
    MessageType.UserPremiumGuildSubscriptionTier3
]);

function buildBoostPayload(user, count) {
    const embed = new EmbedBuilder().setTitle('Server Boosted!\u2002💜')
        .setColor(0xF47FFF)
        .setDescription(`**Thank you for boosting the White Walkers server, <@${user.id}>**\n` +
            'Your support helps make our community even stronger. 💜')
        .setThumbnail(user.displayAvatarURL({ size: 128 }))
        .setFooter({ text: `Server Boosts: ${Number.isInteger(count) && count >= 0 ? count : 'Unavailable'}`,
            iconURL: 'attachment://ww_logo.png' })
        .setTimestamp();
    return { content: `<@${user.id}>`, embeds: [embed], files: [new AttachmentBuilder(path.join(__dirname, '../images/ww_logo.png'), { name: 'ww_logo.png' })],
        allowedMentions: { parse: [], users: [user.id] } };
}

async function handleBoostMessage(message, config) {
    if (!message.guild || !message.author || !boostTypes.has(message.type) ||
        (config.guildId && message.guild.id !== config.guildId) || !config.welcomeChannelID) return;
    const channel = message.guild.channels.cache.get(config.welcomeChannelID) ||
        await message.guild.channels.fetch(config.welcomeChannelID);
    if (!channel?.isTextBased() || config.shutdownSignal?.aborted) return;
    let count;
    try { count = (await message.guild.fetch()).premiumSubscriptionCount; }
    catch (error) { console.error('Failed to fetch server boost count:', error); }
    if (!config.shutdownSignal?.aborted) await channel.send(buildBoostPayload(message.author, count));
}

module.exports = { name: 'messageCreate', execute: handleBoostMessage, buildBoostPayload };
