// Pure helpers for the "mochapoker-v1" provably fair shuffle. No crypto imports: safe in the browser.
// The Node (fairshuffle.ts) and WebCrypto (fairshuffle-web.ts) implementations share these rules.
// The scheme is specified in docs/FAIRNESS.md.

export const FAIR_ALGORITHM = "mochapoker-v1";

/** A client seed: 16 random bytes as 32 lowercase hex characters. */
export const CLIENT_SEED_RE = /^[0-9a-f]{32}$/;
/** A server seed: 32 random bytes as 64 lowercase hex characters. */
export const SERVER_SEED_RE = /^[0-9a-f]{64}$/;

/**
 * Shuffle material for one hand: `mochapoker-v1|<tableId>|<handNumber>|` followed by every contributing
 * `<playerId>:<clientSeed>` pair, sorted by playerId (UTF-16 code unit order) and joined with ",".
 */
export function buildMaterial(tableId: string, handNumber: number, clientSeeds: Readonly<Record<string, string>>): string {
  const ids = Object.keys(clientSeeds).sort();
  return `${FAIR_ALGORITHM}|${tableId}|${handNumber}|${ids.map((id) => `${id}:${clientSeeds[id]}`).join(",")}`;
}

/** Stream prefix for the k-th mid-hand reshuffle (k = 1, 2, ...) of a hand with the given material. */
export function reshufflePrefix(material: string, k: number): string {
  return `${material}|reshuffle${k}`;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Largest multiple of n that fits in 2^32: values u >= limit are rejected to avoid modulo bias. */
export function rejectionLimit(n: number): number {
  return Math.floor(4294967296 / n) * n;
}
