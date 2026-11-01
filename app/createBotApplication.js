// Construct the shared services and command dependencies used by one bot instance.
'use strict';

const path = require('node:path');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { StartupLifecycle } = require('../utils/abortable.js');
const { GuildSettingsStore } = require('../features/guild-settings/GuildSettingsStore.js');
const { CommandCooldowns } = require('./CommandCooldowns.js');
const { BotApplication } = require('./BotApplication.js');
const PvpKingStorage = require('../commands/pvp-king/utils/pvpKingStorage.js');
const { createGiveawayStore } = require('../events/giveaways.js');
const NotificationStore = require('../features/pro-notifications/NotificationStore.js');
const { NOTIFICATION_DEFINITIONS } = require('../features/pro-notifications/notificationCatalog.js');
const { createGuildApplicationMonitor } = require('../features/guild-applications/index.js');
const { createTbaForumShopMonitor } = require('../features/tba-forum-shops/index.js');
const { ScoutServerRegistry } = require('../features/pvp-scouting/ScoutServerRegistry.js');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');
const { ScoutServerSettings } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { ScoutAuditLogger } = require('../features/pvp-scouting/ScoutAuditLogger.js');
const { DiscordDiagnosticLogger } = require('../utils/discordDiagnostics.js');
const { InteractionDiagnostics } = require('../utils/interactionDiagnostics.js');
const { createDiscordTransport } = require('../utils/discordTransport.js');
const { RuntimeHealth } = require('../utils/runtimeHealth.js');
const { MemberAuditHistory } = require('../utils/memberAuditHistory.js');
const { sharedOcrWorkerPool } = require('../utils/runtimeMemoryOcr.js');
const { XpStore } = require('../utils/xpStore.js');
const { configureXpRecovery } = require('../utils/xpEngine.js');

function createBotApplication({ appConfig, runtimeLogging, processObject = process,
    rootPath = path.resolve(__dirname, '..') }) {
    const db = require('../db/db-conn.js');
    const lifecycle = new StartupLifecycle();
    const token = processObject.env.TOKEN;
    const clientId = processObject.env.CLIENT_ID;
    if (!token || !clientId) {
        console.error('TOKEN or CLIENT_ID is undefined. Bot cannot start!');
        processObject.exit(1);
        return null;
    }
    const {
        botTimezone, guildId, welcomeChannelID, ownerID, leaderRoleID, adminRoleID, officerRoleID, guildMemberRoleID, pvpKingRoleID, pvpKingSilverRoleID, pvpWarriorRoleID, ccRoleID, botChannelID, logChannelID, ignoredLogChannels, ignoreLogPrivateChannelCreate, blockedEditBotMsgChannels, pvpKingChannelID, pvpKingSilverChannelID, pvpScoutingGoldChannelID, pvpScoutingSilverChannelID, goldRoleID, silverRoleID, historyThreadID, historySilverThreadID, dungeonChannelID, dungeonRoleID, giveawayChannelID
    } = appConfig;

    let interactionDiagnostics;
    const discordTransport = createDiscordTransport({
        onTiming: event => interactionDiagnostics?.recordTransportTiming(event)
    });
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildWebhooks,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildVoiceStates
        ],
        partials: [Partials.GuildMember, Partials.User, Partials.Message, Partials.Reaction],
        rest: { makeRequest: discordTransport.makeRequest }
    });
    const runtimeHealth = new RuntimeHealth({ client, ocrSnapshot: () => sharedOcrWorkerPool.healthSnapshot() });
    const memberHistory = new MemberAuditHistory({ db, shutdownSignal: lifecycle.signal,
        filePath: path.join(rootPath, 'data', 'member-audit-history.json') });

    const guildSettings = new GuildSettingsStore({ db, guildId, signal: lifecycle.signal, storageMode: processObject.env.STORAGE_MODE,
        filePath: path.join(rootPath, 'data', 'guild_settings.json') });
    const guildSettingsCache = guildSettings.cache;
    const cooldowns = new CommandCooldowns();
    const onCooldown = cooldowns.onCooldown.bind(cooldowns);

    const commandMap = new Map();

    const challengeTimeouts = new Map(); // PvP challenge confirmation timers
    const pvpKingStorage = new PvpKingStorage({ db });
    const pvpKingStores = {
        gold: pvpKingStorage,
        silver: new PvpKingStorage({ db, server: 'silver' })
    };
    const pvpChallengeTimeouts = { gold: challengeTimeouts, silver: new Map() };
    const giveawayStore = createGiveawayStore({ db });
    const xpStore = new XpStore({ db, shutdownSignal: lifecycle.signal });
    db.xpStore = xpStore;
    const notificationStore = new NotificationStore({
        db,
        guildId,
        definitions: NOTIFICATION_DEFINITIONS
    });
    const guildApplicationMonitor = createGuildApplicationMonitor({ client, db, config: appConfig });
    const tbaForumShopMonitor = createTbaForumShopMonitor({ client, db, config: appConfig });
    const scoutRosterStore = new ScoutRosterStore({ db, guildMemberRoleID });
    const scoutServerSettings = new ScoutServerSettings({ config: appConfig, store: scoutRosterStore });
    const scoutAuditLogger = new ScoutAuditLogger({ client, guildId, channelId: logChannelID, ownerId: ownerID });
    const botDiagnostics = new DiscordDiagnosticLogger({ consoleObject: console,
        send: event => scoutAuditLogger.diagnostic(event),
        secrets: Object.entries(processObject.env).filter(([key]) => /TOKEN|PASSWORD|SECRET|API_KEY/iu.test(key)).map(([, value]) => value) });
    botDiagnostics.install();
    botDiagnostics.watchGateway(client);
    interactionDiagnostics = new InteractionDiagnostics({ rest: client.rest });
    const scoutServers = new ScoutServerRegistry({ client, db, config: appConfig,
        rosterStore: scoutRosterStore, auditLogger: scoutAuditLogger, diagnostics: botDiagnostics,
        dataPath: path.join(rootPath, 'data') });
    const { store: pvpScoutStore, ingestor: pvpScoutIngestor } = scoutServers.get('gold');

    // Keep the command constructor contract shared by commands and event modules.
    const commandConfig = {
        client,
        db,
        shutdownSignal: lifecycle.signal,
        botTimezone,
        guildId,
        welcomeChannelID,
        ownerID,
        leaderRoleID,
        adminRoleID,
        officerRoleID,
        guildMemberRoleID,
        pvpKingRoleID,
        pvpKingSilverRoleID,
        pvpWarriorRoleID,
        ccRoleID,
        botChannelID,
        logChannelID,
        memberHistory,
        selfRoleChannelID: appConfig.selfRoleChannelID,
        newAccountWarningHours: appConfig.newAccountWarningHours,
        ignoredLogChannels,
        ignoreLogPrivateChannelCreate,
        blockedEditBotMsgChannels,
        pvpKingChannelID,
        pvpKingSilverChannelID,
        pvpScoutingGoldChannelID,
        pvpScoutingSilverChannelID,
        goldRoleID,
        silverRoleID,
        scoutServers,
        scoutServerSettings,
        historyThreadID,
        historySilverThreadID,
        dungeonChannelID,
        dungeonRoleID,
        giveawayChannelID,
        giveawayStore,
        notificationStore,
        challengeTimeouts,
        pvpKingStorage,
        pvpKingStores,
        pvpChallengeTimeouts,
        pvpScoutStore,
        scoutRosterStore,
        guildMemberStore: scoutRosterStore,
        pvpScoutIngestor,
        onCooldown,
        commandMap,
        guildSettingsCache
    };

    configureXpRecovery(commandConfig);

    return new BotApplication({ appConfig, runtimeLogging, processObject, rootPath, db, lifecycle,
        token, clientId, client, commandConfig, commandMap, guildSettings, botDiagnostics,
        interactionDiagnostics, discordTransport, runtimeHealth, memberHistory, xpStore,
        pvpKingStores, notificationStore, giveawayStore, guildApplicationMonitor, tbaForumShopMonitor,
        scoutServers, scoutServerSettings, scoutAuditLogger });
}

module.exports = { createBotApplication };
