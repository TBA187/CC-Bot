'use strict';

// Settings shared by the two lightweight PRO shop monitors.
const path = require('path');

module.exports = Object.freeze({
    DATA_VERSION: 2,
    DEFAULT_DATA_FILE: path.join(process.cwd(), 'data', 'tba_forum_shops.json'),
    EMBED_COLOR: 0xe63b50,
    SHOP_EMBED_COLORS: Object.freeze({
        forumShop: 0xffd700,
        dungeonShop: 0x00008b
    }),
    IGNORED_FORUM_USERNAME: 'tba7',
    IMAGE_DOWNLOAD_TIMEOUT_MS: 20 * 1000,
    MAX_IMAGE_BYTES: 10 * 1024 * 1024,
    MAX_BACKOFF_MS: 30 * 60 * 1000,
    MONITOR_INTERVAL_MS: 12 * 60 * 1000,
    FORUM_SHOP_START_DELAY_MS: 3 * 60 * 1000,
    DUNGEON_SHOP_START_DELAY_MS: 7 * 60 * 1000,
    REQUEST_TIMEOUT_MS: 30 * 1000
});
