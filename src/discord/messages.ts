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
import type { AwayResult } from "@/server/away";
import type { GroupContext, MemberView } from "@/server/context";
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

export function windowsMessage(ctx: GroupContext, windows: PlayWindow[], url: string): DiscordMessage {
  const P = ctx.group.partySize;
  if (!windows.length) {
    return {
      content: `No ${P}-stack windows in the next 7 days 😢 Update your availability: ${url}/availability`,
      allowed_mentions: NO_PINGS,
    };
  }
  const lines = windows.slice(0, 8).map((w) => {
    const extras = [
      `${fmtDuration(w.playMinutes)} of play`,
      w.pauses.length ? `${w.pauses.length} 🍔 pause${w.pauses.length > 1 ? "s" : ""}` : null,
      w.subs ? `+${w.subs} sub` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `• ${discordTs(w.startMs, "F")} – ${discordTs(w.endMs, "t")} (${extras})`;
  });
  return {
    content: `**Best ${P}-stack windows this week** (times show in your own zone)\n${lines.join("\n")}\n\nLock one in: ${url}`,
    allowed_mentions: NO_PINGS,
  };
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
  ctx: GroupContext,
  s: { startMs: number; endMs: number; pauses: Pause[]; party: string[] },
  late?: LateTally | null,
): DiscordMessage {
  const lines = sessionTimeline(s, ctx.group.matchLengthMinutes).flatMap((e) => {
    switch (e.kind) {
      case "start":
        return [`🎮 ${discordTs(e.atMs)} start`];
      case "last-queue":
        return [`⏰ ${discordTs(e.atMs)} last comp queue${e.reason === "pause" ? " before dinner" : ""}`];
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
      `🔒 **Locked in:** ${discordTs(s.startMs, "F")} (${discordTs(s.startMs, "R")})`,
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
    ctx,
    {
      startMs: late.startMs,
      endMs: late.endMs ?? late.startMs,
      pauses: session.plan?.pauses ?? [],
      party: late.players,
    },
    late,
  );
}

export function lobbyMessage(
  ctx: GroupContext,
  session: PlaySession,
  summary: LiveSummary,
  freeNow: string[] = [],
): DiscordMessage {
  const P = ctx.group.partySize;
  const header =
    session.status !== "active"
      ? "🏁 **Lobby closed.** GGs!"
      : summary.state === "full"
        ? `✅ **Party's full!** (${summary.playing.length}/${P}) Queue up.`
        : summary.state === "paused"
          ? "⏸️ **Paused:** waiting on dinner."
          : `🎮 **Who's in?** ${summary.playing.length}/${P}, need ${summary.needed} more`;
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
  if (freeNow.length) lines.push(`📣 Free right now: ${names(ctx, freeNow)}`);

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
    allowed_mentions: { users: discordIdsOf(ctx, freeNow) },
  };
}

export function partyFullMessage(ctx: GroupContext, summary: LiveSummary): DiscordMessage {
  return {
    content: `✅ **Party's full!** ${names(ctx, summary.playing)}, hop in voice and queue up.`,
    allowed_mentions: { users: discordIdsOf(ctx, summary.playing) },
  };
}

/** Private reply to "/back <time>". Times are shown in their profile's zone, the zone the time was read in. */
export function awayMessage(away: AwayResult, zone: string, url: string): string {
  const z = zoneAbbr(zone, away.backMs);
  const day = away.laterDay ? `${fmtWeekdayLong(away.freeFromMs, zone)} ` : "";
  const lines = away.now
    ? [`✅ Welcome back! You're marked free from now until ${fmtTime(away.freeUntilMs, zone)} ${z}.`]
    : [
        `👋 Away until **${fmtTime(away.backMs, zone)} ${z}** (${discordTs(away.backMs, "R")}). ` +
          `You're marked busy until then, and free ${day}${fmtRange(away.freeFromMs, away.freeUntilMs, zone)} ${z}.`,
      ];
  if (away.lobby) lines.push(away.now ? "🎮 You're in the lobby." : "⏳ The lobby shows when you'll be back.");
  if (away.clashMs !== null) {
    lines.push(
      `⚠️ Heads up: you're locked in for ${fmtTime(away.clashMs, zone)} ${z} (${discordTs(away.clashMs, "R")}), before you're back. Let the party know.`,
    );
  }
  lines.push(`Change or undo it: <${url}/availability> → Specific days`);
  return lines.join("\n");
}

export function wfhVoteMessage(ctx: GroupContext, state: WfhState, url: string): DiscordMessage {
  const P = ctx.group.partySize;
  const closed = state.vote?.status === "closed";
  const decided = (state.vote?.decidedDays ?? []) as Weekday[];
  const header = closed
    ? `🏠 **WFH, week of ${fmtDate(state.weekStart)}: decided.** ${decided.length ? decided.map((d) => WEEKDAY_LONG[d]).join(" & ") : "No shared day this week."}`
    : `🏠 **WFH sync, week of ${fmtDate(state.weekStart)}**\nHybrid folks: tap every day you *could* work from home. The day the most of you can share wins (ties go to the most extra ${P}-stack time).`;

  const lines = state.projection.options.map((o) => {
    const flexible = state.hybrid.filter((m) => m.hybridDays[o.weekday] === "flex");
    const votes = flexible.map((m) => `${state.ballots[m.id]?.includes(o.weekday) ? "✅" : "▫️"} ${m.name}`);
    const home = o.fixed.map((id) => ctx.byId.get(id)?.name).filter(Boolean);
    const star = (closed ? decided : state.plan.recommended).includes(o.weekday) ? " ⭐" : "";
    const gain =
      o.gainMinutes > 0 ? `up to +${fmtDuration(o.gainMinutes)} of ${P}-stack time` : flexible.length ? "no extra play time" : "";
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
  const days = result.recommended.map((d) => {
    const best = result.options.find((o) => o.weekday === d)?.best;
    const window = best ? ` (projected ${ctx.group.partySize}-stack ${discordTs(best.startMs)}–${discordTs(best.endMs)})` : "";
    return `**${WEEKDAY_LONG[d]}**${window}`;
  });
  return {
    content: `🏠 WFH day${days.length > 1 ? "s" : ""} for the week of ${fmtDate(weekStart)}: ${days.join(", ")}\nWorking from home: ${names(ctx, who)}`,
    allowed_mentions: { users: discordIdsOf(ctx, who) },
  };
}
