// Verifies that recurring background failures alert once per streak and log their recovery.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FailureStreak, temporaryFailure } = require('../utils/failureStreak.js');

function capture(t) {
    const errors = [], logs = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    t.mock.method(console, 'log', (...args) => logs.push(args));
    return { errors, logs };
}

test('a recurring failure is reported once and its recovery logs the number of failed attempts', t => {
    const { errors, logs } = capture(t);
    const streak = new FailureStreak();
    const failure = new TypeError('Cannot read properties of undefined');
    assert.equal(streak.fail('shop', '[CC LOG] PRO Forum Shop monitor failed:', failure), true);
    assert.equal(streak.fail('shop', '[CC LOG] PRO Forum Shop monitor failed:', failure), false);
    assert.equal(streak.fail('shop', '[CC LOG] PRO Forum Shop monitor failed:', failure), false);
    assert.deepEqual(errors, [['[CC LOG] PRO Forum Shop monitor failed:', failure]]);
    streak.succeed('shop', '[CC LOG] PRO Forum Shop monitor recovered');
    assert.deepEqual(logs, [['[CC LOG] PRO Forum Shop monitor recovered after 3 failed attempt(s).']]);
    streak.succeed('shop', '[CC LOG] PRO Forum Shop monitor recovered');
    assert.equal(logs.length, 1, 'a success without a streak logs nothing');
    streak.fail('shop', '[CC LOG] PRO Forum Shop monitor failed:', failure);
    assert.equal(errors.length, 2, 'a new streak alerts again');
});

test('temporary Discord and network failures stay in the console, while permission errors alert', t => {
    const { errors, logs } = capture(t);
    const temporary = [
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        Object.assign(new Error('Service Unavailable'), { status: 503 }),
        Object.assign(new Error('You are being rate limited.'), { status: 429 }),
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    ];
    for (const [index, error] of temporary.entries()) {
        assert.equal(temporaryFailure(error), true);
        new FailureStreak().fail(`temporary-${index}`, '[CC LOG] Guild Application notification 1 failed:', error);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(logs.map(args => args[1]), ['ECONNRESET', '503', '429', 'AbortError']);
    const streak = new FailureStreak();
    streak.fail('post', '[CC LOG] Guild Application notification 2 failed:', temporary[0]);
    const missing = Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
    assert.equal(temporaryFailure(missing), false);
    assert.equal(streak.fail('post', '[CC LOG] Guild Application notification 2 failed:', missing), true);
    assert.deepEqual(errors, [['[CC LOG] Guild Application notification 2 failed:', missing]]);
});

test('each key has its own streak, and the oldest streaks are released beyond the limit', t => {
    const { errors } = capture(t);
    const streak = new FailureStreak({ maxStreaks: 2 });
    for (const key of ['a', 'b', 'c']) streak.fail(key, `[CC LOG] Vote reminder ${key} failed:`, new Error('bad data'));
    assert.equal(errors.length, 3);
    assert.deepEqual([...streak.streaks.keys()], ['b', 'c']);
    streak.forget('b');
    assert.deepEqual([...streak.streaks.keys()], ['c']);
});
