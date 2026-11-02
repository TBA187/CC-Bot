const test = require('node:test');
const assert = require('node:assert/strict');
const { AUTHOR_EDIT_WINDOW_MS, canAutoApplyScoutEdit } = require('../features/pvp-scouting/ScoutEditPolicy');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore');
const { auditPayload, memberEditPayload, publishedPayload, diagnosticPayload } = require('../features/pvp-scouting/ScoutAuditLogger');
const oldText = 'Vegeta111\n[Hoppowdon Rocky Helmet] Earthquake, Toxic';
const newText = oldText.replace('Hoppowdon', 'Hippowdon');
const base = { content: oldText, ign: 'Vegeta111', rating: 300, authorId: 'member',
    messageId: '123', channelId: 'channel', createdAt: '2026-11-01T12:00:00.000Z',
    classification: 'scout', reviewStatus: 'not_required', teamText: '[Hippowdon Rocky Helmet] Earthquake, Toxic',
    attachments: [{ id: 'image', name: 'image.jpg', url: 'https://cdn/image?old' }] };

test('authors can change all scout details before the exact 24-hour cutoff', () => {
    const now = Date.parse(base.createdAt) + AUTHOR_EDIT_WINDOW_MS - 1;
    for (const patch of [{ ign: 'Vegeta112' }, { rating: 301 }, { attachments: [] },
        { notes: 'Choice Scarf confirmed' }, { content: newText.replace('Toxic', 'Taunt') }]) {
        const proposal = { ...base, ...patch };
        assert.equal(canAutoApplyScoutEdit(base, proposal, { now }), true);
        assert.equal(canAutoApplyScoutEdit(base, proposal, { now: now + 1 }), false);
    }
});

test('the original posting time and Discord edit timestamp govern queued edits and invalid dates fail closed', () => {
    const postedAt = Date.parse(base.createdAt), now = postedAt + 2 * AUTHOR_EDIT_WINDOW_MS;
    assert.equal(canAutoApplyScoutEdit(base, { ...base, editedAt: new Date(postedAt + AUTHOR_EDIT_WINDOW_MS - 1) }, { now }), true);
    assert.equal(canAutoApplyScoutEdit(base, { ...base, editedAt: new Date(postedAt + AUTHOR_EDIT_WINDOW_MS) }, { now }), false);
    for (const patch of [{ createdAt: null }, { createdAt: 'invalid' }, { createdAt: new Date(now + 1) }]) {
        assert.equal(canAutoApplyScoutEdit({ ...base, ...patch }, base, { now }), false);
    }
    for (const editedAt of ['invalid', new Date(postedAt - 1), new Date(now + 1)]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, editedAt }, { now }), false);
    }
    assert.equal(canAutoApplyScoutEdit(base, { ...base, createdAt: new Date(now) }, { now }), false);
});

test('officer decisions, pending proposals, source ownership and archive boundaries remain protected', () => {
    const now = Date.parse(base.createdAt) + 1000;
    for (const patch of [{ reviewed_by_id: 'officer' }, { reviewStatus: 'confirmed' }, { reviewStatus: 'corrected' },
        { reviewStatus: 'not_scout' }, { staffOverrides: { locked: true } }, { staffOverrides: { hidden: true } }, { is_deleted: true }]) {
        assert.equal(canAutoApplyScoutEdit({ ...base, ...patch }, base, { now }), false);
        assert.equal(canAutoApplyScoutEdit(base, base, { now, root: { ...base, ...patch } }), false);
    }
    for (const patch of [{ authorId: 'other' }, { messageId: 'other' }, { channelId: 'other' }]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, ...patch }, { now }), false);
    }
    assert.equal(canAutoApplyScoutEdit(base, base, { now, pendingEdit: { status: 'pending' } }), false);
    assert.equal(canAutoApplyScoutEdit(base, base, { now, rootEdit: { status: 'pending' } }), false);
    assert.equal(canAutoApplyScoutEdit(base, base, { now, root: { ...base, channelId: 'silver-channel', server: 'silver' } }), false);
});

test('linked follow-ups have their own 24-hour window without bypassing officer decisions', () => {
    const now = Date.parse(base.createdAt) + AUTHOR_EDIT_WINDOW_MS - 1;
    const source = { ...base, root_message_id: 'root' };
    const root = { ...base, messageId: 'root', createdAt: '2026-10-01T12:00:00Z' };
    assert.equal(canAutoApplyScoutEdit(source, base, { now, root }), true);
    assert.equal(canAutoApplyScoutEdit(source, base, { now: now + 1, root }), false);
    assert.equal(canAutoApplyScoutEdit(source, base, { now }), false);
    assert.equal(canAutoApplyScoutEdit(source, base, { now, root: { ...root, reviewed_by_id: 'officer' } }), false);
});

test('audit ignores refreshed screenshots, equal dates, numeric types and supplied false changes', () => {
    const before = { messageContent: oldText, createdAt: new Date('2026-10-01T06:00:00Z'),
        attachments: base.attachments, ign: base.ign, rating: '300' };
    const after = { ...before, messageContent: newText, createdAt: '2026-10-01T06:00:00.000Z',
        rating: 300, attachments: [{ id: 'image', name: 'image.jpg' }] };
    const event = { action: 'edit_accepted', actorId: 'officer', reportId: '123', messageId: '123', sources: [{ before, after }] };
    for (const changes of [undefined, Object.fromEntries(Object.keys(after).map(key => [key, { before: before[key], after: after[key] }]))]) {
        const embed = auditPayload({ ...event, sources: [{ before, after, changes }] }).embeds[0].toJSON();
        assert.deepEqual(embed.fields.map(f => f.name), ['Stored message text']);
        assert.match(embed.fields[0].value, /^```diff\n- \[Hoppowdon.*\n\+ \[Hippowdon.*\n```$/u);
        assert.doesNotMatch(embed.description, /Scout Report ID/u);
    }
});

test('all log kinds deduplicate IDs and member edits omit unchanged metadata', () => {
    const event = { reportId: '123', messageId: '123', ign: base.ign, before: base, after: { ...base, content: newText }, autoApproved: true };
    for (const build of [memberEditPayload, publishedPayload, e => diagnosticPayload({ ...e, message: 'Error' })]) {
        const embed = build(event).embeds[0].toJSON();
        assert.doesNotMatch(JSON.stringify(embed), /Scout Report ID/u);
        assert.match(JSON.stringify(embed), /Scout Message ID/u);
    }
    const embed = memberEditPayload(event).embeds[0].toJSON();
    assert.match(embed.description, /Automatically approved.*updated and published/u);
    assert.ok(!embed.fields.some(f => ['Opponent IGN', 'IGN confidence', 'IGN detection source', 'Attachments', 'PvP rating'].includes(f.name)));
    const changed = memberEditPayload({ ...event, after: { ...event.after, attachments: [] } }).embeds[0].toJSON();
    assert.ok(changed.fields.some(f => f.name === 'Attachments'));
    assert.match(publishedPayload({ ...event, reportId: '456' }).embeds[0].toJSON().description, /Scout Report ID.*456/u);
});

test('historical edit guard counts two other distinct old reports using durable channel-scoped activity', async () => {
    let count = 1, calls = [];
    const store = new PvpScoutStore({ channelId: 'channel', db: { async query(sql, params) { calls.push({ sql, params }); return [[{ total: count }]]; } } });
    store.ensureSchema = async () => {};
    const before = { ...base, messageId: 'source', root_message_id: 'root', createdAt: new Date(Date.now() - 8 * 86400000) };
    assert.equal(await store.isHistoricalEditBurst(before, { ...before, content: newText }), false);
    count = 2;
    assert.equal(await store.isHistoricalEditBurst(before, { ...before, content: newText }), true);
    assert.match(calls[0].sql, /COUNT\(DISTINCT/u);
    assert.match(calls[0].sql, /e.requested_at/u);
    assert.deepEqual(calls[0].params, ['channel', 'member', 'root']);
    calls = [];
    assert.equal(await store.isHistoricalEditBurst({ ...before, createdAt: new Date() }, { ...before, content: newText }), false);
    assert.equal(await store.isHistoricalEditBurst(before, before), false);
    assert.equal(calls.length, 0);
});

test('Gold and Silver apply recent edits and log each change while older or protected edits require review', async () => {
    const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor');
    const cases = [
        ['team', {}, { content: newText.replace('Toxic', 'Taunt'), teamText: 'Hippowdon: Taunt' }, true],
        ['ign', {}, { ign: 'Vegeta112' }, true], ['rating', {}, { rating: 301 }, true],
        ['notes', {}, { notes: 'Choice Scarf confirmed' }, true], ['screenshots', {}, { attachments: [] }, true],
        ['failed retry', { review_status: 'pending' }, {}, true],
        ['failed validation', {}, { reviewStatus: 'pending', reviewReason: 'Unclear IGN' }, true],
        ['old typo', { age: 8 * 86400000 }, {}, false],
        ['old failed retry', { age: 25 * 3600000, review_status: 'pending' }, {}, false],
        ['burst', { age: 8 * 86400000 }, {}, false], ['pending', {}, {}, false],
        ['officer', { review_status: 'confirmed', reviewed_by_id: 'officer' }, {}, false],
        ['linked recent source', { root_message_id: 'root' }, {}, true],
        ['linked old source', { root_message_id: 'root', age: 25 * 3600000 }, {}, false],
        ['linked officer decision', { root_message_id: 'root' }, {}, false],
        ['queued edit', { age: 25 * 3600000 }, { editAge: 23 * 3600000 }, true]
    ];
    for (const server of ['gold', 'silver']) for (const [scenario, patch, changed, allowed] of cases) {
        const createdAt = new Date(Date.now() - (patch.age || 3600000));
        let row = { message_id: '123', root_message_id: '123', channel_id: 'channel', author_id: 'member',
            author_username: 'Member', message_content: oldText, attachments: base.attachments,
            classification: 'scout', review_status: 'not_required', opponent_ign: base.ign, ign_normalized: 'vegeta111', rating: base.rating,
            team_text: base.teamText, created_at: createdAt, server, ...patch };
        const root = { ...row, message_id: 'root', root_message_id: 'root', created_at: new Date(Date.now() - 8 * 86400000),
            reviewed_by_id: scenario === 'linked officer decision' ? 'officer' : null };
        const logs = [], calls = [];
        const pending = scenario === 'pending' ? { status: 'pending', after: { ...base, content: oldText } } : null;
        const store = { async getMessage(id) { return id === 'root' ? root : row; }, async getEditReview() { return pending; },
            async isHistoricalEditBurst() { return scenario === 'burst'; },
            async sourcesForRoots() { return [row]; },
            async saveMessage(proposal) {
                calls.push('save'); assert.equal(proposal.createdAt, createdAt);
                row = { ...row, message_content: proposal.content, review_status: proposal.reviewStatus,
                    review_reason: proposal.reviewReason, opponent_ign: proposal.ign, rating: proposal.rating,
                    team_text: proposal.teamText, attachments: proposal.attachments };
                return row;
            },
            async stageEditReview() { calls.push('stage'); return { message_id: '123', revision: 1 }; },
            auditLogger: { memberEdited(event) { logs.push(event); } } };
        const ingestor = new PvpScoutIngestor({ server, store, channelId: 'channel', client: { user: { id: 'bot' } }, ocr: {},
            feedback: { async observeMessage() { calls.push('feedback'); } } });
        ingestor.buildRecord = async () => ({ ...base, server, createdAt: row.created_at, content: newText, ...changed,
            editedAt: changed.editAge ? new Date(createdAt.getTime() + changed.editAge) : null });
        ingestor.rebuildGroups = async () => { calls.push('publish'); };
        ingestor.notifyEditReview = async () => { calls.push('notify'); };
        await ingestor.handleUpdate({ id: '123', channelId: 'channel', author: { id: 'member' } });
        assert.deepEqual(calls, allowed ? ['save', 'publish', 'feedback'] : ['stage', 'notify', 'feedback'], scenario);
        assert.equal(logs.length, 1, scenario);
        assert.equal(logs[0].awaitingApproval, !allowed, scenario);
        assert.equal(logs[0].autoApproved, allowed ? true : undefined, scenario);
        assert.equal(logs[0].failed, scenario === 'failed validation', scenario);
        assert.equal(logs[0].server, server);
    }
});

test('historical pending edits notify officers and deduplicate report/message IDs', async () => {
    const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor');
    const sent = [];
    const store = { async getMessage() { return { message_id: '123', root_message_id: '123',
        created_at: new Date('2020-01-01'), author_username: 'Member', source_url: 'https://discord.com/channels/1/2/123' }; },
        async getEditReview() { return { status: 'pending', revision: 1 }; },
        async claimEditReviewAlert() { return true; }, async markEditReviewAlertSent() {} };
    const ingestor = new PvpScoutIngestor({ store, channelId: 'channel', officerChannelId: 'staff', ocr: {}, feedback: {},
        client: { channels: { cache: new Map([['staff', { async send(payload) { sent.push(payload); return { id: 'alert' }; } }]]) } } });
    await ingestor.notifyEditReview({ message_id: '123', revision: 1 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Scout Message ID: 123/u);
    assert.doesNotMatch(sent[0].content, /Scout Report ID/u);
});
