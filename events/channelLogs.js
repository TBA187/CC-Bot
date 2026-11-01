// Log channel creation, deletion, and permission or configuration changes.

// Category moves and rapid overwrite changes can outpace the audit log cache.
// TODO: Correlate category deletion and bulk permission events before attributing them.
// BUG: When moving a Channel to another Category, it says "Unknow User", otherwise the rest works!
// BUG: When Creating/Deleting many Role/Member Permission Overwrites fast in a Channel, the bot sometimes ...
// ... logs duplicates of some of the Role/Memebr events for both Create/Delete! Bulk updating many Channel overwrites at the same time works perfect!
// TO-DO: Handle when Deleting Category and it contain channels! Channels gets moved to top as UNCATEGORIZED!
// When Category DELETED, bot logs this for Channel: "Category changed: *None* ➔ *None*" and UNKWON EXECUTOR!

const { AuditLogEvent, ChannelType, PermissionsBitField } = require('discord.js');
const {
    sleep,
    isBlockedLogChannel,
    fetchTargetAuditLog,
    extractExecutor,
    getChannelTypeInfo,
    formatEmoji,
    formatViewChannelPerms,
    buildLogEmbed
} = require('../utils/logHelpers.js');

const channelUpdateCache = new Map();

function scheduleChannelUpdate(oldChannel, channelId, config) {
    return setTimeout(() => processBatchedUpdate(oldChannel, channelId, config)
        .catch(error => console.error('[CC LOG] Channel update log failed:', error)), 2500);
}

function normalizeForumLayout(value) {
    return value === 1 || value === 2 ? value : 0;
}

function normalizeForumSortOrder(value) {
    // Discord represents the normal "Latest Activity" default as either null or 0.
    return value === 1 ? 1 : 0;
}

function getForumLayoutLabel(value) {
    const layout = normalizeForumLayout(value);
    return layout === 1 ? 'List' : (layout === 2 ? 'Gallery' : 'Not Set');
}

function getForumSortLabel(value) {
    return normalizeForumSortOrder(value) === 1 ? 'Creation Time' : 'Latest Activity';
}

function forumReactionKey(emoji) {
    if (!emoji) return '';
    return `${emoji.id || ''}:${emoji.name || ''}`;
}

module.exports = {
    // Channel creation.
    async handleChannelCreate(channel, config) {
        if (!channel.guild) return;

        const logChannel = channel.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await sleep(1500);

        const entry = await fetchTargetAuditLog(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
        const executor = extractExecutor(entry, null, channel.guild);

        // IGNORE logging for newly created Private Channels (Optional Filter for Server Owner only)
        // TO-DO: Store channelID in DB to prevent future logging for update/delete events
        if (config.ignoreLogPrivateChannelCreate === 1 && executor.id === config.ownerID) {
            // Check if view permission for ONLY @everyone were set to false
            const everyoneOverwrites = channel.permissionOverwrites.cache;
            const isPrivateAtCreation = everyoneOverwrites.size === 1 &&
                everyoneOverwrites.has(channel.guild.id) &&
                everyoneOverwrites.get(channel.guild.id).deny.has(PermissionsBitField.Flags.ViewChannel);

            // Skip logging if channel was marked as Private by user and NO other role overwrites were made!
            if (isPrivateAtCreation) return;
        }

        const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(channel.type);
        const channelLabel = channel.type === ChannelType.GuildText ? 'Channel' : typeName;
        const parent = channel.parent ? `${channel.parent.name}` : '*Uncategorized!*';
        const isCategory = channel.type === ChannelType.GuildCategory;

        const viewPerms = formatViewChannelPerms(channel.permissionOverwrites.cache, channel.guild, typeName);

        const fields = isCategory ? [
            { name: 'Category Name', value: `${channel.name}`, inline: true },
            { name: 'Created By', value: `${executor.mention} (${executor.username})`, inline: true },
            { name: '', value: viewPerms, inline: false }
        ] : [
            { name: 'Name', value: `${channel.name}`, inline: true },
            { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
            { name: 'Category', value: parent, inline: true },
            { name: 'Created By', value: `${executor.mention} (${executor.username})`, inline: false },
            { name: '', value: viewPerms, inline: false }
        ];

        const logPayload = buildLogEmbed(
            isCategory ? `✅\u2002Category Created!\u2002${typeEmoji}` : `✅\u2002${channelLabel} Created: <#${channel.id}>`,
            channel.topic ? `**Topic:** ${channel.topic}` : null,
            channel.id,
            isCategory ? 0x228B22 : 0x00FF00,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    },

    // Channel deletion.
    async handleChannelDelete(channel, config) {
        if (!channel.guild) return;

        if (isBlockedLogChannel(channel.id, config.ignoredLogChannels)) return;

        const logChannel = channel.guild.channels.cache.get(config.logChannelID);
        if (!logChannel) return;

        await sleep(1500);
        const entry = await fetchTargetAuditLog(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
        const executor = extractExecutor(entry, null, channel.guild);
        const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(channel.type);
        const channelLabel = channel.type === ChannelType.GuildText ? 'Channel' : typeName;
        const parent = channel.parent ? `${channel.parent.name}` : '*Uncategorized!*';
        const isCategory = channel.type === ChannelType.GuildCategory;

        const fields = isCategory ? [
            { name: 'Category Name', value: `${channel.name}`, inline: true },
            { name: 'Deleted By', value: `${executor.mention} (${executor.username})`, inline: true },
        ] : [
            { name: 'Name', value: `${channel.name}`, inline: true },
            { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
            { name: 'Category', value: parent, inline: true },
            { name: 'Deleted By', value: `${executor.mention} (${executor.username})`, inline: false }
        ];

        const logPayload = buildLogEmbed(
            isCategory ? `❌\u2002Category Deleted!\u2002${typeEmoji}` : `❌\u2002${channelLabel} Deleted!`,
            null,
            channel.id,
            isCategory ? 0x8B0000 : 0xFF0000,
            typeName,
            fields
        );

        await logChannel.send(logPayload);
    },

    // Batch channel updates before comparing their settings.
    async handleChannelUpdate(oldChannel, newChannel, config) {
        if (config.shutdownSignal?.aborted) return;
        if (!newChannel.guild || !newChannel.guild.channels.cache.has(newChannel.id)) return;
        if (isBlockedLogChannel(newChannel.id, config.ignoredLogChannels)) return;

        const channelId = newChannel.id;

        // Keep the first snapshot while Discord delivers the rest of the same edit.
        if (channelUpdateCache.has(channelId)) {
            const cached = channelUpdateCache.get(channelId);
            clearTimeout(cached.timeout);

            cached.timeout = scheduleChannelUpdate(cached.oldChannel, channelId, config);

            return;
        }

        const timeout = scheduleChannelUpdate(oldChannel, channelId, config);

        channelUpdateCache.set(channelId, { oldChannel, timeout });
    }
};

async function processBatchedUpdate(oldChannel, channelId, config) {
    channelUpdateCache.delete(channelId);
    if (config.shutdownSignal?.aborted) return;

    const newChannel = oldChannel.guild.channels.cache.get(channelId);
    if (!newChannel) return;

    const logChannel = newChannel.guild.channels.cache.get(config.logChannelID);
    if (!logChannel) return;

    await sleep(1500);
    if (config.shutdownSignal?.aborted) return;
    let logEntry = null;
    try {
        const fetchedLogs = await newChannel.guild.fetchAuditLogs({ limit: 100 });
        logEntry = fetchedLogs.entries.find(e => {
            const isCorrectAction = [
                AuditLogEvent.ChannelUpdate,
                AuditLogEvent.ChannelOverwriteCreate,
                AuditLogEvent.ChannelOverwriteUpdate,
                AuditLogEvent.ChannelOverwriteDelete
            ].includes(e.action);

            return isCorrectAction &&
                (e.targetId === newChannel.id || e.extra?.channel?.id === newChannel.id || e.extra?.id === newChannel.id) &&
                (Date.now() - e.createdTimestamp) < 45000;
        });
    } catch (err) { console.error(err); }

    const executor = logEntry?.executor ? {
        mention: `<@${logEntry.executor.id}>`,
        username: logEntry.executor.tag,
        id: logEntry.executor.id
    } : { mention: 'Unknown User', username: 'Unknown', id: null };

    const parent = newChannel.parent ? `${newChannel.parent.name}` : '*Uncategorized!*';
    const { name: typeName, emoji: typeEmoji } = getChannelTypeInfo(newChannel.type);
    const { name: oldTypeName } = getChannelTypeInfo(oldChannel.type);
    const channelLabel = newChannel.type === ChannelType.GuildText ? 'Channel' : typeName;
    const isCategory = newChannel.type === ChannelType.GuildCategory;

    // ---------------------------
    // Detect Channel Changes
    // ---------------------------
    let changes = [];

    // Name change
    if (oldChannel.name !== newChannel.name) {
        changes.push(`- **Name Updated:**\u2002\`${oldChannel.name}\`  ➔  \`${newChannel.name}\``);
    }

    // Topic or description.
    if ((oldChannel.topic || '') !== (newChannel.topic || '')) {
        const oldT = oldChannel.topic || '*No topic*';
        const newT = newChannel.topic || '*No topic*';
        changes.push(`- **Topic Changed:**\n**From:** \`\`\`${oldT}\`\`\`\n**To:** \`\`\`${newT}\`\`\``);
    }

    // Slowmode (rate limit).
    if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        const formatSlow = (s) => (s === undefined || s === null) ? 'Off' : (s === 0 ? 'Off' : `${s}s`);
        const oldS = formatSlow(oldChannel.rateLimitPerUser);
        const newS = formatSlow(newChannel.rateLimitPerUser);
        if (oldS !== newS) changes.push(`- **Slowmode:** \`${oldS}\` ➔ \`${newS}\``);
    }

    // Age-restricted channel (NSFW status).
    if (oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`- **Age-Restricted (NSFW):** \`${oldChannel.nsfw ? 'Enabled' : 'Disabled'}\` ➔ \`${newChannel.nsfw ? 'Enabled' : 'Disabled'}\``);
    }

    // Channel type.
    if (oldChannel.type !== newChannel.type) {
        changes.push(`- **Channel Type:** \`${oldTypeName}\` ➔ \`${typeName}\``);
    }

    // Hide threads after inactivity.
    const archiveChange = logEntry?.changes?.find(c => c.key === 'default_auto_archive_duration');
    const oldArchive = archiveChange ? archiveChange.old : oldChannel.defaultAutoArchiveDuration;
    const newArchive = archiveChange ? archiveChange.new : newChannel.defaultAutoArchiveDuration;
    if (archiveChange || (oldArchive !== newArchive)) {
        const formatDuration = (minutes) => {
            if (!minutes) return 'Default (3 Days)';
            if (minutes === 60) return '1 Hour';
            if (minutes === 1440) return '24 Hours';
            if (minutes === 4320) return '3 Days';
            if (minutes === 10080) return '1 Week';
            return `${minutes} Minutes`;
        };
        const oldD = formatDuration(oldArchive);
        const newD = formatDuration(newArchive);
        if (oldD !== newD) changes.push(`- **Hide Threads after inactivity:** \`${oldD}\` ➔ \`${newD}\``);
    }

    // Voice channel bitrate.
    if (oldChannel.bitrate !== newChannel.bitrate) {
        changes.push(`- **Bitrate:** \`${oldChannel.bitrate / 1000}kbps\` ➔ \`${newChannel.bitrate / 1000}kbps\``);
    }

    // Voice channel user limit.
    if (oldChannel.userLimit !== newChannel.userLimit) {
        changes.push(`- **User Limit:** \`${oldChannel.userLimit || '∞'}\` ➔ \`${newChannel.userLimit || '∞'}\``);
    }

    // Voice channel region override.
    if (oldChannel.rtcRegion !== newChannel.rtcRegion) {
        changes.push(`- **Region Override:** \`${oldChannel.rtcRegion || 'Automatic'}\` ➔ \`${newChannel.rtcRegion || 'Automatic'}\``);
    }

    // Voice channel video quality.
    if (oldChannel.videoQualityMode !== newChannel.videoQualityMode) {
        const getVQM = (mode) => mode === 1 ? 'Auto' : (mode === 2 ? '720p/1080p' : 'Unknown');
        changes.push(`- **Video Quality:** \`${getVQM(oldChannel.videoQualityMode)}\` ➔ \`${getVQM(newChannel.videoQualityMode)}\``);
    }

    // Forum layout, sorting, reactions, slowmode, and tags.
    if (newChannel.type === ChannelType.GuildForum) {
        const oldLayout = normalizeForumLayout(oldChannel.defaultForumLayout);
        const newLayout = normalizeForumLayout(newChannel.defaultForumLayout);
        if (oldLayout !== newLayout) {
            changes.push(`- **Default Layout:** \`${getForumLayoutLabel(oldLayout)}\` ➔ \`${getForumLayoutLabel(newLayout)}\``);
        }
        const oldSortOrder = normalizeForumSortOrder(oldChannel.defaultSortOrder);
        const newSortOrder = normalizeForumSortOrder(newChannel.defaultSortOrder);
        if (oldSortOrder !== newSortOrder) {
            changes.push(`- **Default Sort Order:** \`${getForumSortLabel(oldSortOrder)}\` ➔ \`${getForumSortLabel(newSortOrder)}\``);
        }
        if (forumReactionKey(oldChannel.defaultReactionEmoji) !== forumReactionKey(newChannel.defaultReactionEmoji)) {
            const oldEmoji = oldChannel.defaultReactionEmoji ? `${formatEmoji(oldChannel.defaultReactionEmoji)}` : '*No Emoji*';
            const newEmoji = newChannel.defaultReactionEmoji ? `${formatEmoji(newChannel.defaultReactionEmoji)}` : '*No Emoji*';
            changes.push(`- **Default Reaction:** ${oldEmoji} ➔ ${newEmoji}`);
        }
        const oldPostSlowmode = Number(oldChannel.defaultThreadRateLimitPerUser || 0);
        const newPostSlowmode = Number(newChannel.defaultThreadRateLimitPerUser || 0);
        if (oldPostSlowmode !== newPostSlowmode) {
            const oldTR = oldPostSlowmode ? `${oldPostSlowmode}s` : 'Off';
            const newTR = newPostSlowmode ? `${newPostSlowmode}s` : 'Off';
            changes.push(`- **Post Slowmode:** \`${oldTR}\` ➔ \`${newTR}\``);
        }
        if ((oldChannel.flags?.has('RequireTag') || false) !== (newChannel.flags?.has('RequireTag') || false)) {
            changes.push(`- **Require tags to post:** \`${oldChannel.flags?.has('RequireTag') ? 'Enabled' : 'Disabled'}\` ➔ \`${newChannel.flags?.has('RequireTag') ? 'Enabled' : 'Disabled'}\``);
        }

        // Tags Logic
        const oldTags = oldChannel.availableTags || [];
        const newTags = newChannel.availableTags || [];
        oldTags.forEach(oldT => {
            const tagEmoji = oldT.emoji ? `${formatEmoji(oldT)}` : '*No Emoji*';
            if (!newTags.find(t => t.id === oldT.id)) changes.push(`- **Tag Deleted!**\u2002❌\n   - **Tag Name:** \`${oldT.name}\`\n   - **Tag Emoji:** ${tagEmoji}`);
        });
        newTags.forEach(newT => {
            const oldT = oldTags.find(t => t.id === newT.id);
            const tagEmoji = newT.emoji ? `${formatEmoji(newT)}` : '*No Emoji*';
            if (!oldT) {
                changes.push(`- **New Tag Created!**\u2002✅\n   - **Tag Name:** \`${newT.name}\`\n   - **Tag Emoji:** ${tagEmoji}\n   - **Moderators Only:** \`${newT.moderated ? 'Yes' : 'No'}\``);
            } else {
                if (oldT.name !== newT.name) changes.push(`- **Tag Name changed:**\u2002\`${oldT.name}\`  ➔  \`${newT.name}\``);
                const emojiChanged = (oldT.emoji ? `${oldT.emoji.id}-${oldT.emoji.name}` : 'none') !== (newT.emoji ? `${newT.emoji.id}-${newT.emoji.name}` : 'none');
                if (emojiChanged) changes.push(`- **Tag Emoji for** '\`${newT.name}\`' **updated:**\u2002${oldT.emoji ? formatEmoji(oldT) : '*No Emoji*'}  ➔  ${tagEmoji}`);
                if (oldT.moderated !== newT.moderated) changes.push(`- **Tag Permissions for** "\`${newT.name}\`" **updated:**\u2002\`${oldT.moderated ? 'Mods Only' : 'Everyone'}\`  ➔  \`${newT.moderated ? 'Mods Only' : 'Everyone'}\``);
            }
        });
    }

    // Parent category.
    if (oldChannel.parentId !== newChannel.parentId) {
        changes.push(`- **Category changed:** \`${oldChannel.parent?.name || '*None*'}\` ➔ \`${newChannel.parent?.name || '*None*'}\``);
    }

    // Category permission sync.
    if (Boolean(oldChannel.permissionsLocked) !== Boolean(newChannel.permissionsLocked)) {
        changes.push(`- **Category Sync:** \`${newChannel.permissionsLocked ? 'Synced with Category' : 'Custom Permissions'}\``);
    }

    // Role and member permission overwrites.
    const oldOverwrites = oldChannel.permissionOverwrites.cache;
    const newOverwrites = newChannel.permissionOverwrites.cache;
    if (!oldOverwrites.equals(newOverwrites)) {
        // Handle Deleted Overwrites
        oldOverwrites.forEach((oldPerm, id) => {
            if (!newOverwrites.has(id)) {
                const targetTag = id === newChannel.guild.id ? '@everyone' : (newChannel.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`);
                changes.push(`**Overwrites for ${targetTag} removed!**`);
            }
        });

        // Handle Created or Updated Overwrites
        newOverwrites.forEach((newPerm, id) => {
            const oldPerm = oldOverwrites.get(id);
            const hasChanged = !oldPerm ||
                oldPerm.allow.bitfield !== newPerm.allow.bitfield ||
                oldPerm.deny.bitfield !== newPerm.deny.bitfield;

            if (hasChanged) {
                const targetTag = id === newChannel.guild.id ? '@everyone' : (newChannel.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`);
                let permChanges = [];

                for (const [permName, permBit] of Object.entries(PermissionsBitField.Flags)) {
                    const oldAllow = oldPerm ? oldPerm.allow.has(permBit) : false;
                    const oldDeny = oldPerm ? oldPerm.deny.has(permBit) : false;
                    const newAllow = newPerm.allow.has(permBit);
                    const newDeny = newPerm.deny.has(permBit);

                    if (oldAllow !== newAllow || oldDeny !== newDeny) {
                        const spacedName = permName.replace(/([A-Z])/g, ' $1').trim();
                        const getState = (allow, deny) => allow ? '✅' : (deny ? '❌' : '⬜');
                        permChanges.push(`- **${spacedName}: ${getState(oldAllow, oldDeny)} ➔ ${getState(newAllow, newDeny)}**`);
                    }
                }

                if (!oldPerm) {
                    // Logic for a brand new permission overwrite
                    if (permChanges.length === 0) {
                        changes.push(`**Overwrites for ${targetTag} created:**\n- **⚠️\u2002No permissions were selected!**`);
                    } else {
                        // Logic for a brand new permission overwrite that is quickly updated right after creation
                        changes.push(`**Overwrites for ${targetTag} created & configured:**\n${permChanges.join('\n')}`);
                    }
                } else if (permChanges.length > 0) {
                    changes.push(`**Overwrites for ${targetTag} updated:**\n${permChanges.join('\n')}`);
                }
            }
        });
    }

    if (changes.length === 0) return;

    const fields = isCategory ? [
        { name: 'Category Name', value: `${newChannel.name}`, inline: true },
        { name: 'Updated By', value: `${executor.mention} (${executor.username})`, inline: true },
        { name: '\u2002', value: '\u2002', inline: false },
        { name: '⚙️\u2002Changes:', value: changes.join('\n'), inline: false }
    ] : [
        { name: 'Name', value: `${newChannel.name}`, inline: true },
        { name: 'Channel Type', value: `${typeName}\u2002${typeEmoji}`, inline: true },
        { name: 'Category', value: parent, inline: true },
        { name: `Updated By`, value: `${executor.mention} (${executor.username})`, inline: false },
        { name: '\u2002', value: '\u2002', inline: false },
        { name: '⚙️\u2002Changes:', value: changes.join('\n'), inline: false }
    ];

    const logPayload = buildLogEmbed(
        isCategory ? `🔄\u2002Category Updated!\u2002${typeEmoji}` : `🔄\u2002${channelLabel} Updated: <#${newChannel.id}>`,
        null,
        newChannel.id,
        isCategory ? 0x9B59B6 : 0xFFA500, // Purple for category, Orange for channel
        typeName,
        fields
    );

    if (!config.shutdownSignal?.aborted) await logChannel.send(logPayload);
}

module.exports.normalizeForumLayout = normalizeForumLayout;
module.exports.normalizeForumSortOrder = normalizeForumSortOrder;
