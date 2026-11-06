# Moderation dashboard

A staff web API for moderation: a per-member action timeline, a punishment suite the bot enforces itself, a log viewer, an embed builder and a member DM tool. A browser frontend is not included. Drop one into `web-mod/` and it is served at `/`.

## Enabling it

The dashboard stays off until `data/staff-access.json` exists:

```json
{
  "roots": { "yourname": "a-long-random-password" },
  "staffPassword": "shared-staff-password"
}
```

- **Root accounts** live only in this file and have full access, including staff management. Passwords are stored as written, so keep the file private and use long random values.
- **Staff** log in with the shared password. They also need an active row in the PocketBase `staff` collection, which roots manage from the dashboard. Locking a staff row ends their session within about 30 seconds.

PocketBase is optional. Put its binary in `pb/` and set `PB_URL`, `PB_ADMIN_EMAIL` and `PB_ADMIN_PASSWORD`. The bot starts it as a child process.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOD_DASH_HOST` | `127.0.0.1` | Bind address |
| `MOD_DASH_PORT` | `8781` | Port |
| `MOD_DASH_SECRET` | derived | Cookie signing secret. Set it so sessions survive restarts. |
| `STAFF_SERVER` | `staff_guild_id` | Server whose log channels are mirrored |
| `UPLOAD_DIR`, `UPLOAD_PUBLIC_URL` | empty | Folder and public base URL for public file uploads. Leave both empty to disable them. |

Every endpoint except login and static files needs a session, including the `/ws` live feed. Keep it on `127.0.0.1` and reach it over a VPN or a reverse proxy with TLS.

## Data sources

1. **Audit log, live.** `GuildAuditLogEntryCreate` becomes a case for kicks, bans, unbans and timeouts. The source comes from the executor: this bot, Wick, automod or a human.
2. **Bot-issued actions.** The engine records a case whenever staff act through the dashboard.
3. **Logger events.** Every logged event is also written to per-channel day files.

The bot's own actions are deduplicated against their audit-log echo within about 15 seconds.

## Storage

- **Cases and settings:** `data/moderation.json`, behind the `mod-store.js` interface. Swapping in SQLite later means changing only that file.
- **Logs:** `data/logs/<channelId>/dd-mm-yyyy.jsonl`, one JSON record per line, appended live. Files can be reconciled against Discord to rebuild missing days.

### Case record

```
{
  id, seq, guildId,
  type,          // note | warn | timeout | untimeout | kick | softban | ban | tempban | unban
  targetId, targetTag,
  moderatorId, moderatorTag,
  source,        // kitbot | wick | manual | automod
  reason, points, duration (s), expiresAt, active,
  createdAt, evidence[], meta{ auditEntryId, channelId }
}
```

### Per-guild settings

```
{ dmOnPunish, warnDecayDays (0 = never),
  escalation: { enabled, rules: [{ points, action, duration }] },
  wickBotId, modLogChannelId, punishmentRoleId }
```

## Punishment model

- A **warn** is a case with `points`, default 1. Active points add up per member, and `warnDecayDays` expires old warns.
- **Escalation** is off by default. When a member's points cross a rule threshold, the engine applies that rule's action and records it with the reason `Auto-escalation (N pts)`.
- **Timeouts and tempbans** carry a duration. A scheduler lifts them and records the matching `untimeout` or `unban` case.
- **DM on punish** messages the member before the action is applied.

## Engine API

- Engine: `warn() note() timeout() removeTimeout() kick() softban() ban() tempban() unban()`, `getMemberProfile(guildId, userId)`, `listCases(filter)`, `getSettings()/setSettings()`, `getStats()`.
- Log store: `listChannels() listDays(channelId) readDay(channelId, date, { pretty }) reconcile(guildId, channelId)`.
