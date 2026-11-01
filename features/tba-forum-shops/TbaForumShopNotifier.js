'use strict';

// Builds the small owner DM used for new messages in either forum shop topic.
const { EmbedBuilder, embedLength } = require('discord.js');
const {
    EMBED_COLOR,
    IGNORED_FORUM_USERNAME,
    SHOP_EMBED_COLORS
} = require('./constants.js');

const NOT_AVAILABLE = '*N/A*';
const IMAGE_BATCH_LIMIT = 10;

function formatForumDate(value, timeZone = 'Etc/UTC') {
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
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part('month')} ${part('day')}, ${part('year')} ${part('hour')}:${part('minute')}`;
}

function splitMessage(value, limit = 1024) {
    let remaining = String(value || '').trim() || NOT_AVAILABLE;
    const chunks = [];
    while (remaining) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            remaining = '';
            break;
        }
        let cut = remaining.lastIndexOf('\n', limit);
        if (cut < Math.floor(limit * 0.6)) cut = remaining.lastIndexOf(' ', limit);
        if (cut < Math.floor(limit * 0.6)) cut = limit;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    return chunks;
}

function splitQuotedMessage(value, limit = 1024) {
    const quotedText = String(value || '').replace(/\r/g, '').trim();
    if (!quotedText) return [];

    const formattedLines = quotedText.split('\n').flatMap(line => {
        const parts = splitMessage(line || '\u200b', limit - 5);
        return parts.map(part => `-# *${part}*`);
    });
    const chunks = [];
    let current = '';
    for (const line of formattedLines) {
        if (current && current.length + line.length + 1 > limit) {
            chunks.push(current);
            current = line;
        } else {
            current = current ? `${current}\n${line}` : line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function messageContainsPostUrl(message, postUrl) {
    const needle = String(postUrl || '').trim();
    if (!needle) return false;
    const embedText = (message?.embeds || [])
        .map(embed => JSON.stringify(embed?.data || embed || {}))
        .join('\n');
    return `${message?.content || ''}\n${embedText}`.includes(needle);
}

class TbaForumShopNotifier {
    constructor(options = {}) {
        this.client = options.client;
        this.ownerId = String(options.ownerID || options.ownerId || '');
        this.botTimezone = options.botTimezone || 'Etc/UTC';
    }

    async getOwner() {
        const owner = this.client.users.cache.get(this.ownerId) || await this.client.users.fetch(this.ownerId);
        if (!owner || typeof owner.send !== 'function') throw new Error(`Discord user ${this.ownerId} is unavailable.`);
        return owner;
    }

    async findExistingNotification(owner, post) {
        try {
            const channel = owner.dmChannel || await owner.createDM?.();
            if (!channel?.messages?.fetch) return null;
            const messages = await channel.messages.fetch({ limit: 100 });
            const botUserId = String(this.client.user?.id || '');
            return [...messages.values()].find(message => (
                (!botUserId || String(message.author?.id || '') === botUserId)
                && messageContainsPostUrl(message, post.postUrl)
            )) || null;
        } catch (error) {
            console.warn(
                `[CC LOG] Could not check recent DMs for duplicate ${post.postId || 'unknown'}; ` +
                `the shared checkpoint will remain the primary guard: ${error.code || error.message}`
            );
            return null;
        }
    }

    buildPayload(shop, post, downloadedImages = []) {
        const incomplete = (post.extractionWarnings || []).length > 0
            || downloadedImages.some(image => image.error);
        const description = [`**Message Link:\u2002[Click Here!](<${post.postUrl}>)**`];
        if (incomplete) {
            description.push('-# ⚠️ Some information could not be fetched from this forum post. Open the message link to view the original.');
        }
        const embed = new EmbedBuilder()
            .setColor(SHOP_EMBED_COLORS[shop.key] || EMBED_COLOR)
            .setTitle(String(post.forumUsername || '').trim() || 'Unknown Forum User')
            .setURL(shop.topicUrl)
            .setDescription(description.join('\n'))
            .setFooter({ text: `Forum Message Sent: ${formatForumDate(post.postedAt, this.botTimezone)}` });

        splitQuotedMessage(post.quotedBodyText).slice(0, 5).forEach((value, index) => {
            embed.addFields({
                name: index === 0 ? 'Quoted Message:' : 'Quoted Message (continued):',
                value,
                inline: false
            });
        });

        for (const [index, value] of splitMessage(post.bodyText).slice(0, 5).entries()) {
            const name = index === 0 ? 'Message Content:' : 'Message Content (continued):';
            // Quoted text shares Discord's 6,000-character budget with the customer's reply.
            if (embedLength(embed.data) + name.length + value.length > 6000) break;
            embed.addFields({ name, value, inline: false });
        }

        const firstImage = downloadedImages[0];
        const files = [];
        if (firstImage?.buffer) {
            files.push({ attachment: firstImage.buffer, name: firstImage.name });
            embed.setImage(`attachment://${firstImage.name}`);
        } else if (firstImage?.url) {
            embed.setImage(firstImage.url);
        }

        return {
            content: `### ${shop.emoji}\u2002<@${this.ownerId}>, there's a new message in the [${shop.name}!](<${shop.topicUrl}>)`,
            embeds: [embed],
            files,
            allowedMentions: { parse: [], users: [this.ownerId] }
        };
    }

    async sendRemainingMessageContent(owner, bodyText, embeddedChunks = 5) {
        const remaining = splitMessage(bodyText).slice(embeddedChunks);
        for (const value of remaining) {
            await owner.send({
                content: `**Message Content (continued):**\n${value}`,
                allowedMentions: { parse: [] }
            });
        }
    }

    async sendAdditionalImages(owner, downloadedImages) {
        const remaining = downloadedImages.slice(1);
        for (let index = 0; index < remaining.length; index += IMAGE_BATCH_LIMIT) {
            const batch = remaining.slice(index, index + IMAGE_BATCH_LIMIT);
            const files = batch
                .filter(image => image.buffer)
                .map(image => ({ attachment: image.buffer, name: image.name }));
            const publicUrls = batch.filter(image => !image.buffer && image.url).map(image => image.url);
            await owner.send({
                content: `**Additional Images:**${publicUrls.length ? `\n${publicUrls.join('\n')}` : ''}`,
                files,
                allowedMentions: { parse: [] }
            });
        }
    }

    async notify(shop, post, downloadedImages = []) {
        if (String(post.forumUsername || '').trim().toLowerCase() === IGNORED_FORUM_USERNAME) return null;
        if (!this.ownerId) throw new Error('ownerID is not configured for TBA forum shop notifications.');
        const owner = await this.getOwner();
        const existing = await this.findExistingNotification(owner, post);
        if (existing) {
            console.log(`[CC LOG] Skipped duplicate ${shop.name} DM for forum post ${post.postId}.`);
            return existing;
        }
        const payload = this.buildPayload(shop, post, downloadedImages);
        const embeddedChunks = (payload.embeds[0].data.fields || [])
            .filter(field => field.name.startsWith('Message Content')).length;
        const message = await owner.send(payload);
        await this.sendRemainingMessageContent(owner, post.bodyText, embeddedChunks);
        await this.sendAdditionalImages(owner, downloadedImages);
        return message;
    }
}

module.exports = {
    TbaForumShopNotifier,
    IMAGE_BATCH_LIMIT,
    formatForumDate,
    splitMessage,
    splitQuotedMessage,
    messageContainsPostUrl
};
