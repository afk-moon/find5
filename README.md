# FiveStack

Find times when a full Valorant party (5 people, or any size you set) can play across US time zones. It
plans around dinner and helps hybrid workers line up their work-from-home days. It's a web app plus a
Discord bot.

## Quick start

```bash
npm run dev          # http://localhost:3000
```

Pick one of the five demo friends on the login page. Data lives in an embedded Postgres under `.data/`, so
there's no database server and no accounts to set up. Run `npm run db:reset` to start over. On a fresh
machine, run `npm install` first. This repo pins exact versions; see `.npmrc`.

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server / production build / serve the build |
| `npm test` | Engine and integration tests (Vitest) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:generate` | New SQL migration after editing `src/db/schema.ts` |
| `npm run db:reset` | Delete the local database (it re-seeds demo data on the next start) |

Set `SEED_DEMO=0` in `.env.local` to start with an empty group instead of the demo friends.

## How it works

**Availability.** Each person paints a typical week in their own time. A "gaming day" runs 8am to 4am, so
1am still counts as "tonight". Brushes:

- ✅ free
- 🤷 if needed
- 🍔 quick dinner
- 🍝 long dinner

Times are stored as local time plus an IANA zone (`America/Chicago`, never "CST") and converted to UTC
day by day. Daylight saving changes (e.g. Nov 1) and Arizona (no DST) are handled correctly. One-off
days ("busy this Friday") override the typical week.

**Matching.** The app scans 30-minute slots for windows where the *same* 5 people are around the whole
time. Five people free in every slot isn't enough if they're different people. Extra people show up as
subs. Windows are ranked by play time, then fewer pauses, more subs, and fewer "if needed" players.

**Dinner.**
- **Quick dinner** (up to 30 min, configurable): the party pauses and continues. Back-to-back dinners
  that add up past the limit count as long. A sub can cover a quick dinner, so there's no pause.
- **Long dinner**: the session splits into before and after.
- Session plans include a "⏰ last comp queue" time: dinner time minus a ~40 min match.

**Hybrid WFH sync.**
- Hybrid members mark each weekday as Office, Flexible, or Always WFH. They also paint a WFH-day
  pattern (usually an earlier start) and can say how late they can stay up the night before a WFH day.
- Each week they vote on flexible days. The day the most hybrid members can share wins. Ties go to the
  day that unlocks the most extra 5-stack time.
- Winning days become WFH dates, so everyone's windows recalculate automatically.

**Live lobby.** For spontaneous games, `/lfg` (or the Live page) opens a lobby: I'm in · In 15 min · Not
tonight · 🍔/🍝 dinner · I'm back · Leaving. It pings whoever is free right now and pings the party when
it fills up.

## Discord setup

Discord login, slash commands, and announcements use only Node built-ins, so there's no extra SDK.

1. Create an application at <https://discord.com/developers/applications>.
2. Copy these into `.env.local` (template: `.env.example`):
   - **General Information**: Application ID → `DISCORD_APPLICATION_ID`; Public Key → `DISCORD_PUBLIC_KEY`
   - **Bot**: Reset Token → `DISCORD_BOT_TOKEN`
   - **OAuth2**: Client Secret → `DISCORD_CLIENT_SECRET`; add the redirect
     `<APP_URL>/api/auth/discord/callback` (locally `http://localhost:3000/api/auth/discord/callback`)
   - `AUTH_SECRET`: any long random string
3. **Invite the bot**: OAuth2 → URL Generator → scopes `bot` and `applications.commands`. Permissions:
   View Channels, Send Messages, Read Message History, Create Events, Manage Events.
4. **Register slash commands**: `node --env-file=.env.local scripts/register-commands.mjs`. Set
   `DISCORD_GUILD_ID` to make them appear in your server instantly.
5. **Interactions Endpoint URL** (General Information): `<APP_URL>/api/discord/interactions`. Discord
   needs a public HTTPS URL. Deploy (below) or use a tunnel to `localhost:3000`.
6. Everyone clicks **Log in with Discord** once, so the bot can map Discord users to members. The first
   time someone uses a command in your server, that server and channel become the group's announcement
   channel (you can change them in Settings).

Commands: `/windows`, `/lfg`, `/dinner quick|long`, `/back`, `/wfh [this|next]`. Locking in a window
posts the plan and creates a Discord Scheduled Event; Discord notifies everyone who taps "Interested".

## Deploying (e.g. Vercel + Supabase/Neon)

- Set `DATABASE_URL` to a hosted Postgres. Migrations in `drizzle/` run on the first request.
- Also set `APP_URL`, `AUTH_SECRET`, `CRON_SECRET`, and the Discord variables.
- `vercel.json` runs `/api/cron/daily` once a day. It opens next week's WFH vote on the group's "open"
  weekday (Thu by default) and decides it on the "close" weekday (Fri).
- Demo login is off in production unless `ALLOW_DEV_LOGIN=1`.

## Project layout

```
src/engine/     Pure TypeScript scheduling engine: time zones/DST, quorum matcher, dinners, WFH planner (+ tests)
src/db/         Drizzle schema, embedded-Postgres/Postgres client, demo seed
src/server/     Services shared by the web app and the bot: windows, sessions, WFH votes, availability, Discord sync
src/discord/    Signature verification, REST client, message builders, slash command and button handlers
src/app/        Next.js pages (Windows, Live, My availability, WFH sync, Settings, Login), server actions, API routes
scripts/        register-commands.mjs
drizzle/        SQL migrations
```
