import { describe, expect, it } from "vitest";
import { reviewHand } from "@homegame/engine";
import { rabbitCards } from "../../web/src/util.js";
import { foldAround, rig, seatAll } from "./helpers.js";

describe("rabbit hunt (web helper)", () => {
  it("matches the review's undealt board cards when a hand ends before the flop", () => {
    const r = rig(3);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    foldAround(r);
    const rec = r.table.viewFor(r.ids[0]!).lastHand!;
    const rv = reviewHand(rec as never);
    expect(rv.available).toBe(true);
    if (!rv.available) return;
    const rabbit = rabbitCards(rec);
    expect(rabbit).toHaveLength(5);
    expect(rabbit).toEqual(rv.fullBoard.slice(rv.board.length));
  });
});

describe("FYST, Double FYST and Dumb & Dumber at a table", () => {
  it("deals each game with the right number of cards, and the rabbit hunt still lines up", () => {
    for (const [variant, n] of [["fyst-he", 2], ["fyst-o", 4], ["dumb", 4]] as const) {
      const r = rig(3, { variant, actionTimeoutSec: 0 });
      seatAll(r);
      r.table.hostStart(r.ids[0]!);
      r.clock.advance(1000);
      { const me = r.table.viewFor(r.ids[0]!); expect(me.seats[me.you.seat!]!.holeCards).toHaveLength(n); }
      foldAround(r);
      const rec = r.table.viewFor(r.ids[0]!).lastHand!;
      expect(rec.variant).toBe(variant);
      const rv = reviewHand(rec as never);
      expect(rv.available).toBe(true);
      if (rv.available) expect(rabbitCards(rec)).toEqual(rv.fullBoard.slice(rv.board.length));
    }
  });

  it("the old FYST can no longer be picked", () => {
    const r = rig(2);
    expect(() => r.table.hostConfig(r.ids[0]!, { variant: "fyst" })).toThrow(/no longer offered/);
    r.table.hostConfig(r.ids[0]!, { variant: "fyst-o" });
    expect(r.table.viewFor(r.ids[0]!).config.variant).toBe("fyst-o");
  });
});
