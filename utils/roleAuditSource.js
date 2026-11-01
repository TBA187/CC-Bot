// Identify role changes made by bot commands, rewards and self-role panels.
'use strict';

const { selfRoleChannelID } = require('../config.json');

function rolePanelReason(interaction, detail) {
    const channelId = interaction.channelId || interaction.channel?.id;
    // Only Crow Control's own role handlers use this marker. Channel equality is
    // checked again when rendering, along with the audit executor and target.
    return `[CC role panel user=${interaction.user.id} channel=${channelId || 'unknown'}] ${detail}`.slice(0, 512);
}

function roleSource(entry, member, botId, channelId = selfRoleChannelID) {
    if (!entry?.executor?.bot) return null;
    const reason = entry.reason || '';
    const panel = /^\[(?:CC|WW) role panel user=(\d+) channel=(\d+)\] (.*)$/u.exec(reason);
    if (entry.executor.id === botId && panel?.[1] === member.id) {
        return { kind: panel[2] === channelId ? 'self_panel' : 'other_panel', channelId: panel[2], detail: panel[3] };
    }
    if (entry.executor.id === botId) {
        if (/^XP level reward:/u.test(reason)) return { kind: 'automatic', detail: reason };
        if (/^Command /u.test(reason)) return { kind: 'command', detail: reason };
        if (/(?:^| )game-server preference(?: settings)?$/u.test(reason)) return { kind: 'settings', detail: 'Game-server preference settings' };
        if (/color role/i.test(reason)) return { kind: 'automatic', detail: reason };
    }
    return { kind: 'bot', detail: 'The bot did not provide a command, panel, or event source.' };
}

module.exports = { rolePanelReason, roleSource };
