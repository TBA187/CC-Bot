// Log member LEAVE, KICK, BAN, UNBAN, & TIMEOUT changes.
const { AuditLogEvent, Events, escapeMarkdown } = require('discord.js');
const { buildMemberAuditPayload, auditActor, formatDiscordTime } = require('../utils/memberAuditEmbeds.js');
const { fetchGuildMemberRoster } = require('../utils/guildMemberRoster.js');
let memberHistory = null;
const MEMBER_COLORS = {
    left: 0x95A5A6,
    kicked: 0xED2939,
    banned: 0xD30000,
    unbanned: 0xED7117,
    timeout: 0xFA9500,
    timeoutExpired: 0xFFB343,
    timeoutRemoved: 0xFFA51F
};

// activeTimeouts tracks countdowns so the bot can log when timeouts naturally expire.
// The current timeout is also checked on the callback, so a changed timeout cannot produce a stale expiry log.
const activeTimeouts = new Map();
const loggedTimeoutExpiries = new Map();
const recoveringTimeouts = new Map();
let timeoutTrackingStopped = false;

// Guild-scoped state prevents one server's events from affecting another server.
const nicknameCache = new Map();
const recentBanEvents = new Map();
const moderationAuditFetches = new Map();
const MODERATION_AUDIT_MAX_AGE_MS = 30000;
const MODERATION_AUDIT_CACHE_MS = 750;
const BAN_EVENT_CACHE_MS = 30000;
const TIMEOUT_EXPIRY_LOG_CACHE_MS = 60000;
const MAX_TIMEOUT_MS = 2147483647;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function moderationKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function rememberBanEvent(guildId, userId) {
    const key = moderationKey(guildId, userId);
    if (recentBanEvents.get(key)?.active) return false;

    const event = { active: true, createdAt: Date.now() };
    recentBanEvents.set(key, event);
    const timeout = setTimeout(() => {
        if (recentBanEvents.get(key) === event) recentBanEvents.delete(key);
    }, BAN_EVENT_CACHE_MS);
    timeout.unref?.();
    return true;
}

function isRecentBanEvent(guildId, userId, joinedAt = 0) {
    const event = recentBanEvents.get(moderationKey(guildId, userId));
    return Boolean(event && event.createdAt >= (joinedAt ?? 0));
}

async function fetchModerationAuditLogs(guild, actionType) {
    const key = `${guild.id}:${actionType}`;
    const cached = moderationAuditFetches.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const entry = { expiresAt: Date.now() + MODERATION_AUDIT_CACHE_MS, promise: null };
    const discard = () => {
        if (moderationAuditFetches.get(key) === entry) moderationAuditFetches.delete(key);
    };
    entry.promise = guild.fetchAuditLogs({ limit: 100, type: actionType }).catch(error => {
        discard();
        throw error;
    });
    moderationAuditFetches.set(key, entry);
    const timer = setTimeout(discard, MODERATION_AUDIT_CACHE_MS);
    timer.unref?.();
    return entry.promise;
}

async function findModerationAuditEntry(guild, actionType, userId, {
    attempts = 3,
    retryDelayMs = 750,
    eventTime = Date.now(),
    notBefore = eventTime - MODERATION_AUDIT_MAX_AGE_MS,
    onUnavailable = () => {},
    targetMatches = candidate => String(candidate.targetId || candidate.target?.id || '') === String(userId),
    matches = () => true
} = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        let fetchedLogs;
        try {
            fetchedLogs = await fetchModerationAuditLogs(guild, actionType);
        } catch (error) {
            console.warn(`[CC LOG] Audit details unavailable for guild ${guild.id}:`, error.message);
            onUnavailable(error);
            return null;
        }
        const entry = fetchedLogs.entries.find(candidate =>
            targetMatches(candidate) &&
            candidate.createdTimestamp >= notBefore &&
            candidate.createdTimestamp <= eventTime + 5000 &&
            matches(candidate)
        );
        if (entry) return entry;

        if (attempt + 1 < attempts) await sleep(retryDelayMs);
    }
    return null;
}

function timeoutExpiryKey(member, expiresAt) {
    return `${member.guild.id}:${member.id}:${expiresAt}`;
}

async function sendTimeoutExpiry(channel, member, expiresAt) {
    const key = timeoutExpiryKey(member, expiresAt);
    if (loggedTimeoutExpiries.has(key)) return loggedTimeoutExpiries.get(key);
    const pending = channel.send(buildMemberAuditPayload({
        authorName: 'Member Timeout Expired ⌛', member,
        actionText: 'had their timeout expire automatically',
        color: MEMBER_COLORS.timeoutExpired,
        timingLines: [`- **Timeout Ended:** ${formatDiscordTime(expiresAt)}`]
    }));
    loggedTimeoutExpiries.set(key, pending);
    try {
        await pending;
        const timer = setTimeout(() => loggedTimeoutExpiries.delete(key), TIMEOUT_EXPIRY_LOG_CACHE_MS);
        timer.unref?.();
    } catch (error) {
        loggedTimeoutExpiries.delete(key);
        throw error;
    }
}

async function getLogChannel(guild, logChannelID) {
    if (!logChannelID) return null;
    const channel = guild.channels.cache.get(logChannelID) || await guild.channels.fetch(logChannelID);
    return channel?.isTextBased() ? channel : null;
}

function clearTimeoutTimer(member) {
    const key = moderationKey(member.guild.id, member.id);
    recoveringTimeouts.get(member.guild.id)?.add(key);
    clearTimeout(activeTimeouts.get(key)?.timer);
    activeTimeouts.delete(key);
}

function timeoutValue(value) {
    if (value == null) return null;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function matchesTimeoutChange(entry, oldExpiry, newExpiry) {
    return entry.changes?.some(change => change.key === 'communication_disabled_until' &&
        timeoutValue(change.old) === oldExpiry && timeoutValue(change.new) === newExpiry);
}

function scheduleTimeoutExpiry(member, logChannelID, expiresAt) {
    clearTimeoutTimer(member);
    if (timeoutTrackingStopped) return;
    const key = moderationKey(member.guild.id, member.id);
    const state = { timer: null, failures: 0 };
    activeTimeouts.set(key, state);
    const isCurrent = () => activeTimeouts.get(key) === state;
    const arm = delay => {
        state.timer = setTimeout(checkExpiry, Math.min(Math.max(0, delay), MAX_TIMEOUT_MS));
        state.timer.unref?.();
    };
    const checkExpiry = async () => {
        if (!isCurrent()) return;
        // Long timeouts are split across Node's maximum timer delay.
        if (expiresAt > Date.now()) return arm(expiresAt - Date.now() + 1500);
        try {
            const currentMember = await member.guild.members.fetch({ user: member.id, force: true, cache: false });
            if (!isCurrent()) return;
            const currentExpiry = timeoutValue(currentMember.communicationDisabledUntilTimestamp);
            if (currentExpiry !== null && currentExpiry !== expiresAt) {
                clearTimeoutTimer(member);
                if (currentExpiry > Date.now()) scheduleTimeoutExpiry(currentMember, logChannelID, currentExpiry);
                return;
            }
            // Discord may clear the timestamp after expiry. Check for an explicit removal
            // before interpreting that null value as automatic expiry.
            if (currentExpiry === null) {
                let auditUnavailable = false;
                const removal = await findModerationAuditEntry(member.guild, AuditLogEvent.MemberUpdate, member.id, {
                    eventTime: expiresAt,
                    matches: entry => matchesTimeoutChange(entry, expiresAt, null),
                    onUnavailable: () => { auditUnavailable = true; }
                });
                if (!isCurrent()) return;
                if (removal || auditUnavailable) return clearTimeoutTimer(member);
            }
            const channel = await getLogChannel(member.guild, logChannelID);
            if (!isCurrent()) return;
            if (!channel) return clearTimeoutTimer(member);
            await sendTimeoutExpiry(channel, currentMember, expiresAt);
            if (isCurrent()) clearTimeoutTimer(member);
        } catch (error) {
            if (!isCurrent()) return;
            if (error.code === 10007) return clearTimeoutTimer(member); // Member already left.
            console.error('Timeout expiry log failed:', error);
            if (++state.failures <= 3) arm(state.failures * 5000);
            else clearTimeoutTimer(member);
        }
    };
    // Allow a near-deadline gateway removal to cancel this countdown first.
    arm(expiresAt - Date.now() + 1500);
}

module.exports = {
    initializeTimeoutTracking(client, config) {
        memberHistory = config.memberHistory ?? null;
        const signal = config.shutdownSignal;
        timeoutTrackingStopped = Boolean(signal?.aborted);
        signal?.addEventListener('abort', () => {
            timeoutTrackingStopped = true;
            for (const state of activeTimeouts.values()) clearTimeout(state.timer);
            activeTimeouts.clear();
        }, { once: true });

        client.once(Events.ClientReady, async () => {
            if (timeoutTrackingStopped) return;
            for (const guild of client.guilds.cache.values()) {
                if (config.guildId && guild.id !== config.guildId) continue;
                const touched = new Set();
                recoveringTimeouts.set(guild.id, touched);
                try {
                    const members = await fetchGuildMemberRoster(guild, { signal });
                    if (timeoutTrackingStopped) return;
                    memberHistory?.seedMembers(members);
                    if (!config.logChannelID || !await getLogChannel(guild, config.logChannelID) || timeoutTrackingStopped) continue;
                    for (const member of members.values()) {
                        const expiresAt = timeoutValue(member.communicationDisabledUntilTimestamp);
                        if (expiresAt > Date.now() && !touched.has(moderationKey(guild.id, member.id))) {
                            scheduleTimeoutExpiry(member, config.logChannelID, expiresAt);
                        }
                    }
                } catch (error) {
                    if (!timeoutTrackingStopped) console.error(`[CC LOG] Could not restore active timeout countdowns for ${guild.id}:`, error);
                } finally {
                    recoveringTimeouts.delete(guild.id);
                }
            }
        });
    },

    // --------------------------
    // Handle leaves and kicks
    // --------------------------
    async handleMemberRemove(member, logChannelID) {
        const eventTime = Date.now();
        const departure = memberHistory?.beginDeparture(member, eventTime);
        clearTimeoutTimer(member);
        const userId = member.id;
        const key = moderationKey(member.guild.id, userId);
        const savedNickname = { nickname: member.nickname ?? null };
        nicknameCache.set(key, savedNickname);
        const nicknameTimeout = setTimeout(() => {
            if (nicknameCache.get(key) === savedNickname) nicknameCache.delete(key);
        }, 20000);
        nicknameTimeout.unref?.();

        try {
            const channel = await getLogChannel(member.guild, logChannelID);
            if (!channel) return;

            // guildBanAdd can arrive before guildMemberRemove. The ban handler marks it immediately.
            if (isRecentBanEvent(member.guild.id, userId, member.joinedTimestamp)) return;

            // Give Discord time to add the ban audit entry before treating this as a leave.
            await sleep(1200);
            if (isRecentBanEvent(member.guild.id, userId, member.joinedTimestamp)) return;

            let auditUnavailable = false;
            const auditOptions = {
                eventTime,
                notBefore: Math.max(member.joinedTimestamp ?? 0, eventTime - MODERATION_AUDIT_MAX_AGE_MS),
                onUnavailable: () => { auditUnavailable = true; }
            };
            const isBanned = await findModerationAuditEntry(member.guild, AuditLogEvent.MemberBanAdd, userId, auditOptions);
            if (isBanned) memberHistory?.recordDeparture(member, 'banned', eventTime);
            if (isBanned || isRecentBanEvent(member.guild.id, userId, member.joinedTimestamp)) return;

            const kickEntry = await findModerationAuditEntry(
                member.guild,
                AuditLogEvent.MemberKick,
                member.id,
                { ...auditOptions, attempts: 1 }
            );
            if (isRecentBanEvent(member.guild.id, userId, member.joinedTimestamp)) return;

            if (kickEntry) {
                memberHistory?.recordDeparture(member, 'kicked', eventTime);
                await channel.send(buildMemberAuditPayload({
                    authorName: 'Member Kicked 👢',
                    member,
                    actionText: `was kicked by ${auditActor(kickEntry.executor)}`,
                    reason: kickEntry.reason ?? null,
                    color: MEMBER_COLORS.kicked,
                    memberCount: member.guild.memberCount
                }));
                return;
            }

            memberHistory?.recordDeparture(member, auditUnavailable ? 'unknown' : 'left', eventTime);
            await channel.send(buildMemberAuditPayload({
                authorName: 'Member Left 👋',
                member,
                actionText: auditUnavailable ? 'left the server; the departure type could not be confirmed.' : 'voluntarily left the server!',
                extraLines: auditUnavailable ? ['- **Discord Audit Log:** Unavailable; a kick could not be ruled out.'] : [],
                color: MEMBER_COLORS.left,
                memberCount: member.guild.memberCount
            }));
        } catch (err) {
            console.error('Leave/kick/ban message failed:', err);
        } finally {
            memberHistory?.finishDeparture(member, departure);
        }
    },

    // --------------------------------
    // Handle bans (manual and bot bans)
    // --------------------------------
    async handleGuildBanAdd(ban, logChannelID) {
        const eventTime = Date.now();
        clearTimeoutTimer({ id: ban.user.id, guild: ban.guild });
        if (!rememberBanEvent(ban.guild.id, ban.user.id)) return;
        memberHistory?.recordBan(ban, eventTime);

        try {
            const channel = await getLogChannel(ban.guild, logChannelID);
            if (!channel) return;

            await sleep(1500);

            const key = moderationKey(ban.guild.id, ban.user.id);
            const savedNickname = nicknameCache.get(key);
            nicknameCache.delete(key);
            const member = {
                id: ban.user.id,
                user: ban.user,
                nickname: savedNickname ? savedNickname.nickname : 'Nickname unavailable',
                guild: ban.guild
            };
            const banLog = await findModerationAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id, { eventTime });
            const executor = banLog?.executor;
            const extraLines = !executor
                ? ['- **Discord Audit Log:** Executor unavailable; check the server Audit Log.']
                : [];

            await channel.send(buildMemberAuditPayload({
                authorName: 'Member Banned 🔨',
                member,
                actionText: `was banned by ${auditActor(executor)}`,
                reason: banLog ? banLog.reason ?? null : 'Unavailable — audit details could not be retrieved.',
                extraLines,
                color: MEMBER_COLORS.banned,
                memberCount: ban.guild.memberCount
            }));
        } catch (err) {
            console.error('Ban message failed:', err);
        }
    },

    // ---------------
    // Handle unbans
    // ---------------
    async handleGuildBanRemove(ban, logChannelID) {
        const eventTime = Date.now();
        memberHistory?.recordUnban(ban, eventTime);
        // Keep the departure marker while allowing a subsequent, separate ban.
        const recentBan = recentBanEvents.get(moderationKey(ban.guild.id, ban.user.id));
        if (recentBan) recentBan.active = false;

        try {
            const channel = await getLogChannel(ban.guild, logChannelID);
            if (!channel) return;

            await sleep(1000);

            const unbanLog = await findModerationAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id, { eventTime });
            const executor = unbanLog?.executor;
            if (executor) memberHistory?.recordUnban(ban, eventTime, executor);
            const member = { id: ban.user.id, user: ban.user, nickname: null, guild: ban.guild };
            const extraLines = !executor
                ? ['- **Discord Audit Log:** Executor unavailable; check the server Audit Log.']
                : [];

            await channel.send(buildMemberAuditPayload({
                authorName: 'Member Unbanned 🔓',
                member,
                actionText: `was unbanned by ${auditActor(executor)}`,
                afterActionLines: [`-# **${escapeMarkdown(ban.user.username)}** can now join the Discord Server again!`],
                reason: unbanLog ? unbanLog.reason ?? null : 'Unavailable — audit details could not be retrieved.',
                extraLines,
                color: MEMBER_COLORS.unbanned,
                memberCount: ban.guild.memberCount
            }));
        } catch (err) {
            console.error('Unban message failed:', err);
        }
    },

    // ----------------------------------
    // Handle timeouts
    // ----------------------------------
    async handleGuildMemberUpdate(oldMember, newMember, logChannelID) {
        const eventTime = Date.now();
        const oldExpiry = timeoutValue(oldMember.communicationDisabledUntilTimestamp);
        const newExpiry = timeoutValue(newMember.communicationDisabledUntilTimestamp);
        if (oldExpiry === newExpiry) return;

        // Update state before any I/O; a delayed application log must never recreate
        // a countdown that a newer removal or duration change already cancelled.
        if (newExpiry > eventTime) scheduleTimeoutExpiry(newMember, logChannelID, newExpiry);
        else clearTimeoutTimer(newMember);

        try {
            const channel = await getLogChannel(newMember.guild, logChannelID);
            if (!channel) return;

            await sleep(2500);
            let auditUnavailable = false;
            const timeoutLog = await findModerationAuditEntry(
                newMember.guild,
                AuditLogEvent.MemberUpdate,
                newMember.id,
                {
                    eventTime,
                    matches: entry => matchesTimeoutChange(entry, oldExpiry, newExpiry),
                    onUnavailable: () => { auditUnavailable = true; }
                }
            );

            const actor = auditActor(timeoutLog?.executor);
            const reason = timeoutLog ? timeoutLog.reason ?? null : 'Unavailable — audit details could not be retrieved.';
            const member = newMember;

            if (newExpiry > eventTime) {
                const updated = oldExpiry > eventTime;
                await channel.send(buildMemberAuditPayload({
                    authorName: updated ? 'Member Timeout Updated ⏱️' : 'Member Timeout ⏱️',
                    member,
                    actionText: updated ? `had their timeout updated by ${actor}` : `was timed out by ${actor}`,
                    color: MEMBER_COLORS.timeout,
                    reason,
                    timingLines: [
                        `- **Timeout Expires:** ${formatDiscordTime(newExpiry)}`,
                        ...(updated ? [`- **Previous Timeout Expiry:** ${formatDiscordTime(oldExpiry)}`] : [])
                    ]
                }));
                return;
            }

            if (oldExpiry !== null && oldExpiry <= eventTime && !timeoutLog) {
                // A missing audit permission cannot establish whether a cleared timestamp
                // means manual removal or natural expiry.
                // A stale timestamp can be cleared long after the original expiry was logged.
                if (!auditUnavailable && eventTime - oldExpiry < TIMEOUT_EXPIRY_LOG_CACHE_MS) {
                    await sendTimeoutExpiry(channel, newMember, oldExpiry);
                }
                return;
            }

            if (oldExpiry !== null) {
                await channel.send(buildMemberAuditPayload({
                    authorName: 'Member Timeout Removed ⏱️❌',
                    member,
                    actionText: `had their timeout removed by ${actor}`,
                    color: MEMBER_COLORS.timeoutRemoved,
                    reason,
                    timingLines: [`- **Timeout Ended:** ${formatDiscordTime(eventTime)}`]
                }));
            }
        } catch (err) {
            console.error('Timeout message failed:', err);
        }
    },

    // Shared with profile logging so concurrent updates reuse the same audit batch.
    findModerationAuditEntry,
};
