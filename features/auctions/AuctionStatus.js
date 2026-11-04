// Shares auction status rules between monitoring and subscriptions.
'use strict';

function ended(auction) {
    return /^(?:inactive|ended|closed|sold|completed|expired|cancelled|canceled)$/i.test(String(auction?.status || '').trim());
}

function active(auction) {
    return !auction?.sourceUnavailable && /^(?:active|instant price)$/i.test(String(auction?.status || '').trim());
}

module.exports = { active, ended };
