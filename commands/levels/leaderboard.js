// Browse guild XP rankings by track and activity type.

const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    StringSelectMenuBuilder
} = require('discord.js');
const { formatNumber } = require('../../utils/xpFormatter');
const { resolveXpTrack, fetchXpTrackAutocompleteChoices } = require('../../utils/xpDbHelper');
const path = require('path');
const { formatTrackingSince, getTrackRequirementDisplay } = require('../../features/levels/presentation.js');


const SORT_OPTIONS = {
    level: {
        label: 'Level',
        emoji: '🏆',
        description: 'Sort by level and total XP',
        orderBy: 'level DESC, xp_amount DESC',
        select: 'xp_amount, level',
        visibleWhere: '(COALESCE(level, 0) > 0 OR COALESCE(xp_amount, 0) > 0)',
        stat: user => `Lvl **${formatNumber(user.level)}** (${formatNumber(user.xp_amount)} XP)`
    },
    messages: {
        label: 'Messages',
        emoji: '💬',
        description: 'Sort by total messages sent',
        orderBy: 'total_messages_sent DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_messages_sent, message_xp',
        visibleWhere: '(COALESCE(total_messages_sent, 0) > 0 OR COALESCE(message_xp, 0) > 0)',
        stat: user => `**${formatNumber(user.total_messages_sent)}** messages (${formatNumber(user.message_xp || 0)} XP)`
    },
    reactions: {
        label: 'Reactions',
        emoji: '🔥',
        description: 'Sort by total reactions added',
        orderBy: 'total_reactions_added DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_reactions_added, reaction_xp',
        visibleWhere: '(COALESCE(total_reactions_added, 0) > 0 OR COALESCE(reaction_xp, 0) > 0)',
        stat: user => `**${formatNumber(user.total_reactions_added)}** reactions (${formatNumber(user.reaction_xp || 0)} XP)`
    },
    voice: {
        label: 'Voice Hours',
        emoji: '🔊',
        description: 'Sort by total voice hours',
        orderBy: 'total_voice_minutes DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_voice_minutes, voice_xp',
        visibleWhere: '(COALESCE(total_voice_minutes, 0) > 0 OR COALESCE(voice_xp, 0) > 0)',
        stat: user => `**${formatVoiceTime(user.total_voice_minutes)}** voice time (${formatNumber(user.voice_xp || 0)} XP)`
    },
    commands: {
        label: 'Commands',
        emoji: '🤖',
        description: 'Sort by total commands used',
        orderBy: 'total_commands_used DESC, level DESC, xp_amount DESC',
        select: 'xp_amount, level, total_commands_used, command_xp',
        visibleWhere: '(COALESCE(total_commands_used, 0) > 0 OR COALESCE(command_xp, 0) > 0)',
        stat: user => `**${formatNumber(user.total_commands_used)}** commands (${formatNumber(user.command_xp || 0)} XP)`
    }
};

function getSortOption(sortKey) {
    return SORT_OPTIONS[sortKey] || SORT_OPTIONS.level;
}

function formatVoiceTime(minutes) {
    const totalMinutes = Math.max(0, Math.floor(Number(minutes || 0)));
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    if (hours > 0 && remainingMinutes > 0) return `${formatNumber(hours)}h ${remainingMinutes}m`;
    if (hours > 0) return `${formatNumber(hours)}h`;
    return `${remainingMinutes}m`;
}

function buildSortMenu(track, sortKey) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`lb_sort_${track}`)
            .setPlaceholder('Filter leaderboard...')
            .addOptions(Object.entries(SORT_OPTIONS).map(([value, option]) => ({
                label: option.label,
                emoji: option.emoji,
                description: option.description,
                value,
                default: value === sortKey
            })))
    );
}

function buildPageButtons(page, track, sortKey, isLastPage) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`lb_prev_${page}_${sortKey}_${track}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === 1),
        new ButtonBuilder()
            .setCustomId(`lb_next_${page}_${sortKey}_${track}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(isLastPage)
    );
}

class Leaderboard {
    constructor(config) {
        this.config = config;
        this.name = 'leaderboard';
        this.data = new SlashCommandBuilder()
            .setName('leaderboard')
            .setDescription('Display the XP Leaderboard of the server')
            .addStringOption(opt => opt
                .setName('xp_track')
                .setDescription('Optional: Select an XP Track (leave empty for Global XP track)')
                .setAutocomplete(true)
            );
    }

    async execute(interaction) {
        const trackInput = interaction.options.getString('xp_track');
        await interaction.deferReply();
        const trackInfo = await resolveXpTrack(this.config.db, trackInput);

        if (!trackInfo) {
            await interaction.deleteReply();
            return interaction.followUp({
                content: "### Track Not Found\nThis XP track doesn't exist.",
                flags: MessageFlags.Ephemeral
            });
        }

        return this.renderLeaderboard(interaction, 1, trackInfo, 'level');
    }

    async renderLeaderboard(interaction, page, trackInput = null, sortKey = 'level') {
        const trackInfo = trackInput && typeof trackInput === 'object'
            ? trackInput
            : await resolveXpTrack(this.config.db, trackInput);
        if (!trackInfo) {
            const payload = { content: 'This XP track no longer exists.', components: [] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        }

        const track = trackInfo.xpType;
        const sort = getSortOption(sortKey);
        const activeSortKey = SORT_OPTIONS[sortKey] ? sortKey : 'level';
        const guildId = interaction.guild.id;
        const guildName = interaction.guild.name;
        const limit = 20;
        const offset = (page - 1) * limit;

        try {
            const cachedSettings = this.config.guildSettingsCache?.get(String(guildId));
            const trackingSinceValue = trackInfo.isGlobal ? cachedSettings?.xpDateEnabled : trackInfo.createdAt;
            const trackingSince = formatTrackingSince(trackingSinceValue);

            const [users] = await this.config.db.query(
                `SELECT user_id, ${sort.select}
                 FROM xp_user_levels
                 WHERE guild_id = ? AND xp_type = ?
                   AND ${sort.visibleWhere}
                 ORDER BY ${sort.orderBy}
                 LIMIT ? OFFSET ?`,
                [guildId, track, limit, offset]
            );

            const logoPath = path.join(__dirname, '../../images/cc_logo.webp');
            const logoFile = new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' });
            const leaderboardTitle = trackInfo.isGlobal
                ? `Leaderboard for ${guildName}`
                : `Leaderboard for ${trackInfo.displayName}:`;
            const trackRequirements = !trackInfo.isGlobal ? getTrackRequirementDisplay(trackInfo) : { description: '', fields: [] };

            const lbEmbed = new EmbedBuilder()
                .setTitle(leaderboardTitle)
                .setThumbnail('attachment://cc_logo.webp')
                .setColor(trackInfo.color || '#F1C40F')
                .setFooter({ text: `${trackingSince}  •  Page ${page}`, iconURL: 'attachment://cc_logo.webp' })
                .setTimestamp();

            if (!trackInfo.isGlobal) {
                if (trackRequirements.description) {
                    lbEmbed.setDescription(trackRequirements.description);
                }
                if (trackRequirements.fields.length > 0) {
                    lbEmbed.addFields(...trackRequirements.fields);
                }
            }

            if (users.length === 0) {
                lbEmbed.addFields({ name: '\u2002', value: `No XP data has been registered for **${sort.label}\u2002${sort.emoji}**`, inline: false });
            } else {
                const memberColumn = users.map((user, index) => {
                    const rank = offset + index + 1;
                    return `**#${rank}** <@${user.user_id}>`;
                }).join('\n');
                const statColumn = users.map(user => {
                    return sort.stat(user);
                }).join('\n');

                lbEmbed.addFields(
                    { name: '\u2002', value: `Leaderboard sorted by **${sort.label}\u2002${sort.emoji}**`, inline: false },
                    { name: 'Member', value: memberColumn, inline: true },
                    { name: sort.label, value: statColumn, inline: true }
                );
            }

            if (this.config.db.xpStore?.hasPending(guildId, track)) {
                lbEmbed.addFields({ name: 'XP synchronization',
                    value: 'Recent activity is waiting to sync. These totals may be behind.' });
            }
            const components = [
                buildSortMenu(track, activeSortKey),
                buildPageButtons(page, track, activeSortKey, users.length < limit)
            ];

            const payload = { embeds: [lbEmbed], components, files: [logoFile] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        } catch (err) {
            if (this.config.db.isDatabaseUnavailableError?.(err)) {
                const payload = { content: 'XP data is temporarily unavailable while the database reconnects. New XP/activity is saved locally and will sync automatically.', components: [] };
                if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
                return interaction.update(payload);
            }
            console.error('[CC LOG] Level Leaderboard Error:', err);
            const payload = { content: 'Error fetching leaderboard data.', components: [] };
            if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
            return interaction.update(payload);
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('lb_')) return false;

        const parts = interaction.customId.split('_');
        const action = parts[1];
        const currentPage = parseInt(parts[2], 10);
        const sortKey = parts[3] || 'level';
        const track = parts.slice(4).join('_');
        let newPage = currentPage;

        if (action === 'next') newPage++;
        if (action === 'prev') newPage--;

        await interaction.deferUpdate();
        await this.renderLeaderboard(interaction, newPage, track, sortKey);
        return true;
    }

    async handleSelect(interaction) {
        if (!interaction.customId.startsWith('lb_sort_')) return false;

        const track = interaction.customId.replace('lb_sort_', '');
        const sortKey = interaction.values[0] || 'level';

        await interaction.deferUpdate();
        await this.renderLeaderboard(interaction, 1, track, sortKey);
        return true;
    }

    async handleAutocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const choices = await fetchXpTrackAutocompleteChoices(this.config.db, focusedValue);
        await interaction.respond(choices).catch(() => { });
    }
}

module.exports = Leaderboard;
