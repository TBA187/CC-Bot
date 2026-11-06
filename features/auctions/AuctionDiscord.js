// Builds auction announcements and bid DMs, and handles persistent Discord controls.
'use strict';

const { createHash } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, EmbedBuilder,
    MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, PermissionFlagsBits, TextDisplayBuilder, escapeMarkdown } = require('discord.js');
const { messageSearchText } = require('../../utils/discordMessageHistory.js');
const { SERVERS } = require('../pvp-scouting/ScoutServerSettings.js');

const BUTTON_PREFIX = 'auction:';
const NONE = '*None*';
const IMAGE_PAGE_SIZE = 10;
const BID_PAGE_SIZE = 25;
const BID_DESCRIPTION_LIMIT = 4096;
function footer(page = null, title = 'PRO Auctions', botUser = null) {
    const iconURL = botUser?.displayAvatarURL?.({ size: 64 });
    return { text: `${title} • Last updated:${page ? ` • Page ${page}` : ''}`,
        ...(iconURL ? { iconURL } : {}) };
}

function server(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
    const key = normalized === 'cross server' ? 'cross' : normalized;
    const entry = SERVERS[key];
    return entry ? `${entry.markup} ${entry.label}` : text(value, 100);
}

function discordTime(value) {
    const ms = Date.parse(value || '');
    if (!Number.isFinite(ms)) return null;
    const seconds = Math.floor(ms / 1000);
    return `<t:${seconds}:R> (<t:${seconds}:F>)`;
}

function text(value, limit = 1000) {
    const raw = String(value ?? '').trim();
    if (!raw || raw === '-') return NONE;
    const escaped = escapeMarkdown(raw).replace(/@/g, '@\u200b');
    return escaped.length > limit ? `${escaped.slice(0, limit - 1)}…` : escaped;
}

function needsOverflow(value, limit) {
    return escapeMarkdown(String(value || '').trim()).replace(/@/g, '@\u200b').length > limit;
}

function url(value) {
    try {
        const parsed = new URL(String(value || ''));
        if (!['https:', 'http:'].includes(parsed.protocol)) return null;
        if (parsed.href.length > 1800) return null;
        return parsed.href.replace(/[<>]/g, '');
    } catch { return null; }
}

function person(value) {
    if (!value?.name) return NONE;
    const name = text(value.name, 120);
    const candidate = url(value.url);
    const link = candidate?.length <= 300 ? candidate : null;
    return link ? `[${name}](<${link}>)` : name;
}

function jumpToMessage(messageUrl, label = '**Jump to message** ↗️') {
    return /^https:\/\/discord\.com\/channels\/(?:\d+|@me)\/\d+\/\d+$/.test(String(messageUrl || ''))
        ? `[${label}](<${messageUrl}>)` : '*Message unavailable*';
}

function bidLine(bid) {
    const date = bid.timestamp && !Number.isNaN(Date.parse(bid.timestamp))
        ? `<t:${Math.floor(Date.parse(bid.timestamp) / 1000)}:f>` : text(bid.time, 80);
    const labels = [...(bid.labels || []), ...(bid.invalid ? ['Invalid'] : [])];
    const line = `${person(bid.bidder)} · **${text(bid.amount, 80)}** · ${date}${labels.length ? ` · *${labels.map(label => text(label, 80)).join(', ').slice(0, 100)}*` : ''}`;
    return line.replace(/[\r\n]+/g, ' ');
}

function buyerDetails(auction, status) {
    const buyer = auction.buyer || (/^(?:ended|sold|completed)$/.test(status) && auction.endPrice ? auction.highestBidder : null);
    const price = text(auction.endPrice, 100);
    if (!buyer?.name) return auction.endPrice ? `**${price}** · Buyer unavailable` : NONE;
    let result = `**${person(buyer)}${auction.endPrice ? ` for ${price}` : ''}**`;
    const match = (auction.bids || []).find(bid => !bid.invalid
        && String(bid.bidder?.name || '').toLowerCase() === String(buyer.name).toLowerCase()
        && String(bid.amount || '') === String(auction.endPrice || '')
        && (bid.labels || []).some(label => /^price offer$/i.test(label))
        && (bid.labels || []).some(label => /^accepted$/i.test(label)));
    if (match) result += ' *(Price offer accepted)*';
    return result;
}

function button(kind, id, page, label, emoji, disabled = false, style = ButtonStyle.Secondary) {
    const result = new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${kind}:${id}:${page}`)
        .setLabel(label).setStyle(style).setDisabled(disabled);
    if (emoji) result.setEmoji(emoji);
    return result;
}

function chunks(value, size = 3500) {
    const source = String(value || '').trim();
    if (!source) return [];
    const result = [];
    for (let i = 0; i < source.length; i += size) result.push(source.slice(i, i + size));
    return result;
}

function pageControls(kind, id, page, pageCount) {
    return pageCount > 1 ? [new ActionRowBuilder().addComponents(
        button(kind, id, Math.max(0, page - 1), 'Previous', '⬅️', page === 0),
        button(kind, id, Math.min(pageCount - 1, page + 1), 'Next', '➡️', page === pageCount - 1)
    )] : [];
}

function componentPayload(components) {
    // Clear legacy fields when converting an existing private image response.
    return { content: null, embeds: [], attachments: [], flags: MessageFlags.IsComponentsV2,
        components, allowedMentions: { parse: [] } };
}

function imagePage(auction, requestedPage, auctionMessageUrl) {
    const images = (auction.imageUrls || []).map(url).filter(Boolean);
    const pageCount = Math.max(1, Math.ceil(images.length / IMAGE_PAGE_SIZE));
    const page = Math.max(0, Math.min(Math.trunc(Number(requestedPage)) || 0, pageCount - 1));
    const start = page * IMAGE_PAGE_SIZE;
    const title = text(auction.title || 'Auction', 256);
    const link = url(auction.url);
    const container = new ContainerBuilder().setAccentColor(0x452366)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## Auction Images (${images.length})${pageCount > 1 ? ` — Page ${page + 1}/${pageCount}` : ''}\n${link ? `[**${title}**](<${link}>)` : `**${title}**`}`
            + (images.length && pageCount > 1 ? `\nImages ${start + 1}–${Math.min(start + IMAGE_PAGE_SIZE, images.length)} of ${images.length}` : '')));
    if (images.length) {
        container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
            images.slice(start, start + IMAGE_PAGE_SIZE).map((image, index) => new MediaGalleryItemBuilder()
                .setURL(image).setDescription(`${String(auction.title || 'Auction').slice(0, 256)} — Image ${start + index + 1}`))));
    } else container.addTextDisplayComponents(new TextDisplayBuilder().setContent('*No images available.*'));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**Auction Message: ${jumpToMessage(auctionMessageUrl, 'Jump to message ↗️')}**`));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${footer(null, 'PRO Auction Images').text} <t:${Math.floor(Date.now() / 1000)}:f>${pageCount > 1 ? ` • Page ${page + 1}/${pageCount}` : ''}`));
    return componentPayload([container, ...pageControls('images', String(auction.id), page, pageCount)]);
}

function buildAuctionPayload(auction, config = {}, botUser = null) {
    const id = String(auction.id);
    const auctionUrl = url(auction.url);
    const status = String(auction.status || '').trim().toLowerCase();
    const isEnded = /^(ended|closed|sold|completed|expired|cancelled|canceled|inactive)$/.test(status);
    const isActive = /^(active|instant price)$/.test(status);
    const color = isActive ? 0x57F287 : isEnded ? 0xED4245 : 0x747F8D;
    const endTime = discordTime(auction.endedAt);
    const endsAt = discordTime(auction.endsAt);
    const hasBid = (auction.bids || []).some(bid => !bid.invalid && !(bid.labels || []).some(label => /^price offer$/i.test(label))) || Boolean(auction.currentOffer);
    let timing;
    if (/^(?:canceled|cancelled)$/.test(status)) timing = '### This auction has been canceled!';
    else if (isEnded) timing = `**Auction ended:** ${endTime || '*Time unavailable*'}`;
    else if (endsAt || hasBid) timing = `**Auction ends:** ${endsAt || '*Time unavailable*'}`;
    else {
        const duration = text(auction.auctionDuration || 'Not available', 300);
        timing = `**Duration:** ${duration}${auction.auctionDuration && !/[.!?]$/.test(duration) ? '.' : ''}`;
        if (auction.timeLeft) timing += `\n- ${text(auction.timeLeft, 300)}`;
    }
    const tags = [...new Set((auction.tags || []).filter(value => value && !/^(?:gold|silver|cross[\s-]*server)$/i.test(String(value).trim())))];
    const embed = new EmbedBuilder().setColor(color)
        .setTitle(text(auction.title || 'Auction', 256))
        .setDescription(`${timing}\n**Tags:** ${tags.length ? tags.map(tag => text(tag, 100)).join(' · ').slice(0, 400) : NONE}${auction.sourceUnavailable ? '\n\nThe forum page is unavailable. Details below are the last known values.' : ''}`)
        .addFields(
            { name: 'Server', value: server(auction.server), inline: true },
            { name: 'Seller', value: person(auction.seller), inline: true },
            { name: 'Status', value: status === 'instant price' ? 'Active · Instant Price' : text(auction.status, 100), inline: true },
            { name: 'Instant price', value: text(auction.instantPrice, 100), inline: true },
            { name: 'Start price', value: text(auction.startPrice, 100), inline: true },
            { name: 'Minimum bid', value: text(auction.minimumBid, 100), inline: true },
            { name: isEnded ? 'Buyer' : 'Current offer', value: isEnded ? buyerDetails(auction, status)
                : auction.currentOffer ? `**${text(auction.currentOffer, 100)} by ${person(auction.highestBidder)}**` : NONE, inline: false }
        ).setFooter(footer(null, 'PRO Auctions', botUser)).setTimestamp();
    if (auctionUrl) embed.setURL(auctionUrl);
    if (auction.description) embed.addFields({ name: 'Description', value: text(auction.description, 700) });
    if (auction.paymentMethods) embed.addFields({ name: 'Accepted payment methods', value: text(auction.paymentMethods, 700) });
    const bids = Array.isArray(auction.bids) ? auction.bids : [];
    const lines = bids.map(bidLine);
    let history = '';
    for (const line of lines) {
        if ((history ? history.length + 1 : 0) + line.length > 600) break;
        history += `${history ? '\n' : ''}${line}`;
    }
    const shown = history ? history.split('\n').length : 0;
    if (shown < bids.length) history += '\n-# - Click 📋 **Bid History** to view all auction bids.';
    embed.addFields({ name: `Bid history (${bids.length})`, value: history || (isActive ? '*No bids yet..*' : NONE) });
    const images = (auction.imageUrls || []).map(url).filter(Boolean);
    if (images.length) embed.setImage(images[0]);
    if (images.length > 1) embed.addFields({ name: '\u2002',
        value: `-# **${images.length}** attached images. Click 🖼️ **More Images** to view all.`, inline: false });
    const controls = [];
    if (auctionUrl) controls.push(new ButtonBuilder().setLabel('View Auction').setEmoji('🔨').setStyle(ButtonStyle.Link).setURL(auctionUrl));
    controls.push(button('follow', id, 0, 'Follow', '🔔', false, ButtonStyle.Success));
    if (images.length > 1) controls.push(button('images', id, 0, 'More Images', '🖼️', false, ButtonStyle.Primary));
    if (shown < bids.length) controls.push(button('bids', id, 0, 'Bid History', '📋', false, ButtonStyle.Primary));
    if (needsOverflow(auction.description, 700)) controls.push(button('description', id, 0, 'Full Description', '📄'));
    if (needsOverflow(auction.paymentMethods, 700)) controls.push(button('payment', id, 0, 'Payment Details', '💰'));
    const rows = [];
    for (let i = 0; i < controls.length; i += 5) rows.push(new ActionRowBuilder().addComponents(controls.slice(i, i + 5)));
    const roleId = String(config.proNotificationRoleID || '');
    const roleChannelId = String(config.selfRoleChannelID || '');
    const validRole = /^\d+$/.test(roleId);
    const instructions = validRole && /^\d+$/.test(roleChannelId)
        ? `\n-# - Get notified about new auctions by selecting the \`@PRO Auctions 🔔\` role in <#${roleChannelId}>` : '';
    const prefix = validRole ? `<@&${roleId}> There's` : "There's";
    return { content: `${prefix} a new auction in the [**PRO Trade Zone**](<https://pokemonrevolution.net/forum/trade/>)${instructions}\n-# - Click the 🔔 **Follow** button on an auction to receive notifications for new bids.`,
        embeds: [embed], components: rows, allowedMentions: { parse: [], roles: validRole ? [roleId] : [] } };
}

function followConfirmation(auction, alreadyFollowing = false) {
    const title = text(auction.title || 'this auction', 250);
    const link = url(auction.url);
    const name = link ? `[**${title}**](<${link}>)` : `**${title}**`;
    return `### 🔔 You're ${alreadyFollowing ? 'already' : 'now'} following ${name} ✅\n`
        + 'You\'ll receive a DM for every new bid on this auction. DM notifications stop automatically when the auction ends.\n'
        + 'To stop receiving notifications, click the 🔕 **Unfollow** button here or in the auction notification DM.\n'
        + '-# If your privacy settings restrict DMs, you might not receive DM notifications. Make sure DMs from this server are enabled.';
}

function buildBidNotificationPayload(job, userId, botUser = null, auctionMessageUrl = null) {
    const auction = job.auction;
    const bid = job.bid;
    const isOffer = (bid.labels || []).some(label => /^price offer$/i.test(label));
    const label = isOffer ? 'New price offer' : 'New bid';
    const link = url(auction.url);
    const recipient = /^\d{1,20}$/.test(String(userId || '')) ? String(userId) : null;
    const lead = `${recipient ? `<@${recipient}> ` : ''}There's a new ${isOffer ? 'price offer' : 'bid'} for `;
    const title = text(auction.title || 'Auction', Math.min(250, 2000 - lead.length - (link ? link.length + 10 : 4)));
    const content = `**${lead}${link ? `[${title}](<${link}>)` : title}**`;
    const forumTime = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?: UTC)?$/i.exec(String(bid.time || '').trim());
    const bidTime = (forumTime && discordTime(`${forumTime[1]}T${forumTime[2]}Z`))
        || discordTime(bid.timestamp) || text(bid.time, 100);
    const embed = new EmbedBuilder().setColor(0x57F287)
        .setTitle(text(`${label} — ${auction.title || 'Auction'}`, 256))
        .addFields(
            { name: label, value: `**${text(bid.amount, 100)} by ${person(bid.bidder)}**`, inline: false },
            { name: 'Bid time (forum)', value: bidTime, inline: false },
            { name: 'Auction ends', value: discordTime(auction.endsAt) || text(auction.timeLeft, 300), inline: false },
            { name: 'Server', value: server(auction.server), inline: true },
            { name: 'Minimum bid', value: text(auction.minimumBid, 100), inline: true },
            { name: 'Discord message', value: jumpToMessage(auctionMessageUrl), inline: false }
        ).setFooter({ text: 'PRO Auction Notification DM', ...(botUser?.displayAvatarURL ? { iconURL: botUser.displayAvatarURL({ size: 64 }) } : {}) }).setTimestamp();
    const sameOffer = auction.currentOffer && auction.highestBidder?.name && bid.bidder?.name
        && String(auction.currentOffer).replace(/[.,\s]/g, '') === String(bid.amount || '').replace(/[.,\s]/g, '')
        && String(auction.highestBidder.name).toLowerCase() === String(bid.bidder.name).toLowerCase();
    if (auction.currentOffer && !sameOffer) embed.spliceFields(2, 0, { name: 'Current offer',
        value: `**${text(auction.currentOffer, 100)} by ${person(auction.highestBidder)}**`, inline: false });
    if (link) embed.setURL(link);
    const mainImage = (auction.imageUrls || []).map(url).find(Boolean);
    if (mainImage) embed.setThumbnail(mainImage);
    const components = [];
    const row = new ActionRowBuilder();
    if (link) row.addComponents(new ButtonBuilder().setLabel('View Auction').setEmoji('🔨').setStyle(ButtonStyle.Link).setURL(link));
    if (recipient) row.addComponents(button('dm-unfollow', String(auction.id), recipient, 'Unfollow', '🔕', false, ButtonStyle.Danger));
    if (row.components.length) components.push(row);
    return { content, embeds: [embed], components, allowedMentions: { parse: [], ...(recipient ? { users: [recipient] } : {}) } };
}

function privatePage(kind, auction, requestedPage, auctionMessageUrl = null, botUser = null) {
    if (kind === 'images') return imagePage(auction, requestedPage, auctionMessageUrl);
    const id = String(auction.id);
    let pages;
    if (kind === 'bids') {
        const lines = (auction.bids || []).map(bidLine);
        pages = [];
        let page = [];
        let length = 0;
        for (const line of lines) {
            if (page.length && (page.length === BID_PAGE_SIZE || length + 1 + line.length > BID_DESCRIPTION_LIMIT)) {
                pages.push(page);
                page = [];
                length = 0;
            }
            page.push(line);
            length += line.length + (page.length > 1 ? 1 : 0);
        }
        if (page.length) pages.push(page);
    } else {
        pages = chunks(kind === 'payment' ? auction.paymentMethods : auction.description, 1800);
    }
    if (!pages.length) pages = [[]];
    const page = Math.max(0, Math.min(requestedPage, pages.length - 1));
    const title = kind === 'bids' ? `Bid history — Page: ${page + 1}/${pages.length}` : kind === 'payment' ? 'Accepted payment methods' : 'Full description';
    const content = kind === 'bids' ? pages[page].join('\n') || NONE : text(pages[page], 3900);
    const embeds = [new EmbedBuilder().setColor(0x452366).setTitle(title).setDescription(content)];
    if (kind === 'bids') {
        embeds[0].addFields({ name: 'Auction message', value: jumpToMessage(auctionMessageUrl), inline: false });
    }
    embeds.forEach(embed => embed.setFooter(footer(kind === 'bids' && pages.length > 1 ? `${page + 1}/${pages.length}` : null, 'PRO Auctions', botUser)).setTimestamp());
    const components = pageControls(kind, id, page, pages.length);
    return { content: kind !== 'bids' && pages.length > 1 ? `Page ${page + 1} of ${pages.length}` : null, embeds, attachments: [], components, allowedMentions: { parse: [] } };
}

async function handleAuctionButton(interaction, options = {}) {
    const dm = /^auction:dm-(follow|unfollow):(\d+):(\d+)$/.exec(String(interaction.customId || ''));
    if (dm) {
        // Discord can deliver a valid DM interaction without a cached channel after restart.
        const channel = interaction.channel;
        if (interaction.guildId || (channel && channel.type !== ChannelType.DM) || String(interaction.user?.id) !== dm[3]
            || String(interaction.message?.author?.id || '') !== String(interaction.client?.user?.id || '')
            || !interaction.client?.user?.id) {
            await interaction.reply({ content: 'This subscription control is unavailable here.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.deferUpdate();
        if (!options.followService) {
            await interaction.followUp({ content: 'Auction subscriptions are temporarily unavailable. Please try again later.', flags: MessageFlags.Ephemeral });
            return true;
        }
        let following = false;
        if (dm[1] === 'unfollow') await options.followService.unfollow(dm[2], dm[3]);
        else {
            if (!/^\d+$/.test(String(options.guildId || '')) || !/^\d+$/.test(String(options.channelId || ''))) {
                await interaction.followUp({ content: 'Auction subscriptions are temporarily unavailable. Please try again later.', flags: MessageFlags.Ephemeral });
                return true;
            }
            const guild = await interaction.client.guilds.fetch(String(options.guildId));
            let member;
            try { member = await guild.members.fetch(dm[3]); }
            catch (error) {
                if (Number(error.code || error.rawError?.code) !== 10007) throw error;
                await interaction.followUp({ content: 'Join the server and regain access to the auction channel before following this auction.', flags: MessageFlags.Ephemeral });
                return true;
            }
            const channel = await guild.channels.fetch(String(options.channelId));
            if (!channel?.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel)) {
                await interaction.followUp({ content: 'You need access to the auction channel to follow this auction.', flags: MessageFlags.Ephemeral });
                return true;
            }
            const record = await options.getAuctionRecord(dm[2]);
            const result = await options.followService.follow(dm[2], dm[3], record?.messageId);
            if (result.ended || result.unavailable) {
                await interaction.followUp({ content: result.ended ? 'This auction has ended and can no longer be followed.' : 'This auction is unavailable right now.', flags: MessageFlags.Ephemeral });
                return true;
            }
            following = true;
        }
        const rows = interaction.message.components.map(row => ActionRowBuilder.from(row));
        for (const row of rows) row.components = row.components.map(component => component.data.custom_id === interaction.customId
            ? button(following ? 'dm-unfollow' : 'dm-follow', dm[2], dm[3], following ? 'Unfollow' : 'Follow', following ? '🔕' : '🔔', false, following ? ButtonStyle.Danger : ButtonStyle.Success) : component);
        await interaction.editReply({ components: rows });
        await interaction.followUp({ content: following ? '**🔔 You\'re following this auction again and will receive new bid notifications ✅**' : '**🔕 You\'re no longer following this auction and won\'t receive new bid notifications.**', flags: MessageFlags.Ephemeral });
        return true;
    }
    const match = /^auction:(follow|refollow|unfollow|images|bids|description|payment):(\d+):(\d+)$/.exec(String(interaction.customId || ''));
    if (!match) return false;
    if (options.channelId && String(interaction.channelId) !== String(options.channelId)) {
        await interaction.reply({ content: 'This auction control is unavailable here.', flags: MessageFlags.Ephemeral });
        return true;
    }
    if (['follow', 'refollow', 'unfollow'].includes(match[1])) {
        if ((options.guildId && String(interaction.guildId) !== String(options.guildId))
            || !interaction.user?.id || (match[1] !== 'follow' && match[3] !== String(interaction.user.id))) {
            await interaction.reply({ content: 'This subscription control is unavailable here.', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (match[1] === 'follow') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else if (interaction.message?.flags?.has?.(MessageFlags.Ephemeral)) await interaction.deferUpdate();
        else {
            await interaction.reply({ content: 'This private subscription control is unavailable here.', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (!options.followService) {
            await interaction.editReply({ content: 'Auction subscriptions are temporarily unavailable. Please try again later.', allowedMentions: { parse: [] } });
            return true;
        }
        if (match[1] === 'unfollow') {
            await options.followService.unfollow(match[2], String(interaction.user.id));
            await interaction.editReply({ content: '**🔕 You\'re no longer following this auction and won\'t receive further bid updates.**',
                components: [new ActionRowBuilder().addComponents(button('refollow', match[2], String(interaction.user.id), 'Follow', '🔔', false, ButtonStyle.Success))], allowedMentions: { parse: [] } });
            return true;
        }
        const sourceId = match[1] === 'refollow' ? (await options.getAuctionRecord(match[2]))?.messageId : interaction.message?.id;
        const result = await options.followService.follow(match[2], String(interaction.user.id), sourceId);
        const content = result.unavailable ? 'This auction is unavailable and cannot be followed right now.'
            : result.ended ? 'This auction has ended, so it can no longer be followed.' : followConfirmation(result.auction, result.alreadyFollowing);
        const components = result.unavailable || result.ended ? [] : [new ActionRowBuilder().addComponents(
            button('unfollow', match[2], String(interaction.user.id), 'Unfollow', '🔕', false, ButtonStyle.Danger))];
        await interaction.editReply({ content, components, allowedMentions: { parse: [] } });
        return true;
    }
    const isPrivatePage = interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
    if (isPrivatePage) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = await options.getAuctionRecord(match[2]);
    const auction = record?.auction;
    if (!auction) {
        const content = 'This auction is no longer available. Open its forum page for details.';
        await interaction.editReply(interaction.message?.flags?.has?.(MessageFlags.IsComponentsV2)
            ? componentPayload([new TextDisplayBuilder().setContent(content)])
            : { content, allowedMentions: { parse: [] } });
        return true;
    }
    const ids = [interaction.guildId, interaction.channelId, record?.messageMissing ? null : record?.messageId];
    const messageUrl = ids.every(id => /^\d+$/.test(String(id || '')))
        ? `https://discord.com/channels/${ids.join('/')}` : null;
    await interaction.editReply(privatePage(match[1], auction, Number(match[3]), messageUrl, interaction.client?.user));
    return true;
}

class AuctionDiscordNotifier {
    constructor(options = {}) {
        this.client = options.client;
        this.channelId = String(options.channelId || '');
        this.config = options.config || {};
    }

    async channel() {
        if (!this.channelId) throw new Error('Auction channel ID is not configured.');
        const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
        if (!channel?.isTextBased?.() || !channel.messages?.fetch || typeof channel.send !== 'function') {
            throw new Error('Auction channel is unavailable or does not support messages.');
        }
        return channel;
    }

    async findExisting(channel, auction, options = {}) {
        const queuedAt = Date.parse(options.queuedAt || '');
        let before;
        for (let page = 0; page < 100; page++) {
            const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
            const batch = [...messages.values()];
            const existing = batch.find(message => String(message.author?.id || '') === String(this.client.user?.id || '')
                && (options.matches ? options.matches(message) : messageSearchText(message).includes(auction.url)));
            if (existing) return existing;
            const oldest = batch.at(-1);
            if (batch.length < 100 || Number.isFinite(queuedAt) && Number.isFinite(oldest?.createdTimestamp)
                && oldest.createdTimestamp < queuedAt - 60_000) return null;
            if (!oldest?.id || oldest.id === before) throw new Error('Auction duplicate check could not advance through channel history.');
            before = oldest.id;
        }
        throw new Error('Auction duplicate check exceeded its channel-history limit; delivery retained for retry.');
    }

    async send(auction, options = {}) {
        const channel = await this.channel();
        const existing = await this.findExisting(channel, auction, options);
        if (existing) return existing;
        return channel.send({ ...buildAuctionPayload(auction, this.config, this.client.user), nonce: `auction:${auction.id}`, enforceNonce: true });
    }

    async edit(messageId, auction) {
        const channel = await this.channel();
        const message = await channel.messages.fetch(String(messageId));
        const payload = buildAuctionPayload(auction, this.config, this.client.user);
        payload.allowedMentions = { parse: [] };
        const attachments = [...(message.attachments?.values?.() || [])];
        payload.attachments = attachments.filter(attachment => !['cc_logo.webp', 'ww_logo.png'].includes(attachment.name))
            .map(attachment => ({ id: attachment.id }));
        return message.edit(payload);
    }

    async sendBidUpdate(userId, key, job) {
        const user = this.client.users.cache.get(String(userId)) || await this.client.users.fetch(String(userId));
        const channel = user.dmChannel || await user.createDM();
        if (!channel?.messages?.fetch || typeof channel.send !== 'function') throw new Error('Bid notification DMs are unavailable.');
        const ids = [this.config.guildId, this.channelId, job.auctionMessageId];
        const messageUrl = ids.every(id => /^\d+$/.test(String(id || '')))
            ? `https://discord.com/channels/${ids.join('/')}` : null;
        const payload = buildBidNotificationPayload(job, userId, this.client.user, messageUrl);
        const expected = payload.embeds[0].toJSON();
        const identityFields = expected.fields.slice(0, 2);
        const existing = await this.findExisting(channel, job.auction, { queuedAt: job.queuedAt,
            matches: message => (message.embeds || []).some(raw => {
                const embed = raw.data || raw;
                const links = (message.components || []).flatMap(row => row.components || []).map(component => component.url || component.data?.url);
                const normalize = value => String(value || '').replace(/\*\*/g, '').replace(/ UTC$/, '');
                const instant = value => {
                    const text = String(value || '');
                    const discord = /<t:(\d+):/.exec(text);
                    if (discord) return Number(discord[1]) * 1000;
                    const utc = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?: UTC)?$/.exec(text);
                    return utc ? Date.parse(`${utc[1]}T${utc[2]}Z`) : NaN;
                };
                return (embed.url === job.auction.url || links.includes(job.auction.url)) && identityFields.every(field =>
                    embed.fields?.some(other => other.name === field.name && (normalize(other.value) === normalize(field.value)
                        || field.name === 'Bid time (forum)' && Number.isFinite(instant(field.value)) && instant(other.value) === instant(field.value))));
            }) });
        if (existing) return existing;
        const nonce = `af:${createHash('sha256').update(`${job.auction.id}:${key}:${userId}`).digest('hex').slice(0, 22)}`;
        const message = await channel.send({ ...payload, nonce, enforceNonce: true });
        if (!message?.id) throw new Error('Bid notification delivery returned no Discord message ID.');
        return message;
    }
}

module.exports = { AuctionDiscordNotifier, buildAuctionPayload, handleAuctionButton, privatePage,
    followConfirmation, buildBidNotificationPayload };
