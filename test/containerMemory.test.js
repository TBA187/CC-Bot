'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContainerMemoryReader, readContainerMemory, readProcessRss } = require('../utils/containerMemory.js');

const fixture = values => async file => {
    if (!(file in values)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return values[file];
};

test('v2 finds the process cgroup below a host mount and honors a stricter ancestor limit', async () => {
    const values = {
        '/proc/self/cgroup': '0::/services/bot\n',
        '/proc/self/mountinfo': '23 22 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
        '/sys/fs/cgroup/memory.current': '999999',
        '/sys/fs/cgroup/services/bot/memory.current': '450',
        '/sys/fs/cgroup/services/bot/memory.max': 'max',
        '/sys/fs/cgroup/services/memory.max': '500',
        '/sys/fs/cgroup/memory.max': '1000',
        '/sys/fs/cgroup/services/bot/memory.stat': 'file 100\ninactive_file 80\n',
        '/sys/fs/cgroup/services/bot/memory.peak': '475'
    };
    const reader = createContainerMemoryReader({ readFile: fixture(values) });
    assert.deepEqual(await reader.readMemory(), { used: 450, limit: 500, fileCache: 100, inactiveFile: 80, workingSet: 370 });
    assert.equal(await reader.readPeak(), 475);
    delete values['/sys/fs/cgroup/services/bot/memory.current'];
    assert.equal(await reader.readMemory(), null, 'must not substitute whole-host usage for an unreadable nested cgroup');
});

test('v1 resolves a bind mount root and escaped mount names', async () => {
    const memory = await readContainerMemory(fixture({
        '/proc/self/cgroup': '7:cpu:/other\n5:memory:/docker/bot/worker\n',
        '/proc/self/mountinfo': '23 22 0:20 /docker/bot /sys/memory\\040group rw - cgroup memory rw,memory\n',
        '/sys/memory group/worker/memory.usage_in_bytes': '250',
        '/sys/memory group/worker/memory.limit_in_bytes': '9223372036854771712',
        '/sys/memory group/memory.limit_in_bytes': '400',
        '/sys/memory group/worker/memory.stat': 'total_cache 50\ntotal_inactive_file 40\n'
    }));
    assert.deepEqual(memory, { used: 250, limit: 400, fileCache: 50, inactiveFile: 40, workingSet: 210 });
});

test('usage remains usable with unlimited, missing or unreadable limits and zero usage is valid', async () => {
    for (const limit of ['max', '9223372036854771712', undefined]) {
        const values = { '/sys/fs/cgroup/memory.current': '0', '/sys/fs/cgroup/memory.stat': 'inactive_file 0\n' };
        if (limit !== undefined) values['/sys/fs/cgroup/memory.max'] = limit;
        const memory = await readContainerMemory(fixture(values));
        assert.deepEqual(memory, { used: 0, limit: null, fileCache: null, inactiveFile: 0, workingSet: 0 });
    }
    assert.equal(await readContainerMemory(fixture({ '/sys/fs/cgroup/memory.current': 'garbage' })), null);
});

test('mount discovery is cached briefly and detects a changed process cgroup', async () => {
    let now = 0, discoveries = 0;
    const values = { '/sys/fs/cgroup/memory.current': '100' };
    const read = fixture(values);
    const reader = createContainerMemoryReader({ now: () => now, readFile: file => {
        if (file === '/proc/self/cgroup') discoveries++;
        return read(file);
    } });
    await reader.readMemory(); await reader.readMemory();
    assert.equal(discoveries, 1);
    values['/proc/self/cgroup'] = '0::/bot';
    values['/proc/self/mountinfo'] = '23 22 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw';
    values['/sys/fs/cgroup/bot/memory.current'] = '150';
    now = 60000;
    assert.equal((await reader.readMemory()).used, 150);
    assert.equal(discoveries, 2);
});

test('helper RSS reads only a validated process path and handles exited helpers', async () => {
    const read = fixture({ '/proc/123/status': 'Name:\tocr\nVmRSS:\t204800 kB\n' });
    assert.equal(await readProcessRss(123, read), 200 * 1024 * 1024);
    assert.equal(await readProcessRss(124, read), null);
    assert.equal(await readProcessRss('../self', () => assert.fail('must not read an invalid PID')), null);
});
