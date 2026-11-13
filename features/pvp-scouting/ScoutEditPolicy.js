// Applies an author's own edits automatically: any correction during the first 48 hours, small
// updates afterwards, and additions to officer-reviewed reports. Only obvious spam, large late
// rewrites and reports an officer locked, hid or declined wait for review.
'use strict';

const { diffChars } = require('diff');
const { scoutVersion } = require('./PvpScoutStore.js');
const { closeIgnSpelling, extractScoutData, hasImageEvidence, isClearlyOffTopicText, isClearlySpamTeam,
    normalizeIgn } = require('./PvpScoutParser.js');
const { teamLineSpecies } = require('./PokemonTeamParser.js');

const AUTHOR_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
// Discord stamps posts and edits with its own clock. The host clock may lag or lead it,
// so a timestamp slightly ahead of the host is still a genuine edit.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
// After the edit window, an update is small when it changes at most this many characters,
// and no more than half of a longer message.
const SMALL_EDIT_MAX_CHARS = 120;
const SMALL_EDIT_FREE_CHARS = 40;

function archivedSource(previous) {
    const version = scoutVersion(previous);
    return { content: String(previous.archive_message_content ?? version.content),
        attachments: previous.archive_attachments ?? version.attachments, ocrResults: version.ocrResults };
}

// Parses the saved and edited message the same way, without archive history or officer
// learning, so the difference shows only what the author changed.
function comparisonParse(previous, proposal) {
    const parse = value => extractScoutData({ content: value.content, attachments: value.attachments },
        { ocrResults: value.ocrResults });
    return { before: parse(archivedSource(previous)), after: parse(scoutVersion(proposal)) };
}

function hasOfficerDecision(row) {
    const version = scoutVersion(row);
    return Boolean(version.reviewedById) || ['confirmed', 'corrected'].includes(version.reviewStatus);
}

function isSmallEdit(previous, proposal, comparison = comparisonParse(previous, proposal)) {
    const before = archivedSource(previous), after = scoutVersion(proposal);
    const changed = diffChars(before.content, after.content)
        .reduce((total, part) => total + (part.added || part.removed ? part.value.length : 0), 0);
    if (changed > SMALL_EDIT_MAX_CHARS || changed > Math.max(SMALL_EDIT_FREE_CHARS, before.content.length / 2)) return false;
    const ids = list => (Array.isArray(list) ? list : []).map(item => String(item.id || ''));
    const editedIds = ids(after.attachments);
    if (!ids(before.attachments).every(id => editedIds.includes(id))) return false;
    // A small update keeps the opponent, apart from a spelling fix.
    const oldIgn = normalizeIgn(comparison.before.ign), newIgn = normalizeIgn(comparison.after.ign);
    return oldIgn === newIgn || Boolean(oldIgn && newIgn && closeIgnSpelling(oldIgn, newIgn));
}

function canAutoApplyScoutEdit(previous, proposal, { root = null, pendingEdit = null, rootEdit = null,
    now = Date.now(), comparison = null } = {}) {
    const before = scoutVersion(previous), after = scoutVersion(proposal);
    // Confirmed and corrected reports stay editable by their author; mergeReviewedEdit keeps the officer's values.
    const protectedDecision = value => value && (value.is_deleted || value.staffOverrides?.locked
        || value.staffOverrides?.hidden || scoutVersion(value).reviewStatus === 'not_scout');
    if (protectedDecision(previous) || protectedDecision(root)
        || pendingEdit?.status === 'pending' || rootEdit?.status === 'pending') return false;
    if (!before.messageId || before.messageId !== after.messageId
        || !before.authorId || String(before.authorId) !== String(after.authorId || '')
        || before.channelId !== after.channelId) return false;
    if (previous.root_message_id && String(previous.root_message_id) !== before.messageId && !root) return false;
    if (root && (scoutVersion(root).channelId !== before.channelId || root.server && root.server !== before.server)) return false;
    const postedAt = before.createdAt == null ? NaN : new Date(before.createdAt).getTime();
    const latestAllowed = now + CLOCK_SKEW_TOLERANCE_MS;
    const editedAt = after.editedAt == null ? Math.max(now, postedAt) : new Date(after.editedAt).getTime();
    if (!Number.isFinite(postedAt) || !Number.isFinite(editedAt) || postedAt > latestAllowed
        || editedAt > latestAllowed || editedAt < postedAt) return false;
    return editedAt - postedAt < AUTHOR_EDIT_WINDOW_MS || isSmallEdit(previous, proposal, comparison || undefined);
}

function speciesCount(teamText) {
    return new Set(String(teamText || '').split('\n').map(teamLineSpecies).filter(Boolean)).size;
}

// Returns why an otherwise allowed edit must wait for an officer, or null. Changes to the
// opponent, rating, team, notes or screenshots are ordinary corrections; only an edit that
// replaces published scout details with off-topic text, or removes them entirely, is held.
function spamEditReason(previous, proposal) {
    const before = scoutVersion(previous), after = scoutVersion(proposal);
    const beforeSpecies = speciesCount(before.teamText);
    // An unpublished or failed report has nothing to vandalise; its author is still fixing it.
    if (before.reviewStatus === 'pending' || !before.ign && !beforeSpecies) return null;
    const afterSpecies = speciesCount(after.teamText);
    const text = after.content.trim();
    if (!after.ign && !afterSpecies && text && (isClearlyOffTopicText(text) || isClearlySpamTeam(text))) {
        return 'Spam safeguard: the edit replaced the scout details with off-topic text.';
    }
    if (before.ign && !after.ign && !afterSpecies && !hasImageEvidence(after.attachments)) {
        return 'Spam safeguard: the edit removed the opponent and every Pokémon from a published scout report.';
    }
    return null;
}

// An author's edit to an officer-reviewed report replaces only the details the edit changed.
// Values the edit left alone keep what the officer confirmed or corrected, and the officer's
// decision stands while the opponent stays the same.
function mergeReviewedEdit(saved, proposal, comparison = comparisonParse(saved, proposal)) {
    const current = scoutVersion(saved), { before, after } = comparison;
    const merged = { ...proposal };
    const sameOpponent = normalizeIgn(before.ign) === normalizeIgn(after.ign);
    if (sameOpponent) {
        Object.assign(merged, { classification: current.classification, ign: current.ign, ignNormalized: current.ignNormalized,
            ignConfidence: current.ignConfidence, ignSource: current.ignSource });
    }
    if ((before.rating ?? null) === (after.rating ?? null)) merged.rating = current.rating;
    if (String(before.teamText || '') === String(after.teamText || '')) merged.teamText = current.teamText;
    if (String(before.notes || '') === String(after.notes || '')) merged.notes = current.notes;
    if (sameOpponent && ['confirmed', 'corrected'].includes(current.reviewStatus)) {
        Object.assign(merged, { reviewStatus: current.reviewStatus, reviewReason: current.reviewReason,
            preserveReviewDecision: true });
    }
    return merged;
}

module.exports = { AUTHOR_EDIT_WINDOW_MS, CLOCK_SKEW_TOLERANCE_MS, canAutoApplyScoutEdit,
    comparisonParse, hasOfficerDecision, isSmallEdit, mergeReviewedEdit, spamEditReason };
