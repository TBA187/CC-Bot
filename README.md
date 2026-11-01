# Crow Control Bot

A Discord bot for the Crow Control guild, built with Node.js and discord.js. It brings Gold and Silver PvP scouting, PvP King challenges, dungeon recruitment, giveaways, XP rewards, guild applications and forum notifications into the server.

## Requirements

- Node.js 22 or later; Node.js 24 LTS is recommended.
- MySQL or MariaDB for production storage and scouting.
- A Discord application with a bot token and the **Server Members Intent** and **Message Content Intent** enabled.
- Server permissions for the enabled features, including viewing channels, reading message history, sending messages, embedding links and attaching files. Role panels require **Manage Roles**; application polls require **Send Polls**.

## Setup

1. Install dependencies from the repository root:

   ```sh
   npm ci
   ```

2. Create a `.env` file with the application credentials and database connection:

   ```dotenv
   TOKEN=your_discord_bot_token
   CLIENT_ID=your_discord_application_id
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=your_database_user
   DB_PASSWORD=your_database_password
   DB_NAME=your_database_name
   STORAGE_MODE=auto
   ```

3. Update [config.json](config.json) with the guild, role and channel IDs for your server. Configure the forum topics and notification destinations for any monitors you enable.
4. Apply the feature schemas in [sql/](sql/) to the configured database.
5. Start the bot:

   ```sh
   npm start
   ```

The bot registers its application commands in the configured guild at startup. Keep its highest role above the roles it manages.

## Commands and features

| Area | Commands and usage |
| --- | --- |
| Messages and embeds | `/send_message` opens a private builder with attachments, fields, media, timestamps and JSON import/export. `/edit_bot_msg` edits a bot message by channel and message IDs. Leaders, Admins and Officers can use both commands and the **Edit Bot Message (Officer)** and **Edit Bot Embed (Officer)** message context menus. |
| Bot latency | `/ping` shows gateway latency and the measured response latency. |
| PvP scouting | `/scout` searches opponent histories across Gold and Silver. `/scout-review` and `/scout-settings` provide staff review and management; `/scout-stats` shows archive totals. |
| PvP King | The `/pvp_*` commands manage challenges, crowns, cooldowns, events, history, statistics and leaderboards in each server's configured channel. |
| Guild preferences | `/cc-settings` saves a preferred game server. `/notifications` manages notification subscriptions. |
| XP and rewards | `/rank`, `/level` and `/leaderboard` show progress, with configurable activity tracking and role rewards. |
| Recruitment and events | Dungeon commands create team panels and reminders; `/giveaway` manages draws and participation. |
| Server administration | Auto-role panels, welcome messages and configurable audit logging support server management. |

Guild application monitoring posts Officer alerts and Court House polls. Forum shop monitoring delivers new-reply notifications to the configured owner. See [operations and configuration](docs/operations.md) for monitor settings, storage, backups and PvP event configuration.

## Operation

Runtime state is stored in MySQL and feature-specific files under `data/`. In `auto` and `mysql` modes, features with JSON recovery support preserve pending changes through database outages. Scouting and some XP queries require MySQL.

Console output and error stacks are mirrored to monthly files under `data/logs/`, with UTC timestamps and automatic storage maintenance. Log limits, recovery settings and host migration steps are documented in [operations](docs/operations.md).

## Development

See [AGENTS.md](AGENTS.md) for development conventions, testing requirements, and recovery safeguards.

Run syntax checks and the automated test suite:

```sh
node --check index.js
npm test
```

Application wiring and lifecycle live in [app/](app/), command modules in [commands/](commands/), gateway handlers in [events/](events/), scheduled jobs in [tasks/](tasks/), feature services in [features/](features/), and shared utilities in [utils/](utils/). Tests live in [test/](test/).

## Attribution

The bundled Pokémon species data is derived from [Pokémon Showdown's Pokédex](https://github.com/smogon/pokemon-showdown/blob/a5df8274e85b0889bf2a9b3422a08b39732374fc/data/pokedex.ts). Its [license notice](features/pvp-scouting/POKEMON_SHOWDOWN_LICENSE.txt) is included in the repository.
