// Covers officer alerts for member-deleted scout reports: recording, the alert panels, and each decision.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ButtonStyle } = require('discord.js');
const { normalizeMessageRow } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ACTION_HELP, ScoutDeletionReview, deletionPayload, handleScoutDeletionInteraction } = require('../features/pvp-scouting/ScoutDeletionReview.js');
const { PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor.js');

const ID = '1570000000000000011', ROOT = '1570000000000000001', CHANNEL = '2000', OFFICERS = '3000', MEMBER = '4000', OFFICER = '5000';

function raw(patch = {}) {
    return { message_id: ID, root_message_id: ID, channel_id: CHANNEL, server: 'silver', guild_id: '1', author_id: MEMBER,
        author_username: 'member', created_at: new Date('2026-11-12T10:00:00Z'), message_content: 'TestOpponent\nGarchomp: Outrage\nZapdos: Roost',
        source_url: `https://discord.com/channels/1/${CHANNEL}/${ID}`, attachments_json: '[]', ocr_json: '[]', classification: 'scout',
        opponent_ign: 'TestOpponent', ign_normalized: 'testopponent', ign_confidence: 0.9, ign_source: 'first_line', rating: 312,
        team_text: '- Garchomp: Outrage\n- Zapdos: Roost', notes: null, staff_overrides_json: null, review_status: 'not_required',
        review_reason: null, reviewed_by_id: null, is_deleted: 0, ...patch };
}

const IMAGE = { id: '900', name: 'battle.png', url: 'https://cdn.discordapp.com/attachments/1/2/battle.png', contentType: 'image/png' };

// A small in-memory archive that answers the statements used by the deletion store.
function fixture(rows = [raw()], { failSend = false } = {}) {
    const state = { rows: new Map(rows.map(row => [row.message_id, { ...row }])), deletions: new Map(), sent: [], reposts: [], audits: [], regroups: 0 };
    async function query(sql, params = []) {
        const q = sql.trim().replace(/\s+/gu, ' ');
        if (q.startsWith('INSERT IGNORE INTO pvp_scout_deletions')) {
            if (!state.deletions.has(params[0])) state.deletions.set(params[0], { message_id: params[0], channel_id: params[1], report_id: params[2],
                previous_status: params[3], restore_status: params[4], status: 'pending', deleted_by_id: null, alert_message_id: null,
                images_json: null, repost_message_id: null, decided_by_id: null, decided_at: null });
            return [{ affectedRows: 1 }];
        }
        if (q.startsWith('SELECT * FROM pvp_scout_deletions WHERE message_id')) return [state.deletions.has(params[0]) ? [{ ...state.deletions.get(params[0]) }] : []];
        if (q.startsWith('SELECT * FROM pvp_scout_deletions WHERE channel_id')) {
            return [[...state.deletions.values()].filter(item => item.status === 'pending' && !item.alert_message_id).map(item => ({ ...item }))];
        }
        if (q.startsWith('UPDATE pvp_scout_deletions SET alert_channel_id')) {
            Object.assign(state.deletions.get(params[4]), { alert_channel_id: params[0], alert_message_id: params[1],
                deleted_by_id: params[2] ?? state.deletions.get(params[4]).deleted_by_id, images_json: params[3] });
            return [{ affectedRows: 1 }];
        }
        if (q.startsWith("UPDATE pvp_scout_deletions SET restore_status = 'corrected'")) { state.deletions.get(params[0]).restore_status = 'corrected'; return [{ affectedRows: 1 }]; }
        if (q.startsWith("UPDATE pvp_scout_deletions SET status = 'reposted'")) {
            const deletion = state.deletions.get(params[1]);
            if (deletion.status !== 'kept' || deletion.repost_message_id) return [{ affectedRows: 0 }];
            Object.assign(deletion, { status: 'reposted', repost_message_id: params[0] }); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_deletions SET status = ?')) {
            Object.assign(state.deletions.get(params[3]), { status: params[0], decided_by_id: params[1], decided_at: params[2] }); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('SELECT staff_overrides_json FROM pvp_scout_messages')) return [[{ staff_overrides_json: state.rows.get(params[0]).staff_overrides_json }]];
        if (q.startsWith('SELECT * FROM pvp_scout_messages')) return [state.rows.has(params[0]) ? [{ ...state.rows.get(params[0]) }] : []];
        if (q.startsWith('UPDATE pvp_scout_messages SET staff_overrides_json = ? WHERE')) { state.rows.get(params[1]).staff_overrides_json = params[0]; return [{ affectedRows: 1 }]; }
        if (q.startsWith('UPDATE pvp_scout_messages SET staff_overrides_json = ?, reviewed_by_id')) {
            Object.assign(state.rows.get(params[2]), { staff_overrides_json: params[0], reviewed_by_id: params[1] }); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_messages SET opponent_ign')) {
            Object.assign(state.rows.get(params[7]), { opponent_ign: params[0], ign_normalized: params[1], rating: params[2], team_text: params[3],
                notes: params[4], reviewed_by_id: params[5], staff_overrides_json: params[6], ign_source: 'human_corrected', classification: 'scout' });
            return [{ affectedRows: 1 }];
        }
        if (q.startsWith("UPDATE pvp_scout_messages SET is_deleted = 0, review_status = 'confirmed'")) {
            Object.assign(state.rows.get(params[1]), { is_deleted: 0, review_status: 'confirmed', review_reason: null, reviewed_by_id: params[0] }); return [{ affectedRows: 1 }];
        }
        if (q.startsWith('UPDATE pvp_scout_messages SET is_deleted = 0, review_status = ?')) {
            Object.assign(state.rows.get(params[1]), { is_deleted: 0, review_status: params[0] }); return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected deletion test query: ${q}`);
    }
    const connection = { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
    const store = { channelId: CHANNEL, db: { query, getConnection: async () => connection }, async ensureSchema() {},
        async getMessage(id) { return state.rows.has(String(id)) ? normalizeMessageRow(state.rows.get(String(id))) : null; },
        async markDeleted(id) { Object.assign(state.rows.get(String(id)), { is_deleted: 1, review_status: 'not_scout' }); },
        invalidateAutocompleteCache() {}, async autocomplete() { return []; }, auditLogger: { enqueue(event) { state.audits.push(event); } } };
    const channel = (list, id) => ({ id, async send(payload) {
        if (failSend && id === CHANNEL) throw new Error('Missing Access');
        list.push(payload);
        const attachments = new Map((payload.files || []).map((file, index) => [`a${index}`, { id: `a${index}`, name: file.name,
            url: `https://cdn.discordapp.com/attachments/${id}/${list.length}/${file.name}`, contentType: 'image/png' }]));
        return { id: `m${list.length}`, channelId: id, url: `https://discord.com/channels/1/${id}/m${list.length}`, attachments };
    } });
    const client = { user: { id: 'bot', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot.png' },
        channels: { cache: new Map([[OFFICERS, channel(state.sent, OFFICERS)], [CHANNEL, channel(state.reposts, CHANNEL)]]) } };
    const review = new ScoutDeletionReview({ client, store, server: 'silver', channelId: CHANNEL, officerChannelId: OFFICERS, guildId: '1',
        regroup: async () => { state.regroups++; }, auditDelayMs: 0,
        download: async image => ({ attachment: Buffer.from('image'), name: image.name || 'image.png' }) });
    return { state, store, client, review };
}

function buttonInteraction(customId, { staff = true, guild = true } = {}) {
    const calls = { replies: [], edits: [], followUps: [], deferred: 0, modals: [] };
    return { calls, customId, user: { id: OFFICER }, inGuild: () => guild, isButton: () => true, isModalSubmit: () => false,
        member: { roles: { cache: staff ? [{ id: 'officer-role' }] : [] } },
        message: { id: 'alert', components: [], attachments: new Map() },
        async deferUpdate() { calls.deferred++; }, async editReply(payload) { calls.edits.push(payload); },
        async followUp(payload) { calls.followUps.push(payload); }, async reply(payload) { calls.replies.push(payload); },
        async showModal(modal) { calls.modals.push(modal); } };
}

const config = f => ({ officerRoleID: 'officer-role', scoutServers: { get: server => server === 'silver' ? { ingestor: { deletions: f.review } } : null } });
const labels = payload => payload.components.flatMap(row => row.toJSON().components.map(item => item.label));

test('only messages of a report shown in /scout are recorded, before the archive row is marked deleted', async () => {
    const chatter = raw({ message_id: '1570000000000000012', root_message_id: ROOT, classification: 'ignored', opponent_ign: null,
        ign_normalized: null, team_text: null, message_content: 'gg' });
    const followUp = { ...chatter, message_id: '1570000000000000013', team_text: '- Latios (Item: Choice Scarf)', message_content: 'scarf latios' };
    const unnamed = raw({ message_id: '1570000000000000014', root_message_id: '1570000000000000014', opponent_ign: null, ign_normalized: null, review_status: 'pending' });
    const f = fixture([raw(), raw({ message_id: ROOT, root_message_id: ROOT }), chatter, followUp, unnamed,
        raw({ message_id: '1570000000000000015', root_message_id: '1570000000000000015', is_deleted: 1, review_status: 'not_scout' })]);
    assert.equal((await f.review.capture(ID)).row.message_id, ID);
    assert.equal((await f.review.capture(followUp.message_id)).root.message_id, ROOT);
    for (const id of [chatter.message_id, unnamed.message_id, '1570000000000000015', 'missing']) assert.equal(await f.review.capture(id), null, id);
    assert.deepEqual([...f.state.deletions.keys()], [ID, followUp.message_id]);
    assert.deepEqual([f.state.deletions.get(ID).previous_status, f.state.deletions.get(followUp.message_id).report_id], ['not_required', ROOT]);
});

test('a deleted report is announced to officers with its screenshot copy, the four actions and no mentions', async () => {
    const f = fixture([raw({ attachments_json: JSON.stringify([IMAGE]) })]);
    const ingestor = new PvpScoutIngestor({ client: f.client, store: f.store, server: 'silver', channelId: CHANNEL, officerChannelId: OFFICERS,
        guildId: '1', ocr: {}, feedback: { async remove() {} } });
    ingestor.deletionReview = f.review;
    ingestor.rebuildGroups = async () => {};
    await ingestor.handleDelete({ id: ID, channelId: CHANNEL, author: { id: MEMBER, bot: false } });
    assert.equal(f.state.rows.get(ID).is_deleted, 1);
    assert.equal(f.state.sent.length, 1);
    const alert = f.state.sent[0], [info, preview] = alert.embeds.map(embed => embed.toJSON());
    assert.equal(info.title, '🗑️ Scout Report Deleted');
    assert.ok(info.description.endsWith(ACTION_HELP));
    assert.match(ACTION_HELP, /^\*\*Scout report is no longer shown in `\/scout`\. Select an action below:\*\*\n- \*\*Keep:\*\* Keep the scout report in `\/scout`\n- \*\*Keep & repost:\*\* Keep in `\/scout` and repost in scout channel \(CC bot author\)\n- \*\*Remove:\*\* Remove from `\/scout`\n- \*\*Edit:\*\* Edit the scout report before taking any action$/u);
    assert.match(info.description, new RegExp(`\\*\\*Scouted by:\\*\\* <@${MEMBER}>`, 'u'));
    assert.match(info.fields[0].value, /TestOpponent\nGarchomp: Outrage/u);
    assert.match(preview.title, /PvP Scout Report — TestOpponent \(312\)/u);
    assert.equal(preview.image.url, `attachment://scout-${ID}-1.png`);
    assert.ok(!preview.fields.some(field => field.name === 'Original message'), 'the deleted message has no working link');
    assert.deepEqual(alert.files.map(file => file.name), [`scout-${ID}-1.png`]);
    assert.deepEqual(alert.components[0].toJSON().components.map(item => [item.label, item.style, item.custom_id]), [
        ['Keep', ButtonStyle.Success, `scout-deleted:keep:silver:${ID}`], ['Keep & repost', ButtonStyle.Primary, `scout-deleted:repost:silver:${ID}`],
        ['Remove', ButtonStyle.Danger, `scout-deleted:remove:silver:${ID}`], ['Edit', ButtonStyle.Secondary, `scout-deleted:edit:silver:${ID}`]]);
    assert.deepEqual(alert.allowedMentions, { parse: [] });
    // The alert's copy becomes the saved screenshot, so it can be renewed without the deleted message.
    const deletion = f.state.deletions.get(ID), saved = JSON.parse(f.state.rows.get(ID).staff_overrides_json).attachments;
    assert.equal(deletion.alert_message_id, 'm1');
    assert.deepEqual([saved[0].sourceChannelId, saved[0].sourceMessageId, saved[0].name], [OFFICERS, 'm1', `scout-${ID}-1.png`]);
    // A second delete event or a restart does not announce it again.
    await f.review.announce(ID); await f.review.restorePending();
    assert.equal(f.state.sent.length, 1);
});

test('an interrupted alert is sent after a restart, and a lost screenshot is stated', async () => {
    const f = fixture([raw({ attachments_json: JSON.stringify([IMAGE]) })]);
    f.review.download = async () => { throw new Error('HTTP 404'); };
    await f.review.capture(ID); await f.store.markDeleted(ID);
    await f.review.restorePending();
    assert.equal(f.state.sent.length, 1);
    const [info, preview] = f.state.sent[0].embeds.map(embed => embed.toJSON());
    assert.match(info.description, /\*\*Deleted by:\*\* Unknown/u);
    assert.match(info.description, /screenshot could not be recovered/u);
    assert.equal(preview.image, undefined);
});

test('the audit log names a moderator only for a new or grown entry; otherwise the author deleted the message', async () => {
    const f = fixture();
    const entry = (id, count, ageMs = 1000, patch = {}) => ({ id, targetId: MEMBER, executorId: OFFICER, createdTimestamp: Date.now() - ageMs,
        extra: { channel: { id: CHANNEL }, count }, ...patch });
    let entries = [];
    const message = { guild: { async fetchAuditLogs() { return { entries: new Map(entries.map(item => [item.id, item])) }; } } };
    const row = normalizeMessageRow(raw());
    assert.equal(await f.review.deleter(message, row), MEMBER);
    entries = [entry('e1', 1)];
    assert.equal(await f.review.deleter(message, row), OFFICER);
    assert.equal(await f.review.deleter(message, row), MEMBER, 'the same entry does not explain a later deletion');
    entries = [entry('e1', 2, 120_000)];
    assert.equal(await f.review.deleter(message, row), OFFICER, 'Discord merged another moderator deletion into the entry');
    entries = [entry('e2', 1, 1000, { targetId: 'someone-else' }), entry('e3', 1, 1000, { extra: { channel: { id: 'other' }, count: 1 } }), entry('e4', 3, 600_000)];
    assert.equal(await f.review.deleter(message, row), MEMBER);
    message.guild.fetchAuditLogs = async () => { throw new Error('Missing Permissions'); };
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(await f.review.deleter(message, row), null); } finally { console.warn = warn; }
});

test('Keep restores the report once, and keeping a report that awaited review confirms it', async () => {
    for (const [status, expected, reviewer] of [['not_required', 'not_required', null], ['corrected', 'corrected', null], ['pending', 'confirmed', OFFICER]]) {
        const f = fixture([raw({ review_status: status })]);
        await f.review.capture(ID); await f.store.markDeleted(ID); await f.review.announce(ID);
        const interaction = buttonInteraction(`scout-deleted:keep:silver:${ID}`);
        assert.equal(await handleScoutDeletionInteraction(interaction, config(f)), true);
        const row = f.state.rows.get(ID);
        assert.deepEqual([row.is_deleted, row.review_status, row.reviewed_by_id], [0, expected, reviewer], status);
        assert.deepEqual([f.state.deletions.get(ID).status, f.state.deletions.get(ID).decided_by_id, f.state.regroups], ['kept', OFFICER, 1]);
        const panel = interaction.calls.edits.at(-1), info = panel.embeds[0].toJSON();
        assert.equal(info.title, '✅ Deleted Scout Report Kept');
        assert.match(info.description, new RegExp(`\\*\\*Kept\\*\\* by <@${OFFICER}>`, 'u'));
        assert.deepEqual(labels(panel), ['Repost in scout channel']);
        // A second officer pressing an old button changes nothing and is told so.
        const again = buttonInteraction(`scout-deleted:remove:silver:${ID}`);
        await handleScoutDeletionInteraction(again, config(f));
        assert.equal(f.state.deletions.get(ID).status, 'kept'); assert.equal(f.state.rows.get(ID).is_deleted, 0);
        assert.match(again.calls.followUps[0].content, /already kept/u);
    }
});

test('Remove leaves the report out of /scout and closes the alert', async () => {
    const f = fixture();
    await f.review.capture(ID); await f.store.markDeleted(ID); await f.review.announce(ID);
    const interaction = buttonInteraction(`scout-deleted:remove:silver:${ID}`);
    await handleScoutDeletionInteraction(interaction, config(f));
    assert.deepEqual([f.state.rows.get(ID).is_deleted, f.state.rows.get(ID).review_status, f.state.deletions.get(ID).status, f.state.regroups],
        [1, 'not_scout', 'removed', 0]);
    const panel = interaction.calls.edits.at(-1);
    assert.equal(panel.embeds[0].toJSON().title, '❌ Deleted Scout Report Removed');
    assert.deepEqual(labels(panel), []);
});

test('Keep & repost posts an exact copy with a credit and no ping, and points the report at the copy', async () => {
    const f = fixture([raw({ attachments_json: JSON.stringify([IMAGE]), message_content: 'TestOpponent @everyone\nGarchomp: Outrage\nZapdos: Roost' })]);
    await f.review.capture(ID); await f.store.markDeleted(ID); await f.review.announce(ID);
    const interaction = buttonInteraction(`scout-deleted:repost:silver:${ID}`);
    await handleScoutDeletionInteraction(interaction, config(f));
    assert.equal(f.state.reposts.length, 1);
    const copy = f.state.reposts[0];
    assert.equal(copy.content, `TestOpponent @everyone\nGarchomp: Outrage\nZapdos: Roost\n-# Scouted by <@${MEMBER}>`);
    assert.deepEqual(copy.allowedMentions, { parse: [] });
    assert.equal(copy.files.length, 1);
    const row = normalizeMessageRow(f.state.rows.get(ID));
    assert.deepEqual([row.is_deleted, f.state.deletions.get(ID).status, f.state.deletions.get(ID).repost_message_id], [false, 'reposted', 'm1']);
    assert.equal(row.source_url, `https://discord.com/channels/1/${CHANNEL}/m1`);
    assert.deepEqual([row.attachments[0].sourceChannelId, row.attachments[0].sourceMessageId], [CHANNEL, 'm1']);
    const panel = interaction.calls.edits.at(-1), [info, preview] = panel.embeds.map(embed => embed.toJSON());
    assert.equal(info.title, '✅ Deleted Scout Report Kept & Reposted');
    assert.match(info.description, /Jump to reposted message/u);
    assert.ok(preview.fields.some(field => field.name === 'Original message'));
    assert.match(preview.image.url, /^attachment:\/\//u);
    assert.deepEqual(labels(panel), []);
    // Pressing it again never posts a second copy.
    await handleScoutDeletionInteraction(buttonInteraction(`scout-deleted:repost:silver:${ID}`), config(f));
    assert.equal(f.state.reposts.length, 1);
});

test('a failed repost keeps the report, says so privately and can be retried; long text moves into an embed', async t => {
    t.mock.method(console, 'warn', () => {});
    const f = fixture([raw({ message_content: `TestOpponent\n${'Garchomp: Outrage, Earthquake\n'.repeat(80)}` })], { failSend: true });
    await f.review.capture(ID); await f.store.markDeleted(ID); await f.review.announce(ID);
    const interaction = buttonInteraction(`scout-deleted:repost:silver:${ID}`);
    await handleScoutDeletionInteraction(interaction, config(f));
    assert.deepEqual([f.state.rows.get(ID).is_deleted, f.state.deletions.get(ID).status], [0, 'kept']);
    assert.match(interaction.calls.followUps[0].content, /could not be reposted/u);
    assert.deepEqual(labels(interaction.calls.edits.at(-1)), ['Repost in scout channel']);
    f.client.channels.cache.get(CHANNEL).send = async payload => { f.state.reposts.push(payload); return { id: 'm9', channelId: CHANNEL, attachments: new Map() }; };
    await handleScoutDeletionInteraction(buttonInteraction(`scout-deleted:repost:silver:${ID}`), config(f));
    assert.equal(f.state.deletions.get(ID).status, 'reposted');
    assert.equal(f.state.reposts[0].content, `-# Scouted by <@${MEMBER}>`);
    assert.ok(f.state.reposts[0].embeds[0].toJSON().description.startsWith('TestOpponent\nGarchomp'));
});

test('Edit opens a page with a Back button; details saved there are published when the report is kept', async () => {
    const f = fixture();
    await f.review.capture(ID); await f.store.markDeleted(ID); await f.review.announce(ID);
    const edit = buttonInteraction(`scout-deleted:edit:silver:${ID}`);
    await handleScoutDeletionInteraction(edit, config(f));
    const page = edit.calls.edits.at(-1);
    assert.equal(page.embeds[0].toJSON().title, '✏️ Edit Deleted Scout Report');
    assert.deepEqual(page.components[0].toJSON().components.map(item => [item.label, item.style, item.emoji?.name]), [
        ['Edit details', ButtonStyle.Primary, undefined], ['Edit message text', ButtonStyle.Primary, undefined],
        ['Edit screenshots', ButtonStyle.Primary, undefined], ['Back', ButtonStyle.Secondary, '⬅️']]);
    // The form opens from the cached page without touching storage.
    const open = buttonInteraction(`scout-deleted:edit-details:silver:${ID}`);
    f.store.getMessage = async () => assert.fail('opening the form must not read the database');
    await handleScoutDeletionInteraction(open, config(f));
    const modal = open.calls.modals[0].toJSON();
    assert.equal(modal.custom_id, `scout-deleted:modal-details:silver:${ID}`);
    assert.equal(modal.components[0].component.value, 'TestOpponent');
    delete f.store.getMessage;
    f.store.getMessage = async id => f.state.rows.has(String(id)) ? normalizeMessageRow(f.state.rows.get(String(id))) : null;
    const values = { ign: 'RealOpponent', rating: '450', team: '- Garchomp: Outrage, Earthquake', notes: 'Leads Garchomp' };
    const submit = { ...buttonInteraction(`scout-deleted:modal-details:silver:${ID}`), isButton: () => false, isModalSubmit: () => true,
        fields: { getTextInputValue: name => values[name] } };
    await handleScoutDeletionInteraction(submit, config(f));
    const row = f.state.rows.get(ID);
    assert.deepEqual([row.opponent_ign, row.rating, row.notes, row.is_deleted, row.review_status], ['RealOpponent', 450, 'Leads Garchomp', 1, 'not_scout']);
    assert.equal(f.state.deletions.get(ID).restore_status, 'corrected');
    assert.match(submit.calls.edits.at(-1).embeds[1].toJSON().title, /RealOpponent \(450\)/u);
    assert.match(submit.calls.followUps[0].content, /Saved/u);
    assert.equal(f.state.audits[0].action, 'edited');
    const back = buttonInteraction(`scout-deleted:back:silver:${ID}`);
    await handleScoutDeletionInteraction(back, config(f));
    assert.deepEqual(labels(back.calls.edits.at(-1)), ['Keep', 'Keep & repost', 'Remove', 'Edit']);
    await handleScoutDeletionInteraction(buttonInteraction(`scout-deleted:keep:silver:${ID}`), config(f));
    assert.deepEqual([row.is_deleted, row.review_status, row.opponent_ign], [0, 'corrected', 'RealOpponent']);
    // An invalid IGN is refused without changing the report; an expired editor asks for a reload.
    const g = fixture();
    await g.review.capture(ID); await g.store.markDeleted(ID);
    const bad = { ...buttonInteraction(`scout-deleted:modal-details:silver:${ID}`), isButton: () => false, isModalSubmit: () => true,
        fields: { getTextInputValue: name => ({ ...values, ign: '!' })[name] } };
    await handleScoutDeletionInteraction(bad, config(g));
    assert.match(bad.calls.followUps[0].content, /valid opponent IGN/u);
    assert.equal(g.state.rows.get(ID).opponent_ign, 'TestOpponent');
    const expired = buttonInteraction(`scout-deleted:edit-details:silver:${ID}`);
    await handleScoutDeletionInteraction(expired, config(g));
    assert.match(expired.calls.replies[0].content, /editor expired/u);
});

test('only staff in the server can use the alert, and unknown controls are left to other handlers', async () => {
    const f = fixture();
    await f.review.capture(ID); await f.store.markDeleted(ID);
    for (const options of [{ staff: false }, { guild: false }]) {
        const denied = buttonInteraction(`scout-deleted:keep:silver:${ID}`, options);
        assert.equal(await handleScoutDeletionInteraction(denied, config(f)), true);
        assert.match(denied.calls.replies[0].content, /Only the guild leader, Admins, or Officers/u);
        assert.equal(f.state.deletions.get(ID).status, 'pending');
    }
    assert.equal(await handleScoutDeletionInteraction(buttonInteraction('scout-deleted:keep:gold:1'), config(f)), false);
    assert.equal(await handleScoutDeletionInteraction(buttonInteraction('scout-deleted:keep:silver:not-an-id'), config(f)), false);
    assert.equal(await handleScoutDeletionInteraction(buttonInteraction(`scout-deleted:unknown:silver:${ID}`), config(f)), false);
    assert.equal(await handleScoutDeletionInteraction(buttonInteraction(`pvp-scout-review:keep:silver:${ID}`), config(f)), false);
});

test('a kept report is not deleted again when a correction check finds its Discord message missing', async () => {
    const f = fixture();
    const ingestor = new PvpScoutIngestor({ client: f.client, store: f.store, server: 'silver', channelId: CHANNEL, officerChannelId: OFFICERS,
        guildId: '1', ocr: {}, feedback: { async remove() {} } });
    ingestor.deletionReview = f.review;
    ingestor.getChannel = async () => ({ messages: { async fetch() { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } } });
    await f.review.capture(ID); await f.store.markDeleted(ID);
    await f.review.store.decide(ID, OFFICER, true);
    await ingestor.recheckCorrection(ID);
    assert.equal(f.state.rows.get(ID).is_deleted, 0);
    await f.store.markDeleted(ID);
    f.state.deletions.get(ID).status = 'removed'; f.state.rows.get(ID).is_deleted = 0;
    await ingestor.recheckCorrection(ID);
    assert.equal(f.state.rows.get(ID).is_deleted, 1);
});

test('a follow-up alert names its report and each decided panel has no decision buttons', () => {
    const row = normalizeMessageRow(raw({ opponent_ign: null, ign_normalized: null, classification: 'ignored', is_deleted: 1, review_status: 'not_scout' }));
    const context = status => ({ row, reportRoot: { message_id: ROOT, opponent_ign: 'TestOpponent', ign_normalized: 'testopponent' },
        view: { ...row, is_deleted: false, review_status: 'not_required', opponent_ign: 'TestOpponent', ign_normalized: 'testopponent' },
        deletion: { message_id: ID, report_id: ROOT, status, restore_status: 'not_required', deleted_by_id: OFFICER, decided_by_id: OFFICER, images: [] } });
    const pending = deletionPayload(context('pending'), { server: 'gold' }), info = pending.embeds[0].toJSON();
    assert.match(info.description, new RegExp(`\\*\\*Deleted by:\\*\\* <@${OFFICER}> \\(moderator\\)`, 'u'));
    assert.match(info.description, /\*\*Server:\*\* <:gold:\d+> Gold/u);
    assert.match(info.description, new RegExp(`Scout Report ID:\\*\\* \`${ROOT}\`\\n\\*\\*Scout Message ID:\\*\\* \`${ID}\``, 'u'));
    assert.match(info.description, /follow-up to the report for \*\*TestOpponent\*\*/u);
    assert.match(pending.embeds[1].toJSON().footer.text, new RegExp(`Scout Message ID: ${ID}$`, 'u'));
    for (const status of ['removed', 'reposted']) assert.deepEqual(labels(deletionPayload(context(status), { server: 'gold' })), []);
    // The edit page exists only while the report awaits a decision.
    assert.equal(deletionPayload(context('kept'), { server: 'gold', page: 'edit' }).embeds[0].toJSON().title, '✅ Deleted Scout Report Kept');
});
