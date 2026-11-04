// Save source edits, moves and deletions together with their change history.
'use strict';

const { sameValue } = require('./ScoutChanges.js');

const { randomBytes } = require('node:crypto');
const { normalizeMessageRow, contentHash } = require('./PvpScoutStore.js');
const { cleanIgn, normalizeIgn, splitScoutText } = require('./PvpScoutParser.js');
const { reportVersion } = require('./ScoutReportAdminStore.js');

function snapshot(raw) {
    const row = normalizeMessageRow(raw);
    return { messageId: row.message_id, rootMessageId: row.root_message_id, sourceUrl: row.source_url,
        ign: row.opponent_ign, rating: row.rating, teamText: row.team_text, notes: row.notes,
        messageContent: row.message_content, reviewStatus: row.review_status, classification: row.classification,
        ignSource: row.ign_source, ignConfidence: Number(row.ign_confidence || 0),
        teamLayoutStatus: row.team_layout_status, attachments: row.attachments, ocrResults: row.ocrResults,
        staffOverrides: row.staffOverrides };
}

class ScoutSourceAdminStore {
    constructor(store) { this.store = store; }

    async get(messageId) {
        const source = await this.store.getMessage(messageId);
        if (!source || source.channel_id !== this.store.channelId || source.is_deleted) return null;
        const rootId = source.root_message_id || source.message_id;
        const root = rootId === source.message_id ? source : await this.store.getMessage(rootId);
        if (!root || root.is_deleted || root.channel_id !== this.store.channelId) return null;
        const sources = await this.store.sourcesForRoots([root.message_id]);
        return { root, source, sources, versions: Object.fromEntries([root, ...sources, source]
            .map(row => [row.message_id, reportVersion(row)])) };
    }

    async change(action, sourceId, reviewer, options = {}) {
        if (!['attached', 'detached', 'source_deleted', 'source_edited', 'reply_added'].includes(action)) throw new Error('Unknown source action.');
        await this.store.ensureSchema();
        const connection = await this.store.db.getConnection();
        let audit, result;
        try {
            await connection.beginTransaction();
            // Use a stable lock order for moves between reports. Scope this lock
            // to the two families; unrelated reports can still be managed.
            const [initial] = await connection.query(`SELECT * FROM pvp_scout_messages
                WHERE channel_id = ? AND message_id IN (?, ?) ORDER BY message_id`,
            [this.store.channelId, String(sourceId), String(options.targetId || sourceId)]);
            const initialSource = initial.find(row => String(row.message_id) === String(sourceId));
            const initialTarget = initial.find(row => String(row.message_id) === String(options.targetId || sourceId));
            if (!initialSource || !initialTarget) throw new Error('The source or target report does not exist in the scout archive.');
            const oldRootId = String(initialSource.root_message_id || sourceId);
            const targetId = String(initialTarget.root_message_id || initialTarget.message_id);
            const [rows] = await connection.query(`SELECT * FROM pvp_scout_messages
                WHERE channel_id = ? AND (root_message_id IN (?, ?) OR message_id IN (?, ?))
                ORDER BY message_id FOR UPDATE`, [this.store.channelId, oldRootId, targetId, String(sourceId), targetId]);
            const source = rows.find(row => String(row.message_id) === String(sourceId));
            const target = rows.find(row => String(row.message_id) === targetId);
            const oldRoot = rows.find(row => String(row.message_id) === oldRootId);
            if (!source || !oldRoot || !target || [source, oldRoot, target].some(row => normalizeMessageRow(row).is_deleted)) {
                throw new Error('The source or report is no longer available. Reopen the menu.');
            }
            if (String(source.root_message_id || sourceId) !== oldRootId || String(target.root_message_id || targetId) !== targetId) {
                throw new Error('The report grouping changed. Reopen the menu.');
            }
            const wholeFamily = String(sourceId) === oldRootId && ['attached', 'source_deleted', 'source_edited'].includes(action);
            const affected = wholeFamily ? rows.filter(row => String(row.root_message_id || row.message_id) === oldRootId && !normalizeMessageRow(row).is_deleted) : [source];
            for (const row of [...affected, target, oldRoot]) {
                if (options.versions?.[String(row.message_id)] !== reportVersion(row)) throw new Error('This report changed while the menu was open. Reopen it before saving.');
            }
            if (action === 'attached' && oldRootId === targetId) throw new Error('This source already belongs to that report.');
            if (action === 'detached' && String(sourceId) === oldRootId) throw new Error('This is already an independent report.');
            if (['attached', 'reply_added'].includes(action) && (!target.opponent_ign || target.review_status === 'not_scout'
                || !['scout', 'review'].includes(target.classification))) throw new Error('Choose a scout report with a valid opponent IGN.');
            const events = [];
            const event = async (before, after) => {
                const a = snapshot(before), next = snapshot(after);
                const movedReply = next.staffOverrides?.rootMessageId && next.staffOverrides.rootMessageId !== next.messageId;
                const b = { ...next, ...(action === 'source_edited' && !movedReply ? {} : { managementAction: action }) };
                const changes = Object.fromEntries(Object.keys(b).filter(key => !sameValue(key, a[key], b[key]))
                    .map(key => [key, { before: a[key] ?? null, after: b[key] ?? null }]));
                await connection.query(`INSERT INTO pvp_scout_review_events
                    (message_id, channel_id, action, reviewer_id, before_json, after_json, changes_json)
                    VALUES (?, ?, 'corrected', ?, ?, ?, ?)`, [b.messageId, this.store.channelId, String(reviewer),
                    JSON.stringify(a), JSON.stringify(b), JSON.stringify(changes)]);
                events.push({ messageId: b.messageId, before: a, after: b, changes });
            };
            if (action === 'reply_added') {
                const text = String(options.text || '').trim();
                if (!text || text.length > 4000) throw new Error('Enter 1–4000 characters of extra scouting information.');
                const id = `manual_${randomBytes(10).toString('hex')}`;
                const split = splitScoutText(text, target.opponent_ign);
                const overrides = { locked: true, rootMessageId: targetId, relation: 'reply', manual: true };
                await connection.query(`INSERT INTO pvp_scout_messages
                    (message_id, channel_id, server, guild_id, author_id, author_username, created_at, message_content,
                     source_url, reply_to_id, attachments_json, ocr_json, classification, opponent_ign, ign_normalized,
                     ign_confidence, ign_source, team_text, notes, root_message_id, review_status, reviewed_by_id,
                     reviewed_at, content_hash, staff_overrides_json)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?, '', ?, '[]', '[]', 'scout', ?, ?, 1,
                        'staff_supplement', ?, ?, ?, 'corrected', ?, CURRENT_TIMESTAMP(3), ?, ?)`,
                [id, this.store.channelId, this.store.server || target.server || 'gold', target.guild_id, String(reviewer), String(options.username || reviewer).slice(0, 128),
                    text, targetId, target.opponent_ign, target.ign_normalized, split.teamText || null, split.notes || null,
                    targetId, String(reviewer), contentHash({ content: text, attachments: [] }), JSON.stringify(overrides)]);
                const [created] = await connection.query('SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?', [id, this.store.channelId]);
                await event({ message_id: id, channel_id: this.store.channelId }, created[0]);
                result = { sourceId: id, rootId: targetId };
            } else {
                let ign;
                if (['detached', 'source_edited'].includes(action)) {
                    ign = cleanIgn(options.ign);
                    if (!ign) throw new Error('Enter a valid opponent IGN.');
                    if (action === 'source_edited' && !wholeFamily && normalizeIgn(ign) !== normalizeIgn(target.opponent_ign)) {
                        throw new Error('To change this reply to another opponent, make it independent or move it first.');
                    }
                    if (options.rating !== '' && options.rating != null && (!/^\d{1,4}$/u.test(String(options.rating)))) {
                        throw new Error('PvP rating must be a whole number from 0 to 9999.');
                    }
                }
                for (const before of affected) {
                    const id = String(before.message_id), normalized = normalizeMessageRow(before);
                    const overrides = { ...normalized.staffOverrides, locked: true };
                    const rootId = action === 'attached' ? targetId : action === 'detached' ? String(sourceId) : oldRootId;
                    let name = action === 'attached' ? target.opponent_ign : ign || before.opponent_ign;
                    let classification = 'scout', status = 'corrected';
                    let team = before.team_text, notes = before.notes, rating = before.rating;
                    if (action === 'source_deleted') { overrides.hidden = true; classification = 'ignored'; status = 'not_scout'; }
                    if (action === 'attached') {
                        if (!Object.hasOwn(overrides, 'unattachedIgn')) overrides.unattachedIgn = before.opponent_ign;
                        overrides.rootMessageId = rootId;
                        overrides.relation = String(before.author_id || '') === String(target.author_id || '') ? 'continuation' : 'reply';
                    }
                    if (action === 'detached') { overrides.rootMessageId = id; delete overrides.relation; }
                    if (['source_edited', 'detached'].includes(action) && id === String(sourceId)) {
                        team = String(options.teamText || '').trim() || null;
                        notes = String(options.notes || '').trim() || null;
                        rating = options.rating === '' || options.rating == null ? null : Number(options.rating);
                    }
                    // Child IGN values follow a renamed root; their own moves,
                    // notes, screenshots and source attribution stay intact.
                    await connection.query(`UPDATE pvp_scout_messages SET root_message_id = ?, classification = ?,
                        opponent_ign = ?, ign_normalized = ?, ign_confidence = 1, ign_source = 'staff_source_management',
                        rating = ?, team_text = ?, notes = ?, review_status = ?, review_reason = NULL,
                        staff_overrides_json = ?, is_deleted = ?, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                        WHERE message_id = ? AND channel_id = ?`, [rootId, classification, name, normalizeIgn(name), rating,
                        team, notes, status, JSON.stringify(overrides), action === 'source_deleted' ? 1 : 0, String(reviewer), id, this.store.channelId]);
                    await connection.query(`UPDATE pvp_scout_edit_reviews SET status = 'cancelled', reviewed_by_id = ?,
                        reviewed_at = CURRENT_TIMESTAMP(3) WHERE message_id = ? AND channel_id = ? AND status = 'pending'`,
                    [String(reviewer), id, this.store.channelId]);
                    const [updated] = await connection.query('SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?', [id, this.store.channelId]);
                    await event(before, updated[0]);
                }
                result = { sourceId: String(sourceId), rootId: action === 'attached' ? targetId : action === 'detached' ? String(sourceId) : oldRootId };
            }
            await connection.commit();
            audit = { action, actorId: String(reviewer), messageId: result.sourceId, reportId: result.rootId, sources: events };
        } catch (error) { await connection.rollback().catch(() => {}); throw error; }
        finally { connection.release(); }
        this.store.invalidateAutocompleteCache(); this.store.ignEvidenceAt = 0; this.store.reviewLearningAt = 0;
        this.store.auditLogger?.enqueue(audit, () => this.store.getReviewAlertIds(audit));
        return result;
    }
}

module.exports = { ScoutSourceAdminStore, snapshot };
