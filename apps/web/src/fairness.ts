// Client side of the "mochapoker-v1" provably fair shuffle (docs/FAIRNESS.md).
import { buildMaterial, bytesToHex } from "@homegame/engine";
import type { HandRecord } from "@homegame/engine";
import { deriveDeck, seedHash } from "../../../packages/engine/dist/fairshuffle-web.js";
import { sha256Hex, storeGet, storeSet } from "./util";

const KEY = "hg.fair";
const KEEP = 300;

export interface StoredSeed {
  tableId: string;
  handNumber: number;
  serverSeedHash: string;
  clientSeed: string;
}

function load(): StoredSeed[] {
  try {
    const v: unknown = JSON.parse(storeGet(KEY) ?? "[]");
    return Array.isArray(v) ? (v as StoredSeed[]).filter((x) => x && typeof x.tableId === "string" && typeof x.handNumber === "number") : [];
  } catch {
    return [];
  }
}

/** Remember the commitment we saw and the seed we answered with (last 300). */
export function rememberSeed(e: StoredSeed): void {
  const all = load().filter((x) => !(x.tableId === e.tableId && x.handNumber === e.handNumber));
  all.push(e);
  storeSet(KEY, JSON.stringify(all.slice(-KEEP)));
}

export function storedSeed(tableId: string, handNumber: number): StoredSeed | null {
  return load().find((x) => x.tableId === tableId && x.handNumber === handNumber) ?? null;
}

/** 16 random bytes as 32 lowercase hex characters. */
export function newClientSeed(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export interface FairCheck {
  ok: boolean | null; // null = not applicable
  label: string;
  detail: string;
}

/** Runs the four fairness checks for a finished hand. `myId` is the viewer's player id. */
export async function verifyFairness(rec: HandRecord, tableId: string, myId: string): Promise<FairCheck[]> {
  const out: FairCheck[] = [];
  const f = rec.fair;
  const seen = storedSeed(tableId, rec.handNumber);
  if (!f) {
    out.push({ ok: false, label: "Fair shuffle data", detail: "This hand has no provably fair data (it was dealt before this feature existed)." });
  } else {
    try {
      const hash = await seedHash(f.serverSeed);
      if (seen) {
        const ok = hash === seen.serverSeedHash;
        out.push({
          ok, label: "Server seed matches the commitment you saw before the deal",
          detail: ok ? "sha256(server seed) equals the hash your browser stored before the cards were dealt." : "sha256(server seed) differs from the hash your browser saw before the deal.",
        });
      } else {
        const ok = hash === f.serverSeedHash;
        out.push({
          ok, label: "Server seed matches the published commitment",
          detail: `You weren't at the table before this deal — checked against the commitment the server published. ${ok ? "It matches." : "It does NOT match."}`,
        });
      }
      const mine = f.clientSeeds[myId];
      if (!(myId in rec.names)) {
        out.push({ ok: null, label: "Your seed is included", detail: "You weren't dealt into this hand, so there is no seed of yours to check." });
      } else if (mine === undefined) {
        out.push({
          ok: seen ? false : null, label: "Your seed is included",
          detail: seen ? "You sent a seed but it is not in the revealed seeds (it may have arrived after the deal)." : "You didn't send a seed for this hand; the others' seeds were used.",
        });
      } else {
        const ok = !seen || seen.clientSeed === mine;
        out.push({
          ok, label: "Your seed is included",
          detail: ok ? "The seed your browser generated is among the seeds used for the shuffle." : "The seed the server used for you differs from the one your browser sent.",
        });
      }
      const material = buildMaterial(tableId, rec.handNumber, f.clientSeeds);
      const deck = await deriveDeck(f.serverSeed, material);
      const same = deck.length === rec.reveal.deck.length && deck.every((c, i) => c === rec.reveal.deck[i]) && material === f.material;
      out.push({
        ok: same, label: "Deck recomputed in your browser",
        detail: same ? "HMAC-SHA256 shuffle of the server seed and all seeds gives exactly the revealed deck." : "The recomputed deck does NOT equal the revealed deck.",
      });
    } catch (e) {
      out.push({ ok: false, label: "Fairness check", detail: `Could not verify: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  try {
    const computed = await sha256Hex(`${rec.reveal.salt}:${rec.reveal.deck.join(",")}`);
    const ok = computed.toLowerCase() === rec.deckHash.toLowerCase();
    out.push({ ok, label: "Deck fingerprint", detail: ok ? "sha256(salt:deck) equals the hash shown during the hand." : "The deck fingerprint does NOT match the hash shown during the hand." });
  } catch (e) {
    out.push({ ok: false, label: "Deck fingerprint", detail: `Could not verify: ${e instanceof Error ? e.message : String(e)}` });
  }
  return out;
}
