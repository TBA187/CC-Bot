/**
 * @fileoverview Verify private builder interactions, permissions, confirmation and message edits with mocked Discord objects.
 * Cover attachments, imported drafts, audit output and recovery from failed interactions.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ComponentType, ButtonStyle, MessageFlags, MessageFlagsBitField } = require('discord.js');
const {
    EmbedBuilderSession,
    BuilderController,
    builderModal,
    formatValidationFailure,
    formatCommitValidationFailure,
    fieldDisplayText,
    fieldEditDefault,
    parseFooterTimestampInput,
} = require('../features/message-builder/editor.js');

function fakeInteraction(overrides = {}) {
    const calls = [];
    const interaction = {
        calls,
        user: { id: 'owner', username: 'officer', tag: 'officer' },
        member: { roles: ['officer-role'] },
        guild: { maximumUploadLimit: 10 * 1024 * 1024 },
        channel: { id: 'origin', send: async () => ({ id: 'sent' }) },
        client: {
            user: { id: 'bot' },
            channels: { cache: new Collection(), fetch: async () => null },
        },
        deferred: false,
        replied: false,
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async deferUpdate(payload) { this.deferred = true; calls.push(['deferUpdate', payload]); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
        async editReply(payload) { calls.push(['editReply', payload]); return { id: 'preview' }; },
        async followUp(payload) { calls.push(['followUp', payload]); },
        async showModal(payload) { this.replied = true; calls.push(['showModal', payload]); },
        isModalSubmit: () => false,
        isButton: () => true,
        isStringSelectMenu: () => false,
        ...overrides,
    };
    return interaction;
}

function jsonRows(view) {
    return view.map(row => typeof row.toJSON === 'function' ? row.toJSON() : row);
}

function allControls(view) {
    return jsonRows(view).flatMap(row => row.components);
}

function modalJSON(session, kind, options) {
    const modal = builderModal(session, kind, options);
    return typeof modal.toJSON === 'function' ? modal.toJSON() : modal;
}

function privateResponse(interaction) {
    return interaction.calls.find(([kind]) => kind === 'reply' || kind === 'followUp')?.[1];
}

function assertPrivate(payload) {
    assert.ok(payload?.ephemeral || (Number(payload?.flags) & MessageFlags.Ephemeral));
}

test('builder validation preserves the source wording and keeps an empty initial draft quiet', () => {
    assert.equal(formatValidationFailure(['Add message content or at least one embed property.']), '');
    const reason = 'Title URL requires a Title.';
    assert.equal(formatValidationFailure([reason]),
        '### Message validation failed\nThe message or embed contains incomplete or invalid information.\n- **Cause:** Title URL requires a Title.');
    assert.equal(formatCommitValidationFailure(['Add message content or at least one embed property.'], { editing: false }),
        '### Message could not be sent ❌\nThe message or embed contains incomplete or invalid information.');
    assert.equal(formatCommitValidationFailure([reason], { editing: true }),
        '### Message could not be saved ❌\nThe message or embed contains incomplete or invalid information.\n- **Cause:** Title URL requires a Title.');
});

test('invisible field names retain the source labels and stable edit marker', () => {
    assert.equal(fieldDisplayText('\u200b'), '[empty field: \\u200b]');
    assert.equal(fieldDisplayText('\u2002'), '[empty field: \\u2002]');
    assert.equal(fieldDisplayText('\u200b\u2002'), '[empty field: \\u2002]');
    assert.equal(fieldDisplayText('\t'), '[empty field]');
    assert.equal(fieldDisplayText('Visible'), 'Visible');
    assert.equal(fieldEditDefault('\u2002'), '\u2063\u200b');
    assert.equal(fieldEditDefault('Visible'), 'Visible');
});

function fixture(draftProps = {}, overrides = {}) {
    const { EmbedDraft } = require('../features/message-builder/draft.js');
    const controller = new BuilderController({
        leaderRoleID: 'leader-role',
        adminRoleID: 'admin-role',
        officerRoleID: 'officer-role',
        blockedEditBotMsgChannels: [],
        ignoredLogChannels: ['origin'],
        ...overrides.config,
    });
    const sent = [];
    const channel = {
        id: '123',
        async send(payload) {
            sent.push(payload);
            return { id: 'new-message', url: 'https://discord.test/new-message' };
        },
        ...overrides.channel,
    };
    const session = controller.createSession({
        ownerId: 'owner',
        target: {
            channel,
            invocationChannelId: 'origin',
            invocationChannel: { id: 'origin', send: async () => ({ id: 'origin-message' }) },
            ...overrides.target,
        },
        draft: new EmbedDraft(draftProps),
    });
    return { controller, session, channel, sent };
}

test('send and edit retain the exact four-row builder controls', () => {
    const { session, channel } = fixture();
    const rows = jsonRows(session.view());
    assert.deepEqual(rows.map(row => row.components.map(component => component.label)), [
        ['Message Content', 'Embed Title', 'Embed Author', 'Embed Thumbnail'],
        ['Embed Description', 'Embed Fields', 'Embed Image', 'Embed Footer'],
        ['Embed Color', 'Channel', 'Import/Export JSON'],
        ['Send', 'Cancel'],
    ]);
    const controls = rows.flatMap(row => row.components);
    assert.deepEqual(Object.fromEntries(controls.map(control => [control.label, control.emoji?.name])), {
        'Message Content': '💬', 'Embed Title': '🏷️', 'Embed Author': '👤', 'Embed Thumbnail': '🖼️',
        'Embed Description': '📝', 'Embed Fields': '📋', 'Embed Image': '🏞️', 'Embed Footer': '📌',
        'Embed Color': '🎨', Channel: '#️⃣', 'Import/Export JSON': '🔄', Send: '📨', Cancel: '🗑️',
    });
    assert.equal(controls.find(component => component.label === 'Send').style, ButtonStyle.Success);
    assert.equal(controls.find(component => component.label === 'Cancel').style, ButtonStyle.Danger);
    assert.equal(controls.find(component => component.label === 'Import/Export JSON').style, ButtonStyle.Secondary);

    const message = { id: 'original', content: 'Existing text', embeds: [{ title: 'Existing' }], attachments: new Collection(), channel };
    const { session: editing } = fixture({ title: 'Existing' }, { target: { message, channel } });
    assert.deepEqual(jsonRows(editing.view()).map(row => row.components.map(component => component.label)), [
        ['Message Content', 'Embed Title', 'Embed Author', 'Embed Thumbnail'],
        ['Embed Description', 'Embed Fields', 'Embed Image', 'Embed Footer'],
        ['Embed Color', 'Import/Export JSON'],
        ['Save', 'Cancel'],
    ]);
    assert.equal(allControls(editing.view()).find(component => component.label === 'Save').emoji.name, '💾');
    assert.ok(editing.builderContent().startsWith('### Edit Custom Bot Message\u2002🤖'));
});

test('the private preview preserves source instructions and omits inactive branding', () => {
    const { session } = fixture();
    assert.equal(session.builderContent(), [
        '### Send Custom Bot Message\u2002🤖',
        '-# - Channel: <#123>',
        '-# - Message content: **Not set**',
        '-# - Message embed: **Not set**',
        '-# Use the **buttons** below to create a message or embed.',
        '### Message/Embed Preview:',
        '-# - No changes made yet.. Use the **buttons** below to create an embed message.',
    ].join('\n'));
    session.draft.messageContent = '**Visible preview text**';
    assert.ok(session.builderContent().endsWith('### Message/Embed Preview:\n**Visible preview text**'));
    assert.ok(session.builderContent().includes('Use the **buttons** below to create an embed.'));
    assert.ok(!session.builderContent().includes('Message content: **'));
    assert.ok(!session.builderContent().includes('Branding'));
});

test('opening a builder defers privately before rendering the preview', async () => {
    const { session } = fixture({ title: 'Preview' });
    const interaction = fakeInteraction();
    await session.open(interaction);
    assert.deepEqual(interaction.calls.map(([kind]) => kind), ['deferReply', 'editReply']);
    assertPrivate(interaction.calls[0][1]);
    assert.equal(interaction.calls[1][1].embeds[0].title ?? interaction.calls[1][1].embeds[0].data?.title, 'Preview');
    assert.equal(interaction.calls[1][1].components.length, 4);
});

test('all builder modals serialize within Discord limits and keep image uploads', () => {
    const { session } = fixture();
    for (const kind of ['content', 'title', 'author', 'thumbnail', 'description', 'image', 'footer', 'channel', 'import', 'field', 'color']) {
        const modal = modalJSON(session, kind);
        assert.ok(modal.components.length <= 5, `${kind} exceeded five modal components`);
        assert.ok(modal.custom_id.startsWith('send_message:modal:'));
    }
    const author = modalJSON(session, 'author');
    assert.deepEqual(author.components.filter(component => component.type === ComponentType.Label).map(component => component.label),
        ['Author Name', 'Author URL', 'Author Icon URL', 'Author Icon upload']);
    assert.equal(author.components[3].component.type, ComponentType.FileUpload);
    const footer = modalJSON(session, 'footer');
    assert.equal(footer.components.length, 5);
    assert.equal(footer.components[2].component.type, ComponentType.FileUpload);
    assert.equal(footer.components[3].label, 'Footer Timestamp');
    const thumbnail = modalJSON(session, 'thumbnail');
    assert.deepEqual(thumbnail.components.map(component => component.type), [ComponentType.TextDisplay, ComponentType.Label, ComponentType.Label]);
    assert.equal(thumbnail.components[2].component.type, ComponentType.FileUpload);
    const content = modalJSON(session, 'content');
    assert.equal(content.components[0].component.placeholder,
        'To include emojis or role mentions, use the message_content option when running the command.');
    assert.ok(content.components[1].content.includes('select **Copy Text**'));
    assert.equal(content.components[2].component.max_values, 10);
});

test('field modals preserve inline defaults and invisible edit placeholders', () => {
    const { session } = fixture();
    let modal = modalJSON(session, 'field');
    const radio = modal.components.find(component => component.component?.type === ComponentType.RadioGroup);
    assert.equal(radio.label, 'Display Inline? (Yes/No)');
    assert.deepEqual(radio.component.options.map(option => [option.label, option.value, option.default]),
        [['Yes', 'yes', true], ['No', 'no', false]]);
    session.draft.fields = [{ name: '\u2002', value: '\u2002', inline: false }];
    modal = modalJSON(session, 'field', { index: 0 });
    assert.equal(modal.components[0].component.value, '\u2063\u200b');
    assert.equal(modal.components[1].component.value, '\u2063\u200b');
    const existingRadio = modal.components.find(component => component.component?.type === ComponentType.RadioGroup);
    assert.deepEqual(existingRadio.component.options.map(option => option.default), [false, true]);
});

test('field and color pages keep the shared preview and complete controls', () => {
    const { session } = fixture({ messageContent: 'Preview content', title: 'Title' });
    session.draft.fields = Array.from({ length: 25 }, (_, index) => ({ name: `${index}`, value: 'Value', inline: true }));
    const fields = allControls(session.view('fields'));
    assert.equal(fields.find(control => control.label === 'Add Field').disabled, true);
    assert.deepEqual(fields.filter(control => control.type === ComponentType.Button).map(control => control.label),
        ['Add Field', 'Edit', 'Delete', 'Move Up', 'Move Down', 'Back to embed builder']);
    const colors = allControls(session.view('color'));
    assert.equal(colors[0].options.length, 25);
    assert.deepEqual(colors.slice(1).map(control => control.label), ['Custom color', 'Remove color', 'Back to embed builder']);
    const transfer = allControls(session.view('json'));
    assert.deepEqual(transfer.map(control => control.label), ['Import JSON', 'Export JSON', 'Back to embed builder']);
});

test('invalid commits report the source private error without editing the preview', async () => {
    const { session, sent } = fixture();
    const interaction = fakeInteraction();
    await session.commit(interaction);
    const response = privateResponse(interaction);
    assert.equal(response.content,
        '### Message could not be sent ❌\nThe message or embed contains incomplete or invalid information.');
    assertPrivate(response);
    assert.equal(sent.length, 0);
    assert.ok(!interaction.calls.some(([kind]) => kind === 'editReply' || kind === 'deferUpdate'));
});

test('successful commits send exactly once and allow everyone, user and role mentions', async () => {
    const { session, sent } = fixture({ messageContent: '<@user> <@&role> @everyone', title: 'Title' });
    const first = fakeInteraction();
    const second = fakeInteraction();
    await session.commit(first);
    await session.commit(second);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, '<@user> <@&role> @everyone');
    assert.deepEqual(sent[0].allowedMentions, { parse: ['everyone', 'users', 'roles'], repliedUser: false });
    assert.equal(privateResponse(second).content, 'This message has already been processed.');
    assert.ok(first.calls.some(([kind, payload]) => kind === 'editReply' && payload.content === 'Embed sent to <#123>.'));
    assert.equal(session.committed, true);
});

test('a failed send leaves the draft retryable and never records success', async () => {
    let attempts = 0;
    const { session } = fixture({ title: 'Retry' }, {
        channel: { async send() { attempts++; if (attempts === 1) throw new Error('offline'); return { id: 'sent', url: 'https://discord.test/sent' }; } },
    });
    const failed = fakeInteraction();
    const savedConsole = console.error;
    console.error = () => {};
    try { await session.commit(failed); } finally { console.error = savedConsole; }
    assert.equal(session.committed, false);
    assert.equal(session.processing, false);
    assert.ok(failed.calls.some(([kind, payload]) => kind === 'editReply' && payload.content.includes('### Message not saved\nDiscord could not complete the request. No success was recorded.')));
    await session.commit(fakeInteraction());
    assert.equal(attempts, 2);
    assert.equal(session.committed, true);
});

test('simultaneous send clicks cannot send the message twice', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let sends = 0;
    const { session } = fixture({ title: 'Concurrent' }, {
        channel: { async send() { sends++; await gate; return { id: 'sent', url: 'https://discord.test/sent' }; } },
    });
    const first = session.commit(fakeInteraction());
    const secondInteraction = fakeInteraction();
    await session.commit(secondInteraction);
    assert.equal(privateResponse(secondInteraction).content, 'This message has already been processed.');
    release();
    await first;
    assert.equal(sends, 1);
});

test('a failed send finishes restoring its preview before retry or cancellation can start', async () => {
    let attempts = 0, release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, session } = fixture({ title: 'Retry after recovery' }, {
        channel: { async send() {
            attempts++;
            if (attempts === 1) throw new Error('offline');
            return { id: 'sent' };
        } }
    });
    controller.logError = () => {};
    const pending = session.commit(fakeInteraction({ async editReply() { entered(); await gate; } }));
    await started;
    const retry = fakeInteraction(), cancel = fakeInteraction();
    await session.commit(retry);
    await session.cancel(cancel);
    for (const click of [retry, cancel]) {
        assert.equal(privateResponse(click).content, 'This message has already been processed.');
        assertPrivate(privateResponse(click));
    }
    assert.equal(attempts, 1);
    assert.equal(controller.sessions.get(session.sessionId), session);
    release();
    await pending;
    assert.equal(session.processing, false);
    await session.commit(fakeInteraction());
    assert.equal(attempts, 2);
    assert.equal(session.committed, true);
});

test('builder controls cannot cancel or change a message while publication is in progress', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { controller, session } = fixture({ title: 'Confirmed title' }, {
        channel: { async send() { await gate; return { id: 'sent' }; } }
    });
    const cancel = buttonInteraction(session, 'Cancel');
    const pending = session.commit(fakeInteraction());
    await controller.handleButton(cancel);
    assert.equal(privateResponse(cancel).content, 'This message has already been processed.');
    assert.equal(controller.sessions.get(session.sessionId), session);
    release();
    await pending;
    assert.equal(session.committed, true);
});

test('a failed cancellation acknowledgement leaves the builder session usable', async () => {
    const { controller, session } = fixture({ title: 'Keep this draft' });
    const interaction = fakeInteraction({ deferUpdate: async () => { throw new Error('expired'); } });
    await assert.rejects(session.cancel(interaction), /expired/);
    assert.equal(controller.sessions.get(session.sessionId), session);
    assert.equal(session.draft.title, 'Keep this draft');
    assert.equal(session.processing, false);
});

test('a commit cannot start while Discord is acknowledging cancellation', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { session } = fixture({ title: 'Cancel this draft' }, {
        channel: { send: async () => assert.fail('Canceled draft was published') }
    });
    const cancel = session.cancel(fakeInteraction({ deferUpdate: () => gate }));
    const commit = fakeInteraction();
    await session.commit(commit);
    assert.equal(privateResponse(commit).content, 'This message has already been processed.');
    release();
    await cancel;
});

test('cancel removes all preview contents and closes the session', async () => {
    const { controller, session } = fixture({ title: 'Preview' });
    const interaction = fakeInteraction();
    await session.cancel(interaction);
    const edit = interaction.calls.find(([kind]) => kind === 'editReply')[1];
    assert.equal(edit.content, 'Embed builder canceled.');
    assert.deepEqual(edit.embeds, []);
    assert.deepEqual(edit.attachments, []);
    assert.deepEqual(edit.components, []);
    assert.ok(!Array.from(controller.sessions.values()).includes(session));
});

test('an in-flight JSON import blocks publication and cancellation until its preview is ready', async () => {
    const { controller, session, sent } = fixture({ messageContent: 'Reviewed original' });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const upload = { id: 'json', name: 'message.json', async read() {
        entered(); await gate; return Buffer.from(JSON.stringify({ content: 'Imported content' }));
    } };
    const send = buttonInteraction(session, 'Send');
    const update = modalInteraction(session, 'import', { message_json_upload: [upload] });
    const pending = controller.handleModal(update);
    await started;
    await controller.handleButton(send);
    const cancel = fakeInteraction();
    await session.cancel(cancel);
    for (const click of [send, cancel]) {
        assert.match(privateResponse(click).content, /preview is still updating/u);
        assertPrivate(privateResponse(click));
    }
    assert.equal(sent.length, 0);
    assert.equal(session.draft.messageContent, 'Reviewed original');
    assert.equal(controller.sessions.get(session.sessionId), session);
    release(); await pending;
    assert.equal(session.updating, false);
    assert.equal(session.draft.messageContent, 'Imported content');
    assert.match(update.calls.find(([kind]) => kind === 'editReply')[1].content, /JSON imported successfully/u);
    await session.commit(fakeInteraction());
    assert.deepEqual(sent.map(payload => payload.content), ['Imported content']);
    assert.equal(controller.sessions.has(session.sessionId), false);
});

test('destination lookup must finish before a draft can be sent or canceled', async () => {
    const { controller, session, sent } = fixture({ messageContent: 'Reviewed message' });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const destinationMessages = [];
    const destination = { id: 'destination', async send(payload) {
        destinationMessages.push(payload); return { id: 'sent' };
    } };
    const update = modalInteraction(session, 'channel', { destination_channel: [{ id: 'destination' }] }, {
        client: { channels: { cache: new Collection(), async fetch() { entered(); await gate; return destination; } } }
    });
    const pending = controller.handleModal(update);
    await started;
    const send = fakeInteraction(), cancel = fakeInteraction();
    await session.commit(send);
    await session.cancel(cancel);
    assert.match(privateResponse(send).content, /preview is still updating/u);
    assert.match(privateResponse(cancel).content, /preview is still updating/u);
    assert.equal(sent.length, 0);
    assert.equal(destinationMessages.length, 0);
    release(); await pending;
    assert.equal(session.target.channel, destination);
    assert.equal(session.updating, false);
    await session.commit(fakeInteraction());
    assert.equal(destinationMessages.length, 1);
    assert.equal(sent.length, 0);
});

test('ordinary edits keep publication blocked until Discord renders the changed preview', async () => {
    const { controller, session, sent } = fixture({ title: 'Original title' });
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const update = modalInteraction(session, 'title', { title: 'Updated title' }, {
        async editReply() { entered(); await gate; }
    });
    const pending = controller.handleModal(update);
    await started;
    const send = fakeInteraction();
    await session.commit(send);
    assert.match(privateResponse(send).content, /preview is still updating/u);
    assert.equal(sent.length, 0);
    release(); await pending;
    await session.commit(fakeInteraction());
    assert.equal(sent[0].embeds[0].data.title, 'Updated title');
});

test('a failed import releases the preview guard and leaves the original draft usable', async () => {
    const { controller, session, sent } = fixture({ messageContent: 'Original content' });
    controller.logError = () => {};
    const upload = { id: 'json', name: 'message.json', async read() { throw new Error('offline'); } };
    await controller.handleModal(modalInteraction(session, 'import', { message_json_upload: [upload] }));
    assert.equal(session.updating, false);
    assert.equal(session.draft.messageContent, 'Original content');
    await session.commit(fakeInteraction());
    assert.deepEqual(sent.map(payload => payload.content), ['Original content']);
});

test('footer timestamp input accepts every source NOW alias and UTC datetimes', () => {
    for (const value of ['NOW', 'now', 'N0W', 'nov', 'current', 'datetime', 'current datetime', 'time', 'live time', 'realtime', 'real time', 'now()', 'timestamp', 'current timestamp', 'current date and time']) {
        assert.deepEqual(parseFooterTimestampInput(value), { timestamp: null, useCurrentTimestamp: true });
    }
    assert.deepEqual(parseFooterTimestampInput(''), { timestamp: null, useCurrentTimestamp: false });
    const manual = parseFooterTimestampInput('2026-07-18T12:30:00+00:00');
    assert.equal(manual.useCurrentTimestamp, false);
    assert.equal(manual.timestamp.toISOString(), '2026-07-18T12:30:00.000Z');
});


function modalInteraction(session, kind, fields = {}, overrides = {}, context = {}) {
    const modal = modalJSON(session, kind, context);
    return fakeInteraction({
        customId: modal.custom_id,
        isButton: () => false,
        isModalSubmit: () => true,
        fields: {
            getTextInputValue(id) { return fields[id] ?? ''; },
            getUploadedFiles(id) { return new Collection((fields[id] || []).map(file => [file.id, file])); },
            getCheckbox(id) { return fields[id] === true; },
            getRadioGroup(id) { return fields[id] ?? 'yes'; },
            getSelectedChannels(id) { return new Collection((fields[id] || []).map(channel => [channel.id, channel])); },
        },
        ...overrides,
    });
}

function buttonInteraction(session, label, page = 'builder', selectedIndex = null, overrides = {}) {
    const control = allControls(session.view(page, selectedIndex)).find(component => component.label === label);
    assert.ok(control, `Missing button ${label}`);
    return fakeInteraction({ customId: control.custom_id, ...overrides });
}

test('controller navigation acknowledges before updating and protects session ownership', async () => {
    const { controller, session } = fixture({ title: 'Preview' });
    const action = buttonInteraction(session, 'Embed Fields');
    assert.equal(await controller.handleButton(action), true);
    assert.deepEqual(action.calls.map(([kind]) => kind), ['deferUpdate', 'editReply']);
    assert.ok(action.calls[1][1].content.startsWith('### Embed Fields'));
    const outsider = buttonInteraction(session, 'Embed Title', 'builder', null, { user: { id: 'other-user' } });
    assert.equal(await controller.handleButton(outsider), true);
    assert.equal(privateResponse(outsider).content, 'This embed builder belongs to another user.');
    assertPrivate(privateResponse(outsider));
    assert.ok(!outsider.calls.some(([kind]) => kind === 'showModal'));
    assert.equal(await controller.handleButton(fakeInteraction({ customId: 'unrelated' })), false);
});

test('stale send and edit sessions preserve their exact recovery instructions', async () => {
    const controller = new BuilderController();
    for (const mode of ['send', 'edit']) {
        const interaction = fakeInteraction({ customId: `send_message:missing:${mode}:old` });
        assert.equal(await controller.handleButton(interaction), true);
        const response = privateResponse(interaction);
        assertPrivate(response);
        assert.equal(response.content,
            '### Embed builder session ended\nThis preview was opened before the bot restarted. ' +
            (mode === 'edit'
                ? 'Right-click the **original public Crow Control bot message**, then select **Apps → Edit Bot Embed (Officer)** again.'
                : 'Run the `/send_message` command again to start a new builder.'));
    }
    const { controller: recentlyClosed, session } = fixture();
    const oldId = allControls(session.view())[0].custom_id;
    session.finish();
    const delayed = fakeInteraction({ customId: oldId });
    assert.equal(await recentlyClosed.handleButton(delayed), true);
    assert.deepEqual(delayed.calls, []);
});

test('title dependencies and HTTPS errors leave the draft unchanged', async () => {
    const { controller, session } = fixture({ title: 'Original', titleUrl: 'https://example.com' });
    for (const [fields, error] of [
        [{ title: '', title_url: 'https://example.com' }, 'Add a Title before setting its URL.'],
        [{ title: 'Changed', title_url: 'http://example.com' }, 'Title URL must be a valid HTTPS URL.'],
    ]) {
        const interaction = modalInteraction(session, 'title', fields);
        await controller.handleModal(interaction);
        assert.equal(privateResponse(interaction).content, '### Invalid value\n- ' + error);
        assert.equal(session.draft.title, 'Original');
        assert.equal(session.draft.titleUrl, 'https://example.com');
    }
});

test('media removal takes priority and invalid uploads preserve existing media', async () => {
    const { controller, session } = fixture({ thumbnail: { url: 'https://example.com/old.png' } });
    const invalid = { id: 'txt', name: 'document.txt', contentType: 'text/plain', data: Buffer.from('text') };
    const badUpload = modalInteraction(session, 'thumbnail', { thumbnail_url: 'https://example.com/new.png', thumbnail_upload: [invalid] });
    await controller.handleModal(badUpload);
    assert.equal(privateResponse(badUpload).content, '### Invalid value\n- Thumbnail upload must be an image file.');
    assert.equal(session.draft.thumbnail.url, 'https://example.com/old.png');
    const removal = modalInteraction(session, 'thumbnail', { thumbnail_url: 'https://example.com/new.png', thumbnail_upload: [invalid], remove_thumbnail: true });
    await controller.handleModal(removal);
    assert.equal(session.draft.thumbnail.hasSource, false);
    assert.deepEqual(removal.calls.map(([kind]) => kind), ['deferUpdate', 'editReply']);
});

test('content uploads replace attachments and can be removed without changing the embed', async () => {
    const { ImportedAttachment, MessageAttachmentDraft } = require('../features/message-builder/draft.js');
    const first = new ImportedAttachment({ id: 'first', filename: 'first.txt', data: Buffer.from('first') });
    const second = new ImportedAttachment({ id: 'second', filename: 'second.txt', data: Buffer.from('second') });
    const { controller, session } = fixture({ title: 'Keep title', messageAttachments: [new MessageAttachmentDraft(first)] });
    const replace = modalInteraction(session, 'content', { message_content: 'Line 1\\nLine 2', message_attachments: [second], remove_message_attachments: true });
    await controller.handleModal(replace);
    assert.equal(session.draft.messageContent, 'Line 1\nLine 2');
    assert.equal(session.draft.messageAttachments[0].attachment, second);
    assert.equal(session.draft.title, 'Keep title');
    const preview = replace.calls.find(([kind]) => kind === 'editReply')[1];
    assert.deepEqual(preview.attachments, []);
    assert.equal(preview.files[0].name, 'second.txt');
    const remove = modalInteraction(session, 'content', { message_content: '', remove_message_attachments: true });
    await controller.handleModal(remove);
    assert.deepEqual(session.draft.messageAttachments, []);
    assert.equal(session.draft.title, 'Keep title');
});

test('channel changes and clearing selection reset the original destination without activating validation', async () => {
    const { controller, session } = fixture();
    const selected = { id: '456', send: async () => ({ id: 'sent' }) };
    const change = modalInteraction(session, 'channel', { destination_channel: [selected] });
    await controller.handleModal(change);
    assert.equal(session.target.channel, selected);
    assert.equal(session.validationActive, false);
    const reset = modalInteraction(session, 'channel');
    await controller.handleModal(reset);
    assert.equal(session.target.channel, session.target.invocationChannel);
    assert.equal(session.validationActive, false);
});

test('field submissions support fillers, inline selection, reordering and deletion', async () => {
    const { controller, session } = fixture({ title: 'Fields' });
    const add = modalInteraction(session, 'field', { field_name: '\\u2002', field_value: '\\u200b', field_inline: 'no' });
    await controller.handleModal(add);
    assert.deepEqual({ ...session.draft.fields[0] }, { name: '\u2002', value: '\u200b', inline: false });
    assert.ok(add.calls.find(([kind]) => kind === 'editReply')[1].content.includes('Field added *[empty field: \\u2002]*'));
    const edit = modalInteraction(session, 'field', { field_name: '\u2063\u200b', field_value: 'Updated', field_inline: 'yes' }, {}, { index: 0 });
    await controller.handleModal(edit);
    assert.equal(session.draft.fields[0].name, '\u2002');
    assert.equal(session.draft.fields[0].inline, true);
    const addSecond = modalInteraction(session, 'field', { field_name: 'Second', field_value: 'Value', field_inline: 'yes' });
    await controller.handleModal(addSecond);
    await controller.handleButton(buttonInteraction(session, 'Move Up', 'fields', 1));
    assert.equal(session.draft.fields[0].name, 'Second');
    await controller.handleButton(buttonInteraction(session, 'Delete', 'fields', 0));
    assert.equal(session.draft.fields.length, 1);
    assert.equal(session.draft.fields[0].name, '\u2002');
});

test('saving the first embed keeps additional embeds and unrelated attachments', async () => {
    const { ImportedAttachment, draftFromMessage } = require('../features/message-builder/draft.js');
    const document = new ImportedAttachment({ id: 'document', filename: 'guide.txt', data: Buffer.from('guide') });
    const edits = [];
    const channel = { id: '123', send: async () => ({}), messages: { fetch: async () => message } };
    const message = { id: 'original', author: { id: 'bot' }, content: 'Old content', embeds: [{ title: 'Old' }, { title: 'Keep' }], attachments: new Collection([['document', document]]), channel,
        async edit(payload) { edits.push(payload); return { ...message, url: 'https://discord.test/original' }; } };
    const { session } = fixture({}, { target: { message, channel } });
    session.draft = draftFromMessage(message);
    session.draft.title = 'New';
    await session.commit(fakeInteraction());
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].embeds.map(embed => embed.data?.title ?? embed.title), ['New', 'Keep']);
    assert.deepEqual(edits[0].attachments, [document]);
    assert.equal(edits[0].files.length, 0);
});

test('JSON import validates before replacing and rolls back the draft when preview rendering fails', async () => {
    const { ImportedAttachment } = require('../features/message-builder/draft.js');
    const { controller, session } = fixture({ title: 'Original', messageContent: 'Keep content' });
    const original = session.draft;
    const invalid = new ImportedAttachment({ id: 'invalid', filename: 'invalid.json', data: Buffer.from('{invalid') });
    await controller.handleModal(modalInteraction(session, 'import', { message_json_upload: [invalid] }));
    assert.equal(session.draft, original);
    const upload = new ImportedAttachment({ id: 'json', filename: 'message.json', data: Buffer.from(JSON.stringify({ content: 'Imported', embeds: [{ title: 'New' }, { title: 'Extra' }] })) });
    const savedIds = new Set(allControls(session.view()).map(component => component.custom_id));
    const imported = modalInteraction(session, 'import', { message_json_upload: [upload] }, {
        async editReply() { throw new Error('preview failed'); },
    });
    controller.logError = () => {};
    await controller.handleModal(imported);
    assert.equal(session.draft, original);
    assert.deepEqual(session.additionalEmbeds, []);
    assert.equal(privateResponse(imported).content,
        '### JSON import failed\n- Discord could not render the imported preview. The current draft was not changed.');
    for (const id of savedIds) assert.ok(session.actions.has(id));
    const success = modalInteraction(session, 'import', { message_json_upload: [upload] });
    await controller.handleModal(success);
    assert.equal(session.draft.title, 'New');
    assert.equal(session.draft.messageContent, 'Imported');
    assert.equal(session.additionalEmbeds[0].data?.title ?? session.additionalEmbeds[0].title, 'Extra');
});

test('empty JSON exports report the source private feedback', async () => {
    const { controller, session } = fixture();
    const interaction = buttonInteraction(session, 'Export JSON', 'json');
    await controller.handleButton(interaction);
    assert.equal(privateResponse(interaction).content,
        "You can't export an empty message embed! Import or create an embed first.");
    assertPrivate(privateResponse(interaction));
});

test('attachment read failures use the source generic import and export feedback', async () => {
    const { MessageAttachmentDraft } = require('../features/message-builder/draft.js');
    const unreadable = { id: 'bad', name: 'bad.json', size: 10, async read() { throw new Error('offline'); } };
    const { controller, session } = fixture({ title: 'Original' });
    controller.logError = () => {};
    const importFailure = modalInteraction(session, 'import', { message_json_upload: [unreadable] });
    await controller.handleModal(importFailure);
    assert.equal(privateResponse(importFailure).content,
        '### JSON import failed\n- The uploaded file could not be read. The current draft was not changed.');
    session.draft.messageAttachments = [new MessageAttachmentDraft(unreadable)];
    const exportFailure = buttonInteraction(session, 'Export JSON', 'json');
    await controller.handleButton(exportFailure);
    assert.equal(privateResponse(exportFailure).content,
        '### JSON export failed\n- An attachment could not be read or the file could not be created. Please try again.');
});


test('Discord preview failures from a modal use the source builder error wording', async () => {
    const { controller, session } = fixture({ title: 'Original' });
    controller.logError = () => {};
    const interaction = modalInteraction(session, 'title', { title: 'Updated', title_url: '' }, {
        async editReply() { throw new Error('Discord unavailable'); },
    });
    await controller.handleModal(interaction);
    assert.equal(privateResponse(interaction).content,
        '### Builder action failed\nThe submitted changes were not saved. Please try again.');
    assertPrivate(privateResponse(interaction));
});

test('send command metadata, staff permissions and Crow Control defaults remain consistent', async () => {
    const SendMessage = require('../commands/send_message.js');
    const { FOOTER_TEXT, LOGO_FILENAME, CROW_CONTROL_BRANDING_COLOR } = require('../features/message-builder/draft.js');
    const command = new SendMessage({ leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role' });
    const slash = command.data[0].toJSON();
    const context = command.data[1].toJSON();
    assert.equal(slash.name, 'send_message');
    assert.equal(slash.description,
        'Send a custom bot message or embed. Command opens a builder to customize the message before sending.');
    assert.deepEqual(slash.options.map(option => option.name), ['channel', 'message_content', 'crow_control_branding']);
    assert.ok(slash.options.every(option => !option.required));
    assert.equal(context.name, 'Edit Bot Embed (Officer)');
    for (const role of ['leader-role', 'admin-role', 'officer-role']) {
        const interaction = fakeInteraction({
            member: { roles: { cache: new Collection([[role, { id: role }]]) } },
            options: { getChannel: () => null, getString: id => ({ message_content: 'Line 1\\nLine 2', crow_control_branding: 'yes' })[id] },
        });
        await command.handleSlash(interaction);
        assert.deepEqual(interaction.calls.map(([kind]) => kind), ['deferReply', 'editReply']);
        const session = Array.from(command.sessions.values()).at(-1);
        assert.equal(session.draft.messageContent, 'Line 1\nLine 2');
        assert.equal(session.draft.footerText, FOOTER_TEXT);
        assert.equal(session.draft.color, CROW_CONTROL_BRANDING_COLOR);
        assert.equal(session.draft.useCurrentTimestamp, true);
        assert.ok(session.draft.thumbnail.attachment?.filename === LOGO_FILENAME || session.draft.thumbnail.url);
        assert.ok(session.builderContent().includes('-# - Crow Control Branding: **Yes**'));
        const thumbnail = modalJSON(session, 'thumbnail');
        const footer = modalJSON(session, 'footer');
        assert.equal(thumbnail.components[1].component.value, session.draft.thumbnail.inputUrl);
        assert.equal(footer.components[0].component.value, FOOTER_TEXT);
        assert.equal(footer.components[3].component.value, 'NOW');
    }
    const outsider = fakeInteraction({ member: { roles: { cache: new Collection([['member', { id: 'member' }]]) } } });
    await command.handleSlash(outsider);
    assert.equal(privateResponse(outsider).content, '### No permission!');
    assertPrivate(privateResponse(outsider));
});

test('embed context menu permits each requested role and guards other bots and blocked channels', async () => {
    const SendMessage = require('../commands/send_message.js');
    const command = new SendMessage({ leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role', blockedEditBotMsgChannels: ['blocked'] });
    const channel = { id: '123', send: async () => ({}) };
    const message = { id: 'original', content: 'Text-only', embeds: [], attachments: new Collection(), author: { id: 'bot' }, channel, channelId: '123' };
    for (const role of ['leader-role', 'admin-role', 'officer-role']) {
        const interaction = fakeInteraction({ member: { roles: { cache: new Collection([[role, { id: role }]]) } }, targetMessage: message });
        await command.handleContext(interaction);
        assert.deepEqual(interaction.calls.map(([kind]) => kind), ['deferReply', 'editReply']);
        const session = Array.from(command.sessions.values()).at(-1);
        assert.equal(session.editing, true);
        assert.equal(session.draft.messageContent, 'Text-only');
        assert.equal(session.draft.hasEmbedProperties(), false);
    }
    const authorized = { roles: { cache: new Collection([['officer-role', { id: 'officer-role' }]]) } };
    const other = fakeInteraction({ member: authorized, targetMessage: { ...message, author: { id: 'other-bot' } } });
    await command.handleContext(other);
    assert.equal(privateResponse(other).content, 'Only Crow Control bot messages can be edited.');
    const blocked = fakeInteraction({ member: authorized, targetMessage: { ...message, channelId: 'blocked', channel: { ...channel, id: 'blocked' } } });
    await command.handleContext(blocked);
    assert.equal(privateResponse(blocked).content, 'Editing bot messages is not allowed in this channel.');
});


test('failed initial preview delivery removes the inaccessible builder session and handlers', async () => {
    for (const failedMethod of ['deferReply', 'editReply']) {
        const { controller, session } = fixture({ title: 'Preview' });
        // Include a modal context to verify complete cleanup, beyond its session map entry.
        modalJSON(session, 'title');
        assert.ok(session.modalContexts.size > 0);
        const failure = new Error(`${failedMethod} unavailable`);
        const interaction = fakeInteraction({
            async [failedMethod]() { throw failure; },
        });
        await assert.rejects(() => session.open(interaction), error => error === failure);
        assert.ok(!controller.sessions.has(session.sessionId));
        assert.equal(session.actions.size, 0);
        assert.equal(session.modalContexts.size, 0);
        assert.ok(!controller.closed.has(session.sessionId));
    }
});


test('saving an embed restores visibility after manual suppression and preserves other flags', async () => {
    const { draftFromMessage } = require('../features/message-builder/draft.js');
    const edits = [];
    const channel = { id: '123', send: async () => ({}), messages: { fetch: async () => message } };
    const message = {
        id: 'original', author: { id: 'bot' }, content: 'Old content', embeds: [], attachments: new Collection(), channel,
        flags: new MessageFlagsBitField([MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications]),
        async edit(payload) { edits.push(payload); return { ...message, url: 'https://discord.test/original' }; }
    };
    const { session } = fixture({}, { target: { message, channel } });
    session.draft = draftFromMessage(message);
    session.draft.title = 'Replacement';
    await session.commit(fakeInteraction());
    assert.equal(edits.length, 1);
    assert.equal(edits[0].embeds[0].toJSON().title, 'Replacement');
    assert.equal(edits[0].flags, MessageFlags.SuppressNotifications);
    assert.equal(message.flags.has(MessageFlags.SuppressEmbeds), true);
});

test('saving a text-only draft leaves the original suppression flag unchanged', async () => {
    const { draftFromMessage } = require('../features/message-builder/draft.js');
    const edits = [];
    const channel = { id: '123', send: async () => ({}), messages: { fetch: async () => message } };
    const message = {
        id: 'original', author: { id: 'bot' }, content: 'Old content', embeds: [], attachments: new Collection(), channel,
        flags: new MessageFlagsBitField(MessageFlags.SuppressEmbeds),
        async edit(payload) { edits.push(payload); return { ...message, url: 'https://discord.test/original' }; }
    };
    const { session } = fixture({}, { target: { message, channel } });
    session.draft = draftFromMessage(message);
    session.draft.messageContent = 'Updated text';
    await session.commit(fakeInteraction());
    assert.equal(edits.length, 1);
    assert.equal(edits[0].content, 'Updated text');
    assert.equal(Object.hasOwn(edits[0], 'flags'), false);
    assert.equal(message.flags.has(MessageFlags.SuppressEmbeds), true);
});

function controlledPromise() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function editAuthorizationFixture() {
    const edits = [];
    const channel = { id: '123', messages: { fetch: async () => message } };
    const message = { id: 'original', channelId: '123', channel, author: { id: 'bot' }, content: 'Original',
        embeds: [], attachments: new Collection(), async edit(payload) { edits.push(payload); return message; } };
    return { ...fixture({ messageContent: 'Replacement' }, { target: { message, channel } }), channel, message, edits };
}

test('builder publication rejects revoked roles, wrong owners and inactive sessions before lookup', async () => {
    for (const reason of ['role', 'owner', 'session']) {
        const state = editAuthorizationFixture();
        state.channel.messages.fetch = () => assert.fail('Unauthorized publication must not fetch');
        const interaction = fakeInteraction();
        if (reason === 'role') interaction.member.roles = [];
        if (reason === 'owner') interaction.user.id = 'someone-else';
        if (reason === 'session') state.controller.sessions.delete(state.session.sessionId);
        await state.session.commit(interaction);
        assertPrivate(privateResponse(interaction));
        assert.equal(state.edits.length, 0);
        assert.equal(state.session.processing, false);
        assert.equal(interaction.calls.some(([type]) => type === 'deferUpdate'), false);
    }
});

test('builder edits recheck live authorization and resolved targets after lookup', async () => {
    for (const reason of ['role', 'owner', 'session', 'author', 'configured-destination', 'resolved-destination']) {
        const state = editAuthorizationFixture();
        const started = controlledPromise(), lookup = controlledPromise();
        state.channel.messages.fetch = async () => { started.resolve(); return lookup.promise; };
        const interaction = fakeInteraction();
        interaction.guild.members = { cache: new Collection([['owner', interaction.member]]) };
        const pending = state.session.commit(interaction);
        await started.promise;
        let fetched = state.message;
        if (reason === 'role') interaction.guild.members.cache.set('owner', { roles: [] });
        if (reason === 'owner') state.session.ownerId = 'someone-else';
        if (reason === 'session') state.controller.sessions.delete(state.session.sessionId);
        if (reason === 'author') fetched = { ...state.message, author: { id: 'another-bot' } };
        if (reason === 'configured-destination') state.controller.config.blockedEditBotMsgChannels.push('123');
        if (reason === 'resolved-destination') {
            state.controller.config.blockedEditBotMsgChannels.push('blocked');
            fetched = { ...state.message, channelId: 'blocked', channel: { id: 'blocked' } };
        }
        lookup.resolve(fetched);
        await pending;
        assert.equal(state.edits.length, 0, reason);
        assert.equal(state.session.committed, false, reason);
        assert.equal(state.session.processing, false, reason);
        assertPrivate(privateResponse(interaction));
        assert.equal(interaction.calls.some(([type]) => type === 'editReply'), false, reason);
    }
});

test('builder send rechecks cached membership after attachment loading and remains retryable', async () => {
    const { MessageAttachmentDraft } = require('../features/message-builder/draft.js');
    const started = controlledPromise(), read = controlledPromise();
    const state = fixture({ messageContent: 'With attachment' });
    state.session.draft.messageAttachments.push(new MessageAttachmentDraft({
        id: 'upload', name: 'guide.txt', async read() { started.resolve(); await read.promise; return Buffer.from('guide'); },
    }));
    const interaction = fakeInteraction();
    interaction.guild.members = { cache: new Collection([['owner', interaction.member]]) };
    const pending = state.session.commit(interaction);
    await started.promise;
    interaction.guild.members.cache.set('owner', { roles: [] });
    read.resolve();
    await pending;
    assert.equal(state.sent.length, 0);
    assertPrivate(privateResponse(interaction));
    assert.equal(state.session.processing, false);
    assert.equal(state.controller.sessions.get(state.session.sessionId), state.session);
    await state.session.commit(fakeInteraction());
    assert.equal(state.sent.length, 1);
});

test('failed authorization feedback leaves an unpublished builder edit retryable', async () => {
    const state = editAuthorizationFixture();
    const interaction = fakeInteraction({ async followUp() { throw new Error('feedback unavailable'); } });
    state.channel.messages.fetch = async () => {
        interaction.member.roles = [];
        return state.message;
    };
    await assert.rejects(state.session.commit(interaction), /feedback unavailable/);
    assert.equal(state.edits.length, 0);
    assert.equal(state.session.processing, false);
    assert.equal(state.controller.sessions.get(state.session.sessionId), state.session);
    assert.equal(interaction.calls.some(([type]) => type === 'editReply'), false);
    state.channel.messages.fetch = async () => state.message;
    await state.session.commit(fakeInteraction());
    assert.equal(state.edits.length, 1);
});

test('blocked edit channels still allow new builder messages', async () => {
    const { session, sent } = fixture({ messageContent: 'New message' }, { config: { blockedEditBotMsgChannels: ['123'] } });
    await session.commit(fakeInteraction());
    assert.equal(sent.length, 1);
});

test('builder cancellation rechecks membership, ownership and session identity after acknowledgement', async () => {
    for (const reason of ['role', 'owner', 'session']) {
        const { controller, session } = fixture({ messageContent: 'Keep the draft' });
        const acknowledged = controlledPromise();
        const interaction = fakeInteraction({ async deferUpdate() { this.deferred = true; await acknowledged.promise; } });
        const pending = session.cancel(interaction);
        if (reason === 'role') interaction.member.roles = [];
        if (reason === 'owner') session.ownerId = 'someone-else';
        if (reason === 'session') controller.sessions.delete(session.sessionId);
        acknowledged.resolve();
        await pending;
        assert.equal(session.processing, false);
        assert.equal(interaction.calls.some(([type]) => type === 'editReply'), false);
        assertPrivate(privateResponse(interaction));
        assert.equal(controller.closed.has(session.sessionId), false);
        if (reason !== 'session') assert.equal(controller.sessions.get(session.sessionId), session);
    }
});

test('successful builder edits remain committed when final feedback and audit fail', async () => {
    const state = editAuthorizationFixture();
    state.controller.logError = () => {};
    state.session.audit = async () => { throw new Error('audit unavailable'); };
    const feedback = [];
    await state.session.commit(fakeInteraction({ async editReply(payload) { feedback.push(payload); throw new Error('feedback unavailable'); } }));
    const duplicate = fakeInteraction();
    await state.session.commit(duplicate);
    assert.equal(state.edits.length, 1);
    assert.equal(state.session.committed, true);
    assert.equal(state.controller.sessions.has(state.session.sessionId), false);
    assert.deepEqual(feedback.map(payload => payload.content), ['Embed updated in <#123>.']);
    assert.match(privateResponse(duplicate).content, /already been processed/);
});
