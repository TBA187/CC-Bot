// Staff report management uses the same visibility rules as /scout.
'use strict';

const { sameValue } = require('./ScoutChanges.js');

const crypto = require('node:crypto');
const { cleanIgn, normalizeIgn } = require('./PvpScoutParser.js');
const { decode, normalizeMessageRow } = require('./PvpScoutStore.js');

const PUBLIC_WHERE = `m.channel_id = ? AND m.message_id = m.root_message_id AND m.is_deleted = 0
    AND m.opponent_ign IS NOT NULL AND m.ign_normalized IS NOT NULL
    AND m.classification IN ('scout','review') AND m.review_status <> 'not_scout'
    AND NOT (COALESCE(m.ign_source, '') = 'member_submission' AND m.review_status = 'pending')`;

function visible(row) {
    return row && !row.is_deleted && row.opponent_ign && row.ign_normalized
        && ['scout', 'review'].includes(row.classification) && row.review_status !== 'not_scout'
        && !(row.ign_source === 'member_submission' && row.review_status === 'pending');
}

function snapshot(raw) {
    const row = normalizeMessageRow(raw);
    return { messageId: row.message_id, rootMessageId: row.root_message_id, sourceUrl: row.source_url, authorId: row.author_id,
        authorUsername: row.author_username, createdAt: row.created_at, messageContent: row.message_content,
        attachments: row.attachments, ocrResults: row.ocrResults, classification: row.classification,
        ign: row.opponent_ign, ignConfidence: Number(row.ign_confidence || 0), ignSource: row.ign_source,
        rating: row.rating, teamText: row.team_text, notes: row.notes, reviewStatus: row.review_status,
        reviewReason: row.review_reason, teamLayoutStatus: row.team_layout_status, staffOverrides: row.staffOverrides };
}

function reportVersion(raw) {
    const value = snapshot(raw);
    // Signed attachment URL renewals do not invalidate an open editor.
    value.attachments = (value.attachments || []).map(item => ({ id: item.id, name: item.name,
        contentType: item.contentType, size: item.size, width: item.width, height: item.height }));
    delete value.ocrResults;
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function searchFilter(query) {
    const raw = String(query || '').trim().slice(0, 200);
    if (!raw) return { sql: '', params: [] };
    const value = raw.match(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/(\d+)$/u)?.[1] || raw;
    const pattern = `%${value.replace(/[!%_]/gu, '!$&')}%`;
    return {
        sql: ` AND (m.opponent_ign LIKE ? ESCAPE '!' OR m.message_id = ? OR EXISTS (
            SELECT 1 FROM pvp_scout_messages s
            WHERE s.channel_id = m.channel_id AND s.root_message_id = m.message_id AND s.is_deleted = 0
            AND (s.message_id = ? OR s.author_id = ? OR s.author_username LIKE ? ESCAPE '!'
                OR s.message_content LIKE ? ESCAPE '!' OR s.team_text LIKE ? ESCAPE '!' OR s.notes LIKE ? ESCAPE '!'
                OR s.staff_overrides_json LIKE ? ESCAPE '!')))` ,
        params: [pattern, value, value, value.replace(/^<@!?(\d+)>$/u, '$1'), pattern, pattern, pattern, pattern, pattern]
    };
}

class ScoutReportAdminStore {
    constructor(store) { this.store = store; }

    async list(query = '', limit = 25, offset = 0, { includeTotal = true } = {}) {
        await this.store.ensureSchema();
        const filter = searchFilter(query);
        const where = PUBLIC_WHERE + filter.sql;
        const params = [this.store.channelId, ...filter.params];
        const [[counts], [rows]] = await Promise.all([
            includeTotal
                ? this.store.db.query(`SELECT COUNT(*) AS total FROM pvp_scout_messages m WHERE ${where}`, params)
                : Promise.resolve([[]]),
            this.store.db.query(`SELECT m.message_id, m.root_message_id, m.channel_id, m.opponent_ign,
                m.ign_normalized, m.classification, m.review_status, m.author_id, m.author_username,
                m.created_at, m.source_url, m.staff_overrides_json
                FROM pvp_scout_messages m WHERE ${where}
                ORDER BY m.created_at DESC, m.message_id DESC LIMIT ? OFFSET ?`,
            [...params, Math.min(25, Math.max(1, limit)), Math.max(0, offset)])
        ]);
        return { total: includeTotal ? Number(counts[0]?.total || 0) : null, rows: rows.map(normalizeMessageRow) };
    }

    async get(reportId) {
        const root = await this.store.getMessage(reportId);
        if (!root || root.channel_id !== this.store.channelId || root.message_id !== root.root_message_id || !visible(root)) return null;
        const sources = (await this.store.sourcesForRoots([root.message_id])).filter(row => !row.is_deleted && row.review_status !== 'not_scout');
        return { root, sources: sources.length ? sources : [root] };
    }

    async event(connection, before, after, reviewer, action) {
        const previous = snapshot(before), next = snapshot(after);
        const changes = Object.fromEntries(Object.keys(next).filter(key => !sameValue(key, previous[key], next[key]))
            .map(key => [key, { before: previous[key], after: next[key] }]));
        await connection.query(`INSERT INTO pvp_scout_review_events
            (message_id, channel_id, action, reviewer_id, before_json, after_json, changes_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [String(before.message_id), this.store.channelId, action,
            String(reviewer), JSON.stringify(previous), JSON.stringify(next), JSON.stringify(changes)]);
        return { messageId: String(before.message_id), before: previous, after: next, changes };
    }

    async change(reportId, sourceId, reviewer, patch, expectedVersions, deleting = false) {
        await this.store.ensureSchema();
        const connection = await this.store.db.getConnection();
        let affected = [];
        const events = [];
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query(`SELECT * FROM pvp_scout_messages
                WHERE channel_id = ? AND root_message_id = ? AND is_deleted = 0
                ORDER BY message_id FOR UPDATE`, [this.store.channelId, String(reportId)]);
            const root = rows.find(row => String(row.message_id) === String(reportId));
            const source = rows.find(row => String(row.message_id) === String(sourceId));
            if (!visible(root) || !source || source.review_status === 'not_scout') throw new Error('This report is no longer available. Reload Scout Reports.');
            const versionsToCheck = (deleting ? rows : [source, ...(source === root ? rows.filter(row => row !== root) : [])])
                .filter(row => row.review_status !== 'not_scout');
            for (const row of versionsToCheck) {
                if (!expectedVersions?.[String(row.message_id)] || expectedVersions[String(row.message_id)] !== reportVersion(row)) {
                    throw new Error('This report changed while your form was open. Reload it before saving.');
                }
            }
            if (deleting) {
                affected = rows;
                for (const row of rows) {
                    const overrides = { ...decode(row.staff_overrides_json, {}), hidden: true, locked: true };
                    await connection.query(`UPDATE pvp_scout_messages SET is_deleted = 1, classification = 'ignored',
                        review_status = 'not_scout', review_reason = NULL, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3),
                        staff_overrides_json = ? WHERE message_id = ? AND channel_id = ?`,
                    [String(reviewer), JSON.stringify(overrides), String(row.message_id), this.store.channelId]);
                }
            } else if (patch.details) {
                const ign = cleanIgn(patch.details.ign);
                if (!ign) throw new Error('Enter a valid opponent IGN (2–32 letters, numbers, underscores, dots or hyphens).');
                if (source !== root && normalizeIgn(ign) !== normalizeIgn(root.opponent_ign)) {
                    throw new Error('To change the report opponent, select the original source first.');
                }
                const rating = patch.details.rating === '' || patch.details.rating === null ? null : Number(patch.details.rating);
                if (rating !== null && (!Number.isInteger(rating) || rating < 0 || rating > 65535)) throw new Error('PvP rating must be a whole number from 0 to 65535, or blank.');
                await connection.query(`UPDATE pvp_scout_messages SET opponent_ign = ?, ign_normalized = ?, rating = ?,
                    team_text = ?, notes = ?, classification = 'scout', review_status = 'corrected', review_reason = NULL,
                    ign_confidence = 1, ign_source = 'human_corrected', reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3),
                    staff_overrides_json = ?
                    WHERE message_id = ? AND channel_id = ?`, [ign, normalizeIgn(ign), rating, patch.details.teamText || null,
                    patch.details.notes || null, String(reviewer), JSON.stringify({ ...decode(source.staff_overrides_json, {}), locked: true }), String(sourceId), this.store.channelId]);
                affected = [source];
                if (source === root && normalizeIgn(root.opponent_ign) !== normalizeIgn(ign)) {
                    for (const row of rows.filter(row => row !== root && row.ign_normalized === root.ign_normalized && row.review_status !== 'not_scout')) {
                        await connection.query(`UPDATE pvp_scout_messages SET opponent_ign = ?, ign_normalized = ?,
                            review_status = 'corrected', review_reason = NULL, ign_source = 'human_corrected',
                            ign_confidence = 1, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3), staff_overrides_json = ?
                            WHERE message_id = ? AND channel_id = ?`, [ign, normalizeIgn(ign), String(reviewer),
                        JSON.stringify({ ...decode(row.staff_overrides_json, {}), locked: true }), String(row.message_id), this.store.channelId]);
                        affected.push(row);
                    }
                }
            } else {
                const allowed = ['source_url', 'message_content', 'attachments'];
                if (!patch.overrides || Object.keys(patch.overrides).some(key => !allowed.includes(key))) throw new Error('Unsupported source change.');
                const overrides = { ...decode(source.staff_overrides_json, {}), ...patch.overrides, locked: true };
                await connection.query(`UPDATE pvp_scout_messages SET staff_overrides_json = ?,
                    review_status = 'corrected', review_reason = NULL, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                    WHERE message_id = ? AND channel_id = ?`, [JSON.stringify(overrides), String(reviewer), String(sourceId), this.store.channelId]);
                affected = [source];
            }
            for (const before of affected) {
                const [updated] = await connection.query('SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?',
                    [String(before.message_id), this.store.channelId]);
                events.push(await this.event(connection, before, updated[0], reviewer, deleting ? 'not_scout' : 'corrected'));
                await connection.query(`UPDATE pvp_scout_edit_reviews SET status = 'cancelled', reviewed_by_id = ?,
                    reviewed_at = CURRENT_TIMESTAMP(3) WHERE message_id = ? AND channel_id = ? AND status = 'pending'`,
                [String(reviewer), String(before.message_id), this.store.channelId]);
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally { connection.release(); }
        const audit = { action: deleting ? 'deleted' : 'edited', actorId: String(reviewer),
            reportId: String(reportId), messageId: String(sourceId), sources: events };
        this.store.auditLogger?.enqueue(audit, () => this.store.getReviewAlertIds(audit));
        this.store.invalidateAutocompleteCache();
        this.store.ignEvidenceAt = 0;
        this.store.reviewLearningAt = 0;
        // Explicit admin changes must reach the suggestion cache as well.
        void this.store.autocomplete('', this.store.channelId, true).catch(() => {});
        return deleting ? null : this.get(reportId);
    }
}

module.exports = { ScoutReportAdminStore, reportVersion, visible, searchFilter, PUBLIC_WHERE };
