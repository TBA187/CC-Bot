// Shows each server's configured PvP event or the preserved finished event results.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { configuredEvent, loadEventResults, configuredEventSummary, utcEventDate } = require('./utils/pvpEvent.js');

// Vangogsan's eighth consecutive event victory is recorded in Gold history
// at this UTC time. The finished event is shared; each leaderboard reads only
// its own server's history up to the closing victory.
const PVP_KING_EVENT = Object.freeze({
    name: "Vangogsan's PvP King Event",
    startDate: '2026-05-06 01:00:00',
    endDate: '2026-07-10 08:56:20',
    targetStreak: 8,
    rewardCoinCapsules: 23,
    winnerId: '632207715229368349',
    winnerName: 'Vangogsan'
});

function completedEventSummary() {
    const event = PVP_KING_EVENT;
    const endTime = Math.floor(new Date(`${event.endDate}Z`).getTime() / 1000);
    return `## ⚔️ ${event.name} — Finished\n`
        + `### 🥇 Event Winner: <@${event.winnerId}> (${event.winnerName})\n`
        + `### 🏆 Requirement: ${event.targetStreak} wins in a row\n`
        + `### 🎁 Reward: ${event.rewardCoinCapsules} Coin Capsules\n`
        + `-# Finished: <t:${endTime}:F>. Later victories do not count towards this event.\n`;
}

class PvpEvent {
    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_event";
        this.db = config.pvpKingStorage || config.db;
        this.eventConfig = config;
        this.data = new SlashCommandBuilder()
            .setName('pvp_event')
            .setDescription("View the finished PvP King Event results");
    }

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const configured = configuredEvent(this.eventConfig);
            const results = configured ? await loadEventResults(this.db, configured) : null;
            const event = results?.event || PVP_KING_EVENT;
            const historyRows = results?.history || await this.db.eventHistorySince(event.startDate, event.endDate);
            const summary = configured ? configuredEventSummary(event) : completedEventSummary();

            if (historyRows.length === 0) {
                return interaction.editReply({
                    content: summary
                        + `\nNo event victories were recorded for **${this.pvpServerName}**.`
                });
            }

            let currentTempKing = null;
            let currentStreak = 0;
            const eventStats = new Map();

            for (const row of historyRows) {
                if (currentTempKing === row.king_id) {
                    currentStreak += 1;
                } else {
                    currentTempKing = row.king_id;
                    currentStreak = 1;
                }

                if (!eventStats.has(row.king_id)) {
                    eventStats.set(row.king_id, {
                        king_id: row.king_id,
                        king_name: row.king_name,
                        total_wins: 0,
                        best_streak: 0, // Highest they ever reached
                        active_streak: 0, // Their current ongoing streak
                        first_crowned: row.created_at,
                        last_win: row.created_at
                    });
                }

                const userStat = eventStats.get(row.king_id);
                userStat.total_wins += 1;
                userStat.last_win = row.created_at;

                // Reset everyone else's active streak to 0 because someone else took the crown
                for (let [id, stats] of eventStats) {
                    if (id !== row.king_id) stats.active_streak = 0;
                }

                // Update the current person's active and best streaks
                userStat.active_streak = currentStreak;
                if (currentStreak > userStat.best_streak) {
                    userStat.best_streak = currentStreak;
                }
            }


            // Sort logic: 1. Show current King always at top, 2. Total Wins, 3. Best Streak, 4. Date Crowned
            const sortedRows = Array.from(eventStats.values()).sort((a, b) => {
                if (a.king_id === event.winnerId && b.king_id !== event.winnerId) return -1;
                if (b.king_id === event.winnerId && a.king_id !== event.winnerId) return 1;

                // 2. Secondary: Total Wins
                if (b.total_wins !== a.total_wins) {
                    return b.total_wins - a.total_wins;
                }

                // 3. Tertiary: Best Streak ever achieved
                if (b.best_streak !== a.best_streak) {
                    return b.best_streak - a.best_streak;
                }

                // 4. Final: Who got their first win earliest?
                return utcEventDate(a.first_crowned) - utcEventDate(b.first_crowned);
            });

            const itemsPerPage = 10;
            const totalPages = Math.ceil(sortedRows.length / itemsPerPage);
            let currentPage = 0;

            const generateEmbed = (page) => {
                const start = page * itemsPerPage;
                const end = start + itemsPerPage;
                const currentItems = sortedRows.slice(start, end);

                const embed = new EmbedBuilder()
                    .setColor(this.pvpServerColor)
                    .setThumbnail(interaction.guild.iconURL())
                    .setTimestamp()
                    .setFooter({
                        text: `${event.winnerId ? 'Finished Event' : 'PvP King Event'} • ${this.pvpServerName} • Page ${page + 1} of ${totalPages}`,
                        iconURL: interaction.guild.iconURL()
                    });

                let descriptionText = summary
                    + `-# ${this.pvpServerEmoji} Event results for **${this.pvpServerName}**.\n\n`
                    + `## <:pepe_king:1455434151262949535> PvP Event Kings:\n\n`;

                currentItems.forEach((row, index) => {
                    const overallIndex = start + index;
                    const unixLast = Math.floor(utcEventDate(row.last_win).getTime() / 1000);
                    const crownLabel = row.king_id === event.winnerId ? ' 👑' : '';
                    const eventWinnerMedal = row.king_id === event.winnerId ? "\n🌟 **[EVENT WINNER]** 🌟" : '';
                    const rankMedal = overallIndex === 0 ? "🥇" : overallIndex === 1 ? "🥈" : overallIndex === 2 ? "🥉" : `**${overallIndex + 1}.**`;

                    const streakText = `**└ Best Event Streak: \`${row.best_streak}/${event.targetStreak}\` 🔥**\n`;

                    descriptionText += `${rankMedal} **${row.king_name}**${crownLabel} ${eventWinnerMedal}\n` +
                        streakText +
                        `└ Total Event Wins:\u2002\`${row.total_wins}\`\u2002⚔️\n` +
                        `└ Last Victory:\u2002<t:${unixLast}:R>\n\n`;
                });

                embed.setDescription(descriptionText);
                return embed;
            };

            const generateComponents = (page, isDisabled = false) => {
                return [new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page_evt')
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isDisabled || page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page_evt')
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isDisabled || page === totalPages - 1)
                )];
            };

            const message = await interaction.editReply({
                embeds: [generateEmbed(currentPage)],
                components: totalPages > 1 ? generateComponents(currentPage) : []
            });

            if (totalPages <= 1) return;

            const collector = message.createMessageComponentCollector({ time: 300000 });

            collector.on('collect', async (i) => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({
                        content: "### ⚠️ Use `/pvp_event` to open your own menu.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (i.customId === 'prev_page_evt') currentPage--;
                if (i.customId === 'next_page_evt') currentPage++;

                await i.update({
                    embeds: [generateEmbed(currentPage)],
                    components: generateComponents(currentPage)
                });
            });

            collector.on('end', () => {
                interaction.editReply({
                    components: generateComponents(currentPage, true)
                }).catch(() => { });
            });

        } catch (err) {
            console.error(err);
            interaction.editReply({
                content: err.code === 'PVP_DATABASE_UNAVAILABLE'
                    ? '### ⚠️ Database is currently unavailable. Please try again later.'
                    : '### ⚠️ Failed to load the Event Leaderboard!'
            }).catch(() => { });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpEvent);

module.exports.PVP_KING_EVENT = PVP_KING_EVENT;
