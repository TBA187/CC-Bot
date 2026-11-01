'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { Collection, Events } = require('discord.js');
const { fetchGuildMemberRoster } = require('../utils/guildMemberRoster.js');
const { ServerTagRoleManager } = require('../utils/serverTagRoleManager.js');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');
const exits = require('../events/memberExit.js');

function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function page(start, count) {
    return new Collection(Array.from({ length: count }, (_, index) => {
        const id = String(start + index);
        return [id, { id }];
    }));
}

test('concurrent features share one REST member list and do not retain a completed snapshot', async () => {
    const pending = deferred(), options = [];
    const guild = { members: { cache: page(9999, 1),
        fetch: () => assert.fail('Must not send gateway opcode 8'),
        list: input => { options.push(input); return pending.promise; } } };
    const tasks = Array.from({ length: 3 }, () => fetchGuildMemberRoster(guild));
    await nextTurn();
    assert.deepEqual(options, [{ limit: 1000, after: undefined, cache: true }]);
    pending.resolve(page(1, 3));
    const [first, second, third] = await Promise.all(tasks);
    assert.equal(first, second); assert.equal(second, third);
    assert.deepEqual([...first.keys()], ['1', '2', '3']);
    await fetchGuildMemberRoster(guild);
    assert.equal(options.length, 2);
});

test('REST pagination uses the highest snowflake and includes the final partial page', async () => {
    const calls = [], first = page(1, 1000);
    // Do not depend on insertion order when selecting the REST cursor.
    const one = first.get('1'); first.delete('1'); first.set('1', one);
    const guild = { members: { list: async options => {
        calls.push(options);
        return options.after ? page(1001, 37) : first;
    } } };
    const members = await fetchGuildMemberRoster(guild);
    assert.equal(members.size, 1037);
    assert.equal(calls[1].after, '1000');
    assert.equal(members.has('1037'), true);
});

test('an exact full page requires a final empty page before declaring the roster complete', async () => {
    const calls = [];
    const guild = { members: { list: async options => {
        calls.push(options.after); return options.after ? new Collection() : page(1, 1000);
    } } };
    assert.equal((await fetchGuildMemberRoster(guild)).size, 1000);
    assert.deepEqual(calls, [undefined, '1000']);
});

test('a later page failure rejects every caller instead of returning a partial roster, and allows retry', async () => {
    let fail = true, calls = 0;
    const guild = { members: { list: async ({ after }) => {
        calls++;
        if (fail && after) throw new Error('REST unavailable');
        return after ? page(1001, 1) : page(1, 1000);
    } } };
    const results = await Promise.allSettled([fetchGuildMemberRoster(guild), fetchGuildMemberRoster(guild)]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'REST unavailable'));
    assert.equal(calls, 2);
    fail = false;
    assert.equal((await fetchGuildMemberRoster(guild)).size, 1001);
    assert.equal(calls, 4);
});

test('a full page that does not advance the cursor fails instead of looping', async () => {
    let calls = 0;
    const guild = { members: { list: async () => { calls++; return page(1, 1000); } } };
    await assert.rejects(fetchGuildMemberRoster(guild), /pagination did not advance/);
    assert.equal(calls, 2);
});

test('different guilds load independently', async () => {
    const waiting = deferred();
    const first = fetchGuildMemberRoster({ members: { list: () => waiting.promise } });
    const second = await fetchGuildMemberRoster({ members: { list: async () => page(2, 1) } });
    assert.equal(second.has('2'), true);
    waiting.resolve(page(1, 1)); await first;
});

test('an already cancelled caller does not start any member requests', async () => {
    const controller = new AbortController(); controller.abort();
    const guild = { members: { list: () => assert.fail('Cancelled request') } };
    await assert.rejects(fetchGuildMemberRoster(guild, { signal: controller.signal }), { code: 'BOT_SHUTTING_DOWN' });
});

test('cancelling one feature does not cancel the roster needed by another', async () => {
    const pending = deferred(), controller = new AbortController(); let calls = 0;
    const guild = { members: { list: () => { calls++; return pending.promise; } } };
    const cancelled = fetchGuildMemberRoster(guild, { signal: controller.signal });
    const active = fetchGuildMemberRoster(guild);
    await nextTurn(); controller.abort();
    await assert.rejects(cancelled, { code: 'BOT_SHUTTING_DOWN' });
    pending.resolve(page(1, 1));
    assert.equal((await active).size, 1); assert.equal(calls, 1);
});

test('cancelling all consumers stops pagination and a later caller starts a fresh load', async () => {
    const pending = deferred(), controller = new AbortController(); let calls = 0;
    const guild = { members: { list: () => { calls++; return pending.promise; } } };
    const loading = fetchGuildMemberRoster(guild, { signal: controller.signal });
    await nextTurn(); controller.abort();
    await assert.rejects(loading, { code: 'BOT_SHUTTING_DOWN' });
    pending.resolve(page(1, 1000)); await nextTurn();
    assert.equal(calls, 1);
    guild.members.list = async () => { calls++; return page(1, 1); };
    assert.equal((await fetchGuildMemberRoster(guild)).size, 1); assert.equal(calls, 2);
});

test('timeout recovery, CC tag startup, and the real scout seed share REST instead of competing gateway fetches', async t => {
    const controller = new AbortController(); t.after(() => controller.abort());
    const pending = deferred(), client = new EventEmitter(); let lists = 0, seeded = 0;
    const guild = { id: 'guild', available: true, roles: { cache: new Collection([
        ['cc-role', { id: 'cc-role', editable: true, managed: false }]
    ]) } };
    const member = { id: '1', guild, user: { id: '1', username: 'example', bot: false },
        nickname: null, roles: { cache: new Collection() }, communicationDisabledUntilTimestamp: null };
    guild.members = { cache: new Collection([['1', member]]), me: { permissions: { has: () => true } },
        list: () => { lists++; return pending.promise; }, fetch: () => assert.fail('Unexpected gateway member fetch') };
    client.guilds = { cache: new Collection([['guild', guild]]) };
    client.rest = { get: async () => ({ primary_guild: null }) };
    const policy = new ServerTagRoleManager({ client, guildId: 'guild', roleId: 'cc-role', signal: controller.signal, spacingMs: 0 });
    exits.initializeTimeoutTracking(client, { guildId: 'guild', shutdownSignal: controller.signal,
        memberHistory: { seedMembers: members => { seeded++; assert.equal(members.has('1'), true); } } });
    const store = new ScoutRosterStore({ db: { query: async sql => {
        assert.match(sql.trim(), /^SELECT/); return [[]];
    } } });
    store.schemaReady = true; store.hasSeededGuild = async () => true;
    const tasks = [client.listeners(Events.ClientReady)[0](), policy.sweep({ startup: true }),
        store.seedCurrentGuildMembers(guild, 'guild-role', { signal: controller.signal })];
    await nextTurn(); assert.equal(lists, 1);
    pending.resolve(new Collection([['1', member]]));
    await Promise.all(tasks);
    assert.equal(lists, 1); assert.equal(seeded, 1); assert.equal(policy.states.get('1').enabled, false);
});
