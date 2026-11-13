// Tells officers when a published scout message is deleted and lets them keep, repost, remove or edit the report.
'use strict';

const { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder } = require('discord.js');
const { setTimeout: delay } = require('node:timers/promises');
const { scoutIds } = require('./ScoutChanges.js');
const { canonicalIgn } = require('./PvpScoutParser.js');
const { ScoutDeletionStore } = require('./ScoutDeletionStore.js');
const { downloadImageAttachment, imageAttachment, refreshImageAttachments } = require('./ScoutImageUrls.js');
const { scoutPayload, scoutTextInput, withScoutLoading } = require('./ScoutPresentation.js');
const { SERVERS } = require('./ScoutServerSettings.js');

const PREFIX = 'scout-deleted:';
const AUDIT_LOG_DELAY_MS = 1500;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ACTION_HELP = '**Scout report is no longer shown in `/scout`. Select an action below:**\n'
    + '- **Keep:** Keep the scout report in `/scout`\n'
    + '- **Keep & repost:** Keep in `/scout` and repost in scout channel (CC bot author)\n'
    + '- **Remove:** Remove from `/scout`\n'
    + '- **Edit:** Edit the scout report before taking any action';

const mention = id => /^\d+$/u.test(String(id || '')) ? `<@${id}>` : null;
const plain = (value, max = 128) => String(value || '').replace(/([\\*_~`|>])/gu, '\\$1').replace(/@/gu, '@\u200b').slice(0, max);
const codeBlock = (value, max = 1000) => {
    const text = String(value || '').trim().replace(/```/gu, "'''");
    return text ? `\`\`\`\n${text.length > max ? `${text.slice(0, max - 15)}\n… (truncated)` : text}\n\`\`\`` : '*No text. The message contained only attachments.*';
};

function button(label, action, server, messageId, style, emoji = null) {
    const control = new ButtonBuilder().setLabel(label).setStyle(style).setCustomId(`${PREFIX}${action}:${server}:${messageId}`);
    return emoji ? control.setEmoji(emoji) : control;
}

function hasSavedImages(row) {
    return (row.archive_attachments || []).some(imageAttachment);
}

// The report as /scout would show it. Screenshots held by the alert message are referenced as its own attachments.
function previewSource(context, files = null) {
    const { deletion, row, view } = context;
    const hostedUrl = image => ({ ...image, url: `attachment://${image.name}` });
    let attachments = [];
    if (files) {
        attachments = files.map((file, index) => ({ id: `upload-${index}`, name: file.name, url: `attachment://${file.name}`, contentType: 'image/png' }));
    } else if (deletion.status === 'reposted' && deletion.images.length) {
        // The repost carries its own copies; this alert keeps showing the ones it already holds.
        attachments = deletion.images.map(hostedUrl);
    } else if (Object.hasOwn(row.staffOverrides || {}, 'attachments')) {
        attachments = (view.attachments || []).map(item => {
            const hosted = deletion.images.find(image => String(image.id) === String(item.id));
            return hosted ? hostedUrl({ ...item, name: hosted.name }) : item;
        });
    }
    return { ...view, attachments };
}

function deletionPayload(context, { server = 'gold', page = 'main', files = null, iconURL = null } = {}) {
    // Loaded here because the report embed lives with the /scout command, which loads the scouting features itself.
    const { buildScoutEmbed } = require('../../commands/scout.js');
    const { deletion, row, reportRoot } = context;
    const id = String(row.message_id);
    const source = previewSource(context, files);
    const author = mention(row.author_id) || plain(row.author_username || 'Unknown member');
    const postedAt = new Date(row.created_at).getTime();
    const deleter = !deletion.deleted_by_id ? 'Unknown'
        : String(deletion.deleted_by_id) === String(row.author_id) ? `${mention(deletion.deleted_by_id)} (report author)`
            : `${mention(deletion.deleted_by_id)} (moderator)`;
    const officer = mention(deletion.decided_by_id) || 'an officer';
    const decidedAt = deletion.decided_at ? new Date(deletion.decided_at).getTime() : NaN;
    const header = [
        `**Deleted by:** ${deleter}`,
        `**Scouted by:** ${author}${Number.isFinite(postedAt) ? ` • <t:${Math.floor(postedAt / 1000)}:F>` : ''}`,
        `**Server:** ${SERVERS[server].markup} ${SERVERS[server].label}`,
        scoutIds(deletion.report_id, id),
        ...(reportRoot ? [`-# This message was a follow-up to the report for **${plain(canonicalIgn(reportRoot.opponent_ign), 64)}**.`] : []),
        ...(hasSavedImages(row) && !source.attachments.some(imageAttachment)
            ? ['-# ⚠️ The screenshot could not be recovered after the message was deleted.'] : [])
    ].join('\n');
    const states = {
        pending: ['🗑️ Scout Report Deleted', 0xED4245, ACTION_HELP],
        kept: ['✅ Deleted Scout Report Kept', 0x57F287, `**Kept** by ${officer}. The scout report is shown in \`/scout\` again.`],
        reposted: ['✅ Deleted Scout Report Kept & Reposted', 0x57F287, `**Kept and reposted** by ${officer}. The scout report is shown in \`/scout\` again.`
            + (source.source_url ? `\n[**Jump to reposted message ↗️**](${source.source_url})` : '')],
        removed: ['❌ Deleted Scout Report Removed', 0x95A5A6, `**Removed** by ${officer}. The scout report stays out of \`/scout\`.`]
    };
    let [title, color, body] = states[deletion.status] || states.pending;
    const editing = page === 'edit' && deletion.status === 'pending';
    if (editing) {
        [title, color] = ['✏️ Edit Deleted Scout Report', 0x5865F2];
        body = 'Changes are saved to this report and appear in `/scout` once it is kept. Press **Back** to return and select an action.';
    }
    const info = new EmbedBuilder().setTitle(title).setColor(color).setDescription(`${header}\n\n${body}`)
        .addFields({ name: 'Deleted message', value: codeBlock(source.message_content), inline: false });
    if (Number.isFinite(decidedAt) && deletion.status !== 'pending') info.setTimestamp(decidedAt);

    const preview = buildScoutEmbed(source, [source], 0, 1, author).embed;
    // The deleted Discord message can no longer be opened; only a repost has a working link.
    if (deletion.status !== 'reposted') {
        preview.setFields((preview.data.fields || []).filter(field => !/^Original messages?$/u.test(field.name)));
    }
    preview.setFooter({ text: `Crow Control • Scout Message ID: ${id}`, ...(iconURL ? { iconURL } : {}) });

    const components = [];
    if (editing) {
        components.push(new ActionRowBuilder().addComponents(
            button('Edit details', 'edit-details', server, id, ButtonStyle.Primary),
            button('Edit message text', 'edit-text', server, id, ButtonStyle.Primary),
            button('Edit screenshots', 'edit-images', server, id, ButtonStyle.Primary),
            button('Back', 'back', server, id, ButtonStyle.Secondary, '⬅️')));
    } else if (deletion.status === 'pending') {
        components.push(new ActionRowBuilder().addComponents(
            button('Keep', 'keep', server, id, ButtonStyle.Success),
            button('Keep & repost', 'repost', server, id, ButtonStyle.Primary),
            button('Remove', 'remove', server, id, ButtonStyle.Danger),
            button('Edit', 'edit', server, id, ButtonStyle.Secondary)));
    } else if (deletion.status === 'kept') {
        components.push(new ActionRowBuilder().addComponents(
            button('Repost in scout channel', 'repost', server, id, ButtonStyle.Secondary)));
    }
    return { embeds: [info, preview], components, allowedMentions: { parse: [] } };
}

class ScoutDeletionReview {
    constructor({ client, store, server = 'gold', channelId, officerChannelId, guildId, regroup = async () => {},
        stopped = () => false, auditDelayMs = AUDIT_LOG_DELAY_MS, download = downloadImageAttachment }) {
        this.client = client;
        this.store = new ScoutDeletionStore(store);
        this.server = server === 'silver' ? 'silver' : 'gold';
        this.channelId = String(channelId || '');
        this.officerChannelId = String(officerChannelId || '');
        this.guildId = String(guildId || '');
        this.regroup = regroup;
        this.stopped = stopped;
        this.auditDelayMs = auditDelayMs;
        this.download = download;
        this.auditCounts = new Map();
        this.editors = new Map();
    }

    get enabled() { return Boolean(this.officerChannelId) && this.store.enabled; }

    payload(context, options = {}) {
        return deletionPayload(context, { server: this.server, iconURL: this.client?.user?.displayAvatarURL?.() || null, ...options });
    }

    // Updates of the alert drop screenshot copies an officer removed from the report, and keep every other file.
    panel(context, message, options = {}) {
        const payload = this.payload(context, options);
        const hosted = new Set(context.deletion.images.map(image => String(image.id)));
        const kept = new Set(previewSource(context).attachments.map(item => String(item.id)));
        const current = [...(message?.attachments?.values?.() || [])];
        if (current.some(item => hosted.has(String(item.id)) && !kept.has(String(item.id)))) {
            payload.attachments = current.filter(item => !hosted.has(String(item.id)) || kept.has(String(item.id)))
                .map(item => ({ id: item.id }));
        }
        return payload;
    }

    // Call before the archive row is marked deleted, on the ingestion queue.
    async capture(messageId) {
        return this.enabled ? this.store.capture(messageId) : null;
    }

    // Discord records only moderator deletions. Entries for the same moderator, member and channel
    // are merged for a few minutes, so a merged entry counts only when its total grew.
    async deleter(message, row) {
        const targetId = row.ign_source === 'member_submission' ? this.client?.user?.id : row.author_id;
        const self = row.ign_source === 'member_submission' ? null : row.author_id ? String(row.author_id) : null;
        const guild = message?.guild || this.client?.guilds?.cache?.get(this.guildId);
        if (!guild?.fetchAuditLogs) return null;
        if (this.auditDelayMs) await delay(this.auditDelayMs, undefined, { ref: false });
        try {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 6 });
            let moderator = null;
            for (const entry of logs.entries.values()) {
                const count = Number(entry.extra?.count || 1), seen = this.auditCounts.get(entry.id);
                this.auditCounts.set(entry.id, count);
                const isNew = seen === undefined && Date.now() - entry.createdTimestamp < 15_000 + this.auditDelayMs;
                if (!moderator && String(entry.targetId || entry.target?.id || '') === String(targetId || '')
                    && String(entry.extra?.channel?.id || '') === this.channelId && (isNew || seen !== undefined && count > seen)) {
                    moderator = String(entry.executorId || entry.executor?.id || '') || null;
                }
            }
            while (this.auditCounts.size > 50) this.auditCounts.delete(this.auditCounts.keys().next().value);
            return moderator || self;
        } catch (error) {
            console.warn(`[CC LOG] Could not read the audit log for deleted scout ${row.message_id}: ${error.message}`);
            return null;
        }
    }

    // Discord removes a deleted message's files, so the alert keeps its own copies.
    async recoverImages(row, message = null) {
        const cached = new Map([...(message?.attachments?.values?.() || [])].map(item => [String(item.id), item.url]));
        const images = (row.archive_attachments || []).filter(imageAttachment).slice(0, 10);
        const files = [];
        for (const [index, image] of images.entries()) {
            try {
                const file = await this.download({ ...image, url: cached.get(String(image.id)) || image.url }, MAX_UPLOAD_BYTES);
                const extension = String(file.name || '').match(/\.(png|jpe?g|webp|gif|avif)$/iu)?.[1] || 'png';
                files.push({ attachment: file.attachment, name: `scout-${row.message_id}-${index + 1}.${extension.toLowerCase()}` });
            } catch (error) {
                console.warn(`[CC LOG] Could not recover a screenshot of deleted scout ${row.message_id}: ${error.message}`);
            }
        }
        return files;
    }

    async officerChannel() {
        const channel = this.client.channels.cache.get(this.officerChannelId) || await this.client.channels.fetch(this.officerChannelId);
        if (!channel?.send) throw new Error('Officer channel is unavailable or cannot receive messages.');
        return channel;
    }

    async announce(messageId, message = null, { lookupDeleter = true, deletedById: known = null } = {}) {
        if (!this.enabled || this.stopped()) return null;
        const id = String(messageId);
        let context = await this.store.context(id);
        if (!context || context.deletion.status !== 'pending' || context.deletion.alert_message_id) return null;
        const deletedById = known ?? (lookupDeleter ? await this.deleter(message, context.row) : null);
        const files = await this.recoverImages(context.row, message);
        if (this.stopped()) return null;
        context = await this.store.context(id);
        if (!context || context.deletion.status !== 'pending' || context.deletion.alert_message_id) return null;
        context.deletion.deleted_by_id = deletedById || context.deletion.deleted_by_id;
        const sent = await (await this.officerChannel()).send({ ...this.payload(context, { files }), files,
            nonce: `sd:${id}`.slice(-25), enforceNonce: true });
        const images = [...(sent.attachments?.values?.() || [])].map(item => ({
            id: String(item.id), name: item.name, url: item.url, proxyURL: item.proxyURL, contentType: item.contentType,
            size: item.size, width: item.width, height: item.height,
            sourceChannelId: String(sent.channelId || this.officerChannelId), sourceMessageId: String(sent.id) }));
        await this.store.saveAlert(id, { alertChannelId: sent.channelId || this.officerChannelId, alertMessageId: sent.id, deletedById, images });
        return sent;
    }

    // Alerts whose delivery was interrupted are sent after a restart.
    async restorePending() {
        if (!this.enabled) return;
        for (const deletion of await this.store.pendingAlerts()) {
            if (this.stopped()) return;
            await this.announce(deletion.message_id, null, { lookupDeleter: false }).catch(error => {
                console.warn(`[CC LOG] Deleted scout alert ${deletion.message_id} will retry on the next start: ${error.message}`);
            });
        }
    }

    async repost(context) {
        const { row, view } = context;
        const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
        if (!channel?.send) throw new Error('The scouting channel is unavailable or cannot receive messages.');
        await refreshImageAttachments(this.client, view);
        const files = [];
        for (const [index, image] of (view.attachments || []).filter(imageAttachment).slice(0, 10).entries()) {
            const file = await this.download(image, MAX_UPLOAD_BYTES);
            files.push({ attachment: file.attachment, name: file.name || `scout-${row.message_id}-${index + 1}.png` });
        }
        const credit = `-# Scouted by ${mention(row.author_id) || plain(row.author_username || 'Unknown member')}`;
        const text = String(view.message_content || '').trim();
        // A copy longer than a bot message moves into an embed; the credit always stays visible.
        const fits = text.length + credit.length + 1 <= 2000;
        const sent = await channel.send({ content: fits ? [text, credit].filter(Boolean).join('\n') : credit,
            ...(fits ? {} : { embeds: [new EmbedBuilder().setColor(SERVERS[this.server].color).setDescription(text.slice(0, 4096))] }),
            files, allowedMentions: { parse: [] }, nonce: `sr:${row.message_id}`.slice(-25), enforceNonce: true });
        const attachments = [...(sent.attachments?.values?.() || [])].map(item => ({
            id: String(item.id), name: item.name, url: item.url, proxyURL: item.proxyURL, contentType: item.contentType,
            size: item.size, width: item.width, height: item.height,
            sourceChannelId: String(sent.channelId || this.channelId), sourceMessageId: String(sent.id) }));
        const url = sent.url || `https://discord.com/channels/${this.guildId}/${this.channelId}/${sent.id}`;
        await this.store.markReposted(row.message_id, { id: sent.id, url, attachments });
        return sent;
    }

    async decide(interaction, messageId, action) {
        let warning = null;
        return withScoutLoading(interaction, async () => {
            const keep = action !== 'remove';
            let { changed, context } = await this.store.decide(messageId, interaction.user.id, keep);
            if (changed && keep) await this.regroup();
            if (action === 'repost' && context.deletion.status === 'kept') {
                try {
                    await this.repost(context);
                    context = await this.store.context(messageId);
                } catch (error) {
                    console.warn(`[CC LOG] Could not repost deleted scout ${messageId}: ${error.message}`);
                    warning = '⚠️ The scout report was kept in `/scout`, but it could not be reposted in the scout channel. Use **Repost in scout channel** to try again.';
                }
            } else if (!changed) {
                warning = `This deleted scout report was already ${context.deletion.status}. The message shows the current decision.`;
            }
            this.editors.delete(String(messageId));
            return this.panel(context, interaction.message);
        }, { label: action === 'remove' ? 'Removing…' : action === 'repost' ? 'Reposting…' : 'Keeping…', logContext: 'Deleted scout review',
            errorMessage: error => error.code === 'SCOUT_DELETION_STALE' ? `❌ ${error.message}` : '❌ Could not save this decision. Please try again.',
            onLoaded: () => { if (warning) void interaction.followUp({ content: warning, flags: MessageFlags.Ephemeral }).catch(() => {}); } });
    }

    async page(interaction, messageId, page) {
        return withScoutLoading(interaction, async () => {
            const context = await this.store.context(messageId);
            if (!context) throw Object.assign(new Error('This deleted scout report is no longer recorded.'), { code: 'SCOUT_DELETION_STALE' });
            if (page === 'edit' && context.deletion.status === 'pending') {
                await refreshImageAttachments(this.client, context.view);
                this.editors.delete(String(messageId));
                this.editors.set(String(messageId), context);
                while (this.editors.size > 50) this.editors.delete(this.editors.keys().next().value);
            }
            return this.panel(context, interaction.message, { page });
        }, { label: 'Loading…', logContext: 'Deleted scout review',
            errorMessage: error => error.code === 'SCOUT_DELETION_STALE' ? `❌ ${error.message}` : '❌ Could not load this report. Please try again.' });
    }

    // Opened from the cached edit page, so the modal is shown without a database round trip.
    async openEditor(interaction, messageId, section) {
        const context = this.editors.get(String(messageId));
        if (!context) {
            await interaction.reply({ content: 'This editor expired. Press **Back**, then **Edit** again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const { reportEditFields } = require('./ScoutReportManager.js');
        const source = context.view;
        const modal = new ModalBuilder().setCustomId(`${PREFIX}modal-${section}:${this.server}:${messageId}`)
            .setTitle(section === 'details' ? 'Edit scout details' : section === 'text' ? 'Edit scout message text' : 'Edit scout screenshots');
        modal.addLabelComponents(...(section === 'text'
            ? [scoutTextInput('content', 'Stored message text', source.message_content, true)]
            : reportEditFields(section, source, context.reportRoot?.opponent_ign)));
        await interaction.showModal(modal);
        return true;
    }

    async saveEdit(interaction, messageId, section) {
        const { ScoutReportManager, fullModalText, screenshotAttachments } = require('./ScoutReportManager.js');
        await interaction.deferUpdate();
        const cached = this.editors.get(String(messageId));
        try {
            const source = cached?.view || (await this.store.context(messageId))?.view;
            if (!source) throw Object.assign(new Error('This deleted scout report is no longer recorded.'), { code: 'SCOUT_DELETION_STALE' });
            const get = name => interaction.fields.getTextInputValue(name).trim();
            const patch = {};
            if (section === 'details') {
                patch.details = { ign: get('ign'), rating: get('rating'), teamText: fullModalText(interaction, 'team', source.team_text),
                    notes: fullModalText(interaction, 'notes', source.notes) };
            } else if (section === 'text') {
                patch.overrides = { message_content: fullModalText(interaction, 'content', source.message_content) };
            } else {
                const { attachments, uploads } = screenshotAttachments(interaction, source);
                if (uploads.length) {
                    // Uploaded files are stored through the report editor's staff-channel copy, which keeps them renewable.
                    const manager = new ScoutReportManager(this.store.store, this.server);
                    attachments.push(...await manager.storeUploadedImages(interaction,
                        { reportId: cached?.deletion.report_id || messageId, source: { message_id: String(messageId) } }, uploads));
                }
                patch.overrides = { attachments };
            }
            const context = await this.store.edit(messageId, interaction.user.id, patch);
            await refreshImageAttachments(this.client, context.view);
            this.editors.set(String(messageId), context);
            await interaction.editReply(scoutPayload(this.panel(context, interaction.message, { page: 'edit' }), interaction.message));
            await interaction.followUp({ content: '✅ Saved. The change appears in `/scout` once the report is kept.', flags: MessageFlags.Ephemeral });
        } catch (error) {
            if (error.code !== 'SCOUT_DELETION_STALE') console.warn(`[CC LOG] Could not edit deleted scout ${messageId}: ${error.message}`);
            await interaction.followUp({ content: `❌ Could not save this change: ${plain(error.message, 400)}`, flags: MessageFlags.Ephemeral });
        }
        return true;
    }

    async handleInteraction(interaction, action, messageId) {
        if (interaction.isModalSubmit?.()) {
            const section = action.startsWith('modal-') ? action.slice('modal-'.length) : '';
            return ['details', 'text', 'images'].includes(section) ? this.saveEdit(interaction, messageId, section) : false;
        }
        if (!interaction.isButton?.()) return false;
        if (['keep', 'repost', 'remove'].includes(action)) return this.decide(interaction, messageId, action);
        if (action === 'edit' || action === 'back') return this.page(interaction, messageId, action === 'edit' ? 'edit' : 'main');
        if (['edit-details', 'edit-text', 'edit-images'].includes(action)) return this.openEditor(interaction, messageId, action.slice('edit-'.length));
        return false;
    }
}

// Routes "scout-deleted:<action>:<server>:<messageId>" controls after checking staff access.
async function handleScoutDeletionInteraction(interaction, config) {
    const [prefix, action, server, messageId] = String(interaction.customId || '').split(':');
    if (`${prefix}:` !== PREFIX || !/^\d+(?:_\d+)?$/u.test(messageId || '')) return false;
    const review = config.scoutServers?.get?.(server)?.ingestor?.deletions;
    if (!review) return false;
    const roles = interaction.member?.roles?.cache;
    const staff = config.ownerID && String(interaction.user?.id) === String(config.ownerID)
        || Boolean(roles?.some(role => [config.leaderRoleID, config.adminRoleID, config.officerRoleID]
            .filter(Boolean).map(String).includes(String(role.id))));
    if (!interaction.inGuild?.() || !staff) {
        await interaction.reply({ content: 'Only the guild leader, Admins, or Officers can review deleted scout reports.', flags: MessageFlags.Ephemeral });
        return true;
    }
    return review.handleInteraction(interaction, action, messageId);
}

module.exports = { ACTION_HELP, ScoutDeletionReview, deletionPayload, handleScoutDeletionInteraction };
