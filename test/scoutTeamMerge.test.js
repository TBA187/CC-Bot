'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { buildScoutEmbed } = require('../commands/scout.js');
const Scout = require('../commands/scout.js');
const { mergeTeamLines } = require('../features/pvp-scouting/ScoutTeamMerge.js');
const { scoutPayload } = require('../features/pvp-scouting/ScoutPresentation.js');
const { buildGroupLinks, PvpScoutIngestor } = require('../features/pvp-scouting/PvpScoutIngestor.js');
const { extractScoutData, extractRating } = require('../features/pvp-scouting/PvpScoutParser.js');
const { splitScoutText } = require('../features/pvp-scouting/PokemonTeamParser.js');
const { reportRating } = require('../features/pvp-scouting/ScoutArchiveView.js');

const team = '- Clodsire (Black Sludge, Water Absorb): Earthquake, Toxic, Recover\n'
    + '- Keldeo (Waterium Z): Calm Mind\n- Victini (Choice Scarf): V-create, Bolt Strike, U-turn\n'
    + '- Tyranitar (Choice Band, Sand Stream): Knock Off, Earthquake, Stone Edge\n'
    + '- Corviknight (Rocky Helmet, Mirror Armor): Defog, U-turn, Body Press, Roost\n'
    + '- Mega Gardevoir (Trace before Mega): Psyshock';
function source(id, text = team, fields = {}) {
    return { message_id: id, root_message_id: id, author_id: 'vango', author_username: 'vango',
        opponent_ign: 'Minglil', ign_normalized: 'minglil', classification: 'scout', review_status: 'not_required',
        team_text: text, message_content: `Minglil\n${text}`, attachments: [],
        created_at: new Date('2026-10-12T07:48:00Z'), source_url: `https://discord.com/channels/1/2/${id}`, ...fields };
}

test('May 15 original and reply show six unique Pokémon and combine observations in all public views', async () => {
    const root = source('1000');
    const reply = source('1001', '- Tyranitar (Item: Choice Band): Knock Off, Earthquake, Stone Edge\n'
        + '- Victini scarfed - V-create, Bolt Strike, U-turn\n'
        + '- Corviknight (Ability: Mirror Armor): Agility, Defog, U-turn, Body Press, Roost',
    { root_message_id: root.message_id, reply_to_id: root.message_id, author_id: 'other', author_username: 'other',
        created_at: new Date('2026-10-12T07:49:00Z') });
    const sources = [reply, root]; // Stored fetch order cannot override chronology.
    const detail = buildScoutEmbed(root, sources, 0, 1).embed.toJSON();
    const command = new Scout({ pvpScoutStore: {} });
    const history = await command.teamsPayload('Minglil', 'owner', null, [{ root, sources }]);
    for (const description of [detail.description, history.embeds[0].toJSON().description]) {
        assert.equal(description.split('\n').filter(line => /^- \*\*(?:Clodsire|Keldeo|Victini|Tyranitar|Corviknight|Mega Gardevoir)/u.test(line)).length, 6);
        assert.equal((description.match(/\*\*Tyranitar\*\*/gu) || []).length, 1);
        assert.equal((description.match(/\*\*Victini\*\*/gu) || []).length, 1);
        assert.equal((description.match(/\*\*Corviknight\*\*/gu) || []).length, 1);
        assert.match(description, /Corviknight.*Rocky Helmet.*Mirror Armor.*Defog.*Roost.*Agility/u);
        assert.doesNotMatch(description, /Information added later/u);
    }
    assert.ok(detail.fields.some(field => field.name === 'Message reply' && field.value.includes(reply.source_url)));
});

test('saved Vest shorthand in another reporter’s supplement is canonical in merged scout views', async () => {
    const original = '- Pelipper (Item: Damp Rock): U-turn\n- Zapdos: Thunder, Hurricane, Roost\n'
        + '- Mega Swampert: Superpower, Ice Punch, Earthquake\n'
        + '- Tyranitar sassy, AV or smooth rock, doesnt have pursuit and is very very slow\n'
        + '- Ferrothorn leechseed protect stealthrock, doesnt have spikes\n'
        + '- Azumarill: Belly Drum, Knock Off, Play Rough, Aqua Jet';
    const raw = 'Ferro relaxed: Gyro ball, Protect\nTyranitar Vest: Flamethower';
    for (const server of ['gold', 'silver']) {
        const root = source('1000', original, { server });
        const reply = source('1001', '- Ferrothorn (Nature: Relaxed): Gyro Ball, Protect\n- Tyranitar Vest: Flamethower',
            { server, root_message_id: root.message_id, reply_to_id: root.message_id, author_id: 'other',
                opponent_ign: null, ign_normalized: null, message_content: raw, review_status: 'pending',
                review_reason: 'Message looks like scouting information but the opponent IGN is unclear.',
                created_at: new Date('2026-10-12T08:00:00Z') });
        const command = new Scout({ pvpScoutStore: {} });
        const results = [{ root, sources: [root, reply] }];
        const detail = buildScoutEmbed(root, results[0].sources, 0, 1).embed.toJSON();
        const history = await command.teamsPayload('Minglil', 'owner', null, results);
        for (const description of [detail.description, history.embeds[0].toJSON().description]) {
            assert.match(description, /Tyranitar\*\* \(Item: Assault Vest\): Flamethrower/u);
            assert.equal(description.split('\n').filter(line => /^- \*\*/u.test(line)).length, 6);
            assert.match(description, /AV or smooth rock/u);
        }
        assert.ok(detail.fields.some(field => field.name === 'Message reply' && field.value.includes(reply.source_url)));
        assert.equal(reply.message_content, raw);
        assert.match(reply.team_text, /Vest: Flamethower/u);
    }
});

test('later attributes replace older values while moves, forms and uncertain wording survive', () => {
    const merged = mergeTeamLines(['- Scizor (Item: Leftovers; Ability: Technician): Bullet Punch',
        '- Mega Scizor (Item: Scizorite): Roost, Bullet Punch', '- Scizor: Swords Dance',
        '- Tyranitar (possibly Choice Band): Pursuit', '- Tyranitar: Earthquake']);
    assert.equal(merged.teamText.split('\n').length, 2);
    assert.match(merged.teamText, /Mega Scizor \(Item: Scizorite; Ability: Technician\): Bullet Punch, Roost, Swords Dance/u);
    assert.doesNotMatch(merged.teamText, /Leftovers/u);
    assert.match(merged.teamText, /possibly Choice Band/u);
    assert.match(merged.teamText, /Pursuit/u);
    assert.match(merged.teamText, /Earthquake/u);
});

test('an oversized legacy or manually attached family shows at most six Pokémon and a review notice', () => {
    const root = source('1000');
    const reply = source('1001', '- Heatran: Lava Plume', { root_message_id: root.message_id,
        reply_to_id: root.message_id, author_id: 'other', created_at: new Date('2026-10-12T07:49:00Z') });
    const embed = buildScoutEmbed(root, [root, reply], 0, 1).embed.toJSON();
    assert.equal(embed.description.split('\n').filter(line => /^- \*\*/u.test(line)).length, 6);
    assert.match(embed.description, /more than six Pokémon.*needs source review/u);
    assert.ok(embed.fields.some(field => field.value.includes(reply.source_url)));
    assert.equal(reply.team_text, '- Heatran: Lava Plume');
});

test('three close Minglil battles keep their own dates, ratings and report IDs', () => {
    const rows = [230, 260, 280].map((rating, index) => source(String(1000 + index), team,
        { rating, created_at: new Date(Date.parse('2026-10-12T07:48:00Z') + index * 60_000) }));
    assert.equal(buildGroupLinks(rows).links.length, 0);
    for (const row of rows) assert.equal(buildGroupLinks(rows).messageRoots.get(row.message_id), row.message_id);
    const repeatedRating = rows.map(row => ({ ...row, rating: 230 }));
    assert.equal(buildGroupLinks(repeatedRating).links.length, 0);
    const screenshots = rows.map(row => ({ ...row, rating: null, team_text: null, attachments: [{ contentType: 'image/png' }] }));
    assert.equal(buildGroupLinks(screenshots).links.length, 0);
});

test('an explicit same-author reply is a continuation even after fifteen minutes', () => {
    const root = source('1000');
    const reply = source('1001', '- Corviknight: Agility', { reply_to_id: root.message_id,
        created_at: new Date('2026-10-12T09:48:00Z') });
    assert.deepEqual(buildGroupLinks([root, reply]).links, [{ messageId: reply.message_id, rootMessageId: root.message_id }]);
});

test('legacy fragments with inherited names and officer-reviewed screenshot crops stay attached', () => {
    const root = source('1000');
    const fragment = source('1001', '- Corviknight: Agility', { root_message_id: '1000',
        message_content: 'Corviknight: Agility', created_at: new Date('2026-10-12T07:49:00Z') });
    assert.equal(buildGroupLinks([root, fragment]).messageRoots.get('1001'), '1000');
    const imageRoot = { ...root, team_text: null, message_content: '', review_status: 'corrected',
        attachments: [{ contentType: 'image/png' }] };
    const crop = { ...imageRoot, message_id: '1001', root_message_id: '1000', created_at: fragment.created_at };
    assert.equal(buildGroupLinks([imageRoot, crop]).messageRoots.get('1001'), '1000');
});

test('Fusion Bolt remains a move, and a misspelled Hisuian Samurott becomes the sixth team member', () => {
    const result = splitScoutText('Gliscor: Toxic\nFerrothorn: Leech Seed\nEiscue: Freeze-Dry\n'
        + 'Kyurem Black / z move - freezy dry, fusion bolt\nHeatran -\nSammorut / scraff- Hisui - flip turn,');
    assert.equal(result.teamText.split('\n').length, 6);
    assert.match(result.teamText, /Kyurem-Black.*Freeze-Dry.*Fusion Bolt/u);
    assert.doesNotMatch(result.teamText, /Raging Bolt/u);
    assert.match(result.teamText, /Samurott-Hisui.*Choice Scarf.*Flip Turn/u);
});

test('known legacy parsing defects are repaired for display while OCR slots and officer team corrections survive', () => {
    const content = 'Minglil - 260 rank\nGliscor: Toxic\nFerrothorn: Leech Seed\nEiscue: Freeze-Dry\n'
        + 'Kyurem Black / z move - freezy dry, fusion bolt\nHeatran -\nSammorut / scraff- Hisui - flip turn,';
    const legacy = source('1000', '- Gliscor: Toxic\n- Ferrothorn: Leech Seed\n- Eiscue: Freeze-Dry\n'
        + '- Kyurem-Black: Freeze-Dry\n- Raging Bolt fusion\n- Heatran',
    { message_content: content, review_status: 'confirmed' });
    const repaired = buildScoutEmbed(legacy, [legacy], 0, 1).embed.toJSON();
    assert.match(repaired.description, /Samurott-Hisui.*Choice Scarf.*Flip Turn/u);
    assert.match(repaired.description, /Kyurem-Black.*Fusion Bolt/u);
    assert.doesNotMatch(repaired.description, /Raging Bolt/u);
    assert.match(repaired.title, /260/u);
    const corrected = { ...legacy, team_text: '- Pikachu: Thunderbolt', review_status: 'corrected' };
    assert.match(buildScoutEmbed(corrected, [corrected], 0, 1).embed.toJSON().description, /Pikachu/u);
    const partial = source('1000', team, { message_content: 'Minglil\nClodsire: Toxic\nKeldeo: Calm Mind\n'
        + 'Victini: U-turn\nTyranitar: Earthquake' });
    assert.match(buildScoutEmbed(partial, [partial], 0, 1).embed.toJSON().description, /Mega Gardevoir/u);
});

test('rank shorthand is bound to its opponent and fills legacy displays without replacing an officer correction', () => {
    assert.equal(extractRating('Minglil - 260 rank\nGliscor: Toxic', 'Minglil'), 260);
    assert.equal(extractRating('SomeoneElse - 260 rank', 'Minglil'), null);
    assert.equal(extractRating('Minglil - 260 rank', 'Minglil', { fromOcr: true }), null);
    const legacy = source('1000', team, { rating: null, message_content: 'Minglil - 230 rank\n' + team });
    assert.equal(reportRating(legacy), 230);
    assert.equal(reportRating({ ...legacy, review_status: 'corrected' }), null);
});

test('group rebuilding changes only incorrect links, preserves manual decisions, and is idempotent', async () => {
    const rows = [source('1000', team, { rating: 230 }),
        source('1001', team, { rating: 260, root_message_id: '1000', created_at: new Date('2026-10-12T07:49:00Z') }),
        source('1002', team, { rating: 280, root_message_id: '1000', created_at: new Date('2026-10-12T07:50:00Z') }),
        source('1003', '- Corviknight: Agility', { root_message_id: '1000', reply_to_id: '1000',
            created_at: new Date('2026-10-12T07:51:00Z') }),
        source('1004', '- Heatran: Lava Plume', { root_message_id: '1000',
            created_at: new Date('2026-10-12T07:52:00Z'), staffOverrides: { rootMessageId: '1000', relation: 'reply' } })];
    const writes = [];
    const store = { listMessagesAfter: async cursor => cursor ? [] : rows,
        setRootLinks: async links => { writes.push(...links); for (const link of links) rows.find(row => row.message_id === link.messageId).root_message_id = link.rootMessageId; },
        promoteRootIgn: async () => assert.fail('Known opponents need no promotion') };
    const ingestor = new PvpScoutIngestor({ store, ocr: {} });
    await ingestor.rebuildGroups();
    assert.deepEqual(writes, [{ messageId: '1001', rootMessageId: '1001' }, { messageId: '1002', rootMessageId: '1002' }]);
    assert.equal(rows[3].root_message_id, '1000');
    assert.equal(rows[4].root_message_id, '1000');
    writes.length = 0;
    await ingestor.rebuildGroups();
    assert.deepEqual(writes, []);
});

test('scout panels never upload the footer logo and clear only its old attachment', () => {
    const embed = new EmbedBuilder().setTitle('Manage Scout Sources').setFooter({ text: 'Report ID: 1', iconURL: 'attachment://cc_logo.webp' });
    const csv = new AttachmentBuilder(Buffer.from('report'), { name: 'scouts.csv' });
    const result = scoutPayload({ embeds: [embed], files: [csv] });
    assert.deepEqual(result.files, [csv]);
    assert.equal(result.embeds[0].toJSON().footer.icon_url, undefined);
    const old = { attachments: new Collection([['logo', { id: 'logo', name: 'ww_logo.png' }],
        ['proof', { id: 'proof', name: 'battle.png' }]]), author: { displayAvatarURL: () => 'https://example.com/avatar.png' } };
    const edit = scoutPayload({ embeds: [embed] }, old);
    assert.deepEqual(edit.attachments, [{ id: 'proof' }]);
    assert.equal(edit.embeds[0].toJSON().footer.icon_url, 'https://example.com/avatar.png');
});

const typedScout = 'Normalthing (253)\nSkarmory: Spikes, Roost\nMega Sableye: Protect, Night Shade, Recover\n'
    + 'Alomomola: Toxic, Wish, Scald, Protect\nDragapult: Steel Wing, Hex, Dragon Darts\n'
    + 'Clefable (Unaware): Wish, Moonblast, Protect\nChansey: Stealth Rock, Soft-Boiled, Toxic';
function readName(name, confidence = 0.86, knownIgnEvidence = []) {
    return extractScoutData({ content: typedScout, attachments: [{ id: 'image', contentType: 'image/png' }] },
        { knownIgnEvidence, ocrResults: [{ attachmentId: 'image', focusedIgn: name, focusedConfidence: confidence,
            focusedSource: 'result_card_ocr', cardRect: { left: 0, top: 0, width: 500, height: 200 }, text: `${name} K.O.` }] });
}
test('a full typed scout wins over a weak close OCR misspelling, while real conflicts still need review', () => {
    const weak = readName('Normatlthing');
    assert.equal(weak.ign, 'Normalthing');
    assert.equal(weak.rating, 253);
    assert.equal(weak.reviewStatus, 'not_required');
    assert.equal(readName('DifferentOpponent').reviewStatus, 'pending');
    assert.equal(readName('Normatlthing', 0.91).reviewStatus, 'pending');
    assert.equal(readName('Normatlthing', 0.86, [{ ign: 'Normatlthing', authorIds: ['one', 'two'] }]).ign, 'Normatlthing');
});
