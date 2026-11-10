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
