'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TbaForumShopStore } = require('../features/tba-forum-shops/TbaForumShopStore.js');

function tempFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tba-shops-')), 'tba_forum_shops.json');
}

test('shop store creates one small file and preserves both topic checkpoints', async () => {
    const dataFile = tempFile();
    const store = new TbaForumShopStore({ dataFile });
    const shops = [
        { key: 'forumShop', topicUrl: 'https://example.com/forum-shop/' },
        { key: 'dungeonShop', topicUrl: 'https://example.com/dungeon-shop/' }
    ];

    await store.initialize(shops);
    await store.updateShop('forumShop', { initialized: true, lastSeenPostId: '100', lastPage: 7 });
    await store.initialize(shops);

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(Object.keys(data.shops), ['forumShop', 'dungeonShop']);
    assert.equal(data.shops.forumShop.lastSeenPostId, '100');
    assert.equal(data.shops.forumShop.lastPage, 7);
    assert.equal(data.shops.dungeonShop.initialized, false);
});

test('two hosts merge through the shared MySQL checkpoint without moving backward', async () => {
    const rows = new Map();
    const db = {
        hasRequiredConfig: true,
        async query(sql, params = []) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
            if (normalized.startsWith('create table')) return [{ affectedRows: 0 }, []];
            if (normalized.startsWith('select shop_key')) {
                const row = rows.get(String(params[0]));
                return [[...(row ? [row] : [])], []];
            }
            if (normalized.startsWith('insert into tba_forum_shop_checkpoints')) {
                const [key, topicUrl, initialized, lastSeenPostId, lastPage] = params;
                const current = rows.get(String(key));
                const reset = current && current.topic_url !== topicUrl;
                const currentPost = reset ? 0 : Number(current?.last_seen_post_id || 0);
                const incomingPost = Number(lastSeenPostId || 0);
                rows.set(String(key), {
                    shop_key: String(key),
                    topic_url: topicUrl,
                    initialized: reset ? initialized : Math.max(Number(current?.initialized || 0), Number(initialized)),
                    last_seen_post_id: incomingPost >= currentPost ? lastSeenPostId : current.last_seen_post_id,
                    last_page: reset ? lastPage : Math.max(Number(current?.last_page || 1), Number(lastPage || 1))
                });
                return [{ affectedRows: current ? 2 : 1 }, []];
            }
            throw new Error(`Unexpected SQL: ${normalized}`);
        }
    };
    const shop = { key: 'forumShop', topicUrl: 'https://example.com/forum-shop/' };
    const firstHost = new TbaForumShopStore({
        db,
        hasMysqlCredentials: true,
        dataFile: tempFile()
    });
    const secondHost = new TbaForumShopStore({
        db,
        hasMysqlCredentials: true,
        dataFile: tempFile()
    });

    await firstHost.initialize([shop]);
    await secondHost.initialize([shop]);
    await firstHost.updateShop(shop.key, { initialized: true, lastSeenPostId: '500', lastPage: 12 });

    const synchronized = await secondHost.getShop(shop.key);
    assert.equal(synchronized.initialized, true);
    assert.equal(synchronized.lastSeenPostId, '500');
    assert.equal(synchronized.lastPage, 12);

    await secondHost.updateShop(shop.key, { lastSeenPostId: '499', lastPage: 11 });
    assert.equal((await firstHost.getShop(shop.key)).lastSeenPostId, '500');
});

function checkpointDb() {
    return { hasRequiredConfig: true, offline: false, rows: new Map(), calls: [], async query(sql, params = []) {
        this.calls.push(sql);
        if (this.offline) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
        if (/CREATE TABLE/u.test(sql)) return [{ affectedRows: 0 }];
        if (/SELECT shop_key/u.test(sql)) return [[this.rows.get(params[0])].filter(Boolean)];
        if (/INSERT INTO tba_forum_shop_checkpoints/u.test(sql)) {
            const [key, topic_url, initialized, last_seen_post_id, last_page] = params;
            const previous = this.rows.get(key);
            this.rows.set(key, { shop_key: key, topic_url, initialized,
                last_seen_post_id: Number(previous?.last_seen_post_id || 0) > Number(last_seen_post_id || 0)
                    ? previous.last_seen_post_id : last_seen_post_id,
                last_page: Math.max(previous?.last_page || 1, last_page) });
            return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
}

test('shops continue from local progress during an outage/restart and synchronize before returning to one-read polls', async t => {
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const db = checkpointDb(), file = tempFile();
    const shop = { key: 'forumShop', topicUrl: 'https://example.com/topic/' };
    const store = new TbaForumShopStore({ db, dataFile: file });
    await store.initialize([shop]);
    await store.updateShop(shop.key, { initialized: true, lastSeenPostId: '100', lastPage: 2 });
    db.offline = true;
    await store.updateShop(shop.key, { lastSeenPostId: '101', lastPage: 3 });
    const restart = new TbaForumShopStore({ db, dataFile: file });
    await restart.initialize([shop]);
    assert.equal((await restart.getShop(shop.key)).lastSeenPostId, '101');
    await restart.updateShop(shop.key, { lastSeenPostId: '102', lastPage: 3 });
    assert.equal(db.rows.get(shop.key).last_seen_post_id, '100');
    db.offline = false;
    assert.equal((await restart.getShop(shop.key)).lastSeenPostId, '102');
    assert.equal(db.rows.get(shop.key).last_seen_post_id, '102');
    const queryCount = db.calls.length;
    await restart.getShop(shop.key);
    assert.equal(db.calls.length - queryCount, 1);
    assert.ok(db.calls.at(-1).includes('SELECT shop_key'));
});

test('corrupt shop checkpoint files are retained and cannot silently reset the forum baseline', async () => {
    for (const text of ['{"shops":', '{"shops":[]}', '{}']) {
        const file = tempFile();
        fs.writeFileSync(file, text);
        const db = checkpointDb();
        const store = new TbaForumShopStore({ db, dataFile: file });
        await assert.rejects(store.initialize([{ key: 'forumShop', topicUrl: 'https://example.com/topic/' }]),
            error => error.tbaForumShopStorage === true);
        assert.equal(fs.readFileSync(file, 'utf8'), text);
        assert.equal(db.calls.length, 0);
    }
});

test('a local mirror write failure stops the poll without returning a stale checkpoint or reporting a MySQL outage', async t => {
    const db = checkpointDb(), file = tempFile();
    const shop = { key: 'forumShop', topicUrl: 'https://example.com/topic/' };
    const store = new TbaForumShopStore({ db, dataFile: file });
    await store.initialize([shop]);
    await store.updateShop(shop.key, { initialized: true, lastSeenPostId: '100', lastPage: 2 });
    db.rows.get(shop.key).last_seen_post_id = '101';
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
    await assert.rejects(store.getShop(shop.key), error => error.code === 'ENOSPC' && error.tbaForumShopStorage);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).shops.forumShop.lastSeenPostId, '100');
    assert.equal(store.mysqlOutage, false);
});
