// Register Receptionist's slash commands with Discord (no dependencies).
// Usage: node --env-file=.env.local scripts/register-commands.mjs
// Set DISCORD_GUILD_ID to register them in your server instantly (global commands can take a while).

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in .env.local first.");
  process.exit(1);
}

const STRING = 3;
// Suggestions come from the group's games as you type (the bot answers Discord's autocomplete requests).
const game = (description) => ({ type: STRING, name: "game", description, required: false, autocomplete: true, max_length: 100 });
const commands = [
  { name: "windows", description: "Best times this week to play together", options: [game("Just this game (default: the ones you play)")] },
  { name: "lfg", description: "Who's on? Open a lobby for any game" },
  {
    name: "dinner",
    description: "Step away for dinner",
    options: [
      {
        type: STRING,
        name: "kind",
        description: "Quick (the party waits) or long (you're out for a while)",
        required: true,
        choices: [
          { name: "Quick: the party waits", value: "quick" },
          { name: "Long: I'm out for a while", value: "long" },
        ],
      },
    ],
  },
  {
    name: "back",
    description: "When you'll be back: /back 930, /back 9pm, or /back now",
    options: [
      {
        // Required, so Discord jumps straight into it: type /back, then 930.
        type: STRING,
        name: "at",
        description: "930, 9pm, 21:30, or now (read in your profile's time zone)",
        required: true,
        max_length: 20,
      },
    ],
  },
  {
    name: "wfh",
    description: "Post the WFH-day vote",
    options: [
      {
        type: STRING,
        name: "week",
        description: "Which week to vote on",
        required: false,
        choices: [
          { name: "Next week", value: "next" },
          { name: "This week", value: "this" },
        ],
      },
    ],
  },
];

const api = `https://discord.com/api/v10/applications/${appId}`;
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
const res = await fetch(guildId ? `${api}/guilds/${guildId}/commands` : `${api}/commands`, {
  method: "PUT",
  headers,
  body: JSON.stringify(commands),
});
if (!res.ok) {
  console.error(`❌ ${res.status} ${await res.text()}`);
  process.exit(1);
}
// List what Discord actually saved, options included (e.g. "/back at"), so it's clear which version ran.
const saved = await res.json();
const describe = (c) => `/${[c.name, ...(c.options ?? []).map((o) => o.name)].join(" ")}`;
console.log(`✅ Registered ${saved.length} commands ${guildId ? "in your server" : "globally"}: ${saved.map(describe).join(", ")}`);

// Commands registered globally before (without DISCORD_GUILD_ID) show up as a second, older copy of each.
if (guildId) {
  if (process.argv.includes("--remove-global")) {
    const removed = await fetch(`${api}/commands`, { method: "PUT", headers, body: "[]" });
    console.log(removed.ok ? "🧹 Removed the old global copies." : `❌ Couldn't remove global commands: ${removed.status}`);
  } else {
    const global = await fetch(`${api}/commands`, { headers }).then((r) => (r.ok ? r.json() : []));
    if (global.length) {
      console.log(
        `⚠️ ${global.length} older global commands also exist, so Discord shows each command twice. ` +
          "Remove them with: npm run discord:register -- --remove-global",
      );
    }
  }
}
