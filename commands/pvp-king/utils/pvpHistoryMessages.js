// Finds a crown's own history entry without deleting later moderator posts.
const { utcEventDate } = require('./pvpEvent.js');

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
// Older entries used the send time after role changes and announcements finished.
const DELIVERY_WINDOW_MS = 15 * 60 * 1000;

function embedData(embed) {
    return typeof embed?.toJSON === 'function' ? embed.toJSON() : embed?.data || embed || {};
}

function matchesCrownEntry(message, history, serverName, botUserId, eventTime) {
    if (message.author?.id !== botUserId || message.webhookId) return false;
    const sentAt = message.createdTimestamp;
    if (!Number.isFinite(sentAt) || sentAt < eventTime || sentAt > eventTime + DELIVERY_WINDOW_MS) return false;

    const action = history.type === 'defense' ? 'defended' : 'conquered';
    const icon = history.type === 'defense' ? '🛡️' : '⚔️';
    const descriptions = [`### 👑 <@${history.king_id}> ${action} the PvP Throne in ${serverName}! ${icon}`];
    const footers = [`CC PvP King System • ${serverName}`];
    if (serverName === 'Gold') {
        // Gold history predates the separate Silver commands and server labels.
        descriptions.push(`### 👑 <@${history.king_id}> ${action} the PvP Throne! ${icon}`);
        footers.push('CC PvP King System', 'CC PvP King Dominion');
    }
    footers.push(...footers.map(footer => footer.replace(/^CC /u, 'WW ')));

    return (message.embeds || []).some(rawEmbed => {
        const embed = embedData(rawEmbed);
        const description = String(embed.description || '').replace(/\s+/gu, ' ').trim();
        if (!descriptions.includes(description) || !footers.includes(embed.footer?.text)) return false;
        const stampedAt = Date.parse(embed.timestamp);
        if (!Number.isFinite(stampedAt) || stampedAt < eventTime || stampedAt > eventTime + DELIVERY_WINDOW_MS) return false;
        const fields = (embed.fields || []).map(field => String(field.name || '').replace(/\s+/gu, ' ').trim());
        return fields.includes(`🔥 Current Win Streak: ${history.streak_after}`)
            && fields.includes(`🏆 Total Wins: ${history.total_wins_after}`);
    });
}

async function findCrownHistoryMessage(thread, { history, serverName, botUserId }) {
    let eventTime;
    try {
        eventTime = utcEventDate(history?.created_at).getTime();
    } catch {
        return { status: 'missing', message: null };
    }
    if (!botUserId || !history?.king_id || !['Gold', 'Silver'].includes(serverName)
        || !['crown', 'defense'].includes(history.type)
        || !Number.isInteger(Number(history.streak_after)) || !Number.isInteger(Number(history.total_wins_after))) {
        return { status: 'missing', message: null };
    }

    const candidates = new Map();
    const seenIds = new Set();
    let before;
    for (let page = 0; page < MAX_PAGES; page++) {
        const collection = await thread.messages.fetch({ limit: PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
        const messages = [...collection.values()];
        let newMessages = 0;
        for (const message of messages) {
            if (!message.id || seenIds.has(message.id)) continue;
            seenIds.add(message.id);
            newMessages++;
            if (matchesCrownEntry(message, history, serverName, botUserId, eventTime)) candidates.set(message.id, message);
        }
        if (candidates.size > 1) return { status: 'ambiguous', message: null };

        // Finish the time window before accepting a candidate, including page boundaries.
        const reachedEarlierMessages = messages.some(message => Number.isFinite(message.createdTimestamp) && message.createdTimestamp < eventTime);
        if (messages.length < PAGE_SIZE || reachedEarlierMessages) {
            return candidates.size === 1
                ? { status: 'found', message: candidates.values().next().value }
                : { status: 'missing', message: null };
        }
        const oldestId = messages.at(-1)?.id;
        if (!newMessages || !oldestId || oldestId === before) break;
        before = oldestId;
    }
    // A bounded or stalled scan cannot establish that a match is unique.
    return { status: 'incomplete', message: null };
}

module.exports = { findCrownHistoryMessage };
