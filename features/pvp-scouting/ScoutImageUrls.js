// Reuse signed Discord attachment URLs while they remain valid.
'use strict';

const recent = new Map();
const refreshing = new Map();
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function imageAttachment(attachment) {
    return String(attachment?.contentType || '').startsWith('image/')
        || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/iu.test(attachment?.name || attachment?.url || '');
}

function uniqueImageAttachments(sources) {
    const seen = new Set();
    return sources.flatMap(source => (source.attachments || []).filter(imageAttachment)
        .map(attachment => ({
            url: attachment.url, name: attachment.name, sourceUrl: source.source_url,
            sourceId: String(source.message_id), attachmentId: String(attachment.id || ''),
            date: new Date(source.created_at).getTime() || 0
        })))
        .filter(image => image.url)
        .sort((a, b) => b.date - a.date
            || b.sourceId.localeCompare(a.sourceId, 'en', { numeric: true })
            || b.attachmentId.localeCompare(a.attachmentId, 'en', { numeric: true }))
        .filter(image => {
            const key = image.attachmentId || image.url.split('?')[0];
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function urlIsFresh(value, minimumValidityMs = 5 * 60 * 1000) {
    try {
        const expiry = new URL(String(value || '')).searchParams.get('ex');
        return Boolean(expiry && Number.parseInt(expiry, 16) * 1000 > Date.now() + minimumValidityMs);
    } catch {
        return false;
    }
}

function imageUrlKey(value) {
    try {
        const url = new URL(String(value || ''));
        // Renewing a Discord URL changes its signed query, not the image.
        return `${url.origin}${url.pathname}`;
    } catch {
        return String(value || '');
    }
}

function sameImageUrl(left, right) {
    return Boolean(left && right && imageUrlKey(left) === imageUrlKey(right));
}

function attachmentSignature(attachments) {
    return JSON.stringify(attachments.map(attachment => [String(attachment.id || ''),
        imageUrlKey(attachment.url), attachment.name, attachment.contentType,
        attachment.sourceChannelId, attachment.sourceMessageId]));
}

function copyAttachments(attachments) {
    return attachments.map(attachment => ({ ...attachment }));
}

function renewableImages(row) {
    const images = (row.attachments || []).filter(imageAttachment);
    if (!Object.hasOwn(row.staffOverrides || {}, 'attachments')) return images;
    // Staff-selected images must never be replaced with the original message's
    // full attachment list. Renew only the files with a saved source reference.
    return images.filter(item => /^\d+$/u.test(String(item.id || ''))
        && /^\d+$/u.test(String(item.sourceChannelId || ''))
        && /^\d+$/u.test(String(item.sourceMessageId || '')));
}

function reuseFreshImageAttachments(row) {
    const images = renewableImages(row);
    if (!images.length) return false;
    const id = String(row.message_id);
    const channelId = String(row.channel_id);
    const key = `${channelId}:${id}`;
    const signature = attachmentSignature(row.attachments || []);
    const cached = recent.get(key);
    if (cached && cached.until > Date.now()
        && (cached.sourceSignature === signature || cached.signature === signature)
        && renewableImages({ ...row, attachments: cached.attachments }).every(item => urlIsFresh(item.url))) {
        row.attachments = copyAttachments(cached.attachments);
        return true;
    }
    if (images.every(item => urlIsFresh(item.url))) return true;
    return false;
}

const EMBEDDED_FILE_URL = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/(\d+)\/(\d+)\/([^/?#]+)/u;
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

// Discord leaves a file shown as an embed image (attachment://name) out of the message's attachments
// and gives only its link in the embed, so those files are read from the embed links.
function messageFiles(message) {
    const files = [...(message?.attachments?.values?.() || [])].map(item => ({
        id: String(item.id), name: item.name, url: item.url, proxyURL: item.proxyURL,
        contentType: item.contentType, size: item.size, width: item.width, height: item.height
    }));
    // A member's embeds are link previews, which can show files of other messages.
    if (message?.author && !message.author.bot) return files;
    const channelId = String(message?.channelId || '');
    for (const media of (message?.embeds || []).flatMap(embed => [embed?.image, embed?.thumbnail])) {
        const match = EMBEDDED_FILE_URL.exec(media?.url || '');
        if (!match || match[1] !== channelId || files.some(file => file.id === match[2])) continue;
        let name = match[3];
        try { name = decodeURIComponent(name); } catch { /* The encoded name is still usable. */ }
        files.push({ id: match[2], name, url: media.url, proxyURL: media.proxyURL || media.proxy_url || '',
            contentType: IMAGE_TYPES[name.split('.').at(-1).toLowerCase()] || null, size: null,
            width: media.width ?? null, height: media.height ?? null });
    }
    return files;
}

async function messageAttachments(client, channelId, messageId) {
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    return messageFiles(await channel.messages.fetch({ message: messageId, cache: false, force: true }));
}

async function renewedAttachments(client, row, images) {
    if (!Object.hasOwn(row.staffOverrides || {}, 'attachments')) {
        return messageAttachments(client, String(row.channel_id), String(row.message_id));
    }
    const requests = new Map();
    for (const image of images.filter(item => !urlIsFresh(item.url))) {
        const key = `${image.sourceChannelId}:${image.sourceMessageId}`;
        if (!requests.has(key)) requests.set(key, messageAttachments(client, image.sourceChannelId, image.sourceMessageId));
    }
    // One inaccessible upload source must not prevent renewing the others.
    const renewed = new Map(await Promise.all([...requests].map(async ([key, request]) =>
        [key, await request.catch(() => [])])));
    return (row.attachments || []).map(item => {
        const fresh = renewed.get(`${item.sourceChannelId}:${item.sourceMessageId}`)
            ?.find(attachment => attachment.id === String(item.id));
        return fresh ? { ...item, url: fresh.url, proxyURL: fresh.proxyURL } : { ...item };
    });
}

async function refreshImageAttachments(client, row) {
    const images = renewableImages(row);
    if (!images.length) return false;
    if (reuseFreshImageAttachments(row)) return true;
    const id = String(row.message_id);
    const channelId = String(row.channel_id);
    const key = `${channelId}:${id}`;
    const signature = attachmentSignature(row.attachments || []);
    const requestKey = `${key}:${signature}`;
    let request = refreshing.get(requestKey);
    try {
        if (!request) {
            request = (async () => {
                const attachments = await renewedAttachments(client, row, images);
                recent.set(key, { attachments, sourceSignature: signature,
                    signature: attachmentSignature(attachments), until: Date.now() + CACHE_MS });
                if (recent.size > MAX_CACHE_ENTRIES) recent.delete(recent.keys().next().value);
                return attachments;
            })();
            refreshing.set(requestKey, request);
            if (refreshing.size > MAX_CACHE_ENTRIES) refreshing.delete(refreshing.keys().next().value);
        }
        const attachments = await request;
        // Another action may have changed this row while the REST request ran.
        if (attachmentSignature(row.attachments || []) === signature) {
            row.attachments = copyAttachments(attachments);
        }
        return true;
    } catch {
        return true; // The saved link is still the only available image.
    } finally {
        if (refreshing.get(requestKey) === request) refreshing.delete(requestKey);
    }
}

// Re-upload saved screenshots as real Discord attachments, with a bounded
// download and the upload limit supplied by the interaction.
async function downloadImageAttachment(attachment, maxBytes = 10 * 1024 * 1024) {
    const url = new URL(attachment.url);
    if (url.protocol !== 'https:' || !/(^|\.)discord(?:app)?\.(?:com|net)$/iu.test(url.hostname)) {
        throw new Error('Screenshot URL is not hosted by Discord.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            signal: controller.signal, redirect: 'error', headers: { Accept: 'image/*' }
        });
        if (!response.ok) throw new Error(`Screenshot download failed (HTTP ${response.status}).`);
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        if (!contentType.startsWith('image/')) throw new Error('Screenshot download did not return an image.');
        if (Number(response.headers.get('content-length') || 0) > maxBytes) {
            await response.body?.cancel();
            throw new Error('Screenshot exceeds the Discord upload limit.');
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                throw new Error('Screenshot exceeds the Discord upload limit.');
            }
            chunks.push(Buffer.from(value));
        }
        if (!size) throw new Error('Screenshot download was empty.');
        const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
            'image/gif': 'gif', 'image/avif': 'avif' };
        const extension = extensions[contentType] || 'png';
        const savedName = String(attachment.name || '').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 100);
        const name = savedName && /\.(?:png|jpe?g|webp|gif|avif)$/iu.test(savedName)
            ? savedName : `scout-${attachment.attachmentId || attachment.sourceId}.${extension}`;
        return { attachment: Buffer.concat(chunks, size), name };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { downloadImageAttachment, imageAttachment, messageFiles, uniqueImageAttachments, refreshImageAttachments,
    reuseFreshImageAttachments, sameImageUrl, urlIsFresh };
