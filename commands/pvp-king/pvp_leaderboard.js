// Displays a sortable, paginated Hall of Fame for the selected PvP server.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} = require('discord.js');

class PvpLeaderboard {
    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_leaderboard";
        this.db = config.pvpKingStorage || config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.historyThreadID = config.historyThreadID;
        this.data = new SlashCommandBuilder()
            .setName('pvp_leaderboard')
            .setDescription('Display all PvP Kings — Crow Control Hall of Fame!');
    }

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Fetch ALL records
            const rows = await this.db.listStats();

            if (rows.length === 0) {
                return interaction.editReply(`### 📜 The Hall of Fame in ${this.pvpServerName} is currently empty!`);
            }

            // Count Total PvP Kings
            const total_kings = await this.db.countStats('total_kings');

            // Count all PvP King entries and keep the latest history row as a display fallback.
            const historyInfo = await this.db.getHistoryInfo();
            const totalKingEntries = historyInfo?.totalKingEntries || 0;

            // Do not fetch all guild members here; opcode 8 member chunks are heavily rate limited.
            // The commands that need strict role validation refresh members themselves.
            const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
            const cachedKings = kingRole?.members;
            let currentKingId = cachedKings?.size === 1 ? cachedKings.first().id : null;
            if (!currentKingId && historyInfo?.latestKingId) {
                currentKingId = String(historyInfo.latestKingId);
            }
            const currentKingText = currentKingId ? `<@${currentKingId}>` : '*No current PvP King found*';

            // Pagination & Sorting State
            const itemsPerPage = 10;
            const totalPages = Math.ceil(rows.length / itemsPerPage);
            let currentPage = 0;
            let currentSort = 'total_wins';
            let sortedRows = [...rows];

            const applySort = () => {
                if (currentSort === 'total_wins') {
                    // Highest total wins -> Highest streak -> First crowned (oldest first)
                    sortedRows.sort((a, b) => (b.total_wins - a.total_wins) || (b.longest_streak - a.longest_streak) || (a.first_crowned - b.first_crowned));
                } else if (currentSort === 'longest_streak') {
                    // Highest streak -> Highest total wins -> First crowned (oldest first)
                    sortedRows.sort((a, b) => (b.longest_streak - a.longest_streak) || (b.total_wins - a.total_wins) || (a.first_crowned - b.first_crowned));
                } else if (currentSort === 'first_crowned_asc') {
                    // Oldest victories first (Oldest ➔ Newest)
                    sortedRows.sort((a, b) => a.first_crowned - b.first_crowned);
                } else if (currentSort === 'crowned_at_asc') {
                    // Newest victories first (Newest ➔ Oldest)
                    sortedRows.sort((a, b) => b.crowned_at - a.crowned_at);
                }
            };

            applySort();

            const generateEmbed = (page) => {
                const start = page * itemsPerPage;
                const end = start + itemsPerPage;
                const currentItems = sortedRows.slice(start, end);
                const embed = new EmbedBuilder()
                    .setColor(this.pvpServerColor)
                    .setThumbnail(interaction.guild.iconURL())
                    .setTimestamp()
                    .setFooter({
                        text: `CC PvP King System • ${this.pvpServerName} • Page ${page + 1} of ${totalPages}`,
                        iconURL: interaction.guild.iconURL()
                    });

                const sortTitles = {
                    'longest_streak': { emoji: '🔥', title: 'Longest Streak' },
                    'total_wins': { emoji: '⚔️', title: 'Total Wins' },
                    'first_crowned_asc': { emoji: '📜', title: 'First Victories (Oldest ➔ Newest)' },
                    'crowned_at_asc': { emoji: '✨', title: 'Last Victories (Newest ➔ Oldest)' }
                };
                const activeSort = sortTitles[currentSort] || sortTitles.total_wins;

                let descriptionText = `## 🏆\u2002Crow Control — PvP Hall of Fame in ${this.pvpServerName}\u2002🏆\n` +
                    `**In the grip of endless winter, \`${total_kings}\` PvP Kings stand frozen in time, their legacy etched in ice forever!\u2002🧊**\n` +
                    `-# - **Current PvP King:\u2002👑\u2002${currentKingText}\u2002👑**\n` +
                    `-# - Challenge the current PvP King with: **\`/pvp_challenge\`**\n` +
                    `### PvP Kings sorted by\u2002${activeSort.emoji}\u2002${activeSort.title}:\n`;

                currentItems.forEach((row, index) => {
                    const overallIndex = start + index;
                    const unixFirst = Math.floor(row.first_crowned / 1000);
                    const unixLast = Math.floor(row.crowned_at / 1000);

                    // Check if this row is the current king
                    const isCurrentKing = String(row.user_id) === currentKingId;
                    const crownLabel = isCurrentKing ? " 👑" : "";

                    const rankMedal = overallIndex === 0 ? "🥇" : overallIndex === 1 ? "🥈" : overallIndex === 2 ? "🥉" : `**${overallIndex + 1}.**`;

                    descriptionText += `${rankMedal} **${row.king_name}**${crownLabel}\n` +
                        `└ First Victory:\u2002<t:${unixFirst}:d>\u2002—\u2002Last Victory:\u2002<t:${unixLast}:d>\n` +
                        `└ Longest Streak:\u2002\`${row.longest_streak}\`\u2002🔥 \u2002—\u2002  Total Wins:\u2002\`${row.total_wins}\`\u2002⚔️\n\n`;
                });

                if (this.historyThreadID) {
                    descriptionText += `-# View all \`${totalKingEntries}\` PvP King entries in <#${this.historyThreadID}>\n`;
                }

                embed.setDescription(descriptionText);
                return embed;
            };

            const generateComponents = (page, isDisabled = false) => {
                const sortRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('sort_menu')
                        .setPlaceholder(isDisabled ? `🚫 Session Expired! — Run '/pvp_leaderboard' again` : 'Sort the Leaderboard...')
                        .setDisabled(isDisabled)
                        .addOptions([
                            { label: 'Total Wins', description: 'Sort by Total Wins', value: 'total_wins', emoji: '⚔️' },
                            { label: 'Longest Streak', description: 'Sort by Highest Streaks', value: 'longest_streak', emoji: '🔥' },
                            { label: 'Oldest Kings', description: 'Sort by First Victories (Oldest ➔ Newest)', value: 'first_crowned_asc', emoji: '📜' },
                            { label: 'Newest Kings', description: 'Sort by Recent Victories (Newest ➔ Oldest)', value: 'crowned_at_asc', emoji: '✨' }
                        ])
                );

                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('prev_page')
                        .setLabel('◀ Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(isDisabled || page === 0),
                    new ButtonBuilder()
                        .setCustomId('next_page')
                        .setLabel('Next ▶')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(isDisabled || page === totalPages - 1)
                );

                return totalPages > 1 ? [sortRow, buttonRow] : [sortRow];
            };

            const message = await interaction.editReply({
                embeds: [generateEmbed(currentPage)],
                components: generateComponents(currentPage)
            });

            // Set collector for 24 hours (86,400,000 ms)
            const collector = message.createMessageComponentCollector({
                time: 86400000
            });

            collector.on('collect', async (i) => {
                try {
                    if (i.user.id !== interaction.user.id) {
                        return await i.reply({
                            content: "### ⚠️  Use the `/pvp_leaderboard` command to open your own menu.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    if (i.isStringSelectMenu()) {
                        currentSort = i.values[0];
                        currentPage = 0;
                        applySort();
                    } else if (i.isButton()) {
                        // A second click can arrive before Discord displays the disabled button.
                        if (i.customId === 'prev_page') currentPage = Math.max(0, currentPage - 1);
                        if (i.customId === 'next_page') currentPage = Math.min(totalPages - 1, currentPage + 1);
                    }

                    await i.update({
                        embeds: [generateEmbed(currentPage)],
                        components: generateComponents(currentPage)
                    });

                    collector.resetTimer();
                } catch (error) {
                    console.warn('[CC LOG] PvP leaderboard control failed:', error.code || error.name);
                }
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
                    : '### ⚠️ Failed to load the PvP King Hall of Fame!'
            }).catch(() => { });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpLeaderboard);
