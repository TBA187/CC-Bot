// Build role panels. Handles self-service role selections and color previews.
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionsBitField,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const botConfig = require('../config.json');
const { SERVERS, selectionFeedback } = require('../features/pvp-scouting/ScoutServerSettings.js');
const { rolePanelReason } = require('../utils/roleAuditSource.js');


// AUTO ROLES - INTERNAL CONFIG TYPES
const SUPPORTED_AUTO_ROLE_MODES = new Set(['buttons', 'dropdown', 'reactions', 'color_roles']);
const CUSTOM_ID_PREFIX = 'cc:auto_roles';
const COMPONENT_PREFIXES = [CUSTOM_ID_PREFIX, 'ww:auto_roles'];
const COLOR_ROLE_PRESET_PAGE_SIZE = 25;
const CUSTOM_COLOR_ROLE_ANCHOR_ID = botConfig.customColorRoleAnchorID;
const COLOR_ROLE_PANEL_PAGE = 0;
const COLOR_ROLE_PREVIEW_FILENAME = 'role-color-preview.png';
const COLOR_PREVIEW_MAX_AGE_MS = 14 * 60 * 1000;
const ACTIVE_COLOR_PREVIEWS = new Map();

const COLOR_ROLE_PRESETS = [
    { id: 'sunset', roleId: '1520956112160166088', name: 'Sunset Gradient', emoji: '🌇', primary: '#FF512F', secondary: '#DD2476' },
    { id: 'aurora', roleId: '1520956117319028776', name: 'Aurora Gradient', emoji: '🌌', primary: '#00C9FF', secondary: '#92FE9D' },
    { id: 'cyber', roleId: '1520956123308363877', name: 'Cyber Gradient', emoji: '🧬', primary: '#00F5A0', secondary: '#00D9F5' },
    { id: 'royal', roleId: '1520956128283066540', name: 'Royal Gradient', emoji: '👑', primary: '#7F00FF', secondary: '#E100FF' },
    { id: 'ember', roleId: '1520956134779785276', name: 'Ember Gradient', emoji: '🔥', primary: '#F97316', secondary: '#EF4444' },
    { id: 'ocean', roleId: '1520956140547215502', name: 'Ocean Gradient', emoji: '🌊', primary: '#2563EB', secondary: '#06B6D4' },
    { id: 'midnight', roleId: '1520956145697558538', name: 'Midnight Gradient', emoji: '🌙', primary: '#312E81', secondary: '#111827' },
    { id: 'atlantic_ocean', roleId: '1423740475105345627', name: 'Atlantic Ocean Gradient', emoji: '🌊', primary: '#0EA5E9', secondary: '#1E3A8A' },
    { id: 'forest', roleId: '1423748889357455462', name: 'Forest Gradient', emoji: '🌲', primary: '#166534', secondary: '#22C55E' },
    { id: 'blood_moon', roleId: '1423755559416631517', name: 'Blood Moon Gradient', emoji: '🌕', primary: '#7F1D1D', secondary: '#DC2626' },
    { id: 'safari', roleId: '1423765274208899112', name: 'Safari Gradient', emoji: '🦁', primary: '#C2B280', secondary: '#6B8E23' },
    { id: 'sunburst', roleId: '1423766179608264814', name: 'Sunburst Gradient', emoji: '☀️', primary: '#FDE047', secondary: '#F97316' },
    { id: 'seafoam_green', roleId: '1423766217058942976', name: 'Seafoam Green Gradient', emoji: '🐚', primary: '#2DD4BF', secondary: '#A7F3D0' },
    { id: 'imperial_blue', roleId: '1423766245420826695', name: 'Imperial Blue Gradient', emoji: '🔵', primary: '#1D4ED8', secondary: '#312E81' },
    { id: 'ice', roleId: '1520956107647090820', name: 'Ice', emoji: '🧊', primary: '#7DD3FC' },
    { id: 'amethyst', roleId: '1520956101494046781', name: 'Amethyst', emoji: '💜', primary: '#9B59B6' },
    { id: 'violet', roleId: '1423754358712958979', name: 'Violet', emoji: '🟣', primary: '#8B5CF6' },
    { id: 'pink', roleId: '1423758108609482812', name: 'Pink', emoji: '🌸', primary: '#FF69B4' },
    { id: 'sakura', roleId: '1520956084129366096', name: 'Sakura', emoji: '🌸', primary: '#FF7AB6' },
    { id: 'rose', roleId: '1520956097672777758', name: 'Rose', emoji: '🌹', primary: '#ED4245' },
    { id: 'ember_orange', roleId: '1423766170095583302', name: 'Ember Orange', emoji: '🔥', primary: '#F97316' },
    { id: 'golden_blaze', roleId: '1423766435301298326', name: 'Golden Blaze', emoji: '🏆', primary: '#f1c40f' },
    { id: 'blurple', roleId: '1520956079440400485', name: 'Blurple', emoji: '🟦', primary: '#5865F2' },
    { id: 'mint', roleId: '1520956088751489074', name: 'Mint', emoji: '🟩', primary: '#57F287' },
    { id: 'olive_green', roleId: '1423766207764496394', name: 'Olive Green', emoji: '🫒', primary: '#90be6d' }
];

const COLOR_NAME_HEX = {
    aqua: '#1ABC9C',
    cyan: '#1ABC9C',
    green: '#57F287',
    blue: '#3498DB',
    yellow: '#FEE75C',
    purple: '#9B59B6',
    pink: '#EB459E',
    fuchsia: '#EB459E',
    gold: '#F1C40F',
    orange: '#E67E22',
    red: '#ED4245',
    grey: '#95A5A6',
    gray: '#95A5A6',
    navy: '#34495E',
    white: '#FFFFFF',
    black: '#000000',
    blurple: '#5865F2',
    mint: '#57F287',
    rose: '#ED4245',
    amber: '#FEE75C',
    amethyst: '#9B59B6',
    ice: '#7DD3FC',
    darkaqua: '#11806A',
    darkcyan: '#11806A',
    darkgreen: '#1F8B4C',
    darkblue: '#206694',
    darkpurple: '#71368A',
    darkpink: '#AD1457',
    darkgold: '#C27C0E',
    darkorange: '#A84300',
    darkred: '#992D22',
    darkgrey: '#979C9F',
    darkgray: '#979C9F',
    lightgrey: '#BCC0C0',
    lightgray: '#BCC0C0',
    darknavy: '#2C3E50',
    greyple: '#99AAB5',
    grayple: '#99AAB5',
    notquiteblack: '#23272A',
    atlantic: '#0EA5E9',
    atlanticocean: '#0EA5E9',
    forest: '#166534',
    violet: '#8B5CF6',
    bloodmoon: '#7F1D1D',
    safari: '#C2B280',
    emberorange: '#F97316',
    sunburst: '#FDE047',
    goldenblaze: '#F59E0B',
    olive: '#808000',
    olivegreen: '#808000',
    seafoam: '#2DD4BF',
    seafoamgreen: '#2DD4BF',
    imperial: '#1D4ED8',
    imperialblue: '#1D4ED8'
};


function autoRoleChoiceConfig({
    key,
    label,
    roleId,
    emojiName = null,
    emojiId = null,
    unicodeEmoji = null,
    buttonStyle = ButtonStyle.Success,
    row = 0
}) {
    return {
        key,
        label,
        roleId,
        emojiName,
        emojiId,
        unicodeEmoji,
        buttonStyle,
        row,
        get emoji() {
            if (emojiId !== null && emojiName !== null) {
                return `<:${emojiName}:${emojiId}>`;
            }
            return unicodeEmoji;
        }
    };
}


function autoRolePanelConfig({
    key,
    name,
    active,
    mode,
    allowMultiple,
    defaultChannelId,
    title,
    titleUrl,
    description,
    colorHex,
    imagePath,
    imageFilename,
    imageFooterPath,
    imageFooterFilename,
    footerText,
    messageText,
    dropdownPlaceholder,
    roles,
    // Optional Author (Only add "author" fields to a panel when the author field should be shown)
    authorName = null,
    authorIconUrl = null,
    authorUrl = null
}) {
    return {
        key,
        name,
        active,
        mode,
        allowMultiple,
        defaultChannelId,
        title,
        titleUrl,
        description,
        colorHex,
        imagePath,
        imageFilename,
        imageFooterPath,
        imageFooterFilename,
        footerText,
        messageText,
        dropdownPlaceholder,
        roles,
        authorName,
        authorIconUrl,
        authorUrl,
        get safeMode() {
            const safeMode = mode.trim().toLowerCase();
            if (!SUPPORTED_AUTO_ROLE_MODES.has(safeMode)) {
                return 'buttons';
            }
            return safeMode;
        },
        get colorValue() {
            return Number.parseInt(colorHex.trim().replace(/^#/, ''), 16);
        },
        customIdForRole(roleKey) {
            return `${CUSTOM_ID_PREFIX}:${key}:button:${roleKey}`;
        },
        get selectCustomId() {
            return `${CUSTOM_ID_PREFIX}:${key}:select`;
        }
    };
}


// =============================================================================
// AUTO ROLE PANELS
//
// To make a new panel:
// 1. Copy only the block between "AUTO ROLE PANEL: Region Roles" and "AUTO ROLE PANEL END!".
// 2. Paste it below the existing panel.
// 3. Change the variable name, key, name, embed text, roles, etc.
// 4. Add the new variable name to "AUTO_ROLE_PANELS" below.
// 5. Use the '/auto_roles_send' command to select the panel you created and post it in a channel.
//
// =============================================================================
// AUTO ROLE PANEL: Region Roles
// =============================================================================
const REGION_ROLES_PANEL = autoRolePanelConfig({
    key: 'region_roles',
    name: 'Region Roles',
    active: true,
    mode: 'dropdown',
    allowMultiple: false,
    defaultChannelId: null,
    title: 'Region Roles',
    titleUrl: botConfig.brandingImageURL,
    description:
        '### Please select your region from the dropdown menu\n' +
        'This way we can see where CC Members are playing from <:man_of_culture:1186287184106496112>',
    colorHex: '#452366',
    imagePath: 'images/world_globe.png',
    imageFilename: 'world_globe.png',
    imageFooterPath: 'images/cc_logo.webp',
    imageFooterFilename: 'cc_logo.webp',
    footerText: 'Crow Control Discord Roles',
    messageText: null,
    dropdownPlaceholder: 'Select your Region here!',
    roles: [
        autoRoleChoiceConfig({
            key: 'europe',
            label: 'Europe',
            roleId: '1520931401577533603',
            unicodeEmoji: '🏰'
        }),
        autoRoleChoiceConfig({
            key: 'north_america',
            label: 'North America',
            roleId: '1520931563444113629',
            unicodeEmoji: '🗽'
        }),
        autoRoleChoiceConfig({
            key: 'south_america',
            label: 'South America',
            roleId: '1520931622348914848',
            unicodeEmoji: '🦜'
        }),
        autoRoleChoiceConfig({
            key: 'middle_east',
            label: 'Middle East',
            roleId: '1520931645987750073',
            unicodeEmoji: '🕌'
        }),
        autoRoleChoiceConfig({
            key: 'africa',
            label: 'Africa',
            roleId: '1520931702107541577',
            unicodeEmoji: '🦁'
        }),
        autoRoleChoiceConfig({
            key: 'central_asia',
            label: 'Central Asia',
            roleId: '1520931875332423870',
            unicodeEmoji: '🏔️'
        }),
        autoRoleChoiceConfig({
            key: 'south_asia',
            label: 'South Asia',
            roleId: '1520931963874312407',
            unicodeEmoji: '🪷'
        }),
        autoRoleChoiceConfig({
            key: 'southeast_asia',
            label: 'South-east Asia',
            roleId: '1520932030618140936',
            unicodeEmoji: '🌴'
        }),
        autoRoleChoiceConfig({
            key: 'east_asia',
            label: 'East Asia',
            roleId: '1520932076390449192',
            unicodeEmoji: '🏯'
        }),
        autoRoleChoiceConfig({
            key: 'central_america_caribbean',
            label: 'Central America & Caribbean',
            roleId: '1520932133613604937',
            unicodeEmoji: '🏝️'
        }),
        autoRoleChoiceConfig({
            key: 'australia_oceania',
            label: 'Australia & Oceania',
            roleId: '1520932452682436748',
            unicodeEmoji: '🦘'
        })
    ]
});
// =============================================================================
// AUTO ROLE PANEL: Region Server Roles - END!
// =============================================================================


// =============================================================================
// AUTO ROLE PANEL: Guild Roles
// =============================================================================
const GUILD_ROLES_PANEL = autoRolePanelConfig({
    key: 'guild_roles',
    name: 'Guild Roles',
    active: true,
    mode: 'buttons',
    allowMultiple: true,
    defaultChannelId: null,
    title: 'Crow Control Guild Roles',
    titleUrl: botConfig.brandingImageURL,
    description:
        '**Choose your Guild Roles by clicking the buttons below.**\nYou can select multiple roles.\n' +
        'To remove a role, simply click the button corresponding to the role you want to remove.\n' +
        '-# - Select **PvP ⚔️** if you are interested in PvP-related content.\n' +
        '-# - Select **Dungeon 🧙‍♂️** to be pinged for Dungeon runs.\n' +
        '-# - Select **Level / EV ✨** to be pinged for service requests.\n' +
        '-# - Select **Dex Service 🤝** to be pinged for service requests.\n' +
        '-# - Select **PRO Notifications 🔔** to receive notifications about useful game information, updates, and upcoming events.\n' +
        '-# - Select **Stream 🔔** to be pinged when someone from the Guild streams. You can also ping this role when you go live.\n' +
        '-# - Select your **Server Roles**. <@1470242342383521943> will remember your **Server** choice and use it for future commands.',
    colorHex: '#452366',
    imagePath: 'images/cc_logo.webp',
    imageFilename: 'cc_logo.webp',
    imageFooterPath: 'images/cc_logo.webp',
    imageFooterFilename: 'cc_logo.webp',
    footerText: 'Crow Control Discord Roles',
    messageText: null,
    dropdownPlaceholder: null,
    roles: [
        autoRoleChoiceConfig({
            key: 'pvp',
            label: 'PvP',
            roleId: '1180559388256239677',
            unicodeEmoji: '⚔',
            buttonStyle: ButtonStyle.Success,
            row: 0
        }),
        autoRoleChoiceConfig({
            key: 'dungeon',
            label: 'Dungeon',
            roleId: '1184113333482299522',
            unicodeEmoji: '🧙‍♂️',
            buttonStyle: ButtonStyle.Success,
            row: 0
        }),
        autoRoleChoiceConfig({
            key: 'hunter',
            label: 'Hunter',
            roleId: '1180559383432810517',
            unicodeEmoji: '💎',
            buttonStyle: ButtonStyle.Success,
            row: 0
        }),
        autoRoleChoiceConfig({
            key: 'level_ev_trainer',
            label: 'Level / EV Trainer',
            roleId: '1180763923297882212',
            unicodeEmoji: '✨',
            buttonStyle: ButtonStyle.Success,
            row: 0
        }),
        autoRoleChoiceConfig({
            key: 'dex_service',
            label: 'Dex Service',
            roleId: '1390042564174024815',
            unicodeEmoji: '🤝',
            buttonStyle: ButtonStyle.Success,
            row: 0
        }),
        autoRoleChoiceConfig({
            key: 'gold',
            label: 'Gold',
            roleId: botConfig.goldRoleID,
            emojiName: SERVERS.gold.emoji.name,
            emojiId: SERVERS.gold.emoji.id,
            buttonStyle: ButtonStyle.Primary,
            row: 1
        }),
        autoRoleChoiceConfig({
            key: 'silver',
            label: 'Silver',
            roleId: botConfig.silverRoleID,
            emojiName: SERVERS.silver.emoji.name,
            emojiId: SERVERS.silver.emoji.id,
            buttonStyle: ButtonStyle.Primary,
            row: 1
        }),
        autoRoleChoiceConfig({
            key: 'cross',
            label: 'Cross Server',
            roleId: null,
            unicodeEmoji: SERVERS.cross.emoji,
            buttonStyle: ButtonStyle.Primary,
            row: 1
        }),
        autoRoleChoiceConfig({
            key: 'pro_notifications',
            label: 'PRO Notifications',
            roleId: '1537991574162640906',
            unicodeEmoji: '🔔',
            buttonStyle: ButtonStyle.Secondary,
            row: 1
        }),
        autoRoleChoiceConfig({
            key: 'stream',
            label: 'Stream',
            roleId: '1368716918420148314',
            unicodeEmoji: '🔔',
            buttonStyle: ButtonStyle.Secondary,
            row: 1
        })
    ]
});
// =============================================================================
// AUTO ROLE PANEL END!
// =============================================================================


// =============================================================================
// AUTO ROLE PANEL: Color Roles
// =============================================================================
const COLOR_ROLES_PANEL = autoRolePanelConfig({
    key: 'color_roles',
    name: 'Color Roles',
    active: true,
    mode: 'color_roles',
    allowMultiple: false,
    defaultChannelId: null,
    title: 'Choose your personal display color',
    titleUrl: botConfig.brandingImageURL,
    description:
        '**You can change your name color in 3 different ways:**\n' +
        '- Pick a **preset color** (solid or gradient) from the dropdown\n' +
        '- Generate a **random** solid or gradient color\n' +
        '- Enter your own **custom** solid or gradient color:\n' +
        '  - **Custom Color** accepts one color like `blue` or `#5865F2`.\n' +
        '  - **Custom Gradient** accepts two colors like `dark red` and `purple`, or `#FF512F` and `#DD2476`.\n' +
        '  - -# Your personal color role will be named after your username.\n' +
        'When you have selected a color, you will see a preview of the color.\n' +
        'Press **Confirm** after previewing to update your personal color.',
    colorHex: '#5865F2',
    imagePath: 'images/cc_logo.webp',
    imageFilename: 'cc_logo.webp',
    imageFooterPath: 'images/cc_logo.webp',
    imageFooterFilename: 'cc_logo.webp',
    footerText: 'Crow Control Discord Roles',
    messageText: null,
    dropdownPlaceholder: 'Select preset colors here!',
    roles: []
});
// =============================================================================
// AUTO ROLE PANEL END!
// =============================================================================


const AUTO_ROLE_PANELS = [
    REGION_ROLES_PANEL,
    GUILD_ROLES_PANEL,
    COLOR_ROLES_PANEL
];


// ===============
// INTERNAL LOGIC
// ===============


function getAllAutoRolePanels() {
    return AUTO_ROLE_PANELS;
}


function getActiveAutoRolePanels() {
    return AUTO_ROLE_PANELS.filter(panel => panel.active);
}


function findAutoRolePanel(value) {
    const normalized = value.trim().toLowerCase();
    return AUTO_ROLE_PANELS.find(panel =>
        panel.key.toLowerCase() === normalized || panel.name.toLowerCase() === normalized
    ) ?? null;
}


async function autoRolePanelAutocomplete(interaction) {
    const current = interaction.options.getFocused();
    const currentLower = current.trim().toLowerCase();
    let panels = getActiveAutoRolePanels();

    if (currentLower) {
        panels = panels.filter(panel =>
            panel.name.toLowerCase().includes(currentLower) ||
            panel.key.toLowerCase().includes(currentLower)
        );
    }

    return interaction.respond(
        panels.slice(0, 25).map(panel => ({
            name: panel.name.slice(0, 100),
            value: panel.key.slice(0, 100)
        }))
    );
}


function buildAutoRoleEmbed(panel) {
    const embed = new EmbedBuilder()
        .setTitle(panel.title)
        .setDescription(panel.description)
        .setColor(panel.colorValue);

    if (panel.titleUrl) {
        embed.setURL(panel.titleUrl);
    }

    if (panel.authorName) {
        embed.setAuthor({
            name: panel.authorName,
            iconURL: panel.authorIconUrl,
            url: panel.authorUrl
        });
    }

    embed.setThumbnail(`attachment://${panel.imageFilename}`);
    embed.setFooter({ text: panel.footerText, iconURL: `attachment://${panel.imageFooterFilename}` });
    return embed;
}


function buildAutoRoleFiles(panel) {
    const fileConfigs = [
        { filePath: panel.imagePath, filename: panel.imageFilename },
        { filePath: panel.imageFooterPath, filename: panel.imageFooterFilename }
    ];
    const seenFilenames = new Set();
    const files = [];

    for (const fileConfig of fileConfigs) {
        if (seenFilenames.has(fileConfig.filename)) continue;
        seenFilenames.add(fileConfig.filename);

        const fullPath = path.join(__dirname, '..', fileConfig.filePath);
        if (!fs.existsSync(fullPath)) {
            const err = new Error(`Could not find ${fileConfig.filePath}`);
            err.code = 'ENOENT';
            err.filePath = fileConfig.filePath;
            throw err;
        }

        files.push(new AttachmentBuilder(fullPath, { name: fileConfig.filename }));
    }

    return files;
}


async function sendHiddenFeedback(interaction, content) {
    const payload = {
        content,
        allowedMentions: { parse: [] }
    };

    if (interaction.deferred) {
        await interaction.editReply(payload);
        return;
    }

    if (interaction.replied) {
        await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}


async function deferHidden(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
}


async function deferPreviewUpdate(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
    }
}


function colorPreviewKey(interaction) {
    return `${interaction.guildId ?? 'dm'}:${interaction.user.id}`;
}


async function deletePreviousColorPreview(interaction) {
    const key = colorPreviewKey(interaction);
    const previous = ACTIVE_COLOR_PREVIEWS.get(key);
    if (!previous) return;

    ACTIVE_COLOR_PREVIEWS.delete(key);
    if (Date.now() - previous.createdAt > COLOR_PREVIEW_MAX_AGE_MS) return;

    await previous.cleanup().catch(() => { });
}


function rememberColorPreview(interaction, cleanup) {
    ACTIVE_COLOR_PREVIEWS.set(colorPreviewKey(interaction), {
        cleanup,
        createdAt: Date.now()
    });
}


function forgetColorPreview(interaction) {
    ACTIVE_COLOR_PREVIEWS.delete(colorPreviewKey(interaction));
}


async function editPreviewFeedback(interaction, content) {
    const payload = {
        content,
        embeds: [],
        components: [],
        files: [],
        attachments: [],
        allowedMentions: { parse: [] }
    };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.update(payload);
    }

    forgetColorPreview(interaction);
}


async function memberFromInteraction(interaction) {
    if (interaction.member?.roles?.cache) {
        return interaction.member;
    }

    if (!interaction.guild) {
        return null;
    }

    try {
        return await interaction.guild.members.fetch(interaction.user.id);
    } catch {
        return null;
    }
}


function getConfiguredRole(guild, choice) {
    return guild.roles.cache.get(choice.roleId) ?? null;
}


async function manageableRoleError(guild, role) {
    if (role.id === botConfig.ccRoleID) return 'The Crow Control role is managed automatically by your CC Server Tag. Equip or remove the tag to change this role.';
    const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
    if (me === null) {
        return 'Bot role setup is incomplete.';
    }

    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return 'The bot needs **Manage Roles** to update roles.';
    }

    if (role.comparePositionTo(me.roles.highest) >= 0) {
        return `The bot role must be higher than ${role} before this role can be managed.`;
    }

    return null;
}


function hasEnhancedRoleColors(guild) {
    return guild.features?.includes?.('ENHANCED_ROLE_COLORS') ?? false;
}


function normalizeHex(input) {
    const raw = input?.trim().replace(/^#/, '').toUpperCase();
    if (!raw || !/^[0-9A-F]{6}$/.test(raw)) {
        return null;
    }

    return `#${raw}`;
}


function colorNameKey(input) {
    return input?.trim().toLowerCase().replace(/[\s_-]+/g, '') ?? '';
}


function normalizeColorInput(input) {
    const hex = normalizeHex(input);
    if (hex) {
        return hex;
    }

    return COLOR_NAME_HEX[colorNameKey(input)] ?? null;
}


function colorIdPart(hex) {
    return hex.replace(/^#/, '').toUpperCase();
}


function colorFromIdPart(value) {
    return normalizeHex(value);
}


function getPresetById(presetId) {
    return COLOR_ROLE_PRESETS.find(preset => preset.id === presetId) ?? null;
}


function presetToStyle(preset) {
    return {
        kind: 'preset',
        presetId: preset.id,
        name: preset.name,
        emoji: preset.emoji,
        primary: preset.primary,
        secondary: preset.secondary ?? null
    };
}


function customStyle(type, primary, secondary = null) {
    return {
        kind: 'custom',
        presetId: null,
        name: type === 'gradient' ? 'Custom Gradient' : 'Custom Color',
        emoji: type === 'gradient' ? '🌈' : '🎨',
        primary,
        secondary
    };
}


function randomStyle(type, primary, secondary = null) {
    return {
        ...customStyle(type, primary, secondary),
        randomGenerated: true,
        name: type === 'gradient' ? 'Random Gradient' : 'Random Color'
    };
}


function isGradientStyle(style) {
    return Boolean(style.secondary);
}


function styleType(style) {
    return isGradientStyle(style) ? 'gradient' : 'solid';
}


function styleText(style) {
    return isGradientStyle(style)
        ? `${style.primary} → ${style.secondary}`
        : style.primary;
}


function parseApplyStyle(args) {
    const [type, primaryRaw, secondaryRaw] = args;
    if (type === 'preset') {
        const preset = getPresetById(primaryRaw);
        return preset ? presetToStyle(preset) : null;
    }

    const primary = colorFromIdPart(primaryRaw);
    if (!primary) return null;

    if (type === 'solid') {
        return customStyle('solid', primary);
    }

    if (type === 'gradient') {
        const secondary = colorFromIdPart(secondaryRaw);
        if (!secondary) return null;
        return customStyle('gradient', primary, secondary);
    }

    return null;
}


function randomHexColor() {
    return `#${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0').toUpperCase()}`;
}


function getRandomSolidStyle() {
    return randomStyle('solid', randomHexColor());
}


function getRandomGradientStyle() {
    let primary = randomHexColor();
    let secondary = randomHexColor();
    while (secondary === primary) {
        secondary = randomHexColor();
    }

    return randomStyle('gradient', primary, secondary);
}


function getConfiguredColorPresets() {
    return COLOR_ROLE_PRESETS.filter(preset => Boolean(preset.roleId));
}


function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


async function makeColorPreviewPng(style) {
    const width = 900;
    const height = 360;
    const fill = isGradientStyle(style)
        ? 'url(#roleGradient)'
        : style.primary;
    const gradient = isGradientStyle(style)
        ? `<defs><linearGradient id="roleGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="${style.primary}"/><stop offset="100%" stop-color="${style.secondary}"/></linearGradient></defs>`
        : '';
    const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${gradient}
  <rect width="${width}" height="${height}" fill="#111827"/>
  <rect x="60" y="60" width="780" height="185" rx="36" fill="${fill}"/>
  <text x="450" y="292" fill="#F9FAFB" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700">${escapeSvgText(styleText(style))}</text>
</svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
}


function buildApplyCustomId(style) {
    if (style.kind === 'preset' && style.presetId) {
        return `${CUSTOM_ID_PREFIX}:color_roles:apply:preset:${style.presetId}:none`;
    }

    return `${CUSTOM_ID_PREFIX}:color_roles:apply:${styleType(style)}:${colorIdPart(style.primary)}:${style.secondary ? colorIdPart(style.secondary) : 'none'}`;
}


function getColorPanelPageFromMessage(message) {
    for (const row of message?.components ?? []) {
        for (const component of row.components ?? []) {
            const match = component.customId?.match(/^(?:cc|ww):auto_roles:color_roles:select:(\d+)$/);
            if (match) {
                return Number(match[1]) || COLOR_ROLE_PANEL_PAGE;
            }
        }
    }

    return COLOR_ROLE_PANEL_PAGE;
}


function getColorPanelSourceFromInteraction(interaction, page = getColorPanelPageFromMessage(interaction.message)) {
    if (!interaction.message?.id || !interaction.channelId) {
        return null;
    }

    return {
        page,
        channelId: interaction.channelId,
        messageId: interaction.message.id
    };
}


function encodeColorPanelSource(source) {
    if (!source?.channelId || !source?.messageId) {
        return '';
    }

    return `:${source.page ?? COLOR_ROLE_PANEL_PAGE}:${source.channelId}:${source.messageId}`;
}


function parseColorPanelSource(parts) {
    const [pageRaw, channelId, messageId] = parts;
    if (!/^\d{17,20}$/.test(channelId ?? '') || !/^\d{17,20}$/.test(messageId ?? '')) {
        return null;
    }

    return {
        page: Number(pageRaw) || COLOR_ROLE_PANEL_PAGE,
        channelId,
        messageId
    };
}


function colorPanelUrl(source, interaction) {
    if (!source?.channelId || !source?.messageId || !interaction.guildId) {
        return null;
    }

    return `https://discord.com/channels/${interaction.guildId}/${source.channelId}/${source.messageId}`;
}


async function refreshColorRolePanelMessage(message, page = COLOR_ROLE_PANEL_PAGE) {
    if (!message?.edit) {
        return;
    }

    await message.edit({ components: buildColorRoleComponents(page) }).catch(err => {
        console.warn('[CC LOG] Could not refresh Color Roles panel components:', err);
    });
}


function buildPreviewComponents(style, source, interaction) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildApplyCustomId(style))
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success)
    );

    const url = colorPanelUrl(source, interaction);
    if (url) {
        row.addComponents(
            new ButtonBuilder()
                .setLabel('Back to Color Roles')
                .setStyle(ButtonStyle.Link)
                .setURL(url)
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:dismiss`)
            .setLabel('Close Preview')
            .setStyle(ButtonStyle.Danger)
    );

    return [row];
}


async function dismissHiddenPreview(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
    }

    forgetColorPreview(interaction);

    try {
        await interaction.deleteReply();
    } catch (err) {
        await interaction.editReply({
            content: 'Preview closed.',
            embeds: [],
            components: [],
            attachments: []
        }).catch(fallbackErr => {
            console.warn('[CC LOG] Could not dismiss color preview:', fallbackErr);
        });
    }
}


async function sendColorPreview(interaction, style, source = null) {
    if (isGradientStyle(style) && interaction.guild && !hasEnhancedRoleColors(interaction.guild)) {
        await sendHiddenFeedback(interaction, '### ❌ Gradient colors are not available on this server.');
        return;
    }

    // Removing the previous preview and rendering the PNG can both take time.
    // Reserve the private response before either operation starts.
    await deferHidden(interaction);
    await deletePreviousColorPreview(interaction);

    const previewPng = await makeColorPreviewPng(style);
    const attachment = new AttachmentBuilder(previewPng, { name: COLOR_ROLE_PREVIEW_FILENAME });
    const content = style.randomGenerated
        ? `### <@${interaction.user.id}>, please confirm that you want to use this randomly generated color:\n**💻  ${style.name}** (${styleText(style)})`
        : `### <@${interaction.user.id}>, please confirm that you want to use this color:\n**${style.emoji ?? '🎨'}  ${style.name}** (${styleText(style)})`;
    const payload = {
        content,
        files: [attachment],
        components: buildPreviewComponents(style, source, interaction),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { users: [interaction.user.id] }
    };

    if (interaction.deferred) {
        await interaction.editReply(payload);
        rememberColorPreview(interaction, () => interaction.deleteReply());
        return;
    }

    if (interaction.replied) {
        const message = await interaction.followUp(payload);
        rememberColorPreview(interaction, () => interaction.webhook.deleteMessage(message.id));
        return;
    }

    await interaction.reply(payload);
    rememberColorPreview(interaction, () => interaction.deleteReply());
}


function buildSolidColorModal(source = null) {
    const modal = new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:modal_submit:solid${encodeColorPanelSource(source)}`)
        .setTitle('Custom Solid Color');

    const hexInput = new TextInputBuilder()
        .setCustomId('hex_color')
        .setLabel('Color name or hex code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('blue or #5865F2')
        .setRequired(true)
        .setMaxLength(32);

    modal.addComponents(new ActionRowBuilder().addComponents(hexInput));
    return modal;
}


function buildGradientColorModal(source = null) {
    const modal = new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:modal_submit:gradient${encodeColorPanelSource(source)}`)
        .setTitle('Custom Gradient Color');

    const startInput = new TextInputBuilder()
        .setCustomId('start_color')
        .setLabel('Start-color name or hex code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('red or #FF512F')
        .setRequired(true)
        .setMaxLength(32);

    const endInput = new TextInputBuilder()
        .setCustomId('end_color')
        .setLabel('End-color name or hex code')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('purple or #DD2476')
        .setRequired(true)
        .setMaxLength(32);

    modal.addComponents(
        new ActionRowBuilder().addComponents(startInput),
        new ActionRowBuilder().addComponents(endInput)
    );
    return modal;
}


async function fetchRoleById(guild, roleId) {
    if (!roleId) return null;
    return guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
}


async function getBotMember(guild) {
    return guild.members.me ?? await guild.members.fetchMe().catch(() => null);
}


async function maybePositionRoleUnderAnchor(guild, role, anchorRoleId, anchorLabel) {
    const me = await getBotMember(guild);
    if (me === null) {
        console.warn(`[CC LOG] Could not fetch bot member while positioning ${role.name}.`);
        return false;
    }

    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        console.warn(`[CC LOG] Bot is missing Manage Roles; cannot position ${role.name}.`);
        return false;
    }

    const anchorRole = await fetchRoleById(guild, anchorRoleId);
    if (anchorRole === null) {
        console.warn(`[CC LOG] ${anchorLabel} role not found: ${anchorRoleId}`);
        return false;
    }

    if (anchorRole.comparePositionTo(me.roles.highest) >= 0) {
        console.warn(`[CC LOG] Bot role must be above the ${anchorLabel} role.`);
        return false;
    }

    if (role.comparePositionTo(me.roles.highest) >= 0) {
        console.warn(`[CC LOG] Bot role must be above ${role.name} before it can move it.`);
        return false;
    }

    const targetPosition = Math.max(anchorRole.position - 1, 1);
    try {
        await guild.roles.setPosition(role.id, targetPosition, { reason: `Move ${role.name} under ${anchorLabel}` });
        return true;
    } catch (err) {
        console.warn(`[CC LOG] Could not position ${role.name} under ${anchorLabel}:`, err);
        return false;
    }
}


function getMemberColorRoleName(member, user) {
    return member.nickname || user.globalName || user.username;
}


async function findMemberColorRole(guild, member, user) {
    const currentName = getMemberColorRoleName(member, user);
    const legacyName = `color-${user.id}`;
    const customAnchor = await fetchRoleById(guild, CUSTOM_COLOR_ROLE_ANCHOR_ID);
    const presetRoleIds = new Set(COLOR_ROLE_PRESETS.map(preset => preset.roleId).filter(Boolean));

    // Custom color roles are member-owned roles below the custom role anchor in Discord.
    const isCustomCandidate = role =>
        customAnchor !== null &&
        role.position < customAnchor.position &&
        !presetRoleIds.has(role.id) &&
        !role.managed &&
        !role.hoist &&
        !role.mentionable &&
        role.permissions.bitfield === 0n;

    const assignedMatch = member.roles.cache.find(role =>
        role.name === legacyName ||
        (role.name === currentName && (customAnchor === null || role.position < customAnchor.position))
    );
    if (assignedMatch) return assignedMatch;

    const assignedCustomCandidates = member.roles.cache.filter(isCustomCandidate);
    if (assignedCustomCandidates.size === 1) {
        return assignedCustomCandidates.first();
    }

    return guild.roles.cache.find(role => role.name === legacyName) ?? null;
}


async function getPresetColorRoles(guild) {
    const roles = [];
    for (const roleId of COLOR_ROLE_PRESETS.map(preset => preset.roleId).filter(Boolean)) {
        const role = await fetchRoleById(guild, roleId);
        if (role !== null) roles.push(role);
    }
    return roles;
}


function isPresetColorRole(role) {
    return COLOR_ROLE_PRESETS.some(preset => preset.roleId === role?.id);
}


async function deleteCustomColorRole(guild, role, user) {
    if (role === null || isPresetColorRole(role)) {
        return false;
    }

    const roleError = await manageableRoleError(guild, role);
    if (roleError !== null) {
        const err = new Error(roleError);
        err.code = 'CUSTOM_COLOR_ROLE_DELETE_BLOCKED';
        throw err;
    }

    await role.delete(`Delete removed custom color role for ${user.tag ?? user.username} (${user.id})`);
    return true;
}


async function syncMemberColorRoleName(member, user = member.user) {
    // Called after a user changes their server nickname, keeping the color role name in sync with their current display name.
    const role = await findMemberColorRole(member.guild, member, user);
    if (role === null || isPresetColorRole(role)) {
        return false;
    }

    const roleName = getMemberColorRoleName(member, user);
    if (!roleName || role.name === roleName) {
        return false;
    }

    const roleError = await manageableRoleError(member.guild, role);
    if (roleError !== null) {
        console.warn(`[CC LOG] Could not rename custom color role for ${user.tag ?? user.username} (${user.id}): ${roleError}`);
        return false;
    }

    await member.guild.roles.edit(role.id, {
        name: roleName,
        reason: `Color role renamed after server nickname update for ${user.tag ?? user.username} (${user.id})`
    });
    return true;
}


async function removeActiveColorRoles(member, user, exceptRoleId = null, auditReason = null) {
    const presetRoles = await getPresetColorRoles(member.guild);
    const rolesToRemove = presetRoles.filter(role =>
        role.id !== exceptRoleId && member.roles.cache.has(role.id)
    );

    const customRole = await findMemberColorRole(member.guild, member, user);
    const shouldDeleteCustomRole = customRole !== null && customRole.id !== exceptRoleId && !isPresetColorRole(customRole);
    if (customRole !== null && customRole.id !== exceptRoleId && member.roles.cache.has(customRole.id)) {
        rolesToRemove.push(customRole);
    }

    if (rolesToRemove.length > 0) {
        for (const id of new Set(rolesToRemove.map(role => role.id))) await member.roles.remove(id,
            auditReason || `Remove previous color roles for ${user.tag ?? user.username} (${user.id})`);
    }

    if (shouldDeleteCustomRole) {
        await deleteCustomColorRole(member.guild, customRole, user);
    }
}


async function applyRoleColors(role, style, reason) {
    if (typeof role.edit === 'function') {
        return role.edit({
            colors: {
                primaryColor: style.primary,
                secondaryColor: style.secondary ?? null,
                tertiaryColor: null
            },
            reason
        });
    }

    if (typeof role.setColors === 'function') {
        return role.setColors({
            primaryColor: style.primary,
            secondaryColor: style.secondary ?? null,
            tertiaryColor: null
        }, reason);
    }

    throw new Error('Role color editing is not available in this discord.js role object.');
}


async function applyPresetColorRole(interaction, presetId) {
    await deferPreviewUpdate(interaction);

    if (!interaction.guild) {
        await editPreviewFeedback(interaction, 'This panel only works inside the server.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (member === null) {
        await editPreviewFeedback(interaction, 'Server profile not found.');
        return;
    }

    const preset = getPresetById(presetId);
    const roleId = preset?.roleId;
    if (preset === null || !roleId) {
        await editPreviewFeedback(interaction, '### ❌ This preset color role is not configured. Ask an admin to check the Color Roles panel setup.');
        return;
    }

    const role = await fetchRoleById(interaction.guild, roleId);
    if (role === null) {
        await editPreviewFeedback(interaction, `### ❌ The **${preset.name}** color role is missing. Ask an admin to check the Color Roles preset role IDs.`);
        return;
    }

    const roleError = await manageableRoleError(interaction.guild, role);
    if (roleError !== null) {
        await editPreviewFeedback(interaction, roleError);
        return;
    }

    try {
        await removeActiveColorRoles(member, interaction.user, role.id, rolePanelReason(interaction, 'Replace active color role'));
        if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, rolePanelReason(interaction, 'Select preset color role'));
        }

        await editPreviewFeedback(
            interaction,
            `**✅  You have been assigned the ${role} color role!**\n` +
            `- Selected preset: **${preset.emoji ?? '🎨'} ${preset.name}**\n` +
            `- Color: **${styleText(presetToStyle(preset))}**`
        );
    } catch (err) {
        if (err?.code === 50013) {
            await editPreviewFeedback(interaction, 'Role update blocked. Check bot permissions and role order.');
            return;
        }

        console.error('[CC LOG] Preset color role apply error:', err);
        await editPreviewFeedback(interaction, 'Role update failed. Try again shortly.');
    }
}


async function applyCustomColorRole(interaction, style) {
    await deferPreviewUpdate(interaction);

    if (!interaction.guild) {
        await editPreviewFeedback(interaction, 'This panel only works inside the server.');
        return;
    }

    if (isGradientStyle(style) && !hasEnhancedRoleColors(interaction.guild)) {
        await editPreviewFeedback(interaction, '### ❌ Gradient colors are not available on this server.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (member === null) {
        await editPreviewFeedback(interaction, 'Server profile not found.');
        return;
    }

    const me = await getBotMember(interaction.guild);
    if (me === null) {
        await editPreviewFeedback(interaction, 'Bot role setup is incomplete.');
        return;
    }

    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await editPreviewFeedback(interaction, 'The bot needs **Manage Roles** to update roles.');
        return;
    }

    const roleName = getMemberColorRoleName(member, interaction.user);
    const reason = `Color role updated for ${interaction.user.tag ?? interaction.user.username} (${interaction.user.id})`;
    let role = await findMemberColorRole(interaction.guild, member, interaction.user);

    try {
        if (role === null) {
            role = await interaction.guild.roles.create({
                name: roleName,
                permissions: [],
                hoist: false,
                mentionable: false,
                reason: `Color role created for ${interaction.user.tag ?? interaction.user.username} (${interaction.user.id})`
            });
        } else if (role.name !== roleName) {
            role = await interaction.guild.roles.edit(role.id, {
                name: roleName,
                reason
            });
        }

        const roleError = await manageableRoleError(interaction.guild, role);
        if (roleError !== null) {
            await editPreviewFeedback(interaction, roleError);
            return;
        }

        await applyRoleColors(role, style, reason);
        const positioned = await maybePositionRoleUnderAnchor(interaction.guild, role, CUSTOM_COLOR_ROLE_ANCHOR_ID, 'Custom Color Roles anchor');
        await removeActiveColorRoles(member, interaction.user, role.id, rolePanelReason(interaction, 'Replace active color role'));

        if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, rolePanelReason(interaction, 'Select custom color role'));
        }

        await editPreviewFeedback(
            interaction,
            `**✅  Your personal color role has been updated!**\n` +
            `- Personal Role Name: ${role}\n` +
            `- Role Color: **${styleText(style)}**` +
            (positioned ? '' : '\n-# Role color was applied, but staff may need to adjust the role position.')
        );
    } catch (err) {
        if (err?.code === 50013) {
            await editPreviewFeedback(interaction, 'Role update blocked. Check bot permissions and role order.');
            return;
        }

        console.error('[CC LOG] Custom color role apply error:', err);
        await editPreviewFeedback(interaction, 'Role update failed. Try again shortly.');
    }
}


async function clearMemberColorRole(interaction) {
    await deferHidden(interaction);

    if (!interaction.guild) {
        await sendHiddenFeedback(interaction, 'This panel only works inside the server.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (member === null) {
        await sendHiddenFeedback(interaction, 'Server profile not found.');
        return;
    }

    try {
        const presetRoles = await getPresetColorRoles(interaction.guild);
        const customRole = await findMemberColorRole(interaction.guild, member, interaction.user);
        const rolesToRemove = presetRoles.filter(role => member.roles.cache.has(role.id));
        const customRoleToDelete = customRole !== null && !isPresetColorRole(customRole) ? customRole : null;

        if (customRoleToDelete !== null && member.roles.cache.has(customRoleToDelete.id)) {
            rolesToRemove.push(customRoleToDelete);
        }

        if (rolesToRemove.length > 0) {
            for (const id of new Set(rolesToRemove.map(role => role.id))) {
                await member.roles.remove(id, rolePanelReason(interaction, 'Clear active color roles'));
            }
        }

        if (customRoleToDelete !== null) {
            try {
                await deleteCustomColorRole(interaction.guild, customRoleToDelete, interaction.user);
            } catch (deleteErr) {
                if (deleteErr?.code === 'CUSTOM_COLOR_ROLE_DELETE_BLOCKED') {
                    await sendHiddenFeedback(interaction, `${deleteErr.message}\n- Your active color role was removed, but the custom role could not be deleted.`);
                    return;
                }

                throw deleteErr;
            }
        }

        await sendHiddenFeedback(interaction, '**❌  Your active color role has been removed.**');
    } catch (err) {
        if (err?.code === 50013) {
            await sendHiddenFeedback(interaction, 'Role update blocked. Check bot permissions and role order.');
            return;
        }

        console.error('[CC LOG] Color role clear error:', err);
        await sendHiddenFeedback(interaction, 'Role update failed. Try again shortly.');
    }
}


async function toggleRoleFromButton(interaction, panel, choice) {
    await deferHidden(interaction);

    if (!interaction.guild) {
        await sendHiddenFeedback(interaction, 'This panel only works inside the server.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (member === null) {
        await sendHiddenFeedback(interaction, 'Server profile not found.');
        return;
    }

    const role = getConfiguredRole(interaction.guild, choice);
    if (role === null) {
        await sendHiddenFeedback(
            interaction,
            `Role setup is missing for **${choice.label}**. Staff needs to check the role ID.`
        );
        return;
    }

    const roleError = await manageableRoleError(interaction.guild, role);
    if (roleError !== null) {
        await sendHiddenFeedback(interaction, roleError);
        return;
    }

    const reason = rolePanelReason(interaction, 'Role selection button');

    try {
        if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, reason);
            await sendHiddenFeedback(
                interaction,
                `**❌  You no longer have the ${role} role!**\n` +
                '- You can assign the role again by pressing on the same button.'
            );
            return;
        }

        const rolesToRemove = [];
        if (!panel.allowMultiple) {
            for (const otherChoice of panel.roles) {
                if (otherChoice.roleId === role.id) continue;

                const otherRole = getConfiguredRole(interaction.guild, otherChoice);
                if (otherRole === null || !member.roles.cache.has(otherRole.id)) continue;

                if (await manageableRoleError(interaction.guild, otherRole) === null) {
                    rolesToRemove.push(otherRole);
                }
            }
        }

        if (rolesToRemove.length > 0) {
            for (const removed of rolesToRemove) await member.roles.remove(removed.id, reason);
        }

        await member.roles.add(role, reason);
        await sendHiddenFeedback(
            interaction,
            `**✅  You have been assigned the ${role} role!**\n` +
            '- You can remove the role by pressing on the same button.'
        );
    } catch (err) {
        if (err?.code === 50013) {
            await sendHiddenFeedback(
                interaction,
                'Role update blocked. Check bot permissions and role order.'
            );
            return;
        }

        await sendHiddenFeedback(
            interaction,
            'Role update failed. Try again shortly.'
        );
    }
}


async function applyRolesFromDropdown(interaction, panel, selectedKeys) {
    await deferHidden(interaction);

    if (!interaction.guild) {
        await sendHiddenFeedback(interaction, 'This panel only works inside the server.');
        return;
    }

    const member = await memberFromInteraction(interaction);
    if (member === null) {
        await sendHiddenFeedback(interaction, 'Server profile not found.');
        return;
    }

    if (!panel.allowMultiple && selectedKeys.size > 1) {
        selectedKeys = new Set([selectedKeys.values().next().value]);
    }

    const selectedRoleIds = new Set(
        panel.roles
            .filter(choice => selectedKeys.has(choice.key))
            .map(choice => choice.roleId)
    );

    const rolesToAdd = [];
    const rolesToRemove = [];
    const errors = [];

    for (const choice of panel.roles) {
        const role = getConfiguredRole(interaction.guild, choice);
        if (role === null) {
            errors.push(`Role setup is missing for **${choice.label}**.`);
            continue;
        }

        const roleError = await manageableRoleError(interaction.guild, role);
        if (roleError !== null) {
            errors.push(roleError);
            continue;
        }

        const wantsRole = selectedRoleIds.has(role.id);
        const hasRole = member.roles.cache.has(role.id);

        if (wantsRole && !hasRole) {
            rolesToAdd.push(role);
        } else if (!wantsRole && hasRole) {
            rolesToRemove.push(role);
        }
    }

    if (errors.length > 0) {
        await sendHiddenFeedback(interaction, [...new Set(errors)].join('\n'));
        return;
    }

    const reason = rolePanelReason(interaction, 'Role selection dropdown');

    try {
        if (rolesToRemove.length > 0) {
            for (const removed of rolesToRemove) await member.roles.remove(removed.id, reason);
        }
        if (rolesToAdd.length > 0) {
            for (const added of rolesToAdd) await member.roles.add(added.id, reason);
        }
    } catch (err) {
        if (err?.code === 50013) {
            await sendHiddenFeedback(
                interaction,
                'Role update blocked. Check bot permissions and role order.'
            );
            return;
        }

        await sendHiddenFeedback(
            interaction,
            'Role update failed. Try again shortly.'
        );
        return;
    }

    if (rolesToAdd.length === 1 && rolesToRemove.length === 0) {
        await sendHiddenFeedback(
            interaction,
            `**✅  You have been assigned the ${rolesToAdd[0]} role!**\n` +
            '- You can remove the role by deselecting it from dropdown menu.'
        );
        return;
    }

    if (rolesToRemove.length === 1 && rolesToAdd.length === 0) {
        await sendHiddenFeedback(
            interaction,
            `**❌  You no longer have the ${rolesToRemove[0]} role!**\n` +
            '- You can assign the role again from the dropdown menu.'
        );
        return;
    }

    if (rolesToAdd.length > 0 || rolesToRemove.length > 0) {
        const lines = ['Your **region roles** have been updated:'];
        if (rolesToRemove.length > 0) {
            lines.push('- **❌ Removed:** ' + rolesToRemove.map(role => `${role}`).join(', '));
        }
        if (rolesToAdd.length > 0) {
            lines.push('- **✅ Assigned:** ' + rolesToAdd.map(role => `${role}`).join(', '));
        }
        await sendHiddenFeedback(interaction, lines.join('\n'));
        return;
    }

    await sendHiddenFeedback(interaction, alreadyHasRoleMessage(interaction.guild, panel, selectedKeys));
}


function alreadyHasRoleMessage(guild, panel, selectedKeys) {
    for (const choice of panel.roles) {
        if (!selectedKeys.has(choice.key)) {
            continue;
        }

        const role = getConfiguredRole(guild, choice);
        const roleName = role?.name ?? choice.label;
        const emoji = choice.emoji ? `${choice.emoji} ` : '';
        return `You already have the **${emoji}${roleName}** role.`;
    }
    return 'You already have the selected role.';
}


function buildAutoRoleButtons(panel) {
    const rows = new Map();
    for (const choice of panel.roles) {
        if (!rows.has(choice.row)) rows.set(choice.row, []);
        rows.get(choice.row).push(choice);
    }

    return [...rows.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, choices]) => {
            const row = new ActionRowBuilder();
            for (const choice of choices) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(panel.customIdForRole(choice.key))
                        .setLabel(choice.label)
                        .setEmoji(choice.emoji)
                        .setStyle(choice.buttonStyle)
                );
            }
            return row;
        });
}


function buildAutoRoleSelect(panel) {
    const options = panel.roles.map(choice => {
        const option = new StringSelectMenuOptionBuilder()
            .setLabel(choice.label)
            .setValue(choice.key)
            .setDescription(`Select ${choice.label}!`);

        if (choice.emoji) {
            option.setEmoji(choice.emoji);
        }

        return option;
    });

    const select = new StringSelectMenuBuilder()
        .setCustomId(panel.selectCustomId)
        .setPlaceholder(panel.dropdownPlaceholder || `Choose ${panel.name} here!`)
        .setMinValues(0)
        .setMaxValues(panel.allowMultiple ? options.length : 1)
        .addOptions(options);

    return [new ActionRowBuilder().addComponents(select)];
}


function getColorPresetPage(page = COLOR_ROLE_PANEL_PAGE) {
    const configuredPresets = getConfiguredColorPresets();
    const totalPages = Math.max(Math.ceil(configuredPresets.length / COLOR_ROLE_PRESET_PAGE_SIZE), 1);
    const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
    const start = safePage * COLOR_ROLE_PRESET_PAGE_SIZE;

    return {
        page: safePage,
        totalPages,
        presets: configuredPresets.slice(start, start + COLOR_ROLE_PRESET_PAGE_SIZE)
    };
}


function buildColorRolePresetSelect(page = COLOR_ROLE_PANEL_PAGE) {
    const pageData = getColorPresetPage(page);
    const options = pageData.presets.map(preset => {
        const option = new StringSelectMenuOptionBuilder()
            .setLabel(preset.name)
            .setValue(preset.id)
            .setDescription(preset.secondary ? `${preset.primary} → ${preset.secondary}` : preset.primary);

        if (preset.emoji) {
            option.setEmoji(preset.emoji);
        }

        return option;
    });

    const select = new StringSelectMenuBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:select:${pageData.page}`)
        .setPlaceholder('Select a preset color here!')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);

    return new ActionRowBuilder().addComponents(select);
}


function buildColorRoleComponents(page = COLOR_ROLE_PANEL_PAGE) {
    const pageData = getColorPresetPage(page);
    const rows = [];

    if (pageData.presets.length > 0) {
        rows.push(buildColorRolePresetSelect(pageData.page));
    } else {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:setup_needed`)
                .setLabel('Preset roles need setup')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        ));
    }

    if (pageData.totalPages > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:page:${Math.max(pageData.page - 1, 0)}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageData.page === 0),
            new ButtonBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:page:${Math.min(pageData.page + 1, pageData.totalPages - 1)}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(pageData.page >= pageData.totalPages - 1)
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:modal:solid`)
            .setLabel('Custom Color')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:modal:gradient`)
            .setLabel('Custom Gradient')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:random:solid`)
            .setLabel('Random Color')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:random:gradient`)
            .setLabel('Random Gradient')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:color_roles:clear`)
            .setLabel('Clear')
            .setStyle(ButtonStyle.Danger)
    ));

    return rows;
}


function buildComponentsForPanel(panel) {
    if (panel.safeMode === 'buttons') {
        return buildAutoRoleButtons(panel);
    }

    if (panel.safeMode === 'dropdown') {
        return buildAutoRoleSelect(panel);
    }

    if (panel.safeMode === 'color_roles') {
        return buildColorRoleComponents();
    }

    return [];
}


async function sendAutoRolePanel(channel, panel) {
    const embed = buildAutoRoleEmbed(panel);
    const files = buildAutoRoleFiles(panel);
    const components = buildComponentsForPanel(panel);
    const messageText = panel.messageText || null;

    if (panel.safeMode === 'buttons' || panel.safeMode === 'dropdown' || panel.safeMode === 'color_roles') {
        return channel.send({ content: messageText, embeds: [embed], files, components });
    }

    const message = await channel.send({ content: messageText, embeds: [embed], files });
    for (const choice of panel.roles) {
        if (choice.emoji !== null) {
            await message.react(choice.emoji);
        }
    }
    return message;
}


// =============================================================================
// AUTO ROLE PANEL - UPDATE EXISTING MESSAGE
// =============================================================================
async function updateAutoRolePanel(message, panel) {
    const embed = buildAutoRoleEmbed(panel);
    const files = buildAutoRoleFiles(panel);
    const components = buildComponentsForPanel(panel);
    const messageText = panel.messageText || null;

    return message.edit({
        content: messageText,
        embeds: [embed],
        components,

        // Replace old panel attachments with the files from the current config.
        attachments: [],
        files
    });
}


async function handleServerRoleButton(interaction, server, serverSettings) {
    await deferHidden(interaction);

    if (!serverSettings) {
        await sendHiddenFeedback(interaction, 'Server settings are temporarily unavailable. Please try again later.');
        return;
    }

    try {
        const result = await serverSettings.select(interaction, server, { toggle: true });
        await sendHiddenFeedback(interaction, selectionFeedback(result));
    } catch (error) {
        console.error('[CC LOG] Could not save a guild member server preference:', error);
        await sendHiddenFeedback(interaction, error.message === 'No permission!'
            ? 'No permission!'
            : 'Could not save your server selection and role. Please try again.');
    }
}


async function handleAutoRoleButton(interaction, serverSettings = null) {
    if (!COMPONENT_PREFIXES.some(prefix => interaction.customId.startsWith(`${prefix}:`))) return false;

    const [, , panelKey, componentType, ...args] = interaction.customId.split(':');
    if (panelKey === 'color_roles') {
        return handleColorRoleButton(interaction, componentType, args);
    }

    const [roleKey] = args;
    if (componentType !== 'button') return false;

    const panel = findAutoRolePanel(panelKey);
    if (panel === null) {
        await interaction.reply({
            content: 'Auto-role panel not found! Please ask staff to repost this panel.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const choice = panel.roles.find(roleChoice => roleChoice.key === roleKey);
    if (!choice) {
        await interaction.reply({
            content: 'Auto-role choice not found! Please ask staff to repost this panel.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    if (panel.key === 'guild_roles' && ['gold', 'silver', 'cross'].includes(choice.key)) {
        await handleServerRoleButton(interaction, choice.key, serverSettings);
        return true;
    }

    await toggleRoleFromButton(interaction, panel, choice);
    return true;
}


async function handleAutoRoleSelect(interaction) {
    if (!COMPONENT_PREFIXES.some(prefix => interaction.customId.startsWith(`${prefix}:`))) return false;

    const [, , panelKey, componentType, ...args] = interaction.customId.split(':');
    if (panelKey === 'color_roles') {
        return handleColorRoleSelect(interaction, componentType, args);
    }

    if (componentType !== 'select') return false;

    const panel = findAutoRolePanel(panelKey);
    if (panel === null) {
        await interaction.reply({
            content: 'Auto-role panel not found! Please ask staff to repost this panel.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    await applyRolesFromDropdown(interaction, panel, new Set(interaction.values));
    return true;
}


async function handleColorRoleButton(interaction, action, args) {
    if (action === 'page') {
        const page = Number(args[0]) || 0;
        await interaction.update({
            components: buildColorRoleComponents(page)
        });
        return true;
    }

    if (action === 'modal') {
        const [modalType] = args;
        const source = getColorPanelSourceFromInteraction(interaction);
        if (modalType === 'solid') {
            await interaction.showModal(buildSolidColorModal(source));
            await refreshColorRolePanelMessage(interaction.message, source?.page);
            return true;
        }

        if (modalType === 'gradient') {
            if (interaction.guild && !hasEnhancedRoleColors(interaction.guild)) {
                await interaction.reply({
                    content: '### ❌ Gradient colors are not available on this server.',
                    flags: MessageFlags.Ephemeral
                });
                return true;
            }

            await interaction.showModal(buildGradientColorModal(source));
            await refreshColorRolePanelMessage(interaction.message, source?.page);
            return true;
        }
    }

    if (action === 'random') {
        const [randomType] = args;
        const source = getColorPanelSourceFromInteraction(interaction);
        if (randomType === 'solid') {
            await sendColorPreview(interaction, getRandomSolidStyle(), source);
            await refreshColorRolePanelMessage(interaction.message, source?.page);
            return true;
        }

        if (randomType === 'gradient') {
            await sendColorPreview(interaction, getRandomGradientStyle(), source);
            await refreshColorRolePanelMessage(interaction.message, source?.page);
            return true;
        }
    }

    if (action === 'apply') {
        const style = parseApplyStyle(args);
        if (style === null) {
            await deferPreviewUpdate(interaction);
            await editPreviewFeedback(interaction, '### ❌ This color preview is invalid or expired. Please choose the color again.');
            return true;
        }

        if (style.kind === 'preset') {
            await applyPresetColorRole(interaction, style.presetId);
        } else {
            await applyCustomColorRole(interaction, style);
        }
        return true;
    }

    if (action === 'back') {
        await interaction.update({
            content: '### Color Roles\nUse the original Color Roles panel to choose another color.',
            embeds: [],
            components: [],
            attachments: []
        });
        return true;
    }

    if (action === 'dismiss') {
        await dismissHiddenPreview(interaction);
        return true;
    }

    if (action === 'clear') {
        await clearMemberColorRole(interaction);
        return true;
    }

    return false;
}


async function handleColorRoleSelect(interaction, componentType, args) {
    if (componentType !== 'select') return false;

    const [pageRaw] = args;
    const preset = getPresetById(interaction.values[0]);
    if (preset === null) {
        await interaction.reply({
            content: '### ❌ Color preset not found. Please ask staff to repost this panel.',
            flags: MessageFlags.Ephemeral
        });
        return true;
    }

    const page = Number(pageRaw) || COLOR_ROLE_PANEL_PAGE;
    const source = getColorPanelSourceFromInteraction(interaction, page);
    await sendColorPreview(interaction, presetToStyle(preset), source);
    await refreshColorRolePanelMessage(interaction.message, page);
    return true;
}


async function handleAutoRoleModal(interaction) {
    if (!COMPONENT_PREFIXES.some(prefix => interaction.customId.startsWith(`${prefix}:color_roles:modal_submit:`))) return false;

    const [, , , , modalType, ...sourceParts] = interaction.customId.split(':');
    const source = parseColorPanelSource(sourceParts);

    if (modalType === 'solid') {
        const color = normalizeColorInput(interaction.fields.getTextInputValue('hex_color'));
        if (!color) {
            await interaction.reply({
                content: '### ❌ Invalid color\n- Enter a color name like `blue`, or a hex code like `#5865F2`.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        await sendColorPreview(interaction, customStyle('solid', color), source);
        return true;
    }

    if (modalType === 'gradient') {
        if (interaction.guild && !hasEnhancedRoleColors(interaction.guild)) {
            await interaction.reply({
                content: '### ❌ Gradient colors are not available on this server.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        const startColor = normalizeColorInput(interaction.fields.getTextInputValue('start_color'));
        const endColor = normalizeColorInput(interaction.fields.getTextInputValue('end_color'));
        if (!startColor || !endColor) {
            await interaction.reply({
                content: '### ❌ Invalid gradient colors\n- Enter color names like `red` and `purple`, or hex codes like `#FF512F` and `#DD2476`.',
                flags: MessageFlags.Ephemeral
            });
            return true;
        }

        await sendColorPreview(interaction, customStyle('gradient', startColor, endColor), source);
        return true;
    }

    return false;
}


module.exports = {
    autoRolePanelAutocomplete,
    buildAutoRoleEmbed,
    buildAutoRoleFiles,
    buildComponentsForPanel,
    findAutoRolePanel,
    getActiveAutoRolePanels,
    getAllAutoRolePanels,
    handleAutoRoleButton,
    handleAutoRoleModal,
    handleAutoRoleSelect,
    COLOR_ROLE_PRESETS,
    syncMemberColorRoleName,
    sendAutoRolePanel,
    updateAutoRolePanel
};
