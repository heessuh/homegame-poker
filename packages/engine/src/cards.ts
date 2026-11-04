export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUITS = ["c", "d", "h", "s"] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
/** Two-character card code, e.g. "As" (ace of spades), "Td" (ten of diamonds). */
export type Card = `${Rank}${Suit}`;

/** A fresh 52-card deck in a fixed order (unshuffled). */
export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}
