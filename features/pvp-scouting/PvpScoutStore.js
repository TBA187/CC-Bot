// Database access for archived messages, scout groups, catch-up checkpoints, and staff corrections.
'use strict';

const { sameValue } = require('./ScoutChanges.js');

const crypto = require('crypto');
const fs = require('node:fs');
const { setImmediate: yieldToEvents } = require('node:timers/promises');
const { writeJsonIfChanged } = require('../../utils/jsonFile.js');
const { ensureScoutTables } = require('./ScoutSchema.js');
const { candidateFromText, extractScoutData, hasImageEvidence, IGN_DISPLAY_NAMES, nameFromResultLine, normalizeIgn } = require('./PvpScoutParser.js');
const { buildReviewLearning } = require('./ScoutReviewLearning.js');
const { reportContextSpecies, splitScoutText } = require('./PokemonTeamParser.js');

const MISSING_TEAM_REASON = 'The scout report names an opponent but contains no Pokémon team information or screenshot.';
const REOPEN_RESOLVED_CORRECTION_WINDOW = `ON DUPLICATE KEY UPDATE
    started_at_ms = IF(status = 'resolved', NULL, started_at_ms),
    due_at_ms = IF(status = 'resolved', NULL, due_at_ms),
    status = IF(status = 'resolved', 'waiting', status)`;

function publicLookupWhere(ignNormalized) {
    return `root.channel_id = ? ${ignNormalized === null ? "AND COALESCE(root.ign_normalized, '') <> ''" : 'AND root.ign_normalized = ?'}
        AND root.message_id = root.root_message_id AND root.is_deleted = 0
        AND root.classification IN ('scout','review')
        AND root.review_status <> 'not_scout'
        AND NOT (COALESCE(root.ign_source, '') = 'member_submission' AND root.review_status = 'pending')`;
}

// A grouped nameless text follow-up is reviewed together with its root.
// This also applies when the combined report still needs an opponent name.
// Reports inside an open author correction window stay in the queue so an officer can decide early.
const PENDING_REVIEW_WHERE = `
    m.channel_id = ? AND m.review_status = 'pending' AND m.is_deleted = 0
    AND NOT (
        m.root_message_id IS NOT NULL AND m.message_id <> m.root_message_id
        AND m.opponent_ign IS NULL
        AND COALESCE(m.review_reason, '') IN (
            'Could not identify the opponent IGN in the message or screenshot.',
            'Message looks like scouting information but the opponent IGN is unclear.'
        )
        AND JSON_LENGTH(m.attachments_json) = 0
        AND EXISTS (
            SELECT 1 FROM pvp_scout_messages root
            WHERE root.message_id = m.root_message_id AND root.channel_id = m.channel_id
              AND root.is_deleted = 0 AND root.classification IN ('scout','review')
        )
    )
`;

// A message that holds several reports keeps the first on its own row; each further report is saved
// as "<messageId>_<n>". This returns the Discord message a row belongs to.
function discordMessageId(id) {
    const value = String(id || '');
    return value.match(/^(\d+)_\d+$/u)?.[1] || value;
}

function json(value, fallback) {
    try {
        return JSON.stringify(value ?? fallback);
    } catch {
        return JSON.stringify(fallback);
    }
}

function decode(value, fallback) {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value;
    try {
        return JSON.parse(value || '');
    } catch {
        return fallback;
    }
}

function sourceFingerprint(content, attachments) {
    // Discord can renew attachment URLs. The attachment ID and file details are
    // stable, while a fresh OCR pass should never invalidate a staff decision.
    const files = (Array.isArray(attachments) ? attachments : []).map(item => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        size: Number(item.size || 0),
        width: Number(item.width || 0),
        height: Number(item.height || 0)
    }));
    return `${String(content || '')}\n${json(files, [])}`;
}

function contentHash(record) {
    return crypto.createHash('sha256').update(
        sourceFingerprint(record.content, record.attachments)
    ).digest('hex');
}

function scoutVersion(value = {}) {
    const messageContent = value.message_content ?? value.content ?? '';
    const attachments = value.attachments ?? decode(value.attachments_json, []);
    const ocrResults = value.ocrResults ?? decode(value.ocr_json, []);
    return {
        messageId: String(value.message_id || value.messageId || ''),
        channelId: String(value.channel_id || value.channelId || ''),
        server: value.server || 'gold',
        guildId: value.guild_id || value.guildId || null,
        authorId: value.author_id || value.authorId || null,
        authorUsername: value.author_username || value.authorUsername || null,
        createdAt: value.created_at || value.createdAt || null,
        editedAt: value.edited_at || value.editedAt || null,
        content: String(messageContent || ''),
        sourceUrl: value.source_url || value.sourceUrl || '',
        replyToId: value.reply_to_id || value.replyToId || null,
        attachments,
        ocrResults,
        classification: value.classification || 'ignored',
        ign: value.opponent_ign || value.ign || null,
        ignNormalized: value.ign_normalized || value.ignNormalized || null,
        ignConfidence: Number(value.ign_confidence ?? value.ignConfidence ?? 0),
        ignSource: value.ign_source || value.ignSource || null,
        rating: value.rating === null || value.rating === undefined ? null : Number(value.rating),
        teamText: value.team_text ?? value.teamText ?? null,
        notes: value.notes || null,
        reviewStatus: value.review_status || value.reviewStatus || 'not_required',
        reviewReason: value.review_reason || value.reviewReason || null,
        reviewedById: value.reviewed_by_id || value.reviewedById || null,
        reviewedAt: value.reviewed_at || value.reviewedAt || null,
        teamLayoutStatus: value.team_layout_status || value.teamLayoutStatus || 'none',
        contentHash: value.content_hash || contentHash({ content: messageContent, attachments })
    };
}

function normalizeMessageRow(row = {}) {
    const overrides = decode(row.staff_overrides_json ?? row.staffOverrides, {});
    const normalized = {
        ...row,
        message_id: String(row.message_id || ''),
        channel_id: String(row.channel_id || ''),
        server: row.server || 'gold',
        root_message_id: row.root_message_id ? String(row.root_message_id) : null,
        attachments: row.attachments ?? decode(row.attachments_json, []),
        ocrResults: row.ocrResults ?? decode(row.ocr_json, []),
        is_deleted: Number(row.is_deleted) === 1,
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        pending_edit: Number(row.pending_edit) === 1,
        edit_before: decode(row.edit_before_json, null),
        edit_after: decode(row.edit_after_json, null),
        edit_revision: row.edit_revision === null || row.edit_revision === undefined
            ? null : Number(row.edit_revision),
        staffOverrides: overrides,
        archive_message_content: row.archive_message_content ?? row.message_content,
        archive_attachments: row.archive_attachments ?? row.attachments ?? decode(row.attachments_json, [])
    };
    for (const field of ['source_url', 'message_content', 'attachments']) {
        if (Object.hasOwn(overrides, field)) normalized[field] = overrides[field];
    }
    if (overrides.hidden) normalized.is_deleted = true;
    return normalized;
}

function reviewSnapshot(row) {
    row = normalizeMessageRow(row);
    return {
        messageId: String(row.message_id), sourceUrl: row.source_url,
        authorId: row.author_id, authorUsername: row.author_username,
        createdAt: row.created_at, messageContent: row.message_content,
        attachments: row.attachments,
        ocrResults: decode(row.ocr_json, []).map(item => ({
            text: item.text, focusedIgn: item.focusedIgn, focusedSource: item.focusedSource,
            focusedConfidence: item.focusedConfidence, teamLayoutStatus: item.teamLayoutStatus
        })),
        classification: row.classification, ign: row.opponent_ign,
        ignConfidence: Number(row.ign_confidence || 0), ignSource: row.ign_source,
        rating: row.rating === null ? null : Number(row.rating),
        teamText: row.team_text, notes: row.notes,
        reviewStatus: row.review_status, reviewReason: row.review_reason,
        teamLayoutStatus: row.team_layout_status,
        staffOverrides: row.staffOverrides
    };
}

function reviewScope(channelId) {
    const params = Array.isArray(channelId) ? channelId.map(String) : [String(channelId)];
    if (!params.length) throw new Error('No scouting channels are configured.');
    const clause = params.length === 1 ? 'm.channel_id = ?' : `m.channel_id IN (${params.map(() => '?').join(', ')})`;
    return { params, clause, pending: PENDING_REVIEW_WHERE.replace('m.channel_id = ?', clause) };
}

// Both halves of the review queue select the same columns: pending member edits first,
// then pending reports with the state of the author's correction window.
function reviewQueueSql(scope) {
    return `
        SELECT m.*, e.before_json AS edit_before_json, e.after_json AS edit_after_json,
               e.revision AS edit_revision, 1 AS pending_edit,
               0 AS correction_open, NULL AS correction_due_at_ms
        FROM pvp_scout_messages m
        INNER JOIN pvp_scout_edit_reviews e
            ON e.message_id = m.message_id AND e.channel_id = m.channel_id AND e.status = 'pending'
        WHERE ${scope.clause} AND m.is_deleted = 0
        UNION ALL
        SELECT m.*, NULL AS edit_before_json, NULL AS edit_after_json,
               NULL AS edit_revision, 0 AS pending_edit,
               (c.message_id IS NOT NULL) AS correction_open, c.due_at_ms AS correction_due_at_ms
        FROM pvp_scout_messages m
        LEFT JOIN pvp_scout_correction_windows c
            ON c.message_id = m.message_id AND c.channel_id = m.channel_id AND c.status = 'waiting'
        WHERE ${scope.pending}
          AND NOT EXISTS (
              SELECT 1 FROM pvp_scout_edit_reviews e
              WHERE e.message_id = m.message_id AND e.channel_id = m.channel_id AND e.status = 'pending'
          )`;
}

function reviewQueueRow(row) {
    return { ...normalizeMessageRow(row), correction_open: Number(row.correction_open) === 1,
        correction_due_at_ms: row.correction_due_at_ms == null ? null : Number(row.correction_due_at_ms) };
}

class PvpScoutStore {
    constructor(options = {}) {
        this.db = options.db;
        this.channelId = String(options.channelId || '');
        this.server = options.server === 'silver' ? 'silver' : 'gold';
        this.learningChannelIds = [...new Set((options.learningChannelIds || [this.channelId]).filter(Boolean).map(String))];
        this.onLearningChanged = options.onLearningChanged || null;
        this.rosterStore = options.rosterStore || null;
        this.auditLogger = options.auditLogger || null;
        this.schemaReady = false;
        this.schemaPromise = null;
        this.ignEvidence = null;
        this.ignEvidenceAt = 0;
        this.reviewLearning = null;
        this.reviewLearningAt = 0;
        this.reviewLearningRevision = 0;
        this.dataRevision = 0;
        this.reportCountCache = new Map();
        this.autocompleteCache = new Map();
        this.autocompleteRequests = new Map();
        this.autocompleteCachePath = options.autocompleteCachePath || null;
        if (this.autocompleteCachePath) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.autocompleteCachePath, 'utf8'));
                if ([1, 2, 3, 4].includes(saved.version) && saved.channelId === this.channelId && Array.isArray(saved.names)) {
                    this.autocompleteCache.set(`${this.channelId}:`, { names: saved.names,
                        reportCounts: saved.version >= 3 ? saved.reportCounts || {} : {},
                        lastScouted: saved.lastScouted || {}, expiresAt: 0 });
                }
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`[CC LOG] Scout autocomplete cache will be rebuilt (${error.code || 'invalid file'}).`);
            }
        }
    }

    invalidateAutocompleteCache() {
        // Page snapshots and suggestions must stop being reused after a write.
        this.dataRevision += 1;
        this.reportCountCache.clear();
        this.onLearningChanged?.();
        // Keep the last complete list available while a fresh snapshot is
        // rebuilt; autocomplete has a short interaction deadline.
        for (const entry of this.autocompleteCache.values()) entry.expiresAt = 0;
    }

    async knownIgnEvidence({ fresh = false } = {}) {
        await this.ensureSchema();
        if (!fresh && this.ignEvidence && Date.now() - this.ignEvidenceAt < 60000) return this.ignEvidence;
        const [rows] = await this.db.query(`
            SELECT opponent_ign, ign_normalized, author_id, team_text, created_at
            FROM pvp_scout_messages
            WHERE channel_id = ? AND is_deleted = 0 AND classification = 'scout'
              AND review_status IN ('not_required','confirmed','corrected')
              AND ign_confidence >= 0.86 AND opponent_ign IS NOT NULL
              AND COALESCE(ign_source, '') <> 'staff_review_history'
              AND message_id = root_message_id
            ORDER BY created_at DESC
        `, [this.channelId]);
        const names = new Map();
        for (const row of rows) {
            if (!row.ign_normalized || !row.author_id) continue;
            if (!names.has(row.ign_normalized)) names.set(row.ign_normalized,
                { ign: row.opponent_ign, authorIds: new Set(), teamTexts: [] });
            const item = names.get(row.ign_normalized);
            item.authorIds.add(String(row.author_id));
            if (row.team_text && item.teamTexts.length < 8) item.teamTexts.push(row.team_text);
        }
        this.ignEvidence = [...names.values()].map(item =>
            ({ ign: item.ign, authorIds: [...item.authorIds], teamTexts: item.teamTexts }));
        this.ignEvidenceAt = Date.now();
        return this.ignEvidence;
    }

    async staffReviewLearning({ fresh = false } = {}) {
        await this.ensureSchema();
        if (!fresh && this.reviewLearning && Date.now() - this.reviewLearningAt < 60000) return this.reviewLearning;
        const revision = this.reviewLearningRevision;
        const [events] = await this.db.query(`
            SELECT event_id, message_id, channel_id, action, reviewer_id, before_json, after_json
            FROM pvp_scout_review_events WHERE channel_id IN (${this.learningChannelIds.map(() => '?').join(',') || '?'})
            ORDER BY event_id DESC LIMIT 5000
        `, this.learningChannelIds.length ? this.learningChannelIds : [this.channelId]);
        const learning = buildReviewLearning(events, { channelId: this.channelId });
        // An officer decision in either archive can finish during this query.
        // Let the current caller finish, but never cache that older snapshot.
        if (revision === this.reviewLearningRevision) {
            this.reviewLearning = learning;
            this.reviewLearningAt = Date.now();
        }
        return learning;
    }

    async ensureSchema() {
        // Create the tables on startup so a fresh install can use /scout without a separate migration run.
        if (this.schemaReady) return true;
        if (this.schemaPromise) return this.schemaPromise;
        if (!this.db?.query) throw new Error('The PvP scouting database is unavailable.');
        this.schemaPromise = (async () => {
            await ensureScoutTables(this.db, [
                'pvp_scout_messages',
                'pvp_scout_catchup',
                'pvp_scout_message_feedback',
                'pvp_scout_feedback_pending',
                'pvp_scout_review_events',
                'pvp_scout_review_alerts',
                'pvp_scout_edit_reviews',
                'pvp_scout_correction_windows',
                'pvp_scout_deletions'
            ]);
            this.schemaReady = true;
            return true;
        })().catch(error => {
            this.schemaPromise = null;
            throw error;
        });
        return this.schemaPromise;
    }

    async saveMessage(record) {
        if (String(record.channelId || this.channelId) !== this.channelId) {
            throw new Error('The scout source belongs to another server archive.');
        }
        await this.ensureSchema();
        const previous = await this.getMessage(record.messageId);
        const sameSource = previous && sourceFingerprint(previous.archive_message_content ?? previous.message_content,
            previous.archive_attachments ?? previous.attachments)
            === sourceFingerprint(record.content, record.attachments);
        const preserve = sameSource || previous?.staffOverrides?.locked || previous?.staffOverrides?.hidden ? 1 : 0;
        const preservedDecision = "(review_status IN ('confirmed','corrected','not_scout') OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.locked')), 'false') = 'true')";
        // Hide a new parser failure before inserting it into the archive. Historical
        // rows and protected officer edits retain their existing review behavior.
        if (record.deferReview && record.reviewStatus === 'pending'
            && !previous?.reviewed_by_id && !previous?.staffOverrides?.locked && !previous?.staffOverrides?.hidden) {
            await this.reserveCorrectionWindow(record.messageId, this.channelId,
                { reopenResolved: Boolean(previous && previous.review_status !== 'pending') });
        }
        const hash = contentHash(record);
        const params = [
            String(record.messageId), String(record.channelId || this.channelId),
            record.guildId ? String(record.guildId) : null,
            record.authorId ? String(record.authorId) : null,
            String(record.authorUsername || '').slice(0, 128) || null,
            record.createdAt ? new Date(record.createdAt) : new Date(),
            record.editedAt ? new Date(record.editedAt) : null,
            String(record.content || ''), String(record.sourceUrl || ''),
            record.replyToId ? String(record.replyToId) : null,
            json(record.attachments, []), json(record.ocrResults, []),
            record.classification || 'ignored', record.ign || null, record.ignNormalized || null,
            Number(record.ignConfidence || 0), record.ignSource || null,
            record.rating === null || record.rating === undefined ? null : Number(record.rating),
            record.teamText || null, record.notes || null, String(record.messageId),
            record.reviewStatus || 'not_required', record.reviewReason || null,
            record.teamLayoutStatus || 'none', hash, this.server
        ];
        await this.db.query(`
            INSERT INTO pvp_scout_messages (
                message_id, channel_id, guild_id, author_id, author_username,
                created_at, edited_at, message_content, source_url, reply_to_id,
                attachments_json, ocr_json, classification, opponent_ign,
                ign_normalized, ign_confidence, ign_source, rating, team_text,
                notes, root_message_id, review_status, review_reason,
                team_layout_status, content_hash, server
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                channel_id = VALUES(channel_id),
                server = VALUES(server),
                guild_id = VALUES(guild_id),
                author_id = VALUES(author_id),
                author_username = VALUES(author_username),
                created_at = VALUES(created_at),
                edited_at = VALUES(edited_at),
                message_content = VALUES(message_content),
                source_url = VALUES(source_url),
                reply_to_id = VALUES(reply_to_id),
                attachments_json = VALUES(attachments_json),
                ocr_json = VALUES(ocr_json),
                classification = IF(? AND ${preservedDecision}, classification, VALUES(classification)),
                opponent_ign = IF(? AND ${preservedDecision}, opponent_ign, VALUES(opponent_ign)),
                ign_normalized = IF(? AND ${preservedDecision}, ign_normalized, VALUES(ign_normalized)),
                ign_confidence = IF(? AND ${preservedDecision}, ign_confidence, VALUES(ign_confidence)),
                ign_source = IF(? AND ${preservedDecision}, ign_source, VALUES(ign_source)),
                rating = IF(? AND ${preservedDecision}, rating, VALUES(rating)),
                team_text = IF(? AND ${preservedDecision}, team_text, VALUES(team_text)),
                notes = IF(? AND ${preservedDecision}, notes, VALUES(notes)),
                root_message_id = IF(?, COALESCE(root_message_id, VALUES(root_message_id)), VALUES(root_message_id)),
                review_status = IF(? AND ${preservedDecision}, review_status, VALUES(review_status)),
                review_reason = IF(? AND ${preservedDecision}, review_reason, VALUES(review_reason)),
                reviewed_by_id = IF(? AND ${preservedDecision}, reviewed_by_id, NULL),
                reviewed_at = IF(? AND ${preservedDecision}, reviewed_at, NULL),
                team_layout_status = VALUES(team_layout_status),
                is_deleted = IF(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.hidden')), 'false') = 'true', 1, 0),
                content_hash = VALUES(content_hash)
        `, [...params, ...Array(9).fill(preserve),
            // An author's edit to a reviewed report replaces its details but keeps the officer's decision.
            ...Array(4).fill(preserve || record.preserveReviewDecision ? 1 : 0)]);
        this.invalidateAutocompleteCache();
        return this.getMessage(record.messageId);
    }

    // Further reports saved from one Discord message, including ones its author later removed.
    async sectionRows(messageId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT * FROM pvp_scout_messages
            WHERE channel_id = ? AND message_id LIKE ? ESCAPE '!'
            ORDER BY LENGTH(message_id), message_id
        `, [this.channelId, `${discordMessageId(messageId)}!_%`]);
        return rows.map(normalizeMessageRow);
    }

    // Saves the further reports of a message as their own rows and removes the ones its author deleted
    // from the text. Reports are matched by the opponent in their heading, so adding or reordering
    // reports keeps each report's ID, officer decisions and review state.
    async syncSections(primaryValue, sections = [], { deferReview = false } = {}) {
        const base = scoutVersion(primaryValue), id = base.messageId;
        const result = { rows: [], created: 0, removed: 0 };
        if (!/^\d+$/u.test(id)) return result;
        const existing = await this.sectionRows(id);
        if (!sections.length && !existing.length) return result;
        // Loaded here: the edit policy itself depends on this module.
        const { hasOfficerDecision, mergeReviewedEdit } = require('./ScoutEditPolicy.js');
        const heading = content => normalizeIgn(candidateFromText(content)?.ign) || '';
        const keys = contents => {
            const counts = new Map();
            return contents.map(content => {
                const name = heading(content), count = (counts.get(name) || 0) + 1;
                counts.set(name, count);
                return `${name}#${count}`;
            });
        };
        const live = existing.filter(row => !row.is_deleted);
        const liveKeys = keys(live.map(row => row.archive_message_content));
        const byKey = new Map(live.map((row, index) => [liveKeys[index], row]));
        const removed = existing.filter(row => row.is_deleted && !row.staffOverrides?.hidden && !row.reviewed_by_id);
        const taken = new Set(existing.map(row => row.message_id)), kept = new Set();
        const sectionKeys = keys(sections.map(section => section.content));
        let next = 2;
        for (const [index, section] of sections.entries()) {
            let target = byKey.get(sectionKeys[index]) || null;
            if (!target) {
                // A report the author removed and later restored returns under its earlier ID.
                const earlier = removed.findIndex(row => heading(row.archive_message_content) === heading(section.content));
                if (earlier >= 0) {
                    [target] = removed.splice(earlier, 1);
                    await this.db.query(`
                        UPDATE pvp_scout_messages SET is_deleted = 0, review_status = 'not_required'
                        WHERE message_id = ? AND channel_id = ? AND reviewed_by_id IS NULL
                    `, [target.message_id, this.channelId]);
                    target = { ...target, is_deleted: false, review_status: 'not_required' };
                }
            }
            let messageId = target?.message_id;
            if (!messageId) {
                while (taken.has(`${id}_${next}`)) next++;
                messageId = `${id}_${next}`;
                taken.add(messageId);
                result.created++;
            }
            kept.add(messageId);
            // A report an officer locked or declined is not changed by the author's edit.
            if (target && (target.staffOverrides?.locked || target.review_status === 'not_scout')) continue;
            const { content, ...parsed } = section;
            let record = { messageId, channelId: this.channelId, server: this.server, guildId: base.guildId, authorId: base.authorId,
                authorUsername: base.authorUsername, createdAt: base.createdAt, editedAt: base.editedAt, sourceUrl: base.sourceUrl,
                replyToId: null, content, attachments: [], ocrResults: [], ...parsed, teamLayoutStatus: 'none', deferReview };
            if (target && hasOfficerDecision(target) && target.archive_message_content !== content) record = mergeReviewedEdit(target, record);
            result.rows.push(await this.saveMessage(record));
        }
        for (const row of live) {
            if (kept.has(row.message_id) || row.staffOverrides?.locked) continue;
            await this.markDeleted(row.message_id);
            await this.resolveCorrectionWindow(row.message_id);
            result.removed++;
        }
        return result;
    }

    async getMessage(messageId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(
            'SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ? LIMIT 1',
            [String(messageId), this.channelId]
        );
        return rows[0] ? normalizeMessageRow(rows[0]) : null;
    }

    async isHistoricalEditBurst(previous, proposal) {
        const before = scoutVersion(previous), after = scoutVersion(proposal);
        if (before.contentHash === after.contentHash) return false;
        const created = new Date(before.createdAt).getTime();
        if (!Number.isFinite(created) || Date.now() - created <= 7 * 86400000) return false;
        await this.ensureSchema();
        // Count distinct reports, including pending attempts. Database timestamps
        // retain the rolling window across restarts; exclude this report's retries.
        // created_at and edited_at hold Discord's UTC times, while requested_at is the
        // database server's own clock, so each is compared with the matching "now".
        const [rows] = await this.db.query(`
            SELECT COUNT(DISTINCT COALESCE(m.root_message_id, m.message_id)) AS total
            FROM pvp_scout_messages m
            LEFT JOIN pvp_scout_edit_reviews e ON e.message_id = m.message_id AND e.channel_id = m.channel_id
            WHERE m.channel_id = ? AND m.author_id = ?
                AND m.created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
                AND COALESCE(m.root_message_id, m.message_id) <> ?
                AND (m.edited_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)
                    OR e.requested_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE))
        `, [this.channelId, before.authorId, String(previous.root_message_id || before.messageId)]);
        return Number(rows[0]?.total || 0) >= 2;
    }

    async stageEditReview(beforeValue, afterValue) {
        await this.ensureSchema();
        const before = scoutVersion(beforeValue);
        const after = scoutVersion(afterValue);
        if (before.channelId && before.channelId !== this.channelId
            || after.channelId && after.channelId !== this.channelId) {
            throw new Error('The edited scout source belongs to another server archive.');
        }
        if (!before.messageId || before.messageId !== after.messageId) {
            throw new Error('The edited scout message does not match its saved source.');
        }
        if (before.contentHash === after.contentHash) {
            const existing = await this.getEditReview(before.messageId);
            if (existing?.status === 'pending') {
                const restore = existing.before || before;
                await this.db.query(`
                    UPDATE pvp_scout_messages SET review_status = ?, review_reason = ?,
                        reviewed_by_id = ?, reviewed_at = ?
                    WHERE message_id = ? AND channel_id = ?
                `, [restore.reviewStatus, restore.reviewReason, restore.reviewedById,
                    restore.reviewedAt ? new Date(restore.reviewedAt) : null, before.messageId, this.channelId]);
                await this.db.query(`
                    UPDATE pvp_scout_edit_reviews SET status = 'cancelled'
                    WHERE message_id = ? AND channel_id = ? AND status = 'pending'
                `, [before.messageId, this.channelId]);
                this.invalidateAutocompleteCache();
            }
            return null;
        }
        const proposedHash = after.contentHash;
        await this.db.query(`
            INSERT INTO pvp_scout_edit_reviews
                (message_id, channel_id, before_json, after_json, proposed_hash,
                 requested_by_id, requested_by_username)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                before_json = IF(status = 'pending', before_json, VALUES(before_json)),
                after_json = IF(status = 'pending' AND proposed_hash = VALUES(proposed_hash), after_json, VALUES(after_json)),
                revision = IF(status = 'pending', revision + IF(proposed_hash = VALUES(proposed_hash), 0, 1), revision + 1),
                alerted_revision = IF(status = 'pending', alerted_revision, 0),
                requested_by_id = VALUES(requested_by_id),
                requested_by_username = VALUES(requested_by_username),
                requested_at = CURRENT_TIMESTAMP(3),
                reviewed_by_id = NULL,
                reviewed_at = NULL,
                status = 'pending',
                proposed_hash = VALUES(proposed_hash)
        `, [before.messageId, before.channelId || this.channelId, json(before, {}), json(after, {}),
            proposedHash, after.authorId, after.authorUsername]);
        await this.db.query(`
            UPDATE pvp_scout_messages
            SET review_status = 'pending', review_reason = 'The author edited this Scout Report; an officer must approve the changes.'
            WHERE message_id = ? AND channel_id = ? AND is_deleted = 0
        `, [before.messageId, before.channelId || this.channelId]);
        this.invalidateAutocompleteCache();
        return this.getEditReview(before.messageId);
    }

    async expirePendingEditReview(messageId) {
        await this.ensureSchema();
        await this.db.query(`
            UPDATE pvp_scout_edit_reviews SET status = 'expired'
            WHERE message_id = ? AND channel_id = ? AND status = 'pending'
        `, [String(messageId), this.channelId]);
        this.invalidateAutocompleteCache();
    }

    async getEditReview(messageId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT * FROM pvp_scout_edit_reviews
            WHERE message_id = ? AND channel_id = ? LIMIT 1
        `, [String(messageId), this.channelId]);
        const row = rows[0];
        if (!row) return null;
        return {
            ...row,
            message_id: String(row.message_id),
            revision: Number(row.revision || 0),
            alerted_revision: Number(row.alerted_revision || 0),
            before: decode(row.before_json, null),
            after: decode(row.after_json, null)
        };
    }

    async claimEditReviewAlert(messageId, revision) {
        await this.ensureSchema();
        const [result] = await this.db.query(`
            UPDATE pvp_scout_edit_reviews
            SET alerted_revision = revision
            WHERE message_id = ? AND channel_id = ? AND status = 'pending'
              AND revision = ? AND alerted_revision < revision
        `, [String(messageId), this.channelId, Number(revision)]);
        return Number(result.affectedRows || 0) === 1;
    }

    async markEditReviewAlertSent(messageId, revision, alertMessageId) {
        await this.ensureSchema();
        await this.db.query(`
            UPDATE pvp_scout_edit_reviews SET alert_message_id = ?
            WHERE message_id = ? AND channel_id = ? AND revision = ?
        `, [String(alertMessageId), String(messageId), this.channelId, Number(revision)]);
    }

    async releaseEditReviewAlert(messageId, revision) {
        await this.ensureSchema();
        await this.db.query(`
            UPDATE pvp_scout_edit_reviews
            SET alerted_revision = IF(revision > 1, revision - 1, 0)
            WHERE message_id = ? AND channel_id = ? AND revision = ? AND alerted_revision = revision
        `, [String(messageId), this.channelId, Number(revision)]);
    }

    async resolveEditReview(messageId, reviewerId, accept, { requirePending = false, expectedRevision } = {}) {
        await this.ensureSchema();
        const id = String(messageId);
        const connection = await this.db.getConnection();
        let changed = false;
        let auditEvent;
        try {
            await connection.beginTransaction();
            const [editRows] = await connection.query(`
                SELECT * FROM pvp_scout_edit_reviews
                WHERE message_id = ? AND channel_id = ? FOR UPDATE
            `, [id, this.channelId]);
            const edit = editRows[0];
            if (requirePending && (!edit || edit.status !== 'pending'
                || expectedRevision !== undefined && Number(edit.revision) !== Number(expectedRevision))) {
                const error = new Error('This edit review changed or was already resolved. Reopen /scout-review before acting.');
                error.code = 'SCOUT_REVIEW_STALE';
                throw error;
            }
            if (!edit || edit.status !== 'pending') {
                await connection.rollback();
                return this.getMessage(id);
            }
            const [messageRows] = await connection.query(`
                SELECT * FROM pvp_scout_messages
                WHERE message_id = ? AND channel_id = ? AND is_deleted = 0 FOR UPDATE
            `, [id, this.channelId]);
            const current = messageRows[0];
            if (requirePending && !current) {
                const error = new Error('This scout message is no longer available.');
                error.code = 'SCOUT_REVIEW_STALE';
                throw error;
            }
            if (!current) {
                await connection.rollback();
                return null;
            }
            const before = decode(edit.before_json, {});
            if (accept) {
                const next = decode(edit.after_json, {});
                const status = next.classification === 'ignored' || !next.ign
                    ? (next.classification === 'ignored' ? 'not_scout' : 'pending')
                    : 'confirmed';
                const reason = status === 'pending'
                    ? (next.reviewReason || 'Officer accepted the edit, but the opponent IGN still needs review.') : null;
                await connection.query(`
                    UPDATE pvp_scout_messages SET
                        guild_id = ?, author_id = ?, author_username = ?, created_at = ?, edited_at = ?,
                        message_content = ?, source_url = ?, reply_to_id = ?, attachments_json = ?, ocr_json = ?,
                        classification = ?, opponent_ign = ?, ign_normalized = ?, ign_confidence = ?, ign_source = ?,
                        rating = ?, team_text = ?, notes = ?, review_status = ?, review_reason = ?,
                        reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3), team_layout_status = ?,
                        content_hash = ?, is_deleted = 0
                    WHERE message_id = ? AND channel_id = ?
                `, [next.guildId, next.authorId, next.authorUsername, new Date(current.created_at),
                    next.editedAt ? new Date(next.editedAt) : null, next.content, next.sourceUrl, next.replyToId,
                    json(next.attachments, []), json(next.ocrResults, []), next.classification,
                    next.ign, next.ignNormalized, next.ignConfidence, next.ignSource, next.rating,
                    next.teamText, next.notes, status, reason, String(reviewerId), next.teamLayoutStatus,
                    next.contentHash, id, this.channelId]);
            } else {
                await connection.query(`
                    UPDATE pvp_scout_messages SET review_status = ?, review_reason = ?,
                        reviewed_by_id = ?, reviewed_at = ?
                    WHERE message_id = ? AND channel_id = ?
                `, [before.reviewStatus || 'not_required', before.reviewReason || null,
                    before.reviewedById || null, before.reviewedAt ? new Date(before.reviewedAt) : null,
                    id, this.channelId]);
            }
            await connection.query(`
                UPDATE pvp_scout_edit_reviews
                SET status = ?, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                WHERE message_id = ? AND channel_id = ?
            `, [accept ? 'accepted' : 'rejected', String(reviewerId), id, this.channelId]);
            const [publishedRows] = await connection.query('SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?',
                [id, this.channelId]);
            await connection.commit();
            changed = true;
            const proposed = decode(edit.after_json, {});
            auditEvent = { action: accept ? 'edit_accepted' : 'edit_rejected', actorId: String(reviewerId),
                reportId: String(current.root_message_id || id), messageId: id, editRevision: Number(edit.revision),
                sources: [{ messageId: id, before: { ...before, messageContent: before.content },
                    after: accept ? reviewSnapshot(publishedRows[0]) : { ...proposed, messageContent: proposed.content } }] };
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally {
            connection.release();
        }
        if (changed) {
            this.auditLogger?.enqueue(auditEvent, () => this.getReviewAlertIds(auditEvent));
            this.invalidateAutocompleteCache();
            this.ignEvidenceAt = 0;
            this.reviewLearningAt = 0;
            return this.getMessage(id).catch(error => { error.scoutDecisionSaved = true; throw error; });
        }
        return this.getMessage(id);
    }

    async refreshAutomaticRecords() {
        // Revisit old automatic decisions from saved data; this does not fetch Discord images again.
        await this.ensureSchema();
        let cursor = '';
        let updated = 0;
        const knownIgnEvidence = await this.knownIgnEvidence({ fresh: true });
        const reviewLearning = await this.staffReviewLearning({ fresh: true });
        // Messages that already have further reports saved are synchronized even when they no longer split.
        const [sectioned] = await this.db.query(`
            SELECT DISTINCT SUBSTRING_INDEX(message_id, '_', 1) AS message_id FROM pvp_scout_messages
            WHERE channel_id = ? AND message_id REGEXP '^[0-9]+_[0-9]+$'
        `, [this.channelId]);
        const withSections = new Set((Array.isArray(sectioned) ? sectioned : []).map(row => String(row.message_id)));
        while (true) {
            const [rows] = await this.db.query(`
                SELECT m.*, root.classification AS grouped_root_classification,
                    root.opponent_ign AS grouped_root_ign, root.team_text AS grouped_root_team_text,
                    root.ocr_json AS grouped_root_ocr_json
                FROM pvp_scout_messages m
                LEFT JOIN pvp_scout_messages root ON root.message_id = m.root_message_id
                  AND root.channel_id = m.channel_id AND root.is_deleted = 0 AND root.review_status <> 'not_scout'
                WHERE m.channel_id = ? AND m.review_status IN ('pending','not_required') AND m.is_deleted = 0
                  AND m.message_id > ?
                ORDER BY m.message_id ASC LIMIT 200
            `, [this.channelId, cursor]);
            if (!rows.length) break;

            for (const raw of rows) {
                // Cached roster lookups resolve as microtasks. Yield between
                // records so a long startup refresh cannot starve Discord I/O.
                await yieldToEvents();
                const row = normalizeMessageRow(raw);
                cursor = row.message_id;
                if (row.ign_source === 'member_submission' || row.reviewed_by_id) continue;
                const memberContext = this.rosterStore
                    ? await this.rosterStore.ocrMemberContext(row.guild_id, row.author_id) : undefined;
                let parsed = extractScoutData(
                    { content: row.message_content, attachments: row.attachments },
                    { ocrResults: row.ocrResults, knownIgnEvidence, reviewLearning, authorId: row.author_id,
                        memberContext }
                );
                // An unfinished live report must not become published just because
                // startup reparsed its IGN-only header without the feedback timer.
                if (row.review_reason === MISSING_TEAM_REASON && !parsed.teamText && !hasImageEvidence(row.attachments)) {
                    parsed.reviewStatus = 'pending';
                    parsed.reviewReason = MISSING_TEAM_REASON;
                }
                // Keep admitted follow-up notes intact when startup reparses the
                // archive. This changes team details, never the opponent or review decision.
                if (!parsed.ign && parsed.classification === 'ignored'
                    && row.root_message_id && row.root_message_id !== row.message_id
                    && ['scout', 'review'].includes(row.grouped_root_classification)) {
                    const details = splitScoutText(row.message_content, null, {
                        allowContextualDetails: true,
                        contextSpecies: reportContextSpecies({ opponent_ign: row.grouped_root_ign,
                            team_text: row.grouped_root_team_text, ocr_json: row.grouped_root_ocr_json })
                    });
                    if (details.teamText) {
                        parsed.teamText = details.teamText;
                        parsed.notes = details.notes;
                    }
                }
                if (row.ign_source === 'follow_up_message') {
                    if (parsed.ign && parsed.ignConfidence >= 0.86) {
                        // The root itself now has a stronger, independent name.
                    } else if (!parsed.ign && row.opponent_ign
                        && row.review_reason === 'Could not identify the opponent IGN in the message or screenshot.') {
                        const [followUps] = await this.db.query(`
                            SELECT ign_normalized FROM pvp_scout_messages
                            WHERE channel_id = ? AND root_message_id = ? AND message_id <> ?
                              AND author_id = ? AND is_deleted = 0 AND classification = 'scout'
                              AND review_status IN ('not_required','confirmed','corrected')
                              AND ign_confidence >= 0.86 AND ign_normalized IS NOT NULL
                        `, [this.channelId, row.message_id, row.message_id, row.author_id]);
                        if (!followUps.length || followUps.some(source =>
                            source.ign_normalized !== row.ign_normalized)) continue;
                        // The same author supplied the name in a clear follow-up;
                        // preserve the root's saved team and grouping.
                        parsed = { classification: row.classification, ign: row.opponent_ign,
                            ignNormalized: row.ign_normalized, ignConfidence: Number(row.ign_confidence),
                            ignSource: row.ign_source, rating: row.rating, teamText: row.team_text,
                            notes: row.notes, reviewStatus: 'not_required', reviewReason: null };
                    } else {
                        continue;
                    }
                }
                if (parsed.extraSections?.length || withSections.has(row.message_id)) {
                    const synced = await this.syncSections(row, parsed.extraSections || []);
                    updated += synced.created + synced.removed;
                }
                const changed = row.classification !== parsed.classification
                    || row.opponent_ign !== parsed.ign
                    || row.ign_normalized !== parsed.ignNormalized
                    || Number(row.ign_confidence || 0) !== Number(parsed.ignConfidence || 0)
                    || row.ign_source !== parsed.ignSource
                    || row.rating !== parsed.rating
                    || row.team_text !== parsed.teamText
                    || row.notes !== parsed.notes
                    || row.review_status !== parsed.reviewStatus
                    || row.review_reason !== parsed.reviewReason;
                if (!changed) continue;
                const [result] = await this.db.query(`
                    UPDATE pvp_scout_messages
                    SET classification = ?, opponent_ign = ?, ign_normalized = ?,
                        ign_confidence = ?, ign_source = ?, rating = ?, team_text = ?,
                        notes = ?, review_status = ?, review_reason = ?
                    WHERE channel_id = ? AND message_id = ?
                      AND review_status IN ('pending','not_required')
                      AND reviewed_by_id IS NULL
                      AND content_hash = ?
                `, [
                    parsed.classification, parsed.ign, parsed.ignNormalized,
                    parsed.ignConfidence, parsed.ignSource, parsed.rating, parsed.teamText,
                    parsed.notes, parsed.reviewStatus, parsed.reviewReason,
                    this.channelId, row.message_id, row.content_hash
                ]);
                updated += Number(result.affectedRows || 0);
            }
            if (rows.length < 200) break;
        }
        // A confirmed spelling applies to reviewed rows too; only change the display name.
        for (const [normalized, display] of IGN_DISPLAY_NAMES) {
            const [result] = await this.db.query(`
                UPDATE pvp_scout_messages SET opponent_ign = ?
                WHERE channel_id = ? AND ign_normalized = ? AND opponent_ign <> ?
            `, [display, this.channelId, normalized, display]);
            updated += Number(result.affectedRows || 0);
        }
        this.ignEvidenceAt = 0;
        if (updated) this.invalidateAutocompleteCache();
        return updated;
    }

    async reserveCorrectionWindow(messageId, channelId = this.channelId, { reopenResolved = false } = {}) {
        await this.ensureSchema();
        await this.db.query(`INSERT IGNORE INTO pvp_scout_correction_windows (message_id, channel_id, status)
            SELECT ?, ?, IF(EXISTS (SELECT 1 FROM pvp_scout_review_alerts
                WHERE message_id = ? AND channel_id = ?), 'escalated', 'waiting')
            ${reopenResolved ? REOPEN_RESOLVED_CORRECTION_WINDOW : ''}`,
        [String(messageId), String(channelId), String(messageId), String(channelId)]);
    }

    async getCorrectionWindow(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`SELECT * FROM pvp_scout_correction_windows
            WHERE message_id = ? AND channel_id = ?`, [String(messageId), String(channelId)]);
        return rows[0] || null;
    }

    async startCorrectionWindow(messageId, startedAtMs, durationMs, channelId = this.channelId) {
        await this.reserveCorrectionWindow(messageId, channelId);
        await this.db.query(`UPDATE pvp_scout_correction_windows
            SET started_at_ms = ?, due_at_ms = ?
            WHERE message_id = ? AND channel_id = ? AND status = 'waiting' AND started_at_ms IS NULL`,
        [Number(startedAtMs), Number(startedAtMs) + Number(durationMs), String(messageId), String(channelId)]);
        return this.getCorrectionWindow(messageId, channelId);
    }

    async pendingCorrectionWindows(channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`SELECT c.* FROM pvp_scout_correction_windows c
            LEFT JOIN pvp_scout_review_alerts a ON a.message_id = c.message_id AND a.channel_id = c.channel_id
            WHERE c.channel_id = ? AND (c.status = 'waiting'
                OR c.status = 'escalated' AND a.alert_message_id IS NULL)`, [String(channelId)]);
        return rows;
    }

    async resolveCorrectionWindow(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        await this.db.query(`UPDATE pvp_scout_correction_windows SET status = 'resolved'
            WHERE message_id = ? AND channel_id = ? AND status <> 'resolved'`, [String(messageId), String(channelId)]);
    }

    async escalateCorrectionWindow(messageId, nowMs, channelId = this.channelId) {
        await this.ensureSchema();
        const [result] = await this.db.query(`UPDATE pvp_scout_correction_windows c
            INNER JOIN pvp_scout_messages m ON m.message_id = c.message_id AND m.channel_id = c.channel_id
            SET c.status = 'escalated'
            WHERE c.message_id = ? AND c.channel_id = ? AND c.status = 'waiting' AND c.due_at_ms <= ?
              AND m.review_status = 'pending' AND m.is_deleted = 0 AND m.reviewed_by_id IS NULL
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.staff_overrides_json, '$.locked')), 'false') <> 'true'`,
        [String(messageId), String(channelId), Number(nowMs)]);
        return Number(result.affectedRows || 0) > 0;
    }

    async getMessageFeedback(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT * FROM pvp_scout_message_feedback WHERE message_id = ? AND channel_id = ? LIMIT 1
        `, [String(messageId), String(channelId)]);
        return rows[0] || null;
    }

    async scheduleMessageFeedback(rootId, authorId, messageId, dueAtMs, channelId = this.channelId) {
        await this.ensureSchema();
        await this.db.query(`
            INSERT INTO pvp_scout_feedback_pending (channel_id, root_message_id, author_id, latest_message_id, due_at_ms)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE revision = revision + 1,
                publication_notified = IF(CAST(VALUES(latest_message_id) AS UNSIGNED) > CAST(latest_message_id AS UNSIGNED), 0, publication_notified),
                due_at_ms = IF(CAST(VALUES(latest_message_id) AS UNSIGNED) >= CAST(latest_message_id AS UNSIGNED), VALUES(due_at_ms), due_at_ms),
                latest_message_id = IF(CAST(VALUES(latest_message_id) AS UNSIGNED) >= CAST(latest_message_id AS UNSIGNED), VALUES(latest_message_id), latest_message_id)
        `, [String(channelId), String(rootId), String(authorId), String(messageId), Number(dueAtMs)]);
        return this.getMessageFeedbackJob(rootId, authorId, channelId);
    }

    async getMessageFeedbackJob(rootId, authorId, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT * FROM pvp_scout_feedback_pending WHERE channel_id = ? AND root_message_id = ? AND author_id = ?
        `, [String(channelId), String(rootId), String(authorId)]);
        return rows[0] || null;
    }

    async pendingMessageFeedback(channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query('SELECT * FROM pvp_scout_feedback_pending WHERE channel_id = ?', [String(channelId)]);
        return rows;
    }

    async clearMessageFeedbackJob(job) {
        await this.ensureSchema();
        await this.db.query(`DELETE FROM pvp_scout_feedback_pending
            WHERE channel_id = ? AND root_message_id = ? AND author_id = ? AND revision = ?`,
        [String(job.channel_id), String(job.root_message_id), String(job.author_id), Number(job.revision)]);
    }

    async claimPublicationLog(job) {
        await this.ensureSchema();
        const [result] = await this.db.query(`UPDATE pvp_scout_feedback_pending SET publication_notified = 1
            WHERE channel_id = ? AND root_message_id = ? AND author_id = ? AND revision = ? AND publication_notified = 0`,
        [String(job.channel_id), String(job.root_message_id), String(job.author_id), Number(job.revision)]);
        return Number(result.affectedRows || 0) > 0;
    }

    async ensureReportTeamPresence(rootId, hasInformation, channelId = this.channelId, deferReview = false) {
        await this.ensureSchema();
        if (!hasInformation && deferReview) {
            // Reserve only when this update is about to create a fresh failure.
            await this.db.query(`INSERT IGNORE INTO pvp_scout_correction_windows (message_id, channel_id)
                SELECT message_id, channel_id FROM pvp_scout_messages
                WHERE message_id = ? AND channel_id = ? AND review_status = 'not_required'
                  AND classification = 'scout' AND opponent_ign IS NOT NULL AND is_deleted = 0
                  AND reviewed_by_id IS NULL
                  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.locked')), 'false') <> 'true'
                ${REOPEN_RESOLVED_CORRECTION_WINDOW}`,
            [String(rootId), String(channelId)]);
        }
        const [result] = await this.db.query(hasInformation ? `
            UPDATE pvp_scout_messages SET review_status = 'not_required', review_reason = NULL
            WHERE channel_id = ? AND message_id = ? AND review_status = 'pending' AND review_reason = ?
              AND is_deleted = 0 AND reviewed_by_id IS NULL
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.locked')), 'false') <> 'true'
        ` : `
            UPDATE pvp_scout_messages SET review_status = 'pending', review_reason = ?
            WHERE channel_id = ? AND message_id = ? AND review_status = 'not_required' AND classification = 'scout'
              AND opponent_ign IS NOT NULL AND is_deleted = 0 AND reviewed_by_id IS NULL
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.locked')), 'false') <> 'true'
        `, hasInformation ? [String(channelId), String(rootId), MISSING_TEAM_REASON]
            : [MISSING_TEAM_REASON, String(channelId), String(rootId)]);
        if (Number(result.affectedRows || 0)) this.invalidateAutocompleteCache();
    }

    async saveMessageFeedback(messageId, state, channelId = this.channelId) {
        if (!['👍', '👎'].includes(state.reaction)) throw new Error('Invalid scout feedback reaction.');
        await this.ensureSchema();
        await this.db.query(`
            INSERT INTO pvp_scout_message_feedback (message_id, channel_id, reaction, feedback_message_id)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE reaction = VALUES(reaction), feedback_message_id = VALUES(feedback_message_id)
        `, [String(messageId), String(channelId), state.reaction, state.feedback_message_id || null]);
    }

    async clearMessageFeedback(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        await this.db.query(`DELETE FROM pvp_scout_message_feedback WHERE message_id = ? AND channel_id = ?`,
            [String(messageId), String(channelId)]);
    }

    async messageFeedbackForReport(rootMessageId, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT f.* FROM pvp_scout_message_feedback f
            INNER JOIN pvp_scout_messages m ON m.message_id = f.message_id AND m.channel_id = f.channel_id
            WHERE f.channel_id = ? AND m.root_message_id = ?
        `, [String(channelId), String(rootMessageId)]);
        return rows;
    }

    async getCatchupCursor(channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(
            'SELECT last_message_id FROM pvp_scout_catchup WHERE channel_id = ? LIMIT 1',
            [String(channelId)]
        );
        return rows[0]?.last_message_id || null;
    }

    async saveCatchupCursor(messageId, channelId = this.channelId) {
        if (!/^\d{1,20}$/u.test(String(messageId))) throw new Error('A Discord message ID is required for scout catch-up.');
        await this.ensureSchema();
        // A delayed event or another host must never move the checkpoint backward.
        await this.db.query(`
            INSERT INTO pvp_scout_catchup (channel_id, last_message_id) VALUES (?, ?)
            ON DUPLICATE KEY UPDATE last_message_id = IF(
                CAST(VALUES(last_message_id) AS UNSIGNED) > CAST(last_message_id AS UNSIGNED),
                VALUES(last_message_id), last_message_id
            )
        `, [String(channelId), String(messageId)]);
    }

    async listMessagesAfter(messageId = null, limit = 500, channelId = this.channelId) {
        await this.ensureSchema();
        const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 500));
        const [rows] = messageId
            ? await this.db.query(`
                SELECT * FROM pvp_scout_messages
                WHERE channel_id = ? AND message_id > ?
                ORDER BY message_id ASC LIMIT ?
            `, [String(channelId), String(messageId), boundedLimit])
            : await this.db.query(`
                SELECT * FROM pvp_scout_messages
                WHERE channel_id = ?
                ORDER BY message_id ASC LIMIT ?
            `, [String(channelId), boundedLimit]);
        return rows.map(normalizeMessageRow);
    }

    async getPreviousMessage(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT * FROM pvp_scout_messages
            WHERE channel_id = ? AND message_id < ? AND is_deleted = 0
            ORDER BY message_id DESC LIMIT 1
        `, [String(channelId), String(messageId)]);
        return rows[0] ? normalizeMessageRow(rows[0]) : null;
    }

    async setRootLinks(links, channelId = this.channelId) {
        if (!links.length) return;
        await this.ensureSchema();
        this.invalidateAutocompleteCache();
        for (let index = 0; index < links.length; index += 150) {
            const batch = links.slice(index, index + 150);
            const params = [];
            const cases = batch.map(({ messageId, rootMessageId }) => {
                params.push(String(messageId), String(rootMessageId));
                return 'WHEN ? THEN ?';
            }).join(' ');
            params.push(String(channelId), ...batch.map(item => String(item.messageId)));
            await this.db.query(`
                UPDATE pvp_scout_messages
                SET root_message_id = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.rootMessageId')),
                    CASE message_id ${cases} ELSE root_message_id END)
                WHERE channel_id = ? AND message_id IN (${batch.map(() => '?').join(',')})
            `, params);
        }
        for (const link of links) {
            if (!link.teamDetails?.contentHash) continue;
            await this.db.query(`
                UPDATE pvp_scout_messages SET team_text = ?, notes = ?
                WHERE channel_id = ? AND message_id = ? AND root_message_id = ? AND content_hash = ?
                  AND classification = 'ignored' AND review_status = 'not_required' AND reviewed_by_id IS NULL
                  AND is_deleted = 0 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(staff_overrides_json, '$.locked')), 'false') <> 'true'
            `, [link.teamDetails.teamText, link.teamDetails.notes, String(channelId), link.messageId,
                link.rootMessageId, link.teamDetails.contentHash]);
        }
        this.invalidateAutocompleteCache();
    }

    async promoteRootIgn(rootMessageId, sourceMessageId) {
        await this.ensureSchema();
        const source = await this.getMessage(sourceMessageId);
        if (!source?.opponent_ign || !source?.ign_normalized) return;
        const root = await this.getMessage(rootMessageId);
        const clearMissingName = root && String(root.author_id || '') === String(source.author_id || '')
            && !root.reviewed_by_id && !root.staffOverrides?.locked && !root.staffOverrides?.hidden
            && source.classification === 'scout' && source.review_status === 'not_required'
            && Number(source.ign_confidence || 0) >= 0.86
            && (!root.review_reason
                || root.review_reason === 'Could not identify the opponent IGN in the message or screenshot.'
                || root.review_reason === 'Message looks like scouting information but the opponent IGN is unclear.');
        await this.db.query(`
            UPDATE pvp_scout_messages
            SET opponent_ign = ?, ign_normalized = ?, ign_confidence = ?,
                ign_source = 'follow_up_message', rating = COALESCE(rating, ?),
                classification = 'scout',
                review_status = IF(?, 'not_required', IF(review_status = 'not_required', 'pending', review_status)),
                review_reason = IF(?, NULL, COALESCE(review_reason,
                    'Opponent IGN was supplied in a follow-up message; confirm the grouping.'))
            WHERE message_id = ? AND channel_id = ? AND ign_normalized IS NULL
        `, [
            source.opponent_ign, source.ign_normalized, Number(source.ign_confidence || 0),
            source.rating, Boolean(clearMissingName), Boolean(clearMissingName),
            String(rootMessageId), this.channelId
        ]);
        this.invalidateAutocompleteCache();
    }

    async reconcileReviewedGroup(messageId) {
        const reviewed = await this.getMessage(messageId);
        if (!reviewed?.ign_normalized) return reviewed;
        const rootId = String(reviewed.root_message_id || reviewed.message_id);
        if (rootId === String(reviewed.message_id)) return reviewed;

        const root = await this.getMessage(rootId);
        if (!root || root.is_deleted) {
            const overrides = { ...reviewed.staffOverrides, rootMessageId: String(messageId), locked: true };
            delete overrides.relation;
            await this.db.query(
                'UPDATE pvp_scout_messages SET root_message_id = message_id, staff_overrides_json = ? WHERE message_id = ? AND channel_id = ?',
                [json(overrides, {}), String(messageId), this.channelId]
            );
            this.invalidateAutocompleteCache();
            return this.getMessage(messageId);
        } else if (!root.ign_normalized) {
            await this.promoteRootIgn(rootId, messageId);
        } else if (String(root.ign_normalized).toLowerCase() !== String(reviewed.ign_normalized).toLowerCase()) {
            // A human correction found that this post belongs to a different opponent.
            const overrides = { ...reviewed.staffOverrides, rootMessageId: String(messageId), locked: true };
            delete overrides.relation;
            await this.db.query(
                'UPDATE pvp_scout_messages SET root_message_id = message_id, staff_overrides_json = ? WHERE message_id = ? AND channel_id = ?',
                [json(overrides, {}), String(messageId), this.channelId]
            );
            this.invalidateAutocompleteCache();
            return this.getMessage(messageId);
        }
        if (reviewed.review_status === 'corrected' && reviewed.rating !== null
            && rootId !== String(reviewed.message_id)) {
            await this.db.query(
                'UPDATE pvp_scout_messages SET rating = ? WHERE message_id = ? AND channel_id = ?',
                [reviewed.rating, rootId, this.channelId]
            );
            this.invalidateAutocompleteCache();
        }
        return this.getMessage(messageId);
    }

    async searchRootsAndSources(ignNormalized, channelId = this.channelId) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT source.message_id, source.channel_id, source.server, source.author_id, source.author_username,
                   source.created_at, source.message_content, source.source_url, source.reply_to_id,
                   source.attachments_json,
                   CASE WHEN source.message_id = root.message_id THEN source.ocr_json ELSE '[]' END AS ocr_json,
                   source.classification, source.opponent_ign, source.ign_source, source.rating,
                   source.team_text, source.notes, source.staff_overrides_json, source.root_message_id,
                   source.review_status, source.review_reason, source.team_layout_status, source.is_deleted
            FROM pvp_scout_messages AS root
            INNER JOIN pvp_scout_messages AS source
                ON source.channel_id = root.channel_id
                AND source.root_message_id = root.message_id
                AND source.is_deleted = 0
            WHERE ${publicLookupWhere(ignNormalized)}
            ORDER BY root.created_at DESC, root.message_id DESC,
                     source.created_at ASC, source.message_id ASC
        `, ignNormalized === null ? [String(channelId)] : [String(channelId), String(ignNormalized)]);
        const sources = rows.map(normalizeMessageRow);
        const roots = sources.filter(row => String(row.message_id) === String(row.root_message_id));
        return { roots, sources };
    }

    async publicReportCount(ignNormalized, channelId = this.channelId) {
        const key = JSON.stringify([String(channelId), ignNormalized]);
        const now = Date.now();
        for (const [name, entry] of this.reportCountCache) {
            if (entry.expiresAt <= now) this.reportCountCache.delete(name);
        }
        const cached = this.reportCountCache.get(key);
        if (cached) return cached.promise;
        // Server dropdowns need only a count, not the other archive's team text,
        // screenshots and OCR. Share concurrent counts and discard them on writes.
        const entry = { expiresAt: Infinity };
        entry.promise = Promise.resolve().then(async () => {
            await this.ensureSchema();
            const [rows] = await this.db.query(`
                SELECT COUNT(*) AS total FROM pvp_scout_messages root
                WHERE ${publicLookupWhere(ignNormalized)}
            `, ignNormalized === null ? [String(channelId)] : [String(channelId), String(ignNormalized)]);
            entry.expiresAt = Date.now() + 15_000;
            return Number(rows[0]?.total || 0);
        }).catch(error => {
            if (this.reportCountCache.get(key) === entry) this.reportCountCache.delete(key);
            throw error;
        });
        this.reportCountCache.set(key, entry);
        while (this.reportCountCache.size > 25) this.reportCountCache.delete(this.reportCountCache.keys().next().value);
        return entry.promise;
    }

    async sourcesForRoots(rootIds, channelId = this.channelId) {
        await this.ensureSchema();
        if (!rootIds.length) return [];
        const all = [];
        for (let index = 0; index < rootIds.length; index += 400) {
            const chunk = rootIds.slice(index, index + 400).map(String);
            const [rows] = await this.db.query(`
                SELECT * FROM pvp_scout_messages
                WHERE channel_id = ? AND root_message_id IN (${chunk.map(() => '?').join(',')}) AND is_deleted = 0
                ORDER BY created_at ASC, message_id ASC
            `, [String(channelId), ...chunk]);
            all.push(...rows.map(normalizeMessageRow));
        }
        return all;
    }

    cachedAutocomplete(query, channelId = this.channelId) {
        const term = String(query || '').trim().toLowerCase();
        const channel = String(channelId);
        const exact = this.autocompleteCache.get(`${channel}:${term}`);
        const latest = this.autocompleteCache.get(`${channel}:`);
        const refreshedAt = entry => entry?.refreshedAt || entry?.expiresAt || 0;
        // An empty fresh result is authoritative too. Merging older snapshots
        // would put deleted or renamed opponents back into the suggestions.
        const authoritative = exact && (!latest || refreshedAt(exact) > refreshedAt(latest)) ? exact : latest;
        const candidates = authoritative?.names || [];
        if (term && !authoritative) {
            for (const [key, entry] of this.autocompleteCache) {
                if (key.startsWith(`${channel}:`) && entry !== exact && entry !== latest) candidates.push(...entry.names);
            }
        }
        const names = [], seen = new Set();
        for (const name of candidates) {
            if (typeof name !== 'string' || seen.has(name) || term && !name.toLowerCase().startsWith(term)) continue;
            seen.add(name);
            if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(name) || !nameFromResultLine(name)) continue;
            names.push(name);
            if (names.length === 25) break;
        }
        return names;
    }

    cachedAutocompleteReportCount(ign, channelId = this.channelId) {
        const key = String(ign || '').toLocaleLowerCase('en-US');
        const channel = String(channelId);
        let count = null, newest = -1;
        for (const [cacheKey, entry] of this.autocompleteCache) {
            if (!cacheKey.startsWith(`${channel}:`)) continue;
            const found = entry.reportCounts?.[key];
            const refreshedAt = entry.refreshedAt || entry.expiresAt || 0;
            if (Number.isInteger(found) && found >= 1 && refreshedAt >= newest) {
                count = found; newest = refreshedAt;
            }
        }
        // Old cache files have names only. Keep their suggestions usable while
        // the normal background refresh loads counts, rather than inventing 0.
        return count;
    }

    cachedAutocompleteLatestScout(ign, channelId = this.channelId) {
        const key = String(ign || '').toLocaleLowerCase('en-US');
        let date = null, newest = -1;
        for (const [cacheKey, entry] of this.autocompleteCache) {
            if (!cacheKey.startsWith(`${String(channelId)}:`)) continue;
            const timestamp = entry.lastScouted?.[key];
            const refreshedAt = entry.refreshedAt || entry.expiresAt || 0;
            if (timestamp && refreshedAt >= newest) { date = timestamp; newest = refreshedAt; }
        }
        return date;
    }

    async autocomplete(query, channelId = this.channelId, forceRefresh = false) {
        const term = String(query || '').trim().toLowerCase();
        const cacheKey = `${String(channelId)}:${term}`;
        const cached = this.autocompleteCache.get(cacheKey);
        if (!forceRefresh && cached && cached.expiresAt > Date.now()) return this.cachedAutocomplete(term, channelId);
        if (!forceRefresh && cached?.names?.length) {
            void this.autocomplete(term, channelId, true).catch(() => {});
            return this.cachedAutocomplete(term, channelId);
        }
        const revision = this.dataRevision;
        const active = this.autocompleteRequests.get(cacheKey);
        if (active?.revision === revision) return active.promise;
        const request = { revision };
        const pending = (async () => {
            await this.ensureSchema();
            const prefix = term.replace(/[!%_]/g, '!$&');
            let rows;
            try {
                [rows] = await this.db.query(`
                SELECT MAX(opponent_ign) AS opponent_ign, ign_normalized,
                       COUNT(*) AS report_count, MAX(created_at) AS last_scouted
                FROM pvp_scout_messages
                WHERE channel_id = ? AND message_id = root_message_id
                  AND (? = '' OR ign_normalized LIKE CONCAT(?, '%') ESCAPE '!') AND is_deleted = 0
                  AND classification IN ('scout','review')
                  AND review_status <> 'not_scout'
                  AND NOT (COALESCE(ign_source, '') = 'member_submission' AND review_status = 'pending')
                GROUP BY ign_normalized
                ORDER BY last_scouted DESC, opponent_ign ASC LIMIT ${term ? 25 : 10000}
                `, [String(channelId), term, prefix]);
            } catch (error) {
                const fallback = this.cachedAutocomplete(term, channelId);
                if (fallback.length) return fallback;
                throw error;
            }
            // Cache the whole opponent index, ordered by most recent report.
            // Typing a prefix can then get 25 choices without a database wait.
            const names = [...new Set(rows.map(row => String(row.opponent_ign || '')))]
                .filter(name => /^[\p{L}\p{N}_.-]{2,32}$/u.test(name) && nameFromResultLine(name));
            const reportCounts = Object.fromEntries(rows.map(row => [
                String(row.ign_normalized || row.opponent_ign || '').toLocaleLowerCase('en-US'), Number(row.report_count)
            ]).filter(([, count]) => Number.isInteger(count) && count >= 1));
            if (this.dataRevision !== revision) return this.cachedAutocomplete(term, channelId);
            const lastScouted = Object.fromEntries(rows.filter(row => row.last_scouted
                && Number.isFinite(new Date(row.last_scouted).getTime())).map(row => [
                String(row.ign_normalized || row.opponent_ign || '').toLocaleLowerCase('en-US'),
                new Date(row.last_scouted).toISOString()
            ]));
            const refreshedAt = Math.max(Date.now(), (this.autocompleteRefreshedAt || 0) + 1);
            this.autocompleteRefreshedAt = refreshedAt;
            this.autocompleteCache.set(cacheKey, { names, reportCounts, lastScouted, refreshedAt, expiresAt: refreshedAt + 60_000 });
            if (!term && String(channelId) === this.channelId && this.autocompleteCachePath) {
                try {
                    writeJsonIfChanged(this.autocompleteCachePath, `${this.autocompleteCachePath}.tmp`, {
                        version: 4, channelId: this.channelId, names, reportCounts, lastScouted
                    });
                } catch (error) {
                    console.warn(`[CC LOG] Could not save scout autocomplete cache (${error.code || error.message}).`);
                }
            }
            while (this.autocompleteCache.size > 100) {
                const oldest = [...this.autocompleteCache.keys()].find(key => key !== `${this.channelId}:`);
                this.autocompleteCache.delete(oldest);
            }
            return this.cachedAutocomplete(term, channelId);
        })().finally(() => {
            if (this.autocompleteRequests.get(cacheKey) === request) this.autocompleteRequests.delete(cacheKey);
        });
        request.promise = pending;
        this.autocompleteRequests.set(cacheKey, request);
        return pending;
    }

    async pendingReviews(limit = 1, offset = 0, channelId = this.channelId) {
        await this.ensureSchema();
        const scope = reviewScope(channelId);
        const [rows] = await this.db.query(`
            SELECT * FROM (${reviewQueueSql(scope)}
            ) AS review_queue
            ORDER BY created_at DESC, message_id DESC LIMIT ? OFFSET ?
        `, [...scope.params, ...scope.params,
            Math.max(1, Math.min(20, Number(limit) || 1)), Math.max(0, Number(offset) || 0)]);
        return rows.map(reviewQueueRow);
    }

    async pendingReviewCount(channelId = this.channelId) {
        await this.ensureSchema();
        const scope = reviewScope(channelId);
        const [[ordinaryRows], [editRows]] = await Promise.all([this.db.query(`
            SELECT COUNT(*) AS total FROM pvp_scout_messages m
            WHERE ${scope.pending}
              AND NOT EXISTS (
                  SELECT 1 FROM pvp_scout_edit_reviews e
                  WHERE e.message_id = m.message_id AND e.channel_id = m.channel_id AND e.status = 'pending'
              )
        `, scope.params), this.db.query(`
            SELECT COUNT(*) AS total FROM pvp_scout_edit_reviews e
            INNER JOIN pvp_scout_messages m ON m.message_id = e.message_id AND m.channel_id = e.channel_id
            WHERE ${scope.clause} AND e.status = 'pending' AND m.is_deleted = 0
        `, scope.params)]);
        return Number(ordinaryRows[0]?.total || 0) + Number(editRows[0]?.total || 0);
    }

    async exportPendingReviews(channelId = this.channelId) {
        await this.ensureSchema();
        const scope = reviewScope(channelId);
        const [rows] = await this.db.query(`
            SELECT * FROM (${reviewQueueSql(scope)}
            ) AS review_queue
            ORDER BY created_at DESC, message_id DESC
        `, [...scope.params, ...scope.params]);
        return rows.map(reviewQueueRow);
    }

    async applyStaffReview(messageId, reviewerId, action, correction = {},
        { allowPreviouslyReviewed = false, logAction = true, requirePending = false, expectedContentHash } = {}) {
        await this.ensureSchema();
        const id = String(messageId);
        const reviewer = String(reviewerId);
        const connection = await this.db.getConnection();
        let changed = false;
        let auditEvent;
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query(`
                SELECT * FROM pvp_scout_messages
                WHERE message_id = ? AND channel_id = ? AND is_deleted = 0 FOR UPDATE
            `, [id, this.channelId]);
            const before = rows[0];
            // Lock the author's correction window so its deadline cannot escalate during this decision.
            if (requirePending) await connection.query(`
                SELECT status FROM pvp_scout_correction_windows WHERE message_id = ? AND channel_id = ? FOR UPDATE
            `, [id, this.channelId]);
            if (requirePending && (!before || before.review_status !== 'pending')) {
                const error = new Error('This scout review is no longer pending. Reopen /scout-review before acting.');
                error.code = 'SCOUT_REVIEW_STALE';
                throw error;
            }
            // The author can still edit during the correction window; never apply a decision to text the officer has not seen.
            if (requirePending && expectedContentHash && before.content_hash !== expectedContentHash) {
                const error = new Error('The member edited this scout message after the review was opened. Reopen /scout-review before acting.');
                error.code = 'SCOUT_REVIEW_STALE';
                throw error;
            }
            if (!before || before.review_status !== 'pending' && !allowPreviouslyReviewed) {
                await connection.rollback();
                return before ? normalizeMessageRow(before) : null;
            }
            if (action === 'confirmed') {
                await connection.query(`
                    UPDATE pvp_scout_messages SET review_status = 'confirmed', review_reason = NULL,
                        ign_source = 'human_confirmed', reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                    WHERE message_id = ? AND channel_id = ?
                `, [reviewer, id, this.channelId]);
            } else if (action === 'corrected') {
                await connection.query(`
                    UPDATE pvp_scout_messages SET classification = 'scout',
                        opponent_ign = ?, ign_normalized = ?, ign_confidence = 1,
                        ign_source = 'human_corrected', rating = ?, team_text = ?, notes = ?,
                        review_status = 'corrected', review_reason = NULL,
                        reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                    WHERE message_id = ? AND channel_id = ?
                `, [correction.ign, correction.ignNormalized,
                    correction.rating === null || correction.rating === undefined ? null : Number(correction.rating),
                    correction.teamText || null, correction.notes || null, reviewer, id, this.channelId]);
            } else if (action === 'not_scout') {
                await connection.query(`
                    UPDATE pvp_scout_messages SET classification = 'ignored',
                        opponent_ign = NULL, ign_normalized = NULL, review_status = 'not_scout',
                        review_reason = NULL, reviewed_by_id = ?, reviewed_at = CURRENT_TIMESTAMP(3)
                    WHERE message_id = ? AND channel_id = ?
                `, [reviewer, id, this.channelId]);
            } else throw new Error(`Unknown scout review action: ${action}`);
            // An officer decision ends the author's correction window; its deadline must not escalate a reviewed report.
            await connection.query(`
                UPDATE pvp_scout_correction_windows SET status = 'resolved'
                WHERE message_id = ? AND channel_id = ? AND status = 'waiting'
            `, [id, this.channelId]);
            const [updated] = await connection.query(
                'SELECT * FROM pvp_scout_messages WHERE message_id = ? AND channel_id = ?', [id, this.channelId]
            );
            const beforeData = reviewSnapshot(before);
            const afterData = reviewSnapshot(updated[0]);
            const changes = Object.fromEntries(Object.keys(afterData)
                .filter(key => !sameValue(key, beforeData[key], afterData[key]))
                .map(key => [key, { before: beforeData[key], after: afterData[key] }]));
            await connection.query(`
                INSERT INTO pvp_scout_review_events
                    (message_id, channel_id, action, reviewer_id, before_json, after_json, changes_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [id, this.channelId, action, reviewer, json(beforeData, {}),
                json(afterData, {}), json(changes, {})]);
            await connection.commit();
            changed = true;
            auditEvent = { action, actorId: reviewer, reportId: String(before.root_message_id || id), messageId: id,
                sources: [{ messageId: id, before: beforeData, after: afterData, changes }] };
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally {
            connection.release();
        }
        if (changed) {
            if (logAction) this.auditLogger?.enqueue(auditEvent, () => this.getReviewAlertIds(auditEvent));
            this.invalidateAutocompleteCache();
            this.ignEvidenceAt = 0;
            this.reviewLearningAt = 0;
            return this.reconcileReviewedGroup(id).catch(error => { error.scoutDecisionSaved = true; throw error; });
        }
        return this.getMessage(id);
    }

    async confirmReview(messageId, reviewerId, options = {}) {
        return this.applyStaffReview(messageId, reviewerId, 'confirmed', {}, options);
    }

    async correctReview(messageId, reviewerId, correction = {}, options = {}) {
        return this.applyStaffReview(messageId, reviewerId, 'corrected', correction, options);
    }

    async markNotScout(messageId, reviewerId, options = {}) {
        return this.applyStaffReview(messageId, reviewerId, 'not_scout', {}, options);
    }

    async getReviewAlertIds(event) {
        await this.ensureSchema();
        const ids = [...new Set([event.messageId, ...(event.sources || []).map(source => source.messageId)].filter(Boolean).map(String))];
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(', ');
        const editOnly = ['edit_accepted', 'edit_rejected'].includes(event.action);
        const [rows] = await this.db.query(`
            ${editOnly ? '' : `SELECT alert_message_id FROM pvp_scout_review_alerts
                WHERE channel_id = ? AND message_id IN (${placeholders})
                UNION ALL`}
            SELECT alert_message_id FROM pvp_scout_edit_reviews
            WHERE channel_id = ? AND message_id IN (${placeholders}) AND alerted_revision = revision
            ${editOnly ? 'AND revision = ?' : ''}
        `, [...(editOnly ? [] : [this.channelId, ...ids]), this.channelId, ...ids,
            ...(editOnly ? [event.editRevision] : [])]);
        return [...new Set(rows.map(row => row.alert_message_id).filter(Boolean).map(String))];
    }

    async claimReviewAlert(messageId) {
        await this.ensureSchema();
        const [result] = await this.db.query(`
            INSERT IGNORE INTO pvp_scout_review_alerts (message_id, channel_id) VALUES (?, ?)
        `, [String(messageId), this.channelId]);
        return Number(result.affectedRows || 0) === 1;
    }

    async markReviewAlertSent(messageId, alertMessageId) {
        await this.db.query(`
            UPDATE pvp_scout_review_alerts SET alert_message_id = ? WHERE message_id = ? AND channel_id = ?
        `, [String(alertMessageId), String(messageId), this.channelId]);
    }

    async releaseReviewAlert(messageId) {
        await this.db.query(`
            DELETE FROM pvp_scout_review_alerts WHERE message_id = ? AND channel_id = ? AND alert_message_id IS NULL
        `, [String(messageId), this.channelId]);
    }

    async markDeleted(messageId, channelId = this.channelId) {
        await this.ensureSchema();
        await this.db.query(`
            UPDATE pvp_scout_messages
            SET is_deleted = 1, review_status = 'not_scout'
            WHERE message_id = ? AND channel_id = ?
        `, [String(messageId), String(channelId)]);
        this.invalidateAutocompleteCache();
    }
}

module.exports = {
    PvpScoutStore,
    MISSING_TEAM_REASON,
    contentHash,
    discordMessageId,
    scoutVersion,
    decode,
    normalizeMessageRow
};
