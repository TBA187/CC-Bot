// Stores each server's PvP results and replays durable JSON operations after MySQL recovers.
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../../../utils/jsonFile.js');

const STORAGE_VERSION = 1;
const JSON_SOURCES = {
    MYSQL_FALLBACK: 'mysql_fallback',
    JSON_ONLY: 'json_only'
};
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'pvp_king_data.json');
const STORAGE_SYNC_INTERVAL_MS = 30 * 1000;
const DATABASE_UNAVAILABLE_MESSAGE = 'Database is currently unavailable. Please try again later.';
const PVP_COOLDOWN_MS = 48 * 60 * 60 * 1000;

class PvpStorageUnavailableError extends Error {
    constructor(cause) {
        super(DATABASE_UNAVAILABLE_MESSAGE);
        this.name = 'PvpStorageUnavailableError';
        this.code = 'PVP_DATABASE_UNAVAILABLE';
        this.cause = cause;
    }
}

function normalizeSql(sql) {
    return String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseStorageMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
}

function toSqlDate(value = new Date()) {
    if (value === null || value === undefined || value === 0) return null;
    if (typeof value === 'string') {
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return toSqlDate(parsed);
        return value;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneRow(row) {
    if (!row) return row;

    return { ...row };
}

function compareSqlDatesAsc(a, b) {
    return new Date(`${toSqlDate(a) || '1970-01-01 00:00:00'}Z`) - new Date(`${toSqlDate(b) || '1970-01-01 00:00:00'}Z`);
}

function createSyncEventId(prefix = 'pvp') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

class PvpKingStorage {
    constructor(options = {}) {
        this.server = options.server ?? 'gold';
        if (!['gold', 'silver'].includes(this.server)) {
            throw new Error(`Unsupported PvP King server: ${this.server}`);
        }
        this.db = options.db;
        this.storageMode = parseStorageMode(options.storageMode ?? process.env.STORAGE_MODE);
        this.dataFile = options.dataFile || (this.server === 'silver'
            ? path.join(DEFAULT_DATA_DIR, 'pvp_king_silver_data.json')
            : DEFAULT_DATA_FILE);
        this.tempFile = `${this.dataFile}.tmp`;
        this.syncIntervalMs = options.syncIntervalMs || STORAGE_SYNC_INTERVAL_MS;
        this.syncInterval = null;
        this.syncRunning = false;
        this.syncPromise = null;
        this.storageQueue = Promise.resolve();
        this.pendingWrite = Promise.resolve();
        this.state = this.createEmptyState();
        this.mysqlOutage = false;
    }

    createEmptyState() {
        return {
            stats: new Map(),
            cooldowns: new Map(),
            history: [],
            nextCooldownId: 1,
            nextHistoryId: 1,
            operations: []
        };
    }

    getJsonSource() {
        return this.storageMode === 'json' ? JSON_SOURCES.JSON_ONLY : JSON_SOURCES.MYSQL_FALLBACK;
    }

    hasMysqlCredentials() {
        return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
    }

    canUseMysql() {
        return this.storageMode !== 'json' && this.db && this.hasMysqlCredentials();
    }

    canUseMysqlTransactions() {
        return this.canUseMysql() && typeof this.db.getConnection === 'function';
    }

    noteMysqlFailure(err) {
        if (this.db?.isClosed || err?.code === 'BOT_SHUTTING_DOWN') return;
        if (
            this.db?.isDatabaseUnavailableError &&
            err?.code !== 'PVP_DATABASE_UNAVAILABLE' &&
            !this.db.isDatabaseUnavailableError(err)
        ) {
            console.error('[CC LOG] Unexpected MySQL PvP King storage error:', err);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const errorCode = this.db?.getErrorCode?.(err) || err?.causeCode || err?.cause?.code || err?.code || err?.message || err;
        console.warn(
            `[CC LOG] MySQL PvP King ${this.server === 'silver' ? 'Silver' : 'Gold'} storage unavailable (${errorCode}). ` +
            'Using the synchronized JSON snapshot; writes will queue for recovery.'
        );
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log(`[CC LOG] MySQL PvP King ${this.server === 'silver' ? 'Silver' : 'Gold'} storage restored; pending JSON operations will synchronize automatically.`);
    }

    // The JSON interpreter and queued operations use the same logical table
    // names. Translate only at the MySQL boundary, including transactions.
    sqlForServer(sql) {
        if (this.server === 'gold') return sql;
        return sql.replace(/\bpvp_king_(stats|history|cooldowns)\b/g, 'pvp_king_silver_$1');
    }

    async mysqlQuery(sql, params = [], retries) {
        try {
            const result = await this.db.query(this.sqlForServer(sql), params, retries);
            this.noteMysqlRestored();
            return result;
        } catch (err) {
            if (err.code !== 'PVP_STALE_REVERSE') this.noteMysqlFailure(err);
            throw err;
        }
    }

    loadMysqlFallbackSnapshot() {
        const store = this.readJsonStore();
        if (store.source !== JSON_SOURCES.MYSQL_FALLBACK) return false;
        this.state = this.hydrateState(store.state);
        return true;
    }

    ensureJsonStore() {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });

        if (!fs.existsSync(this.dataFile)) {
            this.writeJsonStore(this.getJsonSource(), false);
        }
    }

    serializeState() {
        return {
            stats: [...this.state.stats.values()].map(cloneRow),
            cooldowns: [...this.state.cooldowns.values()].map(cloneRow),
            history: this.state.history.map(cloneRow),
            nextCooldownId: this.state.nextCooldownId,
            nextHistoryId: this.state.nextHistoryId,
            operations: this.state.operations.map(op => ({ ...op }))
        };
    }

    hydrateState(rawState = {}) {
        const state = this.createEmptyState();

        for (const row of Array.isArray(rawState.stats) ? rawState.stats : []) {
            if (!row?.user_id) continue;
            state.stats.set(String(row.user_id), this.normalizeStatsRow(row));
        }

        for (const row of Array.isArray(rawState.cooldowns) ? rawState.cooldowns : []) {
            if (!row?.challenger_id) continue;
            const cooldown = this.normalizeCooldownRow(row);
            state.cooldowns.set(String(cooldown.challenger_id), cooldown);
            state.nextCooldownId = Math.max(state.nextCooldownId, toNumber(cooldown.id, 0) + 1);
        }

        for (const row of Array.isArray(rawState.history) ? rawState.history : []) {
            if (!row?.king_id) continue;
            const history = this.normalizeHistoryRow(row);
            state.history.push(history);
            state.nextHistoryId = Math.max(state.nextHistoryId, toNumber(history.id, 0) + 1);
        }

        state.history.sort((a, b) => toNumber(a.id) - toNumber(b.id));
        state.operations = (Array.isArray(rawState.operations) ? rawState.operations : []).map(op => ({ ...op }));
        state.nextCooldownId = Math.max(state.nextCooldownId, toNumber(rawState.nextCooldownId, state.nextCooldownId));
        state.nextHistoryId = Math.max(state.nextHistoryId, toNumber(rawState.nextHistoryId, state.nextHistoryId));

        return state;
    }

    readJsonStore() {
        this.ensureJsonStore();

        try {
            const stored = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            const source = stored?.source ?? this.getJsonSource();
            const state = stored?.state ?? {};
            const pendingSync = stored?.pendingSync === true || (source === JSON_SOURCES.MYSQL_FALLBACK && Array.isArray(state.operations) && state.operations.length > 0);

            return {
                version: STORAGE_VERSION,
                source,
                pendingSync,
                state
            };
        } catch (err) {
            console.error('[CC LOG] Failed to read PvP King JSON storage:', err);
            return {
                version: STORAGE_VERSION,
                source: this.getJsonSource(),
                pendingSync: false,
                state: this.serializeState()
            };
        }
    }

    writeJsonStore(source = this.getJsonSource(), pendingSync = false, options = {}) {
        try {
            fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
            // Keep a read-only mirror even when MySQL is fully synchronized. The
            // operations array (not the snapshot rows) determines what must replay.
            const state = this.serializeState();
            return writeJsonIfChanged(this.dataFile, this.tempFile, {
                version: STORAGE_VERSION,
                source,
                pendingSync,
                state
            });
        } catch (err) {
            console.error('[CC LOG] Failed to save PvP King JSON storage:', err);
            if (options.throwOnError) throw err;
            return false;
        }
    }

    writeJsonStoreOrThrow(source = this.getJsonSource(), pendingSync = false) {
        return this.writeJsonStore(source, pendingSync, { throwOnError: true });
    }

    queueJsonSave(source = this.getJsonSource(), pendingSync = false) {
        this.pendingWrite = this.pendingWrite
            .catch(() => { })
            .then(() => this.writeJsonStore(source, pendingSync))
            .catch(err => console.error('[CC LOG] Failed to persist PvP King JSON storage:', err));
    }

    enqueueStorage(task) {
        const run = this.storageQueue
            .catch(() => { })
            .then(task);

        this.storageQueue = run.catch(() => { });
        return run;
    }

    normalizeStatsRow(row) {
        return {
            user_id: String(row.user_id),
            king_name: row.king_name ?? '',
            total_wins: toNumber(row.total_wins),
            total_crown_losses: toNumber(row.total_crown_losses),
            current_streak: toNumber(row.current_streak),
            longest_streak: toNumber(row.longest_streak),
            first_crowned: toSqlDate(row.first_crowned),
            crowned_at: toSqlDate(row.crowned_at)
        };
    }

    normalizeCooldownRow(row) {
        return {
            id: toNumber(row.id, this.state.nextCooldownId++),
            challenger_id: String(row.challenger_id),
            challenger_name: row.challenger_name ?? '',
            king_id: row.king_id == null ? null : String(row.king_id),
            king_name: row.king_name ?? '',
            last_challenge: toSqlDate(row.last_challenge),
            notify_on_expire: toNumber(row.notify_on_expire)
        };
    }

    normalizeHistoryRow(row) {
        return {
            id: toNumber(row.id, this.state.nextHistoryId++),
            king_id: String(row.king_id),
            king_name: row.king_name ?? '',
            type: row.type ?? 'crown',
            total_wins_after: toNumber(row.total_wins_after),
            streak_after: toNumber(row.streak_after),
            longest_streak_after: toNumber(row.longest_streak_after),
            last_crowned: toSqlDate(row.last_crowned),
            created_at: toSqlDate(row.created_at),
            sync_event_id: row.sync_event_id ?? null
        };
    }

    async restore() {
        const store = this.readJsonStore();

        if (this.storageMode === 'json') {
            this.state = store.source === JSON_SOURCES.JSON_ONLY
                ? this.hydrateState(store.state)
                : this.createEmptyState();
            this.writeJsonStore(JSON_SOURCES.JSON_ONLY, false);
            return false;
        }

        if (this.canUseMysql()) {
            try {
                await this.loadMysqlState();
                const synced = await this.syncFallbackOperations();
                if (!synced) {
                    this.writeJsonStore(JSON_SOURCES.MYSQL_FALLBACK, false);
                }
                return true;
            } catch (err) {
                this.noteMysqlFailure(err);
            }
        }

        if (store.source === JSON_SOURCES.MYSQL_FALLBACK) {
            this.state = this.hydrateState(store.state);
        }

        return false;
    }

    async loadMysqlState() {
        let results;
        try {
            results = await Promise.all([
                this.db.query(this.sqlForServer('SELECT user_id, king_name, total_wins, total_crown_losses, current_streak, longest_streak, first_crowned, crowned_at FROM pvp_king_stats')),
                this.db.query(this.sqlForServer('SELECT id, challenger_id, challenger_name, king_id, king_name, last_challenge, notify_on_expire FROM pvp_king_cooldowns')),
                this.db.query(this.sqlForServer('SELECT * FROM pvp_king_history ORDER BY id ASC'))
            ]);
            this.noteMysqlRestored();
        } catch (err) {
            this.noteMysqlFailure(err);
            throw err;
        }
        const [[statsRows], [cooldownRows], [historyRows]] = results;

        this.state = this.hydrateState({
            stats: statsRows,
            cooldowns: cooldownRows,
            history: historyRows,
            operations: []
        });

    }

    async withMysqlTransaction(work) {
        if (!this.canUseMysqlTransactions()) {
            throw new PvpStorageUnavailableError(new Error('MySQL transactions are unavailable'));
        }

        let connection;
        try {
            connection = await this.db.getConnection();
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            this.noteMysqlRestored();
            return result;
        } catch (err) {
            if (err.code !== 'PVP_STALE_REVERSE') this.noteMysqlFailure(err);
            if (connection) {
                await connection.rollback().catch(rollbackErr => {
                    console.warn('[CC LOG] PvP King transaction rollback failed:', rollbackErr.code || rollbackErr.message);
                });
            }
            throw err;
        } finally {
            connection?.release();
        }
    }

    async transactionQuery(connection, sql, params = []) {
        return connection.query(this.sqlForServer(sql), params);
    }

    startSyncLoop() {
        if (this.storageMode === 'json' || this.syncInterval) return;

        this.syncInterval = setInterval(() => {
            this.syncFallbackOperations().catch(err => {
                this.noteMysqlFailure(err);
            });
        }, this.syncIntervalMs);

        this.syncInterval.unref?.();
    }

    stopSyncLoop() {
        if (!this.syncInterval) return;
        clearInterval(this.syncInterval);
        this.syncInterval = null;
    }

    async syncFallbackOperations() {
        if (this.storageMode === 'json') return false;
        if (this.syncPromise) return this.syncPromise;

        this.syncPromise = this.enqueueStorage(() => this.syncFallbackOperationsNow())
            .finally(() => {
                this.syncPromise = null;
            });

        return this.syncPromise;
    }

    async syncFallbackOperationsNow() {
        if (this.storageMode === 'json' || !this.canUseMysqlTransactions()) return false;

        const store = this.readJsonStore();
        if (store.source !== JSON_SOURCES.MYSQL_FALLBACK || !store.pendingSync) return false;

        const fallbackState = this.hydrateState(store.state);
        if (fallbackState.operations.length === 0) return false;

        this.syncRunning = true;
        try {
            this.state = fallbackState;
            await this.withMysqlTransaction(async connection => {
                for (const op of fallbackState.operations) {
                    await this.replayOperation(op, connection);
                }
            });

            await this.loadMysqlState();
            this.state.operations = [];
            this.writeJsonStoreOrThrow(JSON_SOURCES.MYSQL_FALLBACK, false);
            console.log(`[CC LOG] Synced ${fallbackState.operations.length} fallback PvP King operation(s) to MySQL.`);
            return true;
        } finally {
            this.syncRunning = false;
        }
    }

    async replayOperation(op, connection = null) {
        if (op.type === 'crownEvent') return this.replayCrownEvent(op, connection);
        if (op.type === 'reverseEvent') return this.replayReverseEvent(op, connection);

        const query = (sql, params = []) => connection
            ? this.transactionQuery(connection, sql, params)
            : this.mysqlQuery(sql, params);

        switch (op.type) {
            case 'upsertCooldown':
                return query(`
                    INSERT INTO pvp_king_cooldowns (challenger_id, challenger_name, king_id, king_name, last_challenge, notify_on_expire)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        challenger_name = VALUES(challenger_name),
                        king_id = VALUES(king_id),
                        king_name = VALUES(king_name),
                        last_challenge = VALUES(last_challenge),
                        notify_on_expire = GREATEST(notify_on_expire, VALUES(notify_on_expire))
                `, [op.challenger_id, op.challenger_name, op.king_id, op.king_name, op.last_challenge, op.notify_on_expire ?? 0]);
            case 'setCooldownNotify':
                return query(
                    'UPDATE pvp_king_cooldowns SET notify_on_expire = ? WHERE challenger_id = ?',
                    [op.notify_on_expire ? 1 : 0, op.challenger_id]
                );
            case 'insertNotifyCooldown':
                return query(`
                    INSERT INTO pvp_king_cooldowns
                    (challenger_id, challenger_name, king_id, king_name, last_challenge, notify_on_expire)
                    VALUES (?, ?, ?, ?, NULL, ?)
                    ON DUPLICATE KEY UPDATE
                        challenger_name = VALUES(challenger_name),
                        notify_on_expire = VALUES(notify_on_expire)
                `, [op.challenger_id, op.challenger_name, op.king_id, op.king_name, op.notify_on_expire ? 1 : 0]);
            case 'defenseStats':
                return query(`
                    INSERT INTO pvp_king_stats (user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)
                    VALUES (?, ?, 1, 1, 1, ?)
                    ON DUPLICATE KEY UPDATE
                        king_name = VALUES(king_name),
                        total_wins = total_wins + 1,
                        current_streak = current_streak + 1,
                        longest_streak = GREATEST(longest_streak, current_streak),
                        crowned_at = VALUES(crowned_at)
                `, [op.user_id, op.king_name, op.crowned_at]);
            case 'markOldKingLoss':
                return query(`
                    UPDATE pvp_king_stats
                    SET
                        total_crown_losses = total_crown_losses + 1,
                        current_streak = 0
                    WHERE user_id = ?
                `, [op.user_id]);
            case 'resetCooldownsForKing':
                return query('UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE king_id = ?', [op.king_id]);
            case 'newKingStats':
                return query(`
                    INSERT INTO pvp_king_stats
                        (user_id, king_name, total_wins, current_streak, longest_streak, first_crowned, crowned_at)
                    VALUES (?, ?, 1, 1, 1, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        king_name = VALUES(king_name),
                        total_wins = total_wins + 1,
                        current_streak = 1,
                        longest_streak = GREATEST(longest_streak, 1),
                        crowned_at = VALUES(crowned_at)
                `, [op.user_id, op.king_name, op.first_crowned, op.crowned_at]);
            case 'insertHistory':
                return query(`
                    INSERT INTO pvp_king_history
                        (king_id, king_name, type, total_wins_after, streak_after, longest_streak_after, last_crowned, created_at, sync_event_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        sync_event_id = VALUES(sync_event_id)
                `, [
                    op.king_id,
                    op.king_name,
                    op.history_type,
                    op.total_wins_after,
                    op.streak_after,
                    op.longest_streak_after,
                    op.last_crowned,
                    op.created_at,
                    op.sync_event_id
                ]);
            case 'deleteHistory':
                if (op.sync_event_id) {
                    return query('DELETE FROM pvp_king_history WHERE sync_event_id = ?', [op.sync_event_id]);
                }
                return query('DELETE FROM pvp_king_history WHERE id = ?', [op.id]);
            case 'deleteStats':
                return query('DELETE FROM pvp_king_stats WHERE user_id = ?', [op.user_id]);
            case 'updateWrongKingStats':
                return query(`
                    UPDATE pvp_king_stats
                    SET
                        total_wins = GREATEST(total_wins - 1, 0),
                        current_streak = 0,
                        longest_streak = ?,
                        crowned_at = ?
                    WHERE user_id = ?
                `, [op.longest_streak, op.crowned_at, op.user_id]);
            case 'updatePrevKingStats':
                if (op.decrement_losses) {
                    return query(`
                        UPDATE pvp_king_stats
                        SET
                            total_crown_losses = GREATEST(total_crown_losses - 1, 0),
                            current_streak = ?
                        WHERE user_id = ?
                    `, [op.current_streak, op.user_id]);
                }
                return query('UPDATE pvp_king_stats SET current_streak = ? WHERE user_id = ?', [op.current_streak, op.user_id]);
            case 'resetCooldownsByIds':
                if (!Array.isArray(op.ids) || op.ids.length === 0) return null;
                return query(
                    `UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE id IN (${op.ids.map(() => '?').join(',')})`,
                    op.ids
                );
            default:
                throw new Error(`Unsupported PvP King fallback operation: ${op.type}`);
        }
    }

    async query(sql, params = [], retries) {
        const normalized = normalizeSql(sql);
        const action = this.createAction(normalized, params);
        const isPvpQuery = normalized.includes('pvp_king_stats') || normalized.includes('pvp_king_history') || normalized.includes('pvp_king_cooldowns');

        if (!isPvpQuery) {
            return this.mysqlQuery(sql, params, retries);
        }

        if (!action) {
            if (!normalized.startsWith('select')) {
                if (this.storageMode === 'json') {
                    throw new Error(`Unsupported PvP King JSON write: ${normalized}`);
                }

                return this.mysqlQuery(sql, params, retries);
            }

            if (this.storageMode === 'json') return this.runLocalSelect(normalized, params);
            try {
                return await this.mysqlQuery(sql, params, retries);
            } catch (err) {
                if (this.loadMysqlFallbackSnapshot()) return this.runLocalSelect(normalized, params);
                throw new PvpStorageUnavailableError(err);
            }
        }

        if (action.kind === 'select') {
            if (this.storageMode === 'json') return this.runLocalSelect(normalized, params);

            const readSource = await this.ensureFreshStateForRead();
            if (readSource === 'local') return this.runLocalSelect(normalized, params);

            if (!this.canUseMysql()) {
                throw new PvpStorageUnavailableError();
            }

            try {
                return await this.mysqlQuery(sql, params, retries);
            } catch (err) {
                if (this.loadMysqlFallbackSnapshot()) return this.runLocalSelect(normalized, params);
                throw new PvpStorageUnavailableError(err);
            }
        }

        return this.enqueueStorage(() => this.executeSingleWrite(sql, params, retries, action.operation));
    }

    async ensureFreshStateForRead() {
        if (this.storageMode === 'json') {
            return 'local';
        }

        const store = this.readJsonStore();
        const hasPendingFallback = store.source === JSON_SOURCES.MYSQL_FALLBACK && store.pendingSync;
        if (!hasPendingFallback) {
            return 'mysql';
        }

        this.state = this.hydrateState(store.state);
        try {
            await this.syncFallbackOperations();
            return 'mysql';
        } catch (err) {
            this.noteMysqlFailure(err);
            const latestStore = this.readJsonStore();
            this.state = this.hydrateState(latestStore.state);
            return 'local';
        }
    }

    async executeSingleWrite(sql, params, retries, op) {
        if (this.storageMode === 'json') {
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.JSON_ONLY, false);
        }

        try {
            await this.syncFallbackOperationsNow().catch(err => {
                this.noteMysqlFailure(err);
            });

            if (!this.canUseMysql()) {
                throw new PvpStorageUnavailableError();
            }

            const result = await this.mysqlQuery(sql, params, retries);
            const localOp = op.type === 'insertHistory'
                ? { ...op, id: result?.[0]?.insertId, sync_event_id: null }
                : op;
            this.applyOperation(localOp, false);
            this.writeJsonStore(JSON_SOURCES.MYSQL_FALLBACK, false);
            return result;
        } catch (err) {
            this.noteMysqlFailure(err);
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.MYSQL_FALLBACK, true);
        }
    }

    applyOperationWithJsonPersistence(op, source, pendingSync) {
        const previousState = this.serializeState();
        const result = this.applyOperation(op, pendingSync);

        try {
            this.writeJsonStoreOrThrow(source, pendingSync);
            return result;
        } catch (err) {
            this.state = this.hydrateState(previousState);
            throw new PvpStorageUnavailableError(err);
        }
    }

    async recordCrownEvent(options) {
        return this.enqueueStorage(() => this.recordCrownEventNow(options));
    }

    async recordCrownEventNow(options) {
        const op = {
            type: 'crownEvent',
            sync_event_id: options.syncEventId || createSyncEventId('pvp_crown'),
            created_at: toSqlDate(options.createdAt || new Date()),
            new_king_id: String(options.newKingId),
            new_king_name: options.newKingName,
            old_king_id: options.oldKingId ? String(options.oldKingId) : null,
            old_king_name: options.oldKingName ?? null,
            is_defense: options.isDefense ? 1 : 0
        };

        if (this.storageMode === 'json') {
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.JSON_ONLY, false);
        }

        try {
            await this.syncFallbackOperationsNow().catch(err => {
                this.noteMysqlFailure(err);
            });

            if (!this.canUseMysqlTransactions()) {
                throw new PvpStorageUnavailableError();
            }

            const result = await this.runCrownEventMysql(op);
            await this.loadMysqlState();
            this.writeJsonStore(JSON_SOURCES.MYSQL_FALLBACK, false);
            return result;
        } catch (err) {
            this.noteMysqlFailure(err);
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.MYSQL_FALLBACK, true);
        }
    }

    async reverseLatestCrownEvent(options = {}) {
        return this.enqueueStorage(() => this.reverseLatestCrownEventNow(options));
    }

    async reverseLatestCrownEventNow(options = {}) {
        const op = {
            type: 'reverseEvent',
            sync_event_id: options.syncEventId || createSyncEventId('pvp_reverse'),
            created_at: toSqlDate(options.createdAt || new Date()),
            expected_history_id: toNumber(options.expectedHistoryId)
        };

        if (this.storageMode === 'json') {
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.JSON_ONLY, false);
        }

        try {
            await this.syncFallbackOperationsNow().catch(err => {
                this.noteMysqlFailure(err);
            });

            if (!this.canUseMysqlTransactions()) {
                throw new PvpStorageUnavailableError();
            }

            const result = await this.runReverseEventMysql(op);
            await this.loadMysqlState();
            this.writeJsonStore(JSON_SOURCES.MYSQL_FALLBACK, false);
            return result;
        } catch (err) {
            if (err.code === 'PVP_STALE_REVERSE') throw err;

            this.noteMysqlFailure(err);
            return this.applyOperationWithJsonPersistence(op, JSON_SOURCES.MYSQL_FALLBACK, true);
        }
    }

    getActiveNotificationRowsForKing(kingId, nowMs = Date.now()) {
        const rows = [];
        for (const row of this.state.cooldowns.values()) {
            if (String(row.king_id) !== String(kingId)) continue;
            if (toNumber(row.notify_on_expire) !== 1 || !row.last_challenge) continue;

            const lastChallengeMs = new Date(`${row.last_challenge}Z`).getTime();
            if (!Number.isNaN(lastChallengeMs) && nowMs - lastChallengeMs < PVP_COOLDOWN_MS) {
                rows.push(cloneRow(row));
            }
        }
        return rows;
    }

    latestLocalHistory(offset = 0) {
        return [...this.state.history]
            .sort((a, b) => toNumber(b.id) - toNumber(a.id))[offset] ?? null;
    }

    async runCrownEventMysql(op) {
        return this.withMysqlTransaction(async connection => {
            const [existingHistory] = await this.transactionQuery(
                connection,
                'SELECT id FROM pvp_king_history WHERE sync_event_id = ? LIMIT 1',
                [op.sync_event_id]
            );
            if (existingHistory.length > 0) {
                const [statsRows] = await this.transactionQuery(
                    connection,
                    'SELECT total_wins, total_crown_losses, current_streak, longest_streak, first_crowned, crowned_at FROM pvp_king_stats WHERE user_id = ?',
                    [op.new_king_id]
                );
                return { stats: statsRows[0] ?? null, history: null, usersToNotify: [], alreadyApplied: true };
            }

            const [[priorCrownedRow]] = await this.transactionQuery(
                connection,
                'SELECT crowned_at FROM pvp_king_stats WHERE user_id = ?',
                [op.new_king_id]
            );
            const priorCrownedAt = priorCrownedRow?.crowned_at ?? null;
            let usersToNotify = [];

            if (op.is_defense) {
                await this.transactionQuery(connection, `
                    INSERT INTO pvp_king_stats (user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)
                    VALUES (?, ?, 1, 1, 1, ?)
                    ON DUPLICATE KEY UPDATE
                        king_name = VALUES(king_name),
                        total_wins = total_wins + 1,
                        current_streak = current_streak + 1,
                        longest_streak = GREATEST(longest_streak, current_streak),
                        crowned_at = VALUES(crowned_at)
                `, [op.new_king_id, op.new_king_name, op.created_at]);
            } else {
                if (op.old_king_id) {
                    const [notifyRows] = await this.transactionQuery(connection, `
                        SELECT challenger_id, last_challenge
                        FROM pvp_king_cooldowns
                        WHERE king_id = ? AND notify_on_expire = 1 AND last_challenge IS NOT NULL
                    `, [op.old_king_id]);
                    usersToNotify = notifyRows.filter(row => {
                        const lastChallengeMs = new Date(`${toSqlDate(row.last_challenge)}Z`).getTime();
                        return !Number.isNaN(lastChallengeMs) && Date.now() - lastChallengeMs < PVP_COOLDOWN_MS;
                    });

                    await this.transactionQuery(connection, `
                        UPDATE pvp_king_stats
                        SET
                            total_crown_losses = total_crown_losses + 1,
                            current_streak = 0
                        WHERE user_id = ?
                    `, [op.old_king_id]);

                    await this.transactionQuery(
                        connection,
                        'UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE king_id = ?',
                        [op.old_king_id]
                    );

                    await this.transactionQuery(connection, `
                        INSERT INTO pvp_king_cooldowns (challenger_id, challenger_name, king_id, king_name, last_challenge)
                        VALUES (?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            challenger_name = VALUES(challenger_name),
                            king_id = VALUES(king_id),
                            king_name = VALUES(king_name),
                            last_challenge = VALUES(last_challenge)
                    `, [op.old_king_id, op.old_king_name, op.new_king_id, op.new_king_name, op.created_at]);
                }

                await this.transactionQuery(connection, `
                    INSERT INTO pvp_king_stats
                        (user_id, king_name, total_wins, current_streak, longest_streak, first_crowned, crowned_at)
                    VALUES (?, ?, 1, 1, 1, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        king_name = VALUES(king_name),
                        total_wins = total_wins + 1,
                        current_streak = 1,
                        longest_streak = GREATEST(longest_streak, 1),
                        crowned_at = VALUES(crowned_at)
                `, [op.new_king_id, op.new_king_name, op.created_at, op.created_at]);
            }

            const [[stats]] = await this.transactionQuery(connection, `
                SELECT total_wins, total_crown_losses, current_streak, longest_streak, first_crowned, crowned_at
                FROM pvp_king_stats
                WHERE user_id = ?
            `, [op.new_king_id]);

            const lastCrowned = priorCrownedAt ?? stats?.crowned_at ?? op.created_at;
            const [historyResult] = await this.transactionQuery(connection, `
                INSERT INTO pvp_king_history
                    (king_id, king_name, type, total_wins_after, streak_after, longest_streak_after, last_crowned, created_at, sync_event_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                op.new_king_id,
                op.new_king_name,
                op.is_defense ? 'defense' : 'crown',
                stats?.total_wins ?? 0,
                stats?.current_streak ?? 0,
                stats?.longest_streak ?? 0,
                toSqlDate(lastCrowned),
                op.created_at,
                op.sync_event_id
            ]);

            return {
                stats,
                history: {
                    id: historyResult.insertId,
                    king_id: op.new_king_id,
                    king_name: op.new_king_name,
                    type: op.is_defense ? 'defense' : 'crown',
                    total_wins_after: stats?.total_wins ?? 0,
                    streak_after: stats?.current_streak ?? 0,
                    longest_streak_after: stats?.longest_streak ?? 0,
                    last_crowned: toSqlDate(lastCrowned),
                    created_at: op.created_at,
                    sync_event_id: op.sync_event_id
                },
                usersToNotify
            };
        });
    }

    async replayCrownEvent(op, connection) {
        return this.runCrownEventMysqlWithConnection(op, connection);
    }

    async runCrownEventMysqlWithConnection(op, connection) {
        const [existingHistory] = await this.transactionQuery(
            connection,
            'SELECT id FROM pvp_king_history WHERE sync_event_id = ? LIMIT 1',
            [op.sync_event_id]
        );
        if (existingHistory.length > 0) return null;

        const [[priorCrownedRow]] = await this.transactionQuery(
            connection,
            'SELECT crowned_at FROM pvp_king_stats WHERE user_id = ?',
            [op.new_king_id]
        );
        const priorCrownedAt = priorCrownedRow?.crowned_at ?? null;

        if (op.is_defense) {
            await this.transactionQuery(connection, `
                INSERT INTO pvp_king_stats (user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)
                VALUES (?, ?, 1, 1, 1, ?)
                ON DUPLICATE KEY UPDATE
                    king_name = VALUES(king_name),
                    total_wins = total_wins + 1,
                    current_streak = current_streak + 1,
                    longest_streak = GREATEST(longest_streak, current_streak),
                    crowned_at = VALUES(crowned_at)
            `, [op.new_king_id, op.new_king_name, op.created_at]);
        } else {
            if (op.old_king_id) {
                await this.replayOperation({ type: 'markOldKingLoss', user_id: op.old_king_id }, connection);
                await this.replayOperation({ type: 'resetCooldownsForKing', king_id: op.old_king_id }, connection);
                await this.replayOperation({
                    type: 'upsertCooldown',
                    challenger_id: op.old_king_id,
                    challenger_name: op.old_king_name,
                    king_id: op.new_king_id,
                    king_name: op.new_king_name,
                    last_challenge: op.created_at,
                    notify_on_expire: 0
                }, connection);
            }

            await this.replayOperation({
                type: 'newKingStats',
                user_id: op.new_king_id,
                king_name: op.new_king_name,
                first_crowned: op.created_at,
                crowned_at: op.created_at
            }, connection);
        }

        const [[stats]] = await this.transactionQuery(connection, `
            SELECT total_wins, current_streak, longest_streak, crowned_at
            FROM pvp_king_stats
            WHERE user_id = ?
        `, [op.new_king_id]);

        return this.replayOperation({
            type: 'insertHistory',
            king_id: op.new_king_id,
            king_name: op.new_king_name,
            history_type: op.is_defense ? 'defense' : 'crown',
            total_wins_after: stats?.total_wins ?? 0,
            streak_after: stats?.current_streak ?? 0,
            longest_streak_after: stats?.longest_streak ?? 0,
            last_crowned: priorCrownedAt ?? stats?.crowned_at ?? op.created_at,
            created_at: op.created_at,
            sync_event_id: op.sync_event_id
        }, connection);
    }

    createStaleReverseError() {
        const err = new Error('The latest PvP crown changed before reverse could finish.');
        err.code = 'PVP_STALE_REVERSE';
        return err;
    }

    getReverseStatsPlan(wrongKing, prevKing) {
        let longestStreakAfter = 0;
        let consoleMsg = '';

        if (prevKing) {
            if (prevKing.king_id == wrongKing.king_id) {
                consoleMsg = 'prevKing.king_id == wrongKing.king_id';
                if (prevKing.longest_streak_after != wrongKing.longest_streak_after) {
                    longestStreakAfter = prevKing.longest_streak_after;
                    consoleMsg = ` - prevKing.longest_streak_after != wrongKing.longest_streak_after: "${longestStreakAfter}"`;
                } else {
                    longestStreakAfter = wrongKing.longest_streak_after;
                    consoleMsg = ` - prevKing.longest_streak_after == wrongKing.longest_streak_after: "${longestStreakAfter}"`;
                }
            } else {
                longestStreakAfter = wrongKing.longest_streak_after;
                consoleMsg = `prevKing.king_id != wrongKing.king_id: "${longestStreakAfter}"`;
            }
        } else {
            longestStreakAfter = wrongKing.longest_streak_after;
            consoleMsg = 'No prevKing!';
        }

        return { longestStreakAfter, consoleMsg };
    }

    async runReverseEventMysql(op) {
        return this.withMysqlTransaction(connection => this.runReverseEventMysqlWithConnection(op, connection, false));
    }

    async replayReverseEvent(op, connection) {
        return this.runReverseEventMysqlWithConnection(op, connection, true);
    }

    async runReverseEventMysqlWithConnection(op, connection, isReplay = false) {
        const [latestRows] = await this.transactionQuery(
            connection,
            'SELECT * FROM pvp_king_history ORDER BY id DESC LIMIT 1'
        );
        const wrongKing = latestRows[0] ?? null;

        if (!wrongKing || toNumber(wrongKing.id) !== toNumber(op.expected_history_id)) {
            if (isReplay) return { alreadyApplied: true };
            throw this.createStaleReverseError();
        }

        const [prevRows] = await this.transactionQuery(
            connection,
            'SELECT * FROM pvp_king_history ORDER BY id DESC LIMIT 1 OFFSET 1'
        );
        const prevKing = prevRows[0] ?? null;

        const [delHistoryRes] = await this.transactionQuery(
            connection,
            'DELETE FROM pvp_king_history WHERE id = ?',
            [wrongKing.id]
        );

        let statsResult;
        let statsConsoleMsg = '';
        if (toNumber(wrongKing.total_wins_after) === 0 || toNumber(wrongKing.total_wins_after) === 1) {
            const [delStatsRes] = await this.transactionQuery(
                connection,
                'DELETE FROM pvp_king_stats WHERE user_id = ?',
                [wrongKing.king_id]
            );
            statsResult = delStatsRes;
        } else {
            const { longestStreakAfter, consoleMsg } = this.getReverseStatsPlan(wrongKing, prevKing);
            statsConsoleMsg = consoleMsg;
            const [updateStatsRes] = await this.transactionQuery(connection, `
                UPDATE pvp_king_stats
                SET
                    total_wins = GREATEST(total_wins - 1, 0),
                    current_streak = 0,
                    longest_streak = ?,
                    crowned_at = ?
                WHERE user_id = ?
            `, [longestStreakAfter, wrongKing.last_crowned, wrongKing.king_id]);
            statsResult = updateStatsRes;
        }

        const [resetCooldownResult] = await this.transactionQuery(
            connection,
            'UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE king_id = ?',
            [wrongKing.king_id]
        );

        let prevKingResult = { affectedRows: 0 };
        if (prevKing) {
            if (prevKing.king_id != wrongKing.king_id) {
                const [updatePrevKingRes] = await this.transactionQuery(connection, `
                    UPDATE pvp_king_stats
                    SET
                        total_crown_losses = GREATEST(total_crown_losses - 1, 0),
                        current_streak = ?
                    WHERE user_id = ?
                `, [prevKing.streak_after, prevKing.king_id]);
                prevKingResult = updatePrevKingRes;
            } else {
                const [updatePrevKingRes] = await this.transactionQuery(
                    connection,
                    'UPDATE pvp_king_stats SET current_streak = ? WHERE user_id = ?',
                    [prevKing.streak_after, prevKing.king_id]
                );
                prevKingResult = updatePrevKingRes;
            }
        }

        return {
            wrongKing,
            prevKing,
            delHistoryRes,
            statsResult,
            resetCooldownResult,
            prevKingResult,
            statsConsoleMsg
        };
    }

    async getCooldown(challengerId) {
        const [rows] = await this.query(
            'SELECT king_id, last_challenge, notify_on_expire FROM pvp_king_cooldowns WHERE challenger_id = ?',
            [challengerId]
        );

        return rows[0] ?? null;
    }

    async upsertChallengeCooldown(challengerId, challengerName, kingId, kingName) {
        return this.query(`
            INSERT INTO pvp_king_cooldowns (challenger_id, challenger_name, king_id, king_name, last_challenge)
            VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE
                challenger_name = VALUES(challenger_name),
                king_id = VALUES(king_id),
                king_name = VALUES(king_name),
                last_challenge = UTC_TIMESTAMP()
        `, [challengerId, challengerName, kingId, kingName]);
    }

    async setCooldownNotification(challengerId, enabled) {
        return this.query(
            'UPDATE pvp_king_cooldowns SET notify_on_expire = ? WHERE challenger_id = ?',
            [enabled ? 1 : 0, challengerId]
        );
    }

    async createNotificationCooldown(challengerId, challengerName, enabled) {
        return this.query(`
            INSERT INTO pvp_king_cooldowns
            (challenger_id, challenger_name, king_id, king_name, last_challenge, notify_on_expire)
            VALUES (?, ?, 'None', 'None', NULL, ?)
        `, [challengerId, challengerName, enabled ? 1 : 0]);
    }

    async getNotifiableCooldownsForKing(kingId) {
        const [rows] = await this.query(`
            SELECT challenger_id, last_challenge FROM pvp_king_cooldowns
            WHERE king_id = ? AND notify_on_expire = 1 AND last_challenge IS NOT NULL
        `, [kingId]);

        return rows;
    }

    async findExpiredNotifiableCooldowns() {
        const [rows] = await this.query(`
            SELECT id, challenger_id, king_id
            FROM pvp_king_cooldowns
            WHERE notify_on_expire = 1
              AND last_challenge IS NOT NULL
              AND last_challenge <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 48 HOUR)
        `);

        return rows;
    }

    async resetCooldownsForKing(kingId) {
        return this.query(`
            UPDATE pvp_king_cooldowns
            SET last_challenge = NULL
            WHERE king_id = ?
        `, [kingId]);
    }

    async resetCooldownsByIds(ids) {
        if (!ids.length) return [{ affectedRows: 0 }];

        return this.query(
            `UPDATE pvp_king_cooldowns SET last_challenge = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
    }

    async getStats(userId) {
        const [rows] = await this.query(`
            SELECT total_wins, total_crown_losses, current_streak, longest_streak, first_crowned, crowned_at
            FROM pvp_king_stats
            WHERE user_id = ?
        `, [userId]);

        return rows[0] ?? null;
    }

    async getHistoryEventCounts(userId) {
        const [rows] = await this.query(`
            SELECT type, COUNT(*) AS total
            FROM pvp_king_history
            WHERE king_id = ?
            GROUP BY type
        `, [userId]);

        const counts = { crown: 0, defense: 0 };
        for (const row of rows) {
            if (row.type === 'crown') counts.crown = toNumber(row.total);
            if (row.type === 'defense') counts.defense = toNumber(row.total);
        }
        return counts;
    }

    async getStatsCrownedAt(userId) {
        const [rows] = await this.query(
            'SELECT crowned_at FROM pvp_king_stats WHERE user_id = ?',
            [userId]
        );

        return rows[0]?.crowned_at ?? null;
    }

    async listStats() {
        const [rows] = await this.query(`
            SELECT user_id, king_name, longest_streak, total_wins, first_crowned, crowned_at
            FROM pvp_king_stats
        `);

        return rows;
    }

    async countStats(alias = 'totalKings') {
        if (alias === 'total_kings') {
            const [[row]] = await this.query('SELECT COUNT(*) AS total_kings FROM pvp_king_stats');
            return row?.total_kings ?? 0;
        }

        const [[row]] = await this.query('SELECT COUNT(*) AS totalKings FROM pvp_king_stats');
        return row?.totalKings ?? 0;
    }

    async recordDefenseStats(userId, kingName) {
        return this.query(`
            INSERT INTO pvp_king_stats (user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)
            VALUES (?, ?, 1, 1, 1, UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE
                total_wins = total_wins + 1,
                current_streak = current_streak + 1,
                longest_streak = GREATEST(longest_streak, current_streak),
                crowned_at = UTC_TIMESTAMP()
        `, [userId, kingName]);
    }

    async markOldKingLoss(userId) {
        return this.query(`
            UPDATE pvp_king_stats
            SET
                total_crown_losses = total_crown_losses + 1,
                current_streak = 0
            WHERE user_id = ?
        `, [userId]);
    }

    async recordNewKingStats(userId, kingName) {
        return this.query(`
            INSERT INTO pvp_king_stats
                (user_id, king_name, total_wins, current_streak, longest_streak, first_crowned, crowned_at)
            VALUES (?, ?, 1, 1, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())
            ON DUPLICATE KEY UPDATE
                total_wins = total_wins + 1,
                current_streak = 1,
                longest_streak = GREATEST(longest_streak, 1),
                crowned_at = UTC_TIMESTAMP()
        `, [userId, kingName]);
    }

    async deleteStats(userId) {
        return this.query('DELETE FROM pvp_king_stats WHERE user_id = ?', [userId]);
    }

    async updateWrongKingStats(userId, longestStreak, crownedAt) {
        return this.query(`
            UPDATE pvp_king_stats
            SET
                total_wins = GREATEST(total_wins - 1, 0),
                current_streak = 0,
                longest_streak = ?,
                crowned_at = ?
            WHERE user_id = ?
        `, [longestStreak, crownedAt, userId]);
    }

    async updatePreviousKingStats(userId, currentStreak, decrementLosses) {
        if (decrementLosses) {
            return this.query(`
                UPDATE pvp_king_stats
                SET
                    total_crown_losses = GREATEST(total_crown_losses - 1, 0),
                    current_streak = ?
                WHERE user_id = ?
            `, [currentStreak, userId]);
        }

        return this.query('UPDATE pvp_king_stats SET current_streak = ? WHERE user_id = ?', [currentStreak, userId]);
    }

    async insertHistory(kingId, kingName, type, totalWinsAfter, streakAfter, longestStreakAfter, lastCrowned) {
        return this.query(`
            INSERT INTO pvp_king_history
                (king_id, king_name, type, total_wins_after, streak_after, longest_streak_after, last_crowned, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
        `, [kingId, kingName, type, totalWinsAfter, streakAfter, longestStreakAfter, lastCrowned]);
    }

    async latestHistory(offset = 0) {
        const [rows] = await this.query(`
            SELECT * FROM pvp_king_history
            ORDER BY id DESC
            LIMIT 1 OFFSET ${Number(offset) || 0}
        `);

        return rows[0] ?? null;
    }

    async historyAscending(limit = 500) {
        const [rows] = await this.query(`
            SELECT id, king_id, king_name, type, total_wins_after, streak_after, created_at
            FROM pvp_king_history
            ORDER BY id ASC
            LIMIT ${Number(limit) || 500}
        `);

        return rows;
    }

    async countHistory() {
        const [[row]] = await this.query('SELECT COUNT(*) AS totalKingEntries FROM pvp_king_history');
        return row?.totalKingEntries ?? 0;
    }

    async getHistoryInfo() {
        const [[row]] = await this.query(`
            SELECT
                COUNT(*) AS totalKingEntries,
                (SELECT king_id FROM pvp_king_history ORDER BY id DESC LIMIT 1) AS latestKingId
            FROM pvp_king_history
        `);

        return row ?? { totalKingEntries: 0, latestKingId: null };
    }

    async eventHistorySince(eventStartDate, eventEndDate = null, { inclusiveStart = false } = {}) {
        const [rows] = await this.query(`
            SELECT id, king_id, king_name, created_at
            FROM pvp_king_history
            WHERE created_at ${inclusiveStart ? '>=' : '>'} ? ${eventEndDate ? 'AND created_at <= ?' : ''}
            ORDER BY created_at ASC, id ASC
        `, eventEndDate ? [eventStartDate, eventEndDate] : [eventStartDate]);

        return rows;
    }

    async deleteHistory(id) {
        return this.query('DELETE FROM pvp_king_history WHERE id = ?', [id]);
    }

    createAction(normalized, params) {
        if (normalized.startsWith('select')) return { kind: 'select' };

        const now = toSqlDate();

        if (normalized.startsWith('insert into pvp_king_cooldowns') && normalized.includes('last_challenge) values') && normalized.includes('utc_timestamp()')) {
            return {
                kind: 'write',
                operation: {
                    type: 'upsertCooldown',
                    challenger_id: String(params[0]),
                    challenger_name: params[1],
                    king_id: String(params[2]),
                    king_name: params[3],
                    last_challenge: now,
                    notify_on_expire: 0
                }
            };
        }

        if (normalized.startsWith('insert into pvp_king_cooldowns') && normalized.includes('notify_on_expire') && normalized.includes('null')) {
            return {
                kind: 'write',
                operation: {
                    type: 'insertNotifyCooldown',
                    challenger_id: String(params[0]),
                    challenger_name: params[1],
                    king_id: 'None',
                    king_name: 'None',
                    notify_on_expire: params[2] ? 1 : 0
                }
            };
        }

        if (normalized.startsWith('update pvp_king_cooldowns set notify_on_expire')) {
            return {
                kind: 'write',
                operation: {
                    type: 'setCooldownNotify',
                    notify_on_expire: params[0] ? 1 : 0,
                    challenger_id: String(params[1])
                }
            };
        }

        if (normalized.startsWith('insert into pvp_king_stats') && normalized.includes('(user_id, king_name, total_wins, current_streak, longest_streak, crowned_at)')) {
            return {
                kind: 'write',
                operation: {
                    type: 'defenseStats',
                    user_id: String(params[0]),
                    king_name: params[1],
                    crowned_at: now
                }
            };
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('total_crown_losses = total_crown_losses + 1')) {
            return {
                kind: 'write',
                operation: {
                    type: 'markOldKingLoss',
                    user_id: String(params[0])
                }
            };
        }

        if (normalized.startsWith('update pvp_king_cooldowns') && normalized.includes('where king_id = ?')) {
            return {
                kind: 'write',
                operation: {
                    type: 'resetCooldownsForKing',
                    king_id: String(params[0])
                }
            };
        }

        if (normalized.startsWith('insert into pvp_king_stats') && normalized.includes('first_crowned, crowned_at')) {
            return {
                kind: 'write',
                operation: {
                    type: 'newKingStats',
                    user_id: String(params[0]),
                    king_name: params[1],
                    first_crowned: now,
                    crowned_at: now
                }
            };
        }

        if (normalized.startsWith('insert into pvp_king_history')) {
            return {
                kind: 'write',
                operation: {
                    type: 'insertHistory',
                    king_id: String(params[0]),
                    king_name: params[1],
                    history_type: params[2],
                    total_wins_after: toNumber(params[3]),
                    streak_after: toNumber(params[4]),
                    longest_streak_after: toNumber(params[5]),
                    last_crowned: toSqlDate(params[6]),
                    created_at: now,
                    sync_event_id: createSyncEventId()
                }
            };
        }

        if (normalized.startsWith('delete from pvp_king_history')) {
            const history = this.state.history.find(row => toNumber(row.id) === toNumber(params[0]));
            return {
                kind: 'write',
                operation: {
                    type: 'deleteHistory',
                    id: toNumber(params[0]),
                    sync_event_id: history?.sync_event_id ?? null
                }
            };
        }

        if (normalized.startsWith('delete from pvp_king_stats')) {
            return {
                kind: 'write',
                operation: {
                    type: 'deleteStats',
                    user_id: String(params[0])
                }
            };
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('total_wins = greatest(total_wins - 1, 0)')) {
            return {
                kind: 'write',
                operation: {
                    type: 'updateWrongKingStats',
                    longest_streak: toNumber(params[0]),
                    crowned_at: toSqlDate(params[1]),
                    user_id: String(params[2])
                }
            };
        }

        if (normalized.startsWith('update pvp_king_stats') && normalized.includes('current_streak = ?') && normalized.includes('where user_id = ?')) {
            return {
                kind: 'write',
                operation: {
                    type: 'updatePrevKingStats',
                    decrement_losses: normalized.includes('total_crown_losses = greatest(total_crown_losses - 1, 0)'),
                    current_streak: toNumber(params[0]),
                    user_id: String(params[1])
                }
            };
        }

        if (normalized.startsWith('update pvp_king_cooldowns set last_challenge = null where id in')) {
            return {
                kind: 'write',
                operation: {
                    type: 'resetCooldownsByIds',
                    ids: params.map(id => toNumber(id))
                }
            };
        }

        return null;
    }

    applyOperation(op, recordPending = false) {
        let affectedRows = 0;

        switch (op.type) {
            case 'crownEvent':
                return this.applyCrownEvent(op, recordPending);
            case 'reverseEvent':
                return this.applyReverseEvent(op, recordPending);
            case 'upsertCooldown':
                affectedRows = this.applyUpsertCooldown(op);
                break;
            case 'insertNotifyCooldown':
                affectedRows = this.applyInsertNotifyCooldown(op);
                break;
            case 'setCooldownNotify':
                affectedRows = this.applySetCooldownNotify(op);
                break;
            case 'defenseStats':
                affectedRows = this.applyDefenseStats(op);
                break;
            case 'markOldKingLoss':
                affectedRows = this.applyMarkOldKingLoss(op);
                break;
            case 'resetCooldownsForKing':
                affectedRows = this.applyResetCooldownsForKing(op);
                break;
            case 'newKingStats':
                affectedRows = this.applyNewKingStats(op);
                break;
            case 'insertHistory':
                affectedRows = this.applyInsertHistory(op);
                break;
            case 'deleteHistory':
                affectedRows = this.applyDeleteHistory(op);
                break;
            case 'deleteStats':
                affectedRows = this.state.stats.delete(String(op.user_id)) ? 1 : 0;
                break;
            case 'updateWrongKingStats':
                affectedRows = this.applyUpdateWrongKingStats(op);
                break;
            case 'updatePrevKingStats':
                affectedRows = this.applyUpdatePrevKingStats(op);
                break;
            case 'resetCooldownsByIds':
                affectedRows = this.applyResetCooldownsByIds(op);
                break;
            default:
                throw new Error(`Unsupported PvP King local operation: ${op.type}`);
        }

        if (recordPending) {
            this.state.operations.push({ ...op });
        }

        return [{ affectedRows }];
    }

    applyCrownEvent(op, recordPending = false) {
        const usersToNotify = op.old_king_id && !op.is_defense
            ? this.getActiveNotificationRowsForKing(op.old_king_id)
            : [];
        const existingNewKing = this.state.stats.get(String(op.new_king_id));
        const priorCrownedAt = existingNewKing?.crowned_at ?? null;

        if (op.is_defense) {
            this.applyDefenseStats({
                user_id: op.new_king_id,
                king_name: op.new_king_name,
                crowned_at: op.created_at
            });
        } else {
            if (op.old_king_id) {
                this.applyMarkOldKingLoss({ user_id: op.old_king_id });
                this.applyResetCooldownsForKing({ king_id: op.old_king_id });
                this.applyUpsertCooldown({
                    challenger_id: op.old_king_id,
                    challenger_name: op.old_king_name,
                    king_id: op.new_king_id,
                    king_name: op.new_king_name,
                    last_challenge: op.created_at,
                    notify_on_expire: 0
                });
            }

            this.applyNewKingStats({
                user_id: op.new_king_id,
                king_name: op.new_king_name,
                first_crowned: op.created_at,
                crowned_at: op.created_at
            });
        }

        const stats = this.state.stats.get(String(op.new_king_id));
        const historyOp = {
            type: 'insertHistory',
            king_id: op.new_king_id,
            king_name: op.new_king_name,
            history_type: op.is_defense ? 'defense' : 'crown',
            total_wins_after: stats?.total_wins ?? 0,
            streak_after: stats?.current_streak ?? 0,
            longest_streak_after: stats?.longest_streak ?? 0,
            last_crowned: priorCrownedAt ?? stats?.crowned_at ?? op.created_at,
            created_at: op.created_at,
            sync_event_id: op.sync_event_id
        };
        this.applyInsertHistory(historyOp);

        if (recordPending) {
            this.state.operations.push({ ...op });
        }

        return {
            stats: cloneRow(stats),
            history: cloneRow(this.latestLocalHistory()),
            usersToNotify: usersToNotify.map(cloneRow)
        };
    }

    applyReverseEvent(op, recordPending = false) {
        const wrongKing = this.latestLocalHistory();
        if (!wrongKing || toNumber(wrongKing.id) !== toNumber(op.expected_history_id)) {
            throw this.createStaleReverseError();
        }

        const prevKing = this.latestLocalHistory(1);
        const delHistoryRes = { affectedRows: this.applyDeleteHistory({ id: wrongKing.id, sync_event_id: wrongKing.sync_event_id }) };

        let statsResult;
        let statsConsoleMsg = '';
        if (toNumber(wrongKing.total_wins_after) === 0 || toNumber(wrongKing.total_wins_after) === 1) {
            statsResult = { affectedRows: this.state.stats.delete(String(wrongKing.king_id)) ? 1 : 0 };
        } else {
            const { longestStreakAfter, consoleMsg } = this.getReverseStatsPlan(wrongKing, prevKing);
            statsConsoleMsg = consoleMsg;
            statsResult = { affectedRows: this.applyUpdateWrongKingStats({
                user_id: wrongKing.king_id,
                longest_streak: longestStreakAfter,
                crowned_at: wrongKing.last_crowned
            }) };
        }

        const resetCooldownResult = { affectedRows: this.applyResetCooldownsForKing({ king_id: wrongKing.king_id }) };
        let prevKingResult = { affectedRows: 0 };
        if (prevKing) {
            prevKingResult = {
                affectedRows: this.applyUpdatePrevKingStats({
                    user_id: prevKing.king_id,
                    current_streak: prevKing.streak_after,
                    decrement_losses: prevKing.king_id != wrongKing.king_id
                })
            };
        }

        if (recordPending) {
            this.state.operations.push({ ...op });
        }

        return {
            wrongKing: cloneRow(wrongKing),
            prevKing: cloneRow(prevKing),
            delHistoryRes,
            statsResult,
            resetCooldownResult,
            prevKingResult,
            statsConsoleMsg
        };
    }

    applyUpsertCooldown(op) {
        const existing = this.state.cooldowns.get(String(op.challenger_id));
        const row = {
            id: existing?.id ?? this.state.nextCooldownId++,
            challenger_id: String(op.challenger_id),
            challenger_name: op.challenger_name,
            king_id: String(op.king_id),
            king_name: op.king_name,
            last_challenge: toSqlDate(op.last_challenge),
            notify_on_expire: existing?.notify_on_expire ?? toNumber(op.notify_on_expire)
        };

        this.state.cooldowns.set(row.challenger_id, row);
        return existing ? 2 : 1;
    }

    applyInsertNotifyCooldown(op) {
        const existing = this.state.cooldowns.get(String(op.challenger_id));
        const row = {
            id: existing?.id ?? this.state.nextCooldownId++,
            challenger_id: String(op.challenger_id),
            challenger_name: op.challenger_name,
            king_id: existing?.king_id ?? op.king_id,
            king_name: existing?.king_name ?? op.king_name,
            last_challenge: existing?.last_challenge ?? null,
            notify_on_expire: op.notify_on_expire ? 1 : 0
        };

        this.state.cooldowns.set(row.challenger_id, row);
        return existing ? 2 : 1;
    }

    applySetCooldownNotify(op) {
        const existing = this.state.cooldowns.get(String(op.challenger_id));
        if (!existing) return 0;

        existing.notify_on_expire = op.notify_on_expire ? 1 : 0;
        return 1;
    }

    applyDefenseStats(op) {
        const existing = this.state.stats.get(String(op.user_id));
        const crownedAt = toSqlDate(op.crowned_at);

        if (!existing) {
            this.state.stats.set(String(op.user_id), {
                user_id: String(op.user_id),
                king_name: op.king_name,
                total_wins: 1,
                total_crown_losses: 0,
                current_streak: 1,
                longest_streak: 1,
                first_crowned: null,
                crowned_at: crownedAt
            });
            return 1;
        }

        existing.king_name = op.king_name;
        existing.total_wins = toNumber(existing.total_wins) + 1;
        existing.current_streak = toNumber(existing.current_streak) + 1;
        existing.longest_streak = Math.max(toNumber(existing.longest_streak), toNumber(existing.current_streak));
        existing.crowned_at = crownedAt;
        return 2;
    }

    applyMarkOldKingLoss(op) {
        const existing = this.state.stats.get(String(op.user_id));
        if (!existing) return 0;

        existing.total_crown_losses = toNumber(existing.total_crown_losses) + 1;
        existing.current_streak = 0;
        return 1;
    }

    applyResetCooldownsForKing(op) {
        let affectedRows = 0;
        for (const row of this.state.cooldowns.values()) {
            if (String(row.king_id) === String(op.king_id)) {
                row.last_challenge = null;
                affectedRows++;
            }
        }
        return affectedRows;
    }

    applyNewKingStats(op) {
        const existing = this.state.stats.get(String(op.user_id));
        const crownedAt = toSqlDate(op.crowned_at);

        if (!existing) {
            this.state.stats.set(String(op.user_id), {
                user_id: String(op.user_id),
                king_name: op.king_name,
                total_wins: 1,
                total_crown_losses: 0,
                current_streak: 1,
                longest_streak: 1,
                first_crowned: toSqlDate(op.first_crowned),
                crowned_at: crownedAt
            });
            return 1;
        }

        existing.king_name = op.king_name;
        existing.total_wins = toNumber(existing.total_wins) + 1;
        existing.current_streak = 1;
        existing.longest_streak = Math.max(toNumber(existing.longest_streak), 1);
        existing.crowned_at = crownedAt;
        return 2;
    }

    applyInsertHistory(op) {
        const row = {
            id: op.id ? toNumber(op.id) : this.state.nextHistoryId++,
            king_id: String(op.king_id),
            king_name: op.king_name,
            type: op.history_type,
            total_wins_after: toNumber(op.total_wins_after),
            streak_after: toNumber(op.streak_after),
            longest_streak_after: toNumber(op.longest_streak_after),
            last_crowned: toSqlDate(op.last_crowned),
            created_at: toSqlDate(op.created_at),
            sync_event_id: op.sync_event_id ?? null
        };

        this.state.nextHistoryId = Math.max(this.state.nextHistoryId, toNumber(row.id) + 1);
        this.state.history.push(row);
        return 1;
    }

    applyDeleteHistory(op) {
        const before = this.state.history.length;
        this.state.history = this.state.history.filter(row => {
            if (op.sync_event_id && row.sync_event_id === op.sync_event_id) return false;
            return toNumber(row.id) !== toNumber(op.id);
        });
        return before - this.state.history.length;
    }

    applyUpdateWrongKingStats(op) {
        const existing = this.state.stats.get(String(op.user_id));
        if (!existing) return 0;

        existing.total_wins = Math.max(toNumber(existing.total_wins) - 1, 0);
        existing.current_streak = 0;
        existing.longest_streak = toNumber(op.longest_streak);
        existing.crowned_at = toSqlDate(op.crowned_at);
        return 1;
    }

    applyUpdatePrevKingStats(op) {
        const existing = this.state.stats.get(String(op.user_id));
        if (!existing) return 0;

        if (op.decrement_losses) {
            existing.total_crown_losses = Math.max(toNumber(existing.total_crown_losses) - 1, 0);
        }
        existing.current_streak = toNumber(op.current_streak);
        return 1;
    }

    applyResetCooldownsByIds(op) {
        let affectedRows = 0;
        const ids = new Set((op.ids ?? []).map(id => toNumber(id)));

        for (const row of this.state.cooldowns.values()) {
            if (ids.has(toNumber(row.id))) {
                row.last_challenge = null;
                affectedRows++;
            }
        }
        return affectedRows;
    }

    runLocalSelect(normalized, params = []) {
        if (normalized.includes('from pvp_king_cooldowns')) {
            return [this.selectCooldowns(normalized, params)];
        }

        if (normalized.includes('from pvp_king_stats')) {
            return [this.selectStats(normalized, params)];
        }

        if (normalized.includes('from pvp_king_history')) {
            return [this.selectHistory(normalized, params)];
        }

        return [[]];
    }

    selectCooldowns(normalized, params) {
        let rows = [...this.state.cooldowns.values()].map(cloneRow);

        if (normalized.includes('where challenger_id = ?')) {
            rows = rows.filter(row => String(row.challenger_id) === String(params[0]));
        }

        if (normalized.includes('where king_id = ?')) {
            rows = rows.filter(row => String(row.king_id) === String(params[0]));
        }

        if (normalized.includes('notify_on_expire = 1')) {
            rows = rows.filter(row => toNumber(row.notify_on_expire) === 1);
        }

        if (normalized.includes('last_challenge is not null')) {
            rows = rows.filter(row => row.last_challenge);
        }

        if (normalized.includes('last_challenge <= date_sub(utc_timestamp(), interval 48 hour)')) {
            const cutoff = Date.now() - (48 * 60 * 60 * 1000);
            rows = rows.filter(row => row.last_challenge && new Date(`${row.last_challenge}Z`).getTime() <= cutoff);
        }

        return rows;
    }

    selectStats(normalized, params) {
        let rows = [...this.state.stats.values()].map(cloneRow);

        if (normalized.includes('count(*) as totalkings')) {
            return [{ totalKings: rows.length }];
        }

        if (normalized.includes('count(*) as total_kings')) {
            return [{ total_kings: rows.length }];
        }

        if (normalized.includes('where user_id = ?')) {
            rows = rows.filter(row => String(row.user_id) === String(params[0]));
        }

        return rows;
    }

    selectHistory(normalized, params) {
        let rows = [...this.state.history].map(cloneRow);

        if (normalized.includes('count(*) as total') && normalized.includes('group by type')) {
            if (normalized.includes('where king_id = ?')) {
                rows = rows.filter(row => String(row.king_id) === String(params[0]));
            }

            const counts = new Map();
            for (const row of rows) {
                counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
            }
            return [...counts.entries()].map(([type, total]) => ({ type, total }));
        }

        if (normalized.includes('count(*) as totalkingentries') && normalized.includes('select king_id from pvp_king_history')) {
            const latest = [...rows].sort((a, b) => toNumber(b.id) - toNumber(a.id))[0];
            return [{ totalKingEntries: rows.length, latestKingId: latest?.king_id ?? null }];
        }

        if (normalized.includes('count(*) as totalkingentries')) {
            return [{ totalKingEntries: rows.length }];
        }

        if (normalized.includes('where created_at >= ?')) {
            const cutoff = toSqlDate(params[0]);
            rows = rows.filter(row => compareSqlDatesAsc(row.created_at, cutoff) >= 0);
        } else if (normalized.includes('where created_at > ?')) {
            const cutoff = toSqlDate(params[0]);
            rows = rows.filter(row => compareSqlDatesAsc(row.created_at, cutoff) > 0);
        }

        if (normalized.includes('created_at <= ?')) {
            const cutoff = toSqlDate(params[1]);
            rows = rows.filter(row => compareSqlDatesAsc(row.created_at, cutoff) <= 0);
        }

        if (normalized.includes('order by id desc')) {
            rows.sort((a, b) => toNumber(b.id) - toNumber(a.id));
        } else if (normalized.includes('order by id asc')) {
            rows.sort((a, b) => toNumber(a.id) - toNumber(b.id));
        } else if (normalized.includes('order by created_at desc')) {
            rows.sort((a, b) => compareSqlDatesAsc(b.created_at, a.created_at));
        } else if (normalized.includes('order by created_at asc')) {
            rows.sort((a, b) => compareSqlDatesAsc(a.created_at, b.created_at));
        }

        const offsetMatch = normalized.match(/offset (\d+)/);
        const limitMatch = normalized.match(/limit (\d+)/);
        const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
        const limit = limitMatch ? Number(limitMatch[1]) : null;

        if (limit !== null) {
            rows = rows.slice(offset, offset + limit);
        }

        return rows;
    }
}

module.exports = PvpKingStorage;
