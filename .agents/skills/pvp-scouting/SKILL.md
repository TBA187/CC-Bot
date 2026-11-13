---
name: pvp-scouting
description: Architecture, invariants and tests for Gold and Silver PvP scouting in features/pvp-scouting/ (message archiving, OCR, parsing, report grouping, correction windows, member edits, officer review, Cross Server search). Use when reading, changing or debugging scout ingestion, /scout, /scout-review, /scout-settings, /scout-stats, scout feedback reactions or the pvp_scout_* tables.
---

# PvP scouting

Members post scouting notes and battle screenshots in the Gold and Silver scouting channels. The bot archives every eligible message in MySQL, reads screenshots with OCR, parses the opponent IGN, rating and team, groups related messages into one report, and publishes or holds each report for officer review. `/scout` searches the archive. Scouting requires MySQL; `STORAGE_MODE=json` does not replace it.

`AGENTS.md` lists the scouting rules; this skill maps them to the code. The modules are large, so read the relevant functions before relying on details here.

## Module map

| Area | Code |
| --- | --- |
| Server routing | `ScoutServerRegistry.js`: one `PvpScoutStore` and one `PvpScoutIngestor` per server, `get(server)`, `forChannel(channelId)`, `warmAutocomplete()`, `start()`, `stop()`. Gold and Silver must use different channels. |
| Live events | `events/pvpScouting.js` routes `messageCreate`, `messageUpdate`, `messageDelete` and `messageDeleteBulk` to the ingestor for the message's channel. |
| Ingestion | `PvpScoutIngestor.js`: per-server queue, startup refresh, catch-up, create/update/delete handling, grouping (`groupRows`, `mayJoinReport`), officer alerts. |
| OCR | `PvpScoutOcr.js` (Discord images read in memory with Sharp, OCR through `ocrWorkerPoolFor` in `utils/runtimeMemoryOcr.js`), `ScoutImageUrls.js` (reuses signed attachment URLs while valid). |
| Parsing | `PvpScoutParser.js` (IGN, rating, details, review decision), `PokemonTeamParser.js` (team entries), `PokemonSpecies.js` and `PokemonVocabulary.js` (local dictionaries), `ScoutSearch.js`. |
| Storage | `PvpScoutStore.js` (messages, groups, catch-up checkpoint, corrections, edit reviews, autocomplete cache), `ScoutSchema.js` (`ensureScoutTables` reads `sql/create_pvp_scout_tables.sql`), `ScoutRosterStore.js` (guild profiles, server preferences, friendly list). |
| Feedback and timers | `ScoutMessageFeedback.js` (public reactions and the author's correction reply), `ScoutCorrectionWindow.js` (one-hour durable windows), `ScoutFeedbackText.js`. |
| Deleted reports | `ScoutDeletionStore.js` (`pvp_scout_deletions`: capture, alert, edit, decision, repost), `ScoutDeletionReview.js` (officer alert panels, `scout-deleted:` buttons and modals routed in `app/interactionRouter.js`, audit-log attribution, screenshot copies, repost). |
| Edits and review | `ScoutEditPolicy.js` (`canAutoApplyScoutEdit`, `isSmallEdit`, `spamEditReason`, `mergeReviewedEdit`), `ScoutReviewLearning.js` (evidence learned from officer decisions), `ScoutReportManager.js` and `ScoutReportAdminStore.js` (staff report editing), `ScoutSourceManager.js` and `ScoutSourceAdminStore.js` (attach, separate and edit sources), `ScoutStaffServers.js` (keeps staff menus bound to their archive). |
| Presentation | `ScoutArchiveView.js` (both archives as one read-only view), `ScoutTeamMerge.js`, `ScoutTeamPages.js`, `ScoutPresentation.js`, `ScoutAuthorDisplay.js`, `ScoutChanges.js`, `ScoutAuditLogger.js` (scout log and bot diagnostics). |
| Commands | `commands/scout.js` (members: search and add a report, `pvp-scout:` IDs), `commands/scout-review.js` (staff, `pvp-scout-review:`), `commands/scout-settings.js` (staff, `scout-settings:`), `commands/scout-stats.js` (`scout-stats:page:`). Source management uses `scout-sources:` IDs routed to the staff commands' `sourceManager`. |
| Roster | `events/scoutRoster.js` reconciles guild-member and friendly lists at startup and on member changes. |

## Records

`pvp_scout_messages` holds one row per source message, with `server` (`gold` or `silver`), `channel_id`, `classification` (`scout`, `review`, `ignored`), `review_status` (`not_required`, `pending`, `confirmed`, `corrected`, `not_scout`), `ign_source` (for example `member_submission` for `/scout` modal reports), `root_message_id` (the report a message belongs to), `staff_overrides_json` (`locked`, `hidden`, `rootMessageId` and other staff decisions), `ocr_json`, `content_hash` and `is_deleted`. Other tables hold the catch-up checkpoint (`pvp_scout_catchup`), feedback state, review events and alerts, edit reviews, correction windows, member deletions awaiting an officer decision (`pvp_scout_deletions`), the friendly list and guild members.

- Message, channel, author and report IDs are strings; never convert them to numbers.
- A message with several reports keeps the first on the row with the Discord message ID, whose `message_content` stays the full message for edit detection. Each further report is its own root row `<messageId>_<n>` holding only its section text and no attachments. `discordMessageId()` in `PvpScoutStore.js` maps any row ID back to the Discord message; use it before fetching, reacting to or linking a message. Officer notes use `manual_<hex>` IDs.
- Deleted messages are marked `is_deleted`, not removed.
- Table definitions come from `sql/create_pvp_scout_tables.sql` at runtime. `CREATE TABLE IF NOT EXISTS` does not change existing tables, so a column change needs a migration that preserves existing rows.

## Ingestion flow

0. **Several reports in one message:** `splitScoutSections` (`PvpScoutParser.js`) finds report headings: a labelled IGN line, an `IGN: team` line, a bold, rated, colon-terminated or digit-bearing name, or a plain name after an empty line or divider with at least two Pokémon below it. `extractScoutData` then parses the first section as the message's own report and returns the others, minus exact repeats, as `extraSections`; `store.syncSections` saves them, matching existing rows by heading IGN so IDs and officer decisions survive edits, and marks removed ones deleted. It runs from `ingestor.saveMessage`, applied edits, accepted held edits (`ingestor.syncSections`) and the startup refresh. Feedback aggregates the sections in `reportOutcome` (one reaction per message, one publication log per report), and deleting the message deletes every report with its own officer alert.
1. **Eligibility:** `canArchiveMessage` accepts messages from members and rejects bots and webhooks, except the bot's own `PvP Scout Report — ` embeds posted for `/scout` submissions.
2. **Startup (`start()`):** ensures the schema, then on the ingestor queue reparses automatic records from saved OCR (`refreshAutomaticRecords`; only `pending` and `not_required` rows that are not member submissions or officer-reviewed, without downloading images again), rebuilds groups, refreshes autocomplete, and starts catch-up. Storage failures retry with backoff of up to 5 seconds.
3. **Catch-up:** walks the channel history backward from the newest message to the saved checkpoint, archives unseen messages, regroups, then saves the newest ID as the checkpoint. A live archive failure during catch-up (`catchupFailureRevision`) keeps the checkpoint paused until the next start, so a gap is never certified as processed. After catch-up, saved correction timers are restored.
4. **New message:** saved through the queue with `deferReview`, assigned to a report (`assignLiveGroup`), and the checkpoint advances only while `catchupReady` is true. Public feedback is then updated.
5. **Edit:** an edit to an archived message is applied directly when `canAutoApplyScoutEdit` allows it, `spamEditReason` returns nothing and the bulk-edit safeguard is quiet. `canAutoApplyScoutEdit` requires the same author and channel, no pending edit review, and no protected state on the message or its root (`not_scout`, locked, hidden or deleted; `/scout-settings` edits lock a report). The edit must fall within 48 hours of posting (`AUTHOR_EDIT_WINDOW_MS`) or be small (`isSmallEdit`: at most 120 changed characters and half of a longer message, no screenshot removed, same opponent apart from a spelling fix). Reports an officer confirmed or corrected stay editable: `mergeReviewedEdit` compares plain parses of the old and new text (`comparisonParse`) and replaces only the fields the edit changed, and `saveMessage` keeps the decision columns when `preserveReviewDecision` is set. Posting and edit times are Discord timestamps; the host clock is only a sanity bound with `CLOCK_SKEW_TOLERANCE_MS`, so a host clock behind Discord must not send fresh edits to review. `spamEditReason` holds only obvious vandalism of a published report: scout details replaced by off-topic text, or the opponent and every Pokémon removed. Changes to the IGN, rating, team, notes or screenshots are ordinary corrections, and a failed report or non-scout message is never held. Held edits are staged in `pvp_scout_edit_reviews` for officer approval with the reason shown as the log's review safeguard. Editing at least three reports older than one week within ten minutes triggers the bulk-edit safeguard (`isHistoricalEditBurst`, which compares the UTC `created_at`/`edited_at` columns with `UTC_TIMESTAMP` and the database-written `requested_at` with `CURRENT_TIMESTAMP`). Every edit is logged through `ScoutAuditLogger.memberEdited`.
6. **Delete:** `deletions.capture` records a message of a report shown in `/scout` in `pvp_scout_deletions` (with its previous `review_status`) before `markDeleted` runs; then messages are marked deleted, groups are rebuilt once per batch, feedback is removed, and `deletions.announce` posts the officer alert. The alert carries copies of the screenshots, saved as the row's `attachments` override so they stay renewable. **Keep** clears `is_deleted` and restores the previous status (a report that awaited review becomes `confirmed`), **Keep & repost** also posts a plain bot copy with a "Scouted by" credit (not archived, because it is not a `PvP Scout Report — ` embed) and points `source_url` and the screenshots at it, **Remove** only records the decision, and **Edit** saves officer changes on the deleted row. Decisions are applied once (`status` guard); unsent alerts are retried by `deletions.restorePending` after catch-up, and `recheckCorrection` never re-deletes a kept report.

Each server's ingestor has its own queue (`enqueue`) and checkpoint, and all archive writes for a message go through that queue. OCR from both servers and guild applications shares one queue and helper process.

## Grouping rules

`groupRows` and `mayJoinReport` decide whether a message joins an earlier report:

- A staff `rootMessageId` override always wins, and saved continuations are preserved when still consistent (`savedContinuation`).
- Explicit replies join the replied report when the evidence is compatible. Without a reply, only the same author's follow-up within 15 minutes can join (`FOLLOW_UP_WINDOW_MS`); the rules are looser within 2 minutes.
- Messages stay separate when the channel or server differs, the IGNs differ, the ratings differ, two messages both carry screenshots, two full teams share fewer than three species, the combined team would exceed six Pokémon (non-replies), or a message restates the opponent together with a team.
- Never merge reports only because the member, opponent or time is similar. Distinct battles keep their own IDs, dates and ratings.
- `rebuildGroups()` recomputes links in pages of 500 and writes only changed links; it never resets the whole archive.

## Review and correction

- A new report that fails validation gets correction suggestions and a one-hour correction window (`CORRECTION_WINDOW_MS`) stored in `pvp_scout_correction_windows`. When it expires without a fix, the report escalates to officers in `officerChannelID`. Deadlines survive restarts.
- `/scout-review` lists a pending report as soon as it fails, including while its window is `waiting`; `reviewQueueSql` exposes `correction_open` and `correction_due_at_ms` and the panel shows a warning. The officer alert is still sent only at expiry. An officer decision (`applyStaffReview`) resolves the window in the same transaction, and `expectedContentHash` rejects a decision when the member edited the message after the panel opened.
- Officer decisions (`confirmed`, `corrected`, `not_scout`, `reviewed_by_id`) and staff overrides are never overwritten by reparsing, refreshing or member edits.
- `ScoutReviewLearning.js` derives reusable evidence from officer decisions in both channels; `ScoutServerRegistry.invalidateLearning()` refreshes it for both servers. Keep learned evidence conservative and keep OCR guesses distinguishable from confirmed player or staff input.

## Gold, Silver and Cross Server

- Each server has its own channel, store, archive, autocomplete cache (`data/scout-autocomplete-cache.json` and `data/scout-autocomplete-silver-cache.json`, both rebuildable) and catch-up checkpoint.
- Cross Server search reads both archives through `ScoutArchiveView.js` and must show each report's own server. Writes always stay in the source channel's archive.
- Player server preferences and the Gold and Silver roles stay in step through `ScoutServerSettings.js`. Staff menus stay bound to the archive they opened (`ScoutStaffServers.js`).

## Invariants to preserve

- Source message IDs, reply links, source URLs, report dates and review history.
- Officer decisions, staff overrides, correction windows and edit reviews.
- The catch-up checkpoint contract: advance only after history up to that message is archived.
- The shared OCR queue and helper process: never create a Tesseract worker per request or run image processing in a command handler.
- Download limits and URL checks for attachments; refresh expiring Discord URLs with the existing helpers while keeping staff-selected images.
- Mentions: player names and note text must not ping anyone.
- Autocomplete deadlines and cached fallbacks in `/scout` (`test/scoutAutocompleteDeadline.test.js`).

## Tests

| Area | Test file |
| --- | --- |
| Parsing, OCR evidence, team details | `test/pvpScouting.test.js`, `test/pvpScoutOpponentEvidence.test.js`, `test/pokemonScoutDetails.test.js`, `test/scoutSearch.test.js` |
| Grouping and team merge | `test/scoutTeamMerge.test.js`, `test/pvpScouting.test.js` |
| Edits, feedback, correction windows | `test/scoutEditPolicy.test.js`, `test/scoutMessageFeedback.test.js` |
| Deleted reports | `test/scoutDeletionReview.test.js` |
| Several reports in one message | `test/scoutSections.test.js` |
| Review and staff tools | `test/scoutReviewLearning.test.js`, `test/scoutReportAdmin.test.js`, `test/scoutSourceManagement.test.js`, `test/scoutStaffServers.test.js`, `test/scoutSettings.test.js` |
| Servers and Cross Server | `test/scoutServerRegistry.test.js`, `test/scoutServers.test.js`, `test/scoutServerSettings.test.js`, `test/scoutCrossServer.test.js` |
| Presentation, stats, autocomplete | `test/scoutReportPresentation.test.js`, `test/scoutStats.test.js`, `test/scoutAutocompleteDeadline.test.js`, `test/scoutIdentityWarning.test.js` |
| Roster, schema, audit log | `test/scoutRoster.test.js`, `test/guildMemberSettings.test.js`, `test/scoutSchema.test.js`, `test/scoutAuditLogger.test.js` |
| OCR worker | `test/runtimeMemoryOcr.test.js`, `test/ocrProcessWorker.test.js` |

```sh
node --test "test/scout*.test.js" "test/pvpScout*.test.js" test/pvpScouting.test.js test/pokemonScoutDetails.test.js test/guildMemberSettings.test.js
```

Use representative message and OCR fixtures for parsing changes, and cover both Gold and Silver when shared behavior changes.

## Before finishing scouting work

1. Check both servers and Cross Server behavior when shared code changed.
2. Run the scouting tests, plus the OCR tests when OCR or image handling changed.
3. Report what could only be verified live: real screenshots, Discord reactions and replies, and officer alerts.
