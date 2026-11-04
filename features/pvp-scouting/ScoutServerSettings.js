// Keeps game-server preferences and Discord server roles in step across settings panels.
'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { rolePanelReason } = require('../../utils/roleAuditSource.js');

const SERVERS = Object.freeze({
    gold: Object.freeze({ label: 'Gold', emoji: { id: '1555743525759356948', name: 'gold' },
        markup: '<:gold:1555743525759356948>', roleKey: 'goldRoleID', color: 0xc9a227 }),
    silver: Object.freeze({ label: 'Silver', emoji: { id: '1555743603567886478', name: 'silver' },
        markup: '<:silver:1555743603567886478>', roleKey: 'silverRoleID', color: 0x9fc1ff }),
    cross: Object.freeze({ label: 'Cross Server', emoji: '🔗', markup: '🔗', color: 0x7c5cfc })
});
const memberJobs = new Map();

function guildSettingsDenial(interaction, config) {
    if (!interaction.inGuild?.()) return 'outside_guild';
    if (String(interaction.guildId || interaction.guild?.id || '') !== String(config.guildId || '')) return 'wrong_guild';
    const roles = interaction.member?.roles;
    const permittedRoles = [config.guildMemberRoleID, config.officerRoleID, config.adminRoleID, config.leaderRoleID]
        .filter(Boolean).map(String);
    const allowed = permittedRoles.some(id => roles?.cache?.has(id) || (Array.isArray(roles) && roles.includes(id)))
        || Boolean((interaction.memberPermissions || interaction.member?.permissions)?.has?.(PermissionFlagsBits.Administrator));
    return allowed ? null : 'missing_guild_role';
}

function canUseGuildSettings(interaction, config) { return guildSettingsDenial(interaction, config) === null; }

function permissionError(reason, interaction, config, stage) {
    const roles = interaction.member?.roles;
    return Object.assign(new Error('No permission!'), {
        code: 'SCOUT_SERVER_FORBIDDEN', permissionReason: reason, permissionStage: stage,
        reason: reason === 'outside_guild' ? 'The interaction was not used inside a Discord server.'
            : reason === 'wrong_guild' ? 'The interaction was used outside the configured Crow Control Discord server.'
                : 'The member has none of the configured member or staff roles and does not have Discord Administrator permission.',
        checkedRoleIds: Array.isArray(roles) ? [...roles] : [...(roles?.cache?.keys?.() || [])],
        requiredRoleIds: [config.guildMemberRoleID, config.officerRoleID, config.adminRoleID, config.leaderRoleID].filter(Boolean).map(String)
    });
}

function serverSelectionFailureMessage(error) {
    if (error.code !== 'SCOUT_SERVER_FORBIDDEN') return error.message === 'No permission!' ? 'No permission!' : null;
    return error.permissionReason === 'missing_guild_role'
        ? 'No permission! These server settings require a Crow Control member or staff role, or Discord Administrator permission.'
        : 'No permission! These server settings are only available in the Crow Control Discord server.';
}

function logServerSelectionFailure(interaction, server, error) {
    const safe = value => String(value ?? 'Unknown').replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/gu, ' ').slice(0, 300);
    const denied = error.code === 'SCOUT_SERVER_FORBIDDEN';
    const ids = [interaction.guildId || interaction.guild?.id, interaction.channelId, interaction.message?.id];
    const context = [
        `User: ${safe(interaction.user?.username)} (${safe(interaction.user?.id)})`,
        `Selected server: ${safe(SERVERS[server]?.label || server)}`,
        `Guild: ${safe(ids[0])}`,
        `Channel: ${safe(ids[1])}`,
        `Control: ${safe(interaction.customId || interaction.commandName)}`,
        `Reason: ${safe(error.reason || error.message)}`
    ];
    if (ids.every(id => /^\d+$/.test(String(id || '')))) context.push(`Panel message: https://discord.com/channels/${ids.join('/')}`);
    if (denied) {
        context.push(`Permission check: ${safe(error.permissionStage)}`,
            `Member role IDs: ${safe(error.checkedRoleIds?.join(', ') || 'None')}`,
            `Accepted role IDs: ${safe(error.requiredRoleIds?.join(', ') || 'None configured')}`);
        console.log(`[CC LOG] Server selection denied.\n${context.join('\n')}`);
    } else {
        console.error(`[CC LOG] Server selection failed.\n${context.join('\n')}`, error);
    }
}

function selectionFeedback({ previous, selected }) {
    if (!selected) return `### ${SERVERS[previous].markup} ${SERVERS[previous].label}${previous === 'cross' ? '' : ' Server'} was removed ❌\n\n`
        + 'You currently don\'t have any **Servers** saved! Select a Server by pressing the **Gold**, **Silver**, or **Cross Server** buttons.';
    if (!previous) return `### ${SERVERS[selected].markup} ${SERVERS[selected].label}${selected === 'cross' ? '' : ' Server'} selected ✅`;
    return `### Server changed from **${SERVERS[previous].label}** to ${SERVERS[selected].markup} **${SERVERS[selected].label}**`;
}

class ScoutServerSettings {
    constructor({ config, store }) {
        this.config = config;
        this.store = store;
    }

    canUse(interaction) { return canUseGuildSettings(interaction, this.config); }
    getCachedServer(guildId, userId) { return this.store.getCachedSelectedServer?.(guildId, userId); }
    getSelectedServer(guildId, userId) { return this.store.getSelectedServer(guildId, userId); }
    hydratePreferences(guildId) { return this.store.hydrateSelectedServers(guildId); }

    async select(interaction, server, { toggle = false } = {}) {
        if (!SERVERS[server]) throw new Error('Select Gold, Silver, or Cross Server.');
        const denial = guildSettingsDenial(interaction, this.config);
        // Current member roles are verified below; interaction role data can be stale.
        if (denial && denial !== 'missing_guild_role') throw permissionError(denial, interaction, this.config, 'interaction');
        const key = `${interaction.guildId || interaction.guild.id}:${interaction.user.id}`;
        const prior = memberJobs.get(key) || Promise.resolve();
        const job = prior.catch(() => {}).then(() => this.applySelection(interaction, server, toggle))
            .finally(() => { if (memberJobs.get(key) === job) memberJobs.delete(key); });
        memberJobs.set(key, job);
        return job;
    }

    async prepareRoles(interaction) {
        const guild = interaction.guild;
        const roleIds = ['gold', 'silver'].map(server => String(this.config[SERVERS[server].roleKey] || ''));
        if (roleIds.some(id => !id) || roleIds[0] === roleIds[1]) throw new Error('Gold and Silver server roles are not configured correctly.');
        if (!guild?.members?.fetch || !guild?.roles?.fetch) throw new Error('Discord member roles are temporarily unavailable.');
        // Fetch first, before holding a database row lock during the role change.
        const [member, goldRole, silverRole, bot] = await Promise.all([
            guild.members.fetch({ user: interaction.user.id, force: true }),
            guild.roles.fetch(roleIds[0]), guild.roles.fetch(roleIds[1]),
            guild.members.me ? Promise.resolve(guild.members.me) : guild.members.fetchMe()
        ]);
        if (!member || !member.roles?.add || !member.roles?.remove) throw new Error('Could not load your Discord member roles.');
        const freshInteraction = { guildId: interaction.guildId || guild.id, guild, inGuild: () => true, member,
            memberPermissions: member.permissions || interaction.memberPermissions };
        const denial = guildSettingsDenial(freshInteraction, this.config);
        if (denial) throw permissionError(denial, freshInteraction, this.config, 'current member roles');
        if (!bot?.permissions?.has(PermissionFlagsBits.ManageRoles)) throw new Error('The bot needs Manage Roles permission to select a server.');
        const highest = bot.roles?.highest;
        for (const role of [goldRole, silverRole]) {
            if (!role || role.managed || !highest || highest.comparePositionTo(role) <= 0) {
                throw new Error('Gold and Silver roles must be below the bot\'s highest role.');
            }
        }
        return { guild, member, roleIds, auditReason: /^(?:cc|ww):auto_roles:/u.test(interaction.customId || '')
            ? rolePanelReason(interaction, 'Select game-server roles') : 'Crow Control game-server preference settings' };
    }

    async applySelection(interaction, server, toggle) {
        const prepared = await this.prepareRoles(interaction);
        const guildId = String(interaction.guildId || interaction.guild.id);
        const userId = String(interaction.user.id);
        let previousServer = null;
        let rolesStarted = false;
        try {
            return await this.store.setSelectedServer(guildId, prepared.member, server, {
                toggle,
                beforeCommit: async ({ previous, selected }) => {
                    previousServer = previous;
                    rolesStarted = true;
                    await this.syncRoles(prepared, this.rolesFor(selected));
                }
            });
        } catch (error) {
            if (rolesStarted) {
                // A lost commit response can leave the transaction outcome uncertain.
                // Read the saved preference before deciding which roles to restore.
                // The locked preference is a safer fallback than the original
                // role set, which might not match the saved preference.
                let expectedRoles = this.rolesFor(previousServer);
                let preferenceKnown = false;
                try {
                    const saved = await this.store.getSelectedServer(guildId, userId, { fresh: true });
                    expectedRoles = this.rolesFor(saved);
                    preferenceKnown = true;
                } catch (readError) {
                    console.error(`[CC LOG] Could not verify server preference after a failed selection for ${userId}:`, readError);
                }
                try {
                    await this.syncRoles(prepared, expectedRoles);
                    if (!preferenceKnown) console.error(`[CC LOG] Server roles were restored for ${userId}, but MySQL could not confirm the saved server preference.`);
                } catch (roleError) {
                    console.error(`[CC LOG] Could not reconcile server roles after a failed selection for ${userId}:`, roleError);
                    error.rolesUnresolved = true;
                }
            }
            throw error;
        }
    }

    rolesFor(selected) {
        const servers = selected === 'cross' ? ['gold', 'silver'] : selected ? [selected] : [];
        return new Set(servers.map(server => String(this.config[SERVERS[server].roleKey])));
    }

    async syncRoles(prepared, expectedRoles) {
        let member = await prepared.guild.members.fetch({ user: prepared.member.id || prepared.member.user.id, force: true });
        const reason = prepared.auditReason;
        // Singular role routes preserve unrelated roles and remove the old server first.
        for (const id of prepared.roleIds) if (!expectedRoles.has(id) && member.roles.cache.has(id)) {
            member = await member.roles.remove(id, reason);
        }
        for (const id of expectedRoles) if (!member.roles.cache.has(id)) member = await member.roles.add(id, reason);
        member = await prepared.guild.members.fetch({ user: prepared.member.id || prepared.member.user.id, force: true });
        if (prepared.roleIds.some(id => member.roles.cache.has(id) !== expectedRoles.has(id))) {
            throw new Error('Discord could not confirm the selected server role. Please try again.');
        }
        prepared.member = member;
    }
}

module.exports = { ScoutServerSettings, SERVERS, canUseGuildSettings, selectionFeedback,
    logServerSelectionFailure, serverSelectionFailureMessage };
