const test = require('node:test');
const assert = require('node:assert/strict');
const { ButtonStyle, Collection, MessageFlags } = require('discord.js');

const DrawList = require('../commands/draw-list.js');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;
const OLD_STAMP = '-# Last updated <t:1794954780:f> — <t:1794954780:R>';
const OLD_CONTENT = [
    '# Ranked PvP Draw List ',
    '## Ghost Riders Members:',
    '  - **Noirz** ~ <@818184019006062593>',
    '  - **Feeki** ~ <@443881773663780884>',
    '',
    '## Alts not in WW or Ghost Riders:',
    '- **Zadkiell** ~ <@266434901102821377>'
].join('\n');
// Shift+Enter arrives as a real line break, while a typed \n arrives as a backslash followed by n.
const INPUT = OLD_CONTENT
    .replace('  - **Feeki** ~ <@443881773663780884>',
        '  - **Feeki** ~ <@443881773663780884>\\n  - **Newbie** ~ <@111111111111111111>')
    .replace('- **Zadkiell** ~ <@266434901102821377>', '- **Narual** ~ <@382960761837715472>');
const SAVED = INPUT.replace('\\n', '\n');
const NO_PERMISSION = { content: '### ❌  No permission!', flags: MessageFlags.Ephemeral };

function fixture({ role = 'officer-role', input = INPUT, config = {} } = {}) {
    const calls = [];
    const message = {
        id: 'draw-message', channelId: 'draw-channel', content: OLD_CONTENT, author: { id: 'bot-user' },
        url: 'https://discord.com/channels/guild/draw-channel/draw-message',
        embeds: [{
            description: OLD_STAMP, color: 0x452366,
            author: { name: 'Crow Control  •  PvP Draw List', icon_url: 'https://cdn.example/author.png' }
        }],
        edit: async payload => { calls.push(['edit-message', payload]); }
    };
    const channel = { id: 'draw-channel', messages: { fetch: async () => message } };
    const members = new Collection([['818184019006062593', { displayName: 'NoirOnline' }]]);
    const fetchableMembers = new Map([['382960761837715472', { displayName: 'Wesucks' }]]);
    const interaction = {
        user: { id: 'officer-user', username: 'Officer' },
        channelId: 'draw-channel',
        guildId: 'guild-id',
        member: { roles: { cache: new Collection([[role, { id: role }]]) } },
        guild: {
            members: {
                cache: members,
                fetch: async ({ user }) => {
                    calls.push(['fetch-members', user]);
                    for (const id of user) if (fetchableMembers.has(id)) members.set(id, fetchableMembers.get(id));
                    return members;
                }
            },
            roles: { cache: new Collection() },
            channels: { cache: new Collection() }
        },
        options: { getString: name => (name === 'content' ? input : null) },
        client: {
            user: { id: 'bot-user' },
            channels: {
                fetch: async id => {
                    calls.push(['fetch-channel', id]);
                    if (id === 'draw-channel') return channel;
                    if (id === 'log-channel') return { send: async payload => calls.push(['send-log', payload]) };
                    throw new Error('Unknown channel');
                }
            }
        },
        reply: async payload => calls.push(['reply', payload]),
        followUp: async payload => calls.push(['follow-up', payload]),
        editReply: async payload => calls.push(['edit-reply', payload]),
        deferReply: async payload => {
            calls.push(['defer-reply', payload]);
            interaction.deferred = true;
        },
        update: async payload => calls.push(['update', payload])
    };
    const command = new DrawList({
        leaderRoleID: 'leader-role', adminRoleID: 'admin-role', officerRoleID: 'officer-role',
        pvpDrawListChannelID: 'draw-channel', pvpDrawListMessageID: 'draw-message',
        onCooldown: () => false, now: () => NOW, ...config
    });
    return { command, interaction, calls, message, channel };
}

async function openPreview(state) {
    await state.command.execute(state.interaction);
    const [type, payload] = state.calls.at(-1);
    assert.equal(type, 'edit-reply');
    return payload.components[0].toJSON().components.map(button => button.custom_id);
}

function click(state, customId, overrides = {}) {
    const interaction = { ...state.interaction, customId, deferred: false, replied: false };
    interaction.deferUpdate = async () => {
        state.calls.push(['defer-update']);
        interaction.deferred = true;
    };
    return Object.assign(interaction, overrides);
}

const edits = state => state.calls.filter(([type]) => type === 'edit-message').map(([, payload]) => payload);

test('/draw-list registers one required content option with the requested wording', () => {
    const json = fixture().command.data.toJSON();
    assert.equal(json.name, 'draw-list');
    assert.equal(json.description, 'Edit the PvP Draw List. Only works in the #pvp-draw-list channel (Officer-only)');
    assert.deepEqual(json.options.map(({ name, description, required, max_length: maxLength }) =>
        ({ name, description, required, maxLength })), [{
        name: 'content', required: true, maxLength: 2000,
        description: 'Right-click the draw message, select Copy Text, and paste it here. Use Shift + Enter for new lines.'
    }]);
});

test('Leaders, Admins and Officers can preview, and other members are refused before any lookup', async () => {
    for (const role of ['leader-role', 'admin-role', 'officer-role']) {
        assert.equal((await openPreview(fixture({ role }))).length, 2);
    }
    const state = fixture({ role: 'member-role' });
    await state.command.execute(state.interaction);
    assert.deepEqual(state.calls, [['reply', NO_PERMISSION]]);
});

test('/draw-list only works in the draw list channel, and other members never learn that rule', async () => {
    const staff = fixture();
    staff.interaction.channelId = 'other-channel';
    await staff.command.execute(staff.interaction);
    assert.deepEqual(staff.calls, [['reply', {
        content: 'Please use the command in the PvP Draw channel: <#draw-channel>', flags: MessageFlags.Ephemeral
    }]]);
    const member = fixture({ role: 'member-role' });
    member.interaction.channelId = 'other-channel';
    await member.command.execute(member.interaction);
    assert.deepEqual(member.calls, [['reply', NO_PERMISSION]]);
});

test('the private preview lists only changed lines with readable mentions, a countdown and Confirm and Cancel buttons', async () => {
    const state = fixture();
    await openPreview(state);
    assert.deepEqual(state.calls[0], ['defer-reply', { flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(state.calls.find(([type]) => type === 'fetch-members')[1],
        ['111111111111111111', '266434901102821377', '382960761837715472']);
    const preview = state.calls.at(-1)[1];
    assert.equal(preview.content, '### <@officer-user>, please review and confirm your changes below.\n\n' +
        '-# - The **Last updated** timestamp is automatically updated.');
    assert.deepEqual(preview.allowedMentions, { parse: [] });
    assert.equal(preview.embeds[0].toJSON().description, '```diff\n' +
        '+   - **Newbie** ~ <@111111111111111111>\n\n' +
        '- - **Zadkiell** ~ <@266434901102821377>\n' +
        '+ - **Narual** ~ @Wesucks\n```\n' +
        `-# Message preview expires <t:${NOW_SECONDS + 15 * 60}:R>`);
    assert.deepEqual(preview.components[0].toJSON().components.map(({ label, style }) => [label, style]),
        [['Confirm', ButtonStyle.Success], ['Cancel', ButtonStyle.Danger]]);
    assert.equal(edits(state).length, 0);
});

test('unchanged text is reported without opening a preview', async () => {
    const state = fixture({ input: OLD_CONTENT });
    await state.command.execute(state.interaction);
    assert.equal(state.calls.at(-1)[1], '### ⚠️  No changes found.\n- Your text matches the current draw list.');
    assert.equal(state.command.previews.size, 0);
});

test('missing configuration or a missing Last updated timestamp stops the command before a preview', async () => {
    const unconfigured = fixture({ config: { pvpDrawListMessageID: undefined } });
    await unconfigured.command.execute(unconfigured.interaction);
    assert.deepEqual(unconfigured.calls.map(([type]) => type), ['reply']);
    assert.match(unconfigured.calls[0][1].content, /not configured/);

    const withoutStamp = fixture();
    withoutStamp.message.embeds = [];
    await withoutStamp.command.execute(withoutStamp.interaction);
    assert.match(withoutStamp.calls.at(-1)[1], /no \*\*Last updated\*\* timestamp/);
    assert.equal(withoutStamp.command.previews.size, 0);
});

test('Confirm saves the text, refreshes only the Last updated time and logs the previewed changes', async () => {
    const state = fixture({ config: { logChannelID: 'log-channel' } });
    const [confirmId] = await openPreview(state);
    const previewDiff = state.calls.at(-1)[1].embeds[0].toJSON().description.split('\n-# Message preview expires')[0];
    assert.equal(await state.command.handleButton(click(state, confirmId)), true);
    const [payload] = edits(state);
    assert.equal(payload.content, SAVED);
    assert.deepEqual(payload.embeds.map(embed => embed.toJSON()), [{
        description: `-# Last updated <t:${NOW_SECONDS}:f> — <t:${NOW_SECONDS}:R>`, color: 0x452366,
        author: { name: 'Crow Control  •  PvP Draw List', icon_url: 'https://cdn.example/author.png' }
    }]);
    const logPayload = state.calls.find(([type]) => type === 'send-log')[1];
    const log = logPayload.embeds[0].toJSON();
    assert.equal(log.description,
        '### <@officer-user> updated the [PvP Draw List](https://discord.com/channels/guild-id/draw-channel)\n' +
        '-# Use the `/draw-list` command to update the <#draw-channel>\n' + previewDiff);
    assert.match(log.description, /- - \*\*Zadkiell\*\*[^\n]*\n\+ - \*\*Narual\*\* ~ @Wesucks\n```$/);
    assert.deepEqual(log.footer, { text: 'PvP Draw List Log', icon_url: 'attachment://cc_logo.webp' });
    assert.equal(log.timestamp, new Date(NOW).toISOString());
    assert.equal(log.color, 0x452366);
    assert.deepEqual(logPayload.files.map(file => file.name), ['cc_logo.webp']);
    assert.deepEqual(logPayload.allowedMentions, { parse: [] });
    assert.deepEqual(state.calls.at(-1), ['edit-reply',
        { content: 'The draw list has been successfully updated ✅', embeds: [], components: [] }]);
    assert.equal(state.command.previews.size, 0);
});

test('an unavailable log channel does not turn a saved draw list into a failure', async () => {
    const state = fixture({ config: { logChannelID: 'missing-log-channel' } });
    const [confirmId] = await openPreview(state);
    await state.command.handleButton(click(state, confirmId));
    assert.equal(edits(state).length, 1);
    assert.equal(state.calls.some(([type]) => type === 'send-log'), false);
    assert.equal(state.calls.at(-1)[1].content, 'The draw list has been successfully updated ✅');
});

test('Confirm keeps the embed files of the draw list inside the embed instead of showing them as images', async () => {
    const state = fixture();
    state.message.channelId = '1373940670309597314';
    const ownFile = 'https://cdn.discordapp.com/attachments/1373940670309597314/1572397542891585636/' +
        'embed-author-icon-1572397232118956133.png?ex=6afe38d3&is=6afce753&hm=abc';
    const otherChannelFile = 'https://cdn.discordapp.com/attachments/999999999999999999/1/cc_logo.webp?ex=1';
    state.message.embeds = [{
        description: OLD_STAMP, color: 0x452366,
        author: { name: 'Crow Control  •  PvP Draw List', icon_url: ownFile, proxy_icon_url: 'https://media.example/icon.png' },
        footer: { text: 'Footer', icon_url: otherChannelFile },
        thumbnail: { url: 'https://example.com/thumbnail.png' }
    }];
    const [confirmId] = await openPreview(state);
    await state.command.handleButton(click(state, confirmId));
    const embed = edits(state)[0].embeds[0].toJSON();
    assert.equal(embed.author.icon_url, 'attachment://embed-author-icon-1572397232118956133.png');
    assert.equal(embed.footer.icon_url, otherChannelFile);
    assert.equal(embed.thumbnail.url, 'https://example.com/thumbnail.png');
    assert.equal(embed.description, `-# Last updated <t:${NOW_SECONDS}:f> — <t:${NOW_SECONDS}:R>`);
});

test('Cancel leaves the draw list and its timestamp untouched', async () => {
    const state = fixture();
    const [, cancelId] = await openPreview(state);
    await state.command.handleButton(click(state, cancelId));
    assert.equal(edits(state).length, 0);
    assert.deepEqual(state.calls.at(-1), ['update',
        { content: 'Your changes have been canceled ❌', embeds: [], components: [] }]);
    assert.equal(state.command.previews.size, 0);
});

test('Confirm refuses a draw list changed after the preview and accepts text that is already saved', async () => {
    const stale = fixture();
    const [staleId] = await openPreview(stale);
    stale.message.content = OLD_CONTENT + '\n- **Someone** ~ <@222222222222222222>';
    await stale.command.handleButton(click(stale, staleId));
    assert.equal(edits(stale).length, 0);
    assert.match(stale.calls.at(-1)[1].content, /changed after your preview/);
    assert.deepEqual(stale.calls.at(-1)[1].components, []);

    const saved = fixture();
    const [savedId] = await openPreview(saved);
    saved.message.content = SAVED;
    await saved.command.handleButton(click(saved, savedId));
    assert.equal(edits(saved).length, 0);
    assert.equal(saved.calls.at(-1)[1].content, 'The draw list has been successfully updated ✅');
});

test('a failed save keeps the old timestamp and the preview for another Confirm', async () => {
    const state = fixture();
    const ids = await openPreview(state);
    let attempts = 0;
    state.message.edit = async payload => {
        if (++attempts === 1) throw new Error('Edit rejected');
        state.calls.push(['edit-message', payload]);
    };
    await state.command.handleButton(click(state, ids[0]));
    assert.equal(edits(state).length, 0);
    assert.equal(state.message.embeds[0].description, OLD_STAMP);
    assert.deepEqual(state.calls.at(-2)[1].components[0].toJSON().components.map(button => button.custom_id), ids);
    assert.deepEqual(state.calls.at(-1), ['follow-up', {
        content: '### ❌  The draw list could not be updated.\n- Press **Confirm** to try again, or **Cancel**.',
        flags: MessageFlags.Ephemeral
    }]);
    await state.command.handleButton(click(state, ids[0]));
    assert.equal(edits(state).length, 1);
    assert.equal(state.command.previews.size, 0);
});

test('a second click while Confirm is saving is refused privately', async () => {
    const state = fixture();
    const ids = await openPreview(state);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const saving = new Promise(resolve => { release = resolve; });
    state.message.edit = async payload => {
        state.calls.push(['edit-message', payload]);
        entered();
        await saving;
    };
    const pending = state.command.handleButton(click(state, ids[0]));
    await started;
    try {
        for (const customId of ids) {
            await state.command.handleButton(click(state, customId));
            assert.equal(state.calls.at(-1)[0], 'reply');
            assert.match(state.calls.at(-1)[1].content, /already being processed/);
        }
    } finally {
        release();
        await pending;
    }
    assert.equal(edits(state).length, 1);
});

test('foreign, unauthorized and expired clicks never edit the draw list', async () => {
    const state = fixture();
    const ids = await openPreview(state);
    const start = state.calls.length;
    assert.equal(await state.command.handleButton(click(state, 'confirmEdit_123_456_false_abc')), false);
    assert.equal(state.calls.length, start);
    for (const overrides of [{ user: { id: 'other-user' } }, { member: { roles: { cache: new Collection() } } }]) {
        await state.command.handleButton(click(state, ids[0], overrides));
        assert.deepEqual(state.calls.at(-1), ['reply', NO_PERMISSION]);
    }
    state.command.now = () => NOW + 15 * 60_000 - 1;
    assert.equal(state.command.previews.size, 1);
    state.command.pruneExpired();
    assert.equal(state.command.previews.size, 1, 'The preview stays valid for the full 15 minutes');
    state.command.now = () => NOW + 15 * 60_000;
    await state.command.handleButton(click(state, ids[0]));
    assert.match(state.calls.at(-1)[1].content, /expired/);
    assert.equal(state.calls.slice(start).some(([type]) => ['fetch-channel', 'edit-message', 'update'].includes(type)), false);
    assert.equal(state.command.previews.size, 0);
});
