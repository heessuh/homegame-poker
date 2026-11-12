export type VariantId = "nlhe" | "nlhe-hilo" | "plo4" | "plo5" | "plo4-8" | "plo5-8" | "plo4-lo8" | "plo4-lo" | "fyst" | "fyst-he" | "fyst-o" | "dumb" | "smd4" | "smd5" | "tko4" | "tko5" | "murder5";

/** Which hole cards a five-card hand must use: exactly 2 (true), any (false), or either 2 or 3 of them ("2or3"). */
export type HoleRule = boolean | "2or3";

export interface Variant {
  id: VariantId;
  name: string;
  /** Name when the game's own betting applies (tournaments, or cash with the house limit off). Default: name. */
  openName?: string;
  holeCards: 2 | 4 | 5;
  /** Omaha: a hand must use exactly 2 hole cards + 3 board cards. Hold'em: any 5 of 7. */
  mustUseTwoHole: boolean;
  /** SMD: a hand uses either 2 or 3 hole cards (so 3 or 2 board cards). Overrides mustUseTwoHole. */
  holeUse?: "2or3";
  /** "points" (TKO): no poker hands; players are scored by the points left in their hand. See points.ts. */
  scoring?: "poker" | "points";
  betting: "no-limit" | "pot-limit" | "spread-limit";
  /** Hi/Lo split. The low half needs an 8-or-better hand unless lowRule is "any". */
  hiLo: boolean;
  /** "any": the lowest hand always takes the low half (ace-to-five, pairs count against you). Default "8-or-better". */
  lowRule?: "8-or-better" | "any";
  /**
   * How a pot is divided. Default derives from hiLo: "hilo" if hiLo else "high".
   * "low": the whole pot goes to the low (no high half). With lowRule "8-or-better" and no qualifying
   * low among a pot's eligible players, the best high hand takes that pot instead.
   */
  split?: "high" | "hilo" | "low";
  /**
   * High-only games: which high hand takes the pot. "best" (default); "second": the second-best group wins
   * (FYST, Double FYST); "worst": every player plays their best hand and the lowest of those wins (Dumb & Dumber).
   */
  highWinner?: "best" | "second" | "worst";
  /** No longer offered. Kept so old hand records still read and verify correctly. */
  retired?: boolean;
  /** Low-only games: "best" (default) low wins, or "second": the second-best low group wins (the old FYST). */
  lowWinner?: "best" | "second";
  /** "board" (default): community-card games. "stud": 5-Murder, see stud.ts. */
  kind?: "board" | "stud";
  maxPlayers: number;
}

export function holeRule(v: Variant): HoleRule {
  return v.holeUse ?? v.mustUseTwoHole;
}

export function splitOf(v: Variant): "high" | "hilo" | "low" {
  return v.split ?? (v.hiLo ? "hilo" : "high");
}

export const VARIANTS: Record<VariantId, Variant> = {
  // Listed in the order the game pickers show them: similar games sit together. Retired games go last.
  nlhe: { id: "nlhe", name: "Texas Hold'em", openName: "No-Limit Texas Hold'em", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: false, maxPlayers: 10 },
  "nlhe-hilo": { id: "nlhe-hilo", name: "Hold'em Hi/Lo (no qualifier)", openName: "No-Limit Hold'em Hi/Lo (no qualifier)", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: true, lowRule: "any", maxPlayers: 10 },
  "fyst-he": { id: "fyst-he", name: "FYST (Texas high, second best hand wins)", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: false, highWinner: "second", maxPlayers: 10 },
  plo4: { id: "plo4", name: "Pot-Limit Omaha High", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 10 },
  plo5: { id: "plo5", name: "5-Card Pot-Limit Omaha High", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 8 },
  "fyst-o": { id: "fyst-o", name: "Double FYST (Omaha high, second best hand wins)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, highWinner: "second", maxPlayers: 10 },
  "plo4-8": { id: "plo4-8", name: "Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 10 },
  "plo5-8": { id: "plo5-8", name: "5-Card Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 8 },
  smd4: { id: "smd4", name: "SMD 4-Card (Omaha Hi/Lo, no qualifier, use 2 or 3 cards)", holeCards: 4, mustUseTwoHole: false, holeUse: "2or3", betting: "pot-limit", hiLo: true, lowRule: "any", maxPlayers: 10 },
  smd5: { id: "smd5", name: "SMD 5-Card (Omaha Hi/Lo, no qualifier, use 2 or 3 cards)", holeCards: 5, mustUseTwoHole: false, holeUse: "2or3", betting: "pot-limit", hiLo: true, lowRule: "any", maxPlayers: 8 },
  "plo4-lo8": { id: "plo4-lo8", name: "Pot-Limit Omaha Low (8 or better)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "8-or-better", maxPlayers: 10 },
  "plo4-lo": { id: "plo4-lo", name: "Pot-Limit Omaha Low (no qualifier)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "any", maxPlayers: 10 },
  dumb: { id: "dumb", name: "Dumb & Dumber (Omaha low, use your best poker hand)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, highWinner: "worst", maxPlayers: 10 },
  tko4: { id: "tko4", name: "TKO 4-Card (points, high and low)", holeCards: 4, mustUseTwoHole: false, betting: "pot-limit", hiLo: true, scoring: "points", maxPlayers: 10 },
  tko5: { id: "tko5", name: "TKO 5-Card (points, high and low)", holeCards: 5, mustUseTwoHole: false, betting: "pot-limit", hiLo: true, scoring: "points", maxPlayers: 8 },
  murder5: { id: "murder5", name: "5-Murder", holeCards: 5, mustUseTwoHole: false, betting: "spread-limit", hiLo: true, lowRule: "any", split: "hilo", kind: "stud", maxPlayers: 8 },
  fyst: { id: "fyst", name: "FYST, old rules (Omaha, second-best low wins)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "any", lowWinner: "second", retired: true, maxPlayers: 10 },
};
