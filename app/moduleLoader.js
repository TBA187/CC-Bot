// Discover commands and events without loading helpers from deeper directories.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function discoverModules(rootPath, directory, fileSystem = fs) {
    const directoryPath = path.join(rootPath, directory);
    const modules = [];
    for (const item of fileSystem.readdirSync(directoryPath, { withFileTypes: true })) {
        const basePath = item.isDirectory() ? `./${directory}/${item.name}/` : `./${directory}/`;
        const files = item.isDirectory()
            ? fileSystem.readdirSync(path.join(directoryPath, item.name)).filter(file => file.endsWith('.js'))
            : item.name.endsWith('.js') ? [item.name] : [];
        for (const file of files) modules.push({ file, basePath, path: path.resolve(rootPath, basePath, file) });
    }
    return modules;
}

function loadCommands({ rootPath, commandConfig, commandMap, fileSystem, load = require }) {
    const definitions = [];
    for (const entry of discoverModules(rootPath, 'commands', fileSystem)) {
        const Command = load(entry.path);
        const command = new Command(commandConfig);
        if (typeof command.name === 'string' && command.name.trim()) commandMap.set(command.name, command);
        for (const data of Array.isArray(command.data) ? command.data : [command.data]) {
            const definition = data.toJSON();
            definitions.push(definition);
            if (definition.name) commandMap.set(definition.name, command);
        }
    }
    return definitions;
}

function loadEvents({ rootPath, fileSystem, load = require }) {
    const prefixCommands = [];
    const modules = discoverModules(rootPath, 'events', fileSystem).map(entry => {
        const event = load(entry.path);
        if (typeof event.register === 'function' || (event.name && typeof event.execute === 'function')) {
            prefixCommands.push(...(event.prefixCommands || []));
        }
        return { ...entry, event };
    });
    return { modules, prefixCommands };
}

function registerEvents({ modules, client, commandConfig, lifecycle, consoleObject = console }) {
    const { logChannelID, guildSettingsCache } = commandConfig;
    // EventEmitter does not await listeners. Observe both thrown errors and rejected promises here.
    const listen = (name, handler, once = false) => {
        client[once ? 'once' : 'on'](name, (...args) => {
            if (lifecycle.stopping) return;
            try {
                return Promise.resolve(handler(...args)).catch(error => consoleObject.error(`[CC LOG] Event ${name} failed:`, error));
            } catch (error) {
                consoleObject.error(`[CC LOG] Event ${name} failed:`, error);
            }
        });
    };
    for (const { file, basePath, event } of modules) {
        if (file === 'memberExit.js') {
            event.initializeTimeoutTracking(client, commandConfig);
            listen('guildMemberRemove', member => event.handleMemberRemove(member, logChannelID));
            listen('guildBanAdd', ban => event.handleGuildBanAdd(ban, logChannelID));
            listen('guildBanRemove', ban => event.handleGuildBanRemove(ban, logChannelID));
            listen('guildMemberUpdate', (oldM, newM) => event.handleGuildMemberUpdate(oldM, newM, logChannelID));
        } else if (file === 'channelLogs.js') {
            listen('channelCreate', channel => event.handleChannelCreate(channel, commandConfig));
            listen('channelDelete', channel => event.handleChannelDelete(channel, commandConfig));
            listen('channelUpdate', (oldC, newC) => event.handleChannelUpdate(oldC, newC, commandConfig));
        } else if (file === 'integrationLogs.js') {
            listen('webhooksUpdate', channel => event.handleWebhookUpdate(channel, commandConfig));
        } else if (file === 'threadLogs.js') {
            listen('threadCreate', thread => event.handleThreadCreate(thread, commandConfig));
            listen('threadDelete', thread => event.handleThreadDelete(thread, commandConfig));
            listen('threadUpdate', (oldT, newT) => event.handleThreadUpdate(oldT, newT, commandConfig));
        } else if (file === 'userUpdatesLogger.js') {
            listen('userUpdate', (oldU, newU) => event.handleUserUpdate(oldU, newU, commandConfig));
            listen('guildMemberUpdate', (oldM, newM) => event.handleGuildMemberUpdate(oldM, newM, commandConfig));
        } else if (typeof event.register === 'function') {
            event.register(client, commandConfig);
            consoleObject.log(`[CC LOG] Registered Event Group: ${basePath}${file}`);
        } else if (event.name && typeof event.execute === 'function') {
            const isXPFile = file.toLowerCase().startsWith('xp');
            listen(event.name, (...args) => {
                if (isXPFile) {
                    const data = args[0];
                    const guildId = data?.guild?.id || data?.message?.guild?.id || data?.guildId;
                    if (!guildId || !guildSettingsCache.get(String(guildId))?.xpEnabled) return;
                }
                return event.execute(...args, commandConfig);
            }, event.once);
            consoleObject.log(`[CC LOG] Registered Event: ${event.name} (${basePath}${file})`);
        }
    }
}

module.exports = { discoverModules, loadCommands, loadEvents, registerEvents };
