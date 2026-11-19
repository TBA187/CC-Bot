// Define the game-event notifications available to the guild and its members.
const NOTIFICATION_DEFINITIONS = [
    {
        key: 'alto_mare',
        name: 'Alto Mare Race',
        description: 'Only active during Summer Event. Pings 15 mins before each race starts (every 6 hours)',
        informationUrl: 'https://www.youtube.com/watch?v=mYnlLlJ_buI',
        createdAt: '2026-08-18T00:31:23.000Z'
    },
    {
        key: 'bug_catching_contest',
        contestKey: 'BCC',
        name: 'BCC (Bug Catching Contest)',
        description: '',
        informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Bug_Catching_Contest_(Multiplayer)',
        createdAt: '2026-08-18T00:30:22.000Z'
    },
    {
        key: 'fish_catching_contest',
        contestKey: 'FCC',
        name: 'FCC (Fish Catching Contest)',
        description: '',
        informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Corsica_Island#Fishing_Contest',
        createdAt: '2026-08-18T00:30:21.000Z'
    }
];

module.exports = {
    NOTIFICATION_DEFINITIONS
};
