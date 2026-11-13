// Archives scouting messages and OCR, then groups replies and short follow-up runs together.
'use strict';

const { PvpScoutOcr, SCAN_VERSION } = require('./PvpScoutOcr.js');
const { extractScoutData, extractRating, candidateFromText, cleanIgn, isClearlySpamTeam, normalizeIgn, hasImageEvidence, isClearlyOffTopicText } = require('./PvpScoutParser.js');
const { hasKnownTeamDetail, isPokemonDetailNote, matchKnownTermHeading, matchSpeciesHeading,
    reportContextSpecies, resolveNoteShorthand, sameTeamSpecies, splitScoutText } = require('./PokemonTeamParser.js');
const { setImmediate: yieldToEvents } = require('node:timers/promises');
const { ScoutMessageFeedback, feedbackOutcome } = require('./ScoutMessageFeedback.js');
const { contentHash, discordMessageId, scoutVersion } = require('./PvpScoutStore.js');
const { runtimeActivity } = require('../../utils/runtimeActivity.js');
const { ScoutDeletionReview } = require('./ScoutDeletionReview.js');

const { canAutoApplyScoutEdit, comparisonParse, hasOfficerDecision, mergeReviewedEdit,
    spamEditReason } = require('./ScoutEditPolicy.js');

const EDIT_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 100;
const CATCHUP_PROGRESS_INTERVAL_MS = 30_000;
const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000;
const IMMEDIATE_FOLLOW_UP_WINDOW_MS = 2 * 60 * 1000;

function submittedScoutEmbed(message, botId) {
    if (!botId || String(message.author?.id) !== String(botId)) return null;
    return message.embeds?.find(embed => String(embed.title || '').startsWith('PvP Scout Report — ')
        && /^https:\/\/discord\.com\/users\/\d+$/u.test(embed.author?.url || '')) || null;
}

function canArchiveMessage(message, botId) {
    return !(message?.author?.bot || message?.webhookId || botId && String(message?.author?.id) === String(botId))
        || Boolean(submittedScoutEmbed(message, botId));
}

function teamSpecies(row, contextual = false, contextSpecies = []) {
    const team = row?.team_text || row?.teamText
        || contextual && splitScoutText(row?.message_content, null, { allowContextualDetails: true, contextSpecies }).teamText;
    return new Set(String(team || '').split(/\n/u)
        .map(line => matchSpeciesHeading(line.replace(/^\s*[-•]\s*/u, ''))?.species)
        .filter(Boolean));
}

function attachmentIsImage(attachment = {}) {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const name = String(attachment.name || attachment.url || '').toLowerCase();
    return contentType.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(name);
}

function attachmentRecord(attachment) {
    return {
        id: String(attachment.id || ''),
        name: String(attachment.name || ''),
        url: String(attachment.url || ''),
        proxyURL: String(attachment.proxyURL || ''),
        contentType: attachment.contentType || null,
        size: Number(attachment.size || 0),
        width: attachment.width || null,
        height: attachment.height || null
    };
}

function discordSourceUrl(message) {
    if (message.url) return String(message.url);
    const guildId = message.guildId || message.guild?.id || '@me';
    return `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
}

function messageTimestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
}

function rowHasScoutEvidence(row, contextual = false, contextSpecies = []) {
    if (!row || row.is_deleted || row.review_status === 'not_scout'
        || row.ign_source === 'multiple_opponents'
        || row.ign_source === 'member_submission' && row.review_status === 'pending') return false;
    if (hasImageEvidence(row.attachments)) return true;
    const text = String(row.message_content || '');
    if (isClearlyOffTopicText(text)) return false;
    if (['scout', 'review'].includes(row.classification)) return true;
    const heading = (contextual ? resolveNoteShorthand(text, contextSpecies) : text).trim().replace(/^[-*•]\s*/u, '');
    const pokemon = matchSpeciesHeading(heading, {
        allowBroadAlias: true, allowTypo: contextual && hasKnownTeamDetail(heading, { allowTypo: true })
    });
    const observation = contextual && /^(?:he|it|the\s+opponent)\s+(?:has|had|got|holds|used|uses|runs)\b/iu.test(heading)
        && hasKnownTeamDetail(heading, { allowTypo: true });
    if (!pokemon?.species && !observation
        && !matchKnownTermHeading(heading) && !/^z[- ]?moves?\b/iu.test(heading)) return false;
    // A nameless move/item fragment can belong to an established scout.
    // Merely mentioning a Pokémon in conversation is insufficient.
    const team = teamSpecies(row, contextual, contextSpecies);
    const parsedDetails = String(row.team_text || row.teamText || '');
    // "Kommo-o z" is an item/move note, including in older archived rows.
    const zMove = pokemon?.species && /^[\s:(=-]*z[\s).!?]*$/iu.test(heading.slice(pokemon.end));
    return team.size > 0 && (zMove || contextual && isPokemonDetailNote(heading)
        || hasKnownTeamDetail(heading, { allowTypo: true }) || /[:=()]/u.test(text)
        || /\((?:Item|Ability|Nature|Other):|:\s*\S/iu.test(parsedDetails));
}

function mayJoinReport(row, root, previous, explicitReply, windowMs = FOLLOW_UP_WINDOW_MS) {
    if (row?.channel_id && root?.channel_id && String(row.channel_id) !== String(root.channel_id)) return false;
    if (row?.server && root?.server && row.server !== root.server) return false;
    const sameAuthor = Boolean(row?.author_id && root?.author_id
        && String(row.author_id) === String(root.author_id));
    const continuingReply = !explicitReply && previous?.message_id !== root?.message_id
        && row?.author_id && String(row.author_id) === String(previous?.author_id || '');
    const contextual = (sameAuthor || continuingReply || explicitReply) && ['scout', 'review'].includes(root?.classification);
    const contextSpecies = contextual ? reportContextSpecies(root) : [];
    if (!rowHasScoutEvidence(row, contextual, contextSpecies) || !rowHasScoutEvidence(root)) return false;
    const name = String(row.ign_normalized || '').toLowerCase();
    const rootName = String(root.ign_normalized || '').toLowerCase();
    if (name && rootName && name !== rootName) return false;
    const species = teamSpecies(row, contextual, contextSpecies);
    const rootSpecies = root.species || teamSpecies(root);
    const shared = [...species].filter(value => [...rootSpecies].some(original => sameTeamSpecies(value, original))).length;
    const rootRating = root.rating ?? extractRating(root.message_content, root.opponent_ign);
    const sourceRating = row.rating ?? extractRating(row.message_content, row.opponent_ign);
    if (sourceRating != null && rootRating != null && Number(sourceRating) !== Number(rootRating)) return false;
    const combinedSpecies = [...rootSpecies];
    for (const value of species) {
        if (!combinedSpecies.some(original => sameTeamSpecies(value, original))) combinedSpecies.push(value);
    }
    if (!explicitReply && combinedSpecies.length > 6) return false;
    // An explicitly different/full team is a separate report, even for the same IGN.
    if (species.size >= 4 && rootSpecies.size >= 4 && shared < 3) return false;
    if (explicitReply) return true;
    if (!sameAuthor && !continuingReply) return false;
    const elapsed = messageTimestamp(row.created_at) - messageTimestamp(previous?.created_at || root.created_at);
    if (elapsed < 0 || elapsed > windowMs) return false;
    const bothImages = hasImageEvidence(row.attachments) && hasImageEvidence(root.attachments);
    if (bothImages) return false;
    // Repeating the opponent alongside a team starts another battle report.
    // Nameless move/item fragments and a screenshot followed by its text still join.
    const statedName = normalizeIgn(candidateFromText(row.message_content)?.ign);
    if (statedName && statedName === name && rootName && species.size && rootSpecies.size) return false;
    if (name && rootName) return true;
    return elapsed <= IMMEDIATE_FOLLOW_UP_WINDOW_MS || shared >= 3
        || !hasImageEvidence(row.attachments) && !name && species.size > 0;
}

function groupLink(row, rootId, root) {
    const link = { messageId: String(row.message_id), rootMessageId: String(rootId) };
    if (row.classification !== 'ignored' || row.review_status !== 'not_required'
        || row.reviewed_by_id || row.staffOverrides?.locked) return link;
    const details = splitScoutText(row.message_content, null, {
        allowContextualDetails: true, contextSpecies: reportContextSpecies(root)
    });
    if (details.teamText && (details.teamText !== row.team_text || details.notes !== row.notes)) {
        link.teamDetails = { teamText: details.teamText, notes: details.notes, contentHash: row.content_hash };
    }
    return link;
}

function savedContinuation(row, root) {
    if (!root) return false;
    const rowRating = row.rating ?? extractRating(row.message_content, row.opponent_ign);
    const rootRating = root.rating ?? extractRating(root.message_content, root.opponent_ign);
    if (rowRating != null && rootRating != null && Number(rowRating) !== Number(rootRating)) return false;
    const stated = normalizeIgn(candidateFromText(row.message_content)?.ign);
    if (stated && root.ign_normalized && stated !== normalizeIgn(root.ign_normalized)) return false;
    if (!row.reply_to_id && stated && teamSpecies(row).size) return false;
    // Existing officer-reviewed image pairs can be crops of one battle.
    if (!row.reply_to_id && hasImageEvidence(row.attachments) && hasImageEvidence(root.attachments)
        && !['confirmed', 'corrected'].includes(row.review_status)) return false;
    return true;
}

// One state machine is shared by the pure helper and paged archive rebuilding.
function groupRows(rows, state, followUpWindowMs = FOLLOW_UP_WINDOW_MS) {
    const links = [];
    const promotions = [];
    const { roots, messageRoots } = state;
    for (const row of rows) {
        const id = String(row.message_id);
        if (row.is_deleted) {
            messageRoots.set(id, null);
            state.previous = null;
            continue;
        }
        let rootId = id;
        const manualRootId = row.staffOverrides?.rootMessageId;
        const savedRootId = row.root_message_id && String(row.root_message_id) !== id ? String(row.root_message_id) : null;
        const preserveContinuation = savedRootId && savedContinuation(row, roots.get(savedRootId));
        const parentRootId = row.reply_to_id && messageRoots.get(String(row.reply_to_id));
        const parentRoot = roots.get(parentRootId);
        if (manualRootId) rootId = String(manualRootId);
        else if (preserveContinuation) rootId = savedRootId;
        else if (parentRoot && mayJoinReport(row, parentRoot, parentRoot, true, followUpWindowMs)) rootId = parentRootId;
        if (!manualRootId && !preserveContinuation && !row.reply_to_id && rootId === id && state.previous
            && row.author_id && String(state.previous.author_id || '') === String(row.author_id)) {
            const priorRootId = messageRoots.get(String(state.previous.message_id));
            const priorRoot = roots.get(priorRootId);
            if (priorRoot && mayJoinReport(row, priorRoot, state.previous, false, followUpWindowMs)) rootId = priorRootId;
        }
        messageRoots.set(id, rootId);
        if (rootId === id) roots.set(id, { ...row, species: teamSpecies(row) });
        else {
            const root = roots.get(rootId);
            links.push(groupLink(row, rootId, root));
            if (root && !root.ign_normalized && row.ign_normalized) {
                root.ign_normalized = row.ign_normalized;
                promotions.push({ rootMessageId: rootId, sourceMessageId: id });
            }
            if (root) for (const species of teamSpecies(row, true, reportContextSpecies(root))) root.species.add(species);
        }
        state.previous = row;
    }
    return { links, promotions, messageRoots, roots };
}

function buildGroupLinks(rows, followUpWindowMs = FOLLOW_UP_WINDOW_MS) {
    return groupRows(rows, { roots: new Map(), messageRoots: new Map(), previous: null }, followUpWindowMs);
}

class PvpScoutIngestor {
    constructor(options = {}) {
        this.client = options.client;
        this.activity = options.activity || runtimeActivity;
        this.store = options.store;
        this.rosterStore = options.rosterStore || null;
        this.guildId = String(options.guildId || '');
        this.channelId = String(options.channelId || '');
        this.server = options.server === 'silver' ? 'silver' : 'gold';
        this.officerChannelId = String(options.officerChannelId || '');
        this.ocr = options.ocr || new PvpScoutOcr({ ...options.ocrOptions,
            activityLabel: `PvP Scout ${this.server === 'silver' ? 'Silver' : 'Gold'}` });
        this.stopped = false;
        this.started = false;
        this.queue = Promise.resolve();
        this.catchupPromise = null;
        this.catchupReady = false;
        this.catchupFailureRevision = 0;
        this.failureCount = 0;
        this.diagnostics = options.diagnostics || null;
        this.feedback = options.feedback || new ScoutMessageFeedback({ client: this.client, store: this.store,
            channelId: this.channelId, stopped: () => this.stopped,
            diagnostics: this.diagnostics,
            onReview: async messageId => this.notifyNewReview({ message_id: messageId }),
            recheck: async messageId => this.recheckCorrection(messageId),
            onPublished: async event => {
                if (!this.store.auditLogger?.published) return;
                let identity = null;
                try {
                    identity = await this.rosterStore?.noticeForIgn(this.guildId, event.ign,
                        this.client?.guilds?.cache?.get(this.guildId));
                } catch (error) {
                    console.warn(`${this.logPrefix} Could not check guild membership for the scout publication log: ${error.message}`);
                }
                this.store.auditLogger.published({ ...event, isGuildMember: identity?.type === 'member' });
            } });
    }

    // Created on first use so a store replaced after construction is still the one consulted.
    get deletions() {
        this.deletionReview ||= new ScoutDeletionReview({ client: this.client, store: this.store, server: this.server,
            channelId: this.channelId, officerChannelId: this.officerChannelId, guildId: this.guildId,
            regroup: () => this.enqueue(() => this.rebuildGroups()), stopped: () => this.stopped });
        return this.deletionReview;
    }

    get logPrefix() {
        return `[CC LOG] [PvP Scout] ${this.server === 'silver' ? 'Silver' : 'Gold'}:`;
    }

    enqueue(task) {
        const pending = this.queue.then(task, task);
        // Callers receive the result, but an idle queue must not retain the last archive payload.
        this.queue = pending.then(() => undefined, error => {
            console.error(`${this.logPrefix} Ingestion failed:`, error);
        });
        return pending;
    }

    enqueueMessage(message, task) {
        this.feedback.beginMessage?.(message);
        const queue = () => this.enqueue(task);
        return (this.diagnostics ? this.diagnostics.run({ component: 'Scout ingestion', messageId: message?.id }, queue) : queue())
            .finally(() => this.feedback.endMessage?.(message));
    }

    async start() {
        if (this.started) return;
        if (!this.channelId) {
            console.warn(`${this.logPrefix} Disabled: ${this.server === 'silver' ? 'pvpScoutingSilverChannelID' : 'pvpScoutingGoldChannelID'} missing.`);
            return;
        }
        this.started = true;
        while (!this.stopped) {
            const finishActivity = this.activity.begin(`PvP Scout ${this.server}: archive refresh`);
            try {
                await this.store.ensureSchema();
                const refreshStartedAt = Date.now();
                console.log(`${this.logPrefix} Archive refresh started (saved OCR).`);
                this.store.autocomplete('', this.channelId).catch(error => {
                    console.warn(`${this.logPrefix} Autocomplete preload failed: ${error.message}`);
                });
                const { updatedRecords, archivedMessages } = await this.enqueue(async () => {
                    const updated = await this.store.refreshAutomaticRecords();
                    const grouped = await this.rebuildGroups();
                    return { updatedRecords: updated, archivedMessages: grouped };
                });
                await this.store.autocomplete('', this.channelId).catch(error => {
                    console.warn(`${this.logPrefix} Autocomplete refresh failed: ${error.message}`);
                });
                if (updatedRecords) {
                    const pending = await this.store.pendingReviewCount();
                    console.log(`${this.logPrefix} Review queue: ${pending} pending.`);
                }
                if (this.stopped) return;
                console.log(`${this.logPrefix} Archive ready: ${archivedMessages} messages, ${updatedRecords} updated (${((Date.now() - refreshStartedAt) / 1000).toFixed(1)}s).`);
                this.failureCount = 0;
                this.startCatchup();
                return;
            } catch (error) {
                finishActivity();
                this.failureCount++;
                const delayMs = Math.min(5000, 1000 * (2 ** Math.min(this.failureCount - 1, 3)));
                console.warn(`${this.logPrefix} Storage unavailable (${error.message}); retrying in ${Math.ceil(delayMs / 1000)}s.`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } finally { finishActivity(); }
        }
    }

    async stop() {
        this.stopped = true;
        await this.catchupPromise?.catch(() => {});
        await this.queue.catch(() => {});
        if (this.feedback.stop) await this.feedback.stop();
        else await this.feedback.drain();
        await this.ocr.close?.();
        this.started = false;
    }

    async getChannel() {
        const channel = this.client.channels.cache.get(this.channelId)
            || await this.client.channels.fetch(this.channelId);
        if (!channel?.messages?.fetch) throw new Error(`Channel ${this.channelId} does not expose message history.`);
        return channel;
    }

    async buildRecord(message) {
        // Keep Discord's attachment URLs as the image source; only the OCR text is saved locally.
        const attachments = [...(message.attachments?.values?.() || [])].map(attachmentRecord);
        // Reports submitted through /scout are posted by the bot with the member credited in the embed.
        const report = submittedScoutEmbed(message, this.client.user?.id);
        if (report) {
            const ign = cleanIgn(report.title.slice('PvP Scout Report — '.length));
            const field = name => report.fields?.find(item => item.name === name)?.value || '';
            const teamText = report.description || '';
            const ratingText = field('PvP Rating');
            if (ign && teamText && (!ratingText || /^\d{1,5}$/.test(ratingText))) {
                const needsOfficerReview = isClearlySpamTeam(teamText);
                return {
                    messageId: String(message.id), channelId: String(message.channelId || this.channelId),
                    server: this.server,
                    guildId: message.guildId || message.guild?.id || null,
                    authorId: report.author.url.split('/').at(-1), authorUsername: report.author.name || 'Unknown member',
                    createdAt: message.createdAt || message.createdTimestamp || new Date(), editedAt: message.editedAt || null,
                    content: [report.title, teamText, ratingText, field('Additional Notes')].filter(Boolean).join('\n'),
                    sourceUrl: discordSourceUrl(message), replyToId: null,
                    attachments, ocrResults: [], classification: needsOfficerReview ? 'review' : 'scout',
                    ign, ignNormalized: normalizeIgn(ign),
                    ignConfidence: 1, ignSource: 'member_submission', rating: ratingText ? Number(ratingText) : null,
                    teamText, notes: field('Additional Notes'),
                    reviewStatus: needsOfficerReview ? 'pending' : 'confirmed',
                    reviewReason: needsOfficerReview ? 'Manual report team text looks like off-topic spam.' : null,
                    teamLayoutStatus: attachments.some(attachmentIsImage) ? 'uncertain' : 'none'
                };
            }
        }
        const imageAttachments = [...(message.attachments?.values?.() || [])]
            .filter(attachmentIsImage);
        const firstTextCandidate = candidateFromText(message.content || '');
        const reviewEvidencePromise = Promise.all([
            this.store.knownIgnEvidence(), this.store.staffReviewLearning()
        ]);
        const memberContextPromise = this.rosterStore?.ocrMemberContext(
            String(message.guildId || message.guild?.id || this.guildId), message.author?.id
        ).catch(error => {
            console.warn(`${this.logPrefix} Member-name lookup failed: ${error.message}`);
            return { memberNames: [], authorNames: [] };
        }) || Promise.resolve({ memberNames: [], authorNames: [] });
        const memberContext = await memberContextPromise;
        const ocrResults = [];
        for (const attachment of imageAttachments) {
            const result = await this.ocr.analyzeAttachment(
                attachment,
                message.id,
                firstTextCandidate?.ign || null,
                memberContext
            );
            ocrResults.push({
                attachmentId: result.attachmentId,
                name: result.name,
                url: result.url,
                text: result.text || null,
                lines: result.lines || [],
                width: result.width || null,
                height: result.height || null,
                ocrWidth: result.ocrWidth || null,
                ocrHeight: result.ocrHeight || null,
                cardRect: result.cardRect || null,
                focusedIgn: result.focusedIgn || null,
                focusedConfidence: result.focusedConfidence || 0,
                focusedSource: result.focusedSource || null,
                focusedScanAttempted: result.focusedScanAttempted === true || Boolean(result.error),
                battlePairAmbiguous: result.battlePairAmbiguous === true,
                scanVersion: result.scanVersion || SCAN_VERSION,
                cardScanAttempted: result.cardScanAttempted === true,
                positionScanAttempted: !result.error,
                teamLayoutStatus: result.teamLayoutStatus || 'uncertain',
                teamLayoutReason: result.teamLayoutReason || null,
                error: result.error || null
            });
        }

        const [knownIgnEvidence, reviewLearning] = await reviewEvidencePromise;
        const parsed = extractScoutData({ content: message.content, attachments }, {
            ocrResults, knownIgnEvidence, reviewLearning, authorId: message.author?.id || null,
            memberContext
        });
        const teamLayoutStatuses = ocrResults.map(result => result.teamLayoutStatus);
        const teamLayoutStatus = !teamLayoutStatuses.length
            ? 'none'
            : teamLayoutStatuses.includes('uncertain')
                ? 'uncertain'
                : 'recognized';
        return {
            messageId: String(message.id),
            channelId: String(message.channelId || this.channelId),
            server: this.server,
            guildId: message.guildId || message.guild?.id || null,
            authorId: message.author?.id || null,
            authorUsername: message.author?.username || message.author?.globalName || message.member?.displayName || 'Unknown member',
            createdAt: message.createdAt || message.createdTimestamp || new Date(),
            editedAt: message.editedAt || null,
            content: String(message.content || ''),
            sourceUrl: discordSourceUrl(message),
            replyToId: message.reference?.messageId || null,
            attachments,
            ocrResults,
            ...parsed,
            teamLayoutStatus
        };
    }

    async saveMessage(message, { regroup = false, deferReview = false } = {}) {
        if (this.stopped || !message?.id || String(message.channelId || message.channel?.id || '') !== this.channelId) return null;
        if (!canArchiveMessage(message, this.client.user?.id)) return null;
        const record = await this.buildRecord(message);
        record.deferReview = deferReview && !message.author?.bot && !message.webhookId;
        if (this.stopped) return null;
        const saved = await this.store.saveMessage(record);
        // Further reports in the same message become their own records.
        await this.store.syncSections?.(saved, record.extraSections || [], { deferReview: record.deferReview });
        if (!regroup) await this.assignLiveGroup(saved);
        return saved;
    }

    // Re-reads the saved text of a message after an officer accepted its held edit.
    async syncSections(messageId) {
        if (!this.store.syncSections) return;
        const row = await this.store.getMessage(discordMessageId(messageId));
        if (!row || row.is_deleted) return;
        const parsed = extractScoutData({ content: row.archive_message_content, attachments: row.archive_attachments },
            { ocrResults: row.ocrResults });
        await this.enqueue(async () => {
            await this.store.syncSections(row, parsed.extraSections || []);
            await this.rebuildGroups();
        });
    }

    async rootForMessage(messageId) {
        if (!messageId) return null;
        const source = await this.store.getMessage(messageId);
        if (!source || source.is_deleted) return null;
        if (source.channel_id && String(source.channel_id) !== this.channelId) return null;
        const rootId = source.root_message_id || source.message_id;
        const root = await this.store.getMessage(rootId);
        if (root?.ign_source === 'member_submission' && root.review_status === 'pending') return null;
        return root && root.classification !== 'ignored' ? root : null;
    }

    async assignLiveGroup(saved) {
        if (saved?.staffOverrides?.rootMessageId) return;
        if (!saved || saved.is_deleted || saved.review_status === 'not_scout') return;
        let root = await this.rootForMessage(saved.reply_to_id);
        const familySpecies = async candidate => {
            if (!candidate || !this.store.sourcesForRoots) return candidate;
            const sources = await this.store.sourcesForRoots([String(candidate.message_id)], this.channelId);
            const species = teamSpecies(candidate);
            for (const source of sources) {
                if (String(source.message_id) === String(saved.message_id) || source.is_deleted || source.review_status === 'not_scout') continue;
                for (const value of teamSpecies(source, true, reportContextSpecies(candidate))) species.add(value);
            }
            return { ...candidate, species };
        };
        root = await familySpecies(root);
        if (root && !mayJoinReport(saved, root, root, true)) root = null;
        if (!root && !saved.reply_to_id) {
            const previous = await this.store.getPreviousMessage(saved.message_id, this.channelId);
            if (previous && String(previous.author_id || '') === String(saved.author_id || '')) {
                const priorRoot = await familySpecies(await this.rootForMessage(previous.root_message_id || previous.message_id));
                if (priorRoot && mayJoinReport(saved, priorRoot, previous, false)) root = priorRoot;
            }
        }
        if (root && String(root.message_id) !== String(saved.message_id)) {
            if (!root.ign_normalized && saved.ign_normalized) await this.store.promoteRootIgn(root.message_id, saved.message_id);
            await this.store.setRootLinks([groupLink(saved, root.message_id, root)], this.channelId);
        }
    }

    async handleCreate(message) {
        const saved = await this.enqueueMessage(message, async () => {
            let row;
            try {
                row = await this.saveMessage(message, { deferReview: true });
            } catch (error) {
                // Later events cannot certify a gap left by this failed message.
                this.catchupReady = false;
                this.catchupFailureRevision++;
                throw error;
            }
            if (row && this.catchupReady && !this.stopped) {
                try {
                    await this.store.saveCatchupCursor(message.id, this.channelId);
                } catch (error) {
                    this.catchupReady = false;
                    this.catchupFailureRevision++;
                    console.warn(`${this.logPrefix} Checkpoint save failed: ${error.message}; retry on restart.`);
                }
            }
            return row;
        });
        // Modal submissions are already complete and are posted by the bot;
        // keep their officer notification without treating them as public feedback.
        if (saved?.ign_source === 'member_submission' && saved.review_status === 'pending') {
            await this.notifyNewReview(saved).catch(error => {
                console.warn(`${this.logPrefix} Review alert failed for ${saved.message_id}: ${error.message}`);
            });
        }
        if (saved) await this.feedback.observeMessage(message);
        return saved;
    }

    async notifyNewReview(saved) {
        if (!this.officerChannelId || this.stopped) return;
        const row = await this.store.getMessage(saved.message_id);
        if (!row || row.review_status !== 'pending' || row.is_deleted) return;
        const age = Date.now() - messageTimestamp(row.created_at);
        const correction = await this.store.getCorrectionWindow(row.message_id);
        if (correction?.status === 'waiting') return;
        // Persisted overdue windows can be escalated after a long bot outage.
        if (!correction && (age < -5 * 60 * 1000 || age > EDIT_REVIEW_WINDOW_MS)) return;
        const groupedWithoutName = String(row.root_message_id || row.message_id) !== String(row.message_id)
            && !row.opponent_ign && !hasImageEvidence(row.attachments) && [
                'Could not identify the opponent IGN in the message or screenshot.',
                'Message looks like scouting information but the opponent IGN is unclear.'
            ].includes(row.review_reason);
        if (groupedWithoutName) return;
        if (!await this.store.claimReviewAlert(row.message_id)) return;
        let posted = false;
        try {
            const channel = this.client.channels.cache.get(this.officerChannelId)
                || await this.client.channels.fetch(this.officerChannelId);
            if (!channel?.send) throw new Error('Officer channel is unavailable or cannot receive messages.');
            const username = String(row.author_username || 'Unknown member').slice(0, 128)
                .replace(/([\\*_~`|>])/gu, '\\$1').replace(/@/gu, '＠');
            const reportId = String(row.root_message_id || row.message_id);
            const message = await channel.send({
                content: `A new **Scout Report** submitted by **${username}** is awaiting review.\n`
                    + 'Use the `/scout-review` command to review the Scout Report.\n'
                    + `-# - Scout Message ID: ${row.message_id}\n`
                    + (String(reportId) === String(row.message_id) ? '' : `-# - Scout Report ID: ${reportId}\n`)
                    + `- [**Jump to Scout Message**](${row.source_url})`,
                allowedMentions: { parse: [] }
            });
            posted = true;
            await this.store.markReviewAlertSent(row.message_id, message.id);
        } catch (error) {
            if (!posted) await this.store.releaseReviewAlert(row.message_id).catch(() => {});
            throw error;
        }
    }

    async notifyEditReview(edit) {
        if (!this.officerChannelId || this.stopped || !edit) return;
        const row = await this.store.getMessage(edit.message_id);
        const latest = await this.store.getEditReview(edit.message_id);
        if (!row || row.is_deleted || latest?.status !== 'pending'
            || Number(latest.revision) !== Number(edit.revision)) return;
        if (!await this.store.claimEditReviewAlert(edit.message_id, edit.revision)) return;
        let posted = false;
        try {
            const channel = this.client.channels.cache.get(this.officerChannelId)
                || await this.client.channels.fetch(this.officerChannelId);
            if (!channel?.send) throw new Error('Officer channel is unavailable or cannot receive messages.');
            const username = String(row.author_username || 'Unknown member').slice(0, 128)
                .replace(/([\\*_~`|>])/gu, '\\$1').replace(/@/gu, '＠');
            const reportId = String(row.root_message_id || row.message_id);
            const message = await channel.send({
                content: `A **Scout Report** was edited by **${username}** and is awaiting review.\n`
                    + 'Use the `/scout-review` command to review the updated Scout Report.\n'
                    + `-# - Scout Message ID: ${row.message_id}\n`
                    + (String(reportId) === String(row.message_id) ? '' : `-# - Scout Report ID: ${reportId}\n`)
                    + `- [**Jump to Scout Message**](${row.source_url})`,
                allowedMentions: { parse: [] }
            });
            posted = true;
            await this.store.markEditReviewAlertSent?.(edit.message_id, edit.revision, message.id);
        } catch (error) {
            if (!posted) await this.store.releaseEditReviewAlert(edit.message_id, edit.revision).catch(() => {});
            throw error;
        }
    }

    async recheckCorrection(messageId) {
        // A further report of a multi-report message is checked through the message that holds it.
        const sourceId = discordMessageId(messageId);
        const row = await this.store.getMessage(sourceId);
        if (!row || row.is_deleted) return;
        let message;
        try { message = await (await this.getChannel()).messages.fetch(sourceId); }
        catch (error) {
            if (Number(error.code) !== 10008) throw error;
            // A deleted report an officer chose to keep stays in the archive without its Discord message.
            for (const id of [sourceId, ...await this.liveSectionIds(sourceId)]) {
                if (!await this.deletions.store.isKept(id)) await this.store.markDeleted(id, this.channelId);
            }
            return;
        }
        const attachments = [...(message.attachments?.values?.() || [])].map(attachmentRecord);
        const savedHash = contentHash({ content: row.archive_message_content ?? row.message_content,
            attachments: row.archive_attachments ?? row.attachments });
        if (savedHash !== contentHash({ content: message.content, attachments })) await this.handleUpdate(message);
    }

    async liveSectionIds(messageId) {
        return (await this.store.sectionRows?.(messageId) || []).filter(row => !row.is_deleted).map(row => row.message_id);
    }

    editSnapshot(message) {
        if (!message) return null;
        const snapshot = Object.create(Object.getPrototypeOf(message), Object.getOwnPropertyDescriptors(message));
        if (message.attachments?.values) snapshot.attachments = new Map([...message.attachments.values()]
            .map(attachment => [attachment.id, { ...attachment }]));
        return snapshot;
    }

    async logMemberEdit(result) {
        if (!this.store.auditLogger?.memberEdited || !result.saved || !result.logBefore || !result.logAfter
            || result.message.author?.bot || result.message.webhookId) return result;
        const before = scoutVersion(result.logBefore), after = scoutVersion(result.logAfter);
        before.content = String(result.logBefore.archive_message_content ?? before.content);
        // Attachment URL refreshes and duplicate gateway events are not author edits.
        if (before.contentHash === after.contentHash) return result;
        const saved = await this.store.getMessage(result.saved.message_id);
        const root = saved?.root_message_id && String(saved.root_message_id) !== String(saved.message_id)
            ? await this.store.getMessage(saved.root_message_id) : saved;
        let failed = after.reviewStatus === 'pending';
        if (!result.stagedEdit && root) {
            const sources = await this.store.sourcesForRoots([String(root.message_id)], this.channelId);
            let outcome;
            for (const source of sources.filter(source => String(source.author_id) === String(after.authorId))) {
                const candidate = feedbackOutcome(source, root, await this.store.getEditReview(source.message_id));
                if (candidate?.reaction === '👎') { outcome = candidate; break; }
                if (candidate) outcome = candidate;
            }
            const missingTeam = root.opponent_ign && !sources.some(source => String(source.team_text || '').trim()
                || hasImageEvidence(source.attachments));
            failed = outcome?.reaction === '👎' || Boolean(missingTeam);
            after.reviewStatus = failed ? 'pending' : saved?.review_status || after.reviewStatus;
            after.reviewReason = failed ? outcome?.reason || saved?.review_reason || root.review_reason
                || 'The scout report names an opponent but contains no Pokémon team information or screenshot.' : null;
        }
        this.store.auditLogger.memberEdited({ messageId: after.messageId,
            reportId: String(saved?.root_message_id || after.messageId), server: this.server,
            authorId: after.authorId, authorUsername: after.authorUsername, sourceUrl: after.sourceUrl,
            before, after, awaitingApproval: result.stagedEdit, autoApproved: result.autoApproved, safetyReason: result.safetyReason, failed });
        return result;
    }

    async handleUpdate(message) {
        const receivedAt = Date.now();
        message = this.editSnapshot(message);
        const result = await this.enqueueMessage(message, async () => {
            let current = message;
            if (current?.partial) current = this.editSnapshot(await current.fetch().catch(() => null));
            if (!current || !canArchiveMessage(current, this.client.user?.id)) return null;
            const previous = await this.store.getMessage(current.id);
            const previousEdit = previous ? await this.store.getEditReview(current.id) : null;
            const logBefore = previousEdit?.status === 'pending' ? previousEdit.after : previous;
            const protectedScout = previous && !previous.is_deleted;
            if (protectedScout) {
                const proposal = await this.buildRecord(current);
                if (this.stopped) return null;
                const latest = await this.store.getMessage(current.id);
                const existingEdit = await this.store.getEditReview(current.id);
                const root = latest?.root_message_id && String(latest.root_message_id) !== String(current.id)
                    ? await this.store.getMessage(latest.root_message_id) : null;
                const rootEdit = root?.review_status === 'pending' ? await this.store.getEditReview(root.message_id) : null;
                const comparison = comparisonParse(latest || previous, proposal);
                const editable = canAutoApplyScoutEdit(latest || previous, proposal,
                    { root, pendingEdit: existingEdit, rootEdit, now: receivedAt, comparison });
                const spamReason = editable ? spamEditReason(latest || previous, proposal) : null;
                // Small updates to old reports apply automatically, so the bulk safeguard is checked first.
                const burst = await this.store.isHistoricalEditBurst?.(latest || previous, proposal) || false;
                if (editable && !spamReason && !burst) {
                    const record = hasOfficerDecision(latest || previous)
                        ? mergeReviewedEdit(latest || previous, proposal, comparison) : proposal;
                    const saved = await this.store.saveMessage({ ...record,
                        createdAt: scoutVersion(latest || previous).createdAt, deferReview: true });
                    await this.store.syncSections?.(saved, proposal.extraSections || [], { deferReview: true });
                    await this.rebuildGroups();
                    return this.logMemberEdit({ saved, message: current, stagedEdit: false, autoApproved: true,
                        logBefore, logAfter: record });
                }
                const edit = await this.store.stageEditReview(latest || previous, proposal);
                return this.logMemberEdit({ saved: latest || previous, message: current, edit, stagedEdit: Boolean(edit),
                    safetyReason: spamReason || (burst ? 'Bulk edit safeguard: this member edited at least three reports older than one week within ten minutes.' : null),
                    logBefore, logAfter: proposal });
            }
            if (previous) await this.store.expirePendingEditReview?.(previous.message_id);
            const saved = await this.saveMessage(current, { regroup: true, deferReview: true });
            if (saved) await this.rebuildGroups();
            return this.logMemberEdit({ saved, message: current, stagedEdit: false, logBefore, logAfter: saved });
        });
        if (!result) return null;
        if (result.stagedEdit) {
            if (result.edit) {
                await this.notifyEditReview(result.edit).catch(error => {
                    console.warn(`${this.logPrefix} Edit review alert failed for ${result.saved.message_id}: ${error.message}`);
                });
            }
        }
        if (result.saved) await this.feedback.observeMessage(result.message);
        return result.saved;
    }

    refreshMessageFeedback(messageId) {
        return this.feedback.refreshReport(messageId);
    }

    async handleDelete(message) {
        return this.handleDeleteBulk([message]);
    }

    async handleDeleteBulk(messages) {
        const eligible = [...messages].filter(message => message?.id
            && String(message.channelId || message.channel?.id || '') === this.channelId
            && canArchiveMessage(message, this.client.user?.id));
        if (!eligible.length) return;
        const errors = [];
        const reported = [];
        const deleted = await this.enqueue(async () => {
            const saved = [];
            for (const message of eligible) {
                try {
                    // Every report held by the message is deleted with it. Each is recorded before its row
                    // is marked, so an interrupted officer alert is sent after a restart.
                    const sections = await this.liveSectionIds(message.id);
                    for (const id of [String(message.id), ...sections]) {
                        const captured = await this.deletions.capture(id);
                        await this.store.markDeleted(id, this.channelId);
                        if (captured) reported.push({ id, message });
                    }
                    for (const id of sections) await this.store.resolveCorrectionWindow?.(id);
                    saved.push(message);
                } catch (error) {
                    errors.push(error);
                }
            }
            // A bulk delete needs one regroup, even when some writes failed.
            if (saved.length) await this.rebuildGroups();
            return saved;
        });
        for (const message of deleted) {
            try {
                await this.feedback.remove(message.id);
            } catch (error) {
                errors.push(error);
            }
        }
        // Discord's audit log names a moderator only for single deletions. Reports from one message
        // share the result of one lookup.
        const deleters = new Map();
        for (const { id, message } of reported) {
            const known = deleters.has(message.id);
            await this.deletions.announce(id, message, known
                ? { lookupDeleter: false, deletedById: deleters.get(message.id) }
                : { lookupDeleter: eligible.length === 1 }).catch(error => {
                console.warn(`${this.logPrefix} Deleted scout alert failed for ${id}: ${error.message}; retry on restart.`);
            });
            if (!known) deleters.set(message.id, (await this.deletions.store.get(id).catch(() => null))?.deleted_by_id || null);
        }
        if (errors.length) throw new AggregateError(errors, 'Some deleted scouting messages could not be updated.');
    }

    async rebuildGroups() {
        let cursor = null;
        let count = 0;
        const state = { roots: new Map(), messageRoots: new Map(), previous: null };
        const promotions = [];
        // Recompute with the live rules, preserving manual overrides. Update
        // only changed links; never reset the entire archive between pages.
        while (true) {
            const rows = await this.store.listMessagesAfter(cursor, 500, this.channelId);
            if (!rows.length) break;
            count += rows.length;
            const links = [];
            for (let index = 0; index < rows.length; index += 20) {
                await yieldToEvents();
                const chunk = rows.slice(index, index + 20);
                const result = groupRows(chunk, state);
                const grouped = new Map(result.links.map(link => [link.messageId, link]));
                for (const row of chunk) {
                    const id = String(row.message_id), expected = result.messageRoots.get(id);
                    if (!expected) continue;
                    const link = grouped.get(id);
                    if (String(row.root_message_id || '') !== expected || link?.teamDetails) {
                        links.push(link || { messageId: id, rootMessageId: expected });
                    }
                }
                promotions.push(...result.promotions);
            }
            await this.store.setRootLinks(links, this.channelId);
            cursor = rows.at(-1).message_id;
            if (rows.length < 500) break;
        }
        for (const promotion of promotions) await this.store.promoteRootIgn(promotion.rootMessageId, promotion.sourceMessageId);
        return count;
    }

    startCatchup() {
        if (this.stopped) return;
        this.catchupReady = false;
        const finishActivity = this.activity.begin(`PvP Scout ${this.server}: catch-up`);
        this.catchupPromise = this.catchUpMessages().then(async () => {
            // Resume saved timers after missed follow-ups have been archived and grouped.
            if (this.stopped) return;
            try { await this.feedback.restorePending?.(); }
            catch (error) { console.warn(`${this.logPrefix} Pending feedback restore failed: ${error.message}`); }
            try { await this.deletions.restorePending(); }
            catch (error) { console.warn(`${this.logPrefix} Deleted scout alert restore failed: ${error.message}`); }
        }).catch(error => {
            this.catchupReady = false;
            if (!this.stopped) console.warn(`${this.logPrefix} Catch-up paused: ${error.message}; retry on restart.`);
        }).finally(finishActivity);
        return this.catchupPromise;
    }

    async catchUpMessages() {
        if (this.stopped) return;
        this.catchupReady = false;
        const failureRevision = this.catchupFailureRevision;
        const cursor = await this.store.getCatchupCursor(this.channelId);
        if (this.stopped) return;
        const channel = await this.getChannel();
        if (this.stopped) return;
        const startedAt = Date.now();
        let lastProgressAt = startedAt;
        if (!cursor) console.log(`${this.logPrefix} Catch-up started (full history; no checkpoint).`);
        let before, newestId, count = 0, checked = 0, pages = 0;
        const reportProgress = () => {
            const now = Date.now();
            if (this.stopped || now - lastProgressAt < CATCHUP_PROGRESS_INTERVAL_MS) return;
            lastProgressAt = now;
            console.log(`${this.logPrefix} Catch-up progress: ${checked} checked, ${count} new, ${pages} page${pages === 1 ? '' : 's'} (${((now - startedAt) / 1000).toFixed(1)}s).`);
        };
        // Walk backward to the checkpoint instead of trusting the highest archived
        // ID: newer live events may already be saved beyond an unprocessed gap.
        try {
            while (!this.stopped) {
                const messages = await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false,
                    ...(before ? { before } : {}) });
                if (this.stopped) return;
                pages++;
                const ordered = [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
                if (!ordered.length) break;
                newestId ||= ordered.at(-1).id;
                for (const message of ordered) {
                    if (this.stopped) return;
                    checked++;
                    if (cursor && BigInt(message.id) <= BigInt(cursor)) continue;
                    const saved = await this.enqueue(async () => {
                        if (this.stopped || await this.store.getMessage(message.id)) return null;
                        if (this.stopped) return null;
                        return this.saveMessage(message, { regroup: true,
                            deferReview: Date.now() - messageTimestamp(message.createdAt || message.createdTimestamp) <= EDIT_REVIEW_WINDOW_MS });
                    });
                    if (saved) count++;
                    reportProgress();
                }
                reportProgress();
                const oldestId = ordered[0].id;
                if (cursor && BigInt(oldestId) <= BigInt(cursor) || ordered.length < HISTORY_PAGE_SIZE) break;
                if (before && BigInt(oldestId) >= BigInt(before)) throw new Error('Discord message history did not advance.');
                before = oldestId;
            }
        } finally {
            // Keep already saved portions grouped even if a later page fails.
            if (count) await this.enqueue(() => this.rebuildGroups());
        }
        if (this.stopped) return;
        await this.enqueue(async () => {
            if (this.stopped) return;
            if (newestId) await this.store.saveCatchupCursor(newestId, this.channelId);
            this.catchupReady = failureRevision === this.catchupFailureRevision;
        });
        if (this.stopped) return;
        const summary = `${checked} checked, ${count} new, ${pages} page${pages === 1 ? '' : 's'} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`;
        if (this.catchupReady) console.log(`${this.logPrefix} Catch-up complete: ${summary}.`);
        else console.warn(`${this.logPrefix} Catch-up finished: ${summary}; checkpoint paused after a live archive failure; retry on restart.`);
    }
}

module.exports = {
    FOLLOW_UP_WINDOW_MS,
    PvpScoutIngestor,
    attachmentIsImage,
    buildGroupLinks,
    canArchiveMessage,
    discordSourceUrl
};
