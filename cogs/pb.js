'use strict';

// PocketBase glue - two small things, no SDK dependency (Node's global fetch is enough):
//   1. startPocketBase()  - launch the bundled binary as a child of the bot.
//   2. PbClient           - superuser REST client for the `staff` access list.
//
// The bot is the ONLY PocketBase client. It authenticates as a service
// superuser (PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD) and the `staff` collection is
// superuser-only, so nothing in PB is exposed to mods or guests. The `staff`
// rows just answer "who is allowed in, and is each account currently active?".

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PB_DIR = path.join(__dirname, '..', 'pb');
const PB_BIN = path.join(PB_DIR, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase');
const USERNAME_RE = /^[\w .\-]{1,64}$/; // letters/digits/_ plus space . -

/**
 * Resolve the binary to actually exec. PB_DIR commonly lives on a network
 * share (noexec) - `chmod +x` succeeds there but the kernel still refuses to
 * run it. So on Linux, stage a copy on local disk (/tmp) and run that
 * instead; pb_data/pb_hooks/pb_migrations stay on the share via cwd.
 */
function resolveExecutable() {
    if (process.platform === 'win32') return PB_BIN;
    try {
        const staged = path.join(os.tmpdir(), 'kitbot-pb', 'pocketbase');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.copyFileSync(PB_BIN, staged);
        fs.chmodSync(staged, 0o755);
        return staged;
    } catch (e) {
        console.error(`[PB] failed to stage local copy (${e.message}), trying ${PB_BIN} directly`);
        try { fs.chmodSync(PB_BIN, 0o755); } catch { /* ignore */ }
        return PB_BIN;
    }
}

/** Spawn `pocketbase serve`. Dies with the bot. Returns the ChildProcess. */
function startPocketBase(url = 'http://127.0.0.1:8090') {
    const http = url.replace(/^https?:\/\//, '');
    const exe = resolveExecutable();
    const proc = spawn(exe, ['serve', `--http=${http}`], { cwd: PB_DIR, stdio: 'inherit' });
    proc.on('error', e => console.error(`[PB] launch failed: ${e.message} (binary: ${exe})`));
    const kill = () => { try { proc.kill(); } catch { /* ignore */ } };
    process.once('exit', kill);
    process.once('SIGINT', kill);
    process.once('SIGTERM', kill);
    return proc;
}

class PbClient {
    constructor({ url, email, password } = {}) {
        this.url = (url || 'http://127.0.0.1:8090').replace(/\/$/, '');
        this.email = email;
        this.password = password;
        this.token = null;
    }

    async _auth() {
        const res = await fetch(`${this.url}/api/collections/_superusers/auth-with-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: this.email, password: this.password })
        });
        if (!res.ok) throw new Error(`PB superuser auth failed: HTTP ${res.status}`);
        this.token = (await res.json()).token;
    }

    async _api(pathname, opts = {}, retry = true) {
        if (!this.token) await this._auth();
        const res = await fetch(`${this.url}${pathname}`, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: this.token },
            body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (res.status === 401 && retry) { this.token = null; return this._api(pathname, opts, false); }
        return res;
    }

    /** Wait for the HTTP server to answer /api/health (PB is a separate process). */
    async waitReady({ tries = 40, delayMs = 500 } = {}) {
        for (let i = 0; i < tries; i++) {
            try { if ((await fetch(`${this.url}/api/health`)).ok) return true; } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, delayMs));
        }
        return false;
    }

    // ── Staff access list ────────────────────────────────────────────────────
    /** True only if a staff row exists for this name (case-insensitive) AND is active. */
    async isActiveStaff(username) {
        if (!USERNAME_RE.test(username)) return false;
        const target = username.toLowerCase();
        const row = (await this.listStaff()).find(s => s.username.toLowerCase() === target);
        return !!(row && row.active);
    }

    async listStaff() {
        const res = await this._api('/api/collections/staff/records?perPage=500&sort=username');
        if (!res.ok) return [];
        return ((await res.json()).items || []).map(r => ({
            id: r.id, username: r.username, active: !!r.active, note: r.note || ''
        }));
    }

    async addStaff(username, note = '') {
        if (!USERNAME_RE.test(username)) throw new Error('Username must be 1-64 chars: letters, digits, space . _ -');
        const res = await this._api('/api/collections/staff/records', {
            method: 'POST', body: { username, active: true, note: String(note).slice(0, 200) }
        });
        if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j?.data?.username ? 'That staff name already exists.' : (j.message || `HTTP ${res.status}`));
        }
        return res.json();
    }

    async setActive(id, active) {
        const res = await this._api(`/api/collections/staff/records/${id}`, { method: 'PATCH', body: { active: !!active } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async deleteStaff(id) {
        const res = await this._api(`/api/collections/staff/records/${id}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        return true;
    }

    async getStaff(username) {
        if (!USERNAME_RE.test(username)) return null;
        const target = username.toLowerCase();
        const res = await this._api(`/api/collections/staff/records?perPage=1&filter=username~'${target}'`);
        if (!res.ok) return null;
        const items = (await res.json()).items || [];
        const row = items.find(s => s.username.toLowerCase() === target);
        return row ? {
            id: row.id, username: row.username, active: !!row.active, 
            note: row.note || '', passwordHash: row.passwordHash || ''
        } : null;
    }

    async updateStaffPassword(id, passwordHash) {
        const res = await this._api(`/api/collections/staff/records/${id}`, { 
            method: 'PATCH', 
            body: { passwordHash } 
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }
}

module.exports = { startPocketBase, PbClient, PB_DIR, PB_BIN };
