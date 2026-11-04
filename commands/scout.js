// /scout shows saved reports and lets members add a report for the current opponent.
'use strict';

const { randomBytes } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    FileUploadBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    RadioGroupBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    TextDisplayBuilder
} = require('discord.js');
const { canonicalIgn, cleanIgn, isClearlyOffTopicText, normalizeIgn } = require('../features/pvp-scouting/PvpScoutParser.js');
const { matchSpeciesHeading, nameKey, recognizedTerms } = require('../features/pvp-scouting/PokemonTeamParser.js');
const { authorDisplays } = require('../features/pvp-scouting/ScoutAuthorDisplay.js');
const { downloadImageAttachment, refreshImageAttachments, reuseFreshImageAttachments,
    imageAttachment, uniqueImageAttachments: uniqueImages, sameImageUrl, urlIsFresh } = require('../features/pvp-scouting/ScoutImageUrls.js');
const { partitionReportSources, reportSourceDetails, sameAuthor, teamDisplayText } = require('../features/pvp-scouting/ScoutReportSources.js');
const { mergeTeamLines, teamMergeNotice } = require('../features/pvp-scouting/ScoutTeamMerge.js');
const { isButtonLoading } = require('../utils/interactionLoading.js');
const { scoutPayload, withScoutLoading } = require('../features/pvp-scouting/ScoutPresentation.js');
const { packTeamPages } = require('../features/pvp-scouting/ScoutTeamPages.js');
const { SERVERS, ScoutServerSettings, canUseGuildSettings, logServerSelectionFailure, serverSelectionFailureMessage } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { bindServer } = require('../features/pvp-scouting/ScoutStaffServers.js');
const { ScoutArchiveView, utcDate: ratingDate, reportServer, reportRating: savedPvpRating, sortReports } = require('../features/pvp-scouting/ScoutArchiveView.js');
const { detailQuery, matchesDetails, reportDateRange, suggestionLabel } = require('../features/pvp-scouting/ScoutSearch.js');

const BUTTON_PREFIX = 'pvp-scout:page:';
const IMAGE_PREFIX = 'pvp-scout:images:';
const TEAM_PREFIX = 'pvp-scout:teams:';
const HISTORY_PREFIX = 'pvp-scout:history:';
const ADD_PREFIX = 'pvp-scout:add:';
const MODAL_PREFIX = 'pvp-scout:add-modal:';
const SEARCH_MODAL_PREFIX = 'pvp-scout:search-modal:';
const PAGE_NUMBER_MODAL_PREFIX = 'pvp-scout:page-number-modal:';
const SERVER_PREFIX = 'pvp-scout:server:';
const SWITCH_PREFIX = 'pvp-scout:switch:';
const SERVER_SELECT_PREFIX = 'pvp-scout:server-select:';
const SORT_MODAL_PREFIX = 'pvp-scout:sort-modal:';
const SORTS = Object.freeze({ newest: 'Newest Scouts', oldest: 'Oldest Scouts', rating: 'Highest PvP Rating',
    gold: 'Gold Server first', silver: 'Silver Server first', alternating: 'Alternating between both servers' });
const MAX_DESCRIPTION = 3900;
const HISTORY_PAGE_SIZE = 10;
const RESULT_CACHE_MS = 15_000;
const RESULT_CACHE_SIZE = 25;
const AUTOCOMPLETE_REPLY_BY_MS = 2500;
const teamSearchIndexCache = new WeakMap();

async function autocompleteWithinDeadline(lookup, waitMs, fallback) {
    let timer;
    // Observe a late rejection even when an already-old interaction has no
    // time left to wait for its query.
    const result = Promise.resolve(lookup).catch(() => fallback());
    try {
        if (waitMs <= 0) return fallback();
        return await Promise.race([
            result,
            new Promise(resolve => { timer = setTimeout(() => resolve(fallback()), waitMs); })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function safeText(value, max = 1000) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.length <= max) return text;
    if (max <= 0) return '';
    const suffix = '\n… (truncated)';
    return max <= suffix.length ? `${text.slice(0, max - 1)}…` : `${text.slice(0, max - suffix.length)}${suffix}`;
}

function pageButton(label, customId, style, disabled) {
    return new ButtonBuilder()
        .setLabel(label)
        .setCustomId(customId)
        .setStyle(style)
        .setDisabled(disabled);
}

function buttonRows(actions, navigation = []) {
    const rows = [new ActionRowBuilder().addComponents(...actions)];
    if (navigation.length) rows.push(new ActionRowBuilder().addComponents(...navigation));
    return rows;
}

function bestImage(sources) {
    for (const source of sources) {
        for (const attachment of source.attachments || []) {
            if (imageAttachment(attachment)) {
                return { url: attachment.url };
            }
        }
    }
    return null;
}

// Share the same team/notes distinction with the public report and history.
function sourceTeamDetails(source, ign, root = source) {
    const { teamText: teamValue, notes: noteValue } = reportSourceDetails(source, ign, root);
    const team = safeText(teamDisplayText(teamValue, ign), Infinity);
    return {
        teamValue, noteValue, team,
        hasTeam: Boolean(team && (source.review_status === 'corrected' || teamValue !== noteValue || !noteValue)),
        notes: source.review_status === 'corrected' && source.team_text && source.notes === source.message_content
            ? '' : safeText(noteValue, 700)
    };
}

function reportedTitle(count, noun, ign) {
    if (count === 1) return `Latest Reported ${noun} — ${ign}`;
    return `${count ? `Last ${count}` : 'No'} Reported ${noun}s — ${ign}`;
}

function historyData(results) {
    const teams = [];
    for (const { root, sources } of results) {
        const { visibleSources } = partitionReportSources(root, sources);
        const lines = [];
        for (const source of visibleSources) {
            const { team, hasTeam } = sourceTeamDetails(source, root.opponent_ign, root);
            if (!hasTeam || /^(?:[-—–\s]*|\*?none\*?|n\/?a|null)$/iu.test(team)) continue;
            for (const line of team.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
                if (/^(?:[-—–\s]*|\*?none\*?|n\/?a|null)$/iu.test(line)) continue;
                lines.push(/^[-•]\s/u.test(line) ? line.replace(/^•/u, '-') : `- ${line}`);
            }
        }
        const merged = mergeTeamLines(lines);
        if (merged.teamText) teams.push({ root, sources: visibleSources, rawTeam: merged.teamText,
            team: [boldTeamNames(merged.teamText), ...merged.unassigned, teamMergeNotice(merged)].filter(Boolean).join('\n') });
    }
    teams.sort((a, b) => (new Date(b.root.created_at).getTime() || 0) - (new Date(a.root.created_at).getTime() || 0)
        || String(b.root.message_id).localeCompare(String(a.root.message_id), 'en', { numeric: true }));
    return { teams };
}

function pokemonQuery(value) {
    const input = String(value || '').trim();
    const heading = matchSpeciesHeading(input, { allowBroadAlias: true });
    if (!heading?.species || nameKey(input.slice(heading.end))) return null;
    return { species: heading.species, label: heading.species === 'Lugia-Shadow' ? 'XD001' : heading.species };
}

function speciesMatchesSearch(species, requested) {
    if (species === requested) return true;
    // Base-species searches include forms, while an explicit form stays narrow.
    // Porygon-Z is a separate evolution, rather than a Porygon form.
    return requested !== 'Porygon' && species.startsWith(`${requested}-`);
}

function teamSearchIndex(entry) {
    let index = teamSearchIndexCache.get(entry);
    if (index) return index;
    const rows = entry.rawTeam.split('\n').map(line => {
        const row = line.match(/^(\s*[-•]\s*)(.+)$/u);
        return { line, row, heading: row && matchSpeciesHeading(row[2], { allowTypo: true, allowBroadAlias: true }) };
    });
    const detailsBySpecies = new Map();
    for (const { row, heading } of rows) {
        if (!heading?.species) continue;
        const existing = detailsBySpecies.get(heading.species) || '';
        detailsBySpecies.set(heading.species, `${existing}; ${row[2].slice(heading.end)}`);
    }
    index = { rows, detailsBySpecies };
    teamSearchIndexCache.set(entry, index);
    return index;
}

function highlightedTeam(entry, search) {
    let found = false;
    const { rows, detailsBySpecies } = teamSearchIndex(entry);
    // Highlight the same team rows used by the report and history pages.
    const team = rows.map(({ line, row, heading }) => {
        if (!heading?.species || search.species && !speciesMatchesSearch(heading.species, search.species)
            || !matchesDetails(detailsBySpecies.get(heading.species), search.details)) return boldTeamNames(line);
        found = true;
        const details = highlightMatchedDetails(row[2].slice(heading.end), search.details);
        return `> - 🔎\u2002__**${row[2].slice(0, heading.end).trim()}**__${details}`;
    }).join('\n');
    return found ? { ...entry, team } : null;
}

function highlightMatchedDetails(text, requirements = []) {
    if (!requirements?.length) return text;
    const required = new Set(requirements.map(term => `${term.kind}:${term.name}`));
    const words = [...String(text).matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
    const spans = [];
    for (let index = 0; index < words.length;) {
        let match = null;
        for (let count = Math.min(5, words.length - index); count >= 1; count--) {
            const candidate = words.slice(index, index + count).map(word => word[0]).join(' ');
            const parsed = recognizedTerms(candidate, { allowTypo: true });
            const term = parsed.found.length === 1 && !nameKey(parsed.leftover) && parsed.found[0];
            if (term && required.has(`${term.kind}:${term.name}`)) {
                match = { count, start: words[index].index,
                    end: words[index + count - 1].index + words[index + count - 1][0].length };
                break;
            }
        }
        if (match) {
            spans.push(match);
            index += match.count;
        } else index++;
    }
    if (!spans.length) return text;
    let output = '', offset = 0;
    for (const span of spans) {
        output += `${text.slice(offset, span.start)}__**${text.slice(span.start, span.end)}**__`;
        offset = span.end;
    }
    return output + text.slice(offset);
}

async function teamCredits(entry, guild) {
    const { rootSource, originalSources, replies, additionalSources } = partitionReportSources(entry.root, entry.sources);
    const authors = await authorDisplays(guild, entry.sources);
    const links = [];
    const seen = new Set();
    const addLink = (source, label) => {
        const url = source?.source_url || '';
        if (!/^https:\/\/discord\.com\/channels\/\d{1,20}\/\d{1,20}\/\d{1,20}$/u.test(url) || seen.has(url)) return;
        seen.add(url);
        links.push(`[**${label}** ↗️](${url})`);
    };
    addLink(rootSource, 'Jump to message');
    if (!links.length) {
        for (const source of originalSources) {
            addLink(source, 'Jump to message');
            if (links.length) break;
        }
    }
    for (const source of [...replies, ...additionalSources]) {
        if (!sameAuthor(source, rootSource)) addLink(source, 'Jump to reply');
    }
    return `-# Scouted by: ${authors}${links.length ? ` • ${links.join(' • ')}` : ''}`;
}

function averagePvpRatingDescription(results) {
    // Count each grouped report once; continuations and replies are its sources.
    const reports = [...new Map(results.map(item => [String(item.root.message_id), item.root])).values()];
    const rated = reports.filter(root => savedPvpRating(root) !== null);
    if (!rated.length) return '**Average PvP Rating:** *No PvP ratings have been reported yet.*';
    const average = Math.round(rated.reduce((sum, root) => sum + savedPvpRating(root), 0) / rated.length);
    const dates = rated.map(root => ratingDate(root.created_at)).filter(Boolean).sort();
    const range = dates.length ? `\u2002(${dates[0]}${dates.length > 1 ? ` — ${dates[dates.length - 1]}` : ''})` : '';
    return `- **Average PvP Rating:** **${average}**${range}\n  - Based on PvP ratings reported in **\`${rated.length}\`** of **\`${reports.length}\`** scout report${reports.length === 1 ? '' : 's'}.`;
}

function lastPvpRatingDescription(results) {
    let latest = null;
    for (const { root } of results) {
        if (savedPvpRating(root) === null) continue;
        if (!latest || new Date(root.created_at).getTime() > new Date(latest.created_at).getTime()) latest = root;
    }
    return latest ? `- **Last reported PvP Rating:** **${savedPvpRating(latest)}**${ratingDate(latest.created_at) ? ` (${ratingDate(latest.created_at)})` : ''}` : '';
}

function crossRatingDescription(results, includeLatest = false) {
    const summaries = ['**Average PvP Rating:**'];
    const latest = [];
    for (const key of ['gold', 'silver']) {
        const reports = results.filter(item => reportServer(item.root) === key);
        const server = SERVERS[key];
        const average = averagePvpRatingDescription(reports)
            .replace(/^- \*\*Average PvP Rating:\*\* /u, '').replace(/^\*\*Average PvP Rating:\*\* /u, '')
            .replace(/reported in (\d+) of/u, 'reported in **$1** of');
        summaries.push(`- ${server.markup} ${server.label}: ${average}`);
        const rating = lastPvpRatingDescription(reports).replace(/^- \*\*Last reported PvP Rating:\*\* /u, '');
        latest.push(`- ${server.markup} ${server.label}: ${rating || '*No PvP ratings have been reported yet.*'}`);
    }
    return summaries.join('\n') + (includeLatest ? `\n\n**Last reported PvP Rating:**\n${latest.join('\n')}` : '');
}

function historyTeamBlock({ root, team, credits = '' }, cross = false) {
    const time = new Date(root.created_at).getTime();
    let date = Number.isFinite(time) ? `<t:${Math.floor(time / 1000)}:F>` : 'Unknown date';
    const rating = savedPvpRating(root);
    if (rating !== null) date += ` — PvP Rating: **${rating}**`;
    if (cross) date = `${SERVERS[reportServer(root)].markup} ${date}`;
    const full = `${date}\n${team}\n${credits}`;
    if (full.length <= 4096) return full;
    // One team cannot span descriptions. Keep its source links available when
    // even a dedicated embed cannot hold the complete date/team/credit block.
    return `${date}\n*This team's full details exceed Discord's embed limit. Open the scout message links below to read the complete team.*\n${credits}`;
}

function boldTeamNames(team) {
    return String(team || '').split('\n').map(line => {
        const row = line.match(/^(\s*[-•]\s*)(.+)$/u);
        if (!row) return line;
        const heading = matchSpeciesHeading(row[2]);
        if (!heading?.species || !heading.end) return line;
        return `${row[1]}**${row[2].slice(0, heading.end).trim()}**${row[2].slice(heading.end)}`;
    }).join('\n');
}

function sourceLinkFields(sources, kind = 'original') {
    const urls = sources.map(source => source.source_url).filter(Boolean);
    if (kind === 'original') urls.splice(1);
    const singular = kind === 'reply' ? 'Message reply' : kind === 'linked' ? 'Linked scout source' : 'Original message';
    const plural = kind === 'reply' ? 'Message replies' : kind === 'linked' ? 'Linked scout sources' : 'Original messages';
    if (urls.length === 1) return [{
        name: singular, value: `[**Jump to ${kind === 'reply' ? 'reply' : 'message'}**  ↗️](${urls[0]})`, inline: false
    }];
    if (!urls.length) return [];

    const groups = [];
    let group = [];
    for (const [index, url] of urls.entries()) {
        const link = `[**${kind === 'reply' ? 'Reply' : 'Message'} ${index + 1}**](${url})`;
        const next = [...group, link].join(' • ');
        if (group.length && next.length > 1000) {
            groups.push(group);
            group = [link];
        } else group.push(link);
    }
    if (group.length) groups.push(group);
    return groups.map((items, index) => ({
        name: index ? `${plural} (continued ${index + 1})` : plural,
        value: items.join(' • '), inline: false
    }));
}

function justIgn(text, ign) {
    const compact = value => String(value || '').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
    return compact(text) && compact(text) === compact(ign);
}

function identityWarningFor(ign, identity) {
    const name = `**${identity?.mention || safeText(canonicalIgn(ign), 64)}**`;
    if (identity?.type === 'member') return `-# ⚠️ ${name} is a current/former Crow Control member. Please accept or send a **draw request** using the \`/draw\` command in the in-game chat.`;
    if (identity?.type === 'friend') return `-# ⚠️ ${name} is a friend of Crow Control. Please accept or send a **draw request** using the \`/draw\` command in the in-game chat.`;
    return '';
}

function buildScoutEmbed(root, sources, index, total, authorNames = null, identity = null, ratingSummary = '', mode = reportServer(root)) {
    const { visibleSources, originalSources, replies, additionalSources } = partitionReportSources(root, sources);
    const originalIds = new Set(originalSources.map(source => String(source.message_id)));
    const orderedSources = [...originalSources, ...replies, ...additionalSources];
    const contributors = [...new Set(visibleSources.map(source => String(source.author_username || '').trim()).filter(Boolean))];
    const teamParts = [];
    const laterNotes = [];
    const noteParts = [];
    for (const source of visibleSources) {
        const fromAnotherMember = !originalIds.has(String(source.message_id));
        const { teamValue, noteValue, team, hasTeam, notes } = sourceTeamDetails(source, root.opponent_ign, root);
        if (hasTeam) {
            for (const line of team.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
                teamParts.push(line);
            }
        }
        if (notes && noteValue !== teamValue && !justIgn(notes, root.opponent_ign)) {
            const destination = fromAnotherMember ? laterNotes : noteParts;
            if (!destination.includes(notes)) destination.push(notes);
        }
        if (!hasTeam && !notes && source.message_content
            && !justIgn(source.message_content, root.opponent_ign)) {
            const raw = safeText(source.message_content, 700);
            const destination = fromAnotherMember ? laterNotes : noteParts;
            if (raw && !destination.includes(raw)) destination.push(raw);
        }
    }
    const merged = mergeTeamLines(teamParts);
    const allNotes = [...new Set([...noteParts, ...laterNotes, ...merged.unassigned])];
    const body = [
        merged.teamText ? `**Pokémon Team**\n${boldTeamNames(merged.teamText)}` : null,
        teamMergeNotice(merged),
        allNotes.length ? `**Additional Notes**\n${allNotes.join('\n')}` : null
    ].filter(Boolean).join('\n\n');
    const sourceFields = [
        ...sourceLinkFields(originalSources),
        ...sourceLinkFields(replies, 'reply'),
        ...sourceLinkFields(additionalSources, 'linked')
    ];
    const needsReview = sources.some(source => {
        if (source.review_status !== 'pending') return false;
        const coveredFollowUp = String(source.message_id) !== String(root.message_id)
            && !source.opponent_ign && root.opponent_ign
            && !(source.attachments || []).some(attachment =>
                String(attachment.contentType || '').startsWith('image/')
                || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(attachment.name || attachment.url || ''))
            && [
                'Could not identify the opponent IGN in the message or screenshot.',
                'Message looks like scouting information but the opponent IGN is unclear.'
            ].includes(source.review_reason);
        return !coveredFollowUp;
    });
    const scoutedBy = safeText(authorNames || contributors.join(', ') || 'Unknown', 900);
    const postedAt = new Date(root.created_at).getTime();
    const posted = Number.isFinite(postedAt) ? `<t:${Math.floor(postedAt / 1000)}:F>` : 'Unknown';
    const ignLabel = safeText(canonicalIgn(root.opponent_ign), 64) || 'Unknown opponent';
    const rating = savedPvpRating(root);
    const identityWarning = identityWarningFor(root.opponent_ign, identity);
    const description = [
        identityWarning,
        ratingSummary,
        `-# **Scouted by:** ${scoutedBy} - ${posted}`,
        body
    ].filter(Boolean).join('\n\n').slice(0, MAX_DESCRIPTION);
    const embed = new EmbedBuilder()
        .setColor(SERVERS[mode === 'cross' ? reportServer(root) : mode].color)
        .setTitle(`${SERVERS[mode === 'cross' ? reportServer(root) : mode].markup} PvP Scout Report — ${ignLabel}${rating !== null ? ` (${rating})` : ''}`)
        .setDescription(description || '*No readable scout notes were saved.*')
        .setFooter({ text: `Report ID: ${root.message_id} • Scout ${index + 1} of ${total}${needsReview ? ' • Needs review' : ''}` });
    if (sourceFields.length) embed.addFields(...sourceFields);
    const image = bestImage(orderedSources);
    embed.addFields({ name: 'Screenshot', value: image?.url ? '\u2002' : '*No screenshots attached*', inline: false });
    if (image?.url) embed.setImage(image.url);
    return { embed, image };
}

class Scout {
    constructor(config) {
        this.name = 'scout';
        this.config = config;
        this.client = config.client;
        this.store = config.pvpScoutStore;
        this.ingestor = config.pvpScoutIngestor;
        this.rosterStore = config.scoutRosterStore;
        this.guildId = String(config.guildId || '');
        this.server = config.scoutServer || 'gold';
        this.channelId = String(config[this.server === 'silver' ? 'pvpScoutingSilverChannelID' : 'pvpScoutingGoldChannelID'] || this.store?.channelId || '');
        this.serverSettings = config.scoutServerSettings || ((config.guildMemberStore || this.rosterStore)
            ? new ScoutServerSettings({ config, store: config.guildMemberStore || this.rosterStore }) : null);
        this.registry = config.scoutArchiveRegistry || config.scoutServers || null;
        this.sharedHistory = config.scoutHistorySessions || new Map();
        this.setupSessions = config.scoutSetupSessions || new Map();
        this.serverViews = null;
        if (config.scoutServers && !config.scoutServerBound) {
            const combined = new ScoutArchiveView(config.scoutServers);
            const contexts = [...config.scoutServers.contexts(), { server: 'cross', store: combined, ingestor: combined.ingestor }];
            this.serverViews = new Map(contexts.map(context => [context.server, new Scout({
                ...config, scoutServers: null, scoutArchiveRegistry: this.registry, scoutServerBound: true,
                scoutHistorySessions: this.sharedHistory, scoutSetupSessions: this.setupSessions,
                scoutServer: context.server, pvpScoutStore: context.store, pvpScoutIngestor: context.ingestor
            })]));
            for (const view of this.serverViews.values()) view.parent = this;
        }
        this.sessions = new Map();
        this.historySessions = this.sharedHistory;
        this.resultCache = new Map();
        this.resultRequests = new Map();
        this.teamCache = new WeakMap();
        this.ratingSummaryCache = new WeakMap();
        this.historyPageCache = new WeakMap();
        this.sortedCache = new WeakMap();
        this.data = new SlashCommandBuilder()
            .setName('scout')
            .setDescription('Look up scouting reports for a PvP opponent.')
            .addStringOption(option => option
                .setName('in_game_name')
                .setDescription('Opponent in-game name; suggestions show recent opponents')
                .setRequired(true)
                .setMaxLength(32)
                .setAutocomplete(true))
            .addStringOption(option => option.setName('server')
                .setDescription('Select Server (optional) — Save your default server for future Scout Reports with: /cc-settings')
                .addChoices({ name: 'Gold', value: 'gold' }, { name: 'Silver', value: 'silver' }, { name: 'Cross Server', value: 'cross' }));
    }

    canUse(interaction) { return canUseGuildSettings(interaction, this.config); }

    viewFor(server) {
        return this.parent ? this.parent.viewFor(server) : this.serverViews ? this.serverViews.get(server) : server === this.server ? this : null;
    }

    viewForInteraction(interaction) {
        const server = interaction.customId.match(/:(gold|silver|cross)$/u)?.[1] || 'gold';
        return this.viewFor(server);
    }

    async reportCounts(ign, loadedResults = null) {
        if (this.server === 'cross' && loadedResults) {
            return { gold: loadedResults.filter(item => reportServer(item.root) === 'gold').length,
                silver: loadedResults.filter(item => reportServer(item.root) === 'silver').length };
        }
        const counts = { gold: 0, silver: 0 };
        await Promise.all(['gold', 'silver'].map(async key => {
            const view = this.viewFor(key);
            if (!view) return;
            const cached = view.resultCache.get(normalizeIgn(ign));
            const reports = key === this.server && loadedResults ? loadedResults
                : cached?.revision === (view.store.dataRevision || 0) && cached.expiresAt > Date.now() ? cached.results : null;
            counts[key] = reports ? reports.length : await view.store.publicReportCount(normalizeIgn(ign), view.channelId);
        }));
        return counts;
    }

    async bindControls(payload, session = null, token = null, loadedResults = null) {
        if (session && token) {
            payload.components ||= [];
            const counts = await this.reportCounts(session.ign, session.globalSearch ? null : loadedResults);
            const select = new StringSelectMenuBuilder()
                .setCustomId(`${SERVER_SELECT_PREFIX}${session.ownerId}:${token}:${this.server}`)
                .setPlaceholder('Select a Server').setMinValues(1).setMaxValues(1)
                .addOptions(...Object.entries(SERVERS).map(([key, server]) => ({
                    label: `${server.label}${key === 'cross' ? '' : ' Server'} (${key === 'cross' ? counts.gold + counts.silver : counts[key]})`,
                    value: key, emoji: server.emoji, default: key === this.server
                })), { label: 'Choose Default Server Here', value: 'default', emoji: '⚙️' });
            payload.components.unshift(new ActionRowBuilder().addComponents(select));
        }
        return bindServer(payload, this.server);
    }

    availableSorts() {
        return Object.entries(SORTS).filter(([key]) => this.server === 'cross' || ['newest', 'oldest', 'rating'].includes(key));
    }

    orderedResults(results, session) {
        const sort = session?.sort || 'newest';
        if (sort === 'newest') return results;
        let variants = this.sortedCache.get(results);
        if (!variants) { variants = new Map(); this.sortedCache.set(results, variants); }
        if (!variants.has(sort)) variants.set(sort, sortReports(results, sort));
        return variants.get(sort);
    }

    renderLookup(interaction, token, session, options = {}) {
        // Keep the previous lookup usable if Discord rejects the replacement page.
        return withScoutLoading(interaction, () => session.view === 'report'
            ? this.payloadFor(session.ign, 0, session.ownerId, interaction.guild, null, session, token)
            : this.historyPayload(session, token, 0, null, interaction.guild), {
            label: 'Loading scouts…', ...options,
            onLoaded: payload => {
                this.historySessions.set(token, session);
                if (session.view === 'report') this.refreshScoutImageReply(interaction, session.ign, 0,
                    payload.embeds?.[0]?.toJSON?.()?.image?.url, session);
            }
        });
    }

    serverSetupPayload(interaction, explicitServer = null, ign = '') {
        const explicit = SERVERS[explicitServer];
        const alternatives = Object.keys(SERVERS).filter(key => key !== explicitServer);
        const alternativeText = alternatives.map(key => key === 'cross'
            ? `  - Press **Cross Server** to save **${SERVERS.cross.markup} both servers** as your default servers.\n`
            : `  - Press **${SERVERS[key].label}** to save **${SERVERS[key].markup} ${SERVERS[key].label}** as your default server.\n`).join('');
        const description = explicit
            ? `### You selected the ${explicit.markup} **${explicit.label}${explicitServer === 'cross' ? '' : ' Server'}**.\n`
                + `- **Do you want to save ${explicit.markup} ${explicit.label} as your default server?**\n`
                + `  - Press **Yes** below to save **${explicit.markup} ${explicit.label}** as your default server.\n`
                + alternativeText + '\n'
                + 'Select your server only once, and the bot will remember it for future commands so you won\'t need to specify it every time.\n'
                + 'You can still view Scout Reports for different servers inside the `/scout` command.\n\n'
                + '**You can change your default server at any time with the**\n**`/cc-settings` command.**'
            : '**Select your prefered default Server below:**\n'
                + `- ${SERVERS.gold.markup} **Gold:** Press this button to select the **Gold Server**.\n`
                + `- ${SERVERS.silver.markup} **Silver:** Press this button to select the **Silver Server**.\n`
                + `- ${SERVERS.cross.markup} **Cross Server:** Press this button to select **Cross Server**.\n\n`
                + 'Select your server only once, and the bot will remember it for future commands so you won\'t need to specify it every time.\n'
                + 'You can still view Scout Reports for different servers inside the `/scout` command.\n\n'
                + '**You can change your default server at any time with the**\n**`/cc-settings` command.**';
        const embed = new EmbedBuilder().setColor((explicit || SERVERS.cross).color).setTitle('One-time default server setup').setDescription(description)
            .setFooter({ text: 'Crow Control Server Settings' }).setTimestamp();
        const avatar = interaction.member?.displayAvatarURL?.({ size: 256 })
            || interaction.user.displayAvatarURL?.({ size: 256 });
        if (avatar) embed.setThumbnail(avatar);
        const token = randomBytes(8).toString('hex');
        this.setupSessions.set(token, { ownerId: interaction.user.id, ign: cleanIgn(ign), createdAt: Date.now() });
        const choices = explicit ? [explicitServer, ...alternatives] : ['gold', 'silver', 'cross'];
        const row = new ActionRowBuilder().addComponents(...choices.map((key, index) => new ButtonBuilder()
            .setCustomId(`${SERVER_PREFIX}${interaction.user.id}:${key}:${token}`)
            .setLabel(explicit && index === 0 ? `Yes (${SERVERS[key].label})` : SERVERS[key].label)
            .setEmoji(SERVERS[key].emoji).setStyle(ButtonStyle.Secondary)));
        return scoutPayload({
            content: `### <@${interaction.user.id}>, please select your default server below.`,
            embeds: [embed], components: [row], allowedMentions: { parse: [] }
        });
    }

    async handleServerButton(interaction) {
        const [ownerId, server, token] = interaction.customId.slice(SERVER_PREFIX.length).split(':');
        if (ownerId !== interaction.user.id || !this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (!SERVERS[server]) return false;
        const setup = this.setupSessions.get(token);
        if (!setup || setup.ownerId !== ownerId || !setup.ign) {
            await interaction.reply({ content: 'This server setup expired. Use `/scout` again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.deferUpdate();
        let saved = false;
        try {
            const result = await this.serverSettings.select(interaction, server);
            saved = true;
            const view = this.viewFor(result.selected);
            if (!view) throw new Error('That scout archive is unavailable.');
            await interaction.editReply(scoutPayload(await view.teamsPayload(setup.ign, ownerId, interaction.guild), interaction.message));
            this.setupSessions.delete(token);
        } catch (error) {
            logServerSelectionFailure(interaction, server, error);
            await interaction.followUp({
                content: serverSelectionFailureMessage(error)
                    || (saved ? 'Your default server was saved, but the scout reports could not load. Use `/scout` again.'
                        : 'Could not save your server selection. Please try again.'), flags: MessageFlags.Ephemeral
            });
        }
        return true;
    }

    async loadResults(ign) {
        const key = ign === null ? '*' : normalizeIgn(ign);
        const revision = this.store.dataRevision || 0;
        const now = Date.now();
        for (const [name, entry] of this.resultCache) {
            if (entry.expiresAt <= now || entry.revision !== revision) this.resultCache.delete(name);
        }
        const cached = this.resultCache.get(key);
        if (cached) return cached.results;
        const existing = this.resultRequests.get(key);
        if (existing?.revision === revision) return existing.promise;
        const request = { revision };
        request.promise = Promise.resolve().then(async () => {
            const { roots, sources } = await this.store.searchRootsAndSources(ign === null ? null : key, this.channelId);
            const byRoot = new Map();
            for (const source of sources) {
                if (source.review_status === 'not_scout') continue;
                if (source.ign_source === 'member_submission' && source.review_status === 'pending') continue;
                const rootId = String(source.root_message_id || source.message_id);
                if (!byRoot.has(rootId)) byRoot.set(rootId, []);
                byRoot.get(rootId).push(source);
            }
            const results = roots.map(root => ({ root, sources: byRoot.get(String(root.message_id)) || [root] }));
            // Keep page reads brief, and never retain a snapshot that predates
            // a report edit, review, deletion or grouping change.
            if ((this.store.dataRevision || 0) === revision) {
                this.resultCache.set(key, { revision, results, expiresAt: Date.now() + RESULT_CACHE_MS });
                while (this.resultCache.size > RESULT_CACHE_SIZE) this.resultCache.delete(this.resultCache.keys().next().value);
            }
            return results;
        }).finally(() => {
            if (this.resultRequests.get(key) === request) this.resultRequests.delete(key);
        });
        this.resultRequests.set(key, request);
        return request.promise;
    }

    loadLookupResults(session) {
        return this.loadResults(session.globalSearch ? null : session.ign);
    }

    cachedSuggestions(mode = this.server, term = '') {
        const allContexts = this.registry?.contexts() || [{ server: this.server, channelId: this.channelId, store: this.store }];
        const contexts = allContexts
            .filter(context => mode === 'cross' || context.server === mode);
        const suggestions = contexts.flatMap(context => {
            const oppositeServer = context.server === 'gold' ? 'silver' : 'gold';
            const oppositeContext = allContexts.find(candidate => candidate.server === oppositeServer);
            return [...new Set(context.store.cachedAutocomplete?.(term, context.channelId) || [])]
                .map(name => ({ name: canonicalIgn(name), server: context.server,
                    count: context.store.cachedAutocompleteReportCount?.(name, context.channelId),
                    latest: context.store.cachedAutocompleteLatestScout?.(name, context.channelId),
                    oppositeServer,
                    oppositeCount: oppositeContext?.store.cachedAutocompleteReportCount?.(name, oppositeContext.channelId),
                    oppositeLatest: oppositeContext?.store.cachedAutocompleteLatestScout?.(name, oppositeContext.channelId) }));
        })
            .sort((a, b) => (Date.parse(b.latest) || 0) - (Date.parse(a.latest) || 0)
                || normalizeIgn(a.name).localeCompare(normalizeIgn(b.name)) || a.server.localeCompare(b.server));
        if (mode !== 'cross') return suggestions.slice(0, 25);
        const unique = new Map();
        for (const suggestion of suggestions) {
            const key = normalizeIgn(suggestion.name);
            if (!unique.has(key)) unique.set(key, suggestion);
        }
        return [...unique.values()].slice(0, 25);
    }

    async resolveSearchIgn(ign) {
        const exact = await this.loadResults(ign);
        if (exact.length) return canonicalIgn(exact[0].root.opponent_ign);
        const contexts = (this.registry?.contexts() || [{ store: this.store, channelId: this.channelId, server: this.server }])
            .filter(context => this.server === 'cross' || context.server === this.server);
        const suggestions = await Promise.all(contexts.map(context => context.store.autocomplete?.(ign, context.channelId, true) || []));
        const names = new Map(suggestions.flat().filter(name => normalizeIgn(name).startsWith(normalizeIgn(ign)))
            .map(name => [normalizeIgn(name), canonicalIgn(name)]));
        if (names.size > 1) {
            const error = new Error('That shortened IGN matches multiple opponents. Enter the full IGN or choose a recent opponent.');
            error.code = 'SCOUT_SEARCH_AMBIGUOUS';
            throw error;
        }
        return names.values().next().value || ign;
    }

    teamsForResults(results, search = null) {
        let cached = this.teamCache.get(results);
        if (!cached) {
            cached = { teams: historyData(results).teams, searches: new Map() };
            this.teamCache.set(results, cached);
        }
        if (!search) return cached.teams;
        const key = JSON.stringify([search.species, search.details]);
        if (!cached.searches.has(key)) {
            cached.searches.set(key, cached.teams.map(entry => highlightedTeam(entry, search)).filter(Boolean));
            while (cached.searches.size > 16) cached.searches.delete(cached.searches.keys().next().value);
        }
        return cached.searches.get(key);
    }

    ratingSummaryForResults(results, includeLatest = false) {
        if (!this.ratingSummaryCache.has(results)) {
            const average = this.server === 'cross' ? crossRatingDescription(results) : averagePvpRatingDescription(results);
            this.ratingSummaryCache.set(results, {
                average, full: this.server === 'cross' ? crossRatingDescription(results, true)
                    : [average, lastPvpRatingDescription(results)].filter(Boolean).join('\n')
            });
        }
        const summary = this.ratingSummaryCache.get(results);
        return includeLatest ? summary.full : summary.average;
    }

    async refreshImageUrl(sources, all = false) {
        for (const source of sources) {
            if (await refreshImageAttachments(this.client, source) && !all) return;
        }
    }

    async identityFor(ign, guild) {
        try {
            return await this.rosterStore?.noticeForIgn(String(guild?.id || this.guildId || ''), ign, guild);
        } catch (error) {
            console.warn(`[CC LOG] Could not look up scout identity for ${ign}: ${error.message}`);
            return null;
        }
    }

    async teamsPayload(ign, userId, guild = null, loadedResults = null, lookup = null, lookupToken = null) {
        const results = loadedResults || await this.loadResults(ign);
        const { token, session } = lookup ? { token: lookupToken, session: lookup } : this.createHistorySession(ign, 0, userId, results);
        if (!results.length) return this.emptyPayload(ign, userId, results, session, token);
        return this.historyPayload(session, token, 0, results, guild);
    }

    async emptyPayload(ign, userId, results, session, token) {
        const counts = await this.reportCounts(ign, results);
        const label = safeText(ign, 64), server = SERVERS[this.server];
        const alternatives = ['gold', 'silver'].filter(key => this.server !== 'cross' && key !== this.server)
            .map(key => `- **${counts[key]}** scout report${counts[key] === 1 ? ' was' : 's were'} found in the ${SERVERS[key].markup} **${SERVERS[key].label} Server**.`);
        const embed = new EmbedBuilder().setColor(server.color).setTitle(`${server.markup} PvP Scout Report — ${label}`)
            .setDescription(`There are no reported scout reports for **${label}** in ${this.server === 'cross' ? 'either the Gold or Silver Server' : `the ${server.markup} **${server.label} Server**`}.`
                + (alternatives.length ? `\n\n${alternatives.join('\n')}` : ''))
            .setFooter({ text: `PvP Scout Report — ${label}` }).setTimestamp();
        session.view ||= session.search ? 'search' : 'teams';
        session.hasReports = false;
        session.reportCount = 0;
        session.teamPageCount = 1;
        session.teamPages.clear();
        const controls = session.view === 'report' ? this.reportControls(session, token, 0, 0, 0)
            : this.historyControls(session, token, 0, 1, 0);
        return this.bindControls({ content: null, embeds: [embed], components: controls,
            allowedMentions: { parse: [] } }, session, token, results);
    }

    async payloadFor(ign, page, userId, guild = null, loadedResults = null, lookup = null, lookupToken = null) {
        const rawResults = loadedResults || await this.loadResults(ign);
        const { token, session } = lookup ? { token: lookupToken, session: lookup } : this.createHistorySession(ign, page, userId, rawResults);
        const results = this.orderedResults(rawResults, session);
        if (!results.length) {
            session.view = 'report';
            return this.emptyPayload(ign, userId, results, session, token);
        }
        const currentPage = Math.max(0, Math.min(results.length - 1, page));
        const selected = results[currentPage];
        // Cached URL renewals are applied before rendering, without a REST wait.
        for (const source of selected.sources) reuseFreshImageAttachments(source);
        const authorSources = selected.sources.filter(source => {
            if (source.review_status === 'not_scout') return false;
            const hasImage = (source.attachments || []).some(attachment =>
                String(attachment.contentType || '').startsWith('image/')
                || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(attachment.name || attachment.url || ''));
            return hasImage || !isClearlyOffTopicText(source.message_content);
        });
        const authors = await authorDisplays(guild, authorSources);
        const identity = await this.identityFor(selected.root.opponent_ign, guild);
        const { embed } = buildScoutEmbed(selected.root, selected.sources, currentPage, results.length, authors, identity,
            this.ratingSummaryForResults(results), this.server);
        session.view = 'report';
        session.originalPage = currentPage;
        session.originalReportId = String(selected.root.message_id);
        session.reportCount = results.length;
        const imageCount = uniqueImages(partitionReportSources(selected.root, selected.sources).visibleSources).length;
        const controls = this.reportControls(session, token, currentPage, results.length, imageCount);
        const mentionedUser = identity?.mention?.match(/^<@(\d+)>$/u)?.[1];
        const payload = {
            content: null, embeds: [embed], components: controls,
            allowedMentions: { parse: [], ...(mentionedUser ? { users: [mentionedUser] } : {}) }
        };
        return this.bindControls(payload, session, token, rawResults);
    }

    reportControls(session, token, page, pageCount, imageCount) {
        const actionId = (action, target = 0) => `${HISTORY_PREFIX}${session.ownerId}:${token}:${action}:${target}`;
        return buttonRows([
            pageButton('Back', actionId('back-search'), ButtonStyle.Secondary, false).setEmoji('↩️'),
            pageButton('Search', actionId('search'), ButtonStyle.Primary, false).setEmoji('🔎'),
            pageButton('Sort', actionId('sort'), ButtonStyle.Primary, false).setEmoji('↕️'),
            pageButton('More Images', actionId('report-images', page), ButtonStyle.Primary, imageCount <= 1).setEmoji('🖼️'),
            pageButton('Add Scout Report', `${ADD_PREFIX}${session.ownerId}:${Buffer.from(session.ign, 'utf8').toString('base64url')}`,
                ButtonStyle.Success, false).setEmoji('📝')
        ], pageCount > 1 ? [
            pageButton('Previous Page', actionId('report-page', page - 1), ButtonStyle.Secondary, page === 0).setEmoji('⬅️'),
            pageButton('Next Page', actionId('report-page', page + 1), ButtonStyle.Secondary, page >= pageCount - 1).setEmoji('➡️'),
            pageButton('Page Number', actionId('page-number'), ButtonStyle.Secondary, false).setEmoji('🔢')
        ] : []);
    }

    createHistorySession(ign, page, ownerId, results) {
        // Keep open scout pages usable until restart; report data is cached separately.
        const originalPage = Math.max(0, Math.min(results.length - 1, Number.isInteger(page) ? page : 0));
        const token = randomBytes(8).toString('hex');
        const session = {
            ownerId, ign: canonicalIgn(results[originalPage]?.root.opponent_ign || ign),
            server: this.server,
            sort: 'newest',
            originalPage, originalReportId: String(results[originalPage]?.root.message_id || ''),
            teamPages: new Map(), view: 'teams'
        };
        this.historySessions.set(token, session);
        return { token, session };
    }

    historyControls(session, token, page, pageCount, imageCount) {
        const customId = (action, requestedPage = 0) => `${HISTORY_PREFIX}${session.ownerId}:${token}:${action}:${requestedPage}`;
        const actions = [];
        if (session.search) actions.push(pageButton('Back', customId('back-search'), ButtonStyle.Secondary, false).setEmoji('↩️'));
        actions.push(pageButton('Search', customId('search', page), ButtonStyle.Primary, false).setEmoji('🔎'));
        actions.push(pageButton('Sort', customId('sort'), ButtonStyle.Primary, false).setEmoji('↕️'));
        if (!session.search || imageCount > 0) actions.push(
            pageButton('Images', customId('images', page), ButtonStyle.Primary, !imageCount).setEmoji('🖼️'));
        if (!session.search) actions.push(pageButton('Detailed View', customId('report'), ButtonStyle.Primary,
            !session.hasReports).setEmoji('📋'));
        actions.push(pageButton('Add Scout Report', `${ADD_PREFIX}${session.ownerId}:${Buffer.from(session.ign, 'utf8').toString('base64url')}`,
            ButtonStyle.Success, false).setEmoji('📝'));
        const navigation = [];
        if (pageCount > 1) {
            const lastPage = pageCount - 1;
            navigation.push(
                pageButton('Previous Page', customId('teams', page - 1), ButtonStyle.Secondary, page === 0).setEmoji('⬅️'),
                pageButton('Next Page', customId('teams', page + 1), ButtonStyle.Secondary, page >= lastPage).setEmoji('➡️')
            );
            if (pageCount > 2) navigation.push(pageButton('Page Number', customId('page-number'),
                ButtonStyle.Secondary, false).setEmoji('🔢'));
        }
        return buttonRows(actions, navigation);
    }

    async historyPayload(session, token, requestedPage = 0, loadedResults = null, guild = null) {
        const results = loadedResults || await this.loadLookupResults(session);
        if (!results.length && !session.globalSearch) return this.emptyPayload(session.ign, session.ownerId, results, session, token);
        const teams = this.orderedResults(this.teamsForResults(results, session.search), session);
        const imageReports = session.search ? teams : results;
        const availableImages = uniqueImages(imageReports.flatMap(item => session.search
            ? item.sources : partitionReportSources(item.root, item.sources).visibleSources));
        const availableScreenshotCount = !session.search && !teams.length ? availableImages.length : 0;
        const imageReportIds = imageReports.map(item => String(item.root.message_id));
        const ignLabel = safeText(session.ign, 64);
        const otherServer = this.server === 'gold' ? 'silver' : this.server === 'silver' ? 'gold' : null;
        const [identity, serverCounts] = await Promise.all([
            session.globalSearch ? null : this.identityFor(session.ign, guild),
            otherServer && !session.search && teams.length ? this.reportCounts(session.ign, results) : null
        ]);
        const otherServerCount = otherServer ? serverCounts?.[otherServer] || 0 : 0;
        const warning = identityWarningFor(session.ign, identity);
        // Cache boundaries with the report snapshot, search and draw notice.
        // Navigation then reuses complete blocks without reparsing every team.
        let cachedPages = this.historyPageCache.get(results);
        if (!cachedPages) {
            cachedPages = new Map();
            this.historyPageCache.set(results, cachedPages);
        }
        const pageKey = JSON.stringify([ignLabel, session.search, session.globalSearch, warning, this.server, session.sort, otherServerCount]);
        let pages = cachedPages.get(pageKey);
        if (!pages) {
            const entries = await Promise.all(teams.map(async entry => {
                const withCredits = { ...entry, credits: await teamCredits(entry, guild) };
                const opponent = session.globalSearch ? `**${safeText(entry.root.opponent_ign, 64)}**\n` : '';
                return { ...withCredits, block: opponent + historyTeamBlock(withCredits, this.server === 'cross') };
            }));
            const ratingSummary = session.search ? '' : this.ratingSummaryForResults(results, true);
            const searchScope = this.server === 'cross' ? 'in **both Servers**'
                : `in the **${SERVERS[this.server].label} Server**`;
            const searchHeading = session.search
                ? `🔎\u2002**\`${teams.length}\`** search result${teams.length === 1 ? '' : 's'} found for **${session.search.label}** ${session.globalSearch ? `across all opponents ${searchScope}.` : `on **${ignLabel}'s** PvP Team.`}` : '';
            pages = packTeamPages(entries, {
                title: session.globalSearch ? `${SERVERS[this.server].markup} PvP Scout Search`
                    : `${SERVERS[this.server].markup} PvP Scout Report — ${ignLabel}`,
                maxTeams: HISTORY_PAGE_SIZE,
                headerForPage: (pageIndex, count) => {
                    let heading = session.search ? searchHeading : !count ? ''
                        : teams.length > HISTORY_PAGE_SIZE && pageIndex === 0
                            ? `**Scout Reports: \`${results.length}\`**${reportDateRange(results)}\n`
                                + `- Showing the **\`${count}\`** latest Scout Report${count === 1 ? '' : 's'}`
                            : `**Scout Reports: \`${results.length}\`**${reportDateRange(results)}`;
                    if (heading && otherServerCount) {
                        const otherServerName = `${SERVERS[otherServer].markup} **${SERVERS[otherServer].label} Server**`;
                        heading += `\n- There ${otherServerCount === 1 ? 'is' : 'are'} \`${otherServerCount}\` scout report${otherServerCount === 1 ? '' : 's'} in ${otherServerName}.`
                            + `\n-# - Change to **Cross Server** to view all scout reports for **${ignLabel}**`;
                    }
                    if (this.server === 'cross') {
                        const counts = ['gold', 'silver'].map(key => {
                            const reports = results.filter(entry => reportServer(entry.root) === key);
                            const number = reports.length;
                            return `${SERVERS[key].markup} **${SERVERS[key].label}: \`${number}\`** scout report${number === 1 ? '' : 's'}${reportDateRange(reports)}`;
                        }).join('\n');
                        const totals = session.search && !teams.length || session.globalSearch ? '' : counts;
                        heading = [session.search ? searchHeading : '', totals].filter(Boolean).join('\n\n');
                    }
                    const empty = count ? '' : session.search
                        ? session.globalSearch ? 'No reported Pokémon match all of these requirements.'
                            : `**${session.search.label}** has not been reported on **${ignLabel}'s** PvP Team.`
                        : [
                            '*No reports with Pokémon Team information are available.*',
                            availableScreenshotCount ? `- *\`${availableScreenshotCount}\` screenshot${availableScreenshotCount === 1 ? '' : 's'} ${availableScreenshotCount === 1 ? 'is' : 'are'} available. Press the 🖼️ **Images** button to view ${availableScreenshotCount === 1 ? 'it' : 'them'}.*` : ''
                        ].filter(Boolean).join('\n');
                    return [warning, ratingSummary, heading, empty].filter(Boolean).join('\n\n');
                },
                footerForPage: (pageIndex, count, totalPages) => {
                    const footer = session.search ? `Pokémon Search — ${session.globalSearch ? 'All Opponents' : ignLabel}` : reportedTitle(count, 'Team', ignLabel);
                    return `${footer}${totalPages > 1 ? ` • Page ${pageIndex + 1} of ${totalPages}` : ''}`;
                }
            });
            cachedPages.set(pageKey, pages);
            while (cachedPages.size > 20) cachedPages.delete(cachedPages.keys().next().value);
        }
        const pageCount = pages.length;
        const page = Math.max(0, Math.min(pageCount - 1,
            Number.isInteger(requestedPage) ? requestedPage : 0));
        const selected = pages[page];
        const pageTeams = selected.entries;
        // Keep team-page membership separate from the complete screenshot
        // scope so page-number navigation remains tied to visible teams.
        session.teamPages.set(page, pageTeams.map(item => String(item.root.message_id)));
        session.imageReportIds = imageReportIds;
        session.hasReports = results.length > 0;
        session.reportCount = results.length;
        session.teamPageCount = pageCount;
        session.teamCount = teams.length;
        session.view = session.search ? 'search' : 'teams';
        session.currentTeamPage = page;
        const embeds = selected.descriptions.map((description, index) => {
            const embed = new EmbedBuilder().setColor(SERVERS[this.server].color).setDescription(description);
            if (index === 0 && selected.title) embed.setTitle(selected.title);
            if (index === selected.descriptions.length - 1) embed.setFooter({ text: selected.footer }).setTimestamp();
            return embed;
        });
        const mentionedUser = identity?.mention?.match(/^<@(\d+)>$/u)?.[1];
        return this.bindControls({
            content: null, embeds,
            components: this.historyControls(session, token, page, pageCount, availableImages.length),
            allowedMentions: { parse: [], ...(mentionedUser ? { users: [mentionedUser] } : {}) }
        }, session, token, results);
    }

    async screenshotPayload(ign, sources, uploadLimit) {
        const firstImages = uniqueImages(sources).slice(0, HISTORY_PAGE_SIZE);
        const sourceIds = new Set(firstImages.map(image => image.sourceId));
        await Promise.all(sources.filter(source => sourceIds.has(String(source.message_id)))
            .map(source => refreshImageAttachments(this.client, source)));
        const images = uniqueImages(sources).slice(0, HISTORY_PAGE_SIZE);
        if (!images.length) return {
            content: 'No screenshots are available for these reports.',
            embeds: [], components: [], allowedMentions: { parse: [] }
        };
        const maxBytes = Number.isFinite(Number(uploadLimit)) && Number(uploadLimit) > 0
            ? Number(uploadLimit) : 10 * 1024 * 1024;
        const downloaded = new Array(images.length);
        let nextIndex = 0;
        // Limit simultaneous downloads, and retain the newest-first order.
        await Promise.all(Array.from({ length: Math.min(3, images.length) }, async () => {
            while (nextIndex < images.length) {
                const index = nextIndex++;
                try {
                    downloaded[index] = await downloadImageAttachment(images[index], maxBytes);
                } catch (error) {
                    console.warn(`[CC LOG] Could not attach scout screenshot from message ${images[index].sourceId}: ${error.message}`);
                }
            }
        }));
        const files = downloaded.filter(Boolean);
        if (!files.length) return {
            content: 'Could not attach these screenshots right now. Please try again.',
            embeds: [], components: [], allowedMentions: { parse: [] }
        };
        const missing = images.length - files.length;
        const detail = missing ? `\n-# ${missing} screenshot${missing === 1 ? '' : 's'} could not be attached. Please try again later.` : '';
        return {
            content: `### ${reportedTitle(files.length, 'Screenshot', safeText(ign, 64))}${detail}`,
            files, embeds: [], components: [], allowedMentions: { parse: [] }
        };
    }

    async handleHistoryButton(interaction) {
        if (!this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        const [ownerId, token, action, pageValue] = interaction.customId.slice(HISTORY_PREFIX.length).split(':');
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This lookup belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const session = this.historySessions.get(token);
        if (!session || session.ownerId !== ownerId || session.server !== this.server
            || !['teams', 'images', 'report', 'report-page', 'report-images', 'search', 'back-search', 'page-number', 'sort'].includes(action)) {
            await interaction.reply({ content: 'This scout page is no longer available. Use /scout to open it again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (action === 'search') {
            await interaction.showModal(this.searchModal(session, token));
            return true;
        }
        if (action === 'sort') {
            const sort = new RadioGroupBuilder().setCustomId('sort').setRequired(true)
                .addOptions(...this.availableSorts().map(([value, label]) => ({ label, value, default: session.sort === value })));
            await interaction.showModal(new ModalBuilder().setCustomId(`${SORT_MODAL_PREFIX}${ownerId}:${token}:${this.server}`)
                .setTitle('Sort').addLabelComponents(new LabelBuilder().setLabel('Sort order').setRadioGroupComponent(sort)));
            return true;
        }
        if (action === 'page-number') {
            const pageCount = session.view === 'report' ? session.reportCount : session.teamPageCount;
            if (!(pageCount > (session.view === 'report' ? 1 : 2))) {
                await interaction.reply({ content: 'There are not enough pages to use Page Number.', flags: MessageFlags.Ephemeral });
                return true;
            }
            await interaction.showModal(this.pageNumberModal(session, token));
            return true;
        }
        if (action === 'back-search') {
            const unfiltered = { ...session, search: null, globalSearch: false, view: 'teams', teamPages: new Map() };
            return this.renderLookup(interaction, token, unfiltered, { label: 'Loading teams…', logContext: '/scout team history' });
        }
        let restoredPage;
        return withScoutLoading(interaction, async () => {
            if (action === 'report' || action === 'report-page') {
                const results = this.orderedResults(await this.loadResults(session.ign), session);
                const originalIndex = results.findIndex(item => String(item.root.message_id) === session.originalReportId);
                const page = action === 'report-page' ? Number(pageValue) : originalIndex >= 0 ? originalIndex : session.originalPage;
                const payload = await this.payloadFor(session.ign, page, ownerId, interaction.guild, results, session, token);
                restoredPage = page;
                return payload;
            } else if (action === 'report-images') {
                const results = await this.loadLookupResults(session);
                const selected = results.find(item => String(item.root.message_id) === session.originalReportId);
                if (!selected) return { content: 'That scout report is no longer available.' };
                return this.screenshotPayload(session.ign, partitionReportSources(selected.root, selected.sources).visibleSources,
                    interaction.attachmentSizeLimit);
            } else if (action === 'images') {
                const reportIds = session.imageReportIds || session.teamPages.get(Number(pageValue));
                if (!reportIds) return { content: 'This team page is no longer available. Open the team history again.' };
                const results = await this.loadLookupResults(session);
                const selectedIds = new Set(reportIds);
                const selectedSources = results.filter(item => selectedIds.has(String(item.root.message_id)))
                    .flatMap(item => partitionReportSources(item.root, item.sources).visibleSources);
                return this.screenshotPayload(session.globalSearch ? 'Search Results' : session.ign, selectedSources, interaction.attachmentSizeLimit);
            }
            return this.historyPayload(session, token, Number(pageValue), null, interaction.guild);
        }, {
            newMessage: action === 'images' || action === 'report-images',
            label: action.includes('images') ? 'Loading screenshots…' : action.startsWith('report') ? 'Loading scout…' : 'Loading teams…',
            logContext: '/scout team history',
            onLoaded: payload => {
                if (restoredPage !== undefined) this.refreshScoutImageReply(interaction, session.ign, restoredPage,
                    payload.embeds?.[0]?.toJSON?.()?.image?.url, session);
            }
        });
    }

    async handleSelect(interaction) {
        if (!interaction.customId.startsWith(SERVER_SELECT_PREFIX)) return false;
        const [ownerId, token, currentServer] = interaction.customId.slice(SERVER_SELECT_PREFIX.length).split(':');
        if (ownerId !== interaction.user.id || !this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        const session = this.historySessions.get(token);
        if (!session || session.ownerId !== ownerId || session.server !== currentServer) {
            await interaction.reply({ content: 'This scout page is no longer available. Use /scout to open it again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const target = interaction.values?.[0];
        if (target === 'default') {
            return withScoutLoading(interaction, async () => {
                const payload = this.serverSetupPayload(interaction, null, session.ign);
                await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
                return { components: interaction.message.components.map(row => row.toJSON()) };
            }, {
                label: 'Opening server settings…', logContext: '/scout default server setup'
            });
        }
        if (!SERVERS[target]) {
            await interaction.reply({ content: 'Select Gold, Silver, or Cross Server.', flags: MessageFlags.Ephemeral });
            return true;
        }
        return this.handleViewSwitch(interaction, { ownerId, token, target });
    }

    async handleViewSwitch(interaction, selection = null) {
        const values = interaction.customId.slice(SWITCH_PREFIX.length).split(':');
        const { ownerId, token, target } = selection || { ownerId: values[0], token: values[1], target: values[2] };
        const previous = this.historySessions.get(token);
        if (ownerId !== interaction.user.id || !this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        const view = this.viewFor(target);
        if (!previous || previous.ownerId !== ownerId || !view) {
            await interaction.reply({ content: 'This scout page is no longer available. Use /scout to open it again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const sort = target === 'cross' || ['newest', 'oldest', 'rating'].includes(previous.sort) ? previous.sort : 'newest';
        const session = { ...previous, server: target, sort, teamPages: new Map(), originalPage: 0, originalReportId: null };
        return view.renderLookup(interaction, token, session, { logContext: '/scout server switch' });
    }

    async handleSortModal(interaction) {
        const [ownerId, token] = interaction.customId.slice(SORT_MODAL_PREFIX.length).split(':');
        const previous = this.historySessions.get(token);
        if (!previous || previous.ownerId !== interaction.user.id || ownerId !== interaction.user.id
            || previous.server !== this.server) {
            await interaction.reply({ content: 'This scout page is no longer available. Use /scout to open it again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const sort = interaction.fields.getRadioGroup('sort', true);
        if (!this.availableSorts().some(([key]) => key === sort)) {
            await interaction.reply({ content: 'That sort order is unavailable for this server.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const session = { ...previous, sort, teamPages: new Map(), originalPage: 0, originalReportId: null };
        return this.renderLookup(interaction, token, session, { logContext: '/scout sort' });
    }

    searchModal(session, token) {
        const ign = new TextInputBuilder().setCustomId('ign').setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(32)
            .setPlaceholder('Enter a players IGN from Pokémon Revoluion Online');
        if (session.ign) ign.setValue(canonicalIgn(session.ign).slice(0, 32));
        const input = new TextInputBuilder().setCustomId('pokemon').setStyle(TextInputStyle.Short)
            .setRequired(false).setMinLength(2).setMaxLength(80).setPlaceholder('Example: Charizard, Mega Charizard X, Rotom-Wash');
        if (session.search?.species) input.setValue(session.search.species);
        const detail = new TextInputBuilder().setCustomId('details').setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(300)
            .setPlaceholder('Example: sd, eq, band, jolly — all must match one Pokémon');
        if (session.search?.detailInput) detail.setValue(session.search.detailInput);
        const modal = new ModalBuilder().setCustomId(`${SEARCH_MODAL_PREFIX}${session.ownerId}:${token}:${this.server}`)
            .setTitle('Search IGN & Pokémon')
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `### Selected Server: ${SERVERS[this.server].label} ${SERVERS[this.server].markup}\n`
                + '**Choose a recent opponent or enter an IGN to search all.**\n'
                + `-# - Choosing an opponent from the dropdown will override the current IGN **(${canonicalIgn(session.ign).slice(0, 32)})**. Otherwise, a newly entered IGN takes priority. If no **IGN** is selected or entered, Pokémon/Details will search across all opponents on the currently selected server.\n`
                + '**Combine IGN, Pokémon and Details, such as moves, items, etc.**\n'
                + '-# - **Pokémon** or **Details** used alone will search across all opponents on the currently selected server.'));
        const choices = this.cachedSuggestions();
        session.searchChoices = new Map(choices.map(choice => [`${choice.server}:${choice.name}`, choice.name]));
        if (choices.length) modal.addLabelComponents(new LabelBuilder().setLabel('IGN (In-Game Name)')
            .setDescription('Choose a recent opponent or type an IGN below.')
            .setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('recent_ign')
                .setPlaceholder('Choose a recently scouted opponent').setMinValues(0).setMaxValues(1).setRequired(false)
                .addOptions(...choices.map(choice => ({ label: suggestionLabel(choice).replace(/^[🥇🥈]\s/u, ''),
                    value: `${choice.server}:${choice.name}`, emoji: SERVERS[choice.server].emoji })))));
        modal.addLabelComponents(new LabelBuilder().setLabel('Enter opponent\'s IGN')
                .setDescription('Leave empty to search across all opponents in the selected server.')
                .setTextInputComponent(ign), new LabelBuilder().setLabel('Pokémon')
                .setDescription('Combine with IGN, Details, or both. Use alone to search for Pokémon across all opponents.')
                .setTextInputComponent(input), new LabelBuilder().setLabel('Details: moves, ability, item, nature')
                .setDescription('Combine comma-separated details with IGN/Pokémon, or use alone to search all opponents and Pokémon')
                .setTextInputComponent(detail));
        // Opening a modal must not wait on MySQL. Refresh suggestions for the next opening.
        setImmediate(() => {
            const contexts = this.registry?.contexts() || [];
            void Promise.all(contexts.filter(context => this.server === 'cross' || context.server === this.server)
                .map(context => context.store.autocomplete('', context.channelId)))
                .catch(error => console.warn(`[CC LOG] Could not refresh scout search suggestions: ${error.message}`));
        });
        return modal;
    }

    pageNumberModal(session, token) {
        const input = new TextInputBuilder().setCustomId('page_number').setStyle(TextInputStyle.Short)
            .setRequired(true).setMinLength(1).setMaxLength(10).setPlaceholder('Enter a page number');
        const description = session.view === 'report'
            ? `**${safeText(session.ign, 64)}** has \`${session.reportCount}\` Scout Reports.\n- Enter a page number to navigate to it.`
            : `${session.globalSearch ? 'This search' : `**${safeText(session.ign, 64)}**`} has \`${session.teamCount || 0}\` ${session.search ? 'matching' : 'reported'} Pokémon Teams across \`${session.teamPageCount}\` pages. Enter a number to navigate to that page.`;
        return new ModalBuilder().setCustomId(`${PAGE_NUMBER_MODAL_PREFIX}${session.ownerId}:${token}:${session.view}:${this.server}`)
            .setTitle('Page Number')
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
            .addLabelComponents(new LabelBuilder().setLabel('Page Number').setTextInputComponent(input));
    }

    async handlePageNumberModal(interaction) {
        if (!this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        const [ownerId, token, viewValue] = interaction.customId.slice(PAGE_NUMBER_MODAL_PREFIX.length).split(':');
        const expectedView = ['teams', 'search', 'report'].includes(viewValue) ? viewValue : 'report';
        const feedback = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
        if (ownerId !== interaction.user.id) {
            await feedback('This lookup belongs to another member.');
            return true;
        }
        const session = this.historySessions.get(token);
        if (!session || session.ownerId !== ownerId || session.server !== this.server || session.view !== expectedView) {
            await feedback('This scout page is no longer available. Use /scout to open it again.');
            return true;
        }
        const value = interaction.fields.getTextInputValue('page_number').trim();
        const pageNumber = Number(value);
        const pageCount = session.view === 'report' ? session.reportCount : session.teamPageCount;
        if (!/^\d+$/u.test(value) || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
            await feedback(`Enter a whole page number from 1 to ${pageCount}.`);
            return true;
        }
        const requestedPage = pageNumber - 1;
        const candidate = { ...session, teamPages: new Map(session.teamPages) };
        return withScoutLoading(interaction, async () => {
            const results = this.orderedResults(await this.loadLookupResults(session), session);
            // Recheck the range in case a report was added or deleted while the modal was open.
            if (session.view !== 'report') {
                const payload = await this.historyPayload(candidate, token, requestedPage, results, interaction.guild);
                if (pageNumber > candidate.teamPageCount) {
                    const error = new Error(`Enter a page number from 1 to ${candidate.teamPageCount}.`);
                    error.code = 'SCOUT_PAGE_RANGE';
                    throw error;
                }
                return payload;
            }
            if (pageNumber > results.length) {
                const error = new Error(results.length ? `Enter a page number from 1 to ${results.length}.`
                    : 'No scout reports are currently available for this opponent.');
                error.code = 'SCOUT_PAGE_RANGE';
                throw error;
            }
            return this.payloadFor(session.ign, requestedPage, ownerId, interaction.guild, results, candidate, token);
        }, {
            label: session.view === 'report' ? 'Loading scout…' : 'Loading teams…', logContext: '/scout page number',
            errorMessage: error => error.code === 'SCOUT_PAGE_RANGE' ? error.message
                : 'Could not load that scout page right now. Please try again.',
            onLoaded: payload => {
                this.historySessions.set(token, candidate);
                if (candidate.view === 'report') this.refreshScoutImageReply(interaction, candidate.ign, requestedPage,
                    payload.embeds?.[0]?.toJSON?.()?.image?.url, candidate);
            }
        });
    }

    async handleSearchModal(interaction) {
        if (!this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        const [ownerId, token] = interaction.customId.slice(SEARCH_MODAL_PREFIX.length).split(':');
        if (ownerId !== interaction.user.id) {
            await interaction.reply({ content: 'This search belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const feedback = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
        const session = this.historySessions.get(token);
        if (!session || session.ownerId !== ownerId || session.server !== this.server) {
            await feedback('This search is no longer available. Use /scout to open it again.');
            return true;
        }
        const rawIgnText = interaction.fields.getTextInputValue('ign').trim();
        const pokemonText = interaction.fields.getTextInputValue('pokemon').trim();
        let detailText = '', selected = '';
        // Older open modals may not contain the new optional fields yet.
        if (interaction.fields.fields?.has?.('details') || !interaction.fields.fields) detailText = interaction.fields.getTextInputValue('details')?.trim() || '';
        if (interaction.fields.fields?.has?.('recent_ign') || !interaction.fields.fields) selected = interaction.fields.getStringSelectValues?.('recent_ign', false)?.[0] || '';
        const selectedIgn = session.searchChoices?.get(selected) || '';
        // The current IGN is prefilled as a default. A recent opponent choice
        // should replace that default, while a different typed IGN takes priority.
        const ignText = rawIgnText && (!selectedIgn || normalizeIgn(rawIgnText) !== normalizeIgn(session.ign))
            ? rawIgnText : '';
        if (selected && !selectedIgn && !ignText) {
            await feedback('That suggestion is no longer available. Open Search again or type the IGN.');
            return true;
        }
        if (!ignText && !selectedIgn && !pokemonText && !detailText) {
            await feedback('Enter an IGN, a Pokémon, or move/ability/item/nature details to search.');
            return true;
        }
        const ign = ignText ? cleanIgn(ignText) : selectedIgn || session.ign;
        if (!ign) {
            await feedback('Enter a valid player IGN using 2–32 letters, numbers, underscores, periods, or hyphens.');
            return true;
        }
        let query = pokemonText ? pokemonQuery(pokemonText) : null;
        if (pokemonText && !query) {
            await feedback('Search for a specific Pokémon on the opponents team, such as Charizard, Mega Charizard X, or Rotom-Wash.');
            return true;
        }
        if (detailText) {
            let details;
            try { details = detailQuery(detailText); }
            catch (error) { await feedback(error.message); return true; }
            query = { ...query, details, detailInput: detailText,
                label: [query?.label, ...details.map(term => term.name)].filter(Boolean).join(' + ') };
        }
        const filtered = { ...session, ign, teamPages: new Map(), search: query,
            globalSearch: Boolean((detailText || pokemonText) && !ignText && !selectedIgn),
            view: query ? 'search' : 'teams', originalPage: 0, originalReportId: null };
        return withScoutLoading(interaction, async () => {
            if (ignText) filtered.ign = await this.resolveSearchIgn(ign);
            return this.historyPayload(filtered, token, 0, null, interaction.guild);
        }, {
            label: 'Searching scouts…', logContext: '/scout IGN and Pokémon search',
            loadingContent: 'Searching scouts…',
            errorMessage: error => error.code === 'SCOUT_SEARCH_AMBIGUOUS' ? error.message
                : 'Could not search these teams right now. Please try again.',
            onLoaded: () => this.historySessions.set(token, filtered)
        });
    }

    async refreshScoutImageReply(interaction, ign, page, renderedImageUrl, session = null) {
        try {
            const revision = this.store.dataRevision || 0;
            const results = this.orderedResults(await this.loadResults(ign), session);
            const currentPage = Math.max(0, Math.min(results.length - 1, page));
            const selected = results[currentPage];
            if (!selected) return;
            const { originalSources, replies, additionalSources } = partitionReportSources(selected.root, selected.sources);
            const imageSource = [...originalSources, ...replies, ...additionalSources]
                .find(source => bestImage([source]));
            if (!imageSource) return;
            const before = renderedImageUrl || bestImage([imageSource])?.url;
            await refreshImageAttachments(this.client, imageSource);
            const after = bestImage([imageSource])?.url;
            if (!after || before === after) return;
            if (sameImageUrl(before, after) && urlIsFresh(before, 0)) return;
            const expectedFooter = `Report ID: ${selected.root.message_id} • Scout ${currentPage + 1} of ${results.length}`;
            const reply = await interaction.fetchReply();
            if (isButtonLoading(reply.id)) return;
            if (!String(reply.embeds?.[0]?.footer?.text || '').startsWith(expectedFooter)) return;
            if ((this.store.dataRevision || 0) !== revision) return;
            const displayed = reply.embeds?.[0];
            if (!displayed || displayed.image?.url === after) return;
            // A still-valid URL already shows this screenshot. Use the renewed
            // URL on the next navigation instead of refreshing the visible page.
            if (sameImageUrl(displayed.image?.url, after) && urlIsFresh(displayed.image?.url, 0)) return;
            // Preserve the current text, footer and controls when an expired
            // image needs renewing; this does not create another page session.
            const embeds = reply.embeds.map((embed, index) => index === 0
                ? new EmbedBuilder(embed.toJSON()).setImage(after) : embed);
            await interaction.editReply({ embeds, allowedMentions: { parse: [] } });
        } catch (error) {
            console.warn(`[CC LOG] Could not refresh a /scout screenshot in the background: ${error.message}`);
        }
    }

    async execute(interaction) {
        if (!this.canUse(interaction)) return interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ign = interaction.options.getString('in_game_name', true).trim();
        try {
            const selected = await this.serverSettings.getSelectedServer(this.guildId, interaction.user.id);
            const explicit = interaction.options.getString('server');
            if (!selected) return interaction.editReply(this.serverSetupPayload(interaction, explicit, ign));
            const view = this.viewFor(explicit || selected);
            if (!view) return interaction.editReply({ content: 'Scouting for that server is temporarily unavailable.', embeds: [], components: [] });
            const payload = await view.teamsPayload(ign, interaction.user.id, interaction.guild);
            await interaction.editReply(scoutPayload(payload));
            return;
        } catch (error) {
            console.error('[CC LOG] /scout lookup failed:', error);
            return interaction.editReply({ content: 'The scouting database is unavailable right now. Please try again later.', embeds: [], components: [] });
        }
    }

    async handleAutocomplete(interaction) {
        let responseAttempted = false;
        const receivedAge = Math.max(0, Date.now() - (interaction.createdTimestamp || Date.now()));
        try {
            if (receivedAge >= AUTOCOMPLETE_REPLY_BY_MS) {
                this.logAutocompleteDelay(`arrived too late to answer (${receivedAge}ms old)`);
                return;
            }
            if (!this.canUse(interaction)) {
                responseAttempted = true;
                await interaction.respond([]);
                return;
            }
            const selected = this.serverSettings?.getCachedServer(this.guildId, interaction.user.id);
            const explicit = interaction.options.getString?.('server');
            const mode = explicit || selected || 'cross';
            const contexts = (this.registry?.contexts() || [{ server: this.server, channelId: this.channelId, store: this.store }])
                .filter(context => mode === 'cross' || context.server === mode);
            const term = interaction.options.getFocused();
            const choices = this.cachedSuggestions(mode, term)
                .map(choice => ({ name: suggestionLabel(choice), value: choice.name.slice(0, 32) }));
            // Recheck after preparing suggestions, preserving time for the REST
            // response rather than using the age captured on arrival a second time.
            const replyAge = Math.max(0, Date.now() - (interaction.createdTimestamp || Date.now()));
            if (replyAge >= AUTOCOMPLETE_REPLY_BY_MS) {
                this.logAutocompleteDelay(`ran out of time preparing suggestions (${receivedAge}ms old on arrival, ${replyAge}ms old before reply)`);
                return;
            }
            responseAttempted = true;
            await interaction.respond(choices);
            // Finish the acknowledgement before starting queries or cache-file
            // writes, so background work cannot delay the pending reply.
            setImmediate(() => {
                if (selected === undefined && this.serverSettings) {
                    void this.serverSettings.getSelectedServer(this.guildId, interaction.user.id)
                        .catch(error => console.warn(`[CC LOG] Could not refresh scout server preference: ${error.message}`));
                }
                void Promise.resolve().then(() => {
                    const refresh = contexts.flatMap(context => [context.store.autocomplete('', context.channelId),
                        ...(term ? [context.store.autocomplete(term, context.channelId)] : [])]);
                    return Promise.all(refresh);
                }).catch(error => console.warn(`[CC LOG] /scout autocomplete cache refresh failed: ${error.message}`));
            });
        } catch (error) {
            if ([10062, 40060].includes(Number(error.code))) {
                this.logAutocompleteDelay(`reply rejected (${error.code}; ${receivedAge}ms old on arrival, ${Date.now() - interaction.createdTimestamp}ms old after the API request)`);
                return;
            }
            console.warn(`[CC LOG] /scout autocomplete failed: ${error.message}`);
            if (!responseAttempted && Date.now() - (interaction.createdTimestamp || Date.now()) < AUTOCOMPLETE_REPLY_BY_MS) {
                await interaction.respond([]).catch(() => { });
            }
        }
    }

    logAutocompleteDelay(message) {
        const now = Date.now();
        if (!this.autocompleteDelayWindow || now - this.autocompleteDelayWindow.startedAt >= 5 * 60_000) {
            this.autocompleteDelayWindow = { startedAt: now, count: 0 };
        }
        this.autocompleteDelayWindow.count++;
        if (!this.autocompleteExpiryLogAt || now - this.autocompleteExpiryLogAt >= 60_000) {
            this.autocompleteExpiryLogAt = now;
            console.log(`[CC LOG] /scout autocomplete ${message}.`);
        }
        // A single expired request can be network jitter; repeated misses need attention.
        if (this.autocompleteDelayWindow.count === 5) {
            console.warn('[CC LOG] /scout autocomplete missed its Discord response deadline 5 times within 5 minutes. '
                + `Check host load and the Discord connection. Latest delay: ${message}.`);
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('pvp-scout:')) return false;
        if (interaction.customId.startsWith(SERVER_PREFIX)) return this.handleServerButton(interaction);
        if (interaction.customId.startsWith(SWITCH_PREFIX)) return this.handleViewSwitch(interaction);
        if (!this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (this.serverViews) {
            const view = this.viewForInteraction(interaction);
            if (!view) {
                await interaction.reply({ content: 'Scouting for that server is temporarily unavailable.', flags: MessageFlags.Ephemeral });
                return true;
            }
            return view.handleButton(interaction);
        }
        if (interaction.customId.startsWith(HISTORY_PREFIX)) return this.handleHistoryButton(interaction);
        const action = interaction.customId.startsWith(BUTTON_PREFIX) ? 'page'
            : interaction.customId.startsWith(IMAGE_PREFIX) ? 'images'
                : interaction.customId.startsWith(TEAM_PREFIX) ? 'teams'
                    : interaction.customId.startsWith(ADD_PREFIX) ? 'add' : null;
        if (!action) return false;
        const [, , ownerId, encodedIgn, pageValue] = interaction.customId.split(':');
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This lookup belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const ign = Buffer.from(encodedIgn || '', 'base64url').toString('utf8');
        const page = Number(pageValue);
        if (action === 'add') {
            await interaction.showModal(this.addReportModal(ownerId, ign));
            return true;
        }
        if (action === 'teams') {
            return withScoutLoading(interaction, () => this.teamsPayload(ign, ownerId, interaction.guild), {
                label: 'Loading teams…', logContext: '/scout team history',
                errorMessage: 'Could not load team history right now. Please try again.'
            });
        }
        if (action === 'images') {
            return withScoutLoading(interaction, async () => {
                const results = await this.loadResults(ign);
                const selected = results[Number.isInteger(page) ? page : 0];
                if (!selected) return { content: 'That scout report is no longer available.' };
                const { visibleSources } = partitionReportSources(selected.root, selected.sources);
                return this.screenshotPayload(canonicalIgn(selected.root.opponent_ign), visibleSources,
                    interaction.attachmentSizeLimit);
            }, {
                label: 'Loading screenshots…', newMessage: true, logContext: '/scout images',
                errorMessage: 'Could not load those screenshots right now.'
            });
        }
        const requestedPage = Number.isFinite(page) ? page : 0;
        return withScoutLoading(interaction,
            () => this.payloadFor(ign, requestedPage, ownerId, interaction.guild), {
            label: 'Loading scout…', logContext: '/scout pagination',
            errorMessage: 'The scouting database is unavailable right now. Please try again.',
            onLoaded: payload => this.refreshScoutImageReply(interaction, ign, requestedPage,
                payload.embeds?.[0]?.toJSON?.()?.image?.url)
        });
    }

    addReportModal(ownerId, ign) {
        const lockedIgn = cleanIgn(ign);
        const token = randomBytes(8).toString('hex');
        const now = Date.now();
        for (const [key, session] of this.sessions) {
            if (now - session.createdAt > 15 * 60 * 1000) this.sessions.delete(key);
        }
        this.sessions.set(token, { ownerId, ign: lockedIgn, server: this.server, createdAt: now });
        const modal = new ModalBuilder().setCustomId(`${MODAL_PREFIX}${ownerId}:${token}:${this.server}`).setTitle('Add Scout Report');
        if (lockedIgn) {
            const server = new RadioGroupBuilder().setCustomId('server').setRequired(true)
                .addOptions(...['gold', 'silver'].map(value => ({ label: `${value === 'gold' ? '🥇' : '🥈'} ${SERVERS[value].label}`,
                    value, default: (this.server === 'cross'
                        ? this.serverSettings?.getCachedServer(this.guildId, ownerId) : this.server) === value })));
            modal.addLabelComponents(new LabelBuilder().setLabel('Server')
                .setDescription(`IGN (In-Game Name): ${lockedIgn}`).setRadioGroupComponent(server));
        } else {
            const name = new TextInputBuilder().setCustomId('ign').setStyle(TextInputStyle.Short)
                .setRequired(true).setMinLength(2).setMaxLength(32).setPlaceholder('Enter opponents in-game name');
            modal.addLabelComponents(new LabelBuilder().setLabel('IGN (In-Game Name)').setTextInputComponent(name));
        }
        const rating = new TextInputBuilder().setCustomId('rating').setStyle(TextInputStyle.Short)
            .setRequired(false).setMaxLength(5).setPlaceholder('Opponents PvP Rating');
        const team = new TextInputBuilder().setCustomId('team').setStyle(TextInputStyle.Paragraph)
            .setRequired(true).setMaxLength(4000)
            .setPlaceholder('Landorus, Sash: Explosion\nTorkoal: Stealth Rock\nVictini: V-create');
        const notes = new TextInputBuilder().setCustomId('notes').setStyle(TextInputStyle.Paragraph)
            .setRequired(false).setMaxLength(1000);
        const screenshot = new FileUploadBuilder().setCustomId('screenshot').setMinValues(0).setMaxValues(1).setRequired(false);
        modal.addLabelComponents(
            new LabelBuilder().setLabel('PvP Rating').setTextInputComponent(rating),
            new LabelBuilder().setLabel('Pokémon Team and additional info')
                .setDescription('List the opponents Pokémon team with any known moves or items.')
                .setTextInputComponent(team),
            new LabelBuilder().setLabel('Additional Notes').setTextInputComponent(notes),
            new LabelBuilder().setLabel('PRO Screenshot').setDescription('Upload a screenshot of the opponents Pokémon team')
                .setFileUploadComponent(screenshot)
        );
        return modal;
    }

    async handleModal(interaction) {
        if (![MODAL_PREFIX, SEARCH_MODAL_PREFIX, PAGE_NUMBER_MODAL_PREFIX, SORT_MODAL_PREFIX].some(prefix => interaction.customId.startsWith(prefix))) return false;
        if (!this.canUse(interaction)) {
            await interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (this.serverViews) {
            const view = this.viewForInteraction(interaction);
            if (!view) {
                await interaction.reply({ content: 'Scouting for that server is temporarily unavailable.', flags: MessageFlags.Ephemeral });
                return true;
            }
            return view.handleModal(interaction);
        }
        if (interaction.customId.startsWith(SEARCH_MODAL_PREFIX)) return this.handleSearchModal(interaction);
        if (interaction.customId.startsWith(SORT_MODAL_PREFIX)) return this.handleSortModal(interaction);
        if (interaction.customId.startsWith(PAGE_NUMBER_MODAL_PREFIX)) return this.handlePageNumberModal(interaction);
        if (!interaction.customId.startsWith(MODAL_PREFIX)) return false;
        const [ownerId, token] = interaction.customId.slice(MODAL_PREFIX.length).split(':');
        if (ownerId !== interaction.user.id) {
            await interaction.reply({ content: 'This form belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const session = this.sessions.get(token);
        if (!session || session.ownerId !== ownerId || Date.now() - session.createdAt > 15 * 60 * 1000) {
            await interaction.editReply('This form expired. Open Add Scout Report again.');
            return true;
        }
        const ign = session.ign || cleanIgn(interaction.fields.getTextInputValue('ign'));
        const destination = session.ign ? interaction.fields.getRadioGroup('server', true) : this.server;
        const archive = this.registry?.get(destination) || (destination === this.server && this.server !== 'cross'
            ? { store: this.store, channelId: this.channelId, ingestor: this.ingestor } : null);
        if (!archive || !['gold', 'silver'].includes(destination)) {
            await interaction.editReply('Select Gold or Silver for this scout report.');
            return true;
        }
        const ratingText = interaction.fields.getTextInputValue('rating').trim();
        const teamText = interaction.fields.getTextInputValue('team').trim();
        const notes = interaction.fields.getTextInputValue('notes').trim();
        const image = interaction.fields.getUploadedFiles('screenshot')?.first();
        if (!ign || !teamText) {
            await interaction.editReply('Enter a valid in-game name and the opponent’s Pokémon team.');
            return true;
        }
        if (ratingText && !/^\d{1,5}$/.test(ratingText)) {
            await interaction.editReply('PvP Rating must contain numbers only. Please open the form and try again.');
            return true;
        }
        if (image && !String(image.contentType || '').startsWith('image/')) {
            await interaction.editReply('The uploaded file must be an image.');
            return true;
        }
        if (session.submitting) {
            await interaction.editReply('This scout report is already being submitted.');
            return true;
        }
        session.submitting = true;
        let posted = false;
        try {
            if (!archive.ingestor) throw new Error('PvP scout ingestion is unavailable.');
            await archive.store.ensureSchema();
            const channel = this.client.channels.cache.get(archive.channelId) || await this.client.channels.fetch(archive.channelId);
            if (!channel?.send) throw new Error('The scouting channel is unavailable.');
            const report = new EmbedBuilder().setColor(0x57F287).setTitle(`PvP Scout Report — ${ign}`)
                .setAuthor({ name: interaction.user.username, url: `https://discord.com/users/${interaction.user.id}` })
                .setDescription(teamText);
            if (ratingText) report.addFields({ name: 'PvP Rating', value: ratingText });
            if (notes) report.addFields({ name: 'Additional Notes', value: notes });
            const sent = await channel.send({
                embeds: [report],
                ...(image ? { files: [{ attachment: image.url, name: image.name || 'scout.png' }] } : {}),
                allowedMentions: { parse: [] }
            });
            posted = true;
            // Once posted, the message ID is the archive's duplicate guard.
            // Reusing this form must not create a second Discord source.
            this.sessions.delete(token);
            const saved = await archive.ingestor.handleCreate(sent);
            const response = saved?.review_status === 'pending'
                ? `The Confidence Score was low for this Scout Report for **${ign}** and was therefore sent for Officer review.`
                : `Thank you for submitting the Scout report for **${ign}**.`;
            await interaction.editReply({ content: response, allowedMentions: { parse: [] } });
        } catch (error) {
            console.error('[CC LOG] /scout report submission failed:', error);
            await interaction.editReply(posted
                ? 'The scout report was posted, but its archive processing could not be confirmed. Check the scouting channel before submitting it again.'
                : 'Could not save the scout report right now. Please try again.');
        } finally {
            session.submitting = false;
        }
        return true;
    }
}

module.exports = Scout;
module.exports.buildScoutEmbed = buildScoutEmbed;
module.exports.autocompleteWithinDeadline = autocompleteWithinDeadline;
