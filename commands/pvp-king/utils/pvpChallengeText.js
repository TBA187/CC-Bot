// Picks the text for accepted PvP King challenges, alternating between categories without repeating a line.
'use strict';

const crypto = require('node:crypto');
const { readJsonObject, writeJsonIfChanged } = require('../../../utils/jsonFile.js');
const BUNDLED_CATEGORIES = require('./pvpChallengeLines.json');

const STATE_VERSION = 1;
// A channel skips lines whose emoji appeared in its last few posts, unless every remaining line in the category does.
const RECENT_EMOJI_LIMIT = 6;

// Keys come from the text, so an edited line counts as new and a deleted line drops out.
function lineKey(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function endingEmoji(text) {
    return text.slice(text.lastIndexOf(' ') + 1);
}

function validCategories(categories) {
    const entries = categories && typeof categories === 'object' && !Array.isArray(categories) ? Object.entries(categories) : [];
    if (!entries.length) throw new TypeError('PvP challenge text needs at least one category.');
    const all = [];
    for (const [name, lines] of entries) {
        if (!Array.isArray(lines) || !lines.length) throw new TypeError(`PvP challenge text category "${name}" needs at least one line.`);
        if (lines.some(line => typeof line !== 'string' || !line.trim())) throw new TypeError('PvP challenge text lines must be non-empty strings.');
        all.push(...lines);
    }
    if (new Set(all).size !== all.length) throw new TypeError('PvP challenge text lines must be unique across all categories.');
    return entries;
}

function stringMap(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(entry => typeof entry === 'string');
}

function stringList(value) {
    return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function validState(value) {
    return value.version === STATE_VERSION && stringList(value.shown) && stringMap(value.last) && stringMap(value.next)
        && value.recent && typeof value.recent === 'object' && !Array.isArray(value.recent)
        && Object.values(value.recent).every(stringList);
}

class PvpChallengeText {
    constructor({ filePath, categories = BUNDLED_CATEGORIES, random = Math.random } = {}) {
        if (!filePath) throw new TypeError('PvP challenge text needs a state file path.');
        this.categories = validCategories(categories).map(([name, lines]) => ({
            name, lines: lines.map(text => ({ key: lineKey(text), text, emoji: endingEmoji(text) }))
        }));
        this.filePath = filePath;
        this.tempFilePath = `${filePath}.tmp`;
        this.random = random;
        this.state = null;
        this.saveFailing = false;
    }

    // The history is rebuildable, so an unreadable file starts a new rotation instead of blocking challenges.
    loadState() {
        if (this.state) return this.state;
        let saved = null;
        try {
            saved = readJsonObject(this.filePath, validState);
        } catch (error) {
            console.warn('[CC LOG] PvP challenge text history could not be read; a new rotation starts.',
                error.preservedPath ? `Original kept at ${error.preservedPath}.` : error.code || error.message);
        }
        this.state = { shown: saved?.shown ?? [], last: saved?.last ?? {}, next: saved?.next ?? {}, recent: saved?.recent ?? {} };
        return this.state;
    }

    // Each server steps through the categories in order; shown lines are shared, so neither channel repeats a line
    // until its whole category has been used.
    next(server = 'default') {
        const state = this.loadState();
        const index = Math.max(0, this.categories.findIndex(category => category.name === state.next[server]));
        const category = this.categories[index];
        const shown = new Set(state.shown);
        let available = category.lines.filter(line => !shown.has(line.key));
        if (!available.length) {
            for (const line of category.lines) shown.delete(line.key);
            // The line that ended a category's cycle cannot also open the next one.
            const previous = state.last[category.name];
            available = category.lines.length > 1 ? category.lines.filter(line => line.key !== previous) : category.lines;
        }
        const recent = state.recent[server] ?? [];
        const fresh = available.filter(entry => !recent.includes(entry.emoji));
        const pool = fresh.length ? fresh : available;
        const line = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
        shown.add(line.key);

        const names = new Set(this.categories.map(entry => entry.name));
        const known = new Set(this.categories.flatMap(entry => entry.lines.map(item => item.key)));
        const last = Object.fromEntries(Object.entries({ ...state.last, [category.name]: line.key })
            .filter(([name]) => names.has(name)));
        this.state = {
            shown: [...shown].filter(key => known.has(key)),
            last,
            next: { ...state.next, [server]: this.categories[(index + 1) % this.categories.length].name },
            recent: { ...state.recent, [server]: [...recent, line.emoji].slice(-RECENT_EMOJI_LIMIT) }
        };
        this.save();
        return line.text;
    }

    save() {
        try {
            writeJsonIfChanged(this.filePath, this.tempFilePath, { version: STATE_VERSION, ...this.state });
            this.saveFailing = false;
        } catch (error) {
            // A lost save can only repeat a line later; warn once until saving works again.
            if (!this.saveFailing) console.warn('[CC LOG] PvP challenge text history could not be saved:', error.code || error.message);
            this.saveFailing = true;
        }
    }
}

module.exports = { PvpChallengeText, BUNDLED_CATEGORIES };
