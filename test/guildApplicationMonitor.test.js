'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GuildApplicationMonitor } = require('../features/guild-applications/GuildApplicationMonitor.js');
const { GuildApplicationParser } = require('../features/guild-applications/parsing/GuildApplicationParser.js');
const { GuildApplicationStore } = require('../features/guild-applications/storage/GuildApplicationStore.js');
const { RuntimeActivity } = require('../utils/runtimeActivity.js');

test('application scans reject overlap and clear job tracking when scan initialization fails', async t => {
    t.mock.method(console, 'error', () => {});
    const activity = new RuntimeActivity();
    let resolve;
    const monitor = new GuildApplicationMonitor({ activity,
        store: { isInitialized: () => new Promise(done => { resolve = done; }) } });
    monitor.retryPendingNotifications = async () => {};
    monitor.scanForNewPosts = async () => {};
    const run = monitor.runOnce();
    assert.equal(activity.snapshot().active[0].name, 'Guild application monitoring');
    assert.equal(await monitor.runOnce(), false);
    resolve(true); assert.equal(await run, true);
    assert.equal(activity.snapshot().active.length, 0);
    monitor.staffFilter = { beginScan() { throw new Error('scan failed'); } };
    assert.equal(await monitor.runOnce(), false);
    assert.equal(monitor.running, false);
    assert.equal(activity.snapshot().active.length, 0);
});

test('stopping during application startup cannot rearm polling or start another scan', async () => {
    let initialized, syncStarted = 0;
    const monitor = new GuildApplicationMonitor({
        store: { initialize: () => new Promise(done => { initialized = done; }),
            startSyncLoop: () => { syncStarted++; }, stopSyncLoop() {} },
        ocr: { async close() {} }
    });
    const startup = monitor.start();
    await monitor.stop(); initialized(); await startup;
    assert.equal(syncStarted, 0);
    assert.equal(monitor.interval, null);
    assert.equal(await monitor.runOnce(), false);
});

function tempFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-monitor-'));
    return path.join(directory, 'guild_applications.json');
}

function forumPost(id, userId, postedAt) {
    return {
        postId: String(id),
        page: 1,
        postUrl: `https://example.com/page/1/#findComment-${id}`,
        forumUserId: String(userId),
        forumUsername: `User${userId}`,
        profileUrl: `https://example.com/profile/${userId}-user/`,
        profileSlug: `user${userId}`,
        postedAt,
        bodyText: `IGN: Player${userId}\nAge: 25\nCountry: Denmark\nWhat you love to do in PRO: PvP and dungeons`,
        imageUrls: []
    };
}

function makeMonitor(posts, notifierCalls, file, nonApplicationCalls = [], reapplicationCooldownHours = 0, forumClient = null) {
    const forum = forumClient || {
        async fetchPage() { return { page: 1, lastPage: 1, posts: [...posts] }; },
        async downloadPostImages() { return []; }
    };
    const store = new GuildApplicationStore({ storageMode: 'json', dataFile: file });
    return new GuildApplicationMonitor({
        forumClient: forum,
        parser: new GuildApplicationParser(),
        ocr: { resolveIgn: async () => ({ ign: null, confidence: 0, output: [] }), close: async () => {} },
        store,
        notifier: {
            async notify(record, options) {
                notifierCalls.push(record.postId);
                record.officerMessageId = `officer-${record.postId}`;
                record.officerMessageUrl = `https://discord.test/${record.postId}`;
                await options.onOfficerMessage(record);
                record.notificationStatus = 'notified';
                record.notifiedAt = new Date().toISOString();
                return record;
            }
        },
        nonApplicationNotifier: {
            async notify(record) {
                nonApplicationCalls.push(record.postId);
                record.notificationStatus = 'non_application_alert_sent';
                record.notifiedAt = new Date().toISOString();
                return { record };
            }
        },
        reapplicationCooldownHours,
        clock: () => new Date('2026-07-13T12:00:00.000Z')
    });
}

test('empty storage builds a complete baseline with zero notifications', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);

    await monitor.runOnce();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.equal(data.initialized, true);
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].isBaseline, true);
    assert.deepEqual(notifications, []);
});

test('new applications are stored before one officer notification is sent', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);
    await monitor.runOnce();

    posts.push(forumPost(2, 200, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.deepEqual(notifications, ['2']);
    assert.equal(data.records.find(item => item.postId === '2').notificationStatus, 'notified');
});

test('posts repeated across fetched pages produce one application notification', async t => {
    const file = tempFile();
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    const first = forumPost(1, 100, '2026-06-01T12:00:00.000Z');
    const next = forumPost(2, 200, '2026-07-13T11:00:00.000Z');
    const notifications = [];
    let lastPage = 1;
    const forum = {
        async fetchPage(page) {
            return { lastPage, posts: page === 1 ? (lastPage === 1 ? [first] : [first, next]) : [next] };
        },
        async downloadPostImages() { return []; }
    };
    const monitor = makeMonitor([], notifications, file, [], 24, forum);
    await monitor.runOnce();
    lastPage = 2;
    await monitor.runOnce();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(notifications, ['2']);
    const record = data.records.find(item => item.postId === '2');
    assert.equal(record.classification, 'application');
    assert.equal(record.notificationStatus, 'notified');
    assert.equal(record.officerMessageId, 'officer-2');
});

test('repeat applications from the same forum user are announced without a waiting period', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, ['2']);
    assert.equal(repeatApplication.classification, 'application');
    assert.equal(repeatApplication.notificationStatus, 'notified');
});

test('a positive application cooldown suppresses repeat applications inside the configured window', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T12:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file, [], 24);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, []);
    assert.equal(repeatApplication.classification, 'duplicate_user');
    assert.equal(repeatApplication.notificationStatus, 'not_required');
});

test('a repeat application is announced at the configured cooldown boundary', async () => {
    const posts = [forumPost(1, 9001, '2026-07-12T11:00:00.000Z')];
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, notifications, file, [], 24);
    await monitor.runOnce();

    posts.push(forumPost(2, 9001, '2026-07-13T11:00:00.000Z'));
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const repeatApplication = data.records.find(item => item.postId === '2');
    assert.deepEqual(notifications, ['2']);
    assert.equal(repeatApplication.classification, 'application');
    assert.equal(repeatApplication.notificationStatus, 'notified');
});

test('new non-applications are saved before the owner-only alert is sent', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const applicationNotifications = [];
    const nonApplicationNotifications = [];
    const file = tempFile();
    const monitor = makeMonitor(posts, applicationNotifications, file, nonApplicationNotifications);
    await monitor.runOnce();

    posts.push({
        ...forumPost(2, 200, '2026-07-13T11:00:00.000Z'),
        bodyText: 'Is there still room in the guild?'
    });
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(applicationNotifications, []);
    assert.deepEqual(nonApplicationNotifications, ['2']);
    assert.equal(data.records.find(item => item.postId === '2').notificationStatus, 'non_application_alert_sent');
});

test('scanner relocates its saved post after a forum page-size change', async () => {
    let layout = 'old';
    const oldPages = new Map();
    for (let page = 1; page <= 10; page++) {
        oldPages.set(page, [{ ...forumPost(page * 10, page, `2026-06-${String(page).padStart(2, '0')}T12:00:00.000Z`), page }]);
    }
    const newPages = new Map([
        [1, [{ ...forumPost(20, 2, '2026-06-02T12:00:00.000Z'), page: 1 }]],
        [2, [{ ...forumPost(60, 6, '2026-06-06T12:00:00.000Z'), page: 2 }]],
        [3, [{ ...forumPost(100, 10, '2026-06-10T12:00:00.000Z'), page: 3 }]],
        [4, [{ ...forumPost(101, 11, '2026-07-11T12:00:00.000Z'), page: 4 }]],
        [5, [{ ...forumPost(102, 12, '2026-07-12T12:00:00.000Z'), page: 5 }]],
        [6, [{ ...forumPost(103, 13, '2026-07-13T12:00:00.000Z'), page: 6 }]]
    ]);
    const forum = {
        async fetchPage(pageNumber) {
            const pages = layout === 'old' ? oldPages : newPages;
            return {
                page: pageNumber,
                lastPage: layout === 'old' ? 10 : 6,
                posts: [...(pages.get(pageNumber) || [])]
            };
        },
        async downloadPostImages() { return []; }
    };
    const notifications = [];
    const file = tempFile();
    const monitor = makeMonitor([], notifications, file, [], 0, forum);

    await monitor.runOnce();
    layout = 'new';
    await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(notifications, ['101', '102', '103']);
    assert.equal(data.checkpoint.lastPostId, '103');
    assert.equal(data.checkpoint.lastPage, 6);
});

test('scanner keeps its checkpoint when a forum page cannot be read', async () => {
    let broken = false;
    const original = forumPost(1, 100, '2026-06-01T12:00:00.000Z');
    const forum = {
        async fetchPage(pageNumber) {
            if (broken && pageNumber === 2) return { page: 2, lastPage: 2, posts: [] };
            return { page: pageNumber, lastPage: broken ? 2 : 1, posts: [original] };
        },
        async downloadPostImages() { return []; }
    };
    const file = tempFile();
    const monitor = makeMonitor([], [], file, [], 0, forum);

    await monitor.runOnce();
    broken = true;
    const completed = await monitor.runOnce();

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(completed, false);
    assert.equal(data.checkpoint.lastPostId, '1');
    assert.equal(data.checkpoint.lastPage, 1);
});

function staffFilter(ign) {
    return { beginScan() {}, async matchAuthor(name) { return name.toLowerCase() === ign.toLowerCase() ? { id: 'officer' } : null; } };
}

test('new staff applications and non-applications are recorded silently while unmatched applicants notify', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [], nonApplications = [];
    const monitor = makeMonitor(posts, notifications, tempFile(), nonApplications);
    monitor.staffFilter = staffFilter('Vangogsan');
    await monitor.runOnce();
    posts.push({ ...forumPost(2, 163701, '2026-07-13T11:00:00.000Z'), forumUsername: 'Vangogsan' });
    posts.push({ ...forumPost(3, 163701, '2026-07-13T11:01:00.000Z'), forumUsername: 'Vangogsan', bodyText: 'Welcome, have fun!', imageUrls: [] });
    posts.push({ ...forumPost(4, 200, '2026-07-13T11:02:00.000Z'), forumUsername: 'Unmatched' });
    assert.equal(await monitor.runOnce(), true);
    assert.deepEqual(notifications, ['4']);
    assert.deepEqual(nonApplications, []);
    for (const id of ['2', '3']) {
        const record = await monitor.store.getRecord(id);
        assert.equal(record.classification, 'ignored_author');
        assert.equal(record.notificationStatus, 'not_required');
        assert.ok(record.parserReasons.includes('discord_staff_author:officer'));
    }
    assert.equal(monitor.store.getCheckpoint().lastPostId, '4');
});

test('pending application and owner alerts are rechecked against current staff before retrying', async () => {
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [], nonApplications = [];
    const monitor = makeMonitor(posts, notifications, tempFile(), nonApplications);
    await monitor.runOnce();
    monitor.staffFilter = staffFilter('NewOfficer');
    for (const [id, body] of [[2, forumPost(2, 200, '2026-07-13T11:00:00.000Z').bodyText], [3, 'Hello!']]) {
        const record = await monitor.createRecord({ ...forumPost(id, 200, '2026-07-13T11:00:00.000Z'), forumUsername: 'NewOfficer', bodyText: body },
            { baseline: false, latestApplications: {} });
        record.classification = id === 2 ? 'application' : 'non_application';
        record.notificationStatus = id === 2 ? 'error' : 'non_application_alert_error';
        await monitor.store.saveRecord(record);
    }
    assert.equal(await monitor.runOnce(), true);
    assert.deepEqual(notifications, []);
    assert.deepEqual(nonApplications, []);
    assert.equal((await monitor.store.getRecord('2')).notificationStatus, 'not_required');
    assert.equal((await monitor.store.getRecord('3')).notificationStatus, 'not_required');
});

test('staff lookup failure leaves the new post unprocessed so it can be checked after Discord recovers', async t => {
    t.mock.method(console, 'error', () => {});
    const posts = [forumPost(1, 100, '2026-06-01T12:00:00.000Z')];
    const notifications = [];
    const monitor = makeMonitor(posts, notifications, tempFile());
    await monitor.runOnce();
    posts.push(forumPost(2, 200, '2026-07-13T11:00:00.000Z'));
    monitor.staffFilter = { beginScan() {}, async matchAuthor() { throw new Error('Discord unavailable'); } };
    assert.equal(await monitor.runOnce(), false);
    assert.equal(monitor.store.getCheckpoint().lastPostId, '1');
    assert.deepEqual(notifications, []);
    monitor.staffFilter = staffFilter('OtherOfficer');
    assert.equal(await monitor.runOnce(), true);
    assert.deepEqual(notifications, ['2']);
});
