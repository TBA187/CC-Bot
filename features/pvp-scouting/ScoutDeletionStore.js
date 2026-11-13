// Durable records of member-deleted scout messages and the officer decision on each.
'use strict';

const { cleanIgn, hasImageEvidence, normalizeIgn, splitScoutSections } = require('./PvpScoutParser.js');
const { decode, normalizeMessageRow } = require('./PvpScoutStore.js');
const { visible } = require('./ScoutReportAdminStore.js');

function staleDeletion(message = 'This deleted scout report was already handled. The message above shows the current decision.') {
    return Object.assign(new Error(message), { code: 'SCOUT_DELETION_STALE' });
}

function normalizeDeletion(row) {
    if (!row) return null;
    return { ...row, message_id: String(row.message_id), channel_id: String(row.channel_id),
        report_id: String(row.report_id), images: decode(row.images_json, []) || [] };
}

function auditSnapshot(raw) {
    const row = normalizeMessageRow(raw);
    return { messageId: row.message_id, sourceUrl: row.source_url, authorId: row.author_id, authorUsername: row.author_username,
        createdAt: row.created_at, messageContent: row.message_content, attachments: row.attachments,
        ign: row.opponent_ign, rating: row.rating, teamText: row.team_text, notes: row.notes };
}

class ScoutDeletionStore {
    constructor(store) { this.store = store; }

    get enabled() { return typeof this.store?.db?.query === 'function' && typeof this.store.getMessage === 'function'; }

    async get(messageId) {
        await this.store.ensureSchema();
        const [rows] = await this.store.db.query(
            'SELECT * FROM pvp_scout_deletions WHERE message_id = ? AND channel_id = ? LIMIT 1',
            [String(messageId), this.store.channelId]);
        return normalizeDeletion(rows[0]);
    }

    // Records a deletion before the archive row is marked deleted. Returns null for messages
    // that were not part of a report shown in /scout: chatter, declined and unnamed reports.
    async capture(messageId) {
        const row = await this.store.getMessage(messageId);
        if (!row || row.is_deleted || row.review_status === 'not_scout') return null;
        const reportId = String(row.root_message_id || row.message_id);
        const isRoot = reportId === String(row.message_id);
        const root = isRoot ? row : await this.store.getMessage(reportId);
        if (!visible(root)) return null;
        if (!isRoot && !['scout', 'review'].includes(row.classification)
            && !String(row.team_text || '').trim() && !hasImageEvidence(row.attachments)) return null;
        await this.store.db.query(`
            INSERT IGNORE INTO pvp_scout_deletions (message_id, channel_id, report_id, previous_status, restore_status)
            VALUES (?, ?, ?, ?, ?)
        `, [String(row.message_id), this.store.channelId, reportId, row.review_status, row.review_status]);
        return { row, root };
    }

    async pendingAlerts() {
        await this.store.ensureSchema();
        const [rows] = await this.store.db.query(`
            SELECT * FROM pvp_scout_deletions
            WHERE channel_id = ? AND status = 'pending' AND alert_message_id IS NULL ORDER BY created_at ASC
        `, [this.store.channelId]);
        return rows.map(normalizeDeletion);
    }

    // The alert message holds copies of the screenshots, because Discord removes the files of a deleted message.
    async saveAlert(messageId, { alertChannelId, alertMessageId, deletedById = null, images = [] }) {
        const id = String(messageId);
        await this.store.db.query(`
            UPDATE pvp_scout_deletions
            SET alert_channel_id = ?, alert_message_id = ?, deleted_by_id = COALESCE(?, deleted_by_id), images_json = ?
            WHERE message_id = ? AND channel_id = ?
        `, [String(alertChannelId), String(alertMessageId), deletedById ? String(deletedById) : null,
            JSON.stringify(images), id, this.store.channelId]);
        if (images.length) await this.mergeOverrides(this.store.db, id, { attachments: images });
    }

    async mergeOverrides(connection, messageId, patch) {
        const [rows] = await connection.query(
            'SELECT staff_overrides_json FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?',
            [String(messageId), this.store.channelId]);
        if (!rows[0]) return;
        await connection.query('UPDATE pvp_scout_messages SET staff_overrides_json = ? WHERE message_id = ? AND channel_id = ?',
            [JSON.stringify({ ...decode(rows[0].staff_overrides_json, {}), ...patch }), String(messageId), this.store.channelId]);
    }

    // The saved record with the values it would have in /scout if an officer keeps it.
    async context(messageId) {
        const deletion = await this.get(messageId);
        const row = deletion && await this.store.getMessage(messageId);
        if (!deletion || !row) return null;
        const reportRoot = deletion.report_id === row.message_id ? null : await this.store.getMessage(deletion.report_id);
        const decided = ['kept', 'reposted'].includes(deletion.status);
        // The first report of a multi-report message is shown and reposted without the other reports' text.
        const ownText = Object.hasOwn(row.staffOverrides || {}, 'message_content') ? null
            : splitScoutSections(row.archive_message_content)?.[0];
        const view = { ...row, ...(ownText ? { message_content: ownText } : {}), is_deleted: false, root_message_id: row.message_id,
            review_status: decided ? row.review_status : deletion.restore_status,
            opponent_ign: row.opponent_ign || reportRoot?.opponent_ign || null,
            ign_normalized: row.ign_normalized || reportRoot?.ign_normalized || null };
        return { deletion, row, view, reportRoot };
    }

    // Officer edits made before a decision are saved on the deleted record and published when it is kept.
    async edit(messageId, reviewerId, patch) {
        await this.store.ensureSchema();
        const id = String(messageId), reviewer = String(reviewerId);
        const connection = await this.store.db.getConnection();
        let before, after;
        try {
            await connection.beginTransaction();
            const [deletions] = await connection.query(
                'SELECT * FROM pvp_scout_deletions WHERE message_id = ? AND channel_id = ? FOR UPDATE', [id, this.store.channelId]);
            if (deletions[0]?.status !== 'pending') throw staleDeletion();
            const [rows] = await connection.query(
                'SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ? FOR UPDATE', [id, this.store.channelId]);
            before = rows[0];
            if (!before) throw staleDeletion('This scout message is no longer in the archive.');
            const overrides = decode(before.staff_overrides_json, {});
            if (patch.details) {
                const ign = cleanIgn(patch.details.ign);
                if (!ign) throw new Error('Enter a valid opponent IGN (2–32 letters, numbers, underscores, dots or hyphens).');
                const rating = patch.details.rating === '' || patch.details.rating == null ? null : Number(patch.details.rating);
                if (rating !== null && (!Number.isInteger(rating) || rating < 0 || rating > 65535)) {
                    throw new Error('PvP rating must be a whole number from 0 to 65535, or blank.');
                }
                await connection.query(`
                    UPDATE pvp_scout_messages SET opponent_ign = ?, ign_normalized = ?, rating = ?, team_text = ?, notes = ?,
                        classification = 'scout', ign_confidence = 1, ign_source = 'human_corrected', review_reason = NULL,
                        reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3), staff_overrides_json = ?
                    WHERE message_id = ? AND channel_id = ?
                `, [ign, normalizeIgn(ign), rating, patch.details.teamText || null, patch.details.notes || null, reviewer,
                    JSON.stringify({ ...overrides, locked: true }), id, this.store.channelId]);
            } else {
                const allowed = ['message_content', 'attachments'];
                if (!patch.overrides || Object.keys(patch.overrides).some(key => !allowed.includes(key))) throw new Error('Unsupported source change.');
                await connection.query(`
                    UPDATE pvp_scout_messages SET staff_overrides_json = ?, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                    WHERE message_id = ? AND channel_id = ?
                `, [JSON.stringify({ ...overrides, ...patch.overrides, locked: true }), reviewer, id, this.store.channelId]);
            }
            await connection.query(`UPDATE pvp_scout_deletions SET restore_status = 'corrected'
                WHERE message_id = ? AND channel_id = ?`, [id, this.store.channelId]);
            const [updated] = await connection.query(
                'SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?', [id, this.store.channelId]);
            after = updated[0];
            await connection.commit();
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally { connection.release(); }
        const audit = { action: 'edited', actorId: reviewer, reportId: String(before.root_message_id || id), messageId: id,
            sources: [{ messageId: id, before: auditSnapshot(before), after: auditSnapshot(after) }] };
        this.store.auditLogger?.enqueue(audit);
        return this.context(id);
    }

    // Applies Keep or Remove once. A repeated click returns the saved decision unchanged.
    async decide(messageId, reviewerId, keep) {
        await this.store.ensureSchema();
        const id = String(messageId), reviewer = String(reviewerId);
        const connection = await this.store.db.getConnection();
        let changed = false;
        try {
            await connection.beginTransaction();
            const [deletions] = await connection.query(
                'SELECT * FROM pvp_scout_deletions WHERE message_id = ? AND channel_id = ? FOR UPDATE', [id, this.store.channelId]);
            const deletion = deletions[0];
            if (!deletion) throw staleDeletion('This deleted scout report is no longer recorded.');
            if (deletion.status === 'pending') {
                if (keep) {
                    const [rows] = await connection.query(
                        'SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ? FOR UPDATE', [id, this.store.channelId]);
                    const row = rows[0];
                    if (!row) throw staleDeletion('This scout message is no longer in the archive.');
                    // Keeping a report whose opponent still awaited review is the officer's confirmation of it.
                    const confirms = deletion.restore_status === 'pending' && row.opponent_ign;
                    if (confirms) {
                        await connection.query(`
                            UPDATE pvp_scout_messages SET is_deleted = 0, review_status = 'confirmed', review_reason = NULL,
                                ign_source = 'human_confirmed', reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                            WHERE message_id = ? AND channel_id = ?
                        `, [reviewer, id, this.store.channelId]);
                    } else {
                        await connection.query(`
                            UPDATE pvp_scout_messages SET is_deleted = 0, review_status = ?
                            WHERE message_id = ? AND channel_id = ?
                        `, [deletion.restore_status, id, this.store.channelId]);
                    }
                }
                // Stored as a UTC instant from the bot, like the archive's other Discord times.
                await connection.query(`
                    UPDATE pvp_scout_deletions SET status = ?, decided_by_id = ?, decided_at = ?
                    WHERE message_id = ? AND channel_id = ?
                `, [keep ? 'kept' : 'removed', reviewer, new Date(), id, this.store.channelId]);
                changed = true;
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally { connection.release(); }
        if (changed && keep) this.invalidate();
        return { changed, context: await this.context(id) };
    }

    // The bot's copy in the scouting channel becomes the report's source link and screenshot host.
    async markReposted(messageId, repost) {
        const id = String(messageId);
        const [result] = await this.store.db.query(`
            UPDATE pvp_scout_deletions SET status = 'reposted', repost_message_id = ?
            WHERE message_id = ? AND channel_id = ? AND status = 'kept' AND repost_message_id IS NULL
        `, [String(repost.id), id, this.store.channelId]);
        if (Number(result.affectedRows || 0) !== 1) return false;
        await this.mergeOverrides(this.store.db, id, { source_url: String(repost.url),
            ...(repost.attachments?.length ? { attachments: repost.attachments } : {}) });
        this.invalidate();
        return true;
    }

    async isKept(messageId) {
        if (!this.enabled) return false;
        return ['kept', 'reposted'].includes((await this.get(messageId))?.status);
    }

    invalidate() {
        this.store.invalidateAutocompleteCache?.();
        this.store.ignEvidenceAt = 0;
        this.store.reviewLearningAt = 0;
        void this.store.autocomplete?.('', this.store.channelId, true).catch(() => {});
    }
}

module.exports = { ScoutDeletionStore };
