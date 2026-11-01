// Display a member's XP totals and progress for a global or special track.

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { formatNumber } = require('../../utils/xpFormatter');
const xpMath = require('../../utils/xpMath');
const xpSettings = require('../../config/xpConfig');
const { resolveXpTrack, fetchXpTrackAutocompleteChoices } = require('../../utils/xpDbHelper');
const path = require('path');
const { formatTrackingSince, getTrackRequirementDisplay } = require('../../features/levels/presentation.js');

function formatVoiceTime(minutes) {
    const totalMinutes = Math.max(0, Math.floor(Number(minutes || 0)));
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    if (hours > 0 && remainingMinutes > 0) return `${formatNumber(hours)}h ${remainingMinutes}m`;
    if (hours > 0) return `${formatNumber(hours)}h`;
    return `${remainingMinutes} min`;
}

function getDisplayName(member, user) {
    return member?.displayName || user.globalName || user.username;
}

function capitalizeDisplayName(name) {
    if (!name) return name;
    return name.charAt(0).toUpperCase() + name.slice(1);
}


class Rank {
    constructor(config) {
        this.config = config;
        this.name = 'rank';
        this.data = new SlashCommandBuilder()
            .setName('rank')
            .setDescription('Check level and detailed XP stats for a user')
            .addUserOption(opt => opt.setName('user').setDescription('User to check (leave empty for yourself)'))
            .addStringOption(opt => opt
                .setName('xp_track')
                .setDescription('Optional: Select an XP Track (leave empty for Global XP track)')
                .setAutocomplete(true)
            );
    }

    async execute(interaction) {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetMember = interaction.options.getMember('user')
            || (target.id === interaction.user.id ? interaction.member : null);
        const trackInput = interaction.options.getString('xp_track');
        const guildId = interaction.guild.id;

        await interaction.deferReply();
        const trackInfo = await resolveXpTrack(this.config.db, trackInput);
        if (!trackInfo) {
            await interaction.deleteReply();
            return interaction.followUp({
                content: "### Track Not Found\nThis XP track doesn't exist.",
                flags: MessageFlags.Ephemeral
            });
        }

        const track = trackInfo.xpType;

        try {
            const [rows] = await this.config.db.query(`
                SELECT
                    xp_date, xp_amount, level,
                    message_xp, reaction_xp, command_xp, voice_xp,
                    messages_sent, reactions_added, commands_used, voice_minutes,
                    total_messages_sent, total_reactions_added, total_commands_used, total_voice_minutes
                FROM xp_user_levels
                WHERE user_id = ? AND guild_id = ? AND xp_type = ?
            `, [target.id, guildId, track]);

            if (!rows[0] && !trackInfo.isGlobal) {
                const trackRequirements = getTrackRequirementDisplay(trackInfo);
                const roleLabel = trackInfo.roleIds.length === 1 ? 'XP-Role' : 'XP-Roles';
                const channelLabel = trackInfo.channelIds.length === 1 ? 'XP-Channel' : 'XP-Channels';
                const requirements = [];

                if (trackInfo.roleIds.length > 0) {
                    requirements.push(`have the specified ${roleLabel}`);
                }

                if (trackInfo.channelIds.length > 0) {
                    requirements.push(`send messages in the specified ${channelLabel}`);
                }

                const requirementText = requirements.length > 0
                    ? `To earn special **${trackInfo.displayName}** XP, you need to ${requirements.join(' and ')} below:`
                    : `No role or channel requirements are configured for this XP track.`;

                const logoPath = path.join(__dirname, '../../images/cc_logo.webp');
                const logoFile = new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' });
                const noDataEmbed = new EmbedBuilder()
                    .setTitle('No XP Data Found!')
                    .setColor(trackInfo.color || '#452366')
                    .setDescription(
                        `${target} has no XP Data for the **${trackInfo.displayName}** XP-track.\n` +
                        `${requirementText}` +
                        `${trackRequirements.description ? `\n${trackRequirements.description}` : ''}`
                    )
                    .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                    .setFooter({ text: 'Crow Control Level System', iconURL: 'attachment://cc_logo.webp' })
                    .setTimestamp();

                if (trackRequirements.fields.length > 0) {
                    noDataEmbed.addFields(trackRequirements.fields);
                }

                if (this.config.db.xpStore?.hasPending(guildId, track, target.id)) {
                    noDataEmbed.addFields({ name: 'XP synchronization',
                        value: 'Recent activity is waiting to sync. Your saved XP will appear after recovery.' });
                }
                await interaction.deleteReply().catch(() => { });
                return interaction.followUp({
                    embeds: [noDataEmbed],
                    files: [logoFile]
                });
            }

            const data = rows[0] || {
                xp_date: null,
                xp_amount: 0,
                level: 0,
                message_xp: 0,
                reaction_xp: 0,
                command_xp: 0,
                voice_xp: 0,
                messages_sent: 0,
                reactions_added: 0,
                commands_used: 0,
                voice_minutes: 0,
                total_messages_sent: 0,
                total_reactions_added: 0,
                total_commands_used: 0,
                total_voice_minutes: 0
            };

            const isMaxLevel = xpSettings.levelFormula.maxLevel && data.level >= xpSettings.levelFormula.maxLevel;
            let xpProgress = '';
            let xpForNextLevel = '';

            if (isMaxLevel) {
                xpProgress = `**${formatNumber(data.xp_amount)}**`;
                xpForNextLevel = '**MAX Level Reached!**';
            } else {
                const totalXpRequiredForNext = xpMath.getTotalXpForLevel(data.level + 1);
                const xpRemainder = totalXpRequiredForNext - data.xp_amount;
                xpProgress = `**${formatNumber(data.xp_amount)} / ${formatNumber(totalXpRequiredForNext)} XP**`;
                xpForNextLevel = `**${formatNumber(xpRemainder)} XP**`;
            }

            const logoPath = path.join(__dirname, '../../images/cc_logo.webp');
            const logoFile = new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' });
            const displayName = capitalizeDisplayName(getDisplayName(targetMember, target));
            const trackingSince = formatTrackingSince(data.xp_date);
            const rankTitle = trackInfo.isGlobal
                ? `${displayName}'s Rank Overview`
                : `${displayName}'s Rank Overview for ${trackInfo.displayName}:`;
            const trackRequirements = !trackInfo.isGlobal ? getTrackRequirementDisplay(trackInfo) : { description: '', fields: [] };

            const rankEmbed = new EmbedBuilder()
                .setTitle(rankTitle)
                .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                .setColor(trackInfo.color || '#452366')
                .addFields(
                    ...trackRequirements.fields,
                    { name: 'Level', value: `**${formatNumber(data.level)}**`, inline: true },
                    { name: 'XP Progress', value: xpProgress, inline: true },
                    { name: 'XP for next Level', value: xpForNextLevel, inline: true },
                    { name: '\u200b', value: '**📊\u2002Detailed Stat Breakdown**', inline: false },
                    { name: '💬\u2002Messages sent       \u200b', value: `- Total: **${formatNumber(data.total_messages_sent)}**\n- XP: **${formatNumber(data.message_xp)}**`, inline: true },
                    { name: '🔥\u2002Reactions added', value: `- Total: **${formatNumber(data.total_reactions_added)}**\n- XP: **${formatNumber(data.reaction_xp)}**`, inline: true },
                    { name: '\u2002', value: '\u2002', inline: false },
                    { name: '🎙️\u2002Voice Chat Hours       \u200b', value: `- Total: **${formatVoiceTime(data.total_voice_minutes)}**\n- XP: **${formatNumber(data.voice_xp)}**`, inline: true },
                    { name: '⌨️\u2002Commands used', value: `- Total: **${formatNumber(data.total_commands_used)}**\n- XP: **${formatNumber(data.command_xp)}**`, inline: true }
                )
                .setFooter({ text: `${trackingSince}`, iconURL: 'attachment://cc_logo.webp' })
                .setTimestamp();

            if (trackRequirements.description) {
                rankEmbed.setDescription(trackRequirements.description);
            }

            if (this.config.db.xpStore?.hasPending(guildId, track, target.id)) {
                rankEmbed.addFields({ name: 'XP synchronization',
                    value: 'Recent activity is waiting to sync. These totals may be behind.' });
            }
            return interaction.editReply({ embeds: [rankEmbed], files: [logoFile] });
        } catch (err) {
            if (this.config.db.isDatabaseUnavailableError?.(err)) {
                return interaction.editReply({ content: 'XP data is temporarily unavailable while the database reconnects. New XP/activity is saved locally and will sync automatically.' });
            }
            console.error('[CC LOG] Rank Command Error:', err);
            return interaction.editReply({ content: 'Error fetching rank data.' });
        }
    }

    async handleAutocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const choices = await fetchXpTrackAutocompleteChoices(this.config.db, focusedValue);
        await interaction.respond(choices).catch(() => { });
    }
}

module.exports = Rank;
