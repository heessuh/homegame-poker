import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildMaterial, deriveDeck, seedHash, type HandRecord } from "@homegame/engine";
import { Table } from "../src/table.js";
import { actor, checkDown, FakeClock, rig, seatAll, type Rig } from "./helpers.js";

const hex16 = () => randomBytes(16).toString("hex");
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fairRig = (n: number, config = {}): Rig => rig(n, config, null);
const view = (r: Rig, i = 0) => r.table.viewFor(r.ids[i]!);
const commitment = (r: Rig) => view(r).fairness!;

/** Everyone sends a seed for the upcoming hand; returns them by player id. */
function sendSeeds(r: Rig, who: number[] = r.ids.map((_, i) => i)): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of who) {
    out[r.ids[i]!] = hex16();
    r.table.submitSeed(r.ids[i]!, commitment(r).nextHandNumber, out[r.ids[i]!]);
  }
  return out;
}

function startAndFinish(r: Rig): HandRecord {
  r.table.hostStart(r.ids[0]!);
  r.clock.advance(1000);
  checkDown(r);
  return view(r).lastHand!;
}

describe("provably fair deals", () => {
  it("publishes a commitment before the hand and the reveal matches it", () => {
    const r = fairRig(3);
    seatAll(r);
    const c = commitment(r);
    expect(c.nextHandNumber).toBe(1);
    expect(c.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    const seeds = sendSeeds(r);
    const rec = startAndFinish(r);
    expect(rec.fair!.algorithm).toBe("mochapoker-v1");
    expect(rec.fair!.serverSeedHash).toBe(c.serverSeedHash);
    expect(seedHash(rec.fair!.serverSeed)).toBe(c.serverSeedHash);
    expect(rec.fair!.clientSeeds).toEqual(seeds);
    expect(rec.fair!.material).toBe(buildMaterial("test-table", 1, seeds));
    expect(rec.reveal.deck).toEqual(deriveDeck(rec.fair!.serverSeed, rec.fair!.material));
  });

  it("rotates the server seed every hand", () => {
    const r = fairRig(2);
    seatAll(r);
    const first = commitment(r).serverSeedHash;
    const a = startAndFinish(r);
    const second = commitment(r);
    expect(second.nextHandNumber).toBe(2);
    expect(second.serverSeedHash).not.toBe(first);
    r.clock.advance(5000);
    checkDown(r);
    const b = view(r).lastHand!;
    expect(b.handNumber).toBe(2);
    expect(b.fair!.serverSeedHash).toBe(second.serverSeedHash);
    expect(b.fair!.serverSeed).not.toBe(a.fair!.serverSeed);
  });

  it("the commitment for the next hand is already visible while a hand is in progress", () => {
    const r = fairRig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    expect(view(r).hand).not.toBeNull();
    expect(commitment(r).nextHandNumber).toBe(2);
  });

  it("only seeds from players dealt in, for the right hand and well-formed, are used; the last one wins", () => {
    const r = fairRig(3);
    seatAll(r, [0, 1, 2]);
    // Player 2 is dealt in but sends no seed: it simply does not contribute.
    const good = sendSeeds(r, [0, 1]);
    r.table.submitSeed(r.ids[0]!, 7, hex16()); // wrong hand number
    r.table.submitSeed(r.ids[1]!, 1, "xyz"); // malformed
    r.table.submitSeed(r.ids[1]!, 1, hex16().toUpperCase()); // uppercase is not allowed
    r.table.submitSeed(r.ids[1]!, 1, 12345 as never);
    r.table.submitSeed("not-a-player", 1, hex16());
    const replaced = hex16();
    r.table.submitSeed(r.ids[0]!, 1, replaced);
    good[r.ids[0]!] = replaced;
    const rec = startAndFinish(r);
    expect(rec.fair!.clientSeeds).toEqual(good);
    expect(r.table.getLog()).toContain("Shuffle seeds: 2 of 3 players");
    // A seed that arrives after the deal is for the NEXT hand only; for hand 1 it is ignored.
    r.table.submitSeed(r.ids[2]!, 1, hex16());
    r.clock.advance(5000);
    checkDown(r);
    expect(view(r).lastHand!.fair!.clientSeeds[r.ids[2]!]).toBeUndefined();
  });

  it("the same inputs always give the same deck and other material gives another", () => {
    const r = fairRig(2);
    seatAll(r);
    const rec = startAndFinish(r);
    const again = deriveDeck(rec.fair!.serverSeed, rec.fair!.material);
    expect(again).toEqual(rec.reveal.deck);
    expect(deriveDeck(rec.fair!.serverSeed, buildMaterial("test-table", 1, { x: hex16() }))).not.toEqual(again);
  });

  it("never leaks the server seed or the fair key in any view before the reveal", () => {
    const r = fairRig(3);
    seatAll(r);
    sendSeeds(r);
    const next1 = r.table.snapshot().nextServerSeed!;
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const snap = r.table.snapshot();
    const dealtSeed = snap.hand!.fair!.serverSeed;
    const next2 = snap.nextServerSeed!;
    expect(dealtSeed).toBe(next1);
    expect(next2).not.toBe(next1);
    for (let i = 0; i < 200 && actor(r); i++) {
      for (const idx of r.ids.keys()) {
        const json = JSON.stringify(view(r, idx));
        for (const s of [dealtSeed, next2]) expect(json).not.toContain(s);
        expect(json).not.toContain('"serverSeed"');
        expect(json).not.toContain('"key"');
      }
      const id = actor(r)!;
      const legal = r.table.viewFor(id).hand!.legal!;
      r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
    }
    // After the hand: only the seed of the finished hand is revealed, never the next one.
    for (const idx of r.ids.keys()) {
      const json = JSON.stringify(view(r, idx));
      expect(json).toContain(dealtSeed);
      expect(json).not.toContain(next2);
    }
  });

  it("restoring mid-hand continues with the same deck, and the next seed and collected seeds survive", () => {
    const r = fairRig(3);
    seatAll(r);
    sendSeeds(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const nextSeeds: Record<string, string> = {};
    for (const i of [0, 2]) {
      nextSeeds[r.ids[i]!] = hex16();
      r.table.submitSeed(r.ids[i]!, 2, nextSeeds[r.ids[i]!]!);
    }
    const nextHash = commitment(r).serverSeedHash;
    const snap = roundTrip(r.table.snapshot());
    expect(snap.seeds).toEqual(nextSeeds);

    const clock = new FakeClock();
    clock.t = 9_000_000;
    const t2 = new Table({ tableId: snap.tableId, now: clock.now, scheduler: clock, onChange: () => undefined, snapshot: snap });
    t2.resume();
    const r2: Rig = { clock, table: t2, ids: r.ids };
    expect(view(r2).fairness).toEqual(commitment(r));
    expect(commitment(r2).serverSeedHash).toBe(nextHash);
    checkDown(r2);
    checkDown(r);
    const a = view(r).lastHand!;
    const b = view(r2).lastHand!;
    expect(b.reveal.deck).toEqual(a.reveal.deck);
    expect(b.fair).toEqual(a.fair);
    expect(b.reveal.deck).toEqual(deriveDeck(b.fair!.serverSeed, b.fair!.material));
    // Hand 2 uses the carried-over seeds and the carried-over server seed.
    clock.advance(5000);
    checkDown(r2);
    const h2 = view(r2).lastHand!;
    expect(h2.fair!.serverSeedHash).toBe(nextHash);
    expect(h2.fair!.clientSeeds).toEqual(nextSeeds);
  });

  it("5-Murder reshuffles are derived too and play out identically after a restore", () => {
    const r = fairRig(8, { variant: "murder5" });
    seatAll(r);
    sendSeeds(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const snapAt = roundTrip(r.table.snapshot());
    expect(snapAt.hand!.state.fair).toBeDefined();
    const drive = (x: Rig) => {
      for (let i = 0; i < 400; i++) {
        const id = actor(x);
        if (!id) return;
        const legal = x.table.viewFor(id).hand!.legal!;
        if (legal.exchange) x.table.action(id, { type: "exchange", card: legal.exchange.upCards[0] ?? null });
        else if (legal.declare) x.table.action(id, { type: "declare", choice: "high" });
        else x.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
      }
    };
    drive(r);
    const clock = new FakeClock();
    clock.t = 9_000_000;
    const t2 = new Table({ tableId: snapAt.tableId, now: clock.now, scheduler: clock, onChange: () => undefined, snapshot: snapAt });
    t2.resume();
    const r2: Rig = { clock, table: t2, ids: r.ids };
    drive(r2);
    expect(view(r2).lastHand!.summary).toEqual(view(r).lastHand!.summary);
    expect(view(r2).lastHand!.shown).toEqual(view(r).lastHand!.shown);
  });

  it("test decks (deckSource) switch fairness off", () => {
    const r = rig(2);
    seatAll(r);
    expect(view(r).fairness).toBeNull();
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    checkDown(r);
    expect(view(r).lastHand!.fair).toBeUndefined();
  });
});
