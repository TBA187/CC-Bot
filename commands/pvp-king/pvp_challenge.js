// Confirms a member's challenge and lets the current King accept or decline it.
const { wrapPvpServerCommand } = require('./utils/pvpServers.js');
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { getServerLogo, getServerBanner, pvpThumnbnail, pvpBannerImage, createPvpFooter, createPvpLogFooter } = require('./utils/pvpAssets.js');
const { formatNowMinute, requirePvpChannel, resolveSinglePvpKing, stopIfOnCooldown } = require('./utils/pvpHelper.js');

class PvpChallengeKing {
    constructor(config) {
        this.pvpServerName = config.pvpServerName;
        this.pvpServerEmoji = config.pvpServerEmoji;
        this.pvpServerColor = config.pvpServerColor;
        this.name = "pvp_challenge";
        this.db = config.pvpKingStorage || config.db;
        this.pvpKingRoleID = config.pvpKingRoleID;
        this.logChannelID = config.logChannelID;
        this.pvpKingChannelID = config.pvpKingChannelID;
        this.ownerID = config.ownerID;
        //this.activeChallenge = null;
        this.challengeTimeouts = config.challengeTimeouts;
        this.onCooldown = config.onCooldown;
        this.pendingResponses = new Set();

        this.data = new SlashCommandBuilder()
            .setName('pvp_challenge')
            .setDescription('Challenge the current PvP King');
    }

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (await stopIfOnCooldown(interaction, this.onCooldown, 'currentking', 2)) return;

        if (!await requirePvpChannel(interaction, this.pvpKingChannelID, 'pvp_challenge')) return;
        
        // Auto-clear stale lock (15 minutes - Discord Limitation)
        //if (activeChallenge && Date.now() - activeChallenge.startedAt > 900000) {
        //   activeChallenge = null;
        //}

        //if (activeChallenge) {
        //    return interaction.editReply({ content: '⚔️ A PvP challenge is already active. Please wait until it finishes.' });
        //}

        try {
            const now = formatNowMinute();
            const kingCheck = await resolveSinglePvpKing(interaction, {
                pvpKingRoleID: this.pvpKingRoleID,
                logChannelID: this.logChannelID,
                ownerID: this.ownerID,
                now,
                contextLabel: '/pvp_challenge',
                missingRoleLog: `**🚨 <@${this.ownerID}> — No PvP King Role found!**\n- This needs to be fixed asap! (${now})`,
                missingRoleReply: '### ❌ PvP King Role not found! Officers have been notified and will resolve the issue as soon as possible.',
                noKingReply: '### ⚠️ No PvP King found. Officers have been notified and will resolve the issue as soon as possible.',
                multipleKingsLog: kings => `### 🚨 <@${this.ownerID}> — A user tried to challenge the PvP King but failed.\n- **Error:** Multiple PvP Kings detected **(${kings.size})** — (${now})`,
                multipleKingsReply: kings => `### ⚠️ There are currently: "${kings.size}" PvP Kings. This must be fixed before challenges can proceed.\n- **Officers have been notified and will resolve the issue as soon as possible.**`
            });
            if (!kingCheck.ok) return;

            const currentKing = kingCheck.currentKing;

            if (interaction.user.id === currentKing.id) {
                return interaction.editReply({
                    content: '### ❌ You cannot challenge yourself!'
                });
            }

            try {
                // Check if challenger has a cooldown (48 hours)
                const cooldown = await this.db.getCooldown(interaction.user.id);
                const lastChallengeKing_id = cooldown?.king_id;
                const lastChallenge = cooldown?.last_challenge;
                if (lastChallenge && lastChallengeKing_id === currentKing.id) {
                    const lastChallengeDate = new Date(lastChallenge + 'Z'); // Z = UTC
                    const now = new Date();
                    const diffMs = now - lastChallengeDate;
                    const cooldownMs = 48 * 60 * 60 * 1000; // (48 hours)
                    const nextChallenge = lastChallengeDate.getTime() + cooldownMs;

                    if (diffMs < cooldownMs) {
                        // Still on cooldown
                        const remainingMs = cooldownMs - diffMs;
                        const hours = Math.floor(remainingMs / (1000 * 60 * 60));
                        const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
                        const unixTime = Math.floor(nextChallenge / 1000);
                        const cooldownEmbed = new EmbedBuilder()
                            .setColor(this.pvpServerColor)
                            .setTitle(`⏳ PvP King Challenge Cooldown Active! — ${this.pvpServerName}`)
                            .setThumbnail(currentKing.displayAvatarURL({ size: 256 }))
                            .setDescription(
                                `### You are still on cooldown against <@${currentKing.id}>\n` +
                                `- Please wait **${hours}h ${minutes}m (<t:${unixTime}:F>)**\n` +
                                `- You can challenge again <t:${unixTime}:R>\n` +
                                `### 🔔 Notification Tip\n` +
                                `- Enable notifications with the \`/pvp_cooldown\` command to get pinged when your cooldown expires!`
                            )
                            .setFooter(createPvpFooter(this.pvpServerName))
                            .setTimestamp();

                        return interaction.editReply({
                            embeds: [cooldownEmbed],
                            files: [getServerLogo()]
                        });
                    }
                }
            } catch (err) {
                console.error(err);
                return interaction.editReply({
                    content: err.code === 'PVP_DATABASE_UNAVAILABLE'
                        ? '### ⚠️ Database is currently unavailable. Please try again later.'
                        : '### ⚠️  Something went wrong. Please try again.'
                });
            }

            //activeChallenge = {
            //    challengerId: interaction.user.id,
            //    kingId: currentKing.id,
            //    startedAt: Date.now()
            //};

            // Confirmation buttons (only visible to challenger)
            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pvp_confirm_yes_${currentKing.id}_${interaction.user.id}`)
                    .setLabel('Yes!')
                    .setStyle(ButtonStyle.Success),

                new ButtonBuilder()
                    .setCustomId(`pvp_confirm_no_${currentKing.id}_${interaction.user.id}`)
                    .setLabel('No!')
                    .setStyle(ButtonStyle.Danger)
            );

            await interaction.editReply({
                content: `## ⚔️  Do you want to challenge the PvP King in ${this.pvpServerName} for the throne?  ${this.pvpServerEmoji}\n- Current PvP King: **👑 <@${currentKing.id}> 👑**\n` +
                    `-# When the PvP King accepts your challenge, you will receive a **48-hour cooldown** before you can challenge **${currentKing.displayName}** again.\n` +
                    `-# If a new PvP King is crowned, the cooldown will reset and you may challenge the new King immediately.`,
                components: [confirmRow]
            });

            // Auto-expire the confirmation buttons after 60 seconds
            if (this.challengeTimeouts.has(interaction.user.id)) {
                clearTimeout(this.challengeTimeouts.get(interaction.user.id));
            }

            const timeout = setTimeout(async () => {
                try {
                    console.log(`Challenge timeout for: ${interaction.user.displayName}`);

                    await interaction.editReply({
                        content: "### ⌛ Challenge request auto expired after 1 minute!\n- You can use the **/pvp_challenge** command again to challenge the PvP King.",
                        components: []
                    });

                } catch { }

                this.challengeTimeouts.delete(interaction.user.id);

            }, 60000);

            this.challengeTimeouts.set(interaction.user.id, timeout);

        } catch (err) {
            console.error(err);
            return interaction.editReply({ content: '### ⚠️ Error executing command.' });
        }
    }

    isCurrentKing(guild, member) {
        const kings = guild.roles.cache.get(this.pvpKingRoleID)?.members;
        return Boolean(member && kings?.size === 1 && kings.first().id === member.id);
    }

    async handleButton(interaction) {
        const parts = String(interaction.customId || '').split('_');
        const [, action, kingId, challengerId] = parts;
        if (parts.length !== 4 || !['accept', 'decline'].includes(action)
            || interaction.user.id !== kingId) return this.handleChallengeButton(interaction);

        const key = `${kingId}:${challengerId}`;
        if (this.pendingResponses.has(key)) {
            await interaction.reply({ content: '### ⏳ This challenge response is already being processed.', flags: MessageFlags.Ephemeral });
            return true;
        }
        // Disabling a button does not stop a second interaction already in flight.
        this.pendingResponses.add(key);
        try {
            return await this.handleChallengeButton(interaction);
        } finally {
            this.pendingResponses.delete(key);
        }
    }

    async handleChallengeButton(interaction) {
        if (!interaction.customId.startsWith("pvp_")) return false;

        const { guild } = interaction;
        const logChannel = guild.channels.cache.get(this.logChannelID);
        if (!logChannel) {
            console.log(' - WARNING: Log channel not found! Channel ID: ' + this.logChannelID);
        }

        // Challenger confirmation buttons: pvp_confirm_yes / pvp_confirm_no
        if (interaction.customId.startsWith('pvp_confirm_')) {
            const parts = interaction.customId.split('_');
            if (parts.length !== 5) return false;

            const [, , action, kingId, challengerId] = parts;

            // Only the challenger can press
            if (interaction.user.id !== challengerId) {
                return interaction.reply({ content: "### ❌  This confirmation isn't for you!", flags: MessageFlags.Ephemeral });
            }

            // Acknowledge before fetching members or publishing the challenge.
            const challengerLoadingRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('pvp_challenger_loading')
                    .setLabel('Summoning the King...')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );

            await interaction.update({ components: [challengerLoadingRow] });

            const timeout = this.challengeTimeouts.get(challengerId);
            if (timeout) {
                // Cancel the PvP challenge timeout!
                clearTimeout(timeout);
                this.challengeTimeouts.delete(challengerId);
            }

            if (action === 'no') {
                console.log(`Challenger cancelled PvP King challenge: ${interaction.user.displayName} against ${kingId}`);
                return interaction.editReply({
                    content: "### ❌  Challenge cancelled.",
                    components: []
                });
            }

            if (action === 'yes') {
                const currentKing = await interaction.guild.members.fetch(kingId).catch(() => null);
                if (!this.isCurrentKing(guild, currentKing)) {
                    return interaction.editReply({
                        content: "### ❌  The PvP King has changed. Use `/pvp_challenge` again.",
                        components: []
                    });
                }

                // Create Accept/Decline Buttons for the PvP King
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`pvp_accept_${kingId}_${challengerId}`)
                        .setLabel('Accept')
                        .setStyle(ButtonStyle.Success),

                    new ButtonBuilder()
                        .setCustomId(`pvp_decline_${kingId}_${challengerId}`)
                        .setLabel('Decline')
                        .setStyle(ButtonStyle.Danger)
                );

                // Send public challenge message
                await interaction.channel.send({
                    content:
                        `## <@&${this.pvpKingRoleID}> has been challenged in ${this.pvpServerName} ${this.pvpServerEmoji}\n\n` +
                        `**🏆 <@${kingId}>**, do you accept the challenge from <@${challengerId}>?\n` +
                        `-# When the PvP King accepts the challenge, a **48 hours cooldown** will be applied to the challenger.\n-# When a new King is Crowned, all active cooldowns will reset and the New King may be challenged immediately!`,
                    components: [row]
                });

                return interaction.editReply({
                    content: "### ⚔️  Challenge sent!  ⚔️",
                    components: []
                });
            }

            return;
        }

        const parts = interaction.customId.split('_');
        if (parts.length !== 4) return;

        const [type, action, kingId, challengerId] = parts;
        const actionType = `${type}_${action}`;
        if (!['pvp_accept', 'pvp_decline'].includes(actionType)) return;

        // Only the King can press buttons
        if (interaction.user.id !== kingId) {
            return interaction.reply({
                content: "### ❌ Not for you! Only the PvP King can press the buttons.",
                flags: MessageFlags.Ephemeral
            });
        }

        // Acknowledge before fetching members or saving the response.
        const kingLoadingRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('pvp_king_loading')
                .setLabel('Processing response...')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );

        await interaction.update({ components: [kingLoadingRow] });

        const currentKing = await interaction.guild.members.fetch(kingId).catch(() => null);
        const challenger = await interaction.guild.members.fetch(challengerId).catch(() => null);
        const unixNow = Math.floor(Date.now() / 1000);

        if (!currentKing || !challenger) {
            const errorMsg = !currentKing && !challenger
                ? 'Both PvP King and Challenger not found!'
                : !currentKing
                    ? 'PvP King not found!'
                    : !challenger
                        ? 'Challenger not found!'
                        : '';

            // Log to Discord Log Channel
            if (logChannel) {
                await logChannel.send(`** ❌ Error:** ${errorMsg}\n- Current King ID: ${kingId}\n- Challenger ID: ${challengerId}`);
            }

            return interaction.editReply({ content: `** ❌ Error:** ${errorMsg}`, flags: MessageFlags.Ephemeral });
        }

        if (!this.isCurrentKing(guild, currentKing)) {
            return interaction.editReply({
                content: '### ❌  The PvP King has changed. Use `/pvp_challenge` again.',
                components: []
            });
        }

        if (actionType === 'pvp_accept') {
            //activeChallenge = null;
            let cooldownSaved = false;
            try {
                const cooldown = await this.db.getCooldown(challengerId);
                const lastChallenge = cooldown?.last_challenge
                    ? new Date(`${cooldown.last_challenge}Z`).getTime() : NaN;
                if (String(cooldown?.king_id) === kingId && Date.now() - lastChallenge < 48 * 60 * 60 * 1000) {
                    await interaction.editReply({
                        content: '### ⏳ This challenger already has an active cooldown against the current PvP King. This request cannot be accepted again.',
                        components: []
                    });
                    return true;
                }
                await this.db.upsertChallengeCooldown(challengerId, challenger.displayName, kingId, currentKing.displayName);
                cooldownSaved = true;

                const acceptEmbed = new EmbedBuilder()
                    .setTitle('<:dark_murkrow:1565243892255694908>\u2002Crow Control Awaken!\u2002<:dark_murkrow:1565243892255694908>')
                    .setDescription(`Winter is coming… the Frozen Throne awaits no mortal. The Crow Control spare none; only the strongest shall endure the frost!\u2002🧊\n\u200B`)
                    .setColor(this.pvpServerColor)
                    .addFields(
                        { name: '👑 The Night King', value: `<@${kingId}>`, inline: true },
                        { name: '🗡️ Frostborn Challenger', value: `<@${challengerId}>`, inline: true }
                        // { name: '📅 🌑 Time of Reckoning', value: `<t:${unixNow}:F>` }
                    )
                    .setThumbnail(currentKing.displayAvatarURL())
                    .setImage(pvpBannerImage)
                    .setFooter(createPvpFooter(this.pvpServerName))
                    .setTimestamp();

                // Send the NEW message first and capture it in a variable
                const newMessage = await interaction.channel.send({
                    content: `## ⚔️  The PvP King in ${this.pvpServerName} (${currentKing.displayName}) accepted a challenge from <@${challengerId}>  ${this.pvpServerEmoji}\n**❄️  Winter decides their fate… all who fall will freeze in its wake!  ❄️**\n\u200B`,
                    embeds: [acceptEmbed],
                    files: [getServerBanner(), getServerLogo()]
                });

                // Edit the OLD message and include the link to the NEW one
                await interaction.editReply({
                    content: `~~${interaction.message.content}~~\n### ✅ Challenge Accepted: <t:${unixNow}:F>\n🔗 **[Jump to Challenge Message](${newMessage.url})**`,
                    components: []
                });

                // Log to Discord Log Channel
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        // .setTitle('🏆\u2002PvP King Challenge Accepted!\u2002🏆')
                        .setDescription(
                            `### 🏆\u2002The PvP King in ${this.pvpServerName} accepted a challenge!\u2002🏆\n` +
                            `**Post-Battle Instructions:**\n` +
                            `-# Once the PvP King battle ends, make sure to check the posted screenshot, or ask the PvP King / Challenger to post a screenshot in <#${this.pvpKingChannelID}>\n` +
                            `### ⚠️\u2002There can be 2 scenarios:\n` +
                            `- **👑\u2002If the challenger wins:**\n   - Use \`/pvp_crown\` targeting <@${challengerId}>\n` +
                            `- **🛡️\u2002If the King defends:**\n   - Use \`/pvp_crown\` targeting <@${kingId}> to log the winning streak 🔥\n` +
                            `### 🔗\u2002Message Link:\u2002[Jump to Acceptance Message](${newMessage.url})\n`
                        )
                        .setColor(this.pvpServerColor)
                        .addFields(
                            { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                            { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                            // { name: '📅 Time of Acceptance', value: `<t:${unixNow}:F>`, inline: true },
                        )
                        .setThumbnail(pvpThumnbnail)
                        .setFooter(createPvpFooter(this.pvpServerName))
                        .setTimestamp();

                    await logChannel.send({
                        embeds: [logEmbed],
                        files: [getServerLogo()]
                    });
                }
            } catch (error) {
                console.warn('[CC LOG] PvP challenge acceptance failed:', error.code || error.name);
                await interaction.editReply({
                    content: cooldownSaved
                        ? '### ⚠️ The challenge was accepted and its cooldown is saved, but some Discord updates failed. Officers should check the challenge messages; do not accept this request again.'
                        : '### ⚠️ Could not confirm that the challenge cooldown was saved. Check `/pvp_cooldown` before trying again.',
                    components: []
                });
            }
        } else if (actionType === 'pvp_decline') {
            //activeChallenge = null;
            const declineEmbed = new EmbedBuilder()
                .setTitle(`❌\u2002PvP King Challenge Declined! — ${this.pvpServerName}`)
                .setDescription(`### <@${kingId}>, please state your reason for declining`)
                .setColor(this.pvpServerColor)
                .addFields(
                    { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                    { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                )
                .setThumbnail(currentKing.displayAvatarURL())
                .setFooter(createPvpFooter(this.pvpServerName))
                .setTimestamp();

            const newMessage = await interaction.channel.send({
                content: `### The PvP King in ${this.pvpServerName} declined the challenge from <@${challengerId}>`,
                embeds: [declineEmbed],
                files: [getServerLogo()]
            });

            await interaction.editReply({
                content: `~~${interaction.message.content}~~\n### ❌ Challenge Declined: <t:${unixNow}:F>\n**🔗 [Jump to Decline Message](${newMessage.url})**`,
                components: []
            });

            if (logChannel) {
                const declineLogEmbed = new EmbedBuilder()
                    .setTitle(`❌\u2002PvP King Challenge Declined! — ${this.pvpServerName}`)
                    .setDescription(`### The PvP King in ${this.pvpServerName} declined a challenge!\n**🔗 [Jump to Decline Message](${newMessage.url})**`)
                    .setColor(this.pvpServerColor)
                    .addFields(
                        { name: '👑 PvP King', value: `<@${kingId}>`, inline: true },
                        { name: '🗡️ Challenger', value: `<@${challengerId}>`, inline: true }
                    )
                    .setThumbnail(pvpThumnbnail)
                    .setFooter(createPvpLogFooter(this.pvpServerName))
                    .setTimestamp();

                await logChannel.send({
                    embeds: [declineLogEmbed],
                    files: [getServerLogo()]
                });
            }
        }
        return true;
    }
}

module.exports = wrapPvpServerCommand(PvpChallengeKing);
