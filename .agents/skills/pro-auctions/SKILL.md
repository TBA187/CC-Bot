---
name: pro-auctions
description: Architecture, invariants and tests for the PRO Trade Zone auction feature in features/auctions/. Use when reading, changing, debugging or finishing the auction monitor, auction announcements, follow/unfollow buttons, bid DMs, the auction store or its MySQL tables.
---

# PRO Trade Zone auctions

The auction feature watches the Pokémon Revolution Online Trade Zone (`https://pokemonrevolution.net/forum/trade/`), posts one announcement per new auction in `auctionChannelID`, keeps those announcements updated, and sends DMs to members who follow an auction when new valid bids appear. It is separate from the guild-application and forum-shop monitors, and it is disabled when `auctionChannelID` is unset.

The code uses its own conventions: camelCase state keys (`messageId`, `seenBids`), clocks in Unix milliseconds (`clock()`), stored times as ISO strings, and auction and Discord IDs as digit strings compared with `BigInt` when order matters. Keep them consistent so stored state and helpers agree.

## Module map

| File | Responsibility |
| --- | --- |
| `index.js` | `createAuctionMonitor({ client, db, config, rootPath, storageMode })` builds the store (`data/forum_auctions.json`), notifier, monitor (enabled only when `config.auctionChannelID` is set) and `monitor.followService`. |
| `AuctionStatus.js` | `active()` (`Active` or `Instant Price`, and not `sourceUnavailable`) and `ended()` (inactive, ended, closed, sold, completed, expired, cancelled). |
| `AuctionBids.js` | `bidKey` (SHA-256 of bidder URL or lowercased name, amount without separators, time and bid/offer kind), `bidTimestamp` (forum `YYYY-MM-DD HH:MM:SS` read as UTC), `notificationKey`, `burstGroups` (90-second groups; bids and price offers stay apart). |
| `AuctionForumClient.js` | `AuctionForumClient`: requests limited to the forum origin (manual redirects, at most 3; 4 MiB HTML cap; 15-second timeout; HTML content type only; `Retry-After`), `parseListing` and `parseAuction`. Throws `AuctionForumRequestError` with `code` (`HTTP_<status>`, `ETIMEDOUT` or a network code), `status` and `retryAfterMs`. |
| `AuctionMonitor.js` | `AuctionMonitor`: scheduling, discovery scans, announcement delivery, paced refreshes, per-item and whole-run backoff, and the shared forum request queue. |
| `AuctionFollowService.js` | `AuctionFollowService` (`follow`, `unfollow`, `observe`, `pause`, `cleanupEnded`, `drain`) and `validFollowState`. |
| `AuctionStore.js` | `AuctionStore`: state validation, JSON-only mode, and MySQL mode with a local operation journal and replay. |
| `AuctionSqlRepository.js` | `AuctionSqlRepository`: flattens state into rows, revision-checked transactional `apply` with operation receipts, `load`, and runtime `ensureSchema`. Also exports `changesBetween`, `projectOperation` and `operationHash`. |
| `AuctionDiscord.js` | Announcement and DM payload builders, private pages (images, bids, description, payment), `handleAuctionButton`, and `AuctionDiscordNotifier` (`send`, `edit`, `sendBidUpdate`, duplicate search). |
| `sql/create_forum_auction_tables.sql` | `forum_auction_control`, `forum_auctions`, `forum_auction_subscriptions`, `forum_auction_outbox`. `schemaStatements()` creates the same tables at runtime; keep both definitions identical (covered by `test/auctionSqlRepository.test.js`). |

Wiring: `app/createBotApplication.js` creates the monitor, `app/BotApplication.js` starts it in `onReady` and stops it in `stopAndExit`, and `app/interactionRouter.js` sends every `auction:` button to `handleAuctionButton` with `getAuctionRecord`, `channelId: appConfig.auctionChannelID`, `guildId` and `followService`. The notifier receives the whole `config.json`: `proAuctionsRoleID` is pinged on new announcements and `selfRoleChannelID` appears in the role instructions. Operator guidance is in the "Forum monitors and scouting" section and the `forum_auctions.json` row of `docs/operations.md`.

## Parsing rules (strict)

- A listing page must contain `.proAuctionList`; otherwise it throws `PRO auction listing was not recognized.`
- Every direct `.ipsData__item` child needs a `.ipsData__title a[href]` that resolves to `https://pokemonrevolution.net/forum/trade/<id>/`. Any other entry fails the page with `PRO auction listing contains an unreadable entry.`
- Pagination comes from the first `.ipsPagination[data-pages]` (default 1). The monitor refuses more than 1,000 pages, and fails the run when a later page is empty or an entry has a higher ID than the one before it (`ordering changed; checkpoint retained`).
- An auction page needs `.proAuctionViewHeader` with an `h1` title and at least one `.proAuctionHeader .ipsBadge`, plus `.proAuctionPanel__grid` and `.proAuctionHistory`. The seller must be readable and every bid row needs a bidder and an amount. The first badge is the status; a `Gold`, `Silver` or `Cross-Server` badge is the server.
- `endsAt` comes from `data-proauction-countdown` (Unix seconds). `endedAt` and the final amount come from the `Auction Ended:` or `Instant Price Purchased:` notice (`YYYY-MM-DD h:mm AM/PM UTC`).
- Images are collected in page order from `.proAuctionAttachments a.proAuctionAttachment[href]` and `.ipsRichText--user img`, without duplicates. An image wrapped in a link to an image file uses the linked file. The first image is the announcement image.
- A bid is invalid when its row has `proAuctionHistory__row--invalid` or contains `.proAuctionHistory__amount--invalid`.

## How one run works

`start()` initializes the store (a conflict or invalid recovery file throws and the monitor stays stopped), sets `needsStartupBaseline`, and schedules the first run. After each run, `schedule()` re-arms a single timer for the later of the backoff time and the earlier of the next discovery or next due refresh.

`runOnce({ scheduled })`:

1. `store.reconcile()` flushes journal operations left from a MySQL outage, then `followService.cleanupEnded()` removes follow data from ended auctions.
2. Discovery runs on the first run after start, whenever `nextDiscoveryAt` is due (every `intervalMs`, 90 seconds by default), and on every direct call. Other scheduled runs only refresh due auctions.
3. `scan()`:
   - **Startup baseline** (on every process start and on an uninitialized store): reads page 1 of the active and inactive listings, sets `inactiveWatermark` to the highest ID seen (including pending and tracked IDs), clears `pending` and `pendingOrder`, and logs `PRO auction startup baseline recorded; ...`. Auctions created while the bot was offline are never announced. With no listings at all it throws `Cannot establish an auction baseline without any listings.`
   - **Later scans:** deliver queued announcements, read the active and inactive listings down to `inactiveWatermark`, queue unseen IDs oldest first (`pending[id] = { id, url, queuedAt }`), raise the watermark only to the highest ID on active page 1, then deliver again. Each scan attempts at most `DELIVERY_BATCH_SIZE` (5) announcements.
4. `refreshTracked()` walks tracked auctions that have not ended, round-robin from `refreshCursor`, up to `REFRESH_BATCH_SIZE` (10). Scheduled runs skip auctions that are not yet due (each is due every `intervalMs`) or are backing off. A tracked auction with `messageMissing` is refreshed only while it has followers. For each auction the monitor fetches the page, keeps the stored `auctionDuration` when the new page lacks one, calls `followService.observe()`, and edits the announcement only when the parsed auction changed.
   - HTTP 404 or 410: `followService.pause()`, edit the announcement once to `Unavailable` with `sourceUnavailable: true`, and retry the item separately. The next successful fetch replaces the stored auction.
   - Discord error `10008` (unknown message): set `messageMissing` and stop embed updates for that auction.
5. `followService.drain(eligible)` sends queued bid DMs for auctions that were active during this refresh, at most 20 attempts per run.
6. Errors for which `batchFailure()` is true (shutdown, HTTP 429 or 5xx, network codes, `fetch failed`) abort the run and back off the whole monitor with `forumRetryDelay` (up to 30 minutes). Other errors back off only the affected item through `itemFailed`.

Every forum request goes through `request()`: one shared queue, 750 ms spacing (`requestSpacingMs`), and a shared 429 wait (`forumRateLimit`) that fails new requests with `HTTP_429` until it expires. `fetchAuction` shares one in-flight request per ID between the monitor and follow buttons.

## State shape

```text
{ version: 1, initialized, inactiveWatermark?, pendingOrder: [id], pending: { id: { id, url, queuedAt } },
  tracked: { id: { messageId, auction, messageMissing?, follow? } } }
follow = { seenBids: [bidKey], users: { userId: { followedAt } }, pending: { notificationKey: job },
           currentAuction?, baselinePendingUsers? }
job    = { bid, bids?, bidKeys?, auction, recipients: [userId], queuedAt }
```

- `validPayload()` checks the result of every `store.update(mutator)`; an invalid result throws `Invalid auction update.` with `auctionStorage: true`. Updates that change nothing are skipped. `follow.users` may not be empty, so remove `follow` when the last follower leaves.
- Following an active auction observes it first, so bids that existed before the follow never reach the new follower. Following while the forum page is unavailable adds the member to `baselinePendingUsers`; the next active observation marks existing bids as seen without notifying them.
- **JSON mode** (`STORAGE_MODE=json`, or no MySQL configuration): the file holds the full state plus `revision` and `syncedRevision`, and every read loads it from disk.
- **MySQL mode:** the file holds a version 2 journal (`{ version: 2, operations, snapshot? }`). Each update appends an operation (UUID, `baseRevision`, `revision`, row `changes`, `metadata`), writes the journal, then applies it in one transaction. During an outage the journal also keeps a `snapshot`; after recovery the operations are replayed against the database revision. A full version 1 file in MySQL mode throws `AUCTION_STORE_CONFLICT` and is left untouched. A journal without a snapshot in JSON mode throws `AUCTION_STORAGE_UNAVAILABLE`.
- **Invalid local file:** `readJsonObject` in `utils/jsonFile.js` keeps the original, saves a `.corrupt-*` copy and throws `JSON_STORE_CORRUPT`.
- **Fresh start (only when the owner asks for a reset):** stop the bot, delete the rows of all four auction tables and reset the file to `{"version": 2, "operations": []}`. The next start records a silent baseline.

## Storage costs

- Each `update()` deep-copies the state (`structuredClone`), diffs it into row changes (`changesBetween`), writes the journal file and applies one MySQL transaction. Batch related changes into one update.
- Every applied operation adds a receipt row (operation UUID, `revision`, `operation_hash`) to `forum_auction_control` beside the `main` row. Receipts make retries idempotent: the same operation with the same hash is skipped, and a different hash is a conflict.
- Nothing prunes receipts, and tracked auctions stay in state after they end (only their `follow` data is removed). Both grow over time, and every update diffs the full state.

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
- Unexpected errors propagate to the router, which logs them with redaction and replies `⚠️ Something went wrong!` (a `TextDisplay` on Components V2 messages). Expired interactions (`10062`, `40060`) are logged without a reply.
- Discord DM errors `50007` and `10013` unfollow that member. Other DM failures keep the job and retry with backoff (2 minutes, up to 30 minutes).

## Invariants to preserve

- **Stable identities:** `bidKey`, `notificationKey` and the DM `deliveryId` (first 22 hex characters of SHA-256 of `auctionId:key:userId`) are stored or embedded formats. Changing their inputs causes duplicate DMs.
- **Persistent buttons:** messages already in Discord depend on the current custom ID formats.
- **Duplicate-safe delivery:** `send` and `sendBidUpdate` search channel or DM history before sending, and send with nonces (`auction:{id}` and `af:{deliveryId}`, `enforceNonce: true`).
- **Completion before removal:** a queued announcement leaves `pending` only after Discord returns a message ID, and a DM recipient is removed only after the DM is confirmed. Both updates are saved even if shutdown starts during the send.
- **No delivery past the deadline:** `drain` skips jobs once the known `endsAt` has passed and resumes them if a later refresh shows an extension.
- **Storage recovery:** never import a full JSON state into MySQL mode, and never edit or reset `data/forum_auctions.json` while the bot runs.
- **Shutdown:** `stop()` bumps `generation`, aborts the controller and waits for the run, the request queue and pending writes. Let `BOT_SHUTTING_DOWN` errors propagate.
- **Mentions and text safety:** announcements ping only `proAuctionsRoleID`, and DMs mention only their recipient. Forum text goes through `text()` (escapes Markdown and breaks `@`), `person()` and `url()`.
- **Time:** forum times are UTC, Discord displays use `<t:...>`, and stored values are ISO strings.

## Alerts

`STATUS_EVENTS` in `utils/discordDiagnostics.js`:

- `PRO auction monitor is unavailable.` opens the "PRO Auctions" incident, which alerts after 10 minutes. `PRO auction monitor connection restored.` recovers it.
- Every other `console.warn` or `console.error` alerts immediately (grouped for 5 minutes), including `PRO auction monitor failed; retaining pending work`, item failures (`PRO auction {id} failed; retrying separately`), DM failures, and `Shared auction state unavailable` (it does not match the MySQL status event).
- Unavailable pages (404 or 410) and recoveries use `console.log` and stay in the console.

Keep log texts stable, or update `STATUS_EVENTS` and `test/discordDiagnostics.test.js` together.

## Tests

| Area | Test file |
| --- | --- |
| Parsing, requests, cancellation | `test/auctionForumClient.test.js` (inline HTML fixtures) |
| Monitor, baseline, refresh, shutdown | `test/auctionMonitor.test.js` (`fixture(t)` with a temporary directory) |
| Follow service and DM retries | `test/auctionFollow.test.js` |
| Store, journal, replay, host changes | `test/auctionStore.test.js` (`setup(t)`) |
| SQL repository and schema consistency | `test/auctionSqlRepository.test.js` |
| Payloads, buttons, duplicate recovery | `test/auctionDiscord.test.js` (`sample()`) |
| Alerts | `test/discordDiagnostics.test.js` |
| Startup and shutdown wiring | `test/botBootstrapShutdown.test.js` |

```sh
node --test test/auctionForumClient.test.js test/auctionMonitor.test.js test/auctionFollow.test.js test/auctionStore.test.js test/auctionSqlRepository.test.js test/auctionDiscord.test.js
```

Forum HTML in tests must be fixture strings, never live requests.

## Before finishing auction work

1. Read the relevant module end to end before editing; `AuctionDiscord.js`, `AuctionMonitor.js` and `AuctionFollowService.js` share state only through the store.
2. Run the auction tests, plus the diagnostics and startup tests if log texts or wiring changed.
3. Update `docs/operations.md` only when operators would notice the change.
4. Report what could only be verified live: Components V2 rendering, DM delivery and current forum markup.
