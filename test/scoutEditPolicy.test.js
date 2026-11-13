const test = require('node:test');
const assert = require('node:assert/strict');
const { AUTHOR_EDIT_WINDOW_MS, CLOCK_SKEW_TOLERANCE_MS, canAutoApplyScoutEdit, isSmallEdit, mergeReviewedEdit,
    spamEditReason } = require('../features/pvp-scouting/ScoutEditPolicy');
const { PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore');
const { auditPayload, memberEditPayload, publishedPayload, diagnosticPayload } = require('../features/pvp-scouting/ScoutAuditLogger');
const oldText = 'Vegeta111\n[Hoppowdon Rocky Helmet] Earthquake, Toxic';
const newText = oldText.replace('Hoppowdon', 'Hippowdon');
const base = { content: oldText, ign: 'Vegeta111', rating: 300, authorId: 'member',
    messageId: '123', channelId: 'channel', createdAt: '2026-11-01T12:00:00.000Z',
    classification: 'scout', reviewStatus: 'not_required', teamText: '[Hippowdon Rocky Helmet] Earthquake, Toxic',
    attachments: [{ id: 'image', name: 'image.jpg', url: 'https://cdn/image?old' }] };
// A different opponent and team: far more than a small update.
const rewrite = { ign: 'OtherPlayer', content: 'OtherPlayer\nGarchomp: Outrage, Earthquake, Stealth Rock\nZapdos: Roost, Defog, Hurricane',
    teamText: '- Garchomp: Outrage, Earthquake, Stealth Rock\n- Zapdos: Roost, Defog, Hurricane' };

test('authors can change all scout details before the exact 48-hour cutoff, and only small updates afterwards', () => {
    assert.equal(AUTHOR_EDIT_WINDOW_MS, 48 * 60 * 60 * 1000);
    const now = Date.parse(base.createdAt) + AUTHOR_EDIT_WINDOW_MS - 1;
    for (const patch of [{ ign: 'Vegeta112' }, { rating: 301 }, { attachments: [] },
        { notes: 'Choice Scarf confirmed' }, { content: newText.replace('Toxic', 'Taunt') }, rewrite]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, ...patch }, { now }), true);
    }
    // A spelling fix, an added move or rating, or an extra screenshot is a small update at any age.
    for (const patch of [{ content: newText }, { content: `${oldText}, Stealth Rock` }, { rating: 301 },
        { content: oldText.replace('Vegeta111', 'Vegeta112'), ign: 'Vegeta112' },
        { attachments: [...base.attachments, { id: 'second', name: 'second.jpg' }] }]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, ...patch }, { now: now + 1 }), true, JSON.stringify(patch));
    }
    // A rewrite, a different opponent or a removed screenshot waits for an officer after the window.
    for (const patch of [rewrite, { content: oldText.replace('Vegeta111', 'Brandnew9'), ign: 'Brandnew9' }, { attachments: [] }]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, ...patch }, { now: now + 1 }), false, JSON.stringify(patch));
    }
});

test('small updates are measured against the archived text and limited to half of a longer message', () => {
    const long = { ...base, content: `Vegeta111\n${['Garchomp', 'Gliscor', 'Hippowdon', 'Landorus', 'Mamoswine']
        .map(name => `${name}: Earthquake, Toxic, Protect, Roost`).join('\n')}` };
    assert.equal(isSmallEdit(long, { ...long, content: `${long.content}\nZapdos: Roost, Defog, Hurricane, Volt Switch` }), true);
    assert.equal(isSmallEdit(long, { ...long, content: `${long.content}\n${'Extra line of text. '.repeat(7)}` }), false);
    // An officer's display override never makes the author's own change look larger.
    const overridden = { ...base, content: 'Officer wording', archive_message_content: oldText };
    assert.equal(isSmallEdit(overridden, { ...base, content: newText }), true);
});

test('the original posting time and Discord edit timestamp govern queued edits and invalid dates fail closed', () => {
    const postedAt = Date.parse(base.createdAt), now = postedAt + 2 * AUTHOR_EDIT_WINDOW_MS;
    const edited = { ...base, ...rewrite };
    assert.equal(canAutoApplyScoutEdit(base, { ...edited, editedAt: new Date(postedAt + AUTHOR_EDIT_WINDOW_MS - 1) }, { now }), true);
    assert.equal(canAutoApplyScoutEdit(base, { ...edited, editedAt: new Date(postedAt + AUTHOR_EDIT_WINDOW_MS) }, { now }), false);
    for (const patch of [{ createdAt: null }, { createdAt: 'invalid' }, { createdAt: new Date(now + CLOCK_SKEW_TOLERANCE_MS + 1) }]) {
        assert.equal(canAutoApplyScoutEdit({ ...base, ...patch }, base, { now }), false);
    }
    for (const editedAt of ['invalid', new Date(postedAt - 1), new Date(now + CLOCK_SKEW_TOLERANCE_MS + 1)]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, editedAt }, { now }), false);
    }
    assert.equal(canAutoApplyScoutEdit(base, edited, { now }), false);
});

test('a host clock behind Discord does not send a fresh edit to review', () => {
    const postedAt = Date.parse(base.createdAt);
    const edited = { ...base, ign: 'Vegeta112', editedAt: new Date(postedAt + 60_000) };
    // Discord stamped the edit two seconds after the host's current time.
    assert.equal(canAutoApplyScoutEdit(base, edited, { now: postedAt + 58_000 }), true);
    // Without an edit timestamp, a host clock behind the posting time still counts as a fresh edit.
    assert.equal(canAutoApplyScoutEdit(base, { ...base, ign: 'Vegeta112' }, { now: postedAt - 2000 }), true);
    // Timestamps further ahead than the tolerance stay protected.
    assert.equal(canAutoApplyScoutEdit(base, edited, { now: postedAt + 60_000 - CLOCK_SKEW_TOLERANCE_MS - 1 }), false);
});

test('corrections to the opponent, rating, team and screenshots are not spam, while replaced or wiped reports are held', () => {
    const published = { ...base, content: 'Vegeta111\nHippowdon: Earthquake\nZapdos: Roost',
        teamText: '- Hippowdon: Earthquake\n- Zapdos: Roost', attachments: [] };
    const wiped = { ign: null, teamText: null, classification: 'ignored' };
    for (const patch of [{ ign: 'Vegeta112' }, { rating: 301 }, { teamText: '- Hippowdon: Toxic\n- Zapdos: Defog' },
        // A different opponent with a team, or a screenshot on its own, is still a scout report.
        { ign: 'OtherPlayer', content: 'OtherPlayer\nGarchomp: Outrage', teamText: '- Garchomp: Outrage' },
        { ...wiped, content: '', attachments: [{ id: 'battle', name: 'battle.png', contentType: 'image/png' }] }]) {
        assert.equal(spamEditReason(published, { ...published, ...patch }), null);
    }
    for (const content of ['lol', '😂😂', 'fuck this guy']) {
        assert.match(spamEditReason(published, { ...published, ...wiped, content }), /off-topic text/u, content);
    }
    assert.match(spamEditReason(published, { ...published, ...wiped, content: 'nvm wrong player' }), /removed the opponent and every Pokémon/u);
    // A failed report or a message that was never a scout has nothing to protect.
    assert.equal(spamEditReason({ ...published, reviewStatus: 'pending' }, { ...published, ...wiped, content: 'lol' }), null);
    assert.equal(spamEditReason({ ...published, ...wiped, content: 'hello' }, { ...published, ...wiped, content: 'lol' }), null);
    // A linked follow-up has no IGN of its own: rewording it is fine, replacing it with chatter is not.
    const followUp = { ...published, ign: null, content: 'Zapdos: Roost', teamText: '- Zapdos: Roost' };
    assert.equal(spamEditReason(followUp, { ...followUp, teamText: null, content: 'he also carries a scarf' }), null);
    assert.match(spamEditReason(followUp, { ...followUp, teamText: null, content: 'lol' }), /off-topic text/u);
});

test('declined, locked, hidden and deleted reports, pending proposals and archive boundaries remain protected', () => {
    const now = Date.parse(base.createdAt) + 1000;
    for (const patch of [{ reviewStatus: 'not_scout' }, { staffOverrides: { locked: true } }, { staffOverrides: { hidden: true } }, { is_deleted: true }]) {
        assert.equal(canAutoApplyScoutEdit({ ...base, ...patch }, base, { now }), false);
        assert.equal(canAutoApplyScoutEdit(base, base, { now, root: { ...base, ...patch } }), false);
    }
    // A confirmed or corrected report still accepts its author's additions.
    for (const patch of [{ reviewed_by_id: 'officer' }, { reviewStatus: 'confirmed' }, { reviewStatus: 'corrected' }]) {
        assert.equal(canAutoApplyScoutEdit({ ...base, ...patch }, base, { now }), true);
        assert.equal(canAutoApplyScoutEdit(base, base, { now, root: { ...base, ...patch } }), true);
    }
    for (const patch of [{ authorId: 'other' }, { messageId: 'other' }, { channelId: 'other' }]) {
        assert.equal(canAutoApplyScoutEdit(base, { ...base, ...patch }, { now }), false);
    }
    assert.equal(canAutoApplyScoutEdit(base, base, { now, pendingEdit: { status: 'pending' } }), false);
    assert.equal(canAutoApplyScoutEdit(base, base, { now, rootEdit: { status: 'pending' } }), false);
    assert.equal(canAutoApplyScoutEdit(base, base, { now, root: { ...base, channelId: 'silver-channel', server: 'silver' } }), false);
});

test('linked follow-ups have their own 48-hour window', () => {
    const now = Date.parse(base.createdAt) + AUTHOR_EDIT_WINDOW_MS - 1;
    const source = { ...base, root_message_id: 'root' }, edited = { ...base, ...rewrite };
    const root = { ...base, messageId: 'root', createdAt: '2026-10-01T12:00:00Z' };
    assert.equal(canAutoApplyScoutEdit(source, edited, { now, root }), true);
    assert.equal(canAutoApplyScoutEdit(source, edited, { now: now + 1, root }), false);
    assert.equal(canAutoApplyScoutEdit(source, edited, { now }), false);
    assert.equal(canAutoApplyScoutEdit(source, edited, { now, root: { ...root, reviewed_by_id: 'officer' } }), true);
});

test('an author edit to an officer-reviewed report keeps the officer values it did not change', () => {
    const content = 'Vegeta111\nHippowdon: Earthquake\nZapdos: Roost';
    const saved = { ...base, content, attachments: [], ign: 'OfficerName', ignNormalized: 'officername', ignSource: 'human_corrected',
        ignConfidence: 1, rating: 450, teamText: '- Hippowdon: Earthquake\n- Zapdos: Roost', notes: 'Officer note',
        reviewStatus: 'corrected', reviewedById: 'officer' };
    const parsed = { ...base, attachments: [], ign: 'Vegeta111', ignNormalized: 'vegeta111', ignSource: 'first_line', ignConfidence: 0.86,
        rating: null, notes: null, reviewStatus: 'not_required' };
    // The author remembers one more move: only the team changes.
    const added = mergeReviewedEdit(saved, { ...parsed, content: `${content}, Defog`, teamText: '- Hippowdon: Earthquake\n- Zapdos: Roost, Defog' });
    assert.deepEqual([added.ign, added.ignSource, added.rating, added.notes, added.reviewStatus, added.preserveReviewDecision],
        ['OfficerName', 'human_corrected', 450, 'Officer note', 'corrected', true]);
    assert.equal(added.teamText, '- Hippowdon: Earthquake\n- Zapdos: Roost, Defog');
    // Naming another opponent replaces the officer's name and returns the report to normal validation.
    const renamed = mergeReviewedEdit(saved, { ...parsed, content: content.replace('Vegeta111', 'Brandnew9'), ign: 'Brandnew9',
        ignNormalized: 'brandnew9', teamText: saved.teamText });
    assert.deepEqual([renamed.ign, renamed.reviewStatus, renamed.preserveReviewDecision], ['Brandnew9', 'not_required', undefined]);
    assert.equal(renamed.teamText, saved.teamText); assert.equal(renamed.rating, 450);
});

test('saving a merged author edit keeps the officer decision columns and replaces the report details', async () => {
    const inserts = [];
    const store = new PvpScoutStore({ channelId: 'channel', db: { async query(sql, params) {
        if (/^\s*INSERT INTO pvp_scout_messages/u.test(sql)) inserts.push(params);
        return [/^\s*SELECT/u.test(sql) ? [] : { affectedRows: 1 }];
    } } });
    store.schemaReady = true;
    await store.saveMessage({ ...base, preserveReviewDecision: true });
    await store.saveMessage(base);
    assert.deepEqual(inserts[0].slice(-13), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(inserts[1].slice(-13), Array(13).fill(0));
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

test('Gold and Silver apply recent, small and reviewed-report edits and log each change while rewrites of old or protected reports require review', async () => {
    const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor');
    const cases = [
        ['team', {}, { content: newText.replace('Toxic', 'Taunt'), teamText: 'Hippowdon: Taunt' }, true],
        ['ign', {}, { ign: 'Vegeta112' }, true], ['rating', {}, { rating: 301 }, true],
        ['notes', {}, { notes: 'Choice Scarf confirmed' }, true], ['screenshots', {}, { attachments: [] }, true],
        ['failed retry', { review_status: 'pending' }, {}, true],
        ['failed validation', {}, { reviewStatus: 'pending', reviewReason: 'Unclear IGN' }, true],
        ['different opponent', {}, { ign: 'OtherPlayer', content: 'OtherPlayer\nGarchomp: Outrage', teamText: '- Garchomp: Outrage' }, true],
        ['spam', {}, { content: 'lol', ign: null, teamText: null, classification: 'ignored' }, false],
        ['old small update', { age: 8 * 86400000 }, {}, true],
        ['old rewrite', { age: 8 * 86400000 }, rewrite, false],
        ['old failed rewrite', { age: 49 * 3600000, review_status: 'pending' }, rewrite, false],
        ['burst', { age: 8 * 86400000 }, {}, false], ['pending', {}, {}, false],
        ['officer confirmed', { review_status: 'confirmed', reviewed_by_id: 'officer' }, {}, true],
        ['officer declined', { review_status: 'not_scout', reviewed_by_id: 'officer' }, {}, false],
        ['locked', { staffOverrides: { locked: true } }, {}, false],
        ['linked recent source', { root_message_id: 'root' }, {}, true],
        ['linked old rewrite', { root_message_id: 'root', age: 49 * 3600000 }, rewrite, false],
        ['linked officer decision', { root_message_id: 'root' }, {}, true],
        ['linked locked report', { root_message_id: 'root' }, {}, false],
        ['queued edit', { age: 49 * 3600000 }, { ...rewrite, editAge: 47 * 3600000 }, true]
    ];
    for (const server of ['gold', 'silver']) for (const [scenario, patch, changed, allowed] of cases) {
        const createdAt = new Date(Date.now() - (patch.age || 3600000));
        let row = { message_id: '123', root_message_id: '123', channel_id: 'channel', author_id: 'member',
            author_username: 'Member', message_content: oldText, attachments: base.attachments,
            classification: 'scout', review_status: 'not_required', opponent_ign: base.ign, ign_normalized: 'vegeta111', rating: base.rating,
            team_text: base.teamText, created_at: createdAt, server, ...patch };
        const root = { ...row, message_id: 'root', root_message_id: 'root', created_at: new Date(Date.now() - 8 * 86400000),
            reviewed_by_id: scenario === 'linked officer decision' ? 'officer' : null,
            staffOverrides: scenario === 'linked locked report' ? { locked: true } : {} };
        const logs = [], calls = [], saves = [];
        const pending = scenario === 'pending' ? { status: 'pending', after: { ...base, content: oldText } } : null;
        const store = { async getMessage(id) { return id === 'root' ? root : row; }, async getEditReview() { return pending; },
            async isHistoricalEditBurst() { return scenario === 'burst'; },
            async sourcesForRoots() { return [row]; },
            async saveMessage(proposal) {
                calls.push('save'); saves.push(proposal); assert.equal(proposal.createdAt, createdAt);
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
        if (scenario === 'officer confirmed') {
            assert.deepEqual([saves[0].reviewStatus, saves[0].preserveReviewDecision], ['confirmed', true]);
        }
        if (scenario === 'spam') assert.match(logs[0].safetyReason, /^Spam safeguard/u);
        else if (scenario !== 'burst') assert.equal(logs[0].safetyReason ?? null, null, scenario);
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
