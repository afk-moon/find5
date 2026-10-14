import { CELLS_PER_DAY, EMPTY_PATTERN, boundaryIndex } from "./time";
import type { CellState } from "./types";

export type PaintState = Exclude<CellState, ".">;
export type PatternSpec = Partial<Record<PaintState, ReadonlyArray<readonly [string, string]>>>;

/**
 * Build a 40-cell pattern from local [from, to) ranges, e.g.
 *   pattern({ F: [["18:00", "23:00"]], Q: [["19:00", "19:30"]] })
 * Ranges may cross midnight ("22:00"–"02:00"). States paint in order F, M, Q, L, so dinners
 * can be layered on top of free time.
 */
export function pattern(spec: PatternSpec): string {
  const cells = EMPTY_PATTERN.split("");
  for (const state of ["F", "M", "Q", "L"] as const) {
    for (const [from, to] of spec[state] ?? []) {
      const end = Math.min(boundaryIndex(to), CELLS_PER_DAY);
      for (let i = boundaryIndex(from); i < end; i++) cells[i] = state;
    }
  }
  return cells.join("");
}

/** Same pattern for every weekday in `days` (1 = Mon … 7 = Sun). */
export function sameOn(days: readonly number[], p: string): Record<number, string> {
  return Object.fromEntries(days.map((d) => [d, p]));
}
