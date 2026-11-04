export type VariantId = "nlhe" | "nlhe-hilo" | "plo4" | "plo5" | "plo4-8" | "plo5-8" | "plo4-lo8" | "plo4-lo" | "fyst";

export interface Variant {
  id: VariantId;
  name: string;
  holeCards: 2 | 4 | 5;
  /** Omaha: a hand must use exactly 2 hole cards + 3 board cards. Hold'em: any 5 of 7. */
  mustUseTwoHole: boolean;
  betting: "no-limit" | "pot-limit";
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
  /** Low-only games: "best" (default) low wins, or "second": the second-best low group wins (FYST). */
  lowWinner?: "best" | "second";
  maxPlayers: number;
}

export function splitOf(v: Variant): "high" | "hilo" | "low" {
  return v.split ?? (v.hiLo ? "hilo" : "high");
}

export const VARIANTS: Record<VariantId, Variant> = {
  nlhe: { id: "nlhe", name: "No-Limit Texas Hold'em", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: false, maxPlayers: 10 },
  "nlhe-hilo": { id: "nlhe-hilo", name: "No-Limit Hold'em Hi/Lo (no qualifier)", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: true, lowRule: "any", maxPlayers: 10 },
  plo4: { id: "plo4", name: "Pot-Limit Omaha High", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 10 },
  plo5: { id: "plo5", name: "5-Card Pot-Limit Omaha High", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 8 },
  "plo4-8": { id: "plo4-8", name: "Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 10 },
  "plo5-8": { id: "plo5-8", name: "5-Card Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 8 },
  "plo4-lo8": { id: "plo4-lo8", name: "Pot-Limit Omaha Low (8 or better)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "8-or-better", maxPlayers: 10 },
  "plo4-lo": { id: "plo4-lo", name: "Pot-Limit Omaha Low (no qualifier)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "any", maxPlayers: 10 },
  fyst: { id: "fyst", name: "FYST (Omaha, second-best low wins)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, split: "low", lowRule: "any", lowWinner: "second", maxPlayers: 10 },
};
