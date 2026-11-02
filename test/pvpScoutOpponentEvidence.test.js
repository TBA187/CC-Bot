// Check opponent selection against screenshot evidence and the guild roster.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRating, extractScoutData, opponentFromBattleBanner } = require('../features/pvp-scouting/PvpScoutParser.js');
const { reviewPatternKey } = require('../features/pvp-scouting/ScoutReviewLearning.js');

const image = { id: 'image-1', name: 'scout.png', contentType: 'image/png', width: 900, height: 500 };

test('a framed focused opponent stays accepted when its score is 88 percent', () => {
    const parsed = extractScoutData({ content: '', attachments: [image] }, {
        ocrResults: [{ attachmentId: image.id, text: 'Beboo1 Rating: -8\nMiltos7',
            focusedIgn: 'Miltos7', focusedConfidence: 0.88, focusedSource: 'result_card_ocr',
            focusedScanAttempted: true, cardRect: { left: 10, top: 10, width: 800, height: 460 } }],
        memberContext: { authorNames: ['Beboo1'], memberNames: ['Beboo1'] }
    });
    assert.equal(parsed.ign, 'Miltos7');
    assert.equal(parsed.reviewStatus, 'not_required');
    assert.equal(parsed.ignConfidence, 0.88);
});

test('a single unframed and unsupported focused name remains in review', () => {
    const parsed = extractScoutData({ content: '', attachments: [image] }, {
        ocrResults: [{ attachmentId: image.id, text: 'Rating: +15\nUnknownName',
            focusedIgn: 'UnknownName', focusedConfidence: 0.86, focusedSource: 'result_card_ocr' }]
    });
    assert.equal(parsed.ign, 'UnknownName');
    assert.equal(parsed.reviewStatus, 'pending');
});

test('saved battle OCR selects the nonmember side even when another member posted the screenshot', () => {
    const parsed = extractScoutData({ content: '', attachments: [image] }, {
        ocrResults: [{ attachmentId: image.id, text: 'Miltos7 VS. Beboo1', battlePairAmbiguous: true }],
        memberContext: { authorNames: ['Spectator'], memberNames: ['Spectator', 'Beboo1'] }
    });
    assert.equal(parsed.ign, 'Miltos7');
    assert.equal(parsed.reviewStatus, 'not_required');
});

test('a banner containing two roster members stays ambiguous without the author side', () => {
    const read = opponentFromBattleBanner('Beboo1 VS. Vangogsan', {
        authorNames: ['Spectator'], memberNames: ['Beboo1', 'Vangogsan', 'Spectator']
    });
    assert.equal(read.ign, null);
    assert.equal(read.ambiguous, true);
});

test('a labelled actual guild-member opponent is accepted and the reporter is excluded', () => {
    const parsed = extractScoutData({ content: '', attachments: [image] }, {
        ocrResults: [{ attachmentId: image.id,
            text: 'System: Ranked Opponent Found: Charank358 (350)\nSystem: Teampreview vs Charank358\nZapdos, Keldeo, Ditto' }],
        memberContext: { authorNames: ['Beboo1'], memberNames: ['Beboo1', 'Charank358'] }
    });
    assert.equal(parsed.ign, 'Charank358');
    assert.equal(parsed.rating, 350);
    assert.equal(parsed.reviewStatus, 'not_required');
});

test('the reporting member cannot become their own opponent even on a labelled OCR line', () => {
    const parsed = extractScoutData({ content: '', attachments: [image] }, {
        ocrResults: [{ attachmentId: image.id, text: 'System: Ranked Opponent Found: Beboo1 (350)' }],
        memberContext: { authorNames: ['Beboo1'], memberNames: ['Beboo1'] }
    });
    assert.equal(parsed.ign, null);
    assert.equal(parsed.reviewStatus, 'pending');
});

test('roster membership does not change validation for clear typed or screenshot opponents', () => {
    for (const ign of ['Twinsoul', 'Charank358']) {
        const fixtures = [
            { message: { content: `${ign}\nHeatran: Taunt\nClefable: Moonblast`, attachments: [] } },
            { message: { content: `Opponent IGN: ${ign}\nHeatran: Taunt`, attachments: [] } },
            { message: { content: '', attachments: [image] }, ocrResults: [{ attachmentId: image.id,
                text: `Inspect: ${ign}\nName: ${ign}\nPvP\nRating: 383\nWins: 317\nLosses: 169` }] },
            { message: { content: ign, attachments: [image] }, ocrResults: [{ attachmentId: image.id,
                text: `Opponent IGN: ${ign}\nZapdos, Keldeo, Ditto` }] }
        ];
        for (const { message, ocrResults = [] } of fixtures) {
            const baseline = extractScoutData(message, { ocrResults });
            const parsed = extractScoutData(message, { ocrResults,
                memberContext: { authorNames: ['Reporter'], memberNames: ['Reporter', ign] } });
            assert.equal(parsed.ign, ign);
            assert.equal(parsed.reviewStatus, 'not_required');
            assert.deepEqual(parsed, baseline);
        }
    }
});

test('guild-member opponents still need review when names conflict or evidence is weak', () => {
    const memberContext = { authorNames: ['Reporter'], memberNames: ['Reporter', 'Twinsoul'] };
    const conflict = extractScoutData({ content: 'Opponent IGN: Twinsoul', attachments: [image] }, {
        memberContext, ocrResults: [{ attachmentId: image.id, text: 'Opponent IGN: Miltos7' }]
    });
    assert.equal(conflict.reviewStatus, 'pending');
    assert.match(conflict.reviewReason, /different opponents/u);
    const weak = extractScoutData({ content: 'Twinsoul', attachments: [image] }, { memberContext });
    assert.equal(weak.reviewStatus, 'pending');
    assert.match(weak.reviewReason, /unlabeled line/u);
});

for (const [source, content] of [
    ['named_report', 'Miltos7 -> Heatran: Taunt\nClefable: Moonblast'],
    ['leading_ign_team', 'Miltos7\nHeatran: Taunt\nClefable: Moonblast'],
    ['first_line', '> Miltos7\nHeatran: Taunt\nClefable: Moonblast'],
    ['numbered_team_heading', '> Miltos7\n1. Heatran: Taunt\n2. Clefable: Moonblast\n3. Keldeo: Scald\n4. Zapdos: Roost']
]) test(`populated ${source} review history accepts clear opponents with or without a roster match`, () => {
    for (const hasImage of [false, true]) for (const isMember of [false, true]) {
        const message = { content, attachments: hasImage ? [image] : [] };
        const baseline = extractScoutData(message);
        assert.equal(baseline.ignSource, source);
        const sourceStats = new Map([[reviewPatternKey(source, hasImage, 'none'),
            { confirmed: 4, changedIgn: 3, rejected: 0 }]]);
        const parsed = extractScoutData(message, { reviewLearning: { sourceStats },
            memberContext: { authorNames: ['Reporter'], memberNames: isMember ? ['Reporter', 'Miltos7'] : ['Reporter'] } });
        assert.equal(parsed.ign, 'Miltos7');
        assert.equal(parsed.reviewStatus, 'not_required');
        assert.deepEqual(parsed, baseline);
    }
});

test('off-topic generic names remain ignored', () => {
    for (const content of ['he has a Gliscor lol', 'for me Clefable is annoying']) {
        const parsed = extractScoutData({ content, attachments: [] });
        assert.equal(parsed.classification, 'ignored');
        assert.equal(parsed.ign, null);
    }
});

test('a species joined to a move is team detail rather than an inferred opponent name', () => {
    const content = 'Gliscor-protectq substitute, toxic and eq, Tornadus - rocky helmet, defog, u-turn, mega latias- ice beam, calm mind, roost, psyshock, lando- choice scarf- eq, azumarill- choice band';
    const parsed = extractScoutData({ content, attachments: [] });
    assert.equal(parsed.ign, null);
    assert.match(parsed.teamText, /Gliscor: Protect, Substitute, Toxic, Earthquake/u);
    const named = extractScoutData({ content: 'Charizardfan\nHeatran: Taunt\nClefable: Moonblast', attachments: [] });
    assert.equal(named.ign, 'Charizardfan');
});

test('opponent rating survives screenshot line wraps and belongs to the selected opponent', () => {
    assert.equal(extractRating('System: Ranked Opponent Found: Ferocityy (309)', 'Ferocityy', { fromOcr: true }), 309);
    assert.equal(extractRating('System: Ranked Opponent Found: Ferocityy\n(241)', 'Ferocityy', { fromOcr: true }), 241);
    assert.equal(extractRating('System: Ranked Opponent Found: OtherPlayer (309)', 'Ferocityy', { fromOcr: true }), null);
    assert.equal(extractRating('Beboo1 Rating: +17\nFerocityy', 'Ferocityy', { fromOcr: true }), null);
    assert.equal(extractRating('Beboo1 Rating: -8\nFerocityy', 'Ferocityy', { fromOcr: true }), null);
    assert.equal(extractRating('Ferocityy ( 400rt )\nZapdos: Roost', 'Ferocityy'), 400);
});

test('an inspect-profile rating belongs to the selected name and excludes result deltas', () => {
    const profile = 'Inspect: Goias\nName: Goias\nPvP\nRating: 383\nWins: 317\nLosses: 169';
    assert.equal(extractRating(profile, 'Goias', { fromOcr: true }), 383);
    assert.equal(extractRating(profile, 'OtherPlayer', { fromOcr: true }), null);
    assert.equal(extractRating('Goias Rating: +17\nWins: 317\nLosses: 169', 'Goias', { fromOcr: true }), null);
    assert.equal(extractRating('Inspect: Goias\nRating: -8\nWins: 317\nLosses: 169', 'Goias', { fromOcr: true }), null);
});
