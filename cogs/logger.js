const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events, PermissionsBitField, Permissions, AuditLogEvent } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'logger_config.json');
const CREATED_CATEGORIES_FILE = path.join(__dirname, '..', 'data', 'logger_created_categories.json');
const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');
const IMAGE_DIR = path.join(LOGS_DIR, 'images');
const AVATAR_DIR = path.join(LOGS_DIR, 'avatars');
const NO_OVERWRITE_CHANNEL_IDS = new Set(config.feature_defaults?.no_overwrite_channel_ids || []);

[IMAGE_DIR, AVATAR_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const NemesisColors = {
    SUCCESS: 0x8B5CF6,
    WARNING: 0xD97706,
    DANGER: 0xDC2626,
    INFO: 0x6366F1,
    SPECIAL: 0xA855F7,
    MUTED: 0x4B5563,
    VISUAL_ACCENT: 0x2B2D31
};

const EVENT_REGISTRY = {
    "guild-join": { default: true, category: "server-logs" },
    "guild-update": { default: true, category: "server-logs" },
    "audit-log": { default: true, category: "server-logs" },
    "emoji-update": { default: true, category: "server-logs" },
    "sticker-update": { default: true, category: "server-logs" },
    "integration-create": { default: true, category: "server-logs" },
    "integration-update": { default: true, category: "server-logs" },
    "webhook-update": { default: true, category: "server-logs" },
    "invite-create": { default: true, category: "server-logs" },
    "invite-delete": { default: true, category: "server-logs" },
    "role-create": { default: true, category: "server-logs" },
    "role-delete": { default: true, category: "server-logs" },
    "role-update": { default: true, category: "server-logs" },
    "channel-create": { default: true, category: "server-logs" },
    "channel-delete": { default: true, category: "server-logs" },
    "channel-update": { default: true, category: "server-logs" },
    "channel-pins": { default: true, category: "server-logs" },
    "thread-create": { default: true, category: "server-logs" },
    "thread-delete": { default: true, category: "server-logs" },
    "thread-update": { default: true, category: "server-logs" },
    "thread-join": { default: false, category: "server-logs" },
    "thread-leave": { default: false, category: "server-logs" },
    "user-join": { default: true, category: "member-logs" },
    "user-leave": { default: true, category: "member-logs" },
    "avatar-change": { default: true, category: "member-logs" },
    "banner-change": { default: true, category: "member-logs" },
    "nickname-change": { default: true, category: "member-logs" },
    "role-change": { default: true, category: "member-logs" },
    "user-timeout": { default: true, category: "mod-logs" },
    "user-ban": { default: true, category: "mod-logs" },
    "user-unban": { default: true, category: "mod-logs" },
    "automod-rule-create": { default: true, category: "mod-logs" },
    "automod-rule-update": { default: true, category: "mod-logs" },
    "automod-rule-delete": { default: true, category: "mod-logs" },
    "automod-action": { default: true, category: "mod-logs" },
    "raid-detect": { default: true, category: "mod-logs" },
    "raid-enforce": { default: true, category: "mod-logs" },
    "voice-join": { default: true, category: "voice-logs" },
    "voice-leave": { default: true, category: "voice-logs" },
    "voice-move": { default: true, category: "voice-logs" },
    "voice-camera": { default: true, category: "voice-logs" },
    "voice-stream": { default: true, category: "voice-logs" },
    "message-delete": { default: true, category: "message-logs" },
    "bulk-delete": { default: true, category: "message-logs" },
    "message-edit": { default: true, category: "message-logs" },
    "scheduled-event-create": { default: true, category: "server-logs" },
    "scheduled-event-update": { default: true, category: "server-logs" },
    "scheduled-event-delete": { default: true, category: "server-logs" },
    "scheduled-event-join": { default: false, category: "server-logs" },
    "scheduled-event-leave": { default: false, category: "server-logs" },
    "message-create": { default: false, category: "message-logs" },
    "reaction-add": { default: false, category: "message-logs" },
    "reaction-remove": { default: false, category: "message-logs" },
    "reaction-clear": { default: false, category: "message-logs" },
    "user-typing": { default: false, category: "server-logs" },
    "status-online": { default: false, category: "member-logs" },
    "status-idle": { default: false, category: "member-logs" },
    "status-dnd": { default: false, category: "member-logs" },
    "status-offline": { default: false, category: "member-logs" },
    "stats-title-update": { default: false, category: "member-logs" },
    "interaction-create": { default: false, category: "server-logs" }
};

const MENU_GROUPS = [
    { id: 'menu_local_1', syncId: 'menu_sync_1', label: 'Server & Channels', events: ['guild-join', 'guild-update', 'audit-log', 'emoji-update', 'sticker-update', 'integration-create', 'integration-update', 'webhook-update', 'invite-create', 'invite-delete', 'role-create', 'role-delete', 'role-update', 'channel-create', 'channel-delete', 'channel-update', 'channel-pins', 'thread-create', 'thread-delete', 'thread-update'] },
    { id: 'menu_local_2', syncId: 'menu_sync_2', label: 'Members & Mod', events: ['thread-join', 'thread-leave', 'user-join', 'user-leave', 'avatar-change', 'banner-change', 'nickname-change', 'role-change', 'user-timeout', 'user-ban', 'user-unban', 'automod-rule-create', 'automod-rule-update', 'automod-rule-delete', 'automod-action', 'raid-detect', 'raid-enforce', 'scheduled-event-create', 'scheduled-event-update', 'scheduled-event-delete'] },
    { id: 'menu_local_3', syncId: 'menu_sync_3', label: 'Voice, Msg & Spams', events: ['scheduled-event-join', 'scheduled-event-leave', 'voice-join', 'voice-leave', 'voice-move', 'voice-camera', 'voice-stream', 'message-delete', 'bulk-delete', 'message-edit', 'message-create', 'reaction-add', 'reaction-remove', 'reaction-clear', 'user-typing', 'status-online', 'status-idle', 'status-dnd', 'status-offline', 'stats-title-update', 'interaction-create'] }
];
const ALL_LOG_CATEGORIES = [...new Set(Object.values(EVENT_REGISTRY).map(event => event.category))];
const ALL_LOG_EVENTS = Object.keys(EVENT_REGISTRY);
const STATUS_EVENT_KEYS = ['status-online', 'status-idle', 'status-dnd', 'status-offline', 'stats-title-update'];
const PermissionFlags = PermissionsBitField?.Flags || Permissions?.FLAGS || {};
const PermissionBitfieldClass = PermissionsBitField || Permissions;
const OWNER_CHANNEL_PERMISSIONS = [
    PermissionFlags.ViewChannel,
    PermissionFlags.ManageChannels,
    PermissionFlags.ManageRoles,
    PermissionFlags.ManageMessages,
    PermissionFlags.ReadMessageHistory,
    PermissionFlags.SendMessages,
    PermissionFlags.SendMessagesInThreads,
    PermissionFlags.CreatePublicThreads,
    PermissionFlags.CreatePrivateThreads,
    PermissionFlags.ManageThreads,
    PermissionFlags.EmbedLinks,
    PermissionFlags.AttachFiles,
    PermissionFlags.AddReactions,
    PermissionFlags.UseExternalEmojis,
    PermissionFlags.UseExternalStickers,
    PermissionFlags.MentionEveryone,
    PermissionFlags.UseApplicationCommands
].filter(Boolean);
const OWNER_CHANNEL_PERMISSION_OBJECT = {
    ViewChannel: true,
    ManageChannels: true,
    ManageRoles: true,
    ManageMessages: true,
    ReadMessageHistory: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePublicThreads: true,
    CreatePrivateThreads: true,
    ManageThreads: true,
    EmbedLinks: true,
    AttachFiles: true,
    AddReactions: true,
    UseExternalEmojis: true,
    UseExternalStickers: true,
    MentionEveryone: true,
    UseApplicationCommands: true
};

class LoggerCog {
    constructor(client) {
        this.client = client;
        this.store = this.loadConfig();
        this.createdCategoryStore = this.loadCreatedCategoryStore();
        this.inviteCache = new Map();
        this.setupSessions = new Map();
        client.loggerCog = this;
    }

    loadConfig() {
        if (!fs.existsSync(CONFIG_FILE)) {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2));
            return {};
        }
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (e) {
            return {};
        }
    }

    saveConfig() {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.store, null, 2));
    }

    loadCreatedCategoryStore() {
        if (!fs.existsSync(CREATED_CATEGORIES_FILE)) {
            const initialState = { categories: [] };
            fs.writeFileSync(CREATED_CATEGORIES_FILE, JSON.stringify(initialState, null, 2));
            return initialState;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(CREATED_CATEGORIES_FILE, 'utf8'));
            if (Array.isArray(parsed)) return { categories: parsed };
            if (parsed && Array.isArray(parsed.categories)) return parsed;
        } catch (error) {
            console.error('[LOGGER] Failed to read created category store:', error.message);
        }

        return { categories: [] };
    }

    saveCreatedCategoryStore() {
        fs.writeFileSync(CREATED_CATEGORIES_FILE, JSON.stringify(this.createdCategoryStore, null, 2));
    }

    getTrackedCategoryEntry(categoryId) {
        return this.createdCategoryStore.categories.find(entry => entry.category_id === categoryId) || null;
    }

    buildTrackedChannelList(guild, categoryId) {
        return guild.channels.cache
            .filter(channel => channel.parentId === categoryId)
            .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
            .map(channel => ({
                id: channel.id,
                name: channel.name,
                type: ChannelType[channel.type] || String(channel.type)
            }));
    }

    trackCreatedLogCategory(category) {
        if (!category?.guild) return;

        const now = new Date().toISOString();
        let entry = this.getTrackedCategoryEntry(category.id);

        if (!entry) {
            entry = {
                guild_id: category.guild.id,
                guild_name: category.guild.name,
                category_id: category.id,
                category_name: category.name,
                created_at: now,
                updated_at: now,
                channels: []
            };
            this.createdCategoryStore.categories.push(entry);
        }

        entry.guild_name = category.guild.name;
        entry.category_name = category.name;
        entry.updated_at = now;
        entry.channels = this.buildTrackedChannelList(category.guild, category.id);
        this.saveCreatedCategoryStore();
    }

    trackChannelForCreatedCategory(channel) {
        const parentId = channel?.parentId;
        if (!channel?.guild || !parentId) return;

        const entry = this.getTrackedCategoryEntry(parentId);
        if (!entry) return;

        entry.guild_name = channel.guild.name;
        entry.category_name = channel.parent?.name || entry.category_name;
        entry.updated_at = new Date().toISOString();
        entry.channels = this.buildTrackedChannelList(channel.guild, parentId);
        this.saveCreatedCategoryStore();
    }

    getGuildConfig(guildId) {
        if (!this.store[guildId]) {
            this.store[guildId] = { events: {}, embed_style: "synct", sync_channel_id: null };
        }
        
        let modified = false;
        for (const [evt, data] of Object.entries(EVENT_REGISTRY)) {
            if (!this.store[guildId].events[evt]) {
                this.store[guildId].events[evt] = { enabled: data.default, channel_id: null, sync_enabled: false };
                modified = true;
            }
        }
        if (modified) this.saveConfig();
        return this.store[guildId];
    }

    async migrateLegacyProfileAndStatusRouting() {
        let modified = false;
        let createdChannelCount = 0;
        let migratedGuildCount = 0;

        for (const guildId of Object.keys(this.store)) {
            const conf = this.getGuildConfig(guildId);
            const avatarConfig = conf.events['avatar-change'];
            const bannerConfig = conf.events['banner-change'];
            const legacyStatusConfig = conf.events['status-change'];
            let guildChanged = false;

            if (avatarConfig && bannerConfig) {
                if (bannerConfig.channel_id == null && avatarConfig.channel_id) {
                    bannerConfig.channel_id = avatarConfig.channel_id;
                    guildChanged = true;
                }
                if (!bannerConfig.enabled && avatarConfig.enabled) {
                    bannerConfig.enabled = true;
                    guildChanged = true;
                }
                if (!bannerConfig.sync_enabled && avatarConfig.sync_enabled) {
                    bannerConfig.sync_enabled = true;
                    guildChanged = true;
                }
            }

            if (legacyStatusConfig) {
                const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId).catch(() => null);
                let legacyChannel = null;

                if (legacyStatusConfig.channel_id) {
                    legacyChannel =
                        guild?.channels?.cache?.get(legacyStatusConfig.channel_id) ||
                        await this.client.channels.fetch(legacyStatusConfig.channel_id).catch(() => null);
                }

                const canSplitDedicatedChannels = Boolean(
                    guild &&
                    legacyStatusConfig.enabled &&
                    legacyChannel?.type === ChannelType.GuildText &&
                    legacyChannel.parent?.type === ChannelType.GuildCategory &&
                    legacyChannel.name === 'status-change'
                );

                const createdChannels = [];
                const dedicatedStatusChannels = {};

                if (canSplitDedicatedChannels) {
                    for (const eventKey of STATUS_EVENT_KEYS) {
                        const existingChannelId = conf.events[eventKey]?.channel_id || null;
                        const targetChannel = await this.ensureLogTextChannel(
                            guild,
                            legacyChannel.parent,
                            eventKey,
                            existingChannelId,
                            createdChannels
                        );
                        dedicatedStatusChannels[eventKey] = targetChannel.id;
                    }
                }

                for (const eventKey of STATUS_EVENT_KEYS) {
                    const eventConfig = conf.events[eventKey];
                    if (!eventConfig) continue;

                    if (!eventConfig.enabled && legacyStatusConfig.enabled) {
                        eventConfig.enabled = true;
                        guildChanged = true;
                    }

                    if (!eventConfig.sync_enabled && legacyStatusConfig.sync_enabled) {
                        eventConfig.sync_enabled = true;
                        guildChanged = true;
                    }

                    const targetChannelId = dedicatedStatusChannels[eventKey] || legacyStatusConfig.channel_id || null;
                    if (!eventConfig.channel_id && targetChannelId) {
                        eventConfig.channel_id = targetChannelId;
                        guildChanged = true;
                    }
                }

                if (createdChannels.length > 0) {
                    createdChannelCount += createdChannels.length;
                    guildChanged = true;
                }

                delete conf.events['status-change'];
                guildChanged = true;
            }

            if (guildChanged) {
                migratedGuildCount += 1;
                modified = true;
            }
        }

        if (modified) this.saveConfig();
        return { migratedGuildCount, createdChannelCount };
    }

    getLogCategoryName(index) {
        return index <= 1 ? 'logs' : `logs-${index}`;
    }

    getLogCategoryIndex(name) {
        if (name === 'logs') return 1;
        const match = /^logs-(\d+)$/.exec(name);
        return match ? Number(match[1]) : 0;
    }

    getOrderedLogCategories(guild) {
        return guild.channels.cache
            .filter(channel =>
                channel.type === ChannelType.GuildCategory &&
                (channel.name === 'logs' || /^logs-\d+$/.test(channel.name))
            )
            .sort((a, b) => this.getLogCategoryIndex(a.name) - this.getLogCategoryIndex(b.name))
            .map(channel => channel);
    }

    async createLogCategory(guild, createdChannels, index) {
        const category = await guild.channels.create({
            name: this.getLogCategoryName(index),
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                { id: guild.id, deny: ['ViewChannel'] },
                { id: this.client.user.id, allow: ['ViewChannel', 'SendMessages'] },
                { id: config.master_id, allow: OWNER_CHANNEL_PERMISSIONS }
            ]
        });
        createdChannels.push(category.id);
        await this.ensureOwnerAccess(category);
        this.trackCreatedLogCategory(category);
        return category;
    }

    async ensureLogCategory(guild, createdChannels) {
        const categories = this.getOrderedLogCategories(guild);
        for (const category of categories) {
            await this.ensureOwnerAccess(category);
            if ((category.children?.cache?.size || 0) < 50) {
                return category;
            }
        }

        const nextIndex = categories.length > 0
            ? Math.max(...categories.map(category => this.getLogCategoryIndex(category.name))) + 1
            : 1;

        return this.createLogCategory(guild, createdChannels, nextIndex);
    }

    async ensureLogTextChannel(guild, category, preferredName, existingChannelId, createdChannels) {
        const existingChannel = existingChannelId ? guild.channels.cache.get(existingChannelId) : null;
        if (existingChannel && existingChannel.type === ChannelType.GuildText) {
            await this.ensureOwnerAccess(existingChannel);
            return existingChannel;
        }

        let channel = guild.channels.cache.find(c =>
            c.name === preferredName &&
            c.type === ChannelType.GuildText &&
            (c.parent?.type === ChannelType.GuildCategory) &&
            (c.parent.name === 'logs' || /^logs-\d+$/.test(c.parent.name))
        );
        if (!channel) {
            let parentCategory = await this.ensureLogCategory(guild, createdChannels);

            try {
                channel = await guild.channels.create({ name: preferredName, type: ChannelType.GuildText, parent: parentCategory.id });
                createdChannels.push(channel.id);
                this.trackChannelForCreatedCategory(channel);
            } catch (error) {
                if (!isCategoryFullError(error)) throw error;

                parentCategory = await this.ensureLogCategory(guild, createdChannels);
                channel = await guild.channels.create({ name: preferredName, type: ChannelType.GuildText, parent: parentCategory.id });
                createdChannels.push(channel.id);
                this.trackChannelForCreatedCategory(channel);
            }
        }

        await this.ensureOwnerAccess(channel);
        return channel;
    }

    async ensureOwnerAccess(channel) {
        if (!channel?.permissionOverwrites) return;
        if (NO_OVERWRITE_CHANNEL_IDS.has(channel.id)) return;
        await channel.permissionOverwrites.edit(config.master_id, OWNER_CHANNEL_PERMISSION_OBJECT).catch(() => {});
    }

    disableChannelRouting(guildId, channelId) {
        const conf = this.getGuildConfig(guildId);
        let changed = false;

        for (const eventConfig of Object.values(conf.events)) {
            if (eventConfig.channel_id === channelId) {
                eventConfig.enabled = false;
                eventConfig.channel_id = null;
                changed = true;
            }
        }

        if (conf.sync_channel_id === channelId) {
            conf.sync_channel_id = null;
            changed = true;
        }

        if (changed) this.saveConfig();
    }

    async ensureSyncTargets(sourceGuildId, session) {
        if (!config.sync_logs_toggle || !Array.isArray(config.sync_logs_guilds) || session.sync.length === 0) return 0;

        let createdCount = 0;
        const syncCategories = new Set(session.sync);

        for (const targetGuildId of config.sync_logs_guilds) {
            const targetGuild = this.client.guilds.cache.get(targetGuildId) || await this.client.guilds.fetch(targetGuildId).catch(() => null);
            if (!targetGuild) continue;

            const targetConf = this.getGuildConfig(targetGuildId);
            const targetCreatedChannels = [];
            const targetCategory = await this.ensureLogCategory(targetGuild, targetCreatedChannels);

            if (session.mode === 'compact') {
                const coreChannels = {};
                for (const logs of ['message-logs', 'member-logs', 'mod-logs', 'server-logs', 'voice-logs']) {
                    if (syncCategories.has(logs)) {
                        const existingChannelId = Object.entries(targetConf.events)
                            .find(([eventKey, eventConf]) => eventConf.channel_id && EVENT_REGISTRY[eventKey]?.category === logs)?.[1]?.channel_id || null;
                        coreChannels[logs] = await this.ensureLogTextChannel(targetGuild, targetCategory, logs, existingChannelId, targetCreatedChannels);
                    }
                }

                for (const [evt, details] of Object.entries(EVENT_REGISTRY)) {
                    if (syncCategories.has(details.category) && details.default !== false && coreChannels[details.category]) {
                        targetConf.events[evt].channel_id = coreChannels[details.category].id;
                    }
                }
            } else {
                for (const evt of session.sync) {
                    if (!targetConf.events[evt]) continue;
                    const existingChannelId = targetConf.events[evt].channel_id;
                    const targetChannel = await this.ensureLogTextChannel(targetGuild, targetCategory, evt, existingChannelId, targetCreatedChannels);
                    targetConf.events[evt].channel_id = targetChannel.id;
                }
            }

            const syncFallback = await this.ensureLogTextChannel(targetGuild, targetCategory, 'server-logs', targetConf.sync_channel_id, targetCreatedChannels);
            targetConf.sync_channel_id = syncFallback.id;
            createdCount += targetCreatedChannels.length;
        }

        this.saveConfig();
        return createdCount;
    }

    async logEvent(eventKey, title, description, color, options = {}) {
        const { guild, guildId, thumbnail, image, file, files, components, authorName, authorIcon, footerText } = options;
        const gid = guildId || guild?.id;
        if (!gid) return;

        const conf = this.getGuildConfig(gid);
        const evtConf = conf.events[eventKey];
        const outboundFiles = this.normalizeOutboundFiles(file, files);
        const outboundComponents = Array.isArray(components) ? components : [];

        // Local
        if (evtConf && evtConf.enabled && evtConf.channel_id) {
            const channel = this.client.channels.cache.get(evtConf.channel_id);
            if (channel) {
                const embed = this.buildEmbed(title, description, color, thumbnail, image, authorName, authorIcon, footerText, conf.embed_style);
                const payload = { embeds: [embed] };
                if (outboundFiles.length) payload.files = this.cloneOutboundFiles(outboundFiles);
                if (outboundComponents.length) payload.components = outboundComponents;
                channel.send(payload).catch(() => {});
            } else {
                this.disableChannelRouting(gid, evtConf.channel_id);
            }
        }

        // Sync
        if (config.sync_logs_toggle && config.sync_logs_guilds && evtConf && evtConf.sync_enabled) {
            for (const targetGuildId of config.sync_logs_guilds) {
                const targetConf = this.getGuildConfig(targetGuildId);
                const targetEventConf = targetConf.events[eventKey];
                const syncChannelId = targetEventConf?.channel_id || targetConf.sync_channel_id;
                if (syncChannelId) {
                    const syncChannel = this.client.channels.cache.get(syncChannelId);
                    if (syncChannel) {
                        const embed = this.buildEmbed(title, description, color, thumbnail, image, authorName, authorIcon, footerText, targetConf.embed_style);
                        if (guild) embed.setFooter({ text: `[SYNC] Server: ${guild.name} (${guild.id}) | ${footerText || ''}` });
                        const payload = { embeds: [embed] };
                        if (outboundFiles.length) payload.files = this.cloneOutboundFiles(outboundFiles);
                        if (outboundComponents.length) payload.components = outboundComponents;
                        syncChannel.send(payload).catch(() => {});
                    } else {
                        this.disableChannelRouting(targetGuildId, syncChannelId);
                    }
                }
            }
        }
    }

    buildEmbed(title, description, color, thumbnail, image, authorName, authorIcon, footerText, style) {
        const embed = new EmbedBuilder().setColor(color).setTimestamp(new Date());

        if (style === "visual") {
            embed.setTitle(title);
            if (description) embed.setDescription(description);
            if (thumbnail) embed.setThumbnail(thumbnail);
            if (image) embed.setImage(image);
            embed.setFooter({ text: "VISUAL LOG" });
        } else if (style === "classic") {
            embed.setTitle(title);
            if (description) embed.setDescription(description);
            embed.setFooter({ text: "SYNCT" });
        } else {
            let body = `**${title}**\n${description || ''}`;
            embed.setDescription(body.slice(0, 4096));
            if (authorName) embed.setAuthor({ name: authorName, iconURL: authorIcon || null });
            if (thumbnail) embed.setThumbnail(thumbnail);
            if (image) embed.setImage(image);
            if (footerText) embed.setFooter({ text: footerText });
        }
        return embed;
    }

    buildLinkButtonRow(url, label = 'Jump') {
        if (!url) return [];

        return [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel(label)
                    .setURL(url)
            )
        ];
    }

    normalizeOutboundFiles(file, files) {
        const normalized = [];
        if (file) normalized.push(file);
        if (Array.isArray(files)) normalized.push(...files.filter(Boolean));
        else if (files) normalized.push(files);
        return normalized;
    }

    cloneOutboundFiles(files = []) {
        return files.map(file => {
            if (!file || typeof file === 'string') return file;
            if (Buffer.isBuffer(file)) return Buffer.from(file);
            if (file instanceof AttachmentBuilder) {
                return new AttachmentBuilder(Buffer.from(file.attachment), {
                    name: file.name,
                    description: file.description
                });
            }
            if (Buffer.isBuffer(file.attachment)) {
                return {
                    ...file,
                    attachment: Buffer.from(file.attachment)
                };
            }
            return { ...file };
        });
    }

    async buildLatestMessageJumpUrl(message) {
        const channel = message?.channel;
        if (!message?.guildId || !channel?.isTextBased?.() || !channel?.messages?.fetch) return null;

        if (channel.lastMessageId && channel.lastMessageId !== message.id) {
            return `https://discord.com/channels/${message.guildId}/${channel.id}/${channel.lastMessageId}`;
        }

        const latestMessages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const latestMessage = latestMessages?.first?.();
        if (!latestMessage || latestMessage.id === message.id) return null;
        return latestMessage.url;
    }

    formatFileSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return null;

        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        const fixed = value >= 10 || unitIndex === 0 ? 0 : 1;
        return `${value.toFixed(fixed)} ${units[unitIndex]}`;
    }

    getAttachmentFallbackExtension(contentType) {
        const normalized = String(contentType || '').toLowerCase();
        if (!normalized) return '';
        if (normalized.includes('png')) return '.png';
        if (normalized.includes('jpeg')) return '.jpg';
        if (normalized.includes('gif')) return '.gif';
        if (normalized.includes('webp')) return '.webp';
        if (normalized.includes('ogg')) return '.ogg';
        if (normalized.includes('mpeg')) return '.mp3';
        if (normalized.includes('mp4')) return '.mp4';
        if (normalized.includes('quicktime')) return '.mov';
        if (normalized.includes('pdf')) return '.pdf';
        if (normalized.includes('plain')) return '.txt';
        if (normalized.includes('zip')) return '.zip';
        return '';
    }

    resolveAttachmentFileName(attachment, index) {
        const explicitName = typeof attachment?.name === 'string' ? attachment.name.trim() : '';
        const baseName = explicitName || `attachment-${index + 1}${this.getAttachmentFallbackExtension(attachment?.contentType)}`;
        return baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
    }

    formatMessageAttachmentSummary(message) {
        if (!message?.attachments?.size) return null;

        const lines = Array.from(message.attachments.values()).map((attachment, index) => {
            const details = [];
            if (attachment.contentType) details.push(attachment.contentType);
            const sizeLabel = this.formatFileSize(attachment.size);
            if (sizeLabel) details.push(sizeLabel);

            return `- \`${this.resolveAttachmentFileName(attachment, index)}\`${details.length ? ` (${details.join(', ')})` : ''}`;
        });

        return `**Attachments:**\n${lines.join('\n')}`;
    }

    async mirrorMessageAttachments(message) {
        if (!message?.attachments?.size) return [];

        const mirroredFiles = [];
        let index = 0;

        for (const attachment of message.attachments.values()) {
            const sourceUrl = attachment.proxyURL || attachment.url;
            if (!sourceUrl) {
                index++;
                continue;
            }

            const response = await fetch(sourceUrl).catch(() => null);
            if (!response?.ok) {
                index++;
                continue;
            }

            const arrayBuffer = await response.arrayBuffer().catch(() => null);
            if (!arrayBuffer) {
                index++;
                continue;
            }

            mirroredFiles.push({
                attachment: Buffer.from(arrayBuffer),
                name: this.resolveAttachmentFileName(attachment, index)
            });
            index++;
        }

        return mirroredFiles;
    }

    truncateText(value, max = 900) {
        const text = typeof value === 'string'
            ? value
            : value == null
                ? ''
                : String(value);

        if (text.length <= max) return text;
        return `${text.slice(0, Math.max(0, max - 3))}...`;
    }

    formatCodeBlock(value, max = 900) {
        const sanitized = this.truncateText(String(value || '[no content]').replace(/```/g, "'''"), max);
        return `\`\`\`${sanitized}\`\`\``;
    }

    formatStatus(status) {
        return status ? String(status).replace(/^\w/, char => char.toUpperCase()) : 'Offline';
    }

    formatAssetUrl(url) {
        return url || 'None';
    }

    humanizeAuditKey(key) {
        const value = String(key || '').replace(/^\$/, '').replace(/_/g, ' ').trim();
        if (!value) return 'Change';
        return value.replace(/\b\w/g, char => char.toUpperCase());
    }

    formatRoleLabel(roleLike, guild) {
        const roleId = typeof roleLike === 'string' ? roleLike : roleLike?.id;
        const cachedRole = roleId ? guild?.roles?.cache?.get(roleId) : null;
        const roleName = cachedRole?.name || roleLike?.name || null;

        if (roleName && roleId) return `\`${roleName}\` (\`${roleId}\`)`;
        if (roleName) return `\`${roleName}\``;
        if (roleId) return `Role ID \`${roleId}\``;
        return '`Unknown Role`';
    }

    formatChannelLabel(channelLike, guild) {
        const channelId = typeof channelLike === 'string' ? channelLike : channelLike?.id;
        const cachedChannel = channelId ? guild?.channels?.cache?.get(channelId) : null;
        const channelName = cachedChannel?.name || channelLike?.name || null;

        if (cachedChannel) return `${cachedChannel} (\`${cachedChannel.id}\`)`;
        if (channelName && channelId) return `#${channelName} (\`${channelId}\`)`;
        if (channelName) return `#${channelName}`;
        if (channelId) return `Channel ID \`${channelId}\``;
        return '`Unknown Channel`';
    }

    formatUserLabel(userLike, guild) {
        const userId = typeof userLike === 'string' ? userLike : userLike?.id;
        const cachedMember = userId ? guild?.members?.cache?.get(userId) : null;
        const cachedUser = cachedMember?.user || (userId ? this.client.users.cache.get(userId) : null);
        const username =
            cachedUser?.tag ||
            userLike?.tag ||
            userLike?.username ||
            userLike?.name ||
            null;

        if (userId && username) return `<@${userId}> (\`${username}\`, \`${userId}\`)`;
        if (userId) return `<@${userId}> (\`${userId}\`)`;
        if (username) return `\`${username}\``;
        return '`Unknown User`';
    }

    formatPermissionBits(value) {
        if (value == null || value === '' || value === '0' || value === 0 || value === 0n) return 'None';

        try {
            const normalizedValue = typeof value === 'bigint' ? value : BigInt(value);
            const names = PermissionBitfieldClass ? new PermissionBitfieldClass(normalizedValue).toArray() : [];
            return names.length ? names.map(name => `\`${name}\``).join(', ') : 'None';
        } catch (error) {
            return `\`${String(value)}\``;
        }
    }

    resolveAuditIdLabel(guild, key, id) {
        const normalizedKey = String(key || '').toLowerCase();

        if (normalizedKey.includes('channel') || normalizedKey === 'parent_id') {
            return this.formatChannelLabel(id, guild);
        }

        if (normalizedKey.includes('role')) {
            return this.formatRoleLabel(id, guild);
        }

        if (
            normalizedKey.includes('user') ||
            normalizedKey.includes('owner') ||
            normalizedKey.includes('inviter') ||
            normalizedKey.includes('executor')
        ) {
            return this.formatUserLabel(id, guild);
        }

        const cachedChannel = guild?.channels?.cache?.get(id);
        if (cachedChannel) return this.formatChannelLabel(cachedChannel, guild);

        const cachedRole = guild?.roles?.cache?.get(id);
        if (cachedRole) return this.formatRoleLabel(cachedRole, guild);

        return `\`${id}\``;
    }

    formatAuditOverwrite(overwrite, guild) {
        if (!overwrite || typeof overwrite !== 'object') return '`Unknown Overwrite`';

        const overwriteType = overwrite.type === 1 || overwrite.type === 'member' ? 'member' : 'role';
        const targetLabel = overwriteType === 'member'
            ? this.formatUserLabel(overwrite, guild)
            : this.formatRoleLabel(overwrite, guild);
        const parts = [targetLabel];

        if (overwrite.allow != null) parts.push(`allow: ${this.formatPermissionBits(overwrite.allow)}`);
        if (overwrite.deny != null) parts.push(`deny: ${this.formatPermissionBits(overwrite.deny)}`);

        return parts.join(' | ');
    }

    formatAuditValue(value, key, guild) {
        if (value == null || value === '') return 'None';

        if (Array.isArray(value)) {
            if (value.length === 0) return 'None';
            return value.map(item => this.formatAuditValue(item, key, guild)).join(', ');
        }

        if (typeof value === 'object') {
            if ('allow' in value || 'deny' in value) {
                return this.formatAuditOverwrite(value, guild);
            }

            if ('id' in value && ('name' in value || 'type' in value)) {
                if (key === '$add' || key === '$remove' || String(key).toLowerCase().includes('role')) {
                    return this.formatRoleLabel(value, guild);
                }
                if (String(key).toLowerCase().includes('channel')) {
                    return this.formatChannelLabel(value, guild);
                }
                return this.formatUserLabel(value, guild);
            }

            const preview = Object.entries(value)
                .slice(0, 4)
                .map(([entryKey, entryValue]) => `${this.humanizeAuditKey(entryKey)}: ${this.formatAuditValue(entryValue, entryKey, guild)}`);
            return preview.join(', ') || '`Object`';
        }

        if (typeof value === 'boolean') return value ? 'Yes' : 'No';

        if (typeof value === 'number' || typeof value === 'bigint') {
            if (['allow', 'deny', 'permissions'].includes(String(key).toLowerCase())) {
                return this.formatPermissionBits(value);
            }
            return `\`${String(value)}\``;
        }

        if (typeof value === 'string') {
            if (/^\d+$/.test(value)) {
                return this.resolveAuditIdLabel(guild, key, value);
            }

            if (/^https?:\/\//i.test(value)) {
                return `<${value}>`;
            }

            return `\`${this.truncateText(value, 500)}\``;
        }

        return `\`${this.truncateText(String(value), 500)}\``;
    }

    formatAuditChange(change, guild) {
        const key = change?.key || 'change';

        if (key === '$add' || key === '$remove') {
            const values = Array.isArray(change.new) ? change.new : Array.isArray(change.old) ? change.old : [];
            return `**${key === '$add' ? 'Added' : 'Removed'}:** ${values.length ? values.map(value => this.formatAuditValue(value, key, guild)).join(', ') : 'None'}`;
        }

        const label = this.humanizeAuditKey(key);
        const hasOld = Object.prototype.hasOwnProperty.call(change || {}, 'old');
        const hasNew = Object.prototype.hasOwnProperty.call(change || {}, 'new');

        if (hasOld && hasNew) {
            return `**${label}:** ${this.formatAuditValue(change.old, key, guild)} -> ${this.formatAuditValue(change.new, key, guild)}`;
        }

        if (hasNew) return `**${label}:** ${this.formatAuditValue(change.new, key, guild)}`;
        if (hasOld) return `**${label}:** ${this.formatAuditValue(change.old, key, guild)}`;
        return `**${label}:** Updated`;
    }

    formatAuditChanges(changes, guild) {
        if (!Array.isArray(changes) || changes.length === 0) return '';

        return changes
            .slice(0, 12)
            .map(change => this.formatAuditChange(change, guild))
            .join('\n');
    }

    describeAuditAction(action) {
        const matchedEntry = Object.entries(AuditLogEvent).find(([, value]) => value === action);
        if (!matchedEntry) return String(action);

        return matchedEntry[0].replace(/([a-z])([A-Z])/g, '$1 $2');
    }

    formatAuditTarget(entry, guild) {
        if (entry?.target && typeof entry.target === 'object') {
            if ('permissions' in entry.target || 'hexColor' in entry.target) {
                return this.formatRoleLabel(entry.target, guild);
            }
            if ('username' in entry.target || 'tag' in entry.target || 'bot' in entry.target) {
                return this.formatUserLabel(entry.target, guild);
            }
            if ('type' in entry.target) {
                return this.formatChannelLabel(entry.target, guild);
            }
            if ('id' in entry.target) {
                return this.formatAuditValue(entry.target, 'target', guild);
            }
        }

        if (entry?.targetId) {
            return this.resolveAuditIdLabel(guild, 'target_id', String(entry.targetId));
        }

        return 'Unknown';
    }

    getPresenceTitle(presence) {
        const activities = Array.isArray(presence?.activities) ? presence.activities : [];
        const customActivity = activities.find(activity => activity?.type === 4);
        if (customActivity) return customActivity.state || customActivity.name || '';
        const primaryActivity = activities.find(activity => activity?.name);
        return primaryActivity?.name || '';
    }

    getStatusEventKey(status) {
        const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : 'offline';
        if (normalizedStatus === 'online') return 'status-online';
        if (normalizedStatus === 'idle') return 'status-idle';
        if (normalizedStatus === 'dnd') return 'status-dnd';
        return 'status-offline';
    }

    describeInteraction(interaction) {
        if (interaction.isChatInputCommand()) return `Slash Command: \`/${interaction.commandName}\``;
        if (interaction.isContextMenuCommand()) return `Context Menu: \`${interaction.commandName}\``;
        if (interaction.isButton()) return `Button: \`${interaction.customId}\``;
        if (interaction.isStringSelectMenu()) return `String Select: \`${interaction.customId}\``;
        if (interaction.isUserSelectMenu()) return `User Select: \`${interaction.customId}\``;
        if (interaction.isRoleSelectMenu()) return `Role Select: \`${interaction.customId}\``;
        if (interaction.isMentionableSelectMenu()) return `Mentionable Select: \`${interaction.customId}\``;
        if (interaction.isChannelSelectMenu()) return `Channel Select: \`${interaction.customId}\``;
        if (interaction.isModalSubmit()) return `Modal Submit: \`${interaction.customId}\``;
        if (interaction.isAutocomplete()) return `Autocomplete: \`${interaction.commandName}\``;
        return `Interaction: \`${interaction.type}\``;
    }

    getThreadMemberMentions(members, guild) {
        return members
            .map(member => guild?.members?.cache?.get(member.id)?.toString() || `<@${member.id}>`)
            .join(', ');
    }

    async ensureSpecificSyncEventChannels(eventKeys = []) {
        if (!config.sync_logs_toggle || !Array.isArray(config.sync_logs_guilds) || eventKeys.length === 0) return 0;

        const normalizedEventKeys = [...new Set(eventKeys.filter(eventKey => EVENT_REGISTRY[eventKey]))];
        if (normalizedEventKeys.length === 0) return 0;

        let createdCount = 0;

        for (const targetGuildId of config.sync_logs_guilds) {
            const targetGuild = this.client.guilds.cache.get(targetGuildId) || await this.client.guilds.fetch(targetGuildId).catch(() => null);
            if (!targetGuild) continue;

            const targetConf = this.getGuildConfig(targetGuildId);
            const targetCreatedChannels = [];
            const targetCategory = await this.ensureLogCategory(targetGuild, targetCreatedChannels);

            for (const eventKey of normalizedEventKeys) {
                const existingChannelId = targetConf.events[eventKey]?.channel_id || null;
                const targetChannel = await this.ensureLogTextChannel(targetGuild, targetCategory, eventKey, existingChannelId, targetCreatedChannels);
                targetConf.events[eventKey].channel_id = targetChannel.id;
            }

            const syncFallback = await this.ensureLogTextChannel(targetGuild, targetCategory, 'server-logs', targetConf.sync_channel_id, targetCreatedChannels);
            targetConf.sync_channel_id = syncFallback.id;
            createdCount += targetCreatedChannels.length;
        }

        this.saveConfig();
        return createdCount;
    }

    start() {
        this.client.on(Events.GuildCreate, g => this.logEvent("guild-join", "Guild Joined", `**Name:** ${g.name}\n**Owner:** ${g.ownerId}`, NemesisColors.SUCCESS, { guild: g, footerText: `Guild ID: ${g.id}` }));
        this.client.on(Events.GuildUpdate, (before, after) => {
            if (!before || (before.name === after.name && before.icon === after.icon)) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.icon !== after.icon) changes.push('**Icon:** Updated');
            this.logEvent("guild-update", "Guild Updated", changes.join('\n'), NemesisColors.INFO, { guild: after });
        });
        this.client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
            const descriptionParts = [
                `**Action:** \`${this.describeAuditAction(entry.action)}\``,
                `**User:** ${entry.executorId ? `<@${entry.executorId}>` : 'Unknown'}`,
                `**Target:** ${this.formatAuditTarget(entry, guild)}`
            ];

            const changeSummary = this.formatAuditChanges(entry.changes, guild);
            if (changeSummary) descriptionParts.push(`**Changes:**\n${changeSummary}`);
            if (entry.reason) descriptionParts.push(`**Reason:** ${this.formatCodeBlock(entry.reason, 300)}`);

            const description = descriptionParts.join('\n');
            this.logEvent("audit-log", "Audit Log Entry", description, NemesisColors.MUTED, { guild });

            if (
                entry.action === AuditLogEvent.IntegrationCreate ||
                entry.action === AuditLogEvent.IntegrationUpdate ||
                entry.action === AuditLogEvent.IntegrationDelete
            ) {
                const integrationTitle = entry.action === AuditLogEvent.IntegrationCreate
                    ? 'Integration Created'
                    : entry.action === AuditLogEvent.IntegrationUpdate
                        ? 'Integration Updated'
                        : 'Integration Deleted';
                this.logEvent("integration-update", integrationTitle, description, NemesisColors.INFO, { guild });
            }
        });
        this.client.on(Events.GuildEmojiCreate, emoji => {
            this.logEvent("emoji-update", "Emoji Created", `**Emoji:** ${emoji.toString()}\n**Name:** \`${emoji.name}\``, NemesisColors.SUCCESS, { guild: emoji.guild });
        });
        this.client.on(Events.GuildEmojiDelete, emoji => {
            this.logEvent("emoji-update", "Emoji Deleted", `**Name:** \`${emoji.name}\`\n**ID:** \`${emoji.id}\``, NemesisColors.DANGER, { guild: emoji.guild });
        });
        this.client.on(Events.GuildEmojiUpdate, (before, after) => {
            if (!before || (before.name === after.name && before.animated === after.animated)) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.animated !== after.animated) changes.push(`**Animated:** ${after.animated ? 'Yes' : 'No'}`);
            this.logEvent("emoji-update", "Emoji Updated", changes.join('\n'), NemesisColors.WARNING, { guild: after.guild, thumbnail: after.imageURL() });
        });
        this.client.on(Events.GuildStickerCreate, sticker => {
            this.logEvent("sticker-update", "Sticker Created", `**Sticker:** \`${sticker.name}\`\n**ID:** \`${sticker.id}\``, NemesisColors.SUCCESS, { guild: sticker.guild });
        });
        this.client.on(Events.GuildStickerDelete, sticker => {
            this.logEvent("sticker-update", "Sticker Deleted", `**Sticker:** \`${sticker.name}\`\n**ID:** \`${sticker.id}\``, NemesisColors.DANGER, { guild: sticker.guild });
        });
        this.client.on(Events.GuildStickerUpdate, (before, after) => {
            if (!before || (before.name === after.name && before.description === after.description)) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.description !== after.description) changes.push(`**Description:** \`${before.description || 'None'}\` -> \`${after.description || 'None'}\``);
            this.logEvent("sticker-update", "Sticker Updated", changes.join('\n'), NemesisColors.WARNING, { guild: after.guild });
        });
        this.client.on(Events.GuildIntegrationsUpdate, guild => {
            this.logEvent("integration-update", "Integrations Updated", `**Guild:** ${guild.name}\nOne or more integrations changed.`, NemesisColors.INFO, { guild });
        });
        this.client.on(Events.WebhooksUpdate, channel => {
            if (!channel?.guild) return;
            this.logEvent("webhook-update", "Webhooks Updated", `**Channel:** ${channel}`, NemesisColors.INFO, { guild: channel.guild });
        });
        this.client.on(Events.InviteCreate, invite => {
            this.logEvent("invite-create", "Invite Created", `**Code:** \`${invite.code}\`\n**Channel:** ${invite.channel || 'Unknown'}\n**Inviter:** ${invite.inviter || 'Unknown'}`, NemesisColors.SUCCESS, { guild: invite.guild });
        });
        this.client.on(Events.InviteDelete, invite => {
            this.logEvent("invite-delete", "Invite Deleted", `**Code:** \`${invite.code}\`\n**Channel:** ${invite.channel || 'Unknown'}`, NemesisColors.DANGER, { guild: invite.guild });
        });
        this.client.on(Events.GuildRoleCreate, role => this.logEvent("role-create", "Role Created", `**Role:** \`${role.name}\` (\`${role.id}\`)`, NemesisColors.SUCCESS, { guild: role.guild }));
        this.client.on(Events.GuildRoleDelete, role => this.logEvent("role-delete", "Role Deleted", `**Role:** \`${role.name}\` (\`${role.id}\`)`, NemesisColors.DANGER, { guild: role.guild }));
        this.client.on(Events.GuildRoleUpdate, (before, after) => {
            if (!before || (before.name === after.name && before.color === after.color && before.permissions.bitfield === after.permissions.bitfield)) return;
            let desc = `**Role:** \`${after.name}\` (\`${after.id}\`)\n`;
            if (before.name !== after.name) desc += `**Name:** \`${before.name}\` -> \`${after.name}\`\n`;
            if (before.color !== after.color) desc += `**Color:** \`${before.color}\` -> \`${after.color}\`\n`;
            if (before.permissions.bitfield !== after.permissions.bitfield) desc += "**Permissions updated.**";
            this.logEvent("role-update", "Role Updated", desc, NemesisColors.WARNING, { guild: after.guild });
        });
        this.client.on(Events.ChannelCreate, ch => { if(ch.guild) this.logEvent("channel-create", "Channel Created", `${ch} (\`${ch.name}\`)\n**Type:** ${ch.type}`, NemesisColors.SUCCESS, { guild: ch.guild }); });
        this.client.on(Events.ChannelDelete, ch => {
            if (ch.guild) {
                this.logEvent("channel-delete", "Channel Deleted", `\`${ch.name}\`\n**Type:** ${ch.type}`, NemesisColors.DANGER, { guild: ch.guild });
                this.disableChannelRouting(ch.guild.id, ch.id);
            }
        });
        this.client.on(Events.ChannelUpdate, (before, after) => {
            if (!before) return;
            if (before.guild && before.name !== after.name) this.logEvent("channel-update", "Channel Renamed", `${after}\n**Old:** \`${before.name}\`\n**New:** \`${after.name}\``, NemesisColors.INFO, { guild: after.guild });
        });
        this.client.on(Events.ChannelPinsUpdate, (channel, pinnedAt) => {
            if (!channel?.guild) return;
            const pinText = pinnedAt ? `<t:${Math.floor(new Date(pinnedAt).getTime() / 1000)}:F>` : 'Unknown';
            this.logEvent("channel-pins", "Channel Pins Updated", `**Channel:** ${channel}\n**Last Pin Change:** ${pinText}`, NemesisColors.INFO, { guild: channel.guild });
        });
        this.client.on(Events.ThreadCreate, (thread, newlyCreated) => {
            if (!thread?.guild) return;
            const title = newlyCreated ? "Thread Created" : "Thread Available";
            this.logEvent("thread-create", title, `**Thread:** ${thread}\n**Parent:** ${thread.parent || 'Unknown'}\n**Archived:** ${thread.archived ? 'Yes' : 'No'}`, NemesisColors.SUCCESS, { guild: thread.guild });
        });
        this.client.on(Events.ThreadDelete, thread => {
            if (!thread?.guild) return;
            this.logEvent("thread-delete", "Thread Deleted", `**Thread:** \`${thread.name}\`\n**Parent:** ${thread.parent || 'Unknown'}`, NemesisColors.DANGER, { guild: thread.guild });
        });
        this.client.on(Events.ThreadUpdate, (before, after) => {
            if (!before || !after?.guild) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.archived !== after.archived) changes.push(`**Archived:** ${after.archived ? 'Yes' : 'No'}`);
            if (before.locked !== after.locked) changes.push(`**Locked:** ${after.locked ? 'Yes' : 'No'}`);
            if (changes.length) this.logEvent("thread-update", "Thread Updated", `**Thread:** ${after}\n${changes.join('\n')}`, NemesisColors.WARNING, { guild: after.guild });
        });
        this.client.on(Events.ThreadMembersUpdate, (addedMembers, removedMembers, thread) => {
            if (!thread?.guild) return;
            const added = Array.from(addedMembers?.values?.() || []);
            const removed = Array.from(removedMembers?.values?.() || []);

            if (added.length) {
                this.logEvent("thread-join", "Thread Members Added", `**Thread:** ${thread}\n**Users:** ${this.getThreadMemberMentions(added, thread.guild)}`, NemesisColors.SUCCESS, { guild: thread.guild });
            }

            if (removed.length) {
                this.logEvent("thread-leave", "Thread Members Removed", `**Thread:** ${thread}\n**Users:** ${this.getThreadMemberMentions(removed, thread.guild)}`, NemesisColors.DANGER, { guild: thread.guild });
            }
        });
        this.client.on(Events.GuildMemberAdd, m => {
            this.logEvent("user-join", "Member Joined", `**User:** ${m}\n**Account Created:** <t:${Math.floor(m.user.createdTimestamp / 1000)}:F>\n**Bot:** ${m.user.bot ? 'Yes' : 'No'}`, NemesisColors.SUCCESS, { guild: m.guild, authorName: `${m.user.tag} (${m.id})`, authorIcon: m.user.displayAvatarURL() });
        });
        this.client.on(Events.GuildMemberRemove, m => {
            const rolesStr = m.roles.cache.filter(r => r.name !== '@everyone').map(r => `\`${r.name}\` (\`${r.id}\`)`).join(', ').slice(0, 1020);
            this.logEvent("user-leave", "Member Left", `**User:** ${m}\n**Roles:** ${rolesStr || 'None'}`, NemesisColors.DANGER, { guild: m.guild, authorName: `${m.user.tag} (${m.id})`, authorIcon: m.user.displayAvatarURL() });
        });
        this.client.on(Events.GuildMemberUpdate, (before, after) => {
            if (!before) return;
            const authorDisplay = `${after.user.tag} (${after.id})`;
            if (before.nickname !== after.nickname) {
                this.logEvent("nickname-change", "Nickname Changed", `**User:** ${after}\n**Old:** \`${before.nickname || before.user.username}\`\n**New:** \`${after.nickname || after.user.username}\``, NemesisColors.INFO, { guild: after.guild, authorName: authorDisplay, authorIcon: after.user.displayAvatarURL() });
            }
            const beforeRoles = new Set(before.roles.cache.keys());
            const afterRoles = new Set(after.roles.cache.keys());
            if (beforeRoles.size !== afterRoles.size) {
                const added = after.roles.cache.filter(r => !beforeRoles.has(r.id)).map(r => `\`${r.name}\` (\`${r.id}\`)`);
                const removed = before.roles.cache.filter(r => !afterRoles.has(r.id)).map(r => `\`${r.name}\` (\`${r.id}\`)`);
                let desc = `**User:** ${after}\n`;
                if (added.length) desc += `**Added:** ${added.join(', ')}\n`;
                if (removed.length) desc += `**Removed:** ${removed.join(', ')}`;
                if (added.length || removed.length) this.logEvent("role-change", "Roles Updated", desc, NemesisColors.INFO, { guild: after.guild, authorName: authorDisplay, authorIcon: after.user.displayAvatarURL() });
            }
            if (before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp) {
                if (after.communicationDisabledUntilTimestamp) this.logEvent("user-timeout", "Member Timed Out", `**User:** ${after}\n**Until:** <t:${Math.floor(after.communicationDisabledUntilTimestamp / 1000)}:F>`, NemesisColors.DANGER, { guild: after.guild, authorName: authorDisplay, authorIcon: after.user.displayAvatarURL() });
                else this.logEvent("user-timeout", "Timeout Removed", `**User:** ${after}\nTimeout was removed.`, NemesisColors.SUCCESS, { guild: after.guild, authorName: authorDisplay, authorIcon: after.user.displayAvatarURL() });
            }
        });
        this.client.on(Events.UserUpdate, (before, after) => {
            if (!before) return;
            if (before.avatar !== after.avatar) {
                const beforeAvatarUrl = this.formatAssetUrl(before.displayAvatarURL({ extension: 'png', size: 4096 }));
                const afterAvatarUrl = this.formatAssetUrl(after.displayAvatarURL({ extension: 'png', size: 4096 }));
                this.client.guilds.cache.forEach(guild => {
                    if (guild.members.cache.has(after.id)) {
                        this.logEvent(
                            "avatar-change",
                            "Avatar Changed",
                            `**User:** <@${after.id}>\n**Old Avatar:** [Link](${beforeAvatarUrl})\n**New Avatar:** [Link](${afterAvatarUrl})`,
                            NemesisColors.SPECIAL,
                            {
                                guild,
                                thumbnail: after.displayAvatarURL({ extension: 'png', size: 4096 }),
                                authorName: `${after.tag} (${after.id})`,
                                authorIcon: after.displayAvatarURL({ extension: 'png', size: 4096 })
                            }
                        );
                    }
                });
            }

            if (before.banner !== after.banner) {
                const beforeBannerUrl = before.bannerURL({ extension: 'png', size: 4096 }) 
                    ? this.formatAssetUrl(before.bannerURL({ extension: 'png', size: 4096 }))
                    : null;
                const afterBannerUrl = after.bannerURL({ extension: 'png', size: 4096 })
                    ? this.formatAssetUrl(after.bannerURL({ extension: 'png', size: 4096 }))
                    : null;
                
                const beforeText = beforeBannerUrl ? `[Link](${beforeBannerUrl})` : '`None`';
                const afterText = afterBannerUrl ? `[Link](${afterBannerUrl})` : '`None`';

                this.client.guilds.cache.forEach(guild => {
                    if (guild.members.cache.has(after.id)) {
                        this.logEvent(
                            "banner-change",
                            "Banner Changed",
                            `**User:** <@${after.id}>\n**Old Banner:** ${beforeText}\n**New Banner:** ${afterText}`,
                            NemesisColors.SPECIAL,
                            {
                                guild,
                                image: afterBannerUrl,
                                authorName: `${after.tag} (${after.id})`,
                                authorIcon: after.displayAvatarURL({ extension: 'png', size: 4096 })
                            }
                        );
                    }
                });
            }
        });
        this.client.on(Events.GuildBanAdd, ban => this.logEvent("user-ban", "User Banned", `${ban.user.toString()} (\`${ban.user.username}\`)`, NemesisColors.DANGER, { guild: ban.guild, thumbnail: ban.user.displayAvatarURL() }));
        this.client.on(Events.GuildBanRemove, ban => this.logEvent("user-unban", "User Unbanned", `${ban.user.toString()} (\`${ban.user.username}\`)`, NemesisColors.SUCCESS, { guild: ban.guild, thumbnail: ban.user.displayAvatarURL() }));
        this.client.on(Events.AutoModerationRuleCreate, rule => {
            this.logEvent("automod-rule-create", "AutoMod Rule Created", `**Rule:** \`${rule.name}\`\n**Trigger:** \`${rule.triggerType}\``, NemesisColors.SUCCESS, { guild: rule.guild });
        });
        this.client.on(Events.AutoModerationRuleUpdate, (before, after) => {
            if (!before) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.enabled !== after.enabled) changes.push(`**Enabled:** ${after.enabled ? 'Yes' : 'No'}`);
            if (before.triggerType !== after.triggerType) changes.push(`**Trigger:** \`${before.triggerType}\` -> \`${after.triggerType}\``);
            this.logEvent("automod-rule-update", "AutoMod Rule Updated", changes.join('\n') || `**Rule:** \`${after.name}\``, NemesisColors.WARNING, { guild: after.guild });
        });
        this.client.on(Events.AutoModerationRuleDelete, rule => {
            this.logEvent("automod-rule-delete", "AutoMod Rule Deleted", `**Rule:** \`${rule.name}\`\n**ID:** \`${rule.id}\``, NemesisColors.DANGER, { guild: rule.guild });
        });
        this.client.on(Events.AutoModerationActionExecution, execution => {
            const guild = execution.guild || this.client.guilds.cache.get(execution.guildId);
            this.logEvent(
                "automod-action",
                "AutoMod Action Executed",
                [
                    `**Rule:** \`${execution.ruleName || execution.ruleId || 'Unknown'}\``,
                    `**User:** <@${execution.userId}>`,
                    execution.channelId ? `**Channel:** <#${execution.channelId}>` : null,
                    execution.action ? `**Action:** \`${execution.action.type}\`` : null,
                    execution.content ? `**Content:** ${this.formatCodeBlock(execution.content, 600)}` : null
                ].filter(Boolean).join('\n'),
                NemesisColors.DANGER,
                { guild, authorName: execution.userId ? `User ID: ${execution.userId}` : undefined }
            );
        });
        this.client.on(Events.MessageCreate, async msg => {
            if (!msg.guild || msg.author.bot) return;
            const attachmentSummary = this.formatMessageAttachmentSummary(msg);
            const mirroredFiles = await this.mirrorMessageAttachments(msg);
            await this.logEvent(
                "message-create",
                "Message Created",
                [
                    `**User:** ${msg.author}`,
                    `**Channel:** ${msg.channel}`,
                    `**Content:** ${this.formatCodeBlock(msg.content, 900)}`,
                    attachmentSummary
                ].filter(Boolean).join('\n'),
                NemesisColors.MUTED,
                {
                    guild: msg.guild,
                    authorName: msg.author?.tag,
                    authorIcon: msg.author?.displayAvatarURL?.(),
                    files: mirroredFiles,
                    components: this.buildLinkButtonRow(msg.url)
                }
            );
        });
        this.client.on(Events.MessageDelete, async msg => {
            if (!msg.guild || msg.author?.bot) return;
            const attachmentSummary = this.formatMessageAttachmentSummary(msg);
            const mirroredFiles = await this.mirrorMessageAttachments(msg);
            const jumpUrl = await this.buildLatestMessageJumpUrl(msg);
            await this.logEvent(
                "message-delete",
                "Message Deleted",
                [
                    `**Channel:** ${msg.channel}`,
                    `**Content:** ${this.formatCodeBlock(msg.content, 1800)}`,
                    attachmentSummary
                ].filter(Boolean).join('\n'),
                NemesisColors.DANGER,
                {
                    guild: msg.guild,
                    authorName: msg.author?.tag,
                    authorIcon: msg.author?.displayAvatarURL?.(),
                    files: mirroredFiles,
                    components: this.buildLinkButtonRow(jumpUrl, 'Jump to Latest')
                }
            );
        });
        this.client.on(Events.MessageUpdate, async (before, after) => {
            if (!before || !before.guild || before.author?.bot || before.content === after.content) return;
            const attachmentSummary = this.formatMessageAttachmentSummary(after);
            const mirroredFiles = await this.mirrorMessageAttachments(after);
            await this.logEvent(
                "message-edit",
                "Message Edited",
                [
                    `**Channel:** ${before.channel}`,
                    `**Before:** ${this.formatCodeBlock(before.content, 900)}`,
                    `**After:** ${this.formatCodeBlock(after.content, 900)}`,
                    attachmentSummary
                ].filter(Boolean).join('\n'),
                NemesisColors.WARNING,
                {
                    guild: before.guild,
                    authorName: before.author?.tag,
                    authorIcon: before.author?.displayAvatarURL?.(),
                    files: mirroredFiles,
                    components: this.buildLinkButtonRow(after.url)
                }
            );
        });
        this.client.on(Events.MessageBulkDelete, messages => {
            const firstMessage = messages.first();
            if (!firstMessage?.guild) return;
            this.logEvent("bulk-delete", "Bulk Message Delete", `**Channel:** ${firstMessage.channel}\n**Messages Deleted:** ${messages.size}`, NemesisColors.DANGER, { guild: firstMessage.guild });
        });
        this.client.on(Events.MessageReactionAdd, (reaction, user) => {
            const guild = reaction.message?.guild;
            if (!guild || user?.bot) return;
            const emoji = reaction.emoji?.toString?.() || reaction.emoji?.name || 'Unknown emoji';
            this.logEvent("reaction-add", "Reaction Added", `**User:** ${user}\n**Channel:** ${reaction.message.channel}\n**Emoji:** ${emoji}\n[Jump](${reaction.message.url})`, NemesisColors.INFO, { guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL?.() });
        });
        this.client.on(Events.MessageReactionRemove, (reaction, user) => {
            const guild = reaction.message?.guild;
            if (!guild || user?.bot) return;
            const emoji = reaction.emoji?.toString?.() || reaction.emoji?.name || 'Unknown emoji';
            this.logEvent("reaction-remove", "Reaction Removed", `**User:** ${user}\n**Channel:** ${reaction.message.channel}\n**Emoji:** ${emoji}\n[Jump](${reaction.message.url})`, NemesisColors.WARNING, { guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL?.() });
        });
        this.client.on(Events.MessageReactionRemoveAll, (message, reactions) => {
            if (!message.guild) return;
            this.logEvent("reaction-clear", "All Reactions Cleared", `**Channel:** ${message.channel}\n**Reaction Types Removed:** ${reactions.size}\n[Jump](${message.url})`, NemesisColors.DANGER, { guild: message.guild });
        });
        this.client.on(Events.MessageReactionRemoveEmoji, reaction => {
            const guild = reaction.message?.guild;
            if (!guild) return;
            const emoji = reaction.emoji?.toString?.() || reaction.emoji?.name || 'Unknown emoji';
            this.logEvent("reaction-clear", "Reaction Emoji Cleared", `**Channel:** ${reaction.message.channel}\n**Emoji:** ${emoji}\n[Jump](${reaction.message.url})`, NemesisColors.DANGER, { guild });
        });
        this.client.on(Events.TypingStart, typing => {
            if (!typing.guild || typing.user?.bot) return;
            this.logEvent("user-typing", "User Started Typing", `**User:** ${typing.user}\n**Channel:** ${typing.channel}`, NemesisColors.MUTED, { guild: typing.guild, authorName: `${typing.user.tag} (${typing.user.id})`, authorIcon: typing.user.displayAvatarURL?.() });
        });
        this.client.on(Events.PresenceUpdate, (before, after) => {
            if (!after?.guild || !after.userId) return;
            const member = after.member || after.guild.members.cache.get(after.userId);
            const user = member?.user;
            if (!user || user.bot) return;

            const beforeStatus = before?.status || 'offline';
            const afterStatus = after.status || 'offline';
            if (beforeStatus !== afterStatus) {
                this.logEvent(
                    this.getStatusEventKey(afterStatus),
                    `Status Changed To ${this.formatStatus(afterStatus)}`,
                    `**User:** ${member}\n**Status:** ${this.formatStatus(beforeStatus)} -> ${this.formatStatus(afterStatus)}`,
                    NemesisColors.INFO,
                    { guild: after.guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL() }
                );
            }

            const beforeTitle = this.getPresenceTitle(before);
            const afterTitle = this.getPresenceTitle(after);
            if (beforeTitle !== afterTitle) {
                this.logEvent(
                    "stats-title-update",
                    "Status Title Updated",
                    `**User:** ${member}\n**Title:** ${beforeTitle || 'None'} -> ${afterTitle || 'None'}`,
                    NemesisColors.INFO,
                    { guild: after.guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL() }
                );
            }
        });
        this.client.on(Events.GuildScheduledEventCreate, scheduledEvent => {
            this.logEvent("scheduled-event-create", "Scheduled Event Created", `**Event:** \`${scheduledEvent.name}\`\n**Start:** ${scheduledEvent.scheduledStartTimestamp ? `<t:${Math.floor(scheduledEvent.scheduledStartTimestamp / 1000)}:F>` : 'Unknown'}`, NemesisColors.SUCCESS, { guild: scheduledEvent.guild });
        });
        this.client.on(Events.GuildScheduledEventUpdate, (before, after) => {
            if (!before) return;
            const changes = [];
            if (before.name !== after.name) changes.push(`**Name:** \`${before.name}\` -> \`${after.name}\``);
            if (before.status !== after.status) changes.push(`**Status:** \`${before.status}\` -> \`${after.status}\``);
            if (before.scheduledStartTimestamp !== after.scheduledStartTimestamp) {
                changes.push(`**Start:** ${after.scheduledStartTimestamp ? `<t:${Math.floor(after.scheduledStartTimestamp / 1000)}:F>` : 'Unknown'}`);
            }
            this.logEvent("scheduled-event-update", "Scheduled Event Updated", changes.join('\n') || `**Event:** \`${after.name}\``, NemesisColors.WARNING, { guild: after.guild });
        });
        this.client.on(Events.GuildScheduledEventDelete, scheduledEvent => {
            this.logEvent("scheduled-event-delete", "Scheduled Event Deleted", `**Event:** \`${scheduledEvent.name}\``, NemesisColors.DANGER, { guild: scheduledEvent.guild });
        });
        this.client.on(Events.GuildScheduledEventUserAdd, (scheduledEvent, user) => {
            this.logEvent("scheduled-event-join", "User Joined Scheduled Event", `**Event:** \`${scheduledEvent.name}\`\n**User:** ${user}`, NemesisColors.SUCCESS, { guild: scheduledEvent.guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL?.() });
        });
        this.client.on(Events.GuildScheduledEventUserRemove, (scheduledEvent, user) => {
            this.logEvent("scheduled-event-leave", "User Left Scheduled Event", `**Event:** \`${scheduledEvent.name}\`\n**User:** ${user}`, NemesisColors.WARNING, { guild: scheduledEvent.guild, authorName: `${user.tag} (${user.id})`, authorIcon: user.displayAvatarURL?.() });
        });
        this.client.on(Events.VoiceStateUpdate, (before, after) => {
            if (!before) return;
            const member = after.member;
            if (!member || member.user.bot) return;
            const authorDisplay = `${member.user.tag} (${member.id})`;

            if (!before.channelId && after.channelId) {
                this.logEvent("voice-join", "Joined Voice", `**User:** ${member}\n**Channel:** ${after.channel}`, NemesisColors.SUCCESS, { guild: member.guild, authorName: authorDisplay, authorIcon: member.user.displayAvatarURL() });
            } else if (before.channelId && !after.channelId) {
                this.logEvent("voice-leave", "Left Voice", `**User:** ${member}\n**Channel:** ${before.channel}`, NemesisColors.DANGER, { guild: member.guild, authorName: authorDisplay, authorIcon: member.user.displayAvatarURL() });
            } else if (before.channelId && after.channelId && before.channelId !== after.channelId) {
                this.logEvent("voice-move", "Moved Voice Channels", `**User:** ${member}\n**From:** ${before.channel}\n**To:** ${after.channel}`, NemesisColors.INFO, { guild: member.guild, authorName: authorDisplay, authorIcon: member.user.displayAvatarURL() });
            }
            if (before.selfVideo !== after.selfVideo) {
                if (after.selfVideo) this.logEvent("voice-camera", "Camera Enabled", `**User:** ${member}\n**Channel:** ${after.channel || before.channel}`, NemesisColors.SPECIAL, { guild: member.guild, authorName: authorDisplay, authorIcon: member.user.displayAvatarURL() });
                else this.logEvent("voice-camera", "Camera Disabled", `**User:** ${member}\n**Channel:** ${after.channel || before.channel}`, NemesisColors.MUTED, { guild: member.guild, authorName: authorDisplay, authorIcon: member.user.displayAvatarURL() });
            }
            if (before.streaming !== after.streaming) {
                if (after.streaming) this.logEvent("voice-stream", "Started Screen Share", `**User:** ${member}\n**Channel:** ${after.channel}`, NemesisColors.SPECIAL, { guild: member.guild });
                else this.logEvent("voice-stream", "Stopped Screen Share", `**User:** ${member}\n**Channel:** ${after.channel || before.channel}`, NemesisColors.MUTED, { guild: member.guild });
            }
        });
        this.client.on(Events.InteractionCreate, interaction => {
            if (!interaction.guildId || interaction.user?.bot) return;
            this.logEvent("interaction-create", "Interaction Created", `${this.describeInteraction(interaction)}\n**User:** ${interaction.user}\n**Channel:** ${interaction.channel || 'Unknown'}`, NemesisColors.INFO, {
                guild: interaction.guild,
                authorName: `${interaction.user.tag} (${interaction.user.id})`,
                authorIcon: interaction.user.displayAvatarURL?.()
            });
        });
        
        // Multi-page Wizard State Manager
        this.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.guildId) return;
            const guildId = interaction.guildId;
            const session = this.setupSessions.get(guildId);

            if (interaction.isButton()) {
                if (interaction.customId === 'logger_sync_all') {
                    const conf = this.getGuildConfig(guildId);
                    Object.keys(conf.events).forEach(k => conf.events[k].sync_enabled = true);
                    this.saveConfig();
                    await interaction.reply({ content: '✅ All logs have been globally synced.', ephemeral: true });
                } else if (interaction.customId === 'logger_desync_all') {
                    const conf = this.getGuildConfig(guildId);
                    Object.keys(conf.events).forEach(k => conf.events[k].sync_enabled = false);
                    this.saveConfig();
                    await interaction.reply({ content: '✅ All logs have been desynced.', ephemeral: true });
                } else if (interaction.customId === 'logger_setup_next_sync' || interaction.customId === 'logger_setup_next_local') {
                    if (!session) return interaction.reply({ content: 'Session expired. Run `abc.log setup` again.', ephemeral: true });
                    session.step = interaction.customId === 'logger_setup_next_local' ? 'local_select' : 'sync_select';
                    await interaction.deferUpdate();
                    await this.renderWizardPage(interaction.message, session);
                } else if (interaction.customId === 'logger_setup_done') {
                    if (!session) return interaction.reply({ content: 'Session expired. Run `abc.log setup` again.', ephemeral: true });
                    await interaction.deferUpdate();
                    await this.initializeLogger(interaction, session);
                } else if (interaction.customId === 'logger_setup_toggle_all_local' || interaction.customId === 'logger_setup_toggle_all_sync') {
                    if (!session) return interaction.reply({ content: 'Session expired. Run `abc.log setup` again.', ephemeral: true });

                    const selectingLocal = interaction.customId === 'logger_setup_toggle_all_local';
                    const allValues = session.mode === 'compact' ? ALL_LOG_CATEGORIES : ALL_LOG_EVENTS;
                    const currentValues = new Set(selectingLocal ? session.local : session.sync);
                    const hasAllSelected = allValues.every(value => currentValues.has(value));

                    if (selectingLocal) {
                        session.local = hasAllSelected ? [] : [...allValues];
                    } else {
                        session.sync = hasAllSelected ? [] : [...allValues];
                    }

                    await interaction.deferUpdate();
                    await this.renderWizardPage(interaction.message, session);
                } else if (interaction.customId === 'logger_setup_disable') {
                    if (!session) return interaction.reply({ content: 'Session expired.', ephemeral: true });
                    const disableRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('log_disable_archive').setLabel('Archive & Disable All').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('log_disable_delete').setLabel('Delete & Disable All').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId('log_disable_cancel').setLabel('Cancel').setStyle(ButtonStyle.Primary)
                    );
                    await interaction.update({ content: "**Disable Mode**\nDo you want to archive or permanently delete the channels associated with logs?", embeds: [], components: [disableRow] });
                } else if (interaction.customId === 'log_disable_archive' || interaction.customId === 'log_disable_delete') {
                    await interaction.deferUpdate();
                    const conf = this.getGuildConfig(guildId);
                    const channelIds = new Set(Object.values(conf.events).map(e => e.channel_id).filter(Boolean));
                    
                    for (const cid of channelIds) {
                        const ch = interaction.guild.channels.cache.get(cid);
                        if (ch) {
                            if (interaction.customId === 'log_disable_delete') ch.delete().catch(() => {});
                            else if (!NO_OVERWRITE_CHANNEL_IDS.has(ch.id)) ch.permissionOverwrites.edit(interaction.guild.roles.everyone, { ViewChannel: false }).catch(() => {});
                        }
                    }
                    Object.keys(conf.events).forEach(k => { conf.events[k].enabled = false; conf.events[k].channel_id = null; conf.events[k].sync_enabled = false; });
                    this.saveConfig();
                    this.setupSessions.delete(guildId);
                    await interaction.editReply({ content: '✅ All logs have been disabled & channels processed.', components: [], embeds: [] });
                } else if (interaction.customId === 'log_disable_cancel') {
                    await interaction.update({ content: "Disable process cancelled.", components: [], embeds: [] });
                    this.setupSessions.delete(guildId);
                }
            } else if (interaction.isStringSelectMenu()) {
                if (!session) return interaction.reply({ content: 'Session expired. Run `abc.log setup` again.', ephemeral: true });
                
                await interaction.deferUpdate();
                if (interaction.customId === 'logger_setup_mode') {
                    session.mode = interaction.values[0];
                } else if (interaction.customId === 'logger_setup_local_compact') {
                    session.local = interaction.values;
                } else if (interaction.customId === 'logger_setup_sync_compact') {
                    session.sync = interaction.values;
                } else if (interaction.customId === 'logger_setup_local_target') {
                    session.localTargetChannelId = interaction.values[0] === 'dedicated' ? null : interaction.values[0];
                } else if (interaction.customId.startsWith('menu_local_')) {
                    const group = MENU_GROUPS.find(g => g.id === interaction.customId);
                    if (group) {
                        session.local = session.local.filter(evt => !group.events.includes(evt));
                        session.local.push(...interaction.values);
                    }
                } else if (interaction.customId.startsWith('menu_sync_')) {
                    const group = MENU_GROUPS.find(g => g.syncId === interaction.customId);
                    if (group) {
                        session.sync = session.sync.filter(evt => !group.events.includes(evt));
                        session.sync.push(...interaction.values);
                    }
                }
                
                await this.renderWizardPage(interaction.message, session);
            }
        });
    }

    async renderWizardPage(message, session) {
        const guild = message.guild;
        const localTargetText = session.localTargetChannelId ? `<#${session.localTargetChannelId}>` : 'Dedicated log channels';
        let codeblock = `## Selections made:\n\`\`\`${session.mode}\nLocal Events:\n${session.local.join('\n') || 'None'}\nLocal Target:\n${localTargetText}\n\nSync Events:\n${session.sync.join('\n') || 'None'}\n\`\`\``;
        
        const embed = new EmbedBuilder().setTitle("SYNCT Initialization Wizard").setDescription(codeblock).setColor(NemesisColors.INFO);
        const components = [];
        const localAllValues = session.mode === 'compact' ? ALL_LOG_CATEGORIES : ALL_LOG_EVENTS;
        const syncAllValues = session.mode === 'compact' ? ALL_LOG_CATEGORIES : ALL_LOG_EVENTS;
        const localAllSelected = localAllValues.every(value => session.local.includes(value));
        const syncAllSelected = syncAllValues.every(value => session.sync.includes(value));
        const localTargetOptions = [
            new StringSelectMenuOptionBuilder()
                .setLabel('Dedicated log channels')
                .setValue('dedicated')
                .setDescription('Create or reuse standard logger channels')
                .setDefault(!session.localTargetChannelId)
        ];

        if (guild) {
            guild.channels.cache
                .filter(channel => channel.type === ChannelType.GuildText)
                .first(24)
                .forEach(channel => {
                    localTargetOptions.push(
                        new StringSelectMenuOptionBuilder()
                            .setLabel(`#${channel.name}`.slice(0, 100))
                            .setValue(channel.id)
                            .setDescription(`Reuse ${channel.name} for local logs`.slice(0, 100))
                            .setDefault(session.localTargetChannelId === channel.id)
                    );
                });
        }

        if (session.step === 'mode_select') {
            embed.setDescription("1️⃣ Choose your Storage Mode\n\n" + codeblock);
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('logger_setup_mode')
                    .setPlaceholder('Select Storage Mode...')
                    .setMinValues(1).setMaxValues(1)
                    .addOptions([
                        new StringSelectMenuOptionBuilder().setLabel("Compact Mode (5 Channels)").setValue("compact").setDescription("Groups logs by category").setDefault(session.mode === 'compact'),
                        new StringSelectMenuOptionBuilder().setLabel("Full Mode (54+ Channels)").setValue("full").setDescription("Independent channel for each log").setDefault(session.mode === 'full')
                    ])
            ));
            
            if (session.mode === 'compact') {
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('logger_setup_local_compact').setPlaceholder('Select Local Categories').setMinValues(0).setMaxValues(ALL_LOG_CATEGORIES.length)
                        .addOptions(ALL_LOG_CATEGORIES.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat).setDefault(session.local.includes(cat))))
                ));
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('logger_setup_sync_compact').setPlaceholder('Select Sync Categories').setMinValues(0).setMaxValues(ALL_LOG_CATEGORIES.length)
                        .addOptions(ALL_LOG_CATEGORIES.map(cat => new StringSelectMenuOptionBuilder().setLabel(cat).setValue(cat).setDefault(session.sync.includes(cat))))
                ));
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('logger_setup_local_target').setPlaceholder('Optional: route local logs into one existing channel').setMinValues(1).setMaxValues(1)
                        .addOptions(localTargetOptions)
                ));
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('logger_setup_toggle_all_local').setLabel(localAllSelected ? 'Clear All Local' : 'All Local').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('logger_setup_toggle_all_sync').setLabel(syncAllSelected ? 'Clear All Sync' : 'All Sync').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('logger_setup_done').setLabel('Done (Initialize Logs)').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('logger_setup_disable').setLabel('Disable Active Logs...').setStyle(ButtonStyle.Danger)
                ));
            } else {
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('logger_setup_next_local').setLabel('Next: Select Local Logs ->').setStyle(ButtonStyle.Primary)
                ));
            }
        } else if (session.step === 'local_select') {
            embed.setDescription("2️⃣ Pick which logs to enable Locally\n\n" + codeblock);
            MENU_GROUPS.forEach(group => {
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId(group.id).setPlaceholder(`Local: ${group.label}`).setMinValues(0).setMaxValues(group.events.length)
                        .addOptions(group.events.map(evt => new StringSelectMenuOptionBuilder().setLabel(evt).setValue(evt).setDefault(session.local.includes(evt))))
                ));
            });
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId('logger_setup_local_target').setPlaceholder('Optional: route local logs into one existing channel').setMinValues(1).setMaxValues(1)
                    .addOptions(localTargetOptions)
            ));
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('logger_setup_toggle_all_local').setLabel(localAllSelected ? 'Clear All Local' : 'All Local').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('logger_setup_next_sync').setLabel('Next: Select Sync Logs ->').setStyle(ButtonStyle.Primary)
            ));
        } else if (session.step === 'sync_select') {
            embed.setDescription("3️⃣ Pick which logs to enable for Global Sync (optional)\n\n" + codeblock);
            MENU_GROUPS.forEach(group => {
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId(group.syncId).setPlaceholder(`Sync: ${group.label}`).setMinValues(0).setMaxValues(group.events.length)
                        .addOptions(group.events.map(evt => new StringSelectMenuOptionBuilder().setLabel(evt).setValue(evt).setDefault(session.sync.includes(evt))))
                ));
            });
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('logger_setup_toggle_all_sync').setLabel(syncAllSelected ? 'Clear All Sync' : 'All Sync').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('logger_setup_done').setLabel('Done (Initialize Logs)').setStyle(ButtonStyle.Success)
            ));
        }

        await message.edit({ embeds: [embed], components });
    }

    async initializeLogger(interaction, session) {
        const conf = this.getGuildConfig(interaction.guildId);
        const guild = interaction.guild;
        Object.keys(conf.events).forEach(evt => {
            conf.events[evt].enabled = false;
            conf.events[evt].channel_id = null;
            conf.events[evt].sync_enabled = false;
        });
        const hasLocalSelections = session.local.length > 0;
        const shouldCreateDedicatedLocalChannels = hasLocalSelections && !session.localTargetChannelId;
        const canHostSyncInbox = config.sync_logs_toggle && Array.isArray(config.sync_logs_guilds) && config.sync_logs_guilds.includes(interaction.guildId);
        const selectedLocalChannel = session.localTargetChannelId
            ? guild.channels.cache.get(session.localTargetChannelId)
            : null;
        let category = guild.channels.cache.find(c => c.name === "logs" && c.type === ChannelType.GuildCategory);
        let createdChannels = [];
        this.client.undoHistory = this.client.undoHistory || new Map();

        if (session.localTargetChannelId && (!selectedLocalChannel || selectedLocalChannel.type !== ChannelType.GuildText)) {
            return interaction.editReply({ content: "❌ The selected local target channel is no longer available. Please run setup again.", components: [], embeds: [] });
        }

        if (shouldCreateDedicatedLocalChannels || canHostSyncInbox) {
            try {
                category = await this.ensureLogCategory(guild, createdChannels);
            } catch (e) {
                return interaction.editReply({ content: "❌ Subsystem error: Bot is missing Manage Channels permissions.", components: [], embeds: [] });
            }
        }

        const localCats = new Set(session.local);
        const syncCats = new Set(session.sync);
        const compactAllLocalSelected = session.mode === 'compact' && ALL_LOG_CATEGORIES.every(category => localCats.has(category));
        const compactAllSyncSelected = session.mode === 'compact' && ALL_LOG_CATEGORIES.every(category => syncCats.has(category));

        try {
            if (session.mode === 'compact') {
                const requiredCategories = new Set([...session.local, ...session.sync]);
                const coreChannels = {};
                for (const logs of ['message-logs', 'member-logs', 'mod-logs', 'server-logs', 'voice-logs']) {
                    if (shouldCreateDedicatedLocalChannels && (requiredCategories.has(logs) || requiredCategories.size === 0)) { // size 0 fallback
                        const existingChannelId = Object.entries(conf.events)
                            .find(([eventKey, eventConf]) => eventConf.channel_id && EVENT_REGISTRY[eventKey]?.category === logs)?.[1]?.channel_id || null;
                        coreChannels[logs] = await this.ensureLogTextChannel(guild, category, logs, existingChannelId, createdChannels);
                    }
                }
                for (const [evt, details] of Object.entries(EVENT_REGISTRY)) {
                    if (localCats.has(details.category)) {
                        if (compactAllLocalSelected || details.default !== false) {
                            conf.events[evt].enabled = true;
                            conf.events[evt].channel_id = selectedLocalChannel?.id || coreChannels[details.category]?.id || null;
                        }
                    }
                    if (syncCats.has(details.category) && (compactAllSyncSelected || details.default !== false)) conf.events[evt].sync_enabled = true;
                }
            } else if (session.mode === 'full') {
                for (const evt of session.local) {
                    try {
                        if (conf.events[evt]) {
                            conf.events[evt].enabled = true;
                            if (selectedLocalChannel) {
                                conf.events[evt].channel_id = selectedLocalChannel.id;
                            } else {
                                const ch = await this.ensureLogTextChannel(guild, category, evt, conf.events[evt].channel_id, createdChannels);
                                conf.events[evt].channel_id = ch.id;
                            }
                        }
                    } catch (err) {
                        console.error(`Missing permissions for local channel ${evt}`);
                    }
                }
                for (const evt of session.sync) {
                    if (conf.events[evt]) conf.events[evt].sync_enabled = true;
                }
            }
            
            if (canHostSyncInbox) {
                const syncFallback = await this.ensureLogTextChannel(guild, category, 'server-logs', conf.sync_channel_id, createdChannels);
                conf.sync_channel_id = syncFallback.id;
            } else {
                conf.sync_channel_id = null;
            }

            const syncCreatedCount = await this.ensureSyncTargets(interaction.guildId, session);
            this.saveConfig();
            if (createdChannels.length > 0) {
                this.client.undoHistory.set(interaction.guildId, { type: 'logger_setup', channels: createdChannels, timestamp: Date.now() });
            }
            this.setupSessions.delete(interaction.guildId);
            await interaction.editReply({ content: `✅ Logger initialized successfully! (**${createdChannels.length}** local channel(s) created, **${syncCreatedCount}** sync-target channel(s) created). Use \`abc.undo\` to revert local creations.`, embeds: [], components: [] });
        } catch (e) {
            console.error(e);
            await interaction.editReply({ content: `❌ Error during channel generation: ${e.message}`, components: [], embeds: [] });
        }
    }

    async handleLogCommand(message, args) {
        const action = (args.shift() || '').toLowerCase();

        if (!action || action === 'help') {
            return message.reply([
                'Usage:',
                '`abc.log setup` - Open the interactive logger setup wizard.',
                '`abc.log style <synct|visual|classic>` - Change logger embed style.'
            ].join('\n'));
        }

        if (action === 'setup') {
            this.setupSessions.set(message.guild.id, {
                mode: 'compact',
                local: [],
                sync: [],
                localTargetChannelId: null,
                step: 'mode_select'
            });

            // Trigger real-time multipage wizard via helper
            const initMsg = await message.reply({ content: "**Loading Interactive Setup Wizard...**" });
            return this.renderWizardPage(initMsg, this.setupSessions.get(message.guild.id));
        }
        
        if (action === 'style') {
            const style = args[0] || 'synct';
            if (['visual', 'classic', 'synct'].includes(style)) {
                const conf = this.getGuildConfig(message.guild.id);
                conf.embed_style = style;
                this.saveConfig();
                return message.reply(`Logger style updated to **${style}**.`);
            }
            return message.reply([
                'Usage:',
                '`abc.log style <synct|visual|classic>`',
                'Valid styles: `visual`, `classic`, `synct`'
            ].join('\n'));
        }

        return message.reply([
            'Unknown log action.',
            'Usage:',
            '`abc.log setup` - Open the interactive logger setup wizard.',
            '`abc.log style <synct|visual|classic>` - Change logger embed style.'
        ].join('\n'));
    }
}

function isCategoryFullError(error) {
    const message = String(error?.message || '');
    return message.includes('CHANNEL_PARENT_MAX_CHANNELS') || message.includes('Maximum number of channels in category reached');
}

// eventKey -> category, and the ordered category list - shared with the log
// store / dashboard so logs can be grouped exactly like the Discord channels.
const EVENT_CATEGORY = Object.fromEntries(Object.entries(EVENT_REGISTRY).map(([k, v]) => [k, v.category]));

module.exports = { LoggerCog, EVENT_CATEGORY, LOG_CATEGORIES: ALL_LOG_CATEGORIES };
