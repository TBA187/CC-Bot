// Guild Settings: Lets members choose their game server and open their notification settings.
'use strict';

const path = require('node:path');
const {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    MessageFlags, SlashCommandBuilder
} = require('discord.js');
const { ScoutServerSettings, SERVERS, selectionFeedback } = require('../features/pvp-scouting/ScoutServerSettings.js');

const PREFIX = 'cc-settings:';
const LEGACY_PREFIX = 'ww-settings:';

function settingsPayload(interaction, selected) {
    const name = interaction.member?.nickname || interaction.member?.nick
        || interaction.user.globalName || interaction.user.username;
    const avatar = interaction.member?.displayAvatarURL?.({ size: 256 })
        || interaction.user.displayAvatarURL?.({ size: 256 });
    const embed = new EmbedBuilder().setColor(0xE63B50)
        .setTitle(`Crow Control Guild Settings - ${name}`)
        .setDescription(
            '- **Select the Server you are currently playing on below:**\n'
            + `  - ${SERVERS.gold.markup} **Gold:** Press this button to select the **Gold Server**.\n`            
            + `  - ${SERVERS.silver.markup} **Silver:** Press this button to select the **Silver Server**.\n`
            + `  - ${SERVERS.cross.markup} **Cross Server:** Press this button to select **Cross Server**.\n`
            + '  - Select your server only once, and the bot will remember it for future commands so you won\'t need to specify it every time. **You can change your server at any time!**\n'
            + '- **Notifications:** Press the 🔔 **Notifications** button to choose which in-game events should ping you.\n'
            + (selected ? `### Selected Server: ${SERVERS[selected].markup} ${SERVERS[selected].label}`
                : '### Selected Server: *`None`*'))
        .setFooter({ text: 'Crow Control Guild Settings', iconURL: 'attachment://cc_logo.webp' })
        .setTimestamp();
    if (avatar) embed.setThumbnail(avatar);
    const row = new ActionRowBuilder().addComponents(
        ...Object.entries(SERVERS).map(([key, server]) => new ButtonBuilder()
            .setCustomId(`${PREFIX}${key}:${interaction.user.id}`).setLabel(server.label)
            .setEmoji(server.emoji).setStyle(ButtonStyle.Secondary)),
        new ButtonBuilder().setCustomId(`${PREFIX}notifications:${interaction.user.id}`)
            .setLabel('Notifications').setEmoji('🔔').setStyle(ButtonStyle.Primary));
    return { embeds: [embed], components: [row], attachments: [],
        files: [new AttachmentBuilder(path.join(__dirname, '../images/cc_logo.webp'), { name: 'cc_logo.webp' })],
        allowedMentions: { parse: [] } };
}

class CcSettings {
    constructor(config) {
        this.name = 'cc-settings';
        this.guildId = String(config.guildId || '');
        this.store = config.guildMemberStore || config.scoutRosterStore;
        this.commandMap = config.commandMap;
        this.serverSettings = config.scoutServerSettings || new ScoutServerSettings({ config, store: this.store });
        this.data = new SlashCommandBuilder().setName(this.name)
            .setDescription('Choose Game Server and manage Guild Notifications.');
    }

    canUse(interaction) {
        return this.serverSettings.canUse(interaction);
    }

    async execute(interaction) {
        if (!this.canUse(interaction)) return interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const selected = await this.serverSettings.getSelectedServer(this.guildId, interaction.user.id);
            await interaction.editReply(settingsPayload(interaction, selected));
        } catch (error) {
            console.error('[CC LOG] Could not load Crow Control guild settings:', error);
            await interaction.editReply({ content: 'Could not load your settings. Please try again.', embeds: [], components: [] });
        }
    }

    async handleButton(interaction) {
        const prefix = [PREFIX, LEGACY_PREFIX].find(value => interaction.customId.startsWith(value));
        if (!prefix) return false;
        const [action, ownerId] = interaction.customId.slice(prefix.length).split(':');
        if (ownerId !== interaction.user.id || !this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (action === 'notifications') {
            const command = this.commandMap?.get('notifications');
            if (!command) {
                await interaction.reply({ content: 'Notifications are temporarily unavailable. Please try again.', flags: MessageFlags.Ephemeral });
            } else {
                // The existing command creates a separate private message below
                // this panel, with its own subscription controls and confirmation.
                await command.execute(interaction);
            }
            return true;
        }
        if (!SERVERS[action]) return false;
        await interaction.deferUpdate();
        let result;
        try {
            result = await this.serverSettings.select(interaction, action, { toggle: true });
        } catch (error) {
            console.error('[CC LOG] Could not save a guild member server preference:', error);
            await interaction.followUp({ content: error.message === 'No permission!' ? 'No permission!'
                : 'Could not save your server selection and role. Please try again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        try {
            await interaction.editReply(settingsPayload(interaction, result.selected));
        } catch (error) {
            console.warn(`[CC LOG] Server preference saved, but the guild settings panel could not refresh: ${error.message}`);
        }
        await interaction.followUp({ content: selectionFeedback(result), flags: MessageFlags.Ephemeral });
        return true;
    }
}

module.exports = CcSettings;
module.exports.settingsPayload = settingsPayload;
module.exports.selectionFeedback = selectionFeedback;
