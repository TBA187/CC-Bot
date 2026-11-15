const test = require('node:test');
const assert = require('node:assert/strict');

const {
    execute,
    stop,
    getContestKey,
    getNextAltoMareSchedule,
    getNextContestSchedule,
    getNextContestScheduleForContest,
    mentionBatches,
    sendUserReminder,
    sendScheduledReminder
} = require('../tasks/proNotifications.js');

test('Alto Mare reminders use the fixed 01:00 UTC race cycle', () => {
    const now = Date.UTC(2026, 7, 18, 0, 0, 0);
    const schedule = getNextAltoMareSchedule(now);

    assert.equal(schedule.reminderTime, Date.UTC(2026, 7, 18, 0, 45, 0));
    assert.equal(schedule.raceStart, Date.UTC(2026, 7, 18, 1, 0, 0));
});

test('Alto Mare skips a reminder that has already passed', () => {
    const now = Date.UTC(2026, 7, 18, 0, 45, 1);
    const schedule = getNextAltoMareSchedule(now);

    assert.equal(schedule.reminderTime, Date.UTC(2026, 7, 18, 6, 45, 0));
    assert.equal(schedule.raceStart, Date.UTC(2026, 7, 18, 7, 0, 0));
});

test('BCC and FCC use the supplied alternating Saturday anchor', () => {
    const anchorSaturday = Date.UTC(2026, 7, 29, 0, 0, 0);
    const followingSaturday = Date.UTC(2026, 8, 5, 0, 0, 0);

    assert.equal(getContestKey(anchorSaturday, 10), 'FCC');
    assert.equal(getContestKey(anchorSaturday, 22), 'BCC');
    assert.equal(getContestKey(followingSaturday, 10), 'BCC');
    assert.equal(getContestKey(followingSaturday, 22), 'FCC');
    const observedSaturday = Date.UTC(2026, 8, 26, 0, 0, 0);
    assert.equal(getContestKey(observedSaturday, 10), 'FCC');
    assert.equal(getContestKey(observedSaturday, 22), 'BCC');
});

test('Saturday contest reminders choose the next event without sending late', () => {
    const beforeFirstReminder = getNextContestSchedule(Date.UTC(2026, 7, 29, 9, 29, 0));
    const afterFirstReminder = getNextContestSchedule(Date.UTC(2026, 7, 29, 9, 30, 1));

    assert.equal(beforeFirstReminder.contestKey, 'FCC');
    assert.equal(beforeFirstReminder.reminderTime, Date.UTC(2026, 7, 29, 9, 30, 0));
    assert.equal(afterFirstReminder.contestKey, 'BCC');
    assert.equal(afterFirstReminder.reminderTime, Date.UTC(2026, 7, 29, 21, 30, 0));

    const beforeObservedBcc = getNextContestSchedule(Date.UTC(2026, 8, 26, 21, 29, 0));
    assert.equal(beforeObservedBcc.contestKey, 'BCC');
    assert.equal(beforeObservedBcc.reminderTime, Date.UTC(2026, 8, 26, 21, 30, 0));
    const afterObservedBcc = getNextContestSchedule(Date.UTC(2026, 8, 26, 21, 30, 1));
    assert.equal(afterObservedBcc.contestKey, 'BCC');
    assert.equal(afterObservedBcc.reminderTime, Date.UTC(2026, 9, 3, 9, 30, 0));
});

test('BCC and FCC each expose their own next event time', () => {
    const now = Date.UTC(2026, 7, 29, 9, 30, 0);
    const nextBcc = getNextContestScheduleForContest('BCC', now);
    const nextFcc = getNextContestScheduleForContest('FCC', now);

    assert.equal(nextBcc.eventStart, Date.UTC(2026, 7, 29, 22, 0, 0));
    assert.equal(nextFcc.eventStart, Date.UTC(2026, 7, 29, 10, 0, 0));
});

test('reminders mention only subscribed users', async () => {
    const sentMessages = [];
    const client = {
        channels: {
            fetch: async channelId => {
                assert.equal(channelId, 'channel-id');
                return {
                    isTextBased: () => true,
                    send: async message => sentMessages.push(message)
                };
            }
        }
    };

    await sendUserReminder(client, {
        channelId: 'channel-id'
    }, 'Test reminder', ['user-1', 'user-2']);

    assert.deepEqual(sentMessages, [{
        content: '<@user-1>, <@user-2>\nTest reminder',
        allowedMentions: {
            parse: [],
            users: ['user-1', 'user-2']
        }
    }]);
});

test('reminders still send normally when no members opted in', async () => {
    const sentMessages = [];
    const client = {
        channels: {
            fetch: async () => ({
                isTextBased: () => true,
                send: async message => sentMessages.push(message)
            })
        }
    };

    await sendUserReminder(client, { channelId: 'channel-id' }, 'Test reminder');

    assert.deepEqual(sentMessages, [{
        content: 'Test reminder',
        allowedMentions: {
            parse: [],
            users: []
        }
    }]);
});

test('large subscriber lists are split without losing a user mention', () => {
    const users = Array.from({ length: 200 }, (_, index) => `user-${index}`);
    const batches = mentionBatches(users, 'x'.repeat(1800));

    assert.ok(batches.length > 1);
    assert.match(batches[0].content, /^<@user-0>/);
    assert.ok(batches.every(batch => batch.content.length <= 2000));
    assert.deepEqual(
        batches.flatMap(batch => batch.userIds).sort(),
        users.sort()
    );
});

test('a disabled notification does not send a Discord message', async () => {
    const client = {
        channels: {
            fetch: async () => {
                throw new Error('A disabled notification should not fetch the channel.');
            }
        }
    };
    const notificationStore = {
        getSetting: () => ({ enabled: false }),
        getEnabledUserIds: () => ['user-1']
    };

    const sent = await sendScheduledReminder(
        client,
        { channelId: 'channel-id', roleId: 'role-id' },
        notificationStore,
        'alto_mare',
        'This should not be sent.'
    );

    assert.equal(sent, false);
});

// Starts the real reminder tasks with a controlled clock and timers. fireAt() runs the earliest
// timer at a later time if given, the way a timer fires late after the host was paused.
function reminderScheduler(t, startIso, { userIds = ['111111111111111111'], failSend = () => false } = {}) {
    let now = Date.parse(startIso);
    const timers = [], logs = [], errors = [], sends = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(global, 'setTimeout', (callback, delay) => {
        const timer = { callback, due: now + delay, unref() {} };
        timers.push(timer);
        return timer;
    });
    t.mock.method(global, 'clearTimeout', timer => {
        if (timers.includes(timer)) timers.splice(timers.indexOf(timer), 1);
    });
    t.mock.method(console, 'log', message => logs.push(String(message)));
    t.mock.method(console, 'error', message => errors.push(String(message)));
    let calls = 0;
    const channel = { isTextBased: () => true, async send(payload) {
        if (failSend(++calls)) throw Object.assign(new Error('getaddrinfo ENOTFOUND discord.com'), { code: 'ENOTFOUND' });
        sends.push(payload);
        return {};
    } };
    const store = { getSetting: () => ({ enabled: true }), getEnabledUserIds: () => userIds };
    t.after(() => stop());
    execute({ channels: { fetch: async () => channel } }, { generalChannelID: 'general' }, store);
    const fireAt = async iso => {
        timers.sort((a, b) => a.due - b.due);
        const timer = timers.shift();
        now = Math.max(timer.due, iso ? Date.parse(iso) : timer.due);
        timer.callback();
        for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setImmediate(resolve));
    };
    const scheduledAt = iso => timers.some(timer => timer.due === Date.parse(iso));
    return { logs, errors, sends, fireAt, scheduledAt };
}

test('a reminder that fires late but before its contest starts is still sent once', async t => {
    const f = reminderScheduler(t, '2026-11-21T09:00:00Z');
    await f.fireAt('2026-11-21T09:50:00Z');
    assert.equal(f.sends.length, 1);
    assert.match(f.sends[0].content, /FCC \(Fish Catching Contest\) starts in 30 minutes!/);
    assert.ok(f.scheduledAt('2026-11-21T21:30:00Z'), 'the next contest reminder is scheduled');
});

test('a reminder that fires after its contest started is skipped instead of sent late', async t => {
    const f = reminderScheduler(t, '2026-11-21T09:00:00Z');
    await f.fireAt('2026-11-21T10:13:00Z');
    assert.deepEqual(f.sends, []);
    assert.deepEqual(f.errors, []);
    assert.ok(f.logs.includes('[SATURDAY CONTEST] FCC reminder skipped: it could not be sent before the contest started at 2026-11-21T10:00:00.000Z.'));
    assert.ok(f.scheduledAt('2026-11-21T21:30:00Z'));
});

test('a failed reminder retries a minute later and sends only the messages that did not go out', async t => {
    const userIds = Array.from({ length: 100 }, (_, index) => String(100000000000000000n + BigInt(index)));
    let failures = 0;
    const f = reminderScheduler(t, '2026-11-21T09:00:00Z', { userIds, failSend: call => call === 2 && ++failures === 1 });
    await f.fireAt();
    assert.equal(f.sends.length, 1);
    assert.equal(f.errors.length, 1);
    assert.ok(f.scheduledAt('2026-11-21T09:31:00Z'), 'a retry is scheduled one minute later');
    await f.fireAt();
    assert.equal(f.sends.length, 2);
    assert.deepEqual(f.sends.flatMap(payload => payload.allowedMentions.users), userIds, 'every member is pinged exactly once');
    assert.equal(f.errors.length, 1);
    assert.ok(f.scheduledAt('2026-11-21T21:30:00Z'));
});

test('retries stop when the contest starts, and the failure is reported only once', async t => {
    const f = reminderScheduler(t, '2026-11-21T09:00:00Z', { failSend: () => true });
    for (let attempt = 0; attempt < 31; attempt++) await f.fireAt();
    assert.deepEqual(f.sends, []);
    assert.equal(f.errors.length, 1);
    assert.ok(f.logs.some(line => line.startsWith('[SATURDAY CONTEST] FCC reminder skipped')));
    assert.ok(f.scheduledAt('2026-11-21T21:30:00Z'));
    assert.ok(!f.scheduledAt('2026-11-21T10:01:00Z'), 'no retry continues after the start');
});

test('an Alto Mare reminder is never sent after its race has started', async t => {
    const f = reminderScheduler(t, '2026-11-21T12:00:00Z');
    await f.fireAt('2026-11-21T13:05:00Z');
    assert.deepEqual(f.sends, []);
    assert.ok(f.logs.includes('[SUMMER EVENT EXCLUSIVE] Alto Mare reminder skipped: it could not be sent before the race started at 2026-11-21T13:00:00.000Z.'));
});
