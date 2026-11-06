const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    ModalBuilder,
    PermissionsBitField,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');

const DEFAULT_EMBED_COLOR = '#8B5CF6';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONTENT_LENGTH = 2000;
const MAX_TITLE_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_AUTHOR_LENGTH = 256;
const MAX_FOOTER_LENGTH = 2048;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_FIELD_VALUE_LENGTH = 1024;
const MAX_FIELDS = 25;
const MAX_CONTENT_PREVIEW_LENGTH = 240;
const MODAL_TEXT_INPUT_MAX_LENGTH = 4000;

class EmbedBuilderCog {
    constructor(client) {
        this.client = client;
        this.sessions = new Map();
        this.ownerSessions = new Map();
        this.controlMessageToSession = new Map();
        this.promptMessageToSession = new Map();
    }

    makeOwnerKey(guildId, userId) {
        return `${guildId}:${userId}`;
    }

    isAuthorized({ userId, member, config, allowedDevs }) {
        const isMaster = userId === config.master_id;
        const isOperator = userId === config.operator_id;
        const isDev = isMaster || allowedDevs.has(userId);
        const isAdmin = Boolean(member?.permissions?.has(PermissionsBitField.Flags.Administrator));
        return isDev || isOperator || isAdmin;
    }

    createDefaultEmbedState(targetChannelId) {
        return {
            targetChannelId,
            content: '',
            tts: false,
            allowedMentions: null,
            embed: {
                title: '',
                description: '',
                color: DEFAULT_EMBED_COLOR,
                url: '',
                authorName: '',
                authorUrl: '',
                authorIconUrl: '',
                thumbnailUrl: '',
                imageUrl: '',
                footerText: '',
                footerIconUrl: '',
                timestamp: null,
                fields: []
            }
        };
    }

    createSession(message) {
        const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        return {
            id: sessionId,
            guildId: message.guildId,
            ownerId: message.author.id,
            ownerTag: message.author.tag,
            controlChannelId: message.channelId,
            controlMessageId: null,
            promptMessageId: null,
            awaitingInput: null,
            payload: this.createDefaultEmbedState(message.channelId),
            createdAt: Date.now(),
            expiresAt: Date.now() + SESSION_TIMEOUT_MS,
            closed: false
        };
    }

    touchSession(session) {
        session.expiresAt = Date.now() + SESSION_TIMEOUT_MS;
    }

    isSessionExpired(session) {
        return Date.now() > session.expiresAt;
    }

    async cleanupExpiredSessions() {
        const expired = [...this.sessions.values()].filter(session => this.isSessionExpired(session));
        for (const session of expired) {
            await this.closeSession(session, 'Builder expired after 30 minutes of inactivity.');
        }
    }

    getSessionByMessageReference(message) {
        const referencedId = message.reference?.messageId;
        if (!referencedId) return null;

        const sessionId = this.promptMessageToSession.get(referencedId) || this.controlMessageToSession.get(referencedId);
        return sessionId ? this.sessions.get(sessionId) || null : null;
    }

    isTextSendChannel(channel) {
        return Boolean(channel?.isTextBased?.() && typeof channel.send === 'function');
    }

    async fetchGuildChannel(guild, channelId) {
        if (!guild || !channelId) return null;

        const cached = guild.channels.cache.get(channelId);
        if (cached) return cached;

        return this.client.channels.fetch(channelId).catch(() => null);
    }

    async openBuilderFromMessage(message, context) {
        await this.cleanupExpiredSessions();

        if (!message.guild) {
            await message.reply('`abc.embed` can only be used inside a server.');
            return true;
        }

        if (!this.isAuthorized({
            userId: message.author.id,
            member: message.member,
            config: context.config,
            allowedDevs: context.allowedDevs
        })) {
            await message.reply("⛔ Access Denied. Administrators or trusted bot staff only.");
            return true;
        }

        const ownerKey = this.makeOwnerKey(message.guildId, message.author.id);
        const existingSessionId = this.ownerSessions.get(ownerKey);
        if (existingSessionId) {
            const existingSession = this.sessions.get(existingSessionId);
            if (existingSession) {
                await this.closeSession(existingSession, 'Replaced by a newer embed builder session.');
            }
        }

        const session = this.createSession(message);
        this.sessions.set(session.id, session);
        this.ownerSessions.set(ownerKey, session.id);

        const controlMessage = await message.reply(this.buildControlMessagePayload(session));
        session.controlMessageId = controlMessage.id;
        this.controlMessageToSession.set(controlMessage.id, session.id);

        await this.updateControlMessage(session);
        return true;
    }

    buildControlMessagePayload(session, options = {}) {
        const { closedReason = null, componentsDisabled = false } = options;
        const channelText = session.payload.targetChannelId ? `<#${session.payload.targetChannelId}>` : '`not selected`';
        const contentPreview = session.payload.content
            ? this.truncateText(session.payload.content, MAX_CONTENT_PREVIEW_LENGTH)
            : '`none`';
        const promptText = 'Use the section buttons below to edit the draft in modals.';
        const allowedMentionsText = this.describeAllowedMentions(session.payload.allowedMentions);
        const embedSnapshot = [
            `Title: ${session.payload.embed.title ? '`set`' : '`empty`'}`,
            `Description: ${session.payload.embed.description ? `\`${session.payload.embed.description.length} chars\`` : '`empty`'}`,
            `Color: \`${session.payload.embed.color || DEFAULT_EMBED_COLOR}\``,
            `Fields: \`${session.payload.embed.fields.length}/${MAX_FIELDS}\``,
            `Author: ${session.payload.embed.authorName ? '`set`' : '`empty`'}`,
            `Footer: ${session.payload.embed.footerText ? '`set`' : '`empty`'}`,
            `Thumbnail: ${session.payload.embed.thumbnailUrl ? '`set`' : '`empty`'}`,
            `Image: ${session.payload.embed.imageUrl ? '`set`' : '`empty`'}`,
            `Timestamp: ${this.describeTimestamp(session.payload.embed.timestamp)}`
        ].join('\n');

        const infoEmbed = new EmbedBuilder()
            .setColor('#1D4ED8')
            .setTitle('abc.embed Builder')
            .setDescription(
                [
                    'Use the channel picker to choose where the finished embed should be posted.',
                    'Use the section buttons to open guided editors without modals.',
                    'For edge-case control, choose **Raw JSON Import** and paste a full Discord message payload or a single embed object.'
                ].join('\n')
            )
            .addFields(
                { name: 'Target Channel', value: channelText, inline: true },
                { name: 'TTS', value: session.payload.tts ? '`on`' : '`off`', inline: true },
                { name: 'Allowed Mentions', value: allowedMentionsText, inline: true },
                { name: 'Message Content', value: contentPreview, inline: false },
                { name: 'Embed Snapshot', value: embedSnapshot, inline: false },
                { name: 'Status', value: closedReason || promptText, inline: false }
            )
            .setFooter({ text: `Builder owner: ${session.ownerTag}` })
            .setTimestamp(new Date(session.createdAt));

        return {
            content: closedReason ? `Embed builder closed. ${closedReason}` : `Embed control panel for <@${session.ownerId}>`,
            embeds: [infoEmbed, this.buildPreviewEmbed(session)],
            components: componentsDisabled ? [] : this.buildComponentRows(session)
        };
    }

    buildPreviewEmbed(session) {
        const embedState = session.payload.embed;
        if (!this.hasVisibleEmbedContent(embedState)) {
            return new EmbedBuilder()
                .setColor(DEFAULT_EMBED_COLOR)
                .setTitle('Live Preview')
                .setDescription(
                    session.payload.content
                        ? 'This message currently only has plain message content. Use the section buttons below to preview embed sections here.'
                        : 'No embed content has been configured yet. Use one of the section buttons below to start building.'
                );
        }

        const embed = new EmbedBuilder();
        if (embedState.color) embed.setColor(embedState.color);
        if (embedState.title) embed.setTitle(embedState.title);
        if (embedState.description) embed.setDescription(embedState.description);
        if (embedState.url) embed.setURL(embedState.url);
        if (embedState.authorName) {
            embed.setAuthor({
                name: embedState.authorName,
                ...(embedState.authorUrl ? { url: embedState.authorUrl } : {}),
                ...(embedState.authorIconUrl ? { iconURL: embedState.authorIconUrl } : {})
            });
        }
        if (embedState.thumbnailUrl) embed.setThumbnail(embedState.thumbnailUrl);
        if (embedState.imageUrl) embed.setImage(embedState.imageUrl);
        if (embedState.footerText || embedState.footerIconUrl) {
            embed.setFooter({
                text: embedState.footerText || ' ',
                ...(embedState.footerIconUrl ? { iconURL: embedState.footerIconUrl } : {})
            });
        }
        if (embedState.timestamp) {
            const timestamp = embedState.timestamp === 'NOW' ? new Date() : new Date(embedState.timestamp);
            if (!Number.isNaN(timestamp.valueOf())) {
                embed.setTimestamp(timestamp);
            }
        }
        if (embedState.fields.length > 0) {
            embed.addFields(embedState.fields);
        }

        return embed;
    }

    buildComponentRows(session) {
        const channelRow = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`embed_builder:channel:${session.id}`)
                .setPlaceholder('Pick the channel that should receive the embed')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        );

        const sectionRowOne = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_builder:basics:${session.id}`)
                .setLabel('Basics')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:author:${session.id}`)
                .setLabel('Author')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:footer:${session.id}`)
                .setLabel('Footer')
                .setStyle(ButtonStyle.Primary)
        );

        const sectionRowTwo = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_builder:media:${session.id}`)
                .setLabel('Media')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:fields:${session.id}`)
                .setLabel('Fields')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:json:${session.id}`)
                .setLabel('Raw JSON')
                .setStyle(ButtonStyle.Secondary)
        );

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`embed_builder:tts:${session.id}`)
                .setLabel(session.payload.tts ? 'TTS: On' : 'TTS: Off')
                .setStyle(session.payload.tts ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:post:${session.id}`)
                .setLabel('Post Embed')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`embed_builder:reset:${session.id}`)
                .setLabel('Reset Draft')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`embed_builder:close:${session.id}`)
                .setLabel('Close Builder')
                .setStyle(ButtonStyle.Danger)
        );

        return [channelRow, sectionRowOne, sectionRowTwo, actionRow];
    }

    hasVisibleEmbedContent(embedState) {
        return Boolean(
            embedState.title ||
            embedState.description ||
            embedState.url ||
            embedState.authorName ||
            embedState.authorUrl ||
            embedState.authorIconUrl ||
            embedState.thumbnailUrl ||
            embedState.imageUrl ||
            embedState.footerText ||
            embedState.footerIconUrl ||
            embedState.timestamp ||
            embedState.fields.length
        );
    }

    async updateControlMessage(session) {
        if (!session?.controlMessageId || session.closed) return;
        const guild = this.client.guilds.cache.get(session.guildId);
        const controlChannel = await this.fetchGuildChannel(guild, session.controlChannelId);
        if (!controlChannel || !this.isTextSendChannel(controlChannel)) return;

        const controlMessage = await controlChannel.messages.fetch(session.controlMessageId).catch(() => null);
        if (!controlMessage) return;

        await controlMessage.edit(this.buildControlMessagePayload(session)).catch(() => {});
    }

    async closeSession(sessionOrId, reason) {
        const session = typeof sessionOrId === 'string' ? this.sessions.get(sessionOrId) : sessionOrId;
        if (!session || session.closed) return;

        session.closed = true;
        session.awaitingInput = null;
        await this.deletePromptMessage(session);

        const ownerKey = this.makeOwnerKey(session.guildId, session.ownerId);
        if (this.ownerSessions.get(ownerKey) === session.id) {
            this.ownerSessions.delete(ownerKey);
        }

        if (session.controlMessageId) {
            this.controlMessageToSession.delete(session.controlMessageId);
        }

        const guild = this.client.guilds.cache.get(session.guildId);
        const channel = await this.fetchGuildChannel(guild, session.controlChannelId);
        if (channel && this.isTextSendChannel(channel) && session.controlMessageId) {
            const controlMessage = await channel.messages.fetch(session.controlMessageId).catch(() => null);
            if (controlMessage) {
                await controlMessage.edit(
                    this.buildControlMessagePayload(session, {
                        closedReason: reason || 'Closed.',
                        componentsDisabled: true
                    })
                ).catch(() => {});
            }
        }

        this.sessions.delete(session.id);
    }

    async deletePromptMessage(session) {
        if (!session?.promptMessageId) return;

        const guild = this.client.guilds.cache.get(session.guildId);
        const channel = await this.fetchGuildChannel(guild, session.controlChannelId);
        if (channel && this.isTextSendChannel(channel)) {
            const promptMessage = await channel.messages.fetch(session.promptMessageId).catch(() => null);
            if (promptMessage) {
                await promptMessage.delete().catch(() => {});
            }
        }

        this.promptMessageToSession.delete(session.promptMessageId);
        session.promptMessageId = null;
    }

    getSectionLabel(type) {
        switch (type) {
            case 'basics': return 'Basics & Content';
            case 'author': return 'Author Block';
            case 'footer': return 'Footer & Timestamp';
            case 'media': return 'Media';
            case 'fields': return 'Fields';
            case 'json': return 'Raw JSON Import';
            default: return 'Embed Section';
        }
    }

    buildTextInput(customId, label, style, value, options = {}) {
        const input = new TextInputBuilder()
            .setCustomId(customId)
            .setLabel(label)
            .setStyle(style)
            .setRequired(Boolean(options.required));

        if (options.placeholder) input.setPlaceholder(options.placeholder);
        const clampedMaxLength = typeof options.maxLength === 'number'
            ? Math.max(1, Math.min(options.maxLength, MODAL_TEXT_INPUT_MAX_LENGTH))
            : null;
        const clampedMinLength = typeof options.minLength === 'number'
            ? Math.max(0, Math.min(options.minLength, clampedMaxLength ?? MODAL_TEXT_INPUT_MAX_LENGTH))
            : null;
        if (clampedMaxLength !== null) input.setMaxLength(clampedMaxLength);
        if (clampedMinLength !== null) input.setMinLength(clampedMinLength);

        const safeValue = this.fitModalValue(value, clampedMaxLength ?? MODAL_TEXT_INPUT_MAX_LENGTH);
        if (safeValue) input.setValue(safeValue);

        return new ActionRowBuilder().addComponents(input);
    }

    fitModalValue(value, maxLength) {
        const text = String(value || '');
        if (!text) return '';
        return text.length > maxLength ? text.slice(0, maxLength) : text;
    }

    buildSectionModal(section, session) {
        const modal = new ModalBuilder()
            .setCustomId(`embed_builder_modal:${section}:${session.id}`)
            .setTitle(this.getSectionLabel(section));
        const embedState = session.payload.embed;

        if (section === 'basics') {
            modal.addComponents(
                this.buildTextInput('title', 'Embed Title', TextInputStyle.Short, embedState.title, { maxLength: MAX_TITLE_LENGTH }),
                this.buildTextInput('description', 'Description', TextInputStyle.Paragraph, embedState.description, { maxLength: MAX_DESCRIPTION_LENGTH }),
                this.buildTextInput('color', 'Hex Color', TextInputStyle.Short, embedState.color || DEFAULT_EMBED_COLOR, { placeholder: '#8B5CF6', maxLength: 7 }),
                this.buildTextInput('url', 'Embed URL', TextInputStyle.Short, embedState.url, { placeholder: 'https://example.com', maxLength: 1000 }),
                this.buildTextInput('content', 'Message Content', TextInputStyle.Paragraph, session.payload.content, { placeholder: 'Leave empty to keep message content blank.', maxLength: MAX_CONTENT_LENGTH })
            );
            return modal;
        }

        if (section === 'author') {
            modal.addComponents(
                this.buildTextInput('author_name', 'Author Name', TextInputStyle.Short, embedState.authorName, { maxLength: MAX_AUTHOR_LENGTH }),
                this.buildTextInput('author_url', 'Author URL', TextInputStyle.Short, embedState.authorUrl, { placeholder: 'https://example.com', maxLength: 1000 }),
                this.buildTextInput('author_icon', 'Author Icon URL', TextInputStyle.Short, embedState.authorIconUrl, { placeholder: 'https://example.com/icon.png', maxLength: 1000 })
            );
            return modal;
        }

        if (section === 'footer') {
            modal.addComponents(
                this.buildTextInput('footer_text', 'Footer Text', TextInputStyle.Paragraph, embedState.footerText, { maxLength: MAX_FOOTER_LENGTH }),
                this.buildTextInput('footer_icon', 'Footer Icon URL', TextInputStyle.Short, embedState.footerIconUrl, { placeholder: 'https://example.com/footer.png', maxLength: 1000 }),
                this.buildTextInput('timestamp', 'Timestamp', TextInputStyle.Short, embedState.timestamp === 'NOW' ? 'now' : (embedState.timestamp || ''), { placeholder: 'off, now, or 2026-04-01T20:15:00Z', maxLength: 1000 })
            );
            return modal;
        }

        if (section === 'media') {
            modal.addComponents(
                this.buildTextInput('thumbnail', 'Thumbnail URL', TextInputStyle.Short, embedState.thumbnailUrl, { placeholder: 'https://example.com/thumb.png', maxLength: 1000 }),
                this.buildTextInput('image', 'Image URL', TextInputStyle.Short, embedState.imageUrl, { placeholder: 'https://example.com/banner.png', maxLength: 1000 })
            );
            return modal;
        }

        if (section === 'fields') {
            modal.addComponents(
                this.buildTextInput(
                    'fields',
                    'Fields Block',
                    TextInputStyle.Paragraph,
                    this.serializeFieldsForModal(embedState.fields),
                    {
                        placeholder: 'Use name/value/inline blocks. Enter clear to wipe all fields.',
                        maxLength: 4000
                    }
                )
            );
            return modal;
        }

        modal.addComponents(
            this.buildTextInput(
                'json',
                'JSON Payload',
                TextInputStyle.Paragraph,
                '',
                {
                    placeholder: '{"content":"Update","embeds":[{"title":"Patch Notes"}]}',
                    maxLength: 4000
                }
            )
        );
        return modal;
    }

    serializeFieldsForModal(fields) {
        if (!fields?.length) return '';
        return fields.map(field => [
            `name: ${field.name}`,
            `value: ${field.value}`,
            `inline: ${field.inline ? 'true' : 'false'}`
        ].join('\n')).join('\n\n');
    }

    async handleInteraction(interaction) {
        if (
            !interaction.isButton() &&
            !interaction.isChannelSelectMenu() &&
            !interaction.isModalSubmit()
        ) {
            return false;
        }

        const isBuilderComponent = interaction.customId.startsWith('embed_builder:');
        const isBuilderModal = interaction.customId.startsWith('embed_builder_modal:');
        if (!isBuilderComponent && !isBuilderModal) {
            return false;
        }

        await this.cleanupExpiredSessions();

        const idParts = interaction.customId.split(':');
        const action = idParts[1];
        const sessionId = idParts[2];
        const session = this.sessions.get(sessionId);
        if (!session || session.closed || this.isSessionExpired(session)) {
            await interaction.reply({ content: 'That embed builder session has expired. Run `abc.embed` again to start over.', ephemeral: true });
            if (session) {
                await this.closeSession(session, 'Builder expired after 30 minutes of inactivity.');
            }
            return true;
        }

        if (interaction.user.id !== session.ownerId) {
            await interaction.reply({ content: 'Only the admin who opened this embed builder can use it.', ephemeral: true });
            return true;
        }

        this.touchSession(session);

        if (interaction.isModalSubmit()) {
            await this.handleSectionModalSubmit(interaction, session, action);
            return true;
        }

        if (action === 'channel') {
            await this.handleChannelPicker(interaction, session);
            return true;
        }

        if (['basics', 'author', 'footer', 'media', 'fields', 'json'].includes(action)) {
            await this.handleSectionButton(interaction, session, action);
            return true;
        }

        if (action === 'tts') {
            await this.handleTtsToggle(interaction, session);
            return true;
        }

        if (action === 'post') {
            await this.handlePost(interaction, session);
            return true;
        }

        if (action === 'reset') {
            await this.handleReset(interaction, session);
            return true;
        }

        if (action === 'close') {
            await interaction.reply({ content: 'Embed builder closed.', ephemeral: true });
            await this.closeSession(session, 'Closed by the builder owner.');
            return true;
        }

        await interaction.reply({ content: 'Unknown embed builder action.', ephemeral: true });
        return true;
    }

    async handleChannelPicker(interaction, session) {
        const channelId = interaction.values[0];
        const channel = await this.fetchGuildChannel(interaction.guild, channelId);

        if (!channel || !this.isTextSendChannel(channel) || channel.guildId !== interaction.guildId) {
            await interaction.reply({ content: 'Please choose a text channel from this server.', ephemeral: true });
            return;
        }

        session.payload.targetChannelId = channel.id;
        await this.updateControlMessage(session);
        await interaction.reply({ content: `Target channel updated to ${channel}.`, ephemeral: true });
    }

    async handleSectionButton(interaction, session, action) {
        await interaction.showModal(this.buildSectionModal(action, session));
    }

    async handleSectionModalSubmit(interaction, session, section) {
        try {
            await this.applyModalInput(session, section, interaction);
            await this.updateControlMessage(session);
            await interaction.reply({ content: `${this.getSectionLabel(section)} updated.`, ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: `I couldn't apply that modal: ${error.message}`, ephemeral: true });
        }
    }

    async handleTtsToggle(interaction, session) {
        session.payload.tts = !session.payload.tts;
        await this.updateControlMessage(session);
        await interaction.reply({
            content: `Text-to-speech is now ${session.payload.tts ? '`enabled`' : '`disabled`'}.`,
            ephemeral: true
        });
    }

    async handlePost(interaction, session) {
        try {
            const targetChannel = await this.fetchGuildChannel(interaction.guild, session.payload.targetChannelId);
            if (!targetChannel || !this.isTextSendChannel(targetChannel)) {
                throw new Error('Pick a valid text channel before posting.');
            }

            const memberMe = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
            const permissions = memberMe ? targetChannel.permissionsFor(memberMe) : null;
            if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
                throw new Error(`I cannot view ${targetChannel}.`);
            }
            if (!permissions.has(PermissionsBitField.Flags.SendMessages)) {
                throw new Error(`I cannot send messages in ${targetChannel}.`);
            }
            if (this.hasVisibleEmbedContent(session.payload.embed) && !permissions.has(PermissionsBitField.Flags.EmbedLinks)) {
                throw new Error(`I need the Embed Links permission in ${targetChannel}.`);
            }

            const payload = this.buildSendPayload(session);
            const sentMessage = await targetChannel.send(payload);
            await interaction.reply({
                content: `✅ Embed posted to ${targetChannel}. [Jump to message](${sentMessage.url})`,
                ephemeral: true
            });
        } catch (error) {
            await interaction.reply({ content: `Failed to post the embed: ${error.message}`, ephemeral: true });
        }
    }

    async handleReset(interaction, session) {
        const channelId = session.payload.targetChannelId || session.controlChannelId;
        session.payload = this.createDefaultEmbedState(channelId);
        session.awaitingInput = null;
        await this.deletePromptMessage(session);
        await this.updateControlMessage(session);
        await interaction.reply({ content: 'The embed draft has been reset.', ephemeral: true });
    }

    buildSendPayload(session) {
        const payload = {};
        if (session.payload.content) payload.content = session.payload.content;
        if (session.payload.tts) payload.tts = true;
        if (session.payload.allowedMentions) payload.allowedMentions = session.payload.allowedMentions;
        if (this.hasVisibleEmbedContent(session.payload.embed)) {
            payload.embeds = [this.buildPreviewEmbed(session).toJSON()];
        }

        if (!payload.content && !payload.embeds?.length) {
            throw new Error('The message is empty. Add message content or at least one embed field before posting.');
        }

        return payload;
    }

    async handlePendingInput(message) {
        return false;
    }

    async applyModalInput(session, type, interaction) {
        if (type === 'basics') {
            session.payload.embed.title = this.normalizeNullableText(interaction.fields.getTextInputValue('title'), MAX_TITLE_LENGTH);
            session.payload.embed.description = this.normalizeNullableText(interaction.fields.getTextInputValue('description'), MAX_DESCRIPTION_LENGTH);
            session.payload.embed.color = this.normalizeColor(interaction.fields.getTextInputValue('color'), true) || DEFAULT_EMBED_COLOR;
            session.payload.embed.url = this.normalizeUrl(interaction.fields.getTextInputValue('url'), true);
            session.payload.content = this.normalizeNullableText(interaction.fields.getTextInputValue('content'), MAX_CONTENT_LENGTH);
            return;
        }

        if (type === 'author') {
            session.payload.embed.authorName = this.normalizeNullableText(interaction.fields.getTextInputValue('author_name'), MAX_AUTHOR_LENGTH);
            session.payload.embed.authorUrl = this.normalizeUrl(interaction.fields.getTextInputValue('author_url'), true);
            session.payload.embed.authorIconUrl = this.normalizeUrl(interaction.fields.getTextInputValue('author_icon'), true);
            return;
        }

        if (type === 'footer') {
            session.payload.embed.footerText = this.normalizeNullableText(interaction.fields.getTextInputValue('footer_text'), MAX_FOOTER_LENGTH);
            session.payload.embed.footerIconUrl = this.normalizeUrl(interaction.fields.getTextInputValue('footer_icon'), true);
            session.payload.embed.timestamp = this.normalizeTimestamp(interaction.fields.getTextInputValue('timestamp'));
            return;
        }

        if (type === 'media') {
            session.payload.embed.thumbnailUrl = this.normalizeUrl(interaction.fields.getTextInputValue('thumbnail'), true);
            session.payload.embed.imageUrl = this.normalizeUrl(interaction.fields.getTextInputValue('image'), true);
            return;
        }

        if (type === 'fields') {
            session.payload.embed.fields = this.parseFieldBlocks(interaction.fields.getTextInputValue('fields'));
            return;
        }

        if (type === 'json') {
            this.applyRawJson(session, interaction.fields.getTextInputValue('json'));
            return;
        }

        throw new Error('Unknown builder modal type.');
    }

    applyRawJson(session, rawInput) {
        let parsed;
        try {
            parsed = JSON.parse(this.stripCodeFence(rawInput));
        } catch (error) {
            throw new Error(`JSON parsing failed: ${error.message}`);
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Please provide a JSON object.');
        }

        const hasMessageKeys = ['content', 'embed', 'embeds', 'allowedMentions', 'allowed_mentions', 'tts'].some(key => key in parsed);
        const nextPayload = hasMessageKeys ? parsed : { embed: parsed };

        if ('content' in nextPayload) {
            session.payload.content = this.normalizeNullableText(nextPayload.content, MAX_CONTENT_LENGTH);
        }
        if ('tts' in nextPayload) {
            session.payload.tts = Boolean(nextPayload.tts);
        }
        if ('allowedMentions' in nextPayload || 'allowed_mentions' in nextPayload) {
            session.payload.allowedMentions = this.normalizeAllowedMentions(nextPayload.allowedMentions || nextPayload.allowed_mentions);
        }

        const hasEmbedKey = Object.prototype.hasOwnProperty.call(nextPayload, 'embed') || Object.prototype.hasOwnProperty.call(nextPayload, 'embeds');
        const embedSource = nextPayload.embed || (Array.isArray(nextPayload.embeds) ? nextPayload.embeds[0] : null);
        if (hasEmbedKey) {
            session.payload.embed = embedSource
                ? this.normalizeEmbedObject(embedSource)
                : this.createDefaultEmbedState(session.payload.targetChannelId).embed;
        }
    }

    normalizeEmbedObject(embedSource) {
        const fields = Array.isArray(embedSource.fields) ? embedSource.fields : [];
        const author = embedSource.author || {};
        const footer = embedSource.footer || {};
        const thumbnail = embedSource.thumbnail || {};
        const image = embedSource.image || {};

        return {
            title: this.normalizeNullableText(embedSource.title, MAX_TITLE_LENGTH),
            description: this.normalizeNullableText(embedSource.description, MAX_DESCRIPTION_LENGTH),
            color: this.normalizeColor(embedSource.color, true) || DEFAULT_EMBED_COLOR,
            url: this.normalizeUrl(embedSource.url, true),
            authorName: this.normalizeNullableText(author.name, MAX_AUTHOR_LENGTH),
            authorUrl: this.normalizeUrl(author.url, true),
            authorIconUrl: this.normalizeUrl(author.iconURL || author.icon_url, true),
            thumbnailUrl: this.normalizeUrl(thumbnail.url, true),
            imageUrl: this.normalizeUrl(image.url, true),
            footerText: this.normalizeNullableText(footer.text, MAX_FOOTER_LENGTH),
            footerIconUrl: this.normalizeUrl(footer.iconURL || footer.icon_url, true),
            timestamp: this.normalizeTimestamp(embedSource.timestamp),
            fields: fields.slice(0, MAX_FIELDS).map(field => ({
                name: this.requireText(field.name, 'Field names are required.', MAX_FIELD_NAME_LENGTH),
                value: this.requireText(field.value, 'Field values are required.', MAX_FIELD_VALUE_LENGTH),
                inline: Boolean(field.inline)
            }))
        };
    }

    normalizeAllowedMentions(value) {
        if (value == null) return null;
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('`allowedMentions` must be a JSON object.');
        }

        const normalized = {};
        if (Array.isArray(value.parse)) {
            normalized.parse = value.parse.filter(entry => ['roles', 'users', 'everyone'].includes(entry));
        }
        if (Array.isArray(value.roles)) {
            normalized.roles = value.roles.map(roleId => String(roleId)).filter(Boolean);
        }
        if (Array.isArray(value.users)) {
            normalized.users = value.users.map(userId => String(userId)).filter(Boolean);
        }
        if ('repliedUser' in value || 'replied_user' in value) {
            normalized.repliedUser = Boolean(value.repliedUser ?? value.replied_user);
        }

        return normalized;
    }

    parseFieldBlocks(input) {
        const lowered = input.trim().toLowerCase();
        if (['clear', 'none', 'reset'].includes(lowered)) {
            return [];
        }

        const blocks = input.split(/\r?\n\s*\r?\n/).filter(block => block.trim());
        if (blocks.length > MAX_FIELDS) {
            throw new Error(`Discord only allows ${MAX_FIELDS} embed fields.`);
        }

        return blocks.map(block => {
            const values = this.parseKeyValueBlock(block, ['name', 'value', 'inline']);
            if (!('name' in values) || !('value' in values)) {
                throw new Error('Every field block needs both `name:` and `value:`.');
            }

            return {
                name: this.requireText(values.name, 'Field names cannot be empty.', MAX_FIELD_NAME_LENGTH),
                value: this.requireText(values.value, 'Field values cannot be empty.', MAX_FIELD_VALUE_LENGTH),
                inline: 'inline' in values ? this.normalizeBoolean(values.inline) : false
            };
        });
    }

    parseKeyValueBlock(input, allowedKeys) {
        const lines = input.replace(/\r/g, '').split('\n');
        const values = {};
        let currentKey = null;

        for (const line of lines) {
            const match = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
            if (match) {
                const key = match[1].toLowerCase();
                if (!allowedKeys.includes(key)) {
                    throw new Error(`Unknown key \`${key}\`. Valid keys: ${allowedKeys.join(', ')}.`);
                }
                currentKey = key;
                values[key] = match[2];
                continue;
            }

            if (!currentKey) {
                if (line.trim()) {
                    throw new Error(`Line \`${line}\` does not belong to a recognized key.`);
                }
                continue;
            }

            values[currentKey] = values[currentKey]
                ? `${values[currentKey]}\n${line}`
                : line;
        }

        return values;
    }

    normalizeNullableText(value, maxLength) {
        if (value == null) return '';
        const text = String(value).trim();
        if (!text || ['none', 'clear', 'null'].includes(text.toLowerCase())) return '';
        if (text.length > maxLength) {
            throw new Error(`That value is too long. Maximum length: ${maxLength} characters.`);
        }
        return text;
    }

    requireText(value, message, maxLength) {
        const text = this.normalizeNullableText(value, maxLength);
        if (!text) throw new Error(message);
        return text;
    }

    normalizeUrl(value, allowEmpty = false) {
        if (value == null) return allowEmpty ? '' : null;
        const text = String(value).trim();
        if (!text || ['none', 'clear', 'null'].includes(text.toLowerCase())) {
            return allowEmpty ? '' : null;
        }

        let url;
        try {
            url = new URL(text);
        } catch (error) {
            throw new Error(`Invalid URL: ${text}`);
        }

        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error(`Only http and https URLs are supported: ${text}`);
        }

        return url.toString();
    }

    normalizeColor(value, allowEmpty = false) {
        if (value == null || value === '') {
            return allowEmpty ? '' : DEFAULT_EMBED_COLOR;
        }

        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) {
            return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
        }

        const text = String(value).trim();
        if (!text || ['none', 'clear', 'null'].includes(text.toLowerCase())) {
            return allowEmpty ? '' : DEFAULT_EMBED_COLOR;
        }

        const hex = text.startsWith('#') ? text : `#${text}`;
        if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
            throw new Error('Colors must be a 6-digit hex code like `#DC2626`.');
        }

        return hex.toUpperCase();
    }

    normalizeBoolean(value) {
        if (typeof value === 'boolean') return value;

        const text = String(value).trim().toLowerCase();
        if (['true', 'yes', 'y', 'on', 'inline'].includes(text)) return true;
        if (['false', 'no', 'n', 'off', 'block', 'stacked'].includes(text)) return false;
        throw new Error(`Couldn't understand boolean value \`${value}\`. Use yes/no, true/false, or on/off.`);
    }

    normalizeTimestamp(value) {
        if (value == null) return null;
        if (value === 'NOW') return 'NOW';

        const text = String(value).trim();
        if (!text || ['none', 'clear', 'null', 'off', 'false'].includes(text.toLowerCase())) return null;
        if (['now', 'current', 'today'].includes(text.toLowerCase())) return 'NOW';

        const date = new Date(text);
        if (Number.isNaN(date.valueOf())) {
            throw new Error('Timestamp must be `off`, `now`, or a valid ISO date/time.');
        }

        return date.toISOString();
    }

    truncateText(text, maxLength) {
        if (!text || text.length <= maxLength) return text;
        return `${text.slice(0, maxLength - 3)}...`;
    }

    stripCodeFence(value) {
        const text = String(value || '').trim();
        const match = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)```$/);
        return match ? match[1].trim() : text;
    }

    describeAllowedMentions(allowedMentions) {
        if (!allowedMentions) return '`default`';

        const parse = Array.isArray(allowedMentions.parse) ? allowedMentions.parse : [];
        if (parse.length === 0 && !allowedMentions.roles?.length && !allowedMentions.users?.length) {
            return '`none`';
        }

        const pieces = [];
        if (parse.length) pieces.push(`parse=${parse.join(',')}`);
        if (allowedMentions.roles?.length) pieces.push(`roles=${allowedMentions.roles.length}`);
        if (allowedMentions.users?.length) pieces.push(`users=${allowedMentions.users.length}`);
        if ('repliedUser' in allowedMentions) pieces.push(`repliedUser=${allowedMentions.repliedUser}`);
        return `\`${pieces.join(' | ')}\``;
    }

    describeTimestamp(timestamp) {
        if (!timestamp) return '`off`';
        if (timestamp === 'NOW') return '`now`';
        return `\`${timestamp}\``;
    }
}

module.exports = {
    EmbedBuilderCog
};
