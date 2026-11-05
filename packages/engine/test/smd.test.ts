import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { bestHigh, bestLowAny } from "../src/evaluate.js";
import { fastHighScore } from "../src/luck.js";

const c = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];

describe("SMD: 2or3 hole-card rule", () => {
  // Hole Ks Qs Js 2c, board Ts 9s 2d 3h 7c: K-high straight flush needs three hole cards and two board cards.
  const hole = c("Ks Qs Js 2c");
  const board = c("Ts 9s 2d 3h 7c");

  it("finds a straight flush using three hole cards", () => {
    const best = bestHigh(hole, board, "2or3");
    expect(best.name).toBe("Straight Flush, King high");
    expect(best.cards.filter((x) => hole.includes(x))).toHaveLength(3);
  });

  it("exactly two hole cards (true) cannot make it", () => {
    const best = bestHigh(hole, board, true);
    expect(best.name).not.toMatch(/Straight Flush/);
    expect(best.name).toBe("Pair of Twos");
  });

  it("'false' (any five) also finds it", () => {
    expect(bestHigh(hole, board, false).name).toBe("Straight Flush, King high");
  });

  it("never uses four hole cards: As Ks Qs Js on Ts 9s is not a royal under 2or3", () => {
    // A royal would need all four hole cards plus Ts. Under 2or3 the best is the K-high straight flush.
    const best = bestHigh(c("As Ks Qs Js"), c("Ts 9s 2d 3h 7c"), "2or3");
    expect(best.name).toBe("Straight Flush, King high");
    expect(best.cards.filter((x) => c("As Ks Qs Js").includes(x))).toHaveLength(3);
  });

  // Hole As 2c 3d Kh, board 4h 5s Qd Jc 9c: the wheel uses three hole cards (As 2c 3d) and two board cards (4h 5s).
  const lowHole = c("As 2c 3d Kh");
  const lowBoard = c("4h 5s Qd Jc 9c");

  it("the wheel (5-4-3-2-A) is the best low with three hole cards", () => {
    const low = bestLowAny(lowHole, lowBoard, "2or3");
    expect(low!.name).toBe("5-4-3-2-A");
    expect(low!.cards.filter((x) => lowHole.includes(x))).toHaveLength(3);
  });

  it("with exactly two hole cards the best low is worse", () => {
    const low = bestLowAny(lowHole, lowBoard, true);
    expect(low!.name).toBe("9-5-4-2-A");
    expect(low!.score).toBeGreaterThan(bestLowAny(lowHole, lowBoard, "2or3")!.score);
  });

  it("works with five hole cards", () => {
    expect(bestHigh(c("Ks Qs Js 2c 4d"), board, "2or3").name).toBe("Straight Flush, King high");
    expect(bestLowAny(c("As 2c 3d Kh 6d"), lowBoard, "2or3")!.name).toBe("5-4-3-2-A");
  });

  it("the fast scorer agrees with bestHigh on random deals (4 and 5 hole cards)", () => {
    let seed = 99;
    const r = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 300; i++) {
      const d = freshDeck();
      for (let k = d.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1));
        [d[k], d[j]] = [d[j]!, d[k]!];
      }
      for (const h of [4, 5]) {
        const hc = d.slice(0, h);
        const bd = d.slice(h, h + 5);
        expect(fastHighScore(hc, bd, "2or3")).toBe(bestHigh(hc, bd, "2or3").score);
      }
    }
  });
});
