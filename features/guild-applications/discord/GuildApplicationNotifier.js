'use strict';

// Posts complete applications for Officers, then creates and cross-links the Court House poll.
const path = require('path');
const { EmbedBuilder, embedLength } = require('discord.js');
const { findRecentBotMessage } = require('../../../utils/discordMessageHistory.js');
const { TOPIC_URL } = require('../constants.js');
const {
    extractNarrativeDetails,
    normalizeCountryCandidate,
    removeAttachmentFilenames
} = require('../parsing/GuildApplicationParser.js');

const EMBED_COLOR = 0x452366;
const NOT_AVAILABLE = '*N/A*';
const ADDITIONAL_IMAGE_BATCH_LIMIT = 10;
const PRO_FORUM_EMOJI = '<:pro_revolution_online:1526117366159638628>';
const CC_LOGO_NAME = 'cc_logo.webp';
const CC_LOGO_PATH = path.join(__dirname, '..', '..', '..', 'images', CC_LOGO_NAME);

const EXTRA_PLACEHOLDER_PATTERNS = [
    /^(?:📌\s*)?(?:in[\s-]*game(?:[\s-]*name)?|ign|age|country)\s*:?$/iu,
    /^(?:📌\s*)?screen\s*shot of (?:your\s+)?pok(?:e|é)mon id\s*:?$/iu,
    /^(?:📌\s*)?what (?:do )?you love to do in pro\s*:?\s*(?:we(?:'|’)ll review and respond with next steps!?)?$/iu
];

function messageUrl(guildId, channelId, messageId) {
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function safeValue(value) {
    const text = String(value || '').trim();
    return text || NOT_AVAILABLE;
}

function cleanForumMetadata(value) {
    return removeAttachmentFilenames(value)
        .split(/\r?\n/)
        .filter(line => !/^edited\b.*\bby\s+.+$/i.test(line.trim()))
        .join('\n')
        .trim();
}

function imageCountText(count) {
    const noun = count === 1 ? 'image' : 'images';
    return `-# *${count} ${noun} attached!*`;
}

function cleanExtraInformation(value) {
    const lines = cleanForumMetadata(value)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !EXTRA_PLACEHOLDER_PATTERNS.some(pattern => pattern.test(line)));
    return lines.join('\n').trim() || null;
}

function formatSubmittedDate(value, timeZone = 'Etc/UTC') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    const parts = new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        month: 'long',
        timeZone,
        year: 'numeric'
    }).formatToParts(date);
    const valueFor = type => parts.find(part => part.type === type)?.value;
    return `${valueFor('month')} ${valueFor('day')}, ${valueFor('year')} ${valueFor('hour')}:${valueFor('minute')}`;
}

function logoFile() {
    return { attachment: CC_LOGO_PATH, name: CC_LOGO_NAME };
}

function splitFieldValue(value, limit = 1024) {
    const text = safeValue(value);
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length) {
        let cut = Math.min(limit, remaining.length);
        if (cut < remaining.length) {
            const newline = remaining.lastIndexOf('\n', cut);
            const space = remaining.lastIndexOf(' ', cut);
            cut = Math.max(newline, space, Math.floor(limit * 0.65));
        }
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    return chunks;
}

function addLongField(embed, name, value, inline = false, maxTotalFields = 24, maxCharacters = 6000) {
    const chunks = splitFieldValue(value);
    for (const [index, chunk] of chunks.entries()) {
        if ((embed.data.fields?.length || 0) >= maxTotalFields) return true;
        const fieldName = index === 0 ? name : `${name} (continued)`;
        const available = Math.max(0, maxCharacters - embedLength(embed.data) - fieldName.length);
        if (!available) return true;
        const truncated = chunk.length > available;
        embed.addFields({
            name: fieldName,
            value: truncated ? `${chunk.slice(0, available - 1).trimEnd()}…` : chunk,
            inline: index === 0 && inline
        });
        if (truncated) return true;
    }
    return false;
}

function rawApplicationFieldValue(record) {
    const rawText = safeValue(cleanForumMetadata(record.rawBodyText));
    if (rawText.length <= 1024) return rawText;
    const suffix = `...\n\n[Read the complete forum post](${record.postUrl})`;
    return `${rawText.slice(0, 1024 - suffix.length).trimEnd()}${suffix}`;
}

class GuildApplicationNotifier {
    constructor(options = {}) {
        this.client = options.client;
        this.guildId = String(options.guildId || '');
        this.officerChannelId = String(options.officerChannelID || options.officerChannelId || '');
        this.courtChannelId = String(options.courtHouseChannelID || options.courtChannelId || '');
        this.officerRoleId = String(options.officerRoleID || options.officerRoleId || '');
        this.topicUrl = options.topicUrl || TOPIC_URL;
        this.botTimezone = options.botTimezone || 'Etc/UTC';
        this.clock = options.clock || (() => new Date());
    }

    async getTextChannel(channelId, label) {
        if (!channelId) throw new Error(`${label} channel ID is not configured.`);
        const channel = this.client.channels.cache.get(channelId) || await this.client.channels.fetch(channelId);
        if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
            throw new Error(`${label} channel ${channelId} is not text-based or is unavailable.`);
        }
        return channel;
    }

    initialOfficerContent(record) {
        return `### <@&${this.officerRoleId}>, a new application to join Crow Control has been submitted through the [**PRO Forum**](<${this.topicUrl}>) ${PRO_FORUM_EMOJI}\n`
            + `- PRO Forum Application: [**Click Here!**](<${record.postUrl}>)`;
    }

    officerContentWithPoll(record, pollUrl) {
        return `### <@&${this.officerRoleId}>, a new application to join Crow Control has been submitted through the [**PRO Forum**](<${this.topicUrl}>) ${PRO_FORUM_EMOJI}\n`
            + `Review the application and cast your vote in ${pollUrl}\n`
            + `- PRO Forum Application: [**Click Here!**](<${record.postUrl}>)`;
    }

    courtContent(record, officerUrl) {
        return `Guild Application from **${record.ign}:**\n`
            + `-# - PRO Forum Application: [**Click Here**](<${record.postUrl}>)\n`
            + `-# - View Application in Discord: [**Click Here**](<${officerUrl}>)`;
    }

    createApplicationEmbed(record) {
        return new EmbedBuilder()
            .setTitle('Crow Control Guild Application')
            .setURL(this.topicUrl)
            .setColor(EMBED_COLOR)
            .setFooter({
                text: `Guild Application Submitted: ${formatSubmittedDate(record.postedAt, this.botTimezone)}`,
                iconURL: `attachment://${CC_LOGO_NAME}`
            });
    }

    buildNormalPayload(record, downloadedImages) {
        const availableImages = downloadedImages || [];
        const firstImage = availableImages[0] || null;
        const embed = this.createApplicationEmbed(record);
        const narrative = extractNarrativeDetails(record.extraInformation);
        const country = normalizeCountryCandidate(record.country) || narrative.country;
        const screenshotValue = availableImages.length
            ? imageCountText(availableImages.length)
            : `${NOT_AVAILABLE}\n${imageCountText(0)}`;
        const fullApplication = { name: 'Full Application', value: `[Read the complete forum post](${record.postUrl})`, inline: false };
        // Leave room for the screenshot count and source link before filling long answers.
        const reservedCharacters = 'Screenshot of Trainer Card'.length + screenshotValue.length
            + fullApplication.name.length + fullApplication.value.length;
        const addApplicationField = (name, value, inline = false) =>
            addLongField(embed, name, value, inline, 23, 6000 - reservedCharacters);

        let contentTruncated = addApplicationField('In-Game Name', record.ign, true);
        contentTruncated = addApplicationField('Age', record.age, true) || contentTruncated;
        contentTruncated = addApplicationField('Country', country, true) || contentTruncated;
        contentTruncated = addApplicationField('Interests in game', cleanForumMetadata(record.interests)) || contentTruncated;
        const extraInformation = cleanExtraInformation(record.extraInformation);
        if (extraInformation) contentTruncated = addApplicationField('Extra Information', extraInformation) || contentTruncated;
        if (contentTruncated) {
            embed.addFields(fullApplication);
        }

        addLongField(embed, 'Screenshot of Trainer Card', screenshotValue, false, 25);

        const files = [logoFile()];
        if (firstImage?.buffer) {
            files.push({ attachment: firstImage.buffer, name: firstImage.name });
            embed.setImage(`attachment://${firstImage.name}`);
        } else if (firstImage?.url) {
            embed.setImage(firstImage.url);
        }

        return { embeds: [embed], files };
    }

    buildRawApplicationPayload(record, downloadedImages) {
        const availableImages = downloadedImages || [];
        const embed = this.createApplicationEmbed(record)
            .addFields({
                name: 'Guild Application',
                value: rawApplicationFieldValue(record),
                inline: false
            });
        const firstImage = availableImages[0] || null;
        const files = [logoFile()];

        if (firstImage?.buffer) {
            files.push({ attachment: firstImage.buffer, name: firstImage.name });
            embed.setImage(`attachment://${firstImage.name}`);
        } else if (firstImage?.url) {
            embed.setImage(firstImage.url);
        }

        return { embeds: [embed], files };
    }

    async sendRemainingAttachments(officerMessage, downloadedImages) {
        const remainingImages = (downloadedImages || []).slice(1);
        for (let index = 0; index < remainingImages.length; index += ADDITIONAL_IMAGE_BATCH_LIMIT) {
            const batch = remainingImages.slice(index, index + ADDITIONAL_IMAGE_BATCH_LIMIT);
            const files = batch
                .filter(image => image.buffer)
                .map(image => ({ attachment: image.buffer, name: image.name }));
            const publicUrls = batch.filter(image => !image.buffer && image.url).map(image => image.url);
            await officerMessage.reply({
                content: `**Additional Images:**${publicUrls.length ? `\n${publicUrls.join('\n')}` : ''}`,
                files,
                allowedMentions: { parse: [] },
                failIfNotExists: false
            });
        }
    }

    async fetchExistingMessage(channel, messageId) {
        if (!messageId || !channel.messages?.fetch) return null;
        try {
            return await channel.messages.fetch(messageId);
        } catch (error) {
            if (Number(error.code) === 10008) return null;
            // A network or permission failure does not mean the saved message disappeared.
            throw error;
        }
    }

    async findRecoveredMessage(channel, needles, label, postId) {
        try {
            const message = await findRecentBotMessage(channel, {
                botUserId: this.client.user?.id,
                needles
            });
            if (message) {
                console.log(`[CC LOG] Recovered ${label} for Guild Application forum post ${postId || 'unknown'}; duplicate send skipped.`);
            }
            return message;
        } catch (error) {
            console.warn(
                `[CC LOG] Could not check recent Discord messages for Guild Application ${postId || 'unknown'} ${label}: `
                + `${error.code || error.message}`
            );
            return null;
        }
    }

    async notify(record, options = {}) {
        const officerChannel = await this.getTextChannel(this.officerChannelId, 'Officer');
        let officerMessage = await this.fetchExistingMessage(officerChannel, record.officerMessageId);
        if (!officerMessage) {
            officerMessage = await this.findRecoveredMessage(
                officerChannel,
                [record.postUrl, 'a new application to join '],
                'Officer alert',
                record.postId
            );
            if (officerMessage) {
                record.officerMessageId = officerMessage.id;
                record.officerMessageUrl = officerMessage.url
                    || messageUrl(this.guildId, officerChannel.id, officerMessage.id);
                record.notificationStatus = 'officer_sent';
                if (options.onOfficerMessage) await options.onOfficerMessage(record);
            }
        }

        if (!officerMessage) {
            const visualPayload = options.useRawApplicationFallback
                ? this.buildRawApplicationPayload(record, options.downloadedImages || [])
                : this.buildNormalPayload(record, options.downloadedImages || []);
            officerMessage = await officerChannel.send({
                content: this.initialOfficerContent(record),
                ...visualPayload,
                allowedMentions: { parse: [], roles: [this.officerRoleId] }
            });
            record.officerMessageId = officerMessage.id;
            record.officerMessageUrl = messageUrl(this.guildId, officerChannel.id, officerMessage.id);
            record.notificationStatus = 'officer_sent';
            if (options.onOfficerMessage) await options.onOfficerMessage(record);
            await this.sendRemainingAttachments(officerMessage, options.downloadedImages);
        }

        if (!record.ign || record.ignConfidence < 0.78) {
            record.notificationStatus = 'notified_no_poll';
            record.notifiedAt = new Date().toISOString();
            return record;
        }

        const courtChannel = await this.getTextChannel(this.courtChannelId, 'Court House');
        let pollMessage = await this.fetchExistingMessage(courtChannel, record.pollMessageId);
        try {
            if (!pollMessage) {
                pollMessage = await this.findRecoveredMessage(
                    courtChannel,
                    [record.postUrl, `Guild Application from **${record.ign}:**`],
                    'Court House poll',
                    record.postId
                );
            }
            if (!pollMessage) {
                pollMessage = await courtChannel.send({
                    content: this.courtContent(record, record.officerMessageUrl),
                    poll: {
                        question: { text: `Invite ${record.ign} to Crow Control?` },
                        answers: [{ text: 'Yes' }, { text: 'No' }],
                        duration: 24,
                        allowMultiselect: false
                    },
                    allowedMentions: { parse: [] }
                });
            }
            record.pollMessageId = pollMessage.id;
            record.pollMessageUrl = messageUrl(this.guildId, courtChannel.id, pollMessage.id);
            record.pollCreatedAt = pollMessage.createdAt?.toISOString?.()
                || (pollMessage.createdTimestamp ? new Date(pollMessage.createdTimestamp).toISOString() : null)
                || record.pollCreatedAt
                || this.clock().toISOString();
            if (options.onPollMessage) await options.onPollMessage(record);
            await officerMessage.edit({
                content: this.officerContentWithPoll(record, record.pollMessageUrl),
                allowedMentions: { parse: [], roles: [this.officerRoleId] }
            });
            record.notificationStatus = 'notified';
            record.notifiedAt = new Date().toISOString();
            record.lastError = null;
        } catch (error) {
            console.error('[CC LOG] Guild Application poll could not be created:', error);
            record.notificationStatus = 'notified_poll_failed';
            record.notifiedAt = new Date().toISOString();
            record.lastError = error.message;
        }
        return record;
    }
}

module.exports = {
    GuildApplicationNotifier,
    EMBED_COLOR,
    addLongField,
    cleanForumMetadata,
    formatSubmittedDate,
    logoFile,
    messageUrl,
    rawApplicationFieldValue,
    splitFieldValue
};
