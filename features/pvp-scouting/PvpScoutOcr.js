// Reads Discord-hosted screenshots in memory and finds result cards before running OCR.
'use strict';

const sharp = require('sharp');
const { ocrWorkerPoolFor, configureImageMemory } = require('../../utils/runtimeMemoryOcr.js');
configureImageMemory(sharp);
const { candidateFromOcr, closeIgnSpelling, nameFromResultLine, normalizeIgn,
    opponentFromBattleBanner } = require('./PvpScoutParser.js');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 30 * 1000 * 1000;
const MAX_OCR_WIDTH = 2400;
const MAX_FRAME_SCAN_DIMENSION = 1600;
const SCAN_VERSION = 8;

async function battleBannerBands(image, sharpInstance, width, height) {
    // The yellow VS marker sits on a dark battle banner. Scan the entire
    // screenshot so photos of a monitor and cropped game windows also work.
    const scale = Math.min(1, 1000 / width);
    const sample = scale < 1 ? sharpInstance(image).resize({ width: Math.round(width * scale) }) : sharpInstance(image);
    const { data, info } = await sample.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const scores = [];
    for (let y = 0; y < info.height; y += 2) {
        let yellow = 0;
        let dark = 0;
        let count = 0;
        for (let x = Math.floor(info.width * 0.12); x < info.width * 0.95; x += 2) {
            const offset = (y * info.width + x) * info.channels;
            const r = data[offset], g = data[offset + 1], b = data[offset + 2];
            if (r > 140 && g > 90 && b < Math.min(145, g * 0.8)
                && r > b * 1.7 && g > b * 1.3) yellow++;
            if (Math.max(r, g, b) < 125) dark++;
            count++;
        }
        const score = yellow * (dark / Math.max(1, count)) ** 2;
        if (score >= 5) scores.push({ y, score });
    }
    const bands = [];
    for (const item of scores.sort((a, b) => b.score - a.score)) {
        if (bands.some(other => Math.abs(other.y - item.y) < 24)) continue;
        const top = Math.max(0, Math.floor((item.y - 18) / scale));
        const bottom = Math.min(height, Math.ceil((item.y + 85) / scale));
        if (bottom - top >= 24) bands.push({ left: 0, top, width, height: bottom - top });
        if (bands.length >= 3) break;
    }
    return bands;
}

async function detectResultCardFrame(image, sharpInstance, width, height) {
    // The result card has a long blue top edge and two blue sides. Locate the frame,
    // rather than assuming a fixed position in a screenshot of the game window.
    const scale = Math.min(1, MAX_FRAME_SCAN_DIMENSION / Math.max(width, height));
    const scan = scale < 1 ? sharpInstance(image).resize({ width: Math.round(width * scale) }) : sharpInstance(image);
    const { data, info } = await scan.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const scanWidth = info.width;
    const scanHeight = info.height;
    const blueAt = (x, y) => {
        const offset = (y * scanWidth + x) * info.channels;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        // A photo of a monitor can turn the cyan border dark blue or nearly white.
        return blue >= 75 && green >= 60 && blue >= red + 30
            && green >= red + 15 && blue >= green - 15;
    };
    const minTop = Math.max(30, Math.round(scanWidth * 0.035));
    const minSide = Math.max(18, Math.round(scanHeight * 0.035));
    const gapAllowance = Math.max(3, Math.round(Math.min(scanWidth, scanHeight) * 0.008));
    const visualEvidence = (left, top, right, bottom) => {
        // Repeated red team circles over a dark panel distinguish the result card
        // from the blue outlines elsewhere in the game UI.
        let dark = 0;
        let red = 0;
        let count = 0;
        const insetX = (right - left) * 0.03;
        const insetY = (bottom - top) * 0.09;
        for (let y = top + insetY; y < bottom - insetY; y += Math.max(2, (bottom - top) / 20)) {
            for (let x = left + insetX; x < right - insetX; x += Math.max(2, (right - left) / 40)) {
                const offset = (Math.floor(y) * scanWidth + Math.floor(x)) * info.channels;
                const r = data[offset];
                const g = data[offset + 1];
                const b = data[offset + 2];
                if (Math.max(r, g, b) < 95) dark++;
                if (r > 55 && r > g * 1.35 && r > b * 1.2) red++;
                count++;
            }
        }
        const darkRatio = count ? dark / count : 0;
        const redRatio = count ? red / count : 0;
        return {
            supported: darkRatio >= 0.5 || (darkRatio >= 0.18 && redRatio >= 0.025),
            score: 0.35 + darkRatio + Math.min(2, redRatio * 16)
        };
    };
    const edges = [];
    for (let y = 0; y < scanHeight; y++) {
        let start = -1;
        let hits = 0;
        let gap = 0;
        for (let x = 0; x <= scanWidth; x++) {
            const isBlue = x < scanWidth && blueAt(x, y);
            if (isBlue) {
                if (start < 0) start = x;
                hits++;
                gap = 0;
            } else if (start >= 0 && (++gap > gapAllowance || x === scanWidth)) {
                const end = x - gap;
                if (end - start + 1 >= minTop && hits / (end - start + 1) >= 0.55) {
                    edges.push({ left: start, right: end, top: y });
                }
                start = -1;
                hits = 0;
                gap = 0;
            }
        }
    }
    const sideEnd = (x, top) => {
        let best = top;
        for (let nearX = Math.max(0, x - 4); nearX <= Math.min(scanWidth - 1, x + 4); nearX++) {
            let gap = 0;
            let end = top;
            let started = false;
            for (let y = top; y < scanHeight && gap <= gapAllowance; y++) {
                if (blueAt(nearX, y)) {
                    end = y;
                    started = true;
                    gap = 0;
                } else if (started) {
                    gap++;
                } else if (y - top > gapAllowance) {
                    break;
                }
            }
            best = Math.max(best, end);
        }
        return best;
    };
    const distinctEdges = [];
    for (const edge of edges.sort((a, b) => (b.right - b.left) - (a.right - a.left))) {
        if (distinctEdges.some(other => Math.abs(other.top - edge.top) <= 5
            && Math.abs(other.left - edge.left) <= 5 && Math.abs(other.right - edge.right) <= 5)) continue;
        distinctEdges.push(edge);
        if (distinctEdges.length >= 80) break;
    }
    const candidates = [];
    for (const edge of distinctEdges) {
        const leftEnd = sideEnd(edge.left, edge.top);
        const rightEnd = sideEnd(edge.right, edge.top);
        const sideLength = Math.min(leftEnd, rightEnd) - edge.top;
        const cardWidth = edge.right - edge.left + 1;
        if (sideLength < minSide || cardWidth / sideLength < 1.3 || cardWidth / sideLength > 6) continue;
        const evidence = visualEvidence(edge.left, edge.top, edge.right, Math.max(leftEnd, rightEnd));
        if (!evidence.supported) continue;
        // Keep OCR inside the transparent card: text visible immediately below
        // its lower edge belongs to the background, not the opponent label.
        const padding = 1;
        candidates.push({ left: edge.left, top: edge.top, right: edge.right + 1,
            bottom: Math.min(scanHeight, Math.max(leftEnd, rightEnd) + padding + 1),
            score: cardWidth * sideLength * evidence.score * 1.1 });
    }
    // Uploads sometimes remove the top edge while leaving the two sides. Check
    // those as candidates too, even if another blue rectangle has a top edge.
    const sides = [];
    for (let x = 0; x < scanWidth; x++) {
        let start = -1;
        let lastBlue = -1;
        for (let y = 0; y <= scanHeight; y++) {
            if (y < scanHeight && blueAt(x, y)) {
                if (start < 0) start = y;
                lastBlue = y;
            } else if (start >= 0 && (y - lastBlue > gapAllowance || y === scanHeight)) {
                if (lastBlue - start >= minSide) sides.push({ x, top: start, bottom: lastBlue });
                start = -1;
            }
        }
    }
    const likelySides = sides.sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top)).slice(0, 180);
    const pairs = [];
    for (const leftSide of likelySides) {
        for (const rightSide of likelySides) {
            const cardWidth = rightSide.x - leftSide.x;
            if (cardWidth < Math.max(60, scanWidth * 0.07)) continue;
            const overlapTop = Math.max(leftSide.top, rightSide.top);
            const overlapBottom = Math.min(leftSide.bottom, rightSide.bottom);
            const overlap = overlapBottom - overlapTop;
            if (overlap < minSide || cardWidth / overlap < 1.3 || cardWidth / overlap > 8) continue;
            const alignment = Math.abs(leftSide.top - rightSide.top) + Math.abs(leftSide.bottom - rightSide.bottom);
            const roughScore = cardWidth * overlap / (1 + alignment / Math.max(overlap, 1));
            pairs.push({ leftSide, rightSide, overlapTop, overlapBottom, roughScore });
        }
    }
    for (const pair of pairs.sort((a, b) => b.roughScore - a.roughScore).slice(0, 120)) {
        const evidence = visualEvidence(pair.leftSide.x, pair.overlapTop,
            pair.rightSide.x, pair.overlapBottom);
        if (!evidence.supported) continue;
        candidates.push({ left: pair.leftSide.x, top: pair.overlapTop, right: pair.rightSide.x + 1,
            bottom: Math.min(scanHeight, pair.overlapBottom + 1),
            score: pair.roughScore * evidence.score });
    }
    const selected = candidates.sort((a, b) => b.score - a.score)[0];
    if (!selected) return null;
    const left = Math.max(0, Math.floor(selected.left / scale));
    const top = Math.max(0, Math.floor(selected.top / scale));
    const right = Math.min(width, Math.ceil(selected.right / scale));
    const bottom = Math.min(height, Math.ceil(selected.bottom / scale));
    return { left, top, width: right - left, height: bottom - top };
}

async function looksLikeFullResultCard(image, sharpInstance, width, height) {
    // Some uploads cut off every blue edge. A card that fills the image still
    // shows a dark panel and a row of red team circles across most of its width.
    if (width / height < 1.4) return false;
    const sample = width > 900 ? sharpInstance(image).resize({ width: 900 }) : sharpInstance(image);
    const { data, info } = await sample.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const bins = Array.from({ length: 6 }, () => ({ red: 0, total: 0 }));
    let dark = 0;
    let total = 0;
    for (let y = Math.floor(info.height * 0.08); y < Math.floor(info.height * 0.78); y += 3) {
        for (let x = Math.floor(info.width * 0.03); x < Math.floor(info.width * 0.97); x += 3) {
            const offset = (y * info.width + x) * info.channels;
            const red = data[offset];
            const green = data[offset + 1];
            const blue = data[offset + 2];
            const bin = bins[Math.min(5, Math.floor(x / info.width * 6))];
            if (red > 55 && red > green * 1.35 && red > blue * 1.2) bin.red++;
            bin.total++;
            if (Math.max(red, green, blue) < 95) dark++;
            total++;
        }
    }
    return total > 0 && dark / total >= 0.25
        && bins.filter(bin => bin.total && bin.red / bin.total >= 0.035).length >= 5;
}

function normalizedLine(line) {
    if (typeof line === 'string') return { text: line.trim(), bbox: null };
    const bbox = line?.bbox || line?.boundingBox || null;
    return {
        text: String(line?.text || '').trim(),
        bbox: bbox && [bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
            ? { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 }
            : null
    };
}

function levelRows(lines, width, height) {
    const markers = (Array.isArray(lines) ? lines : [])
        .map(normalizedLine)
        .filter(line => line.bbox && /\blv\.?\s*1?00\b/iu.test(line.text))
        .sort((a, b) => ((a.bbox.y0 + a.bbox.y1) / 2) - ((b.bbox.y0 + b.bbox.y1) / 2));
    if (markers.length < 6) return [];

    const threshold = Math.max(24, height * 0.035);
    const rows = [];
    for (const marker of markers) {
        const centerY = (marker.bbox.y0 + marker.bbox.y1) / 2;
        let row = rows.find(candidate => Math.abs(candidate.centerY - centerY) <= threshold);
        if (!row) {
            row = { centerY, markers: [] };
            rows.push(row);
        }
        row.markers.push(marker);
        row.centerY = row.markers.reduce((sum, item) => sum + (item.bbox.y0 + item.bbox.y1) / 2, 0) / row.markers.length;
    }
    return rows
        .filter(row => row.markers.length >= 6)
        .map(row => ({ ...row, markers: row.markers.sort((a, b) => a.bbox.x0 - b.bbox.x0) }))
        .sort((a, b) => a.centerY - b.centerY);
}

function targetLabelNearRow(lines, ign, row, width, height) {
    const target = normalizeIgn(ign);
    if (!target) return false;
    const normalized = (Array.isArray(lines) ? lines : []).map(normalizedLine);
    return normalized.some(line => {
        if (!line.bbox || !line.text) return false;
        const text = normalizeIgn(line.text.replace(/^.*?\bvs\.?\s*/iu, ''));
        if (text !== target && !text?.includes(target)) return false;
        return Math.abs((line.bbox.y0 + line.bbox.y1) / 2 - row.centerY) <= height * 0.24
            || (line.bbox.x0 <= width * 0.2 && line.bbox.y0 > row.centerY);
    });
}

function verticalOpponentRoster(lines, width, height, ign) {
    const target = normalizeIgn(ign);
    if (!target) return null;
    const normalized = (Array.isArray(lines) ? lines : []).map(normalizedLine).filter(line => line.bbox && line.text);
    const hasVsTarget = normalized.some(line => {
        const text = normalizeIgn(line.text);
        return /\bvs\.?\b/iu.test(line.text) && text?.includes(target);
    });
    if (!hasVsTarget) return null;

    const markers = normalized
        .filter(line => /\blv\.?\s*1?00\b/iu.test(line.text))
        .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const xThreshold = Math.max(18, width * 0.035);
    const columns = [];
    for (const marker of markers) {
        const centerX = (marker.bbox.x0 + marker.bbox.x1) / 2;
        let column = columns.find(item => Math.abs(item.centerX - centerX) <= xThreshold);
        if (!column) {
            column = { centerX, markers: [] };
            columns.push(column);
        }
        column.markers.push(marker);
        column.centerX = column.markers.reduce((sum, item) => sum + (item.bbox.x0 + item.bbox.x1) / 2, 0) / column.markers.length;
    }
    const roster = columns
        .filter(column => column.markers.length >= 6 && column.centerX <= width * 0.2)
        .map(column => ({ ...column, markers: column.markers.sort((a, b) => a.bbox.y0 - b.bbox.y0) }))
        .sort((a, b) => a.centerX - b.centerX)[0];
    if (!roster) return null;

    const first = roster.markers[0].bbox;
    const last = roster.markers.at(-1).bbox;
    const top = Math.max(0, Math.floor(first.y0 - height * 0.045));
    const bottom = Math.min(height, Math.ceil(last.y1 + height * 0.045));
    const right = Math.min(width, Math.ceil(Math.max(width * 0.18, ...roster.markers.map(marker => marker.bbox.x1)) + width * 0.035));
    if (bottom - top < height * 0.45 || right < width * 0.12) return null;
    return { left: 0, top, width: right, height: bottom - top };
}

function detectTeamRegion(lines, width, height, ign) {
    // This only checks whether a roster can be identified; the bot displays the original Discord image.
    const rows = levelRows(lines, width, height);
    if (!rows.length) {
        const verticalRect = verticalOpponentRoster(lines, width, height, ign);
        if (verticalRect) return { status: 'recognized', rect: verticalRect, layout: 'vertical_battle_roster' };
        return { status: 'uncertain', reason: 'Could not confidently locate a six-Pokémon roster.' };
    }

    const row = rows.at(-1); // In team-preview images with two rows, the opponent is the lower row.
    const markers = row.markers.slice(-6);
    const hasTargetLabel = targetLabelNearRow(lines, ign, row, width, height);
    if (!hasTargetLabel) {
        return { status: 'uncertain', reason: 'Roster was found, but its opponent label could not be matched.' };
    }

    const first = markers[0].bbox;
    const last = markers.at(-1).bbox;
    const markerHeight = Math.max(...markers.map(marker => marker.bbox.y1 - marker.bbox.y0));
    const verticalPadding = Math.max(markerHeight * 5, height * 0.12);
    const columnGap = markers.length > 1
        ? (last.x0 - first.x0) / (markers.length - 1)
        : width * 0.12;
    const horizontalPadding = Math.max(columnGap * 0.55, width * 0.025);
    const left = Math.max(0, Math.floor(first.x0 - horizontalPadding));
    const right = Math.min(width, Math.ceil(last.x1 + horizontalPadding));
    const top = Math.max(0, Math.floor(row.centerY - verticalPadding));
    const bottom = Math.min(height, Math.ceil(row.centerY + markerHeight * 1.8));
    const rect = { left, top, width: right - left, height: bottom - top };
    if (rect.width < width * 0.35 || rect.height < height * 0.1) {
        return { status: 'uncertain', reason: 'The detected roster crop was too small to trust.' };
    }
    const areaRatio = (rect.width * rect.height) / (width * height);
    return { status: 'recognized', rect, areaRatio };
}

class PvpScoutOcr {
    constructor(options = {}) {
        this.sharp = options.sharp || sharp;
        this.fetch = options.fetch || globalThis.fetch;
        this.workerPool = ocrWorkerPoolFor(options);
        this.maxImageBytes = options.maxImageBytes || MAX_IMAGE_BYTES;
        this.activityLabel = options.activityLabel || 'PvP Scout';
        this.isolatedPipeline = !options.workerPool && !options.worker && !options.workerFactory && !options.sharp && !options.fetch;
    }

    async download(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error('Invalid image URL.');
        }
        if (parsed.protocol !== 'https:' || !/(^|\.)discord(?:app)?\.(?:com|net)$/i.test(parsed.hostname)) {
            throw new Error('Only Discord-hosted image attachments can be processed.');
        }
        if (!this.fetch) throw new Error('Image download is unavailable in this Node runtime.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await this.fetch(url, {
                headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8' },
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}.`);
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (!contentType.startsWith('image/')) throw new Error('Attachment is not an image.');
            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > this.maxImageBytes) throw new Error('Image exceeds the processing size limit.');
            let buffer;
            if (response.body?.getReader) {
                const reader = response.body.getReader();
                const chunks = [];
                let total = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > this.maxImageBytes) {
                        await reader.cancel().catch(() => {});
                        throw new Error('Image exceeds the processing size limit.');
                    }
                    chunks.push(Buffer.from(value));
                }
                buffer = Buffer.concat(chunks, total);
            } else {
                buffer = Buffer.from(await response.arrayBuffer());
            }
            if (!buffer.length || buffer.length > this.maxImageBytes) throw new Error('Image is empty or exceeds the processing size limit.');
            return { buffer, contentType };
        } finally {
            clearTimeout(timer);
        }
    }

    async analyzeAttachment(attachment, messageId, opponentIgn, context = {}) {
        if (this.isolatedPipeline) {
            try {
                // Send metadata only. Download, decoding, crop generation and OCR
                // all happen in the helper, after this image reaches the queue head.
                const source = { id: attachment.id, name: attachment.name, url: attachment.url };
                return await this.workerPool.run(() => this.workerPool.processImage('analyzeScout',
                    source, messageId, opponentIgn, context, { maxImageBytes: this.maxImageBytes }), { label: this.activityLabel });
            } catch (error) {
                return { attachmentId: String(attachment.id || attachment.name || 'image'), name: attachment.name || 'scout-image',
                    url: attachment.url, text: null, lines: [], teamLayoutStatus: 'uncertain',
                    error: error?.message || 'Image could not be processed.', teamLayoutReason: 'Image could not be confidently inspected.' };
            }
        }
        return this.workerPool.run(() => this.analyzeAttachmentQueued(attachment, messageId, opponentIgn, context), { label: this.activityLabel });
    }

    async analyzeAttachmentQueued(attachment, messageId, opponentIgn, context = {}) {
        const base = {
            attachmentId: String(attachment.id || attachment.name || 'image'),
            name: attachment.name || 'scout-image',
            url: attachment.url,
            text: null,
            lines: [],
            teamLayoutStatus: 'uncertain',
            error: null
        };
        try {
            const { buffer } = await this.download(attachment.url);
            const original = await this.sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
            if (!original.width || !original.height || original.width * original.height > MAX_IMAGE_PIXELS) {
                throw new Error('Image dimensions exceed the processing limit.');
            }
            const oriented = await this.sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().png().toBuffer();
            const metadata = await this.sharp(oriented).metadata();
            const width = metadata.width || 0;
            const height = metadata.height || 0;
            if (!width || !height) throw new Error('Image dimensions could not be read.');
            const cardRect = await detectResultCardFrame(oriented, this.sharp, width, height);
            const readRegion = async (rect = null, { nameStrip = false, threshold = null, zoomTarget = 1200,
                enhance = false, pixelated = false, pad = false } = {}) => {
                const regionWidth = rect?.width || width;
                const regionHeight = rect?.height || height;
                if (regionWidth < 8 || regionHeight < 8) {
                    return { text: '', lines: [], width: regionWidth, height: regionHeight, confidence: 0 };
                }
                const scale = nameStrip
                    ? Math.min(16, Math.max(1, zoomTarget / regionWidth))
                    : Math.min(MAX_OCR_WIDTH / regionWidth, Math.max(1, Math.min(6, 1200 / regionWidth)));
                let pipeline = rect ? this.sharp(oriented).extract(rect) : this.sharp(oriented);
                if (scale !== 1) pipeline = pipeline.resize({ width: Math.round(regionWidth * scale),
                    kernel: pixelated ? 'nearest' : 'lanczos3' });
                if (enhance) pipeline = pipeline.normalize().sharpen();
                if (threshold !== null) pipeline = pipeline.grayscale().threshold(threshold).negate();
                if (threshold !== null) {
                    const channel = (await pipeline.clone().stats()).channels[0];
                    // Empty threshold masks only make Tesseract inspect stray pixels.
                    if (channel && (channel.mean >= 254 || channel.mean <= 1 || channel.stdev < 4)) {
                        return { text: '', lines: [], width: regionWidth, height: regionHeight, confidence: 0 };
                    }
                }
                if (nameStrip && (threshold !== null || pad)) pipeline = pipeline.extend({
                    top: 10, bottom: 10, left: 12, right: 12, background: '#ffffff'
                });
                const ocrBuffer = await pipeline.png().toBuffer();
                // Tesseract.js v7 only includes text by default; blocks hold line positions.
                const recognized = await this.workerPool.recognize(ocrBuffer,
                    nameStrip ? { tessedit_pageseg_mode: '6',
                        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.- ' } : {},
                    { text: true, blocks: !nameStrip });
                const data = recognized?.data || recognized || {};
                const blockLines = (Array.isArray(data.blocks) ? data.blocks : [])
                    .flatMap(block => Array.isArray(block.paragraphs) ? block.paragraphs : [])
                    .flatMap(paragraph => Array.isArray(paragraph.lines) ? paragraph.lines : []);
                const lines = (blockLines.length ? blockLines : Array.isArray(data.lines) ? data.lines : []).map(line => {
                    const box = line.bbox || line.boundingBox || {};
                    return {
                        text: String(line.text || '').trim(),
                        bbox: [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
                            ? { x0: box.x0 / scale, y0: box.y0 / scale, x1: box.x1 / scale, y1: box.y1 / scale }
                            : null
                    };
                }).filter(line => line.text);
                return { text: String(data.text || '').trim(), lines, width: regionWidth, height: regionHeight,
                    confidence: Number(data.confidence || 0) };
            };
            // Once a result card is located, read that panel first. OCR of the
            // entire game screen can confuse player names in the background with
            // the opponent on the card.
            let selected = await readRegion(cardRect);
            let selectedFromCard = Boolean(cardRect);
            let ocrCandidate = candidateFromOcr(selected.text, selected.lines, selected);
            let focusedIgn = null;
            let focusedConfidence = 0;
            let focusedSource = null;
            let focusedScanAttempted = false;
            let battlePairAmbiguous = false;
            // Some screenshots are already legible in the full-page OCR, but
            // that text is not a result-card line. Accept a clear VS banner
            // pair directly instead of discarding it as unrelated OCR.
            const fullReadBanner = opponentFromBattleBanner(selected.text, context);
            battlePairAmbiguous ||= fullReadBanner.ambiguous;
            if (fullReadBanner.ign) {
                focusedIgn = fullReadBanner.ign;
                focusedConfidence = 0.96;
                focusedSource = 'battle_header_ocr';
                focusedScanAttempted = true;
            }
            const cardLikeText = /\brating\s*[:;=]\s*[+-]\s*\d+|\bK\.?\s*[O0]\.?|\b(?:surrendered|victory|defeat|forfeit|disconnected)\b|\blv\.?\s*1?00\b/iu.test(selected.text)
                || (width / height > 2.2 && /\b(?:win|loss)\b/iu.test(selected.text));
            const fullCardVisual = !cardRect && cardLikeText
                && await looksLikeFullResultCard(oriented, this.sharp, width, height);
            const cardArea = cardRect || (fullCardVisual
                ? { left: 0, top: 0, width, height } : null);
            if (cardArea) {
                const strip = (topRatio, bottomRatio, widthRatio) => {
                    const left = cardArea.left + Math.floor(cardArea.width * 0.012);
                    const top = cardArea.top + Math.floor(cardArea.height * topRatio);
                    return { left, top, width: Math.min(width - left,
                        Math.max(8, Math.floor(cardArea.width * widthRatio))),
                    height: Math.min(height - top,
                        Math.max(8, Math.floor(cardArea.height * (bottomRatio - topRatio)))) };
                };
                const nameFromRead = read => {
                    const names = read.text.split(/\n/u).map(line =>
                        nameFromResultLine(line.replace(/\b(?:Opponent|Result|Duration|Date|Type)\b.*$/iu, '').trim()))
                        .filter(Boolean);
                    return new Set(names.map(normalizeIgn)).size === 1 ? names[0] : null;
                };
                const reads = [];
                const run = async (rect, options, family) => {
                    if (rect.width < 8 || rect.height < 8) return;
                    const read = await readRegion(rect, { nameStrip: true, ...options });
                    focusedScanAttempted = true;
                    reads.push({ ...read, family, name: nameFromRead(read) });
                };
                // The opponent name is at the lower left of the result panel even
                // when the top or side borders were cut out of the upload.
                const usualStrip = strip(0.77, 0.99, 0.53);
                await run(usualStrip, { zoomTarget: 1000 }, 'plain');
                await run(usualStrip, { zoomTarget: 1400, enhance: true, pixelated: true }, 'pixel');
                await run(usualStrip, { zoomTarget: 1200, threshold: 155 }, 'threshold');
                const matching = reads.length === 3 && reads.every(read => read.name
                    && normalizeIgn(read.name) === normalizeIgn(reads[0].name)
                    && read.confidence >= 65);
                if (!matching) {
                    // Wider and higher bands handle partial cards and names crossing
                    // the result table underneath. They are separate OCR evidence.
                    await run(strip(0.68, 0.99, 0.53), { zoomTarget: 1300 }, 'wide');
                    await run(strip(0.78, 0.99, 0.42), { zoomTarget: 1200, threshold: 185 }, 'narrow');
                    await run(strip(0.76, 0.99, 0.53), { zoomTarget: 1400, enhance: true }, 'photo');
                    await run(strip(0.78, 0.99, 0.42), { zoomTarget: 1200, threshold: 110 }, 'dim');
                    await run(strip(0.74, 0.99, 0.35), {
                        zoomTarget: Math.floor(cardArea.width * 0.35 * 3), pixelated: true, pad: true
                    }, 'tight');
                }
                const votes = new Map();
                for (const read of reads) {
                    const key = normalizeIgn(read.name);
                    if (!key || read.confidence < 40) continue;
                    if (!votes.has(key)) votes.set(key, { name: read.name, count: 0, confidence: 0, families: new Set() });
                    const vote = votes.get(key);
                    vote.count++;
                    vote.confidence += read.confidence;
                    vote.families.add(read.family);
                }
                const ranked = [...votes.values()].sort((a, b) => b.count - a.count || b.confidence - a.confidence);
                const winner = ranked[0];
                const average = winner ? winner.confidence / winner.count : 0;
                const matchesTyped = normalizeIgn(winner?.name) === normalizeIgn(opponentIgn);
                const matchesFullRead = normalizeIgn(winner?.name) === normalizeIgn(ocrCandidate?.ign)
                    && ['result_card_ocr', 'result_outcome_ocr'].includes(ocrCandidate?.source);
                const unopposed = winner && winner.count >= 2 && winner.count > (ranked[1]?.count || 0);
                const strongImageRead = winner?.count >= 3 && winner.families.size >= 3 && average >= 70;
                if (unopposed && winner.families.size >= 2 && average >= 60
                    && (strongImageRead || winner.count >= 2 && (matchesTyped || matchesFullRead))) {
                    focusedIgn = winner.name;
                    focusedSource = 'result_card_ocr';
                    // Agreeing full-card and close-up reads are useful on a
                    // clearly framed card. A disagreement with a typed IGN must
                    // still be small; cropped or noisy reads stay in review.
                    const corroboratedCardRead = (cardRect || fullCardVisual) && matchesFullRead && strongImageRead
                        && average >= 80 && (!opponentIgn || closeIgnSpelling(winner.name, opponentIgn));
                    focusedConfidence = matchesTyped || corroboratedCardRead ? 0.94
                        : strongImageRead ? 0.89 : 0.86;
                }
                if (!focusedIgn && cardArea.width >= 300) {
                    const bottomText = selected.text.split(/\n/u).slice(-5).join('')
                        .replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
                    const tight = reads.filter(read => read.family === 'tight' && read.name
                        && normalizeIgn(read.name).length >= 5
                        && bottomText.includes(normalizeIgn(read.name).replace(/[^\p{L}\p{N}]/gu, '')));
                    if (tight.length === 1) {
                        focusedIgn = tight[0].name;
                        // One cropped read can land on translucent background text.
                        // Keep it in review unless the card frame itself was found.
                        focusedConfidence = cardRect ? 0.88 : 0.79;
                        focusedSource = 'result_card_ocr';
                    }
                }
            }
            if (cardRect && !focusedIgn && (opponentIgn || ocrCandidate?.ign)
                && (!ocrCandidate || ocrCandidate.confidence < 0.8)) {
                const full = await readRegion();
                const fullCandidate = candidateFromOcr(full.text, full.lines, full);
                const corroborates = fullCandidate && (normalizeIgn(fullCandidate.ign) === normalizeIgn(opponentIgn)
                    || normalizeIgn(fullCandidate.ign) === normalizeIgn(ocrCandidate?.ign));
                if (corroborates && fullCandidate.confidence >= 0.8
                    && (!ocrCandidate || fullCandidate.confidence > ocrCandidate.confidence)) {
                    selected = full;
                    selectedFromCard = false;
                    ocrCandidate = fullCandidate;
                }
            }
            // A battle header is independent evidence and stays useful even when
            // a centered result card was also detected elsewhere in the image.
            if (!focusedIgn) {
                const bannerBands = await battleBannerBands(oriented, this.sharp, width, height);
                // Header detection can miss compact or photographed banners.
                // The upper fifth is a cheap, bounded fallback for common game
                // screenshots where the two players flank the yellow VS mark.
                const topBand = { left: 0, top: 0, width, height: Math.min(height, Math.max(36, Math.round(height * 0.2))) };
                if (!bannerBands.some(band => band.top <= topBand.height * 0.35
                    && band.top + band.height >= topBand.height * 0.45)) bannerBands.unshift(topBand);
                for (const band of bannerBands) {
                    const banner = await this.workerPool.recognize(await this.sharp(oriented).extract(band).png().toBuffer(),
                        { tessedit_pageseg_mode: '6' });
                    const bannerText = String(banner?.data?.text || '').trim();
                    const bannerResolution = opponentFromBattleBanner(bannerText, context);
                    battlePairAmbiguous ||= bannerResolution.ambiguous;
                    if (!bannerResolution.ign) continue;
                    focusedIgn = bannerResolution.ign;
                    focusedConfidence = /\bV\s*S\.?\s+/iu.test(bannerText) ? 0.96 : 0.9;
                    focusedSource = 'battle_header_ocr';
                    focusedScanAttempted = true;
                    break;
                }
            }
            if (focusedIgn && (context.authorNames || []).some(name => normalizeIgn(name) === normalizeIgn(focusedIgn))) {
                // The scout author is one of the visible players, so this is
                // their own name rather than the opponent. Require a clear
                // second-side reading or officer review instead of promoting it.
                focusedIgn = null;
                focusedConfidence = 0;
                focusedSource = null;
                battlePairAmbiguous = true;
            }
            const detected = detectTeamRegion(selected.lines, selected.width, selected.height, opponentIgn || ocrCandidate?.ign);

            return {
                ...base,
                text: selected.text,
                lines: selected.lines,
                width,
                height,
                ocrWidth: selected.width,
                ocrHeight: selected.height,
                cardRect: selectedFromCard ? cardRect : null,
                cardScanAttempted: true,
                focusedScanAttempted,
                scanVersion: SCAN_VERSION,
                focusedIgn,
                focusedConfidence,
                focusedSource,
                battlePairAmbiguous,
                teamLayoutStatus: detected.status,
                teamLayoutReason: detected.reason || null
            };
        } catch (error) {
            return { ...base, error: error?.message || 'Image could not be processed.', teamLayoutReason: 'Image could not be confidently inspected.' };
        }
    }

    async close() {
        await this.workerPool.close();
    }
}

module.exports = {
    MAX_IMAGE_BYTES,
    SCAN_VERSION,
    PvpScoutOcr,
    detectTeamRegion,
    levelRows,
    verticalOpponentRoster
};
