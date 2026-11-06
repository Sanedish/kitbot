const { Client, GatewayIntentBits, Intents, Constants, Events, PermissionsBitField, Partials, ActivityType, version: discordJsVersion } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const fs = require('fs');
const os = require('os');
require('dotenv').config();
const { config, getConfig } = require('./config-store');
const packageJson = require('./package.json');
// const { SocialsCog } = require('./cogs/socials');
const { LoggerCog } = require('./cogs/logger');
const { ModmailCog, MODMAIL_CATEGORIES } = require('./cogs/modmail');
const { ModmailDebugCog } = require('./cogs/modmail-debug');
// const { AIChatCog } = require('./cogs/ai-chat');
// const { ComfyUICog } = require('./cogs/comfyui');
const { StarboardCog } = require('./cogs/starboard');
const { LevelingCog } = require('./cogs/leveling');
const { EmbedBuilderCog } = require('./cogs/embed-builder');
const { MusicCog } = require('./cogs/music');
const { MusicDashboardCog } = require('./cogs/music-dashboard');
const { ModStore } = require('./cogs/mod-store');
const { ModerationCog } = require('./cogs/moderation');
const { LogStore } = require('./cogs/log-store');
const { ModDashboardCog } = require('./cogs/mod-dashboard');
const { FahCog } = require('./cogs/fah');
const { startPocketBase, PbClient } = require('./cogs/pb');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ChannelType } = require('discord.js');

const featureDefaults = config.feature_defaults || {};
const DEFAULT_AUTO_DELETE_CHANNEL_ID = featureDefaults.autodelete_channel_id || null;
const DEFAULT_AUTO_DELETE_IMMUNE_MESSAGE_IDS = featureDefaults.autodelete_immune_message_ids || [];
const AUTO_DELETE_CUTOFF_TIMESTAMP = Date.parse('2026-01-01T00:00:00.000Z');
const DEFAULT_AUTO_THREAD_CHANNEL_IDS = featureDefaults.auto_thread_channel_ids || [];
const DEFAULT_AUTO_MESSAGE_CHANNEL_ID = featureDefaults.auto_message_channel_id || null;
const NO_OVERWRITE_CHANNEL_IDS = new Set(featureDefaults.no_overwrite_channel_ids || []);
const AUTO_MESSAGE_TEXT = 'Make sure to read the pinned message before asking a question!\n-# [I`m a bot, I **autosend** this cuz I wanna feel important! ^w^]';
const AUTO_MESSAGE_IDLE_DELAY_MS = 1000;
const AUTO_MESSAGE_SEND_INTERVAL_MS = 1500;
const AUTO_MESSAGE_CLEANUP_FETCH_LIMIT = 25;
const AUTO_MESSAGE_MAX_STICKY_DELETIONS = 5;
const BOT_INTERACTION_SYNC_GUILD_ID = config.staff_guild_id || null;
const BOT_INTERACTION_SYNC_CHANNEL_ID = config.bot_interaction_sync_channel_id || null;
const featureStateFilePath = './data/feature_state.json';
const USER_ID_PATTERN = /^\d+$/;
const IntentFlags = GatewayIntentBits || Intents?.FLAGS || {};
const getIntentFlag = (primary, legacy) => IntentFlags[primary] ?? IntentFlags[legacy];
const PartialFlags = Partials || Constants?.Partials || {};
const defaultGuildFeatureState = {
    autodeleteEnabled: false,
    autodeleteChannelId: null,
    autodeleteImmuneMessageIds: [],
    autoThreadChannelIds: [],
    autoMessageEnabled: false,
    autoMessageChannelId: null,
    stickyMessageId: null,
    autodeleteUserImmunities: {},
    gamesEnabled: false,
    gamesChannelId: null,
    gamesStatsChannelId: null,
    welcomsgEnabled: false,
    welcomsgText: "👋 **Welcome to the server!**\nIf you have any questions, send me a message to open a ticket with the staff team."
};
const defaultFeatureState = {
    version: 2,
    guilds: {}
};
const COMMAND_USAGE = {
    ping: ['`abc.ping` - Test bot response.'],
    help: ['`abc.help` - Show all command usage.', '`abc.help <command>` - Show usage for one command.'],
    dev: ['`abc.dev allow <id>` - Grant developer rights.', '`abc.dev deny <id>` - Remove developer rights.'],
    eval: ['`abc.eval <code>` - Reserved developer command. Currently unsupported.'],
    autodelete: ['`abc.autodelete status` - Show autodelete status.', '`abc.autodelete enable` - Enable autodelete for the configured channel.', '`abc.autodelete disable` - Disable autodelete.'],
    immune: ['`abc.immune <self|@user|user_id>` - Exempt a user from autodelete.'],
    unimmune: ['`abc.unimmune <self|@user|user_id>` - Remove one immunity you added.', '`abc.unimmune all` - Remove every immunity you added.'],
    enable: ['`abc.enable auto-message` - Enable the sticky bottom reminder.'],
    disable: ['`abc.disable auto-message` - Disable the sticky bottom reminder.'],
    toggle: ['`abc.toggle modmail` - Enable or disable modmail.'],
    close: ['`abc.close` - Close and archive the current modmail ticket.'],
    resolve: ['`abc.resolve` - Mark the current modmail ticket as resolved and archive it.'],
    clear: ['`abc.clear` - Clear AI memory for the current channel.', '`abc.clear <channel>` - Clear AI memory for a specific channel.'],
    aitest: ['`abc.aitest conversation` - Force one ambient KitGST pop-in in the current channel for testing.'],
    level: ['`abc.level` - Show leveling status.', '`abc.level toggle` - Enable or disable leveling for this server.'],
    leveling: [
        '`abc.leveling` - Show leveling channel and level-up settings.',
        '`abc.leveling <channel|off>` - Restrict `k!rank` and `k!rep` to one channel, or clear the restriction.',
        '`abc.leveling lvlup <global|channel>` - Send level-up embeds in the current channel or a specific channel.',
        '`abc.leveling lvlup <channel...> <block|allow>` - Mass blacklist or whitelist level-up channels.'
    ],
    xp: ['`abc.xp` - Show the current XP multiplier.', '`abc.xp <multiplier>` - Set the XP multiplier. Example: `abc.xp 1.33`.'],
    rank: ['`k!rank` - Show your server rank card.', '`k!rank @user` - Show another member\'s rank card.'],
    rep: ['`k!rep @user` - Give one reputation point every 24 hours.'],
    games: [
        '`k.8ball <question>` - Ask the Magic 8-Ball a question.',
        '`k.coinflip` - Flip a coin.',
        '`k.roll [sides]` or `k.roll <count>d<sides>` - Roll dice, e.g. `k.roll 3d6`.',
        '`k.rps <rock|paper|scissors>` - Rock-paper-scissors with score and streak tracking.',
        '`k.choose <a | b | c>` - Let the bot pick between options.',
        '`k.stats [@user]` - View per-user game stats.',
        '`k.lb` - Server-wide games leaderboard.',
        '`k.fah` - Folding@home stats and how we support protein-folding research.',
        '`abc.games <channel|toggle|status|disable>` - Manage where mini-games are enabled.',
        '`_*games statchan <#channel|name|id|link|cleared>` - Staff: route stats commands to a dedicated channel.'
    ],
    music: [
        '`k.play <name>` - Play a track from the library (auto-joins your VC). Alias `p`.',
        '`k.playnext <name>` / `k.search <terms>` - Queue next, or pick from local matches.',
        '`k.queue [page]` / `k.np` - Show the queue / what\'s playing.',
        '`k.skip` / `k.pause` / `k.resume` / `k.stop` - Transport controls.',
        '`k.loop <off|track|queue>` / `k.shuffle` - Loop & shuffle. `k.seek <m:ss>`.',
        '`k.remove <n>` / `k.move <from> <to>` / `k.clear` - Queue editing.',
        '`k.volume <0-200>` - Set playback volume (100 = normal).',
        '`k.join [channel]` / `k.leave` - Summon or dismiss the bot. `k.panel` for buttons. `k.help` for the full list.',
        '`abc.music <stop|clear|force <search>|lock on/off|omnia on/off/status|rescan>` - Staff jukebox controls.'
    ],
    embed: ['`abc.embed` - Open the advanced embed builder with live preview and channel picker.'],
    send: ['`abc.send <channel_id|message_id|auto> <message>` - Send a message as the bot.', '`abc.send embed` - Open the embed builder.'],
    reply: ['`abc.reply <channel_id-message_id|message_id|auto> <message>` - Reply as the bot.'],
    socials: [
        '`abc.socials add <link> [social_name]` - Add a monitored social. [deprecated]',
        '`abc.socials check [social_name]` - Run a manual check. [deprecated]',
        '`abc.socials status <social_name>` - Show current status. [deprecated]',
        '`abc.socials test <social_name>` - Send a test notification. [deprecated]',
        '`abc.socials list` - List monitors. [deprecated]',
        '`abc.socials remove <social_name>` - Remove a monitor. [deprecated]'
    ],
    welcomsg: [
        '`abc.welcomsg` - Toggle welcome direct messages on or off.',
        '`abc.welcomsg <message>` - Set the direct message to send when someone joins.',
        '`abc.welcomsg-test` - Send the current welcome message to your DMs as a test.'
    ],
    config: [
        '`abc.config soc_ping <social_name> <channel|here|off>` - Set the ping channel.',
        '`abc.config soc_msg <social_name> <message|reset>` - Set or reset the outgoing message.'
    ],
     unlog: ['`abc.unlog [channel]` - Stop all logs from being sent to a specific channel.'],  log: ['`abc.log setup` - Open the interactive logger setup.', '`abc.log style <synct|visual|classic>` - Change logger embed style.'],
    undo: ['`abc.undo` - Revert the most recent logger setup creation.'],
    delete: ['`abc.delete <channel_id_or_mention> ...` - Delete one or more channels/categories.'],
    secret_send_msg: ['`_*send_msg <channel_id|message_id|auto> <message>` - Send a hidden staff message.'],
    secret_reply: ['`_*reply <channel_id-message_id|message_id|auto> <message>` - Send a hidden staff reply.'],
    secret_ai: ['`_*ai toggle [channel]` - Toggle AI replies for the current or chosen channel.', '`_*ai toggle global` - Toggle ambient guild-wide pop-ins for the current server.', '`_*ai clear [channel]` - Clear AI memory for the current or chosen channel.', '`_*ai toggle ima-gen [channel]` - Toggle ComfyUI image generation for the current or chosen channel.', '`_*ai imagen <only|duo> [channel]` - Enable image generation in image-only or mixed mode for the current or chosen channel.'],
    secret_music: ['`_*music status` - Deep jukebox diagnostics (pipelines, pids, library).', '`_*music reset` - Panic reset: stop, clear queue, Omnia off, unlock, leave voice.']
};
const HELP_SECTIONS = [
    { name: 'Core', keys: ['ping', 'help'] },
    { name: 'Developer', keys: ['dev', 'eval', 'clear'] },
    { name: 'Moderation', keys: ['autodelete', 'immune', 'unimmune', 'enable', 'disable', 'welcomsg'] },
    { name: 'Modmail', keys: ['toggle', 'close', 'resolve'] },
    { name: 'Leveling', keys: ['level', 'leveling', 'xp', 'rank', 'rep'] },
    { name: 'Mini-Games', keys: ['games'] },
    { name: 'Jukebox', keys: ['music'] },
    { name: 'Messaging', keys: ['embed', 'send', 'reply'] },
    { name: 'Socials [deprecated]', keys: ['socials', 'config'] },
    { name: 'Logger', keys: ['log', 'undo', 'delete'] },
    { name: 'Hidden Staff', keys: ['secret_send_msg', 'secret_reply', 'secret_ai', 'secret_music'] }
];
const APPLICATION_COMMAND_BUILDERS = [
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('Open a geeky info panel for the bot, host, or current server.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('host')
                .setDescription('Show a sanitized telemetry snapshot of the host system.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('bot')
                .setDescription('Show runtime stats and build info for the bot.')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('server')
                .setDescription('Show a server snapshot for the current guild.')
        )
    ,
    new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('Open a modmail ticket with staff from inside the server.')
        .addStringOption(option =>
            option
                .setName('category')
                .setDescription('Choose the category that best matches your issue.')
                .setRequired(true)
                .addChoices(
                    ...Object.values(MODMAIL_CATEGORIES).map(category => ({
                        name: category.label,
                        value: category.id
                    }))
                )
        )
        .addStringOption(option =>
            option
                .setName('message')
                .setDescription('Your initial message to staff.')
                .setRequired(true)
        )
];
const INFO_EMBED_COLORS = {
    host: 0x38BDF8,
    bot: 0x22C55E,
    server: 0xF97316
};

// 1. Setup Persistent Developer Storage
const devsFilePath = './data/developers/dev_allowlist.json';
let allowedDevs = new Set();
let featureState = { ...defaultFeatureState };
const channelTaskQueues = new Map();
const autoMessageLastSentAt = new Map();
const autoMessageRefreshTimers = new Map();
const OWNER_CHANNEL_OVERWRITE = {
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
// Load existing devs if the file exists, otherwise create it
if (fs.existsSync(devsFilePath)) {
    const rawData = fs.readFileSync(devsFilePath);
    allowedDevs = new Set(JSON.parse(rawData));
} else {
    fs.writeFileSync(devsFilePath, JSON.stringify([]));
}

// Helper function to save dev list to file
const saveDevs = () => {
    fs.writeFileSync(devsFilePath, JSON.stringify([...allowedDevs], null, 2));
};

const getUsageText = key => {
    const entries = COMMAND_USAGE[key] || [];
    return entries.join('\n');
};

const normalizeHelpTopic = rawTopic => {
    const value = String(rawTopic || '').trim().toLowerCase();
    if (!value) return '';

    const cleaned = value
        .replace(/^abc\./, '')
        .replace(/^k!/, '')
        .replace(/^k\./, '')
        .replace(/^_\*/, '')
        .replace(/[<>`]/g, '');

    if (cleaned === 'send_msg') return 'secret_send_msg';
    if (cleaned === 'ai') return 'secret_ai';
    if (['8ball', 'coinflip', 'flip', 'roll', 'rps', 'choose', 'pick', 'stats', 'lb', 'leaderboard'].includes(cleaned)) return 'games';
    if (['play', 'p', 'playnext', 'pn', 'search', 'find', 'np', 'nowplaying', 'queue', 'q', 'skip', 's', 'next', 'pause', 'resume', 'stop', 'clear', 'loop', 'repeat', 'shuffle', 'remove', 'rm', 'move', 'seek', 'volume', 'vol', 'v', 'join', 'summon', 'leave', 'disconnect', 'dc', 'panel', 'jukebox', 'controls'].includes(cleaned)) return 'music';
    return cleaned;
};

const buildHelpEmbed = () => {
    const embed = new EmbedBuilder()
        .setTitle('kitbot Command Usage')
        .setColor('#8B5CF6');

    embed.addFields(
        ...HELP_SECTIONS.map(section => ({
            name: section.name,
            value: section.keys.map(key => getUsageText(key)).filter(Boolean).join('\n')
        }))
    );

    return embed;
};

const formatBytes = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

const formatDuration = totalMs => {
    const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const segments = [];

    if (days) segments.push(`${days}d`);
    if (hours || segments.length) segments.push(`${hours}h`);
    if (minutes || segments.length) segments.push(`${minutes}m`);
    segments.push(`${seconds}s`);

    return segments.join(' ');
};

const formatRelativeTimestampFromMs = msAgo =>
    `<t:${Math.floor((Date.now() - msAgo) / 1000)}:R>`;

const getTotalKnownMembers = readyClient =>
    readyClient.guilds.cache.reduce((sum, guild) => sum + (guild.memberCount || 0), 0);

const buildHostInfoEmbed = requestingUser => {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const uptimeMs = os.uptime() * 1000;

    return new EmbedBuilder()
        .setColor(INFO_EMBED_COLORS.host)
        .setTitle('kitbot Host Telemetry')
        .setDescription('Shows sanitized info about the machine running kitbot')
        .addFields(
            {
                name: 'Kernel',
                value: [
                    `Platform: \`${process.platform}\``,
                    `Release: \`${os.release()}\``,
                    `Architecture: \`${os.arch()}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Compute',
                value: [
                    `Logical cores: \`${cpus.length || 'unknown'}\``,
                    `RAM Usage: \`${formatBytes(usedMemory)} / ${formatBytes(totalMemory)}\``,
                    `Last Server Restart: ${formatRelativeTimestampFromMs(uptimeMs)}`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Runtime',
                value: [
                    `Node.js: \`${process.version}\``,
                    `discord.js: \`v${discordJsVersion}\``,
                    `Load average: \`${os.loadavg().map(value => value.toFixed(2)).join(' / ')}\``
                ].join('\n'),
                inline: true
            }
        )
        .setFooter({ text: `Telemetry requested by ${requestingUser.tag}` })
        .setTimestamp();
};

const { MessageFlags } = require('discord.js');

const buildBotInfoEmbed = (readyClient, requestingUser) => {
    const memoryUsage = process.memoryUsage();
    const loadedCogs = Object.keys(readyClient.cogs || {});

    return new EmbedBuilder()
        .setColor(INFO_EMBED_COLORS.bot)
        .setTitle('Kitbot Activity Stats')
        .setDescription('Live process stats, such as uptime, buildstacks and footprints.')
        .setThumbnail(readyClient.user.displayAvatarURL())
        .addFields(
            {
                name: 'Build Stack',
                value: [
                    `Package: \`kitbot v${packageJson.version}\``,
                    `Node.js: \`${process.version}\``,
                    `discord.js: \`v${discordJsVersion}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Session',
                value: [
                    `Gateway ping: \`${readyClient.ws.ping} ms\``,
                    `Last downtime: ${formatRelativeTimestampFromMs(readyClient.uptime || 0)}`,
                    `Bot uptime: \`${formatDuration(process.uptime() * 1000)}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Footprint',
                value: [
                    `RSS: \`${formatBytes(memoryUsage.rss)}\``,
                    `Heap used: \`${formatBytes(memoryUsage.heapUsed)} / ${formatBytes(memoryUsage.heapTotal)}\``,
                    `External: \`${formatBytes(memoryUsage.external)}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Reach',
                value: [
                    `Guilds online: \`${readyClient.guilds.cache.size}\``,
                    `Channels cached: \`${readyClient.channels.cache.size}\``,
                    `Known members: \`${getTotalKnownMembers(readyClient)}\``
                ].join('\n'),
                inline: true
            }
            
        )
        .setFooter({ text: `Stats requested by ${requestingUser.tag}` })
        .setTimestamp();
};

const buildServerInfoEmbed = (guild, requestingUser) => {
    const channels = guild.channels.cache;
    const textChannels = channels.filter(channel => channel.type === ChannelType.GuildText).size;
    const voiceChannels = channels.filter(channel => channel.type === ChannelType.GuildVoice).size;
    const forumChannels = channels.filter(channel => channel.type === ChannelType.GuildForum).size;
    const categories = channels.filter(channel => channel.type === ChannelType.GuildCategory).size;
    const threads = channels.filter(channel => channel.isThread?.()).size;
    const emojis = guild.emojis?.cache?.size || 0;
    const stickers = guild.stickers?.cache?.size || 0;

    const embed = new EmbedBuilder()
        .setColor(INFO_EMBED_COLORS.server)
        .setTitle(`Snapshot of ${guild.name} (${guild.id})`)
        .setDescription('Sanitized guild info showing information, such as creation, topology, etc')
        .addFields(
            {
                name: 'Core:',
                value: [
                    `Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`,
                    `Members: \`${guild.memberCount ?? 'unknown'}\``,
                    `Verification: \`${String(guild.verificationLevel).toLowerCase()}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Channel Topology:',
                value: [
                    `Text: \`${textChannels}\``,
                    `Voice: \`${voiceChannels}\``,
                    `Forum: \`${forumChannels}\``,
                    `Threads: \`${threads}\``,
                    `Categories: \`${categories}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Decorators:',
                value: [
                    `Roles: \`${Math.max(0, guild.roles.cache.size - 1)}\``,
                    `Emojis: \`${emojis}\``,
                    `Stickers: \`${stickers}\``,
                    `Boost tier: \`${guild.premiumTier || 0}\``
                ].join('\n'),
                inline: true
            },
            {
                name: 'Other:',
                value: [
                    `Preferred locale: \`${guild.preferredLocale || 'unknown'}\``,
                    `NSFW level: \`${String(guild.nsfwLevel).toLowerCase()}\``,
                    `Vanity URL: \`${guild.vanityURLCode ? 'configured' : 'not configured'}\``
                ].join('\n'),
                inline: true
            }
        )
        .setFooter({ text: `Snapshot requested by ${requestingUser.tag}` })
        .setTimestamp();


    const guildIconUrl = guild.iconURL();
    if (guildIconUrl) embed.setThumbnail(guildIconUrl);

    return embed;
};

async function syncApplicationInfoCommands(readyClient) {
    const commandPayload = APPLICATION_COMMAND_BUILDERS.map(builder => builder.toJSON());
    const guildRefs = await readyClient.guilds.fetch();
    for (const guildRef of guildRefs.values()) {
        const guild = readyClient.guilds.cache.get(guildRef.id) || await readyClient.guilds.fetch(guildRef.id).catch(() => null);
        if (!guild) continue;
        await guild.commands.set(commandPayload);
    }
    console.log(`[SYNC] Guild slash commands synced.`);
}

async function handleInfoSlashCommand(interaction) {
    const requestedPanel = interaction.options.getSubcommand();

    if (requestedPanel === 'host') {
        if (!interaction.inGuild() || !interaction.guild) {
            return interaction.reply({
                content: 'Commands are not intented for usage in dms due to them interfering with modmail. Use any channel in the server, messages are ephemeral.',
                ephemeral: true
            });
        }
        
        return interaction.reply({ embeds: [buildHostInfoEmbed(interaction.user)], flags: MessageFlags.Ephemeral});
    }

    if (requestedPanel === 'bot') {
        if (!interaction.inGuild() || !interaction.guild) {
            return interaction.reply({
                content: 'Commands are not intented for usage in dms due to them interfering with modmail. Use any channel in the server, messages are ephemeral.',
                ephemeral: true
            });
        }

        return interaction.reply({ embeds: [buildBotInfoEmbed(interaction.client, interaction.user)], flags: MessageFlags.Ephemeral});
    }

    if (requestedPanel === 'server') {
        if (!interaction.inGuild() || !interaction.guild) {
            return interaction.reply({
                content: 'Commands are not intented for usage in dms due to them interfering with modmail. Use any channel in the server, messages are ephemeral.',
                ephemeral: true
            });
        }

        return interaction.reply({ embeds: [buildServerInfoEmbed(interaction.guild, interaction.user)], flags: MessageFlags.Ephemeral});
    }

    return interaction.reply({
        content: 'Unknown info panel requested.',
        ephemeral: true
    });
}

const normalizeIdList = value =>
    [...new Set(
        Array.isArray(value)
            ? value.filter(item => typeof item === 'string' && USER_ID_PATTERN.test(item))
            : []
    )];

const normalizeAutodeleteUserImmunities = rawImmunities => {
    const normalizedImmunities = {};
    if (!rawImmunities || typeof rawImmunities !== 'object') return normalizedImmunities;

    for (const [moderatorId, userIds] of Object.entries(rawImmunities)) {
        if (!USER_ID_PATTERN.test(moderatorId) || !Array.isArray(userIds)) continue;

        const normalizedUserIds = [...new Set(
            userIds.filter(userId => typeof userId === 'string' && USER_ID_PATTERN.test(userId))
        )];

        if (normalizedUserIds.length > 0) {
            normalizedImmunities[moderatorId] = normalizedUserIds;
        }
    }

    return normalizedImmunities;
};

const normalizeGuildFeatureState = rawState => ({
    autodeleteEnabled: Boolean(rawState?.autodeleteEnabled),
    autodeleteChannelId: typeof rawState?.autodeleteChannelId === 'string' ? rawState.autodeleteChannelId : null,
    autodeleteImmuneMessageIds: normalizeIdList(rawState?.autodeleteImmuneMessageIds),
    autoThreadChannelIds: normalizeIdList(rawState?.autoThreadChannelIds),
    autoMessageEnabled: Boolean(rawState?.autoMessageEnabled),
    autoMessageChannelId: typeof rawState?.autoMessageChannelId === 'string' ? rawState.autoMessageChannelId : null,
    stickyMessageId: typeof rawState?.stickyMessageId === 'string' ? rawState.stickyMessageId : null,
    autodeleteUserImmunities: normalizeAutodeleteUserImmunities(rawState?.autodeleteUserImmunities),
    gamesEnabled: Boolean(rawState?.gamesEnabled),
    gamesChannelId: typeof rawState?.gamesChannelId === 'string' ? rawState.gamesChannelId : null,
    gamesStatsChannelId: typeof rawState?.gamesStatsChannelId === 'string' ? rawState.gamesStatsChannelId : null,
    welcomsgEnabled: Boolean(rawState?.welcomsgEnabled),
    welcomsgText: typeof rawState?.welcomsgText === 'string' ? rawState.welcomsgText : "👋 **Welcome to the server!**\nIf you have any questions, send me a message to open a ticket with the staff team."
});

const normalizeFeatureState = rawState => {
    if (rawState?.guilds && typeof rawState.guilds === 'object') {
        const guilds = {};
        for (const [guildId, guildState] of Object.entries(rawState.guilds)) {
            if (!USER_ID_PATTERN.test(guildId)) continue;
            guilds[guildId] = normalizeGuildFeatureState(guildState);
        }

        return {
            version: 2,
            guilds
        };
    }

    // Migrate legacy global feature state into a temporary bucket that startup will re-home by channel ownership.
    return {
        version: 2,
        guilds: {
            __legacy__: {
                autodeleteEnabled: Boolean(rawState?.autodeleteEnabled),
                autodeleteChannelId: DEFAULT_AUTO_DELETE_CHANNEL_ID,
                autodeleteImmuneMessageIds: [...DEFAULT_AUTO_DELETE_IMMUNE_MESSAGE_IDS],
                autoThreadChannelIds: [...DEFAULT_AUTO_THREAD_CHANNEL_IDS],
                autoMessageEnabled: Boolean(rawState?.autoMessageEnabled),
                autoMessageChannelId: DEFAULT_AUTO_MESSAGE_CHANNEL_ID,
                stickyMessageId: typeof rawState?.stickyMessageId === 'string' ? rawState.stickyMessageId : null,
                autodeleteUserImmunities: normalizeAutodeleteUserImmunities(rawState?.autodeleteUserImmunities),
                gamesEnabled: Boolean(rawState?.gamesEnabled),
                gamesChannelId: typeof rawState?.gamesChannelId === 'string' ? rawState.gamesChannelId : null,
                gamesStatsChannelId: typeof rawState?.gamesStatsChannelId === 'string' ? rawState.gamesStatsChannelId : null,
                welcomsgEnabled: Boolean(rawState?.welcomsgEnabled),
                welcomsgText: typeof rawState?.welcomsgText === 'string' ? rawState.welcomsgText : "👋 **Welcome to the server!**\nIf you have any questions, send me a message to open a ticket with the staff team."
            }
        }
    };
};

if (fs.existsSync(featureStateFilePath)) {
    const rawFeatureState = fs.readFileSync(featureStateFilePath, 'utf8');
    featureState = normalizeFeatureState(JSON.parse(rawFeatureState));
} else {
    fs.writeFileSync(featureStateFilePath, JSON.stringify(defaultFeatureState, null, 2));
}

const saveFeatureState = () => {
    fs.writeFileSync(featureStateFilePath, JSON.stringify(featureState, null, 2));
};

async function ensureOwnerChannelAccess(channel) {
    if (!channel?.permissionOverwrites) return;
    if (NO_OVERWRITE_CHANNEL_IDS.has(channel.id)) return;
    const liveConfig = getConfig();
    await channel.permissionOverwrites.edit(liveConfig.master_id, OWNER_CHANNEL_OVERWRITE).catch(() => {});
}

async function handleModmailSlashCommand(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
        return interaction.reply({
            content: 'Use `/modmail` inside the server so I can open the ticket reliably without depending on cold DMs.',
            ephemeral: true
        });
    }

    const categoryId = interaction.options.getString('category', true);
    const message = interaction.options.getString('message', true);
    const result = await modmailCog.createTicketFromSlashCommand(interaction.user, categoryId, message);

    if (!result?.ok) {
        return interaction.reply({
            content: result?.reason || 'I could not create your modmail ticket right now.',
            ephemeral: true
        });
    }

    return interaction.reply({
        content: result.dmReady
            ? 'Your modmail ticket has been created. Staff will reply to you in DMs.'
            : 'Your modmail ticket has been created. I could not confirm the DM channel immediately, but staff still has your ticket.',
        ephemeral: true
    });
}

const getGuildFeatureState = guildId => {
    const existingState = featureState.guilds[guildId];
    const normalizedState = normalizeGuildFeatureState(existingState || defaultGuildFeatureState);
    const shouldPersist =
        !existingState ||
        JSON.stringify(existingState) !== JSON.stringify(normalizedState);

    featureState.guilds[guildId] = normalizedState;

    if (shouldPersist) {
        saveFeatureState();
    }

    return normalizedState;
};

const enqueueChannelTask = (channelId, task) => {
    const previousTask = channelTaskQueues.get(channelId) || Promise.resolve();
    const nextTask = previousTask
        .catch(() => {})
        .then(task)
        .catch(error => {
            console.error(`[FEATURES] Channel task failed for ${channelId}:`, error);
        })
        .finally(() => {
            if (channelTaskQueues.get(channelId) === nextTask) {
                channelTaskQueues.delete(channelId);
            }
        });

    channelTaskQueues.set(channelId, nextTask);
    return nextTask;
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function throttleAutoMessageSend(channelId) {
    const lastSentAt = autoMessageLastSentAt.get(channelId) || 0;
    const elapsedMs = Date.now() - lastSentAt;

    if (elapsedMs < AUTO_MESSAGE_SEND_INTERVAL_MS) {
        await wait(AUTO_MESSAGE_SEND_INTERVAL_MS - elapsedMs);
    }
}

async function seedConfiguredGuildFeatureDefaults(readyClient) {
    const knownChannels = [
        { feature: 'autodelete', channelId: DEFAULT_AUTO_DELETE_CHANNEL_ID },
        { feature: 'autoMessage', channelId: DEFAULT_AUTO_MESSAGE_CHANNEL_ID },
        ...DEFAULT_AUTO_THREAD_CHANNEL_IDS.map(channelId => ({ feature: 'autoThread', channelId }))
    ];

    for (const { feature, channelId } of knownChannels.filter(entry => entry.channelId)) {
        const channel = await readyClient.channels.fetch(channelId).catch(() => null);
        if (!channel?.guildId) continue;

        const guildState = getGuildFeatureState(channel.guildId);

        if (feature === 'autodelete' && !guildState.autodeleteChannelId) {
            guildState.autodeleteChannelId = channelId;
            guildState.autodeleteImmuneMessageIds = [...DEFAULT_AUTO_DELETE_IMMUNE_MESSAGE_IDS];
        }

        if (feature === 'autoMessage' && !guildState.autoMessageChannelId) {
            guildState.autoMessageChannelId = channelId;
        }

        if (feature === 'autoThread' && !guildState.autoThreadChannelIds.includes(channelId)) {
            guildState.autoThreadChannelIds.push(channelId);
        }
    }

    saveFeatureState();
}

async function migrateLegacyFeatureState(readyClient) {
    const legacyState = featureState.guilds.__legacy__;
    if (!legacyState) return;

    const migrateChannelToGuild = async channelId => {
        const channel = channelId ? await readyClient.channels.fetch(channelId).catch(() => null) : null;
        return channel?.guildId || null;
    };

    const autodeleteGuildId = await migrateChannelToGuild(legacyState.autodeleteChannelId);
    const autoMessageGuildId = await migrateChannelToGuild(legacyState.autoMessageChannelId);
    const autoThreadAssignments = new Map();

    for (const channelId of legacyState.autoThreadChannelIds || []) {
        const guildId = await migrateChannelToGuild(channelId);
        if (!guildId) continue;
        if (!autoThreadAssignments.has(guildId)) autoThreadAssignments.set(guildId, []);
        autoThreadAssignments.get(guildId).push(channelId);
    }

    if (autodeleteGuildId) {
        const guildState = getGuildFeatureState(autodeleteGuildId);
        guildState.autodeleteEnabled = legacyState.autodeleteEnabled;
        guildState.autodeleteChannelId = legacyState.autodeleteChannelId;
        guildState.autodeleteImmuneMessageIds = normalizeIdList([
            ...normalizeIdList(guildState.autodeleteImmuneMessageIds),
            ...(legacyState.autodeleteImmuneMessageIds || [])
        ]);
        guildState.autodeleteUserImmunities = normalizeAutodeleteUserImmunities(legacyState.autodeleteUserImmunities);
    }

    if (autoMessageGuildId) {
        const guildState = getGuildFeatureState(autoMessageGuildId);
        guildState.autoMessageEnabled = legacyState.autoMessageEnabled;
        guildState.autoMessageChannelId = legacyState.autoMessageChannelId;
        guildState.stickyMessageId = legacyState.stickyMessageId;
    }

    for (const [guildId, channelIds] of autoThreadAssignments.entries()) {
        const guildState = getGuildFeatureState(guildId);
        guildState.autoThreadChannelIds = normalizeIdList([
            ...normalizeIdList(guildState.autoThreadChannelIds),
            ...channelIds
        ]);
    }

    delete featureState.guilds.__legacy__;
    saveFeatureState();
}

function scheduleAutoMessageRefresh(channel, delayMs = AUTO_MESSAGE_IDLE_DELAY_MS) {
    if (!channel?.guildId) return;

    const guildState = getGuildFeatureState(channel.guildId);
    if (!guildState.autoMessageEnabled || channel.id !== guildState.autoMessageChannelId) return;

    const existingTimer = autoMessageRefreshTimers.get(channel.id);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        autoMessageRefreshTimers.delete(channel.id);
        void refreshAutoMessage(channel);
    }, delayMs);

    autoMessageRefreshTimers.set(channel.id, timer);
}

const getAutodeleteImmuneUserIds = guildState => new Set(
    Object.values(guildState?.autodeleteUserImmunities || {}).flat()
);

const isImmuneAutodeleteMessage = message =>
    Boolean(message && message.guildId && (() => {
        const guildState = getGuildFeatureState(message.guildId);
        return (
            guildState.autodeleteImmuneMessageIds.includes(message.id) ||
            getAutodeleteImmuneUserIds(guildState).has(message.author?.id)
        );
    })());

const resolveImmunityTarget = (rawTarget, message) => {
    if (!rawTarget) return null;

    if (rawTarget.toLowerCase() === 'self') return message.author.id;

    const mentionedUser = message.mentions.users.first();
    if (mentionedUser) return mentionedUser.id;

    const cleanedTarget = rawTarget.replace(/[<@!>]/g, '');
    return USER_ID_PATTERN.test(cleanedTarget) ? cleanedTarget : null;
};

const shouldAutodeleteMessage = message =>
    Boolean(
        message &&
        message.guildId &&
        getGuildFeatureState(message.guildId).autodeleteEnabled &&
        message.channelId === getGuildFeatureState(message.guildId).autodeleteChannelId &&
        message.createdTimestamp >= AUTO_DELETE_CUTOFF_TIMESTAMP &&
        !isImmuneAutodeleteMessage(message)
    );

const buildThreadName = message => {
    const compactContent = message.content?.replace(/\s+/g, ' ').trim();
    if (compactContent) return compactContent.slice(0, 100);

    const authorName = message.member?.displayName || message.author?.username || 'message';
    return `${authorName}'s thread`.slice(0, 100);
};

async function ensureAutoThread(message) {
    if (message.system || !message.guild) return;
    const guildState = getGuildFeatureState(message.guild.id);
    if (!guildState.autoThreadChannelIds.includes(message.channelId)) return;
    if (message.channel?.isThread?.() || message.hasThread) return;

    try {
        await message.startThread({
            name: buildThreadName(message),
            autoArchiveDuration: 1440
        });
    } catch (error) {
        console.error(`[THREAD] Failed to create thread for message ${message.id}:`, error.message);
    }
}

async function safelyDeleteMessage(message) {
    if (!shouldAutodeleteMessage(message) || !message.deletable) return false;

    try {
        await message.delete();
        return true;
    } catch (error) {
        console.error(`[AUTODELETE] Failed to delete message ${message.id}:`, error.message);
        return false;
    }
}

function scheduleAutodelete(message) {
    if (!shouldAutodeleteMessage(message)) return;

    setTimeout(() => {
        void safelyDeleteMessage(message);
    }, 1500);
}

async function sweepAutodeleteChannel(channel, transientImmuneIds = new Set()) {
    let deletedCount = 0;
    let skippedImmuneCount = 0;
    let beforeId = null;

    while (true) {
        const fetchOptions = { limit: 100 };
        if (beforeId) fetchOptions.before = beforeId;

        const batch = await channel.messages.fetch(fetchOptions).catch(error => {
            console.error('[AUTODELETE] Failed to fetch channel history:', error.message);
            return null;
        });

        if (!batch || batch.size === 0) break;

        let reachedCutoff = false;
        for (const fetchedMessage of batch.values()) {
            if (fetchedMessage.createdTimestamp < AUTO_DELETE_CUTOFF_TIMESTAMP) {
                reachedCutoff = true;
                break;
            }

            if (isImmuneAutodeleteMessage(fetchedMessage) || transientImmuneIds.has(fetchedMessage.id)) {
                skippedImmuneCount++;
                continue;
            }

            if (!fetchedMessage.deletable) continue;

            try {
                await fetchedMessage.delete();
                deletedCount++;
            } catch (error) {
                console.error(`[AUTODELETE] Failed to delete backlog message ${fetchedMessage.id}:`, error.message);
            }
        }

        if (reachedCutoff || batch.size < 100) break;
        beforeId = batch.last().id;
    }

    return { deletedCount, skippedImmuneCount };
}

async function refreshAutoMessage(channel) {
    if (!channel?.guildId) return null;

    const guildState = getGuildFeatureState(channel.guildId);
    if (!guildState.autoMessageEnabled || channel.id !== guildState.autoMessageChannelId) return null;

    return enqueueChannelTask(channel.id, async () => {
        await cleanupAutoMessages(channel, guildState);

        await throttleAutoMessageSend(channel.id);
        const stickyMessage = await channel.send(AUTO_MESSAGE_TEXT);
        autoMessageLastSentAt.set(channel.id, Date.now());
        guildState.stickyMessageId = stickyMessage.id;
        saveFeatureState();
        return stickyMessage;
    });
}

async function clearAutoMessage(channel) {
    if (!channel?.guildId) return;

    const guildState = getGuildFeatureState(channel.guildId);
    if (channel.id !== guildState.autoMessageChannelId) return;

    const pendingTimer = autoMessageRefreshTimers.get(channel.id);
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        autoMessageRefreshTimers.delete(channel.id);
    }

    await enqueueChannelTask(channel.id, async () => {
        await cleanupAutoMessages(channel, guildState);

        guildState.stickyMessageId = null;
        saveFeatureState();
    });
}

function isAutoStickyMessage(message) {
    return Boolean(
        message &&
        message.author?.id === client.user?.id &&
        message.content === AUTO_MESSAGE_TEXT
    );
}

async function cleanupAutoMessages(channel, guildState) {
    const candidateMessages = new Map();
    const previousStickyId = guildState?.stickyMessageId;

    if (previousStickyId) {
        const previousSticky = await channel.messages.fetch(previousStickyId).catch(() => null);
        if (previousSticky) {
            candidateMessages.set(previousSticky.id, previousSticky);
        }
    }

    const recentMessages = await channel.messages
        .fetch({ limit: AUTO_MESSAGE_CLEANUP_FETCH_LIMIT })
        .catch(() => null);

    for (const message of recentMessages?.values() || []) {
        if (!isAutoStickyMessage(message)) continue;
        candidateMessages.set(message.id, message);
        if (candidateMessages.size >= AUTO_MESSAGE_MAX_STICKY_DELETIONS) break;
    }

    let deletedCount = 0;
    for (const stickyMessage of candidateMessages.values()) {
        if (deletedCount >= AUTO_MESSAGE_MAX_STICKY_DELETIONS) break;
        if (!stickyMessage.deletable) continue;

        await stickyMessage.delete().catch(() => {});
        deletedCount++;
    }

    return deletedCount;
}

async function initializeOperationalFeatures(readyClient) {
    await migrateLegacyFeatureState(readyClient);
    await seedConfiguredGuildFeatureDefaults(readyClient);

    for (const [guildId, guildState] of Object.entries(featureState.guilds)) {
        if (!USER_ID_PATTERN.test(guildId)) continue;

        if (guildState.autodeleteEnabled && guildState.autodeleteChannelId) {
            const autoDeleteChannel = await readyClient.channels.fetch(guildState.autodeleteChannelId).catch(() => null);
            if (autoDeleteChannel?.isTextBased()) {
                const { deletedCount, skippedImmuneCount } = await sweepAutodeleteChannel(autoDeleteChannel);
                console.log(`[AUTODELETE] Startup sweep completed for guild ${guildId}. Deleted ${deletedCount} messages and skipped ${skippedImmuneCount} immune messages.`);
            }
        }

        if (guildState.autoMessageEnabled && guildState.autoMessageChannelId) {
            const autoMessageChannel = await readyClient.channels.fetch(guildState.autoMessageChannelId).catch(() => null);
            if (autoMessageChannel?.isTextBased()) {
                scheduleAutoMessageRefresh(autoMessageChannel, 0);
                console.log(`[AUTO-MESSAGE] Sticky bottom message refresh scheduled on startup for guild ${guildId}.`);
            }
        }
    }
}

function isTextMessageChannel(channel) {
    return Boolean(channel?.isTextBased?.() && channel?.messages?.fetch);
}

// HELPER: Auto-fetch target channels across the client for send/reply admin commands.
async function resolveChannel(guild, inputArg, fallbackChannel) {
    if (!inputArg || inputArg === 'auto') return { channel: fallbackChannel, msg: null };

    const normalizedInput = inputArg.replace(/[<#>]/g, '');
    const cachedChannel = guild?.channels?.cache?.get(normalizedInput);
    if (isTextMessageChannel(cachedChannel)) return { channel: cachedChannel, msg: null };

    const fetchedChannel = await client.channels.fetch(normalizedInput).catch(() => null);
    if (isTextMessageChannel(fetchedChannel) && (!guild || fetchedChannel.guildId === guild.id)) {
        return { channel: fetchedChannel, msg: null };
    }

    if (isTextMessageChannel(fallbackChannel)) {
        const fallbackMessage = await fallbackChannel.messages.fetch(normalizedInput).catch(() => null);
        if (fallbackMessage) return { channel: fallbackChannel, msg: fallbackMessage };
    }

    for (const channel of guild?.channels?.cache?.values?.() || []) {
        if (!isTextMessageChannel(channel) || fallbackChannel?.id === channel.id) continue;

        const msg = await channel.messages.fetch(normalizedInput).catch(() => null);
        if (msg) return { channel, msg };
    }

    return { channel: null, msg: null };
}

const client = new Client({
    intents: [
        getIntentFlag('Guilds', 'GUILDS'),
        getIntentFlag('GuildMembers', 'GUILD_MEMBERS'),
        getIntentFlag('GuildModeration', 'GUILD_BANS'),
        getIntentFlag('GuildExpressions', 'GUILD_EMOJIS_AND_STICKERS'),
        getIntentFlag('GuildIntegrations', 'GUILD_INTEGRATIONS'),
        getIntentFlag('GuildWebhooks', 'GUILD_WEBHOOKS'),
        getIntentFlag('GuildInvites', 'GUILD_INVITES'),
        getIntentFlag('GuildVoiceStates', 'GUILD_VOICE_STATES'),
        getIntentFlag('GuildMessages', 'GUILD_MESSAGES'),
        getIntentFlag('GuildMessageReactions', 'GUILD_MESSAGE_REACTIONS'),
        getIntentFlag('DirectMessages', 'DIRECT_MESSAGES'),
        getIntentFlag('MessageContent', 'MESSAGE_CONTENT'),
        getIntentFlag('GuildScheduledEvents', 'GUILD_SCHEDULED_EVENTS'),
        getIntentFlag('AutoModerationConfiguration', 'AUTO_MODERATION_CONFIGURATION'),
        getIntentFlag('AutoModerationExecution', 'AUTO_MODERATION_EXECUTION')
    ].filter(p => p != null),
    partials: [
        PartialFlags.User,
        PartialFlags.Channel,
        PartialFlags.GuildMember,
        PartialFlags.Message,
        PartialFlags.Reaction,
        PartialFlags.GuildScheduledEvent,
        PartialFlags.ThreadMember
    ].filter(p => p != null)
});

// const socialsCog = new SocialsCog(client);
const loggerCog = new LoggerCog(client);
const modmailCog = new ModmailCog(client);
const modmailDebugCog = new ModmailDebugCog(client);
// Deprecated: AIChatCog
// const aiChatCog = new AIChatCog(client);
// Deprecated: ComfyUICog
// const comfyCog = new ComfyUICog(client);
const starboardCog = new StarboardCog(client);
const levelingCog = new LevelingCog(client);
const embedBuilderCog = new EmbedBuilderCog(client);
const musicCog = new MusicCog(client, {
    getConfig,
    isPrivilegedUser: userId => {
        const liveConfig = getConfig();
        return userId === liveConfig.master_id || userId === liveConfig.operator_id || allowedDevs.has(userId);
    }
});
const musicDashboardCog = new MusicDashboardCog(musicCog);

// Moderation subsystem: case/punishment store, enforcement engine, durable logs.
const modStore = new ModStore();
const moderationCog = new ModerationCog(client, { store: modStore, getConfig });
const logStore = new LogStore(client);
// Mirror every LoggerCog emission to data/logs/<channelId>/dd-mm-yyyy.jsonl.
logStore.attach(loggerCog);

// PocketBase: login + staff access control. The bot owns the process and is its
// only client (superuser). See cogs/pb.js and data/staff-access.json.
const pbClient = new PbClient({
    url: process.env.PB_URL,
    email: process.env.PB_ADMIN_EMAIL,
    password: process.env.PB_ADMIN_PASSWORD
});
const modDashboardCog = new ModDashboardCog({ client, moderation: moderationCog, store: modStore, logStore, pb: pbClient });
const fahCog = new FahCog();

// Persist any debounced moderation writes on shutdown so cases aren't lost.
const flushModStore = () => { try { modStore.flush(); } catch { /* ignore */ } };
process.once('beforeExit', flushModStore);
process.once('SIGINT', () => { flushModStore(); process.exit(0); });
process.once('SIGTERM', () => { flushModStore(); process.exit(0); });

client.cogs = {
    // socials: socialsCog,
    logger: loggerCog,
    modmail: modmailCog,
    modmailDebug: modmailDebugCog,
    // Deprecated: AIChatCog
    // aiChat: aiChatCog,
    // Deprecated: ComfyUICog
    // comfy: comfyCog,
    starboard: starboardCog,
    leveling: levelingCog,
    embedBuilder: embedBuilderCog,
    music: musicCog,
    musicDashboard: musicDashboardCog,
    modStore,
    moderation: moderationCog,
    logStore,
    modDashboard: modDashboardCog,
    fah: fahCog
};

// Register modmail listeners immediately so DM relay and debug probes are not blocked by ready-time startup tasks.
modmailCog.start();
modmailDebugCog.start();

// ─── RAW GATEWAY DM INTERCEPTOR ─────────────────────────────────────────────
// Discord.js silently drops DM MESSAGE_CREATE events when the DM channel is
// not in the internal channel cache. This raw listener intercepts the event at
// the websocket level, force-fetches the channel into cache, fetches the full
// Message object, and re-emits it so modmail and all other listeners see it.
const { GatewayDispatchEvents } = require('discord.js');
client.ws.on(GatewayDispatchEvents.MessageCreate, async (rawData) => {
    try {
        // Only care about DM channels (no guild_id means DM)
        if (rawData.guild_id) return;
        const channelId = rawData.channel_id;
        const authorId = rawData.author?.id;
        if (!channelId || !authorId) return;
        if (authorId === client.user?.id) return;

        // If the channel is already cached, discord.js handles it normally
        const cachedChannel = client.channels.cache.get(channelId);
        if (cachedChannel) return;

        // Channel is NOT cached - discord.js would silently drop this DM.
        // Force-fetch the channel into cache, then fetch the message and re-emit.
        console.log(`[DM-INTERCEPT] Uncached DM channel ${channelId} from user ${authorId} - force-fetching and re-emitting.`);

        const dmChannel = await client.channels.fetch(channelId).catch(fetchError => {
            console.error(`[DM-INTERCEPT] Failed to fetch DM channel ${channelId}: ${fetchError.message}`);
            return null;
        });
        if (!dmChannel) return;

        const message = await dmChannel.messages.fetch(rawData.id).catch(fetchError => {
            console.error(`[DM-INTERCEPT] Failed to fetch message ${rawData.id} in channel ${channelId}: ${fetchError.message}`);
            return null;
        });
        if (!message) return;

        // Re-emit so modmail and all other listeners process it
        client.emit(Events.MessageCreate, message);
        console.log(`[DM-INTERCEPT] Successfully re-emitted DM from ${message.author?.tag || authorId} (channel ${channelId}).`);
    } catch (error) {
        console.error(`[DM-INTERCEPT] Raw gateway handler error: ${error.message}`);
    }
});

// --- Automatic banner rotation ---
// Day banners run 1:00 PM -> 2:00 AM; night banners run 2:00 AM -> 1:00 PM (server local time).
const BANNER_DAY_FILE = './media/banner_day.png';
const BANNER_NIGHT_FILE = './media/banner_night.png';
const SERVER_BANNER_DAY_FILE = './media/server_banner_day.png';
const SERVER_BANNER_NIGHT_FILE = './media/server_banner_night.png';
const SERVER_BANNER_GUILD_ID = config.operator_guild_id || null;
const BANNER_DAY_START_HOUR = 13; // 1:00 PM
const BANNER_NIGHT_START_HOUR = 2; // 2:00 AM

let currentBannerKey = null;
let currentServerBannerKey = null;
let bannerRotationTimer = null;

function getScheduledBanner(date = new Date()) {
    const hour = date.getHours();
    const isDay = hour >= BANNER_DAY_START_HOUR || hour < BANNER_NIGHT_START_HOUR;
    return isDay
        ? { key: 'day', file: BANNER_DAY_FILE, serverFile: SERVER_BANNER_DAY_FILE }
        : { key: 'night', file: BANNER_NIGHT_FILE, serverFile: SERVER_BANNER_NIGHT_FILE };
}

function msUntilNextBannerChange(date = new Date()) {
    const next = new Date(date);
    next.setMinutes(0, 0, 0);
    const hour = date.getHours();
    if (hour >= BANNER_DAY_START_HOUR) {
        // After 1 PM -> next change is 2 AM tomorrow.
        next.setDate(next.getDate() + 1);
        next.setHours(BANNER_NIGHT_START_HOUR);
    } else if (hour < BANNER_NIGHT_START_HOUR) {
        // Past midnight but before 2 AM -> next change is 2 AM today.
        next.setHours(BANNER_NIGHT_START_HOUR);
    } else {
        // Between 2 AM and 1 PM -> next change is 1 PM today.
        next.setHours(BANNER_DAY_START_HOUR);
    }
    return Math.max(1000, next.getTime() - date.getTime());
}

async function applyScheduledBanner(readyClient) {
    const { key, file, serverFile } = getScheduledBanner();
    if (key !== currentBannerKey && fs.existsSync(file)) {
        try {
            await readyClient.user.setBanner(file);
            currentBannerKey = key;
            console.log(`[BANNER] Applied ${key} bot banner (${file}).`);
        } catch (error) {
            console.error(`[BANNER] Failed to apply ${key} bot banner: ${error.message}`);
        }
    }
    if (key !== currentServerBannerKey && SERVER_BANNER_GUILD_ID && fs.existsSync(serverFile)) {
        try {
            const guild = await readyClient.guilds.fetch(SERVER_BANNER_GUILD_ID);
            await guild.setBanner(serverFile);
            currentServerBannerKey = key;
            console.log(`[BANNER] Applied ${key} server banner (${serverFile}).`);
        } catch (error) {
            console.error(`[BANNER] Failed to apply ${key} server banner: ${error.message}`);
        }
    }
}

function scheduleBannerRotation(readyClient) {
    if (bannerRotationTimer) clearTimeout(bannerRotationTimer);
    const delay = msUntilNextBannerChange();
    bannerRotationTimer = setTimeout(() => {
        void applyScheduledBanner(readyClient).finally(() => scheduleBannerRotation(readyClient));
    }, delay);
    console.log(`[BANNER] Next banner change scheduled in ~${Math.round(delay / 60000)} min.`);
}

client.once(Events.ClientReady, async readyClient => {
    console.log(`[SYSTEM] Successfully connected as ${readyClient.user.tag}`);
    try {
        await syncApplicationInfoCommands(readyClient);
    } catch (error) {
        console.error(`[ERROR] Failed to sync slash commands: ${error.message}`);
    }

    try {
        const liveConfig = getConfig();
        readyClient.user.setPresence({
            activities: [{
                name: 'Custom Status OwO',
                state: liveConfig.status_message,
                type: ActivityType.Custom
            }],
            status: liveConfig.status
        });
        console.log(`[SYSTEM] Presence updated: [${liveConfig.status}] custom status "${liveConfig.status_message}"`);
    } catch (error) {
        console.error(`[ERROR] Failed to set presence: ${error.message}`);
    }

    await applyScheduledBanner(readyClient);
    scheduleBannerRotation(readyClient);

    // socialsCog.start();
    starboardCog.start();
    loggerCog.start();
    moderationCog.start(); // enforcement engine + GuildAuditLogEntryCreate ingestion
    // Deprecated: AIChatCog
    // aiChatCog.start();
    // Deprecated: ComfyUICog
    // comfyCog.start();

    let migratedStatusRouting = { migratedGuildCount: 0, createdChannelCount: 0 };
    let syncBackfillCount = 0;
    try {
        migratedStatusRouting = await loggerCog.migrateLegacyProfileAndStatusRouting();
        syncBackfillCount = await loggerCog.ensureSpecificSyncEventChannels([
            'avatar-change',
            'banner-change',
            'status-online',
            'status-idle',
            'status-dnd',
            'status-offline',
            'stats-title-update'
        ]);
    } catch (error) {
        console.error(`[LOGGER] Startup migration/backfill failed: ${error.message}`);
    }
    console.log('[SYSTEM] Social monitors are now polling for new activity.');
    console.log('[SYSTEM] Logger Event Subsystem is active.');
    console.log(`[SYSTEM] Logger migrated ${migratedStatusRouting.migratedGuildCount} guild config(s) and created ${migratedStatusRouting.createdChannelCount} local status channel(s).`);
    console.log(`[SYSTEM] Sync logger channel backfill created ${syncBackfillCount} channel(s) for profile/status events.`);
    console.log('[SYSTEM] Modmail relay is active.');
    console.log('[SYSTEM] Starboard subsystem is active.');
    // Deprecated: AIChatCog
    // console.log('[SYSTEM] AI chat subsystem is active.');
    // Deprecated: ComfyUICog
    // console.log('[SYSTEM] ComfyUI image subsystem is active.');

    void modmailCog.primeKnownDmChannels().catch(error => {
        console.error(`[MODMAIL] Startup DM priming failed: ${error.message}`);
    });

    await initializeOperationalFeatures(readyClient);
});

// Mount the new support redirect event

// 2. The Command Handler with ACL
// Handle Modals / Auth'd Interactions
client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'info') {
            return handleInfoSlashCommand(interaction);
        }

        if (interaction.commandName === 'modmail') {
            return handleModmailSlashCommand(interaction);
        }

        return interaction.reply({
            content: 'That slash command is not available in this build.',
            ephemeral: true
        });
    }

    if (await musicCog.handleComponent(interaction).catch(error => {
        console.error(`[MUSIC] Component interaction failed: ${error.message}`);
        return true;
    })) {
        return;
    }

    if (await embedBuilderCog.handleInteraction(interaction)) {
        return;
    }

    // Quick Reply Modal Opener
    if (interaction.isButton() && interaction.customId.startsWith('admin_reply_')) {
        const parts = interaction.customId.split('_');
        const channelId = parts[2];
        const msgId = parts[3];
        const liveConfig = getConfig();

        const isMaster = interaction.user.id === liveConfig.master_id;
        const isOperator = interaction.user.id === liveConfig.operator_id;
        const isDev = isMaster || allowedDevs.has(interaction.user.id);
        if (!isMaster && !isOperator && !isDev) return interaction.reply({ content: "Access Denied.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`reply_modal_${channelId}_${msgId}`).setTitle('Act as kitbot');
        const replyInput = new TextInputBuilder().setCustomId('reply_content').setLabel('Your Response').setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(replyInput));
        await interaction.showModal(modal);
    }
    
    // Quick Reply Modal Submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('reply_modal_')) {
        const parts = interaction.customId.split('_');
        const channelId = parts[2];
        const msgId = parts[3];
        const content = interaction.fields.getTextInputValue('reply_content');
        const liveConfig = getConfig();

        const isMaster = interaction.user.id === liveConfig.master_id;
        const isOperator = interaction.user.id === liveConfig.operator_id;
        const isDev = isMaster || allowedDevs.has(interaction.user.id);
        if (!isMaster && !isOperator && !isDev) return interaction.reply({ content: "Access Denied.", ephemeral: true });

        try {
            const channel = client.channels.cache.get(channelId);
            if (!channel) return interaction.reply({ content: "Target channel no longer exists.", ephemeral: true });
            
            const targetMsg = await channel.messages.fetch(msgId);
            if (!targetMsg) return interaction.reply({ content: "Target message no longer exists.", ephemeral: true });

            await targetMsg.reply(content);
            await interaction.reply({ content: `✅ Successfully replied to the message in ${channel}!`, ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: `Failed to send reply: ${e.message}`, ephemeral: true });
        }
    }
});

// 2. The Command Handler with ACL
client.on(Events.GuildMemberAdd, async member => {
    if (member.user.bot) return;

    void modmailCog.getUserDmChannel(member.user, 'guild_member_add', { traceSuccess: true }).catch(error => {
        console.error(`[MODMAIL] Failed to prime DM channel for ${member.user.tag}: ${error.message}`);
    });

    const guildState = getGuildFeatureState(member.guild.id);
    if (guildState.welcomsgEnabled && guildState.welcomsgText) {
        try {
            await member.send(guildState.welcomsgText);
        } catch (error) {
            console.error(`[WELCOME] Failed to DM new member ${member.user.tag}:`, error.message);
        }
    }
});

client.on(Events.MessageCreate, async message => {
    // Jukebox prefix commands (k. / abc.music / _*music) get first pick;
    // anything it does not consume falls through to the main handler.
    const musicHandled = await musicCog.handleMessage(message).catch(error => {
        console.error(`[MUSIC] Message command failed: ${error.message}`);
        return true;
    });
    if (musicHandled) return;

    const fahHandled = await fahCog.handleMessage(message).catch(error => {
        console.error(`[FAH] Message command failed: ${error.message}`);
        return true;
    });
    if (fahHandled) return;

    // Dynamically require so the file can be hot-reloaded
    const handleMessageCreate = require('./cogs/message_create');
    const liveConfig = getConfig();
    await handleMessageCreate(message, {
        client, config: liveConfig, allowedDevs, saveDevs, getGuildFeatureState, saveFeatureState,
        sweepAutodeleteChannel, scheduleAutodelete, scheduleAutoMessageRefresh,
        clearAutoMessage, 
        // Deprecated: AIChatCog
        // aiChatCog: client.cogs.aiChat, 
        // Deprecated: ComfyUICog
        // comfyCog: client.cogs.comfy, 
        loggerCog: client.cogs.logger, 
        modmailCog: client.cogs.modmail, 
       // socialsCog: client.cogs.socials, 
        resolveChannel,
        getUsageText, buildHelpEmbed, COMMAND_USAGE, normalizeHelpTopic, getAutodeleteImmuneUserIds,
        resolveImmunityTarget, ensureAutoThread, OWNER_CHANNEL_OVERWRITE,
        BOT_INTERACTION_SYNC_CHANNEL_ID, BOT_INTERACTION_SYNC_GUILD_ID, ensureOwnerChannelAccess,
        PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType,
        levelingCog: client.cogs.leveling,
        embedBuilderCog: client.cogs.embedBuilder
    });
});

// The jukebox library scan and the web dashboard start immediately - the web
// UI must stay reachable even while Discord login is pending or failing.
// Voice features come online once the client is ready.
void musicCog.start()
    .catch(error => console.error(`[MUSIC] Library startup failed: ${error.message}`))
    .finally(() => musicDashboardCog.start());

// PocketBase (login + staff access control) - the bot owns the process. Launch
// it, then bring the moderation dashboard up once PB answers. The dashboard
// no-ops with a warning if data/staff-access.json is missing.
// PocketBase is optional: skip it entirely unless its superuser is configured.
if (process.env.PB_ADMIN_EMAIL) {
    startPocketBase(process.env.PB_URL || 'http://127.0.0.1:8090');
    pbClient.waitReady()
        .then(ok => { if (!ok) console.error('[PB] did not become ready in time - staff login will fail until it does.'); })
        .finally(() => modDashboardCog.start());
} else {
    modDashboardCog.start();
}

client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error(`[SYSTEM] Discord login failed: ${error.message}. The web dashboard stays up; fix the token and restart to bring the bot online.`);
});
