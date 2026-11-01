'use strict';

// Sends the owner a compact review alert for new forum posts that are not valid applications.
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags
} = require('discord.js');
const {
    EMBED_COLOR,
    addLongField,
    cleanForumMetadata,
    formatSubmittedDate,
    logoFile
} = require('./GuildApplicationNotifier.js');
const { findRecentBotMessage } = require('../../../utils/discordMessageHistory.js');
const { TOPIC_URL } = require('../constants.js');

const NOT_AVAILABLE = '*N/A*';
const FEEDBACK_BUTTON_PREFIX = 'guild_application_feedback:';

function feedbackButton(postId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${FEEDBACK_BUTTON_PREFIX}${postId || 'unknown'}`)
            .setLabel('AI Training Feedback')
            .setEmoji('⭐')
            .setStyle(ButtonStyle.Primary)
    );
}

async function handleGuildForumFeedbackButton(interaction, options = {}) {
    if (!String(interaction.customId || '').startsWith(FEEDBACK_BUTTON_PREFIX)) return false;

    const ownerId = String(options.ownerID || options.ownerId || '');
    if (interaction.user.id !== ownerId) {
        await interaction.reply({
            content: `Feedback for improving the detection algorithm and training database can only be submitted by <@${ownerId}>`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] }
        });
        return true;
    }

    await interaction.reply({ content: 'Coming soon...', flags: MessageFlags.Ephemeral });
    return true;
}

class GuildForumPostNotifier {
    constructor(options = {}) {
        this.client = options.client;
        this.officerChannelId = String(options.officerChannelID || options.officerChannelId || '');
        this.ownerId = String(options.ownerID || options.ownerId || '');
        this.botTimezone = options.botTimezone || 'Etc/UTC';
        this.topicUrl = options.topicUrl || TOPIC_URL;
    }

    async getOfficerChannel() {
        if (!this.officerChannelId) throw new Error('Officer channel ID is not configured.');
        const channel = this.client.channels.cache.get(this.officerChannelId)
            || await this.client.channels.fetch(this.officerChannelId);
        if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
            throw new Error(`Officer channel ${this.officerChannelId} is not text-based or is unavailable.`);
        }
        return channel;
    }

    content(record) {
        return `<@${this.ownerId}>, a new message was detected on the **Crow Control guild application forum page**, but it was **not** classified as a valid guild application!\n`
            .trim();
    }

    embed(record) {
        const percentage = Math.round(Math.max(0, Math.min(1, Number(record.classificationConfidence || 0))) * 100);
        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setFooter({
                text: `Forum Post Created: ${formatSubmittedDate(record.postedAt, this.botTimezone)}`,
                iconURL: 'attachment://cc_logo.webp'
            })
            .addFields(
                { name: 'Probability Score', value: `**${percentage}%**`, inline: true },
                { name: 'Posted by Vangogsan', value: '**No**', inline: true },
                { name: 'View Forum Application', value: `[**Click Here!**](<${record.postUrl}>)`, inline: true },
                {
                    name: 'Forum Username',
                    value: String(record.forumUsername || '').trim() || NOT_AVAILABLE,
                    inline: false
                }
            );

        addLongField(embed, 'Message Content', cleanForumMetadata(record.rawBodyText) || NOT_AVAILABLE, false);
        return embed;
    }

    async notify(record) {
        if (!this.ownerId) throw new Error('Owner ID is not configured for forum post alerts.');
        const officerChannel = await this.getOfficerChannel();
        try {
            const existing = await findRecentBotMessage(officerChannel, {
                botUserId: this.client.user?.id,
                needles: [record.postUrl, 'classified as a valid guild application']
            });
            if (existing) {
                console.log(`[CC LOG] Recovered non-application alert for forum post ${record.postId}; duplicate send skipped.`);
                record.notificationStatus = 'non_application_alert_sent';
                record.notifiedAt = record.notifiedAt || existing.createdAt?.toISOString?.() || new Date().toISOString();
                record.officerMessageId = existing.id;
                record.officerMessageUrl = existing.url || null;
                record.lastError = null;
                return { record, message: existing };
            }
        } catch (error) {
            console.warn(
                `[CC LOG] Could not check recent Officer messages for duplicate forum post ${record.postId || 'unknown'}: `
                + `${error.code || error.message}`
            );
        }
        const message = await officerChannel.send({
            content: this.content(record),
            embeds: [this.embed(record)],
            components: [feedbackButton(record.postId)],
            files: [logoFile()],
            allowedMentions: { parse: [], users: [this.ownerId] }
        });
        record.notificationStatus = 'non_application_alert_sent';
        record.notifiedAt = new Date().toISOString();
        record.officerMessageId = message.id;
        record.officerMessageUrl = message.url || null;
        record.lastError = null;
        return { record, message };
    }
}

module.exports = {
    FEEDBACK_BUTTON_PREFIX,
    GuildForumPostNotifier,
    feedbackButton,
    handleGuildForumFeedbackButton
};
