// Own startup, Discord readiness and shutdown for one bot instance.
'use strict';

const { REST, Routes, Events, ActivityType } = require('discord.js');
const { abortable } = require('../utils/abortable.js');
const { buildCommandSummary } = require('../utils/commandSummary.js');
const { CommandRegistration } = require('../utils/commandRegistration.js');
const { fetchSpecialTracks } = require('../utils/xpDbHelper.js');
const { startGiveawayLoop } = require('../events/giveaways.js');
const { loadCommands, loadEvents, registerEvents } = require('./moduleLoader.js');
const { createInteractionHandler } = require('./interactionRouter.js');

class BotApplication {
    constructor(context) {
        Object.assign(this, context);
        this.console = context.consoleObject || console;
        this.processObject = context.processObject || process;
        this.startPromise = null;
        this.shutdownPromise = null;
        this.shutdownStarted = false;
        this.processHandlers = new Map();
    }

    start() {
        if (this.startPromise) return this.startPromise;
        if (this.lifecycle.stopping) return Promise.resolve();
        const { client, lifecycle, botDiagnostics, processObject } = this;
        const onProcess = (name, handler, once = false) => {
            this.processHandlers.set(name, handler);
            processObject[once ? 'once' : 'on'](name, handler);
        };
        client.on('error', error => this.console.error('Discord client error:', error));
        onProcess('unhandledRejection', error => this.console.error('Unhandled rejection:', error));
        // Node prints the warning itself; only the structured staff diagnostic is added here.
        onProcess('warning', warning => botDiagnostics.capture('warn', ['Node runtime warning:', warning]));
        onProcess('SIGINT', () => this.shutdown('SIGINT'), true);
        onProcess('SIGTERM', () => this.shutdown('SIGTERM'), true);
        client.once(Events.ClientReady, () => {
            if (!lifecycle.stopping) this.onReady().catch(error => this.console.error('[CC LOG] Ready tasks failed:', error));
        });
        client.on('guildCreate', guild => {
            if (!lifecycle.stopping) this.guildSettings.addGuild(guild)
                .catch(error => this.console.error('[CC LOG] Error setting up new guild:', error));
        });
        client.on('interactionCreate', createInteractionHandler({ ...this, consoleObject: this.console }));
        this.startPromise = this.bootstrap();
        return this.startPromise;
    }

    async startupStep(label, work) {
        this.lifecycle.check();
        const startedAt = Date.now();
        const waitingLog = setInterval(() => {
            this.console.warn(`[CC LOG] Startup is still waiting for ${label} (${Math.floor((Date.now() - startedAt) / 1000)}s).`);
        }, 15000);
        waitingLog.unref?.();
        try {
            const result = await this.lifecycle.run(work);
            this.console.log(`[CC LOG] Startup: ${label} loaded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
            return result;
        } finally { clearInterval(waitingLog); }
    }

    async bootstrap() {
        const { db, lifecycle, xpStore, pvpKingStores, giveawayStore, notificationStore, memberHistory,
            scoutServers, scoutServerSettings, appConfig } = this;
        try {
            this.console.log('[CC LOG] Establishing database connection...');
            const dbReady = await lifecycle.run(() => db.initPromise);
            if (!dbReady) this.console.warn('[CC LOG] Database unavailable at startup. DB-backed features will retry when used.');
            await this.startupStep('guild settings', () => this.guildSettings.sync());
            await this.startupStep('XP recovery data', () => xpStore.restore());
            await lifecycle.preload(() => fetchSpecialTracks(db), {
                timeoutCode: 'XP_TRACK_PRELOAD_TIMEOUT',
                onTimeout: error => this.console.log(`[CC LOG] XP tracks will refresh in the background (${error.code}).`),
                onError: error => this.console.warn('[CC LOG] Could not preload XP tracks:', error)
            });
            await this.startupStep('PvP King data', () => Promise.all(Object.values(pvpKingStores).map(store => store.restore())));
            await this.startupStep('giveaway data', () => giveawayStore.restore());
            await this.startupStep('notification data', () => notificationStore.restore());
            await this.startupStep('member audit history', () => memberHistory.restore());
            memberHistory.startSyncLoop();
            // Saved suggestions remain usable while a cold database load finishes in the background.
            await lifecycle.preload(() => scoutServers.warmAutocomplete(), {
                timeoutCode: 'AUTOCOMPLETE_PRELOAD_TIMEOUT',
                onTimeout: error => this.console.log(`[CC LOG] Scout autocomplete will refresh in the background (${error.code}).`),
                onError: error => this.console.warn('[CC LOG] Could not preload scout autocomplete; background refresh will retry:', error)
            });
            await lifecycle.preload(() => scoutServerSettings.hydratePreferences(appConfig.guildId), {
                timeoutCode: 'SERVER_PREFERENCE_PRELOAD_TIMEOUT',
                onTimeout: error => this.console.log(`[CC LOG] Player server preferences will refresh when used (${error.code}).`),
                onError: error => this.console.warn('[CC LOG] Could not preload player server preferences; lookups will retry:', error)
            });
            const definitions = loadCommands(this);
            const { modules, prefixCommands } = loadEvents(this);
            await this.registerCommands(definitions);
            lifecycle.check();
            this.runtimeLogging.logBlock(buildCommandSummary(definitions, prefixCommands).lines);
            registerEvents({ ...this, modules, consoleObject: this.console });
            await lifecycle.run(() => this.client.login(this.token));
        } catch (error) {
            if (this.shutdownStarted) return;
            this.console.error('[CC LOG] 🚨 Startup Failed:', error);
            await this.shutdown('Startup failed', 1);
        }
    }

    async registerCommands(definitions) {
        const rest = new REST({ version: '10' }).setToken(this.token);
        this.commandRegistration = new CommandRegistration({ signal: this.lifecycle.signal, consoleObject: this.console,
            register: () => this.lifecycle.run(() => rest.put(
                Routes.applicationGuildCommands(this.clientId, this.appConfig.guildId), { body: definitions }
            )) });
        await this.commandRegistration.start();
    }

    async onReady() {
        if (this.lifecycle.stopping) return;
        const { client, commandConfig, appConfig, notificationStore } = this;
        this.botDiagnostics.start();
        this.console.log(`[CC LOG] Logged in as ${client.user.tag}`);
        this.runtimeHealth.start();
        void this.discordTransport.startWarmup();
        const env = this.processObject.env;
        client.user.setPresence({ status: env.BOT_STATUS || 'online', activities: [{
            name: env.ACTIVITY_NAME || 'Crow Control', type: ActivityType[env.ACTIVITY_TYPE || 'Watching'] || ActivityType.Playing
        }] });
        for (const store of Object.values(this.pvpKingStores)) store.startSyncLoop();
        notificationStore.startSyncLoop();
        this.xpStore.startSyncLoop()?.catch(error => this.console.error('[XP QUEUE] Could not start recovery:', error));
        this.guildSettings.startSyncLoop();
        startGiveawayLoop(client, commandConfig);
        this.guildApplicationMonitor.start().catch(error => this.console.error('[CC LOG] Guild Application monitor failed to start:', error));
        this.tbaForumShopMonitor.start().catch(error => this.console.error('[CC LOG] TBA PRO Forum shop monitor failed to start:', error));
        this.auctionMonitor.start().catch(error => this.console.error('[CC LOG] Auction monitor failed to start:', error));
        this.scoutServers.start().catch(error => this.console.error('[CC LOG] PvP scouting ingestion failed to start:', error));
        require('../events/userUpdatesLogger.js').primeUserProfileCache(commandConfig);
        require('../tasks/cooldownNotifier.js').execute(client, commandConfig);
        require('../tasks/proNotifications.js').execute(client, appConfig, notificationStore);
    }

    shutdown(signal, exitCode = 0) {
        if (!this.shutdownPromise) {
            this.shutdownStarted = true;
            this.shutdownPromise = this.stopAndExit(signal, exitCode);
        }
        return this.shutdownPromise;
    }

    async stopAndExit(signal, exitCode) {
        this.lifecycle.stop();
        this.console.log(`[CC LOG] ${signal} received. Shutting down cleanly...`);
        // Run every cleanup even if an earlier feature throws while stopping.
        const pending = [];
        const stop = work => {
            try { pending.push(Promise.resolve(work()).catch(error => this.console.error('[CC LOG] Cleanup failed:', error))); }
            catch (error) { this.console.error('[CC LOG] Cleanup failed:', error); }
        };
        stop(() => this.commandRegistration?.stop());
        stop(() => this.runtimeHealth.stop());
        stop(() => this.client.cooldownNotifier?.stop?.());
        for (const store of Object.values(this.pvpKingStores)) stop(() => store.stopSyncLoop());
        stop(() => this.notificationStore.stopSyncLoop());
        stop(() => this.xpStore.stopSyncLoop());
        stop(() => this.memberHistory.stopSyncLoop());
        stop(() => this.guildSettings.stop());
        for (const command of new Set(this.commandMap.values())) stop(() => command.stop?.());
        for (const timers of Object.values(this.commandConfig.pvpChallengeTimeouts || {})) {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        }
        stop(() => this.client.giveawayLoop?.stop?.());
        stop(() => require('../tasks/proNotifications.js').stop?.());
        stop(() => this.guildApplicationMonitor.stop?.());
        stop(() => this.tbaForumShopMonitor.stop?.());
        stop(() => this.auctionMonitor.stop?.());
        stop(() => this.scoutServers.stop());
        stop(() => this.discordTransport.stop());
        stop(() => this.botDiagnostics.stop());
        stop(() => this.interactionDiagnostics.stop());
        stop(() => this.client.destroy());
        await abortable(Promise.resolve().then(() => this.scoutAuditLogger.flush()), {
            timeoutMs: 2000, timeoutCode: 'SCOUT_LOG_SHUTDOWN_TIMEOUT'
        }).catch(() => {});
        await abortable(Promise.allSettled(pending), {
            timeoutMs: 3000, timeoutCode: 'SHUTDOWN_CLEANUP_TIMEOUT'
        }).catch(() => {});
        await abortable(Promise.resolve().then(() => this.db.end()), {
            timeoutMs: 2000, timeoutCode: 'SHUTDOWN_POOL_TIMEOUT'
        }).catch(() => {});
        for (const [name, handler] of this.processHandlers) this.processObject.removeListener?.(name, handler);
        this.runtimeLogging.stop();
        this.processObject.exit(exitCode);
    }
}

module.exports = { BotApplication };
