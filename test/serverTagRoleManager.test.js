'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Collection, Events, GuildMemberFlagsBitField, UserFlagsBitField, UserFlags, GuildMemberFlags } = require('discord.js');
const { ServerTagRoleManager, serverTagStatus, policyReason } = require('../utils/serverTagRoleManager.js');
const { rolePanelReason, roleSource } = require('../utils/roleAuditSource.js');
const { buildMemberJoinPayload } = require('../events/memberJoinLogs.js');
const roleEvents = require('../events/roleDetector.js');
const { buildMemberAuditPayload } = require('../utils/memberAuditEmbeds.js');

const GUILD = '1148499020038295582', USER = '296447098298171393', ROLE = '1483676323301036072';
const PANEL = '1184121209609269409', BOT = '223456789012345678';
const actor = { id: '123456789012345678', username: 'Vangogsan', globalName: 'Am1damaru' };
const rawTag = enabled => ({ primary_guild: enabled === null ? null : { identity_enabled: enabled, identity_guild_id: GUILD } });
const json = payload => payload.embeds[0].toJSON();

function fixture({ tag = true, hasRole = false, permission = true, editable = true, onCorrection } = {}) {
    const client = new EventEmitter();
    client.user = { id: BOT, username: 'WW-Bot', bot: true };
    client.isReady = () => true;
    const role = { id: ROLE, name: 'White Walker', managed: false, editable };
    const guild = { id: GUILD, available: true, memberCount: 184,
        roles: { cache: new Collection([[ROLE, role]]) }, channels: { cache: new Collection() } };
    const user = { id: USER, username: 'kaasfondue', globalName: 'Kaasfondue', bot: false,
        createdTimestamp: Date.UTC(2017, 2, 29), displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' };
    const member = { id: USER, guild, user, nickname: 'Kaasfondue', joinedTimestamp: Date.now(),
        flags: new GuildMemberFlagsBitField(), roles: { cache: new Collection(hasRole ? [[ROLE, role]] : []) } };
    const calls = [], notifications = [], corrections = [];
    member.roles.add = async (id, reason) => { calls.push({ added: true, id, reason }); member.roles.cache.set(id, role); return member; };
    member.roles.remove = async (id, reason) => { calls.push({ added: false, id, reason }); member.roles.cache.delete(id); return member; };
    guild.members = { cache: new Collection([[USER, member]]), me: { permissions: { has: () => permission } },
        fetch: async () => member, list: async () => new Collection([[USER, member]]) };
    client.guilds = { cache: new Collection([[GUILD, guild]]) };
    let metadata = rawTag(tag), time = Date.now();
    client.rest = { get: async () => metadata };
    const controller = new AbortController();
    const manager = new ServerTagRoleManager({ client, guildId: GUILD, roleId: ROLE, signal: controller.signal,
        now: () => time, spacingMs: 0, onTagChange: async (_, enabled) => notifications.push(enabled),
        onCorrection: onCorrection || (async (_, detail) => corrections.push(detail)) });
    return { client, guild, user, member, role, manager, controller, calls, notifications, corrections,
        setTag: value => { metadata = value; }, advance: ms => { time += ms; } };
}

test('brief DNS failures retry read-only lookups and confirm the role before reporting recovery', async t => {
    const warnings = [], logs = [], waits = [];
    t.mock.method(console, 'warn', text => warnings.push(text));
    t.mock.method(console, 'log', text => logs.push(text));
    const f = fixture(); t.after(() => f.manager.stop());
    f.manager.pause = async ms => waits.push(ms);
    let reads = 0;
    f.client.rest.get = async () => {
        if (++reads < 3) throw Object.assign(new Error('lookup failed'), { cause: Object.assign(new Error('DNS'), { code: 'EAI_AGAIN' }) });
        return rawTag(true);
    };
    assert.equal((await f.manager.request(f.member)).status, 'corrected');
    assert.deepEqual(waits, [1000, 3000]);
    assert.equal(f.calls.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Discord verification unavailable \(EAI_AGAIN\)/);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Discord verification restored/);
    assert.equal(f.manager.retryTimer, null);
});

test('persistent DNS failures defer the sweep with one retry timer instead of querying every member', async t => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {});
    const f = fixture(); t.after(() => f.manager.stop());
    f.manager.pause = async () => {};
    const timers = new Set();
    f.manager.scheduleTimeout = callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; };
    f.manager.cancelTimeout = timer => timers.delete(timer);
    const second = { ...f.member, id: '123456789012345679' };
    f.guild.members.list = async () => new Collection([[USER, f.member], [second.id, second]]);
    let reads = 0, unavailable = true;
    f.client.rest.get = async () => {
        reads++;
        if (unavailable) throw Object.assign(new Error('DNS'), { code: 'EAI_AGAIN' });
        return rawTag(true);
    };
    await f.manager.sweep();
    assert.equal(reads, 3);
    assert.equal(timers.size, 1);
    assert.equal(f.calls.length, 0);
    unavailable = false;
    const timer = [...timers][0]; timers.delete(timer); timer.callback();
    while (f.manager.sweeping) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.manager.networkUnavailable, false);
    assert.equal(f.manager.retryTimer, null);
    assert.equal(timers.size, 0);
    assert.equal(f.calls.length, 1);
});

test('permission failures are immediate and never retried as network interruptions', async t => {
    const warnings = [];
    t.mock.method(console, 'warn', text => warnings.push(text));
    const f = fixture(); t.after(() => f.manager.stop());
    let reads = 0;
    f.manager.pause = async () => assert.fail('must not retry permissions');
    f.client.rest.get = async () => { reads++; throw Object.assign(new Error('Missing access'), { code: 50001, status: 403 }); };
    assert.equal((await f.manager.request(f.member)).status, 'failed');
    assert.equal(reads, 1);
    assert.match(warnings[0], /Missing access/);
    assert.equal(f.manager.retryTimer, null);
});

test('shutdown cancels lookup backoff without another request or a late retry timer', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture(); f.manager.lookupRetryDelays = [60000];
    let reads = 0;
    f.client.rest.get = async () => { reads++; throw Object.assign(new Error('DNS'), { code: 'EAI_AGAIN' }); };
    const pending = f.manager.request(f.member);
    await new Promise(resolve => setImmediate(resolve));
    f.manager.stop();
    await pending;
    assert.equal(reads, 1);
    assert.equal(f.manager.retryTimer, null);
    assert.equal(f.manager.pending.size, 0);
});

test('an uncertain role-write response triggers verification without repeating a confirmed correction', async t => {
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {});
    const f = fixture(); t.after(() => f.manager.stop());
    const add = f.member.roles.add;
    f.member.roles.add = async (...args) => {
        await add(...args);
        throw Object.assign(new Error('connection lost after write'), { code: 'ECONNRESET' });
    };
    assert.equal((await f.manager.request(f.member)).status, 'unavailable');
    assert.equal((await f.manager.request(f.member)).status, 'compliant');
    assert.equal(f.calls.length, 1);
    assert.equal(f.manager.networkUnavailable, false);
    assert.equal(f.manager.retryTimer, null);
});

test('verification recovery waits for every affected member and stopping cancels its queued sweep', async t => {
    const logs = [];
    t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', text => logs.push(text));
    const f = fixture({ hasRole: true });
    const timers = new Set();
    f.manager.scheduleTimeout = callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; };
    f.manager.cancelTimeout = timer => timers.delete(timer);
    const error = Object.assign(new Error('DNS'), { code: 'EAI_AGAIN' });
    f.manager.noteUnavailable(USER, error);
    f.manager.noteUnavailable('another-member', error);
    f.manager.retryVerification();
    await f.manager.request(f.member);
    assert.equal(logs.length, 0);
    assert.equal(timers.size, 1);
    const queued = [...timers][0];
    f.manager.stop(); queued.callback();
    assert.equal(timers.size, 0);
    assert.equal(f.manager.retryTimer, null);
    assert.equal(logs.length, 0);
});

test('tag metadata distinguishes absent or incomplete data from an explicit tag removal', () => {
    assert.equal(serverTagStatus({}, GUILD), undefined);
    assert.equal(serverTagStatus({ primary_guild: {} }, GUILD), undefined);
    assert.equal(serverTagStatus({ primaryGuild: { identityEnabled: true } }, GUILD), undefined);
    assert.equal(serverTagStatus(rawTag(null), GUILD), false);
    assert.equal(serverTagStatus(rawTag(false), GUILD), false);
    assert.equal(serverTagStatus(rawTag(true), GUILD), true);
    assert.equal(serverTagStatus({ primaryGuild: { identityEnabled: true, identityGuildId: 'other' } }, GUILD), false);
});

test('WW-Bot assigns a role for its tag and removes an unauthorized role without RaidProtect', async () => {
    for (const tag of [true, false]) {
        const f = fixture({ tag, hasRole: !tag });
        const result = await f.manager.request(f.member);
        assert.equal(result.status, 'corrected');
        assert.equal(f.member.roles.cache.has(ROLE), tag);
        assert.deepEqual(f.calls.map(call => [call.added, call.id]), [[tag, ROLE]]);
        assert.equal(f.corrections[0].success, true);
        assert.doesNotMatch(f.calls[0].reason, /role_update|RaidProtect/);
        assert.equal(f.manager.consumeExpectedChange(f.member, tag).added, tag);
        assert.equal(f.manager.consumeExpectedChange(f.member, tag), null);
    }
});

test('manual removal is restored for a tag wearer and invalid manual addition is reversed', async () => {
    for (const tag of [true, false]) {
        const f = fixture({ tag, hasRole: !tag });
        const enforcement = await f.manager.request(f.member, { reportCorrection: false });
        const payload = json(roleEvents.buildWwRolePayload(f.member, { role: f.role, added: !tag, entry: { executor: actor }, enforcement }));
        assert.match(payload.author.name, /Intercepted/);
        assert.match(payload.description, /<@123456789012345678> tried to/);
        assert.match(payload.description, tag ? /restored the role/ : /removed the role again/);
        assert.match(payload.description, /Confirmed by Discord/);
        assert.equal(f.corrections.length, 0);
    }
});

test('unknown metadata never strips a role or invents a confirmed interception', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture({ hasRole: true }); f.setTag({ id: USER });
    const enforcement = await f.manager.request(f.member);
    assert.equal(enforcement.status, 'unknown'); assert.equal(f.calls.length, 0);
    const payload = json(roleEvents.buildWwRolePayload(f.member, { role: f.role, added: true, entry: { executor: actor }, enforcement }));
    assert.doesNotMatch(payload.description, /intercepted|Confirmed/);
    assert.match(payload.description, /Pending/);
});

test('permission and hierarchy failures remain pending and do not claim a restored role', async t => {
    t.mock.method(console, 'warn', () => {});
    for (const options of [{ permission: false }, { editable: false }]) {
        const f = fixture(options), enforcement = await f.manager.request(f.member);
        assert.equal(enforcement.status, 'failed'); assert.equal(f.calls.length, 0);
        assert.equal(f.corrections[0].success, false);
        const payload = json(roleEvents.buildWwRolePayload(f.member, { role: f.role, added: false, entry: { executor: actor }, enforcement }));
        assert.doesNotMatch(payload.description, /intercepted the change|Confirmed/);
        assert.match(payload.description, /Manage Roles/);
    }
});

test('unsuccessful Discord role verification is logged as a failure', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture(); f.member.roles.add = async () => f.member;
    assert.equal((await f.manager.request(f.member)).status, 'failed');
    assert.equal(f.corrections[0].success, false);
});

test('tag equip/removal events win over a stale in-flight user lookup', async () => {
    const f = fixture({ tag: true, hasRole: false });
    let resolve;
    f.client.rest.get = () => new Promise(done => { resolve = done; });
    const first = f.manager.request(f.member);
    while (!resolve) await Promise.resolve();
    const latest = f.manager.request(f.member, { user: rawTag(false), trustEvent: true, previousTag: true, source: 'tag_update' });
    resolve(rawTag(true));
    assert.equal((await first).status, 'stale'); await latest;
    assert.equal(f.calls.length, 0); assert.deepEqual(f.notifications, [false]);
});

test('repeated live tag updates welcome once and automatic role edits do not repeat the welcome', async () => {
    const f = fixture({ tag: false });
    await f.manager.request(f.member, { user: rawTag(true), trustEvent: true, previousTag: false, source: 'tag_update' });
    await f.manager.request(f.member, { user: rawTag(true), trustEvent: true, previousTag: false, source: 'tag_update' });
    await f.manager.request(f.member);
    assert.deepEqual(f.notifications, [true]); assert.equal(f.calls.length, 1);
    await f.manager.request(f.member, { user: rawTag(false), trustEvent: true, previousTag: true, source: 'tag_update' });
    assert.deepEqual(f.notifications, [true, false]); assert.equal(f.member.roles.cache.has(ROLE), false);
});

test('startup repairs roles silently and periodic checks catch missed tag changes', async () => {
    const f = fixture();
    await f.manager.sweep({ startup: true });
    assert.deepEqual(f.notifications, []); assert.equal(f.member.roles.cache.has(ROLE), true);
    f.setTag(rawTag(false)); f.advance(600000); await f.manager.sweep();
    assert.deepEqual(f.notifications, [false]); assert.equal(f.member.roles.cache.has(ROLE), false);
});

test('periodic verification reuses only a recent check, while manual edits still fetch fresh metadata', async () => {
    const f = fixture({ tag: true, hasRole: true });
    const get = f.client.rest.get;
    let reads = 0;
    f.client.rest.get = async (...args) => { reads++; return get(...args); };
    await f.manager.request(f.member);
    await f.manager.request(f.member, { source: 'periodic' });
    assert.equal(reads, 1);
    f.setTag(rawTag(false));
    await f.manager.request(f.member);
    assert.equal(reads, 2);
    assert.equal(f.member.roles.cache.has(ROLE), false);
    f.setTag(rawTag(true)); f.advance(30000);
    await f.manager.request(f.member, { source: 'periodic' });
    assert.equal(reads, 3);
    assert.equal(f.member.roles.cache.has(ROLE), true);
});

test('overlapping tag sweeps share one run and clear the activity marker after a failure', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture();
    const { RuntimeActivity } = require('../utils/runtimeActivity.js');
    f.manager.activity = new RuntimeActivity();
    let reject;
    f.guild.members.list = () => new Promise((_, fail) => { reject = fail; });
    const run = f.manager.sweep();
    while (!reject) await Promise.resolve();
    await f.manager.sweep();
    assert.equal(f.manager.activity.snapshot().active.length, 1);
    reject(new Error('Discord unavailable')); await run;
    assert.equal(f.manager.sweeping, false);
    assert.equal(f.manager.activity.snapshot().active.length, 0);
});

test('shutdown and departed members invalidate an in-flight role lookup', async () => {
    for (const stop of ['stop', 'forget']) {
        const f = fixture(); let resolve;
        f.client.rest.get = () => new Promise(done => { resolve = done; });
        const pending = f.manager.request(f.member);
        while (!resolve) await Promise.resolve();
        if (stop === 'stop') f.manager.stop(); else f.manager.forget(f.member);
        resolve(rawTag(true)); await pending;
        assert.equal(f.calls.length, 0);
    }
});

test('a departure from another guild cannot invalidate WW tag verification', async () => {
    const f = fixture(); let resolve;
    f.client.rest.get = () => new Promise(done => { resolve = done; });
    const pending = f.manager.request(f.member);
    while (!resolve) await Promise.resolve();
    f.manager.forget({ ...f.member, guild: { id: 'another-guild' } });
    resolve(rawTag(true));
    assert.equal((await pending).status, 'corrected');
    assert.equal(f.calls.length, 1);
});

test('failed role corrections keep inline code separate from the user-detail subtext style', () => {
    const f = fixture();
    const payload = json(roleEvents.buildWwCorrectionPayload(f.member, {
        added: true, role: f.role, source: 'periodic', reason: policyReason(true), success: false, error: 'Missing permissions'
    }, f.client.user));
    assert.match(payload.description, /Failed — `Missing permissions`/);
    assert.doesNotMatch(payload.description, /— -#/);
});

test('notification failure cannot turn a confirmed role correction into a failed correction', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture({ onCorrection: async () => { throw new Error('Log channel unavailable'); } });
    assert.equal((await f.manager.request(f.member)).status, 'corrected');
    assert.equal(f.member.roles.cache.has(ROLE), true);
});

test('the registered WW-Bot listeners enforce tags and send exactly one public member ping', async () => {
    const f = fixture({ tag: false });
    const sent = [], welcomes = [];
    for (const [id, sink] of [['log', sent], ['welcome', welcomes]]) f.guild.channels.cache.set(id, { isTextBased: () => true, send: async payload => sink.push(payload) });
    f.client.isReady = () => false;
    const config = { client: f.client, guildId: GUILD, wwRoleID: ROLE, logChannelID: 'log', welcomeChannelID: 'welcome', shutdownSignal: f.controller.signal, ownerID: actor.id };
    roleEvents.register(f.client, config);
    const manager = config.serverTagRoleManager;
    try {
        const before = { ...f.user, primaryGuild: null };
        const after = { ...f.user, primaryGuild: { identityEnabled: true, identityGuildId: GUILD } };
        await f.client.listeners(Events.UserUpdate)[0](before, after);
        // The registered listener deliberately does not block Discord's event emitter.
        while (!manager.pending.size && !welcomes.length) await Promise.resolve();
        await Promise.all([...manager.pending.values()]);
        assert.equal(f.member.roles.cache.has(ROLE), true);
        assert.equal(welcomes.length, 1); assert.equal(welcomes[0].content, `<@${USER}>`);
        assert.deepEqual(welcomes[0].allowedMentions, { parse: [], users: [USER] });
        assert.match(json(sent[0]).author.name, /Tag Equipped/);
    } finally { f.controller.abort(); }
});

test('self-panel provenance requires the correct channel, actor, target, and WW-Bot executor', () => {
    const f = fixture();
    const interaction = { user: { id: USER }, channelId: PANEL };
    const entry = { executor: f.client.user, reason: rolePanelReason(interaction, 'Role selection dropdown') };
    assert.equal(roleSource(entry, f.member, BOT).kind, 'self_panel');
    assert.equal(roleSource({ ...entry, reason: rolePanelReason({ ...interaction, channelId: '123456789012345678' }, 'Other panel') }, f.member, BOT).kind, 'other_panel');
    assert.equal(roleSource({ ...entry, executor: { ...f.client.user, id: 'other-bot' } }, f.member, BOT).kind, 'bot');
    assert.equal(roleSource(entry, { id: 'other-user' }, BOT).kind, 'bot');
    assert.equal(roleSource({ executor: f.client.user, reason: 'XP level reward: reached level 10' }, f.member, BOT).kind, 'automatic');
    assert.equal(roleSource({ executor: f.client.user, reason: 'Command /level: XP track' }, f.member, BOT).kind, 'command');
});

test('role formatting keeps IDs beside mentions, uses nested lists for batches, and marks both directions', () => {
    const f = fixture(), extra = { id: '623456789012345678', name: 'PvP Team' };
    const payload = json(roleEvents.buildRoleAuditPayload(f.member, { addedRoles: [f.role, extra], removedRoles: [{ id: '323456789012345678', name: 'Guild Member' }], entry: { executor: actor } }));
    assert.match(payload.description, /- \*\*\+\*\* \*\*Roles Added:\*\*\n  - <@&1483676323301036072> \(`1483676323301036072`\)/);
    assert.match(payload.description, /- \*\*-\*\* \*\*Role Removed:\*\*/);
    assert.doesNotMatch(payload.description, /Role ID:|`White Walker`|User Details|Reason:/);
    assert.equal(payload.color, 0x5865F2);
});

test('self role-panel changes show member intent and executing bot, while commands retain their source', () => {
    const f = fixture(), entry = { executor: f.client.user, reason: rolePanelReason({ user: f.user, channelId: PANEL }, 'Role selection button') };
    for (const added of [true, false]) {
        const payload = json(roleEvents.buildRoleAuditPayload(f.member, { addedRoles: added ? [f.role] : [], removedRoles: added ? [] : [f.role], entry, source: roleSource(entry, f.member, BOT) }));
        assert.match(payload.description, added ? /self-assigned roles using the role selection panel/ : /self-removed roles using the role selection panel/);
        assert.match(payload.description, /Roles Updated By:\*\* <@223456789012345678>/);
        assert.doesNotMatch(payload.description, /- \*\*[+-]\*\*/);
    }
    const command = { executor: f.client.user, reason: 'Command /level: XP track confirmation' };
    const payload = json(roleEvents.buildRoleAuditPayload(f.member, { addedRoles: [f.role], entry: command, source: roleSource(command, f.member, BOT) }));
    assert.match(payload.description, /Action Source:\*\* Command \/level/); assert.doesNotMatch(payload.description, /self-assigned/);
});

test('single-direction role events omit direction markers for one role and batches', () => {
    const f = fixture(), extra = { id: '623456789012345678', name: 'PvP Team' };
    for (const added of [true, false]) for (const roles of [[f.role], [f.role, extra]]) {
        const payload = json(roleEvents.buildRoleAuditPayload(f.member, {
            addedRoles: added ? roles : [], removedRoles: added ? [] : roles, entry: { executor: actor }
        }));
        assert.doesNotMatch(payload.description, /- \*\*[+-]\*\*/);
        assert.match(payload.description, added ? /\*\*Roles? Added:\*\*/ : /\*\*Roles? Removed:\*\*/);
        assert.ok(payload.description.includes(`<@${USER}>`));
        assert.ok(payload.description.includes(`<@${actor.id}>`));
    }
});

test('timeout layouts always have a user ID footer, timing under reason, and no member count', () => {
    const f = fixture();
    for (const authorName of ['Member Timeout ⏱️', 'Member Timeout Updated ⏱️', 'Member Timeout Expired ⌛', 'Member Timeout Removed ⏱️❌']) {
        const payload = json(buildMemberAuditPayload({ member: f.member, authorName,
            actionText: `had a timeout action by <@${actor.id}>`, reason: 'Example reason',
            timingLines: ['- **Timeout Ended:** <t:1792018800:F> (<t:1792018800:R>)'] }));
        assert.equal(payload.footer.text, `User ID: ${USER}`);
        assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
        assert.doesNotMatch(payload.description, /Discord Member Count|White Walkers/);
        assert.match(payload.description, /Reason:\*\* Example reason\n- \*\*Timeout Ended:/);
        assert.equal(payload.fields.length, 3);
        assert.ok(payload.fields.every(field => field.inline));
    }
});

test('48-hour new-account warning shows exact age and respects the boundary on joins and rejoins', () => {
    const f = fixture(), joinedAt = Date.now();
    f.user.createdTimestamp = joinedAt - 753000;
    for (const rejoined of [true, false]) {
        const payload = json(buildMemberJoinPayload(f.member, { rejoined, joinedAt, kind: rejoined ? 'left' : 'new' }));
        assert.deepEqual(payload.fields.at(-1), { name: '⚠️ **NEW ACCOUNT** ⚠️', value: 'New account created 12 minutes and 33 seconds ago!', inline: false });
        assert.doesNotMatch(payload.description, /NEW ACCOUNT/);
        assert.ok(payload.description.endsWith('- **Discord Member Count:** `184`'));
        assert.doesNotMatch(payload.description, /User Details/);
        assert.ok(payload.fields.slice(0, 5).every(field => field.inline));
    }
    f.user.createdTimestamp = joinedAt - 48 * 3600000;
    assert.ok(!json(buildMemberJoinPayload(f.member, { joinedAt, kind: 'new' })).fields.some(field => field.name.includes('NEW ACCOUNT')));
});

test('join safety facts appear only when supplied and never label an account safe or malicious', () => {
    const f = fixture();
    f.member.pending = true; f.user.bot = true;
    f.member.flags = new GuildMemberFlagsBitField(GuildMemberFlags.AutomodQuarantinedUsernameOrGuildNickname);
    f.user.flags = new UserFlagsBitField(UserFlags.Spammer + UserFlags.Quarantined);
    const payload = json(buildMemberJoinPayload(f.member, { joinedAt: Date.now(), kind: 'new' }));
    const warnings = payload.fields.slice(5);
    assert.ok(warnings.every(field => !field.inline && field.name.startsWith('⚠️ **')));
    const text = warnings.map(field => `${field.name}: ${field.value}`).join('\n');
    assert.match(text, /Bot account/); assert.match(text, /Membership Screening/);
    assert.match(text, /blocked by AutoMod/); assert.match(text, /spammer flag/); assert.match(text, /quarantine flag/);
    assert.doesNotMatch(text, /malicious|blacklisted|safe account/i);
    assert.doesNotMatch(payload.description, /Bot account|Membership Screening|spammer flag|blocked by AutoMod/);
});

test('all shared member embeds use the shortened labels and affected member avatar', () => {
    const f = fixture(), payload = json(buildMemberAuditPayload({ member: f.member, authorName: 'Member Left 👋', actionText: 'left.', memberCount: 184 }));
    assert.deepEqual(payload.fields.map(field => field.name), ['Username', 'Global Display Name', 'WW Server Nickname']);
    assert.ok(payload.fields.every(field => field.inline));
    assert.equal(payload.fields[0].value, '-# kaasfondue');
    assert.ok(payload.description.startsWith(`**<@${USER}> left.**`));
    assert.ok(payload.description.endsWith('- **Discord Member Count:** `184`'));
    assert.doesNotMatch(payload.description, /User Details/);
    assert.equal(payload.author.icon_url, f.user.displayAvatarURL()); assert.equal(payload.footer.text, `User ID: ${USER}`);
});

test('real member-role handlers intercept invalid edits and suppress duplicate WW-Bot correction events', async () => {
    for (const tag of [true, false]) {
        const f = fixture({ tag, hasRole: !tag }), sent = [];
        f.guild.channels.cache.set('log', { isTextBased: () => true, send: async payload => sent.push(payload) });
        const entry = { id: `change-${tag}`, targetId: USER, executor: actor, reason: null, createdTimestamp: Date.now(),
            changes: [{ key: tag ? '$remove' : '$add', new: [{ id: ROLE }] }] };
        f.guild.fetchAuditLogs = async () => ({ entries: new Collection([[entry.id, entry]]) });
        const config = { client: f.client, guildId: GUILD, logChannelID: 'log', wwRoleID: ROLE, serverTagRoleManager: f.manager };
        const prior = { ...f.member, roles: { cache: new Collection(tag ? [[ROLE, f.role]] : []) } };
        await roleEvents.handleRoleUpdate(prior, f.member, config);
        assert.equal(f.member.roles.cache.has(ROLE), tag); assert.equal(sent.length, 1);
        assert.match(json(sent[0]).author.name, /Intercepted/); assert.match(json(sent[0]).description, /<@123456789012345678> tried to/);
        const beforeCorrection = { ...f.member, roles: { cache: new Collection(tag ? [] : [[ROLE, f.role]]) } };
        await roleEvents.handleRoleUpdate(beforeCorrection, f.member, config);
        assert.equal(sent.length, 1); assert.equal(f.calls.length, 1);
    }
});

test('policy enforcement still works when the staff log channel is not configured', async () => {
    const f = fixture({ tag: false, hasRole: true });
    const before = { ...f.member, roles: { cache: new Collection() } };
    await roleEvents.handleRoleUpdate(before, f.member, { client: f.client, guildId: GUILD, wwRoleID: ROLE, serverTagRoleManager: f.manager });
    assert.equal(f.member.roles.cache.has(ROLE), false);
});
