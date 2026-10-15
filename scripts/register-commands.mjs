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
const commands = [
  { name: "windows", description: "Best times this week for a full party" },
  { name: "lfg", description: "Open a lobby: who's in right now?" },
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
  { name: "back", description: "Back from dinner" },
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

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;
const res = await fetch(url, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
if (res.ok) console.log(`✅ Registered ${commands.length} commands ${guildId ? "in your server" : "globally"}.`);
else {
  console.error(`❌ ${res.status} ${await res.text()}`);
  process.exit(1);
}
