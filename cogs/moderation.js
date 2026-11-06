'use strict';

// ModerationCog - kitbot's own punishment engine + audit-log ingestion.
//
// Two jobs:
//   1. Enforce punishments on Discord (warn/note/timeout/kick/softban/ban/
//      tempban/unban), record each as a case, DM the member, and run point-
//      based auto-escalation.
//   2. Ingest moderation actions that happen *outside* kitbot - Wick, human
//      mods, automod - by listening to GuildAuditLogEntryCreate, so the
//      dashboard shows one merged per-member timeline attributed by source.
//
// All persistence goes through ModStore (data/moderation.json). The engine
// performs the Discord side-effects and the bookkeeping; the dashboard (Phase
// 2) is a thin caller over the public API methods at the bottom.

const { AuditLogEvent, EmbedBuilder, PermissionsBitField } = require('discord.js');

const SELF_ACTION_TTL_MS = 15_000;     // window to dedup our own actions vs the audit echo
const EXPIRY_SWEEP_MS = 30_000;        // how often to lift due timeouts/tempbans + decay warns
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord hard cap (28 days)

class ModerationCog {
    constructor(client, options = {}) {
        this.client = client;
        this.store = options.store;
        this.getConfig = options.getConfig || (() => ({}));
        if (!this.store) throw new Error('ModerationCog requires { store }');

        this._recentSelfActions = new Map(); // key -> expiry ts
        this._sweepTimer = null;
        this._started = false;

        this.boundAuditEntry = entry => {
            this.handleAuditEntry(entry).catch(err =>
                console.error(`[MODERATION] audit ingest failed: ${err.message}`));
        };
    }

    start() {
        if (this._started) return;
        this.client.on(AuditLogEvent ? 'guildAuditLogEntryCreate' : 'guildAuditLogEntryCreate', this.boundAuditEntry);
        this._sweepTimer = setInterval(() => this._sweep().catch(() => {}), EXPIRY_SWEEP_MS);
        if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
        this._started = true;
        console.log('[MODERATION] engine started (enforcement + audit ingestion).');
    }

    stop() {
        this.client.off('guildAuditLogEntryCreate', this.boundAuditEntry);
        if (this._sweepTimer) clearInterval(this._sweepTimer);
        this.store.flush();
        this._started = false;
    }

    // ── Dedup helpers ─────────────────────────────────────────────────────────
    _markSelfAction(guildId, targetId, type) {
        this._recentSelfActions.set(`${guildId}:${targetId}:${type}`, Date.now() + SELF_ACTION_TTL_MS);
    }

    _isRecentSelfAction(guildId, targetId, type) {
        const key = `${guildId}:${targetId}:${type}`;
        const exp = this._recentSelfActions.get(key);
        if (!exp) return false;
        if (exp < Date.now()) { this._recentSelfActions.delete(key); return false; }
        return true;
    }

    _emit(record) {
        // let other cogs (log-store, dashboard ws) observe new cases
        this.client.emit('moderation:case', record);
    }

    _record(input) {
        const record = this.store.addCase(input);
        this._emit(record);
        return record;
    }

    // ── Member DM ─────────────────────────────────────────────────────────────
    async _dmMember(guild, userId, { reason, type, duration }) {
        const settings = this.store.getSettings(guild.id);
        if (!settings.dmOnPunish) return false;
        try {
            const user = await this.client.users.fetch(userId);
            const verb = DM_VERB[type] || type;
            const embed = new EmbedBuilder()
                .setColor(0x4b5563)
                .setTitle(`You have been ${verb} in ${guild.name}`)
                .setTimestamp(new Date());
            const lines = [];
            if (reason) lines.push(`**Reason:** ${reason}`);
            if (duration) lines.push(`**Duration:** ${humanizeDuration(duration)}`);
            if (lines.length) embed.setDescription(lines.join('\n'));
            await user.send({ embeds: [embed] });
            return true;
        } catch {
            return false; // DMs closed / not shared a guild - non-fatal
        }
    }

    // ── Enforcement API ───────────────────────────────────────────────────────
    // Every method resolves to { ok, case?, error?, dmSent? }.

    async note({ guild, targetId, moderator, reason }) {
        const record = this._record({
            guildId: guild.id, type: 'note', targetId,
            targetTag: await this._tag(targetId),
            moderatorId: moderator?.id, moderatorTag: moderator?.tag,
            source: 'kitbot', reason
        });
        return { ok: true, case: record };
    }

    async warn({ guild, targetId, moderator, reason, points = 1 }) {
        const tag = await this._tag(targetId);
        const dmSent = await this._dmMember(guild, targetId, { reason, type: 'warn' });
        this._markSelfAction(guild.id, targetId, 'warn');
        const settings = this.store.getSettings(guild.id);
        const expiresAt = settings.warnDecayDays > 0
            ? Date.now() + settings.warnDecayDays * 86400_000
            : null;
        const record = this._record({
            guildId: guild.id, type: 'warn', targetId, targetTag: tag,
            moderatorId: moderator?.id, moderatorTag: moderator?.tag,
            source: 'kitbot', reason, points, expiresAt
        });
        const escalation = await this._maybeEscalate(guild, targetId, moderator);
        return { ok: true, case: record, dmSent, escalation };
    }

    async timeout({ guild, targetId, moderator, reason, duration }) {
        const ms = Math.min(Math.max(1, Number(duration) || 0) * 1000, MAX_TIMEOUT_MS);
        const member = await this._member(guild, targetId);
        if (!member) return { ok: false, error: 'Member not in guild.' };
        const dmSent = await this._dmMember(guild, targetId, { reason, type: 'timeout', duration: ms / 1000 });
        try {
            await member.timeout(ms, reason || undefined);
        } catch (e) {
            return { ok: false, error: `Discord refused the timeout: ${e.message}` };
        }
        this._markSelfAction(guild.id, targetId, 'timeout');
        const record = this._record({
            guildId: guild.id, type: 'timeout', targetId, targetTag: member.user.tag,
            moderatorId: moderator?.id, moderatorTag: moderator?.tag,
            source: 'kitbot', reason, duration: ms / 1000, expiresAt: Date.now() + ms, active: true
        });
        return { ok: true, case: record, dmSent };
    }

    async removeTimeout({ guild, targetId, moderator, reason }) {
        const member = await this._member(guild, targetId);
        if (!member) return { ok: false, error: 'Member not in guild.' };
        try {
            await member.timeout(null, reason || undefined);
        } catch (e) {
            return { ok: false, error: e.message };
        }
        this._markSelfAction(guild.id, targetId, 'untimeout');
        this._deactivate(guild.id, targetId, 'timeout');
        const record = this._record({
            guildId: guild.id, type: 'untimeout', targetId, targetTag: member.user.tag,
            moderatorId: moderator?.id, moderatorTag: moderator?.tag, source: 'kitbot', reason
        });
        return { ok: true, case: record };
    }

    async kick({ guild, targetId, moderator, reason }) {
        const member = await this._member(guild, targetId);
        if (!member) return { ok: false, error: 'Member not in guild.' };
        const tag = member.user.tag;
        const dmSent = await this._dmMember(guild, targetId, { reason, type: 'kick' });
        try {
            await member.kick(reason || undefined);
        } catch (e) {
            return { ok: false, error: `Discord refused the kick: ${e.message}` };
        }
        this._markSelfAction(guild.id, targetId, 'kick');
        const record = this._record({
            guildId: guild.id, type: 'kick', targetId, targetTag: tag,
            moderatorId: moderator?.id, moderatorTag: moderator?.tag, source: 'kitbot', reason
        });
        return { ok: true, case: record, dmSent };
    }

    async ban({ guild, targetId, moderator, reason, deleteMessageSeconds = 0 }) {
        const tag = await this._tag(targetId);
        const dmSent = await this._dmMember(guild, targetId, { reason, type: 'ban' });
        try {
            await guild.members.ban(targetId, { reason: reason || undefined, deleteMessageSeconds });
        } catch (e) {
            return { ok: false, error: `Discord refused the ban: ${e.message}` };
        }
        this._markSelfAction(guild.id, targetId, 'ban');
        const record = this._record({
            guildId: guild.id, type: 'ban', targetId, targetTag: tag,
            moderatorId: moderator?.id, moderatorTag: moderator?.tag, source: 'kitbot', reason, active: true
        });
        return { ok: true, case: record, dmSent };
    }

    async softban({ guild, targetId, moderator, reason }) {
        // ban (purges recent messages) then immediately unban - a "clean kick".
        const r = await this.ban({ guild, targetId, moderator, reason, deleteMessageSeconds: 7 * 86400 });
        if (!r.ok) return r;
        try { await guild.bans.remove(targetId, 'softban: auto-unban'); } catch { /* ignore */ }
        this._deactivate(guild.id, targetId, 'ban');
        this.store.updateCase(r.case.id, { type: 'softban', active: false });
        return { ok: true, case: this.store.getCase(r.case.id) };
    }

    async tempban({ guild, targetId, moderator, reason, duration, deleteMessageSeconds = 0 }) {
        const seconds = Math.max(1, Number(duration) || 0);
        const dmSent = await this._dmMember(guild, targetId, { reason, type: 'tempban', duration: seconds });
        try {
            await guild.members.ban(targetId, { reason: reason || undefined, deleteMessageSeconds });
        } catch (e) {
            return { ok: false, error: `Discord refused the ban: ${e.message}` };
        }
        this._markSelfAction(guild.id, targetId, 'ban');
        const record = this._record({
            guildId: guild.id, type: 'tempban', targetId, targetTag: await this._tag(targetId),
            moderatorId: moderator?.id, moderatorTag: moderator?.tag,
            source: 'kitbot', reason, duration: seconds, expiresAt: Date.now() + seconds * 1000, active: true
        });
        return { ok: true, case: record, dmSent };
    }

    async unban({ guild, targetId, moderator, reason }) {
        try {
            await guild.bans.remove(targetId, reason || undefined);
        } catch (e) {
            return { ok: false, error: `Discord refused the unban: ${e.message}` };
        }
        this._markSelfAction(guild.id, targetId, 'unban');
        this._deactivate(guild.id, targetId, 'ban');
        this._deactivate(guild.id, targetId, 'tempban');
        const record = this._record({
            guildId: guild.id, type: 'unban', targetId, targetTag: await this._tag(targetId),
            moderatorId: moderator?.id, moderatorTag: moderator?.tag, source: 'kitbot', reason
        });
        return { ok: true, case: record };
    }

    // ── Escalation ────────────────────────────────────────────────────────────
    async _maybeEscalate(guild, targetId, moderator) {
        const settings = this.store.getSettings(guild.id);
        if (!settings.escalation?.enabled) return null;
        const points = this.store.getActiveWarnPoints(guild.id, targetId);
        const rules = [...(settings.escalation.rules || [])].sort((a, b) => a.points - b.points);
        const rule = rules.filter(r => points >= r.points).pop();
        if (!rule) return null;

        // Don't re-fire the same threshold: skip if we already escalated at >= this rule's points.
        const already = this.store.listCases({ guildId: guild.id, targetId, source: 'kitbot' }).cases
            .some(c => c.meta?.escalationPoints && c.meta.escalationPoints >= rule.points);
        if (already) return null;

        const reason = `Auto-escalation (${points} warn pts → ${rule.action})`;
        const meta = { escalationPoints: rule.points };
        let result;
        switch (rule.action) {
            case 'timeout': result = await this.timeout({ guild, targetId, moderator, reason, duration: rule.duration || 3600 }); break;
            case 'kick': result = await this.kick({ guild, targetId, moderator, reason }); break;
            case 'ban': result = await this.ban({ guild, targetId, moderator, reason }); break;
            default: return null;
        }
        if (result?.ok && result.case) this.store.updateCase(result.case.id, { meta });
        return { rule, result };
    }

    // ── Audit-log ingestion ───────────────────────────────────────────────────
    async handleAuditEntry(entry) {
        const guild = entry.guild || this.client.guilds.cache.get(entry.guildId);
        if (!guild) return;

        const type = mapAuditAction(entry);
        if (!type) return; // not a moderation action we track

        const targetId = entry.targetId || entry.target?.id;
        if (!targetId) return;

        // Skip our own action's echo (we already recorded it).
        if (this._isRecentSelfAction(guild.id, targetId, type)) return;

        const settings = this.store.getSettings(guild.id);
        const source = this._sourceFromExecutor(entry, settings);
        // kitbot is the only "self" source; if the executor is us but we somehow
        // missed the self-action window, still skip to avoid duplicates.
        if (source === 'kitbot') return;

        const executor = entry.executor || (entry.executorId ? await this.client.users.fetch(entry.executorId).catch(() => null) : null);
        const targetTag = entry.target?.tag || (await this._tag(targetId));

        const record = this._record({
            guildId: guild.id, type, targetId, targetTag,
            moderatorId: entry.executorId || null,
            moderatorTag: executor?.tag || null,
            source,
            reason: entry.reason || null,
            duration: type === 'timeout' ? timeoutSecondsFromEntry(entry) : null,
            expiresAt: type === 'timeout' ? timeoutExpiryFromEntry(entry) : null,
            active: type === 'ban' || type === 'timeout',
            meta: { auditEntryId: entry.id }
        });

        if (type === 'unban') { this._deactivate(guild.id, targetId, 'ban'); this._deactivate(guild.id, targetId, 'tempban'); }
        if (type === 'untimeout') this._deactivate(guild.id, targetId, 'timeout');
        return record;
    }

    _sourceFromExecutor(entry, settings) {
        const id = entry.executorId;
        if (!id) return 'manual';
        if (id === this.client.user?.id) return 'kitbot';
        if (settings.wickBotId && id === settings.wickBotId) return 'wick';
        if (entry.executor?.bot) return 'automod';
        return 'manual';
    }

    // ── Expiry sweep ──────────────────────────────────────────────────────────
    async _sweep() {
        this.store.expireWarns();
        const due = this.store.getDuePunishments();
        for (const c of due) {
            const guild = this.client.guilds.cache.get(c.guildId);
            if (!guild) continue;
            try {
                if (c.type === 'tempban') {
                    await guild.bans.remove(c.targetId, 'tempban expired').catch(() => {});
                    this._markSelfAction(c.guildId, c.targetId, 'unban');
                    this._record({
                        guildId: c.guildId, type: 'unban', targetId: c.targetId, targetTag: c.targetTag,
                        moderatorId: this.client.user?.id, moderatorTag: this.client.user?.tag,
                        source: 'kitbot', reason: `Auto: tempban #${c.seq} expired`
                    });
                }
                // timeouts auto-lift on Discord's side; just settle bookkeeping.
                this.store.updateCase(c.id, { active: false });
            } catch (e) {
                console.error(`[MODERATION] expiry sweep on case ${c.id} failed: ${e.message}`);
            }
        }
    }

    _deactivate(guildId, targetId, type) {
        for (const c of this.store.listCases({ guildId, targetId, type, active: true }).cases) {
            this.store.updateCase(c.id, { active: false });
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    async _member(guild, userId) {
        if (!guild?.members?.fetch) return null;
        return guild.members.fetch(userId).catch(() => null);
    }

    async _tag(userId) {
        const user = await this.client.users.fetch(userId).catch(() => null);
        return user?.tag || null;
    }

    // ── Public read API (used by the dashboard) ───────────────────────────────
    async getMemberProfile(guildId, userId) {
        const guild = this.client.guilds.cache.get(guildId);
        const member = guild ? await this._member(guild, userId) : null;
        let user = member?.user;
        if (!user) user = await this.client.users.fetch(userId, { force: true }).catch(() => null);
        else user = await user.fetch(true).catch(() => user); // force fetch to get banner
        
        const history = this.store.getMemberHistory(guildId, userId);

        // Actions this user has executed as a moderator (audit-log-attributed cases
        // carry a moderatorId; dashboard-issued ones don't, so those won't match).
        const executedList = this.store.listCases({ guildId, moderatorId: userId, limit: 200 });
        const executed = {
            count: executedList.total ?? (executedList.cases || []).length,
            recent: (executedList.cases || []).slice(0, 10)
        };

        // Last-active / XP from the leveling cog (Discord exposes no "last seen").
        const activity = this.client.cogs?.leveling?.getUserActivity?.(guildId, userId) || null;

        return {
            user: user ? {
                id: user.id,
                tag: user.tag,
                globalName: user.globalName || null,
                avatar: user.displayAvatarURL?.({ size: 128 }),
                banner: user.bannerURL?.({ size: 512 }),
                color: user.hexAccentColor,
                createdAt: user.createdAt?.getTime(),
                bot: user.bot,
                system: Boolean(user.system),
                badges: userFlagNames(user)
            } : { id: userId, tag: null },
            inGuild: Boolean(member),
            member: member ? {
                nickname: member.nickname,
                serverAvatar: member.avatarURL?.({ size: 128 }) || null,
                joinedAt: member.joinedAt?.getTime(),
                premiumSince: member.premiumSince?.getTime(),
                timedOutUntil: member.communicationDisabledUntil?.getTime(),
                voiceChannel: member.voice?.channel ? { id: member.voice.channelId, name: member.voice.channel.name } : null,
                roles: [...member.roles.cache.values()]
                    .filter(r => r.name !== '@everyone')
                    .sort((a, b) => b.position - a.position)
                    .map(r => ({ name: r.name, color: r.hexColor })),
                hierarchy: memberHierarchy(member, guild)
            } : null,
            executed,
            activity,
            ...history
        };
    }

    listCases(filter) { return this.store.listCases(filter); }
    getSettings(guildId) { return this.store.getSettings(guildId); }
    setSettings(guildId, patch) { return this.store.setSettings(guildId, patch); }
    getStats(guildId) { return this.store.getStats(guildId); }
}

// ── Pure helpers ───────────────────────────────────────────────────────────
const DM_VERB = {
    warn: 'warned', timeout: 'timed out', kick: 'kicked', ban: 'banned',
    tempban: 'temporarily banned', softban: 'softbanned'
};

function mapAuditAction(entry) {
    switch (entry.action) {
        case AuditLogEvent.MemberKick: return 'kick';
        case AuditLogEvent.MemberBanAdd: return 'ban';
        case AuditLogEvent.MemberBanRemove: return 'unban';
        case AuditLogEvent.MemberUpdate: {
            const change = (entry.changes || []).find(c => c.key === 'communication_disabled_until');
            if (!change) return null;
            const future = change.new && new Date(change.new).getTime() > Date.now();
            return future ? 'timeout' : 'untimeout';
        }
        default: return null;
    }
}

function timeoutSecondsFromEntry(entry) {
    const change = (entry.changes || []).find(c => c.key === 'communication_disabled_until');
    if (!change?.new) return null;
    const ms = new Date(change.new).getTime() - Date.now();
    return ms > 0 ? Math.round(ms / 1000) : null;
}

function timeoutExpiryFromEntry(entry) {
    const change = (entry.changes || []).find(c => c.key === 'communication_disabled_until');
    if (!change?.new) return null;
    const ts = new Date(change.new).getTime();
    return ts > Date.now() ? ts : null;
}

function humanizeDuration(seconds) {
    if (!seconds) return '-';
    const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
    let rem = Math.round(seconds);
    const parts = [];
    for (const [label, size] of units) {
        if (rem >= size) { parts.push(`${Math.floor(rem / size)}${label}`); rem %= size; }
    }
    return parts.slice(0, 2).join(' ') || '0s';
}

// Readable Discord badge/flag names for a user (empty if flags weren't fetched).
function userFlagNames(user) {
    try { return user.flags?.toArray?.() || []; }
    catch { return []; }
}

// Server-side moderator state + role hierarchy for the member profile.
function memberHierarchy(member, guild) {
    const P = PermissionsBitField.Flags;
    const perms = member.permissions;
    const has = flag => { try { return perms.has(flag); } catch { return false; } };
    const top = member.roles?.highest;
    const me = guild?.members?.me;
    const isAdmin = has(P.Administrator);
    const can = {
        admin: isAdmin,
        ban: isAdmin || has(P.BanMembers),
        kick: isAdmin || has(P.KickMembers),
        timeout: isAdmin || has(P.ModerateMembers),
        manageMessages: isAdmin || has(P.ManageMessages),
        manageRoles: isAdmin || has(P.ManageRoles),
        manageGuild: isAdmin || has(P.ManageGuild)
    };
    return {
        isModerator: can.admin || can.ban || can.kick || can.timeout || can.manageMessages,
        permissions: can,
        topRole: top && top.name !== '@everyone' ? { name: top.name, color: top.hexColor, position: top.position } : null,
        // Whether kitbot itself sits above this member (so dashboard actions can land).
        botCanAct: Boolean(me && top && me.roles.highest.position > top.position && !can.admin && guild.ownerId !== member.id)
    };
}

module.exports = { ModerationCog, humanizeDuration };
