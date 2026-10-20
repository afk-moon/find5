import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { groups, playSessions, wfhVotes } from "@/db/schema";
import type { Weekday } from "@/engine";
import { discordTs } from "@/lib/format";
import { partyLabel } from "@/lib/games";
import { setAwayUntil } from "@/server/away";
import { findGame, forGame, gamesOf, loadGroupContext, type GameView, type GroupContext, type MemberView } from "@/server/context";
import { getLateTally, toggleLateReport } from "@/server/lateness";
import {
  freeNowNotInLobby,
  markLobbyReplaced,
  sendStackDms,
  stackDms,
  syncLobby,
  syncPlannedMessage,
  syncSessionPost,
} from "@/server/notify";
import {
  castKickVote,
  getParty,
  kickOptions,
  partyOf,
  toggleDropOut,
  toggleKickVote,
  type PartyState,
} from "@/server/party";
import {
  activeLive,
  endSession,
  fullStacks,
  getSession,
  goToDinner,
  lobbyExpired,
  setPlayerStatus,
  startFreshLive,
  summarizeLive,
} from "@/server/sessions";
import { clearBallot, ensureVote, getWfhState, toggleBallotDay, weekStartOf } from "@/server/wfh";
import { upcomingWindows } from "@/server/windows";
import {
  awayMessage,
  kickChoiceMessage,
  kickPickerMessage,
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

/** After replying, look up the reply's message ("channelId:messageId") so the web app can edit it later. */
async function replyRef(i: Interaction): Promise<string | null> {
  const res = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`);
  if (!res.ok) return null;
  const msg = (await res.json()) as { id: string; channel_id: string };
  return `${msg.channel_id}:${msg.id}`;
}

function rememberReply(i: Interaction, save: (ref: string) => Promise<unknown>) {
  return async () => {
    const ref = await replyRef(i);
    if (ref) await save(ref);
  };
}

/** What a vote did, for the voter's private picker. */
function kickNote(name: string, r: { voted: boolean; changed: boolean; removed: boolean; party: PartyState }, targetId: string) {
  const tally = `${r.party.votes[targetId] ?? 0} of ${r.party.needed}`;
  if (r.removed) return `🚪 **${name}** was voted out${r.party.kind === "live" ? " of the lobby" : ""}.`;
  if (!r.changed) return `You already voted to remove **${name}** (${tally}). Tap their name below to take it back.`;
  return r.voted ? `🗳️ You voted to remove **${name}** (${tally}).` : `↩️ Took back your vote for **${name}**.`;
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
      // Always a fresh lobby (for every game): whatever was open closes, and everyone taps I'm in again.
      const { sessionId, closed } = await startFreshLive(ctx, me.id);
      const s = (await getSession(ctx.group.id, sessionId))!;
      const freeNow = freeNowNotInLobby(ctx, s.players.map((p) => p.userId));
      // This reply becomes the lobby message that button clicks and the web app keep updated. The closed
      // lobbies' posts lose their buttons and point to it (or just say they're closed, if it can't be found).
      defer(async () => {
        const ref = await replyRef(i);
        if (ref) await db.update(playSessions).set({ discordMessageId: ref }).where(eq(playSessions.id, sessionId));
        for (const old of closed) {
          if (!old.discordMessageId) continue;
          if (ref) await markLobbyReplaced(old.discordMessageId, ref, i.guild_id);
          else await syncLobby(ctx, old.id);
        }
      });
      return reply(lobbyMessage(ctx, s.session, summarizeLive(ctx.games, s.players), freeNow));
    }

    case "votekick": {
      // "/votekick user:@Sam": vote them out of the open lobby or a locked-in session you're both in.
      const target = ctx.members.find((m) => m.discordId === String(option("user") ?? ""));
      if (!target) return ephemeral(`I don't know them yet. They need to log in with Discord once at ${appUrl()}/login.`);
      if (target.id === me.id) {
        return ephemeral("You can't vote yourself out. Tap Leaving on the lobby post, or “Can't make it” on a locked-in session.");
      }
      const found = await kickOptions(ctx, me.id, target.id);
      const options = found.filter((o) => o.canVote);
      if (!options.length) {
        return ephemeral(
          found.some((o) => o.session.kind === "live")
            ? "Only people who are in the lobby can vote. Tap I'm in on the lobby post first."
            : found.length
              ? `Only players in that session can vote **${target.name}** out.`
              : `**${target.name}** isn't in the open lobby or an upcoming locked-in session.`,
        );
      }
      // In more than one place (the lobby and a locked-in session, say): let them pick.
      if (options.length > 1) return { type: 4, data: { ...kickChoiceMessage(ctx, options, target.id, me.timezone), flags: EPHEMERAL } };
      const result = await castKickVote(ctx, options[0].session.id, me.id, target.id);
      if (result.changed || result.removed) defer(() => syncSessionPost(ctx, result.session));
      return { type: 4, data: { ...kickPickerMessage(ctx, result.party, me.id, kickNote(target.name, result, target.id)), flags: EPHEMERAL } };
    }

    case "dinner":
    case "back": {
      // "/back 930": away until then. Changes their availability, so it works without a lobby too.
      // ("time" is the option's old name, from before it became the required "at".)
      const time = i.data?.name === "back" ? String(option("at") ?? option("time") ?? "").trim() : "";
      if (time) {
        const away = await setAwayUntil(ctx, me.id, time);
        const lobby = away.lobby;
        if (lobby) defer(() => syncLobby(ctx, lobby.sessionId, { before: lobby.before, actorId: me.id }));
        return ephemeral(awayMessage(away, me.timezone, appUrl()));
      }
      // The time is required on /back now, so a /back without one comes from Discord's old copy of the
      // command. That copy drops anything typed after "/back", so say why the time didn't come through.
      const stale =
        "Discord's copy of /back is out of date, so it didn't send a time. Reload Discord (Ctrl+R, or restart " +
        "the app). If the time box still doesn't appear, run `npm run discord:register` again.";
      const live = await activeLive(ctx.group);
      if (!live) return ephemeral(i.data?.name === "back" ? `⚠️ ${stale}` : "No lobby is open. Start one with /lfg.");
      const before = fullStacks(summarizeLive(ctx.games, live.players));
      const kind = option("kind") === "long" ? "long" : "quick";
      if (i.data?.name === "dinner") await goToDinner(ctx, live.session.id, me.id, kind);
      else await setPlayerStatus(ctx, live.session.id, me.id, "in");
      defer(() => syncLobby(ctx, live.session.id, { before, actorId: me.id }));
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
    const before = fullStacks(summarizeLive(ctx.games, s.players));
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
    let lobbyRef = fresh.session.discordMessageId;
    if (!lobbyRef && i.message) {
      const ref = `${i.message.channel_id}:${i.message.id}`;
      lobbyRef = ref;
      defer(() => getDb().then((db) => db.update(playSessions).set({ discordMessageId: ref }).where(eq(playSessions.id, sessionId))));
    }
    // People who asked for it get a DM when a 5-stack fills (no ping in the channel).
    const dms = stackDms(ctx, fresh.players, { before, actorId: me.id });
    if (dms.length) defer(() => sendStackDms(ctx, lobbyRef, dms));
    // Keep "Free right now": whoever's free by their schedule and still hasn't answered.
    const freeNow = freeNowNotInLobby(ctx, fresh.players.map((p) => p.userId));
    return update(lobbyMessage(ctx, fresh.session, summary, freeNow, partyOf(ctx, fresh.session, fresh.players, fresh.votes, null)));
  }

  if (kind === "wfh") {
    const weekStart = a;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return ephemeral("Unknown week.");
    if (b === "none") await clearBallot(ctx, weekStart, me.id);
    else await toggleBallotDay(ctx, weekStart, me.id, Number(b) as Weekday);
    return update(wfhVoteMessage(ctx, await getWfhState(ctx, weekStart), appUrl()));
  }

  // Locked-in posts: "Can't make it" (tap again to rejoin).
  if (kind === "drop") {
    const sessionId = a;
    const result = await toggleDropOut(ctx, sessionId, me.id);
    const late = (await getLateTally(ctx.group.id, sessionId, me.id))!;
    if (late.session.discordEventId) defer(() => syncPlannedMessage(ctx, sessionId)); // refreshes the server event too
    whisper(
      result.dropped
        ? "🙅 You're out of this session. Changed your mind? Tap “Can't make it” again to rejoin."
        : "✅ You're back in the party.",
    );
    return update(storedPlannedMessage(ctx, late.session, late.tally, result.party));
  }

  // "Vote someone out" (lobby and locked-in posts) opens a private picker with a button per person.
  if (kind === "kickmenu") {
    const found = await getParty(ctx, a, me.id);
    const live = found?.session.kind === "live";
    if (!found || !found.party.open) return ephemeral(live ? "That lobby is closed. Start a new one with /lfg." : "This session is over.");
    if (!found.party.voters.includes(me.id)) {
      return ephemeral(live ? "Only people who are in the lobby can vote. Tap I'm in first." : "Only players in this session can vote someone out.");
    }
    return { type: 4, data: { ...kickPickerMessage(ctx, found.party, me.id), flags: EPHEMERAL } };
  }

  // A vote from that private picker (or /votekick's choice): update it, and the shared post shows the new count.
  if (kind === "kick") {
    const targetId = b;
    const result = await toggleKickVote(ctx, a, me.id, targetId);
    defer(() => syncSessionPost(ctx, result.session));
    return update(kickPickerMessage(ctx, result.party, me.id, kickNote(ctx.byId.get(targetId)?.name ?? "them", result, targetId)));
  }

  if (kind === "late") {
    const sessionId = a;
    const lateUserId = b;
    const [found, party] = await Promise.all([getLateTally(ctx.group.id, sessionId, me.id), getParty(ctx, sessionId, me.id)]);
    if (!found || !party) return ephemeral("That session isn't available anymore.");
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
      return update(storedPlannedMessage(ctx, found.session, found.tally, party.party)); // shows the result and drops the buttons
    }
    const { reported, tally } = await toggleLateReport(ctx, sessionId, me.id, lateUserId);
    const name = ctx.byId.get(lateUserId)?.name ?? "them";
    const n = tally.counts[lateUserId] ?? 0;
    whisper(
      reported
        ? `⏰ You reported **${name}** as late (${n} of ${tally.needed} reports needed${n >= tally.needed ? ", so it counts" : ""}). Only you can see this. Tap again to undo.`
        : `↩️ Took back your late report for **${name}**.`,
    );
    return update(storedPlannedMessage(ctx, found.session, tally, party.party));
  }

  return ephemeral("Unknown button.");
}
