import { describe, expect, it } from "vitest";
import type { Card } from "../src/cards.js";
import { tkoPoints, tkoSummary } from "../src/points.js";

const cards = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];

describe("TKO points", () => {
  it("counts 2-9 at face value and T, J, Q, K as ten", () => {
    const r = tkoPoints(cards("Ks Qd Jc Th"), cards("2c 3d 4h 5s 6c"));
    expect(r.high).toBe(40);
    expect(r.low).toBe(40);
    expect(r.out).toEqual([]);
    const nines = tkoPoints(cards("9s 8d 7c 2h"), cards("3c 4d 5h 6s"));
    expect(nines.high).toBe(26);
    expect(nines.low).toBe(26);
  });

  it("counts an ace as 11 for high and 1 for low", () => {
    const r = tkoPoints(cards("Ah"), cards("2c 3d 4h 5s 6c"));
    expect(r.high).toBe(11);
    expect(r.low).toBe(1);
    expect(r.remaining).toEqual(cards("Ah"));
  });

  it("knocks out a hole card whose rank is on the board", () => {
    const r = tkoPoints(cards("7s 9d"), cards("9c 2h 3c 4d 5s"));
    expect(r.out).toEqual(cards("9d"));
    expect(r.remaining).toEqual(cards("7s"));
    expect(r.high).toBe(7);
    expect(r.low).toBe(7);
  });

  it("knocks out every hole card of a matching rank", () => {
    const r = tkoPoints(cards("8s 8d 3c 4h"), cards("8c 2d 5h 6s Ks"));
    expect(r.out).toEqual(cards("8s 8d"));
    expect(r.remaining).toEqual(cards("3c 4h"));
    expect(r.high).toBe(7);
    expect(r.low).toBe(7);
  });

  it("a pair on the board knocks a hole card out only once", () => {
    const r = tkoPoints(cards("8s 3c 4h 9d"), cards("8c 8d 2d 5h 6s"));
    expect(r.out).toEqual(cards("8s"));
    expect(r.remaining).toEqual(cards("3c 4h 9d"));
    expect(r.high).toBe(16);
  });

  it("keeps the remaining cards in dealt order", () => {
    const r = tkoPoints(cards("2s 9h 5d 3d"), cards("5c"));
    expect(r.out).toEqual(cards("5d"));
    expect(r.remaining).toEqual(cards("2s 9h 3d"));
    expect(r.high).toBe(14);
    expect(r.low).toBe(14);
  });

  it("gives zero when no cards are left", () => {
    const r = tkoPoints(cards("5s 5d"), cards("5c 9h"));
    expect(r.remaining).toEqual([]);
    expect(r.out).toEqual(cards("5s 5d"));
    expect(r.high).toBe(0);
    expect(r.low).toBe(0);
    expect(tkoSummary(r)).toBe("no cards left");
  });

  it("keeps hole cards that share a rank with each other when the board has no match", () => {
    const r = tkoPoints(cards("7s 7d Kc 2h"), cards("3c 4d 5h 6s 9c"));
    expect(r.out).toEqual([]);
    expect(r.remaining).toEqual(cards("7s 7d Kc 2h"));
    expect(r.high).toBe(26);
    expect(r.low).toBe(26);
  });

  it("only counts ace as 11 for the high total when several aces are in hand", () => {
    const r = tkoPoints(cards("Ah Ad 3c"), cards("2d 4s 6h 8c Td"));
    expect(r.high).toBe(25);
    expect(r.low).toBe(5);
  });

  it("summarizes a single number when high and low match, and a range otherwise", () => {
    expect(tkoSummary(tkoPoints(cards("7s 7d"), cards("3c 4d 5h 6s 9c")))).toBe("14 points");
    expect(tkoSummary(tkoPoints(cards("Ah 3c"), cards("2d 4s 6h 8c Td")))).toBe("4 to 14 points");
  });
});
