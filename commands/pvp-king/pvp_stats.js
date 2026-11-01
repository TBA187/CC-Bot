// Shows a member's crown, defense and streak statistics for the selected PvP server.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');
const { replyMissingMemberOption, stopIfOnCooldown } = require('./utils/pvpHelper.js');

function formatWinTimesTxt(count) {
    return `${count} ${count === 1 ? 'time' : 'times'}`;
}

class PvpStats {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_stats";
        this.db = config.pvpKingStorage || config.db;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_stats')
            .setDescription('Show PvP King stats for a user')
            .addUserOption(o =>
                o.setName('user')
                    .setDescription('Select user')
                    .setRequired(true)
            );
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'stats', 2)) return;

        const user = interaction.options.getUser('user');
        const member = await replyMissingMemberOption(interaction, 'user', '❌ User not found!');
        const name = member ? member.displayName : user.username;
        if (!member) return;

        await interaction.deferReply();

        try {
            const stats = await this.db.getStats(user.id);

            if (!stats) {
                return interaction.editReply(
                    `### 📈  No PvP King data in ${this.pvpServerName} found for ${name}\n`
                );
            }

            const eventCounts = await this.db.getHistoryEventCounts(user.id);
            const firstCrowned = stats.first_crowned ? `<t:${Math.floor(new Date(stats.first_crowned).getTime() / 1000)}:F>` : '*Never*';
            const lastCrowned = stats.crowned_at ? `<t:${Math.floor(new Date(stats.crowned_at).getTime() / 1000)}:F>` : '*Never*';
            const embed = new EmbedBuilder()
                .setTitle(`Crow Control PvP King Stats — ${this.pvpServerName} ${this.pvpServerEmoji}`)
                .setDescription(`### 📈\u2002PvP Stats for <@${user.id}>`)
                .addFields(
                    { name: `🔥\u2002Current Win Streak:\u2002${stats.current_streak ?? 0}`, value: '', inline: false },
                    { name: `⚔️\u2002Longest Streak:\u2002${stats.longest_streak ?? 0}`, value: '', inline: false },
                    {
                        name: `🏆\u2002Total Wins:\u2002${stats.total_wins ?? 0}`,
                        value:
                            `-# └ 👑\u2002Crowned as King: **${formatWinTimesTxt(eventCounts.crown)}**\n` +
                            `-# └ 🛡️\u2002Defended Throne: **${formatWinTimesTxt(eventCounts.defense)}**`,
                        inline: false
                    },
                    { name: `🥇\u2002First Victory:\u2002${firstCrowned}`, value: '', inline: false },
                    { name: `<:pepe_king:1455434151262949535>\u2002Last Victory:\u2002${lastCrowned}`, value: '', inline: false }
                )
                .setColor(this.pvpServerColor)
                .setThumbnail(user.displayAvatarURL())
                .setFooter(createPvpFooter(this.pvpServerName))
                .setTimestamp();

            await interaction.editReply({
                embeds: [embed],
                files: [getServerLogo()]
            });
        } catch (err) {
            console.error(err);
            const message = err.code === 'PVP_DATABASE_UNAVAILABLE'
                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                : '### ⚠️ Failed to retrieve stats.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpStats);
