# Receptionist

Find times when a full party can play across US time zones, for each game your group plays (Valorant,
League of Legends, TFT and Aion 2 to start; add your own). It plans around dinner and helps hybrid workers
line up their work-from-home days. It's a web app plus an optional Discord bot.

- **Games:** everyone ticks the games they play under **My availability → My games**, and can add a game
  that's missing. Windows, lobbies and pings for a game only include the people who play it. Each game
  has its own party size (5 for Valorant, a duo for TFT…), editable in **Settings → Games**.
- **Windows:** each game's best times this week when the same people are free, shown in your own time zone.
- **Dinner-aware:** a 🍔 quick dinner pauses the party; a 🍝 long dinner splits the session.
- **WFH sync:** hybrid members vote on a shared work-from-home day that unlocks the most play time.
- **Vacation:** in **My availability**, pick the first and last day you're away. You show as busy on every
  day in between, whatever your usual week or one-off days say, and the Live page shows who's on vacation.
- **Live lobby:** “who's on right now?” with I'm in / in 15 min / dinner / back, one lobby per game. A lobby
  closes at 4am (group time) or after 12 hours, and its Discord post switches to “lobby closed” without
  buttons, so an old post never looks open. Posting `/lfg` again while a lobby is open moves it to the new
  post.
- **Late reports:** once a locked-in session starts, teammates can report who was late. Anyone late in
  more than half of their last 10 sessions gets a ⏰ **Frequently late** tag next to their name.
- **Discord:** login, slash commands, lobby buttons, announcements, and Scheduled Events.

---

## Run it locally

Running locally needs only Node.js. There's no database server, Docker, or account to set up. The app
ships with an embedded Postgres and five demo friends to play with.

### 1. Install the prerequisites

You need **Node.js 20.9 or newer**, on an LTS (even-numbered) version: 20, 22, or 24. **24 is
recommended.** npm comes with Node. You also need **Git** to clone the repo (or use GitHub's “Download
ZIP”).

<details open>
<summary><b>Windows</b></summary>

1. Install Node.js LTS from <https://nodejs.org> (the big “LTS” button), or in PowerShell:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
2. Install Git from <https://git-scm.com/download/win>, or `winget install Git.Git`.
3. **Close and reopen** your terminal (PowerShell or Windows Terminal) so it picks up `node` and `git`.

</details>

<details open>
<summary><b>macOS</b></summary>

Using nvm (no admin rights needed):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
# open a NEW terminal window, then:
nvm install 24
```

Alternatives: the installer from <https://nodejs.org>, or `brew install node@24` with Homebrew. Git
comes with Apple's command line tools: run `xcode-select --install` if `git --version` doesn't work.

</details>

<details open>
<summary><b>Linux</b></summary>

Use nvm (distro packages are often too old):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
# open a NEW terminal, then:
nvm install 24
```

Install Git with your package manager, e.g. `sudo apt install git`.

</details>

Check that everything is there:

```bash
node -v   # v20.9.0 or newer (v24.x recommended)
npm -v
git --version
```

### 2. Get the code

```bash
git clone https://github.com/afk-moon/find5.git
cd find5
```

If you used nvm, run `nvm use` in this folder. It reads `.nvmrc` and switches to Node 24.

### 3. Install the dependencies

```bash
npm install
```

This installs everything in `package.json` at the exact versions pinned in `package-lock.json`: Next.js,
React, Tailwind CSS, Drizzle ORM, the embedded Postgres (PGlite), Luxon, Vitest, ESLint, and TypeScript.
It takes a minute or two. The `.npmrc` file in the repo is required, so keep it: it stops npm from
pulling in optional database drivers that conflict.

### 4. Start the app

```bash
npm run dev
```

Open **<http://localhost:3000>** and click one of the demo friends (Maya, Dev, Rosa, Kai, Sam), or join as
yourself. The first page load takes a few seconds: the app creates its database in `.data/` and fills it
with demo data. Stop the server with **Ctrl+C**.

Things to try:

- Switch between friends to see times in different zones.
- Switch games with the tabs on the Windows page. Everyone plays Valorant, Maya and Rosa are a TFT duo,
  four play Aion 2, and League is one player short. Tick your own games under **My availability**.
- Paint your week on **My availability**.
- Lock in a window.
- Open a **Live** lobby.
- Vote on **WFH sync** as Maya or Kai (they're the hybrid workers).
- Try the ⏰ **late check** on the Windows page. The demo data includes a session that started about 2
  hours before your first run, and its late check stays open for 24 hours (`npm run db:reset` gives you a
  fresh one). Maya already reported Sam, so one more report from anyone else makes it count. Sam
  already has the **Frequently late** tag from the demo history.

### 5. (Optional) Settings

Nothing is required locally. To change defaults, copy the template and edit it:

```bash
cp .env.example .env.local              # macOS / Linux
Copy-Item .env.example .env.local       # Windows PowerShell
```

Restart `npm run dev` after editing. Each variable is explained in `.env.example`. For example,
`SEED_DEMO=0` starts with an empty group instead of the demo friends. Run `npm run db:reset` first if
you've already started the app once.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server at <http://localhost:3000> (reloads on code changes) |
| `npm test` | Run the tests: scheduling engine plus full flows against a temporary database |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript checks |
| `npm run build` then `npm start` | Production build and server. Demo login is off in production; add `ALLOW_DEV_LOGIN=1` to `.env.local` to try it locally |
| `npm run db:reset` | Delete the local database. It's recreated, with fresh demo data, on the next start |
| `npm run db:generate` | Create a SQL migration after editing `src/db/schema.ts` |
| `npm run discord:register` | Register the Discord slash commands (see [Discord setup](#discord-setup)) |

### Troubleshooting

- **`'next' is not recognized as an internal or external command`** (Windows), or **`next: command not
  found`** (Mac/Linux): the dependencies aren't installed in this folder. Run `npm install` in the
  project folder, then `npm run dev`. If you copied the folder from another computer, delete its
  `node_modules` folder first: in PowerShell `Remove-Item -Recurse -Force node_modules`, on Mac/Linux
  `rm -rf node_modules`.
- **`node` or `npm` not found, or “Unsupported engine”:** install or upgrade Node (step 1), then open a
  new terminal. With nvm, run `nvm use` in the project folder.
- **`npm install` fails with `ERESOLVE` peer-dependency errors:** the hidden `.npmrc` file is missing.
  Restore it from the repo, or run `npm install --legacy-peer-deps`.
- **Port 3000 is already in use:** run `npm run dev -- -p 3001` and open <http://localhost:3001>. If you
  use Discord, update `APP_URL` too.
- **Database errors after pulling new changes, or you want fresh demo data:** run `npm run db:reset`,
  then start again. New tables are added automatically, but demo data is only created for a brand-new
  database. For example, you won't see the demo late history until you reset.
- **Company laptop with a private npm registry:** nothing to change. The lockfile uses public npm URLs,
  and npm automatically swaps in your configured registry.

---

## How it works

**Availability.** Each person paints a typical week in their own time. A “gaming day” runs 8am to 4am,
so 1am still counts as “tonight”. Brushes:

- ✅ free
- 🤷 if needed
- 🍔 quick dinner
- 🍝 long dinner

Times are stored as local time plus a named time zone (`America/Chicago`, never “CST”) and converted
day by day. Daylight saving changes and Arizona (which skips DST) are handled. One-off days (“busy this
Friday”) override the typical week.

**Matching.** Each game is matched separately, among the members who play it. The app scans 30-minute
slots for windows where the *same* people (as many as the game's party size, e.g. 5 for Valorant) are
around the whole time. Five people free in every slot isn't enough if they're different people. Extra
people show up as subs. Windows are ranked by play time, then fewer pauses, more subs, and fewer “if
needed” players. A game with fewer players than its party size says so instead of showing windows.

**Games.** New groups start with Valorant (5), League of Legends (5), TFT (duo) and Aion 2 (4). Anyone can
add a game under **My availability → My games** (they're signed up for it), and **Settings → Games**
changes a game's name, party size and match length, or removes it (past sessions stay). People who joined
before games existed play Valorant; new members pick their own.

**Dinner.**
- **Quick dinner** (up to 30 min, configurable): the party pauses and continues. Back-to-back dinners
  that add up past the limit count as long. A free sub covers a quick dinner, so there's no pause.
- **Long dinner**: the session splits into before and after.
- Session plans include a “⏰ last queue” time: dinner time minus one match of that game (about 40 min
  for Valorant; set per game).

**Hybrid WFH sync.**
- Hybrid members mark each weekday as Office, Flexible, or Always WFH. They also paint what each WFH
  weekday looks like (usually an earlier start; a WFH Monday can differ from a WFH Friday) and can say
  how late they can stay up the night before a WFH day.
- Each week they vote on flexible days. The day the most hybrid members can share wins. Ties go to the
  day that unlocks the most extra play time in the game most of the group plays. Hybrid members who
  don't play that game still vote.
- Winning days become WFH dates, and everyone's windows recalculate.

**Live lobby.** `/lfg` in Discord, or the **Live** page, opens a lobby for a game. It pings whoever plays
that game and is free right now, tracks quick and long dinners with “back in…” countdowns, and pings the
party when it's full. Each game has its own lobby, so a Valorant lobby and a TFT lobby can be open at once.

**Late reports.** These work on locked-in sessions, from the Windows page or the buttons on the
session's Discord post.
- Reporting opens at the session's start time and stays open for 24 hours. Before that, the buttons
  only say when it opens.
- Only players in that session can report, and not themselves. Tap again to take a report back.
- Someone counts as late once at least half of the *other* players report them (2 of 4 in a 5-stack),
  so one person can't mark someone late alone.
- Everyone sees the counts, but not who reported whom.
- **⏰ Frequently late** = late in more than half (over 50%) of their most recent 10 sessions. A session
  counts once its 24 hours of voting are over, and the tag needs at least 3 finished sessions, so one bad
  night doesn't tag a new member.
- A session can't be cancelled after it starts, so cancelling can't wipe out late reports.
- All of these numbers are constants at the top of `src/engine/lateness.ts`.

---

## Discord setup

The website works fine without Discord. Discord adds login, pings, slash commands, and announcements,
using Node built-ins only, so there's nothing extra to install.

1. Create an application at <https://discord.com/developers/applications>. Name it **Receptionist**:
   the application's name is the bot's name in your server.
2. Copy these into `.env.local` (template: `.env.example`):
   - **General Information**: Application ID → `DISCORD_APPLICATION_ID`; Public Key → `DISCORD_PUBLIC_KEY`
   - **Bot**: Reset Token → `DISCORD_BOT_TOKEN`
   - **OAuth2**: Client Secret → `DISCORD_CLIENT_SECRET`
   - `AUTH_SECRET`: any long random string
   - Optional: `DISCORD_GUILD_ID`, your server's ID (makes slash commands appear instantly)
3. **Invite the bot**: OAuth2 → URL Generator → scopes `bot` and `applications.commands`. Permissions:
   View Channels, Send Messages, Read Message History, Create Events, Manage Events. Open the generated
   URL and add the bot to your server.
4. **Register slash commands**: `npm run discord:register`
5. **Give Discord a public URL.** Discord has to reach your app over HTTPS, so `localhost` won't work.
   - **Testing from your computer:** run a tunnel such as `cloudflared tunnel --url http://localhost:3000`
     or `ngrok http 3000`. Set `APP_URL` in `.env.local` to the tunnel's https URL and restart
     `npm run dev`. Quick tunnels get a new URL each run.
   - **Long-term:** [deploy it](#deploying).
6. In the developer portal, using your public URL:
   - **General Information → Interactions Endpoint URL:** `<APP_URL>/api/discord/interactions`.
     Discord sends a test request when you save, and the app answers it.
   - **OAuth2 → Redirects:** `<APP_URL>/api/auth/discord/callback`, then **Save Changes**. It must match
     exactly (https, spelling, no trailing slash), otherwise Discord says “Invalid OAuth2 redirect_uri”.
     The login page (under that message) and **Settings** show the exact URL to copy.
7. Everyone opens the site and clicks **Log in with Discord** once, so the bot can match Discord users to
   members. The first time someone uses a command in your server, that channel becomes the announcement
   channel (you can change it in **Settings**).

Commands:

- `/windows`: best times this week for the games you play. `/windows game: TFT` shows just one game
  (start typing and pick it from the list).
- `/lfg`: open a lobby. If you play several games it asks which one (blue buttons already have a lobby
  open); `/lfg game: Valorant` skips the question.
- `/dinner quick|long`: for the lobby you're in
- `/back 930` (or `9pm`, `21:30`, `noon`): you're away until then. Your availability for today changes to
  busy until then and free from then, so windows and pings use it right away. The time is read in your
  profile's time zone, and a bare `930` means whichever 9:30 comes next. You're free until the end of what
  you'd already planned that evening, or until midnight (at least 2 hours) if you hadn't planned anything.
  The lobby you're in (or the one open lobby for a game you play) shows when you'll be back. It's saved as
  a one-off day, so you can see or undo it under **My availability → Specific days**. Discord shows it as
  `/back at: 930`; just type `/back`, then the time.
- `/back now`: back from dinner (puts you back in your lobby), or free from now if your schedule said busy
- `/wfh [this|next]`: post the WFH vote

After changing commands (for example, after updating the app), run `npm run discord:register` again, from
the updated code. It lists what Discord saved, for example `/back at`. If you then still see the old version
in Discord, reload it (Ctrl+R, or restart the phone app). If it warns that older global commands exist
(each command shows up twice), run `npm run discord:register -- --remove-global`.

Locking in a window posts the plan and creates a Discord Scheduled Event; Discord notifies everyone who
taps “Interested”. The post also has a “*name* was late” button for each player. These work once the
session starts: the post shows only the counts, and the person who tapped gets a private confirmation.

---

## Deploying

This works on any Node host with a Postgres database. On Vercel with Neon:

1. **Import the repo:** in Vercel, **Add New → Project** → pick `find5`.
2. **Add the database:** in the project, open **Storage → Create Database → Neon**, then **Connect**
   it to the project (at least **Production**). This adds `DATABASE_URL` (plus a few `PG*`/`POSTGRES_*`
   variables the app ignores) to the project for you, so there's nothing to copy. The `.env.local` tab
   on the database page is only for pointing your own computer at this database. Skip it: your local
   app uses its built-in database, and the hosted one holds your group's real data.
3. **Add the other variables** in **Settings → Environment Variables**:

   | Variable | Value |
   |---|---|
   | `APP_URL` | Your site's address, e.g. `https://your-project.vercel.app` (no trailing slash) |
   | `AUTH_SECRET` | Any long random string, e.g. from `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` |
   | `CRON_SECRET` | Another random string (protects the daily job) |
   | Discord variables | Only if you use Discord (see [Discord setup](#discord-setup)) |
   | `SEED_DEMO` | `1` only if you want the demo friends in the hosted database |
   | `ALLOW_DEV_LOGIN` | `1` only to test without Discord login. Anyone with the link can then sign in as anyone |

4. **Redeploy:** **Deployments → ⋯ → Redeploy**. Variable changes only apply to new deployments. The
   database tables are created automatically on the first visit.

How people log in: with Discord login set up, each friend clicks **Log in with Discord** and joins the
group automatically. The first person creates it. Without Discord, set `ALLOW_DEV_LOGIN=1` and use
“join as a new member” on the login page.

If a page shows an error, open the deployment's **Logs** in Vercel. “DATABASE_URL is not set” means the
database isn't connected to that environment yet (step 2), or the project wasn't redeployed after
connecting it.

`vercel.json` runs `/api/cron/daily` once a day. It opens next week's WFH vote on the group's “open”
weekday (Thu by default) and decides it on the “close” weekday (Fri). It also updates the Discord posts of
late checks that have closed, showing who was late and removing the buttons.

`vercel.json` also runs the app in Portland (`"regions": ["pdx1"]`), next to the Neon database. Every page
waits on the database, so the app should run in the same region as it. If your database is somewhere
else, change `regions` to the matching [Vercel region](https://vercel.com/docs/regions) (e.g. `iad1` for
Washington, D.C.). A Neon database's region can't be changed after it's created.

---

## Project layout

```
src/engine/     Scheduling engine (pure TypeScript): time zones/DST, matching, dinners, WFH planner, late rules, plus tests
src/db/         Database schema (Drizzle), embedded-Postgres/Postgres client, demo data
src/server/     Logic shared by the website and the bot: windows, sessions, WFH votes, late reports, availability, Discord sync
src/discord/    Discord request verification, REST client, message builders, command and button handlers
src/app/        Next.js pages (Windows, Live, My availability, WFH sync, Settings, Login), actions, API routes
scripts/        register-commands.mjs (Discord slash commands)
drizzle/        SQL migrations
```
