// Let staff edit bot messages by ID or private confirmation while enforcing blocked destinations.

// TODO: Include embed content in message creation, update and deletion logs.

'use strict';

const {
    SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags
} = require('discord.js');
const { randomBytes } = require('node:crypto');
const { brandedEditAttachments, visibleEmbedEditOptions, logoFile, LOGO_ATTACHMENT_URL } = require('../features/message-builder/draft.js');
const { hasAllowedRole, currentMember } = require('../features/message-builder/permissions.js');

const ZERO_WIDTH_SPACE = '\u200B';
const CONFIRM_TIMEOUT = 300_000;

// Match Python's SequenceMatcher line grouping to preserve the source edit-log text.
function matchingBlocks(oldLines, newLines) {
    const positions = new Map();
    for (let index = 0; index < newLines.length; index++) {
        const indexes = positions.get(newLines[index]) || [];
        indexes.push(index);
        positions.set(newLines[index], indexes);
    }
    if (newLines.length >= 200) {
        const popularityLimit = Math.floor(newLines.length / 100) + 1;
        for (const [line, indexes] of positions) if (indexes.length > popularityLimit) positions.delete(line);
    }
    const queue = [[0, oldLines.length, 0, newLines.length]];
    const matches = [];
    while (queue.length) {
        const [oldStart, oldEnd, newStart, newEnd] = queue.pop();
        let bestOld = oldStart, bestNew = newStart, bestLength = 0;
        let previousLengths = new Map();
        for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex++) {
            const lengths = new Map();
            for (const newIndex of positions.get(oldLines[oldIndex]) || []) {
                if (newIndex < newStart) continue;
                if (newIndex >= newEnd) break;
                const length = (previousLengths.get(newIndex - 1) || 0) + 1;
                lengths.set(newIndex, length);
                if (length > bestLength) {
                    bestOld = oldIndex - length + 1;
                    bestNew = newIndex - length + 1;
                    bestLength = length;
                }
            }
            previousLengths = lengths;
        }
        while (bestOld > oldStart && bestNew > newStart && oldLines[bestOld - 1] === newLines[bestNew - 1]) {
            bestOld--; bestNew--; bestLength++;
        }
        while (bestOld + bestLength < oldEnd && bestNew + bestLength < newEnd &&
            oldLines[bestOld + bestLength] === newLines[bestNew + bestLength]) bestLength++;
        if (!bestLength) continue;
        matches.push([bestOld, bestNew, bestLength]);
        if (oldStart < bestOld && newStart < bestNew) queue.push([oldStart, bestOld, newStart, bestNew]);
        if (bestOld + bestLength < oldEnd && bestNew + bestLength < newEnd) {
            queue.push([bestOld + bestLength, oldEnd, bestNew + bestLength, newEnd]);
        }
    }
    matches.sort((first, second) => first[0] - second[0] || first[1] - second[1]);
    const merged = [];
    for (const block of matches) {
        const previous = merged.at(-1);
        if (previous && previous[0] + previous[2] === block[0] && previous[1] + previous[2] === block[1]) previous[2] += block[2];
        else merged.push(block);
    }
    merged.push([oldLines.length, newLines.length, 0]);
    return merged;
}

function formatDiffLine(prefix, line) {
    if (line !== '') return prefix + ' ' + line;
    if (prefix === '+') return '+ *[ADDED EMPTY LINE]*';
    if (prefix === '-') return '- *[REMOVED EMPTY LINE]*';
    return '  ';
}

function buildDiffLines(oldContent, newContent, compact = false) {
    const oldLines = (String(oldContent).trimEnd() + '\n').split('\n');
    const newLines = (String(newContent).trimEnd() + '\n').split('\n');
    oldLines.pop(); newLines.pop();
    const lines = [];
    let oldPosition = 0, newPosition = 0;
    for (const [oldStart, newStart, length] of matchingBlocks(oldLines, newLines)) {
        for (const line of oldLines.slice(oldPosition, oldStart)) lines.push(formatDiffLine('-', line));
        for (const line of newLines.slice(newPosition, newStart)) lines.push(formatDiffLine('+', line));
        if (length) {
            if (compact && length > 2) lines.push('  ... (' + length + ' unchanged lines) ...');
            else for (const line of oldLines.slice(oldStart, oldStart + length)) lines.push(formatDiffLine(' ', line));
        }
        oldPosition = oldStart + length;
        newPosition = newStart + length;
    }
    return lines;
}

function formatMessageDiff(oldContent, newContent) {
    let result = buildDiffLines(oldContent, newContent).join('\n');
    if (result.length > 1000) {
        result = buildDiffLines(oldContent, newContent, true).join('\n').slice(0, 980) + '\n... [Truncated due to length]';
    }
    return '```diff\n' + (result || '  No text changes') + '\n```';
}

class EditBotMsg {
    constructor(config) {
        this.name = 'edit_bot_msg';
        this.allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean);
        this.logChannelID = config.logChannelID;
        this.ignoredLogChannels = config.ignoredLogChannels || [];
        this.blockedEditBotMsgChannels = config.blockedEditBotMsgChannels || [];
        this.onCooldown = config.onCooldown || (() => false);
        this.data = [
            new SlashCommandBuilder().setName('edit_bot_msg')
                .setDescription('Edit messages sent by Crow Control Bot (Officer only)').setDMPermission(false)
                .addStringOption(option => option.setName('channel_id')
                    .setDescription('Channel ID where the message is located').setRequired(true))
                .addStringOption(option => option.setName('message_id')
                    .setDescription('Message ID you want to edit').setRequired(true))
                .addStringOption(option => option.setName('content')
                    .setDescription('New message content (use \\n for new line)').setRequired(true)),
            new ContextMenuCommandBuilder().setName('Edit Bot Message (Officer)')
                .setType(ApplicationCommandType.Message).setDMPermission(false)
        ];
    }

    async execute(interaction) {
        if (interaction.isChatInputCommand()) return this.handleSlash(interaction);
        if (interaction.isMessageContextMenuCommand()) return this.handleContext(interaction);
    }

    async denyIfUnauthorized(interaction) {
        if (hasAllowedRole(currentMember(interaction), this.allowedRoles)) return false;
        await this.privateError(interaction, '### ❌  No permission!');
        return true;
    }

    privateError(interaction, content) {
        const payload = { content, flags: MessageFlags.Ephemeral };
        return interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload);
    }

    editPermissionError(interaction, channelId, channel, message, ownerId = interaction.user.id) {
        if (!hasAllowedRole(currentMember(interaction), this.allowedRoles) || ownerId !== interaction.user.id) {
            return '### ❌  No permission!';
        }
        if ([channelId, channel?.id, message?.channelId, message?.channel?.id]
            .some(id => id && this.blockedEditBotMsgChannels.includes(id))) {
            return '### ❌  Editing bot messages is not allowed in this channel!';
        }
        if (message && (!interaction.client.user?.id || message.author?.id !== interaction.client.user.id)) {
            return '### ❌  Only bot messages can be edited!';
        }
        return null;
    }

    async fetchMessage(interaction, channelId, messageId) {
        const channel = await interaction.client.channels.fetch(channelId);
        if (!channel?.messages?.fetch) return { channel, message: null };
        const message = await channel.messages.fetch(messageId);
        return { channel, message };
    }

    async handleSlash(interaction) {
        if (this.onCooldown(interaction.user.id, 'edit_msg', 2)) return interaction.reply('⏳ Slow down!');
        if (await this.denyIfUnauthorized(interaction)) return;
        const channelId = interaction.options.getString('channel_id');
        const messageId = interaction.options.getString('message_id');
        const newContent = interaction.options.getString('content').replace(/\\n/g, '\n');
        if (this.blockedEditBotMsgChannels.includes(channelId)) {
            return interaction.reply({ content: '### ❌  Editing bot messages is not allowed in this channel!', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let channel, message, oldContent;
        try {
            ({ channel, message } = await this.fetchMessage(interaction, channelId, messageId));
            if (!message) return interaction.editReply('### ❌  Failed to edit message.');
            oldContent = message.content || '';
            const permissionError = this.editPermissionError(interaction, channelId, channel, message);
            if (permissionError) return interaction.editReply(permissionError);
            await message.edit({ content: newContent });
        } catch {
            return interaction.editReply('### ❌  Failed to edit message.');
        }
        // Publication has succeeded; audit or feedback failures must not change that outcome.
        try { await this.logMessageEdit(interaction, channel, message, oldContent, newContent, 'no changes'); }
        catch { }
        try { await interaction.editReply('### ✅  Message edited!'); }
        catch { }
    }

    async handleContext(interaction) {
        if (await this.denyIfUnauthorized(interaction)) return;
        const message = interaction.targetMessage;
        const permissionError = this.editPermissionError(interaction, message.channelId, message.channel, message);
        if (permissionError) return this.privateError(interaction, permissionError);
        const modal = new ModalBuilder().setCustomId('editMsg_' + message.id + '_' + message.channelId)
            .setTitle('Edit Bot Message (Officer)');
        const contentInput = new TextInputBuilder().setCustomId('content').setLabel('Message content')
            .setStyle(TextInputStyle.Paragraph).setValue((message.content || ZERO_WIDTH_SPACE).slice(0, 4000)).setRequired(false);
        const appendInput = new TextInputBuilder().setCustomId('append')
            .setLabel('Append instead of replace? (Y/N) - (optional)').setStyle(TextInputStyle.Short).setPlaceholder('N').setRequired(false);
        const embedInput = new TextInputBuilder().setCustomId('embed').setLabel('Embed JSON (optional)')
            .setStyle(TextInputStyle.Paragraph).setPlaceholder('{"title":"Example","description":"Hello"}').setRequired(false);
        modal.addComponents(
            new ActionRowBuilder().addComponents(contentInput),
            new ActionRowBuilder().addComponents(appendInput),
            new ActionRowBuilder().addComponents(embedInput)
        );
        await interaction.showModal(modal);
    }

    async handleModal(interaction) {
        if (!interaction.customId.startsWith('editMsg_')) return false;
        if (await this.denyIfUnauthorized(interaction)) return true;
        const [, messageId, channelId] = interaction.customId.split('_');
        const permissionError = this.editPermissionError(interaction, channelId);
        if (permissionError) {
            await this.privateError(interaction, permissionError);
            return true;
        }
        const appendRaw = (interaction.fields.getTextInputValue('append') || 'n').toLowerCase().trim() || 'n';
        if (appendRaw !== 'y' && appendRaw !== 'n') {
            await interaction.reply({
                content: '### ❌  Invalid Append Input!\n- Please enter **Y** for Yes or **N** for No.', flags: MessageFlags.Ephemeral
            });
            return true;
        }
        const isAppend = appendRaw === 'y';
        const content = interaction.fields.getTextInputValue('content') || ZERO_WIDTH_SPACE;
        const embedRaw = interaction.fields.getTextInputValue('embed');
        const confirmId = 'confirmEdit_' + messageId + '_' + channelId + '_' + isAppend + '_' + randomBytes(8).toString('hex');
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel('✅ Confirm Edit').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('cancelEdit_' + confirmId).setLabel('❌ Cancel').setStyle(ButtonStyle.Danger)
        );
        const previewLabel = isAppend ? 'APPEND to existing message:' : 'your edit below!\n## 👁️‍🗨️ New Message:\n';
        const preview = {
            content: '### ⚠️  <@' + interaction.user.id + '>, please confirm ' + previewLabel + '\n\n' +
                content + '\n\n' + (embedRaw ? '- 📦 *Contains Embed JSON*' : ''),
            components: [buttons]
        };
        const cacheMap = this.editCache(interaction.client);
        cacheMap.set(confirmId, {
            content, embedRaw, ownerId: interaction.user.id, expiresAt: Date.now() + CONFIRM_TIMEOUT,
            preview, processing: false
        });
        try { await interaction.reply({ ...preview, flags: MessageFlags.Ephemeral }); }
        catch (error) { cacheMap.delete(confirmId); throw error; }
        return true;
    }

    editCache(client) {
        client.editCache ??= new Map();
        for (const [key, value] of client.editCache) {
            if (!value.processing && value.expiresAt <= Date.now()) client.editCache.delete(key);
        }
        return client.editCache;
    }

    async handleButton(interaction) {
        const isCancel = interaction.customId === 'cancelEdit' || interaction.customId.startsWith('cancelEdit_');
        if (!isCancel && !interaction.customId.startsWith('confirmEdit_')) return false;
        if (!hasAllowedRole(currentMember(interaction), this.allowedRoles)) {
            await this.privateError(interaction, '### ❌  No permission!');
            return true;
        }
        const cacheMap = this.editCache(interaction.client);
        const confirmId = isCancel ? interaction.customId.slice('cancelEdit_'.length) : interaction.customId;
        const cache = cacheMap.get(confirmId);
        const staleNotice = '### ❌  This edit preview has expired or was already processed. Open Edit Bot Message (Officer) again.';
        if (!cache) {
            await this.privateError(interaction, staleNotice);
            return true;
        }
        if (cache.ownerId !== interaction.user.id) {
            await this.privateError(interaction, '### ❌  No permission!');
            return true;
        }
        if (cache.processing) {
            await this.privateError(interaction, 'This edit preview is already being processed. Please wait, then try again.');
            return true;
        }
        // Reserve both controls before acknowledgement and retain the reservation through recovery rendering.
        cache.processing = true;
        try {
            if (isCancel) {
                await interaction.update({ content: '### ❌  Edit cancelled.', components: [] });
                cacheMap.delete(confirmId);
                return true;
            }
            await interaction.deferUpdate();
            const [, messageId, channelId, appendValue] = confirmId.split('_');
            const permissionError = this.editPermissionError(interaction, channelId, null, null, cache.ownerId);
            if (permissionError) {
                await this.privateError(interaction, permissionError).catch(() => { });
                return true;
            }
            let channel, message, oldContent, finalContent;
            let embedStatus = 'no changes';
            try {
                ({ channel, message } = await this.fetchMessage(interaction, channelId, messageId));
                if (!message) throw new Error('Target message unavailable');
                const accessError = cacheMap.get(confirmId) !== cache ? staleNotice :
                    this.editPermissionError(interaction, channelId, channel, message, cache.ownerId);
                if (accessError) {
                    await this.privateError(interaction, accessError).catch(() => { });
                    return true;
                }
                oldContent = message.content || '';
                finalContent = cache.content;
                if (appendValue === 'true') {
                    const addition = finalContent === ZERO_WIDTH_SPACE ? '' : finalContent;
                    finalContent = oldContent.trimEnd() + '\n' + addition;
                } else if (!finalContent || finalContent === ZERO_WIDTH_SPACE) finalContent = oldContent;
                const editPayload = { content: finalContent || message.content };
                const trimmedEmbed = cache.embedRaw?.trim() || '';
                if (trimmedEmbed) {
                    let replacementEmbed;
                    try {
                        const parsed = JSON.parse(trimmedEmbed);
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected embed object');
                        replacementEmbed = new EmbedBuilder(parsed);
                    } catch {
                        cacheMap.delete(confirmId);
                        await interaction.editReply({ content: '❌ Invalid embed JSON.', components: [] }).catch(() => { });
                        return true;
                    }
                    editPayload.embeds = [replacementEmbed];
                    Object.assign(editPayload, brandedEditAttachments(message, replacementEmbed), visibleEmbedEditOptions(message));
                    embedStatus = message.embeds?.length ? '✏️ **Modified**' : '✅ **Added**';
                }
                await message.edit(editPayload);
            } catch {
                try { await interaction.editReply(cache.preview); }
                catch { }
                await this.privateError(interaction, '### ❌  Failed to edit bot message! Please try Confirm Edit again or Cancel.').catch(() => { });
                return true;
            }
            // Consume the preview before any audit or feedback can fail or yield to another callback.
            cacheMap.delete(confirmId);
            try { await this.logMessageEdit(interaction, channel, message, oldContent, finalContent, embedStatus); }
            catch { }
            try { await interaction.editReply({ content: '### ✅  Bot message successfully updated!', components: [] }); }
            catch { }
        } finally {
            cache.processing = false;
        }
        return true;
    }

    async logMessageEdit(interaction, channel, message, oldContent, finalContent, embedStatus) {
        if (!this.logChannelID || this.ignoredLogChannels.includes(channel.id)) return;
        try {
            const logChannel = await interaction.client.channels.fetch(this.logChannelID);
            if (!logChannel?.send) return;
            const embed = new EmbedBuilder().setColor(0x452366).setTitle('🤖  Bot Message Edited  ✏️')
                .setDescription('Edited by <@' + interaction.user.id + '> (' + interaction.user.username + ')')
                .addFields(
                    { name: 'Channel:', value: '<#' + channel.id + '>', inline: true },
                    { name: 'Message ID:', value: '`' + message.id + '`', inline: true }
                );
            if (embedStatus !== 'no changes') embed.addFields({ name: 'Embed Status:', value: embedStatus, inline: true });
            embed.addFields(
                { name: 'Message Link:', value: '[Jump to Message](' + message.url + ')', inline: false },
                { name: 'Difference:', value: formatMessageDiff(oldContent, finalContent), inline: false }
            ).setTimestamp();
            const logo = logoFile();
            const footer = { text: 'Crow Control Logs' };
            if (logo) footer.iconURL = LOGO_ATTACHMENT_URL;
            embed.setFooter(footer);
            await logChannel.send({ embeds: [embed], ...(logo ? { files: [logo] } : {}) });
        } catch {
            // A failed audit delivery must not report an already-applied edit as a failed edit.
        }
    }
}

module.exports = EditBotMsg;
module.exports.formatMessageDiff = formatMessageDiff;
module.exports.hasAllowedRole = hasAllowedRole;
