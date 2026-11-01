// Record member joins with profile details and available membership history.
'use strict';

const { buildMemberAuditPayload, auditActor, formatDiscordTime } = require('../utils/memberAuditEmbeds.js');
const { GuildMemberFlags, UserFlags } = require('discord.js');

function suppliedUserFlag(user, flag) {
    const bits = user.flags?.bitfield;
    if (flag === undefined || (typeof bits !== 'bigint' && !Number.isSafeInteger(bits))) return false;
    // UserFlagsBitField.has uses 32-bit number operators in this discord.js
    // version; quarantine is bit 44, so inspect the supplied bits with BigInt.
    return (BigInt(bits) & BigInt(flag)) === BigInt(flag);
}

function exactAccountAge(ageMs) {
    let seconds = Math.max(0, Math.floor(ageMs / 1000));
    const parts = [];
    for (const [name, size] of [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
        const value = Math.floor(seconds / size);
        seconds %= size;
        if (value || (name === 'second' && !parts.length)) parts.push(`${value} ${name}${value === 1 ? '' : 's'}`);
    }
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

function joinSafetyFields(member, joinedAt, warningHours) {
    const fields = [], created = member.user.createdTimestamp;
    const warning = (name, value) => fields.push({ name: `⚠️ **${name}**`, value, inline: false });
    const age = joinedAt - created;
    if (Number.isFinite(age) && age >= 0 && age < warningHours * 3600000) {
        fields.push({ name: '⚠️ **NEW ACCOUNT** ⚠️', value: `New account created ${exactAccountAge(age)} ago!`, inline: false });
    }
    if (member.user.bot) warning('Account Type', 'Bot account.');
    if (member.pending === true) warning('Membership Screening', 'Pending — the member has not completed the server requirements.');
    if (member.flags?.has(GuildMemberFlags.AutomodQuarantinedUsernameOrGuildNickname)) {
        warning('Discord AutoMod', 'Username, display name, or server nickname is blocked by AutoMod.');
    }
    if (member.flags?.has(GuildMemberFlags.AutoModQuarantinedGuildTag)) warning('Discord AutoMod', 'Server tag is blocked by AutoMod.');
    // These are supplied by discord.js when present, but are not guaranteed
    // public API fields. Absence must never be presented as a safety verdict.
    if (suppliedUserFlag(member.user, UserFlags.Spammer)) warning('Discord Safety Flag', 'Discord supplied a spammer flag.');
    if (suppliedUserFlag(member.user, UserFlags.Quarantined)) warning('Discord Safety Flag', 'Discord supplied an account quarantine flag.');
    return fields;
}

function buildMemberJoinPayload(member, context, { newAccountWarningHours = 48 } = {}) {
    const rejoined = context.rejoined;
    const unbanned = context.kind === 'unbanned';
    const extraContext = [];
    let actionText = `${rejoined ? 'rejoined' : 'joined'} Crow Control's Discord Server!`;
    if (unbanned) {
        actionText = `${rejoined ? 'rejoined' : 'joined'} Crow Control's Discord Server after being unbanned!`;
        if (context.unban.executor) extraContext.push(`- **Unbanned By:** ${auditActor(context.unban.executor)}`);
        extraContext.push(`- **Unbanned At:** ${formatDiscordTime(context.unban.at)}`);
    } else if (rejoined) {
        const labels = { left: 'Left voluntarily', kicked: 'Kicked', banned: 'Banned', unknown: 'Not recorded or could not be confirmed' };
        extraContext.push(`- **Previous Departure:** ${labels[context.kind] ?? labels.unknown}`);
    }
    if (rejoined && context.departure?.at) extraContext.push(`- **Previously Left:** ${formatDiscordTime(context.departure.at)}`);
    const createdAt = member.user.createdTimestamp;
    const threshold = Number.isFinite(newAccountWarningHours) && newAccountWarningHours >= 0 ? newAccountWarningHours : 48;
    return buildMemberAuditPayload({
        authorName: rejoined ? `Member Rejoined ${unbanned ? '🔓' : '🔄'}` : 'Member Joined 🎉',
        member, actionText, afterActionLines: extraContext,
        warningFields: joinSafetyFields(member, context.joinedAt, threshold),
        color: unbanned ? 0x00BFA5 : rejoined ? 0x1ABC9C : 0x2ECC71,
        detailFields: [
            { name: 'Account Created', value: `-# ${formatDiscordTime(createdAt, true, 'd')}` },
            { name: 'Joined Server', value: `-# ${formatDiscordTime(context.joinedAt, true, 'd')}` }
        ],
        memberCount: member.guild.memberCount
    });
}

async function handleMemberJoin(member, config) {
    if (config.guildId && member.guild.id !== config.guildId) return;
    config.memberHistory.beginJoin(member);
    try {
        await config.memberHistory.loadMember(member.guild.id, member.id);
        await config.memberHistory.waitForDeparture(member);
        if (config.shutdownSignal?.aborted) return;
        const context = config.memberHistory.recordJoin(member);
        if (!context || !config.logChannelID) return;
        const channel = member.guild.channels.cache.get(config.logChannelID) || await member.guild.channels.fetch(config.logChannelID);
        if (channel?.isTextBased()) await channel.send(buildMemberJoinPayload(member, context, config));
    } catch (error) { console.error('Member join audit failed:', error); }
    finally { config.memberHistory.finishJoin(member); }
}

module.exports = { register(client, config) { client.on('guildMemberAdd', member => handleMemberJoin(member, config)); },
    handleMemberJoin, buildMemberJoinPayload };
