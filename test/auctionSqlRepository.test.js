// Verifies transactional auction writes, revision conflicts, schema consistency, and recovery.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuctionSqlRepository, schemaStatements, operationHash, changesBetween, projectOperation, inflate } = require('../features/auctions/AuctionSqlRepository.js');

test('SQL mutations lock the revision, update only changed rows and commit a receipt in the same transaction', async () => {
    const calls = [];
    const connection = { async beginTransaction() { calls.push('begin'); }, async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); }, release() { calls.push('release'); }, async query(sql, values) {
            calls.push({ sql, values });
            if (sql.startsWith('SELECT revision FROM forum_auction_control')) return [[{ revision: 4 }]];
            if (sql.startsWith('SELECT revision, operation_hash FROM forum_auction_control')) return [[]];
            return [{ affectedRows: 1 }];
        } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await repository.apply({ id: 'a', baseRevision: 4, revision: 5, metadata: { initialized: false, pendingOrder: [] },
        changes: [{ name: 'subscriptions', keys: ['101', '111'], values: ['2026-11-04T00:00:00Z'] }] });
    assert.equal(calls[0], 'begin');
    assert.match(calls[1].sql, /FOR UPDATE/);
    const writes = calls.filter(call => call.sql?.startsWith('INSERT'));
    assert.equal(writes.length, 3);
    assert.match(writes[0].sql, /forum_auction_subscriptions/);
    assert.deepEqual(writes[0].values, ['101', '111', '2026-11-04T00:00:00Z']);
    assert.deepEqual(calls.slice(-2), ['commit', 'release']);
});

test('SQL conflicts roll back without modifying rows and always release the connection', async () => {
    const calls = [];
    const connection = { async beginTransaction() {}, async commit() { assert.fail(); }, async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); }, async query(sql) { if (sql.includes('forum_auction_control')) return [[{ revision: 9 }]]; return [[]]; } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await assert.rejects(repository.apply({ id: 'a', baseRevision: 4, revision: 5 }), { code: 'AUCTION_STORE_CONFLICT' });
    assert.deepEqual(calls, ['rollback', 'release']);
});

test('SQL write failures roll back the complete operation', async () => {
    let rolledBack = false, released = false;
    const connection = { async beginTransaction() {}, async commit() { assert.fail(); }, async rollback() { rolledBack = true; }, release() { released = true; },
        async query(sql) { if (sql.startsWith('SELECT revision FROM forum_auction_control')) return [[{ revision: 0 }]];
            if (sql.startsWith('SELECT')) return [[]]; throw Object.assign(new Error('lost connection'), { code: 'ECONNRESET' }); } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await assert.rejects(repository.apply({ id: 'a', baseRevision: 0, revision: 1, changes: [{ name: 'outbox', keys: ['bid', '101', 'a'.repeat(64)], values: ['{}', '["111"]'] }] }), { code: 'ECONNRESET' });
    assert.equal(rolledBack, true); assert.equal(released, true);
});

test('SQL definitions contain indexed subscriber rows and match the checked-in schema', () => {
    const fs = require('node:fs');
    const schema = fs.readFileSync(require('node:path').join(__dirname, '../sql/create_forum_auction_tables.sql'), 'utf8')
        .replace(/^(?:--[^\r\n]*(?:\r?\n|$)|\r?\n)+/, '');
    const normalize = sql => sql.replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim();
    assert.equal(normalize(schema), normalize(schemaStatements().join(';\n\n') + ';\n'));
    assert.ok(schemaStatements().some(sql => /forum_auction_subscriptions/.test(sql) && /PRIMARY KEY \(auction_id, user_id\)/.test(sql)));
    assert.equal(schemaStatements().length, 4);
});

test('a receipt accepts the same operation and rejects altered recovery data under the same ID', async () => {
    const operation = { id: 'operation', baseRevision: 4, revision: 5, metadata: { initialized: false, pendingOrder: [] }, changes: [] };
    let digest = operationHash(operation), writes = 0;
    const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, async query(sql) {
        if (sql.startsWith('SELECT revision FROM forum_auction_control')) return [[{ revision: 6 }]];
        if (sql.startsWith('SELECT revision, operation_hash')) return [[{ revision: 5, operation_hash: digest }]];
        writes++; return [{}];
    } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await repository.apply(operation);
    assert.equal(writes, 0);
    digest = '0'.repeat(64);
    await assert.rejects(repository.apply(operation), { code: 'AUCTION_STORE_CONFLICT' });
    assert.equal(writes, 0);
});

test('follow metadata changes update one column without copying the auction snapshot', async () => {
    const before = { version: 1, initialized: false, pendingOrder: [], pending: {}, tracked: {
        '101': { messageId: '123', auction: { id: '101', description: 'A long auction description' } }
    } };
    const after = structuredClone(before);
    after.tracked['101'].follow = { seenBids: [], users: { '111': { followedAt: '2026-11-04T00:00:00Z' } }, pending: {} };
    const delta = changesBetween(before, after);
    const record = delta.changes.find(change => change.name === 'records');
    assert.deepEqual(record.columns, ['follow_details']);
    assert.equal(JSON.stringify(delta).includes('A long auction description'), false);
    assert.deepEqual(projectOperation(before, delta), after);
    const writes = [];
    const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, async query(sql, values) {
        if (sql.startsWith('SELECT revision FROM')) return [[{ revision: 4 }]];
        if (sql.startsWith('SELECT')) return [[]];
        writes.push({ sql, values }); return [{ affectedRows: 1 }];
    } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await repository.apply({ id: 'operation', baseRevision: 4, revision: 5, ...delta });
    assert.equal(writes[0].sql, 'UPDATE forum_auctions SET follow_details = ? WHERE auction_id = ?');
    assert.deepEqual(writes[0].values, ['{"seenBids":[]}', '101']);
});

test('the shared outbox preserves independent announcement and bid jobs across a reload', () => {
    const key = 'a'.repeat(64);
    const job = { recipients: ['111', '222'], bid: { amount: '100' } };
    const data = inflate({ details: '{"initialized":false,"pendingOrder":["101"]}' }, {
        records: [{ auction_id: '101', message_id: '123', message_missing: null, details: '{"id":"101"}', follow_details: '{"seenBids":[]}' }],
        subscriptions: [{ auction_id: '101', user_id: '111', followed_at: '2026-11-04T00:00:00Z' }, { auction_id: '101', user_id: '222', followed_at: '2026-11-04T00:00:00Z' }],
        outbox: [{ kind: 'announcement', auction_id: '101', bid_key: '', details: '{"id":"101","attempts":1}', recipients: null },
            { kind: 'bid', auction_id: '101', bid_key: key, details: '{"bid":{"amount":"100"}}', recipients: '["111","222"]' }]
    });
    assert.deepEqual(data.pending['101'], { id: '101', attempts: 1 });
    assert.deepEqual(data.tracked['101'].follow.pending[key], job);
    const after = structuredClone(data);
    after.tracked['101'].follow.pending[key].recipients = ['222'];
    delete after.tracked['101'].follow.users['111'];
    const delta = changesBetween(data, after);
    assert.deepEqual(delta.changes.map(change => change.name).sort(), ['outbox', 'subscriptions']);
    assert.deepEqual(delta.changes.find(change => change.name === 'outbox').columns, ['recipients']);
    assert.deepEqual(delta.changes.find(change => change.name === 'outbox').values, ['["222"]']);
    assert.deepEqual(projectOperation(data, delta), after);
    delete after.tracked['101'].follow;
    const endDelta = changesBetween(data, after);
    assert.deepEqual(endDelta.changes.find(change => change.name === 'records').values, [null]);
    assert.equal(endDelta.changes.filter(change => change.name === 'subscriptions' && change.values === null).length, 2);
    assert.deepEqual(projectOperation(data, endDelta), after);
    assert.deepEqual(after.pending['101'], data.pending['101'], 'ending a subscription does not remove independent announcement work');
});

test('missing control metadata cannot silently discard existing auctions', async () => {
    let rolledBack = false;
    const connection = { async beginTransaction() {}, async commit() { assert.fail(); }, async rollback() { rolledBack = true; }, release() {}, async query(sql) {
        return sql.includes('forum_auctions') ? [[{ present: 1 }]] : [[]];
    } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await assert.rejects(repository.load(), { code: 'AUCTION_STORE_CONFLICT' });
    assert.equal(rolledBack, true);
});

test('remaining write receipts prevent a missing checkpoint from becoming a new empty database', async () => {
    let rolledBack = false;
    const connection = { async beginTransaction() {}, async commit() {}, async rollback() { rolledBack = true; }, release() {},
        async query(sql) { return sql === 'SELECT 1 FROM forum_auction_control LIMIT 1' ? [[{ present: 1 }]] : [[]]; } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await assert.rejects(repository.load(), { code: 'AUCTION_STORE_CONFLICT' });
    assert.equal(rolledBack, true);
});

test('partial updates to a missing row roll back rather than acknowledging lost work', async () => {
    let rolledBack = false;
    const connection = { async beginTransaction() {}, async commit() { assert.fail(); }, async rollback() { rolledBack = true; }, release() {}, async query(sql) {
        if (sql.startsWith('SELECT revision FROM')) return [[{ revision: 4 }]];
        if (sql.startsWith('SELECT')) return [[]];
        return [{ affectedRows: 0 }];
    } };
    const repository = new AuctionSqlRepository({ async query() {}, async getConnection() { return connection; } });
    await assert.rejects(repository.apply({ id: 'operation', baseRevision: 4, revision: 5,
        changes: [{ name: 'records', keys: ['101'], columns: ['follow_details'], values: [null] }] }), { code: 'AUCTION_STORE_CONFLICT' });
    assert.equal(rolledBack, true);
});
