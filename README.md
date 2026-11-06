# kitbot

A self-hosted Discord bot for running a community server. One Node.js process, state in local JSON files, no database required.

- **Modmail** - users DM the bot, tickets open as forum threads for staff, with categories, tags and transcripts.
- **Logging** - 60+ server events routed into log channels, with optional cross-server sync.
- **Moderation** - warns, timeouts, kicks, bans, escalation rules and audit-log ingestion, plus an optional web dashboard.
- **Leveling** - message XP, reputation, rank cards and level-up announcements.
- **Starboard**, **mini-games**, **embed builder**, **welcome DMs**, **autodelete**, **auto-threads** and a **sticky reminder**.
- **Music jukebox** - plays your own local library into voice, with a control API and optional broadcast-processing loop.

## Quick start

Requires Node.js 22.12 or newer. The jukebox also needs `ffmpeg` on your PATH.

```bash
git clone https://github.com/Sanedish/kitbot.git
cd kitbot
npm install
npm run setup
npm start
```

`npm run setup` asks for your bot token and a few IDs, writes `.env` and `config.json`, and prints an invite link.

Before you start:

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications) and add a bot.
2. Under **Bot**, enable the **Server Members** and **Message Content** privileged intents.
3. In Discord, turn on **Settings > Advanced > Developer Mode** so you can right-click to copy IDs.

## Configuration

Two files, both created by `npm run setup` and both ignored by git:

| File | Holds |
| --- | --- |
| `.env` | The bot token, passwords, ports and paths. See [`.env.example`](.env.example). |
| `config.json` | Discord IDs, the prefix and feature toggles. See [`config.example.json`](config.example.json). |

Key `config.json` fields:

| Key | Meaning |
| --- | --- |
| `master_id` | Your user ID. Full access to every command. |
| `operator_id` | Optional second trusted user. |
| `operator_guild_id` | Your main server. |
| `staff_guild_id` | Server that hosts modmail and staff tools. Can be the main server. |
| `test_guild_id` | Optional server for testing. |
| `prefix` | Staff command prefix, default `abc.`. Public commands use `k.` |
| `toggle_mod_mail` | Turns modmail on or off. Also toggled with `abc.toggle modmail`. |
| `sync_logs_toggle`, `sync_logs_guilds` | Mirror logs into other servers. |
| `music_admin_role_ids` | Roles that count as jukebox admins. |
| `starboard.default_channels` | `{ "guildId": "channelId" }` defaults. |
| `feature_defaults` | Optional channels for autodelete, auto-threads and the sticky reminder. These can also be set with commands. |
| `modmail` | Ticket routing, described below. |

### Modmail

Modmail creates one forum thread per ticket. Create a **forum channel** in your staff server, add at least one **tag** to it, then list it under `modmail.categories`:

```json
{
  "id": "general",
  "label": "General Support",
  "forum_channel_id": "FORUM_CHANNEL_ID",
  "support_role_id": "ROLE_TO_PING",
  "ongoing_tag_id": "",
  "resolved_tag_id": "",
  "tags": [{ "id": "FORUM_TAG_ID", "label": "Question", "description": "Ask a question or request help." }]
}
```

Add more categories to give users a picker, such as reports, appeals or feedback. Each category needs at least one tag. To get a forum tag ID, right-click the tag while Developer Mode is on.

### Images

Put your own images in `media/` to enable these features. Everything works without them.

| File | Used for |
| --- | --- |
| `media/leveling_card.png` | Rank card background, 1920x1080. A plain card is drawn without it. |
| `media/levelup.png` | Image on level-up announcements. |
| `media/banner_day.png`, `media/banner_night.png` | Bot profile banner, swapped at 13:00 and 02:00. |
| `media/server_banner_day.png`, `media/server_banner_night.png` | Main server banner on the same schedule. Needs a boosted server. |

## Commands

Run `abc.help` in your server for the full list. The main groups:

- **Staff** (`abc.`) - `autodelete`, `immune`, `enable`/`disable auto-message`, `welcomsg`, `toggle modmail`, `close`, `resolve`, `level`, `xp`, `log setup`, `embed`, `send`, `reply`, `music`.
- **Public** (`k.`) - `k.play`, `k.queue`, `k.skip`, `k.panel`, `k.8ball`, `k.coinflip`, `k.roll`, `k.rps`, `k.stats`, `k!rank`, `k!rep`.
- **Slash** - `/info` and `/modmail`.

## Optional modules

- **Music jukebox** - set `MUSIC_DIR` to a folder of audio files. See [docs/music.md](docs/music.md).
- **Moderation dashboard** - needs `data/staff-access.json` and, for staff accounts, PocketBase. See [docs/moderation-dashboard.md](docs/moderation-dashboard.md).
- **Folding@home** - set the `FAH_*` values to show team stats.

Both dashboards ship as a JSON and WebSocket API. A browser frontend is not included yet. They bind to `127.0.0.1` by default, so put a reverse proxy with TLS in front before exposing them.

## Data and privacy

`data/` holds runtime state, message logs and modmail transcripts. It is ignored by git. Keep it private and back it up. You are responsible for telling your members what the bot logs.

## License

[MIT](LICENSE)
