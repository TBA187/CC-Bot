// Shares PvP permissions, channel checks and cached King-role validation.
const { MessageFlags } = require('discord.js');
const { fetchGuildMemberRoster } = require('../../../utils/guildMemberRoster.js');

const MEMBER_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const memberRefreshCache = new WeakMap();

function formatNowMinute(date = new Date()) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
}

function getLogChannel(guild, logChannelID) {
    const logChannel = guild?.channels?.cache?.get(logChannelID);
    if (!logChannel) {
        console.log(' - WARNING: Log channel not found! Channel ID: ' + logChannelID);
    }

    return logChannel;
}

function memberHasAnyRole(member, roleIds) {
    return member?.roles?.cache?.some(role => roleIds.includes(role.id)) ?? false;
}

async function stopIfOnCooldown(interaction, onCooldown, commandKey, seconds, message = '### ⏳ Slow down!') {
    if (!onCooldown(interaction.user.id, commandKey, seconds)) return false;

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
    } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
    return true;
}

async function requireAnyRole(interaction, roleIds, message = '### ❌  No permission!') {
    if (memberHasAnyRole(interaction.member, roleIds)) return true;

    await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral
    });
    return false;
}

async function requirePvpChannel(interaction, channelId, commandName) {
    const channelIds = (Array.isArray(channelId) ? channelId : [channelId]).filter(Boolean);
    if (channelIds.includes(interaction.channelId)) return true;

    const channels = channelIds.map(id => `<#${id}>`).join(' or ');
    const content = `### ❌  The \`/${commandName}\` command can only be used in ${channels}`;
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
    } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return false;
}

async function replyMissingMemberOption(interaction, optionName = 'user', message = '### ❌  User not found.') {
    const member = interaction.options.getMember(optionName);
    if (member) return member;

    await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral
    });
    return null;
}

async function refreshGuildMembers(guild, contextLabel) {
    const lastRefresh = memberRefreshCache.get(guild) ?? 0;
    if (Date.now() - lastRefresh < MEMBER_REFRESH_COOLDOWN_MS) {
        return false;
    }

    try {
        await fetchGuildMemberRoster(guild);
    } catch (err) {
        console.error(`[CC LOG] Failed to refresh members for ${contextLabel}:`, err.code || err.message);
        return false;
    }
    memberRefreshCache.set(guild, Date.now());
    return true;
}

function getPvpKingRole(guild, pvpKingRoleID) {
    return guild?.roles?.cache?.get(pvpKingRoleID) ?? null;
}

// Shared by commands that require exactly one current king; each caller keeps its own wording.
async function getSinglePvpKing(options) {
    const {
        guild,
        pvpKingRoleID,
        logChannel,
        ownerID,
        now = formatNowMinute(),
        contextLabel,
        missingRoleLog,
        missingRoleReply,
        noKingLog,
        noKingReply,
        multipleKingsLog,
        multipleKingsReply
    } = options;

    const kingRole = getPvpKingRole(guild, pvpKingRoleID);
    if (!kingRole) {
        if (logChannel) {
            await logChannel.send(
                missingRoleLog ??
                `### 🚨 <@${ownerID}> — PvP King role missing! (${now})`
            );
        }

        return {
            ok: false,
            reason: 'missing_role',
            reply: missingRoleReply ?? '### ❌ PvP King role not found! Officers have been notified.'
        };
    }

    let kings = kingRole.members;
    if (kings.size === 0 && contextLabel) {
        await refreshGuildMembers(guild, contextLabel);
        kings = kingRole.members;
    }

    if (kings.size === 0) {
        if (logChannel) {
            await logChannel.send(
                typeof noKingLog === 'function'
                    ? noKingLog(kings)
                    : (noKingLog ?? `### 🚨 <@${ownerID}> — No PvP King found! (${now})`)
            );
        }

        return {
            ok: false,
            reason: 'no_king',
            kingRole,
            kings,
            reply: typeof noKingReply === 'function' ? noKingReply(kings) : noKingReply
        };
    }

    if (kings.size > 1) {
        if (logChannel) {
            await logChannel.send(
                typeof multipleKingsLog === 'function'
                    ? multipleKingsLog(kings)
                    : (multipleKingsLog ?? `### 🚨 <@${ownerID}> — Multiple PvP Kings detected: ${kings.size} — (${now})`)
            );
        }

        return {
            ok: false,
            reason: 'multiple_kings',
            kingRole,
            kings,
            reply: typeof multipleKingsReply === 'function' ? multipleKingsReply(kings) : multipleKingsReply
        };
    }

    return {
        ok: true,
        kingRole,
        kings,
        currentKing: kings.first()
    };
}

async function resolveSinglePvpKing(interaction, options) {
    const logChannel = getLogChannel(interaction.guild, options.logChannelID);
    const kingCheck = await getSinglePvpKing({
        guild: interaction.guild,
        pvpKingRoleID: options.pvpKingRoleID,
        logChannel,
        ownerID: options.ownerID,
        now: options.now ?? formatNowMinute(),
        contextLabel: options.contextLabel,
        missingRoleLog: options.missingRoleLog,
        missingRoleReply: options.missingRoleReply,
        noKingLog: options.noKingLog,
        noKingReply: options.noKingReply,
        multipleKingsLog: options.multipleKingsLog,
        multipleKingsReply: options.multipleKingsReply
    });

    if (!kingCheck.ok && kingCheck.reply) {
        await interaction.editReply({ content: kingCheck.reply });
    }

    return { ...kingCheck, logChannel };
}

module.exports = {
    formatNowMinute,
    getLogChannel,
    memberHasAnyRole,
    stopIfOnCooldown,
    requireAnyRole,
    requirePvpChannel,
    replyMissingMemberOption,
    refreshGuildMembers,
    resolveSinglePvpKing
};
