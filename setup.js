#!/usr/bin/env node
// Interactive first-run setup: writes .env and config.json from the examples.
// Run with `npm run setup`. Safe to re-run; existing values are offered as defaults.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SNOWFLAKE = /^\d{17,20}$/;

function readEnv(file) {
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .map(line => line.match(/^([A-Za-z_][\w-]*)=(.*)$/))
        .filter(Boolean)
        .map(m => [m[1], m[2]]));
}

// Fill KEY= lines in the template, keep comments and order.
function renderEnv(template, values) {
    return template.split(/\r?\n/).map(line => {
        const m = line.match(/^([A-Za-z_][\w-]*)=/);
        return m && values[m[1]] !== undefined ? `${m[1]}=${values[m[1]]}` : line;
    }).join('\n');
}

// The first token segment is the bot's user id in base64.
function appIdFromToken(token) {
    try {
        const id = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
        return SNOWFLAKE.test(id) ? id : null;
    } catch {
        return null;
    }
}

async function main() {
    // Line iterator instead of rl.question so piped answers are buffered, not dropped.
    const rl = readline.createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (question, fallback = '', check = null) => {
        for (;;) {
            const hint = fallback ? ` [${fallback.length > 24 ? fallback.slice(0, 6) + '…' : fallback}]` : '';
            process.stdout.write(`${question}${hint}: `);
            const { value, done } = await lines.next();
            const answer = (done ? '' : value).trim() || fallback;
            if (!check || check(answer)) return answer;
            if (done) throw new Error('\nInput ended before setup finished.');
            console.log('  That does not look right, try again.');
        }
    };
    const isId = v => SNOWFLAKE.test(v);
    const optionalId = v => v === '' || SNOWFLAKE.test(v);

    console.log('\nkitbot setup');
    console.log('Enable Developer Mode in Discord to copy IDs: Settings > Advanced.\n');

    const env = { ...readEnv(path.join(ROOT, '.env.example')), ...readEnv(ENV_FILE) };
    const config = JSON.parse(fs.readFileSync(fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : path.join(ROOT, 'config.example.json'), 'utf8'));
    const keep = v => (isId(String(v || '')) ? v : '');

    env.DISCORD_TOKEN = await ask('Bot token', env.DISCORD_TOKEN, v => v.split('.').length === 3);
    config.master_id = await ask('Your Discord user ID', keep(config.master_id), isId);
    config.operator_guild_id = await ask('Main server ID', keep(config.operator_guild_id), isId);
    config.staff_guild_id = await ask('Staff server ID, blank for the main server', keep(config.staff_guild_id), optionalId) || config.operator_guild_id;
    config.prefix = await ask('Staff command prefix', config.prefix || 'abc.');

    if ((await ask('Set up modmail now? y/n', 'n')).toLowerCase().startsWith('y')) {
        const category = config.modmail.categories[0];
        config.modmail.guild_id = config.staff_guild_id;
        category.forum_channel_id = await ask('Modmail forum channel ID', keep(category.forum_channel_id), isId);
        config.modmail.default_support_role_id = await ask('Support role ID to ping', keep(config.modmail.default_support_role_id), isId);
        category.tags[0].id = await ask('Forum tag ID for new tickets', keep(category.tags[0].id), isId);
        config.toggle_mod_mail = true;
    }
    rl.close();

    fs.writeFileSync(ENV_FILE, renderEnv(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), env));
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
    for (const dir of ['data/developers', 'media']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });

    const appId = appIdFromToken(env.DISCORD_TOKEN);
    console.log('\nWrote .env and config.json.\n');
    console.log('Next:');
    console.log('  1. Developer Portal > Bot: enable Server Members and Message Content intents.');
    if (appId) console.log(`  2. Invite: https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=8`);
    console.log(`  ${appId ? 3 : 2}. Start: npm start\n`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { readEnv, renderEnv, appIdFromToken };
