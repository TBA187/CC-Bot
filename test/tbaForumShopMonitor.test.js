'use strict';

const { RuntimeActivity } = require('../utils/runtimeActivity.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TbaForumShopMonitor } = require('../features/tba-forum-shops/TbaForumShopMonitor.js');
const { TbaForumRequestError } = require('../features/tba-forum-shops/TbaForumShopClient.js');
const { TbaForumShopStore } = require('../features/tba-forum-shops/TbaForumShopStore.js');

test('shop activity distinguishes shops and clears failed runs without allowing overlap', async t => {
    t.mock.method(console, 'error', () => {});
    const activity = new RuntimeActivity();
    const monitor = new TbaForumShopMonitor({ activity });
    const shop = { key: 'forum', name: 'PRO Forum Shop' };
    let reject;
    monitor.scanShop = () => new Promise((_, fail) => { reject = fail; });
    const run = monitor.runShopOnce(shop);
    assert.equal(activity.snapshot().active[0].name, 'PRO Forum Shop monitoring');
    assert.equal(await monitor.runShopOnce(shop), false);
    reject(new Error('request failed')); assert.equal(await run, false);
    assert.equal(activity.snapshot().active.length, 0);
    assert.equal(monitor.stateFor(shop).running, false);
});

test('stopping during shop initialization cannot schedule new polls', async () => {
    let initialized;
    const monitor = new TbaForumShopMonitor({ enabled: 1, shops: [{ key: 'forum' }, { key: 'dungeon' }],
        store: { initialize: () => new Promise(done => { initialized = done; }) } });
    const startup = monitor.start();
    monitor.stop(); initialized(); await startup;
    assert.equal(monitor.timers.size, 0);
    assert.equal(await monitor.runShopOnce(monitor.shops[0]), false);
});

function tempFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tba-monitor-')), 'tba_forum_shops.json');
}

function post(postId, forumUsername) {
    return {
        postId: String(postId),
        page: 1,
        postUrl: `https://example.com/#findComment-${postId}`,
        forumUsername,
        postedAt: '2026-07-14T12:00:00.000Z',
        bodyText: `Message ${postId}`
    };
}

test('first scan is silent, new customer posts send DMs, and Tba7 posts are skipped', async () => {
    const posts = [post(100, 'Tba7')];
    const notifications = [];
    const shop = {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/',
        forumClient: {
            async fetchPage() { return { page: 1, lastPage: 1, posts: [...posts] }; },
            async downloadPostImages() { return []; }
        }
    };
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([shop]);
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store,
        notifier: { async notify(selectedShop, selectedPost) { notifications.push([selectedShop.key, selectedPost.postId]); } },
        enabled: 1
    });

    await monitor.runOnce();
    assert.deepEqual(notifications, []);

    posts.push(post(101, 'Customer'));
    await monitor.runOnce();
    assert.deepEqual(notifications, [['forumShop', '101']]);

    posts.push(post(102, 'TBA7'));
    await monitor.runOnce();
    assert.deepEqual(notifications, [['forumShop', '101']]);
    assert.equal((await store.getShop('forumShop')).lastSeenPostId, '102');
});

test('disabled shop notifications create the JSON file without fetching the forum', async () => {
    const dataFile = tempFile();
    let fetches = 0;
    const shop = {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/',
        forumClient: {
            async fetchPage() { fetches++; return { page: 1, lastPage: 1, posts: [] }; },
            async downloadPostImages() { return []; }
        }
    };
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store: new TbaForumShopStore({ dataFile }),
        notifier: { async notify() {} },
        enabled: 0
    });

    await monitor.start();
    monitor.stop();
    assert.equal(fetches, 0);
    assert.equal(fs.existsSync(dataFile), true);
});

test('monitor catches up on every page added while the bot was offline', async () => {
    let lastPage = 1;
    const pages = new Map([[1, [post(100, 'Tba7')]]]);
    const notifications = [];
    const shop = {
        key: 'dungeonShop',
        name: 'PRO Dungeon Shop',
        emoji: '🏰',
        topicUrl: 'https://example.com/dungeon-shop/',
        forumClient: {
            async fetchPage(pageNumber) {
                return { page: pageNumber, lastPage, posts: [...(pages.get(pageNumber) || [])] };
            },
            async downloadPostImages() { return []; }
        }
    };
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([shop]);
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store,
        notifier: { async notify(_, selectedPost) { notifications.push(selectedPost.postId); } },
        enabled: 1
    });

    await monitor.runOnce();
    lastPage = 3;
    pages.set(2, [post(101, 'BuyerOne')]);
    pages.set(3, [post(102, 'BuyerTwo')]);
    await monitor.runOnce();

    assert.deepEqual(notifications, ['101', '102']);
    assert.equal((await store.getShop('dungeonShop')).lastSeenPostId, '102');
    assert.equal((await store.getShop('dungeonShop')).lastPage, 3);
});

test('monitor finds the saved post again when the forum page size changes', async () => {
    let layout = 'old';
    const notifications = [];
    const shop = {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/',
        forumClient: {
            async fetchPage(pageNumber) {
                if (layout === 'old') {
                    return {
                        page: pageNumber,
                        lastPage: 3,
                        posts: pageNumber === 1 ? [post(100, 'Tba7')] : pageNumber === 3 ? [post(300, 'Tba7')] : [post(200, 'Buyer')]
                    };
                }
                return {
                    page: pageNumber,
                    lastPage: 2,
                    posts: pageNumber === 1
                        ? [post(100, 'Tba7'), post(200, 'Buyer'), post(300, 'Tba7')]
                        : [post(301, 'BuyerOne'), post(302, 'BuyerTwo')]
                };
            },
            async downloadPostImages() { return []; }
        }
    };
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([shop]);
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store,
        notifier: { async notify(_, selectedPost) { notifications.push(selectedPost.postId); } },
        enabled: 1
    });

    await monitor.runOnce();
    layout = 'new';
    await monitor.runOnce();

    assert.deepEqual(notifications, ['301', '302']);
    assert.equal((await store.getShop('forumShop')).lastSeenPostId, '302');
    assert.equal((await store.getShop('forumShop')).lastPage, 2);
});

test('an unreadable page leaves the saved checkpoint unchanged', async () => {
    let broken = false;
    const posts = [post(100, 'Tba7')];
    const shop = {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/',
        forumClient: {
            async fetchPage(pageNumber) {
                if (broken && pageNumber === 2) return { page: 2, lastPage: 2, posts: [] };
                return { page: pageNumber, lastPage: broken ? 2 : 1, posts: [...posts] };
            },
            async downloadPostImages() { return []; }
        }
    };
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([shop]);
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store,
        notifier: { async notify() {} },
        enabled: 1
    });

    await monitor.runOnce();
    broken = true;
    posts.push(post(101, 'Buyer'));
    await monitor.runOnce();

    assert.equal((await store.getShop('forumShop')).lastSeenPostId, '100');
    assert.equal((await store.getShop('forumShop')).lastPage, 1);
});

test('failed DMs leave the post pending for the next scan', async () => {
    const posts = [post(100, 'Tba7')];
    let attempts = 0;
    const shop = {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: 'https://example.com/forum-shop/',
        forumClient: {
            async fetchPage() { return { page: 1, lastPage: 1, posts: [...posts] }; },
            async downloadPostImages() { return []; }
        }
    };
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([shop]);
    const monitor = new TbaForumShopMonitor({
        shops: [shop],
        store,
        notifier: {
            async notify() {
                attempts++;
                if (attempts === 1) throw new Error('Discord unavailable');
            }
        },
        enabled: 1
    });

    await monitor.runOnce();
    posts.push(post(101, 'Buyer'));
    await monitor.runOnce();
    assert.equal((await store.getShop('forumShop')).lastSeenPostId, '100');

    await monitor.runOnce();
    assert.equal(attempts, 2);
    assert.equal((await store.getShop('forumShop')).lastSeenPostId, '101');
});

test('each shop backs off independently after a forum failure', async () => {
    let now = 1_000;
    let forumShopFetches = 0;
    let dungeonShopFetches = 0;
    const makeShop = (key, fetchPage) => ({
        key,
        name: key === 'forumShop' ? 'PRO Forum Shop' : 'PRO Dungeon Shop',
        topicUrl: `https://example.com/${key}/`,
        forumClient: { fetchPage, async downloadPostImages() { return []; } }
    });
    const forumShop = makeShop('forumShop', async () => {
        forumShopFetches++;
        throw new TbaForumRequestError('rate limited', { retryAfterMs: 20 * 60 * 1000 });
    });
    const dungeonShop = makeShop('dungeonShop', async () => {
        dungeonShopFetches++;
        return { page: 1, lastPage: 1, posts: [post(100, 'Tba7')] };
    });
    const store = new TbaForumShopStore({ dataFile: tempFile() });
    await store.initialize([forumShop, dungeonShop]);
    const monitor = new TbaForumShopMonitor({
        shops: [forumShop, dungeonShop],
        store,
        notifier: { async notify() {} },
        enabled: 1,
        intervalMs: 12 * 60 * 1000,
        clock: () => now
    });

    await monitor.runOnce();
    assert.equal(forumShopFetches, 1);
    assert.equal(dungeonShopFetches, 1);
    assert.equal(monitor.stateFor(forumShop).nextAttemptAt, now + (20 * 60 * 1000));

    await monitor.runOnce();
    assert.equal(forumShopFetches, 1);
    assert.equal(dungeonShopFetches, 2);

    now += 20 * 60 * 1000;
    await monitor.runOnce();
    assert.equal(forumShopFetches, 2);
    assert.equal(dungeonShopFetches, 3);
});
