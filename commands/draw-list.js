// Let staff replace the PvP Draw List text after a private preview of the changed lines.

'use strict';

const {
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags
} = require('discord.js');
const { randomBytes } = require('node:crypto');
const { CONFIRM_TIMEOUT, buildDiffLines, previewExpiryLine } = require('./edit_bot_msg.js');
const {
    CROW_CONTROL_BRANDING_COLOR, LOGO_ATTACHMENT_URL, MAX_MESSAGE_CONTENT, expandLiteralLineBreaks, logoFile,
    visibleEmbedEditOptions
} = require('../features/message-builder/draft.js');
const { hasAllowedRole, currentMember } = require('../features/message-builder/permissions.js');

const MEMBER_LOOKUP_TIMEOUT = 5_000;
// Leaves room in the 4096-character embed description for the countdown or the log heading.
const MAX_DIFF_LENGTH = 3900;
const BUTTON_ID = /^draw-list:(confirm|cancel):([0-9a-f]{16})$/;
const MENTION = /<(@!?|@&|#)(\d{17,20})>/g;
const TIMESTAMP = /<t:-?\d+(:[A-Za-z])?>/g;
const LAST_UPDATED_LINE = /Last updated.*<t:-?\d+(?::[A-Za-z])?>/i;
const DISCORD_ATTACHMENT_URL = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/(\d+)\/\d+\/([^/?#]+)/;

const NO_PERMISSION = '### ❌  No permission!';
const NOT_CONFIGURED = '### ❌  The draw list is not configured.\n' +
    '- Set `pvpDrawListChannelID` and `pvpDrawListMessageID` in config.json.';
const LOAD_FAILED = '### ❌  The draw list message could not be loaded.\n' +
    '- Please try again. If this keeps happening, check `pvpDrawListChannelID` and `pvpDrawListMessageID` in config.json.';
const NOT_BOT_MESSAGE = '### ❌  The configured draw list message was not sent by this bot.';
const MISSING_LAST_UPDATED = '### ❌  The draw list embed has no **Last updated** timestamp to refresh.\n' +
    '- Add it back with **Edit Bot Embed (Officer)**, then try again.';
const NO_CHANGES = '### ⚠️  No changes found.\n- Your text matches the current draw list.';
const EXPIRED = '### ❌  This preview has expired or was already used.\n- Run `/draw-list` again.';
const PROCESSING = 'This draw list update is already being processed. Please wait.';
const STALE = '### ❌  The draw list was changed after your preview, so your changes were not saved.\n' +
    '- Copy the current text and run `/draw-list` again.';
const UPDATE_FAILED = '### ❌  The draw list could not be updated.\n- Press **Confirm** to try again, or **Cancel**.';
const SUCCESS = 'The draw list has been successfully updated ✅';
const CANCELED = 'Your changes have been canceled ❌';

const sameText = (first, second) => first.trim() === second.trim();
const mentionKey = (kind, id) => (kind === '@!' ? '@' : kind) + id;

// Group consecutive added and removed lines so separate edits stay apart in the preview.
function changedLineGroups(oldContent, newContent) {
    const groups = [];
    let group = [];
    for (const line of buildDiffLines(oldContent, newContent)) {
        if (line.startsWith('- ') || line.startsWith('+ ')) group.push(line);
        else if (group.length) {
            groups.push(group);
            group = [];
        }
    }
    if (group.length) groups.push(group);
    return groups;
}

// Code blocks show raw mention IDs, so the preview names the members, roles and channels it can resolve.
async function mentionLabels(guild, text) {
    const labels = new Map();
    if (!guild) return labels;
    const userIds = new Set();
    for (const [, kind, id] of text.matchAll(MENTION)) {
        if (kind === '@&') {
            const role = guild.roles?.cache?.get(id);
            if (role) labels.set(mentionKey(kind, id), '@' + role.name);
        } else if (kind === '#') {
            const channel = guild.channels?.cache?.get(id);
            if (channel) labels.set(mentionKey(kind, id), '#' + channel.name);
        } else userIds.add(id);
    }
    const missing = [...userIds].filter(id => !guild.members?.cache?.has(id));
    if (missing.length && guild.members?.fetch) {
        // Members that cannot be fetched keep their raw mention in the preview.
        await guild.members.fetch({ user: missing, time: MEMBER_LOOKUP_TIMEOUT }).catch(() => null);
    }
    for (const id of userIds) {
        const member = guild.members?.cache?.get(id);
        if (member) labels.set(mentionKey('@', id), '@' + member.displayName);
    }
    return labels;
}

function formatChangedLines(groups, labels) {
    let text = groups.map(group => group.join('\n')).join('\n\n')
        .replace(MENTION, (match, kind, id) => labels.get(mentionKey(kind, id)) ?? match)
        .replaceAll('```', '`​`​`');
    if (text.length > MAX_DIFF_LENGTH) {
        const end = text.lastIndexOf('\n', MAX_DIFF_LENGTH);
        text = text.slice(0, end > 0 ? end : MAX_DIFF_LENGTH) + '\n... [Truncated due to length]';
    }
    return '```diff\n' + text + '\n```';
}

function lastUpdatedIndex(embeds) {
    return [...(embeds || [])].findIndex(embed =>
        String(embed?.description || '').split('\n').some(line => LAST_UPDATED_LINE.test(line)));
}

// Discord stores an embed image sent as attachment://name as a CDN link and hides that file from the message.
// Sending the link back detaches the file, which then shows as a separate image, so files uploaded in this
// channel are referenced by name again.
function embedFileReference(url, channelId) {
    const match = DISCORD_ATTACHMENT_URL.exec(url || '');
    return match && match[1] === String(channelId) ? 'attachment://' + match[2] : url;
}

function resendableEmbed(embed, channelId) {
    const data = EmbedBuilder.from(embed).toJSON();
    for (const [part, key] of [['author', 'icon_url'], ['footer', 'icon_url'], ['image', 'url'], ['thumbnail', 'url']]) {
        if (data[part]?.[key]) data[part] = { ...data[part], [key]: embedFileReference(data[part][key], channelId) };
    }
    return new EmbedBuilder(data);
}

// Only the timestamps on the "Last updated" line change; every other embed property is sent back as fetched.
function refreshLastUpdated(embeds, seconds, channelId) {
    const index = lastUpdatedIndex(embeds);
    return [...embeds].map((embed, position) => {
        const builder = resendableEmbed(embed, channelId);
        if (position !== index) return builder;
        return builder.setDescription(embed.description.split('\n').map(line => LAST_UPDATED_LINE.test(line)
            ? line.replace(TIMESTAMP, (_, style = '') => '<t:' + seconds + style + '>') : line).join('\n'));
    });
}

function previewPayload(ownerId, token, diff, expiresAt) {
    return {
        content: '### <@' + ownerId + '>, please review and confirm your changes below.\n\n' +
            '-# - The **Last updated** timestamp is automatically updated.',
        embeds: [new EmbedBuilder().setColor(CROW_CONTROL_BRANDING_COLOR)
            .setDescription(diff + '\n' + previewExpiryLine(expiresAt))],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('draw-list:confirm:' + token).setLabel('Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('draw-list:cancel:' + token).setLabel('Cancel').setStyle(ButtonStyle.Danger)
        )],
        allowedMentions: { parse: [] }
    };
}

class DrawList {
    constructor(config) {
        this.name = 'draw-list';
        this.allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean);
        this.channelId = config.pvpDrawListChannelID;
        this.messageId = config.pvpDrawListMessageID;
        this.logChannelID = config.logChannelID;
        this.ignoredLogChannels = config.ignoredLogChannels || [];
        this.onCooldown = config.onCooldown || (() => false);
        this.now = config.now || (() => Date.now());
        this.previews = new Map();
        this.data = new SlashCommandBuilder().setName('draw-list')
            .setDescription('Edit the PvP Draw List. Only works in the #pvp-draw-list channel (Officer-only)').setDMPermission(false)
            .addStringOption(option => option.setName('content')
                .setDescription('Right-click the draw message, select Copy Text, and paste it here. Use Shift + Enter for new lines.')
                .setRequired(true).setMaxLength(MAX_MESSAGE_CONTENT));
    }

    isAllowed(interaction) {
        return hasAllowedRole(currentMember(interaction), this.allowedRoles);
    }

    privateMessage(interaction, content) {
        const payload = { content, flags: MessageFlags.Ephemeral };
        return interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload);
    }

    async fetchDrawList(client) {
        const channel = await client.channels.fetch(this.channelId);
        if (!channel?.messages?.fetch) throw new Error('The draw list channel cannot hold messages');
        return { channel, message: await channel.messages.fetch(this.messageId) };
    }

    drawListProblem(client, message) {
        if (!client.user?.id || message.author?.id !== client.user.id) return NOT_BOT_MESSAGE;
        if (lastUpdatedIndex(message.embeds) < 0) return MISSING_LAST_UPDATED;
        return null;
    }

    pruneExpired() {
        const now = this.now();
        for (const [token, preview] of this.previews) {
            if (!preview.processing && preview.expiresAt <= now) this.previews.delete(token);
        }
    }

    async execute(interaction) {
        if (!this.isAllowed(interaction)) return this.privateMessage(interaction, NO_PERMISSION);
        if (this.onCooldown(interaction.user.id, 'draw_list', 2)) return this.privateMessage(interaction, '⏳ Slow down!');
        if (!this.channelId || !this.messageId) return this.privateMessage(interaction, NOT_CONFIGURED);
        if (interaction.channelId !== this.channelId) {
            return this.privateMessage(interaction, 'Please use the command in the PvP Draw channel: <#' + this.channelId + '>');
        }
        const content = expandLiteralLineBreaks(interaction.options.getString('content', true));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let message;
        try {
            ({ message } = await this.fetchDrawList(interaction.client));
        } catch {
            return interaction.editReply(LOAD_FAILED);
        }
        const problem = this.isAllowed(interaction) ? this.drawListProblem(interaction.client, message) : NO_PERMISSION;
        if (problem) return interaction.editReply(problem);
        const baseContent = message.content || '';
        const groups = changedLineGroups(baseContent, content);
        if (!groups.length) return interaction.editReply(NO_CHANGES);
        const labels = await mentionLabels(interaction.guild, groups.flat().join('\n'));
        const token = randomBytes(8).toString('hex');
        const expiresAt = this.now() + CONFIRM_TIMEOUT;
        const diff = formatChangedLines(groups, labels);
        const preview = previewPayload(interaction.user.id, token, diff, expiresAt);
        this.pruneExpired();
        this.previews.set(token, {
            ownerId: interaction.user.id, content, baseContent, diff, preview, expiresAt, processing: false
        });
        try {
            await interaction.editReply(preview);
        } catch (error) {
            this.previews.delete(token);
            throw error;
        }
    }

    async handleButton(interaction) {
        const match = BUTTON_ID.exec(interaction.customId || '');
        if (!match) return false;
        const [, action, token] = match;
        this.pruneExpired();
        const preview = this.previews.get(token);
        let rejection = null;
        if (!this.isAllowed(interaction) || (preview && preview.ownerId !== interaction.user.id)) rejection = NO_PERMISSION;
        else if (!preview) rejection = EXPIRED;
        else if (preview.processing) rejection = PROCESSING;
        if (rejection) {
            await this.privateMessage(interaction, rejection);
            return true;
        }
        // Reserve the preview so a second Confirm or Cancel cannot run alongside this one.
        preview.processing = true;
        try {
            if (action === 'confirm') await this.confirm(interaction, token, preview);
            else {
                await interaction.update({ content: CANCELED, embeds: [], components: [] });
                this.previews.delete(token);
            }
        } finally {
            preview.processing = false;
        }
        return true;
    }

    async confirm(interaction, token, preview) {
        await interaction.deferUpdate();
        let target;
        try {
            target = await this.fetchDrawList(interaction.client);
        } catch {
            await this.offerRetry(interaction, preview);
            return;
        }
        // Roles can change while the acknowledgement and lookup are pending.
        if (!this.isAllowed(interaction)) {
            await this.privateMessage(interaction, NO_PERMISSION).catch(() => { });
            return;
        }
        const { channel, message } = target;
        const current = message.content || '';
        if (sameText(current, preview.content)) {
            // A timed-out earlier attempt may already have saved this text together with its timestamp.
            this.previews.delete(token);
        } else {
            if (!sameText(current, preview.baseContent)) {
                this.previews.delete(token);
                await interaction.editReply({ content: STALE, embeds: [], components: [] }).catch(() => { });
                return;
            }
            const problem = this.drawListProblem(interaction.client, message);
            if (problem) {
                await this.privateMessage(interaction, problem).catch(() => { });
                return;
            }
            try {
                await message.edit({
                    content: preview.content,
                    embeds: refreshLastUpdated(message.embeds, Math.floor(this.now() / 1000), message.channelId),
                    ...visibleEmbedEditOptions(message)
                });
            } catch {
                await this.offerRetry(interaction, preview);
                return;
            }
            this.previews.delete(token);
            await this.logUpdate(interaction, channel, preview.diff);
        }
        await interaction.editReply({ content: SUCCESS, embeds: [], components: [] }).catch(() => { });
    }

    async logUpdate(interaction, channel, diff) {
        if (!this.logChannelID || this.ignoredLogChannels.includes(channel.id)) return;
        try {
            const logChannel = await interaction.client.channels.fetch(this.logChannelID);
            if (!logChannel?.send) return;
            const logo = logoFile();
            const embed = new EmbedBuilder().setColor(CROW_CONTROL_BRANDING_COLOR)
                .setDescription('### <@' + interaction.user.id + '> updated the [PvP Draw List](https://discord.com/channels/' +
                    interaction.guildId + '/' + channel.id + ')\n' +
                    '-# Use the `/draw-list` command to update the <#' + channel.id + '>\n' + diff)
                .setFooter({ text: 'PvP Draw List Log', ...(logo ? { iconURL: LOGO_ATTACHMENT_URL } : {}) })
                .setTimestamp(this.now());
            await logChannel.send({ embeds: [embed], ...(logo ? { files: [logo] } : {}), allowedMentions: { parse: [] } });
        } catch {
            // A failed log delivery must not report a saved draw list as a failed update.
        }
    }

    async offerRetry(interaction, preview) {
        await interaction.editReply(preview.preview).catch(() => { });
        await this.privateMessage(interaction, UPDATE_FAILED).catch(() => { });
    }
}

module.exports = DrawList;
