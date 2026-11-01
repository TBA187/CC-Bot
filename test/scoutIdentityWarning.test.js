// Cover member and friendly-player warnings, mentions and IGN fallbacks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');
const { buildScoutEmbed } = require('../commands/scout.js');

const ID = '482354850110373898';
function member({ nickname = null, globalName = null, username = 'account', current = false, id = ID } = {}) {
    return { id, nickname, user: { id, username, globalName }, roles: { cache: new Set(current ? ['role'] : []) } };
}
function fixture({ live = [], saved = [], friends = [], fetched = null } = {}) {
    let queries = 0, fetches = 0;
    const store = new ScoutRosterStore({ guildMemberRoleID: 'role', db: { async query(sql) {
        queries++; return [sql.includes('FROM pvp_scout_friendly_list') ? friends : saved];
    } } }); store.schemaReady = true;
    const guild = { id: 'guild', members: { cache: new Map(live.map(item => [item.id, item])), async fetch(options) {
        fetches++; assert.equal(options.force, true); return fetched;
    } } };
    return { store, guild, counts: () => ({ queries, fetches }) };
}
function report(ign, identity) {
    return buildScoutEmbed({ message_id: '1350059044102078494', opponent_ign: ign, created_at: new Date(),
        author_username: 'Reporter', team_text: '- Clefable: Moonblast' }, [], 0, 5, null, identity).embed.toJSON();
}

for (const [label, profile] of [
    ['server nickname', { nickname: 'Ragequit027', globalName: 'Different' }],
    ['global display name', { globalName: 'Ragequit027', username: 'bogendorpher3779' }],
    ['username', { username: 'Ragequit027' }]
]) test(`current role holder is identified and mentioned by matching ${label}`, async () => {
    const f = fixture({ live: [member({ ...profile, current: true })] });
    const notice = await f.store.noticeForIgn('guild', 'Ragequit027', f.guild);
    assert.deepEqual(notice, { type: 'member', status: 'current', mention: `<@${ID}>` });
    assert.deepEqual(f.counts(), { queries: 0, fetches: 0 });
    const embed = report('Ragequit027', notice);
    assert.match(embed.description, /⚠️ \*\*<@482354850110373898>\*\* is a current\/former Crow Control member/u);
    assert.doesNotMatch(embed.description, /bogendorpher3779|Different/u);
    assert.equal(embed.footer.text, 'Report ID: 1350059044102078494 • Scout 1 of 5');
});

test('a real server nickname takes precedence over a matching global name or username', async () => {
    const f = fixture({ live: [member({ nickname: 'OtherIGN', globalName: 'Ragequit027', username: 'Ragequit027', current: true })] });
    assert.equal(await f.store.noticeForIgn('guild', 'Ragequit027', f.guild), null);
});

test('former member with stale stored nickname uses a fresh server nickname for mentions', async () => {
    const f = fixture({ saved: [{ discord_id: ID, server_nickname: 'Ragequit027', username: 'account', status: 'former' }],
        live: [member({ nickname: 'Old' })], fetched: member({ nickname: 'Ragequit027' }) });
    const notice = await f.store.noticeForIgn('guild', 'Ragequit027', f.guild);
    assert.equal(notice.mention, `<@${ID}>`); assert.equal(notice.status, 'former'); assert.equal(f.counts().fetches, 1);
});

test('former member who left the server keeps the warning with plain IGN', async () => {
    const f = fixture({ saved: [{ discord_id: ID, server_nickname: 'Ragequit027', status: 'former' }] });
    const notice = await f.store.noticeForIgn('guild', 'Ragequit027', f.guild);
    assert.equal(notice.mention, null);
    assert.match(report('Ragequit027', notice).description, /⚠️ \*\*Ragequit027\*\*/u);
});

test('former member still in the server is matched by the live nickname while profile storage catches up', async () => {
    const f = fixture({ saved: [{ discord_id: ID, server_nickname: 'OldIGN', status: 'former' }],
        live: [member({ nickname: 'NewIGN' })] });
    assert.deepEqual(await f.store.noticeForIgn('guild', 'NewIGN', f.guild),
        { type: 'member', status: 'former', mention: `<@${ID}>` });
});

test('friendly player warnings use the same mention fallbacks and preserve their wording', async () => {
    for (const profile of [{ nickname: 'FriendlyIGN' }, { globalName: 'FriendlyIGN' }, { username: 'FriendlyIGN' }]) {
        const f = fixture({ friends: [{ ign: 'FriendlyIGN', discord_id: ID }], live: [member(profile)] });
        const notice = await f.store.noticeForIgn('guild', 'FriendlyIGN', f.guild);
        assert.deepEqual(notice, { type: 'friend', mention: `<@${ID}>` });
        assert.match(report('FriendlyIGN', notice).description, /is a friend of Crow Control\. Please accept or send a \*\*draw request\*\* using the `\/draw` command/u);
    }
});

test('a linked friendly account whose names do not match falls back to the actual scout IGN', async () => {
    const f = fixture({ friends: [{ ign: 'FriendlyIGN', discord_id: ID }],
        live: [member({ nickname: 'DifferentIGN', globalName: 'FriendlyIGN' })], fetched: member({ nickname: 'DifferentIGN' }) });
    const notice = await f.store.noticeForIgn('guild', 'FriendlyIGN', f.guild);
    assert.equal(notice.mention, null);
    const embed = report('FriendlyIGN', notice);
    assert.match(embed.description, /⚠️ \*\*FriendlyIGN\*\*/u); assert.doesNotMatch(embed.description, /DifferentIGN/u);
});

test('plain friendly entry can mention a unique matching server member', async () => {
    const f = fixture({ friends: [{ ign: 'FriendlyIGN' }], live: [member({ nickname: 'FriendlyIGN' })] });
    assert.equal((await f.store.noticeForIgn('guild', 'FriendlyIGN', f.guild)).mention, `<@${ID}>`);
});

test('duplicate matching identities and nickname aliases never cause an arbitrary mention', async () => {
    const duplicates = fixture({ live: [member({ nickname: 'Ragequit027', current: true }), member({ nickname: 'Ragequit027', current: true, id: '123456789012345678' })] });
    assert.equal((await duplicates.store.noticeForIgn('guild', 'Ragequit027', duplicates.guild)).mention, null);
    const decorated = fixture({ live: [member({ nickname: 'Ragequit027 / OtherName', current: true })] });
    assert.equal((await decorated.store.noticeForIgn('guild', 'Ragequit027', decorated.guild)).mention, null);
});
