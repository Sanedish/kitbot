'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const DEFAULT_API_URL = 'https://api.foldingathome.org';
const DEFAULT_CLIENT_HOST = '127.0.0.1:7396';
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Match F@H web control login: PBKDF2(passphrase, SHA256(email), 100k) → SHA256 → base64. */
function deriveLoginPassword(email, passphrase) {
    const salt = crypto.createHash('sha256').update(email.toLowerCase()).digest();
    const key = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
    return crypto.createHash('sha256').update(key).digest('base64');
}

function fmtNum(n) {
    return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

class FahClient {
    constructor(options = {}) {
        this.user = options.user || process.env.FAH_USER || process.env['fah-user'] || '';
        this.team = options.team || process.env.FAH_TEAM || process.env['fah-team'] || '';
        this.passkey = options.passkey || process.env.FAH_PASSKEY || process.env['fah-passkey'] || '';
        this.email = options.email || process.env.FAH_EMAIL || process.env['fah-email'] || '';
        this.passphrase = options.passphrase || process.env.FAH_PASSWORD || process.env['fah-password'] || '';
        this.apiUrl = (options.apiUrl || process.env.FAH_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
        this.clientHost = options.clientHost || process.env.FAH_CLIENT_HOST || DEFAULT_CLIENT_HOST;
        this._session = null;
    }

    configured() {
        return Boolean(this.user || (this.email && this.passphrase));
    }

    async fetchDashboard() {
        const out = { account: null, stats: null, local: null, machines: [], errors: [] };
        if (!this.configured()) {
            out.errors.push('FAH credentials are not configured.');
            return out;
        }

        let { user, team, passkey } = this;

        // Public stats only need the username. Fall back to an account login to discover it.
        // ponytail: login path kept for email/passphrase configs; username path needs no secrets.
        if (!user) {
            try {
                const account = await this._getAccount();
                out.account = account;
                out.machines = Array.isArray(account.machines) ? account.machines : [];
                ({ user, team, passkey } = account);
            } catch (e) {
                out.errors.push(`Account login failed: ${e.message}`);
                return out;
            }
        }

        if (user && user.toLowerCase() !== 'anonymous') {
            try {
                out.stats = await this._fetchUserStats(user, team, passkey);
            } catch (e) {
                out.errors.push(`Stats lookup failed: ${e.message}`);
            }
        }

        try {
            out.local = await this._fetchLocalState();
        } catch (e) {
            out.errors.push(`Local client unreachable: ${e.message}`);
        }

        return out;
    }

    async _getAccount() {
        const now = Date.now();
        if (this._session?.account && this._session.expires > now) return this._session.account;

        const password = deriveLoginPassword(this.email, this.passphrase);
        const loginUrl = new URL(`${this.apiUrl}/login`);
        loginUrl.search = new URLSearchParams({ email: this.email, password }).toString();

        const loginRes = await fetch(loginUrl, { signal: AbortSignal.timeout(15_000) });
        const loginBody = await loginRes.json().catch(() => ({}));
        if (!loginRes.ok) throw new Error(loginBody.error || `HTTP ${loginRes.status}`);

        const sid = loginBody.id;
        if (!sid) throw new Error('Login returned no session id.');

        const accountRes = await fetch(`${this.apiUrl}/account`, {
            headers: { Authorization: sid },
            signal: AbortSignal.timeout(15_000)
        });
        const account = await accountRes.json().catch(() => ({}));
        if (!accountRes.ok) throw new Error(account.error || `HTTP ${accountRes.status}`);

        this._session = { sid, account, expires: now + SESSION_TTL_MS };
        return account;
    }

    async _fetchUserStats(user, team, passkey) {
        const url = new URL(`${this.apiUrl}/user/${encodeURIComponent(user)}`);
        if (passkey) url.searchParams.set('passkey', passkey);

        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.name) throw new Error(data?.error || `HTTP ${res.status}`);
        if (team != null && team !== '') data.team = team; // /user/<name> returns teams[], not a single team
        return data;
    }

    _fetchLocalState(timeoutMs = 6000) {
        return new Promise((resolve, reject) => {
            const url = `ws://${this.clientHost}/api/websocket`;
            const ws = new WebSocket(url);
            let settled = false;

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { ws.close(); } catch { /* ignore */ }
                fn(value);
            };

            const timer = setTimeout(() => finish(reject, new Error('timed out waiting for client state')), timeoutMs);

            ws.on('error', err => finish(reject, err));
            ws.on('message', raw => {
                const text = String(raw);
                if (text === 'ping') return;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        finish(resolve, summarizeLocalState(parsed));
                    }
                } catch { /* wait for a full state object */ }
            });
        });
    }
}

function summarizeLocalState(state) {
    const info = state.info || {};
    const units = Array.isArray(state.units) ? state.units : [];
    const group = state.groups?.[''] || {};
    const config = group.config || state.config || {};
    const paused = Boolean(config.paused);
    const finishing = Boolean(config.finish);

    let ppd = 0;
    let running = 0;
    for (const unit of units) {
        ppd += Number(unit.ppd) || 0;
        if (unit.state === 'RUN' && !unit.pause_reason) running += 1;
    }

    const completedOnMachine = Array.isArray(state.wus) ? state.wus.length : null;
    let status = 'Idle';
    if (paused && finishing) status = 'Finishing';
    else if (paused) status = 'Paused';
    else if (running) status = 'Folding';
    else if (units.length) status = 'Waiting';

    const lead = units.find(u => u.state === 'RUN' && !u.pause_reason) || units[0];
    const project = lead?.assignment?.project;

    return {
        name: info.mach_name || info.hostname || 'Local client',
        version: info.version || null,
        os: info.os || null,
        status,
        ppd,
        activeUnits: units.length,
        runningUnits: running,
        completedOnMachine,
        project: project != null ? String(project) : null,
        user: config.user || info.user || null,
        team: config.team ?? info.team ?? null
    };
}

module.exports = { FahClient, deriveLoginPassword, fmtNum, summarizeLocalState };
