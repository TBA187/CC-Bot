'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const giveaways = require('../events/giveaways');
const Giveaways = require('../commands/giveaways');

const copy = value => structuredClone(value);
const winnerIds = count => Array.from({ length: count }, (_, index) => String(10000000000000000000n + BigInt(index)));
const controls = payload => (payload.components || []).flatMap(row => row.toJSON().components);
const mentions = payload => [...payload.embeds[0].toJSON().description.matchAll(/<@(\d+)>/g)].map(match => match[1]);
const legacyButton = draw => `cc_giveaway:winners:${draw.giveaway_id}:${crypto.createHash('sha256').update(draw.draw_id).digest('hex').slice(0, 16)}`;

function fixture({ count = 100, entries = count } = {}) {
    const initial = {
        giveaway_id: giveaways.makeGiveawayId(), guild_id: '100000000000000000', channel_id: '200000000000000000',
        message_id: null, status: 'active', winners_total: count, prize: 'P'.repeat(512),
        host_text: 'H'.repeat(256), winner_user_ids: [],
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        ends_at: new Date(Date.now() - 60000).toISOString()
    };
    let current = copy(initial);
    const draws = [];
    const participants = winnerIds(entries).map(user_id => ({ user_id, joined_at: initial.starts_at, left_at: null }));
    const store = {
        async getGiveaway(id) { assert.equal(id, initial.giveaway_id); return copy(current); },
        async listEntries() { return copy(participants); },
        async listDraws() { return copy(draws); },
        async saveDraw(id, draw) { assert.equal(id, draw.draw_id); draws.push(copy(draw)); return copy(draw); },
        async updateGiveaway(id, changes) { assert.equal(id, initial.giveaway_id); current = { ...current, ...changes }; return copy(current); }
    };
    const sent = [];
    const channel = { messages: { async fetch() { throw new Error('Message not available in offline fixture'); } }, async send(payload) {
        sent.push(payload);
        return { id: `announcement-${sent.length}` };
    } };
    const client = { channels: { cache: { get: () => channel }, fetch: async () => channel } };
    return { initial, store, draws, sent, client, channel, participants,
        end: options => giveaways.endGiveaway(client, { giveawayStore: store }, initial, { drawType: 'end', ...options }) };
}

function click(customId, options = {}) {
    const replies = [], edits = [], updates = [], order = [];
    const interaction = {
        customId, user: { id: 'viewer' }, guildId: '100000000000000000',
        async deferReply(payload) { order.push('defer'); replies.push(payload); },
        async editReply(payload) { order.push('edit'); edits.push(payload); },
        async reply(payload) { replies.push(payload); },
        async update(payload) { updates.push(payload); },
        ...options
    };
    return { interaction, replies, edits, updates, order };
}

function assertPayloadLimits(payload) {
    assert.ok((payload.content || '').length <= 2000);
    for (const embed of payload.embeds || []) {
        const json = embed.toJSON();
        assert.ok((json.title || '').length <= 256);
        assert.ok((json.description || '').length <= 4096);
        assert.ok((json.fields || []).length <= 25);
        for (const field of json.fields || []) {
            assert.ok(field.name.length <= 256);
            assert.ok(field.value.length <= 1024);
        }
        assert.ok(embed.length <= 6000);
    }
    for (const control of controls(payload)) assert.ok(control.custom_id.length <= 100);
}

test('create, edit, and reroll allow up to 500 winners and reject more', () => {
    const command = new Giveaways({ giveawayStore: {} });
    for (const name of ['create', 'edit', 'reroll']) {
        const subcommand = command.data.toJSON().options.find(option => option.name === name);
        const winners = subcommand.options.find(option => option.name === 'winners');
        assert.equal(winners.max_value, 500);
        assert.match(winners.description, /500/);
    }
    assert.equal(giveaways.validateWinnerCount(500), 500);
    assert.throws(() => giveaways.validateWinnerCount(501), /500/);
});

test('other giveaway pagination keeps its existing button appearance', async () => {
    let response;
    await giveaways.sendEmbedFollowUp({ user: { id: 'viewer' }, async editReply(payload) { response = payload; } },
        [new EmbedBuilder().setTitle('First'), new EmbedBuilder().setTitle('Second')]);
    assert.equal(controls(response)[0].emoji, undefined);
    assert.equal(controls(response)[1].emoji, undefined);
});

async function originalMessage(store, giveawayId, api = giveaways) {
    const record = await store.getGiveaway(giveawayId);
    let payload;
    await api.replyWithGiveawayMessage({
        async reply(result) { payload = result; },
        async fetchReply() { return { id: record.message_id }; }
    }, record, { giveawayStore: store });
    return payload;
}

test('Host and Prize appear in the description above plain-valued active giveaway fields', () => {
    const f = fixture({ count: 20 });
    const embed = giveaways.buildGiveawayEmbed({ ...f.initial, description: 'Additional giveaway details.' }, { participantCount: 50 }).toJSON();
    assert.equal(embed.description, `<:man_of_culture:1186287184106496112>\u2002**Host:** @${f.initial.host_text}\n`
        + `🎁\u2002**Prize:** ${f.initial.prize}\n**Description:**\nAdditional giveaway details.`);
    assert.deepEqual(embed.fields.map(field => [field.name, field.inline]), [
        ['🏆 Winners', true], ['👥 Participants', true], ['⏳ Ends', true]
    ]);
    assert.equal(embed.fields[0].value, '20');
    assert.equal(embed.fields[1].value, '50');
    assert.ok(embed.fields.every(field => !field.value.startsWith('- ') && !field.value.includes('**')));
    for (const host of ['<@123456789012345678>', '<@&123456789012345678>', '@Crow Control Team']) {
        const description = giveaways.buildGiveawayEmbed({ ...f.initial, host_text: host }).toJSON().description;
        assert.ok(description.startsWith(`<:man_of_culture:1186287184106496112>\u2002**Host:** ${host}\n`));
    }
});

test('ended giveaway fields remove the inline count and keep a full-width counted winner list with selective summary bolding', () => {
    for (const count of [1, 20, 25, 26, 100]) {
        const f = fixture({ count });
        const embed = giveaways.buildGiveawayEmbed({ ...f.initial, status: 'ended', ended_at: f.initial.ends_at,
            winner_user_ids: winnerIds(count), required_role_id: '300000000000000000' }, { participantCount: count }).toJSON();
        assert.deepEqual(embed.fields.slice(0, 3).map(field => [field.name, field.inline]), [
            ['👥 Participants', true], ['❌ Giveaway ended!', true], [`🏆 Winners (${count})`, false]
        ]);
        assert.ok(embed.fields.every(field => field.name !== '🏆 Winners' && !field.value.startsWith('- ')));
        assert.equal(embed.fields[0].value, String(count));
        assert.ok(!embed.fields[1].value.includes('**'));
        assert.ok(!embed.fields.at(-1).value.includes('**'));
        const winners = embed.fields[2];
        if (count > 25) {
            assert.equal(winners.value, `**${count} winners!**`);
        } else {
            assert.equal(winners.value, winnerIds(count).map(id => `<@${id}>`).join(', '));
        }
        assertPayloadLimits({ embeds: [giveaways.buildGiveawayEmbed({ ...f.initial, status: 'ended', winner_user_ids: winnerIds(count) })] });
    }
});

test('end and reroll announcements include the prize and identify every notified winner', async () => {
    for (const count of [1, 20, 100]) {
        const f = fixture({ count, entries: count * 2 });
        await f.end();
        await f.end({ drawType: 'reroll' });
        for (const announcement of f.sent) {
            if (count > 20) {
                assert.ok(announcement.allowedMentions.users.length > 0);
                assert.doesNotMatch(announcement.content, /\*\*Winners \d+|\(continued\)/);
                assert.deepEqual(controls(announcement), []);
            } else {
                assert.match(announcement.content, /- \*\*Congratulations\*\* [^\n]+!\nYou won \*\*/);
                assert.ok(announcement.content.endsWith(`You won **${f.initial.prize}  <:man_of_culture:1186287184106496112>**`));
            }
        }
    }
});

test('original ended giveaways show View Winners only above 25 winners', async () => {
    for (const count of [0, 1, 20, 25, 26, 100]) {
        const f = fixture({ count });
        await f.end();
        await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
        const payload = await originalMessage(f.store, f.initial.giveaway_id);
        const buttons = controls(payload);
        assert.equal(buttons[0].custom_id, 'cc_giveaway:participants');
        assert.equal(buttons[0].style, ButtonStyle.Primary);
        assert.equal(buttons.length, count > 25 ? 2 : 1);
        if (count > 25) {
            assert.equal(buttons[1].label, 'View Winners');
            assert.equal(buttons[1].emoji.name, '🏆');
            assert.equal(buttons[1].style, ButtonStyle.Success);
            assert.equal(buttons[1].custom_id, legacyButton(f.draws[0]));
            const viewer = click(buttons[1].custom_id);
            await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
            assert.deepEqual(mentions(viewer.edits[0]), f.draws[0].winner_user_ids.slice(0, 50));
        }
    }
});

test('the original giveaway follows the latest reroll while its older announcement keeps the original saved result', async () => {
    const f = fixture({ count: 26, entries: 52 });
    await f.end();
    const firstId = legacyButton(f.draws[0]);
    await f.end({ drawType: 'reroll' });
    await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
    const currentId = legacyButton(f.draws[1]);
    const payload = await originalMessage(f.store, f.initial.giveaway_id);
    assert.equal(controls(payload)[1].custom_id, currentId);
    assert.notEqual(currentId, firstId);
    for (const [customId, draw] of [[firstId, f.draws[0]], [currentId, f.draws[1]]]) {
        const viewer = click(customId, { message: { id: customId === currentId ? '400000000000000000' : '500000000000000000' } });
        await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
        assert.deepEqual(mentions(viewer.edits[0]), draw.winner_user_ids.slice(0, 50));
    }
    const oldOriginal = click(firstId, { message: { id: '400000000000000000' } });
    await giveaways.handleGiveawayButton(oldOriginal.interaction, { giveawayStore: f.store });
    assert.deepEqual(mentions(oldOriginal.edits[0]), f.draws[1].winner_user_ids.slice(0, 50));
});

for (const originalMessage of [true, false]) {
    test(`${originalMessage ? 'original' : 'historical'} winner buttons resolve the correct saved draw when a reroll completes during lookup`, async t => {
        const f = fixture({ count: 21, entries: 63 });
        await f.end();
        await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
        const viewer = click(legacyButton(f.draws[0]), {
            message: { id: originalMessage ? '400000000000000000' : '500000000000000000' }
        });
        const loading = Promise.withResolvers(), release = Promise.withResolvers();
        t.after(() => release.resolve());
        let reads = 0;
        const store = { ...f.store,
            async listDraws() {
                assert.deepEqual(viewer.replies, [{ flags: MessageFlags.Ephemeral }]);
                const snapshot = await f.store.listDraws();
                if (++reads === 1) {
                    loading.resolve();
                    await release.promise;
                }
                return snapshot;
            },
            async saveDraw() { assert.fail('Viewing winners must not create a draw'); },
            async updateGiveaway() { assert.fail('Viewing winners must not change the giveaway'); }
        };
        const pending = giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: store });
        await loading.promise;
        await f.end({ drawType: 'reroll' });
        release.resolve();
        await pending;
        const expected = f.draws[originalMessage ? 1 : 0];
        assert.deepEqual(mentions(viewer.edits[0]), expected.winner_user_ids.slice(0, 50));
        assert.equal(reads, originalMessage ? 2 : 1);
        assert.deepEqual(viewer.edits[0].allowedMentions, { parse: [] });
        assertPayloadLimits(viewer.edits[0]);
    });
}

test('an original-message lookup stops after bounded retries when each read races another reroll', async () => {
    const f = fixture({ count: 21, entries: 105 });
    await f.end();
    await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
    let reads = 0;
    const store = { ...f.store,
        async listDraws() {
            assert.ok(++reads <= 3, 'Draw lookup must not retry indefinitely');
            const snapshot = await f.store.listDraws();
            await f.end({ drawType: 'reroll' });
            return snapshot;
        },
        async saveDraw() { assert.fail('A lookup must not draw new winners'); }
    };
    const viewer = click(legacyButton(f.draws[0]), { message: { id: '400000000000000000' } });
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: store });
    assert.equal(reads, 3);
    assert.match(viewer.edits[0], /winner list couldn’t be loaded.*try again/);
    assert.equal(f.draws.length, 4);
});

test('an original-message button never substitutes an older saved draw when the current reroll is missing', async () => {
    const f = fixture({ count: 21, entries: 42 });
    await f.end();
    await f.end({ drawType: 'reroll' });
    await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
    const store = { ...f.store, async listDraws() { return [copy(f.draws[0])]; } };
    const viewer = click(legacyButton(f.draws[0]), { message: { id: '400000000000000000' } });
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: store });
    assert.deepEqual(viewer.edits, ['The winner list couldn’t be loaded. Please try again.']);
});

test('participant pages mark the current reroll after slow entry reads across all 250 participants', async t => {
    const f = fixture({ count: 100, entries: 250 });
    const [ended] = await f.end();
    const viewer = click('cc_giveaway:participants', { message: { id: '400000000000000000' } });
    const loading = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const store = { ...f.store,
        async getByMessageId() { return [ended.giveaway_id, copy(ended)]; },
        async listEntries(id, options) {
            assert.deepEqual(viewer.replies, [{ flags: MessageFlags.Ephemeral }]);
            assert.equal(id, ended.giveaway_id);
            assert.deepEqual(options, { activeOnly: true });
            const entries = await f.store.listEntries();
            loading.resolve();
            await release.promise;
            return entries;
        }
    };
    const pending = giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: store });
    await loading.promise;
    const [, selected] = await f.end({ drawType: 'reroll' });
    release.resolve();
    await pending;
    let page = viewer.edits[0];
    const rows = [];
    for (;;) {
        assertPayloadLimits(page);
        rows.push(...[...page.embeds[0].toJSON().description.matchAll(/^\*\*(\d+)\.\*\* <@(\d+)>( 🏆)? - Joined: (.+)$/gm)]
            .map(match => ({ number: Number(match[1]), id: match[2], trophy: Boolean(match[3]), joined: match[4] })));
        const next = controls(page).find(button => button.label === 'Next');
        if (!next || next.disabled) break;
        const navigation = click(next.custom_id);
        await giveaways.handleGiveawayButton(navigation.interaction, {});
        page = navigation.updates[0];
    }
    assert.equal(rows.length, 250);
    assert.deepEqual(rows.map(row => row.number), Array.from({ length: 250 }, (_, index) => index + 1));
    assert.equal(new Set(rows.map(row => row.id)).size, 250);
    assert.deepEqual(rows.filter(row => row.trophy).map(row => row.id).sort(), [...selected].sort());
    const joinedAt = Math.floor(Date.parse(f.initial.starts_at) / 1000);
    assert.ok(rows.every(row => row.joined === `<t:${joinedAt}:F> (<t:${joinedAt}:R>)`));
});

test('active participant lists have no winner trophies and ended lists follow the latest reroll', async () => {
    const f = fixture({ count: 1, entries: 50 });
    const viewer = click('cc_giveaway:participants');
    await f.store.updateGiveaway(f.initial.giveaway_id, { winner_user_ids: [f.participants[0].user_id] });
    await giveaways.sendParticipantEmbeds(viewer.interaction, { giveawayStore: f.store }, {
        ...f.initial, winner_user_ids: [f.participants[0].user_id]
    });
    assert.doesNotMatch(viewer.edits[0].embeds[0].toJSON().description, /🏆/);
    const [ended, initialWinners] = await f.end();
    const [rerolled, latestWinners] = await f.end({ drawType: 'reroll' });
    assert.notDeepEqual(initialWinners, latestWinners);
    const seen = [];
    const updated = click('cc_giveaway:participants');
    await giveaways.sendParticipantEmbeds(updated.interaction, { giveawayStore: f.store }, rerolled);
    let page = updated.edits[0];
    for (;;) {
        seen.push(...[...page.embeds[0].toJSON().description.matchAll(/<@(\d+)> 🏆/g)].map(match => match[1]));
        const next = controls(page).find(button => button.label === 'Next');
        if (!next || next.disabled) break;
        const navigation = click(next.custom_id);
        await giveaways.handleGiveawayButton(navigation.interaction, {});
        page = navigation.updates[0];
    }
    assert.deepEqual(seen, latestWinners);
    assert.equal(ended.status, 'ended');
});

test('participant lookup reports a removed giveaway instead of using its stale winner snapshot', async () => {
    const f = fixture({ count: 1 });
    const [ended] = await f.end();
    const viewer = click('cc_giveaway:participants');
    const store = { ...f.store, async getGiveaway() { return null; } };
    await giveaways.sendParticipantEmbeds(viewer.interaction, { giveawayStore: store }, ended);
    assert.deepEqual(viewer.edits, ['That giveaway could not be found.']);
});

test('zero-participant endings show plain zero totals, no winner field and no winner button', async () => {
    const f = fixture({ count: 1, entries: 0 });
    const [ended, selected] = await f.end();
    assert.deepEqual(selected, []);
    const payload = await originalMessage(f.store, f.initial.giveaway_id);
    assert.deepEqual(payload.embeds[0].toJSON().fields.map(field => field.name), ['👥 Participants', '❌ Giveaway ended!']);
    assert.equal(payload.embeds[0].toJSON().fields[0].value, '0');
    assert.equal(controls(payload).length, 1);
    assert.equal(controls(payload)[0].style, ButtonStyle.Primary);
    const viewer = click('cc_giveaway:participants');
    await giveaways.sendParticipantEmbeds(viewer.interaction, { giveawayStore: f.store }, ended);
    assert.equal(viewer.edits[0].embeds[0].toJSON().description, 'No active participants found.');
});

test('100 winners are all pinged in bounded announcements and shown in two complete private pages', async () => {
    const f = fixture();
    const [ended, selected] = await f.end();
    assert.equal(f.sent.length, 2);
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.draws.length, 1);
    const publicPayload = f.sent[0];
    assertPayloadLimits(publicPayload);
    assert.match(publicPayload.content, /100 winners/);
    assert.deepEqual(f.sent.flatMap(payload => payload.allowedMentions.users), selected);
    assert.ok(f.sent.every(payload => payload.content.length <= 2000 && payload.allowedMentions.parse.length === 0));
    assert.deepEqual(controls(publicPayload), []);
    const firstCount = publicPayload.allowedMentions.users.length;
    assert.ok(firstCount > 50);
    assert.ok(publicPayload.content.endsWith(`<@${selected[firstCount - 1]}>,`));
    assert.ok(f.sent[1].content.startsWith(`<@${selected[firstCount]}>`));
    assert.ok(f.sent[1].content.endsWith(`<@${selected[99]}>`));
    assert.doesNotMatch(f.sent[1].content, /\(continued\)|Winners 51/);

    assertPayloadLimits({ embeds: [giveaways.buildGiveawayEmbed(ended)] });
    for (const action of ['Ended', 'Rerolled']) {
        const summary = giveaways.drawSummary(action, ended, selected);
        assert.ok(summary.length <= 2000);
        assert.match(summary, /100 selected/);
        assert.doesNotMatch(summary, /<@\d+>/);
    }

    const viewer = click(legacyButton(f.draws[0]));
    const orderedStore = { ...f.store,
        async getGiveaway(id) { assert.deepEqual(viewer.order, ['defer']); return f.store.getGiveaway(id); }
    };
    assert.equal(await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: orderedStore }), true);
    assert.deepEqual(viewer.replies, [{ flags: MessageFlags.Ephemeral }]);
    let page = viewer.edits[0];
    const shown = [];
    for (let index = 0; index < 2; index++) {
        assertPayloadLimits(page);
        assert.deepEqual(page.allowedMentions, { parse: [] });
        assert.equal(mentions(page).length, 50);
        assert.ok(page.embeds[0].toJSON().description.startsWith(`**${index * 50 + 1}.** <@`));
        assert.equal(page.embeds[0].toJSON().title, `Giveaway Winners (100) — Page ${index + 1}/2`);
        assert.equal(page.embeds[0].toJSON().footer.text, `Page ${index + 1}/2 • 100 winners`);
        assert.equal(controls(page)[0].disabled, index === 0);
        assert.equal(controls(page)[1].disabled, index === 1);
        shown.push(...mentions(page));
        if (index < 1) {
            const next = click(controls(page)[1].custom_id);
            await giveaways.handleGiveawayButton(next.interaction, {});
            page = next.updates[0];
        }
    }
    assert.deepEqual(shown, selected);
    assert.equal(new Set(shown).size, 100);
    const previous = click(controls(page)[0].custom_id);
    await giveaways.handleGiveawayButton(previous.interaction, {});
    assert.deepEqual(mentions(previous.updates[0]), selected.slice(0, 50));
});

test('25 winners keep the inline congratulations; 26 winners are all pinged', async () => {
    for (const count of [25, 26]) {
        const f = fixture({ count });
        const [ended, selected] = await f.end();
        const payload = f.sent[0];
        assertPayloadLimits(payload);
        assertPayloadLimits({ embeds: [giveaways.buildGiveawayEmbed(ended)] });
        if (count === 25) {
            assert.equal(payload.content, `### 🎉  Giveaway ended!\n- **Congratulations** ${selected.map(id => `<@${id}>`).join(', ')}!\nYou won **${f.initial.prize}  <:man_of_culture:1186287184106496112>**`);
            assert.deepEqual(payload.allowedMentions, { parse: [], users: selected, roles: [], repliedUser: false });
            assert.deepEqual(controls(payload), []);
            assert.match(giveaways.drawSummary('Ended', ended, selected), new RegExp(`<@${selected[0]}>`));
        } else {
            assert.deepEqual(controls(payload), []);
            assert.deepEqual(payload.allowedMentions.users, selected);
            assert.doesNotMatch(payload.content, /View Winners/);
        }
    }
});

test('large winner announcements continue as one comma-separated list within Discord limits', () => {
    for (const count of [26, 50, 51, 100, 250, 500]) {
        const f = fixture({ count });
        for (const drawType of ['end', 'reroll']) {
            const ids = winnerIds(count);
            const parts = giveaways.winnerAnnouncementParts(f.initial, ids, { drawType });
            assert.deepEqual(parts.flatMap(part => part.allowedMentions.users), ids);
            for (const [index, part] of parts.entries()) {
                assertPayloadLimits(part);
                assert.deepEqual(controls(part), []);
                assert.equal(part.content.endsWith(','), index + 1 < parts.length);
                assert.doesNotMatch(part.content, /\*\*Winners \d+|\(continued\)/);
                if (index > 0) assert.ok(part.content.startsWith(`<@${part.allowedMentions.users[0]}>`));
            }
        }
    }
});

test('250 winners use one private five-page view with complete mentions and a dynamic giveaway link', async () => {
    const f = fixture({ count: 250, entries: 1256 });
    const [ended, selected] = await f.end();
    await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
    const original = await originalMessage(f.store, f.initial.giveaway_id);
    const viewer = click(controls(original)[1].custom_id, { message: { id: '400000000000000000' } });
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    assert.deepEqual(viewer.replies, [{ flags: MessageFlags.Ephemeral }]);
    const shown = [];
    let page = viewer.edits[0];
    for (let index = 0; index < 5; index++) {
        assertPayloadLimits(page);
        const embed = page.embeds[0].toJSON();
        assert.equal(embed.title, `Giveaway Winners (250) — Page ${index + 1}/5`);
        assert.deepEqual(embed.fields.slice(0, 2).map(field => [field.name, field.inline]), [['Prize', true], ['Giveaway', true]]);
        assert.equal(embed.fields[1].value, '[Jump to Giveaway](https://discord.com/channels/100000000000000000/200000000000000000/400000000000000000)');
        assert.equal(controls(page)[0].emoji.name, '◀️');
        assert.equal(controls(page)[1].emoji.name, '▶️');
        assert.equal(mentions(page).length, 50);
        shown.push(...mentions(page));
        if (index < 4) {
            const next = click(controls(page)[1].custom_id);
            await giveaways.handleGiveawayButton(next.interaction, {});
            page = next.updates[0];
        }
    }
    assert.deepEqual(shown, selected);
    assert.equal(ended.winner_user_ids.length, 250);
});

test('long mention tokens move intact to the next page or announcement instead of being cut', async () => {
    const ids = Array.from({ length: 60 }, (_, index) => String(index + 1).padStart(3, '0') + '8'.repeat(180));
    const giveaway = { giveaway_id: 'long-mentions', guild_id: '100000000000000000', status: 'ended', prize: 'Prize', winner_user_ids: ids };
    const draw = { giveaway_id: giveaway.giveaway_id, draw_id: 'long-mentions:end', draw_type: 'end', winner_user_ids: ids };
    const store = { async getGiveaway() { return giveaway; }, async listDraws() { return [draw]; } };
    const viewer = click(legacyButton(draw));
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: store });
    let page = viewer.edits[0];
    const shown = [];
    for (;;) {
        assertPayloadLimits(page);
        shown.push(...mentions(page));
        if (controls(page)[1].disabled) break;
        const next = click(controls(page)[1].custom_id);
        await giveaways.handleGiveawayButton(next.interaction, {});
        page = next.updates[0];
    }
    assert.deepEqual(shown, ids);
    const parts = giveaways.winnerAnnouncementParts(giveaway, ids, { drawType: 'end' });
    assert.ok(parts.length > 1);
    assert.deepEqual(parts.flatMap(part => [...part.content.matchAll(/<@(\d+)>/g)].map(match => match[1])), ids);
    assert.ok(parts.every(part => part.content.length <= 2000 && part.allowedMentions.users.length <= 100));
});

test('the first winner announcement replies to the giveaway and subsequent batches do not', async () => {
    for (const count of [25, 250, 500]) {
        const f = fixture({ count });
        const calls = [];
        const source = { id: '400000000000000000', channelId: f.initial.channel_id,
            async reply(payload) { calls.push({ kind: 'reply', payload }); return { id: 'reply-1' }; }, async edit() {} };
        f.channel.messages.fetch = async target => typeof target === 'object' ? [] : source;
        f.channel.send = async payload => { calls.push({ kind: 'send', payload }); return { id: `send-${calls.length}` }; };
        await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: source.id });
        const [, selected] = await f.end();
        assert.equal(calls[0].kind, 'reply');
        assert.ok(calls.slice(1).every(call => call.kind === 'send'));
        assert.equal(calls[0].payload.allowedMentions.repliedUser, false);
        assert.deepEqual(calls.flatMap(call => call.payload.allowedMentions.users), selected);
        assert.equal(new Set(selected).size, count);
        assert.ok(calls.every(call => call.payload.content.length <= 2000 && call.payload.allowedMentions.users.length <= 100));
    }
});

test('the actual winner count determines pagination and empty draws keep their existing message', async () => {
    for (const count of [0, 1, 20]) {
        const f = fixture({ count: 100, entries: count });
        const [, selected] = await f.end();
        assert.equal(selected.length, count);
        assert.deepEqual(controls(f.sent[0]), []);
        assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: selected, roles: [], repliedUser: false });
        if (!count) assert.match(f.sent[0].content, /Nobody joined this giveaway/);
    }
});

test('only the viewer who opened a private winner list can change its page', async () => {
    const f = fixture({ count: 51 });
    await f.end();
    const viewer = click(legacyButton(f.draws[0]));
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    const nextId = controls(viewer.edits[0])[1].custom_id;
    const stranger = click(nextId, { user: { id: 'someone-else' } });
    await giveaways.handleGiveawayButton(stranger.interaction, {});
    assert.deepEqual(stranger.updates, []);
    assert.equal(stranger.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(stranger.replies[0].content, /Only the command user/);
    const next = click(nextId);
    await giveaways.handleGiveawayButton(next.interaction, {});
    assert.deepEqual(mentions(next.updates[0]), f.draws[0].winner_user_ids.slice(50));
});

test('expired private winner pages can be reopened from the unchanged public button', async t => {
    const f = fixture({ count: 51 });
    await f.end();
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const publicId = legacyButton(f.draws[0]);
    const viewer = click(publicId);
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    const privateId = controls(viewer.edits[0])[1].custom_id;
    now += 5 * 60 * 1000 + 1;
    const expired = click(privateId);
    await giveaways.handleGiveawayButton(expired.interaction, {});
    assert.match(expired.replies[0].content, /expired.*original button/);
    assert.deepEqual(expired.updates, []);
    const reopened = click(publicId);
    await giveaways.handleGiveawayButton(reopened.interaction, { giveawayStore: f.store });
    assert.deepEqual(mentions(reopened.edits[0]), f.draws[0].winner_user_ids.slice(0, 50));
    assert.notEqual(controls(reopened.edits[0])[1].custom_id, privateId);
});

test('end and historical reroll buttons resolve their saved draws after a store and process-state restart', async t => {
    const f = fixture({ count: 51, entries: 153 });
    await f.end();
    await f.end({ drawType: 'reroll' });
    await f.end({ drawType: 'reroll' });
    assert.equal(f.sent.length, 3);
    assert.equal(f.draws.length, 3);
    assert.equal(new Set(f.draws.map(legacyButton)).size, 3);
    assert.equal(new Set(f.draws.flatMap(draw => draw.winner_user_ids)).size, 153);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-winner-history-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const storeOptions = { storageMode: 'json', dataFile: path.join(directory, 'giveaways.json'),
        db: { async query() { assert.fail('Winner history must not query MySQL'); } } };
    const persisted = giveaways.createGiveawayStore(storeOptions);
    await f.store.updateGiveaway(f.initial.giveaway_id, { message_id: '400000000000000000' });
    persisted.localSaveGiveaway(f.initial.giveaway_id, await f.store.getGiveaway(f.initial.giveaway_id), false);
    for (const draw of f.draws) persisted.localSaveDraw(draw.draw_id, draw, false);
    const viewer = click(legacyButton(f.draws[0]));
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: persisted });

    const modulePath = require.resolve('../events/giveaways');
    delete require.cache[modulePath];
    const restarted = require('../events/giveaways');
    const restored = restarted.createGiveawayStore(storeOptions);
    await restored.restore();
    const oldPrivatePage = click(controls(viewer.edits[0])[1].custom_id);
    await restarted.handleGiveawayButton(oldPrivatePage.interaction, {});
    assert.match(oldPrivatePage.replies[0].content, /expired/);
    for (const [index] of f.sent.entries()) {
        const reopened = click(legacyButton(f.draws[index]), { message: { id: `announcement-${index + 1}` } });
        await restarted.handleGiveawayButton(reopened.interaction, { giveawayStore: restored });
        assert.deepEqual(mentions(reopened.edits[0]), f.draws[index].winner_user_ids.slice(0, 50));
        const last = click(controls(reopened.edits[0])[1].custom_id);
        await restarted.handleGiveawayButton(last.interaction, {});
        assert.deepEqual(mentions(last.updates[0]), f.draws[index].winner_user_ids.slice(50));
        assert.equal(reopened.edits[0].embeds[0].toJSON().title, `${index ? 'Rerolled Winners' : 'Giveaway Winners'} (51) — Page 1/2`);
    }
    const original = click(legacyButton(f.draws[0]), { message: { id: '400000000000000000' } });
    await restarted.handleGiveawayButton(original.interaction, { giveawayStore: restored });
    assert.deepEqual(mentions(original.edits[0]), f.draws.at(-1).winner_user_ids.slice(0, 50));
});

test('missing draws and cross-guild winner buttons never substitute the latest winners', async () => {
    const f = fixture({ count: 21 });
    await f.end();
    const publicId = legacyButton(f.draws[0]);
    let drawReads = 0;
    const store = { ...f.store, async listDraws() { drawReads++; return []; } };
    const outside = click(publicId, { guildId: 'another-guild' });
    await giveaways.handleGiveawayButton(outside.interaction, { giveawayStore: store });
    assert.equal(drawReads, 0);
    assert.deepEqual(outside.edits, ['That giveaway could not be found.']);
    const missing = click(publicId);
    await giveaways.handleGiveawayButton(missing.interaction, { giveawayStore: store });
    assert.equal(drawReads, 1);
    assert.match(missing.edits[0], /winner list couldn’t be loaded/);
});

test('failed acknowledgement of a winner click stops before accessing storage', async () => {
    const f = fixture({ count: 21 });
    await f.end();
    const viewer = click(legacyButton(f.draws[0]), {
        async deferReply() { throw new Error('Interaction expired'); }
    });
    await assert.rejects(giveaways.handleGiveawayButton(viewer.interaction, {
        giveawayStore: { async getGiveaway() { assert.fail('No read before acknowledgement'); } }
    }), /Interaction expired/);
});

test('manual end and reroll deliver all winner pings without a winner button', async () => {
    const f = fixture({ entries: 200 });
    const config = { giveawayStore: f.store, officerRoleID: 'officer' };
    const command = new Giveaways(config);
    for (const action of ['end', 'reroll']) {
        const publicReplies = [], privateReplies = [];
        const interaction = {
            client: f.client, user: { id: 'staff', username: 'Officer' },
            member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
            options: { getString: () => f.initial.giveaway_id, getInteger: () => 100 },
            async deferReply() { this.deferred = true; },
            async editReply(payload) { this.replied = true; publicReplies.push(payload); return { id: `${action}-reply` }; },
            async followUp(payload) { privateReplies.push(payload); }
        };
        await command[action](interaction);
        assert.equal(publicReplies.length, 1);
        assert.match(typeof publicReplies[0] === 'string' ? publicReplies[0] : publicReplies[0].content, /100 selected/);
        assert.equal(privateReplies.length, 0);
    }
    assert.equal(f.sent.length, 4);
    for (const offset of [0, 2]) {
        assert.deepEqual(controls(f.sent[offset]), []);
        assert.equal(f.sent.slice(offset, offset + 2).flatMap(payload => payload.allowedMentions.users).length, 100);
    }
});

test('manual draw confirmations stay private and do not ping winners again', async () => {
    const f = fixture({ count: 25, entries: 50 });
    const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
    for (const action of ['end', 'reroll']) {
        let deferral, summary;
        const interaction = { client: f.client, user: { id: 'staff', username: 'Officer' },
            member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
            options: { getString: () => f.initial.giveaway_id, getInteger: () => 25 },
            async deferReply(options) { deferral = options; this.deferred = true; },
            async editReply(payload) { summary = payload; return { id: 'private-summary' }; } };
        await command[action](interaction);
        assert.equal(deferral.flags, MessageFlags.Ephemeral);
        assert.deepEqual(summary.allowedMentions, { parse: [] });
        assert.match(summary.content, /<@\d+>/);
    }
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0].allowedMentions.users.length, 25);
    assert.equal(f.sent[1].allowedMentions.users.length, 25);
});

test('a failed reroll announcement leaves its saved draw pending for recovery', async () => {
    const f = fixture({ count: 20, entries: 40 });
    await f.end();
    f.channel.send = async () => { throw new Error('Discord unavailable'); };
    const command = new Giveaways({ giveawayStore: f.store, officerRoleID: 'officer' });
    const attempts = [];
    const interaction = {
        client: f.client, user: { id: 'staff', username: 'Officer' },
        member: { roles: { cache: { some: predicate => predicate({ id: 'officer' }) } } },
        options: { getString: () => f.initial.giveaway_id, getInteger: () => 20 },
        async deferReply() { this.deferred = true; },
        async editReply(payload) {
            attempts.push(payload);
            this.replied = true;
            return { id: 'recovered-reroll-reply' };
        },
        async followUp() { assert.fail('Pending delivery must finish the existing private response'); }
    };
    await command.reroll(interaction);
    assert.equal(attempts.length, 1);
    assert.equal(f.draws.length, 2);
    assert.equal(f.sent.length, 1);
    assert.match(attempts[0], /Winner notifications are pending/);
    assert.equal((await f.store.getGiveaway(f.initial.giveaway_id)).reroll_announcement.draw_id, f.draws[1].draw_id);
});

test('a large recovered legacy end uses its saved draw ID even if pending metadata lacks end_draw_id', async () => {
    const f = fixture({ count: 21 });
    await f.store.updateGiveaway(f.initial.giveaway_id, { status: 'ended', end_announcement_pending: true,
        winner_user_ids: winnerIds(21), ended_at: f.initial.ends_at });
    const saved = { draw_id: `${f.initial.giveaway_id}:end:legacy`, giveaway_id: f.initial.giveaway_id,
        draw_type: 'end', drawn_at: f.initial.ends_at, winner_user_ids: winnerIds(21) };
    await f.store.saveDraw(saved.draw_id, saved);
    const [ended] = await f.end();
    assert.equal(ended.end_announcement_pending, false);
    assert.equal(f.draws.length, 1);
    const viewer = click(legacyButton(saved));
    await giveaways.handleGiveawayButton(viewer.interaction, { giveawayStore: f.store });
    assert.deepEqual(mentions(viewer.edits[0]), saved.winner_user_ids.slice(0, 50));
});
