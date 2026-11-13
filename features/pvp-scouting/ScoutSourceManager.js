// Staff menus for attaching, separating and editing scout sources.
'use strict';

const { scoutIds } = require('./ScoutChanges.js');

const { randomBytes } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
    StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { ScoutSourceAdminStore } = require('./ScoutSourceAdminStore.js');
const { ScoutReportAdminStore } = require('./ScoutReportAdminStore.js');
const { scoutTextInput: field, withScoutLoading } = require('./ScoutPresentation.js');
const { bindServer, interactionServer } = require('./ScoutStaffServers.js');

const PREFIX = 'scout-sources:';
const TTL = 15 * 60 * 1000;
const safe = (value, max = 100) => String(value || '').replace(/[\r\n]/gu, ' ').slice(0, max);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const btn = (label, action, owner, token, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setLabel(label).setCustomId(`${PREFIX}${action}:${owner}:${token}`).setStyle(style).setDisabled(disabled);
const idFrom = text => String(text || '').trim().match(/^(?:https:\/\/discord\.com\/channels\/\d+\/\d+\/)?(\d{17,20}(?:_\d{1,3})?|manual_[a-f0-9]{20})$/u)?.[1];

class ScoutSourceManager {
    constructor(config) {
        this.store = config.pvpScoutStore; this.client = config.client; this.ingestor = config.pvpScoutIngestor;
        this.server = config.scoutServer || null;
        this.admin = new ScoutSourceAdminStore(this.store); this.reports = new ScoutReportAdminStore(this.store);
        this.ownerID = String(config.ownerID || ''); this.roles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID].filter(Boolean).map(String);
        this.sessions = new Map();
    }

    isStaff(interaction) {
        return this.ownerID && String(interaction.user.id) === this.ownerID
            || Boolean(interaction.member?.roles?.cache?.some(role => this.roles.includes(String(role.id))))
            || Array.isArray(interaction.member?.roles) && interaction.member.roles.some(role => this.roles.includes(String(role)));
    }

    remember(owner, data) {
        for (const [id, session] of this.sessions) if (Date.now() - session.time > TTL) this.sessions.delete(id);
        while (this.sessions.size >= 500) this.sessions.delete(this.sessions.keys().next().value);
        const token = randomBytes(8).toString('hex');
        this.sessions.set(token, { ...data, owner: String(owner), time: Date.now() }); return token;
    }

    session(owner, token) {
        const session = this.sessions.get(token);
        return session?.owner === String(owner) && Date.now() - session.time <= TTL ? session : null;
    }

    async panel(owner, sourceId, feedback = '') {
        const report = await this.admin.get(sourceId);
        if (!report) return { content: feedback || 'This source is no longer available.', embeds: [], components: [] };
        const index = Math.max(0, report.sources.findIndex(source => source.message_id === report.source.message_id));
        const token = this.remember(owner, { kind: 'source', ...report, index });
        const source = report.source;
        const chunk = report.sources.slice(Math.floor(index / 25) * 25, Math.floor(index / 25) * 25 + 25);
        const embed = new EmbedBuilder().setTitle('Manage Scout Sources').setColor(0x5865F2)
            .setDescription('-# Move a reply to another report, edit it, delete it, or make it an independent scout. Moving the original moves all its sources. Deleting the original deletes its whole report. The scout reporter and posted date cannot be edited.\n'
                + `**Opponent:** ${safe(report.root.opponent_ign || 'Not detected', 64)}\n` + scoutIds(report.root.message_id, source.message_id) + '\n'
                + `**Selected source:** ${index + 1} of ${report.sources.length}\n`
                + `**Reporter:** ${safe(source.author_username || source.author_id, 128)}`)
            .addFields({ name: 'Stored scouting information', value: String(source.team_text || source.notes || source.message_content || '*None*').slice(0, 1000) })
            .setFooter({ text: `Report ID: ${report.root.message_id} • Source ID: ${source.message_id}` });
        if (this.server) embed.setTitle(`Manage ${this.server === 'gold' ? 'Gold' : 'Silver'} Scout Sources`);
        return bindServer({ content: feedback || null, embeds: [embed], components: [
            row(new StringSelectMenuBuilder().setCustomId(`${PREFIX}select:${owner}:${token}`).setPlaceholder('Choose a source or reply')
                .addOptions(chunk.map(item => ({ label: safe(`${item.staffOverrides?.manual ? 'Officer note' : 'Message'} ${item.message_id}`),
                    value: item.message_id, description: safe(item.author_username || 'Unknown reporter'), default: item.message_id === source.message_id })))),
            row(btn('Move / attach', 'move', owner, token, ButtonStyle.Primary), btn('Edit', 'edit', owner, token),
                btn('Delete', 'delete', owner, token, ButtonStyle.Danger),
                btn('Make independent', 'detach', owner, token, ButtonStyle.Secondary, source.message_id === report.root.message_id),
                btn('Add information', 'add', owner, token, ButtonStyle.Success)),
            row(btn('Previous source', 'prev', owner, token, ButtonStyle.Secondary, index === 0),
                btn('Next source', 'next', owner, token, ButtonStyle.Secondary, index === report.sources.length - 1))
        ], allowedMentions: { parse: [] } }, this.server);
    }

    modal(owner, session, kind) {
        const token = this.remember(owner, { ...session, kind });
        const modal = new ModalBuilder().setCustomId(`${PREFIX}modal:${owner}:${token}${this.server ? `:${this.server}` : ''}`);
        if (kind === 'move') return modal.setTitle('Attach to another scout').addLabelComponents(
            field('target', 'Target IGN, report ID or Discord link', '', false, true, 200));
        if (kind === 'add-id') return modal.setTitle('Add an existing scout message').addLabelComponents(
            field('source', 'Message ID or Discord link', '', false, true, 200));
        if (kind === 'add-text') return modal.setTitle('Add scouting information').addLabelComponents(
            field('text', 'Extra team information, moves, items or notes', '', true, true));
        const source = session.source;
        return modal.setTitle(kind === 'detach' ? 'Make an independent scout' : 'Edit scout details').addLabelComponents(
            field('ign', 'Opponent IGN', kind === 'detach' ? source.staffOverrides?.unattachedIgn || source.opponent_ign : source.opponent_ign || session.root.opponent_ign, false, true, 32),
            field('rating', 'PvP rating (blank = none)', source.rating, false, false, 5),
            field('team', 'Pokémon team / moves / items', source.team_text, true),
            field('notes', 'Additional notes', source.notes, true));
    }

    confirmation(owner, session, target) {
        if (session.root.channel_id !== this.store.channelId || target.root.channel_id !== this.store.channelId) {
            throw new Error('Sources can only be attached to a report on the same server.');
        }
        const token = this.remember(owner, { ...session, kind: 'attach', target,
            versions: { ...session.versions, ...target.versions } });
        const count = session.source.message_id === session.root.message_id ? session.sources.length : 1;
        return bindServer({ content: null, embeds: [new EmbedBuilder().setTitle('Attach Scout Information?').setColor(0x5865F2)
            .setDescription(`Attach **${count} source(s)** from \`${session.root.message_id}\` to **${safe(target.root.opponent_ign, 64)}** (\`${target.root.message_id}\`)?\n`
                + `The attached information will use opponent **${safe(target.root.opponent_ign, 64)}**. Original reporters, dates and Discord messages stay saved.`)],
        components: [row(btn('Attach', 'confirm-attach', owner, token, ButtonStyle.Success), btn('Cancel', 'cancel', owner, token))],
        allowedMentions: { parse: [] } }, this.server);
    }

    async importSource(value) {
        const id = idFrom(value);
        if (!id || id.startsWith('manual_')) throw new Error('Enter an existing Discord message ID or link.');
        const link = String(value).match(/^https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\//u);
        if (link && link[2] !== this.store.channelId) throw new Error('Use a message from the scouting channel.');
        let result = await this.admin.get(id);
        if (result) return result;
        if (await this.store.getMessage(id)) throw new Error('That source was deleted. Deleted sources cannot be restored by attaching them.');
        if (!this.ingestor) throw new Error('This message is not archived yet. Try again once scouting ingestion is available.');
        const channel = this.client.channels.cache.get(this.store.channelId) || await this.client.channels.fetch(this.store.channelId);
        const message = await channel.messages.fetch(id);
        await this.ingestor.enqueue(() => this.ingestor.saveMessage(message));
        result = await this.admin.get(id);
        if (!result) throw new Error('Could not archive this scouting message.');
        return result;
    }

    async mutation(task) {
        return this.ingestor?.enqueue ? this.ingestor.enqueue(task) : task();
    }

    async handleInteraction(interaction) {
        if (!interaction.customId?.startsWith(PREFIX)) return false;
        const [, action, owner, token] = interaction.customId.split(':');
        if (!this.isStaff(interaction) || String(interaction.user.id) !== owner) {
            await interaction.reply({ content: 'Only the officer who opened this menu can use it.', flags: MessageFlags.Ephemeral }); return true;
        }
        if (action === 'open') {
            return withScoutLoading(interaction, () => this.panel(owner, token), {
                label: 'Loading sources…', newMessage: true, logContext: 'Scout sources',
                errorMessage: error => `Could not load sources: ${safe(error.message, 350)}`
            });
        }
        const session = this.session(owner, token);
        if (!session) { await interaction.reply({ content: 'This source menu expired. Reopen the report.', flags: MessageFlags.Ephemeral }); return true; }
        if (['move', 'edit', 'detach', 'add-id', 'add-text'].includes(action)) {
            await interaction.showModal(this.modal(owner, session, action)); return true;
        }
        if (action === 'add') {
            await interaction.update(bindServer({ content: 'Add another source to this scout report:', embeds: [], components: [row(
                btn('Existing message ID', 'add-id', owner, token, ButtonStyle.Primary),
                btn('Type information', 'add-text', owner, token, ButtonStyle.Primary), btn('Cancel', 'cancel', owner, token))] }, this.server)); return true;
        }
        if (action === 'delete') {
            const confirmation = this.remember(owner, { ...session, kind: 'delete' });
            await interaction.update(bindServer({ content: `Delete ${session.source.message_id === session.root.message_id ? `the whole report (${session.sources.length} sources)` : `only source ${session.source.message_id}`} from /scout?`,
                embeds: [], components: [row(btn('Delete', 'confirm-delete', owner, confirmation, ButtonStyle.Danger), btn('Cancel', 'cancel', owner, confirmation))] }, this.server)); return true;
        }
        const isModal = action === 'modal';
        if (!['select', 'prev', 'next', 'cancel', 'target', 'confirm-attach', 'confirm-delete', 'modal'].includes(action)) return false;
        return withScoutLoading(interaction, async () => {
            let payload;
            if (action === 'select') {
                if (!session.sources.some(source => source.message_id === interaction.values[0])) throw new Error('Choose a source from this report.');
                payload = await this.panel(owner, interaction.values[0]);
            } else if (action === 'prev' || action === 'next') {
                const index = Math.max(0, Math.min(session.sources.length - 1, session.index + (action === 'next' ? 1 : -1)));
                payload = await this.panel(owner, session.sources[index].message_id);
            } else if (action === 'cancel') payload = await this.panel(owner, session.source.message_id);
            else if (action === 'target') {
                const targetId = interaction.values[0];
                if (!session.targets?.includes(targetId)) throw new Error('Choose a target from these search results.');
                const target = await this.admin.get(targetId);
                if (!target) throw new Error('That report is no longer available.');
                payload = this.confirmation(owner, session, target);
            } else if (action === 'confirm-attach' && session.kind === 'attach') {
                const result = await this.mutation(() => this.admin.change('attached', session.source.message_id, owner,
                    { targetId: session.target.root.message_id, versions: session.versions }));
                this.sessions.delete(token);
                payload = await this.panel(owner, result.sourceId, `Attached to report ${result.rootId}. /scout now includes this information.`);
            } else if (action === 'confirm-delete' && session.kind === 'delete') {
                await this.mutation(() => this.admin.change('source_deleted', session.source.message_id, owner, { versions: session.versions }));
                this.sessions.delete(token);
                payload = session.source.message_id === session.root.message_id
                    ? { content: 'The report was deleted from /scout. The parser will not learn from this deletion.', embeds: [], components: [] }
                    : await this.panel(owner, session.root.message_id, 'The selected reply was deleted. The parser will not learn from this deletion.');
            } else if (isModal) {
                const get = name => interaction.fields.getTextInputValue(name).trim();
                if (session.kind === 'move') {
                    const query = get('target'), targetId = idFrom(query);
                    if (targetId) {
                        const target = await this.admin.get(targetId);
                        if (!target) throw new Error('No scout report exists for that ID.');
                        payload = this.confirmation(owner, session, target);
                    } else {
                        const matches = await this.reports.list(query, 25, 0, { includeTotal: false });
                        const targets = matches.rows.filter(item => item.message_id !== session.root.message_id);
                        if (!targets.length) throw new Error('No other scout reports match that search.');
                        const searchToken = this.remember(owner, { ...session, targets: targets.map(item => item.message_id) });
                        payload = { content: 'Choose the report to attach to (up to 25 matches).', embeds: [], components: [row(
                            new StringSelectMenuBuilder().setCustomId(`${PREFIX}target:${owner}:${searchToken}`).setPlaceholder('Target scout report')
                                .addOptions(targets.map(item => ({ label: safe(item.opponent_ign), value: item.message_id,
                                    description: safe(`Report ${item.message_id}`) }))))] };
                    }
                } else if (session.kind === 'add-id') {
                    const imported = await this.importSource(get('source'));
                    payload = this.confirmation(owner, imported, session);
                } else if (session.kind === 'add-text') {
                    const result = await this.mutation(() => this.admin.change('reply_added', session.root.message_id, owner,
                        { text: get('text'), username: interaction.user.username, versions: session.versions }));
                    payload = await this.panel(owner, result.sourceId, 'Extra scouting information was saved.');
                } else if (session.kind === 'edit' || session.kind === 'detach') {
                    const fullText = (name, original) => {
                        const value = get(name), stored = String(original || '');
                        return stored.length > 4000 && value === stored.slice(0, 4000).trim() ? stored : value;
                    };
                    const result = await this.mutation(() => this.admin.change(session.kind === 'detach' ? 'detached' : 'source_edited',
                        session.source.message_id, owner, { versions: session.versions, ign: get('ign'), rating: get('rating'),
                            teamText: fullText('team', session.source.team_text), notes: fullText('notes', session.source.notes) }));
                    payload = await this.panel(owner, result.sourceId,
                        session.kind === 'detach' ? `Source ${result.sourceId} is now its own scout report.` : 'Scout details saved. /scout now shows the updated values.');
                }
                this.sessions.delete(token);
            }
            if (!payload) throw new Error('This source action is no longer available. Reopen the report.');
            return bindServer(payload, this.server);
        }, { newMessage: isModal, logContext: 'Scout source action',
            errorMessage: error => `Could not save: ${safe(error.message, 400)}` });
    }
}

function sourceManagerFor(config) {
    if (config.scoutServers) {
        if (!config.scoutServers.sourceManager) config.scoutServers.sourceManager = new ScoutSourceManagerRegistry(config);
        return config.scoutServers.sourceManager;
    }
    if (!config.pvpScoutStore) return null;
    if (!config.pvpScoutStore.sourceManager) config.pvpScoutStore.sourceManager = new ScoutSourceManager(config);
    return config.pvpScoutStore.sourceManager;
}

class ScoutSourceManagerRegistry {
    constructor(config) {
        this.managers = new Map(config.scoutServers.contexts().map(context => [context.server, sourceManagerFor({
            ...config, scoutServers: null, scoutServer: context.server,
            pvpScoutStore: context.store, pvpScoutIngestor: context.ingestor
        })]));
    }

    forServer(server = 'gold') { return this.managers.get(server); }

    panel(owner, id, feedback = '', server = 'gold') {
        return this.forServer(server).panel(owner, id, feedback);
    }

    handleInteraction(interaction) {
        if (!interaction.customId?.startsWith(PREFIX)) return false;
        return this.forServer(interactionServer(interaction)).handleInteraction(interaction);
    }
}

module.exports = { ScoutSourceManager, ScoutSourceManagerRegistry, sourceManagerFor, PREFIX, idFrom };
