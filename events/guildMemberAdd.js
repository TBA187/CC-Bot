// Welcome new guild members in the configured welcome channel.

const { AttachmentBuilder } = require('discord.js');

module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member, config) {
        try {
            const channel = member.guild.channels.cache.get(config.welcomeChannelID);
            if (!channel || !channel.isTextBased()) return;

            const total = member.guild.memberCount;
            const file = new AttachmentBuilder('./images/cc_banner.webp');

            await channel.send({
                content: `## Hello <@${member.id}>! Welcome to Crow Control! <:dark_murkrow:1565243892255694908>\n` +
                    `### 📜  Have a look at the Guild Rules: <#1246059221280096357>\n` +
                    `### 📌  Familiarize yourself with our Discord channels and roles here: <#1454633218094530700>\n` +
                    `### Enjoy your stay and feel free to ask any questions in <#1301600985655017566>! 👑\n` +
                    `-# **<:dark_murkrow:1565243892255694908> Crow Control** Discord Server has **${total}** members!\n` +
                    `_ _`,
                files: [file]
            });
        } catch (err) {
            console.error('Welcome message failed:', err);
        }
    }
}
