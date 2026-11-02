// Turns message text and OCR into an opponent IGN, rating, scout details, and review decision.
'use strict';

const { commaRosterEntries, hasKnownTeamDetail, inlineSeparatedEntries, matchKnownTermHeading, matchSpeciesHeading, mergePreviewTeam,
    splitScoutText, teamFromPreview } = require('./PokemonTeamParser.js');
const { reviewedTextKey, reviewPatternKey } = require('./ScoutReviewLearning.js');

const IGN_PATTERN = '[\\p{L}\\p{N}_.-]{2,32}';
// Keep names whose spelling has confirmed consistent across reports.
const IGN_DISPLAY_NAMES = new Map([
    ['90skid', '90skid'],
    ['goldenp1kachu', 'Goldenp1kachu'],
    ['gesb', 'gesb'],
    ['justbillionare', 'Justbillionare'],
    ['gal1leo', 'Gal1leo']
]);

function normalizeIgn(value) {
    const ign = String(value || '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_.-]+$/gu, '').replace(/-+$/u, '');
    return ign ? ign.toLocaleLowerCase('en-US') : null;
}

function canonicalIgn(value) {
    const ign = String(value || '').trim();
    return IGN_DISPLAY_NAMES.get(normalizeIgn(ign)) || ign;
}

function cleanIgn(value) {
    const ign = String(value || '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}_.-]+$/gu, '').replace(/-+$/u, '');
    return new RegExp(`^${IGN_PATTERN}$`, 'u').test(ign) ? canonicalIgn(ign) : null;
}

function genericInferredIgn(value) {
    return /^(?:a|an|and|at|but|by|for|from|he|her|his|i|in|is|it|me|my|of|on|or|our|she|that|the|their|them|they|this|to|us|was|we|with|you|your)$/iu.test(String(value || ''));
}

function joinedSpeciesDetail(value) {
    const name = String(value || '');
    const heading = matchSpeciesHeading(name);
    return Boolean(heading?.species && name[heading.end] === '-'
        && hasKnownTeamDetail(name.slice(heading.end + 1), { allowTypo: true }));
}

function extractRating(text, ign = null, { fromOcr = false } = {}) {
    const source = String(text || '');
    const patterns = [
        new RegExp(`ranked\\s+opponent\\s+found\\s*:\\s*${ign ? escapeRegExp(ign) : '[^\\s(]{2,32}'}\\s*\\(\\s*(\\d{1,4})\\s*\\)`, 'iu'),
        /\bopponent\s+(?:pvp\s+)?rating\s*[:=]?\s*(?![+-])(\d{1,4})/iu,
        ign ? new RegExp(`${escapeRegExp(ign)}\\s*\\(\\s*(\\d{1,4})\\s*(?:(?:pvp\\s*)?(?:rating|rtg|rt))?\\s*\\)`, 'iu') : null
    ].filter(Boolean);
    // Result screens show Rating:+16 for the scout's rating change, not the opponent's rating.
    if (!fromOcr) {
        patterns.push(/\b(?:pvp\s*)?rating\s*[:=]?\s*(?![+-])(\d{1,4})/iu);
        patterns.push(/\b(\d{2,4})\s+(?:pvp\s+)?(?:rating|rtg)\b/iu);
        // Players also write "Opponent - 230 rank". Bind this shorthand to
        // the opponent heading so unrelated rankings cannot become ratings.
        if (ign) patterns.push(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(ign)}\\s*[-:–—]\\s*(\\d{1,4})\\s+rank\\b`, 'iu'));
    } else if (ign) {
        const profileName = new RegExp(`\\b(?:inspect|name)\\s*[:=]\\s*${escapeRegExp(ign)}(?![\\p{L}\\p{N}_.-])`, 'iu');
        // Inspect windows show an absolute rating alongside wins/losses. Bind
        // those unsigned values to the selected profile so result-card deltas
        // and another player's profile cannot supply an opponent's rating.
        if (profileName.test(source) && /\bwins\s*:?\s*\d/iu.test(source)
            && /\blosses\s*:?\s*\d/iu.test(source)) {
            patterns.push(/\b(?:pvp\s*)?rating\s*[:=]?\s*(?![+-])(\d{1,4})/iu);
        }
    }
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match) return Number(match[1]);
    }
    return null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function closeIgnSpelling(left, right) {
    const a = normalizeIgn(left);
    const b = normalizeIgn(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const limit = Math.min(a.length, b.length) >= 10 ? 2 : 1;
    if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > limit) return false;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let index = 1; index <= a.length; index++) {
        const current = [index];
        for (let column = 1; column <= b.length; column++) {
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + (a[index - 1] === b[column - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length] <= limit;
}

function sameNameWithOcrZeros(left, right) {
    const a = normalizeIgn(left);
    const b = normalizeIgn(right);
    return Boolean(a && b && a !== b && a.replace(/0/gu, 'o') === b.replace(/0/gu, 'o'));
}

function numericSuffixVariation(left, right) {
    const a = normalizeIgn(left);
    const b = normalizeIgn(right);
    if (!a || !b || a === b) return false;
    const withoutSuffix = value => value.replace(/[-_]?\d{2,4}$/u, '');
    return (withoutSuffix(a) !== a && withoutSuffix(a) === b)
        || (withoutSuffix(b) !== b && withoutSuffix(b) === a);
}

function relatedIgnShape(left, right) {
    const a = normalizeIgn(left), b = normalizeIgn(right);
    if (!a || !b || Math.min(a.length, b.length) < 8) return false;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
    while (suffix < Math.min(a.length, b.length) - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    return prefix >= 4 && suffix >= 3 && prefix + suffix >= Math.min(a.length, b.length) * 0.55;
}

function establishedNameSupport(name, evidence = []) {
    const match = Array.isArray(evidence)
        ? evidence.find(item => normalizeIgn(item.ign) === normalizeIgn(name)) : null;
    return new Set(match?.authorIds || []).size;
}

function nameAppearsInOcr(text, name) {
    if (!name) return false;
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_.-])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_.-])`, 'iu').test(String(text || ''));
}

function obviousIgnTypo(left, right) {
    const a = normalizeIgn(left);
    const b = normalizeIgn(right);
    if (!a || !b || Math.min(a.length, b.length) < 6) return false;
    if (a === b) return true;
    if (Math.abs(a.length - b.length) === 1) {
        const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
        return [...longer].some((_, index) => longer.slice(0, index) + longer.slice(index + 1) === shorter);
    }
    if (a.length !== b.length) return false;
    const mismatch = [...a].map((character, index) => character === b[index] ? -1 : index).filter(index => index >= 0);
    if (mismatch.length === 1) return true;
    // A swapped pair is common in longer names; avoid merging short IGNs.
    if (a.length < 9) return false;
    return mismatch.length === 2 && mismatch[1] === mismatch[0] + 1
        && a[mismatch[0]] === b[mismatch[1]] && a[mismatch[1]] === b[mismatch[0]];
}

function distinctiveLongIgnTypo(left, right) {
    const a = normalizeIgn(left);
    const b = normalizeIgn(right);
    if (!a || !b || Math.min(a.length, b.length) < 10) return false;
    if (Math.abs(a.length - b.length) === 1) {
        const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
        return [...longer].some((_, index) => longer.slice(0, index) + longer.slice(index + 1) === shorter);
    }
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length - 1; index++) {
        if (a[index] !== b[index] && a[index] === b[index + 1]
            && a[index + 1] === b[index]
            && a.slice(0, index) === b.slice(0, index)
            && a.slice(index + 2) === b.slice(index + 2)) return true;
    }
    return false;
}

function screenshotNamesOpponent(ocrText, ign) {
    const labels = new RegExp(`(?:ranked\\s+opponent\\s+found\\s*:|team\\s*preview\\s+vs\\.?|teampreview\\s+vs\\.?|\\bvs\\.?\\s+)\\s*(${IGN_PATTERN})`, 'giu');
    return [...String(ocrText || '').matchAll(labels)].some(match => normalizeIgn(match[1]) === normalizeIgn(ign));
}

function mentionedSpeciesCount(text) {
    const words = [...String(text || '').matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu)]
        .map(match => match[0]);
    const species = new Set();
    for (let index = 0; index < words.length; index++) {
        const heading = matchSpeciesHeading(words.slice(index, index + 4).join(' '));
        if (heading?.species) species.add(heading.species);
        if (species.size >= 2) return species.size;
    }
    return species.size;
}

// Queue and battle activity describes when a scout was written, not the
// opponent's team. Keep this narrow so a heading such as "staller team" stays
// in the report. A separated suffix can still carry a useful team note.
const MATCHMAKING_STATUS = /^(?:(?:is|was|currently|just)\s+)*(?:(?:waiting\s+)?in\s+(?:(?:the|a)\s+)?(?:(?:ranked|pvp)\s+)?queue|(?:queued|queuing|queueing)(?:\s+up)?(?:\s+(?:for|in)\s+(?:ranked|pvp)(?:\s+queue)?)?|(?:searching|looking|waiting)\s+for\s+(?:a\s+)?(?:(?:ranked|pvp)\s+)?(?:match|battle|game)|(?:playing|in)\s+(?:a\s+)?(?:ranked|pvp)(?:\s+(?:match|battle|game))?)(?:\s+(?:now|rn|atm|right\s+now|at\s+the\s+moment))?(?=$|[\s,;:.!?–—-])/iu;

function withoutMatchmakingStatus(value) {
    const line = String(value || '').trim();
    const status = line.match(MATCHMAKING_STATUS);
    if (!status) return null;
    const tail = line.slice(status[0].length).trim();
    if (!tail || /^[.!?]+$/u.test(tail)) return '';
    // Require punctuation between the status and any remaining note. An
    // unseparated continuation may change the meaning of the whole sentence.
    const separated = tail.match(/^(?:[,;:–—-]|[.!?]\s+)\s*(.+)$/u);
    return separated ? separated[1].trim() : null;
}

function candidateFromText(text) {
    const source = String(text || '').replace(/\r/g, '');
    const sectionHeading = /^(?:team|notes?|scout|opponent|pokemon|pok[eé]mon|ign|rating|pvp|moves?|info|details)$/iu;
    const ratingInFront = source.match(new RegExp(`^\\s*(?:\\d{2,4}|[1-9]xx)\\s*(?:rtg|rating|rt)\\s*\\(\\s*(${IGN_PATTERN})\\s*\\)`, 'iu'));
    if (ratingInFront) {
        const ign = cleanIgn(ratingInFront[1]);
        if (ign && !genericInferredIgn(ign)) return { ign, confidence: 0.9, source: 'rated_name' };
    }
    const ratedHeading = source.match(/^\s*([\p{L}\p{N}_.-]{3,32})\s*\(\s*\d{2,4}\s*\)\s*(?:(?:current|top|ranked|rating|pvp)\b|[\p{L}\s]{0,24}\bteam\b)/iu);
    if (ratedHeading && splitScoutText(source).teamText) {
        const ign = cleanIgn(ratedHeading[1]);
        if (ign && !genericInferredIgn(ign) && !matchSpeciesHeading(ign, { allowTypo: true })?.species) {
            return { ign, confidence: 0.9, source: 'rated_name' };
        }
    }
    const ratedName = source.match(new RegExp(`^\\s*\\d{2,4}\\s+(?:pvp\\s+)?rating\\.?\\s+(${IGN_PATTERN})(?=$|\\s)`, 'iu'));
    if (ratedName) {
        const ign = cleanIgn(ratedName[1]);
        if (ign && !genericInferredIgn(ign)) return { ign, confidence: 0.9, source: 'rated_name' };
    }
    const strongPatterns = [
        new RegExp(`ranked\\s+opponent\\s+found\\s*:\\s*(${IGN_PATTERN})`, 'iu'),
        new RegExp(`team\\s*preview\\s+vs\\.?\\s*(${IGN_PATTERN})`, 'iu'),
        new RegExp(`team.?preview\\s+vs\\.?\\s*(${IGN_PATTERN})`, 'iu'),
        new RegExp(`(?:opponent(?:'s)?(?:\\s+ign)?|ign)\\s*[:=\\-]\\s*(${IGN_PATTERN})`, 'iu'),
        new RegExp(`\\bvs\\.?\\s+(${IGN_PATTERN})`, 'iu')
    ];
    for (const [index, pattern] of strongPatterns.entries()) {
        const match = source.match(pattern);
        if (match) {
            const value = cleanIgn(match[1]);
            if (index === strongPatterns.length - 1
                && /^(?:eachother|everyone|anyone|someone|you|me|him|her|them|us)$/iu.test(value || '')) continue;
            if (value && !genericInferredIgn(value)) return { ign: value, confidence: 0.96,
                source: index === strongPatterns.length - 1 ? 'versus_text' : 'labelled_text' };
        }
    }

    // Reports often start with "IGN -> team" or "IGN (rating): team".
    const namedReport = source.match(/^\s*\*{0,2}([\p{L}\p{N}_.-]{2,32}?)\*{0,2}\s*(?:\(\s*\d{1,4}\s*\))?\s*(?:-{1,2}>|=>|:)\s*([\s\S]+)/iu);
    if (namedReport) {
        const ign = cleanIgn(namedReport[1]);
        const pokemonHeading = ign && matchSpeciesHeading(ign, { allowTypo: true });
        const details = namedReport[2];
        const detailTeamRows = splitScoutText(details, ign).teamText?.split('\n').filter(Boolean).length || 0;
        if (ign && !genericInferredIgn(ign) && !sectionHeading.test(ign)
            && !(pokemonHeading?.species && pokemonHeading.end === ign.length)
            && !joinedSpeciesDetail(ign)
            && (detailTeamRows >= 2 || detailTeamRows === 1 && hasKnownTeamDetail(details))) {
            return { ign, confidence: 0.93, source: 'named_report' };
        }
    }

    // A first line can give an IGN plus a temporary matchmaking status. The
    // actual scout may start on the next line, so inspect the remaining lines
    // before treating the first token as the opponent's name.
    const statusLines = source.split(/\n/u).map(line => line.trim()).filter(Boolean);
    if (statusLines.length) {
        const statusHeading = statusLines[0].match(new RegExp(
            `^(?:>+\\s*)?\\*{0,2}(${IGN_PATTERN})\\*{0,2}[ \\t]*(?:\\([ \\t]*\\d{1,4}[ \\t]*\\))?[ \\t]*(?:[:;–—-][ \\t]*)?[ \\t]+(.+)$`, 'iu'
        ));
        const ign = cleanIgn(statusHeading?.[1]);
        if (ign && !genericInferredIgn(ign) && !sectionHeading.test(ign)
            && !matchSpeciesHeading(ign, { allowTypo: true })?.species
            && withoutMatchmakingStatus(statusHeading[2]) !== null) {
            // The status can be a separate Discord message. Preserve it as a
            // provisional named root so consecutive posts by this author join
            // the same scout; the status-only root needs officer review.
            if (statusLines.length === 1) {
                return { ign, confidence: 0.74, source: 'matchmaking_status_heading' };
            }
            const details = statusLines.slice(1).join('\n');
            const teamRows = splitScoutText(details, ign).teamText?.split('\n').length || 0;
            if (teamRows >= 2 || teamRows === 1 && hasKnownTeamDetail(details)) {
                return { ign, confidence: teamRows >= 2 ? 0.88 : 0.78,
                    source: 'matchmaking_status_heading' };
            }
        }
    }

    const leadingName = source.match(new RegExp(`^\\s*(?:\\*{1,2})?(${IGN_PATTERN})(?:\\*{1,2})?\\s+`, 'iu'));
    if (leadingName) {
        const firstTeamLine = source.slice(leadingName[0].length).split(/\n/u)[0];
        const inlineTeam = inlineSeparatedEntries(firstTeamLine);
        const commaTeam = commaRosterEntries(firstTeamLine);
        const bracketedTeam = /^\[/u.test(firstTeamLine.trim())
            ? splitScoutText(firstTeamLine).teamText?.split('\n') || [] : [];
        const parsedLeadingTeam = splitScoutText(firstTeamLine).teamText?.split('\n').filter(Boolean) || [];
        const singleDetailedPokemon = parsedLeadingTeam.length === 1
            && hasKnownTeamDetail(firstTeamLine)
            && /^(?:[-•]|\d+[.)]|[^\s:]{2,35}\s*[:(])/u.test(firstTeamLine.trim());
        if (!genericInferredIgn(leadingName[1]) && !sectionHeading.test(leadingName[1]) && !matchKnownTermHeading(source.trim())
            && !/^(?:scarf|band|specs|sash|leftovers|sandveil|wilowisp|wisp|bold|impish|modest|timid|mega|life|choice)$/iu.test(leadingName[1])
            && ((inlineTeam && !inlineTeam.before && inlineTeam.entries.length >= 3)
            || commaTeam?.entries.length >= 3
            || bracketedTeam.length >= 3
            || singleDetailedPokemon
            || parsedLeadingTeam.length >= 2 && (/[,:;]/u.test(firstTeamLine)
                || hasKnownTeamDetail(firstTeamLine)))) {
            const ign = cleanIgn(leadingName[1]);
            const pokemonHeading = ign && matchSpeciesHeading(ign);
            if (ign && !(pokemonHeading?.species && pokemonHeading.end === ign.length)
                && !joinedSpeciesDetail(ign)) {
                return { ign, confidence: 0.9, source: 'leading_ign_team' };
            }
        }
    }

    const lines = source.split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (lines.length >= 2) {
        const first = lines[0]
            .replace(/^(?:>+|[-*•\s])+/, '')
            .replace(/\s+\[[^\]]+\]$/, '')
            .replace(/\s+\([^)]{1,80}\)$/, '')
            .trim();
        const ign = cleanIgn(first);
        const pokemonHeading = ign && matchSpeciesHeading(ign);
        const details = lines.slice(1).join('\n');
        const detailTeamRows = splitScoutText(details, ign).teamText?.split('\n').filter(Boolean).length || 0;
        if (ign && !genericInferredIgn(ign) && !(pokemonHeading?.species && pokemonHeading.end === ign.length)
            && !joinedSpeciesDetail(ign)
            && !/^(?:team|notes?|scout|opponent|ranked|pvp|vs|ign)$/i.test(ign)) {
            // A heading followed by numbered Pokémon notes identifies the opponent.
            const numberedRows = lines.slice(1).map(line => line.match(/^>?\s*(\d{1,2})[.)]\s+\S/u)?.[1]);
            const teamNumbers = new Set(numberedRows.filter(Boolean).map(Number));
            if ([1, 2, 3, 4].every(number => teamNumbers.has(number))) {
                return { ign, confidence: 0.9, source: 'numbered_team_heading' };
            }
            if (detailTeamRows >= 2 || detailTeamRows === 1 && hasKnownTeamDetail(details)) {
                return { ign, confidence: detailTeamRows >= 2 ? 0.86 : 0.78, source: 'first_line' };
            }
        }
    }

    return null;
}

function nameFromResultLine(line) {
    const value = String(line || '').trim().replace(/^[^\p{L}\p{N}_.-]+/u, '');
    const match = value.match(new RegExp(`^(${IGN_PATTERN})(?=$|[^\\p{L}\\p{N}_.-])`, 'iu'));
    const ign = cleanIgn(match?.[1])?.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
    if (!ign || genericInferredIgn(ign) || !/\p{L}/u.test(ign)
        || /^(?:rating|system|date|duration|opponent|battle|replay|result|win|loss|victory|defeat|winner|loser|score|team|pokemon|rewards|you|your|surrendered|forfeit|disconnected|pvp|ranked|lv|level|ko|k\.?o\.?)$/iu.test(ign)
        || /^(?:lv|l)\.?\d{1,3}$/iu.test(ign)) return null;
    const remainder = value.slice(match[0].length);
    // Team-card names may share an OCR line with a trophy or a win/loss marker.
    const strayCharacters = remainder.replace(/K\.?\s*[O0]\.?|\bWIN\b|\bLOSS\b|\bSURRENDERED\b|\bDEFEAT\b|\bVICTORY\b|\bFORFEIT\b|\bDISCONNECTED\b/giu, '').replace(/[^\p{L}\p{N}]/gu, '');
    return strayCharacters.length <= 2 ? ign : null;
}

function candidateFromResultCard(source, ocrLines, imageInfo = {}) {
    const width = Number(imageInfo.width || 0);
    const height = Number(imageInfo.height || 0);
    const ratingChange = /\brating\s*[:;=]\s*[+-]\s*\d{1,4}\b/iu.test(source);
    const resultMarker = /\b(?:K\.?\s*[O0]\.?|surrendered|victory|defeat|forfeit|disconnected)(?=\W|$)/iu.test(source)
        || (width > height * 2.2 && /\b(?:win|loss)\b/iu.test(source));
    const levelCount = (source.match(/\blv\.?\s*1?00\b/giu) || []).length;
    if (!ratingChange && !(resultMarker && width > height * 1.3) && levelCount < 8) return null;

    const positioned = (Array.isArray(ocrLines) ? ocrLines : [])
        .map(line => ({ text: typeof line === 'string' ? line : line?.text, box: line?.bbox || line?.boundingBox }))
        .filter(line => line.box && [line.box.x0, line.box.y0, line.box.x1, line.box.y1].every(Number.isFinite));
    if (width && height && positioned.length) {
        const levelMarkers = positioned.filter(line => /\blv\.?\s*1?00\b/iu.test(line.text))
            .sort((a, b) => a.box.y0 - b.box.y0);
        // Use the lower six-Pokémon row as the anchor, regardless of card size or placement.
        const markerHeight = levelMarkers.length
            ? Math.max(...levelMarkers.map(line => line.box.y1 - line.box.y0)) : 0;
        const rowTolerance = Math.max(markerHeight * 1.5, height * 0.005);
        const lowerRosterY = levelMarkers.length >= 6
            && levelMarkers.at(-1).box.y0 - levelMarkers[0].box.y0 > rowTolerance * 2
            ? levelMarkers.at(-1).box.y0 : null;
        const lowerRow = lowerRosterY === null ? [] : levelMarkers.filter(line =>
            Math.abs(line.box.y0 - lowerRosterY) <= rowTolerance);
        const rowLeft = lowerRow.length >= 3 ? Math.min(...lowerRow.map(line => line.box.x0)) : null;
        const rowRight = lowerRow.length >= 3 ? Math.max(...lowerRow.map(line => line.box.x1)) : null;
        const rowWidth = rowRight === null ? null : rowRight - rowLeft;
        const rowGap = lowerRosterY === null ? null : lowerRosterY - levelMarkers[0].box.y0;
        const bandStart = lowerRosterY === null ? height * 0.78 : lowerRosterY - height * 0.01;
        const bandEnd = lowerRosterY === null ? height
            : Math.min(height, lowerRosterY + Math.max(height * 0.04, rowGap * 1.2));
        const anchored = rowWidth && rowWidth > width * 0.12;
        const lowerLeft = positioned
            .filter(line => {
                const atLeft = anchored
                    ? line.box.x0 >= rowLeft - rowWidth * 0.15 && line.box.x0 <= rowLeft + rowWidth * 0.25
                    : line.box.x0 <= width * 0.35;
                return atLeft && line.box.y0 >= bandStart && line.box.y0 <= bandEnd;
            })
            .sort((a, b) => b.box.y0 - a.box.y0 || a.box.x0 - b.box.x0);
        const names = [...new Set(lowerLeft.map(line => nameFromResultLine(line.text)).filter(Boolean))];
        if (names.length === 1) {
            const outcomeOnNameLine = lowerLeft.some(line => nameFromResultLine(line.text) === names[0]
                && /\b(?:K\.?\s*[O0]\.?|surrendered|victory|defeat)(?=\W|$)|🏆/iu.test(line.text));
            return { ign: names[0], confidence: anchored ? 0.92 : outcomeOnNameLine ? 0.86 : 0.74,
                source: anchored || outcomeOnNameLine ? 'result_card_ocr' : 'bottom_ocr_line' };
        }
        if (names.length > 1) return { ign: names[0], confidence: 0.64, source: 'bottom_ocr_line' };
    }

    const bottomText = source.split(/\n+/).map(line => line.trim()).filter(Boolean).slice(-4);
    const names = bottomText.reverse().map(line => ({ line, ign: nameFromResultLine(line) }))
        .filter(item => item.ign);
    const distinctNames = [...new Set(names.map(item => item.ign))];
    if (distinctNames.length === 1) {
        const outcomeOnNameLine = names.some(item => /\b(?:K\.?\s*[O0]\.?|surrendered|victory|defeat)(?=\W|$)|🏆/iu.test(item.line));
        return { ign: distinctNames[0], confidence: outcomeOnNameLine ? 0.86 : 0.74,
            source: outcomeOnNameLine ? 'result_card_ocr' : 'bottom_ocr_line' };
    }
    if (distinctNames.length > 1) return { ign: distinctNames[0], confidence: 0.64, source: 'bottom_ocr_line' };
    return null;
}

function battleParticipantPair(text) {
    const lines = String(text || '').split(/\n/u).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        const versus = line.match(/\b([\p{L}\p{N}_.-]{3,32})\s+V\s*S\.?\s+([\p{L}\p{N}_.-]{3,32})\b/iu);
        if (versus && !genericInferredIgn(versus[1]) && !genericInferredIgn(versus[2])
            && !/^(?:system|team.?preview|preview|opponent|ranked|battle)$/iu.test(versus[1])
            && !/^(?:please|wait|pokemon|team|result)$/iu.test(versus[2])) {
            return [versus[1], versus[2]];
        }
    }
    // Some battle banners lose the yellow VS glyph during grayscale OCR.
    for (const line of lines.slice(0, 2)) {
        const names = line.match(/^([\p{L}\p{N}_.-]{3,32})\s+([\p{L}\p{N}_.-]{3,32})(?:\s|$)/u);
        if (names && names[1].length >= 6 && names[2].length >= 6
            && /^(?:Please\s+Wait\b|$)/iu.test(line.slice(names[0].length).trim())
            && !/^(?:system|battle|ranked|pokemon|please|wait|date|opponent|result|surrendered|rating|victory|defeat|forfeit|duration|type|win|loss|ko|k\.o\.)$/iu.test(names[1])
            && !/^(?:system|battle|ranked|pokemon|please|wait|date|opponent|result|surrendered|rating|victory|defeat|forfeit|duration|type|win|loss|ko|k\.o\.)$/iu.test(names[2])
            && normalizeIgn(names[1]) !== normalizeIgn(names[2])) return [names[1], names[2]];
    }
    return null;
}

function opponentFromBattleBanner(text, context = {}) {
    const pair = battleParticipantPair(text);
    if (!pair) return { ign: null, ambiguous: false, sideResolved: false };
    const [left, right] = pair;
    const authorNames = new Set((context.authorNames || []).map(normalizeIgn).filter(Boolean));
    const memberNames = new Set((context.memberNames || []).map(normalizeIgn).filter(Boolean));
    const leftAuthor = authorNames.has(normalizeIgn(left));
    const rightAuthor = authorNames.has(normalizeIgn(right));
    if (leftAuthor !== rightAuthor) return { ign: leftAuthor ? right : left, ambiguous: false, sideResolved: true };
    if (leftAuthor && rightAuthor) return { ign: null, ambiguous: true, sideResolved: false };
    const leftMember = memberNames.has(normalizeIgn(left));
    const rightMember = memberNames.has(normalizeIgn(right));
    // A screenshot can be forwarded by another member. Exactly one roster
    // match still identifies our member's side without assuming the author.
    if (leftMember !== rightMember) return { ign: leftMember ? right : left, ambiguous: false, sideResolved: true };
    if (leftMember && rightMember) return { ign: null, ambiguous: true, sideResolved: false };
    return { ign: right, ambiguous: false, sideResolved: false };
}

function candidateFromOcr(ocrText, ocrLines = [], imageInfo = {}) {
    const source = String(ocrText || '').replace(/\r/g, '');
    if (imageInfo.focusedIgn && imageInfo.focusedConfidence >= 0.82) {
        return { ign: cleanIgn(imageInfo.focusedIgn), confidence: imageInfo.focusedConfidence,
            source: imageInfo.focusedSource === 'battle_header_ocr' ? 'battle_header_ocr' : 'result_card_ocr' };
    }
    // Saved OCR can predate focused banner detection. Reuse its visible pair
    // with the same roster context used for a fresh image read.
    const banner = opponentFromBattleBanner(source, imageInfo.memberContext);
    if (banner.ign && (banner.sideResolved || !imageInfo.battlePairAmbiguous)) {
        return { ign: cleanIgn(banner.ign), confidence: banner.sideResolved ? 0.96 : 0.9,
            source: 'battle_header_ocr' };
    }
    if (imageInfo.battlePairAmbiguous) return null;
    const profileTitle = source.match(new RegExp(`\\binspect\\s*:\\s*(${IGN_PATTERN})`, 'iu'));
    const profileName = source.match(new RegExp(`(?:^|\\n)\\s*name\\s*:\\s*(${IGN_PATTERN})`, 'iu'));
    const inspectedIgn = cleanIgn(profileTitle?.[1]);
    const namedIgn = cleanIgn(profileName?.[1]);
    if (inspectedIgn && namedIgn && normalizeIgn(inspectedIgn) === normalizeIgn(namedIgn)) {
        return { ign: namedIgn, confidence: 0.94, source: 'inspect_profile_ocr' };
    }
    // Some profile screenshots have only one readable name label.
    const profileFields = /\b(?:guild|play\s*time|join\s*date|total\s*pok[eé]mon|doctor\s*rank|excavation\s*rank)\s*:/iu;
    if (profileFields.test(source) && (inspectedIgn || namedIgn) && !(inspectedIgn && namedIgn)) {
        return { ign: namedIgn || inspectedIgn, confidence: 0.85, source: 'inspect_profile_ocr' };
    }

    const explicit = candidateFromText(source);
    if (explicit?.source === 'labelled_text') {
        return { ...explicit, confidence: Math.min(explicit.confidence, 0.88), source: 'labelled_ocr' };
    }

    const resultCard = candidateFromResultCard(source, ocrLines, imageInfo);
    if (resultCard?.confidence >= 0.85) {
        // Failure to recognize a close-up is not conflicting evidence. Keep
        // the score from the located bottom roster/name geometry; the caller
        // still requires a frame, an anchored name, or independent agreement.
        return resultCard;
    }

    // A surrender line can identify the opponent when tiny roster labels are unreadable.
    const surrenderedNames = [...source.matchAll(new RegExp(`\\b(${IGN_PATTERN})\\.?\\s+surrendered\\b`, 'giu'))]
        .map(match => cleanIgn(match[1]))
        .filter(ign => ign && !/^(?:you|your|opponent|system|player|enemy)$/iu.test(ign));
    const distinctSurrendered = [...new Set(surrenderedNames.map(normalizeIgn))];
    if (!imageInfo.cardRect && distinctSurrendered.length === 1 && /\brating\s*[:;=]\s*[+-]\s*\d{1,4}\b/iu.test(source)) {
        return { ign: surrenderedNames[0], confidence: imageInfo.focusedScanAttempted && !imageInfo.focusedIgn ? 0.79 : 0.86,
            source: 'result_outcome_ocr' };
    }
    if (resultCard) return resultCard;

    const lines = (Array.isArray(ocrLines) ? ocrLines : [])
        .map(item => typeof item === 'string' ? item : item?.text)
        .map(line => String(line || '').trim())
        .filter(Boolean);
    const lastLines = lines.slice(-4).reverse();
    for (const line of lastLines) {
        const ign = nameFromResultLine(line.replace(/\s+(?:K\.?O\.?|Win|Loss).*$/iu, ''));
        if (ign && /\p{L}/u.test(ign)
            && !/^(?:K\.?O\.?|win|loss|rating|system|date|duration|opponent|battle|replay|surrendered|lv\.?\s*\d+)$/iu.test(ign)) {
            return { ign, confidence: 0.64, source: 'bottom_ocr_line' };
        }
    }
    return null;
}

function anchoredResultCardName(result, candidate) {
    if (!candidate?.ign || !['result_card_ocr', 'bottom_ocr_line'].includes(candidate.source)
        || normalizeIgn(candidate.ign).length < 4) return false;
    const width = Number(result?.ocrWidth || result?.width || 0);
    const height = Number(result?.ocrHeight || result?.height || 0);
    if (width < 100 || height < 55 || width < height * 1.3) return false;
    const lines = Array.isArray(result?.lines) ? result.lines : [];
    const bottomName = lines.find(line => {
        const box = line?.bbox || line?.boundingBox;
        return box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
            && normalizeIgn(nameFromResultLine(line.text)) === normalizeIgn(candidate.ign)
            && box.x0 <= width * 0.14 && box.y0 >= height * 0.65
            && box.y1 <= height * 1.03;
    });
    if (!bottomName) return false;
    const box = bottomName.bbox || bottomName.boundingBox;
    const topText = lines.filter(line => line?.bbox?.y0 <= height * 0.35)
        .map(line => line.text).join(' ');
    const hasRating = /\brating\s*[:;=]\s*[+-]\s*\d{1,4}\b/iu.test(topText);
    const outcome = /\b(?:K\.?\s*[O0]\.?|surrendered|victory|defeat|forfeit|disconnected)(?=\W|$)/iu;
    const hasOutcome = outcome.test(topText) || outcome.test(bottomName.text);
    const outcomeOnNameLine = outcome.test(bottomName.text);
    const longEnough = normalizeIgn(candidate.ign).length >= 4;
    // OCR often combines the bottom-left name and the far-right result into
    // one bounding box. The box then spans the card, even though the name is
    // anchored at the left edge. Very short OCR fragments stay in review.
    if (result.cardRect) return longEnough && (box.x1 <= width * 0.6 || outcomeOnNameLine);
    return longEnough && width >= height * 3 && lines.length >= 2 && outcomeOnNameLine
        || width >= height * 1.7 && hasRating && hasOutcome;
}

function resemblesEstablishedIgn(candidate, evidence = []) {
    const name = normalizeIgn(candidate);
    if (!name || name.length < 8 || !Array.isArray(evidence)) return false;
    return evidence.some(item => {
        const known = normalizeIgn(item.ign);
        return known && known !== name && known.length >= 8
            && Math.abs(known.length - name.length) <= 2
            && known[0] === name[0] && known.slice(-5) === name.slice(-5)
            && new Set(item.authorIds || []).size >= 2;
    });
}

function isLikelyScoutText(text) {
    return /\b(?:ranked\s+opponent|team\s*preview|teampreview|opponent|pvp|battle|\bvs\.?\b|\b(?:mega|z[- ]move|choice\s+band|stealth\s+rock|scald|u-?turn|knock\s+off|swords?\s+dance|troom|trick\s+room)\b)\b/iu.test(String(text || ''));
}

function hasImageEvidence(attachments = []) {
    return (Array.isArray(attachments) ? attachments : []).some(item => {
        const contentType = String(item?.contentType || '').toLowerCase();
        const name = String(item?.name || item?.url || '').toLowerCase();
        return contentType.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(name);
    });
}

function isClearlyOffTopicText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/^:[a-z0-9_+-]+:$/iu.test(value) || /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(value)) return true;
    const withoutTrailingEmoji = value.replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, '').trim();
    if (/\bvs\.?\s+(?:eachother|each\s+other|everyone|anyone|someone|you|me|him|her|them|us)\b/iu.test(value)
        && mentionedSpeciesCount(value) === 0) return true;
    return /^(?:(?:ha){2,}|heh+|lol+|lmao+|rofl+|gg|wp|nice|danger|(?:that|this|it) was crazy|was crazy|crazy|wtf is (?:ur|your) team|looks like one of the teams i get in randoms|yes i speak about my team|i still won|ig .*\b(?:ur|your|my) team\b.*)$/iu.test(withoutTrailingEmoji)
        || /^(?:remember|guys\s+try)\b.*\bwrite\b.*\bopponent'?s?\s+names?\b.*\b(?:plain\s+text|search)\b/iu.test(withoutTrailingEmoji)
        || /^you(?:'|’)?ll\s+never\s+know\s+if\s+the\s+opponent\s+is\b/iu.test(withoutTrailingEmoji)
        || /^my\s+first\s+opponent\s+after\s+making\s+(?:my\s+)?first\s+team\s+is\s+(?:u|you)\b/iu.test(withoutTrailingEmoji)
        || /^how\s+troom\??$/iu.test(withoutTrailingEmoji);
}

function isClearlySpamTeam(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    // A real Pokémon heading takes precedence over jokes or profanity in the notes.
    const hasPokemon = value.split(/\n+/u).some(line => {
        const heading = line.replace(/^\s*(?:[-•]|\d+[.)])\s*/u, '').replace(/^\s*\[/u, '');
        return Boolean(matchSpeciesHeading(heading, { allowTypo: true })?.species);
    });
    if (hasPokemon) return false;
    if (isClearlyOffTopicText(value)) return true;
    const words = value.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
    if (!words.length) return true;
    const spamWords = new Set([
        'fuck', 'fucking', 'shit', 'bullshit', 'bitch', 'asshole', 'dick', 'cunt',
        'haha', 'hehe', 'lol', 'lmao', 'rofl', 'wtf', 'xd', 'gg', 'ez', 'noob',
        'spam', 'test', 'testing', 'hi', 'hello'
    ]);
    return words.every(word => spamWords.has(word))
        || words.length <= 20 && words.some(word => spamWords.has(word))
            && /\b(?:fuck|fucking|shit|bullshit|bitch|asshole|dick|cunt)\b/iu.test(value);
}

function namesSeveralOpponents(text) {
    const source = String(text || '');
    const headings = [...source.matchAll(/\*\*([\p{L}\p{N}_.-]{3,32})\*\*\s*:/gu)]
        .map(match => match[1])
        .filter(name => {
            const pokemon = matchSpeciesHeading(name, { allowTypo: true });
            return !pokemon?.species || pokemon.end !== name.length;
        });
    for (const line of source.split(/\n+/u)) {
        const match = line.match(/^\s*([\p{L}\p{N}_.-]{3,32}?)\s*(?:-{1,2}>|=>|:)\s*(.*)$/u);
        if (!match) continue;
        const label = match[1];
        const pokemon = matchSpeciesHeading(label, { allowTypo: true });
        if (pokemon?.species && pokemon.end === label.length) continue;
        // A move list like "Aegis: Shadow Sneak" is one Pokémon, not another scout.
        if (splitScoutText(match[2]).teamText || /\b(?:team|opponent|pvp|vs)\b/iu.test(match[2])) headings.push(label);
    }
    if (new Set(headings.map(normalizeIgn)).size >= 2) return true;
    const sharedTeam = source.match(/^\s*([\p{L}\p{N}_.-]{3,32})\s*&\s*([\p{L}\p{N}_.-]{3,32})\b/u);
    return Boolean(sharedTeam && !matchSpeciesHeading(sharedTeam[1])?.species
        && !matchSpeciesHeading(sharedTeam[2])?.species);
}

function extractScoutData(message = {}, options = {}) {
    const content = String(message.content || '').trim();
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const images = hasImageEvidence(attachments);
    const results = Array.isArray(options.ocrResults) ? options.ocrResults : [];
    const reviewLearning = options.reviewLearning || null;
    const authorIgnNames = new Set((options.memberContext?.authorNames || []).map(normalizeIgn).filter(Boolean));
    const ocrText = results.map(result => result?.text || '').filter(Boolean).join('\n');
    const ocrCandidates = results
        .map(result => {
            // Older OCR rows did not save dimensions, but Discord attachment metadata did.
            const attachment = attachments.find(item => String(item?.id || '') === String(result?.attachmentId || ''));
            let read = candidateFromOcr(result?.text, result?.lines, {
                width: result?.ocrWidth || result?.width || attachment?.width,
                height: result?.ocrHeight || result?.height || attachment?.height,
                focusedIgn: result?.focusedIgn,
                focusedConfidence: result?.focusedConfidence,
                focusedScanAttempted: result?.focusedScanAttempted,
                focusedSource: result?.focusedSource,
                battlePairAmbiguous: result?.battlePairAmbiguous,
                cardRect: result?.cardRect,
                memberContext: options.memberContext
            });
            if (!read) return read;
            const normalizedReadIgn = normalizeIgn(read.ign);
            // OCR occasionally turns a UI word into a short "IGN" (for
            // example, "he" or "for"). Also never treat the reporting
            // member's own name as the opponent.
            if (genericInferredIgn(read.ign) || authorIgnNames.has(normalizedReadIgn)) return null;
            if (['result_card_ocr', 'bottom_ocr_line'].includes(read.source)
                && result?.focusedIgn && Number(result?.focusedConfidence || 0) >= 0.85
                && Array.isArray(options.knownIgnEvidence)) {
                const ligature = value => normalizeIgn(value)?.replace(/in|rn/gu, 'm');
                const matches = options.knownIgnEvidence.filter(item =>
                    normalizeIgn(item.ign)?.length >= 8 && normalizeIgn(item.ign) !== normalizeIgn(read.ign)
                    && ligature(item.ign) === ligature(read.ign)
                    && new Set(item.authorIds || []).size >= 2);
                if (matches.length === 1 && establishedNameSupport(read.ign, options.knownIgnEvidence) < 2) {
                    read = { ...read, ign: matches[0].ign, confidence: Math.max(0.9, read.confidence) };
                }
            }
            if (read.source === 'battle_header_ocr' && Array.isArray(options.knownIgnEvidence)) {
                const matches = options.knownIgnEvidence.filter(item =>
                    obviousIgnTypo(item.ign, read.ign) && normalizeIgn(item.ign) !== normalizeIgn(read.ign)
                    && new Set(item.authorIds || []).size >= 2);
                if (matches.length === 1 && establishedNameSupport(read.ign, options.knownIgnEvidence) < 2) {
                    return { ...read, ign: matches[0].ign, confidence: Math.max(0.91, read.confidence) };
                }
            }
            if (anchoredResultCardName(result, read)
                && !resemblesEstablishedIgn(read.ign, options.knownIgnEvidence)) {
                return { ...read, confidence: Math.max(read.confidence, 0.87), source: 'result_card_ocr' };
            }
            if (!['result_card_ocr', 'result_outcome_ocr'].includes(read.source)) return read;
            const corroborated = Array.isArray(options.knownIgnEvidence)
                && normalizeIgn(read.ign)?.length >= 4
                && options.knownIgnEvidence.some(item => normalizeIgn(item.ign) === normalizeIgn(read.ign)
                    && item.authorIds?.some(id => String(id) !== String(options.authorId || '')));
            const strongFocused = normalizeIgn(result?.focusedIgn) === normalizeIgn(read.ign)
                && normalizeIgn(read.ign)?.length >= 4
                && (Number(result?.focusedConfidence || 0) >= 0.89
                    || Boolean(result?.cardRect) && Number(result?.focusedConfidence || 0) >= 0.85);
            if (corroborated && read.confidence >= 0.79) return { ...read, confidence: Math.max(read.confidence, 0.87) };
            if (!strongFocused) return { ...read, confidence: Math.min(read.confidence, 0.79) };
            return read;
        })
        .filter(Boolean)
        .sort((a, b) => b.confidence - a.confidence);
    const contentCandidate = candidateFromText(content);
    const ocrCandidate = ocrCandidates[0] || null;
    let candidate = contentCandidate;
    if (!candidate && images && content.split(/\n+/).filter(Boolean).length === 1) {
        const oneLineIgn = cleanIgn(content.replace(/\s+\([^)]{1,80}\)$/, ''));
        if (oneLineIgn && !genericInferredIgn(oneLineIgn) && !isClearlyOffTopicText(content)) {
            const pokemonCaption = matchSpeciesHeading(content);
            const screenshotAgrees = normalizeIgn(ocrCandidate?.ign) === normalizeIgn(oneLineIgn)
                && Number(ocrCandidate?.confidence || 0) >= 0.85;
            const otherScoutAgrees = options.knownIgnEvidence?.some(item =>
                normalizeIgn(item.ign) === normalizeIgn(oneLineIgn)
                && item.authorIds?.some(id => String(id) !== String(options.authorId || '')));
            candidate = pokemonCaption?.species && pokemonCaption.end === content.length
                && ocrCandidate?.confidence >= 0.85
                ? ocrCandidate
                : { ign: oneLineIgn, confidence: screenshotAgrees ? 0.92 : otherScoutAgrees ? 0.86 : 0.74,
                    source: 'image_message_line' };
        }
    }
    if (!candidate) candidate = ocrCandidate;
    const screenshotCandidate = ocrCandidate && ocrCandidate.confidence >= 0.85
        && ['labelled_ocr', 'inspect_profile_ocr', 'result_card_ocr', 'result_outcome_ocr', 'battle_header_ocr'].includes(ocrCandidate.source)
        ? ocrCandidate : null;
    let resolvedImageDifference = false;
    // Match scores sometimes precede the actual IGN on the next line. Accept
    // that second line only when the screenshot independently names it.
    const firstTwoLines = content.split(/\n+/u).map(line => line.trim()).filter(Boolean).slice(0, 2);
    if (contentCandidate?.source === 'first_line' && /^\d{1,2}\s*[-:]\s*\d{1,2}$/u.test(firstTwoLines[0] || '')
        && normalizeIgn(cleanIgn(firstTwoLines[1])) === normalizeIgn(screenshotCandidate?.ign)) {
        candidate = screenshotCandidate;
        resolvedImageDifference = true;
    }
    if (contentCandidate && screenshotCandidate
        && normalizeIgn(contentCandidate.ign) !== normalizeIgn(screenshotCandidate.ign)
        && !resolvedImageDifference) {
        const typedSupport = establishedNameSupport(contentCandidate.ign, options.knownIgnEvidence);
        const imageSupport = establishedNameSupport(screenshotCandidate.ign, options.knownIgnEvidence);
        const zeroOrLetter = sameNameWithOcrZeros(contentCandidate.ign, screenshotCandidate.ign);
        const numericSuffix = numericSuffixVariation(contentCandidate.ign, screenshotCandidate.ign);
        const close = closeIgnSpelling(contentCandidate.ign, screenshotCandidate.ign);
        const imageRead = results.some(result => normalizeIgn(result?.focusedIgn) === normalizeIgn(screenshotCandidate.ign)
            && Number(result?.focusedConfidence || 0) >= 0.93);
        // A name in the history table behind the card is not evidence about
        // the active opponent; only the OCR of the isolated card counts here.
        const typedRead = results.some(result => result?.cardRect
            && nameAppearsInOcr(result.text, contentCandidate.ign));
        if (typedRead || (close || zeroOrLetter) && typedSupport >= 2 && imageSupport < 2) {
            // The name also appears elsewhere in the image, or independent scouts
            // already know the typed spelling. Keep it over a conflicting OCR read.
            candidate = contentCandidate;
            resolvedImageDifference = true;
        } else if ((close || zeroOrLetter
            || screenshotCandidate.source === 'battle_header_ocr'
                && relatedIgnShape(contentCandidate.ign, screenshotCandidate.ign))
            && imageSupport >= 2 && typedSupport < 2) {
            candidate = { ...screenshotCandidate, confidence: Math.max(0.9, screenshotCandidate.confidence) };
            resolvedImageDifference = true;
        } else if (numericSuffix && imageSupport >= 2 && typedSupport < 2) {
            candidate = { ...screenshotCandidate, confidence: Math.max(0.9, screenshotCandidate.confidence) };
            resolvedImageDifference = true;
        } else if (zeroOrLetter) {
            // 0/O is often indistinguishable in small game text; the member's
            // spelling is more useful for an IGN search than OCR's guess.
            candidate = contentCandidate;
            resolvedImageDifference = true;
        } else if (close && normalizeIgn(contentCandidate.ign)?.length >= 6
            && (imageRead || screenshotCandidate.source === 'inspect_profile_ocr'
                && screenshotCandidate.confidence >= 0.94)) {
            candidate = screenshotCandidate;
            resolvedImageDifference = true;
        }
    }
    const structuredText = splitScoutText(content, contentCandidate?.ign || candidate?.ign);
    // A complete typed scout is better spelling evidence than one weak image
    // read. Keep real conflicts, strong image reads and established names in review.
    if (!resolvedImageDifference && contentCandidate && screenshotCandidate
        && contentCandidate.confidence >= 0.86 && screenshotCandidate.confidence < 0.9
        && normalizeIgn(contentCandidate.ign)?.length >= 8
        && closeIgnSpelling(contentCandidate.ign, screenshotCandidate.ign)
        && (structuredText.teamText?.split('\n').filter(Boolean).length || 0) >= 4
        && establishedNameSupport(screenshotCandidate.ign, options.knownIgnEvidence) < 2
        && !results.some(result => normalizeIgn(result.focusedIgn) === normalizeIgn(screenshotCandidate.ign)
            && Number(result.focusedConfidence || 0) >= 0.9)) {
        candidate = contentCandidate;
        resolvedImageDifference = true;
    }
    if (!images && contentCandidate?.source === 'versus_text') {
        const explicitTeamRows = content.split(/\n+/u).map(line => line.trim()).filter(Boolean).filter(line => {
            if (/^(?:[-•]|\d+[.)])\s*\S/u.test(line)) return true;
            const species = matchSpeciesHeading(line, { allowTypo: true, allowBroadAlias: true });
            return Boolean(species?.species && (/[,:(]/u.test(line.slice(species.end)) || hasKnownTeamDetail(line)));
        });
        if (explicitTeamRows.length < 2) candidate = null;
    }
    let historicalSuggestion = null;
    if (candidate && !screenshotCandidate && Array.isArray(options.knownIgnEvidence)) {
        const matches = options.knownIgnEvidence.filter(item =>
            normalizeIgn(item.ign) !== normalizeIgn(candidate.ign)
            && (obviousIgnTypo(item.ign, candidate.ign)
                || normalizeIgn(item.ign)?.length >= 10
                    && closeIgnSpelling(item.ign, candidate.ign)
                    && normalizeIgn(ocrCandidate?.ign) === normalizeIgn(item.ign))
            && item.authorIds?.filter(id => id !== options.authorId).length >= 2);
        const establishedCurrent = options.knownIgnEvidence.some(item =>
            normalizeIgn(item.ign) === normalizeIgn(candidate.ign) && item.authorIds?.length >= 2);
        if (!establishedCurrent && matches.length === 1) {
            const species = text => new Set(String(text || '').split('\n')
                .map(line => matchSpeciesHeading(line.replace(/^\s*[-•]\s*/u, ''))?.species)
                .filter(Boolean));
            const currentTeam = species(structuredText.teamText);
            const authors = new Set(matches[0].authorIds || []).size;
            const sharedCount = Math.max(0, ...(matches[0].teamTexts || []).map(text =>
                [...species(text)].filter(name => currentTeam.has(name)).length));
            const knownSpecies = new Set((matches[0].teamTexts || []).flatMap(text => [...species(text)]));
            const sharedAcrossReports = [...currentTeam].filter(name => knownSpecies.has(name)).length;
            const supportedShortTypo = authors >= 3 && sharedCount >= 1
                && Math.min(normalizeIgn(matches[0].ign).length, normalizeIgn(candidate.ign).length) >= 8;
            const supportedAcrossReports = authors >= 2 && sharedAcrossReports >= 2
                && Math.min(normalizeIgn(matches[0].ign).length, normalizeIgn(candidate.ign).length) >= 8;
            const stronglyEstablishedTypo = authors >= 5
                && Math.min(normalizeIgn(matches[0].ign).length, normalizeIgn(candidate.ign).length) >= 8;
            const imageAndHistoryAgree = authors >= 2
                && normalizeIgn(ocrCandidate?.ign) === normalizeIgn(matches[0].ign)
                && closeIgnSpelling(matches[0].ign, candidate.ign);
            if (sharedCount >= 2 || supportedShortTypo || supportedAcrossReports || stronglyEstablishedTypo
                || imageAndHistoryAgree || distinctiveLongIgnTypo(matches[0].ign, candidate.ign)) {
                candidate = { ign: matches[0].ign, confidence: sharedCount >= 2 || supportedAcrossReports ? 0.93 : 0.9,
                    source: 'known_scouts' };
            } else {
                historicalSuggestion = matches[0].ign;
                candidate = { ...candidate, confidence: Math.min(candidate.confidence, 0.79),
                    source: 'possible_ign_typo' };
            }
        } else if (!establishedCurrent && matches.length > 1) {
            candidate = { ...candidate, confidence: Math.min(candidate.confidence, 0.79) };
        }
    }

    if (candidate && reviewLearning?.aliases instanceof Map) {
        const oldName = candidate.ign;
        const oldSupport = establishedNameSupport(oldName, options.knownIgnEvidence);
        const choices = (reviewLearning.aliases.get(normalizeIgn(oldName)) || []).filter(item => {
            const targetSupport = establishedNameSupport(item.to, options.knownIgnEvidence);
            const confusable = closeIgnSpelling(oldName, item.to)
                || sameNameWithOcrZeros(oldName, item.to)
                || relatedIgnShape(oldName, item.to)
                || normalizeIgn(oldName)?.replace(/in|rn/gu, 'm') === normalizeIgn(item.to)?.replace(/in|rn/gu, 'm');
            return oldSupport < 2 && (item.reports >= 2 && item.reviewers >= 2
                || item.reports >= 1 && targetSupport >= 2 && confusable);
        });
        if (choices.length === 1 && (!screenshotCandidate
            || normalizeIgn(screenshotCandidate.ign) === normalizeIgn(oldName)
            || normalizeIgn(screenshotCandidate.ign) === normalizeIgn(choices[0].to))) {
            candidate = { ign: choices[0].to, confidence: 0.92, source: 'staff_review_history' };
            historicalSuggestion = null;
            resolvedImageDifference = true;
        }
    }

    let candidateMatchesAuthor = false;
    if (candidate) {
        const normalizedCandidate = normalizeIgn(candidate.ign);
        candidateMatchesAuthor = authorIgnNames.has(normalizedCandidate);
        if (candidateMatchesAuthor && screenshotCandidate
            && !authorIgnNames.has(normalizeIgn(screenshotCandidate.ign))) {
            candidate = screenshotCandidate;
            resolvedImageDifference = true;
            candidateMatchesAuthor = false;
        } else if (candidateMatchesAuthor) candidate = null;
    }

    // A name heading followed by scout details is common in this channel.
    if (candidate?.source === 'first_line' && (isLikelyScoutText(content)
        || (structuredText.teamText?.split('\n').length || 0) >= 2)) {
        candidate = { ...candidate, confidence: 0.86 };
    }
    const conflictingOcr = ocrCandidates.some(item => item.confidence >= 0.8
        && normalizeIgn(item.ign) !== normalizeIgn(ocrCandidate?.ign));
    const imageAgrees = ocrCandidates.some(item => normalizeIgn(item.ign) === normalizeIgn(candidate?.ign)
        && item.confidence >= 0.85);
    const otherScoutsAgree = ['first_line', 'image_message_line'].includes(candidate?.source)
        && (options.knownIgnEvidence || []).some(item => normalizeIgn(item.ign) === normalizeIgn(candidate.ign)
            && item.authorIds?.filter(id => String(id) !== String(options.authorId || '')).length >= 2)
        && (!ocrCandidate || ocrCandidate.confidence < 0.85
            || closeIgnSpelling(ocrCandidate.ign, candidate.ign));
    if (candidate && candidate.confidence < 0.8 && images && !historicalSuggestion
        && (imageAgrees || otherScoutsAgree) && !conflictingOcr) {
        candidate = { ...candidate, confidence: 0.86 };
    }
    const layout = results.some(result => result?.teamLayoutStatus === 'uncertain') ? 'uncertain'
        : results.some(result => result?.teamLayoutStatus === 'recognized') ? 'recognized' : 'none';
    const learnedStats = candidate && reviewLearning?.sourceStats instanceof Map
        ? reviewLearning.sourceStats.get(reviewPatternKey(candidate.source, images, layout)) : null;
    if (learnedStats && !['staff_review_history', 'known_scouts'].includes(candidate.source)) {
        const wrong = learnedStats.changedIgn + learnedStats.rejected;
        const reviewed = learnedStats.confirmed + wrong;
        const directlySupported = results.some(result =>
            normalizeIgn(result.focusedIgn) === normalizeIgn(candidate.ign)
                && (Number(result.focusedConfidence || 0) >= 0.89
                    || Boolean(result.cardRect) && Number(result.focusedConfidence || 0) >= 0.85)
            || anchoredResultCardName(result, candidate))
            || ['named_report', 'numbered_team_heading', 'leading_ign_team', 'first_line'].includes(candidate.source)
                && candidate.confidence >= 0.86
                && (structuredText.teamText?.split('\n').filter(Boolean).length || 0) >= 2
                && !conflictingOcr && (!screenshotCandidate
                    || normalizeIgn(screenshotCandidate.ign) === normalizeIgn(candidate.ign));
        if (reviewed >= 6 && wrong >= 3 && wrong / reviewed >= 0.4 && candidate.confidence < 0.95
            && !directlySupported) {
            candidate = { ...candidate, confidence: Math.min(candidate.confidence, 0.79) };
        } else if (learnedStats.confirmed >= 5 && wrong === 0
            && candidate.confidence >= 0.77 && candidate.confidence < 0.8
            && (results.some(result => normalizeIgn(result.focusedIgn) === normalizeIgn(candidate.ign)
                && Number(result.focusedConfidence || 0) >= 0.8)
                || (structuredText.teamText?.split('\n').length || 0) >= 2)) {
            candidate = { ...candidate, confidence: 0.82 };
        }
    }

    const rating = extractRating(content, candidate?.ign || null)
        ?? extractRating(ocrText, candidate?.ign || null, { fromOcr: true });
    const likelyText = isLikelyScoutText(content);
    const previewTeam = teamFromPreview(ocrText);
    const reviewReasons = [];
    const multipleOpponents = namesSeveralOpponents(content)
        && !(contentCandidate && ocrCandidate && closeIgnSpelling(contentCandidate.ign, ocrCandidate.ign));
    const namedOcr = ocrCandidate?.confidence >= 0.85
        && ['labelled_ocr', 'inspect_profile_ocr', 'result_card_ocr', 'result_outcome_ocr', 'battle_header_ocr'].includes(ocrCandidate?.source);
    const offTopicImage = images && isClearlyOffTopicText(content) && !ocrCandidate;
    const textLines = content.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const teamRowCount = structuredText.teamText?.split('\n').filter(Boolean).length || 0;
    const rosterFormatting = textLines.length >= 2
        || /(?:^|\n)\s*(?:team|pok[eé]mon|opponent)\s*:/iu.test(content)
        || /(?:^|\n)\s*(?:[-•]|\d+[.)])\s*\S/iu.test(content)
        || teamRowCount >= 2 && hasKnownTeamDetail(content);
    const substantialUnnamedTeam = teamRowCount >= 2 && rosterFormatting;
    const onePokemonScoutDetail = Boolean(structuredText.teamText
        && structuredText.teamText.split('\n').filter(Boolean).length === 1
        && hasKnownTeamDetail(content)
        && /(?:^|\n)\s*(?:[-•]|\d+[.)]|[\p{L}\p{N}_.-]{2,35}\s*[:(])/u.test(content));
    const explicitScoutMarker = /\b(?:ranked\s+opponent\s+found|team\s*preview|teampreview)\b/iu.test(content)
        || /(?:^|\n)\s*(?:opponent(?:'s)?(?:\s+ign)?|ign)\s*[:=]/iu.test(content);
    const missingNameScoutText = !images && !candidate && !isClearlyOffTopicText(content)
        && (explicitScoutMarker || substantialUnnamedTeam || onePokemonScoutDetail);

    let classification = 'ignored';
    if (candidate && (images || likelyText || content.length > candidate.ign.length)) {
        classification = 'scout';
    } else if ((images && !offTopicImage) || missingNameScoutText || namedOcr || candidateMatchesAuthor) {
        classification = 'review';
    }
    if (multipleOpponents) {
        candidate = null;
        classification = 'review';
        reviewReasons.push('This message names multiple opponents; review each scout separately.');
    }

    if (classification !== 'ignored') {
        // Only ask staff to check an uncertain opponent. The full image stays visible in /scout.
        if (candidateMatchesAuthor) {
            reviewReasons.push('The detected IGN matches the scout author’s server name; verify the opponent from the screenshot.');
        }
        if (candidate && candidate.confidence < 0.8) {
            reviewReasons.push(historicalSuggestion
                ? `Similar confirmed IGN exists; check the spelling.\n- Plain text IGN: ${candidate.ign}\n- Existing IGN: ${historicalSuggestion}`
                : candidate.source === 'matchmaking_status_heading'
                    ? 'Matchmaking status names a possible opponent; confirm it belongs with the following scout details.'
                    : 'Opponent IGN was inferred from an unlabeled line.');
        }
        if (candidate && namedOcr
            && !closeIgnSpelling(candidate.ign, ocrCandidate.ign)
            && !sameNameWithOcrZeros(candidate.ign, ocrCandidate.ign)
            && !resolvedImageDifference
            && !screenshotNamesOpponent(ocrText, candidate.ign)) {
            reviewReasons.push(`Message text and screenshot identify different opponents.\n- Plain text IGN: ${contentCandidate?.ign || 'Not detected'}\n- Screenshot IGN: ${ocrCandidate.ign}`);
        }
        if (contentCandidate && namedOcr && normalizeIgn(contentCandidate.ign)?.length >= 6
            && normalizeIgn(contentCandidate.ign) !== normalizeIgn(ocrCandidate.ign)
            && closeIgnSpelling(contentCandidate.ign, ocrCandidate.ign) && !resolvedImageDifference) {
            const trustedRead = results.some(result => result?.focusedIgn
                && (normalizeIgn(result.focusedIgn) === normalizeIgn(contentCandidate.ign)
                    && Number(result.focusedConfidence || 0) >= 0.9
                    || normalizeIgn(result.focusedIgn) === normalizeIgn(ocrCandidate.ign)
                    && Number(result.focusedConfidence || 0) >= 0.95));
            if (!trustedRead && ocrCandidate.source !== 'inspect_profile_ocr') {
                reviewReasons.push(`Message and screenshot spell the IGN slightly differently; verify the image before choosing a spelling.\n- Plain text IGN: ${contentCandidate.ign}\n- Screenshot OCR: ${ocrCandidate.ign}`);
            }
        }
        if (contentCandidate && normalizeIgn(contentCandidate.ign)?.length < 6
            && results.some(result => Number(result?.focusedConfidence || 0) >= 0.95
                && normalizeIgn(result.focusedIgn) !== normalizeIgn(contentCandidate.ign)
                && closeIgnSpelling(result.focusedIgn, contentCandidate.ign))) {
            reviewReasons.push('Short IGN differs by one character between the message and repeated image reads; confirm the spelling.');
        }
        if (conflictingOcr) reviewReasons.push('Screenshots identify different opponents.');
        if (!candidate) {
            reviewReasons.push(images
                ? 'Could not identify the opponent IGN in the message or screenshot.'
                : 'Message looks like scouting information but the opponent IGN is unclear.');
        }
        if (structuredText.uncertainNames.length) {
            reviewReasons.push(`Check Pokémon spelling: ${structuredText.uncertainNames.slice(0, 3).join(', ')}.`);
        }
        if (candidate?.source === 'matchmaking_status_heading'
            && structuredText.notes?.split('\n').some(line => {
                const detail = withoutMatchmakingStatus(line) ?? line;
                return detail && (mentionedSpeciesCount(detail) > 0 || isLikelyScoutText(detail));
            })) {
            reviewReasons.push('Some Pokémon details could not be assigned to a team member; check the original message.');
        }
        if (!structuredText.teamText && previewTeam.uncertainNames.length) {
            reviewReasons.push(`Team preview contains unclear Pokémon: ${previewTeam.uncertainNames.slice(0, 3).join(', ')}.`);
        }
    }

    const teamText = mergePreviewTeam(structuredText.teamText, previewTeam.teamText);
    const notes = structuredText.notes?.split('\n')
        .map(line => withoutMatchmakingStatus(line) ?? line)
        .filter(Boolean).join('\n') || null;

    const parsed = {
        classification,
        ign: candidate?.ign || null,
        ignNormalized: normalizeIgn(candidate?.ign),
        ignConfidence: candidate?.confidence || 0,
        ignSource: multipleOpponents ? 'multiple_opponents' : candidate?.source || null,
        rating,
        notes,
        teamText,
        ocrText: ocrText || null,
        reviewStatus: classification === 'review' || reviewReasons.length ? 'pending' : 'not_required',
        reviewReason: reviewReasons.length ? [...new Set(reviewReasons)].join(' ') : null,
        hasImages: images
    };
    if (!images && reviewLearning) {
        const key = reviewedTextKey(content);
        if (reviewLearning.rejectedText?.has(key)) {
            return { ...parsed, classification: 'ignored', ign: null, ignNormalized: null,
                ignConfidence: 0, ignSource: 'staff_review_history', rating: null,
                teamText: null, notes: null, reviewStatus: 'not_required', reviewReason: null };
        }
        const correction = reviewLearning.exactCorrections?.get(key);
        if (correction?.ign) {
            return { ...parsed, classification: 'scout', ign: correction.ign,
                ignNormalized: normalizeIgn(correction.ign), ignConfidence: 0.94,
                ignSource: 'staff_review_history', rating: correction.rating,
                teamText: correction.teamText, notes: correction.notes,
                reviewStatus: 'not_required', reviewReason: null };
        }
    }
    return parsed;
}

module.exports = {
    IGN_DISPLAY_NAMES,
    canonicalIgn,
    candidateFromOcr,
    candidateFromText,
    cleanIgn,
    closeIgnSpelling,
    extractRating,
    extractScoutData,
    hasImageEvidence,
    isClearlyOffTopicText,
    isClearlySpamTeam,
    isLikelyScoutText,
    nameFromResultLine,
    normalizeIgn,
    obviousIgnTypo,
    opponentFromBattleBanner,
    splitScoutText
};
