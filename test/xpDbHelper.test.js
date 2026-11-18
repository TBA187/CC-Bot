// Covers XP track lookups and their stored role and channel settings.
const assert = require('node:assert/strict');
const test = require('node:test');
const { Collection } = require('discord.js');
const { fetchTrackById, fetchXpTrackAutocompleteChoices } = require('../utils/xpDbHelper.js');

const ROLE = '1180559377636274259';
const CHANNEL = '1469101041189523657';
const ARRAY_FIELDS = ['role_ids', 'channel_ids', 'level_rewards'];

function trackRow(overrides = {}) {
    return {
        id: 7, name: 'PvP XP', role_ids: [ROLE], channel_ids: [CHANNEL],
        level_rewards: [1, 3], cooldown_overrides: { message: 30, reaction: 15, command: 5, voiceMinTime: 120 },
        send_level_up_msg: 1, tag_user_level_up_msg: 1, color: '#5865F2', created_at: '2026-01-01 00:00:00',
        ...overrides
    };
}

function dbFor(row) {
    return { query: async () => [[row]] };
}

function assertMappedTrack(track) {
    assert.deepEqual(track.roleIds, [ROLE]);
    assert.deepEqual(track.channelIds, [CHANNEL]);
    assert.deepEqual(track.levelRewards, [1, 3]);
    assert.deepEqual(track.cooldownOverrides, { message: 30, reaction: 15, command: 5, voiceMinTime: 120 });
    assert.equal(track.id, 7);
    assert.equal(track.sendLevelUpMsg, true);
    assert.equal(track.tagUserLevelUpMsg, true);
}

test('XP track mapping preserves JSON arrays and objects already decoded by mysql2', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const row = trackRow();
    Object.freeze(row.role_ids);
    Object.freeze(row.channel_ids);
    Object.freeze(row.level_rewards);
    Object.freeze(row.cooldown_overrides);
    assertMappedTrack(await fetchTrackById(dbFor(row), 7));
    assert.equal(errors.length, 0);
});

test('XP track mapping preserves JSON text and Buffer results from older schemas', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    for (const asBuffer of [false, true]) {
        const row = trackRow();
        for (const field of [...ARRAY_FIELDS, 'cooldown_overrides']) {
            const json = JSON.stringify(row[field]);
            row[field] = asBuffer ? Buffer.from(json) : json;
        }
        assertMappedTrack(await fetchTrackById(dbFor(row), 7));
    }
    assert.equal(errors.length, 0);
});

test('XP track mapping supports a mixture of native JSON and JSON text in one row', async () => {
    const row = trackRow({ role_ids: JSON.stringify([ROLE]), level_rewards: Buffer.from('[1,3]') });
    assertMappedTrack(await fetchTrackById(dbFor(row), 7));
});

test('missing XP track JSON fields keep empty-list and null defaults', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    for (const value of [null, undefined, '', 'null']) {
        const row = trackRow(Object.fromEntries([...ARRAY_FIELDS, 'cooldown_overrides'].map(field => [field, value])));
        const track = await fetchTrackById(dbFor(row), 7);
        assert.deepEqual(track.roleIds, []);
        assert.deepEqual(track.channelIds, []);
        assert.deepEqual(track.levelRewards, []);
        assert.equal(track.cooldownOverrides, null);
    }
    assert.equal(errors.length, 0);
});

test('incorrect JSON shapes cannot become XP role/channel lists or cooldown overrides', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    for (const value of [{ message: 30 }, '{"message":30}', 123, '123', true, 'true']) {
        const track = await fetchTrackById(dbFor(trackRow({ role_ids: value, channel_ids: value, level_rewards: value })), 7);
        assert.deepEqual(track.roleIds, []);
        assert.deepEqual(track.channelIds, []);
        assert.deepEqual(track.levelRewards, []);
    }
    for (const value of [[1, 2], '[1,2]', 123, '123', true, 'true']) {
        const track = await fetchTrackById(dbFor(trackRow({ cooldown_overrides: value })), 7);
        assert.equal(track.cooldownOverrides, null);
    }
    assert.equal(errors.length, 0);
});

test('malformed JSON text still produces a diagnostic and retains safe defaults', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const track = await fetchTrackById(dbFor(trackRow({ role_ids: 'not json', cooldown_overrides: '{broken' })), 7);
    assert.deepEqual(track.roleIds, []);
    assert.equal(track.cooldownOverrides, null);
    assert.equal(errors.length, 2);
    assert.match(errors[0][0], /JSON array/u);
    assert.match(errors[1][0], /JSON object/u);
});

test('native JSON track settings still enforce both role and channel requirements when awarding XP', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const { getXPTracksForUser } = require('../utils/xpHelper.js');
    const db = dbFor(trackRow());
    const member = { id: 'member', roles: { cache: new Collection([[ROLE, { id: ROLE }]]) } };
    const matches = await getXPTracksForUser(member, CHANNEL, db);
    const special = matches.find(track => track.dbTrackName === '7');
    assert.ok(special);
    assert.equal(special.type, 'both_role_channel');
    assert.equal(special.cooldownOverrides.message, 30);
    assert.deepEqual(special.levelRewards, [1, 3]);
    assert.ok(!(await getXPTracksForUser(member, 'other-channel', db)).some(track => track.dbTrackName === '7'));
    const noRole = { id: 'no-role', roles: { cache: new Collection() } };
    assert.ok(!(await getXPTracksForUser(noRole, CHANNEL, db)).some(track => track.dbTrackName === '7'));
    assert.equal(errors.length, 0);
});

test('XP track autocomplete answers from cached tracks while a stale list refreshes in the background', async () => {
    let queries = 0, release;
    const db = {
        xpStore: {
            getSpecialTracks: () => [{ id: 9, name: 'Silver PvP' }, { id: 3, name: 'gold pvp' }, { id: 4, name: 'Dungeons' }],
            saveSpecialTracks() {}
        },
        query: () => { queries++; return new Promise(resolve => { release = resolve; }); }
    };
    assert.deepEqual(await fetchXpTrackAutocompleteChoices(db, 'PVP'),
        [{ name: 'gold pvp (ID: 3)', value: '3' }, { name: 'Silver PvP (ID: 9)', value: '9' }]);
    assert.equal(queries, 1);
    release([[trackRow({ id: 5, name: 'PvP Arena' })]]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await fetchXpTrackAutocompleteChoices(db, 'arena'), [{ name: 'PvP Arena (ID: 5)', value: '5' }]);
    assert.equal(queries, 1, 'A fresh cache answers without another MySQL query');
});

test('XP track autocomplete stops waiting for a slow first MySQL lookup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = fetchXpTrackAutocompleteChoices({ query: () => new Promise(() => {}) }, '');
    t.mock.timers.tick(1500);
    assert.deepEqual(await pending, []);
});
