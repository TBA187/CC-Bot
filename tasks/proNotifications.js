// Schedule game-event reminders at fixed UTC times for opted-in members.
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const CONTEST_REMINDER_BEFORE_MS = 30 * MINUTE_MS;
// A reminder that cannot go out on time, for example after the host was paused, may still be sent,
// and retried after a failure, for up to 30 minutes. It is never sent once its event has started.
const REMINDER_SEND_WINDOW_MS = 30 * MINUTE_MS;
const REMINDER_RETRY_MS = MINUTE_MS;

// Base anchor for the alternating FCC/BCC contests (Saturday, 29 August 2026 at 00:00 UTC)
const ANCHOR_SATURDAY_UTC_MS = Date.UTC(2026, 7, 29, 0, 0, 0, 0);

const CONTESTS = {
    BCC: {
        name: 'BCC (Bug Catching Contest)',
        informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Bug_Catching_Contest_(Multiplayer)'
    },
    FCC: {
        name: 'FCC (Fish Catching Contest)',
        informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Corsica_Island#Fishing_Contest'
    }
};

const CONTEST_NOTIFICATION_KEYS = {
    BCC: 'bug_catching_contest',
    FCC: 'fish_catching_contest'
};

let started = false;
const reminderTimers = new Set();

function stop() {
    started = false;
    for (const timer of reminderTimers) clearTimeout(timer);
    reminderTimers.clear();
}

function getNotificationConfig(config) {
    const channelId = config?.generalChannelID;

    if (!channelId) {
        throw new Error(
            'PRO notifications require generalChannelID in config.json.'
        );
    }

    return { channelId };
}

function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
}

function uniqueUserIds(userIds) {
    return [...new Set((userIds || []).map(String).filter(Boolean))];
}

function mentionBatches(userIds, body) {
    const batches = [];
    let currentUserIds = [];
    let currentMentions = [];

    for (const userId of uniqueUserIds(userIds)) {
        const userMention = `<@${userId}>`;
        const withUser = [...currentMentions, userMention].join(', ');
        const firstMessage = batches.length === 0;
        const content = firstMessage ? `${withUser}\n${body}` : withUser;

        if (content.length <= 2000) {
            currentMentions.push(userMention);
            currentUserIds.push(userId);
            continue;
        }

        batches.push({
            content: firstMessage && currentMentions.length
                ? `${currentMentions.join(', ')}\n${body}`
                : (firstMessage ? body : currentMentions.join(', ')),
            userIds: currentUserIds
        });

        currentMentions = [userMention];
        currentUserIds = [userId];
    }

    const isFirstMessage = batches.length === 0;
    batches.push({
        content: isFirstMessage && currentMentions.length
            ? `${currentMentions.join(', ')}\n${body}`
            : (isFirstMessage ? body : currentMentions.join(', ')),
        userIds: currentUserIds
    });

    return batches;
}

/**
 * Sends every user who subscribed to this notification.
 * `delivery` keeps the message batches and how many were sent, so a retry
 * continues with the remaining batches and never pings anyone twice.
 */
async function sendUserReminder(client, notificationConfig, content, userIds = [], delivery = {}) {
    const { channelId } = notificationConfig;
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
        throw new Error(
            `Channel ${channelId} was not found or cannot receive text messages.`
        );
    }

    delivery.batches ||= mentionBatches(userIds, content);
    delivery.sent ||= 0;
    const sent = [];
    while (delivery.sent < delivery.batches.length) {
        const batch = delivery.batches[delivery.sent];
        sent.push(await channel.send({
            content: batch.content,

            // Only opted-in members are allowed to be pinged.
            allowedMentions: {
                parse: [],
                users: batch.userIds
            }
        }));
        delivery.sent += 1;
    }

    return sent;
}

async function sendScheduledReminder(client, notificationConfig, notificationStore, notificationKey, content, delivery = {}) {
    if (!delivery.batches) {
        const setting = notificationStore.getSetting(notificationKey);

        if (!setting?.enabled) {
            return false;
        }

        delivery.batches = mentionBatches(notificationStore.getEnabledUserIds(notificationKey), content);
    }

    await sendUserReminder(client, notificationConfig, content, [], delivery);
    return true;
}

/**
 * Schedule the next reminder.
 *
 * Each reminder recalculates its fixed UTC time after every run.
 * Bot restarts will NOT shift the schedule.
 */
function scheduleNextNotification(options) {
    const {
        client,
        notificationConfig,
        notificationStore,
        getNextSchedule,
        sendReminder,
        logNextReminder,
        logFailure,
        logSkipped
    } = options;
    if (!started) return;
    const schedule = getNextSchedule();
    const eventStart = schedule.eventStart ?? schedule.raceStart;
    const deadline = Math.min(schedule.reminderTime + REMINDER_SEND_WINDOW_MS, eventStart);
    const delivery = {};

    if (logNextReminder) {
        console.log(logNextReminder(schedule));
    }

    const attempt = async () => {
        if (!started) return;
        if (Date.now() >= deadline) {
            console.log(logSkipped(schedule));
            scheduleNextNotification(options);
            return;
        }
        try {
            await sendReminder(client, notificationConfig, notificationStore, schedule, delivery);
        } catch (err) {
            // Log the first failure only; retries continue quietly until the reminder is sent or skipped.
            if (!delivery.failed) console.error(logFailure, err);
            delivery.failed = true;
            setReminderTimer(attempt, REMINDER_RETRY_MS);
            return;
        }
        scheduleNextNotification(options);
    };
    setReminderTimer(attempt, Math.max(0, schedule.reminderTime - Date.now()));
}

function setReminderTimer(callback, delay) {
    const timer = setTimeout(() => {
        reminderTimers.delete(timer);
        void callback();
    }, delay);
    reminderTimers.add(timer);

    // The Discord client keeps Node.js running.
    timer.unref?.();
}

// ============================================================
// Send a reminder 30 minutes before the weekly BCC/FCC events.
//
// Event times every Saturday:
// 10:00 and 22:00 UTC/GMT
//
// Reminder times every Saturday:
// 09:30 and 21:30 UTC/GMT
//
// Alternating anchor - Saturday, 29 August 2026:
// 10:00 UTC = FCC
// 22:00 UTC = BCC
//
// The order reverses each following Saturday.
// ============================================================
function getContestKey(saturdayStartUtc, eventHourUtc) {
    const weeksFromAnchor = Math.round(
        (saturdayStartUtc - ANCHOR_SATURDAY_UTC_MS) / WEEK_MS
    );

    const usesAnchorOrder = positiveModulo(weeksFromAnchor, 2) === 0;

    // Anchor week (August 29) starts with FCC at 10:00 UTC.
    if (eventHourUtc === 10) {
        return usesAnchorOrder ? 'FCC' : 'BCC';
    }

    return usesAnchorOrder ? 'BCC' : 'FCC';
}

/**
 * Finds the next future Saturday reminder using UTC only.
 *
 * Bot restarts do not shift the schedule because the next fixed
 * Saturday reminder is recalculated from the current UTC time.
 */
function getNextContestSchedule(now = Date.now()) {
    const nowDate = new Date(now);
    const todayStartUtc = Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate()
    );

    // getUTCDay(): Sunday = 0, Saturday = 6.
    const daysUntilSaturday = (6 - nowDate.getUTCDay() + 7) % 7;
    const firstSaturdayStartUtc = todayStartUtc + (daysUntilSaturday * DAY_MS);

    // Checking this Saturday and the next two is more than enough,
    // because a valid reminder is always less than seven days away.
    for (let weekOffset = 0; weekOffset < 3; weekOffset += 1) {
        const saturdayStartUtc = firstSaturdayStartUtc + (weekOffset * WEEK_MS);

        for (const eventHourUtc of [10, 22]) {
            const eventStart = saturdayStartUtc + (eventHourUtc * 60 * MINUTE_MS);
            const reminderTime = eventStart - CONTEST_REMINDER_BEFORE_MS;

            // If the exact reminder time was already missed, do not send late.
            // Move on to the next scheduled contest instead.
            if (reminderTime < now) {
                continue;
            }

            const contestKey = getContestKey(saturdayStartUtc, eventHourUtc);

            return {
                contestKey,
                contest: CONTESTS[contestKey],
                eventStart,
                reminderTime
            };
        }
    }

    throw new Error('Could not calculate the next Saturday BCC/FCC reminder.');
}

function getNextContestScheduleForContest(contestKey, now = Date.now()) {
    const nowDate = new Date(now);
    const todayStartUtc = Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate()
    );
    const daysUntilSaturday = (6 - nowDate.getUTCDay() + 7) % 7;
    const firstSaturdayStartUtc = todayStartUtc + (daysUntilSaturday * DAY_MS);

    for (let weekOffset = 0; weekOffset < 3; weekOffset += 1) {
        const saturdayStartUtc = firstSaturdayStartUtc + (weekOffset * WEEK_MS);

        for (const eventHourUtc of [10, 22]) {
            const eventStart = saturdayStartUtc + (eventHourUtc * 60 * MINUTE_MS);
            if (eventStart < now || getContestKey(saturdayStartUtc, eventHourUtc) !== contestKey) {
                continue;
            }

            return {
                contestKey,
                contest: CONTESTS[contestKey],
                eventStart
            };
        }
    }

    throw new Error(`Could not calculate the next ${contestKey} contest.`);
}

async function sendContestReminder(client, notificationConfig, notificationStore, schedule, delivery = {}) {
    const eventStartUnix = Math.floor(schedule.eventStart / 1000);

    const content =
        `### ${schedule.contest.name} starts in 30 minutes!\n` +
        `- Start time: **<t:${eventStartUnix}:t> (<t:${eventStartUnix}:R>)**\n` +
        `-# - More information: <${schedule.contest.informationUrl}>\n` +
        `-# Use the \`/notifications\` command to enable or disable notification pings.`;

    const sent = await sendScheduledReminder(
        client,
        notificationConfig,
        notificationStore,
        CONTEST_NOTIFICATION_KEYS[schedule.contestKey],
        content,
        delivery
    );

    if (sent) {
        console.log(
            `[SATURDAY CONTEST] ${schedule.contestKey} reminder sent at ${new Date().toISOString()} | ` +
            `Event starts at ${new Date(schedule.eventStart).toISOString()}`
        );
    }
}

function startContestReminders(client, notificationConfig, notificationStore) {
    console.log('[SATURDAY CONTEST] Starting permanent BCC/FCC reminder task.');

    scheduleNextNotification({
        client,
        notificationConfig,
        notificationStore,
        getNextSchedule: getNextContestSchedule,
        sendReminder: sendContestReminder,
        logNextReminder: schedule =>
            `[SATURDAY CONTEST] Next reminder: ${schedule.contestKey} at ` +
            `${new Date(schedule.reminderTime).toISOString()} | ` +
            `Event starts at ${new Date(schedule.eventStart).toISOString()}`,
        logFailure: '[SATURDAY CONTEST] Failed to send reminder:',
        logSkipped: schedule =>
            `[SATURDAY CONTEST] ${schedule.contestKey} reminder skipped: it could not be sent before ` +
            `the contest started at ${new Date(schedule.eventStart).toISOString()}.`
    });
}

// ============================================================
// SUMMER EVENT EXCLUSIVE
// Send a reminder 15 minutes before each Alto Mare Race starts.
//
// Race times:
// 01:00, 07:00, 13:00, 19:00 UTC/GMT
//
// ============================================================

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ALTO_MARE_REMINDER_BEFORE_MS = 15 * MINUTE_MS;
const RACE_OFFSET_MS = 1 * 60 * 60 * 1000; // Race cycle starts at 01:00 UTC

/**
 * Finds the next Alto Mare reminder using fixed UTC race times.
 */
function getNextAltoMareSchedule(now = Date.now()) {
    // Find the next 6-hour race boundary, offset to 01:00 UTC.
    let raceStart =
        Math.ceil(
            (now + ALTO_MARE_REMINDER_BEFORE_MS - RACE_OFFSET_MS) / SIX_HOURS_MS
        ) * SIX_HOURS_MS
        + RACE_OFFSET_MS;

    let reminderTime = raceStart - ALTO_MARE_REMINDER_BEFORE_MS;

    // Safety check:
    // If the reminder time somehow already passed, move to the following race.
    if (reminderTime < now) {
        raceStart += SIX_HOURS_MS;
        reminderTime = raceStart - ALTO_MARE_REMINDER_BEFORE_MS;
    }

    return {
        raceStart,
        reminderTime
    };
}

/**
 * Sends the Alto Mare Race reminder.
 *
 * raceStart is the REAL race start time,
 * NOT the reminder time.
 */
async function sendAltoMareReminder(client, notificationConfig, notificationStore, schedule, delivery = {}) {
    // Discord timestamps use UNIX time in SECONDS.
    const raceStartUnix = Math.floor(schedule.raceStart / 1000);

    const content =
        `### Alto Mare Race starts in 15 minutes!\u2002🔔\n` +
        `- Start time: **<t:${raceStartUnix}:t> (<t:${raceStartUnix}:R>)**\n` +
        `-# - Video Guide: <https://www.youtube.com/watch?v=mYnlLlJ_buI>\n` +
        `-# Use the \`/notifications\` command to enable or disable notification pings.`;

    const sent = await sendScheduledReminder(
        client,
        notificationConfig,
        notificationStore,
        'alto_mare',
        content,
        delivery
    );

    return sent;
}

function startAltoMareReminder(client, notificationConfig, notificationStore) {
    scheduleNextNotification({
        client,
        notificationConfig,
        notificationStore,
        getNextSchedule: getNextAltoMareSchedule,
        sendReminder: sendAltoMareReminder,
        logFailure: '[SUMMER EVENT EXCLUSIVE] Failed to send reminder:',
        logSkipped: schedule =>
            '[SUMMER EVENT EXCLUSIVE] Alto Mare reminder skipped: it could not be sent before ' +
            `the race started at ${new Date(schedule.raceStart).toISOString()}.`
    });
}

/**
 * Called once from index.js when Discord client is ready.
 */
function execute(client, config, notificationStore) {
    // Prevent accidentally starting duplicate timers.
    if (started) {
        console.warn('[PRO NOTIFICATIONS] Reminder tasks are already running.');
        return;
    }

    if (!notificationStore) {
        throw new Error('PRO notifications require a notification store.');
    }

    const notificationConfig = getNotificationConfig(config);
    started = true;

    startContestReminders(client, notificationConfig, notificationStore);
    startAltoMareReminder(client, notificationConfig, notificationStore);
}

module.exports = {
    execute,
    stop,
    getContestKey,
    getNextAltoMareSchedule,
    getNextContestSchedule,
    getNextContestScheduleForContest,
    mentionBatches,
    sendUserReminder,
    sendScheduledReminder
};
