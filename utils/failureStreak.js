// Reports a recurring background failure once per streak instead of on every retry.
'use strict';

const { isTransientDiscordError, networkErrorCode } = require('./networkErrors.js');

const MAX_STREAKS = 500;

// Discord and network outages have their own delayed connection alerts, so these stay in the console.
function temporaryFailure(error) {
    return isTransientDiscordError(error) || Number(error?.status) === 429
        || ['AbortError', 'TimeoutError'].includes(error?.name);
}

// Each key (a monitor, a post, a giveaway) has its own streak. The first unexpected failure is logged with
// console.error, which alerts staff; later failures stay silent until a success logs one recovery line.
class FailureStreak {
    constructor({ maxStreaks = MAX_STREAKS } = {}) {
        this.maxStreaks = maxStreaks;
        this.streaks = new Map();
    }

    // expected marks failures that another alert already covers, such as a MySQL outage; they stay in the console.
    fail(key, message, error, { expected = false } = {}) {
        const id = String(key);
        let streak = this.streaks.get(id);
        if (!streak) {
            streak = { failures: 0, alerted: false, logged: false };
            this.streaks.set(id, streak);
            if (this.streaks.size > this.maxStreaks) this.streaks.delete(this.streaks.keys().next().value);
        }
        streak.failures += 1;
        if (expected || temporaryFailure(error)) {
            const code = networkErrorCode(error);
            if (!streak.logged) console.log(message, code === 'UNKNOWN' ? String(error?.status ?? error?.code ?? error?.name) : code);
            streak.logged = true;
            return false;
        }
        if (streak.alerted) return false;
        streak.alerted = streak.logged = true;
        console.error(message, error);
        return true;
    }

    succeed(key, recoveryMessage) {
        const id = String(key);
        const streak = this.streaks.get(id);
        if (!streak) return;
        this.streaks.delete(id);
        if (streak.logged) console.log(`${recoveryMessage} after ${streak.failures} failed attempt(s).`);
    }

    // Drops a streak without a recovery line, for example when its work no longer exists.
    forget(key) {
        this.streaks.delete(String(key));
    }

    keys() {
        return [...this.streaks.keys()];
    }
}

module.exports = { FailureStreak, temporaryFailure };
