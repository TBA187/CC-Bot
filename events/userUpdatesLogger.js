// Log profile and guild-member changes and maintain the profile lookup cache.

const path = require('node:path');
const { AttachmentBuilder, AuditLogEvent, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { syncMemberColorRoleName } = require('./auto_roles.js');
const { findModerationAuditEntry } = require('./memberExit.js');

const RECENT_NAME_LOG_TTL_MS = 30 * 1000;
const recentNameLogs = new Map();
const knownUserProfiles = new Map();

async function getLogChannel(config, guild = null) {
    const targetGuild = guild || config.client?.guilds.cache.get(config.guildId);
    if (!targetGuild || !config.logChannelID) return null;
    return targetGuild.channels.cache.get(config.logChannelID) || targetGuild.channels.fetch(config.logChannelID);
}

function normalizeNickname(value) {
    return value || null;
}

function userProfile(user) {
    return {
        id: user.id,
        username: user.username ?? null,
        globalName: user.globalName ?? null
    };
}

function rememberUserProfile(user) {
    if (!user?.id) return;
    knownUserProfiles.set(user.id, userProfile(user));
}

function formatNickname(value) {
    return value ? escapeMarkdown(value) : '*No server nickname*';
}

function formatDiscordDisplayName(value) {
    return value ? escapeMarkdown(value) : '-# *No Discord Display Name!*';
}

function boldValue(value) {
    return `**${escapeMarkdown(value)}**`;
}

function getChangeAction(oldValue, newValue) {
    if (!oldValue && newValue) return 'Added';
    if (oldValue && !newValue) return 'Removed';
    return 'Changed';
}

function actionEmoji(action) {
    if (action === 'Added') return '✅';
    if (action === 'Removed') return '❌';
    return '📝';
}

function actionVerb(action) {
    if (action === 'Added') return 'added';
    if (action === 'Removed') return 'removed';
    return 'changed';
}

function changeTitle(label, oldValue, newValue, forcedAction = null) {
    const action = forcedAction || getChangeAction(oldValue, newValue);
    return `${actionEmoji(action)}\u2002${label} ${action}`;
}

function nameChangeDescription(user, label, oldValue, newValue, forcedAction = null) {
    const action = forcedAction || getChangeAction(oldValue, newValue);
    const article = action === 'Added' ? 'a' : 'their';
    return `<@${user.id}> ${actionVerb(action)} ${article} **${label}**`;
}

function serverNicknameDescription(executor, member, isModeratorAction, oldValue, newValue) {
    const action = getChangeAction(oldValue, newValue);
    const article = action === 'Added' ? 'a' : isModeratorAction ? 'the' : 'their';

    if (!executor) {
        return `<@${member.id}> had their **Server Nickname** ${actionVerb(action)} by *Unknown User*`;
    }

    if (isModeratorAction) {
        return `<@${executor.id}> ${actionVerb(action)} ${article} **Server Nickname** for <@${member.id}>`;
    }

    return `<@${member.id}> ${actionVerb(action)} ${article} **Server Nickname**`;
}

function serverNicknameFallbackText() {
    return '-# *No server nickname!*';
}

function newServerNicknameFallbackText(user) {
    if (user.globalName) {
        return `-# *No server nickname!*\n-# Using Discord Display Name: **${escapeMarkdown(user.globalName)}**`;
    }

    return `-# *No server nickname!*\n-# Using Discord Username: **@${escapeMarkdown(user.username)}**`;
}

function auditChangeValue(change, key) {
    return change?.[key] ?? change?.[`${key}_value`] ?? null;
}

function createLogoFile() {
    return new AttachmentBuilder(path.join(__dirname, '../images/cc_logo.webp'), { name: 'cc_logo.webp' });
}

function authorName(user) {
    const displayName = user.displayName || user.username;
    return displayName === user.username ? user.username : `${displayName} (${user.username})`;
}

function reserveNameLog(channelId, userId, label, oldValue, newValue, action) {
    const now = Date.now();
    const key = `${channelId}:${userId}:${label}`;
    const signature = JSON.stringify([oldValue, newValue, action]);
    const previous = recentNameLogs.get(key);

    for (const [entryKey, entry] of recentNameLogs) {
        if (now - entry.loggedAt > RECENT_NAME_LOG_TTL_MS) {
            recentNameLogs.delete(entryKey);
        }
    }

    if (previous?.signature === signature && now - previous.loggedAt < RECENT_NAME_LOG_TTL_MS) {
        return null;
    }

    const entry = { signature, loggedAt: now };
    recentNameLogs.set(key, entry);
    return { key, entry };
}

async function sendAvatarLog(logChannel, user, avatarUrl, title) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const logoFile = createLogoFile();
    const embed = new EmbedBuilder()
        .setAuthor({
            name: authorName(user),
            iconURL: avatarUrl
        })
        .setTitle(title)
        .setColor(0x5865f2)
        .setDescription(`<@${user.id}> changed their avatar!`)
        .setThumbnail(avatarUrl)
        .setFooter({ text: `ID: ${user.id}`, iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp();

    await logChannel.send({ embeds: [embed], files: [logoFile] });
}

async function sendNameChangeLog(logChannel, options) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const {
        user,
        label,
        description,
        oldLabel,
        newLabel,
        oldValue,
        newValue,
        oldDisplayValue,
        newDisplayValue,
        action,
        color
    } = options;

    const reservation = reserveNameLog(logChannel.id, user.id, label, oldValue, newValue, action);
    if (!reservation) return;

    try {
        const logoFile = createLogoFile();
        const embed = new EmbedBuilder()
            .setAuthor({
                name: authorName(user),
                iconURL: user.displayAvatarURL({ dynamic: true })
            })
            .setTitle(changeTitle(label, oldValue, newValue, action))
            .setColor(color)
            .setDescription(description)
            .addFields(
                { name: oldLabel, value: oldDisplayValue, inline: true },
                { name: newLabel, value: newDisplayValue, inline: true }
            )
            .setFooter({ text: `ID: ${user.id}`, iconURL: 'attachment://cc_logo.webp' })
            .setTimestamp();

        await logChannel.send({ embeds: [embed], files: [logoFile] });
    } catch (error) {
        if (recentNameLogs.get(reservation.key) === reservation.entry) recentNameLogs.delete(reservation.key);
        throw error;
    }
}

async function sendDiscordUsernameLog(logChannel, oldProfile, newUser) {
    if (oldProfile.username === newUser.username) return;

    await sendNameChangeLog(logChannel, {
        user: newUser,
        label: 'Discord Username',
        description: nameChangeDescription(newUser, 'Discord Username', oldProfile.username, newUser.username, 'Changed'),
        oldLabel: 'Old Discord Username',
        newLabel: 'New Discord Username',
        oldValue: oldProfile.username,
        newValue: newUser.username,
        oldDisplayValue: oldProfile.username ? escapeMarkdown(oldProfile.username) : '*Unknown Username*',
        newDisplayValue: boldValue(newUser.username),
        action: 'Changed',
        color: 0x3498db
    });
}

async function sendDiscordDisplayNameLog(logChannel, oldProfile, newUser) {
    if (oldProfile.globalName === newUser.globalName) return;

    await sendNameChangeLog(logChannel, {
        user: newUser,
        label: 'Discord Display Name',
        description: nameChangeDescription(newUser, 'Discord Display Name', oldProfile.globalName, newUser.globalName),
        oldLabel: 'Old Discord Display Name',
        newLabel: 'New Discord Display Name',
        oldValue: oldProfile.globalName,
        newValue: newUser.globalName,
        oldDisplayValue: formatDiscordDisplayName(oldProfile.globalName),
        newDisplayValue: newUser.globalName ? boldValue(newUser.globalName) : formatDiscordDisplayName(newUser.globalName),
        color: 0x9b59b6
    });
}

async function sendDiscordAccountNameLogs(logChannel, oldUser, newUser) {
    const oldProfile = knownUserProfiles.get(newUser.id) ?? userProfile(oldUser);

    await sendDiscordUsernameLog(logChannel, oldProfile, newUser);
    await sendDiscordDisplayNameLog(logChannel, oldProfile, newUser);
    rememberUserProfile(newUser);
}

async function sendNicknameLog(logChannel, oldMember, newMember) {
    if (!logChannel || !logChannel.isTextBased()) return;

    const oldNickname = normalizeNickname(oldMember.nickname);
    const newNickname = normalizeNickname(newMember.nickname);
    if (oldNickname === newNickname) return;

    const eventTime = Date.now();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const auditEntry = await findModerationAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, {
        eventTime,
        matches: entry => entry.changes?.some(change => change.key === 'nick' &&
            normalizeNickname(auditChangeValue(change, 'old')) === oldNickname &&
            normalizeNickname(auditChangeValue(change, 'new')) === newNickname)
    });
    const executor = auditEntry?.executor;
    const isModeratorAction = Boolean(executor && executor.id !== newMember.id);

    await sendNameChangeLog(logChannel, {
        user: newMember.user,
        label: 'Server Nickname',
        description: serverNicknameDescription(executor, newMember, isModeratorAction, oldNickname, newNickname),
        oldLabel: 'Old Server Nickname',
        newLabel: 'New Server Nickname',
        oldValue: oldNickname,
        newValue: newNickname,
        oldDisplayValue: oldNickname ? formatNickname(oldNickname) : serverNicknameFallbackText(),
        newDisplayValue: newNickname ? boldValue(newNickname) : newServerNicknameFallbackText(newMember.user),
        color: 0xf1c40f
    });
}

module.exports = {
    primeUserProfileCache(config) {
        const client = config.client;
        if (!client) return;

        for (const user of client.users.cache.values()) {
            rememberUserProfile(user);
        }

        // This uses only members Discord already cached; no full member fetch here.
        for (const guild of client.guilds.cache.values()) {
            for (const member of guild.members.cache.values()) {
                rememberUserProfile(member.user);
            }
        }
    },

    async handleUserUpdate(oldUser, newUser, config) {
        try {
            const logChannel = await getLogChannel(config);
            await sendDiscordAccountNameLogs(logChannel, oldUser, newUser);
            if (oldUser.avatar === newUser.avatar) return;
            const avatarUrl = newUser.displayAvatarURL({ dynamic: true, size: 256 });
            await sendAvatarLog(logChannel, newUser, avatarUrl, 'Discord Avatar Update');
        } catch (error) {
            console.error('[CC LOG] User profile update log failed:', error);
        }
    },

    async handleGuildMemberUpdate(oldMember, newMember, config) {
        try {
            const logChannel = await getLogChannel(config, newMember.guild);
            // Discord account-name changes can arrive here before userUpdate is useful from cache.
            await sendDiscordAccountNameLogs(logChannel, oldMember.user, newMember.user);
            if (oldMember.avatar !== newMember.avatar) {
                const avatarUrl = newMember.displayAvatarURL({ dynamic: true, size: 256 });
                await sendAvatarLog(logChannel, newMember.user, avatarUrl, 'Server Avatar Update');
            }
            await sendNicknameLog(logChannel, oldMember, newMember);
        } catch (error) {
            console.error('[CC LOG] Member profile update log failed:', error);
        } finally {
            // Role syncing must not depend on audit-log permissions or a successful log send.
            if (normalizeNickname(oldMember.nickname) !== normalizeNickname(newMember.nickname)) {
                const currentMember = newMember.guild.members.cache.get(newMember.id) ?? newMember;
                await syncMemberColorRoleName(currentMember).catch(error => {
                    console.warn(`[CC LOG] Could not sync custom color role name for ${newMember.user.tag ?? newMember.id}:`, error);
                });
            }
        }
    }
};
