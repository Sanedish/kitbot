'use strict';

// avatar-cache - pull each user's avatar to disk ONCE, keyed by user id.
//
// Before this, log-store downloaded the author icon to a fresh random filename
// on every single log event (9.8k files / 162 MB of duplicates). Now:
//   • one canonical file per uid: data/logs/avatars/<uid>.<ext>
//   • an index (_index.json) tracks each uid's current avatar hash
//   • when the avatar hash changes, the old file is renamed
//       old_<uid>_<YYYY-MM-DD>.<ext>   (date = day of the change)
//     and the new one is pulled exactly once
//   • unchanged avatar → no download, returns the existing filename
//
// Keyed off the Discord CDN URL, which already carries both the uid and the
// content hash, so callers just pass the avatar URL they already have.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const AVATAR_DIR = path.join(__dirname, '..', 'data', 'logs', 'avatars');
const INDEX_PATH = path.join(AVATAR_DIR, '_index.json');
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

let index = null;            // { <uid>: { hash, ext, file, updated } }
const inflight = new Map();  // uid -> Promise<file>  (collapse concurrent pulls)

function loadIndex() {
    if (index) return index;
    try { index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
    catch { index = {}; }
    return index;
}

let saveTimer = null;
function saveIndexSoon() {
    // ponytail: debounce - many events land per second, one write covers them.
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        fsp.writeFile(INDEX_PATH, JSON.stringify(index)).catch(() => {});
    }, 1000);
}

/** Pull uid + content-hash + ext out of a Discord avatar URL. null if not parseable. */
function parse(url) {
    if (typeof url !== 'string') return null;
    const clean = url.split('?')[0];
    let m;
    // per-guild member avatar: /guilds/<gid>/users/<uid>/avatars/<hash>.<ext>
    if ((m = clean.match(/\/users\/(\d+)\/avatars\/([^./]+)\.(\w+)$/))) {
        return { uid: `g${m[1]}`, hash: m[2], ext: norm(m[3]) };
    }
    // global user avatar: /avatars/<uid>/<hash>.<ext>
    if ((m = clean.match(/\/avatars\/(\d+)\/([^./]+)\.(\w+)$/))) {
        return { uid: m[1], hash: m[2], ext: norm(m[3]) };
    }
    // default avatar: /embed/avatars/<n>.png - shared, no real uid, never changes.
    if ((m = clean.match(/\/embed\/avatars\/(\d+)\./))) {
        return { uid: `default-${m[1]}`, hash: m[1], ext: 'png' };
    }
    return null;
}

function norm(ext) {
    const e = String(ext).toLowerCase();
    return ALLOWED_EXT.has(e) ? e : 'png';
}

function today() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Ensure this user's avatar is on disk, pulling only if new or changed.
 * @returns {Promise<string|null>} the filename under data/logs/avatars/, or null.
 */
async function cacheAvatar(url) {
    const info = parse(url);
    if (!info) return null;
    const { uid, hash, ext } = info;
    loadIndex();

    const prev = index[uid];
    if (prev && prev.hash === hash && fs.existsSync(path.join(AVATAR_DIR, prev.file))) {
        return prev.file; // unchanged - reuse, no network hit
    }
    if (inflight.has(uid)) return inflight.get(uid);

    const p = (async () => {
        await fsp.mkdir(AVATAR_DIR, { recursive: true });
        // Avatar changed: archive the old file as old_<uid>_<date>.<ext>.
        if (prev && prev.file) {
            const oldPath = path.join(AVATAR_DIR, prev.file);
            if (fs.existsSync(oldPath)) {
                const archived = `old_${uid}_${today()}.${prev.ext}`;
                await fsp.rename(oldPath, path.join(AVATAR_DIR, archived)).catch(() => {});
            }
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const file = `${uid}.${ext}`;
        await fsp.writeFile(path.join(AVATAR_DIR, file), buf);
        index[uid] = { hash, ext, file, updated: Date.now() };
        saveIndexSoon();
        return file;
    })().catch(err => {
        // On failure keep any existing copy rather than wiping a known-good avatar.
        if (prev && prev.file && fs.existsSync(path.join(AVATAR_DIR, prev.file))) return prev.file;
        console.error(`[AVATAR] pull failed for ${uid}: ${err.message}`);
        return null;
    }).finally(() => inflight.delete(uid));

    inflight.set(uid, p);
    return p;
}

module.exports = { cacheAvatar, parse, AVATAR_DIR };
