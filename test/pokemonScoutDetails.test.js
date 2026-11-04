// Cover Pokémon names, moves and items in written scout reports.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitScoutText } = require('../features/pvp-scouting/PokemonTeamParser.js');

test('an item parenthesis joined to the species remains in its team entry', () => {
    const parsed = splitScoutText('Dragonite(Choice Band) Extreme Speed');
    assert.match(parsed.teamText, /^- Dragonite/);
    assert.match(parsed.teamText, /Choice Band/);
    assert.match(parsed.teamText, /Extreme Speed/);
    assert.equal(parsed.notes, null);
});

test('a reporter Pokemon mentioned in a parenthetical speed comparison is not a new opponent team entry', () => {
    const parsed = splitScoutText("Weavile (Choice Band) - Knock Off , Pursuit maybe? (Didn't atack before my 258speed Hoopa)");
    assert.match(parsed.teamText, /^- Weavile/);
    assert.equal(parsed.teamText.split('\n').filter(Boolean).length, 1);
    assert.match(parsed.teamText, /Hoopa/);
    assert.doesNotMatch(parsed.teamText, /^- Hoopa/m);
});

test('a colon after the opponent heading never becomes a Pokemon detail', () => {
    const parsed = splitScoutText('Ferocityy: Zapdos fast, Lopunny, Lando, Kyurem Z, Clod, Aegislash', 'Ferocityy');
    assert.equal(parsed.teamText.split('\n').length, 6);
    assert.doesNotMatch(parsed.teamText, /Ferocityy/u);
    assert.match(parsed.teamText, /^- Zapdos/u);
    const rated = splitScoutText('90skid (300): Mega Diancie (psyshock, moonblast, earth power), Ferrothorn (iron defense, body press)', '90skid');
    assert.match(rated.teamText, /^- Mega Diancie: Psyshock, Moonblast, Earth Power/u);
    assert.doesNotMatch(rated.teamText, /90skid|300/u);
});

test('Vest resolves to Assault Vest before or after a Pokémon name', () => {
    for (const text of ['Tyranitar Vest: Flamethower', 'Tyranitar vest: Flamethrower', 'Vest Tyranitar: Flamethrower',
        'Tyranitar AV: Flamethrower', 'Tyranitar Assault Vest: Flamethrower']) {
        assert.equal(splitScoutText(text, 'Rogue005').teamText, '- Tyranitar (Item: Assault Vest): Flamethrower');
    }
    for (const text of ['Tyranitar maybe vest: Flamethrower', 'Tyranitar no vest: Flamethrower']) {
        const parsed = splitScoutText(text, 'Rogue005');
        assert.match(parsed.teamText, /(?:maybe|no) vest/u);
        assert.doesNotMatch(parsed.teamText, /Item: Assault Vest/u);
    }
});
