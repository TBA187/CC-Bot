// Welcomes a newly joined Discord guild member.
const { SlashCommandBuilder, MessageFlags, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');

class Welcome {
    constructor(config) {
        this.name = "welcome";
        this.data = new SlashCommandBuilder()
            .setName('welcome')
            .setDescription('Welcome a guild member to the Discord server')
            .addUserOption(o =>
                o.setName('user').setDescription('Select a member to welcome').setRequired(true)
            );
    }

    async execute(interaction) {
        const member = interaction.options.getMember('user');
        if (!member) {
            return interaction.reply({ content: '### ❌  User not found.', flags: MessageFlags.Ephemeral });
        }

        const total = interaction.guild.memberCount;
        const logoPath = path.join(process.cwd(), 'images', 'cc_logo.webp');
        const logoAttachment = new AttachmentBuilder(logoPath, { name: 'cc_logo.webp' });

        const welcomeEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setThumbnail(member.displayAvatarURL({ size: 256 }))
            .setDescription(
                `📜\u2002**Guild Rules:** <#1246059221280096357>\n` +
                `📑\u2002**Discord Information:** <#1454633218094530700>\n` +
                `📢\u2002**Guild Announcements:** <#1180559473501290688>\n\n` +
                `- **Introduce yourself to the guild in** <#1180559477519437947>\n` +
                `- **Get yourself some roles in** <#1184121209609269409>\n` +
                `- **Feel free to ask any PvP questions in** <#1345014095103135825>\n` +
                `- **Get help building your PvP team in** <#1180559466555527309>\n` +
                `- **Arrange Dungeon runs in** <#1199781504545472512>\n` +
                `- **Participate in our PvP King mini-games:**\n` +
                `  - <:gold:1555743525759356948> **Gold:** <#1469101041189523657>\n` +
                `  - <:silver:1555743603567886478> **Silver:** <#1557472327560732713>\n` +
                `  - *Read Channel description for more info*\n\n` +
                `**If you have any questions, feel free to ask in <#1301600985655017566> or send a DM to an Officer. Enjoy your stay!** <:man_of_culture:1186287184106496112>`
            )
            .setFooter({
                text: `Crow Control Server  •  ${total} members`,
                iconURL: 'attachment://cc_logo.webp'
            })
            .setTimestamp();

        await interaction.reply({
            content: `### <:dark_murkrow:1565243892255694908>  Welcome to Crow Control, <@${member.id}> — We're happy to have you here!  🎉`,
            embeds: [welcomeEmbed],
            files: [logoAttachment]
        });
    }
}

module.exports = Welcome;
