import { LATE_VOTING_HOURS, sessionTimeline, type Pause, type PlayWindow, type Weekday } from "@/engine";
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  discordTs,
  fmtDate,
  fmtDay,
  fmtDuration,
  fmtRange,
  fmtTime,
  fmtWeekdayLong,
  zoneAbbr,
} from "@/lib/format";
import { MENACE_TAG, NO_REPUTATION, OFFENSES_FOR_TAG, RATING_COOLDOWN_MS, REPORTS_PER_OFFENSE } from "@/engine/reputation";
import { partyLabel } from "@/lib/games";
import type { AwayResult } from "@/server/away";
import { mainGame, sessionGame, type GameContext, type GameView, type GroupContext, type MemberView } from "@/server/context";
import type { LateTally } from "@/server/lateness";
import type { PartyState } from "@/server/party";
import { FEEDBACK_MAX_CHARS, type LobbyRatings, type PlayerReport } from "@/server/reputation";
import { gamesInLobby, progressText, type GameProgress, type LiveSummary, type PlaySession } from "@/server/sessions";
import type { WfhState } from "@/server/wfh";
import type { ActionRow, Button, DiscordMessage, DiscordModal } from "./rest";

const NO_PINGS = { parse: [] as string[] };

const LATE_TAG = " (⏰ frequently late)";
export const mention = (m?: MemberView) =>
  !m
    ? "someone"
    : `${m.discordId ? `<@${m.discordId}>` : `**${m.name}**`}${m.lateness.frequentlyLate ? LATE_TAG : ""}${m.rep.menace ? ` (${MENACE_TAG})` : ""}`;
const names = (ctx: GroupContext, ids: readonly string[]) => ids.map((id) => mention(ctx.byId.get(id))).join(", ");
export const discordIdsOf = (ctx: GroupContext, ids: readonly string[]) =>
  ids.map((id) => ctx.byId.get(id)?.discordId).filter((d): d is string => !!d);

export { partyLabel };

/** /windows: each game's best windows this week, among the people who play it. */
export function windowsMessage(
  sections: Array<{ game: GameView; windows: PlayWindow[] }>,
  url: string,
  perGame = 8,
): DiscordMessage {
  if (!sections.length) {
    return { content: `Nobody's picked their games yet. Choose yours at ${url}/availability`, allowed_mentions: NO_PINGS };
  }
  const build = (limit: number) => {
    const blocks = sections.map(({ game, windows }) => {
      const title = `**${game.name}** (${partyLabel(game.partySize)})`;
      const n = game.players.length;
      if (n < game.partySize) {
        return `${title}: needs ${game.partySize} players, and ${n} ${n === 1 ? "plays" : "play"} it so far. Pick your games at <${url}/availability>`;
      }
      if (!windows.length) return `${title}: no windows in the next 7 days 😢`;
      const lines = windows.slice(0, limit).map((w) => {
        const extras = [
          `${fmtDuration(w.playMinutes)} of play`,
          w.pauses.length ? `${w.pauses.length} 🍔 pause${w.pauses.length > 1 ? "s" : ""}` : null,
          w.subs ? `+${w.subs} sub` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return `• ${discordTs(w.startMs, "F")} – ${discordTs(w.endMs, "t")} (${extras})`;
      });
      const more = windows.length > limit ? `\n-# +${windows.length - limit} more on the site` : "";
      return `${title}\n${lines.join("\n")}${more}`;
    });
    return `**Best times this week** (in your own zone)\n\n${blocks.join("\n\n")}\n\nLock one in: ${url}`;
  };
  // Discord posts max out at 2000 characters: show fewer windows per game until it fits.
  let limit = perGame;
  let content = build(limit);
  while (content.length > 2000 && limit > 1) content = build(--limit);
  return { content: content.slice(0, 2000), allowed_mentions: NO_PINGS };
}

/** Late-check lines + "<name> was late" buttons for a locked-in session. */
function lateSection(ctx: GroupContext, late: LateTally): { lines: string[]; rows: ActionRow[] } {
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const reported = Object.entries(late.counts).sort((a, b) => b[1] - a[1]);
  const lines: string[] = [];
  if (late.voting === "not-started") {
    // Worded so it still reads right after the start time (this message isn't edited when voting opens).
    lines.push(
      `🕒 Late check opens at ${discordTs(late.startMs)} for ${LATE_VOTING_HOURS}h. If someone shows up late, tap their name. It counts with ${late.needed}+ reports, and reports are anonymous.`,
    );
  } else if (late.voting === "open") {
    lines.push(
      `🕒 **Late check is open** (closes ${discordTs(late.closesAt, "R")}). Tap a name if they were late. It counts with ${late.needed}+ reports, and reports are anonymous.`,
    );
    if (reported.length) {
      lines.push(
        `Reports so far: ${reported.map(([id, n]) => `**${nameOf(id)}** ×${n}${n >= late.needed ? " (counts as late)" : ""}`).join(", ")}`,
      );
    }
  } else {
    const wasLate = reported.filter(([, n]) => n >= late.needed).map(([id]) => `**${nameOf(id)}**`);
    lines.push(`🕒 Late check closed. ${wasLate.length ? `Late: ${wasLate.join(", ")}` : "Everyone was on time 🎉"}`);
  }

  const rows: ActionRow[] = [];
  if (late.voting !== "closed") {
    const buttons: Button[] = late.players.map((id) => ({
      type: 2,
      style: (late.counts[id] ?? 0) >= late.needed ? 4 : 2,
      label: `${nameOf(id).slice(0, 60)} was late`,
      custom_id: `late:${late.sessionId}:${id}`,
    }));
    for (let i = 0; i < buttons.length && rows.length < 5; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  return { lines, rows };
}

/** "🗳️ Votes to remove: **Sam** 1/2" while voting is open (counts only, so voters stay anonymous). */
function votesLine(ctx: GroupContext, party: PartyState | null | undefined): string[] {
  if (!party?.open) return [];
  const pending = party.party.filter((id) => (party.votes[id] ?? 0) > 0);
  if (!pending.length) return [];
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  return [`🗳️ Votes to remove: ${pending.map((id) => `**${nameOf(id)}** ${party.votes[id]}/${party.needed}`).join(", ")}`];
}

/** Party lines for a locked-in post: who's in (and how many short), who's out, and open votes to remove someone. */
function partySection(ctx: GameContext, members: readonly string[], party: PartyState | null | undefined): string[] {
  const P = ctx.game.partySize;
  const short = members.length < P ? ` (${members.length}/${P}, need ${P - members.length} more)` : "";
  const lines = [`Party: ${members.length ? names(ctx, members) : "nobody yet"}${short}`];
  if (party?.dropped.length) lines.push(`🙅 Can't make it: ${names(ctx, party.dropped)}`);
  if (party?.removed.length) lines.push(`🚪 Voted out: ${names(ctx, party.removed)}`);
  return [...lines, ...votesLine(ctx, party)];
}

export function plannedSessionMessage(
  ctx: GameContext,
  s: { startMs: number; endMs: number; pauses: Pause[]; party: string[] },
  late?: LateTally | null,
  party?: PartyState | null,
): DiscordMessage {
  const members = party?.party ?? s.party;
  const lines = sessionTimeline(s, ctx.game.matchMinutes).flatMap((e) => {
    switch (e.kind) {
      case "start":
        return [`🎮 ${discordTs(e.atMs)} start`];
      case "last-queue":
        return [`⏰ ${discordTs(e.atMs)} last queue${e.reason === "pause" ? " before dinner" : ""}`];
      case "pause":
        return [`🍔 ${discordTs(e.atMs)} pause while ${names(ctx, e.who)} eat${e.who.length === 1 ? "s" : ""}, back ${discordTs(e.untilMs)}`];
      case "end":
        return [`🏁 ${discordTs(e.atMs)} wrap up`];
      default:
        return [];
    }
  });
  const lateBits = late ? lateSection(ctx, late) : { lines: [], rows: [] };
  // Discord allows 5 rows of buttons: late buttons get up to 4, and the party buttons the last one.
  const rows = lateBits.rows.slice(0, party?.open ? 4 : 5);
  if (party?.open) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 2, label: "Can't make it", emoji: { name: "🙅" }, custom_id: `drop:${party.sessionId}` },
        { type: 2, style: 2, label: "Vote someone out", emoji: { name: "🗳️" }, custom_id: `kickmenu:${party.sessionId}` },
      ],
    });
  }
  return {
    content: [
      `🔒 **Locked in: ${ctx.game.name}** ${discordTs(s.startMs, "F")} (${discordTs(s.startMs, "R")})`,
      ...partySection(ctx, members, party),
      ...lines,
      ...lateBits.lines,
    ].join("\n"),
    components: rows,
    allowed_mentions: { users: discordIdsOf(ctx, members) },
  };
}

/** The locked-in message for a saved session, with its current party and late check. */
export function storedPlannedMessage(ctx: GroupContext, session: PlaySession, late: LateTally, party: PartyState): DiscordMessage {
  return plannedSessionMessage(
    sessionGame(ctx, session),
    {
      startMs: late.startMs,
      endMs: late.endMs ?? late.startMs,
      pauses: session.plan?.pauses ?? [],
      party: party.party,
    },
    late,
    party,
  );
}

/**
 * The private "vote someone out" picker (only the voter sees it): a button per teammate with the votes so far.
 * `note` says what just happened. Add the ephemeral flag when sending it as a new reply.
 */
export function kickPickerMessage(ctx: GroupContext, party: PartyState, viewerId: string, note?: string): DiscordMessage {
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const others = party.party.filter((id) => id !== viewerId);
  const buttons: Button[] = others.slice(0, 25).map((id) => {
    const mine = party.mine.includes(id);
    return {
      type: 2,
      style: mine ? 4 : 2,
      label: `${mine ? "✓ " : ""}${nameOf(id).slice(0, 60)} · ${party.votes[id] ?? 0}/${party.needed}`,
      custom_id: `kick:${party.sessionId}:${id}`,
    };
  });
  const live = party.kind === "live";
  const takes = `It takes ${party.needed} vote${party.needed === 1 ? "" : "s"}. Votes are anonymous; tap again to take yours back.`;
  const help = !others.length
    ? `Nobody else is ${live ? "in the lobby" : "left in the party"}.`
    : live
      ? `🗳️ **Vote someone out of the lobby** (tapped in but not around, or not coming). ${takes} They can tap I'm in to come back.`
      : `🗳️ **Vote someone out** (late, or not coming). ${takes}`;
  return {
    content: [note, help].filter(Boolean).join("\n"),
    components: party.open ? rowsOf(buttons) : [],
    allowed_mentions: { parse: [] },
  };
}

/** Buttons in rows of 5 (Discord's limit is 5 rows of 5). */
function rowsOf(buttons: Button[]): ActionRow[] {
  const rows: ActionRow[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  return rows;
}

/**
 * /votekick when that person is in more than one place (the lobby and a locked-in session, say): a button for
 * each with the votes so far, and the voter picks. Times are in the voter's zone (buttons can't show Discord
 * timestamps).
 */
export function kickChoiceMessage(
  ctx: GroupContext,
  options: ReadonlyArray<{ session: PlaySession; party: PartyState }>,
  targetId: string,
  zone: string,
): DiscordMessage {
  const name = ctx.byId.get(targetId)?.name ?? "them";
  const buttons: Button[] = options.slice(0, 25).map(({ session, party }) => {
    const start = session.startAt.getTime();
    const where =
      session.kind === "live" ? "The lobby" : `${sessionGame(ctx, session).game.name} ${fmtDay(start, zone)} ${fmtTime(start, zone)}`;
    const mine = party.mine.includes(targetId);
    return {
      type: 2,
      style: mine ? 4 : 2,
      label: `${mine ? "✓ " : ""}${where} · ${party.votes[targetId] ?? 0}/${party.needed}`.slice(0, 80),
      emoji: { name: session.kind === "live" ? "🎮" : "🔒" },
      custom_id: `kick:${session.id}:${targetId}`,
    };
  });
  return {
    content: `🗳️ **${name}** is in more than one. Where do you want to vote them out?`,
    components: rowsOf(buttons),
    allowed_mentions: { parse: [] },
  };
}

/**
 * The live lobby post. The lobby is for every game: it says which games the people in it can play now,
 * and how close the rest are. `freeNow` is everyone free by their schedule who hasn't answered yet. Pass
 * it on every render, edits included, or the "Free right now" line vanishes as soon as someone taps a
 * button. (Edited messages don't ping, so keeping the mentions doesn't notify anyone again.)
 */
export function lobbyMessage(
  ctx: GroupContext,
  session: PlaySession,
  summary: LiveSummary,
  freeNow: readonly string[],
  party?: PartyState | null,
): DiscordMessage {
  const active = session.status === "active";
  const games = gamesInLobby(summary);
  const ready = games.filter((g) => g.ready).map((g) => g.game.name);
  const closest = games.find((g) => !g.ready);
  const header = !active
    ? `🏁 **Lobby closed.** ${ready.length ? "GGs!" : "Start a new one with /lfg."}`
    : summary.state === "full"
      ? `✅ **Ready to play:** ${ready.join(", ")}. Queue up!`
      : summary.state === "paused"
        ? "⏸️ **Paused,** waiting on dinner."
        : `🎮 **Who's on?** ${summary.playing.length} in${closest ? `, ${closest.game.name} needs ${closest.needed} more` : ""}`;
  const lines = [header];
  if (summary.playing.length) lines.push(`In: ${names(ctx, summary.playing)}`);
  if (active && games.length) lines.push(`🎯 ${games.map(progressText).join(" · ")}`);
  for (const e of summary.eating) {
    const back = e.backAt ? `, back ${discordTs(e.backAt, "R")}` : "";
    lines.push(`${e.kind === "quick" ? "🍔" : "🍝"} ${mention(ctx.byId.get(e.id))}: ${e.kind} dinner${back}`);
  }
  for (const s of summary.soon) {
    const when = s.backAt ? `back ${discordTs(s.backAt)} (${discordTs(s.backAt, "R")})` : "on the way";
    lines.push(`⏳ ${mention(ctx.byId.get(s.id))}: ${when}`);
  }
  if (summary.declined.length) lines.push(`🙅 Not tonight: ${names(ctx, summary.declined)}`);
  if (summary.left.length) lines.push(`👋 Left: ${names(ctx, summary.left)}`);
  if (summary.kicked.length) lines.push(`🚪 Voted out: ${names(ctx, summary.kicked)}${active ? " (tap I'm in to come back)" : ""}`);
  if (active) lines.push(...votesLine(ctx, party));
  if (active && freeNow.length) lines.push(`📣 Free right now: ${names(ctx, freeNow)}`);
  // When it opened, so an old post is obvious at a glance ("2 days ago" while open, the full date once closed).
  const opener = ctx.byId.get(session.createdBy ?? "")?.name;
  lines.push(`-# Opened ${discordTs(session.startAt.getTime(), active ? "R" : "f")}${opener ? ` by ${opener}` : ""}`);

  const id = session.id;
  const components: ActionRow[] =
    session.status === "active"
      ? [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: "I'm in", custom_id: `lfg:in:${id}` },
              { type: 2, style: 2, label: "In 15 min", custom_id: `lfg:soon:${id}` },
              { type: 2, style: 2, label: "Not tonight", custom_id: `lfg:declined:${id}` },
            ],
          },
          {
            type: 1,
            components: [
              { type: 2, style: 2, label: "Quick dinner", emoji: { name: "🍔" }, custom_id: `lfg:quick:${id}` },
              { type: 2, style: 2, label: "Long dinner", emoji: { name: "🍝" }, custom_id: `lfg:long:${id}` },
              { type: 2, style: 1, label: "I'm back", custom_id: `lfg:back:${id}` },
              { type: 2, style: 4, label: "Leaving", custom_id: `lfg:left:${id}` },
            ],
          },
          {
            type: 1,
            components: [
              { type: 2, style: 2, label: "Vote someone out", emoji: { name: "🗳️" }, custom_id: `kickmenu:${id}` },
              { type: 2, style: 2, label: "Rate players", emoji: { name: "⭐" }, custom_id: `rate:${id}` },
            ],
          },
        ]
      : [];
  return {
    content: lines.join("\n"),
    components,
    allowed_mentions: { users: active ? discordIdsOf(ctx, freeNow) : [] },
  };
}

/**
 * The private ratings panel (only the viewer sees it): a row per person with 👍/👎 (labels show their totals
 * over every lobby; the viewer's latest one is lit), 🚫 bannable offense (reports in this lobby, and the
 * offenses they make) and 💬 feedback. Up to 5 people fit; more get pages of 4 with Previous/Next. It opens on
 * `page`, or on the page with `focus` (whoever was just rated).
 */
export function ratePanelMessage(
  ctx: GroupContext,
  r: LobbyRatings,
  viewerId: string,
  { page = 0, focus, note }: { page?: number; focus?: string; note?: string } = {},
): DiscordMessage {
  const others = r.people.filter((id) => id !== viewerId);
  const perPage = others.length <= 5 ? 5 : 4;
  const pages = Math.max(1, Math.ceil(others.length / perPage));
  const at = focus && others.includes(focus) ? Math.floor(others.indexOf(focus) / perPage) : page;
  const p = Math.min(Math.max(0, at), pages - 1);
  const rows: ActionRow[] = others.slice(p * perPage, (p + 1) * perPage).map((id) => {
    const t = r.totals[id] ?? NO_REPUTATION;
    const vote = r.lastVote[id];
    const reports = r.reports[id] ?? 0;
    const offenses = r.offenses[id] ?? 0;
    const name = (ctx.byId.get(id)?.name ?? "someone").slice(0, 40);
    const notes = r.myNotes[id] ?? 0;
    return {
      type: 1,
      components: [
        { type: 2, style: vote === 1 ? 3 : 2, emoji: { name: "👍" }, label: `${name}${t.menace ? " 🚨" : ""} · ${t.up}`, custom_id: `up:${r.sessionId}:${id}` },
        { type: 2, style: vote === -1 ? 4 : 2, emoji: { name: "👎" }, label: String(t.down), custom_id: `down:${r.sessionId}:${id}` },
        {
          type: 2,
          style: r.myReports[id] ? 4 : 2,
          emoji: { name: "🚫" },
          label: offenses ? `${reports} (${offenses} offense${offenses === 1 ? "" : "s"})` : String(reports),
          custom_id: `ban:${r.sessionId}:${id}`,
        },
        { type: 2, style: 2, emoji: { name: "💬" }, label: notes ? `Feedback (${notes})` : "Feedback", custom_id: `fbopen:${r.sessionId}:${id}` },
      ],
    };
  });
  if (pages > 1) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 2, label: "◀ Previous", custom_id: `ratepage:${r.sessionId}:${p - 1}`, disabled: p === 0 },
        { type: 2, style: 2, label: `Next ▶ (${p + 1}/${pages})`, custom_id: `ratepage:${r.sessionId}:${p + 1}`, disabled: p === pages - 1 },
      ],
    });
  }
  const cooldown = `${RATING_COOLDOWN_MS / 60_000} min`;
  const help = !r.open
    ? "That lobby is closed."
    : others.length
      ? `⭐ **Rate players** (only you see this). 👍/👎 as often as every ${cooldown} per person; the numbers are their totals. ` +
        `🚫 **Bannable offense** (also every ${cooldown}): every ${REPORTS_PER_OFFENSE} reports from ${REPORTS_PER_OFFENSE} different people in a lobby make one offense, and ${OFFENSES_FOR_TAG} offenses earn ${MENACE_TAG}. ` +
        "💬 Feedback is anonymous; `/summary @name` sums it up."
      : "Nobody else is in the lobby yet.";
  return { content: [note, help].filter(Boolean).join("\n"), components: r.open ? rows : [], allowed_mentions: { parse: [] } };
}

/** The pop-up form for a feedback note about someone in the lobby. */
export function feedbackModal(ctx: GroupContext, sessionId: string, targetId: string): DiscordModal {
  const name = ctx.byId.get(targetId)?.name ?? "them";
  return {
    custom_id: `fb:${sessionId}:${targetId}`,
    title: `Feedback for ${name}`.slice(0, 45),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "text",
            label: "How was playing with them? (anonymous)",
            style: 2,
            min_length: 2,
            max_length: FEEDBACK_MAX_CHARS,
            required: true,
            placeholder: "Great comms, clutched the last round, a bit tilted after losses…",
          },
        ],
      },
    ],
  };
}

/**
 * /summary: someone's numbers, and what teammates wrote about them, summed up by AI when it's set up. It's
 * posted in the channel, so notes are never quoted word for word (feedback is anonymous).
 */
export function playerReportMessage(m: MemberView, report: PlayerReport): DiscordMessage {
  const r = m.rep;
  const toTag = r.menace || !r.offenses ? "" : ` (${OFFENSES_FOR_TAG - r.offenses} more earns ${MENACE_TAG})`;
  const tags = [r.menace ? MENACE_TAG : null, m.lateness.frequentlyLate ? "⏰ Frequently late" : null].filter(Boolean);
  const lines = [
    `📋 **Player report: ${m.name}**${tags.length ? ` · ${tags.join(" · ")}` : ""}`,
    `👍 ${r.up} · 👎 ${r.down} · 🚫 ${r.offenses} bannable offense${r.offenses === 1 ? "" : "s"}${toTag}`,
    "",
  ];
  const n = report.notes.length;
  if (report.ai === "ok" && report.summary) {
    lines.push(report.summary.slice(0, 1500), "", `-# From ${n} anonymous note${n === 1 ? "" : "s"}, summed up by AI. Take it with a grain of salt.`);
  } else if (report.ai === "empty") {
    lines.push("📝 No written feedback yet. Leave some with ⭐ Rate players on the lobby post.");
  } else {
    const notes = `${n} anonymous note${n === 1 ? "" : "s"} so far`;
    lines.push(
      report.ai === "off"
        ? `🤖 AI summaries aren't set up yet (the app needs a GEMINI_API_KEY). ${notes}.`
        : `🤖 The AI didn't answer this time (it may be busy or over its daily limit). ${notes}: try again later.`,
    );
  }
  return { content: lines.join("\n").slice(0, 2000), allowed_mentions: { parse: [] } };
}

/**
 * A lobby that closed because someone ran /lfg again: point to the new post and drop the buttons, so only the
 * new lobby has them. `newRef` is "channelId:messageId".
 */
export function lobbyReplacedMessage(newRef: string, guildId?: string): DiscordMessage {
  const [channelId, messageId] = newRef.split(":");
  const where = guildId && channelId && messageId ? `: https://discord.com/channels/${guildId}/${channelId}/${messageId}` : " below.";
  return { content: `🏁 Lobby closed. A new one was opened${where}`, components: [], allowed_mentions: { parse: [] } };
}

/** DM for someone who asked for one (in their profile) when a lobby they're in gets a full 5-stack. */
export function stackReadyDm(ctx: GroupContext, game: GameProgress, lobbyLink: string | null): DiscordMessage {
  const who = ctx.members
    .filter((m) => game.playing.includes(m.id))
    .map((m) => m.name)
    .join(", ");
  return {
    content: [
      `🎮 **${game.game.name} ${partyLabel(game.game.partySize)} is ready:** ${who}. Hop in voice!`,
      lobbyLink ? `Lobby: ${lobbyLink}` : null,
      "-# You asked for this DM in your profile (My availability → Profile).",
    ]
      .filter(Boolean)
      .join("\n"),
    allowed_mentions: { parse: [] },
  };
}

/** Private reply to "/back <time>". Times are shown in their profile's zone, the zone the time was read in. */
export function awayMessage(away: AwayResult, zone: string, url: string): string {
  const z = zoneAbbr(zone, away.backMs);
  const { plan } = away;
  const lines: string[] = [];
  if (away.now) {
    lines.push(plan ? `✅ Welcome back! You're marked free from now until ${fmtTime(plan.freeUntilMs, zone)} ${z}.` : "✅ Welcome back!");
  } else if (plan) {
    const day = plan.laterDay ? `${fmtWeekdayLong(plan.freeFromMs, zone)} ` : "";
    lines.push(
      `👋 Away until **${fmtTime(away.backMs, zone)} ${z}** (${discordTs(away.backMs, "R")}). ` +
        `You're marked busy until then, and free ${day}${fmtRange(plan.freeFromMs, plan.freeUntilMs, zone)} ${z}.`,
    );
  }
  if (away.lobby) lines.push(away.now ? "🎮 You're in the lobby." : "⏳ The lobby shows when you'll be back.");
  if (away.vacationUntil) {
    lines.push(`🏖️ You're on vacation until ${fmtDate(away.vacationUntil)}, so your availability didn't change.`);
  }
  if (away.clashMs !== null) {
    lines.push(
      `⚠️ Heads up: you're locked in for ${fmtTime(away.clashMs, zone)} ${z} (${discordTs(away.clashMs, "R")}), before you're back. Let the party know.`,
    );
  }
  if (plan?.overrides.length) lines.push(`Change or undo it: <${url}/availability> → Specific days`);
  return lines.join("\n");
}

export function wfhVoteMessage(ctx: GroupContext, state: WfhState, url: string): DiscordMessage {
  // Play time here is counted for the game most of the group plays.
  const { game } = mainGame(ctx);
  const playTime = `${game.name} ${partyLabel(game.partySize)} time`;
  const closed = state.vote?.status === "closed";
  const decided = (state.vote?.decidedDays ?? []) as Weekday[];
  const header = closed
    ? `🏠 **WFH, week of ${fmtDate(state.weekStart)}: decided.** ${decided.length ? decided.map((d) => WEEKDAY_LONG[d]).join(" & ") : "No shared day this week."}`
    : `🏠 **WFH sync, week of ${fmtDate(state.weekStart)}**\nHybrid folks: tap every day you *could* work from home. The day the most of you can share wins (ties go to the most extra ${playTime}).`;

  const lines = state.projection.options.map((o) => {
    const flexible = state.hybrid.filter((m) => m.hybridDays[o.weekday] === "flex");
    const votes = flexible.map((m) => `${state.ballots[m.id]?.includes(o.weekday) ? "✅" : "▫️"} ${m.name}`);
    const home = o.fixed.map((id) => ctx.byId.get(id)?.name).filter(Boolean);
    const star = (closed ? decided : state.plan.recommended).includes(o.weekday) ? " ⭐" : "";
    const gain =
      o.gainMinutes > 0 ? `up to +${fmtDuration(o.gainMinutes)} of ${playTime}` : flexible.length ? "no extra play time" : "";
    return [`**${WEEKDAY_SHORT[o.weekday]}**${star}`, votes.join(" "), home.length ? `home anyway: ${home.join(", ")}` : "", gain]
      .filter(Boolean)
      .join(" · ");
  });

  const components: ActionRow[] = closed
    ? []
    : [
        {
          type: 1,
          components: ([1, 2, 3, 4, 5] as const).map((d) => ({
            type: 2 as const,
            style: 2 as const,
            label: WEEKDAY_SHORT[d],
            custom_id: `wfh:${state.weekStart}:${d}`,
          })),
        },
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: "Can't WFH this week", custom_id: `wfh:${state.weekStart}:none` },
            { type: 2, style: 5, label: "Open planner", url: `${url}/wfh?week=${state.weekStart}` },
          ],
        },
      ];
  return { content: [header, ...lines].join("\n"), components, allowed_mentions: NO_PINGS };
}

export function wfhDecisionMessage(
  ctx: GroupContext,
  weekStart: string,
  result: { recommended: Weekday[]; assignments: Array<{ memberId: string; date: string }>; options: Array<{ weekday: Weekday; best: PlayWindow | null }> },
): DiscordMessage {
  if (!result.recommended.length) {
    return { content: `🏠 No shared WFH day for the week of ${fmtDate(weekStart)}.`, allowed_mentions: NO_PINGS };
  }
  const who = [...new Set(result.assignments.map((a) => a.memberId))];
  const { game } = mainGame(ctx);
  const days = result.recommended.map((d) => {
    const best = result.options.find((o) => o.weekday === d)?.best;
    const window = best ? ` (projected ${game.name} ${discordTs(best.startMs)}–${discordTs(best.endMs)})` : "";
    return `**${WEEKDAY_LONG[d]}**${window}`;
  });
  return {
    content: `🏠 WFH day${days.length > 1 ? "s" : ""} for the week of ${fmtDate(weekStart)}: ${days.join(", ")}\nWorking from home: ${names(ctx, who)}`,
    allowed_mentions: { users: discordIdsOf(ctx, who) },
  };
}
