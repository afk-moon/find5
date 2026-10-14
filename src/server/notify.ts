import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { playSessions, wfhVotes } from "@/db/schema";
import {
  lobbyMessage,
  partyFullMessage,
  plannedSessionMessage,
  wfhDecisionMessage,
  wfhVoteMessage,
} from "@/discord/messages";
import { appUrl, botConfigured, createScheduledEvent, editMessage, postMessage } from "@/discord/rest";
import type { PlayWindow } from "@/engine";
import type { GroupContext } from "./context";
import { getSession, summarizeLive, type LiveSummary, type PlaySession } from "./sessions";
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

export function freeNowNotInLobby(ctx: GroupContext, lobby: Iterable<string>): string[] {
  const inLobby = new Set(lobby);
  return membersNow(ctx)
    .filter((m) => (m.state === "F" || m.state === "M") && !inLobby.has(m.member.id))
    .map((m) => m.member.id);
}

/** Post the locked-in session (with its dinner/last-queue timeline) and create a Scheduled Event. */
export function announceLockIn(ctx: GroupContext, session: PlaySession, window: PlayWindow) {
  return safely("lock-in", async () => {
    const channelId = ctx.group.discordChannelId;
    if (!channelId) return;
    const posted = await postMessage(channelId, plannedSessionMessage(ctx, window));
    let eventId: string | null = null;
    if (ctx.group.discordGuildId && window.startMs > Date.now() + 60_000) {
      const event = await createScheduledEvent(ctx.group.discordGuildId, {
        name: `Valorant ${ctx.group.partySize}-stack`,
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

/** Create or refresh the lobby message; ping the party when it just became full. */
export function syncLobby(ctx: GroupContext, sessionId: string, previous?: LiveSummary["state"]) {
  return safely("lobby", async () => {
    const s = await getSession(ctx.group.id, sessionId);
    if (!s) return;
    const summary = summarizeLive(ctx.group.partySize, s.players);
    const ref = parseRef(s.session.discordMessageId);
    if (ref) {
      await editMessage(ref.channelId, ref.messageId, lobbyMessage(ctx, s.session, summary));
    } else if (ctx.group.discordChannelId && s.session.status === "active") {
      const freeNow = freeNowNotInLobby(ctx, s.players.map((p) => p.userId));
      const posted = await postMessage(ctx.group.discordChannelId, lobbyMessage(ctx, s.session, summary, freeNow));
      const db = await getDb();
      await db
        .update(playSessions)
        .set({ discordMessageId: `${ctx.group.discordChannelId}:${posted.id}` })
        .where(eq(playSessions.id, sessionId));
    }
    const channelId = ref?.channelId ?? ctx.group.discordChannelId;
    if (channelId && previous && previous !== "full" && summary.state === "full") {
      await postMessage(channelId, partyFullMessage(ctx, summary));
    }
  });
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
