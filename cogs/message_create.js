const fs = require('fs');
const path = require('path');

const GAME_CHANNEL_ID_PATTERN = /^\d+$/;
const GAME_SHORTCUT_COMMANDS = new Set(['games', '8ball', 'coinflip', 'flip', 'roll', 'rps', 'choose', 'pick', 'stats', 'lb', 'leaderboard']);
const GAME_STATS_COMMANDS = new Set(['stats', 'lb', 'leaderboard']);
const GAME_STATS_FILE = path.join(__dirname, '..', 'data', 'game_stats.json');
const GAME_CHOICES = ['rock', 'paper', 'scissors'];
const RPS_CHOICE_EMOJI = { rock: '🪨', paper: '📄', scissors: '✂️' };
const RPS_WIN_LINES = [
    'You win! >:0',
    'Curses, you got me!',
    'Defeated... I demand a rematch!',
    'You win this round, mortal.'
];
const RPS_LOSE_LINES = [
    'I win! >:3',
    'The bot strikes again! Better luck next time~',
    'I win! My training is paying off.',
    'Hehe, gotcha! I win!'
];
const RPS_TIE_LINES = [
    "It's a tie!",
    'A tie?! Great minds think alike.',
    "Tie! We're clearly both geniuses.",
    'A draw... the tension rises.'
];
const MAGIC_8_BALL_SHAKE_FLAVOR = [
    '*shakes the orb vigorously*',
    '*peers into the swirling mist*',
    '*gives the ball a dramatic tap*',
    '*consults the spirits within*',
    '*polishes the glass and squints*'
];
const COINFLIP_HEADS_FLAVOR = [
    'The coin spins, wobbles, and lands on **Heads**!',
    'It flips high into the air... **Heads**!',
    '**Heads**! I totally called it.',
    'A clean toss - **Heads** it is.'
];
const COINFLIP_TAILS_FLAVOR = [
    'The coin tumbles dramatically... **Tails**!',
    'It bounces off my paw... **Tails**!',
    '**Tails**! The coin has spoken.',
    'A wobbly landing - **Tails** it is.'
];
const COINFLIP_EDGE_FLAVOR = '...it landed on its **EDGE**?! (1% chance!) The universe refuses to decide. Flip again!';
const CHOOSE_FLAVOR = [
    'Easy choice:',
    'The council has decided:',
    'Hmm... definitely',
    'My circuits say',
    "Don't question it:",
    'Fate has spoken:',
    'After much deliberation (0.3ms):'
];

// Persistent per-user game stats, stored in data/game_stats.json per guild.
let gameStatsState = { guilds: {} };
try {
    const rawStats = JSON.parse(fs.readFileSync(GAME_STATS_FILE, 'utf8'));
    if (rawStats?.guilds && typeof rawStats.guilds === 'object') gameStatsState = { guilds: rawStats.guilds };
} catch {}

let gameStatsSaveTimer = null;
const saveGameStats = () => {
    if (gameStatsSaveTimer) return;
    gameStatsSaveTimer = setTimeout(() => {
        gameStatsSaveTimer = null;
        fs.writeFile(GAME_STATS_FILE, JSON.stringify(gameStatsState, null, 2), error => {
            if (error) console.error(`[GAMES] Failed to save game stats: ${error.message}`);
        });
    }, 2000);
};

const ensureGameStatsShape = stats => {
    if (typeof stats.plays !== 'number') stats.plays = 0;
    if (!stats.eightBall) stats.eightBall = { asked: 0 };
    if (!stats.coinflip) stats.coinflip = { flips: 0, heads: 0, tails: 0, edges: 0 };
    if (!stats.roll) stats.roll = { rolls: 0, crits: 0, fails: 0 };
    if (!stats.rps) stats.rps = { wins: 0, losses: 0, ties: 0, streak: 0, bestStreak: 0 };
    if (typeof stats.rps.bestStreak !== 'number') stats.rps.bestStreak = 0;
    if (!stats.choose) stats.choose = { picks: 0 };
    return stats;
};

const getUserGameStats = (guildId, userId, displayName) => {
    if (!gameStatsState.guilds[guildId]) gameStatsState.guilds[guildId] = {};
    const guildStats = gameStatsState.guilds[guildId];
    if (!guildStats[userId]) guildStats[userId] = { name: displayName || 'Unknown' };
    const stats = ensureGameStatsShape(guildStats[userId]);
    if (displayName) stats.name = displayName;
    return stats;
};

const readUserGameStats = (guildId, userId) => {
    const stats = gameStatsState.guilds?.[guildId]?.[userId];
    return stats ? ensureGameStatsShape(stats) : null;
};

const formatRpsStreak = score => {
    if (score.streak >= 3) return ` 🔥 **${score.streak}-win streak!**`;
    if (score.streak <= -3) return ` 💀 ${-score.streak} losses in a row...`;
    return '';
};

const resolveStatsChannelInput = async (guild, rawInput, client) => {
    const input = String(rawInput || '').trim();
    if (!input || !guild) return null;

    const linkMatch = input.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/i);
    const cleaned = linkMatch ? linkMatch[1] : input.replace(/[<#>]/g, '');
    if (GAME_CHANNEL_ID_PATTERN.test(cleaned)) {
        const byId = guild.channels.cache.get(cleaned) || await client.channels.fetch(cleaned).catch(() => null);
        return byId && byId.guildId === guild.id && byId.isTextBased() ? byId : null;
    }

    const nameNeedle = input.replace(/^#/, '').toLowerCase();
    return guild.channels.cache.find(channel => channel.isTextBased?.() && channel.name?.toLowerCase() === nameNeedle) || null;
};
const MAGIC_8_BALL_STANDARD_RESPONSES = [
    'Strong signs point to yes.',
    'It is decidedly so',
    'Chances are good.',
    'It is certain',
    'Without a doubt',
    'Yes, definitely',
    'You may rely on it',
    'Answer unclear. Try later.',
    'Not looking likely.',
    'As I see it, yes',
    'Most likely',
    'Outlook good',
    'Yes',
    'Signs point to yes',
    'Reply hazy, try again',
    'Ask again later',
    'Better not tell you now',
    'Cannot predict now',
    'Concentrate and ask again',
    "Don't count on it",
    'My reply is no',
    'My sources say no',
    'Outlook not so good',
    'Very doubtful',
    'My sources say no',
    'Absolutely not',
    'My developer thought adding this message would be funny! :3',
];
const MAGIC_8_BALL_GAME_CONTEXT_TERMS = [
    'in game',
    'in this game',
    'in-game',
    'ingame',
    'this match',
    'this round',
    'respawn',
    'checkpoint',
    'quest',
    'boss',
    'enemy',
    'npc',
    'raid'
];
const MAGIC_8_BALL_SUICIDE_TERMS = [
    'suicide',
    'suicidal',
    'kill myself',
    'end my life',
    'take my own life',
    'want to die',
    'i want to die',
    'i should die',
    'unalive myself',
    'off myself',
    'self harm',
    'self-harm',
    'hurt myself',
    'harm myself',
    'cut myself',
    'burn myself',
    'hang myself',
    'shoot myself',
    'off myself',
    'self harm',
    'self-harm',
    'hurt myself',
    'harm myself',
    'cut myself',
    'burn myself',
    'hang myself',
    'shoot myself',
    'overdose',
    'take myself out',
    'od myself',
    'I od'
];
const MAGIC_8_BALL_SUICIDE_SHORTCODE_PATTERNS = [
    /\bk[\W_]*[m4][\W_]*s\b/i,
    /\bk[\W_]*[y7][\W_]*s\b/i
];
const MAGIC_8_BALL_VIOLENCE_TERMS = [
    // Core violence & terrorism
    'terror', 'terrorist', 'terrorism', 'mass shooting', 'shooting spree',
    'bomb', 'pipe bomb', 'pipebomb', 'car bomb', 'carbomb', 'ied', 'explosive',
    'bioweapon', 'chemical weapon', 'dirty bomb', 'dirtybomb', 'molotov',
    'hostage', 'isis', 'isil', 'al qaeda', 'alqaeda', 'taliban',

    // Direct harm to people
    'kill my friend', 'kill him', 'kill her', 'kill them', 'kill everyone',
    'murder', 'murder my', 'shoot my friend', 'stab my friend', 'stab him',
    'stab her', 'beat him to death', 'beat her to death', 'torture',
    'torture my', 'strangle', 'drown my', 'burn alive',

    // Self-harm / suicide
    'kill myself', 'kill my self', 'kms', 'kys', 'suicide', 'end my life',
    'hang myself', 'shoot myself', 'slit my wrists', 'overdose',

    // School / public violence
    'school shooting', 'columbine', 'virginia tech', 'parkland',
];

const MAGIC_8_BALL_HEAVY_NSFW_TERMS = [
    // General explicit sex
    'fuck', 'fucking', 'fucked', 'fck', 'fuk', 'fucc', 'sex', 'seggs',
    'rape', 'raped', 'raping', 'sexual assault', 'noncon', 'non-consensual',

    // Extreme / illegal content
    'child porn', 'cp', 'csam', 'lolicon', 'shotacon', 'underage', 'loli',
    'shota', 'incest', 'bestiality', 'zoophilia', 'necrophilia', 'gore porn',

    // Common sexual acts
    'blowjob', 'deepthroat', 'throatfuck', 'facefuck', 'gangbang', 'creampie',
    'anal sex', 'anal creampie', 'double penetration', 'dp', 'threesome',
    'forced sex', 'breeding', 'impregnation', 'cum inside', 'cumflation',

    // Furry-specific & common kinks in furry communities
    'knot', 'knotting', 'knot my', 'knotting me','vore', 'vorarephilia', 'unbirthing', 
    'cock vore', 'anal vore', 'hyper', 'hyper cock', 'hyper dick',
    'fursuit sex', 'fursuit fucking', 'yiff', 'yiffing', 'murr', 'murrsuit',
    'feral', 'feral sex', 'feral fucking', 'zoophile', 'zoophilia', 'scat', 
    'diaper', 'abdl', 'ageplay', 'petplay', 'bdsm', 'cnc', 'dubcon', 'ahegao',

    // Body / genital focused
    'cock', 'dick', 'penis', 'pussy', 'cunt', 'vagina', 'ass', 'butthole',
    'clit', 'balls', 'testicles', 'cum', 'semen', 'precum', 'squirt',
    'knot', 'bulge', 'sheath', 'cloaca', 'muzzlefuck', 'pawjob',
    'footjob', 'tailjob',

    // Other heavy NSFW
    'porn', 'hentai', 'rule34', 'e621', 'furry porn', 'furry hentai',
    'hitler', 'nazi', 'nigger', 'faggot', 'tranny', 'retard' 
];

const MAGIC_8_BALL_EXTRA_FILTER_TERMS = [
    // Drugs (very common in large furry servers)
    'weed', 'marijuana', 'cocaine', 'meth', 'lsd', 'shrooms',
    'mushrooms', 'ecstasy', 'mdma', 'ketamine', 'xanax', 'oxy', 'opioid',
    'heroin', 'fentanyl', 'lean', 'perc', 'adderall',

    // Self-harm adjacent or mental health extremes
    'cut myself', 'self harm', 'selfharm', 'self mutilation',

    // Common furry drama / edgy terms
    'zoophile', 'zoophilia', 'feral lover', 'pro-zoo', 'anti-zoo',
    'map', 'minor attracted', 'pedophile', 'pedophilia'
];

// Combined filter for easy use
const MAGIC_8_BALL_BLOCKED_TERMS = [
    ...MAGIC_8_BALL_VIOLENCE_TERMS,
    ...MAGIC_8_BALL_HEAVY_NSFW_TERMS,
    ...MAGIC_8_BALL_EXTRA_FILTER_TERMS
];

// Optional: Helper function with better matching (case insensitive + word boundary aware)
function containsBlockedTerm(question) {
    const lowerQuestion = question.toLowerCase();
    
    return MAGIC_8_BALL_BLOCKED_TERMS.some(term => {
        // Exact phrase match or whole word match to reduce false positives
        const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(lowerQuestion);
    });
}
const MAGIC_8_BALL_SAFETY_DECLINE_RESPONSE =
    "Magic 8-Ball: **I can't answer that. Keep your question safe and non-harmful.**\n"
    "-# Note; We filter content through a regex pattern, please report any false positives through our modmail system with sufficient proof.";
const MAGIC_8_BALL_SUICIDE_SUPPORT_RESPONSE = [
    "Magic 8-Ball: **Please refrain from asking questions about triggering topics.**",
    'If you are in immediate danger, please reach out to the sources below;\n',
    '- Call or text **988** (US & Canada, 24/7)',
    '- Call local emergency services [yes, self-unalival *is* a reason to call 911 if posing immediate danger]',
    '- Find local crisis lines: **https://findahelpline.com**\n\n',
    '-# Note; This message is proactively sensitive and may trigger false positives. We apologize if this is such and would kindly ask you to report false positives through our modmail system.'
].join('\n');

const randomItem = items => items[Math.floor(Math.random() * items.length)];
const containsAnyPattern = (text, patterns) => patterns.some(pattern => pattern.test(text));
const escapeRegex = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEET_CHAR_MAP = {
    a: '[a4@]',
    b: '[b8]',
    e: '[e3]',
    g: '[g69]',
    i: '[i1!|l]',
    l: '[l1!|i]',
    o: '[o0]',
    s: '[s5$]',
    t: '[t7+]',
    y: '[y7]',
    z: '[z2]'
};
const OBFUSCATION_JOINER = '[\\W_]*';
const termToObfuscatedRegex = (term, { allowEmbedded = false } = {}) => {
    const normalizedTerm = String(term || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (!normalizedTerm) return null;

    const corePattern = normalizedTerm
        .split(' ')
        .map(token =>
            token
                .split('')
                .map(character => LEET_CHAR_MAP[character] || escapeRegex(character))
                .join(OBFUSCATION_JOINER)
        )
        .join(OBFUSCATION_JOINER);

    const wrappedPattern = allowEmbedded
        ? corePattern
        : `(?:^|[^a-z0-9])${corePattern}(?:$|[^a-z0-9])`;

    return new RegExp(wrappedPattern, 'i');
};
const buildRegexSet = (terms, options = {}) =>
    terms
        .map(term => termToObfuscatedRegex(term, options))
        .filter(Boolean);

const MAGIC_8_BALL_GAME_CONTEXT_PATTERNS = buildRegexSet(MAGIC_8_BALL_GAME_CONTEXT_TERMS);
const MAGIC_8_BALL_SUICIDE_PATTERNS = buildRegexSet(MAGIC_8_BALL_SUICIDE_TERMS);
const MAGIC_8_BALL_VIOLENCE_PATTERNS = buildRegexSet(MAGIC_8_BALL_VIOLENCE_TERMS);
const MAGIC_8_BALL_HEAVY_NSFW_PATTERNS = buildRegexSet(MAGIC_8_BALL_HEAVY_NSFW_TERMS);

const classifyMagic8BallQuestion = questionText => {
    const normalized = String(questionText || '').trim();
    if (!normalized) return 'empty';
    if (containsAnyPattern(normalized, MAGIC_8_BALL_GAME_CONTEXT_PATTERNS)) return 'safe';
    if (containsAnyPattern(normalized, MAGIC_8_BALL_SUICIDE_PATTERNS) || containsAnyPattern(normalized, MAGIC_8_BALL_SUICIDE_SHORTCODE_PATTERNS)) {
        return 'suicide';
    }
    if (containsAnyPattern(normalized, MAGIC_8_BALL_VIOLENCE_PATTERNS)) return 'terrorism';
    if (containsAnyPattern(normalized, MAGIC_8_BALL_HEAVY_NSFW_PATTERNS)) return 'heavy_nsfw';
    return 'safe';
};

const normalizeGameChannelId = rawValue => {
    const cleaned = String(rawValue || '').replace(/[<#>]/g, '').trim();
    return GAME_CHANNEL_ID_PATTERN.test(cleaned) ? cleaned : null;
};

const formatGamesHelp = (prefix, statsChannelId = null) => [
    'Mini-games are enabled in this channel. Use the short `k.` prefix (or the long `' + prefix + 'games ...` form):',
    '`k.8ball <question>` - Ask the Magic 8-Ball a question.',
    '`k.coinflip` - Flip a coin. Watch for rare edge landings...',
    '`k.roll [sides]` or `k.roll <count>d<sides>` - Roll dice. Try `k.roll 3d6`!',
    '`k.rps <rock|paper|scissors>` - Rock-paper-scissors. I keep score and streaks!',
    '`k.choose <a | b | c>` - Can\'t decide? Let me pick for you.',
    '`k.stats [@user]` - View your (or someone else\'s) game stats.',
    '`k.lb` - Server-wide games leaderboard.',
    statsChannelId ? `-# Stats commands run in <#${statsChannelId}>.` : null
].filter(Boolean).join('\n');

const resolveRpsOutcome = (playerChoice, botChoice) => {
    if (playerChoice === botChoice) return 'tie';
    if (
        (playerChoice === 'rock' && botChoice === 'scissors') ||
        (playerChoice === 'paper' && botChoice === 'rock') ||
        (playerChoice === 'scissors' && botChoice === 'paper')
    ) {
        return 'win';
    }

    return 'lose';
};

async function handleGamesCommand({
    message,
    command,
    args,
    config,
    client,
    guildFeatureState,
    canManageFeatures,
    saveFeatureState
}) {
    const isNamespaceCommand = command === 'games';
    const gamesEnabled = Boolean(guildFeatureState?.gamesEnabled && guildFeatureState?.gamesChannelId);
    const configuredChannelId = guildFeatureState?.gamesChannelId || null;
    const rawAction = (isNamespaceCommand ? args[0] : command || '').toLowerCase();
    const gameArgs = isNamespaceCommand ? args.slice(1) : args;
    const requestedChannelId = isNamespaceCommand
        ? normalizeGameChannelId(rawAction === 'toggle' ? gameArgs[0] : args[0])
        : null;
    const isManagementRequest = isNamespaceCommand && (
        rawAction === 'toggle' ||
        rawAction === 'status' ||
        rawAction === 'disable' ||
        rawAction === 'off' ||
        requestedChannelId !== null
    );

    if (isManagementRequest) {
        if (!canManageFeatures) {
            await message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
            return true;
        }

        if (rawAction === 'status') {
            await message.reply(
                gamesEnabled
                    ? `Mini-games are currently **ENABLED** in <#${configuredChannelId}>.`
                    : 'Mini-games are currently **DISABLED**.'
            );
            return true;
        }

        if (rawAction === 'disable' || rawAction === 'off') {
            if (!gamesEnabled) {
                await message.reply('Mini-games are already disabled.');
                return true;
            }

            guildFeatureState.gamesEnabled = false;
            guildFeatureState.gamesChannelId = null;
            saveFeatureState();
            await message.reply('😔 Mini-games are now disabled.');
            return true;
        }

        const targetChannelId = requestedChannelId || message.channelId;
        const targetChannel =
            message.guild.channels.cache.get(targetChannelId) ||
            await client.channels.fetch(targetChannelId).catch(() => null);

        if (!targetChannel || !targetChannel.isTextBased() || targetChannel.guildId !== message.guild.id) {
            await message.reply('Please provide a valid text channel from this server.');
            return true;
        }

        if (gamesEnabled && configuredChannelId === targetChannelId) {
            guildFeatureState.gamesEnabled = false;
            guildFeatureState.gamesChannelId = null;
            saveFeatureState();
            await message.reply(`😔 Mini-games are now disabled for ${targetChannel}.`);
            return true;
        }

        guildFeatureState.gamesEnabled = true;
        guildFeatureState.gamesChannelId = targetChannelId;
        saveFeatureState();
        await message.reply(`✅ Mini-games are now enabled in ${targetChannel}.`);
        return true;
    }

    if (!gamesEnabled) return false;

    const gameplayCommand = rawAction;
    const supportedGameplayCommands = new Set(['8ball', 'coinflip', 'flip', 'roll', 'rps', 'choose', 'pick', 'stats', 'lb', 'leaderboard', 'help']);
    if (!isNamespaceCommand && !supportedGameplayCommands.has(gameplayCommand)) return false;

    const statsChannelId = guildFeatureState?.gamesStatsChannelId || null;
    const isStatsCommand = GAME_STATS_COMMANDS.has(gameplayCommand);

    if (isStatsCommand && statsChannelId) {
        // A dedicated stats channel is configured: stats commands run there and nowhere else.
        if (message.channelId !== statsChannelId) {
            await message.reply(`📊 Stats and leaderboards live in <#${statsChannelId}> - check them there!`);
            return true;
        }
    } else if (message.channelId !== configuredChannelId) {
        await message.reply(`Mini-games are available in <#${configuredChannelId}>.`);
        return true;
    }

    if (isNamespaceCommand && (!gameplayCommand || gameplayCommand === 'help')) {
        await message.reply(formatGamesHelp(config.prefix, statsChannelId));
        return true;
    }

    const recordPlay = () => {
        const stats = getUserGameStats(message.guildId, message.author.id, message.member?.displayName || message.author.username);
        stats.plays += 1;
        saveGameStats();
        return stats;
    };

    if (gameplayCommand === '8ball') {
        const question = gameArgs.join(' ').trim();
        if (!question) {
            await message.reply(`Usage: \`${config.prefix}games 8ball <question>\``);
            return true;
        }

        const safetyCategory = classifyMagic8BallQuestion(question);
        if (safetyCategory === 'suicide') {
            await message.reply(MAGIC_8_BALL_SUICIDE_SUPPORT_RESPONSE);
            return true;
        }

        if (safetyCategory !== 'safe') {
            await message.reply(MAGIC_8_BALL_SAFETY_DECLINE_RESPONSE);
            return true;
        }

//        if (!question.includes('?')) {
//            await message.reply('Magic 8-Ball: **Ask it like a real question ending with `?` and I will answer.**');
//            return true; ----> Logic to scan for "?" being present in the message
//        }

        recordPlay().eightBall.asked += 1;
        await message.reply(`${randomItem(MAGIC_8_BALL_SHAKE_FLAVOR)}\n🎱 Magic 8-Ball: **${randomItem(MAGIC_8_BALL_STANDARD_RESPONSES)}**`);
        return true;
    }

    if (gameplayCommand === 'coinflip' || gameplayCommand === 'flip') {
        const stats = recordPlay();
        stats.coinflip.flips += 1;
        if (Math.random() < 0.01) {
            stats.coinflip.edges += 1;
            await message.reply(`🪙 ${COINFLIP_EDGE_FLAVOR}`);
            return true;
        }

        const isHeads = Math.random() < 0.5;
        if (isHeads) stats.coinflip.heads += 1;
        else stats.coinflip.tails += 1;
        const flavor = isHeads
            ? randomItem(COINFLIP_HEADS_FLAVOR)
            : randomItem(COINFLIP_TAILS_FLAVOR);
        await message.reply(`🪙 ${flavor}`);
        return true;
    }

    if (gameplayCommand === 'roll') {
        const rollArg = String(gameArgs[0] || '').toLowerCase();
        const notationMatch = rollArg.match(/^(\d*)d(\d+)$/);
        const diceCount = notationMatch ? (notationMatch[1] ? Number.parseInt(notationMatch[1], 10) : 1) : 1;
        const sides = notationMatch
            ? Number.parseInt(notationMatch[2], 10)
            : (rollArg ? Number.parseInt(rollArg, 10) : 6);
        if (!Number.isInteger(sides) || sides < 2 || sides > 1000 || !Number.isInteger(diceCount) || diceCount < 1 || diceCount > 10) {
            await message.reply(`Usage: \`k.roll [2-1000]\` or \`k.roll <count>d<sides>\` - up to 10 dice, e.g. \`k.roll 3d6\`.`);
            return true;
        }

        const rolls = Array.from({ length: diceCount }, () => Math.floor(Math.random() * sides) + 1);
        const rollStats = recordPlay().roll;
        rollStats.rolls += diceCount;
        rollStats.crits += rolls.filter(value => value === sides).length;
        if (sides >= 6) rollStats.fails += rolls.filter(value => value === 1).length;
        if (diceCount === 1) {
            const result = rolls[0];
            const flavor = result === sides
                ? ' ✨ **Maximum roll!**'
                : (result === 1 && sides >= 6 ? ' 💀 ...a natural 1. Tragic.' : '');
            await message.reply(`🎲 You rolled **${result}** out of **${sides}**.${flavor}`);
        } else {
            const total = rolls.reduce((sum, value) => sum + value, 0);
            await message.reply(`🎲 ${diceCount}d${sides}: [${rolls.join(', ')}] = **${total}**`);
        }
        return true;
    }

    if (gameplayCommand === 'rps') {
        const playerChoice = String(gameArgs[0] || '').toLowerCase();
        if (!GAME_CHOICES.includes(playerChoice)) {
            await message.reply(`Usage: \`k.rps <rock|paper|scissors>\``);
            return true;
        }

        const botChoice = randomItem(GAME_CHOICES);
        const outcome = resolveRpsOutcome(playerChoice, botChoice);
        const score = recordPlay().rps;
        if (outcome === 'win') {
            score.wins += 1;
            score.streak = score.streak > 0 ? score.streak + 1 : 1;
            if (score.streak > score.bestStreak) score.bestStreak = score.streak;
        } else if (outcome === 'lose') {
            score.losses += 1;
            score.streak = score.streak < 0 ? score.streak - 1 : -1;
        } else {
            score.ties += 1;
        }

        const outcomeText = outcome === 'win'
            ? randomItem(RPS_WIN_LINES)
            : outcome === 'lose'
                ? randomItem(RPS_LOSE_LINES)
                : randomItem(RPS_TIE_LINES);
        await message.reply([
            `You picked ${RPS_CHOICE_EMOJI[playerChoice]} **${playerChoice}**. I picked ${RPS_CHOICE_EMOJI[botChoice]} **${botChoice}**. ${outcomeText}`,
            `-# Score vs me: ${score.wins}W-${score.losses}L-${score.ties}T${formatRpsStreak(score)}`
        ].join('\n'));
        return true;
    }

    if (gameplayCommand === 'choose' || gameplayCommand === 'pick') {
        const optionsText = gameArgs.join(' ').trim();
        const options = optionsText
            .split(/\s*(?:\||,| or )\s*/i)
            .map(option => option.trim())
            .filter(Boolean);
        if (options.length < 2) {
            await message.reply('Usage: `k.choose <option> | <option> | ...` - give me at least two options (separate with `|`, `,` or `or`).');
            return true;
        }

        const safetyCategory = classifyMagic8BallQuestion(optionsText);
        if (safetyCategory === 'suicide') {
            await message.reply(MAGIC_8_BALL_SUICIDE_SUPPORT_RESPONSE);
            return true;
        }

        if (safetyCategory !== 'safe') {
            await message.reply(MAGIC_8_BALL_SAFETY_DECLINE_RESPONSE);
            return true;
        }

        recordPlay().choose.picks += 1;
        await message.reply(`${randomItem(CHOOSE_FLAVOR)} **${randomItem(options)}**`);
        return true;
    }

    if (gameplayCommand === 'stats') {
        const targetArg = String(gameArgs[0] || '').replace(/[<@!>]/g, '');
        const targetId = GAME_CHANNEL_ID_PATTERN.test(targetArg) ? targetArg : message.author.id;
        const isSelf = targetId === message.author.id;
        const stats = readUserGameStats(message.guildId, targetId);
        if (!stats) {
            await message.reply(isSelf
                ? "You haven't played any games yet! Try `k.8ball`, `k.rps`, or `k.roll` first."
                : "That user hasn't played any games yet.");
            return true;
        }

        await message.reply([
            `📊 **Game stats for ${isSelf ? 'you' : stats.name}** - ${stats.plays} total plays`,
            `🎱 8-Ball: ${stats.eightBall.asked} questions asked`,
            `🪙 Coinflip: ${stats.coinflip.flips} flips (${stats.coinflip.heads} heads / ${stats.coinflip.tails} tails / ${stats.coinflip.edges} edge landings)`,
            `🎲 Dice: ${stats.roll.rolls} dice rolled (${stats.roll.crits} max rolls, ${stats.roll.fails} natural 1s)`,
            `✂️ RPS: ${stats.rps.wins}W-${stats.rps.losses}L-${stats.rps.ties}T (best streak: ${stats.rps.bestStreak})`,
            `🤔 Choose: ${stats.choose.picks} decisions outsourced`
        ].join('\n'));
        return true;
    }

    if (gameplayCommand === 'lb' || gameplayCommand === 'leaderboard') {
        const guildStats = gameStatsState.guilds[message.guildId] || {};
        const ranked = Object.values(guildStats)
            .filter(stats => (stats?.plays || 0) > 0)
            .sort((a, b) => (b.plays || 0) - (a.plays || 0))
            .slice(0, 10);
        if (ranked.length === 0) {
            await message.reply('🏆 The leaderboard is empty - nobody has played yet! Be the first with `k.8ball`, `k.rps`, or `k.roll`.');
            return true;
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines = ranked.map((stats, index) => {
            const rank = medals[index] || `**#${index + 1}**`;
            return `${rank} ${stats.name} - ${stats.plays} plays | RPS ${stats.rps?.wins || 0}W-${stats.rps?.losses || 0}L (best streak ${stats.rps?.bestStreak || 0})`;
        });
        await message.reply([`🏆 **Server Games Leaderboard** - top ${ranked.length} by total plays`, ...lines].join('\n'));
        return true;
    }

    if (isNamespaceCommand) {
        await message.reply(formatGamesHelp(config.prefix, statsChannelId));
        return true;
    }

    return false;
}

async function handleMessageCreate(message, deps) {
    const {
        client, config, allowedDevs, saveDevs, getGuildFeatureState, saveFeatureState,
        sweepAutodeleteChannel, scheduleAutodelete, scheduleAutoMessageRefresh,
        clearAutoMessage, aiChatCog, comfyCog, loggerCog, modmailCog, socialsCog, resolveChannel,
        getUsageText, buildHelpEmbed, COMMAND_USAGE, normalizeHelpTopic, getAutodeleteImmuneUserIds,
        resolveImmunityTarget, ensureAutoThread, OWNER_CHANNEL_OVERWRITE,
        BOT_INTERACTION_SYNC_CHANNEL_ID, BOT_INTERACTION_SYNC_GUILD_ID, ensureOwnerChannelAccess,
        PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType,
        levelingCog, embedBuilderCog
    } = deps;
    const hasAiSecretHandler = typeof aiChatCog?.handleSecretCommand === 'function';
    const hasAiMemoryControls = typeof aiChatCog?.clearChannelMemory === 'function';
    const hasAiAmbientTest = typeof aiChatCog?.triggerAmbientTest === 'function';
    const hasComfySecretHandler = typeof comfyCog?.handleSecretCommand === 'function';
    const hasComfyGenerate = typeof comfyCog?.handleGenerateCommand === 'function';
    const hasSocialsCommands = typeof socialsCog?.handleSocialsCommand === 'function';
    const hasSocialsConfig = typeof socialsCog?.handleConfigCommand === 'function';
    const replyUnavailableFeature = featureName =>
        message.reply(`😔 ${featureName} is currently unavailable because its cog is not loaded.`);


    const isDirectMessage = !message.guild;
    const isKnownCommandLikeMessage =
        message.content.startsWith(config.prefix) ||
        message.content.startsWith('k!') ||
        message.content.startsWith('k.') ||
        message.content.startsWith('_*');

    if (isDirectMessage && !isKnownCommandLikeMessage) {
        return;
    }

    await ensureAutoThread(message);
    scheduleAutodelete(message);

    if (message.author.bot) return;

    if (await embedBuilderCog.handlePendingInput(message)) {
        return;
    }

    const liveGuildState = message.guildId ? getGuildFeatureState(message.guildId) : null;
    if (liveGuildState && message.channelId === liveGuildState.autoMessageChannelId && liveGuildState.autoMessageEnabled) {
        scheduleAutoMessageRefresh(message.channel);
    }

    await levelingCog.handleMessage(message);

    // Secret Trusted Commands (Master + Operator + allowlisted developers)
    if (
        message.content.startsWith('_*') &&
        (
            message.author.id === config.master_id ||
            message.author.id === config.operator_id ||
            allowedDevs.has(message.author.id)
        )
    ) {
        const secretArgs = message.content.slice(2).trim().split(/ +/);
        const secretCmd = secretArgs.shift().toLowerCase();

        if (hasComfySecretHandler && await comfyCog.handleSecretCommand(message, secretCmd, [...secretArgs])) {
            return;
        }

        if (hasAiSecretHandler && await aiChatCog.handleSecretCommand(message, secretCmd, [...secretArgs])) {
            return;
        }

        if (secretCmd === 'restart') {
            const targetCog = secretArgs[0]?.toLowerCase();
            const configMap = {
                'socials': { key: 'socials', file: './socials.js', ClassName: 'SocialsCog' },
                'logger': { key: 'logger', file: './logger.js', ClassName: 'LoggerCog' },
                'modmail': { key: 'modmail', file: './modmail.js', ClassName: 'ModmailCog' },
                'modmail_debug': { key: 'modmailDebug', file: './modmail-debug.js', ClassName: 'ModmailDebugCog' },
                'ai': { key: 'aiChat', file: './ai-chat.js', ClassName: 'AIChatCog' },
                'comfy': { key: 'comfy', file: './comfyui.js', ClassName: 'ComfyUICog' },
                'starboard': { key: 'starboard', file: './starboard.js', ClassName: 'StarboardCog' },
                'leveling': { key: 'leveling', file: './leveling.js', ClassName: 'LevelingCog' },
                'message_create': { file: './message_create.js' }
            };

            const cogDef = configMap[targetCog];
            if (!cogDef) {
                await message.reply(`Unknown cog: \`${targetCog || 'none'}\`. Valid options: ${Object.keys(configMap).join(', ')}`);
                return;
            }

            try {
                const resolvedPath = require.resolve(cogDef.file);
                delete require.cache[resolvedPath];

                if (targetCog === 'message_create') {
                    await message.reply(`✅ Hot-reloaded \`message_create.js\` successfully!`);
                    return;
                }

                const existingInst = client.cogs[cogDef.key];
                if (existingInst && typeof existingInst.stop === 'function') {
                    existingInst.stop();
                } else if (existingInst && typeof existingInst.destroy === 'function') {
                    existingInst.destroy();
                }

                const requiredModule = require(cogDef.file);
                const NewClass = requiredModule[cogDef.ClassName] || requiredModule;
                if (typeof NewClass !== 'function') throw new Error(`Class export not found in ${cogDef.file}`);

                const newInst = new NewClass(client);
                client.cogs[cogDef.key] = newInst;

                if (typeof newInst.start === 'function') {
                    newInst.start();
                }

                await message.reply(`✅ Hot-reloaded \`${targetCog}\` successfully without rebooting!`);
            } catch (error) {
                await message.reply(`😔 Failed to reload \`${targetCog}\`: \`${error.message}\``);
                console.error(`[HOT-RELOAD] Failed to reload ${targetCog}:`, error);
            }
            return;
        }

        if (secretCmd === 'send_msg' || secretCmd === 'reply') {
            await message.delete().catch(() => {});
            
            const targetArg = secretArgs.shift();
            const msgContent = secretArgs.join(' ');
            if (!targetArg || !msgContent) {
                await message.channel.send(secretCmd === 'send_msg' ? getUsageText('secret_send_msg') : getUsageText('secret_reply')).catch(() => {});
                return;
            }

            const files = Array.from(message.attachments.values());

            try {
                // If the user uses a hyphen, split it. Else they might have just passed a MSID
                let query = targetArg;
                let replyMsgId = null;
                if (secretCmd === 'reply') {
                    if (targetArg.includes('-')) {
                        const parts = targetArg.split('-');
                        query = parts[0]; 
                        replyMsgId = parts[1];
                    }
                }
                
                const { channel: resolvedCh, msg: resolvedMsg } = await resolveChannel(message.guild, query, message.channel);
                if (!resolvedCh) {
                    await message.channel.send(secretCmd === 'send_msg' ? getUsageText('secret_send_msg') : getUsageText('secret_reply')).catch(() => {});
                    return;
                }

                if (secretCmd === 'send_msg') {
                    await resolvedCh.send({ content: msgContent || null, files });
                } else if (secretCmd === 'reply') {
                    const targetMsg = replyMsgId ? await resolvedCh.messages.fetch(replyMsgId).catch(() => null) : resolvedMsg;
                    if (!targetMsg) {
                        await message.channel.send(getUsageText('secret_reply')).catch(() => {});
                        return;
                    }
                    await targetMsg.reply({ content: msgContent || null, files });
                }
            } catch(e) { console.error("Secret command failed", e); }
            return;
        }

        if (secretCmd === 'games') {
            const gamesSubCmd = (secretArgs.shift() || '').toLowerCase();
            if (gamesSubCmd !== 'statchan') {
                await message.reply('Usage: `_*games statchan <#channel|name|id|link>` or `_*games statchan cleared`');
                return;
            }

            if (!message.guild) {
                await message.reply('`_*games statchan` can only be used inside a server.');
                return;
            }

            const guildState = getGuildFeatureState(message.guild.id);
            const rawTarget = secretArgs.join(' ').trim();

            if (!rawTarget) {
                await message.reply(guildState.gamesStatsChannelId
                    ? `Stats channel is currently <#${guildState.gamesStatsChannelId}>. Use \`_*games statchan cleared\` to remove it.`
                    : 'No stats channel set; `k.stats` and `k.lb` run in the games channel.\nUsage: `_*games statchan <#channel|name|id|link|cleared>`');
                return;
            }

            if (rawTarget.toLowerCase() === 'cleared' || rawTarget.toLowerCase() === 'clear') {
                guildState.gamesStatsChannelId = null;
                saveFeatureState();
                await message.reply('✅ Stats channel cleared. `k.stats` and `k.lb` now run in the games channel.');
                return;
            }

            const statsChannel = await resolveStatsChannelInput(message.guild, rawTarget, client);
            if (!statsChannel) {
                await message.reply('Could not resolve that channel. Use a #mention, exact channel name, ID, or channel link from this server.');
                return;
            }

            guildState.gamesStatsChannelId = statsChannel.id;
            saveFeatureState();
            await message.reply(`✅ \`k.stats\` and \`k.lb\` are now locked to ${statsChannel}. They are no longer usable in the games channel.`);
            return;
        }
    }

    // Interaction Tracker

    const isPing = message.mentions.has(client.user);
    let isReply = false;
    if (message.reference && message.reference.messageId) {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (refMsg && refMsg.author.id === client.user.id) isReply = true;
    }

    if (isPing || isReply) {
        try {
            const guild = message.guild;
            if (guild) {
                const interactionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`admin_reply_${message.channelId}_${message.id}`).setLabel('Quick Reply').setStyle(ButtonStyle.Primary)
                );
                const interactionEmbed = new EmbedBuilder()
                    .setAuthor({ name: `${message.author.tag} (${message.author.id})`, iconURL: message.author.displayAvatarURL() })
                    .setColor('#8B5CF6')
                    .setDescription(`**Content:**\n${message.content || '[No Text/Attachments Only]'}`)
                    .addFields(
                        { name: 'Channel', value: `${message.channel} (\`${message.channel.id}\`)`, inline: true },
                        { name: 'Direct Link', value: `[Jump to message](${message.url})`, inline: true }
                    )
                    .setFooter({ text: `Message ID: ${message.id}` })
                    .setTimestamp(message.createdAt);

                let cat = guild.channels.cache.find(c => c.name === 'bot-interaction' && c.type === ChannelType.GuildCategory);
                if (!cat) {
                    cat = await guild.channels.create({
                        name: 'bot-interaction',
                        type: ChannelType.GuildCategory,
                        permissionOverwrites: [
                            { id: guild.id, deny: ['ViewChannel'] },
                            { id: client.user.id, allow: ['ViewChannel', 'SendMessages'] },
                            { id: config.master_id, allow: Object.keys(OWNER_CHANNEL_OVERWRITE) }
                        ]
                    });
                }
                await ensureOwnerChannelAccess(cat);
                
                let ch = guild.channels.cache.find(c => c.name === 'interactions' && c.parentId === cat.id);
                if (!ch) ch = await guild.channels.create({ name: 'interactions', type: ChannelType.GuildText, parent: cat.id });
                await ensureOwnerChannelAccess(ch);
                await ch.send({ embeds: [interactionEmbed], components: [interactionRow] });

                const syncChannel = await client.channels.fetch(BOT_INTERACTION_SYNC_CHANNEL_ID).catch(() => null);
                if (syncChannel?.guildId === BOT_INTERACTION_SYNC_GUILD_ID && syncChannel.isTextBased()) {
                    await syncChannel.send({ embeds: [interactionEmbed], components: [interactionRow] }).catch(() => {});
                }
            }
        } catch(e) { console.error("Tracker failed", e); }
    }
    if (message.author.bot) return;
    const usesPrimaryPrefix = message.content.startsWith(config.prefix);
    const usesLevelingPrefix = message.content.startsWith('k!');
    const usesGamesPrefix = !usesPrimaryPrefix && !usesLevelingPrefix && message.content.startsWith('k.');
    if (!usesPrimaryPrefix && !usesLevelingPrefix && !usesGamesPrefix) return;

    const commandPrefix = usesPrimaryPrefix ? config.prefix : (usesLevelingPrefix ? 'k!' : 'k.');
    const args = message.content.slice(commandPrefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const isLevelingShortcut = usesLevelingPrefix && ['rank', 'rep'].includes(command);
    const isGamesShortcut = usesGamesPrefix && GAME_SHORTCUT_COMMANDS.has(command);

    if (usesLevelingPrefix && !isLevelingShortcut) {
        return;
    }

    if (usesGamesPrefix && !isGamesShortcut) {
        return;
    }

    // --- PERMISSION DEFINITIONS ---
    const isMaster = message.author.id === config.master_id;
    const isOperator = message.author.id === config.operator_id;
    const isDev = isMaster || allowedDevs.has(message.author.id);
    const isModerator = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages));
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    const canManageFeatures = isDev || isOperator || isModerator;
    const isTrustedStaff = isDev || isOperator;
    const isAllowedGuild = message.guildId === config.staff_guild_id;
    const guildFeatureState = message.guild ? getGuildFeatureState(message.guild.id) : null;

    if (!message.guild) {
        if (isLevelingShortcut) {
            return message.reply('`k!rank` and `k!rep` can only be used inside a server.');
        }

        if (isGamesShortcut) {
            return message.reply('Mini-games only work inside a server. Find the games channel and play there! :3');
        }

        if (!isTrustedStaff) {
            return message.reply('DM commands are restricted. If you need support, just send a normal DM without `abc.` and modmail will handle it when enabled.');
        }

        if (command === 'dev') {
            if (!isMaster) return message.reply("nuh-uh! This feature has been locked master_only for security reasons. Please ask them for access if you think you should have it.");

            const action = args[0];
            const targetId = args[1];

            if (!targetId) return message.reply(getUsageText('dev'));

            if (action === 'allow') {
                if (allowedDevs.has(targetId)) return message.reply(`ID \`${targetId}\` is already an allowed developer, I heard high-quality omega-3 fish oil supplements helps with memory, maybe you should check that out...`);
                allowedDevs.add(targetId);
                saveDevs();
                return message.reply(`✅ ID \`${targetId}\` has been granted developer execution rights.\n-# protip: be silly :3`);
            }

            if (action === 'deny') {
                if (!allowedDevs.has(targetId)) return message.reply(`ID \`${targetId}\` is not in the developer list.`);
                allowedDevs.delete(targetId);
                saveDevs();
                return message.reply(`😔 ID \`${targetId}\` has been stripped of developer execution rights.`);
            }

            return message.reply(getUsageText('dev'));
        }

        if (command === 'clear') {
            const rawChannel = args[0];
            if (!rawChannel) {
                return message.reply('Usage in DMs:\n' + getUsageText('clear').split('\n')[1]);
            }

            const channelId = rawChannel.replace(/[<#>]/g, '');
            const targetChannel = await client.channels.fetch(channelId).catch(() => null);
            if (!targetChannel || !targetChannel.isTextBased()) {
                return message.reply('Please provide a valid text channel ID.');
            }

            if (!hasAiMemoryControls) {
                return replyUnavailableFeature('AI memory controls');
            }

            aiChatCog.clearChannelMemory(targetChannel.id);
            return message.reply(`✅ Cleared bot memory for <#${targetChannel.id}>.`);
        }

        if (command === 'ping') {
            return message.reply(`Pong! Owner is <@${config.master_id}>, Operating for: <@${config.operator_id}>.`);
        }

        if (command === 'help') {
            const topic = normalizeHelpTopic(args[0]);
            if (topic && COMMAND_USAGE[topic]) {
                return message.reply(getUsageText(topic));
            }

            return message.reply({ embeds: [buildHelpEmbed()] });
        }

        return message.reply('That command needs to be run in a server, or use the hidden `_*` staff commands in DMs.');
    }

    if (isLevelingShortcut) {
        if (command === 'rank') {
            return levelingCog.handleRankCommand(message, args);
        }

        if (command === 'rep') {
            return levelingCog.handleRepCommand(message, args);
        }
    }

    // --- TIER 1: THE MASTER COMMANDS (Only YOU can use these) ---
    if (command === 'dev') {
        if (!isMaster) return message.reply("nuh-uh! This feature has been locked master_only for security reasons. Please ask them for access if you think you should have it.");

        const action = args[0];
        const targetId = args[1];

        if (!targetId) return message.reply(getUsageText('dev'));

        if (action === 'allow') {
            if (allowedDevs.has(targetId)) return message.reply(`ID \`${targetId}\` is already an allowed developer, I heard high-quality omega-3 fish oil supplements helps with memory, maybe you should check that out...`);
            allowedDevs.add(targetId);
            saveDevs();
            return message.reply(`✅ ID \`${targetId}\` has been granted developer execution rights.\n-# protip: be silly :3`);
        }

        if (action === 'deny') {
            if (!allowedDevs.has(targetId)) return message.reply(`ID \`${targetId}\` is not in the developer list.`);
            allowedDevs.delete(targetId);
            saveDevs();
            return message.reply(`😔 ID \`${targetId}\` has been stripped of developer execution rights.`);
        }

        return message.reply(getUsageText('dev'));
    }

    // --- TIER 2: DEVELOPER COMMANDS (Master + Allowed Devs) ---
    if (command === 'eval') {
        if (!isDev) return message.reply("⛔ Access Denied. This command is restricted to the bot owner and allowed developers only.");
        
        // EVAL LOGIC GOES HERE (Extremely dangerous, handle with care)
        return message.reply(`unsupported at the moment.\n${getUsageText('eval')}`);
    }

    if (command === 'autodelete') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const action = (args[0] || 'status').toLowerCase();
        const moderatorImmuneUsers = guildFeatureState.autodeleteUserImmunities[message.author.id] || [];
        const totalImmuneUsers = getAutodeleteImmuneUserIds(guildFeatureState).size;
        const configuredChannelText = guildFeatureState.autodeleteChannelId ? `<#${guildFeatureState.autodeleteChannelId}>` : '`not configured`';
        const immuneMessageIds = guildFeatureState.autodeleteImmuneMessageIds.length
            ? `\`${guildFeatureState.autodeleteImmuneMessageIds.join('`, `')}\``
            : '`none`';

        if (action === 'status') {
            return message.reply(
                `Autodelete is currently **${guildFeatureState.autodeleteEnabled ? 'ENABLED' : 'DISABLED'}** for ${configuredChannelText}.\n` +
                `Cutoff: messages created on or after 2026-01-01 UTC.\n` +
                `Immune message IDs: ${immuneMessageIds}\n` +
                `Immune users: **${totalImmuneUsers}** total, **${moderatorImmuneUsers.length}** added by you.`
            );
        }

        if (action === 'enable' || action === 'on') {
            if (!guildFeatureState.autodeleteChannelId) {
                return message.reply('Autodelete is not configured for this guild yet.');
            }

            guildFeatureState.autodeleteEnabled = true;
            saveFeatureState();

            const autoDeleteChannel = await client.channels.fetch(guildFeatureState.autodeleteChannelId).catch(() => null);
            if (!autoDeleteChannel?.isTextBased()) {
                return message.reply(`Autodelete was enabled, but I couldn't access <#${guildFeatureState.autodeleteChannelId}> to sweep it.`);
            }

            const { deletedCount, skippedImmuneCount } = await sweepAutodeleteChannel(autoDeleteChannel, new Set([message.id]));
            const reply = await message.reply(
                `✅ Autodelete is now enabled for <#${guildFeatureState.autodeleteChannelId}>.\n` +
                `Backlog sweep removed **${deletedCount}** messages and skipped **${skippedImmuneCount}** immune messages.`
            );

            if (message.channelId === guildFeatureState.autodeleteChannelId) scheduleAutodelete(message);
            if (reply.channelId === guildFeatureState.autodeleteChannelId) scheduleAutodelete(reply);
            return;
        }

        if (action === 'disable' || action === 'off') {
            guildFeatureState.autodeleteEnabled = false;
            saveFeatureState();
            return message.reply(`😔 Autodelete is now disabled for ${configuredChannelText}.`);
        }

        return message.reply("Usage: `abc.autodelete status`, `abc.autodelete enable`, or `abc.autodelete disable`");
    }

    if (command === 'immune') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const targetUserId = resolveImmunityTarget(args[0], message);
        if (!targetUserId) {
            return message.reply('Usage: `abc.immune <self|@user|user_id>`');
        }

        const moderatorImmuneUsers = new Set(guildFeatureState.autodeleteUserImmunities[message.author.id] || []);
        if (moderatorImmuneUsers.has(targetUserId)) {
            return message.reply(`<@${targetUserId}> is already immune from autodelete through your moderation entry.`);
        }

        moderatorImmuneUsers.add(targetUserId);
        guildFeatureState.autodeleteUserImmunities[message.author.id] = [...moderatorImmuneUsers];
        saveFeatureState();

        return message.reply(
            `✅ <@${targetUserId}> is now immune from autodelete until you remove that immunity with ` +
            '`abc.unimmune <self|@user|user_id>`.'
        );
    }

    if (command === 'unimmune') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const action = (args[0] || '').toLowerCase();
        const moderatorImmuneUsers = new Set(guildFeatureState.autodeleteUserImmunities[message.author.id] || []);

        if (action === 'all') {
            const removedCount = moderatorImmuneUsers.size;
            if (removedCount === 0) {
                return message.reply('You have no active autodelete immunities to remove.');
            }

            delete guildFeatureState.autodeleteUserImmunities[message.author.id];
            saveFeatureState();

            let sweepSummary = '';
            if (guildFeatureState.autodeleteEnabled && guildFeatureState.autodeleteChannelId) {
                const autoDeleteChannel = await client.channels.fetch(guildFeatureState.autodeleteChannelId).catch(() => null);
                if (autoDeleteChannel?.isTextBased()) {
                    const { deletedCount } = await sweepAutodeleteChannel(autoDeleteChannel, new Set([message.id]));
                    sweepSummary = ` Backlog sweep removed **${deletedCount}** newly eligible messages.`;
                }
            }

            return message.reply(
                `✅ Removed **${removedCount}** autodelete immunities that you added.${sweepSummary}`
            );
        }

        const targetUserId = resolveImmunityTarget(args[0], message);
        if (!targetUserId) {
            return message.reply('Usage: `abc.unimmune <self|@user|user_id>` or `abc.unimmune all`');
        }

        if (!moderatorImmuneUsers.has(targetUserId)) {
            return message.reply(`<@${targetUserId}> is not immune through your moderation entry.`);
        }

        moderatorImmuneUsers.delete(targetUserId);
        if (moderatorImmuneUsers.size > 0) {
            guildFeatureState.autodeleteUserImmunities[message.author.id] = [...moderatorImmuneUsers];
        } else {
            delete guildFeatureState.autodeleteUserImmunities[message.author.id];
        }
        saveFeatureState();

        let sweepSummary = '';
        if (guildFeatureState.autodeleteEnabled && guildFeatureState.autodeleteChannelId) {
            const autoDeleteChannel = await client.channels.fetch(guildFeatureState.autodeleteChannelId).catch(() => null);
            if (autoDeleteChannel?.isTextBased()) {
                const { deletedCount } = await sweepAutodeleteChannel(autoDeleteChannel, new Set([message.id]));
                sweepSummary = ` Backlog sweep removed **${deletedCount}** newly eligible messages.`;
            }
        }

        const stillImmune = getAutodeleteImmuneUserIds(guildFeatureState).has(targetUserId);
        const immunitySummary = stillImmune
            ? `<@${targetUserId}> is still immune because another moderator also exempted them.`
            : `<@${targetUserId}> is no longer immune from autodelete.`;

        return message.reply(`✅ ${immunitySummary}${sweepSummary}`);
    }

    if (command === 'enable' && args[0]?.toLowerCase() === 'auto-message') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        if (!guildFeatureState.autoMessageChannelId) {
            return message.reply('Auto-message is not configured for this guild yet.');
        }

        guildFeatureState.autoMessageEnabled = true;
        saveFeatureState();

        const reply = await message.reply(`✅ Auto-message is now enabled for <#${guildFeatureState.autoMessageChannelId}>.`);
        const autoMessageChannel = await client.channels.fetch(guildFeatureState.autoMessageChannelId).catch(() => null) || reply.channel;
        if (autoMessageChannel?.isTextBased()) {
            scheduleAutoMessageRefresh(autoMessageChannel);
        }
        return;
    }

    if (command === 'enable') {
        return message.reply(getUsageText('enable'));
    }

    if (command === 'disable' && args[0]?.toLowerCase() === 'auto-message') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        guildFeatureState.autoMessageEnabled = false;
        saveFeatureState();

        const autoMessageChannel = guildFeatureState.autoMessageChannelId
            ? await client.channels.fetch(guildFeatureState.autoMessageChannelId).catch(() => null)
            : null;
        if (autoMessageChannel?.isTextBased()) {
            await clearAutoMessage(autoMessageChannel);
        }

        const autoMessageChannelText = guildFeatureState.autoMessageChannelId ? `<#${guildFeatureState.autoMessageChannelId}>` : '`not configured`';
        return message.reply(`😔 Auto-message is now disabled for ${autoMessageChannelText}.`);
    }

    if (command === 'disable') {
        return message.reply(getUsageText('disable'));
    }

    if (command === 'welcomsg') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const msgContent = args.join(' ');
        if (!msgContent) {
            guildFeatureState.welcomsgEnabled = !guildFeatureState.welcomsgEnabled;
            saveFeatureState();
            return message.reply(
                guildFeatureState.welcomsgEnabled 
                    ? '✅ Welcome DMs are now enabled.'
                    : '😔 Welcome DMs are now disabled.'
            );
        } else {
            guildFeatureState.welcomsgText = msgContent;
            saveFeatureState();
            return message.reply(`✅ Welcome DM message updated to:\n${msgContent}`);
        }
    }

    if (command === 'welcomsg-test') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const welcomeMessage =
            guildFeatureState.welcomsgText ||
            "👋 **Welcome to the server!**\nIf you have any questions, send me a message to open a ticket with the staff team.";

        try {
            await message.author.send(welcomeMessage);
            return message.reply('✅ Sent the current welcome message to your DMs.');
        } catch (error) {
            return message.reply(`😔 I couldn't DM you the welcome test message: ${error.message}`);
        }
    }

    if (command === 'toggle' && args[0]?.toLowerCase() === 'modmail') {
        if (!canManageFeatures) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const enabled = modmailCog.toggleEnabled();
        return message.reply(
            enabled
                ? '✅ Modmail is now enabled.'
                : '😔 Modmail is now disabled.'
        );
    }

    if (command === 'note' || command === 'reply' || command === 'anonreply' || command === 'areply') {
        const ticket = modmailCog.getTicketByThreadId(message.channel.id);
        const isActiveModmailThread = Boolean(ticket && ticket.open && message.channel.isThread());
        if (isActiveModmailThread) {
            if (!canManageFeatures && !isAllowedGuild) {
                return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
            }

            const content = args.join(' ').trim();
            if (!content) {
                const usage = command === 'note'
                    ? `Usage: \`${config.prefix}note <content>\``
                    : command === 'reply'
                        ? `Usage: \`${config.prefix}reply <content>\``
                        : `Usage: \`${config.prefix}${command} <content>\``;
                return message.reply(usage);
            }

            await message.delete().catch(() => {});

            if (command === 'note') {
                const result = await modmailCog.addInternalNote(ticket, message.channel, message.author, content);
                if (!result?.ok) {
                    return message.channel.send(`😔 ${result?.reason || 'Failed to post the staff note.'}`).catch(() => {});
                }
                return;
            }

            const result = await modmailCog.sendStaffCommandReply(ticket, message.channel, message.author, content, {
                anonymous: command === 'anonreply' || command === 'areply'
            });
            if (!result?.ok) {
                return message.channel.send(`😔 ${result?.reason || 'Failed to send the reply.'}`).catch(() => {});
            }
            return;
        }
    }

    if (command === 'close' || command === 'resolve') {
        if (!canManageFeatures && !isAllowedGuild) {
            return message.reply("⛔ Access Denied. Moderators or trusted bot staff only.");
        }

        const ticket = modmailCog.getTicketByThreadId(message.channel.id);
        if (!ticket || !message.channel.isThread()) {
            return message.reply("This command can only be used within an active modmail ticket thread.");
        }

        if (!ticket.open) {
            return message.reply("This ticket is already closed.");
        }

        const markResolved = (command === 'resolve');
        await modmailCog.closeTicket(ticket, message.channel, markResolved, message.author);
        return message.reply(markResolved 
            ? '✅ Ticket resolved and archived.' 
            : '✅ Ticket closed and archived.'
        );
    }

    if (command === 'toggle') {
        return message.reply(getUsageText('toggle'));
    }

    if (command === 'clear') {
        if (!(isDev || isOperator || isAdmin)) {
            return message.reply("⛔ Access Denied. Administrators or trusted bot staff only.");
        }

        const rawChannel = args[0];
        const channelId = rawChannel ? rawChannel.replace(/[<#>]/g, '') : message.channelId;
        const targetChannel = message.guild.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);

        if (!targetChannel || !targetChannel.isTextBased() || targetChannel.guildId !== message.guild.id) {
            return message.reply('Please provide a valid text channel from this server.');
        }

        if (!hasAiMemoryControls) {
            return replyUnavailableFeature('AI memory controls');
        }

        aiChatCog.clearChannelMemory(targetChannel.id);
        return message.reply(`✅ Cleared bot memory for ${targetChannel}.`);
    }

    if (command === 'aitest') {
        if (!(isDev || isOperator || isAdmin)) {
            return message.reply("⛔ Access Denied. Administrators or trusted bot staff only.");
        }

        const subcommand = (args[0] || '').toLowerCase();
        if (subcommand !== 'conversation') {
            return message.reply(getUsageText('aitest'));
        }

        if (!hasAiAmbientTest) {
            return replyUnavailableFeature('Ambient AI testing');
        }

        const result = await aiChatCog.triggerAmbientTest(message);
        if (!result?.ok) {
            return message.reply(result?.reason || 'Ambient AI test failed.');
        }

        return message.reply('✅ Ambient conversation test queued for this channel.');
    }

    if (command === 'level') {
        return levelingCog.handleLevelCommand(message, args, canManageFeatures);
    }

    if (command === 'leveling') {
        return levelingCog.handleLevelingCommand(message, args, canManageFeatures);
    }

    if (command === 'xp') {
        return levelingCog.handleXpCommand(message, args, canManageFeatures);
    }

    if (['generate', 'imagine', 'draw'].includes(command)) {
        if (!hasComfyGenerate) {
            return replyUnavailableFeature('Image generation');
        }

        const handledGenerateCommand = await comfyCog.handleGenerateCommand(message, args);
        if (handledGenerateCommand) return;
    }

    if (GAME_SHORTCUT_COMMANDS.has(command)) {
        const handledGameCommand = await handleGamesCommand({
            message,
            command,
            args,
            config,
            client,
            guildFeatureState,
            canManageFeatures,
            saveFeatureState
        });

        if (handledGameCommand) return;
    }

    if (command === 'embed' || (command === 'send' && args[0]?.toLowerCase() === 'embed')) {
        if (!(isDev || isOperator || isAdmin)) {
            return message.reply("⛔ Access Denied. Administrators or trusted bot staff only.");
        }

        if (!message.guild) {
            return message.reply('`abc.embed` can only be used inside a server.');
        }

        return embedBuilderCog.openBuilderFromMessage(message, { config, allowedDevs });
    }

    // --- TIER 3: STANDARD COMMANDS (Master + Operator + Allowed Devs) ---
    // Trusted bot staff can run these.
    if (isDev || isOperator || isAllowedGuild) {
        if (command === 'socials') {
            if (!hasSocialsCommands) {
                return replyUnavailableFeature('Social monitors');
            }

            return socialsCog.handleSocialsCommand(message, args);
        }

         if (command === 'unlog') { return loggerCog.handleUnlogCommand(message, args); } if (command === 'log') {
            return loggerCog.handleLogCommand(message, args);
        }

        if (command === 'send' || command === 'reply') {
            let targetArg = args.shift()?.replace(/[<#>]/g, '');
            const msgContent = args.join(' ');
            if (!targetArg || !msgContent) return message.reply(command === 'send' ? getUsageText('send') : getUsageText('reply'));

            let replyMsgId = null;
            if (command === 'reply' && targetArg.includes('-')) {
                const parts = targetArg.split('-');
                targetArg = parts[0];
                replyMsgId = parts[1];
            }

            const { channel: resolvedCh, msg: resolvedMsg } = await resolveChannel(message.guild, targetArg, message.channel);
            if (!resolvedCh) return message.reply("I couldn't locate that channel or message.");

            try {
                if (command === 'send') {
                    await resolvedCh.send(msgContent);
                    return message.reply(`✅ Message sent to ${resolvedCh}.`);
                } else {
                    const targetMsg = replyMsgId ? await resolvedCh.messages.fetch(replyMsgId).catch(() => null) : resolvedMsg;
                    if (!targetMsg) return message.reply("Message to reply to could not be found.");
                    await targetMsg.reply(msgContent);
                    return message.reply(`✅ Replied to message in ${resolvedCh}.`);
                }
            } catch (e) {
                return message.reply(`Failed to send/reply: ${e.message}`);
            }
        }

        if (command === 'help') {
            const topic = normalizeHelpTopic(args[0]);
            if (topic && COMMAND_USAGE[topic]) {
                return message.reply(getUsageText(topic));
            }

            return message.reply({ embeds: [buildHelpEmbed()] });
        }

        if (command === 'undo') {
            const history = client.undoHistory?.get(message.guild.id);
            if (!history || history.type !== 'logger_setup' || !history.channels || history.channels.length === 0) {
                return message.reply({ content: "❌ No valid kitbot setup operations found to undo." });
            }
            
            const msg = await message.reply("🔄 Undoing recent setup operation, reverting channels...");
            let deleted = 0;
            for (const chId of history.channels) {
                const channel = message.guild.channels.cache.get(chId);
                if (channel) {
                    await channel.delete().catch(() => {});
                    deleted++;
                }
            }
            
            client.undoHistory.delete(message.guild.id);
            return msg.edit(`✅ Undo successful. Safely deleted **${deleted}** recently generated channels.`);
        }

        if (command === 'delete') {
            if (!args.length) return message.reply("Usage: `abc.delete <ID> ...` (ID can be a channel, category, or message ID created by the bot)");
            
            const targetIds = args.map(arg => arg.replace(/[<#>]/g, ''));
            const msg = await message.reply("🗑️ Verifying and processing deletion targets...");
            
            let deletedCount = 0;
            const { AuditLogEvent } = require('discord.js');

            for (const targetId of targetIds) {
                // --- 1. Try treating as a channel/category ---
                const channel = message.guild.channels.cache.get(targetId);
                if (channel) {
                    // Verification: Check Audit Logs to see if the bot created this channel
                    const logs = await message.guild.fetchAuditLogs({ 
                        type: AuditLogEvent.ChannelCreate,
                        limit: 50 // Check recent creations
                    }).catch(() => null);
                    
                    const entry = logs?.entries.find(e => e.targetId === targetId);
                    const isBotCreated = entry?.executorId === client.user.id;
                    
                    // Fallback: Check known bot channel names if audit logs are inconclusive/old
                    const isKnownName = ['💫starboard', 'bot-interaction', 'interactions'].includes(channel.name);

                    if (isBotCreated || isKnownName) {
                        if (channel.type === ChannelType.GuildCategory) {
                            const children = message.guild.channels.cache.filter(c => c.parentId === channel.id);
                            for (const child of children.values()) {
                                await child.delete().catch(() => {});
                                deletedCount++;
                            }
                        }
                        await channel.delete().catch(() => {});
                        deletedCount++;
                        continue;
                    } else {
                        // Skip if we can't confirm the bot created it
                        continue;
                    }
                }

                // --- 2. Try treating as a message ID ---
                let targetMsg = await message.channel.messages.fetch(targetId).catch(() => null);

                // Fallback: Search other channels
                if (!targetMsg) {
                    for (const ch of message.guild.channels.cache.values()) {
                        if (ch.isTextBased() && ch.id !== message.channelId) {
                            targetMsg = await ch.messages.fetch(targetId).catch(() => null);
                            if (targetMsg) break;
                        }
                    }
                }

                if (targetMsg) {
                    // Verification: MUST be sent by the bot
                    if (targetMsg.author.id === client.user.id) {
                        await targetMsg.delete().catch(() => {});
                        deletedCount++;
                    }
                }
            }
            
            if (deletedCount === 0) return msg.edit("No bot-created targets (messages or channels) were found matching those IDs.");
            return msg.edit(`✅ Successfully deleted **${deletedCount}** bot-created target(s).`);
        }

        if (command === 'config') {
            if (!hasSocialsConfig) {
                return replyUnavailableFeature('Social monitor configuration');
            }

            return socialsCog.handleConfigCommand(message, args);
        }
        
        if (command === 'ping') {
            return message.reply(`Pong! Ping = \`${client.ws.ping} ms\`, Master is <@${config.master_id}>, Operator is <@${config.operator_id}>.`);
        }
        
        if (command === 'starboard') {
            return client.cogs.starboard.handleStarboardCommand(message, args, canManageFeatures);
        }
        // Add more standard bot commands here...
        return message.reply('Unknown command.\nUse `abc.help` to view all command usage.');
    } else {
        return; 
    }
}

module.exports = handleMessageCreate;
module.exports.__testables = {
    shouldSendLinkGifReply
};
