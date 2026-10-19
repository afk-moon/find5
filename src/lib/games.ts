/**
 * Starter games every new group gets (members pick which ones they play). Party size is how many players
 * are needed to play together; match length is for "last queue before dinner" heads-ups. Both can be
 * changed per game in Settings. Keep in sync with the data step in drizzle/0003_games.sql.
 */
export const DEFAULT_GAMES = [
  { slug: "valorant", name: "Valorant", partySize: 5, matchMinutes: 40 },
  { slug: "lol", name: "League of Legends", partySize: 5, matchMinutes: 35 },
  { slug: "tft", name: "TFT", partySize: 2, matchMinutes: 40 },
  { slug: "aion2", name: "Aion 2", partySize: 4, matchMinutes: 30 },
] as const;

/** Starter games have predictable ids, e.g. "valorant-<groupId>". Games members add get random ids. */
export const defaultGameId = (slug: string, groupId: string) => `${slug}-${groupId}`;

/** Rows for a new group's starter games (created a second apart, so ties list in this order). */
export function defaultGameRows(groupId: string, nowMs = Date.now()) {
  return DEFAULT_GAMES.map((g, i) => ({
    id: defaultGameId(g.slug, groupId),
    groupId,
    name: g.name,
    partySize: g.partySize,
    matchMinutes: g.matchMinutes,
    createdAt: new Date(nowMs + i * 1000),
  }));
}

export const MIN_PARTY = 2;
export const MAX_PARTY = 10;

/** "duo" for 2-player games (TFT Double Up), else "4-stack", "5-stack"… */
export const partyLabel = (size: number) => (size === 2 ? "duo" : `${size}-stack`);
