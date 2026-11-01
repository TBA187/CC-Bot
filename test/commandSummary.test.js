/**
 * @fileoverview Verify startup command counts, grouped listings and loader routing without logging in to Discord.
 * Protect valid command registrations from missing names and duplicate internal aliases.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCommands } = require('../app/moduleLoader.js');
const { BotApplication } = require('../app/BotApplication.js');
const { REST } = require('discord.js');
const Module = require('node:module');
const { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { buildCommandSummary } = require('../utils/commandSummary.js');
const ScoutStats = require('../commands/scout-stats.js');
const messageCreate = require('../events/messageCreate.js');

test('startup counts executable commands once and lists subcommands relative to their group', () => {
    const commands = [
        { name: 'ping' },
        { name: 'admin', options: [
            { name: 'notifications', type: 1, options: [{ name: 'status', type: 3 }] },
            { name: 'tools', type: 2, options: [{ name: 'remove', type: 1 }, { name: 'add', type: 1 }] }
        ] },
        { name: 'Edit Bot Embed (Officer)', type: 3 },
        { name: 'Inspect Member', type: 2 }
    ];
    const result = buildCommandSummary(commands, [
        ...messageCreate.prefixCommands,
        { name: 'write', prefixes: ['!', '?'] }
    ]);
    assert.deepEqual(result.counts, {
        standaloneSlash: 1, subcommands: 3, contextMenus: 2, prefixCommands: 2,
        otherApplicationCommands: 0, total: 8
    });
    assert.deepEqual(result.lines, [
        "Loaded 8 commands:",
        " - Standalone slash commands (1): ping",
        " - Slash-command groups (1 group, 3 subcommands): admin: notifications, tools add, tools remove",
        " - Message context-menu commands (1): Edit Bot Embed (Officer)",
        " - User context-menu commands (1): Inspect Member",
        " - Prefix commands (2): welcome (!welcome / ?welcome), write (!write / ?write)"
    ]);
});

test('the actual command loader skips missing instance names while preserving declared routes and internal aliases', () => {
    class MultiCommand {
        constructor() {
            this.name = 'internal-helper';
            this.data = [
                new SlashCommandBuilder().setName('real-command').setDescription('A real slash command'),
                new ContextMenuCommandBuilder().setName('Edit Example').setType(ApplicationCommandType.Message)
            ];
        }
    }
    const commandMap = new Map();
    const context = {
        commandMap, commandConfig: {}, rootPath: path.resolve(__dirname, '..'),
        fileSystem: { readdirSync: () => ['scout-stats.js', 'multi.js'].map(name => ({ name, isDirectory: () => false })) },
        load: name => {
            if (path.basename(name) === 'scout-stats.js') return ScoutStats;
            if (path.basename(name) === 'multi.js') return MultiCommand;
            assert.fail('Unexpected command import: ' + name);
        }
    };
    const definitions = loadCommands(context);
    assert.equal(commandMap.has(undefined), false);
    assert.equal(commandMap.has(''), false);
    assert.ok(commandMap.get('scout-stats') instanceof ScoutStats);
    assert.equal(commandMap.get('real-command'), commandMap.get('internal-helper'));
    assert.equal(commandMap.get('Edit Example'), commandMap.get('internal-helper'));
    assert.deepEqual([...commandMap.keys()], ['scout-stats', 'internal-helper', 'real-command', 'Edit Example']);
    const result = buildCommandSummary(definitions, messageCreate.prefixCommands);
    assert.equal(result.counts.total, 5);
    assert.ok(result.lines.includes(' - Standalone slash commands (2): real-command, scout-stats'));
    assert.equal(result.lines.some(line => line.includes('internal-helper')), false);
    assert.equal(result.lines.some(line => line.includes('undefined') || /^\s*-\s*$/u.test(line)), false);
});

test('empty and singular startup counts remain correct and unknown application types are included', () => {
    assert.equal(buildCommandSummary([]).lines[0],
        'Loaded 0 commands:');
    assert.equal(buildCommandSummary([{ name: 'ping' }]).lines[0],
        'Loaded 1 command:');
    const other = buildCommandSummary([{ name: 'Activity', type: 4 }]);
    assert.equal(other.counts.total, 1);
    assert.ok(other.lines.includes(' - Other application commands (1): Activity'));
});

test('all current CC command declarations and loaded prefix forms appear in the startup inventory offline', t => {
    // Fail rather than initialize a database, read environment secrets, or write
    // runtime state while inspecting the real command builders.
    const originalLoad = Module._load;
    t.mock.method(Module, '_load', function(request, ...args) {
        assert.equal(/db-conn|dotenv/u.test(request), false, 'Unexpected runtime dependency: ' + request);
        return originalLoad.call(this, request, ...args);
    });
    for (const operation of ['writeFileSync', 'mkdirSync', 'renameSync', 'unlinkSync']) {
        t.mock.method(fs, operation, () => assert.fail('Command inventory attempted fs.' + operation));
    }
    const Dungeon = require('../commands/dungeon_recruitment.js');
    t.mock.method(Dungeon.prototype, 'loadPersistedRuns', () => {});
    const root = path.resolve(__dirname, '../commands');
    const definitions = [];
    const config = { ...require('../config.json'), pvpKingStores: { gold: {}, silver: {} } };
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
        const files = item.isDirectory()
            ? fs.readdirSync(path.join(root, item.name)).filter(name => name.endsWith('.js'))
                .map(name => path.join(root, item.name, name))
            : item.name.endsWith('.js') ? [path.join(root, item.name)] : [];
        for (const file of files) {
            const Command = require(file);
            const instance = new Command(config);
            for (const data of Array.isArray(instance.data) ? instance.data : [instance.data]) {
                definitions.push(data.toJSON());
            }
        }
    }
    const result = buildCommandSummary(definitions, messageCreate.prefixCommands);
    for (const definition of definitions) assert.ok(result.lines.some(line => line.includes(definition.name)), definition.name);
    assert.equal(result.lines.some(line => /^\s*-\s*$/u.test(line)), false);
    assert.equal(result.lines.some(line => line.includes('dungeon_recruitment')), false, 'An internal module alias is not a slash command');
    assert.equal(result.counts.prefixCommands, 2);
    t.diagnostic(result.lines.join('\n'));
});


test('startup prints dynamic prefix metadata beneath registration before event logs and loads modules once', async t => {
    const output = [], loaded = [], hooks = [];
    const rootPath = path.resolve(__dirname, '..');
    const fakeStore = { async restore() {}, startSyncLoop() {} };
    const application = new BotApplication({
        rootPath, appConfig: { guildId: 'guild' }, commandConfig: {}, commandMap: new Map(),
        token: 'offline-test-token', clientId: 'application',
        runtimeLogging: { logBlock: lines => output.push(...lines) },
        fileSystem: { readdirSync: directory => (directory.endsWith('commands') ? ['future.js']
            : ['future.js', 'future-group.js']).map(name => ({ name, isDirectory: () => false })) },
        load: file => {
            loaded.push(path.relative(rootPath, file).replaceAll('\\', '/'));
            if (file.includes(path.sep + 'commands' + path.sep)) return class {
                constructor() { this.data = new SlashCommandBuilder().setName('future_command').setDescription('Future'); }
            };
            if (file.endsWith('future.js')) return {
                name: 'messageCreate', execute() {}, prefixCommands: [{ name: 'future', prefixes: ['!', '?'] }]
            };
            return { register() { hooks.push('group'); }, prefixCommands: [{ name: 'group', prefixes: ['!'] }] };
        },
        db: { initPromise: Promise.resolve(true), query: async () => [[]] },
        guildSettings: { async sync() {} }, xpStore: fakeStore, pvpKingStores: { gold: fakeStore, silver: fakeStore },
        giveawayStore: fakeStore, notificationStore: fakeStore, memberHistory: fakeStore,
        scoutServers: { async warmAutocomplete() {} }, scoutServerSettings: { async hydratePreferences() {} },
        lifecycle: { run: task => task(), check() {}, preload: task => task(), stopping: false },
        consoleObject: { log: line => output.push(line), error: (...args) => assert.fail(JSON.stringify(args)) },
        client: { on: name => hooks.push(name), once: name => hooks.push(name), login: async () => hooks.push('login') }
    });
    t.mock.method(REST.prototype, 'put', async (route, payload) => {
        assert.equal(route, '/applications/application/guilds/guild/commands');
        assert.equal(payload.body[0].name, 'future_command');
    });
    await application.bootstrap();
    assert.deepEqual(loaded, ['commands/future.js', 'events/future.js', 'events/future-group.js']);
    assert.deepEqual(hooks, ['messageCreate', 'group', 'login']);
    const registered = output.indexOf('[CC LOG] Registering Guild slash commands...');
    assert.deepEqual(output.slice(registered, registered + 5), [
        '[CC LOG] Registering Guild slash commands...',
        '[CC LOG] ✅ Guild slash commands registered to Discord',
        'Loaded 3 commands:',
        ' - Standalone slash commands (1): future_command',
        ' - Prefix commands (2): future (!future / ?future), group (!group)'
    ]);
    assert.ok(output[registered + 5].startsWith('[CC LOG] Registered Event:'));
    assert.ok(output[registered + 6].startsWith('[CC LOG] Registered Event Group:'));
});
