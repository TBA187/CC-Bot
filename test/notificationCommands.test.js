const test = require('node:test');
const assert = require('node:assert/strict');

const Admin = require('../commands/admin.js');
const Notifications = require('../commands/notifications.js');
const { subscriptionsEmbed } = require('../commands/notifications.js');
const { notificationStatusEmbed } = require('../commands/admin.js');

function states() {
    return [
        {
            key: 'alto_mare',
            name: 'Alto Mare Race',
            description: 'Summer Event Exclusive',
            informationUrl: 'https://www.youtube.com/watch?v=mYnlLlJ_buI',
            enabled: false
        },
        {
            key: 'bug_catching_contest',
            contestKey: 'BCC',
            name: 'Saturday Bug Catching Contest',
            description: '',
            informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Bug_Catching_Contest_(Multiplayer)',
            enabled: true
        },
        {
            key: 'fish_catching_contest',
            contestKey: 'FCC',
            name: 'Saturday Fish Catching Contest',
            description: '',
            informationUrl: 'https://wiki.pokemonrevolution.net/index.php?title=Corsica_Island#Fishing_Contest',
            enabled: false
        }
    ];
}

function makeStore() {
    const store = {
        definitionsByKey: new Map(states().map(state => [state.key, state])),
        savedGuildStatus: null,
        savedUserSubscriptions: null,
        listNotificationStates: () => states(),
        getUserSubscriptionKeys: () => ['fish_catching_contest']
    };

    store.setGuildNotificationEnabled = async (key, enabled) => {
        store.savedGuildStatus = { key, enabled };
        return { enabled };
    };
    store.setUserSubscriptions = async (userId, keys) => {
        store.savedUserSubscriptions = { userId, keys };
    };

    return store;
}

test('/admin notifications registers searchable notification and status fields', () => {
    const store = makeStore();
    const command = new Admin({ adminRoleID: 'admin-role', notificationStore: store });
    const data = command.data.toJSON();
    const options = data.options[0].options;

    assert.equal(data.name, 'admin');
    assert.equal(options[0].name, 'notification');
    assert.equal(options[0].autocomplete, true);
    assert.equal(options[1].description, 'Enable or Disable this Guild Notification');
    assert.deepEqual(options[1].choices.map(choice => ({ name: choice.name, value: choice.value })), [
        { name: 'Enable', value: 'enabled' },
        { name: 'Disable', value: 'disabled' }
    ]);
});

test('/admin notifications shows only names and statuses in its summary embed', () => {
    const embed = notificationStatusEmbed(states()).toJSON();

    assert.match(embed.description, /Alto Mare Race.*Disabled ❌/);
    assert.doesNotMatch(embed.description, /Summer Event Exclusive/);
});

test('/notifications shows global disabled state and selects existing subscriptions', async () => {
    const store = makeStore();
    const command = new Notifications({ notificationStore: store });
    let reply = null;

    await command.execute({
        inGuild: () => true,
        user: {
            id: 'user-1',
            username: 'TestUser',
            displayAvatarURL: () => 'https://example.com/avatar.png'
        },
        reply: async payload => {
            reply = payload;
        }
    });

    const embed = reply.embeds[0].toJSON();
    const menu = reply.components[0].components[0].toJSON();
    assert.equal(embed.title, 'Guild Notification Pings for TestUser');
    assert.doesNotMatch(embed.description, /- Status:/);
    assert.match(embed.description, /Disabled by admin ❌/);
    assert.match(embed.description, /Ping Notifications: \*\*Enabled ✅\*\*/);
    assert.match(embed.description, /\[Alto Mare Race\]\(https:\/\/www\.youtube\.com\/watch\?v=mYnlLlJ_buI\)/);
    assert.doesNotMatch(embed.description, /Next Race:/);
    assert.doesNotMatch(embed.description, /The BCC alternates|The FCC alternates/);
    assert.match(embed.description, /BCC and FCC alternates every Saturday/);
    assert.equal(embed.footer.text, 'Crow Control Notifications');
    assert.equal(embed.thumbnail.url, 'https://example.com/avatar.png');
    assert.match(embed.description, /Next BCC: \*\*<t:/);
    assert.equal(menu.options.find(option => option.value === 'fish_catching_contest').default, true);
    assert.equal(menu.options.find(option => option.value === 'alto_mare').default, false);
});

test('/notifications saves all member selections from its own menu', async () => {
    const store = makeStore();
    const command = new Notifications({ notificationStore: store });
    let deferred = false;
    let edited = null;

    const user = {
        id: 'user-1',
        username: 'TestUser',
        displayAvatarURL: () => 'https://example.com/avatar.png'
    };
    const handled = await command.handleSelect({
        customId: 'notifications:subscriptions:user-1:panel-one',
        user,
        values: ['alto_mare'],
        deferUpdate: async () => {
            deferred = true;
        },
        editReply: async payload => {
            edited = payload;
        }
    });

    assert.equal(handled, true);
    assert.equal(deferred, true);
    assert.equal(edited, null);
    assert.equal(store.savedUserSubscriptions, null);

    await command.handleSelect({
        customId: 'notifications:subscriptions:user-1:panel-two',
        user,
        values: ['fish_catching_contest'],
        deferUpdate: async () => {},
        editReply: async () => {}
    });

    const confirmed = await command.handleButton({
        customId: 'notifications:confirm:user-1:panel-one',
        user,
        deferUpdate: async () => {},
        editReply: async () => {}
    });

    assert.equal(confirmed, true);
    assert.deepEqual(store.savedUserSubscriptions, {
        userId: 'user-1',
        keys: ['alto_mare']
    });
});

test('/notifications hides the disabled notice when every guild notification is active', () => {
    const embed = subscriptionsEmbed(
        states().map(state => ({ ...state, enabled: true })),
        [],
        { username: 'TestUser' }
    ).toJSON();

    assert.doesNotMatch(embed.description, /Disabled guild notifications will not ping anyone/);
    assert.match(embed.description, /Next Race: \*\*<t:/);
});
