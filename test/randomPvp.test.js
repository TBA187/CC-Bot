const test = require('node:test');
const assert = require('node:assert/strict');
const { ButtonStyle, ComponentType, MessageFlags } = require('discord.js');

const RandomPvp = require('../commands/randompvp.js');
const { RandomPvpCatalog, defaultCatalog } = require('../features/random-pvp/RandomPvpSets.js');
const { CARD_COLORS, buildSetMessages, footerText, needsTopLink } = require('../features/random-pvp/RandomPvpPresentation.js');
const { RandomPvpEmojis, emojiName } = require('../features/random-pvp/RandomPvpEmojis.js');
const vocabulary = require('../features/pvp-scouting/PokemonVocabulary.js');

const set = (overrides = {}) => ({
    ability: 'Pressure', level: 80, speed: 150, item: 'Leftovers', moves: ['Toxic', 'Protect', 'Roost', 'Earthquake'],
    ...overrides
});
const mega = (overrides = {}) => set({ speed: 150, megaSpeed: 180, ...overrides });
const LONG_SET = set({ moves: ['Moveaaaaaaaaaaaaaaaaaaaa', 'Movebbbbbbbbbbbbbbbbbbbb', 'Movecccccccccccccccccccc', 'Movedddddddddddddddddddd'] });
const SIX_LARGE = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];

function catalogOf(...names) {
    return new RandomPvpCatalog({ pokemon: names.map(name => (typeof name === 'string' ? { name, sets: [set()] } : name)) });
}

const SAMPLE = catalogOf(
    { name: 'Absol', sets: [set({ ability: 'Justified', speed: 174, level: 84 })] },
    { name: 'Absol Mega', sets: [set({ ability: 'Justified', speed: 170, megaSpeed: 236, level: 82, item: 'Absolite' })] },
    { name: 'Rayquaza Mega', sets: [set({ speed: 169, megaSpeed: 196, level: 68 })] },
    'Meganium', 'Ninetales Alolan', 'Mr. Mime', 'Garchomp', 'Gardevoir', 'Infernape', 'Mew'
);

const NAMES = catalogOf(
    'Abomasnow', { name: 'Abomasnow Mega', sets: [mega()] }, 'Charizard', { name: 'Charizard Mega X', sets: [mega()] },
    { name: 'Charizard Mega Y', sets: [mega()] }, 'Tyranitar', { name: 'Tyranitar Mega', sets: [mega()] }, 'Tyrantrum',
    'Salamence', 'Salazzle', 'Gengar', 'Garchomp', 'Rotom', 'Rotom Wash', 'Zygarde 10% (dog)', 'XD001 (Shadow Lugia)', 'Hitmontop',
    'Tauros Paldean - Blaze Breed (Fighting/Fire)', 'Muk Alolan'
);

const containers = message => message.components.map(item => item.toJSON()).filter(item => item.type === ComponentType.Container);
const texts = container => container.components.filter(item => item.type === ComponentType.TextDisplay).map(item => item.content);
const topButton = message => message.components.map(item => item.toJSON())
    .find(item => item.type === ComponentType.ActionRow)?.components[0];

test('the catalog resolves aliases and groups transformed forms under their base Pokémon', () => {
    assert.equal(SAMPLE.resolve('mega absol').name, 'Absol Mega');
    assert.equal(SAMPLE.resolve('Alolan Ninetales').name, 'Ninetales Alolan');
    assert.equal(SAMPLE.resolve('ninetales-alola').name, 'Ninetales Alolan');
    assert.equal(SAMPLE.resolve('Mr Mime').name, 'Mr. Mime');
    assert.deepEqual(SAMPLE.resolve('absol').forms.map(form => form.name), ['Absol Mega']);
    const rayquaza = SAMPLE.resolve('rayquaza');
    assert.deepEqual([rayquaza.sets.length, rayquaza.forms.map(form => form.name)], [0, ['Rayquaza Mega']]);
    assert.equal(SAMPLE.resolve('Meganium').baseKey, null);
    assert.equal(SAMPLE.resolve('Missingno'), null);

    const result = SAMPLE.resolveList('absol, ABSOL MEGA, rayquaza,, xyz; absol');
    assert.deepEqual(result.entries.map(entry => entry.name), ['Absol', 'Rayquaza']);
    assert.deepEqual(result.unknown, ['xyz']);
    assert.equal(result.count, 3);
});

test('names resolve from unique prefixes, nicknames, Mega words, later words and small typos', () => {
    const cases = {
        chari: 'Charizard', aboma: 'Abomasnow', ttar: 'Tyranitar', zard: 'Charizard', 'zard y': 'Charizard Mega Y',
        'mega zard x': 'Charizard Mega X', 'mega zard': 'Charizard', 'ttar mega': 'Tyranitar Mega', megattar: 'Tyranitar Mega',
        mence: 'Salamence', top: 'Hitmontop', wash: 'Rotom Wash', dog: 'Zygarde 10% (dog)', 'shadow lugia': 'XD001 (Shadow Lugia)',
        'tauros blaze': 'Tauros Paldean - Blaze Breed (Fighting/Fire)', 'alolan muk': 'Muk Alolan', charzard: 'Charizard', garchmp: 'Garchomp'
    };
    for (const [input, name] of Object.entries(cases)) assert.equal(NAMES.resolve(input)?.name, name, input);
});

test('text that fits several Pokémon lists them instead of guessing', () => {
    assert.deepEqual(NAMES.resolveMatch('tyran').matches.map(entry => entry.name), ['Tyranitar', 'Tyrantrum']);
    // A nickname that also starts another name lists its own Pokémon first.
    assert.deepEqual(NAMES.resolveMatch('sala').matches.map(entry => entry.name), ['Salamence', 'Salazzle']);
    assert.deepEqual(NAMES.resolveMatch('gar').matches.map(entry => entry.name), ['Gengar', 'Garchomp']);
    assert.equal(NAMES.resolveMatch('ab').entry, null);
    const result = NAMES.resolveList('chari, tyran, xyz');
    assert.deepEqual(result.entries.map(entry => entry.name), ['Charizard']);
    assert.deepEqual(result.ambiguous, [{ text: 'tyran', names: ['Tyranitar', 'Tyrantrum'] }]);
    assert.deepEqual(result.unknown, ['xyz']);
});

// Ordinary choices submit exactly the text they show.
function shown(catalog, text) {
    const choices = catalog.suggest(text);
    for (const choice of choices) if (!/ - All (?:Types|Forms)/u.test(choice.name)) assert.equal(choice.value, choice.name);
    return choices.map(choice => choice.name);
}

test('autocomplete completes the name after the last comma and writes earlier shorthand in full', () => {
    assert.deepEqual(shown(SAMPLE, 'absol, gar'), ['Absol, Garchomp', 'Absol, Gardevoir']);
    assert.deepEqual(shown(SAMPLE, 'mega abs'), ['Absol Mega']);
    assert.ok(!shown(SAMPLE, 'Absol, ').some(choice => /Absol, Absol/.test(choice)));
    assert.deepEqual(shown(SAMPLE, 'xyz, mew'), ['xyz, Mew']);
    // Rayquaza and Ninetales have no sets of their own here, so only their variants are suggested.
    assert.equal(shown(SAMPLE, '').length, 10);
    assert.deepEqual(shown(SAMPLE, 'Absol, Garchomp, Gardevoir, Infernape, Mew, Meganium, Mr'),
        ['Absol, Garchomp, Gardevoir, Infernape, Mew, Meganium']);
    assert.deepEqual(shown(NAMES, 'chari, aboma').slice(0, 2), ['Charizard, Abomasnow', 'Charizard, Abomasnow Mega']);
    assert.deepEqual(shown(NAMES, 'ttar').slice(0, 2), ['Tyranitar', 'Tyranitar Mega']);
    assert.equal(shown(NAMES, 'garchmp')[0], 'Garchomp');
});

test('autocomplete drops the spaces or the choice when a list passes Discord\'s 100-character limit', () => {
    const names = ['A', 'B', 'C', 'D', 'E'].map(letter => `Longmon ${letter}`.padEnd(24, 'x'));
    const catalog = catalogOf(...names);
    const [a, b, c, d] = names;
    assert.deepEqual(shown(catalog, `${a}, ${b}, ${c}, longmon d`), [[a, b, c, d].join(',')]);
    assert.deepEqual(shown(catalog, `${a}, ${b}, ${c}, ${d}, longmon e`), []);
});

const SMALL = 1;
const LARGE = 2;
const layout = card => card.components.map(item => (item.type === ComponentType.Separator
    ? (item.divider && item.spacing === LARGE ? 'wide divider' : item.divider && item.spacing === SMALL ? 'thin divider' : 'other')
    : item.content.split('\n')[0]));
const cardSize = card => 1 + card.components.length;

test('each Pokémon gets its own card, with a wide divider above each transformed form', () => {
    const catalog = catalogOf(
        { name: 'Absol', sets: [set({ ability: 'Justified', item: 'Choice_Band*' })] },
        { name: 'Absol Mega', sets: [set({ speed: 170, megaSpeed: 236 })] },
        { name: 'Charizard', sets: [set()] },
        { name: 'Charizard Mega X', sets: [mega()] },
        { name: 'Charizard Mega Y', sets: [mega({ megaSpeed: 150 })] },
        { name: 'Blastoise Mega', sets: [mega()] },
        'Garchomp'
    );
    const footer = footerText(catalog.setCount);
    const messages = buildSetMessages(catalog.resolveList('Absol, Garchomp, Charizard, Blastoise').entries, catalog.setCount);
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(message.allowedMentions, { parse: [] });
    const [absol, garchomp, charizard, blastoise] = containers(message);
    assert.ok([absol, garchomp, charizard, blastoise].every(card => card.type === ComponentType.Container && card.accent_color === 0x452366));

    assert.deepEqual(texts(absol), [
        '## Absol\n**Lv 80 · Speed 150 · Justified · Choice\\_Band\\***\nToxic, Protect, Roost, Earthquake',
        '## Absol Mega\n**Lv 80 · Speed 170 → 236 · Pressure · Leftovers**\nToxic, Protect, Roost, Earthquake'
    ]);
    assert.deepEqual(layout(absol), ['## Absol', 'wide divider', '## Absol Mega']);
    assert.deepEqual(layout(garchomp), ['## Garchomp']);
    // Every form name uses the same heading size as the Pokémon's own name.
    assert.deepEqual(layout(charizard), ['## Charizard', 'wide divider', '## Charizard Mega X', 'wide divider', '## Charizard Mega Y']);
    assert.match(texts(charizard)[2], /Speed 150 · /u);
    // A form without base sets, such as Rayquaza Mega, starts the card under its own name.
    assert.deepEqual(layout(blastoise), ['## Blastoise Mega', 'thin divider', footer]);
    assert.ok(![absol, garchomp, charizard].some(card => texts(card).includes(footer)));
});

test('sets of one Pokémon are apart by a blank line and the footer credits the list with its set count', () => {
    const catalog = catalogOf({ name: 'Mew', sets: [set(), set({ item: 'Life Orb' })] });
    const [card] = containers(buildSetMessages([catalog.resolve('mew')], catalog.setCount)[0]);
    assert.deepEqual(texts(card), [
        '## Mew\n**Lv 80 · Speed 150 · Pressure · Leftovers**\nToxic, Protect, Roost, Earthquake\n\n' +
            '**Lv 80 · Speed 150 · Pressure · Life Orb**\nToxic, Protect, Roost, Earthquake',
        '-# <:crow_control:1571743936697860127>  Random PvP Sets: **2**  **•**  Compiled by **CitizenPete**'
    ]);
    assert.equal(footerText(1570), '-# <:crow_control:1571743936697860127>  Random PvP Sets: **1,570**  **•**  Compiled by **CitizenPete**');
});

test('large lookups continue in more messages within Discord\'s Components V2 limits', () => {
    const catalog = catalogOf(...SIX_LARGE.map(name => ({ name, sets: Array(14).fill(LONG_SET) })));
    const footer = footerText(catalog.setCount);
    const messages = buildSetMessages(catalog.resolveList(SIX_LARGE.join(', ')).entries, catalog.setCount);
    assert.ok(messages.length > 1);
    for (const message of messages) {
        const cards = containers(message);
        assert.ok(cards.reduce((total, card) => total + texts(card).join('').length, 0) <= 4000);
        assert.ok(cards.reduce((total, card) => total + cardSize(card), 0) <= 40);
    }
    assert.deepEqual(messages.map(message => texts(containers(message).at(-1)).includes(footer)),
        [...Array(messages.length - 1).fill(false), true]);
    assert.deepEqual(messages.flatMap(containers).map(card => texts(card)[0].split('\n')[0]), SIX_LARGE.map(name => `## ${name}`));
});

const FAMILIES = catalogOf(
    'Kyogre', 'Kyogre Primal', 'Ninetales', 'Ninetales Alolan', 'Steelix', 'Steelix Crystal', { name: 'Steelix Mega', sets: [mega()] },
    { name: 'Steelix Crystal Mega', sets: [mega()] }, 'Rotom', 'Rotom Wash', 'Porygon2', 'Porygon-Z', 'Tapu Koko', 'Tapu Lele',
    'Lugia', 'Baby Lugia', 'XD001 (Shadow Lugia)', 'Baby XD001 (Baby Shadow Lugia)', 'Arceus Fire', 'Arceus Water', 'Arceus Normal', 'Silvally Fire', 'Silvally Normal', 'Deoxys Speed', 'Deoxys Attack',
    { name: 'Rayquaza Mega', sets: [mega()] }
);
const formsOf = name => FAMILIES.resolve(name).forms.map(form => form.name);

test('every variant joins its default Pokémon\'s card in a fixed order and stays searchable by itself', () => {
    assert.deepEqual(formsOf('kyogre'), ['Kyogre Primal']);
    assert.deepEqual(formsOf('ninetales'), ['Ninetales Alolan']);
    assert.deepEqual(formsOf('rotom'), ['Rotom Wash']);
    assert.deepEqual(formsOf('lugia'), ['XD001 (Shadow Lugia)', 'Baby Lugia', 'Baby XD001 (Baby Shadow Lugia)']);
    // Other variants come first, then the default Pokémon's own Mega, then the Megas of its variants.
    assert.deepEqual(formsOf('steelix'), ['Steelix Crystal', 'Steelix Mega', 'Steelix Crystal Mega']);
    // A default Pokémon without sets of its own still collects its variants: the Normal type first, then alphabetically.
    assert.deepEqual(formsOf('silvally'), ['Silvally Normal', 'Silvally Fire']);
    assert.deepEqual(formsOf('arceus'), ['Arceus Normal', 'Arceus Fire', 'Arceus Water']);
    assert.deepEqual(formsOf('deoxys'), ['Deoxys Attack', 'Deoxys Speed']);
    for (const [input, name] of [['kyogre primal', 'Kyogre Primal'], ['primal kyogre', 'Kyogre Primal'], ['mega steelix', 'Steelix Mega'],
        ['mega steelix crystal', 'Steelix Crystal Mega'], ['alolan ninetales', 'Ninetales Alolan'], ['deoxys s', 'Deoxys Speed']]) {
        assert.equal(FAMILIES.resolve(input)?.name, name, input);
    }
    assert.deepEqual(FAMILIES.resolveList('Kyogre, Kyogre Primal').entries.map(entry => entry.name), ['Kyogre']);
});

test('Lugia shows its whole family, XD001 shows its baby, and each baby shows only itself', () => {
    assert.deepEqual(formsOf('xd001'), ['Baby XD001 (Baby Shadow Lugia)']);
    assert.deepEqual(formsOf('baby lugia'), []);
    assert.deepEqual(formsOf('baby xd001'), []);
    // "shadow" fits both Shadow Lugias, so it shows XD001's card, which already includes its baby.
    for (const input of ['shadow', 'shadow lugia', 'XD001', 'xd']) assert.equal(FAMILIES.resolve(input).name, 'XD001 (Shadow Lugia)', input);
    assert.equal(FAMILIES.resolve('baby shadow').name, 'Baby XD001 (Baby Shadow Lugia)');
    assert.deepEqual(FAMILIES.resolveList('lugia, xd001, baby xd001').entries.map(entry => entry.name), ['Lugia']);
    assert.deepEqual(FAMILIES.resolveList('xd001, baby xd001, baby lugia').entries.map(entry => entry.name),
        ['XD001 (Shadow Lugia)', 'Baby Lugia']);
    assert.deepEqual(shown(FAMILIES, 'lugia'), ['Lugia', 'XD001 (Shadow Lugia)', 'Baby Lugia', 'Baby XD001 (Baby Shadow Lugia)']);
    assert.deepEqual(shown(FAMILIES, 'shadow'), ['XD001 (Shadow Lugia)', 'Baby XD001 (Baby Shadow Lugia)']);
});

test('separate Pokémon whose names start alike keep their own cards', () => {
    for (const name of ['Porygon2', 'Porygon-Z', 'Tapu Koko']) assert.equal(FAMILIES.resolve(name).baseKey, null, name);
    assert.deepEqual(FAMILIES.resolveMatch('porygon').matches.map(entry => entry.name), ['Porygon-Z', 'Porygon2']);
    assert.equal(FAMILIES.resolve('arceus f').name, 'Arceus Fire');
});

test('autocomplete suggests only names with sets, while the default name still finds its variants', () => {
    assert.deepEqual(shown(FAMILIES, 'rayq'), ['Rayquaza Mega']);
    assert.deepEqual(FAMILIES.resolve('rayquaza').forms.map(form => form.name), ['Rayquaza Mega']);
    assert.equal(shown(FAMILIES, 'rayquaza, kyog')[0], 'Rayquaza Mega, Kyogre');
    // Several variants without a default get one choice for all of them, followed by the variants in card order:
    // "Silvally - All Types" for types, "Deoxys - All Forms" for other forms; both submit the plain name.
    assert.deepEqual(shown(FAMILIES, 'silval'), ['Silvally - All Types', 'Silvally Normal', 'Silvally Fire']);
    assert.deepEqual(shown(FAMILIES, 'absol, arce'),
        ['absol, Arceus - All Types', 'absol, Arceus Normal', 'absol, Arceus Fire', 'absol, Arceus Water']);
    assert.deepEqual(FAMILIES.suggest('silval')[0], { name: 'Silvally - All Types', value: 'Silvally' });
    assert.deepEqual(FAMILIES.suggest('deoxys'), [
        { name: 'Deoxys - All Forms', value: 'Deoxys' },
        { name: 'Deoxys Attack', value: 'Deoxys Attack' },
        { name: 'Deoxys Speed', value: 'Deoxys Speed' }
    ]);
    // The label may stay in the typed text, so it still finds every variant.
    for (const text of ['Arceus', 'Arceus - All Types', 'Deoxys - All Forms']) assert.ok(FAMILIES.resolve(text).forms.length > 1, text);
    assert.equal(FAMILIES.suggest('Arceus, arc').length, 0);
});

test('choices for all variants are not pinned above other names', () => {
    const catalog = catalogOf('Abra', 'Absol', 'Arceus Fire', 'Arceus Normal', 'Deoxys Attack', 'Deoxys Speed');
    assert.deepEqual(shown(catalog, ''), ['Abra', 'Absol', 'Arceus - All Types', 'Arceus Normal', 'Arceus Fire', 'Deoxys - All Forms',
        'Deoxys Attack', 'Deoxys Speed']);
});

test('Armored Mewtwo shows on the Mewtwo card after its own sets and stays searchable by itself', () => {
    const catalog = catalogOf('Mewtwo', { name: 'Mewtwo Mega X', sets: [mega()] }, { name: 'Mewtwo Mega Y', sets: [mega()] },
        'Mewtwo Steel (Armored Mewtwo)', 'Steelix');
    const mewtwo = catalog.resolve('mewtwo');
    assert.deepEqual(mewtwo.forms.map(form => form.name), ['Mewtwo Steel (Armored Mewtwo)', 'Mewtwo Mega X', 'Mewtwo Mega Y']);
    for (const input of ['armored mewtwo', 'armoured mewtwo', 'armord mewtwo', 'armor', 'mewtwo steel', 'steel mewtwo']) {
        assert.equal(catalog.resolve(input)?.name, 'Mewtwo Steel (Armored Mewtwo)', input);
    }
    assert.equal(catalog.resolve('mewtwo x').name, 'Mewtwo Mega X');
    assert.equal(catalog.resolve('mega mewtwo').name, 'Mewtwo');
    assert.deepEqual(catalog.resolveList('Mewtwo, Armored Mewtwo').entries.map(entry => entry.name), ['Mewtwo']);
    const [card] = containers(buildSetMessages([mewtwo], catalog.setCount)[0]);
    assert.deepEqual(layout(card).filter(line => line.startsWith('#') || line === 'wide divider'), ['## Mewtwo', 'wide divider',
        '## Mewtwo Steel (Armored Mewtwo)', 'wide divider', '## Mewtwo Mega X', 'wide divider', '## Mewtwo Mega Y']);
});

test('split or tall lookups get a Go to Top button in the footer, short ones do not', () => {
    const catalog = catalogOf(...SIX_LARGE.map(name => ({ name, sets: Array(14).fill(LONG_SET) })), 'Garchomp',
        { name: 'Mew', sets: Array(10).fill(set()) });
    const short = buildSetMessages([catalog.resolve('garchomp')], catalog.setCount);
    assert.equal(needsTopLink(short), false);
    assert.equal(needsTopLink(buildSetMessages([catalog.resolve('mew')], catalog.setCount)), true);
    assert.equal(needsTopLink(buildSetMessages(catalog.resolveList(SIX_LARGE.join(', ')).entries, catalog.setCount)), true);

    const url = 'https://discord.com/channels/guild-1/channel-1/first-message';
    const [linked] = buildSetMessages([catalog.resolve('mew')], catalog.setCount, { topUrl: url });
    // The button sits in its own row under the card, outside the footer.
    assert.deepEqual(linked.components.map(item => item.toJSON().type), [ComponentType.Container, ComponentType.ActionRow]);
    assert.deepEqual(layout(containers(linked)[0]).slice(-2), ['thin divider', footerText(catalog.setCount)]);
    const button = topButton(linked);
    assert.deepEqual([button.type, button.style, button.url, button.label, button.emoji.name],
        [ComponentType.Button, ButtonStyle.Link, url, 'Go to Top', '⬆️']);
    // The button never changes how cards are split across messages.
    const entries = catalog.resolveList(SIX_LARGE.join(', ')).entries;
    const split = buildSetMessages(entries, catalog.setCount, { topUrl: url });
    assert.deepEqual(split.map(message => containers(message).length),
        buildSetMessages(entries, catalog.setCount).map(message => containers(message).length));
    assert.deepEqual(split.map(message => Boolean(topButton(message))), [...Array(split.length - 1).fill(false), true]);
});

const ACCESS = { guildId: 'guild-1', guildMemberRoleID: 'member-role', officerRoleID: 'officer-role' };

function interaction(value, calls = [], { editError = null, roles = ['member-role'], guildId = 'guild-1' } = {}) {
    return {
        calls,
        guildId,
        inGuild: () => Boolean(guildId),
        member: { roles },
        channelId: 'channel-1',
        options: {
            getString: name => (name === 'pokemon' ? value : null),
            getFocused: () => ({ name: 'pokemon', value })
        },
        respond: async choices => { calls.push(['respond', choices]); },
        reply: async payload => {
            calls.push(['reply', payload]);
            return payload.withResponse ? { resource: { message: { id: 'first-message' } } } : undefined;
        },
        followUp: async payload => { calls.push(['followUp', payload]); },
        editReply: async payload => {
            calls.push(['editReply', payload]);
            if (editError) throw editError;
        }
    };
}

const FIRST_MESSAGE_URL = 'https://discord.com/channels/guild-1/channel-1/first-message';

test('/randompvp is for guild members and staff in the Crow Control server only', async () => {
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: SAMPLE });
    for (const options of [{ roles: [] }, { roles: ['other-role'] }, { guildId: 'other-guild' }, { guildId: null }]) {
        const lookup = interaction('absol', [], options);
        await command.execute(lookup);
        assert.equal(lookup.calls.length, 1, JSON.stringify(options));
        assert.match(lookup.calls[0][1].content, /^### ❌ {2}No permission!/u);
        assert.equal(lookup.calls[0][1].flags, MessageFlags.Ephemeral);
        const typing = interaction('abs', [], options);
        await command.handleAutocomplete(typing);
        assert.deepEqual(typing.calls, [['respond', []]]);
    }
    for (const roles of [['member-role'], ['officer-role']]) {
        const lookup = interaction('absol', [], { roles });
        await command.execute(lookup);
        assert.equal(lookup.calls[0][1].flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2, roles[0]);
    }
});

test('/randompvp has one required autocomplete option and suggests comma-separated lists', async () => {
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: SAMPLE });
    const data = command.data.toJSON();
    assert.equal(data.name, 'randompvp');
    assert.deepEqual(data.options.map(option => [option.name, option.type, option.required, option.autocomplete]),
        [['pokemon', 3, true, true]]);

    const lookup = interaction('Absol, gar');
    await command.handleAutocomplete(lookup);
    assert.deepEqual(lookup.calls, [['respond', [
        { name: 'Absol, Garchomp', value: 'Absol, Garchomp' },
        { name: 'Absol, Gardevoir', value: 'Absol, Gardevoir' }
    ]]]);
});

test('/randompvp replies privately once and continues long results in private follow-ups', async () => {
    const privateCards = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: NAMES });
    const lookup = interaction('Absol, chari, aboma');
    await command.execute(lookup);
    assert.equal(lookup.calls[0][1].content.split('\n')[0], '### ❌  Check the Pokémon names.');

    const found = interaction('chari, aboma');
    await command.execute(found);
    assert.equal(found.calls.length, 1);
    const [kind, payload] = found.calls[0];
    assert.equal(kind, 'reply');
    assert.equal(payload.flags, privateCards);
    assert.deepEqual(containers(payload).map(card => texts(card)[0].split('\n')[0]), ['## Charizard', '## Abomasnow']);
    assert.equal(texts(containers(payload).at(-1)).at(-1), footerText(NAMES.setCount));

    assert.equal(topButton(payload), undefined);

    const big = new RandomPvp({ ...ACCESS, randomPvpCatalog: catalogOf(...SIX_LARGE.map(name => ({ name, sets: Array(14).fill(LONG_SET) }))) });
    const long = interaction(SIX_LARGE.join(', '));
    await big.execute(long);
    assert.ok(long.calls.length > 1);
    assert.deepEqual(long.calls.map(([callKind, callPayload]) => [callKind, callPayload.flags]),
        [['reply', privateCards], ...long.calls.slice(1).map(() => ['followUp', privateCards])]);
    // The last follow-up links back to the first message.
    assert.equal(topButton(long.calls.at(-1)[1]).url, FIRST_MESSAGE_URL);
});

test('/randompvp adds the Go to Top button to one tall message after sending it', async t => {
    const catalog = catalogOf({ name: 'Mew', sets: Array(10).fill(set()) });
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: catalog });
    const lookup = interaction('mew');
    await command.execute(lookup);
    assert.deepEqual(lookup.calls.map(([kind]) => kind), ['reply', 'editReply']);
    assert.equal(lookup.calls[0][1].withResponse, true);
    assert.equal(topButton(lookup.calls[0][1]), undefined);
    const edit = lookup.calls[1][1];
    assert.equal(edit.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(edit.allowedMentions, { parse: [] });
    assert.equal(topButton(edit).url, FIRST_MESSAGE_URL);

    // A failed edit leaves the sets in place and only logs that the button is missing.
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    const failing = interaction('mew', [], { editError: new Error('Unknown Webhook') });
    await command.execute(failing);
    assert.deepEqual(failing.calls.map(([kind]) => kind), ['reply', 'editReply']);
    assert.deepEqual(warnings, ['[CC LOG] /randompvp could not add the Go to Top button: Unknown Webhook']);
});

test('/randompvp explains empty, oversized, unknown and unclear names without pinging anyone', async () => {
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: NAMES });
    const cases = [
        [' , ,', /No Pokémon entered/],
        ['Abomasnow, Charizard, Tyranitar, Salamence, Gengar, Rotom, Hitmontop', /Your list has 7/],
        ['chari, @everyone, xyz_', /\*\*@everyone\*\*, \*\*xyz\\_\*\* are not in the Random PvP set list/],
        ['tyran, sala', /\*\*tyran\*\* matches Tyranitar, Tyrantrum\. Type more of the name\.\n- \*\*sala\*\* matches Salamence, Salazzle\./]
    ];
    for (const [value, expected] of cases) {
        const lookup = interaction(value);
        await command.execute(lookup);
        assert.equal(lookup.calls.length, 1);
        const [kind, payload] = lookup.calls[0];
        assert.equal(kind, 'reply');
        assert.match(payload.content, expected);
        assert.equal(payload.flags, MessageFlags.Ephemeral);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
    }
});

function emojiClient(fetch) {
    return { application: { emojis: { fetch } } };
}
const emoji = (name, id) => ({ name, toString: () => `<:${name}:${id}>` });

test('emoji names follow the Pokémon names on the cards', () => {
    assert.equal(emojiName('Charizard Mega X'), 'charizard_mega_x');
    assert.equal(emojiName('Wormadam Trash Cloak (Steel)'), 'wormadam_trash_cloak_steel');
    assert.equal(emojiName('Zygarde 10% (dog)'), 'zygarde_10_dog');
    assert.equal(emojiName('Mr. Mime Galar'), 'mr_mime_galar');
    assert.equal(emojiName('Farfetch’d'), 'farfetchd');
    assert.equal(emojiName('Tauros Paldean - Blaze Breed (Fighting/Fire)'), 'tauros_paldean_blaze_breed');
    assert.equal(emojiName('Heavy-Duty Boots'), 'heavy_duty_boots');
    for (const entry of defaultCatalog().entries) assert.match(emojiName(entry.name), /^[a-z0-9_]{2,32}$/u, entry.name);
});

test('bot emojis load in the background, refresh every ten minutes and survive a failed load', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const logs = [];
    const emojis = new RandomPvpEmojis({ clock: () => now, consoleObject: { log: line => logs.push(['log', line]), warn: line => logs.push(['warn', line]) } });
    const client = emojiClient(async () => {
        calls++;
        if (fail) throw new Error('Service Unavailable');
        return new Map([['1', emoji('charizard_mega_x', '1')]]);
    });
    assert.equal(emojis.icon('Charizard Mega X'), null);
    await emojis.refresh(client);
    assert.equal(emojis.icon('Charizard Mega X'), '<:charizard_mega_x:1>');
    assert.equal(emojis.icon('Absol'), null);
    emojis.refresh(client);
    assert.equal(calls, 1);

    now = 10 * 60_000;
    fail = true;
    await emojis.refresh(client);
    now = 20 * 60_000;
    await emojis.refresh(client);
    // A failed load keeps the emojis it already had and warns once until loading works again.
    assert.equal(emojis.icon('Charizard Mega X'), '<:charizard_mega_x:1>');
    fail = false;
    now = 30 * 60_000;
    await emojis.refresh(client);
    assert.equal(calls, 4);
    assert.deepEqual(logs, [['warn', '[CC LOG] /randompvp could not load the Pokémon emojis: Service Unavailable'],
        ['log', '[CC LOG] /randompvp loaded 1 Pokémon emojis again.']]);
    assert.equal(new RandomPvpEmojis().refresh({}), null);
});

test('each card name starts with its Pokémon emoji and each item is followed by its emoji when the bot has them', async () => {
    const catalog = catalogOf('Absol', { name: 'Absol Mega', sets: [mega({ item: 'Absolite' })] }, 'Garchomp');
    const icon = name => ({ 'Absol Mega': '<:absol_mega:2>', Absolite: '<:absolite:4>' })[name] || null;
    const [message] = buildSetMessages(catalog.resolveList('absol, garchomp').entries, catalog.setCount, { icon });
    const sections = containers(message).flatMap(card => texts(card).filter(content => content.startsWith('## ')).map(content => content.split('\n')));
    assert.deepEqual(sections.map(lines => lines[0]), ['## Absol', '## <:absol_mega:2> Absol Mega', '## Garchomp']);
    assert.deepEqual(sections.map(lines => lines[1]), ['**Lv 80 · Speed 150 · Pressure · Leftovers**',
        '**Lv 80 · Speed 150 → 180 · Pressure · Absolite <:absolite:4>**', '**Lv 80 · Speed 150 · Pressure · Leftovers**']);

    const emojis = { refreshed: 0, refresh() { this.refreshed++; }, icon: name => (name === 'Garchomp' ? '<:garchomp:3>' : null) };
    const command = new RandomPvp({ ...ACCESS, randomPvpCatalog: catalog, randomPvpEmojis: emojis });
    await command.handleAutocomplete(interaction('gar'));
    const lookup = interaction('garchomp');
    await command.execute(lookup);
    assert.equal(emojis.refreshed, 2);
    assert.match(texts(containers(lookup.calls[0][1])[0])[0], /^## <:garchomp:3> Garchomp\n/u);
});

// The bot does not validate the tracked list at runtime, so these checks guard edits to randomPvpSets.json.
test('the tracked Random PvP set list is valid, every name resolves to itself and every lookup fits Discord limits', () => {
    const { pokemon } = require('../features/random-pvp/randomPvpSets.json');
    const names = pokemon.map(entry => entry.name);
    assert.equal(new Set(names.map(name => name.toLowerCase().replace(/[^a-z0-9]+/g, ''))).size, names.length);
    for (const entry of pokemon) {
        assert.ok(entry.sets.length > 0, entry.name);
        assert.ok(Object.hasOwn(CARD_COLORS, entry.color), `${entry.name}: ${entry.color}`);
        for (const item of entry.sets) {
            assert.ok(typeof item.ability === 'string' && item.ability && typeof item.item === 'string' && item.item, entry.name);
            assert.ok(Number.isInteger(item.level) && item.level >= 1 && item.level <= 100, entry.name);
            assert.ok(Number.isInteger(item.speed) && item.speed > 0, entry.name);
            assert.ok(item.megaSpeed === undefined || (Number.isInteger(item.megaSpeed) && item.megaSpeed > 0), entry.name);
            assert.ok(item.moves.length >= 1 && item.moves.length <= 4 && item.moves.every(move => move && move !== '...'), entry.name);
        }
    }
    // Items, abilities and moves use the official spelling, such as "Hidden Power Fire". Shadow Storm, Shadow Lugia's
    // move from Pokémon XD, is not in the Showdown list.
    const official = {
        items: new Set(vocabulary.items), abilities: new Set(vocabulary.abilities),
        moves: new Set([...vocabulary.moves, 'Shadow Storm'])
    };
    for (const entry of pokemon) {
        for (const item of entry.sets) {
            assert.ok(official.items.has(item.item), `${entry.name}: ${item.item}`);
            assert.ok(official.abilities.has(item.ability), `${entry.name}: ${item.ability}`);
            for (const move of item.moves) assert.ok(official.moves.has(move), `${entry.name}: ${move}`);
        }
    }
    const catalog = defaultCatalog();
    for (const entry of catalog.entries) assert.equal(catalog.resolve(entry.name), entry, entry.name);
    // Every Pokémon and item has a bot emoji. Only Arceus with all its types is long enough to need more messages.
    const icon = name => `<:${emojiName(name)}:1571743936697860127>`;
    for (const entry of catalog.entries) {
        const messages = buildSetMessages([entry], catalog.setCount, { topUrl: 'https://discord.com/channels/1/2/3', icon });
        assert.equal(messages.length > 1, entry.name === 'Arceus', entry.name);
        for (const message of messages) {
            const cards = containers(message);
            assert.ok(cards.reduce((total, card) => total + texts(card).join('').length, 0) <= 4000, entry.name);
            assert.ok(message.components.reduce((total, item) => total + 1 + (item.toJSON().components?.length || 0), 0) <= 40, entry.name);
        }
    }
});

test('a card has its Pokémon\'s color, which its variants share, while a variant looked up alone has its own', () => {
    const catalog = catalogOf(
        { name: 'Charizard', color: 'Fire', sets: [set()] }, { name: 'Charizard Mega X', color: 'Dragon', sets: [mega()] },
        { name: 'Arceus Normal', color: 'Normal', sets: [set()] }, { name: 'Arceus Fire', color: 'Fire', sets: [set()] },
        'Garchomp'
    );
    const colors = text => buildSetMessages(catalog.resolveList(text).entries, catalog.setCount)
        .flatMap(containers).map(card => card.accent_color);
    assert.deepEqual(colors('charizard'), [CARD_COLORS.Fire]);
    assert.deepEqual(colors('charizard mega x, arceus fire'), [CARD_COLORS.Dragon, CARD_COLORS.Fire]);
    // A Pokémon without sets of its own, such as Arceus, takes the color of the first variant on its card.
    assert.deepEqual(colors('arceus'), [CARD_COLORS.Normal]);
    // A Pokémon without a color keeps the Crow Control color.
    assert.deepEqual(colors('garchomp'), [0x452366]);
    const types = ['Bug', 'Dark', 'Dragon', 'Fire', 'Grass', 'Water'];
    const long = catalogOf(...types.map(type => ({ name: `Silvally ${type}`, color: type, sets: Array(6).fill(LONG_SET) })));
    const cards = buildSetMessages([long.resolve('silvally')], long.setCount).flatMap(containers);
    assert.ok(cards.length > 1);
    assert.deepEqual(new Set(cards.map(card => card.accent_color)), new Set([CARD_COLORS.Bug]));
});

test('every Pokémon has the color of its main type, or a variant the type it gains, and PRO forms their own', () => {
    const catalog = defaultCatalog();
    for (const [name, color] of [['Charizard', 'Fire'], ['Charizard Mega X', 'Dragon'], ['Charizard Mega Y', 'Fire'],
        ['Rotom Wash', 'Water'], ['Ninetales Alolan', 'Ice'], ['Aggron Mega', 'Steel'], ['Arceus', 'Normal'], ['Zoroark', 'Normal'],
        ['Tauros Paldean - Combat Breed (Fighting)', 'Fighting'], ['Tauros Paldean - Blaze Breed (Fighting/Fire)', 'Fire'],
        ['Tauros Paldean - Aqua Breed (Fighting/Water)', 'Water'], ['Steelix Crystal', 'Crystal'], ['XD001 (Shadow Lugia)', 'Shadow'],
        ['Mewtwo Steel (Armored Mewtwo)', 'Steel'], ['Baby Lugia', 'Psychic']]) {
        assert.equal(catalog.resolve(name).color, color, name);
    }
});

test('earlier PRO names and spellings still find the renamed Pokémon', () => {
    const catalog = defaultCatalog();
    for (const [input, name] of [['Enamorus Turtle', 'Enamorus Therian'], ['Dialga Original Form', 'Dialga Origin'],
        ['Wormadam Bug Steel', 'Wormadam Trash Cloak (Steel)'], ['wormadam plant', 'Wormadam Plant Cloak (Grass)'],
        ['Zygarde (dog)', 'Zygarde 10% (dog)'], ['Porygon 2', 'Porygon2'], ['Porygon Z', 'Porygon-Z'], ['Type Null', 'Type: Null'],
        ["Farfetch'd", 'Farfetch’d'], ['Farfetchd', 'Farfetch’d'], ['Farfetch', 'Farfetch’d'], ['Mr Mime Galar', 'Mr. Mime Galar'],
        ['Mister Mime', 'Mr. Mime'], ['Rotom Fridge', 'Rotom Frost'], ['Ursaluna-BM', 'Ursaluna Bloodmoon']]) {
        assert.equal(catalog.resolve(input)?.name, name, input);
    }
    assert.deepEqual(shown(catalog, 'wormadam'), ['Wormadam - All Forms', 'Wormadam Plant Cloak (Grass)', 'Wormadam Trash Cloak (Steel)']);
});

test('the Paldean Tauros breeds keep their official order and are found by breed, type and earlier names', () => {
    const catalog = defaultCatalog();
    const combat = 'Tauros Paldean - Combat Breed (Fighting)';
    const blaze = 'Tauros Paldean - Blaze Breed (Fighting/Fire)';
    const aqua = 'Tauros Paldean - Aqua Breed (Fighting/Water)';
    assert.deepEqual(catalog.resolve('tauros').forms.map(form => form.name), [combat, blaze, aqua]);
    for (const [input, name] of [['Tauros Paldea', combat], ['Paldean Tauros', combat], ['Tauros-Paldea-Combat', combat],
        ['Combat Tauros', combat], ['Tauros Fighting', combat], ['Tauros Paldea (Fight Fire)', blaze], ['Tauros Blaze', blaze],
        ['Fire Tauros', blaze], ['Paldean Tauros (Blaze Breed)', blaze], ['Tauros Paldea (Fight Water)', aqua], ['Aqua Tauros', aqua],
        ['Tauros Water', aqua], ['Tauros-Paldea-Aqua', aqua]]) {
        assert.equal(catalog.resolve(input)?.name, name, input);
    }
});

test('two-word variants are found the other way round and a trailing "Forme" is left out', () => {
    const catalog = defaultCatalog();
    for (const [input, name] of [['Wash Rotom', 'Rotom Wash'], ['Fire Arceus', 'Arceus Fire'], ['Origin Giratina', 'Giratina Origin'],
        ['Black Kyurem', 'Kyurem Black'], ['Crystal Onix', 'Onix Crystal'], ['Mega Crystal Steelix', 'Steelix Crystal Mega'],
        ['Shaymin Sky Forme', 'Shaymin Sky'], ['Deoxys Speed Form', 'Deoxys Speed'], ['Dialga Original Form', 'Dialga Origin']]) {
        assert.equal(catalog.resolve(input)?.name, name, input);
    }
});

test('parts of names, sound-alike spellings and typos inside a part find the Pokémon', () => {
    const catalog = defaultCatalog();
    for (const [input, name] of [['kazam', 'Alakazam'], ['chomp', 'Garchomp'], ['gross', 'Metagross'], ['onyx', 'Onix'],
        ['lukario', 'Lucario'], ['tiranitar', 'Tyranitar'], ['kiogre', 'Kyogre'], ['dragonight', 'Dragonite'], ['snorlacks', 'Snorlax'],
        ['exkadrill', 'Excadrill'], ['scizzor', 'Scizor'], ['kazzam', 'Alakazam'], ['ninetails', 'Ninetales']]) {
        assert.equal(catalog.resolve(input)?.name, name, input);
    }
    // Text that fits several Pokémon lists them, and text that fits none, or needs more than one typo inside a part,
    // finds nothing.
    assert.deepEqual(catalog.resolveMatch('king').matches.map(entry => entry.name), ['Kingambit', 'Kingdra', 'Kingler']);
    for (const input of ['hello', 'qwerty', 'mega kazam']) assert.equal(catalog.resolveMatch(input).entry, null, input);
    assert.deepEqual(catalog.resolveMatch('mega kazam').matches, []);
    // Autocomplete offers the same Pokémon first.
    assert.equal(catalog.suggest('kazam')[0].value, 'Alakazam');
});

test('names typed with spaces, "and" or other separators are split, longest name first', () => {
    const catalog = defaultCatalog();
    const names = text => {
        const { entries, unknown, ambiguous } = catalog.resolveList(text);
        return [...entries.map(entry => entry.name), ...unknown.map(item => `?${item}`), ...ambiguous.map(item => `~${item.text}`)];
    };
    assert.deepEqual(names('kazam dialga hooh'), ['Alakazam', 'Dialga', 'Ho-Oh']);
    assert.deepEqual(names('rotom wash garchomp'), ['Rotom Wash', 'Garchomp']);
    assert.deepEqual(names('charizard mega x tapu koko'), ['Charizard Mega X', 'Tapu Koko']);
    assert.deepEqual(names('mr mime type null'), ['Mr. Mime', 'Type: Null']);
    assert.deepEqual(names('garchomp and kazam'), ['Garchomp', 'Alakazam']);
    assert.deepEqual(names('garchomp + kazam & ttar / mence'), ['Garchomp', 'Alakazam', 'Tyranitar', 'Salamence']);
    // A slash inside a name is not a separator, and names with spaces still match as a whole.
    assert.deepEqual(names('Tauros Paldean - Blaze Breed (Fighting/Fire)'), ['Tauros Paldean - Blaze Breed (Fighting/Fire)']);
    assert.deepEqual(names('ho oh'), ['Ho-Oh']);
    // Unclear text stays one question, and words that name nothing are reported without guessing.
    assert.deepEqual(names('arceus f'), ['~arceus f']);
    assert.deepEqual(names('steel garchomp'), ['Garchomp', '~steel']);
    assert.deepEqual(names('kazam qqqq zzzz'), ['Alakazam', '?qqqq zzzz']);
    assert.deepEqual(names('qqqq zzzz'), ['?qqqq zzzz']);
});

test('autocomplete completes the last of several space-separated names and writes the list with commas', () => {
    const catalog = defaultCatalog();
    assert.equal(catalog.suggest('kazam dialga ho')[0].value, 'Alakazam, Dialga Origin, Ho-Oh');
    assert.equal(catalog.suggest('garchomp tapu ko')[0].value, 'Garchomp, Tapu Koko');
    assert.equal(catalog.suggest('kazam, dialga hooh ga')[0].value.startsWith('Alakazam, Dialga Origin, Ho-Oh, '), true);
    // Text that is one name as a whole keeps completing that name.
    assert.equal(catalog.suggest('rotom w')[0].value, 'Rotom Wash');
    assert.equal(catalog.suggest('charizard m')[0].value, 'Charizard Mega X');
});

test('a Pokémon too long for one message continues in another card that starts with its next variant', () => {
    const types = ['Bug', 'Dark', 'Dragon', 'Fire', 'Grass', 'Water'];
    const catalog = catalogOf(...types.map(type => ({ name: `Arceus ${type}`, sets: Array(6).fill(LONG_SET) })));
    const messages = buildSetMessages([catalog.resolve('arceus')], catalog.setCount);
    assert.ok(messages.length > 1);
    const cards = messages.flatMap(containers);
    assert.deepEqual(cards.flatMap(card => texts(card).filter(content => content.startsWith('## ')).map(content => content.split('\n')[0])),
        types.map(type => `## Arceus ${type}`));
    assert.deepEqual(cards.map(card => texts(card).at(-1) === footerText(catalog.setCount)),
        [...Array(cards.length - 1).fill(false), true]);
    for (const message of messages) assert.ok(containers(message).reduce((total, card) => total + texts(card).join('').length, 0) <= 4000);
});
