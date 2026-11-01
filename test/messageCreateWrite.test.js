const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');

const messageCreate = require('../events/messageCreate.js');

function fixture(content, role = 'member-role', config = {}) {
    const calls = [];
    const sentMessage = { id: 'sent-message', url: 'https://discord.com/channels/guild/channel/sent-message' };
    const message = {
        content,
        guild: { id: 'guild' },
        author: { id: 'author', username: 'Member', displayName: 'Guild Member', bot: false },
        member: { roles: { cache: new Collection([[role, { id: role }]]) } },
        attachments: new Collection(),
        mentions: { members: new Collection() },
        channel: {
            id: 'channel',
            send: async payload => {
                calls.push(['send', payload]);
                return sentMessage;
            }
        },
        client: {
            channels: {
                fetch: async id => {
                    calls.push(['fetch-log', id]);
                    return { send: async payload => calls.push(['send-log', payload]) };
                }
            }
        },
        reply: async payload => calls.push(['reply', payload]),
        delete: async () => calls.push(['delete'])
    };
    return {
        calls, message, sentMessage,
        config: {
            leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role',
            ignoredLogChannels: [], ...config
        }
    };
}

test('write commands require an exact lowercase name followed by whitespace or end of input', async () => {
    for (const prefix of ['!', '?']) {
        for (const suffix of ['r hello', 'Anything', '-h hidden', '_extra text', '! text', '. text']) {
            const state = fixture(`${prefix}write${suffix}`);
            await messageCreate.execute(state.message, state.config);
            assert.deepEqual(state.calls, [], `${prefix}write${suffix} must not execute`);
        }
        for (const content of [`${prefix}Write text`, `${prefix}WRITE text`, ` ${prefix}write text`]) {
            const state = fixture(content);
            await messageCreate.execute(state.message, state.config);
            assert.deepEqual(state.calls, [], `${content} must retain existing case/prefix handling`);
        }
        for (const separator of [' ', '\t', '\n', '\r\n', '  ']) {
            const state = fixture(`${prefix}write${separator}first line\nsecond line`, 'officer-role');
            await messageCreate.execute(state.message, state.config);
            assert.deepEqual(state.calls, [['send', { content: 'first line\nsecond line', files: [] }]]);
        }
        const state = fixture(`${prefix}write`, 'officer-role');
        state.message.attachments.set('image', { url: 'https://example.test/image.png' });
        await messageCreate.execute(state.message, state.config);
        assert.deepEqual(state.calls, [['send', { content: null, files: ['https://example.test/image.png'] }]]);
    }
});

test('regular write commands retain member attribution and omit it for Leader, Admin and Officer', async () => {
    for (const prefix of ['!', '?']) {
        for (const role of ['member-role', 'leader-role', 'admin-role', 'officer-role']) {
            const state = fixture(`${prefix}write Message\nwith two lines`, role);
            state.message.attachments.set('first', { url: 'https://example.test/first.png' });
            state.message.attachments.set('second', { url: 'https://example.test/second.png' });
            await messageCreate.execute(state.message, state.config);
            assert.deepEqual(state.calls, [['send', {
                content: 'Message\nwith two lines' + (role === 'member-role' ? '\n\n-# - Message created by <@author>' : ''),
                files: ['https://example.test/first.png']
            }]]);
        }
        const state = fixture(`${prefix}write`);
        await messageCreate.execute(state.message, state.config);
        assert.equal(state.calls[0][1].content, '-# - Message created by <@author>');
    }
});

test('the existing hidden flag is staff-only and deletes the source only after publication', async () => {
    for (const prefix of ['!', '?']) {
        for (const role of ['member-role', 'leader-role', 'admin-role', 'officer-role']) {
            const state = fixture(`${prefix}write -h Hidden\nmessage`, role);
            await messageCreate.execute(state.message, state.config);
            if (role === 'member-role') {
                assert.deepEqual(state.calls, [['reply', {
                    content: '### ❌  You do not have permission to use the hidden flag (-h)!'
                }]]);
            } else {
                assert.deepEqual(state.calls, [['send', { content: 'Hidden\nmessage', files: [] }], ['delete']]);
            }
        }
        for (const content of ['-h', '-hello', '-h\ttext', '-h\ntext']) {
            const state = fixture(`${prefix}write ${content}`);
            await messageCreate.execute(state.message, state.config);
            assert.deepEqual(state.calls, [['send', {
                content: `${content}\n\n-# - Message created by <@author>`, files: []
            }]]);
        }
    }
});

test('write publication keeps message.client audit delivery, hidden labels and ignored destinations', async () => {
    for (const hidden of [false, true]) {
        const state = fixture(`!write ${hidden ? '-h ' : ''}Logged text`, 'officer-role', { logChannelID: 'log-channel' });
        await messageCreate.execute(state.message, state.config);
        assert.deepEqual(state.calls.map(([type]) => type), hidden
            ? ['send', 'delete', 'fetch-log', 'send-log']
            : ['send', 'fetch-log', 'send-log']);
        assert.equal(state.calls.find(([type]) => type === 'fetch-log')[1], 'log-channel');
        const payload = state.calls.at(-1)[1];
        const embed = payload.embeds[0].toJSON();
        assert.equal(embed.title, `💻 \u2002\`?write${hidden ? ' -h' : ''}\` command used!`);
        assert.equal(embed.fields.find(field => field.name === 'Message ID').value, '`sent-message`');
        assert.equal(embed.fields.find(field => field.name === 'Message Link').value, `[Jump to message](${state.sentMessage.url})`);
        assert.equal(embed.fields.at(-1).value, '```text\nLogged text\n```');
        assert.equal(embed.footer.text, 'Crow Control Logs');
        assert.equal(payload.files[0].name, 'cc_logo.webp');
    }
    const state = fixture('?write text', 'officer-role', { logChannelID: 'log-channel', ignoredLogChannels: ['channel'] });
    await messageCreate.execute(state.message, state.config);
    assert.deepEqual(state.calls.map(([type]) => type), ['send']);
});

test('welcome commands and prefix command guards retain their existing behavior', async () => {
    for (const prefix of ['!', '?']) {
        const state = fixture(`${prefix}welcome <@new-member>`);
        state.message.mentions.members.set('new-member', { id: 'new-member' });
        await messageCreate.execute(state.message, state.config);
        assert.equal(state.calls[0][0], 'send');
        assert.match(state.calls[0][1], /Welcome to Crow Control, <@new-member>/);
        assert.match(state.calls[0][1], /<#1469101041189523657>/);
        state.calls.length = 0;
        state.message.mentions.members.clear();
        await messageCreate.execute(state.message, state.config);
        assert.deepEqual(state.calls, [['reply', { content: '### ❌  Please mention a user to welcome!' }]]);
    }
    for (const mutation of [
        message => { message.author.bot = true; },
        message => { message.guild = null; },
        message => { message.member = null; }
    ]) {
        const state = fixture('!write text');
        mutation(state.message);
        await messageCreate.execute(state.message, state.config);
        assert.deepEqual(state.calls, []);
    }
});
