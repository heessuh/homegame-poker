import { createHash, randomBytes, randomInt } from "node:crypto";
import { freshDeck, type Card } from "./cards.js";

/**
 * Uniform Fisher–Yates shuffle driven by Node's CSPRNG.
 * crypto.randomInt is rejection-sampled, so there is no modulo bias:
 * every one of the 52! orderings is equally likely. No weighting, ever.
 */
export function shuffle(deck: readonly Card[] = freshDeck()): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface DeckCommitment {
  /** Published to every player before the first card is dealt. */
  hash: string;
  /** Revealed after the hand so anyone can recompute the hash. */
  reveal: { deck: Card[]; salt: string };
}

/**
 * Provably fair commit/reveal: hash = sha256(salt + ":" + deck joined by ",").
 * The server cannot change the deck mid-hand without the hash failing to verify.
 */
export function commitDeck(deck: Card[]): DeckCommitment {
  const salt = randomBytes(16).toString("hex");
  return { hash: hashDeck(deck, salt), reveal: { deck, salt } };
}

export function hashDeck(deck: readonly Card[], salt: string): string {
  return createHash("sha256").update(`${salt}:${deck.join(",")}`).digest("hex");
}

export function verifyDeck(hash: string, deck: readonly Card[], salt: string): boolean {
  return hashDeck(deck, salt) === hash;
}
