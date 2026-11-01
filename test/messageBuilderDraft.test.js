/**
 * @fileoverview Verify message-draft validation, Crow Control branding, attachments and JSON round trips.
 * Protect editable message data and import compatibility without Discord API requests.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, EmbedBuilder } = require('discord.js');
const {
    EmbedDraft, EmbedFieldDraft, EmbedMediaDraft, MessageAttachmentDraft, ImportedAttachment,
    MAX_DESCRIPTION, MAX_EMBED_TEXT, FOOTER_TEXT, LOGO_FILENAME, LOGO_URL, MESSAGE_JSON_FORMAT,
    applyCrowControlBrandingDefaults, buildMediaFiles, buildMessageAttachmentFiles,
    draftFromMessage, validateEmbedDraft, reconcileEditAttachments, relatedAttachmentIdsFromMessage,
    exportMessageJson, importMessageJson, parseEmbedTimestamp, formatEmbedTimestamp,
    normalizeEmbedColor, expandLiteralLineBreaks, expandFieldSpacingEscapes,
    readAttachmentBytes, populatedEmbedProperties, formatEmbedChanges, brandedEditAttachments
} = require('../features/message-builder/draft.js');

function attachment(id, name, data = Buffer.from('attachment'), contentType = 'image/png') {
    return new ImportedAttachment({ id, filename: name, data, contentType, url: 'https://cdn.discord.test/' + name });
}
function message(content, embeds, attachments) {
    return { content, embeds, attachments: new Collection(attachments.map(item => [item.id, item])) };
}

test('draft validation preserves dependencies, URL rules and exact limit text', () => {
    assert.deepEqual(validateEmbedDraft(new EmbedDraft()), [
        'Add message content, a regular attachment, or at least one embed property before sending.'
    ]);
    assert.deepEqual(validateEmbedDraft(new EmbedDraft({ messageContent: 'Hello' })), []);
    const errors = validateEmbedDraft(new EmbedDraft({
        titleUrl: 'http://example.com', authorUrl: 'https://example.com/profile',
        footerIcon: new EmbedMediaDraft({ url: 'https://example.com/footer.png' })
    }));
    assert.deepEqual(errors, [
        'Title URL requires a Title.', 'Author URL and icon require an Author name.',
        'Footer icon URL requires Footer text.', 'Title URL must be a valid HTTPS URL.'
    ]);
    assert.deepEqual(validateEmbedDraft(new EmbedDraft({ messageContent: 'x'.repeat(2001) })), [
        'Message content cannot exceed 2,000 characters.'
    ]);
    const combined = new EmbedDraft({
        title: 'T', description: 'x'.repeat(MAX_DESCRIPTION),
        fields: [new EmbedFieldDraft('N', 'v'.repeat(MAX_EMBED_TEXT - MAX_DESCRIPTION))]
    });
    assert.ok(validateEmbedDraft(combined).includes('Combined embed text cannot exceed 6,000 characters (currently 6,002).'));
    assert.ok(validateEmbedDraft(combined).includes('Field 1 value cannot exceed 1,024 characters.'));
    assert.ok(validateEmbedDraft(new EmbedDraft({ title: 'T',
        fields: Array.from({ length: 26 }, (_, index) => new EmbedFieldDraft(String(index), 'value')) }))
        .includes('An embed can contain at most 25 fields.'));
});

test('named colors, line breaks and invisible field fillers use source behavior', () => {
    assert.equal(normalizeEmbedColor(' dark-red '), '#8B0000');
    assert.equal(normalizeEmbedColor('light_blue'), '#ADD8E6');
    assert.equal(normalizeEmbedColor('#a1b2c3'), '#A1B2C3');
    assert.equal(normalizeEmbedColor(''), '');
    assert.throws(() => normalizeEmbedColor('rgb(1,2,3)'), /Color must be a hex code/);
    assert.equal(expandLiteralLineBreaks('Line 1\\nLine 2'), 'Line 1\nLine 2');
    assert.equal(expandFieldSpacingEscapes('\\u200b\\u2002'), '\u2002');
    assert.equal(expandFieldSpacingEscapes('\u2063\\U200B'), '\u200b');
    assert.equal(expandFieldSpacingEscapes('\\u200B\nValue'), '\u200b\nValue');
});

test('timestamps support offsets, 12-hour clocks, current local dates and IANA DST', () => {
    const now = new Date('2026-07-18T23:30:00Z');
    const parse = text => parseEmbedTimestamp(text, { now });
    assert.equal(parse('2026-07-18T12:30:00+02:00').toISOString(), '2026-07-18T10:30:00.000Z');
    assert.equal(formatEmbedTimestamp(parse('2026-07-18T12:30:00+02:00')), '2026-07-18T12:30:00+02:00');
    assert.equal(formatEmbedTimestamp(parse('2026-07-18T12:30:00.123456Z')), '2026-07-18T12:30:00.123456+00:00');
    assert.equal(formatEmbedTimestamp(new Date('2026-07-18T12:30:00.123Z')), '2026-07-18T12:30:00.123000+00:00');
    assert.equal(parse('2026-07-18 04:20 pm UTC+1').toISOString(), '2026-07-18T15:20:00.000Z');
    assert.equal(formatEmbedTimestamp(parse('17:30')), '2026-07-18T17:30:00+00:00');
    assert.equal(formatEmbedTimestamp(parse('04:20 PM')), '2026-07-18T16:20:00+00:00');
    assert.equal(formatEmbedTimestamp(parse('17:30 GMT+05:30')), '2026-07-19T17:30:00+05:30');
    assert.equal(formatEmbedTimestamp(parse('2026-07-18 17:30 (UTC+1)')), '2026-07-18T17:30:00+01:00');
    assert.equal(formatEmbedTimestamp(parse('2026-07-18 17:30 CEST')), '2026-07-18T17:30:00+02:00');
    assert.equal(formatEmbedTimestamp(parse('2026-07-18 17:30 Europe/Copenhagen')), '2026-07-18T17:30:00+02:00');
    assert.equal(formatEmbedTimestamp(parse('2026-01-18 17:30 Europe/Copenhagen')), '2026-01-18T17:30:00+01:00');
    assert.equal(formatEmbedTimestamp(parse('17:30 Europe/Copenhagen')), '2026-07-19T17:30:00+02:00');
    assert.equal(formatEmbedTimestamp(parse('2026-10-25 02:30 Europe/Copenhagen')), '2026-10-25T02:30:00+02:00');
    assert.equal(formatEmbedTimestamp(parse('2026-03-29 02:30 Europe/Copenhagen')), '2026-03-29T02:30:00+01:00');
    assert.equal(parse('20260718T1730').toISOString(), '2026-07-18T17:30:00.000Z');
    assert.equal(parse('2026-W29-6T17:30').toISOString(), '2026-07-18T17:30:00.000Z');
    assert.equal(parse(''), null);
    for (const text of ['2026-02-30 17:30', '24:30', '2026-07-18 13:30 PM']) assert.throws(() => parse(text), /Timestamp must contain/);
    assert.throws(() => parse('2026-07-18 17:30 UTC+15'), /between -14:00 and \+14:00/);
    assert.throws(() => parse('2026-07-18 17:30 IST'), /ambiguous/);
    assert.throws(() => parse('2026-07-18 17:30 NoSuch\/Zone'), /Unknown timezone/);
    assert.throws(() => parse('2026-07-18T17:30+01:00 CEST'), /more than one timezone/);
});

test('branding fills editable CC defaults and sends one local logo', async () => {
    const draft = new EmbedDraft();
    applyCrowControlBrandingDefaults(draft);
    const payload = draft.toEmbedDict();
    assert.deepEqual(payload.footer, { text: FOOTER_TEXT, icon_url: LOGO_URL });
    assert.deepEqual(payload.thumbnail, { url: LOGO_URL });
    assert.equal(payload.color, 0x452366);
    assert.equal(draft.crowControlBranding, true);
    assert.ok(Math.abs(Date.now() - parseEmbedTimestamp(payload.timestamp).getTime()) < 2000);
    const files = await buildMediaFiles(draft);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, LOGO_FILENAME);
    assert.ok(Buffer.isBuffer(files[0].attachment));
    draft.footerText = 'Custom footer';
    draft.footerIcon.setUrl('https://example.com/footer.png');
    draft.thumbnail.clear();
    draft.color = '#000080';
    draft.timestamp = parseEmbedTimestamp('2026-07-18T12:30:00Z');
    draft.useCurrentTimestamp = false;
    assert.deepEqual(draft.toEmbedDict().footer, { text: 'Custom footer', icon_url: 'https://example.com/footer.png' });
    assert.equal(draft.toEmbedDict().color, 0x000080);
    assert.equal(draft.toEmbedDict().timestamp, '2026-07-18T12:30:00+00:00');
    assert.deepEqual(validateEmbedDraft(draft), []);
});

test('color-only temporary field is only present in built API embeds', () => {
    const draft = new EmbedDraft({ color: '#123456' });
    assert.deepEqual(validateEmbedDraft(draft), []);
    assert.equal(draft.toEmbedDict().fields, undefined);
    assert.deepEqual(draft.buildEmbed().toJSON().fields, [{ name: '\u200b', value: '\u200b', inline: false }]);
    draft.title = 'Title';
    assert.equal(draft.buildEmbed().toJSON().fields, undefined);
    draft.title = ''; draft.fields = [new EmbedFieldDraft('Name', 'Value')];
    assert.equal(draft.buildEmbed().toJSON().fields.length, 1);
});

test('existing message drafts preserve content, ordinary files and media without extra embeds', async () => {
    const photo = attachment('5', 'photo.png'), regular = attachment('7', 'guide.txt', Buffer.from('Guide'), 'text/plain');
    const embed = new EmbedBuilder({ title: 'Existing', image: { url: photo.url },
        fields: [{ name: 'One', value: 'Two', inline: true }] });
    const draft = draftFromMessage(message('Above', [embed], [photo, regular]));
    assert.equal(draft.messageContent, 'Above');
    assert.equal(draft.image.attachment, photo);
    assert.equal(draft.image.isNewUpload, false);
    assert.equal(draft.messageAttachments[0].attachment, regular);
    assert.equal(draft.fields[0].inline, true);
    assert.equal(draft.buildEmbeds().length, 1);
    assert.equal(draft.toEmbedDict().image.url, 'attachment://photo.png');
    assert.deepEqual(await buildMediaFiles(draft), []);
    assert.deepEqual((await buildMessageAttachmentFiles(draft)).map(file => file.name), ['guide.txt', 'photo.png']);
    const plain = draftFromMessage(message('Plain bot message', [], [regular]));
    assert.equal(plain.hasEmbedProperties(), false);
    assert.equal(plain.messageAttachments[0].isNewUpload, false);
    assert.deepEqual(plain.buildEmbeds(), []);
});

test('edit reconciliation removes deleted media but keeps unrelated and secondary-embed files', () => {
    const old = attachment('10', 'old.png'), unrelated = attachment('11', 'document.txt');
    const draft = new EmbedDraft({ title: 'Updated' });
    const result = reconcileEditAttachments(message('', [], [old, unrelated]),
        { originalMediaAttachmentIds: new Set(['10']), draft, newFiles: [] });
    assert.deepEqual(result, { attachments: [unrelated], files: [] });
    const first = new EmbedBuilder({ title: 'Primary', image: { url: old.url } });
    const second = new EmbedBuilder({ thumbnail: { url: old.url } });
    const shared = reconcileEditAttachments(message('', [first, second], [old, unrelated]),
        { originalMediaAttachmentIds: new Set(['10']), draft, newFiles: [] });
    assert.deepEqual(shared.attachments, [old, unrelated]);
    const logo = attachment('12', LOGO_FILENAME);
    const branded = message('', [new EmbedBuilder({ title: 'Existing', footer: { text: FOOTER_TEXT, icon_url: LOGO_URL } })], [logo]);
    assert.deepEqual(relatedAttachmentIdsFromMessage(branded, draftFromMessage(branded)), new Set(['12']));
});

test('JSON exports round-trip binary files, all draft properties and extra embeds', async () => {
    const file = attachment('301', 'guide.txt', Buffer.from([0, 1, 255]), 'text/plain');
    const image = attachment('302', 'banner.png');
    const draft = new EmbedDraft({
        messageContent: 'Message text', messageAttachments: [new MessageAttachmentDraft(file)], crowControlBranding: true,
        title: 'Exported title', titleUrl: 'https://example.com/title', authorName: 'Author',
        authorIcon: new EmbedMediaDraft({ url: 'https://example.com/author.png' }),
        thumbnail: new EmbedMediaDraft({ url: 'https://example.com/thumb.png' }), description: 'Embed description',
        image: new EmbedMediaDraft({ attachment: image, filename: 'embed-image.png', isNewUpload: true }),
        fields: [new EmbedFieldDraft('Field', 'Value', true)], footerText: 'Footer',
        footerIcon: new EmbedMediaDraft({ url: 'https://example.com/footer.png' }), useCurrentTimestamp: true, color: '#39FF14'
    });
    const exported = await exportMessageJson(draft, { additionalEmbeds: [new EmbedBuilder({ title: 'Second embed' })] });
    const payload = JSON.parse(exported);
    assert.equal(payload.format, MESSAGE_JSON_FORMAT);
    assert.equal(payload.embed.crowControlBranding, undefined);
    const restored = importMessageJson(exported);
    assert.deepEqual(restored.draft.snapshot(), { ...draft.snapshot(), crowControlBranding: false });
    assert.deepEqual(await restored.draft.messageAttachments[0].attachment.read(), Buffer.from([0, 1, 255]));
    assert.deepEqual(await restored.draft.image.attachment.read(), Buffer.from('attachment'));
    assert.equal(restored.additionalEmbeds[0].toJSON().title, 'Second embed');
    assert.deepEqual((await buildMessageAttachmentFiles(restored.draft)).map(item => item.name), ['guide.txt', 'embed-image.png']);
    payload.format = 'crowcontrol-custom-message';
    assert.equal(importMessageJson(JSON.stringify(payload)).draft.title, draft.title);
    for (const format of ['white-walker-custom-message', 'whitewalker-custom-message']) {
        payload.format = format;
        assert.equal(importMessageJson(JSON.stringify(payload)).draft.title, draft.title);
    }
});

test('external Discord JSON import is validated and malformed imports leave no partial result', () => {
    const result = importMessageJson('{"content":"Hello","embeds":[{"title":"Discord JSON","color":16711680},{"title":"Second"}]}');
    assert.equal(result.draft.messageContent, 'Hello');
    assert.equal(result.draft.title, 'Discord JSON');
    assert.equal(result.draft.color, '#FF0000');
    assert.equal(result.additionalEmbeds.length, 1);
    assert.equal(importMessageJson('\ufeff{"title":"BOM"}').draft.title, 'BOM');
    assert.throws(() => importMessageJson('{"content":'), /Invalid JSON at line 1/);
    assert.throws(() => importMessageJson(Buffer.from([0xff, 0xfe, 0x00])), /UTF-8 text encoding/);
    assert.throws(() => importMessageJson('[]'), /JSON root must be an object/);
    assert.throws(() => importMessageJson('{"image":{"url":"attachment://lost.png"}}'), /require embedded file data/);
    assert.throws(() => importMessageJson('{"title":"Bad URL","url":"http://example.com"}'), /Imported message validation failed: Title URL/);
    const exported = { format: MESSAGE_JSON_FORMAT, version: 1, message: {
        content: 'Hello', attachments: [{ filename: 'a.txt', data_base64: '@@@@' }]
    } };
    assert.throws(() => importMessageJson(JSON.stringify(exported)), /invalid Base64 file data/);
    exported.message.attachments[0].data_base64 = 'aGVsbG8=';
    exported.embed = { timestamp: { mode: 'invalid' } };
    assert.throws(() => importMessageJson(JSON.stringify(exported)), /Footer timestamp mode must be/);
});

test('attachment downloads prefer original source and fall back to proxy', async t => {
    const attempts = [];
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async url => {
        attempts.push(url);
        if (url.includes('original')) return { ok: false, status: 404 };
        return { ok: true, arrayBuffer: async () => Buffer.from('proxy') };
    };
    assert.deepEqual(await readAttachmentBytes({ id: '1', name: 'a.png', url: 'https://original', proxyURL: 'https://proxy' }), Buffer.from('proxy'));
    assert.deepEqual(attempts, ['https://original', 'https://proxy']);
    const cached = [];
    assert.deepEqual(await readAttachmentBytes({ async read({ useCached }) {
        cached.push(useCached); if (!useCached) throw new Error('Unavailable'); return Buffer.from('cached');
    } }), Buffer.from('cached'));
    assert.deepEqual(cached, [false, true]);
});

test('property and field diff text distinguishes edits from reordered duplicates', () => {
    const before = new EmbedDraft({ title: 'Before', fields: [new EmbedFieldDraft('One', 'Old')] });
    const after = new EmbedDraft({ title: 'After', fields: [new EmbedFieldDraft('One', 'New')] });
    assert.equal(formatEmbedChanges(before, after), '**Title:** ' + String.fromCharCode(96) + 'Before' + String.fromCharCode(96) +
        ' -> ' + String.fromCharCode(96) + 'After' + String.fromCharCode(96) +
        '\n**Fields removed:** ' + String.fromCharCode(96) + 'One' + String.fromCharCode(96) +
        '\n**Fields added:** ' + String.fromCharCode(96) + 'One' + String.fromCharCode(96) + '\n**Fields edited/reordered at positions:** 1');
    assert.deepEqual(populatedEmbedProperties(after), ['Title', '1 field']);
    assert.equal(formatEmbedChanges(before, before), 'No embed property changes.');
    before.fields = [new EmbedFieldDraft('One', 'A'), new EmbedFieldDraft('Two', 'B')];
    after.title = 'Before'; after.fields = [...before.fields].reverse();
    assert.equal(formatEmbedChanges(before, after), '**Fields:** reordered');
});

test('text-editor branding preserves unrelated attachments and custom footer icons', () => {
    const document = attachment('1', 'document.txt'), logo = attachment('2', LOGO_FILENAME);
    const target = message('', [], [document, logo]);
    const embed = new EmbedBuilder({ title: 'Edited' });
    const result = brandedEditAttachments(target, embed);
    assert.deepEqual(result, { attachments: [document, logo], files: [] });
    assert.deepEqual(embed.toJSON().footer, { text: FOOTER_TEXT, icon_url: LOGO_URL });
    const custom = new EmbedBuilder({ title: 'Custom', footer: { text: 'Custom footer', icon_url: 'https://example.com/custom.png' } });
    assert.deepEqual(brandedEditAttachments(target, custom), { attachments: [document], files: [] });
    assert.equal(custom.toJSON().footer.icon_url, 'https://example.com/custom.png');
});

test('exported CC branding reuses identical named logo bytes after import', async () => {
    const draft = new EmbedDraft({ title: 'Branded export' });
    applyCrowControlBrandingDefaults(draft);
    const { draft: restored } = importMessageJson(await exportMessageJson(draft));
    const files = await buildMediaFiles(restored);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, LOGO_FILENAME);
    restored.messageAttachments = Array.from({ length: 9 }, (_, index) =>
        new MessageAttachmentDraft(attachment('regular-' + index, 'file-' + index + '.txt', Buffer.from(String(index)), 'text/plain')));
    assert.deepEqual(validateEmbedDraft(restored), []);
    assert.equal((await buildMediaFiles(restored)).length, 10);
});

test('JSON syntax diagnostics retain the Python line, column and error wording', () => {
    const { DraftValidationError } = require('../features/message-builder/draft.js');
    const cases = [
        ['{"content":', 'Invalid JSON at line 1, column 12: Expecting value.'],
        ['{x:1}', 'Invalid JSON at line 1, column 2: Expecting property name enclosed in double quotes.'],
        ['{"x" 1}', "Invalid JSON at line 1, column 6: Expecting ':' delimiter."],
        ['{"x":1', "Invalid JSON at line 1, column 7: Expecting ',' delimiter."],
        ['{"x":"hi', 'Invalid JSON at line 1, column 6: Unterminated string starting at.'],
        ['{"x":"\\q"}', 'Invalid JSON at line 1, column 7: Invalid \\escape.'],
        ['{"x":"\\uZZZZ"}', 'Invalid JSON at line 1, column 8: Invalid \\uXXXX escape.'],
        ['{"x":1}more', 'Invalid JSON at line 1, column 8: Extra data.'],
        ['{\n  "x":\n}', 'Invalid JSON at line 3, column 1: Expecting value.']
    ];
    for (const [input, expected] of cases) {
        assert.throws(() => importMessageJson(input), error => error instanceof DraftValidationError && error.message === expected);
    }
    assert.throws(() => normalizeEmbedColor('invalid'), DraftValidationError);
    assert.throws(() => parseEmbedTimestamp('2026-99-99'), DraftValidationError);
});
