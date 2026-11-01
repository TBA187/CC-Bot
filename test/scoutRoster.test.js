// Cover member seeding, reconciliation and saved profile changes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');
const rosterEvent = require('../events/scoutRoster.js');
const { normalizeIgn } = require('../features/pvp-scouting/PvpScoutParser.js');

function member(id, nickname, current = false) {
    return { id, user: { id, username: `user-${id}` }, nickname,
        guild: { id: 'guild' }, roles: { cache: new Set(current ? ['member-role'] : []) } };
}

function saved(id, nickname, status = 'current') {
    return { discord_id: id, username: `user-${id}`, server_nickname: nickname,
        server_nickname_normalized: normalizeIgn(nickname), status, first_seen_at: 'historical' };
}

function fixture({ rows = [], friends = [], seeded = true, members = [] } = {}) {
    const state = { rows: new Map(rows.map(row => [row.discord_id, { ...row }])),
        friends: friends.map(row => ({ ...row })), seeded, writes: [], fetches: 0 };
    const db = { async query(sql, params) {
        const query = sql.trim().replace(/\s+/gu, ' ');
        if (query.startsWith('SELECT guild_id FROM pvp_scout_member_seed')) {
            return [state.seeded ? [{ guild_id: 'guild' }] : []];
        }
        if (query.startsWith('SELECT discord_id') && query.includes('FROM guild_members')) {
            return [[...state.rows.values()].map(row => ({ ...row }))];
        }
        if (query.startsWith('SELECT discord_id') && query.includes('FROM pvp_scout_friendly_list')) {
            return [state.friends.filter(row => row.discord_id).map(row => ({ ...row }))];
        }
        state.writes.push({ query, params });
        if (query.startsWith('INSERT INTO guild_members')) {
            const [, id, username, nickname, normalized, status] = params;
            state.rows.set(id, { ...state.rows.get(id), discord_id: id, username,
                server_nickname: nickname, server_nickname_normalized: normalized, status });
            if (query.includes('global_name')) state.rows.get(id).global_name = params.at(-1);
        } else if (query.startsWith('UPDATE guild_members')) {
            const [username, nickname, normalized] = params;
            const id = params.at(-1);
            const row = state.rows.get(id);
            if (row) Object.assign(row, { username, server_nickname: nickname,
                server_nickname_normalized: normalized });
            if (row && query.includes('global_name')) row.global_name = params[3];
        } else if (query.startsWith('UPDATE pvp_scout_friendly_list')) {
            const [username, nickname, normalized, , id] = params;
            for (const row of state.friends.filter(row => row.discord_id === id)) {
                Object.assign(row, { username, server_nickname: nickname,
                    server_nickname_normalized: normalized });
            }
        } else if (query.startsWith('INSERT IGNORE INTO pvp_scout_member_seed')) {
            state.seeded = true;
        } else {
            throw new Error(`Unexpected roster query: ${query}`);
        }
        return [{ affectedRows: 1 }];
    } };
    const store = new ScoutRosterStore({ db });
    store.schemaReady = true;
    const guild = { id: 'guild', members: { async list() {
        state.fetches++;
        return new Map(members.map(value => [value.id, value]));
    } } };
    return { state, store, guild };
}

test('startup catches offline role changes and profiles while retaining historical and manual entries', async () => {
    const manual = saved('manual', 'ManualAlias', 'former');
    const f = fixture({
        rows: [saved('unchanged', 'Same'), saved('role-lost', 'Lost'), saved('left', 'LastKnown'),
            saved('returned', 'Returned', 'former'), saved('former-profile', 'Old', 'former'),
            saved('profile', 'OldCurrent'), manual],
        friends: [{ ...saved('profile', 'OldCurrent'), ign: 'FriendlyIgn' },
            { ...saved('friend-only', 'OldFriend'), ign: 'SeparateIgn' },
            { ...manual, ign: 'ManualFriend' }, { discord_id: null, ign: 'UnlinkedFriend' }],
        members: [member('unchanged', 'Same', true), member('role-lost', 'Lost'),
            member('returned', 'Returned', true), member('former-profile', 'New'),
            member('profile', 'NewCurrent', true), member('new', 'NewMember', true),
            member('ordinary', 'Visitor'), member('friend-only', 'NewFriend')]
    });
    f.store.memberNamesCache = { stale: true };
    const { profileUpdates, ...counts } = await f.store.seedCurrentGuildMembers(f.guild, 'member-role');
    assert.deepEqual(counts,
        { added: 1, restored: 1, former: 2, updated: 3, alreadySeeded: true });
    assert.deepEqual(profileUpdates.map(update => update.discordId), ['former-profile', 'profile', 'friend-only']);
    assert.deepEqual(profileUpdates[1].changes, [
        { list: 'member list', fields: [
            { field: 'server nickname', before: 'OldCurrent', after: 'NewCurrent' },
            { field: 'nickname lookup key', before: 'oldcurrent', after: 'newcurrent' }
        ] },
        { list: 'friendly list', ign: 'FriendlyIgn', fields: [
            { field: 'server nickname', before: 'OldCurrent', after: 'NewCurrent' },
            { field: 'nickname lookup key', before: 'oldcurrent', after: 'newcurrent' }
        ] }
    ]);
    assert.equal(f.state.fetches, 1);
    assert.equal(f.state.rows.get('role-lost').status, 'former');
    assert.equal(f.state.rows.get('left').status, 'former');
    assert.equal(f.state.rows.get('left').server_nickname, 'LastKnown');
    assert.equal(f.state.rows.get('left').first_seen_at, 'historical');
    assert.equal(f.state.rows.get('returned').status, 'current');
    assert.equal(f.state.rows.get('former-profile').server_nickname, 'New');
    assert.equal(f.state.rows.get('former-profile').status, 'former');
    assert.equal(f.state.rows.get('profile').server_nickname, 'NewCurrent');
    assert.equal(f.state.rows.get('new').status, 'current');
    assert.deepEqual(f.state.rows.get('manual'), manual);
    assert.equal(f.state.rows.has('ordinary'), false);
    assert.equal(f.state.rows.has('friend-only'), false);
    assert.deepEqual(f.state.friends.map(row => row.ign),
        ['FriendlyIgn', 'SeparateIgn', 'ManualFriend', 'UnlinkedFriend']);
    assert.equal(f.state.friends[1].server_nickname, 'NewFriend');
    assert.equal(f.store.memberNamesCache, null);
    assert.equal(f.state.writes.some(write => /DELETE|member_seed/u.test(write.query)), false);
});

test('unchanged seeded startup still fetches members and performs no writes', async () => {
    const f = fixture({ rows: [saved('current', 'Same'), saved('former', 'History', 'former')],
        members: [member('current', 'Same', true)] });
    const cached = { unchanged: true };
    f.store.memberNamesCache = cached;
    assert.deepEqual(await f.store.seedCurrentGuildMembers(f.guild, 'member-role'),
        { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded: true, profileUpdates: [] });
    assert.equal(f.state.fetches, 1);
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.store.memberNamesCache, cached);
});

test('first initialization writes the seed once and later startups reconcile', async () => {
    const f = fixture({ seeded: false,
        members: [member('holder', 'Holder', true), member('visitor', 'Visitor')] });
    assert.deepEqual(await f.store.seedCurrentGuildMembers(f.guild, 'member-role'),
        { added: 1, restored: 0, former: 0, updated: 0, alreadySeeded: false, profileUpdates: [] });
    assert.equal(f.state.rows.size, 1);
    assert.equal(f.state.seeded, true);
    f.state.writes.length = 0;
    assert.deepEqual(await f.store.seedCurrentGuildMembers(f.guild, 'member-role'),
        { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded: true, profileUpdates: [] });
    assert.equal(f.state.fetches, 2);
    assert.deepEqual(f.state.writes, []);
});

test('failed full-member fetch propagates without changing membership and allows retry', async () => {
    const f = fixture({ rows: [saved('current', 'Same')], members: [member('current', 'Same', true)] });
    const originalList = f.guild.members.list;
    f.guild.members.list = async () => { throw new Error('Roster fetch failed'); };
    await assert.rejects(f.store.seedCurrentGuildMembers(f.guild, 'member-role'), /Roster fetch failed/u);
    assert.equal(f.state.rows.get('current').status, 'current');
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.store.seedPromises.size, 0);
    f.guild.members.list = originalList;
    assert.equal((await f.store.seedCurrentGuildMembers(f.guild, 'member-role')).former, 0);
});

for (const memberListed of [true, false]) {
    test(`a linked friend with a global name stays unchanged across startups (${memberListed ? 'also a member' : 'friend only'})`, async () => {
        const live = member('linked', 'Same', memberListed);
        live.user.globalName = 'Discord Display Name';
        const f = fixture({
            rows: memberListed ? [{ ...saved('linked', 'Same'), global_name: live.user.globalName }] : [],
            friends: [{ ...saved('linked', 'Same'), ign: 'ManualIgn' }], members: [live]
        });
        const cached = { unchanged: true };
        f.store.memberNamesCache = cached;
        for (let startup = 0; startup < 2; startup++) {
            assert.deepEqual(await f.store.seedCurrentGuildMembers(f.guild, 'member-role'),
                { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded: true, profileUpdates: [] });
        }
        assert.deepEqual(f.state.writes, []);
        assert.equal(f.state.friends[0].ign, 'ManualIgn');
        assert.equal(f.store.memberNamesCache, cached);
        assert.equal(f.store.friendlyIgnRevision, 0);
    });
}

test('actual global display-name changes are saved once and reported only for the member list', async () => {
    const live = member('linked', 'Same', true);
    live.user.globalName = 'New display name';
    const f = fixture({
        rows: [{ ...saved('linked', 'Same'), global_name: 'Old display name' }],
        friends: [{ ...saved('linked', 'Same'), ign: 'ManualIgn' }], members: [live]
    });
    const result = await f.store.seedCurrentGuildMembers(f.guild, 'member-role');
    assert.equal(result.updated, 1);
    assert.deepEqual(result.profileUpdates, [{ discordId: 'linked', username: 'user-linked', changes: [
        { list: 'member list', fields: [{ field: 'global display name', before: 'Old display name', after: 'New display name' }] }
    ] }]);
    assert.equal(f.state.rows.get('linked').global_name, 'New display name');
    assert.equal(f.state.friends[0].ign, 'ManualIgn');
    f.state.writes.length = 0;
    assert.equal((await f.store.seedCurrentGuildMembers(f.guild, 'member-role')).updated, 0);
    assert.deepEqual(f.state.writes, []);
});

test('stale linked friends are counted once per member and identify each affected IGN and field', async () => {
    const live = member('linked', 'Same', true);
    live.user.globalName = 'Display name';
    const f = fixture({
        rows: [{ ...saved('linked', 'Same'), global_name: live.user.globalName }],
        friends: [{ ...saved('linked', 'Same'), username: 'old-username', ign: 'FirstIgn' },
            { ...saved('linked', 'OldNick'), ign: 'SecondIgn' }], members: [live]
    });
    const result = await f.store.seedCurrentGuildMembers(f.guild, 'member-role');
    assert.equal(result.updated, 1);
    assert.deepEqual(result.profileUpdates, [{ discordId: 'linked', username: 'user-linked', changes: [
        { list: 'friendly list', ign: 'FirstIgn', fields: [{ field: 'username', before: 'old-username', after: 'user-linked' }] },
        { list: 'friendly list', ign: 'SecondIgn', fields: [
            { field: 'server nickname', before: 'OldNick', after: 'Same' },
            { field: 'nickname lookup key', before: 'oldnick', after: 'same' }
        ] }
    ] }]);
    assert.deepEqual(f.state.friends.map(row => row.ign), ['FirstIgn', 'SecondIgn']);
    f.state.writes.length = 0;
    assert.equal((await f.store.seedCurrentGuildMembers(f.guild, 'member-role')).updated, 0);
    assert.deepEqual(f.state.writes, []);
});

test('removed nickname and display name are saved and recorded as null', async () => {
    const f = fixture({
        rows: [{ ...saved('linked', 'OldNick'), global_name: 'Old display name' }],
        members: [member('linked', null, true)]
    });
    const result = await f.store.seedCurrentGuildMembers(f.guild, 'member-role');
    assert.equal(result.updated, 1);
    assert.deepEqual(result.profileUpdates[0].changes[0].fields, [
        { field: 'server nickname', before: 'OldNick', after: null },
        { field: 'nickname lookup key', before: 'oldnick', after: null },
        { field: 'global display name', before: 'Old display name', after: null }
    ]);
    assert.equal(f.state.rows.get('linked').server_nickname, null);
    assert.equal(f.state.rows.get('linked').global_name, null);
    assert.equal(f.state.rows.get('linked').status, 'current');
});

for (const [label, profile, expected] of [
    ['server nickname', { server_nickname: 'ReporterIGN', global_name: 'OtherGlobal', username: 'OtherAccount' }, 'reporterign'],
    ['global display name', { server_nickname: null, global_name: 'Ragequit027', username: 'bogendorpher3779' }, 'ragequit027'],
    ['username', { server_nickname: null, global_name: null, username: 'ReporterIGN' }, 'reporterign']
]) test(`OCR author context uses ${label} with the same identity priority as scout warnings`, async () => {
    const f = fixture({ rows: [{ ...saved('reporter', null), ...profile }] });
    assert.deepEqual(await f.store.ocrMemberContext('guild', 'reporter'), {
        memberNames: [expected], authorNames: [expected]
    });
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.state.fetches, 0);
});

test('OCR identity context retains former members and separates the reporting author', async () => {
    const f = fixture({ rows: [saved('reporter', 'ReporterIGN'), saved('former', 'FormerIGN', 'former')] });
    assert.deepEqual(await f.store.ocrMemberContext('guild', 'reporter'), {
        memberNames: ['reporterign', 'formerign'], authorNames: ['reporterign']
    });
    assert.deepEqual(await f.store.ocrMemberContext('guild', 'former'), {
        memberNames: ['reporterign', 'formerign'], authorNames: ['formerign']
    });
});

test('startup logs meaningful reconciliation changes and stays quiet when unchanged', async () => {
    const handlers = new Map();
    let result = { added: 0, restored: 0, former: 0, updated: 0, alreadySeeded: true };
    const guild = { id: 'guild' };
    const client = { guilds: { cache: new Map([['guild', guild]]) },
        once(event, callback) { handlers.set('ready', callback); }, on() {} };
    rosterEvent.register(client, { guildId: 'guild', guildMemberRoleID: 'member-role',
        scoutRosterStore: { async seedCurrentGuildMembers(actualGuild, role) {
            assert.equal(actualGuild, guild);
            assert.equal(role, 'member-role');
            return result;
        } } });
    const logs = [];
    const originalLog = console.log;
    console.log = value => logs.push(value);
    try {
        await handlers.get('ready')();
        assert.deepEqual(logs, []);
        result = { added: 1, restored: 2, former: 3, updated: 4, alreadySeeded: true };
        await handlers.get('ready')();
        assert.deepEqual(logs, ['[CC LOG] Scout startup: reconciled MySQL member/friendly lists from Discord (guild guild); 1 added, 2 restored, 3 marked former, 4 saved profile(s) refreshed. Local data files are not used for this check.']);
    } finally {
        console.log = originalLog;
    }
});

test('startup logs the MySQL source, member ID and saved old/new values, then stays quiet on the next startup', async t => {
    const live = member('linked', 'Same', true);
    live.user.globalName = 'New display name\nwith a newline';
    const f = fixture({ rows: [{ ...saved('linked', 'Same'), global_name: 'Old display name' }],
        friends: [{ ...saved('linked', 'Same'), username: 'old-user', ign: 'ManualIgn' }], members: [live] });
    const handlers = new Map();
    const client = { guilds: { cache: new Map([['guild', f.guild]]) },
        once(event, callback) { handlers.set('ready', callback); }, on() {} };
    rosterEvent.register(client, { guildId: 'guild', guildMemberRoleID: 'member-role', scoutRosterStore: f.store });
    const logs = [];
    t.mock.method(console, 'log', value => logs.push(value));
    await handlers.get('ready')();
    assert.deepEqual(logs, [
        '[CC LOG] Scout startup: reconciled MySQL member/friendly lists from Discord (guild guild); 1 saved profile(s) refreshed. Local data files are not used for this check.',
        '[CC LOG] Scout profile saved to MySQL for "user-linked" (Discord ID linked): member list: global display name "Old display name" -> "New display name\\nwith a newline"; friendly list (IGN "ManualIgn"): username "old-user" -> "user-linked".'
    ]);
    logs.length = 0;
    await handlers.get('ready')();
    assert.deepEqual(logs, []);
});
