'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AuditLogEvent, Collection, GuildMemberFlags, GuildMemberFlagsBitField } = require('discord.js');
const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');
const joins = require('../events/memberJoinLogs.js');
const invites = require('../events/inviteLogs.js');
const roles = require('../events/roleDetector.js');
const exits = require('../events/memberExit.js');

const USER_ID = '296447098298171393';
const moderator = { id: '123456789012345678', username: 'Vangogsan', globalName: 'Am1damaru', bot: false };
const automation = { id: '223456789012345678', username: 'Crow Control', globalName: null, bot: true };
const regularRole = { id: '323456789012345678', name: 'Guild Member', managed: false };
const ccRole = { id: '423456789012345678', name: 'Crow Control', managed: false };
let fixtureNumber = 0;

function fixture() {
    const sent = [], welcomed = [];
    const channel = { isTextBased: () => true, send: async payload => { sent.push(payload); } };
    const welcome = { isTextBased: () => true, send: async payload => { welcomed.push(payload); } };
    const guild = { id: `audit-guild-${++fixtureNumber}`, memberCount: 184,
        channels: { cache: new Collection([['log', channel], ['welcome', welcome]]), fetch: async () => channel },
        roles: { cache: new Collection([[regularRole.id, regularRole], [ccRole.id, ccRole]]) },
        members: { cache: new Collection() }, fetchAuditLogs: async () => ({ entries: new Collection() }) };
    const user = { id: USER_ID, username: 'kaasfondue', globalName: 'Kaasfondue', createdTimestamp: Date.UTC(2017, 2, 29) };
    const member = { id: USER_ID, user, nickname: 'Kaasfondue', guild, joinedTimestamp: Date.now() - 60000,
        roles: { cache: new Collection() }, flags: new GuildMemberFlagsBitField() };
    guild.members.cache.set(member.id, member);
    const config = { guildId: guild.id, logChannelID: 'log', welcomeChannelID: 'welcome', ccRoleID: ccRole.id,
        ownerID: moderator.id, client: { guilds: { cache: new Collection([[guild.id, guild]]) } }, memberHistory: new MemberAuditHistory() };
    return { guild, user, member, config, sent, welcomed };
}

function auditEntry(targetId, executor, changes = [], extra = {}) {
    return { id: `audit-${fixtureNumber}-${Math.random()}`, targetId, executor, changes, reason: 'Test action', createdTimestamp: Date.now(), ...extra };
}

function embed(payload) { return payload.embeds[0].toJSON(); }

test('invite creators, stream hosts, and deleting moderators use real user mentions', () => {
    const invite = { code: 'WWtest', inviter: moderator, channelId: '523456789012345678',
        targetUser: { id: USER_ID, username: 'kaasfondue', globalName: 'Kaasfondue' }, maxAge: 0 };
    const created = embed(invites.buildInviteCreatedPayload(invite));
    assert.ok(created.description.includes(`<@${moderator.id}> created`));
    assert.ok(created.description.includes(`**Stream Host:** <@${USER_ID}>`));
    const deleted = embed(invites.buildInviteDeletedPayload(invite, { executor: moderator }));
    assert.ok(deleted.description.includes(`<@${moderator.id}> deleted`));
    assert.match(deleted.description, /Invite Code:\*\* `WWtest`/);
});

test('voluntary departure and rejoin classification persist across a bot restart', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-member-history-'));
    const filePath = path.join(directory, 'history.json');
    t.after(() => {
        fs.rmSync(filePath, { force: true });
        fs.rmSync(`${filePath}.tmp`, { force: true });
        fs.rmdirSync(directory);
    });
    const { member } = fixture();
    const initial = new MemberAuditHistory({ filePath });
    initial.seedMembers(new Collection([[member.id, member]]));
    initial.recordDeparture(member, 'left', Date.now());
    const restored = new MemberAuditHistory({ filePath });
    const context = restored.recordJoin({ ...member, joinedTimestamp: Date.now() + 1000 });
    assert.equal(context.rejoined, true);
    assert.equal(context.kind, 'left');
    const payload = embed(joins.buildMemberJoinPayload(member, context));
    assert.equal(payload.author.name, 'Member Rejoined 🔄');
    assert.match(payload.description, /Previous Departure:\*\* Left voluntarily/);
    assert.equal(payload.footer.text, `User ID: ${USER_ID}`);
    assert.match(payload.description, /Discord Member Count:\*\* `184`/);
});

test('unban rejoin is distinct, and an old unban does not label later voluntary rejoins', () => {
    const { member, config } = fixture();
    const history = config.memberHistory, at = Date.now();
    history.recordJoin(member, at - 1000);
    history.recordBan({ guild: member.guild, user: member.user }, at);
    history.recordUnban({ guild: member.guild, user: member.user }, at + 1000, moderator);
    const rejoined = { ...member, joinedTimestamp: at + 2000 };
    const context = history.recordJoin(rejoined, at + 2000);
    assert.equal(context.kind, 'unbanned');
    assert.equal(context.rejoined, true);
    assert.equal(embed(joins.buildMemberJoinPayload(rejoined, context)).author.name, 'Member Rejoined 🔓');
    assert.match(embed(joins.buildMemberJoinPayload(rejoined, context)).description, /Unbanned By:\*\* <@123456789012345678>/);
    const payload = embed(joins.buildMemberJoinPayload(rejoined, context));
    for (const field of payload.fields.slice(3, 5)) {
        assert.match(field.value.replace(/^-# /u, ''), /^<t:\d+:d> \(<t:\d+:R>\)$/);
        assert.equal(field.inline, true);
    }
    assert.match(payload.description, /Unbanned At:\*\* <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(payload.description, /Previously Left:\*\* <t:\d+:F> \(<t:\d+:R>\)/);
    assert.doesNotMatch(payload.description, /User Details/);
    history.recordDeparture(rejoined, 'left', at + 3000);
    assert.equal(history.recordJoin({ ...member, joinedTimestamp: at + 4000 }, at + 4000).kind, 'left');
});

test('first joins, preemptively banned users, and Discord rejoin flags are classified honestly', () => {
    const { member } = fixture(), history = new MemberAuditHistory(), at = Date.now();
    assert.equal(history.recordJoin(member).rejoined, false);
    const preemptive = new MemberAuditHistory();
    preemptive.recordBan({ guild: member.guild, user: member.user }, at);
    preemptive.recordUnban({ guild: member.guild, user: member.user }, at + 1000);
    const context = preemptive.recordJoin({ ...member, joinedTimestamp: at + 2000 });
    assert.equal(context.rejoined, false);
    assert.equal(context.kind, 'unbanned');
    const flagged = new MemberAuditHistory().recordJoin({ ...member, flags: new GuildMemberFlagsBitField(GuildMemberFlags.DidRejoin) });
    assert.equal(flagged.rejoined, true);
    assert.equal(flagged.kind, 'unknown');
});

test('a departure missed while offline does not reuse a reason from an older membership', () => {
    const { member } = fixture(), history = new MemberAuditHistory(), at = Date.now();
    history.recordJoin(member);
    history.recordDeparture(member, 'left', at);
    history.recordJoin({ ...member, joinedTimestamp: at + 1000 }, at + 1000);
    const returned = history.recordJoin({ ...member, joinedTimestamp: at + 5000 }, at + 5000);
    assert.equal(returned.rejoined, true);
    assert.equal(returned.kind, 'unknown');
    assert.equal(returned.departure, null);
});

test('a rapid rejoin waits for the preceding departure to be classified', async () => {
    const { member, config, sent } = fixture(), at = Date.now();
    const pending = config.memberHistory.beginDeparture(member, at);
    const joining = joins.handleMemberJoin({ ...member, joinedTimestamp: at + 1 }, config);
    await Promise.resolve();
    assert.equal(sent.length, 0);
    config.memberHistory.recordDeparture(member, 'left', at);
    config.memberHistory.finishDeparture(member, pending);
    await joining;
    assert.equal(sent.length, 1);
    assert.match(embed(sent[0]).description, /Left voluntarily/);
});

test('startup seeding cannot swallow a join already being processed', async () => {
    const { member, config, sent } = fixture();
    const pending = config.memberHistory.beginDeparture(member, Date.now());
    const returned = { ...member, joinedTimestamp: Date.now() + 1 };
    const joining = joins.handleMemberJoin(returned, config);
    config.memberHistory.seedMembers(new Collection([[returned.id, returned]]));
    config.memberHistory.recordDeparture(member, 'left', Date.now());
    config.memberHistory.finishDeparture(member, pending);
    await joining;
    assert.equal(sent.length, 1);
    assert.equal(embed(sent[0]).author.name, 'Member Rejoined 🔄');
});

test('ban then unban then rejoin does not hide a new voluntary departure', async () => {
    const { member, config, guild, sent } = fixture();
    exits.initializeTimeoutTracking(new EventEmitter(), config);
    const ban = { guild, user: member.user };
    const banAt = Date.now();
    const banAudit = auditEntry(member.id, moderator, [], { createdTimestamp: banAt });
    const unbanAudit = auditEntry(member.id, moderator);
    guild.fetchAuditLogs = async ({ type }) => ({ entries: new Collection(
        type === AuditLogEvent.MemberBanAdd ? [['ban', banAudit]] : type === AuditLogEvent.MemberBanRemove ? [['unban', unbanAudit]] : []) });
    await exits.handleGuildBanAdd(ban, 'log');
    await exits.handleGuildBanRemove(ban, 'log');
    const returned = { ...member, joinedTimestamp: Date.now() };
    config.memberHistory.recordJoin(returned);
    await exits.handleMemberRemove(returned, 'log');
    assert.deepEqual(sent.map(payload => embed(payload).author.name), ['Member Banned 🔨', 'Member Unbanned 🔓', 'Member Left 👋']);
    const unbanned = embed(sent[1]);
    assert.match(unbanned.description, /\*\*\n-# \*\*kaasfondue\*\* can now join the Discord Server again!\n- \*\*Reason:/);
    assert.ok(unbanned.description.indexOf('can now join') < unbanned.description.indexOf('**Reason:**'));
    assert.ok(unbanned.description.indexOf('can now join') < unbanned.description.indexOf('**Discord Member Count:**'));
    assert.doesNotMatch(unbanned.description, /User Details|can now join the Discord Server again\./);
});

test('invite deletion selects an audit by invite code even when target_id is null', async () => {
    const { guild, config, sent } = fixture();
    const wrong = auditEntry(null, automation, [{ key: 'code', old: 'otherCode' }]);
    const correct = auditEntry(null, moderator, [{ key: 'code', old: 'WWtest' }]);
    guild.fetchAuditLogs = async ({ type }) => {
        assert.equal(type, AuditLogEvent.InviteDelete);
        return { entries: new Collection([['wrong', wrong], ['correct', correct]]) };
    };
    await invites.handleInviteDelete({ guild, code: 'WWtest', channelId: '523456789012345678' }, config);
    assert.equal(sent.length, 1);
    assert.match(embed(sent[0]).description, /<@123456789012345678>.*deleted/);
    assert.equal(embed(sent[0]).footer.text, 'Invite Link ID: WWtest');
});

test('invite deletion still logs without audit permission and does not invent a moderator', async t => {
    const { guild, config, sent } = fixture();
    t.mock.method(console, 'warn', () => {});
    guild.fetchAuditLogs = async () => { throw new Error('Missing ViewAuditLog'); };
    await invites.handleInviteDelete({ guild, code: 'WWtest' }, config);
    assert.equal(sent.length, 1);
    assert.match(embed(sent[0]).description, /Deleted By:\*\* \*Unavailable/);
});

test('role removal matches the actual role and direction rather than a recent role addition', async () => {
    const { member, guild, config, sent } = fixture();
    const add = auditEntry(member.id, automation, [{ key: '$add', new: [regularRole] }]);
    const remove = auditEntry(member.id, moderator, [{ key: '$remove', new: [regularRole] }]);
    guild.fetchAuditLogs = async () => ({ entries: new Collection([['add', add], ['remove', remove]]) });
    await roles.handleRoleUpdate({ ...member, roles: { cache: new Collection([[regularRole.id, regularRole]]) } }, member, config);
    assert.equal(sent.length, 1);
    assert.equal(embed(sent[0]).author.name, 'Member Role Removed 🏷️➖');
    assert.match(embed(sent[0]).description, /removed by <@123456789012345678>/);
});

test('a batch role assignment produces one embed and a manual CC warning never claims an unobserved correction', async () => {
    const { member, guild, config, sent, welcomed } = fixture();
    const extraRole = { id: '623456789012345678', name: 'PvP Team' };
    guild.roles.cache.set(extraRole.id, extraRole);
    const entry = auditEntry(member.id, moderator, [{ key: '$add', new: [regularRole, extraRole, ccRole] }]);
    guild.fetchAuditLogs = async () => ({ entries: new Collection([['roles', entry]]) });
    await roles.handleRoleUpdate(member, { ...member, roles: { cache: new Collection([[regularRole.id, regularRole], [extraRole.id, extraRole], [ccRole.id, ccRole]]) } }, config);
    assert.equal(sent.length, 2);
    const warning = sent.map(embed).find(value => value.description.includes(`<@&${ccRole.id}>`));
    assert.match(warning.description, /CC Role Verification:\*\* Pending/);
    assert.doesNotMatch(warning.description, /Confirmed —/);
    assert.equal(welcomed.length, 0);
    assert.match(sent.map(embed).find(value => value.author.name === 'Member Roles Added 🏷️➕').description, new RegExp(`${regularRole.id}[\\s\\S]*${extraRole.id}`));
});

test('external bot role changes do not invent a confirmed policy correction', async () => {
    const { member, guild, config, sent, welcomed } = fixture();
    const removed = auditEntry(member.id, moderator, [{ key: '$remove', new: [ccRole] }], { createdTimestamp: Date.now() - 500 });
    const restored = auditEntry(member.id, automation, [{ key: '$add', new: [ccRole] }]);
    guild.fetchAuditLogs = async () => ({ entries: new Collection([['restored', restored], ['removed', removed]]) });
    await roles.handleRoleUpdate(member, { ...member, roles: { cache: new Collection([[ccRole.id, ccRole]]) } }, config);
    assert.equal(embed(sent[0]).author.name, 'Member Role Added 🏷️➕');
    assert.doesNotMatch(embed(sent[0]).description, /Correction Status/);
    assert.equal(welcomed.length, 0);
});

test('managed role additions survive missing audit access with an honest source label', async t => {
    const { member, guild, config, sent } = fixture();
    const managed = { id: '723456789012345678', name: 'Twitch Subscriber', managed: true };
    guild.roles.cache.set(managed.id, managed);
    t.mock.method(console, 'warn', () => {});
    guild.fetchAuditLogs = async () => { throw new Error('Missing ViewAuditLog'); };
    await roles.handleRoleUpdate(member, { ...member, roles: { cache: new Collection([[managed.id, managed]]) } }, config);
    assert.equal(sent.length, 1);
    assert.match(embed(sent[0]).description, /Integration-managed role/);
    assert.match(embed(sent[0]).description, /Unknown Moderator/);
});

test('large role batches are split below the Discord description limit', async () => {
    const { member, guild, config, sent } = fixture();
    const assigned = Array.from({ length: 21 }, (_, index) => ({ id: `${823456789012345678n + BigInt(index)}`, name: '*'.repeat(100) }));
    for (const role of assigned) guild.roles.cache.set(role.id, role);
    const entry = auditEntry(member.id, moderator, [{ key: '$add', new: assigned }], { reason: '*'.repeat(512) });
    guild.fetchAuditLogs = async () => ({ entries: new Collection([['batch', entry]]) });
    await roles.handleRoleUpdate(member, { ...member, roles: { cache: new Collection(assigned.map(role => [role.id, role])) } }, config);
    assert.equal(sent.length, 3);
    for (const payload of sent) assert.ok(embed(payload).description.length <= 4096);
});

test('real CC tag changes are passed to the policy manager once per transition', async () => {
    const { user, guild, config, sent, welcomed } = fixture();
    const changes = [];
    config.serverTagRoleManager = { request: async (member, options) => changes.push(options.user.primaryGuild.identityEnabled) };
    user.primaryGuild = { identityEnabled: false, identityGuildId: guild.id };
    const equipped = { ...user, primaryGuild: { identityEnabled: true, identityGuildId: guild.id } };
    await roles.handleCcTagUpdate(user, equipped, config);
    await roles.handleCcTagUpdate(equipped, equipped, config);
    await roles.handleCcTagUpdate(equipped, user, config);
    assert.deepEqual(changes, [true, false]);
    assert.equal(sent.length, 0);
    assert.equal(welcomed.length, 0);
});
