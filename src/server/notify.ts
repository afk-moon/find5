import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { playSessions, wfhVotes } from "@/db/schema";
import {
  gameReadyMessage,
  lobbyMessage,
  lobbyMovedMessage,
  partyLabel,
  plannedSessionMessage,
  storedPlannedMessage,
  wfhDecisionMessage,
  wfhVoteMessage,
} from "@/discord/messages";
import { appUrl, botConfigured, createScheduledEvent, editMessage, postMessage } from "@/discord/rest";
import { lateVotingClosesAt, type PlayWindow } from "@/engine";
import type { GameContext, GroupContext } from "./context";
import { getLateTally } from "./lateness";
import { closeExpiredLobbies, getSession, readyGames, summarizeLive, type PlaySession } from "./sessions";
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

/** Post the locked-in session (with its dinner/last-queue timeline and late check) and create a Scheduled Event. */
export function announceLockIn(ctx: GameContext, session: PlaySession, window: PlayWindow) {
  return safely("lock-in", async () => {
    const channelId = ctx.group.discordChannelId;
    if (!channelId) return;
    const late = (await getLateTally(ctx.group.id, session.id))?.tally;
    const posted = await postMessage(channelId, plannedSessionMessage(ctx, window, late));
    let eventId: string | null = null;
    if (ctx.group.discordGuildId && window.startMs > Date.now() + 60_000) {
      const event = await createScheduledEvent(ctx.group.discordGuildId, {
        name: `${ctx.game.name} ${partyLabel(ctx.game.partySize)}`,
        description: `Party: ${window.party.map((id) => ctx.byId.get(id)?.name).join(", ")}`,
        startMs: window.startMs,
        endMs: window.endMs,
        voiceChannelId: ctx.group.discordVoiceChannelId,
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

/** Re-render a locked-in session's Discord message (late report counts, or the result once voting closes). */
export function syncPlannedMessage(ctx: GroupContext, sessionId: string) {
  return safely("planned session", async () => {
    const found = await getLateTally(ctx.group.id, sessionId);
    const ref = parseRef(found?.session.discordMessageId);
    if (found && ref) await editMessage(ref.channelId, ref.messageId, storedPlannedMessage(ctx, found.session, found.tally));
  });
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

/**
 * Create or refresh the lobby message. `readyBefore` is the games that had a full party before the change
 * (see readyGames): games that just got one ping their players.
 */
export function syncLobby(ctx: GroupContext, sessionId: string, readyBefore?: readonly string[]) {
  return safely("lobby", async () => {
    const s = await getSession(ctx.group.id, sessionId);
    if (!s) return;
    const summary = summarizeLive(ctx.games, s.players);
    // Every render lists who's free and hasn't answered, so edits don't drop that line.
    const message = lobbyMessage(ctx, s.session, summary, freeNowNotInLobby(ctx, s.players.map((p) => p.userId)));
    const ref = parseRef(s.session.discordMessageId);
    if (ref) {
      await editMessage(ref.channelId, ref.messageId, message);
    } else if (ctx.group.discordChannelId && s.session.status === "active") {
      const posted = await postMessage(ctx.group.discordChannelId, message);
      const db = await getDb();
      await db
        .update(playSessions)
        .set({ discordMessageId: `${ctx.group.discordChannelId}:${posted.id}` })
        .where(eq(playSessions.id, sessionId));
    }
    const channelId = ref?.channelId ?? ctx.group.discordChannelId;
    const newlyReady = readyBefore ? readyGames(summary).filter((id) => !readyBefore.includes(id)) : [];
    if (channelId && s.session.status === "active" && newlyReady.length) {
      await postMessage(channelId, gameReadyMessage(ctx, summary, newlyReady));
    }
  });
}

/** The older post of a lobby that was just posted again: point it to the new post and drop its buttons. */
export function markLobbyMoved(oldRef: string, newRef: string, guildId?: string) {
  return safely("lobby moved", async () => {
    const from = parseRef(oldRef);
    if (from) await editMessage(from.channelId, from.messageId, lobbyMovedMessage(newRef, guildId));
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
