// Compares saved scout fields and formats report/source IDs for review messages.
'use strict';

function attachmentIdentity(items = []) {
    return items.map(item => ({ id: String(item.id || String(item.url || '').split('?')[0]),
        name: item.name || '' })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function sameValue(key, before, after) {
    const normalize = value => {
        if (key === 'attachments') return attachmentIdentity(value || []);
        if (key === 'createdAt' && value != null) {
            const time = new Date(value).getTime();
            if (Number.isFinite(time)) return time;
        }
        if (['rating', 'ignConfidence'].includes(key) && value != null) return Number(value);
        return value === '' ? null : value ?? null;
    };
    return JSON.stringify(normalize(before)) === JSON.stringify(normalize(after));
}

function scoutIds(reportId, messageId) {
    return (reportId && String(reportId) !== String(messageId) ? `**Scout Report ID:** \`${reportId}\`\n` : '')
        + `**Scout Message ID:** \`${messageId}\``;
}

function scoutIdFooter(reportId, messageId) {
    return String(reportId) === String(messageId) ? `CC • Scout Message ID: ${messageId}` : `CC • Scout Report ID: ${reportId}`;
}

module.exports = { attachmentIdentity, sameValue, scoutIds, scoutIdFooter };
