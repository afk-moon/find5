import { LATE_VOTING_HOURS, sessionTimeline, type Pause, type PlayWindow, type Weekday } from "@/engine";
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  discordTs,
  fmtDate,
  fmtDuration,
  fmtRange,
  fmtTime,
  fmtWeekdayLong,
  zoneAbbr,
} from "@/lib/format";
import { partyLabel } from "@/lib/games";
import type { AwayResult } from "@/server/away";
import { mainGame, sessionGame, type GameContext, type GameView, type GroupContext, type MemberView } from "@/server/context";
import type { LateTally } from "@/server/lateness";
import type { LiveSummary, PlaySession } from "@/server/sessions";
import type { WfhState } from "@/server/wfh";
import type { ActionRow, Button, DiscordMessage } from "./rest";

const NO_PINGS = { parse: [] as string[] };

const LATE_TAG = " (⏰ frequently late)";
export const mention = (m?: MemberView) =>
  !m ? "someone" : `${m.discordId ? `<@${m.discordId}>` : `**${m.name}**`}${m.lateness.frequentlyLate ? LATE_TAG : ""}`;
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

export function plannedSessionMessage(
  ctx: GameContext,
  s: { startMs: number; endMs: number; pauses: Pause[]; party: string[] },
  late?: LateTally | null,
): DiscordMessage {
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
  return {
    content: [
      `🔒 **Locked in: ${ctx.game.name}** ${discordTs(s.startMs, "F")} (${discordTs(s.startMs, "R")})`,
      `Party: ${names(ctx, s.party)}`,
      ...lines,
      ...lateBits.lines,
    ].join("\n"),
    components: lateBits.rows,
    allowed_mentions: { users: discordIdsOf(ctx, s.party) },
  };
}

/** The locked-in message for a saved session (its players are the party), with the current late check. */
export function storedPlannedMessage(ctx: GroupContext, session: PlaySession, late: LateTally): DiscordMessage {
  return plannedSessionMessage(
    sessionGame(ctx, session),
    {
      startMs: late.startMs,
      endMs: late.endMs ?? late.startMs,
      pauses: session.plan?.pauses ?? [],
      party: late.players,
    },
    late,
  );
}

/**
 * The live lobby post. `freeNow` is everyone free by their schedule who hasn't answered yet. Pass it on
 * every render, edits included, or the "Free right now" line vanishes as soon as someone taps a button.
 * (Edited messages don't ping, so keeping the mentions doesn't notify anyone again.)
 */
export function lobbyMessage(
  ctx: GroupContext,
  session: PlaySession,
  summary: LiveSummary,
  freeNow: readonly string[],
): DiscordMessage {
  const { game } = sessionGame(ctx, session);
  const P = game.partySize;
  const active = session.status === "active";
  const header = !active
    ? `🏁 **${game.name} lobby closed.** ${summary.playing.length >= P ? "GGs!" : "Start a new one with /lfg."}`
    : summary.state === "full"
      ? `✅ **${game.name}: party's full!** (${summary.playing.length}/${P}) Queue up.`
      : summary.state === "paused"
        ? `⏸️ **${game.name}: paused,** waiting on dinner.`
        : `🎮 **${game.name}: who's in?** ${summary.playing.length}/${P}, need ${summary.needed} more`;
  const lines = [header];
  if (summary.playing.length) lines.push(`In: ${names(ctx, summary.playing)}`);
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
        ]
      : [];
  return {
    content: lines.join("\n"),
    components,
    allowed_mentions: { users: active ? discordIdsOf(ctx, freeNow) : [] },
  };
}

/**
 * An older post of a lobby that was posted again with /lfg: point to the new post and drop the buttons, so
 * only one post per lobby has them. `newRef` is "channelId:messageId".
 */
export function lobbyMovedMessage(newRef: string, guildId?: string): DiscordMessage {
  const [channelId, messageId] = newRef.split(":");
  const where = guildId && channelId && messageId ? `: https://discord.com/channels/${guildId}/${channelId}/${messageId}` : " below.";
  return { content: `↪️ This lobby moved to a newer post${where}`, components: [], allowed_mentions: { parse: [] } };
}

export function partyFullMessage(ctx: GameContext, summary: LiveSummary): DiscordMessage {
  return {
    content: `✅ **${ctx.game.name}: party's full!** ${names(ctx, summary.playing)}, hop in voice and queue up.`,
    allowed_mentions: { users: discordIdsOf(ctx, summary.playing) },
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
  if (away.lobbies.length) {
    const which = away.lobbies.map((l) => l.game).join(" and ");
    const many = away.lobbies.length > 1;
    lines.push(
      away.now
        ? `🎮 You're in the ${which} ${many ? "lobbies" : "lobby"}.`
        : `⏳ The ${which} ${many ? "lobbies show" : "lobby shows"} when you'll be back.`,
    );
  }
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
