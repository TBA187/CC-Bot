// Check combined archive reads, officer writes and dates at server boundaries.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Scout = require('../commands/scout.js');
const ScoutReview = require('../commands/scout-review.js');
const { ScoutArchiveView, sortReports, utcDate } = require('../features/pvp-scouting/ScoutArchiveView.js');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');

function report(server, id, date) {
    return { message_id: id, root_message_id: id, channel_id: `${server}-channel`, server,
        created_at: new Date(date), author_id: 'reporter', author_username: 'Reporter',
        opponent_ign: 'Opponent', ign_normalized: 'opponent', classification: 'scout',
        review_status: 'pending', ign_confidence: 0.79, review_reason: 'Verify the opponent.',
        team_text: '- Charizard: Roost', attachments: [], ocrResults: [], rating: 300,
        source_url: `https://discord.com/channels/1/2/${id}` };
}

function fixture() {
    const calls = [], contexts = ['gold', 'silver'].map((server, index) => {
        const row = report(server, String(1500000000000000000n + BigInt(index)), `2026-10-0${index + 1}T23:30:00Z`);
        const store = { dataRevision: 0, row,
            async publicReportCount(ign) { return row.opponent_ign.toLowerCase() === ign ? 1 : 0; },
            async searchRootsAndSources() { return { roots: [row], sources: [row] }; },
            async sourcesForRoots(ids) { return ids.includes(row.message_id) ? [row] : []; },
            async getMessage(id) { return id === row.message_id ? row : null; },
            async confirmReview(id, actor, options) {
                calls.push(['confirm', server, id, actor, options]); row.review_status = 'confirmed'; store.dataRevision++;
                return row;
            },
            async correctReview(id, actor, correction, options) {
                calls.push(['correct', server, id, actor, options]); row.opponent_ign = correction.ign;
                row.review_status = 'corrected'; store.dataRevision++; return row;
            },
            async markNotScout(id) { calls.push(['decline', server, id]); row.review_status = 'not_scout'; store.dataRevision++; }
        };
        const ingestor = { async rebuildGroups() { calls.push(['regroup', server]); },
            async refreshMessageFeedback(id) { calls.push(['feedback', server, id]); } };
        return { server, channelId: `${server}-channel`, store, ingestor };
    });
    const pending = channelIds => sortReports(contexts.filter(context => channelIds.includes(context.channelId))
        .map(context => context.store.row).filter(row => row.review_status === 'pending'));
    contexts[0].store.pendingReviews = async (limit, offset, channels) => pending(channels).slice(offset, offset + limit);
    contexts[0].store.pendingReviewCount = async channels => pending(channels).length;
    contexts[0].store.exportPendingReviews = async channels => pending(channels);
    const registry = { contexts: () => contexts, get: server => contexts.find(context => context.server === server) };
    const config = { scoutServers: registry, ownerID: 'owner', guildId: 'guild', client: {}, scoutRosterStore: {},
        pvpScoutStore: contexts[0].store, pvpScoutIngestor: contexts[0].ingestor };
    return { calls, contexts, registry, config };
}

function interaction(customId) {
    const calls = [];
    return { customId, calls, user: { id: 'owner' }, guild: null,
        async deferUpdate() { calls.push(['defer']); this.deferred = true; },
        async deferReply() { calls.push(['defer']); this.deferred = true; },
        async editReply(payload) { calls.push(['edit', payload]); },
        async followUp(payload) { calls.push(['feedback', payload]); },
        async reply(payload) { calls.push(['reply', payload]); } };
}

test('all combined sort orders retain reports and sources in their original archives', () => {
    const rows = [report('gold', '1', '2026-10-01Z'), report('silver', '2', '2026-10-02Z'),
        report('gold', '3', '2026-10-03Z'), report('silver', '4', '2026-10-04Z'), report('gold', '5', '2026-10-05Z')];
    const expected = { newest: ['5', '4', '3', '2', '1'], oldest: ['1', '2', '3', '4', '5'],
        gold: ['5', '3', '1', '4', '2'], silver: ['4', '2', '5', '3', '1'], alternating: ['5', '4', '3', '2', '1'] };
    for (const [sort, ids] of Object.entries(expected)) assert.deepEqual(sortReports(rows, sort).map(row => row.message_id), ids);
    assert.deepEqual(rows.map(row => row.message_id), ['1', '2', '3', '4', '5']);
});

test('combined cached lookups invalidate when either physical archive changes', async () => {
    const f = fixture(), view = new ScoutArchiveView(f.registry);
    const command = new Scout({ pvpScoutStore: view, scoutServer: 'cross' });
    const first = await command.loadResults('Opponent');
    assert.equal(await command.loadResults('Opponent'), first);
    assert.deepEqual(first.map(item => item.root.server), ['silver', 'gold']);
    for (const context of f.contexts) {
        context.store.dataRevision++;
        const refreshed = await command.loadResults('Opponent');
        assert.notEqual(refreshed, first);
        assert.equal(refreshed.length, 2);
    }
});

test('combined review pages are newest first, use actual colors and scope source editing physically', async () => {
    const f = fixture(), queue = new ScoutReview(f.config).scoped.get('cross');
    for (const [page, server] of [[0, 'silver'], [1, 'gold']]) {
        const payload = await queue.queuePayload(page, 'owner');
        const embed = payload.embeds[0].toJSON();
        assert.equal(embed.color, SERVERS[server].color);
        assert.match(embed.title, new RegExp(`^${SERVERS[server].label} Scout review ${page + 1} of 2$`, 'u'));
        const ids = payload.components.flatMap(row => row.toJSON().components.map(button => button.custom_id));
        assert.equal(new Set(ids).size, ids.length);
        assert.ok(ids.filter(id => id.startsWith('pvp-scout-review:') && !id.includes(':server:')).every(id => id.endsWith(':cross')));
        assert.ok(ids.find(id => id.startsWith('scout-sources:')).endsWith(`:${server}`));
    }
});

test('combined review fetches sources only from the displayed report\'s archive', async () => {
    const f = fixture(), calls = [];
    for (const context of f.contexts) {
        const original = context.store.sourcesForRoots;
        context.store.sourcesForRoots = (...args) => { calls.push(context.server); return original.apply(context.store, args); };
    }
    const queue = new ScoutReview(f.config).scoped.get('cross');
    await queue.queuePayload(0, 'owner');
    assert.deepEqual(calls, ['silver']);
    calls.length = 0;
    await queue.queuePayload(1, 'owner');
    assert.deepEqual(calls, ['gold']);
});

test('combined review approval writes and regroups only the actual archive then retains its filter', async () => {
    const f = fixture(), command = new ScoutReview(f.config), queue = command.scoped.get('cross');
    const payload = await queue.queuePayload(0, 'owner');
    const confirm = payload.components[0].toJSON().components.find(button => button.label === 'Confirm');
    const click = interaction(confirm.custom_id); await command.handleButton(click);
    assert.deepEqual(f.calls.filter(([action]) => action === 'confirm').map(call => call.slice(1, 4)),
        [['silver', f.contexts[1].store.row.message_id, 'owner']]);
    assert.deepEqual(f.calls.filter(([action]) => action === 'regroup'), [['regroup', 'silver']]);
    const updated = click.calls.findLast(([action]) => action === 'edit')[1];
    assert.equal(updated.embeds[0].toJSON().color, SERVERS.gold.color);
    assert.equal(updated.components.at(-1).toJSON().components.find(button => button.style === 1).label, 'Cross Server');
    assert.match(click.calls.find(([action]) => action === 'feedback')[1].content, /Approved scout report/u);
});

test('combined review corrections and declines delegate options and avoid the other archive', async () => {
    const f = fixture(), view = new ScoutArchiveView(f.registry);
    const silver = f.contexts[1].store.row.message_id;
    await view.correctReview(silver, 'owner', { ign: 'CorrectName' }, { requirePending: true });
    assert.deepEqual(f.calls[0], ['correct', 'silver', silver, 'owner', { requirePending: true }]);
    await view.ingestor.rebuildGroups();
    const gold = f.contexts[0].store.row.message_id;
    await view.markNotScout(gold, 'owner', { requirePending: true });
    await view.ingestor.rebuildGroups();
    assert.deepEqual(f.calls.filter(([action]) => action === 'regroup'), [['regroup', 'silver'], ['regroup', 'gold']]);
    await assert.rejects(view.confirmReview('unknown', 'owner'), { code: 'SCOUT_REVIEW_STALE' });
});

test('combined review CSV includes each source server and ISO UTC timestamps', async () => {
    const f = fixture(), queue = new ScoutReview(f.config).scoped.get('cross');
    const payload = await queue.csvPayload(), csv = payload.files[0].attachment.toString('utf8');
    assert.match(csv, /"message_id","server","source_url","created_at"/u);
    assert.match(csv, /"silver"[\s\S]*"2026-10-02T23:30:00.000Z"/u);
    assert.match(csv, /"gold"[\s\S]*"2026-10-01T23:30:00.000Z"/u);
});

test('combined SQL review filters bind both channels and keep newest-first ordering', async () => {
    const queries = [], store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query(sql, params) {
        queries.push({ sql, params }); return [[{ total: 0 }]];
    } } });
    store.schemaReady = true;
    const scope = ['gold-channel', 'silver-channel'];
    await store.pendingReviews(1, 3, scope); await store.exportPendingReviews(scope); await store.pendingReviewCount(scope);
    for (const query of queries) assert.match(query.sql, /m.channel_id IN \(\?, \?\)/u);
    assert.deepEqual(queries[0].params, [...scope, ...scope, 1, 3]);
    assert.deepEqual(queries[1].params, [...scope, ...scope]);
    assert.ok(queries.slice(0, 2).every(query => /ORDER BY created_at DESC, message_id DESC/u.test(query.sql)));
});

test('the review queue keeps reports inside an open correction window and reports its deadline', async () => {
    const queries = [], row = { message_id: '1', channel_id: 'gold-channel', review_status: 'pending',
        pending_edit: 0, correction_open: 1, correction_due_at_ms: '1794212049857' };
    const store = new PvpScoutStore({ channelId: 'gold-channel', db: { async query(sql) {
        queries.push(sql); return [/COUNT\(\*\)/u.test(sql) ? [{ total: 1 }] : [row, { ...row, message_id: '2', correction_open: 0, correction_due_at_ms: null }]];
    } } });
    store.schemaReady = true;
    const [open, escalated] = await store.pendingReviews(2, 0);
    assert.deepEqual([open.correction_open, open.correction_due_at_ms], [true, 1794212049857]);
    assert.deepEqual([escalated.correction_open, escalated.correction_due_at_ms], [false, null]);
    assert.equal((await store.exportPendingReviews())[0].correction_open, true);
    await store.pendingReviewCount();
    // A waiting window is joined for display only; it no longer hides the report from officers.
    for (const sql of queries) assert.doesNotMatch(sql, /NOT EXISTS \(\s*SELECT 1 FROM pvp_scout_correction_windows/u);
    assert.match(queries[0], /LEFT JOIN pvp_scout_correction_windows c\s+ON c\.message_id = m\.message_id AND c\.channel_id = m\.channel_id AND c\.status = 'waiting'/u);
});

test('UTC summary dates do not shift around midnight under different host timezones', () => {
    const script = `const Scout=require('./commands/scout.js');
        const {utcDate}=require('./features/pvp-scouting/ScoutArchiveView.js');
        const dates=['2026-10-01T23:30:00Z','2026-10-02T00:30:00Z'];
        const results=dates.map((date,i)=>({root:{message_id:String(i),created_at:new Date(date),rating:300}}));
        console.log(JSON.stringify({dates:dates.map(utcDate),summary:new Scout({pvpScoutStore:{}}).ratingSummaryForResults(results,true)}));`;
    const outputs = ['UTC', 'Europe/Copenhagen', 'America/Los_Angeles'].map(TZ => execFileSync(process.execPath, ['-e', script],
        { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8', windowsHide: true }).trim());
    assert.equal(new Set(outputs).size, 1);
    assert.match(outputs[0], /2026-10-01 — 2026-10-02/u);
    assert.equal(utcDate(null), null); assert.equal(utcDate('invalid'), null);
});

test('a delayed review screenshot refresh cannot restore a previous archive filter', async () => {
    const { EmbedBuilder } = require('discord.js');
    for (const filter of ['cross', 'gold']) {
        const f = fixture(), command = new ScoutReview(f.config), gold = command.scoped.get('gold');
        const row = f.contexts[0].store.row, edits = [];
        row.attachments = [{ contentType: 'image/png', url: 'https://example.com/old.png' }];
        gold.reviewRows.set(row.message_id, row);
        gold.refreshImageUrl = async () => { row.attachments[0].url = 'https://example.com/new.png'; };
        const embed = new EmbedBuilder().setTitle('Scout review 1 of 1').setFooter({ text: `Message ${row.message_id}` });
        const current = command.scoped.get(filter).serverPanel({ embeds: [embed], components: [] }, 'owner', 'gold');
        const click = { user: { id: 'owner' }, async fetchReply() {
            return { id: 'reply', embeds: current.embeds.map(value => value.toJSON()), components: current.components };
        }, async editReply(payload) { edits.push(payload); } };
        gold.scheduleReviewImageRefresh(click, { embeds: [embed] });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(edits.length, filter === 'gold' ? 1 : 0);
    }
});
