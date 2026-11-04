// Finds Pokémon team entries in scouting notes while leaving the original message intact.
'use strict';

const speciesNames = require('./PokemonSpecies.js');
const vocabulary = require('./PokemonVocabulary.js');

function nameKey(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/♀/g, 'f').replace(/♂/g, 'm')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

const knownSpecies = new Set(speciesNames);
const namesByKey = new Map();
const fuzzyNamesByLength = new Map();

function addName(phrase, species) {
    const key = nameKey(phrase);
    if (!key || !knownSpecies.has(species)) return;
    if (!namesByKey.has(key)) namesByKey.set(key, new Set());
    namesByKey.get(key).add(species);
}

for (const species of speciesNames) {
    addName(species, species);
    addName(species.replace(/-/g, ' '), species);
    const speciesKey = nameKey(species);
    if (!fuzzyNamesByLength.has(speciesKey.length)) fuzzyNamesByLength.set(speciesKey.length, []);
    fuzzyNamesByLength.get(speciesKey.length).push({ key: speciesKey, species });
    const mega = species.match(/^(.+)-Mega(?:-(X|Y))?$/u);
    if (mega) {
        const suffix = mega[2] ? ` ${mega[2]}` : '';
        addName(`Mega ${mega[1]}${suffix}`, species);
        addName(`${mega[1]} Mega${suffix}`, species);
        addName(`M ${mega[1]}${suffix}`, species);
        if (mega[2]) addName(`${mega[1]} ${mega[2]}`, species);
    }
    const regional = species.match(/^(.+)-(Alola|Galar|Hisui|Paldea)$/u);
    if (regional) {
        const adjective = { Alola: 'Alolan', Galar: 'Galarian', Hisui: 'Hisuian', Paldea: 'Paldean' }[regional[2]];
        addName(`${regional[2]} ${regional[1]}`, species);
        addName(`${adjective} ${regional[1]}`, species);
        addName(`${regional[1]} ${adjective}`, species);
        addName(`${regional[1]} ${regional[2]}`, species);
    }
    const therian = species.match(/^(.+)-(Therian|Incarnate)$/u);
    if (therian) addName(`${therian[1]} ${therian[2][0]}`, species);
    const kyurem = species.match(/^Kyurem-(Black|White)$/u);
    if (kyurem) addName(`Kyurem ${kyurem[1][0]}`, species);
}

// Many Showdown aliases are also ordinary words ("hands", "moon", "ray").
// Use these only in a strong team slot, not while scanning arbitrary prose.
const broadSpeciesAliases = new Map();
for (const [alias, target] of Object.entries(vocabulary.aliases)) {
    const key = nameKey(alias);
    if (key.length < 3 || !knownSpecies.has(target)) continue;
    if (broadSpeciesAliases.has(key) && broadSpeciesAliases.get(key) !== target) {
        broadSpeciesAliases.set(key, null);
    } else if (!broadSpeciesAliases.has(key)) {
        broadSpeciesAliases.set(key, target);
    }
}
broadSpeciesAliases.set('land', 'Landorus');
// Common player abbreviations missing from Showdown's alias table. These stay
// contextual: a bare word in chat is not enough to establish a team member.
for (const [alias, species] of Object.entries({
    zap: 'Zapdos', zappy: 'Zapdos', tork: 'Torkoal', thund: 'Thundurus',
    thundy: 'Thundurus', loom: 'Breloom', tina: 'Giratina', hoop: 'Hoopa',
    garch: 'Garchomp', lax: 'Snorlax', slowb: 'Slowbro', slowk: 'Slowking',
    muka: 'Muk-Alola', metag: 'Metagross', glis: 'Gliscor',
    peli: 'Pelipper', clod: 'Clodsire', hatt: 'Hatterene', meta: 'Metagross',
    gambit: 'Kingambit', dondo: 'Dondozo', latia: 'Latias', latio: 'Latios'
})) {
    if (knownSpecies.has(species)) broadSpeciesAliases.set(alias, species);
}

// Guild shorthand is small. Add an alias only when its meaning is clear here.
for (const [alias, species] of Object.entries({
    xd001: 'Lugia-Shadow',
    shadowlugia: 'Lugia-Shadow',
    lugiaxd001: 'Lugia-Shadow',
    char: 'Charizard',
    chari: 'Charizard',
    zard: 'Charizard',
    charx: 'Charizard-Mega-X',
    charix: 'Charizard-Mega-X',
    zardx: 'Charizard-Mega-X',
    chary: 'Charizard',
    chariy: 'Charizard-Mega-Y',
    zardy: 'Charizard-Mega-Y',
    ttar: 'Tyranitar',
    chomp: 'Garchomp',
    pult: 'Dragapult',
    ferro: 'Ferrothorn',
    tran: 'Heatran',
    lando: 'Landorus',
    corvi: 'Corviknight',
    exca: 'Excadrill',
    gyara: 'Gyarados',
    serp: 'Serperior',
    volc: 'Volcarona',
    aegi: 'Aegislash',
    aegish: 'Aegislash',
    megalop: 'Lopunny-Mega',
    azu: 'Azumarill',
    aero: 'Aerodactyl',
    cloy: 'Cloyster',
    blacepha: 'Blacephalon',
    megabunny: 'Lopunny-Mega',
    clef: 'Clefable',
    pex: 'Toxapex',
    landot: 'Landorus-Therian',
    torna: 'Tornadus',
    tornt: 'Tornadus-Therian',
    kommo: 'Kommo-o',
    conke: 'Conkeldurr',
    conk: 'Conkeldurr',
    alomola: 'Alomomola',
    alomuk: 'Muk-Alola',
    diance: 'Diancie',
    shukle: 'Shuckle',
    sammorut: 'Samurott'
})) addName(alias, species);
addName('Hoopa Unbond', 'Hoopa-Unbound');

function editDistanceWithin(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row++) {
        const current = [row];
        let rowBest = current[0];
        for (let column = 1; column <= b.length; column++) {
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
            );
            rowBest = Math.min(rowBest, current[column]);
        }
        if (rowBest > limit) return limit + 1;
        previous = current;
    }
    return previous[b.length];
}

function adjacentSwap(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        if (a[index] === b[index]) continue;
        return a[index] === b[index + 1] && a[index + 1] === b[index]
            && a.slice(index + 2) === b.slice(index + 2);
    }
    return false;
}

function matchSpeciesHeading(value, { allowTypo = false, preview = false, allowBroadAlias = false } = {}) {
    const input = String(value || '').trim();
    // Parentheses begin item/move details even when the author omits a space:
    // "Dragonite(Choice Band)" is a Dragonite heading followed by its item.
    const headingInput = input.split(/[([\]]/u, 1)[0];
    const words = [...headingInput.matchAll(/\S+/gu)].slice(0, 5);
    let exact = null;
    for (let count = 1; count <= words.length; count++) {
        const word = words[count - 1][0].replace(/[:;–-]+$/u, '');
        if (!nameKey(word)) break;
        const end = words[count - 1].index + word.length;
        const key = nameKey(input.slice(0, end));
        const names = namesByKey.get(key);
        if (names) exact = { species: names.size === 1 ? [...names][0] : null, end, ambiguous: names.size > 1, kind: 'exact' };
        else if (allowBroadAlias && broadSpeciesAliases.get(key)) {
            exact = { species: broadSpeciesAliases.get(key), end, kind: 'alias' };
        }
    }
    if (exact?.species) return exact;
    if (nameKey(words[0]?.[0]) === 'mega' && words[1]) {
        const rest = input.slice(words[1].index);
        const base = matchSpeciesHeading(rest, { preview, allowBroadAlias: true });
        const megaSpecies = base?.species && `${base.species}-Mega`;
        const end = base && words[1].index + base.end;
        const suffix = base && input.slice(end).match(/^\s+([XY])(?=$|\W)/iu);
        const form = suffix && `${megaSpecies}-${suffix[1].toUpperCase()}`;
        // Charizard has X/Y forms but no generic Mega species in the dictionary.
        if (form && knownSpecies.has(form)) {
            return { species: form, end: end + suffix[0].length, kind: 'exact' };
        }
        if (knownSpecies.has(megaSpecies)) {
            return { species: megaSpecies, end, kind: 'exact' };
        }
    }
    if (exact) return exact;
    const joinedDetail = words[0]?.[0].match(/^([\p{L}\p{N}_.]{3,25})-(?=[\p{L}])/u);
    if (joinedDetail) {
        // "Hydreigon-choice scarf" names the Pokémon before the item detail.
        // Complete form names such as "Landorus-Therian" matched above.
        const prefix = matchSpeciesHeading(joinedDetail[1], { allowTypo, preview });
        if (prefix?.species && prefix.end === joinedDetail[1].length) return prefix;
    }
    const zModifier = words[0]?.[0].match(/^(.+)-z$/iu);
    if (zModifier) {
        const names = namesByKey.get(nameKey(zModifier[1]));
        if (names?.size === 1) return { species: [...names][0], end: zModifier[1].length, kind: 'exact' };
    }
    if (!allowTypo) return null;

    let best = null;
    let tied = false;
    for (let count = 1; count <= Math.min(3, words.length); count++) {
        const word = words[count - 1][0].replace(/[:;–-]+$/u, '');
        if (!nameKey(word)) break;
        const end = words[count - 1].index + word.length;
        const key = nameKey(input.slice(0, end));
        if (key.length < (preview ? 5 : 7)) continue;
        // Preview rows already identify a roster, so short OCR slips are safer to repair there.
        const limit = key.length >= (preview ? 7 : 9) ? 2 : 1;
        for (let length = key.length - limit; length <= key.length + limit; length++) {
            for (const entry of fuzzyNamesByLength.get(length) || []) {
                if (/[,;:!?]/u.test(input.slice(0, end))) continue;
                const distance = adjacentSwap(key, entry.key) ? 1 : editDistanceWithin(key, entry.key, limit);
                if (distance > limit) continue;
                if (!best || distance < best.distance) {
                    best = { species: entry.species, end, distance, kind: 'typo' };
                    tied = false;
                } else if (distance === best.distance && entry.species !== best.species) {
                    tied = true;
                }
            }
        }
    }
    return best && !tied ? best : null;
}

function displaySpecies(species) {
    if (species === 'Lugia-Shadow') return 'XD001';
    const mega = species.match(/^(.+)-Mega(?:-(X|Y))?$/u);
    return mega ? `Mega ${mega[1]}${mega[2] ? ` ${mega[2]}` : ''}` : species;
}

const termsByKey = new Map();
const termNames = new Map();
const fuzzyTermsByLength = new Map();
for (const [kind, names] of Object.entries({ move: vocabulary.moves, item: vocabulary.items,
    ability: vocabulary.abilities, nature: vocabulary.natures })) {
    termNames.set(kind, new Set(names));
    for (const name of names) {
        const key = nameKey(name);
        if (!termsByKey.has(key)) termsByKey.set(key, []);
        termsByKey.get(key).push({ kind, name });
        if (key.length >= 7) {
            if (!fuzzyTermsByLength.has(key.length)) fuzzyTermsByLength.set(key.length, []);
            fuzzyTermsByLength.get(key.length).push({ key, kind, name });
        }
    }
}
const safeShortTermAliases = new Set(['av', 'cb', 'cc', 'cm', 'dd', 'eq', 'lo', 'np', 'qd',
    'sd', 'se', 'sr', 'tr', 'tw', 'wp']);
const ambiguousTermAliases = new Set(['imp', 'bb', 'bp', 'cs', 'fc']);
for (const [alias, target] of Object.entries(vocabulary.aliases)) {
    if (ambiguousTermAliases.has(alias) || alias.length < 3 && !safeShortTermAliases.has(alias)) continue;
    for (const [kind, names] of termNames) {
        if (!names.has(target)) continue;
        if (!termsByKey.has(nameKey(alias))) termsByKey.set(nameKey(alias), []);
        termsByKey.get(nameKey(alias)).push({ kind, name: target });
    }
}
for (const [alias, name] of Object.entries({ rockhelmet: 'Rocky Helmet', rockyhelm: 'Rocky Helmet', scarfed: 'Choice Scarf', vest: 'Assault Vest',
    rocks: 'Stealth Rock', banded: 'Choice Band', sitrus: 'Sitrus Berry',
    adam: 'Adamant', mod: 'Modest', tim: 'Timid', joll: 'Jolly', care: 'Careful' })) {
    if (!termsByKey.has(alias)) termsByKey.set(alias, []);
    termsByKey.get(alias).push({ kind: termNames.get('nature').has(name) ? 'nature'
        : termNames.get('item').has(name) ? 'item' : 'move', name });
}

const closeTermCache = new Map();
const CLOSE_TERM_CACHE_SIZE = 4096;

function closeUniqueTerm(key) {
    if (key.length < 7) return null;
    if (closeTermCache.has(key)) {
        const cached = closeTermCache.get(key);
        closeTermCache.delete(key);
        closeTermCache.set(key, cached);
        return cached;
    }
    const matches = [];
    for (let length = key.length - 1; length <= key.length + 1; length++) {
        for (const term of fuzzyTermsByLength.get(length) || []) {
            if (adjacentSwap(key, term.key) || editDistanceWithin(key, term.key, 1) === 1) {
                matches.push(term);
            }
        }
    }
    const unique = [...new Map(matches.map(term => [`${term.kind}:${term.name}`, term])).values()];
    const result = unique.length === 1 ? unique[0] : null;
    closeTermCache.set(key, result);
    while (closeTermCache.size > CLOSE_TERM_CACHE_SIZE) closeTermCache.delete(closeTermCache.keys().next().value);
    return result;
}

function recognizedTerms(text, { allowTypo = false } = {}) {
    const words = [...String(text || '').matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
    const consumed = new Set();
    const found = [];
    for (let index = 0; index < words.length;) {
        let match = null;
        for (let count = Math.min(5, words.length - index); count >= 1; count--) {
            const key = nameKey(words.slice(index, index + count).map(word => word[0]).join(''));
            const choices = [...new Map((termsByKey.get(key) || [])
                .map(choice => [`${choice.kind}:${choice.name}`, choice])).values()];
            if (choices.length !== 1) continue;
            match = { ...choices[0], count };
            break;
        }
        if (!match && allowTypo) {
            for (let count = Math.min(4, words.length - index); count >= 1; count--) {
                const key = nameKey(words.slice(index, index + count).map(word => word[0]).join(''));
                const typo = closeUniqueTerm(key);
                if (typo) { match = { ...typo, count }; break; }
            }
        }
        if (!match) { index++; continue; }
        found.push({ kind: match.kind, name: match.name,
            written: words.slice(index, index + match.count).map(word => word[0]).join(' ') });
        for (let offset = 0; offset < match.count; offset++) consumed.add(index + offset);
        index += match.count;
    }
    return { found, leftover: words.filter((_, index) => !consumed.has(index)).map(word => word[0]).join(' ') };
}

function matchKnownTermHeading(text) {
    const words = [...String(text || '').trim().matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].slice(0, 5);
    if (!words.length || words[0].index !== 0) return null;
    for (let count = words.length; count >= 1; count--) {
        const key = nameKey(words.slice(0, count).map(word => word[0]).join(''));
        const choices = [...new Map((termsByKey.get(key) || [])
            .map(choice => [`${choice.kind}:${choice.name}`, choice])).values()];
        if (choices.length === 1) return choices[0];
    }
    return null;
}

function hasKnownTeamDetail(text, { allowTypo = false } = {}) {
    return recognizedTerms(text, { allowTypo }).found.some(term => nameKey(term.written) !== 'wow')
        || /\bz\s*[- ]?moves?\b/iu.test(String(text || ''));
}

function organizedDetail(detail) {
    const original = String(detail || '').trim().replace(/^[:;\s]+/u, '');
    if (!original) return '';
    if (/^[\s(:=-]*z[\s).!?]*$/iu.test(original)) return ' (Other: Z-Move)';
    // A hedge or negation changes the meaning of a term. Preserve the author's
    // exact wording rather than presenting a speculative item as confirmed.
    if (/\b(?:not|no|without|maybe|might|probably|possibly|seems|unsure|unknown|don't\s+know)\b/iu.test(original)) {
        return ` ${original}`;
    }
    const other = [];
    let source = original.replace(/\bz\s*[- ]?moves?\b/giu, () => { other.push('Z-Move'); return ' '; });
    source = source.replace(/\+\s*speed\b/giu, () => { other.push('+Speed'); return ' '; });
    const { found, leftover } = recognizedTerms(source, { allowTypo: true });
    if (!found.length && !other.length) return ` ${original}`;
    const byKind = { item: [], ability: [], nature: [], move: [] };
    for (const { kind, name } of found) {
        if (!byKind[kind].includes(name)) byKind[kind].push(name);
    }
    const remainder = leftover.replace(/\b(?:with|and|holding|holds|has|using|is|a|the|moves?|item|ability|nature)\b/giu, ' ')
        .replace(/\s+/gu, ' ').trim();
    // An unknown word can modify a nearby term ("Pscyco cut" is not Cut).
    // Keep the original detail whenever we cannot assign every word safely.
    if (remainder) return ` ${original}`;
    const attributes = [
        byKind.item.length && `Item: ${byKind.item.join(', ')}`,
        byKind.ability.length && `Ability: ${byKind.ability.join(', ')}`,
        byKind.nature.length && `Nature: ${byKind.nature.join(', ')}`,
        other.length && `Other: ${other.join(', ')}`
    ].filter(Boolean);
    return `${attributes.length ? ` (${attributes.join('; ')})` : ''}${byKind.move.length ? `: ${byKind.move.join(', ')}` : ''}`;
}

function formatEntry(species, remainder) {
    let detail = String(remainder || '');
    const regional = detail.match(/^\s*\/?\s*((?:choice\s+)?(?:scarf|scraff))?\s*[-/;,]*\s*(Hisui|Alola|Galar|Paldea)\b\s*[-/;,]?/iu);
    if (regional) {
        const region = regional[2][0].toUpperCase() + regional[2].slice(1).toLowerCase();
        if (knownSpecies.has(`${species}-${region}`)) {
            species = `${species}-${region}`;
            detail = `${regional[1] ? 'Choice Scarf ' : ''}${detail.slice(regional[0].length)}`;
        }
    }
    const mega = detail.match(/^\s*(?:\(\s*mega(?:\s+([XY]))?\s*\)|mega(?:\s+([XY]))?)\s*[:;,–-]?\s*/iu);
    if (mega) {
        const form = `${species}-Mega${mega[1] || mega[2] ? `-${(mega[1] || mega[2]).toUpperCase()}` : ''}`;
        if (knownSpecies.has(form)) {
            species = form;
            detail = detail.slice(mega[0].length);
        }
    }
    return `- ${displaySpecies(species)}${organizedDetail(detail)}`;
}

function bracketEntries(line) {
    const bracketedRoster = line.match(/^([^\[\]\n]*)\[([^\]\n]+)\]\s*$/u);
    if (bracketedRoster) {
        const roster = commaRosterEntries(bracketedRoster[2]);
        if (roster) return { ...roster, before: bracketedRoster[1].trim() };
    }
    const headings = [];
    for (const bracket of line.matchAll(/\[([^\]\n]{2,80})\]/gu)) {
        const match = matchSpeciesHeading(bracket[1], { allowTypo: true, allowBroadAlias: true });
        if (match?.species) headings.push({ start: bracket.index, end: bracket.index + bracket[0].length, inside: bracket[1], match });
    }
    if (!headings.length) return null;

    const entries = [];
    const uncertainNames = [];
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const next = headings[index + 1]?.start ?? line.length;
        const insideTail = heading.inside.slice(heading.match.end).trim();
        const body = line.slice(heading.end, next).trim();
        entries.push(formatEntry(heading.match.species, [insideTail && `[${insideTail}]`, body].filter(Boolean).join(' ')));
        if (heading.match.kind === 'typo' && heading.match.distance > 2) uncertainNames.push(`${heading.inside.slice(0, heading.match.end)} → ${heading.match.species}`);
    }
    return { entries, before: line.slice(0, headings[0].start).trim(), uncertainNames };
}

function inlineSeparatedEntries(line) {
    const headings = [];
    for (const token of line.matchAll(/\S+/gu)) {
        const start = token.index;
        if (headings.length && start < headings.at(-1).end) continue;
        const match = matchSpeciesHeading(line.slice(start), { allowTypo: true, allowBroadAlias: true });
        if (!match?.species || !/^\s*(?:-->|->|=>|→|[-–:])\s*(?:\S|$)/u.test(line.slice(start + match.end))) continue;
        headings.push({ start, end: start + match.end, match });
    }
    if (headings.length < 2) return null;
    const entries = [];
    const uncertainNames = [];
    for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const next = headings[index + 1]?.start ?? line.length;
        const detail = line.slice(heading.end, next).trim().replace(/^(?:-->|->|=>|→|[-–:])\s*/u, '');
        entries.push(formatEntry(heading.match.species, detail));
        if (heading.match.kind === 'typo' && heading.match.distance > 2) uncertainNames.push(`${line.slice(heading.start, heading.end)} → ${heading.match.species}`);
    }
    return { entries, before: line.slice(0, headings[0].start).trim(), uncertainNames };
}

function arrowEntry(line) {
    const match = String(line || '').match(/^(.{2,35}?)\s*(?:-->|->|=>|→)\s*(.*)$/u);
    if (!match) return null;
    const heading = matchSpeciesHeading(match[1].trim(), { allowTypo: true, allowBroadAlias: true });
    if (!heading?.species || heading.end !== match[1].trim().length) return null;
    return {
        entry: formatEntry(heading.species, match[2]),
        uncertainName: heading.kind === 'typo' && heading.distance > 2
            ? `${match[1].trim()} → ${heading.species}` : null
    };
}

function splitTopLevelClauses(line, { loose = false } = {}) {
    const clauses = [];
    let start = 0;
    let parentheses = 0;
    let brackets = 0;
    const source = String(line || '');
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === '(') parentheses++;
        else if (character === ')') parentheses = Math.max(0, parentheses - 1);
        else if (character === '[') brackets++;
        else if (character === ']') brackets = Math.max(0, brackets - 1);
        else if (parentheses === 0 && brackets === 0 && (character === ',' || character === ';'
            || loose && (character === '.' || /[-–]/u.test(character) && /\s/u.test(source[index - 1] || '')
                && /\s/u.test(source[index + 1] || '')))) {
            clauses.push(source.slice(start, index).trim());
            start = index + 1;
        }
    }
    clauses.push(source.slice(start).trim());
    return clauses.filter(Boolean);
}

function structuredClauseEntries(line) {
    const clauses = splitTopLevelClauses(line);
    if (!clauses.length || clauses.length > 6) return null;
    const parsed = [];
    for (const clause of clauses) {
        if (matchKnownTermHeading(clause) && !nameKey(recognizedTerms(clause).leftover)) return null;
        const words = speciesWordsOutsideParentheses(clause);
        const speciesReads = [];
        for (const word of words) {
            if (speciesReads.some(read => word.index < read.end)) continue;
            const match = matchSpeciesHeading(clause.slice(word.index), { allowBroadAlias: true });
            if (match?.species) speciesReads.push({ ...match, start: word.index, end: word.index + match.end });
        }
        if (speciesReads.length !== 1) return null;
        const read = speciesReads[0];
        const detail = `${clause.slice(0, read.start)} ${clause.slice(read.end)}`.trim();
        const hasGameTerm = hasKnownTeamDetail(detail, { allowTypo: true }) || /\+\s*speed\b/iu.test(detail);
        const explicitForm = /\bmega\b/iu.test(clause) && read.species.includes('-Mega');
        if (read.kind === 'alias' && !hasGameTerm && !explicitForm && clauses.length < 2) return null;
        // Do not turn an incidental Pokémon word in free text into a team row.
        if (read.start > 0 && !hasGameTerm && !explicitForm && clauses.length < 2) return null;
        parsed.push({ read, entry: formatEntry(read.species, detail) });
    }
    return { entries: parsed.map(item => item.entry), uncertainNames: [] };
}

function modifierFirstEntries(line) {
    // Notes occasionally put an item, ability or move before the Pokémon name.
    // Require a real species after a short prefix; scanning every word would turn moves into names.
    const clauses = String(line || '').split(/\s*[.;]\s*/u).map(value => value.trim()).filter(Boolean);
    const entries = [];
    const uncertainNames = [];
    for (const clause of clauses) {
        const megaHeading = /^mega\s/iu.test(clause) && matchSpeciesHeading(clause, { allowBroadAlias: true });
        if (megaHeading?.species?.includes('-Mega')) {
            // Consume the full form name before treating Mega as a prefix note.
            entries.push(formatEntry(megaHeading.species, clause.slice(megaHeading.end)));
            continue;
        }
        const tokens = [...clause.matchAll(/\S+/gu)];
        let heading = null;
        let prefix = null;
        for (let index = 1; index <= Math.min(3, tokens.length - 1); index++) {
            const before = clause.slice(0, tokens[index].index).trim();
            if (!/^(?:(?:choice\s+)?(?:scarf|band|specs)|sash|life\s+orb|leftovers|(?:assault\s+)?vest|sand\s*veil|will-?o-?wisp|wilowisp|wisp|bold|impish|modest|timid|mega|z\s*move)$/iu.test(before)) continue;
            const candidate = matchSpeciesHeading(clause.slice(tokens[index].index), { allowTypo: true, allowBroadAlias: true });
            if (candidate?.species) {
                heading = { ...candidate, start: tokens[index].index };
                prefix = before;
                break;
            }
        }
        if (!heading) return null;
        const after = clause.slice(heading.start + heading.end).trim();
        entries.push(formatEntry(heading.species, `(${prefix})${after ? `: ${after}` : ''}`));
        if (heading.kind === 'typo' && heading.distance > 2) {
            uncertainNames.push(`${clause.slice(heading.start, heading.start + heading.end)} → ${heading.species}`);
        }
    }
    return entries.length ? { entries, uncertainNames } : null;
}

function looseMentionEntries(line) {
    // A few reports list multiple Pokémon as prose: "left over Landorus,
    // Lopunny quick attack, unaware Clef". Require two separate, exact species
    // mentions before treating the text as a team.
    const clauses = splitTopLevelClauses(line, { loose: true });
    if (clauses.length < 2) return null;
    const entries = [];
    const remaining = [];
    const species = new Set();
    for (const clause of clauses) {
        const words = speciesWordsOutsideParentheses(clause);
        const found = words.map(word => ({
            start: word.index,
            match: matchSpeciesHeading(clause.slice(word.index))
        })).find(item => item.match?.species);
        if (!found) {
            remaining.push(clause);
            continue;
        }
        const before = clause.slice(0, found.start).trim();
        const after = clause.slice(found.start + found.match.end).trim();
        entries.push(formatEntry(found.match.species,
            `${before ? `(${before})` : ''}${before && after ? ': ' : ''}${after}`));
        species.add(found.match.species);
    }
    return species.size >= 2 ? { entries, remaining } : null;
}

function speciesWordsOutsideParentheses(text) {
    const source = String(text || '');
    let cursor = 0, depth = 0;
    return [...source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu)].filter(word => {
        while (cursor < word.index) {
            if (source[cursor] === '(') depth++;
            else if (source[cursor] === ')') depth = Math.max(0, depth - 1);
            cursor++;
        }
        return depth === 0;
    });
}

function commaRosterEntries(line) {
    const names = String(line || '').split(/[,，]/u).map(name => name.trim()).filter(Boolean);
    if (names.length < 3 || names.length > 6) return null;
    const matches = names.map(name => matchSpeciesHeading(name, { allowTypo: true, allowBroadAlias: true }));
    if (matches.some((match, index) => !match?.species || match.end !== names[index].length)) return null;
    return {
        entries: matches.map(match => formatEntry(match.species, '')),
        uncertainNames: matches.flatMap((match, index) => match.kind === 'typo' && match.distance > 2
            ? [`${names[index]} → ${match.species}`] : [])
    };
}

function noteWithoutIgnHeading(value, ign) {
    const line = String(value || '').trim();
    if (!ign) return line;
    const heading = line.match(/^\s*(?:>+\s*)?(?:\*\*)?([\p{L}\p{N}_.-]{2,32})(?:\*\*)?([\s\S]*)$/u);
    if (!heading || nameKey(heading[1]) !== nameKey(ign)) return line;

    let detail = heading[2].trim();
    const parenthetical = detail.match(/^\(([^)\n]{1,80})\)\s*([\s\S]*)$/u);
    if (parenthetical) {
        const inside = parenthetical[1].trim();
        const isRating = /^\d{1,4}\s*(?:(?:pvp\s*)?(?:rating|rtg|rt))?$/iu.test(inside);
        detail = [isRating ? '' : inside, parenthetical[2].trim()].filter(Boolean).join(' ');
    }
    return detail.replace(/^(?:-{1,2}>|=>|[:;–—-])\s*/u, '').trim();
}

function isPokemonDetailNote(text) {
    const lines = String(text || '').trim().split(/\n+/u);
    return lines.length > 0 && lines.every(line => {
        const heading = line.trim().replace(/^(?:>+\s*|[-*•]\s*)/u, '');
        const pokemon = matchSpeciesHeading(heading, {
            allowBroadAlias: true, allowTypo: hasKnownTeamDetail(heading, { allowTypo: true })
        });
        const detail = pokemon?.species && heading.slice(pokemon.end).trim();
        if (!detail || !/[\p{L}\p{N}?]/u.test(detail)) return false;
        // Short observations can describe an unknown set. Questions and general
        // Pokémon chatter do not become part of a scout just by mentioning one.
        return !/\b(?:my|your|our)\s+(?:team|favou?rite)|\b(?:lol|lmao|rofl)\b|\b(?:looks?\s+(?:cool|cute)|(?:is|are)\s+(?:cool|cute|op|broken|trash)|sucks?|needs?\s+(?:a\s+)?nerf)\b/iu.test(detail)
            && !/\b(?:why|how|what|which|where|when|should|can\s+(?:i|you|we))\b.*\?/iu.test(detail);
    });
}

function reportContextSpecies(row = {}) {
    row ||= {};
    const species = new Set(String(row.team_text || '').split(/\n/u)
        .map(line => matchSpeciesHeading(line.replace(/^\s*[-•]\s*/u, ''))?.species).filter(Boolean));
    let results = row.ocrResults;
    if (!Array.isArray(results)) {
        try { results = JSON.parse(row.ocr_json || '[]'); } catch { results = []; }
    }
    if (!Array.isArray(results)) results = [];
    for (const result of results) {
        const text = String(result.text || '');
        const name = text.match(/team\s*preview\s+vs\s+([\p{L}\p{N}_.-]+)/iu)?.[1];
        if (!name || !row.opponent_ign || nameKey(name) !== nameKey(row.opponent_ign)) continue;
        const preview = teamFromPreview(text);
        if (preview.uncertainNames.length) continue;
        for (const line of String(preview.teamText || '').split('\n')) {
            const pokemon = matchSpeciesHeading(line.replace(/^[-•]\s*/u, ''))?.species;
            if (pokemon) species.add(pokemon);
        }
    }
    return species;
}

function resolveNoteShorthand(text, contextSpecies = []) {
    const source = String(text || '');
    const species = [...new Set(contextSpecies)];
    if (!species.length) return source;
    return source.replace(/\b[\p{L}]{4,}\b/gu, (word, offset) => {
        if (matchSpeciesHeading(word, { allowBroadAlias: true })?.species
            || matchKnownTermHeading(source.slice(offset))) return word;
        // "Lati" stays ambiguous unless this report's own team identifies one side.
        const choices = species.filter(name => nameKey(name).startsWith(nameKey(word)));
        return choices.length === 1 ? displaySpecies(choices[0]) : word;
    });
}

function splitScoutText(text, ign = null, { allowContextualDetails = false, contextSpecies = [] } = {}) {
    const source = (allowContextualDetails ? resolveNoteShorthand(text, contextSpecies) : String(text || '')).trim();
    if (!source) return { teamText: null, notes: null, uncertainNames: [] };
    const team = [];
    const notes = [];
    const uncertainNames = [];
    const addNote = value => {
        const note = noteWithoutIgnHeading(value, ign);
        if (note) notes.push(note);
    };
    for (const rawLine of source.replace(/\r/g, '').split(/\n+/)) {
        const line = rawLine.trim();
        if (!line || (ign && nameKey(line) === nameKey(ign))) continue;
        const unquoted = line.replace(/^>+\s*/, '');
        let withoutBullet = unquoted.replace(/^(?:\d{1,2}[.)]\s+|[-*•]\s+)/u, '');
        const namedLine = ign && withoutBullet.match(/^([^\s:]+)\s*(?::\s*|\s+)([\s\S]+)$/u);
        if (namedLine && nameKey(namedLine[1]) === nameKey(ign)) {
            const afterIgn = namedLine[2]
                .replace(/^\(\s*\d{1,4}\s*\)\s*/u, '')
                .replace(/^(?:-->|->|=>|:)\s*/u, '');
            if (matchSpeciesHeading(afterIgn, { allowBroadAlias: true })?.species || /^\[/u.test(afterIgn)) {
                withoutBullet = afterIgn;
            }
        }
        const arrow = arrowEntry(withoutBullet);
        if (arrow) {
            team.push(arrow.entry);
            if (arrow.uncertainName) uncertainNames.push(arrow.uncertainName);
            continue;
        }
        const bracketed = bracketEntries(withoutBullet);
        if (bracketed) {
            if (bracketed.before && (!ign || nameKey(bracketed.before) !== nameKey(ign))
                && !/^(?:team|opponent|pokemon)\s*:?$/iu.test(bracketed.before)) addNote(bracketed.before);
            team.push(...bracketed.entries);
            uncertainNames.push(...bracketed.uncertainNames);
            continue;
        }
        const inline = inlineSeparatedEntries(withoutBullet);
        if (inline) {
            if (inline.before && (!ign || nameKey(inline.before) !== nameKey(ign))) addNote(inline.before);
            team.push(...inline.entries);
            uncertainNames.push(...inline.uncertainNames);
            continue;
        }

        const clauses = structuredClauseEntries(withoutBullet);
        if (clauses) {
            team.push(...clauses.entries);
            continue;
        }

        const modifierFirst = modifierFirstEntries(withoutBullet);
        if (modifierFirst) {
            team.push(...modifierFirst.entries);
            uncertainNames.push(...modifierFirst.uncertainNames);
            continue;
        }

        const firstWord = withoutBullet.match(/^([^\s]+)\s+(.+)$/u);
        const rosterLine = firstWord && ign && nameKey(firstWord[1]) === nameKey(ign)
            ? firstWord[2] : withoutBullet;
        const commaRoster = commaRosterEntries(rosterLine);
        if (commaRoster) {
            team.push(...commaRoster.entries);
            uncertainNames.push(...commaRoster.uncertainNames);
            continue;
        }

        const body = ign && firstWord && nameKey(firstWord[1]) === nameKey(ign)
            ? rosterLine.replace(/^\s*(?:-->|->|=>|:)?\s*/u, '') : rosterLine;
        const mentions = looseMentionEntries(body);
        if (mentions) {
            team.push(...mentions.entries);
            for (const remainder of mentions.remaining) addNote(remainder);
            continue;
        }

        const hasHeadingFormat = withoutBullet !== unquoted || /^\[/u.test(withoutBullet)
            || /^[^\s:]{2,35}\s*[-–:]\s*\S/u.test(withoutBullet)
            || /[,;]\s*\S/u.test(withoutBullet);
        const match = matchSpeciesHeading(withoutBullet, {
            allowTypo: hasHeadingFormat || allowContextualDetails && hasKnownTeamDetail(withoutBullet, { allowTypo: true }),
            allowBroadAlias: true
        });
        const aliasDetail = match?.species ? withoutBullet.slice(match.end) : '';
        const strongAlias = match?.kind !== 'alias' || hasHeadingFormat || team.length > 0
            || allowContextualDetails && isPokemonDetailNote(withoutBullet)
            || recognizedTerms(aliasDetail, { allowTypo: true }).found.length > 0;
        if (match?.species && strongAlias) {
            team.push(formatEntry(match.species, withoutBullet.slice(match.end)));
            if (match.kind === 'typo' && match.distance > 2) uncertainNames.push(`${withoutBullet.slice(0, match.end)} → ${match.species}`);
        } else if (/^[-•]\s*\S/u.test(unquoted) && team.length) {
            team[team.length - 1] += `; ${unquoted.replace(/^[-•]\s*/, '')}`;
        } else {
            addNote(line);
        }
    }
    return {
        teamText: team.join('\n') || null,
        notes: notes.join('\n') || null,
        uncertainNames
    };
}

function teamFromPreview(ocrText) {
    const lines = String(ocrText || '').replace(/\r/g, '').split(/\n+/).map(line => line.trim()).filter(Boolean);
    for (let index = 0; index < lines.length - 1; index++) {
        if (!/team\s*preview\s+vs|teampreview\s+vs/iu.test(lines[index])) continue;
        const names = [];
        for (const line of lines.slice(index + 1, index + 5)) {
            if (/^\[?\d{1,2}:\d{2}(?::\d{2})?\]?|^(?:system|battle)\s*:/iu.test(line)) break;
            const parts = line.split(/[,，]/u)
                .map(value => value.trim().replace(/^[^\p{L}\p{N}]{1,3}(?=\p{L})/u, ''))
                .filter(Boolean);
            if (!parts.some(name => matchSpeciesHeading(name, { allowTypo: true, preview: true })?.species)) break;
            names.push(...parts);
            if (names.length >= 6) break;
        }
        if (names.length < 4 || names.length > 6) continue;
        const entries = [];
        const uncertainNames = [];
        for (const name of names) {
            const match = matchSpeciesHeading(name, { allowTypo: true, preview: true });
            entries.push(match?.species ? formatEntry(match.species, '') : `- [Unclear] ${name || '?'}`);
            if (!match?.species || (match.kind === 'typo' && match.distance > 2)) uncertainNames.push(name || '?');
        }
        return { teamText: entries.join('\n'), uncertainNames };
    }
    return { teamText: null, uncertainNames: [] };
}

function sameTeamSpecies(left, right) {
    if (!left || !right) return false;
    return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
}

function teamLineSpecies(line) {
    const body = String(line || '').trim().replace(/^(?:[-•]|\d+[.)])\s*/u, '');
    const match = matchSpeciesHeading(body, { allowTypo: true });
    return match?.species || null;
}

function mergePreviewTeam(teamText, previewText) {
    const rows = String(teamText || '').split(/\n/u).map(line => line.trim()).filter(Boolean);
    for (const line of String(previewText || '').split(/\n/u).map(value => value.trim()).filter(Boolean)) {
        const species = teamLineSpecies(line);
        if (species && rows.some(row => sameTeamSpecies(teamLineSpecies(row), species))) continue;
        if (!rows.includes(line)) rows.push(line);
    }
    return rows.join('\n') || null;
}

module.exports = {
    commaRosterEntries, hasKnownTeamDetail, inlineSeparatedEntries, isPokemonDetailNote,
    matchKnownTermHeading, matchSpeciesHeading, mergePreviewTeam, nameKey, reportContextSpecies,
    recognizedTerms, resolveNoteShorthand, sameTeamSpecies, splitScoutText, teamFromPreview, teamLineSpecies
};
