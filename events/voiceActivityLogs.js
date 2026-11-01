'use strict';

const { buildMemberAuditPayload } = require('../utils/memberAuditEmbeds.js');

function buildVoicePayload(member, oldChannelId, newChannelId, counts = {}) {
    const moved = oldChannelId && newChannelId;
    const actionText = moved ? `moved from <#${oldChannelId}> to <#${newChannelId}>.`
        : newChannelId ? `joined <#${newChannelId}>.` : `left <#${oldChannelId}>.`;
    const payload = buildMemberAuditPayload({ member, actionText, showUserDetails: false,
        authorName: moved ? 'Member Moved Voice Channel 🔄' : newChannelId ? 'Member Joined Voice Channel 🎙️' : 'Member Left Voice Channel 🎙️',
        color: moved ? 0x5865F2 : newChannelId ? 0x57F287 : 0xED4245 });
    const count = value => Number.isInteger(value) && value >= 0 ? value : 'Unavailable';
    const text = moved ? `Members in Voice Channels: Previous ${count(counts.old)} • New ${count(counts.new)}`
        : `Members in Voice Channel: ${count(newChannelId ? counts.new : counts.old)}`;
    payload.embeds[0].setFooter({ text, iconURL: 'attachment://ww_logo.png' });
    return payload;
}

async function handleVoiceStateUpdate(oldState, newState, config) {
    const oldChannelId = oldState.channelId, newChannelId = newState.channelId;
    if (oldChannelId === newChannelId || (!oldChannelId && !newChannelId)) return;
    const guild = newState.guild || oldState.guild;
    const member = newState.member || oldState.member;
    if (!guild || !member || (config.guildId && guild.id !== config.guildId) || !config.botChannelID) return;
    const states = guild.voiceStates?.cache;
    const counts = { old: states && oldChannelId ? 0 : undefined, new: states && newChannelId ? 0 : undefined };
    if (states) for (const state of states.values()) {
        if (state.channelId === oldChannelId && oldChannelId) counts.old++;
        if (state.channelId === newChannelId && newChannelId) counts.new++;
    }
    const payload = buildVoicePayload(member, oldChannelId, newChannelId, counts);
    const channel = guild.channels.cache.get(config.botChannelID) || await guild.channels.fetch(config.botChannelID);
    if (channel?.isTextBased() && !config.shutdownSignal?.aborted) {
        await channel.send(payload);
    }
}

module.exports = { name: 'voiceStateUpdate', execute: handleVoiceStateUpdate, buildVoicePayload };
