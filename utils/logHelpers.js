// Share audit-log lookup and formatting for channel and member events.
const { ChannelType, EmbedBuilder, AttachmentBuilder } = require('discord.js');

module.exports = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    // Helper to check if a channel/thread should be ignored for logging
    isBlockedLogChannel: (channelId, ignoredLogChannels) => {
        return ignoredLogChannels && ignoredLogChannels.includes(channelId);
    },

    // Helper to fetch and find the correct audit log entry
    fetchTargetAuditLog: async (guild, actionType, targetId, maxAgeMs = 15000) => {
        if (!guild) return null;
        try {
            // A busy moderation action can create far more than ten entries at once.
            // Filtering by action lets Discord return the full recent batch for that action.
            const fetchedLogs = await guild.fetchAuditLogs({
                limit: 100,
                ...(actionType ? { type: actionType } : {})
            });

            return fetchedLogs.entries.find(e => {
                if (actionType && e.action !== actionType) return false;

                const isRecent = (Date.now() - e.createdTimestamp) < maxAgeMs;
                if (!isRecent) return false;

                // Permission overwrites may identify the channel in extra rather than target.
                return (
                    String(e.targetId || e.target?.id || '') === String(targetId) ||
                    String(e.extra?.channel?.id || '') === String(targetId) ||
                    String(e.extra?.id || '') === String(targetId)
                );
            });
        } catch (error) {
            console.error("Error fetching audit logs:", error);
            return null;
        }
    },

    // Helper to standardize getting the user who performed the action
    extractExecutor: (entry, fallbackId = null, guild = null) => {
        const user = entry?.executor;
        const member = (user && guild) ? guild.members.cache.get(user.id) : (fallbackId ? guild?.members.cache.get(fallbackId) : null);

        return {
            mention: user ? `<@${user.id}>` : (fallbackId ? `<@${fallbackId}>` : 'Unknown User'),
            id: user?.id || fallbackId || 'Unknown User ID',
            tag: user?.tag || 'Unknown User Tag',
            username: user?.username || 'Unknown Username',
            nickname: member?.nickname || 'No Nickname', // Server specific Nickname
            globalName: user?.displayName || 'No Global Name', // Discord Global Display Name
            avatar: user?.displayAvatarURL() || null
        };
    },

    // Helper to turn ChannelType numbers into readable text
    getChannelTypeInfo: (type) => {
        const types = {
            [ChannelType.GuildText]: { name: 'Text Channel', emoji: '💬' },
            [ChannelType.GuildVoice]: { name: 'Voice Channel', emoji: '🔊' },
            [ChannelType.GuildCategory]: { name: 'Category', emoji: '📂' },
            [ChannelType.GuildAnnouncement]: { name: 'Announcement Channel', emoji: '📢' },
            [ChannelType.AnnouncementThread]: { name: 'Announcement Thread', emoji: '📢 🧵' },
            [ChannelType.PublicThread]: { name: 'Public Thread', emoji: '🧵' },
            [ChannelType.PrivateThread]: { name: 'Private Thread', emoji: '🔐 🧵' },
            [ChannelType.GuildStageVoice]: { name: 'Stage Channel', emoji: '🎤' },
            [ChannelType.GuildForum]: { name: 'Forum Channel', emoji: '🗂️' },
            // [ChannelType.GuildForum]: { name: 'Forum Post', emoji: '🗨️' },
            [ChannelType.GuildMedia]: { name: 'Media Channel', emoji: '🖼️' },
            [ChannelType.GuildDirectory]: { name: 'Directory Channel (Student Hub)', emoji: '📇' },
            // [ChannelType.PublicThread]: { name: 'Thread', emoji: '#️⃣' },
        };

        return types[type] || { name: 'Unknown Channel Type', emoji: '❓' };
    },

    // Emoji Helper
    formatEmoji: (data) => {
        if (!data) return '';
        let eId = null;
        let eName = null;

        if (data.emoji !== undefined) {
            if (!data.emoji) return '';
            eId = data.emoji.id;
            eName = data.emoji.name;
        } else {
            eId = data.id || data.emojiId;
            eName = data.name || data.emojiName;
        }

        if (eId) {
            const safeName = eName ? eName.replace(/[^a-zA-Z0-9_]/g, '') : 'e';
            return `<:${safeName}:${eId}>`;
        }

        if (eName) return eName;
        return '';
    },

    // Channel Role Permissions Formatter
    formatViewChannelPerms: (overwrites, guild, typeName) => {
        if (!overwrites || overwrites.size === 0) return '- **Default Permissions (Public Category)**';

        let permStrings = [];
        overwrites.forEach((perm, id) => {
            const isEveryone = id === guild.id;
            const isRole = guild.roles.cache.has(id);
            let targetLabel = 'Role';
            let targetTag;
            if (isEveryone) {
                targetTag = '@everyone';
            } else if (isRole) {
                const role = guild.roles.cache.get(id);
                targetTag = `<@&${id}> (${role.name})`;
            } else {
                targetLabel = 'Member';
                const member = guild.members.cache.get(id);
                targetTag = member ? `<@${id}> (${member.user?.username || 'Unknown User'})` : `<@${id}>`;
            }

            const canView = perm.allow.has('ViewChannel');
            const cannotView = perm.deny.has('ViewChannel');
            if (canView) {
                permStrings.push(`**${targetLabel} override for ${targetTag}**\n- View Channel  ➔  ✅`);
            } else if (cannotView) {
                permStrings.push(`**${targetLabel} override for ${targetTag}**\n- View Channel  ➔  ❌`);
            }
        });
        return permStrings.length > 0 ? permStrings.join('\n') : `- **Default Permissions (Public ${typeName})**`;
    },

    // Build embed message for Discord Logs
    buildLogEmbed: (title, description, id, color, typeName, fields = []) => {
        const attachment = new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' });
        const safeFields = Array.isArray(fields)
            ? fields
                .filter(field => field && typeof field === 'object')
                .map(field => ({
                    name: String(field.name || '\u200B').slice(0, 256),
                    value: String(field.value || '\u200B').slice(0, 1024),
                    inline: Boolean(field.inline)
                }))
            : [];

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(color || 0x808080)
            .setDescription(description || ' ')
            .setFooter({ text: `${typeName} ID: ${id}`, iconURL: 'attachment://cc_logo.webp' })
            .setTimestamp();

        if (safeFields.length > 0) {
            embed.addFields(safeFields);
        }

        return { embeds: [embed], files: [attachment] };
    }
};
