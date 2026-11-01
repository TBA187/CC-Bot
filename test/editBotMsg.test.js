const test = require('node:test');
const assert = require('node:assert/strict');

const EditBotMsg = require('../commands/edit_bot_msg.js');

test('/edit_bot_msg acknowledges the interaction before fetching the target message', async () => {
    const calls = [];
    const command = new EditBotMsg({
        adminRoleID: 'admin-role',
        blockedEditBotMsgChannels: [],
        onCooldown: () => false
    });
    const interaction = {
        user: { id: 'admin-user' },
        member: {
            roles: {
                cache: {
                    some: callback => callback({ id: 'admin-role' })
                }
            }
        },
        options: {
            getString: name => ({
                channel_id: 'channel-id',
                message_id: 'message-id',
                content: 'Updated message'
            })[name]
        },
        client: {
            user: { id: 'bot-user' },
            channels: {
                fetch: async () => {
                    calls.push('fetch-channel');
                    return {
                        messages: {
                            fetch: async () => {
                                calls.push('fetch-message');
                                return {
                                    author: { id: 'bot-user' },
                                    edit: async () => calls.push('edit-message')
                                };
                            }
                        }
                    };
                }
            }
        },
        deferReply: async () => calls.push('defer-reply'),
        editReply: async content => calls.push(`edit-reply:${content}`)
    };

    await command.handleSlash(interaction);

    assert.deepEqual(calls, [
        'defer-reply',
        'fetch-channel',
        'fetch-message',
        'edit-message',
        'edit-reply:### ✅  Message edited!'
    ]);
});

const { Collection, MessageFlags, MessageFlagsBitField } = require('discord.js');

function fixture(role = 'officer-role', config = {}) {
    const calls = [];
    const message = {
        id: '123', channelId: '456', content: 'Old text  \n', embeds: [],
        attachments: new Collection([['file-id', { id: 'file-id', name: 'guide.txt' }]]),
        author: { id: 'bot-user' }, url: 'https://discord.com/channels/guild/456/123',
        edit: async payload => calls.push(['edit-message', payload])
    };
    const channel = { id: '456', messages: { fetch: async () => message } };
    const command = new EditBotMsg({
        leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role',
        onCooldown: () => false, ...config
    });
    const interaction = {
        user: { id: 'officer-user', username: 'Officer' },
        member: { roles: { cache: new Collection([[role, { id: role }]]) } },
        targetMessage: message,
        options: { getString: name => ({ channel_id: '456', message_id: '123', content: 'New\\ntext' })[name] },
        client: { user: { id: 'bot-user' }, channels: { fetch: async () => channel } },
        reply: async payload => calls.push(['reply', payload]),
        followUp: async payload => calls.push(['follow-up', payload]),
        editReply: async payload => calls.push(['edit-reply', payload]),
        deferReply: async payload => calls.push(['defer-reply', payload]),
        deferUpdate: async () => calls.push(['defer-update']),
        update: async payload => calls.push(['update', payload]),
        showModal: async modal => calls.push(['modal', modal])
    };
    return { command, interaction, calls, message, channel };
}

async function previewEdit(state, values) {
    const modal = {
        ...state.interaction,
        customId: 'editMsg_123_456',
        fields: { getTextInputValue: name => ({ append: 'N', content: '', embed: '', ...values })[name] }
    };
    await state.command.handleModal(modal);
    const reply = state.calls.at(-1)[1];
    return reply.components[0].toJSON().components.map(component => component.custom_id);
}

test('the message context menu and slash command allow Leader, Admin and Officer roles', async () => {
    for (const role of ['leader-role', 'admin-role', 'officer-role']) {
        const state = fixture(role);
        await state.command.handleSlash(state.interaction);
        assert.deepEqual(state.calls.find(([type]) => type === 'edit-message')[1], { content: 'New\ntext' });
        await state.command.handleContext(state.interaction);
        assert.equal(state.calls.at(-1)[1].toJSON().title, 'Edit Bot Message (Officer)');
    }
    assert.equal(fixture().command.data[1].toJSON().name, 'Edit Bot Message (Officer)');
});

test('the editor denies other roles and blocked channels before fetching', async () => {
    for (const state of [fixture('member-role'), fixture('officer-role', { blockedEditBotMsgChannels: ['456'] })]) {
        state.interaction.client.channels.fetch = () => assert.fail('Must not fetch');
        await state.command.handleSlash(state.interaction);
        assert.equal(state.calls[0][1].flags, MessageFlags.Ephemeral);
        assert.match(state.calls[0][1].content, /No permission|not allowed in this channel/);
    }
});

test('confirmation preserves old content when empty and appends below trimmed old content', async () => {
    for (const [append, content, expected] of [
        ['N', '', 'Old text  \n'], ['Y', '', 'Old text\n'],
        ['Y', 'Extra text', 'Old text\nExtra text'], ['N', 'Replacement', 'Replacement']
    ]) {
        const state = fixture();
        const [confirmId] = await previewEdit(state, { append, content });
        await state.command.handleButton({ ...state.interaction, customId: confirmId });
        assert.equal(state.calls.find(([type]) => type === 'edit-message')[1].content, expected);
        assert.equal(state.calls.at(-1)[1].content, '### ✅  Bot message successfully updated!');
        assert.equal(state.interaction.client.editCache.size, 0);
    }
});

test('confirmation can add a JSON embed while preserving unrelated attachments and applying CC branding', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { embed: '{"title":"New embed"}' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.content, 'Old text  \n');
    assert.equal(payload.embeds[0].toJSON().title, 'New embed');
    assert.equal(payload.embeds[0].toJSON().footer.icon_url, 'attachment://cc_logo.webp');
    assert.equal(payload.attachments[0].id, 'file-id');
    assert.equal(payload.files[0].name, 'cc_logo.webp');
});

test('invalid JSON leaves the original message unchanged and keeps its existing error text', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { embed: '{"broken":' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
    assert.equal(state.calls.at(-1)[1].content, '❌ Invalid embed JSON.');
});

test('parallel confirmation previews remain independent and only their owner can confirm', async () => {
    const state = fixture();
    const [firstId] = await previewEdit(state, { content: 'First' });
    const [secondId, secondCancel] = await previewEdit(state, { content: 'Second' });
    assert.notEqual(firstId, secondId);
    await state.command.handleButton({ ...state.interaction, user: { id: 'other-user' }, customId: firstId });
    assert.equal(state.calls.at(-1)[1].content, '### ❌  No permission!');
    assert.equal(state.interaction.client.editCache.size, 2);
    await state.command.handleButton({ ...state.interaction, customId: secondCancel });
    assert.equal(state.calls.at(-1)[1].content, '### ❌  Edit cancelled.');
    assert.equal(state.interaction.client.editCache.size, 1);
    await state.command.handleButton({ ...state.interaction, customId: firstId });
    assert.equal(state.calls.find(([type]) => type === 'edit-message')[1].content, 'First');
});

test('expired confirmations do not edit the message', async () => {
    const state = fixture();
    const [confirmId] = await previewEdit(state, { content: 'Expired' });
    state.interaction.client.editCache.get(confirmId).expiresAt = Date.now() - 1;
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
    assert.equal(state.interaction.client.editCache.size, 0);
});

test('slash edits log the source diff with Crow Control logo and survive unavailable log channels', async () => {
    const state = fixture('officer-role', { logChannelID: '789' });
    state.interaction.client.channels.fetch = async id => {
        if (id === '456') return state.channel;
        return { send: async payload => state.calls.push(['send-log', payload]) };
    };
    await state.command.handleSlash(state.interaction);
    const payload = state.calls.find(([type]) => type === 'send-log')[1];
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, '🤖  Bot Message Edited  ✏️');
    assert.equal(embed.footer.text, 'Crow Control Logs');
    assert.equal(embed.footer.icon_url, 'attachment://cc_logo.webp');
    assert.equal(embed.fields.at(-1).value, '```diff\n- Old text\n+ New\n+ text\n```');
    state.calls.length = 0;
    state.interaction.client.channels.fetch = async id => {
        if (id === '456') return state.channel;
        throw new Error('Log access unavailable');
    };
    await state.command.handleSlash(state.interaction);
    assert.equal(state.calls.at(-1)[1], '### ✅  Message edited!');
});

test('ignored log channels skip audit delivery', async () => {
    const state = fixture('officer-role', { logChannelID: '789', ignoredLogChannels: ['456'] });
    state.interaction.client.channels.fetch = async id => {
        assert.equal(id, '456');
        return state.channel;
    };
    await state.command.handleSlash(state.interaction);
    assert.equal(state.calls.at(-1)[1], '### ✅  Message edited!');
});

test('source diff preserves internal whitespace and added empty lines, and stays within embed field limits', () => {
    assert.equal(EditBotMsg.formatMessageDiff('one  \ntwo', 'one  \n\nthree'),
        '```diff\n  one  \n- two\n+ *[ADDED EMPTY LINE]*\n+ three\n```');
    const long = Array.from({ length: 250 }, (_, index) => 'Unchanged line ' + index).join('\n');
    const diff = EditBotMsg.formatMessageDiff(long + '\nOld', long + '\nNew');
    assert.ok(diff.length <= 1024);
    assert.match(diff, /250 unchanged lines/);
    assert.match(diff, /- Old\n\+ New/);
});


test('confirmed embed replacement restores manually suppressed embeds and preserves other flags', async () => {
    const state = fixture();
    state.message.flags = new MessageFlagsBitField([MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications]);
    const [confirmId] = await previewEdit(state, { embed: '{"title":"Replacement"}' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.embeds[0].toJSON().title, 'Replacement');
    assert.equal(payload.flags, MessageFlags.SuppressNotifications);
    assert.equal(state.message.flags.has(MessageFlags.SuppressEmbeds), true);
});

test('text-only confirmation leaves existing embed suppression unchanged', async () => {
    const state = fixture();
    state.message.flags = new MessageFlagsBitField(MessageFlags.SuppressEmbeds);
    const [confirmId] = await previewEdit(state, { content: 'Updated text' });
    await state.command.handleButton({ ...state.interaction, customId: confirmId });
    const payload = state.calls.find(([type]) => type === 'edit-message')[1];
    assert.equal(payload.content, 'Updated text');
    assert.equal(Object.hasOwn(payload, 'flags'), false);
    assert.equal(state.message.flags.has(MessageFlags.SuppressEmbeds), true);
});

function deferred() {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function buttonInteraction(state, customId, overrides = {}) {
    const interaction = { ...state.interaction, customId, ...overrides };
    const deferUpdate = interaction.deferUpdate;
    interaction.deferUpdate = async () => {
        await deferUpdate();
        interaction.deferred = true;
    };
    return interaction;
}

function componentIds(payload) {
    return (payload.components || []).flatMap(row => (row.toJSON?.() || row).components)
        .map(component => component.custom_id);
}

function assertPrivateRejection(calls) {
    assert.equal(calls.length, 1);
    assert.ok(['reply', 'follow-up'].includes(calls[0][0]));
    assert.equal(calls[0][1].flags, MessageFlags.Ephemeral);
    assert.ok(calls[0][1].content);
}

async function allowResponseFailure(operation, expected) {
    try { await operation; }
    catch (error) { assert.equal(error, expected); }
}

test('failed Confirm and Cancel acknowledgements retain the preview for another click', async () => {
    for (const action of ['confirm', 'cancel']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'Retry this draft' });
        const cache = state.interaction.client.editCache.get(ids[0]);
        const failure = new Error('Acknowledgement unavailable');
        const customId = ids[action === 'confirm' ? 0 : 1];
        const method = action === 'confirm' ? 'deferUpdate' : 'update';
        const click = buttonInteraction(state, customId, { [method]: async () => { throw failure; } });
        await allowResponseFailure(state.command.handleButton(click), failure);
        assert.equal(state.interaction.client.editCache.get(ids[0]), cache);
        assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);

        await state.command.handleButton(buttonInteraction(state, customId));
        assert.equal(state.interaction.client.editCache.size, 0);
        assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, action === 'confirm' ? 1 : 0);
    }
});

test('Confirm and Cancel reserve their preview before awaiting acknowledgement', async () => {
    for (const action of ['confirm', 'cancel']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'One action only' });
        const entered = deferred();
        const release = deferred();
        const method = action === 'confirm' ? 'deferUpdate' : 'update';
        const click = buttonInteraction(state, ids[action === 'confirm' ? 0 : 1], {
            [method]: async payload => {
                entered.resolve();
                await release.promise;
                state.calls.push([method === 'update' ? 'update' : 'defer-update', payload]);
            }
        });
        const pending = state.command.handleButton(click);
        await entered.promise;
        try {
            assert.ok(state.interaction.client.editCache.has(ids[0]));
            for (const customId of ids) {
                const start = state.calls.length;
                await state.command.handleButton(buttonInteraction(state, customId));
                assertPrivateRejection(state.calls.slice(start));
            }
            assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
        } finally {
            release.resolve();
            await pending;
        }
        assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, action === 'confirm' ? 1 : 0);
        assert.equal(state.interaction.client.editCache.size, 0);
    }
});

test('Confirm excludes Cancel and duplicate Confirm during target lookup and publication', async () => {
    for (const stage of ['lookup', 'publication']) {
        const state = fixture();
        const ids = await previewEdit(state, { append: 'Y', content: 'Append once' });
        const entered = deferred();
        const release = deferred();
        if (stage === 'lookup') {
            state.channel.messages.fetch = async () => {
                entered.resolve();
                await release.promise;
                return state.message;
            };
        } else {
            state.message.edit = async payload => {
                state.calls.push(['edit-message', payload]);
                entered.resolve();
                await release.promise;
            };
        }
        const pending = state.command.handleButton(buttonInteraction(state, ids[0]));
        await entered.promise;
        try {
            for (const customId of ids) {
                const start = state.calls.length;
                await state.command.handleButton(buttonInteraction(state, customId));
                assertPrivateRejection(state.calls.slice(start));
            }
            assert.equal(state.calls.some(([type]) => type === 'update'), false);
        } finally {
            release.resolve();
            await pending;
        }
        assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, 1);
        assert.match(state.calls.at(-1)[1].content, /successfully updated/);
        assert.equal(state.interaction.client.editCache.size, 0);
    }
});

test('stale, expired and restart-lost controls give private feedback without changing the preview', async () => {
    for (const reason of ['confirmed', 'cancelled', 'expired', 'restart']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'No longer active' });
        if (reason === 'confirmed' || reason === 'cancelled') {
            await state.command.handleButton(buttonInteraction(state, ids[reason === 'confirmed' ? 0 : 1]));
        } else if (reason === 'expired') {
            state.interaction.client.editCache.get(ids[0]).expiresAt = Date.now() - 1;
        } else {
            delete state.interaction.client.editCache;
        }
        for (const customId of [...ids, 'cancelEdit']) {
            const start = state.calls.length;
            await state.command.handleButton(buttonInteraction(state, customId));
            assertPrivateRejection(state.calls.slice(start));
        }
    }
});

test('failed-edit recovery excludes overlapping actions until rendering settles, then allows retry or cancel', async () => {
    for (const renderFails of [false, true]) {
        for (const nextAction of ['confirm', 'cancel']) {
            const state = fixture();
            const ids = await previewEdit(state, { content: 'Recover this draft' });
            const cache = state.interaction.client.editCache.get(ids[0]);
            const entered = deferred();
            const release = deferred();
            const renderFailure = new Error('Recovery response unavailable');
            let attempts = 0;
            let recovery;
            state.message.edit = async payload => {
                if (++attempts === 1) throw new Error('Edit request rejected');
                state.calls.push(['edit-message', payload]);
            };
            const click = buttonInteraction(state, ids[0], {
                editReply: async payload => {
                    recovery = payload;
                    entered.resolve();
                    await release.promise;
                    if (renderFails) throw renderFailure;
                    state.calls.push(['edit-reply', payload]);
                }
            });
            const pending = allowResponseFailure(state.command.handleButton(click), renderFailure);
            await entered.promise;
            try {
                assert.equal(state.interaction.client.editCache.get(ids[0]), cache);
                assert.deepEqual(componentIds(recovery), ids);
                assert.match(recovery.content, /Recover this draft/);
                for (const customId of ids) {
                    const start = state.calls.length;
                    await state.command.handleButton(buttonInteraction(state, customId));
                    assertPrivateRejection(state.calls.slice(start));
                }
                assert.equal(attempts, 1);
            } finally {
                release.resolve();
                await pending;
            }
            await state.command.handleButton(buttonInteraction(state, ids[nextAction === 'confirm' ? 0 : 1]));
            assert.equal(attempts, nextAction === 'confirm' ? 2 : 1);
            assert.equal(state.interaction.client.editCache.size, 0);
            assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, nextAction === 'confirm' ? 1 : 0);
        }
    }
});

test('failed target lookup keeps the preview available for confirmation', async () => {
    const state = fixture();
    const ids = await previewEdit(state, { content: 'After lookup recovery' });
    state.channel.messages.fetch = async () => { throw new Error('Temporary lookup failure'); };
    await state.command.handleButton(buttonInteraction(state, ids[0]));
    assert.ok(state.interaction.client.editCache.has(ids[0]));
    const recovery = state.calls.findLast(([type]) => type === 'edit-reply')[1];
    assert.deepEqual(componentIds(recovery), ids);
    assert.match(state.calls.at(-1)[1].content, /try Confirm Edit again or Cancel/);
    assert.equal(state.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
    state.channel.messages.fetch = async () => state.message;
    await state.command.handleButton(buttonInteraction(state, ids[0]));
    assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, 1);
});

test('callbacks reject revoked roles and wrong owners before acknowledging or fetching', async () => {
    for (const denied of ['role', 'owner']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'Protected draft' });
        if (denied === 'role') state.interaction.member.roles.cache.clear();
        const user = denied === 'owner' ? { id: 'other-user' } : state.interaction.user;
        let lookups = 0;
        state.interaction.client.channels.fetch = async () => { lookups++; return state.channel; };
        for (const customId of ids) {
            const start = state.calls.length;
            await state.command.handleButton(buttonInteraction(state, customId, { user }));
            assertPrivateRejection(state.calls.slice(start));
            assert.ok(state.interaction.client.editCache.has(ids[0]));
        }
        assert.equal(lookups, 0);
    }
});

test('confirmation rechecks roles, ownership, author and blocked destinations after awaited lookup', async () => {
    for (const changed of ['role', 'owner', 'author', 'requested-channel', 'resolved-channel', 'message-channel']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'Must remain private' });
        const entered = deferred();
        const release = deferred();
        state.channel.messages.fetch = async () => {
            entered.resolve();
            await release.promise;
            return state.message;
        };
        const pending = state.command.handleButton(buttonInteraction(state, ids[0]));
        await entered.promise;
        try {
            if (changed === 'role') state.interaction.member.roles.cache.clear();
            if (changed === 'owner') state.interaction.client.editCache.get(ids[0]).ownerId = 'other-user';
            if (changed === 'author') state.message.author.id = 'another-bot';
            if (changed === 'requested-channel') state.command.blockedEditBotMsgChannels.push('456');
            if (changed === 'resolved-channel') {
                state.channel.id = 'blocked-channel';
                state.command.blockedEditBotMsgChannels.push('blocked-channel');
            }
            if (changed === 'message-channel') {
                state.message.channelId = 'blocked-channel';
                state.command.blockedEditBotMsgChannels.push('blocked-channel');
            }
        } finally {
            release.resolve();
            await pending;
        }
        assert.equal(state.calls.some(([type]) => type === 'edit-message'), false, changed);
        const response = state.calls.at(-1)[1];
        assert.match(response.content, /permission|Only bot messages|not allowed in this channel/, changed);
    }
});

test('slash edits recheck roles, author and all destination identifiers after awaited lookup', async () => {
    for (const changed of ['role', 'author', 'requested-channel', 'resolved-channel', 'message-channel']) {
        const state = fixture();
        const entered = deferred();
        const release = deferred();
        state.channel.messages.fetch = async () => {
            entered.resolve();
            await release.promise;
            return state.message;
        };
        const pending = state.command.handleSlash(state.interaction);
        await entered.promise;
        if (changed === 'role') state.interaction.member.roles.cache.clear();
        if (changed === 'author') state.message.author.id = 'another-bot';
        if (changed === 'requested-channel') state.command.blockedEditBotMsgChannels.push('456');
        if (changed === 'resolved-channel') {
            state.channel.id = 'blocked-channel';
            state.command.blockedEditBotMsgChannels.push('blocked-channel');
        }
        if (changed === 'message-channel') {
            state.message.channelId = 'blocked-channel';
            state.command.blockedEditBotMsgChannels.push('blocked-channel');
        }
        release.resolve();
        await pending;
        assert.equal(state.calls.some(([type]) => type === 'edit-message'), false, changed);
        const response = state.calls.at(-1)[1];
        assert.match(typeof response === 'string' ? response : response.content,
            /permission|Only bot messages|not allowed in this channel/, changed);
    }
});

test('successful publication closes the preview before audit and final feedback finish', async () => {
    for (const stage of ['audit', 'feedback']) {
        const state = fixture();
        const ids = await previewEdit(state, { append: 'Y', content: 'Append exactly once' });
        const entered = deferred();
        const release = deferred();
        const failure = new Error(stage + ' unavailable');
        const click = buttonInteraction(state, ids[0]);
        if (stage === 'audit') {
            state.command.logMessageEdit = async () => {
                entered.resolve();
                await release.promise;
                throw failure;
            };
        } else {
            click.editReply = async payload => {
                state.calls.push(['edit-reply', payload]);
                entered.resolve();
                await release.promise;
                throw failure;
            };
        }
        const pending = state.command.handleButton(click);
        await entered.promise;
        try {
            assert.equal(state.interaction.client.editCache.has(ids[0]), false);
            for (const customId of ids) {
                const start = state.calls.length;
                await state.command.handleButton(buttonInteraction(state, customId));
                assertPrivateRejection(state.calls.slice(start));
            }
        } finally {
            release.resolve();
            await pending;
        }
        assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, 1);
        const feedback = state.calls.filter(([type]) => type === 'edit-reply').map(([, payload]) => payload.content);
        assert.ok(feedback.length > 0, 'Successful edits still attempt success feedback after an audit failure');
        assert.ok(feedback.every(content => /successfully updated/.test(content)));
        assert.equal(state.calls.some(([type]) => type === 'update'), false);
        assert.equal(state.interaction.client.editCache.size, 0);
    }
});

test('slash edits never report publication failure after audit or final feedback fails', async () => {
    for (const stage of ['audit', 'feedback']) {
        const state = fixture();
        const failure = new Error(stage + ' unavailable');
        if (stage === 'audit') state.command.logMessageEdit = async () => { throw failure; };
        else state.interaction.editReply = async payload => {
            state.calls.push(['edit-reply', payload]);
            throw failure;
        };
        await assert.doesNotReject(state.command.handleSlash(state.interaction));
        assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, 1);
        const feedback = state.calls.filter(([type]) => type === 'edit-reply').map(([, payload]) => payload);
        assert.ok(feedback.length > 0);
        assert.ok(feedback.every(content => /Message edited!/.test(content)));
    }
});

test('context menu keeps the direct modal response and denies foreign authors or blocked destinations', async () => {
    const allowed = fixture();
    await allowed.command.handleContext(allowed.interaction);
    assert.deepEqual(allowed.calls.map(([type]) => type), ['modal']);
    for (const denied of ['author', 'channel']) {
        const state = fixture();
        if (denied === 'author') state.message.author.id = 'another-bot';
        else state.command.blockedEditBotMsgChannels.push('456');
        await state.command.handleContext(state.interaction);
        assertPrivateRejection(state.calls);
        assert.equal(state.calls.some(([type]) => type === 'modal'), false);
    }
});

test('confirmation rechecks cached membership and ownership after acknowledgement before lookup', async () => {
    for (const changed of ['member', 'owner']) {
        const state = fixture();
        const ids = await previewEdit(state, { content: 'Private draft' });
        const acknowledgement = deferred();
        const click = buttonInteraction(state, ids[0], { deferUpdate: () => acknowledgement.promise });
        click.guild = { members: { cache: new Collection([[click.user.id, click.member]]) } };
        state.interaction.client.channels.fetch = () => assert.fail('Unauthorized confirmation must not fetch');
        const pending = state.command.handleButton(click);
        if (changed === 'member') click.guild.members.cache.set(click.user.id, { roles: [] });
        else state.interaction.client.editCache.get(ids[0]).ownerId = 'another-user';
        acknowledgement.resolve();
        await pending;
        assertPrivateRejection(state.calls.slice(-1));
        assert.equal(state.calls.at(-1)[0], 'follow-up');
        assert.equal(state.calls.some(([type]) => type === 'edit-message'), false);
        assert.ok(state.interaction.client.editCache.has(ids[0]));
    }
});

test('an in-flight confirmation keeps its reservation when the preview timeout passes', async () => {
    const state = fixture();
    const ids = await previewEdit(state, { content: 'Complete one edit' });
    const entered = deferred(), lookup = deferred();
    state.channel.messages.fetch = async () => { entered.resolve(); await lookup.promise; return state.message; };
    const pending = state.command.handleButton(buttonInteraction(state, ids[0]));
    await entered.promise;
    try {
        state.interaction.client.editCache.get(ids[0]).expiresAt = Date.now() - 1;
        for (const customId of ids) {
            const start = state.calls.length;
            await state.command.handleButton(buttonInteraction(state, customId));
            assertPrivateRejection(state.calls.slice(start));
            assert.match(state.calls.at(-1)[1].content, /already being processed/);
        }
        assert.ok(state.interaction.client.editCache.has(ids[0]));
    } finally {
        lookup.resolve();
        await pending;
    }
    assert.equal(state.calls.filter(([type]) => type === 'edit-message').length, 1);
    assert.match(state.calls.at(-1)[1].content, /successfully updated/);
    assert.equal(state.interaction.client.editCache.size, 0);
});

test('modal submissions reject blocked destinations and discard previews that failed to open', async () => {
    const state = fixture();
    state.command.blockedEditBotMsgChannels.push('456');
    const modal = { ...state.interaction, customId: 'editMsg_123_456',
        fields: { getTextInputValue: name => ({ append: 'N', content: 'Private draft', embed: '' })[name] } };
    await state.command.handleModal(modal);
    assertPrivateRejection(state.calls);
    assert.match(state.calls[0][1].content, /not allowed in this channel/);
    assert.equal(state.interaction.client.editCache?.size || 0, 0);
    state.command.blockedEditBotMsgChannels.length = 0;
    const failure = new Error('Preview unavailable');
    modal.reply = async () => { throw failure; };
    await assert.rejects(state.command.handleModal(modal), error => error === failure);
    assert.equal(state.interaction.client.editCache.size, 0);
});
