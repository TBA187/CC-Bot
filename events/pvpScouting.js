// Keeps the scouting archive in sync with new, edited, and deleted channel messages.
'use strict';

const { canArchiveMessage } = require('../features/pvp-scouting/PvpScoutIngestor.js');

function scoutingContext(message, config) {
    const channelId = message?.channelId || message?.channel?.id;
    return config.scoutServers?.forChannel(channelId) || null;
}

module.exports = {
    register(client, config) {
        client.on('messageCreate', async message => {
            const context = scoutingContext(message, config);
            if (!context || !canArchiveMessage(message, client.user?.id)) return;
            try {
                await context.ingestor?.handleCreate(message);
            } catch (error) {
                console.error('[CC LOG] Failed to archive a PvP scouting message:', error);
            }
        });

        client.on('messageUpdate', async (_oldMessage, newMessage) => {
            const context = scoutingContext(newMessage, config);
            if (!context || !canArchiveMessage(newMessage, client.user?.id)) return;
            try {
                await context.ingestor?.handleUpdate(newMessage);
            } catch (error) {
                console.error('[CC LOG] Failed to update an archived PvP scouting message:', error);
            }
        });

        client.on('messageDelete', async message => {
            const context = scoutingContext(message, config);
            if (!context || !canArchiveMessage(message, client.user?.id)) return;
            try {
                await context.ingestor?.handleDelete(message);
            } catch (error) {
                console.error('[CC LOG] Failed to mark a deleted PvP scouting message:', error);
            }
        });

        client.on('messageDeleteBulk', async (messages, channel) => {
            const context = scoutingContext({ channelId: channel?.id || messages.first()?.channelId }, config);
            if (!context) return;
            try {
                await context.ingestor?.handleDeleteBulk(messages.values());
            } catch (error) {
                console.error('[CC LOG] Failed to mark bulk-deleted PvP scouting messages:', error);
            }
        });
    }
};
