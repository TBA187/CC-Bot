---
name: wire-bot-feature
description: Checklist for connecting a new feature, store, monitor, background loop, setting or database table to the Crow Control bot (config.json, .env.example, app/createBotApplication.js, app/BotApplication.js, SQL schema, .gitignore, docs and lifecycle tests). Use when adding a new monitor, background task, store, runtime file, configuration key or database table.
---

# Wiring a feature into the bot

New features touch several shared files. Missing one usually shows up only after a restart, an outage or a shutdown, so go through every item that applies. For commands, buttons, menus, modals and event modules, also follow the `discord-command` skill.

## Settings

- Guild, channel and role IDs and feature switches belong in `config.json`, which is tracked and read once at startup as `appConfig`. Nothing validates its keys, so a missing key is `undefined`. A feature that is not configured should disable itself instead of failing startup, as `createAuctionMonitor` does (`enabled: Boolean(config.auctionChannelID)`) and the shop monitor does (empty topic URLs are skipped).
- Credentials and host-specific switches belong in `.env`. Add new variables to `.env.example` without real values, read them from `process.env` with a safe default, and never log them. `createBotApplication` redacts environment values whose names contain `TOKEN`, `PASSWORD`, `SECRET` or `API_KEY` from Discord alerts, so name secrets accordingly.
- Monitors receive the whole `appConfig`. Commands and events only see the keys copied into `commandConfig` in `app/createBotApplication.js`; add new keys there when a command or event needs them.
- Add a row to the "Server configuration" table in `docs/operations.md` when operators must set the value.

## Stores and runtime files

- Follow an existing store with the same needs: `features/guild-settings/GuildSettingsStore.js` (cached settings with a sync loop), `features/pro-notifications/NotificationStore.js`, `commands/pvp-king/utils/pvpKingStorage.js` (per-server JSON operations replayed to MySQL), `utils/xpStore.js` (durable queue with SQL receipts) or `features/auctions/AuctionStore.js` (operation journal with revisions).
- Accept `db`, the data file path and `storageMode` in the constructor, build paths with `path.join(rootPath, 'data', '<file>.json')`, and let tests inject temporary paths. Honor `STORAGE_MODE`: `auto` and `mysql` keep JSON recovery, `json` does not synchronize to MySQL. Use `db.hasRequiredConfig` to detect missing credentials.
- Read and write recovery files with `utils/jsonFile.js`. `readJsonObject` preserves an invalid file as `.corrupt-*` and throws `JSON_STORE_CORRUPT`; `writeJsonIfChanged` replaces atomically through a `.tmp` file. Never replace unreadable state with defaults.
- Save pending work locally before the MySQL write, clear it only after confirmed success, and give operations stable IDs so a retry after an uncertain timeout cannot apply twice.
- `.gitignore` lists runtime files one by one. Add `data/<file>.json`, `data/<file>.json.tmp` and `data/<file>.json.corrupt-*`, or the new state file will be committed.
- Add the file to the "Runtime files and backups" table in `docs/operations.md` and state whether it holds pending work.

## Database tables

- Add `sql/create_<feature>_tables.sql` with `CREATE TABLE IF NOT EXISTS`, InnoDB and `utf8mb4`, matching the existing schema files. Store Discord IDs as `VARCHAR` strings. The existing schemas use MariaDB syntax such as `json_valid` checks.
- When the store also creates tables at runtime (`schemaStatements()` in `AuctionSqlRepository.js`, or `ensureScoutTables` reading `sql/create_pvp_scout_tables.sql`), keep both definitions identical. `CREATE TABLE IF NOT EXISTS` never changes an existing table; a column change needs an explicit migration that keeps existing rows.
- Pass every value as a parameter. Build dynamic table or column names only from fixed mappings, like `specs` in `AuctionSqlRepository.js`.
- The pool in `db/db-conn.js` uses `DB_CONNECTION_LIMIT` connections, default 1. Inside a transaction, use only the transaction's connection: a `db.query` call while that connection is held waits for it and never completes. Always `release()` connections and roll back on errors.
- `docs/operations.md` tells operators to apply the relevant schemas before enabling a feature; mention the new file where the feature is described.

## Startup, background work and shutdown

- Construct the store or monitor in `app/createBotApplication.js` and pass it in the `new BotApplication({ ... })` context so `BotApplication` can start and stop it.
- Restore durable state in `bootstrap()` with `this.startupStep('<label>', () => store.restore())`; it blocks login until loaded and aborts on shutdown. Optional caches use `lifecycle.preload(...)` with a `timeoutCode`, `onTimeout` and `onError`, and must not block startup.
- Start loops and monitors in `onReady()`, and catch the start promise there like the existing monitors do. `ClientReady` is registered with `client.once`, so `onReady` runs once per process and reconnects do not repeat it; `start()` should still ignore a second call.
- Add a matching call in `stopAndExit()` through `stop(() => feature.stop())`. Stop must set a stopped flag, clear timers, abort in-flight requests and wait for the running pass. A pass that finishes after stop must not schedule another timer (see the `generation` checks in `AuctionMonitor.schedule`).
- Long timers call `.unref?.()`. Wrap each background pass in `runtimeActivity.begin('<name>')` and call the returned function when the pass ends.
- Commands with long-lived state can expose `stop()`; `stopAndExit` calls `stop?.()` on every loaded command.

## Discord alerts

`utils/discordDiagnostics.js` turns console output into staff alerts in `logChannelID`. Without these steps a new feature either pings staff for routine events or fails silently:

- Every `console.warn` and `console.error` becomes an immediate alert (repeats grouped for 5 minutes). Use `console.log` for expected conditions such as a single unavailable item.
- For outages that should alert only when they persist, log one fixed warning when the outage starts and one fixed `console.log` recovery when it ends, and add both patterns to `STATUS_EVENTS`. The key prefix sets the delay: `forum:` waits 10 minutes, `database:` 5 minutes (all `database:*` keys share one MySQL incident), `storage:` alerts immediately, and other keys 5 minutes, except `discord:gateway` and `runtime:memory-pressure` (1 minute).
- Messages about corrupt data, or errors with `JSON_STORE_CORRUPT`, `ENOSPC`, `EROFS` or `EIO`, alert immediately even when they match a status event.
- Use the `[CC LOG]` prefix and cover new status events in `test/discordDiagnostics.test.js`.

## Test doubles

- `test/botBootstrapShutdown.test.js` runs `index.js` in a VM with a fixed `imports` map. Any new `require` in `index.js`, `app/createBotApplication.js` or `app/BotApplication.js` fails with `Unexpected startup import` until a fake is added to that map. Give the fake every method startup and shutdown call (`restore`, `startSyncLoop`, `stopSyncLoop`, `start`, `stop`).
- Feature tests inject `db`, `fetch`, clocks, file paths and Discord clients. A constructor must not contact the network or read real files under `data/`.

## Checks

```sh
node --test test/applicationModules.test.js test/botBootstrapShutdown.test.js test/startupShutdown.test.js test/discordDiagnostics.test.js
```

Then run the feature's own tests and the full suite (see the `validate-changes` skill).
