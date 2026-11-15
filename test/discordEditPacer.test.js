// Verifies the shared Discord edit pacer: call order, spacing, slots, cancellation and pruning.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscordEditPacer } = require('../utils/discordEditPacer.js');
const { abortableDelay } = require('../utils/abortable.js');

function fixture({ routeDelayMs = 1500, sameMessageDelayMs = 6500 } = {}) {
    let now = 0;
    const waits = [], edits = [];
    const pacer = new DiscordEditPacer({ routeDelayMs, sameMessageDelayMs, clock: () => now,
        delay: async ms => { waits.push(ms); now += ms; } });
    const message = id => ({ id, async edit(payload) { edits.push({ id, at: now, payload }); return payload; } });
    const edit = (id, options = {}) => pacer.edit({ key: `channel:${id}`, load: async () => message(id),
        payload: () => ({ content: id }), ...options });
    return { pacer, waits, edits, edit, message, advance: ms => { now += ms; } };
}

test('a repeat edit of one message waits for the same-message delay and other messages for the route delay', async () => {
    const f = fixture();
    await f.edit('a');
    await f.edit('b');
    await f.edit('a');
    assert.deepEqual(f.waits, [1500, 5000]);
    assert.deepEqual(f.edits.map(edit => [edit.id, edit.at]), [['a', 0], ['b', 1500], ['a', 6500]]);
});

test('edits run in call order and one at a time, even when an earlier message loads slowly', async () => {
    const f = fixture({ routeDelayMs: 0, sameMessageDelayMs: 0 });
    const slow = Promise.withResolvers();
    const loads = [];
    const first = f.pacer.edit({ key: 'a', payload: () => ({ content: 'a' }),
        load: async () => { loads.push('a'); await slow.promise; return f.message('a'); } });
    const second = f.edit('b', { load: async () => { loads.push('b'); return f.message('b'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(loads, ['a']);
    slow.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(loads, ['a', 'b']);
    assert.deepEqual(f.edits.map(edit => edit.id), ['a', 'b']);
});

test('only sent edits use a slot: skipped payloads and stale callers do not, rejected edits do', async () => {
    const f = fixture({ routeDelayMs: 6500 });
    assert.equal(await f.edit('skipped', { payload: () => null }), null);
    await f.edit('b');
    assert.deepEqual(f.waits, [], 'a skipped payload sent nothing and needs no wait');
    f.advance(6500);
    let checks = 0;
    // Current before and after loading the message, stale after the wait.
    await assert.rejects(f.edit('stale', { isCurrent: () => ++checks < 3 }), { code: 'BOT_SHUTTING_DOWN' });
    assert.equal(checks, 3);
    const rejected = { async edit() { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } };
    await assert.rejects(f.pacer.edit({ key: 'channel:deleted', load: async () => rejected, payload: () => ({ content: 'x' }) }),
        { code: 10008 });
    await f.edit('c');
    assert.deepEqual(f.edits.map(edit => edit.id), ['b', 'c']);
    assert.deepEqual(f.waits, [6500], 'the rejected edit was sent, so the next edit waits for its slot');
});

test('an aborted wait rejects at once, sends nothing and does not hold up the next edit', async () => {
    let now = 0;
    const edits = [];
    const waiting = Promise.withResolvers();
    const pacer = new DiscordEditPacer({ routeDelayMs: 60_000, sameMessageDelayMs: 60_000, clock: () => now,
        delay: (ms, signal) => { waiting.resolve(ms); return abortableDelay(ms, signal); } });
    const edit = (id, options = {}) => pacer.edit({ key: id, payload: () => ({ content: id }),
        load: async () => ({ async edit() { edits.push(id); } }), ...options });
    await edit('first');
    const controller = new AbortController();
    const stopped = edit('stopped', { signal: controller.signal });
    const queued = edit('queued');
    assert.equal(await waiting.promise, 60_000);
    now = 60_000;
    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(stopped, { code: 'BOT_SHUTTING_DOWN' });
    // The next edit is measured from the first edit, so it needs no wait at all.
    await queued;
    assert.ok(Date.now() - abortedAt < 1000);
    assert.deepEqual(edits, ['first', 'queued']);
});

test('a caller that is already stopped sends nothing and loads no message', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    let loads = 0;
    await assert.rejects(f.edit('a', { signal: controller.signal, load: async () => { loads++; return f.message('a'); } }),
        { code: 'BOT_SHUTTING_DOWN' });
    assert.equal(loads, 0);
    assert.deepEqual(f.edits, []);
});

test('per-message edit times are pruned once more than 512 messages were edited', async () => {
    const f = fixture({ routeDelayMs: 0, sameMessageDelayMs: 0 });
    for (let index = 0; index < 512; index++) await f.edit(`old-${index}`);
    assert.equal(f.pacer.lastMessageEditAt.size, 512);
    f.advance(60_001);
    await f.edit('new');
    assert.deepEqual([...f.pacer.lastMessageEditAt.keys()], ['channel:new']);
});
