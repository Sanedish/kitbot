'use strict';

// ModDashboardCog - staff moderation dashboard.
//
// Serves an enterprise-plain web UI (web-mod/) plus a JSON API over the
// moderation engine, case store, and log store:
//   /                 static dashboard (web-mod/)
//   /api/login        name + password, HMAC-signed cookie (see auth model below)
//   /api/staff        root-only staff access control, backed by PocketBase
//   /api/*            everything else - requires an authenticated session
//   /ws               live push of newly recorded cases AND logger events
//
// Auth model (see data/staff-access.json + cogs/pb.js):
//   • Root accounts live ONLY in data/staff-access.json on
//     disk - untouchable from PocketBase or the UI. Full access incl. /api/staff.
//   • Staff use one shared password + an `active` row in the PocketBase `staff`
//     collection. Roots add/lock/remove staff; a lock drops a live session ~30s.
//
// No anonymous tier: every endpoint except login + static assets requires the
// session. Bind to MOD_DASH_HOST (default 127.0.0.1) and reach it over
// Tailscale; no public exposure needed.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ChannelType } = require('discord.js');
const { EVENT_CATEGORY, LOG_CATEGORIES } = require('./logger');

// Announcement channels (and their threads) are off-limits to the dashboard -
// no accidental @everyone-grade posts from a mod tool. Blocked for everyone.
const ANNOUNCEMENT_TYPES = new Set([ChannelType.GuildAnnouncement, ChannelType.AnnouncementThread]);

// Pending bot-DM requests from staff await a root's approval before they send.
const DM_APPROVALS_PATH = path.join(__dirname, '..', 'data', 'dm-approvals.json');

// The staff server whose log channels the dashboard mirrors 1-to-1.
const STAFF_GUILD = process.env.STAFF_SERVER || require('../config-store').config.staff_guild_id;
const CATEGORY_LABEL = {
    'server-logs': 'Server', 'member-logs': 'Members', 'mod-logs': 'Mod',
    'voice-logs': 'Voice', 'message-logs': 'Messages', other: 'Other'
};

const COOKIE_NAME = 'kb_mod_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_POSTS = 60;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

const ACTION_TYPES = new Set(['note', 'warn', 'timeout', 'untimeout', 'kick', 'softban', 'ban', 'tempban', 'unban']);

class ModDashboardCog {
    constructor({ client, moderation, store, logStore, pb }) {
        this.client = client;
        this.moderation = moderation;
        this.store = store;
        this.logStore = logStore;
        this.pb = pb;
        this.port = Number(process.env.MOD_DASH_PORT) || 8781;
        this.host = process.env.MOD_DASH_HOST || '127.0.0.1';
        this.accessPath = path.join(__dirname, '..', 'data', 'staff-access.json');
        this.access = loadAccess(); // { roots: { name: password }, staffPassword } - filesystem-only
        this.secret = deriveSecret(this.access);
        this.pendingDms = loadPendingDms(); // staff bot-DMs awaiting root approval
        this.server = null;
        this.wss = null;
        this.rateBuckets = new Map();
        this.loginBuckets = new Map();
        this._activeCache = new Map(); // name -> { active, exp } : keeps staff lockout near-immediate
    }

    start() {
        if (this.server) return;
        if (!this.access || !this.access.staffPassword || !Object.keys(this.access.roots).length) {
            console.warn('[MOD-DASH] data/staff-access.json is missing or empty - the moderation dashboard is DISABLED.');
            return;
        }
        const app = express();
        app.disable('x-powered-by');
        app.use(express.json({ limit: '256kb' }));
        app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Referrer-Policy', 'no-referrer');
            req.actor = this._readSession(req);
            next();
        });

        // ── Auth ────────────────────────────────────────────────────────────
        // Root logins live ONLY in data/staff-access.json (filesystem). Staff use
        // one shared password + an active row in PocketBase, which roots manage.
        app.post('/api/login', async (req, res) => {
            if (!this._allow(this.loginBuckets, this._ip(req), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
                return res.status(429).json({ error: '429 Too Many Requests' });
            }
            const name = String(req.body?.name || '').trim().slice(0, 64);
            const actor = await this._authenticate(name, String(req.body?.password || ''));
            if (!actor) return res.status(403).json({ error: 'Wrong credentials or the account is locked, try again. Contact staff if persistant.' });
            this._writeSession(res, actor);
            res.json({ actor });
        });
        app.post('/api/logout', (req, res) => {
            this._clearCookie(res);
            res.json({ ok: true });
        });
        app.get('/api/me', (req, res) => res.json({ actor: req.actor || null }));

        // Everything below requires a session. Staff sessions also re-check the
        // PocketBase active flag (cached ~30s) so lockouts bite a live session.
        const auth = async (req, res, next) => {
            const a = req.actor;
            if (!a?.admin) return res.status(401).json({ error: 'Not authenticated.' });
            if (!a.root && !(await this._staffStillActive(a.name))) {
                this._clearCookie(res);
                return res.status(401).json({ error: 'Account locked.' });
            }
            next();
        };
        const rootOnly = (req, res, next) => {
            if (!req.actor?.root) return res.status(403).json({ error: 'Root accounts only.' });
            next();
        };
        const limited = this._postLimiter();

        // ── Staff access control (root only) - backed by PocketBase ──────────
        app.get('/api/staff', auth, rootOnly, async (req, res) => {
            try { res.json({ staff: await this.pb.listStaff() }); }
            catch (e) { res.status(502).json({ error: `PocketBase: ${e.message}` }); }
        });
        app.post('/api/staff', auth, rootOnly, limited, async (req, res) => {
            try { const r = await this.pb.addStaff(String(req.body?.username || '').trim(), req.body?.note || ''); res.json({ ok: true, id: r.id }); }
            catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.patch('/api/staff/:id', auth, rootOnly, limited, async (req, res) => {
            try { await this.pb.setActive(req.params.id, Boolean(req.body?.active)); this._activeCache.clear(); res.json({ ok: true }); }
            catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.delete('/api/staff/:id', auth, rootOnly, limited, async (req, res) => {
            try { await this.pb.deleteStaff(req.params.id); this._activeCache.clear(); res.json({ ok: true }); }
            catch (e) { res.status(400).json({ error: e.message }); }
        });
        app.put('/api/staff/password', auth, limited, async (req, res) => {
            try {
                const targetUser = String(req.body?.targetUser || '').trim();
                const oldPassword = String(req.body?.oldPassword || '');
                const newPassword = String(req.body?.newPassword || '');
                
                if (!targetUser || !newPassword) return res.status(400).json({ error: 'Target user and new password are required.' });
                
                const isSelf = targetUser.toLowerCase() === req.actor.name.toLowerCase();
                const isRoot = req.actor.root;
                
                if (!isSelf && !isRoot) {
                    return res.status(403).json({ error: 'You can only change your own password.' });
                }

                if (isSelf) {
                    if (!oldPassword) return res.status(400).json({ error: 'Old password is required to change your own password.' });
                    const authRes = await this._authenticate(targetUser, oldPassword);
                    if (!authRes) return res.status(403).json({ error: 'Incorrect old password.' });
                }

                const targetRootKey = Object.keys(this.access.roots).find(k => k.toLowerCase() === targetUser.toLowerCase());
                if (targetRootKey) {
                    if (!isSelf) return res.status(403).json({ error: 'Roots can only change their own password.' });
                    this.access.roots[targetRootKey] = newPassword;
                    fs.writeFileSync(this.accessPath, JSON.stringify(this.access, null, 2));
                    return res.json({ ok: true });
                }

                let staffUser = await this.pb.getStaff(targetUser);
                if (!staffUser) return res.status(404).json({ error: 'Staff user not found.' });
                
                await this.pb.updateStaffPassword(staffUser.id, hashPassword(newPassword));
                res.json({ ok: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ── Guilds / context ────────────────────────────────────────────────
        app.get('/api/guilds', auth, (req, res) => {
            const guilds = [...this.client.guilds.cache.values()].map(g => ({
                id: g.id, name: g.name, members: g.memberCount, icon: g.iconURL?.({ size: 64 }) || null
            }));
            res.json({ guilds });
        });

        // ── Stats ───────────────────────────────────────────────────────────
        app.get('/api/stats', auth, (req, res) => {
            res.json(this.store.getStats(req.query.guild || undefined));
        });

        // ── Cases ───────────────────────────────────────────────────────────
        app.get('/api/cases', auth, (req, res) => {
            const q = req.query;
            const filter = {
                guildId: q.guild || undefined,
                targetId: q.user || undefined,
                moderatorId: q.moderator || undefined,
                type: q.type || undefined,
                source: q.source || undefined,
                active: q.active === undefined ? undefined : q.active === 'true',
                since: q.since ? Number(q.since) : undefined,
                until: q.until ? Number(q.until) : undefined,
                search: q.search || undefined,
                limit: clampInt(q.limit, 50, 1, 200),
                offset: clampInt(q.offset, 0, 0, 1e9)
            };
            res.json(this.store.listCases(filter));
        });

        app.patch('/api/cases/:id', auth, limited, (req, res) => {
            const patch = {};
            if (typeof req.body?.reason === 'string') patch.reason = req.body.reason;
            if (Number.isFinite(req.body?.points)) patch.points = req.body.points;
            if (typeof req.body?.active === 'boolean') patch.active = req.body.active;
            const updated = this.store.updateCase(req.params.id, patch);
            if (!updated) return res.status(404).json({ error: 'Case not found.' });
            res.json({ case: updated });
        });

        app.delete('/api/cases/:id', auth, limited, (req, res) => {
            const ok = this.store.deleteCase(req.params.id);
            if (!ok) return res.status(404).json({ error: 'Case not found.' });
            res.json({ ok: true });
        });

        // ── Member profile ──────────────────────────────────────────────────
        app.get('/api/member', auth, async (req, res) => {
            const guildId = String(req.query.guild || '');
            const userId = String(req.query.user || '');
            if (!guildId || !userId) return res.status(400).json({ error: 'guild and user are required.' });
            res.json(await this.moderation.getMemberProfile(guildId, userId));
        });

        // Best-effort member search by name/id within a guild (for the pickers).
        app.get('/api/member/search', auth, async (req, res) => {
            const guild = this.client.guilds.cache.get(String(req.query.guild || ''));
            const query = String(req.query.q || '').trim();
            if (!guild || !query) return res.json({ results: [] });
            if (/^\d{15,21}$/.test(query)) {
                const m = await guild.members.fetch(query).catch(() => null);
                return res.json({ results: m ? [memberLite(m)] : [] });
            }
            const found = await guild.members.search({ query, limit: 10 }).catch(() => null);
            res.json({ results: found ? [...found.values()].map(memberLite) : [] });
        });

        // Member list for the guild (audit-log style), from the cache so it's cheap.
        // A query hits the live search; otherwise we page through cached members
        // newest-join first. `cached` flags that this is the known subset, not all.
        app.get('/api/members', auth, async (req, res) => {
            const guild = this.client.guilds.cache.get(String(req.query.guild || ''));
            if (!guild) return res.status(400).json({ error: 'Unknown guild.' });
            const q = String(req.query.q || '').trim();
            const offset = clampInt(req.query.offset, 0, 0, 1e6);
            const limit = clampInt(req.query.limit, 50, 1, 100);

            if (q) {
                const found = /^\d{15,21}$/.test(q)
                    ? await guild.members.fetch(q).then(m => [m]).catch(() => [])
                    : [...(await guild.members.search({ query: q, limit: 25 }).catch(() => new Map())).values()];
                const members = found.map(memberRow).sort(byJoinedDesc);
                return res.json({ members, total: members.length, cached: true });
            }
            const all = [...guild.members.cache.values()].map(memberRow).sort(byJoinedDesc);
            res.json({ members: all.slice(offset, offset + limit), total: all.length, cached: guild.members.cache.size < guild.memberCount });
        });

        // ── Enforcement ─────────────────────────────────────────────────────
        app.post('/api/action', auth, limited, async (req, res) => {
            const { guild: guildId, user: userId, type, reason, duration, points, deleteMessageSeconds } = req.body || {};
            if (!ACTION_TYPES.has(type)) return res.status(400).json({ error: 'Unknown action type.' });
            const guild = this.client.guilds.cache.get(String(guildId || ''));
            if (!guild) return res.status(400).json({ error: 'Unknown guild.' });
            if (!/^\d{15,21}$/.test(String(userId || ''))) return res.status(400).json({ error: 'Invalid user id.' });

            const moderator = { id: null, tag: `${req.actor.name} (dashboard)` };
            const base = { guild, targetId: String(userId), moderator, reason: reason ? String(reason).slice(0, 480) : null };
            let result;
            try {
                switch (type) {
                    case 'note': result = await this.moderation.note(base); break;
                    case 'warn': result = await this.moderation.warn({ ...base, points: clampInt(points, 1, 0, 50) }); break;
                    case 'timeout': result = await this.moderation.timeout({ ...base, duration: Number(duration) || 0 }); break;
                    case 'untimeout': result = await this.moderation.removeTimeout(base); break;
                    case 'kick': result = await this.moderation.kick(base); break;
                    case 'softban': result = await this.moderation.softban(base); break;
                    case 'ban': result = await this.moderation.ban({ ...base, deleteMessageSeconds: clampInt(deleteMessageSeconds, 0, 0, 604800) }); break;
                    case 'tempban': result = await this.moderation.tempban({ ...base, duration: Number(duration) || 0 }); break;
                    case 'unban': result = await this.moderation.unban(base); break;
                }
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
            if (!result?.ok) return res.status(400).json({ error: result?.error || 'Action failed.' });
            res.json(result);
        });

        // ── Personal Settings & Uploads ─────────────────────────────────────
        const PERSONAL_SETTINGS_PATH = path.join(__dirname, '..', 'data', 'personal-settings.json');
        function getPersonalSettings() {
            try { return JSON.parse(fs.readFileSync(PERSONAL_SETTINGS_PATH, 'utf8')); }
            catch { return {}; }
        }
        function savePersonalSettings(data) {
            try { fs.writeFileSync(PERSONAL_SETTINGS_PATH, JSON.stringify(data, null, 2)); }
            catch (e) { console.error(`[MOD-DASH] Could not save personal settings: ${e.message}`); }
        }

        app.get('/api/staff/personal', auth, (req, res) => {
            const all = getPersonalSettings();
            res.json(all[req.actor.name] || {});
        });

        app.post('/api/staff/personal', auth, limited, (req, res) => {
            const all = getPersonalSettings();
            all[req.actor.name] = { ...(all[req.actor.name] || {}), ...(req.body || {}) };
            savePersonalSettings(all);
            res.json({ ok: true });
        });

        const multer = require('multer');
        const upload = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 90 * 1024 * 1024 }
        });

        app.post('/api/staff/upload', auth, limited, (req, res, next) => {
            upload.single('file')(req, res, function (err) {
                if (err) {
                    return res.status(400).json({ error: err.message || 'File upload error' });
                }
                next();
            });
        }, async (req, res) => {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
            
            const isPrivate = req.body.private === 'true';
            const canWait = req.body.canWait === 'true';
            
            const maxPublicSize = canWait ? 90 * 1024 * 1024 : 25 * 1024 * 1024;
            const maxPrivateSize = 1 * 1024 * 1024;
            const maxAllowed = isPrivate ? maxPrivateSize : maxPublicSize;
            
            if (req.file.size > maxAllowed) {
                return res.status(400).json({ error: `File too large. Max size is ${Math.round(maxAllowed / 1024 / 1024)}MB.` });
            }

            const safeName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
            const targetDirName = req.actor.name.replace(/[^a-zA-Z0-9.-]/g, '_');
            
            try {
                if (isPrivate) {
                    const privateDir = path.join(__dirname, '..', 'data', 'uploads', targetDirName);
                    fs.mkdirSync(privateDir, { recursive: true });
                    const targetPath = path.join(privateDir, safeName);
                    fs.writeFileSync(targetPath, req.file.buffer);
                    return res.json({ url: `/api/uploads/${targetDirName}/${safeName}` });
                } else {
                    const cdnDir = process.env.UPLOAD_DIR;
                    const publicUrl = process.env.UPLOAD_PUBLIC_URL;
                    if (!cdnDir || !publicUrl) return res.status(503).json({ error: 'Public uploads are not configured.' });
                    try {
                        fs.accessSync(cdnDir, fs.constants.W_OK);
                    } catch (e) {
                        return res.status(500).json({ error: 'CDN Storage is currently unavailable.' });
                    }

                    const userCdnDir = path.join(cdnDir, targetDirName);
                    fs.mkdirSync(userCdnDir, { recursive: true });
                    const targetPath = path.join(userCdnDir, safeName);
                    fs.writeFileSync(targetPath, req.file.buffer);
                    
                    return res.json({ url: `${publicUrl.replace(/\/+$/, '')}/${targetDirName}/${safeName}` });
                }
            } catch (err) {
                console.error('[MOD-DASH] Upload failed:', err);
                return res.status(500).json({ error: 'Failed to process file upload.' });
            }
        });
        
        app.use('/api/uploads', auth, express.static(path.join(__dirname, '..', 'data', 'uploads')));

        // ── Settings ────────────────────────────────────────────────────────
        app.get('/api/settings', auth, (req, res) => res.json(this.store.getSettings(String(req.query.guild || ''))));
        app.put('/api/settings', auth, rootOnly, limited, (req, res) => {
            const guildId = String(req.body?.guild || '');
            if (!guildId) return res.status(400).json({ error: 'guild is required.' });
            const patch = {};
            const b = req.body || {};
            if (typeof b.dmOnPunish === 'boolean') patch.dmOnPunish = b.dmOnPunish;
            if (Number.isFinite(b.warnDecayDays)) patch.warnDecayDays = b.warnDecayDays;
            if (typeof b.wickBotId === 'string') patch.wickBotId = b.wickBotId.trim();
            if (typeof b.modLogChannelId === 'string') patch.modLogChannelId = b.modLogChannelId.trim() || null;
            if (b.escalation && typeof b.escalation === 'object') patch.escalation = b.escalation;
            res.json(this.store.setSettings(guildId, patch));
        });

        // ── Logs ────────────────────────────────────────────────────────────
        // The dashboard mirrors the staff server's log channels 1-to-1. The exact
        // channels are read straight from the logger cog's saved config; each is a
        // channel the bot routes a specific event type to, grouped like Discord.
        app.use('/media', auth, express.static(path.join(__dirname, '..', 'data', 'logs')));
        app.get('/api/logs/layout', auth, (req, res) => res.json(this._logLayout()));
        app.get('/api/logs/dates', auth, async (req, res) => res.json({ dates: await this.logStore.listDates() }));
        app.get('/api/logs/channels', auth, async (req, res) => res.json({ channels: await this.logStore.listChannels() }));
        app.get('/api/logs/days', auth, async (req, res) =>
            res.json({ days: await this.logStore.listDays(String(req.query.channel || '')) }));
        app.get('/api/logs/day', auth, async (req, res) => {
            const channel = String(req.query.channel || '');
            const date = String(req.query.date || '');
            const pretty = req.query.pretty === 'true';
            const { search, user, startTime, endTime, guild } = req.query;
            if (!channel || !date) return res.status(400).json({ error: 'channel and date are required.' });
            const data = await this.logStore.readDay(channel, date, { pretty, search, user, startTime, endTime, guild });
            if (pretty) return res.type('text/plain').send(data);
            res.json({ records: data });
        });
        app.post('/api/logs/reconcile', auth, limited, async (req, res) => {
            const { guild, channel, date } = req.body || {};
            if (!channel) return res.status(400).json({ error: 'channel is required.' });
            res.json(await this.logStore.reconcile(String(guild || ''), String(channel), date || undefined));
        });

        // ── Messaging: DM a member / send embed ─────────────────────────────
        // Access rules:
        //   • Root: may DM members and post to channels (announcement channels are
        //     blocked for everyone - see _resolveSend).
        //   • Staff: may ONLY request bot-DMs to members, and each goes into a
        //     pending queue a root must approve before it sends. No channel posts.
        app.post('/api/message', auth, limited, async (req, res) => {
            const msg = normalizeMessage(req.body || {});
            if (!msg) return res.status(400).json({ error: 'Nothing to send.' });
            const target = String(req.body?.target || '');

            if (!req.actor.root) {
                if (!target.startsWith('dm:')) {
                    return res.status(403).json({ error: 'Staff may only send direct messages to members, and only after a root approves.' });
                }
                const user = await this.client.users.fetch(target.slice(3)).catch(() => null);
                if (!user) return res.status(404).json({ error: 'User not found.' });
                const request = {
                    id: crypto.randomUUID(),
                    fromName: req.actor.name,
                    targetId: user.id, targetTag: user.tag || user.id,
                    msg, createdAt: Date.now()
                };
                this.pendingDms.push(request);
                this._savePendingDms();
                this._broadcast({ type: 'dm-pending', request });
                return res.json({ pending: true });
            }

            const err = await this._resolveSend(target, msg);
            if (err) return res.status(err.code).json({ error: err.error });
            res.json({ ok: true });
        });

        // ── Bot-DM approvals (root only) ─────────────────────────────────────
        app.get('/api/message/pending', auth, rootOnly, (req, res) => {
            res.json({ pending: this.pendingDms });
        });
        app.post('/api/message/pending/:id/approve', auth, rootOnly, limited, async (req, res) => {
            const i = this.pendingDms.findIndex(r => r.id === req.params.id);
            if (i === -1) return res.status(404).json({ error: 'Request not found (already handled?).' });
            const request = this.pendingDms[i];
            // Non-root messages must always name their sender (the requesting staff).
            const err = await this._resolveSend(`dm:${request.targetId}`, withAttribution(request.msg, request.fromName));
            if (err) return res.status(err.code).json({ error: err.error });
            this.pendingDms.splice(i, 1);
            this._savePendingDms();
            this._broadcast({ type: 'dm-resolved', id: request.id });
            res.json({ ok: true });
        });
        app.post('/api/message/pending/:id/reject', auth, rootOnly, limited, (req, res) => {
            const i = this.pendingDms.findIndex(r => r.id === req.params.id);
            if (i === -1) return res.status(404).json({ error: 'Request not found.' });
            this.pendingDms.splice(i, 1);
            this._savePendingDms();
            this._broadcast({ type: 'dm-resolved', id: req.params.id });
            res.json({ ok: true });
        });

        app.use(express.static(path.join(__dirname, '..', 'web-mod'), { index: 'index.html' }));

        this.server = http.createServer(app);
        // Live cases and logs are private: only signed-in staff may subscribe.
        this.wss = new WebSocketServer({ server: this.server, path: '/ws', verifyClient: ({ req }) => Boolean(this._readSession(req)) });
        this.wss.on('error', () => {});
        this.server.on('error', error => {
            console.error(`[MOD-DASH] Server error: ${error.message}`);
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
                console.error(`[MOD-DASH] Port ${this.port} unavailable - dashboard OFF, bot keeps running. Set MOD_DASH_PORT and restart.`);
            }
        });

        // Live-push newly recorded cases (kitbot-issued + ingested Wick/manual).
        this._onCase = record => this._broadcast({ type: 'case', case: record });
        this.client.on('moderation:case', this._onCase);

        // Live-push every logger event the LogStore writes to disk.
        this._onLog = record => this._broadcast({ type: 'log', record });
        this.client.on('log:record', this._onLog);

        this.server.listen(this.port, this.host, () => {
            console.log(`[MOD-DASH] Moderation dashboard listening on http://${this.host}:${this.port}`);
        });
    }

    stop() {
        if (this._onCase) this.client.off('moderation:case', this._onCase);
        if (this._onLog) this.client.off('log:record', this._onLog);
        this.wss?.close();
        this.server?.close();
    }

    // ── Authentication ──────────────────────────────────────────────────────
    async _authenticate(name, password) {
        if (!name || !password) return null;
        // Names are case-insensitive (login ignores capitalisation).
        // Root accounts: filesystem-only, untouchable from PocketBase or the UI.
        const rootKey = Object.keys(this.access.roots).find(k => k.toLowerCase() === name.toLowerCase());
        if (rootKey) {
            return safeEq(password, this.access.roots[rootKey]) ? { id: `root:${rootKey}`, name: rootKey, admin: true, root: true } : null;
        }
        
        let staffUser = null;
        try { staffUser = await this.pb.getStaff(name); }
        catch (e) { console.error(`[MOD-DASH] PocketBase staff check failed: ${e.message}`); return null; }

        if (!staffUser || !staffUser.active) return null;

        let valid = false;
        if (staffUser.passwordHash) {
            valid = verifyPassword(password, staffUser.passwordHash);
        } else if (this.access.staffPassword) {
            valid = safeEq(password, this.access.staffPassword);
            if (valid) {
                try { await this.pb.updateStaffPassword(staffUser.id, hashPassword(password)); }
                catch (e) { console.error(`[MOD-DASH] Auto-migrate password failed for ${name}: ${e.message}`); }
            }
        }
        return valid ? { id: `staff:${staffUser.username}`, name: staffUser.username, admin: true, root: false } : null;
    }

    /** Cached (~30s) PocketBase active check so lockouts hit live staff sessions. */
    async _staffStillActive(name) {
        const now = Date.now();
        const cached = this._activeCache.get(name);
        if (cached && cached.exp > now) return cached.active;
        let active;
        try { active = await this.pb.isActiveStaff(name); }
        catch { active = cached ? cached.active : true; } // tolerate a PB blip; don't lock everyone out
        this._activeCache.set(name, { active, exp: now + 30_000 });
        return active;
    }

    _clearCookie(res) {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    }

    /** Deliver a normalized message to a "dm:<uid>" or channel target. Returns null, or {code,error}. */
    async _resolveSend(target, msg) {
        try {
            if (target.startsWith('dm:')) {
                const user = await this.client.users.fetch(target.slice(3)).catch(() => null);
                if (!user) return { code: 404, error: 'User not found.' };
                await user.send(msg);
            } else {
                const channel = await this.client.channels.fetch(target).catch(() => null);
                if (!channel || typeof channel.send !== 'function') return { code: 404, error: 'Channel not found / not sendable.' };
                if (ANNOUNCEMENT_TYPES.has(channel.type)) return { code: 403, error: 'Announcement channels are off-limits to the dashboard.' };
                await channel.send(msg);
            }
        } catch (e) {
            return { code: 502, error: `Send failed: ${e.message}` };
        }
        return null;
    }

    _savePendingDms() {
        try { fs.writeFileSync(DM_APPROVALS_PATH, JSON.stringify(this.pendingDms, null, 2)); }
        catch (e) { console.error(`[MOD-DASH] Could not persist DM approvals: ${e.message}`); }
    }

    /** The staff server's log channels, straight from the logger cog, grouped like Discord. */
    _logLayout() {
        const logger = this.client.cogs?.logger;
        const out = { guildId: STAFF_GUILD, categories: [] };
        if (!logger || typeof logger.getGuildConfig !== 'function') return out;
        const cfg = logger.getGuildConfig(STAFF_GUILD);
        const groups = {};
        for (const [eventKey, ev] of Object.entries(cfg.events || {})) {
            const channelId = (ev && ev.channel_id) || cfg.sync_channel_id;
            if (!channelId) continue;
            const cat = EVENT_CATEGORY[eventKey] || 'other';
            const name = this.client.channels?.cache?.get(channelId)?.name || null;
            (groups[cat] = groups[cat] || []).push({ eventKey, channelId, name });
        }
        out.categories = [...LOG_CATEGORIES, 'other']
            .filter(c => groups[c])
            .map(c => ({ category: c, label: CATEGORY_LABEL[c] || c, channels: groups[c] }));
        return out;
    }

    _broadcast(payload) {
        if (!this.wss) return;
        const msg = JSON.stringify(payload);
        for (const socket of this.wss.clients) {
            if (socket.readyState === socket.OPEN) socket.send(msg);
        }
    }

    // ── Sessions (HMAC-signed JSON cookie) ──────────────────────────────────
    _sign(payload) { return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url'); }
    _writeSession(res, actor) {
        const payload = Buffer.from(JSON.stringify({ ...actor, iat: Date.now() })).toString('base64url');
        res.setHeader('Set-Cookie',
            `${COOKIE_NAME}=${payload}.${this._sign(payload)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax`);
    }
    _readSession(req) {
        const header = req.headers.cookie || '';
        const raw = header.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE_NAME}=`));
        if (!raw) return null;
        const value = raw.slice(COOKIE_NAME.length + 1);
        const dot = value.lastIndexOf('.');
        if (dot === -1) return null;
        const payload = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        const expected = this._sign(payload);
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
        try {
            const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (!s.iat || Date.now() - s.iat > SESSION_TTL_MS) return null;
            return { id: s.id, name: s.name, admin: Boolean(s.admin), root: Boolean(s.root) };
        } catch { return null; }
    }

    // ── Rate limiting ───────────────────────────────────────────────────────
    _ip(req) { return req.socket.remoteAddress || 'unknown'; }
    _allow(buckets, ip, max, windowMs) {
        const now = Date.now();
        const bucket = (buckets.get(ip) || []).filter(at => now - at < windowMs);
        if (bucket.length >= max) { buckets.set(ip, bucket); return false; }
        bucket.push(now);
        buckets.set(ip, bucket);
        if (buckets.size > 5000) buckets.clear();
        return true;
    }
    _postLimiter() {
        return (req, res, next) => {
            if (!this._allow(this.rateBuckets, this._ip(req), RATE_MAX_POSTS, RATE_WINDOW_MS)) {
                return res.status(429).json({ error: 'Slow down.' });
            }
            next();
        };
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadAccess() {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'staff-access.json'), 'utf8'));
        return { roots: j.roots || {}, staffPassword: j.staffPassword || '' };
    } catch (e) {
        console.error(`[MOD-DASH] Could not read data/staff-access.json: ${e.message}`);
        return null;
    }
}

function loadPendingDms() {
    try {
        const j = JSON.parse(fs.readFileSync(DM_APPROVALS_PATH, 'utf8'));
        return Array.isArray(j) ? j : [];
    } catch { return []; }
}

/** Sanitize a compose payload into Discord send options, or null if empty. */
function normalizeMessage(b) {
    const content = b.content ? String(b.content).slice(0, 2000) : undefined;
    const embeds = b.embed && hasEmbedContent(b.embed) ? [sanitizeEmbed(b.embed)] : undefined;
    const files = Array.isArray(b.attachments)
        ? b.attachments.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 10)
        : undefined;
    if (!content && !embeds && (!files || !files.length)) return null;
    return { content, embeds, files };
}

function attributionLine(name, at = new Date()) {
    const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `(sent by ${name} at ${time})`;
}

// Stamp the sender's name onto a message so non-root bot messages are always
// attributable. Embeds use footer + timestamp; plain text gets a -# subtext tag.
function withAttribution(msg, name, at = new Date()) {
    const when = at instanceof Date ? at : new Date(at);
    if (msg.embeds?.length) {
        const footerLine = `sent by ${name}`;
        const embeds = msg.embeds.map((embed, i) => {
            if (i !== 0) return embed;
            const prefix = embed.footer?.text ? `${embed.footer.text}\n` : '';
            return {
                ...embed,
                footer: { ...(embed.footer || {}), text: `${prefix}${footerLine}`.slice(0, 2048) },
                timestamp: when.toISOString()
            };
        });
        return { ...msg, embeds };
    }
    const tag = `-# ${attributionLine(name, when)}`;
    const contentTag = `\n${tag}`;
    const room = Math.max(0, 2000 - contentTag.length);
    const body = (msg.content || '').slice(0, room);
    return { ...msg, content: `${body}${contentTag}` };
}

function deriveSecret(access) {
    if (process.env.MOD_DASH_SECRET) return process.env.MOD_DASH_SECRET;
    const basis = `${access?.staffPassword || ''}|${Object.values(access?.roots || {}).join('|')}`;
    if (basis.length > 1) return crypto.createHash('sha256').update(`kitbot-mod-dash:${basis}`).digest();
    return crypto.randomBytes(32); // ephemeral; sessions won't survive restart
}

function safeEq(a, b) {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), min), max);
}

function memberLite(m) {
    return { id: m.id, tag: m.user?.tag || null, nick: m.nickname || null, avatar: m.user?.displayAvatarURL?.({ size: 64 }) || null };
}

function memberRow(m) {
    const top = m.roles?.highest;
    return {
        id: m.id, tag: m.user?.tag || null, nick: m.nickname || null, bot: Boolean(m.user?.bot),
        avatar: m.user?.displayAvatarURL?.({ size: 64 }) || null,
        joinedAt: m.joinedAt?.getTime() || null,
        createdAt: m.user?.createdAt?.getTime() || null,
        topRole: top && top.name !== '@everyone' ? { name: top.name, color: top.hexColor } : null
    };
}

const byJoinedDesc = (a, b) => (b.joinedAt || 0) - (a.joinedAt || 0);

function hasEmbedContent(e) {
    return Boolean(e && (e.title || e.description || e.author?.name || e.footer?.text || e.image?.url ||
        e.thumbnail?.url || (Array.isArray(e.fields) && e.fields.length)));
}

function sanitizeEmbed(e) {
    const out = {};
    if (e.title) out.title = String(e.title).slice(0, 256);
    if (e.description) out.description = String(e.description).slice(0, 4096);
    if (e.url && /^https?:\/\//.test(e.url)) out.url = e.url;
    if (Number.isFinite(e.color)) out.color = e.color & 0xffffff;
    else if (typeof e.color === 'string' && /^#?[0-9a-f]{6}$/i.test(e.color)) out.color = parseInt(e.color.replace('#', ''), 16);
    if (e.author?.name) out.author = { name: String(e.author.name).slice(0, 256), icon_url: validUrl(e.author.icon_url), url: validUrl(e.author.url) };
    if (e.footer?.text) out.footer = { text: String(e.footer.text).slice(0, 2048), icon_url: validUrl(e.footer.icon_url) };
    if (validUrl(e.image?.url)) out.image = { url: e.image.url };
    if (validUrl(e.thumbnail?.url)) out.thumbnail = { url: e.thumbnail.url };
    if (e.timestamp) out.timestamp = new Date().toISOString();
    if (Array.isArray(e.fields)) {
        out.fields = e.fields.filter(f => f && f.name && f.value).slice(0, 25).map(f => ({
            name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: Boolean(f.inline)
        }));
    }
    return out;
}

function validUrl(u) { return typeof u === 'string' && /^https?:\/\//.test(u) ? u : undefined; }

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { ModDashboardCog, hashPassword, verifyPassword, withAttribution };
