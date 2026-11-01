// Records crowns and defenses before updating Discord roles, history and announcements.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { announceEventWinner, utcEventDate } = require('./utils/pvpEvent.js');
const { splitMessageParts } = require('./utils/pvpMessages.js');
const { setInteractionContext, interactionErrorCode } = require('../../utils/interactionDiagnostics.js');
const { SlashCommandBuilder, MessageFlags, ThreadChannel, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const {
    formatNowMinute,
    getLogChannel,
    refreshGuildMembers,
    memberHasAnyRole,
    requirePvpChannel
} = require('./utils/pvpHelper.js');

class PvpCrownKing {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_crown";
        this.db = config.pvpKingStorage || config.db;
        this.eventConfig = config;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.pvpWarriorRoleID = config.pvpWarriorRoleID;
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.ownerID = config.ownerID;
        this.logChannelID = config.logChannelID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.historyThreadID = config.historyThreadID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_crown')
            .setDescription('Crown a new PvP King (Officers only)')
            .addUserOption(o =>
                o.setName('user').setDescription('Select the new PvP King').setRequired(true)
            );
    }

    async execute(interaction) {
        setInteractionContext(interaction, { server: this.pvpServerName, phase: 'validation', crownSaved: false });

        // Check if user has Officer Role
        if (interaction.channelId !== this.pvpKingChannelID) {
            return requirePvpChannel(interaction, this.pvpKingChannelID, 'pvp_crown');
        }
        const { guild } = interaction;
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID, this.pvpWarriorRoleID];
        if (!memberHasAnyRole(interaction.member, allowedRoles)) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        // Crown has slightly different rules than the normal "find one king" helper:
        // no current king is allowed, but multiple current kings must be fixed manually.
        const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
        if (!kingRole) {
            return interaction.reply({ content: '### ❌  PvP King role not found! Needs to be fixed manually!', flags: MessageFlags.Ephemeral });
        }

        const newKing = interaction.options.getMember('user');
        if (!newKing) {
            return interaction.reply({ content: '### ❌  User not found.', flags: MessageFlags.Ephemeral });
        }
        setInteractionContext(interaction, { targetId: newKing.id });
        if (this.onCooldown?.(interaction.user.id, 'crown', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        setInteractionContext(interaction, { phase: 'acknowledging crown' });
        await interaction.deferReply();
        const logChannel = getLogChannel(guild, this.logChannelID);
        setInteractionContext(interaction, { phase: 'checking King roles' });
        await refreshGuildMembers(interaction.guild, '/pvp_crown');

        const kings = kingRole.members;
        if (kings.size > 1) {
            if (logChannel) {
                const now = formatNowMinute();
                await logChannel.send(
                    `**🚨 <@${this.ownerID}> — Multiple PvP Kings Detected in ${this.pvpServerName}!**\n` +
                    `**${kingRole.members.size} members** currently have the PvP King role.\n` +
                    `This needs to be fixed manually before crowning a new king! (${now})`
                );
            }

            return interaction.editReply({
                content:
                    `❌ **Error:** There are currently **${kingRole.members.size} members** with the PvP King role.\n` +
                    `Please fix this manually before crowning a new king!`
            });
        }

        let crownSaved = false;
        const failedUpdates = [];
        const discordStep = async (label, work) => {
            setInteractionContext(interaction, { phase: label });
            try {
                return await work();
            } catch (error) {
                failedUpdates.push(label);
                // REST errors contain credentials and request bodies; log only safe identifiers.
                console.warn(`[CC LOG] PvP ${label} failed; the crown is saved:`, {
                    interactionId: interaction.id, code: interactionErrorCode(error)
                });
                return null;
            }
        };
        try {
            // IF New King Crowned, OR Current King defends their crown
            const oldKing = kings.first();
            const isDefense = oldKing && oldKing.id === newKing.id;

            // A rejected storage call can have an uncertain commit outcome.
            setInteractionContext(interaction, { phase: 'saving crown', crownSaved: undefined });
            const crownResult = await this.db.recordCrownEvent({
                newKingId: newKing.id,
                newKingName: newKing.displayName,
                oldKingId: oldKing?.id,
                oldKingName: oldKing?.displayName,
                isDefense
            });
            crownSaved = true;
            setInteractionContext(interaction, { crownSaved: true });

            // Discord changes happen only after storage succeeds.
            if (!isDefense) {
                await discordStep('King role updates', async () => {
                    // Preserve the old King if assigning the new King's role fails.
                    await newKing.roles.add(this.pvpKingRoleID, `Command /pvp_crown: crown assigned by ${interaction.user.username}`);
                    if (oldKing) await oldKing.roles.remove(this.pvpKingRoleID, `Command /pvp_crown: previous crown replaced by ${interaction.user.username}`);
                });

                // Add secondary role ONCE to all first-time PvP Kings
                if (!newKing.roles.cache.has(this.pvpWarriorRoleID)) {
                    await discordStep('Warrior role update', () => newKing.roles.add(this.pvpWarriorRoleID, `Command /pvp_crown: warrior reward assigned by ${interaction.user.username}`));
                }

                const usersToNotify = (crownResult.usersToNotify ?? []).map(row => `<@${row.challenger_id}>`);
                // If any challengers have an active cooldown against the fallen King AND enabled notifications, then send notifications to waiting challengers!
                if (oldKing && usersToNotify.length > 0 && this.pvpKingChannelID) {
                    const pvpKingChannel = guild.channels.cache.get(this.pvpKingChannelID);
                    if (pvpKingChannel) {
                        const logoFile = new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' });
                        const pvpKingCdEmbed = new EmbedBuilder()
                            .setColor(this.pvpServerColor)
                            .setTitle(`🔔 PvP Cooldowns Cleared! — ${this.pvpServerName} ${this.pvpServerEmoji}`)
                            .setThumbnail(newKing.displayAvatarURL({ size: 256 }))
                            .setDescription(
                                `### ${this.pvpServerEmoji} The PvP Throne in ${this.pvpServerName} has been claimed by <@${newKing.id}>!\n` +
                                `The reign of **${oldKing.displayName}** has ended. **All cooldowns have been reset**, and you may now challenge the new PvP King! ⚔️`
                            )
                            .addFields(
                                { name: '👑 New PvP King', value: `<@${newKing.id}>`, inline: true },
                                { name: 'Old PvP King', value: `<@${oldKing.id}>`, inline: true }
                            )
                            .setFooter({ text: `CC PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                            .setTimestamp();

                        for (const content of splitMessageParts(usersToNotify, ' ')) {
                            await discordStep('cooldown notification', () => pvpKingChannel.send({
                                content,
                                embeds: [pvpKingCdEmbed],
                                files: [logoFile],
                                allowedMentions: { parse: ['users'] }
                            }));
                        }
                    }
                }
            }

            // Get current King's Win Streak
            const stats = crownResult.stats;
            const totalWins = stats?.total_wins || 0;
            const streak = stats?.current_streak || 0;
            const longest = stats?.longest_streak || 0;

            // Public Feedback Message
            const oldKingTag = oldKing ? `<@${oldKing.id}> ` : '*No previous PvP King!*';
            const attachment = new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' });
            const crownEmbed = new EmbedBuilder()
                .setDescription(`### 👑\u2002 <@${newKing.id}> ${isDefense ? 'defended' : 'conquered'} the PvP Throne in ${this.pvpServerName}\u2002${isDefense ? '🛡️' : '⚔️'}`)
                .addFields(
                    { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: false },
                    { name: `⚔️\u2002Longest Streak: ${longest}`, value: `\u2002`, inline: false },
                    { name: `🏆\u2002Total Wins: ${totalWins}`, value: '\u2002', inline: false },
                )
                .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                .setThumbnail(newKing.displayAvatarURL())
                .setFooter({ text: `CC PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                .setTimestamp();

            if (!isDefense) {
                crownEmbed.addFields(
                    { name: 'Former King', value: oldKingTag, inline: true },
                    { name: 'New King', value: `👑\u2002 <@${newKing.id}>\u2002👑`, inline: true });
            }

            const crownMessage = await discordStep('public crown response', () => interaction.editReply({
                embeds: [crownEmbed],
                files: [attachment]
            }));

            // Event announcements cannot roll back an already saved crown.
            await discordStep('event announcement', () => announceEventWinner(this.eventConfig, interaction, newKing));

            // Log Event to Log Channel
            if (logChannel) {
                const crownEmbedLog = new EmbedBuilder()
                    .setDescription(
                        `### 🏆\u2002 <@${interaction.user.id}> used the \`/pvp_crown\` command!\u2002🤖\n` +
                        `- Server: **${this.pvpServerName}** ${this.pvpServerEmoji}\n` +
                        `- Event Type: **${isDefense ? 'Defense 🛡️' : 'Crown 👑'}**\n` +
                        `- Target Member: <@${newKing.id}>\n` +
                        (crownMessage?.url ? `### [🔗 Jump to ${isDefense ? 'Defense Message 🛡️' : 'Crown Message 👑'}](${crownMessage.url})`
                            : '- Public response could not be published; the result is saved.')
                    )
                    .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: `CC PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                    .setTimestamp();

                if (!isDefense) {
                    crownEmbedLog.addFields(
                        { name: 'Former King', value: oldKingTag, inline: true },
                        { name: 'New King', value: `👑\u2002<@${newKing.id}>\u2002👑`, inline: true }
                    );
                }

                await discordStep('crown audit log', () => logChannel.send({
                    embeds: [crownEmbedLog],
                    files: [attachment]
                }));
            }

            // Log to History Thread
            await discordStep('history thread entry', async () => {
                const historyThread = await interaction.guild.channels.fetch(this.historyThreadID);
                if (!(historyThread instanceof ThreadChannel)) {
                    throw Object.assign(new Error('PvP history thread is unavailable.'), { code: 'PVP_HISTORY_UNAVAILABLE' });
                }

                const crownEmbedEntry = new EmbedBuilder()
                    .setDescription(`### 👑\u2002<@${newKing.id}> ${isDefense ? 'defended' : 'conquered'} the PvP Throne in ${this.pvpServerName}!\u2002${isDefense ? '🛡️' : '⚔️'}`)
                    .addFields(
                        { name: `🔥\u2002Current Win Streak: ${streak}`, value: '\u2002', inline: true },
                        { name: `🏆\u2002Total Wins: ${totalWins}`, value: `\u2002`, inline: true },
                    )
                    .setColor(isDefense ? 0x9b59b6 : this.pvpServerColor)
                    .setThumbnail(newKing.displayAvatarURL())
                    .setFooter({ text: `CC PvP King System • ${this.pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                    // Match history to the saved event even if Discord updates took time.
                    .setTimestamp(crownResult.history?.created_at ? utcEventDate(crownResult.history.created_at) : new Date());

                await historyThread.send({
                    embeds: [crownEmbedEntry],
                    files: [attachment]
                });
            });
            if (failedUpdates.length) {
                await discordStep('saved-result warning', () => interaction.editReply({
                    content: `### ⚠️ The PvP result is saved, but some Discord updates failed (${failedUpdates.join(', ')}).\n`
                        + 'Do not run `/pvp_crown` again for this battle. Officers should check the King roles and `/pvp_history`.'
                }));
            }
            setInteractionContext(interaction, { phase: failedUpdates.length ? 'saved with Discord update failures' : 'complete' });
        } catch (err) {
            console.error(`[CC LOG] PvP crown failed; ${crownSaved ? 'the crown is saved' : 'save status is uncertain'}:`, {
                interactionId: interaction.id, code: interactionErrorCode(err)
            });
            const message = crownSaved
                ? '### ⚠️ The PvP result is saved, but Discord updates were incomplete. Do not run `/pvp_crown` again for this battle. Officers should check the King roles and `/pvp_history`.'
                : '### ⚠️ Could not confirm that the PvP result was saved. Check `/pvp_history` before retrying.';
            if (interaction.replied || interaction.deferred) {
                return interaction.editReply({ content: message });
            }
            return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    }
}

module.exports = wrapPvpServerCommand(PvpCrownKing);
