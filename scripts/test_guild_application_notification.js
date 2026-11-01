// Preview live forum applications; Discord delivery requires an explicit send option.
'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client, Events, GatewayIntentBits } = require('discord.js');
const config = require('../config.json');
const {
    CLASSIFICATIONS,
    TOPIC_ID,
    TOPIC_URL
} = require('../features/guild-applications/constants.js');
const { GuildApplicationNotifier, messageUrl } = require('../features/guild-applications/discord/GuildApplicationNotifier.js');
const { GuildForumPostNotifier } = require('../features/guild-applications/discord/GuildForumPostNotifier.js');
const { ProForumClient } = require('../features/guild-applications/forum/ProForumClient.js');
const { GuildApplicationParser } = require('../features/guild-applications/parsing/GuildApplicationParser.js');

const TEST_CHANNEL_ID = '1184117095231918101';
const TEST_USER_ID = '291142291073269761';
const PRO_FORUM_EMOJI = '<:pro_revolution_online:1526117366159638628>';

function argumentValue(name) {
    const prefix = `--${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || null;
}

function structuredFieldCount(parsed) {
    return [parsed.fields.ign, parsed.fields.age, parsed.fields.country, parsed.fields.interests]
        .filter(Boolean)
        .length;
}

function strongCandidates(posts, parser) {
    return posts
        .map(post => ({ post, parsed: parser.parse(post) }))
        .filter(({ post, parsed }) => (
            parsed.classification === CLASSIFICATIONS.APPLICATION
            && parsed.confidence >= 0.75
            && parsed.fields.ign
            && parsed.ignConfidence >= 0.78
            && structuredFieldCount(parsed) >= 3
            && post.imageUrls.length > 0
        ));
}

function nonApplicationCandidates(posts, parser) {
    return posts
        .map(post => ({ post, parsed: parser.parse(post) }))
        .filter(({ parsed }) => parsed.classification === CLASSIFICATIONS.NON_APPLICATION);
}

function normalizedTestName(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function applicationCandidates(posts, parser) {
    const excluded = new Set(['foxcomeback', 'solosolow']);
    return posts
        .map(post => ({ post, parsed: parser.parse(post) }))
        .filter(({ post, parsed }) => {
            if (parsed.classification !== CLASSIFICATIONS.APPLICATION) return false;
            const identities = [post.forumUsername, post.profileSlug, parsed.fields.ign]
                .map(normalizedTestName)
                .filter(Boolean);
            return !identities.some(identity => excluded.has(identity));
        });
}

function selectTestSuite(posts, parser) {
    const candidates = applicationCandidates(posts, parser)
        .filter(candidate => normalizedTestName(candidate.post.forumUsername) !== 'aaronlee191');
    const used = new Set();
    const choose = (predicate, sort = () => 0) => {
        const selected = candidates
            .filter(candidate => !used.has(String(candidate.post.postId)) && predicate(candidate))
            .sort(sort)[0];
        if (!selected) return null;
        used.add(String(selected.post.postId));
        return selected;
    };

    // Historical applications are often well-structured, so force the fallback on a real post when needed.
    const rawFallback = choose(candidate => structuredFieldCount(candidate.parsed) < 2)
        || choose(() => true);
    const multipleImages = choose(
        candidate => candidate.post.imageUrls.length > 1,
        (a, b) => b.post.imageUrls.length - a.post.imageUrls.length
    );
    const extraInformation = choose(
        candidate => Boolean(candidate.parsed.fields.extraInformation),
        (a, b) => String(b.parsed.fields.extraInformation || '').length - String(a.parsed.fields.extraInformation || '').length
    );
    const missingFields = choose(
        candidate => {
            const count = structuredFieldCount(candidate.parsed);
            return count >= 2 && count < 4;
        },
        (a, b) => structuredFieldCount(b.parsed) - structuredFieldCount(a.parsed)
    );

    const selected = [
        { key: 'raw-fallback', label: 'Forced raw fallback, one-field embed', candidate: rawFallback, useRawFallback: true },
        { key: 'multiple-images', label: 'Multiple images', candidate: multipleImages, useRawFallback: false },
        { key: 'extra-information', label: 'Extra Information', candidate: extraInformation, useRawFallback: false },
        { key: 'missing-fields', label: 'Missing fields shown as N/A', candidate: missingFields, useRawFallback: false }
    ];

    const missing = selected.filter(item => !item.candidate).map(item => item.key);
    if (missing.length) throw new Error(`Could not find distinct application test cases: ${missing.join(', ')}`);
    return selected.map(item => ({ ...item, post: item.candidate.post, parsed: item.candidate.parsed }));
}

function selectRandomCandidate(candidates) {
    if (!candidates.length) throw new Error('No strong historical Guild Application candidates were found.');
    return candidates[crypto.randomInt(candidates.length)];
}

function applicationRecord(post, parsed) {
    const topicUrl = config.forumGuildApplicationPage || TOPIC_URL;
    return {
        postId: String(post.postId),
        topicId: topicUrl.match(/\/topic\/(\d+)/i)?.[1] || TOPIC_ID,
        topicUrl,
        postUrl: post.postUrl,
        pageNumber: post.page,
        forumUserId: post.forumUserId,
        forumUsername: post.forumUsername,
        forumProfileUrl: post.profileUrl,
        forumProfileSlug: post.profileSlug,
        postedAt: post.postedAt,
        rawBodyText: post.bodyText || '',
        imageUrls: post.imageUrls || [],
        classification: parsed.classification,
        classificationConfidence: parsed.confidence,
        ign: parsed.fields.ign,
        ignSource: parsed.ignSource,
        ignConfidence: parsed.ignConfidence,
        age: parsed.fields.age,
        country: parsed.fields.country,
        interests: parsed.fields.interests,
        extraInformation: parsed.fields.extraInformation
    };
}

async function fetchAllPosts(forum) {
    const firstPage = await forum.fetchPage(1);
    const pages = [firstPage];

    // Keep this sequential so a manual preview does not burst requests at the forum.
    for (let page = 2; page <= firstPage.lastPage; page++) {
        pages.push(await forum.fetchPage(page));
    }

    const postsById = new Map();
    for (const result of pages) {
        for (const post of result.posts) postsById.set(String(post.postId), post);
    }
    return [...postsById.values()];
}

function testOfficerContent(record, pollUrl = null) {
    const reviewLine = pollUrl ? `Review the application and cast your vote in ${pollUrl}\n` : '';
    return `### <@${TEST_USER_ID}>, a new application to join Crow Control has been submitted through the [**PRO Forum**](<${record.topicUrl || TOPIC_URL}>) ${PRO_FORUM_EMOJI}\n`
        + reviewLine
        + `- PRO Forum Application: [**Click Here!**](<${record.postUrl}>)`;
}

function testReminderContent(applicationUrl, pollUrl, hours, ign) {
    return `### 🔔 Vote Reminder, <@${TEST_USER_ID}>\n\n`
        + `It has been **${hours} hours** since a poll was created, and less than 50% of Officers have voted!\n`
        + `Please review the application for **${ign || 'this applicant'}** and cast your vote!\n`
        + `- **View Application: [Click Here!](<${applicationUrl}>)**\n`
        + `- **Cast your vote: [Click Here!](<${pollUrl}>)**`;
}

async function postNonApplicationPreview(client, record) {
    const notifier = new GuildForumPostNotifier({
        client,
        officerChannelID: TEST_CHANNEL_ID,
        ownerID: TEST_USER_ID,
        botTimezone: config.botTimezone,
        topicUrl: config.forumGuildApplicationPage || TOPIC_URL
    });
    const updated = await notifier.notify(record);
    const channel = await client.channels.fetch(TEST_CHANNEL_ID);
    const alertUrl = messageUrl(config.guildId, channel.id, updated.message.id);
    console.log(`[CC LOG] Non-application preview posted for ${record.forumUsername} (${record.postId}): ${alertUrl}`);
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withDiscordClient(callback) {
    if (!process.env.TOKEN) throw new Error('TOKEN is missing from .env.');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const ready = new Promise(resolve => client.once(Events.ClientReady, resolve));

    try {
        await client.login(process.env.TOKEN);
        await ready;
        return await callback(client);
    } finally {
        client.destroy();
    }
}

async function postPreview(client, forum, record, options = {}) {
    const notifier = new GuildApplicationNotifier({
        client,
        guildId: config.guildId,
        officerChannelID: TEST_CHANNEL_ID,
        courtHouseChannelID: TEST_CHANNEL_ID,
        officerRoleID: config.officerRoleID,
        botTimezone: config.botTimezone
    });
    const channel = await notifier.getTextChannel(TEST_CHANNEL_ID, 'Guild Application test');
    const downloadedImages = await forum.downloadPostImages({
        imageUrls: record.imageUrls
    });
    const visualPayload = options.useRawFallback
        ? notifier.buildRawApplicationPayload(record, downloadedImages)
        : notifier.buildNormalPayload(record, downloadedImages);
    const applicationMessage = await channel.send({
        content: `${testOfficerContent(record)}${options.testLabel ? `\n-# Test case: ${options.testLabel}` : ''}`,
        ...visualPayload,
        allowedMentions: { parse: [], users: [TEST_USER_ID] }
    });
    const applicationUrl = messageUrl(config.guildId, channel.id, applicationMessage.id);
    await notifier.sendRemainingAttachments(applicationMessage, downloadedImages);

    if (options.includePoll === false) return { applicationUrl, pollUrl: null };

    try {
        const pollMessage = await channel.send({
            content: notifier.courtContent(record, applicationUrl),
            poll: {
                question: { text: `Invite ${record.ign} to Crow Control?` },
                answers: [{ text: 'Yes' }, { text: 'No' }],
                duration: 24,
                allowMultiselect: false
            },
            allowedMentions: { parse: [] }
        });
        const pollUrl = messageUrl(config.guildId, channel.id, pollMessage.id);
        await applicationMessage.edit({
            content: `${testOfficerContent(record, pollUrl)}${options.testLabel ? `\n-# Test case: ${options.testLabel}` : ''}`,
            allowedMentions: { parse: [], users: [TEST_USER_ID] }
        });
        return { applicationUrl, pollUrl };
    } catch (error) {
        console.error('[CC LOG] Guild Application preview poll could not be created:', error);
        return { applicationUrl, pollUrl: null };
    }
}

async function main() {
    const forum = new ProForumClient({
        topicUrl: config.forumGuildApplicationPage || TOPIC_URL
    });
    const parser = new GuildApplicationParser();
    const posts = await fetchAllPosts(forum);
    const requestedPostId = argumentValue('post-id');
    const excludedPostId = argumentValue('exclude-post-id');
    const candidates = strongCandidates(posts, parser)
        .filter(candidate => String(candidate.post.postId) !== String(excludedPostId || ''))
        .filter(candidate => !['foxcomeback', 'solosolow'].includes(normalizedTestName(candidate.parsed.fields.ign)));

    if (process.argv.includes('--send-aaron')) {
        const selectedAaron = applicationCandidates(posts, parser).find(candidate => (
            normalizedTestName(candidate.post.forumUsername) === 'aaronlee191'
            || normalizedTestName(candidate.parsed.fields.ign) === 'aaronlee191'
        ));
        if (!selectedAaron) throw new Error('Aaronlee191 application was not found.');
        const record = applicationRecord(selectedAaron.post, selectedAaron.parsed);
        await withDiscordClient(async client => {
            const result = await postPreview(client, forum, record, {
                includePoll: false,
                testLabel: 'Country validation: PokeMMO ignored, Singapore selected'
            });
            console.log(`[CC LOG] Aaronlee191 preview posted: ${result.applicationUrl}`);
        });
        return;
    }

    if (process.argv.includes('--send-post-test')) {
        if (!requestedPostId) throw new Error('--send-post-test requires --post-id=POST_ID.');
        const selectedPost = applicationCandidates(posts, parser).find(candidate => (
            String(candidate.post.postId) === String(requestedPostId)
        ));
        if (!selectedPost) throw new Error(`Forum post ${requestedPostId} is not a detected application.`);
        const record = applicationRecord(selectedPost.post, selectedPost.parsed);
        await withDiscordClient(async client => {
            const result = await postPreview(client, forum, record, {
                includePoll: false,
                testLabel: `Specific forum post test: ${requestedPostId}`
            });
            console.log(`[CC LOG] Forum post ${requestedPostId} preview posted for ${record.forumUsername}: ${result.applicationUrl}`);
        });
        return;
    }

    if (process.argv.includes('--send-test-suite') || process.argv.includes('--send-edge-suite')) {
        const suite = selectTestSuite(posts, parser);
        await withDiscordClient(async client => {
            for (const testCase of suite) {
                const record = applicationRecord(testCase.post, testCase.parsed);
                const result = await postPreview(client, forum, record, {
                    includePoll: false,
                    testLabel: testCase.label,
                    useRawFallback: testCase.useRawFallback
                });
                console.log(`[CC LOG] ${testCase.label} preview posted for ${record.forumUsername} (${record.postId}): ${result.applicationUrl}`);
            }
        });
        return;
    }

    if (process.argv.includes('--send-reminder-test')) {
        const reminderCandidates = candidates.filter(candidate => normalizedTestName(candidate.post.forumUsername) !== 'aaronlee191');
        const selectedReminder = requestedPostId
            ? reminderCandidates.find(candidate => String(candidate.post.postId) === String(requestedPostId))
            : selectRandomCandidate(reminderCandidates);
        if (!selectedReminder) throw new Error('No suitable Guild Application reminder test candidate was found.');
        const record = applicationRecord(selectedReminder.post, selectedReminder.parsed);

        await withDiscordClient(async client => {
            const result = await postPreview(client, forum, record, {
                testLabel: 'Accelerated vote reminder test (production remains 12h/18h)'
            });
            if (!result.pollUrl) throw new Error('The reminder test poll could not be created.');
            const channel = await client.channels.fetch(TEST_CHANNEL_ID);

            for (const hours of [12, 18]) {
                await wait(60_000);
                const reminder = await channel.send({
                    content: testReminderContent(result.applicationUrl, result.pollUrl, hours, record.ign),
                    allowedMentions: { parse: [], users: [TEST_USER_ID] }
                });
                console.log(`[CC LOG] Accelerated ${hours}-hour reminder posted: ${messageUrl(config.guildId, channel.id, reminder.id)}`);
            }
        });
        return;
    }

    if (process.argv.includes('--send-non-application-test')) {
        const selected = selectRandomCandidate(nonApplicationCandidates(posts, parser));
        const record = applicationRecord(selected.post, selected.parsed);
        await withDiscordClient(client => postNonApplicationPreview(client, record));
        return;
    }

    if (process.argv.includes('--send-notification-test-suite')) {
        const selectedApplication = selectRandomCandidate(candidates);
        const nonApplications = nonApplicationCandidates(posts, parser);
        const selectedNonApplication = selectRandomCandidate(nonApplications);
        const application = applicationRecord(selectedApplication.post, selectedApplication.parsed);
        const nonApplication = applicationRecord(selectedNonApplication.post, selectedNonApplication.parsed);

        await withDiscordClient(async client => {
            const result = await postPreview(client, forum, application, {
                testLabel: 'Test-only accelerated vote reminder (1 and 2 minutes)',
                includePoll: true
            });
            if (!result.pollUrl) throw new Error('The test application poll could not be created.');

            await postNonApplicationPreview(client, nonApplication);
            const channel = await client.channels.fetch(TEST_CHANNEL_ID);
            for (const hours of [12, 18]) {
                await wait(60_000);
                const reminder = await channel.send({
                    content: testReminderContent(result.applicationUrl, result.pollUrl, hours, application.ign),
                    allowedMentions: { parse: [], users: [TEST_USER_ID] }
                });
                console.log(`[CC LOG] Accelerated ${hours}-hour reminder posted: ${messageUrl(config.guildId, channel.id, reminder.id)}`);
            }
        });
        return;
    }

    const selected = requestedPostId
        ? candidates.find(candidate => String(candidate.post.postId) === String(requestedPostId))
        : selectRandomCandidate(candidates);
    if (!selected) throw new Error(`Forum post ${requestedPostId} is not an available strong application candidate.`);
    const record = applicationRecord(selected.post, selected.parsed);

    console.log(`[CC LOG] Selected Guild Application ${record.postId} from ${record.forumUsername} (${record.ign}). Country: ${record.country || 'N/A'}. Images: ${record.imageUrls.join(', ') || 'none'}.`);
    if (!process.argv.includes('--send')) {
        console.log(`[CC LOG] Dry run complete. Found ${candidates.length} strong candidate(s); nothing was sent to Discord.`);
        return;
    }

    await withDiscordClient(async client => {
        const result = await postPreview(client, forum, record);
        console.log(`[CC LOG] Guild Application preview posted: ${result.applicationUrl}`);
        if (result.pollUrl) console.log(`[CC LOG] Guild Application preview poll posted: ${result.pollUrl}`);
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error('[CC LOG] Guild Application preview failed:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    applicationRecord,
    applicationCandidates,
    fetchAllPosts,
    normalizedTestName,
    selectRandomCandidate,
    selectTestSuite,
    strongCandidates,
    structuredFieldCount,
    testOfficerContent,
    testReminderContent,
    nonApplicationCandidates
};
