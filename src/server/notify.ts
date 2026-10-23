import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { playSessions, wfhVotes } from "@/db/schema";
import {
  lobbyMessage,
  lobbyReplacedMessage,
  partyLabel,
  dailyWindowsMessage,
  plannedSessionMessage,
  stackReadyDm,
  storedPlannedMessage,
  wfhDecisionMessage,
  wfhVoteMessage,
} from "@/discord/messages";
import {
  appUrl,
  botConfigured,
  createScheduledEvent,
  editMessage,
  editScheduledEvent,
  postMessage,
  sendDirectMessage,
} from "@/discord/rest";
import { lateVotingClosesAt, type PlayWindow } from "@/engine";
import type { GameContext, GroupContext } from "./context";
import { getLateTally } from "./lateness";
import { getParty, partyOf } from "./party";
import {
  closeExpiredLobbies,
  fullStacks,
  getSession,
  LOBBY_STATUSES,
  summarizeLive,
  type GameProgress,
  type PlaySession,
  type SessionPlayer,
} from "./sessions";
import { getWfhState } from "./wfh";
import { membersNow } from "./windows";

/** Discord sync must never break the web app: failures are logged, not thrown. No-op without a bot token. */
async function safely(label: string, fn: () => Promise<void>) {
  if (!botConfigured()) return;
  try {
    await fn();
  } catch (err) {
    console.error(`[discord] ${label} failed:`, err);
  }
}

/** Message refs are stored as "channelId:messageId". */
function parseRef(ref: string | null | undefined) {
  const [channelId, messageId] = (ref ?? "").split(":");
  return channelId && messageId ? { channelId, messageId } : null;
}

/** Everyone free by their schedule right now who hasn't answered the lobby (it's for every game). */
export function freeNowNotInLobby(ctx: GroupContext, lobby: Iterable<string>): string[] {
  const inLobby = new Set(lobby);
  return membersNow(ctx)
    .filter((m) => (m.state === "F" || m.state === "M") && !inLobby.has(m.member.id))
    .map((m) => m.member.id);
}

/** "Party: Maya, Dev, …" for the server event. */
const partyDescription = (ctx: GroupContext, party: readonly string[]) =>
  `Party: ${party.map((id) => ctx.byId.get(id)?.name ?? "someone").join(", ")}`;

/** Post the day's windows for a game (the bot does this in the morning, see autopost.ts). */
export function postDailyWindows(ctx: GameContext, windows: readonly PlayWindow[], leadMinutes: number) {
  return safely("daily windows", async () => {
    if (ctx.group.discordChannelId) await postMessage(ctx.group.discordChannelId, dailyWindowsMessage(ctx, windows, leadMinutes));
  });
}

/**
 * Post the locked-in session (with its dinner/last-queue timeline and late check) and create a Scheduled Event.
 * `event: false` skips the event (the bot's own lock-ins happen minutes before the start; the post pings the party).
 */
export function announceLockIn(ctx: GameContext, session: PlaySession, window: PlayWindow, { event = true } = {}) {
  return safely("lock-in", async () => {
    const channelId = ctx.group.discordChannelId;
    if (!channelId) return;
    const [late, found] = await Promise.all([getLateTally(ctx.group.id, session.id), getParty(ctx, session.id)]);
    const posted = await postMessage(channelId, plannedSessionMessage(ctx, window, late?.tally, found?.party));
    let eventId: string | null = null;
    if (event && ctx.group.discordGuildId && window.startMs > Date.now() + 60_000) {
      const event = await createScheduledEvent(ctx.group.discordGuildId, {
        name: `${ctx.game.name} ${partyLabel(ctx.game.partySize)}`,
        description: partyDescription(ctx, window.party),
        startMs: window.startMs,
        endMs: window.endMs,
        voiceChannelId: ctx.group.discordVoiceChannelId,
        location: ctx.game.name,
      });
      eventId = event.id;
    }
    const db = await getDb();
    await db
      .update(playSessions)
      .set({ discordMessageId: `${channelId}:${posted.id}`, discordEventId: eventId })
      .where(eq(playSessions.id, session.id));
  });
}

/**
 * Re-render a locked-in session's Discord message: the party (drop-outs, votes to remove someone) and the
 * late check. Before it starts, the server event's party list is updated too.
 */
export function syncPlannedMessage(ctx: GroupContext, sessionId: string) {
  return safely("planned session", async () => {
    const [late, found] = await Promise.all([getLateTally(ctx.group.id, sessionId), getParty(ctx, sessionId)]);
    if (!late || !found) return;
    const ref = parseRef(late.session.discordMessageId);
    if (ref) await editMessage(ref.channelId, ref.messageId, storedPlannedMessage(ctx, late.session, late.tally, found.party));
    const { discordEventId } = late.session;
    if (discordEventId && ctx.group.discordGuildId && late.session.startAt.getTime() > Date.now()) {
      await editScheduledEvent(ctx.group.discordGuildId, discordEventId, { description: partyDescription(ctx, found.party.party) });
    }
  });
}

/** Refresh a session's Discord post, whether it's the lobby or a locked-in session (after a vote, say). */
export function syncSessionPost(ctx: GroupContext, session: Pick<PlaySession, "id" | "kind">) {
  return session.kind === "live" ? syncLobby(ctx, session.id) : syncPlannedMessage(ctx, session.id);
}

/**
 * Daily cron: show the result on late checks that closed recently and remove their buttons.
 * Looks back 2 days because the cron can run up to an hour late; editing a message twice does no harm.
 */
export async function finishLateChecks(ctx: GroupContext, nowMs = Date.now()) {
  const closed = ctx.lateRecords.filter((r) => {
    const closesAt = lateVotingClosesAt(r.startMs);
    return closesAt <= nowMs && closesAt > nowMs - 48 * 3_600_000;
  });
  for (const r of closed) await syncPlannedMessage(ctx, r.sessionId);
  return closed.length;
}

/** Link to a Discord message from its stored "channelId:messageId" ref. */
function messageLink(ctx: GroupContext, ref: string | null | undefined): string | null {
  const at = parseRef(ref);
  return at && ctx.group.discordGuildId ? `https://discord.com/channels/${ctx.group.discordGuildId}/${at.channelId}/${at.messageId}` : null;
}

/** For opt-in DMs: the lobby's full 5-stacks before a change (see fullStacks), and who made the change. */
export interface StackWatch {
  before: readonly string[];
  /** Whoever tapped: they just saw the stack fill, so they don't get a DM about it. */
  actorId?: string;
}

/** One opt-in DM: who gets it, and the game whose 5-stack filled. */
export interface StackDm {
  userId: string;
  discordId: string;
  game: GameProgress;
}

/**
 * Who to DM when 5-stacks just filled in the lobby (they weren't full before): people in the lobby who play
 * that game, asked for DMs in their profile, and logged in with Discord. One DM each.
 */
export function stackDms(ctx: GroupContext, players: readonly SessionPlayer[], watch: StackWatch): StackDm[] {
  const summary = summarizeLive(ctx.games, [...players]);
  const full = fullStacks(summary);
  const filled = summary.games.filter((g) => full.includes(g.game.id) && !watch.before.includes(g.game.id));
  const inLobby = new Set(players.filter((p) => LOBBY_STATUSES.includes(p.status)).map((p) => p.userId));
  const sent = new Set<string>();
  const dms: StackDm[] = [];
  for (const game of filled) {
    for (const userId of game.game.players) {
      const m = ctx.byId.get(userId);
      if (!m?.dmWhenFull || !m.discordId || !inLobby.has(userId) || userId === watch.actorId || sent.has(userId)) continue;
      sent.add(userId);
      dms.push({ userId, discordId: m.discordId, game });
    }
  }
  return dms;
}

/**
 * Send the DMs from stackDms, linking to the lobby post (`lobbyRef` is "channelId:messageId"). A DM that fails
 * (they turned off DMs from server members) is skipped.
 */
export function sendStackDms(ctx: GroupContext, lobbyRef: string | null, dms: readonly StackDm[]) {
  return safely("stack DMs", async () => {
    const link = messageLink(ctx, lobbyRef);
    for (const dm of dms) {
      try {
        await sendDirectMessage(dm.discordId, stackReadyDm(ctx, dm.game, link));
      } catch (err) {
        console.error(`[discord] DM to ${dm.userId} failed:`, err);
      }
    }
  });
}

/**
 * Create or refresh the lobby message. There's no "ready" ping in the channel (whoever tapped I'm in is usually
 * in voice already); pass `watch` to DM the people who asked for it when a 5-stack fills.
 */
export function syncLobby(ctx: GroupContext, sessionId: string, watch?: StackWatch) {
  return safely("lobby", async () => {
    const s = await getSession(ctx.group.id, sessionId);
    if (!s) return;
    const summary = summarizeLive(ctx.games, s.players);
    // Every render lists who's free and hasn't answered, so edits don't drop that line.
    const free = freeNowNotInLobby(ctx, s.players.map((p) => p.userId));
    const message = lobbyMessage(ctx, s.session, summary, free, partyOf(ctx, s.session, s.players, s.votes, null));
    const ref = parseRef(s.session.discordMessageId);
    let session = s.session;
    if (ref) {
      await editMessage(ref.channelId, ref.messageId, message);
    } else if (ctx.group.discordChannelId && s.session.status === "active") {
      const posted = await postMessage(ctx.group.discordChannelId, message);
      const discordMessageId = `${ctx.group.discordChannelId}:${posted.id}`;
      const db = await getDb();
      await db.update(playSessions).set({ discordMessageId }).where(eq(playSessions.id, sessionId));
      session = { ...session, discordMessageId };
    }
    const dms = watch && session.status === "active" ? stackDms(ctx, s.players, watch) : [];
    if (dms.length) await sendStackDms(ctx, session.discordMessageId, dms);
  });
}

/** A lobby that closed because of a new /lfg: point its post to the new one and drop its buttons. */
export function markLobbyReplaced(oldRef: string, newRef: string, guildId?: string) {
  return safely("lobby replaced", async () => {
    const from = parseRef(oldRef);
    if (from) await editMessage(from.channelId, from.messageId, lobbyReplacedMessage(newRef, guildId));
  });
}

/** Close lobbies that expired (like last night's) and update their posts to "Lobby closed". Returns how many. */
export async function closeOldLobbies(ctx: GroupContext, nowMs = Date.now()) {
  const closed = await closeExpiredLobbies(ctx.group, nowMs);
  for (const id of closed) await syncLobby(ctx, id);
  return closed.length;
}

/** Refresh the WFH vote message (or post it, e.g. from the weekly cron). */
export function syncWfhVote(ctx: GroupContext, weekStart: string, postIfMissing = false) {
  return safely("wfh vote", async () => {
    const state = await getWfhState(ctx, weekStart);
    const msg = wfhVoteMessage(ctx, state, appUrl());
    const ref = parseRef(state.vote?.discordMessageId);
    if (ref) {
      await editMessage(ref.channelId, ref.messageId, msg);
    } else if (postIfMissing && ctx.group.discordChannelId && state.vote) {
      const posted = await postMessage(ctx.group.discordChannelId, msg);
      const db = await getDb();
      await db
        .update(wfhVotes)
        .set({ discordMessageId: `${ctx.group.discordChannelId}:${posted.id}` })
        .where(eq(wfhVotes.id, state.vote.id));
    }
  });
}

export function announceWfhDecision(ctx: GroupContext, weekStart: string, result: Parameters<typeof wfhDecisionMessage>[2]) {
  return safely("wfh decision", async () => {
    if (ctx.group.discordChannelId) await postMessage(ctx.group.discordChannelId, wfhDecisionMessage(ctx, weekStart, result));
  });
}
