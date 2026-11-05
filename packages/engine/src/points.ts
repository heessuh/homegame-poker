import type { Card } from "./cards.js";

/**
 * TKO scoring. No poker hands: each card is worth points, and a hole card whose rank shows up on the board is out.
 * Cards are 2-9 at face value, T/J/Q/K worth 10, and an ace is worth 11 or 1.
 */
export interface PointsResult {
  /** Hole cards still in the count, in the order they were dealt. */
  remaining: Card[];
  /** Hole cards knocked out because their rank is on the board. */
  out: Card[];
  /** Total with every ace counted as 11. Used for the most points. */
  high: number;
  /** Total with every ace counted as 1. Used for the fewest points. */
  low: number;
}

const FACE: Record<string, number> = { T: 10, J: 10, Q: 10, K: 10 };

function pointsOf(c: Card, aceValue: number): number {
  const r = c[0] as string;
  if (r === "A") return aceValue;
  return FACE[r] ?? Number(r);
}

export function tkoPoints(hole: readonly Card[], board: readonly Card[]): PointsResult {
  const onBoard = new Set(board.map((c) => c[0]));
  const remaining = hole.filter((c) => !onBoard.has(c[0] as string));
  const out = hole.filter((c) => onBoard.has(c[0] as string));
  return {
    remaining,
    out,
    high: remaining.reduce((t, c) => t + pointsOf(c, 11), 0),
    low: remaining.reduce((t, c) => t + pointsOf(c, 1), 0),
  };
}

/** Short wording used in logs and the winner list. */
export function tkoSummary(r: PointsResult): string {
  if (r.remaining.length === 0) return "no cards left";
  return r.high === r.low ? `${r.high} points` : `${r.low} to ${r.high} points`;
}
