// Run with `npm test`. Covers the setup helpers that write .env.
'use strict';

const assert = require('assert');
const { renderEnv, appIdFromToken } = require('../setup');

const template = '# comment\nDISCORD_TOKEN=\nMUSIC_DIR=./music\nEMPTY=';
assert.strictEqual(
    renderEnv(template, { DISCORD_TOKEN: 'abc.def.ghi', MUSIC_DIR: '/srv/music' }),
    '# comment\nDISCORD_TOKEN=abc.def.ghi\nMUSIC_DIR=/srv/music\nEMPTY='
);

const id = '123456789012345678';
const fakeToken = `${Buffer.from(id).toString('base64')}.xxxxxx.yyyyyyyy`;
assert.strictEqual(appIdFromToken(fakeToken), id);
assert.strictEqual(appIdFromToken('not-a-token'), null);

console.log('setup tests passed');
