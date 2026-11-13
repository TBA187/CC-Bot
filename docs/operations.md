# Operations and configuration

[Return to the README](../README.md).

## Storage and database recovery

Database credentials belong in `.env`; server and feature configuration belongs in [config.json](../config.json). Apply the relevant schemas from [sql/](../sql/) before enabling a feature.

| `STORAGE_MODE` | Behavior |
| --- | --- |
| `auto` | Use MySQL when available; features with JSON recovery support save locally during outages and synchronize on recovery. |
| `mysql` | Prefer MySQL, retaining JSON recovery for features that support it. |
| `json` | Use local JSON in features that support this mode, without synchronizing their state to MySQL. |

JSON mode does not provide a complete database replacement. Scouting uses MySQL, and rank/leaderboard queries need verified database totals. Pending XP awards and activity counters are persisted before database writes and replayed after recovery; SQL receipts prevent an uncertain retry from applying the same operation twice.

Optional database connection settings:

| Environment variable | Default |
| --- | --- |
| `DB_CONNECT_TIMEOUT_MS` | `10000` |
| `DB_KEEPALIVE_DELAY_MS` | `30000` |
| `DB_RETRY_COOLDOWN_MS` | `5000` |
| `DB_RETRY_MAX_COOLDOWN_MS` | `60000` |
| `DB_STATUS_LOG_INTERVAL_MS` | `300000` |

Shared connection retry backoff limits repeated connection attempts during outages. Recovery-capable features retain their pending writes until synchronization succeeds.

An unreadable guild-settings, dungeon or notification recovery file is preserved with a `.corrupt-*` suffix and is not reset to empty state. Resolve the file error or restore a verified backup before restarting. Pending local updates must be retained when repairing a file.

## Server configuration

| Configuration | Purpose |
| --- | --- |
| `guildId`, `botTimezone` | Command-registration guild and calendar timezone. The current timezone is `Etc/UTC`. |
| `leaderRoleID`, `adminRoleID`, `officerRoleID` | Staff access to message editing, scouting review and other administration tools. |
| `goldRoleID`, `silverRoleID` | Game-server selection roles. |
| `logChannelID`, `ignoredLogChannels` | Audit destination and channels excluded from applicable audit delivery. |
| `blockedEditBotMsgChannels` | Channels where bot-message editing is blocked. |
| `pvpScoutingGoldChannelID`, `pvpScoutingSilverChannelID` | Separate scout-report source channels. |
| `pvpKingChannelID`, `pvpKingRoleID`, `historyThreadID` | Gold PvP King channel, crown role and history destination. |
| `pvpKingSilverChannelID`, `pvpKingSilverRoleID`, `historySilverThreadID` | Silver PvP King channel, crown role and history destination. |
| `dungeonChannelID`, `dungeonRoleID`, `giveawayChannelID` | Recruitment and giveaway destinations. |
| `officerChannelID`, `courtHouseChannelID` | Guild application alerts and voting polls. |
| `auctionChannelID` | Channel for PRO Trade Zone Auction listings and their updates. |
| `ownerID` | Owner-only forum review alerts and shop notifications. |
| `brandingImageURL` | Crow Control banner image URL hosted online. |

The invoking PvP King channel selects the corresponding crown, challenge state, history and notifications. Message-builder previews remain private until the owner confirms sending or saving.

## PvP King events

Configure events under `pvpKingEvents.gold` or `pvpKingEvents.silver`, then restart the bot. Each server has its own winner, streak requirement and reward.

Example value for `pvpKingEvents`:

```json
{
  "gold": {
    "enabled": true,
    "id": "gold-winter-2026",
    "name": "Gold Winter PvP King Challenge",
    "startDate": "2026-11-01T00:00:00Z",
    "endDate": null,
    "targetStreak": 10,
    "rewardCoinCapsules": 3,
    "announcementChannelID": "YOUR_ANNOUNCEMENT_CHANNEL_ID",
    "mentionEveryone": false
  },
  "silver": null
}
```

Use a stable, unique event ID. `/pvp_event` displays progress and finished results. `/pvp_crown` announces a winner and uses the event ID to recognize an existing announcement after a restart.

## Forum monitors and scouting

Guild applications use `forumGuildApplicationPage` and are checked every ten minutes. The initial scan establishes a baseline; later valid applications notify Officers and can create a 24-hour Court House poll. Voting reminders occur after 12 and 18 hours when fewer than half of current Officers have voted. Configure `forumGuildApplicationCooldownHours` to filter repeat applicants; `0` disables that filtering. Apply [the application schema](../sql/create_guild_applications_table.sql) before enabling the monitor.

Forum shop notifications use `tbaProForumShop`, `tbaProDungeonShop` and `tbaProForumNotifications` (`1` enables delivery, `0` disables it). The monitors check every twelve minutes, establish a silent initial baseline and share processed-post checkpoints through MySQL. New replies are sent to `ownerID`.

The PRO Auction Trade Zone monitor uses `auctionChannelID` and checks the first active and inactive listing pages for new auctions about every 90 seconds; each scan attempts up to five announcements. The first start with empty storage records a silent baseline. After a restart, the ten newest auctions posted while the bot was offline are announced and older ones are skipped.
Announcements follow the listing: the pages holding auctions announced in the last seven days are read every ten minutes and every active page once a day, and only auctions whose listing card changed or that left the listing are opened. Followed auctions are checked about every 90 seconds, auctions with a countdown shortly after it ends, and every auction at least every six hours (weekly once it is older than seven days).
Auction records leave storage 30 days after the auction ends or its forum page disappears; the Discord posts stay, and their buttons then point to the forum page. The monitor keeps a local recovery file and synchronizes its state to MySQL unless `STORAGE_MODE=json`.

Members can follow multiple auctions to receive DMs for new valid bids detected after subscribing. Rapid bids for the same auction within a 90-second burst are grouped into one DM showing the newest five, with a Bid History button when the group contains more than five bids; different auctions stay separate. DM Notifications stop when the auction ends or the user unfollows. Subscriptions in the database are removed when the auction ends, and are also removed for a member when Discord reports that their DMs are unavailable.

Scout reports that fail validation receive correction suggestions and a one-hour correction window before staff escalation. Correction deadlines survive restarts. Officers can already review such a report with `/scout-review` while its window is open; the panel shows a warning, and a decision closes the window. Gold and Silver reports remain in separate archives; Cross Server searches read both. The saved autocomplete snapshots can be rebuilt from the database.

Members can edit their own scout messages during the first 48 hours after posting; each linked follow-up has its own 48-hour window. Afterwards, small updates such as an added move or a spelling fix still apply automatically. Edits to reports an officer confirmed or corrected also apply, keeping the officer's values for everything the edit did not change. Edits are validated and logged in the scout log channel. Officer approval is required for larger rewrites after the deadline, for reports an officer locked, declined or edited in `/scout-settings`, and for edits that replace a published report with off-topic text or remove its opponent and team.

When a message of a report shown in `/scout` is deleted while the bot is online, the report leaves `/scout` and the officer channel receives an alert with the report, a copy of its screenshot and four actions: **Keep** restores it, **Keep & repost** also posts a credited copy in the scouting channel, **Remove** leaves it out, and **Edit** changes its details first.

One message can hold several reports. Each report starts with the opponent's IGN on its own line after an empty line or divider (or with a `name:`/`IGN:` label, bold text or a rating) and is followed by its team; every report is saved separately, also when the same opponent appears twice with a different team, and an exact repeat is saved once. The reports share the message's reaction, and a screenshot stays with the first report. A report after the first has the ID `<message ID>_<number>`.

Separate battle reports keep their own dates, ratings and IDs, even when the same member scouts the same opponent a few minutes apart. Replies and nameless continuations combine observations into one team with at most six Pokémon; newer items, abilities and natures replace older observations, and discovered moves are combined. Original sources and reply links remain available. Excess Pokémon in a manually linked report trigger a source-review notice without deleting stored information.

A guild-application preview is available without Discord delivery:

```sh
node scripts/test_guild_application_notification.js
```

The script's `--send` and other `--send-*` modes publish previews to its configured test destinations. Review the options in [the script](../scripts/test_guild_application_notification.js) before using a delivery mode.

## Runtime files and backups

Stop the old bot instance before moving hosts. Back up MySQL and preserve the feature state below, particularly pending updates that have not reached the database.

| Path under `data/` | Purpose |
| --- | --- |
| `dungeon_runs.json` | Dungeon recovery state. |
| `pvp_king_data.json`, `pvp_king_silver_data.json` | Gold and Silver PvP King recovery state. |
| `giveaways.json` | Giveaway metadata, entries, draw history and pending updates. |
| `xp_pending.json` | Pending XP/activity operations and saved special-track settings. Copy pending operations before starting a replacement host. |
| `guild_settings.json` | Guild settings recovery mirror. |
| `notifications.json` | Subscription settings and recovery state. |
| `guild_applications.json` | Forum scan checkpoint, application records and pending delivery state. |
| `tba_forum_shops.json` | Forum shop recovery checkpoints. |
| `forum_auctions.json` | Pending auction database operations and any outage snapshot; full auction state when using JSON-only storage. Do not switch a healthy MySQL journal to JSON-only mode without first exporting a full snapshot. |
| `scout-autocomplete-cache.json`, `scout-autocomplete-silver-cache.json` | Rebuildable Gold and Silver search indexes. |
| `tesseract-cache/` | Reusable OCR language data. |
| `logs/cc-YYYY-MM.log` | Runtime diagnostic output. |

Runtime state files are ignored by Git; bundled reference data under `data/` is tracked. Avoid editing state files while the bot is running.

## Runtime logs

Standard output, errors and full stack traces are appended to UTF-8 monthly files. Log entries use UTC timestamps. Monthly filename rollover follows `botTimezone`.

Maintenance runs at startup, rollover and every hour. Defaults retain the newest 12 matching monthly files, including the active month. Completed months are removed oldest first when matching logs exceed 100 MiB or free disk space falls below 100 MiB; low-space recovery targets 150 MiB free. The active monthly file is always retained.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `BOT_LOG_PATH` | `data/logs/cc.log` | Base filename; `-YYYY-MM` is inserted before the extension. |
| `BOT_LOG_RETENTION_MONTHS` | `12` | Maximum retained monthly files, including the active file. |
| `BOT_LOG_MAX_TOTAL_MIB` | `100` | Matching log storage cap; `0` disables the cap. |
| `BOT_LOG_MIN_FREE_MIB` | `100` | Low-free-space cleanup trigger; `0` disables it. |
| `BOT_LOG_CLEANUP_TARGET_FREE_MIB` | `150` | Cleanup target, never lower than the trigger threshold. |

Invalid values use defaults. Retention is at least one file; storage values are at least zero. Unrelated files are left alone. If file logging is unavailable, console logging continues.

## Discord diagnostic alerts

Bot warnings and errors use the existing `logChannelID` and mention `ownerID`. Confirmed recovery replies to the original alert without another mention.
Console and monthly logs record failures immediately; Discord waits for persistent service outages:

| Problem | Discord alert timing |
| --- | --- |
| JSON save failures, corrupted data, unexpected errors, failed background jobs | Immediately |
| MySQL outages and feature storage fallbacks, Discord REST warmup, CC tag verification, command registration, unavailable container memory accounting | After 5 minutes |
| PRO forum outages, including application and shop scans | After 10 minutes |
| Discord Gateway disconnection | After 1 minute |
| Memory pressure | After 1 minute |

Memory monitoring logs pressure, recovery and changes in container accounting, plus a memory summary 15 minutes after start and every 6 hours in the console and monthly log only. Warning and critical thresholds are 80% and 90%; recovery is below 75%. Sustained pressure is logged at most every 10 minutes unless severity increases.

Alerts contain fixed summaries rather than raw exceptions, credentials, SQL or payment details. Alert delivery is separate from commands and uses bounded in-memory incident tracking with retry delays. Incident tracking resets when the process restarts; a stopped process cannot send an alert.
Routine reconnects, successful operations and normal cleanup remain in console/file logs.

## OCR memory lifecycle

Gold, Silver, and guild-application OCR use a shared queue and a lazily started helper process. The helper handles image downloading, preparation, and recognition using consistent Tesseract settings and parsing logic.
- Automatically exits after 5 minutes of inactivity, 20 completed image jobs, or a process failure.
- Releases native memory when exiting and restarts when needed.
- Bot shutdown waits for active jobs and helper termination. The helper also exits if its parent process dies.
- On Linux, memory usage is checked between jobs, with a threshold of 85% of the available memory limit, capped at 512 MiB (~435 MiB threshold).
- When usage exceeds the threshold, the helper is released. If memory remains high, processing waits up to 5 seconds before continuing.
- Active jobs are never interrupted or rejected due to memory usage.
- Normal jobs have no intentional delay. Helper recycling limits retained memory but does not guarantee a fixed memory ceiling.
- If container memory metrics are unavailable, pressure checks fall back to process RSS estimates; idle and batch recycling remain active.
- The helper uses MALLOC_ARENA_MAX=2 unless configured by the host.
- On Linux/glibc, setting this variable before Node starts can also reduce memory fragmentation in the main process. See [Sharp's memory guidance](https://sharp.pixelplumbing.com/performance/).
- Memory pressure logs include process memory and OCR activity. Container memory also includes the helper and file cache.
Requires data/tesseract-cache/eng.traineddata:
```
node --expose-gc scripts/measure_ocr_memory.js --isolated
```
Runs five 1080p OCR cycles, measuring parent and helper memory without Discord, MySQL, or language-data downloads. Windows can verify process behavior, while Linux is required for representative allocator measurements.
