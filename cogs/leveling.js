const fs = require('fs');
const path = require('path');
const https = require('https');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');

const execFileAsync = promisify(execFile);

const DATA_FILE = path.join(__dirname, '..', 'data', 'leveling_state.json');
const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp', 'leveling');
const CARD_BACKGROUND_FILE = path.join(__dirname, '..', 'media', 'leveling_card.png');
const LEVELUP_GRAPHIC_FILE = path.join(__dirname, '..', 'media', 'levelup.png');
const { renderCard } = require('./render-leveling-card.js');

const USER_ID_PATTERN = /^\d+$/;
const DEFAULT_XP_MULTIPLIER = 1;
const MIN_XP_PER_MESSAGE = 10;
const MAX_XP_PER_MESSAGE = 20;
const XP_COOLDOWN_MS = 2 * 60 * 1000;
const REP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LEVEL_THRESHOLDS = [0, 5000, 20000, 50000, 80000, 110000, 150000, 190000, 240000, 290000, 360000];
const LEVEL_TAIL_INCREMENT = 80000;

const DEFAULT_GUILD_STATE = {
    enabled: false,
    xpMultiplier: DEFAULT_XP_MULTIPLIER,
    commandChannelId: null,
    levelupMode: 'global',
    levelupChannelId: null,
    levelupAllowedChannelIds: [],
    levelupBlockedChannelIds: [],
    users: {},
    repCooldowns: {}
};

const DEFAULT_USER_STATE = {
    score: 0,
    reputation: 0,
    lastXpAt: 0
};

function normalizeChannelId(rawValue) {
    const cleaned = String(rawValue || '').replace(/[<#>]/g, '').trim();
    return USER_ID_PATTERN.test(cleaned) ? cleaned : null;
}

function normalizeChannelIdList(rawValue) {
    if (!Array.isArray(rawValue)) return [];

    return [...new Set(
        rawValue
            .map(normalizeChannelId)
            .filter(Boolean)
    )];
}

function normalizeUserState(rawState) {
    return {
        score: Number.isFinite(Number(rawState?.score)) ? Math.max(0, Math.round(Number(rawState.score))) : 0,
        reputation: Number.isInteger(rawState?.reputation) ? Math.max(0, rawState.reputation) : 0,
        lastXpAt: Number.isFinite(Number(rawState?.lastXpAt)) ? Math.max(0, Number(rawState.lastXpAt)) : 0
    };
}

function normalizeRepCooldowns(rawCooldowns) {
    const normalized = {};
    if (!rawCooldowns || typeof rawCooldowns !== 'object') return normalized;

    for (const [userId, timestamp] of Object.entries(rawCooldowns)) {
        if (!USER_ID_PATTERN.test(userId)) continue;
        const normalizedTimestamp = Number(timestamp);
        if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) continue;
        normalized[userId] = normalizedTimestamp;
    }

    return normalized;
}

function normalizeGuildState(rawState) {
    const users = {};
    if (rawState?.users && typeof rawState.users === 'object') {
        for (const [userId, userState] of Object.entries(rawState.users)) {
            if (!USER_ID_PATTERN.test(userId)) continue;
            users[userId] = normalizeUserState(userState);
        }
    }

    return {
        enabled: Boolean(rawState?.enabled),
        xpMultiplier: Number.isFinite(Number(rawState?.xpMultiplier)) ? clampMultiplier(Number(rawState.xpMultiplier)) : DEFAULT_XP_MULTIPLIER,
        commandChannelId: normalizeChannelId(rawState?.commandChannelId),
        levelupMode: rawState?.levelupMode === 'channel' ? 'channel' : 'global',
        levelupChannelId: normalizeChannelId(rawState?.levelupChannelId),
        levelupAllowedChannelIds: normalizeChannelIdList(rawState?.levelupAllowedChannelIds),
        levelupBlockedChannelIds: normalizeChannelIdList(rawState?.levelupBlockedChannelIds),
        users,
        repCooldowns: normalizeRepCooldowns(rawState?.repCooldowns)
    };
}

function clampMultiplier(value) {
    return Math.min(10, Math.max(0.1, Number(value)));
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function randomIntInclusive(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatNumber(value) {
    return Math.round(Number(value) || 0).toLocaleString('en-US');
}

function formatMultiplier(value) {
    return `${Number(value || DEFAULT_XP_MULTIPLIER).toFixed(2)}x`;
}

function formatDuration(ms) {
    const safeMs = Math.max(0, Math.round(ms));
    const totalMinutes = Math.ceil(safeMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
}

function getLevelInfo(score) {
    const normalizedScore = Math.max(0, Math.round(Number(score) || 0));
    const lastThresholdIndex = LEVEL_THRESHOLDS.length - 1;
    const lastThreshold = LEVEL_THRESHOLDS[lastThresholdIndex];

    if (normalizedScore < lastThreshold) {
        let level = 0;
        for (let index = 0; index < LEVEL_THRESHOLDS.length; index += 1) {
            if (normalizedScore >= LEVEL_THRESHOLDS[index]) {
                level = index;
            } else {
                break;
            }
        }

        const currentThreshold = LEVEL_THRESHOLDS[level];
        const nextThreshold = LEVEL_THRESHOLDS[Math.min(level + 1, lastThresholdIndex)];
        const neededForNext = Math.max(1, nextThreshold - currentThreshold);

        return {
            level,
            currentThreshold,
            nextThreshold,
            progress: normalizedScore - currentThreshold,
            neededForNext,
            progressRatio: Math.max(0, Math.min(1, (normalizedScore - currentThreshold) / neededForNext))
        };
    }

    const overflow = normalizedScore - lastThreshold;
    const extraLevels = Math.floor(overflow / LEVEL_TAIL_INCREMENT);
    const level = lastThresholdIndex + extraLevels;
    const currentThreshold = lastThreshold + (extraLevels * LEVEL_TAIL_INCREMENT);
    const nextThreshold = currentThreshold + LEVEL_TAIL_INCREMENT;

    return {
        level,
        currentThreshold,
        nextThreshold,
        progress: normalizedScore - currentThreshold,
        neededForNext: LEVEL_TAIL_INCREMENT,
        progressRatio: Math.max(0, Math.min(1, (normalizedScore - currentThreshold) / LEVEL_TAIL_INCREMENT))
    };
}

function downloadFile(url, destinationPath, redirectDepth = 0) {
    return new Promise((resolve, reject) => {
        if (!url) {
            reject(new Error('No URL provided.'));
            return;
        }

        if (redirectDepth > 5) {
            reject(new Error('Too many redirects while downloading avatar.'));
            return;
        }

        const request = https.get(url, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                resolve(downloadFile(response.headers.location, destinationPath, redirectDepth + 1));
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Avatar download failed with status ${response.statusCode}.`));
                return;
            }

            const fileStream = fs.createWriteStream(destinationPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(() => resolve(destinationPath));
            });

            fileStream.on('error', error => {
                fs.unlink(destinationPath, () => reject(error));
            });
        });

        request.on('error', reject);
    });
}

class LevelingCog {
    constructor(client, options = {}) {
        this.client = client;
        this.dataFilePath = options.dataFilePath || DATA_FILE;
        this.cardBackgroundPath = options.cardBackgroundPath || CARD_BACKGROUND_FILE;
        this.levelupGraphicPath = options.levelupGraphicPath || LEVELUP_GRAPHIC_FILE;
        ensureDirectory(path.dirname(this.dataFilePath));
        ensureDirectory(TEMP_DIR);
        this.state = this.loadState();
    }

    loadState() {
        if (!fs.existsSync(this.dataFilePath)) {
            const initialState = { version: 1, guilds: {} };
            fs.writeFileSync(this.dataFilePath, JSON.stringify(initialState, null, 2));
            return initialState;
        }

        try {
            const rawState = JSON.parse(fs.readFileSync(this.dataFilePath, 'utf8'));
            const guilds = {};

            if (rawState?.guilds && typeof rawState.guilds === 'object') {
                for (const [guildId, guildState] of Object.entries(rawState.guilds)) {
                    if (!USER_ID_PATTERN.test(guildId)) continue;
                    guilds[guildId] = normalizeGuildState(guildState);
                }
            }

            return {
                version: 1,
                guilds
            };
        } catch (error) {
            console.error('[LEVELING] Failed to load state:', error.message);
            return { version: 1, guilds: {} };
        }
    }

    saveState() {
        fs.writeFileSync(this.dataFilePath, JSON.stringify(this.state, null, 2));
    }

    getGuildState(guildId) {
        if (!this.state.guilds[guildId]) {
            this.state.guilds[guildId] = normalizeGuildState(DEFAULT_GUILD_STATE);
            this.saveState();
        }

        return this.state.guilds[guildId];
    }

    getUserState(guildState, userId) {
        if (!guildState.users[userId]) {
            guildState.users[userId] = normalizeUserState(DEFAULT_USER_STATE);
        }

        return guildState.users[userId];
    }

    /** Read-only activity snapshot for a user (no mutation), or null if untracked. */
    getUserActivity(guildId, userId) {
        const u = this.state.guilds?.[guildId]?.users?.[userId];
        if (!u) return null;
        return { xp: u.score || 0, reputation: u.reputation || 0, lastActiveAt: u.lastXpAt || null };
    }

    isPublicCommandRestricted(guildState, channelId) {
        return Boolean(guildState.commandChannelId && guildState.commandChannelId !== channelId);
    }

    getPublicCommandRestrictionMessage(guildState) {
        return guildState.commandChannelId
            ? `Leveling commands are currently restricted to <#${guildState.commandChannelId}>.`
            : null;
    }

    getLeaderboardEntries(guildState) {
        return Object.entries(guildState.users)
            .map(([userId, userState]) => ({
                userId,
                score: Math.max(0, Math.round(Number(userState?.score) || 0))
            }))
            .sort((left, right) => {
                if (right.score !== left.score) return right.score - left.score;
                return left.userId.localeCompare(right.userId);
            });
    }

    getRankForUser(guildState, userId) {
        const leaderboard = this.getLeaderboardEntries(guildState);
        const index = leaderboard.findIndex(entry => entry.userId === userId);
        return {
            rank: index === -1 ? leaderboard.length + 1 : index + 1,
            totalTrackedUsers: leaderboard.length
        };
    }

    async handleMessage(message) {
        if (!message.guild || message.author?.bot || message.webhookId) return;

        const guildState = this.getGuildState(message.guild.id);
        if (!guildState.enabled) return;

        const userState = this.getUserState(guildState, message.author.id);
        const now = Date.now();
        if ((now - userState.lastXpAt) < XP_COOLDOWN_MS) return;

        const previousLevel = getLevelInfo(userState.score).level;
        const baseXp = randomIntInclusive(MIN_XP_PER_MESSAGE, MAX_XP_PER_MESSAGE);
        const gainedXp = Math.max(1, Math.round(baseXp * guildState.xpMultiplier));

        userState.score += gainedXp;
        userState.lastXpAt = now;
        this.saveState();

        const updatedLevelInfo = getLevelInfo(userState.score);
        if (updatedLevelInfo.level > previousLevel) {
            await this.sendLevelUpMessage(message, guildState, userState, updatedLevelInfo.level).catch(error => {
                console.error('[LEVELING] Failed to send level-up message:', error.message);
            });
        }
    }

    async handleLevelCommand(message, args, canManageFeatures) {
        if (!message.guild) {
            return message.reply('This command can only be used inside a server.');
        }

        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const guildState = this.getGuildState(message.guild.id);
        const action = (args[0] || 'status').toLowerCase();

        if (action === 'toggle') {
            guildState.enabled = !guildState.enabled;
            this.saveState();

            return message.reply(
                guildState.enabled
                    ? `✅ Leveling is now enabled. Users will earn **${MIN_XP_PER_MESSAGE}-${MAX_XP_PER_MESSAGE}** score every **2 minutes** with the current ${formatMultiplier(guildState.xpMultiplier)} multiplier.`
                    : '😔 Leveling is now disabled.'
            );
        }

        const commandChannelText = guildState.commandChannelId ? `<#${guildState.commandChannelId}>` : '`any channel`';
        const levelupDestination = guildState.levelupMode === 'channel' && guildState.levelupChannelId
            ? `<#${guildState.levelupChannelId}>`
            : '`same channel as the level-up`';

        return message.reply([
            `Leveling is currently **${guildState.enabled ? 'ENABLED' : 'DISABLED'}**.`,
            `XP multiplier: **${formatMultiplier(guildState.xpMultiplier)}**`,
            `Public leveling commands: ${commandChannelText}`,
            `Level-up delivery: ${levelupDestination}`
        ].join('\n'));
    }

    async handleXpCommand(message, args, canManageFeatures) {
        if (!message.guild) {
            return message.reply('This command can only be used inside a server.');
        }

        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const guildState = this.getGuildState(message.guild.id);
        const rawValue = args[0];

        if (!rawValue) {
            return message.reply(`The current XP multiplier is **${formatMultiplier(guildState.xpMultiplier)}**.`);
        }

        const parsedMultiplier = Number(rawValue);
        if (!Number.isFinite(parsedMultiplier) || parsedMultiplier < 0.1 || parsedMultiplier > 10) {
            return message.reply('Please provide a multiplier between **0.1** and **10**.\nExample: `abc.xp 1.33`');
        }

        guildState.xpMultiplier = clampMultiplier(parsedMultiplier);
        this.saveState();

        return message.reply(
            `✅ XP multiplier set to **${formatMultiplier(guildState.xpMultiplier)}**.`
        );
    }

    async handleLevelingCommand(message, args, canManageFeatures) {
        if (!message.guild) {
            return message.reply('This command can only be used inside a server.');
        }

        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const guildState = this.getGuildState(message.guild.id);
        const action = (args[0] || '').toLowerCase();

        if (!action) {
            return message.reply(this.buildLevelingStatusMessage(guildState));
        }

        if (action === 'lvlup') {
            return this.handleLevelupConfigCommand(message, args.slice(1), guildState);
        }

        if (['off', 'disable', 'clear', 'global', 'any'].includes(action)) {
            guildState.commandChannelId = null;
            this.saveState();
            return message.reply('✅ Public leveling commands are no longer restricted to one channel.');
        }

        const targetChannelId = normalizeChannelId(action);
        const targetChannel =
            targetChannelId
                ? (message.guild.channels.cache.get(targetChannelId) || await this.client.channels.fetch(targetChannelId).catch(() => null))
                : message.mentions.channels.first();

        if (!targetChannel || !targetChannel.isTextBased() || targetChannel.guildId !== message.guild.id) {
            return message.reply('Please provide a valid text channel from this server, or use `abc.leveling off`.');
        }

        guildState.commandChannelId = targetChannel.id;
        this.saveState();

        return message.reply(
            `✅ Public leveling commands are now restricted to ${targetChannel}.`
        );
    }

    buildLevelingStatusMessage(guildState) {
        const commandChannelText = guildState.commandChannelId ? `<#${guildState.commandChannelId}>` : '`any channel`';
        const levelupModeText = guildState.levelupMode === 'channel' && guildState.levelupChannelId
            ? `<#${guildState.levelupChannelId}>`
            : '`same channel as the level-up`';
        const allowText = guildState.levelupAllowedChannelIds.length
            ? guildState.levelupAllowedChannelIds.map(channelId => `<#${channelId}>`).join(', ')
            : '`none`';
        const blockText = guildState.levelupBlockedChannelIds.length
            ? guildState.levelupBlockedChannelIds.map(channelId => `<#${channelId}>`).join(', ')
            : '`none`';

        return [
            `Leveling is **${guildState.enabled ? 'ENABLED' : 'DISABLED'}**.`,
            `Public leveling commands: ${commandChannelText}`,
            `Level-up delivery: ${levelupModeText}`,
            `Level-up whitelist: ${allowText}`,
            `Level-up blacklist: ${blockText}`
        ].join('\n');
    }

    async handleLevelupConfigCommand(message, args, guildState) {
        if (!args.length) {
            return message.reply(this.buildLevelingStatusMessage(guildState));
        }

        const trailingAction = String(args[args.length - 1] || '').toLowerCase();
        if (trailingAction === 'allow' || trailingAction === 'block') {
            const rawTargets = args.slice(0, -1);
            if (!rawTargets.length || (rawTargets.length === 1 && rawTargets[0].toLowerCase() === 'clear')) {
                if (trailingAction === 'allow') guildState.levelupAllowedChannelIds = [];
                if (trailingAction === 'block') guildState.levelupBlockedChannelIds = [];
                this.saveState();
                return message.reply(
                    `✅ Cleared the level-up ${trailingAction === 'allow' ? 'whitelist' : 'blacklist'}.`
                );
            }

            const channelIds = this.extractChannelIds(rawTargets, message.mentions.channels.map(channel => channel.id));
            if (!channelIds.length) {
                return message.reply('Please provide one or more valid text channels to update.');
            }

            const validChannelIds = [];
            for (const channelId of channelIds) {
                const channel = message.guild.channels.cache.get(channelId) || await this.client.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.isTextBased() || channel.guildId !== message.guild.id) continue;
                validChannelIds.push(channel.id);
            }

            if (!validChannelIds.length) {
                return message.reply('I could not resolve any valid text channels from that list.');
            }

            if (trailingAction === 'allow') {
                guildState.levelupAllowedChannelIds = [...new Set([...guildState.levelupAllowedChannelIds, ...validChannelIds])];
                guildState.levelupBlockedChannelIds = guildState.levelupBlockedChannelIds.filter(channelId => !validChannelIds.includes(channelId));
            } else {
                guildState.levelupBlockedChannelIds = [...new Set([...guildState.levelupBlockedChannelIds, ...validChannelIds])];
                guildState.levelupAllowedChannelIds = guildState.levelupAllowedChannelIds.filter(channelId => !validChannelIds.includes(channelId));
            }

            this.saveState();
            return message.reply(
                `✅ Updated the level-up ${trailingAction === 'allow' ? 'whitelist' : 'blacklist'} for ${validChannelIds.map(channelId => `<#${channelId}>`).join(', ')}.`
            );
        }

        const modeArg = String(args[0] || '').toLowerCase();
        if (modeArg === 'global') {
            guildState.levelupMode = 'global';
            guildState.levelupChannelId = null;
            this.saveState();
            return message.reply('✅ Level-up embeds will now post in the same channel where the user leveled up.');
        }

        const targetChannelId = normalizeChannelId(args[0]);
        const targetChannel =
            targetChannelId
                ? (message.guild.channels.cache.get(targetChannelId) || await this.client.channels.fetch(targetChannelId).catch(() => null))
                : message.mentions.channels.first();

        if (!targetChannel || !targetChannel.isTextBased() || targetChannel.guildId !== message.guild.id) {
            return message.reply('Please provide `global` or a valid text channel from this server.');
        }

        guildState.levelupMode = 'channel';
        guildState.levelupChannelId = targetChannel.id;
        this.saveState();

        return message.reply(
            `✅ Level-up embeds will now post in ${targetChannel}.`
        );
    }

    extractChannelIds(rawTargets, mentionedChannelIds = []) {
        const channelIds = [];
        for (const rawTarget of rawTargets) {
            const normalized = normalizeChannelId(rawTarget);
            if (normalized) channelIds.push(normalized);
        }

        return [...new Set([...mentionedChannelIds, ...channelIds])];
    }

    async handleRankCommand(message, args) {
        if (!message.guild) {
            return message.reply('`k!rank` can only be used inside a server.');
        }

        const guildState = this.getGuildState(message.guild.id);
        if (!guildState.enabled) {
            return message.reply('Leveling is disabled in this server right now.');
        }

        if (this.isPublicCommandRestricted(guildState, message.channelId)) {
            return message.reply(this.getPublicCommandRestrictionMessage(guildState));
        }

        const targetMember = await this.resolveTargetMember(message, args).catch(() => null);
        if (!targetMember) {
            return message.reply('Please mention a valid server member, or use `k!rank` by itself.');
        }

        const userState = this.getUserState(guildState, targetMember.id);
        this.saveState();

        const rankMeta = this.getRankForUser(guildState, targetMember.id);
        const attachment = await this.buildRankCardAttachment(message.guild, targetMember, userState, rankMeta.rank);

        return message.reply({ files: [attachment] });
    }

    async handleRepCommand(message) {
        if (!message.guild) {
            return message.reply('`k!rep` can only be used inside a server.');
        }

        const guildState = this.getGuildState(message.guild.id);
        if (!guildState.enabled) {
            return message.reply('Leveling is disabled in this server right now.');
        }

        if (this.isPublicCommandRestricted(guildState, message.channelId)) {
            return message.reply(this.getPublicCommandRestrictionMessage(guildState));
        }

        const targetMember = message.mentions.members.first();
        if (!targetMember) {
            return message.reply('Usage: `k!rep @user`');
        }

        if (targetMember.id === message.author.id) {
            return message.reply('You cannot give reputation to yourself.');
        }

        if (targetMember.user.bot) {
            return message.reply('Bots cannot receive reputation.');
        }

        const now = Date.now();
        const lastRepAt = Number(guildState.repCooldowns[message.author.id] || 0);
        const remainingCooldown = REP_COOLDOWN_MS - (now - lastRepAt);
        if (remainingCooldown > 0) {
            return message.reply(
                `You already gave out reputation recently. You can give rep again in **${formatDuration(remainingCooldown)}**.`
            );
        }

        const targetUserState = this.getUserState(guildState, targetMember.id);
        targetUserState.reputation += 1;
        guildState.repCooldowns[message.author.id] = now;
        this.saveState();

        return message.reply(
            `✅ You gave **+1 reputation** to ${targetMember}. They now have **${formatNumber(targetUserState.reputation)}** rep.`
        );
    }

    async resolveTargetMember(message, args) {
        const mentionedMember = message.mentions.members.first();
        if (mentionedMember) return mentionedMember;

        const rawTarget = String(args[0] || '').trim();
        if (!rawTarget) {
            return message.member;
        }

        const targetId = rawTarget.replace(/[<@!>]/g, '');
        if (!USER_ID_PATTERN.test(targetId)) return null;

        return message.guild.members.fetch(targetId).catch(() => null);
    }

    async buildRankCardAttachment(guild, member, userState, rank) {
        const tempStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const outputPath = path.join(TEMP_DIR, `rank-card-${tempStamp}.png`);
        const avatarPath = path.join(TEMP_DIR, `avatar-${tempStamp}.png`);
        const cleanupTargets = [outputPath, avatarPath];
        const score = Math.max(0, Math.round(Number(userState?.score) || 0));
        const levelInfo = getLevelInfo(score);
        const nextLabel = `Level ${levelInfo.level + 1}`;
        const avatarUrl = member.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });

        try {
            await downloadFile(avatarUrl, avatarPath);
        } catch (error) {
            cleanupTargets.pop();
        }

        try {
            await renderCard({
                backgroundPath: this.cardBackgroundPath,
                outputPath: outputPath,
                avatarPath: fs.existsSync(avatarPath) ? avatarPath : '',
                displayName: member.displayName || member.user.username,
                serverName: guild.name,
                levelText: `Level ${levelInfo.level}`,
                repText: `Rep ${formatNumber(userState.reputation)}`,
                rankText: `Rank #${rank}`,
                scoreText: `${formatNumber(score)} / ${formatNumber(levelInfo.nextThreshold)} XP`,
                nextText: nextLabel,
                progressRatio: parseFloat(levelInfo.progressRatio.toFixed(4))
            });

            const cardBuffer = fs.readFileSync(outputPath);
            return new AttachmentBuilder(cardBuffer, {
                name: `rank-${member.id}.png`
            });
        } finally {
            for (const filePath of cleanupTargets) {
                if (fs.existsSync(filePath)) {
                    fs.unlink(filePath, () => {});
                }
            }
        }
    }

    isLevelupChannelAllowed(guildState, channelId) {
        if (!channelId) return false;
        if (guildState.levelupBlockedChannelIds.includes(channelId)) return false;
        if (guildState.levelupAllowedChannelIds.length > 0 && !guildState.levelupAllowedChannelIds.includes(channelId)) {
            return false;
        }

        return true;
    }

    async resolveLevelupTargetChannel(message, guildState) {
        const preferredChannelId = guildState.levelupMode === 'channel'
            ? guildState.levelupChannelId
            : message.channelId;

        if (!preferredChannelId || !this.isLevelupChannelAllowed(guildState, preferredChannelId)) {
            return null;
        }

        const channel = message.guild.channels.cache.get(preferredChannelId)
            || await this.client.channels.fetch(preferredChannelId).catch(() => null);

        if (!channel || !channel.isTextBased() || channel.guildId !== message.guild.id) {
            return null;
        }

        return channel;
    }

    async sendLevelUpMessage(message, guildState, userState, level) {
        const targetChannel = await this.resolveLevelupTargetChannel(message, guildState);
        if (!targetChannel) return;

        const score = Math.max(0, Math.round(Number(userState?.score) || 0));
        const hasGraphic = fs.existsSync(this.levelupGraphicPath);
        const embed = new EmbedBuilder()
            .setColor('#5EB5E8')
            .setAuthor({
                name: `${message.member?.displayName || message.author.username} leveled up!`,
                iconURL: message.author.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true })
            })
            .setDescription(`${message.author} reached **Level ${level}**.`)
            .addFields(
                { name: 'Server Score', value: formatNumber(score), inline: true },
                { name: 'Reputation', value: formatNumber(userState.reputation), inline: true }
            )
            .setTimestamp(new Date(message.createdTimestamp));
        if (hasGraphic) embed.setImage('attachment://levelup.png');

        await targetChannel.send({
            embeds: [embed],
            files: hasGraphic ? [new AttachmentBuilder(fs.readFileSync(this.levelupGraphicPath), { name: 'levelup.png' })] : []
        });
    }
}

module.exports = {
    LevelingCog,
    getLevelInfo
};
