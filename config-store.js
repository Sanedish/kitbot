const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function readConfigFromDisk() {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function syncConfig(target, source) {
    for (const key of Object.keys(target)) {
        if (!(key in source)) {
            delete target[key];
        }
    }

    Object.assign(target, source);
    return target;
}

const config = readConfigFromDisk();

function getConfig() {
    try {
        return syncConfig(config, readConfigFromDisk());
    } catch (error) {
        console.error(`[CONFIG] Failed to reload config: ${error.message}`);
        return config;
    }
}

function saveConfig(nextConfig) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2));
    return syncConfig(config, nextConfig);
}

module.exports = {
    CONFIG_FILE,
    config,
    getConfig,
    saveConfig
};
