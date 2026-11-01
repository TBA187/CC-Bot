// Keep scout controls responsive while a page or attachment is being prepared.
'use strict';

const { MessageFlags } = require('discord.js');

const FRAMES = ['◐', '◓', '◑', '◒'];
const activeMessages = new Set();

function isButtonLoading(messageId) {
    return activeMessages.has(String(messageId));
}

function loadingRows(original, interaction, label, frame, spinner) {
    const rows = structuredClone(original);
    let marked = false;
    for (const row of rows) {
        for (const component of row.components || []) {
            component.disabled = true;
            if (component.type !== 2 || component.custom_id !== interaction.customId) continue;
            marked = true;
            component.label = `${spinner ? '' : `${frame} `}${label || component.label || 'Loading…'}`.slice(0, 80);
            if (spinner) component.emoji = { id: spinner.id, name: spinner.name, animated: true };
            else delete component.emoji;
        }
    }
    // Select menus and modal submissions have no matching button. Keep their
    // controls disabled and add a separate loading button on an available row.
    if (!marked) {
        const button = { type: 2, style: 2, custom_id: `scout-loading:${interaction.id}`,
            label: `${spinner ? '' : `${frame} `}${label || 'Loading…'}`.slice(0, 80), disabled: true,
            ...(spinner ? { emoji: { id: spinner.id, name: spinner.name, animated: true } } : {}) };
        const row = rows.find(item => item.type === 1 && item.components.length < 5
            && item.components.every(component => component.type === 2));
        if (row) row.components.push(button);
        else if (rows.length < 5) rows.push({ type: 1, components: [button] });
    }
    return rows;
}

// Acknowledge immediately, then animate without delaying the work or allowing a
// late animation frame to overwrite the finished page. New screenshot messages
// remain private, with the original page's controls restored afterward.
async function withButtonLoading(interaction, work, {
    label, newMessage = false, errorMessage = 'Could not load this page. Please try again.',
    logContext = 'Scout page', onLoaded, loadingContent
} = {}) {
    const feedback = error => typeof errorMessage === 'function' ? errorMessage(error) : errorMessage;
    if (!interaction.message) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (loadingContent) {
                try {
                    await interaction.editReply({ content: loadingContent, embeds: [], components: [] });
                } catch (error) {
                    // A transient status update should not prevent the search itself.
                    console.warn(`[CC LOG] Could not show ${logContext} loading status: ${error.message}`);
                }
            }
            const payload = await work();
            await interaction.editReply(payload);
            onLoaded?.(payload);
        } catch (error) {
            console.warn(`[CC LOG] ${logContext} failed: ${error.message}`);
            await interaction.editReply({ content: feedback(error), embeds: [], components: [] });
        }
        return true;
    }

    const messageId = String(interaction.message.id);
    if (isButtonLoading(messageId)) {
        await interaction.reply({ content: 'This page is already loading. Please wait.', flags: MessageFlags.Ephemeral });
        return true;
    }
    let original;
    let spinner;
    let firstFrameTimer;
    let timer;
    let pending;
    let active = true;
    let frame = 0;
    let acknowledged = false;
    let animationStarted = false;
    let loadedPayload;
    const stop = async () => {
        active = false;
        clearTimeout(firstFrameTimer);
        clearInterval(timer);
        await pending;
    };
    activeMessages.add(messageId);
    try {
        // Send the small acknowledgement before building or updating controls.
        // The animation uses the webhook after Discord has accepted the click.
        await interaction.deferUpdate();
        acknowledged = true;
        original = (interaction.message.components || []).map(row => row.toJSON());
        spinner = interaction.guild?.emojis?.cache?.find(emoji => emoji.animated && emoji.available !== false
            && /^(?:loading|spinner|spinning)(?:[_-].*)?$/iu.test(emoji.name || ''));
        const animate = () => {
            if (!active || pending) return;
            animationStarted = true;
            pending = interaction.editReply({ components: loadingRows(original, interaction, label, FRAMES[frame], spinner) })
                .catch(() => { active = false; clearInterval(timer); })
                .finally(() => { pending = undefined; });
        };
        // Cached pages finish before this timer, avoiding a needless edit.
        firstFrameTimer = setTimeout(() => {
            animate();
            if (!spinner) {
                timer = setInterval(() => {
                    if (!active || pending) return;
                    frame = (frame + 1) % FRAMES.length;
                    animate();
                }, 1500);
                timer.unref?.();
            }
        }, 200);
        firstFrameTimer.unref?.();
        const payload = await work();
        if (newMessage) {
            await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
            await stop();
            if (animationStarted) await interaction.editReply({ components: original });
        } else {
            await stop();
            await interaction.editReply(payload);
        }
        loadedPayload = payload;
    } catch (error) {
        await stop();
        // Let the interaction dispatcher handle a failed acknowledgement.
        if (!acknowledged) throw error;
        console.warn(`[CC LOG] ${logContext} failed: ${error.message}`);
        await interaction.editReply({ components: original }).catch(() => {});
        await interaction.followUp({ content: feedback(error), flags: MessageFlags.Ephemeral });
    } finally {
        await stop();
        activeMessages.delete(messageId);
    }
    if (loadedPayload) onLoaded?.(loadedPayload);
    return true;
}

module.exports = { withButtonLoading, isButtonLoading };
