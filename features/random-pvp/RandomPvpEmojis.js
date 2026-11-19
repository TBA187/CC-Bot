// Finds the bot's own emoji for each Pokémon on the /randompvp cards. The emojis belong to the bot application
// and are named with emojiName, for example "charizard_mega_x".
'use strict';

const REFRESH_MS = 10 * 60_000;

// Discord emoji names allow 2 to 32 letters, digits and underscores. Apostrophes are dropped, so Farfetch’d
// is "farfetchd", and a name that would be too long leaves out its closing parenthesis, so
// "Tauros Paldean - Blaze Breed (Fighting/Fire)" is "tauros_paldean_blaze_breed".
function emojiName(name) {
    const slug = text => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const full = slug(String(name));
    return (full.length > 32 ? slug(String(name).replace(/\s*\([^)]*\)$/, '')) : full).slice(0, 32);
}

class RandomPvpEmojis {
    constructor({ clock = Date.now, consoleObject = console } = {}) {
        this.clock = clock;
        this.console = consoleObject;
        this.byName = new Map();
        this.checkedAt = null;
        this.loading = null;
        this.failing = false;
    }

    // Starts a background load at most every ten minutes, so newly uploaded emojis appear without a restart.
    // Replies never wait for it: autocomplete normally loads the emojis before a lookup is submitted.
    refresh(client) {
        if (this.loading || (this.checkedAt !== null && this.clock() - this.checkedAt < REFRESH_MS)) return this.loading;
        const emojis = client?.application?.emojis;
        if (!emojis) return null;
        this.loading = emojis.fetch()
            .then(collection => {
                this.byName = new Map([...collection.values()].map(emoji => [emoji.name, emoji.toString()]));
                if (this.failing) this.console.log(`[CC LOG] /randompvp loaded ${this.byName.size} Pokémon emojis again.`);
                this.failing = false;
            })
            .catch(error => {
                if (!this.failing) this.console.warn(`[CC LOG] /randompvp could not load the Pokémon emojis: ${error.message}`);
                this.failing = true;
            })
            .finally(() => {
                this.checkedAt = this.clock();
                this.loading = null;
            });
        return this.loading;
    }

    icon(name) {
        return this.byName.get(emojiName(name)) || null;
    }
}

module.exports = {
    RandomPvpEmojis,
    emojiName
};
