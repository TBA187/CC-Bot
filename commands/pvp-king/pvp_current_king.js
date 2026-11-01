// Displays the current PvP King and their recorded wins.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');
const { formatNowMinute, resolveSinglePvpKing, stopIfOnCooldown } = require('./utils/pvpHelper.js');

class PvpCurrentKing {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_current_king";
        this.db = config.pvpKingStorage || config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.ownerID = config.ownerID;
        this.logChannelID = config.logChannelID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_current_king')
            .setDescription('Show the current PvP King');
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        await interaction.deferReply();

        try {
            const kingCheck = await resolveSinglePvpKing(interaction, {
                pvpKingRoleID: this.pvpKingRoleID,
                logChannelID: this.logChannelID,
                ownerID: this.ownerID,
                now: formatNowMinute(),
                contextLabel: '/pvp_current_king',
                missingRoleReply: '### ❌ PvP King role not found! Officers have been notified and will resolve the issue as soon as possible.',
                noKingReply: '### ⚠️ No PvP King found! Officers have been notified and will resolve the issue as soon as possible.',
                multipleKingsReply: '### ⚠️ Multiple PvP Kings detected! Officers have been notified and will resolve the issue as soon as possible.'
            });
            if (!kingCheck.ok) return;

            const currentKing = kingCheck.currentKing;

            // Get PvP King stats from DB
            const stats = await this.db.getStats(currentKing.id);

            const totalWins = stats?.total_wins || 0;
            const currentStreak = stats?.current_streak || 0;
            const longestStreak = stats?.longest_streak || 0;
            const firstCrowned = stats?.first_crowned ? `<t:${Math.floor(new Date(stats?.first_crowned).getTime() / 1000)}:F>` : '*Never*';
            const lastCrowned = stats?.crowned_at ? `<t:${Math.floor(new Date(stats?.crowned_at).getTime() / 1000)}:F>` : '*Never*';
            const embed = new EmbedBuilder()
                .setTitle(`<:dark_murkrow:1565243892255694908>\u2002Crow Control PvP King — ${this.pvpServerName} ${this.pvpServerEmoji}`)
                .setDescription(`## 👑\u2002<@${currentKing.id}>\u2002👑`)
                .addFields(
                    { name: `🔥\u2002 Current Win Streak:\u2002${currentStreak}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002 Longest Streak:\u2002${longestStreak}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002 Total Wins:\u2002${totalWins}`, value: '\u2002', inline: false },
                    { name: `🥇\u2002 First Victory:\u2002${firstCrowned}`, value: '\u2002', inline: false },
                    { name: `<:pepe_king:1455434151262949535>\u2002 Last Victory:\u2002${lastCrowned}`, value: '\u2002', inline: false },
                    { name: '\u2002', value: '\u2002', inline: false },
                    { name: '\u2002', value: `- Challenge <@${currentKing.id}> with the \`/pvp_challenge\` command!`, inline: false },
                    { name: '\u2002', value: '\u2002', inline: false }
                )
                .setColor(this.pvpServerColor)
                .setThumbnail(currentKing.displayAvatarURL())
                .setFooter(createPvpFooter(this.pvpServerName))
                .setTimestamp();

            return interaction.editReply({
                embeds: [embed],
                files: [getServerLogo()]
            });
        } catch (err) {
            console.error(err);
            const message = err.code === 'PVP_DATABASE_UNAVAILABLE'
                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                : '### ⚠️ Database error.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpCurrentKing);
