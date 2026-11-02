// Create and manage giveaways through the shared storage and delivery service.
const {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder
} = require('discord.js');

const {
    GIVEAWAY_ACTIVE,
    GIVEAWAY_DELETED,
    GIVEAWAY_ENDED,
    MAX_WINNERS,
    GiveawayFinalizationDeferred,
    buildGiveawayListEmbeds,
    canManageGiveaways,
    deleteGiveawayMessage,
    drawSummary,
    endGiveaway,
    giveawayAutocomplete,
    giveawayChannelOnlyError,
    giveawayDisplayLabel,
    giveawayEndedWithinRerollWindow,
    giveawayHasEnded,
    makeGiveawayId,
    normalizeGiveawayDescription,
    parseColor,
    parseGiveawayEndTime,
    refreshGiveawayMessage,
    resolveRequiredRoleIds,
    resolveGiveawayPings,
    sendEmbedFollowUp,
    replyWithGiveawayMessage,
    sendParticipantEmbeds,
    shouldRestrictGiveawayChannel,
    utcNowIso,
    validateWinnerCount,
    wakeGiveawayLoop,
    withGiveawayLock
} = require('../events/giveaways');
const { setInteractionContext } = require('../utils/interactionDiagnostics');

class Giveaways {
    constructor(config) {
        this.name = 'giveaway';
        this.config = config;
        this.giveawayStore = config.giveawayStore;

        this.data = new SlashCommandBuilder()
            .setName('giveaway')
            .setDescription('Create and manage Crow Control giveaways.')
            .addSubcommand(sub =>
                sub.setName('create')
                    .setDescription('Create a giveaway.')
                    .addStringOption(o =>
                        o.setName('duration')
                            .setDescription("Enter a relative time ('24h' or '1d 5h 30m') or a UTC datetime (2026-07-01 18:30).")
                            .setRequired(true)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription('Winners to draw (max 500 winners).')
                            .setRequired(true)
                            .setMinValue(1)
                            .setMaxValue(MAX_WINNERS)
                    )
                    .addStringOption(o =>
                        o.setName('prize')
                            .setDescription('Prize for the giveaway.')
                            .setRequired(true)
                            .setMaxLength(512)
                    )
                    .addStringOption(o =>
                        o.setName('title')
                            .setDescription('Giveaway title. Leave empty to use the default title: Crow Control Giveaway 🎉')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('description')
                            .setDescription('Giveaway description (optional). Use \\n for line breaks, e.g. Line1\\nLine2')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('host')
                            .setDescription('Enter a different giveaway host. Leave empty to use your name.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('color')
                            .setDescription('Enter a hex code (#RRGGBB) or a color name (red, dark blue). Default color: #39FF14')
                            .setRequired(false)
                            .setMaxLength(64)
                    )
                    .addAttachmentOption(o =>
                        o.setName('thumbnail')
                            .setDescription('Image for Giveaway (appears at the top right of the embed). Leave empty to use Crow Control logo.')
                            .setRequired(false)
                    )
                    .addStringOption(o =>
                        o.setName('pin_giveaway')
                            .setDescription('Pin the giveaway in the channel (Default: No).')
                            .setRequired(false)
                            .addChoices(
                                { name: 'Yes', value: 'yes' },
                                { name: 'No', value: 'no' }
                            )
                    )
                    .addStringOption(o =>
                        o.setName('ping_roles')
                            .setDescription('Select roles or members to ping (type @ to search). Leave empty for no pings.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('required_role')
                            .setDescription('Select roles required to enter the giveaway. Only one matching role is needed (Officer-only).')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('edit')
                    .setDescription('Edit an active giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to edit.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addStringOption(o =>
                        o.setName('duration')
                            .setDescription("New duration: Enter a relative time ('24h' or '1d 5h 30m') or a UTC datetime (2026-07-01 18:30).")
                            .setRequired(false)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription('New amount of winners to draw (max 500).')
                            .setRequired(false)
                            .setMinValue(1)
                            .setMaxValue(MAX_WINNERS)
                    )
                    .addStringOption(o =>
                        o.setName('prize')
                            .setDescription('New prize.')
                            .setRequired(false)
                            .setMaxLength(512)
                    )
                    .addStringOption(o =>
                        o.setName('title')
                            .setDescription('New giveaway title.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('host')
                            .setDescription('New giveaway host.')
                            .setRequired(false)
                            .setMaxLength(256)
                    )
                    .addStringOption(o =>
                        o.setName('color')
                            .setDescription('New embed color: Enter hex code (#RRGGBB) or color name (red, dark blue). Default: #39FF14')
                            .setRequired(false)
                            .setMaxLength(64)
                    )
                    .addAttachmentOption(o =>
                        o.setName('thumbnail')
                            .setDescription('New image for the embed thumbnail.')
                            .setRequired(false)
                    )
                    .addStringOption(o =>
                        o.setName('ping_roles')
                            .setDescription('Select roles or members to ping (type @ to search). Leave empty to keep current pings.')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addStringOption(o =>
                        o.setName('required_role')
                            .setDescription('Select roles required to enter the giveaway. Only one matching role is needed (Officer-only).')
                            .setRequired(false)
                            .setMaxLength(1000)
                    )
                    .addBooleanOption(o =>
                        o.setName('remove_ping_roles')
                            .setDescription('Remove the current role and member pings.')
                            .setRequired(false)
                    )
                    .addBooleanOption(o =>
                        o.setName('remove_required_role')
                            .setDescription('Remove the current required role.')
                            .setRequired(false)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('end')
                    .setDescription('End an active giveaway immediately.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to end.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('delete')
                    .setDescription('Delete a giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to delete.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('reroll')
                    .setDescription('Reroll winners for an ended giveaway.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Select an ended giveaway to reroll. Giveaways older than 48 hours cannot be rerolled.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addIntegerOption(o =>
                        o.setName('winners')
                            .setDescription("New winners to draw (max 500). Leave empty to use the giveaway's default winner count.")
                            .setRequired(false)
                            .setMinValue(1)
                            .setMaxValue(MAX_WINNERS)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('participants')
                    .setDescription('Show giveaway participants.')
                    .addStringOption(o =>
                        o.setName('giveaway')
                            .setDescription('Giveaway to inspect.')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('list')
                    .setDescription('List giveaways.')
                    .addStringOption(o =>
                        o.setName('status')
                            .setDescription('Which giveaways to list. Leave empty to show currently active giveaways.')
                            .setRequired(false)
                            .addChoices(
                                { name: 'Active', value: GIVEAWAY_ACTIVE },
                                { name: 'Ended', value: GIVEAWAY_ENDED },
                                { name: 'Deleted', value: GIVEAWAY_DELETED },
                                { name: 'All', value: 'all' }
                            )
                    )
            );
    }

    async execute(interaction) {
        if (!this.giveawayStore) {
            return interaction.reply({ content: 'Giveaway storage is not ready.', flags: MessageFlags.Ephemeral });
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'create') return this.create(interaction);
        if (subcommand === 'edit') return this.edit(interaction);
        if (subcommand === 'end') return this.end(interaction);
        if (subcommand === 'delete') return this.delete(interaction);
        if (subcommand === 'reroll') return this.reroll(interaction);
        if (subcommand === 'participants') return this.participants(interaction);
        if (subcommand === 'list') return this.list(interaction);
        return interaction.reply({ content: 'Unknown giveaway command.', flags: MessageFlags.Ephemeral });
    }

    async create(interaction) {
        if (shouldRestrictGiveawayChannel(this.config) && interaction.channelId !== this.config.giveawayChannelID) {
            return interaction.reply({ content: giveawayChannelOnlyError(this.config), flags: MessageFlags.Ephemeral });
        }

        const requiredRoleText = interaction.options.getString('required_role');
        if (requiredRoleText?.trim() && !canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: '`required_role` is Officer-only!', flags: MessageFlags.Ephemeral });
        }

        let winners;
        let endsAt;
        let colorHex;
        let pings;
        let requiredRoleIds;
        try {
            winners = validateWinnerCount(interaction.options.getInteger('winners', true));
            endsAt = parseGiveawayEndTime(interaction.options.getString('duration', true));
            colorHex = parseColor(interaction.options.getString('color'));
            pings = resolveGiveawayPings(interaction.guild, interaction.options.getString('ping_roles'));
            requiredRoleIds = resolveRequiredRoleIds(interaction.guild, requiredRoleText);
        } catch (err) {
            return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
        }

        if (!interaction.channel?.send || interaction.channel?.type !== ChannelType.GuildText) {
            return interaction.reply({ content: 'This command must be used in a message channel.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply();

        const giveawayId = makeGiveawayId();
        const title = interaction.options.getString('title');
        const host = interaction.options.getString('host');
        const thumbnail = interaction.options.getAttachment('thumbnail');
        const pinGiveaway = (interaction.options.getString('pin_giveaway') || 'no') === 'yes';
        const now = utcNowIso();
        let giveaway = {
            giveaway_id: giveawayId,
            guild_id: interaction.guildId,
            channel_id: interaction.channelId,
            message_id: null,
            name: title?.trim() || null,
            description: normalizeGiveawayDescription(interaction.options.getString('description')),
            prize: interaction.options.getString('prize', true).trim(),
            host_text: host?.trim() || interaction.user.toString(),
            host_display_name: host?.trim() ? null : this.userDisplayName(interaction.member || interaction.user),
            host_user_id: host?.trim() ? null : interaction.user.id,
            created_by_id: interaction.user.id,
            created_by_name: this.userDisplayName(interaction.member || interaction.user),
            winners_total: winners,
            ping_role_ids: pings.roleIds,
            ping_user_ids: pings.userIds,
            required_role_ids: requiredRoleIds,
            required_role_id: requiredRoleIds[0] || null,
            status: GIVEAWAY_ACTIVE,
            starts_at: now,
            ends_at: endsAt.toISOString(),
            ended_at: null,
            deleted_at: null,
            color_hex: colorHex,
            thumbnail_url: thumbnail?.url || null,
            pin_giveaway: pinGiveaway,
            winner_user_ids: []
        };

        giveaway = await this.giveawayStore.createGiveaway(giveaway);

        let message;
        try {
            message = await replyWithGiveawayMessage(interaction, giveaway, this.config);
        } catch (err) {
            console.error('[CC LOG] Giveaway create message failed:', err);
            await this.giveawayStore.updateGiveaway(giveawayId, {
                status: GIVEAWAY_DELETED,
                deleted_at: utcNowIso()
            });
            wakeGiveawayLoop(interaction.client);
            await interaction.editReply('Discord returned an error while creating the giveaway.').catch(() => { });
            return;
        }

        giveaway = await this.giveawayStore.updateGiveaway(giveawayId, { message_id: message.id });
        wakeGiveawayLoop(interaction.client);
        let pinNotice = '';
        if (pinGiveaway) {
            try {
                await message.pin('Giveaway created with pin enabled');
            } catch (err) {
                console.warn(`[CC LOG] Could not pin giveaway ${giveawayId}: ${err.code || err.message}`);
                pinNotice = '\nI could not pin the message. Check the bot’s Manage Messages permission.';
            }
        }
        await interaction.followUp({ content: `Giveaway created: ${message.url}${pinNotice}`, flags: MessageFlags.Ephemeral });
    }

    async edit(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);

        const updates = {};
        try {
            const duration = interaction.options.getString('duration');
            const winners = interaction.options.getInteger('winners');
            const color = interaction.options.getString('color');
            const pingRoles = interaction.options.getString('ping_roles');
            const requiredRole = interaction.options.getString('required_role');
            if (duration) updates.ends_at = parseGiveawayEndTime(duration).toISOString();
            if (winners !== null) updates.winners_total = validateWinnerCount(winners);
            if (color) updates.color_hex = parseColor(color);
            if (pingRoles) {
                const pings = resolveGiveawayPings(interaction.guild, pingRoles);
                updates.ping_role_ids = pings.roleIds;
                updates.ping_user_ids = pings.userIds;
            }
            if (requiredRole) {
                const requiredRoleIds = resolveRequiredRoleIds(interaction.guild, requiredRole);
                updates.required_role_ids = requiredRoleIds;
                updates.required_role_id = requiredRoleIds[0] || null;
            }
        } catch (err) {
            return interaction.editReply(err.message);
        }

        const prize = interaction.options.getString('prize');
        const title = interaction.options.getString('title');
        const host = interaction.options.getString('host');
        const thumbnail = interaction.options.getAttachment('thumbnail');
        if (prize) updates.prize = prize.trim();
        if (title) updates.name = title.trim();
        if (host) {
            updates.host_text = host.trim();
            updates.host_display_name = null;
            updates.host_user_id = null;
        }
        if (thumbnail) updates.thumbnail_url = thumbnail.url;
        if (interaction.options.getBoolean('remove_ping_roles') === true) {
            updates.ping_role_ids = [];
            updates.ping_user_ids = [];
        }
        if (interaction.options.getBoolean('remove_required_role') === true) {
            updates.required_role_ids = [];
            updates.required_role_id = null;
        }

        if (!Object.keys(updates).length) {
            return interaction.editReply('No giveaway changes were provided.');
        }

        const updated = await withGiveawayLock(giveawayId, async () => {
            const record = await this.giveawayStore.getGiveaway(giveawayId);
            if (!record || giveawayHasEnded(record)) return null;
            return this.giveawayStore.updateGiveaway(giveawayId, updates);
        });
        if (!updated) return interaction.editReply('That active giveaway could not be found.');
        if (updates.ends_at) wakeGiveawayLoop(interaction.client);
        await refreshGiveawayMessage(interaction.client, this.config, updated);
        await interaction.editReply(`Updated **${giveawayDisplayLabel(updated, { guild: interaction.guild })}**.`);
    }

    async end(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record || record.status !== GIVEAWAY_ACTIVE && !record.end_announcement_pending) {
            return interaction.editReply('That active giveaway could not be found.');
        }

        let ended;
        let winnerIds;
        try {
            [ended, winnerIds] = await endGiveaway(interaction.client, this.config, record, {
                actor: interaction.user,
                drawType: 'end',
                announceInteraction: interaction
            });
        } catch (err) {
            if (!(err instanceof GiveawayFinalizationDeferred) && !this.giveawayStore.db?.isDatabaseUnavailableError?.(err)) throw err;
            const saved = await this.giveawayStore.getGiveaway(giveawayId);
            if (saved?.end_requested_at || saved?.end_announcement_pending) {
                return interaction.editReply('The end request was saved. Entries are closed; the giveaway will finish automatically when storage and delivery are available.');
            }
            return interaction.editReply('Giveaway storage is temporarily unavailable. Please try again shortly.');
        }

        if (ended.status !== GIVEAWAY_ENDED) {
            return interaction.editReply('That active giveaway could not be found.');
        }
        if (ended.end_announcement_pending) {
            return interaction.editReply('The giveaway ended and its winners were saved. The announcement is pending and will retry automatically.');
        }

        const summary = drawSummary('Ended', ended, winnerIds, interaction.guild);
        if (interaction.replied) {
            await interaction.followUp({ content: summary, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        } else if (interaction.deferred) {
            await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
        } else {
            await interaction.reply({ content: summary, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
    }

    async delete(interaction) {
        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const updated = await withGiveawayLock(giveawayId, async () => {
            const record = await this.giveawayStore.getGiveaway(giveawayId);
            if (!record) return null;
            return this.giveawayStore.updateGiveaway(giveawayId, {
                status: GIVEAWAY_DELETED,
                deleted_at: utcNowIso()
            });
        });
        if (!updated) return interaction.editReply('That giveaway could not be found.');
        wakeGiveawayLoop(interaction.client);
        await deleteGiveawayMessage(interaction.client, this.config, updated);
        await interaction.editReply(`Deleted **${giveawayDisplayLabel(updated, { guild: interaction.guild })}**.`);
    }

    async reroll(interaction) {
        if (shouldRestrictGiveawayChannel(this.config) && interaction.channelId !== this.config.giveawayChannelID) {
            return interaction.reply({ content: giveawayChannelOnlyError(this.config, 'reroll'), flags: MessageFlags.Ephemeral });
        }

        if (!canManageGiveaways(interaction.member, this.config)) {
            return interaction.reply({ content: "You don't have permission.", flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record || record.status !== GIVEAWAY_ENDED) {
            return interaction.editReply('That ended giveaway could not be found.');
        }
        if (record.end_announcement_pending) {
            return interaction.editReply('The initial giveaway announcement is still pending. Please wait for it to finish.');
        }
        if (record.reroll_announcement?.draw_id) {
            return interaction.editReply('The previous reroll announcement is still pending. Please wait for it to finish.');
        }
        if (!giveawayEndedWithinRerollWindow(record)) {
            return interaction.editReply('The 48-hour reroll window for that giveaway has expired.');
        }

        let winnerCount;
        try {
            winnerCount = validateWinnerCount(interaction.options.getInteger('winners') || Number(record.winners_total || 1));
        } catch (err) {
            return interaction.editReply(err.message);
        }

        let rerolled, winnerIds;
        try {
            [rerolled, winnerIds] = await endGiveaway(interaction.client, this.config, record, {
                actor: interaction.user,
                drawType: 'reroll',
                winnerCount,
                announceInteraction: interaction
            });
        } catch (err) {
            if (!(err instanceof GiveawayFinalizationDeferred) && !this.giveawayStore.db?.isDatabaseUnavailableError?.(err)) throw err;
            const saved = await this.giveawayStore.getGiveaway(giveawayId).catch(() => null);
            if (saved?.reroll_announcement?.draw_id) {
                return interaction.editReply('The reroll was saved. Winner notifications are pending and will retry automatically.');
            }
            return interaction.editReply(err instanceof GiveawayFinalizationDeferred ? err.message : 'Giveaway storage is temporarily unavailable. Please try again shortly.');
        }

        if (rerolled.status !== GIVEAWAY_ENDED) {
            return interaction.editReply('That ended giveaway could not be found.');
        }
        if (rerolled.reroll_announcement?.draw_id) {
            return interaction.editReply('The reroll was saved. Winner notifications are pending and will retry automatically.');
        }

        const summary = drawSummary('Rerolled', rerolled, winnerIds, interaction.guild);
        if (interaction.replied) {
            await interaction.followUp({ content: summary, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        } else if (interaction.deferred) {
            await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
        } else {
            await interaction.reply({ content: summary, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }
    }

    async participants(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giveawayId = interaction.options.getString('giveaway', true);
        const record = await this.giveawayStore.getGiveaway(giveawayId);
        if (!record) {
            return interaction.editReply('That giveaway could not be found.');
        }

        await sendParticipantEmbeds(interaction, this.config, record);
    }

    async list(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = interaction.options.getString('status') || GIVEAWAY_ACTIVE;
        const giveaways = await this.giveawayStore.listGiveaways(status);
        for (const giveaway of giveaways) {
            const entries = await this.giveawayStore.listEntries(giveaway.giveaway_id, { activeOnly: true });
            giveaway.participant_count = entries.length;
        }

        const embeds = buildGiveawayListEmbeds(giveaways, status, interaction.guild);
        return this.sendEmbeds(interaction, embeds);
    }

    async sendEmbeds(interaction, embeds) {
        await sendEmbedFollowUp(interaction, embeds);
    }

    async handleAutocomplete(interaction) {
        if (interaction.commandName !== 'giveaway') return;
        const subcommand = interaction.options.getSubcommand();
        const focused = interaction.options.getFocused(true);
        setInteractionContext(interaction, { phase: `autocomplete ${subcommand}/${focused.name}` });
        if (focused.name !== 'giveaway') return interaction.respond([]);
        if (subcommand === 'edit' || subcommand === 'end') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: GIVEAWAY_ACTIVE }));
        }
        if (subcommand === 'reroll') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: GIVEAWAY_ENDED, recentEndedOnly: true }));
        }
        if (subcommand === 'delete' || subcommand === 'participants') {
            return interaction.respond(await giveawayAutocomplete(interaction, this.config, { status: 'all' }));
        }
        return interaction.respond([]);
    }

    userDisplayName(user) {
        return String(user?.nickname || user?.displayName || user?.globalName || user?.username || user?.user?.username || user?.id || 'Unknown');
    }
}

module.exports = Giveaways;
