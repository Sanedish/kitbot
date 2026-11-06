# Music jukebox

Plays audio files from a local library into a voice channel. You control it from Discord or over the dashboard API.

The jukebox only plays files you already have. It never streams audio to browsers and never offers files for download. The only outputs are the Discord voice channel and the optional processing loop described below.

## Setup

1. Install `ffmpeg` and `ffprobe`, or point `FFMPEG_PATH` and `FFPROBE_PATH` at them.
2. Set `MUSIC_DIR` in `.env` to your library folder. It is scanned recursively.
3. Optionally list Discord roles in `music_admin_role_ids` in `config.json`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MUSIC_DIR` | `./music` | Library root |
| `MUSIC_EXCLUDE_DIRS` | empty | Comma-separated folder names to skip |
| `MUSIC_DASH_HOST` | `127.0.0.1` | Dashboard bind address |
| `MUSIC_DASH_PORT` | `8780` | Dashboard port |
| `MUSIC_ADMIN_PASSWORD` | empty | Dashboard admin login. Empty disables it. |
| `OMNIA_INPUT_URL` | empty | Processed return stream, see below |
| `ICECAST_PUSH_URL` | empty | Push the raw feed to an Icecast mount |
| `RAW_STREAM_PUBLIC_URL` | empty | Override the raw feed URL printed at launch |

## Discord commands

| Command | What it does |
| --- | --- |
| `k.play <name>` or `k.p` | Play from the library and join your voice channel. Several matches give a picker. |
| `k.playnext <name>` or `k.pn` | Queue a track to play next |
| `k.search <terms>` or `k.find` | Pick from library matches |
| `k.queue [page]` or `k.q` | Show the queue |
| `k.np` | Show the current track |
| `k.skip`, `k.pause`, `k.resume`, `k.stop` | Transport controls |
| `k.loop <off\|track\|queue>` | Repeat mode |
| `k.shuffle`, `k.seek <m:ss>`, `k.remove <n>`, `k.move <from> <to>`, `k.clear` | Queue tools |
| `k.volume <0-200>` | Volume, 100 is normal |
| `k.join [channel]`, `k.leave` | Voice connection |
| `k.panel` | Button and menu control panel |

Staff commands use the staff prefix: `abc.music force <search>`, `stop`, `clear`, `lock on|off`, `omnia on|off|status` and `rescan`. The owner also has `_*music status` and `_*music reset`.

## Permissions

- **Users** can browse, queue, pause, skip, seek, change volume and remove their own requests.
- **Admins** can do everything, always. Admins are the owner, the operator, developers, members with Administrator or Manage Server, `music_admin_role_ids`, and dashboard admin logins. Extras include force-play, which pins a track so users cannot skip it. Admins can also stop and clear, reorder anything, lock commands for non-admins, toggle the processing loop and rescan.

## Processing loop

Optional. Use it to run the audio through an external broadcast processor before it reaches Discord.

```
Direct:   file -> ffmpeg -> ogg/opus -> Discord voice

Loop:     file -> ffmpeg -> mp3 -> /kitbot_raw  (and ICECAST_PUSH_URL if set)
          processor pulls /kitbot_raw and serves its own stream
          OMNIA_INPUT_URL -> ffmpeg -> ogg/opus -> Discord voice
```

The raw feed is sent at unity gain, and volume is applied on the return. `/kitbot_raw` on the dashboard port always streams, sending silence while the loop is off, so the processor never loses its input.

## Dashboard API

The dashboard is an Express and WebSocket server. A browser frontend is not included. Drop one into `web/` and it is served at `/`.

- Visitors pick a display name, which creates a signed session cookie.
- Admin login uses `MUSIC_ADMIN_PASSWORD` and is rate-limited.
- All writes are rate-limited per IP.
- State is pushed over `/ws`.

For internet exposure, put it behind a reverse proxy with TLS and choose a strong admin password.
