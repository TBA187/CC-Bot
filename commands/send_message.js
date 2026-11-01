// Open private message builders for staff to compose or edit bot messages.
'use strict';
const { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, MessageFlags } = require('discord.js');
const { EmbedDraft, draftFromMessage, expandLiteralLineBreaks, applyCrowControlBrandingDefaults } = require('../features/message-builder/draft.js');
const { BuilderController } = require('../features/message-builder/editor.js');
const { hasAllowedRole, currentMember } = require('../features/message-builder/permissions.js');
class SendMessage {
    constructor(config = {}) {
        this.name = 'send_message';
        this.config = config;
        this.allowedRoles = new Set([config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean));
        this.controller = new BuilderController(config);
        this.sessions = this.controller.sessions;
        this.data = [
            new SlashCommandBuilder()
                .setName('send_message')
                .setDescription('Send a custom bot message or embed. Command opens a builder to customize the message before sending.')
                .setDMPermission(false)
                .addChannelOption(option => option.setName('channel')
                .setDescription('Select a channel to send the message to, or leave empty to use the current channel.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
                .addStringOption(option => option.setName('message_content')
                .setDescription('Message content. Supports markdown, emojis, mentions and \\n for new lines. Add files in the builder.'))
                .addStringOption(option => option.setName('crow_control_branding')
                .setDescription('Adds Crow Control footer, thumbnail, brand color, and current timestamp. Leave empty for No.')
                .addChoices({ name: 'Yes', value: 'yes' }, { name: 'No', value: 'no' })),
            new ContextMenuCommandBuilder()
                .setName('Edit Bot Embed (Officer)')
                .setType(ApplicationCommandType.Message)
                .setDMPermission(false)
        ];
    }
    canBuild(member) {
        return hasAllowedRole(member, this.allowedRoles);
    }
    async execute(interaction) {
        if (interaction.isMessageContextMenuCommand())
            return this.handleContext(interaction);
        return this.handleSlash(interaction);
    }
    async handleSlash(interaction) {
        if (!this.canBuild(currentMember(interaction)))
            return interaction.reply({ content: '### No permission!', flags: MessageFlags.Ephemeral });
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        if (!channel || typeof channel.send !== 'function')
            return interaction.reply({ content: 'The selected channel cannot receive messages.', flags: MessageFlags.Ephemeral });
        const draft = new EmbedDraft({ messageContent: expandLiteralLineBreaks(interaction.options.getString('message_content')) });
        if (interaction.options.getString('crow_control_branding') === 'yes')
            applyCrowControlBrandingDefaults(draft);
        const session = this.controller.createSession({ ownerId: interaction.user.id, target: {
                channel, invocationChannelId: interaction.channel?.id || null, invocationChannel: interaction.channel
            }, draft });
        await session.open(interaction);
    }
    async handleContext(interaction) {
        if (!this.canBuild(currentMember(interaction)))
            return interaction.reply({ content: '### No permission!', flags: MessageFlags.Ephemeral });
        const message = interaction.targetMessage;
        if (!interaction.client.user || message.author.id !== interaction.client.user.id)
            return interaction.reply({ content: 'Only Crow Control bot messages can be edited.', flags: MessageFlags.Ephemeral });
        if ((this.config.blockedEditBotMsgChannels || []).includes(message.channelId || message.channel?.id))
            return interaction.reply({ content: 'Editing bot messages is not allowed in this channel.', flags: MessageFlags.Ephemeral });
        const session = this.controller.createSession({ ownerId: interaction.user.id, target: {
                channel: message.channel, invocationChannelId: interaction.channel?.id || null,
                invocationChannel: interaction.channel, message
            }, draft: draftFromMessage(message) });
        await session.open(interaction);
    }
    async handleComponent(interaction, method) {
        if (!interaction.customId?.startsWith('send_message:')) return false;
        if (!this.canBuild(currentMember(interaction))) {
            await interaction.reply({ content: '### No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        return this.controller[method](interaction);
    }
    handleButton(interaction) { return this.handleComponent(interaction, 'handleButton'); }
    handleSelect(interaction) { return this.handleComponent(interaction, 'handleSelect'); }
    handleSelectMenu(interaction) { return this.handleSelect(interaction); }
    handleModal(interaction) { return this.handleComponent(interaction, 'handleModal'); }
}
module.exports = SendMessage;
