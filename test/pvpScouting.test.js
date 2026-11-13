// Covers IGN extraction and the rules for joining follow-up posts into one scout report.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractScoutData, isClearlyOffTopicText } = require('../features/pvp-scouting/PvpScoutParser.js');
const { buildGroupLinks } = require('../features/pvp-scouting/PvpScoutIngestor.js');

test('groups seven consecutive posts by the same author into one scouting record', () => {
    const start = Date.parse('2026-09-27T12:00:00Z');
    const rows = Array.from({ length: 7 }, (_, index) => ({
        message_id: String(1000 + index),
        author_id: 'scouter-1',
        created_at: new Date(start + index * 30_000),
        classification: index === 0 ? 'scout' : 'ignored',
        message_content: index === 0 ? 'Mavywavy' : 'Landorus: Earthquake',
        team_text: '- Landorus: Earthquake',
        ign_normalized: index === 0 ? 'mavywavy' : null,
        reply_to_id: null,
        review_status: 'not_required',
        is_deleted: false
    }));

    const result = buildGroupLinks(rows);

    assert.equal(result.links.length, 6);
    assert.ok(result.links.every(link => link.rootMessageId === '1000'));
});

test('groups a reply with its scouting root but keeps a conflicting opponent separate', () => {
    const root = {
        message_id: '1000', author_id: 'scouter-1', created_at: new Date('2026-09-27T12:00:00Z'),
        classification: 'scout', ign_normalized: '90skid', reply_to_id: null, is_deleted: false
    };
    const reply = {
        message_id: '1001', author_id: 'scouter-2', created_at: new Date('2026-09-27T12:01:00Z'),
        classification: 'ignored', ign_normalized: null, reply_to_id: '1000', is_deleted: false,
        message_content: 'Gliscor: Toxic, Protect', team_text: '- Gliscor: Toxic, Protect'
    };
    const conflictingReply = {
        ...reply, message_id: '1002', ign_normalized: 'financebro', reply_to_id: '1000'
    };

    const result = buildGroupLinks([root, reply, conflictingReply]);

    assert.deepEqual(result.links, [{ messageId: '1001', rootMessageId: '1000' }]);
});

test('keeps a one-line IGN attached to an image searchable and sends it for review', () => {
    const parsed = extractScoutData({
        content: 'Rachelgardner',
        attachments: [{ name: 'team.png', contentType: 'image/png' }]
    });

    assert.equal(parsed.ign, 'Rachelgardner');
    assert.equal(parsed.classification, 'scout');
    assert.equal(parsed.reviewStatus, 'pending');
});

test('archives obvious reaction-only messages without treating them as scout notes', () => {
    assert.equal(isClearlyOffTopicText('was crazy 😭'), true);
    assert.equal(isClearlyOffTopicText(':popcorn1:'), true);

    const parsed = extractScoutData({ content: 'was crazy 😭', attachments: [] });
    assert.equal(parsed.classification, 'ignored');
});
test('keeps separate images apart when the earlier opponent was missed', () => {
    const root = { message_id: '1357528992621789225', author_id: 'same',
        created_at: new Date('2025-04-04T12:00:00Z'), classification: 'review',
        attachments: [{contentType:'image/png'}], ign_normalized: null };
    const next = { ...root, message_id:'1357532622343110787',
        created_at: new Date('2025-04-04T12:14:00Z'), ign_normalized:'gesb' };
    assert.deepEqual(buildGroupLinks([root,next]).links, []);
});

test('groups a screenshot and same-author text posted 28 seconds later', () => {
    const root = { message_id:'1', author_id:'same', created_at:new Date('2025-03-14T12:00:00Z'),
        classification:'review', attachments:[{contentType:'image/png'}], ign_normalized:null };
    const text = { message_id:'2', author_id:'same', created_at:new Date('2025-03-14T12:00:28Z'),
        classification:'review', team_text:'- Tornadus: Hidden Power Ice\n- Diggersby: Fire Punch',
        message_content:'Tornadus hp ice - digg fire punch', ign_normalized:null };
    assert.deepEqual(buildGroupLinks([root,text]).links,[{messageId:'2',rootMessageId:'1'}]);
});

test('does not attach another author solely for sharing the same Pokémon', () => {
    const team = '- Landorus\n- Clefable\n- Tornadus\n- Keldeo\n- Heatran\n- Ferrothorn';
    const root = {message_id:'1',author_id:'one',created_at:new Date('2025-04-04T12:00:00Z'),
        classification:'scout',ign_normalized:'opponent',team_text:team};
    const other = {...root,message_id:'2',author_id:'two',ign_normalized:null,
        created_at:new Date('2025-04-04T12:01:00Z')};
    assert.deepEqual(buildGroupLinks([root,other]).links,[]);
});

test('keeps filler replies and he/for outside a genuine scout', () => {
    const root = {message_id:'1',author_id:'one',created_at:new Date('2025-04-04T12:00:00Z'),
        classification:'scout',ign_normalized:'90skid'};
    const filler = {message_id:'2',author_id:'two',created_at:new Date('2025-04-04T12:01:00Z'),
        classification:'ignored',message_content:'lol',reply_to_id:'1'};
    assert.deepEqual(buildGroupLinks([root,filler]).links,[]);
    for (const content of ['he has Gliscor and Clefable','for Landorus use earthquake', 'lol that Clefable was crazy']) {
        const parsed = extractScoutData({content,attachments:[]});
        assert.notEqual(parsed.classification,'scout');
        const conversation = {message_id:'3',author_id:'one',created_at:new Date('2025-04-04T12:00:30Z'),
            message_content:content, classification:parsed.classification, team_text:parsed.teamText};
        assert.deepEqual(buildGroupLinks([root,conversation]).links,[]);
    }
});

test('live grouping and paged rebuild use the same continuation rules', async () => {
    const {PvpScoutIngestor} = require('../features/pvp-scouting/PvpScoutIngestor.js');
    const rows = [
        {message_id:'1',author_id:'one',classification:'review',created_at:new Date('2025-04-04T12:00:00Z'),
            attachments:[{contentType:'image/png'}],ign_normalized:null,root_message_id:'1'},
        {message_id:'2',author_id:'one',classification:'review',created_at:new Date('2025-04-04T12:00:28Z'),
            message_content:'Tornadus: Hidden Power Ice',team_text:'- Tornadus: Hidden Power Ice',root_message_id:'2'}
    ];
    const links = [];
    const store = {
        listMessagesAfter:async cursor=>cursor?[]:rows,
        setRootLinks:async value=>links.push(...value), promoteRootIgn:async()=>{},
        getMessage:async id=>rows.find(row=>row.message_id===id),
        getPreviousMessage:async()=>rows[0]
    };
    const ingestor = new PvpScoutIngestor({store,ocr:{}});
    await ingestor.rebuildGroups();
    assert.deepEqual(links,buildGroupLinks(rows).links);
    links.length=0;
    await ingestor.assignLiveGroup(rows[1]);
    assert.deepEqual(links,buildGroupLinks(rows).links);
});

test('short parsed item and ability continuations retain all four original Machao sources', () => {
    const created = offset => new Date(Date.UTC(2025, 2, 20, 1, 41, 14) + offset * 1000);
    const root = { message_id: '1352109704586989587', author_id: 'reporter',
        classification: 'scout', ign_normalized: 'machao754', created_at: created(0),
        message_content: 'Machao754 is in queue' };
    const details = { message_id: '1352109860224892949', author_id: 'reporter',
        classification: 'review', created_at: created(37),
        message_content: 'Swords dance land, rock helmet trick room cress, mega maw, keldeo scarf with flip turn',
        team_text: '- Landorus: Swords Dance\n- Cresselia (Item: Rocky Helmet): Trick Room\n- Mega Mawile\n- Keldeo (Item: Choice Scarf): Flip Turn' };
    const ability = { message_id: '1352109955729195129', author_id: 'reporter',
        classification: 'ignored', created_at: created(60), message_content: 'Z moves blace beast boost + speed',
        team_text: '- Blacephalon (Ability: Beast Boost; Other: Z-Move, +Speed)' };
    const item = { message_id: '1352110022124896306', author_id: 'reporter',
        classification: 'ignored', created_at: created(76), message_content: 'Bisharp evio',
        team_text: '- Bisharp (Item: Eviolite)' };
    const filler = { message_id: '1352115708812853248', author_id: 'someone-else',
        classification: 'ignored', created_at: created(1400), message_content: 'Z-hynosis',
        reply_to_id: ability.message_id };
    assert.deepEqual(buildGroupLinks([root, details, ability, item, filler]).links,
        [details, ability, item].map(row => ({ messageId: row.message_id, rootMessageId: root.message_id })));
});

test('a "name :" field names the opponent and divider rows are not scout details', () => {
    const parsed = extractScoutData({ content: [
        'name  : magikarpsh', ' ',
        ' - samurott (focus sash) : sword dance- aqua cutter - ceseasser - sucker punch',
        ' -  rillaboom (choice scarf) : wood - knock off - grass move - ?',
        ' -  gliscor :  taunt - sand tomb - protect - toxic',
        ' -  corviknight : iron head - uturn - roost - iron defense', '',
        '---------------------------------------------------------------------------------',
        '---------------------------------------------------------------------------------'
    ].join('\n'), attachments: [] });

    assert.equal(parsed.ign, 'magikarpsh');
    assert.equal(parsed.ignSource, 'labelled_text');
    assert.equal(parsed.classification, 'scout');
    assert.equal(parsed.reviewStatus, 'not_required');
    assert.equal(parsed.notes, null);
    assert.doesNotMatch(parsed.teamText, /--/u);
    // "Sand Tomb" is a move, so the line stays one Pokémon instead of adding Spiritomb.
    assert.deepEqual(parsed.teamText.split('\n').map(line => line.split(/[ :]/u)[1]),
        ['Samurott', 'Rillaboom', 'Gliscor', 'Corviknight']);
    assert.match(parsed.teamText, /Gliscor: Taunt, Sand Tomb, Protect, Toxic/u);
});

test('name field variants are recognised only as a line label, and the label is never the IGN', () => {
    const team = '\n- Garchomp: Earthquake, Outrage\n- Zapdos: Roost, Defog';
    for (const heading of ['name: Foobar12', 'Name - Foobar12', '**Name:** Foobar12', 'player name : Foobar12',
        'opponent name = Foobar12', '> - nickname: Foobar12', 'IGN: Foobar12', 'Opponent IGN: Foobar12']) {
        const parsed = extractScoutData({ content: heading + team, attachments: [] });
        assert.equal(parsed.ign, 'Foobar12', heading);
        assert.equal(parsed.notes, null, heading);
        assert.equal(parsed.teamText.split('\n').length, 2, heading);
    }
    // Text after the name is kept; a hyphenated IGN is not split at its dash.
    assert.equal(extractScoutData({ content: `name: Foobar12 (300) rain team${team}`, attachments: [] }).notes, 'rain team');
    assert.equal(extractScoutData({ content: `Player-123${team}`, attachments: [] }).ign, 'Player-123');
    for (const heading of ['name : unknown', 'name', 'i forgot his name: he had', 'name: name']) {
        const parsed = extractScoutData({ content: heading + team, attachments: [] });
        assert.equal(parsed.ign, null, heading);
        assert.equal(parsed.reviewStatus, 'pending', heading);
    }
});

test('several name fields in one message are separate reports, and a profile "Name:" row in OCR is unchanged', () => {
    const { candidateFromOcr } = require('../features/pvp-scouting/PvpScoutParser.js');
    const parsed = extractScoutData({ content: 'name : aaa111\n- Garchomp: Earthquake\n- Zapdos: Roost\n------\nname : bbb222\n- Scizor: Roost\n- Rotom: Volt Switch',
        attachments: [] });
    assert.deepEqual([parsed.ign, parsed.reviewStatus, parsed.teamText.split('\n').length], ['aaa111', 'not_required', 2]);
    assert.deepEqual(parsed.extraSections.map(section => [section.ign, section.reviewStatus]), [['bbb222', 'not_required']]);
    assert.equal(extractScoutData({ content: 'name: Foobar12 Garchomp, Zapdos, Scizor, Rotom', attachments: [] }).ign, 'Foobar12');
    assert.equal(candidateFromOcr('Name: Foobar12\nSome text\nmore'), null);
});
