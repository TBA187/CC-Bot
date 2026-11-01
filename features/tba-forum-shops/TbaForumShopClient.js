'use strict';

// Reads post IDs, authors, timestamps, and message text from one PRO forum topic.
const cheerio = require('cheerio');
const { discoverForumLastPage } = require('../../utils/forumPagination.js');
const { parseRetryAfter } = require('../../utils/forumRetry.js');
const { readResponseBuffer, cancelResponseBody } = require('../../utils/readResponseBuffer.js');
const path = require('path');
const sharp = require('sharp');
const {
    IMAGE_DOWNLOAD_TIMEOUT_MS,
    MAX_IMAGE_BYTES,
    REQUEST_TIMEOUT_MS
} = require('./constants.js');

class TbaForumRequestError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'TbaForumRequestError';
        this.status = options.status || null;
        this.retryAfterMs = options.retryAfterMs || null;
        this.cause = options.cause || null;
    }
}

function cleanText(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/[\t\f\v]+/g, ' ')
        .replace(/[ \u00a0]+\n/g, '\n')
        .replace(/\n[ \u00a0]+/g, '\n')
        .replace(/[ \u00a0]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

class TbaForumShopClient {
    constructor(options = {}) {
        this.topicUrl = String(options.topicUrl || '').trim();
        this.fetch = options.fetch || global.fetch;
        this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
        this.imageTimeoutMs = options.imageTimeoutMs || IMAGE_DOWNLOAD_TIMEOUT_MS;
        this.maxImageBytes = options.maxImageBytes || MAX_IMAGE_BYTES;
        if (!this.topicUrl) throw new Error('A PRO forum shop URL is required.');
        if (typeof this.fetch !== 'function') throw new TypeError('TbaForumShopClient requires a fetch implementation.');
    }

    pageUrl(page = 1) {
        const pageNumber = Math.max(1, Number(page) || 1);
        return pageNumber === 1
            ? this.topicUrl
            : `${this.topicUrl.replace(/\/$/, '')}/page/${pageNumber}/`;
    }

    directPostUrl(page, postId) {
        return `${this.pageUrl(page)}#findComment-${postId}`;
    }

    async request(url, timeoutMs = this.requestTimeoutMs, accept = 'text/html,application/xhtml+xml', consume = response => response) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        timeout.unref?.();

        try {
            const response = await this.fetch(url, {
                signal: controller.signal,
                headers: {
                    accept,
                    'user-agent': 'CrowControlDiscordBot/1.0 (+TBA forum shop monitor)'
                },
                redirect: 'follow'
            });
            if (!response.ok) {
                await cancelResponseBody(response);
                throw new TbaForumRequestError(`PRO Forum request failed with HTTP ${response.status}.`, {
                    status: response.status,
                    retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
                });
            }
            return await consume(response);
        } catch (error) {
            if (error instanceof TbaForumRequestError) throw error;
            const message = controller.signal.aborted || error?.name === 'AbortError'
                ? `PRO Forum request timed out after ${timeoutMs}ms.`
                : `PRO Forum request failed: ${error?.message || error}`;
            throw new TbaForumRequestError(message, { cause: error });
        } finally {
            clearTimeout(timeout);
        }
    }

    discoverLastPage($) {
        return discoverForumLastPage($, this.topicUrl);
    }

    messageText($, content, pageUrl) {
        const clone = content.clone();
        clone.find('img').each((_, element) => {
            const image = $(element);
            const visibleReference = image.attr('alt') || image.attr('data-src') || image.attr('src');
            image.replaceWith(visibleReference ? `\n${visibleReference}\n` : '');
        });
        clone.find('a[href]').each((_, element) => {
            const link = $(element);
            const label = cleanText(link.text());
            try {
                const url = new URL(link.attr('href'), pageUrl).href;
                link.replaceWith(label ? `[${label}](${url})` : url);
            } catch {
                link.replaceWith(label || link.attr('href') || '');
            }
        });
        clone.find('br').replaceWith('\n');
        clone.find('p, div, li, section').each((_, element) => $(element).append('\n'));
        return cleanText(clone.text());
    }

    quotedMessageText($, content, pageUrl) {
        return content.find('blockquote.ipsQuote')
            .toArray()
            .map(element => this.messageText($, $(element), pageUrl))
            .filter(Boolean)
            .join('\n\n');
    }

    imageUrls($, content, pageUrl, warnings = []) {
        const urls = [];
        content.find('img').each((_, element) => {
            const image = $(element);
            const rawUrl = image.closest('a[href]').attr('href') || image.attr('data-src') || image.attr('src');
            if (!rawUrl || /^(?:data:|javascript:)/i.test(rawUrl)) return;
            try {
                const resolved = new URL(rawUrl, pageUrl);
                if (/^https?:$/.test(resolved.protocol)) urls.push(resolved.href);
            } catch {
                warnings.push('image link');
            }
        });
        return urls;
    }

    extractPosts(html, page = 1) {
        const $ = cheerio.load(html);
        const posts = [];
        const pageUrl = this.pageUrl(page);

        const articles = $('article[data-ips-hook="postWrapper"], article[data-commentid]');
        articles.each((_, article) => {
            const wrapper = $(article);
            const postId = wrapper.attr('data-commentid')
                || wrapper.find('[id^="findComment-"]').first().attr('id')?.match(/findComment-(\d+)/i)?.[1]
                || wrapper.attr('id')?.match(/(?:comment|post)[-_]?(\d+)/i)?.[1]
                || wrapper.find('a[href*="#findComment-"]').first().attr('href')?.match(/findComment-(\d+)/i)?.[1];
            if (!postId) return;

            const warnings = [];
            const standardContent = wrapper.find('[data-role="commentContent"]').first();
            const fallbackContent = wrapper.find('.ipsComment_content, .ipsType_richText').first();
            const content = standardContent.length ? standardContent : fallbackContent.length ? fallbackContent : wrapper;
            if (!standardContent.length) warnings.push('message layout');

            const authorLink = wrapper.find('[data-ips-hook="postUsername"] a[href*="/profile/"], .ipsComment_author a[href*="/profile/"]').first();
            const fallbackAuthor = wrapper.find('[data-ips-hook="postUsername"], [itemprop="author"]').first();
            const forumUsername = cleanText(authorLink.text() || fallbackAuthor.text()) || null;
            const time = wrapper.find('time[datetime]').first();
            const postedAt = time.attr('datetime') || time.attr('title') || null;
            const imageUrls = this.imageUrls($, content, pageUrl, warnings);
            const quotedBodyText = this.quotedMessageText($, content, pageUrl);
            const originalContent = content.clone();
            originalContent.find('blockquote.ipsQuote').remove();
            const bodyText = this.messageText($, originalContent, pageUrl);
            if (!forumUsername) warnings.push('forum username');
            if (!postedAt) warnings.push('post timestamp');
            if (!bodyText && !imageUrls.length) warnings.push('message content');

            posts.push({
                postId: String(postId),
                page: Number(page),
                postUrl: this.directPostUrl(page, postId),
                forumUsername: forumUsername || 'Unknown Forum User',
                postedAt,
                bodyText,
                quotedBodyText,
                imageUrls,
                extractionWarnings: [...new Set(warnings)]
            });
        });

        if (posts.length !== articles.length) {
            throw new TbaForumRequestError(`PRO Forum page ${page} contained a post that could not be read; checkpoint retained.`);
        }

        return { posts, lastPage: this.discoverLastPage($) };
    }

    async fetchPage(page = 1) {
        const html = await this.request(this.pageUrl(page), this.requestTimeoutMs, 'text/html,application/xhtml+xml', response => response.text());
        const parsed = this.extractPosts(html, page);
        if (!parsed.posts.length) throw new TbaForumRequestError(`PRO Forum shop page ${page} did not contain any readable posts.`);
        return { page: Number(page), ...parsed };
    }

    imageFilename(url, index, contentType = '') {
        let extension = '';
        try {
            extension = path.extname(new URL(url).pathname).slice(0, 8);
        } catch {
            extension = '';
        }
        if (!/^\.[a-z0-9]{2,7}$/i.test(extension)) {
            const subtype = contentType.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg');
            extension = subtype && /^[a-z0-9]+$/i.test(subtype) ? `.${subtype}` : '.png';
        }
        return `forum-shop-image-${index + 1}${extension}`;
    }

    async downloadImage(url, index) {
        return this.request(
            url,
            this.imageTimeoutMs,
            'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8',
            async response => {
                const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                if (!contentType.startsWith('image/')) {
                    await cancelResponseBody(response);
                    throw new TbaForumRequestError(`Forum attachment is not an image: ${url}`);
                }
                const buffer = await readResponseBuffer(response, this.maxImageBytes,
                    () => new TbaForumRequestError(`Forum image is larger than ${this.maxImageBytes} bytes: ${url}`));
                try {
                    const metadata = await sharp(buffer).metadata();
                    if (!metadata.format || !metadata.width || !metadata.height) {
                        throw new Error('missing image metadata');
                    }
                } catch (error) {
                    throw new TbaForumRequestError(`Forum attachment did not contain a valid image: ${url}`, { cause: error });
                }
                return { url, buffer, name: this.imageFilename(url, index, contentType) };
            }
        );
    }

    async downloadPostImages(post) {
        const images = [];
        for (const [index, url] of (post.imageUrls || []).entries()) {
            try {
                images.push(await this.downloadImage(url, index));
            } catch (error) {
                images.push({ url, buffer: null, name: this.imageFilename(url, index), error });
            }
        }
        return images;
    }
}

module.exports = {
    TbaForumRequestError,
    TbaForumShopClient,
    cleanText,
    parseRetryAfter
};
