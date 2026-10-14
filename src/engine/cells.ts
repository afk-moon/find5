/**
 * Luxon-free helpers for the 40-cell "gaming day" grid (safe to import from client components).
 */

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60_000;
/** A "gaming day" starts at 08:00 local time… */
export const DAY_START_HOUR = 8;
/** …and runs 20 hours (40 half-hour cells) until 04:00 the next morning, so 1am still counts as "tonight". */
export const CELLS_PER_DAY = 40;
export const EMPTY_PATTERN = ".".repeat(CELLS_PER_DAY);

/** Wall-clock start of a cell: 0 → 08:00, 32 → 00:00 (next morning). */
export function cellStart(idx: number): { hour: number; minute: number } {
  return { hour: (DAY_START_HOUR + Math.floor(idx / 2)) % 24, minute: (idx % 2) * 30 };
}

/** "8am", "6:30pm", "12am" style label for a cell boundary (0–40). */
export function cellLabel(idx: number): string {
  const { hour, minute } = cellStart(idx);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "am" : "pm";
  return minute ? `${h12}:${String(minute).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** Replace one cell in a pattern string. */
export function setCell(pattern: string, idx: number, state: string): string {
  return pattern.slice(0, idx) + state + pattern.slice(idx + 1);
}
