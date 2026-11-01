'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProForumClient } = require('../features/guild-applications/forum/ProForumClient.js');

const html = `
<!doctype html>
<html>
<head><link rel="last" href="https://pokemonrevolution.net/forum/topic/228820-crow-control-in-both-servers-ready-for-new-members/page/12/"></head>
<body>
  <nav data-ips-pagination-pages="12"><a data-page="11"></a><a data-page="12"></a></nav>
  <article data-ips-hook="postWrapper" data-commentid="1729000">
    <div data-ips-hook="postUsername"><a href="/forum/profile/9999-applicant-name/">ApplicantName</a></div>
    <time datetime="2026-07-13T12:00:00Z"></time>
    <div data-role="commentContent">
      <blockquote class="ipsQuote">IGN: QuotedPerson <img src="/quoted.png"></blockquote>
      <p>IGN: RealPerson<br>Age: 22<br>Country: Denmark</p>
      <a href="/forum/uploads/monthly_2026_07/card.png"><img data-src="/forum/uploads/monthly_2026_07/card-small.png" alt="image.png"></a>
      <p class="ipsEdited" data-el="edited">Edited August 1, 2025Aug 1 by ApplicantName</p>
      <img class="ipsEmoji" src="/emoji.png" width="24" height="24">
    </div>
    <div data-role="memberSignature">This signature must not appear.</div>
  </article>
</body>
</html>`;

test('fetched forum pages retain extracted data without raw HTML or a DOM tree', async () => {
    const client = new ProForumClient({ fetch: async () => ({ ok: true, text: async () => html }) });
    const page = await client.fetchPage(1);
    assert.equal(page.posts.length, 1);
    assert.equal(Object.hasOwn(page, 'html'), false);
    assert.equal(Object.hasOwn(client.extractPosts(html, 1), '$'), false);
});

test('discovers dynamic pagination and isolates the applicant post body', () => {
    const client = new ProForumClient({ fetch: async () => { throw new Error('not used'); } });
    const parsed = client.extractPosts(html, 12);

    assert.equal(parsed.lastPage, 12);
    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.posts[0].postId, '1729000');
    assert.equal(parsed.posts[0].forumUserId, '9999');
    assert.equal(parsed.posts[0].forumUsername, 'ApplicantName');
    assert.match(parsed.posts[0].bodyText, /IGN: RealPerson/);
    assert.doesNotMatch(parsed.posts[0].bodyText, /QuotedPerson|signature|Edited August/i);
    assert.deepEqual(parsed.posts[0].imageUrls, [
        'https://pokemonrevolution.net/forum/uploads/monthly_2026_07/card.png'
    ]);
    assert.equal(
        parsed.posts[0].postUrl,
        'https://pokemonrevolution.net/forum/topic/228820-crow-control-in-both-servers-ready-for-new-members/page/12/#findComment-1729000'
    );
});

test('uses page one when no pagination metadata exists', () => {
    const client = new ProForumClient({ fetch: async () => { throw new Error('not used'); } });
    assert.equal(client.extractPosts('<html><body></body></html>', 1).lastPage, 1);
});

test('prioritizes the image attached to the trainer-card section', () => {
    const client = new ProForumClient({ fetch: async () => { throw new Error('not used'); } });
    const parsed = client.extractPosts(`
        <article data-commentid="200" data-ips-hook="postWrapper">
          <div data-ips-hook="postUsername"><a href="/forum/profile/9-applicant/">Applicant</a></div>
          <div data-role="commentContent">
            <p>Here is another screenshot:</p>
            <p><img src="/forum/uploads/team.png" alt="screenshot.png"></p>
            <p>Screenshot of Your Pokémon ID:</p>
            <p><img src="/forum/uploads/trainer.png" alt="image.png"></p>
          </div>
        </article>
    `, 1);

    assert.deepEqual(parsed.posts[0].imageUrls, [
        'https://pokemonrevolution.net/forum/uploads/trainer.png',
        'https://pokemonrevolution.net/forum/uploads/team.png'
    ]);
});

test('ignores CDN Twemoji assets even when their dimensions exceed the emoji size check', () => {
    const client = new ProForumClient({ fetch: async () => { throw new Error('not used'); } });
    const parsed = client.extractPosts(`
        <article data-commentid="201" data-ips-hook="postWrapper">
          <div data-ips-hook="postUsername"><a href="/forum/profile/9-applicant/">Applicant</a></div>
          <div data-role="commentContent">
            <img src="https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4cc.png">
            <img src="/forum/uploads/monthly_2026_07/trainer.png" alt="trainer card">
          </div>
        </article>
    `, 1);

    assert.deepEqual(parsed.posts[0].imageUrls, [
        'https://pokemonrevolution.net/forum/uploads/monthly_2026_07/trainer.png'
    ]);
});

test('removes copied recruitment-template images learned from the topic owner', () => {
    const client = new ProForumClient({ fetch: async () => { throw new Error('not used'); } });
    const parsed = client.extractPosts(`
        <article data-commentid="1" data-ips-hook="postWrapper">
          <div data-ips-hook="postUsername"><a href="/forum/profile/163701-vangogsan/">Vangogsan</a></div>
          <div data-role="commentContent">
            <img src="https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4cc.png">
            <img src="/forum/uploads/monthly_2026_01/cc.png.14a076b219f04cdecfd7863e4969cab3.png">
          </div>
        </article>
        <article data-commentid="2" data-ips-hook="postWrapper">
          <div data-ips-hook="postUsername"><a href="/forum/profile/9-applicant/">Applicant</a></div>
          <div data-role="commentContent">
            <p>IGN: Applicant<br>Age: 22<br>Country: Denmark</p>
            <img src="https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4cc.png">
            <img src="/forum/uploads/monthly_2026_01/cc.png.14a076b219f04cdecfd7863e4969cab3.png">
            <img src="/forum/uploads/monthly_2026_07/trainer-card.png" alt="trainer card">
          </div>
        </article>
    `, 1);

    assert.deepEqual(parsed.posts[0].imageUrls, []);
    assert.deepEqual(parsed.posts[1].imageUrls, [
        'https://pokemonrevolution.net/forum/uploads/monthly_2026_07/trainer-card.png'
    ]);
    assert.equal(client.getTemplateImageUrls().length, 2);
});

test('keeps the public image URL when an attachment download fails validation', async () => {
    const client = new ProForumClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
            arrayBuffer: async () => new TextEncoder().encode('not an image').buffer
        })
    });
    const [image] = await client.downloadPostImages({ imageUrls: ['https://example.com/card.png'] });

    assert.equal(image.url, 'https://example.com/card.png');
    assert.equal(image.buffer, null);
    assert.match(image.error.message, /not an image/i);
});

test('later Vangogsan posts retain real application images instead of being treated as recruitment templates', () => {
    const client = new ProForumClient();
    const parsed = client.extractPosts(`<article data-commentid="123"><div data-ips-hook="postUsername">
        <a href="/forum/profile/163701-vangogsan/">Vangogsan</a></div>
        <div data-role="commentContent"><p>IGN: Vangogsan</p><img src="/forum/uploads/trainer.png" alt="Trainer card"></div></article>`, 2);
    assert.deepEqual(parsed.posts[0].imageUrls, ['https://pokemonrevolution.net/forum/uploads/trainer.png']);
    assert.deepEqual(client.getTemplateImageUrls(), []);
});
