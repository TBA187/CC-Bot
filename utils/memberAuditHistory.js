// Retain recent membership transitions and replay pending audit records after outages.
'use strict';

const { GuildMemberFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { readJsonObject, writeJsonIfChanged } = require('./jsonFile.js');

// Retain only the latest membership transition per user, with a bounded store.
class MemberAuditHistory {
    constructor({ db, filePath, storageMode = process.env.STORAGE_MODE, shutdownSignal, retryMs = 30000,
        maxEntries = 5000, onError = (error, { localJson = false } = {}) => {
            if (localJson) console.error('[CC LOG] Member audit local JSON storage failed:', error);
            else if (error instanceof SyntaxError || error.message === 'Invalid MySQL member audit record.') {
                console.error('[CC LOG] Member audit data is corrupted; review is required:', error);
            } else console.warn('[CC LOG] Member audit history unavailable; JSON recovery remains active:', error);
        } } = {}) {
        Object.assign(this, { db, shutdownSignal, retryMs });
        this.storageMode = String(storageMode || 'auto').toLowerCase();
        this.dirty = new Set();
        this.loadedMysql = false;
        this.schemaReady = false;
        this.stopped = false;
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        this.onError = onError;
        this.entries = new Map();
        this.pendingDepartures = new Map();
        this.pendingJoins = new Set();
        if (filePath) {
            try {
                const saved = readJsonObject(filePath, value => [1, 2].includes(value.version) && Array.isArray(value.members));
                for (const entry of saved?.members ?? []) {
                    if (entry?.guildId && entry?.userId) this.entries.set(this.key(entry.guildId, entry.userId), entry);
                }
                for (const key of saved?.version === 2 ? saved.pending || [] : this.entries.keys()) {
                    if (this.entries.has(key)) this.dirty.add(key);
                }
                this.prune();
            } catch (error) { this.onError(error, { localJson: true }); }
        }
    }

    key(guildId, userId) { return `${guildId}:${userId}`; }

    entry(guildId, userId) {
        const key = this.key(guildId, userId);
        if (!this.entries.has(key)) this.entries.set(key, { guildId, userId, knownMember: false, inServer: false });
        return this.entries.get(key);
    }

    prune() {
        if (this.entries.size <= this.maxEntries) return;
        const oldest = [...this.entries].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
        let excess = this.entries.size - this.maxEntries;
        // Protect pending MySQL writes during an outage. JSON-only stores have
        // no acknowledgement to wait for, so their retention must still work.
        for (const [key] of oldest) {
            if (excess <= 0) break;
            if (this.canUseMysql() && this.dirty.has(key)) continue;
            if (this.pendingJoins.has(key) || this.pendingDepartures.has(key)) continue;
            this.entries.delete(key);
            this.dirty.delete(key);
            excess--;
        }
    }

    persist() {
        this.prune();
        if (!this.filePath) return;
        try { writeJsonIfChanged(this.filePath, `${this.filePath}.tmp`, { version: 2, members: [...this.entries.values()], pending: [...this.dirty] }); }
        catch (error) { this.onError(error, { localJson: true }); }
    }

    changed(entry, at = Date.now()) {
        entry.updatedAt = Math.max(Date.now(), at, (entry.updatedAt || 0) + 1);
        this.dirty.add(this.key(entry.guildId, entry.userId));
        this.persist();
        if (this.timer) void this.flush();
    }

    canUseMysql() { return this.storageMode !== 'json' && Boolean(this.db?.hasRequiredConfig); }

    restore() { return this.flush(); }

    async loadMember(guildId, userId) {
        const key = this.key(guildId, userId);
        if (this.entries.has(key) || !this.loadedMysql || !this.canUseMysql() || this.stopped || this.shutdownSignal?.aborted) return;
        try {
            const [rows] = await this.db.query('SELECT state_json FROM member_audit_history WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            const value = rows[0]?.state_json;
            const saved = typeof value === 'string' || Buffer.isBuffer(value) ? JSON.parse(value) : value;
            if (!this.entries.has(key) && saved?.guildId === guildId && saved?.userId === userId) this.entries.set(key, saved);
        } catch (error) {
            if (!this.outage && !this.stopped && !this.shutdownSignal?.aborted) { this.outage = true; this.onError(error); }
        }
    }

    flush() {
        if (this.flushing) return this.flushing;
        if (this.stopped || this.shutdownSignal?.aborted || !this.canUseMysql()) return Promise.resolve();
        this.flushing = this.syncMysql().catch(error => {
            if (!this.stopped && !this.shutdownSignal?.aborted && !this.outage) { this.outage = true; this.onError(error); }
        }).finally(() => { this.flushing = null; });
        return this.flushing;
    }

    async syncMysql() {
        if (!this.schemaReady) {
            await this.db.query(fs.readFileSync(path.join(__dirname, '../sql/create_member_audit_history_table.sql'), 'utf8'));
            this.schemaReady = true;
        }
        if (!this.loadedMysql) {
            const [rows] = await this.db.query('SELECT guild_id, user_id, state_json FROM member_audit_history ORDER BY updated_at_ms DESC LIMIT ?', [this.maxEntries]);
            if (this.stopped || this.shutdownSignal?.aborted) return;
            for (const row of rows) {
                const saved = typeof row.state_json === 'string' || Buffer.isBuffer(row.state_json) ? JSON.parse(row.state_json) : row.state_json;
                if (!saved || String(saved.guildId) !== String(row.guild_id) || String(saved.userId) !== String(row.user_id)) throw new Error('Invalid MySQL member audit record.');
                const key = this.key(saved.guildId, saved.userId), local = this.entries.get(key);
                if (!local || (saved.updatedAt || 0) > (local.updatedAt || 0)) { this.entries.set(key, saved); this.dirty.delete(key); }
                else if ((local.updatedAt || 0) > (saved.updatedAt || 0)) this.dirty.add(key);
            }
            const present = new Set(rows.map(row => this.key(row.guild_id, row.user_id)));
            for (const key of this.entries.keys()) if (!present.has(key)) this.dirty.add(key);
            this.loadedMysql = true;
            this.persist();
        }
        for (const key of [...this.dirty]) {
            if (this.stopped || this.shutdownSignal?.aborted) return;
            const entry = this.entries.get(key);
            if (!entry) { this.dirty.delete(key); continue; }
            const version = entry.updatedAt, json = JSON.stringify(entry);
            await this.db.query(`INSERT INTO member_audit_history (guild_id, user_id, state_json, updated_at_ms)
                VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE
                state_json = IF(VALUES(updated_at_ms) >= updated_at_ms, VALUES(state_json), state_json),
                updated_at_ms = GREATEST(updated_at_ms, VALUES(updated_at_ms))`, [entry.guildId, entry.userId, json, version]);
            if (this.entries.get(key)?.updatedAt === version) this.dirty.delete(key);
            this.persist();
        }
        if (this.outage) console.log('[CC LOG] Member audit MySQL storage restored; pending JSON history synchronized.');
        this.outage = false;
    }

    startSyncLoop() {
        if (this.timer || this.stopped || this.shutdownSignal?.aborted) return;
        this.timer = setInterval(() => { void this.flush(); }, this.retryMs);
        this.timer.unref?.();
        return this.flush();
    }

    stopSyncLoop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = null;
        this.persist();
        return this.flushing;
    }

    seedMembers(members) {
        for (const member of members.values()) {
            if (this.pendingJoins.has(this.key(member.guild.id, member.id))) continue;
            const entry = this.entry(member.guild.id, member.id);
            // A join may finish while the startup roster is still loading.
            if (member.joinedTimestamp != null && entry.lastJoinedAt > member.joinedTimestamp) continue;
            // A gateway departure during the initial fetch takes precedence over its snapshot.
            if (entry.lastDeparture?.at >= (member.joinedTimestamp ?? 0) && !entry.inServer) continue;
            entry.knownMember = true;
            entry.inServer = true;
            entry.lastJoinedAt = member.joinedTimestamp ?? entry.lastJoinedAt ?? Date.now();
            entry.updatedAt = Math.max(Date.now(), (entry.updatedAt || 0) + 1);
            this.dirty.add(this.key(entry.guildId, entry.userId));
        }
        this.persist();
        if (this.timer) void this.flush();
    }

    beginDeparture(member, at) {
        this.recordDeparture(member, 'unknown', at);
        const key = this.key(member.guild.id, member.id);
        let resolve;
        const token = { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
        this.pendingDepartures.set(key, token);
        return token;
    }

    finishDeparture(member, token) {
        if (!token) return;
        const key = this.key(member.guild.id, member.id);
        if (this.pendingDepartures.get(key) === token) this.pendingDepartures.delete(key);
        token.resolve();
    }

    async waitForDeparture(member, timeoutMs = 5000) {
        const pending = this.pendingDepartures.get(this.key(member.guild.id, member.id));
        if (!pending) return;
        let timer;
        try { await Promise.race([pending.promise, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
        finally { clearTimeout(timer); }
    }

    beginJoin(member) { this.pendingJoins.add(this.key(member.guild.id, member.id)); }
    finishJoin(member) { this.pendingJoins.delete(this.key(member.guild.id, member.id)); }

    recordDeparture(member, kind, at) {
        const entry = this.entry(member.guild.id, member.id);
        const membershipJoinedAt = member.joinedTimestamp ?? entry.lastJoinedAt ?? null;
        const prior = entry.lastDeparture;
        const preserveBan = kind === 'unknown' && prior?.kind === 'banned' &&
            (prior.joinedAt === membershipJoinedAt ||
                (prior.joinedAt === null && (membershipJoinedAt === null || membershipJoinedAt <= prior.at) &&
                    Math.abs(at - prior.at) < 30000));
        if (!preserveBan && (!prior || prior.at <= at)) entry.lastDeparture = { kind, at, joinedAt: membershipJoinedAt };
        entry.knownMember = true;
        if (!entry.lastJoinedAt || entry.lastJoinedAt <= at) entry.inServer = false;
        this.changed(entry, at);
    }

    recordBan(ban, at) {
        const entry = this.entry(ban.guild.id, ban.user.id);
        entry.lastDeparture = { kind: 'banned', at, joinedAt: entry.lastJoinedAt ?? null };
        entry.inServer = false;
        this.changed(entry, at);
    }

    recordUnban(ban, at, executor = null) {
        const entry = this.entry(ban.guild.id, ban.user.id);
        // Audit-log lookups can finish after another ban/unban cycle.
        if (entry.lastUnban?.at > at) return;
        entry.lastUnban = { at, executor: executor ? { id: executor.id, username: executor.username, globalName: executor.globalName } : null };
        this.changed(entry, at);
    }

    recordJoin(member, at = Date.now()) {
        const entry = this.entry(member.guild.id, member.id);
        const joinedAt = member.joinedTimestamp ?? at;
        if (entry.inServer && entry.lastJoinedAt === joinedAt) return null;
        const rejoined = Boolean(entry.knownMember || member.flags?.has(GuildMemberFlags.DidRejoin));
        const departure = entry.lastDeparture?.at >= (entry.lastJoinedAt || 0) && entry.lastDeparture.at <= joinedAt
            ? entry.lastDeparture : null;
        const unban = entry.lastUnban?.at <= joinedAt && entry.lastUnban.at > (entry.lastJoinedAt || 0) &&
            (!departure || entry.lastUnban.at >= departure.at)
            ? entry.lastUnban : null;
        const context = { rejoined, joinedAt, departure, unban,
            kind: unban ? 'unbanned' : rejoined ? departure?.kind ?? 'unknown' : 'new' };
        entry.knownMember = true;
        entry.inServer = true;
        entry.lastJoinedAt = joinedAt;
        this.changed(entry, at);
        return context;
    }
}

module.exports = { MemberAuditHistory };
