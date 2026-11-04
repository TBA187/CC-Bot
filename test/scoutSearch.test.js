// Checks dictionary-based detail searches and UTC report-date labels.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detailQuery, matchesDetails, reportDateRange } = require('../features/pvp-scouting/ScoutSearch.js');

test('search vocabulary resolves move, item, ability and nature shorthands', () => {
    assert.deepEqual(detailQuery('shadow ball, sash, timid, levitate').map(term => [term.kind, term.name]),
        [['move', 'Shadow Ball'], ['item', 'Focus Sash'], ['nature', 'Timid'], ['ability', 'Levitate']]);
    assert.equal(detailQuery('specs')[0].name, 'Choice Specs');
    assert.equal(detailQuery('eq')[0].name, 'Earthquake');
    assert.equal(detailQuery('hdb')[0].name, 'Heavy-Duty Boots');
    assert.equal(detailQuery('sash, focus sash').length, 1);
    assert.deepEqual(detailQuery('vest').map(term => [term.kind, term.name]), [['item', 'Assault Vest']]);
    assert.equal(matchesDetails('Tyranitar Vest: Flamethrower', detailQuery('assault vest')), true);
    assert.equal(matchesDetails('Tyranitar no vest: Flamethrower', detailQuery('vest')), false);
});

test('detail searches accept comma, space, and mixed separators', () => {
    const names = input => detailQuery(input).map(term => [term.kind, term.name]);
    const expected = [['move', 'Roost'], ['item', 'Rocky Helmet']];
    assert.deepEqual(names('roost, rocky helmet'), expected);
    assert.deepEqual(names('roost rocky helmet'), expected);
    assert.deepEqual(names('roost rocky helmet, choice specs'),
        [...expected, ['item', 'Choice Specs']]);
});

test('unknown or ambiguous detail queries fail clearly instead of silently widening results', () => {
    for (const input of ['not a real item', 'shadow ball,', 'bp']) assert.throws(() => detailQuery(input), /recognized/);
});

test('all detail requirements must be present, with negative notes excluded', () => {
    assert.equal(matchesDetails('(Item: Focus Sash; Nature: Timid): Shadow Ball', detailQuery('shadow ball, sash, timid')), true);
    assert.equal(matchesDetails(': Shadow Ball', detailQuery('shadow ball, sash')), false);
    assert.equal(matchesDetails('(Item: specs): shadowball', detailQuery('shadow ball, specs')), true);
    assert.equal(matchesDetails('- no healing wish', detailQuery('healing wish')), false);
    assert.equal(matchesDetails('- no healing wish but Thunderbolt', detailQuery('healing wish')), false);
    assert.equal(matchesDetails('- no healing wish but Thunderbolt', detailQuery('thunderbolt')), true);
    assert.equal(matchesDetails('(Not Banded): Liquidation', detailQuery('banded')), false);
});

test('date ranges omit absent dates and use UTC for single reports and multiple reports', () => {
    assert.equal(reportDateRange([]), '');
    assert.equal(reportDateRange([{ created_at: '2026-09-30T23:30:00Z' }]), ' (2026-09-30)');
    assert.equal(reportDateRange([{ created_at: '2026-10-02T00:30:00Z' }, { created_at: '2026-09-30T23:30:00Z' }]),
        ' (2026-09-30 — 2026-10-02)');
});

test('general archive reads retain the same publication and channel filters as IGN lookups', async () => {
    const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
    const queries = [];
    const store = new PvpScoutStore({ db: { async query(sql, params) { queries.push({ sql, params }); return [[]]; } },
        channelId: 'silver-channel' });
    store.ensureSchema = async () => {};
    await store.searchRootsAndSources(null, 'silver-channel');
    await store.searchRootsAndSources('example', 'silver-channel');
    assert.deepEqual(queries[0].params, ['silver-channel']);
    assert.deepEqual(queries[1].params, ['silver-channel', 'example']);
    for (const { sql } of queries) {
        assert.match(sql, /source.channel_id = root.channel_id/u);
        assert.doesNotMatch(sql, /SELECT\s+source\.\*/iu);
        assert.match(sql, /CASE WHEN source\.message_id = root\.message_id THEN source\.ocr_json ELSE '\[\]' END AS ocr_json/iu);
        assert.match(sql, /root.is_deleted = 0/u);
        assert.match(sql, /root.review_status <> 'not_scout'/u);
        assert.match(sql, /member_submission.*pending/u);
    }
    assert.match(queries[0].sql, /COALESCE\(root.ign_normalized, ''\) <> ''/u);
    assert.match(queries[1].sql, /root.ign_normalized = \?/u);
});

test('server counts use the exact lookup visibility rules without loading source payloads', async () => {
    const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
    const queries = [];
    const store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query(sql, params) {
        queries.push({ sql, params }); return [[{ total: 8 }]];
    } } });
    store.schemaReady = true;
    for (const ign of ['opponent', null]) {
        await store.searchRootsAndSources(ign, 'silver-channel');
        assert.equal(await store.publicReportCount(ign, 'silver-channel'), 8);
        const [lookup, count] = queries.slice(-2);
        assert.deepEqual(count.params, lookup.params);
        const where = query => query.sql.split('WHERE ')[1].split('ORDER BY')[0].trim();
        assert.equal(where(count), where(lookup));
        assert.match(count.sql, /SELECT COUNT\(\*\) AS total/u);
        assert.doesNotMatch(count.sql, /JOIN|ocr_json|team_text|attachments_json/u);
    }
});

test('server counts share concurrent reads, cache zeroes, expire and invalidate on archive writes', async t => {
    const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
    let reads = 0, total = 0, now = 1000, release;
    t.mock.method(Date, 'now', () => now);
    const pending = new Promise(resolve => { release = resolve; });
    const store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query() {
        reads++; if (reads === 1) await pending; return [[{ total }]];
    } } });
    store.schemaReady = true;
    const first = store.publicReportCount('opponent'), second = store.publicReportCount('opponent');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1); release();
    assert.deepEqual(await Promise.all([first, second]), [0, 0]);
    assert.equal(await store.publicReportCount('opponent'), 0); assert.equal(reads, 1);
    total = 5; store.invalidateAutocompleteCache();
    assert.equal(await store.publicReportCount('opponent'), 5); assert.equal(reads, 2);
    now += 15_001;
    assert.equal(await store.publicReportCount('opponent'), 5); assert.equal(reads, 3);
    await store.publicReportCount('opponent', 'silver-channel'); assert.equal(reads, 4);
    for (let index = 0; index < 30; index++) await store.publicReportCount(`opponent${index}`);
    assert.ok(store.reportCountCache.size <= 25);
});

test('failed and superseded server counts cannot poison later dropdown counts', async () => {
    const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
    let reads = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query() {
        reads++;
        if (reads === 1) throw new Error('Database unavailable');
        if (reads === 2) { await pending; return [[{ total: 1 }]]; }
        return [[{ total: 2 }]];
    } } });
    store.schemaReady = true;
    await assert.rejects(store.publicReportCount('opponent'), /Database unavailable/u);
    const old = store.publicReportCount('opponent');
    await new Promise(resolve => setImmediate(resolve));
    store.invalidateAutocompleteCache();
    assert.equal(await store.publicReportCount('opponent'), 2);
    release(); assert.equal(await old, 1);
    assert.equal(await store.publicReportCount('opponent'), 2); assert.equal(reads, 3);
});
