// Manage private message previews, owner-bound editing sessions, and confirmed publication.
'use strict';
const { randomBytes } = require('node:crypto');
const { hasAllowedRole, currentMember } = require('./permissions.js');
const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, CheckboxBuilder, EmbedBuilder, FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, RadioGroupBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { DraftValidationError, EmbedDraft, EmbedFieldDraft, EmbedMediaDraft, MessageAttachmentDraft, MAX_MESSAGE_CONTENT, MAX_TITLE, MAX_AUTHOR_NAME, MAX_FOOTER_TEXT, MAX_FIELD_NAME, MAX_FIELD_VALUE, MAX_FIELDS, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_JSON_BYTES, LOGO_PATH, LOGO_FILENAME, LOGO_ATTACHMENT_URL, draftFromMessage, validateEmbedDraft, buildMediaFiles, buildMessageAttachmentFiles, relatedAttachmentIdsFromMessage, reconcileEditAttachments, visibleEmbedEditOptions, readAttachmentBytes, exportMessageJson, importMessageJson, formatEmbedChanges, populatedEmbedProperties, parseEmbedTimestamp, formatEmbedTimestamp, normalizeEmbedColor, expandLiteralLineBreaks, expandFieldSpacingEscapes, isHttpsUrl, isImageAttachment } = require('./draft.js');
const PREFIX = 'send_message:';
const MODAL_PREFIX = `${PREFIX}modal:`;
const EMPTY_VALUE = 'Not set';
const ZERO_WIDTH_FIELD = '\u200b';
const EN_SPACE_FIELD = '\u2002';
const FIELD_EDIT_MARKER = '\u2063';
const CLEAR_FIELD_NOTE = '-# **Note:** Leave fields empty to clear them from the embed!';
const MENTIONS = { parse: ['everyone', 'users', 'roles'], repliedUser: false };
const NO_MENTIONS = { parse: [], repliedUser: false };
const PREVIEW_BUSY = 'This preview is still updating. Wait for it to finish, then try again.';
const COLOR_PRESETS = [
    ['Crimson', 'crimson', '#DC143C', '🔴'], ['Blood Moon', '#5A0000', '#5A0000', '🔴'], ['Orange', 'orange', '#FFA500', '🟠'], ['Coral', '#FF7F50', '#FF7F50', '🟠'], ['Gold', 'gold', '#D4AF37', '🟡'], ['Yellow', 'yellow', '#FFFF00', '🟡'], ['Neon Green', 'neon green', '#39FF14', '🟢'], ['Green', 'green', '#008000', '🟢'], ['Lime', '#00FF00', '#00FF00', '🟢'], ['Cyan', 'cyan', '#00FFFF', '🟦'], ['Teal', 'teal', '#008080', '🟦'], ['Blue', 'blue', '#0000FF', '🟦'], ['Navy Blue', 'navy blue', '#000080', '🟦'], ['Royal Blue', 'royal blue', '#4169E1', '🔵'], ['Electric Blue', '#00BFFF', '#00BFFF', '🔵'], ['Violet', 'violet', '#8A2BE2', '🟣'], ['Purple', 'purple', '#800080', '🟣'], ['Midnight Purple', 'dark purple', '#4B0082', '🟣'], ['Magenta', '#FF00FF', '#FF00FF', '🟣'], ['Hot Pink', 'hot pink', '#FF69B4', '🩷'], ['Brown', '#8B4513', '#8B4513', '🟤'], ['Copper', '#B87333', '#B87333', '🟤'], ['Silver', 'silver', '#C0C0C0', '⚪'], ['White', 'white', '#FFFFFF', '⚪'], ['Black', 'black', '#000000', '⚫']
];
const CURRENT_TIMESTAMP_ALIASES = new Set(['now', 'nov', 'current', 'datetime', 'currentdatetime', 'time', 'currenttime', 'livetime', 'realtime', 'rightnow', 'present', 'timestamp', 'currenttimestamp', 'currentdateandtime']);
function truncate(value, limit) { const text = String(value ?? ''); return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 3)) + '...'; }
function channelMention(channel) { return channel?.id ? `<#${channel.id}>` : 'the selected channel'; }
function formatValidationFailure(errors) {
    const visible = errors.filter(error => !error.startsWith('Add message content'));
    return visible.length ? ['### Message validation failed', 'The message or embed contains incomplete or invalid information.', ...visible.map(error => `- **Cause:** ${error.replace(/\.$/, '')}.`)].join('\n') : '';
}
function formatCommitValidationFailure(errors, { editing = false } = {}) { return [`### Message could not be ${editing ? 'saved' : 'sent'} ❌`, 'The message or embed contains incomplete or invalid information.', ...errors.filter(error => !error.startsWith('Add message content')).map(error => `- **Cause:** ${error.replace(/\.$/, '')}.`)].join('\n'); }
function isInvisibleFieldText(value) { return !value || /^[\p{Cc}\p{Cf}\p{Cs}\p{Zs}]+$/u.test(value); }
function fieldDisplayText(value) {
    const filler = value && /^[\u200b\u2002]+$/.test(value) ? value.at(-1) : value;
    if (filler === ZERO_WIDTH_FIELD)
        return '[empty field: \\u200b]';
    if (filler === EN_SPACE_FIELD)
        return '[empty field: \\u2002]';
    return isInvisibleFieldText(value) ? '[empty field]' : value;
}
function fieldEditDefault(value) { return value === EN_SPACE_FIELD ? FIELD_EDIT_MARKER + ZERO_WIDTH_FIELD : value; }
function fieldUpdateNotice(action, field) { const name = fieldDisplayText(field.name); return isInvisibleFieldText(field.name) ? `${action} *${name}*` : `${action} (${name})`; }
function parseFooterTimestampInput(value) {
    const text = String(value || '').trim();
    if (!text)
        return { timestamp: null, useCurrentTimestamp: false };
    if (CURRENT_TIMESTAMP_ALIASES.has(text.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/0/g, 'o')))
        return { timestamp: null, useCurrentTimestamp: true };
    return { timestamp: parseEmbedTimestamp(text), useCurrentTimestamp: false };
}
async function privateError(interaction, content) { const payload = { content, flags: MessageFlags.Ephemeral }; return interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload); }
class EmbedBuilderSession {
    constructor(controller, { ownerId, target, draft }) {
        this.controller = controller;
        this.config = controller.config;
        this.sessionId = randomBytes(8).toString('hex');
        this.ownerId = ownerId;
        this.target = target;
        this.draft = draft;
        this.originalDraft = target.message ? draftFromMessage(target.message) : new EmbedDraft();
        this.originalMediaAttachmentIds = target.message ? relatedAttachmentIdsFromMessage(target.message, this.originalDraft) : new Set();
        this.additionalEmbeds = target.message ? Array.from(target.message.embeds || []).slice(1) : [];
        this.actions = new Map();
        this.modalContexts = new Map();
        this.activeIds = new Set();
        this.processing = false;
        this.updating = false;
        this.committed = false;
        this.validationActive = Boolean(draft.messageContent || draft.messageAttachments.length || draft.hasEmbedProperties());
        controller.sessions.set(this.sessionId, this);
    }
    get editing() { return Boolean(this.target.message); }
    id(action, context = {}) {
        const id = `${PREFIX}${this.sessionId}:${this.editing ? 'edit' : 'send'}:${randomBytes(5).toString('hex')}`;
        this.actions.set(id, { action, ...context });
        this.activeIds.add(id);
        return id;
    }
    modalId(kind, context = {}) {
        const now = Date.now();
        for (const [id, saved] of this.modalContexts)
            if (saved.expiresAt <= now)
                this.modalContexts.delete(id);
        const id = `${MODAL_PREFIX}${this.sessionId}:${this.editing ? 'edit' : 'send'}:${randomBytes(5).toString('hex')}`;
        this.modalContexts.set(id, { kind, ...context, expiresAt: now + 3600000 });
        return id;
    }
    confirmView() { for (const id of this.actions.keys())
        if (!this.activeIds.has(id))
            this.actions.delete(id); }
    finish({ rememberClosed = true } = {}) {
        this.controller.sessions.delete(this.sessionId);
        if (rememberClosed) this.controller.closed.set(this.sessionId, Date.now() + 30_000);
        this.actions.clear();
        this.modalContexts.clear();
    }
    markChanged() { this.validationActive = true; }
    validationText() { return this.validationActive ? formatValidationFailure(validateEmbedDraft(this.draft)) : ''; }
    appendPreview(lines, emptyMessage) {
        lines.push('### Message/Embed Preview:');
        if (this.draft.messageContent)
            lines.push(this.draft.messageContent);
        if (!this.draft.hasEmbedProperties() && !this.additionalEmbeds.length && !this.draft.messageContent && !this.draft.messageAttachments.length)
            lines.push(emptyMessage || '-# - No changes made yet.. Use the **buttons** below to create an embed message.');
    }
    builderContent(notice) {
        const hasEmbed = this.draft.hasEmbedProperties() || this.additionalEmbeds.length > 0;
        const hasMessage = Boolean(this.draft.messageContent || this.draft.messageAttachments.length);
        const lines = [`### ${this.editing ? 'Edit' : 'Send'} Custom Bot Message\u2002🤖`, `-# - Channel: ${channelMention(this.target.channel)}`];
        if (this.draft.crowControlBranding)
            lines.push('-# - Crow Control Branding: **Yes**');
        if (!this.draft.messageContent)
            lines.push(`-# - Message content: **${EMPTY_VALUE}**`);
        if (!hasEmbed)
            lines.push(`-# - Message embed: **${EMPTY_VALUE}**`);
        if (notice)
            lines.push('', notice);
        const validation = this.validationText();
        if (validation)
            lines.push('', validation);
        lines.push(hasEmbed ? '-# Use the **buttons** below to edit the embed preview.' : hasMessage ? '-# Use the **buttons** below to create an embed.' : '-# Use the **buttons** below to create a message or embed.');
        this.appendPreview(lines);
        return lines.join('\n');
    }
    jsonContent() {
        const lines = ['### Import or Export JSON files', '- -# **Import JSON** accepts a Crow Control export file or valid Discord-style message/embed JSON files.', '- -# **Export JSON** downloads the complete message preview, including the embed and uploaded files.', '- -# Imported data is validated before it replaces the current private draft.', '- -# Importing replaces all current message and embed content. **Export a backup first** if you may need the current draft.'];
        if (this.additionalEmbeds.length)
            lines.push(`-# Additional embeds preserved: **${this.additionalEmbeds.length}**`);
        this.appendPreview(lines, '-# - No message embed to export. Import or create a message embed first.');
        return lines.join('\n');
    }
    colorContent(notice) {
        const lines = ['### Embed Color', "-# Change the embed's left accent bar color by choosing a preset color or entering a custom color using a supported color name or hex code.", `-# - Current color: **${this.draft.effectiveColor || EMPTY_VALUE}**`];
        if (notice)
            lines.push(notice);
        const validation = this.validationText();
        if (validation)
            lines.push('', validation);
        this.appendPreview(lines);
        return lines.join('\n');
    }
    fieldsContent(notice) {
        const lines = ['### Embed Fields', `- Fields: **${this.draft.fields.length}/${MAX_FIELDS}**`, '-# Press on **Add Field** to create a new field shown under the embed description.', '-# Select the field from the dropdown to edit, delete, or move it.'];
        if (notice)
            lines.push(`- ${notice.startsWith('Selected field') ? 'Field Selection' : 'Field Updates'}: **${notice.replace(/\.$/, '')}**`);
        const validation = this.validationText();
        if (validation)
            lines.push('', validation);
        this.appendPreview(lines);
        return lines.join('\n');
    }
    previewEmbeds() { return this.draft.buildEmbeds({ preview: true }); }
    view(page = 'builder', selectedIndex = null) {
        this.activeIds = new Set();
        const button = (label, emoji, style, action, context = {}, disabled = false) => new ButtonBuilder().setCustomId(this.id(action, context)).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
        const row = (...items) => new ActionRowBuilder().addComponents(...items);
        const back = () => button('Back to embed builder', '⬅️', ButtonStyle.Secondary, 'back');
        if (page === 'json')
            return [row(button('Import JSON', '📥', ButtonStyle.Success, 'import'), button('Export JSON', '📤', ButtonStyle.Primary, 'export'), back())];
        if (page === 'color') {
            const select = new StringSelectMenuBuilder().setCustomId(this.id('color_preset')).setPlaceholder('Choose a preset embed color').setMinValues(1).setMaxValues(1).addOptions(COLOR_PRESETS.map(([label, value, description, emoji]) => ({ label, value, description, emoji, default: this.draft.effectiveColor === description })));
            return [row(select), row(button('Custom color', '🎨', ButtonStyle.Primary, 'color_custom'), button('Remove color', '🗑️', ButtonStyle.Danger, 'color_remove'), back())];
        }
        if (page === 'fields') {
            const fields = this.draft.fields;
            const select = new StringSelectMenuBuilder().setCustomId(this.id('field_select')).setPlaceholder('Select a field').setMinValues(1).setMaxValues(1).setDisabled(!fields.length).addOptions(fields.length ? fields.map((field, i) => ({ label: truncate(fieldDisplayText(field.name), 100), value: String(i), description: truncate(fieldDisplayText(field.value).replace(/\n/g, ' '), 100), default: i === selectedIndex })) : [{ label: 'No fields added', value: 'none' }]);
            return [row(select), row(button('Add Field', '➕', ButtonStyle.Success, 'field_add', {}, fields.length >= MAX_FIELDS), button('Edit', '✏️', ButtonStyle.Primary, 'field_edit', { selectedIndex }), button('Delete', '🗑️', ButtonStyle.Danger, 'field_delete', { selectedIndex }), button('Move Up', '⬆️', ButtonStyle.Secondary, 'field_up', { selectedIndex }), button('Move Down', '⬇️', ButtonStyle.Secondary, 'field_down', { selectedIndex })), row(back())];
        }
        const edit = (label, emoji, kind) => button(label, emoji, ButtonStyle.Primary, 'modal', { kind });
        const colorRow = [button('Embed Color', '🎨', ButtonStyle.Primary, 'color')];
        if (!this.editing)
            colorRow.push(edit('Channel', '#️⃣', 'channel'));
        colorRow.push(button('Import/Export JSON', '🔄', ButtonStyle.Secondary, 'json'));
        return [row(edit('Message Content', '💬', 'content'), edit('Embed Title', '🏷️', 'title'), edit('Embed Author', '👤', 'author'), edit('Embed Thumbnail', '🖼️', 'thumbnail')), row(edit('Embed Description', '📝', 'description'), button('Embed Fields', '📋', ButtonStyle.Primary, 'fields'), edit('Embed Image', '🏞️', 'image'), edit('Embed Footer', '📌', 'footer')), row(...colorRow), row(button(this.editing ? 'Save' : 'Send', this.editing ? '💾' : '📨', ButtonStyle.Success, 'commit'), button('Cancel', '🗑️', ButtonStyle.Danger, 'cancel'))];
    }
    async open(interaction) {
        try {
            const components = this.view();
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const files = await buildMessageAttachmentFiles(this.draft);
            await interaction.editReply({ content: this.builderContent(), embeds: this.previewEmbeds(), attachments: [], files, components });
            this.confirmView();
        } catch (error) {
            // A preview that never opened has no visible controls keeping its session reachable.
            this.finish({ rememberClosed: false });
            throw error;
        }
    }
    async refresh(interaction, { replaceMessageAttachments = false, notice, activateValidation = true, responseDeferred = false } = {}) {
        if (activateValidation)
            this.markChanged();
        const components = this.view();
        if (!responseDeferred)
            await interaction.deferUpdate();
        const payload = { content: this.builderContent(notice), embeds: this.previewEmbeds(), components };
        if (replaceMessageAttachments) {
            payload.attachments = [];
            payload.files = await buildMessageAttachmentFiles(this.draft);
        }
        await interaction.editReply(payload);
        this.confirmView();
    }
    async showPage(interaction, page, selectedIndex = null, notice) {
        const components = this.view(page, selectedIndex);
        await interaction.deferUpdate();
        const content = page === 'json' ? this.jsonContent() : page === 'color' ? this.colorContent(notice) : page === 'fields' ? this.fieldsContent(notice) : this.builderContent(notice);
        await interaction.editReply({ content, embeds: this.previewEmbeds(), components });
        this.confirmView();
    }
    accessError(interaction) {
        if (this.controller.sessions.get(this.sessionId) !== this || this.committed)
            return 'This message has already been processed.';
        if (interaction.user.id !== this.ownerId)
            return 'This embed builder belongs to another user.';
        if (!hasAllowedRole(currentMember(interaction), this.controller.allowedRoles))
            return '### No permission!';
        return null;
    }
    publicationError(interaction, message = this.target.message) {
        const error = this.accessError(interaction);
        if (error) return error;
        if (this.editing) {
            if (!interaction.client.user?.id || message?.author?.id !== interaction.client.user.id)
                return 'Only Crow Control bot messages can be edited.';
            const blocked = this.config.blockedEditBotMsgChannels || [];
            if ([this.target.channel?.id, this.target.message?.channelId, this.target.message?.channel?.id,
                message.channelId, message.channel?.id].some(id => id && blocked.includes(id)))
                return 'Editing bot messages is not allowed in this channel.';
        }
        return null;
    }
    async rejectReservedAction(interaction, error) {
        try { await privateError(interaction, error); }
        finally { this.processing = false; }
    }
    async cancel(interaction) {
        if (this.updating) return privateError(interaction, PREVIEW_BUSY);
        if (this.processing || this.committed) return privateError(interaction, 'This message has already been processed.');
        const error = this.accessError(interaction);
        if (error) return privateError(interaction, error);
        this.processing = true;
        try { await interaction.deferUpdate(); }
        catch (error) { this.processing = false; throw error; }
        const denied = this.accessError(interaction);
        if (denied) return this.rejectReservedAction(interaction, denied);
        this.finish();
        await interaction.editReply({ content: 'Embed builder canceled.', embeds: [], attachments: [], components: [] });
    }
    async commit(interaction) {
        if (this.updating) return privateError(interaction, PREVIEW_BUSY);
        const errors = validateEmbedDraft(this.draft);
        if (errors.length) {
            this.markChanged();
            return privateError(interaction, formatCommitValidationFailure(errors, { editing: this.editing }));
        }
        if (this.processing || this.committed)
            return privateError(interaction, 'This message has already been processed.');
        const error = this.publicationError(interaction);
        if (error) return privateError(interaction, error);
        this.processing = true;
        try {
            await interaction.deferUpdate();
        }
        catch {
            this.processing = false;
            return;
        }
        let result;
        try {
            const files = await buildMediaFiles(this.draft);
            const embeds = [...this.draft.buildEmbeds(), ...this.additionalEmbeds];
            if (this.editing) {
                let message = this.target.message;
                if (message.channel?.messages?.fetch)
                    message = await message.channel.messages.fetch(message.id);
                const attachments = reconcileEditAttachments(message, { originalMediaAttachmentIds: this.originalMediaAttachmentIds, draft: this.draft, newFiles: files });
                const denied = this.publicationError(interaction, message);
                if (denied) return this.rejectReservedAction(interaction, denied);
                this.target.message = message;
                result = await message.edit({ content: this.draft.messageContent || null, embeds, ...attachments,
                    ...(embeds.length ? visibleEmbedEditOptions(message) : {}), allowedMentions: MENTIONS });
            }
            else {
                const denied = this.publicationError(interaction);
                if (denied) return this.rejectReservedAction(interaction, denied);
                result = await this.target.channel.send({ content: this.draft.messageContent || null, embeds, files, allowedMentions: MENTIONS });
            }
        }
        catch (error) {
            this.controller.logError('Custom embed operation failed', error);
            try {
                await interaction.editReply({ content: this.builderContent('### Message not saved\nDiscord could not complete the request. No success was recorded.'), embeds: this.previewEmbeds(), components: this.view() });
                this.confirmView();
            }
            catch { }
            finally { this.processing = false; }
            return;
        }
        this.processing = false;
        this.committed = true;
        this.finish();
        try {
            await interaction.editReply({ content: this.editing ? `Embed updated in ${channelMention(this.target.channel)}.` : `Embed sent to ${channelMention(this.target.channel)}.`, embeds: [], attachments: [], components: [] });
        }
        catch { }
        try {
            await this.audit(interaction, result);
        }
        catch (error) {
            this.controller.logError('Custom embed audit log failed', error);
        }
    }
    async updatePreview(interaction, work) {
        if (this.updating) return privateError(interaction, PREVIEW_BUSY);
        if (this.processing || this.committed || this.controller.sessions.get(this.sessionId) !== this)
            return privateError(interaction, 'This message has already been processed.');
        // Imports, attachment reads and destination lookups must finish before publication can start.
        this.updating = true;
        try { return await work(); }
        finally { this.updating = false; }
    }
    async audit(interaction, message) {
        const ignored = this.config.ignoredLogChannels || [];
        if (!this.config.logChannelID || [this.target.invocationChannelId, this.target.channel.id].some(id => ignored.includes(id)))
            return;
        const channel = interaction.client.channels.cache?.get(this.config.logChannelID) || await interaction.client.channels.fetch(this.config.logChannelID);
        if (!channel?.send)
            return;
        const embed = new EmbedBuilder().setTitle(this.editing ? 'Bot Embed Edited' : 'Custom Bot Message Sent').setDescription(`Executor: <@${interaction.user.id}> (\`${interaction.user.username}\`)`).setColor(0xE63B50).setFooter({ text: 'Crow Control Logs', iconURL: LOGO_ATTACHMENT_URL }).setTimestamp();
        if (this.editing) {
            embed.addFields({ name: 'Channel', value: channelMention(this.target.channel), inline: true }, { name: 'Message ID', value: `\`${message.id}\``, inline: true }, { name: 'Message', value: `[Jump to Message](${message.url})`, inline: false });
            if (this.originalDraft.messageContent !== this.draft.messageContent) {
                const { formatMessageDiff } = require('../../commands/edit_bot_msg.js');
                embed.addFields({ name: 'Message Content Changes', value: formatMessageDiff(this.originalDraft.messageContent, this.draft.messageContent), inline: false });
            }
            embed.addFields({ name: 'Embed Changes', value: truncate(formatEmbedChanges(this.originalDraft, this.draft), 1024), inline: false });
        }
        else
            embed.addFields({ name: 'Invocation Channel', value: this.target.invocationChannelId ? `<#${this.target.invocationChannelId}>` : 'Unknown', inline: true }, { name: 'Destination', value: channelMention(this.target.channel), inline: true }, { name: 'Message ID', value: `\`${message.id}\``, inline: true }, { name: 'Message', value: `[Jump to Message](${message.url})`, inline: false }, { name: 'Crow Control Branding', value: this.draft.crowControlBranding ? 'Yes' : 'No', inline: true }, { name: 'Populated Properties', value: truncate(populatedEmbedProperties(this.draft).join(', ') || 'Message content only', 1024), inline: false });
        await channel.send({ embeds: [embed], files: [new AttachmentBuilder(LOGO_PATH, { name: LOGO_FILENAME })], allowedMentions: NO_MENTIONS });
    }
}
function builderModal(session, kind, context = {}) {
    const titles = { content: 'Message Content', title: 'Embed Title', author: 'Embed Author', thumbnail: 'Embed Thumbnail', description: 'Embed Description', image: 'Embed Image', footer: 'Embed Footer', channel: 'Destination Channel', import: 'Import Message JSON', color: 'Embed Color', field: context.index == null ? 'Add Embed Field' : 'Edit Embed Field' };
    const draft = session.draft;
    if (kind === 'description')
        context = { ...context, originalDescription: draft.description };
    const modal = new ModalBuilder().setCustomId(session.modalId(kind, context)).setTitle(titles[kind]);
    const label = (text, component, description) => {
        const value = new LabelBuilder().setLabel(text);
        if (description)
            value.setDescription(description);
        if (component instanceof TextInputBuilder)
            value.setTextInputComponent(component);
        else if (component instanceof FileUploadBuilder)
            value.setFileUploadComponent(component);
        else if (component instanceof CheckboxBuilder)
            value.setCheckboxComponent(component);
        else if (component instanceof RadioGroupBuilder)
            value.setRadioGroupComponent(component);
        else
            value.setChannelSelectMenuComponent(component);
        modal.addLabelComponents(value);
    };
    const note = text => modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    const text = (name, id, value = '', { description, placeholder, style = TextInputStyle.Short, required = false, maxLength } = {}) => {
        const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
        if (value)
            input.setValue(String(value).slice(0, 4000));
        if (placeholder)
            input.setPlaceholder(placeholder);
        if (maxLength)
            input.setMaxLength(maxLength);
        label(name, input, description);
        return input;
    };
    const upload = (name, id, description, required = false, maxValues = 1) => label(name, new FileUploadBuilder().setCustomId(id).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(maxValues), description);
    const remove = (media, id, name, description) => {
        if (!media.hasSource)
            return false;
        label(`Remove current ${name}`, new CheckboxBuilder().setCustomId(id).setDefault(false), description);
        return true;
    };
    const media = (value, kind, name, urlDescription, uploadDescription) => {
        text(`${name} URL`, `${kind}_url`, value.inputUrl, { placeholder: 'https://example.com/image.png', description: urlDescription });
        upload(`${name} upload`, `${kind}_upload`, uploadDescription);
    };
    if (kind === 'content') {
        text('Message content', 'message_content', draft.messageContent, { style: TextInputStyle.Paragraph, maxLength: MAX_MESSAGE_CONTENT, placeholder: 'To include emojis or role mentions, use the message_content option when running the command.', description: 'Message content and attachments are displayed above the embed. Leave empty to clear message content.' });
        note('-# **Note:** You can compose and send a message in Discord first, then **right-click** it and select **Copy Text**. This preserves the original markdown formatting, as well as channel and role mentions, allowing you to paste it directly into the message content field.');
        const count = draft.messageAttachments.length;
        upload('Message attachments', 'message_attachments', count ? `Upload 1-10 files. Uploading new files will replace the current ${count} ${count === 1 ? 'file' : 'files'}.` : 'Upload 1-10 files, which are shown below the Message content.', false, MAX_MESSAGE_ATTACHMENTS);
        if (count)
            label('Remove current attachments', new CheckboxBuilder().setCustomId('remove_message_attachments').setDefault(false), 'Removes uploaded attachments.');
    }
    else if (kind === 'title') {
        text('Title', 'title', draft.title, { placeholder: 'Enter a title..', description: 'The title is displayed at the top-left of the embed.', maxLength: MAX_TITLE });
        text('Title URL', 'title_url', draft.titleUrl, { placeholder: 'https://example.com', description: 'Enter a URL link to turn the title into a clickable link. (Title turns blue)' });
        note(CLEAR_FIELD_NOTE);
    }
    else if (kind === 'author') {
        text('Author Name', 'author_name', draft.authorName, { placeholder: 'Enter Author Name...', description: 'Author name is displayed at the top left, above the embed title.', maxLength: MAX_AUTHOR_NAME });
        text('Author URL', 'author_url', draft.authorUrl, { placeholder: 'https://example.com', description: 'Enter a URL link to turn Author Name into a clickable link.' });
        media(draft.authorIcon, 'author-icon', 'Author Icon', 'Author Icon is displayed next to Author Name. You can enter an image URL link or upload an image.', 'The uploaded image takes precedence over the image URL.');
        if (!remove(draft.authorIcon, 'remove_author_icon', 'Author Icon', 'Note: Leave fields empty to clear them from the embed!'))
            note(CLEAR_FIELD_NOTE);
    }
    else if (kind === 'thumbnail' || kind === 'image') {
        const thumbnail = kind === 'thumbnail';
        const name = thumbnail ? 'Thumbnail' : 'Image';
        note(thumbnail ? '**Embed Thumbnail**\n-# A small image displayed in the top-right corner of the embed.\n-# Enter an image URL or upload an image; an uploaded image takes precedence over the URL.\n-# Leave both fields empty to remove the thumbnail.' : '**Embed Image**\n-# A large image displayed at the bottom of the embed, above the footer.\n-# Enter an image URL or upload an image; an uploaded image takes precedence over the URL.\n-# Leave both fields empty to remove the embed image.');
        media(draft[kind], kind, name);
        remove(draft[kind], `remove_${kind}`, name, `Remove the current ${thumbnail ? 'thumbnail' : 'image'} from the embed.`);
    }
    else if (kind === 'description') {
        text('Description (max 4000 characters)', 'description', draft.description.slice(0, 4000), { style: TextInputStyle.Paragraph, maxLength: 4000, placeholder: 'Enter a description... (supports markdown and line breaks)', description: 'Description is displayed under the embed title.' });
        note('-# **Note:** You can compose and send a message in Discord first, then **right-click** it and select **Copy Text**. This preserves the original markdown formatting, as well as channel and role mentions, allowing you to paste it directly into the description field.\n\nLeave the description field empty to clear it from the embed!');
    }
    else if (kind === 'footer') {
        text('Footer text', 'footer_text', draft.footerText, { style: TextInputStyle.Paragraph, maxLength: MAX_FOOTER_TEXT, placeholder: 'Enter footer text...', description: 'Footer text is displayed in the bottom-left corner of the embed.' });
        media(draft.footerIcon, 'footer-icon', 'Footer icon', 'Footer Icon is displayed next to the footer text. You can use a URL link or upload an image.', 'The uploaded image takes precedence over the image URL.');
        text('Footer Timestamp', 'timestamp', draft.useCurrentTimestamp ? 'NOW' : formatEmbedTimestamp(draft.timestamp), { placeholder: 'NOW, or 2026-07-18 12:30 PM UTC+2 (UTC by default)', description: 'Enter custom datetime "YYYY-MM-DD HH:MM" (12/24-hour format), or "NOW" for a live Discord timestamp.' });
        if (!remove(draft.footerIcon, 'remove_footer_icon', 'Footer icon', 'Note: Leave fields empty to clear them from the embed!'))
            note(CLEAR_FIELD_NOTE);
    }
    else if (kind === 'channel') {
        const select = new ChannelSelectMenuBuilder().setCustomId('destination_channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setPlaceholder('Select a destination channel').setMinValues(0).setMaxValues(1).setRequired(false);
        if (session.target.channel?.id)
            select.setDefaultChannels(session.target.channel.id);
        label('Channel', select, 'Select a destination channel for the custom bot message.');
        note(`-# **Note:** Leave empty to use command origin channel: ${channelMention(session.target.invocationChannel || session.target.channel)}`);
    }
    else if (kind === 'import') {
        upload('JSON file', 'message_json_upload', 'Upload a Crow Control export file or a Discord-style JSON file.', true);
        note('**⚠️\u2002Notice**\nImporting replaces all current message and embed content. **Export a backup first** if you may need the current draft.\n-# **Note:** Invalid files leave the current draft unchanged!');
    }
    else if (kind === 'color') {
        text('Embed Color', 'color', draft.color, { placeholder: 'blue, dark red, neon green, or #39FF14', description: 'Accepts color names or 6-digit hex codes (with or without #)' });
        note('-# **Note:** Leave the color field empty to remove the embed color!');
    }
    else if (kind === 'field') {
        const field = context.index == null ? new EmbedFieldDraft('', '', true) : draft.fields[context.index];
        text('Field name', 'field_name', fieldEditDefault(field.name), { placeholder: 'Enter field name (max 256 characters)', description: 'Field name is displayed in bold.', required: true, maxLength: MAX_FIELD_NAME });
        text('Field value', 'field_value', fieldEditDefault(field.value), { placeholder: 'Enter field value (max 1024 characters)', description: 'Field value is displayed below the field name.', style: TextInputStyle.Paragraph, required: true, maxLength: MAX_FIELD_VALUE });
        note('-# **Tip:** Enter **\\u200b** or **\\u2002** to create empty fields.\n-# - **\\u200b:** Creates a large empty area.\n-# - **\\u2002:** Creates a small empty area or can be used to indent text.');
        label('Display Inline? (Yes/No)', new RadioGroupBuilder().setCustomId('field_inline').addOptions({ label: 'Yes', value: 'yes', description: 'Allows up to 3 fields to be displayed side by side on the same row.', default: field.inline }, { label: 'No', value: 'no', description: 'Displays the field at full width on its own row.', default: !field.inline }));
    }
    return modal;
}
function optionalUrl(label, value) { const text = String(value || '').trim(); if (text && !isHttpsUrl(text))
    throw new DraftValidationError(`${label} must be a valid HTTPS URL.`); return text; }
function mediaFromModal(current, { kind, label, enteredUrl, uploads = [], remove = false }) {
    const media = new EmbedMediaDraft({ url: current.url, attachment: current.attachment, filename: current.filename, isNewUpload: current.isNewUpload });
    if (remove) {
        media.clear();
        return media;
    }
    const text = String(enteredUrl || '').trim();
    if (uploads.length) {
        if (!isImageAttachment(uploads[0]))
            throw new DraftValidationError(`${label} upload must be an image file.`);
        media.setUpload(kind, uploads[0]);
    }
    else if (text.startsWith('attachment://')) {
        if (!media.attachment || text !== media.inputUrl)
            throw new DraftValidationError(`Upload a new ${label.toLowerCase()} or enter a valid HTTPS URL.`);
    }
    else if (text)
        media.setUrl(optionalUrl(`${label} URL`, text));
    else
        media.clear();
    return media;
}
function values(collection) { return collection ? Array.from(collection.values ? collection.values() : collection) : []; }
function input(interaction, id) { try {
    return interaction.fields.getTextInputValue(id) || '';
}
catch {
    return '';
} }
function uploads(interaction, id) { try {
    return values(interaction.fields.getUploadedFiles(id));
}
catch {
    return [];
} }
function checked(interaction, id) { try {
    return interaction.fields.getCheckbox(id);
}
catch {
    return false;
} }
class BuilderController {
    constructor(config = {}) {
        this.config = config;
        this.allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean);
        this.sessions = new Map();
        this.closed = new Map();
    }
    createSession(props) { return new EmbedBuilderSession(this, props); }
    logError(message, error) { console.error(`[CC LOG] ${message}:`, { name: error?.name, code: error?.code, message: error?.message }); }
    async resolve(interaction, { modal = false } = {}) {
        const id = interaction.customId || '';
        if (!id.startsWith(PREFIX))
            return null;
        const parts = id.slice(modal ? MODAL_PREFIX.length : PREFIX.length).split(':');
        const [sessionId, mode] = parts;
        const now = Date.now();
        for (const [key, expiry] of this.closed)
            if (expiry <= now)
                this.closed.delete(key);
        const session = this.sessions.get(sessionId);
        if (!session) {
            if (!this.closed.has(sessionId) && !interaction.deferred && !interaction.replied) {
                const recovery = mode === 'edit' ? 'Right-click the **original public Crow Control bot message**, then select **Apps → Edit Bot Embed (Officer)** again.' : 'Run the `/send_message` command again to start a new builder.';
                await privateError(interaction, `### Embed builder session ended\nThis preview was opened before the bot restarted. ${recovery}`);
            }
            return { handled: true };
        }
        if (interaction.user.id !== session.ownerId) {
            await privateError(interaction, 'This embed builder belongs to another user.');
            return { handled: true };
        }
        if (session.processing || session.committed) {
            await privateError(interaction, 'This message has already been processed.');
            return { handled: true };
        }
        if (session.updating) {
            await privateError(interaction, PREVIEW_BUSY);
            return { handled: true };
        }
        return { session };
    }
    async handleButton(interaction) {
        if (!interaction.customId?.startsWith(PREFIX) || interaction.customId.startsWith(MODAL_PREFIX))
            return false;
        const found = await this.resolve(interaction);
        if (!found?.session)
            return true;
        const session = found.session;
        const action = session.actions.get(interaction.customId);
        if (!action)
            return true;
        try {
            if (action.action === 'commit') await session.commit(interaction);
            else if (action.action === 'cancel') await session.cancel(interaction);
            else await session.updatePreview(interaction, async () => {
                switch (action.action) {
                    case 'modal':
                        await interaction.showModal(builderModal(session, action.kind));
                        break;
                    case 'back':
                        await session.showPage(interaction, 'builder');
                        break;
                    case 'json':
                        await session.showPage(interaction, 'json');
                        break;
                    case 'color':
                        await session.showPage(interaction, 'color');
                        break;
                    case 'fields':
                        await session.showPage(interaction, 'fields');
                        break;
                    case 'import':
                        await interaction.showModal(builderModal(session, 'import'));
                        break;
                    case 'export':
                        await this.exportJson(interaction, session);
                        break;
                    case 'color_custom':
                        await interaction.showModal(builderModal(session, 'color'));
                        break;
                    case 'color_remove':
                        session.draft.color = '';
                        session.markChanged();
                        await session.showPage(interaction, 'color');
                        break;
                    case 'field_add':
                        if (session.draft.fields.length >= MAX_FIELDS)
                            await privateError(interaction, 'An embed can contain at most 25 fields.');
                        else
                            await interaction.showModal(builderModal(session, 'field'));
                        break;
                    default: if (action.action.startsWith('field_'))
                        await this.fieldAction(interaction, session, action);
                }
            });
        }
        catch (error) {
            this.logError('Embed builder component failed', error);
            await privateError(interaction, '### Builder action failed\nThe action could not be completed. Please try the button again.').catch(() => { });
        }
        return true;
    }
    async handleSelect(interaction) {
        if (!interaction.customId?.startsWith(PREFIX))
            return false;
        const found = await this.resolve(interaction);
        if (!found?.session)
            return true;
        const session = found.session;
        const action = session.actions.get(interaction.customId);
        if (!action)
            return true;
        try {
            await session.updatePreview(interaction, async () => {
                if (action.action === 'color_preset') {
                    session.draft.color = normalizeEmbedColor(interaction.values[0]);
                    session.markChanged();
                    await session.showPage(interaction, 'color');
                }
                else if (action.action === 'field_select') {
                    const index = Number(interaction.values[0]);
                    if (Number.isInteger(index) && session.draft.fields[index])
                        await session.showPage(interaction, 'fields', index, `Selected field ${index + 1}: ${fieldDisplayText(session.draft.fields[index].name)}`);
                }
            });
        }
        catch (error) {
            this.logError('Embed builder component failed', error);
            await privateError(interaction, '### Builder action failed\nThe action could not be completed. Please try the button again.').catch(() => { });
        }
        return true;
    }
    async fieldAction(interaction, session, action) {
        const index = action.selectedIndex;
        const fields = session.draft.fields;
        if (index == null || index < 0 || index >= fields.length)
            return privateError(interaction, 'Select a field first.');
        if (action.action === 'field_edit')
            return interaction.showModal(builderModal(session, 'field', { index }));
        let notice;
        let selected = null;
        if (action.action === 'field_delete')
            notice = fieldUpdateNotice('Field deleted', fields.splice(index, 1)[0]);
        else if (action.action === 'field_up') {
            if (index === 0)
                return privateError(interaction, 'That field is already first.');
            [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
            selected = index - 1;
            notice = fieldUpdateNotice('Field moved up', fields[selected]);
        }
        else if (action.action === 'field_down') {
            if (index >= fields.length - 1)
                return privateError(interaction, 'That field is already last.');
            [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]];
            selected = index + 1;
            notice = fieldUpdateNotice('Field moved down', fields[selected]);
        }
        session.markChanged();
        await session.showPage(interaction, 'fields', selected, notice);
    }
    async handleModal(interaction) {
        if (!interaction.customId?.startsWith(MODAL_PREFIX))
            return false;
        const found = await this.resolve(interaction, { modal: true });
        if (!found?.session)
            return true;
        const session = found.session;
        const context = session.modalContexts.get(interaction.customId);
        if (!context || context.expiresAt <= Date.now())
            return true;
        try {
            await session.updatePreview(interaction, async () => {
                session.modalContexts.delete(interaction.customId);
                await this.submitModal(interaction, session, context);
            });
        }
        catch (error) {
            if (!(error instanceof DraftValidationError)) {
                this.logError('Embed builder modal failed', error);
                await privateError(interaction, '### Builder action failed\nThe submitted changes were not saved. Please try again.').catch(() => { });
            }
            else
                await privateError(interaction, `### Invalid value\n- ${error.message}`).catch(() => { });
        }
        return true;
    }
    async submitModal(interaction, session, context) {
        const draft = session.draft;
        const media = (current, kind, label, removeId) => mediaFromModal(current, { kind, label, enteredUrl: input(interaction, `${kind}_url`), uploads: uploads(interaction, `${kind}_upload`), remove: checked(interaction, removeId) });
        switch (context.kind) {
            case 'content': {
                draft.messageContent = expandLiteralLineBreaks(input(interaction, 'message_content'));
                const files = uploads(interaction, 'message_attachments');
                const remove = checked(interaction, 'remove_message_attachments');
                if (files.length)
                    draft.messageAttachments = files.map(file => new MessageAttachmentDraft(file));
                else if (remove)
                    draft.messageAttachments = [];
                return session.refresh(interaction, { replaceMessageAttachments: Boolean(files.length) || remove });
            }
            case 'title': {
                const title = expandLiteralLineBreaks(input(interaction, 'title'));
                const url = optionalUrl('Title URL', input(interaction, 'title_url'));
                if (url && !title)
                    throw new DraftValidationError('Add a Title before setting its URL.');
                draft.title = title;
                draft.titleUrl = url;
                break;
            }
            case 'author': {
                const name = expandLiteralLineBreaks(input(interaction, 'author_name'));
                const url = optionalUrl('Author URL', input(interaction, 'author_url'));
                const icon = media(draft.authorIcon, 'author-icon', 'Author Icon', 'remove_author_icon');
                if ((url || icon.hasSource) && !name)
                    throw new DraftValidationError('Author URL and icon require an Author name.');
                draft.authorName = name;
                draft.authorUrl = url;
                draft.authorIcon = icon;
                return session.refresh(interaction, { replaceMessageAttachments: true });
            }
            case 'thumbnail':
                draft.thumbnail = media(draft.thumbnail, 'thumbnail', 'Thumbnail', 'remove_thumbnail');
                return session.refresh(interaction, { replaceMessageAttachments: true });
            case 'image':
                draft.image = media(draft.image, 'image', 'Image', 'remove_image');
                return session.refresh(interaction, { replaceMessageAttachments: true });
            case 'description': {
                let text = expandLiteralLineBreaks(input(interaction, 'description'));
                const original = context.originalDescription;
                if (original.length > 4000 && text === original.slice(0, 4000))
                    text = original;
                draft.description = text;
                break;
            }
            case 'footer': {
                const text = expandLiteralLineBreaks(input(interaction, 'footer_text'));
                const icon = media(draft.footerIcon, 'footer-icon', 'Footer icon', 'remove_footer_icon');
                const timestamp = parseFooterTimestampInput(input(interaction, 'timestamp'));
                if (icon.hasSource && !text)
                    throw new DraftValidationError('Footer icon requires Footer text.');
                draft.footerText = text;
                draft.footerIcon = icon;
                draft.timestamp = timestamp.timestamp;
                draft.useCurrentTimestamp = timestamp.useCurrentTimestamp;
                return session.refresh(interaction, { replaceMessageAttachments: true });
            }
            case 'color':
                draft.color = normalizeEmbedColor(input(interaction, 'color'));
                session.markChanged();
                return session.showPage(interaction, 'color');
            case 'field': {
                const rawName = input(interaction, 'field_name');
                const rawValue = input(interaction, 'field_value');
                let name = expandFieldSpacingEscapes(rawName);
                let value = expandFieldSpacingEscapes(rawValue);
                if (context.index != null) {
                    const current = draft.fields[context.index];
                    if (current.name === EN_SPACE_FIELD && (!rawName || rawName === FIELD_EDIT_MARKER + ZERO_WIDTH_FIELD))
                        name = current.name;
                    if (current.value === EN_SPACE_FIELD && (!rawValue || rawValue === FIELD_EDIT_MARKER + ZERO_WIDTH_FIELD))
                        value = current.value;
                }
                const field = new EmbedFieldDraft(name, value, interaction.fields.getRadioGroup('field_inline') !== 'no');
                let index = context.index;
                let notice;
                if (index == null) {
                    draft.fields.push(field);
                    index = draft.fields.length - 1;
                    notice = fieldUpdateNotice('Field added', field);
                }
                else {
                    draft.fields[index] = field;
                    notice = fieldUpdateNotice('Field updated', field);
                }
                session.markChanged();
                return session.showPage(interaction, 'fields', index, notice);
            }
            case 'channel': {
                await interaction.deferUpdate();
                const selected = values(interaction.fields.getSelectedChannels('destination_channel'))[0];
                let destination = selected || session.target.invocationChannel || interaction.channel;
                if (destination && typeof destination.send !== 'function')
                    destination = interaction.guild?.channels?.cache?.get(destination.id) || interaction.client.channels.cache?.get(destination.id) || await interaction.client.channels.fetch(destination.id).catch(() => null);
                if (!destination?.send)
                    return privateError(interaction, '### Channel could not be changed\n- **Cause:** The selected channel could not be found or does not allow bot messages.');
                session.target.channel = destination;
                return session.refresh(interaction, { activateValidation: false, responseDeferred: true });
            }
            case 'import': return this.importJson(interaction, session);
        }
        return session.refresh(interaction);
    }
    async exportJson(interaction, session) {
        await interaction.deferUpdate();
        const draft = session.draft;
        if (!draft.messageContent.trim() && !draft.messageAttachments.length && !draft.hasEmbedProperties() && !session.additionalEmbeds.length)
            return privateError(interaction, "You can't export an empty message embed! Import or create an embed first.");
        try {
            const data = await exportMessageJson(draft, { additionalEmbeds: session.additionalEmbeds });
            const uploadLimit = Number(interaction.guild?.maximumUploadLimit || interaction.guild?.filesizeLimit || 10 * 1024 * 1024);
            if (data.length > uploadLimit)
                throw new DraftValidationError(`The export is ${(data.length / (1024 * 1024)).toFixed(1)} MB, but this server allows files up to ${(uploadLimit / (1024 * 1024)).toFixed(1)} MB. Remove large attachments or use image URLs before exporting.`);
            await interaction.followUp({ content: '### JSON export file ready to download!\n- The JSON file below contains the message and embed draft.', files: [new AttachmentBuilder(data, { name: 'crow-control-message.json' })], flags: MessageFlags.Ephemeral });
        }
        catch (error) {
            if (!(error instanceof DraftValidationError)) {
                this.logError('Message JSON export failed', error);
                await privateError(interaction, '### JSON export failed\n- An attachment could not be read or the file could not be created. Please try again.');
            }
            else
                await privateError(interaction, `### JSON export failed\n- ${truncate(error.message, 1800)}`);
        }
    }
    async importJson(interaction, session) {
        await interaction.deferUpdate();
        const attachment = uploads(interaction, 'message_json_upload')[0];
        if (!attachment || !String(attachment.name || attachment.filename).toLowerCase().endsWith('.json'))
            return privateError(interaction, '### JSON import failed\n- Upload a file with the `.json` extension.');
        if (Number(attachment.size || 0) > MAX_MESSAGE_JSON_BYTES)
            return privateError(interaction, `### JSON import failed\n- JSON files cannot exceed ${MAX_MESSAGE_JSON_BYTES / (1024 * 1024)} MB.`);
        let imported, files;
        try {
            const raw = await readAttachmentBytes(attachment);
            imported = importMessageJson(raw);
            files = await buildMessageAttachmentFiles(imported.draft);
        }
        catch (error) {
            if (!(error instanceof DraftValidationError)) {
                this.logError('Message JSON import failed', error);
                return privateError(interaction, '### JSON import failed\n- The uploaded file could not be read. The current draft was not changed.');
            }
            return privateError(interaction, `### JSON import failed\n- ${truncate(error.message, 1800)}`);
        }
        const previous = { draft: session.draft, additionalEmbeds: session.additionalEmbeds, validationActive: session.validationActive, activeIds: session.activeIds, actions: new Map(session.actions) };
        session.draft = imported.draft;
        session.additionalEmbeds = imported.additionalEmbeds;
        session.validationActive = true;
        try {
            const components = session.view();
            await interaction.editReply({ content: session.builderContent('### JSON imported successfully\n- The message and embed draft have been replaced.'), embeds: session.previewEmbeds(), attachments: [], files, components });
            session.confirmView();
        }
        catch (error) {
            Object.assign(session, previous);
            this.logError('Imported message preview could not be rendered', error);
            await privateError(interaction, '### JSON import failed\n- Discord could not render the imported preview. The current draft was not changed.');
        }
    }
}
module.exports = { EmbedBuilderSession, BuilderController, builderModal, formatValidationFailure, formatCommitValidationFailure, fieldDisplayText, fieldEditDefault, parseFooterTimestampInput, mediaFromModal, PREFIX, MODAL_PREFIX };
