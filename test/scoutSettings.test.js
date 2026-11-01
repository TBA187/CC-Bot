// Cover scout settings menus, permissions and unique component IDs.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ScoutSettings = require('../commands/scout-settings.js');
const { ScoutReportManager } = require('../features/pvp-scouting/ScoutReportManager.js');
const { reportVersion } = require('../features/pvp-scouting/ScoutReportAdminStore.js');
const { normalizeMessageRow, PvpScoutStore } = require('../features/pvp-scouting/PvpScoutStore.js');
const { ScoutRosterStore } = require('../features/pvp-scouting/ScoutRosterStore.js');

const OWNER = '291142291073269761';
const ID = '1350059044102078494';
function source(id = ID) {
    return normalizeMessageRow({ message_id: id, root_message_id: ID, channel_id: 'channel', opponent_ign: 'Blacku',
        ign_normalized: 'blacku', classification: 'scout', review_status: 'confirmed', author_id: OWNER,
        author_username: 'reporter', created_at: new Date('2025-03-14T11:52:00Z'), rating: 300,
        message_content: 'Blacku\nTornadus: Hidden Power Ice', team_text: '- Tornadus: Hidden Power Ice',
        source_url: `https://discord.com/channels/1/2/${id}`, attachments_json: '[]', ocr_json: '[]' });
}
function config() {
    const list = (status = '') => Array.from({ length: 60 }, (_, n) => ({ entry_id: String(n + 1), ign: `Opponent${n}`,
        discord_id: String(BigInt(OWNER) + BigInt(n)), username: `user${n}`, server_nickname: `Opponent${n}`, status }));
    return { guildId: 'guild', guildMemberRoleID: 'member', adminRoleID: 'admin', officerRoleID: 'officer',
        scoutRosterStore: { async listFriendly(_guild, limit, offset) { const rows = list(); return { rows: rows.slice(offset, offset + limit), total: rows.length }; },
            async listMembers(_guild, status, limit, offset) { const rows = list(status); return { rows: rows.slice(offset, offset + limit), total: rows.length }; } },
        pvpScoutStore: {} };
}
function interaction(customId = '', fields = {}) {
    const calls = [];
    return { customId, calls, user: { id: OWNER }, member: { roles: ['officer'] },
        ...(customId ? { message: { id: 'settings-message', components: [], attachments: new Map() } } : {}),
        guild: { id: 'guild', members: { cache: new Map() } }, values: [],
        inGuild: () => true, isChatInputCommand: () => !customId, options: { getString: () => null },
        fields: { getTextInputValue: name => fields[name] ?? '' },
        async deferReply(value) { calls.push(['deferReply', value]); this.deferred = true; },
        async deferUpdate() { calls.push(['deferUpdate']); this.deferred = true; },
        async editReply(value) { calls.push(['editReply', value]); },
        async reply(value) { calls.push(['reply', value]); }, async followUp(value) { calls.push(['followUp', value]); },
        async update(value) { calls.push(['update', value]); }, async showModal(value) { calls.push(['showModal', value]); }
    };
}
function validatePanel(payload) {
    const components = payload.components.flatMap(row => row.toJSON().components);
    const ids = components.map(component => component.custom_id);
    assert.equal(new Set(ids).size, ids.length, 'all buttons and selects need unique custom IDs');
    assert.ok(ids.every(id => id.length <= 100));
    assert.ok(payload.components.length <= 5);
    for (const component of components) if (component.options) assert.ok(component.options.length <= 25);
    const total = payload.embeds.map(embed => embed.toJSON()).reduce((sum, embed) => sum
        + (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0)
        + (embed.fields || []).reduce((n, field) => n + field.name.length + field.value.length, 0), 0);
    assert.ok(total <= 6000, `embed text size ${total}`);
}

test('settings home keeps the requested description and places Scout Reports last', () => {
    const settings = new ScoutSettings(config());
    validatePanel(settings.home(OWNER));
    assert.deepEqual(settings.home(OWNER).components[0].toJSON().components.map(button => button.label),
        ['Friendly List', 'Member List', 'Scout Reports']);
    assert.match(settings.home(OWNER).embeds[0].toJSON().description, /search and edit\/delete/iu);
    assert.equal(settings.data.toJSON().options[0].autocomplete, true);
});

test('friendly and current/former member menus have unique IDs on empty, one-page and pagination edges', async () => {
    for (const count of [0, 1, 25, 60]) {
        const cfg = config();
        for (const method of ['listFriendly', 'listMembers']) {
            const original = cfg.scoutRosterStore[method];
            cfg.scoutRosterStore[method] = async (...args) => {
                const value = await original(...args); return { rows: value.rows.slice(0, Math.max(0, count - args.at(-1))), total: count };
            };
        }
        const settings = new ScoutSettings(cfg);
        for (const page of [0, Math.max(0, Math.ceil(count / 25) - 1), 50]) {
            validatePanel(await settings.friendlyPanel(OWNER, page));
            for (const status of ['current', 'former']) validatePanel(await settings.memberPanel(OWNER, status, page));
        }
    }
});

test('full roster pages with long names stay inside Discord description limits', async () => {
    const cfg = config();
    const rows = Array.from({ length: 25 }, (_, n) => ({ entry_id: String(n + 1), discord_id: OWNER,
        ign: 'I'.repeat(32), username: 'U'.repeat(128), server_nickname: 'N'.repeat(128) }));
    cfg.scoutRosterStore.listFriendly = cfg.scoutRosterStore.listMembers = async () => ({ rows, total: 25 });
    const settings = new ScoutSettings(cfg);
    for (const payload of [await settings.friendlyPanel(OWNER), await settings.memberPanel(OWNER)]) {
        validatePanel(payload); assert.ok(payload.embeds[0].toJSON().description.length <= 4096);
    }
});

test('settings command and list buttons acknowledge before storage queries', async () => {
    const settings = new ScoutSettings(config());
    const slash = interaction();
    await settings.execute(slash);
    assert.equal(slash.calls[0][0], 'deferReply');
    const click = interaction(`scout-settings:open-friendly:${OWNER}:0`);
    const original = settings.store.listFriendly;
    settings.store.listFriendly = async (...args) => {
        assert.equal(click.calls[0][0], 'deferUpdate'); return original(...args);
    };
    await settings.handleButton(click);
    assert.equal(click.calls[1][0], 'editReply');
});

test('cached edit buttons open modals without reading the database before acknowledgement', async () => {
    const settings = new ScoutSettings(config());
    await settings.friendlyPanel(OWNER);
    settings.store.listFriendly = async () => { throw new Error('Must not read DB before showModal'); };
    const click = interaction(`scout-settings:edit-friendly:${OWNER}:0:1`);
    await settings.handleButton(click);
    assert.equal(click.calls[0][0], 'showModal');
});

test('staff-only and owner-only guards deny access with private feedback', async () => {
    const settings = new ScoutSettings(config());
    const nonstaff = interaction(); nonstaff.member.roles = [];
    await settings.execute(nonstaff);
    assert.equal(nonstaff.calls[1][0], 'editReply');
    assert.match(nonstaff.calls[1][1].content, /Only Crow Control/u);
    const other = interaction('scout-settings:open-friendly:123456789012345678:0');
    await settings.handleButton(other);
    assert.match(other.calls[0][1].content, /another staff member/u);
});

test('roster fetch failures give private feedback after acknowledgement', async () => {
    const settings = new ScoutSettings(config());
    const select = interaction(`scout-settings:member-user:${OWNER}:current:0`);
    select.values = [OWNER];
    select.guild.members.fetch = async () => { throw new Error('Controlled member fetch failure'); };
    await settings.handleSelect(select);
    assert.equal(select.calls[0][0], 'deferUpdate');
    const feedback = select.calls.find(([kind, payload]) => kind === 'followUp' && payload.content);
    assert.equal(feedback[1].flags, 64);
    assert.match(feedback[1].content, /Controlled member fetch failure/u);
});

test('report browser loads only a page and reads sources when that report is opened', async () => {
    const manager = new ScoutReportManager({}); let lists = 0, gets = 0;
    manager.admin.list = async (_query, limit, offset) => {
        lists++; assert.equal(limit, 25); assert.equal(offset, 0);
        return { total: 70, rows: [source()] };
    };
    manager.admin.get = async () => { gets++; return { root: source(), sources: [source()] }; };
    const list = await manager.listPanel(OWNER);
    validatePanel(list);
    assert.equal(lists, 1); assert.equal(gets, 0);
    const token = list.components[0].toJSON().components[0].custom_id.split(':').at(-1);
    const select = interaction('report-select'); select.values = [ID];
    await manager.handleSelect(select, OWNER, 'reports-select', [token]);
    assert.equal(select.calls[0][0], 'deferUpdate'); assert.equal(gets, 1);
    validatePanel(select.calls[1][1]);
});

test('report source menus support more than 25 sources and use unique action IDs', async () => {
    const manager = new ScoutReportManager({});
    const sources = Array.from({ length: 30 }, (_, n) => source(String(BigInt(ID) + BigInt(n))));
    manager.admin.get = async () => ({ root: sources[0], sources });
    const payload = await manager.detailPanel(OWNER, ID, '', 0, sources[29].message_id);
    validatePanel(payload);
    assert.equal(payload.components[0].toJSON().components[0].options.length, 5);
});

test('report editors are served from the session and stale forms cannot mutate data', async () => {
    const manager = new ScoutReportManager({});
    const token = manager.remember(OWNER, { kind: 'detail', source: source(), report: { root: source(), sources: [source()] } });
    manager.admin.get = async () => { throw new Error('No DB before modal'); };
    const click = interaction();
    await manager.handleButton(click, OWNER, 'reports-edit-details', [token]);
    assert.equal(click.calls[0][0], 'showModal');
    let writes = 0; manager.admin.change = async () => { writes++; };
    const expired = interaction();
    await manager.handleModal(expired, OWNER, 'invalid-token');
    assert.equal(expired.calls[0][0], 'deferReply');
    assert.match(expired.calls[1][1], /expired/u); assert.equal(writes, 0);
});

test('source edit form offers text and link only; reporter and date are immutable', () => {
    const manager = new ScoutReportManager({}); const item = source();
    const modal = manager.editModal(OWNER, { source: item, report: { root: item } }, 'source').toJSON();
    assert.deepEqual(modal.components.map(label => label.component.custom_id), ['source_url', 'content']);
});

test('long unchanged team and source text survive editing another field', async () => {
    const manager = new ScoutReportManager({});
    const item = source(); item.team_text = 'A'.repeat(5000); item.notes = 'B'.repeat(4500);
    const token = manager.remember(OWNER, { kind: 'edit', section: 'details', reportId: ID, source: item,
        report: { root: item, sources: [item] }, versions: { [ID]: reportVersion(item) }, query: '', page: 0 });
    let saved;
    manager.admin.change = async (_report, _source, _actor, patch) => { saved = patch; };
    manager.detailPanel = async () => ({ embeds: [], components: [] });
    const form = interaction('', { ign: 'Blacku', rating: '309', team: 'A'.repeat(4000), notes: 'B'.repeat(4000) });
    await manager.handleModal(form, OWNER, token);
    assert.equal(saved.details.teamText.length, 5000); assert.equal(saved.details.notes.length, 4500);
    assert.equal(saved.details.rating, '309');
    assert.match(form.calls[1][1].content, /saved/u);
});

test('report deletion requires confirmation and acknowledges before its transaction', async () => {
    const manager = new ScoutReportManager({});
    const report = { root: source(), sources: [source()] };
    const token = manager.remember(OWNER, { kind: 'detail', reportId: ID, report, source: report.root,
        versions: { [ID]: reportVersion(report.root) }, query: '', page: 0 });
    let changes = 0;
    const click = interaction(); await manager.handleButton(click, OWNER, 'reports-delete', [token]);
    assert.equal(changes, 0); assert.equal(click.calls[0][0], 'update');
    const confirmation = click.calls[0][1].components[0].toJSON().components[0].custom_id.split(':').at(-1);
    const confirm = interaction('report-confirm-delete');
    manager.admin.change = async (...args) => { assert.equal(confirm.calls[0][0], 'deferUpdate'); assert.equal(args.at(-1), true); changes++; };
    manager.listPanel = async () => ({ embeds: [], components: [] });
    await manager.handleButton(confirm, OWNER, 'reports-confirm-delete', [confirmation]);
    assert.equal(changes, 1); assert.match(confirm.calls[1][1].content, /deleted/u);
});

test('settings search autocomplete returns newest 25 report IDs in a single response', async () => {
    const manager = new ScoutReportManager({});
    manager.admin.list = async term => { assert.equal(term, ''); return { rows: Array.from({ length: 25 }, (_, n) => source(String(BigInt(ID) + BigInt(n)))) }; };
    const responses = [];
    await manager.autocomplete({ createdTimestamp: Date.now(), options: { getFocused: () => '' }, respond: async value => responses.push(value) });
    assert.equal(responses.length, 1); assert.equal(responses[0].length, 25);
    assert.equal(responses[0][0].value, ID);
});

for (const [label, Store, table, column] of [
    ['report', PvpScoutStore, 'pvp_scout_messages', 'staff_overrides_json'],
    ['roster', ScoutRosterStore, 'guild_members', 'global_name']
]) test(`fresh scout ${label} schema contains the current columns without completed upgrade queries`, async () => {
    const statements = [];
    const store = new Store({ db: { async query(sql) { statements.push(sql); return [[]]; } } });
    await Promise.all([store.ensureSchema(), store.ensureSchema()]);
    const create = statements.find(sql => new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'u').test(sql.replace(/`/gu, '')));
    assert.ok(create, `${table} must still be created for fresh installations`);
    assert.match(create, new RegExp(`\\b${column}\\b`, 'u'));
    assert.ok(statements.every(sql => /^\s*CREATE TABLE IF NOT EXISTS\b/u.test(sql)),
        'fresh schema creation must not issue completed SHOW COLUMNS or ALTER TABLE upgrades');
    const setupSql = fs.readFileSync(path.join(__dirname, '../sql/create_pvp_scout_tables.sql'), 'utf8');
    const normalizeSql = sql => sql.trim().replace(/\s+/gu, ' ');
    const definitions = [...setupSql.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?;/gu)].map(match => normalizeSql(match[0]));
    assert.ok(statements.every(sql => definitions.includes(normalizeSql(sql))), 'runtime table definitions must match database setup');
    assert.equal(statements.length, label === 'report' ? 8 : 3);
    const queries = statements.length;
    await store.ensureSchema();
    assert.equal(statements.length, queries, 'schema work is shared and completed only once');
});
