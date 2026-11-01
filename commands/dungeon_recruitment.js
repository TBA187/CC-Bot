// ---------------------------------------------------------
// Dungeon recruitment commands:
// /forlorn | /victini | /meloetta | /hoopa | /xmas_dungeon
// ---------------------------------------------------------
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { readJsonObject, writeJsonIfChanged } = require('../utils/jsonFile.js');
const { findRecentBotMessage } = require('../utils/discordMessageHistory.js');

const DUNGEON_RUNS_DATA_DIR = path.join(__dirname, '../data');
const DUNGEON_RUNS_FILE = path.join(DUNGEON_RUNS_DATA_DIR, 'dungeon_runs.json');
const DUNGEON_RUNS_STORAGE_VERSION = 1;
const JSON_SOURCES = {
    MYSQL_FALLBACK: 'mysql_fallback',
    JSON_ONLY: 'json_only'
};
const STORAGE_SYNC_INTERVAL_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 2147483647;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const NO_MULTIPLE_ASSIGNMENT_COMMANDS = new Set(['victini', 'xmas_dungeon']);
const NOTIFICATION_MODES = {
    DM: 'dm',
    CHANNEL: 'channel'
};

const DUNGEONS = {
    forlorn: {
        name: 'Forlorn',
        location: 'Forlorn Court',
        titleEmoji: '🏰',
        color: 0x1A43BF,
        roles: [
            { key: 'room1', label: 'Room 1', emoji: '<:slowbro:1520646521396134019>' },
            { key: 'room2', label: 'Room 2', emoji: '<:sceptile:1520646685175316533>' },
            { key: 'room3', label: 'Room 3', emoji: '<:houndoom:1520646615969300510>' },
            { key: 'room4', label: 'Room 4', emoji: '<:salamence:1520646651428077658>' },
            { key: 'mid', label: 'Mid (Rotom)', emoji: '<:rotom:1520647413017346128>' }
        ]
    },
    victini: {
        name: 'Victini',
        location: 'Ruins of the Vale',
        titleEmoji: '<:victini:1514805175519412254>',
        color: 0xF59E0B,
        rolesNote: '-# **Victini Dungeon** needs at least 4 guild members!',
        roles: [
            { key: 'player1', label: 'Player 1', emoji: '🥇' },
            { key: 'player2', label: 'Player 2', emoji: '🥈' },
            { key: 'player3', label: 'Player 3', emoji: '🥉' },
            { key: 'player4', label: 'Player 4', emoji: '🏅' },
            { key: 'player5', label: 'Player 5', emoji: '🏆' }
        ]
    },
    meloetta: {
        name: 'Meloetta',
        location: 'Crux of Melody',
        titleEmoji: '<:meloetta:1514805507372748830>',
        color: 0xEC4899,
        buttonRows: [
            ['ice', 'sleep', 'trees'],
            ['fire', 'poison']
        ],
        roles: [
            { key: 'ice', label: 'Ice Room', emoji: '❄️' },
            { key: 'sleep', label: 'Sleep Room', emoji: '😴' },
            { key: 'fire', label: 'Fire Room', emoji: '🔥' },
            { key: 'poison', label: 'Poison Room', emoji: '☠️' },
            { key: 'trees', label: 'Trees (Water Room)', emoji: '🌊' }
        ]
    },
    hoopa: {
        name: 'Hoopa',
        location: 'Scattered Realm',
        titleEmoji: '<a:hoopa:1474190060671995924>',
        color: 0x8B5CF6,
        buttonRows: [
            ['hoopa', 'dialga', 'palkia'],
            ['groudon', 'kyogre']
        ],
        roles: [
            { key: 'groudon', label: 'Groudon Boss', emoji: '<:groudon:1520634366546673729>' },
            { key: 'kyogre', label: 'Kyogre Boss', emoji: '<a:kyogre:1520633624477700119>' },
            { key: 'dialga', label: 'Dialga Boss', emoji: '<:dialga:1520650577183510578>' },
            { key: 'palkia', label: 'Palkia Boss', emoji: '<:palkia:1520650534640685077>' },
            { key: 'hoopa', label: 'Hoopa Boss', emoji: '<:hoopa_unbound:1520651206756794398>' }
        ]
    },
    xmas_dungeon: {
        name: 'Xmas',
        location: 'Temple of Truth',
        titleEmoji: '<a:reshiram:1474190687246225450>',
        color: 0x02f3d7,
        buttonRows: [
            ['reshiram', 'tyranitar', 'ninetales'],
            ['camerupt', 'houndoom']
        ],
        roles: [
            { key: 'tyranitar', label: 'Tyranitar Boss', emoji: '<:tyranitar:1521280904796831875>' },
            { key: 'ninetales', label: 'Ninetales Boss', emoji: '<:ninetales_alolan:1521281765157634088>' },
            { key: 'camerupt', label: 'Camerupt Boss', emoji: '<:camerupt:1521280853689237676>' },
            { key: 'houndoom', label: 'Houndoom Boss', emoji: '<:houndoom:1520646615969300510>' },
            { key: 'reshiram', label: 'Reshiram Boss', emoji: '<a:reshiram:1474190687246225450>' }
        ]
    }
};

function getUnix(date) {
    return Math.floor(date.getTime() / 1000);
}

function formatDiscordTime(date) {
    const unix = getUnix(date);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatDungeonTime(date, isClosed) {
    const formattedTime = formatDiscordTime(date);
    return isClosed ? `~~${formattedTime}~~` : formattedTime;
}

function createFooterLogoAttachment() {
    return new AttachmentBuilder(path.join(__dirname, '../images/cc_logo.webp'), { name: 'cc_logo.webp' });
}

function parseRelativeTime(input, nowMs) {
    const multipliers = {
        s: 1000,
        sec: 1000,
        secs: 1000,
        second: 1000,
        seconds: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        mins: 60 * 1000,
        minute: 60 * 1000,
        minutes: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        hrs: 60 * 60 * 1000,
        hour: 60 * 60 * 1000,
        hours: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000
    };

    const cleaned = input
        .trim()
        .toLowerCase()
        .replace(/^in\s+/, '')
        .replace(/,/g, ' ')
        .replace(/\band\b/g, ' ');

    const partRegex = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
    let totalMs = 0;
    let matched = false;
    let cursor = 0;
    let match;

    while ((match = partRegex.exec(cleaned)) !== null) {
        const betweenParts = cleaned.slice(cursor, match.index).trim();
        if (betweenParts) return null;

        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        const multiplier = multipliers[unit];

        if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;

        totalMs += amount * multiplier;
        matched = true;
        cursor = partRegex.lastIndex;
    }

    if (!matched || cleaned.slice(cursor).trim()) return null;

    const result = new Date(nowMs + totalMs);
    return Number.isFinite(result.getTime()) ? result : null;
}

function parseDungeonTime(input, nowMs = Date.now()) {
    if (!input || !input.trim()) return null;

    const cleaned = input.trim();
    return parseRelativeTime(cleaned, nowMs);
}

function normalizeDescription(input) {
    const description = input?.trim().replace(/\\n/g, '\n');
    return description || null;
}

function truncateChoiceName(name) {
    return name.length > 100 ? `${name.slice(0, 97)}...` : name;
}

function getDungeonDisplayName(runOrDungeon) {
    return `${runOrDungeon.name ?? runOrDungeon.dungeonName} Dungeon (${runOrDungeon.location})`;
}

class DungeonRecruitment {
    constructor(config) {
        this.name = 'dungeon_recruitment';
        this.client = config.client;
        this.db = config.db;
        this.onCooldown = config.onCooldown;
        this.activeRuns = new Map();
        this.runButtonQueues = new Map();
        this.pendingStorageWrite = Promise.resolve();
        this.storageSyncInterval = null;
        this.stopped = false;
        this.storageFile = config.dungeonRunsFile || DUNGEON_RUNS_FILE;
        this.storageTempFile = `${this.storageFile}.tmp`;
        this.mysqlOutage = false;
        // Both database modes retain pending changes in JSON during an outage.
        this.storageMode = this.parseStorageMode(process.env.STORAGE_MODE);
        this.dungeonChannelID = config.dungeonChannelID;
        this.dungeonRoleID = config.dungeonRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;

        this.data = [
            ...Object.keys(DUNGEONS).map(commandName => this.buildCommand(commandName)),
            this.buildReminderCommand()
        ];

        this.loadPersistedRuns();
        this.restoreOnReady = () => {
            if (this.stopped) return;
            this.restorePromise = this.restorePersistedRuns()
                .catch(err => console.error('[CC LOG] Failed to restore Dungeon recruitments:', err));
        };
        if (this.client?.isReady?.()) {
            this.restoreOnReady();
        } else {
            this.client?.once?.('clientReady', this.restoreOnReady);
        }
    }

    async stop() {
        this.stopped = true;
        this.client?.off?.('clientReady', this.restoreOnReady);
        if (this.storageSyncInterval) clearInterval(this.storageSyncInterval);
        this.storageSyncInterval = null;
        for (const run of this.activeRuns.values()) {
            if (run.deadlineTimeout) clearTimeout(run.deadlineTimeout);
            run.deadlineTimeout = null;
        }
        await Promise.allSettled([this.restorePromise, ...this.runButtonQueues.values()]);
        await this.pendingStorageWrite;
    }

    buildCommand(commandName) {
        const dungeon = DUNGEONS[commandName];

        const builder = new SlashCommandBuilder()
            .setName(commandName)
            .setDescription(`Create a ${dungeon.name} Dungeon recruitment. (${dungeon.location})`)
            .addStringOption(o =>
                o.setName('dungeon_start')
                    .setDescription('Time until the Dungeon starts (e.g. 5 hours or 7 hours 17 mins)')
                    .setRequired(true)
                    .setMaxLength(100)
            )
            .addStringOption(o =>
                o.setName('registration_end')
                    .setDescription('Leave empty to close when 5 members join. Or enter time to close recruiment, e.g. 7 h 30 m')
                    .setRequired(false)
                    .setMaxLength(100)
            )
            .addStringOption(o =>
                o.setName('description')
                    .setDescription('Dungeon description (optional). Use \\n for line breaks, e.g. Line 1\\nLine 2.')
                    .setRequired(false)
                    .setMaxLength(1000)
            )
            .addStringOption(o =>
                o.setName('ping_dungeon_role')
                    .setDescription('Should the @Dungeon role be pinged for this dungeon run? (Leave empty for NO!)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            )

        if (!NO_MULTIPLE_ASSIGNMENT_COMMANDS.has(commandName)) {
            builder.addStringOption(o =>
                o.setName('multiple_assignments')
                    .setDescription('Should a player be able to select multiple Dungeon roles? (Leave empty for NO!)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            );
        }

        builder.addStringOption(o =>
            o.setName('notifications')
                .setDescription('Receive a notification when someone joins or leaves your Dungeon Team? (Leave empty for NO!)')
                .setRequired(false)
                .addChoices(
                    { name: 'Get notified in a DM (Direct Message)', value: NOTIFICATION_MODES.DM },
                    { name: 'Get notified in the Dungeon Channel', value: NOTIFICATION_MODES.CHANNEL }
                )
        );

        return builder;
    }

    buildReminderCommand() {
        return new SlashCommandBuilder()
            .setName('dungeon_reminders')
            .setDescription('Enable or disable reminder messages for open Dungeon recruitments')
            .addStringOption(o =>
                o.setName('active_dungeon_runs')
                    .setDescription('Select one open Dungeon recruitment to update its reminders')
                    .setRequired(false)
                    .setAutocomplete(true)
            )
            .addStringOption(o =>
                o.setName('post_reminder')
                    .setDescription('Post reminders for the selected Dungeon run? Leave empty for YES.')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Yes', value: 'yes' },
                        { name: 'No', value: 'no' }
                    )
            )
            .addStringOption(o =>
                o.setName('disable_all_reminders')
                    .setDescription('Select "Yes" to disable ALL open reminders. No enables all. Empty makes no global change.')
                    .setRequired(false)
                    .addChoices(
                        { name: 'No', value: 'no' },
                        { name: 'Yes', value: 'yes' }
                    )
            );
    }

    createRunId() {
        let runId;
        do {
            runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        } while (this.activeRuns.has(runId));

        return runId;
    }

    parseStorageMode(value) {
        const mode = String(value || 'auto').toLowerCase();
        return ['auto', 'mysql', 'json'].includes(mode) ? mode : 'auto';
    }

    getJsonSource() {
        return this.storageMode === 'json' ? JSON_SOURCES.JSON_ONLY : JSON_SOURCES.MYSQL_FALLBACK;
    }

    hasMysqlCredentials() {
        return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
    }

    canUseMysql() {
        return this.storageMode !== 'json' && this.db && this.hasMysqlCredentials();
    }

    noteMysqlFailure(err) {
        if (this.db?.isDatabaseUnavailableError && !this.db.isDatabaseUnavailableError(err)) {
            console.error('[CC LOG] Unexpected MySQL Dungeon storage error:', err);
            return;
        }
        if (this.mysqlOutage) return;
        this.mysqlOutage = true;
        const errorCode = this.db?.getErrorCode?.(err) || err?.causeCode || err?.code || err?.message || err;
        console.warn(
            `[CC LOG] MySQL Dungeon storage unavailable (${errorCode}). ` +
            'Using JSON; pending runs will synchronize automatically.'
        );
    }

    noteMysqlRestored() {
        if (!this.mysqlOutage) return;
        this.mysqlOutage = false;
        console.log('[CC LOG] MySQL Dungeon storage restored; pending JSON runs are synchronizing.');
    }

    async mysqlQuery(sql, params = []) {
        try {
            const result = await this.db.query(sql, params);
            this.noteMysqlRestored();
            return result;
        } catch (err) {
            this.noteMysqlFailure(err);
            throw err;
        }
    }

    getRunStatus(run) {
        if (run.status) return run.status;
        if (!run.closed) return 'open';
        if (run.closeReason === 'full') return 'closed_full';
        if (run.closeReason === 'deadline') return 'closed_deadline';
        return 'closed_missing_message';
    }

    markRunClosed(run, reason) {
        run.closed = true;
        run.remindersEnabled = false;
        run.closeReason = reason;
        run.closedAt = Date.now();
        run.status = reason === 'full'
            ? 'closed_full'
            : (reason === 'deadline' ? 'closed_deadline' : 'closed_missing_message');
    }

    serializeRun(run) {
        return {
            id: run.id,
            guildId: run.guildId,
            channelId: run.channelId,
            messageId: run.messageId,
            messageUrl: run.messageUrl,
            partyLeaderId: run.partyLeaderId,
            partyLeaderName: run.partyLeaderName,
            dungeonKey: run.dungeonKey,
            startTime: run.startTime?.getTime?.() ?? Number(run.startTime) ?? null,
            registrationEndTime: run.registrationEndTime?.getTime?.() ?? (run.registrationEndTime ? Number(run.registrationEndTime) : null),
            description: run.description,
            notificationMode: run.notificationMode,
            multipleAssignments: run.multipleAssignments,
            assignments: run.assignments ?? {},
            memberNames: run.memberNames ?? {},
            joinOrder: run.joinOrder ?? [],
            status: this.getRunStatus(run),
            closeReason: run.closeReason ?? null,
            closedAt: run.closedAt ?? null,
            closed: run.closed === true,
            createdAt: run.createdAt,
            reminderCounter: run.reminderCounter ?? 0,
            remindersEnabled: run.remindersEnabled !== false,
            remindersStopAt: run.remindersStopAt ?? null
        };
    }

    deserializeRun(raw) {
        const status = raw?.status ?? (raw?.closed ? 'closed_missing_message' : 'open');
        if (!raw || status !== 'open') return null;

        const dungeon = DUNGEONS[raw.dungeonKey];
        if (!dungeon || !raw.id || !raw.guildId || !raw.channelId || !raw.messageId || !raw.partyLeaderId) return null;

        const startTime = new Date(Number(raw.startTime));
        if (Number.isNaN(startTime.getTime())) return null;

        let registrationEndTime = null;
        if (raw.registrationEndTime) {
            registrationEndTime = new Date(Number(raw.registrationEndTime));
            if (Number.isNaN(registrationEndTime.getTime())) return null;
        }

        const roleKeys = new Set(dungeon.roles.map(role => role.key));
        const assignments = {};
        if (raw.assignments && typeof raw.assignments === 'object' && !Array.isArray(raw.assignments)) {
            for (const [roleKey, userId] of Object.entries(raw.assignments)) {
                if (roleKeys.has(roleKey) && userId) assignments[roleKey] = String(userId);
            }
        }

        const memberNames = {};
        if (raw.memberNames && typeof raw.memberNames === 'object' && !Array.isArray(raw.memberNames)) {
            for (const [userId, name] of Object.entries(raw.memberNames)) {
                if (userId && name) memberNames[String(userId)] = String(name);
            }
        }
        if (!memberNames[String(raw.partyLeaderId)] && raw.partyLeaderName) {
            memberNames[String(raw.partyLeaderId)] = String(raw.partyLeaderName);
        }

        const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
        const remindersStopAt = Number.isFinite(Number(raw.remindersStopAt))
            ? Number(raw.remindersStopAt)
            : createdAt + REMINDER_WINDOW_MS;

        return {
            id: String(raw.id),
            guildId: String(raw.guildId),
            channelId: String(raw.channelId),
            messageId: String(raw.messageId),
            messageUrl: raw.messageUrl ?? `https://discord.com/channels/${raw.guildId}/${raw.channelId}/${raw.messageId}`,
            partyLeaderId: String(raw.partyLeaderId),
            partyLeaderName: raw.partyLeaderName ?? memberNames[String(raw.partyLeaderId)] ?? 'Unknown',
            dungeonKey: raw.dungeonKey,
            dungeonName: dungeon.name,
            location: dungeon.location,
            titleEmoji: dungeon.titleEmoji,
            color: dungeon.color,
            roles: dungeon.roles,
            rolesNote: dungeon.rolesNote ?? null,
            buttonRows: dungeon.buttonRows ?? null,
            startTime,
            registrationEndTime,
            description: raw.description ?? null,
            notificationMode: raw.notificationMode ?? null,
            multipleAssignments: raw.multipleAssignments === true,
            assignments,
            memberNames,
            joinOrder: Array.isArray(raw.joinOrder) ? raw.joinOrder.map(String) : [],
            closed: false,
            status: 'open',
            closeReason: null,
            closedAt: null,
            createdAt,
            reminderCounter: Number.isFinite(Number(raw.reminderCounter)) ? Number(raw.reminderCounter) : 0,
            remindersEnabled: raw.remindersEnabled !== false,
            remindersStopAt,
            deadlineTimeout: null
        };
    }

    parseJsonValue(value, fallback) {
        if (value == null) return fallback;
        if (typeof value !== 'string') return value;

        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    dbRowToStoredRun(row) {
        return {
            id: row.run_id,
            guildId: row.guild_id,
            channelId: row.channel_id,
            messageId: row.message_id,
            messageUrl: row.message_url,
            partyLeaderId: row.party_leader_id,
            partyLeaderName: row.party_leader_name,
            dungeonKey: row.dungeon_key,
            startTime: Number(row.start_time_ms),
            registrationEndTime: row.registration_end_time_ms == null ? null : Number(row.registration_end_time_ms),
            description: row.description,
            notificationMode: row.notification_mode,
            multipleAssignments: row.multiple_assignments === 1 || row.multiple_assignments === true,
            assignments: this.parseJsonValue(row.assignments, {}),
            memberNames: this.parseJsonValue(row.member_names, {}),
            joinOrder: this.parseJsonValue(row.join_order, []),
            status: row.status ?? 'open',
            closeReason: row.close_reason,
            closedAt: row.closed_at_ms == null ? null : Number(row.closed_at_ms),
            closed: row.status !== 'open',
            createdAt: Number(row.created_at_ms),
            reminderCounter: Number(row.reminder_counter ?? 0),
            remindersEnabled: row.reminders_enabled !== 0,
            remindersStopAt: row.reminders_stop_at_ms == null ? null : Number(row.reminders_stop_at_ms)
        };
    }

    ensureJsonStore() {
        fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
        if (!fs.existsSync(this.storageFile)) {
            this.writeJsonStore([], this.getJsonSource(), false);
        }
    }

    readJsonStore() {
        this.ensureJsonStore();

        const stored = readJsonObject(this.storageFile, value => Array.isArray(value.runs));
        const runs = stored?.runs || [];
        const source = stored?.source ?? this.getJsonSource();
        const pendingSync = stored?.pendingSync === true || (source === JSON_SOURCES.MYSQL_FALLBACK && runs.length > 0);
        return { version: DUNGEON_RUNS_STORAGE_VERSION, source, pendingSync, runs };
    }

    writeJsonStore(runs, source, pendingSync) {
        return writeJsonIfChanged(this.storageFile, this.storageTempFile, {
            version: DUNGEON_RUNS_STORAGE_VERSION,
            source,
            pendingSync,
            runs
        });
    }

    getOpenStoredRuns() {
        return [...this.activeRuns.values()]
            .filter(run => !run.closed)
            .map(run => this.serializeRun(run));
    }

    mergeFallbackRuns(extraRun = null) {
        const store = this.readJsonStore();
        const byId = new Map();

        if (store.source === JSON_SOURCES.MYSQL_FALLBACK) {
            for (const storedRun of store.runs) {
                if (storedRun?.id) byId.set(String(storedRun.id), storedRun);
            }
        }

        const activeIds = new Set();
        for (const storedRun of this.getOpenStoredRuns()) {
            activeIds.add(storedRun.id);
            byId.set(storedRun.id, storedRun);
        }

        if (extraRun) {
            const storedExtra = this.serializeRun(extraRun);
            byId.set(storedExtra.id, storedExtra);
        }

        for (const [runId, storedRun] of byId.entries()) {
            if ((storedRun.status ?? 'open') === 'open' && !activeIds.has(runId) && (!extraRun || extraRun.id !== runId)) {
                byId.delete(runId);
            }
        }

        return [...byId.values()];
    }

    loadPersistedRuns() {
        const store = this.readJsonStore();
        if (store.source !== this.getJsonSource()) return;

        let skipped = 0;
        for (const rawRun of store.runs) {
            const status = rawRun?.status ?? (rawRun?.closed ? 'closed_missing_message' : 'open');
            if (rawRun?.id && status !== 'open') {
                // A pending close takes precedence over an older open row from MySQL.
                this.activeRuns.delete(String(rawRun.id));
                continue;
            }
            const run = this.deserializeRun(rawRun);
            if (!run) {
                if ((rawRun?.status ?? 'open') === 'open') skipped += 1;
                continue;
            }

            this.activeRuns.set(run.id, run);
        }

        if (skipped > 0) {
            console.warn(`[CC LOG] Skipped ${skipped} invalid persisted Dungeon run(s).`);
            this.saveRuns();
        }
    }

    async loadMysqlRuns() {
        if (!this.canUseMysql()) return false;

        try {
            const [rows] = await this.mysqlQuery(`
                SELECT *
                FROM dungeon_runs
                WHERE status = 'open'
            `);

            for (const row of rows) {
                const run = this.deserializeRun(this.dbRowToStoredRun(row));
                if (run && !this.activeRuns.has(run.id)) {
                    this.activeRuns.set(run.id, run);
                }
            }

            return true;
        } catch (err) {
            this.noteMysqlFailure(err);
            return false;
        }
    }

    async upsertMysqlRun(storedRun, storageOrigin = 'mysql') {
        await this.mysqlQuery(`
            INSERT INTO dungeon_runs (
                run_id, guild_id, channel_id, message_id, message_url,
                party_leader_id, party_leader_name,
                dungeon_key, start_time_ms, registration_end_time_ms, description,
                notification_mode, multiple_assignments,
                assignments, member_names, join_order,
                status, close_reason, closed_at_ms,
                created_at_ms, reminder_counter, reminders_enabled, reminders_stop_at_ms,
                storage_origin
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                guild_id = VALUES(guild_id),
                channel_id = VALUES(channel_id),
                message_id = VALUES(message_id),
                message_url = VALUES(message_url),
                party_leader_id = VALUES(party_leader_id),
                party_leader_name = VALUES(party_leader_name),
                dungeon_key = VALUES(dungeon_key),
                start_time_ms = VALUES(start_time_ms),
                registration_end_time_ms = VALUES(registration_end_time_ms),
                description = VALUES(description),
                notification_mode = VALUES(notification_mode),
                multiple_assignments = VALUES(multiple_assignments),
                assignments = VALUES(assignments),
                member_names = VALUES(member_names),
                join_order = VALUES(join_order),
                status = IF(dungeon_runs.status <> 'open' AND VALUES(status) = 'open', dungeon_runs.status, VALUES(status)),
                close_reason = IF(dungeon_runs.status <> 'open' AND VALUES(status) = 'open', dungeon_runs.close_reason, VALUES(close_reason)),
                closed_at_ms = IF(dungeon_runs.status <> 'open' AND VALUES(status) = 'open', dungeon_runs.closed_at_ms, VALUES(closed_at_ms)),
                created_at_ms = VALUES(created_at_ms),
                reminder_counter = VALUES(reminder_counter),
                reminders_enabled = VALUES(reminders_enabled),
                reminders_stop_at_ms = VALUES(reminders_stop_at_ms),
                storage_origin = VALUES(storage_origin)
        `, [
            storedRun.id,
            storedRun.guildId,
            storedRun.channelId,
            storedRun.messageId,
            storedRun.messageUrl ?? null,
            storedRun.partyLeaderId,
            storedRun.partyLeaderName ?? null,
            storedRun.dungeonKey,
            storedRun.startTime,
            storedRun.registrationEndTime ?? null,
            storedRun.description ?? null,
            storedRun.notificationMode ?? null,
            storedRun.multipleAssignments ? 1 : 0,
            JSON.stringify(storedRun.assignments ?? {}),
            JSON.stringify(storedRun.memberNames ?? {}),
            JSON.stringify(storedRun.joinOrder ?? []),
            storedRun.status ?? 'open',
            storedRun.closeReason ?? null,
            storedRun.closedAt ?? null,
            storedRun.createdAt,
            storedRun.reminderCounter ?? 0,
            storedRun.remindersEnabled === false ? 0 : 1,
            storedRun.remindersStopAt ?? null,
            storageOrigin
        ]);
    }

    saveRuns(extraRun = null) {
        return this.queueStorageWrite(() => this.saveRunsNow(extraRun));
    }

    queueStorageWrite(work) {
        this.pendingStorageWrite = this.pendingStorageWrite
            .catch(() => { })
            .then(work);
        void this.pendingStorageWrite.catch(err => console.error('[CC LOG] Failed to persist Dungeon recruitments:', err));
        return this.pendingStorageWrite;
    }

    async saveRunsNow(extraRun = null) {
        if (this.storageMode === 'json') {
            this.writeJsonStore(this.getOpenStoredRuns(), JSON_SOURCES.JSON_ONLY, false);
            return;
        }

        const storedRuns = this.mergeFallbackRuns(extraRun);
        const currentRunIds = new Set(this.activeRuns.keys());
        if (extraRun) currentRunIds.add(extraRun.id);

        // Keep the snapshot recoverable before any database request can time out.
        this.writeJsonStore(storedRuns, JSON_SOURCES.MYSQL_FALLBACK, true);

        if (!this.canUseMysql()) {
            return;
        }

        try {
            for (const storedRun of storedRuns) {
                await this.upsertMysqlRun(storedRun, currentRunIds.has(storedRun.id) ? 'mysql' : 'json_fallback');
            }
        } catch (err) {
            this.noteMysqlFailure(err);
            return;
        }

        try {
            this.writeJsonStore([], JSON_SOURCES.MYSQL_FALLBACK, false);
        } catch (err) {
            // The change is already durable; leave the pending snapshot for a safe replay.
            console.error('[CC LOG] Failed to clear synchronized Dungeon recovery data:', err);
        }
    }

    async syncFallbackRuns() {
        if (!this.canUseMysql()) return false;

        const store = this.readJsonStore();
        if (store.source !== JSON_SOURCES.MYSQL_FALLBACK || !store.pendingSync || store.runs.length === 0) return false;

        for (const storedRun of store.runs) {
            await this.upsertMysqlRun(storedRun, 'json_fallback');
        }

        this.writeJsonStore([], JSON_SOURCES.MYSQL_FALLBACK, false);
        console.log(`[CC LOG] Synced ${store.runs.length} fallback Dungeon run(s) to MySQL.`);
        return true;
    }

    startStorageSyncLoop() {
        if (this.stopped || this.storageMode === 'json' || this.storageSyncInterval) return;

        this.storageSyncInterval = setInterval(() => {
            // Use the write queue so an older sync cannot clear a newer fallback.
            this.queueStorageWrite(() => this.syncFallbackRuns());
        }, STORAGE_SYNC_INTERVAL_MS);

        this.storageSyncInterval.unref?.();
    }

    async restorePersistedRuns() {
        if (this.stopped) return;
        if (this.storageMode !== 'json') {
            await this.loadMysqlRuns();
            if (this.stopped) return;
            this.loadPersistedRuns();
            await this.queueStorageWrite(() => this.syncFallbackRuns()).catch(() => { });
        }

        if (this.stopped) return;
        this.startStorageSyncLoop();
        if (this.activeRuns.size === 0) return;

        let changed = false;
        for (const run of [...this.activeRuns.values()]) {
            const message = await this.fetchRunMessage(run, this.client);
            if (this.stopped) return;
            if (!message) {
                this.markRunClosed(run, 'missing_message');
                this.activeRuns.delete(run.id);
                this.saveRuns(run);
                changed = true;
                continue;
            }

            if (!this.isReminderWindowOpen(run)) {
                run.remindersEnabled = false;
                changed = true;
            }

            if (this.isFull(run)) {
                await this.closeRun(run.id, 'full', this.client, message);
                continue;
            }

            if (run.registrationEndTime && run.registrationEndTime.getTime() <= Date.now()) {
                await this.closeRunAtDeadline(run, message);
                continue;
            }

            await message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            }).catch(err => console.error('[CC LOG] Failed to refresh persisted dungeon recruitment:', err));

            this.scheduleDeadline(run);
        }

        if (changed) this.saveRuns();
    }

    async execute(interaction) {
        if (interaction.commandName === 'dungeon_reminders') {
            return this.executeReminderCommand(interaction);
        }

        const dungeon = DUNGEONS[interaction.commandName];
        if (!dungeon) return;

        if (this.onCooldown?.(interaction.user.id, `dungeon_${interaction.commandName}`, 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (!this.dungeonChannelID) {
            return interaction.reply({
                content: '### ❌ Dungeon channel is not configured.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.channelId !== this.dungeonChannelID) {
            return interaction.reply({
                content: `### ❌ The \`/${interaction.commandName}\` command can only be used in <#${this.dungeonChannelID}>.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const nowMs = Date.now();
        const startInput = interaction.options.getString('dungeon_start', true);
        const registrationEndInput = interaction.options.getString('registration_end');
        const description = normalizeDescription(interaction.options.getString('description'));
        const notificationMode = interaction.options.getString('notifications');
        const pingDungeonRole = interaction.options.getString('ping_dungeon_role') === 'yes';
        const multipleAssignments = interaction.options.getString('multiple_assignments') === 'yes';

        if (pingDungeonRole && !this.dungeonRoleID) {
            return interaction.reply({
                content: '### ❌ Dungeon role is not configured.',
                flags: MessageFlags.Ephemeral
            });
        }

        const startTime = parseDungeonTime(startInput, nowMs);
        if (!startTime || startTime.getTime() <= nowMs) {
            return interaction.reply({
                content: '### ❌ Invalid Dungeon Start\n- Enter a time from now, like `5h (hours)`, `100m (mins)`, `1d (day)`, or `5h 17m`.',
                flags: MessageFlags.Ephemeral
            });
        }

        let registrationEndTime = null;
        if (registrationEndInput?.trim()) {
            registrationEndTime = parseDungeonTime(registrationEndInput, nowMs);
            if (!registrationEndTime || registrationEndTime.getTime() <= nowMs) {
                return interaction.reply({
                    content: '### ❌ Invalid Registration End\n- Enter a time from now, like `5h (hours)`, `100m (mins)`, `1d (day)`, or `5h 17m`.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const runId = this.createRunId();
        const run = {
            id: runId,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            messageId: null,
            messageUrl: null,
            partyLeaderId: interaction.user.id,
            partyLeaderName: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
            dungeonKey: interaction.commandName,
            dungeonName: dungeon.name,
            location: dungeon.location,
            titleEmoji: dungeon.titleEmoji,
            color: dungeon.color,
            roles: dungeon.roles,
            rolesNote: dungeon.rolesNote ?? null,
            buttonRows: dungeon.buttonRows ?? null,
            startTime,
            registrationEndTime,
            description,
            notificationMode,
            multipleAssignments,
            assignments: {},
            memberNames: {
                [interaction.user.id]: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username
            },
            joinOrder: [],
            closed: false,
            createdAt: nowMs,
            reminderCounter: 0,
            remindersEnabled: true,
            remindersStopAt: nowMs + REMINDER_WINDOW_MS,
            deadlineTimeout: null
        };

        this.activeRuns.set(runId, run);

        try {
            await interaction.deferReply();

            const startMessage = pingDungeonRole
                ? `### ${run.titleEmoji} <@&${this.dungeonRoleID}>, a **${run.dungeonName} Dungeon** run has been started by <@${run.partyLeaderId}>!\n- Join by pressing the **buttons** below!`
                : `### ${run.titleEmoji} A **${run.dungeonName} Dungeon** run has been started by <@${run.partyLeaderId}>!\n- Join by pressing the **buttons** below!`;

            const message = await interaction.editReply({
                content: startMessage,
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run),
                files: [createFooterLogoAttachment()],
                allowedMentions: { roles: pingDungeonRole ? [this.dungeonRoleID] : [] }
            });

            run.messageId = message.id;
            run.messageUrl = message.url ?? `https://discord.com/channels/${run.guildId}/${run.channelId}/${run.messageId}`;
            this.scheduleDeadline(run);
            await this.saveRuns();
        } catch (err) {
            this.activeRuns.delete(runId);
            if (run.deadlineTimeout) clearTimeout(run.deadlineTimeout);
            this.saveRuns();
            throw err;
        }
    }

    hasReminderPermission(interaction) {
        const allowedRoles = [this.adminRoleID, this.officerRoleID].filter(Boolean);
        return interaction.member?.roles?.cache?.some(role => allowedRoles.includes(role.id)) ?? false;
    }

    getOpenRuns() {
        return [...this.activeRuns.values()]
            .filter(run => !run.closed)
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    }

    isReminderWindowOpen(run, nowMs = Date.now()) {
        return !run.remindersStopAt || nowMs < run.remindersStopAt;
    }

    setRunReminders(run, enabled, nowMs = Date.now()) {
        if (enabled && !this.isReminderWindowOpen(run, nowMs)) {
            run.remindersEnabled = false;
            return { updated: false, expired: true };
        }

        const wasEnabled = run.remindersEnabled !== false;
        run.remindersEnabled = enabled;
        if (enabled && !wasEnabled) {
            run.reminderCounter = 0;
        }

        return { updated: true, expired: false };
    }

    async saveReminderChanges(runs, enabled) {
        return this.queueRunOperations(runs.map(run => run.id), async () => {
            const openRuns = runs.filter(run => !run.closed && this.activeRuns.get(run.id) === run);
            const previous = openRuns.map(run => ({
                run, remindersEnabled: run.remindersEnabled, reminderCounter: run.reminderCounter
            }));
            const changes = openRuns.map(run => ({ run, result: this.setRunReminders(run, enabled) }));
            try {
                if (changes.length) await this.saveRuns();
            } catch (error) {
                for (const { run, remindersEnabled, reminderCounter } of previous) {
                    Object.assign(run, { remindersEnabled, reminderCounter });
                }
                throw error;
            }
            return changes;
        });
    }

    async executeReminderCommand(interaction) {
        if (this.onCooldown?.(interaction.user.id, 'dungeon_reminders', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        if (!this.hasReminderPermission(interaction)) {
            return interaction.reply({ content: '### ❌ No permission!', flags: MessageFlags.Ephemeral });
        }

        const runId = interaction.options.getString('active_dungeon_runs');
        const postReminder = interaction.options.getString('post_reminder');
        const disableAllReminders = interaction.options.getString('disable_all_reminders');

        if (runId && disableAllReminders) {
            return interaction.reply({
                content: '### ❌ Choose either one active Dungeon run or a global reminder action, not both.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!runId && !disableAllReminders) {
            return interaction.reply({
                content: '### ❌ Select an active Dungeon run, or use `disable_all_reminders` to manage all open reminders.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (disableAllReminders) {
            const enableAll = disableAllReminders === 'no';
            const openRuns = this.getOpenRuns();
            if (openRuns.length === 0) {
                return interaction.reply({
                    content: '### ❌ There are no open Dungeon recruitments in the local cache.',
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            let updatedCount = 0;
            let expiredCount = 0;
            for (const { result } of await this.saveReminderChanges(this.getOpenRuns(), enableAll)) {
                if (result.expired) expiredCount += 1;
                if (result.updated) updatedCount += 1;
            }

            const actionText = enableAll ? 'enabled' : 'disabled';
            const expiredText = expiredCount > 0
                ? `\n- ${expiredCount} Dungeon run(s) are older than 24 hours, so reminders stayed disabled.`
                : '';

            return interaction.editReply({
                content: `### ✅ Dungeon reminders updated\n- Reminders ${actionText} for **${updatedCount}** open Dungeon run(s).${expiredText}`
            });
        }

        const run = this.activeRuns.get(runId);
        if (!run || run.closed) {
            return interaction.reply({
                content: '### ❌ That Dungeon recruitment is no longer open.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (run.closed || this.activeRuns.get(runId) !== run) {
            return interaction.editReply({ content: '### ❌ That Dungeon recruitment is no longer open.' });
        }
        const enableReminder = postReminder !== 'no';
        const [change] = await this.saveReminderChanges([run], enableReminder);
        if (!change) {
            return interaction.editReply({ content: '### ❌ That Dungeon recruitment is no longer open.' });
        }
        const { result } = change;
        if (result.expired) {
            return interaction.editReply({
                content: `### ⏳ Reminders cannot be re-enabled for **${this.formatDungeonName(run)}** because it is older than 24 hours.`
            });
        }

        return interaction.editReply({
            content:
                `### ✅ Dungeon reminders updated\n` +
                `- Dungeon: **${this.formatDungeonName(run)}** by <@${run.partyLeaderId}>\n` +
                `- Reminders: **${enableReminder ? 'Enabled' : 'Disabled'}**`
        });
    }

    async handleAutocomplete(interaction) {
        if (interaction.commandName !== 'dungeon_reminders') return;

        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'active_dungeon_runs') return interaction.respond([]);

        const query = focused.value.toLowerCase();
        const choices = this.getOpenRuns()
            .map(run => ({
                name: truncateChoiceName(`${run.dungeonName} (${run.partyLeaderName ?? 'Unknown'})`),
                value: run.id
            }))
            .filter(choice => choice.name.toLowerCase().includes(query))
            .slice(0, MAX_AUTOCOMPLETE_CHOICES);

        return interaction.respond(choices);
    }

    buildEmbed(run) {
        const descriptionLines = [
            `## ${run.titleEmoji}\u2002${getDungeonDisplayName(run)}\n` +
            `- Dungeon Start: ${formatDiscordTime(run.startTime)}`
        ];

        if (run.registrationEndTime) {
            descriptionLines.push(`- Registration End: ${formatDungeonTime(run.registrationEndTime, run.closed)}`);
        }

        descriptionLines.push(`- Multiple **Dungeon Roles** assignments: **${run.multipleAssignments ? 'Yes!' : 'No!'}**`);
        descriptionLines.push(`- Dungeon Registration: **${run.closed ? 'Closed!\u2002:x:' : 'Open!\u2002:white_check_mark:'}**`);

        const embed = new EmbedBuilder()
            .setColor(run.color)
            .setDescription(descriptionLines.join('\n'))
            .setFooter({
                text: 'Crow Control Dungeon Organizer',
                iconURL: 'attachment://cc_logo.webp'
            })
            .setTimestamp();

        if (run.description) {
            embed.addFields({
                name: 'Description:',
                value: run.description,
                inline: false
            });
        }

        embed.addFields({
            name: 'Dungeon Roles:',
            value: run.closed
                ? ''
                : ['-# Select an available Dungeon role by pressing the buttons below', run.rolesNote].filter(Boolean).join('\n'),
            inline: false
        });

        embed.addFields(this.getRolesInButtonOrder(run).map(role => ({
            name: `${role.emoji} ${role.label}`,
            value: run.assignments[role.key]
                ? `<@${run.assignments[role.key]}>`
                : (run.closed ? '- *No assignment*' : '- *Available!*'),
            inline: true
        })));

        return embed;
    }

    buildCloseOverviewEmbed(run) {
        const signedUpCount = this.getAssignedUserIds(run).length;
        const rolesOverview = signedUpCount === 0
            ? `No members signed up for the ${this.formatDungeonName(run)}.`
            : this.getRolesInButtonOrder(run)
                .map(role => `- ${role.emoji}\u2002**${role.label}:** ${run.assignments[role.key] ? `<@${run.assignments[role.key]}>` : '*No assignment*'}`)
                .join('\n');

        return new EmbedBuilder()
            .setDescription(`### ${run.titleEmoji}\u2002${getDungeonDisplayName(run)}\n` +
                `**Party Leader:** <@${run.partyLeaderId}>`
            )
            .setColor(run.color)
            .setFooter({
                text: 'Crow Control Dungeon Organizer',
                iconURL: 'attachment://cc_logo.webp'
            })
            .setTimestamp()
            .addFields(
                {
                    name: 'Dungeon Start:',
                    value: formatDiscordTime(run.startTime),
                    inline: false
                }
            )
            .addFields(run.description ? [{
                name: 'Description:',
                value: run.description,
                inline: false
            }] : [])
            .addFields({
                name: 'Dungeon Roles:',
                value: rolesOverview,
                inline: false
            });
    }

    getRolesInButtonOrder(run) {
        if (!Array.isArray(run.buttonRows) || run.buttonRows.length === 0) {
            return run.roles;
        }

        const roleByKey = new Map(run.roles.map(role => [role.key, role]));
        const orderedRoles = run.buttonRows.flatMap(row =>
            row.map(roleKey => roleByKey.get(roleKey)).filter(Boolean)
        );
        const orderedKeys = new Set(orderedRoles.map(role => role.key));
        const missingRoles = run.roles.filter(role => !orderedKeys.has(role.key));

        return [...orderedRoles, ...missingRoles];
    }

    buildComponents(run) {
        const roleByKey = new Map(run.roles.map(role => [role.key, role]));
        const buttonRows = Array.isArray(run.buttonRows) && run.buttonRows.length > 0
            ? run.buttonRows
                .map(row => row.map(roleKey => roleByKey.get(roleKey)).filter(Boolean))
                .filter(row => row.length > 0)
            : [run.roles];

        return buttonRows.map(roles => {
            const row = new ActionRowBuilder();

            for (const role of roles) {
                const isClaimed = Boolean(run.assignments[role.key]);

                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`dgn:${run.id}:${role.key}`)
                        .setLabel(role.label)
                        .setEmoji(role.emoji)
                        .setStyle(isClaimed ? ButtonStyle.Danger : ButtonStyle.Success)
                        .setDisabled(run.closed)
                );
            }

            return row;
        });
    }

    getRole(run, roleKey) {
        return run.roles.find(role => role.key === roleKey);
    }

    formatRoleLabel(role) {
        return `${role.emoji} ${role.label}`;
    }

    formatRoleTextList(roles) {
        return roles.map(role => this.formatRoleLabel(role)).join(', ');
    }

    formatDungeonName(run) {
        return `${run.titleEmoji} ${run.dungeonName} Dungeon`;
    }

    getAssignedRoleForUser(run, userId) {
        return run.roles.find(role => run.assignments[role.key] === userId) ?? null;
    }

    getAssignedUserIds(run) {
        return Object.values(run.assignments);
    }

    isFull(run) {
        return run.roles.every(role => Boolean(run.assignments[role.key]));
    }

    plainMemberName(run, userId) {
        const rawName = run.memberNames?.[userId] ?? 'Unknown';
        return `@${rawName.replace(/[`*_~|>]/g, '')}`;
    }

    getAssignedRolesForUser(run, userId) {
        return run.roles.filter(role => run.assignments[role.key] === userId);
    }

    getNotificationMemberOrder(run) {
        const seen = new Set();
        const ordered = [];

        if (run.partyLeaderId) {
            seen.add(run.partyLeaderId);
            ordered.push(run.partyLeaderId);
        }

        for (const userId of run.joinOrder ?? []) {
            if (seen.has(userId)) continue;
            seen.add(userId);
            ordered.push(userId);
        }

        for (const userId of this.getAssignedUserIds(run)) {
            if (seen.has(userId)) continue;
            seen.add(userId);
            ordered.push(userId);
        }

        return ordered;
    }

    formatNotificationMemberLine(run, userId) {
        const selectedRoles = this.getAssignedRolesForUser(run, userId);
        const isPartyLeader = userId === run.partyLeaderId;

        if (isPartyLeader && selectedRoles.length === 0) {
            return `  - ${this.plainMemberName(run, userId)} (Party Leader)`;
        }

        const roleText = selectedRoles.length > 0 ? this.formatRoleTextList(selectedRoles) : 'No selected role';
        const leaderText = isPartyLeader ? 'Party Leader — ' : '';
        return `  - ${this.plainMemberName(run, userId)} (${leaderText}${roleText})`;
    }

    buildJoinNotification(run, memberUser, role, action = 'joined') {
        const memberLines = this.getNotificationMemberOrder(run)
            .map(userId => this.formatNotificationMemberLine(run, userId));
        const memberCount = memberLines.length;
        const claimedRoleCount = this.getAssignedUserIds(run).length;
        const membersLine = run.multipleAssignments
            ? `- **Members:** \`${memberCount}/${run.roles.length}\`  —  **Dungeon Roles:** \`${claimedRoleCount}/${run.roles.length}\``
            : `- **Members:** \`${memberCount}/${run.roles.length}\``;
        const actionEmoji = action === 'left' ? '❌' : '✅';
        const actionText = action === 'left' ? 'left' : 'joined';
        const lines = [
            `**${actionEmoji}  ${this.plainMemberName(run, memberUser.id)} — ${this.formatRoleLabel(role)} — ** ${actionText} your **${this.formatDungeonName(run)}** run, <@${run.partyLeaderId}>`,
            `### ${this.formatDungeonName(run)} Overview:\n`,
            ...(run.multipleAssignments ? ['- **Multiple Assignments:** \`Yes!\`'] : []),
            membersLine,
            ...memberLines
        ];

        if (run.registrationEndTime) {
            lines.push(`- **Registration End:** ${formatDungeonTime(run.registrationEndTime, run.closed)}`);
        }

        if (run.messageUrl) {
            lines.push(`### [Jump to Dungeon Recruitment Panel](${run.messageUrl})  ↗️`);
        }

        return lines.join('\n');
    }

    async sendJoinNotification(run, interaction, role, action = 'joined') {
        if (!run.notificationMode) return;
        if (interaction.user.id === run.partyLeaderId) return;

        const content = this.buildJoinNotification(run, interaction.user, role, action);

        try {
            if (run.notificationMode === NOTIFICATION_MODES.CHANNEL || run.notificationMode === 'channel_hidden') {
                const channel = interaction.channel ?? await interaction.client.channels.fetch(run.channelId).catch(() => null);
                if (!channel?.isTextBased?.()) return;

                await channel.send({
                    content,
                    allowedMentions: { users: [run.partyLeaderId] }
                });
                return;
            }

            const leader = await interaction.client.users.fetch(run.partyLeaderId);
            await leader.send({
                content,
                allowedMentions: { users: [run.partyLeaderId] }
            });
        } catch (err) {
            console.warn(`[CC LOG] Failed to send Dungeon ${action} notification for ${run.dungeonName} (${run.id}):`, err);
        }
    }

    scheduleDeadline(run) {
        if (this.stopped || !run.registrationEndTime || run.closed) return;

        const delay = run.registrationEndTime.getTime() - Date.now();
        if (delay <= 0) {
            this.closeRunAtDeadline(run);
            return;
        }

        const timeoutDelay = Math.min(delay, MAX_TIMEOUT_MS);
        run.deadlineTimeout = setTimeout(() => {
            run.deadlineTimeout = null;
            if (this.stopped) return;
            if (Date.now() >= run.registrationEndTime.getTime()) {
                this.closeRunAtDeadline(run);
            } else {
                this.scheduleDeadline(run);
            }
        }, timeoutDelay);
    }

    closeRunAtDeadline(run, sourceMessage = null) {
        return this.closeRun(run.id, 'deadline', this.client, sourceMessage).catch(err => {
            console.error('[CC LOG] Dungeon deadline close failed:', err);
            if (this.stopped || run.closed || this.activeRuns.get(run.id) !== run) return;

            // A failed local save leaves the run open; retry without a tight timer loop.
            run.deadlineTimeout = setTimeout(() => {
                run.deadlineTimeout = null;
                this.scheduleDeadline(run);
            }, 60_000);
            run.deadlineTimeout.unref?.();
        });
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('dgn:')) return false;

        const [, runId, roleKey] = interaction.customId.split(':');
        const run = this.activeRuns.get(runId);

        if (!run) {
            await interaction.reply({
                content: '### ❌ This dungeon recruitment is no longer active.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        const role = this.getRole(run, roleKey);
        if (!role) {
            await interaction.reply({
                content: '### ❌ This Dungeon role no longer exists.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        if (run.closed) {
            await interaction.reply({
                content: '### ⏳ This dungeon recruitment has already closed.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        return this.queueRunOperation(runId, () => this.handleRunButton(interaction, run, role));
    }

    async queueRunOperation(runId, work) {
        return this.queueRunOperations([runId], work);
    }

    async queueRunOperations(runIds, work) {
        this.runButtonQueues ??= new Map();
        const ids = [...new Set(runIds)];
        const previous = ids.map(id => this.runButtonQueues.get(id) || Promise.resolve());
        const pending = Promise.all(previous.map(operation => operation.catch(() => {}))).then(work);
        for (const id of ids) this.runButtonQueues.set(id, pending);
        try {
            return await pending;
        } finally {
            for (const id of ids) {
                if (this.runButtonQueues.get(id) === pending) this.runButtonQueues.delete(id);
            }
        }
    }

    async handleRunButton(interaction, run, role) {
        // A deadline or another join can close the run while acknowledgement is pending.
        if (this.stopped || run.closed || this.activeRuns.get(run.id) !== run) {
            await interaction.editReply({ content: '### ⏳ This dungeon recruitment has already closed.' });
            return true;
        }

        const claimedBy = run.assignments[role.key];
        const previousState = {
            assignments: { ...run.assignments },
            memberNames: { ...run.memberNames },
            joinOrder: [...(run.joinOrder || [])]
        };
        if (claimedBy === interaction.user.id) {
            run.memberNames ??= {};
            run.memberNames[interaction.user.id] ??= interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
            delete run.assignments[role.key];
            if (!this.getAssignedRoleForUser(run, interaction.user.id)) {
                run.joinOrder = (run.joinOrder ?? []).filter(userId => userId !== interaction.user.id);
            }

            try { await this.saveRuns(); }
            catch (error) { Object.assign(run, previousState); throw error; }

            await this.sendJoinNotification(run, interaction, role, 'left');

            await interaction.message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            });

            await interaction.editReply({
                content: `❌ You have been successfully removed from **${this.formatDungeonName(run)}** with the role: **${this.formatRoleLabel(role)}**.`
            });
            return true;
        }

        if (claimedBy) {
            await interaction.editReply({
                content: `❌ **${this.formatRoleLabel(role)}** has already been claimed by <@${claimedBy}>.`
            });
            return true;
        }

        const existingRole = this.getAssignedRoleForUser(run, interaction.user.id);
        if (!run.multipleAssignments && existingRole) {
            await interaction.editReply({
                content: `❌ You are already assigned to **${this.formatRoleLabel(existingRole)}** in this **${this.formatDungeonName(run)}** run.\n-# Press your current role button to leave before selecting another role.`
            });
            return true;
        }

        run.assignments[role.key] = interaction.user.id;
        run.memberNames ??= {};
        run.memberNames[interaction.user.id] = interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
        run.joinOrder ??= [];
        if (!run.joinOrder.includes(interaction.user.id)) {
            run.joinOrder.push(interaction.user.id);
        }

        try { await this.saveRuns(); }
        catch (error) { Object.assign(run, previousState); throw error; }

        const isNowFull = this.isFull(run);
        await this.sendJoinNotification(run, interaction, role);

        if (isNowFull) {
            await this.closeRunNow(run.id, 'full', interaction.client, interaction.message);
        } else {
            await interaction.message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            });
        }

        await interaction.editReply({
            content:
                `✅ You have been successfully assigned to **${this.formatDungeonName(run)}** with the role: **${this.formatRoleLabel(role)}**.\n` +
                (isNowFull
                    ? '-# This filled the final Dungeon role, so recruitment is now closed.'
                    : '-# Press the button corresponding to your role to be removed from this Dungeon run.')
        });

        return true;
    }

    async closeRun(runId, reason, client, sourceMessage = null) {
        return this.queueRunOperation(runId, () => this.closeRunNow(runId, reason, client, sourceMessage));
    }

    async closeRunNow(runId, reason, client, sourceMessage = null) {
        const run = this.activeRuns.get(runId);
        if (!run || run.closed) return;

        const previousState = {
            closed: run.closed, remindersEnabled: run.remindersEnabled,
            closeReason: run.closeReason, closedAt: run.closedAt, status: run.status
        };
        this.markRunClosed(run, reason);
        try {
            await this.saveRuns(run);
        } catch (error) {
            Object.assign(run, previousState);
            throw error;
        }
        if (run.deadlineTimeout) {
            clearTimeout(run.deadlineTimeout);
            run.deadlineTimeout = null;
        }

        const message = sourceMessage ?? await this.fetchRunMessage(run, client);
        if (message) {
            await message.edit({
                embeds: [this.buildEmbed(run)],
                components: this.buildComponents(run)
            }).catch(err => console.error('[CC LOG] Failed to edit closed dungeon recruitment:', err));
        }

        const channel = message?.channel ?? await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) {
            this.markRunClosed(run, 'missing_message');
            this.activeRuns.delete(runId);
            this.saveRuns(run);
            return;
        }

        const uniqueUserIds = [...new Set(this.getAssignedUserIds(run))];
        const mentions = uniqueUserIds.map(id => `<@${id}>`).join(', ');

        let content;
        if (reason === 'full') {
            content =
                `${mentions}\n` +
                `Recruitment for the ${this.formatDungeonName(run)} has been closed, as all 5 roles have been filled.\n` +
                '- Good luck, and have fun!\u2002<:man_of_culture:1186287184106496112>';
        } else {
            const signedUpCount = this.getAssignedUserIds(run).length;
            content =
                `${mentions ? `${mentions}\n` : ''}` +
                `The recruitment deadline for the ${this.formatDungeonName(run)} has ended, and recruitment is now closed.\n` +
                `${signedUpCount > 0 ? `- Good luck, and have fun!\u2002<:man_of_culture:1186287184106496112>` : ''}`;
        }

        try {
            let existingCloseMessage = null;
            try {
                existingCloseMessage = await findRecentBotMessage(channel, {
                    botUserId: client.user?.id,
                    needles: [
                        `<@${run.partyLeaderId}>`,
                        formatDiscordTime(run.startTime),
                        reason === 'full' ? 'Recruitment for' : 'recruitment deadline'
                    ]
                });
            } catch (err) {
                console.warn(
                    `[CC LOG] Could not check recent Dungeon close messages for run ${run.id}: `
                    + `${err.code || err.message}`
                );
            }

            if (existingCloseMessage) {
                console.log(`[CC LOG] Recovered close notification for Dungeon run ${run.id}; duplicate send skipped.`);
            } else {
                await channel.send({
                    content,
                    embeds: [this.buildCloseOverviewEmbed(run)],
                    files: [createFooterLogoAttachment()],
                    allowedMentions: { users: uniqueUserIds }
                });
            }
        } finally {
            this.activeRuns.delete(runId);
            this.saveRuns(run);
        }
    }

    async fetchRunMessage(run, client) {
        if (!run.messageId) return null;

        const channel = await client.channels.fetch(run.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return null;

        return channel.messages.fetch(run.messageId).catch(() => null);
    }

    async handleMessageCreate(message) {
        if (message.author.bot) return false;

        let handled = false;
        let shouldSave = false;
        const nowMs = Date.now();
        for (const run of this.activeRuns.values()) {
            if (run.closed || run.channelId !== message.channelId) continue;
            if (!this.isReminderWindowOpen(run, nowMs)) {
                if (run.remindersEnabled !== false) {
                    run.remindersEnabled = false;
                    shouldSave = true;
                }
                continue;
            }
            if (run.remindersEnabled === false) continue;

            handled = true;
            run.reminderCounter += 1;
            shouldSave = true;

            if (run.reminderCounter % 10 === 0 && run.messageUrl) {
                await message.channel.send({
                    content:
                        `## Recruitment for ${this.formatDungeonName(run)} is still open!\n` +
                        `- [Jump to Dungeon Recruitment](${run.messageUrl})`
                });
            }
        }

        if (shouldSave) this.saveRuns();
        return handled;
    }
}

module.exports = DungeonRecruitment;
