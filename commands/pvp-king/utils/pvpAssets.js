// Supplies the shared images and footer branding used by PvP King messages.
const path = require('path');
const { AttachmentBuilder } = require('discord.js');

const getServerLogo = () => {
    return new AttachmentBuilder(
        path.resolve('images/cc_logo.webp'),
        { name: 'serverLogo.webp' }
    );
};

const getServerBanner = () => {
    return new AttachmentBuilder(
        path.resolve('images/cc_banner.webp'),
        { name: 'serverBanner.webp' }
    );
};

const pvpThumnbnail = 'attachment://serverLogo.webp';

const pvpBannerImage = 'attachment://serverBanner.webp';

const createPvpFooter = serverName => ({
    text: `CC PvP King Dominion${serverName ? ` • ${serverName}` : ''}`,
    iconURL: 'attachment://serverLogo.webp'
});

const createPvpLogFooter = serverName => ({
    text: `CC PvP King Logs${serverName ? ` • ${serverName}` : ''}`,
    iconURL: 'attachment://serverLogo.webp'
});

module.exports = {
    getServerLogo,
    getServerBanner,
    pvpThumnbnail,
    pvpBannerImage,
    createPvpFooter,
    createPvpLogFooter
};
