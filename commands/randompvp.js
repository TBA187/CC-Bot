// Show every Random PvP set for one to six Pokémon separated by commas or spaces.
'use strict';

const { SlashCommandBuilder, MessageFlags, escapeMarkdown } = require('discord.js');
const { MAX_POKEMON, defaultCatalog } = require('../features/random-pvp/RandomPvpSets.js');
const { buildSetMessages, needsTopLink } = require('../features/random-pvp/RandomPvpPresentation.js');
const { RandomPvpEmojis } = require('../features/random-pvp/RandomPvpEmojis.js');
const { canUseGuildSettings } = require('../features/pvp-scouting/ScoutServerSettings.js');

const OPTION_NAME = 'pokemon';
const NO_PERMISSION = '### ❌  No permission!\n- `/randompvp` is only available to Crow Control guild members.';
const MAX_SHOWN_NAME = 40;
const MAX_SHOWN_MATCHES = 5;

const NO_POKEMON = '### ❌  No Pokémon entered.\n- Enter 1 to 6 Pokémon separated by commas or spaces, for example `Absol, Garchomp`.';
const tooMany = count => `### ❌  Too many Pokémon.\n- Enter up to ${MAX_POKEMON} Pokémon. Your list has ${count}.`;
const typed = name => `**${escapeMarkdown(name.length > MAX_SHOWN_NAME ? `${name.slice(0, MAX_SHOWN_NAME - 1)}…` : name)}**`;

function nameProblems(unknown, ambiguous) {
    const lines = ['### ❌  Check the Pokémon names.'];
    if (unknown.length) {
        lines.push(`- ${unknown.map(typed).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the Random PvP set list.`);
    }
    for (const { text, names } of ambiguous) {
        const shown = names.slice(0, MAX_SHOWN_MATCHES).map(name => escapeMarkdown(name));
        const more = names.length - shown.length;
        lines.push(`- ${typed(text)} matches ${shown.join(', ')}${more ? ` and ${more} more` : ''}. Type more of the name.`);
    }
    lines.push('- Pick names from the suggestions and separate them with commas.');
    return lines.join('\n');
}

class RandomPvp {
    constructor(config = {}) {
        this.name = 'randompvp';
        this.config = config;
        this.catalog = config.randomPvpCatalog || defaultCatalog();
        this.emojis = config.randomPvpEmojis || new RandomPvpEmojis();
        this.data = new SlashCommandBuilder()
            .setName('randompvp')
            .setDescription('Show Random PvP sets for up to 6 Pokémon')
            .addStringOption(option => option
                .setName(OPTION_NAME)
                .setDescription('Enter 1 to 6 Pokémon separated by spaces or commas, for example: absol, char x, chomp, mega ttar')
                .setRequired(true)
                .setAutocomplete(true));
    }

    // Same audience as /scout: the guild member role or a staff role in the Crow Control server, or Discord
    // Administrator permission.
    canUse(interaction) {
        return canUseGuildSettings(interaction, this.config);
    }

    async handleAutocomplete(interaction) {
        if (!this.canUse(interaction)) return interaction.respond([]);
        const focused = interaction.options.getFocused(true);
        await interaction.respond(focused.name === OPTION_NAME ? this.catalog.suggest(focused.value) : []);
        // Typing a lookup loads the Pokémon emojis in the background, so the cards have them when it is sent.
        this.emojis.refresh(interaction.client);
    }

    async execute(interaction) {
        const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        if (!this.canUse(interaction)) return reply(NO_PERMISSION);
        const { entries, unknown, ambiguous, count } = this.catalog.resolveList(interaction.options.getString(OPTION_NAME, true));
        if (!count) return reply(NO_POKEMON);
        if (count > MAX_POKEMON) return reply(tooMany(count));
        if (unknown.length || ambiguous.length) return reply(nameProblems(unknown, ambiguous));

        this.emojis.refresh(interaction.client);
        const setCount = this.catalog.setCount;
        const icon = name => this.emojis.icon(name);
        const privately = payload => ({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
        const messages = buildSetMessages(entries, setCount, { icon });
        if (!needsTopLink(messages)) return interaction.reply(privately(messages[0]));

        // The Go to Top button needs the first message's ID, which exists only after it is sent.
        const response = await interaction.reply({ ...privately(messages[0]), withResponse: true });
        const firstId = response?.resource?.message?.id;
        const topUrl = firstId && `https://discord.com/channels/${interaction.guildId ?? '@me'}/${interaction.channelId}/${firstId}`;
        const linked = firstId ? buildSetMessages(entries, setCount, { icon, topUrl }) : messages;
        for (const payload of linked.slice(1)) await interaction.followUp(privately(payload));
        if (firstId && linked.length === 1) {
            // The sets are already shown, so a failed edit only leaves the button out.
            await interaction.editReply({ components: linked[0].components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } })
                .catch(error => console.warn(`[CC LOG] /randompvp could not add the Go to Top button: ${error.message}`));
        }
    }
}

module.exports = RandomPvp;
