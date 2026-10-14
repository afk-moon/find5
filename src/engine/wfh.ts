import { DateTime } from "luxon";
import { makeHorizon } from "./availability";
import { findWindows, selectBestWindows, type PlayWindow } from "./match";
import { addDays, gamingDayOf } from "./time";
import type { MatchSettings, MemberInput, Weekday } from "./types";

export interface WfhDayOption {
  weekday: Weekday;
  date: string;
  /** Hybrid members who can choose to WFH this day ("flex"). */
  votable: string[];
  /** Members who are home anyway (fixed WFH weekday or an already-confirmed WFH date). */
  fixed: string[];
  /** Members who'd WFH: their ballots, or every flexible member when projecting. */
  approvers: string[];
  /** How many hybrid folks would be home together that day (approvers + fixed). */
  together: number;
  /** Extra party play time across the week vs. nobody switching. */
  gainMinutes: number;
  scoreGain: number;
  /** Best window that gaming day with this choice… */
  best: PlayWindow | null;
  /** …and without it. */
  baseline: PlayWindow | null;
}

export interface WfhPlan {
  options: WfhDayOption[];
  /** Day(s) to WFH together: most people home together, then biggest gaming gain. */
  recommended: Weekday[];
  /** True when no ballots were given, so every flexible member is assumed to say yes. */
  projected: boolean;
}

export interface WfhPlanArgs {
  members: readonly MemberInput[];
  settings: MatchSettings;
  /** Monday of the week being planned, "YYYY-MM-DD". */
  weekStart: string;
  /** Group's reference zone (used for week boundaries and "which day is this window on"). */
  homeZone: string;
  /** memberId → weekdays they could WFH. Omit to project before anyone votes. */
  ballots?: Readonly<Record<string, readonly Weekday[]>> | null;
  /** How many shared WFH days to pick (default 1). */
  sharedDays?: number;
}

export function planWfhWeek(args: WfhPlanArgs): WfhPlan {
  const { members, settings, weekStart, homeZone } = args;
  const projected = !args.ballots;
  const sharedDays = Math.max(1, args.sharedDays ?? 1);

  // Sunday (the night before Monday) through the next Monday morning.
  const horizon = makeHorizon(
    DateTime.fromISO(addDays(weekStart, -1), { zone: homeZone }).toMillis(),
    DateTime.fromISO(addDays(weekStart, 7), { zone: homeZone }).plus({ hours: 12 }).toMillis(),
  );
  const evaluate = (ms: readonly MemberInput[]) => {
    const best = selectBestWindows(findWindows(ms, horizon, settings));
    return {
      best,
      minutes: best.reduce((n, w) => n + w.playMinutes, 0),
      score: best.reduce((n, w) => n + w.score, 0),
    };
  };
  const base = evaluate(members);

  const options: WfhDayOption[] = [];
  for (let d = 1; d <= 5; d++) {
    const weekday = d as Weekday;
    const date = addDays(weekStart, d - 1);
    const homeAnyway = (m: MemberInput) => m.hybridDays?.[weekday] === "wfh" || !!m.wfhDates?.has(date);
    const votable = members.filter((m) => m.hybridDays?.[weekday] === "flex" && !homeAnyway(m)).map((m) => m.id);
    const fixed = members.filter(homeAnyway).map((m) => m.id);
    const approvers = projected ? votable : votable.filter((id) => args.ballots?.[id]?.includes(weekday));

    const scenario = approvers.length
      ? members.map((m) =>
          approvers.includes(m.id) ? { ...m, wfhDates: new Set([...(m.wfhDates ?? []), date]) } : m,
        )
      : members;
    const result = approvers.length ? evaluate(scenario) : base;

    options.push({
      weekday,
      date,
      votable,
      fixed,
      approvers,
      together: approvers.length + fixed.length,
      gainMinutes: result.minutes - base.minutes,
      scoreGain: result.score - base.score,
      best: bestOnDay(result.best, date, homeZone),
      baseline: bestOnDay(base.best, date, homeZone),
    });
  }

  const recommended = options
    .filter((o) => o.approvers.length > 0)
    .sort((a, b) => b.together - a.together || b.scoreGain - a.scoreGain || a.weekday - b.weekday)
    .slice(0, sharedDays)
    .map((o) => o.weekday)
    .sort((a, b) => a - b);

  return { options, recommended, projected };
}

/** Close a vote: the recommended day(s) become WFH dates for everyone who approved them. */
export function decideWfhVote(args: WfhPlanArgs & { ballots: Readonly<Record<string, readonly Weekday[]>> }) {
  const plan = planWfhWeek(args);
  const assignments = plan.options
    .filter((o) => plan.recommended.includes(o.weekday))
    .flatMap((o) => o.approvers.map((memberId) => ({ memberId, date: o.date })));
  return { ...plan, assignments };
}

function bestOnDay(windows: readonly PlayWindow[], date: string, zone: string): PlayWindow | null {
  let best: PlayWindow | null = null;
  for (const w of windows) {
    if (gamingDayOf(w.startMs, zone) !== date) continue;
    if (!best || w.score > best.score) best = w;
  }
  return best;
}
