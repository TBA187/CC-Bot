'use strict';

// Stores forum history in MySQL and keeps a JSON fallback ready for database outages.
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../../../utils/jsonFile.js');
const {
    CLASSIFICATIONS,
    DEFAULT_DATA_FILE,
    JSON_SOURCES,
    STORAGE_SYNC_INTERVAL_MS,
    STORAGE_VERSION
} = require('../constants.js');

function parseStorageMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
}

function toSqlDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 23).replace('T', ' ');
}

function fromSqlDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const text = String(value);
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function parseJson(value, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function normalizeUserKey(forumUserId, forumUsername) {
    if (forumUserId) return `id:${forumUserId}`;
    const username = String(forumUsername || '').trim().toLowerCase();
    return username ? `name:${username}` : null;
}

function numericPostId(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function normalizeImageUrl(value) {
    try {
        const url = new URL(String(value || ''));
        url.hash = '';
        url.search = '';
        return url.href;
    } catch {
        return String(value || '').trim();
    }
}

function isDecorativeImageUrl(value) {
    return /(?:twitter\/twemoji|twemoji@)/i.test(String(value || ''));
}

function isVoteReminderCandidate(record, now = new Date()) {
    const pollCreatedMs = Date.parse(record.pollCreatedAt || '');
    if (record.notificationStatus !== 'notified'
        || !record.pollMessageId
        || !record.pollMessageUrl
        || !record.officerMessageUrl
        || !Number.isFinite(pollCreatedMs)) return false;
    const ageMs = now.getTime() - pollCreatedMs;
    if (ageMs < 12 * 60 * 60 * 1000 || ageMs >= 24 * 60 * 60 * 1000) return false;
    if (ageMs >= 18 * 60 * 60 * 1000) return !record.voteReminder18hCheckedAt;
    return !record.voteReminder12hCheckedAt;
}

const TERMINAL_NOTIFICATION_STATUSES = new Set([
    'not_required',
    'notified',
    'notified_no_poll',
    'notified_poll_failed',
    'non_application_alert_sent'
]);

function notificationProgress(record = {}) {
    if (TERMINAL_NOTIFICATION_STATUSES.has(record.notificationStatus) || record.notifiedAt) return 4;
    if (record.pollMessageId || record.pollMessageUrl) return 3;
    if (record.notificationStatus === 'officer_sent' || record.officerMessageId || record.officerMessageUrl) return 2;
    return 1;
}

function mergeReminderState(target, incoming, existing, checkedField, messageField) {
    const incomingTime = Date.parse(incoming?.[checkedField] || '');
    const existingTime = Date.parse(existing?.[checkedField] || '');
    const useExisting = Number.isFinite(existingTime)
        && (!Number.isFinite(incomingTime) || existingTime >= incomingTime);
    const primary = useExisting ? existing : incoming;
    const secondary = useExisting ? incoming : existing;
    target[checkedField] = primary?.[checkedField] || secondary?.[checkedField] || null;
    target[messageField] = primary?.[messageField] || secondary?.[messageField] || null;
}

function mergeDeliveryState(incoming = {}, existing = {}) {
    const useExisting = notificationProgress(existing) >= notificationProgress(incoming);
    const primary = useExisting ? existing : incoming;
    const secondary = useExisting ? incoming : existing;
    const merged = { ...existing, ...incoming };

    merged.notificationStatus = primary.notificationStatus || secondary.notificationStatus || 'not_required';
    for (const field of [
        'officerMessageId',
        'officerMessageUrl',
        'pollMessageId',
        'pollMessageUrl',
        'pollCreatedAt',
        'notifiedAt'
    ]) {
        merged[field] = primary[field] || secondary[field] || null;
    }
    merged.lastError = notificationProgress(primary) >= 4
        ? null
        : (primary.lastError || secondary.lastError || null);
    mergeReminderState(merged, incoming, existing, 'voteReminder12hCheckedAt', 'voteReminder12hMessageId');
    mergeReminderState(merged, incoming, existing, 'voteReminder18hCheckedAt', 'voteReminder18hMessageId');
    return merged;
}

class GuildApplicationStore {
    constructor(options = {}) {
        this.db = options.db;
        this.storageMode = parseStorageMode(options.storageMode ?? process.env.STORAGE_MODE);
        this.dataFile = options.dataFile || DEFAULT_DATA_FILE;
        this.tempFile = `${this.dataFile}.tmp`;
        this.syncIntervalMs = options.syncIntervalMs || STORAGE_SYNC_INTERVAL_MS;
        this.hasMysqlConfig = options.hasMysqlCredentials
            ?? this.db?.hasRequiredConfig
            ?? Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
        // One queue keeps a fallback sync and a new forum write from stepping on each other.
        this.queue = Promise.resolve();
        this.syncInterval = null;
        this.mysqlOutage = false;
        this.localStorageOutage = false;
    }

    source() {
        return this.storageMode === 'json' ? JSON_SOURCES.JSON_ONLY : JSON_SOURCES.MYSQL_FALLBACK;
    }

    canUseMysql() {
        return this.storageMode !== 'json' && Boolean(this.db) && Boolean(this.hasMysqlConfig);
    }

    emptyData() {
        return {
            version: STORAGE_VERSION,
            source: this.source(),
            pendingSync: false,
            initialized: false,
            checkpoint: null,
            records: []
        };
    }

    ensureFile() {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        if (!fs.existsSync(this.dataFile)) this.writeData(this.emptyData());
    }

    readData() {
        try {
            this.ensureFile();
            const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            const source = parsed.source === JSON_SOURCES.JSON_ONLY || parsed.source === JSON_SOURCES.MYSQL_FALLBACK
                ? parsed.source
                : this.source();
            const records = Array.isArray(parsed.records) ? parsed.records.map(record => this.normalizeRecord(record)) : [];
            return {
                version: STORAGE_VERSION,
                source,
                pendingSync: source === JSON_SOURCES.MYSQL_FALLBACK && (parsed.pendingSync === true || records.length > 0),
                initialized: parsed.initialized === true,
                checkpoint: parsed.checkpoint && typeof parsed.checkpoint === 'object' ? parsed.checkpoint : null,
                records
            };
        } catch (error) {
            // An unreadable fallback may contain unsynchronized applications.
            // Never replace it with an empty snapshot.
            error.guildApplicationStorage = true;
            throw error;
        }
    }

    writeData(data) {
        try {
            const changed = writeJsonIfChanged(this.dataFile, this.tempFile, {
                version: STORAGE_VERSION,
                source: data.source || this.source(),
                pendingSync: data.pendingSync === true,
                initialized: data.initialized === true,
                checkpoint: data.checkpoint || null,
                records: Array.isArray(data.records) ? data.records : []
            });
            if (this.localStorageOutage && changed) {
                this.localStorageOutage = false;
                console.log('[CC LOG] Guild Application local JSON storage restored.');
            }
            return changed;
        } catch (error) {
            error.guildApplicationStorage = true;
            throw error;
        }
    }

    enqueue(task) {
        const pending = this.queue.then(task, task);
        this.queue = pending.catch(() => {});
        return pending;
    }

    normalizeRecord(record) {
        return {
            postId: String(record.postId ?? record.post_id ?? ''),
            topicId: String(record.topicId ?? record.topic_id ?? '228820'),
            topicUrl: record.topicUrl ?? record.topic_url ?? null,
            postUrl: record.postUrl ?? record.post_url ?? null,
            pageNumber: Number(record.pageNumber ?? record.page_number ?? 1),
            forumUserId: record.forumUserId ?? record.forum_user_id ?? null,
            forumUsername: record.forumUsername ?? record.forum_username ?? null,
            forumProfileUrl: record.forumProfileUrl ?? record.forum_profile_url ?? null,
            forumProfileSlug: record.forumProfileSlug ?? record.forum_profile_slug ?? null,
            postedAt: fromSqlDate(record.postedAt ?? record.posted_at),
            observedAt: fromSqlDate(record.observedAt ?? record.observed_at) || new Date().toISOString(),
            contentHash: record.contentHash ?? record.content_hash ?? null,
            rawBodyText: record.rawBodyText ?? record.raw_body_text ?? '',
            imageUrls: parseJson(record.imageUrls ?? record.image_urls, []),
            classification: record.classification || CLASSIFICATIONS.NON_APPLICATION,
            classificationConfidence: Number(record.classificationConfidence ?? record.classification_confidence ?? 0),
            parserReasons: parseJson(record.parserReasons ?? record.parser_reasons, []),
            ocrOutput: parseJson(record.ocrOutput ?? record.ocr_output, null),
            ign: record.ign || null,
            ignSource: record.ignSource ?? record.ign_source ?? null,
            ignConfidence: Number(record.ignConfidence ?? record.ign_confidence ?? 0),
            age: record.age || null,
            country: record.country || null,
            interests: record.interests || null,
            extraInformation: record.extraInformation ?? record.extra_information ?? null,
            isBaseline: record.isBaseline === true || record.is_baseline === 1 || record.is_baseline === true,
            notificationStatus: record.notificationStatus ?? record.notification_status ?? 'not_required',
            officerMessageId: record.officerMessageId ?? record.officer_message_id ?? null,
            officerMessageUrl: record.officerMessageUrl ?? record.officer_message_url ?? null,
            pollMessageId: record.pollMessageId ?? record.poll_message_id ?? null,
            pollMessageUrl: record.pollMessageUrl ?? record.poll_message_url ?? null,
            pollCreatedAt: fromSqlDate(record.pollCreatedAt ?? record.poll_created_at),
            voteReminder12hCheckedAt: fromSqlDate(record.voteReminder12hCheckedAt ?? record.vote_reminder_12h_checked_at),
            voteReminder12hMessageId: record.voteReminder12hMessageId ?? record.vote_reminder_12h_message_id ?? null,
            voteReminder18hCheckedAt: fromSqlDate(record.voteReminder18hCheckedAt ?? record.vote_reminder_18h_checked_at),
            voteReminder18hMessageId: record.voteReminder18hMessageId ?? record.vote_reminder_18h_message_id ?? null,
            lastError: record.lastError ?? record.last_error ?? null,
            notifiedAt: fromSqlDate(record.notifiedAt ?? record.notified_at),
            storageOrigin: record.storageOrigin ?? record.storage_origin ?? null
        };
    }

    rowToRecord(row) {
        return this.normalizeRecord(row);
    }

    recordValues(record) {
        const item = this.normalizeRecord(record);
        return [
            item.postId,
            item.topicId,
            item.topicUrl,
            item.postUrl,
            item.pageNumber,
            item.forumUserId,
            item.forumUsername,
            item.forumProfileUrl,
            item.forumProfileSlug,
            toSqlDate(item.postedAt),
            toSqlDate(item.observedAt),
            item.contentHash,
            item.rawBodyText,
            JSON.stringify(item.imageUrls || []),
            item.classification,
            item.classificationConfidence,
            JSON.stringify(item.parserReasons || []),
            item.ocrOutput == null ? null : JSON.stringify(item.ocrOutput),
            item.ign,
            item.ignSource,
            item.ignConfidence,
            item.age,
            item.country,
            item.interests,
            item.extraInformation,
            item.isBaseline ? 1 : 0,
            item.notificationStatus,
            item.officerMessageId,
            item.officerMessageUrl,
            item.pollMessageId,
            item.pollMessageUrl,
            toSqlDate(item.pollCreatedAt),
            toSqlDate(item.voteReminder12hCheckedAt),
            item.voteReminder12hMessageId,
            toSqlDate(item.voteReminder18hCheckedAt),
            item.voteReminder18hMessageId,
            item.lastError,
            toSqlDate(item.notifiedAt),
            item.storageOrigin
        ];
    }

    upsertSql() {
        return `
            INSERT INTO guild_applications (
                post_id, topic_id, topic_url, post_url, page_number, forum_user_id, forum_username,
                forum_profile_url, forum_profile_slug, posted_at, observed_at, content_hash,
                raw_body_text, image_urls, classification, classification_confidence,
                parser_reasons, ocr_output, ign, ign_source, ign_confidence, age, country,
                interests, extra_information, is_baseline, notification_status,
                officer_message_id, officer_message_url, poll_message_id, poll_message_url,
                poll_created_at, vote_reminder_12h_checked_at, vote_reminder_12h_message_id,
                vote_reminder_18h_checked_at, vote_reminder_18h_message_id,
                last_error, notified_at, storage_origin
            ) VALUES (${Array(39).fill('?').join(', ')})
            ON DUPLICATE KEY UPDATE
                topic_id = VALUES(topic_id),
                topic_url = VALUES(topic_url),
                post_url = VALUES(post_url),
                page_number = VALUES(page_number),
                forum_user_id = VALUES(forum_user_id),
                forum_username = VALUES(forum_username),
                forum_profile_url = VALUES(forum_profile_url),
                forum_profile_slug = VALUES(forum_profile_slug),
                posted_at = VALUES(posted_at),
                observed_at = VALUES(observed_at),
                content_hash = VALUES(content_hash),
                raw_body_text = VALUES(raw_body_text),
                image_urls = VALUES(image_urls),
                classification = VALUES(classification),
                classification_confidence = VALUES(classification_confidence),
                parser_reasons = VALUES(parser_reasons),
                ocr_output = VALUES(ocr_output),
                ign = VALUES(ign),
                ign_source = VALUES(ign_source),
                ign_confidence = VALUES(ign_confidence),
                age = VALUES(age),
                country = VALUES(country),
                interests = VALUES(interests),
                extra_information = VALUES(extra_information),
                is_baseline = VALUES(is_baseline),
                notification_status = VALUES(notification_status),
                officer_message_id = VALUES(officer_message_id),
                officer_message_url = VALUES(officer_message_url),
                poll_message_id = VALUES(poll_message_id),
                poll_message_url = VALUES(poll_message_url),
                poll_created_at = VALUES(poll_created_at),
                vote_reminder_12h_checked_at = VALUES(vote_reminder_12h_checked_at),
                vote_reminder_12h_message_id = VALUES(vote_reminder_12h_message_id),
                vote_reminder_18h_checked_at = VALUES(vote_reminder_18h_checked_at),
                vote_reminder_18h_message_id = VALUES(vote_reminder_18h_message_id),
                last_error = VALUES(last_error),
                notified_at = VALUES(notified_at),
                storage_origin = VALUES(storage_origin)
        `;
    }

    async transaction(work) {
        if (typeof this.db?.getConnection !== 'function') return work(this.db);
        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally {
            connection.release();
        }
    }

    async upsertMysqlRecords(records) {
        if (!records.length) return;
        await this.transaction(async connection => {
            for (const record of records) {
                await connection.query(this.upsertSql(), this.recordValues(record));
            }
        });
    }

    async mysqlRecordsByPostId(postIds) {
        const ids = [...new Set((postIds || []).map(String).filter(Boolean))];
        const records = new Map();
        for (let index = 0; index < ids.length; index += 500) {
            const chunk = ids.slice(index, index + 500);
            const [rows] = await this.db.query(
                `SELECT * FROM guild_applications WHERE post_id IN (${chunk.map(() => '?').join(', ')})`,
                chunk
            );
            for (const row of rows) records.set(String(row.post_id), this.rowToRecord(row));
        }
        return records;
    }

    noteMysqlFailure(error) {
        if (this.db?.isDatabaseUnavailableError && !this.db.isDatabaseUnavailableError(error)) {
            console.error('[CC LOG] Unexpected MySQL Guild Application storage error:', error);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const prefix = this.storageMode === 'mysql'
            ? '[CC LOG] MySQL Guild Application storage failed in STORAGE_MODE=mysql. Using JSON fallback:'
            : '[CC LOG] MySQL Guild Application storage unavailable. Using JSON fallback:';
        const errorCode = this.db?.getErrorCode?.(error) || error?.causeCode || error?.code || error?.message || error;
        console.warn(prefix, errorCode);
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log('[CC LOG] MySQL Guild Application storage restored; JSON fallback is synchronized.');
    }

    noteLocalStorageFailure(error) {
        if (this.localStorageOutage) return;
        this.localStorageOutage = true;
        if (error.code === 'ENOSPC' || error.code === 'EDQUOT') {
            console.error(`[CC LOG] Guild Application local JSON storage cannot write (${error.code}). Check container quota, free space, and inodes; any previous complete file is preserved. Retries continue.`);
        } else {
            console.error('[CC LOG] Guild Application local JSON storage failed; processing will retry:', error);
        }
    }

    mergeRecords(data, records, { pendingSync }) {
        const byId = new Map(data.records.map(record => [String(record.postId), this.normalizeRecord(record)]));
        for (const record of records) byId.set(String(record.postId), this.normalizeRecord(record));
        data.records = [...byId.values()].sort((a, b) => numericPostId(a.postId) - numericPostId(b.postId));
        data.pendingSync = pendingSync;
        return data;
    }

    async removeStoredImageUrlsNow(imageUrls) {
        const ignoredUrls = new Set((imageUrls || []).map(normalizeImageUrl).filter(Boolean));
        if (!ignoredUrls.size) return false;

        const removeKnownUrls = urls => (Array.isArray(urls) ? urls : [])
            .filter(url => !ignoredUrls.has(normalizeImageUrl(url)) && !isDecorativeImageUrl(url));
        const data = this.readData();
        let localChanged = false;
        data.records = data.records.map(record => {
            const imageUrlsBefore = Array.isArray(record.imageUrls) ? record.imageUrls : [];
            const imageUrlsAfter = removeKnownUrls(imageUrlsBefore);
            if (imageUrlsBefore.length === imageUrlsAfter.length) return record;
            localChanged = true;
            return { ...record, imageUrls: imageUrlsAfter };
        });
        if (localChanged) this.writeData(data);

        if (this.storageMode === 'json' || !this.canUseMysql()) return localChanged;

        try {
            const [rows] = await this.db.query(`
                SELECT post_id, image_urls
                FROM guild_applications
                WHERE image_urls IS NOT NULL AND image_urls <> '[]'
            `);
            const updates = rows.map(row => {
                const before = parseJson(row.image_urls, []);
                const after = removeKnownUrls(before);
                return before.length === after.length ? null : { postId: String(row.post_id), imageUrls: after };
            }).filter(Boolean);
            if (!updates.length) return localChanged;

            await this.transaction(async connection => {
                for (const update of updates) {
                    await connection.query(
                        'UPDATE guild_applications SET image_urls = ? WHERE post_id = ?',
                        [JSON.stringify(update.imageUrls), update.postId]
                    );
                }
            });
            this.noteMysqlRestored();
            return true;
        } catch (error) {
            // A cleanup miss should not hold up the monitor or create a fallback record by itself.
            this.noteMysqlFailure(error);
            return localChanged;
        }
    }

    removeStoredImageUrls(imageUrls) {
        return this.enqueue(() => this.removeStoredImageUrlsNow(imageUrls));
    }

    updateCheckpointFromRecords(data, records) {
        const checkpoint = {
            lastPage: 1,
            lastPostId: null,
            lastScanAt: null,
            latestApplications: {},
            ...(data.checkpoint || {})
        };

        for (const record of records) {
            checkpoint.lastPage = Math.max(Number(checkpoint.lastPage || 1), Number(record.pageNumber || 1));
            if (numericPostId(record.postId) > numericPostId(checkpoint.lastPostId)) checkpoint.lastPostId = String(record.postId);
            if (record.classification !== CLASSIFICATIONS.APPLICATION || !record.postedAt) continue;
            const key = normalizeUserKey(record.forumUserId, record.forumUsername);
            if (!key) continue;
            const existing = checkpoint.latestApplications[key];
            if (!existing || new Date(record.postedAt) > new Date(existing.postedAt)) {
                checkpoint.latestApplications[key] = {
                    postId: String(record.postId),
                    postedAt: record.postedAt,
                    forumUsername: record.forumUsername || null
                };
            }
        }
        data.checkpoint = checkpoint;
        return data;
    }

    async syncFallbackNow() {
        const data = this.readData();
        if (data.source !== JSON_SOURCES.MYSQL_FALLBACK || !data.pendingSync || !data.records.length) return false;
        if (!this.canUseMysql()) throw new Error('MySQL is not configured for Guild Application synchronization.');

        const existingById = await this.mysqlRecordsByPostId(data.records.map(record => record.postId));
        const records = data.records.map(record => ({
            ...mergeDeliveryState(record, existingById.get(String(record.postId))),
            storageOrigin: JSON_SOURCES.MYSQL_FALLBACK
        }));
        await this.upsertMysqlRecords(records);
        data.records = [];
        data.pendingSync = false;
        data.source = JSON_SOURCES.MYSQL_FALLBACK;
        this.writeData(data);
        this.noteMysqlRestored();
        return true;
    }

    syncFallback() {
        return this.enqueue(() => this.syncFallbackNow());
    }

    async saveRecordsNow(records) {
        if (!records.length) return { storageOrigin: this.source(), records: [] };
        const normalized = records.map(record => this.normalizeRecord(record));

        if (this.storageMode === 'json') {
            const saved = normalized.map(record => ({ ...record, storageOrigin: JSON_SOURCES.JSON_ONLY }));
            const data = this.updateCheckpointFromRecords(
                this.mergeRecords(this.readData(), saved, { pendingSync: false }),
                saved
            );
            data.source = JSON_SOURCES.JSON_ONLY;
            this.writeData(data);
            return { storageOrigin: JSON_SOURCES.JSON_ONLY, records: saved };
        }

        try {
            await this.syncFallbackNow();
            if (!this.canUseMysql()) throw new Error('MySQL is not configured.');
            const saved = normalized.map(record => ({
                ...record,
                storageOrigin: record.storageOrigin === JSON_SOURCES.MYSQL_FALLBACK
                    ? JSON_SOURCES.MYSQL_FALLBACK
                    : 'mysql'
            }));
            await this.upsertMysqlRecords(saved);
            const data = this.updateCheckpointFromRecords(this.readData(), saved);
            data.source = JSON_SOURCES.MYSQL_FALLBACK;
            data.records = [];
            data.pendingSync = false;
            this.writeData(data);
            this.noteMysqlRestored();
            return { storageOrigin: 'mysql', records: saved };
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            const saved = normalized.map(record => ({ ...record, storageOrigin: JSON_SOURCES.MYSQL_FALLBACK }));
            const data = this.updateCheckpointFromRecords(
                this.mergeRecords(this.readData(), saved, { pendingSync: true }),
                saved
            );
            data.source = JSON_SOURCES.MYSQL_FALLBACK;
            this.writeData(data);
            return { storageOrigin: JSON_SOURCES.MYSQL_FALLBACK, records: saved };
        }
    }

    saveRecords(records) {
        return this.enqueue(() => this.saveRecordsNow(records));
    }

    async saveRecord(record) {
        const result = await this.saveRecords([record]);
        return result.records[0];
    }

    async initialize() {
        this.ensureFile();
        const current = this.readData();
        if (this.storageMode === 'json' && current.source === JSON_SOURCES.MYSQL_FALLBACK) {
            if (current.pendingSync && current.records.length) {
                throw new Error('Guild Application JSON mode cannot start while unsynced MySQL fallback records exist. Restore MySQL and sync them first.');
            }
            this.writeData(this.emptyData());
        } else if (this.storageMode !== 'json' && current.source === JSON_SOURCES.JSON_ONLY) {
            // Local test records are intentionally discarded here instead of ever being replayed into MySQL.
            const fresh = this.emptyData();
            fresh.source = JSON_SOURCES.MYSQL_FALLBACK;
            this.writeData(fresh);
        }
        if (this.storageMode !== 'json') {
            await this.syncFallback().catch(error => {
                if (error.guildApplicationStorage) throw error;
                this.noteMysqlFailure(error);
            });
        }
        return this.isInitialized();
    }

    async isInitialized() {
        const data = this.readData();
        if (data.initialized) return true;
        if (this.storageMode === 'json') return false;

        try {
            if (!this.canUseMysql()) return false;
            const [[row]] = await this.db.query('SELECT COUNT(*) AS total FROM guild_applications');
            if (Number(row?.total || 0) === 0) return false;
            await this.hydrateCheckpointFromMysql();
            return true;
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            return false;
        }
    }

    async hydrateCheckpointFromMysql() {
        const [[summary], [applications]] = await Promise.all([
            this.db.query('SELECT MAX(page_number) AS last_page, MAX(CAST(post_id AS UNSIGNED)) AS last_post_id FROM guild_applications'),
            this.db.query(`
                SELECT post_id, forum_user_id, forum_username, posted_at
                FROM guild_applications
                WHERE classification = 'application' AND posted_at IS NOT NULL
                ORDER BY posted_at ASC
            `)
        ]);
        const data = this.readData();
        data.initialized = true;
        data.checkpoint = {
            lastPage: Number(summary?.[0]?.last_page || 1),
            lastPostId: summary?.[0]?.last_post_id ? String(summary[0].last_post_id) : null,
            lastScanAt: new Date().toISOString(),
            latestApplications: {}
        };
        for (const row of applications) {
            this.updateCheckpointFromRecords(data, [this.rowToRecord({ ...row, classification: CLASSIFICATIONS.APPLICATION })]);
        }
        this.writeData(data);
        return data.checkpoint;
    }

    async markInitialized(checkpoint = {}) {
        return this.enqueue(async () => {
            const data = this.readData();
            data.initialized = true;
            data.checkpoint = { ...(data.checkpoint || {}), ...checkpoint };
            this.writeData(data);
            return data.checkpoint;
        });
    }

    async updateCheckpoint(patch = {}) {
        return this.enqueue(async () => {
            const data = this.readData();
            data.checkpoint = { ...(data.checkpoint || {}), ...patch };
            this.writeData(data);
            return data.checkpoint;
        });
    }

    getCheckpoint() {
        return this.readData().checkpoint || {
            lastPage: 1,
            lastPostId: null,
            lastScanAt: null,
            latestApplications: {}
        };
    }

    async knownPostIds(postIds) {
        const ids = [...new Set(postIds.map(String).filter(Boolean))];
        const data = this.readData();
        const known = new Set(data.records.filter(record => ids.includes(String(record.postId))).map(record => String(record.postId)));
        const checkpointId = numericPostId(data.checkpoint?.lastPostId);

        if (this.storageMode === 'json') return known;
        try {
            await this.syncFallback();
            if (!this.canUseMysql() || !ids.length) return known;
            for (let index = 0; index < ids.length; index += 500) {
                const chunk = ids.slice(index, index + 500);
                const [rows] = await this.db.query(
                    `SELECT post_id FROM guild_applications WHERE post_id IN (${chunk.map(() => '?').join(', ')})`,
                    chunk
                );
                rows.forEach(row => known.add(String(row.post_id)));
            }
            this.noteMysqlRestored();
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            for (const id of ids) {
                if (checkpointId && numericPostId(id) <= checkpointId) known.add(id);
            }
        }
        return known;
    }

    async latestApplicationFor(post) {
        const key = normalizeUserKey(post.forumUserId, post.forumUsername);
        const local = key ? this.readData().checkpoint?.latestApplications?.[key] || null : null;
        if (this.storageMode === 'json') return local;

        try {
            await this.syncFallback();
            if (!this.canUseMysql()) return local;
            const conditions = post.forumUserId
                ? ['forum_user_id = ?', [String(post.forumUserId)]]
                : ['LOWER(forum_username) = LOWER(?)', [String(post.forumUsername || '')]];
            const [rows] = await this.db.query(`
                SELECT post_id, forum_username, posted_at
                FROM guild_applications
                WHERE classification = 'application' AND ${conditions[0]}
                ORDER BY posted_at DESC
                LIMIT 1
            `, conditions[1]);
            const mysql = rows[0] ? {
                postId: String(rows[0].post_id),
                postedAt: fromSqlDate(rows[0].posted_at),
                forumUsername: rows[0].forum_username
            } : null;
            if (!local) return mysql;
            if (!mysql) return local;
            return new Date(local.postedAt) > new Date(mysql.postedAt) ? local : mysql;
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            return local;
        }
    }

    async getRecord(postId) {
        const local = this.readData().records.find(record => String(record.postId) === String(postId));
        if (local) return this.normalizeRecord(local);
        if (this.storageMode === 'json') return null;
        try {
            const [rows] = await this.db.query('SELECT * FROM guild_applications WHERE post_id = ? LIMIT 1', [String(postId)]);
            return rows[0] ? this.rowToRecord(rows[0]) : null;
        } catch (error) {
            this.noteMysqlFailure(error);
            return null;
        }
    }

    async pendingNotifications() {
        const localRecords = () => this.readData().records.filter(record => (
            record.classification === CLASSIFICATIONS.APPLICATION
            && !record.isBaseline
            && ['pending', 'error', 'officer_sent'].includes(record.notificationStatus)
        ));
        let local = localRecords();
        if (this.storageMode === 'json') return local;
        try {
            await this.syncFallback();
            local = localRecords();
            if (!this.canUseMysql()) return local;
            const [rows] = await this.db.query(`
                SELECT * FROM guild_applications
                WHERE classification = 'application'
                  AND is_baseline = 0
                  AND notification_status IN ('pending', 'error', 'officer_sent')
                ORDER BY posted_at ASC, CAST(post_id AS UNSIGNED) ASC
            `);
            const byId = new Map(rows.map(row => [String(row.post_id), this.rowToRecord(row)]));
            local.forEach(record => byId.set(String(record.postId), record));
            return [...byId.values()];
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            return local;
        }
    }

    async pendingNonApplicationAlerts() {
        const localRecords = () => this.readData().records.filter(record => (
            record.classification === CLASSIFICATIONS.NON_APPLICATION
            && !record.isBaseline
            && ['non_application_alert_pending', 'non_application_alert_error'].includes(record.notificationStatus)
        ));
        let local = localRecords();
        if (this.storageMode === 'json') return local;

        try {
            await this.syncFallback();
            local = localRecords();
            if (!this.canUseMysql()) return local;
            const [rows] = await this.db.query(`
                SELECT * FROM guild_applications
                WHERE classification = 'non_application'
                  AND is_baseline = 0
                  AND notification_status IN ('non_application_alert_pending', 'non_application_alert_error')
                ORDER BY posted_at ASC, CAST(post_id AS UNSIGNED) ASC
            `);
            const byId = new Map(rows.map(row => [String(row.post_id), this.rowToRecord(row)]));
            local.forEach(record => byId.set(String(record.postId), record));
            return [...byId.values()];
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            return local;
        }
    }

    async voteReminderCandidates(now = new Date()) {
        const localRecords = () => this.readData().records.filter(record => isVoteReminderCandidate(record, now));
        let local = localRecords();
        if (this.storageMode === 'json') return local;

        try {
            await this.syncFallback();
            local = localRecords();
            if (!this.canUseMysql()) return local;
            const twelveHoursAgo = new Date(now.getTime() - (12 * 60 * 60 * 1000));
            const eighteenHoursAgo = new Date(now.getTime() - (18 * 60 * 60 * 1000));
            const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
            const [rows] = await this.db.query(`
                SELECT * FROM guild_applications
                WHERE notification_status = 'notified'
                  AND poll_message_id IS NOT NULL
                  AND poll_message_url IS NOT NULL
                  AND officer_message_url IS NOT NULL
                  AND poll_created_at IS NOT NULL
                  AND poll_created_at <= ?
                  AND poll_created_at > ?
                  AND (
                    vote_reminder_12h_checked_at IS NULL
                    OR (poll_created_at <= ? AND vote_reminder_18h_checked_at IS NULL)
                  )
                ORDER BY poll_created_at ASC
            `, [toSqlDate(twelveHoursAgo), toSqlDate(twentyFourHoursAgo), toSqlDate(eighteenHoursAgo)]);
            const byId = new Map(rows.map(row => [String(row.post_id), this.rowToRecord(row)]));
            local.forEach(record => byId.set(String(record.postId), record));
            this.noteMysqlRestored();
            return [...byId.values()].filter(record => isVoteReminderCandidate(record, now));
        } catch (error) {
            if (error.guildApplicationStorage) throw error;
            this.noteMysqlFailure(error);
            return local;
        }
    }

    startSyncLoop() {
        if (this.storageMode === 'json' || this.syncInterval) return;
        this.syncInterval = setInterval(() => {
            this.syncFallback().catch(error => {
                if (error.guildApplicationStorage) this.noteLocalStorageFailure(error);
                else this.noteMysqlFailure(error);
            });
        }, this.syncIntervalMs);
        this.syncInterval.unref?.();
    }

    stopSyncLoop() {
        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = null;
    }
}

module.exports = {
    GuildApplicationStore,
    fromSqlDate,
    isVoteReminderCandidate,
    mergeDeliveryState,
    normalizeUserKey,
    normalizeImageUrl,
    isDecorativeImageUrl,
    parseStorageMode,
    toSqlDate
};
