export type VariantId = "nlhe" | "plo4" | "plo5" | "plo4-8" | "plo5-8";

export interface Variant {
  id: VariantId;
  name: string;
  holeCards: 2 | 4 | 5;
  /** Omaha: a hand must use exactly 2 hole cards + 3 board cards. Hold'em: any 5 of 7. */
  mustUseTwoHole: boolean;
  betting: "no-limit" | "pot-limit";
  /** Hi/Lo split with an 8-or-better qualifier for the low half. */
  hiLo: boolean;
  maxPlayers: number;
}

export const VARIANTS: Record<VariantId, Variant> = {
  nlhe: { id: "nlhe", name: "No-Limit Texas Hold'em", holeCards: 2, mustUseTwoHole: false, betting: "no-limit", hiLo: false, maxPlayers: 10 },
  plo4: { id: "plo4", name: "Pot-Limit Omaha High", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 10 },
  plo5: { id: "plo5", name: "5-Card Pot-Limit Omaha High", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: false, maxPlayers: 9 },
  "plo4-8": { id: "plo4-8", name: "Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 4, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 10 },
  "plo5-8": { id: "plo5-8", name: "5-Card Pot-Limit Omaha Hi/Lo (8 or better)", holeCards: 5, mustUseTwoHole: true, betting: "pot-limit", hiLo: true, maxPlayers: 9 },
};
