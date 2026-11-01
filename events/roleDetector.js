// Log role and member-role changes while tracking their audit sources.
'use strict';

const { AuditLogEvent, AttachmentBuilder, EmbedBuilder, Events } = require('discord.js');
const path = require('node:path');
const { findModerationAuditEntry } = require('./memberExit.js');
const { buildMemberAuditPayload, auditActor, inlineCode } = require('../utils/memberAuditEmbeds.js');
const { ServerTagRoleManager, serverTagStatus, POLICY_REASON_PREFIX } = require('../utils/serverTagRoleManager.js');
const { sleep } = require('../utils/logHelpers.js');
const { roleSource } = require('../utils/roleAuditSource.js');

function changedRole(entry, roleId, added) {
    return entry.changes?.some(change => change.key === (added ? '$add' : '$remove') &&
        Array.isArray(change.new) && change.new.some(role => String(role.id) === String(roleId)));
}

function roleLines(roles, added, mixed = false) {
    if (!roles.length) return [];
    const label = `- ${mixed ? `**${added ? '+' : '-'}** ` : ''}**Role${roles.length > 1 ? 's' : ''} ${added ? 'Added' : 'Removed'}:**`;
    const format = role => `<@&${role.id}> (\`${role.id}\`)`;
    return roles.length === 1 ? [`${label} ${format(roles[0])}`] : [label, ...roles.map(role => `  - ${format(role)}`)];
}

function buildRoleAuditPayload(member, { addedRoles = [], removedRoles = [], entry, source, definitionDeleted = false }) {
    const roles = [...addedRoles, ...removedRoles], mixed = addedRoles.length > 0 && removedRoles.length > 0;
    const added = addedRoles.length > 0;
    const lines = [...roleLines(addedRoles, true, mixed), ...roleLines(removedRoles, false, mixed)];
    if (definitionDeleted) lines.push('- **Removal Context:** The role itself was deleted from the server.');
    let actionText = mixed ? `had roles updated by ${auditActor(entry?.executor)}`
        : `had ${roles.length > 1 ? 'roles' : 'a role'} ${added ? 'added' : 'removed'} by ${auditActor(entry?.executor)}`;
    if (source?.kind === 'self_panel') {
        actionText = `${mixed ? 'updated their self-assigned roles' : added ? 'self-assigned roles' : 'self-removed roles'} using the role selection panel.`;
        lines.push(`- **Role Selection Panel:** <#${source.channelId}>`, `- **Roles Updated By:** ${auditActor(entry.executor)}`);
    } else if (source?.kind === 'other_panel') lines.push(`- **Action Source:** Role panel in <#${source.channelId}>`, `- **Roles Updated By:** ${auditActor(entry.executor)}`);
    else if (source?.kind === 'command' || source?.kind === 'settings') lines.push(`- **Action Source:** ${source.detail}`);
    else if (source?.kind === 'automatic') lines.push(`- **Action Source:** Automatic event — ${source.detail}`);
    else if (entry?.executor?.bot) lines.push(`- **Action Source:** ${source?.detail || 'Bot role update — the command, panel, or event was not supplied.'}`);
    else if (roles.every(role => role.managed)) lines.push('- **Action Source:** Integration-managed role');
    if (!entry?.executor) lines.push('- **Discord Audit Log:** Executor unavailable; the role change was confirmed from member data.');
    return buildMemberAuditPayload({
        authorName: mixed ? 'Member Roles Updated 🔄' : `Member Role${roles.length > 1 ? 's' : ''} ${added ? 'Added 🏷️➕' : 'Removed 🏷️➖'}`,
        member, actionText,
        color: mixed ? 0x5865F2 : added ? 0x57F287 : 0xED4245,
        reason: source && source.kind !== 'bot' ? undefined : entry?.reason?.trim() || undefined, extraLines: lines, showUserDetails: false
    });
}

function buildCcRolePayload(member, { role, added, entry, enforcement }) {
    if (typeof enforcement?.enabled === 'boolean' && enforcement.enabled !== added) {
        const corrected = enforcement.status === 'corrected';
        return buildMemberAuditPayload({ authorName: corrected
            ? `CC Role ${added ? 'Addition Intercepted 🏷️➖' : 'Removal Intercepted 🏷️➕'}` : 'CC Role Correction Pending 🔄', member,
            actionHeading: `${auditActor(entry?.executor)} tried to ${added ? 'give' : 'remove'} the Crow Control role ${added ? 'to' : 'from'} <@${member.id}>.` +
                (corrected ? ` the bot intercepted the change and ${added ? 'removed the role again' : 'restored the role'}!` : ''),
            color: corrected ? added ? 0xED4245 : 0x57F287 : 0x5865F2,
            reason: enforcement.enabled ? 'This member is wearing the CC Server Tag and must keep the Crow Control role.'
                : 'This member is not wearing the CC Server Tag and cannot have the Crow Control role.',
            showUserDetails: false,
            extraLines: corrected ? [...roleLines([role], !added), '- **Correction Status:** Confirmed by Discord.']
                : [`- **Role:** <@&${role.id}> (\`${role.id}\`)`,
                    `- **Correction Status:** ${enforcement.status === 'compliant' ? 'The role already matches the current tag.' : 'Not completed — ' + (enforcement.error || 'verification will retry automatically.')}`] });
    }
    const payload = buildRoleAuditPayload(member, { addedRoles: added ? [role] : [], removedRoles: added ? [] : [role], entry });
    if (!enforcement || enforcement.enabled === undefined) payload.embeds[0].setDescription(payload.embeds[0].data.description +
        '\n- **CC Role Verification:** Pending — the current server tag could not be confirmed. The bot will retry automatically.');
    return payload;
}

function buildCcCorrectionPayload(member, { added, role, source, reason, success, error }, bot) {
    const label = success ? added ? 'CC Role Assigned / Restored 🏷️➕' : 'CC Role Removed 🏷️➖' : 'CC Role Correction Failed 🔄';
    const triggers = { tag_update: 'Server tag changed', role_update: 'Member roles changed', join: 'Member joined', startup: 'Bot startup', periodic: 'Scheduled verification' };
    return buildMemberAuditPayload({ authorName: label, member,
        actionText: success ? `had the Crow Control role ${added ? 'assigned or restored' : 'removed'} by ${auditActor(bot)}`
            : 'needs a Crow Control role correction that the bot could not complete.',
        color: success ? added ? 0x57F287 : 0xED4245 : 0x5865F2,
        reason: reason?.replace(`${POLICY_REASON_PREFIX} `, ''), showUserDetails: false,
        extraLines: [...(success ? roleLines([role], added) : [`- **Role:** <@&${role.id}> (\`${role.id}\`)`,
            `- **Requested Role Action:** ${added ? 'Assign / restore' : 'Remove'}`]), `- **Server Tag:** ${added ? 'Equipped' : 'Not equipped'}`,
            `- **Check Trigger:** ${triggers[source] || 'Policy verification'}`,
            success ? `- **Correction Status:** Confirmed — the role is ${added ? 'present' : 'absent'}.`
                : `- **Correction Status:** Failed — ${inlineCode(String(error).slice(0, 512))}`] });
}

function buildCcTagPayload(member, equipped) {
    return buildMemberAuditPayload({ authorName: `CC Server Tag ${equipped ? 'Equipped 🏷️➕' : 'Removed 🏷️➖'}`,
        member, actionText: `${equipped ? 'equipped' : 'removed'} the CC Server Tag!`,
        color: equipped ? 0x57F287 : 0xED4245, showUserDetails: false,
        extraLines: [`- **Server Tag:** ${equipped ? 'Equipped' : 'Not equipped'}`] });
}

function buildCcRepresentativePayload(member, config) {
    const embed = new EmbedBuilder().setTitle('New Crow Control Representative 🎉').setColor(0x9B59B6)
        .setDescription(`### Big shoutout to <@${member.id}> for equipping the CC Server Tag!\n` +
            '- Your Crow Control role, name color, and Murkrow icon are managed automatically.\n' +
            `-# If you would like to change your name color or icon, you can contact <@${config.ownerID}>`)
        .setFooter({ text: `User ID: ${member.id}`, iconURL: 'attachment://cc_logo.webp' }).setTimestamp();
    return { content: `<@${member.id}>`, embeds: [embed],
        files: [new AttachmentBuilder(path.join(__dirname, '../images/cc_logo.webp'), { name: 'cc_logo.webp' })],
        allowedMentions: { parse: [], users: [member.id] } };
}

async function getChannel(guild, id) {
    if (!id) return null;
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id);
    return channel?.isTextBased() ? channel : null;
}

async function sendStaff(member, config, payload) {
    const channel = await getChannel(member.guild, config.logChannelID);
    if (channel) await channel.send(payload);
}

async function handleRoleUpdate(oldMember, newMember, config) {
    if (config.guildId && newMember.guild.id !== config.guildId) return;
    const policy = config.serverTagRoleManager;
    // Enforcement runs independently of log-channel availability and audit access.
    if (oldMember.partial || !oldMember.roles?.cache || !newMember.roles?.cache) return policy?.request(newMember);
    const eventTime = Date.now();
    const changes = [
        ...[...newMember.roles.cache.values()].filter(role => role.id !== newMember.guild.id && !oldMember.roles.cache.has(role.id)).map(role => ({ role, added: true })),
        ...[...oldMember.roles.cache.values()].filter(role => role.id !== newMember.guild.id && !newMember.roles.cache.has(role.id)).map(role => ({ role, added: false }))
    ].filter(change => change.role.id !== config.ccRoleID || !policy?.consumeExpectedChange(newMember, change.added));
    const ccChanged = changes.some(change => change.role.id === config.ccRoleID);
    const check = policy?.request(newMember, { reportCorrection: !ccChanged });
    if (!changes.length) return check;
    try {
        const channel = await getChannel(newMember.guild, config.logChannelID);
        if (!channel) return check;
        await sleep(1200);
        const resolved = await Promise.all(changes.map(async change => {
            const definitionDeleted = !change.added && !newMember.guild.roles.cache.has(change.role.id);
            const entry = await findModerationAuditEntry(newMember.guild,
                definitionDeleted ? AuditLogEvent.RoleDelete : AuditLogEvent.MemberRoleUpdate,
                definitionDeleted ? change.role.id : newMember.id,
                { eventTime, matches: candidate => definitionDeleted || changedRole(candidate, change.role.id, change.added) });
            return { ...change, entry, definitionDeleted };
        }));
        const groups = new Map();
        for (const change of resolved) {
            if (change.role.id === config.ccRoleID && !change.definitionDeleted) {
                if (change.entry?.executor?.id === config.client.user?.id && change.entry.reason?.startsWith(POLICY_REASON_PREFIX)) continue;
                await channel.send(buildCcRolePayload(newMember, { ...change, enforcement: await check }));
                continue;
            }
            const key = `${change.definitionDeleted}:${change.entry?.id || 'unknown'}`;
            if (!groups.has(key)) groups.set(key, { ...change, source: roleSource(change.entry, newMember, config.client.user?.id, config.selfRoleChannelID), changes: [] });
            groups.get(key).changes.push(change);
        }
        for (const group of groups.values()) {
            for (let index = 0; index < group.changes.length; index += 10) {
                const batch = group.changes.slice(index, index + 10);
                await channel.send(buildRoleAuditPayload(newMember, { ...group,
                    addedRoles: batch.filter(change => change.added).map(change => change.role),
                    removedRoles: batch.filter(change => !change.added).map(change => change.role) }));
            }
        }
    } catch (error) { console.error('Member role audit failed:', error); }
    return check;
}

async function handleCcTagUpdate(oldUser, newUser, config) {
    if (!config.guildId || !config.serverTagRoleManager) return;
    const before = oldUser.partial ? undefined : serverTagStatus(oldUser, config.guildId);
    const equipped = serverTagStatus(newUser, config.guildId);
    if (equipped === undefined || before === equipped) return;
    try {
        const guild = config.client.guilds.cache.get(config.guildId);
        if (!guild) return;
        const member = guild.members.cache.get(newUser.id) || await guild.members.fetch(newUser.id).catch(() => null);
        if (member) await config.serverTagRoleManager.request(member, { user: newUser, previousTag: before,
            source: 'tag_update', trustEvent: true });
    } catch (error) { console.error('CC server tag audit failed:', error); }
}

module.exports = {
    register(client, config) {
        if (config.serverTagRoleManager) return;
        const manager = new ServerTagRoleManager({ client, guildId: config.guildId, roleId: config.ccRoleID, signal: config.shutdownSignal,
            onTagChange: async (member, equipped) => {
                const jobs = [sendStaff(member, config, buildCcTagPayload(member, equipped))];
                if (equipped) jobs.push((async () => {
                    const welcome = await getChannel(member.guild, config.welcomeChannelID);
                    if (welcome) await welcome.send(buildCcRepresentativePayload(member, config));
                })());
                const results = await Promise.allSettled(jobs);
                for (const result of results) if (result.status === 'rejected') console.error('CC tag notification failed:', result.reason);
            },
            onCorrection: (member, correction) => sendStaff(member, config, buildCcCorrectionPayload(member, correction, client.user)) });
        config.serverTagRoleManager = manager;
        client.on(Events.GuildMemberUpdate, (oldMember, newMember) => { void handleRoleUpdate(oldMember, newMember, config); });
        client.on(Events.UserUpdate, (oldUser, newUser) => { void handleCcTagUpdate(oldUser, newUser, config); });
        client.on(Events.GuildMemberAdd, member => { void manager.request(member, { source: 'join' }); });
        client.on(Events.GuildMemberRemove, member => manager.forget(member));
        manager.start();
    },
    handleRoleUpdate, handleCcTagUpdate, buildRoleAuditPayload, buildCcRolePayload, buildCcTagPayload,
    buildCcCorrectionPayload, buildCcRepresentativePayload
};
