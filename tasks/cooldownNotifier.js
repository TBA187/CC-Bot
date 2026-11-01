// Notify challengers when their Gold or Silver PvP King cooldown expires.

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { refreshGuildMembers } = require('../commands/pvp-king/utils/pvpHelper.js');
const { getPvpServerConfigs } = require('../commands/pvp-king/utils/pvpServers.js');
const { messageSearchText } = require('../utils/discordMessageHistory.js');

const COOLDOWN_CHECK_INTERVAL_MS = 60000;
const PVP_COOLDOWN_MS = 48 * 60 * 60 * 1000;
const MAX_MISSED_NOTIFICATION_AGE_MS = 60 * 60 * 1000;

function getCooldownExpiryMs(row) {
    if (!row?.last_challenge) return null;

    const rawDate = row.last_challenge instanceof Date
        ? row.last_challenge
        : new Date(`${row.last_challenge}Z`);
    const lastChallengeMs = rawDate.getTime();

    if (Number.isNaN(lastChallengeMs)) return null;
    return lastChallengeMs + PVP_COOLDOWN_MS;
}

function shouldNotifyExpiredCooldown(row, nowMs = Date.now()) {
    const expiryMs = getCooldownExpiryMs(row);
    if (!expiryMs) return false;

    return nowMs - expiryMs <= MAX_MISSED_NOTIFICATION_AGE_MS;
}

async function recentlyNotifiedCooldownUsers(channel, userIds, botUserId, nowMs = Date.now()) {
    const notified = new Set();
    if (!channel?.messages?.fetch || !userIds?.length) return notified;
    const messages = await channel.messages.fetch({ limit: 100 });
    if (!messages || typeof messages.values !== 'function') return notified;

    for (const message of messages.values()) {
        if (botUserId && String(message.author?.id || '') !== String(botUserId)) continue;
        const createdMs = Number(message.createdTimestamp || message.createdAt?.getTime?.());
        if (!Number.isFinite(createdMs) || nowMs - createdMs > MAX_MISSED_NOTIFICATION_AGE_MS) continue;
        const text = messageSearchText(message);
        if (!text.includes('PvP Cooldown Expired!')) continue;
        for (const userId of userIds) {
            if (text.includes(`<@${userId}>`)) notified.add(String(userId));
        }
    }
    return notified;
}

function startServerCooldownNotifier(client, config) {
    const db = config.pvpKingStorage || config.db;
    const { pvpKingChannelID, pvpKingRoleID, guildId, pvpServerName, pvpServerEmoji, pvpServerColor } = config;
    let isRunning = false;
    let storageUnavailable = false;
    let stopped = Boolean(config.shutdownSignal?.aborted);
    let interval;
    const stop = () => {
        stopped = true;
        clearInterval(interval);
        config.shutdownSignal?.removeEventListener('abort', stop);
    };
    config.shutdownSignal?.addEventListener('abort', stop, { once: true });

    const runCooldownCheck = async () => {
        if (stopped || isRunning) return;
        isRunning = true;

        try {
            const expired = await db.findExpiredNotifiableCooldowns();
            if (stopped) return;
            if (storageUnavailable) {
                storageUnavailable = false;
                console.log('[CC LOG] PvP cooldown notification storage restored; scheduled checks resumed.');
            }

            if (expired.length === 0) return;

            const guild = client.guilds.cache.get(guildId);
            const pvpChannel = guild?.channels.cache.get(pvpKingChannelID);
            const kingRole = guild?.roles.cache.get(pvpKingRoleID);

            if (guild && kingRole && kingRole.members.size !== 1) {
                await refreshGuildMembers(guild, 'PvP cooldown task');
            }

            const currentKing = kingRole?.members.first();
            if (stopped) return;
            if (!pvpChannel || !currentKing) return;

            const usersToPing = [];
            const idsToReset = [];
            let alreadyNotified = new Set();
            try {
                alreadyNotified = await recentlyNotifiedCooldownUsers(
                    pvpChannel,
                    expired.map(row => String(row.challenger_id)),
                    client.user?.id
                );
                if (alreadyNotified.size) {
                    console.log(
                        `[CC LOG] Recovered ${alreadyNotified.size} recent PvP cooldown notification(s); duplicate ping skipped.`
                    );
                }
            } catch (error) {
                if (stopped) return;
                console.warn(
                    '[CC LOG] Could not check recent PvP cooldown messages for duplicates; database state remains the primary guard:',
                    error.code || error.message
                );
            }

            for (const row of expired) {
                if (row.king_id === currentKing.id
                    && shouldNotifyExpiredCooldown(row)
                    && !alreadyNotified.has(String(row.challenger_id))) {
                    usersToPing.push(`<@${row.challenger_id}>`);
                }

                idsToReset.push(row.id);
            }

            if (stopped) return;

            if (usersToPing.length > 0) {
                const logoFile = new AttachmentBuilder('./images/cc_logo.webp', { name: 'cc_logo.webp' });
                const pvpKingCdEmbed = new EmbedBuilder()
                    .setColor(pvpServerColor)
                    .setTitle(`🔔 PvP Cooldown Expired! — ${pvpServerName} ${pvpServerEmoji}`)
                    .setThumbnail(currentKing.displayAvatarURL({ size: 256 }))
                    .setDescription(
                        `### The wait is over!\n` +
                        `- Your cooldown against <@${currentKing.id}> has expired.\n` +
                        '- You may now challenge the **PvP King** once again! ⚔️'
                    )
                    .setFooter({ text: `CC PvP King System • ${pvpServerName}`, iconURL: 'attachment://cc_logo.webp' })
                    .setTimestamp();

                await pvpChannel.send({
                    content: usersToPing.join(' '),
                    embeds: [pvpKingCdEmbed],
                    files: [logoFile]
                });
            }

            if (!stopped && idsToReset.length > 0) {
                await db.resetCooldownsByIds(idsToReset);
            }
        } catch (err) {
            if (stopped) return;
            if (err.code === 'PVP_DATABASE_UNAVAILABLE' || err.code === 'DATABASE_UNAVAILABLE') {
                if (!storageUnavailable) {
                    storageUnavailable = true;
                    console.warn(
                        '[CC LOG] PvP cooldown notification check paused because neither MySQL nor a usable JSON snapshot is available. ' +
                        'The task will retry every minute.'
                    );
                }
            } else {
                console.error('[CC LOG] Cooldown Task Error:', err);
            }
        } finally {
            isRunning = false;
        }
    };

    runCooldownCheck();
    if (stopped) return { stop };
    interval = setInterval(runCooldownCheck, COOLDOWN_CHECK_INTERVAL_MS);
    interval.unref?.();
    return { stop };
}

module.exports = {
    name: 'cooldownTask',
    execute(client, config) {
        client.cooldownNotifier?.stop?.();
        const tasks = getPvpServerConfigs(config).map(server => startServerCooldownNotifier(client, server));
        client.cooldownNotifier = {
            stop() {
                for (const task of tasks) task.stop();
            }
        };
        return client.cooldownNotifier;
    }
};

module.exports.shouldNotifyExpiredCooldown = shouldNotifyExpiredCooldown;
module.exports.recentlyNotifiedCooldownUsers = recentlyNotifiedCooldownUsers;
