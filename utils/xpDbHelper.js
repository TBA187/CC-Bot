// Load XP tracks, rewards and activity totals with cached outage fallbacks.

const { getXpStore } = require('./xpStore');
const { abortable } = require('./abortable');

const AUTOCOMPLETE_LOOKUP_MS = 1500;

function parseJsonArray(value) {
    if (!value) return [];

    try {
        const parsed = typeof value === 'string' || Buffer.isBuffer(value)
            ? JSON.parse(value)
            : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        console.error('[XP DB HELPER] Error parsing JSON array:', err);
        return [];
    }
}

function parseJsonObject(value) {
    if (!value) return null;

    try {
        const parsed = typeof value === 'string' || Buffer.isBuffer(value)
            ? JSON.parse(value)
            : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
        console.error('[XP DB HELPER] Error parsing JSON object:', err);
        return null;
    }
}

function normalizeXpType(value) {
    if (value === null || value === undefined) return null;

    const xpType = String(value).trim();
    return xpType || null;
}

function getXpTypeFromTrackInfo(trackInfo) {
    if (!trackInfo) return null;

    return normalizeXpType(trackInfo.dbTrackName)
        || normalizeXpType(trackInfo.xpType)
        || normalizeXpType(trackInfo.id)
        || (trackInfo.type === 'global' ? 'global' : null);
}

function mapTrackRow(row) {
    return {
        id: row.id,
        name: row.name,
        roleIds: parseJsonArray(row.role_ids),
        channelIds: parseJsonArray(row.channel_ids),
        levelRewards: parseJsonArray(row.level_rewards),
        sendLevelUpMsg: row.send_level_up_msg === 1,
        tagUserLevelUpMsg: row.tag_user_level_up_msg === 1,
        cooldownOverrides: parseJsonObject(row.cooldown_overrides),
        color: row.color,
        createdAt: row.created_at
    };
}

const SPECIAL_TRACKS_CACHE_TTL_MS = Number(process.env.XP_TRACK_CACHE_TTL_MS || 60000);
const OUTAGE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const outageWarnings = new WeakMap();
const trackCaches = new WeakMap();
function getTrackCache(db) {
    let cache = trackCaches.get(db);
    if (!cache) {
        cache = { expiresAt: 0, tracks: db.xpStore?.getSpecialTracks() ?? null, request: null };
        trackCaches.set(db, cache);
    }
    return cache;
}

function reportXpDatabaseError(db, error, { context, write = false, fallback = '', prefix = '[XP DB HELPER]' }) {
    const unavailable = error?.code === 'DATABASE_UNAVAILABLE' || error?.isCircuitOpen
        || db?.isDatabaseUnavailableError?.(error);
    if (!unavailable) {
        console.error(`${prefix} ${context}:`, error);
        return;
    }

    // The pool already reports the outage and recovery. Keep XP's fallback
    // notices brief, with separate notices for reads and unsaved writes.
    const outageStartedAt = db.health?.outageStartedAt ?? null;
    let state = outageWarnings.get(db);
    if (!state || state.outageStartedAt !== outageStartedAt) {
        state = { outageStartedAt, loggedAt: new Map() };
        outageWarnings.set(db, state);
    }
    const kind = write ? 'write' : 'read';
    const now = Date.now();
    const lastLog = state.loggedAt.get(kind);
    if (lastLog !== undefined && now - lastLog < OUTAGE_LOG_INTERVAL_MS) return;
    state.loggedAt.set(kind, now);
    const code = db.getErrorCode?.(error) || error.causeCode || error.code || 'UNKNOWN';
    const detail = write
        ? 'XP/activity updates are retained in the persistent JSON queue for recovery.'
        : fallback;
    console.warn(`${prefix} ${context}: MySQL unavailable (${code}).${detail ? ` ${detail}` : ''}`);
}

/**
 * Fetch all special XP tracks from the database.
 * @param {object} db - MySQL database connection pool
 * @returns {Promise<Array>} Array of track objects
 */
async function fetchSpecialTracks(db) {
    const specialTracksCache = getTrackCache(db);
    const now = Date.now();
    if (specialTracksCache.tracks && now < specialTracksCache.expiresAt) {
        return specialTracksCache.tracks;
    }

    // Message, reaction and command events can request the same refresh.
    if (specialTracksCache.request) return specialTracksCache.request;
    const request = loadSpecialTracks(db, specialTracksCache);
    specialTracksCache.request = request;
    try {
        return await request;
    } finally {
        if (specialTracksCache.request === request) specialTracksCache.request = null;
    }
}

async function loadSpecialTracks(db, specialTracksCache) {
    try {
        const [rows] = await db.query(`
            SELECT id, name, role_ids, channel_ids, level_rewards,
                   send_level_up_msg, tag_user_level_up_msg,
                   cooldown_overrides, color, created_at
            FROM xp_channel_tracks
        `);

        const tracks = rows.map(mapTrackRow);
        specialTracksCache.expiresAt = Date.now() + SPECIAL_TRACKS_CACHE_TTL_MS;
        specialTracksCache.tracks = tracks;
        try { db.xpStore?.saveSpecialTracks(tracks); }
        catch (error) { console.error('[XP DB HELPER] Could not save XP track recovery settings:', error); }

        return tracks;
    } catch (err) {
        reportXpDatabaseError(db, err, {
            context: 'Error fetching special tracks',
            fallback: specialTracksCache.tracks ? 'Using cached special XP tracks.' : 'No cached special XP tracks are available.'
        });
        if (specialTracksCache.tracks) {
            return specialTracksCache.tracks;
        }

        return [];
    }
}

/**
 * Fetch a specific track by ID from the database.
 * @param {object} db - MySQL database connection pool
 * @param {number} trackId - The track ID
 * @returns {Promise<Object|null>} Track object or null if not found
 */
async function fetchTrackById(db, trackId, { requireMysql = false } = {}) {
    try {
        const [rows] = await db.query(`
            SELECT id, name, role_ids, channel_ids, level_rewards,
                   send_level_up_msg, tag_user_level_up_msg,
                   cooldown_overrides, color, created_at
            FROM xp_channel_tracks
            WHERE id = ?
        `, [trackId]);

        if (rows.length === 0) return null;
        return mapTrackRow(rows[0]);
    } catch (err) {
        if (requireMysql) throw err;
        reportXpDatabaseError(db, err, { context: `Error fetching track ${trackId}` });
        return null;
    }
}

/**
 * Resolve user-facing track input into the value stored in xp_user_levels.xp_type.
 * Blank/global input resolves to the global track; numeric input resolves by
 * track ID; non-numeric input resolves by exact track name for typed input.
 */
async function resolveXpTrack(db, trackInput) {
    const input = (trackInput || '').trim();

    if (!input || input.toLowerCase() === 'global') {
        return {
            xpType: 'global',
            displayName: 'Global',
            isGlobal: true,
            roleIds: [],
            channelIds: []
        };
    }

    const isNumericId = /^\d+$/.test(input);
    const tracks = await fetchSpecialTracks(db);
    const track = tracks.find(candidate => {
        if (isNumericId) return String(candidate.id) === input;
        return String(candidate.name || '').toLowerCase() === input.toLowerCase();
    });

    if (!track) {
        return null;
    }

    return {
        ...track,
        xpType: track.id.toString(),
        displayName: track.name,
        isGlobal: false
    };
}

function formatTrackChoiceName(row) {
    const suffix = ` (ID: ${row.id})`;
    const name = row.name || `Track ${row.id}`;
    const maxNameLength = Math.max(1, 100 - suffix.length);
    return `${name.slice(0, maxNameLength)}${suffix}`;
}

/**
 * Fetch autocomplete choices for XP track options. Choice values are numeric IDs
 * so selected slash-command values map directly to xp_user_levels.xp_type.
 */
// Autocomplete must answer within Discord's 3-second deadline, so it uses the cached track list and refreshes a
// stale list in the background. Only an empty cache waits for MySQL, and no longer than AUTOCOMPLETE_LOOKUP_MS.
async function fetchXpTrackAutocompleteChoices(db, focusedValue) {
    const cache = getTrackCache(db);
    let tracks = cache.tracks;
    if (!tracks || Date.now() >= cache.expiresAt) {
        const refresh = fetchSpecialTracks(db);
        if (tracks) refresh.catch(() => null);
        else tracks = await abortable(refresh, { timeoutMs: AUTOCOMPLETE_LOOKUP_MS }).catch(() => null);
    }
    const term = String(focusedValue || '').toLowerCase();
    return (tracks || [])
        .filter(track => String(track.name || '').toLowerCase().includes(term))
        .sort((first, second) => String(first.name || '').localeCompare(String(second.name || '')))
        .slice(0, 25)
        .map(track => ({ name: formatTrackChoiceName(track), value: String(track.id) }));
}

/**
 * Increment raw per-track activity counters. These counters represent eligible
 * XP-system activity before cooldown checks, while processXp tracks awarded XP.
 */
async function recordRawActivity(db, userId, guildId, username, xpType, actionType, statCount = 1) {
    const columnByAction = {
        message: 'total_messages_sent',
        reaction: 'total_reactions_added',
        command: 'total_commands_used',
        voice: 'total_voice_minutes'
    };

    const totalColumn = columnByAction[actionType];
    if (!totalColumn || statCount <= 0) return;

    const safeXpType = normalizeXpType(xpType);
    if (!safeXpType) {
        console.error(`[XP DB HELPER] Refusing to record raw ${actionType} activity without a valid xp_type.`);
        return;
    }

    try {
        await getXpStore(db).record({ kind: 'activity', userId, guildId, username,
            xpType: safeXpType, actionType, statCount });
    } catch (err) {
        reportXpDatabaseError(db, err, { context: `Error recording raw ${actionType} activity`, write: true });
    }
}

/**
 * Fetch rewards by their IDs from the database.
 * @param {object} db - MySQL database connection pool
 * @param {Array<number>} rewardIds - Array of reward IDs
 * @returns {Promise<Array>} Array of reward objects
 */
async function fetchRewardsByIds(db, rewardIds, { requireMysql = false } = {}) {
    if (!rewardIds || rewardIds.length === 0) return [];

    try {
        const placeholders = rewardIds.map(() => '?').join(',');
        const [rows] = await db.query(`
            SELECT id, level, description, role_id
            FROM xp_rewards
            WHERE id IN (${placeholders})
            ORDER BY level ASC
        `, rewardIds);

        return rows.map(row => ({
            id: row.id,
            level: row.level,
            description: row.description,
            roleId: row.role_id
        }));
    } catch (err) {
        if (requireMysql) throw err;
        reportXpDatabaseError(db, err, { context: 'Error fetching rewards by IDs' });
        return [];
    }
}

module.exports = {
    fetchSpecialTracks,
    fetchTrackById,
    fetchRewardsByIds,
    resolveXpTrack,
    getXpTypeFromTrackInfo,
    fetchXpTrackAutocompleteChoices,
    reportXpDatabaseError,
    recordRawActivity
};
