// Cover coordinated server preferences, role changes and failure recovery.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { ScoutServerSettings, canUseGuildSettings } = require('../features/pvp-scouting/ScoutServerSettings.js');

function fixture({ selected = null, roleIds = ['member', 'unrelated'], failAdd = false, failCommit = false,
    committedDespiteError = false, failRead = false } = {}) {
    const config = { guildId: 'guild', guildMemberRoleID: 'member', officerRoleID: 'officer',
        adminRoleID: 'admin', leaderRoleID: 'leader', goldRoleID: 'gold-role', silverRoleID: 'silver-role' };
    const roles = new Set(roleIds), calls = [];
    let saved = selected;
    const user = { id: 'user', username: 'Account' };
    const member = { id: 'user', user, nickname: 'IGN', roles: { cache: roles,
        async add(id) { calls.push(['add', id]); if (failAdd && id === 'silver-role') throw new Error('Add failed'); roles.add(id); return member; },
        async remove(id) { calls.push(['remove', id]); roles.delete(id); return member; }
    } };
    const bot = { permissions: { has: flag => flag === PermissionFlagsBits.ManageRoles },
        roles: { highest: { comparePositionTo: () => 1 } } };
    const guild = { id: 'guild', members: { me: bot, async fetch() { return member; } },
        roles: { async fetch(id) { return { id, managed: false }; } } };
    const store = {
        async setSelectedServer(_guild, _member, server, { toggle, beforeCommit }) {
            calls.push(['write', server]);
            const previous = saved, next = toggle && server === previous ? null : server;
            await beforeCommit({ previous, selected: next });
            calls.push(['commit', next]);
            if (failCommit) {
                if (committedDespiteError) saved = next;
                throw new Error('Commit response lost');
            }
            saved = next;
            return { previous, selected: next };
        },
        async getSelectedServer() { calls.push(['read', saved]); if (failRead) throw new Error('Read failed'); return saved; }
    };
    const interaction = { guild, guildId: 'guild', user, member, inGuild: () => true };
    const service = new ScoutServerSettings({ config, store });
    return { service, config, store, interaction, bot, roles, calls, selected: () => saved };
}

test('first-time setup is idempotent and only adds the selected role', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.select(f.interaction, 'gold'), { previous: null, selected: 'gold' });
    assert.deepEqual(await f.service.select(f.interaction, 'gold'), { previous: 'gold', selected: 'gold' });
    assert.deepEqual([...f.roles], ['member', 'unrelated', 'gold-role']);
    assert.equal(f.calls.filter(([action]) => action === 'add').length, 1);
});

test('switching removes the previous role before assigning the next and preserves unrelated roles', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'unrelated', 'gold-role'] });
    await f.service.select(f.interaction, 'silver', { toggle: true });
    assert.deepEqual(f.calls, [['write', 'silver'], ['remove', 'gold-role'], ['add', 'silver-role'], ['commit', 'silver']]);
    assert.deepEqual([...f.roles], ['member', 'unrelated', 'silver-role']);
    assert.equal(f.selected(), 'silver');
});

test('clearing a preference removes both server roles, including an accidentally duplicated role', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'unrelated', 'gold-role', 'silver-role'] });
    const result = await f.service.select(f.interaction, 'gold', { toggle: true });
    assert.equal(result.selected, null);
    assert.deepEqual([...f.roles], ['member', 'unrelated']);
});

test('separate service instances serialize selection for the same guild member', async () => {
    const f = fixture(), second = new ScoutServerSettings({ config: f.config, store: f.store });
    const write = f.store.setSelectedServer;
    f.store.setSelectedServer = async (...args) => {
        await new Promise(resolve => setImmediate(resolve));
        return write(...args);
    };
    await Promise.all([f.service.select(f.interaction, 'gold'), second.select(f.interaction, 'silver')]);
    assert.equal(f.selected(), 'silver');
    assert.deepEqual([...f.roles], ['member', 'unrelated', 'silver-role']);
    assert.deepEqual(f.calls.filter(([action]) => action === 'commit'), [['commit', 'gold'], ['commit', 'silver']]);
});

test('a failed Discord role assignment restores the saved preference roles and reports failure', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role', 'unrelated'], failAdd: true });
    await assert.rejects(f.service.select(f.interaction, 'silver'), /Add failed/u);
    assert.equal(f.selected(), 'gold');
    assert.deepEqual([...f.roles].sort(), ['member', 'gold-role', 'unrelated'].sort());
    assert.equal(f.calls.some(([action]) => action === 'commit'), false);
});

test('a failed database commit restores the preference roles without reporting success', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role'], failCommit: true });
    await assert.rejects(f.service.select(f.interaction, 'silver'), /Commit response lost/u);
    assert.equal(f.selected(), 'gold');
    assert.deepEqual([...f.roles].sort(), ['member', 'gold-role'].sort());
});

test('an uncertain commit is reconciled to the actual stored preference', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role'], failCommit: true, committedDespiteError: true });
    await assert.rejects(f.service.select(f.interaction, 'silver'), /Commit response lost/u);
    assert.equal(f.selected(), 'silver');
    assert.deepEqual([...f.roles], ['member', 'silver-role']);
});

test('an unavailable database after failure restores the previous preference role and logs the uncertainty', async t => {
    const warnings = [];
    t.mock.method(console, 'error', (...args) => warnings.push(args));
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role'], failCommit: true, failRead: true });
    await assert.rejects(f.service.select(f.interaction, 'silver'), /Commit response lost/u);
    assert.deepEqual([...f.roles].sort(), ['member', 'gold-role'].sort());
    assert.equal(warnings.length, 2);
});

test('failure recovery never restores both server roles even when both were originally present', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role', 'silver-role'], failRead: true });
    const remove = f.interaction.member.roles.remove;
    let failed = false;
    f.interaction.member.roles.remove = async id => {
        const member = await remove.call(f.interaction.member.roles, id);
        if (!failed) { failed = true; throw new Error('Lost Discord remove response'); }
        return member;
    };
    await assert.rejects(f.service.select(f.interaction, 'gold'), /Lost Discord remove response/u);
    assert.deepEqual([...f.roles].sort(), ['member', 'gold-role'].sort());
    assert.equal(f.selected(), 'gold');
});

test('role permissions and hierarchy are validated before storage or role mutations', async () => {
    for (const change of [f => { f.bot.permissions.has = () => false; },
        f => { f.bot.roles.highest.comparePositionTo = () => 0; },
        f => { f.config.goldRoleID = ''; }, f => { f.interaction.guild.roles.fetch = async () => null; }]) {
        const f = fixture(); change(f);
        await assert.rejects(f.service.select(f.interaction, 'gold'));
        assert.deepEqual(f.calls, []);
        assert.equal(f.selected(), null);
    }
});

test('a permission revoked since the settings panel opened prevents selection', async () => {
    const f = fixture();
    f.interaction.member = { roles: ['member'] };
    f.roles.delete('member');
    await assert.rejects(f.service.select(f.interaction, 'gold'), error => {
        assert.equal(error.code, 'SCOUT_SERVER_FORBIDDEN');
        assert.equal(error.permissionReason, 'missing_guild_role');
        assert.equal(error.permissionStage, 'current member roles');
        assert.equal(error.checkedRoleIds.includes('member'), false);
        return true;
    });
    assert.deepEqual(f.calls, []);
});

test('server selection checks current membership when interaction roles are stale', async () => {
    for (const server of ['gold', 'silver', 'cross']) {
        const f = fixture();
        f.interaction.member = { roles: [] };
        assert.equal(f.service.canUse(f.interaction), false);
        await f.service.select(f.interaction, server, { toggle: true });
        assert.equal(f.selected(), server);
    }
});

test('nonmembers cannot save any server preference or change roles', async () => {
    for (const server of ['gold', 'silver', 'cross']) {
        const f = fixture({ roleIds: ['unrelated'] });
        await assert.rejects(f.service.select(f.interaction, server), { code: 'SCOUT_SERVER_FORBIDDEN' });
        assert.equal(f.selected(), null);
        assert.deepEqual(f.calls, []);
        assert.deepEqual([...f.roles], ['unrelated']);
    }
});

test('other guilds and DMs are rejected before fetching Discord roles', async () => {
    for (const change of [f => { f.interaction.guildId = 'other'; }, f => { f.interaction.inGuild = () => false; }]) {
        const f = fixture();
        change(f);
        f.interaction.guild.members.fetch = () => assert.fail('No request should be made outside the configured guild');
        await assert.rejects(f.service.select(f.interaction, 'gold'), { code: 'SCOUT_SERVER_FORBIDDEN' });
        assert.deepEqual(f.calls, []);
    }
});

test('shared permissions reject DMs and other guilds even for Discord administrators', () => {
    const f = fixture();
    f.interaction.memberPermissions = { has: () => true };
    assert.equal(canUseGuildSettings(f.interaction, f.config), true);
    f.interaction.guildId = 'other';
    assert.equal(canUseGuildSettings(f.interaction, f.config), false);
    f.interaction.guildId = 'guild'; f.interaction.inGuild = () => false;
    assert.equal(canUseGuildSettings(f.interaction, f.config), false);
});

test('Cross Server assigns both roles and switches or clears without touching unrelated roles', async () => {
    const f = fixture();
    for (const server of ['cross', 'gold', 'cross', 'silver', 'cross']) {
        await f.service.select(f.interaction, server);
        const expected = server === 'cross' ? ['gold-role', 'silver-role'] : [`${server}-role`];
        assert.deepEqual([...f.roles].sort(), ['member', 'unrelated', ...expected].sort());
        assert.equal(f.selected(), server);
    }
    await f.service.select(f.interaction, 'cross', { toggle: true });
    assert.equal(f.selected(), null);
    assert.deepEqual([...f.roles].sort(), ['member', 'unrelated']);
});

test('partial Cross Server assignment failure rolls back both preference and roles', async () => {
    const f = fixture({ failAdd: true });
    await assert.rejects(f.service.select(f.interaction, 'cross'), /Add failed/u);
    assert.equal(f.selected(), null);
    assert.deepEqual([...f.roles].sort(), ['member', 'unrelated']);
    assert.ok(f.calls.some(([action, id]) => action === 'add' && id === 'gold-role'));
});

test('a lost Cross Server commit response reconciles both roles to the saved preference', async () => {
    const f = fixture({ selected: 'gold', roleIds: ['member', 'gold-role', 'unrelated'], failCommit: true, committedDespiteError: true });
    await assert.rejects(f.service.select(f.interaction, 'cross'), /Commit response lost/u);
    assert.equal(f.selected(), 'cross');
    assert.deepEqual([...f.roles].sort(), ['member', 'gold-role', 'silver-role', 'unrelated'].sort());
});

test('simultaneous Cross Server and single-server selections remain serialized', async () => {
    const f = fixture(), second = new ScoutServerSettings({ config: f.config, store: f.store });
    await Promise.all([f.service.select(f.interaction, 'cross'), second.select(f.interaction, 'silver')]);
    assert.equal(f.selected(), 'silver');
    assert.deepEqual([...f.roles].sort(), ['member', 'silver-role', 'unrelated'].sort());
});
