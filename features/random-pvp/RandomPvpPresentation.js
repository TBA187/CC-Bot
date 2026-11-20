// Builds the /randompvp cards: one Components V2 container per selected Pokémon, split across messages to fit Discord limits.
'use strict';

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize,
    TextDisplayBuilder, escapeMarkdown
} = require('discord.js');
const { CROW_CONTROL_BRANDING_COLOR } = require('../message-builder/draft.js');

const ACCENT_COLOR = Number.parseInt(CROW_CONTROL_BRANDING_COLOR.slice(1), 16);
// Card stripe colors named by the "color" of each set-list Pokémon: the official type colors used by Pokémon HOME
// and Legends: Z-A, except a gunmetal Steel and a deep indigo Dragon that are easier to tell apart from Ice and
// Water, plus Crystal for PRO's crystal forms and the Crow Control color for the Shadow Lugias.
const CARD_COLORS = {
    Normal: 0x9FA19F, Fire: 0xE62829, Water: 0x2980EF, Electric: 0xFAC000, Grass: 0x3FA129, Ice: 0x3FD8FF,
    Fighting: 0xFF8000, Poison: 0x9141CB, Ground: 0x915121, Flying: 0x81B9EF, Psychic: 0xEF4179, Bug: 0x91A119,
    Rock: 0xAFA981, Ghost: 0x704170, Dragon: 0x4A2FB8, Dark: 0x50413F, Steel: 0x6E7B8B, Fairy: 0xEF70EF,
    Crystal: 0xA7D8DE, Shadow: ACCENT_COLOR
};
// CitizenPete compiled the Random PvP set list in randomPvpSets.json; the footer credits him.
const footerText = setCount =>
    `-# <:crow_control:1571743936697860127>  Random PvP Sets: **${setCount.toLocaleString('en-US')}**  **•**  Compiled by **CitizenPete**`;
// Discord allows 4,000 characters of text and 40 components, nested ones included, in one Components V2 message.
const MAX_MESSAGE_TEXT = 4000;
const MAX_MESSAGE_COMPONENTS = 40;
// The footer is counted with the Go to Top button row under its card, so adding the button never changes the split.
const FOOTER_COMPONENTS = 4;
// Every card leaves room for the footer, so the last card never has to move to another message.
const CARD_TEXT = MAX_MESSAGE_TEXT - 150;
const CARD_COMPONENTS = MAX_MESSAGE_COMPONENTS - FOOTER_COMPONENTS;
// Lookups taller than about one screen of text get a Go to Top button.
const LONG_LOOKUP_LINES = 30;

const text = value => escapeMarkdown(String(value));

function speedText(set) {
    if (set.megaSpeed === undefined || set.megaSpeed === set.speed) return String(set.speed);
    return `${set.speed} → ${set.megaSpeed}`;
}

function setText(set, icon) {
    const emoji = icon(set.item);
    return `**Lv ${set.level} · Speed ${speedText(set)} · ${text(set.ability)} · ${text(set.item)}${emoji ? ` ${emoji}` : ''}**\n` +
        set.moves.map(text).join(', ');
}

// A "Go to Top" button is added to the last message of a multi-message lookup.
function topButtonRow(topUrl) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(topUrl).setLabel('Go to Top').setEmoji('⬆️'));
}

// Variants follow the default sets under their own name, set off by a wide divider, and a thin divider separates
// the footer. A Pokémon too long for one message, such as Arceus with all its types, continues in another card
// that starts with the next variant's name. When the bot has the emojis, each name starts with its Pokémon emoji
// and each item is followed by its item emoji. Every card has the color of the Pokémon it is for, so variants on
// their default Pokémon's card share its color, while a variant looked up alone shows its own.
function entryCards(entry, setCount, icon) {
    const accentColor = CARD_COLORS[entry.color] ?? ACCENT_COLOR;
    const sections = [];
    if (entry.sets.length) sections.push({ name: entry.name, sets: entry.sets });
    for (const form of entry.forms) sections.push({ name: form.name, sets: form.sets });

    const cards = [];
    let card = null;
    for (const section of sections) {
        const emoji = icon(section.name);
        const content = `## ${emoji ? `${emoji} ` : ''}${text(section.name)}\n${section.sets.map(set => setText(set, icon)).join('\n\n')}`;
        if (!card || card.length + content.length > CARD_TEXT || card.components + 2 > CARD_COMPONENTS) {
            card = { container: new ContainerBuilder().setAccentColor(accentColor), length: 0, components: 1 };
            cards.push(card);
        } else {
            card.container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large));
            card.components++;
        }
        card.container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
        card.length += content.length;
        card.components++;
    }
    if (setCount !== null) {
        card.container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        card.container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerText(setCount)));
        card.length += footerText(setCount).length;
        card.components += FOOTER_COMPONENTS;
    }
    return cards;
}

// Returns message payloads in display order. Only the last card carries the footer; with topUrl, a Go to Top
// button that jumps to that message follows the last card. icon(name) returns a Pokémon's or item's emoji, or null.
function buildSetMessages(entries, setCount, { topUrl = null, icon = () => null } = {}) {
    const messages = [];
    let current = null;
    entries.forEach((entry, index) => {
        for (const card of entryCards(entry, index === entries.length - 1 ? setCount : null, icon)) {
            if (!current || current.length + card.length > MAX_MESSAGE_TEXT
                || current.components + card.components > MAX_MESSAGE_COMPONENTS) {
                current = { containers: [], length: 0, components: 0 };
                messages.push(current);
            }
            current.containers.push(card.container);
            current.length += card.length;
            current.components += card.components;
        }
    });
    return messages.map((message, index) => ({
        components: topUrl && index === messages.length - 1 ? [...message.containers, topButtonRow(topUrl)] : message.containers,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
    }));
}

// A lookup split over several messages, or one taller than about a screen, gets a Go to Top button.
function needsTopLink(messages) {
    if (messages.length > 1) return true;
    const lines = messages.flatMap(message => message.components)
        .flatMap(container => container.toJSON().components)
        .reduce((total, item) => total + (item.content ? item.content.split('\n').length : 0), 0);
    return lines >= LONG_LOOKUP_LINES;
}

module.exports = {
    CARD_COLORS,
    buildSetMessages,
    footerText,
    needsTopLink
};
