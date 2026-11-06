'use strict';

const { EmbedBuilder } = require('discord.js');
const { FahClient, fmtNum } = require('./fah-client');

const FAH_COLOR = 0x00909d;
const FAH_URL = 'https://foldingathome.org/';
const FAH_TEAM_URL = "https://stats.foldingathome.org/team/1065919";
const FAH_DONATE = "https://foldingathome.org/donate/";
const WEB_CONTROL_URL = 'https://v8-5.foldingathome.org/machines';

class FahCog {
    constructor() {
        this.client = new FahClient();
    }

    /** Routes `k.fah`. Returns true when consumed. */
    async handleMessage(message) {
        if (message.author?.bot || !message.guildId) return false;
        const content = (message.content || '').trim();
        if (!content.toLowerCase().startsWith('k.')) return false;

        const cmd = content.slice(2).split(/\s+/)[0]?.toLowerCase();
        if (cmd !== 'fah') return false;

        await message.channel.sendTyping().catch(() => {});
        const embed = await this.buildEmbed();
        await message.reply({ embeds: [embed] }).catch(() => {});
        return true;
    }

    async buildEmbed() {
        const embed = new EmbedBuilder()
            .setColor(FAH_COLOR)
            .setTitle('Folding@home')
            .setURL(FAH_URL)
            .setDescription(
                'Our community proudly supports **[Folding@home](https://foldingathome.org/)**, sharing spare compute power to simulate ' +
                'protein folding and help disease research again I.e. cancer and Alzheimer`s.\n Anyone can run and help, you can also join our team below!'
            )
            .setFooter({ text: 'Run k.fah anytime for stats updates · foldingathome.org' })
            .setTimestamp();

        if (!this.client.configured()) {
            embed.addFields({
                name: 'Live stats',
                value: 'Not configured yet. Set `fah-email` and `fah-password` in `.env` to show our folding stats here.'
            });
            return embed;
        }

        const dash = await this.client.fetchDashboard();
        const lines = [];

        if (dash.stats) {
            lines.push(`> - Donor: **${dash.stats.name || dash.account?.user || '—'}**`);
            if (dash.stats.team != null) lines.push(`> - Team: **${dash.stats.team}**`);
            lines.push(`> - Total WUs completed: **${fmtNum(dash.stats.wus)}**`);
            lines.push(`> - Total points: **${fmtNum(dash.stats.score)}**`);
            if (dash.stats.rank != null) lines.push(`> - Global rank: **#${fmtNum(dash.stats.rank)}**`);
            if (dash.stats.active_7 != null) lines.push(`> - Active machines (7-day): **${fmtNum(dash.stats.active_7)}**`);
            const lastTs = Date.parse(`${dash.stats.last}`.replace(' ', 'T') + 'Z');
            if (Number.isFinite(lastTs)) lines.push(`> - Last WU Completed: **<t:${Math.floor(lastTs / 1000)}:R>**`);
        } else if (dash.account?.user) {
            lines.push(`Donor: **${dash.account.user}**`);
            if (dash.account.team != null) lines.push(`> - Team: **${dash.account.team}**`);
        }

        if (dash.machines.length) {
            lines.push(`**Linked machines:** ${dash.machines.length}`);
        }

        if (lines.length) {
            embed.addFields({ name: 'How do we Contribute?', value: lines.join('\n') });
        }

        if (dash.local) {
            const local = dash.local;
            const localLines = [
                `> - Machine: **${local.name}**`,
                `> - Status: **${local.status}**`,
                `> - Est. PPD: **${fmtNum(local.ppd)}**`,
                `> - Active work units: **${local.activeUnits}**`
            ];
            if (local.completedOnMachine != null) {
                localLines.push(`**WUs on this host:** ${fmtNum(local.completedOnMachine)}`);
            }
            if (local.project) localLines.push(`> - Current project: **${local.project}**`);
            if (local.version) localLines.push(`> - Client: **v${local.version}${local.os ? ` · ${local.os}**` : ''}`);

            embed.addFields({ name: 'Current Host:', value: localLines.join('\n') });
        }

        if (dash.errors.length) {
            embed.addFields({
                name: 'Notes',
                value: dash.errors.map(e => `-# ${e}`).join('\n').slice(0, 1024)
            });
        }

        embed.addFields({
            name: 'Join in',
            value: `[Install the client](${FAH_URL}start-folding/) · [Our Team](${FAH_TEAM_URL})  · [Donate](${FAH_DONATE})`
        });

        return embed;
    }
}

module.exports = { FahCog };
