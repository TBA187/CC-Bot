'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');

const member = (id = '1', joinedTimestamp = 1000) => ({ id, guild: { id: 'guild' }, joinedTimestamp });

function database() {
    const rows = new Map();
    let offline = false, beforeWrite = null;
    return { rows, hasRequiredConfig: true,
        setOffline: value => { offline = value; }, setBeforeWrite: callback => { beforeWrite = callback; },
        async query(sql, params = []) {
            if (offline) throw new Error('MySQL unavailable');
            if (sql.startsWith('CREATE TABLE')) return [[], []];
            if (sql.includes('WHERE guild_id')) return [[...rows.values()].filter(row =>
                row.guild_id === params[0] && row.user_id === params[1])];
            if (sql.startsWith('SELECT')) return [[...rows.values()].sort((a, b) => b.updated_at_ms - a.updated_at_ms).slice(0, params[0])];
            assert.match(sql, /^INSERT INTO member_audit_history/);
            if (beforeWrite) { const callback = beforeWrite; beforeWrite = null; await callback(); }
            const [guild_id, user_id, state_json, updated_at_ms] = params, key = `${guild_id}:${user_id}`;
            if (!rows.has(key) || rows.get(key).updated_at_ms <= updated_at_ms) rows.set(key, { guild_id, user_id, state_json, updated_at_ms });
            return [{ affectedRows: 1 }];
        }
    };
}

test('JSON-only history stays bounded without waiting for a MySQL acknowledgement', () => {
    for (const options of [{ storageMode: 'json', db: database() }, { storageMode: 'auto' }]) {
        const history = new MemberAuditHistory({ ...options, maxEntries: 2 });
        for (let i = 1; i <= 5; i++) history.recordJoin(member(String(i)), Date.now() + i);
        assert.equal(history.entries.size, 2);
        assert.equal(history.dirty.size, 2);
        assert.deepEqual([...history.entries.keys()], ['guild:4', 'guild:5']);
    }
});

test('a new membership does not inherit a ban while its rapid departure is awaiting classification', () => {
    const history = new MemberAuditHistory(), first = member();
    history.recordJoin(first, 1000);
    history.recordBan({ guild: first.guild, user: { id: first.id } }, 2000);
    history.beginDeparture(first, 2001);
    assert.equal(history.entry('guild', '1').lastDeparture.kind, 'banned');
    history.recordUnban({ guild: first.guild, user: { id: first.id } }, 3000);
    const returned = member('1', 4000);
    history.recordJoin(returned, 4000);
    const token = history.beginDeparture(returned, 5000);
    assert.equal(history.entry('guild', '1').lastDeparture.kind, 'unknown');
    history.finishDeparture(returned, token);
    assert.equal(history.recordJoin(member('1', 6000), 6000).kind, 'unknown');
});

test('an older unban is not attributed to a later ban and return', () => {
    const history = new MemberAuditHistory(), ban = { guild: member().guild, user: { id: '1' } };
    history.recordJoin(member(), 1000);
    history.recordBan(ban, 2000);
    history.recordUnban(ban, 3000);
    history.recordBan(ban, 4000);
    const context = history.recordJoin(member('1', 5000), 5000);
    assert.equal(context.kind, 'banned');
    assert.equal(context.unban, null);
});

test('a ban arriving before startup seeding remains a ban when its departure event arrives', () => {
    const history = new MemberAuditHistory(), departing = member('1', 1000);
    history.recordBan({ guild: departing.guild, user: { id: departing.id } }, 2000);
    const token = history.beginDeparture(departing, 2001);
    assert.equal(history.entry('guild', '1').lastDeparture.kind, 'banned');
    history.finishDeparture(departing, token);
});

test('a delayed unban audit lookup cannot overwrite a newer unban', () => {
    const history = new MemberAuditHistory(), ban = { guild: member().guild, user: { id: '1' } };
    history.recordJoin(member(), 1000);
    history.recordBan(ban, 2000);
    history.recordUnban(ban, 3000);
    history.recordBan(ban, 4000);
    history.recordUnban(ban, 5000, { id: 'latest-moderator', username: 'latest' });
    history.recordUnban(ban, 3000, { id: 'earlier-moderator', username: 'earlier' });
    const context = history.recordJoin(member('1', 6000), 6000);
    assert.equal(context.kind, 'unbanned');
    assert.equal(context.unban.at, 5000);
    assert.equal(context.unban.executor.id, 'latest-moderator');
});

test('a late startup roster cannot overwrite a completed rejoin', () => {
    const history = new MemberAuditHistory();
    history.recordJoin(member('1', 1000), 1000);
    history.recordDeparture(member('1', 1000), 'left', 2000);
    history.recordJoin(member('1', 3000), 3000);
    history.seedMembers(new Map([['1', member('1', 1000)]]));
    assert.equal(history.entry('guild', '1').lastJoinedAt, 3000);
    assert.equal(history.entry('guild', '1').inServer, true);
    assert.equal(history.recordJoin(member('1', 3000), 3000), null);
});

test('outage history survives JSON restart, retains pending writes, and recovers into MySQL', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-history-storage-'));
    const filePath = path.join(directory, 'history.json');
    t.after(() => { fs.rmSync(filePath, { force: true }); fs.rmSync(`${filePath}.tmp`, { force: true }); fs.rmdirSync(directory); });
    t.mock.method(console, 'log', () => {});
    const db = database(), errors = [];
    const history = new MemberAuditHistory({ db, filePath, maxEntries: 1, onError: error => errors.push(error) });
    await history.restore();
    history.recordJoin(member()); await history.flush();
    db.setOffline(true);
    history.recordDeparture(member(), 'left', 2000);
    history.recordJoin(member('2'), 2100);
    await history.flush(); await history.flush();
    assert.equal(errors.length, 1);
    assert.equal(history.dirty.size, 2);
    assert.equal(history.entries.size, 2, 'pending outage changes must survive the retention limit');
    const restarted = new MemberAuditHistory({ db, filePath, maxEntries: 1 });
    assert.equal(restarted.dirty.size, 2);
    db.setOffline(false); await restarted.restore();
    assert.equal(restarted.dirty.size, 0);
    assert.equal(JSON.parse(db.rows.get('guild:1').state_json).lastDeparture.kind, 'left');
    assert.equal(db.rows.size, 2);
    assert.ok(restarted.entries.size <= 1);
    // A member evicted from RAM is still recoverable from the primary store.
    await restarted.loadMember('guild', '1');
    assert.equal(restarted.recordJoin(member('1', 3000), 3000).kind, 'left');
});

test('an in-flight database write cannot acknowledge a newer membership transition', async () => {
    const db = database(), history = new MemberAuditHistory({ db });
    await history.restore();
    history.recordJoin(member(), 1000);
    db.setBeforeWrite(() => history.recordDeparture(member(), 'kicked', 2000));
    await history.flush();
    assert.equal(history.dirty.size, 1);
    await history.flush();
    assert.equal(history.dirty.size, 0);
    assert.equal(JSON.parse(db.rows.get('guild:1').state_json).lastDeparture.kind, 'kicked');
});
