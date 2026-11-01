// Defines configurable PvP King events and announces each server's first qualifying streak.
const { createHash } = require('node:crypto');
const { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const announcementQueues = new WeakMap();
const announcedEvents = new WeakMap();

function utcEventDate(value) {
    if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) throw new Error('Invalid PvP event UTC date.');
        return value;
    }
    const text = String(value || '');
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
        ? text.replace(' ', 'T') + 'Z' : text;
    if (!/T.*Z$/.test(normalized)) throw new Error('PvP event dates must use UTC (YYYY-MM-DDTHH:mm:ssZ).');
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== normalized.slice(0, 19)) {
        throw new Error('Invalid PvP event UTC date.');
    }
    return date;
}

function configuredEvent(config) {
    const server = config.pvpServer || 'gold';
    const raw = config.pvpKingEvents?.[server];
    if (!raw || raw.enabled !== true) return null;
    if (!/^[a-z0-9_-]{1,64}$/i.test(raw.id || '')) throw new Error('PvP events need a unique id (letters, numbers, hyphens or underscores).');
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 100) throw new Error('PvP event names must contain 1–100 characters.');
    if (!Number.isSafeInteger(raw.targetStreak) || raw.targetStreak < 1) throw new Error('PvP event targetStreak must be a positive integer.');
    if (!Number.isSafeInteger(raw.rewardCoinCapsules) || raw.rewardCoinCapsules < 0) throw new Error('PvP event rewardCoinCapsules must be a nonnegative integer.');
    if (!/^\d{17,20}$/.test(raw.announcementChannelID || '')) throw new Error('PvP event announcementChannelID must be a Discord channel ID.');
    const start = utcEventDate(raw.startDate);
    const end = raw.endDate ? utcEventDate(raw.endDate) : null;
    if (end && end <= start) throw new Error('PvP event endDate must be after startDate.');
    const sqlDate = date => date.toISOString().slice(0, 19).replace('T', ' ');
    return { ...raw, server, startDate: sqlDate(start), endDate: end ? sqlDate(end) : null };
}

function findEventWinner(rows, event) {
    let kingId = null;
    let wins = [];
    const start = utcEventDate(event.startDate);
    const end = event.endDate ? utcEventDate(event.endDate) : null;
    for (const row of rows) {
        const date = utcEventDate(row.created_at);
        if (date < start || (end && date > end)) continue;
        if (String(row.king_id) !== kingId) {
            kingId = String(row.king_id);
            wins = [];
        }
        wins.push(row);
        if (wins.length >= event.targetStreak) return {
            winnerId: kingId, winnerName: row.king_name, endDate: row.created_at, wins: [...wins]
        };
    }
    return null;
}

async function loadEventResults(store, event, now = new Date()) {
    const cutoff = event.endDate && utcEventDate(event.endDate) < now ? event.endDate
        : now.toISOString().slice(0, 19).replace('T', ' ');
    const history = await store.eventHistorySince(event.startDate, cutoff, { inclusiveStart: true });
    const winner = findEventWinner(history, event);
    // Stop at the winning row, including only that row when several wins share a second.
    const winningIndex = winner ? history.indexOf(winner.wins.at(-1)) : -1;
    return { event: winner ? { ...event, ...winner } : event,
        history: winner ? history.slice(0, winningIndex + 1) : history, winner };
}

function configuredEventSummary(event, now = new Date()) {
    const status = event.winnerId ? 'Finished' : now < utcEventDate(event.startDate) ? 'Scheduled'
        : event.endDate && now > utcEventDate(event.endDate) ? 'Closed — no qualifying winner' : 'In progress';
    const winnerText = event.winnerId ? '### 🥇 Event Winner: <@' + event.winnerId + '> (' + event.winnerName + ')\n' : '';
    const endText = event.winnerId ? '-# Finished: <t:' + Math.floor(utcEventDate(event.endDate).getTime() / 1000)
        + ':F>. Later victories do not count towards this event.\n' : '';
    return '## ⚔️ ' + event.name + ' — ' + status + '\n' + winnerText
        + '### 🏆 Requirement: ' + event.targetStreak + ' wins in a row\n'
        + '### 🎁 Reward: ' + event.rewardCoinCapsules + ' Coin Capsules\n'
        + '-# Starts: <t:' + Math.floor(utcEventDate(event.startDate).getTime() / 1000) + ':F>'
        + (event.endDate && !event.winnerId ? ' • Ends: <t:' + Math.floor(utcEventDate(event.endDate).getTime() / 1000) + ':F>' : '')
        + '\n' + endText;
}

async function hasEventAnnouncement(channel, botId, marker, startDate) {
    let before;
    const start = utcEventDate(startDate).getTime();
    while (true) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
        const rows = [...messages.values()];
        if (!rows.length) return false;
        if (rows.some(message => message.author?.id === botId
            && message.embeds?.some(embed => embed.footer?.text === marker))) return true;
        const oldest = rows.at(-1);
        if (oldest.createdTimestamp <= start || rows.length < 100) return false;
        if (!oldest.id || oldest.id === before) throw new Error('PvP event announcement history did not advance.');
        before = oldest.id;
    }
}

async function announceEventWinner(config, interaction, newKing) {
    const event = configuredEvent(config);
    if (!event || new Date() < utcEventDate(event.startDate)) return;
    const guild = interaction.guild;
    const marker = 'CC PvP Event • ' + config.pvpServerName + ' • Event ID: ' + event.id;
    const sent = announcedEvents.get(guild) || new Set();
    announcedEvents.set(guild, sent);
    const queues = announcementQueues.get(guild) || new Map();
    announcementQueues.set(guild, queues);
    const previous = queues.get(marker) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
        if (sent.has(marker)) return;
        const { winner } = await loadEventResults(config.pvpKingStorage || config.db, event);
        if (!winner) return;
        const channel = await guild.channels.fetch(event.announcementChannelID);
        if (!channel?.send || !channel.messages?.fetch) throw new Error('PvP event announcement channel is unavailable.');
        const botId = interaction.client?.user?.id || guild.members.me?.id;
        if (!botId) throw new Error('Cannot verify the bot identity for PvP event announcements.');
        if (typeof channel.permissionsFor === 'function'
            && !channel.permissionsFor(guild.members.me || botId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
                ...(event.mentionEveryone === true ? [PermissionFlagsBits.MentionEveryone] : [])])) {
            throw new Error('PvP event announcements require View Channel, Read Message History, Send Messages, Embed Links and Attach Files (plus Mention Everyone when enabled).');
        }
        if (await hasEventAnnouncement(channel, botId, marker, event.startDate)) { sent.add(marker); return; }
        const member = newKing?.id === winner.winnerId ? newKing
            : await guild.members.fetch(winner.winnerId).catch(() => null);
        const victoryLines = winner.wins.map((row, index) => '**' + (index + 1) + '.** <t:'
            + Math.floor(utcEventDate(row.created_at).getTime() / 1000) + ':f>').join('\n');
        const files = [new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' })];
        let description = configuredEventSummary({ ...event, ...winner });
        if (description.length + victoryLines.length + 35 <= 4096) description += '\n**📜 Event Victory Logs:**\n' + victoryLines;
        else {
            files.push(new AttachmentBuilder(Buffer.from(winner.wins.map((row, i) => (i + 1) + '. '
                + utcEventDate(row.created_at).toISOString()).join('\n')), { name: 'event_victories.txt' }));
            description += '\nThe complete event victory log is attached.';
        }
        const embed = new EmbedBuilder().setTitle('🏆 PvP King Event Challenge has concluded! 🏆')
            .setColor(config.pvpServerColor).setDescription(description)
            .setFooter({ text: marker, iconURL: 'attachment://cc_logo.webp' }).setTimestamp();
        if (member) embed.setThumbnail(member.displayAvatarURL());
        await channel.send({
            content: '## <:pepe_king:1455434151262949535> PvP King Event Winner Announcement!\n'
                + '### 👑 Grand Champion: <@' + winner.winnerId + '> • ' + config.pvpServerName + '\n'
                + (event.mentionEveryone === true ? '||@everyone||' : ''),
            embeds: [embed], files,
            allowedMentions: { parse: event.mentionEveryone === true ? ['everyone'] : [], users: [winner.winnerId] },
            nonce: createHash('sha256').update(guild.id + ':' + marker).digest('hex').slice(0, 24), enforceNonce: true
        });
        sent.add(marker);
    });
    queues.set(marker, run);
    try { await run; } finally { if (queues.get(marker) === run) queues.delete(marker); }
}

module.exports = { utcEventDate, configuredEvent, findEventWinner, loadEventResults, configuredEventSummary, announceEventWinner };
