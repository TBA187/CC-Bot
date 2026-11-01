// Keep the Crow Control role aligned with each member's server tag.
'use strict';

const { Events, PermissionFlagsBits, Routes } = require('discord.js');
const { fetchGuildMemberRoster } = require('./guildMemberRoster.js');
const { runtimeActivity } = require('./runtimeActivity.js');
const { abortableDelay } = require('./abortable.js');
const { networkErrorCode, isTransientDiscordError } = require('./networkErrors.js');

const POLICY_REASON_PREFIX = '[CC tag policy]';

function serverTagStatus(user, guildId) {
    if (!user) return undefined;
    const raw = Object.hasOwn(user, 'primary_guild');
    if (!raw && !Object.hasOwn(user, 'primaryGuild')) return undefined;
    const identity = raw ? user.primary_guild : user.primaryGuild;
    if (identity === undefined) return undefined;
    if (identity === null) return false;
    const enabled = raw ? identity.identity_enabled : identity.identityEnabled;
    if (enabled === false || enabled === null) return false;
    const id = raw ? identity.identity_guild_id : identity.identityGuildId;
    if (enabled !== true || id == null) return undefined;
    return String(id) === String(guildId);
}

function policyReason(enabled) {
    return `${POLICY_REASON_PREFIX} ${enabled
        ? 'This member is wearing the CC Server Tag, so they must keep the Crow Control role.'
        : 'This member is not wearing the CC Server Tag, so they cannot keep the Crow Control role.'}`;
}

class ServerTagRoleManager {
    constructor({ client, guildId, roleId, signal, onTagChange = async () => {}, onCorrection = async () => {},
        intervalMs = 10 * 60_000, spacingMs = 350, now = Date.now, activity = runtimeActivity,
        schedule = setInterval, cancel = clearInterval, pause = abortableDelay,
        lookupRetryDelays = [1000, 3000], retryDelayMs = 30_000, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout }) {
        Object.assign(this, { client, guildId, roleId, signal, onTagChange, onCorrection, intervalMs, spacingMs, now, activity, schedule, cancel, pause });
        Object.assign(this, { lookupRetryDelays, retryDelayMs, scheduleTimeout, cancelTimeout });
        this.states = new Map();
        this.pending = new Map();
        this.expectedChanges = new Map();
        this.lastIssues = new Map();
        this.timer = null;
        this.retryTimer = null;
        this.stopController = new AbortController();
        this.networkFailures = new Set();
        this.networkUnavailable = false;
        this.sweeping = false;
        this.stopped = Boolean(signal?.aborted);
    }

    current(member, state, revision) {
        return !this.stopped && this.states.get(member.id) === state && state.revision === revision;
    }

    reportIssue(code, error) {
        const previous = this.lastIssues.get(code);
        if (previous !== undefined && this.now() - previous < this.intervalMs) return false;
        this.lastIssues.set(code, this.now());
        console.warn(`[CC TAG] ${error.message}`);
        return true;
    }

    noteUnavailable(id, error) {
        if (this.stopped) return;
        this.networkFailures.add(id);
        if (this.networkUnavailable) return;
        this.networkUnavailable = true;
        console.warn(`[CC TAG] Discord verification unavailable (${networkErrorCode(error)}). Tag checks will retry automatically; existing roles remain pending verification.`);
    }

    noteVerified(id) {
        this.networkFailures.delete(id);
        if (this.stopped || !this.networkUnavailable || this.networkFailures.size) return;
        this.networkUnavailable = false;
        if (this.retryTimer !== null) this.cancelTimeout(this.retryTimer);
        this.retryTimer = null;
        console.log('[CC TAG] Discord verification restored. Pending tag checks have completed.');
    }

    retryVerification() {
        if (this.stopped || this.retryTimer !== null) return;
        this.retryTimer = this.scheduleTimeout(() => {
            this.retryTimer = null;
            if (this.stopped) return;
            if (this.sweeping) this.retryVerification();
            else void this.sweep();
        }, this.retryDelayMs);
        this.retryTimer?.unref?.();
    }

    async lookupUser(member, state, revision) {
        for (let attempt = 0; ; attempt++) {
            if (!this.current(member, state, revision)) return;
            try { return await this.client.rest.get(Routes.user(member.id)); }
            catch (error) {
                if (!this.current(member, state, revision) || !isTransientDiscordError(error)) throw error;
                this.noteUnavailable(member.id, error);
                if (attempt >= this.lookupRetryDelays.length) throw error;
                await this.pause(this.lookupRetryDelays[attempt], this.stopController.signal);
            }
        }
    }

    async editableRole(guild) {
        const role = guild.roles.cache.get(this.roleId) || await guild.roles.fetch(this.roleId);
        if (!role || role.managed) throw Object.assign(new Error('The configured Crow Control role is missing or is managed by an integration.'), { code: 'CC_ROLE_UNAVAILABLE' });
        const me = guild.members.me || await guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
            throw Object.assign(new Error('Crow Control needs Manage Roles and a highest role above the Crow Control role to enforce the server-tag policy.'), { code: 'CC_ROLE_PERMISSIONS' });
        }
        return role;
    }

    consumeExpectedChange(member, added) {
        const valid = (this.expectedChanges.get(member.id) || []).filter(change => this.now() - change.at < 30000);
        const index = valid.findIndex(change => change.added === added);
        const expected = index >= 0 ? valid.splice(index, 1)[0] : null;
        if (valid.length) this.expectedChanges.set(member.id, valid);
        else this.expectedChanges.delete(member.id);
        return expected;
    }

    request(member, { user, previousTag, source = 'role_update', announce = true, trustEvent = false, reportCorrection = true } = {}) {
        if (this.stopped || member.guild.id !== this.guildId) return Promise.resolve({ status: 'stopped' });
        let state = this.states.get(member.id);
        if (!state) {
            state = { revision: 0, enabled: undefined, eventTag: undefined, eventAt: 0 };
            this.states.set(member.id, state);
        }
        const tag = trustEvent ? serverTagStatus(user, this.guildId) : undefined;
        if (tag !== undefined) { state.eventTag = tag; state.eventAt = this.now(); state.revision++; }
        const before = this.pending.get(member.id) || Promise.resolve();
        const pending = before.catch(() => {}).then(() => this.reconcile(member, state, { tag, previousTag, source, announce, reportCorrection }))
            .then(result => {
                if (result.status === 'compliant' || result.status === 'corrected') this.noteVerified(member.id);
                return result;
            })
            .catch(error => {
                const transient = isTransientDiscordError(error);
                if (!this.stopped && error.code !== 10007) {
                    if (transient) { this.noteUnavailable(member.id, error); this.retryVerification(); }
                    else this.reportIssue(error.code || 'CC_TAG_LOOKUP', error);
                }
                return { status: error.code === 10007 ? 'left' : transient ? 'unavailable' : 'failed' };
            }).finally(() => {
                if (this.pending.get(member.id) === pending) this.pending.delete(member.id);
            });
        this.pending.set(member.id, pending);
        return pending;
    }

    async reconcile(member, state, { tag, previousTag, source, announce, reportCorrection }) {
        const revision = state.revision;
        if (!this.current(member, state, revision)) return { status: 'stale' };
        let enabled;
        const recentlyChecked = source === 'periodic' && state.checkedAt != null && this.now() - state.checkedAt < 30000;
        if (tag !== undefined || (state.eventTag !== undefined && this.now() - state.eventAt < 5000)) enabled = state.eventTag;
        else if (recentlyChecked) enabled = state.enabled;
        else if (member.user.bot) enabled = false;
        else {
            // Inspect the raw response: an omitted optional field is unknown,
            // whereas an explicit null means the user is not displaying a tag.
            const raw = await this.lookupUser(member, state, revision);
            if (!this.current(member, state, revision)) return { status: 'stale' };
            enabled = serverTagStatus(raw, this.guildId);
        }
        if (enabled === undefined) {
            state.checkedAt = null;
            this.reportIssue('CC_TAG_METADATA', new Error('Discord did not provide primary-guild metadata; the CC role was left pending verification.'));
            return { status: 'unknown' };
        }
        const before = state.enabled ?? previousTag;
        state.enabled = enabled;
        // A periodic sweep may reuse a just-completed live check. Manual edits
        // still verify current metadata, and each ten-minute sweep refreshes it.
        if (!recentlyChecked) state.checkedAt = this.now();
        if (announce && before !== enabled && (before !== undefined || (source === 'join' && enabled))) {
            try { await this.onTagChange(member, enabled); }
            catch (error) { this.reportIssue('CC_TAG_LOG', error); }
        }
        if (!this.current(member, state, revision)) return { status: 'stale' };
        const cached = member.guild.members.cache.get(member.id) || member;
        if (cached.roles.cache.has(this.roleId) === enabled) return { status: 'compliant', enabled };
        let role, token;
        const reason = policyReason(enabled);
        try {
            role = await this.editableRole(member.guild);
            // Confirm membership and its current roles before touching the one managed role.
            const current = await member.guild.members.fetch({ user: member.id, force: true, cache: false });
            if (!this.current(member, state, revision)) return { status: 'stale' };
            if (current.roles.cache.has(this.roleId) === enabled) return { status: 'compliant', enabled };
            token = { added: enabled, at: this.now() };
            const expected = (this.expectedChanges.get(member.id) || []).filter(change => this.now() - change.at < 30000);
            this.expectedChanges.set(member.id, [...expected, token].slice(-5));
            if (enabled) await current.roles.add(this.roleId, reason);
            else await current.roles.remove(this.roleId, reason);
            const verified = await member.guild.members.fetch({ user: member.id, force: true, cache: false });
            if (!this.current(member, state, revision)) return { status: 'stale' };
            if (verified.roles.cache.has(this.roleId) !== enabled) throw new Error('Discord has not confirmed the requested CC role correction.');
            const result = { status: 'corrected', enabled, added: enabled, role, source, reason, success: true };
            try { if (reportCorrection) await this.onCorrection(verified, result); }
            catch (error) { this.reportIssue('CC_TAG_LOG', error); }
            return result;
        } catch (error) {
            if (token) {
                const remaining = (this.expectedChanges.get(member.id) || []).filter(change => change !== token);
                if (remaining.length) this.expectedChanges.set(member.id, remaining);
                else this.expectedChanges.delete(member.id);
            }
            if (!this.current(member, state, revision) || error.code === 10007) return { status: 'left' };
            if (isTransientDiscordError(error)) {
                this.noteUnavailable(member.id, error);
                this.retryVerification();
                return { status: 'unavailable', enabled, role, reason };
            }
            if (this.reportIssue(error.code || 'CC_TAG_CORRECTION', error)) {
                try { if (reportCorrection) await this.onCorrection(member, { added: enabled, role: role || { id: this.roleId, name: 'Crow Control' }, source,
                    reason, success: false, error: error.message }); }
                catch (logError) { this.reportIssue('CC_TAG_LOG', logError); }
            }
            return { status: 'failed', enabled, role, reason, error: error.message };
        }
    }

    forget(member) {
        if (member.guild.id !== this.guildId) return;
        const state = this.states.get(member.id);
        if (state) state.revision++;
        this.states.delete(member.id);
        this.expectedChanges.delete(member.id);
        this.networkFailures.delete(member.id);
    }

    async sweep({ startup = false } = {}) {
        if (this.stopped || this.sweeping) return;
        this.sweeping = true;
        const finishActivity = this.activity.begin(`CC server-tag verification${startup ? ' (startup)' : ''}`);
        try {
            const guild = this.client.guilds.cache.get(this.guildId);
            if (!guild || !guild.available) return;
            await this.editableRole(guild);
            const members = await fetchGuildMemberRoster(guild, { signal: this.signal });
            if (this.stopped) return;
            for (const member of members.values()) {
                if (this.stopped) break;
                const result = await this.request(member, { source: startup ? 'startup' : 'periodic', announce: !startup });
                // One failed lookup is enough to defer a sweep during an outage.
                if (result.status === 'unavailable') break;
                if (this.spacingMs && !this.stopped) await this.pause(this.spacingMs, this.stopController.signal);
            }
            for (const id of this.states.keys()) if (!members.has(id) && !this.pending.has(id)) {
                this.states.delete(id); this.networkFailures.delete(id);
            }
            this.noteVerified('sweep');
        } catch (error) {
            if (!this.stopped) {
                if (isTransientDiscordError(error)) { this.noteUnavailable('sweep', error); this.retryVerification(); }
                else this.reportIssue(error.code || 'CC_TAG_SWEEP', error);
            }
        } finally { this.sweeping = false; finishActivity(); }
    }

    start() {
        if (this.stopped || this.timer) return;
        const initialize = () => { if (!this.stopped) void this.sweep({ startup: true }); };
        if (this.client.isReady()) initialize();
        else this.client.once(Events.ClientReady, initialize);
        this.timer = this.schedule(() => { void this.sweep(); }, this.intervalMs);
        this.timer.unref?.();
        this.signal?.addEventListener('abort', () => this.stop(), { once: true });
    }

    stop() {
        this.stopped = true;
        this.stopController.abort();
        if (this.timer) this.cancel(this.timer);
        if (this.retryTimer !== null) this.cancelTimeout(this.retryTimer);
        this.retryTimer = null;
        this.timer = null;
        this.states.clear();
        this.expectedChanges.clear();
        this.networkFailures.clear();
    }
}

module.exports = { ServerTagRoleManager, serverTagStatus, policyReason, POLICY_REASON_PREFIX };
