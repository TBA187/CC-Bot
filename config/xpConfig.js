// =============================
// Centralized XP Configuration
// =============================
const path = require('path');

module.exports = {
    // --- XP Embed Images --- TP-DO: PLACE IN BOTTOM AFTER IMPLEMENTED CORRECTLY WITH ACTUAL SERVER IMAGES!
    logoPath: path.join(__dirname, '../images/cc_logo.webp'),
    bannerPath: path.join(__dirname, '../images/cc_banner.webp'),

    // --- Independent XP Toggles ---
    globalEnabled: true,              // Toggle Global XP tracking ON/OFF
    specialTracksEnabled: true,       // Toggle Special XP tracking ON/OFF
    allowGlobalXpWhileSpecial: true,  // If TRUE, special trakcs get Global + Special XP. If FALSE, only Special.

    // Boosted XP Stack Calculation Strategy
    // 'compound' = Multipliers multiply each other (High XP Gain)
    // 'additive' = Combined: Percentages are added together first (Lower/Balanced XP Gain)
    // The difference between Compounding (Multiplicative) and Combining (Additive)
    // multipliers depends entirely on how high percentages are. As the percentages go up,
    // the gap between the two methods grows exponentially. - The Math for 50% for both:
    // Additive: 1 + 0.5 + 0.5 = 2.0x
    // Compounded: 1.5 x 1.5 = 2.25x
    // The compounded version gives an extra 25% of the base XP
    // because the 50% Role Boost is also boosting the 50% Activity Bonus.
    boostStackStrategy: 'additive',

    // --- LEVEL FORMULA CONFIGURATION ---
    levelFormula: {
        type: 'exponential', // Options: 'linear', 'exponential', 'constant (flat)'

        // Multiplier for "Linear, Exponential, and Constant (Flat)" acts as a global difficulty (Higher = Harder to level)
        // If Multiplier is 1: Standard XP requirements for all curves.
        // If Multiplier is 2: Every single level requires double the XP (Hard Mode)
        // If Multiplier is 0.5: Level up twice as fast (Easy Mode)
        multiplier: 1,
        // Multiplier: Min: 0.1 (Lol Mode) | Max: 10 (Forever Grind) | Default: 1

        baseAmount: 75, // Base XP added to calculations. If changed to 75, Level 1 only requires 75 XP.
        // Base Amount: Min: 1 | Max: 5000 | Default: 100 (Controls how much XP is needed for Level 1)
        // Setting to 1 makes the "Early Game" extremely fast, but it doesn't really change the "End Game"

        maxLevel: null   // Set a number (e.g., 100) to cap leveling. Set null for infinite levels.
        // Max Level: Min: 1 | Max: 10,000 | Default: Unlimited
    },

    // --- LEVEL REWARDS (Auto Assign Roles) ---
    // In production, fetch these from `level_rewards` MySQL table
    levelRewards: [
        // Example: { roleId: '1184117095231918101', level: 10 }
    ],

    // --- XP BOOSTERS ---
    // In production, fetch these from `xp_boosters` MySQL table
    boosters: {
        // Boost Percentage: Min: 1% | Max: 500% | Default: 50%
        stackBoosters: true, // TRUE = 50% + 25% = 75% total. FALSE = only takes the highest (50%).
        roles: [
            // {
            //     id: '1180559379171393679',
            //     percentage: 50,
            //     appliesTo: {
            //         messages: true,
            //         reactions: false,
            //         commands: false,
            //         voice: true
            //     }
            // }
        ],
        channels: [
            // Example: { id: '1184117095231918101', percentage: 25, appliesTo: { messages: true, reactions: true, commands: false, voice: false } }
        ],
        users: [
            // Example: { id: '1234567891011', percentage: 100, appliesTo: { messages: true, reactions: true, commands: true, voice: true } }
        ]
    },

    // --- GLOBAL XP TRACK CONFIGURATION ---
    global: {
        // INSTRUCTIONS TO ADD TO THE WEBSITE DASHBOARD:
        // ⚙️ XP Filtering Logic Explained
        // The XP System uses a "Safety-First" hierarchy to decide who earns XP.
        // 🚫 The Master Blacklist (Priority 1)
        // Blacklists always take precedence. If a User, Role, or Channel is added to a Blacklist, XP gain is instantly disabled for those targets.
        // - Role Blacklist: Any user with one of these roles is blocked from earning XP.
        // - Channel Blacklist: No XP can be earned within these channels.
        // - User Blacklist: Specific users who are blocked from the system entirely.
        // Note: If a user is on both a Blacklist and a Whitelist, the Blacklist wins and they will receive 0 XP.
        // ✅ The Master Whitelist (Priority 2)
        // Whitelists act as a "Gatekeeper." If a Whitelist is empty, it is ignored and everyone (who isn't blacklisted) can earn XP.
        // - Role Whitelist: If roles are added here, only users with those roles can earn XP.
        //   - Note: If a blacklisted user have a whitelisted role, they won't get any XP.
        // - Channel Whitelist: If channels are added here, XP can only be earned in those specific locations.
        //   - Note: If a blacklisted user writes in a whitelisted channel, they won't get any XP.
        // - User Whitelist: If users are added here, only those specific individuals can participate in the entire XP system.
        // 💡 The Golden Rule: If a Blacklist trigger exists (User, Role, or Channel), it cancels any Whitelist permission.

        blackListUsers: [],
        blackListChannels: [],
        blackListRoles: [],
        whiteListUsers: [],
        whiteListChannels: [],
        whiteListRoles: [],
        sendLevelUpMsg: false,
        tagUserLevelUpMsg: true,
        color: '#452366',
    },

    // This is fetched from the remote database now!
    // --- SPECIAL XP TRACK CONFIGURATIONS ---
    // Special XP Tracks are independent from the Global XP Track
    // role_only: If roleIds is present and channelIds is empty: Only the role is checked.
    // channel_only: If roleIds is empty and channelIds is present: Only the channel is checked.
    // both_role_channel: If BOTH are present; The user must be in that channel and have that role.
    // specialTracks: [], // Will be populated by loadSpecialTracks()

    // --- XP SOURCES ---
    // Decide exactly HOW users can earn XP.
    sources: {
        textMessages: true, // Earn XP by chatting (regular text messages)
        reactions: true,    // Earn XP by reacting to messages
        commands: true,     // Earn XP by using slash bot commands
        voice: true,        // Earn XP by spending time in voice channels
        publicThreads: true,     // Earn XP in public threads
        privateThreads: true,   // Earn XP in private threads
        forumThreads: true,      // Earn XP in forum channel threads (Forum Posts)
        voiceTextChannels: true, // Earn XP in the text chat of voice channels
    },

    // --- XP YIELDS & XP COOLDOWNS ---
    // The base random XP given per valid action with cooldoowns for every action
    // All "Min value:" and "Max value:" are controlled from the Website Dashboard

    // Messages
    messageXp: {
        min: 15, // Min value: 1  | Default: 15
        max: 25, // Max value: 50 | Default: 25
        cooldownTimer: 60  // Min: 5 sec | Max: 600 (10 minute) | Default: 60 (1 minute)
    },

    // Reactions
    reactionXp: {
        min: 5,  // Min value: 1  | Default: 5
        max: 10, // Max value: 25 | Default: 10
        cooldownTimer: 120 // Min: 10 sec | Max: 3600 (1 hour) | Default: 120 (2 minutes)
    },

    // Commands
    commandXp: {
        min: 3, // Min value: 1  | Default: 3
        max: 7, // Max value: 25 | Default: 7
        cooldownTimer: 180 // Min: 10 sec | Max: 3600 (1 hour) | Default: 180 (3 minutes)
    },

    // Voice XP is calculated differently since it's based on time spent
    voiceXp: {
        xpPerMinuteMin: 5,    // Min value: 1  | Default: 5
        xpPerMinuteMax: 10,   // Max value: 25 | Default: 10
        minTimeForXp: 60,     // Min: 60 (1 min) | Max: 600 (10 min) | Default: 60 (1 min)

        // Voice Activity BONUSES (in percentage %)
        bonusMultipliers: {
            streaming: 50, // +50% XP Bonus for Screen Sharing
            camera: 50     // +50% XP Bonus for Camera On
        },

        // Deafen (Headphones & Mic): Cannot hear others, and vice versa. Microphone gets auto muted as well.
        ignoreSelfDeafened: true,   // User Deafened themselves (Headset off icon) -> ignore them to prevent XP afk farming.
        ignoreServerDeafened: true, // Moderator deafened the user -> Don't award XP!

        // Mute (Microphone): User can hear others, but they cannot hear user.
        ignoreSelfMuted: false,     // User muted themselves. Default false to allow listeners & Push-to-Talk users.
        ignoreServerMuted: true     // Moderator muted the user or they were moved to AFK channel -> Don't award XP!
    },

    // --- TEXT MESSAGE BONUSES (Only for TEXT messages!) ---
    // Attachments Bonus (Images/Videos)
    imageBonusXp: {
        enabled: true,
        min: 10,   // Min XP per images included in message
        max: 20,   // Max XP per images included in message
        maxImagesRewarded: 3  // Cap the bonus (only reward first 3 images in one message)
        // Discord allows max 10 images per message. Min: 1 | Max: 10 | Default: 3
    },

    // Message Length Bonus
    lengthBonusXp: {
        // -----
        enabled: true,

        // Stacking Option:
        // If TRUE: Length Bonus XP is added ON TOP of the standard random text message XP. (Base + Bonus)
        // If FALSE: Length XP REPLACES the standard random text message XP entirely. (Only length matters)
        stackWithBaseXp: true,

        // Calculation Method:
        // Toggle between counting by 'words' or 'chars' (characters).
        calculationMethod: 'words',

        // Toggle if spaces/whitespace should count towards the length
        // If TRUE: "A B" is 2 words/chars (spaces are ignored).
        // If FALSE: "A B" is 3 words/chars (spaces are counted).
        ignoreSpaces: true,

        // Thresholds: How many words/characters are needed to trigger ONE interval of XP
        wordsRequired: 5, // wordsRequired: 5 -> grants XP per 5 words written (if 'words' is selected)
        charsRequired: 10, // charsRequired: 10 -> grants XP per 10 chars written (if 'chars' is selected)
        xpPerIntervalMin: 1, // Minimum random XP granted per interval of words/chars
        xpPerIntervalMax: 3, // Maximum random XP granted per interval of words/chars

        // minBonus: Fallback XP if length-requirements aren't met in 'standalone' length bonus mode.
        // minBonus: Fallback XP if xpGained is 0 (e.g., message too short in "Length Only" mode), 
        minBonus: 5, // Set to null or 0 to give 0 XP for short messages.

        // Max Bonus is a hard cap on the BONUS amount to prevent people from pasting essays to farm XP
        // Example: If charsRequired is 10, and someone pastes a 2,000-character essay, 
        // they would trigger 200 intervals. If xpPerInterval is 2, they'd get 400 XP!
        // maxBonus stops this. If maxBonus is 20, the loop stops giving bonus XP 
        // once the bonus reaches 20, preventing people from farming XP with spam.
        // If you want to encourage quality discussion, try setting it to 50.
        // Example Breakdown (Based on 20 Avg Base XP, 2 Bonus XP per interval & 50 Max Bonus Cap):
        // 1. Small Message   (10 chars): ~20 XP (Base) + 2 XP (Bonus) = 22 XP Total
        // 2. Medium Message (150 chars): ~20 XP (Base) + 30 XP (Bonus) = 50 XP Total
        // 3. Large Message (300+ chars): ~20 XP (Base) + 50 XP (Cap) = 70 XP Total
        // NOTE: A "Max Effort" post (70 XP) is worth exactly 3.5x a standard message
        maxBonus: 20
    },
};
