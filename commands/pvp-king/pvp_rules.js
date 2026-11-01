// Shows the PvP King rules.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');

class PvPKingRules {
    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_rules";
        this.officerRoleID = config.officerRoleID;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.pvpWarriorRoleID = config.pvpWarriorRoleID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.historyThreadID = config.historyThreadID;
        this.data = new SlashCommandBuilder()
            .setName('pvp_rules')
            .setDescription('Rules & Info about the PvP King Challenge System');
    }

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const imagePath = path.join(__dirname, '../../images/cc_logo.webp');
            const ccLogo = new AttachmentBuilder(imagePath, { name: 'cc_logo.webp' });

            const rulesEmbed = new EmbedBuilder()
                .setTitle('❄️ The Long Night Awaits ❄️')
                .setDescription(`The **PvP King Challenge** is Crow Control ultimate test of strength. Each server has its own PvP King. One King holds this server's PvP Crown. Do you have the steel to seize the throne?\n` +
                    `### ⚔️ How to Challenge\n` +
                    `Head over to <#${this.pvpKingChannelID}> and use the command:\n` +
                    `> **/pvp_challenge**\n` +
                    `-# ⏳ Once the PvP King **Accepts** your challenge, a **48-hour cooldown** is applied between you and that King.\n` +
                    `-# Cooldowns are tied to the **PvP King**, not the Throne! If a new King is crowned, your cooldown resets instantly and you may challenge the new King.` +
                    ` Additionally, when a new PvP King is crowned, the former King is subject to a 48-hour cooldown against the new King. This prevents repeated back-and-forth challenges between the former and current Kings.\n\n` +
                    `## 📜 Royal Decree (Rules)\n` +
                    `- Toxicity is a fast - track to the Wall. Keep it respectful!\n` +
                    `- All matches follow PRO's **Normal Ranked PvP Rules**. It is a **Best-of-1** (Single Match) to decide the fate of the Crown.\n` +
                    `- Matches do not have to be streamed, but a **Screenshot of the results** must be posted in <#${this.pvpKingChannelID}>\n` +
                    `- Tag an <@&${this.officerRoleID}> after your match to be Crowned.\n` +
                    `- Even if the King defends the throne, post the results! We track **Winning Streaks** 🔥 to honor our greatest champions.\n` +
                    `- The PvP King may decline a challenge with a valid reason. However, should a challenge go ignored for **48 hours**, the King shall be deemed to have **Forfeited**, and the Crown will pass automatically to the first challenger!\n` +
                    `- All PvP Kings are reborn in the eternal frost, claiming the <@&${this.pvpWarriorRoleID}> role as tribute to the **Crow Control** legion!\n` +
                    `- Only **One King** can hold the <@&${this.pvpKingRoleID}> role at a time!\n\u200b`)
                .setColor(this.pvpServerColor)
                .addFields(
                    { name: '❄️ Commands of the Cold', value: `\`/pvp_help\``, inline: true },
                    { name: '🧊 The Frozen Records', value: `<#${this.historyThreadID}>`, inline: true },
                )
                .setThumbnail('attachment://cc_logo.webp')
                .setFooter({ text: `CC PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                .setTimestamp();

            await interaction.editReply({
                content: `## 📜  Crow Control PvP King Challenge Rules — ${this.pvpServerName} ${this.pvpServerEmoji}`,
                embeds: [rulesEmbed],
                files: [ccLogo]
            });

        } catch (error) {
            console.error("Error sending rules:", error);
            await interaction.editReply({ content: "### ❌ Failed to load the rules. Please contact an admin." });
        }
    }
}

module.exports = wrapPvpServerCommand(PvPKingRules);
