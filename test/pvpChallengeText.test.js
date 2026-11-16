// Checks the accepted-challenge text rotation without touching the bot's data folder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PvpChallengeText, BUNDLED_CATEGORIES } = require('../commands/pvp-king/utils/pvpChallengeText.js');

const CATEGORIES = {
    murkrow: ['Murkrow one 🌑', 'Murkrow two 🪶', 'Murkrow three ✨'],
    itachi: ['Itachi one 🔴', 'Itachi two 🔥'],
    crows: ['Crows one 🐦‍⬛', 'Crows two 🖤']
};
const categoryOf = line => Object.keys(CATEGORIES).find(name => CATEGORIES[name].includes(line));

function stateFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pvp-text-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'pvp_challenge_text.json');
}

function sequence(...values) {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
}

test('each server steps through Murkrow, Itachi and crow lines in order', t => {
    const text = new PvpChallengeText({ filePath: stateFile(t), categories: CATEGORIES });
    const gold = [], silver = [];
    for (let round = 0; round < 6; round++) {
        gold.push(categoryOf(text.next('gold')));
        // Uneven turns between the servers must not shift either server's order.
        if (round % 2 === 0) silver.push(categoryOf(text.next('silver')));
    }
    assert.deepEqual(gold, ['murkrow', 'itachi', 'crows', 'murkrow', 'itachi', 'crows']);
    assert.deepEqual(silver, ['murkrow', 'itachi', 'crows']);
});

test('servers share shown lines, so no line repeats until its whole category was used', t => {
    const text = new PvpChallengeText({ filePath: stateFile(t), categories: CATEGORIES });
    const murkrow = [text.next('gold'), text.next('silver')];
    text.next('gold'); text.next('gold');
    murkrow.push(text.next('gold'));
    assert.deepEqual([...murkrow].sort(), [...CATEGORIES.murkrow].sort());
});

test('each channel skips emoji from its own recent posts until no other line is left', t => {
    const categories = { murkrow: ['Murkrow 🔥', 'Murkrow 🌑'], itachi: ['Itachi 🔥', 'Itachi 👑'], crows: ['Crows 🔥'] };
    // A 0 roll takes the first candidate, which would repeat 🔥 without the recent-emoji rule.
    const text = new PvpChallengeText({ filePath: stateFile(t), categories, random: () => 0 });
    assert.equal(text.next('gold'), 'Murkrow 🔥');
    assert.equal(text.next('gold'), 'Itachi 👑');
    assert.equal(text.next('gold'), 'Crows 🔥', 'a category whose only lines share a recent emoji still posts');
    // Silver has not shown 🔥 yet, so the remaining Itachi line is fine there.
    assert.equal(text.next('silver'), 'Murkrow 🌑');
    assert.equal(text.next('silver'), 'Itachi 🔥');
});

test('a category never opens a new cycle with the line that ended its previous cycle', t => {
    // Three Murkrow picks of 0.99 end the cycle on the first Murkrow line; a 0 roll would show it again without the guard.
    const random = sequence(0.99, 0, 0, 0.99, 0, 0, 0.99, 0, 0, 0);
    const text = new PvpChallengeText({ filePath: stateFile(t), categories: CATEGORIES, random });
    const murkrow = [];
    for (let pick = 0; pick < 10; pick++) {
        const line = text.next('gold');
        if (pick % 3 === 0) murkrow.push(line);
    }
    assert.deepEqual([...murkrow.slice(0, 3)].sort(), [...CATEGORIES.murkrow].sort());
    assert.equal(murkrow[2], CATEGORIES.murkrow[0]);
    assert.notEqual(murkrow[3], murkrow[2]);
});

test('remembers shown lines and each server\'s next category across restarts without reading during construction', t => {
    const filePath = stateFile(t);
    const before = new PvpChallengeText({ filePath, categories: CATEGORIES });
    assert.equal(fs.existsSync(filePath), false);
    const goldFirst = before.next('gold');
    const after = new PvpChallengeText({ filePath, categories: CATEGORIES });
    assert.equal(categoryOf(after.next('gold')), 'itachi');
    const silverFirst = after.next('silver');
    assert.equal(categoryOf(after.next('gold')), 'crows');
    const goldSecond = after.next('gold');
    assert.deepEqual([goldFirst, silverFirst, goldSecond].map(categoryOf), ['murkrow', 'murkrow', 'murkrow']);
    assert.equal(new Set([goldFirst, silverFirst, goldSecond]).size, 3);
});

test('edited lines count as new and removed lines or categories cannot block the rotation', t => {
    const filePath = stateFile(t);
    const original = new PvpChallengeText({ filePath, categories: CATEGORIES });
    const shown = Array.from({ length: 4 }, () => original.next('gold'));
    const edited = new PvpChallengeText({ filePath, categories: {
        murkrow: [shown[0], 'Edited Murkrow 🌘'],
        crows: CATEGORIES.crows
    } });
    // Gold was due an Itachi line, but that category was removed, so it continues with the first one.
    assert.equal(edited.next('gold'), 'Edited Murkrow 🌘');
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(Object.keys(saved.last).sort(), ['crows', 'murkrow']);
    assert.equal(saved.shown.length, 3, 'keys of removed lines are dropped');
    assert.equal(saved.next.gold, 'crows');
});

test('an unreadable history starts a new rotation and keeps a copy of the original file', t => {
    const filePath = stateFile(t);
    fs.writeFileSync(filePath, 'not json');
    const warn = t.mock.method(console, 'warn', () => {});
    const text = new PvpChallengeText({ filePath, categories: CATEGORIES });
    assert.equal(categoryOf(text.next('gold')), 'murkrow');
    text.next('gold');
    assert.equal(warn.mock.calls.length, 1);
    const copies = fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.corrupt-'));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), copies[0]), 'utf8'), 'not json');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).shown.length, 2);
});

test('failed saves keep serving lines and warn once per failure streak', t => {
    const filePath = stateFile(t);
    const warn = t.mock.method(console, 'warn', () => {});
    const rename = fs.renameSync;
    let failing = true;
    t.mock.method(fs, 'renameSync', (...args) => {
        if (failing) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
        return rename(...args);
    });
    const text = new PvpChallengeText({ filePath, categories: CATEGORIES });
    text.next('gold'); text.next('gold');
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(fs.existsSync(filePath), false);
    failing = false;
    assert.equal(categoryOf(text.next('gold')), 'crows', 'the order continues from memory during the failure');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).shown.length, 3);
    failing = true;
    text.next('gold');
    assert.equal(warn.mock.calls.length, 2);
});

test('rejects a missing state path and empty, blank or duplicate lines', () => {
    assert.throws(() => new PvpChallengeText({ categories: CATEGORIES }), /state file path/u);
    for (const categories of [{}, [], { murkrow: [] }, { murkrow: ['Line ⚔️', ' '] },
        { murkrow: ['Line ⚔️'], crows: ['Line ⚔️'] }, { murkrow: 'Line ⚔️' }]) {
        assert.throws(() => new PvpChallengeText({ filePath: 'unused.json', categories }), TypeError);
    }
});

test('bundled lines are evenly grouped, unique, brief, end with an emoji and cannot ping anyone', () => {
    assert.deepEqual(Object.keys(BUNDLED_CATEGORIES), ['murkrow', 'itachi', 'crows']);
    const sizes = new Set(Object.values(BUNDLED_CATEGORIES).map(lines => lines.length));
    assert.equal(sizes.size, 1, 'equal category sizes keep the categories cycling together');
    const all = Object.values(BUNDLED_CATEGORIES).flat();
    assert.equal(new Set(all).size, all.length);
    for (const line of all) {
        // Server emoji markup shows as one emoji. About two to four lines in an embed beside the King's avatar.
        const length = [...line.replace(/<a?:\w+:\d+>/gu, 'E')].length;
        assert.ok(length >= 90 && length <= 200, `${length} characters: ${line}`);
        assert.doesNotMatch(line, /[\r\n]|<@|@everyone|@here/u, line);
        assert.match(line, / (?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*|<a?:\w+:\d+>)$/u, line);
    }
});
