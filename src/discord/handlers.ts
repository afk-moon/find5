import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { groups, playSessions, wfhVotes } from "@/db/schema";
import type { Weekday } from "@/engine";
import { discordTs } from "@/lib/format";
import { partyLabel } from "@/lib/games";
import { setAwayUntil } from "@/server/away";
import { findGame, forGame, gamesOf, loadGroupContext, type GameView, type GroupContext, type MemberView } from "@/server/context";
import { getLateTally, toggleLateReport } from "@/server/lateness";
import { freeNowNotInLobby, markLobbyMoved, syncLobby } from "@/server/notify";
import {
  activeLive,
  endSession,
  getSession,
  goToDinner,
  lobbyExpired,
  setPlayerStatus,
  startLive,
  summarizeLive,
} from "@/server/sessions";
import { clearBallot, ensureVote, getWfhState, toggleBallotDay, weekStartOf } from "@/server/wfh";
import { upcomingWindows } from "@/server/windows";
import {
  awayMessage,
  lobbyMessage,
  storedPlannedMessage,
  windowsMessage,
  wfhVoteMessage,
} from "./messages";
import { appUrl, postFollowup, type DiscordMessage } from "./rest";

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number; // 1 ping, 2 slash command, 3 button, 4 autocomplete
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    name?: string;
    /** `focused` marks the option being typed in, for autocomplete. */
    options?: Array<{ name: string; value: string | number; focused?: boolean }>;
    custom_id?: string;
  };
  message?: { id: string; channel_id: string };
}

export interface Choice {
  name: string;
  value: string;
}
export type InteractionResponse = { type: number; data?: DiscordMessage };
/** Reply to an autocomplete request (type 4): just the choices. */
export type AutocompleteResponse = { type: 8; data: { choices: Choice[] } };
/** Work to run after the response is sent (Discord wants a reply within 3 seconds). */
type Defer = (task: () => Promise<unknown>) => void;

const EPHEMERAL = 64;
const reply = (data: DiscordMessage): InteractionResponse => ({ type: 4, data });
const update = (data: DiscordMessage): InteractionResponse => ({ type: 7, data });
const ephemeral = (content: string): InteractionResponse => ({
  type: 4,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
});

export async function handleInteraction(i: Interaction, defer: Defer): Promise<InteractionResponse> {
  if (i.type === 1) return { type: 1 }; // PING → PONG

  const ctx = await groupFor(i);
  if (!ctx) return ephemeral(`No group yet. Open ${appUrl()} and log in first.`);
  const discordId = (i.member?.user ?? i.user)?.id;
  const me = ctx.members.find((m) => m.discordId === discordId);
  if (!me) return ephemeral(`I don't know you yet. Log in with Discord once at ${appUrl()}/login, then try again.`);

  try {
    if (i.type === 2) return await onCommand(i, ctx, me, defer);
    if (i.type === 3) return await onButton(i, ctx, me, defer);
    return ephemeral("Unsupported interaction.");
  } catch (err) {
    return ephemeral(`⚠️ ${err instanceof Error ? err.message : "Something went wrong."}`);
  }
}

/** Autocomplete (type 4) for the `game:` option. It only takes a list of choices back, never a message. */
export async function handleAutocomplete(i: Interaction): Promise<AutocompleteResponse> {
  return gameChoices(i, await groupFor(i), (i.member?.user ?? i.user)?.id);
}

/** The group bound to this server. The first time a server uses the bot, the first group claims it. */
async function groupFor(i: Interaction): Promise<GroupContext | null> {
  const db = await getDb();
  let [group] = i.guild_id ? await db.select().from(groups).where(eq(groups.discordGuildId, i.guild_id)) : [];
  if (!group) {
    [group] = await db.select().from(groups).limit(1);
    if (!group) return null;
    if (!group.discordGuildId && i.guild_id) {
      await db
        .update(groups)
        .set({ discordGuildId: i.guild_id, discordChannelId: group.discordChannelId ?? i.channel_id ?? null })
        .where(eq(groups.id, group.id));
    }
  }
  return loadGroupContext(group.id);
}

/** After replying, look up the reply's message id so the web app can edit it later. */
function rememberReply(i: Interaction, save: (ref: string) => Promise<unknown>) {
  return async () => {
    const res = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`);
    if (!res.ok) return;
    const msg = (await res.json()) as { id: string; channel_id: string };
    await save(`${msg.channel_id}:${msg.id}`);
  };
}

/** The `game:` option's suggestions as they type: matching games, the ones they play first. */
function gameChoices(i: Interaction, ctx: GroupContext | null, discordId?: string): AutocompleteResponse {
  const typed = String(i.data?.options?.find((o) => o.focused)?.value ?? "").trim().toLowerCase();
  const me = ctx?.members.find((m) => m.discordId === discordId);
  const mine = (g: GameView) => (me && g.players.includes(me.id) ? 1 : 0);
  const choices = (ctx?.games ?? [])
    .filter((g) => g.name.toLowerCase().includes(typed))
    .sort((a, b) => mine(b) - mine(a)) // stable: most players first within each group
    .slice(0, 25)
    .map((g) => {
      const n = g.players.length;
      return { name: `${g.name} (${partyLabel(g.partySize)}) · ${n} ${n === 1 ? "player" : "players"}`.slice(0, 100), value: g.id };
    });
  return { type: 8, data: { choices } };
}

const unknownGame = (ctx: GroupContext, text: string) =>
  ephemeral(
    `I don't know a game called “${text.slice(0, 40)}”. Games: ${ctx.games.map((g) => g.name).join(", ") || "none yet"}. ` +
      `Add one at <${appUrl()}/availability>.`,
  );

async function onCommand(i: Interaction, ctx: GroupContext, me: MemberView, defer: Defer) {
  const option = (name: string) => i.data?.options?.find((o) => o.name === name)?.value;
  const db = await getDb();

  switch (i.data?.name) {
    case "windows": {
      // One game if they named it; otherwise the games they play (or every game people play, if they haven't picked).
      const text = String(option("game") ?? "").trim();
      const picked = findGame(ctx, text);
      if (text && !picked) return unknownGame(ctx, text);
      const mine = gamesOf(ctx, me.id);
      const list = picked ? [picked] : mine.length ? mine : ctx.games.filter((g) => g.players.length);
      const sections = list.map((g) => ({ game: g, windows: upcomingWindows(forGame(ctx, g)) }));
      return reply(windowsMessage(sections, appUrl()));
    }

    case "lfg": {
      // One lobby for every game: whoever's in decides what to play, and the post shows which games are ready.
      const { sessionId, created, closed } = await startLive(ctx, me.id);
      const s = (await getSession(ctx.group.id, sessionId))!;
      const freeNow = freeNowNotInLobby(ctx, s.players.map((p) => p.userId));
      // Lobbies that expired (like last night's) were just closed: show that on their posts.
      for (const id of closed) defer(() => syncLobby(ctx, id));
      // This reply becomes the lobby message that button clicks and the web app keep updated. If the lobby was
      // already open, its older post becomes a pointer to this one, so only one post has buttons.
      const previous = created ? null : s.session.discordMessageId;
      defer(
        rememberReply(i, async (ref) => {
          await db.update(playSessions).set({ discordMessageId: ref }).where(eq(playSessions.id, sessionId));
          if (previous && previous !== ref) await markLobbyMoved(previous, ref, i.guild_id);
        }),
      );
      return reply(lobbyMessage(ctx, s.session, summarizeLive(ctx.games, s.players), freeNow));
    }

    case "dinner":
    case "back": {
      // "/back 930": away until then. Changes their availability, so it works without a lobby too.
      // ("time" is the option's old name, from before it became the required "at".)
      const time = i.data?.name === "back" ? String(option("at") ?? option("time") ?? "").trim() : "";
      if (time) {
        const away = await setAwayUntil(ctx, me.id, time);
        const lobby = away.lobby;
        if (lobby) defer(() => syncLobby(ctx, lobby.sessionId));
        return ephemeral(awayMessage(away, me.timezone, appUrl()));
      }
      // The time is required on /back now, so a /back without one comes from Discord's old copy of the
      // command. That copy drops anything typed after "/back", so say why the time didn't come through.
      const stale =
        "Discord's copy of /back is out of date, so it didn't send a time. Reload Discord (Ctrl+R, or restart " +
        "the app). If the time box still doesn't appear, run `npm run discord:register` again.";
      const live = await activeLive(ctx.group);
      if (!live) return ephemeral(i.data?.name === "back" ? `⚠️ ${stale}` : "No lobby is open. Start one with /lfg.");
      const kind = option("kind") === "long" ? "long" : "quick";
      if (i.data?.name === "dinner") await goToDinner(ctx, live.session.id, me.id, kind);
      else await setPlayerStatus(ctx, live.session.id, me.id, "in");
      defer(() => syncLobby(ctx, live.session.id));
      if (i.data?.name === "back") return ephemeral(`Welcome back! 🎮\n-# Meant to give a time? ${stale}`);
      return ephemeral(
        kind === "quick"
          ? `🍔 Enjoy! The party will wait about ${ctx.group.maxPauseMinutes} min.`
          : "🍝 Enjoy dinner! The lobby will look for a sub. Tap “I'm back” when you return.",
      );
    }

    case "wfh": {
      const weekStart = weekStartOf(ctx.group.homeTimezone, option("week") === "this" ? 0 : 1);
      const vote = await ensureVote(ctx.group.id, weekStart);
      defer(rememberReply(i, (ref) => db.update(wfhVotes).set({ discordMessageId: ref }).where(eq(wfhVotes.id, vote.id))));
      return reply(wfhVoteMessage(ctx, await getWfhState(ctx, weekStart), appUrl()));
    }
  }
  return ephemeral("Unknown command.");
}

async function onButton(i: Interaction, ctx: GroupContext, me: MemberView, defer: Defer) {
  const [kind, a, b] = (i.data?.custom_id ?? "").split(":");
  // A private note to whoever tapped, sent after the response (which edits the shared message).
  const whisper = (content: string) =>
    defer(() => postFollowup(i.application_id, i.token, { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }));

  if (kind === "lfg") {
    const action = a;
    const sessionId = b;
    let s = await getSession(ctx.group.id, sessionId);
    if (!s) return ephemeral("That lobby is gone. Start a new one with /lfg.");
    // An old lobby (like last night's) closes when someone taps it, and its post loses the buttons.
    if (s.session.status === "active" && lobbyExpired(s.session, Date.now(), ctx.group.homeTimezone)) {
      await endSession(ctx, sessionId);
      s = (await getSession(ctx.group.id, sessionId))!;
    }
    if (s.session.status !== "active") {
      whisper("That lobby is closed. Start a new one with /lfg.");
      return update(lobbyMessage(ctx, s.session, summarizeLive(ctx.games, s.players), []));
    }
    switch (action) {
      case "in":
      case "back":
        await setPlayerStatus(ctx, sessionId, me.id, "in");
        break;
      case "soon":
        await setPlayerStatus(ctx, sessionId, me.id, "soon", new Date(Date.now() + 15 * 60_000));
        break;
      case "declined":
      case "left":
        await setPlayerStatus(ctx, sessionId, me.id, action);
        break;
      case "quick":
      case "long":
        await goToDinner(ctx, sessionId, me.id, action);
        break;
      default:
        return ephemeral("Unknown button.");
    }
    const fresh = (await getSession(ctx.group.id, sessionId))!;
    const summary = summarizeLive(ctx.games, fresh.players);
    if (!fresh.session.discordMessageId && i.message) {
      const ref = `${i.message.channel_id}:${i.message.id}`;
      defer(() => getDb().then((db) => db.update(playSessions).set({ discordMessageId: ref }).where(eq(playSessions.id, sessionId))));
    }
    // Keep "Free right now": whoever's free by their schedule and still hasn't answered.
    const freeNow = freeNowNotInLobby(ctx, fresh.players.map((p) => p.userId));
    return update(lobbyMessage(ctx, fresh.session, summary, freeNow));
  }

  if (kind === "wfh") {
    const weekStart = a;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return ephemeral("Unknown week.");
    if (b === "none") await clearBallot(ctx, weekStart, me.id);
    else await toggleBallotDay(ctx, weekStart, me.id, Number(b) as Weekday);
    return update(wfhVoteMessage(ctx, await getWfhState(ctx, weekStart), appUrl()));
  }

  if (kind === "late") {
    const sessionId = a;
    const lateUserId = b;
    const found = await getLateTally(ctx.group.id, sessionId, me.id);
    if (!found) return ephemeral("That session isn't available anymore.");
    if (found.tally.voting === "not-started") {
      return ephemeral(`⏰ Late reports open when the session starts (${discordTs(found.tally.startMs, "R")}).`);
    }
    // Remember this message so reports made in the web app refresh it too.
    if (!found.session.discordMessageId && i.message) {
      const ref = `${i.message.channel_id}:${i.message.id}`;
      defer(() => getDb().then((db) => db.update(playSessions).set({ discordMessageId: ref }).where(eq(playSessions.id, sessionId))));
    }
    // The shared message only ever shows counts; the clicker gets a private confirmation.
    if (found.tally.voting === "closed") {
      whisper("Late reports for this session are closed.");
      return update(storedPlannedMessage(ctx, found.session, found.tally)); // shows the result and drops the buttons
    }
    const { reported, tally } = await toggleLateReport(ctx, sessionId, me.id, lateUserId);
    const name = ctx.byId.get(lateUserId)?.name ?? "them";
    const n = tally.counts[lateUserId] ?? 0;
    whisper(
      reported
        ? `⏰ You reported **${name}** as late (${n} of ${tally.needed} reports needed${n >= tally.needed ? ", so it counts" : ""}). Only you can see this. Tap again to undo.`
        : `↩️ Took back your late report for **${name}**.`,
    );
    return update(storedPlannedMessage(ctx, found.session, tally));
  }

  return ephemeral("Unknown button.");
}
