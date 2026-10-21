/**
 * Lobby ratings: 👍/👎 from teammates, and "bannable offense" reports. Reports only count when enough
 * different people agree in the same lobby, and enough of those earn a (comic) tag next to someone's name.
 */

/** Different people who must report someone in the same lobby for it to count as one bannable offense. */
export const REPORTS_PER_OFFENSE = 3;
/** Bannable offenses that earn the tag. */
export const OFFENSES_FOR_TAG = 3;
/** The tag itself (comic on purpose). */
export const MENACE_TAG = "🚨 Certified Menace";

/** Someone's standing in the group, over every lobby. */
export interface Reputation {
  /** 👍 received (one per teammate per lobby). */
  up: number;
  /** 👎 received. */
  down: number;
  /** Lobbies where at least REPORTS_PER_OFFENSE people reported them for a bannable offense. */
  offenses: number;
  /** Earned the tag (OFFENSES_FOR_TAG offenses). */
  menace: boolean;
}

export const NO_REPUTATION: Reputation = { up: 0, down: 0, offenses: 0, menace: false };

export const reputationOf = (up: number, down: number, offenses: number): Reputation => ({
  up,
  down,
  offenses,
  menace: offenses >= OFFENSES_FOR_TAG,
});
