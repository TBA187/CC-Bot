// Log invite creation and deletion with the available audit details.
const path = require('node:path');
const { AttachmentBuilder, AuditLogEvent, EmbedBuilder, InviteTargetType, escapeMarkdown } = require('discord.js');
const { findModerationAuditEntry } = require('./memberExit.js');
const { auditActor, inlineCode } = require('../utils/memberAuditEmbeds.js');
const { sleep } = require('../utils/logHelpers.js');

const LOGO_PATH = path.join(__dirname, '../images/cc_logo.webp');
const LOGO_FILENAME = 'cc_logo.webp';
const INVITE_BLUE = 0x5865F2;

function discordTime(timestamp) {
    if (timestamp == null) return 'Unknown';
    const seconds = Math.floor(new Date(timestamp).getTime() / 1000);
    if (!Number.isFinite(seconds)) return 'Unknown';
    return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}

function streamTargetLines(invite) {
    if (invite.targetType !== InviteTargetType.Stream && !invite.targetUser) return [];

    const lines = ['- **Invite Target:** Stream'];
    if (invite.targetUser) lines.push(`- **Stream Host:** ${auditActor(invite.targetUser)}`);
    return lines;
}

function buildInviteCreatedPayload(invite) {
    const inviter = invite.inviter;
    const inviterId = inviter?.id ?? invite.inviterId;
    const inviterLabel = inviterId ? `<@${inviterId}>` : inviter?.username ? `@${escapeMarkdown(inviter.username)}` : '*Unknown User*';
    const channelId = invite.channel?.id ?? invite.channelId;
    const channel = channelId ? `<#${channelId}>` : '*Unknown Channel*';
    const url = invite.url || (invite.code ? `https://discord.gg/${invite.code}` : '*Unavailable*');
    const maxUses = invite.maxUses == null ? 'Unknown' : invite.maxUses > 0 ? String(invite.maxUses) : 'Unlimited';
    const temporary = invite.temporary == null ? 'Unknown' : invite.temporary ? 'Yes' : 'No';
    const expiry = invite.expiresAt == null && invite.maxAge === 0 ? 'Never' : discordTime(invite.expiresAt);
    const inviteId = invite.code || invite.id;
    const description = [
        `**${inviterLabel} created an invite link for Crow Control's Discord Server.**`,
        `- **Invite Channel:** ${channel}`,
        `- **Invite Link:** ${url}`,
        `- **Invite Expires:** ${expiry}`,
        `- **Temporary Membership:** ${temporary}`,
        `- **Max Uses:** ${maxUses}`,
        ...streamTargetLines(invite)
    ].join('\n');

    const embed = new EmbedBuilder()
        .setTitle('Server Invite Created 🔗')
        .setColor(INVITE_BLUE)
        .setDescription(description)
        .setTimestamp();

    if (inviteId) {
        embed.setFooter({ text: `Invite Link ID: ${inviteId}`, iconURL: 'attachment://cc_logo.webp' });
    } else {
        embed.setFooter({ text: 'Invite Link ID: unavailable', iconURL: 'attachment://cc_logo.webp' });
    }

    return {
        embeds: [embed],
        files: [new AttachmentBuilder(LOGO_PATH, { name: LOGO_FILENAME })]
    };
}

async function handleInviteCreate(invite, config) {
    try {
        if (!invite.guild || !config.logChannelID || (config.guildId && invite.guild.id !== config.guildId)) return;
        const channel = invite.guild.channels.cache.get(config.logChannelID)
            || await invite.guild.channels.fetch(config.logChannelID).catch(() => null);
        if (!channel?.isTextBased()) return;
        await channel.send(buildInviteCreatedPayload(invite));
    } catch (error) {
        console.error('Invite creation log failed:', error);
    }
}

function inviteAuditMatchesCode(entry, code) {
    return entry.target?.code === code || entry.targetId === code ||
        entry.changes?.some(change => change.key === 'code' && (change.old === code || change.new === code));
}

function buildInviteDeletedPayload(invite, auditEntry) {
    const code = invite.code || invite.id;
    const channelId = invite.channel?.id ?? invite.channelId;
    const actor = auditEntry?.executor;
    const lines = [
        actor ? `**${auditActor(actor)} deleted an invite link for Crow Control's Discord Server.**`
            : `**An invite link for Crow Control's Discord Server was deleted.**`,
        `- **Invite Channel:** ${channelId ? `<#${channelId}>` : '*Unknown Channel*'}`,
        `- **Invite Code:** ${inlineCode(code ?? 'Unavailable')}`,
        `- **Deleted Invite Link:** ${code ? `https://discord.gg/${code}` : '*Unavailable*'}`
    ];
    if (!actor) lines.push('- **Deleted By:** *Unavailable — no matching moderator audit details.*');
    if (auditEntry?.reason) lines.push(`- **Reason:** ${escapeMarkdown(auditEntry.reason)}`);
    const embed = new EmbedBuilder().setTitle('Server Invite Deleted 🗑️').setColor(0xE67E22)
        .setDescription(lines.join('\n')).setFooter({ text: `Invite Link ID: ${code ?? 'unavailable'}`, iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp();
    return { embeds: [embed], files: [new AttachmentBuilder(LOGO_PATH, { name: LOGO_FILENAME })], allowedMentions: { parse: [] } };
}

async function handleInviteDelete(invite, config) {
    const eventTime = Date.now();
    try {
        const guild = invite.guild ?? config.client?.guilds.cache.get(invite.guildId);
        if (!guild || !config.logChannelID || (config.guildId && guild.id !== config.guildId)) return;
        const channel = guild.channels.cache.get(config.logChannelID) || await guild.channels.fetch(config.logChannelID);
        if (!channel?.isTextBased()) return;
        const code = invite.code || invite.id;
        await sleep(1200);
        const auditEntry = code ? await findModerationAuditEntry(guild, AuditLogEvent.InviteDelete, code, {
            eventTime, targetMatches: entry => inviteAuditMatchesCode(entry, code)
        }) : null;
        await channel.send(buildInviteDeletedPayload(invite, auditEntry));
    } catch (error) { console.error('Invite deletion log failed:', error); }
}

module.exports = {
    register(client, config) {
        client.on('inviteCreate', invite => handleInviteCreate(invite, config));
        client.on('inviteDelete', invite => handleInviteDelete(invite, config));
    },
    handleInviteDelete, buildInviteCreatedPayload, buildInviteDeletedPayload
};
