'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType } = require('discord.js');
const Giveaways = require('../commands/giveaways');
const { resolveRequiredRoleIds, resolveGiveawayPings } = require('../events/giveaways');

const guildId = '1148499020038295582';
const roles = Array.from({ length: 97 }, (_, index) => ({
    id: String(1000000000000000000n + BigInt(index)), name: `Role ${index}`, position: 97 - index
}));
const guild = { id: guildId, roles: { cache: new Collection(roles.map(role => [role.id, role])) } };
const userId = '291142291073269761';
let fixtureNumber = 0;

function fixture() {
    let record;
    const published = [], refreshed = [], replies = [];
    const message = { id: `mention-message-${++fixtureNumber}`, channelId: 'channel',
        url: 'https://discord.com/channels/1/2/3', async edit(payload) { refreshed.push(payload); return message; } };
    const channel = { type: ChannelType.GuildText, send() {}, messages: { async fetch() { return message; } } };
    const client = { channels: { cache: { get: () => channel } } };
    const store = {
        async createGiveaway(value) { record = structuredClone(value); return record; },
        async updateGiveaway(_id, updates) { record = { ...record, ...structuredClone(updates) }; return record; },
        async getGiveaway() { return structuredClone(record); },
        async listEntries() { return []; }
    };
    const command = new Giveaways({ giveawayStore: store, officerRoleID: roles[0].id });
    const interaction = (values = {}) => ({
        client, guild, guildId, channelId: 'channel', channel,
        user: { id: userId, username: 'Host', toString: () => `<@${userId}>` },
        member: { roles: { cache: new Collection([[roles[0].id, roles[0]]]) } },
        deferred: false, replied: false,
        options: {
            getString(name) { assert.notEqual(name, 'name'); return values[name] ?? null; },
            getInteger: name => values[name] ?? null,
            getAttachment: () => null,
            getBoolean: name => values[name] ?? null
        },
        async deferReply() { this.deferred = true; },
        async reply(payload) { replies.push(payload); },
        async editReply(payload) { published.push(payload); },
        async fetchReply() { return message; },
        async followUp(payload) { replies.push(payload); }
    });
    return { command, store, interaction, published, refreshed, replies,
        get record() { return record; } };
}

test('create and edit expose title and manual mention fields while giveaway search keeps autocomplete', () => {
    const command = new Giveaways({ giveawayStore: {} });
    for (const name of ['create', 'edit']) {
        const options = command.data.toJSON().options.find(option => option.name === name).options;
        assert.ok(options.some(option => option.name === 'title'));
        assert.ok(!options.some(option => option.name === 'name'));
        for (const optionName of ['ping_roles', 'required_role']) {
            const option = options.find(option => option.name === optionName);
            assert.ok(!option.autocomplete);
            assert.equal(option.max_length, 1000);
        }
    }
    assert.equal(command.data.toJSON().options.find(option => option.name === 'edit').options[0].autocomplete, true);
});

test('manual pings accept many roles throughout the guild and both member mention formats without duplicates', () => {
    const selected = [roles[0], roles[35], roles[70], roles[96]];
    const input = [...selected.map(role => `<@&${role.id}>`), `<@${userId}>`, `<@!${userId}>`, `<@&${roles[96].id}>`].join(', ');
    assert.ok(input.length > 100);
    assert.deepEqual(resolveGiveawayPings(guild, input), { roleIds: selected.map(role => role.id), userIds: [userId] });
    assert.deepEqual(resolveGiveawayPings(guild, `<@${userId}>, <@!${userId}>`), { roleIds: [], userIds: [userId] });
    assert.deepEqual(resolveGiveawayPings(guild, ''), { roleIds: [], userIds: [] });
    assert.deepEqual(resolveGiveawayPings(guild, 'Role 96, Role 35'), { roleIds: [roles[96].id, roles[35].id], userIds: [] });
});

test('role and member mentions accept whitespace, punctuation or no separator without dropping recipients', () => {
    const selected = [roles[0], roles[35], roles[96]];
    const roleMentions = selected.map(role => `<@&${role.id}>`);
    const roleIds = selected.map(role => role.id);
    for (const separator of [' ', '  ', '\t', '\n', ', ', '; ', '|', '']) {
        assert.deepEqual(resolveRequiredRoleIds(guild, roleMentions.join(separator)), roleIds);
        assert.deepEqual(resolveGiveawayPings(guild, roleMentions.join(separator)), { roleIds, userIds: [] });
        const mixed = [roleMentions[0], `<@${userId}>`, roleMentions[1], `<@!${userId}>`, roleMentions[2]].join(separator);
        assert.deepEqual(resolveGiveawayPings(guild, mixed), { roleIds, userIds: [userId] });
        assert.throws(() => resolveRequiredRoleIds(guild, mixed), /Only roles/u);
    }
});

test('required roles stay role-only and ping inputs reject malformed or unintended mentions', () => {
    assert.deepEqual(resolveRequiredRoleIds(guild, `<@&${roles[70].id}>, <@&${roles[96].id}>`), [roles[70].id, roles[96].id]);
    assert.throws(() => resolveRequiredRoleIds(guild, `<@${userId}>`), /Only roles/u);
    for (const input of ['@everyone', '@here', '<#123456789012345678>', '<@bad>', '<@99999999999999999999>', 'Missing Role']) {
        assert.throws(() => resolveGiveawayPings(guild, input));
    }
    assert.throws(() => resolveGiveawayPings(null, `<@${userId}>`), /inside a server/u);
    const shortNames = { id: guildId, roles: { cache: new Collection(roles.map((role, index) => [role.id, { ...role, name: `R${index}` }])) } };
    assert.throws(() => resolveGiveawayPings(shortNames, roles.map((_, index) => `R${index}`).join(',')), /Too many/u);
    assert.throws(() => resolveRequiredRoleIds(shortNames, roles.slice(0, 50).map((_, index) => `R${index}`).join(',')), /Too many required/u);
});

test('title and explicit role/member pings are saved and rendered on create, then updated without repinging', async () => {
    const f = fixture();
    await f.command.create(f.interaction({ duration: '24h', winners: 1, prize: 'Coin Capsule', title: ' Capsule giveaway ',
        ping_roles: `<@&${roles[96].id}> <@${userId}>`, required_role: `<@&${roles[70].id}>` }));
    assert.equal(f.record.name, 'Capsule giveaway');
    assert.deepEqual(f.record.ping_role_ids, [roles[96].id]);
    assert.deepEqual(f.record.ping_user_ids, [userId]);
    assert.deepEqual(f.record.required_role_ids, [roles[70].id]);
    assert.equal(f.published[0].embeds[0].toJSON().title, 'Capsule giveaway');
    assert.ok(f.published[0].content.includes(`<@&${roles[96].id}> <@${userId}>`));
    assert.deepEqual(f.published[0].allowedMentions, { parse: [], roles: [roles[96].id], users: [userId] });

    const otherUser = '291142291073269762';
    await f.command.edit(f.interaction({ giveaway: f.record.giveaway_id, title: ' Updated capsule giveaway ',
        ping_roles: `<@!${otherUser}>`, required_role: `<@&${roles[35].id}> <@&${roles[96].id}>` }));
    assert.equal(f.record.name, 'Updated capsule giveaway');
    assert.deepEqual(f.record.ping_role_ids, []);
    assert.deepEqual(f.record.ping_user_ids, [otherUser]);
    assert.deepEqual(f.record.required_role_ids, [roles[35].id, roles[96].id]);
    assert.equal(f.refreshed[0].embeds[0].toJSON().title, 'Updated capsule giveaway');
    assert.ok(f.refreshed[0].content.includes(`<@${otherUser}>`));
    assert.deepEqual(f.refreshed[0].allowedMentions, { parse: [] });
});

test('clearing pings removes both role and member recipients and blank edit fields preserve existing recipients', async () => {
    const f = fixture();
    await f.command.create(f.interaction({ duration: '24h', winners: 1, prize: 'Prize', ping_roles: `<@${userId}>` }));
    await f.store.updateGiveaway(f.record.giveaway_id, { message_id: null, ping_role_ids: [roles[96].id] });
    await f.command.edit(f.interaction({ giveaway: f.record.giveaway_id, title: 'New title' }));
    assert.deepEqual(f.record.ping_role_ids, [roles[96].id]);
    assert.deepEqual(f.record.ping_user_ids, [userId]);
    await f.command.edit(f.interaction({ giveaway: f.record.giveaway_id, remove_ping_roles: true }));
    assert.deepEqual(f.record.ping_role_ids, []);
    assert.deepEqual(f.record.ping_user_ids, []);
});

test('member mentions do not bypass Officer-only required roles', async () => {
    const f = fixture();
    const interaction = f.interaction({ duration: '24h', winners: 1, prize: 'Prize', required_role: `<@&${roles[96].id}>` });
    interaction.member.roles.cache.clear();
    await f.command.create(interaction);
    assert.equal(f.record, undefined);
    assert.match(f.replies[0].content, /Officer-only/u);
});

test('giveaway autocomplete still works and stale role autocomplete requests receive an empty response', async () => {
    const command = new Giveaways({ giveawayStore: { async listGiveaways() { return []; } } });
    for (const name of ['giveaway', 'ping_roles', 'required_role']) {
        let response;
        await command.handleAutocomplete({ commandName: 'giveaway',
            options: { getSubcommand: () => 'edit', getFocused: withMetadata => withMetadata ? { name, value: 'missing' } : 'missing' },
            async respond(choices) { response = choices; } });
        assert.deepEqual(response, []);
    }
});
