// Manage XP and levels.

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const crypto = require('crypto');
const xpMath = require('../../utils/xpMath');
const xpSettings = require('../../config/xpConfig');
const { resolveXpTrack, fetchXpTrackAutocompleteChoices } = require('../../utils/xpDbHelper');

const ROLE_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function addTrackOption(subcommand) {
    return subcommand.addStringOption(opt => opt
        .setName('track')
        .setDescription('Optional: XP Track to update (leave empty for Global XP)')
        .setAutocomplete(true)
    );
}

function getTrackDescription(trackInfo) {
    if (trackInfo.isGlobal) return 'Global Profile';
    return `Track: **${trackInfo.displayName}** (ID: ${trackInfo.xpType})`;
}

function getDisplayName(member, user) {
    return member?.displayName || user.globalName || user.username;
}

function getRoleToAssignForTrack(trackInfo, member) {
    if (trackInfo.isGlobal || !trackInfo.roleIds?.length) return null;

    const hasAnyTrackRole = trackInfo.roleIds.some(roleId => member.roles.cache.has(roleId));
    if (hasAnyTrackRole) return null;

    return trackInfo.roleIds[0];
}

function buildRoleConfirmationRow(requestId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`levelAdmin_confirm_${requestId}`)
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`levelAdmin_cancel_${requestId}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
    );
}

class LevelAdmin {
    constructor(config) {
        this.name = 'level';
        this.db = config.db;
        this.pendingRoleConfirmations = new Map();
        this.data = new SlashCommandBuilder()
            .setName('level')
            .setDescription('Manage user XP and Levels')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand(sub => addTrackOption(sub
                .setName('add_xp')
                .setDescription('Add additional XP to a user')
                .addUserOption(opt => opt.setName('user').setDescription('Select User').setRequired(true))
                .addIntegerOption(opt => opt.setName('amount').setDescription("Additional XP to add to the user's current XP").setRequired(true).setMinValue(1))
            ))
            .addSubcommand(sub => addTrackOption(sub
                .setName('set_xp')
                .setDescription('Set exact XP for a user')
                .addUserOption(opt => opt.setName('user').setDescription('Select User').setRequired(true))
                .addIntegerOption(opt => opt.setName('amount').setDescription('Total XP amount to set; overwrites existing XP').setRequired(true).setMinValue(0))
            ))
            .addSubcommand(sub => addTrackOption(sub
                .setName('add_level')
                .setDescription('Add additional level(s) to a user')
                .addUserOption(opt => opt.setName('user').setDescription('Select User').setRequired(true))
                .addIntegerOption(opt => opt.setName('amount').setDescription('Levels to add').setRequired(true).setMinValue(1))
            ))
            .addSubcommand(sub => addTrackOption(sub
                .setName('set_level')
                .setDescription('Set exact level for a user')
                .addUserOption(opt => opt.setName('user').setDescription('Select User').setRequired(true))
                .addIntegerOption(opt => opt.setName('amount').setDescription('Level to set').setRequired(true).setMinValue(0))
            ));
    }

    async writeLevelAdjustment(adjustment) {
        await this.db.query(`
            INSERT INTO xp_user_levels (user_id, guild_id, username, xp_type, xp_date, xp_amount, level)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
            ON DUPLICATE KEY UPDATE
                xp_amount = VALUES(xp_amount),
                level = VALUES(level),
                username = VALUES(username),
                xp_date = COALESCE(xp_date, CURRENT_TIMESTAMP)
        `, [
            adjustment.targetId,
            adjustment.guildId,
            adjustment.displayName,
            adjustment.track,
            adjustment.finalXp,
            adjustment.finalLevel
        ]);
    }

    buildSuccessEmbed(adjustment) {
        return new EmbedBuilder()
            .setTitle('Level Admin Adjustment')
            .setColor('#2ecc71')
            .setDescription(`Successfully updated <@${adjustment.targetId}>.`)
            .addFields(
                { name: 'Target Track', value: adjustment.trackDesc, inline: false },
                { name: 'New Level', value: `${adjustment.finalLevel}`, inline: true },
                { name: 'New Total XP', value: `${adjustment.finalXp}`, inline: true }
            )
            .setFooter({ text: 'Crow Control' })
            .setTimestamp();
    }

    createPendingRoleConfirmation(adjustment) {
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
            this.pendingRoleConfirmations.delete(requestId);
        }, ROLE_CONFIRMATION_TTL_MS);
        timeout.unref?.();

        this.pendingRoleConfirmations.set(requestId, { ...adjustment, timeout });
        return requestId;
    }

    clearPendingRoleConfirmation(requestId) {
        const pending = this.pendingRoleConfirmations.get(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        this.pendingRoleConfirmations.delete(requestId);
        return pending;
    }

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getUser('user');
        let targetMember = interaction.options.getMember('user');
        const amount = interaction.options.getInteger('amount');
        const trackInput = interaction.options.getString('track');

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!targetMember) {
            targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        }

        if (!targetMember) {
            return interaction.editReply('Could not find that user as a server member.');
        }

        const displayName = getDisplayName(targetMember, target);

        const trackInfo = await resolveXpTrack(this.db, trackInput);
        if (!trackInfo) {
            return interaction.editReply('Track not found. Select a valid XP track from autocomplete, or leave the track option empty for Global XP.');
        }

        const track = trackInfo.xpType;
        const trackDesc = getTrackDescription(trackInfo);

        try {
            let finalXp = 0;
            let finalLevel = 0;
            let currentXp = 0;
            let currentLevel = 0;

            if (sub.includes('add')) {
                const [rows] = await this.db.query(
                    'SELECT xp_amount, level FROM xp_user_levels WHERE user_id = ? AND guild_id = ? AND xp_type = ?',
                    [target.id, interaction.guild.id, track]
                );

                if (rows.length > 0) {
                    currentXp = rows[0].xp_amount;
                    currentLevel = rows[0].level;
                }
            }

            if (sub === 'add_xp') {
                finalXp = currentXp + amount;
                finalLevel = xpMath.getLevelFromTotalXp(finalXp);
            } else if (sub === 'set_xp') {
                finalXp = amount;
                finalLevel = xpMath.getLevelFromTotalXp(amount);
            } else if (sub === 'add_level') {
                finalLevel = currentLevel + amount;
                finalXp = xpMath.getTotalXpForLevel(finalLevel);
            } else if (sub === 'set_level') {
                finalLevel = amount;
                finalXp = xpMath.getTotalXpForLevel(amount);
            }

            if (xpSettings.levelFormula.maxLevel && finalLevel > xpSettings.levelFormula.maxLevel) {
                return interaction.editReply(`Level cannot exceed the configured max level of ${xpSettings.levelFormula.maxLevel}.`);
            }

            const adjustment = {
                adminId: interaction.user.id,
                targetId: target.id,
                guildId: interaction.guild.id,
                displayName,
                track,
                trackDesc,
                trackName: trackInfo.displayName,
                finalXp,
                finalLevel
            };

            const roleIdToAssign = getRoleToAssignForTrack(trackInfo, targetMember);
            if (roleIdToAssign) {
                const requestId = this.createPendingRoleConfirmation({ ...adjustment, roleIdToAssign });
                return interaction.editReply({
                    content: `${target} doesn't have the <@&${roleIdToAssign}> role required for the this XP Track: **${trackInfo.displayName} (ID: ${trackInfo.xpType})**\n### \u26A0\uFE0F Proceeding will automatically assign the required role to ${target}`,
                    components: [buildRoleConfirmationRow(requestId)]
                });
            }

            await this.writeLevelAdjustment(adjustment);
            const embed = this.buildSuccessEmbed(adjustment);

            return interaction.editReply({ embeds: [embed] });
        } catch (err) {
            console.error('[CC LOG] Level Admin database error:', err);
            return interaction.editReply('Database error. Check console.');
        }
    }

    async handleButton(interaction) {
        const match = interaction.customId.match(/^levelAdmin_(confirm|cancel)_(.+)$/);
        if (!match) return false;

        const [, action, requestId] = match;
        const pending = this.pendingRoleConfirmations.get(requestId);

        if (!pending) {
            await interaction.update({
                content: 'This level-admin confirmation expired. Run the command again if you still want to make the change.',
                embeds: [],
                components: []
            });
            return true;
        }

        if (interaction.user.id !== pending.adminId) {
            await interaction.reply({
                content: 'Only the admin who started this adjustment can confirm it.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        this.clearPendingRoleConfirmation(requestId);

        if (action === 'cancel') {
            await interaction.update({
                content: 'Cancelled. No level changes were made.',
                embeds: [],
                components: []
            });
            return true;
        }

        await interaction.deferUpdate();

        try {
            const targetMember = await interaction.guild.members.fetch(pending.targetId).catch(() => null);
            if (!targetMember) {
                return interaction.editReply({
                    content: 'Could not find that user as a server member. No level changes were made.',
                    embeds: [],
                    components: []
                });
            }

            if (!targetMember.roles.cache.has(pending.roleIdToAssign)) {
                await targetMember.roles.add(
                    pending.roleIdToAssign,
                    `Command /level: XP-Track confirmation by ${interaction.user.tag}`
                );
            }

            await this.writeLevelAdjustment(pending);
            const embed = this.buildSuccessEmbed(pending);

            return interaction.editReply({
                content: '',
                embeds: [embed],
                components: []
            });
        } catch (err) {
            console.error('[CC LOG] Level Admin role confirmation error:', err);
            return interaction.editReply({
                content: 'Could not assign the required role or update the database. No level changes were completed. Check console.',
                embeds: [],
                components: []
            });
        }
    }

    async handleAutocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const choices = await fetchXpTrackAutocompleteChoices(this.db, focusedValue);
        await interaction.respond(choices).catch(() => { });
    }
}

module.exports = LevelAdmin;
