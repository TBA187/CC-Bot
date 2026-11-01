/**
 * @fileoverview Mirror stdout and stderr into timestamped monthly bot logs from startup through shutdown.
 * Buffer partial lines, preserve console arguments and schedule log maintenance.
 */
'use strict';

const { StringDecoder } = require('node:string_decoder');
const { formatTimestamp, stripBotLogPrefix } = require('./logFormat.js');
const { createMonthlyFileHandler } = require('./logFiles.js');

const DEFAULT_LOG_PATH = 'data/logs/cc.log';
const DEFAULT_LOG_RETENTION_MONTHS = 12;
const DEFAULT_LOG_MAX_TOTAL_MIB = 100;
const DEFAULT_LOG_MIN_FREE_MIB = 100;
const DEFAULT_LOG_CLEANUP_TARGET_FREE_MIB = 150;
const LOG_MAINTENANCE_CHECK_MS = 60 * 60 * 1000;
const installedStreams = new WeakMap();

function envInteger(env, name, fallback, minimum) {
    const text = String(env[name] ?? fallback).trim();
    // Match Python int parsing instead of accepting fractions or a numeric prefix.
    if (!/^[+-]?\d+(?:_\d+)*$/u.test(text)) return fallback;
    const value = Number(text.replaceAll('_', ''));
    return Number.isSafeInteger(value) ? Math.max(minimum, value) : fallback;
}

function createFileLogHandler({
    path, retentionMonths, maxTotalMib, minFreeMib, cleanupTargetFreeMib,
    env = process.env, ...handlerOptions
} = {}) {
    try {
        return createMonthlyFileHandler(path || env.BOT_LOG_PATH || DEFAULT_LOG_PATH, {
            ...handlerOptions,
            retentionMonths: retentionMonths || envInteger(env, 'BOT_LOG_RETENTION_MONTHS', DEFAULT_LOG_RETENTION_MONTHS, 1),
            maxTotalMib: maxTotalMib == null
                ? envInteger(env, 'BOT_LOG_MAX_TOTAL_MIB', DEFAULT_LOG_MAX_TOTAL_MIB, 0) : Math.max(0, Math.trunc(maxTotalMib)),
            minFreeMib: minFreeMib == null
                ? envInteger(env, 'BOT_LOG_MIN_FREE_MIB', DEFAULT_LOG_MIN_FREE_MIB, 0) : Math.max(0, Math.trunc(minFreeMib)),
            cleanupTargetFreeMib: cleanupTargetFreeMib == null
                ? envInteger(env, 'BOT_LOG_CLEANUP_TARGET_FREE_MIB', DEFAULT_LOG_CLEANUP_TARGET_FREE_MIB, 0)
                : Math.max(0, Math.trunc(cleanupTargetFreeMib))
        });
    } catch (error) {
        // File access must not stop the bot; programming errors should still surface.
        if (error && typeof error.code === 'string' && !error.code.startsWith('ERR_')) return null;
        throw error;
    }
}

function splitLines(text) {
    return text.match(/[^\r\n\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\r\n\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)
        ?.filter(Boolean) || [];
}

class TimestampedConsole {
    constructor(stream, { fileHandler = null, now = () => new Date(), onFileError = () => {} } = {}) {
        this.stream = stream;
        this.fileHandler = fileHandler;
        this.now = now;
        this.onFileError = onFileError;
        this.originalWrite = stream.write;
        this.atLineStart = true;
        this.pendingLogText = '';
        this.pendingPrefix = '';
        this.decoder = new StringDecoder('utf8');
        this.mirroring = false;
        this.wrapper = this.write.bind(this);
    }

    install() {
        this.stream.write = this.wrapper;
        installedStreams.set(this.stream, this);
        return this;
    }

    write(chunk, encoding, callback) {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
            return this.originalWrite.call(this.stream, chunk, encoding, callback);
        }
        const decoded = typeof chunk === 'string'
            ? this.decoder.end() + chunk : this.decoder.write(Buffer.from(chunk));
        const text = this.stripPrefix(decoded);
        if (typeof chunk === 'string') this.decoder = new StringDecoder('utf8');
        const formatted = this.timestamp(text);
        this.mirror(text);
        // One underlying write preserves callbacks and its backpressure return value.
        if (typeof encoding === 'function') return this.originalWrite.call(this.stream, formatted, encoding);
        return this.originalWrite.call(this.stream, formatted, typeof chunk === 'string' ? encoding : 'utf8', callback);
    }

    // Grouped startup entries use one timestamp for the header in both outputs.
    writeBlock(lines) {
        if (!lines.length) return true;
        this.flush();
        const text = formatTimestamp(this.now()) + ' ' + lines.map(stripBotLogPrefix).join('\n');
        const written = this.originalWrite.call(this.stream, (this.atLineStart ? '' : '\n') + text + '\n', 'utf8');
        this.atLineStart = true;
        if (this.fileHandler && !this.mirroring) {
            this.mirroring = true;
            try { this.fileHandler.write(text); }
            catch (error) { this.onFileError(error); }
            finally { this.mirroring = false; }
        }
        return written;
    }

    stripPrefix(text, final = false) {
        let output = '';
        let atLineStart = this.atLineStart;
        const fragments = splitLines(this.pendingPrefix + text);
        this.pendingPrefix = '';
        for (let fragment of fragments) {
            // A direct writer can split the bot tag across calls. Buffer only
            // its possible nine-character prefix, keeping normal writes immediate.
            if (atLineStart && !final && ['[CC LOG] ', '[WW LOG] '].some(prefix => prefix.startsWith(fragment))) {
                this.pendingPrefix = fragment;
                break;
            }
            if (atLineStart) fragment = stripBotLogPrefix(fragment);
            output += fragment;
            if (/[\r\n]$/u.test(fragment)) atLineStart = true;
            else if (fragment) atLineStart = false;
        }
        return output;
    }

    timestamp(text) {
        let output = '';
        for (const fragment of splitLines(text)) {
            if (this.atLineStart && !/^(?:\n|\r|\r\n)$/u.test(fragment)) {
                output += formatTimestamp(this.now()) + ' ';
            }
            output += fragment;
            if (/[\r\n]$/u.test(fragment)) this.atLineStart = true;
            else if (fragment) this.atLineStart = false;
        }
        return output;
    }

    saveLine(text) {
        try { this.fileHandler.write(formatTimestamp(this.now()) + ' ' + text); }
        catch (error) { this.onFileError(error); }
    }

    mirror(text) {
        if (!this.fileHandler || !text || this.mirroring) return;
        this.mirroring = true;
        try {
            const lines = splitLines(this.pendingLogText + text);
            this.pendingLogText = '';
            for (const line of lines) {
                if (/[\r\n]$/u.test(line)) this.saveLine(line.replace(/[\r\n]+$/u, ''));
                else this.pendingLogText = line;
            }
        } finally {
            this.mirroring = false;
        }
    }

    flush() {
        const remaining = this.stripPrefix(this.decoder.end(), true);
        this.decoder = new StringDecoder('utf8');
        if (remaining) {
            this.originalWrite.call(this.stream, this.timestamp(remaining), 'utf8');
            this.mirror(remaining);
        }
        if (!this.fileHandler || !this.pendingLogText || this.mirroring) return;
        this.mirroring = true;
        try {
            const pending = this.pendingLogText;
            this.pendingLogText = '';
            this.saveLine(pending);
        } finally {
            this.mirroring = false;
        }
    }

    restore() {
        this.flush();
        if (this.stream.write === this.wrapper) {
            this.stream.write = this.originalWrite;
            installedStreams.delete(this.stream);
        }
    }
}

function installTimestampedConsole({
    stdout = process.stdout, stderr = process.stderr, ...options
} = {}) {
    return [...new Set([stdout, stderr])].map(stream =>
        installedStreams.get(stream) || new TimestampedConsole(stream, options).install());
}

function installRuntimeLogging({
    env = process.env, stdout = process.stdout, stderr = process.stderr,
    now = () => new Date(), processImpl = process,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
    fileHandler = createFileLogHandler({ env, now })
} = {}) {
    const rawStderrWrite = stderr.write.bind(stderr);
    const reportFileError = error => {
        // Bypass the mirror when reporting its own write failure to prevent recursion.
        rawStderrWrite(formatTimestamp(now()) + ' File logging failed: '
            + (error?.stack || String(error)) + '\n');
    };
    const streams = installTimestampedConsole({ stdout, stderr, fileHandler, now, onFileError: reportFileError });
    let stopped = false;
    let maintenanceTimer;
    const flush = () => { for (const stream of streams) stream.flush(); };
    const maintenance = () => {
        if (stopped || !fileHandler) return;
        try {
            for (const message of fileHandler.enforceLimits()) stderr.write(message + '\n');
        } catch (error) {
            reportFileError(error);
        }
    };
    const onFatalError = error => {
        if (!fileHandler || stopped) return;
        // Node's default fatal-error printer can bypass stream.write; observe it
        // without handling the exception or changing the process's exit behavior.
        flush();
        try { fileHandler.write(formatTimestamp(now()) + ' ' + (error?.stack || String(error))); }
        catch (fileError) { reportFileError(fileError); }
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        if (maintenanceTimer !== undefined) clearIntervalImpl(maintenanceTimer);
        processImpl.removeListener?.('exit', stop);
        processImpl.removeListener?.('uncaughtExceptionMonitor', onFatalError);
        for (const stream of streams) stream.restore();
        try { fileHandler?.close(); }
        catch (error) { reportFileError(error); }
    };

    processImpl.once?.('exit', stop);
    processImpl.on?.('uncaughtExceptionMonitor', onFatalError);
    if (fileHandler) {
        stdout.write('Detailed logs are being saved to ' + fileHandler.baseFilename + '\n');
        maintenance();
        maintenanceTimer = setIntervalImpl(maintenance, LOG_MAINTENANCE_CHECK_MS);
        maintenanceTimer.unref?.();
    } else {
        stderr.write('File logging could not be enabled; console logging will continue normally.\n');
    }
    return { fileHandler, flush, stop,
        logBlock: lines => streams.find(stream => stream.stream === stdout).writeBlock(lines) };

}

module.exports = {
    DEFAULT_LOG_PATH, DEFAULT_LOG_RETENTION_MONTHS, DEFAULT_LOG_MAX_TOTAL_MIB,
    DEFAULT_LOG_MIN_FREE_MIB, DEFAULT_LOG_CLEANUP_TARGET_FREE_MIB, LOG_MAINTENANCE_CHECK_MS,
    formatTimestamp, createFileLogHandler, TimestampedConsole,
    installTimestampedConsole, installRuntimeLogging
};
