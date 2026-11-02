// Allows author edits during each source message's first 24 hours while protecting officer decisions.
'use strict';

const { scoutVersion } = require('./PvpScoutStore.js');

const AUTHOR_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function canAutoApplyScoutEdit(previous, proposal, { root = null, pendingEdit = null, rootEdit = null,
    now = Date.now() } = {}) {
    const before = scoutVersion(previous), after = scoutVersion(proposal);
    const protectedDecision = value => value && (value.is_deleted || scoutVersion(value).reviewedById
        || value.staffOverrides?.locked || value.staffOverrides?.hidden
        || ['confirmed', 'corrected', 'not_scout'].includes(scoutVersion(value).reviewStatus));
    if (protectedDecision(previous) || protectedDecision(root)
        || pendingEdit?.status === 'pending' || rootEdit?.status === 'pending') return false;
    if (!before.messageId || before.messageId !== after.messageId
        || !before.authorId || String(before.authorId) !== String(after.authorId || '')
        || before.channelId !== after.channelId) return false;
    if (previous.root_message_id && String(previous.root_message_id) !== before.messageId && !root) return false;
    if (root && (scoutVersion(root).channelId !== before.channelId || root.server && root.server !== before.server)) return false;
    const postedAt = before.createdAt == null ? NaN : new Date(before.createdAt).getTime();
    const editedAt = after.editedAt == null ? now : new Date(after.editedAt).getTime();
    return Number.isFinite(postedAt) && Number.isFinite(editedAt) && editedAt <= now
        && editedAt >= postedAt && editedAt - postedAt < AUTHOR_EDIT_WINDOW_MS;
}

module.exports = { AUTHOR_EDIT_WINDOW_MS, canAutoApplyScoutEdit };
