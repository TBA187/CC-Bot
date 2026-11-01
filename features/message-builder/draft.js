// Model message drafts, validate imports, and reconcile embed media and attachments.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { AttachmentBuilder, EmbedBuilder, MessageFlags, MessageFlagsBitField } = require('discord.js');

const MAX_MESSAGE_CONTENT = 2000;
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const MAX_AUTHOR_NAME = 256;
const MAX_FOOTER_TEXT = 2048;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;
const MAX_EMBED_TEXT = 6000;
const MAX_MESSAGE_ATTACHMENTS = 10;
const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const CROW_CONTROL_BRANDING_COLOR = '#452366';
const MESSAGE_JSON_FORMAT = 'crow-control-custom-message';
const MESSAGE_JSON_VERSION = 1;
const MAX_MESSAGE_JSON_BYTES = 50 * 1024 * 1024;
const INVISIBLE_COLOR_ONLY_FIELD = '\u200b';
const FOOTER_TEXT = 'Crow Control Guild';
const LOGO_FILENAME = 'cc_logo.webp';
const LOGO_PATH = path.join(__dirname, '..', '..', 'images', LOGO_FILENAME);
const LOGO_ATTACHMENT_URL = 'attachment://' + LOGO_FILENAME;
const LOGO_URL = LOGO_ATTACHMENT_URL;
function isBrandedFooter(text, icon) {
    if (text === FOOTER_TEXT) return icon.replace(/\/+$/, '') === LOGO_URL || icon.includes('/emojis/1565243892255694908');
    return text === 'White Walker Guild' && (icon.replace(/\/+$/, '') === 'attachment://ww_logo.png' || icon.includes('/emojis/1472065995089645609'));
}
class DraftValidationError extends Error {
    constructor(message, options) { super(message, options); this.name = 'DraftValidationError'; }
}
const TICK = String.fromCharCode(96);
const quoted = value => TICK + value + TICK;
const timestampFormats = new WeakMap();
const zoneFormatters = new Map();
const COLOR_NAMES = Object.freeze({
    red: '#FF0000', 'dark red': '#8B0000', 'light red': '#FF6666', crimson: '#DC143C',
    blue: '#0000FF', 'dark blue': '#00008B', 'light blue': '#ADD8E6', navy: '#000080',
    'navy blue': '#000080', 'royal blue': '#4169E1', 'sky blue': '#87CEEB', green: '#008000',
    'neon green': '#39FF14', 'dark green': '#006400', 'light green': '#90EE90', lime: '#00FF00',
    'lime green': '#32CD32', 'forest green': '#228B22', gold: '#D4AF37', yellow: '#FFFF00',
    'light yellow': '#FFFFE0', orange: '#FFA500', 'dark orange': '#FF8C00', 'light orange': '#FFD580',
    purple: '#800080', 'dark purple': '#4B0082', 'light purple': '#C084FC', violet: '#8A2BE2',
    pink: '#FFC0CB', 'hot pink': '#FF69B4', 'light pink': '#FFB6C1', white: '#FFFFFF', black: '#000000',
    gray: '#95A5A6', grey: '#95A5A6', 'dark gray': '#2F3136', 'dark grey': '#2F3136',
    'light gray': '#D3D3D3', 'light grey': '#D3D3D3', silver: '#C0C0C0', teal: '#008080',
    'dark teal': '#008080', 'light teal': '#7FDBDA', cyan: '#00FFFF', aqua: '#00FFFF',
    brown: '#8B4513', maroon: '#800000'
});
const TIMEZONE_ABBREVIATION_OFFSETS = Object.freeze({
    CET: 60, CEST: 120, EET: 120, EEST: 180, WET: 0, WEST: 60, EST: -300, EDT: -240,
    CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, AKST: -540,
    AKDT: -480, HST: -600, JST: 540, KST: 540, AEST: 600, AEDT: 660, ACST: 570,
    ACDT: 630, AWST: 480, NZST: 720, NZDT: 780
});
const TIMESTAMP_ERROR = 'Timestamp must contain a valid date and time, or a time such as ' +
    quoted('17:30') + ' or ' + quoted('04:20 PM') + '. Supported timezones include ' +
    quoted('UTC+1') + ', ' + quoted('GMT-01:00') + ', ' + quoted('CEST') + ', and ' + quoted('Europe/Copenhagen') + '.';
const clean = value => String(value || '').trim();
const characters = value => Array.from(String(value || '')).length;
const attachmentName = attachment => String(attachment?.filename || attachment?.name || '');
const attachmentId = attachment => String(attachment.id);
const attachmentType = attachment => attachment.contentType || attachment.content_type || null;
const attachmentProxy = attachment => attachment.proxyURL || attachment.proxy_url || '';
const asArray = values => values?.values && !Array.isArray(values) ? [...values.values()] : [...(values || [])];
const embedPayload = embed => embed.toJSON ? embed.toJSON() : embed.to_dict ? embed.to_dict() : structuredClone(embed);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEmpty = value => value == null || value === '';
const pad = (value, length = 2) => String(value).padStart(length, '0');
const numberText = value => value.toLocaleString('en-US');

function expandLiteralLineBreaks(value) { return String(value || '').replaceAll('\\n', '\n'); }
function expandFieldSpacingEscapes(value) {
    const text = expandLiteralLineBreaks(value).replaceAll('\u2063', '')
        .replace(/\\u(200b|2002)/gi, (_, code) => code.toLowerCase() === '200b' ? '\u200b' : '\u2002');
    return text && /^[\u200b\u2002]+$/.test(text) ? text.at(-1) : text;
}
function isHttpsUrl(value) {
    try { const url = new URL(clean(value)); return url.protocol.toLowerCase() === 'https:' && Boolean(url.host); }
    catch { return false; }
}
function normalizeEmbedColor(value) {
    const text = clean(value);
    if (!text) return '';
    const normalized = text.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
    if (COLOR_NAMES[normalized]) return COLOR_NAMES[normalized];
    if (/^#?[\da-f]{6}$/i.test(text)) return '#' + text.replace(/^#/, '').toUpperCase();
    throw new DraftValidationError('Color must be a hex code like ' + quoted('#FF0000') + ' or a supported color name like ' + quoted('dark red') + '.');
}
function timezoneFormatter(zone) {
    if (!zoneFormatters.has(zone)) {
        try {
            zoneFormatters.set(zone, new Intl.DateTimeFormat('en-CA', {
                timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            }));
        } catch {
            throw new DraftValidationError('Unknown timezone ' + quoted(zone) + '. Use a valid region such as ' +
                quoted('Europe/Copenhagen') + ' or a UTC/GMT offset.');
        }
    }
    return zoneFormatters.get(zone);
}
function partsInZone(milliseconds, zone) {
    const parts = {};
    for (const item of timezoneFormatter(zone).formatToParts(new Date(milliseconds))) {
        if (item.type !== 'literal') parts[item.type] = Number(item.value);
    }
    return parts;
}
function utcMilliseconds(parts) {
    // Date.UTC treats years 0..99 as 1900..1999.
    const value = new Date(0);
    value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    value.setUTCHours(parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0);
    return value.getTime();
}
function zoneOffset(milliseconds, zone) {
    const instant = Math.floor(milliseconds / 1000) * 1000;
    return (utcMilliseconds(partsInZone(instant, zone)) - instant) / 60000;
}
function offsetForLocalTime(parts, zone) {
    const local = utcMilliseconds(parts), before = zoneOffset(local - 86400000, zone);
    const offsets = new Set([before, zoneOffset(local, zone), zoneOffset(local + 86400000, zone)]);
    const valid = [...offsets].filter(offset => zoneOffset(local - offset * 60000, zone) === offset);
    // ZoneInfo's default fold=0 uses the first occurrence and the pre-gap offset.
    return valid.length ? Math.max(...valid) : before;
}
function timezoneSuffix(value) {
    let text = value;
    const parenthesized = text.match(/^(.+?)\s+\(([^()]+)\)$/);
    if (parenthesized) text = parenthesized[1].trim() + ' ' + parenthesized[2].trim();
    const offset = text.match(/^(.+?)\s+(UTC|GMT)(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i);
    if (offset) {
        const hours = Number(offset[4] || 0), minutes = Number(offset[5] || 0);
        if (minutes >= 60 || hours > 14 || (hours === 14 && minutes)) throw new DraftValidationError('UTC/GMT offset must be between -14:00 and +14:00.');
        return { text: offset[1].trim(), offset: (hours * 60 + minutes) * (offset[3] === '-' ? -1 : 1) };
    }
    const iana = text.match(/^(.+?)\s+([A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/);
    if (iana) { timezoneFormatter(iana[2]); return { text: iana[1].trim(), zone: iana[2] }; }
    const abbreviation = text.match(/^(.+?)\s+([A-Za-z]{2,5})$/);
    if (abbreviation) {
        const name = abbreviation[2].toUpperCase();
        if (['AST', 'BST', 'IST'].includes(name)) throw new DraftValidationError('Timezone ' + quoted(name) +
            ' is ambiguous. Use a UTC/GMT offset or an IANA region such as ' + quoted('Europe/Copenhagen') + '.');
        if (name === 'UTC' || name === 'GMT') return { text: abbreviation[1].trim(), offset: 0 };
        if (TIMEZONE_ABBREVIATION_OFFSETS[name] != null) return { text: abbreviation[1].trim(), offset: TIMEZONE_ABBREVIATION_OFFSETS[name] };
    }
    return { text };
}
function parseDateTimeParts(value) {
    let text = value;
    const twelve = text.match(/^(?:(\d{4}-\d{2}-\d{2})[T ]+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(AM|PM)$/i);
    if (twelve) {
        const hour = Number(twelve[2]);
        if (hour < 1 || hour > 12) return null;
        text = (twelve[1] ? twelve[1] + 'T' : '') + pad(hour % 12 + (twelve[5].toUpperCase() === 'PM' ? 12 : 0)) +
            ':' + twelve[3] + ':' + (twelve[4] || '00');
    }
    let date = text.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[Tt ](.*))?$/);
    const week = !date && text.match(/^(\d{4})-?W(\d{2})(?:-?(\d))?(?:[Tt ](.*))?$/);
    if (week) {
        const year = Number(week[1]), weekNumber = Number(week[2]), weekday = Number(week[3] || 1);
        if (weekNumber < 1 || weekNumber > 53 || weekday < 1 || weekday > 7) return null;
        const january4 = new Date(utcMilliseconds({ year, month: 1, day: 4 }));
        const weekStart = january4.getTime() - ((january4.getUTCDay() + 6) % 7) * 86400000;
        const selected = new Date(weekStart + ((weekNumber - 1) * 7 + weekday - 1) * 86400000);
        const nextYear4 = new Date(utcMilliseconds({ year: year + 1, month: 1, day: 4 }));
        const nextWeekStart = nextYear4.getTime() - ((nextYear4.getUTCDay() + 6) % 7) * 86400000;
        if (selected.getTime() >= nextWeekStart) return null;
        date = [text, String(selected.getUTCFullYear()), String(selected.getUTCMonth() + 1), String(selected.getUTCDate()), week[4]];
    }
    const timeText = date ? date[4] || '00:00:00' : text.replace(/^[Tt]/, '');
    const time = timeText.match(/^(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:[.,](\d+))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?(?:[.,](\d+))?)?$/);
    if (!time) return null;
    const hour = Number(time[1]), minute = Number(time[2] || 0), second = Number(time[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    const microsecond = Number((time[4] || '').padEnd(6, '0').slice(0, 6));
    const parts = { hour, minute, second, microsecond, millisecond: Math.floor(microsecond / 1000) };
    if (date) {
        parts.year = Number(date[1]); parts.month = Number(date[2]); parts.day = Number(date[3]);
        const check = new Date(utcMilliseconds(parts));
        if (parts.year < 1 || check.getUTCFullYear() !== parts.year || check.getUTCMonth() + 1 !== parts.month || check.getUTCDate() !== parts.day) return null;
    }
    if (time[5]) {
        const offset = Number(time[6]) * 60 + Number(time[7] || 0) + Number(time[8] || 0) / 60;
        if (offset >= 1440) return null;
        parts.offset = offset * (time[5] === '-' ? -1 : 1);
    }
    return parts;
}
function parseEmbedTimestamp(value, { now = new Date() } = {}) {
    const text = clean(value);
    if (!text) return null;
    const selected = timezoneSuffix(text.replace(/[Zz]$/, '+00:00'));
    const parts = parseDateTimeParts(selected.text);
    if (!parts) throw new DraftValidationError(TIMESTAMP_ERROR);
    if ((selected.zone || selected.offset != null) && parts.offset != null) throw new DraftValidationError('Timestamp contains more than one timezone.');
    const offset = selected.offset ?? parts.offset ?? 0;
    if (parts.year == null) {
        const current = selected.zone ? partsInZone(now.getTime(), selected.zone) : (() => {
            const date = new Date(now.getTime() + offset * 60000);
            return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
        })();
        Object.assign(parts, { year: current.year, month: current.month, day: current.day });
    }
    const effectiveOffset = selected.zone ? offsetForLocalTime(parts, selected.zone) : offset;
    const result = new Date(utcMilliseconds(parts) - effectiveOffset * 60000);
    const absSeconds = Math.round(Math.abs(effectiveOffset) * 60);
    let zoneText = (effectiveOffset < 0 ? '-' : '+') + pad(Math.floor(absSeconds / 3600)) + ':' + pad(Math.floor(absSeconds % 3600 / 60));
    if (absSeconds % 60) zoneText += ':' + pad(absSeconds % 60);
    const fraction = parts.microsecond ? '.' + pad(parts.microsecond, 6) : '';
    const formatted = pad(parts.year, 4) + '-' + pad(parts.month) + '-' + pad(parts.day) + 'T' +
        pad(parts.hour) + ':' + pad(parts.minute) + ':' + pad(parts.second) + fraction + zoneText;
    timestampFormats.set(result, { milliseconds: result.getTime(), formatted });
    return result;
}
function formatEmbedTimestamp(value) {
    if (value == null) return '';
    const stored = timestampFormats.get(value);
    if (stored && stored.milliseconds === value.getTime()) return stored.formatted;
    const result = value.toISOString().replace(/Z$/, '+00:00');
    return value.getUTCMilliseconds() ? result.replace(/\.(\d{3})/, (_, fraction) => '.' + fraction + '000') : result.replace('.000', '');
}
class ImportedAttachment {
    constructor({ id, filename, data, contentType = null, description = null, url = '', proxyURL = '' }) {
        this.id = String(id); this.filename = filename; this.name = filename; this.data = Buffer.from(data);
        this.contentType = contentType; this.description = description; this.url = url; this.proxyURL = proxyURL;
    }
    get size() { return this.data.length; }
    async read() { return this.data; }
    async toFile({ filename = this.filename } = {}) {
        return new AttachmentBuilder(this.data, { name: filename, description: this.description || undefined });
    }
}
function logoAttachment() {
    return new ImportedAttachment({ id: 'cc-brand-logo', filename: LOGO_FILENAME, data: fs.readFileSync(LOGO_PATH), contentType: 'image/webp' });
}
function logoFile() { return new AttachmentBuilder(LOGO_PATH, { name: LOGO_FILENAME }); }
// Imported copies of the same named file may have different export indexes/IDs.
// Reuse identical bytes without merging distinct files that share a filename.
const fileDigests = new WeakMap();
function attachmentFileKey(attachment, filename = attachmentName(attachment)) {
    if (attachment instanceof ImportedAttachment) {
        if (!fileDigests.has(attachment)) fileDigests.set(attachment, createHash('sha256').update(attachment.data).digest('hex'));
        return filename + ':' + fileDigests.get(attachment);
    }
    return attachmentId(attachment);
}
function isImageAttachment(attachment) {
    return String(attachmentType(attachment) || '').toLowerCase().startsWith('image/') ||
        IMAGE_EXTENSIONS.has(path.extname(attachmentName(attachment)).toLowerCase());
}
class EmbedFieldDraft {
    constructor(name = '', value = '', inline = false) {
        if (isObject(name)) ({ name = '', value = '', inline = false } = name);
        Object.assign(this, { name, value, inline });
    }
    toDict() { return { name: this.name, value: this.value, inline: this.inline }; }
}
class EmbedMediaDraft {
    constructor({ url = '', attachment = null, filename = '', isNewUpload = false } = {}) {
        Object.assign(this, { url, attachment, filename, isNewUpload });
    }
    get hasSource() { return this.attachment !== null || Boolean(clean(this.url)); }
    get sourceLabel() { return this.attachment ? 'Upload: ' + (this.filename || attachmentName(this.attachment)) : this.url; }
    get inputUrl() { return this.attachment ? 'attachment://' + (this.filename || attachmentName(this.attachment)) : this.url; }
    clear() { Object.assign(this, { url: '', attachment: null, filename: '', isNewUpload: false }); }
    setUrl(value) { this.clear(); this.url = clean(value); }
    setUpload(kind, attachment, { new: isNew = true } = {}) {
        let suffix = path.extname(attachmentName(attachment)).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(suffix)) suffix = '.png';
        Object.assign(this, { url: '', attachment, filename: isNew ? 'embed-' + kind + '-' + attachment.id + suffix : attachmentName(attachment), isNewUpload: isNew });
    }
    renderUrl() { return this.inputUrl; }
}
class MessageAttachmentDraft {
    constructor(attachment, isNewUpload = true) {
        this.attachment = attachment;
        this.isNewUpload = isObject(isNewUpload) ? isNewUpload.isNewUpload ?? true : isNewUpload;
    }
    get sourceLabel() { return attachmentName(this.attachment) || 'Attachment ' + this.attachment.id; }
}
class EmbedDraft {
    constructor(values = {}) {
        Object.assign(this, {
            messageContent: '', messageAttachments: [], crowControlBranding: false,
            title: '', titleUrl: '', authorName: '', authorUrl: '', authorIcon: new EmbedMediaDraft(),
            thumbnail: new EmbedMediaDraft(), description: '', image: new EmbedMediaDraft(), fields: [],
            footerText: '', footerIcon: new EmbedMediaDraft(), timestamp: null, useCurrentTimestamp: false, color: ''
        }, values);
    }
    get effectiveFooterText() { return this.footerText; }
    get effectiveFooterIcon() { return this.footerIcon; }
    get effectiveColor() { return this.color; }
    get effectiveThumbnail() { return this.thumbnail; }
    effectiveTimestamp() { return this.timestamp || (this.useCurrentTimestamp ? new Date() : null); }
    hasEmbedProperties() {
        return Boolean(this.title || this.titleUrl || this.authorName || this.authorUrl || this.authorIcon.hasSource ||
            this.effectiveThumbnail.hasSource || this.description || this.image.hasSource || this.fields.length ||
            this.effectiveFooterText || this.effectiveFooterIcon.hasSource || this.effectiveTimestamp() || this.effectiveColor);
    }
    combinedTextLength() {
        return [this.title, this.description, this.authorName, this.effectiveFooterText,
            ...this.fields.map(field => field.name), ...this.fields.map(field => field.value)].reduce((sum, value) => sum + characters(value), 0);
    }
    toEmbedDict({ preview = false } = {}) {
        const payload = {};
        if (this.title) payload.title = this.title;
        if (this.titleUrl) payload.url = this.titleUrl;
        if (this.description) payload.description = this.description;
        if (this.effectiveColor) payload.color = parseInt(normalizeEmbedColor(this.effectiveColor).slice(1), 16);
        const timestamp = this.effectiveTimestamp();
        if (timestamp) payload.timestamp = formatEmbedTimestamp(timestamp);
        if (this.authorName) {
            payload.author = { name: this.authorName };
            if (this.authorUrl) payload.author.url = this.authorUrl;
            if (this.authorIcon.hasSource) payload.author.icon_url = this.authorIcon.renderUrl({ preview });
        }
        if (this.effectiveThumbnail.hasSource) payload.thumbnail = { url: this.effectiveThumbnail.renderUrl({ preview }) };
        if (this.image.hasSource) payload.image = { url: this.image.renderUrl({ preview }) };
        if (this.fields.length) payload.fields = this.fields.map(field => field.toDict ? field.toDict() : { name: field.name, value: field.value, inline: Boolean(field.inline) });
        if (this.effectiveFooterText) {
            payload.footer = { text: this.effectiveFooterText };
            if (this.effectiveFooterIcon.hasSource) payload.footer.icon_url = this.effectiveFooterIcon.renderUrl({ preview });
        }
        return payload;
    }
    buildEmbed(options = {}) {
        const payload = this.toEmbedDict(options);
        if (!Object.keys(payload).length) return null;
        if (Object.keys(payload).length === 1 && 'color' in payload) {
            payload.fields = [{ name: INVISIBLE_COLOR_ONLY_FIELD, value: INVISIBLE_COLOR_ONLY_FIELD, inline: false }];
        }
        return new EmbedBuilder(payload);
    }
    buildEmbeds(options = {}) { const embed = this.buildEmbed(options); return embed ? [embed] : []; }
    snapshot() {
        return {
            messageAttachments: this.messageAttachments.map(item => item.sourceLabel), title: this.title, titleUrl: this.titleUrl,
            authorName: this.authorName, authorUrl: this.authorUrl, authorIcon: this.authorIcon.sourceLabel,
            thumbnail: this.effectiveThumbnail.sourceLabel, description: this.description, image: this.image.sourceLabel,
            fields: this.fields.map(field => field.toDict ? field.toDict() : { name: field.name, value: field.value, inline: Boolean(field.inline) }), footerText: this.effectiveFooterText, footerIcon: this.effectiveFooterIcon.sourceLabel,
            timestamp: this.timestamp ? formatEmbedTimestamp(this.timestamp) : this.useCurrentTimestamp ? 'Current timestamp' : '',
            color: this.effectiveColor, crowControlBranding: this.crowControlBranding
        };
    }
}
function applyCrowControlBrandingDefaults(draft) {
    draft.crowControlBranding = true;
    if (!draft.footerText) draft.footerText = FOOTER_TEXT;
    const attachment = logoAttachment();
    if (!draft.footerIcon.hasSource) draft.footerIcon = new EmbedMediaDraft({ attachment, filename: LOGO_FILENAME, isNewUpload: true });
    if (!draft.thumbnail.hasSource) draft.thumbnail = new EmbedMediaDraft({ attachment, filename: LOGO_FILENAME, isNewUpload: true });
    if (!draft.color) draft.color = CROW_CONTROL_BRANDING_COLOR;
    if (!draft.timestamp) draft.useCurrentTimestamp = true;
}
function mediaFromEmbed(payload, attachments) {
    const media = new EmbedMediaDraft({ url: clean(payload?.url) });
    if (!media.url) return media;
    for (const attachment of attachments) {
        if ([attachment.url || '', attachmentProxy(attachment), 'attachment://' + attachmentName(attachment)].includes(media.url)) {
            media.setUpload('media', attachment, { new: false }); break;
        }
    }
    return media;
}
function attachmentIdsReferencedByEmbeds(embeds, attachments) {
    const urls = new Set();
    const collect = value => {
        if (typeof value === 'string') urls.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (isObject(value)) Object.values(value).forEach(collect);
    };
    for (const embed of embeds) collect(embedPayload(embed));
    return new Set(attachments.filter(attachment =>
        [attachment.url || '', attachmentProxy(attachment), 'attachment://' + attachmentName(attachment)].some(url => urls.has(url))
    ).map(attachmentId));
}
function draftFromMessage(message) {
    const attachments = asArray(message.attachments), embeds = asArray(message.embeds);
    const draft = new EmbedDraft({ messageContent: message.content || '' });
    if (!embeds.length) {
        draft.messageAttachments = attachments.map(attachment => new MessageAttachmentDraft(attachment, false)); return draft;
    }
    const payload = embedPayload(embeds[0]), author = payload.author || {}, footer = payload.footer || {};
    Object.assign(draft, {
        title: String(payload.title || ''), titleUrl: String(payload.url || ''), description: String(payload.description || ''),
        authorName: String(author.name || ''), authorUrl: String(author.url || ''),
        authorIcon: mediaFromEmbed({ url: author.icon_url }, attachments), thumbnail: mediaFromEmbed(payload.thumbnail, attachments),
        image: mediaFromEmbed(payload.image, attachments), fields: fieldsFromJson(payload.fields),
        footerText: String(footer.text || ''), footerIcon: mediaFromEmbed({ url: footer.icon_url }, attachments),
        timestamp: payload.timestamp ? parseEmbedTimestamp(String(payload.timestamp)) : null,
        color: payload.color == null ? '' : '#' + Number(payload.color).toString(16).padStart(6, '0').toUpperCase()
    });
    draft.crowControlBranding = isBrandedFooter(draft.footerText, draft.footerIcon.inputUrl);
    const referencedIds = attachmentIdsReferencedByEmbeds(embeds, attachments);
    draft.messageAttachments = attachments.filter(attachment => !referencedIds.has(attachmentId(attachment)))
        .map(attachment => new MessageAttachmentDraft(attachment, false));
    return draft;
}
function validateEmbedDraft(draft) {
    const errors = [];
    for (const [value, limit, label] of [
        [draft.messageContent, MAX_MESSAGE_CONTENT, 'Message content'], [draft.title, MAX_TITLE, 'Title'],
        [draft.description, MAX_DESCRIPTION, 'Description'], [draft.authorName, MAX_AUTHOR_NAME, 'Author name'],
        [draft.effectiveFooterText, MAX_FOOTER_TEXT, 'Footer text']
    ]) if (characters(value) > limit) errors.push(label + ' cannot exceed ' + numberText(limit) + ' characters.');
    if (draft.fields.length > MAX_FIELDS) errors.push('An embed can contain at most ' + MAX_FIELDS + ' fields.');
    if (draft.messageAttachments.length > MAX_MESSAGE_ATTACHMENTS) errors.push('A message can contain at most ' + MAX_MESSAGE_ATTACHMENTS + ' regular attachments.');
    if (draft.titleUrl && !draft.title) errors.push('Title URL requires a Title.');
    if ((draft.authorUrl || draft.authorIcon.hasSource) && !draft.authorName) errors.push('Author URL and icon require an Author name.');
    if (draft.footerIcon.hasSource && !draft.footerText) errors.push('Footer icon URL requires Footer text.');
    for (const [label, value] of [['Title URL', draft.titleUrl], ['Author URL', draft.authorUrl]]) {
        if (value && !value.startsWith('attachment://') && !isHttpsUrl(value)) errors.push(label + ' must be a valid HTTPS URL.');
    }
    for (const [label, media] of [['Thumbnail', draft.thumbnail], ['Author icon', draft.authorIcon], ['Image', draft.image], ['Footer icon', draft.footerIcon]]) {
        if (media.attachment && !isImageAttachment(media.attachment)) errors.push(label + ' upload must be an image file.');
        if (media.url && !isHttpsUrl(media.url)) errors.push(label + ' URL must be a valid HTTPS URL.');
    }
    draft.fields.forEach((field, index) => {
        if (!field.name) errors.push('Field ' + (index + 1) + ' requires a name.');
        else if (characters(field.name) > MAX_FIELD_NAME) errors.push('Field ' + (index + 1) + ' name cannot exceed ' + numberText(MAX_FIELD_NAME) + ' characters.');
        if (!field.value) errors.push('Field ' + (index + 1) + ' requires a value.');
        else if (characters(field.value) > MAX_FIELD_VALUE) errors.push('Field ' + (index + 1) + ' value cannot exceed ' + numberText(MAX_FIELD_VALUE) + ' characters.');
    });
    if (draft.effectiveColor) { try { normalizeEmbedColor(draft.effectiveColor); } catch (error) { errors.push(error.message); } }
    const combinedLength = draft.combinedTextLength();
    if (combinedLength > MAX_EMBED_TEXT) errors.push('Combined embed text cannot exceed ' + numberText(MAX_EMBED_TEXT) +
        ' characters (currently ' + numberText(combinedLength) + ').');
    const uploadedCount = new Set([
        ...draft.messageAttachments.map(item => attachmentFileKey(item.attachment)),
        ...[draft.authorIcon, draft.thumbnail, draft.image, draft.footerIcon]
            .filter(media => media.attachment).map(media => attachmentFileKey(media.attachment, media.filename || attachmentName(media.attachment)))
    ]).size;
    if (uploadedCount > MAX_MESSAGE_ATTACHMENTS) errors.push('A message can contain at most ' + MAX_MESSAGE_ATTACHMENTS +
        ' uploaded files, including regular attachments and uploaded embed images or icons.');
    if (!draft.messageContent.trim() && !draft.messageAttachments.length && !draft.hasEmbedProperties()) {
        errors.push('Add message content, a regular attachment, or at least one embed property before sending.');
    }
    return errors;
}
function mediaAttachmentIds(draft) {
    return new Set([draft.authorIcon, draft.thumbnail, draft.image, draft.footerIcon]
        .filter(media => media.attachment && !media.isNewUpload).map(media => attachmentId(media.attachment)));
}
function referencedAttachmentIds(draft) {
    return new Set([...mediaAttachmentIds(draft), ...draft.messageAttachments.filter(item => !item.isNewUpload).map(item => attachmentId(item.attachment))]);
}
function relatedAttachmentIdsFromMessage(message, draft) {
    const related = referencedAttachmentIds(draft);
    if (draft.crowControlBranding) {
        for (const attachment of asArray(message.attachments)) {
            if (attachmentName(attachment).toLowerCase() === LOGO_FILENAME.toLowerCase()) related.add(attachmentId(attachment));
        }
    }
    return related;
}
async function readAttachmentBytes(attachment) {
    if (typeof attachment.read === 'function') {
        let originalError;
        for (const useCached of [false, true]) {
            try { return Buffer.from(await attachment.read({ useCached })); }
            catch (error) {
                if (error instanceof TypeError) return Buffer.from(await attachment.read());
                originalError ||= error;
            }
        }
        throw originalError;
    }
    if (attachment.data != null) return Buffer.from(attachment.data);
    let originalError;
    for (const url of [attachment.url, attachmentProxy(attachment)]) {
        if (!url) continue;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Attachment download failed (' + response.status + ').');
            return Buffer.from(await response.arrayBuffer());
        } catch (error) { originalError ||= error; }
    }
    throw originalError || new Error('Attachment has no download URL.');
}
async function attachmentToFile(attachment, { filename = attachmentName(attachment) } = {}) {
    return new AttachmentBuilder(await readAttachmentBytes(attachment), { name: filename, description: attachment.description || undefined });
}
async function attachmentFiles(draft, onlyNew) {
    const files = [], seen = new Set(), seenFiles = new Set();
    const add = async (attachment, filename) => {
        const id = attachmentId(attachment);
        const key = attachmentFileKey(attachment, filename);
        if (seen.has(id) || seenFiles.has(key)) return;
        seenFiles.add(key);
        seen.add(id);
        files.push(await attachmentToFile(attachment, { filename }));
    };
    for (const item of draft.messageAttachments) {
        if (!onlyNew || item.isNewUpload) await add(item.attachment, attachmentName(item.attachment));
    }
    for (const media of [draft.authorIcon, draft.thumbnail, draft.image, draft.footerIcon]) {
        if (media.attachment && (!onlyNew || media.isNewUpload)) await add(media.attachment, media.filename || attachmentName(media.attachment));
    }
    return files;
}
const buildNewAttachmentFiles = draft => attachmentFiles(draft, true);
const buildMediaFiles = buildNewAttachmentFiles;
const buildMessageAttachmentFiles = draft => attachmentFiles(draft, false);
function reconcileEditAttachments(message, { originalMediaAttachmentIds, draft, newFiles }) {
    const current = referencedAttachmentIds(draft), originals = new Set([...originalMediaAttachmentIds].map(String));
    const attachments = asArray(message.attachments);
    const additional = attachmentIdsReferencedByEmbeds(asArray(message.embeds).slice(1), attachments);
    return {
        attachments: attachments.filter(attachment => !originals.has(attachmentId(attachment)) || current.has(attachmentId(attachment)) || additional.has(attachmentId(attachment))),
        files: [...newFiles]
    };
}
function closeFiles(files) {
    // Buffer-backed AttachmentBuilders hold no open descriptors.
    for (const file of files) { try { file.close?.(); } catch { /* best effort */ } }
}
function brandedEditAttachments(message, embed) {
    const payload = embedPayload(embed), footer = payload.footer || {};
    const all = asArray(message.attachments), logos = all.filter(attachment => attachmentName(attachment).toLowerCase() === LOGO_FILENAME);
    const attachments = all.filter(attachment => !logos.includes(attachment));
    const requested = String(footer.icon_url || '');
    const isExpiringLogo = requested.toLowerCase().includes('/attachments/') && requested.toLowerCase().includes('/' + LOGO_FILENAME);
    const setFooter = value => { if (embed.setFooter) embed.setFooter(value); else embed.footer = { text: value.text, icon_url: value.iconURL }; };
    if (/^https?:\/\//.test(requested) && !isExpiringLogo) {
        setFooter({ text: footer.text || FOOTER_TEXT, iconURL: requested }); return { attachments, files: [] };
    }
    setFooter({ text: footer.text || FOOTER_TEXT, iconURL: LOGO_ATTACHMENT_URL });
    if (logos.length) return { attachments: [...attachments, logos[0]], files: [] };
    return { attachments, files: [logoFile()] };
}

async function attachmentToJson(attachment) {
    return { filename: attachmentName(attachment), content_type: String(attachmentType(attachment) || ''),
        description: String(attachment.description || ''), data_base64: (await readAttachmentBytes(attachment)).toString('base64') };
}
async function mediaToJson(media) {
    return media.attachment ? { filename: media.filename || attachmentName(media.attachment), attachment: await attachmentToJson(media.attachment) } :
        media.url ? { url: media.url } : {};
}
async function exportMessageJson(draft, { additionalEmbeds = [] } = {}) {
    const payload = {
        format: MESSAGE_JSON_FORMAT, version: MESSAGE_JSON_VERSION,
        message: { content: draft.messageContent, attachments: await Promise.all(draft.messageAttachments.map(item => attachmentToJson(item.attachment))) },
        embed: {
            title: draft.title, title_url: draft.titleUrl,
            author: { name: draft.authorName, url: draft.authorUrl, icon: await mediaToJson(draft.authorIcon) },
            thumbnail: await mediaToJson(draft.thumbnail), description: draft.description, image: await mediaToJson(draft.image),
            fields: draft.fields.map(field => field.toDict ? field.toDict() : { name: field.name, value: field.value, inline: Boolean(field.inline) }), footer: { text: draft.footerText, icon: await mediaToJson(draft.footerIcon) },
            timestamp: { mode: draft.timestamp ? 'custom' : draft.useCurrentTimestamp ? 'current' : 'none', value: formatEmbedTimestamp(draft.timestamp) },
            color: draft.color
        }, additional_embeds: [...additionalEmbeds].map(embedPayload)
    };
    return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
}
function decodeExportedAttachment(payload, index) {
    if (!isObject(payload)) throw new DraftValidationError('An exported attachment entry must be a JSON object.');
    const filename = path.basename(String(payload.filename || ''));
    if (!filename) throw new DraftValidationError('An exported attachment is missing its filename.');
    const encoded = payload.data_base64;
    if (typeof encoded !== 'string' || !encoded) throw new DraftValidationError('Attachment ' + quoted(filename) + ' is missing its Base64 file data.');
    // Buffer's decoder is permissive; require the strict exported file format.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new DraftValidationError('Attachment ' + quoted(filename) + ' contains invalid Base64 file data.');
    }
    const data = Buffer.from(encoded, 'base64');
    const digest = createHash('sha256').update(index + ':' + filename + ':', 'utf8').update(data).digest();
    const id = digest.readBigUInt64BE(0) || BigInt(index + 1);
    return new ImportedAttachment({ id: id.toString(), filename, data,
        contentType: clean(payload.content_type) || null, description: clean(payload.description) || null });
}
function mediaFromJson(payload, kind, attachmentIndex) {
    if (isEmpty(payload)) return new EmbedMediaDraft();
    if (!isObject(payload)) throw new DraftValidationError('The ' + kind.replaceAll('_', ' ') + ' value must be a JSON object.');
    if (payload.attachment != null) {
        const attachment = decodeExportedAttachment(payload.attachment, attachmentIndex.value++);
        return new EmbedMediaDraft({ attachment, filename: path.basename(String(payload.filename || attachment.filename)) || attachment.filename, isNewUpload: true });
    }
    const url = clean(payload.url);
    if (url.startsWith('attachment://')) throw new DraftValidationError('The ' + kind.replaceAll('_', ' ') + ' references an attachment without embedded file data.');
    return new EmbedMediaDraft({ url });
}
function fieldsFromJson(payload) {
    if (isEmpty(payload)) return [];
    if (!Array.isArray(payload)) throw new DraftValidationError('Embed fields must be a JSON array.');
    return payload.map((item, index) => {
        if (!isObject(item)) throw new DraftValidationError('Embed field ' + (index + 1) + ' must be a JSON object.');
        return new EmbedFieldDraft(String(item.name || ''), String(item.value || ''), Boolean(item.inline));
    });
}
function additionalEmbedsFromJson(payload) {
    if (!Array.isArray(payload)) throw new DraftValidationError('Additional embeds must be a JSON array.');
    return payload.map((item, index) => {
        if (!isObject(item)) throw new DraftValidationError('Embed ' + (index + 2) + ' must be a JSON object.');
        return new EmbedBuilder(item);
    });
}
function draftFromExport(payload) {
    if (payload.version !== MESSAGE_JSON_VERSION) throw new DraftValidationError('Unsupported Crow Control message JSON version. Expected version ' + MESSAGE_JSON_VERSION + '.');
    const message = payload.message || {}, embed = payload.embed || {};
    if (!isObject(message) || !isObject(embed)) throw new DraftValidationError('The exported message and embed values must be JSON objects.');
    const attachments = message.attachments || [];
    if (!Array.isArray(attachments)) throw new DraftValidationError('Message attachments must be a JSON array.');
    const messageAttachments = attachments.map((item, index) => new MessageAttachmentDraft(decodeExportedAttachment(item, index), true));
    const attachmentIndex = { value: messageAttachments.length };
    const author = embed.author || {}, footer = embed.footer || {}, timestampPayload = embed.timestamp || {};
    if (!isObject(author) || !isObject(footer)) throw new DraftValidationError('Author and footer values must be JSON objects.');
    if (!isObject(timestampPayload)) throw new DraftValidationError('Footer timestamp must be a JSON object.');
    const mode = clean(timestampPayload.mode).toLowerCase() || 'none';
    if (!['none', 'current', 'custom'].includes(mode)) throw new DraftValidationError('Footer timestamp mode must be ' + quoted('none') + ', ' + quoted('current') + ', or ' + quoted('custom') + '.');
    const timestamp = mode === 'custom' ? parseEmbedTimestamp(String(timestampPayload.value || '')) : null;
    if (mode === 'custom' && !timestamp) throw new DraftValidationError('A custom footer timestamp requires an ISO-8601 datetime value.');
    const draft = new EmbedDraft({ messageContent: String(message.content || ''), messageAttachments,
        title: String(embed.title || ''), titleUrl: String(embed.title_url || ''), authorName: String(author.name || ''), authorUrl: String(author.url || ''),
        authorIcon: mediaFromJson(author.icon, 'author_icon', attachmentIndex), thumbnail: mediaFromJson(embed.thumbnail, 'thumbnail', attachmentIndex),
        description: String(embed.description || ''), image: mediaFromJson(embed.image, 'image', attachmentIndex), fields: fieldsFromJson(embed.fields),
        footerText: String(footer.text || ''), footerIcon: mediaFromJson(footer.icon, 'footer_icon', attachmentIndex),
        timestamp, useCurrentTimestamp: mode === 'current', color: String(embed.color || '') });
    return { draft, additionalEmbeds: additionalEmbedsFromJson(payload.additional_embeds || []) };
}
function mediaFromDiscordJson(payload, { icon = false } = {}) {
    if (isEmpty(payload)) return new EmbedMediaDraft();
    if (!isObject(payload)) throw new DraftValidationError('Embed media values must be JSON objects.');
    const url = clean(icon ? payload.icon_url : payload.url);
    if (url.startsWith('attachment://')) throw new DraftValidationError('External JSON attachment references require embedded file data.');
    return new EmbedMediaDraft({ url });
}
function draftFromDiscordJson(payload) {
    let content, embeds;
    if ('embeds' in payload || 'content' in payload) {
        content = String(payload.content || '');
        const attachments = payload.attachments || [];
        if (Array.isArray(attachments) ? attachments.length : Boolean(attachments)) throw new DraftValidationError('External message attachments are supported only when they contain Crow Control Base64 file data.');
        embeds = payload.embeds || [];
        if (!Array.isArray(embeds)) throw new DraftValidationError('The ' + quoted('embeds') + ' value must be a JSON array.');
    } else if (isObject(payload.embed)) {
        content = String(payload.message_content || payload.content || ''); embeds = [payload.embed];
    } else { content = ''; embeds = [payload]; }
    if (embeds.length > 10) throw new DraftValidationError('A Discord message can contain at most 10 embeds.');
    const primary = embeds[0] ?? {};
    if (!isObject(primary)) throw new DraftValidationError('The first embed must be a JSON object.');
    const author = primary.author || {}, footer = primary.footer || {};
    if (!isObject(author) || !isObject(footer)) throw new DraftValidationError('Author and footer values must be JSON objects.');
    const draft = new EmbedDraft({ messageContent: content, title: String(primary.title || ''), titleUrl: String(primary.url || ''),
        authorName: String(author.name || ''), authorUrl: String(author.url || ''), authorIcon: mediaFromDiscordJson(author, { icon: true }),
        thumbnail: mediaFromDiscordJson(primary.thumbnail), description: String(primary.description || ''), image: mediaFromDiscordJson(primary.image),
        fields: fieldsFromJson(primary.fields), footerText: String(footer.text || ''), footerIcon: mediaFromDiscordJson(footer, { icon: true }),
        timestamp: primary.timestamp ? parseEmbedTimestamp(String(primary.timestamp)) : null,
        color: Number.isInteger(primary.color) ? '#' + primary.color.toString(16).padStart(6, '0').toUpperCase() : String(primary.color || '') });
    draft.crowControlBranding = isBrandedFooter(draft.footerText, draft.footerIcon.url);
    return { draft, additionalEmbeds: additionalEmbedsFromJson(embeds.slice(1)) };
}
function jsonErrorDetails(text) {
    let cursor = 0, detail = null;
    const fail = (reason, position = cursor) => { detail ||= { reason, position }; return false; };
    const whitespace = () => { while (/[\x20\t\n\r]/.test(text[cursor] || '\0')) cursor++; };
    function string() {
        const start = cursor++;
        while (cursor < text.length) {
            const character = text[cursor++];
            if (character === '"') return true;
            if (character.charCodeAt(0) < 32) return fail('Invalid control character at', cursor - 1);
            if (character === '\\') {
                const escape = text[cursor++];
                if (escape === 'u') {
                    if (!/^[\da-f]{4}$/i.test(text.slice(cursor, cursor + 4))) return fail('Invalid \\uXXXX escape', cursor - 1);
                    cursor += 4;
                } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
                    if (!escape) return fail('Unterminated string starting at', start);
                    return fail('Invalid \\escape', cursor - 2);
                }
            }
        }
        return fail('Unterminated string starting at', start);
    }
    function value(depth = 0) {
        if (depth > 1000) return fail('Expecting value');
        whitespace();
        if (text[cursor] === '"') return string();
        if (text[cursor] === '{') {
            cursor++; whitespace();
            if (text[cursor] === '}') { cursor++; return true; }
            while (cursor <= text.length) {
                if (text[cursor] !== '"') return fail('Expecting property name enclosed in double quotes');
                if (!string()) return false;
                whitespace();
                if (text[cursor] !== ':') return fail("Expecting ':' delimiter");
                cursor++;
                if (!value(depth + 1)) return false;
                whitespace();
                if (text[cursor] === '}') { cursor++; return true; }
                if (text[cursor] !== ',') return fail("Expecting ',' delimiter");
                cursor++; whitespace();
            }
        } else if (text[cursor] === '[') {
            cursor++; whitespace();
            if (text[cursor] === ']') { cursor++; return true; }
            while (cursor <= text.length) {
                if (!value(depth + 1)) return false;
                whitespace();
                if (text[cursor] === ']') { cursor++; return true; }
                if (text[cursor] !== ',') return fail("Expecting ',' delimiter");
                cursor++; whitespace();
            }
        } else {
            const token = text.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
            if (token) { cursor += token[0].length; return true; }
            return fail('Expecting value');
        }
        return fail('Expecting value');
    }
    if (value()) { whitespace(); if (cursor < text.length) fail('Extra data'); }
    return detail || { reason: 'Expecting value', position: cursor };
}
function importMessageJson(data) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (raw.length > MAX_MESSAGE_JSON_BYTES) throw new DraftValidationError('JSON files cannot exceed ' + MAX_MESSAGE_JSON_BYTES / (1024 * 1024) + ' MB.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/, ''); }
    catch { throw new DraftValidationError('The JSON file must use UTF-8 text encoding.'); }
    let payload;
    try { payload = JSON.parse(text); }
    catch (error) {
        const { position, reason } = jsonErrorDetails(text);
        const prefix = text.slice(0, position), line = prefix.split('\n').length;
        const column = Array.from(prefix.slice(prefix.lastIndexOf('\n') + 1)).length + 1;
        throw new DraftValidationError('Invalid JSON at line ' + line + ', column ' + column + ': ' + reason + '.');
    }
    if (!isObject(payload)) throw new DraftValidationError('The JSON root must be an object.');
    // Versioned custom-message exports share a schema independent of the exporter label.
    const customExport = payload.format === MESSAGE_JSON_FORMAT ||
        (typeof payload.format === 'string' && payload.format.endsWith('-custom-message'));
    const result = customExport ? draftFromExport(payload) : draftFromDiscordJson(payload);
    if (result.additionalEmbeds.length > 9) throw new DraftValidationError('A message can contain at most 10 embeds, including the editable embed.');
    const errors = validateEmbedDraft(result.draft);
    if (errors.length) throw new DraftValidationError('Imported message validation failed: ' + errors.join(' '));
    return result;
}
const PROPERTY_LABELS = Object.freeze({
    messageAttachments: 'Message attachments', title: 'Title', titleUrl: 'Title URL', authorName: 'Author name',
    authorUrl: 'Author URL', authorIcon: 'Author icon', thumbnail: 'Thumbnail', description: 'Description', image: 'Image',
    footerText: 'Footer text', footerIcon: 'Footer icon', timestamp: 'Footer timestamp', color: 'Embed color', crowControlBranding: 'Crow Control branding'
});
function populatedEmbedProperties(draft) {
    const snapshot = draft.snapshot();
    const populated = Object.entries(PROPERTY_LABELS).filter(([key]) => key !== 'crowControlBranding' &&
        (Array.isArray(snapshot[key]) ? snapshot[key].length : Boolean(snapshot[key]))).map(([, label]) => label);
    if (draft.fields.length) populated.push(draft.fields.length + ' field' + (draft.fields.length === 1 ? '' : 's'));
    return populated;
}
function pythonDisplay(value) {
    if (Array.isArray(value)) return '[' + value.map(item => "'" + String(item).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'").join(', ') + ']';
    return String(value || '');
}
function shorten(value, limit = 240) {
    const text = Array.from(pythonDisplay(value));
    return text.length <= limit ? text.join('') : text.slice(0, Math.max(0, limit - 3)).join('') + '...';
}
function fieldDifference(values, other) {
    const counts = new Map();
    for (const value of other) { const key = JSON.stringify(value); counts.set(key, (counts.get(key) || 0) + 1); }
    return values.filter(value => {
        const key = JSON.stringify(value), count = counts.get(key) || 0;
        if (count) { counts.set(key, count - 1); return false; }
        return true;
    });
}
function formatEmbedChanges(before, after, { limit = 3500 } = {}) {
    const oldValues = before.snapshot(), newValues = after.snapshot(), lines = [];
    for (const [key, label] of Object.entries(PROPERTY_LABELS)) {
        const old = oldValues[key], value = newValues[key];
        if (isDeepStrictEqual(old, value)) continue;
        const boolean = typeof old === 'boolean' || typeof value === 'boolean';
        const oldText = boolean ? old ? 'Yes' : 'No' : shorten(Array.isArray(old) && !old.length ? 'Empty' : old || 'Empty');
        const newText = boolean ? value ? 'Yes' : 'No' : shorten(Array.isArray(value) && !value.length ? 'Empty' : value || 'Empty');
        lines.push('**' + label + ':** ' + quoted(oldText) + ' -> ' + quoted(newText));
    }
    const oldFields = oldValues.fields.map(field => [String(field.name || ''), String(field.value || ''), Boolean(field.inline)]);
    const newFields = newValues.fields.map(field => [String(field.name || ''), String(field.value || ''), Boolean(field.inline)]);
    if (!isDeepStrictEqual(oldFields, newFields)) {
        const removed = fieldDifference(oldFields, newFields), added = fieldDifference(newFields, oldFields);
        if (removed.length) lines.push('**Fields removed:** ' + removed.map(item => quoted(shorten(item[0], 60))).join(', '));
        if (added.length) lines.push('**Fields added:** ' + added.map(item => quoted(shorten(item[0], 60))).join(', '));
        if (!added.length && !removed.length) lines.push('**Fields:** reordered');
        else if (oldFields.length === newFields.length) {
            const edited = oldFields.map((field, index) => !isDeepStrictEqual(field, newFields[index]) ? String(index + 1) : null).filter(Boolean);
            if (edited.length) lines.push('**Fields edited/reordered at positions:** ' + edited.join(', '));
        }
    }
    const result = lines.join('\n') || 'No embed property changes.';
    return characters(result) > limit ? Array.from(result).slice(0, Math.max(0, limit - 24)).join('') + '\n... changes truncated' : result;
}
// Discord's Remove Embed action persists suppression across edits. Clear only
// that bit when saving an embed, and retain the message's remaining flags.
function visibleEmbedEditOptions(message) {
    const flags = new MessageFlagsBitField(message.flags?.bitfield ?? message.flags ?? 0);
    return flags.has(MessageFlags.SuppressEmbeds)
        ? { flags: flags.remove(MessageFlags.SuppressEmbeds).bitfield } : {};
}

module.exports = {
    visibleEmbedEditOptions,
    MAX_MESSAGE_CONTENT, MAX_TITLE, MAX_DESCRIPTION, MAX_AUTHOR_NAME, MAX_FOOTER_TEXT, MAX_FIELD_NAME, MAX_FIELD_VALUE,
    MAX_FIELDS, MAX_EMBED_TEXT, MAX_MESSAGE_ATTACHMENTS, IMAGE_EXTENSIONS, CROW_CONTROL_BRANDING_COLOR,
    MESSAGE_JSON_FORMAT, MESSAGE_JSON_VERSION, MAX_MESSAGE_JSON_BYTES, INVISIBLE_COLOR_ONLY_FIELD,
    FOOTER_TEXT, LOGO_PATH, LOGO_FILENAME, LOGO_ATTACHMENT_URL, LOGO_URL, COLOR_NAMES, PROPERTY_LABELS,
    DraftValidationError, ImportedAttachment, EmbedFieldDraft, EmbedMediaDraft, MessageAttachmentDraft, EmbedDraft,
    expandLiteralLineBreaks, expandFieldSpacingEscapes, isHttpsUrl, parseEmbedTimestamp, formatEmbedTimestamp, normalizeEmbedColor,
    logoAttachment, logoFile, isImageAttachment, applyCrowControlBrandingDefaults, draftFromMessage, validateEmbedDraft,
    mediaAttachmentIds, referencedAttachmentIds, relatedAttachmentIdsFromMessage, attachmentIdsReferencedByEmbeds,
    attachmentToFile, readAttachmentBytes, buildNewAttachmentFiles, buildMediaFiles, buildMessageAttachmentFiles,
    reconcileEditAttachments, closeFiles, brandedEditAttachments, exportMessageJson, importMessageJson,
    populatedEmbedProperties, formatEmbedChanges
};
