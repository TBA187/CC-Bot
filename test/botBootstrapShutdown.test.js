// Check that cancelling startup prevents the bot from logging in or starting tasks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const discord = require('discord.js');
const abortHelpers = require('../utils/abortable.js');

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

for (const cleanupFailure of [false, true]) test(`actual index startup stops after Ctrl+C${cleanupFailure ? ' even if a cleanup throws' : ''}`, async () => {
    const databaseReady = deferred();
    const calls = [];
    const processHandlers = new Map();
    const exit = deferred();
    const fakeProcess = {
        env: { TOKEN: 'fake-token', CLIENT_ID: 'fake-client' },
        on() {}, once: (event, handler) => processHandlers.set(event, handler),
        exit: code => { calls.push('exit ' + code); exit.resolve(); }
    };
    let client;
    let xpStopped = false, historyStopped = false;
    class FakeClient extends EventEmitter {
        constructor() { super(); client = this; }
        destroy() { calls.push('disconnect'); }
        login() { calls.push('login'); return Promise.resolve(); }
    }
    class FakeStore {
        restore() { calls.push('restore'); return Promise.resolve(); }
        stopSyncLoop() { if (cleanupFailure) throw new Error('Feature cleanup failed'); }
        startSyncLoop() { calls.push('start sync'); }
        autocomplete() { return Promise.resolve([]); }
    }
    class FakeXpStore extends FakeStore { stopSyncLoop() { xpStopped = true; } }
    class FakeMemberHistory extends FakeStore { stopSyncLoop() { historyStopped = true; } }
    const monitor = { start() { calls.push('monitor start'); return Promise.resolve(); }, stop() {} };
    class FakeIngestor { start() { calls.push('ingestor start'); return Promise.resolve(); } stop() {} }
    const db = { initPromise: databaseReady.promise,
        end: async () => calls.push('feature pool closed') };
    const imports = {
        'dotenv': { config() {} },
        './config.json': { guildId: 'test-guild', botTimezone: 'Europe/Copenhagen' },
        './utils/runtimeLogging.js': { installRuntimeLogging() {
            assert.equal(fakeProcess.env.TZ, 'Europe/Copenhagen');
            calls.push('logging started');
            return { stop: () => calls.push('logging stopped') };
        } },
        './utils/commandSummary.js': require('../utils/commandSummary.js'),
        './db/db-conn.js': db,
        './utils/abortable.js': abortHelpers,
        './utils/discordDiagnostics.js': require('../utils/discordDiagnostics.js'),
        './utils/commandRegistration.js': require('../utils/commandRegistration.js'),
        './utils/interactionDiagnostics.js': require('../utils/interactionDiagnostics.js'),
        './utils/discordTransport.js': { createDiscordTransport: () => ({ makeRequest() {}, startWarmup() {}, async stop() {} }) },
        './utils/runtimeHealth.js': { RuntimeHealth: class { start() {} stop() {} } },
        './utils/runtimeMemoryOcr.js': { sharedOcrWorkerPool: { healthSnapshot: () => ({ workers: 0, pending: 0, creating: false }) } },
        './utils/memberAuditHistory.js': { MemberAuditHistory: FakeMemberHistory },
        './commands/pvp-king/utils/pvpKingStorage.js': FakeStore,
        './events/giveaways.js': { createGiveawayStore: () => new FakeStore() },
        './features/pro-notifications/NotificationStore.js': FakeStore,
        './features/pro-notifications/notificationCatalog.js': { NOTIFICATION_DEFINITIONS: [] },
        './features/guild-applications/index.js': { createGuildApplicationMonitor: () => monitor },
        './features/tba-forum-shops/index.js': { createTbaForumShopMonitor: () => monitor },
        './features/auctions/index.js': { createAuctionMonitor: () => monitor },
        './features/auctions/AuctionDiscord.js': { handleAuctionButton: async () => false },
        './features/pvp-scouting/ScoutServerRegistry.js': { ScoutServerRegistry: class {
            get() { return { store: new FakeStore(), ingestor: new FakeIngestor() }; }
            async warmAutocomplete() {}
            async start() { calls.push('ingestor start'); }
            async stop() {}
        } },
        './features/pvp-scouting/ScoutServerSettings.js': { ScoutServerSettings: class { async hydratePreferences() {} } },
        './features/pvp-scouting/ScoutRosterStore.js': { ScoutRosterStore: FakeStore },
        './features/pvp-scouting/ScoutAuditLogger.js': { ScoutAuditLogger: class { async flush() {} } },
        './utils/jsonFile.js': { writeJsonIfChanged() {} },
        './utils/xpStore.js': { XpStore: FakeXpStore },
        './utils/xpEngine.js': { configureXpRecovery() {} },
        './utils/xpDbHelper.js': { fetchSpecialTracks: async () => { calls.push('XP track load'); return []; } },
        './tasks/proNotifications.js': { stop() {} },
        'discord.js': { ...discord, Client: FakeClient },
        'fs': {}, 'path': path
    };
    const root = path.resolve(__dirname, '..');
    const loaded = new Map();
    function loadLocal(file) {
        if (loaded.has(file)) return loaded.get(file).exports;
        const module = { exports: {} };
        loaded.set(file, module);
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
            module, exports: module.exports, __dirname: path.dirname(file),
            require: name => {
                const normalized = name.startsWith('.')
                    ? './' + path.relative(root, path.resolve(path.dirname(file), name)).replaceAll('\\', '/') : name;
                if (normalized === './db/db-conn.js') calls.push('database imported');
                if (normalized in imports) return imports[normalized];
                if (normalized === 'node:path') return path;
                if (normalized === 'node:fs') return {};
                if (normalized === './features/guild-settings/GuildSettingsStore.js') return {
                    GuildSettingsStore: class { constructor() { this.cache = new Map(); } stop() {} }
                };
                if (normalized.startsWith('./app/')) return loadLocal(path.resolve(root, normalized));
                throw new Error('Unexpected startup import: ' + normalized);
            },
            process: fakeProcess, console: { log() {}, warn() {}, error() {} },
            setTimeout, clearTimeout, setInterval, clearInterval, Map, Set
        }, { filename: file });
        return module.exports;
    }
    loadLocal(path.join(root, 'index.js'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['logging started', 'database imported']);
    await processHandlers.get('SIGINT')();
    await exit.promise;
    databaseReady.resolve(true);
    client.emit(discord.Events.ClientReady);
    await new Promise(resolve => setImmediate(resolve));
    await processHandlers.get('SIGINT')();
    assert.deepEqual(calls, [
        'logging started', 'database imported', 'disconnect', 'feature pool closed',
        'logging stopped', 'exit 0'
    ]);
    assert.equal(xpStopped, true);
    assert.equal(historyStopped, true);
});
