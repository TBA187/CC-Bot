// Report gateway and reply latency through the public ping command.
'use strict';

const { SlashCommandBuilder } = require('discord.js');
const { performance } = require('node:perf_hooks');

class Ping {
    constructor() {
        this.name = 'ping';
        this.data = new SlashCommandBuilder()
            .setName('ping')
            .setDescription('Check Crow Control bot latency');
    }

    async execute(interaction) {
        const gatewayMs = interaction.client.ws.ping;
        const startTime = performance.now();
        await interaction.reply('Pinging...');
        const apiMs = performance.now() - startTime;

        return interaction.editReply(
            `**<:dark_murkrow:1565243892255694908>  Gateway Latency:** ${gatewayMs.toFixed(2)}ms *(avg)*\n` +
            `**<:dark_murkrow:1565243892255694908>  API Latency:** ${apiMs.toFixed(2)}ms *(real-time)*`
        );
    }
}

module.exports = Ping;
