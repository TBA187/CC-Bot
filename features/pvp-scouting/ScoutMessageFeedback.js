// Keeps public scout reactions and the author's correction reply in sync with saved results.
'use strict';

const { Routes } = require('discord.js');
const { ScoutCorrectionWindow } = require('./ScoutCorrectionWindow.js');
const { reviewFeedbackText } = require('./ScoutFeedbackText.js');
const { hasImageEvidence } = require('./PvpScoutParser.js');
const { teamLineSpecies } = require('./PokemonTeamParser.js');

const UP = '👍';
const DOWN = '👎';
const NEW_FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUIET_PERIOD_MS = 60 * 1000;
const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000;
const GROUPED_NAME_REASONS = new Set([
    'Could not identify the opponent IGN in the message or screenshot.',
    'Message looks like scouting information but the opponent IGN is unclear.'
]);

function feedbackOutcome(row, root = row, edit = null) {
    if (!row || row.is_deleted || row.staffOverrides?.hidden || row.review_status === 'not_scout'
        || !root || root.is_deleted || root.staffOverrides?.hidden || root.review_status === 'not_scout') return null;
    const grouped = String(row.message_id) !== String(root.message_id);
    if (!grouped && !['scout', 'review'].includes(row.classification)) return null;
    if (edit?.status === 'pending') return { reaction: DOWN, reason: row.review_reason, edit, reviewMessageId: row.message_id };
    // A nameless supplement is reviewed with its root, rather than as a separate failed scout.
    const needsOwnReview = row.review_status === 'pending' && !(grouped && !row.opponent_ign
        && !row.attachments?.length && GROUPED_NAME_REASONS.has(row.review_reason));
    if (needsOwnReview || root.review_status === 'pending') {
        return { reaction: DOWN, reason: needsOwnReview ? row.review_reason : root.review_reason,
            reviewMessageId: needsOwnReview ? row.message_id : root.message_id };
    }
    if (root.opponent_ign && root.ign_normalized && ['scout', 'review'].includes(root.classification)) {
        return { reaction: UP };
    }
    return { reaction: DOWN, reason: 'Could not identify the opponent IGN in the message or screenshot.' };
}


function missingMessage(error) { return Number(error?.code) === 10008; }

function hasTeamInformation(row) {
    if (!row || row.is_deleted || row.staffOverrides?.hidden || row.review_status === 'not_scout') return false;
    return Boolean(String(row?.team_text || '').trim()) || hasImageEvidence(row?.attachments);
}

function completeSingleMessage(row) {
    if (!row?.opponent_ign || !row.ign_normalized) return false;
    if (hasImageEvidence(row.attachments)) return true;
    const species = new Set(String(row.team_text || '').split('\n').map(teamLineSpecies).filter(Boolean));
    return species.size >= 6;
}

function feedbackRun(sources, messageId) {
    const index = sources.findIndex(row => String(row.message_id) === String(messageId));
    if (index < 0) return [];
    const joins = (left, right) => String(left.author_id) === String(right.author_id)
        && new Date(right.created_at).getTime() - new Date(left.created_at).getTime() <= FOLLOW_UP_WINDOW_MS;
    let first = index, last = index;
    while (first > 0 && joins(sources[first - 1], sources[first])) first--;
    while (last + 1 < sources.length && joins(sources[last], sources[last + 1])) last++;
    return sources.slice(first, last + 1);
}

class ScoutMessageFeedback {
    constructor({ client, store, channelId, stopped = () => false, onReview = async () => {},
        onPublished = async () => {}, recheck = async () => {}, diagnostics = null }) {
        this.client = client;
        this.store = store;
        this.channelId = String(channelId);
        this.stopped = stopped;
        this.onReview = onReview;
        this.onPublished = onPublished;
        this.diagnostics = diagnostics;
        this.closing = false;
        this.pending = new Map();
        this.timers = new Map();
        this.inFlight = new Map();
        // Retain a just-sent reply if its database write fails, so retrying won't send another.
        this.unsaved = new Map();
        this.corrections = new ScoutCorrectionWindow({ store, onReview: id => this.onReview(id), recheck,
            recover: id => this.refreshReport(id, null, true),
            needsReview: async id => {
                const context = await this.reportContext(id);
                if (!context) return false;
                const outcome = feedbackOutcome(context.row, context.root, await this.store.getEditReview(id));
                return outcome?.reaction === DOWN && !outcome.edit;
            },
            busy: () => this.inFlight.size > 0, stopped: () => this.stopped() || this.closing });
    }

    enqueue(messageId, task) {
        const id = String(messageId);
        const previous = this.pending.get(id) || Promise.resolve();
        const rootId = /^report:(\d+):/u.exec(id)?.[1];
        const context = { component: 'Scout feedback', reportId: rootId, messageId: /^\d+$/u.test(id) ? id : undefined };
        const run = work => this.diagnostics ? this.diagnostics.run(context, work) : work();
        const pending = previous.then(() => this.stopped() || this.closing ? null : run(task)).catch(error => run(() => {
            console.warn(`[CC LOG] Could not update public scout feedback for ${id}: ${error.message}`);
            return null;
        }));
        this.pending.set(id, pending);
        void pending.then(() => { if (this.pending.get(id) === pending) this.pending.delete(id); });
        return pending;
    }

    jobKey(job) { return `report:${job.root_message_id}:${job.author_id}`; }

    beginMessage(message) {
        if (!message?.id || String(message.channelId || message.channel?.id) !== this.channelId
            || message.author?.bot || message.webhookId) return;
        const id = String(message.id), active = this.inFlight.get(id);
        this.inFlight.set(id, { authorId: String(message.author?.id || ''), count: (active?.count || 0) + 1 });
    }

    endMessage(message) {
        const id = String(message?.id), active = this.inFlight.get(id);
        if (!active) return;
        if (active.count > 1) active.count--;
        else this.inFlight.delete(id);
    }

    authorBusy(authorId) {
        return [...this.inFlight.values()].some(active => !active.authorId || active.authorId === String(authorId));
    }

    cancelTimer(key) {
        const timer = this.timers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(key);
    }

    armTimer(job, retryDelay = null) {
        const key = this.jobKey(job);
        this.cancelTimer(key);
        if (this.stopped() || this.closing) return;
        const timer = setTimeout(() => {
            this.timers.delete(key);
            void this.enqueue(key, () => this.finishJob(job));
        }, retryDelay ?? Math.max(0, Number(job.due_at_ms) - Date.now()));
        timer.unref?.();
        this.timers.set(key, timer);
    }

    async restorePending() {
        await this.corrections.restore();
        const jobs = await this.store.pendingMessageFeedback(this.channelId);
        for (const job of jobs) this.armTimer(job);
    }

    async reportContext(messageId) {
        const row = await this.store.getMessage(messageId);
        if (!row || String(row.channel_id) !== this.channelId) return null;
        const rootId = String(row.root_message_id || row.message_id);
        const sources = await this.store.sourcesForRoots([rootId], this.channelId);
        const root = sources.find(source => String(source.message_id) === rootId) || await this.store.getMessage(rootId);
        return { row, root, rootId, sources, run: feedbackRun(sources, messageId) };
    }

    async clearRunFeedback(run, suppliedMessage = null, keepLastReply = false) {
        for (const row of run) {
            const state = await this.state(row.message_id);
            if (!state) continue;
            let message = String(suppliedMessage?.id) === String(row.message_id) ? suppliedMessage : null;
            if (!message) {
                try { message = await (await this.channel()).messages.fetch(row.message_id); }
                catch (error) { if (!missingMessage(error)) throw error; }
            }
            if (keepLastReply && row === run.at(-1) && state.reaction === DOWN && state.feedback_message_id) {
                // Keep the existing edit instructions until the retry succeeds,
                // then update or delete that reply instead of posting another.
                if (message) await this.removeOwnReaction(message, DOWN);
            } else await this.clear(row.message_id, state, message);
        }
    }

    async observeMessage(message) {
        if (!message?.author?.id || message.author.bot || message.webhookId || this.stopped() || this.closing) return;
        const row = await this.store.getMessage(message.id);
        if (!row || String(row.channel_id) !== this.channelId) return;
        const age = Date.now() - new Date(row.created_at).getTime();
        if (!Number.isFinite(age) || age < -5 * 60 * 1000 || age > NEW_FEEDBACK_WINDOW_MS) return;
        const key = this.jobKey({ root_message_id: row.root_message_id || row.message_id, author_id: row.author_id });
        return this.enqueue(key, async () => {
            const context = await this.reportContext(message.id);
            if (!context?.run.length) return;
            const { rootId, root, sources, run } = context;
            const latest = run.at(-1);
            if (!feedbackOutcome(latest, root)) {
                await this.clearRunFeedback(run, message);
                return;
            }
            // Reactions belong to the final message, and remain absent while the author is typing.
            await this.clearRunFeedback(run, message, true);
            await this.store.ensureReportTeamPresence(rootId, sources.some(hasTeamInformation), this.channelId, true);
            const complete = completeSingleMessage(latest);
            const job = await this.store.scheduleMessageFeedback(rootId, latest.author_id, latest.message_id,
                Date.now() + (complete ? 0 : QUIET_PERIOD_MS), this.channelId);
            this.cancelTimer(this.jobKey(job));
            if (complete) await this.finishJob(job, String(message.id) === String(latest.message_id) ? message : null);
            else this.armTimer(job);
        });
    }

    async finishJob(job, message = null) {
        try {
            const current = await this.store.getMessageFeedbackJob(job.root_message_id, job.author_id, this.channelId);
            if (!current) return;
            if (Number(current.revision) !== Number(job.revision) || Number(current.due_at_ms) > Date.now()) {
                this.armTimer(current);
                return;
            }
            if (this.authorBusy(current.author_id)) {
                this.armTimer(current, QUIET_PERIOD_MS);
                return;
            }
            const context = await this.reportContext(current.latest_message_id);
            if (!context?.run.length || context.row.is_deleted) {
                await this.store.clearMessageFeedbackJob(current);
                return;
            }
            const latest = context.run.at(-1);
            const age = Date.now() - new Date(latest.created_at).getTime();
            if (!Number.isFinite(age) || age < -5 * 60 * 1000 || age > NEW_FEEDBACK_WINDOW_MS) {
                await this.store.clearMessageFeedbackJob(current);
                return;
            }
            if (String(latest.message_id) !== String(current.latest_message_id) || context.rootId !== String(current.root_message_id)) {
                const next = await this.store.scheduleMessageFeedback(context.rootId, latest.author_id, latest.message_id,
                    Date.now() + QUIET_PERIOD_MS, this.channelId);
                if (context.rootId !== String(current.root_message_id)) await this.store.clearMessageFeedbackJob(current);
                this.armTimer(next);
                return;
            }
            await this.store.ensureReportTeamPresence(context.rootId, context.sources.some(hasTeamInformation), this.channelId, true);
            const root = await this.store.getMessage(context.rootId);
            const outcome = await this.reportOutcome(context.sources, latest, root);
            if (this.authorBusy(current.author_id)) {
                this.armTimer(current, QUIET_PERIOD_MS);
                return;
            }
            if (outcome?.reaction === UP && (await this.state(latest.message_id))?.reaction !== UP
                && await this.store.claimPublicationLog(current)) {
                await this.onPublished({ ign: root.opponent_ign, reportId: context.rootId, messageId: latest.message_id,
                    rating: root.rating, sourceUrl: root.source_url,
                    sources: context.sources.filter(source => feedbackOutcome(source, root)?.reaction === UP)
                        .map(source => ({ message_id: source.message_id, author_id: source.author_id,
                            author_username: source.author_username })) }).catch(error => {
                    console.warn(`[CC LOG] Could not prepare scout publication log for ${latest.message_id}: ${error.message}`);
                });
            }
            await this.clearRunFeedback(context.run.slice(0, -1));
            await this.synchronize(latest.message_id, message, true);
            if (this.stopped() || this.closing) return;
            await this.store.clearMessageFeedbackJob(current);
        } catch (error) {
            // Keep the saved job until both Discord feedback and its state have been saved.
            this.armTimer(job, QUIET_PERIOD_MS);
            throw error;
        }
    }

    async reportOutcome(sources, latest, root) {
        let result = null;
        // Check every source from this author, not just the final fragment. Other
        // contributors' unresolved additions keep their own feedback and review.
        for (const row of sources.filter(source => String(source.author_id) === String(latest.author_id))) {
            const edit = await this.store.getEditReview(row.message_id);
            const outcome = feedbackOutcome(row, root, edit);
            if (outcome?.reaction === DOWN) return { ...outcome,
                reviewMessageId: outcome.reviewMessageId || root?.message_id };
            if (outcome) result = outcome;
        }
        return result;
    }

    async state(messageId) {
        return this.unsaved.get(String(messageId)) || await this.store.getMessageFeedback(messageId, this.channelId);
    }

    async saveState(messageId, state) {
        this.unsaved.set(String(messageId), state);
        await this.store.saveMessageFeedback(messageId, state, this.channelId);
        this.unsaved.delete(String(messageId));
    }

    async channel() {
        return this.client.channels.cache.get(this.channelId) || await this.client.channels.fetch(this.channelId);
    }

    async replyMessage(messageId, replyId) {
        if (!replyId) return null;
        try {
            const message = await (await this.channel()).messages.fetch(replyId);
            // A saved ID must never let feedback cleanup edit or delete an unrelated message.
            if (String(message.author?.id) !== String(this.client.user?.id)
                || String(message.reference?.messageId) !== String(messageId)) {
                throw new Error('The saved scout feedback reply does not match its source.');
            }
            return message;
        } catch (error) {
            if (missingMessage(error)) return null;
            throw error;
        }
    }

    async deleteReply(messageId, state) {
        const reply = await this.replyMessage(messageId, state?.feedback_message_id);
        if (reply) await reply.delete().catch(error => { if (!missingMessage(error)) throw error; });
    }

    async removeOwnReaction(message, emoji) {
        // Remove only the bot's reaction; other members' thumbs are left alone.
        await this.client.rest.delete(Routes.channelMessageOwnReaction(this.channelId, message.id, encodeURIComponent(emoji)))
            .catch(error => { if (!missingMessage(error)) throw error; });
    }

    async clear(messageId, state, message = null) {
        if (!state) return;
        await this.deleteReply(messageId, state);
        if (message) {
            for (const emoji of [UP, DOWN]) {
                if (state.reaction === emoji || message.reactions?.cache.get(emoji)?.me) await this.removeOwnReaction(message, emoji);
            }
        }
        await this.store.clearMessageFeedback(messageId, this.channelId);
        this.unsaved.delete(String(messageId));
    }

    async synchronize(messageId, suppliedMessage = null, create = false) {
        const state = await this.state(messageId);
        if (!create && !state) return null;
        const row = await this.store.getMessage(messageId);
        if (!row || String(row.channel_id) !== this.channelId) return null;
        const age = Date.now() - new Date(row.created_at).getTime();
        if (!state && (!Number.isFinite(age) || age < -5 * 60 * 1000 || age > NEW_FEEDBACK_WINDOW_MS)
            && !(await this.store.getCorrectionWindow(messageId))) return null;
        const rootId = String(row.root_message_id || row.message_id);
        const root = rootId === String(messageId) ? row : await this.store.getMessage(rootId);
        if (!state && rootId === String(messageId) && !['scout', 'review'].includes(row.classification)) return null;
        const sources = await this.store.sourcesForRoots([rootId], this.channelId);
        const outcome = await this.reportOutcome(sources, row, root);
        if (!outcome && !state) return null;
        if (this.stopped()) return null;
        let message = suppliedMessage;
        if (!message) {
            try { message = await (await this.channel()).messages.fetch(messageId); }
            catch (error) {
                if (!missingMessage(error)) throw error;
                await this.clear(messageId, state);
                return rootId;
            }
        }
        if (message.author?.bot || message.webhookId) return rootId;
        if (!outcome) {
            await this.corrections.resolve(messageId);
            await this.clear(messageId, state, message);
            return rootId;
        }
        const opposite = outcome.reaction === UP ? DOWN : UP;
        if (state?.reaction === opposite || message.reactions?.cache.get(opposite)?.me) await this.removeOwnReaction(message, opposite);
        if (!message.reactions?.cache.get(outcome.reaction)?.me) await message.react(outcome.reaction);
        // The deadline starts after the first successful thumbs-down reaction.
        if (outcome.reaction === DOWN && !outcome.edit && !/officer must approve/iu.test(outcome.reason || '')) {
            const window = await this.corrections.start(outcome.reviewMessageId);
            outcome.dueAtMs = Number(window?.due_at_ms) || null;
            outcome.escalated = window?.status === 'escalated';
        }
        if (outcome.reaction === UP) {
            for (const source of sources) {
                const edit = await this.store.getEditReview(source.message_id);
                if (feedbackOutcome(source, root, edit)?.reaction !== DOWN) await this.corrections.resolve(source.message_id);
            }
            await this.deleteReply(messageId, state);
            await this.saveState(messageId, { reaction: UP, feedback_message_id: null });
        } else {
            const content = reviewFeedbackText(outcome);
            let reply = await this.replyMessage(messageId, state?.feedback_message_id);
            if (this.stopped()) return rootId;
            if (reply) {
                if (reply.content !== content) await reply.edit({ content, allowedMentions: { parse: [], repliedUser: false } });
            } else {
                reply = await message.reply({ content, allowedMentions: { parse: [], repliedUser: false },
                    nonce: `sf:${messageId}`, enforceNonce: true });
            }
            await this.saveState(messageId, { reaction: DOWN, feedback_message_id: String(reply.id) });
        }
        return rootId;
    }

    async refreshReport(messageId, message = null, create = false) {
        if (message && (!message.author?.id || message.author.bot || message.webhookId)) return;
        let rootId = await this.enqueue(messageId, () => this.synchronize(messageId, message, create));
        if (!rootId && !create) {
            const row = await this.store.getMessage(messageId);
            rootId = row && String(row.root_message_id || row.message_id);
        }
        if (!rootId || this.stopped()) return;
        // Officer actions refresh the final message even when an earlier source was reviewed.
        try {
            const related = await this.store.messageFeedbackForReport(rootId, this.channelId);
            for (const state of related) {
                if (String(state.message_id) !== String(messageId)) {
                    await this.enqueue(state.message_id, () => this.synchronize(state.message_id));
                }
            }
        } catch (error) {
            console.warn(`[CC LOG] Could not refresh grouped scout feedback for ${rootId}: ${error.message}`);
        }
    }

    remove(messageId) {
        return this.enqueue(messageId, async () => {
            await this.corrections.resolve(messageId);
            await this.clear(messageId, await this.state(messageId));
        });
    }

    async drain() {
        while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
    }

    async stop() {
        this.closing = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        await this.corrections.stop();
        await this.drain();
    }
}

module.exports = { ScoutMessageFeedback, completeSingleMessage, feedbackOutcome, reviewFeedbackText };
