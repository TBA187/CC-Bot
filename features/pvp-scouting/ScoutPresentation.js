// Shares modal inputs, branded embeds, and loading feedback across scout commands.
'use strict';

const { EmbedBuilder, LabelBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { withButtonLoading } = require('../../utils/interactionLoading.js');

const LOGO_NAME = 'cc_logo.webp';
const isBrandLogo = attachment => [LOGO_NAME, 'ww_logo.png'].includes(attachment.name);

function scoutTextInput(id, label, value = '', paragraph = false, required = false, maxLength = 4000, placeholder = '') {
    const input = new TextInputBuilder().setCustomId(id).setRequired(required).setMaxLength(maxLength)
        .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short);
    if (value != null && String(value)) input.setValue(String(value).slice(0, maxLength));
    if (placeholder) input.setPlaceholder(placeholder);
    return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

function scoutPayload(payload, message = null) {
    // Screenshot messages remain plain text with up to ten image attachments.
    if (!payload?.embeds?.length) return payload;
    const iconURL = message?.author?.displayAvatarURL?.();
    const embeds = payload.embeds.map((value, index) => {
        const json = value.toJSON?.() || value;
        // Team pages put their footer below the last description. Leave earlier
        // embeds footerless so the logo and page count appear only once.
        if (!json.footer && index < payload.embeds.length - 1) return new EmbedBuilder(json);
        const savedIcon = json.footer?.icon_url;
        return new EmbedBuilder(json).setFooter({ text: json.footer?.text || 'Crow Control',
            ...(iconURL || savedIcon && !savedIcon.startsWith('attachment://')
                ? { iconURL: iconURL || savedIcon } : {}) });
    });
    const result = { ...payload, embeds };
    if (payload.files) result.files = payload.files.filter(file => !isBrandLogo(file));
    if (payload.attachments) result.attachments = payload.attachments.filter(attachment => !isBrandLogo(attachment));
    else if (message?.attachments?.some?.(isBrandLogo)) {
        result.attachments = [...message.attachments.values()].filter(attachment => !isBrandLogo(attachment))
            .map(attachment => ({ id: attachment.id }));
    }
    return result;
}

function withScoutLoading(interaction, work, options = {}) {
    return withButtonLoading(interaction, async () => scoutPayload(await work(),
        options.newMessage ? null : interaction.message), options);
}

module.exports = { scoutPayload, scoutTextInput, withScoutLoading };
