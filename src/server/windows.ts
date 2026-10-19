import { DateTime } from "luxon";
import {
  SLOT_MS,
  buildTimelines,
  findWindows,
  makeHorizon,
  selectBestWindows,
  type CellState,
  type Horizon,
  type PlayWindow,
} from "@/engine";
import type { GameContext, GroupContext, MemberView } from "./context";

/** From a few hours ago (to catch sessions in progress) through the next 7 days. */
export function upcomingHorizon(ctx: GroupContext, nowMs = Date.now(), days = 7): Horizon {
  const end = DateTime.fromMillis(nowMs, { zone: ctx.group.homeTimezone })
    .startOf("day")
    .plus({ days: days + 1 })
    .toMillis();
  return makeHorizon(nowMs - 6 * 3_600_000, end);
}

/** A game's best non-overlapping windows that haven't ended yet, among the people who play it. */
export function upcomingWindows(ctx: GameContext, nowMs = Date.now()): PlayWindow[] {
  const all = findWindows(ctx.inputs, upcomingHorizon(ctx, nowMs), ctx.settings);
  return selectBestWindows(all).filter((w) => w.endMs > nowMs);
}

/** Re-find a window by its exact bounds (never trust window data sent from the client). */
export function findWindowByBounds(ctx: GameContext, startMs: number, endMs: number, nowMs = Date.now()) {
  return findWindows(ctx.inputs, upcomingHorizon(ctx, nowMs), ctx.settings).find(
    (w) => w.startMs === startMs && w.endMs === endMs,
  );
}

export interface MemberNow {
  member: MemberView;
  state: CellState;
  /** When their current free / if-needed stretch ends. */
  freeUntil: number | null;
  /** Next time they're free, if not free now. */
  nextFreeAt: number | null;
  nextDinner: { kind: "Q" | "L"; startMs: number; endMs: number } | null;
}

/** Who's around right now and what's coming up in the next 8 hours. */
export function membersNow(ctx: GroupContext, nowMs = Date.now()): MemberNow[] {
  const h = makeHorizon(nowMs, nowMs + 8 * 3_600_000);
  const timelines = buildTimelines(ctx.inputs, h);
  const at = (k: number) => h.startMs + k * SLOT_MS;
  const playable = (s: CellState) => s === "F" || s === "M";

  return ctx.members.map((member, i) => {
    const row = timelines[i];
    let freeUntil: number | null = null;
    let nextFreeAt: number | null = null;
    if (playable(row[0])) {
      let j = 0;
      while (j < row.length && playable(row[j])) j++;
      freeUntil = at(j);
    } else {
      const k = row.findIndex(playable);
      nextFreeAt = k >= 0 ? at(k) : null;
    }
    let nextDinner: MemberNow["nextDinner"] = null;
    const d = row.findIndex((s) => s === "Q" || s === "L");
    if (d >= 0) {
      let j = d;
      while (j < row.length && row[j] === row[d]) j++;
      nextDinner = { kind: row[d] as "Q" | "L", startMs: at(d), endMs: at(j) };
    }
    return { member, state: row[0], freeUntil, nextFreeAt, nextDinner };
  });
}

export interface HeatRow {
  date: string;
  label: string;
  cells: Array<{ startMs: number; count: number; dinner: number; inWindow: boolean; past: boolean }>;
}

/** Week at a glance in the viewer's zone: how many of a game's players are free in each half hour, noon → 2am. */
export function weekHeat(ctx: GameContext, zone: string, windows: PlayWindow[], nowMs = Date.now()): HeatRow[] {
  const today = DateTime.fromMillis(nowMs, { zone }).startOf("day");
  const h = makeHorizon(today.set({ hour: 12 }).toMillis(), today.plus({ days: 8 }).set({ hour: 2 }).toMillis());
  const timelines = buildTimelines(ctx.inputs, h);
  const rows: HeatRow[] = [];
  for (let d = 0; d < 7; d++) {
    const day = today.plus({ days: d });
    const from = day.set({ hour: 12 }).toMillis();
    const to = day.plus({ days: 1 }).set({ hour: 2 }).toMillis();
    const cells: HeatRow["cells"] = [];
    for (let t = from; t < to; t += SLOT_MS) {
      const k = (t - h.startMs) / SLOT_MS;
      let count = 0;
      let dinner = 0;
      for (const row of timelines) {
        if (row[k] === "F" || row[k] === "M") count++;
        else if (row[k] === "Q" || row[k] === "L") dinner++;
      }
      cells.push({
        startMs: t,
        count,
        dinner,
        inWindow: windows.some((w) => t >= w.startMs && t < w.endMs),
        past: t + SLOT_MS <= nowMs,
      });
    }
    rows.push({ date: day.toISODate()!, label: day.toFormat("ccc"), cells });
  }
  return rows;
}
