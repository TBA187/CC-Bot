// Check private guild settings, server toggles and the existing notifications menu.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ButtonStyle, MessageFlags, PermissionFlagsBits } = require('discord.js');
const CcSettings = require('../commands/cc-settings.js');
const Notifications = require('../commands/notifications.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');

function fixture() {
    const selected = new Map();
    const commandMap = new Map();
    const config = { guildId: 'guild', guildMemberRoleID: 'member', officerRoleID: 'officer',
        adminRoleID: 'admin', leaderRoleID: 'leader', goldRoleID: 'gold-role', silverRoleID: 'silver-role', commandMap,
        guildMemberStore: {
            async getSelectedServer(_guild, userId) { return selected.get(userId) || null; },
            async setSelectedServer(_guild, member, server, { toggle, beforeCommit }) {
                const previous = selected.get(member.user.id) || null;
                const next = toggle && previous === server ? null : server;
                await beforeCommit({ previous, selected: next });
                selected.set(member.user.id, next);
                return { previous, selected: next };
            }
        } };
    return { command: new CcSettings(config), config, selected, commandMap };
}

function interaction(action = '') {
    const calls = [];
    const user = { id: 'user', username: 'AccountName', globalName: 'GlobalName',
        displayAvatarURL: () => 'https://example.com/avatar.png' };
    const member = { id: user.id, nickname: 'ServerName', user,
        roles: { cache: new Set(['member']), async add(id) { calls.push(['addRole', id]); this.cache.add(id); return member; },
            async remove(id) { calls.push(['removeRole', id]); this.cache.delete(id); return member; } } };
    const guild = { id: 'guild', members: { async fetch() { return member; }, me: {
        permissions: { has: flag => flag === PermissionFlagsBits.ManageRoles },
        roles: { highest: { comparePositionTo: () => 1 } }
    } }, roles: { async fetch(id) { return { id, managed: false }; } } };
    return { calls, user, member,
        guildId: 'guild', guild, inGuild: () => true,
        customId: action ? `cc-settings:${action}:user` : '', id: `interaction-${action}`,
        message: { id: 'panel' },
        async reply(payload) { calls.push(['reply', payload]); },
        async deferReply(payload) { calls.push(['deferReply', payload]); },
        async deferUpdate() { calls.push(['deferUpdate']); },
        async editReply(payload) { calls.push(['editReply', payload]); },
        async followUp(payload) { calls.push(['followUp', payload]); }
    };
}

test('guild settings registers the command and shows branded private controls in the requested order', async () => {
    const f = fixture(), i = interaction();
    await f.command.execute(i);
    assert.equal(f.command.data.toJSON().name, 'cc-settings');
    assert.deepEqual(i.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    const payload = i.calls[1][1], embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'Crow Control Guild Settings - ServerName');
    assert.equal(embed.thumbnail.url, 'https://example.com/avatar.png');
    assert.equal(embed.footer.text, 'Crow Control Guild Settings');
    assert.equal(embed.footer.icon_url, 'attachment://cc_logo.webp');
    assert.ok(embed.timestamp);
    assert.equal(payload.files[0].name, 'cc_logo.webp');
    assert.match(embed.description, /Silver:\*\* Press this button to select the \*\*Silver Server\*\*/u);
    assert.match(embed.description, /Selected Server: \*`None`\*/u);
    const buttons = payload.components[0].toJSON().components;
    assert.deepEqual(buttons.map(b => b.label), ['Gold', 'Silver', 'Cross Server', 'Notifications']);
    assert.deepEqual(buttons.map(b => b.style), [ButtonStyle.Secondary, ButtonStyle.Secondary, ButtonStyle.Secondary, ButtonStyle.Primary]);
    assert.deepEqual(buttons.map(b => b.emoji.name), ['gold', 'silver', '🔗', '🔔']);
    assert.deepEqual(buttons.slice(0, 2).map(b => b.emoji.id), ['1555743525759356948', '1555743603567886478']);
    assert.equal(new Set(buttons.map(b => b.custom_id)).size, 4);
});

test('title uses server nickname, global display name, then username', () => {
    const i = interaction();
    for (const [nickname, globalName, expected] of [
        ['Nickname', 'Global', 'Nickname'], [null, 'Global', 'Global'], [null, null, 'AccountName']
    ]) {
        i.member.nickname = nickname; i.user.globalName = globalName;
        assert.equal(CcSettings.settingsPayload(i, null).embeds[0].toJSON().title, `Crow Control Guild Settings - ${expected}`);
    }
});

test('members, officers, admins, leaders and Discord administrators can use settings', () => {
    const f = fixture(), i = interaction();
    for (const role of ['member', 'officer', 'admin', 'leader']) {
        i.member.roles = [role]; assert.equal(f.command.canUse(i), true);
        i.member.roles = { cache: new Set([role]) }; assert.equal(f.command.canUse(i), true);
    }
    i.member.roles = [];
    i.memberPermissions = { has: flag => flag === PermissionFlagsBits.Administrator };
    assert.equal(f.command.canUse(i), true);
});

test('outsiders, other guilds, DMs and another panel owner receive only No permission', async () => {
    for (const change of [i => { i.member.roles = []; }, i => { i.guildId = 'other'; },
        i => { i.inGuild = () => false; }]) {
        const f = fixture(), i = interaction(); change(i);
        await f.command.execute(i);
        assert.deepEqual(i.calls, [['reply', { content: 'No permission!', flags: MessageFlags.Ephemeral }]]);
    }
    const f = fixture(), i = interaction('gold'); i.user.id = 'someone-else';
    await f.command.handleButton(i);
    assert.deepEqual(i.calls, [['reply', { content: 'No permission!', flags: MessageFlags.Ephemeral }]]);
    assert.equal(f.selected.size, 0);
});

test('selecting, switching and removing servers updates the panel and gives private feedback', async () => {
    const f = fixture();
    for (const [action, expected, feedback] of [
        ['gold', 'gold', `### ${SERVERS.gold.markup} Gold Server selected ✅`],
        ['silver', 'silver', `### Server changed from **Gold** to ${SERVERS.silver.markup} **Silver**`],
        ['silver', null, `### ${SERVERS.silver.markup} Silver Server was removed ❌`],
        ['gold', 'gold', `### ${SERVERS.gold.markup} Gold Server selected ✅`],
        ['gold', null, `### ${SERVERS.gold.markup} Gold Server was removed ❌`]
    ]) {
        const i = interaction(action);
        assert.equal(await f.command.handleButton(i), true);
        assert.equal(i.calls[0][0], 'deferUpdate');
        assert.equal(f.selected.get('user'), expected);
        const response = i.calls.find(call => call[0] === 'followUp')[1];
        assert.ok(response.content.startsWith(feedback));
        assert.equal(response.flags, MessageFlags.Ephemeral);
        if (!expected) assert.match(response.content, /don't have any \*\*Servers\*\* saved/u);
    }
});

test('reopening settings reads the persistent server preference after acknowledgement', async () => {
    const f = fixture(), i = interaction();
    f.selected.set('user', 'silver');
    const read = f.config.guildMemberStore.getSelectedServer;
    f.config.guildMemberStore.getSelectedServer = async (...args) => {
        assert.equal(i.calls[0][0], 'deferReply'); return read(...args);
    };
    await f.command.execute(i);
    assert.match(i.calls[1][1].embeds[0].toJSON().description, /Selected Server: <:silver:1555743603567886478> Silver/u);
});

test('a previously posted settings button still saves a server and refreshes to new controls', async () => {
    const f = fixture(), i = interaction('gold');
    i.customId = 'ww-settings:gold:user';
    assert.equal(await f.command.handleButton(i), true);
    assert.equal(f.selected.get('user'), 'gold');
    const payload = i.calls.find(call => call[0] === 'editReply')[1];
    assert.ok(payload.components[0].toJSON().components.every(button => button.custom_id.startsWith('cc-settings:')));
});

test('Notifications opens the existing command privately below settings, without editing settings or server', async () => {
    const f = fixture(), i = interaction('notifications');
    const store = { listNotificationStates: () => [], getUserSubscriptionKeys: () => [] };
    const notifications = new Notifications({ notificationStore: store });
    f.commandMap.set('notifications', notifications);
    await f.command.handleButton(i);
    assert.equal(i.calls.length, 1);
    assert.equal(i.calls[0][0], 'reply');
    assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
    assert.match(i.calls[0][1].embeds[0].toJSON().title, /Guild Notification Pings/u);
    assert.equal(f.selected.size, 0);
});

test('failed storage gives private feedback and never claims that a selection was saved', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture();
    f.config.guildMemberStore.getSelectedServer = f.config.guildMemberStore.setSelectedServer = async () => { throw new Error('DB down'); };
    const open = interaction(); await f.command.execute(open);
    assert.match(open.calls[1][1].content, /Could not load/u);
    const click = interaction('gold'); await f.command.handleButton(click);
    assert.deepEqual(click.calls.map(call => call[0]), ['deferUpdate', 'followUp']);
    assert.equal(click.calls[1][1].flags, MessageFlags.Ephemeral);
    assert.match(click.calls[1][1].content, /Could not save/u);
});

test('two clicks on the same panel are acknowledged promptly and saved in order', async () => {
    const f = fixture(), calls = [];
    const toggle = f.config.guildMemberStore.setSelectedServer;
    f.config.guildMemberStore.setSelectedServer = async (...args) => {
        calls.push(args[2]); await new Promise(resolve => setImmediate(resolve)); return toggle(...args);
    };
    const gold = interaction('gold'), silver = interaction('silver');
    await Promise.all([f.command.handleButton(gold), f.command.handleButton(silver)]);
    assert.deepEqual(calls, ['gold', 'silver']);
    assert.equal(gold.calls[0][0], 'deferUpdate'); assert.equal(silver.calls[0][0], 'deferUpdate');
    assert.equal(f.selected.get('user'), 'silver');
    assert.match(silver.calls.find(call => call[0] === 'editReply')[1].embeds[0].toJSON().description, /Selected Server: <:silver:1555743603567886478> Silver/u);
});
