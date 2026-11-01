'use strict';

// Sends a small, fixed set of live forum examples to the owner for visual testing.
// Run with --send only when you actually want Discord messages created.
require('dotenv').config();

const fs = require('fs');
const { REST, Routes } = require('discord.js');
const { TbaForumShopClient } = require('../features/tba-forum-shops/TbaForumShopClient.js');
const { TbaForumShopNotifier } = require('../features/tba-forum-shops/TbaForumShopNotifier.js');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const selections = [
    {
        key: 'forumShop',
        name: 'PRO Forum Shop',
        emoji: '🛒',
        topicUrl: config.tbaProForumShop,
        posts: [
            { id: '1444830', page: 1, label: 'short customer question' },
            { id: '1590998', page: 23, label: 'two-image customer post' },
            { id: '1592668', page: 23, label: 'quoted customer post with an image' },
            { id: '1645229', page: 26, label: 'longer price negotiation' },
            { id: '1730109', page: 35, label: 'complete boss-team request' }
        ]
    },
    {
        key: 'dungeonShop',
        name: 'PRO Dungeon Shop',
        emoji: '🏰',
        topicUrl: config.tbaProDungeonShop,
        posts: [
            { id: '1468678', page: 1, label: 'customer asking for both services' },
            { id: '1483395', page: 3, label: 'short Victini price request' },
            { id: '1558774', page: 5, label: 'availability question' },
            { id: '1596083', page: 5, label: 'customer asking about Time Flute service' },
            { id: '1649543', page: 6, label: 'short Meloetta service request' }
        ]
    }
];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function createOwnerDm(rest, ownerId) {
    const channel = await rest.post(Routes.userChannels(), {
        body: { recipient_id: ownerId }
    });
    return channel.id;
}

function createRestOwner(rest, channelId) {
    return {
        async send(payload) {
            return rest.post(Routes.channelMessages(channelId), {
                body: {
                    content: payload.content,
                    embeds: (payload.embeds || []).map(embed => embed.toJSON()),
                    allowed_mentions: payload.allowedMentions || { parse: [] }
                },
                // Raw REST uploads use `data`; discord.js TextBasedChannel.send uses `attachment`.
                files: (payload.files || []).map(file => ({
                    data: file.attachment,
                    name: file.name
                }))
            });
        }
    };
}

async function loadSelectedPosts(selection) {
    const forumClient = new TbaForumShopClient({ topicUrl: selection.topicUrl });
    const pageCache = new Map();
    const posts = [];

    for (const selected of selection.posts) {
        if (!pageCache.has(selected.page)) pageCache.set(selected.page, await forumClient.fetchPage(selected.page));
        const page = pageCache.get(selected.page);
        const post = page.posts.find(item => String(item.postId) === selected.id);
        if (!post) throw new Error(`Could not find ${selection.name} post ${selected.id} on page ${selected.page}.`);
        posts.push({ selected, post, forumClient });
    }
    return posts;
}

async function main() {
    const quoteOnly = process.argv.includes('--send-quote');
    const oneEach = process.argv.includes('--send-one-each');
    const send = process.argv.includes('--send') || quoteOnly || oneEach;
    const ownerId = String(config.ownerID || '').trim();
    const token = process.env.TOKEN;
    if (!ownerId || !token) throw new Error('config.ownerID and TOKEN are required.');

    if (!send) {
        console.log('Preview only. Add --send to create the owner DMs.');
        for (const selection of selections) {
            console.log(`${selection.name}: ${selection.posts.map(post => `${post.id} (${post.label})`).join(', ')}`);
        }
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);
    const dmChannelId = await createOwnerDm(rest, ownerId);
    const owner = createRestOwner(rest, dmChannelId);
    const notifier = new TbaForumShopNotifier({
        client: { users: { cache: new Map([[ownerId, owner]]) } },
        ownerID: ownerId,
        botTimezone: config.botTimezone
    });

    const selectedShops = quoteOnly
        ? selections.map(selection => ({
            ...selection,
            posts: selection.posts.filter(post => post.label.includes('quoted'))
        })).filter(selection => selection.posts.length)
        : oneEach
            ? selections.map(selection => ({ ...selection, posts: [selection.posts[0]] }))
            : selections;

    let sentCount = 0;
    for (const selection of selectedShops) {
        const posts = await loadSelectedPosts(selection);
        for (const { selected, post, forumClient } of posts) {
            const images = await forumClient.downloadPostImages(post);
            const sentMessage = await notifier.notify(selection, post, images);
            if (!sentMessage) {
                console.log(`[CC LOG] Skipped ignored ${selection.name} test post ${selected.id}.`);
                continue;
            }
            sentCount++;
            console.log(`[CC LOG] Sent ${selection.name} test post ${selected.id}: ${selected.label}`);
            await sleep(1500);
        }
    }
    console.log(`[CC LOG] Sent ${sentCount} TBA forum shop test preview(s) to ${ownerId}.`);
}

main().catch(error => {
    console.error('[CC LOG] TBA forum shop test failed:', error);
    process.exitCode = 1;
});
