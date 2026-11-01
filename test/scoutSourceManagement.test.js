// Cover source attachment, separation, editing and deletion.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScoutSourceAdminStore } = require('../features/pvp-scouting/ScoutSourceAdminStore.js');
const { ScoutSourceManager, idFrom } = require('../features/pvp-scouting/ScoutSourceManager.js');
const { reportVersion } = require('../features/pvp-scouting/ScoutReportAdminStore.js');
const { PvpScoutStore, normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { buildGroupLinks, PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor.js');
const { partitionReportSources } = require('../features/pvp-scouting/ScoutReportSources.js');
const { buildReviewLearning } = require('../features/pvp-scouting/ScoutReviewLearning.js');
const { auditPayload } = require('../features/pvp-scouting/ScoutAuditLogger.js');

const ROOT = '1350059044102078494', REPLY = '1350059160351412264', TARGET = '1554691886654955681', OFFICER = '291142291073269761';
function raw(id, root = id, ign = 'Blacku', author = 'reporter') {
    return { message_id: id, root_message_id: root, channel_id: 'channel', guild_id: 'guild',
        author_id: author, author_username: author, created_at: new Date('2025-03-14T11:52:00Z'),
        message_content: `${ign}\nGliscor: Toxic`, source_url: `https://discord.com/channels/1/2/${id}`, reply_to_id: null,
        attachments_json: '[]', ocr_json: '[]', classification: 'scout', opponent_ign: ign,
        ign_normalized: ign.toLowerCase(), ign_confidence: 0.9, ign_source: 'battle_banner',
        rating: null, team_text: '- Gliscor: Toxic', notes: null, review_status: 'pending', review_reason: 'Unlabeled name', is_deleted: 0 };
}
function fixture({ failCommit = false } = {}) {
    const state = { rows: new Map([raw(ROOT), raw(REPLY, ROOT, 'Blacku', 'contributor'), raw(TARGET, TARGET, 'Vegeta111')]
        .map(row => [row.message_id, row])), events: [], audits: [], calls: [] };
    let backup;
    const query = async (sql, params = []) => {
        const q = sql.trim().replace(/\s+/gu, ' '); state.calls.push(q);
        if (q.startsWith('SELECT * FROM pvp_scout_messages')) {
            let found = [...state.rows.values()];
            if (q.includes('message_id IN (?, ?) ORDER')) found = found.filter(row => row.channel_id === params[0] && params.slice(1).includes(row.message_id));
            else if (q.includes('root_message_id IN')) found = found.filter(row => row.channel_id === params[0]
                && (params.slice(1, 3).includes(row.root_message_id) || params.slice(3).includes(row.message_id)));
            else found = found.filter(row => row.message_id === params[0] && row.channel_id === params[1]);
            return [structuredClone(found)];
        }
        if (q.startsWith('UPDATE pvp_scout_messages')) {
            const target = state.rows.get(params.at(-2)); assert.ok(target);
            let index = 0;
            for (const match of q.split(' SET ')[1].split(' WHERE ')[0].matchAll(/(\w+)\s*=\s*(\?|'[^']*'|NULL|CURRENT_TIMESTAMP\(3\)|\d+)/gu)) {
                const [, key, value] = match;
                target[key] = value === '?' ? params[index++] : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1)
                    : value.startsWith('CURRENT_TIMESTAMP') ? new Date() : Number(value);
            }
            assert.equal(index, params.length - 2); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_edit_reviews')) return [{ affectedRows: 0 }];
        if (q.startsWith('INSERT INTO pvp_scout_review_events')) {
            state.events.push({ message_id: params[0], action: 'corrected', reviewer_id: params[2],
                before_json: params[3], after_json: params[4], changes_json: params[5] }); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('INSERT INTO pvp_scout_messages')) {
            const columns = q.match(/pvp_scout_messages\s*\((.*?)\) VALUES/u)[1].split(',').map(name => name.trim());
            const values = [...q.match(/VALUES\s*\((.*)\)$/u)[1].matchAll(/\?|CURRENT_TIMESTAMP\(3\)|'[^']*'|\b\d+\b/gu)].map(match => match[0]);
            assert.equal(columns.length, values.length);
            let index = 0;
            const source = Object.fromEntries(columns.map((column, i) => [column, values[i] === '?' ? params[index++]
                : values[i].startsWith("'") ? values[i].slice(1, -1) : values[i].startsWith('CURRENT_TIMESTAMP') ? new Date() : Number(values[i])]));
            assert.equal(index, params.length); state.rows.set(source.message_id, source); return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected query: ${q}`);
    };
    const connection = { query, async beginTransaction() { backup = { rows: structuredClone(state.rows), events: structuredClone(state.events) }; },
        async commit() { if (failCommit) throw new Error('Controlled commit failure'); state.calls.push('commit'); },
        async rollback() { Object.assign(state, backup); state.calls.push('rollback'); }, release() { state.calls.push('release'); } };
    const store = { channelId: 'channel', ensureSchema: async () => {}, db: { getConnection: async () => connection },
        async getMessage(id) { const source = state.rows.get(String(id)); return source ? normalizeMessageRow(structuredClone(source)) : null; },
        async sourcesForRoots(roots) { return [...state.rows.values()].filter(row => roots.includes(row.root_message_id) && !row.is_deleted).map(normalizeMessageRow); },
        invalidateAutocompleteCache() { state.calls.push('invalidate'); }, auditLogger: { enqueue(event) {
            assert.equal(state.calls.at(-1), 'invalidate'); assert.ok(state.calls.includes('commit')); state.audits.push(event);
        } } };
    const admin = new ScoutSourceAdminStore(store);
    const versions = () => Object.fromEntries([...state.rows].map(([id, row]) => [id, reportVersion(row)]));
    return { store, admin, state, versions };
}

test('attaching a response changes only that source and logs the committed move', async () => {
    const f = fixture(); const original = structuredClone(f.state.rows.get(REPLY));
    const result = await f.admin.change('attached', REPLY, OFFICER, { targetId: TARGET, versions: f.versions() });
    assert.deepEqual(result, { sourceId: REPLY, rootId: TARGET });
    const source = await f.store.getMessage(REPLY);
    assert.equal(source.opponent_ign, 'Vegeta111'); assert.equal(source.review_status, 'corrected');
    assert.equal(source.staffOverrides.rootMessageId, TARGET); assert.equal(source.staffOverrides.relation, 'reply');
    assert.equal(f.state.rows.get(ROOT).root_message_id, ROOT);
    assert.equal(source.author_id, original.author_id); assert.deepEqual(source.created_at, original.created_at);
    assert.equal(f.state.audits.length, 1); assert.equal(f.state.audits[0].action, 'attached');
    assert.deepEqual(f.state.audits[0].sources[0].changes.rootMessageId, { before: ROOT, after: TARGET });
    const learning = buildReviewLearning(f.state.events); assert.equal(learning.aliases.size, 0); assert.equal(learning.sourceStats.size, 0);
});

test('attaching an original moves all its continuations and excludes cycles', async () => {
    const f = fixture(); await f.admin.change('attached', ROOT, OFFICER, { targetId: TARGET, versions: f.versions() });
    for (const id of [ROOT, REPLY]) { const source = await f.store.getMessage(id); assert.equal(source.root_message_id, TARGET); assert.equal(source.staffOverrides.rootMessageId, TARGET); }
    assert.equal(f.state.audits[0].sources.length, 2);
    await assert.rejects(f.admin.change('attached', ROOT, OFFICER, { targetId: TARGET, versions: f.versions() }), /already belongs/u);
});

test('detaching permits a different IGN and editing team, rating and notes without editing attribution', async () => {
    const f = fixture(), original = structuredClone(f.state.rows.get(REPLY));
    await f.admin.change('detached', REPLY, OFFICER, { versions: f.versions(), ign: 'Godredeye', rating: '309',
        teamText: '- Clefable: Moonblast', notes: 'Original report' });
    const source = await f.store.getMessage(REPLY);
    assert.equal(source.root_message_id, REPLY); assert.equal(source.staffOverrides.rootMessageId, REPLY);
    assert.equal(source.opponent_ign, 'Godredeye'); assert.equal(source.rating, 309);
    assert.equal(source.author_id, original.author_id); assert.deepEqual(source.created_at, original.created_at);
    const groups = buildGroupLinks([await f.store.getMessage(ROOT), source]); assert.equal(groups.messageRoots.get(REPLY), REPLY);
    assert.equal(f.state.audits[0].action, 'detached');
});

test('root IGN editing propagates to its family and cannot change reporter or date', async () => {
    const f = fixture(); const original = structuredClone(f.state.rows.get(ROOT));
    await f.admin.change('source_edited', ROOT, OFFICER, { versions: f.versions(), ign: 'Godredeye', rating: '',
        teamText: '- Chansey: Soft-Boiled', notes: '', authorId: 'fake', createdAt: new Date() });
    assert.equal(f.state.rows.get(ROOT).opponent_ign, 'Godredeye'); assert.equal(f.state.rows.get(REPLY).opponent_ign, 'Godredeye');
    assert.equal(f.state.rows.get(ROOT).author_id, original.author_id); assert.deepEqual(f.state.rows.get(ROOT).created_at, original.created_at);
    assert.equal(buildReviewLearning(f.state.events).aliases.get('blacku')[0].to, 'Godredeye');
});

test('editing a moved reply does not teach its original screenshot as another opponent', async () => {
    const f = fixture(); await f.admin.change('attached', REPLY, OFFICER, { targetId: TARGET, versions: f.versions() });
    await f.admin.change('source_edited', REPLY, OFFICER, { versions: f.versions(), ign: 'Vegeta111', rating: '',
        teamText: '- Gliscor: Protect', notes: 'More details' });
    assert.equal(buildReviewLearning(f.state.events).aliases.size, 0); assert.equal(buildReviewLearning(f.state.events).sourceStats.size, 0);
});

test('reply cannot be edited to another opponent without moving or detaching first', async () => {
    const f = fixture(); await assert.rejects(f.admin.change('source_edited', REPLY, OFFICER,
        { versions: f.versions(), ign: 'Godredeye', rating: '', teamText: '', notes: '' }), /move it first/u);
    assert.equal(f.state.audits.length, 0);
});

test('administrative source deletion hides one reply and never trains a rejection', async () => {
    const f = fixture(); await f.admin.change('source_deleted', REPLY, OFFICER, { versions: f.versions() });
    assert.equal((await f.store.getMessage(REPLY)).is_deleted, true); assert.equal(f.state.rows.get(ROOT).is_deleted, 0);
    const learning = buildReviewLearning(f.state.events); assert.equal(learning.rejectedText.size, 0); assert.equal(learning.sourceStats.size, 0);
    assert.equal(f.state.audits[0].action, 'source_deleted');
});

test('deleting the original deletes its entire report but preserves the target report', async () => {
    const f = fixture(); await f.admin.change('source_deleted', ROOT, OFFICER, { versions: f.versions() });
    assert.equal((await f.store.getMessage(ROOT)).is_deleted, true); assert.equal((await f.store.getMessage(REPLY)).is_deleted, true);
    assert.equal((await f.store.getMessage(TARGET)).is_deleted, false);
});

test('typed information becomes a separate attributed, permanent source with no fabricated Discord link', async () => {
    const f = fixture(); f.store.server = 'silver';
    const result = await f.admin.change('reply_added', ROOT, OFFICER,
        { versions: f.versions(), text: 'Gliscor: Toxic, Protect', username: 'officer' });
    const source = await f.store.getMessage(result.sourceId);
    assert.match(source.message_id, /^manual_[a-f0-9]{20}$/u); assert.equal(source.source_url, '');
    assert.equal(source.author_id, OFFICER); assert.equal(source.opponent_ign, 'Blacku');
    assert.equal(source.server, 'silver');
    assert.match(source.team_text, /Gliscor.*Toxic.*Protect/u); assert.equal(source.staffOverrides.manual, true);
    const partition = partitionReportSources(await f.store.getMessage(ROOT), await f.store.sourcesForRoots([ROOT]));
    assert.ok(partition.replies.some(row => row.message_id === source.message_id));
    assert.equal(buildReviewLearning(f.state.events).sourceStats.size, 0);
});

test('attaching to a report from another server is rejected before any source changes', async () => {
    const f = fixture(); f.state.rows.get(TARGET).channel_id = 'other-server-channel';
    const original = structuredClone(f.state.rows.get(REPLY));
    await assert.rejects(f.admin.change('attached', REPLY, OFFICER,
        { targetId: TARGET, versions: f.versions() }), /does not exist in the scout archive/u);
    assert.deepEqual(f.state.rows.get(REPLY), original);
    assert.equal(f.state.events.length, 0); assert.equal(f.state.audits.length, 0);
});

test('stale forms, hidden targets and commit failure cannot partially change or log a move', async () => {
    const f = fixture(), versions = f.versions(); f.state.rows.get(REPLY).notes = 'Changed';
    await assert.rejects(f.admin.change('attached', REPLY, OFFICER, { targetId: TARGET, versions }), /changed while/u);
    assert.equal(f.state.rows.get(REPLY).root_message_id, ROOT); assert.equal(f.state.audits.length, 0);
    const failed = fixture({ failCommit: true }); await assert.rejects(failed.admin.change('attached', REPLY, OFFICER,
        { targetId: TARGET, versions: failed.versions() }), /commit failure/u);
    assert.equal(failed.state.rows.get(REPLY).root_message_id, ROOT); assert.equal(failed.state.events.length, 0); assert.equal(failed.state.audits.length, 0);
    f.state.rows.get(TARGET).is_deleted = 1;
    await assert.rejects(f.admin.change('attached', REPLY, OFFICER, { targetId: TARGET, versions: f.versions() }), /no longer available/u);
});

test('manual attachments to later messages and manual separation survive automatic grouping', async () => {
    const f = fixture(); await f.admin.change('attached', ROOT, OFFICER, { targetId: TARGET, versions: f.versions() });
    const rows = await Promise.all([ROOT, REPLY, TARGET].map(id => f.store.getMessage(id)));
    const grouped = buildGroupLinks(rows); assert.equal(grouped.messageRoots.get(ROOT), TARGET); assert.equal(grouped.messageRoots.get(REPLY), TARGET);
    const queries = []; const store = new PvpScoutStore({ channelId: 'channel', db: { query: async sql => { queries.push(sql); return [[]]; } } });
    store.schemaReady = true; await store.setRootLinks([{ messageId: REPLY, rootMessageId: ROOT }]);
    assert.ok(queries.every(sql => sql.includes("JSON_EXTRACT(staff_overrides_json, '$.rootMessageId')")));
});

test('a later officer correction to another opponent persistently separates a manually attached source', async () => {
    const f = fixture(); await f.admin.change('attached', REPLY, OFFICER, { targetId: TARGET, versions: f.versions() });
    f.state.rows.get(REPLY).opponent_ign = 'Godredeye'; f.state.rows.get(REPLY).ign_normalized = 'godredeye';
    const store = new PvpScoutStore({ channelId: 'channel', db: { async query(sql, params) {
        assert.match(sql, /root_message_id = message_id, staff_overrides_json = \?/u);
        const source = f.state.rows.get(params[1]); source.root_message_id = source.message_id; source.staff_overrides_json = params[0];
        return [{ affectedRows: 1 }];
    } } }); store.getMessage = f.store.getMessage;
    const separated = await store.reconcileReviewedGroup(REPLY);
    assert.equal(separated.root_message_id, REPLY); assert.equal(separated.staffOverrides.rootMessageId, REPLY);
    assert.equal(separated.staffOverrides.relation, undefined);
});

function interaction(customId, fields = {}, roles = ['officer']) {
    const calls = [];
    return { customId, calls, user: { id: OFFICER, username: 'officer' }, member: { roles }, values: [],
        ...(customId && !customId.startsWith('scout-sources:modal:')
            ? { message: { id: 'source-message', components: [], attachments: new Map() } } : {}),
        fields: { getTextInputValue: name => fields[name] || '' },
        async deferReply(payload) { calls.push(['deferReply', payload]); }, async deferUpdate() { calls.push(['deferUpdate']); },
        async reply(payload) { calls.push(['reply', payload]); }, async editReply(payload) { calls.push(['editReply', payload]); },
        async followUp(payload) { calls.push(['followUp', payload]); }, async showModal(payload) { calls.push(['showModal', payload]); },
        async update(payload) { calls.push(['update', payload]); } };
}
function manager(f) { return new ScoutSourceManager({ pvpScoutStore: f.store, officerRoleID: 'officer' }); }
function component(panel, label) { return panel.components.flatMap(row => row.toJSON().components).find(button => button.label === label); }

test('source panel supports 26+ sources with unique IDs and bounded select options', async () => {
    const f = fixture(); for (let i = 0; i < 30; i++) f.state.rows.set(`source-${i}`, raw(`source-${i}`, ROOT));
    const m = manager(f); const panel = await m.panel(OFFICER, 'source-29');
    const components = panel.components.flatMap(row => row.toJSON().components);
    assert.equal(new Set(components.map(item => item.custom_id)).size, components.length);
    assert.ok(components.every(item => item.custom_id.length <= 100)); assert.ok(panel.components.length <= 5);
    assert.ok(components.filter(item => item.options).every(item => item.options.length <= 25));
    assert.ok(component(panel, 'Move / attach')); assert.ok(component(panel, 'Make independent')); assert.ok(component(panel, 'Add information'));
});

test('source open acknowledges before reading and edit/detach/move modals need no storage before acknowledgement', async () => {
    const f = fixture(), m = manager(f); const open = interaction(`scout-sources:open:${OFFICER}:${REPLY}`);
    const read = f.store.getMessage; f.store.getMessage = async id => { assert.equal(open.calls[0][0], 'deferUpdate'); return read(id); };
    await m.handleInteraction(open); f.store.getMessage = async () => assert.fail('No database read before modal');
    const panel = open.calls.at(-1)[1];
    for (const label of ['Move / attach', 'Edit', 'Make independent']) {
        const it = interaction(component(panel, label).custom_id); await m.handleInteraction(it); assert.equal(it.calls[0][0], 'showModal');
    }
});

test('officer forms never offer reporter/date, and forged menus are denied privately', async () => {
    const f = fixture(), m = manager(f), report = await m.admin.get(REPLY);
    const modal = m.modal(OFFICER, report, 'edit').toJSON();
    assert.deepEqual(modal.components.map(component => component.component.custom_id), ['ign', 'rating', 'team', 'notes']);
    for (const kind of ['move', 'add-id', 'add-text', 'detach', 'edit']) assert.doesNotThrow(() => m.modal(OFFICER, report, kind).toJSON());
    const stranger = interaction(`scout-sources:open:${OFFICER}:${REPLY}`, {}, []);
    await m.handleInteraction(stranger); assert.equal(stranger.calls[0][0], 'reply'); assert.equal(stranger.calls[0][1].flags, 64);
    const differentOwner = interaction(`scout-sources:open:another:${REPLY}`); await m.handleInteraction(differentOwner);
    assert.equal(differentOwner.calls[0][0], 'reply');
});

test('move by exact ID asks confirmation; confirming logs and updates the selected source', async () => {
    const f = fixture(), m = manager(f), report = await m.admin.get(REPLY);
    const modal = m.modal(OFFICER, report, 'move');
    const submit = interaction(modal.toJSON().custom_id, { target: TARGET }); await m.handleInteraction(submit);
    assert.equal(submit.calls[0][0], 'deferReply');
    const confirmation = submit.calls.at(-1)[1]; assert.equal(f.state.audits.length, 0);
    const confirm = interaction(component(confirmation, 'Attach').custom_id); await m.handleInteraction(confirm);
    assert.equal(confirm.calls[0][0], 'deferUpdate'); assert.equal(f.state.rows.get(REPLY).root_message_id, TARGET);
    assert.equal(f.state.audits.length, 1);
});

test('adding an archived message by ID opens a confirmation with the correct target', async () => {
    const f = fixture(), m = manager(f), report = await m.admin.get(TARGET);
    const modal = m.modal(OFFICER, report, 'add-id'); const submit = interaction(modal.toJSON().custom_id, { source: REPLY });
    await m.handleInteraction(submit);
    const confirmation = submit.calls.at(-1)[1]; assert.match(confirmation.embeds[0].toJSON().description, /Vegeta111/u);
    const confirm = interaction(component(confirmation, 'Attach').custom_id); await m.handleInteraction(confirm);
    assert.equal(f.state.rows.get(REPLY).root_message_id, TARGET);
});

test('new source-management actions have timestamped logo audit embeds with before/after grouping', () => {
    const payload = auditPayload({ action: 'attached', actorId: OFFICER, messageId: REPLY, reportId: TARGET,
        sources: [{ messageId: REPLY, before: { rootMessageId: ROOT, ign: 'Blacku' }, after: { rootMessageId: TARGET, ign: 'Vegeta111' } }] });
    const embed = payload.embeds[0].toJSON(); assert.equal(embed.title, 'Scout Source Attached');
    assert.match(embed.fields.find(field => field.name === 'Scout Report ID').value, /Before.*\n.*After/us);
    assert.ok(embed.timestamp); assert.equal(embed.footer.icon_url, 'attachment://cc_logo.webp');
});

function catchupFixture(count = 3, cursor = ROOT) {
    const id = offset => String(BigInt(ROOT) + BigInt(offset));
    const state = { cursor, writes: [], archived: new Map(), created: [], reads: [], fetches: [], grouped: 0 };
    const messages = Array.from({ length: count }, (_, offset) => ({ id: id(offset + 1), channelId: 'channel',
        createdTimestamp: Date.now() - 90 * 86400000 + offset, content: 'Blacku\nGliscor: Toxic' }));
    const channel = { messages: { async fetch(options) {
        state.fetches.push(options);
        assert.equal(options.cache, false);
        const page = messages.filter(message => !options.before || BigInt(message.id) < BigInt(options.before))
            .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, options.limit);
        return new Map(page.map(message => [message.id, message]));
    } } };
    const store = {
        async getCatchupCursor() { return state.cursor; },
        async saveCatchupCursor(value) {
            state.writes.push(value);
            if (!state.cursor || BigInt(value) > BigInt(state.cursor)) state.cursor = value;
        },
        async getMessage(value) { state.reads.push(value); return state.archived.get(value); }
    };
    const ingestor = new PvpScoutIngestor({ client: { channels: { cache: new Map([['channel', channel]]) } },
        store, channelId: 'channel', ocr: {} });
    ingestor.saveMessage = async message => {
        state.created.push(message.id);
        const row = { message_id: message.id, review_status: 'pending' };
        state.archived.set(message.id, row);
        return row;
    };
    ingestor.rebuildGroups = async () => { state.grouped++; return state.archived.size; };
    ingestor.notifyNewReview = async () => assert.fail('No historical notification');
    return { ingestor, store, channel, messages, state, id };
}

test('checkpoint catch-up imports months-old messages, skips saved decisions, and never sends historical alerts', async t => {
    t.mock.method(console, 'log', () => {});
    const f = catchupFixture();
    const edited = { review_status: 'corrected', staffOverrides: { hidden: true } };
    f.state.archived.set(f.id(2), edited);
    await f.ingestor.catchUpMessages();
    assert.deepEqual(f.state.created, [f.id(1), f.id(3)]);
    assert.equal(f.state.archived.get(f.id(2)), edited);
    assert.deepEqual(f.state.writes, [f.id(3)]);
    assert.equal(f.state.grouped, 1);
    assert.equal(f.ingestor.catchupReady, true);
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 2, 'running again must not duplicate scouts');
});

test('checkpoint catch-up reads every page beyond 100 messages and handles a deleted checkpoint message', async t => {
    t.mock.method(console, 'log', () => {});
    const f = catchupFixture(205);
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 205);
    assert.equal(f.state.fetches.length, 3);
    assert.deepEqual(f.state.writes, [f.id(205)]);
    assert.equal(f.state.grouped, 1);
    assert.ok(!f.messages.some(message => message.id === ROOT), 'checkpoint itself need not still exist in Discord');
});

test('first checkpoint checks all history once rather than trusting newer archived IDs beyond gaps', async t => {
    t.mock.method(console, 'log', () => {});
    const f = catchupFixture(105, null);
    for (const offset of [2, 101, 105]) f.state.archived.set(f.id(offset), { reviewed: true });
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 102);
    assert.ok(f.state.created.includes(f.id(1)), 'an older gap must not be skipped');
    assert.equal(f.state.fetches.length, 2);
    assert.deepEqual(f.state.writes, [f.id(105)]);
});

test('failed history fetch keeps the checkpoint and resumes without duplicating already saved messages', async t => {
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    const f = catchupFixture(105);
    const fetch = f.channel.messages.fetch;
    f.channel.messages.fetch = async options => {
        if (options.before) throw new Error('controlled history failure');
        return fetch(options);
    };
    await assert.rejects(f.ingestor.catchUpMessages(), /controlled history failure/u);
    assert.equal(f.state.created.length, 100);
    assert.equal(f.state.cursor, ROOT);
    assert.equal(f.ingestor.catchupReady, false);
    assert.equal(f.state.grouped, 1, 'saved portions must still be grouped');
    assert.ok(!logs.some(line => line.includes('Catch-up complete')), 'a failed scan must not claim completion');
    f.channel.messages.fetch = fetch;
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 105);
    assert.equal(new Set(f.state.created).size, 105);
    assert.equal(f.state.cursor, f.id(105));
});

test('live arrivals during catch-up cannot advance the checkpoint over older missed messages', async t => {
    t.mock.method(console, 'log', () => {});
    const f = catchupFixture(105);
    const fetch = f.channel.messages.fetch;
    f.channel.messages.fetch = async options => {
        if (options.before) {
            const live = { id: f.id(106), channelId: 'channel' };
            f.ingestor.notifyNewReview = async () => {};
            await f.ingestor.handleCreate(live);
            assert.deepEqual(f.state.writes, []);
        }
        return fetch(options);
    };
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 106);
    assert.equal(f.state.cursor, f.id(105), 'the completed scan covers only its initial snapshot');
    assert.equal(f.ingestor.catchupReady, true);
});

test('a failed live save prevents later live messages from advancing past the gap', async t => {
    t.mock.method(console, 'error', () => {});
    const f = catchupFixture();
    f.ingestor.catchupReady = true;
    f.ingestor.saveMessage = async () => { throw new Error('controlled archive failure'); };
    await assert.rejects(f.ingestor.handleCreate(f.messages[0]), /controlled archive failure/u);
    f.ingestor.saveMessage = async () => ({ review_status: 'not_required' });
    await f.ingestor.handleCreate(f.messages[1]);
    assert.equal(f.ingestor.catchupReady, false);
    assert.deepEqual(f.state.writes, []);
});

test('a live failure during the scan leaves later live checkpoint updates paused', async t => {
    const logs = [], warnings = [];
    t.mock.method(console, 'log', line => logs.push(line));
    t.mock.method(console, 'warn', line => warnings.push(line));
    t.mock.method(console, 'error', () => {});
    const f = catchupFixture(105);
    const fetch = f.channel.messages.fetch, save = f.ingestor.saveMessage;
    f.channel.messages.fetch = async options => {
        if (options.before) {
            f.ingestor.saveMessage = async () => { throw new Error('failed newer live message'); };
            await assert.rejects(f.ingestor.handleCreate({ id: f.id(106), channelId: 'channel' }), /failed newer live message/u);
            f.ingestor.saveMessage = save;
        }
        return fetch(options);
    };
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.cursor, f.id(105));
    assert.equal(f.ingestor.catchupReady, false);
    assert.ok(!logs.some(line => line.includes('Catch-up complete')));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[PvP Scout\] Gold:.*checkpoint paused/u);
});

test('live messages advance the durable checkpoint only after their save succeeds', async () => {
    const f = catchupFixture();
    f.ingestor.catchupReady = true;
    f.ingestor.notifyNewReview = async () => {};
    const save = f.ingestor.saveMessage;
    f.ingestor.saveMessage = async message => {
        assert.deepEqual(f.state.writes, []);
        return save(message);
    };
    await f.ingestor.handleCreate(f.messages[0]);
    assert.deepEqual(f.state.writes, [f.id(1)]);
});

test('checkpoint failures preserve the saved live report but pause further advancement', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = catchupFixture();
    f.ingestor.catchupReady = true;
    f.ingestor.notifyNewReview = async () => {};
    f.store.saveCatchupCursor = async () => { throw new Error('controlled cursor failure'); };
    const saved = await f.ingestor.handleCreate(f.messages[0]);
    assert.equal(saved.message_id, f.id(1));
    assert.equal(f.ingestor.catchupReady, false);
    assert.equal(f.state.cursor, ROOT);
});

test('shutdown during a catch-up save cannot advance the checkpoint', async t => {
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    const f = catchupFixture();
    const save = f.ingestor.saveMessage;
    f.ingestor.saveMessage = async message => {
        const row = await save(message);
        f.ingestor.stopped = true;
        return row;
    };
    await f.ingestor.catchUpMessages();
    assert.equal(f.state.created.length, 1);
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.ingestor.catchupReady, false);
    assert.ok(!logs.some(line => line.includes('Catch-up complete')));
});

test('startup reports completion for both archives even when every historical message is already saved', async t => {
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    for (const server of ['gold', 'silver']) {
        const f = catchupFixture();
        f.ingestor.server = server;
        for (const message of f.messages) f.state.archived.set(message.id, { reviewed: true });
        f.store.ensureSchema = async () => {};
        f.store.autocomplete = async () => [];
        f.store.refreshAutomaticRecords = async () => 0;
        f.ingestor.feedback = { async restorePending() {}, async stop() {} };
        await f.ingestor.start();
        await f.ingestor.catchupPromise;
        assert.deepEqual(f.state.created, [], 'saved messages must not be ingested or scanned again');
        assert.equal(f.ingestor.catchupReady, true);
        const label = server === 'silver' ? 'Silver' : 'Gold';
        assert.ok(logs.some(line => line.includes(`[PvP Scout] ${label}: Archive ready: 3 messages, 0 updated`)));
        assert.ok(logs.some(line => line.includes(`[PvP Scout] ${label}: Catch-up complete: 3 checked, 0 new, 1 page (`)));
        await f.ingestor.stop();
    }
});

test('long history scans report completed work at most every thirty seconds and finish with elapsed time', async t => {
    const logs = [];
    t.mock.method(console, 'log', line => logs.push(line));
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const f = catchupFixture(6);
    const save = f.ingestor.saveMessage;
    f.ingestor.saveMessage = async message => {
        const row = await save(message);
        now += 12_000;
        return row;
    };
    await f.ingestor.catchUpMessages();
    const progress = logs.filter(line => line.includes('Catch-up progress'));
    assert.equal(progress.length, 2);
    assert.match(progress[0], /3 checked, 3 new, 1 page \(36\.0s\)/u);
    assert.match(progress[1], /6 checked, 6 new, 1 page \(72\.0s\)/u);
    assert.match(logs.at(-1), /Catch-up complete:.*6 new, 1 page \(72\.0s\)/u);
    assert.equal(f.state.cursor, f.id(6));
});

test('durable checkpoint SQL uses the channel and numeric message ID without moving backward', async () => {
    const calls = [];
    const store = new PvpScoutStore({ channelId: 'channel', db: { async query(sql, params) {
        calls.push({ sql, params }); return [[{ last_message_id: ROOT }]];
    } } });
    store.schemaReady = true;
    assert.equal(await store.getCatchupCursor(), ROOT);
    await store.saveCatchupCursor(REPLY);
    assert.deepEqual(calls[1].params, ['channel', REPLY]);
    assert.match(calls[1].sql, /CAST\(VALUES\(last_message_id\) AS UNSIGNED\) > CAST\(last_message_id AS UNSIGNED\)/u);
    await assert.rejects(store.saveCatchupCursor('not-a-discord-id'), /Discord message ID/u);
});

test('message IDs and Discord links are accepted but arbitrary URLs cannot masquerade as IDs', () => {
    assert.equal(idFrom(TARGET), TARGET); assert.equal(idFrom(`https://discord.com/channels/1/2/${TARGET}`), TARGET);
    assert.equal(idFrom(`https://example.com/${TARGET}`), undefined);
});

test('stopping ingestion while OCR is in flight prevents a late database write', async () => {
    const ingestor = new PvpScoutIngestor({ client: {}, channelId: 'channel', ocr: {},
        store: { saveMessage: async () => assert.fail('No database write after stop') } });
    let complete;
    ingestor.buildRecord = () => new Promise(resolve => { complete = resolve; });
    const saving = ingestor.saveMessage({ id: ROOT, channelId: 'channel' });
    ingestor.stopped = true; complete({}); assert.equal(await saving, null);
});

test('startup goes directly to checkpoint catch-up for saved and missing cursors', async t => {
    t.mock.method(console, 'log', () => {});
    for (const [server, cursor] of [['gold', ROOT], ['silver', null]]) {
        const f = catchupFixture(105, cursor);
        f.ingestor.server = server;
        f.store.ensureSchema = async () => {};
        f.store.autocomplete = async () => [];
        f.store.refreshAutomaticRecords = async () => 0;
        let restored = 0;
        f.ingestor.feedback = { async restorePending() { restored++; }, async stop() {} };
        await f.ingestor.start();
        await f.ingestor.catchupPromise;
        assert.equal(f.ingestor.catchupReady, true);
        assert.equal(f.state.created.length, 105);
        assert.equal(f.state.cursor, f.id(105));
        assert.equal(restored, 1);
        await f.ingestor.stop();
        assert.equal(f.ingestor.started, false);
    }
});
