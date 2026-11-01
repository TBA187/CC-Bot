// Staff tools for checking uncertain imports and correcting saved scout details.
'use strict';

const { sameValue } = require('../features/pvp-scouting/ScoutChanges.js');

const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { canonicalIgn, cleanIgn, normalizeIgn } = require('../features/pvp-scouting/PvpScoutParser.js');
const { matchSpeciesHeading } = require('../features/pvp-scouting/PokemonTeamParser.js');
const { authorDisplay } = require('../features/pvp-scouting/ScoutAuthorDisplay.js');
const { refreshImageAttachments } = require('../features/pvp-scouting/ScoutImageUrls.js');
const { mergeOriginalReport, partitionReportSources } = require('../features/pvp-scouting/ScoutReportSources.js');
const { sourceManagerFor } = require('../features/pvp-scouting/ScoutSourceManager.js');
const { isButtonLoading } = require('../utils/interactionLoading.js');
const { scoutPayload, withScoutLoading } = require('../features/pvp-scouting/ScoutPresentation.js');
const { interactionServer, bindServer, serverButtons } = require('../features/pvp-scouting/ScoutStaffServers.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { ScoutArchiveView, reportServer } = require('../features/pvp-scouting/ScoutArchiveView.js');

const PREFIX = 'pvp-scout-review:';
const PAGE_SIZE = 1;

function clipped(value, max = 3500) {
    const text = String(value || '').trim();
    if (text.length <= max) return text || '*None*';
    return `${text.slice(0, max - 20)}\n… (truncated)`;
}

function formattedReviewReason(value) {
    const escape = text => String(text).replace(/([\\`*_~])/gu, '\\$1');
    return clipped(value, 800).replace(/(^|\n)(-?\s*(?:Plain text IGN|Screenshot (?:OCR|IGN)|Existing IGN):\s*)([^\n]+)/giu,
        (_match, lineStart, label, name) => `${lineStart}${label}**${escape(name.trim())}**`);
}

function csvCell(value) {
    let text = String(value instanceof Date ? value.toISOString() : value ?? '').replace(/\r/g, '').replace(/\0/g, '');
    // Keep exported values from being treated as formulas when staff open the CSV in a spreadsheet.
    if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

function reviewImage(row) {
    for (const attachment of row.attachments || []) {
        if (String(attachment.contentType || '').startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(attachment.name || attachment.url || '')) {
            return { url: attachment.url };
        }
    }
    return null;
}

function reviewImageSource(row, originalSources = partitionReportSources(row, row.linkedSources).originalSources) {
    return [row, ...originalSources].find(source => reviewImage(source)) || null;
}

function codeFields(name, value, max = 2600) {
    const text = String(value || '').trim();
    if (!text) return [{ name, value: '`None`', inline: false }];
    const safe = clipped(text.replace(/```/gu, "'''"), max);
    const chunks = [];
    for (let start = 0; start < safe.length; start += 950) chunks.push(safe.slice(start, start + 950));
    return chunks.map((chunk, index) => ({
        name: index ? `${name} (continued)` : name,
        value: `\`\`\`\n${chunk}\n\`\`\``, inline: false
    }));
}

function editVersionText(value = {}) {
    const team = String(value.teamText || '').trim() || 'None';
    const notes = String(value.notes || '').trim() || 'None';
    const ocrText = (value.ocrResults || []).map(result => result.text || '').filter(Boolean).join('\n');
    return [
        `Message: ${String(value.content || '').trim() || 'None'}`,
        `IGN: ${value.ign || 'None'}`,
        `PvP rating: ${value.rating ?? 'None'}`,
        `Classification: ${value.classification || 'Unknown'}`,
        `Pokémon team: ${team}`,
        `Additional notes: ${notes}`,
        ocrText ? `Screenshot OCR:\n${ocrText}` : ''
    ].filter(Boolean).join('\n\n');
}

function correctionSummary(before, after) {
    const changes = [];
    const name = value => canonicalIgn(value) || 'Not detected';
    if (!sameValue('ign', before.opponent_ign, after.opponent_ign)) changes.push(`IGN: **${name(before.opponent_ign)}** → **${name(after.opponent_ign)}**`);
    if (!sameValue('rating', before.rating, after.rating)) changes.push(`PvP rating: **${before.rating ?? 'None'}** → **${after.rating ?? 'None'}**`);
    if (String(before.team_text || '') !== String(after.team_text || '')) changes.push('Pokémon team updated');
    if (String(before.notes || '') !== String(after.notes || '')) changes.push('Additional notes updated');
    if (String(before.message_content || '') !== String(after.message_content || '')) changes.push('Source message text updated');
    if (!sameValue('attachments', before.attachments, after.attachments)) {
        changes.push(`Screenshots updated (${(before.attachments || []).length} → ${(after.attachments || []).length})`);
    }
    return changes.length ? changes.join('; ') + '.' : 'Existing scout details verified; no values needed changing.';
}

function reviewPayload(row, page, total, userId, authorName = null) {
    const { rootSource, originalSources, replies, additionalSources } = partitionReportSources(row, row.linkedSources);
    const originalReport = mergeOriginalReport(originalSources, row.opponent_ign || rootSource.opponent_ign);
    const ocrText = originalReport.ocrResults.map(result => result.text || '').filter(Boolean).join('\n\n');
    const imageSource = reviewImageSource(row, originalSources);
    const postedAt = new Date(rootSource.created_at).getTime();
    const posted = Number.isFinite(postedAt) ? `<t:${Math.floor(postedAt / 1000)}:F>` : 'Unknown';
    const author = authorName || rootSource.author_username || 'Unknown';
    const scoutedBy = author;
    const sourceLines = [
        ...(row.pending_edit ? ['**Review type:** Recent member edit'] : []),
        ...originalSources.filter(source => source.source_url).slice(0, 1).map(source =>
            `**Scout Source:** [**Jump to message**  ↗️](${source.source_url})`),
        ...replies.filter(source => source.source_url).map(source =>
            `**Scout Reply:** [**Jump to reply-message**  ↗️](${source.source_url})`),
        ...additionalSources.filter(source => source.source_url).map(source =>
            `**Linked Scout Source:** [**Jump to message**  ↗️](${source.source_url})`),
        `-# **Scouted by:** ${scoutedBy} - ${posted}`
    ];
    const editFields = row.pending_edit ? [
        { name: 'Edited by', value: `${clipped(row.edit_after?.authorUsername || row.author_username || 'Unknown member', 128)} • revision ${row.edit_revision}`, inline: false },
        ...codeFields('Old saved values', editVersionText(row.edit_before || {}), 2100),
        ...codeFields('Proposed edited values', editVersionText(row.edit_after || {}), 2100)
    ] : [];
    const embed = new EmbedBuilder()
        .setColor(SERVERS[reportServer(row)].color)
        .setTitle(`Scout review ${page + 1} of ${total}`)
        .setDescription(sourceLines.join('\n'))
        .addFields(
            { name: row.pending_edit ? 'Current Candidate IGN' : 'Candidate IGN', value: clipped(canonicalIgn(row.opponent_ign) || 'Not detected', 128), inline: true },
            { name: row.pending_edit ? 'Current PvP Rating' : 'PvP Rating', value: row.rating === null || row.rating === undefined ? '*None*' : String(row.rating), inline: true },
            {
                name: 'Confidence Score', value: row.opponent_ign
                    ? `${Math.round(Number(row.ign_confidence || 0) * 100)}%` : 'Not detected', inline: true
            },
            { name: 'Reason', value: formattedReviewReason(row.review_reason), inline: false },
            ...editFields,
            ...(row.pending_edit ? [] : codeFields('Message text', originalReport.messageText, 1400)),
            ...(row.pending_edit || !originalReport.teamText ? [] : codeFields('Pokémon Team', originalReport.teamText, 800)),
            ...(row.pending_edit ? [] : codeFields('OCR text extracted from screenshot',
                ocrText || (imageSource ? 'No OCR text detected' : 'No screenshot'), 1300))
        )
        .setFooter({ text: `Message ${row.message_id} • team layout ${row.team_layout_status || 'unprocessed'}` });

    const linkedText = replies
        .map(source => String(source.message_content || '').trim()).filter(Boolean).join('\n');
    if (linkedText && !row.pending_edit) embed.addFields(...codeFields('Linked scouting messages', linkedText, 600));

    const image = imageSource ? reviewImage(imageSource) : null;
    if (image?.url) embed.setImage(image.url);
    const buttons = row.pending_edit
        ? new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}prev:${userId}:${page}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
            new ButtonBuilder().setCustomId(`${PREFIX}next:${userId}:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
            new ButtonBuilder().setCustomId(`${PREFIX}accept-edit:${userId}:${row.message_id}:${page}`).setLabel('Accept changes').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${PREFIX}keep-edit:${userId}:${row.message_id}:${page}`).setLabel('Keep existing').setStyle(ButtonStyle.Danger)
        )
        : new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}prev:${userId}:${page}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
            new ButtonBuilder().setCustomId(`${PREFIX}next:${userId}:${page}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
            new ButtonBuilder().setCustomId(`${PREFIX}confirm:${userId}:${row.message_id}:${page}`).setLabel('Confirm').setStyle(ButtonStyle.Success).setDisabled(!row.opponent_ign),
            new ButtonBuilder().setCustomId(`${PREFIX}edit:${userId}:${row.message_id}:${page}`).setLabel('Correct').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`${PREFIX}ignore:${userId}:${row.message_id}:${page}`).setLabel('Not a scout').setStyle(ButtonStyle.Danger)
        );
    const payload = { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
    payload.components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`scout-sources:open:${userId}:${row.message_id}`).setLabel('Manage sources / replies').setStyle(ButtonStyle.Secondary)));
    return payload;
}

class ScoutReview {
    constructor(config) {
        this.name = 'scout-review';
        this.client = config.client;
        this.store = config.pvpScoutStore;
        this.ingestor = config.pvpScoutIngestor;
        this.channelId = String(config.scoutChannelId || config.pvpScoutingGoldChannelID || '');
        this.server = config.scoutServer || null;
        this.config = config;
        this.registry = config.scoutArchiveRegistry || config.scoutServers || null;
        this.ownerID = String(config.ownerID || '');
        this.allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID]
            .map(value => String(value || '')).filter(Boolean);
        this.reviewRows = new Map();
        this.sourceManager = sourceManagerFor(config);
        this.data = new SlashCommandBuilder()
            .setName('scout-review')
            .setDescription('Review uncertain PvP scouting reports.')
            .addStringOption(option => option
                .setName('action')
                .setDescription('Review in Discord or export the review list.')
                .setRequired(true)
                .addChoices(
                    { name: 'Discord Review', value: 'queue' },
                    { name: 'Export CSV', value: 'export' },
                    { name: 'Manage report sources / replies', value: 'sources' }
                ))
            .addIntegerOption(option => option
                .setName('page')
                .setDescription('Review queue page number.')
                .setMinValue(1))
            .addStringOption(option => option.setName('report').setDescription('Message/report ID or Discord link for managing sources.'))
            .addStringOption(option => option.setName('server').setDescription('Choose the scout server to review.')
                .addChoices({ name: 'Gold', value: 'gold' }, { name: 'Silver', value: 'silver' }, { name: 'Cross Server', value: 'cross' }));
        if (config.scoutServers) {
            this.scoped = new Map(config.scoutServers.contexts().map(context => [context.server, new ScoutReview({
                ...config, scoutServers: null, scoutArchiveRegistry: this.registry, scoutServer: context.server, scoutChannelId: context.channelId,
                pvpScoutStore: context.store, pvpScoutIngestor: context.ingestor
            })]));
            const combined = new ScoutArchiveView(this.registry);
            this.scoped.set('cross', new ScoutReview({ ...config, scoutServers: null, scoutArchiveRegistry: this.registry,
                scoutServer: 'cross', pvpScoutStore: combined, pvpScoutIngestor: combined.ingestor }));
        }
    }

    isStaff(interaction) {
        // Check permissions again on button and modal actions, not just when the command is opened.
        if (this.ownerID && String(interaction.user?.id) === this.ownerID) return true;
        const roles = interaction.member?.roles?.cache;
        return Boolean(roles?.some(role => this.allowedRoles.includes(String(role.id))));
    }

    reviewSources(row) {
        const context = this.registry?.get?.(reportServer(row));
        const store = context && String(context.channelId) === String(row.channel_id) ? context.store : this.store;
        return store.sourcesForRoots([row.root_message_id || row.message_id], row.channel_id || this.channelId);
    }

    async queuePayload(page, userId, guild = null) {
        const requestedPage = Math.max(0, Number(page) || 0);
        const rowsPromise = this.store.pendingReviews(PAGE_SIZE, requestedPage, this.channelId);
        const [total, requestedRows, requestedSources] = await Promise.all([
            this.store.pendingReviewCount(this.channelId),
            rowsPromise,
            rowsPromise.then(rows => rows.length ? this.reviewSources(rows[0]) : [])
        ]);
        if (!total) {
            const server = SERVERS[this.server || 'gold'];
            return this.serverPanel({ content: `### The ${server.markup} **${server.label}** scout review queue is empty.`,
                embeds: [new EmbedBuilder().setColor(server.color).setTitle(`${server.label} Scout Review`)
                    .setFooter({ text: 'Crow Control Scout Review' }).setTimestamp()], components: [] }, userId);
        }
        const currentPage = Math.max(0, Math.min(total - 1, requestedPage));
        const rows = currentPage === requestedPage
            ? requestedRows : await this.store.pendingReviews(PAGE_SIZE, currentPage, this.channelId);
        if (!rows.length) return this.serverPanel({ content: '### The scout review queue changed. Run `/scout-review` again.', embeds: [], components: [] }, userId);
        if (rows[0].pending_edit && rows[0].edit_after) {
            rows[0].attachments = rows[0].edit_after.attachments || rows[0].attachments;
            rows[0].ocrResults = rows[0].edit_after.ocrResults || rows[0].ocrResults;
        }
        const linkedSources = currentPage === requestedPage ? requestedSources : await this.reviewSources(rows[0]);
        const { rootSource } = partitionReportSources(rows[0], linkedSources);
        const author = await authorDisplay(guild, rootSource);
        rows[0].linkedSources = linkedSources;
        rows[0].reviewAuthor = author;
        // Keep form defaults ready so the Correct button can open its modal without a database round trip.
        this.reviewRows.delete(String(rows[0].message_id));
        this.reviewRows.set(String(rows[0].message_id), rows[0]);
        if (this.reviewRows.size > 100) this.reviewRows.delete(this.reviewRows.keys().next().value);
        return this.serverPanel(reviewPayload(rows[0], currentPage, total, userId, author), userId, reportServer(rows[0]));
    }

    serverPanel(payload, userId, actualServer = null) {
        if (!this.server) return payload;
        bindServer(payload, this.server);
        if (actualServer && payload.embeds?.[0]) payload.embeds[0]
            .setColor(SERVERS[actualServer].color).setTitle(`${SERVERS[actualServer].label} ${payload.embeds[0].data.title}`);
        // Source editing stays in the displayed report's archive, even in a combined queue.
        if (actualServer) for (const row of payload.components || []) for (const component of row.components || []) {
            const id = component.data?.custom_id;
            if (id?.startsWith('scout-sources:')) component.setCustomId(id.replace(/:(gold|silver|cross)$/u, '') + `:${actualServer}`);
        }
        payload.components ||= [];
        payload.components.push(serverButtons(`${PREFIX}server:`, userId, this.server, '', true));
        return payload;
    }

    scheduleReviewImageRefresh(interaction, payload) {
        const embed = payload?.embeds?.[0];
        const messageId = String((embed?.toJSON?.() || embed)?.footer?.text || '').match(/Message (\d+)/u)?.[1];
        const row = messageId ? this.reviewRows.get(messageId) : null;
        if (!row) return;
        const imageSource = reviewImageSource(row);
        if (!imageSource) return;
        const revision = this.store.dataRevision;
        void (async () => {
            try {
                const before = reviewImage(imageSource)?.url;
                await this.refreshImageUrl(imageSource);
                const after = reviewImage(imageSource)?.url;
                if (!after || before === after) return;
                const reply = await interaction.fetchReply();
                if (isButtonLoading(reply.id)) return;
                if (!String(reply.embeds?.[0]?.footer?.text || '').includes(`Message ${messageId}`)) return;
                if (this.server) {
                    const controls = (reply.components || []).flatMap(row => row.components || row.data?.components || []);
                    const active = controls.find(button => (button.customId || button.data?.custom_id || button.custom_id || '')
                        .startsWith(`${PREFIX}server:`) && (button.style || button.data?.style) === ButtonStyle.Primary);
                    const id = active?.customId || active?.data?.custom_id || active?.custom_id;
                    // Gold and Cross Server can display the same report. Its ID
                    // alone cannot establish that this is still the original filter.
                    if (id !== `${PREFIX}server:${interaction.user.id}:${this.server}`) return;
                }
                const title = String(reply.embeds?.[0]?.title || '');
                if (!/^(?:(?:Gold|Silver) )?Scout review /u.test(title)) return;
                if (this.store.dataRevision !== revision || this.reviewRows.get(messageId) !== row) return;
                await interaction.editReply(scoutPayload(this.serverPanel(reviewPayload(row, Number(title.match(/Scout review (\d+)/u)?.[1] || 1) - 1,
                    Number(title.match(/ of (\d+)/u)?.[1] || 1), interaction.user.id, row.reviewAuthor), interaction.user.id, reportServer(row)), reply));
            } catch (error) {
                console.warn(`[CC LOG] Could not refresh a /scout-review screenshot in the background: ${error.message}`);
            }
        })();
    }

    async runReviewAction(interaction, label, task, page, userId, messageId = null) {
        let savedFeedback = null;
        let feedbackDelivered = false;
        return withScoutLoading(interaction, async () => {
            savedFeedback = await task();
            if (savedFeedback) {
                await interaction.followUp({ content: savedFeedback, flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] } }).then(() => { feedbackDelivered = true; }).catch(error => {
                    console.warn(`[CC LOG] Could not send scout review feedback: ${error.message}`);
                });
                await this.regroupAfterReview();
                if (messageId) void Promise.resolve(this.ingestor?.refreshMessageFeedback?.(messageId)).catch(error => {
                    console.warn(`[CC LOG] Could not refresh public scout review feedback: ${error.message}`);
                });
            }
            const payload = await this.queuePayload(page, userId, interaction.guild);
            // Use the panel as a fallback if the separate feedback could not be delivered.
            return { ...payload, content: savedFeedback && !feedbackDelivered
                ? [savedFeedback, payload.content].filter(Boolean).join('\n\n') : payload.content ?? null };
        }, { label, logContext: 'Scout review action',
            errorMessage: error => savedFeedback || error.scoutDecisionSaved
                ? '⚠️ Your review decision was saved, but the final refresh could not finish. Reopen `/scout-review`.'
                : error.code === 'SCOUT_REVIEW_STALE' ? `❌ Review action not saved: ${error.message}`
                    : '❌ Could not save the review action. Reopen `/scout-review` to check its current status before retrying.',
            onLoaded: payload => this.scheduleReviewImageRefresh(interaction, payload) });
    }

    async refreshImageUrl(row) {
        await refreshImageAttachments(this.client, row);
    }

    async regroupAfterReview() {
        if (!this.ingestor) return;
        try {
            await this.ingestor.rebuildGroups();
        } catch (error) {
            console.error('[CC LOG] Could not rebuild PvP scout groups after review:', error);
        }
    }

    async csvPayload() {
        const rows = await this.store.exportPendingReviews(this.channelId);
        if (!rows.length) return { content: 'There are no unresolved scout messages to export.', embeds: [], components: [] };
        const headers = [
            'message_id', 'server', 'source_url', 'created_at', 'author', 'classification', 'candidate_ign',
            'rating', 'team_layout_status', 'team_text', 'notes', 'review_reason', 'ocr_text', 'attachment_urls'
        ];
        const lines = [headers.map(csvCell).join(',')];
        for (const row of rows) {
            const values = [
                row.message_id, reportServer(row), row.source_url, row.created_at, row.author_username,
                row.classification, row.opponent_ign, row.rating, row.team_layout_status, row.team_text,
                row.notes || row.message_content, row.review_reason,
                (row.ocrResults || []).map(result => result.text || result.error || '').join('\n'),
                (row.attachments || []).map(attachment => attachment.url).join('\n')
            ];
            lines.push(values.map(csvCell).join(','));
        }
        const csv = `\uFEFF${lines.join('\r\n')}`;
        return {
            content: `Exported ${rows.length} unresolved scouting message(s).`,
            files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'pvp-scout-review.csv' })],
            embeds: [], components: []
        };
    }

    async execute(interaction) {
        if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!interaction.inGuild()) {
            return interaction.editReply({ content: 'This command can only be used in the server.' });
        }
        if (!this.isStaff(interaction)) {
            return interaction.editReply({ content: 'Only the guild leader, Admins, or Officers can review scout data.' });
        }
        if (this.scoped) {
            try { return await this.scoped.get(interaction.options.getString('server') || 'cross').execute(interaction); }
            catch (error) {
                console.error('[CC LOG] Could not select the scout review server:', error);
                return interaction.editReply({ content: 'The scout review database is unavailable right now.', embeds: [], components: [] });
            }
        }
        try {
            if (interaction.options.getString('action', true) === 'export') {
                return interaction.editReply(await this.csvPayload());
            }
            if (interaction.options.getString('action', true) === 'sources') {
                const { idFrom } = require('../features/pvp-scouting/ScoutSourceManager.js');
                const id = idFrom(interaction.options.getString('report'));
                const context = id && this.server === 'cross' ? await this.store.owner(id) : null;
                const manager = context ? sourceManagerFor({ ...this.config, scoutServers: null, scoutServer: context.server,
                    scoutChannelId: context.channelId, pvpScoutStore: context.store, pvpScoutIngestor: context.ingestor }) : this.sourceManager;
                return interaction.editReply(scoutPayload(id ? await manager.panel(interaction.user.id, id)
                    : { content: 'Provide the report/message ID or Discord link in the `report` option.' }));
            }
            const page = Math.max(0, (interaction.options.getInteger('page') || 1) - 1);
            const payload = await this.queuePayload(page, interaction.user.id, interaction.guild);
            await interaction.editReply(scoutPayload(payload));
            this.scheduleReviewImageRefresh(interaction, payload);
            return;
        } catch (error) {
            console.error('[CC LOG] /scout-review failed:', error);
            return interaction.editReply({ content: 'The scout review database is unavailable right now.', embeds: [], components: [] });
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId.startsWith(PREFIX)) return false;
        if (this.scoped) return this.scoped.get(interactionServer(interaction)).handleButton(interaction);
        if (!this.isStaff(interaction)) {
            await interaction.reply({ content: 'Only the guild leader, Admins, or Officers can review scout data.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const [, action, ownerId, target, pageValue] = interaction.customId.split(':');
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This review queue belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const page = Number(pageValue) || 0;
        if (action === 'server') {
            await this.runReviewAction(interaction, 'Loading scout server...', async () => {}, 0, ownerId);
            return true;
        }
        if (action === 'prev' || action === 'next') {
            const currentPage = Number(target) || 0;
            const nextPage = action === 'next' ? currentPage + 1 : Math.max(0, currentPage - 1);
            await this.runReviewAction(interaction, 'Loading scout...', async () => { }, nextPage, ownerId);
            return true;
        }
        const messageId = target;
        if (action === 'accept-edit' || action === 'keep-edit') {
            const accept = action === 'accept-edit';
            await this.runReviewAction(interaction,
                accept ? 'Accepting scout edit...' : 'Keeping existing scout report...',
                async () => {
                    const before = await this.store.getMessage(messageId);
                    const after = await this.store.resolveEditReview(messageId, interaction.user.id, accept, {
                        requirePending: true, expectedRevision: this.reviewRows.get(String(messageId))?.edit_revision
                    });
                    if (!before || !after) throw new Error('The scout message is no longer available.');
                    const title = `**${canonicalIgn(after.opponent_ign || before.opponent_ign) || 'Unknown opponent'}** (\`${messageId}\`)`;
                    return accept ? `✅ Accepted the edited scout report for ${title}.\n${correctionSummary(before, after)}`
                        + (after.review_status === 'pending' ? '\nThe updated report still needs an opponent IGN review.' : '')
                        : `✅ Declined the proposed edit for ${title}. The existing published values were kept.`;
                }, Math.max(0, page), ownerId, messageId);
            return true;
        }
        if (action === 'edit') {
            const row = this.reviewRows.get(String(messageId));
            const modal = new ModalBuilder()
                .setCustomId(`${PREFIX}modal:${ownerId}:${messageId}:${page}${this.server ? `:${this.server}` : ''}`)
                .setTitle('Correct scouting extraction');
            const ign = new TextInputBuilder().setCustomId('ign').setLabel('Opponent IGN').setStyle(TextInputStyle.Short)
                .setRequired(true).setMaxLength(32);
            if (row?.opponent_ign && !/different opponents/i.test(row.review_reason || '')
                && (Number(row.ign_confidence) >= 0.8
                    || ['confirmed', 'corrected'].includes(row.review_status))) {
                ign.setValue(canonicalIgn(row.opponent_ign).slice(0, 32));
            }
            const rating = new TextInputBuilder().setCustomId('rating').setLabel('PvP rating (optional)').setStyle(TextInputStyle.Short)
                .setRequired(false).setMaxLength(5);
            if (row?.rating !== null && row?.rating !== undefined) rating.setValue(String(row.rating));
            const originalSources = row ? partitionReportSources(row, row.linkedSources).originalSources : [];
            const correctionSources = originalSources.some(source => String(source.message_id) === String(row?.message_id))
                ? originalSources : row ? [row] : [];
            const originalReport = mergeOriginalReport(correctionSources, row?.opponent_ign);
            const combinedTeam = originalReport.teamText;
            const hasRecognizableTeam = combinedTeam.split('\n').some(line =>
                matchSpeciesHeading(line.replace(/^\s*(?:[-•]|\d+[.)])\s*/u, ''))?.species);
            const teamValue = hasRecognizableTeam ? combinedTeam.slice(0, 1000) : '';
            const notesValue = originalReport.notes.slice(0, 1000);
            const team = new TextInputBuilder().setCustomId('team').setLabel('Team or readable screenshot details').setStyle(TextInputStyle.Paragraph)
                .setRequired(false).setMaxLength(1000);
            if (teamValue) team.setValue(teamValue);
            const notes = new TextInputBuilder().setCustomId('notes').setLabel('Additional notes').setStyle(TextInputStyle.Paragraph)
                .setRequired(false).setMaxLength(1000);
            if (notesValue) notes.setValue(notesValue);
            modal.addComponents(
                new ActionRowBuilder().addComponents(ign),
                new ActionRowBuilder().addComponents(rating),
                new ActionRowBuilder().addComponents(team),
                new ActionRowBuilder().addComponents(notes)
            );
            await interaction.showModal(modal);
            return true;
        }

        if (action !== 'confirm' && action !== 'ignore') return false;
        await this.runReviewAction(interaction,
            action === 'confirm' ? 'Confirming scout...' : 'Removing scout...',
            async () => {
                if (action === 'confirm') {
                    const saved = await this.store.confirmReview(messageId, interaction.user.id, { requirePending: true });
                    return `✅ Approved scout report **${canonicalIgn(saved.opponent_ign) || 'Unknown opponent'}** (\`${messageId}\`). `
                        + 'The saved scout details were accepted and removed from the review queue.';
                }
                await this.store.markNotScout(messageId, interaction.user.id, { requirePending: true });
                return `✅ Declined message \`${messageId}\` as **Not a scout**. This source is excluded from \`/scout\` and the review queue.`;
            }, Math.max(0, page), ownerId, messageId);
        return true;
    }

    async handleModal(interaction) {
        if (!interaction.customId.startsWith(`${PREFIX}modal:`)) return false;
        if (this.scoped) return this.scoped.get(interactionServer(interaction)).handleModal(interaction);
        if (!this.isStaff(interaction)) {
            await interaction.reply({ content: 'Only the guild leader, Admins, or Officers can review scout data.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const [, , ownerId, messageId, pageValue] = interaction.customId.split(':');
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This review form belongs to another member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const ign = cleanIgn(interaction.fields.getTextInputValue('ign'));
        const ratingText = interaction.fields.getTextInputValue('rating').trim();
        const rating = ratingText ? Number(ratingText) : null;
        if (!ign) {
            await interaction.reply({ content: '❌ Correction not saved: enter a valid opponent IGN (2–32 letters, numbers, dots, underscores, or hyphens).', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (ratingText && (!Number.isInteger(rating) || rating < 0 || rating > 9999)) {
            await interaction.reply({ content: '❌ Correction not saved: rating must be a whole number from 0 to 9999.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await this.runReviewAction(interaction, 'Saving correction...', async () => {
            const existing = await this.store.getMessage(messageId);
            if (!existing) {
                const error = new Error('This scout message is no longer available.');
                error.code = 'SCOUT_REVIEW_STALE';
                throw error;
            }
            const saved = await this.store.correctReview(messageId, interaction.user.id, {
                ign,
                ignNormalized: normalizeIgn(ign),
                rating: ratingText ? rating : null,
                teamText: interaction.fields.getTextInputValue('team').trim() || null,
                notes: interaction.fields.getTextInputValue('notes').trim() || null
            }, { requirePending: true });
            return `✅ Corrected scout report **${canonicalIgn(saved.opponent_ign)}** (\`${messageId}\`).\n`
                + correctionSummary(existing, saved);
        }, Math.max(0, Number(pageValue) || 0), ownerId, messageId);
        return true;
    }
}

module.exports = ScoutReview;
module.exports.csvCell = csvCell;
module.exports.reviewPayload = reviewPayload;
