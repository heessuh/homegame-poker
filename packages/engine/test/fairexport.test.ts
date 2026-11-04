import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMaterial } from "../src/fair.js";
import { buildFairExport, FAIR_EXPORT_FORMAT, VERIFIER_URL } from "../src/fairexport.js";
import { deriveDeck, seedHash } from "../src/fairshuffle.js";
import type { HandRecord } from "../src/protocol.js";

// The standalone verifier is a separate, independent project that lives next to the app checkout
// (D:\projects\mochapoker-verify). These tests run it against real exports when it is present.
const verifyPath = fileURLToPath(new URL("../../../../mochapoker-verify/verify.js", import.meta.url));
type Verifier = { verifyAll(text: string, mySeed?: string): Promise<{ ok: boolean; checks: { ok: boolean; label: string }[] }[]> };
const verifier: Verifier | null = existsSync(verifyPath) ? (createRequire(import.meta.url)(verifyPath) as Verifier) : null;

function makeRecord(n: number, tableId: string, tamper = false): { rec: HandRecord; mine: string } {
  const serverSeed = randomBytes(32).toString("hex");
  const clientSeeds = { alice: randomBytes(16).toString("hex"), bob: randomBytes(16).toString("hex") };
  const material = buildMaterial(tableId, n, clientSeeds);
  const deck = deriveDeck(serverSeed, material);
  if (tamper) [deck[0], deck[1]] = [deck[1]!, deck[0]!];
  const rec = {
    handNumber: n, variant: "holdem", deckHash: "x", reveal: { deck, salt: "s" },
    fair: { algorithm: "mochapoker-v1", serverSeed, serverSeedHash: seedHash(serverSeed), clientSeeds, material },
    board: [], winners: [], summary: [], shown: {}, names: { alice: "Alice", bob: "Bob" }, endedAt: 1,
  } as unknown as HandRecord;
  return { rec, mine: clientSeeds.alice };
}

describe("fairness export", () => {
  it("has a stable shape and skips hands without fair data", () => {
    const { rec } = makeRecord(3, "tbl");
    const legacy = { ...rec, handNumber: 2, fair: undefined } as HandRecord;
    const out = buildFairExport("tbl", [rec, legacy]);
    expect(out.format).toBe(FAIR_EXPORT_FORMAT);
    expect(out.version).toBe(1);
    expect(out.hands.map((h) => h.handNumber)).toEqual([3]);
    expect(Object.keys(out.hands[0]!).sort()).toEqual(["algorithm", "clientSeeds", "deck", "handNumber", "material", "serverSeed", "serverSeedHash", "tableId"]);
    expect(VERIFIER_URL).toMatch(/^https:\/\/heessuh\.github\.io\/mochapoker-verify\/$/);
  });

  it.skipIf(!verifier)("round-trips through the independent verifier (JSON text, as pasted)", async () => {
    const recs = [1, 2, 3].map((n) => makeRecord(n, "room9"));
    const seen = new Map(recs.map((r) => [r.rec.handNumber, { serverSeedHash: r.rec.fair!.serverSeedHash, clientSeed: r.mine }]));
    const text = JSON.stringify(buildFairExport("room9", recs.map((r) => r.rec), { playerId: "alice", seen: (n) => seen.get(n) ?? null }));
    const out = await verifier!.verifyAll(text);
    expect(out).toHaveLength(3);
    for (const r of out) expect(r.ok).toBe(true);
    // Own-seed check by pasting a seed.
    expect((await verifier!.verifyAll(JSON.stringify(buildFairExport("room9", [recs[0]!.rec])), recs[0]!.mine))[0]!.ok).toBe(true);
    expect((await verifier!.verifyAll(JSON.stringify(buildFairExport("room9", [recs[0]!.rec])), "00".repeat(16)))[0]!.ok).toBe(false);
  });

  it.skipIf(!verifier)("the verifier rejects a doctored deck or a swapped commitment", async () => {
    const bad = makeRecord(1, "room9", true).rec;
    expect((await verifier!.verifyAll(JSON.stringify(buildFairExport("room9", [bad]))))[0]!.ok).toBe(false);
    const good = makeRecord(2, "room9");
    const seen = { serverSeedHash: "ab".repeat(32), clientSeed: good.mine };
    expect((await verifier!.verifyAll(JSON.stringify(buildFairExport("room9", [good.rec], { seen: () => seen }))))[0]!.ok).toBe(false);
  });
});
