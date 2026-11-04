import type { HandRecord } from "./protocol.js";
import { FAIR_ALGORITHM } from "./fair.js";

// Export format for the standalone verifier (https://heessuh.github.io/mochapoker-verify/). No crypto here.
// Pure data: everything in it is revealed after the hand anyway.

/** The public home of the independent verifier. Single source of truth for the app's "Check it yourself" link. */
export const VERIFIER_URL = "https://heessuh.github.io/mochapoker-verify/";

export const FAIR_EXPORT_FORMAT = "mochapoker-fairness";

/** What one browser remembers from before the deal (optional). */
export interface FairSeen {
  serverSeedHash: string;
  clientSeed: string;
}

export interface FairExportHand {
  tableId: string;
  handNumber: number;
  algorithm: typeof FAIR_ALGORITHM;
  serverSeed: string;
  serverSeedHash: string;
  clientSeeds: Record<string, string>;
  material: string;
  deck: string[];
  /** Only present when the exporting browser saw the commitment before the deal. */
  youSaw?: { playerId?: string; serverSeedHash: string; clientSeed: string };
}

export interface FairExport {
  format: typeof FAIR_EXPORT_FORMAT;
  version: 1;
  tableId: string;
  hands: FairExportHand[];
}

/** Builds the verifier JSON. Hands without fair data (pre-feature or test-injected decks) are skipped. */
export function buildFairExport(
  tableId: string,
  records: readonly HandRecord[],
  opts: { playerId?: string; seen?: (handNumber: number) => FairSeen | null } = {},
): FairExport {
  const hands: FairExportHand[] = [];
  for (const rec of records) {
    const f = rec.fair;
    if (!f) continue;
    const h: FairExportHand = {
      tableId, handNumber: rec.handNumber, algorithm: FAIR_ALGORITHM,
      serverSeed: f.serverSeed, serverSeedHash: f.serverSeedHash,
      clientSeeds: { ...f.clientSeeds }, material: f.material, deck: [...rec.reveal.deck],
    };
    const s = opts.seen?.(rec.handNumber);
    if (s) h.youSaw = { ...(opts.playerId ? { playerId: opts.playerId } : {}), serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed };
    hands.push(h);
  }
  hands.sort((a, b) => a.handNumber - b.handNumber);
  return { format: FAIR_EXPORT_FORMAT, version: 1, tableId, hands };
}
