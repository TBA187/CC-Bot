'use strict';

const fs = require('node:fs/promises');
const path = require('node:path').posix;

function bytes(value, { zero = false } = {}) {
    if (!/^\d+$/u.test(String(value).trim())) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && (zero ? number >= 0 : number > 0) ? number : null;
}

const unescapePath = value => value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

function locations(cgroups, mounts) {
    const groups = String(cgroups).split('\n').map(line => /^(\d+):([^:]*):(\/.*)$/u.exec(line)).filter(Boolean);
    const found = [];
    for (const line of String(mounts).split('\n')) {
        const [before, after] = line.split(' - ');
        if (!after) continue;
        const fields = before.split(' '), [type, , options = ''] = after.split(' ');
        const version = type === 'cgroup2' ? 2 : type === 'cgroup' && options.split(',').includes('memory') ? 1 : null;
        if (!version || fields.length < 5) continue;
        const group = groups.find(item => version === 2 ? item[1] === '0' && item[2] === '' : item[2].split(',').includes('memory'));
        if (!group) continue;
        const root = unescapePath(fields[3]), mount = unescapePath(fields[4]), membership = unescapePath(group[3]);
        const relative = path.relative(root, membership);
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
        const directory = path.resolve(mount, relative);
        if (directory !== mount && !directory.startsWith(mount + '/')) continue;
        found.push({ directory, mount, version });
    }
    return found;
}

function createContainerMemoryReader({ readFile = fs.readFile, now = Date.now } = {}) {
    let candidates, discoveredAt = -Infinity;
    async function discover() {
        if (candidates && now() - discoveredAt < 60_000) return candidates;
        const [groups, mounts] = await Promise.all([
            readFile('/proc/self/cgroup', 'utf8').catch(() => ''),
            readFile('/proc/self/mountinfo', 'utf8').catch(() => '')
        ]);
        candidates = locations(groups, mounts);
        // Namespaced containers commonly expose their own cgroup directly here.
        if (!candidates.length) candidates = [
            { directory: '/sys/fs/cgroup', mount: '/sys/fs/cgroup', version: 2 },
            { directory: '/sys/fs/cgroup/memory', mount: '/sys/fs/cgroup/memory', version: 1 }
        ];
        discoveredAt = now();
        return candidates;
    }

    async function readMemory() {
        for (const { directory, mount, version } of await discover()) {
            try {
                const limitFile = version === 2 ? 'memory.max' : 'memory.limit_in_bytes';
                const limits = [];
                for (let parent = directory; ; parent = path.dirname(parent)) {
                    limits.push(readFile(path.join(parent, limitFile), 'utf8').then(value => bytes(value)).catch(() => null));
                    if (parent === mount) break;
                }
                const [current, stat, maximums] = await Promise.all([
                    readFile(path.join(directory, version === 2 ? 'memory.current' : 'memory.usage_in_bytes'), 'utf8'),
                    readFile(path.join(directory, 'memory.stat'), 'utf8').catch(() => ''), Promise.all(limits)
                ]);
                const used = bytes(current, { zero: true });
                if (used === null) continue;
                const finiteLimits = maximums.filter(value => value !== null);
                const value = key => bytes(new RegExp(`^${key}\\s+(\\d+)$`, 'mu').exec(stat)?.[1], { zero: true });
                const inactiveFile = value(version === 2 ? 'inactive_file' : 'total_inactive_file');
                return { used, limit: finiteLimits.length ? Math.min(...finiteLimits) : null,
                    fileCache: value(version === 2 ? 'file' : 'total_cache'), inactiveFile,
                    workingSet: inactiveFile !== null && inactiveFile <= used ? used - inactiveFile : null };
            } catch { /* Try another visible memory hierarchy. */ }
        }
        return null;
    }

    async function readPeak() {
        for (const { directory, version } of await discover()) {
            try {
                const peak = bytes(await readFile(path.join(directory, version === 2 ? 'memory.peak' : 'memory.max_usage_in_bytes'), 'utf8'));
                if (peak !== null) return peak;
            } catch { /* Older kernels may not expose a high-water mark. */ }
        }
        return null;
    }
    return { readMemory, readPeak };
}

const defaultReader = createContainerMemoryReader();
const readContainerMemory = readFile => (readFile ? createContainerMemoryReader({ readFile }) : defaultReader).readMemory();
const readContainerPeak = readFile => (readFile ? createContainerMemoryReader({ readFile }) : defaultReader).readPeak();

async function readProcessRss(pid, readFile = fs.readFile) {
    if (!/^[1-9]\d*$/u.test(String(pid))) return null;
    try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const rss = bytes(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1], { zero: true });
        return rss === null ? null : rss * 1024;
    } catch { return null; }
}

module.exports = { createContainerMemoryReader, readContainerMemory, readContainerPeak, readProcessRss };
