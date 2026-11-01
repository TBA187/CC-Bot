'use strict';

// Shares shop checkpoints through MySQL and keeps a per-host JSON recovery mirror.
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../../utils/jsonFile.js');
const { DATA_VERSION, DEFAULT_DATA_FILE } = require('./constants.js');

function parseStorageMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
}

function postNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : 0;
}

function normalizedCheckpoint(shop, value = {}) {
    const lastSeenPostId = value.lastSeenPostId ?? value.last_seen_post_id;
    return {
        topicUrl: String(value.topicUrl ?? value.topic_url ?? shop.topicUrl ?? ''),
        initialized: value.initialized === true || Number(value.initialized) === 1,
        lastSeenPostId: lastSeenPostId === null || lastSeenPostId === undefined
            ? null
            : String(lastSeenPostId),
        lastPage: Math.max(1, Number(value.lastPage ?? value.last_page) || 1)
    };
}

function mergeCheckpoints(shop, local, remote) {
    const left = normalizedCheckpoint(shop, local);
    const right = normalizedCheckpoint(shop, remote);
    if (left.topicUrl !== shop.topicUrl) return right.topicUrl === shop.topicUrl
        ? right
        : normalizedCheckpoint(shop);
    if (right.topicUrl !== shop.topicUrl) return left;

    const leftPost = postNumber(left.lastSeenPostId);
    const rightPost = postNumber(right.lastSeenPostId);
    const newest = rightPost > leftPost ? right : left;
    return {
        topicUrl: shop.topicUrl,
        initialized: left.initialized || right.initialized,
        lastSeenPostId: newest.lastSeenPostId || left.lastSeenPostId || right.lastSeenPostId || null,
        lastPage: Math.max(left.lastPage, right.lastPage, 1)
    };
}

class TbaForumShopStore {
    constructor(options = {}) {
        this.db = options.db;
        this.storageMode = parseStorageMode(options.storageMode ?? process.env.STORAGE_MODE);
        this.hasMysqlConfig = options.hasMysqlCredentials
            ?? this.db?.hasRequiredConfig
            ?? Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
        this.dataFile = options.dataFile || DEFAULT_DATA_FILE;
        this.tempFile = `${this.dataFile}.tmp`;
        this.shops = new Map();
        this.schemaReady = false;
        this.mysqlOutage = false;
    }

    canUseMysql() {
        return this.storageMode !== 'json' && Boolean(this.db) && Boolean(this.hasMysqlConfig);
    }

    emptyData() {
        return {
            version: DATA_VERSION,
            shops: {}
        };
    }

    ensureFile() {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        if (!fs.existsSync(this.dataFile)) {
            writeJsonIfChanged(this.dataFile, this.tempFile, this.emptyData());
        }
    }

    readData() {
        this.ensureFile();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
            if (!parsed?.shops || typeof parsed.shops !== 'object' || Array.isArray(parsed.shops)) {
                throw new Error('Invalid TBA forum shop checkpoint mirror.');
            }
            return {
                version: DATA_VERSION,
                shops: parsed?.shops && typeof parsed.shops === 'object' ? parsed.shops : {}
            };
        } catch (error) {
            error.tbaForumShopStorage = true;
            throw error;
        }
    }

    writeData(data) {
        try {
            writeJsonIfChanged(this.dataFile, this.tempFile, {
                version: DATA_VERSION,
                shops: data.shops || {}
            });
        } catch (error) {
            error.tbaForumShopStorage = true;
            throw error;
        }
    }

    noteMysqlFailure(error) {
        if (this.db?.isDatabaseUnavailableError && !this.db.isDatabaseUnavailableError(error)) {
            console.error('[CC LOG] Unexpected TBA forum shop checkpoint MySQL error:', error);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const code = this.db?.getErrorCode?.(error) || error?.code || error?.message || 'UNKNOWN';
        console.warn(
            `[CC LOG] Shared TBA forum shop checkpoints unavailable (${code}). ` +
            'Using the local JSON mirror until MySQL recovers.'
        );
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log('[CC LOG] Shared TBA forum shop checkpoints restored and synchronized.');
    }

    async ensureSchema() {
        if (this.schemaReady || !this.canUseMysql()) return this.schemaReady;
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS tba_forum_shop_checkpoints (
                shop_key VARCHAR(64) NOT NULL,
                topic_url VARCHAR(1000) NOT NULL,
                initialized TINYINT(1) NOT NULL DEFAULT 0,
                last_seen_post_id VARCHAR(32) NULL,
                last_page INT UNSIGNED NOT NULL DEFAULT 1,
                updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                PRIMARY KEY (shop_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        this.schemaReady = true;
        return true;
    }

    async mysqlGetShop(key) {
        await this.ensureSchema();
        const [rows] = await this.db.query(`
            SELECT shop_key, topic_url, initialized, last_seen_post_id, last_page
            FROM tba_forum_shop_checkpoints
            WHERE shop_key = ?
            LIMIT 1
        `, [String(key)]);
        return rows[0] || null;
    }

    async mysqlSaveShop(key, checkpoint) {
        await this.ensureSchema();
        await this.db.query(`
            INSERT INTO tba_forum_shop_checkpoints (
                shop_key, topic_url, initialized, last_seen_post_id, last_page
            ) VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                initialized = CASE
                    WHEN topic_url <> VALUES(topic_url) THEN VALUES(initialized)
                    ELSE GREATEST(initialized, VALUES(initialized))
                END,
                last_seen_post_id = CASE
                    WHEN topic_url <> VALUES(topic_url) THEN VALUES(last_seen_post_id)
                    WHEN CAST(COALESCE(last_seen_post_id, '0') AS UNSIGNED) <= CAST(COALESCE(VALUES(last_seen_post_id), '0') AS UNSIGNED)
                        THEN VALUES(last_seen_post_id)
                    ELSE last_seen_post_id
                END,
                last_page = CASE
                    WHEN topic_url <> VALUES(topic_url) THEN VALUES(last_page)
                    ELSE GREATEST(last_page, VALUES(last_page))
                END,
                topic_url = VALUES(topic_url)
        `, [
            String(key),
            checkpoint.topicUrl,
            checkpoint.initialized ? 1 : 0,
            checkpoint.lastSeenPostId,
            checkpoint.lastPage
        ]);
    }

    saveLocalShop(key, checkpoint) {
        const data = this.readData();
        data.shops[key] = checkpoint;
        this.writeData(data);
        return checkpoint;
    }

    async initialize(shops) {
        const data = this.readData();
        for (const shop of shops) {
            this.shops.set(shop.key, shop);
            let checkpoint = normalizedCheckpoint(shop, data.shops[shop.key]);
            if (checkpoint.topicUrl !== shop.topicUrl) checkpoint = normalizedCheckpoint(shop);

            if (this.canUseMysql()) {
                try {
                    const remote = await this.mysqlGetShop(shop.key);
                    checkpoint = mergeCheckpoints(shop, checkpoint, remote || {});
                    await this.mysqlSaveShop(shop.key, checkpoint);
                    const savedRemote = await this.mysqlGetShop(shop.key);
                    checkpoint = mergeCheckpoints(shop, checkpoint, savedRemote || {});
                    this.noteMysqlRestored();
                } catch (error) {
                    if (error.tbaForumShopStorage) throw error;
                    this.noteMysqlFailure(error);
                }
            }

            data.shops[shop.key] = checkpoint;
        }
        this.writeData(data);
        return data;
    }

    async getShop(key) {
        const shop = this.shops.get(key);
        const local = this.readData().shops[key] || null;
        if (!shop || !this.canUseMysql()) return local;

        try {
            const remote = await this.mysqlGetShop(key);
            const merged = mergeCheckpoints(shop, local || {}, remote || {});
            const remoteCheckpoint = normalizedCheckpoint(shop, remote || {});
            const needsSync = ['topicUrl', 'initialized', 'lastSeenPostId', 'lastPage']
                .some(field => merged[field] !== remoteCheckpoint[field]);
            let current = merged;
            if (needsSync) {
                await this.mysqlSaveShop(key, merged);
                const saved = await this.mysqlGetShop(key);
                current = mergeCheckpoints(shop, merged, saved || {});
            }
            this.saveLocalShop(key, current);
            this.noteMysqlRestored();
            return current;
        } catch (error) {
            if (error.tbaForumShopStorage) throw error;
            this.noteMysqlFailure(error);
            return local;
        }
    }

    async updateShop(key, patch) {
        const shop = this.shops.get(key);
        if (!shop) throw new Error(`Unknown TBA forum shop key: ${key}`);
        const local = this.readData().shops[key];
        if (!local) throw new Error(`Unknown TBA forum shop key: ${key}`);
        let checkpoint = normalizedCheckpoint(shop, { ...local, ...patch });
        this.saveLocalShop(key, checkpoint);

        if (this.canUseMysql()) {
            try {
                await this.mysqlSaveShop(key, checkpoint);
                const remote = await this.mysqlGetShop(key);
                checkpoint = mergeCheckpoints(shop, checkpoint, remote || {});
                this.saveLocalShop(key, checkpoint);
                this.noteMysqlRestored();
            } catch (error) {
                if (error.tbaForumShopStorage) throw error;
                this.noteMysqlFailure(error);
            }
        }
        return checkpoint;
    }
}

module.exports = {
    TbaForumShopStore,
    mergeCheckpoints,
    normalizedCheckpoint,
    parseStorageMode,
    postNumber
};
