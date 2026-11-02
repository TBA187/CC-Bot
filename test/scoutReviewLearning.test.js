// Check which officer decisions the parser may reuse for future scouts.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReviewLearning, reviewedTextKey, reviewPatternKey } = require('../features/pvp-scouting/ScoutReviewLearning.js');

function version(ign, reviewStatus = 'pending') {
    return { ign, reviewStatus, messageContent: 'Goldenp1kachu\nZapdos: Roost\nKeldeo: Scald',
        attachments: [], ocrResults: [], ignSource: 'first_line', teamLayoutStatus: 'none',
        rating: null, teamText: '- Zapdos: Roost\n- Keldeo: Scald', notes: null };
}

test('confirming an unchanged guild-member opponent teaches a successful read without a spelling alias', () => {
    const before = { ...version('Twinsoul'), messageContent: 'Twinsoul\nZapdos: Roost\nKeldeo: Scald',
        reviewReason: 'The detected IGN matches a current or former guild member; verify that the screenshot names the opponent.' };
    const learning = buildReviewLearning([{ event_id: '1', message_id: '1563947587097067621',
        reviewer_id: 'officer', action: 'confirmed', before_json: before,
        after_json: { ...before, reviewStatus: 'confirmed', reviewReason: null } }]);
    assert.deepEqual(learning.sourceStats.get(reviewPatternKey('first_line', false, 'none')),
        { confirmed: 1, changedIgn: 0, rejected: 0 });
    assert.equal(learning.aliases.size, 0);
    assert.equal(learning.exactCorrections.size, 0);
    assert.equal(learning.rejectedText.size, 0);
});

test('shares format and spelling evidence without borrowing exact team edits from another server', () => {
    const before = version('Go1denp1kachu'), after = version('Goldenp1kachu', 'corrected');
    const events = [{ event_id: '1', message_id: 'gold-source', channel_id: 'gold-channel',
        reviewer_id: 'officer', action: 'corrected', before_json: before, after_json: after }];
    const silver = buildReviewLearning(events, { channelId: 'silver-channel' });
    const gold = buildReviewLearning(events, { channelId: 'gold-channel' });
    assert.equal(silver.aliases.get('go1denp1kachu')[0].to, 'Goldenp1kachu');
    assert.equal(silver.sourceStats.size, 1);
    assert.equal(silver.exactCorrections.size, 0);
    assert.equal(gold.exactCorrections.size, 1);
});

test('restoring a mistaken correction cancels the wrong alias and false pattern penalty', () => {
    const learning = buildReviewLearning([
        { event_id: '1', message_id: 'scout-1', reviewer_id: 'officer-1', action: 'corrected',
            before_json: version('Goldenp1kachu'), after_json: version('Go1denp1kachu', 'corrected') },
        { event_id: '2', message_id: 'scout-1', reviewer_id: 'officer-1', action: 'corrected',
            before_json: version('Go1denp1kachu', 'corrected'), after_json: version('Goldenp1kachu', 'corrected') }
    ]);
    assert.equal(learning.aliases.has('goldenp1kachu'), false);
    assert.equal(learning.aliases.get('go1denp1kachu')[0].to, 'Goldenp1kachu');
    assert.deepEqual(learning.sourceStats.get(reviewPatternKey('first_line', false, 'none')),
        { confirmed: 1, changedIgn: 0, rejected: 0 });
    assert.equal(learning.exactCorrections.get(reviewedTextKey(version('').messageContent)).ign, 'Goldenp1kachu');
});

test('a later approval supersedes a rejection of the same message', () => {
    const learning = buildReviewLearning([
        { event_id: '2', message_id: 'scout-1', reviewer_id: 'officer-2', action: 'corrected',
            before_json: version(null, 'not_scout'), after_json: version('Goldenp1kachu', 'corrected') },
        { event_id: '1', message_id: 'scout-1', reviewer_id: 'officer-1', action: 'not_scout',
            before_json: version('Goldenp1kachu'), after_json: version(null, 'not_scout') }
    ]);
    assert.equal(learning.rejectedText.size, 0);
    assert.equal(learning.exactCorrections.get(reviewedTextKey(version('').messageContent)).ign, 'Goldenp1kachu');
});

test('reopening a reviewed message removes its old reusable approval', () => {
    const learning = buildReviewLearning([
        { event_id: '2', message_id: 'scout-1', reviewer_id: 'officer-1', action: 'corrected',
            before_json: version('Goldenp1kachu', 'corrected'), after_json: version(null, 'pending') },
        { event_id: '1', message_id: 'scout-1', reviewer_id: 'officer-1', action: 'corrected',
            before_json: version('Go1denp1kachu'), after_json: version('Goldenp1kachu', 'corrected') }
    ]);
    assert.equal(learning.aliases.size, 0);
    assert.equal(learning.exactCorrections.size, 0);
    assert.equal(learning.sourceStats.size, 0);
});

test('administrative deletion does not teach the parser that valid scout content is off topic', () => {
    const learning = buildReviewLearning([{ event_id: '2', message_id: 'scout-1', action: 'not_scout',
        before_json: version('Goldenp1kachu'), after_json: { ...version('Goldenp1kachu', 'not_scout'), staffOverrides: { hidden: true } } },
    { event_id: '1', message_id: 'scout-1', action: 'corrected', before_json: version('Go1denp1kachu'),
        after_json: version('Goldenp1kachu', 'corrected') }]);
    assert.equal(learning.rejectedText.size, 0);
    assert.equal(learning.sourceStats.size, 0);
    assert.equal(learning.aliases.size, 0);
});

test('later maintenance cannot revive learning from an administratively deleted source', () => {
    const learning = buildReviewLearning([{ event_id: '3', message_id: 'scout-1', action: 'not_scout',
        before_json: version('Goldenp1kachu'), after_json: version('Goldenp1kachu', 'not_scout') },
    { event_id: '2', message_id: 'scout-1', action: 'not_scout', before_json: version('Goldenp1kachu'),
        after_json: { ...version('Goldenp1kachu', 'not_scout'), staffOverrides: { hidden: true } } }]);
    assert.equal(learning.sourceStats.size, 0); assert.equal(learning.rejectedText.size, 0);
});

test('moving or adding a response does not teach an OCR correction or rejection', () => {
    const learning = buildReviewLearning([{ event_id: '2', message_id: 'scout-1', action: 'corrected',
        before_json: version('WrongRead'), after_json: { ...version('Goldenp1kachu', 'corrected'), managementAction: 'attached' } }]);
    assert.equal(learning.aliases.size, 0); assert.equal(learning.exactCorrections.size, 0);
    assert.equal(learning.sourceStats.size, 0);
});
