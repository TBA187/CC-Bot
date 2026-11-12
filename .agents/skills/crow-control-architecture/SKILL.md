---
name: crow-control-architecture
description: Map of the Crow Control codebase and how its main flows fit together (startup, shutdown, stores, background monitors, interaction routing, alerts, database, OCR). Use to find where something lives, to understand a flow end to end, or to orient before changing unfamiliar code.
---

# Crow Control architecture

`docs/operations.md` describes behavior, configuration and recovery from the operator's side. This skill maps that behavior to the code. Confirm details in the code before relying on them; module names and sizes change over time.

## Startup and shutdown

- `index.js` loads `.env`, reads `config.json`, sets `process.env.TZ` from `botTimezone` (fallback `Etc/UTC`), installs runtime logging, then calls `createBotApplication(...)` and `start()`.
- `app/createBotApplication.js` builds everything one instance needs: the discord.js `Client` (intents, partials, REST through `utils/discordTransport.js`), every store and monitor, `ScoutServerRegistry`, `DiscordDiagnosticLogger`, `InteractionDiagnostics`, and the `commandConfig` object shared by commands and event modules. It exits when `TOKEN` or `CLIENT_ID` is missing.
- `app/BotApplication.js`:
  - `bootstrap()` waits for `db.initPromise` (and continues without MySQL), restores state through `startupStep` (guild settings, XP recovery, PvP King Gold and Silver, giveaways, notifications, member audit history), preloads XP tracks, scout autocomplete and player server preferences with short deadlines (`lifecycle.preload`), loads commands and events, registers guild commands, registers events, then logs in.
  - `onReady()` starts diagnostics, runtime health, the REST warm-up, the sync loops (PvP King, notifications, XP, guild settings), the giveaway loop, the guild-application, shop and auction monitors, scouting ingestion, the profile cache, the PvP cooldown notifier and the PRO game-event reminders.
  - `stopAndExit()` aborts the startup lifecycle, runs every stop function independently (one failure does not skip the rest), clears PvP challenge timers, flushes the scout audit log (2 s), waits for cleanup (3 s), closes the MySQL pool (2 s) and exits.
- `utils/abortable.js` provides `StartupLifecycle` (`run`, `preload`, `check`, `signal`), `abortable`, `abortableDelay` and `shutdownError()` (`code: 'BOT_SHUTTING_DOWN'`).

## Where things live

| Area | Code |
| --- | --- |
| Wiring | `app/`: `createBotApplication.js`, `BotApplication.js`, `moduleLoader.js` (command and event discovery), `interactionRouter.js` (autocomplete, buttons, selects, modals, context menus and slash commands), `CommandCooldowns.js`. See the `discord-command` skill. |
| PvP King | `commands/pvp-king/` (challenge, crown, reverse, cooldown, event, history, leaderboard, stats and help commands) and `commands/pvp-king/utils/`: `pvpServers.js` (Gold and Silver routing to storage, roles and channels), `pvpKingStorage.js` (per-server storage with JSON operations replayed to MySQL), `pvpEvent.js`, `pvpHelper.js`, `pvpHistoryMessages.js`. `tasks/cooldownNotifier.js` sends cooldown-expiry notifications. |
| PvP scouting | `features/pvp-scouting/`, `events/pvpScouting.js`, `events/scoutRoster.js`, `commands/scout*.js`. See the `pvp-scouting` skill. |
| PRO auctions | `features/auctions/`. See the `pro-auctions` skill. |
| Guild applications | `features/guild-applications/`: `GuildApplicationMonitor.js`, `forum/ProForumClient.js`, `parsing/` (parser, trainer-card OCR, country names), `storage/GuildApplicationStore.js` (MySQL with a JSON fallback), `discord/` (Officer notice and Court House poll, vote reminders, owner review alerts, staff filter). |
| Forum shops | `features/tba-forum-shops/`: topic client, monitor, store (MySQL checkpoints with a JSON mirror) and owner DM notifier. |
| Giveaways | `commands/giveaways.js`; `events/giveaways.js` (store factory, entries, serialized draws, delivery recovery and `startGiveawayLoop`). |
| XP and levels | `utils/xp*.js` (`xpStore.js` durable queue with SQL receipts, `xpEngine.js` awards and role rewards, `xpDbHelper.js` reads), `events/levels/` (message, reaction, voice and command XP), `commands/levels/`, `config/xpConfig.js`, `features/levels/presentation.js`. |
| Game-event reminders | `tasks/proNotifications.js` (fixed UTC schedules), `features/pro-notifications/` (store and catalog), `commands/notifications.js`, and the notification settings in `commands/admin.js`. |
| Message builder | `commands/send_message.js`, `commands/edit_bot_msg.js`, `features/message-builder/` (`draft.js`, `editor.js`, `permissions.js`). |
| Guild settings | `features/guild-settings/GuildSettingsStore.js` (cached settings, MySQL sync and JSON mirror) and `commands/cc-settings.js`. |
| Audit logs | Logging modules in `events/` (channels, threads, invites, integrations, roles, members, voice, boosts), `utils/memberAuditHistory.js`, `utils/memberAuditEmbeds.js`, `utils/logHelpers.js`, `utils/roleAuditSource.js`. |
| Roles | `commands/auto_roles.js` and `events/auto_roles.js` (self-role panels), `utils/serverTagRoleManager.js` (Crow Control server-tag role). |
| Dungeon recruitment | `commands/dungeon_recruitment.js` (recruitment state in `data/dungeon_runs.json`) and `events/dungeonRecruitmentReminder.js`. |
| Runtime | `utils/runtimeLogging.js` and `utils/logFiles.js` (monthly logs), `utils/discordTransport.js` (REST requests and warm-up), `utils/interactionDiagnostics.js`, `utils/runtimeHealth.js` and `utils/containerMemory.js` (memory pressure lines, plus a log-only summary 15 minutes after start and every 6 hours), `utils/runtimeActivity.js` (job names shown in memory reports). |
| OCR | `utils/runtimeMemoryOcr.js` (shared queue, `sharedOcrWorkerPool`, `ocrWorkerPoolFor`; `run(task, { label })` names the running job, for example "OCR: PvP Scout Gold"), `utils/ocrProcessWorker.js` and `utils/ocrProcessEntry.js` (helper process). Used by scouting and guild applications. |
| Forum helpers | `utils/forumRetry.js` (`forumRetryDelay`, `parseRetryAfter`), `utils/forumPagination.js`, `utils/readResponseBuffer.js` (size-capped bodies), `utils/networkErrors.js`, `utils/discordMessageHistory.js` (finds earlier bot messages so retries do not post twice). |

## Patterns

- **Configuration.** Guild, channel and role IDs and feature settings live in `config.json` (`appConfig`). Credentials and host switches (`TOKEN`, `CLIENT_ID`, `DB_*`, `STORAGE_MODE`, presence settings) live in `.env`. Discord IDs stay strings everywhere.
- **commandConfig.** One object built in `createBotApplication.js` holds the client, `db`, `shutdownSignal`, role and channel IDs, stores, `scoutServers`, `onCooldown` and `commandMap`. Commands receive it in their constructor; event modules receive it as the last `execute` argument or in `register(client, config)`.
- **Database.** `db/db-conn.js` exports one mysql2 pool with a retrying `query`, a health-tracked `getConnection`, `initPromise`, `hasRequiredConfig`, `isDatabaseUnavailableError` and `health`. It uses `DB_CONNECTION_LIMIT` connections (default 1) and returns big numbers as strings. It sets no `timezone` option, so mysql2 converts `Date` values using the process timezone from `botTimezone`. With `STORAGE_MODE=json` it skips the startup connection check.
- **Stores.** Most stores restore state at startup, keep a JSON recovery file under `data/` written with `utils/jsonFile.js`, and run a sync loop that replays pending operations to MySQL. `STORAGE_MODE` (`auto`, `mysql`, `json`) selects the behavior per feature. Several stores create their tables at runtime; scouting reads its table definitions from `sql/create_pvp_scout_tables.sql`.
- **Monitors.** The forum monitors share one shape: `start()` and `stop()`, a silent baseline instead of historical alerts, backoff with `forumRetryDelay`, fixed outage and recovery log messages, and `runtimeActivity.begin(...)` around each pass.
- **Gold and Silver.** PvP King routes through `commands/pvp-king/utils/pvpServers.js` with separate `pvpKingStores` and `pvpChallengeTimeouts`. Scouting routes through `ScoutServerRegistry` (`get(server)`, `forChannel(channelId)`). Each server has its own channel, storage, roles and history thread.
- **Access.** Staff checks compare member roles with `leaderRoleID`, `adminRoleID` and `officerRoleID` in code. Owner-only alerts and shop notifications go to `ownerID`.
- **Time.** Stored instants are UTC (ISO strings or `datetime(3)` columns). Discord displays use `<t:seconds:...>`.

## Alerts

`DiscordDiagnosticLogger` in `utils/discordDiagnostics.js` wraps `console.log`, `console.warn` and `console.error`, and posts alerts to `logChannelID` through `ScoutAuditLogger.diagnostic`, mentioning `ownerID`:

- Every `console.warn` and `console.error` becomes an alert, with secrets redacted and repeats grouped for 5 minutes, unless it matches a status event or a console-only rule.
- `STATUS_EVENTS` pairs a warning pattern with a recovery pattern for each subsystem (forum monitors, MySQL stores, gateway, command registration, memory). A matching warning opens an incident that alerts only after its delay (forum outages 10 minutes, gateway and memory pressure 1 minute, most others 5 minutes, storage failures immediately). A matching `console.log` recovery replies to the alert. All `database:*` keys share one MySQL incident.
- Corrupt-data messages, and errors with `JSON_STORE_CORRUPT`, `ENOSPC`, `EROFS` or `EIO`, alert immediately even when they match a status event.
- Changing a monitored log message changes alerting. Update `STATUS_EVENTS` and `test/discordDiagnostics.test.js` together.

## Scripts

`scripts/` holds manual tools that run separately from the bot: the guild-application and forum-shop notification previews (their delivery modes publish to Discord), a Discord network diagnostic, and an OCR memory measurement. Read each script's options before running it; `docs/operations.md` covers the preview and OCR measurement commands.
