import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();
const uuid = () => crypto.randomUUID();

// ─── Better Auth core tables (Discord login is wired up in M3) ─────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── Receptionist ───────────────────────────────────────────────────────────────────────────

export const memberProfiles = pgTable("member_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** IANA zone, e.g. "America/Chicago". */
  timezone: text("timezone").notNull().default("America/New_York"),
  workStyle: text("work_style", { enum: ["fixed", "hybrid"] }).notNull().default("fixed"),
  /** "HH:mm": the night before a WFH day they can stay up until this time. */
  nightBeforeWfhUntil: text("night_before_wfh_until"),
  discordId: text("discord_id"),
  color: text("color"),
  updatedAt: updatedAt(),
});

export const groups = pgTable("groups", {
  id: text("id").primaryKey().$defaultFn(uuid),
  name: text("name").notNull(),
  homeTimezone: text("home_timezone").notNull().default("America/Chicago"),
  partySize: integer("party_size").notNull().default(5),
  minSessionMinutes: integer("min_session_minutes").notNull().default(90),
  maxPauseMinutes: integer("max_pause_minutes").notNull().default(30),
  matchLengthMinutes: integer("match_length_minutes").notNull().default(40),
  wfhSharedDays: integer("wfh_shared_days").notNull().default(1),
  /** ISO weekday the WFH vote for next week opens (4 = Thu) and closes (5 = Fri), at this hour (home tz). */
  wfhVoteOpenWeekday: integer("wfh_vote_open_weekday").notNull().default(4),
  wfhVoteCloseWeekday: integer("wfh_vote_close_weekday").notNull().default(5),
  wfhVoteHour: integer("wfh_vote_hour").notNull().default(12),
  discordGuildId: text("discord_guild_id"),
  discordChannelId: text("discord_channel_id"),
  discordVoiceChannelId: text("discord_voice_channel_id"),
  createdAt: createdAt(),
});

/**
 * Games the group plays. Windows, lobbies and locked-in sessions are per game, among the members who play
 * it. (The group's own partySize / matchLengthMinutes are from before games existed; games have their own.)
 */
export const games = pgTable(
  "games",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Players needed to play together (5 for a Valorant stack). */
    partySize: integer("party_size").notNull().default(5),
    /** About how long one match takes, for "last queue before dinner" heads-ups. */
    matchMinutes: integer("match_minutes").notNull().default(40),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [unique("games_group_name").on(t.groupId, t.name)],
);

/** Which games each member plays. */
export const memberGames = pgTable(
  "member_games",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.gameId] })],
);

export const memberships = pgTable(
  "memberships",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

/**
 * 40-cell availability patterns (08:00 → 04:00 local).
 * key: "w1"…"w7" = typical weekday (ISO), "wfh1"…"wfh5" = that weekday when working from home,
 * "wfh" = older shared WFH-day pattern (used for weekdays without their own), "d:YYYY-MM-DD" = date override.
 */
export const dayPatterns = pgTable(
  "day_patterns",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    cells: text("cells").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const hybridDays = pgTable(
  "hybrid_days",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    mode: text("mode", { enum: ["office", "wfh", "flex"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekday] })],
);

export const wfhDays = pgTable(
  "wfh_days",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    source: text("source", { enum: ["vote", "manual"] }).notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);

/** Time away (vacation, travel): the member isn't available on any day from startDate to endDate. */
export const vacations = pgTable("vacations", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** First and last day away, inclusive ("YYYY-MM-DD" gaming days in the member's own zone). */
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  createdAt: createdAt(),
});

export const wfhVotes = pgTable(
  "wfh_votes",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    /** Monday of the week being voted on. */
    weekStart: text("week_start").notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    decidedDays: jsonb("decided_days").$type<number[]>(),
    discordMessageId: text("discord_message_id"),
    createdAt: createdAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.groupId, t.weekStart)],
);

export const wfhBallots = pgTable(
  "wfh_ballots",
  {
    voteId: text("vote_id")
      .notNull()
      .references(() => wfhVotes.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    days: jsonb("days").$type<number[]>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.voteId, t.userId] })],
);

export interface SessionPlan {
  playMinutes: number;
  subs: number;
  pauses: Array<{ startMs: number; endMs: number; who: string[] }>;
}

export const playSessions = pgTable("play_sessions", {
  id: text("id").primaryKey().$defaultFn(uuid),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["planned", "live"] }).notNull(),
  /** Which game it's for. Null only if that game was removed. */
  gameId: text("game_id").references(() => games.id, { onDelete: "set null" }),
  status: text("status", { enum: ["active", "ended", "cancelled"] }).notNull().default("active"),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }),
  plan: jsonb("plan").$type<SessionPlan>(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  discordMessageId: text("discord_message_id"),
  discordEventId: text("discord_event_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const playerStatuses = ["in", "soon", "quick_dinner", "long_dinner", "left", "declined"] as const;
export type PlayerStatus = (typeof playerStatuses)[number];

export const playSessionPlayers = pgTable(
  "play_session_players",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => playSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: playerStatuses }).notNull(),
    backAt: timestamp("back_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/** "X was late" reports on locked-in sessions. Shown only as counts, so reporters stay anonymous. */
export const lateReports = pgTable(
  "late_reports",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => playSessions.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lateUserId: text("late_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.reporterId, t.lateUserId] })],
);
