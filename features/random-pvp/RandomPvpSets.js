// Holds the Random PvP set list in memory and resolves the Pokémon lists used by /randompvp.
'use strict';

const { adjacentSwap, editDistanceWithin, matchSpeciesHeading } = require('../pvp-scouting/PokemonTeamParser.js');
const speciesNames = require('../pvp-scouting/PokemonSpecies.js');

const MAX_POKEMON = 6;
const MAX_CHOICES = 25;
// Discord limits each autocomplete choice name and value to 100 characters.
const MAX_CHOICE_LENGTH = 100;
const MIN_PREFIX_LENGTH = 3;
const MIN_PART_LENGTH = 4;
const MIN_TYPO_LENGTH = 5;
const MIN_TYPO_PART_LENGTH = 6;
// Names are separated by commas, semicolons, pipes, new lines, "+", "&" or a slash with spaces around it. A slash
// without spaces belongs to names such as "Tauros Paldean - Blaze Breed (Fighting/Fire)".
const LIST_SEPARATOR = /[,;|\n+&]+|\s+\/\s+/;
// The word "and" also separates names typed with spaces, as in "garchomp and kazam".
const LIST_WORD = /^and$/i;
// The most words in one set-list name or alias, which bounds how far a space-separated name can reach.
const MAX_NAME_WORDS = 6;
const MATCH_CACHE_SIZE = 1000;
// Forms a Pokémon changes into during battle. They follow its other variants on its card.
const TRANSFORM_SUFFIX = / (?:Mega(?: [XY])?|Primal|Ash)$/;
const MEGA_FORM = / Mega(?: [XY])?$/;
// Variants whose default Pokémon is not in their name. A variant shows on its parent's card and on every card
// above that, so Lugia's card has both Shadow Lugias and XD001's card has its baby.
const PARENTS = { 'XD001 (Shadow Lugia)': 'Lugia', 'Baby XD001 (Baby Shadow Lugia)': 'XD001 (Shadow Lugia)' };
// Autocomplete offers a Pokémon without sets of its own but several variants as one choice that shows them all:
// "Arceus - All Types" for type variants, "Deoxys - All Forms" for other forms. That choice submits the plain name,
// but the suffix is accepted in case it stays in the typed text.
const ALL_FORMS_SUFFIX = /\s*-\s*all\s*(?:forms|types)$/i;
// A trailing "Form" or "Forme", as in "Giratina Origin Forme", is left out.
const FORM_WORD = /\s+forme?$/i;
const TYPE_VARIANT = / (?:Bug|Dark|Dragon|Electric|Fairy|Fighting|Fire|Flying|Ghost|Grass|Ground|Ice|Normal|Poison|Psychic|Rock|Steel|Water)$/;
// More names a set-list Pokémon can be found by, including prefixes and small typos of them. Earlier PRO names
// such as "Enamorus Turtle" stay here so players can still use them.
const EXTRA_NAMES = {
    'Mewtwo Steel (Armored Mewtwo)': ['Armored Mewtwo', 'Armoured Mewtwo', 'Armor Mewtwo', 'Mewtwo Armored', 'Mewtwo Steel', 'Steel Mewtwo'],
    'XD001 (Shadow Lugia)': ['XD001', 'XD', 'Shadow Lugia', 'Lugia Shadow'],
    'Baby XD001 (Baby Shadow Lugia)': ['Baby XD001', 'Baby Shadow Lugia', 'Shadow Baby Lugia'],
    'Dialga Origin': ['Dialga Original Form'],
    'Enamorus Therian': ['Enamorus Turtle'],
    'Mr. Mime': ['Mister Mime'],
    'Mr. Mime Galar': ['Mister Mime Galar', 'Galarian Mister Mime'],
    'Rotom Fan': ['Rotom Spin'],
    'Rotom Frost': ['Rotom Fridge', 'Fridge Rotom'],
    'Rotom Heat': ['Rotom Oven', 'Oven Rotom'],
    'Rotom Mow': ['Rotom Mower', 'Rotom Lawnmower', 'Mower Rotom', 'Lawnmower Rotom', 'Rotom Cut'],
    'Rotom Wash': ['Rotom Washer', 'Washer Rotom'],
    'Ursaluna Bloodmoon': ['Ursaluna Blood Moon', 'Blood Moon Ursaluna', 'Ursaluna BM'],
    'Wormadam Plant Cloak (Grass)': ['Wormadam Plant Cloak', 'Wormadam Plant', 'Wormadam Grass', 'Plant Wormadam', 'Grass Wormadam'],
    'Wormadam Trash Cloak (Steel)': ['Wormadam Trash Cloak', 'Wormadam Trash', 'Wormadam Steel', 'Wormadam Bug Steel',
        'Trash Wormadam', 'Steel Wormadam'],
    'Zygarde 10% (dog)': ['Zygarde 10%', 'Zygarde Dog', 'Dog Zygarde']
};
// The Paldean Tauros breeds in their official order. Each is also found by its breed or added type
const PALDEAN_TAUROS = [
    { breed: 'Combat', types: 'Fighting', earlier: ['Tauros Paldea', 'Tauros Paldean', 'Paldean Tauros', 'Paldea Tauros'] },
    { breed: 'Blaze', types: 'Fighting/Fire', type: 'Fire', earlier: ['Tauros Paldea (Fight Fire)', 'Tauros Fight Fire'] },
    { breed: 'Aqua', types: 'Fighting/Water', type: 'Water', earlier: ['Tauros Paldea (Fight Water)', 'Tauros Fight Water'] }
];
const taurosName = ({ breed, types }) => `Tauros Paldean - ${breed} Breed (${types})`;
for (const tauros of PALDEAN_TAUROS) {
    const words = [tauros.breed, `${tauros.breed} Breed`, tauros.types.replace('/', ' '), ...tauros.type ? [tauros.type] : []];
    EXTRA_NAMES[taurosName(tauros)] = [...tauros.earlier, ...words.flatMap(word => [
        `Tauros ${word}`, `${word} Tauros`, `Tauros Paldea ${word}`, `Paldean Tauros ${word}`, `Paldean ${word} Tauros`
    ])];
}
// Variants listed in this order on their card instead of alphabetically.
const LISTED_ORDER = new Map(PALDEAN_TAUROS.map((tauros, index) => [taurosName(tauros), index]));
const FORM_PREFIXES = /^(.+) (Mega|Primal|Alolan|Galar|Hisui|Paldea)( [XY])?$/;
const FORM_ALIASES = { Alolan: ['Alola'], Galar: ['Galarian'], Hisui: ['Hisuian'], Paldea: ['Paldean'] };
// Showdown species names whose set-list (PRO) names differ.
const SPECIES_NAMES = {
    'Lugia-Shadow': 'XD001 (Shadow Lugia)',
    'Tauros-Paldea-Aqua': 'Tauros Paldean - Aqua Breed (Fighting/Water)',
    'Tauros-Paldea-Blaze': 'Tauros Paldean - Blaze Breed (Fighting/Fire)',
    'Tauros-Paldea-Combat': 'Tauros Paldean - Combat Breed (Fighting)',
    'Wormadam-Trash': 'Wormadam Trash Cloak (Steel)', 'Zygarde-10%': 'Zygarde 10% (dog)'
};
// Nicknames that are everyday words or common names. The shared scouting matcher leaves them out because it
// also reads player names and notes; here the text is always a Pokémon name.
const WORD_NICKNAMES = {
    ape: 'Infernape', bliss: 'Blissey', bro: 'Slowbro', celery: 'Celebi', champ: 'Machamp', chan: 'Hitmonchan',
    chandy: 'Chandelure', croak: 'Toxicroak', deo: 'Deoxys', doom: 'Houndoom', dory: 'Excadrill', dusk: 'Dusknoir',
    fable: 'Clefable', ferry: 'Ferrothorn', genny: 'Genesect', hax: 'Haxorus', hera: 'Heracross', jelly: 'Jellicent',
    jolt: 'Jolteon', kiss: 'Togekiss', kou: 'Raikou', lee: 'Hitmonlee', lix: 'Steelix', luke: 'Lucario', mag: 'Magnezone',
    maggie: 'Magneton', maggy: 'Magneton', nape: 'Infernape', obama: 'Abomasnow', ogre: 'Kyogre', rank: 'Reuniclus',
    raptor: 'Staraptor', sala: 'Salamence', shroom: 'Amoonguss', snow: 'Abomasnow', tar: 'Tyranitar',
    thorn: 'Ferrothorn', tom: 'Rotom', tomb: 'Spiritomb', top: 'Hitmontop', tops: 'Kabutops', tusk: 'Great Tusk',
    wak: 'Marowak', wob: 'Wobbuffet', wrath: 'Poliwrath', zam: 'Alakazam', zek: 'Zekrom', zone: 'Magnezone'
};

function normalizeKey(text) {
    return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const speciesKeys = new Set(speciesNames.map(normalizeKey));

// Spellings that sound alike share a key, so "Onyx", "Lukario", "Snorlacks" and "Dragonight" find Onix, Lucario,
// Snorlax and Dragonite. A silent final "e" is left out.
function soundKey(key) {
    return key.replace(/ph/g, 'f').replace(/igh/g, 'i').replace(/ck|c|q/g, 'k').replace(/x/g, 'ks').replace(/y/g, 'i')
        .replace(/z/g, 's').replace(/(.)\1+/g, '$1').replace(/([^aeiou])e$/, '$1');
}

// The fewest edits that turn term into some part of text, such as 1 for "kazzam" in "alakazam", or limit + 1 once
// more than limit edits are certain.
function partDistance(term, text, limit) {
    if (term.length - text.length > limit) return limit + 1;
    let previous = new Array(text.length + 1).fill(0);
    for (let row = 1; row <= term.length; row++) {
        const current = [row];
        let rowBest = row;
        for (let column = 1; column <= text.length; column++) {
            current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
                previous[column - 1] + (term[row - 1] === text[column - 1] ? 0 : 1));
            rowBest = Math.min(rowBest, current[column]);
        }
        if (rowBest > limit) return limit + 1;
        previous = current;
    }
    return Math.min(...previous);
}

// Accepts names such as "Mega Absol" and "Alolan Ninetales" for "Absol Mega" and "Ninetales Alolan", and other
// two-word names the other way round, such as "Wash Rotom", "Fire Arceus" and "Crystal Onix".
function nameAliases(name) {
    const match = FORM_PREFIXES.exec(name);
    if (!match) {
        const words = /^([A-Za-z]+) ([A-Za-z]+)$/.exec(name);
        return words ? [`${words[2]} ${words[1]}`] : [];
    }
    const [, base, form, variant = ''] = match;
    const aliases = [`${form} ${base}${variant}`];
    for (const alias of FORM_ALIASES[form] || []) aliases.push(`${alias} ${base}${variant}`, `${base} ${alias}${variant}`);
    return aliases;
}

class RandomPvpCatalog {
    constructor(data) {
        this.entries = [];
        this.byKey = new Map();
        this.setCount = 0;
        for (const { name, sets, color } of data.pokemon) {
            this.addEntry(name, sets, color);
            this.setCount += sets.length;
        }

        // Every variant joins its default Pokémon's card. A default Pokémon without sets, such as Rayquaza or
        // Arceus, gets an entry without sets so its name still finds the variants.
        for (const entry of [...this.entries]) {
            const parentName = PARENTS[entry.name] || this.baseNameOf(entry.name);
            if (parentName) entry.parentKey = (this.byKey.get(normalizeKey(parentName)) || this.addEntry(parentName, [])).key;
        }
        // baseKey ends as the topmost Pokémon, whose card shows the whole family.
        for (const entry of this.entries) {
            for (let parent = this.byKey.get(entry.parentKey); parent; parent = this.byKey.get(parent.parentKey)) {
                parent.forms.push(entry);
                entry.baseKey = parent.key;
            }
        }
        // A default Pokémon without sets takes the card color of the first variant on its card, such as Normal for
        // Arceus and Hisuian Zoroark's Normal for Zoroark.
        for (const entry of this.entries) {
            entry.forms.sort((a, b) => this.formOrder(entry, a) - this.formOrder(entry, b) || a.name.localeCompare(b.name, 'en'));
            if (!entry.color && entry.forms.length) entry.color = entry.forms[0].color;
        }

        this.entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        this.aliasIndex = new Map();
        for (const entry of this.entries) {
            for (const searchKey of entry.searchKeys.slice(1)) {
                if (!this.byKey.has(searchKey) && !this.aliasIndex.has(searchKey)) this.aliasIndex.set(searchKey, entry);
            }
        }
        this.matchCache = new Map();
        this.nicknames = new Map();
        for (const [nickname, name] of Object.entries(WORD_NICKNAMES)) {
            const target = this.byKey.get(normalizeKey(name));
            if (target) this.nicknames.set(nickname, target);
        }
    }

    addEntry(name, sets, color = null) {
        const key = normalizeKey(name);
        const entry = {
            name, key, sets, color, forms: [], baseKey: null, parentKey: null,
            searchKeys: [key, ...[...nameAliases(name), ...EXTRA_NAMES[name] || []].map(normalizeKey)],
            wordKeys: name.split(/\s+/).map(normalizeKey).filter(Boolean)
        };
        entry.soundKeys = entry.searchKeys.map(soundKey);
        this.entries.push(entry);
        this.byKey.set(key, entry);
        return entry;
    }

    // The default Pokémon is the shortest other set-list name the variant starts with ("Steelix" for
    // "Steelix Crystal Mega"); otherwise its first word when that is a Pokémon ("Arceus" for "Arceus Fire").
    // "Baby Lugia" belongs to Lugia.
    baseNameOf(name) {
        const baby = /^Baby (.+)$/.exec(name);
        if (baby) return this.byKey.has(normalizeKey(baby[1])) ? baby[1] : null;
        const words = name.split(' ');
        for (let count = 1; count < words.length; count++) {
            const prefix = words.slice(0, count).join(' ');
            if (this.byKey.has(normalizeKey(prefix))) return prefix;
        }
        return words.length > 1 && speciesKeys.has(normalizeKey(words[0])) ? words[0] : null;
    }

    // A card lists the default sets, then the Normal type of Arceus or Silvally, other variants, baby variants,
    // the default Pokémon's own transformed forms and finally the transformed forms of its variants, each group
    // alphabetically.
    formOrder(base, form) {
        if (form.name === `${base.name} Normal`) return 0;
        if (LISTED_ORDER.has(form.name)) return 1 + LISTED_ORDER.get(form.name) / 10;
        if (!TRANSFORM_SUFFIX.test(form.name)) return form.name.startsWith('Baby ') ? 1.5 : 1;
        return form.name.replace(TRANSFORM_SUFFIX, '') === base.name ? 2 : 3;
    }

    root(entry) {
        return entry.baseKey ? this.byKey.get(entry.baseKey) : entry;
    }

    // One candidate is used as is, and a candidate whose card already shows all the others, such as Charizard
    // with its Megas or XD001 with its baby, is used for its whole card. Other matches are listed: the variants
    // when they all belong to one Pokémon, otherwise one name per Pokémon.
    single(candidates) {
        if (candidates.length === 1) return { entry: candidates[0], matches: [] };
        const covering = candidates.find(entry => candidates.every(other => other === entry || entry.forms.includes(other)));
        if (covering) return { entry: covering, matches: [] };
        const roots = [...new Set(candidates.map(entry => this.root(entry)))];
        if (roots.length === 1) return { entry: null, matches: candidates };
        return {
            entry: null,
            matches: roots.map(root => {
                const own = candidates.filter(entry => this.root(entry) === root);
                return own.length === 1 ? own[0] : root;
            })
        };
    }

    entryForSpecies(species) {
        if (SPECIES_NAMES[species]) return this.byKey.get(normalizeKey(SPECIES_NAMES[species])) || null;
        // Forms missing from the set list fall back to their base Pokémon, for example Landorus-Therian.
        for (let name = species; name; name = name.includes('-') ? name.slice(0, name.lastIndexOf('-')) : '') {
            const key = normalizeKey(name);
            const entry = this.byKey.get(key) || this.aliasIndex.get(key);
            if (entry) return entry;
        }
        return null;
    }

    // Uses the scouting name matcher for Showdown and guild nicknames, Mega and regional names and long typos.
    speciesMatch(text) {
        const match = matchSpeciesHeading(text, { allowBroadAlias: true, allowTypo: true });
        if (!match?.species || normalizeKey(text.slice(match.end))) return null;
        return this.entryForSpecies(match.species);
    }

    // "mega zard", "zard mega", "m zard x" and "megazardy" name a Mega form of a Pokémon given by any accepted name.
    megaMatch(text) {
        const words = text.toLowerCase().split(/[\s-]+/).filter(Boolean);
        const megaIndex = words.findIndex((word, index) => word === 'mega' || index === 0 && word === 'm');
        let rest;
        if (megaIndex >= 0 && words.length > 1) rest = words.filter((_, index) => index !== megaIndex);
        else {
            const glued = /^mega(.{3,})$|^(.{3,})mega$/.exec(normalizeKey(text));
            if (!glued) return null;
            rest = [glued[1] || glued[2]];
        }
        const variant = rest.length > 1 && /^[xy]$/.test(rest.at(-1)) ? rest.pop().toUpperCase() : null;
        const base = this.resolveMatch(rest.join(' ')).entry;
        if (!base) return null;
        if (MEGA_FORM.test(base.name)) return base;
        // "mega steelix" is Steelix Mega, not Steelix Crystal Mega from the same card.
        const megas = ['', ' X', ' Y'].map(suffix => this.byKey.get(normalizeKey(`${base.name} Mega${suffix}`)))
            .filter(form => form && (!variant || form.name.endsWith(` ${variant}`)));
        if (megas.length === 1) return megas[0];
        return megas.length ? this.root(base) : null;
    }

    // The Pokémon nearest to key within limit edits, compared as typed and as it sounds. Sounding alike counts as
    // one edit, so a sound-alike spelling allows one typo less.
    closeMatches(key, limit) {
        const sound = soundKey(key);
        const bySound = sound.length >= MIN_TYPO_LENGTH;
        return this.nearest(entry => Math.min(
            ...entry.searchKeys.map(searchKey => (adjacentSwap(key, searchKey) ? 1 : editDistanceWithin(key, searchKey, limit))),
            ...bySound ? entry.soundKeys.map(searchKey => 1 + editDistanceWithin(sound, searchKey, limit - 1)) : []
        ), limit);
    }

    // The Pokémon with a part of the name nearest to key, within limit edits, such as Alakazam for "kazzam".
    closePartMatches(key, limit) {
        return this.nearest(entry => Math.min(...entry.searchKeys.map(searchKey => partDistance(key, searchKey, limit))), limit);
    }

    nearest(distanceOf, limit) {
        let best = Infinity;
        let candidates = [];
        for (const entry of this.entries) {
            const distance = distanceOf(entry);
            if (distance > limit || distance > best) continue;
            if (distance < best) candidates = [];
            best = distance;
            candidates.push(entry);
        }
        return candidates;
    }

    // A nickname that also starts another Pokémon's name, such as "sala" for Salamence and Salazzle, lists them all.
    nicknameMatch(key, entry) {
        const root = this.root(entry);
        const others = [...new Set(this.entries.filter(other => other.key.startsWith(key)).map(other => this.root(other)))]
            .filter(other => other !== root);
        return others.length ? { entry: null, matches: [entry, ...others] } : { entry, matches: [] };
    }

    // Returns { entry } for a single Pokémon, or the competing Pokémon in matches when the text fits several.
    // Recent results are kept, because autocomplete and space-separated lists ask about the same text again.
    resolveMatch(text) {
        const input = String(text ?? '').trim();
        const cached = this.matchCache.get(input);
        if (cached) return cached;
        const match = this.findMatch(input);
        if (this.matchCache.size >= MATCH_CACHE_SIZE) this.matchCache.delete(this.matchCache.keys().next().value);
        this.matchCache.set(input, match);
        return match;
    }

    findMatch(text) {
        const input = text.replace(ALL_FORMS_SUFFIX, '').replace(FORM_WORD, '');
        const key = normalizeKey(input);
        if (!key) return { entry: null, matches: [] };
        const named = this.byKey.get(key) || this.aliasIndex.get(key);
        if (named) return { entry: named, matches: [] };
        // Mega words go first so "mega mewtwo" shows both Mega forms instead of one the scouting matcher picks.
        const nickname = this.nicknames.get(key) || this.megaMatch(input) || this.speciesMatch(input);
        if (nickname) return this.nicknameMatch(key, nickname);
        if (key.length >= MIN_PREFIX_LENGTH) {
            const prefixed = this.entries.filter(entry => entry.searchKeys.some(searchKey => searchKey.startsWith(key)));
            if (prefixed.length) return this.single(prefixed);
            // A later word of the name, such as "wash" for Rotom Wash.
            const worded = this.entries.filter(entry => entry.wordKeys.slice(1).some(word => word.startsWith(key)));
            if (worded.length) return this.single(worded);
        }
        const sound = soundKey(key);
        if (key.length >= MIN_PART_LENGTH) {
            // Any part of the name, such as "kazam" for Alakazam or "chomp" for Garchomp.
            const parted = this.entries.filter(entry => entry.searchKeys.some(searchKey => searchKey.includes(key)));
            if (parted.length) return this.single(parted);
        }
        // A spelling that sounds the same, such as "onyx" for Onix, or part of one. Repeated letters shrink when
        // compared by sound, so text such as "qqqzzz" that sounds like too few letters is not compared this way.
        if (sound.length >= MIN_PREFIX_LENGTH) {
            const alike = this.entries.filter(entry => entry.soundKeys.includes(sound));
            if (alike.length) return this.single(alike);
        }
        if (sound.length >= MIN_PART_LENGTH) {
            const alikePart = this.entries.filter(entry => entry.soundKeys.some(searchKey => searchKey.includes(sound)));
            if (alikePart.length) return this.single(alikePart);
        }
        if (key.length < MIN_TYPO_LENGTH) return { entry: null, matches: [] };
        const close = this.closeMatches(key, key.length >= 8 ? 2 : 1);
        if (close.length) return this.single(close);
        // One typo inside part of a name, such as "kazzam" for Alakazam. More would match unrelated names.
        if (key.length < MIN_TYPO_PART_LENGTH) return { entry: null, matches: [] };
        const closePart = this.closePartMatches(key, 1);
        return closePart.length ? this.single(closePart) : { entry: null, matches: [] };
    }

    resolve(text) {
        return this.resolveMatch(text).entry;
    }

    // Returns { entry, label } items; label is the name shown in the suggestion list.
    search(query, exclude, limit) {
        const term = normalizeKey(query);
        const ranked = new Map();
        // Equally good matches are alphabetical, except that the variants of a Pokémon without sets of its own
        // stay together in card order, after the choice that shows all of them.
        const put = (shown, label, rank) => {
            if (exclude.has(shown.key)) return;
            const owner = shown.baseKey && !this.root(shown).sets.length ? this.root(shown) : null;
            const item = {
                entry: shown, label, rank, group: owner ? owner.name : shown.name,
                position: owner ? 1 + owner.forms.indexOf(shown) : 0
            };
            const id = label === shown.name ? shown.key : `all:${shown.key}`;
            if (!ranked.has(id) || ranked.get(id).rank > rank) ranked.set(id, item);
        };
        // A Pokémon without sets of its own, such as Rayquaza, is suggested through its variants, and through one
        // choice for all of them when it has several.
        const add = (entry, rank) => {
            if (entry.sets.length) return put(entry, entry.name, rank);
            if (entry.forms.length > 1) {
                put(entry, `${entry.name} - ${entry.forms.every(form => TYPE_VARIANT.test(form.name)) ? 'All Types' : 'All Forms'}`, rank);
            }
            for (const form of entry.forms) put(form, form.name, rank);
        };
        if (term) {
            // The Pokémon the text resolves to comes first, followed by its variants in card order.
            const { entry, matches } = this.resolveMatch(query);
            (entry ? [entry, ...entry.forms] : matches).forEach((match, index) => add(match, index ? -1 + index / 1000 : -2));
        }
        for (const entry of this.entries) {
            const rank = term ? matchRank(entry, term) : 0;
            if (rank !== null) add(entry, rank);
        }
        if (ranked.size < limit && term.length >= MIN_TYPO_LENGTH - 1) {
            for (const entry of this.closeMatches(term, 2)) add(entry, 5);
        }
        return [...ranked.values()].sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group, 'en')
            || a.position - b.position || a.label.localeCompare(b.label, 'en')).slice(0, limit);
    }

    // Splits text typed without separators, such as "kazam dialga hooh", into names. At each word the longest run
    // of words that names one Pokémon is taken, so "rotom wash garchomp" is Rotom Wash and Garchomp. A word that
    // starts no name is reported alone, or together with the unknown words before it. Returns null when no run of
    // words names a Pokémon.
    splitWords(text) {
        const words = text.split(/\s+/).filter(word => word && !LIST_WORD.test(word));
        const parts = [];
        for (let start = 0; start < words.length;) {
            let end = Math.min(words.length, start + MAX_NAME_WORDS);
            for (; end > start + 1 && !this.resolveMatch(words.slice(start, end).join(' ')).entry; end--);
            const part = { text: words.slice(start, end).join(' '), ...this.resolveMatch(words.slice(start, end).join(' ')) };
            const last = parts.at(-1);
            if (!part.entry && !part.matches.length && last && !last.entry && !last.matches.length) last.text += ` ${part.text}`;
            else parts.push(part);
            start = end;
        }
        return parts.some(part => part.entry) ? parts : null;
    }

    // The names in a list as { text, entry, matches }. A part between separators that names no Pokémon as a whole
    // is split at its spaces.
    listParts(text) {
        return String(text ?? '').split(LIST_SEPARATOR).map(part => part.trim()).filter(Boolean).flatMap(part => {
            const whole = { text: part, ...this.resolveMatch(part) };
            if (whole.entry || whole.matches.length || !/\s/.test(part)) return [whole];
            return this.splitWords(part) || [whole];
        });
    }

    // For autocomplete: when the name being typed is not one name as a whole, as in "kazam dialga ho", returns the
    // complete names before it and the shortest ending that some Pokémon starts with, which is still being typed.
    leadingNames(text) {
        const words = text.split(/\s+/).filter(Boolean);
        const whole = this.resolveMatch(text);
        if (words.length < 2 || whole.entry || whole.matches.length) return null;
        if (LIST_WORD.test(words.at(-1))) {
            const parts = this.splitWords(words.slice(0, -1).join(' '));
            return parts?.every(part => part.entry) ? { parts, rest: '' } : null;
        }
        for (let tail = 1; tail < words.length && tail <= MAX_NAME_WORDS; tail++) {
            const rest = words.slice(-tail).join(' ');
            const parts = this.splitWords(words.slice(0, -tail).join(' '));
            if (parts?.every(part => part.entry) && this.search(rest, new Set(), 1).length) return { parts, rest };
        }
        return null;
    }

    // Resolves submitted text. A Pokémon selected together with another whose card already shows it is shown once,
    // inside that card.
    resolveList(text) {
        const entries = [];
        const unknown = [];
        const ambiguous = [];
        const seen = new Set();
        for (const { text: part, entry, matches } of this.listParts(text)) {
            if (entry) {
                if (!seen.has(entry.key)) {
                    seen.add(entry.key);
                    entries.push(entry);
                }
            } else if (matches.length) {
                if (!ambiguous.some(item => item.text === part)) ambiguous.push({ text: part, names: matches.map(match => match.name) });
            } else if (!unknown.includes(part)) unknown.push(part);
        }
        const shown = entries.filter(entry => !entries.some(other => other !== entry && other.forms.includes(entry)));
        return { entries: shown, unknown, ambiguous, count: shown.length + unknown.length + ambiguous.length };
    }

    // Suggests { name, value } choices that complete the name after the last separator and write earlier names in
    // full. The value is what gets submitted; only an "All Types" or "All Forms" choice shows a different name.
    suggest(text) {
        const parts = String(text ?? '').split(LIST_SEPARATOR);
        let current = parts.pop().trim();
        const named = parts.flatMap(part => this.listParts(part));
        const leading = this.leadingNames(current);
        if (leading) {
            named.push(...leading.parts);
            current = leading.rest;
        }
        const previous = [];
        const exclude = new Set();
        for (const { text: part, entry } of named) {
            if (!entry) {
                previous.push(part);
                continue;
            }
            if (exclude.has(entry.key)) continue;
            previous.push(!entry.sets.length && entry.forms.length === 1 ? entry.forms[0].name : entry.name);
            exclude.add(entry.key);
            for (const form of entry.forms) exclude.add(form.key);
        }

        if (previous.length >= MAX_POKEMON) {
            const list = joinChoice(previous.slice(0, MAX_POKEMON));
            return list ? [{ name: list, value: list }] : [];
        }
        const choices = [];
        for (const { entry, label } of this.search(current, exclude, MAX_CHOICES * 2)) {
            const value = joinChoice([...previous, entry.name]);
            const name = joinChoice([...previous, label]);
            if (value && name && !choices.some(choice => choice.value === value)) choices.push({ name, value });
            if (choices.length === MAX_CHOICES) break;
        }
        return choices;
    }
}

function matchRank(entry, term) {
    if (entry.searchKeys.includes(term)) return 0;
    if (entry.key.startsWith(term)) return 1;
    if (entry.searchKeys.some(key => key.startsWith(term))) return 2;
    if (entry.wordKeys.some(key => key.startsWith(term))) return 3;
    // Aliases join words in another order, so a substring match on them would find unrelated names.
    if (entry.key.includes(term)) return 4;
    return null;
}

function joinChoice(names) {
    const spaced = names.join(', ');
    if (spaced.length <= MAX_CHOICE_LENGTH) return spaced;
    const compact = names.join(',');
    return compact.length <= MAX_CHOICE_LENGTH ? compact : null;
}

let defaultCatalogInstance = null;

function defaultCatalog() {
    if (!defaultCatalogInstance) defaultCatalogInstance = new RandomPvpCatalog(require('./randomPvpSets.json'));
    return defaultCatalogInstance;
}

module.exports = {
    MAX_POKEMON,
    RandomPvpCatalog,
    defaultCatalog
};
