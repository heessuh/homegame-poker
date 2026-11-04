// Spread-limit betting shared by the board games (HouseLimit) and 5-Murder (StudStakes).
// A bet or raise INCREMENT (raise-to minus the current high bet) must lie in [minBet, cap]. With raiseMustExceed,
// each raise increment must also be strictly larger than the previous bet/raise increment on the street.

export interface SpreadRules {
  minBet: number;
  /** Largest increment allowed this round. */
  maxBet: number;
  /** Raises allowed per street after the opening bet (heads-up included). */
  maxRaises: number;
  raiseMustExceed: boolean;
}

export interface SpreadSizingInput {
  rules: SpreadRules;
  /** Highest total bet on the street. */
  currentBet: number;
  /** The acting player's chips already bet on this street. */
  playerBet: number;
  /** The acting player's remaining stack. */
  stack: number;
  /** Increment of the last full bet/raise on this street (preflop in board games: the big blind). 0 = nobody has opened. */
  prevIncrement: number;
  /** Raises made on this street after the opening bet. */
  raises: number;
  /** Extra upper limit on the raise-to amount (pot-limit). */
  potCapRaiseTo?: number;
}

export interface SpreadSizing {
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
}

/** Smallest increment that counts as a full bet or raise. */
export function requiredIncrement(rules: SpreadRules, prevIncrement: number): number {
  if (prevIncrement <= 0 || !rules.raiseMustExceed) return rules.minBet;
  return Math.max(rules.minBet, prevIncrement + 1);
}

/** Legal raise-to range for a player who is otherwise allowed to raise. Both null when raising is not possible. */
export function houseLimitSizing(i: SpreadSizingInput): SpreadSizing {
  const none: SpreadSizing = { minRaiseTo: null, maxRaiseTo: null };
  const toCall = i.currentBet - i.playerBet;
  if (i.stack <= toCall) return none;
  const opening = i.prevIncrement <= 0;
  if (!opening && i.raises >= i.rules.maxRaises) return none;
  const minInc = requiredIncrement(i.rules, i.prevIncrement);
  if (minInc > i.rules.maxBet) return none;
  const allInTo = i.stack + i.playerBet;
  const minRaiseTo = Math.min(allInTo, i.currentBet + minInc);
  let maxRaiseTo = Math.min(allInTo, i.currentBet + i.rules.maxBet);
  if (i.potCapRaiseTo !== undefined) maxRaiseTo = Math.min(maxRaiseTo, i.potCapRaiseTo);
  maxRaiseTo = Math.max(maxRaiseTo, minRaiseTo);
  return { minRaiseTo, maxRaiseTo };
}

export function validateSpreadRules(r: SpreadRules, label: string): void {
  for (const k of ["minBet", "maxBet"] as const) {
    if (!Number.isInteger(r[k]) || r[k] <= 0) throw new Error(`invalid ${label} ${k}`);
  }
  if (r.maxBet < r.minBet) throw new Error(`${label} maxBet must be at least minBet`);
  if (!Number.isInteger(r.maxRaises) || r.maxRaises < 0) throw new Error(`invalid ${label} maxRaises`);
}
