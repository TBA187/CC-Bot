'use strict';

function networkErrorCode(error) {
    const seen = new Set();
    let name;
    for (let current = error; current && !seen.has(current) && seen.size < 8; current = current.cause) {
        seen.add(current);
        if (typeof current.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(current.code)) return current.code;
        if (current.name && current.name !== 'Error') name = current.name;
    }
    return /^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(name || '') ? name : 'UNKNOWN';
}

function isTransientDiscordError(error) {
    return /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/u.test(networkErrorCode(error))
        || (Number(error?.status) >= 500 && Number(error?.status) <= 599);
}

module.exports = { networkErrorCode, isTransientDiscordError };
