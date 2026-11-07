// Stores auction changes transactionally with revision checks and retry receipts.
'use strict';

const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');

const specs = {
    records: { table: 'forum_auctions', keys: ['auction_id'], columns: ['message_id', 'message_missing', 'details', 'follow_details'] },
    subscriptions: { table: 'forum_auction_subscriptions', keys: ['auction_id', 'user_id'], columns: ['followed_at'] },
    outbox: { table: 'forum_auction_outbox', keys: ['kind', 'auction_id', 'bid_key'], columns: ['details', 'recipients'] }
};

function flatten(data) {
    const rows = Object.fromEntries(Object.keys(specs).map(name => [name, {}]));
    const put = (name, keys, values) => { rows[name][keys.join(':')] = { keys, values }; };
    for (const [id, record] of Object.entries(data.tracked)) {
        const follow = record.follow;
        const followDetails = follow ? JSON.stringify({ seenBids: follow.seenBids,
            ...(follow.baselinePendingUsers === undefined ? {} : { baselinePendingUsers: follow.baselinePendingUsers }),
            ...(follow.currentAuction === undefined ? {} : { currentAuction: follow.currentAuction }) }) : null;
        put('records', [id], [record.messageId, record.messageMissing === undefined ? null : Number(record.messageMissing), JSON.stringify(record.auction), followDetails]);
        if (!record.follow) continue;
        for (const [user, entry] of Object.entries(follow.users)) put('subscriptions', [id, user], [entry.followedAt]);
        for (const [key, job] of Object.entries(follow.pending)) {
            const { recipients, ...details } = job;
            put('outbox', ['bid', id, key], [JSON.stringify(details), JSON.stringify(recipients)]);
        }
    }
    for (const [id, entry] of Object.entries(data.pending)) put('outbox', ['announcement', id, ''], [JSON.stringify(entry), null]);
    return rows;
}

function metadata(data) {
    return { initialized: data.initialized, ...(data.inactiveWatermark === undefined ? {} : { inactiveWatermark: data.inactiveWatermark }), pendingOrder: data.pendingOrder };
}

function changesBetween(before, after) {
    const oldRows = flatten(before), newRows = flatten(after), changes = [];
    for (const name of Object.keys(specs)) {
        for (const [key, row] of Object.entries(newRows[name])) {
            const previous = oldRows[name][key];
            if (isDeepStrictEqual(row, previous)) continue;
            if (!previous) changes.push({ name, ...row });
            else {
                const indices = specs[name].columns.map((_, i) => i).filter(i => !isDeepStrictEqual(row.values[i], previous.values[i]));
                changes.push({ name, keys: row.keys, columns: indices.map(i => specs[name].columns[i]), values: indices.map(i => row.values[i]) });
            }
        }
        for (const [key, row] of Object.entries(oldRows[name])) if (!newRows[name][key]) changes.push({ name, keys: row.keys, values: null });
    }
    return { changes, metadata: metadata(after) };
}

function projectOperation(before, operation) {
    const flat = flatten(before);
    for (const change of operation.changes) {
        if (change.values === null) delete flat[change.name][change.keys.join(':')];
        else if (change.columns) {
            const row = flat[change.name][change.keys.join(':')];
            if (!row) throw conflict();
            for (let i = 0; i < change.columns.length; i++) row.values[specs[change.name].columns.indexOf(change.columns[i])] = change.values[i];
        } else flat[change.name][change.keys.join(':')] = { keys: change.keys, values: change.values };
    }
    const rows = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, Object.values(flat[name]).map(row =>
        Object.fromEntries([...spec.keys, ...spec.columns].map((column, i) => [column, [...row.keys, ...row.values][i]])))]));
    return inflate({ details: JSON.stringify(operation.metadata) }, rows);
}

function inflate(meta, rows) {
    const data = { version: 1, ...JSON.parse(meta.details), pending: {}, tracked: {} };
    for (const r of rows.records) data.tracked[r.auction_id] = { messageId: r.message_id, auction: JSON.parse(r.details),
        ...(r.message_missing === null ? {} : { messageMissing: Boolean(Number(r.message_missing)) }),
        ...(r.follow_details === null ? {} : { follow: { ...JSON.parse(r.follow_details), users: {}, pending: {} } }) };
    for (const r of rows.subscriptions) data.tracked[r.auction_id].follow.users[r.user_id] = { followedAt: r.followed_at };
    for (const r of rows.outbox) {
        if (r.kind === 'announcement' && r.bid_key === '' && r.recipients === null) data.pending[r.auction_id] = JSON.parse(r.details);
        else if (r.kind === 'bid' && /^[a-f0-9]{64}$/.test(r.bid_key)) data.tracked[r.auction_id].follow.pending[r.bid_key] = { ...JSON.parse(r.details), recipients: JSON.parse(r.recipients) };
        else throw conflict();
    }
    return data;
}

const conflict = () => Object.assign(new Error('Auction recovery conflicts with newer shared state; pending operations were preserved.'), { code: 'AUCTION_STORE_CONFLICT' });
function operationHash(operation) {
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(canonical(operation))).digest('hex');
}

function schemaStatements() {
    const result = [
        `CREATE TABLE IF NOT EXISTS forum_auction_control (entry_id VARCHAR(36) NOT NULL PRIMARY KEY,
            revision BIGINT UNSIGNED NOT NULL, operation_hash CHAR(64) NULL, details LONGTEXT NULL, INDEX (revision)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];
    for (const spec of Object.values(specs)) {
        const fields = [...spec.keys.map(key => `${key} ${key === 'bid_key' ? 'CHAR(64)' : 'VARCHAR(20)'} NOT NULL`),
            ...spec.columns.map(column => `${column} ${column === 'message_missing' ? 'TINYINT NULL' : ['follow_details', 'recipients'].includes(column) ? 'LONGTEXT NULL' : column === 'details' ? 'LONGTEXT NOT NULL' : 'VARCHAR(32) NOT NULL'}`)];
        result.push(`CREATE TABLE IF NOT EXISTS ${spec.table} (${fields.join(', ')}, PRIMARY KEY (${spec.keys.join(', ')})${spec === specs.subscriptions ? ', INDEX (user_id)' : ''}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }
    return result;
}

class AuctionSqlRepository {
    constructor(db) { this.db = db; this.ready = false; }

    async ensureSchema() {
        if (this.ready) return;
        for (const sql of schemaStatements()) await this.db.query(sql);
        this.ready = true;
    }

    async transaction(work) {
        await this.ensureSchema();
        const connection = await this.db.getConnection();
        try {
            await connection.beginTransaction();
            const result = await work(connection);
            await connection.commit();
            return result;
        } catch (error) { await connection.rollback().catch(() => {}); throw error; }
        finally { connection.release(); }
    }

    async load() {
        return this.transaction(async connection => {
            const [meta] = await connection.query('SELECT revision, details FROM forum_auction_control WHERE entry_id = ? FOR UPDATE', ['main']);
            if (!meta.length) {
                const [control] = await connection.query('SELECT 1 FROM forum_auction_control LIMIT 1');
                if (control.length) throw conflict();
                for (const spec of Object.values(specs)) {
                    const [existing] = await connection.query(`SELECT 1 FROM ${spec.table} LIMIT 1`);
                    if (existing.length) throw conflict();
                }
                return null;
            }
            const rows = {};
            for (const [name, spec] of Object.entries(specs)) [rows[name]] = await connection.query(`SELECT * FROM ${spec.table}`);
            try { return { revision: Number(meta[0].revision), data: inflate(meta[0], rows) }; }
            catch (cause) { throw Object.assign(conflict(), { cause }); }
        });
    }

    async apply(operation) {
        return this.transaction(async connection => {
            const [meta] = await connection.query('SELECT revision FROM forum_auction_control WHERE entry_id = ? FOR UPDATE', ['main']);
            const digest = operationHash(operation);
            const [receipts] = await connection.query('SELECT revision, operation_hash FROM forum_auction_control WHERE entry_id = ?', [operation.id]);
            if (receipts.length) {
                if (Number(receipts[0].revision) !== operation.revision || receipts[0].operation_hash !== digest) throw conflict();
                return;
            }
            if ((meta.length ? Number(meta[0].revision) : 0) !== operation.baseRevision) throw conflict();
            for (const change of operation.changes) {
                const spec = Object.hasOwn(specs, change.name) && specs[change.name];
                if (!spec || change.keys.length !== spec.keys.length) throw conflict();
                if (change.values === null) await connection.query(`DELETE FROM ${spec.table} WHERE ${spec.keys.map(key => `${key} = ?`).join(' AND ')}`, change.keys);
                else {
                    const columns = change.columns || spec.columns;
                    if (!Array.isArray(columns) || !Array.isArray(change.values) || change.values.length !== columns.length || !columns.length
                        || new Set(columns).size !== columns.length || columns.some(column => !spec.columns.includes(column))) throw conflict();
                    if (change.columns) {
                        const [result] = await connection.query(`UPDATE ${spec.table} SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE ${spec.keys.map(key => `${key} = ?`).join(' AND ')}`, [...change.values, ...change.keys]);
                        if (!result.affectedRows) throw conflict();
                    } else {
                        const fields = [...spec.keys, ...columns];
                        await connection.query(`INSERT INTO ${spec.table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${columns.map(column => `${column} = VALUES(${column})`).join(', ')}`, [...change.keys, ...change.values]);
                    }
                }
            }
            await connection.query('INSERT INTO forum_auction_control (entry_id, revision, details) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE revision = VALUES(revision), details = VALUES(details)', ['main', operation.revision, JSON.stringify(operation.metadata)]);
            await connection.query('INSERT INTO forum_auction_control (entry_id, revision, operation_hash) VALUES (?, ?, ?)', [operation.id, operation.revision, digest]);
        });
    }
}

module.exports = { AuctionSqlRepository, changesBetween, specs, conflict, inflate, schemaStatements, operationHash, projectOperation };
