---
name: pro-auctions
description: Architecture, invariants and tests for the PRO Trade Zone auction feature in features/auctions/. Use when reading, changing, debugging or finishing the auction monitor, auction announcements, follow/unfollow buttons, bid DMs, the auction store or its MySQL tables.
---

# PRO Trade Zone auctions

The auction feature watches the Pokémon Revolution Online Trade Zone (`https://pokemonrevolution.net/forum/trade/`), posts one announcement per new auction in `auctionChannelID`, keeps those announcements updated, and sends DMs to members who follow an auction when new valid bids appear. It is separate from the guild-application and forum-shop monitors, and it is disabled when `auctionChannelID` is unset.

The code uses its own conventions: camelCase state keys (`messageId`, `seenBids`), clocks in Unix milliseconds (`clock()`), stored times as ISO strings, and auction and Discord IDs as digit strings compared with `BigInt` when order matters. Keep them consistent so stored state and helpers agree.

Both listings grow over time: an auction without bids stays active until someone bids, which can be months later, and the inactive listing keeps every finished auction. Never make work depend on a listing's total page count.

## Module map

| File | Responsibility |
| --- | --- |
| `index.js` | `createAuctionMonitor({ client, db, config, rootPath, storageMode })` builds the store (`data/forum_auctions.json`), notifier, monitor (enabled only when `config.auctionChannelID` is set) and `monitor.followService`. |
| `AuctionStatus.js` | `active()` (`Active` or `Instant Price`, and not `sourceUnavailable`) and `ended()` (inactive, ended, closed, sold, completed, expired, cancelled). The forum shows `Active` and `Ended`. |
| `AuctionBids.js` | `bidKey` (SHA-256 of bidder URL or lowercased name, amount without separators, time and bid/offer kind), `bidTimestamp` (forum `YYYY-MM-DD HH:MM:SS` read as UTC), `notificationKey`, `burstGroups` (90-second groups; bids and price offers stay apart). |
| `AuctionForumClient.js` | `AuctionForumClient`: requests limited to the forum origin (manual redirects, at most 3; 4 MiB HTML cap; 15-second timeout; HTML content type only; `Retry-After`), `parseListing` (IDs plus a card `signature`) and `parseAuction`. Throws `AuctionForumRequestError` with `code` (`HTTP_<status>`, `ETIMEDOUT` or a network code), `status` and `retryAfterMs`. |
| `AuctionMonitor.js` | `AuctionMonitor`: scheduling, discovery scans, restart catch-up, the listing sweep and refresh schedule, retention cleanup, announcement delivery, per-item and whole-run backoff, and the shared forum request queue. |
| `AuctionFollowService.js` | `AuctionFollowService` (`follow`, `unfollow`, `observe`, `pause`, `cleanupEnded`, `drain`) and `validFollowState`. |
| `AuctionStore.js` | `AuctionStore`: copy-on-write updates, cheap reads, JSON-only mode, MySQL mode with a local operation journal and replay, and receipt pruning. |
| `AuctionSqlRepository.js` | `AuctionSqlRepository`: flattens state into rows, revision-checked transactional `apply` with operation receipts, `load`, `pruneReceipts`, and runtime `ensureSchema`. Also exports `changesBetween`, `projectOperation` and `operationHash`. |
| `AuctionDiscord.js` | Announcement and DM payload builders, private pages (images, bids, description, payment), `handleAuctionButton`, `temporaryAuctionFailure`, and `AuctionDiscordNotifier` (`send`, `edit`, `sendBidUpdate`, duplicate search). |
| `sql/create_forum_auction_tables.sql` | `forum_auction_control` (with `applied_at`), `forum_auctions`, `forum_auction_subscriptions`, `forum_auction_outbox`. `schemaStatements()` creates the same tables at runtime; keep both definitions identical (covered by `test/auctionSqlRepository.test.js`). |

Wiring: `app/createBotApplication.js` creates the monitor, `app/BotApplication.js` starts it in `onReady` and stops it in `stopAndExit`, and `app/interactionRouter.js` sends every `auction:` button to `handleAuctionButton` with `getAuctionRecord`, `channelId: appConfig.auctionChannelID`, `guildId` and `followService`. The notifier receives the whole `config.json`: `proAuctionsRoleID` is pinged on new announcements and `selfRoleChannelID` appears in the role instructions. Operator guidance is in the "Forum monitors and scouting" section of `docs/operations.md`.

## Parsing rules

- A listing page must contain `.proAuctionList`; otherwise it throws `PRO auction listing was not recognized (page title: "…")`, with the cleaned page title (at most 120 characters) or `missing`.
- Every direct `.ipsData__item` child needs a link to `https://pokemonrevolution.net/forum/trade/<id>/` or `/forum/trade/<id>-slug/`. The title link is preferred; any other link in the card is accepted. A card without one fails the page with `PRO auction listing contains an unreadable entry.`
- Each card also returns `signature`: 16 hex characters of SHA-256 over the card text without the view counter (`.proAuctionListViews`) and with the ticking `.proAuctionTimer` text replaced by its `data-proauction-countdown` value. Bids, offer, prices, status, title and end time change it; views and the passing countdown do not.
- Pagination comes from the first `.ipsPagination[data-pages]` (default 1). The total page count is never a limit by itself; discovery fails only when it would have to read more than 1,000 new pages, or when a later page is empty or an entry has a higher ID than the one before it (`ordering changed; checkpoint retained`).
- An auction page needs `.proAuctionViewHeader` with an `h1` title and at least one `.proAuctionHeader .ipsBadge`, plus `.proAuctionPanel__grid` and `.proAuctionHistory`. The seller must be readable and every bid row needs a bidder and an amount. The first badge is the status; a `Gold`, `Silver` or `Cross-Server` badge is the server.
- `endsAt` comes from `data-proauction-countdown` (Unix seconds). Auctions without bids show "Countdown starts with the first qualifying bid." and have no `endsAt`. `endedAt` and the final amount come from the `Auction Ended:` or `Instant Price Purchased:` notice (`YYYY-MM-DD h:mm AM/PM UTC`).
- Images are collected in page order from `.proAuctionAttachments a.proAuctionAttachment[href]` and `.ipsRichText--user img`, without duplicates. The first image is the announcement image. A bid is invalid when its row has `proAuctionHistory__row--invalid` or contains `.proAuctionHistory__amount--invalid`.

## How one run works

`start()` initializes the store, sets `needsStartupBaseline`, resets the in-memory refresh schedule and schedules the first run. After each run, `schedule()` re-arms one timer for the later of the backoff time and the earliest of the next discovery, the next due refresh, or now while a sweep is in progress.

`runOnce({ scheduled })`:

1. `store.reconcile()`, then `followService.cleanupEnded()` (removes follow data from ended auctions), then `pruneStale()` (retention below, plus receipt pruning at most hourly).
2. Discovery (`scan()`) runs on the first run, whenever `nextDiscoveryAt` is due (every `intervalMs`, 90 seconds), and on every direct call:
   - **Uninitialized store:** a silent baseline at the highest ID seen; queued announcements are cleared.
   - **First scan of a process with initialized storage (`queueStartupCatchUp`):** read active and inactive listings above the saved `inactiveWatermark`, at most 11 new entries each (the extra one shows whether older ones exist), merge them with announcements still queued, skip tracked auctions, keep the 10 highest IDs (`CATCH_UP_LIMIT`), keep queued entries' original `queuedAt`, and log `PRO auction startup catch-up queued N auctions posted while the bot was offline[; older ones were skipped].`
   - **Later scans:** queue unseen IDs above the watermark oldest first, then raise the watermark only to the highest ID on active page 1.
   - Each scan delivers at most `DELIVERY_BATCH_SIZE` (5) announcements, oldest first. A delivery stores the card signature seen on page 1.
3. `sweepListings(first)` starts only in a run that fetched active page 1, at most every 10 minutes (`SWEEP_INTERVAL_MS`), and reads up to 10 pages per run (`SWEEP_PAGES_PER_RUN`), continuing in the next runs:
   - **Regular sweep:** from page 1 down to the first page whose lowest ID is below the oldest fresh tracked auction (fresh means announced within 7 days, read from the Discord message ID's timestamp; implausible IDs count as fresh). At most 50 pages (`RECENT_SWEEP_PAGE_LIMIT`), with one warning if reached.
   - **Full sweep:** every active page once a day (`FULL_SWEEP_INTERVAL_MS`, first one at a random time within the first day).
   - When a sweep finishes, a tracked auction whose card signature differs from `auction.listingSignature` is flagged, and one that was not seen between the covered floor and the sweep's ceiling (the newest auction tracked when the sweep started) is flagged, because it may have ended or been deleted. Auctions tracked after the sweep started are newer than the pages it read, so they are not flagged. Deleted posts without followers are flagged only when they leave the listing. Non-network page errors end the sweep early with a console line.
4. `refreshTracked(delivered, { onlyDue: scheduled })` refreshes at most `REFRESH_BATCH_SIZE` (10) auctions per run, most overdue first. Scheduled runs use `refreshDue()`; the earliest rule wins:

   | Auction | Next check |
   | --- | --- |
   | Flagged by a sweep | Now |
   | Followed | Every `intervalMs` (90 s) |
   | Countdown ended | 60 s after `endsAt`, then every 90 s for an hour and every 10 min after that until the forum shows the end |
   | Countdown running, older than 7 days, post present or followed | Every 10 min |
   | Forum page gone (`sourceUnavailable`) | Every 30 min for a day, then daily |
   | Every other auction | Safety refresh every 6 h when fresh, every 7 days when older or when its post is deleted without followers |
   | Failing | Never before the item's backoff (`itemFailures`) |

   After a restart the timing state is empty; each auction's first regular check starts at a random point in its interval (`refreshBase`), so there is no burst. Direct runs (`runOnce()` without `scheduled`, used by tests) ignore the schedule and refresh the least recently refreshed auctions first, except deleted posts without followers.
5. For each refresh: fetch the page, keep the stored `auctionDuration` and `listingSignature`, call `followService.observe()`, and edit the announcement only when the auction changed apart from its signature (`withoutSignature`). HTTP 404 or 410 edits the post once to `Unavailable` with `sourceUnavailable: true` and `unavailableSince`; the next successful fetch replaces the stored auction, which clears both. Discord error `10008` sets `messageMissing` and stops embed updates.
6. `followService.drain(eligible)` sends queued bid DMs for auctions observed active in this run, at most 20 attempts.
7. Errors for which `batchFailure()` is true (shutdown, HTTP 429 or 5xx, network codes, `fetch failed`) abort the run and back off the whole monitor with `forumRetryDelay` (up to 30 minutes). Other errors back off only the item.

Every forum request goes through `request()`: one shared queue, 750 ms spacing (`requestSpacingMs`), a shared 429 wait (`forumRateLimit`), and one retry after the spacing for a network reset, timeout, DNS or socket error without an HTTP status (`retryableNetworkError`). TLS and certificate errors anywhere in the `cause` chain are not retried. `fetchAuction` shares one in-flight request per ID between the monitor and follow buttons.

## Retention

`pruneStale()` makes one update that touches only the selected records:

- Ended auctions leave storage 30 days (`RETENTION_MS`) after their end: `endedAt`, else a past `endsAt`, else `endedObservedAt`. Unavailable auctions leave 30 days after `unavailableSince`. A missing, invalid or future time is stamped once with the current time, so the 30 days start when the monitor first sees the state.
- A queued announcement whose page keeps returning 404/410 gets `unavailableSince` on its pending entry (cleared when a fetch succeeds but the send fails) and is dropped 30 days later.
- Active auctions are never removed, however long they wait for bids. Discord posts are never edited or deleted by cleanup; their buttons answer `This auction is no longer available. Open its forum page for details.` (`follow()` returns `{ unavailable: true, removed: true }`).
- Log lines: `Removed N stale PRO auction records (ended or unavailable for more than 30 days).`, `Dropped N queued PRO auction announcements whose forum page stayed unavailable for 30 days.`, `Removed N PRO auction change receipts older than 30 days.`

## State shape

```text
{ version: 1, initialized, inactiveWatermark?, pendingOrder: [id], pending: { id: { id, url, queuedAt, unavailableSince? } },
  tracked: { id: { messageId, auction, messageMissing?, follow? } } }
auction may also carry listingSignature, endedObservedAt and unavailableSince
follow = { seenBids: [bidKey], users: { userId: { followedAt } }, pending: { notificationKey: job },
           currentAuction?, baselinePendingUsers? }
job    = { bid, bids?, bidKeys?, auction, recipients: [userId], queuedAt }
```

- **Copy-on-write updates:** `store.update(mutator)` gives the mutator a draft whose tracked records are cloned only when read or written; untouched records stay shared and frozen. Only the metadata and touched records are validated (`validMetadata`, `validTrackedEntry`) and diffed, with the same operation as a full `changesBetween()` (covered by a randomized test). Saved values are copied, so objects a caller still holds cannot change stored state, and a draft cannot be used after its update. `update()` resolves to nothing.
- **Reads:** `getAuctionRecord(id)` copies one record, `getMeta()` returns the small metadata, and `readTracked(read)` scans the frozen records without copying them. `getState()` returns a full copy and is meant for tests and rare callers.
- An invalid result throws `Invalid auction update.` with `auctionStorage: true`; updates that change nothing are skipped. `follow.users` may not be empty, so remove `follow` when the last follower leaves.
- Following an active auction observes it first, so bids that existed before the follow never reach the new follower. Following while the forum page is unavailable adds the member to `baselinePendingUsers`.
- **JSON mode** (`STORAGE_MODE=json`, or no MySQL configuration): the file holds the full state plus `revision` and `syncedRevision`, and every read loads it from disk.
- **MySQL mode:** the file holds a version 2 journal (`{ version: 2, operations, snapshot? }`). Each update appends an operation, writes the journal, then applies it in one transaction. During an outage the journal also keeps a `snapshot` (a shallow copy of the state, which is safe because records are frozen and metadata is replaced, never changed in place); after recovery the operations are replayed. A full version 1 file in MySQL mode throws `AUCTION_STORE_CONFLICT`; a journal without a snapshot in JSON mode throws `AUCTION_STORAGE_UNAVAILABLE`. An invalid file is preserved as `.corrupt-*` and throws `JSON_STORE_CORRUPT`.
- **Receipts:** every applied operation adds a receipt row (operation UUID, `revision`, `operation_hash`, `applied_at` in UTC) that makes retries idempotent. `pruneReceipts` deletes receipts older than 30 days, never the `main` row, and only while MySQL is healthy and the journal is empty.
- **Fresh start (only when the owner asks for a reset):** stop the bot, delete the rows of all four auction tables and reset the file to `{"version": 2, "operations": []}`. The next start records a silent baseline.

## Discord controls

Every custom ID starts with `auction:` and is handled by `handleAuctionButton`:

| Custom ID | Where | Behavior |
| --- | --- | --- |
| `auction:follow:{id}:0` | Announcement | Follow; ephemeral confirmation with an Unfollow button. |
| `auction:images\|bids\|description\|payment:{id}:{page}` | Announcement or private page | Private paged view. The images page uses Components V2 (`ContainerBuilder`, `MediaGalleryBuilder`). |
| `auction:unfollow\|refollow:{id}:{userId}` | Ephemeral confirmation only | Owner-only toggle. On a public message it answers `This private subscription control is unavailable here.` |
| `auction:dm-follow\|dm-unfollow:{id}:{userId}[:{deliveryId}]` | Bid DM | Owner-only toggle in DMs. Following again checks guild membership and `ViewChannel` on the auction channel. |
| `auction:dm-bids:{id}:{userId}:{page}` | Bid DM | Owner-only bid history; requires the same access check. |

- Channel controls answer `This auction control is unavailable here.` outside `auctionChannelID`. DM controls require a DM channel, the matching user ID and a message authored by the bot.
- Unexpected errors propagate to the router, which logs them with redaction and replies `⚠️ Something went wrong!` (a `TextDisplay` on Components V2 messages). For `auction:` controls it adds ` Please try again in a moment.` only when `temporaryAuctionFailure()` finds a temporary cause in the error or its causes: `AUCTION_STORAGE_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, transient MySQL or network codes, Discord 429 or 5xx, or a timeout. `AUCTION_STORE_CONFLICT`, `JSON_STORE_CORRUPT`, `auctionStorage`, other 4xx errors and anything else get no hint. Expired interactions (`10062`, `40060`) are logged without a reply.
- Discord DM errors `50007` and `10013` unfollow that member. Other DM failures keep the job and retry with backoff (2 minutes, doubling up to 30 minutes, longer when `Retry-After` asks).

## Invariants to preserve

- **Stable identities:** `bidKey`, `notificationKey` and the DM `deliveryId` (first 22 hex characters of SHA-256 of `auctionId:key:userId`) are stored or embedded formats. Changing their inputs causes duplicate DMs. Changing the card signature inputs causes one refresh of every tracked auction.
- **Persistent buttons:** messages already in Discord depend on the current custom ID formats.
- **Duplicate-safe delivery:** `send` and `sendBidUpdate` search channel or DM history before sending, and send with nonces (`auction:{id}` and `af:{deliveryId}`, `enforceNonce: true`). This also covers announcements re-queued by the restart catch-up.
- **Completion before removal:** a queued announcement leaves `pending` only after Discord returns a message ID, and a DM recipient is removed only after the DM is confirmed. Both updates are saved even if shutdown starts during the send.
- **No delivery past the deadline:** `drain` skips jobs once the known `endsAt` has passed and resumes them if a later refresh shows an extension.
- **Frozen stored records:** never modify a record returned by `readTracked`; change state only through `store.update()`.
- **Storage recovery:** never import a full JSON state into MySQL mode, and never edit or reset `data/forum_auctions.json` while the bot runs.
- **Shutdown:** `stop()` bumps `generation`, aborts the controller and waits for the run, the request queue and pending writes. Let `BOT_SHUTTING_DOWN` errors propagate.
- **Mentions and text safety:** announcements ping only `proAuctionsRoleID`, and DMs mention only their recipient. Forum text goes through `text()`, `person()` and `url()`.
- **Time:** forum times are UTC, Discord displays use `<t:...>`, and stored values are ISO strings.

## Alerts

`STATUS_EVENTS` in `utils/discordDiagnostics.js`:

- `PRO auction monitor is unavailable. Retrying in …` opens the "PRO Auctions" incident, which alerts after 10 minutes. `PRO auction monitor connection restored.` recovers it.
- Every other `console.warn` or `console.error` alerts immediately (grouped for 5 minutes), including `PRO auction monitor failed; retaining pending work`, item failures (`PRO auction {id} failed; retrying separately`), DM failures, `Shared auction state unavailable` and the 50-page sweep warning.
- Unavailable pages (404 or 410), retention, catch-up, sweep stops and recoveries use `console.log` and stay in the console.

Keep log texts stable, or update `STATUS_EVENTS` and `test/discordDiagnostics.test.js` together.

## Tests

| Area | Test file |
| --- | --- |
| Parsing, signatures, requests, cancellation | `test/auctionForumClient.test.js` (inline HTML fixtures, `listingCard()`) |
| Monitor, catch-up, sweep, schedule, retention, retry, shutdown | `test/auctionMonitor.test.js` (`fixture(t)`, `scheduleFixture(t, now)`, `snowflakeAt()`) |
| Follow service and DM retries | `test/auctionFollow.test.js` |
| Store, copy-on-write updates, journal, replay, receipts | `test/auctionStore.test.js` (`setup(t)`) |
| SQL repository, receipt times and schema consistency | `test/auctionSqlRepository.test.js` |
| Payloads, buttons, removed auctions, retry hint | `test/auctionDiscord.test.js` (`sample()`) |
| Alerts | `test/discordDiagnostics.test.js` |
| Startup and shutdown wiring | `test/botBootstrapShutdown.test.js` |

```sh
node --test "test/auction*.test.js"
```

Forum HTML in tests must be fixture strings, never live requests.

## Before finishing auction work

1. Read the relevant module end to end before editing; `AuctionDiscord.js`, `AuctionMonitor.js` and `AuctionFollowService.js` share state only through the store.
2. Run the auction tests, plus the diagnostics and startup tests if log texts or wiring changed.
3. Update `docs/operations.md` only when operators would notice the change.
4. Report what could only be verified live: Components V2 rendering, DM delivery, current forum markup and request volume.
