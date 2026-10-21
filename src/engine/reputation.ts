/**
 * Lobby ratings: 👍/👎 from teammates, and "bannable offense" reports. Reports only count when enough
 * different people agree in the same lobby, and enough of those earn a (comic) tag next to someone's name.
 */

/** Reports that make one bannable offense, each from a different person, in the same lobby. */
export const REPORTS_PER_OFFENSE = 3;
/** Wait between one person's 👍/👎 on the same teammate, and between their reports about them. */
export const RATING_COOLDOWN_MS = 2 * 60_000;
/** Bannable offenses that earn the tag. */
export const OFFENSES_FOR_TAG = 3;
/** The tag itself (comic on purpose). */
export const MENACE_TAG = "🚨 Certified Menace";

/** Someone's standing in the group, over every lobby. */
export interface Reputation {
  /** 👍 received. */
  up: number;
  /** 👎 received. */
  down: number;
  /** Bannable offenses: groups of REPORTS_PER_OFFENSE reports from different people in a lobby (see offensesFrom). */
  offenses: number;
  /** Earned the tag (OFFENSES_FOR_TAG offenses). */
  menace: boolean;
}

export const NO_REPUTATION: Reputation = { up: 0, down: 0, offenses: 0, menace: false };

/**
 * Bannable offenses from one lobby's reports about one person, given how many times each reporter reported
 * them: every REPORTS_PER_OFFENSE reports from that many different people make one. So one person reporting
 * over and over never makes an offense alone, and two incidents need three people each.
 * (The most groups of distinct reporters: the largest k with sum(min(count, k)) >= REPORTS_PER_OFFENSE * k.)
 */
export function offensesFrom(reportsPerReporter: readonly number[]): number {
  const total = reportsPerReporter.reduce((a, b) => a + b, 0);
  for (let k = Math.floor(total / REPORTS_PER_OFFENSE); k > 0; k--) {
    if (reportsPerReporter.reduce((sum, n) => sum + Math.min(n, k), 0) >= REPORTS_PER_OFFENSE * k) return k;
  }
  return 0;
}

export const reputationOf = (up: number, down: number, offenses: number): Reputation => ({
  up,
  down,
  offenses,
  menace: offenses >= OFFENSES_FOR_TAG,
});
