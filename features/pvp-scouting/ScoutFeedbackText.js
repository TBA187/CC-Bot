// Correction wording shared by the scouting channel and member edit audit embeds.
'use strict';

function reviewSuggestions(outcome) {
    const rawReason = outcome.reason || 'The opponent or team could not be verified confidently.';
    const needsApproval = Boolean(outcome.edit) || /officer must approve/iu.test(rawReason);
    const suggestions = [];
    if (needsApproval) {
        suggestions.push('An officer must approve changes to an already published or reviewed scout.');
        if (outcome.edit?.after?.reviewReason) suggestions.push('Also check the opponent IGN and team details in your edited message.');
    } else {
        if (/IGN|opponent|unlabeled|name/iu.test(rawReason)) {
            suggestions.push('Put the opponent’s exact IGN on the first line, for example `Opponent IGN: PlayerName`.');
        }
        if (/different|multiple|spell.*differ/iu.test(rawReason)) {
            suggestions.push('Make sure the text and screenshots identify the same opponent.');
        }
        if (/multiple opponents/iu.test(rawReason)) {
            suggestions.push('To report several opponents in one message, start each report with the opponent’s IGN on its own line after an empty line.');
        }
        if (/author|guild member/iu.test(rawReason)) {
            suggestions.push('Identify which name is the opponent, especially when the screenshot also shows your own IGN.');
        }
        if (/screenshot|image|preview/iu.test(rawReason)) {
            suggestions.push('Use a clear screenshot with the opponent IGN visible.');
        }
        if (/Pokémon|pokemon|team member|details|spam/iu.test(rawReason) || !suggestions.length) {
            suggestions.push('Put each Pokémon on its own line, followed by its moves, item, or other scouting details.');
        }
    }
    return suggestions;
}

function reviewFeedbackText(outcome) {
    const rawReason = outcome.reason || 'The opponent or team could not be verified confidently.';
    const needsApproval = Boolean(outcome.edit) || /officer must approve/iu.test(rawReason);
    const reason = String(rawReason).replace(/([\\*_~`|>])/gu, '\\$1').slice(0, 900);
    const suggestions = reviewSuggestions(outcome);
    return `⚠️ **This Scout Report needs review.**\n`
        + (needsApproval ? 'Your edited scout is awaiting officer approval.\n'
            : outcome.escalated ? "The scout message still couldn't be verified after the correction window and was sent for officer review.\n"
                : "The scout message couldn't be confidently verified. Please correct it using the suggestions below.\n")
        + `\n**Reason:** ${reason}\n\n**What to improve:**\n`
        + suggestions.map(suggestion => `- ${suggestion}`).join('\n')
        + '\n\nPlease edit **your original scout message** with these changes, and your scout report will be processed again. '
        + 'You don’t need to reply to this bot message.\n'
        + 'Once your scout report has been successfully validated'
        + (needsApproval ? ' and any required officer review has been completed' : '')
        + ' and added to the `/scout` command, this reply will be deleted and the 👎 reaction will be replaced with 👍.'
        + (needsApproval || outcome.escalated ? '' : '\n\n-# If this report still cannot be validated 1 hour after the first 👎, it will be sent for officer review.'
            + (outcome.dueAtMs ? ` Deadline: <t:${Math.floor(outcome.dueAtMs / 1000)}:R>.` : ''));
}


module.exports = { reviewFeedbackText, reviewSuggestions };
