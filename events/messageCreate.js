// Handle the write and welcome prefix commands and log published messages.

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');

const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;

function formatMessageContentForLog(content) {
    const text = content.trim() || '*No text content (Image only)*';
    const prefix = '```text\n';
    const suffix = '\n```';
    const fullValue = `${prefix}${text}${suffix}`;

    if (fullValue.length <= MAX_EMBED_FIELD_VALUE_LENGTH) {
        return fullValue;
    }

    const truncationNotice = '\n... [Message content truncated in logs]';
    const maxTextLength = MAX_EMBED_FIELD_VALUE_LENGTH - prefix.length - suffix.length - truncationNotice.length;
    return `${prefix}${text.slice(0, maxTextLength)}${truncationNotice}${suffix}`;
}

async function notifyWriteFailure(message) {
    const content = '### ❌  Failed to send message.';

    try {
        return await message.reply({ content });
    } catch {
        return message.channel.send({ content }).catch(() => { });
    }
}

module.exports = {
    name: 'messageCreate',
    prefixCommands: [
        { name: 'write', prefixes: ['!', '?'] },
        { name: 'welcome', prefixes: ['!', '?'] }
    ],
    async execute(message, config) {
        if (message.author.bot || !message.guild || !message.member) return;
        if (!message.content.startsWith('?') && !message.content.startsWith('!')) return;

        const allowedRoles = [config.leaderRoleID, config.adminRoleID, config.officerRoleID];
        const isStaff = message.member.roles.cache.some(role => allowedRoles.includes(role.id));

        // ---------------------------------------------------------
        // COMMAND 1: !write / ?write command
        // ---------------------------------------------------------
        if (/^[!?]write(?=\s|$)/.test(message.content)) {
            let newMessage = message.content.slice(6).trim();
            let hidden = false;

            // Check for hidden flag (-h)
            if (newMessage.startsWith('-h ')) {
                if (!isStaff) {
                    return message.reply({ content: '### ❌  You do not have permission to use the hidden flag (-h)!' });
                }

                hidden = true;
                newMessage = newMessage.slice(3).trim(); // Remove "-h "
            }

            const attachment = message.attachments.first();
            let finalContent = newMessage || '';

            if (!isStaff) {
                // If NOT staff, force author footer
                finalContent += `\n\n-# - Message created by <@${message.author.id}>`;
            }

            const payload = {
                content: finalContent.trim() || null,
                files: attachment ? [attachment.url] : []
            };

            try {
                const sentMessage = await message.channel.send(payload);

                let command = '?write';
                if (hidden) {
                    command = '?write -h';
                    // Delete the original message command IF -h flag was used
                    await message.delete().catch(() => { });
                }

                // Ignore log events for specified channels (this.ignoredLogChannels)
                if (config.logChannelID && !config.ignoredLogChannels.includes(message.channel.id)) {
                    try {
                        const logChannel = await message.client.channels.fetch(config.logChannelID);
                        const imagePath = path.join(__dirname, '../images/cc_logo.webp');
                        const ccLogo = new AttachmentBuilder(imagePath, { name: 'cc_logo.webp' });
                        const logEmbed = new EmbedBuilder()
                            .setTitle(`💻 \u2002\`${command}\` command used!`)
                            .setColor(0x57F287)
                            .setDescription(`<@${message.author.id}> (${message.author.username}) commanded the CC Bot to write a message.`)
                            .addFields(
                                { name: 'Executor', value: `\`${message.author.displayName}\``, inline: true },
                                { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                                { name: '\u200b', value: '\u200b', inline: true },
                                { name: 'Message ID', value: `\`${sentMessage.id}\``, inline: true },
                                { name: 'Message Link', value: `[Jump to message](${sentMessage.url})`, inline: true },
                                { name: '\u200b', value: '\u200b', inline: true },
                                {
                                    name: '📝 Message Content',
                                    value: formatMessageContentForLog(finalContent),
                                    inline: false
                                }
                            )
                            .setFooter({ text: 'Crow Control Logs', iconURL: 'attachment://cc_logo.webp' })
                            .setTimestamp();

                        await logChannel.send({ embeds: [logEmbed], files: [ccLogo] });
                    } catch (logErr) {
                        console.error('[CC LOG] Failed to log write command:', logErr);
                    }
                }
            } catch (err) {
                console.error(err);
                return notifyWriteFailure(message);
            }

            return;
        }

        // ---------------------------------------------------------
        // COMMAND 2: !welcome / ?welcome command
        // ---------------------------------------------------------
        if (/^[!?]welcome\b/.test(message.content)) {
            const member = message.mentions.members.first();
            if (!member) {
                return message.reply({ content: '### ❌  Please mention a user to welcome!' });
            }

            return message.channel.send(
                `## 🎉  Welcome to Crow Control, <@${member.id}> — We're happy to have you here!  🎉\n` +
                `### 📜 **Guild Rules:** <#1246059221280096357>\n` +
                `### 📑 **Discord Information:** <#1454633218094530700>\n` +
                `### 📢 **Guild Announcements:** <#1180559473501290688>\n_ _\n` +
                `- <#1180559477519437947> — Introduce yourself to the guild\n` +
                `- <#1184121209609269409> — Get yourself some roles (You can select multiple roles)\n` +
                `- <#1345014095103135825> & <#1180559466555527309> — Feel free to ask any PvP related questions here\n` +
                `- <#1469101041189523657> — Participate in our PvP King competition (Read Channel description for more info)\n` +
                `### If you have any questions, feel free to ask in <#1301600985655017566> or send a DM to an Officer!`
            );
        }
    }
};
