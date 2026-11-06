const { EmbedBuilder, Events } = require('discord.js');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STARBOARD_CHANNELS = require('../config-store').config.starboard?.default_channels || {};

class StarboardCog {
    constructor(client) {
        this.client = client;
        this.dataFile = path.join(__dirname, '..', 'data', 'starboard.json');
        this.data = {};
        this._listeners = [];
        this.defaultThreshold = 6;
        this.starEmojis = ['⭐'];
        this.channelName = 'starboard';
        this.accentColor = 0xFFAC33;
    }

    async init() {
        try {
            await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
            const fileContent = await fs.readFile(this.dataFile, 'utf-8');
            this.data = JSON.parse(fileContent);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to load starboard data:', error);
            }
            this.data = {};
        }

        let mutated = false;
        for (const [guildId, channelId] of Object.entries(DEFAULT_STARBOARD_CHANNELS)) {
            const guildData = this.getGuildData(guildId);
            if (!guildData.channel_id) {
                guildData.channel_id = channelId;
                mutated = true;
            }
        }

        if (mutated) {
            await this.save();
        }
    }

    async start() {
        await this.init();
        this.registerEvents();
    }

    stop() {
        for (const [event, listener] of this._listeners) {
            this.client.off(event, listener);
        }
        this._listeners = [];
    }

    async save() {
        try {
            await fs.writeFile(this.dataFile, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('Failed to save starboard data:', error);
        }
    }

    getGuildData(guildId) {
        if (!this.data[guildId]) {
            this.data[guildId] = {
                threshold: this.defaultThreshold,
                channel_id: null,
                star_emojis: [...this.starEmojis],
                entries: {}
            };
        }

        return this.data[guildId];
    }

    async getValidStarCount(message, guildData) {
        const uniqueUsers = new Set();
        const starEmojis = guildData.star_emojis || this.starEmojis;

        for (const reaction of message.reactions.cache.values()) {
            if (!starEmojis.includes(reaction.emoji.name)) continue;

            const users = await reaction.users.fetch();
            for (const user of users.values()) {
                if (user.id !== message.author.id) {
                    uniqueUsers.add(user.id);
                }
            }
        }

        return uniqueUsers.size;
    }

    async updateStarboardMessage(message, count, starboardChannel, guildData) {
        const entries = guildData.entries || {};
        const starboardMsgId = entries[message.id];
        if (!starboardMsgId) return;

        try {
            const starboardMsg = await starboardChannel.messages.fetch(starboardMsgId);
            const newContent = `💫 **${count}** | ${message.channel}`;

            if (starboardMsg.content !== newContent) {
                await starboardMsg.edit({ content: newContent });
            }
        } catch (error) {
            delete entries[message.id];
            await this.save();
        }
    }

    async getOrCreateStarboardChannel(guild, guildData) {
        if (!guildData.channel_id) {
            return null;
        }

        const cachedChannel = guild.channels.cache.get(guildData.channel_id);
        if (cachedChannel?.isTextBased()) {
            return cachedChannel;
        }

        const fetchedChannel = await this.client.channels.fetch(guildData.channel_id).catch(() => null);
        if (fetchedChannel?.isTextBased() && fetchedChannel.guildId === guild.id) {
            return fetchedChannel;
        }

        return null;
    }

    async handleStarboardCommand(message, args, canManageFeatures) {
        if (!canManageFeatures) {
            await message.reply('⛔ Access Denied. Moderators or trusted bot staff only.');
            return true;
        }

        const guildId = message.guildId;
        const guildData = this.getGuildData(guildId);
        if (args.length === 0) {
            if (guildData.channel_id === message.channelId) {
                guildData.channel_id = null;
                await this.save();
                await message.reply('😔 Starboard has been unbound from this channel. No fallback or auto-creation will be used.');
            } else {
                guildData.channel_id = message.channelId;
                await this.save();
                await message.reply(`✅ Starboard is now enabled and bound to <#${message.channelId}>.`);
            }
            return true;
        }

        const firstArg = args[0].toLowerCase();
        if (firstArg === 'stars' || firstArg === 'threshold') {
            const count = Number.parseInt(args[1], 10);
            if (!Number.isInteger(count) || count < 1) {
                await message.reply('Please provide a valid number of stars (minimum 1).');
                return true;
            }

            guildData.threshold = count;
            await this.save();
            await message.reply(`✅ Starboard threshold set to **${count}** stars.`);
            return true;
        }

        const channelId = args[0].replace(/[<#>]/g, '');
        const targetChannel = message.guild.channels.cache.get(channelId) || await this.client.channels.fetch(channelId).catch(() => null);

        if (targetChannel?.isTextBased() && targetChannel.guildId === message.guild.id) {
            guildData.channel_id = targetChannel.id;
            await this.save();
            await message.reply(`✅ Starboard is now bound to <#${targetChannel.id}>.`);
            return true;
        }

        await message.reply(
            'Usage:\n' +
            '`abc.starboard` - Toggle or bind to this channel\n' +
            '`abc.starboard #channel` - Bind to a specific channel\n' +
            '`abc.starboard stars <number>` - Set star threshold\n\n' +
            'Starboard channels are never auto-created.'
        );
        return true;
    }

    async handleCommand(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildData = this.getGuildData(interaction.guildId);

        if (subcommand === 'setup') {
            const channel = interaction.options.getChannel('channel');
            const threshold = interaction.options.getInteger('threshold') || this.defaultThreshold;

            guildData.channel_id = channel.id;
            guildData.threshold = threshold;
            await this.save();

            const embed = new EmbedBuilder()
                .setTitle('⭐ Starboard Configured')
                .setDescription(`Channel: ${channel}\nThreshold: **${guildData.threshold}** star(s)`)
                .setColor(this.accentColor);

            await interaction.reply({ embeds: [embed], ephemeral: true });
            return;
        }

        if (subcommand === 'threshold') {
            const count = interaction.options.getInteger('count');
            guildData.threshold = count;
            await this.save();
            await interaction.reply({ content: `⭐ Threshold set to **${guildData.threshold}**.`, ephemeral: true });
            return;
        }

        if (subcommand === 'stats') {
            const entries = guildData.entries || {};
            const channel = interaction.guild.channels.cache.get(guildData.channel_id);
            const embed = new EmbedBuilder()
                .setTitle('⭐ Starboard Stats')
                .setColor(this.accentColor)
                .addFields(
                    { name: 'Total Starred', value: `**${Object.keys(entries).length}** messages`, inline: true },
                    { name: 'Threshold', value: `**${guildData.threshold}** stars`, inline: true },
                    { name: 'Channel', value: channel ? channel.toString() : 'Not set', inline: true }
                );
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    registerEvents() {
        const onReactionAdd = async (reaction, user) => {
            if (reaction.partial) try { await reaction.fetch(); } catch (error) { return; }
            if (reaction.message.partial) try { await reaction.message.fetch(); } catch (error) { return; }

            const message = reaction.message;
            if (!message.guild) return;

            const guildData = this.getGuildData(message.guildId);
            const starEmojis = guildData.star_emojis || this.starEmojis;

            if (!starEmojis.includes(reaction.emoji.name)) return;
            if (message.channelId === guildData.channel_id) return;

            if (user.id === message.author.id) {
                try {
                    await reaction.users.remove(user.id);
                } catch (error) {
                    // Ignore missing permissions.
                }
                return;
            }

            const count = await this.getValidStarCount(message, guildData);
            if (count < guildData.threshold) return;

            const starboardChannel = await this.getOrCreateStarboardChannel(message.guild, guildData);
            if (!starboardChannel) return;

            const entries = guildData.entries || {};
            if (entries[message.id]) {
                await this.updateStarboardMessage(message, count, starboardChannel, guildData);
                return;
            }

            const embed = new EmbedBuilder()
                .setDescription(message.content || '*No text content*')
                .setColor(this.accentColor)
                .setTimestamp(message.createdAt)
                .setAuthor({
                    name: message.member?.displayName || message.author.username,
                    iconURL: message.author.displayAvatarURL()
                })
                .addFields({ name: 'Source', value: `[Jump to Message](${message.url})` })
                .setFooter({ text: `ID: ${message.id}` });

            const attachment = message.attachments.first();
            if (attachment?.contentType?.startsWith('image')) {
                embed.setImage(attachment.url);
            }

            const content = `💫 **${count}** | ${message.channel}`;
            try {
                const sentMsg = await starboardChannel.send({ content, embeds: [embed] });
                entries[message.id] = sentMsg.id;
                guildData.entries = entries;
                await this.save();
            } catch (error) {
                console.error('Failed to send message to starboard:', error);
            }
        };

        const onReactionRemove = async reaction => {
            if (reaction.partial) try { await reaction.fetch(); } catch (error) { return; }
            if (reaction.message.partial) try { await reaction.message.fetch(); } catch (error) { return; }

            const message = reaction.message;
            if (!message.guild) return;

            const guildData = this.getGuildData(message.guildId);
            const entries = guildData.entries || {};
            if (!entries[message.id]) return;

            const starEmojis = guildData.star_emojis || this.starEmojis;
            if (!starEmojis.includes(reaction.emoji.name)) return;

            const starboardChannel = await this.getOrCreateStarboardChannel(message.guild, guildData);
            if (!starboardChannel) return;

            const count = await this.getValidStarCount(message, guildData);
            await this.updateStarboardMessage(message, count, starboardChannel, guildData);
        };

        this.client.on(Events.MessageReactionAdd, onReactionAdd);
        this.client.on(Events.MessageReactionRemove, onReactionRemove);
        this._listeners.push([Events.MessageReactionAdd, onReactionAdd]);
        this._listeners.push([Events.MessageReactionRemove, onReactionRemove]);
    }
}

module.exports = { StarboardCog };
