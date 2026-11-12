# Crow Control Development Instructions

## Project overview

Crow Control is the Crow Control guild's Discord bot for Pokemon Revolution Online. It uses Node.js, CommonJS JavaScript, discord.js v14, and MySQL/MariaDB through `mysql2/promise`. Features include Gold and Silver PvP scouting and PvP King challenges, guild applications, forum shop notifications, dungeon recruitment, giveaways, XP rewards, message editing, role management, and audit logging. Feature-specific JSON files preserve supported state and pending operations during database outages. OCR uses Sharp and Tesseract through a shared helper process.

## Development commands

Use the Node.js versions documented in `README.md` (Node.js 22 or later, with Node.js 24 recommended) and respect dependency engine requirements. Dependencies and resolved versions are in `package.json` and `package-lock.json`. See `docs/operations.md` for configuration, storage recovery, monitor behavior, diagnostics, and OCR operation.

- Install dependencies when needed: `npm ci`. Keep `package.json` and `package-lock.json` consistent when intentionally changing dependencies.
- Run the bot: `npm start` or `node index.js`. Startup connects to configured services, registers guild application commands, and starts background work. Keep only one production instance running; use a separate test bot, guild, database, and runtime data for live development checks.
- Run targeted tests: `node --test test/pvpKingServers.test.js` (substitute the relevant files). Full suite: `npm test`, which runs `node --test`.
- Syntax-check changed JavaScript files: `node --check path/to/changed_file.js`. This checks syntax without executing the file. Do not import `index.js` as a smoke test because it starts the bot.
- There are no configured lint, build, or typecheck scripts. Do not assume the TypeScript dependency makes this a TypeScript project.
- The guild-application preview, `node scripts/test_guild_application_notification.js`, reads the live forum without sending to Discord by default. It is a network integration check, not an offline unit test. Its `--send` and `--send-*` modes publish messages or polls; the shop preview script also has delivery modes. Inspect each script's options and destinations before use. Use delivery modes only when sending is part of the authorized task.

## General rules and project structure

- Preserve existing functionality unless the task changes or removes it. Keep edits focused, avoid unrelated refactoring, and preserve existing work in the working tree.
- Inspect the closest relevant implementation before editing. Reuse established commands, interaction handlers, feature services, stores, builders, and helpers rather than duplicating logic.
- Follow the existing layout: `app/` for application wiring, loading, routing and lifecycle, `commands/` for slash and context-menu commands, `events/` for Discord event handlers, `tasks/` for scheduled notifications, `features/` for feature services, `utils/` for shared helpers, `db/` for database connectivity, `sql/` for schemas, `test/` for automated tests, and `scripts/` for manual utilities. Configuration belongs in `config.json`, `config/`, or the existing environment settings as appropriate.
- Inspect `index.js` and the relevant `app/` modules when changing command loading, event registration, component routing, or lifecycle wiring. Commands are constructed dynamically, and events use existing registration/export contracts. Helpers placed in command or event discovery paths can be loaded as executable modules; keep them in the appropriate utility or feature location.
- Match the surrounding code's formatting and CommonJS exports. Consult official documentation for the installed dependency versions when Node.js, discord.js, MySQL, Sharp, or Tesseract behavior is unclear.
- Add dependencies only with a clear justification. Keep credentials in the existing environment configuration; never commit or expose tokens, passwords, or private diagnostic data.
- Before deleting code, check dynamic loaders, component IDs, callbacks, scheduled jobs, tests, and manual scripts. A static unused-code warning alone does not prove code is unused.

## Consistency across related functionality

- Start with the affected flow. Expand inspection to related commands, event handlers, components, services, stores, jobs, and tests when shared behavior or meaningfully equivalent cases could be affected. Use targeted reference searches to establish scope; an isolated edit does not require a full repository audit.
- Judge equivalence by purpose, inputs and outputs, permissions, audience, game server, state changes, stored data, delivery destinations, and retry behavior. Use existing helpers, implementations, and tests as evidence.
- Update all directly affected or meaningfully equivalent cases within scope unless instructed otherwise. When changing a shared helper, inspect relevant callers and recovery paths to preserve their contracts.
- Check both Gold and Silver when changing shared PvP behavior. Preserve separate archives, storage, channels, crown roles, history threads, cooldowns, and event results. Reuse `commands/pvp-king/utils/pvpServers.js` and `features/pvp-scouting/ScoutServerRegistry.js` for their respective routing. Cross Server scouting searches must preserve each record's source server.
- Preserve other intentional distinctions: member versus staff actions, Officer alerts versus Court House polls versus owner notifications, pending versus confirmed XP totals, private previews versus published messages, and durable recovery data versus rebuildable caches. Do not change unrelated flows merely for uniformity.
- If an equivalent case is intentionally left unchanged, explain why in the final report. If equivalence remains uncertain, limit changes to what the evidence supports and state the assumption, affected cases, and verification limits in proportion to the task.

## Discord interface and interactions

- Make messages, embeds, buttons, selects, and modals clear for their intended members, applicants, Officers, or administrators. Provide enough context to understand outcomes and next actions.
- Reuse existing branding, colors, images, footer conventions, builders, and interaction patterns. Preserve command names, game-server labels, links, and status meanings unless the task changes them.
- Use concise labels, restrained formatting, and layouts readable across light/dark themes and desktop/mobile clients. Respect Discord message, embed, attachment, poll, and component limits; reuse pagination or splitting where needed.
- Limit mentions to intended recipients with appropriate `allowedMentions`. Do not let forum text, imported message JSON, player names, or other external content create unintended pings.
- Acknowledge interactions before slow database, network, image, or OCR work. Follow existing `reply`, `deferReply`, `deferUpdate`, `editReply`, and `followUp` patterns; prevent duplicate initial responses and preserve public/ephemeral visibility. Reuse `utils/interactionLoading.js` where its behavior fits.
- Preserve autocomplete deadlines and cached fallback results. Modal opening and autocomplete have different response contracts from ordinary commands; do not apply a generic defer pattern to every interaction.
- Enforce role, channel, game-server, and interaction-ownership checks in both commands and component callbacks. Preserve staff checks and blocked edit destinations in message editing, and keep message-builder previews private until their owner confirms sending or saving.
- Preserve stable component IDs, central routing in `app/interactionRouter.js`, collector filters, timeout behavior, and existing restart handling for controls attached to messages. Old controls must remain compatible where supported or fail clearly without changing unrelated state.
- Keep displayed challenge, crown, giveaway, recruitment, application, and XP states aligned with confirmed operations. Prevent duplicate confirmations, awards, entries, draws, and notifications.
- Handle expired interactions, partial Discord objects, missing messages/channels, and permission failures using existing error patterns. Give actionable user feedback without exposing stack traces or private data.

## JavaScript and asynchronous behavior

- Keep code compatible with the supported Node.js versions and installed dependencies. Validate command, modal, imported JSON, forum, and image inputs at their boundaries.
- Keep Discord snowflakes and other large identifiers as strings across JSON, SQL, maps, and component IDs. Do not convert them to JavaScript `Number` and lose precision.
- Await asynchronous work or attach deliberate error handling. Avoid unhandled promise rejections, overlapping scans, unbounded request batches, and long synchronous work on the Discord event loop.
- Preserve existing queues, locks, in-flight promise sharing, and per-server state. Keep mutable state in the appropriate client, service, store, or session rather than adding unnecessary globals.
- Reuse `utils/abortable.js` and the existing startup/shutdown lifecycle. Preserve abort signals, bounded retries, timeouts, and cleanup. Shutdown must not rearm timers or restart a stopped monitor when an outstanding operation completes.
- Preserve background-task ownership and reconnect behavior. Register listeners and start jobs only once where intended; give new long-lived work a matching stop/cleanup path and wire it into shutdown.
- Follow existing logging, transport, and diagnostic patterns. Preserve credential redaction, incident deduplication, delayed outage alerts, and recovery notifications. Routine reconnects and successful operations should not create repeated staff alerts.

### Dates, times, and timezones

- Use UTC+0 by default for calculations, stored timestamps, fixed schedules, logs, and integrations unless a different timezone is explicitly specified. `index.js` sets `process.env.TZ` from `config.json`'s `botTimezone`, falling back to `Etc/UTC`; honor explicit configured display/calendar behavior without changing the instant represented.
- JavaScript `Date` represents an instant. Prefer explicit UTC or offset-bearing input, `Date.UTC`, UTC accessors, and `toISOString()` where appropriate. Convert known source timezones correctly; do not rely on the host's local timezone or append `Z` to a value without establishing that it is UTC.
- Preserve timestamp units and existing storage contracts: JavaScript timestamps are generally milliseconds, while Discord `<t:...>` timestamps use Unix seconds. Serialize new textual instants as ISO 8601 with `Z` or an explicit UTC offset unless an existing SQL or JSON format requires otherwise.
- For database time changes, check SQL writers, MySQL session timezone, driver conversion, and record readers together. The Node process timezone alone does not establish the database session timezone. Preserve the meaning of older records.
- Label fixed UTC dates and times `UTC` when shown to users. Preserve dynamic Discord timestamps so each viewer sees their local time; do not manually apply a viewer offset or label a localized display as UTC.

## Database and durable state

- When a schema change is applied manually, do not add code that supports the old schema. Once the change is confirmed, remove any temporary compatibility or migration code so no unused legacy paths remain.
- Change schemas only when required by the task. Never delete production data. Keep relevant `sql/` definitions, runtime schema setup, and store readers/writers compatible when a schema change is necessary.
- Reuse `db/db-conn.js`, feature stores, transactions, and shared retry/backoff behavior. Parameterize SQL values; use existing validated mappings for dynamic table names. Release acquired connections and preserve rollback behavior.
- Preserve `STORAGE_MODE` semantics: `auto` and `mysql` retain JSON recovery in features that support it; `json` does not synchronize those stores to MySQL. JSON mode is not a complete database replacement: scouting and some XP queries still require MySQL.
- Preserve stable record/operation IDs, status values, JSON formats, pending operations, SQL receipts, and replay order. A timeout may leave a write's outcome uncertain; retries must not duplicate a crown, giveaway result, XP award, activity counter, or delivery.
- Persist recovery work before relying on later synchronization. Clear pending work only after confirmed success, and track separate delivery destinations independently. Preserve protections against stale database snapshots overwriting newer local changes.
- Reuse `utils/jsonFile.js` for applicable JSON reads and writes. Preserve atomic replacement, write-failure handling, and corrupt-file preservation. Do not silently replace unreadable recovery state with empty defaults or report success after persistence fails.
- Treat ignored runtime files under `data/` as potentially essential recovery data. Do not remove, reset, or regenerate them as routine cleanup. Avoid editing live state while the bot is running; use temporary files and injected paths for tests. Preserve tracked reference data and its attribution.
- Follow `docs/operations.md` for backup and host migration. Distinguish durable state from rebuildable scout autocomplete snapshots and OCR language caches, and check actual usage before removing any file.

## Scouting, forum monitoring, and OCR

- Preserve scouting source message IDs, reply links, server identity, report dates, and review history. Distinct battles remain distinct records; explicit replies or linked continuations follow the existing team-merge rules. Do not merge reports solely because their member, opponent, or timestamps are similar.
- Preserve staff overrides, correction windows, source selection, and review-learning behavior when reparsing or refreshing reports. Reuse existing Pokemon normalization and parsing helpers; keep uncertain OCR evidence distinguishable from confirmed player or staff input.
- Preserve forum initial-baseline behavior, processed-post checkpoints, repeat-applicant rules, staff filtering, and pending notifications. Check application and shop monitors for shared parser/pagination changes without erasing their different audiences or delivery rules.
- Advance scan checkpoints only according to the existing durable-processing contract. Failed pages, incomplete scans, or partial Discord delivery must not silently lose pending work or create duplicate historical alerts, polls, or reminders.
- Reuse the shared OCR queue and helper process in `utils/runtimeMemoryOcr.js`, `utils/ocrProcessWorker.js`, and `utils/ocrProcessEntry.js`. Preserve idle/batch recycling, memory checks, worker failure recovery, and shutdown behavior; do not create a new Tesseract worker for each request or move expensive image processing into command handlers.
- Preserve download timeouts, response-size limits, content checks, and existing URL/redirect restrictions. Respect Discord and forum rate limits; reuse pagination, pacing, retries, and backoff. Reuse attachment-refresh helpers for expiring Discord URLs while preserving staff-selected images and source references.
- Keep manual preview, diagnostic, and recovery scripts separate from bot startup. Use preview or dry-run behavior where supported and review output before applying live repairs or deliveries within the authorized task.

## Writing style, documentation, and comments

- Write added or revised text in clear, natural, professional language. Use plain, specific wording with enough context; avoid robotic phrasing, filler, unnecessary jargon, and overly elaborate explanations.
- Use neutral wording in project text and reports. Avoid first-person language such as "I", "we", "us", "my", and "our". Addressing the user as "you" or "your" is acceptable when helpful.
- Add comments only for useful context that is not obvious from the code: reasoning, constraints, non-obvious behavior, or relevant references. Do not restate self-explanatory operations or describe the requested edit, prompt, or conversation.

### Documentation

- Default to leaving repository documentation unchanged for bug fixes, refactors, tests, and presentation edits. Restoring intended behavior alone does not justify documentation. Update documentation only when explicitly requested or when users or operators need different instructions to use, configure, maintain, or recover the bot correctly.
- Make the smallest necessary edit beside existing guidance, normally one to three sentences. Add a section only when a new capability or procedure requires it. Do not duplicate existing guidance or document minor UI wording, labels, spacing, or styling unless explicitly requested or needed to complete an operation correctly.
- Keep `README.md` focused on the overview, setup, configuration, and essential usage. Keep command access, operations, recovery, maintenance, and manual-script guidance in `docs/operations.md`; there is no separate scripts guide. Keep `AGENTS.md` focused on development instructions.
- Put change-specific implementation details, fix summaries, task history, test results, deployment reassurances, and compatibility notes requiring no operator action in the task response or pull request. One-time upgrade or migration steps for an existing installation, such as a database ALTER, also belong there, not in documentation. Do not create documents solely to record an edit. These restrictions apply to all repository documentation and code comments.
- Preserve user edits and removals throughout documentation. Do not restore user-removed details unless explicitly requested.

### Agent skills

- `.agents/skills/<name>/SKILL.md` holds the shared skill text for all AI coding agents. Each `.claude/skills/<name>/SKILL.md` is a pointer to that file with identical `name` and `description` frontmatter; keep the frontmatter in sync and edit only the shared copy's body.
- When a change alters behavior, file locations, commands, tests, configuration, or invariants that a skill describes, update that skill in the same change, even when user documentation stays unchanged. Correct or remove statements that no longer hold, and describe current behavior rather than change history.
- Add a skill, with its pointer, only for a substantial new feature or a recurring multi-step workflow whose details are not evident from the code or this file. Small features and one-off procedures do not need one, and skills must not repeat guidance already in this file or `docs/operations.md`.

## Tests and validation

- Start with the smallest relevant existing tests. Expand when shared behavior, impact, or unresolved risk warrants it; run the full suite before committing code. Do not rerun passing checks without a reason.
- Use the existing `node:test` and `node:assert/strict` patterns. Add or update meaningful tests for new logic, regressions, and changed behavior, including affected equivalent cases and intentional differences. Do not add tests that merely mirror implementation or test wording-only edits.
- Keep tests independent of production Discord, MySQL, and runtime files. Inject clients, stores, clocks, fetch functions, and workers as supported; use temporary directories and clean up timers, workers, and mocks. Importing a module can have side effects, so inspect its initialization before using it in a test.
- Do not remove or weaken valid tests merely to make them pass. Fix implementation failures unless expected behavior deliberately changed. Separate pre-existing or environment-related failures from regressions introduced by the change.
- Syntax-check changed executable JavaScript. For documentation-only changes, check wording, Markdown, commands, and referenced paths; application tests and bot startup are not required.
- For Discord changes, check labels, content, permissions, ownership, public/ephemeral visibility, interaction lifecycle, and existing-message compatibility. Review readability where possible and report when live or visual checks were not performed.
- For storage and recovery changes, verify failed writes, partial completion, replay, stable IDs, duplicate prevention, and confirmation before pending work is cleared. For shared PvP changes, cover Gold and Silver isolation and relevant Cross Server behavior.
- For parsing, forum, or OCR changes, use representative fixtures for affected cases and preserve sources and uncertainty. For background work, check overlapping runs, cancellation during startup or shutdown, reconnects, and cleanup.

## Reporting

- List changed files, what changed, and why. Report check commands and results, skipped checks and reasons, remaining work, and material verification limits. Include equivalence assumptions or intentional exclusions when applicable; keep detail proportional to the task.
- Distinguish local checks from actual Discord, database, forum, or deployment verification. Do not imply the bot was restarted, commands registered, messages delivered, or production behavior verified unless those actions occurred.
