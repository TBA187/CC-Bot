'use strict';

// Checks open application polls and nudges Officers when participation is still too low.
const {
    POLL_LIFETIME_MS,
    VOTE_REMINDER_12H_MS,
    VOTE_REMINDER_18H_MS,
    VOTE_REMINDER_INTERVAL_MS
} = require('../constants.js');
const { findRecentBotMessage } = require('../../../utils/discordMessageHistory.js');
const { shutdownError } = require('../../../utils/abortable.js');

class GuildApplicationVoteReminder {
    constructor(options = {}) {
        this.client = options.client;
        this.store = options.store;
        this.guildId = String(options.guildId || '');
        this.courtChannelId = String(options.courtHouseChannelID || options.courtChannelId || '');
        this.officerRoleId = String(options.officerRoleID || options.officerRoleId || '');
        this.clock = options.clock || (() => new Date());
        this.intervalMs = options.intervalMs || VOTE_REMINDER_INTERVAL_MS;
        this.interval = null;
        this.running = false;
        this.started = false;
        this.stopped = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        this.interval = setInterval(() => {
            this.runOnce().catch(error => console.error('[CC LOG] Guild Application vote reminder failed:', error));
        }, this.intervalMs);
        this.interval.unref?.();
        await this.runOnce().catch(error => console.error('[CC LOG] Guild Application vote reminder failed:', error));
    }

    stop() {
        this.stopped = true;
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.started = false;
    }

    checkRunning() {
        if (this.stopped) throw shutdownError();
    }

    async getGuild() {
        if (!this.guildId) throw new Error('Guild ID is not configured for Guild Application vote reminders.');
        const guild = this.client.guilds.cache.get(this.guildId) || await this.client.guilds.fetch(this.guildId);
        if (!guild) throw new Error(`Guild ${this.guildId} is unavailable.`);
        return guild;
    }

    async getCourtChannel() {
        if (!this.courtChannelId) throw new Error('Court House channel ID is not configured.');
        const channel = this.client.channels.cache.get(this.courtChannelId)
            || await this.client.channels.fetch(this.courtChannelId);
        if (!channel?.isTextBased?.() || !channel.messages?.fetch || typeof channel.send !== 'function') {
            throw new Error(`Court House channel ${this.courtChannelId} is unavailable.`);
        }
        return channel;
    }

    async fetchOfficerIds(guild) {
        const officerIds = new Set();
        let after;

        // REST pagination avoids the gateway member-search request used by guild.members.fetch().
        while (true) {
            this.checkRunning();
            const members = await guild.members.list({ limit: 1000, after, cache: false });
            for (const member of members.values()) {
                if (!member.user?.bot && member.roles?.cache?.has(this.officerRoleId)) officerIds.add(member.id);
            }
            if (members.size < 1000) break;
            const nextAfter = members.lastKey();
            if (!nextAfter || nextAfter === after) break;
            after = nextAfter;
        }

        return officerIds;
    }

    async fetchPollVoterIds(pollMessage) {
        if (!pollMessage?.poll?.answers?.size) throw new Error(`Message ${pollMessage?.id || 'unknown'} has no poll.`);
        const voterIds = new Set();

        for (const answer of pollMessage.poll.answers.values()) {
            let after;
            while (true) {
                this.checkRunning();
                const voters = await answer.voters.fetch({ limit: 100, after });
                for (const user of voters.values()) {
                    if (!user.bot) voterIds.add(user.id);
                }
                if (voters.size < 100) break;
                const nextAfter = voters.lastKey();
                if (!nextAfter || nextAfter === after) break;
                after = nextAfter;
            }
        }

        return voterIds;
    }

    reminderStage(record, now) {
        const createdMs = Date.parse(record.pollCreatedAt || '');
        if (!Number.isFinite(createdMs)) return null;
        const ageMs = now.getTime() - createdMs;
        if (ageMs < VOTE_REMINDER_12H_MS || ageMs >= POLL_LIFETIME_MS) return null;
        if (ageMs >= VOTE_REMINDER_18H_MS && !record.voteReminder18hCheckedAt) {
            return { hours: 18, checkedField: 'voteReminder18hCheckedAt', messageField: 'voteReminder18hMessageId' };
        }
        if (ageMs < VOTE_REMINDER_18H_MS && !record.voteReminder12hCheckedAt) {
            return { hours: 12, checkedField: 'voteReminder12hCheckedAt', messageField: 'voteReminder12hMessageId' };
        }
        return null;
    }

    reminderContent(record, hours) {
        const applicant = record.ign || 'this applicant';
        return `### \u{1F514} Vote Reminder, <@&${this.officerRoleId}>\n\n`
            + `It has been **${hours} hours** since a poll was created, and less than 50% of Officers have voted!\n`
            + `Please review the application for **${applicant}** and cast your vote!\n`
            + `- **View Application: [Click Here!](<${record.officerMessageUrl}>)**\n`
            + `- **Cast your vote: [Click Here!](<${record.pollMessageUrl}>)**`;
    }

    async processCandidate(record, now, officerIds, courtChannel) {
        this.checkRunning();
        const stage = this.reminderStage(record, now);
        if (!stage) return false;

        const pollMessage = await courtChannel.messages.fetch(record.pollMessageId);
        const voterIds = await this.fetchPollVoterIds(pollMessage);
        this.checkRunning();
        const officerVotes = [...voterIds].filter(userId => officerIds.has(userId)).length;
        const requiredVotes = Math.ceil(officerIds.size / 2);

        // A late restart skips the stale 12-hour reminder and records only the current 18-hour check.
        if (stage.hours === 18 && !record.voteReminder12hCheckedAt) {
            record.voteReminder12hCheckedAt = now.toISOString();
        }

        if (officerVotes < requiredVotes) {
            let reminder = null;
            try {
                reminder = await findRecentBotMessage(courtChannel, {
                    botUserId: this.client.user?.id,
                    needles: [record.pollMessageUrl, `It has been **${stage.hours} hours**`]
                });
            } catch (error) {
                console.warn(
                    `[CC LOG] Could not check recent vote reminders for Guild Application ${record.postId}: `
                    + `${error.code || error.message}`
                );
            }
            if (reminder) {
                console.log(
                    `[CC LOG] Recovered ${stage.hours}-hour vote reminder for Guild Application ${record.postId}; `
                    + 'duplicate send skipped.'
                );
            } else {
                this.checkRunning();
                reminder = await courtChannel.send({
                    content: this.reminderContent(record, stage.hours),
                    allowedMentions: { parse: [], roles: [this.officerRoleId], repliedUser: false },
                    reply: { messageReference: pollMessage.id }
                });
            }
            record[stage.messageField] = reminder.id;
        }

        record[stage.checkedField] = now.toISOString();
        await this.store.saveRecord(record);
        return true;
    }

    async runOnce() {
        if (this.stopped || this.running) return false;
        this.running = true;
        try {
            const now = this.clock();
            const candidates = await this.store.voteReminderCandidates(now);
            this.checkRunning();
            if (!candidates.length) return true;

            const guild = await this.getGuild();
            this.checkRunning();
            const courtChannel = await this.getCourtChannel();
            this.checkRunning();
            const officerIds = await this.fetchOfficerIds(guild);

            for (const record of candidates) {
                try {
                    await this.processCandidate(record, now, officerIds, courtChannel);
                } catch (error) {
                    if (error.code === 'BOT_SHUTTING_DOWN') return false;
                    console.error(`[CC LOG] Guild Application vote reminder ${record.postId} failed:`, error);
                }
            }
            return true;
        } catch (error) {
            if (error.code === 'BOT_SHUTTING_DOWN') return false;
            throw error;
        } finally {
            this.running = false;
        }
    }
}

module.exports = {
    GuildApplicationVoteReminder
};
