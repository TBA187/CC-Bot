// Check server setup, permissions and archive isolation throughout scout navigation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const Scout = require('../commands/scout.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');

const USER_ID = '291142291073269761';
const GUILD_ID = '1148499020038295582';
const CHANNELS = { gold: '1180559470435246132', silver: '1553366937654788236' };

function fixture(preference = 'gold') {
    const preferences = new Map([[USER_ID, preference]]), reads = [], countReads = [], writes = [], sent = [], ingested = [];
    const contexts = ['gold', 'silver'].map((server, index) => {
        const roots = [0, 1].map(offset => {
            const id = String(1500000000000000000n + BigInt(index * 10 + offset));
            return { message_id: id, root_message_id: id, channel_id: CHANNELS[server], server,
                opponent_ign: 'SameOpponent', author_id: USER_ID, author_username: 'Reporter',
                created_at: new Date(`2026-09-${20 - offset}T10:00:00Z`),
                message_content: server === 'gold' ? 'Charizard: Roost' : 'Slowbro: Scald',
                team_text: server === 'gold' ? '- Charizard: Roost' : '- Slowbro: Scald',
                rating: server === 'gold' ? 420 : 180, review_status: 'corrected', notes: null, attachments: [],
                source_url: `https://discord.com/channels/${GUILD_ID}/${CHANNELS[server]}/${id}` };
        });
        const store = { channelId: CHANNELS[server], dataRevision: 0, roots,
            async ensureSchema() {},
            async publicReportCount(ign, channelId) {
                assert.equal(channelId, CHANNELS[server]);
                countReads.push([server, ign]);
                return roots.filter(root => root.opponent_ign.toLowerCase() === ign).length;
            },
            async searchRootsAndSources(ign, channelId) {
                assert.equal(channelId, CHANNELS[server]);
                reads.push([server, ign]);
                const matching = roots.filter(root => ign === null || root.opponent_ign.toLowerCase() === ign);
                return { roots: matching, sources: matching };
            },
            cachedAutocomplete(_term, channelId) { assert.equal(channelId, CHANNELS[server]); return [`${SERVERS[server].label}Opponent`]; },
            cachedAutocompleteReportCount(ign, channelId) {
                assert.equal(channelId, CHANNELS[server]);
                return ign === `${SERVERS[server].label}Opponent` ? index + 2 : undefined;
            },
            async autocomplete() { return [`${SERVERS[server].label}Opponent`]; }
        };
        const ingestor = { async handleCreate(message) { ingested.push([server, message.id]); return { review_status: 'approved' }; } };
        return { server, channelId: CHANNELS[server], store, ingestor };
    });
    const registry = { contexts: () => contexts, get: server => contexts.find(context => context.server === server) };
    const service = {
        getCachedServer: (_guild, id) => preferences.has(id) ? preferences.get(id) : undefined,
        async getSelectedServer(_guild, id) { return preferences.get(id) || null; },
        async select(interaction, server) {
            const previous = preferences.get(interaction.user.id) || null;
            writes.push(server); preferences.set(interaction.user.id, server); return { previous, selected: server };
        }
    };
    const client = { channels: { cache: new Map(contexts.map(context => [context.channelId, {
        async send(payload) {
            sent.push([context.server, payload]); return { id: `${context.server}-submission`, channelId: context.channelId };
        }
    }])) } };
    const config = { guildId: GUILD_ID, guildMemberRoleID: 'member', officerRoleID: 'officer',
        adminRoleID: 'admin', leaderRoleID: 'leader', pvpScoutingGoldChannelID: CHANNELS.gold,
        pvpScoutingSilverChannelID: CHANNELS.silver, scoutServers: registry, scoutServerSettings: service, client,
        pvpScoutStore: contexts[0].store, pvpScoutIngestor: contexts[0].ingestor };
    return { command: new Scout(config), contexts, preferences, service, reads, countReads, writes, sent, ingested };
}

test('server dropdown counts do not fetch the other archive\'s full reports', async () => {
    const f = fixture('gold'), counts = [];
    f.contexts[1].store.publicReportCount = async (ign, channelId) => {
        counts.push([ign, channelId]); return 2;
    };
    f.contexts[1].store.searchRootsAndSources = async () => { throw new Error('Unnecessary full archive lookup'); };
    const view = f.command.viewFor('gold');
    const payload = await view.teamsPayload('SameOpponent', USER_ID, null);
    const options = payload.components[0].toJSON().components[0].options;
    assert.deepEqual(options.slice(0, 3).map(option => option.label),
        ['Gold Server (2)', 'Silver Server (2)', 'Cross Server (4)']);
    assert.deepEqual(f.reads, [['gold', 'sameopponent']]);
    assert.ok(counts.every(([ign, channelId]) => ign === 'sameopponent' && channelId === CHANNELS.silver));
});

function interaction({ ign = 'SameOpponent', server = null, customId = '', fields = {}, authorized = true,
    values = [], message = null } = {}) {
    const calls = [];
    return { calls, customId, values, message, guildId: GUILD_ID, guild: { id: GUILD_ID }, createdTimestamp: Date.now(),
        user: { id: USER_ID, username: 'Reporter', displayAvatarURL: () => 'https://example.com/avatar.png' },
        member: { nickname: 'ReporterIGN', roles: authorized ? ['member'] : [] }, inGuild: () => true,
        options: { getString: name => name === 'server' ? server : ign, getFocused: () => ign },
        fields: { getTextInputValue: name => fields[name] || '', getUploadedFiles: () => null,
            getStringSelectValues: name => fields[name] ? [fields[name]] : [],
            getRadioGroup: name => fields[name] || (name === 'server' ? 'silver' : 'newest') },
        async reply(payload) { calls.push(['reply', payload]); },
        async deferReply(payload) { calls.push(['deferReply', payload]); },
        async deferUpdate() { calls.push(['deferUpdate']); },
        async editReply(payload) { calls.push(['editReply', payload]); },
        async followUp(payload) { calls.push(['followUp', payload]); },
        async respond(payload) { calls.push(['respond', payload]); },
        async showModal(payload) { calls.push(['showModal', payload]); }
    };
}

function buttons(payload) { return payload.components.flatMap(row => row.toJSON().components); }
function body(payload) { return payload.embeds.map(embed => embed.toJSON().description || '').join('\n'); }
function lastEdit(i) { return i.calls.findLast(([action]) => action === 'editReply')?.[1]; }
function serverSelect(payload, value, options = {}) {
    return interaction({ customId: payload.components[0].toJSON().components[0].custom_id, values: [value], ...options });
}

test('scout registers all three server options while retaining required IGN autocomplete', () => {
    const { command } = fixture();
    const options = command.data.toJSON().options;
    assert.equal(options[0].name, 'in_game_name');
    assert.equal(options[0].required, true); assert.equal(options[0].autocomplete, true);
    assert.equal(options[1].name, 'server'); assert.equal(Boolean(options[1].required), false);
    assert.deepEqual(options[1].choices.map(({ name, value }) => ({ name, value })), [{ name: 'Gold', value: 'gold' }, { name: 'Silver', value: 'silver' }, { name: 'Cross Server', value: 'cross' }]);
    assert.equal(options[1].description, 'Select Server (optional) — Save your default server for future Scout Reports with: /cc-settings');
});

test('first-use autocomplete offers cached opponents in the requested archives', async () => {
    const f = fixture(null);
    for (const server of [null, 'gold', 'silver']) {
        const i = interaction({ ign: '', server });
        await f.command.handleAutocomplete(i);
        const expected = server === 'gold' ? ['GoldOpponent'] : server === 'silver' ? ['SilverOpponent'] : ['GoldOpponent', 'SilverOpponent'];
        assert.deepEqual(i.calls[0][1].map(choice => choice.value), expected);
    }
    assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test('unknown preference cache answers from both archives while the preference read runs later', async () => {
    const f = fixture();
    f.service.getCachedServer = () => undefined;
    let started = false;
    f.service.getSelectedServer = () => { started = true; return new Promise(() => {}); };
    const i = interaction();
    await f.command.handleAutocomplete(i);
    assert.equal(started, false);
    assert.equal(i.calls[0][1][0].value, 'GoldOpponent');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, true);
});

test('first-use setup is private and branded and remembers the chosen IGN', async () => {
    const f = fixture(null), i = interaction();
    await f.command.execute(i);
    assert.deepEqual(i.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    const payload = lastEdit(i), embed = payload.embeds[0].toJSON();
    assert.equal(payload.content, `### <@${USER_ID}>, please select your default server below.`);
    assert.equal(embed.footer.text, 'Crow Control Server Settings');
    assert.equal(embed.footer.icon_url, undefined);
    assert.equal(embed.thumbnail.url, 'https://example.com/avatar.png'); assert.ok(embed.timestamp);
    assert.deepEqual(buttons(payload).map(button => button.label), ['Gold', 'Silver', 'Cross Server']);
    assert.deepEqual(buttons(payload).map(button => button.emoji.id), [SERVERS.gold.emoji.id, SERVERS.silver.emoji.id, undefined]);
    assert.deepEqual(f.reads, []);
});

test('explicit first-use confirmation offers selected and alternative servers, and both save their named server', async () => {
    for (const explicit of ['gold', 'silver', 'cross']) for (const buttonIndex of [0, 1, 2]) {
        const f = fixture(null), i = interaction({ server: explicit });
        await f.command.execute(i);
        const setup = lastEdit(i), controls = buttons(setup);
        const alternatives = Object.keys(SERVERS).filter(key => key !== explicit);
        assert.deepEqual(controls.map(button => button.label), [`Yes (${SERVERS[explicit].label})`, ...alternatives.map(key => SERVERS[key].label)]);
        const selected = [explicit, ...alternatives][buttonIndex];
        const click = interaction({ customId: controls[buttonIndex].custom_id });
        await f.command.handleButton(click);
        assert.deepEqual(f.writes, [selected]);
        assert.equal(f.preferences.get(USER_ID), selected);
        assert.equal(click.calls[0][0], 'deferUpdate');
        assert.match(lastEdit(click).embeds[0].toJSON().title, /PvP Scout Report — SameOpponent/u);
        assert.ok(f.reads.length, 'saving setup opens the selected IGN immediately');
        assert.equal(lastEdit(click).components[0].toJSON().components[0].options.find(option => option.default).value, selected);
    }
});

test('failed first-use selection returns private feedback and retains the setup controls', async t => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    const f = fixture(null);
    f.service.select = async () => { throw new Error('Role assignment failed'); };
    const setup = f.command.serverSetupPayload(interaction(), null, 'SameOpponent');
    const i = interaction({ customId: buttons(setup)[0].custom_id });
    await f.command.handleButton(i);
    assert.deepEqual(i.calls.map(([action]) => action), ['deferUpdate', 'followUp']);
    assert.equal(i.calls[1][1].flags, MessageFlags.Ephemeral);
    assert.match(i.calls[1][1].content, /Could not save/u); assert.deepEqual(f.reads, []);
    assert.ok(errors[0][0].includes(USER_ID));
    assert.match(errors[0][0], /Selected server: Gold/);
    assert.match(errors[0][0], /Reason: Role assignment failed/);
});

test('commands, buttons and modals enforce permissions, while autocomplete exposes no names', async () => {
    const f = fixture();
    for (const [method, customId] of [['execute', ''], ['handleButton', `pvp-scout:server:${USER_ID}:gold`],
        ['handleButton', `pvp-scout:page:${USER_ID}:U2FtZU9wcG9uZW50:0:gold`],
        ['handleModal', `pvp-scout:add-modal:${USER_ID}:token:gold`]]) {
        const i = interaction({ customId, authorized: false }); await f.command[method](i);
        assert.deepEqual(i.calls, [['reply', { content: 'No permission!', flags: MessageFlags.Ephemeral }]]);
    }
    const autocomplete = interaction({ authorized: false }); await f.command.handleAutocomplete(autocomplete);
    assert.deepEqual(autocomplete.calls, [['respond', []]]);
    assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test('a saved preference chooses its archive and an explicit override changes only the lookup', async () => {
    const f = fixture('gold');
    const gold = interaction(); await f.command.execute(gold);
    assert.match(body(lastEdit(gold)), /Charizard/u); assert.match(body(lastEdit(gold)), /420/u);
    assert.doesNotMatch(body(lastEdit(gold)), /Slowbro|\*\*180\*\*/u);
    const silver = interaction({ server: 'silver' }); await f.command.execute(silver);
    assert.match(body(lastEdit(silver)), /Slowbro/u); assert.match(body(lastEdit(silver)), /180/u);
    assert.doesNotMatch(body(lastEdit(silver)), /Charizard|\*\*420\*\*/u);
    assert.equal(f.preferences.get(USER_ID), 'gold'); assert.deepEqual(f.writes, []);
    assert.deepEqual(f.reads, [['gold', 'sameopponent'], ['silver', 'sameopponent']]);
});

test('saved preferences and overrides keep autocomplete names and report counts server-scoped', async () => {
    const f = fixture('gold');
    const gold = interaction({ ign: '' }); await f.command.handleAutocomplete(gold);
    assert.deepEqual(gold.calls[0][1], [{ name: '🥇 GoldOpponent — Scout Reports: 2', value: 'GoldOpponent' }]);
    const silver = interaction({ ign: '', server: 'silver' }); await f.command.handleAutocomplete(silver);
    assert.deepEqual(silver.calls[0][1], [{ name: '🥈 SilverOpponent — Scout Reports: 3', value: 'SilverOpponent' }]);
    assert.equal(f.preferences.get(USER_ID), 'gold');
    await new Promise(resolve => setImmediate(resolve));
});

test('a saved Cross Server preference opens both archives without changing the preference', async () => {
    const f = fixture('cross'), i = interaction();
    await f.command.execute(i);
    assert.match(body(lastEdit(i)), /Charizard/u); assert.match(body(lastEdit(i)), /Slowbro/u);
    assert.deepEqual(f.writes, []);
});

test('open Silver history and detailed pages remain Silver after the saved preference changes', async () => {
    const f = fixture('silver'), open = interaction(); await f.command.execute(open);
    const detailed = buttons(lastEdit(open)).find(button => button.label === 'Detailed View');
    assert.match(detailed.custom_id, /:silver$/u);
    f.preferences.set(USER_ID, 'gold');
    const click = interaction({ customId: detailed.custom_id }); await f.command.handleButton(click);
    const detail = lastEdit(click);
    assert.match(body(detail), /Slowbro/u); assert.doesNotMatch(body(detail), /Charizard/u);
    assert.ok(buttons(detail).filter(button => !button.custom_id.startsWith('pvp-scout:switch:')).every(button => button.custom_id.endsWith(':silver')));
    const next = buttons(detail).find(button => button.label === 'Next Page');
    const page = interaction({ customId: next.custom_id }); await f.command.handleButton(page);
    assert.match(body(lastEdit(page)), /Slowbro/u); assert.doesNotMatch(body(lastEdit(page)), /Charizard/u);
    assert.match(lastEdit(page).embeds[0].toJSON().footer.text, /Scout 2 of 2/u);
    assert.deepEqual(f.reads, [['silver', 'sameopponent']]);
    assert.ok(f.countReads.some(([server, ign]) => server === 'gold' && ign === 'sameopponent'));
});

test('search modals and results stay bound to the originating archive', async () => {
    const f = fixture('silver'), open = interaction(); await f.command.execute(open);
    const search = buttons(lastEdit(open)).find(button => button.label === 'Search');
    f.preferences.set(USER_ID, 'gold');
    const click = interaction({ customId: search.custom_id }); await f.command.handleButton(click);
    const modal = click.calls[0][1].toJSON(); assert.match(modal.custom_id, /:silver$/u);
    const submit = interaction({ customId: modal.custom_id, fields: { pokemon: 'Slowbro' } });
    await f.command.handleModal(submit);
    assert.match(body(lastEdit(submit)), /2.*search results found/u);
    assert.match(body(lastEdit(submit)), /Slowbro/u); assert.doesNotMatch(body(lastEdit(submit)), /Charizard/u);
    assert.ok(buttons(lastEdit(submit)).filter(button => !button.custom_id.startsWith('pvp-scout:switch:')).every(button => button.custom_id.endsWith(':silver')));
});

test('image actions use only the originating server reports after a preference change', async () => {
    const f = fixture('silver'), open = interaction(); await f.command.execute(open);
    const showImages = buttons(lastEdit(open)).find(button => button.label === 'Images');
    const seen = [];
    f.command.viewFor('silver').screenshotPayload = async (_ign, sources) => {
        seen.push(...sources.map(source => source.server)); return { content: 'Silver screenshots', embeds: [], components: [] };
    };
    f.preferences.set(USER_ID, 'gold');
    const click = interaction({ customId: showImages.custom_id }); await f.command.handleButton(click);
    assert.deepEqual(seen, ['silver', 'silver']); assert.equal(lastEdit(click).content, 'Silver screenshots');
});

test('add-report sessions post to their bound server channel and ingestor', async () => {
    const f = fixture('silver'), open = interaction(); await f.command.execute(open);
    const add = buttons(lastEdit(open)).find(button => button.label === 'Add Scout Report');
    const click = interaction({ customId: add.custom_id }); await f.command.handleButton(click);
    const modal = click.calls[0][1].toJSON(); assert.match(modal.custom_id, /:silver$/u);
    f.preferences.set(USER_ID, 'gold');
    const submit = interaction({ customId: modal.custom_id, fields: { rating: '321', team: 'Slowbro: Scald', notes: '' } });
    await f.command.handleModal(submit);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'silver');
    assert.equal(f.sent[0][1].embeds[0].toJSON().title, 'PvP Scout Report — SameOpponent');
    assert.deepEqual(f.ingested, [['silver', 'silver-submission']]);
    assert.match(lastEdit(submit).content, /Thank you/u);
});

test('tampering with the server suffix cannot reuse another archive modal session', async () => {
    const f = fixture('silver');
    const modal = f.command.viewFor('silver').addReportModal(USER_ID, 'SameOpponent').toJSON();
    const submit = interaction({ customId: modal.custom_id.replace(/:silver$/u, ':gold'), fields: { team: 'Slowbro: Scald' } });
    await f.command.handleModal(submit);
    assert.match(lastEdit(submit), /expired/u); assert.deepEqual(f.sent, []);
});

test('server-bound controls and modal identifiers fit Discord limits for a 32-character IGN', async () => {
    const f = fixture('silver'), view = f.command.viewFor('silver');
    const ign = 'A'.repeat(32);
    for (const context of f.contexts) for (const root of context.store.roots) root.opponent_ign = ign;
    const teams = await view.teamsPayload(ign, USER_ID);
    const details = await view.payloadFor(ign, 0, USER_ID);
    for (const payload of [teams, details]) for (const button of buttons(payload)) {
        assert.ok(button.custom_id.length <= 100, button.custom_id);
        if (!button.custom_id.startsWith('pvp-scout:switch:')) assert.match(button.custom_id, /:silver$/u);
    }
    const { token, session } = view.createHistorySession(ign, 0, USER_ID, await view.loadResults(ign));
    session.reportCount = 2;
    for (const modal of [view.addReportModal(USER_ID, ign), view.searchModal(session, token), view.pageNumberModal(session, token)]) {
        assert.ok(modal.toJSON().custom_id.length <= 100); assert.match(modal.toJSON().custom_id, /:silver$/u);
    }
});

test('combined autocomplete sorts by latest timestamps, uses UTC dates and deterministic ties', async () => {
    const f = fixture(null);
    for (const context of f.contexts) {
        context.store.cachedAutocomplete = () => ['Shared', context.server === 'gold' ? 'Newest' : 'Older'];
        context.store.cachedAutocompleteReportCount = name => (name === 'Shared'
            || context.server === 'gold' && name === 'Newest'
            || context.server === 'silver' && name === 'Older') ? context.server === 'gold' ? 2 : 3 : undefined;
        context.store.cachedAutocompleteLatestScout = name => name === 'Shared' ? '2026-10-01T23:30:00Z'
            : context.server === 'gold' ? '2026-10-02T00:30:00Z' : '2026-09-30T00:30:00Z';
    }
    const i = interaction({ ign: '' }); await f.command.handleAutocomplete(i);
    assert.deepEqual(i.calls[0][1].map(choice => choice.name), [
        '🥇 Newest — Scout Reports: 2 (2026-10-02)',
        '🥇 Shared — Scout Reports: 2 (2026-10-01) — 🥈 Scout Reports: 3 (2026-10-01)',
        '🥈 Older — Scout Reports: 3 (2026-09-30)'
    ]);
    assert.equal(i.calls[0][1].filter(choice => choice.value.toLowerCase() === 'shared').length, 1);
    assert.deepEqual(f.reads, []);
});

test('combined pages show separate averages, latest dates, actual server markers and colors', async () => {
    const f = fixture('cross'), open = interaction(); await f.command.execute(open);
    const teams = lastEdit(open), description = body(teams);
    assert.equal(teams.embeds[0].toJSON().color, SERVERS.cross.color);
    assert.match(description, /Gold: \*\*420\*\*/u); assert.match(description, /Silver: \*\*180\*\*/u);
    assert.match(description, /reported in \*\*`2`\*\* of \*\*`2`\*\* scout reports/u);
    assert.match(description, /\*\*Last reported PvP Rating:\*\*[\s\S]*\*\*420\*\* \(2026-09-20\)/u);
    for (const server of ['gold', 'silver']) assert.ok(description.includes(`${SERVERS[server].markup} <t:`));
    assert.doesNotMatch(description, /\*\*Scout Reports: `4`\*\*/u);
    assert.ok(description.includes(`${SERVERS.gold.markup} **Gold: \`2\`** scout reports`));
    assert.ok(description.includes(`${SERVERS.gold.markup} **Gold: \`2\`** scout reports (2026-09-19 — 2026-09-20)\n${SERVERS.silver.markup} **Silver: \`2\`** scout reports (2026-09-19 — 2026-09-20)`));
    const detailClick = interaction({ customId: buttons(teams).find(button => button.label === 'Detailed View').custom_id });
    await f.command.handleButton(detailClick);
    const details = lastEdit(detailClick);
    assert.equal(details.embeds[0].toJSON().color, SERVERS.silver.color);
    assert.ok(details.embeds[0].toJSON().title.startsWith(SERVERS.silver.markup));
    assert.doesNotMatch(body(details), /Last reported PvP Rating/u);
    const next = interaction({ customId: buttons(details).find(button => button.label === 'Next Page').custom_id });
    await f.command.handleButton(next);
    assert.equal(lastEdit(next).embeds[0].toJSON().color, SERVERS.gold.color);
    assert.ok(lastEdit(next).embeds[0].toJSON().title.startsWith(SERVERS.gold.markup));
});

test('Gold and Silver team pages identify reports in the other server and offer Cross Server', async () => {
    const f = fixture('gold');
    f.contexts[1].store.roots.length = 1;

    const gold = await f.command.viewFor('gold').teamsPayload('SameOpponent', USER_ID);
    assert.ok(body(gold).includes(`There is \`1\` scout report in ${SERVERS.silver.markup} **Silver Server**.`));
    assert.match(body(gold), /Change to \*\*Cross Server\*\* to view all scout reports for \*\*SameOpponent\*\*/u);

    const silver = await f.command.viewFor('silver').teamsPayload('SameOpponent', USER_ID);
    assert.ok(body(silver).includes(`There are \`2\` scout reports in ${SERVERS.gold.markup} **Gold Server**.`));
    assert.match(body(silver), /Change to \*\*Cross Server\*\* to view all scout reports for \*\*SameOpponent\*\*/u);

    const cross = await f.command.viewFor('cross').teamsPayload('SameOpponent', USER_ID);
    assert.doesNotMatch(body(cross), /Change to \*\*Cross Server\*\*/u);
});

test('recent IGN choices reuse newest-first autocomplete metadata and stay within modal limits', async () => {
    const f = fixture('cross'), view = f.command.viewFor('cross');
    for (const context of f.contexts) {
        context.store.cachedAutocomplete = () => Array.from({ length: 25 }, (_, index) => `${context.server}Player${index}`);
        context.store.cachedAutocompleteReportCount = name => name.startsWith(context.server)
            ? context.server === 'gold' ? 2 : 3 : undefined;
        context.store.cachedAutocompleteLatestScout = name => new Date(Date.UTC(2026, 8, 30, 0, -Number(name.match(/\d+$/u)[0])
            - (context.server === 'silver' ? 1 : 0))).toISOString();
    }
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
    const modal = view.searchModal(session, token).toJSON();
    assert.equal(modal.components.length, 5);
    const select = modal.components.find(label => label.component?.custom_id === 'recent_ign').component;
    assert.equal(select.options.length, 25);
    assert.equal(select.options[0].value, 'gold:goldPlayer0');
    assert.match(select.options[0].label, /Scout Reports: 2 \(2026-09-30\)/u);
    assert.equal(select.options[1].value, 'gold:goldPlayer1');
    assert.equal(select.required, false);
    assert.ok(select.options.every(option => !option.default && option.value.length <= 100 && option.label.length <= 100));
    assert.ok(modal.components.filter(component => component.component).every(label => label.description.length <= 100));
});

test('typed IGN overrides the optional recent choice while choice-only lookup uses the current server', async () => {
    for (const typed of ['', 'OtherOpponent']) {
        const f = fixture('silver'), view = f.command.viewFor('silver');
        f.contexts[1].store.cachedAutocomplete = () => ['SameOpponent'];
        const source = f.contexts[1].store.roots[0];
        f.contexts[1].store.roots.push({ ...source, opponent_ign: 'OtherOpponent',
            message_id: '1500000000000000201', root_message_id: '1500000000000000201' });
        const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
        const submit = interaction({ customId: view.searchModal(session, token).toJSON().custom_id,
            fields: { recent_ign: typed ? 'silver:NoLongerHere' : 'silver:SameOpponent', ign: typed } });
        await f.command.handleModal(submit);
        assert.match(lastEdit(submit).embeds[0].toJSON().title, new RegExp(typed || 'SameOpponent'));
        assert.equal(f.command.historySessions.get(token).ign, typed || 'SameOpponent');
        assert.deepEqual(f.writes, []);
    }
});

test('detail searches combine species and all requirements on the same Pokémon without hiding the full team', async () => {
    const f = fixture('gold'), view = f.command.viewFor('gold');
    f.contexts[0].store.roots[0].team_text = '- Gengar (Item: Focus Sash; Nature: Timid; Ability: Levitate): Shadow Ball\n- Charizard: Roost';
    f.contexts[0].store.roots[1].team_text = '- Gengar: Shadow Ball\n- Alakazam (Item: Focus Sash)';
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
    const submit = interaction({ customId: view.searchModal(session, token).toJSON().custom_id,
        fields: { ign: 'SameOpponent', pokemon: 'Gengar', details: 'shadow ball, sash, timid, levitate' } });
    await f.command.handleModal(submit);
    const text = body(lastEdit(submit));
    assert.match(text, /`1`.*search result found/u);
    assert.match(text, /> - 🔎.*Gengar/u); assert.match(text, /Charizard/u);
    assert.doesNotMatch(text, /Alakazam/u);
    assert.equal(f.command.historySessions.get(token).globalSearch, false);
});

test('details alone search all opponents and keep server switching, Back, and images scoped correctly', async () => {
    const f = fixture('gold'), view = f.command.viewFor('gold');
    const root = f.contexts[0].store.roots[0];
    root.team_text = '- Gengar (Item: Focus Sash): Shadow Ball';
    root.attachments = [{ contentType: 'image/png', url: 'https://example.com/gengar.png' }];
    f.contexts[0].store.roots.push({ ...root, opponent_ign: 'OtherOpponent', message_id: '1500000000000000202',
        root_message_id: '1500000000000000202' });
    f.contexts[1].store.roots[0].team_text = '- Gengar (Item: Choice Specs): Shadow Ball';
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
    const submit = interaction({ customId: view.searchModal(session, token).toJSON().custom_id, fields: { details: 'shadow ball, sash' } });
    await f.command.handleModal(submit);
    const payload = lastEdit(submit);
    assert.match(body(payload), /`2`.*search results found/u);
    assert.match(body(payload), /\*\*OtherOpponent\*\*/u);
    assert.ok(f.reads.some(([server, ign]) => server === 'gold' && ign === null));
    const seen = [];
    view.screenshotPayload = async (_ign, sources) => { seen.push(...sources.map(source => source.message_id)); return { content: 'Screenshots' }; };
    await f.command.handleButton(interaction({ customId: buttons(payload).find(button => button.label === 'Images').custom_id }));
    assert.deepEqual(seen.sort(), [root.message_id, '1500000000000000202'].sort());
    const switcher = serverSelect(payload, 'silver'); await f.command.handleSelect(switcher);
    assert.match(body(lastEdit(switcher)), /`0`.*search results found/u);
    assert.equal(f.command.historySessions.get(token).globalSearch, true);
    const back = interaction({ customId: buttons(lastEdit(switcher)).find(button => button.label === 'Back').custom_id });
    await f.command.handleButton(back);
    assert.equal(f.command.historySessions.get(token).globalSearch, false);
    assert.equal(f.command.historySessions.get(token).ign, 'SameOpponent');
    assert.equal(f.preferences.get(USER_ID), 'gold');
});

test('global search heading names the Gold, Silver or Cross Server scope', async () => {
    const expected = {
        gold: /across all opponents in the \*\*Gold Server\*\*/u,
        silver: /across all opponents in the \*\*Silver Server\*\*/u,
        cross: /across all opponents in \*\*both Servers\*\*/u
    };
    for (const server of ['gold', 'silver', 'cross']) {
        const f = fixture(server), view = f.command.viewFor(server);
        const results = await view.loadResults('SameOpponent');
        const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, results);
        session.globalSearch = true;
        session.search = { details: [{ kind: 'move', name: 'Roost' }], label: 'Rocky Helmet + Roost' };
        const payload = await view.historyPayload(session, token, 0, results);
        assert.match(body(payload), expected[server]);
    }
});

test('Cross Server submission defaults use the saved physical preference while physical views override it', () => {
    for (const preference of ['gold', 'silver', 'cross', null]) {
        const f = fixture(preference);
        for (const server of ['gold', 'silver', 'cross']) {
            const choices = f.command.viewFor(server).addReportModal(USER_ID, 'SameOpponent').toJSON().components[0].component.options;
            assert.equal(choices.find(option => option.default)?.value || null,
                server === 'cross' ? ['gold', 'silver'].includes(preference) ? preference : null : server);
        }
    }
});

test('all Sort buttons are blue and both initial setup variants mention the user', async () => {
    const f = fixture();
    for (const server of ['gold', 'silver', 'cross']) {
        const view = f.command.viewFor(server);
        for (const payload of [await view.teamsPayload('SameOpponent', USER_ID), await view.payloadFor('SameOpponent', 0, USER_ID)]) {
            assert.equal(buttons(payload).find(button => button.label === 'Sort').style, 1);
        }
        assert.equal(f.command.serverSetupPayload(interaction(), server, 'SameOpponent').content,
            `### <@${USER_ID}>, please select your default server below.`);
    }
});

test('report counts use all report dates in UTC, independently of stored ratings and the displayed page', async () => {
    const f = fixture('cross');
    f.contexts[0].store.roots[1].created_at = new Date('2026-09-18T23:30:00Z');
    f.contexts[0].store.roots[1].rating = null;
    f.contexts[1].store.roots.splice(1);
    const cross = await f.command.viewFor('cross').teamsPayload('SameOpponent', USER_ID);
    assert.ok(body(cross).includes(`${SERVERS.gold.markup} **Gold: \`2\`** scout reports (2026-09-18 — 2026-09-20)\n${SERVERS.silver.markup} **Silver: \`1\`** scout report (2026-09-20)`));
    assert.doesNotMatch(body(cross), /Scout Reports: `3`/u);
    const gold = await f.command.viewFor('gold').teamsPayload('SameOpponent', USER_ID);
    assert.match(body(gold), /\*\*Scout Reports: `2`\*\* \(2026-09-18 — 2026-09-20\)/u);
    f.contexts[1].store.roots.splice(0);
    f.contexts[1].store.dataRevision++;
    const updated = await f.command.viewFor('cross').teamsPayload('SameOpponent', USER_ID);
    assert.ok(body(updated).includes(`${SERVERS.silver.markup} **Silver: \`0\`** scout reports`));
});

test('unique typed IGN prefixes resolve while ambiguous prefixes leave the previous lookup intact', async () => {
    const f = fixture('gold'), view = f.command.viewFor('gold');
    const root = f.contexts[0].store.roots[0];
    f.contexts[0].store.roots.push({ ...root, opponent_ign: 'OtherOpponent', message_id: '1500000000000000203',
        root_message_id: '1500000000000000203' });
    f.contexts[0].store.autocomplete = async () => ['OtherOpponent'];
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
    const first = interaction({ customId: view.searchModal(session, token).toJSON().custom_id, fields: { ign: 'Other' } });
    await f.command.handleModal(first);
    assert.equal(f.command.historySessions.get(token).ign, 'OtherOpponent');
    f.contexts[0].store.autocomplete = async () => ['OtherOpponent', 'OtherPlayer'];
    const previous = f.command.historySessions.get(token);
    const ambiguous = interaction({ customId: view.searchModal(previous, token).toJSON().custom_id, fields: { ign: 'Other' },
        message: { id: 'ambiguous-prefix', components: lastEdit(first).components } });
    await f.command.handleModal(ambiguous);
    assert.match(ambiguous.calls.find(([action]) => action === 'followUp')[1].content, /multiple opponents/u);
    assert.equal(f.command.historySessions.get(token), previous);
});

test('supplements can supply different search requirements for the same Pokémon within one report', async () => {
    const f = fixture('gold'), view = f.command.viewFor('gold');
    const root = f.contexts[0].store.roots[0];
    root.team_text = '- Gengar: Shadow Ball\n- Gengar (Item: Focus Sash)\n- Charizard: Roost';
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, await view.loadResults('SameOpponent'));
    const submit = interaction({ customId: view.searchModal(session, token).toJSON().custom_id,
        fields: { ign: 'SameOpponent', details: 'shadow ball, sash' } });
    await f.command.handleModal(submit);
    assert.match(body(lastEdit(submit)), /`1`.*search result found/u);
    assert.equal((body(lastEdit(submit)).match(/> - 🔎/gu) || []).length, 1);
    assert.match(body(lastEdit(submit)), /Gengar.*Focus Sash.*Shadow Ball/u);
    assert.match(body(lastEdit(submit)), /Charizard/u);
});

test('lookup server switches preserve the page type and search without saving preferences', async () => {
    const f = fixture('gold'), open = interaction(); await f.command.execute(open);
    const cross = serverSelect(lastEdit(open), 'cross');
    await f.command.handleSelect(cross);
    const search = interaction({ customId: buttons(lastEdit(cross)).find(button => button.label === 'Search').custom_id });
    await f.command.handleButton(search);
    const submit = interaction({ customId: search.calls[0][1].toJSON().custom_id, fields: { pokemon: 'Slowbro' } });
    await f.command.handleModal(submit);
    assert.match(body(lastEdit(submit)), /2.*search results found/u);
    const gold = serverSelect(lastEdit(submit), 'gold');
    await f.command.handleSelect(gold);
    assert.match(body(lastEdit(gold)), /0.*search results found.*Slowbro/u);
    assert.equal(lastEdit(gold).embeds[0].toJSON().title, `${SERVERS.gold.markup} PvP Scout Search`);
    const silver = serverSelect(lastEdit(gold), 'silver');
    await f.command.handleSelect(silver);
    assert.match(body(lastEdit(silver)), /2.*search results found.*Slowbro/u);
    assert.deepEqual(f.writes, []); assert.equal(f.preferences.get(USER_ID), 'gold');
});

test('sort modal keeps its order through team, detailed and back navigation', async () => {
    const f = fixture('cross'), open = interaction(); await f.command.execute(open);
    const sort = interaction({ customId: buttons(lastEdit(open)).find(button => button.label === 'Sort').custom_id });
    await f.command.handleButton(sort);
    const modal = sort.calls[0][1].toJSON();
    assert.equal(modal.components[0].component.options.length, 6);
    const submit = interaction({ customId: modal.custom_id, fields: { sort: 'oldest' } });
    await f.command.handleModal(submit);
    const teams = lastEdit(submit), text = body(teams);
    const oldest = f.contexts[0].store.roots[1].created_at.getTime() / 1000;
    const latest = f.contexts[0].store.roots[0].created_at.getTime() / 1000;
    assert.ok(text.indexOf(`<t:${oldest}:F>`) < text.indexOf(`<t:${latest}:F>`));
    const detail = interaction({ customId: buttons(teams).find(button => button.label === 'Detailed View').custom_id });
    await f.command.handleButton(detail);
    assert.match(lastEdit(detail).embeds[0].toJSON().footer.text, new RegExp(f.contexts[0].store.roots[1].message_id, 'u'));
    const back = interaction({ customId: buttons(lastEdit(detail)).find(button => button.label === 'Back').custom_id });
    await f.command.handleButton(back);
    assert.ok(body(lastEdit(back)).indexOf(`<t:${oldest}:F>`) < body(lastEdit(back)).indexOf(`<t:${latest}:F>`));
});

test('empty archive views show actual counts from the other archive and retain switches', async () => {
    const f = fixture('silver'); f.contexts[1].store.roots.length = 0;
    const open = interaction(); await f.command.execute(open);
    const payload = lastEdit(open);
    assert.match(body(payload), /no reported scout reports.*Silver Server/u);
    assert.match(body(payload), /\*\*2\*\* scout reports were found.*Gold Server/u);
    assert.equal(payload.embeds[0].toJSON().color, SERVERS.silver.color);
    assert.deepEqual(payload.components[0].toJSON().components[0].options.map(option => option.label),
        ['Gold Server (2)', 'Silver Server (0)', 'Cross Server (2)', 'Choose Default Server Here']);
});

test('Cross Server submission requires an actual archive and keeps the five-field modal', async () => {
    const f = fixture('cross'), view = f.command.viewFor('cross');
    const modal = view.addReportModal(USER_ID, 'SameOpponent').toJSON();
    assert.equal(modal.title, 'Add Scout Report'); assert.equal(modal.components.length, 5);
    assert.equal(modal.components[0].label, 'Server');
    assert.equal(modal.components[0].description, 'IGN (In-Game Name): SameOpponent');
    assert.deepEqual(modal.components[0].component.options.map(option => option.label), ['🥇 Gold', '🥈 Silver']);
    assert.ok(modal.components[0].component.options.every(option => !option.default));
    const submit = interaction({ customId: modal.custom_id, fields: { server: 'gold', team: 'Charizard: Roost' } });
    await f.command.handleModal(submit);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0][0], 'gold');
    assert.deepEqual(f.ingested, [['gold', 'gold-submission']]);
    const replay = interaction({ customId: modal.custom_id, fields: { server: 'gold', team: 'Charizard: Roost' } });
    await f.command.handleModal(replay);
    assert.equal(f.sent.length, 1);
});

test('a successful setup preference survives a subsequent report-loading failure', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture(null), open = interaction(); await f.command.execute(open);
    f.contexts[0].store.searchRootsAndSources = async () => { throw new Error('Database unavailable'); };
    const click = interaction({ customId: buttons(lastEdit(open))[0].custom_id });
    await f.command.handleButton(click);
    assert.equal(f.preferences.get(USER_ID), 'gold');
    assert.match(click.calls.find(([action]) => action === 'followUp')[1].content, /default server was saved/u);
});

test('simultaneous submissions from one form create just one source', async () => {
    const f = fixture('cross');
    const modal = f.command.viewFor('cross').addReportModal(USER_ID, 'SameOpponent').toJSON();
    const channel = f.command.client.channels.cache.get(CHANNELS.gold), send = channel.send;
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    channel.send = async payload => { entered(); await waiting; return send(payload); };
    const first = interaction({ customId: modal.custom_id, fields: { server: 'gold', team: 'Charizard: Roost' } });
    const pending = f.command.handleModal(first); await started;
    const second = interaction({ customId: modal.custom_id, fields: { server: 'gold', team: 'Charizard: Roost' } });
    await f.command.handleModal(second);
    assert.match(lastEdit(second), /already being submitted/u);
    release(); await pending;
    assert.equal(f.sent.length, 1); assert.equal(f.ingested.length, 1);
});

test('a posted source cannot be duplicated by replaying a form after archive processing fails', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture('cross'); f.contexts[0].ingestor.handleCreate = async () => { throw new Error('Database unavailable'); };
    const modal = f.command.viewFor('cross').addReportModal(USER_ID, 'SameOpponent').toJSON();
    for (let attempt = 0; attempt < 2; attempt++) {
        const submit = interaction({ customId: modal.custom_id, fields: { server: 'gold', team: 'Charizard: Roost' } });
        await f.command.handleModal(submit);
        assert.match(lastEdit(submit), attempt === 0 ? /report was posted/u : /form expired/u);
    }
    assert.equal(f.sent.length, 1);
});

test('Images stays enabled on every team page when any opponent report has a screenshot', async () => {
    const f = fixture('cross'), view = f.command.viewFor('cross');
    for (const context of f.contexts) {
        const template = context.store.roots[0];
        context.store.roots.length = 0;
        for (let i = 0; i < 7; i++) {
            const id = `${template.message_id}${i}`;
            context.store.roots.push({ ...template, message_id: id, root_message_id: id,
                created_at: new Date(Date.UTC(2026, 8, 20 - i)),
                attachments: context.server === 'silver' && i === 0
                    ? [{ id, contentType: 'image/png', url: `https://example.com/${id}.png` }] : [] });
        }
    }
    const results = await view.loadResults('SameOpponent');
    const { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, results);
    session.sort = 'silver';
    const payload = await view.historyPayload(session, token, 1, results);
    const expected = results.find(item => item.sources.some(source => source.attachments.length)).root.message_id, seen = [];
    const imagesButton = buttons(payload).find(button => button.label === 'Images');
    assert.equal(imagesButton.disabled, false);
    assert.equal(session.imageReportIds.length, results.length);
    view.screenshotPayload = async (_ign, sources) => {
        seen.push(...sources.filter(source => source.attachments.length).map(source => source.message_id));
        return { content: 'Screenshots' };
    };
    const images = interaction({ customId: imagesButton.custom_id });
    await f.command.handleButton(images);
    assert.deepEqual(seen, [expected]);
});

test('server dropdown counts all grouped reports, uses custom emojis and follows the active lookup', async () => {
    const f = fixture('gold');
    f.contexts[0].store.roots[1].team_text = '';
    f.contexts[0].store.roots[1].message_content = '';
    const open = interaction({ server: 'silver' }); await f.command.execute(open);
    const payload = lastEdit(open), select = payload.components[0].toJSON().components[0];
    assert.equal(select.type, 3);
    assert.deepEqual(select.options.map(option => option.label),
        ['Gold Server (2)', 'Silver Server (2)', 'Cross Server (4)', 'Choose Default Server Here']);
    assert.equal(select.options.find(option => option.default).value, 'silver');
    assert.equal(select.options[0].emoji.id, SERVERS.gold.emoji.id);
    assert.equal(select.options[1].emoji.id, SERVERS.silver.emoji.id);
    assert.equal(select.options[2].emoji.name, '🔗');
    assert.deepEqual(payload.components[1].toJSON().components.map(button => button.label),
        ['Search', 'Sort', 'Images', 'Detailed View', 'Add Scout Report']);
    assert.ok(payload.components.every(row => row.toJSON().components.every(component => component.type === 2)
        || row.toJSON().components.length === 1));
    assert.equal(f.preferences.get(USER_ID), 'gold');
    const switcher = serverSelect(payload, 'gold'); await f.command.handleSelect(switcher);
    assert.match(body(lastEdit(switcher)), /\*\*Scout Reports: `2`\*\*/u);
    assert.equal(lastEdit(switcher).embeds[0].toJSON().title, `${SERVERS.gold.markup} PvP Scout Report — SameOpponent`);
    assert.deepEqual(f.writes, []);
});

test('an opposite-server report change refreshes the teams heading without discarding the current archive cache', async () => {
    const f = fixture('gold'), open = interaction();
    await f.command.execute(open);
    assert.match(body(lastEdit(open)), /There are `2` scout reports in/u);
    const gold = f.command.viewFor('gold');
    const [token, session] = gold.historySessions.entries().next().value;
    const silverStore = f.contexts[1].store;
    silverStore.roots.push({ ...silverStore.roots[0], message_id: '1500000000000000099', root_message_id: '1500000000000000099' });
    silverStore.dataRevision++;
    const refreshed = await gold.historyPayload(session, token);
    assert.match(body(refreshed), /There are `3` scout reports in/u);
    assert.equal(f.reads.filter(([server]) => server === 'gold').length, 1);
});

test('search modal has optional IGN and Pokémon fields and rejects a completely blank submission', async () => {
    const f = fixture(), open = interaction(); await f.command.execute(open);
    const click = interaction({ customId: buttons(lastEdit(open)).find(button => button.label === 'Search').custom_id });
    await f.command.handleButton(click);
    const modal = click.calls[0][1].toJSON();
    assert.equal(modal.title, 'Search IGN & Pokémon');
    const labels = modal.components.filter(component => component.component);
    assert.deepEqual(labels.map(label => label.component.custom_id), ['recent_ign', 'ign', 'pokemon', 'details']);
    assert.ok(labels.every(label => label.component.required === false));
    assert.equal(labels[1].label, "Enter opponent's IGN");
    assert.equal(labels[1].component.value, 'SameOpponent');
    assert.equal(labels[1].component.min_length, undefined);
    assert.equal(labels[1].component.placeholder, 'Enter a players IGN from Pokémon Revoluion Online');
    const submit = interaction({ customId: modal.custom_id }); await f.command.handleModal(submit);
    assert.match(submit.calls[0][1].content, /Enter an IGN, a Pokémon, or move/u);
    assert.equal(submit.calls[0][1].flags, MessageFlags.Ephemeral);
});

test('IGN-only and combined search use the displayed archive and replace the previous opponent', async () => {
    for (const fields of [{ ign: 'OtherOpponent' }, { ign: 'OtherOpponent', pokemon: 'Slowbro' }]) {
        const f = fixture('gold');
        const template = f.contexts[1].store.roots[0];
        f.contexts[1].store.roots.push({ ...template, opponent_ign: 'OtherOpponent', message_id: '1500000000000000099',
            root_message_id: '1500000000000000099' });
        const open = interaction({ server: 'silver' }); await f.command.execute(open);
        const click = interaction({ customId: buttons(lastEdit(open)).find(button => button.label === 'Search').custom_id });
        await f.command.handleButton(click);
        const submit = interaction({ customId: click.calls[0][1].toJSON().custom_id, fields });
        await f.command.handleModal(submit);
        const payload = lastEdit(submit), text = body(payload);
        assert.match(text, /Slowbro/u); assert.doesNotMatch(text, /Charizard/u);
        assert.equal(payload.components[0].toJSON().components[0].options.find(option => option.default).value, 'silver');
        assert.equal(f.preferences.get(USER_ID), 'gold'); assert.deepEqual(f.writes, []);
        if (fields.pokemon) {
            assert.match(text, /1.*search result found.*OtherOpponent/u);
            assert.deepEqual(payload.components[1].toJSON().components.map(button => button.label),
                ['Back', 'Search', 'Sort', 'Add Scout Report']);
        } else assert.equal(payload.embeds[0].toJSON().title, `${SERVERS.silver.markup} PvP Scout Report — OtherOpponent`);
        const session = f.command.historySessions.get(payload.components[0].toJSON().components[0].custom_id.split(':')[3]);
        assert.equal(session.ign, 'OtherOpponent');
        assert.equal(session.search?.species || null, fields.pokemon || null);
    }
});

test('an unknown IGN opens its branded empty view and a no-match combined search hides report totals', async () => {
    const f = fixture('cross'), open = interaction(); await f.command.execute(open);
    const view = f.command.viewFor('cross');
    const results = await view.loadResults('SameOpponent'), { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, results);
    const submit = interaction({ customId: view.searchModal(session, token).toJSON().custom_id,
        fields: { ign: 'NotReported' } });
    await f.command.handleModal(submit);
    assert.equal(lastEdit(submit).embeds[0].toJSON().title, '🔗 PvP Scout Report — NotReported');
    assert.match(body(lastEdit(submit)), /no reported scout reports/u);
    const missing = { ...session, search: { species: 'Pikachu', label: 'Pikachu' }, teamPages: new Map() };
    const emptySearch = await view.historyPayload(missing, token, 0, results);
    assert.match(body(emptySearch), /0.*search results found/u);
    assert.doesNotMatch(body(emptySearch), /Scout Reports:|Gold:|Silver:/u);
    assert.ok(!buttons(emptySearch).some(button => button.label === 'Images'));
});

test('all servers offer common sort choices while Cross Server also offers archive order', async () => {
    const f = fixture();
    for (const server of ['gold', 'silver', 'cross']) {
        const view = f.command.viewFor(server), payload = await view.teamsPayload('SameOpponent', USER_ID);
        const click = interaction({ customId: buttons(payload).find(button => button.label === 'Sort').custom_id });
        await f.command.handleButton(click);
        const modal = click.calls[0][1].toJSON(), options = modal.components[0].component.options;
        assert.equal(modal.title, 'Sort');
        assert.deepEqual(options.map(option => option.label), ['Newest Scouts', 'Oldest Scouts', 'Highest PvP Rating',
            ...(server === 'cross' ? ['Gold Server first', 'Silver Server first', 'Alternating between both servers'] : [])]);
        assert.equal(options.find(option => option.default).value, 'newest');
    }
});

test('Highest PvP Rating puts unrated reports last and preserves its order in Detailed View', async () => {
    const f = fixture('gold'), roots = f.contexts[0].store.roots;
    roots[0].rating = null;
    const template = roots[0];
    roots.push({ ...template, message_id: '1500000000000000002', root_message_id: '1500000000000000002', rating: 0 });
    const open = interaction(); await f.command.execute(open);
    const click = interaction({ customId: buttons(lastEdit(open)).find(button => button.label === 'Sort').custom_id });
    await f.command.handleButton(click);
    const submit = interaction({ customId: click.calls[0][1].toJSON().custom_id, fields: { sort: 'rating' } });
    await f.command.handleModal(submit);
    const payload = lastEdit(submit), token = payload.components[0].toJSON().components[0].custom_id.split(':')[3];
    assert.deepEqual(f.command.historySessions.get(token).teamPages.get(0), [roots[1].message_id, roots[2].message_id, roots[0].message_id]);
    const details = interaction({ customId: buttons(payload).find(button => button.label === 'Detailed View').custom_id });
    await f.command.handleButton(details);
    assert.match(lastEdit(details).embeds[0].toJSON().footer.text, new RegExp(roots[1].message_id, 'u'));
});

test('Detailed View always shows More Images and enables it only for additional screenshots', async () => {
    const f = fixture(), view = f.command.viewFor('gold');
    for (const count of [0, 1, 2]) {
        const root = f.contexts[0].store.roots[0];
        root.attachments = Array.from({ length: count }, (_, index) => ({ name: `team${index}.png`, contentType: 'image/png',
            url: `https://example.com/team${index}.png` }));
        const payload = await view.payloadFor('SameOpponent', 0, USER_ID);
        const row = payload.components[1].toJSON().components;
        assert.deepEqual(row.map(button => button.label), ['Back', 'Search', 'Sort', 'More Images', 'Add Scout Report']);
        assert.equal(row.find(button => button.label === 'More Images').disabled, count < 2);
    }
});

test('empty team history exposes available screenshots and enables Images for one screenshot', async () => {
    const f = fixture(), view = f.command.viewFor('gold');
    for (const count of [0, 1, 2]) {
        const template = f.contexts[0].store.roots[0];
        const root = { ...template, team_text: '', message_content: '', notes: null,
            attachments: Array.from({ length: count }, (_, index) => ({ id: `image-${index}`, name: `team${index}.png`,
                contentType: 'image/png', url: `https://example.com/team${index}.png` })) };
        const results = [{ root, sources: [root] }];
        view.loadResults = async () => results;
        const payload = await view.teamsPayload('SameOpponent', USER_ID, null, results);
        const description = body(payload);
        assert.match(description, /\*No reports with Pokémon Team information are available\.\*/u);
        if (!count) assert.doesNotMatch(description, /screenshot is available|screenshots are available/u);
        else assert.ok(description.includes(`- *\`${count}\` screenshot${count === 1 ? ' is' : 's are'} available. Press the 🖼️ **Images** button to view ${count === 1 ? 'it' : 'them'}.*`));

        const imageButton = buttons(payload).find(button => button.label === 'Images');
        assert.equal(imageButton.disabled, count === 0);
        if (count === 1) {
            const seen = [];
            view.screenshotPayload = async (_ign, sources) => {
                seen.push(...sources.map(source => source.message_id));
                return { content: 'Thetick screenshot', embeds: [], components: [] };
            };
            const click = interaction({ customId: imageButton.custom_id });
            await f.command.handleButton(click);
            assert.equal(lastEdit(click).content, 'Thetick screenshot');
            assert.deepEqual(seen, [root.message_id]);
        }
    }
});

test('team and search Page Number appears after two pages and jumps to complete matching report groups', async () => {
    for (const search of [null, { species: 'Charizard', label: 'Charizard' }]) {
        const f = fixture(), view = f.command.viewFor('gold'), roots = f.contexts[0].store.roots;
        const template = roots[0]; roots.length = 0;
        for (let index = 0; index < 25; index++) {
            const id = String(1500000000000000000n + BigInt(index));
            roots.push({ ...template, message_id: id, root_message_id: id, created_at: new Date(Date.UTC(2026, 8, 30 - index)) });
        }
        const results = await view.loadResults('SameOpponent'), { token, session } = view.createHistorySession('SameOpponent', 0, USER_ID, results);
        session.search = search;
        const payload = await view.historyPayload(session, token, 0, results);
        assert.equal(session.teamPageCount, 3);
        assert.deepEqual(payload.components[2].toJSON().components.map(button => button.label),
            ['Previous Page', 'Next Page', 'Page Number']);
        const click = interaction({ customId: buttons(payload).find(button => button.label === 'Page Number').custom_id });
        await f.command.handleButton(click);
        const modal = click.calls[0][1].toJSON();
        const submit = interaction({ customId: modal.custom_id, fields: { page_number: '3' } });
        await f.command.handleModal(submit);
        const selected = f.command.historySessions.get(token);
        assert.equal(selected.currentTeamPage, 2); assert.deepEqual(selected.teamPages.get(2), roots.slice(20).map(root => root.message_id));
        assert.match(lastEdit(submit).embeds.at(-1).toJSON().footer.text, /Page 3 of 3/u);
        if (search) assert.ok(body(lastEdit(submit)).includes('🔎'));
        const invalid = interaction({ customId: modal.custom_id, fields: { page_number: '4' } });
        await f.command.handleModal(invalid);
        assert.match(lastEdit(invalid).content, /from 1 to 3/u);
        assert.equal(f.command.historySessions.get(token).currentTeamPage, 2);
    }
    const f = fixture(), view = f.command.viewFor('gold');
    const roots = f.contexts[0].store.roots, template = roots[0]; roots.length = 0;
    for (let index = 0; index < 11; index++) roots.push({ ...template, message_id: String(index), root_message_id: String(index) });
    const payload = await view.teamsPayload('SameOpponent', USER_ID);
    assert.deepEqual(payload.components[2].toJSON().components.map(button => button.label), ['Previous Page', 'Next Page']);
});

test('Choose Default Server Here opens a private setup and restores the lookup without saving a preference', async () => {
    const f = fixture('gold'), open = interaction(); await f.command.execute(open);
    const payload = lastEdit(open), message = { id: 'setup-look-up', components: payload.components };
    const click = serverSelect(payload, 'default', { message });
    await f.command.handleSelect(click);
    const setup = click.calls.find(([action]) => action === 'followUp')[1];
    assert.equal(setup.flags, MessageFlags.Ephemeral);
    assert.equal(setup.embeds[0].toJSON().title, 'One-time default server setup');
    assert.equal(setup.content, `### <@${USER_ID}>, please select your default server below.`);
    assert.deepEqual(buttons(setup).map(button => button.label), ['Gold', 'Silver', 'Cross Server']);
    assert.deepEqual(f.writes, []); assert.equal(f.preferences.get(USER_ID), 'gold');
    assert.deepEqual(lastEdit(click).components, payload.components.map(row => row.toJSON()));
});

test('server dropdown rejects unauthorized, stale and invalid selections', async () => {
    const f = fixture(), open = interaction(); await f.command.execute(open);
    const payload = lastEdit(open);
    const denied = serverSelect(payload, 'cross', { authorized: false }); await f.command.handleSelect(denied);
    assert.equal(denied.calls[0][1].content, 'No permission!');
    const invalid = serverSelect(payload, 'invalid'); await f.command.handleSelect(invalid);
    assert.match(invalid.calls[0][1].content, /Select Gold, Silver, or Cross Server/u);
    const change = serverSelect(payload, 'silver'); await f.command.handleSelect(change);
    const stale = serverSelect(payload, 'cross'); await f.command.handleSelect(stale);
    assert.match(stale.calls[0][1].content, /no longer available/u);
    assert.deepEqual(f.writes, []);
});

test('failed page updates retain the previous lookup for server, IGN and sort changes', async t => {
    t.mock.method(console, 'warn', () => {});
    for (const action of ['server', 'ign', 'sort']) {
        const f = fixture(), open = interaction(); await f.command.execute(open);
        const payload = lastEdit(open), token = payload.components[0].toJSON().components[0].custom_id.split(':')[3];
        const previous = f.command.historySessions.get(token);
        const view = f.command.viewFor('gold');
        const click = action === 'server' ? serverSelect(payload, 'silver') : action === 'ign'
            ? interaction({ customId: view.searchModal(previous, token).toJSON().custom_id, fields: { ign: 'NotReported' } })
            : interaction({ customId: `pvp-scout:sort-modal:${USER_ID}:${token}:gold`, fields: { sort: 'oldest' } });
        click.message = { id: `failed-update-${action}`, components: payload.components };
        click.editReply = async next => {
            if (next.embeds) throw new Error('Discord unavailable');
            click.calls.push(['editReply', next]);
        };
        if (action === 'server') await f.command.handleSelect(click);
        else await f.command.handleModal(click);
        assert.equal(f.command.historySessions.get(token), previous);
        assert.equal(previous.server, 'gold'); assert.equal(previous.ign, 'SameOpponent'); assert.equal(previous.sort, 'newest');
        assert.ok(click.calls.some(([call]) => call === 'followUp'));
    }
});

test('dropdown server changes preserve Detailed View and its controls', async () => {
    const f = fixture(), open = interaction(); await f.command.execute(open);
    const click = interaction({ customId: buttons(lastEdit(open)).find(button => button.label === 'Detailed View').custom_id });
    await f.command.handleButton(click);
    const switcher = serverSelect(lastEdit(click), 'silver'); await f.command.handleSelect(switcher);
    const payload = lastEdit(switcher);
    assert.equal(payload.embeds[0].toJSON().color, SERVERS.silver.color);
    assert.ok(payload.embeds[0].toJSON().title.startsWith(SERVERS.silver.markup));
    assert.deepEqual(payload.components[1].toJSON().components.map(button => button.label),
        ['Back', 'Search', 'Sort', 'More Images', 'Add Scout Report']);
    assert.match(payload.embeds[0].toJSON().footer.text, /Scout 1 of 2/u);
    assert.deepEqual(f.writes, []);
});
