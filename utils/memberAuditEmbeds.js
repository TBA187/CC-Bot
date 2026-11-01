// Build consistent member audit messages with safe names and Discord timestamps.
'use strict';

const path = require('node:path');
const { AttachmentBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');

function inlineCode(value) {
    return `\`${String(value ?? 'Unknown').replace(/`/gu, 'ˋ').replace(/[\r\n]+/gu, ' ')}\``;
}

function userDetail(value) {
    return `-# ${String(value ?? 'Unknown').replace(/`/gu, 'ˋ').replace(/[\r\n]+/gu, ' ')}`;
}

function auditActor(user) {
    if (!user) return '*Unknown Moderator*';
    if (user.id) return `<@${user.id}>`;
    const name = user.displayName || user.globalName || user.username;
    return name ? `@${escapeMarkdown(name)}` : '*Unknown Moderator*';
}

function formatDiscordTime(timestampMs, relative = true, style = 'F') {
    if (!Number.isFinite(timestampMs)) return 'Unknown';
    const timestamp = Math.floor(timestampMs / 1000);
    return `<t:${timestamp}:${style}>${relative ? ` (<t:${timestamp}:R>)` : ''}`;
}

function memberAvatarURL(member) {
    return member.displayAvatarURL?.({ size: 128 }) ?? member.user?.displayAvatarURL?.({ size: 128 }) ?? undefined;
}

function buildMemberAuditPayload({ authorName, member, actionText, actionHeading, afterActionLines = [], color = 0x95A5A6,
    reason, timingLines = [], extraLines = [], detailFields = [], warningFields = [], showUserDetails = true, memberCount }) {
    const user = member.user ?? {};
    const lines = [`**${actionHeading ?? `<@${member.id}> ${actionText}`}**`, ...afterActionLines];
    if (reason !== undefined) lines.push(`- **Reason:** ${reason ? escapeMarkdown(reason) : '*No reason provided!*'}`);
    lines.push(...timingLines, ...extraLines);
    if (memberCount !== undefined && memberCount !== null) lines.push(`- **Discord Member Count:** \`${memberCount}\``);
    const fields = [];
    if (showUserDetails) {
        fields.push(
            { name: 'Username', value: userDetail(user.username ?? user.tag ?? 'Unknown User') },
            { name: 'Global Display Name', value: userDetail(user.globalName ?? 'No Global Display Name') },
            { name: 'CC Server Nickname', value: userDetail(member.nickname ?? 'No Server Nickname') },
            ...detailFields
        );
    }
    const embed = new EmbedBuilder().setAuthor({ name: authorName, iconURL: memberAvatarURL(member) })
        .setColor(color).setDescription(lines.join('\n'))
        .setFooter({ text: `User ID: ${member.id}`, iconURL: 'attachment://cc_logo.webp' }).setTimestamp();
    if (fields.length) embed.addFields(fields.map(field => ({ ...field, inline: true })));
    if (warningFields.length) embed.addFields(warningFields.map(field => ({ ...field, inline: false })));
    return { embeds: [embed], files: [new AttachmentBuilder(path.join(__dirname, '../images/cc_logo.webp'), { name: 'cc_logo.webp' })],
        allowedMentions: { parse: [] } };
}

module.exports = { buildMemberAuditPayload, inlineCode, auditActor, formatDiscordTime };
