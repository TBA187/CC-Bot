// Cover public reports, team history, Pokémon search and screenshot messages.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewPayload } = require('../commands/scout-review.js');
const { buildScoutEmbed } = require('../commands/scout.js');
const { authorDisplay } = require('../features/pvp-scouting/ScoutAuthorDisplay.js');
const Scout = require('../commands/scout.js');
const { packTeamPages } = require('../features/pvp-scouting/ScoutTeamPages.js');
const { SERVERS } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { scoutPayload, scoutTextInput } = require('../features/pvp-scouting/ScoutPresentation.js');

test('shared scout modal inputs preserve zero ratings, limits, styles and placeholders', () => {
    const rating = scoutTextInput('rating', 'PvP rating', 0, false, false, 5).toJSON();
    assert.equal(rating.label, 'PvP rating');
    assert.equal(rating.component.custom_id, 'rating');
    assert.equal(rating.component.value, '0');
    assert.equal(rating.component.required, false);
    assert.equal(rating.component.max_length, 5);
    assert.equal(rating.component.style, 1);
    const notes = scoutTextInput('notes', 'Notes', '123456', true, true, 4, 'Enter notes').toJSON().component;
    assert.equal(notes.value, '1234');
    assert.equal(notes.required, true);
    assert.equal(notes.style, 2);
    assert.equal(notes.placeholder, 'Enter notes');
    assert.equal(scoutTextInput('notes', 'Notes', null).toJSON().component.value, undefined);
});

function originalAndContinuation() {
    const root = {
        message_id: '1350059044102078494', root_message_id: '1350059044102078494',
        author_id: '123456789012345678', author_username: 'reporter',
        created_at: new Date('2025-03-14T11:52:00Z'), message_content: '',
        opponent_ign: 'Blacku', ign_confidence: 0.95, review_status: 'pending',
        attachments: [{ name: 'team.png', contentType: 'image/png', url: 'https://example.com/team.png' }],
        ocrResults: [], source_url: 'https://discord.com/channels/1/2/1350059044102078494'
    };
    const continuation = {
        ...root, message_id: '1350059160351412264', created_at: new Date('2025-03-14T11:52:30Z'),
        message_content: 'Tornadus hp ice - digg fire punch - muk alola shadow neak',
        team_text: '- Tornadus: Hidden Power Ice\n- Diggersby: Fire Punch\n- Muk-Alola: Shadow Sneak',
        attachments: [], source_url: 'https://discord.com/channels/1/2/1350059160351412264'
    };
    return { root, continuation };
}

test('same-author continuation is part of the original review report and its team', () => {
    const { root, continuation } = originalAndContinuation();
    const embed = reviewPayload({ ...root, linkedSources: [root, continuation] }, 0, 1, 'owner').embeds[0].toJSON();
    assert.match(embed.description, /Scout Source:.*Jump to message.*1350059044102078494/u);
    assert.doesNotMatch(embed.description, /1350059160351412264/u);
    assert.doesNotMatch(embed.description, /Scout Reply/u);
    assert.ok(!embed.fields.some(field => field.name.startsWith('Linked scouting messages')));
    assert.match(embed.fields.find(field => field.name === 'Message text').value, /Tornadus hp ice/u);
    assert.match(embed.fields.find(field => field.name === 'Pokémon Team').value, /Muk-Alola: Shadow Sneak/u);
});

test('same-author continuation stays in the public report original team and source links', () => {
    const { root, continuation } = originalAndContinuation();
    const embed = buildScoutEmbed(root, [root, continuation], 0, 1).embed.toJSON();
    assert.match(embed.description, /Pokémon Team/u);
    assert.match(embed.description, /Hidden Power Ice/u);
    assert.doesNotMatch(embed.description, /Information added later/u);
    const sourceField = embed.fields.find(field => field.name === 'Original message');
    assert.match(sourceField.value, /Jump to message.*1350059044102078494/u);
    assert.doesNotMatch(sourceField.value, /1350059160351412264/u);
    assert.ok(!embed.fields.some(field => /reply/iu.test(field.name)));
    assert.ok(!embed.fields.some(field => /^(?:Candidate IGN|PvP Rating|Confidence Score|Reason)$/u.test(field.name)));
});

test('other-author reply is supplemental information with its own reply link', () => {
    const { root, continuation } = originalAndContinuation();
    const reply = {
        ...continuation, message_id: '1350059260351412264', author_id: '223456789012345678',
        author_username: 'other-reporter', reply_to_id: root.message_id,
        message_content: 'Clefable: Moonblast', team_text: '- Clefable: Moonblast',
        source_url: 'https://discord.com/channels/1/2/1350059260351412264'
    };
    const review = reviewPayload({ ...root, linkedSources: [root, continuation, reply] }, 0, 1, 'owner').embeds[0].toJSON();
    assert.match(review.description, /Scout Reply:.*1350059260351412264/u);
    assert.match(review.fields.find(field => field.name === 'Linked scouting messages').value, /Clefable/u);
    assert.doesNotMatch(review.fields.find(field => field.name === 'Message text').value, /Clefable/u);
    const publicEmbed = buildScoutEmbed(root, [root, continuation, reply], 0, 1).embed.toJSON();
    assert.doesNotMatch(publicEmbed.description, /Information added later/u);
    assert.match(publicEmbed.description, /Clefable.*Moonblast/u);
    assert.ok(publicEmbed.fields.some(field => field.name === 'Message reply'
        && field.value.includes(reply.source_url)));
});

test('a different-author message without a reply reference does not claim to be a reply', () => {
    const { root, continuation } = originalAndContinuation();
    continuation.author_id = '223456789012345678';
    continuation.author_username = 'other-reporter';
    const embed = reviewPayload({ ...root, linkedSources: [root, continuation] }, 0, 1, 'owner').embeds[0].toJSON();
    assert.doesNotMatch(embed.description, /Scout Reply/u);
    assert.match(embed.description, /Linked Scout Source/u);
});

test('sources belonging to a different root are never shown in report links or notes', () => {
    const { root, continuation } = originalAndContinuation();
    const unrelated = {
        ...continuation, message_id: '1350059360351412264', root_message_id: '1350059360351412264',
        message_content: 'Unrelated report content', team_text: '- Pikachu: Thunderbolt',
        source_url: 'https://discord.com/channels/1/2/1350059360351412264'
    };
    const review = reviewPayload({ ...root, linkedSources: [root, continuation, unrelated] }, 0, 1, 'owner').embeds[0].toJSON();
    assert.doesNotMatch(review.description, /1350059360351412264/u);
    assert.ok(review.fields.every(field => !/Unrelated|Pikachu/u.test(field.value)));
    const publicEmbed = buildScoutEmbed(root, [root, continuation, unrelated], 0, 1).embed.toJSON();
    assert.doesNotMatch(publicEmbed.description, /Unrelated|Pikachu/u);
    assert.ok(publicEmbed.fields.every(field => !/1350059360351412264/u.test(field.value)));
});

test('saved author IDs render one mention and plain username is only a fallback', async () => {
    const mention = await authorDisplay(null, { author_id: '123456789012345678', author_username: 'vangogsan' });
    assert.equal(mention, '<@123456789012345678>');
    assert.equal(await authorDisplay(null, { author_username: 'vangogsan' }), 'vangogsan');
    const { root } = originalAndContinuation();
    const embed = reviewPayload(root, 0, 1, 'owner', mention).embeds[0].toJSON();
    assert.match(embed.description, /Scouted by:\*\* <@123456789012345678>/u);
    assert.doesNotMatch(embed.description, /vangogsan/u);
});

test('a review opened during the member correction window warns the officer and keeps every action', () => {
    const { root } = originalAndContinuation();
    const dueAt = Date.now() + 30 * 60 * 1000;
    const open = reviewPayload({ ...root, correction_open: true, correction_due_at_ms: dueAt }, 0, 1, 'owner');
    const description = open.embeds[0].toJSON().description;
    assert.match(description, new RegExp(`^⚠️ \\*\\*The member's correction window is still open\\.\\*\\* It ends <t:${Math.floor(dueAt / 1000)}:R>\\.`, 'u'));
    assert.match(description, /officers are alerted only if it remains unresolved/u);
    assert.deepEqual(open.components[0].toJSON().components.map(button => button.label),
        ['Previous', 'Next', 'Confirm', 'Correct', 'Not a scout']);
    assert.deepEqual(open.allowedMentions, { parse: [] });
    // The deadline is omitted until the window has started, and after it has passed.
    for (const due of [null, Date.now() - 1000]) {
        const text = reviewPayload({ ...root, correction_open: true, correction_due_at_ms: due }, 0, 1, 'owner').embeds[0].toJSON().description;
        assert.match(text, /correction window is still open/u);
        assert.doesNotMatch(text, /It ends/u);
    }
    assert.doesNotMatch(reviewPayload(root, 0, 1, 'owner').embeds[0].toJSON().description, /correction window/u);
});

function embedTextLength(embeds) {
    return embeds.reduce((sum, value) => {
        const embed = value.toJSON?.() || value;
        return sum + (embed.title?.length || 0) + (embed.description?.length || 0)
            + (embed.footer?.text?.length || 0) + (embed.author?.name?.length || 0)
            + (embed.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
    }, 0);
}

function longReports(count, detailsLength = 450) {
    return Array.from({ length: count }, (_, index) => {
        const id = String(1500000000000000000n + BigInt(index));
        const root = { message_id: id, root_message_id: id,
            author_id: '123456789012345678', author_username: 'reporter',
            opponent_ign: 'Blacku', ign_normalized: 'blacku', classification: 'scout',
            review_status: 'corrected', created_at: new Date(Date.UTC(2026, 8, 30 - index)),
            team_text: `- Slowbro: Scald, Teleport, Future Sight. ${'detail '.repeat(Math.ceil(detailsLength / 7)).slice(0, detailsLength)}`,
            source_url: `https://discord.com/channels/1/2/${id}`,
            attachments: [{ id: `image-${id}`, name: `${id}.png`, contentType: 'image/png',
                url: `https://example.com/${id}.png` }], ocrResults: [] };
        return { root, sources: [root] };
    });
}

test('whole-team packer adds a second description only when the first cannot hold the next complete block', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({ id: index, block: `${index}:${'x'.repeat(498)}` }));
    const pages = packTeamPages(entries, { title: 'Scout', headerForPage: () => 'Header', footerForPage: () => 'Footer' });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].descriptions.length, 2);
    assert.deepEqual(pages[0].entries, entries);
    for (const entry of entries) {
        assert.equal(pages[0].descriptions.filter(description => description.includes(entry.block)).length, 1);
    }
    assert.ok(pages[0].descriptions.every(description => description.length <= 4096));
    const short = packTeamPages(entries.slice(0, 2), { headerForPage: () => 'Header' });
    assert.equal(short[0].descriptions.length, 1);
});

test('whole-team packer moves the overflowing team to the next page and counts all embed text', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({ id: index, block: `${index}:${'x'.repeat(647)}` }));
    const pages = packTeamPages(entries, { title: 'PvP Scout Report — Blacku',
        headerForPage: (_page, count) => `Showing ${count} reported teams`,
        footerForPage: (page, count, total) => `${count} teams • Page ${page + 1} of ${total}` });
    assert.equal(pages[0].entries.length, 9);
    assert.deepEqual(pages.flatMap(page => page.entries), entries);
    assert.equal(pages[1].entries[0].id, 9);
    for (const [index, page] of pages.entries()) {
        assert.match(page.descriptions[0], new RegExp(`Showing ${page.entries.length} reported teams`));
        assert.ok(page.title.length + page.footer.length + page.descriptions.reduce((sum, text) => sum + text.length, 0) <= 6000);
        assert.match(page.footer, new RegExp(`Page ${index + 1} of ${pages.length}`));
        assert.ok(page.entries.length <= 10);
    }
});

test('teams and search share complete-team pagination, accurate counts and screenshot report IDs', async () => {
    const results = longReports(20);
    const command = new Scout({ pvpScoutStore: {} });
    const { token, session } = command.createHistorySession('Blacku', 0, 'owner', results);
    let firstIds;
    for (const search of [null, { species: 'Slowbro', label: 'Slowbro' }]) {
        session.search = search;
        session.teamPages = new Map();
        const first = await command.historyPayload(session, token, 0, results);
        const firstTeams = session.teamPages.get(0);
        assert.ok(firstTeams.length < 10, 'full details require fewer reports than the maximum of ten');
        assert.ok(first.embeds.length > 1);
        assert.ok(first.embeds.every(embed => !embed.toJSON().fields?.length));
        assert.ok(embedTextLength(first.embeds) <= 6000);
        assert.doesNotMatch(first.embeds.map(embed => embed.toJSON().description).join('\n'), /details shortened|truncated/u);
        if (search) assert.match(first.embeds[0].toJSON().description, /20.*search results.*Slowbro/u);
        else {
            assert.match(first.embeds[0].toJSON().description, /\*\*Scout Reports: `20`\*\*/u);
            assert.match(first.embeds[0].toJSON().description, new RegExp(`Showing the .*${firstTeams.length}.*latest Scout Reports`));
        }
        const allIds = new Set(firstTeams);
        for (const id of firstTeams) {
            const entry = results.find(result => result.root.message_id === id);
            const body = command.teamsForResults(results, search).find(team => team.root.message_id === id).team;
            assert.equal(first.embeds.filter(embed => embed.toJSON().description.includes(body)
                && embed.toJSON().description.includes(entry.root.source_url)).length, 1);
        }
        const second = await command.historyPayload(session, token, 1, results);
        const secondIds = session.teamPages.get(1);
        assert.ok(secondIds.every(id => !allIds.has(id)));
        assert.ok(embedTextLength(second.embeds) <= 6000);
        assert.deepEqual(secondIds, results.slice(firstTeams.length, firstTeams.length + secondIds.length).map(item => item.root.message_id));
        if (!search) firstIds = firstTeams;
        const branded = scoutPayload(first);
        assert.ok(branded.embeds.slice(0, -1).every(embed => !embed.toJSON().footer));
        assert.equal(branded.embeds.at(-1).toJSON().footer.icon_url, undefined);
        assert.equal(branded.files, undefined);
    }
    assert.ok(firstIds.length > 0);
});

test('a single oversized team keeps its source link with a notice rather than cropping its Pokémon list', async () => {
    const results = longReports(1, 4500);
    const command = new Scout({ pvpScoutStore: {} });
    const { token, session } = command.createHistorySession('Blacku', 0, 'owner', results);
    const payload = await command.historyPayload(session, token, 0, results);
    const description = payload.embeds[0].toJSON().description;
    assert.match(description, /full details exceed Discord's embed limit/u);
    assert.match(description, /Jump to message/u);
    assert.ok(description.includes(results[0].root.source_url));
    assert.doesNotMatch(description, /details shortened|truncated|detail detail/u);
});

test('rating summaries count grouped roots and only teams history adds the latest reported rating', async () => {
    const results = longReports(3, 0);
    results[0].root.rating = 420;
    results[1].root.rating = null;
    results[2].root.rating = 300;
    const reply = { ...results[0].root, message_id: '1500000000000000099', rating: 9999 };
    results[0].sources.push(reply);
    const command = new Scout({ pvpScoutStore: {} });
    const teams = await command.teamsPayload('Blacku', 'owner', null, results);
    assert.match(teams.embeds[0].toJSON().description, /\*\*Average PvP Rating:\*\* \*\*360\*\*/u);
    assert.match(teams.embeds[0].toJSON().description, /\*\*`2`\*\* of \*\*`3`\*\* scout reports/u);
    assert.match(teams.embeds[0].toJSON().description, /\*\*Last reported PvP Rating:\*\* \*\*420\*\*/u);
    const detail = await command.payloadFor('Blacku', 0, 'owner', null, results);
    assert.equal(detail.embeds[0].toJSON().title, `${SERVERS.gold.markup} PvP Scout Report — Blacku (420)`);
    assert.match(detail.embeds[0].toJSON().description, /\*\*Average PvP Rating:\*\* \*\*360\*\*/u);
    assert.doesNotMatch(detail.embeds[0].toJSON().description, /Last reported PvP Rating/u);
    const { token, session } = command.createHistorySession('Blacku', 0, 'owner', results);
    session.search = { species: 'Slowbro', label: 'Slowbro' };
    const search = await command.historyPayload(session, token, 0, results);
    assert.doesNotMatch(search.embeds[0].toJSON().description, /Average PvP Rating|Last reported PvP Rating/u);
});

test('scout navigation shares one snapshot read and invalidates it immediately after a saved change', async () => {
    const original = longReports(1, 0);
    const next = longReports(2, 0);
    let reads = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const store = { dataRevision: 0, async searchRootsAndSources() {
        reads++;
        if (reads === 1) await pending;
        const results = reads === 1 ? original : next;
        return { roots: results.map(item => item.root), sources: results.flatMap(item => item.sources) };
    } };
    const command = new Scout({ pvpScoutStore: store });
    const first = command.loadResults('Blacku');
    const second = command.loadResults('blacku');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    release();
    const [firstResults, secondResults] = await Promise.all([first, second]);
    assert.equal(firstResults, secondResults);
    assert.equal(await command.loadResults('Blacku'), firstResults);
    assert.equal(reads, 1);
    store.dataRevision++;
    const refreshed = await command.loadResults('Blacku');
    assert.equal(reads, 2);
    assert.equal(refreshed.length, 2);
});

function countedTeamFormatter(t) {
    const modulePath = require.resolve('../features/pvp-scouting/ScoutReportSources.js');
    const previous = require.cache[modulePath];
    const parser = require('../features/pvp-scouting/PvpScoutParser.js');
    let parses = 0;
    t.mock.method(parser, 'splitScoutText', body => {
        parses++;
        return { teamText: `- ${body}`, notes: null };
    });
    delete require.cache[modulePath];
    const { teamDisplayText } = require(modulePath);
    t.after(() => {
        delete require.cache[modulePath];
        if (previous) require.cache[modulePath] = previous;
    });
    return { format: teamDisplayText, parses: () => parses };
}

test('team layout cache reuses identical text and IGN while treating edits and different opponents separately', t => {
    const formatter = countedTeamFormatter(t);
    const team = '- Slowbro: Scald\n- Gliscor: Toxic';
    assert.equal(formatter.format(team, 'Blacku'), team);
    assert.equal(formatter.parses(), 2);
    assert.equal(formatter.format(team, 'Blacku'), team);
    assert.equal(formatter.parses(), 2);
    assert.equal(formatter.format(team, 'OtherOpponent'), team);
    assert.equal(formatter.parses(), 4);
    const edited = team.replace('Scald', 'Teleport');
    assert.equal(formatter.format(edited, 'Blacku'), edited);
    assert.equal(formatter.parses(), 6);
});

test('team layout cache evicts older entries instead of retaining every previously displayed report', t => {
    const formatter = countedTeamFormatter(t);
    const oldest = '- Slowbro: Detail 0';
    formatter.format(oldest, 'Blacku');
    for (let index = 1; index <= 201; index++) formatter.format(`- Slowbro: Detail ${index}`, 'Blacku');
    assert.equal(formatter.parses(), 202);
    formatter.format('- Slowbro: Detail 201', 'Blacku');
    assert.equal(formatter.parses(), 202);
    formatter.format(oldest, 'Blacku');
    assert.equal(formatter.parses(), 203);
});

test('team layout cache bounds retained text as well as its number of entries', t => {
    const formatter = countedTeamFormatter(t);
    const first = `- Slowbro: ${'A'.repeat(60000)}`;
    const second = `- Slowbro: ${'B'.repeat(60000)}`;
    formatter.format(first, 'Blacku');
    formatter.format(second, 'Blacku');
    assert.equal(formatter.parses(), 2);
    formatter.format(second, 'Blacku');
    assert.equal(formatter.parses(), 2);
    formatter.format(first, 'Blacku');
    assert.equal(formatter.parses(), 3);
});

test('cached formatting preserves Pokémon detail notes and still expands compact multiple-Pokémon lines', () => {
    const { teamDisplayText } = require('../features/pvp-scouting/ScoutReportSources.js');
    const team = '- Tyranitar (seems AV, slower than bold Pelipper): Earthquake, Pursuit, Stone Edge\n'
        + '- Slowbro: Scald, Teleport, Future Sight';
    assert.equal(teamDisplayText(team, '90skid'), team);
    assert.equal(teamDisplayText(team, '90skid'), team);
    const compact = 'Gliscor: Toxic, Starmie: Scald, Aegislash: Kings Shield';
    const expanded = teamDisplayText(compact, '90skid');
    assert.match(expanded, /Gliscor.*Toxic\n- Starmie.*Scald\n- Aegislash/u);
    assert.equal(teamDisplayText(compact, '90skid'), expanded);
});
