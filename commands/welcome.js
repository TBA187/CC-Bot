// Welcomes a newly joined Discord guild member.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

class Welcome {
    constructor(config) {
        this.name = "welcome";
        this.data = new SlashCommandBuilder()
            .setName('welcome')
            .setDescription('Welcome a guild member to the Discord server')
            .addUserOption(o =>
                o.setName('user').setDescription('Select member to welcome').setRequired(true)
            );
    }

    async execute(interaction) {
        const member = interaction.options.getMember('user');
        if (!member) {
            return interaction.reply({ content: '### ❌  User not found.', flags: MessageFlags.Ephemeral });
        }

        await interaction.reply(
            `## 🎉  Welcome to Crow Control, <@${member.id}> — We're happy to have you here!  🎉\n` +
            `### 📜 **Guild Rules:** <#1246059221280096357>\n` +
            `### 📑 **Discord Information:** <#1454633218094530700>\n` +
            `### 📢 **Guild Announcements:** <#1180559473501290688>\n_ _\n` +
            `- <#1180559477519437947> — Introduce yourself to the guild\n` +
            `- <#1184121209609269409> — Get yourself some roles (You can select multiple roles)\n` +
            `- <#1345014095103135825> & <#1180559466555527309> — Feel free to ask any PvP related questions here\n` +
            `- <#1469101041189523657> — Participate in our PvP King competition (Read Channel description for more info)\n` +
            `### If you have any questions, feel free to ask in <#1301600985655017566> or send a DM to an Offcier!`
        );
    }
}

module.exports = Welcome;
