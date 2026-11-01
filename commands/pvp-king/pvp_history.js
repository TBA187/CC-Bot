// Displays recent PvP reigns, combining consecutive defenses by the same King.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { stopIfOnCooldown } = require('./utils/pvpHelper.js');
const { splitMessageParts } = require('./utils/pvpMessages.js');

class PvpHistory {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_history";
        this.db = config.pvpKingStorage || config.db;
        this.historyThreadID = config.historyThreadID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_history')
            .setDescription('History of PvP Kings')
            .addIntegerOption(o =>
                o.setName('amount')
                    .setDescription('How many recent entries? (default 10, max 15)')
                    .setMinValue(1)
                    .setMaxValue(15)
            );
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        await interaction.deferReply();

        try {
            const amount = interaction.options.getInteger('amount') ?? 10;

            // Count Total PvP Kings
            const totalKings = await this.db.countStats();

            // Fetch latest 500 entries from history
            const rowsDesc = await this.db.historyAscending(500);

            // Count all PvP King entries
            const totalKingEntries = await this.db.countHistory();

            if (!rowsDesc.length) {
                return interaction.editReply(`### ⚠️ No PvP King history found for ${this.pvpServerName} ${this.pvpServerEmoji}`);
            }

            // Remove consecutive duplicates and take last streak/wins in block
            const displayRows = [];
            let i = 0;
            while (i < rowsDesc.length) {
                const currentUserId = rowsDesc[i].king_id;
                let firstRow = rowsDesc[i];
                let lastRowIndex = i;

                // Find last consecutive row for this user
                for (let j = i + 1; j < rowsDesc.length; j++) {
                    if (rowsDesc[j].king_id === currentUserId) lastRowIndex = j;
                    else break;
                }

                const lastRow = rowsDesc[lastRowIndex];

                displayRows.push({
                    king_id: lastRow.king_id,
                    king_name: lastRow.king_name,
                    created_at: firstRow.created_at,
                    total_wins_after: lastRow.total_wins_after,
                    streak_after: lastRow.streak_after,
                });

                i = lastRowIndex + 1;
            }

            // Fetch 'amount' history entries to show
            const historyRows = displayRows.slice(-(amount + 1));
            const currentKing = historyRows.pop(); // remove newest entry (current king)

            // All King entries
            const entries = historyRows.map(r => {
                const time = r.created_at
                    ? `<t:${Math.floor(new Date(r.created_at).getTime() / 1000)}:F>`
                    : '*Error loading time!*';

                return `- 🏆  ${time}  **—  👑  ${r.king_name}  👑  —  Streak during reign:  ${r.streak_after}   |  Total Wins:  ${r.total_wins_after}**`;
            });

            // Always show the last record in DB as current king
            const lastTime = currentKing.created_at
                ? `<t:${Math.floor(new Date(currentKing.created_at).getTime() / 1000)}:F>`
                : '*Error loading time!*';

            entries.push(
                `\n## 👑  ${currentKing.king_name} is the current PvP King  👑  —  Crowned: ${lastTime}\n` +
                `       **→ Current Streak:  ${currentKing.streak_after}  🔥**\n` +
                `       **→ Total Wins:  ${currentKing.total_wins_after}  🏆**`
            );

            const messages = splitMessageParts([
                `# 👑  PvP King History in ${this.pvpServerName} (Last ${historyRows.length} entries)  👑\n` +
                `**<:pepe_king:1455434151262949535>  ${totalKings} individual PvP Kings have ruled Crow Control so far! View all PvP Kings with the \`/pvp_leaderboard\` command.**\n\n`,
                ...entries.map((entry, index) => (index ? '\n' : '') + entry),
                `\n\n### View all \`${totalKingEntries}\` PvP King entries in <#${this.historyThreadID}>`
            ], '');
            await interaction.editReply({ content: messages[0], allowedMentions: { parse: [] } });
            for (const content of messages.slice(1)) {
                await interaction.followUp({ content, allowedMentions: { parse: [] } });
            }

        } catch (err) {
            console.error(err);
            const message = err.code === 'PVP_DATABASE_UNAVAILABLE'
                ? '### ⚠️ Database is currently unavailable. Please try again later.'
                : '### ⚠️ Failed to fetch history.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpHistory);
