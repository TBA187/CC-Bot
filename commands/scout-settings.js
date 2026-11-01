// Staff settings to manage all public scout reports as well as the friendly and guild-member lists.
'use strict';

const { randomBytes } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    UserSelectMenuBuilder
} = require('discord.js');

const PREFIX = 'scout-settings:';
const { ScoutReportManager, ScoutReportManagerRegistry } = require('../features/pvp-scouting/ScoutReportManager.js');
const { staffServer } = require('../features/pvp-scouting/ScoutStaffServers.js');
const { sourceManagerFor } = require('../features/pvp-scouting/ScoutSourceManager.js');
const { scoutPayload, scoutTextInput, withScoutLoading } = require('../features/pvp-scouting/ScoutPresentation.js');
const PAGE_SIZE = 25;
const SESSION_TTL_MS = 15 * 60 * 1000;

function safe(value, max = 100) {
    return String(value || '').replace(/[\r\n]/gu, ' ').slice(0, max);
}

function button(label, customId, style = ButtonStyle.Secondary, disabled = false) {
    return new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style).setDisabled(disabled);
}

function textInput(id, label, value, { required = false, maxLength = 128, placeholder = '' } = {}) {
    return scoutTextInput(id, label, String(value || ''), false, required, maxLength, placeholder);
}

function menuRow(menu) {
    return new ActionRowBuilder().addComponents(menu);
}

class ScoutSettings {
    constructor(config) {
        this.name = 'scout-settings';
        this.config = config;
        this.store = config.scoutRosterStore;
        this.guildId = String(config.guildId || '');
        this.guildMemberRoleID = String(config.guildMemberRoleID || '');
        this.adminRoleID = String(config.adminRoleID || '');
        this.officerRoleID = String(config.officerRoleID || '');
        this.sessions = new Map();
        this.entryCache = new Map();
        this.reportManager = config.scoutServers ? new ScoutReportManagerRegistry(config)
            : config.pvpScoutStore ? new ScoutReportManager(config.pvpScoutStore) : null;
        this.sourceManager = sourceManagerFor(config);
        this.data = new SlashCommandBuilder()
            .setName('scout-settings')
            .setDescription('Scout Settings for Officers.')
            .addStringOption(option => option.setName('search').setDescription('Search reports by IGN, ID, reporter or Pokémon/notes')
                .setMaxLength(200).setAutocomplete(true))
            .addStringOption(option => option.setName('server').setDescription('Choose the scout server to manage.')
                .addChoices({ name: 'Gold', value: 'gold' }, { name: 'Silver', value: 'silver' }));
    }

    isStaff(interaction) {
        const roles = interaction.member?.roles;
        const cache = roles?.cache;
        if (cache?.has) return cache.has(this.adminRoleID) || cache.has(this.officerRoleID);
        const roleIds = Array.isArray(roles) ? roles.map(String) : [];
        return roleIds.includes(this.adminRoleID) || roleIds.includes(this.officerRoleID);
    }

    async deny(interaction) {
        const payload = { content: 'Only Crow Control admins and officers can use this command.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred && interaction.isChatInputCommand?.()) await interaction.editReply({ content: payload.content });
        else if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
        return true;
    }

    async updatePanel(interaction, build) {
        return withScoutLoading(interaction, build, { logContext: 'Scout setting',
            errorMessage: error => `Could not load this setting: ${safe(error.message, 300)}. Try again.` });
    }

    cacheEntries(kind, rows) {
        for (const [key, value] of this.entryCache) if (Date.now() - value.time > SESSION_TTL_MS) this.entryCache.delete(key);
        for (const entry of rows) this.entryCache.set(`${kind}:${entry.entry_id || entry.discord_id}`, { entry, time: Date.now() });
        while (this.entryCache.size > 1000) this.entryCache.delete(this.entryCache.keys().next().value);
    }

    cachedEntry(kind, id) {
        const cached = this.entryCache.get(`${kind}:${id}`);
        return cached && Date.now() - cached.time <= SESSION_TTL_MS ? cached.entry : null;
    }

    home(userId, server = 'gold') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Scout Settings')
            .setDescription(
                '**Choose a setting to manage:**\n' +
                '- **Friendly List:** Add/edit/remove members from the **Friendly List**.\n' +
                '  - Adding members or IGN\'s to the Friendly List will show a **/draw** recommendation in `/scout` for that player.\n' +
                '- **Member List:** Add/edit/remove current/former guild members.\n' +
                '  - Current/Former Guild Members are managed automatically by the bot. These members will show a **/draw** recommendation in `/scout`.\n' +
                '- **Scout Reports:** Search and edit/delete submitted scout reports publicly shown in `/scout`'
            );
        const row = new ActionRowBuilder().addComponents(
            button('Friendly List', `${PREFIX}open-friendly:${userId}:0`, ButtonStyle.Primary),
            button('Member List', `${PREFIX}open-members:${userId}:current:0`, ButtonStyle.Primary),
            button('Scout Reports', `${PREFIX}reports-open:${userId}${this.config.scoutServers ? `:${server}` : ''}`, ButtonStyle.Primary, !this.reportManager)
        );
        return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
    }

    async friendlyPanel(userId, page = 0, selectedId = '') {
        const requestedPage = page;
        const { rows, total } = await this.store.listFriendly(this.guildId, PAGE_SIZE, page * PAGE_SIZE);
        this.cacheEntries('friendly', rows);
        const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        page = Math.min(Math.max(0, page), lastPage);
        if (page !== requestedPage) {
            return this.friendlyPanel(userId, page, selectedId);
        }
        const lines = rows.map((row, index) => {
            const linked = row.discord_id ? ` — <@${row.discord_id}>` : '';
            const profile = row.username ? ` (Discord: ${safe(row.username, 24)}`
                + (row.server_nickname ? `; nickname: ${safe(row.server_nickname, 24)}` : '') + ')' : '';
            return `${page * PAGE_SIZE + index + 1}. **${safe(row.ign, 32)}**${linked}${profile}`;
        });
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Scout Settings — Friendly List')
            .setDescription((lines.join('\n') || '*No friendly entries yet.*')
                + '\n\nAdd an IGN directly or choose a guild member to link their Discord account.')
            .setFooter({ text: lastPage > 0 ? `Crow Control • Page ${page + 1} of ${lastPage + 1}` : 'Crow Control' });
        const components = [];
        if (rows.length) {
            const options = rows.map(row => ({
                label: safe(row.ign, 100), value: String(row.entry_id),
                description: safe(row.username ? `Discord: ${row.username}` : 'Plain-text IGN', 100),
                default: String(row.entry_id) === String(selectedId)
            }));
            components.push(menuRow(new StringSelectMenuBuilder()
                .setCustomId(`${PREFIX}select-friendly:${userId}:${page}`)
                .setPlaceholder('Select a friendly entry to edit or remove')
                .addOptions(options)));
        }
        components.push(menuRow(new UserSelectMenuBuilder()
            .setCustomId(`${PREFIX}friend-user:${userId}:${page}`)
            .setPlaceholder('Link a Discord Server member to a friendly IGN')
            .setMinValues(1).setMaxValues(1)));
        components.push(new ActionRowBuilder().addComponents(
            button('Add IGN', `${PREFIX}add-friendly:${userId}:${page}`, ButtonStyle.Success),
            button('Edit selected', `${PREFIX}edit-friendly:${userId}:${page}:${selectedId || '-'}`, ButtonStyle.Primary, !selectedId),
            button('Remove selected', `${PREFIX}remove-friendly:${userId}:${page}:${selectedId || '-'}`, ButtonStyle.Danger, !selectedId)
        ));
        components.push(new ActionRowBuilder().addComponents(
            button('Previous', `${PREFIX}page-friendly:${userId}:${Math.max(0, page - 1)}:prev`, ButtonStyle.Secondary, page === 0),
            button('Next', `${PREFIX}page-friendly:${userId}:${Math.min(lastPage, page + 1)}:next`, ButtonStyle.Secondary, page >= lastPage),
            button('Settings', `${PREFIX}home:${userId}`).setEmoji('↩️')
        ));
        return { embeds: [embed], components, allowedMentions: { parse: [] } };
    }

    async memberPanel(userId, status = 'current', page = 0, selectedId = '') {
        status = status === 'former' ? 'former' : 'current';
        const { rows, total } = await this.store.listMembers(this.guildId, status, PAGE_SIZE, page * PAGE_SIZE);
        this.cacheEntries('member', rows);
        const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        const requestedPage = page;
        page = Math.min(Math.max(0, page), lastPage);
        if (page !== requestedPage) return this.memberPanel(userId, status, page, selectedId);
        const lines = rows.map((row, index) => {
            const display = row.server_nickname ? `**${safe(row.server_nickname, 48)}**` : `*No server nickname*`;
            return `${page * PAGE_SIZE + index + 1}. <@${row.discord_id}> — ${display} (Discord: ${safe(row.username, 24)})`;
        });
        const embed = new EmbedBuilder().setColor(0x5865F2)
            .setTitle(`Scout Settings — ${status === 'current' ? 'Current' : 'Former'} Members`)
            .setDescription((lines.join('\n') || `*No ${status} members in the scout list.*`)
                + '\n\nRole changes update current/former status automatically. You can select a server member to add or refresh their profile.')
            .setFooter({ text: lastPage > 0 ? `Crow Control • Page ${page + 1} of ${lastPage + 1}` : 'Crow Control' });
        const components = [];
        if (rows.length) {
            components.push(menuRow(new StringSelectMenuBuilder()
                .setCustomId(`${PREFIX}select-member:${userId}:${status}:${page}`)
                .setPlaceholder(status === 'former'
                    ? 'Select a Former Member to edit or remove'
                    : 'Select a Guild Member to edit or remove')
                .addOptions(rows.map(row => ({
                    label: safe(row.server_nickname || row.global_name || row.username, 100),
                    value: String(row.discord_id),
                    description: safe(`Discord: ${row.username}`, 100),
                    default: String(row.discord_id) === String(selectedId)
                })))));
        }
        components.push(menuRow(new UserSelectMenuBuilder()
            .setCustomId(`${PREFIX}member-user:${userId}:${status}:${page}`)
            .setPlaceholder(status === 'former'
                ? 'Add any Discord member or refresh a Former Member'
                : 'Add any Discord user or refresh a current Guild Member')
            .setMinValues(1).setMaxValues(1)));
        components.push(new ActionRowBuilder().addComponents(
            button('Add former by ID', `${PREFIX}add-former:${userId}:${page}`, ButtonStyle.Success),
            button('Edit selected', `${PREFIX}edit-member:${userId}:${status}:${page}:${selectedId || '-'}`, ButtonStyle.Primary, !selectedId),
            button('Remove selected', `${PREFIX}remove-member:${userId}:${status}:${page}:${selectedId || '-'}`, ButtonStyle.Danger, !selectedId)
        ));
        components.push(new ActionRowBuilder().addComponents(
            button('Previous', `${PREFIX}page-member:${userId}:${status}:${Math.max(0, page - 1)}:prev`, ButtonStyle.Secondary, page === 0),
            button('Next', `${PREFIX}page-member:${userId}:${status}:${Math.min(lastPage, page + 1)}:next`, ButtonStyle.Secondary, page >= lastPage),
            button('Current', `${PREFIX}status-member:${userId}:current`, status === 'current' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            button('Former', `${PREFIX}status-member:${userId}:former`, status === 'former' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            button('Settings', `${PREFIX}home:${userId}`).setEmoji('↩️')
        ));
        return { embeds: [embed], components, allowedMentions: { parse: [] } };
    }

    makeSession(interaction, fields) {
        const now = Date.now();
        for (const [token, session] of this.sessions) {
            if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(token);
        }
        const token = randomBytes(8).toString('hex');
        this.sessions.set(token, { ...fields, ownerId: interaction.user.id, createdAt: now });
        return token;
    }

    friendlyModal(interaction, { mode, page, entryId = '', ign = '', member = null }) {
        const token = this.makeSession(interaction, { mode, page, entryId, member });
        const modal = new ModalBuilder().setCustomId(`${PREFIX}modal:${interaction.user.id}:${token}`)
            .setTitle(mode === 'edit-friendly' ? 'Edit Friendly IGN' : 'Add Friendly IGN')
            .addLabelComponents(textInput('ign', 'In-game name', ign, {
                required: true, maxLength: 32, placeholder: 'Enter the exact Pokémon Revolution IGN'
            }));
        return modal;
    }

    memberModal(interaction, { mode, status = 'former', page = 0, memberId = '', username = '', nickname = '' }) {
        const token = this.makeSession(interaction, { mode, status, page, memberId });
        const modal = new ModalBuilder().setCustomId(`${PREFIX}modal:${interaction.user.id}:${token}`)
            .setTitle(mode === 'add-former' ? 'Add Former Member' : 'Edit Member Profile');
        if (mode === 'add-former') {
            modal.addLabelComponents(
                textInput('discord_id', 'Discord user ID', '', { required: true, maxLength: 20, placeholder: 'Discord snowflake ID' }),
                textInput('username', 'Discord username', '', { required: true, maxLength: 128 }),
                textInput('nickname', 'Server nickname (if known)', '', { required: false, maxLength: 128 })
            );
        } else {
            modal.addLabelComponents(
                textInput('username', 'Discord username', username, { required: true, maxLength: 128 }),
                textInput('nickname', 'Server nickname (if known)', nickname, { required: false, maxLength: 128 })
            );
        }
        return modal;
    }

    async getSelectedGuildMember(interaction, userId) {
        const selected = interaction.members?.get?.(String(userId));
        if (selected?.user) return selected;
        const cached = interaction.guild?.members?.cache?.get(String(userId));
        if (cached) return cached;
        return interaction.guild?.members?.fetch(String(userId)) || null;
    }

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!interaction.inGuild()) {
            return interaction.editReply({ content: 'This command can only be used in the server.' });
        }
        if (!this.isStaff(interaction)) return this.deny(interaction);
        if (!this.store) return interaction.editReply({ content: 'Scout list storage is unavailable.' });
        const search = interaction.options?.getString?.('search');
        let server = 'gold';
        if (this.config.scoutServers) {
            try { server = await staffServer(this.config, interaction); }
            catch (error) { return interaction.editReply(`Could not load your scout server: ${safe(error.message, 300)}`); }
        }
        if (search && this.reportManager) {
            try { await interaction.editReply(scoutPayload(await this.reportManager.listPanel(interaction.user.id, search, 0, server))); }
            catch (error) { await interaction.editReply(`Could not search scout reports: ${safe(error.message, 300)}`); }
        } else await interaction.editReply(scoutPayload(this.home(interaction.user.id, server)));
        return true;
    }

    async handleAutocomplete(interaction) {
        if (!this.isStaff(interaction) || !this.reportManager) return interaction.respond([]);
        try {
            const server = this.config.scoutServers ? await staffServer(this.config, interaction, { cachedOnly: true }) : 'gold';
            if (!server) return interaction.respond([]);
            await this.reportManager.autocomplete(interaction, server);
        }
        catch (error) {
            if (![10062, 40060].includes(Number(error.code))) console.warn(`[CC LOG] /scout-settings autocomplete failed: ${error.message}`);
        }
    }

    async handleButton(interaction) {
        if (!interaction.customId?.startsWith(PREFIX)) return false;
        const [, action, ownerId, ...args] = interaction.customId.split(':');
        if (!this.isStaff(interaction)) return this.deny(interaction);
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This settings menu belongs to another staff member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const page = Number(args[0]) || 0;
        if (action.startsWith('reports-') && this.reportManager) return this.reportManager.handleButton(interaction, ownerId, action, args);
        if (action === 'home') return interaction.update(scoutPayload(this.home(ownerId, args[0] === 'silver' ? 'silver' : 'gold'), interaction.message));
        if (action === 'open-friendly') return this.updatePanel(interaction, () => this.friendlyPanel(ownerId, Number(args[0]) || 0));
        if (action === 'open-members') return this.updatePanel(interaction, () => this.memberPanel(ownerId, args[0], Number(args[1]) || 0));
        if (action === 'add-friendly') {
            await interaction.showModal(this.friendlyModal(interaction, { mode: 'add-friendly', page }));
            return true;
        }
        if (action === 'add-former') {
            await interaction.showModal(this.memberModal(interaction, { mode: 'add-former', page }));
            return true;
        }
        if (action === 'friend-user') return false;
        if (action === 'edit-friendly') {
            const entryId = args[1];
            if (!entryId || entryId === '-') return interaction.reply({ content: 'Select a friendly entry first.', flags: MessageFlags.Ephemeral });
            const entry = this.cachedEntry('friendly', entryId);
            if (!entry) return this.updatePanel(interaction, () => this.friendlyPanel(ownerId, Number(args[0]) || 0));
            await interaction.showModal(this.friendlyModal(interaction, {
                mode: 'edit-friendly', page: Number(args[0]) || 0, entryId, ign: entry.ign
            }));
            return true;
        }
        if (action === 'remove-friendly') {
            const entryId = args[1];
            if (!entryId || entryId === '-') return interaction.reply({ content: 'Select a friendly entry first.', flags: MessageFlags.Ephemeral });
            return this.updatePanel(interaction, async () => {
                await this.store.removeFriendly(this.guildId, entryId);
                return { ...await this.friendlyPanel(ownerId, Number(args[0]) || 0), content: 'Friendly entry removed.' };
            });
        }
        if (action === 'page-friendly') return this.updatePanel(interaction, () => this.friendlyPanel(ownerId, Number(args[0]) || 0));
        if (action === 'page-member') return this.updatePanel(interaction, () => this.memberPanel(ownerId, args[0], Number(args[1]) || 0));
        if (action === 'status-member') return this.updatePanel(interaction, () => this.memberPanel(ownerId, args[0], 0));
        if (action === 'edit-member') {
            const [status, pageText, memberId] = args;
            if (!memberId || memberId === '-') return interaction.reply({ content: 'Select a member first.', flags: MessageFlags.Ephemeral });
            const member = this.cachedEntry('member', memberId);
            if (!member) return this.updatePanel(interaction, () => this.memberPanel(ownerId, status, Number(pageText) || 0));
            await interaction.showModal(this.memberModal(interaction, {
                mode: 'edit-member', status, page: Number(pageText) || 0, memberId,
                username: member.username, nickname: member.server_nickname
            }));
            return true;
        }
        if (action === 'remove-member') {
            const [status, pageText, memberId] = args;
            if (!memberId || memberId === '-') return interaction.reply({ content: 'Select a member first.', flags: MessageFlags.Ephemeral });
            return this.updatePanel(interaction, async () => {
                await this.store.removeMember(this.guildId, memberId);
                return { ...await this.memberPanel(ownerId, status, Number(pageText) || 0), content: 'Member entry removed.' };
            });
        }
        return false;
    }

    async handleSelect(interaction) {
        if (!interaction.customId?.startsWith(PREFIX)) return false;
        const [, action, ownerId, ...args] = interaction.customId.split(':');
        if (!this.isStaff(interaction)) return this.deny(interaction);
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This settings menu belongs to another staff member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        if (action === 'select-friendly') {
            return this.updatePanel(interaction, () => this.friendlyPanel(ownerId, Number(args[0]) || 0, interaction.values[0]));
        }
        if (action.startsWith('reports-') && this.reportManager) return this.reportManager.handleSelect(interaction, ownerId, action, args);
        if (action === 'select-member') {
            return this.updatePanel(interaction, () => this.memberPanel(ownerId, args[0], Number(args[1]) || 0, interaction.values[0]));
        }
        if (action === 'friend-user') {
            const page = Number(args[0]) || 0;
            let member = interaction.members?.get?.(interaction.values[0]) || interaction.guild?.members?.cache?.get(interaction.values[0]);
            if (member && !member.user) {
                const user = interaction.users?.get?.(interaction.values[0]);
                member = user ? { ...member, id: user.id, user, nickname: member.nick || null } : null;
            }
            if (!member) {
                return this.updatePanel(interaction, async () => {
                    const fetched = await this.getSelectedGuildMember(interaction, interaction.values[0]);
                    return { ...await this.friendlyPanel(ownerId, page), content: fetched
                        ? 'Member loaded. Select them again to enter the friendly IGN.' : 'Could not load that server member. Try again.' };
                });
            }
            await interaction.showModal(this.friendlyModal(interaction, {
                mode: 'add-friendly', page, member,
                ign: member.nickname || member.user.globalName || member.user.username
            }));
            return true;
        }
        if (action === 'member-user') {
            const [status, pageText] = args;
            return this.updatePanel(interaction, async () => {
                const member = await this.getSelectedGuildMember(interaction, interaction.values[0]);
                if (!member) throw new Error('Could not load that server member');
                const isMember = Boolean(member.roles?.cache?.has(this.guildMemberRoleID)
                    || (Array.isArray(member.roles) && member.roles.includes(this.guildMemberRoleID)));
                await this.store.saveMember(member, this.guildId, isMember ? 'current' : 'former');
                return { ...await this.memberPanel(ownerId, status, Number(pageText) || 0, member.id), content: 'Member profile saved.' };
            });
        }
        return false;
    }

    async handleModal(interaction) {
        if (!interaction.customId?.startsWith(`${PREFIX}modal:`) && !interaction.customId?.startsWith(`${PREFIX}reports-modal:`)) return false;
        const [, , ownerId, token] = interaction.customId.split(':');
        if (!this.isStaff(interaction)) return this.deny(interaction);
        if (String(ownerId) !== String(interaction.user.id)) {
            await interaction.reply({ content: 'This form belongs to another staff member.', flags: MessageFlags.Ephemeral });
            return true;
        }
        const session = this.sessions.get(token);
        if (interaction.customId.startsWith(`${PREFIX}reports-modal:`) && this.reportManager) return this.reportManager.handleModal(interaction, ownerId, token);
        if (!session || session.ownerId !== ownerId || Date.now() - session.createdAt > SESSION_TTL_MS) {
            await interaction.reply({ content: 'This form expired. Reopen the settings menu and try again.', flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (session.mode === 'add-friendly' || session.mode === 'edit-friendly') {
                const ign = interaction.fields.getTextInputValue('ign').trim();
                if (session.mode === 'edit-friendly') await this.store.editFriendly(this.guildId, session.entryId, ign);
                else await this.store.saveFriendly(this.guildId, ign, session.member);
                await interaction.editReply(`Friendly list saved for **${safe(ign, 64)}**. The settings menu remains open for more changes.`);
            } else if (session.mode === 'edit-member') {
                await this.store.editMember(this.guildId, session.memberId,
                    interaction.fields.getTextInputValue('username'),
                    interaction.fields.getTextInputValue('nickname'));
                await interaction.editReply('Member profile saved.');
            } else if (session.mode === 'add-former') {
                const discordId = interaction.fields.getTextInputValue('discord_id').trim();
                const username = interaction.fields.getTextInputValue('username').trim();
                const nickname = interaction.fields.getTextInputValue('nickname').trim() || null;
                if (!/^\d{17,20}$/u.test(discordId)) throw new Error('Enter a valid Discord user ID.');
                await this.store.saveMember({
                    id: discordId,
                    user: { id: discordId, username },
                    nickname
                }, this.guildId, 'former');
                await interaction.editReply('Former member added to the scout list.');
            }
        } catch (error) {
            await interaction.editReply(`Could not save this change: ${safe(error.message, 300)}`);
        } finally {
            this.sessions.delete(token);
        }
        return true;
    }
}

module.exports = ScoutSettings;
