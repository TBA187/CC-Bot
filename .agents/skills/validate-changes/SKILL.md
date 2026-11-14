---
name: validate-changes
description: Run the right offline checks for the current Crow Control changes and produce the change report required by AGENTS.md. Use after editing code, before committing, or when asked to test, validate or check the work.
---

# Validating changes

## 1. Check the Node.js version

```sh
node --version
```

The project requires Node.js 22 or later (24 recommended). Older versions fail tests for environment reasons, for example `Promise.withResolvers is not a function` on Node 20. If the active version is too old, run the checks with a Node 22+ executable instead and say so in the report; do not change code or tests to suit an older runtime. Switching the machine's default Node version (for example with `nvm use`) affects other projects, so leave that to the user.

## 2. Find what changed

```sh
git status --short
git diff --stat
```

Include untracked files. Never revert or discard work in the tree that this task did not create.

## 3. Syntax-check changed JavaScript

Run `node --check <file>` for every changed or new `.js` file. It parses without executing. Never import `index.js` to smoke-test startup: it connects to Discord and MySQL.

## 4. Run the smallest relevant tests first

Map each changed file to its tests. With Node 22+, `node --test` expands quoted glob patterns itself, so the commands work in PowerShell and Git Bash:

| Changed code | Start with |
| --- | --- |
| `features/auctions/` | `"test/auction*.test.js"` (see the `pro-auctions` skill) |
| `features/pvp-scouting/`, `commands/scout*.js`, `events/pvpScouting.js`, `events/scoutRoster.js` | `"test/scout*.test.js" "test/pvpScout*.test.js" test/pvpScouting.test.js test/pokemonScoutDetails.test.js test/guildMemberSettings.test.js` (see the `pvp-scouting` skill) |
| `commands/pvp-king/`, `tasks/cooldownNotifier.js` | `"test/pvpKing*.test.js" test/pvpHelper.test.js test/pvpHistoryMessages.test.js test/cooldownNotifier.test.js` |
| `features/guild-applications/` | `"test/guildApplication*.test.js" "test/guildForum*.test.js" test/proForumClient.test.js test/countryRegistry.test.js test/forumClientReliability.test.js test/forumMonitorLifecycle.test.js` |
| `features/tba-forum-shops/` | `"test/tbaForumShop*.test.js" test/forumClientReliability.test.js test/forumMonitorLifecycle.test.js` |
| `commands/giveaways.js`, `events/giveaways.js` | `"test/giveaway*.test.js"` |
| `utils/xp*.js`, `events/levels/`, `commands/levels/`, `config/xpConfig.js` | `"test/xp*.test.js"` |
| `features/message-builder/`, `commands/send_message.js`, `commands/edit_bot_msg.js` | `"test/messageBuilder*.test.js" test/editBotMsg.test.js` |
| `features/pro-notifications/`, `tasks/proNotifications.js`, `commands/notifications.js`, `commands/admin.js` | `test/proNotifications.test.js test/notificationStore.test.js test/notificationCommands.test.js` |
| `features/guild-settings/`, `commands/cc-settings.js` | `test/guildSettingsStore.test.js test/ccSettings.test.js` |
| `commands/dungeon_recruitment.js`, `events/dungeonRecruitmentReminder.js` | `"test/dungeon*.test.js"` |
| Audit log events, `utils/memberAudit*.js`, `utils/logHelpers.js` | `"test/memberAudit*.test.js" test/memberTimeoutEvents.test.js test/threadLogs.test.js test/loggingReliability.test.js test/boostVoiceEvents.test.js test/messageCreateWrite.test.js` |
| `commands/auto_roles.js`, `events/auto_roles.js`, `utils/serverTagRoleManager.js` | `test/autoRolesInteractions.test.js test/serverTagRoleManager.test.js` |
| `utils/runtimeMemoryOcr.js`, `utils/ocrProcess*.js`, `utils/runtimeHealth.js`, `utils/containerMemory.js` | `test/runtimeMemoryOcr.test.js test/ocrProcessWorker.test.js test/runtimeHealth.test.js test/containerMemory.test.js`, plus `test/guildApplicationOcr.test.js` and the scouting OCR tests when the OCR contract changes |
| `app/`, `index.js`, `utils/abortable.js`, `utils/commandRegistration.js` | `test/applicationModules.test.js test/botBootstrapShutdown.test.js test/startupShutdown.test.js test/messageBuilderRouting.test.js` |
| `utils/discordDiagnostics.js`, `utils/diagnosticIncidents.js`, or any changed log message | `test/discordDiagnostics.test.js` |
| `db/` | `test/databaseHealthTracker.test.js test/databaseShutdown.test.js`, plus the tests of affected stores |
| `utils/discordTransport.js`, `utils/interactionDiagnostics.js`, `utils/interactionLoading.js` | `test/discordTransport.test.js test/interactionDiagnostics.test.js test/interactionLoading.test.js` |
| `utils/runtimeLogging.js`, `utils/logFiles.js` | `test/runtimeLogging.test.js test/logFiles.test.js test/loggingReliability.test.js` |
| Other shared helpers in `utils/` | tests for every caller of the changed helper, found with a reference search |

When no row matches, search `test/` for imports of the changed module.

```sh
node --test test/<file>.test.js [test/<other>.test.js ...]
```

## 5. Run the full suite

Required before committing code:

```sh
npm test
```

If a test fails, fix the implementation. Change a test only when the expected behavior was changed on purpose, and say so in the report. Report failures caused by the environment (an old Node version, missing language data) separately from regressions.

## 6. Checks that tests cannot cover

- Discord changes: labels, content, permissions in callbacks, public versus ephemeral visibility, interaction lifecycle and compatibility with controls on existing messages. Note what was not checked in a real Discord client.
- Storage and recovery changes: failed writes, partial completion, replay, stable IDs and duplicate prevention, verified with injected stores or temporary files only.
- Manual scripts: preview modes only, and only when the task calls for it; `--send` modes publish to Discord.
- Documentation-only changes: Markdown, wording and every referenced path, command and link. Application tests are not required.

## 7. Report

Finish with:

- Every changed file, what changed in it and why.
- Each check command and its result, including failures and the Node version used.
- Skipped checks and the reason.
- Equivalent cases left unchanged on purpose (for example Gold versus Silver), and any assumptions about equivalence.
- Temporary, compatibility, migration or one-time code that still remains, why it stays, and when it can be removed.
- Remaining work and verification limits. Do not imply that the bot was restarted, commands were registered or messages were delivered unless that happened.
