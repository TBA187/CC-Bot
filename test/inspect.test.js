'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const Inspect = require('../commands/inspect.js');

function fixture() {
    const calls = [];
    const user = { id: '123456789012345678', username: 'player', globalName: 'Player', bot: false,
        createdTimestamp: Date.UTC(2020, 0, 1), primaryGuild: { identityGuildId: 'guild', identityEnabled: true } };
    const member = { id: user.id, user, nickname: 'Trainer', joinedTimestamp: Date.UTC(2025, 0, 1),
        premiumSinceTimestamp: Date.UTC(2026, 0, 1), pending: false, communicationDisabledUntilTimestamp: Date.UTC(2027, 0, 1),
        permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
        roles: { cache: new Collection([['guild', { id: 'guild', position: 0 }], ['role', { id: 'role', position: 1 }]]) },
        voice: { channelId: 'voice', mute: true, deaf: false, streaming: true, selfVideo: false } };
    const guild = { id: 'guild', ownerId: 'owner', members: { cache: new Collection(), fetch: async options => {
        calls.push(['fetch', options]); return member;
    } } };
    member.guild = guild;
    const interaction = { guild, user: { id: 'staff' }, member: { roles: ['officer'] },
        options: { getMember: () => member },
        reply: async payload => calls.push(['reply', payload]), deferReply: async payload => calls.push(['defer', payload]),
        editReply: async payload => calls.push(['edit', payload]) };
    const command = new Inspect({ guildId: guild.id, officerRoleID: 'officer' });
    return { user, member, guild, interaction, command, calls };
}

const fields = payload => Object.fromEntries(payload.embeds[0].toJSON().fields.map(field => [field.name, field.value]));

test('inspect registers a server-only command and defers before refreshing the member', async () => {
    const f = fixture();
    const definition = f.command.data.toJSON();
    assert.equal(definition.name, 'inspect');
    assert.equal(definition.dm_permission, false);
    await f.command.execute(f.interaction);
    assert.deepEqual(f.calls.map(([name]) => name), ['defer', 'fetch', 'edit']);
    assert.equal(f.calls[0][1].flags, MessageFlags.Ephemeral);
    assert.deepEqual(f.calls[1][1], { user: f.user.id, force: true });
    assert.deepEqual(f.calls[2][1].allowedMentions, { parse: [] });
    assert.equal(Object.hasOwn(fields(f.calls[2][1]), 'Scouting Records'), false);
});

test('inspection reports current dates, roles, permissions, boosts, timeouts and voice state', () => {
    const f = fixture();
    const payload = Inspect.buildInspectPayload(f.member, Date.UTC(2026, 10, 1));
    const values = fields(payload);
    assert.match(values['Account Created'], /<t:1577836800:F>/u);
    assert.match(values['Joined Server'], /<t:1735689600:F>/u);
    assert.match(values['Server Tag: Yes'], /<t:1767225600:d> \(<t:1767225600:R>\)/u);
    assert.match(values['Timeout'], /<t:1798761600:d>/u);
    assert.equal(values['Server Roles (1)'], '<@&role>');
    assert.equal(values['Key Server Permissions'], 'Manage Roles');
    assert.match(values['Voice Activity'], /^<#voice>\n/u);
    assert.match(values['Voice Activity'], /\*\*Muted:\*\* Yes · \*\*Deafened:\*\* No/u);
    assert.match(values['Voice Activity'], /\*\*Streaming:\*\* Yes · \*\*Camera:\*\* No/u);
});

test('inactive states and unavailable tag data are shown without inventing information', () => {
    const f = fixture();
    f.member.voice = { channelId: null };
    f.member.premiumSinceTimestamp = null;
    f.member.communicationDisabledUntilTimestamp = Date.UTC(2020, 0, 1);
    delete f.user.primaryGuild;
    const values = fields(Inspect.buildInspectPayload(f.member));
    assert.equal(values['Voice Activity'], 'Not connected');
    assert.equal(values['Server Tag: Unavailable'], '**Server Boost:** Not boosting');
    assert.equal(values['Timeout'], 'None');
});

test('long role lists fit Discord field limits and retain an omitted-role count', () => {
    const f = fixture();
    f.member.roles.cache = new Collection(Array.from({ length: 250 }, (_, i) => [String(100000000000000000n + BigInt(i)),
        { id: String(100000000000000000n + BigInt(i)), position: i }]));
    const payload = Inspect.buildInspectPayload(f.member);
    const values = fields(payload);
    assert.ok(values['Server Roles (250)'].length <= 1024);
    assert.match(values['Server Roles (250)'], /\+ \d+ more$/u);
    assert.ok(payload.embeds[0].toJSON().fields.every(field => field.value.length <= 1024));
});

test('non-staff and requests outside the configured guild cannot fetch member details', async () => {
    for (const setup of [f => { f.interaction.member.roles = ['member']; }, f => { f.interaction.guild = null; },
        f => { f.command.guildId = 'other'; }]) {
        const f = fixture();
        setup(f);
        await f.command.execute(f.interaction);
        assert.deepEqual(f.calls.map(([name]) => name), ['reply']);
        assert.equal(f.calls[0][1].flags, MessageFlags.Ephemeral);
    }
});

test('an expired acknowledgement prevents member fetches', async () => {
    const f = fixture();
    f.interaction.deferReply = async () => { throw Object.assign(new Error('Expired'), { code: 10062 }); };
    await assert.rejects(f.command.execute(f.interaction), { code: 10062 });
    assert.equal(f.calls.length, 0);
});

