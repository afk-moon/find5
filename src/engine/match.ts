import { buildTimelines } from "./availability";
import { SLOT_MINUTES, SLOT_MS } from "./time";
import type { CellState, Horizon, MatchSettings, MemberInput } from "./types";

export interface Pause {
  startMs: number;
  endMs: number;
  /** Who's eating (party members on a quick dinner during the pause). */
  who: string[];
}

export interface PlayWindow {
  startMs: number;
  endMs: number;
  /** Everyone present (playing or on a quick dinner) for the whole window. Always ≥ partySize. */
  party: string[];
  /** People beyond the party size: backups who can sub in. */
  subs: number;
  /** Time actually playing (pauses excluded). */
  playMinutes: number;
  pauses: Pause[];
  /** "If needed" people the party actually relies on to reach the party size. */
  ifNeeded: string[];
  score: number;
}

export function popcount(x: bigint): number {
  let c = 0;
  while (x) {
    x &= x - 1n;
    c++;
  }
  return c;
}

/** Quick dinners longer than the pause limit behave like long dinners (the party won't wait that long). */
export function normalizeQuickDinners(row: readonly CellState[], maxPauseSlots: number): CellState[] {
  const out = row.slice();
  for (let i = 0; i < out.length; ) {
    if (out[i] !== "Q") {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] === "Q") j++;
    if (j - i > maxPauseSlots) for (let k = i; k < j; k++) out[k] = "L";
    i = j;
  }
  return out;
}

export function findWindows(
  members: readonly MemberInput[],
  horizon: Horizon,
  settings: MatchSettings,
): PlayWindow[] {
  return findWindowsInTimelines(
    members.map((m) => m.id),
    buildTimelines(members, horizon),
    horizon,
    settings,
  );
}

/**
 * Find every maximal window where the *same* ≥ partySize people are around the whole time.
 *
 * - A slot is a **pause** when fewer than partySize party members are playing (someone's on a
 *   quick dinner and no sub can cover). Pauses don't count as play time, can't open or close a
 *   window, and back-to-back pauses longer than maxPauseMinutes end the window (like a long dinner).
 * - Each slot stores bitmasks of who's present/playing, so "the same people throughout" is just an AND.
 */
export function findWindowsInTimelines(
  ids: readonly string[],
  timelines: ReadonlyArray<readonly CellState[]>,
  horizon: Horizon,
  settings: MatchSettings,
): PlayWindow[] {
  const P = settings.partySize;
  const S = horizon.slots;
  if (P < 1 || ids.length < P || S === 0) return [];
  const maxPauseSlots = Math.max(0, Math.floor(settings.maxPauseMinutes / SLOT_MINUTES));
  const minPlaySlots = Math.max(1, Math.ceil(settings.minSessionMinutes / SLOT_MINUTES));

  const present = new Array<bigint>(S).fill(0n); // playing or on a quick dinner
  const play = new Array<bigint>(S).fill(0n); // free or "if needed"
  const free = new Array<bigint>(S).fill(0n);
  const maybe = new Array<bigint>(S).fill(0n);
  timelines.forEach((raw, i) => {
    const row = normalizeQuickDinners(raw, maxPauseSlots);
    const bit = 1n << BigInt(i);
    for (let t = 0; t < S; t++) {
      const s = row[t];
      if (s === "F") {
        present[t] |= bit;
        play[t] |= bit;
        free[t] |= bit;
      } else if (s === "M") {
        present[t] |= bit;
        play[t] |= bit;
        maybe[t] |= bit;
      } else if (s === "Q") {
        present[t] |= bit;
      }
    }
  });

  const isPlay = (party: bigint, t: number) => popcount(party & play[t]) >= P;

  // 1) From every start slot, extend as far as possible.
  //    Validity only gets worse as the window grows (the party can only shrink, which can only add
  //    pauses), so a single forward scan finds the longest window, then we trim back to a play slot.
  const raws: Array<{ s: number; e: number; party: bigint }> = [];
  for (let s = 0; s < S; s++) {
    if (!isPlay(present[s], s)) continue;
    let party = present[s];
    let run = 0; // trailing pause length under the current party
    const parties: bigint[] = []; // parties[k] = people present for all of [s, s + k]
    for (let t = s; t < S; t++) {
      const next = party & present[t];
      if (popcount(next) < P) break;
      if (next !== party) {
        // Someone dropped out, so earlier slots they were covering may now be pauses. Re-check.
        let r = 0;
        let ok = true;
        for (let u = s; u < t; u++) {
          if (isPlay(next, u)) r = 0;
          else if (++r > maxPauseSlots) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        party = next;
        run = r;
      }
      if (isPlay(party, t)) run = 0;
      else if (++run > maxPauseSlots) break;
      parties.push(party);
    }
    let e = s + parties.length - 1;
    while (e > s && !isPlay(parties[e - s], e)) e--;
    const finalParty = parties[e - s];
    // If someone who covered the first slot left later, the session can't start here.
    // The scan from a later start slot finds the right window instead.
    if (!isPlay(finalParty, s)) continue;
    raws.push({ s, e, party: finalParty });
  }

  // 2) Summarize, drop short sessions, and drop windows nested inside a longer one.
  const windows: PlayWindow[] = [];
  let maxEnd = -1;
  for (const { s, e, party } of raws) {
    let playSlots = 0;
    let ifNeededSlots = 0;
    let ifNeededMask = 0n;
    const pauses: Array<{ s: number; e: number; who: bigint }> = [];
    for (let t = s; t <= e; t++) {
      if (isPlay(party, t)) {
        playSlots++;
        const freeCount = popcount(party & free[t]);
        if (freeCount < P) {
          ifNeededSlots += P - freeCount;
          ifNeededMask |= party & maybe[t];
        }
      } else {
        const eating = party & present[t] & ~play[t];
        const last = pauses[pauses.length - 1];
        if (last && last.e === t - 1) {
          last.e = t;
          last.who |= eating;
        } else {
          pauses.push({ s: t, e: t, who: eating });
        }
      }
    }
    if (playSlots < minPlaySlots) continue;
    if (e <= maxEnd) continue; // nested inside an earlier window (raws are ordered by start)
    maxEnd = e;

    const toIds = (mask: bigint) => ids.filter((_, i) => (mask >> BigInt(i)) & 1n);
    const subs = popcount(party) - P;
    windows.push({
      startMs: horizon.startMs + s * SLOT_MS,
      endMs: horizon.startMs + (e + 1) * SLOT_MS,
      party: toIds(party),
      subs,
      playMinutes: playSlots * SLOT_MINUTES,
      pauses: pauses.map((p) => ({
        startMs: horizon.startMs + p.s * SLOT_MS,
        endMs: horizon.startMs + (p.e + 1) * SLOT_MS,
        who: toIds(p.who),
      })),
      ifNeeded: toIds(ifNeededMask),
      score:
        playSlots * SLOT_MINUTES - 15 * pauses.length + 10 * Math.min(subs, 2) - 10 * ifNeededSlots,
    });
  }
  return windows;
}

/** Highest-scoring windows that don't overlap each other, in chronological order. */
export function selectBestWindows(windows: readonly PlayWindow[], limit = Infinity): PlayWindow[] {
  const picked: PlayWindow[] = [];
  const byScore = [...windows].sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  for (const w of byScore) {
    if (picked.length >= limit) break;
    if (picked.some((p) => w.startMs < p.endMs && p.startMs < w.endMs)) continue;
    picked.push(w);
  }
  return picked.sort((a, b) => a.startMs - b.startMs);
}

export type TimelineEvent =
  | { kind: "start"; atMs: number }
  | { kind: "last-queue"; atMs: number; reason: "pause" | "end"; who: string[] }
  | { kind: "pause"; atMs: number; untilMs: number; who: string[] }
  | { kind: "resume"; atMs: number }
  | { kind: "end"; atMs: number };

/**
 * Session plan with "last comp queue" heads-ups: a match takes ~matchLengthMinutes, so don't
 * queue a new one after (pause or end) − match length.
 */
export function sessionTimeline(
  w: Pick<PlayWindow, "startMs" | "endMs" | "pauses">,
  matchLengthMinutes: number,
): TimelineEvent[] {
  const matchMs = matchLengthMinutes * 60_000;
  const events: TimelineEvent[] = [{ kind: "start", atMs: w.startMs }];
  let segmentStart = w.startMs;
  for (const p of w.pauses) {
    if (p.startMs - matchMs > segmentStart) {
      events.push({ kind: "last-queue", atMs: p.startMs - matchMs, reason: "pause", who: p.who });
    }
    events.push({ kind: "pause", atMs: p.startMs, untilMs: p.endMs, who: p.who });
    events.push({ kind: "resume", atMs: p.endMs });
    segmentStart = p.endMs;
  }
  if (w.endMs - matchMs > segmentStart) {
    events.push({ kind: "last-queue", atMs: w.endMs - matchMs, reason: "end", who: [] });
  }
  events.push({ kind: "end", atMs: w.endMs });
  return events;
}
