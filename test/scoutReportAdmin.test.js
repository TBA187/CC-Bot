// Cover officer edits and deletions, including persistent history and visibility.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PvpScoutStore, normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ScoutReportAdminStore, reportVersion, searchFilter, visible } = require('../features/pvp-scouting/ScoutReportAdminStore.js');
const { refreshImageAttachments } = require('../features/pvp-scouting/ScoutImageUrls.js');

const ROOT = '1350059044102078494', CHILD = '1350059160351412264', OFFICER = '291142291073269761';
function raw(id = ROOT) {
    return { message_id: id, root_message_id: ROOT, channel_id: 'channel', guild_id: 'guild', author_id: OFFICER,
        author_username: 'reporter', created_at: new Date('2025-03-14T11:52:00Z'), message_content: 'Blacku\nTornadus: Hidden Power Ice',
        source_url: `https://discord.com/channels/1/2/${id}`, attachments_json: '[{"id":"file","name":"team.png","url":"https://example.com/team.png","contentType":"image/png"}]',
        ocr_json: '[]', classification: 'scout', opponent_ign: 'Blacku', ign_normalized: 'blacku', ign_confidence: 0.9,
        ign_source: 'battle_banner', rating: 300, team_text: '- Tornadus: Hidden Power Ice', notes: null,
        review_status: 'confirmed', review_reason: null, team_layout_status: 'none', is_deleted: 0 };
}

function fixture(rows = [raw(), raw(CHILD)], { failCommit = false } = {}) {
    const state = { rows: new Map(rows.map(item => [item.message_id, structuredClone(item)])), events: [], audits: [],
        calls: [], commits: 0, rollbacks: 0, cancelled: [], windows: new Map() };
    let backup;
    async function query(sql, params = []) {
        const q = sql.trim().replace(/\s+/gu, ' '); state.calls.push({ q, params });
        if (q.startsWith('SELECT status FROM pvp_scout_correction_windows')) {
            return [state.windows.has(params[0]) ? [{ status: state.windows.get(params[0]) }] : []];
        }
        if (q.startsWith("UPDATE pvp_scout_correction_windows SET status = 'resolved'")) {
            if (state.windows.get(params[0]) === 'waiting') state.windows.set(params[0], 'resolved');
            return [{ affectedRows: 1 }];
        }
        if (q.startsWith('SELECT * FROM pvp_scout_messages')) {
            let found = [...state.rows.values()];
            if (q.includes('root_message_id = ?')) found = found.filter(item => item.channel_id === params[0] && item.root_message_id === params[1] && !item.is_deleted);
            else if (q.includes('root_message_id IN')) found = found.filter(item => item.channel_id === params[0] && params.slice(1).includes(item.root_message_id) && !item.is_deleted);
            else found = found.filter(item => item.message_id === params[0] && (!q.includes('channel_id = ?') || item.channel_id === params[1]));
            if (q.includes('is_deleted = 0')) found = found.filter(item => !item.is_deleted);
            return [structuredClone(found)];
        }
        if (q.startsWith('SELECT * FROM pvp_scout_edit_reviews')) return [state.edit ? [structuredClone(state.edit)] : []];
        if (q.startsWith('INSERT INTO pvp_scout_review_events')) {
            state.events.push({ message_id: params[0], action: params[2], reviewer_id: params[3], before_json: params[4], after_json: params[5], changes_json: params[6] });
            return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_edit_reviews')) {
            if (q.includes('SET status = ?')) { state.edit.status = params[0]; return [{ affectedRows: 1 }]; }
            state.cancelled.push(params[1]); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_messages SET')) {
            const target = state.rows.get(params.at(-2)); assert.ok(target, 'source update is addressed by ID');
            const set = q.split(' SET ')[1].split(' WHERE ')[0]; let index = 0;
            for (const match of set.matchAll(/(\w+)\s*=\s*(\?|'[^']*'|NULL|CURRENT_TIMESTAMP\(3\)|\d+)/gu)) {
                const [, key, value] = match;
                target[key] = value === '?' ? params[index++] : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1)
                    : value.startsWith('CURRENT_TIMESTAMP') ? new Date() : Number(value);
            }
            assert.equal(index, params.length - 2); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('INSERT INTO pvp_scout_messages')) {
            const names = ['message_id','channel_id','guild_id','author_id','author_username','created_at','edited_at','message_content','source_url','reply_to_id',
                'attachments_json','ocr_json','classification','opponent_ign','ign_normalized','ign_confidence','ign_source','rating','team_text','notes','root_message_id',
                'review_status','review_reason','team_layout_status','content_hash','server'];
            const incoming = Object.fromEntries(names.map((name, i) => [name, params[i]]));
            const previous = state.rows.get(incoming.message_id);
            const overrides = JSON.parse(previous?.staff_overrides_json || '{}');
            const preserve = params[26] && (['confirmed','corrected','not_scout'].includes(previous?.review_status) || overrides.locked);
            if (preserve) for (const name of ['classification','opponent_ign','ign_normalized','ign_confidence','ign_source','rating','team_text','notes','review_status','review_reason']) incoming[name] = previous[name];
            if (params[26]) incoming.root_message_id = previous?.root_message_id || incoming.root_message_id;
            state.rows.set(incoming.message_id, { ...previous, ...incoming, is_deleted: overrides.hidden ? 1 : 0 });
            assert.match(q, /is_deleted = IF\(COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(staff_overrides_json/u);
            return [{ affectedRows: 1 }];
        }
        if (q.includes('GROUP BY ign_normalized')) return [[]];
        throw new Error(`Unexpected admin test query ${q}`);
    }
    const connection = { query,
        async beginTransaction() { backup = { rows: structuredClone(state.rows), events: structuredClone(state.events), cancelled: structuredClone(state.cancelled) }; },
        async commit() { if (failCommit) throw new Error('Controlled commit failure'); state.commits++; },
        async rollback() { state.rollbacks++; Object.assign(state, backup); }, release() { state.calls.push({ q: 'RELEASE' }); } };
    const store = new PvpScoutStore({ channelId: 'channel', db: { query, getConnection: async () => connection },
        auditLogger: { enqueue(event) { assert.ok(state.commits > 0); assert.equal(state.calls.at(-1).q, 'RELEASE'); state.audits.push(event); } } });
    store.schemaReady = true; store.autocomplete = async () => [];
    store.reconcileReviewedGroup = id => store.getMessage(id);
    return { store, admin: new ScoutReportAdminStore(store), state, versions: () => Object.fromEntries([...state.rows].map(([id, item]) => [id, reportVersion(item)])) };
}

test('search supports exact Discord URLs and safely escapes LIKE wildcard characters', () => {
    assert.equal(searchFilter('').sql, '');
    const link = searchFilter(`https://discord.com/channels/1/2/${ROOT}`);
    assert.equal(link.params[1], ROOT); assert.equal(link.params[2], ROOT);
    assert.equal(searchFilter('a_b%!!').params[0], '%a!_b!%!!!!%');
    assert.equal(searchFilter(`<@${OFFICER}>`).params[3], OFFICER);
    assert.match(link.sql, /s.author_username/u); assert.match(link.sql, /s.team_text/u);
});

test('public visibility excludes deleted, declined and unpublished member submissions', () => {
    const source = raw(); assert.ok(visible(source));
    assert.equal(visible({ ...source, is_deleted: 1 }), false);
    assert.equal(visible({ ...source, review_status: 'not_scout' }), false);
    assert.equal(visible({ ...source, ign_source: 'member_submission', review_status: 'pending' }), false);
    assert.ok(visible({ ...source, ign_source: 'member_submission', review_status: 'confirmed' }));
});

test('the list uses only a limited root projection and does not load sources, OCR or screenshots', async () => {
    const calls = [];
    const store = { channelId: 'channel', ensureSchema: async () => {}, db: { async query(q, params) {
        calls.push({ q, params }); return q.includes('COUNT(*)') ? [[{ total: 200 }]] : [[raw()]];
    } } };
    const page = await new ScoutReportAdminStore(store).list('Blacku', 25, 50);
    assert.equal(page.total, 200); assert.equal(page.rows.length, 1); assert.equal(calls.length, 2);
    const read = calls.find(call => !call.q.includes('COUNT(*)'));
    assert.deepEqual(read.params.slice(-2), [25, 50]);
    assert.doesNotMatch(read.q.split('FROM pvp_scout_messages')[0], /attachments_json|ocr_json|SELECT \*/u);
});

test('officer correction changes details, renames matching continuations and records all before/after values', async () => {
    const f = fixture();
    const report = await f.admin.change(ROOT, ROOT, OFFICER, { details: { ign: 'Godredeye', rating: '309',
        teamText: '- Clefable: Moonblast', notes: 'Updated note' } }, f.versions());
    assert.equal(report.root.opponent_ign, 'Godredeye'); assert.equal(report.root.rating, 309);
    assert.equal(report.sources[1].opponent_ign, 'Godredeye');
    assert.equal(f.state.events.length, 2); assert.equal(f.state.audits.length, 1);
    assert.equal(f.state.audits[0].action, 'edited'); assert.equal(f.state.audits[0].actorId, OFFICER);
    const change = JSON.parse(f.state.events[0].changes_json);
    assert.deepEqual(change.ign, { before: 'Blacku', after: 'Godredeye' });
    assert.deepEqual(change.rating, { before: 300, after: 309 });
    assert.equal(report.root.staffOverrides.locked, true);
});

test('source text, links and screenshots are editable without changing raw archived evidence or reporter/date', async () => {
    const f = fixture(); const override = { source_url: `https://discord.com/channels/1/2/${ROOT}`, message_content: 'Updated content',
        attachments: [{ name: 'corrected.png', url: 'https://example.com/corrected.png', contentType: 'image/png' }] };
    const report = await f.admin.change(ROOT, ROOT, OFFICER, { overrides: override }, f.versions());
    assert.equal(report.root.author_id, OFFICER); assert.equal(report.root.author_username, 'reporter');
    assert.equal(report.root.created_at.toISOString(), raw().created_at.toISOString());
    assert.equal(report.root.message_content, 'Updated content');
    assert.equal(report.root.archive_message_content, raw().message_content);
    assert.equal(report.root.attachments[0].name, 'corrected.png');
    assert.equal(f.state.rows.get(ROOT).message_content, raw().message_content);
    const normalizedAgain = normalizeMessageRow(report.root);
    assert.equal(normalizedAgain.archive_message_content, raw().message_content);
    const refreshed = await refreshImageAttachments({ channels: { get() { throw new Error('No fetch of original screenshots'); } } }, report.root);
    assert.equal(refreshed, false); assert.equal(report.root.attachments[0].name, 'corrected.png');
});

test('later archive rereads cannot overwrite a locked correction even if original text changes', async () => {
    const f = fixture();
    await f.admin.change(ROOT, ROOT, OFFICER, { details: { ign: 'Godredeye', rating: 309, teamText: '- Clefable: Moonblast', notes: 'Officer note' } }, f.versions());
    await f.store.saveMessage({ messageId: ROOT, channelId: 'channel', content: 'Entirely changed original text',
        attachments: [], ign: 'WrongRead', ignNormalized: 'wrongread', rating: 10, teamText: 'Wrong team', classification: 'review', reviewStatus: 'pending' });
    const saved = await f.store.getMessage(ROOT);
    assert.equal(saved.opponent_ign, 'Godredeye'); assert.equal(saved.team_text, '- Clefable: Moonblast');
    assert.equal(saved.notes, 'Officer note'); assert.equal(saved.review_status, 'corrected');
    assert.equal(f.state.audits.length, 1, 'an archive reread is not a user action');
});

test('locked report details remain intact while an author edit is awaiting review', async () => {
    const f = fixture();
    await f.admin.change(ROOT, ROOT, OFFICER, { details: { ign: 'Godredeye', rating: 309, teamText: '- Clefable: Moonblast', notes: 'Officer note' } }, f.versions());
    f.state.rows.get(ROOT).review_status = 'pending';
    await f.store.saveMessage({ messageId: ROOT, channelId: 'channel', content: 'Changed raw text', attachments: [],
        ign: 'WrongRead', ignNormalized: 'wrongread', classification: 'review', reviewStatus: 'pending' });
    const saved = await f.store.getMessage(ROOT);
    assert.equal(saved.opponent_ign, 'Godredeye'); assert.equal(saved.notes, 'Officer note');
    const upsert = f.state.calls.findLast(call => call.q.startsWith('INSERT INTO pvp_scout_messages'));
    assert.match(upsert.q, /review_status IN.*OR COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(staff_overrides_json, '\$\.locked'/u);
});

test('report storage rejects reporter and posted date changes, including forged override requests', async () => {
    const f = fixture();
    for (const overrides of [{ author_id: '123456789012345678' }, { author_username: 'Display correction' }, { created_at: '2026-10-01T01:00:00Z' }]) {
        await assert.rejects(f.admin.change(ROOT, ROOT, OFFICER, { overrides }, f.versions()), /Unsupported source change/u);
    }
    assert.equal(f.state.rows.get(ROOT).author_id, OFFICER);
    assert.equal(f.state.rows.get(ROOT).author_username, 'reporter');
    assert.equal(f.state.audits.length, 0);
    const legacy = normalizeMessageRow({ ...raw(), staff_overrides_json: JSON.stringify({ author_id: null,
        author_username: 'Wrong reporter', created_at: '2026-10-01T01:00:00Z' }) });
    assert.equal(legacy.author_id, OFFICER); assert.equal(legacy.author_username, 'reporter');
    assert.equal(legacy.created_at.toISOString(), raw().created_at.toISOString());
});

test('deletion hides every source, cancels edits, keeps history and never revives after a reread', async () => {
    const f = fixture();
    assert.equal(await f.admin.change(ROOT, ROOT, OFFICER, {}, f.versions(), true), null);
    assert.equal(await f.admin.get(ROOT), null); assert.equal(f.state.events.length, 2);
    assert.deepEqual(f.state.cancelled, [ROOT, CHILD]); assert.equal(f.state.audits[0].action, 'deleted');
    for (const id of [ROOT, CHILD]) {
        assert.equal(JSON.parse(f.state.rows.get(id).staff_overrides_json).hidden, true);
        await f.store.saveMessage({ messageId: id, channelId: 'channel', content: 'Changed raw text', attachments: [],
            ign: 'Unexpected', ignNormalized: 'unexpected', classification: 'scout', reviewStatus: 'not_required' });
        assert.equal((await f.store.getMessage(id)).is_deleted, true);
    }
    assert.equal(f.state.audits.length, 1);
});

test('stale root and source versions reject changes and send no action log', async () => {
    for (const deleting of [false, true]) {
        const f = fixture(); const versions = f.versions();
        f.state.rows.get(CHILD).notes = 'Another officer edited this';
        await assert.rejects(f.admin.change(ROOT, ROOT, OFFICER,
            { details: { ign: 'Godredeye', rating: null } }, versions, deleting), /changed while your form was open/u);
        assert.equal(f.state.rows.get(ROOT).opponent_ign, 'Blacku');
        assert.equal(f.state.events.length, 0); assert.equal(f.state.audits.length, 0); assert.equal(f.state.rollbacks, 1);
    }
});

test('failed transactions roll back report changes and never send a success audit', async () => {
    const f = fixture(undefined, { failCommit: true });
    await assert.rejects(f.admin.change(ROOT, ROOT, OFFICER, { details: { ign: 'Godredeye', rating: 309 } }, f.versions()), /commit failure/u);
    assert.equal(f.state.rows.get(ROOT).opponent_ign, 'Blacku');
    assert.equal(f.state.events.length, 0); assert.equal(f.state.audits.length, 0);
});

test('continuation-only editors cannot rename the root or alter hidden/internal override flags', async () => {
    const f = fixture();
    await assert.rejects(f.admin.change(ROOT, CHILD, OFFICER, { details: { ign: 'Godredeye', rating: null } }, f.versions()), /original source first/u);
    await assert.rejects(f.admin.change(ROOT, ROOT, OFFICER, { overrides: { hidden: true } }, f.versions()), /Unsupported/u);
    assert.equal(f.state.audits.length, 0);
});

test('signed URL renewals do not invalidate an editor but officer screenshot changes do', () => {
    const before = raw(), after = { ...before, attachments_json: before.attachments_json.replace('https://example.com/team.png', 'https://example.com/team.png?ex=new') };
    assert.equal(reportVersion(before), reportVersion(after));
    assert.notEqual(reportVersion(before), reportVersion({ ...before, attachments_json: '[]' }));
    after.staff_overrides_json = JSON.stringify({ attachments: [{ name: 'new.png', url: 'https://example.com/new.png' }] });
    assert.notEqual(reportVersion(before), reportVersion(after));
});

for (const [method, action] of [['confirmReview', 'confirmed'], ['correctReview', 'corrected'], ['markNotScout', 'not_scout']]) {
    test(`/scout-review ${method} logs the new saved action and no duplicate on repeated clicks`, async () => {
        const f = fixture([{ ...raw(), review_status: 'pending' }]);
        await f.store[method](ROOT, OFFICER, { ign: 'Godredeye', ignNormalized: 'godredeye', rating: 309 });
        assert.equal(f.state.audits.length, 1); assert.equal(f.state.audits[0].action, action);
        assert.equal(f.state.audits[0].sources[0].before.ign, 'Blacku');
        await f.store[method](ROOT, OFFICER, { ign: 'Godredeye', ignNormalized: 'godredeye', rating: 309 });
        assert.equal(f.state.audits.length, 1);
    });
}

test('officers can decide a report during its open correction window, which the decision closes', async () => {
    const options = { requirePending: true, expectedContentHash: 'seen' };
    for (const [method, status] of [['confirmReview', 'confirmed'], ['correctReview', 'corrected'], ['markNotScout', 'not_scout']]) {
        const f = fixture([{ ...raw(), review_status: 'pending', content_hash: 'seen' }]);
        f.state.windows.set(ROOT, 'waiting');
        await f.store[method](ROOT, OFFICER, ...(method === 'correctReview'
            ? [{ ign: 'Godredeye', ignNormalized: 'godredeye', rating: 309 }, options] : [options]));
        assert.equal(f.state.rows.get(ROOT).review_status, status);
        assert.equal(f.state.windows.get(ROOT), 'resolved');
        assert.equal(f.state.audits.length, 1);
    }
});

test('a review decision is refused when the member edited the message after the panel opened', async () => {
    const f = fixture([{ ...raw(), review_status: 'pending', content_hash: 'edited' }]);
    f.state.windows.set(ROOT, 'waiting');
    await assert.rejects(f.store.confirmReview(ROOT, OFFICER, { requirePending: true, expectedContentHash: 'seen' }),
        { code: 'SCOUT_REVIEW_STALE', message: /edited this scout message/u });
    assert.equal(f.state.rows.get(ROOT).review_status, 'pending');
    assert.equal(f.state.windows.get(ROOT), 'waiting');
    assert.equal(f.state.events.length, 0); assert.equal(f.state.audits.length, 0);
    // Controls created before the hash was tracked still work.
    await f.store.confirmReview(ROOT, OFFICER, { requirePending: true });
    assert.equal(f.state.rows.get(ROOT).review_status, 'confirmed');
});

test('historical maintenance corrections do not post action logs', async () => {
    const f = fixture();
    await f.store.correctReview(ROOT, OFFICER, { ign: 'Godredeye', ignNormalized: 'godredeye' },
        { allowPreviouslyReviewed: true, logAction: false });
    assert.equal(f.state.events.length, 1); assert.equal(f.state.audits.length, 0);
});

for (const accept of [true, false]) test(`author edit ${accept ? 'acceptance' : 'decline'} logs only once with the proposed changes`, async () => {
    const f = fixture([{ ...raw(), review_status: 'pending' }]);
    const previous = { messageId: ROOT, ign: 'Blacku', reviewStatus: 'confirmed', content: 'Old content',
        rating: 300, teamText: 'Old team', sourceUrl: raw().source_url };
    const proposed = { ...previous, content: 'New content', ign: 'Godredeye', ignNormalized: 'godredeye',
        classification: 'scout', rating: 309, reviewStatus: 'pending', attachments: [], ocrResults: [] };
    f.state.edit = { status: 'pending', before_json: JSON.stringify(previous), after_json: JSON.stringify(proposed) };
    await f.store.resolveEditReview(ROOT, OFFICER, accept);
    assert.equal(f.state.audits.length, 1);
    assert.equal(f.state.audits[0].action, accept ? 'edit_accepted' : 'edit_rejected');
    assert.equal(f.state.audits[0].sources[0].before.messageContent, 'Old content');
    assert.equal(f.state.audits[0].sources[0].after.messageContent, 'New content');
    const current = await f.store.getMessage(ROOT);
    assert.equal(current.opponent_ign, accept ? 'Godredeye' : 'Blacku');
    if (accept) assert.equal(f.state.audits[0].sources[0].after.reviewStatus, 'confirmed');
    await f.store.resolveEditReview(ROOT, OFFICER, accept);
    assert.equal(f.state.audits.length, 1);
});

test('accepting a typo preserves the posted date and screenshot URLs and logs only real differences', async () => {
    const { scoutVersion } = require('../features/pvp-scouting/PvpScoutStore');
    const { auditPayload } = require('../features/pvp-scouting/ScoutAuditLogger');
    const original = raw();
    const before = scoutVersion(original);
    const proposed = { ...before, content: before.content.replace('Tornadus', 'Tornadus-Therian'), createdAt: null };
    const f = fixture([{ ...original, review_status: 'pending' }]);
    f.state.edit = { status: 'pending', before_json: JSON.stringify(before), after_json: JSON.stringify(proposed) };
    await f.store.resolveEditReview(ROOT, OFFICER, true);
    const saved = await f.store.getMessage(ROOT);
    assert.equal(saved.created_at.getTime(), original.created_at.getTime());
    const after = f.state.audits[0].sources[0].after;
    assert.equal(after.createdAt.getTime(), original.created_at.getTime());
    assert.equal(after.attachments[0].url, before.attachments[0].url);
    const fields = auditPayload(f.state.audits[0]).embeds[0].toJSON().fields;
    assert.deepEqual(fields.map(field => field.name), ['Stored message text']);
    assert.match(fields[0].value, /^```diff/u);
});
