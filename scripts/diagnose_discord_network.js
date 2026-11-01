// Public HTTP probes only: no .env, bot login, interaction tokens or database.
'use strict';

const dns = require('node:dns/promises');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { DefaultUserAgent } = require('@discordjs/rest');
const { networkErrorCode: safeCode } = require('../utils/networkErrors.js');
const { abortable } = require('../utils/abortable.js');

const TARGET = 'https://discord.com/api/v10/gateway';

function probe(agent, family) {
    return new Promise(resolve => {
        const started = performance.now();
        const timings = {};
        const elapsed = () => Math.round(performance.now() - started);
        const request = https.get(TARGET, {
            agent, ...(family ? { family } : {}), signal: AbortSignal.timeout(8000),
            headers: { 'User-Agent': DefaultUserAgent }
        }, response => {
            timings.headersMs = elapsed();
            timings.status = response.statusCode;
            response.resume();
            response.once('end', () => resolve({ ...timings, totalMs: elapsed() }));
            response.once('error', error => resolve({ ...timings, error: safeCode(error), totalMs: elapsed() }));
        });
        request.once('socket', socket => {
            timings.reused = request.reusedSocket;
            if (socket.connecting) {
                socket.once('lookup', () => { timings.dnsMs = elapsed(); });
                socket.once('connect', () => { timings.tcpMs = elapsed(); });
                socket.once('secureConnect', () => { timings.tlsMs = elapsed(); timings.family = socket.remoteFamily; });
            } else { timings.family = socket.remoteFamily; }
        });
        request.once('error', error => resolve({ ...timings, error: safeCode(error), totalMs: elapsed() }));
    });
}

async function main() {
    console.log(`Discord public network diagnostic; Node ${process.version}; all times in ms from request start.`);
    const lookupStart = performance.now();
    try {
        const addresses = await abortable(dns.lookup('discord.com', { all: true }), { timeoutMs: 8000, timeoutCode: 'DNS_LOOKUP_TIMEOUT' });
        console.log(JSON.stringify({ systemLookupMs: Math.round(performance.now() - lookupStart), addresses: addresses.length }));
    } catch (error) {
        console.log(JSON.stringify({ systemLookupMs: Math.round(performance.now() - lookupStart), systemLookupError: safeCode(error) }));
    }
    const started = performance.now();
    const resolver = new dns.Resolver({ timeout: 2000, tries: 1 });
    const dnsTimeout = setTimeout(() => resolver.cancel(), 8000);
    try {
        const [ipv4, ipv6] = await Promise.allSettled([resolver.resolve4('discord.com'), resolver.resolve6('discord.com')]);
        console.log(JSON.stringify({ dnsMs: Math.round(performance.now() - started),
            ...(ipv4.status === 'fulfilled' ? { IPv4Addresses: ipv4.value.length } : { IPv4LookupError: safeCode(ipv4.reason) }),
            ...(ipv6.status === 'fulfilled' ? { IPv6Addresses: ipv6.value.length } : { IPv6LookupError: safeCode(ipv6.reason) }) }));
    } catch (error) { console.log(JSON.stringify({ dnsError: safeCode(error) })); }
    finally { clearTimeout(dnsTimeout); }
    for (const [label, family] of [['default', undefined], ['IPv4', 4], ['IPv6', 6]]) {
        const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
        try {
            for (const attempt of ['cold', 'warm']) {
                const result = await probe(agent, family);
                console.log(JSON.stringify({ route: label, attempt, ...result }));
                if (result.error) break;
            }
        } finally { agent.destroy(); }
    }
    console.log('A public GET cannot reproduce every interaction failure. Compare this output with callback socket/header timings in the bot log.');
}

if (require.main === module) main().catch(error => { console.error(`Diagnostic failed (${safeCode(error)}).`); process.exitCode = 1; });

module.exports = { probe };
