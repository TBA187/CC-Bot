// Verifies auction parsing, request validation, cancellation, and network error handling.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuctionForumClient, AuctionForumRequestError } = require('../features/auctions/AuctionForumClient.js');

const listing = `<ul class="ipsPagination" data-pages="3"></ul><ol class="proAuctionList">
<li class="ipsData__item"><h3 class="ipsData__title"><a href="https://pokemonrevolution.net/forum/trade/14722/">First</a></h3></li>
<li class="ipsData__item"><h3 class="ipsData__title"><a href="/forum/trade/14720/">Second</a></h3></li></ol>`;

function detail({ empty = false } = {}) {
    return `<div class="proAuctionViewHeader"><h1>Test &amp; title</h1>
<div class="proAuctionHeader"><span class="ipsBadge">Active</span><span class="ipsBadge">Cross-Server</span><span class="ipsBadge">Pokemon</span><span class="ipsBadge">Auction</span><span class="ipsBadge">Shiny</span></div>
<span class="proAuctionByline"><a href="/forum/profile/1-seller/">Seller</a></span>
${empty ? '<span class="proAuctionMeta proAuctionMeta--stack"><span>Countdown starts with the first qualifying bid.</span><span class="proAuctionMeta__sub"><span>Auction Time: 45 hours after auction start</span></span></span><span class="proAuctionMeta">Highest Bidder: -</span>' : '<span class="proAuctionMeta">Time left: <span data-proauction-countdown="1793714943"></span></span><span class="proAuctionMeta">Highest Bidder: <a href="/forum/profile/2-bidder/">Bidder</a></span>'}</div>
<div><div class="proAuctionPanel__grid"><div><div class="proAuctionPanel__label">Start price</div><div class="proAuctionPanel__value">50.000</div></div><div><div class="proAuctionPanel__label">Instant price</div><div class="proAuctionPanel__value">${empty ? '-' : '1.500.000'}</div></div><div><div class="proAuctionPanel__label">Minimum bid</div><div class="proAuctionPanel__value">50.000</div></div><div><div class="proAuctionPanel__label">Current offer</div><div class="proAuctionPanel__value">${empty ? '-' : '<span>250.000</span><a>Place bid</a>'}</div></div></div>
<div class="proAuctionAttachments"><a class="proAuctionAttachment" href="/forum/uploads/first.png"><img src="/forum/uploads/first.png"></a><a class="proAuctionAttachment" href="/forum/uploads/second.png"><img src="/forum/uploads/second.png"></a></div>
<div class="proAuctionPaymentMethods">Accepted alternative payment methods: Coin Capsule = 500.000</div><div class="ipsRichText--user"><p>Seller description</p></div></div>
<div class="proAuctionHistory">${empty ? '<p>No bids yet.</p>' : '<div class="proAuctionHistory__row"><div class="proAuctionHistory__member"><a href="/forum/profile/2-bidder/">Bidder</a></div><div class="proAuctionHistory__amount">250.000</div><div class="proAuctionHistory__date">2026-11-02 21:09:07</div></div><div class="proAuctionHistory__row proAuctionHistory__row--invalid"><div class="proAuctionHistory__member"><a href="/forum/profile/3-other/">Other</a></div><div class="proAuctionHistory__amount">200.000</div><div class="proAuctionHistory__date">2026-11-02 09:15:03</div></div>'}</div>`;
}

test('listing uses date-added descending and parses all entries and pagination', () => {
    const client = new AuctionForumClient();
    const url = new URL(client.listingUrl(2));
    assert.equal(url.searchParams.get('sort'), 'date_added');
    assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(new URL(client.listingUrl(2, 'inactive')).searchParams.get('status'), 'inactive');
    assert.throws(() => client.listingUrl(1, 'unknown'), /Invalid listing status/);
    assert.deepEqual(client.parseListing(listing, 2), { page: 2, lastPage: 3, auctions: [
        { id: '14722', url: 'https://pokemonrevolution.net/forum/trade/14722/' },
        { id: '14720', url: 'https://pokemonrevolution.net/forum/trade/14720/' }
    ] });
    assert.throws(() => client.parseListing('<html>maintenance</html>'), /not recognized/);
    assert.throws(() => client.parseListing(listing.replace('/trade/14720/', '/topic/14720/')), /unreadable/);
});

test('auction detail preserves prices, tags, images, description and all bids', () => {
    const auction = new AuctionForumClient().parseAuction(detail(), '14628');
    assert.equal(auction.title, 'Test & title');
    assert.equal(auction.server, 'Cross-Server');
    assert.deepEqual(auction.tags, ['Cross-Server', 'Pokemon', 'Auction', 'Shiny']);
    assert.equal(auction.seller.name, 'Seller');
    assert.equal(auction.currentOffer, '250.000');
    assert.equal(auction.instantPrice, '1.500.000');
    assert.equal(auction.highestBidder.name, 'Bidder');
    assert.equal(auction.endsAt, '2026-11-03T14:09:03.000Z');
    assert.equal(auction.description, 'Seller description');
    assert.match(auction.paymentMethods, /Coin Capsule = 500.000/);
    assert.deepEqual(auction.imageUrls, ['https://pokemonrevolution.net/forum/uploads/first.png', 'https://pokemonrevolution.net/forum/uploads/second.png']);
    assert.equal(auction.bids.length, 2);
    assert.equal(auction.bids[0].time, '2026-11-02 21:09:07');
    assert.equal(auction.bids[0].timestamp, null);
    assert.equal(auction.bids[1].invalid, true);
});

test('not-started auction retains empty fields and timing instructions', () => {
    const auction = new AuctionForumClient().parseAuction(detail({ empty: true }), '14702');
    assert.equal(auction.instantPrice, null);
    assert.equal(auction.currentOffer, null);
    assert.equal(auction.highestBidder, null);
    assert.equal(auction.endsAt, null);
    assert.equal(auction.timeLeft, 'Countdown starts with the first qualifying bid.');
    assert.equal(auction.auctionDuration, '45 hours after auction start');
    assert.deepEqual(auction.bids, []);
    assert.throws(() => new AuctionForumClient().parseAuction('<html>maintenance</html>', '14702'), /not recognized/);
});

test('completed listings preserve end price, buyer and price offer status', () => {
    const html = detail()
        .replace('<span class="ipsBadge">Active</span>', '<span class="ipsBadge">Ended</span>')
        .replace('Highest Bidder: <a href="/forum/profile/2-bidder/">Bidder</a>', 'Buyer: <a href="/forum/profile/2-bidder/">Bidder</a>')
        .replace('Current offer</div>', 'End price</div>')
        .replace('<a href="/forum/profile/2-bidder/">Bidder</a></div><div class="proAuctionHistory__amount">', '<a href="/forum/profile/2-bidder/">Bidder</a><span class="ipsBadge">Price offer</span><span class="ipsBadge">Accepted</span></div><div class="proAuctionHistory__amount">');
    const auction = new AuctionForumClient().parseAuction(html, '13077');
    assert.equal(auction.status, 'Ended');
    assert.equal(auction.currentOffer, null);
    assert.equal(auction.endPrice, '250.000');
    assert.equal(auction.buyer.name, 'Bidder');
    assert.equal(auction.highestBidder, null);
    assert.deepEqual(auction.bids[0].labels, ['Price offer', 'Accepted']);
});

test('extracts confirmed UTC sale times and instant-sale prices without guessing missing dates', () => {
    const client = new AuctionForumClient();
    const html = detail({ empty: true }).replace('<span class="ipsBadge">Active</span>', '<span class="ipsBadge">Ended</span>');
    const auction = client.parseAuction(`${html}<div class="ipsMessage ipsMessage--info">Auction Ended: Bidder won this auction with 200.000 Pokedollars on 2026-10-23 10:22 AM UTC.</div>`, '13545');
    assert.equal(auction.endedAt, '2026-10-23T10:22:00.000Z');
    assert.equal(auction.endPrice, '200.000');
    const instant = client.parseAuction(`${html}<div class="ipsMessage ipsMessage--info">Instant Price Purchased: Buyer bought this for 210.000 Pokedollars on 2026-10-23 12:08 AM UTC.</div>`, '13077');
    assert.equal(instant.endedAt, '2026-10-23T00:08:00.000Z');
    assert.equal(instant.endPrice, '210.000');
    const afternoon = client.parseAuction(`${html}<div class="ipsMessage ipsMessage--info">Auction Ended: Buyer won this auction with 200.000 Pokedollars on 2026-10-23 11:08 PM UTC.</div>`, '13545');
    assert.equal(afternoon.endedAt, '2026-10-23T23:08:00.000Z');
    assert.equal(client.parseAuction(`${html}<div class="ipsMessage">Thread Canceled.</div>`, '14689').endedAt, null);
});

test('requests follow only bounded same-origin redirects and require HTML', async () => {
    const seen = [];
    const client = new AuctionForumClient({ fetch: async url => {
        seen.push(url);
        return seen.length === 1
            ? new Response(null, { status: 302, headers: { location: '/forum/trade/14702/' } })
            : new Response(detail({ empty: true }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } });
    assert.equal((await client.fetchAuction('14702')).id, '14702');
    assert.equal(seen.length, 2);
    const external = new AuctionForumClient({ fetch: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } }) });
    await assert.rejects(external.fetchAuction('14702'), /left the forum origin/);
    const badType = new AuctionForumClient({ fetch: async () => new Response('bad', { headers: { 'content-type': 'image/png' } }) });
    await assert.rejects(badType.fetchAuction('14702'), /not HTML/);
    const oversized = new AuctionForumClient({ fetch: async () => new Response('large', { headers: { 'content-type': 'text/html', 'content-length': '5000000' } }) });
    await assert.rejects(oversized.fetchAuction('14702'), /size limit/);
});

test('forum requests cancel on shutdown and distinguish request timeouts', async t => {
    const started = Promise.withResolvers();
    const client = new AuctionForumClient({ fetch: async (_url, { signal }) => {
        started.resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const controller = new AbortController();
    const request = client.fetchListing(1, 'active', { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(request, error => error.code === 'BOT_SHUTTING_DOWN' && !(error instanceof AuctionForumRequestError));
    const keepAlive = setTimeout(() => {}, 1000);
    t.after(() => clearTimeout(keepAlive));
    client.requestTimeoutMs = 10;
    await assert.rejects(client.fetchAuction('14702'), error => {
        assert.ok(error instanceof AuctionForumRequestError);
        assert.equal(error.code, 'ETIMEDOUT');
        assert.equal(error.operation, 'auction 14702');
        assert.match(error.message, /timed out after 10 ms \(auction 14702\)/);
        return true;
    });
    await assert.rejects(client.fetchListing(2, 'inactive'), error => {
        assert.equal(error.operation, 'inactive listings page 2');
        assert.match(error.message, /timed out after 10 ms \(inactive listings page 2\)/);
        return true;
    });
});

test('forum transport errors retain their request context, network cause and server retry hints', async () => {
    const cause = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    const unavailable = new AuctionForumClient({ fetch: async () => { throw cause; } });
    await assert.rejects(unavailable.fetchListing(1), error => {
        assert.ok(error instanceof AuctionForumRequestError);
        assert.equal(error.cause, cause);
        assert.equal(error.code, 'UND_ERR_CONNECT_TIMEOUT');
        assert.equal(error.operation, 'active listings page 1');
        assert.match(error.message, /active listings page 1/);
        return true;
    });
    const limited = new AuctionForumClient({ fetch: async () => new Response(null, { status: 429, headers: { 'retry-after': '300' } }) });
    await assert.rejects(limited.fetchAuction('14702'), error => {
        assert.equal(error.code, 'HTTP_429');
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 300000);
        assert.equal(error.operation, 'auction 14702');
        return true;
    });
});

test('linked description images use image URLs and seller text cannot spoof sale notices', () => {
    const html = detail({ empty: true }).replace('<p>Seller description</p>',
        '<p>Seller description</p><a href="https://example.com/page"><img data-src="https://example.com/pokemon.png"></a><div class="ipsMessage">Auction Ended: Fake won with 999 Pokedollars on 2026-10-23 10:22 AM UTC.</div>');
    const auction = new AuctionForumClient().parseAuction(html, '14702');
    assert.ok(auction.imageUrls.includes('https://example.com/pokemon.png'));
    assert.ok(!auction.imageUrls.includes('https://example.com/page'));
    assert.equal(auction.endedAt, null);
    assert.equal(auction.endPrice, null);
});
