// Shows combined Gold and Silver scouting database statistics.
'use strict';

const path = require('node:path');
const { randomBytes } = require('node:crypto');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    escapeMarkdown
} = require('discord.js');
const { SERVERS, canUseGuildSettings } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { PUBLIC_WHERE } = require('../features/pvp-scouting/ScoutReportAdminStore.js');
const { partitionReportSources, reportHasTeam } = require('../features/pvp-scouting/ScoutReportSources.js');
const { uniqueImageAttachments } = require('../features/pvp-scouting/ScoutImageUrls.js');

const BUTTON_PREFIX = 'scout-stats:page:';
const LOGO_PATH = path.join(__dirname, '../images/cc_logo.webp');
const CONTRIBUTOR_PAGE_SIZE = 20;
const CONTRIBUTORS_PER_EMBED = 10;
const SESSION_TTL_MS = 15 * 60 * 1000;
const STATS_CACHE_MS = 30 * 1000;

function asCount(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
}

function normalizedIgn(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('en-US');
}

function dateMs(value) {
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function compareNewestReports(a, b) {
    return b.date - a.date || String(b.message_id).localeCompare(String(a.message_id), 'en', { numeric: true });
}

function formatMonth(key, timeZone) {
    const [year, month] = key.split('-').map(Number);
    if (!year || !month) return key;
    return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone })
        .format(new Date(Date.UTC(year, month - 1, 1, 12)));
}

function shortName(value, max = 64) {
    return escapeMarkdown(String(value || 'Unknown opponent').slice(0, max)).replace(/@/gu, '＠');
}

function inlineCode(value) {
    return String.fromCharCode(96) + value + String.fromCharCode(96);
}

class ScoutStats {
    constructor(config) {
        this.config = config;
        this.registry = config.scoutArchiveRegistry || config.scoutServers || null;
        this.contexts = this.registry?.contexts?.() || (config.pvpScoutStore
            ? [{ server: config.scoutServer || 'gold', channelId: config.pvpScoutingGoldChannelID,
                store: config.pvpScoutStore }]
            : []);
        this.sessions = new Map();
        this.statsSnapshot = null;
        this.statsRequest = null;
        this.data = new SlashCommandBuilder()
            .setName('scout-stats')
            .setDescription('View PvP Scout statistics and contributors.');
    }

    canUse(interaction) {
        return canUseGuildSettings(interaction, this.config);
    }

    async readArchive(context) {
        const { store } = context;
        await store.ensureSchema();
        // Read only source metadata used by statistics, never the OCR payload.
        // Grouping and staff-selected images follow the same rules as /scout.
        const [rawSources] = await store.db.query(`
            SELECT source.message_id, source.root_message_id, source.channel_id, source.ign_normalized,
                   source.opponent_ign, source.rating, source.created_at, source.author_id, source.author_username,
                   source.message_content, source.reply_to_id, source.attachments_json, source.team_text,
                   source.notes, source.staff_overrides_json, source.review_status, source.is_deleted
            FROM pvp_scout_messages root
            INNER JOIN pvp_scout_messages source ON source.channel_id = root.channel_id
                AND source.root_message_id = root.message_id AND source.is_deleted = 0 AND source.review_status <> 'not_scout'
            WHERE ${PUBLIC_WHERE.replace(/\bm\./gu, 'root.')}
        `, [String(context.channelId)]);
        const sources = rawSources.map(normalizeMessageRow);
        const grouped = new Map();
        for (const source of sources) {
            if (!grouped.has(source.root_message_id)) grouped.set(source.root_message_id, []);
            grouped.get(source.root_message_id).push(source);
        }
        const contributors = new Map();
        const rows = sources.filter(source => source.message_id === source.root_message_id).map(root => {
            const { visibleSources } = partitionReportSources(root, grouped.get(root.message_id));
            for (const source of visibleSources) {
                const key = source.author_id ? `id:${source.author_id}` : `name:${normalizedIgn(source.author_username)}`;
                if (!contributors.has(key)) contributors.set(key, {
                    author_id: source.author_id, author_username: source.author_username, reportIds: new Set()
                });
                const contributor = contributors.get(key);
                contributor.reportIds.add(root.message_id);
                if (source.author_username) contributor.author_username = source.author_username;
            }
            return { ...root, screenshot_count: uniqueImageAttachments(visibleSources).length,
                has_team: reportHasTeam(root, visibleSources) };
        });
        return { server: context.server, rows, contributors: [...contributors.values()].map(contributor => ({
            author_id: contributor.author_id, author_username: contributor.author_username, scout_count: contributor.reportIds.size
        })) };
    }

    archiveRevision() {
        return JSON.stringify(this.contexts.map(context => [context.server, context.store?.dataRevision || 0]));
    }

    async loadStats() {
        const revision = this.archiveRevision();
        if (this.statsSnapshot?.revision === revision && this.statsSnapshot.expiresAt > Date.now()) return this.statsSnapshot.stats;
        if (this.statsRequest?.revision === revision) return this.statsRequest.promise;
        if (!this.contexts.length) throw new Error('No scout archives are configured.');
        const request = { revision };
        request.promise = Promise.all(this.contexts.map(context => this.readArchive(context))).then(archives => {
            const stats = this.aggregate(archives);
            if (revision === this.archiveRevision()) this.statsSnapshot = { stats, revision, expiresAt: Date.now() + STATS_CACHE_MS };
            return stats;
        }).finally(() => {
            if (this.statsRequest === request) this.statsRequest = null;
        });
        this.statsRequest = request;
        return request.promise;
    }

    aggregate(archives) {
        const now = Date.now();
        const byServer = {
            gold: { reports: 0, opponents: new Set(), ratings: { count: 0, sum: 0, min: null, max: null }, screenshots: 0, reportsWithScreenshots: 0,
                reportsWithTeamText: 0, last30Days: 0 },
            silver: { reports: 0, opponents: new Set(), ratings: { count: 0, sum: 0, min: null, max: null }, screenshots: 0, reportsWithScreenshots: 0,
                reportsWithTeamText: 0, last30Days: 0 }
        };
        const opponentMap = new Map();
        const contributorMap = new Map();
        const latestReportByServer = { gold: null, silver: null };
        const ratings = { count: 0, sum: 0, min: null, max: null };
        const busiestMonthCounts = { gold: new Map(), silver: new Map() };
        const cutoff30Days = now - 30 * 24 * 60 * 60 * 1000;
        const cutoffYear = now - 365 * 24 * 60 * 60 * 1000;

        for (const archive of archives) {
            const server = byServer[archive.server];
            if (!server) continue;
            for (const row of archive.rows) {
                const date = dateMs(row.created_at);
                const ignKey = normalizedIgn(row.ign_normalized);
                const report = { ...row, server: archive.server, date };
                if (!latestReportByServer[archive.server]
                    || compareNewestReports(report, latestReportByServer[archive.server]) < 0) {
                    latestReportByServer[archive.server] = report;
                }
                server.reports++;
                server.screenshots += asCount(row.screenshot_count);
                if (asCount(row.screenshot_count)) server.reportsWithScreenshots++;
                if (row.has_team) server.reportsWithTeamText++;
                if (date >= cutoff30Days) server.last30Days++;
                const rating = row.rating === null || row.rating === undefined ? null : Number(row.rating);
                if (Number.isInteger(rating) && rating >= 0) {
                    server.ratings.count++;
                    server.ratings.sum += rating;
                    server.ratings.min = server.ratings.min === null ? rating : Math.min(server.ratings.min, rating);
                    server.ratings.max = server.ratings.max === null ? rating : Math.max(server.ratings.max, rating);
                    ratings.count++;
                    ratings.sum += rating;
                    ratings.min = ratings.min === null ? rating : Math.min(ratings.min, rating);
                    ratings.max = ratings.max === null ? rating : Math.max(ratings.max, rating);
                }

                if (ignKey) {
                    server.opponents.add(ignKey);
                    if (!opponentMap.has(ignKey)) opponentMap.set(ignKey, {
                        name: row.opponent_ign || row.ign_normalized, reports: 0, gold: 0, silver: 0, servers: new Set()
                    });
                    const opponent = opponentMap.get(ignKey);
                    opponent.reports++;
                    opponent[archive.server]++;
                    opponent.servers.add(archive.server);
                }
                if (date >= cutoffYear && date) {
                    const reportDate = new Date(date);
                    const key = `${reportDate.getUTCFullYear()}-${String(reportDate.getUTCMonth() + 1).padStart(2, '0')}`;
                    const counts = busiestMonthCounts[archive.server];
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
            }
            for (const row of archive.contributors || []) {
                const authorId = String(row.author_id || '').trim();
                const username = String(row.author_username || '').trim();
                const count = asCount(row.scout_count);
                if ((!authorId && !username) || !count) continue;
                const key = authorId ? `id:${authorId}` : `name:${normalizedIgn(username)}`;
                if (!contributorMap.has(key)) contributorMap.set(key, {
                    id: authorId || null, name: username || 'Unknown member', gold: 0, silver: 0, total: 0
                });
                const contributor = contributorMap.get(key);
                contributor[archive.server] += count;
                contributor.total += count;
                if (username) contributor.name = username;
            }
        }

        const opponents = [...opponentMap.values()].sort((a, b) => b.reports - a.reports || a.name.localeCompare(b.name));
        const contributors = [...contributorMap.values()].sort((a, b) => b.total - a.total
            || a.name.localeCompare(b.name) || String(a.id || '').localeCompare(String(b.id || '')));
        const busiestMonths = {};
        for (const server of ['gold', 'silver']) {
            busiestMonths[server] = [...busiestMonthCounts[server].entries()]
                .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || null;
        }
        return { generatedAt: now, byServer, opponents, contributors,
            totalReports: byServer.gold.reports + byServer.silver.reports,
            totalOpponents: opponentMap.size,
            opponentsInBoth: [...opponentMap.values()].filter(item => item.servers.size > 1).length,
            ratings,
            busiestMonths,
            latestReportsByServer: latestReportByServer };
    }

    pruneSessions() {
        const now = Date.now();
        for (const [token, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(token);
        }
        while (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
    }

    contributorLine(contributor, index) {
        const identity = contributor.id ? `<@${contributor.id}>`
            : `@${escapeMarkdown(contributor.name).replace(/@/gu, '＠').slice(0, 32)}`;
        return `**${index}.** **${identity}:**\u2002**${inlineCode(contributor.total)}**\u2002—\u2002${SERVERS.gold.markup} ${inlineCode(contributor.gold)}\u2002**•**\u2002${SERVERS.silver.markup} ${inlineCode(contributor.silver)}`;
    }

    busiestMonthText(stats, server, timeZone) {
        const busiest = stats.busiestMonths[server];
        return busiest ? `${formatMonth(busiest[0], timeZone)} — ${inlineCode(busiest[1])} reports` : 'No reports in the past 12 months';
    }

    render(stats, page, ownerId, token, logoUrl = null) {
        const gold = stats.byServer.gold, silver = stats.byServer.silver;
        const timeZone = 'UTC';
        const contributorPageCount = Math.max(1, Math.ceil(stats.contributors.length / CONTRIBUTOR_PAGE_SIZE));
        const currentPage = Math.max(0, Math.min(contributorPageCount, Number(page) || 0));
        const logoReference = logoUrl || 'attachment://cc_logo.webp';
        const embed = new EmbedBuilder().setColor(0x452366)
            .setTitle('<:dark_murkrow:1565243892255694908>\u2002Crow Control  •  Scout Statistics')
            .setThumbnail(logoReference);

        const embeds = [embed];
        if (currentPage === 0) {
            embed.setFooter({ text: 'Crow Control  •  Scout Statistics', iconURL: logoReference })
                .setTimestamp(new Date(stats.generatedAt));
            const ratings = stats.ratings;
            const average = ratings.count ? (ratings.sum / ratings.count).toFixed(1) : 'No ratings yet';
            const range = ratings.count ? `${inlineCode(ratings.min)} – ${inlineCode(ratings.max)}` : '—';
            const latestLines = ['gold', 'silver'].map(server => {
                const latest = stats.latestReportsByServer?.[server];
                return latest
                    ? `  - **${shortName(latest.opponent_ign || latest.ign_normalized)}** in ${SERVERS[server].markup} ${SERVERS[server].label} (<t:${Math.floor(latest.date / 1000)}:f>)`
                    : `  - No scout reports yet in ${SERVERS[server].markup} ${SERVERS[server].label}.`;
            }).join('\n');
            const latestText = `Latest Scout Report:\n${latestLines}`;
            const topOpponents = stats.opponents.slice(0, 5).map((opponent, index) =>
                `**${index + 1}.** **${shortName(opponent.name).replace(/\s+/gu, ' ')}:**\u2002**${inlineCode(opponent.reports)}**\u2002—\u2002${SERVERS.gold.markup} ${inlineCode(opponent.gold)}\u2002**•**\u2002${SERVERS.silver.markup} ${inlineCode(opponent.silver)}`);
            const topContributors = stats.contributors.slice(0, 5)
                .map((contributor, index) => this.contributorLine(contributor, index + 1));
            const screenshotCount = gold.screenshots + silver.screenshots;
            const reportsWithScreenshots = gold.reportsWithScreenshots + silver.reportsWithScreenshots;
            const teamTextReports = gold.reportsWithTeamText + silver.reportsWithTeamText;

            embed.setDescription(
                `**Scout Reports:**\u2002${inlineCode(stats.totalReports)}\n` +
                `⤷ ${SERVERS.gold.markup} Gold: ${inlineCode(gold.reports)}\u2002**•**\u2002${SERVERS.silver.markup} Silver: ${inlineCode(silver.reports)}\n` +
                `- Total Screenshots: ${inlineCode(screenshotCount)} across ${inlineCode(reportsWithScreenshots)} scout reports\n` +
                `- Total Pokémon Teams: ${inlineCode(teamTextReports)}\n\n` +
                `**Opponents Scouted:**\u2002${inlineCode(stats.totalOpponents)}\n` +
                `⤷ ${SERVERS.gold.markup} Gold: ${inlineCode(gold.opponents.size)}\u2002**•**\u2002${SERVERS.silver.markup} Silver: ${inlineCode(silver.opponents.size)}\u2002**•**\u2002${SERVERS.cross.markup} Both Servers: ${inlineCode(stats.opponentsInBoth)}\n\n` +
                `**PvP Ratings:**\u2002${inlineCode(ratings.count)} ratings scouted\n` +
                ` ⤷ ${SERVERS.gold.markup} Gold: ${inlineCode(gold.ratings.count)}\u2002**•**\u2002${SERVERS.silver.markup} Silver: ${inlineCode(silver.ratings.count)}\n` +
                `- Combined average: ${inlineCode(average)}\n` +
                `\u2002⤷ ${SERVERS.gold.markup} Gold: ${inlineCode(gold.ratings.count ? (gold.ratings.sum / gold.ratings.count).toFixed(1) : '—')}\u2002**•**\u2002${SERVERS.silver.markup} Silver: ${inlineCode(silver.ratings.count ? (silver.ratings.sum / silver.ratings.count).toFixed(1) : '—')}\n` +
                `- Lowest to Highest Rating: ${range}\n\n` +
                `**Scouting Activity**\n` +
                `- Past 30 days: ${SERVERS.gold.markup} Gold: ${inlineCode(gold.last30Days)}\u2002**•**\u2002${SERVERS.silver.markup} Silver: ${inlineCode(silver.last30Days)}\n` +
                `- Busiest month in the past year:\n` +
                `  - ${SERVERS.gold.markup} Gold: ${this.busiestMonthText(stats, 'gold', timeZone)}\n` +
                `  - ${SERVERS.silver.markup} Silver: ${this.busiestMonthText(stats, 'silver', timeZone)}\n` +
                `- ${latestText}`
            )

            embed.addFields(
                { name: '\u2002', value: '\u2002', inline: false },
                { name: '🔥\u2002Top 5 Most-Reported Opponents', value: topOpponents.join('\n') || 'No opponent reports yet.', inline: false },
                { name: '\u2002', value: '\u2002', inline: false },
                { name: '<:man_of_culture:1186287184106496112>\u2002Top 5 Contributors', value: topContributors.join('\n') || 'No contributors have been recorded yet.', inline: false }
            );
        } else {
            const start = (currentPage - 1) * CONTRIBUTOR_PAGE_SIZE;
            const contributors = stats.contributors.slice(start, start + CONTRIBUTOR_PAGE_SIZE);
            const firstGroup = contributors.slice(0, CONTRIBUTORS_PER_EMBED);
            const secondGroup = contributors.slice(CONTRIBUTORS_PER_EMBED);
            const contributorLines = (group, groupStart) => group
                .map((contributor, index) => this.contributorLine(contributor, groupStart + index + 1))
                .join('\n');
            embed.setDescription(`### <:man_of_culture:1186287184106496112>\u2002Contributors ${start + 1}–${start + firstGroup.length} of ${stats.contributors.length}\n`
                + (contributorLines(firstGroup, start) || 'No contributors have been recorded yet.'));
            if (secondGroup.length) {
                embeds.push(new EmbedBuilder().setColor(0x452366)
                    .setDescription(contributorLines(secondGroup, start + CONTRIBUTORS_PER_EMBED))
                    .setFooter({ text: `Crow Control  •  Scout Statistics  •  Contributors ${currentPage}/${contributorPageCount}`,
                        iconURL: logoReference })
                    .setTimestamp(new Date(stats.generatedAt)));
            }
        }

        const components = [];
        if (currentPage === 0) {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${ownerId}:${token}:1`)
                    .setLabel('Contributors').setEmoji('<:man_of_culture:1186287184106496112>').setStyle(ButtonStyle.Primary)
                    .setDisabled(stats.contributors.length === 0)
            ));
        } else {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${ownerId}:${token}:0`)
                    .setLabel('Back to frontpage').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
            ));
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${ownerId}:${token}:${Math.max(1, currentPage - 1)}`)
                    .setLabel('Previous Page').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
                new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${ownerId}:${token}:${currentPage + 1}`)
                    .setLabel('Next Page').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage >= contributorPageCount),
            ));
        }
        const contributorStart = currentPage === 0 ? 0 : (currentPage - 1) * CONTRIBUTOR_PAGE_SIZE;
        const contributorLimit = currentPage === 0 ? 5 : CONTRIBUTOR_PAGE_SIZE;
        const allowedUsers = stats.contributors.slice(contributorStart, contributorStart + contributorLimit)
            .map(contributor => contributor.id).filter(Boolean);
        const payload = { embeds, components, allowedMentions: { parse: [], users: allowedUsers } };
        if (!logoUrl) payload.files = [new AttachmentBuilder(LOGO_PATH, { name: 'cc_logo.webp' })];
        return payload;
    }

    async execute(interaction) {
        if (!this.canUse(interaction)) return interaction.reply({ content: 'No permission!', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const stats = await this.loadStats();
            this.pruneSessions();
            const token = randomBytes(6).toString('base64url');
            this.sessions.set(token, { ownerId: String(interaction.user.id), stats, expiresAt: Date.now() + SESSION_TTL_MS });
            const payload = this.render(stats, 0, String(interaction.user.id), token);
            await interaction.editReply(payload);
        } catch (error) {
            console.error('[CC LOG] /scout-stats failed:', error);
            await interaction.editReply({ content: 'Scout statistics are unavailable right now. Please try again later.', embeds: [], components: [] });
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId?.startsWith(BUTTON_PREFIX)) return false;
        const [, , ownerId, token, pageText] = interaction.customId.split(':');
        if (String(interaction.user.id) !== ownerId || !this.canUse(interaction)) {
            await interaction.reply({ content: 'This scout statistics view belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const session = this.sessions.get(token);
        if (!session || session.ownerId !== ownerId || session.expiresAt <= Date.now()) {
            this.sessions.delete(token);
            await interaction.reply({ content: 'This scout statistics view expired. Run `/scout-stats` again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const page = Number(pageText);
        const logoUrl = interaction.message?.attachments?.find(attachment => attachment.name === 'cc_logo.webp')?.url || null;
        await interaction.deferUpdate();
        await interaction.editReply(this.render(session.stats, page, ownerId, token, logoUrl));
        return true;
    }
}

module.exports = ScoutStats;
