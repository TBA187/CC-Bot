// Verifies auction message layouts, persistent controls, and duplicate delivery recovery.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, ButtonInteraction, Collection, ChannelType, ComponentType, MessageFlags, MessageFlagsBitField, embedLength } = require('discord.js');
const { AuctionDiscordNotifier, buildAuctionPayload, handleAuctionButton, privatePage,
    followConfirmation, buildBidNotificationPayload } = require('../features/auctions/AuctionDiscord.js');

function sample(overrides = {}) {
    return { id: '14702', url: 'https://pokemonrevolution.net/forum/trade/14702/', title: 'Teddiursa',
        server: 'Silver', status: 'Active', tags: ['Pokemon', 'Auction'], seller: { name: 'Seller', url: 'https://pokemonrevolution.net/forum/profile/1-seller/' },
        startPrice: '500.000', instantPrice: null, minimumBid: '50.000', currentOffer: null,
        highestBidder: null, timeLeft: 'Countdown starts with the first qualifying bid.',
        auctionDuration: '45 hours after auction start', description: 'Coin Capsule = 500.000',
        imageUrls: ['https://example.com/1.png', 'https://example.com/2.png'], bids: [], ...overrides };
}

test('auction embed includes requested details and private image control', () => {
    const payload = buildAuctionPayload(sample());
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.url, 'https://pokemonrevolution.net/forum/trade/14702/');
    assert.doesNotMatch(embed.description, /Auction link/i);
    assert.match(embed.description, /\*\*Duration:\*\* 45 hours after auction start/);
    assert.match(embed.description, /- Countdown starts with the first qualifying bid/);
    assert.match(embed.description, /\*\*Tags:\*\* Pokemon · Auction/);
    assert.deepEqual(embed.fields.slice(0, 7).map(field => field.name), ['Server', 'Seller', 'Status', 'Instant price', 'Start price', 'Minimum bid', 'Current offer']);
    assert.ok(embed.fields.slice(0, 6).every(field => field.inline));
    assert.equal(embed.fields[6].inline, false);
    assert.equal(embed.fields[0].value, '<:silver:1555743603567886478> Silver');
    assert.equal(embed.footer.text, 'PRO Auctions • Last updated:');
    assert.equal(embed.footer.icon_url, undefined);
    assert.ok(Number.isFinite(Date.parse(embed.timestamp)));
    assert.equal(payload.files, undefined);
    assert.equal(embed.image.url, 'https://example.com/1.png');
    assert.deepEqual(embed.fields.at(-1), { name: '\u2002',
        value: '-# **2** attached images. Click 🖼️ **More Images** to view all.', inline: false });
    assert.equal(embed.fields.find(field => field.name === 'Instant price').value, '*None*');
    assert.equal(embed.fields.find(field => field.name === 'Current offer').value, '*None*');
    assert.equal(embed.fields.find(field => field.name === 'Bid history (0)').value, '*No bids yet..*');
    assert.match(embed.fields.find(field => field.name === 'Description').value, /Coin Capsule/);
    const components = payload.components[0].toJSON().components;
    assert.deepEqual(components.map(item => item.label), ['View Auction', 'Follow', 'More Images']);
    assert.equal(components[1].style, 3);
    assert.equal(components[2].style, 1);
    assert.equal(components[0].url, sample().url);
    assert.equal(components[1].custom_id, 'auction:follow:14702:0');
    assert.equal(components[2].custom_id, 'auction:images:14702:0');
    assert.deepEqual(payload.allowedMentions, { parse: [], roles: [] });
    assert.ok(embedLength(embed) <= 6000);
    assert.equal(embed.color, 0x57F287);
    const instant = buildAuctionPayload(sample({ status: 'Instant Price' })).embeds[0].toJSON();
    assert.equal(instant.color, 0x57F287);
    assert.equal(instant.fields.find(field => field.name === 'Status').value, 'Active · Instant Price');
});

test('server tags are excluded and active and ended dates use Discord timestamps', () => {
    for (const [name, emoji] of [['Gold', '<:gold:1555743525759356948>'], ['Silver', '<:silver:1555743603567886478>'], ['Cross-Server', '🔗']]) {
        const embed = buildAuctionPayload(sample({ server: name, tags: [name, 'Pokemon', 'Shiny'], endsAt: '2026-11-03T14:09:03.000Z', timeLeft: null })).embeds[0].toJSON();
        assert.match(embed.fields[0].value, new RegExp(`^${emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(embed.description, /\*\*Tags:\*\* Pokemon · Shiny/);
        assert.doesNotMatch(embed.description, new RegExp(name, 'i'));
        assert.match(embed.description, /Auction ends:\*\* <t:1793714943:R> \(<t:1793714943:F>\)/);
    }
    const ended = buildAuctionPayload(sample({ status: 'Ended', endedAt: '2026-10-23T10:22:00.000Z', endPrice: '200.000' })).embeds[0].toJSON();
    assert.match(ended.description, /Auction ended:\*\* <t:1792750920:R> \(<t:1792750920:F>\)/);
    assert.equal(ended.fields[6].name, 'Buyer');
    assert.equal(ended.fields[6].value, '**200.000** · Buyer unavailable');
    assert.ok(!ended.fields.some(field => field.name === 'Current offer'));
    const unavailable = buildAuctionPayload(sample({ status: 'Ended', endedAt: null })).embeds[0].toJSON();
    assert.match(unavailable.description, /Auction ended:\*\* \*Time unavailable\*/);
    for (const status of ['Canceled', 'Cancelled']) {
        const canceled = buildAuctionPayload(sample({ status, endedAt: null })).embeds[0].toJSON();
        assert.ok(canceled.description.startsWith('### This auction has been canceled!\n**Tags:**'));
        assert.doesNotMatch(canceled.description, /Auction ended|Time unavailable/);
        assert.equal(canceled.color, 0xED4245);
        assert.equal(canceled.fields.find(field => field.name === 'Status').value, status);
    }
});

test('overflow controls depend on escaped length, not a literal ellipsis', () => {
    const short = buildAuctionPayload(sample({ imageUrls: [], description: 'A short description…', paymentMethods: 'Coins…' }));
    assert.deepEqual(short.components[0].toJSON().components.map(item => item.label), ['View Auction', 'Follow']);
    assert.ok(short.embeds[0].toJSON().fields.every(field => field.name !== '\u2002'));
    const single = buildAuctionPayload(sample({ imageUrls: ['https://example.com/1.png'] }));
    assert.ok(single.embeds[0].toJSON().fields.every(field => field.name !== '\u2002'));
    assert.deepEqual(single.components[0].toJSON().components.map(item => item.label), ['View Auction', 'Follow']);
    const long = buildAuctionPayload(sample({ imageUrls: [], description: '@'.repeat(400), paymentMethods: '@'.repeat(400) }));
    assert.deepEqual(long.components[0].toJSON().components.map(item => item.label), ['View Auction', 'Follow', 'Full Description', 'Payment Details']);
});

test('announcement mentions only the configured role and links the channel', () => {
    const payload = buildAuctionPayload(sample(), { proNotificationRoleID: '1537991574162640906', selfRoleChannelID: '1184121209609269409' });
    assert.match(payload.content, /\[\*\*PRO Trade Zone\*\*\]\(<https:\/\/pokemonrevolution.net\/forum\/trade\/>\)/);
    assert.match(payload.content, /<@&1537991574162640906>/);
    assert.match(payload.content, /<#1184121209609269409>/);
    assert.match(payload.content, /^<@&1537991574162640906> There's a new auction/);
    assert.match(payload.content, /selecting the `@PRO Notifications 🔔` role in <#1184121209609269409>\n/);
    assert.match(payload.content, /Follow.*receive notifications for new bids/);
    assert.doesNotMatch(payload.content, /Coming soon/);
    assert.deepEqual(payload.allowedMentions, { parse: [], roles: ['1537991574162640906'] });
});

test('all auction controls fit Discord rows in the requested order', () => {
    const bids = Array.from({ length: 50 }, (_, i) => ({ bidder: { name: `bidder${i}` }, amount: '100', time: '2026-11-02 10:00:00' }));
    const payload = buildAuctionPayload(sample({ bids, description: '@'.repeat(400), paymentMethods: '@'.repeat(400) }));
    const rows = payload.components.map(row => row.toJSON().components);
    assert.deepEqual(rows.map(row => row.length), [5, 1]);
    assert.deepEqual(rows.flat().map(item => item.label), ['View Auction', 'Follow', 'More Images', 'Bid History', 'Full Description', 'Payment Details']);
    assert.deepEqual(rows.flat().slice(1, 4).map(item => item.style), [3, 1, 1]);
});

test('completed sales and bid labels stay visible', () => {
    const payload = buildAuctionPayload(sample({ status: 'Ended', endPrice: '250.000', buyer: { name: 'Buyer' },
        paymentMethods: 'Coin Capsule = 500.000', bids: [{ bidder: { name: 'Bidder' }, amount: '100.000', time: '2026-11-02', labels: ['Price offer', 'Accepted'], invalid: true }] }));
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.color, 0xED4245);
    assert.equal(embed.fields.find(field => field.name === 'Buyer').value, '**Buyer for 250.000**');
    assert.match(embed.fields.find(field => field.name === 'Accepted payment methods').value, /Coin Capsule/);
    assert.match(embed.fields.find(field => field.name.startsWith('Bid history')).value, /\*Price offer, Accepted, Invalid\*/);
    assert.equal(buildAuctionPayload(sample({ status: 'unknown' })).embeds[0].toJSON().color, 0x747F8D);
});

test('unavailable listings explain that displayed details may be stale', () => {
    const embed = buildAuctionPayload(sample({ status: 'Unavailable', sourceUnavailable: true })).embeds[0].toJSON();
    assert.equal(embed.fields.find(field => field.name === 'Status').value, 'Unavailable');
    assert.match(embed.description, /last known values/);
});

test('active offers and completed auction winners use consistent linked buyer fields', () => {
    const bidder = { name: 'Bidder', url: 'https://pokemonrevolution.net/forum/profile/2-bidder/' };
    const active = buildAuctionPayload(sample({ currentOffer: '250.000', highestBidder: bidder, endsAt: '2026-11-03T14:09:03.000Z' })).embeds[0].toJSON();
    assert.equal(active.fields[6].value, '**250.000 by [Bidder](<https://pokemonrevolution.net/forum/profile/2-bidder/>)**');
    assert.equal(active.fields[6].inline, false);
    const won = buildAuctionPayload(sample({ status: 'Ended', endPrice: '250.000', highestBidder: bidder })).embeds[0].toJSON();
    assert.equal(won.fields[6].value, '**[Bidder](<https://pokemonrevolution.net/forum/profile/2-bidder/>) for 250.000**');
    const accepted = buildAuctionPayload(sample({ status: 'Ended', endPrice: '210.000', buyer: bidder,
        bids: [{ bidder, amount: '210.000', labels: ['Price offer', 'Accepted'] }] })).embeds[0].toJSON();
    assert.equal(accepted.fields[6].value, '**[Bidder](<https://pokemonrevolution.net/forum/profile/2-bidder/>) for 210.000** *(Price offer accepted)*');
    const canceled = buildAuctionPayload(sample({ status: 'Canceled', endPrice: null, highestBidder: bidder })).embeds[0].toJSON();
    assert.equal(canceled.fields[6].value, '*None*');
});

test('long histories, descriptions and images remain reachable on private pages', () => {
    const bids = Array.from({ length: 45 }, (_, i) => ({ bidder: { name: `bidder${i}` }, amount: `${i}000`, time: '2026-11-02 10:00:00' }));
    const auction = sample({ bids, description: '*'.repeat(6000), imageUrls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`) });
    const payload = buildAuctionPayload(auction);
    const embed = payload.embeds[0].toJSON();
    assert.ok(embedLength(embed) <= 6000);
    assert.ok(embed.fields.every(field => field.value.length <= 1024));
    assert.equal(embed.fields.at(-1).value, '-# **11** attached images. Click 🖼️ **More Images** to view all.');
    assert.deepEqual(payload.components[0].toJSON().components.map(item => item.label), ['View Auction', 'Follow', 'More Images', 'Bid History', 'Full Description']);
    assert.match(embed.fields.find(field => field.name.startsWith('Bid history')).value, /-# - Click 📋 \*\*Bid History\*\* to view all auction bids\./);
    const history = [];
    for (let page = 0; page < 2; page++) history.push(privatePage('bids', auction, page).embeds[0].toJSON().description);
    for (let i = 0; i < 45; i++) assert.match(history.join('\n'), new RegExp(`bidder${i}\\b`));
    assert.equal(history[0].split('\n').length, 25);
    assert.equal(history[1].split('\n').length, 20);
    assert.equal(privatePage('images', auction, 1).components[0].toJSON().components
        .find(component => component.type === ComponentType.MediaGallery).items.length, 1);
    for (let page = 0; page < 4; page++) assert.ok(privatePage('description', auction, page).embeds[0].toJSON().description.length <= 4096);
});

test('bid history respects Discord limits without splitting a bid and links to the auction message', () => {
    const bids = Array.from({ length: 30 }, (_, i) => ({ bidder: { name: `bidder${i}${'x'.repeat(80)}`, url: `https://example.com/${'y'.repeat(260)}/${i}` }, amount: '123.000', time: '2026-11-02 10:00:00' }));
    const auction = sample({ bids });
    const jump = 'https://discord.com/channels/123/456/789';
    const pages = [];
    for (let page = 0; page < 10; page++) {
        const payload = privatePage('bids', auction, page, jump);
        const embed = payload.embeds[0].toJSON();
        if (pages.includes(embed.description)) break;
        pages.push(embed.description);
        assert.ok(embed.description.length <= 4096);
        assert.ok(embed.description.split('\n').length <= 25);
        assert.deepEqual(embed.fields[0], { name: 'Auction message', value: `[**Jump to message** ↗️](<${jump}>)`, inline: false });
        assert.match(embed.title, /^Bid history — Page: \d+\/\d+$/);
        assert.match(embed.footer.text, /^PRO Auctions • Last updated: • Page \d+\/\d+$/);
        assert.ok(Number.isFinite(Date.parse(embed.timestamp)));
        const navigation = payload.components[0].toJSON().components;
        assert.deepEqual(navigation.map(item => item.emoji.name), ['⬅️', '➡️']);
    }
    assert.ok(pages.length > 1);
    const lines = pages.flatMap(page => page.split('\n'));
    assert.equal(lines.length, 30);
    for (let i = 0; i < 30; i++) assert.match(lines[i], new RegExp(`bidder${i}x`));
    assert.ok(lines.every(line => line.endsWith('2026-11-02 10:00:00')));
});

test('one-page bid history has no navigation controls or footer page count', () => {
    const payload = privatePage('bids', sample({ bids: [{ bidder: { name: 'Bidder' }, amount: '100', time: 'now' }] }), 0);
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'Bid history — Page: 1/1');
    assert.doesNotMatch(embed.footer.text, / • Page /);
    assert.deepEqual(payload.components, []);
});

test('private image galleries preserve every image in order with ten per page and navigation only when needed', () => {
    const jump = 'https://discord.com/channels/123/456/789';
    for (const count of [0, 1, 2, 9, 10, 11, 20, 21]) {
        const images = Array.from({ length: count }, (_, i) => `https://example.com/${i}.png`);
        const pageCount = Math.max(1, Math.ceil(count / 10));
        const displayed = [];
        for (let page = 0; page < pageCount; page++) {
            const payload = privatePage('images', sample({ imageUrls: images }), page, jump);
            assert.equal(payload.flags, MessageFlags.IsComponentsV2);
            assert.equal(payload.content, null);
            assert.deepEqual(payload.embeds, []);
            assert.deepEqual(payload.attachments, []);
            assert.deepEqual(payload.allowedMentions, { parse: [] });
            assert.equal(payload.files, undefined);
            const container = payload.components[0].toJSON();
            assert.equal(container.type, ComponentType.Container);
            assert.ok(container.components[0].content.startsWith(`## Auction Images (${count})${pageCount > 1 ? ` — Page ${page + 1}/${pageCount}` : ''}\n`));
            if (pageCount > 1) assert.match(container.components[0].content, new RegExp(`Images ${page * 10 + 1}–${Math.min((page + 1) * 10, count)} of ${count}`));
            else assert.doesNotMatch(container.components[0].content, /\nImages \d/);
            const gallery = container.components.find(component => component.type === ComponentType.MediaGallery);
            const navigation = payload.components[1]?.toJSON();
            assert.equal(payload.components.length, pageCount > 1 ? 2 : 1);
            assert.ok(container.components.every(component => component.type !== ComponentType.ActionRow));
            assert.doesNotMatch(JSON.stringify(container), /cc_logo|attachment:\/\//);
            if (count) {
                assert.ok(gallery.items.length >= 1 && gallery.items.length <= 10);
                displayed.push(...gallery.items.map(item => item.media.url));
                assert.equal(gallery.items[0].description, `Teddiursa — Image ${page * 10 + 1}`);
            } else {
                assert.equal(gallery, undefined, 'an empty gallery is invalid in Discord');
                assert.ok(container.components.some(component => /No images available/.test(component.content)));
            }
            const footer = container.components.at(-1);
            assert.equal(container.components.at(-2).content, `**Auction Message: [Jump to message ↗️](<${jump}>)**`);
            assert.equal(footer.type, ComponentType.TextDisplay);
            const footerText = footer.content;
            assert.match(footerText, /^-# PRO Auction Images • Last updated: <t:\d+:f>/);
            if (pageCount > 1) {
                assert.equal(navigation.type, ComponentType.ActionRow);
                assert.deepEqual(navigation.components.map(component => component.emoji.name), ['⬅️', '➡️']);
                assert.deepEqual(navigation.components.map(component => component.disabled), [page === 0, page === pageCount - 1]);
                assert.match(footerText, new RegExp(`Page ${page + 1}/${pageCount}$`));
                assert.equal(navigation.components[0].custom_id, `auction:images:14702:${Math.max(0, page - 1)}`);
                assert.equal(navigation.components[1].custom_id, `auction:images:14702:${Math.min(pageCount - 1, page + 1)}`);
            } else {
                assert.equal(navigation, undefined);
                assert.doesNotMatch(footerText, /Page/);
            }
        }
        assert.deepEqual(displayed, images);
    }
});

test('image pagination clamps stale cursors and excludes invalid URLs before calculating pages', () => {
    const images = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`);
    const auction = sample({ imageUrls: ['javascript:alert(1)', '', 'file:///private.png', ...images, 'https://example.com/' + 'x'.repeat(1800)] });
    for (const [requested, expected] of [[-1, images.slice(0, 10)], [NaN, images.slice(0, 10)], [100, images.slice(10)]]) {
        const container = privatePage('images', auction, requested).components[0].toJSON();
        assert.deepEqual(container.components.find(component => component.type === ComponentType.MediaGallery).items
            .map(item => item.media.url), expected);
    }
    const cleared = privatePage('images', sample({ imageUrls: [] }), 100).components[0].toJSON();
    assert.ok(cleared.components.every(component => component.type !== ComponentType.ActionRow));
});

test('gallery text suppresses imported mentions and refreshes its localized timestamp on each page render', t => {
    let now = Date.parse('2026-11-04T00:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const auction = sample({ title: '@everyone **Rare** Pokemon' });
    const first = privatePage('images', auction, 0).components[0].toJSON();
    assert.doesNotMatch(first.components[0].content, /@everyone/);
    assert.match(first.components[0].content, /\\\*\\\*Rare/);
    assert.match(first.components.at(-1).content, /<t:1793750400:f>/);
    now += 60_000;
    const edited = privatePage('images', auction, 0).components[0].toJSON();
    assert.match(edited.components.at(-1).content, /<t:1793750460:f>/);
});

test('Follow acknowledges privately before persisting and returns an owned Unfollow control', async () => {
    const calls = [];
    const interaction = { customId: 'auction:follow:14702:0', channelId: '123', guildId: '456', user: { id: '789' }, message: { id: '111' },
        async deferReply(payload) { calls.push(['defer', payload]); }, async editReply(payload) { calls.push(['edit', payload]); } };
    const options = { channelId: '123', guildId: '456', followService: { async follow(...args) {
        assert.equal(calls[0][0], 'defer');
        assert.deepEqual(args, ['14702', '789', '111']);
        return { auction: sample(), alreadyFollowing: false };
    } } };
    assert.equal(await handleAuctionButton(interaction, options), true);
    assert.equal(calls[0][1].flags, MessageFlags.Ephemeral);
    assert.equal(calls[1][1].content, followConfirmation(sample()));
    assert.match(calls[1][1].content, /^### 🔔 You're now following .* ✅\n/);
    assert.match(followConfirmation(sample(), true), /^### 🔔 You're already following .* ✅\n/);
    assert.equal(calls[1][1].components[0].toJSON().components[0].custom_id, 'auction:unfollow:14702:789');
    assert.deepEqual(calls[1][1].allowedMentions, { parse: [] });
});

test('subscription controls reject other guilds and another user’s Unfollow button', async () => {
    for (const change of [i => { i.guildId = 'other'; }, i => { i.channelId = 'other'; },
        i => { i.customId = 'auction:unfollow:14702:999'; }]) {
        const replies = [];
        const interaction = { customId: 'auction:follow:14702:0', channelId: '123', guildId: '456', user: { id: '789' },
            async reply(payload) { replies.push(payload); } };
        change(interaction);
        await handleAuctionButton(interaction, { channelId: '123', guildId: '456',
            followService: { follow() { assert.fail('Unauthorized subscription'); }, unfollow() { assert.fail('Unauthorized removal'); } } });
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    }
});

test('ended auctions cannot be followed and owned Unfollow controls remove only their owner', async () => {
    const replies = [], acknowledgements = [];
    const interaction = { customId: 'auction:follow:14702:0', channelId: '123', guildId: '456', user: { id: '789' }, message: { id: '111' },
        async deferReply() { acknowledgements.push('reply'); }, async deferUpdate() { acknowledgements.push('update'); },
        async editReply(payload) { replies.push(payload); } };
    const service = { async follow() { return { ended: true }; }, async unfollow(...args) { assert.deepEqual(args, ['14702', '789']); } };
    await handleAuctionButton(interaction, { channelId: '123', guildId: '456', followService: service });
    assert.match(replies[0].content, /has ended/);
    assert.deepEqual(replies[0].components, []);
    interaction.customId = 'auction:unfollow:14702:789';
    interaction.message = { id: 'private-response', flags: { has: flag => flag === MessageFlags.Ephemeral } };
    await handleAuctionButton(interaction, { channelId: '123', guildId: '456', followService: service });
    assert.deepEqual(acknowledgements, ['reply', 'update']);
    assert.match(replies[1].content, /^\*\*🔕 You're no longer following/);
    const refollow = replies[1].components[0].toJSON().components[0];
    assert.equal(refollow.style, 3);
    assert.equal(refollow.emoji.name, '🔔');
    assert.equal(refollow.custom_id, 'auction:refollow:14702:789');
});

test('server re-follow uses the saved auction message and keeps its controls owned', async () => {
    const replies = [], followed = [], acknowledgements = [];
    const interaction = { customId: 'auction:refollow:14702:789', channelId: '123', guildId: '456', user: { id: '789' },
        message: { id: 'private-response', flags: { has: flag => flag === MessageFlags.Ephemeral } },
        async deferReply() { assert.fail('A private toggle must not create another response'); },
        async deferUpdate() { acknowledgements.push('update'); },
        async editReply(payload) { replies.push(payload); }, async reply(payload) { replies.push(payload); } };
    const options = { channelId: '123', guildId: '456', getAuctionRecord: async () => ({ messageId: '111' }),
        followService: { async follow(...args) { followed.push(args); return { auction: sample() }; } } };
    await handleAuctionButton(interaction, options);
    assert.deepEqual(followed, [['14702', '789', '111']]);
    assert.deepEqual(acknowledgements, ['update']);
    assert.equal(replies[0].components[0].toJSON().components[0].style, 4);
    interaction.user.id = '999';
    await handleAuctionButton(interaction, options);
    assert.equal(followed.length, 1);
    assert.match(replies[1].content, /unavailable/);
});

test('empty bid history says None for terminal statuses and preserves the active empty label', () => {
    for (const status of ['Canceled', 'Cancelled', 'Closed', 'Inactive', 'Ended', 'Sold', 'Completed', 'Expired', 'Unavailable']) {
        const embed = buildAuctionPayload(sample({ status, bids: [] })).embeds[0].toJSON();
        assert.equal(embed.fields.find(field => field.name === 'Bid history (0)').value, '*None*');
    }
    const embed = buildAuctionPayload(sample({ status: 'Active', bids: [] })).embeds[0].toJSON();
    assert.equal(embed.fields.find(field => field.name === 'Bid history (0)').value, '*No bids yet..*');
});

test('bid DMs identify their auction and include linked bidder, price, source time and end time', () => {
    const auction = sample({ title: 'Another auction', endsAt: '2026-11-05T00:00:00Z', currentOffer: '250.000',
        highestBidder: { name: 'Player', url: 'https://pokemonrevolution.net/forum/profile/2-player/' } });
    const jump = 'https://discord.com/channels/123/456/789';
    const payload = buildBidNotificationPayload({ auction, bid: { bidder: auction.highestBidder, amount: '250.000', time: '2026-11-04 00:30:00' } }, null, null, jump);
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title, 'New bid — Another auction');
    assert.equal(embed.url, auction.url);
    assert.equal(embed.thumbnail.url, buildAuctionPayload(auction).embeds[0].toJSON().image.url);
    assert.equal(embed.image, undefined);
    assert.equal(embed.description, undefined);
    assert.match(embed.fields[0].value, /^\*\*250\.000 by \[Player\].*\*\*$/);
    const seconds = Date.parse('2026-11-04T00:30:00Z') / 1000;
    assert.equal(embed.fields[1].value, `<t:${seconds}:R> (<t:${seconds}:F>)`);
    assert.match(embed.fields.find(field => field.name === 'Auction ends').value, /<t:\d+:R>/);
    assert.ok(!embed.fields.some(field => field.name === 'Auction' || field.name === 'Current offer'));
    assert.deepEqual(embed.fields.slice(-3).map(field => field.name), ['Server', 'Minimum bid', 'Discord message']);
    assert.deepEqual(embed.fields.slice(-3).map(field => field.inline), [true, true, false]);
    assert.equal(embed.fields.at(-1).value, `[**Jump to message** ↗️](<${jump}>)`);
    assert.equal(embed.footer.text, 'PRO Auction Notification DM');
    assert.ok(Number.isFinite(Date.parse(embed.timestamp)));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.ok(embedLength(embed) <= 6000);
});

test('bid DMs distinguish delayed bids and price offers from the current offer', () => {
    const bidder = { name: 'First' }, leader = { name: 'Leader' };
    const auction = sample({ currentOffer: '300.000', highestBidder: leader });
    for (const labels of [[], ['Price offer']]) {
        const payload = buildBidNotificationPayload({ auction, bid: { bidder, amount: '200.000', time: '2026-11-04 00:30:00', labels } }, '111');
        const embed = payload.embeds[0].toJSON();
        assert.equal(embed.title, `${labels.length ? 'New price offer' : 'New bid'} — ${auction.title}`);
        assert.equal(embed.url, auction.url);
        assert.equal(embed.thumbnail.url, auction.imageUrls[0]);
        assert.equal(payload.content, `**<@111> There's a new ${labels.length ? 'price offer' : 'bid'} for [${auction.title}](<${auction.url}>)**`);
        assert.deepEqual(payload.allowedMentions, { parse: [], users: ['111'] });
        assert.equal(embed.fields.find(field => field.name === 'Current offer').value, '**300.000 by Leader**');
        assert.equal(embed.fields[2].name, 'Current offer');
        assert.deepEqual(embed.fields.slice(-3).map(field => field.name), ['Server', 'Minimum bid', 'Discord message']);
        const row = payload.components[0].toJSON().components;
        assert.equal(row[0].label, 'View Auction');
        assert.equal(row[1].custom_id, 'auction:dm-unfollow:14702:111');
        assert.equal(row[1].style, 4);
    }
    const offer = buildBidNotificationPayload({ auction: { ...auction, currentOffer: '200.000', highestBidder: bidder },
        bid: { bidder, amount: '200.000', time: '2026-11-04 00:30:00', labels: ['Price offer'] } }, '111');
    assert.ok(!offer.embeds[0].toJSON().fields.some(field => field.name === 'Current offer'));
});

test('DM subscription controls toggle only the recipient’s subscription and handle ended auctions', async () => {
    const calls = [], updates = [];
    const initial = buildBidNotificationPayload({ auction: sample(), bid: { bidder: { name: 'Bidder' }, amount: '100', time: '2026-11-04 00:00:00' } }, '111');
    const interaction = { customId: 'auction:dm-unfollow:14702:111', user: { id: '111' }, channel: { type: ChannelType.DM },
        client: { user: { id: '222' }, guilds: { async fetch() { return {
            members: { async fetch() { return { id: '111' }; } },
            channels: { async fetch() { return { permissionsFor: () => ({ has: () => true }) }; } }
        }; } } }, message: { author: { id: '222' }, components: initial.components },
        async deferUpdate() { calls.push('defer'); }, async editReply(payload) { updates.push(payload); this.message.components = payload.components; },
        async followUp(payload) { calls.push(payload); }, async reply(payload) { calls.push(payload); } };
    let ended = false;
    const options = { guildId: '444', channelId: '555', getAuctionRecord: async () => ({ messageId: '333' }), followService: {
        async unfollow(id, user) { calls.push(['unfollow', id, user]); },
        async follow(id, user, messageId) { calls.push(['follow', id, user, messageId]); return ended ? { ended: true } : {}; }
    } };
    await handleAuctionButton(interaction, options);
    assert.deepEqual(calls.slice(0, 2), ['defer', ['unfollow', '14702', '111']]);
    let toggle = updates[0].components[0].toJSON().components[1];
    assert.equal(toggle.custom_id, 'auction:dm-follow:14702:111');
    assert.equal(toggle.style, 3);
    assert.equal(calls.at(-1).flags, MessageFlags.Ephemeral);
    interaction.customId = toggle.custom_id;
    await handleAuctionButton(interaction, options);
    assert.ok(calls.some(call => Array.isArray(call) && call.join(':') === 'follow:14702:111:333'));
    toggle = updates[1].components[0].toJSON().components[1];
    assert.equal(toggle.custom_id, 'auction:dm-unfollow:14702:111');
    assert.equal(toggle.style, 4);
    interaction.user.id = '999';
    await handleAuctionButton(interaction, options);
    assert.match(calls.at(-1).content, /unavailable/);
    interaction.user.id = '111';
    interaction.customId = 'auction:dm-follow:14702:111';
    ended = true;
    await handleAuctionButton(interaction, options);
    assert.match(calls.at(-1).content, /ended/);
    assert.equal(updates.length, 2);
    ended = false;
    interaction.client.guilds.fetch = async () => ({ members: { async fetch() { return {}; } },
        channels: { async fetch() { return { permissionsFor: () => ({ has: () => false }) }; } } });
    const followCalls = calls.filter(call => Array.isArray(call) && call[0] === 'follow').length;
    await handleAuctionButton(interaction, options);
    assert.match(calls.at(-1).content, /access to the auction channel/);
    assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'follow').length, followCalls);
});

test('an older bid DM supports subscription toggles after restart when its channel is not cached', async t => {
    const client = new Client({ intents: [] });
    t.after(() => client.destroy());
    const bot = { id: '222', username: 'Bot', discriminator: '0000', avatar: null, bot: true };
    client.user = client.users._add(bot);
    const payload = buildBidNotificationPayload({ auction: sample(), bid: { bidder: { name: 'Bidder' }, amount: '100' } }, '111');
    const interaction = new ButtonInteraction(client, {
        id: '666', application_id: '222', type: 3, token: 'test-only', context: 1,
        channel: { id: '333', type: ChannelType.DM }, user: { id: '111', username: 'Member', discriminator: '0000', avatar: null },
        data: { custom_id: 'auction:dm-unfollow:14702:111', component_type: ComponentType.Button },
        message: { id: '555', channel_id: '333', author: bot, content: '', type: 0, timestamp: '2026-11-04T00:00:00Z',
            attachments: [], embeds: payload.embeds.map(embed => embed.toJSON()), components: payload.components.map(row => row.toJSON()) },
        entitlements: [], app_permissions: '0', authorizing_integration_owners: {}
    });
    assert.equal(interaction.channel, null);
    assert.equal(interaction.guildId, null);
    const calls = [];
    interaction.deferUpdate = async () => { calls.push('defer'); };
    interaction.editReply = async update => { calls.push(update); };
    interaction.followUp = async feedback => { calls.push(feedback); };
    interaction.reply = async () => { assert.fail('An authenticated, uncached DM must not be rejected'); };
    const options = { guildId: '444', channelId: '777', getAuctionRecord: async () => ({ messageId: '888' }), followService: {
        async unfollow(...args) { calls.push(args); }, async follow(...args) { calls.push(args); return { auction: sample() }; }
    } };
    await handleAuctionButton(interaction, options);
    assert.deepEqual(calls.slice(0, 2), ['defer', ['14702', '111']]);
    const controls = calls[2].components[0].toJSON().components;
    assert.equal(controls[0].url, sample().url);
    assert.equal(controls[1].custom_id, 'auction:dm-follow:14702:111');
    assert.equal(controls[1].style, 3);
    interaction.customId = controls[1].custom_id;
    interaction.message.components = calls[2].components;
    t.mock.method(client.guilds, 'fetch', async guildId => {
        assert.equal(guildId, '444');
        return { members: { async fetch(userId) { assert.equal(userId, '111'); return { id: '111' }; } },
            channels: { async fetch(channelId) { assert.equal(channelId, '777'); return { permissionsFor: () => ({ has: () => true }) }; } } };
    });
    calls.length = 0;
    await handleAuctionButton(interaction, options);
    assert.equal(interaction.channel, null);
    assert.deepEqual(calls.slice(0, 2), ['defer', ['14702', '111', '888']]);
    const following = calls[2].components[0].toJSON().components[1];
    assert.equal(following.custom_id, 'auction:dm-unfollow:14702:111');
    assert.equal(following.style, 4);
});

test('DM subscription controls reject guilds, other channel types, other users and messages from other senders', async () => {
    for (const change of [i => { i.guildId = '444'; }, i => { i.channel = { type: ChannelType.GuildText }; },
        i => { i.channel = { type: ChannelType.GroupDM }; }, i => { i.user.id = '999'; },
        i => { i.message.author.id = '999'; }, i => { i.client.user = null; }]) {
        const replies = [];
        const interaction = { customId: 'auction:dm-unfollow:14702:111', channel: null,
            user: { id: '111' }, client: { user: { id: '222' } }, message: { author: { id: '222' } },
            async reply(payload) { replies.push(payload); }, async deferUpdate() { assert.fail('Invalid controls must be rejected before mutation'); } };
        change(interaction);
        await handleAuctionButton(interaction, { followService: { async unfollow() { assert.fail('Invalid removal'); } } });
        assert.equal(replies.length, 1);
        assert.match(replies[0].content, /unavailable here/);
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    }
});

test('bid DM headings respect Discord title limits and reject unsafe auction links', () => {
    const payload = buildBidNotificationPayload({ auction: sample({ title: '@everyone ' + 'x'.repeat(300), url: 'javascript:alert(1)' }),
        bid: { bidder: { name: 'Bidder' }, amount: '100' } }, '111');
    const embed = payload.embeds[0].toJSON();
    assert.equal(embed.title.length, 256);
    assert.ok(embed.title.startsWith('New bid — '));
    assert.doesNotMatch(embed.title, /@everyone/);
    assert.equal(embed.url, undefined);
    assert.equal(embed.description, undefined);
    assert.deepEqual(payload.components[0].toJSON().components.map(button => button.label), ['Unfollow']);
    assert.ok(payload.content.startsWith("**<@111> There's a new bid for "));
    assert.doesNotMatch(payload.content, /@everyone|javascript:/);
});

test('bid DM announcements fit Discord limits and mention only their recipient', () => {
    const longUrl = 'https://example.com/' + 'x'.repeat(1700);
    const payload = buildBidNotificationPayload({ auction: sample({ url: longUrl, title: '@everyone ' + 'A'.repeat(300) }),
        bid: { bidder: { name: '@here' }, amount: '100', labels: ['Price offer'] } }, '291142291073269761');
    assert.ok(payload.content.length <= 2000);
    assert.match(payload.content, /^\*\*<@291142291073269761> There's a new price offer for \[/);
    assert.ok(payload.content.endsWith(`](<${longUrl}>)**`));
    assert.doesNotMatch(payload.content, /@everyone|@here/);
    assert.deepEqual(payload.allowedMentions, { parse: [], users: ['291142291073269761'] });
});

test('private auction links show unavailable for missing or invalid Discord message URLs', () => {
    for (const jump of [null, 'javascript:alert(1)', 'https://example.com/channels/123/456/789', 'https://discord.com/channels/123/456/789?@everyone']) {
        const auction = sample();
        const dm = buildBidNotificationPayload({ auction, bid: { bidder: { name: 'Bidder' }, amount: '100' } }, '111', null, jump);
        assert.equal(dm.embeds[0].toJSON().fields.at(-1).value, '*Message unavailable*');
        const gallery = privatePage('images', auction, 0, jump).components[0].toJSON();
        assert.equal(gallery.components.at(-2).content, '**Auction Message: *Message unavailable***');
    }
});

test('bid DMs localize UTC forum times and fall back to stored timestamps or source text', () => {
    const timestamp = '2026-11-04T06:54:22Z';
    const seconds = Date.parse(timestamp) / 1000;
    for (const labels of [[], ['Price offer']]) {
        for (const bid of [{ time: '2026-11-04 06:54:22' }, { time: '2026-11-04 06:54:22 UTC' },
            { timestamp }, { time: 'unavailable', timestamp }, { timestamp: 'invalid', time: 'Unknown', expected: 'Unknown' },
            { expected: '*None*' }]) {
            const embed = buildBidNotificationPayload({ auction: sample(), bid: { ...bid, labels } }, '111').embeds[0].toJSON();
            assert.equal(embed.fields.find(field => field.name === 'Bid time (forum)').value,
                bid.expected || `<t:${seconds}:R> (<t:${seconds}:F>)`);
        }
    }
});

for (const format of ['discord', 'utc']) test(`delivery recovery recognizes a previously sent DM with ${format} time and the older embed layout`, async () => {
    const auction = sample();
    const bidder = { name: 'Bidder', url: 'https://pokemonrevolution.net/forum/profile/2-bidder/' };
    const timestamp = '2026-11-04T00:30:00.000Z';
    const seconds = Math.floor(Date.parse(timestamp) / 1000);
    const previous = { id: '500', author: { id: 'bot' }, embeds: [{ url: auction.url, fields: [
        { name: 'New bid', value: '**200.000** by [Bidder](<https://pokemonrevolution.net/forum/profile/2-bidder/>)' },
        { name: 'Bid time (forum)', value: format === 'discord' ? `<t:${seconds}:R> (<t:${seconds}:F>)` : '2026-11-04 00:30:00 UTC' }
    ] }] };
    const channel = { messages: { async fetch() { return new Collection([[previous.id, previous]]); } },
        async send() { assert.fail('A confirmed previous DM must not be sent twice'); } };
    const notifier = new AuctionDiscordNotifier({ client: { user: { id: 'bot' },
        users: { cache: new Map([['111', { dmChannel: channel }]]) } } });
    const message = await notifier.sendBidUpdate('111', 'key', { auction, bid: { bidder, amount: '200.000',
        time: '2026-11-04 00:30:00', timestamp } });
    assert.equal(message.id, '500');
});

test('public auctions, private details and bid DMs use hosted footer icons without uploading logo files', () => {
    const avatar = 'https://cdn.discordapp.com/avatars/123/avatar.webp';
    const botUser = { displayAvatarURL: options => { assert.equal(options.size, 64); return avatar; } };
    const auction = sample();
    const payloads = [buildAuctionPayload(auction, {}, botUser),
        buildBidNotificationPayload({ auction, bid: { bidder: { name: 'Bidder' }, amount: '100', time: 'now' } }, '111', botUser),
        ...['bids', 'description', 'payment'].map(kind => privatePage(kind, auction, 0, null, botUser))];
    for (const payload of payloads) {
        assert.equal(payload.files, undefined);
        assert.equal(payload.embeds[0].toJSON().footer.icon_url, avatar);
        assert.notEqual(payload.embeds[0].toJSON().image?.url, avatar);
        assert.doesNotMatch(JSON.stringify(payload.embeds.map(embed => embed.toJSON())), /attachment:\/\/cc_logo/);
    }
    const gallery = privatePage('images', auction, 0, null, botUser);
    assert.equal(gallery.files, undefined);
    assert.deepEqual(gallery.attachments, []);
    assert.doesNotMatch(JSON.stringify(gallery.components.map(component => component.toJSON())), /cc_logo|avatars\/123/);
});

test('editing an auction refreshes its native timestamp while retaining the footer text', async t => {
    let now = Date.parse('2026-11-04T00:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const original = buildAuctionPayload(sample()).embeds[0].toJSON();
    let edited;
    const message = { attachments: new Collection(), async edit(payload) { edited = payload.embeds[0].toJSON(); } };
    const channel = { isTextBased: () => true, messages: { async fetch() { return message; } }, async send() {} };
    const notifier = new AuctionDiscordNotifier({ client: { channels: { cache: new Map([['123', channel]]) } }, channelId: '123' });
    now += 60_000;
    await notifier.edit('111', sample());
    assert.equal(edited.footer.text, original.footer.text);
    assert.equal(Date.parse(edited.timestamp) - Date.parse(original.timestamp), 60_000);
});

test('persistent bid history controls link to the original message on every private page', async () => {
    const calls = [];
    const auction = sample({ bids: Array.from({ length: 30 }, (_, i) => ({ bidder: { name: `Bidder${i}` }, amount: '100', time: 'now' })) });
    const interaction = { customId: 'auction:bids:14702:0', guildId: '123', channelId: '456',
        deferReply: async () => calls.push('defer'), editReply: async payload => calls.push(payload) };
    const options = { channelId: '456', getAuctionRecord: async () => ({ messageId: '789', auction }) };
    await handleAuctionButton(interaction, options);
    assert.equal(calls[0], 'defer');
    assert.equal(calls[1].embeds[0].toJSON().fields[0].value, '[**Jump to message** ↗️](<https://discord.com/channels/123/456/789>)');
    const next = { ...interaction, customId: 'auction:bids:14702:1', message: { flags: { has: flag => flag === MessageFlags.Ephemeral } },
        deferUpdate: async () => calls.push('update') };
    await handleAuctionButton(next, options);
    assert.equal(calls[2], 'update');
    assert.equal(calls[3].embeds[0].toJSON().fields[0].value, '[**Jump to message** ↗️](<https://discord.com/channels/123/456/789>)');
});

test('private galleries and bid histories do not link to an announcement confirmed deleted', async () => {
    for (const kind of ['images', 'bids']) {
        let response;
        const interaction = { customId: `auction:${kind}:14702:0`, guildId: '123', channelId: '456',
            message: { flags: { has: flag => flag === MessageFlags.Ephemeral } },
            async deferUpdate() {}, async editReply(payload) { response = payload; } };
        await handleAuctionButton(interaction, { channelId: '456', getAuctionRecord: async () => ({
            messageId: '789', messageMissing: true, auction: sample()
        }) });
        if (kind === 'images') assert.equal(response.components[0].toJSON().components.at(-2).content, '**Auction Message: *Message unavailable***');
        else assert.equal(response.embeds[0].toJSON().fields[0].value, '*Message unavailable*');
    }
});

test('button privately acknowledges before reading durable auction data and supports navigation', async () => {
    const calls = [];
    const interaction = { customId: 'auction:images:14702:0', channelId: '123',
        deferReply: async payload => calls.push(['deferReply', payload]), editReply: async payload => calls.push(['editReply', payload]) };
    assert.equal(await handleAuctionButton(interaction, { channelId: '123', getAuctionRecord: async () => { calls.push(['lookup']); return { auction: sample() }; } }), true);
    assert.equal(calls[0][0], 'deferReply');
    assert.equal(calls[0][1].flags, MessageFlags.Ephemeral);
    assert.equal(calls[1][0], 'lookup');
    assert.equal(calls[2][1].flags, MessageFlags.IsComponentsV2);
    assert.equal(calls[2][1].components[0].toJSON().components
        .find(component => component.type === ComponentType.MediaGallery).items.length, 2);
    const privateInteraction = { ...interaction, message: { flags: { has: flag => flag === MessageFlags.Ephemeral } },
        deferUpdate: async () => calls.push(['deferUpdate']) };
    await handleAuctionButton(privateInteraction, { channelId: '123', getAuctionRecord: async () => ({ auction: sample() }) });
    assert.ok(calls.some(call => call[0] === 'deferUpdate'));
});

test('V2 image pagination updates its private response and clears unavailable auctions without legacy content', async () => {
    const calls = [];
    const interaction = { customId: 'auction:images:14702:1', channelId: '123',
        message: { flags: new MessageFlagsBitField([MessageFlags.Ephemeral, MessageFlags.IsComponentsV2]) },
        deferUpdate: async () => calls.push('deferUpdate'), editReply: async payload => calls.push(payload) };
    const options = { channelId: '123', async getAuctionRecord() {
        assert.equal(calls[0], 'deferUpdate');
        return { auction: sample({ imageUrls: Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`) }) };
    } };
    await handleAuctionButton(interaction, options);
    assert.deepEqual(calls[1].embeds, []);
    assert.equal(calls[1].components[0].toJSON().components.find(component => component.type === ComponentType.MediaGallery).items.length, 1);
    calls.length = 0;
    options.getAuctionRecord = async () => null;
    await handleAuctionButton(interaction, options);
    assert.equal(calls[0], 'deferUpdate');
    assert.equal(calls[1].content, null);
    assert.deepEqual(calls[1].embeds, []);
    assert.deepEqual(calls[1].attachments, []);
    assert.equal(calls[1].components[0].toJSON().type, ComponentType.TextDisplay);
    assert.match(calls[1].components[0].toJSON().content, /no longer available/);
});

test('sending recovers an existing notification and leaves fetch failures visible', async () => {
    let sends = 0;
    const existing = { id: '555', author: { id: 'bot' }, embeds: [{ url: sample().url }] };
    const channel = { isTextBased: () => true, messages: { fetch: async () => new Map([['555', existing]]) }, send: async () => { sends++; } };
    const client = { user: { id: 'bot' }, channels: { cache: new Map([['123', channel]]) } };
    const notifier = new AuctionDiscordNotifier({ client, channelId: '123' });
    assert.equal(await notifier.send(sample()), existing);
    assert.equal(sends, 0);
    channel.messages.fetch = async () => { throw new Error('unavailable'); };
    await assert.rejects(notifier.send(sample()), /unavailable/);
    assert.equal(sends, 0);
});

test('a delivery retry finds an older announcement beyond the latest 100 messages', async () => {
    const requests = [];
    const first = new Collection(Array.from({ length: 100 }, (_, i) => [String(1000 - i), {
        id: String(1000 - i), author: { id: 'bot' }, content: 'another message', createdTimestamp: 5000
    }]));
    const prior = { id: '800', author: { id: 'bot' }, embeds: [{ url: sample().url }], createdTimestamp: 4000 };
    const channel = { isTextBased: () => true, messages: { async fetch(query) {
        requests.push(query);
        return query.before ? new Collection([[prior.id, prior]]) : first;
    } }, async send() { assert.fail('The prior announcement must be recovered'); } };
    const notifier = new AuctionDiscordNotifier({ client: { user: { id: 'bot' }, channels: { cache: new Map([['123', channel]]) } }, channelId: '123' });
    assert.equal(await notifier.send(sample(), { queuedAt: new Date(1000).toISOString() }), prior);
    assert.equal(requests[1].before, '901');
});

test('new deliveries stop the history check once it predates their durable queue time', async () => {
    let pages = 0;
    let sends = 0;
    const channel = { isTextBased: () => true, messages: { async fetch() {
        pages++;
        return new Collection(Array.from({ length: 100 }, (_, i) => [String(1000 - i), {
            id: String(1000 - i), author: { id: 'other' }, createdTimestamp: 1000
        }]));
    } }, async send() { sends++; return { id: 'new' }; } };
    const notifier = new AuctionDiscordNotifier({ client: { user: { id: 'bot' }, channels: { cache: new Map([['123', channel]]) } }, channelId: '123' });
    await notifier.send(sample(), { queuedAt: new Date(100000).toISOString() });
    assert.equal(pages, 1);
    assert.equal(sends, 1);
});

test('auction edits remove logo attachments, retain other files and use the hosted bot avatar only as a footer icon', async () => {
    const edits = [];
    const message = { attachments: new Collection([
        ['a', { id: 'a', name: 'cc_logo.webp', url: 'https://cdn.example.com/cc_logo.webp' }],
        ['b', { id: 'b', name: 'cc_logo.webp', url: 'https://cdn.example.com/duplicate-logo.webp' }],
        ['c', { id: 'c', name: 'pokemon.png', url: 'https://cdn.example.com/pokemon.png' }]
    ]),
        async edit(payload) { edits.push(payload); } };
    const channel = { isTextBased: () => true, messages: { fetch: async () => message }, async send() {} };
    const botUser = { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/123/avatar.webp' };
    const notifier = new AuctionDiscordNotifier({ client: { user: botUser, channels: { cache: new Map([['123', channel]]) } }, channelId: '123' });
    await notifier.edit('message', sample());
    assert.equal(edits[0].files, undefined);
    assert.deepEqual(edits[0].attachments, [{ id: 'c' }]);
    assert.equal(edits[0].embeds[0].toJSON().footer.icon_url, botUser.displayAvatarURL());
    assert.equal(edits[0].embeds[0].toJSON().image.url, sample().imageUrls[0]);
    message.attachments = new Collection();
    await notifier.edit('message', sample());
    assert.equal(edits[1].files, undefined);
    assert.deepEqual(edits[1].attachments, []);
    assert.equal(edits[1].embeds[0].toJSON().footer.icon_url, botUser.displayAvatarURL());
});

test('new announcements notify only the configured role and subsequent edits do not notify it again', async () => {
    let sent;
    let edited;
    const message = { attachments: new Collection(), async edit(payload) { edited = payload; } };
    const channel = { isTextBased: () => true, messages: { async fetch(query) {
        return typeof query === 'string' ? message : new Collection();
    } }, async send(payload) { sent = payload; return { id: 'message' }; } };
    const notifier = new AuctionDiscordNotifier({ client: { user: { id: 'bot' }, channels: { cache: new Map([['123', channel]]) } },
        channelId: '123', config: { proNotificationRoleID: '1537991574162640906', selfRoleChannelID: '1184121209609269409' } });
    await notifier.send(sample());
    assert.deepEqual(sent.allowedMentions, { parse: [], roles: ['1537991574162640906'] });
    await notifier.edit('message', sample());
    assert.deepEqual(edited.allowedMentions, { parse: [] });
    assert.match(edited.content, /^<@&1537991574162640906>/);
});
