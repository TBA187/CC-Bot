// Persists auction state and replays pending database changes from the local recovery journal.
'use strict';

const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const { readJsonObject, writeJsonIfChanged } = require('../../utils/jsonFile.js');
const { validFollowState } = require('./AuctionFollowService.js');
const { randomUUID } = require('node:crypto');
const { AuctionSqlRepository, changesBetween, specs, conflict, projectOperation } = require('./AuctionSqlRepository.js');

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^\d+$/.test(value);

function validPayload(data) {
    return object(data) && data.version === 1 && typeof data.initialized === 'boolean'
        && (data.initialized ? validId(data.inactiveWatermark) : data.inactiveWatermark === undefined)
        && Array.isArray(data.pendingOrder) && data.pendingOrder.every(validId)
        && object(data.pending) && Object.entries(data.pending).every(([id, entry]) => validId(id) && object(entry)
            && (entry.id === undefined || entry.id === id))
        && object(data.tracked) && Object.entries(data.tracked).every(([id, entry]) => validId(id) && object(entry)
            && typeof entry.messageId === 'string' && entry.messageId.length > 0 && object(entry.auction)
            && entry.auction.id === id && (entry.messageMissing === undefined || typeof entry.messageMissing === 'boolean')
            && (entry.follow === undefined || validFollowState(entry.follow, id)));
}

function validLocal(data) {
    const revision = data?.revision;
    const synced = data?.syncedRevision;
    return validPayload(data) && Number.isSafeInteger(revision) && revision >= 0
        && Number.isSafeInteger(synced) && synced >= 0 && synced <= revision;
}

function validJournal(data) {
    return data.version === 2 && Array.isArray(data.operations) && data.operations.every(op => object(op)
        && typeof op.id === 'string' && /^[a-f0-9-]{36}$/i.test(op.id)
        && Number.isSafeInteger(op.baseRevision) && op.baseRevision >= 0
        && Number.isSafeInteger(op.revision) && op.revision > op.baseRevision
        && object(op.metadata) && typeof op.metadata.initialized === 'boolean' && Array.isArray(op.metadata.pendingOrder)
        && op.metadata.pendingOrder.every(validId) && (!op.metadata.initialized || validId(op.metadata.inactiveWatermark))
        && Array.isArray(op.changes) && op.changes.every(validChange))
        && (data.snapshot === undefined || validLocal(data.snapshot));
}

function validChange(change) {
    if (!object(change) || !Object.hasOwn(specs, change.name)) return false;
    const spec = specs[change.name];
    if (!Array.isArray(change.keys) || change.keys.length !== spec.keys.length) return false;
    if (change.name === 'outbox') {
        const [kind, id, key] = change.keys;
        if (!validId(id) || !(kind === 'announcement' && key === '' || kind === 'bid' && typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) return false;
    } else if (!change.keys.every(validId)) return false;
    if (change.columns !== undefined && (!Array.isArray(change.columns) || !change.columns.length
        || new Set(change.columns).size !== change.columns.length || change.columns.some(column => !spec.columns.includes(column)))) return false;
    return change.values === null ? change.columns === undefined
        : Array.isArray(change.values) && change.values.length === (change.columns || spec.columns).length;
}

class AuctionStore {
    constructor(options = {}) {
        this.dataFile = options.dataFile || path.join(process.cwd(), 'data', 'forum_auctions.json');
        this.tempFile = `${this.dataFile}.tmp`;
        this.db = options.db;
        this.storageMode = String(options.storageMode ?? process.env.STORAGE_MODE ?? 'auto').toLowerCase();
        this.hasMysqlConfig = options.hasMysqlCredentials ?? this.db?.hasRequiredConfig
            ?? Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
        this.repository = options.repository || (this.db ? new AuctionSqlRepository(this.db) : null);
        this.writeQueue = Promise.resolve();
        this.state = null;
        this.journal = null;
        this.mysqlOutage = false;
    }

    enqueue(work) {
        const result = this.writeQueue.then(work);
        this.writeQueue = result.catch(() => {});
        return result;
    }

    waitForWrites() { return this.writeQueue; }
    initialize() { return this.enqueue(() => this.initializeState()); }
    canUseMysql() { return this.storageMode !== 'json' && Boolean(this.repository) && Boolean(this.hasMysqlConfig); }
    emptyState() { return { version: 1, revision: 0, syncedRevision: 0, initialized: false, pendingOrder: [], pending: {}, tracked: {} }; }
    payload(data) { const { revision, syncedRevision, ...body } = data; return body; }

    write(data) {
        try { writeJsonIfChanged(this.dataFile, this.tempFile, data); }
        catch (error) { error.auctionStorage = true; throw error; }
    }

    readLocal() { return readJsonObject(this.dataFile, data => validLocal(data) || validJournal(data)); }
    unavailableError() { return Object.assign(new Error('Auction storage is unavailable; waiting for MySQL without resetting auction state.'), { code: 'AUCTION_STORAGE_UNAVAILABLE' }); }
    unavailable(error) {
        if (!this.mysqlOutage) console.warn('[CC LOG] Shared auction state unavailable; pending changes retained:', error.code || error.message);
        this.mysqlOutage = true;
    }
    restored() {
        if (this.mysqlOutage) console.log('[CC LOG] Shared auction state restored and synchronized.');
        this.mysqlOutage = false;
    }

    async initializeState() {
        const local = this.readLocal();
        if (!this.canUseMysql()) {
            if (local?.version === 2 && !local.snapshot) throw this.unavailableError();
            this.state = structuredClone(local?.version === 2 ? local.snapshot : local || this.emptyState());
            return;
        }
        if (local?.version === 1) throw Object.assign(new Error('Full JSON auction state requires JSON storage mode; the saved data was preserved.'), { code: 'AUCTION_STORE_CONFLICT' });
        this.journal = local || { version: 2, operations: [] };
        try {
            let remote = await this.repository.load();
            if (!remote) {
                await this.repository.apply({ id: randomUUID(), baseRevision: 0, revision: 0, ...changesBetween(this.emptyState(), this.emptyState()) });
                remote = await this.repository.load();
            }
            if (!remote || !validPayload(remote.data) || !Number.isSafeInteger(remote.revision) || remote.revision < 0) throw conflict();
            await this.replay(remote);
            if (this.journal.operations.length) remote = await this.repository.load();
            if (!remote || !validPayload(remote.data)) throw conflict();
            this.state = { ...remote.data, revision: remote.revision, syncedRevision: remote.revision };
            this.write({ version: 2, operations: [] });
            this.journal = { version: 2, operations: [] };
            this.restored();
        } catch (error) {
            if (error.auctionStorage || error.code === 'AUCTION_STORE_CONFLICT') throw error;
            this.unavailable(error);
            const snapshot = this.journal.snapshot;
            if (snapshot) this.state = structuredClone(snapshot);
        }
    }

    async getState() {
        if (!this.canUseMysql()) {
            const saved = this.readLocal();
            if (saved?.version === 2 && !saved.snapshot) throw this.unavailableError();
            return structuredClone(saved?.version === 2 ? saved.snapshot : saved || this.emptyState());
        }
        if (!this.state) await this.initialize();
        if (!this.state) throw this.unavailableError();
        return structuredClone(this.state);
    }

    update(mutator) { return this.enqueue(() => this.updateState(mutator)); }
    async updateState(mutator) {
        if (this.canUseMysql() && !this.state) await this.initializeState();
        const before = this.canUseMysql() ? this.state : await this.getState();
        if (!before) throw this.unavailableError();
        const draft = structuredClone(before);
        mutator(draft);
        if (!validPayload(draft)) throw Object.assign(new Error('Invalid auction update.'), { auctionStorage: true });
        if (isDeepStrictEqual(this.payload(before), this.payload(draft))) return structuredClone(before);
        draft.revision = before.revision + 1;
        if (!Number.isSafeInteger(draft.revision)) throw conflict();
        if (!this.canUseMysql()) {
            this.write(draft);
            return structuredClone(draft);
        }
        const operation = { id: randomUUID(), baseRevision: before.revision, revision: draft.revision, ...changesBetween(before, draft) };
        const journal = { ...this.journal, operations: [...this.journal.operations, operation] };
        this.write(journal);
        this.journal = journal;
        this.state = structuredClone(draft);
        await this.flush();
        return structuredClone(this.state);
    }

    async flush() {
        try {
            if (this.mysqlOutage) {
                const remote = await this.repository.load();
                if (!remote || !validPayload(remote.data)) throw conflict();
                await this.replay(remote);
            } else for (const operation of this.journal.operations) await this.repository.apply(operation);
            const clean = { version: 2, operations: [] };
            this.write(clean);
            this.journal = clean;
            this.state.syncedRevision = this.state.revision;
            this.restored();
        } catch (error) {
            if (error.auctionStorage || error.code === 'AUCTION_STORE_CONFLICT') throw error;
            this.unavailable(error);
            const fallback = { ...this.journal, snapshot: structuredClone(this.state) };
            this.write(fallback);
            this.journal = fallback;
        }
    }

    async replay(remote) {
        for (const operation of this.journal.operations) {
            let projected;
            if (operation.revision > remote.revision) {
                try { projected = projectOperation(remote.data, operation); }
                catch { throw conflict(); }
                if (operation.baseRevision !== remote.revision || !validPayload(projected)) throw conflict();
            }
            await this.repository.apply(operation);
            if (projected) remote = { revision: operation.revision, data: projected };
        }
    }

    reconcile() { return this.enqueue(async () => {
        if (!this.canUseMysql()) return;
        if (!this.state) await this.initializeState();
        else if (this.journal.operations.length || this.mysqlOutage) await this.flush();
        if (!this.state) throw this.unavailableError();
    }); }

    async getAuctionRecord(id) { return (await this.getState()).tracked[String(id)] || null; }
}

module.exports = { AuctionStore };

