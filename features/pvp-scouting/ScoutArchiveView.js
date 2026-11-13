// Reads both scout archives as one view while keeping every write in its source channel.
'use strict';

const { extractRating } = require('./PvpScoutParser.js');

function utcDate(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function reportServer(row) { return row?.server === 'silver' ? 'silver' : 'gold'; }

function reportRating(row) {
    const source = row?.root || row;
    const value = source?.rating ?? (source?.review_status === 'corrected' ? null
        : extractRating(source?.message_content, source?.opponent_ign));
    if (value === null || value === undefined || value === '') return null;
    const rating = Number(value);
    return Number.isInteger(rating) && rating >= 0 ? rating : null;
}

function newestFirst(a, b) {
    const left = a.root || a, right = b.root || b;
    return (new Date(right.created_at).getTime() || 0) - (new Date(left.created_at).getTime() || 0)
        || String(right.message_id).localeCompare(String(left.message_id), 'en', { numeric: true });
}

function sortReports(reports, sort = 'newest') {
    const newest = [...reports].sort(newestFirst);
    if (sort === 'oldest') return newest.reverse();
    if (sort === 'newest') return newest;
    if (sort === 'rating') return newest.sort((a, b) =>
        (reportRating(b) ?? -1) - (reportRating(a) ?? -1) || newestFirst(a, b));
    const gold = newest.filter(item => reportServer(item.root || item) === 'gold');
    const silver = newest.filter(item => reportServer(item.root || item) === 'silver');
    if (sort === 'gold') return [...gold, ...silver];
    if (sort === 'silver') return [...silver, ...gold];
    if (sort === 'alternating') {
        const combined = [];
        for (let index = 0; index < Math.max(gold.length, silver.length); index++) {
            if (gold[index]) combined.push(gold[index]);
            if (silver[index]) combined.push(silver[index]);
        }
        return combined;
    }
    return newest;
}

class ScoutArchiveView {
    constructor(registry) {
        this.contexts = registry.contexts();
        this.channelIds = this.contexts.map(context => context.channelId);
        this.server = 'cross';
        this.dirty = new Set();
        this.ingestor = {
            rebuildGroups: async () => {
                const contexts = [...this.dirty];
                for (const context of contexts) {
                    await context.ingestor?.rebuildGroups();
                    this.dirty.delete(context);
                }
            },
            refreshMessageFeedback: async id => {
                const context = await this.owner(id);
                return context.ingestor?.refreshMessageFeedback?.(id);
            },
            syncSections: async id => (await this.owner(id)).ingestor?.syncSections?.(id)
        };
    }

    get dataRevision() { return this.contexts.map(context => `${context.server}:${context.store.dataRevision || 0}`).join('|'); }
    async ensureSchema() { for (const context of this.contexts) await context.store.ensureSchema(); }

    async searchRootsAndSources(ign) {
        const batches = await Promise.all(this.contexts.map(context => context.store.searchRootsAndSources(ign, context.channelId)));
        return { roots: sortReports(batches.flatMap(batch => batch.roots)), sources: batches.flatMap(batch => batch.sources) };
    }

    async pendingReviews(limit, offset) {
        return this.contexts[0].store.pendingReviews(limit, offset, this.channelIds);
    }
    async pendingReviewCount() { return this.contexts[0].store.pendingReviewCount(this.channelIds); }
    async exportPendingReviews() { return this.contexts[0].store.exportPendingReviews(this.channelIds); }
    async sourcesForRoots(ids) {
        const batches = await Promise.all(this.contexts.map(context => context.store.sourcesForRoots(ids, context.channelId)));
        return batches.flat();
    }
    async getMessage(id) {
        const rows = await Promise.all(this.contexts.map(context => context.store.getMessage(id)));
        return rows.find(Boolean) || null;
    }
    async owner(id) {
        const row = await this.getMessage(id);
        const context = row && this.contexts.find(item => item.channelId === String(row.channel_id));
        if (!context) throw Object.assign(new Error('This scout message is no longer available.'), { code: 'SCOUT_REVIEW_STALE' });
        return context;
    }
    async write(method, id, ...args) {
        const context = await this.owner(id);
        const result = await context.store[method](id, ...args);
        this.dirty.add(context);
        return result;
    }
    confirmReview(id, ...args) { return this.write('confirmReview', id, ...args); }
    correctReview(id, ...args) { return this.write('correctReview', id, ...args); }
    markNotScout(id, ...args) { return this.write('markNotScout', id, ...args); }
    resolveEditReview(id, ...args) { return this.write('resolveEditReview', id, ...args); }
}

module.exports = { ScoutArchiveView, utcDate, reportServer, reportRating, sortReports };
