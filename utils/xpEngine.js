// Apply confirmed XP awards, level changes and configured role rewards.
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getTotalXpForLevel } = require('./xpMath');
const { getXpStore } = require('./xpStore');
const { fetchTrackById, fetchRewardsByIds, getXpTypeFromTrackInfo, reportXpDatabaseError } = require('./xpDbHelper');
const xpSettings = require('../config/xpConfig');

/**
 * Shared logic to process XP, update DB, and handle level-ups.
 * Accepts 'actionType' (message, reaction, command, voice) 
 * and 'statCount' (usually 1, but for voice it represents minutes).
 */
async function processXp(userId, guild, channelId, member, xpGained, trackInfo, commandConfig, actionType, statCount = 1) {
    const track = getXpTypeFromTrackInfo(trackInfo);
    if (!track) {
        console.error(`[XP ENGINE] Refusing to process ${actionType} XP for ${userId} without a valid xp_type.`);
        return;
    }

    if (!['message', 'reaction', 'command', 'voice'].includes(actionType)) {
        console.warn(`[XP ENGINE] Unknown actionType: ${actionType}`);
        return;
    }
    const guildId = guild.id;
    // Server Nickname > Discord Global Name > Username
    const displayName = member.displayName || member.user.globalName || member.user.username;

    try {
        await getXpStore(commandConfig.db).record({
            kind: 'award', userId, guildId, username: displayName, xpType: track,
            actionType, xpGained, statCount, channelId, trackInfo
        }, (operation, result) => finishXpAward(operation, result, guild, member, commandConfig));
    } catch (err) {
        reportXpDatabaseError(commandConfig.db, err, {
            context: `🚨 Error for ${userId} on track ${track}`, write: true, prefix: '[XP ENGINE]'
        });
    }
}

// The original level reward/message behavior runs only after a committed award.
async function finishXpAward(operation, currentData, guild, member, commandConfig) {
    const { userId, xpType: track, trackInfo } = operation;
    const correctLevel = currentData.correctLevel;
    if (correctLevel > currentData.level) {
        // --- Initialize displayTrackInfo and settings early for reward fetching ---
        let settings = (track === 'global') ? xpSettings.global : trackInfo;
        let displayTrackInfo = trackInfo;

        // If track is numeric ID, fetch full track details from database
        if (/^\d+$/.test(track)) {
            const dbTrack = await fetchTrackById(commandConfig.db, parseInt(track), { requireMysql: true });
            if (dbTrack) {
                displayTrackInfo = dbTrack;
                settings = dbTrack;
            }
        }

        // --- AUTO ROLE ASSIGNMENT (Level Rewards) ---
        let rolesEarned = []; // Array to store multiple roles in case of level jumps
        let rewardDescriptions = []; // Array to store reward descriptions
        let trackRewards = [];

        // Fetch rewards from database if track is numeric ID, otherwise use config
        if (/^\d+$/.test(track)) {
            // Get the track's level_rewards IDs from the track info
            const rewardIds = displayTrackInfo.levelRewards || [];
            if (rewardIds.length > 0) {
                trackRewards = await fetchRewardsByIds(commandConfig.db, rewardIds, { requireMysql: true });
            }
        } else {
            trackRewards = (track === 'global') ? xpSettings.levelRewards : trackInfo.levelRewards;
        }

        if (trackRewards && trackRewards.length > 0) {
            for (const reward of trackRewards) {
                // Check if the user just reached this level (between old level and new level)
                if (correctLevel >= reward.level && currentData.level < reward.level) {
                    // Add description if present
                    if (reward.description) {
                        rewardDescriptions.push({ level: reward.level, description: reward.description });
                    }
                    // Assign role if roleId is present and user doesn't have it
                    if (reward.roleId && !member.roles.cache.has(reward.roleId)) {
                        try {
                            await member.roles.add(reward.roleId, `XP level reward: reached level ${reward.level} (${track})`);
                            // Push object to reference the level and role together in the embed
                            rolesEarned.push({ id: reward.roleId, level: reward.level });
                        } catch (roleErr) {
                            console.error(`[XP ENGINE] 🚨 Failed to assign role ${reward.roleId} to ${userId} :`, roleErr);
                        }
                    }
                }
            }
        }

        // --- Level Up Notification Logic ---
        // Only proceed if sendLevelUpMsg is TRUE
        if (settings.sendLevelUpMsg) {
            const xpLogChannel = guild.channels.cache.get(commandConfig.botChannelID);
            if (xpLogChannel) {
                const logoFile = new AttachmentBuilder(xpSettings.logoPath, { name: 'cc_logo.webp' });

                // --- Calculate XP needed for next level ---
                // Check if the user is at Max Level
                const isMaxLevel = xpSettings.levelFormula.maxLevel && correctLevel >= xpSettings.levelFormula.maxLevel;
                let xpProgress = "";
                let xpForNextLevel = "";
                if (isMaxLevel) {
                    xpProgress = currentData.xp_amount;
                    xpForNextLevel = "**MAX Level Reached!**";
                } else {
                    const totalXpRequiredForNext = getTotalXpForLevel(correctLevel + 1);
                    const xpRequiredForNext = totalXpRequiredForNext - currentData.xp_amount;
                    xpProgress = `${currentData.xp_amount} / ${totalXpRequiredForNext} XP`;
                    xpForNextLevel = `${xpRequiredForNext} XP`;
                }

                // --- XP TRACK Text ---
                let xpTrackTxt = '';
                switch (true) {
                    case track === 'global':
                        xpTrackTxt = `Congratulations <@${userId}>! You reached level **${correctLevel}**\u2002🎉`;
                        break;
                    case /^\d+$/.test(track): {
                        // Handle special XP-Tracks from the Database
                        const hasRoles = displayTrackInfo.roleIds && displayTrackInfo.roleIds.length > 0;
                        const hasChannels = displayTrackInfo.channelIds && displayTrackInfo.channelIds.length > 0;

                        if (hasRoles && hasChannels) {
                            // Both Role(s) & Channel(s) XP-Track
                            const requiredRoles = displayTrackInfo.roleIds.length > 1
                                ? displayTrackInfo.roleIds.map(roleId => `<@&${roleId}>`).join(', ')
                                : `<@&${displayTrackInfo.roleIds[0]}>`;
                            const requiredChannels = displayTrackInfo.channelIds.length > 1
                                ? displayTrackInfo.channelIds.map(channelId => `<#${channelId}>`).join(', ')
                                : `<#${displayTrackInfo.channelIds[0]}>`;

                            xpTrackTxt =
                                `### Congratulations <@${userId}>!\u2002🎉\nYou reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                `-# - **XP role${displayTrackInfo.roleIds.length > 1 ? 's' : ''}:** ${requiredRoles}\n` +
                                `-# - **XP channel${displayTrackInfo.channelIds.length > 1 ? 's' : ''}:** ${requiredChannels}`;
                        } else if (hasRoles) {
                            // Roles Only XP-Track
                            const requiredRoles = displayTrackInfo.roleIds.length > 1
                                ? displayTrackInfo.roleIds.map(roleId => `<@&${roleId}>`).join(', ')
                                : `<@&${displayTrackInfo.roleIds[0]}>`;

                            xpTrackTxt =
                                `### Congratulations <@${userId}>!\u2002🎉\nYou reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                `-# - **XP role${displayTrackInfo.roleIds.length > 1 ? 's' : ''}:** ${requiredRoles}`;
                        } else if (hasChannels) {
                            // Channels Only XP-Track
                            const requiredChannels = displayTrackInfo.channelIds.length > 1
                                ? displayTrackInfo.channelIds.map(channelId => `<#${channelId}>`).join(', ')
                                : `<#${displayTrackInfo.channelIds[0]}>`;

                            xpTrackTxt =
                                `### Congratulations <@${userId}>!\u2002🎉You reached level **${correctLevel}** in the **${displayTrackInfo.name}** XP Track:\n` +
                                `-# - **XP channel${displayTrackInfo.channelIds.length > 1 ? 's' : ''}:** ${requiredChannels}`;
                        }
                        break;
                    }
                    default:
                        return; // Not a valid track
                }

                // -- Role Rewards Text ---
                let roleRewardTxt = '';
                if (rolesEarned.length === 1) { // Singular: One role earned
                    roleRewardTxt = `\n\nFor reaching Level **${rolesEarned[0].level}**, you have been awarded a new role:\n- <@&${rolesEarned[0].id}>`;
                } else if (rolesEarned.length > 1) { // Plural: Multiple roles earned (e.g. jumping multiple levels)
                    const roleList = rolesEarned.map(r => `Level **${r.level}**: <@&${r.id}>`).join('\n');
                    roleRewardTxt = `\n\nYou have earned multiple role rewards for your progress:\n${roleList}`;
                }

                // -- Reward Descriptions Text ---
                let rewardTxt = '';
                if (rewardDescriptions.length > 0) {
                    const rewardList = rewardDescriptions.map(r => `**:gift:\u2002You have earned a reward:**\n${r.description}`).join('\n');
                    rewardTxt = `\n\n${rewardList}`;
                }

                // -- Level Up Embed ---
                const levelEmbed = new EmbedBuilder()
                    .setTitle('🏆\u2002Level Up!')
                    .setDescription(`${xpTrackTxt}${roleRewardTxt}${rewardTxt}`)
                    .setColor(displayTrackInfo.color || '#5865F2')
                    .addFields(
                        { name: 'XP Progress', value: xpProgress, inline: true },
                        { name: 'XP for next Level', value: xpForNextLevel, inline: true }
                    )
                    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                    .setFooter({ text: 'Crow Control', iconURL: 'attachment://cc_logo.webp' })
                    .setTimestamp();

                // Prepare the message payload
                const messagePayload = {
                    embeds: [levelEmbed],
                    files: [logoFile]
                };

                // if tagUserLevelUpMsg: true, ping the user
                if (settings.tagUserLevelUpMsg) {
                    messagePayload.content = `<@${userId}>  🎉`;
                }

                await xpLogChannel.send(messagePayload);
            }
        }
    }
}

function configureXpRecovery(commandConfig) {
    const store = getXpStore(commandConfig.db);
    store.onAward = async (operation, result) => {
        const client = commandConfig.client;
        let guild = client.guilds.cache.get(operation.guildId);
        if (!guild) {
            try { guild = await client.guilds.fetch(operation.guildId); }
            catch (error) { if (error.code === 10004) return; throw error; }
        }
        let member = guild.members.cache.get(operation.userId);
        if (!member) {
            try { member = await guild.members.fetch(operation.userId); }
            catch (error) { if (error.code === 10007) return; throw error; }
        }
        await finishXpAward(operation, result, guild, member, commandConfig);
    };
    return store;
}

module.exports = { processXp, configureXpRecovery };
