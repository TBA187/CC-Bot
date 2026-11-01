'use strict';

// Shared defaults for the PRO forum monitor, parsing, storage, and Discord notices.
const path = require('path');

const TOPIC_URL = 'https://pokemonrevolution.net/forum/topic/228820-crow-control-in-both-servers-ready-for-new-members/';
const TOPIC_ID = '228820';
const TEMPLATE_FORUM_USER_ID = '163701';
const TEMPLATE_FORUM_USERNAME = 'vangogsan';

module.exports = Object.freeze({
    TOPIC_URL,
    TOPIC_ID,
    TOPIC_ORIGIN: new URL(TOPIC_URL).origin,
    TEMPLATE_FORUM_USER_ID,
    TEMPLATE_FORUM_USERNAME,
    STORAGE_VERSION: 1,
    STORAGE_SYNC_INTERVAL_MS: 30 * 1000,
    MONITOR_INTERVAL_MS: 10 * 60 * 1000,
    VOTE_REMINDER_INTERVAL_MS: 5 * 60 * 1000,
    POLL_LIFETIME_MS: 24 * 60 * 60 * 1000,
    VOTE_REMINDER_12H_MS: 12 * 60 * 60 * 1000,
    VOTE_REMINDER_18H_MS: 18 * 60 * 60 * 1000,
    MAX_BACKOFF_MS: 30 * 60 * 1000,
    MAX_OCR_IMAGES: 2,
    MAX_IMAGE_BYTES: 10 * 1024 * 1024,
    IMAGE_DOWNLOAD_TIMEOUT_MS: 20 * 1000,
    FORUM_REQUEST_TIMEOUT_MS: 30 * 1000,
    DEFAULT_DATA_FILE: path.join(process.cwd(), 'data', 'guild_applications.json'),
    CLASSIFICATIONS: Object.freeze({
        APPLICATION: 'application',
        NON_APPLICATION: 'non_application',
        IGNORED_AUTHOR: 'ignored_author',
        DUPLICATE_USER: 'duplicate_user'
    }),
    JSON_SOURCES: Object.freeze({
        MYSQL_FALLBACK: 'mysql_fallback',
        JSON_ONLY: 'json_only'
    })
});
