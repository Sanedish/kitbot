'use strict';

// ModStore - JSON-backed persistence for the moderation/punishment system.
//
// Single source of truth for moderation *cases* (warns, timeouts, kicks, bans,
// notes, ...) and per-guild moderation settings. Logs are NOT stored here - the
// high-volume audit-style logs live in data/logs/<channelId>/dd-mm-yyyy.jsonl
// via log-store.js. This file only holds the comparatively small set of
// moderation cases plus settings.
//
// Everything is deliberately behind a small DAO surface (addCase, listCases,
// getMemberHistory, settings, ...) so the backend can be swapped to SQLite or
// Mongo later without touching the engine or the dashboard. Writes are
// debounced and atomic (temp file + rename) to survive crashes.

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'moderation.json');
const WRITE_DEBOUNCE_MS = 400;

const CASE_TYPES = new Set([
    'note', 'warn', 'timeout', 'untimeout', 'kick', 'softban', 'ban', 'tempban', 'unban'
]);

const DEFAULT_SETTINGS = {
    dmOnPunish: true,
    warnDecayDays: 0, // 0 = warns never expire
    escalation: {
        enabled: false,
        // ascending point thresholds; first crossed rule with no recorded
        // escalation case yet is applied.
        rules: [
            { points: 3, action: 'timeout', duration: 3600 },
            { points: 5, action: 'timeout', duration: 86400 },
            { points: 8, action: 'kick' },
            { points: 12, action: 'ban' }
        ]
    },
    wickBotId: '536991182035746816',
    modLogChannelId: null,   // Wick mod-log channel (Phase 3 parsing)
    punishmentRoleId: null   // optional "muted" role, if role-based mutes are used
};

class ModStore {
    constructor(filePath = DATA_FILE) {
        this.filePath = filePath;
        this.data = { version: 1, caseSeq: {}, cases: [], settings: {} };
        this._writeTimer = null;
        this._dirty = false;
        this._load();
    }

    _load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = {
                version: parsed.version || 1,
                caseSeq: parsed.caseSeq || {},
                cases: Array.isArray(parsed.cases) ? parsed.cases : [],
                settings: parsed.settings || {}
            };
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`[MOD-STORE] Failed to load ${this.filePath}: ${error.message}. Starting empty.`);
            }
            this._scheduleWrite();
        }
    }

    _scheduleWrite() {
        this._dirty = true;
        if (this._writeTimer) return;
        this._writeTimer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
        if (typeof this._writeTimer.unref === 'function') this._writeTimer.unref();
    }

    /** Force a synchronous, atomic write. Call on shutdown. */
    flush() {
        if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
        if (!this._dirty) return;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmp, this.filePath);
            this._dirty = false;
        } catch (error) {
            console.error(`[MOD-STORE] Write failed: ${error.message}`);
        }
    }

    // ── Settings ────────────────────────────────────────────────────────────
    getSettings(guildId) {
        const stored = this.data.settings[guildId] || {};
        return {
            ...DEFAULT_SETTINGS,
            ...stored,
            escalation: { ...DEFAULT_SETTINGS.escalation, ...(stored.escalation || {}) }
        };
    }

    setSettings(guildId, patch) {
        const current = this.getSettings(guildId);
        const next = { ...current, ...patch };
        if (patch.escalation) next.escalation = { ...current.escalation, ...patch.escalation };
        this.data.settings[guildId] = next;
        this._scheduleWrite();
        return next;
    }

    // ── Cases ───────────────────────────────────────────────────────────────
    _nextSeq(guildId) {
        const next = (this.data.caseSeq[guildId] || 0) + 1;
        this.data.caseSeq[guildId] = next;
        return next;
    }

    /**
     * Insert a case. Returns the stored record.
     * Required: guildId, type, targetId. Everything else is optional.
     */
    addCase(input) {
        if (!input || !input.guildId || !input.targetId) {
            throw new Error('addCase requires guildId and targetId');
        }
        const type = String(input.type || 'note');
        if (!CASE_TYPES.has(type)) throw new Error(`Unknown case type: ${type}`);

        const seq = this._nextSeq(input.guildId);
        const now = Date.now();
        const record = {
            id: `g${input.guildId}-${seq}`,
            seq,
            guildId: input.guildId,
            type,
            targetId: input.targetId,
            targetTag: input.targetTag || null,
            moderatorId: input.moderatorId || null,
            moderatorTag: input.moderatorTag || null,
            source: input.source || 'kitbot', // kitbot | wick | manual | automod
            reason: input.reason || null,
            points: Number.isFinite(input.points) ? input.points : (type === 'warn' ? 1 : 0),
            duration: Number.isFinite(input.duration) ? input.duration : null, // seconds
            expiresAt: Number.isFinite(input.expiresAt) ? input.expiresAt : null,
            active: input.active !== undefined ? Boolean(input.active) : isActiveByDefault(type),
            createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
            evidence: Array.isArray(input.evidence) ? input.evidence : [],
            meta: input.meta || {}
        };
        this.data.cases.push(record);
        this._scheduleWrite();
        return record;
    }

    getCase(caseId) {
        return this.data.cases.find(c => c.id === caseId) || null;
    }

    updateCase(caseId, patch) {
        const c = this.getCase(caseId);
        if (!c) return null;
        Object.assign(c, patch, { meta: { ...c.meta, ...(patch.meta || {}) } });
        this._scheduleWrite();
        return c;
    }

    deleteCase(caseId) {
        const i = this.data.cases.findIndex(c => c.id === caseId);
        if (i === -1) return false;
        this.data.cases.splice(i, 1);
        this._scheduleWrite();
        return true;
    }

    /**
     * Filtered, paginated listing. Newest first.
     * filter: { guildId, targetId, moderatorId, type, source, active,
     *           since, until, search, limit, offset }
     */
    listCases(filter = {}) {
        const {
            guildId, targetId, moderatorId, type, source, active,
            since, until, search, limit = 50, offset = 0
        } = filter;
        const needle = search ? String(search).toLowerCase() : null;

        let rows = this.data.cases.filter(c => {
            if (guildId && c.guildId !== guildId) return false;
            if (targetId && c.targetId !== targetId) return false;
            if (moderatorId && c.moderatorId !== moderatorId) return false;
            if (type && c.type !== type) return false;
            if (source && c.source !== source) return false;
            if (active !== undefined && Boolean(c.active) !== Boolean(active)) return false;
            if (since && c.createdAt < since) return false;
            if (until && c.createdAt > until) return false;
            if (needle) {
                const hay = `${c.reason || ''} ${c.targetTag || ''} ${c.moderatorTag || ''} ${c.id}`.toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });

        rows.sort((a, b) => b.createdAt - a.createdAt);
        const total = rows.length;
        return { total, cases: rows.slice(offset, offset + limit) };
    }

    /** All cases for one member, newest first, plus derived counters. */
    getMemberHistory(guildId, targetId) {
        const cases = this.data.cases
            .filter(c => c.guildId === guildId && c.targetId === targetId)
            .sort((a, b) => b.createdAt - a.createdAt);
        return {
            cases,
            activeWarnPoints: this.getActiveWarnPoints(guildId, targetId),
            counts: tallyByType(cases)
        };
    }

    /** Sum of points from active, non-expired warns. */
    getActiveWarnPoints(guildId, targetId, now = Date.now()) {
        return this.data.cases.reduce((sum, c) => {
            if (c.guildId !== guildId || c.targetId !== targetId) return sum;
            if (c.type !== 'warn' || !c.active) return sum;
            if (c.expiresAt && c.expiresAt <= now) return sum;
            return sum + (c.points || 0);
        }, 0);
    }

    /** Expire warns past their decay window. Returns the ones flipped inactive. */
    expireWarns(now = Date.now()) {
        const expired = [];
        for (const c of this.data.cases) {
            if (c.type === 'warn' && c.active && c.expiresAt && c.expiresAt <= now) {
                c.active = false;
                expired.push(c);
            }
        }
        if (expired.length) this._scheduleWrite();
        return expired;
    }

    /** Active punishments with an expiry that's now due (timeout/tempban). */
    getDuePunishments(now = Date.now()) {
        return this.data.cases.filter(c =>
            c.active &&
            (c.type === 'timeout' || c.type === 'tempban') &&
            c.expiresAt && c.expiresAt <= now
        );
    }

    getStats(guildId) {
        const rows = this.data.cases.filter(c => !guildId || c.guildId === guildId);
        const bySource = {};
        const byType = {};
        for (const c of rows) {
            bySource[c.source] = (bySource[c.source] || 0) + 1;
            byType[c.type] = (byType[c.type] || 0) + 1;
        }
        return { total: rows.length, bySource, byType };
    }
}

function isActiveByDefault(type) {
    // "active" means the case currently counts / is in effect.
    // Reversal events (untimeout/unban) and one-shot events are not "active".
    switch (type) {
        case 'warn': return true;
        case 'timeout': return true;
        case 'tempban': return true;
        case 'ban': return true;
        default: return false; // note, kick, softban, untimeout, unban
    }
}

function tallyByType(cases) {
    const out = {};
    for (const c of cases) out[c.type] = (out[c.type] || 0) + 1;
    return out;
}

module.exports = { ModStore, CASE_TYPES, DEFAULT_SETTINGS };
