import { createHash, createHmac } from "node:crypto";
import { freshDeck, type Card } from "./cards.js";
import { hexToBytes, rejectionLimit } from "./fair.js";

// Node implementation of the "mochapoker-v1" shuffle (see docs/FAIRNESS.md).
// The WebCrypto twin in fairshuffle-web.ts must produce identical output.

/** Endless stream of big-endian uint32s: HMAC-SHA256(key, `${prefix}|${i}`) for i = 0, 1, 2, ... eight words per block. */
function* words(key: Uint8Array, prefix: string): Generator<number, never> {
  for (let i = 0; ; i++) {
    const block = createHmac("sha256", key).update(`${prefix}|${i}`).digest();
    for (let o = 0; o < 32; o += 4) yield block.readUInt32BE(o);
  }
}

/** Fisher–Yates over `cards` (kept in order), driven by the HMAC stream for (keyHex, prefix). */
export function derivedShuffle(cards: readonly Card[], serverSeedHex: string, prefix: string): Card[] {
  const stream = words(hexToBytes(serverSeedHex), prefix);
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const n = i + 1;
    const limit = rejectionLimit(n);
    let u = stream.next().value;
    while (u >= limit) u = stream.next().value;
    const j = u % n;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The deck for a hand: freshDeck() shuffled with the server seed and the hand's material. */
export function deriveDeck(serverSeedHex: string, material: string): Card[] {
  return derivedShuffle(freshDeck(), serverSeedHex, material);
}

/** The public commitment to a server seed: sha256 of the hex-decoded seed bytes, as hex. */
export function seedHash(serverSeedHex: string): string {
  return createHash("sha256").update(hexToBytes(serverSeedHex)).digest("hex");
}
