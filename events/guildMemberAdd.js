// Welcome new guild members in the configured welcome channel.

const {
    MessageFlags,
    AttachmentBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize
} = require('discord.js');
const path = require('path');

module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member, config) {
        try {
            const channel = member.guild.channels.cache.get(config.welcomeChannelID);
            if (!channel || !channel.isTextBased()) return;

            const total = member.guild.memberCount;
            const bannerPath = path.join(process.cwd(), 'images', 'cc_banner.webp');
            const bannerAttachment = new AttachmentBuilder(bannerPath, { name: 'cc_banner.webp' });

            const welcomeHeader = new TextDisplayBuilder()
                .setContent(`### <:dark_murkrow:1565243892255694908>  Welcome to Crow Control, <@${member.id}> — We're happy to have you here!  🎉`);

            const mainSection = new SectionBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `📜\u2002**Guild Rules:** <#1246059221280096357>\n` +
                        `📑\u2002**Discord Information:** <#1454633218094530700>\n` +
                        `📢\u2002**Guild Announcements:** <#1180559473501290688>\n\n` +
                        `If you have any questions, feel free to ask in <#1301600985655017566> or send a DM to an Officer. **Enjoy your stay!** <:man_of_culture:1186287184106496112>`
                    )
                )
                .setThumbnailAccessory(
                    new ThumbnailBuilder()
                        .setURL(member.displayAvatarURL({ size: 256 }))
                        .setDescription(`${member.user.username}'s avatar`)
                );

            const bannerGallery = new MediaGalleryBuilder()
                .addItems(
                    new MediaGalleryItemBuilder().setURL('attachment://cc_banner.webp')
                );

            const footerSeparator = new SeparatorBuilder()
                .setDivider(true)
                .setSpacing(SeparatorSpacingSize.Small);

            const timestamp = Math.floor(Date.now() / 1000);
            const footerText = new TextDisplayBuilder()
                .setContent(`-# <:crow_control:1571743936697860127>\u2002Crow Control Server\u2002**•**\u2002**${total}** members\u2002**•**\u2002<t:${timestamp}:f>`);

            const welcomeContainer = new ContainerBuilder()
                .setAccentColor(0x452366)
                .addSectionComponents(mainSection)
                .addMediaGalleryComponents(bannerGallery)
                .addSeparatorComponents(footerSeparator)
                .addTextDisplayComponents(footerText);

            await channel.send({
                components: [welcomeHeader, welcomeContainer],
                files: [bannerAttachment],
                flags: MessageFlags.IsComponentsV2
            });
        } catch (err) {
            console.error('Welcome message failed:', err);
        }
    }
};
