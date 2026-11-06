'use strict';

// MusicDashboardCog - public-facing web dashboard for the kitbot jukebox.
//
// Serves:
//   /              static dashboard (web/)
//   /api/*         JSON control API (signed-cookie sessions, per-IP rate limits)
//   /ws            WebSocket state push
//   /kitbot_raw    raw mp3 feed for the Omnia processor (only while Omnia is on)
//
// The dashboard is reachable by anyone; identity is a self-chosen display name
// in a signed cookie. Admin rights come from MUSIC_ADMIN_PASSWORD. Admin
// actions always pass the music cog's gates (admins overwrite user commands);
// non-admin actions are refused while an admin lock is active.

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { RAW_MOUNT } = require('./music');

const COOKIE_NAME = 'kb_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_POSTS = 30;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;

class MusicDashboardCog {
    /** @param {import('./music').MusicCog} musicCog */
    constructor(musicCog) {
        this.music = musicCog;
        this.port = Number(process.env.MUSIC_DASH_PORT) || 8780; // keep clear of the local Icecast ports (8765/8766)
        this.host = process.env.MUSIC_DASH_HOST || '127.0.0.1';
        this.adminPassword = process.env.MUSIC_ADMIN_PASSWORD || '';
        this.secret = null;
        this.server = null;
        this.wss = null;
        this.rateBuckets = new Map();   // ip → [timestamps]
        this.loginBuckets = new Map();  // ip → [timestamps]
    }

    start() {
        if (this.server) return;
        this.secret = this.music.getSessionSecret();
        const app = express();
        app.disable('x-powered-by');
        app.use(express.json({ limit: '16kb' }));

        app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Referrer-Policy', 'no-referrer');
            req.actor = this._readSession(req);
            next();
        });

        // ── Raw feed for the Omnia processor ────────────────────────────────
        // Always active: carries the program in Omnia mode and an mp3 silence
        // keepalive otherwise, so Omnia's streaming input never drops.
        app.get(RAW_MOUNT, (req, res) => {
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Connection', 'close');
            res.setHeader('icy-name', 'kitbot raw feed');
            res.setHeader('icy-description', 'kitbot pre-processing program feed');
            this.music.addRawClient(res);
            // Send headers immediately - icecast-style clients expect a response
            // on connect, before the first audio chunk exists.
            res.flushHeaders();
        });

        // ── Read API ────────────────────────────────────────────────────────
        app.get('/api/state', (req, res) => res.json(this._stateFor(req.actor)));
        app.get('/api/library', (req, res) => {
            const listing = this.music.getDirListing(req.query.dir);
            if (!listing) return res.status(404).json({ error: this.music.library.error || 'Library is empty.' });
            res.json(listing);
        });
        app.get('/api/search', (req, res) => {
            res.json({ results: this.music.searchLibrary(String(req.query.q || ''), 50) });
        });

        // ── Sessions ────────────────────────────────────────────────────────
        app.post('/api/session', this._postLimiter(), (req, res) => {
            const name = String(req.body?.name || '').trim().slice(0, 24);
            if (!name) return res.status(400).json({ error: 'Pick a display name.' });
            const actor = { id: req.actor?.id || crypto.randomUUID(), name, admin: Boolean(req.actor?.admin) };
            this._writeSession(res, actor);
            res.json({ actor });
        });

        app.post('/api/login', (req, res) => {
            if (!this._allow(this.loginBuckets, this._ip(req), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
                return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
            }
            if (!this.adminPassword) {
                return res.status(503).json({ error: 'Admin login is not configured (set MUSIC_ADMIN_PASSWORD).' });
            }
            const supplied = Buffer.from(String(req.body?.password || ''));
            const expected = Buffer.from(this.adminPassword);
            const match = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
            if (!match) return res.status(403).json({ error: 'Wrong password.' });
            const actor = { id: req.actor?.id || crypto.randomUUID(), name: req.actor?.name || 'admin', admin: true };
            this._writeSession(res, actor);
            res.json({ actor });
        });

        app.post('/api/logout', (req, res) => {
            res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
            res.json({ ok: true });
        });

        // ── Control API ─────────────────────────────────────────────────────
        const act = handler => [this._postLimiter(), (req, res) => {
            const actor = req.actor;
            if (!actor?.name) return res.status(401).json({ error: 'Set a display name first.' });
            const result = handler(req, actor);
            if (result?.ok) return res.json({ ok: true });
            const status = result?.code === 'forbidden' ? 403 : result?.code === 'locked' ? 423 : 400;
            res.status(status).json({ error: result?.reason || 'Request refused.' });
        }];

        app.post('/api/enqueue', ...act((req, actor) =>
            this.music.enqueue(req.body?.fileId, actor, { force: Boolean(req.body?.force), next: Boolean(req.body?.next) })));
        app.post('/api/queue/remove', ...act((req, actor) => this.music.removeFromQueue(String(req.body?.uid || ''), actor)));
        app.post('/api/queue/move', ...act((req, actor) =>
            this.music.moveInQueue(String(req.body?.uid || ''), req.body?.direction === 'up' ? 'up' : 'down', actor)));
        app.post('/api/queue/clear', ...act((req, actor) => this.music.clearQueue(actor)));
        app.post('/api/control', ...act((req, actor) => {
            switch (req.body?.action) {
                case 'pause': return this.music.pause(actor);
                case 'resume': return this.music.resume(actor);
                case 'skip': return this.music.skip(actor);
                case 'stop': return this.music.stopPlayback(actor);
                default: return { ok: false, reason: 'Unknown action.' };
            }
        }));
        app.post('/api/volume', ...act((req, actor) => this.music.setVolume(req.body?.percent, actor)));
        app.post('/api/seek', ...act((req, actor) => this.music.seek(req.body?.seconds, actor)));
        app.post('/api/loop', ...act((req, actor) => this.music.setLoop(req.body?.mode, actor)));
        app.post('/api/shuffle', ...act((req, actor) => this.music.shuffleQueue(actor)));
        app.post('/api/lock', ...act((req, actor) => this.music.setLocked(Boolean(req.body?.locked), actor)));
        app.post('/api/omnia', ...act((req, actor) => this.music.setOmnia(Boolean(req.body?.enabled), actor)));
        app.post('/api/rescan', [this._postLimiter(), async (req, res) => {
            if (!req.actor?.admin) return res.status(403).json({ error: 'That action is admin-only.' });
            await this.music.rescanLibrary();
            res.json({ ok: true });
        }]);
        app.post('/api/voice', [this._postLimiter(), async (req, res) => {
            const actor = req.actor;
            if (!actor?.name) return res.status(401).json({ error: 'Set a display name first.' });
            const result = req.body?.channelId
                ? await this.music.joinChannel(String(req.body.channelId), actor)
                : this.music.leaveChannel(actor);
            if (result.ok) return res.json({ ok: true });
            res.status(result.code === 'forbidden' ? 403 : result.code === 'locked' ? 423 : 400).json({ error: result.reason });
        }]);

        // Request a track by name from the library.
        app.post('/api/request', [this._postLimiter(), async (req, res) => {
            const actor = req.actor;
            if (!actor?.name) return res.status(401).json({ error: 'Set a display name first.' });
            const query = String(req.body?.query || '').trim();
            if (!query) return res.status(400).json({ error: 'Enter a song name.' });
            const acquired = await this.music.acquireTrack(query);
            if (!acquired.ok) return res.status(404).json({ error: acquired.reason });
            const result = this.music.enqueue(acquired.file.id, actor, {
                force: Boolean(req.body?.force),
                next: Boolean(req.body?.next)
            });
            if (!result.ok) {
                const status = result.code === 'forbidden' ? 403 : result.code === 'locked' ? 423 : 400;
                return res.status(status).json({ error: result.reason });
            }
            res.json({ ok: true, source: acquired.source, track: { name: acquired.file.name, rel: acquired.file.rel } });
        }]);

        app.use(express.static(path.join(__dirname, '..', 'web'), { index: 'index.html' }));

        this.server = http.createServer(app);
        this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
        // A port conflict must never take the whole bot down: the Icecast raw
        // push lives in the music cog and keeps running without the dashboard.
        this.server.on('error', error => {
            console.error(`[MUSIC] Dashboard server error: ${error.message}`);
            if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
                console.error(`[MUSIC] Port ${this.port} is unavailable - the web dashboard is OFF, but the bot and the Icecast raw push keep running. Set MUSIC_DASH_PORT to a free port and restart.`);
                this._logRawStreamUrls({ dashboardUp: false });
            }
        });
        // ws re-emits server errors on the WebSocketServer; without a listener
        // that re-emit is an uncaught exception that kills the process.
        this.wss.on('error', () => {});
        this.wss.on('connection', socket => {
            socket.send(JSON.stringify({ type: 'state', state: this.music.getState() }));
        });
        this.music.events.on('state', state => this._broadcast(state));
        this._tickTimer = setInterval(() => {
            // Light heartbeat so progress bars stay honest even without events.
            if (this.music.nowPlaying && !this.music.nowPlaying.paused) this._broadcast(this.music.getState());
        }, 5000);

        this.server.listen(this.port, this.host, () => {
            console.log(`[MUSIC] Dashboard listening on http://${this.host}:${this.port} (raw feed at ${RAW_MOUNT}).`);
            this._logRawStreamUrls();
        });
    }

    stop() {
        if (this._tickTimer) clearInterval(this._tickTimer);
        this.wss?.close();
        this.server?.close();
    }

    /**
     * Public URLs of the Icecast raw mount. Derived from ICECAST_PUSH_URL and
     * this machine's real network interfaces (no hardcoded hosts); a push to
     * loopback means the mount lives on this machine, so every external IPv4
     * serves it. RAW_STREAM_PUBLIC_URL (comma-separated) overrides if set.
     */
    _icecastMountUrls() {
        const override = String(process.env.RAW_STREAM_PUBLIC_URL || '')
            .split(',').map(url => url.trim()).filter(Boolean);
        if (override.length) return override;
        if (!this.music.icecastPushUrl) return [];
        let push;
        try {
            push = new URL(this.music.icecastPushUrl);
        } catch {
            return [];
        }
        const port = push.port || '8000';
        const mount = push.pathname || RAW_MOUNT;
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(push.hostname)) {
            return [`http://${push.hostname}:${port}${mount}`];
        }
        const urls = [`http://localhost:${port}${mount}`];
        for (const addresses of Object.values(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family !== 'IPv4' || address.internal) continue;
                if (address.address.startsWith('169.254.')) continue; // link-local noise
                urls.push(`http://${address.address}:${port}${mount}`);
            }
        }
        return urls;
    }

    /** Announce where the raw program feed can be pulled from (Omnia streaming input). */
    _logRawStreamUrls({ dashboardUp = true } = {}) {
        console.log('[MUSIC] ─────────────────────────────────────────────────────────');
        console.log('[MUSIC] Raw program feed (use as the Omnia streaming input):');
        for (const url of this._icecastMountUrls()) {
            console.log(`[MUSIC]   Icecast mount (always active): ${url}`);
        }
        if (dashboardUp) {
            const localUrl = `http://${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${this.port}${RAW_MOUNT}`;
            console.log(`[MUSIC]   Bot direct feed (always active): ${localUrl}`);
        }
        if (this.music.icecastPushUrl) {
            console.log(`[MUSIC]   Pushing raw feed to Icecast: ${this.music.icecastPushUrl.replace(/\/\/[^@]*@/, '//***@')}`);
        }
        console.log('[MUSIC] ─────────────────────────────────────────────────────────');
    }

    _broadcast(state) {
        if (!this.wss) return;
        const payload = JSON.stringify({ type: 'state', state });
        for (const socket of this.wss.clients) {
            if (socket.readyState === socket.OPEN) socket.send(payload);
        }
    }

    _stateFor(actor) {
        return {
            ...this.music.getState(),
            you: actor ? { name: actor.name, admin: Boolean(actor.admin), id: actor.id } : null,
            adminLoginAvailable: Boolean(this.adminPassword)
        };
    }

    // ── Sessions: HMAC-signed JSON cookie ───────────────────────────────────

    _sign(payload) {
        return crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    }

    _writeSession(res, actor) {
        const payload = Buffer.from(JSON.stringify({ ...actor, iat: Date.now() })).toString('base64url');
        const cookie = `${COOKIE_NAME}=${payload}.${this._sign(payload)}; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax`;
        res.setHeader('Set-Cookie', cookie);
    }

    _readSession(req) {
        const header = req.headers.cookie || '';
        const raw = header.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
        if (!raw) return null;
        const value = raw.slice(COOKIE_NAME.length + 1);
        const dot = value.lastIndexOf('.');
        if (dot === -1) return null;
        const payload = value.slice(0, dot);
        const signature = value.slice(dot + 1);
        const expected = this._sign(payload);
        if (signature.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
        try {
            const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (!session.iat || Date.now() - session.iat > SESSION_TTL_MS) return null;
            return { id: session.id, name: session.name, admin: Boolean(session.admin) };
        } catch {
            return null;
        }
    }

    // ── Rate limiting ───────────────────────────────────────────────────────

    _ip(req) {
        return req.socket.remoteAddress || 'unknown';
    }

    _allow(buckets, ip, max, windowMs) {
        const now = Date.now();
        const bucket = (buckets.get(ip) || []).filter(at => now - at < windowMs);
        if (bucket.length >= max) {
            buckets.set(ip, bucket);
            return false;
        }
        bucket.push(now);
        buckets.set(ip, bucket);
        if (buckets.size > 5000) buckets.clear(); // crude memory guard for a public endpoint
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

module.exports = { MusicDashboardCog };
