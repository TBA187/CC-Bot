// Publish and refresh role panels and route their interactive controls.
const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const {
    autoRolePanelAutocomplete,
    findAutoRolePanel,
    handleAutoRoleButton,
    handleAutoRoleModal,
    handleAutoRoleSelect,
    sendAutoRolePanel,
    updateAutoRolePanel
} = require('../events/auto_roles');


class AutoRoles {
    constructor(config) {
        this.name = 'auto_roles_send';
        this.adminRoleID = config.adminRoleID;
        this.serverSettings = config.scoutServerSettings || null;

        this.data = [
            // =========================================================
            // SEND NEW AUTO ROLE PANEL
            // =========================================================
            new SlashCommandBuilder()
                .setName('auto_roles_send')
                .setDescription('Send one of the configured auto-role panels.')
                .addStringOption(o =>
                    o.setName('panel')
                        .setDescription('Auto-role panel to send.')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addChannelOption(o =>
                    o.setName('channel')
                        .setDescription('Channel to post the selected auto-role panel in. If omitted, the panel default channel is used.')
                        .setRequired(false)
                        .addChannelTypes(ChannelType.GuildText)
                ),

            // =========================================================
            // UPDATE EXISTING AUTO ROLE PANEL
            // =========================================================
            new SlashCommandBuilder()
                .setName('auto_roles_update')
                .setDescription('Update an existing auto-role panel from the current config file.')
                .addStringOption(o =>
                    o.setName('panel')
                        .setDescription('Select the auto-role panel to update.')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addChannelOption(o =>
                    o.setName('channel')
                        .setDescription('Channel containing the existing auto-role panel.')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText)
                )
                .addStringOption(o =>
                    o.setName('message_id')
                        .setDescription('Message ID of the existing auto-role panel.')
                        .setRequired(true)
                )
        ];
    }

    isAdminMember(member) {
        if (!member?.roles?.cache) {
            return false;
        }

        return member.roles.cache.some(role => role.id === this.adminRoleID);
    }

    async execute(interaction) {
        if (!this.isAdminMember(interaction.member)) {
            await interaction.reply({
                content: 'Only admins can use this command.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // =========================================================
        // UPDATE EXISTING AUTO ROLE PANEL
        // =========================================================
        if (interaction.commandName === 'auto_roles_update') {
            return this.executeUpdate(interaction);
        }

        const panel = interaction.options.getString('panel', true);
        const selectedPanel = findAutoRolePanel(panel);
        if (selectedPanel === null) {
            await interaction.reply({
                content: 'Auto-role panel not found! Please pick one from the autocomplete list.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!selectedPanel.active) {
            await interaction.reply({
                content: `**${selectedPanel.name}** is currently inactive and cannot be sent.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // Default channels may need a REST fetch. Accept the command before
        // that request so it cannot consume Discord's initial response window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let targetChannel = interaction.options.getChannel('channel');
        if (targetChannel === null && selectedPanel.defaultChannelId !== null) {
            const fetchedChannel = interaction.client.channels.cache.get(selectedPanel.defaultChannelId)
                ?? await interaction.client.channels.fetch(selectedPanel.defaultChannelId).catch(() => null);

            if (fetchedChannel?.type === ChannelType.GuildText) {
                targetChannel = fetchedChannel;
            }
        }

        if (targetChannel === null) {
            await interaction.editReply({
                content: 'Please choose a channel, or set `AUTO_ROLES_CHANNEL_ID` inside `events/auto_roles.js` for this panel.'
            });
            return;
        }

        try {
            const message = await sendAutoRolePanel(targetChannel, selectedPanel);
            await interaction.editReply(
                `Sent **${selectedPanel.name}** in ${targetChannel}.\n` +
                `Message ID: \`${message.id}\``
            );
        } catch (err) {
            if (err?.code === 'ENOENT') {
                await interaction.editReply(`Could not find \`${selectedPanel.imagePath}\``);
                return;
            }

            if (err?.code === 50013) {
                await interaction.editReply('No permissions to send the auto-role panel in this channel.');
                return;
            }

            console.error('[CC LOG] Auto-role panel send error:', err);
            await interaction.editReply('Discord returned an error while sending the auto-role panel. Please try again.');
        }
    }

    async executeUpdate(interaction) {
        const panel = interaction.options.getString('panel', true);
        const selectedPanel = findAutoRolePanel(panel);

        if (selectedPanel === null) {
            await interaction.reply({
                content: 'Auto-role panel not found! Please pick one from the autocomplete list.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!selectedPanel.active) {
            await interaction.reply({
                content: `**${selectedPanel.name}** is currently inactive and cannot be updated.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const targetChannel = interaction.options.getChannel('channel', true);
        const messageId = interaction.options.getString('message_id', true);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const message = await targetChannel.messages
                .fetch(messageId)
                .catch(() => null);

            if (message === null) {
                await interaction.editReply(
                    'Could not find that message in the selected channel. Check the channel and message ID.'
                );
                return;
            }

            if (message.author.id !== interaction.client.user.id) {
                await interaction.editReply(
                    'The message was sent by another bot, so it cannot be updated by this command.'
                );
                return;
            }

            // Rebuild the existing message using the CURRENT panel config.
            await updateAutoRolePanel(message, selectedPanel);

            await interaction.editReply(
                `Updated **${selectedPanel.name}** in ${targetChannel}.\n` +
                `Message ID: \`${message.id}\``
            );
        } catch (err) {
            if (err?.code === 'ENOENT') {
                await interaction.editReply(
                    'Could not find one of the configured panel image files.'
                );
                return;
            }

            if (err?.code === 50013) {
                await interaction.editReply(
                    'No permission to update the auto-role panel in this channel.'
                );
                return;
            }

            console.error('[CC LOG] Auto-role panel update error:', err);
            await interaction.editReply(
                'Discord returned an error while updating the auto-role panel. Please try again.'
            );
        }
    }

    async handleAutocomplete(interaction) {
        if (
            interaction.commandName !== 'auto_roles_send' &&
            interaction.commandName !== 'auto_roles_update'
        ) {
            return;
        }

        if (!this.isAdminMember(interaction.member)) {
            return interaction.respond([]);
        }

        return autoRolePanelAutocomplete(interaction);
    }

    async handleButton(interaction) {
        return handleAutoRoleButton(interaction, this.serverSettings);
    }

    async handleSelect(interaction) {
        return handleAutoRoleSelect(interaction);
    }

    async handleModal(interaction) {
        return handleAutoRoleModal(interaction);
    }
}

module.exports = AutoRoles;
