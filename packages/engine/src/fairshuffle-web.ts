import { freshDeck, type Card } from "./cards.js";
import { bytesToHex, hexToBytes, rejectionLimit } from "./fair.js";

// WebCrypto implementation of the "mochapoker-v1" shuffle (see docs/FAIRNESS.md). Does not import node:crypto,
// so it runs in browsers and in Node (globalThis.crypto.subtle). Must match fairshuffle.ts exactly.

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto is unavailable (needs HTTPS or localhost)");
  return s;
}

/** Async Fisher–Yates over `cards`, driven by the HMAC-SHA256 stream for (serverSeedHex, prefix). */
export async function derivedShuffle(cards: readonly Card[], serverSeedHex: string, prefix: string): Promise<Card[]> {
  const s = subtle();
  const key = await s.importKey("raw", hexToBytes(serverSeedHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  let block = 0;
  let view = new DataView(new ArrayBuffer(32));
  let pos = 32;
  const next = async (): Promise<number> => {
    if (pos >= 32) {
      view = new DataView(await s.sign("HMAC", key, enc.encode(`${prefix}|${block++}`)));
      pos = 0;
    }
    const u = view.getUint32(pos, false);
    pos += 4;
    return u;
  };
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const n = i + 1;
    const limit = rejectionLimit(n);
    let u = await next();
    while (u >= limit) u = await next();
    const j = u % n;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function deriveDeck(serverSeedHex: string, material: string): Promise<Card[]> {
  return derivedShuffle(freshDeck(), serverSeedHex, material);
}

export async function seedHash(serverSeedHex: string): Promise<string> {
  return bytesToHex(new Uint8Array(await subtle().digest("SHA-256", hexToBytes(serverSeedHex))));
}
