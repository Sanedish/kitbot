'use strict';

// LogStore - durable, file-backed mirror of everything the LoggerCog emits.
//
// Layout (all inside the bot dir, per requirement):
//   data/logs/<channelId>/dd-mm-yyyy.jsonl   one JSON record per line
//
// It taps LoggerCog.logEvent (the single choke point through which every one of
// the 61 event types is sent) and appends a compact structured record for the
// channel the event was routed to. The dashboard reads these files directly
// (raw + pretty), so logs survive even if someone deletes the Discord messages.
//
// Tamper mitigation: reconcile() diffs the file against the live Discord channel
// - it backfills a missing day file from the channel, and flags file records
// that no longer have a matching message in the channel (likely deleted).
//
// NOTE: exact message-id matching needs LoggerCog.logEvent to return the sent
// message; until that one-line change lands, reconcile() matches on a content
// fingerprint within a time window, which is a strong-but-heuristic signal.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { EVENT_CATEGORY } = require('./logger');
const { cacheAvatar } = require('./avatar-cache');

const LOGS_ROOT = path.join(__dirname, '..', 'data', 'logs');
const IMAGE_DIR = path.join(LOGS_ROOT, 'images');
const AVATAR_DIR = path.join(LOGS_ROOT, 'avatars');
const MAX_DESC = 4000;
// The central staff server whose log channels the dashboard mirrors 1-to-1.
const STAFF_GUILD = process.env.STAFF_SERVER || require('../config-store').config.staff_guild_id;

class LogStore {
    constructor(client) {
        this.client = client;
        this.root = LOGS_ROOT;
        this._origLogEvent = null;
        this._logger = null;
        fs.mkdirSync(this.root, { recursive: true });
    }

    /** Wrap LoggerCog.logEvent so every emitted log is also written to disk. */
    attach(loggerCog) {
        if (!loggerCog || typeof loggerCog.logEvent !== 'function') return;
        this._logger = loggerCog;
        const orig = loggerCog.logEvent.bind(loggerCog);
        this._origLogEvent = orig;
        const self = this;
        loggerCog.logEvent = async function (eventKey, title, description, color, options = {}) {
            try {
                // Mirror into the staff server's dedicated channel for this event
                // (the exact channel the bot sends to, read from the logger config).
                const channelId = self._staffChannelFor(loggerCog, eventKey);
                if (channelId) {
                    let savedImage = null;
                    let savedThumbnail = null;
                    let savedAuthorIcon = null;
                    const savedFiles = [];

                    async function downloadUrl(url, dir, prefix) {
                        if (!url) return null;
                        const ext = url.split('?')[0].split('.').pop().toLowerCase() || 'png';
                        const safeExt = ['png','jpg','jpeg','gif','webp'].includes(ext) ? ext : 'png';
                        const filename = `${prefix}_${crypto.randomBytes(8).toString('hex')}.${safeExt}`;
                        const filepath = path.join(dir, filename);
                        try {
                            const res = await fetch(url);
                            if (res.ok) {
                                const buffer = await res.arrayBuffer();
                                await fsp.writeFile(filepath, Buffer.from(buffer));
                                return filename;
                            }
                        } catch(e) {}
                        return null;
                    }

                    if (options.authorIcon) {
                        // Pull each user's avatar ONCE, keyed by uid (see avatar-cache.js).
                        const file = await cacheAvatar(options.authorIcon);
                        if (file) savedAuthorIcon = file;
                    }
                    if (options.image) {
                        const file = await downloadUrl(options.image, IMAGE_DIR, 'image');
                        if (file) savedImage = file;
                    }
                    if (options.thumbnail) {
                        const file = await downloadUrl(options.thumbnail, IMAGE_DIR, 'thumb');
                        if (file) savedThumbnail = file;
                    }
                    
                    if (options.files) {
                        for (const f of options.files) {
                            if (!f) continue;
                            const buffer = f.attachment || f;
                            if (Buffer.isBuffer(buffer)) {
                                const name = f.name || `file_${crypto.randomBytes(8).toString('hex')}.png`;
                                const isSpoiler = name.startsWith('SPOILER_');
                                const safeName = `${crypto.randomBytes(4).toString('hex')}_${name.replace(/[^a-zA-Z0-9_.-]/g, '')}`;
                                const filepath = path.join(IMAGE_DIR, safeName);
                                await fsp.writeFile(filepath, buffer);
                                savedFiles.push({ name, url: safeName, isSpoiler });
                            }
                        }
                    }

                    const rec = self.record({
                        guildId: STAFF_GUILD, originGuildId: options.guildId || options.guild?.id || null,
                        channelId, eventKey, title, description,
                        authorName: options.authorName, footerText: options.footerText,
                        authorIcon: savedAuthorIcon,
                        image: savedImage,
                        thumbnail: savedThumbnail,
                        files: savedFiles,
                        source: 'logger'
                    });
                    // Live-push to the dashboard (same choke point that writes the file).
                    self.client.emit('log:record', rec);
                }
            } catch (e) {
                console.error(`[LOG-STORE] capture failed for ${eventKey}: ${e.message}`);
            }
            return orig(eventKey, title, description, color, options);
        };
    }

    /** The staff guild's channel for an event: its mapped channel, else the sync fallback. */
    _staffChannelFor(loggerCog, eventKey) {
        if (typeof loggerCog.getGuildConfig !== 'function') return null;
        const conf = loggerCog.getGuildConfig(STAFF_GUILD);
        const evt = conf?.events?.[eventKey];
        return (evt && evt.channel_id) || conf?.sync_channel_id || null;
    }

    // ── Writing ───────────────────────────────────────────────────────────────
    record(entry) {
        const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
        const rec = {
            ts,
            id: entry.id || shortId(),
            guildId: entry.guildId || null,
            originGuildId: entry.originGuildId || null,
            channelId: entry.channelId,
            eventKey: entry.eventKey || 'unknown',
            category: EVENT_CATEGORY[entry.eventKey] || 'other', // Discord log-channel grouping
            title: clip(entry.title, 256),
            description: clip(stripMd(entry.description), MAX_DESC),
            authorName: entry.authorName || null,
            authorIcon: entry.authorIcon || null,
            footerText: entry.footerText || null,
            image: entry.image || null,
            thumbnail: entry.thumbnail || null,
            files: entry.files || [],
            source: entry.source || 'logger',
            fp: fingerprint(entry.title, entry.description),
            messageId: entry.messageId || null
        };
        const file = this._fileFor(rec.channelId, new Date(ts));
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, JSON.stringify(rec) + '\n');
        } catch (e) {
            console.error(`[LOG-STORE] append failed (${rec.channelId}): ${e.message}`);
        }
        return rec;
    }

    _fileFor(channelId, date) {
        return path.join(this.root, String(channelId), `${dayStamp(date)}.jsonl`);
    }

    // ── Reading ───────────────────────────────────────────────────────────────
    async listChannels() {
        const out = [];
        let dirs;
        try { dirs = await fsp.readdir(this.root, { withFileTypes: true }); }
        catch { return out; }
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            // Log-channel dirs are Discord snowflakes; skip the logger's asset
            // dirs (images/, avatars/) and anything else non-numeric.
            if (!/^\d{15,21}$/.test(d.name)) continue;
            const channelId = d.name;
            const ch = this.client.channels.cache.get(channelId);
            const days = await this.listDays(channelId);
            out.push({
                channelId,
                name: ch?.name || null,
                guildId: ch?.guild?.id || null,
                days: days.length,
                latest: days[0] || null
            });
        }
        return out;
    }

    async listDays(channelId) {
        try {
            const files = await fsp.readdir(path.join(this.root, String(channelId)));
            return files.filter(f => f.endsWith('.jsonl'))
                .map(f => f.replace('.jsonl', ''))
                .sort((a, b) => stampToTs(b) - stampToTs(a));
        } catch { return []; }
    }

    async readDay(channelId, date, options = {}) {
        const file = path.join(this.root, String(channelId), `${date}.jsonl`);
        let raw;
        try { raw = await fsp.readFile(file, 'utf8'); }
        catch { return options.pretty ? '' : []; }
        let records = raw.split('\n').filter(Boolean).map(safeParse).filter(Boolean);

        if (options.user) {
            const u = options.user.toLowerCase();
            records = records.filter(r => (r.description && r.description.toLowerCase().includes(`<@${u}>`)) || (r.authorName && r.authorName.toLowerCase().includes(u)));
        }
        if (options.search) {
            const s = options.search.toLowerCase();
            records = records.filter(r => 
                (r.eventKey && r.eventKey.toLowerCase().includes(s)) || 
                (r.title && r.title.toLowerCase().includes(s)) || 
                (r.description && r.description.toLowerCase().includes(s))
            );
        }
        if (options.endTime || options.startTime) {
            records = records.filter(r => {
                const d = new Date(r.ts);
                const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                if (options.startTime && timeStr < options.startTime) return false;
                if (options.endTime && timeStr > options.endTime) return false;
                return true;
            });
        }
        
        if (options.guild) {
            records = records.filter(r => r.originGuildId === options.guild);
        }

        if (!options.pretty) {
            records.forEach(r => {
                if (r.originGuildId) {
                    const g = this.client.guilds.cache.get(r.originGuildId);
                    if (g) r.originGuildName = g.name;
                }
                if (r.description) {
                    const match = r.description.match(/<@!?(\d+)>/);
                    if (match) {
                        const user = this.client.users.cache.get(match[1]);
                        if (user) {
                            r.targetIcon = user.displayAvatarURL({ dynamic: true });
                            r.targetName = user.username || user.tag;
                        }
                    }
                }
            });
            return records;
        }
        return records.map(r => prettyLine(r, this.client)).join('\n');
    }

    /** Every day for which any channel has a log file, newest first. */
    async listDates() {
        const set = new Set();
        for (const { channelId } of await this.listChannels()) {
            for (const d of await this.listDays(channelId)) set.add(d);
        }
        return [...set].sort((a, b) => stampToTs(b) - stampToTs(a));
    }

    // ── Reconciliation (tamper check + backfill) ──────────────────────────────
    /**
     * Diff today's (or a given date's) file against the live Discord channel.
     * - Missing file → rebuilt from the channel.
     * - File records with no matching live message → flagged (likely deleted).
     * Returns { channelId, date, fileCount, channelCount, backfilled, suspicious[] }.
     */
    async reconcile(guildId, channelId, date = dayStamp(new Date()), { fetchLimit = 100 } = {}) {
        const channel = this.client.channels.cache.get(channelId)
            || await this.client.channels.fetch(channelId).catch(() => null);
        const report = { channelId, date, fileCount: 0, channelCount: 0, backfilled: 0, suspicious: [] };
        if (!channel || typeof channel.messages?.fetch !== 'function') {
            report.error = 'Channel not accessible.';
            return report;
        }

        const dayStart = stampToTs(date);
        const dayEnd = dayStart + 86400_000;

        const fetched = await channel.messages.fetch({ limit: fetchLimit }).catch(() => null);
        const liveForDay = fetched
            ? [...fetched.values()].filter(m => m.createdTimestamp >= dayStart && m.createdTimestamp < dayEnd)
            : [];
        report.channelCount = liveForDay.length;

        const file = path.join(this.root, String(channelId), `${date}.jsonl`);
        const exists = fs.existsSync(file);

        if (!exists) {
            // Backfill the whole day from the channel.
            for (const m of liveForDay.sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
                const { title, description } = extractEmbed(m);
                this.record({
                    guildId, channelId, ts: m.createdTimestamp, title, description,
                    eventKey: 'backfill', source: 'backfill', messageId: m.id
                });
                report.backfilled++;
            }
            report.fileCount = report.backfilled;
            return report;
        }

        const records = (await this.readDay(channelId, date));
        report.fileCount = records.length;

        // Fingerprint the live messages; any file record whose fingerprint is
        // absent from the channel is suspicious (deleted/edited after logging).
        const liveFps = new Set(liveForDay.map(m => {
            const { title, description } = extractEmbed(m);
            return fingerprint(title, description);
        }));
        for (const r of records) {
            if (!r.fp) continue;
            if (!liveFps.has(r.fp)) {
                report.suspicious.push({ id: r.id, ts: r.ts, eventKey: r.eventKey, title: r.title });
            }
        }
        // Only treat as real tampering signal if we actually fetched the day's
        // tail (i.e. the oldest fetched message is older than the day start).
        report.fetchCoveredDay = liveForDay.length < fetchLimit;
        return report;
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
function dayStamp(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function stampToTs(stamp) {
    const [dd, mm, yyyy] = String(stamp).split('-').map(Number);
    return new Date(yyyy, (mm || 1) - 1, dd || 1).getTime();
}

function prettyLine(r, client) {
    const t = new Date(r.ts);
    const p = n => String(n).padStart(2, '0');
    const timestamp = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    
    const key = String(r.eventKey || '').toUpperCase();
    let serverLine = '';
    if (r.originGuildId && client) {
        const g = client.guilds.cache.get(r.originGuildId);
        if (g) serverLine = `\nServer:      ${g.name}`;
    }
    const head = r.title ? `\nTitle:       ${r.title}` : '';
    
    let desc = '';
    if (r.description) {
        let text = r.description.trim();
        
        if (client) {
            text = text.replace(/<@!?(\d+)>/g, (match, id) => {
                const user = client.users.cache.get(id);
                return user ? `<@${id}> [@${user.username || user.tag}]` : match;
            });
            text = text.replace(/<#(\d+)>/g, (match, id) => {
                const channel = client.channels.cache.get(id);
                return channel ? `<#${id}> [#${channel.name}]` : match;
            });
        }
        
        text = text.replace(/\s+(Channel:|Content:|Reason:|Action:|Message:|Before:|After:|User:)/g, '\n$1');
        
        const contentMatch = text.match(/Content:\s*([\s\S]+)$/);
        if (contentMatch) {
            text = text.replace(contentMatch[0], `Content: \`\`\`\n${contentMatch[1].trim()}\n\`\`\``);
        }
        
        if (/^(User|Channel|Content|Reason|Action|Message|Before|After):/.test(text.trim())) {
            desc = `\n${text.trim()}`;
        } else {
            desc = `\nDescription: ${text.replace(/\n+/g, ' ')}`;
        }
    }

    return `--- [ ${timestamp} ] ---\nEvent: ${key}${head}${desc}\n`;
}

function stripMd(s) {
    if (!s) return s;
    return String(s).replace(/\*\*/g, '').replace(/`/g, '');
}

function clip(s, n) {
    if (!s) return s || null;
    const str = String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
}

function fingerprint(title, description) {
    const basis = `${stripMd(title) || ''}|${(stripMd(description) || '').replace(/\s+/g, ' ').trim().slice(0, 160)}`;
    return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

function extractEmbed(message) {
    const embed = message.embeds?.[0];
    if (!embed) return { title: null, description: message.content || null };
    const data = embed.data || embed;
    let title = data.title || null;
    let description = data.description || null;
    // 'synct' default style packs the title as the first **bold** line of desc.
    if (!title && description) {
        const m = description.match(/^\*\*(.+?)\*\*/);
        if (m) title = m[1];
    }
    return { title, description };
}

function safeParse(line) { try { return JSON.parse(line); } catch { return null; } }
function shortId() { return crypto.randomBytes(5).toString('hex'); }

module.exports = { LogStore };
