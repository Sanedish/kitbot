'use strict';

// MusicCog - kitbot jukebox.
//
// Plays files from the private streaming library (MUSIC_DIR) into a voice
// channel of the operator guild. Single-server / proprietary: the library is
// never exposed for download or browser playback - the dashboard and the
// Discord panel are control surfaces only.
//
// Signal paths:
//   Direct mode  : file ─ffmpeg→ ogg/opus ─→ Discord voice
//   Omnia mode   : file ─ffmpeg(-re)→ mp3 ─→ <machine_url>/kitbot_raw (HTTP/icecast feed)
//                                            └→ optional push to external Icecast (ICECAST_PUSH_URL)
//                  OMNIA_INPUT_URL ─ffmpeg→ ogg/opus ─→ Discord voice
//
// In Omnia mode the broadcast processor pulls the raw feed, processes it, and
// the bot plays the processed return stream into Discord. The raw feed is sent
// at unity gain (volume is applied on the processed return) so the processor
// always sees a clean signal.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    ChannelType,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    entersState,
    generateDependencyReport
} = require('@discordjs/voice');

const AUDIO_EXTENSIONS = new Set([
    '.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.aiff', '.aif', '.mka'
]);
const MUSIC_STATE_FILE = process.env.MUSIC_STATE_FILE || path.join(__dirname, '..', 'data', 'music_state.json');
const RAW_MOUNT = '/kitbot_raw';
const ACTION_LOG_LIMIT = 60;
const SELECT_PAGE_SIZE = 24;
const QUEUE_LIMIT = 200;
const PROCESSED_RETRY_MS = 4000;
const ICECAST_RETRY_MS = 5000;
const RAW_SILENCE_RETRY_MS = 5000;

const LOOP_MODES = ['off', 'track', 'queue'];
const normalizeLoop = mode => {
    const value = String(mode || '').toLowerCase();
    if (['track', 'song', 'one', 'single', 'current'].includes(value)) return 'track';
    if (['queue', 'all', 'on'].includes(value)) return 'queue';
    if (['off', 'none', 'stop', 'disable'].includes(value)) return 'off';
    return LOOP_MODES.includes(value) ? value : null;
};
const LOOP_GLYPH = { off: '➡', track: '🔂', queue: '🔁' };

const clampVolume = value => Math.min(200, Math.max(0, Math.round(Number(value) || 0)));

const formatClock = totalSeconds => {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
    const seconds = Math.floor(totalSeconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
};

class MusicCog {
    /**
     * @param {import('discord.js').Client} client
     * @param {{ getConfig: () => any, isPrivilegedUser: (userId: string) => boolean }} options
     */
    constructor(client, options) {
        this.client = client;
        this.getConfig = options.getConfig;
        this.isPrivilegedUser = options.isPrivilegedUser;

        this.musicDir = process.env.MUSIC_DIR || './music';
        // Folder names skipped by the library scanner, comma separated.
        this.excludeDirs = new Set(
            String(process.env.MUSIC_EXCLUDE_DIRS || '')
                .split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
        );
        this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
        this.omniaInputUrl = process.env.OMNIA_INPUT_URL || '';
        this.icecastPushUrl = process.env.ICECAST_PUSH_URL || '';

        this.events = new EventEmitter();
        this.events.setMaxListeners(50);

        // Library index. Ids are per-scan; scanId guards stale references.
        this.library = { scanId: 0, scannedAt: null, error: null, dirs: new Map(), files: new Map(), rootId: null };

        // Persisted knobs.
        this.persisted = this._loadPersistedState();
        this.volume = clampVolume(this.persisted.volume ?? 100);
        this.locked = Boolean(this.persisted.locked);
        this.omniaEnabled = Boolean(this.persisted.omniaEnabled);
        this.loopMode = normalizeLoop(this.persisted.loopMode) || 'off';

        // Playback state.
        this.queue = [];
        this.nowPlaying = null;      // { track, durationSec, startedAtMs, baseOffsetMs, pausedElapsedMs, paused }
        this.trackProcess = null;    // ffmpeg decoding the current track (both modes)
        this.processedProcess = null;// ffmpeg pulling the Omnia return stream
        this.processedRetryTimer = null;
        this.icecastProcess = null;  // optional push of the raw feed to an external Icecast server
        this.icecastRetryTimer = null;
        this.rawSilenceProcess = null; // keeps /kitbot_raw an always-active mp3 stream while idle
        this.rawSilenceRetryTimer = null;
        this.rawClients = new Set(); // HTTP responses subscribed to the raw feed
        this.actionLog = [];

        this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        this.voiceConnection = null;
        this.voiceChannelId = null;

        this.audioPlayer.on('error', error => {
            console.error(`[MUSIC] Audio player error: ${error.message}`);
        });
        this.audioPlayer.on(AudioPlayerStatus.Idle, () => this._onPlayerIdle());
    }

    async start() {
        if (this._started) return;
        this._started = true;
        await this.rescanLibrary();
        this._ensureRawSilence();
        this._ensureIcecastPush();
        this._logDaveStatus();
        console.log(`[MUSIC] Jukebox ready. Library root: ${this.musicDir} (${this.library.files.size} tracks). Omnia: ${this.omniaEnabled ? 'on' : 'off'}.`);
    }

    stop() {
        this._stopTrackProcess();
        this._stopProcessedStream();
        this._stopIcecastPush();
        this._stopRawSilence();
        for (const res of this.rawClients) res.destroy();
        this.rawClients.clear();
        if (this.voiceConnection) {
            this.voiceConnection.destroy();
            this.voiceConnection = null;
        }
    }

    _logDaveStatus() {
        const report = generateDependencyReport();
        const daveLine = report.split(/\r?\n/).find(line => line.includes('@snazzah/davey')) || '- @snazzah/davey: not found';
        console.log(`[MUSIC] Discord voice DAVE support: ${daveLine.replace(/^\s*-\s*/, '')}.`);
    }

    // ─── Persistence ────────────────────────────────────────────────────────

    _loadPersistedState() {
        try {
            return JSON.parse(fs.readFileSync(MUSIC_STATE_FILE, 'utf8'));
        } catch {
            return {};
        }
    }

    _savePersistedState() {
        this.persisted.volume = this.volume;
        this.persisted.locked = this.locked;
        this.persisted.omniaEnabled = this.omniaEnabled;
        this.persisted.loopMode = this.loopMode;
        try {
            fs.writeFileSync(MUSIC_STATE_FILE, JSON.stringify(this.persisted, null, 2));
        } catch (error) {
            console.error(`[MUSIC] Failed to persist state: ${error.message}`);
        }
    }

    /** Stable secret for dashboard session cookies, survives restarts. */
    getSessionSecret() {
        if (!this.persisted.sessionSecret) {
            this.persisted.sessionSecret = crypto.randomBytes(32).toString('hex');
            this._savePersistedState();
        }
        return this.persisted.sessionSecret;
    }

    // ─── Permissions ────────────────────────────────────────────────────────

    isAdminMember(member) {
        if (!member) return false;
        if (this.isPrivilegedUser(member.id)) return true;
        if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
        if (member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)) return true;
        const adminRoleIds = this.getConfig().music_admin_role_ids || [];
        return adminRoleIds.some(roleId => member.roles?.cache?.has?.(roleId));
    }

    /**
     * Gate a user-level action. Admins always pass - they overwrite user
     * commands and ignore the lock. Returns { ok, reason }.
     */
    _authorize(actor) {
        if (actor?.admin) return { ok: true };
        if (this.locked) return { ok: false, code: 'locked', reason: 'Playback is locked by an admin right now.' };
        return { ok: true };
    }

    _requireAdmin(actor) {
        if (actor?.admin) return { ok: true };
        return { ok: false, code: 'forbidden', reason: 'That action is admin-only.' };
    }

    _log(actor, action, detail = '') {
        this.actionLog.unshift({
            at: Date.now(),
            actor: actor ? `${actor.name}${actor.god ? ' [owner]' : actor.admin ? ' [admin]' : ''}` : 'system',
            action,
            detail
        });
        if (this.actionLog.length > ACTION_LOG_LIMIT) this.actionLog.length = ACTION_LOG_LIMIT;
    }

    // ─── Library ────────────────────────────────────────────────────────────

    async rescanLibrary() {
        const dirs = new Map();
        const files = new Map();
        let nextId = 1;
        const scanId = this.library.scanId + 1;

        const rootStat = await fs.promises.stat(this.musicDir).catch(() => null);
        if (!rootStat?.isDirectory()) {
            this.library = { scanId, scannedAt: Date.now(), error: `Library root not found: ${this.musicDir}`, dirs, files, rootId: null };
            console.error(`[MUSIC] ${this.library.error}`);
            this._emitState();
            return this.library;
        }

        const walk = async (absPath, rel, parentId) => {
            const dirId = nextId++;
            const dir = { id: dirId, name: rel ? path.basename(rel) : 'Library', rel, parentId, dirIds: [], fileIds: [] };
            dirs.set(dirId, dir);

            const entries = await fs.promises.readdir(absPath, { withFileTypes: true }).catch(() => []);
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                if (entry.isDirectory() && this.excludeDirs.has(entry.name.toLowerCase())) continue;
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    const childId = await walk(path.join(absPath, entry.name), childRel, dirId);
                    dir.dirIds.push(childId);
                } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    const fileId = nextId++;
                    files.set(fileId, {
                        id: fileId,
                        name: path.basename(entry.name, path.extname(entry.name)),
                        rel: childRel,
                        dirId,
                        ext: path.extname(entry.name).toLowerCase()
                    });
                    dir.fileIds.push(fileId);
                }
            }
            return dirId;
        };

        const rootId = await walk(this.musicDir, '', null);
        this.library = { scanId, scannedAt: Date.now(), error: null, dirs, files, rootId };
        this._emitState();
        return this.library;
    }

    getFile(fileId) {
        return this.library.files.get(Number(fileId)) || null;
    }

    getDirListing(dirId) {
        const dir = this.library.dirs.get(Number(dirId) || this.library.rootId) || this.library.dirs.get(this.library.rootId);
        if (!dir) return null;
        const crumbs = [];
        for (let cursor = dir; cursor; cursor = this.library.dirs.get(cursor.parentId)) {
            crumbs.unshift({ id: cursor.id, name: cursor.name });
        }
        return {
            scanId: this.library.scanId,
            id: dir.id,
            name: dir.name,
            parentId: dir.parentId,
            crumbs,
            dirs: dir.dirIds.map(id => {
                const child = this.library.dirs.get(id);
                return { id: child.id, name: child.name, dirCount: child.dirIds.length, fileCount: child.fileIds.length };
            }),
            files: dir.fileIds.map(id => {
                const file = this.library.files.get(id);
                return { id: file.id, name: file.name, rel: file.rel, ext: file.ext };
            })
        };
    }

    searchLibrary(query, limit = 25) {
        const needle = String(query || '').toLowerCase().trim();
        if (!needle) return [];
        const terms = needle.split(/\s+/);
        const results = [];
        for (const file of this.library.files.values()) {
            const haystack = file.rel.toLowerCase();
            if (terms.every(term => haystack.includes(term))) {
                results.push({ id: file.id, name: file.name, rel: file.rel, ext: file.ext });
                if (results.length >= limit) break;
            }
        }
        return results;
    }

    /** Find a library file by its path relative to the library root. */
    _fileByRel(rel) {
        const needle = String(rel || '').split(path.sep).join('/');
        for (const file of this.library.files.values()) {
            if (file.rel === needle) return file;
        }
        return null;
    }

    /** Resolve a query to a playable library file. Returns { ok, file, source, reason? }. */
    async acquireTrack(query) {
        const local = this.searchLibrary(query, 5);
        if (local.length) return { ok: true, file: this.getFile(local[0].id), source: 'library' };
        return { ok: false, reason: `No library match for \`${query}\`.` };
    }

    _probeTrack(absPath) {
        return new Promise(resolve => {
            const probe = spawn(this.ffprobePath, [
                '-v', 'error',
                '-show_entries', 'format=duration:format_tags=title,artist',
                '-of', 'json',
                absPath
            ], { windowsHide: true });
            let output = '';
            probe.stdout.on('data', chunk => { output += chunk; });
            probe.on('error', () => resolve(null));
            probe.on('close', () => {
                try {
                    const parsed = JSON.parse(output);
                    resolve({
                        durationSec: Number(parsed?.format?.duration) || null,
                        title: parsed?.format?.tags?.title || parsed?.format?.tags?.TITLE || null,
                        artist: parsed?.format?.tags?.artist || parsed?.format?.tags?.ARTIST || null
                    });
                } catch {
                    resolve(null);
                }
            });
        });
    }

    // ─── Voice connection ───────────────────────────────────────────────────

    _commandGuildIds() {
        const cfg = this.getConfig();
        return new Set([cfg.operator_guild_id, cfg.test_guild_id]
            .filter(Boolean)
            .map(id => String(id)));
    }

    _isCommandGuild(guildId) {
        return this._commandGuildIds().has(String(guildId));
    }

    listVoiceChannels() {
        const guilds = [...this._commandGuildIds()]
            .map(guildId => this.client.guilds?.cache?.get(guildId))
            .filter(Boolean);
        const channels = [];
        for (const guild of guilds) {
            const guildChannels = guild.channels.cache
                .filter(channel => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
                .sort((a, b) => a.rawPosition - b.rawPosition)
                .map(channel => ({
                    id: channel.id,
                    name: guilds.length > 1 ? `${guild.name} / ${channel.name}` : channel.name
                }));
            channels.push(...guildChannels);
        }
        return channels;
    }

    async joinChannel(channelId, actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;

        const channel = this.client.channels?.cache?.get(channelId);
        if (!channel ||
            (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) ||
            !this._isCommandGuild(channel.guildId)) {
            return { ok: false, reason: 'That is not a voice channel in the operator or test server.' };
        }
        const guild = channel.guild;

        try {
            this.voiceConnection = joinVoiceChannel({
                channelId: channel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true,
                daveEncryption: true
            });
            this.voiceConnection.subscribe(this.audioPlayer);
            this.voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(this.voiceConnection, VoiceConnectionStatus.Signalling, 5000),
                        entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5000)
                    ]);
                } catch {
                    this.voiceConnection?.destroy();
                    this.voiceConnection = null;
                    this.voiceChannelId = null;
                    this._emitState();
                }
            });
            await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 15000);
            this._scheduleDaveCheck();
        } catch (error) {
            console.error(`[MUSIC] Failed to join voice channel ${channelId}: ${error.message}`);
            this.voiceConnection?.destroy();
            this.voiceConnection = null;
            this.voiceChannelId = null;
            this._emitState();
            return { ok: false, reason: 'Could not connect to that voice channel.' };
        }

        this.voiceChannelId = channel.id;
        this.persisted.lastChannelId = channel.id;
        this._savePersistedState();
        this._log(actor, 'join', `#${channel.name}`);

        // Resume the session: restart whatever should be audible.
        if (this.omniaEnabled) this._ensureProcessedStream();
        if (!this.nowPlaying && this.queue.length > 0) this._playNext();
        else if (this.nowPlaying && !this.trackProcess && !this.nowPlaying.paused) this._startPipeline(this.getElapsedMs() / 1000);

        this._emitState();
        return { ok: true };
    }

    leaveChannel(actor) {
        const gate = actor?.admin ? { ok: true } : this._authorize(actor);
        if (!gate.ok) return gate;
        this._stopTrackProcess();
        this._stopProcessedStream();
        this.nowPlaying = null;
        if (this.voiceConnection) {
            this.voiceConnection.destroy();
            this.voiceConnection = null;
        }
        this.voiceChannelId = null;
        this._log(actor, 'leave');
        this._emitState();
        return { ok: true };
    }

    // ─── Queue ──────────────────────────────────────────────────────────────

    enqueue(fileId, actor, { force = false, next = false } = {}) {
        if (force || next) {
            const adminGate = this._requireAdmin(actor);
            if (!adminGate.ok) return adminGate;
        }
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;

        const file = this.getFile(fileId);
        if (!file) return { ok: false, reason: 'Unknown track. The library may have been rescanned - refresh and retry.' };
        if (!actor?.god && this.queue.length >= QUEUE_LIMIT) return { ok: false, reason: 'The queue is full.' };

        const item = {
            uid: crypto.randomUUID(),
            fileId: file.id,
            name: file.name,
            rel: file.rel,
            requestedBy: { id: actor.id, name: actor.name, admin: Boolean(actor.admin) },
            pinned: Boolean(force && actor.admin)
        };

        if (force) {
            this.queue.unshift(item);
            this._log(actor, 'force-play', file.rel);
            this._advance();                      // interrupts the current track
        } else {
            if (next) this.queue.unshift(item);
            else this.queue.push(item);
            this._log(actor, next ? 'queue-next' : 'queue', file.rel);
            if (!this.nowPlaying) this._playNext();
        }
        this._emitState();
        return { ok: true, item };
    }

    removeFromQueue(uid, actor) {
        const index = this.queue.findIndex(item => item.uid === uid);
        if (index === -1) return { ok: false, reason: 'That item is no longer queued.' };
        const item = this.queue[index];
        if (!actor.admin) {
            const gate = this._authorize(actor);
            if (!gate.ok) return gate;
            if (item.requestedBy.id !== actor.id) return { ok: false, reason: 'You can only remove tracks you queued.' };
        }
        this.queue.splice(index, 1);
        this._log(actor, 'unqueue', item.rel);
        this._emitState();
        return { ok: true };
    }

    moveInQueue(uid, direction, actor) {
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) return adminGate;
        const index = this.queue.findIndex(item => item.uid === uid);
        if (index === -1) return { ok: false, reason: 'That item is no longer queued.' };
        const target = direction === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= this.queue.length) return { ok: false, reason: 'Cannot move further.' };
        const [item] = this.queue.splice(index, 1);
        this.queue.splice(target, 0, item);
        this._log(actor, 'reorder', item.rel);
        this._emitState();
        return { ok: true };
    }

    clearQueue(actor) {
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) return adminGate;
        this.queue = [];
        this._log(actor, 'clear-queue');
        this._emitState();
        return { ok: true };
    }

    // ─── Transport ──────────────────────────────────────────────────────────

    skip(actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        if (!this.nowPlaying) return { ok: false, reason: 'Nothing is playing.' };
        if (this.nowPlaying.track.pinned && !actor.admin) {
            return { ok: false, reason: 'An admin pinned this track - only admins can skip it.' };
        }
        this._log(actor, 'skip', this.nowPlaying.track.rel);
        this._advance();
        return { ok: true };
    }

    stopPlayback(actor) {
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) return adminGate;
        this.queue = [];
        this._stopTrackProcess();
        if (!this.omniaEnabled) this.audioPlayer.stop(true);
        this.nowPlaying = null;
        this._log(actor, 'stop');
        this._emitState();
        return { ok: true };
    }

    pause(actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        if (!this.nowPlaying || this.nowPlaying.paused) return { ok: false, reason: 'Nothing to pause.' };
        if (this.nowPlaying.track.pinned && !actor.admin) {
            return { ok: false, reason: 'An admin pinned this track - only admins can pause it.' };
        }

        this.nowPlaying.pausedElapsedMs = this.getElapsedMs();
        this.nowPlaying.paused = true;
        if (this.omniaEnabled) {
            // The Omnia return is a live stream; freeze the source feed instead.
            this._stopTrackProcess();
        } else {
            this.audioPlayer.pause(true);
        }
        this._log(actor, 'pause', this.nowPlaying.track.rel);
        this._emitState();
        return { ok: true };
    }

    resume(actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        if (!this.nowPlaying || !this.nowPlaying.paused) return { ok: false, reason: 'Nothing is paused.' };

        this.nowPlaying.paused = false;
        if (this.omniaEnabled) {
            this._startPipeline(this.nowPlaying.pausedElapsedMs / 1000);
        } else {
            this.audioPlayer.unpause();
            this.nowPlaying.startedAtMs = Date.now() - this.nowPlaying.pausedElapsedMs;
        }
        this._log(actor, 'resume', this.nowPlaying.track.rel);
        this._emitState();
        return { ok: true };
    }

    seek(seconds, actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        if (!this.nowPlaying) return { ok: false, reason: 'Nothing is playing.' };
        const target = Math.max(0, Number(seconds) || 0);
        this._log(actor, 'seek', `${formatClock(target)} ${this.nowPlaying.track.rel}`);
        if (this.nowPlaying.paused) {
            this.nowPlaying.pausedElapsedMs = target * 1000;
        } else {
            this._startPipeline(target);
        }
        this._emitState();
        return { ok: true };
    }

    setVolume(value, actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        this.volume = clampVolume(value);
        this._savePersistedState();
        this._log(actor, 'volume', `${this.volume}%`);
        if (this.omniaEnabled) {
            // Volume lives on the processed return; raw feed stays at unity gain.
            this._stopProcessedStream();
            this._ensureProcessedStream();
        } else if (this.nowPlaying && !this.nowPlaying.paused) {
            this._startPipeline(this.getElapsedMs() / 1000);
        }
        this._emitState();
        return { ok: true };
    }

    setLocked(locked, actor) {
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) return adminGate;
        this.locked = Boolean(locked);
        this._savePersistedState();
        this._log(actor, this.locked ? 'lock' : 'unlock');
        this._emitState();
        return { ok: true };
    }

    setLoop(mode, actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        const normalized = normalizeLoop(mode);
        if (!normalized) return { ok: false, reason: 'Loop mode must be `off`, `track`, or `queue`.' };
        this.loopMode = normalized;
        this._savePersistedState();
        this._log(actor, 'loop', normalized);
        this._emitState();
        return { ok: true, mode: normalized };
    }

    /** Cycle off → track → queue → off. Used by the panel button. */
    cycleLoop(actor) {
        const next = LOOP_MODES[(LOOP_MODES.indexOf(this.loopMode) + 1) % LOOP_MODES.length];
        return this.setLoop(next, actor);
    }

    shuffleQueue(actor) {
        const gate = this._authorize(actor);
        if (!gate.ok) return gate;
        if (this.queue.length < 2) return { ok: false, reason: 'Not enough tracks in the queue to shuffle.' };
        // Fisher–Yates, but keep admin-pinned tracks anchored at the front.
        const pinned = this.queue.filter(item => item.pinned);
        const rest = this.queue.filter(item => !item.pinned);
        for (let i = rest.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        this.queue = [...pinned, ...rest];
        this._log(actor, 'shuffle', `${this.queue.length} tracks`);
        this._emitState();
        return { ok: true };
    }

    // ─── Playback engine ────────────────────────────────────────────────────

    /**
     * Natural end of the current track (player idle in direct mode, or the
     * source ffmpeg closing cleanly in Omnia mode). Applies the loop mode, then
     * advances. Manual skips go through _advance() and intentionally bypass loop.
     */
    _onTrackEnded() {
        const finished = this.nowPlaying?.track;
        this.nowPlaying = null;
        if (finished && this.loopMode === 'track') {
            this.queue.unshift({ ...finished, uid: crypto.randomUUID() });
        } else if (finished && this.loopMode === 'queue') {
            this.queue.push({ ...finished, uid: crypto.randomUUID() });
        }
        this._playNext();
    }

    getElapsedMs() {
        if (!this.nowPlaying) return 0;
        if (this.nowPlaying.paused) return this.nowPlaying.pausedElapsedMs;
        if (this.omniaEnabled) {
            return Date.now() - this.nowPlaying.startedAtMs;
        }
        const resource = this.audioPlayer.state.resource;
        return this.nowPlaying.baseOffsetMs + (resource?.playbackDuration ?? 0);
    }

    _advance() {
        this._stopTrackProcess();
        if (!this.omniaEnabled) this.audioPlayer.stop(true);
        this.nowPlaying = null;
        this._playNext();
    }

    _playNext() {
        if (this.nowPlaying || this.queue.length === 0) {
            this._emitState();
            return;
        }
        if (!this.voiceConnection) {
            this._emitState();
            return; // Hold the queue until the bot joins a channel.
        }

        const track = this.queue.shift();
        const file = this.getFile(track.fileId);
        if (!file) {
            console.error(`[MUSIC] Queued file vanished from library: ${track.rel}`);
            return this._playNext();
        }

        this.nowPlaying = {
            track,
            durationSec: null,
            title: track.name,
            artist: null,
            startedAtMs: Date.now(),
            baseOffsetMs: 0,
            pausedElapsedMs: 0,
            paused: false
        };

        const absPath = path.join(this.musicDir, file.rel);
        void this._probeTrack(absPath).then(meta => {
            if (!meta || this.nowPlaying?.track !== track) return;
            this.nowPlaying.durationSec = meta.durationSec;
            if (meta.title) this.nowPlaying.title = meta.title;
            if (meta.artist) this.nowPlaying.artist = meta.artist;
            this._emitState();
        });

        this._startPipeline(0);
        this._emitState();
    }

    /** (Re)start the ffmpeg pipeline for the current track at an offset (seconds). */
    _startPipeline(offsetSec) {
        if (!this.nowPlaying) return;
        const file = this.getFile(this.nowPlaying.track.fileId);
        if (!file) return this._advance();
        const absPath = path.join(this.musicDir, file.rel);

        this._stopTrackProcess();
        this.nowPlaying.paused = false;

        if (this.omniaEnabled) {
            this.nowPlaying.startedAtMs = Date.now() - offsetSec * 1000;
            this._spawnOmniaSource(absPath, offsetSec);
            this._ensureProcessedStream();
        } else {
            this.nowPlaying.baseOffsetMs = offsetSec * 1000;
            this._spawnDirectPipeline(absPath, offsetSec);
        }
    }

    /** Direct mode: track file → ogg/opus on stdout → Discord. */
    _spawnDirectPipeline(absPath, offsetSec) {
        const args = ['-hide_banner', '-loglevel', 'error'];
        if (offsetSec > 0) args.push('-ss', String(offsetSec));
        args.push(
            '-i', absPath,
            '-vn',
            '-af', `volume=${(this.volume / 100).toFixed(3)}`,
            '-ar', '48000', '-ac', '2',
            '-c:a', 'libopus', '-b:a', '192k',
            '-f', 'ogg', 'pipe:1'
        );
        const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
        this.trackProcess = proc;
        proc.stderr.on('data', chunk => console.error(`[MUSIC][ffmpeg] ${String(chunk).trim()}`));
        proc.on('error', error => {
            console.error(`[MUSIC] ffmpeg spawn failed: ${error.message}`);
            if (this.trackProcess === proc) this._advance();
        });
        // Track end in direct mode is signalled by the audio player going idle,
        // not by process exit (the demuxer buffers ahead of playback).
        const resource = createAudioResource(proc.stdout, { inputType: StreamType.OggOpus });
        this.audioPlayer.play(resource);
    }

    /** Omnia mode: track file → mp3 (realtime pace, unity gain) → raw feed fan-out. */
    _spawnOmniaSource(absPath, offsetSec) {
        const args = ['-hide_banner', '-loglevel', 'error', '-re'];
        if (offsetSec > 0) args.push('-ss', String(offsetSec));
        args.push(
            '-i', absPath,
            '-vn',
            '-ar', '44100', '-ac', '2',
            '-c:a', 'libmp3lame', '-b:a', '320k',
            '-f', 'mp3', 'pipe:1'
        );
        const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
        this.trackProcess = proc;
        proc.stderr.on('data', chunk => console.error(`[MUSIC][ffmpeg:source] ${String(chunk).trim()}`));
        proc.stdout.on('data', chunk => this._broadcastRawChunk(chunk));
        proc.on('error', error => {
            console.error(`[MUSIC] Omnia source ffmpeg spawn failed: ${error.message}`);
            if (this.trackProcess === proc) this._advance();
        });
        proc.on('close', code => {
            if (this.trackProcess !== proc) return; // superseded or intentionally killed
            this.trackProcess = null;
            if (code === 0) {
                // Natural end of track → apply loop, then advance the queue.
                this._onTrackEnded();
            } else if (this.nowPlaying && !this.nowPlaying.paused) {
                console.error(`[MUSIC] Omnia source exited with code ${code}; skipping track.`);
                this.nowPlaying = null;
                this._playNext();
            }
        });
    }

    _stopTrackProcess() {
        if (!this.trackProcess) return;
        const proc = this.trackProcess;
        this.trackProcess = null;
        proc.stdout?.removeAllListeners('data');
        proc.removeAllListeners('close');
        proc.kill('SIGKILL');
    }

    _onPlayerIdle() {
        if (this.omniaEnabled) {
            // The processed return stream dropped - recover it, playback state is untouched.
            if (this.voiceConnection) this._scheduleProcessedRetry();
            return;
        }
        if (this.nowPlaying && !this.nowPlaying.paused) {
            this._stopTrackProcess();
            this._onTrackEnded();
        }
    }

    // ─── Omnia mode ─────────────────────────────────────────────────────────

    setOmnia(enabled, actor) {
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) return adminGate;
        enabled = Boolean(enabled);
        if (enabled === this.omniaEnabled) return { ok: true };
        if (enabled && !this.omniaInputUrl) return { ok: false, reason: 'Set OMNIA_INPUT_URL in .env first.' };

        const elapsedSec = this.nowPlaying ? this.getElapsedMs() / 1000 : 0;
        const wasPaused = this.nowPlaying?.paused;

        this.omniaEnabled = enabled;
        this._savePersistedState();
        this._log(actor, enabled ? 'omnia-on' : 'omnia-off');

        this._stopTrackProcess();
        this.audioPlayer.stop(true);

        if (enabled) {
            if (this.voiceConnection) this._ensureProcessedStream();
            this._ensureIcecastPush();
        } else {
            this._stopProcessedStream();
        }

        // Re-enter the current track at the same position in the new signal path.
        if (this.nowPlaying && !wasPaused) this._startPipeline(elapsedSec);
        else if (this.nowPlaying) this.nowPlaying.pausedElapsedMs = elapsedSec * 1000;

        this._emitState();
        return { ok: true };
    }

    /** Play the processed Omnia return stream into Discord (persistent while enabled). */
    _ensureProcessedStream() {
        if (!this.omniaEnabled || this.processedProcess || !this.voiceConnection) return;
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
            '-i', this.omniaInputUrl,
            '-vn',
            '-af', `volume=${(this.volume / 100).toFixed(3)}`,
            '-ar', '48000', '-ac', '2',
            '-c:a', 'libopus', '-b:a', '192k',
            '-f', 'ogg', 'pipe:1'
        ];
        const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
        this.processedProcess = proc;
        proc.stderr.on('data', chunk => console.error(`[MUSIC][ffmpeg:omnia-in] ${String(chunk).trim()}`));
        proc.on('error', error => console.error(`[MUSIC] Omnia return ffmpeg spawn failed: ${error.message}`));
        proc.on('close', () => {
            if (this.processedProcess !== proc) return;
            this.processedProcess = null;
            this._scheduleProcessedRetry();
            this._emitState();
        });
        const resource = createAudioResource(proc.stdout, { inputType: StreamType.OggOpus });
        this.audioPlayer.play(resource);
        this._emitState();
    }

    _scheduleProcessedRetry() {
        if (!this.omniaEnabled || this.processedRetryTimer || this.processedProcess) return;
        this.processedRetryTimer = setTimeout(() => {
            this.processedRetryTimer = null;
            if (this.omniaEnabled && this.voiceConnection) {
                console.log('[MUSIC] Reconnecting to Omnia return stream…');
                this._ensureProcessedStream();
            }
        }, PROCESSED_RETRY_MS);
    }

    _stopProcessedStream() {
        if (this.processedRetryTimer) {
            clearTimeout(this.processedRetryTimer);
            this.processedRetryTimer = null;
        }
        if (!this.processedProcess) return;
        const proc = this.processedProcess;
        this.processedProcess = null;
        proc.removeAllListeners('close');
        proc.kill('SIGKILL');
        this.audioPlayer.stop(true);
    }

    // ─── Raw feed (<machine_url>/kitbot_raw) ────────────────────────────────

    /** Attach an HTTP response as a raw-feed listener. The stream stays active with mp3 silence while idle. */
    addRawClient(res) {
        this._ensureRawSilence();
        this._ensureIcecastPush();
        this.rawClients.add(res);
        res.on('close', () => this.rawClients.delete(res));
        this._emitState();
        return true;
    }

    _broadcastRawChunk(chunk, { silence = false } = {}) {
        // The track process feeds the raw mount only in Omnia mode; in direct
        // mode the track goes straight to Discord, so silence must keep flowing
        // or the always-on feed (and the Icecast push) starves mid-track.
        if (silence && this.omniaEnabled && this.trackProcess) return;
        for (const res of this.rawClients) {
            // Drop listeners that cannot keep up instead of buffering unbounded.
            if (res.writableLength > 4 * 1024 * 1024) {
                res.destroy();
                this.rawClients.delete(res);
                continue;
            }
            res.write(chunk);
        }
        if (this.icecastProcess?.stdin?.writable) {
            this.icecastProcess.stdin.write(chunk);
        }
    }

    _ensureRawSilence() {
        if (this.rawSilenceProcess) return;
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-re',
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-vn',
            '-c:a', 'libmp3lame', '-b:a', '128k',
            '-f', 'mp3', 'pipe:1'
        ];
        const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
        this.rawSilenceProcess = proc;
        proc.stderr.on('data', chunk => console.error(`[MUSIC][ffmpeg:raw-silence] ${String(chunk).trim()}`));
        proc.stdout.on('data', chunk => this._broadcastRawChunk(chunk, { silence: true }));
        proc.on('error', error => console.error(`[MUSIC] Raw silence ffmpeg spawn failed: ${error.message}`));
        proc.on('close', () => {
            if (this.rawSilenceProcess !== proc) return;
            this.rawSilenceProcess = null;
            if (!this.rawSilenceRetryTimer) {
                this.rawSilenceRetryTimer = setTimeout(() => {
                    this.rawSilenceRetryTimer = null;
                    this._ensureRawSilence();
                }, RAW_SILENCE_RETRY_MS);
            }
            this._emitState();
        });
        this._emitState();
    }

    _stopRawSilence() {
        if (this.rawSilenceRetryTimer) {
            clearTimeout(this.rawSilenceRetryTimer);
            this.rawSilenceRetryTimer = null;
        }
        if (!this.rawSilenceProcess) return;
        const proc = this.rawSilenceProcess;
        this.rawSilenceProcess = null;
        proc.stdout?.removeAllListeners('data');
        proc.removeAllListeners('close');
        proc.kill('SIGKILL');
    }

    /** Optional: push the raw feed to an external Icecast server as well. */
    _ensureIcecastPush() {
        if (!this.icecastPushUrl || this.icecastProcess) return;
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'mp3', '-i', 'pipe:0',
            '-c', 'copy',
            '-content_type', 'audio/mpeg',
            '-f', 'mp3', this.icecastPushUrl
        ];
        const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
        this.icecastProcess = proc;
        proc.stderr.on('data', chunk => console.error(`[MUSIC][ffmpeg:icecast] ${String(chunk).trim()}`));
        proc.on('error', error => console.error(`[MUSIC] Icecast push spawn failed: ${error.message}`));
        proc.stdin.on('error', () => {});
        proc.on('close', () => {
            if (this.icecastProcess !== proc) return;
            this.icecastProcess = null;
            if (this.icecastPushUrl && !this.icecastRetryTimer) {
                this.icecastRetryTimer = setTimeout(() => {
                    this.icecastRetryTimer = null;
                    this._ensureIcecastPush();
                }, ICECAST_RETRY_MS);
            }
        });
    }

    _stopIcecastPush() {
        if (this.icecastRetryTimer) {
            clearTimeout(this.icecastRetryTimer);
            this.icecastRetryTimer = null;
        }
        if (!this.icecastProcess) return;
        const proc = this.icecastProcess;
        this.icecastProcess = null;
        proc.removeAllListeners('close');
        proc.kill('SIGKILL');
    }

    // ─── State snapshot ─────────────────────────────────────────────────────

    getState() {
        const channel = this.voiceChannelId ? this.client.channels?.cache?.get(this.voiceChannelId) : null;
        return {
            serverTime: Date.now(),
            voice: {
                connected: Boolean(this.voiceConnection),
                channelId: this.voiceChannelId,
                channelName: channel?.name || null
            },
            channels: this.listVoiceChannels(),
            nowPlaying: this.nowPlaying ? {
                uid: this.nowPlaying.track.uid,
                fileId: this.nowPlaying.track.fileId,
                title: this.nowPlaying.title,
                artist: this.nowPlaying.artist,
                rel: this.nowPlaying.track.rel,
                durationSec: this.nowPlaying.durationSec,
                elapsedMs: this.getElapsedMs(),
                paused: this.nowPlaying.paused,
                pinned: this.nowPlaying.track.pinned,
                requestedBy: this.nowPlaying.track.requestedBy
            } : null,
            queue: this.queue.map(item => ({
                uid: item.uid,
                fileId: item.fileId,
                name: item.name,
                rel: item.rel,
                pinned: item.pinned,
                requestedBy: item.requestedBy
            })),
            volume: this.volume,
            locked: this.locked,
            loopMode: this.loopMode,
            omnia: {
                enabled: this.omniaEnabled,
                inputUrl: this.omniaInputUrl,
                rawMount: RAW_MOUNT,
                sourceActive: Boolean(this.trackProcess || this.rawSilenceProcess),
                processedActive: Boolean(this.processedProcess),
                rawListeners: this.rawClients.size,
                icecastPush: this.icecastPushUrl ? Boolean(this.icecastProcess) : null
            },
            library: {
                root: this.musicDir,
                fileCount: this.library.files.size,
                dirCount: this.library.dirs.size,
                scanId: this.library.scanId,
                scannedAt: this.library.scannedAt,
                error: this.library.error
            },
            actionLog: this.actionLog
        };
    }

    _emitState() {
        this.events.emit('state', this.getState());
    }

    // ─── Discord: prefix commands ───────────────────────────────────────────
    //
    // Slash commands are not used on this bot. Tiers follow house convention:
    //   k.…       public jukebox commands
    //   abc.music staff jukebox controls (config prefix, admin-gated)
    //   _*music   hidden owner/dev tools (silently ignored for everyone else)

    /** Build an actor. The bot owner (master_id) is god: always admin, no limits. */
    _actorFromMember(user, member) {
        const god = String(user.id) === String(this.getConfig().master_id);
        return {
            id: user.id,
            name: member?.displayName || user.username,
            god,
            admin: god || this.isAdminMember(member)
        };
    }

    _inOperatorGuild(interaction) {
        return interaction.inGuild() && this._isCommandGuild(interaction.guildId);
    }

    /** Routes prefix message commands. Returns true when the message was consumed. */
    async handleMessage(message) {
        if (!message.guildId || message.author?.bot) return false;
        if (!this._isCommandGuild(message.guildId)) return false;

        const content = (message.content || '').trim();
        const greyPrefix = this.getConfig().prefix || 'abc.';
        let tier = null;
        let body = '';
        if (content.startsWith('k.')) { tier = 'public'; body = content.slice(2); }
        else if (content.startsWith('_*')) { tier = 'hidden'; body = content.slice(2); }
        else if (content.startsWith(greyPrefix)) { tier = 'grey'; body = content.slice(greyPrefix.length); }
        if (!tier) return false;

        const [rawCommand, ...restParts] = body.split(/\s+/);
        const command = (rawCommand || '').toLowerCase();
        const arg = restParts.join(' ').trim();
        const actor = this._actorFromMember(message.author, message.member);

        const reply = payload => message.reply(payload).catch(() => {});
        const warn = reason => reply(`❌ ${reason}`);
        const ack = (result, okText) => result.ok ? reply(okText) : warn(result.reason);

        if (tier === 'public') {
            switch (command) {
                case 'play': case 'p':
                    return this._cmdPlay(message, actor, arg, { force: false });
                case 'playnext': case 'pn':
                    return this._cmdPlay(message, actor, arg, { force: false, next: true });
                case 'search': case 'find':
                    return this._cmdSearch(message, actor, arg);
                case 'queue': case 'q':
                    await reply({ embeds: [this.buildQueueEmbed(Number.parseInt(arg, 10) || 1)] });
                    return true;
                case 'np': case 'nowplaying': case 'now':
                    await reply({ embeds: [this.buildNowPlayingEmbed()] });
                    return true;
                case 'skip': case 's': case 'next': case 'fs':
                    await ack(this.skip(actor), '⏭ Skipped.');
                    return true;
                case 'pause':
                    await ack(this.pause(actor), '⏸ Paused.');
                    return true;
                case 'resume': case 'unpause':
                    await ack(this.resume(actor), '▶ Resumed.');
                    return true;
                case 'stop':
                    await ack(this.stopPlayback(actor), '⏹ Stopped and cleared the queue.');
                    return true;
                case 'clear': case 'cq':
                    await ack(this.clearQueue(actor), '🧹 Queue cleared.');
                    return true;
                case 'loop': case 'repeat': case 'l': {
                    if (!arg) { const r = this.cycleLoop(actor); await ack(r, `${LOOP_GLYPH[r.mode]} Loop: **${r.mode}**.`); return true; }
                    const r = this.setLoop(arg, actor);
                    await ack(r, `${LOOP_GLYPH[r.mode]} Loop: **${r.mode}**.`);
                    return true;
                }
                case 'shuffle': case 'sh':
                    await ack(this.shuffleQueue(actor), '🔀 Queue shuffled.');
                    return true;
                case 'remove': case 'rm': case 'dequeue':
                    return this._cmdRemove(message, actor, arg);
                case 'move': case 'mv':
                    return this._cmdMove(message, actor, restParts);
                case 'seek': {
                    const seconds = this._parseTime(arg);
                    if (seconds == null) { await reply('Usage: `k.seek <m:ss>` or `k.seek <seconds>`.'); return true; }
                    await ack(this.seek(seconds, actor), `⏩ Seeked to ${formatClock(seconds)}.`);
                    return true;
                }
                case 'volume': case 'vol': case 'v': {
                    if (!arg) { await reply(`🎚 Volume is **${this.volume}%**. Set it with \`k.volume <0-200>\`.`); return true; }
                    const percent = Number.parseInt(arg, 10);
                    if (!Number.isFinite(percent)) {
                        await reply('Usage: `k.volume <0-200>` (100 = normal).');
                        return true;
                    }
                    await ack(this.setVolume(percent, actor), `🎚 Volume set to ${clampVolume(percent)}%.`);
                    return true;
                }
                case 'join': case 'summon': case 'connect': case 'j': {
                    const channel = this._resolveVoiceChannel(arg, message);
                    if (!channel) {
                        await warn(arg ? `No voice channel matches \`${arg}\`.` : 'Join a voice channel first, or name one: `k.join <channel>`.');
                        return true;
                    }
                    const result = await this.joinChannel(channel.id, actor);
                    await ack(result, `🔊 Connected to **#${channel.name}**.`);
                    return true;
                }
                case 'leave': case 'disconnect': case 'dc': case 'fuckoff':
                    await ack(this.leaveChannel(actor), '👋 Disconnected.');
                    return true;
                case 'panel': case 'jukebox': case 'music': case 'controls':
                    await reply(this.buildPanel(this.library.rootId, 0, actor));
                    return true;
                case 'help': case 'commands': case 'h': case '?':
                    await reply({ embeds: [this.buildHelpEmbed(greyPrefix)] });
                    return true;
                default:
                    return false; // not a jukebox command - leave it for mini-games etc.
            }
        }

        if (command !== 'music') return false;
        const [subRaw, ...subRest] = arg.split(/\s+/);
        const sub = (subRaw || '').toLowerCase();
        const subArg = subRest.join(' ').trim();

        if (tier === 'grey') {
            if (!actor.admin) {
                await warn('Jukebox staff commands are admin-only.');
                return true;
            }
            switch (sub) {
                case 'stop':
                    await ack(this.stopPlayback(actor), '⏹ Stopped and cleared the queue.');
                    return true;
                case 'clear':
                    await ack(this.clearQueue(actor), '🧹 Queue cleared.');
                    return true;
                case 'force':
                    return this._cmdPlay(message, actor, subArg, { force: true });
                case 'lock':
                    if (subArg !== 'on' && subArg !== 'off') {
                        await reply(`Usage: \`${greyPrefix}music lock <on|off>\``);
                        return true;
                    }
                    await ack(this.setLocked(subArg === 'on', actor), subArg === 'on' ? '🔒 Locked - admins only.' : '🔓 Unlocked.');
                    return true;
                case 'omnia': {
                    if (subArg === 'status' || !subArg) {
                        const omnia = this.getState().omnia;
                        await reply([
                            `Omnia processing: **${omnia.enabled ? 'enabled' : 'disabled'}**`,
                            `Raw feed: \`${omnia.rawMount}\` (${omnia.rawListeners} listener${omnia.rawListeners === 1 ? '' : 's'})${omnia.sourceActive ? ' - live' : ''}`,
                            `Processed return: \`${omnia.inputUrl}\` - ${omnia.processedActive ? 'connected' : 'not connected'}`
                        ].join('\n'));
                        return true;
                    }
                    if (subArg !== 'on' && subArg !== 'off') {
                        await reply(`Usage: \`${greyPrefix}music omnia <on|off|status>\``);
                        return true;
                    }
                    await ack(this.setOmnia(subArg === 'on', actor), subArg === 'on' ? '📡 Omnia processing enabled.' : '📡 Omnia processing disabled - direct playback.');
                    return true;
                }
                case 'rescan': {
                    await this.rescanLibrary();
                    this._log(actor, 'rescan', `${this.library.files.size} tracks`);
                    await reply(this.library.error
                        ? `❌ ${this.library.error}`
                        : `🗄 Library rescanned: **${this.library.files.size}** tracks in **${this.library.dirs.size}** folders.`);
                    return true;
                }
                default:
                    await reply(`Staff jukebox usage: \`${greyPrefix}music <stop|clear|force <search>|lock on/off|omnia on/off/status|rescan>\``);
                    return true;
            }
        }

        if (tier === 'hidden') {
            // Hidden tools stay hidden: non-privileged users get silence.
            if (!actor.god && !this.isPrivilegedUser(actor.id)) return true;
            switch (sub) {
                case 'status':
                    await reply({ embeds: [this._buildDiagnosticsEmbed()] });
                    return true;
                case 'reset':
                    this._panicReset(actor);
                    await reply('🚨 Panic reset done: playback stopped, queue cleared, Omnia off, lock off, left voice.');
                    return true;
                default:
                    await reply('Hidden jukebox usage: `_*music <status|reset>`');
                    return true;
            }
        }

        return false;
    }

    /**
     * Shared play flow for k.play / k.playnext / abc.music force.
     * Local library first; an exact-ish single local match plays immediately, a
     * handful of matches offer a picker.
     */
    async _cmdPlay(message, actor, query, { force = false, next = false } = {}) {
        const reply = payload => message.reply(payload).catch(() => {});
        if (!query) {
            const prefix = this.getConfig().prefix || 'abc.';
            await reply(force ? `Usage: \`${prefix}music force <search>\`` : 'Usage: `k.play <song name or artist - title>`');
            return true;
        }

        const local = this.searchLibrary(query, 10);

        // Multiple local matches → let the requester disambiguate.
        if (local.length > 1) {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`mz:pick:${force ? 'f' : next ? 'n' : 'q'}`)
                .setPlaceholder(`${local.length} matches - pick one`)
                .addOptions(local.map(file => ({
                    label: `🎵 ${file.name}`.slice(0, 100),
                    description: file.rel.slice(0, 100),
                    value: `f${file.id}`
                })));
            await reply({
                content: `Found **${local.length}** matches for \`${query}\` in the library:`,
                components: [new ActionRowBuilder().addComponents(select)]
            });
            return true;
        }

        let file = local[0] ? this.getFile(local[0].id) : null;
        let source = file ? 'library' : null;
        let status = null;

        if (!file) {
            await reply(`❌ No library match for \`${query}\`.`);
            return true;
        }

        if (!this.voiceConnection) {
            const memberChannelId = message.member?.voice?.channelId;
            if (memberChannelId) await this.joinChannel(memberChannelId, actor);
        }

        const result = this.enqueue(file.id, actor, { force, next });
        const respond = payload => status ? status.edit(payload).catch(() => {}) : reply(payload);

        if (!result.ok) {
            await respond(`❌ ${result.reason}`);
        } else if (!this.voiceConnection) {
            await respond(`Queued **${file.name}** - I'm not in voice yet; hop in a channel and run \`k.join\`.`);
        } else {
            await respond({ content: '', embeds: [this.buildAddedEmbed(file, { force, next, source })] });
        }
        return true;
    }

    /** k.search - interactive library picker (no download). */
    async _cmdSearch(message, actor, query) {
        const reply = payload => message.reply(payload).catch(() => {});
        if (!query) { await reply('Usage: `k.search <terms>`'); return true; }
        const results = this.searchLibrary(query, 25);
        if (!results.length) {
            await reply(`No library match for \`${query}\`.`);
            return true;
        }
        const select = new StringSelectMenuBuilder()
            .setCustomId('mz:pick:q')
            .setPlaceholder(`${results.length} result${results.length === 1 ? '' : 's'} - pick to queue`)
            .addOptions(results.slice(0, 25).map(file => ({
                label: `🎵 ${file.name}`.slice(0, 100),
                description: file.rel.slice(0, 100),
                value: `f${file.id}`
            })));
        await reply({
            content: `🔎 **${results.length}** match${results.length === 1 ? '' : 'es'} for \`${query}\`:`,
            components: [new ActionRowBuilder().addComponents(select)]
        });
        return true;
    }

    /** k.remove <n> - drop a queued track by its 1-based position. */
    async _cmdRemove(message, actor, arg) {
        const reply = payload => message.reply(payload).catch(() => {});
        const index = Number.parseInt(arg, 10);
        if (!Number.isFinite(index) || index < 1) { await reply('Usage: `k.remove <queue position>` (see `k.queue`).'); return true; }
        const item = this.queue[index - 1];
        if (!item) { await reply(`❌ There's no track at position ${index}.`); return true; }
        const result = this.removeFromQueue(item.uid, actor);
        await (result.ok ? reply(`🗑 Removed **${item.name}** from the queue.`) : reply(`❌ ${result.reason}`));
        return true;
    }

    /** k.move <from> <to> - admin reorder by 1-based positions. */
    async _cmdMove(message, actor, restParts) {
        const reply = payload => message.reply(payload).catch(() => {});
        const from = Number.parseInt(restParts[0], 10);
        const to = Number.parseInt(restParts[1], 10);
        if (!Number.isFinite(from) || !Number.isFinite(to)) { await reply('Usage: `k.move <from> <to>` (1-based positions).'); return true; }
        const item = this.queue[from - 1];
        if (!item) { await reply(`❌ No track at position ${from}.`); return true; }
        const adminGate = this._requireAdmin(actor);
        if (!adminGate.ok) { await reply(`❌ ${adminGate.reason}`); return true; }
        // moveInQueue steps one slot at a time; walk it to the target.
        const target = Math.min(Math.max(1, to), this.queue.length);
        let current = from;
        while (current !== target) {
            const dir = current < target ? 'down' : 'up';
            const r = this.moveInQueue(item.uid, dir, actor);
            if (!r.ok) { await reply(`❌ ${r.reason}`); return true; }
            current += current < target ? 1 : -1;
        }
        await reply(`↕ Moved **${item.name}** to position ${target}.`);
        return true;
    }

    /** Parse "1:23", "83", "1m20s" → seconds. Returns null on garbage. */
    _parseTime(text) {
        const value = String(text || '').trim();
        if (!value) return null;
        if (/^\d+$/.test(value)) return Number(value);
        const clock = value.match(/^(\d+):([0-5]?\d)$/);
        if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
        const hms = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
        if (hms && (hms[1] || hms[2] || hms[3])) return (Number(hms[1]) || 0) * 3600 + (Number(hms[2]) || 0) * 60 + (Number(hms[3]) || 0);
        return null;
    }

    /** Report whether the established voice connection negotiated a DAVE E2EE session. */
    _scheduleDaveCheck() {
        const connection = this.voiceConnection;
        setTimeout(() => {
            if (!connection || this.voiceConnection !== connection) return;
            const daveSession = connection.state?.networking?.state?.dave || null;
            const protocolVersion = daveSession?.protocolVersion ?? 0;
            if (protocolVersion >= 1) {
                console.log(`[MUSIC] Voice connected with DAVE E2EE active (protocol v${protocolVersion}).`);
            } else {
                console.warn('[MUSIC] Voice connected without DAVE E2EE (gateway negotiated transport-only encryption).');
            }
        }, 3000).unref?.();
    }

    _resolveVoiceChannel(arg, message) {
        // Resolve within the guild the command came from, so k.join works in
        // the test guild as well as the operator guild.
        const guild = message.guild;
        if (!guild) return null;
        if (!arg) {
            const channelId = message.member?.voice?.channelId;
            return channelId ? guild.channels.cache.get(channelId) : null;
        }
        const id = arg.replace(/[<#>]/g, '');
        const isVoice = channel => channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
        const byId = guild.channels.cache.get(id);
        if (isVoice(byId)) return byId;
        const needle = arg.toLowerCase();
        return guild.channels.cache.find(channel => isVoice(channel) && channel.name.toLowerCase().includes(needle)) || null;
    }

    _buildDiagnosticsEmbed() {
        const state = this.getState();
        return new EmbedBuilder()
            .setColor(0x38BDF8)
            .setTitle('Jukebox diagnostics')
            .addFields(
                {
                    name: 'Playback',
                    value: [
                        `Player: \`${this.audioPlayer.state.status}\``,
                        `Voice: ${state.voice.connected ? `\`#${state.voice.channelName}\` (${state.voice.channelId})` : '`disconnected`'}`,
                        `Now: ${state.nowPlaying ? `\`${state.nowPlaying.rel}\` @ ${formatClock(state.nowPlaying.elapsedMs / 1000)}` : '`idle`'}`,
                        `Queue: \`${state.queue.length}\` · Volume: \`${state.volume}%\` · Locked: \`${state.locked}\``
                    ].join('\n')
                },
                {
                    name: 'Pipelines',
                    value: [
                        `Track ffmpeg: \`${this.trackProcess ? `pid ${this.trackProcess.pid}` : 'down'}\``,
                        `Omnia return ffmpeg: \`${this.processedProcess ? `pid ${this.processedProcess.pid}` : 'down'}\``,
                        `Icecast push ffmpeg: \`${this.icecastProcess ? `pid ${this.icecastProcess.pid}` : this.icecastPushUrl ? 'down' : 'not configured'}\``,
                        `Raw listeners: \`${this.rawClients.size}\` · Omnia: \`${this.omniaEnabled ? 'on' : 'off'}\``
                    ].join('\n')
                },
                {
                    name: 'Library',
                    value: this.library.error
                        ? `⚠ \`${this.library.error}\``
                        : `\`${state.library.fileCount}\` tracks · \`${state.library.dirCount}\` folders · scan #${state.library.scanId} at ${new Date(state.library.scannedAt).toLocaleString()}`
                }
            )
            .setTimestamp();
    }

    /** Owner/dev panic button: stop everything and return to a clean idle state. */
    _panicReset(actor) {
        this.queue = [];
        this._stopTrackProcess();
        this._stopProcessedStream();
        this._stopIcecastPush();
        this.audioPlayer.stop(true);
        this.nowPlaying = null;
        this.omniaEnabled = false;
        for (const res of this.rawClients) res.destroy();
        this.rawClients.clear();
        this.locked = false;
        this._savePersistedState();
        if (this.voiceConnection) {
            this.voiceConnection.destroy();
            this.voiceConnection = null;
        }
        this.voiceChannelId = null;
        this._log(actor, 'panic-reset');
        this._emitState();
    }

    // ─── Discord: embed panel + components ──────────────────────────────────

    buildNowPlayingLines() {
        if (!this.nowPlaying) return '*Nothing is playing.*';
        const np = this.nowPlaying;
        const elapsed = this.getElapsedMs() / 1000;
        const lines = [];
        lines.push(`**${np.title}**${np.artist ? ` - ${np.artist}` : ''}${np.track.pinned ? ' 📌' : ''}`);
        if (np.durationSec) {
            const ratio = Math.min(1, elapsed / np.durationSec);
            const filled = Math.round(ratio * 14);
            lines.push(`\`${formatClock(elapsed)}\` ${'▰'.repeat(filled)}${'▱'.repeat(14 - filled)} \`${formatClock(np.durationSec)}\``);
        } else {
            lines.push(`\`${formatClock(elapsed)}\``);
        }
        const flags = [np.paused ? '⏸ Paused' : '▶ Playing'];
        if (this.loopMode !== 'off') flags.push(`${LOOP_GLYPH[this.loopMode]} loop ${this.loopMode}`);
        lines.push(`-# ${flags.join(' · ')} · requested by ${np.track.requestedBy.name}`);
        return lines.join('\n');
    }

    /** Rich "now playing" embed with a transport row, for k.np. */
    buildNowPlayingEmbed() {
        return new EmbedBuilder()
            .setColor(this.nowPlaying ? 0x8B5CF6 : 0x4B5563)
            .setAuthor({ name: 'kitbot · Jukebox' })
            .setTitle(this.nowPlaying ? '▶ Now playing' : 'Idle')
            .setDescription(this.buildNowPlayingLines());
    }

    /** "Added to queue" confirmation, Jockie-style. */
    buildAddedEmbed(file, { force = false, next = false, source = 'library' } = {}) {
        const position = force ? 'Now' : next ? 'Next' : (this.queue.length || 'Now playing');
        const sourceTag = 'Fed from library';
        return new EmbedBuilder()
            .setColor(force ? 0xF59E0B : 0x22C55E)
            .setAuthor({ name: force ? 'Force-Fed:' : next ? 'Playing next:' : 'Added to queue:' })
            .setTitle(`🎵 ${file.name}`)
            .setDescription(`\`${file.rel}\``)
            .setFooter({ text: `Position: ${position} · ${sourceTag}` });
    }

    buildQueueEmbed(page = 1) {
        const pageSize = 10;
        const pageCount = Math.max(1, Math.ceil(this.queue.length / pageSize));
        const safePage = Math.min(Math.max(1, Number(page) || 1), pageCount);
        const start = (safePage - 1) * pageSize;
        const embed = new EmbedBuilder()
            .setTitle('kitbot Jukebox - Queue')
            .setColor(0x8B5CF6)
            .setDescription(this.buildNowPlayingLines());
        const lines = this.queue.slice(start, start + pageSize).map((item, index) =>
            `\`${String(start + index + 1).padStart(2, '0')}\` ${item.pinned ? '📌 ' : ''}**${item.name}** · ${item.requestedBy.name}`);
        embed.addFields({
            name: `Up next (${this.queue.length})${pageCount > 1 ? ` - page ${safePage}/${pageCount}` : ''}`,
            value: lines.length ? lines.join('\n') : '*Queue is empty.*'
        });
        if (this.loopMode !== 'off') embed.setFooter({ text: `${LOOP_GLYPH[this.loopMode]} Looping ${this.loopMode}` });
        return embed;
    }

    /** k.help - Jockie-style command reference. */
    buildHelpEmbed(greyPrefix = 'abc.') {
        return new EmbedBuilder()
            .setColor(0x8B5CF6)
            .setTitle("kitbot Music Commands cuz community'n'stuff")
            .setDescription('Was forced to put this here by discord')
            .addFields(
                {
                    name: 'Playback',
                    value: [
                        '`k.play <name>` - play a track from the library (alias; `k.p`)',
                        '`k.playnext <name>` - queue it up next (alias; `k.pn`)',
                        '`k.search <terms>` - pick from local matches (alias; `k.find`)',
                        '`k.np` · `k.queue [page]`'
                    ].join('\n')
                },
                {
                    name: 'Misc',
                    value: [
                        '`k.pause` · `k.resume` · `k.skip` (alias; `k.s`) · `k.stop`',
                        '`k.seek <m:ss>` · `k.volume <0-200>` *(alias; `k.vol`)*',
                        '`k.loop <off|track|queue>` *(alias; `k..repeat`)* · `k.shuffle`'
                    ].join('\n')
                },
                {
                    name: 'Queue',
                    value: '`k.remove <n>` · `k.move <from> <to>` · `k.clear`'
                },
                {
                    name: 'Join/Leave',
                    value: '`k.join [channel]` (alias; `k.summon [channel]`) · `k.leave` (alias; `k.dc`)\nNote; k.p will always summon KB into your active channel.'
                },
                {
                    name: 'Moderation Notice;',
                    value: `We behold the right to suspend your access to kitbots music player or other features if deemed missused, as well as manually override playlists.`
                }
            )
            .setFooter({ text: 'No Expies where harmed during the creation of this Feature™️' });
    }

    buildPanel(dirId, page, actor) {
        const listing = this.getDirListing(dirId);
        const state = this.getState();

        const embed = new EmbedBuilder()
            .setTitle('kitbot Jukebox')
            .setColor(0x8B5CF6)
            .setDescription(this.buildNowPlayingLines())
            .addFields(
                {
                    name: `Up next (${this.queue.length})`,
                    value: this.queue.slice(0, 5).map((item, index) =>
                        `\`${index + 1}\` ${item.pinned ? '📌 ' : ''}${item.name} · ${item.requestedBy.name}`).join('\n') || '*Queue is empty - just like head.*',
                    inline: false
                },
                {
                    name: 'Status',
                    value: [
                        state.voice.connected ? `🔊 #${state.voice.channelName}` : '🔇 Not in voice',
                        `🎚 Volume ${state.volume}%`,
                        `${LOOP_GLYPH[state.loopMode]} Loop ${state.loopMode}`,
                        `📡 Omnia ${state.omnia.enabled ? 'ON' : 'off'}`,
                        state.locked ? '🔒 Locked (admins only)' : '🔓 Unlocked'
                    ].join(' · '),
                    inline: false
                }
            );

        const components = [];
        if (listing && !this.library.error) {
            embed.setFooter({ text: `📁 ${listing.crumbs.map(crumb => crumb.name).join(' / ')} - pick a folder or track below` });

            const entries = [
                ...listing.dirs.map(dir => ({
                    label: `📁 ${dir.name}`.slice(0, 100),
                    description: `${dir.fileCount} tracks, ${dir.dirCount} folders`.slice(0, 100),
                    value: `d${dir.id}`
                })),
                ...listing.files.map(file => ({
                    label: `🎵 ${file.name}`.slice(0, 100),
                    description: file.ext.slice(1).toUpperCase(),
                    value: `f${file.id}`
                }))
            ];
            const pageCount = Math.max(1, Math.ceil(entries.length / SELECT_PAGE_SIZE));
            const safePage = Math.min(Math.max(0, page), pageCount - 1);
            const pageEntries = entries.slice(safePage * SELECT_PAGE_SIZE, (safePage + 1) * SELECT_PAGE_SIZE);

            if (pageEntries.length > 0) {
                components.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`mz:sel:${listing.id}:${safePage}:${listing.scanId}`)
                        .setPlaceholder(`Browse - page ${safePage + 1}/${pageCount}`)
                        .addOptions(pageEntries)
                ));
            }

            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mz:open:${listing.parentId ?? listing.id}:0`).setLabel('⬆ Up').setStyle(ButtonStyle.Secondary).setDisabled(listing.parentId == null),
                new ButtonBuilder().setCustomId(`mz:open:${listing.id}:${safePage - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
                new ButtonBuilder().setCustomId(`mz:open:${listing.id}:${safePage + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
                new ButtonBuilder().setCustomId(`mz:open:${listing.id}:${safePage}`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary)
            );
            components.push(navRow);
        } else if (this.library.error) {
            embed.setFooter({ text: `Library unavailable: ${this.library.error}` });
        }

        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mz:pp').setLabel(this.nowPlaying?.paused ? '▶ Resume' : '⏸ Pause').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('mz:skip').setLabel('⏭ Skip').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('mz:stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('mz:shq').setLabel('📜 Queue').setStyle(ButtonStyle.Secondary)
        ));

        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mz:loop').setLabel(`${LOOP_GLYPH[this.loopMode]} Loop: ${this.loopMode}`).setStyle(this.loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('mz:shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(this.queue.length < 2)
        ));

        return { embeds: [embed], components };
    }

    /** Routes mz:* component interactions. Returns true when handled. */
    async handleComponent(interaction) {
        const customId = interaction.customId || '';
        if (!customId.startsWith('mz:')) return false;
        if (!this._inOperatorGuild(interaction)) {
            await interaction.reply({ content: 'The jukebox only runs in the operator server.', flags: MessageFlags.Ephemeral }).catch(() => {});
            return true;
        }
        const actor = this._actorFromMember(interaction.user, interaction.member);
        const [, op, arg1, arg2, arg3] = customId.split(':');

        const ephemeral = content => interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
        const refreshPanel = async (dirId, page) => {
            const panel = this.buildPanel(dirId ?? this.library.rootId, page ?? 0, actor);
            await interaction.update(panel).catch(() => {});
        };

        if (interaction.isStringSelectMenu() && op === 'pick') {
            const force = arg1 === 'f';
            const next = arg1 === 'n';
            const file = this.getFile(interaction.values[0].slice(1));
            if (!file) {
                await interaction.update({ content: 'That track vanished from the library - search again.', components: [] }).catch(() => {});
                return true;
            }
            if (!this.voiceConnection) {
                const memberChannelId = interaction.member?.voice?.channelId;
                if (memberChannelId) await this.joinChannel(memberChannelId, actor);
            }
            const result = this.enqueue(file.id, actor, { force, next });
            await interaction.update({
                content: result.ok
                    ? `${force ? '📌 Force-playing' : next ? '⏭ Playing next:' : 'Queued'} **${file.name}**.${this.voiceConnection ? '' : ' Use `k.join` from a voice channel to start playback.'}`
                    : `❌ ${result.reason}`,
                components: []
            }).catch(() => {});
            return true;
        }

        if (interaction.isStringSelectMenu() && op === 'sel') {
            const scanId = Number(arg3);
            if (scanId !== this.library.scanId) {
                await refreshPanel(this.library.rootId, 0);
                return true;
            }
            const value = interaction.values[0];
            if (value.startsWith('d')) {
                await refreshPanel(Number(value.slice(1)), 0);
                return true;
            }
            const file = this.getFile(value.slice(1));
            if (!file) {
                await ephemeral('That track vanished from the library - try a refresh.');
                return true;
            }
            if (!this.voiceConnection) {
                const memberChannelId = interaction.member?.voice?.channelId;
                if (memberChannelId) await this.joinChannel(memberChannelId, actor);
            }
            const result = this.enqueue(file.id, actor);
            if (result.ok) {
                await refreshPanel(Number(arg1), Number(arg2));
            } else {
                await ephemeral(`❌ ${result.reason}`);
            }
            return true;
        }

        if (interaction.isButton()) {
            switch (op) {
                case 'open':
                    await refreshPanel(Number(arg1), Number(arg2));
                    return true;
                case 'pp': {
                    const result = this.nowPlaying?.paused ? this.resume(actor) : this.pause(actor);
                    if (result.ok) await refreshPanel(this.library.rootId, 0);
                    else await ephemeral(`❌ ${result.reason}`);
                    return true;
                }
                case 'skip': {
                    const result = this.skip(actor);
                    if (result.ok) await refreshPanel(this.library.rootId, 0);
                    else await ephemeral(`❌ ${result.reason}`);
                    return true;
                }
                case 'stop': {
                    const result = this.stopPlayback(actor);
                    if (result.ok) await refreshPanel(this.library.rootId, 0);
                    else await ephemeral(`❌ ${result.reason}`);
                    return true;
                }
                case 'shq':
                    await interaction.reply({ embeds: [this.buildQueueEmbed()], flags: MessageFlags.Ephemeral }).catch(() => {});
                    return true;
                case 'loop': {
                    const result = this.cycleLoop(actor);
                    if (result.ok) await refreshPanel(this.library.rootId, 0);
                    else await ephemeral(`❌ ${result.reason}`);
                    return true;
                }
                case 'shuffle': {
                    const result = this.shuffleQueue(actor);
                    if (result.ok) await refreshPanel(this.library.rootId, 0);
                    else await ephemeral(`❌ ${result.reason}`);
                    return true;
                }
                default:
                    await ephemeral('Unknown jukebox control.');
                    return true;
            }
        }

        return true;
    }
}

module.exports = { MusicCog, RAW_MOUNT };
