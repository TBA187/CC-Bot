// Check owner alerts, startup buffering, secret removal and recovery from log delivery failures.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Events } = require('discord.js');
const { DiscordDiagnosticLogger, redactDiagnostic } = require('../utils/discordDiagnostics.js');
const { CommandRegistration } = require('../utils/commandRegistration.js');
const { InteractionDiagnostics } = require('../utils/interactionDiagnostics.js');

const settle = () => new Promise(resolve => setImmediate(resolve));

function fakeClock(initial = 1000) {
    let time = initial;
    const timers = new Set();
    return { now: () => time, timers,
        schedule(work, delay) {
            const timer = { at: time + delay, work, unref() {} };
            timers.add(timer); return timer;
        },
        cancel: timer => timers.delete(timer),
        async advance(ms) {
            const target = time + ms;
            for (;;) {
                const next = [...timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
                if (!next) break;
                time = next.at; timers.delete(next); next.work(); await settle();
            }
            time = target; await settle();
        }
    };
}

function fixture(options = {}) {
    const printed = [], sent = [];
    const clock = fakeClock();
    const consoleObject = { log: (...args) => printed.push(['log', ...args]),
        warn: (...args) => printed.push(['warn', ...args]), error: (...args) => printed.push(['error', ...args]) };
    const logger = new DiscordDiagnosticLogger({ send: event => { sent.push(event); return { id: `message-${sent.length}` }; },
        consoleObject, now: clock.now, schedule: clock.schedule, cancel: clock.cancel, ...options });
    logger.install();
    return { logger, consoleObject, printed, sent, clock };
}

test('actionable warnings before Discord login stay in memory, then post once with their original timestamp', () => {
    const f = fixture({ now: () => Date.parse('2026-10-03T09:30:00Z') });
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 5m (ECONNREFUSED).');
    assert.equal(f.printed.length, 1); assert.equal(f.sent.length, 0);
    f.logger.start(); f.logger.start();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].code, 'ECONNREFUSED');
    assert.equal(f.sent[0].component, 'MySQL');
    assert.equal(f.sent[0].timestamp, '2026-10-03T09:25:00.000Z');
    f.logger.stop();
});

test('late-arrival timing information stays local while near-expiry acknowledgements still alert', async () => {
    const f = fixture();
    f.consoleObject.info = (...args) => f.printed.push(['info', ...args]);
    f.logger.start();
    let elapsed = 0;
    const rest = new EventEmitter();
    const tracker = new InteractionDiagnostics({ rest, consoleObject: f.consoleObject, now: () => 10000,
        clock: () => elapsed, eventLoopUtilization: () => ({ active: 0 }) });
    for (const [id, createdTimestamp] of [['123', 8190], ['456', 7750]]) {
        elapsed = 0;
        const interaction = { id, commandName: 'giveaway', createdTimestamp,
            async respond() {
                elapsed += 261;
                rest.emit('response', { path: `/interactions/${id}/private-token/callback` }, { status: 204 });
            } };
        tracker.track(interaction);
        await interaction.respond();
        if (id === '123') {
            assert.equal(f.sent.length, 0);
            assert.equal(f.printed[0][0], 'info');
            assert.match(f.printed[0][1], /arrived late; acknowledgement succeeded/u);
        }
    }
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].message, /acknowledgement was slow/u);
    tracker.stop();
    f.logger.stop();
});

test('expected startup deadlines stay local while persistent fallback outages share one delayed database alert', async () => {
    const f = fixture();
    const notices = [
        '[CC LOG] Scout autocomplete will refresh in the background (AUTOCOMPLETE_PRELOAD_TIMEOUT).',
        '[CC LOG] Player server preferences will refresh when used (SERVER_PREFERENCE_PRELOAD_TIMEOUT).',
        '[DB LOG] MySQL connectivity issue detected (ECONNRESET: read ECONNRESET). Query retries and feature fallbacks are active.',
        '[CC LOG] MySQL PvP King Gold storage unavailable (ETIMEDOUT). Using the synchronized JSON snapshot; writes will queue for recovery.',
        '[PRO NOTIFICATIONS] MySQL storage unavailable (ECONNREFUSED). Using JSON; pending settings and subscriptions will retry automatically.'
    ];
    for (const notice of notices) f.consoleObject.warn(notice);
    f.consoleObject.warn('[CC LOG] Could not preload scout autocomplete; background refresh will retry:',
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    f.consoleObject.warn('[CC LOG] Could not preload player server preferences; lookups will retry:',
        Object.assign(new Error('MySQL is temporarily unavailable.'), { code: 'DATABASE_UNAVAILABLE', causeCode: 'ETIMEDOUT' }));
    f.logger.start();
    assert.equal(f.printed.length, notices.length + 2);
    assert.equal(f.sent.length, 0);
    await f.clock.advance(5 * 60_000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].statusKey, 'database:mysql');
    assert.equal(f.logger.waiting.size, 0);
    // A real preload failure and a non-transient database failure still need attention.
    f.consoleObject.warn('[CC LOG] Could not preload player server preferences:', Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }));
    f.consoleObject.error('[CC LOG] Unexpected MySQL PvP King storage error:', Object.assign(new Error('Lost write'), { code: 'ETIMEDOUT' }));
    assert.equal(f.sent.length, 3);
    f.logger.stop();
});

test('the known loader deprecation stays in stderr and other Node warnings have one warning alert', () => {
    const f = fixture(); f.logger.start();
    f.consoleObject.error('(node:34) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.');
    f.logger.capture('warn', ['Node runtime warning:', Object.assign(new Error('fs.Stats constructor is deprecated.'),
        { name: 'DeprecationWarning', code: 'DEP0180' })]);
    assert.equal(f.sent.length, 0);
    f.consoleObject.error('(node:34) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.');
    f.logger.run({ component: 'Scout parsing', reportId: '123' }, () => {
        f.logger.capture('warn', ['Node runtime warning:', Object.assign(new Error('Possible EventEmitter memory leak detected.'),
            { name: 'MaxListenersExceededWarning' })]);
    });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].level, 'warn');
    assert.equal(f.sent[0].component, 'Bot runtime');
    assert.equal(f.sent[0].reportId, undefined);
    // A deprecation thrown as an exception is a real failure, not a warning notice.
    f.consoleObject.error('Unhandled rejection:', Object.assign(new Error('fs.Stats constructor is deprecated.'),
        { name: 'DeprecationWarning', code: 'DEP0180' }));
    assert.equal(f.sent.length, 2);
    f.logger.stop();
});

test('persistent MySQL alerts ping once until confirmed recovery even across error codes and report contexts', async () => {
    const f = fixture(); f.logger.start();
    f.logger.run({ component: 'Scout ingestion', reportId: '123', messageId: '124' }, () => {
        f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 5m (ECONNRESET; 5 failed attempt(s)).');
    });
    assert.equal(f.sent[0].component, 'MySQL');
    assert.equal(f.sent[0].reportId, undefined);
    assert.equal(f.sent[0].messageId, undefined);
    await settle();
    await f.clock.advance(5 * 60_000);
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 10m (ETIMEDOUT; 10 failed attempt(s)).');
    await f.clock.advance(5 * 60_000);
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 15m (ECONNREFUSED; 15 failed attempt(s)).');
    assert.equal(f.sent.length, 1);
    await f.clock.advance(20 * 60_000);
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 35m (ETIMEDOUT; 35 failed attempt(s)).');
    assert.equal(f.sent.length, 1);
    f.consoleObject.error('The database write failed.', Object.assign(new Error('Lost connection'), { code: 'ECONNRESET' }));
    assert.equal(f.sent.length, 2);
    f.logger.stop();
});

test('persistent autocomplete alerts have a 15-minute Discord cooldown', () => {
    let now = 1000;
    const f = fixture({ now: () => now }); f.logger.start();
    const notice = '[CC LOG] /scout autocomplete missed its Discord response deadline 5 times within 5 minutes.';
    f.consoleObject.warn(notice);
    now += 5 * 60_000;
    f.consoleObject.warn(notice);
    assert.equal(f.sent.length, 1);
    now += 10 * 60_000;
    f.consoleObject.warn(notice);
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].repeats, 1);
    f.logger.stop();
});

test('asynchronous scout work includes its known report and message IDs in the alert', async () => {
    const f = fixture(); f.logger.start();
    await f.logger.run({ component: 'Scout feedback', reportId: '1350059044102078494', messageId: '1350059160351412264' }, async () => {
        await Promise.resolve();
        f.consoleObject.error('Could not save feedback', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    });
    assert.equal(f.sent[0].reportId, '1350059044102078494');
    assert.equal(f.sent[0].messageId, '1350059160351412264');
    assert.equal(f.sent[0].code, 'ETIMEDOUT');
    f.logger.stop();
});

test('repeated errors do not flood the log channel, and a later alert includes the suppressed count', () => {
    let now = 1000;
    const f = fixture({ now: () => now }); f.logger.start();
    f.consoleObject.warn('Database still unavailable after 15s');
    f.consoleObject.warn('Database still unavailable after 30s');
    f.consoleObject.warn('Database still unavailable after 45s');
    assert.equal(f.sent.length, 1); assert.equal(f.printed.length, 3);
    now += 5 * 60_000;
    f.consoleObject.warn('Database still unavailable after 300s');
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1].repeats, 2);
    f.consoleObject.error('A different failure');
    assert.equal(f.sent.length, 3);
    f.logger.stop();
});

test('Discord copies remove configured secrets, REST tokens, SQL and request bodies', () => {
    const f = fixture({ secrets: ['private-token-123', 'private-db-password'] }); f.logger.start();
    f.consoleObject.error('private-token-123 https://discord.com/api/interactions/123/interaction-secret/callback',
        { message: 'password=private-db-password', code: 'EFAIL', sql: "SELECT 'private-sql'", requestBody: { token: 'private-body' } });
    const text = f.sent[0].message;
    assert.doesNotMatch(text, /private-token|private-db|private-sql|private-body|interaction-secret/u);
    assert.match(text, /redacted/u);
    // Long enough to look like a token to the redaction rule, without matching a real Discord token format.
    const token = `fake-test-token-${'abcdefghijklmnop'.repeat(2)}`;
    assert.doesNotMatch(redactDiagnostic(`mysql://user:password@host Bot ${token} Bearer ${token} https://discord.com/api/webhooks/123/secret`),
        /user:password|abcdefghijklmnop|123\/secret/u);
    assert.equal(redactDiagnostic('bot RSS 242.3 MiB; the bot could not send; bearer of bad news'),
        'bot RSS 242.3 MiB; the bot could not send; bearer of bad news', 'ordinary words after bot or bearer stay readable');
    f.logger.stop();
});

test('failed log sends cannot recursively log themselves or interfere with the original console call', () => {
    const f = fixture({ send: () => { throw new Error('Discord unavailable'); } }); f.logger.start();
    assert.doesNotThrow(() => f.consoleObject.error('Original failure'));
    f.consoleObject.warn('[CC LOG] Could not send bot diagnostic log: Missing permission');
    assert.equal(f.printed.length, 2);
    assert.equal(f.logger.recent.size, 1);
    f.logger.stop();
});

test('stopping restores console methods and does not modify unrelated logging hooks', () => {
    const printed = [], consoleObject = { warn: value => printed.push(value), error: value => printed.push(value) };
    const original = consoleObject.error;
    const logger = new DiscordDiagnosticLogger({ consoleObject, send: () => {} });
    logger.install(); logger.install();
    const otherWrapper = () => {};
    consoleObject.warn = otherWrapper;
    logger.stop();
    assert.equal(consoleObject.error, original);
    assert.equal(consoleObject.warn, otherWrapper);
    consoleObject.error('Still logged'); assert.deepEqual(printed, ['Still logged']);
});

test('Discord diagnostic messages omit the redundant CC tag without changing component context', () => {
    const f = fixture(); f.logger.start();
    f.logger.run({ component: 'Scout ingestion' }, () => {
        f.consoleObject.error('[CC LOG] Could not save report.');
    });
    assert.equal(f.sent[0].message, 'Could not save report.');
    assert.equal(f.sent[0].component, 'Scout ingestion');
    f.consoleObject.error('[DB LOG] MySQL query failed.');
    assert.match(f.sent[1].message, /^\[DB LOG\] MySQL query failed/u);
    assert.equal(f.sent[1].component, 'MySQL');
    f.logger.stop();
});

test('recoverable warnings get a reply only after the same subsystem reports recovery', async () => {
    const { logger, consoleObject, sent, printed, clock } = fixture(); logger.start();
    const scenarios = [
        ['[CC LOG] PRO Forum Shop monitor is unavailable. Retrying in 12 minute(s): fetch failed',
            '[CC LOG] PRO Forum Shop monitor connection restored.'],
        ['[CC LOG] PRO Dungeon Shop monitor is unavailable. Retrying in 12 minute(s): HTTP 522',
            '[CC LOG] PRO Dungeon Shop monitor connection restored.'],
        ['[CC LOG] PRO auction monitor is unavailable. Retrying in 2 minute(s); pending work retained: PRO auction request timed out after 15000 ms (active listings page 1).',
            '[CC LOG] PRO auction monitor connection restored.'],
        ['[CC LOG] Discord interaction connection warmup failed (ETIMEDOUT). Initial responses may need a new connection.',
            '[CC LOG] Discord interaction connection warmup recovered.'],
        ['[RUNTIME MEMORY] CRITICAL: 460.8/512.0 MiB (90.0%; container); OCR 0 queued/active task(s).',
            '[RUNTIME MEMORY] Recovered below 75%: 380.0/512.0 MiB (container).'],
        ['[CC LOG] MySQL PvP King Gold storage unavailable (ECONNREFUSED). Using the synchronized JSON snapshot; writes will queue for recovery.',
            '[CC LOG] MySQL PvP King Gold storage restored; pending JSON operations will synchronize automatically.'],
        ['[PRO NOTIFICATIONS] MySQL storage unavailable (ETIMEDOUT). Using JSON; pending settings and subscriptions will retry automatically.',
            '[PRO NOTIFICATIONS] MySQL storage restored; pending JSON data is synchronizing.']
    ];
    for (const [warning, recovery] of scenarios) {
        consoleObject.warn(warning);
        await clock.advance(10 * 60_000);
        consoleObject.log(recovery);
        await settle();
    }
    assert.equal(sent.length, scenarios.length * 2);
    for (let index = 0; index < scenarios.length; index++) {
        const warning = sent[index * 2], recovery = sent[index * 2 + 1];
        assert.equal(warning.status, 'unavailable');
        assert.equal(recovery.status, 'recovered');
        assert.equal(recovery.replyTo, `message-${index * 2 + 1}`);
        assert.equal(recovery.statusKey, warning.statusKey);
    }
    assert.equal(printed.length, scenarios.length * 2);
    logger.stop();
});

test('unmatched recovery logs do not create standalone Discord alerts', () => {
    const f = fixture(); f.logger.start();
    f.consoleObject.log('[CC LOG] PRO Forum Shop monitor connection restored.');
    assert.deepEqual(f.sent, []);
    f.logger.stop();
});

test('brief auction forum timeouts stay local while persistent outages alert once under PRO Auctions and recover in a reply', async t => {
    const f = fixture();
    t.after(() => f.logger.stop());
    f.logger.start();
    const warning = '[CC LOG] PRO auction monitor is unavailable. Retrying in 2 minute(s); pending work retained:';
    const detail = 'PRO auction request timed out after 15000 ms (active listings page 1).';
    f.consoleObject.warn(warning, detail, { code: 'ETIMEDOUT' });
    assert.equal(f.printed.length, 1);
    assert.deepEqual(f.sent, []);
    await f.clock.advance(120000);
    f.consoleObject.log('[CC LOG] PRO auction monitor connection restored.');
    await f.clock.advance(10 * 60000);
    assert.deepEqual(f.sent, []);
    f.consoleObject.warn(warning, detail, { code: 'ETIMEDOUT' });
    await f.clock.advance(10 * 60000 - 1);
    assert.deepEqual(f.sent, []);
    await f.clock.advance(1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].statusKey, 'forum:auctions');
    assert.equal(f.sent[0].component, 'PRO Auctions');
    assert.equal(f.sent[0].code, 'ETIMEDOUT');
    f.consoleObject.warn(warning, detail, { code: 'ETIMEDOUT' });
    await f.clock.advance(120000);
    assert.equal(f.sent.length, 1);
    f.consoleObject.warn('[CC LOG] PRO auction monitor failed; retaining pending work:', 'disk failure');
    assert.equal(f.sent.length, 2, 'unexpected monitor failures remain immediate');
    f.consoleObject.log('[CC LOG] PRO auction monitor connection restored.');
    await settle();
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[2].status, 'recovered');
    assert.equal(f.sent[2].replyTo, 'message-1');
    assert.equal(f.sent[2].statusKey, 'forum:auctions');
});

test('a recoverable outage resolved before Discord is ready does not post a stale warning later', () => {
    const f = fixture();
    f.consoleObject.warn('[CC LOG] PRO Forum Shop monitor is unavailable. Retrying in 1 minute(s): fetch failed');
    f.consoleObject.log('[CC LOG] PRO Forum Shop monitor connection restored.');
    f.logger.start();
    assert.deepEqual(f.sent, []);
    assert.equal(f.logger.waiting.size, 0);
    f.logger.stop();
});

test('failed alert delivery retries with the same nonce, then recovery replies to the confirmed alert', async t => {
    for (const failure of [() => null, () => Promise.reject(new Error('Discord unavailable'))]) {
        let calls = 0;
        const sent = [];
        const f = fixture({ send: event => {
            sent.push(event);
            if (++calls === 1) return failure();
            return { id: `message-${calls}`, attachments: new Map() };
        } });
        t.after(() => f.logger.stop()); f.logger.start();
        const warning = '[CC LOG] PRO Forum Shop monitor is unavailable. Retrying in 1 minute(s): fetch failed';
        f.consoleObject.warn(warning);
        await f.clock.advance(10 * 60_000);
        await f.clock.advance(30_000);
        assert.equal(sent[0].nonce, sent[1].nonce);
        f.consoleObject.log('[CC LOG] PRO Forum Shop monitor connection restored.');
        await settle();
        assert.equal(sent[2].replyTo, 'message-2');
        f.consoleObject.warn(warning);
        await f.clock.advance(10 * 60_000);
        assert.equal(sent[3].status, 'unavailable');
        assert.notEqual(sent[3].nonce, sent[0].nonce);
        assert.equal(calls, 4);
    }
});

test('pending recovery replies are cancelled at shutdown', async () => {
    let finish;
    const sent = [], pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ send: event => { sent.push(event); return pending; } });
    f.logger.start();
    f.consoleObject.warn('[CC LOG] PRO Forum Shop monitor is unavailable. Retrying in 1 minute(s): fetch failed');
    await f.clock.advance(10 * 60_000);
    f.consoleObject.log('[CC LOG] PRO Forum Shop monitor connection restored.');
    f.logger.stop();
    finish({ id: 'warning' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
});

test('Gold and Silver storage outages share one ping and recover only when both sources confirm success', async t => {
    const PvpKingStorage = require('../commands/pvp-king/utils/pvpKingStorage.js');
    const sent = [];
    const f = fixture({ send: event => { sent.push(event); return { id: `message-${sent.length}` }; } });
    t.after(() => f.logger.stop()); f.logger.start();
    t.mock.method(console, 'warn', f.consoleObject.warn);
    t.mock.method(console, 'log', f.consoleObject.log);
    const gold = new PvpKingStorage({ server: 'gold' }), silver = new PvpKingStorage({ server: 'silver' });
    const outage = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
    f.logger.run({ component: 'Scout ingestion', reportId: '123', messageId: '456' }, () => {
        gold.noteMysqlFailure(outage); silver.noteMysqlFailure(outage);
    });
    await f.clock.advance(5 * 60_000);
    assert.deepEqual(sent.map(event => event.statusKey), ['database:mysql']);
    assert.ok(sent.every(event => event.reportId === undefined && event.messageId === undefined));
    gold.noteMysqlRestored();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.equal(f.logger.incidents.active.has('database:mysql'), true);
    silver.noteMysqlRestored();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent[1].replyTo, 'message-1');
    assert.equal(f.logger.incidents.active.has('database:mysql'), false);
});

const timedServices = [
    { name: 'MySQL', delay: 5 * 60_000,
        warning: '[DB LOG] MySQL connectivity issue detected (ECONNREFUSED). Query retries and feature fallbacks are active.',
        recovery: '[DB LOG] MySQL connection restored after 5m (2 failed attempt(s)).' },
    { name: 'command registration', delay: 5 * 60_000,
        warning: '[CC LOG] ❌ ERROR: Command registration failed: ETIMEDOUT',
        recovery: '[CC LOG] ✅ Guild slash commands registered to Discord' },
    { name: 'Discord REST warmup', delay: 5 * 60_000,
        warning: '[CC LOG] Discord interaction connection warmup failed (ETIMEDOUT). Initial responses may need a new connection.',
        recovery: '[CC LOG] Discord interaction connection warmup recovered.' },
    { name: 'CC tag verification', delay: 5 * 60_000,
        warning: '[CC TAG] Discord verification unavailable (EAI_AGAIN). Tag checks will retry automatically.',
        recovery: '[CC TAG] Discord verification restored. Pending tag checks have completed.' },
    { name: 'container memory accounting', delay: 5 * 60_000,
        warning: '[RUNTIME MEMORY] Container accounting unavailable. Process RSS fallback is active.',
        recovery: '[RUNTIME MEMORY] Container accounting restored. Container memory checks are active.' },
    ...['PRO Forum Shop', 'PRO Dungeon Shop', 'PRO Forum application'].map(name => ({ name, delay: 10 * 60_000,
        warning: `[CC LOG] ${name} monitor is unavailable. Retrying in 12 minute(s): fetch failed`,
        recovery: `[CC LOG] ${name} monitor connection restored.` }))
];

for (const service of timedServices) {
    test(`${service.name} alerts at its threshold from the first failure and pings once per incident`, async t => {
        const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
        f.consoleObject.warn(service.warning);
        await f.clock.advance(service.delay - 1);
        assert.equal(f.sent.length, 0);
        f.consoleObject.warn(service.warning);
        await f.clock.advance(1);
        assert.equal(f.sent.length, 1);
        assert.equal(f.sent[0].timestamp, new Date(1000).toISOString());
        await f.clock.advance(service.delay);
        f.consoleObject.warn(service.warning);
        assert.equal(f.sent.length, 1);
        f.consoleObject.log(service.recovery); await settle();
        assert.equal(f.sent.length, 2);
        assert.equal(f.sent[1].status, 'recovered');
        assert.equal(f.sent[1].replyTo, 'message-1');
        assert.equal(f.sent[1].durationMs, service.delay * 2);
        // Recovery starts a new incident clock, rather than reusing the old alert.
        f.consoleObject.warn(service.warning);
        await f.clock.advance(service.delay - 1);
        assert.equal(f.sent.length, 2);
        await f.clock.advance(1);
        assert.equal(f.sent.length, 3);
        assert.notEqual(f.sent[2].nonce, f.sent[0].nonce);
    });
}

test('brief service interruptions stay in the console without warning or recovery messages', async t => {
    for (const service of timedServices) {
        const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
        f.consoleObject.warn(service.warning);
        await f.clock.advance(service.delay - 1);
        f.consoleObject.log(service.recovery);
        await f.clock.advance(service.delay * 2);
        assert.equal(f.sent.length, 0, service.name);
        assert.equal(f.printed.length, 2);
        assert.equal(f.clock.timers.size, 0);
    }
});

test('a long outage resolved before login still sends its warning followed by confirmed recovery', async t => {
    const f = fixture(); t.after(() => f.logger.stop());
    const service = timedServices[0];
    f.consoleObject.warn(service.warning);
    await f.clock.advance(service.delay + 10_000);
    f.consoleObject.log(service.recovery);
    assert.equal(f.sent.length, 0);
    f.logger.start(); await settle();
    assert.deepEqual(f.sent.map(event => event.status), ['unavailable', 'recovered']);
    assert.equal(f.sent[1].durationMs, service.delay + 10_000);
});

test('urgent data loss and unexpected failures alert immediately and corruption never auto-recovers', async t => {
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    f.consoleObject.error('Background job crashed:', new Error('Unexpected exception'));
    f.consoleObject.error('Could not save settings JSON:', Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    f.consoleObject.warn('[CC LOG] MySQL Guild Application storage unavailable. Using JSON fallback:',
        Object.assign(new Error('JSON recovery paused; original data preserved at data.json.corrupt-123'), { code: 'JSON_STORE_CORRUPT' }));
    f.consoleObject.warn('[CC LOG] Guild Application local JSON storage cannot write:',
        Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }));
    assert.equal(f.sent.length, 4);
    assert.ok(f.sent.every(event => event.status !== 'recovered'));
    f.consoleObject.log('[CC LOG] MySQL Guild Application storage restored.');
    f.consoleObject.log('[CC LOG] Guild Application local JSON storage restored.');
    await f.clock.advance(10 * 60_000);
    assert.equal(f.sent.length, 4);
});

test('local JSON write retries alert immediately, memory pressure after one minute, and neither repeatedly pings', async t => {
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    const json = '[CC LOG] Guild Application local JSON storage cannot write: EACCES';
    const memory = '[RUNTIME MEMORY] WARNING: 420.0/512.0 MiB (82.0%; container).';
    f.consoleObject.warn(json); f.consoleObject.warn(memory); await settle();
    assert.equal(f.sent.length, 1);
    await f.clock.advance(60_000);
    assert.equal(f.sent.length, 2);
    await f.clock.advance(30 * 60_000);
    f.consoleObject.warn(json); f.consoleObject.warn(memory);
    assert.equal(f.sent.length, 2);
    f.consoleObject.log('[CC LOG] Guild Application local JSON storage restored.');
    f.consoleObject.log('[RUNTIME MEMORY] Recovered below 75%: 370.0/512.0 MiB (container).');
    await settle();
    assert.equal(f.sent.length, 4);
});

for (const label of ['WARNING', 'CRITICAL']) test(`${label.toLowerCase()} memory pressure that lasts a minute alerts once and recovers normally`, async t => {
    const f = fixture();
    t.after(() => f.logger.stop()); f.logger.start();
    f.consoleObject.warn(`[RUNTIME MEMORY] ${label}: 470.0/512.0 MiB (91.8%; container).`);
    await f.clock.advance(59_999);
    assert.equal(f.sent.length, 0, 'the console logs it at once, Discord waits one minute');
    await f.clock.advance(1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].timestamp, new Date(1000).toISOString());
    assert.equal(f.sent[0].statusKey, 'runtime:memory-pressure');
    assert.ok(f.sent[0].message.includes(label));
    f.consoleObject.warn(`[RUNTIME MEMORY] ${label}: 470.0/512.0 MiB (91.8%; container).`);
    await settle();
    assert.equal(f.sent.length, 1);
    await f.clock.advance(20_000);
    f.consoleObject.log('[RUNTIME MEMORY] Recovered below 75%: 370.0/512.0 MiB (container).');
    await settle();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[1].status, 'recovered');
    assert.equal(f.sent[1].replyTo, 'message-1');
    assert.equal(f.sent[1].durationMs, 80_000);
});

test('a memory spike that recovers within a minute stays in the console', async t => {
    const f = fixture();
    t.after(() => f.logger.stop()); f.logger.start();
    f.consoleObject.warn('[RUNTIME MEMORY] WARNING: 443.7/512.0 MiB (86.7%; container working set).');
    f.consoleObject.warn('[RUNTIME MEMORY] CRITICAL: 472.7/512.0 MiB (92.3%; container working set).');
    await f.clock.advance(3_000);
    f.consoleObject.log('[RUNTIME MEMORY] Recovered below 75%: 254.1/512.0 MiB (49.6%; container working set).');
    await f.clock.advance(5 * 60_000);
    assert.equal(f.sent.length, 0);
    assert.equal(f.clock.timers.size, 0);
});

test('pre-login memory warnings that last a minute deliver once Discord is ready', async t => {
    const f = fixture();
    t.after(() => f.logger.stop());
    f.consoleObject.warn('[RUNTIME MEMORY] WARNING: 420.0/512.0 MiB (82.0%; container).');
    await settle();
    assert.equal(f.sent.length, 0);
    f.logger.start(); f.logger.start(); await settle();
    assert.equal(f.sent.length, 0);
    await f.clock.advance(60_000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].statusKey, 'runtime:memory-pressure');
    assert.equal(f.sent[0].timestamp, new Date(1000).toISOString());
});

test('OCR pressure warnings deliver immediately after login, including buffered startup warnings', async t => {
    const notice = '[CC LOG] OCR memory pressure: briefly delaying the next image (up to 5 seconds).';
    for (const beforeLogin of [true, false]) {
        const f = fixture(); t.after(() => f.logger.stop());
        if (!beforeLogin) f.logger.start();
        f.consoleObject.warn(notice);
        assert.equal(f.sent.length, beforeLogin ? 0 : 1);
        f.logger.start(); await settle();
        assert.equal(f.sent.length, 1);
        assert.match(f.sent[0].message, /OCR memory pressure/);
        assert.equal(f.sent[0].timestamp, new Date(1000).toISOString());
        f.consoleObject.warn(notice);
        assert.equal(f.sent.length, 1);
    }
});

test('gateway interruptions wait one minute and require every disconnected shard to recover', async t => {
    const f = fixture(), client = new EventEmitter(); t.after(() => f.logger.stop());
    f.logger.watchGateway(client); f.logger.watchGateway(client); f.logger.start();
    client.emit(Events.ShardReady, 0);
    client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
    await f.clock.advance(59_999);
    assert.equal(f.sent.length, 0);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardDisconnect, { code: 1006 }, 1);
    await f.clock.advance(1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].statusKey, 'discord:gateway');
    client.emit(Events.ShardResume, 0, 4); await settle();
    assert.equal(f.sent.length, 1);
    client.emit(Events.ShardReady, 1); await settle();
    assert.equal(f.sent[1].replyTo, 'message-1');
    // A later 59-second interruption stays local.
    client.emit(Events.ShardDisconnect, {}, 0);
    await f.clock.advance(59_000);
    client.emit(Events.ShardResume, 0, 1);
    await f.clock.advance(60_000);
    assert.equal(f.sent.length, 2);
    f.logger.stop();
    assert.equal(client.eventNames().length, 0);
    assert.equal(f.clock.timers.size, 0);
});

test('gateway diagnostics preserve close codes, durations and session outcomes without raw close text', async t => {
    const f = fixture(), client = new EventEmitter(); t.after(() => f.logger.stop());
    f.logger.watchGateway(client); f.logger.start();
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardDisconnect, { code: 4009, reason: 'private-token\nunsafe text' }, 0);
    await f.clock.advance(1500);
    client.emit(Events.ShardResume, 0, 4);
    assert.ok(f.printed.some(row => /4009 \(SessionTimedOut\)/u.test(row[1])));
    assert.match(f.printed.at(-1)[1], /Downtime 1.5s; previous session resumed/);
    client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
    await f.clock.advance(500);
    client.emit(Events.ShardReady, 0);
    assert.match(f.printed.at(-1)[1], /Downtime 0.5s; new session ready/);
    assert.ok(f.printed.every(row => !/private-token|unsafe/u.test(row[1])));
    assert.equal(f.sent.length, 0);
});

test('recovery delivery retries without another warning ping and preserves a new concurrent outage', async t => {
    let resolveRecovery;
    const sent = [];
    const f = fixture({ send: event => {
        sent.push(event);
        if (sent.length === 2) return new Promise(resolve => { resolveRecovery = resolve; });
        if (sent.length === 3) return null;
        return { id: `message-${sent.length}` };
    } });
    t.after(() => f.logger.stop()); f.logger.start();
    const service = timedServices[0];
    f.consoleObject.warn(service.warning); await f.clock.advance(service.delay);
    f.consoleObject.log(service.recovery);
    f.consoleObject.warn(service.warning);
    resolveRecovery(null); await settle();
    await f.clock.advance(30_000); // First retry also fails.
    await f.clock.advance(60_000); // Second retry succeeds.
    assert.deepEqual(sent.map(event => event.status), ['unavailable', 'recovered', 'recovered', 'recovered']);
    assert.equal(sent[1].nonce, sent[2].nonce);
    assert.equal(sent[2].nonce, sent[3].nonce);
    assert.ok(sent.slice(1).every(event => event.replyTo === 'message-1'));
    await f.clock.advance(service.delay - 90_000);
    assert.equal(sent[4].status, 'unavailable');
    assert.notEqual(sent[4].nonce, sent[0].nonce);
    f.consoleObject.log(service.recovery); await settle();
    assert.equal(sent[5].replyTo, 'message-5');
});

test('an outage that heals during failed delivery is reported once when delivery resumes', async t => {
    let available = false;
    const sent = [];
    const f = fixture({ send: event => { sent.push(event); return available ? { id: `message-${sent.length}` } : null; } });
    t.after(() => f.logger.stop()); f.logger.start();
    const service = timedServices[0];
    f.consoleObject.warn(service.warning); await f.clock.advance(service.delay);
    f.consoleObject.log(service.recovery); await settle();
    available = true;
    await f.clock.advance(30_000);
    assert.deepEqual(sent.map(event => event.status), ['unavailable', 'unavailable', 'recovered']);
    assert.equal(sent[0].nonce, sent[1].nonce);
    assert.equal(sent[2].replyTo, 'message-2');
});

test('synchronous send failures do not leave extra timers and shutdown cancels delayed alerts', async () => {
    const f = fixture({ send: () => { throw new Error('Offline'); } }); f.logger.start();
    f.consoleObject.warn(timedServices[0].warning);
    f.consoleObject.warn(timedServices[3].warning);
    f.consoleObject.warn('[RUNTIME MEMORY] WARNING: 420.0/512.0 MiB (82.0%; container).');
    assert.equal(f.clock.timers.size, 1);
    await f.clock.advance(5 * 60_000);
    assert.equal(f.clock.timers.size, 1);
    f.logger.stop();
    assert.equal(f.clock.timers.size, 0);
    await f.clock.advance(10 * 60_000);
    assert.equal(f.logger.incidents.pending.size, 0);
});

test('registration failure allows startup to continue, retries with backoff and confirms recovery', async t => {
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    let calls = 0;
    const registration = new CommandRegistration({ consoleObject: f.consoleObject,
        schedule: f.clock.schedule, cancel: f.clock.cancel,
        register: async () => { if (++calls < 4) throw new Error('Discord REST unavailable'); } });
    t.after(() => registration.stop());
    await assert.doesNotReject(registration.start());
    assert.equal(calls, 1);
    await f.clock.advance(60_000); assert.equal(calls, 2);
    await f.clock.advance(120_000); assert.equal(calls, 3);
    await f.clock.advance(120_000);
    assert.equal(f.sent.length, 1); // Five minutes from the first failure.
    await f.clock.advance(120_000); assert.equal(calls, 4);
    assert.deepEqual(f.sent.map(event => event.status), ['unavailable', 'recovered']);
    assert.equal(f.clock.timers.size, 0);
    await registration.start();
    assert.equal(calls, 4);
});

test('a command registration retry that succeeds within five minutes creates no Discord alerts', async t => {
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    let calls = 0;
    const registration = new CommandRegistration({ consoleObject: f.consoleObject,
        schedule: f.clock.schedule, cancel: f.clock.cancel,
        register: async () => { if (++calls === 1) throw new Error('Temporary outage'); } });
    t.after(() => registration.stop());
    await registration.start(); await f.clock.advance(60_000);
    await f.clock.advance(10 * 60_000);
    assert.equal(calls, 2);
    assert.equal(f.sent.length, 0);
});

test('registration attempts cannot overlap and abort discards an in-flight result', async t => {
    const f = fixture(); t.after(() => f.logger.stop());
    const controller = new AbortController();
    let calls = 0, finish;
    const registration = new CommandRegistration({ signal: controller.signal, consoleObject: f.consoleObject,
        schedule: f.clock.schedule, cancel: f.clock.cancel,
        register: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const attempt = registration.start();
    await registration.start();
    assert.equal(calls, 1);
    controller.abort(); finish(); await attempt;
    assert.equal(f.printed.length, 1); // Only the initial "Registering..." line.
    assert.equal(f.clock.timers.size, 0);
    await registration.start();
    assert.equal(calls, 1);
});

test('registration retries stop on shutdown and never start for an already aborted bootstrap', async t => {
    const f = fixture(); t.after(() => f.logger.stop());
    const controller = new AbortController();
    let calls = 0;
    const options = { signal: controller.signal, consoleObject: f.consoleObject,
        schedule: f.clock.schedule, cancel: f.clock.cancel,
        register: async () => { calls++; throw new Error('Offline'); } };
    const registration = new CommandRegistration(options);
    await registration.start();
    assert.equal(calls, 1);
    assert.equal(f.clock.timers.size, 1);
    controller.abort();
    assert.equal(f.clock.timers.size, 0);
    await f.clock.advance(10 * 60_000);
    assert.equal(calls, 1);
    await new CommandRegistration(options).start();
    assert.equal(calls, 1);
});

test('member audit database failures wait five minutes and recover after synchronization succeeds', async t => {
    const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, f.consoleObject[level]);
    let offline = true;
    const history = new MemberAuditHistory({ db: { hasRequiredConfig: true, query: async () => {
        if (offline) throw Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
        return [[], []];
    } } });
    await history.restore();
    assert.equal(f.sent.length, 0);
    await f.clock.advance(5 * 60_000);
    assert.equal(f.sent[0].statusKey, 'database:mysql');
    offline = false; await history.restore(); await settle();
    assert.equal(f.sent[1].replyTo, 'message-1');
});

test('a failed member audit JSON save alerts immediately instead of becoming a database outage', t => {
    const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-history-alert-'));
    t.after(() => fs.rmdirSync(directory));
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, f.consoleObject[level]);
    const filePath = path.join(directory, 'history.json');
    const history = new MemberAuditHistory({ storageMode: 'json', filePath });
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
        if (file === `${filePath}.tmp`) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        return write(file, ...args);
    });
    history.recordJoin({ id: 'member', guild: { id: 'guild' }, joinedTimestamp: 1000 });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].level, 'error');
    assert.match(f.sent[0].message, /local JSON storage failed/u);
    assert.equal(f.sent[0].statusKey, undefined);
    assert.equal(f.logger.incidents.active.size, 0);
});

test('corrupt member audit database JSON alerts immediately and does not falsely announce recovery', async t => {
    const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');
    const f = fixture(); t.after(() => f.logger.stop()); f.logger.start();
    for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, f.consoleObject[level]);
    let corrupt = true;
    const history = new MemberAuditHistory({ db: { hasRequiredConfig: true, query: async sql => [
        !sql.startsWith('CREATE') && corrupt ? [{ state_json: '{ invalid JSON' }] : [], []
    ] } });
    await history.restore();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].level, 'error');
    assert.match(f.sent[0].message, /data is corrupted/u);
    corrupt = false; await history.restore();
    await f.clock.advance(10 * 60_000);
    assert.equal(f.sent.length, 1);
});

test('a retrospective database duration does not change the nonce of an unconfirmed alert retry', async t => {
    const sent = [];
    const f = fixture({ send: event => { sent.push(event); return null; } });
    t.after(() => f.logger.stop()); f.logger.start();
    f.consoleObject.warn(timedServices[0].warning);
    await f.clock.advance(5 * 60_000);
    f.consoleObject.warn('[DB LOG] MySQL is still unavailable after 6m (ECONNREFUSED).');
    await f.clock.advance(30_000);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].nonce, sent[1].nonce);
});
