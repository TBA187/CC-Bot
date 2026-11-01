// Inspect Discord profile details and current server membership.
'use strict';

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { buildMemberAuditPayload, formatDiscordTime } = require('../utils/memberAuditEmbeds.js');
const { hasAllowedRole, currentMember } = require('../features/message-builder/permissions.js');
const { serverTagStatus } = require('../utils/serverTagRoleManager.js');

function roleSummary(member) {
    const roles = [...member.roles.cache.values()].filter(role => role.id !== member.guild.id)
        .sort((a, b) => b.position - a.position);
    if (!roles.length) return 'None';
    let result = '';
    for (let index = 0; index < roles.length; index++) {
        const mention = `<@&${roles[index].id}>`;
        const remainder = `\n+ ${roles.length - index} more`;
        if (result.length + mention.length + 2 + remainder.length > 1024) return result + remainder;
        result += (result ? ', ' : '') + mention;
    }
    return result;
}

function keyPermissions(member) {
    if (member.id === member.guild.ownerId) return 'Server owner';
    if (!member.permissions?.has) return 'Unavailable';
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return 'Administrator (all permissions)';
    const permissions = [
        ['ManageGuild', 'Manage Server'], ['ManageRoles', 'Manage Roles'], ['ManageChannels', 'Manage Channels'],
        ['BanMembers', 'Ban Members'], ['KickMembers', 'Kick Members'], ['ModerateMembers', 'Timeout Members'],
        ['ManageMessages', 'Manage Messages'], ['ViewAuditLog', 'View Audit Log'],
        ['MoveMembers', 'Move Members'], ['MuteMembers', 'Mute Members'], ['DeafenMembers', 'Deafen Members']
    ].filter(([flag]) => member.permissions.has(PermissionFlagsBits[flag])).map(([, label]) => label);
    return permissions.join(', ') || 'No listed moderation permissions';
}

function buildInspectPayload(member, now = Date.now()) {
    const voice = member.voice;
    const tag = serverTagStatus(member.user, member.guild.id);
    const boolean = value => value === true ? 'Yes' : value === false ? 'No' : 'Unavailable';
    const plainName = value => escapeMarkdown(String(value || 'Not set'));
    const timeout = member.communicationDisabledUntilTimestamp;
    const payload = buildMemberAuditPayload({ authorName: 'Member Inspection', member, showUserDetails: false,
        actionHeading: `<@${member.id}>`, color: 0x452366,
    });
    const avatar = member.user.displayAvatarURL?.({ size: 256 }) ?? member.displayAvatarURL?.({ size: 256 });
    if (avatar) payload.embeds[0].setThumbnail(avatar);
    const roles = [...member.roles.cache.values()].filter(role => role.id !== member.guild.id);
    payload.embeds[0].setDescription(`<@${member.id}> — **Account type:** \`${member.user.bot ? 'Bot' : 'User'}\``).addFields(
        { name: 'Username', value: plainName(member.user.username), inline: true },
        { name: 'Display Name', value: plainName(member.user.globalName), inline: true },
        { name: 'Server Nickname', value: plainName(member.nickname), inline: true },
        { name: 'Account Created', value: formatDiscordTime(member.user.createdTimestamp), inline: false },
        { name: 'Joined Server', value: formatDiscordTime(member.joinedTimestamp), inline: false },
        { name: `Server Tag: ${boolean(tag)}`, inline: false,
            value: `**Server Boost:** ${member.premiumSinceTimestamp ? `Since ${formatDiscordTime(member.premiumSinceTimestamp, true, 'd')}` : 'Not boosting'}` },
        { name: 'Screening Pending', value: boolean(member.pending), inline: true },
        { name: 'Timeout', value: timeout > now ? `Until ${formatDiscordTime(timeout, true, 'd')}` : 'None', inline: true }
    );
    payload.embeds[0].addFields({ name: 'Voice Activity', inline: false,
        value: voice?.channelId ? `<#${voice.channelId}>\n` +
            `**Muted:** ${boolean(voice.mute)} · **Deafened:** ${boolean(voice.deaf)}\n` +
            `**Streaming:** ${boolean(voice.streaming)} · **Camera:** ${boolean(voice.selfVideo)}` : 'Not connected' });
    payload.embeds[0].addFields(
        { name: `Server Roles (${roles.length})`, value: roleSummary(member), inline: false },
        { name: 'Key Server Permissions', value: keyPermissions(member), inline: false }
    );
    return payload;
}

class Inspect {
    constructor(config = {}) {
        this.name = 'inspect';
        this.guildId = config.guildId;
        this.allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean);
        this.onCooldown = config.onCooldown;
        this.data = new SlashCommandBuilder()
            .setName(this.name)
            .setDescription('Inspect a member\'s Discord profile, roles and server status.')
            .setDMPermission(false)
            .addUserOption(o =>
                o.setName('user')
                    .setDescription('Select user')
                    .setRequired(true)
            );
    }

    async execute(interaction) {
        if (!interaction.guild || (this.guildId && interaction.guild.id !== this.guildId)) {
            return interaction.reply({ content: 'Use this command in the configured server.', flags: MessageFlags.Ephemeral });
        }
        if (!hasAllowedRole(currentMember(interaction), this.allowedRoles)) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }
        if (this.onCooldown?.(interaction.user.id, this.name, 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }
        const selected = interaction.options.getMember('user');
        if (!selected) return interaction.reply({ content: '❌ This user is not a member of the server.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const member = await interaction.guild.members.fetch({ user: selected.id, force: true });
            await interaction.editReply(buildInspectPayload(member));
        } catch (error) {
            console.error('[CC LOG] Could not inspect member:', error);
            await interaction.editReply({ content: Number(error.code) === 10007 ? 'This user is no longer a member of the server.'
                : 'Could not load this member\'s details. Please try again.', embeds: [] });
        }
    }
}

Inspect.buildInspectPayload = buildInspectPayload;
module.exports = Inspect;
