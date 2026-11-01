// Posts scout publications, officer actions and bot diagnostics to the staff log.
'use strict';

const path = require('node:path');
const { diffLines } = require('diff');
const { sameValue, scoutIds, scoutIdFooter } = require('./ScoutChanges.js');
const { reviewSuggestions } = require('./ScoutFeedbackText.js');
const { AttachmentBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');

const ACTIONS = {
    edited: ['Scout Report Edited', 0x5865F2], deleted: ['Scout Report Deleted', 0xED4245],
    confirmed: ['Scout Review Approved', 0x57F287], corrected: ['Scout Review Corrected', 0x5865F2],
    not_scout: ['Scout Review Declined', 0xED4245],
    edit_accepted: ['Scout Message Edit Accepted', 0x57F287], edit_rejected: ['Scout Message Edit Declined', 0xED4245],
    attached: ['Scout Source Attached', 0x5865F2], detached: ['Scout Source Made Independent', 0x5865F2],
    source_deleted: ['Scout Source Deleted', 0xED4245], source_edited: ['Scout Source Edited', 0x5865F2],
    reply_added: ['Scout Information Added', 0x57F287]
};
const LABELS = { ign: 'Opponent IGN', rating: 'PvP rating', teamText: 'Pokémon team', notes: 'Additional notes',
    authorId: 'Reporter Discord ID', authorUsername: 'Reporter username', createdAt: 'Scout posted',
    sourceUrl: 'Discord source link', messageContent: 'Stored message text',
    attachments: 'Screenshots', reviewStatus: 'Review status', classification: 'Classification', rootMessageId: 'Scout Report ID' };

function changesBetween(before = {}, after = {}) {
    return Object.fromEntries(Object.keys(LABELS).filter(key => Object.hasOwn(before, key) && Object.hasOwn(after, key) && !sameValue(key, before[key], after[key]))
        .map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}

function display(value, max = 390) {
    if (value === null || value === undefined || value === '') return '*None*';
    const text = Array.isArray(value) ? value.map(item => item.url || item.name || item.id || String(item)).join('\n') : String(value);
    return escapeMarkdown(text.slice(0, max)).slice(0, max) + (text.length > max ? '…' : '');
}

function auditPayload(event, logoPath = path.join(__dirname, '../../images/cc_logo.webp')) {
    const [title, color] = ACTIONS[event.action] || ['Scout Report Updated', 0x5865F2];
    const first = event.sources?.[0] || {};
    const before = first.before || {}, after = first.after || {};
    const ign = after.ign || before.ign || 'Not detected';
    const sourceUrl = after.sourceUrl || before.sourceUrl;
    const embed = new EmbedBuilder().setColor(color).setTitle(title)
        .setDescription(`**Officer:** <@${event.actorId}> (\`${event.actorId}\`)\n**Opponent:** ${display(ign, 64)}\n`
            + scoutIds(event.reportId, event.messageId)
            + (sourceUrl ? `\n[Jump to scout message ↗️](${sourceUrl})` : ''))
        .setFooter({ text: `Crow Control • Message ID: ${event.messageId}`, iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    const sources = event.sources || [];
    const changes = first.changes || changesBetween(before, after);
    const entries = Object.entries(changes).filter(([key, change]) => LABELS[key] && !sameValue(key, change.before, change.after));
    for (const [key, change] of entries.slice(0, 5)) embed.addFields({ name: LABELS[key],
        value: ['messageContent', 'teamText', 'notes'].includes(key) ? diffPreview(scoutTextDiff(change.before || '', change.after || ''))
            : `**Before:** ${display(change.before)}\n**${event.action === 'edit_rejected' ? 'Proposed' : 'After'}:** ${display(change.after)}`, inline: false });
    if (event.action === 'deleted') embed.addFields({ name: 'Deleted report',
        value: `${sources.length} source(s) removed from \`/scout\`. The original Discord messages remain available.`, inline: false });
    if (sources.length > 1) embed.addFields({ name: 'Affected source IDs',
        value: sources.map(source => `\`${source.messageId}\``).join(', ').slice(0, 1024), inline: false });
    if ((!entries.length || event.action === 'edit_rejected') && event.action !== 'deleted') embed.addFields({ name: 'Decision',
        value: event.action === 'edit_rejected' ? 'The proposed changes were declined; the published report stays unchanged.'
            : 'The officer saved this review decision.', inline: false });
    const files = [new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' })];
    // Preserve every before/after value, even when Discord's embed limits require shortened previews.
    if (entries.length || event.action === 'deleted') files.push(new AttachmentBuilder(Buffer.from(JSON.stringify(event, null, 2)),
        { name: `scout-${event.messageId}-changes.json` }));
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
}

function publishedPayload(event, logoPath = path.join(__dirname, '../../images/cc_logo.webp')) {
    const contributors = [...new Map((event.sources || []).map(source => [source.author_id,
        source.author_id ? `<@${source.author_id}>` : display(source.author_username || 'Unknown member', 80)])).values()];
    const embed = new EmbedBuilder().setColor(0x57F287).setTitle('✅ Scout Report Published')
        .setDescription(`The Scout Report for **${escapeMarkdown(event.ign)}** has been successfully validated and added to \`/scout\`.\n\n`
            + `**Scouted by:** ${contributors.slice(0, 20).join(', ') || '*Unknown member*'}`
            + (contributors.length > 20 ? ` and ${contributors.length - 20} more` : '') + '\n'
            + scoutIds(event.reportId, event.messageId)
            + (event.sourceUrl ? `\n[**Jump to scout message ↗️**](${event.sourceUrl})` : ''))
        .setFooter({ text: scoutIdFooter(event.reportId, event.messageId), iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (event.rating != null) embed.addFields({ name: 'PvP Rating', value: String(event.rating), inline: true });
    embed.addFields({ name: 'Source messages', value: String(event.sources?.length || 1), inline: true });
    return { embeds: [embed], files: [new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' })],
        allowedMentions: { parse: [] }, nonce: `sp:${event.messageId}`, enforceNonce: true };
}

function scoutTextDiff(before = '', after = '') {
    return diffLines(String(before), String(after)).filter(part => part.added || part.removed)
        .map(part => part.value.replace(/\n$/u, '').split('\n')
            .map(line => `${part.removed ? '-' : '+'} ${line}`).join('\n')).join('\n');
}

function diffPreview(diff) {
    const safe = diff.replace(/`/gu, 'ˋ');
    return `\`\`\`diff\n${safe.slice(0, 940)}\n\`\`\`` + (safe.length > 940 ? '\nFull changes attached.' : '');
}

function memberEditPayload(event, logoPath = path.join(__dirname, '../../images/cc_logo.webp')) {
    const before = event.before || {}, after = event.after || {};
    const ignored = ['ignored', 'not_scout'].includes(after.classification) || after.reviewStatus === 'not_scout';
    const failed = Boolean(event.failed) || after.reviewStatus === 'pending';
    const status = failed ? '❌ Failed validation' : ignored ? 'Not a scout report'
        : event.awaitingApproval ? '⏳ Parsed successfully • awaiting officer approval' : event.autoApproved ? '✅ Automatically approved • updated and published' : '✅ Successfully validated';
    const color = failed ? 0xED4245 : ignored ? 0x95A5A6 : event.awaitingApproval ? 0xFEE75C : 0x57F287;
    const diff = scoutTextDiff(before.content, after.content);
    const attachmentNames = value => (value.attachments || []).map(a => `${a.id}: ${a.name || 'image'}`);
    const attachmentsChanged = !sameValue('attachments', before.attachments, after.attachments);
    const confidence = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'Unavailable';
    const embed = new EmbedBuilder().setTitle('Scout Message Edited').setColor(color)
        .setDescription(`**Reporter:** ${display(event.authorUsername || after.authorUsername || 'Unknown', 128)}`
            + (event.authorId ? ` (\`${event.authorId}\`)` : '')
            + `\n**Server:** ${event.server === 'silver' ? 'Silver' : 'Gold'}\n**Status:** ${status}`
            + '\n' + scoutIds(event.reportId, event.messageId)
            + (event.sourceUrl ? `\n[Jump to scout message ↗️](${event.sourceUrl})` : ''))
        .setFooter({ text: scoutIdFooter(event.reportId, event.messageId), iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (diff) embed.addFields({ name: 'Message changes', value: diffPreview(diff), inline: false });
    for (const [key, name, format] of [['ign', 'Opponent IGN', v => display(v, 64)],
        ['ignConfidence', 'IGN confidence', confidence], ['ignSource', 'IGN detection source', v => display(v, 100)]]) {
        if (!sameValue(key, before[key], after[key]) && format(before[key]) !== format(after[key]))
            embed.addFields({ name, value: `${format(before[key])} → ${format(after[key])}`, inline: true });
    }
    if (event.safetyReason) embed.addFields({ name: 'Review safeguard', value: display(event.safetyReason, 850), inline: false });
    embed.addFields({ name: 'Validation reason', value: display(after.reviewReason || (failed
        ? 'The opponent or team could not be verified confidently.'
        : ignored ? 'This message is not recognized as a scout report.' : 'Validation passed.'), 850), inline: false });
    const suggestions = failed || event.awaitingApproval ? reviewSuggestions({ reason: after.reviewReason,
        edit: event.awaitingApproval ? { after } : null }) : [];
    embed.addFields({ name: 'Bot suggestions', value: suggestions.length
        ? suggestions.map(suggestion => `- ${suggestion}`).join('\n').slice(0, 1024)
        : ignored ? 'Submit an opponent IGN and Pokémon team details or a screenshot.' : 'No corrections needed.', inline: false });
    if (!sameValue('rating', before.rating, after.rating)) embed.addFields({ name: 'PvP rating', value: `${display(before.rating)} → ${display(after.rating)}`, inline: true });
    if (attachmentsChanged) embed.addFields({ name: 'Attachments', value: `Before: ${display(attachmentNames(before), 350)}\nAfter: ${display(attachmentNames(after), 350)}`, inline: false });
    const files = [new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' }),
        new AttachmentBuilder(Buffer.from(JSON.stringify(event, null, 2)), { name: `scout-edit-${event.messageId}.json` })];
    if (diff.length > 940) files.push(new AttachmentBuilder(Buffer.from(diff), { name: `scout-edit-${event.messageId}.diff.txt` }));
    return { embeds: [embed], files, allowedMentions: { parse: [] } };
}

function diagnosticPayload(event, ownerId, logoPath = path.join(__dirname, '../../images/cc_logo.webp')) {
    const warning = event.level === 'warn';
    const reportId = String(event.reportId || '').trim();
    const footer = reportId && reportId !== 'N/A' ? scoutIdFooter(reportId, event.messageId)
        : `CC • ${event.component || 'Bot runtime'}`;
    const embed = new EmbedBuilder().setColor(warning ? 0xFEE75C : 0xED4245)
        .setTitle(warning ? '⚠️ Bot Warning' : '❌ Bot Error')
        .setDescription(event.message.slice(0, 3500) || 'No error details were available.')
        .setFooter({ text: footer.slice(0, 256), iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (event.component) embed.addFields({ name: 'Component', value: escapeMarkdown(event.component).slice(0, 256), inline: true });
    if (event.code) embed.addFields({ name: 'Error code', value: escapeMarkdown(String(event.code)).slice(0, 128), inline: true });
    if (event.messageId) embed.addFields({ name: 'Scout Message ID', value: `\`${event.messageId}\``, inline: true });
    if (event.repeats) embed.addFields({ name: 'Repeated occurrences', value: `${event.repeats} matching alert(s) were suppressed since the previous notification.`, inline: false });
    return { content: ownerId ? `<@${ownerId}>` : undefined, embeds: [embed],
        files: [new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' })],
        ...(event.nonce ? { nonce: event.nonce, enforceNonce: true } : {}),
        allowedMentions: { parse: [], users: ownerId ? [String(ownerId)] : [] } };
}

function recoveryPayload(event, logoPath = path.join(__dirname, '../../images/cc_logo.webp')) {
    const embed = new EmbedBuilder().setColor(0x57F287).setTitle('✅ Service Restored')
        .setDescription(event.message.slice(0, 3500) || 'The service is responding again.')
        .setFooter({ text: `CC • ${event.component || 'Bot runtime'}`.slice(0, 256), iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());
    if (event.component) embed.addFields({ name: 'Component', value: escapeMarkdown(event.component).slice(0, 256), inline: true });
    if (Number.isFinite(event.durationMs)) {
        const seconds = Math.max(0, Math.floor(event.durationMs / 1000));
        embed.addFields({ name: 'Outage duration', value: `${Math.floor(seconds / 60)}m ${seconds % 60}s`, inline: true });
    }
    return { embeds: [embed], files: [new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' })],
        ...(event.nonce ? { nonce: event.nonce, enforceNonce: true } : {}),
        allowedMentions: { parse: [], repliedUser: false } };
}

class ScoutAuditLogger {
    constructor({ client, guildId, channelId, ownerId, logoPath } = {}) {
        this.client = client; this.guildId = String(guildId || ''); this.channelId = String(channelId || '');
        this.logoPath = logoPath; this.pending = Promise.resolve();
        this.ownerId = String(ownerId || '');
    }

    published(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        this.queuePayload(() => publishedPayload(saved, this.logoPath), `scout publication log for ${saved.messageId}`);
    }

    memberEdited(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        this.queuePayload(() => memberEditPayload(saved, this.logoPath), `scout member edit log for ${saved.messageId}`);
    }

    diagnostic(event) {
        if (!this.channelId) return;
        const saved = structuredClone(event);
        if (saved.status === 'recovered') {
            return this.queuePayload(() => recoveryPayload(saved, this.logoPath), 'bot recovery log', saved.replyTo);
        }
        return this.queuePayload(() => diagnosticPayload(saved, this.ownerId, this.logoPath), 'bot diagnostic log');
    }

    queuePayload(build, label, replyTo) {
        const queued = this.pending.then(async () => {
            const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
            if (!channel?.send || channel.guildId !== this.guildId) throw new Error('Scout log channel is unavailable in this server.');
            const payload = build();
            if (replyTo) payload.reply = { messageReference: String(replyTo), failIfNotExists: false };
            return channel.send(payload);
        });
        const result = queued.catch(error => {
            console.warn(`[CC LOG] Could not send ${label}: ${error.message}`);
            return null;
        });
        // The send result is useful to callers, but the idle queue must not retain a Discord Message.
        this.pending = result.then(() => undefined);
        return result;
    }

    enqueue(event) {
        if (!this.channelId) return;
        const saved = structuredClone({ ...event, timestamp: new Date().toISOString() });
        // Only new committed user actions enter this queue. Startup never replays old review history.
        this.pending = this.pending.then(async () => {
            const channel = this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
            if (!channel?.send || channel.guildId !== this.guildId) throw new Error('Scout log channel is unavailable in this server.');
            await channel.send(auditPayload(saved, this.logoPath));
        }).catch(error => console.warn(`[CC LOG] Could not send scout action log for ${saved.messageId}: ${error.message}. The saved change history is intact.`));
    }

    flush() { return this.pending; }
}

module.exports = { ScoutAuditLogger, auditPayload, changesBetween, diagnosticPayload, recoveryPayload, publishedPayload, memberEditPayload, scoutTextDiff };
