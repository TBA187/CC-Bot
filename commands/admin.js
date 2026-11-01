// Admin only commands:
// - Manage guild-wide notification settings.
const {
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

function statusLabel(enabled) {
    return enabled ? 'Enabled' : 'Disabled';
}

function statusEmoji(enabled) {
    return enabled ? '✅' : '❌';
}

function notificationStatusEmbed(states, title = 'Guild Notifications') {
    const description = states.map(state => {
        const globalStatus = statusLabel(state.enabled);
        return `**${state.name}** — ${globalStatus} ${statusEmoji(state.enabled)}`;
    }).join('\n\n');

    return new EmbedBuilder()
        .setColor(0x452366)
        .setTitle(title)
        .setDescription(description || 'No guild notifications are configured.');
}

class Admin {
    constructor(config) {
        this.name = 'admin';
        this.config = config;
        this.adminRoleID = config.adminRoleID;
        this.notificationStore = config.notificationStore;

        this.data = new SlashCommandBuilder()
            .setName('admin')
            .setDescription('Admin tools.')
            .addSubcommand(sub =>
                sub.setName('notifications')
                    .setDescription('Enable or disable guild notifications.')
                    .addStringOption(option =>
                        option.setName('notification')
                            .setDescription('Select a guild notification to enable or disable.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(option =>
                        option.setName('status')
                            .setDescription('Enable or Disable this Guild Notification')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Enable', value: 'enabled' },
                                { name: 'Disable', value: 'disabled' }
                            )
                    )
            );
    }

    isAdminMember(member) {
        return Boolean(
            this.adminRoleID &&
            member?.roles?.cache?.has(this.adminRoleID)
        );
    }

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'This command can only be used in the server.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!this.isAdminMember(interaction.member)) {
            return interaction.reply({
                content: 'Only admins can use this command.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.options.getSubcommand() !== 'notifications') return;

        const notificationKey = interaction.options.getString('notification', true);
        const enabled = interaction.options.getString('status', true) === 'enabled';
        const definition = this.notificationStore.definitionsByKey.get(notificationKey);

        if (!definition) {
            return interaction.reply({
                content: 'That notification was not found. Please choose one from the autocomplete list.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const saved = await this.notificationStore.setGuildNotificationEnabled(notificationKey, enabled);
        const states = this.notificationStore.listNotificationStates();

        return interaction.editReply({
            content: `**${definition.name}** is now **${statusLabel(saved.enabled)} ${statusEmoji(saved.enabled)}**.`,
            embeds: [notificationStatusEmbed(states)]
        });
    }

    async handleAutocomplete(interaction) {
        if (
            interaction.commandName !== 'admin' ||
            interaction.options.getSubcommand() !== 'notifications' ||
            interaction.options.getFocused(true).name !== 'notification' ||
            !this.isAdminMember(interaction.member)
        ) {
            return interaction.respond([]);
        }

        const focused = interaction.options.getFocused().toLowerCase();
        const choices = this.notificationStore
            .listNotificationStates()
            .filter(state => {
                const searchable = `${state.name} ${state.description} ${statusLabel(state.enabled)}`.toLowerCase();
                return searchable.includes(focused);
            })
            .slice(0, 25)
            .map(state => ({
                name: `${state.name} — ${statusLabel(state.enabled)}`.slice(0, 100),
                value: state.key
            }));

        return interaction.respond(choices);
    }
}

module.exports = Admin;
module.exports.notificationStatusEmbed = notificationStatusEmbed;
