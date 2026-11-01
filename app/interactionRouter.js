// Route commands and persistent controls, preserving their acknowledgement and error handling.
'use strict';

const { MessageFlags } = require('discord.js');
const { redactDiagnostic } = require('../utils/discordDiagnostics.js');
const { handleGiveawayButton } = require('../events/giveaways.js');
const { handleGuildForumFeedbackButton } = require('../features/guild-applications/index.js');

function createInteractionHandler({ lifecycle, interactionDiagnostics, commandMap, commandConfig,
    botDiagnostics, appConfig, consoleObject = console,
    giveawayButton = handleGiveawayButton, forumFeedbackButton = handleGuildForumFeedbackButton }) {
    const console = consoleObject;
    return async interaction => {
        if (lifecycle.stopping) return;
        interactionDiagnostics.track(interaction);
        try {
            // Autocomplete Handling
            if (interaction.isAutocomplete()) {
                const command = commandMap.get(interaction.commandName);
                if (command && typeof command.handleAutocomplete === 'function') {
                    return await command.handleAutocomplete(interaction);
                }
                return;
            }

            // Button Handling
            if (interaction.customId?.startsWith('scout-sources:')) {
                const manager = commandMap.get('scout-review')?.sourceManager || commandMap.get('scout-settings')?.sourceManager;
                if (manager && await manager.handleInteraction(interaction)) return true;
            }
            if (interaction.isButton()) {
                if (interaction.customId?.startsWith('send_message:')) {
                    const builder = commandMap.get('send_message');
                    if (builder && await builder.handleButton(interaction)) return true;
                }
                if (interaction.customId?.startsWith('scout-stats:page:')) {
                    const stats = commandMap.get('scout-stats');
                    if (stats && await stats.handleButton(interaction)) return true;
                }
                if (interaction.customId?.startsWith('cc-settings:') || interaction.customId?.startsWith('ww-settings:')) {
                    const settings = commandMap.get('cc-settings');
                    if (settings && await settings.handleButton(interaction)) return true;
                }
                if (interaction.customId?.startsWith('pvp-scout:')) {
                    const scout = commandMap.get('scout');
                    if (scout && await scout.handleButton(interaction)) return true;
                }
                if (interaction.customId?.startsWith('scout-settings:')) {
                    const settings = commandMap.get('scout-settings');
                    if (settings && await settings.handleButton(interaction)) return true;
                }
                // Review buttons need their acknowledgement before unrelated handlers do any work.
                if (interaction.customId?.startsWith('pvp-scout-review:')) {
                    const review = commandMap.get('scout-review');
                    if (review && await review.handleButton(interaction)) return true;
                }
                // Acknowledge giveaway buttons before walking unrelated command handlers.
                if (interaction.customId?.startsWith('cc_giveaway:') || interaction.customId?.startsWith('ww_giveaway:')) {
                    if (await giveawayButton(interaction, commandConfig)) return true;
                }
                if (await forumFeedbackButton(interaction, { ownerID: appConfig.ownerID })) return true;

                for (const command of new Set(commandMap.values())) {
                    if (typeof command.handleButton === 'function') {
                        const handled = await command.handleButton(interaction);
                        if (handled) return true;
                    }
                }
            }

            // Select Menu Handling
            if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
                if (interaction.customId?.startsWith('send_message:')) {
                    const builder = commandMap.get('send_message');
                    if (builder && await builder.handleSelect(interaction)) return true;
                }
                if (interaction.customId?.startsWith('scout-settings:')) {
                    const settings = commandMap.get('scout-settings');
                    if (settings && await settings.handleSelect(interaction)) return true;
                }
                for (const command of new Set(commandMap.values())) {
                    if (typeof command.handleSelect === 'function') {
                        const handled = await command.handleSelect(interaction);
                        if (handled) return true;
                    }
                }
            }

            // Modal Handling
            if (interaction.isModalSubmit()) {
                if (interaction.customId?.startsWith('send_message:')) {
                    const builder = commandMap.get('send_message');
                    if (builder && await builder.handleModal(interaction)) return true;
                }
                if (interaction.customId?.startsWith('pvp-scout:')) {
                    const scout = commandMap.get('scout');
                    if (scout && await scout.handleModal(interaction)) return true;
                }
                if (interaction.customId?.startsWith('scout-settings:')) {
                    const settings = commandMap.get('scout-settings');
                    if (settings && await settings.handleModal(interaction)) return true;
                }
                if (interaction.customId?.startsWith('pvp-scout-review:modal:')) {
                    const review = commandMap.get('scout-review');
                    if (review && await review.handleModal(interaction)) return true;
                }
                for (const command of new Set(commandMap.values())) {
                    if (typeof command.handleModal === 'function') {
                        const handled = await command.handleModal(interaction);
                        if (handled) return true;
                    }
                }
            }

            // Context Menu Handling (Right-click message)
            if (interaction.isMessageContextMenuCommand()) {
                // Check both properties: standard slash commands and context menu
                let command = [...commandMap.values()].find(cmd => cmd.data?.some?.(d => d.name === interaction.commandName));
                if (!command) command = commandMap.get(interaction.commandName);

                if (command) return await command.execute(interaction);
                return;
            }

            // Slash Command Handling
            if (interaction.isChatInputCommand()) {
                const command = commandMap.get(interaction.commandName);
                if (command) {
                    return await command.execute(interaction);
                }
                return;
            }
        } catch (err) {
            const interactionErrorCode = Number(err?.code || err?.rawError?.code);
            if (interactionErrorCode === 10062 || interactionErrorCode === 40060) {
                const reason = interactionDiagnostics.errorReason(interaction, interactionErrorCode);
                console.warn(interactionDiagnostics.describe(interaction, reason));
                return;
            }
            // Discord REST error objects contain the full interaction URL and token.
            // Keep diagnostics without printing that token into console logs.
            console.error(interactionDiagnostics.describe(interaction, 'failed'), {
                command: interaction.customId || interaction.commandName || 'unknown',
                interactionId: interaction.id,
                code: err?.code || err?.rawError?.code || null,
                message: redactDiagnostic(err?.message || String(err), botDiagnostics.secrets),
                stack: err?.stack ? redactDiagnostic(err.stack, botDiagnostics.secrets) : null
            });
            // Autocomplete interactions don't have reply/editReply methods
            if (interaction.isAutocomplete()) {
                return;
            }
            if (interaction.deferred || interaction.replied) {
                interaction.editReply({ content: '⚠️ Something went wrong!' }).catch(() => { });
            } else if (interactionDiagnostics.canAcknowledge(interaction)) {
                interaction.reply({ content: '⚠️ Something went wrong!', flags: MessageFlags.Ephemeral }).catch(() => { });
            }
        }
    };
}

module.exports = { createInteractionHandler };
