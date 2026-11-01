/**
 * @fileoverview Format UTC log timestamps and normalize bot prefixes.
 * Keep useful component labels and message contents intact across console and file output.
 */
'use strict';

function formatTimestamp(date = new Date()) {
    return '[' + date.toISOString().slice(0, 19).replace('T', ' ') + ']';
}

// Keep component labels and quoted message contents; remove only a line's bot tag.
function stripBotLogPrefix(text) {
    return String(text).replace(/^\[(?:CC|WW) LOG\] ?/gmu, '');
}

module.exports = { formatTimestamp, stripBotLogPrefix };
