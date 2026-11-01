// Check that autocomplete responds within Discord’s acknowledgement deadline.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Scout = require('../commands/scout.js');
const { autocompleteWithinDeadline } = Scout;
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function storeWithQuery(query) {
    const store = new PvpScoutStore({ channelId: 'channel', db: { query } });
    store.schemaReady = true;
    return store;
}

function commandForStore(options) {
    return new Scout({ guildId: 'guild', guildMemberRoleID: 'member',
        scoutServerSettings: { getCachedServer: () => 'gold' }, ...options });
}

function autocompleteInteraction(term, age = 0) {
    const responses = [];
    return {
        inGuild: () => true, guildId: 'guild', user: { id: 'user' }, member: { roles: ['member'] },
        createdTimestamp: Date.now() - age,
        options: { getFocused: () => term },
        respond: async choices => { responses.push(choices); },
        responses
    };
}

test('isolated autocomplete delays stay in the console; five delays within five minutes raise one warning', t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const logs = [], warnings = [];
    t.mock.method(console, 'log', text => logs.push(text));
    t.mock.method(console, 'warn', text => warnings.push(text));
    const command = commandForStore({});
    command.logAutocompleteDelay('arrived too late to answer (4569ms old)');
    assert.equal(logs.length, 1);
    assert.deepEqual(warnings, []);
    for (let count = 0; count < 4; count++) {
        now += 1000;
        command.logAutocompleteDelay('reply rejected (10062; 10ms old on arrival)');
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /5 times within 5 minutes/u);
    command.logAutocompleteDelay('another late request');
    assert.equal(warnings.length, 1);
    now += 5 * 60_000;
    command.logAutocompleteDelay('isolated delay after the previous window');
    assert.equal(warnings.length, 1);
    assert.equal(command.autocompleteDelayWindow.count, 1);
});

test('cold autocomplete responds before a controlled database query resolves and later warms the cache', async () => {
    const slow = deferred();
    let queries = 0;
    const store = storeWithQuery(async () => { queries++; return slow.promise; });
    const command = commandForStore({ pvpScoutStore: store, pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('');
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses, [[]]);
    assert.equal(queries, 0, 'acknowledgement finishes before database work is scheduled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 1);
    slow.resolve([[{ opponent_ign: 'Miltos7' }]]);
    assert.deepEqual(await store.autocomplete('', 'channel'), ['Miltos7']);
    assert.equal(queries, 1, 'the second caller shares the ongoing cache fill');
});

test('typed cache misses use only matching cached names, then replace them with the complete query result', async () => {
    const slow = deferred();
    const store = storeWithQuery(async () => slow.promise);
    store.autocompleteCache.set('channel:', { names: ['Blacku', 'Miltos7', 'he', 'for'], expiresAt: 0 });
    store.autocompleteCache.set('other:', { names: ['BadChannel'], expiresAt: 0 });
    const command = commandForStore({ pvpScoutStore: store, pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('b');
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses[0], [{ name: '🥇 Blacku', value: 'Blacku' }]);
    await new Promise(resolve => setImmediate(resolve));
    slow.resolve([[{ opponent_ign: 'Blackw' }]]);
    assert.deepEqual(await store.autocomplete('b', 'channel'), ['Blackw']);
    assert.deepEqual(store.cachedAutocomplete('he', 'channel'), []);
    assert.deepEqual(store.cachedAutocomplete('for', 'channel'), []);
});

test('blank autocomplete keeps the newest 25 cache order while one background refresh runs', async () => {
    const slow = deferred();
    let queries = 0;
    const store = storeWithQuery(async (_sql, params) => {
        queries++;
        assert.deepEqual(params, ['channel', '', '']);
        return slow.promise;
    });
    const names = Array.from({ length: 25 }, (_, i) => `Opponent${25 - i}`);
    store.autocompleteCache.set('channel:', { names, expiresAt: 0 });
    assert.deepEqual(await store.autocomplete('', 'channel'), names);
    assert.deepEqual(await store.autocomplete('', 'channel'), names);
    assert.equal(queries, 1);
    slow.resolve([names.map(opponent_ign => ({ opponent_ign }))]);
    await store.autocomplete('', 'channel', true);
});

test('a late database rejection is handled after the autocomplete reply', async t => {
    const slow = deferred();
    const store = storeWithQuery(async () => slow.promise);
    const command = commandForStore({ pvpScoutStore: store, pvpScoutingGoldChannelID: 'channel' });
    t.mock.method(console, 'warn', () => {});
    const interaction = autocompleteInteraction('unknown');
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses, [[]]);
    await new Promise(resolve => setImmediate(resolve));
    slow.reject(new Error('controlled slow query failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.autocompleteRequests.size, 0);
});

test('deadline helper waits for fast results but does not cancel a slow cache fill', async () => {
    assert.deepEqual(await autocompleteWithinDeadline(Promise.resolve(['FastName']), 20, () => ['CachedName']), ['FastName']);
    const slow = deferred();
    assert.deepEqual(await autocompleteWithinDeadline(slow.promise, 5, () => ['CachedName']), ['CachedName']);
    slow.resolve(['LaterName']);
    assert.deepEqual(await slow.promise, ['LaterName']);
});

test('fresh empty typed results remain empty and known filler names are excluded from fresh results', async () => {
    const store = storeWithQuery(async () => [[{ opponent_ign: 'he' }, { opponent_ign: 'for' }, { opponent_ign: 'Charizardfan' }]]);
    assert.deepEqual(await store.autocomplete('', 'channel'), ['Charizardfan']);
    store.autocompleteCache.set('channel:b', { names: [], refreshedAt: 2, expiresAt: Date.now() + 60000 });
    store.autocompleteCache.set('channel:', { names: ['Blacku'], refreshedAt: 1, expiresAt: Date.now() + 60000 });
    assert.deepEqual(await store.autocomplete('b', 'channel'), []);
});

function cacheFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scout-autocomplete-test-'));
    const filename = path.join(directory, 'cache.json');
    t.after(() => {
        for (const file of [filename, `${filename}.tmp`]) if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(directory);
    });
    return filename;
}

test('newest 25 survive a restart and reply immediately while a database refresh remains blocked', async t => {
    const autocompleteCachePath = cacheFile(t);
    const names = Array.from({ length: 25 }, (_, i) => `Opponent${25 - i}`);
    const first = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: async () => [names.map((opponent_ign, index) => ({ opponent_ign,
            last_scouted: new Date(Date.UTC(2026, 8, 25 - index)) }))] } });
    first.schemaReady = true;
    assert.deepEqual(await first.autocomplete(''), names);
    const refresh = deferred();
    const restarted = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: () => refresh.promise } });
    restarted.schemaReady = true;
    const command = commandForStore({ pvpScoutStore: restarted, pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('', 0);
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses[0].map(choice => choice.value), names);
    assert.equal(interaction.responses[0][0].name, '🥇 Opponent25 (2026-09-25)');
    assert.equal(restarted.cachedAutocompleteLatestScout('Opponent25'), '2026-09-25T00:00:00.000Z');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restarted.autocompleteRequests.size, 1);
    refresh.resolve([[{ opponent_ign: 'NewOpponent' }]]);
    await restarted.autocomplete('', 'channel', true);
    const nextRestart = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath });
    assert.deepEqual(nextRestart.cachedAutocomplete(''), ['NewOpponent']);
});

test('saved autocomplete remains available on lookup failure without restoring filler or another channel', async t => {
    const autocompleteCachePath = cacheFile(t);
    fs.writeFileSync(autocompleteCachePath, JSON.stringify({ version: 1, channelId: 'channel',
        names: ['he', 'for', 'Miltos7', 'Blacku'] }));
    const store = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: async () => { throw new Error('controlled unavailable database'); } } });
    store.schemaReady = true;
    assert.deepEqual(await store.autocomplete('', 'channel', true), ['Miltos7', 'Blacku']);
    assert.deepEqual(store.cachedAutocomplete('b'), ['Blacku']);
    const other = new PvpScoutStore({ channelId: 'other', autocompleteCachePath });
    assert.deepEqual(other.cachedAutocomplete(''), []);
});

test('corrupt autocomplete snapshot is ignored and replaced after a successful read', async t => {
    const autocompleteCachePath = cacheFile(t);
    t.mock.method(console, 'warn', () => {});
    fs.writeFileSync(autocompleteCachePath, '{broken');
    const store = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: async () => [[{ opponent_ign: 'Victor100' }]] } });
    store.schemaReady = true;
    assert.deepEqual(store.cachedAutocomplete(''), []);
    await store.autocomplete('');
    assert.deepEqual(JSON.parse(fs.readFileSync(autocompleteCachePath)).names, ['Victor100']);
});

test('an expired Discord autocomplete is responded to only once', async t => {
    t.mock.method(console, 'warn', () => {});
    const store = storeWithQuery(async () => [[{ opponent_ign: 'Miltos7' }]]);
    const command = commandForStore({ pvpScoutStore: store, pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('', 0);
    let replies = 0;
    interaction.respond = async () => { replies++; throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
    await command.handleAutocomplete(interaction);
    assert.equal(replies, 1);
});

test('an autocomplete received after the deadline is skipped without a doomed API request', async t => {
    t.mock.method(console, 'warn', () => {});
    let queries = 0;
    const command = commandForStore({ pvpScoutStore: storeWithQuery(async () => { queries++; return [[]]; }),
        pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('', 4000);
    await command.handleAutocomplete(interaction);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(interaction.responses, []);
    assert.equal(queries, 0);
});

test('fresh prefix results exclude names left in an older complete index', async () => {
    const store = storeWithQuery(async () => [[{ opponent_ign: 'Blackw', report_count: 2 }]]);
    store.autocompleteCache.set('channel:', { names: ['Blacku'], refreshedAt: 1, expiresAt: 0 });
    assert.deepEqual(await store.autocomplete('b', 'channel', true), ['Blackw']);
    assert.deepEqual(store.cachedAutocomplete('b', 'channel'), ['Blackw']);
});

test('a fresh complete index excludes names left in an older prefix cache', async () => {
    const store = storeWithQuery(async () => [[{ opponent_ign: 'Blackw', report_count: 2 }]]);
    store.autocompleteCache.set('channel:b', { names: ['Blacku'], refreshedAt: 1, expiresAt: 0 });
    assert.deepEqual(await store.autocomplete('', 'channel', true), ['Blackw']);
    assert.deepEqual(store.cachedAutocomplete('b', 'channel'), ['Blackw']);
});

test('a fresh complete index with no reports suppresses older cached suggestions', async () => {
    const store = storeWithQuery(async () => [[]]);
    store.autocompleteCache.set('channel:b', { names: ['Blacku'], refreshedAt: 1, expiresAt: 0 });
    assert.deepEqual(await store.autocomplete('', 'channel', true), []);
    assert.deepEqual(store.cachedAutocomplete('b', 'channel'), []);
});

test('autocomplete count labels survive saved caches and leave the selected IGN value unchanged', async t => {
    const autocompleteCachePath = cacheFile(t);
    const first = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: async () => [[{ opponent_ign: '90skid', ign_normalized: '90skid', report_count: 8 },
            { opponent_ign: 'Blacku', ign_normalized: 'blacku', report_count: 1 }]] } });
    first.schemaReady = true;
    await first.autocomplete('');
    const refresh = deferred();
    const restarted = new PvpScoutStore({ channelId: 'channel', autocompleteCachePath,
        db: { query: () => refresh.promise } });
    restarted.schemaReady = true;
    const command = commandForStore({ pvpScoutStore: restarted, pvpScoutingGoldChannelID: 'channel' });
    const interaction = autocompleteInteraction('');
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses[0], [
        { name: '🥇 90skid — Scout Reports: 8', value: '90skid' },
        { name: '🥇 Blacku — Scout Reports: 1', value: 'Blacku' }
    ]);
    await new Promise(resolve => setImmediate(resolve));
    refresh.resolve([[]]);
    await restarted.autocomplete('', 'channel', true);
});

test('typed cache pressure cannot evict the default newest-25 list', async () => {
    const store = storeWithQuery(async () => [[{ opponent_ign: 'NewName' }]]);
    const latest = Array.from({ length: 25 }, (_, i) => `Opponent${i}`);
    store.autocompleteCache.set('channel:', { names: latest, expiresAt: 0 });
    for (let i = 0; i < 100; i++) store.autocompleteCache.set(`channel:prefix${i}`, { names: [], expiresAt: 0 });
    await store.autocomplete('new');
    assert.equal(store.autocompleteCache.size, 100);
    assert.deepEqual(store.cachedAutocomplete(''), latest);
});

test('autocomplete rechecks the current deadline after preparing cached suggestions', async t => {
    let clock = 10_000;
    t.mock.method(Date, 'now', () => clock);
    let queries = 0;
    const command = commandForStore({
        pvpScoutStore: storeWithQuery(async () => { queries++; return [[]]; }),
        pvpScoutingGoldChannelID: 'channel'
    });
    const notices = [];
    t.mock.method(command, 'logAutocompleteDelay', message => notices.push(message));
    t.mock.method(command, 'cachedSuggestions', () => {
        clock += 200;
        return [{ name: 'Miltos7', server: 'gold', count: 1 }];
    });
    const interaction = autocompleteInteraction('', 2400);
    await command.handleAutocomplete(interaction);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(interaction.responses, []);
    assert.equal(queries, 0);
    assert.match(notices[0], /2400ms old on arrival, 2600ms old before reply/u);
});

test('background autocomplete queries wait until the reply is acknowledged', async () => {
    const reply = deferred();
    let queries = 0;
    const command = commandForStore({
        pvpScoutStore: storeWithQuery(async () => { queries++; return [[{ opponent_ign: 'Miltos7' }]]; }),
        pvpScoutingGoldChannelID: 'channel'
    });
    const interaction = autocompleteInteraction('');
    interaction.respond = choices => { interaction.responses.push(choices); return reply.promise; };
    const pending = command.handleAutocomplete(interaction);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(interaction.responses, [[]]);
    assert.equal(queries, 0, 'cache refresh must not block the reply still in flight');
    reply.resolve();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 1);
});

test('a rejected autocomplete acknowledgement does not start background queries or retry', async t => {
    let queries = 0, replies = 0;
    const command = commandForStore({
        pvpScoutStore: storeWithQuery(async () => { queries++; return [[]]; }),
        pvpScoutingGoldChannelID: 'channel'
    });
    t.mock.method(command, 'logAutocompleteDelay', () => {});
    const interaction = autocompleteInteraction('');
    interaction.respond = async () => {
        replies++;
        throw Object.assign(new Error('Unknown interaction'), { code: 10062 });
    };
    await command.handleAutocomplete(interaction);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies, 1);
    assert.equal(queries, 0);
});

test('a cache error after the response budget expires does not send a doomed fallback', async t => {
    let clock = 10_000;
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(console, 'warn', () => {});
    const command = commandForStore({
        pvpScoutStore: storeWithQuery(async () => [[]]),
        pvpScoutingGoldChannelID: 'channel'
    });
    t.mock.method(command, 'cachedSuggestions', () => {
        clock += 300;
        throw new Error('controlled cache failure');
    });
    const interaction = autocompleteInteraction('', 2400);
    await command.handleAutocomplete(interaction);
    assert.deepEqual(interaction.responses, []);
});
