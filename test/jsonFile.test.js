'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonObject, writeTextIfChanged } = require('../utils/jsonFile.js');

test('a failed JSON snapshot write preserves the previous file and removes the partial temp file', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-json-write-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'state.json');
    const temp = `${file}.tmp`;
    fs.writeFileSync(file, 'previous');

    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (filePath, contents, ...options) => {
        if (filePath === temp) {
            originalWriteFileSync(filePath, 'partial');
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return originalWriteFileSync(filePath, contents, ...options);
    };
    try {
        assert.throws(() => writeTextIfChanged(file, temp, 'updated'), { code: 'ENOSPC' });
    } finally {
        fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(fs.readFileSync(file, 'utf8'), 'previous');
    assert.equal(fs.existsSync(temp), false);
    assert.equal(writeTextIfChanged(file, temp, 'updated'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'updated');
});

test('corrupt JSON is preserved byte for byte and reading stops', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-json-corrupt-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'state.json');
    const bytes = Buffer.from('{"pendingSyncDrawIds":["saved-draw"],\xff', 'binary');
    fs.writeFileSync(file, bytes);
    let error;
    try { readJsonObject(file); } catch (err) { error = err; }
    assert.equal(error.code, 'JSON_STORE_CORRUPT');
    assert.deepEqual(fs.readFileSync(error.preservedPath), bytes);
    assert.deepEqual(fs.readFileSync(file), bytes);
});

test('failed corrupt JSON preservation throws and leaves the original intact', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-json-preserve-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'state.json');
    fs.writeFileSync(file, '{broken');
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    try { assert.throws(() => readJsonObject(file), { code: 'ENOSPC' }); }
    finally { fs.copyFileSync = originalCopy; }
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('a valid JSON value with invalid store structure is preserved rather than accepted', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-json-shape-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'state.json');
    fs.writeFileSync(file, '[]');
    assert.throws(() => readJsonObject(file), { code: 'JSON_STORE_CORRUPT' });
    assert.equal(fs.readFileSync(file, 'utf8'), '[]');
});
