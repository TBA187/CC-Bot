// Display member profile details; the filename avoids Node test discovery.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildMemberAuditPayload } = require('../utils/memberAuditEmbeds.js');

class Test {

    constructor(config) {
        this.name = "test";
        this.leaderRoleID = config.leaderRoleID;
        this.adminRoleID = config.adminRoleID;
        this.officerRoleID = config.officerRoleID;
        this.onCooldown = config.onCooldown;

        this.data = new SlashCommandBuilder()
            .setName('test')
            .setDescription('Test')
            .addUserOption(o =>
                o.setName('user')
                    .setDescription('Select user')
                    .setRequired(true)
            );
    }

    async execute(interaction) {
        if (this.onCooldown(interaction.user.id, 'stats', 2)) {
            return interaction.reply({ content: '### ⏳ Slow down!', flags: MessageFlags.Ephemeral });
        }

        // Check if user has Officer Role
        const allowedRoles = [this.leaderRoleID, this.adminRoleID, this.officerRoleID];
        if (!interaction.member.roles.cache.some(role => allowedRoles.includes(role.id))) {
            return interaction.reply({ content: '### ❌  No permission!', flags: MessageFlags.Ephemeral });
        }

        const member = interaction.options.getMember('user');
        if (!member) return interaction.reply({ content: '❌ User not found!', flags: MessageFlags.Ephemeral });

        await interaction.reply(buildMemberAuditPayload({ authorName: 'Member Information', member,
            actionText: 'has the following Discord profile details.', color: 0xe63b50,
            memberCount: member.guild.memberCount }));
    }
}

module.exports = Test;
