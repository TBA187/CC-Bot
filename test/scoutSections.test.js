// Covers messages that hold several scout reports: splitting, saving each as its own report, and shared feedback.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractScoutData, splitScoutSections } = require('../features/pvp-scouting/PvpScoutParser.js');
const { PvpScoutStore, discordMessageId, normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ScoutMessageFeedback } = require('../features/pvp-scouting/ScoutMessageFeedback.js');
const { PvpScoutIngestor, buildGroupLinks } = require('../features/pvp-scouting/PvpScoutIngestor.js');

const ID = '1570000000000000011', CHANNEL = '2000';
const A = 'Mattegray\n\n* Garchomp: outrage, earthquake\n\n* Zapdos: roost, defog';
const B = 'Rellique\n\n* Scizor: bullet punch, roost\n* Rotom-Wash: volt switch, hydro pump';
const C = 'Ufoz466\n\n* Clefable: moonblast, soft-boiled\n* Tyranitar: stone edge, crunch';
const reports = parsed => [parsed, ...(parsed.extraSections || [])].map(report => [report.ign, report.teamText.split('\n').length]);

test('several opponents in one message become one report each, with their own team', () => {
    const parsed = extractScoutData({ content: [A, B, C].join('\n\n'), attachments: [] });
    assert.deepEqual(reports(parsed), [['Mattegray', 2], ['Rellique', 2], ['Ufoz466', 2]]);
    assert.deepEqual(parsed.extraSections.map(section => section.content), [B, C]);
    for (const report of [parsed, ...parsed.extraSections]) {
        assert.deepEqual([report.classification, report.reviewStatus, report.notes], ['scout', 'not_required', null]);
    }
    assert.match(parsed.extraSections[0].teamText, /Scizor: Bullet Punch, Roost\n- Rotom-Wash/u);
});

test('the same opponent can appear again with a different team, while an exact repeat is saved once', () => {
    const first = 'Mattegray\n- Garchomp: outrage\n- Zapdos: roost';
    const parsed = extractScoutData({ content: [first, 'Mattegray\n- Garchomp: outrage\n- Zapdos: roost, defog', first, B].join('\n\n'), attachments: [] });
    assert.deepEqual(reports(parsed), [['Mattegray', 2], ['Mattegray', 2], ['Rellique', 2]]);
    assert.match(parsed.extraSections[0].teamText, /Zapdos: Roost, Defog/u);
});

test('labels, dividers, bold headings with ratings and one-line reports are all split', () => {
    const labelled = extractScoutData({ content: 'name : mattegray\n- Garchomp: outrage\n- Zapdos: roost\n------\nname : rellique\n- Scizor: roost\n------', attachments: [] });
    assert.deepEqual(reports(labelled), [['mattegray', 2], ['rellique', 1]]);
    assert.doesNotMatch(labelled.extraSections[0].content, /---/u);
    const bold = extractScoutData({ content: '**Mattegray** (312):\n- Garchomp: outrage\n**Rellique** (280):\n- Scizor: roost', attachments: [] });
    assert.deepEqual([bold.ign, bold.rating, bold.extraSections[0].ign, bold.extraSections[0].rating], ['Mattegray', 312, 'Rellique', 280]);
    const lines = extractScoutData({ content: 'Mattegray: Garchomp, Zapdos, Scizor\nRellique: Clefable, Tyranitar, Rotom-Wash', attachments: [] });
    assert.deepEqual(reports(lines), [['Mattegray', 3], ['Rellique', 3]]);
    // A digit in the name marks a heading even without an empty line.
    assert.equal(splitScoutSections('Mattegray\n- Garchomp: outrage\nUfoz466\n- Scizor: roost').length, 2);
});

test('sub-headings, notes and single reports are not split', () => {
    for (const content of [
        'Mattegray (312)\n- Garchomp: outrage\n- Zapdos: roost',
        // A plain word needs an empty line before it and two Pokémon below it.
        'Mattegray\n- Garchomp: outrage\n- Zapdos: roost\nRellique\n- Scizor: roost\n- Rotom-Wash: volt switch',
        'Mattegray\n- Garchomp: outrage\n\nbulky\n- Scizor: roost',
        'Mattegray\n- Garchomp: outrage\n\nLeads\n- Zapdos: roost\n- Scizor: roost\n\nhe switches a lot',
        'Mattegray\n- Garchomp: outrage\n\nGarchomp\n- Zapdos: roost\n- Scizor: roost',
        'Garchomp: outrage, earthquake\nZapdos: roost, defog',
        'gg\n\nwp'
    ]) {
        assert.equal(splitScoutSections(content), null, content);
        assert.equal(extractScoutData({ content, attachments: [] }).extraSections, undefined, content);
    }
    const single = extractScoutData({ content: 'Mattegray\n- Garchomp: outrage\n\nLeads\n- Zapdos: roost\n- Scizor: roost', attachments: [] });
    assert.deepEqual([single.ign, single.teamText.split('\n').length, single.notes], ['Mattegray', 3, 'Leads']);
});

test('a screenshot stays with the first report of the message', () => {
    const attachments = [{ id: '1', name: 'battle.png', contentType: 'image/png' }];
    const parsed = extractScoutData({ content: [A, B].join('\n\n'), attachments });
    assert.equal(parsed.hasImages, true);
    assert.equal(parsed.extraSections[0].hasImages, false);
});

test('further reports of one message stay separate reports when groups are rebuilt', () => {
    const row = (id, content, parsed) => ({ message_id: id, author_id: 'member', created_at: new Date('2026-11-12T10:00:00Z'), reply_to_id: null,
        is_deleted: false, review_status: 'not_required', classification: 'scout', message_content: content, attachments: [],
        team_text: parsed.teamText, opponent_ign: parsed.ign, ign_normalized: parsed.ignNormalized });
    const second = 'Mattegray\n- Scizor: roost\n- Rotom-Wash: volt switch';
    const parsed = extractScoutData({ content: [A, second, B].join('\n\n'), attachments: [] });
    const rows = [row(ID, [A, second, B].join('\n\n'), parsed), row(`${ID}_2`, second, parsed.extraSections[0]), row(`${ID}_3`, B, parsed.extraSections[1])];
    assert.deepEqual(buildGroupLinks(rows).links, []);
});

// A store whose row access is replaced by an in-memory map; syncSections itself is the real implementation.
function sectionStore(rows = []) {
    const state = { rows: new Map(rows.map(row => [row.message_id, row])), saved: [], deleted: [], resolved: [] };
    const store = new PvpScoutStore({ channelId: CHANNEL, server: 'silver', db: { async query(sql, params) {
        if (/SET is_deleted = 0, review_status = 'not_required'/u.test(sql)) Object.assign(state.rows.get(params[0]), { is_deleted: 0, review_status: 'not_required' });
        return [{ affectedRows: 1 }];
    } } });
    store.schemaReady = true;
    store.sectionRows = async id => [...state.rows.values()].filter(row => row.message_id.startsWith(`${id}_`)).map(normalizeMessageRow);
    store.saveMessage = async record => {
        state.saved.push(record);
        const previous = state.rows.get(record.messageId) || {};
        state.rows.set(record.messageId, { ...previous, message_id: record.messageId, channel_id: CHANNEL, message_content: record.content,
            opponent_ign: record.ign, ign_normalized: record.ignNormalized, team_text: record.teamText, rating: record.rating ?? null,
            review_status: record.reviewStatus, is_deleted: 0 });
        return normalizeMessageRow(state.rows.get(record.messageId));
    };
    store.markDeleted = async id => { state.deleted.push(id); Object.assign(state.rows.get(id), { is_deleted: 1, review_status: 'not_scout' }); };
    store.resolveCorrectionWindow = async id => { state.resolved.push(id); };
    return { store, state };
}

const primary = { messageId: ID, channelId: CHANNEL, authorId: 'member', authorUsername: 'Member', createdAt: new Date('2026-11-12T10:00:00Z'),
    sourceUrl: `https://discord.com/channels/1/${CHANNEL}/${ID}`, guildId: '1' };
const sections = content => extractScoutData({ content, attachments: [] }).extraSections || [];

test('further reports are saved under the message with their own text, and keep their IDs when reports are added or removed', async () => {
    const { store, state } = sectionStore();
    const created = await store.syncSections(primary, sections([A, B, C].join('\n\n')), { deferReview: true });
    assert.deepEqual([created.created, created.removed, created.rows.map(row => row.message_id)], [2, 0, [`${ID}_2`, `${ID}_3`]]);
    assert.deepEqual(state.saved.map(record => [record.messageId, record.ign, record.content, record.sourceUrl, record.authorId, record.deferReview, record.attachments.length]),
        [[`${ID}_2`, 'Rellique', B, primary.sourceUrl, 'member', true, 0], [`${ID}_3`, 'Ufoz466', C, primary.sourceUrl, 'member', true, 0]]);
    // The author inserts a report before the others and removes Rellique: Ufoz466 keeps its ID.
    const D = 'Alderan19\n\n* Jirachi: iron head, u-turn\n* Zapdos: roost';
    state.saved.length = 0;
    const edited = await store.syncSections(primary, sections([A, D, C].join('\n\n')));
    assert.deepEqual(state.saved.map(record => [record.messageId, record.ign]), [[`${ID}_4`, 'Alderan19'], [`${ID}_3`, 'Ufoz466']]);
    assert.deepEqual([edited.created, edited.removed, state.deleted, state.resolved], [1, 1, [`${ID}_2`], [`${ID}_2`]]);
    // Restoring the removed report brings back its earlier ID; removing everything deletes the rest.
    state.saved.length = 0;
    await store.syncSections(primary, sections([A, B].join('\n\n')));
    assert.deepEqual(state.saved.map(record => record.messageId), [`${ID}_2`]);
    assert.deepEqual(state.deleted, [`${ID}_2`, `${ID}_3`, `${ID}_4`]);
    assert.deepEqual(await store.syncSections({ ...primary, messageId: '1570000000000000099' }, []), { rows: [], created: 0, removed: 0 });
});

test('an officer decision on one report of a message survives the author editing the message', async () => {
    const { store, state } = sectionStore([
        { message_id: `${ID}_2`, channel_id: CHANNEL, message_content: B, opponent_ign: 'OfficerName', ign_normalized: 'officername', rating: 450,
            team_text: '- Scizor: Bullet Punch, Roost\n- Rotom-Wash: Volt Switch, Hydro Pump', review_status: 'corrected', reviewed_by_id: 'officer',
            ign_source: 'human_corrected', ign_confidence: 1, is_deleted: 0 },
        { message_id: `${ID}_3`, channel_id: CHANNEL, message_content: C, opponent_ign: 'Ufoz466', ign_normalized: 'ufoz466', review_status: 'corrected',
            reviewed_by_id: 'officer', staff_overrides_json: '{"locked":true}', team_text: '- Officer team', is_deleted: 0 },
        { message_id: `${ID}_4`, channel_id: CHANNEL, message_content: 'Wyloria\n\n* Zapdos: roost\n* Scizor: roost', opponent_ign: null, ign_normalized: null,
            review_status: 'not_scout', reviewed_by_id: 'officer', is_deleted: 0 }
    ]);
    const withMove = B.replace('hydro pump', 'hydro pump, will-o-wisp');
    await store.syncSections(primary, sections([A, withMove, C.replace('crunch', 'crunch, pursuit'), 'Wyloria\n\n* Zapdos: roost, defog\n* Scizor: roost'].join('\n\n')));
    // Only the unlocked, undeclined report is written; it keeps the officer's opponent and rating and gains the new move.
    assert.equal(state.saved.length, 1);
    const [record] = state.saved;
    assert.deepEqual([record.messageId, record.ign, record.rating, record.reviewStatus, record.preserveReviewDecision], [`${ID}_2`, 'OfficerName', 450, 'corrected', true]);
    assert.match(record.teamText, /Will-O-Wisp/u);
    assert.deepEqual(state.deleted, []);
});

test('split-report IDs map back to their Discord message, and other IDs are unchanged', () => {
    assert.equal(discordMessageId(`${ID}_2`), ID);
    assert.equal(discordMessageId(ID), ID);
    assert.equal(discordMessageId('manual_0123456789abcdef0123'), 'manual_0123456789abcdef0123');
    assert.equal(discordMessageId('manual_12345678901234567890'), 'manual_12345678901234567890');
});

function feedbackFixture(sectionRows) {
    const row = { message_id: ID, root_message_id: ID, channel_id: CHANNEL, author_id: 'member', created_at: new Date(), classification: 'scout',
        review_status: 'not_required', opponent_ign: 'Mattegray', ign_normalized: 'mattegray', attachments: [], team_text: '- Garchomp: Outrage' };
    const calls = { reactions: [], replies: [], published: [], fetched: [], windows: [] };
    const states = new Map();
    const message = { id: ID, channelId: CHANNEL, author: { id: 'member', bot: false }, reactions: { cache: new Map() },
        async react(emoji) { calls.reactions.push(emoji); }, async reply(payload) { calls.replies.push(payload.content); return { id: '900' }; } };
    const job = { channel_id: CHANNEL, root_message_id: ID, author_id: 'member', latest_message_id: ID, due_at_ms: 0, revision: 1 };
    const store = { async getMessage(id) { return id === ID ? row : sectionRows.find(item => item.message_id === id) || null; },
        async sourcesForRoots(ids) { return ids.includes(ID) ? [row] : sectionRows.filter(item => ids.includes(item.message_id)); },
        async sectionRows() { return sectionRows; }, async getEditReview() { return null; },
        async getMessageFeedback(id) { return states.get(id) || null; }, async saveMessageFeedback(id, state) { states.set(id, state); },
        async clearMessageFeedback(id) { states.delete(id); }, async messageFeedbackForReport() { return []; },
        async getCorrectionWindow() { return null; }, async resolveCorrectionWindow() {},
        async startCorrectionWindow(id, started, duration) { calls.windows.push(id); return { status: 'waiting', due_at_ms: started + duration }; },
        async getMessageFeedbackJob() { return job; }, async clearMessageFeedbackJob() {}, async claimPublicationLog() { return true; },
        async ensureReportTeamPresence() {} };
    const client = { user: { id: 'bot' }, rest: { async delete() {} },
        channels: { cache: new Map([[CHANNEL, { messages: { async fetch(id) { calls.fetched.push(id); return message; } } }]]) } };
    const feedback = new ScoutMessageFeedback({ client, store, channelId: CHANNEL, onPublished: async event => { calls.published.push(event); } });
    return { feedback, calls, job, message };
}

const section = (n, patch = {}) => ({ message_id: `${ID}_${n}`, root_message_id: `${ID}_${n}`, channel_id: CHANNEL, author_id: 'member', author_username: 'Member',
    created_at: new Date(), classification: 'scout', review_status: 'not_required', opponent_ign: `Opponent${n}`, ign_normalized: `opponent${n}`,
    attachments: [], team_text: '- Zapdos: Roost', source_url: 'https://discord.com/channels/1/2/3', ...patch });

test('a message with several valid reports gets one thumbs-up and a publication log per report', async t => {
    const f = feedbackFixture([section(2), section(3, { is_deleted: true })]);
    t.after(() => f.feedback.stop());
    await f.feedback.finishJob(f.job, f.message);
    assert.deepEqual(f.calls.reactions, ['👍']);
    assert.deepEqual(f.calls.published.map(event => [event.ign, event.reportId, event.messageId]), [['Mattegray', ID, ID], ['Opponent2', `${ID}_2`, `${ID}_2`]]);
    assert.deepEqual(f.calls.replies, []);
});

test('one report that needs review turns the shared reaction into a thumbs-down naming that report', async t => {
    const f = feedbackFixture([section(2), section(3, { review_status: 'pending', review_reason: 'Opponent IGN was inferred from an unlabeled line.' })]);
    t.after(() => f.feedback.stop());
    // An officer action on the further report refreshes the Discord message that holds it.
    await f.feedback.refreshReport(`${ID}_3`, null, true);
    assert.deepEqual(f.calls.fetched, [ID]);
    assert.deepEqual(f.calls.reactions, ['👎']);
    assert.match(f.calls.replies[0], /\*\*Reason:\*\* Report for Opponent3: Opponent IGN was inferred from an unlabeled line\./u);
    assert.deepEqual(f.calls.windows, [`${ID}_3`]);
});

test('ingestion saves every report of a message and deleting the message removes them all', async () => {
    const calls = [], rows = new Map();
    const store = { async saveMessage(record) { calls.push(['save', record.messageId]); rows.set(record.messageId, { message_id: record.messageId, root_message_id: record.messageId, review_status: 'not_required', is_deleted: false }); return rows.get(record.messageId); },
        async syncSections(saved, sectionList, options) { calls.push(['sync', saved.message_id, sectionList.map(item => item.ign), options.deferReview]); },
        async sectionRows(id) { return [{ message_id: `${id}_2`, is_deleted: false }, { message_id: `${id}_3`, is_deleted: true }]; },
        async markDeleted(id) { calls.push(['delete', id]); }, async resolveCorrectionWindow(id) { calls.push(['resolve', id]); },
        async getMessage(id) { return rows.get(id) || null; }, async getPreviousMessage() { return null; } };
    const ingestor = new PvpScoutIngestor({ client: { user: { id: 'bot' } }, store, server: 'silver', channelId: CHANNEL, ocr: {},
        feedback: { async remove(id) { calls.push(['feedback', id]); } } });
    ingestor.buildRecord = async message => ({ messageId: message.id, channelId: CHANNEL, ...extractScoutData({ content: message.content, attachments: [] }) });
    ingestor.rebuildGroups = async () => { calls.push(['regroup']); };
    const message = { id: ID, channelId: CHANNEL, author: { id: 'member', bot: false }, content: [A, B].join('\n\n') };
    await ingestor.saveMessage(message, { deferReview: true });
    assert.deepEqual(calls, [['save', ID], ['sync', ID, ['Rellique'], true]]);
    calls.length = 0;
    await ingestor.handleDelete(message);
    assert.deepEqual(calls, [['delete', ID], ['delete', `${ID}_2`], ['resolve', `${ID}_2`], ['regroup'], ['feedback', ID]]);
});
