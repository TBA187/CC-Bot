---
name: discord-command
description: Add or change a Crow Control slash command, context-menu command, button, select menu, modal, or Discord event module. Covers how app/moduleLoader.js discovers modules, the command class contract, component routing in app/interactionRouter.js, guild command registration, and the matching test pattern.
---

# Discord commands, controls, and events

The rules in AGENTS.md still apply. This skill covers the wiring that a new or changed command, control, or event must fit. The code is the source of truth: `app/moduleLoader.js`, `app/interactionRouter.js`, `app/createBotApplication.js`, and `app/BotApplication.js`. If this guide and the code disagree, follow the code.

## Where files go

- `app/moduleLoader.js` loads every `.js` file in `commands/` and one level of subfolders (for example `commands/levels/rank.js`), then calls `new Command(commandConfig)` on its export. A helper file at either level is constructed as a command and breaks startup. Put helpers two levels down (`commands/pvp-king/utils/`), in `features/`, or in `utils/`.
- `events/` uses the same one-level discovery, but event modules are required, not constructed.
- Start from the closest existing module: `commands/ping.js` (minimal), `commands/notifications.js` (member-owned ephemeral panel with a select and a button), `commands/send_message.js` (slash command plus context menu), and `commands/edit_bot_msg.js` (staff-only slash command plus context menu).

## Command class contract

```js
class Example {
    constructor(config) {
        this.name = 'example';
        this.data = new SlashCommandBuilder().setName('example').setDescription('...');
    }

    async execute(interaction) {}

    // Optional: handleAutocomplete, handleButton, handleSelect, handleModal
}

module.exports = Example;
```

- `config` is the `commandConfig` object built in `app/createBotApplication.js`. Read stores, role IDs, channel IDs, `db`, `onCooldown`, and `shutdownSignal` from it. A new dependency belongs in that object; do not create stores or open connections inside the command module.
- `data` may be a single builder or an array, such as a slash command plus a `ContextMenuCommandBuilder`. Every builder is registered and mapped to the command by its name.
- Staff access is checked in code against config role IDs (`leaderRoleID`, `adminRoleID`, `officerRoleID`); see `allowedRoles` in `commands/inspect.js` and `commands/edit_bot_msg.js`. Repeat the check in every component handler, not only in `execute`.
- Per-user cooldowns use `config.onCooldown(userId, key, seconds)`, which returns `true` while the user is on cooldown. Include the game server in the key when Gold and Silver need separate cooldowns.
- A command that keeps timers or other long-lived state can expose `stop()`; shutdown calls `stop?.()` on every loaded command.

## Buttons, selects, and modals

- After its explicit prefix routes, `app/interactionRouter.js` offers each component interaction to every command's `handleButton`, `handleSelect`, or `handleModal` in turn. A handler must return `false` immediately, without acknowledging, when the `customId` is not its own, and return `true` once it has handled the interaction.
- Give each command a unique `customId` prefix such as `example:action:` and keep IDs under Discord's 100-character limit. Existing prefixes are stable contracts for controls on old messages: do not rename them, and keep accepting legacy prefixes (see `cc-settings:` and `ww-settings:`).
- For controls owned by one member, put the owner's user ID in the `customId` and answer anyone else with an ephemeral rejection (see `parsePanelId` in `commands/notifications.js`).
- Add an explicit prefix route in `app/interactionRouter.js` only when the control must be acknowledged before the fallback loop runs, or when its handler is not a command (for example `auction:` buttons). Place it beside the matching existing routes.
- Acknowledge before slow work with `deferReply`, `deferUpdate`, or `withButtonLoading` from `utils/interactionLoading.js`. Let unexpected errors propagate: the router logs them with token redaction and sends the standard "Something went wrong" reply.
- Autocomplete goes to `handleAutocomplete` and must respond within Discord's 3-second deadline. Reuse cached results the way the scout commands do.

## Event modules

- Export either `{ name, execute(...args, config), once }` for a single listener, or `register(client, config)` for a group (for example `events/roleDetector.js`). The loader wraps `name`/`execute` listeners so thrown errors and rejected promises are logged and nothing runs during shutdown. Listeners attached inside `register` get no wrapper and need their own error handling.
- Event files whose names start with `xp` only run in guilds with XP enabled.
- `memberExit.js`, `channelLogs.js`, `integrationLogs.js`, `threadLogs.js`, and `userUpdatesLogger.js` are special-cased by filename in `registerEvents`. Renaming one silently drops its listeners.
- Check `config.shutdownSignal?.aborted` before delayed sends, and give timers or loops a stop path wired into shutdown (see the `wire-bot-feature` skill).

## Registration

At startup, `BotApplication.registerCommands` replaces the guild's entire command set with every loaded definition. New, renamed, or removed commands take effect only after a restart, and deleting a command file removes that command from Discord on the next start. Registration failures retry with backoff without blocking login.

## Tests and checks

- Construct the command with a minimal fake config and assert on `command.data.toJSON()` (names, options, choices). Call handlers with fake interaction objects that record `reply`, `deferUpdate`, and `editReply` calls. See `test/notificationCommands.test.js`; loader and event behavior is covered in `test/applicationModules.test.js`, and router behavior in `test/messageBuilderRouting.test.js`.
- Cover at least: a foreign `customId` returns `false` without acknowledging; another member or a non-staff user is rejected; the success path acknowledges exactly once.
- Run `node --check` on changed files and the targeted tests, then `npm test` before committing (see the `validate-changes` skill). Report that command registration and Discord appearance were not verified unless the bot was actually restarted against a test guild.
