// Connects auction storage, forum monitoring, and Discord subscription services.
'use strict';

const path = require('node:path');
const { AuctionForumClient } = require('./AuctionForumClient.js');
const { AuctionStore } = require('./AuctionStore.js');
const { AuctionMonitor } = require('./AuctionMonitor.js');
const { AuctionDiscordNotifier } = require('./AuctionDiscord.js');
const { AuctionFollowService } = require('./AuctionFollowService.js');

function createAuctionMonitor(options = {}) {
    const config = options.config || {};
    const store = options.store || new AuctionStore({
        dataFile: path.join(options.rootPath || path.resolve(__dirname, '../..'), 'data', 'forum_auctions.json'),
        db: options.db,
        storageMode: options.storageMode
    });
    const notifier = options.notifier || new AuctionDiscordNotifier({ client: options.client, channelId: config.auctionChannelID, config });
    const monitor = new AuctionMonitor({
        store,
        forumClient: options.forumClient || new AuctionForumClient({ fetch: options.fetch }),
        notifier,
        enabled: Boolean(config.auctionChannelID),
        intervalMs: options.intervalMs
    });
    monitor.followService = options.followService || new AuctionFollowService({ store, notifier,
        fetchAuction: id => monitor.fetchAuction(id), checkRunning: () => monitor.checkRunning() });
    return monitor;
}

module.exports = { createAuctionMonitor };
