// Reverses the latest confirmed crown event after an Officer reviews the affected King.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLogChannel, requireAnyRole, stopIfOnCooldown } = require('./utils/pvpHelper.js');
const { findCrownHistoryMessage } = require('./utils/pvpHistoryMessages.js');

class PvpReverse {

    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_reverse";
        this.db = config.pvpKingStorage || config.db;
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.logChannelID = config.logChannelID;
        this.historyThreadID = config.historyThreadID;
        this.ownerID = config.ownerID;
        this.client = config.client;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('pvp_reverse')
            .setDescription('Reverse the last PvP Crown and restore the previous king with correct data (Officers only)');
    }

    async execute(interaction) {
        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!await requireAnyRole(interaction, allowedRoles)) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            console.log("------------------------------------------");
            console.log('"/pvp_reverse" command used!');

            const { guild } = interaction;
            const logChannel = getLogChannel(guild, this.logChannelID);

            // 1) Get the last Crowned PvP King
            let wrongKing = await this.db.latestHistory();

            if (!wrongKing) {
                return interaction.editReply('### ⚠️ No PvP crown history found to reverse.');
            }

            console.log('Wrong King: ', wrongKing);

            // 2) Get the previous King BEFORE wrong crown
            let prevKing = await this.db.latestHistory(1);
            console.log('Previous King: ', prevKing);

            // 3) Send confirmation message with buttons
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_reverse')
                    .setLabel('✅ Confirm')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('cancel_reverse')
                    .setLabel('❌ Cancel')
                    .setStyle(ButtonStyle.Danger)
            );

            let prevKingTag = prevKing?.king_id ? `(<@${prevKing.king_id}>)` : '';
            let type = 'Crown 👑';
            let typeTxt = 'Crowned:';
            let reverseWarningTxt = 'This will restore the Crown back to the previous PvP King';
            if (prevKing?.king_id == wrongKing.king_id) {
                type = 'Defense 🛡️';
                typeTxt = 'Defended Crown:';
                reverseWarningTxt = 'This will undo the PvP stats for the Throne defender';
            }

            const last_crowned_time = wrongKing.created_at
                ? `<t:${Math.floor(new Date(wrongKing.created_at).getTime() / 1000)}:F>`
                : '*Error loading time!*';

            // Live countdown timer
            const now = Math.floor(Date.now() / 1000);
            const countdownSeconds = 60; // 1 min
            const endTime = now + countdownSeconds;

            const message = await interaction.editReply({
                content: `# ⚠️  Warning — ${this.pvpServerName} ${this.pvpServerEmoji}\n## Are you sure you want to reverse the last PvP Crown event of <@${wrongKing.king_id}> in ${this.pvpServerName}?\n` +
                    `- **Event Type:** ${type}\n` +
                    `- **${typeTxt}** ${last_crowned_time}\n` +
                    `### ℹ️  ${reverseWarningTxt} ${prevKingTag} and update the database accordingly!\n` +
                    `_ _\n⏳ Bot will auto decline the request in **<t:${endTime}:R>** for security purposes!`,
                components: [row]
            });

            // 4) Create a collector to handle button interaction
            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, time: 60000, max: 1 }); // 1 min

            collector.on('collect', async i => {
                let reversalSaved = false;
                try {
                    if (i.customId === 'confirm_reverse') {
                        // Permissions can change while the confirmation is open.
                        if (!await requireAnyRole(i, allowedRoles)) return;
                        await i.update({ content: `🔄 Reversing PvP Crown of wrong King: **${wrongKing.king_name}...**`, components: [] });

                        // Resolve the entry before reversal can allow another crown with the same stats.
                        let historyEntry;
                        let historyLookupError;
                        try {
                            const thread = await this.client.channels.fetch(this.historyThreadID);
                            if (!thread || !thread.isThread()) throw new Error('PvP history thread is unavailable.');
                            historyEntry = await findCrownHistoryMessage(thread, {
                                history: wrongKing,
                                serverName: this.pvpServerName,
                                botUserId: this.client.user?.id
                            });
                        } catch (error) {
                            // Discord lookup failures must not prevent the database reversal.
                            historyLookupError = error;
                        }

                        let reverseResult;
                        try {
                            reverseResult = await this.db.reverseLatestCrownEvent({ expectedHistoryId: wrongKing.id });
                        } catch (err) {
                            if (err.code === 'PVP_STALE_REVERSE') {
                                return await interaction.editReply({
                                    content: '### ⚠️ The latest PvP crown changed before this reverse could finish.\n- Nothing was changed. Run `/pvp_reverse` again to review the newest crown event.',
                                    components: []
                                });
                            }

                            console.warn('[CC LOG] PvP reversal save could not be confirmed:', err.code || err.name);
                            return await interaction.editReply({
                                content: '### ⚠️ Could not confirm that the PvP reversal was saved. Check `/pvp_history` before retrying.',
                                components: []
                            });
                        }

                        reversalSaved = true;
                        wrongKing = reverseResult.wrongKing;
                        prevKing = reverseResult.prevKing;
                        console.log("1) DELETE wrong King FROM pvp_king_history: ", reverseResult.delHistoryRes?.affectedRows ?? 0);
                        console.log("2) UPDATE wrong King in pvp_king_stats: ", reverseResult.statsResult?.affectedRows ?? 0);
                        if (reverseResult.statsConsoleMsg) console.log(`2) Conditions: ${reverseResult.statsConsoleMsg}`);

                        // 7) Update Discord roles
                        const kingRole = interaction.guild.roles.cache.get(this.pvpKingRoleID);
                        if (!kingRole) throw new Error('PvP King role is unavailable.');
                        // Keep the current role assigned if restoring the previous King fails.
                        if (prevKing) {
                            const newMember = await interaction.guild.members.fetch(prevKing.king_id);
                            if (!newMember) throw new Error('Previous PvP King member is unavailable.');
                            await newMember.roles.add(kingRole, `Command /pvp_reverse: restore crown by ${interaction.user.username}`);
                        }
                        if (prevKing?.king_id !== wrongKing.king_id) {
                            const wrongMember = await interaction.guild.members.fetch(wrongKing.king_id).catch(error => {
                                if (error.code === 10007) return null;
                                throw error;
                            });
                            if (wrongMember) await wrongMember.roles.remove(kingRole, `Command /pvp_reverse: reverse crown by ${interaction.user.username}`);
                        }

                        console.log("5) UPDATE pvp_king_cooldowns to remove cooldowns against the wrong King: ", reverseResult.resetCooldownResult?.affectedRows ?? 0);

                        // Delete only the entry identified before the confirmed storage change.
                        if (historyLookupError) throw historyLookupError;
                        if (!historyEntry.message) {
                            throw Object.assign(new Error('The crown history entry could not be identified safely.'), {
                                code: 'PVP_HISTORY_UNCONFIRMED', historyStatus: historyEntry.status
                            });
                        }
                        await historyEntry.message.delete();
                        console.log('6) Deleted the matching crown message in Discord History Thread!');

                        const executorName = interaction.user.displayName;
                        const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

                        // Error handling: If no Previous King found!
                        if (!prevKing) {
                            console.log("No Previous King found!");

                            // Log to Discord Log Channel
                            if (logChannel) {
                                await logChannel.send(
                                    `## 🚨  PvP Crown reversed in ${this.pvpServerName} ${this.pvpServerEmoji} (${now})\n` +
                                    `- **${executorName}** successfully reversed the last PvP Crown of **<@${wrongKing.king_id}>**\n` +
                                    `### ❌ No previous King found to assign the PvP King role!\n` +
                                    `### <@${this.ownerID}> - No Members currently have the PvP King role. Assign it manually!\n` +
                                    `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                                    `### ✅  All stats for the wrong King are restored correctly in the database!`
                                );
                            }

                            // User feedback message
                            return await interaction.editReply(
                                `## 🚨  PvP Crown reversed in ${this.pvpServerName} ${this.pvpServerEmoji} (${now})\n` +
                                `- The last PvP Crown of **<@${wrongKing.king_id}>** has been successfully reversed!\n` +
                                `### ❌ However, no previous King found to assign the PvP King role! Assign it manually to a new King with the */pvp_crown* command!\n` +
                                `### ✅ All stats for the wrong King are restored correctly in the database!`
                            );
                        }

                        console.log("7) UPDATE pvp_king_stats for previous King: ", reverseResult.prevKingResult?.affectedRows ?? 0);

                        const last_crowned_time = wrongKing.created_at
                            ? `<t:${Math.floor(new Date(wrongKing.created_at).getTime() / 1000)}:F>`
                            : '*Error loading time!*';
                        let type = 'Crown 👑';
                        let typeTxt = 'Crowned:';
                        let reverseTxt = `The PvP King role has been successfully restored back to <@${prevKing.king_id}>`;
                        if (prevKing.king_id == wrongKing.king_id) {
                            type = 'Defense 🛡️';
                            typeTxt = 'Defended Crown:';
                            reverseTxt = `The PvP stats for <@${prevKing.king_id}> has been successfully reverted.`;
                        }

                        // Log to Discord Log Channel
                        if (logChannel) {
                            await logChannel.send(
                                `## 🚨  PvP Crown reversed in ${this.pvpServerName} ${this.pvpServerEmoji} (${now})\n` +
                                `- **${executorName} reversed the last PvP Crown event of <@${wrongKing.king_id}>**\n` +
                                `- **Event Type:** ${type}\n` +
                                `- **${typeTxt}** ${last_crowned_time}\n` +
                                `### ✅  ${reverseTxt}\n` +
                                `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                                `### ✅  All stats are updated correctly in the database!`
                            );
                        }

                        console.log("✅ PvP Reversal Success!");
                        console.log("------------------------------------------");

                        // Private executor message
                        await interaction.editReply({
                            content: `### ✅  Reversal complete!\n- Check log for more information: <#${this.logChannelID}>`,
                            components: []
                        });

                        // Send new public message to the channel
                        return await interaction.channel.send(
                            `## 🚨  PvP Crown reversed in ${this.pvpServerName} ${this.pvpServerEmoji} (${now})\n` +
                            `- **${executorName} reversed the last PvP Crown event of <@${wrongKing.king_id}>**\n` +
                            `- **Event Type:** ${type}\n` +
                            `- **${typeTxt}** ${last_crowned_time}\n` +
                            `### ✅  ${reverseTxt}\n` +
                            `### ✅  Wrong King Log deleted in <#${this.historyThreadID}>\n` +
                            `### ✅  All stats are updated correctly in the database!`
                        );

                    } else if (i.customId === 'cancel_reverse') {
                        await i.update({ components: [] });
                        await i.followUp({
                            content: '### ❌  PvP Crown reversal canceled!',
                            ephemeral: true
                        });

                        console.log("User canceled PvP Crown reversal!");
                        console.log("------------------------------------------");
                    }
                } catch (error) {
                    console.warn('[CC LOG] PvP reversal control failed:', error.code || error.name);
                    await interaction.editReply({
                        content: reversalSaved
                            ? '### ⚠️ The reversal is saved, but Discord updates were incomplete. Do not run `/pvp_reverse` again for this event. Officers should check the King roles and `/pvp_history`.'
                                + (error.code === 'PVP_HISTORY_UNCONFIRMED'
                                    ? `\nThe matching crown entry could not be identified safely in <#${this.historyThreadID}>. No history message was deleted; an Officer should check that thread manually.` : '')
                            : '### ⚠️ The reversal could not be completed. Check `/pvp_history` before trying again.',
                        components: []
                    }).catch(() => {});
                }
            });

            collector.on('end', collected => {
                if (!collected.size) {
                    interaction.editReply({ content: '### ⌛  PvP Crown reversal timed out *(1 minute)* and has been automatically canceled!\n- You can try again.', components: [] }).catch(() => {});

                    console.log("PvP Crown reversal timed out!");
                    console.log("------------------------------------------");
                }
            });
        } catch (err) {
            console.error(err);
            return interaction.editReply('### ⚠️ Failed to reverse the last PvP crown! Try again.');
        }

    }
}

module.exports = wrapPvpServerCommand(PvpReverse);
