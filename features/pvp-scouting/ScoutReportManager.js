// Lets officers search, edit and delete published scout reports.
'use strict';

const { scoutIds } = require('./ScoutChanges.js');

const { randomBytes } = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, FileUploadBuilder, LabelBuilder, ModalBuilder,
    StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { ScoutReportAdminStore, reportVersion } = require('./ScoutReportAdminStore.js');
const { buildScoutEmbed, autocompleteWithinDeadline } = require('../../commands/scout.js');
const { scoutPayload, scoutTextInput: input, withScoutLoading } = require('./ScoutPresentation.js');
const { downloadImageAttachment, refreshImageAttachments } = require('./ScoutImageUrls.js');
const { bindServer, interactionServer, serverButtons } = require('./ScoutStaffServers.js');

const PREFIX = 'scout-settings:';
const TTL = 15 * 60 * 1000;
const safe = (value, max = 100) => String(value || '').replace(/[\r\n]/gu, ' ').slice(0, max);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (label, action, owner, token, style = ButtonStyle.Secondary, disabled = false) =>
    new ButtonBuilder().setLabel(label).setCustomId(`${PREFIX}reports-${action}:${owner}:${token}`).setStyle(style).setDisabled(disabled);

function embedLength(embed) {
    return (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0)
        + (embed.fields || []).reduce((size, field) => size + field.name.length + field.value.length, 0);
}

function fitPreview(preview, info) {
    const json = preview.toJSON();
    let remaining = 6000 - embedLength(info.toJSON()) - (json.title?.length || 0) - (json.footer?.text?.length || 0);
    json.description = (json.description || '').slice(0, Math.min(2400, remaining));
    remaining -= json.description.length;
    json.fields = (json.fields || []).flatMap(field => {
        if (remaining <= field.name.length + 1) return [];
        const value = field.value.slice(0, Math.min(1024, remaining - field.name.length));
        remaining -= field.name.length + value.length;
        return [{ ...field, value }];
    });
    return new EmbedBuilder(json);
}

class ScoutReportManager {
    constructor(store, server = null) {
        this.admin = new ScoutReportAdminStore(store);
        this.server = server;
        this.sessions = new Map();
        this.suggestions = new Map();
        this.suggestionRequests = new Map();
    }

    remember(owner, value) {
        const now = Date.now();
        for (const [id, session] of this.sessions) if (now - session.time > TTL) this.sessions.delete(id);
        while (this.sessions.size >= 500) this.sessions.delete(this.sessions.keys().next().value);
        const id = randomBytes(8).toString('hex');
        this.sessions.set(id, { ...value, owner: String(owner), time: now });
        return id;
    }

    session(owner, token) {
        const value = this.sessions.get(token);
        if (!value || value.owner !== String(owner) || Date.now() - value.time > TTL) return null;
        return value;
    }

    async listPanel(owner, query = '', page = 0) {
        page = Math.max(0, Number(page) || 0);
        const result = await this.admin.list(query, 25, page * 25);
        const last = Math.max(0, Math.ceil(result.total / 25) - 1);
        if (page > last) return this.listPanel(owner, query, last);
        const token = this.remember(owner, { kind: 'list', query, page });
        const lines = result.rows.map((item, index) => `${page * 25 + index + 1}. **${safe(item.opponent_ign, 32)}** — \`${item.message_id}\``);
        const serverLabel = this.server ? `${this.server === 'gold' ? 'Gold' : 'Silver'} ` : '';
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`Scout Settings — ${serverLabel}Scout Reports`)
            .setDescription((query ? `Search: **${safe(query, 200)}**\n\n` : '')
                + (lines.join('\n') || '*No publicly available reports match this search.*')
                + '\n\nSelect a report to edit its details, sources or screenshots. Search by IGN, report/source ID, Discord link, reporter or Pokémon/notes.')
            .setFooter({ text: `${result.total} report(s) • Page ${page + 1} of ${last + 1}` });
        const components = [];
        if (result.rows.length) components.push(row(new StringSelectMenuBuilder()
            .setCustomId(`${PREFIX}reports-select:${owner}:${token}`).setPlaceholder('Choose a scout report')
            .addOptions(result.rows.map(item => ({ label: safe(item.opponent_ign, 100), value: item.message_id,
                description: safe(`ID ${item.message_id} • ${item.author_username || 'Unknown reporter'}`, 100) })))));
        components.push(row(button('Previous', 'prev', owner, token, ButtonStyle.Secondary, page === 0),
            button('Next', 'next', owner, token, ButtonStyle.Secondary, page >= last),
            button('Search', 'search', owner, token, ButtonStyle.Primary),
            new ButtonBuilder().setLabel('Settings').setEmoji('⬅️').setCustomId(`${PREFIX}home:${owner}${this.server ? `:${this.server}` : ''}`).setStyle(ButtonStyle.Secondary)));
        if (this.server) components.push(serverButtons(`${PREFIX}reports-server:`, owner, this.server));
        return bindServer({ content: null, embeds: [embed], components, allowedMentions: { parse: [] } }, this.server);
    }

    async detailPanel(owner, reportId, query = '', page = 0, sourceId = '', loadedReport = undefined) {
        const report = loadedReport === undefined ? await this.admin.get(reportId) : loadedReport;
        if (!report) return { ...await this.listPanel(owner, query, page), content: 'That report is no longer available.' };
        const index = Math.max(0, report.sources.findIndex(source => source.message_id === String(sourceId)));
        const source = report.sources[index];
        const versions = Object.fromEntries(report.sources.map(item => [item.message_id, reportVersion(item)]));
        const token = this.remember(owner, { kind: 'detail', reportId: String(reportId), query, page, report, source, index, versions });
        const preview = buildScoutEmbed(report.root, report.sources, 0, 1).embed;
        const imageUrl = preview.data.image?.url;
        const imageSource = imageUrl && report.sources.find(item => item.attachments.some(attachment =>
            attachment.url === imageUrl && attachment.sourceMessageId));
        const client = this.admin.store.auditLogger?.client;
        if (imageSource && client) {
            const imageId = imageSource.attachments.find(item => item.url === imageUrl).id;
            await refreshImageAttachments(client, imageSource);
            const image = imageSource.attachments.find(item => item.id === imageId);
            if (image?.url) preview.setImage(image.url);
        }
        const info = new EmbedBuilder().setColor(0x5865F2).setTitle(`Edit ${this.server ? `${this.server === 'gold' ? 'Gold' : 'Silver'} ` : ''}Scout Report`)
            .setDescription(scoutIds(reportId, source.message_id) + `\n**Selected source:** ${index + 1} of ${report.sources.length}\n`
                + 'Choose the original source to change the opponent. Each continuation and reply can be edited separately. Reporter, posted date and message IDs come from the original Discord source.')
            .addFields({ name: 'PvP Rating', value: source.rating == null ? '*None*' : String(source.rating), inline: true },
                { name: 'Stored source text', value: String(source.message_content || '*None*').slice(0, 1000), inline: false })
            .setFooter({ text: 'Crow Control' });
        const chunk = report.sources.slice(Math.floor(index / 25) * 25, Math.floor(index / 25) * 25 + 25);
        const components = [row(new StringSelectMenuBuilder().setCustomId(`${PREFIX}reports-source:${owner}:${token}`)
            .setPlaceholder('Choose the original, continuation or reply source').addOptions(chunk.map(item => ({
                label: `Source ${report.sources.indexOf(item) + 1} — ${item.message_id}`, value: item.message_id,
                description: safe(item.author_username || 'Unknown reporter'), default: item.message_id === source.message_id
            })))),
        row(button('Edit details', 'edit-details', owner, token, ButtonStyle.Primary),
            button('Edit source', 'edit-source', owner, token), button('Edit screenshots', 'edit-images', owner, token),
            button('Delete report', 'delete', owner, token, ButtonStyle.Danger)),
        row(button('Previous source', 'source-prev', owner, token, ButtonStyle.Secondary, index === 0),
            button('Next source', 'source-next', owner, token, ButtonStyle.Secondary, index >= report.sources.length - 1),
            button('Back to reports', 'back', owner, token), button('Search', 'search', owner, token)),
        row(new ButtonBuilder().setLabel('Manage sources / replies').setStyle(ButtonStyle.Primary)
            .setCustomId(`scout-sources:open:${owner}:${source.message_id}`))];
        return bindServer({ content: null, embeds: [info, fitPreview(preview, info)], components, allowedMentions: { parse: [] } }, this.server);
    }

    searchModal(owner, value = '') {
        const token = this.remember(owner, { kind: 'search' });
        return new ModalBuilder().setCustomId(`${PREFIX}reports-modal:${owner}:${token}${this.server ? `:${this.server}` : ''}`).setTitle('Search Scout Reports')
            .addLabelComponents(input('query', 'Search scout reports', value, false, false, 200)
                .setDescription('IGN, report/source ID, Discord link, reporter, Pokémon or notes. Blank shows all reports.'));
    }

    editModal(owner, session, section) {
        const token = this.remember(owner, { ...session, kind: 'edit', section });
        const source = session.source;
        const modal = new ModalBuilder().setCustomId(`${PREFIX}reports-modal:${owner}:${token}${this.server ? `:${this.server}` : ''}`).setTitle(`Edit scout ${section}`);
        if (section === 'details') modal.addLabelComponents(
            input('ign', 'Opponent IGN (change on original source)', source.opponent_ign || session.report.root.opponent_ign, false, true, 32),
            input('rating', 'PvP rating (blank = none)', source.rating, false, false, 5),
            input('team', 'Pokémon team / moves / items', source.team_text, true), input('notes', 'Additional notes', source.notes, true));
        if (section === 'source') modal.addLabelComponents(
            input('source_url', 'Original Discord message link', source.source_url, false, true, 512),
            input('content', 'Stored message text', source.message_content, true));
        if (section === 'images') modal.addLabelComponents(
            input('images', 'Screenshot URLs', source.attachments.map(item => item.url).join('\n'), true)
                .setDescription('One HTTPS URL per line. Keep URLs to retain images; clear them to replace or remove images.'),
            new LabelBuilder().setLabel('Upload screenshots (optional)')
                .setDescription('Add images alongside the URLs above. Up to 10 screenshots total per source.')
                .setFileUploadComponent(new FileUploadBuilder().setCustomId('screenshots')
                    .setMinValues(0).setMaxValues(10).setRequired(false)));
        return modal;
    }

    async storeUploadedImages(interaction, session, uploads) {
        const logger = this.admin.store.auditLogger;
        if (!logger?.channelId) throw new Error('The scout log channel must be configured to store uploaded screenshots.');
        const client = interaction.client;
        const channel = client.channels.cache.get(logger.channelId) || await client.channels.fetch(logger.channelId);
        if (!channel?.send || channel.guildId !== interaction.guildId || channel.guildId !== logger.guildId) {
            throw new Error('The scout log channel is unavailable in this server.');
        }
        const limit = Number(interaction.attachmentSizeLimit) || 10 * 1024 * 1024;
        const files = new Array(uploads.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, uploads.length) }, async () => {
            while (next < uploads.length) {
                const index = next++;
                files[index] = await downloadImageAttachment(uploads[index], limit);
            }
        }));
        // Modal upload URLs expire. Keep a staff-channel copy whose attachment
        // URLs can be renewed without changing the original scout message.
        const message = await channel.send({
            content: `**Scout screenshot uploads**\n${scoutIds(session.reportId, session.source.message_id)}\n`
                + `Uploaded by <@${interaction.user.id}>. The saved edit is recorded separately in the scout action log.`,
            files, allowedMentions: { parse: [] }
        });
        return [...message.attachments.values()].map(item => ({
            id: String(item.id), name: item.name, url: item.url, proxyURL: item.proxyURL,
            contentType: item.contentType, size: item.size, width: item.width, height: item.height,
            sourceChannelId: String(message.channelId), sourceMessageId: String(message.id)
        }));
    }

    async update(interaction, work) {
        return withScoutLoading(interaction, work, { logContext: 'Scout report manager',
            errorMessage: error => `Could not load Scout Reports: ${safe(error.message, 300)}` });
    }

    async handleButton(interaction, owner, action, args) {
        if (action === 'reports-open') return this.update(interaction, () => this.listPanel(owner));
        const session = this.session(owner, args[0]);
        if (!session) {
            await interaction.reply({ content: 'This report menu expired. Reopen `/scout-settings`.', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (action === 'reports-search') { await interaction.showModal(this.searchModal(owner, session.query)); return true; }
        if (action.startsWith('reports-edit-') && session.kind === 'detail') {
            await interaction.showModal(this.editModal(owner, session, action.slice('reports-edit-'.length))); return true;
        }
        if (action === 'reports-delete' && session.kind === 'detail') {
            const token = this.remember(owner, { ...session, kind: 'delete' });
            await interaction.update(scoutPayload(bindServer({ content: null, embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Delete Scout Report?')
                .setDescription(`Remove report **${safe(session.report.root.opponent_ign)}** (\`${session.reportId}\`) and all ${session.report.sources.length} linked source(s) from \`/scout\`?`)],
            components: [row(button('Delete report', 'confirm-delete', owner, token, ButtonStyle.Danger),
                button('Cancel', 'cancel-delete', owner, token))], allowedMentions: { parse: [] } }, this.server), interaction.message));
            return true;
        }
        if (action === 'reports-confirm-delete' && session.kind === 'delete') {
            return this.update(interaction, async () => {
                await this.admin.change(session.reportId, session.reportId, owner, {}, session.versions, true);
                this.sessions.delete(args[0]); this.suggestions.clear();
                return { ...await this.listPanel(owner, session.query, session.page), content: `Scout report ${session.reportId} was deleted from /scout.` };
            });
        }
        if (action === 'reports-prev' || action === 'reports-next' || action === 'reports-back') {
            return this.update(interaction, () => this.listPanel(owner, session.query, session.page + (action === 'reports-prev' ? -1 : action === 'reports-next' ? 1 : 0)));
        }
        if (action === 'reports-source-prev' || action === 'reports-source-next' || action === 'reports-cancel-delete') {
            const index = Math.max(0, Math.min(session.report.sources.length - 1,
                session.index + (action === 'reports-source-prev' ? -1 : action === 'reports-source-next' ? 1 : 0)));
            return this.update(interaction, () => this.detailPanel(owner, session.reportId, session.query, session.page, session.report.sources[index].message_id));
        }
        return false;
    }

    async handleSelect(interaction, owner, action, args) {
        const session = this.session(owner, args[0]);
        if (!session) { await interaction.reply({ content: 'This menu expired. Reopen `/scout-settings`.', flags: MessageFlags.Ephemeral }); return true; }
        if (action === 'reports-select') return this.update(interaction,
            () => this.detailPanel(owner, interaction.values[0], session.query, session.page));
        if (action === 'reports-source' && session.report.sources.some(source => source.message_id === interaction.values[0])) {
            return this.update(interaction, () => this.detailPanel(owner, session.reportId, session.query, session.page, interaction.values[0]));
        }
        return false;
    }

    async handleModal(interaction, owner, token) {
        const session = this.session(owner, token);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!session) { await interaction.editReply('This form expired. Reopen Scout Reports.'); return true; }
        try {
            const get = name => interaction.fields.getTextInputValue(name).trim();
            if (session.kind === 'search') {
                await interaction.editReply(scoutPayload(await this.listPanel(owner, get('query'))));
            } else if (session.kind === 'edit') {
                const patch = {};
                // A Discord text input holds at most 4000 characters. Opening an
                // editor must not silently erase the rest of a longer saved field.
                const fullText = (name, original) => {
                    const value = get(name);
                    const stored = String(original || '');
                    return stored.length > 4000 && value === stored.slice(0, 4000).trim() ? stored : value;
                };
                if (session.section === 'details') patch.details = { ign: get('ign'), rating: get('rating'),
                    teamText: fullText('team', session.source.team_text), notes: fullText('notes', session.source.notes) };
                if (session.section === 'source') {
                    const sourceUrl = get('source_url');
                    const sourceMessageId = session.source.staffOverrides?.splitFromMessageId || session.source.message_id;
                    if (!new RegExp(`^https://discord\\.com/channels/\\d+/\\d+/${sourceMessageId}$`, 'u').test(sourceUrl)) throw new Error('The Discord link must refer to this source message ID.');
                    patch.overrides = { source_url: sourceUrl,
                        message_content: fullText('content', session.source.message_content) };
                }
                if (session.section === 'images') {
                    const urls = [...new Set(fullText('images', session.source.attachments.map(item => item.url).join('\n'))
                        .split(/\r?\n/u).map(value => value.trim()).filter(Boolean))];
                    const uploads = [...(interaction.fields.getUploadedFiles('screenshots')?.values() || [])];
                    if (urls.length + uploads.length > 10) throw new Error('Use at most 10 screenshots per source, including URLs and uploads.');
                    if (uploads.some(item => !String(item.contentType || '').startsWith('image/'))) {
                        throw new Error('Each uploaded screenshot must be an image.');
                    }
                    const attachments = urls.map((url, index) => {
                        let parsed;
                        try { parsed = new URL(url); } catch { throw new Error('Each screenshot must be a valid HTTPS URL.'); }
                        if (parsed.protocol !== 'https:') throw new Error('Each screenshot must be a valid HTTPS URL.');
                        const original = session.source.attachments.find(item => item.url === url);
                        if (!original) return { id: '', name: `scout-${index + 1}.png`, url, contentType: 'image/png' };
                        return original.id ? { ...original,
                            sourceChannelId: original.sourceChannelId || session.source.channel_id,
                            sourceMessageId: original.sourceMessageId || session.source.message_id } : original;
                    });
                    if (uploads.length) attachments.push(...await this.storeUploadedImages(interaction, session, uploads));
                    patch.overrides = { attachments };
                }
                const savedReport = await this.admin.change(session.reportId, session.source.message_id, owner, patch, session.versions);
                this.suggestions.clear();
                await interaction.editReply(scoutPayload({ ...await this.detailPanel(owner, session.reportId, session.query, session.page, session.source.message_id, savedReport),
                    content: 'Scout report saved. The updated values are now available in `/scout`.' }));
            }
        } catch (error) {
            await interaction.editReply({ content: `Could not save this change: ${safe(error.message, 400)}\nReopen the report to refresh it and try again.`, embeds: [], components: [] });
        } finally { this.sessions.delete(token); }
        return true;
    }

    async autocomplete(interaction) {
        const term = String(interaction.options.getFocused() || '').trim().toLowerCase();
        const revision = this.admin.store.dataRevision || 0;
        const isCurrent = () => revision === (this.admin.store.dataRevision || 0);
        const entry = this.suggestions.get(term);
        const cached = entry?.revision === revision ? entry : null;
        let request = this.suggestionRequests.get(term);
        let pending = request?.revision === revision ? request.promise : null;
        if (!pending && (!cached || Date.now() - cached.time > 60_000)) {
            pending = this.admin.list(term, 25, 0, { includeTotal: false }).then(result => {
                if (!isCurrent()) return [];
                const choices = result.rows.map(item => ({ name: safe(`${item.opponent_ign} — ${item.message_id}`, 100), value: item.message_id }));
                this.suggestions.set(term, { choices, time: Date.now(), revision });
                while (this.suggestions.size > 100) this.suggestions.delete(this.suggestions.keys().next().value);
                return choices;
            }).catch(() => isCurrent() ? cached?.choices || [] : []).finally(() => {
                if (this.suggestionRequests.get(term) === request) this.suggestionRequests.delete(term);
            });
            request = { promise: pending, revision };
            this.suggestionRequests.set(term, request);
        }
        const age = Date.now() - (interaction.createdTimestamp || Date.now());
        const choices = cached?.choices || await autocompleteWithinDeadline(pending || Promise.resolve([]), Math.min(1000, Math.max(0, 2000 - age)), () => []);
        await interaction.respond(isCurrent() ? choices.slice(0, 25) : []);
    }
}

class ScoutReportManagerRegistry {
    constructor(config) {
        this.managers = new Map(config.scoutServers.contexts().map(context => [context.server,
            new ScoutReportManager(context.store, context.server)]));
    }

    forServer(server = 'gold') { return this.managers.get(server); }
    listPanel(owner, query = '', page = 0, server = 'gold') {
        return this.forServer(server).listPanel(owner, query, page);
    }
    autocomplete(interaction, server = 'gold') { return this.forServer(server).autocomplete(interaction); }
    handleButton(interaction, owner, action, args) {
        const manager = this.forServer(interactionServer(interaction));
        if (action === 'reports-server') return manager.update(interaction, () => manager.listPanel(owner));
        return manager.handleButton(interaction, owner, action, args);
    }
    handleSelect(interaction, owner, action, args) {
        return this.forServer(interactionServer(interaction)).handleSelect(interaction, owner, action, args);
    }
    handleModal(interaction, owner, token) {
        return this.forServer(interactionServer(interaction)).handleModal(interaction, owner, token);
    }
}

module.exports = { ScoutReportManager, ScoutReportManagerRegistry };
