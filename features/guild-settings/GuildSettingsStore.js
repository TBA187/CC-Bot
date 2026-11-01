// Keep guild XP/logging settings cached and recover pending changes after database outages.
'use strict';

const path = require('node:path');
const { readJsonObject, writeJsonIfChanged } = require('../../utils/jsonFile.js');
const { throwIfAborted } = require('../../utils/abortable.js');

function normalizeRow(row) {
    const date = value => !value ? null : value instanceof Date ? value.toISOString() : String(value);
    return {
        guild_id: String(row.guild_id),
        guild_name: row.guild_name ?? null,
        xp_enabled: Number(row.xp_enabled || 0),
        xp_date_enabled: date(row.xp_date_enabled),
        logging_enabled: Number(row.logging_enabled || 0),
        updated_at: date(row.updated_at)
    };
}

class GuildSettingsStore {
    constructor({ db, guildId, signal, storageMode = process.env.STORAGE_MODE,
        filePath = path.join(__dirname, '../../data/guild_settings.json'), consoleObject = console,
        schedule = setInterval, cancel = clearInterval, syncIntervalMs = 5 * 60_000 } = {}) {
        Object.assign(this, { db, guildId, signal, filePath, console: consoleObject, schedule, cancel, syncIntervalMs });
        const mode = String(storageMode || 'auto').toLowerCase();
        this.storageMode = ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
        this.cache = new Map();
        this.queue = Promise.resolve();
        this.syncPromise = null;
        this.timer = null;
        this.stopped = false;
        this.mysqlOutage = false;
    }

    get stopping() { return this.stopped || this.signal?.aborted; }
    canUseMysql() { return this.storageMode !== 'json' && this.db?.hasRequiredConfig; }

    defaultRows() {
        if (!this.guildId) return [];
        return [{ guild_id: String(this.guildId), guild_name: 'Crow Control', xp_enabled: 1,
            xp_date_enabled: '2026-05-11 04:56:00', logging_enabled: 1, updated_at: '2026-06-05 02:12:20' }];
    }

    writeMirror(rows, pendingSync = false) {
        return writeJsonIfChanged(this.filePath, `${this.filePath}.tmp`, {
            version: 1, source: 'mysql_mirror', pendingSync, settings: rows.map(normalizeRow)
        });
    }

    readMirror() {
        const parsed = readJsonObject(this.filePath, value => Array.isArray(value.settings)
            && value.settings.every(row => row && row.guild_id != null && String(row.guild_id).trim()));
        if (!parsed) {
            const settings = this.defaultRows();
            this.writeMirror(settings);
            return { settings, pendingSync: false };
        }
        return { settings: parsed.settings.length ? parsed.settings.map(normalizeRow) : this.defaultRows(),
            pendingSync: parsed.pendingSync === true };
    }

    cacheRows(rows) {
        this.cache.clear();
        for (const row of rows) {
            if (row.guild_id) this.cache.set(String(row.guild_id), {
                xpEnabled: Number(row.xp_enabled) === 1,
                xpDateEnabled: row.xp_date_enabled,
                loggingEnabled: Number(row.logging_enabled) === 1
            });
        }
    }

    loadMirror({ quiet = false } = {}) {
        const mirror = this.readMirror();
        this.cacheRows(mirror.settings);
        if (!quiet) this.console.warn(`[CC LOG] Loaded ${this.cache.size} guild setting(s) from JSON mirror.`);
        return mirror;
    }

    enqueue(work) {
        const pending = this.queue.then(() => this.stopping ? false : work());
        this.queue = pending.catch(() => {});
        return pending;
    }

    async upsertRows(rows) {
        for (const row of rows.map(normalizeRow)) {
            throwIfAborted(this.signal);
            if (this.stopped) return;
            await this.db.query(`
                INSERT INTO guild_settings (guild_id, guild_name, xp_enabled, xp_date_enabled, logging_enabled)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    guild_name = VALUES(guild_name),
                    xp_enabled = VALUES(xp_enabled),
                    xp_date_enabled = VALUES(xp_date_enabled),
                    logging_enabled = VALUES(logging_enabled)
            `, [row.guild_id, row.guild_name, row.xp_enabled, row.xp_date_enabled, row.logging_enabled]);
        }
    }

    sync(options = {}) {
        if (this.stopping) return Promise.resolve(false);
        if (!this.syncPromise) {
            this.syncPromise = this.enqueue(() => this.syncNow(options)).finally(() => { this.syncPromise = null; });
        }
        return this.syncPromise;
    }

    async syncNow({ quiet = false } = {}) {
        // Validate recovery data before touching MySQL; an unreadable mirror may contain unsent changes.
        const mirror = this.readMirror();
        if (!this.canUseMysql()) {
            this.cacheRows(mirror.settings);
            if (!quiet) this.console.warn(`[CC LOG] Loaded ${this.cache.size} guild setting(s) from JSON mirror.`);
            return false;
        }
        try {
            if (mirror.pendingSync) {
                await this.upsertRows(mirror.settings);
                if (this.stopping) return false;
                this.writeMirror(mirror.settings, false);
                this.console.log(`[CC LOG] Synced ${mirror.settings.length} pending guild setting(s) to MySQL.`);
            }
            await this.db.query(`
                UPDATE guild_settings
                SET xp_date_enabled = CURRENT_TIMESTAMP
                WHERE xp_enabled = 1 AND xp_date_enabled IS NULL
            `);
            if (this.stopping) return false;
            const [rows] = await this.db.query('SELECT guild_id, guild_name, xp_enabled, xp_date_enabled, logging_enabled, updated_at FROM guild_settings');
            if (this.stopping) return false;
            const settings = rows.map(normalizeRow);
            if (!settings.length) {
                this.console.log('[CC LOG] ⚠️ No rows found in guild_settings table.');
                this.loadMirror();
                return false;
            }
            const changed = this.writeMirror(settings, false);
            this.cacheRows(settings);
            if (this.mysqlOutage) {
                this.mysqlOutage = false;
                this.console.log('[CC LOG] Guild settings MySQL restored; the JSON mirror is synchronized.');
            }
            if (!quiet || mirror.pendingSync || changed) this.console.log(`[CC LOG] ✅ Cached settings for ${this.cache.size} guilds.`);
            return true;
        } catch (error) {
            if (this.stopping) return false;
            if (this.db.isDatabaseUnavailableError?.(error)) {
                if (!this.mysqlOutage) {
                    this.mysqlOutage = true;
                    this.console.warn(`[CC LOG] Guild settings MySQL unavailable (${this.db.getErrorCode?.(error) || error.code || error.message}). `
                        + 'Using the JSON mirror; the five-minute sync loop remains active.');
                }
            } else this.console.error('[CC LOG] ❌ Failed to sync settings:', error);
            this.loadMirror({ quiet: true });
            return false;
        }
    }

    addGuild(guild) {
        return this.enqueue(async () => {
            this.console.log(`[CC LOG] New Guild joined: ${guild.name} (${guild.id})`);
            const row = normalizeRow({ guild_id: guild.id, guild_name: guild.name,
                xp_enabled: 0, xp_date_enabled: null, logging_enabled: 0, updated_at: new Date().toISOString() });
            const mirror = this.readMirror();
            const rows = new Map(mirror.settings.map(setting => [String(setting.guild_id), setting]));
            rows.set(row.guild_id, row);
            const settings = [...rows.values()];
            // Persist first: a failed or interrupted SQL request must leave replayable work.
            this.writeMirror(settings, true);
            this.cacheRows(settings);
            if (this.canUseMysql()) {
                try {
                    await this.upsertRows([row]);
                    if (!this.stopping) this.writeMirror(settings, mirror.pendingSync);
                } catch (error) {
                    if (!this.stopping) this.console.error('[CC LOG] Error setting up new guild:', error);
                }
            }
            return true;
        });
    }

    startSyncLoop() {
        if (this.stopping || this.timer !== null) return;
        this.timer = this.schedule(() => {
            this.sync({ quiet: true }).catch(error => this.console.error('[CC LOG] Guild settings sync loop failed:', error));
        }, this.syncIntervalMs);
        this.timer?.unref?.();
    }

    stop() {
        this.stopped = true;
        if (this.timer !== null) this.cancel(this.timer);
        this.timer = null;
        return this.queue;
    }
}

module.exports = { GuildSettingsStore };
