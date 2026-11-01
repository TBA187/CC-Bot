// Lists the PvP King commands and the server channels where members can use them.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerLogo, createPvpFooter } = require('./utils/pvpAssets.js');

class PvPKingHelp {
    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_help";
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.data = new SlashCommandBuilder()
            .setName('pvp_help')
            .setDescription('View all PvP King commands and their descriptions');
    }

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle(`👑\u2002PvP King Bot Commands — ${this.pvpServerName}\u2002👑`)
            .setDescription(
                `## ${this.pvpServerEmoji} ${this.pvpServerName} Server\nUse the PvP King commands in <#${this.pvpKingChannelID}>\nBrowse all PvP King commands with the **\`/pvp\`** prefix.\n` +
                `## Command List:\n` +
                `### 📜\u2002/pvp_rules\n- Rules and Information about the PvP King Challenge System\n` +
                `### ⚔️\u2002/pvp_challenge\n- Send a challenge request to the current PvP King\n   - When the PvP King accepts your challenge, you'll receive a **48-hour cooldown** against this PvP King\n` +
                `### ⏱️ /pvp_cooldown\n- Check your cooldown status against the current PvP King\n   - You can also enable/disable **Cooldown Notifications! 🔔**\n` +
                `### <:pepe_king:1455434151262949535>\u2002/pvp_current_king\n- Show the current PvP King\n` +
                `### 🏆\u2002/pvp_leaderboard\n- Display all PvP Kings — Crow Control Hall of Fame!\n` +
                `### 📊\u2002/pvp_stats\n- Display PvP King stats for a user\n` +
                `### 📚\u2002/pvp_history\n- History of all PvP King entries\n` +
                `### ⭐ /pvp_event\n- View the finished PvP King Event results for this server\n` +
                `### 🥇 /pvp_crown\u2002—\u2002Officers only 🔒\n- Crown a new PvP King 👑 or record a Throne defense 🛡️\n` +
                `### 🔄\u2002/pvp_reverse\u2002—\u2002Officers only 🔒\n- Undo the most recent PvP Crown event and restore data for the previous/current PvP King`
            )
            .setColor(this.pvpServerColor)
            .setThumbnail('attachment://cc_logo.webp')
            .setFooter(createPvpFooter(this.pvpServerName))
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            files: [getServerLogo()]
        });
        
        // // Loop through all commands
        // for (const command of this.commandMap.values()) {
        //     if (!command.data) continue;

        //     // Handle slash commands
        //     if (!Array.isArray(command.data)) {
        //         embed.addFields({
        //             name: `/${command.data.name}`,
        //             value: command.data.description || 'No description provided',
        //             inline: false
        //         });
        //     }

        //     // Handle context menu commands
        //     if (Array.isArray(command.data)) {
        //         for (const ctx of command.data) {
        //             embed.addFields({
        //                 name: `${ctx.name}`,
        //                 value: 'Context Menu Command',
        //                 inline: false
        //             });
        //         }
        //     }
        // }
    }
}

module.exports = wrapPvpServerCommand(PvPKingHelp);
