// Fetches and parses PRO auction listings, auction details, and bid histories.
'use strict';

const cheerio = require('cheerio');
const { readResponseBuffer, cancelResponseBody } = require('../../utils/readResponseBuffer.js');
const { parseRetryAfter } = require('../../utils/forumRetry.js');
const { shutdownError, throwIfAborted } = require('../../utils/abortable.js');
const { networkErrorCode } = require('../../utils/networkErrors.js');

const ORIGIN = 'https://pokemonrevolution.net';
const TRADE_URL = `${ORIGIN}/forum/trade/`;
const LIST_URL = `${ORIGIN}/forum/index.php?app=proauctions&module=auction&controller=auctions&content_type=pokemon&sort=date_added&direction=desc`;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

class AuctionForumRequestError extends Error {
    constructor(message, { cause, code, status, retryAfterMs, operation } = {}) {
        super(message, { cause });
        this.name = 'AuctionForumRequestError';
        Object.assign(this, { code, status, retryAfterMs, operation });
    }
}

function clean(value) {
    const text = String(value || '').replace(/\u00a0/g, ' ').replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text && text !== '-' ? text : null;
}

function safeUrl(value, base = TRADE_URL) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value, base);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function identity($, element) {
    const link = $(element).find('a[href*="/profile/"]').first();
    const name = clean(link.text());
    return name ? { name, url: safeUrl(link.attr('href')) } : null;
}

function completedSale($) {
    const message = $('.ipsMessage').filter((_, node) => !$(node).closest('.ipsRichText--user').length)
        .map((_, node) => clean($(node).text())).get()
        .find(value => /^(?:Auction Ended|Instant Price Purchased):/i.test(value || '')) || '';
    const date = /\bon (\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM) UTC\b/i.exec(message);
    let endedAt = null;
    if (date) {
        const [, year, month, day, hours, minutes, meridiem] = date;
        const hour = Number(hours) % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
        const iso = `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${minutes}:00.000Z`;
        const instant = new Date(iso);
        if (Number(hours) >= 1 && Number(hours) <= 12 && !Number.isNaN(instant.getTime()) && instant.toISOString() === iso) endedAt = iso;
    }
    const amount = /\b(?:with|for)\s+([\d.,]+)\s+Pokedollars\b/i.exec(message)?.[1] || null;
    return { endedAt, amount };
}

class AuctionForumClient {
    constructor(options = {}) {
        this.fetch = options.fetch || global.fetch;
        this.requestTimeoutMs = options.requestTimeoutMs || 15000;
        if (typeof this.fetch !== 'function') throw new TypeError('AuctionForumClient requires fetch.');
    }

    async request(url, options = {}) {
        throwIfAborted(options.signal);
        const controller = new AbortController();
        const onAbort = () => controller.abort(shutdownError());
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        timer.unref?.();
        try {
            let currentUrl = new URL(url);
            for (let redirects = 0; redirects <= 3; redirects++) {
                if (currentUrl.origin !== ORIGIN || currentUrl.username || currentUrl.password) throw new Error('PRO auction redirect left the forum origin.');
                const response = await this.fetch(currentUrl.href, { signal: controller.signal, redirect: 'manual', headers: {
                    'user-agent': 'CrowControlDiscordBot/1.0 (+auction monitor)',
                    accept: 'text/html,application/xhtml+xml'
                } });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get('location');
                    await cancelResponseBody(response);
                    if (!location || redirects === 3) throw new Error('PRO auction redirect limit or invalid location.');
                    currentUrl = new URL(location, currentUrl);
                    continue;
                }
                if (!response.ok) {
                    await cancelResponseBody(response);
                    const error = new Error(`PRO auction request failed with HTTP ${response.status}.`);
                    error.status = response.status;
                    error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
                    throw error;
                }
                const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/.test(contentType)) {
                    await cancelResponseBody(response);
                    throw new Error('PRO auction response was not HTML.');
                }
                const bytes = await readResponseBuffer(response, MAX_HTML_BYTES, () => new Error('PRO auction page exceeds size limit.'));
                return bytes.toString('utf8');
            }
        } catch (error) {
            throwIfAborted(options.signal);
            const operation = options.operation || 'forum page';
            const message = controller.signal.aborted ? `PRO auction request timed out after ${this.requestTimeoutMs} ms`
                : String(error.message || 'PRO auction request failed').replace(/\.$/, '');
            throw new AuctionForumRequestError(`${message} (${operation}).`, {
                cause: error, operation, status: error.status, retryAfterMs: error.retryAfterMs,
                code: controller.signal.aborted ? 'ETIMEDOUT' : error.status ? `HTTP_${error.status}` : networkErrorCode(error)
            });
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }

    listingUrl(page, status = 'active') {
        if (!['active', 'inactive'].includes(status)) throw new TypeError('Invalid listing status.');
        const url = new URL(LIST_URL);
        if (status === 'inactive') url.searchParams.set('status', status);
        url.searchParams.set('page', String(page));
        return url.href;
    }

    parseListing(html, page = 1) {
        const $ = cheerio.load(html);
        const list = $('.proAuctionList').first();
        if (!list.length) throw new Error('PRO auction listing was not recognized.');
        const auctions = [];
        list.children('.ipsData__item').each((_, element) => {
            const href = $(element).find('.ipsData__title a[href]').first().attr('href');
            const url = safeUrl(href);
            const parsed = url && new URL(url);
            const match = parsed && parsed.origin === ORIGIN && parsed.pathname.match(/^\/forum\/trade\/(\d+)\/?$/);
            if (!match) throw new Error('PRO auction listing contains an unreadable entry.');
            auctions.push({ id: match[1], url: `${TRADE_URL}${match[1]}/` });
        });
        const rawPages = $('.ipsPagination[data-pages]').first().attr('data-pages');
        const lastPage = rawPages ? Number(rawPages) : 1;
        if (!Number.isSafeInteger(lastPage) || lastPage < 1) throw new Error('PRO auction pagination was not recognized.');
        return { page: Number(page), auctions, lastPage };
    }

    async fetchListing(page = 1, status = 'active', options = {}) {
        if (!Number.isSafeInteger(Number(page)) || Number(page) < 1) throw new TypeError('Invalid listing page.');
        return this.parseListing(await this.request(this.listingUrl(page, status),
            { ...options, operation: `${status} listings page ${Number(page)}` }), Number(page));
    }

    parseAuction(html, id) {
        if (!/^\d+$/.test(String(id))) throw new TypeError('Invalid auction ID.');
        const $ = cheerio.load(html);
        const header = $('.proAuctionViewHeader').first();
        const title = clean(header.find('h1').first().text());
        const badges = header.find('.proAuctionHeader .ipsBadge').map((_, node) => clean($(node).text())).get().filter(Boolean);
        if (!title || !badges.length || !$('.proAuctionPanel__grid').length || !$('.proAuctionHistory').length) {
            throw new Error(`PRO auction ${id} page was not recognized.`);
        }
        const seller = identity($, header.find('.proAuctionByline'));
        if (!seller) throw new Error(`PRO auction ${id} seller was not recognized.`);
        const values = {};
        $('.proAuctionPanel__grid .proAuctionPanel__label').each((_, node) => {
            const label = clean($(node).text())?.toLowerCase();
            const value = $(node).next('.proAuctionPanel__value').clone();
            value.find('a, button').remove();
            values[label] = clean(value.text());
        });
        let highestBidder = null;
        let buyer = null;
        header.find('.proAuctionMeta').each((_, node) => {
            if (/highest bidder\s*:/i.test($(node).text())) highestBidder = identity($, node);
            if (/^\s*buyer\s*:/i.test($(node).text())) buyer = identity($, node);
        });
        const countdown = header.find('[data-proauction-countdown]').first().attr('data-proauction-countdown');
        const seconds = /^\d+$/.test(countdown || '') ? Number(countdown) : NaN;
        const endsAt = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8640000000000 / 1000 ? new Date(seconds * 1000).toISOString() : null;
        const stack = header.find('.proAuctionMeta--stack');
        const timeLeft = clean(stack.children('span').first().text()) || (endsAt ? null : clean(header.find('.proAuctionMeta').filter((_, n) => /time left:/i.test($(n).text())).first().text().replace(/^\s*time left:\s*/i, '')));
        const auctionDuration = clean(stack.find('.proAuctionMeta__sub span').filter((_, n) => /auction time:/i.test($(n).text())).first().text().replace(/^\s*auction time:\s*/i, ''));
        const completed = completedSale($);
        const richSource = $('.proAuctionPanel__grid').parent().find('.ipsRichText--user').first();
        const rich = richSource.clone();
        rich.find('script, style, img').remove();
        rich.find('br').replaceWith('\n');
        rich.find('p, div, li').append('\n');
        const description = clean(rich.text());
        const paymentMethods = clean($('.proAuctionPaymentMethods').first().text());
        const imageUrls = [];
        $('.proAuctionAttachments a.proAuctionAttachment[href], .ipsRichText--user img').each((_, node) => {
            const image = $(node);
            const linked = safeUrl(image.closest('a[href]').attr('href'));
            const directImage = linked && /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(linked);
            const raw = image.is('img') ? (directImage ? linked : image.attr('data-src') || image.attr('src')) : image.attr('href');
            const url = safeUrl(raw);
            if (url && !imageUrls.includes(url)) imageUrls.push(url);
        });
        const bids = [];
        $('.proAuctionHistory__row').each((_, node) => {
            const row = $(node);
            const bidder = identity($, row.find('.proAuctionHistory__member'));
            const amount = clean(row.find('.proAuctionHistory__amount').first().text());
            if (!bidder || !amount) throw new Error(`PRO auction ${id} has an unreadable bid.`);
            const labels = row.find('.proAuctionHistory__member .ipsBadge').map((__, badge) => clean($(badge).text())).get().filter(Boolean);
            bids.push({ bidder, amount, time: clean(row.find('.proAuctionHistory__date').text()), timestamp: null, labels,
                invalid: row.hasClass('proAuctionHistory__row--invalid') || row.find('.proAuctionHistory__amount--invalid').length > 0 });
        });
        return { id: String(id), url: `${TRADE_URL}${id}/`, title, status: badges[0],
            server: badges.find(value => /^(?:gold|silver|cross-server)$/i.test(value)) || null,
            tags: badges.slice(1), seller, startPrice: values['start price'] || null,
            instantPrice: values['instant price'] || null, minimumBid: values['minimum bid'] || null,
            currentOffer: values['current offer'] || null, endPrice: values['end price'] || completed.amount, highestBidder, buyer, timeLeft, auctionDuration,
            endsAt, endedAt: completed.endedAt, description, paymentMethods, imageUrls, bids };
    }

    async fetchAuction(id, options = {}) {
        if (!/^\d+$/.test(String(id))) throw new TypeError('Invalid auction ID.');
        return this.parseAuction(await this.request(`${TRADE_URL}${id}/`, { ...options, operation: `auction ${id}` }), String(id));
    }
}

module.exports = { AuctionForumClient, AuctionForumRequestError };
