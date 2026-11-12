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

function validMetadata(data) {
    return object(data) && data.version === 1 && typeof data.initialized === 'boolean'
        && (data.initialized ? validId(data.inactiveWatermark) : data.inactiveWatermark === undefined)
        && Array.isArray(data.pendingOrder) && data.pendingOrder.every(validId)
        && object(data.pending) && Object.entries(data.pending).every(([id, entry]) => validId(id) && object(entry)
            && (entry.id === undefined || entry.id === id))
        && object(data.tracked);
}

function validTrackedEntry(id, entry) {
    return validId(id) && object(entry) && typeof entry.messageId === 'string' && entry.messageId.length > 0
        && object(entry.auction) && entry.auction.id === id
        && (entry.messageMissing === undefined || typeof entry.messageMissing === 'boolean')
        && (entry.follow === undefined || validFollowState(entry.follow, id));
}

function validPayload(data) {
    return validMetadata(data) && Object.entries(data.tracked).every(([id, entry]) => validTrackedEntry(id, entry));
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

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

function freezeRecords(state) {
    for (const record of Object.values(state.tracked)) deepFreeze(record);
    return state;
}

function pick(source, keys) {
    const subset = {};
    for (const key of keys) if (Object.hasOwn(source, key)) subset[key] = source[key];
    return subset;
}

const invalidUpdate = () => Object.assign(new Error('Invalid auction update.'), { auctionStorage: true });

// Stored records are never modified in place, so an update copies only the tracked
// auctions it reads or writes and shares every other record with the current state.
function trackedDraft(source) {
    const target = { ...source };
    const touched = new Set();
    const own = key => typeof key === 'string' && Object.hasOwn(target, key);
    const { proxy, revoke } = Proxy.revocable(target, {
        get(draft, key, receiver) {
            if (own(key) && !touched.has(key)) {
                touched.add(key);
                draft[key] = structuredClone(draft[key]);
            }
            return Reflect.get(draft, key, receiver);
        },
        set(draft, key, value) {
            if (typeof key === 'string') touched.add(key);
            draft[key] = value;
            return true;
        },
        defineProperty(draft, key, descriptor) {
            if (typeof key === 'string') touched.add(key);
            return Reflect.defineProperty(draft, key, descriptor);
        },
        deleteProperty(draft, key) {
            if (own(key)) touched.add(key);
            return Reflect.deleteProperty(draft, key);
        }
    });
    return { proxy, revoke, target, touched };
}

// Validates and diffs only what an update touched; the result matches a full comparison
// because untouched records cannot have changed. Returns null when nothing changed.
function stageUpdate(before, draft, staged) {
    const { tracked: beforeTracked, revision: _revision, syncedRevision: _synced, ...beforeMeta } = before;
    const { tracked: draftTracked, revision: _draftRevision, syncedRevision: _draftSynced, ...afterMeta } = draft;
    let afterTracked, changed;
    if (draftTracked === staged.proxy) {
        afterTracked = staged.target;
        changed = [];
        for (const id of staged.touched) {
            const had = Object.hasOwn(beforeTracked, id), has = Object.hasOwn(afterTracked, id);
            if (had !== has || had && !isDeepStrictEqual(beforeTracked[id], afterTracked[id])) changed.push(id);
            else if (had) afterTracked[id] = beforeTracked[id];
        }
    } else {
        if (!object(draftTracked)) throw invalidUpdate();
        afterTracked = { ...draftTracked };
        const keys = new Set([...Object.keys(beforeTracked), ...Object.keys(afterTracked)]);
        changed = [...keys].filter(id => Object.hasOwn(beforeTracked, id) !== Object.hasOwn(afterTracked, id)
            || !isDeepStrictEqual(beforeTracked[id], afterTracked[id]));
        const changedIds = new Set(changed);
        for (const id of Object.keys(afterTracked)) if (!changedIds.has(id)) afterTracked[id] = beforeTracked[id];
    }
    if (!validMetadata({ ...afterMeta, tracked: afterTracked })
        || changed.some(id => Object.hasOwn(afterTracked, id) && !validTrackedEntry(id, afterTracked[id]))) throw invalidUpdate();
    if (!changed.length && isDeepStrictEqual(beforeMeta, afterMeta)) return null;
    const changes = changesBetween({ ...beforeMeta, tracked: pick(beforeTracked, changed) },
        { ...afterMeta, tracked: pick(afterTracked, changed) });
    // Copy the saved values so objects the caller still holds cannot change stored state.
    for (const id of changed) if (Object.hasOwn(afterTracked, id)) afterTracked[id] = deepFreeze(structuredClone(afterTracked[id]));
    const metadata = structuredClone(afterMeta);
    const next = { ...before };
    for (const key of Object.keys(next)) {
        if (!['tracked', 'revision', 'syncedRevision'].includes(key) && !Object.hasOwn(metadata, key)) delete next[key];
    }
    Object.assign(next, metadata, { tracked: afterTracked, revision: before.revision + 1 });
    if (!Number.isSafeInteger(next.revision)) throw conflict();
    return { next, changes };
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
    payload(data) { const { revision: _revision, syncedRevision: _synced, ...body } = data; return body; }

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
            this.state = freezeRecords(structuredClone(local?.version === 2 ? local.snapshot : local || this.emptyState()));
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
            this.state = freezeRecords({ ...remote.data, revision: remote.revision, syncedRevision: remote.revision });
            this.write({ version: 2, operations: [] });
            this.journal = { version: 2, operations: [] };
            this.restored();
        } catch (error) {
            if (error.auctionStorage || error.code === 'AUCTION_STORE_CONFLICT') throw error;
            this.unavailable(error);
            const snapshot = this.journal.snapshot;
            if (snapshot) this.state = freezeRecords(structuredClone(snapshot));
        }
    }

    // JSON mode reads the file on every call, so another process's saved changes stay visible.
    readState() {
        const saved = this.readLocal();
        if (saved?.version === 2 && !saved.snapshot) throw this.unavailableError();
        return saved?.version === 2 ? saved.snapshot : saved || this.emptyState();
    }

    async currentState() {
        if (!this.canUseMysql()) return this.readState();
        if (!this.state) await this.initialize();
        if (!this.state) throw this.unavailableError();
        return this.state;
    }

    async getState() {
        const state = await this.currentState();
        return this.canUseMysql() ? structuredClone(state) : state;
    }

    async getMeta() {
        const { tracked: _tracked, revision: _revision, syncedRevision: _synced, ...metadata } = await this.currentState();
        return structuredClone(metadata);
    }

    async getAuctionRecord(id) {
        const tracked = (await this.currentState()).tracked;
        return Object.hasOwn(tracked, String(id)) ? structuredClone(tracked[String(id)]) : null;
    }

    // Reads every stored auction without copying it. Stored records are frozen; `read`
    // returns the small value it needs, and undefined values are left out of the result.
    async readTracked(read) {
        const results = [];
        for (const [id, record] of Object.entries((await this.currentState()).tracked)) {
            const value = read(record, id);
            if (value !== undefined) results.push(value);
        }
        return results;
    }

    update(mutator) { return this.enqueue(() => this.updateState(mutator)); }
    async updateState(mutator) {
        const mysql = this.canUseMysql();
        if (mysql && !this.state) await this.initializeState();
        const before = mysql ? this.state : this.readState();
        if (!before) throw this.unavailableError();
        const { tracked, ...metadata } = before;
        const staged = trackedDraft(tracked);
        const draft = { ...structuredClone(metadata), tracked: staged.proxy };
        try { mutator(draft); }
        finally { staged.revoke(); }
        const result = stageUpdate(before, draft, staged);
        if (!result) return;
        if (!mysql) {
            this.write(result.next);
            return;
        }
        const operation = { id: randomUUID(), baseRevision: before.revision, revision: result.next.revision, ...result.changes };
        const journal = { ...this.journal, operations: [...this.journal.operations, operation] };
        this.write(journal);
        this.journal = journal;
        this.state = result.next;
        await this.flush();
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
            // A shallow copy is enough: stored records are frozen, metadata is replaced rather than
            // changed in place, only syncedRevision is set on the state object, and write() serializes now.
            const fallback = { ...this.journal, snapshot: { ...this.state } };
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

    // A receipt only matters while its operation waits in a local journal for confirmation.
    pruneReceipts(cutoffMs) { return this.enqueue(async () => {
        if (!this.canUseMysql() || !this.state || this.mysqlOutage || this.journal?.operations.length || !this.repository.pruneReceipts) return 0;
        try {
            return Number(await this.repository.pruneReceipts(cutoffMs)) || 0;
        } catch (error) {
            console.warn('[CC LOG] Old PRO auction change receipts could not be removed; retrying later:', error.code || error.message);
            return 0;
        }
    }); }

    reconcile() { return this.enqueue(async () => {
        if (!this.canUseMysql()) return;
        if (!this.state) await this.initializeState();
        else if (this.journal.operations.length || this.mysqlOutage) await this.flush();
        if (!this.state) throw this.unavailableError();
    }); }
}

module.exports = { AuctionStore };
