// Let members choose their own in-game notification subscriptions.
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    StringSelectMenuBuilder
} = require('discord.js');
const {
    getNextAltoMareSchedule,
    getNextContestScheduleForContest
} = require('../tasks/proNotifications.js');

const SELECT_PREFIX = 'notifications:subscriptions:';
const CONFIRM_PREFIX = 'notifications:confirm:';

function statusEmoji(enabled) {
    return enabled ? '✅' : '❌';
}

function nextContestLine(state) {
    if (!state.contestKey) return '';

    try {
        const schedule = getNextContestScheduleForContest(state.contestKey);
        const unixTime = Math.floor(schedule.eventStart / 1000);
        return `\n- Next ${state.contestKey}: **<t:${unixTime}:F> (<t:${unixTime}:R>)**`;
    } catch (err) {
        console.error(`[PRO NOTIFICATIONS] Failed to calculate the next ${state.contestKey}:`, err);
        return `\n- Next ${state.contestKey}: **Unavailable**`;
    }
}

function nextAltoMareLine(state) {
    if (state.key !== 'alto_mare' || !state.enabled) return '';

    try {
        const schedule = getNextAltoMareSchedule();
        const unixTime = Math.floor(schedule.raceStart / 1000);
        return `\n- Next Race: **<t:${unixTime}:F> (<t:${unixTime}:R>)**`;
    } catch (err) {
        console.error('[PRO NOTIFICATIONS] Failed to calculate the next Alto Mare Race:', err);
        return '\n- Next Race: **Unavailable**';
    }
}

function notificationTitle(state) {
    const label = state.informationUrl
        ? `[${state.name}](${state.informationUrl})`
        : state.name;

    return state.enabled
        ? `**${label}**`
        : `~~**${label}**~~ — Disabled by admin ${statusEmoji(false)}`;
}

function subscriptionsEmbed(states, selectedKeys, user) {
    const selected = new Set(selectedKeys);
    const description = states.map(state => {
        const pingStatus = selected.has(state.key)
            ? `Enabled ${statusEmoji(true)}`
            : `Disabled ${statusEmoji(false)}`;
        const details = state.description ? `-# ${state.description}\n` : '';
        const sharedContestNote = state.key === 'fish_catching_contest'
            ? '\n\n-# BCC and FCC alternates every Saturday between 10:00 AM and 10:00 PM UTC. Pings 30 mins before the contests starts.'
            : '';

        return `${notificationTitle(state)}\n` +
            details +
            `- Ping Notifications: **${pingStatus}**` +
            nextContestLine(state) +
            nextAltoMareLine(state) +
            sharedContestNote;
    }).join('\n\n');

    const disabledNotice = states.some(state => !state.enabled)
        ? '\n-# Disabled guild notifications will not ping anyone until an admin enables them again.'
        : '';
    const username = user?.username || user?.globalName || 'Member';

    const embed = new EmbedBuilder()
        .setColor(0x452366)
        .setTitle(`Guild Notification Pings for ${username}`)
        .setDescription(
            `${description}\n\n` +
            'Choose which notifications should ping you from the dropdown menu below, then press the button to confirm.' +
            disabledNotice
        )
        .setFooter({
            text: 'Crow Control Notifications',
            iconURL: 'attachment://cc_logo.webp'
        })
        .setTimestamp();

    const avatarUrl = user?.displayAvatarURL?.({ size: 256 });
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    return embed;
}

function subscriptionMenu(states, selectedKeys, userId, panelId) {
    const selected = new Set(selectedKeys);
    const options = states.map(state => ({
        label: state.name.slice(0, 100),
        value: state.key,
        description: `${state.enabled ? 'Active' : 'Disabled'} • Ping: ${selected.has(state.key) ? 'Enabled' : 'Disabled'}`.slice(0, 100),
        default: selected.has(state.key)
    }));

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`${SELECT_PREFIX}${userId}:${panelId}`)
        .setPlaceholder('Select the notifications you want to receive.')
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options);

    return new ActionRowBuilder().addComponents(menu);
}

function confirmButton(userId, panelId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CONFIRM_PREFIX}${userId}:${panelId}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success)
    );
}

function ccLogoFile() {
    return new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' });
}

function parsePanelId(customId, prefix) {
    const [ownerId, panelId] = customId.slice(prefix.length).split(':', 2);
    return { ownerId, panelId };
}

class Notifications {
    constructor(config) {
        this.name = 'notifications';
        this.notificationStore = config.notificationStore;
        this.pendingSelections = new Map();
        this.data = new SlashCommandBuilder()
            .setName('notifications')
            .setDescription('Choose which notifications should ping you.');
    }

    async buildReply(user, selectedKeys = null, panelId = 'current') {
        const states = this.notificationStore.listNotificationStates();
        const enabledKeys = selectedKeys || this.notificationStore.getUserSubscriptionKeys(user.id);

        return {
            embeds: [subscriptionsEmbed(states, enabledKeys, user)],
            components: states.length
                ? [subscriptionMenu(states, enabledKeys, user.id, panelId), confirmButton(user.id, panelId)]
                : [],
            files: [ccLogoFile()]
        };
    }

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'This command can only be used in the server.',
                flags: MessageFlags.Ephemeral
            });
        }

        return interaction.reply({
            ...(await this.buildReply(interaction.user, null, interaction.id)),
            flags: MessageFlags.Ephemeral
        });
    }

    async handleSelect(interaction) {
        if (!interaction.customId.startsWith(SELECT_PREFIX)) return false;

        const { ownerId, panelId } = parsePanelId(interaction.customId, SELECT_PREFIX);
        if (ownerId !== interaction.user.id) {
            await interaction.reply({
                content: 'This notification menu belongs to another member.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        await interaction.deferUpdate();
        const pendingKey = `${ownerId}:${panelId}`;
        this.pendingSelections.set(pendingKey, interaction.values);
        return true;
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith(CONFIRM_PREFIX)) return false;

        const { ownerId, panelId } = parsePanelId(interaction.customId, CONFIRM_PREFIX);
        if (ownerId !== interaction.user.id) {
            await interaction.reply({
                content: 'This notification menu belongs to another member.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        const pendingKey = `${ownerId}:${panelId}`;
        const selectedKeys = this.pendingSelections.get(pendingKey)
            || this.notificationStore.getUserSubscriptionKeys(interaction.user.id);

        await interaction.deferUpdate();
        await this.notificationStore.setUserSubscriptions(interaction.user.id, selectedKeys);
        this.pendingSelections.delete(pendingKey);
        await interaction.editReply(await this.buildReply(interaction.user, null, panelId));
        return true;
    }
}

module.exports = Notifications;
module.exports.subscriptionsEmbed = subscriptionsEmbed;
