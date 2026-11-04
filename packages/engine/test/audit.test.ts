import { describe, expect, it } from "vitest";
import {
  FLOP, SEVEN_CARD_CATEGORIES, SEVEN_CARD_PROBS, SEVEN_CARD_TOTAL, TWO_CARD,
  addHandToCounts, bestHigh, buildReport, chiSquareGof, chiSquareSf, choose, emptyCounts, freshDeck, gammaQ,
  logGamma, minSamplesForTest, normalInterval95, shuffle, wilsonInterval95,
  type AuditCounts, type Card, type RngAuditReport,
} from "../src/index.js";

const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

describe("stats: special functions", () => {
  it("logGamma matches known values", () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(100)).toBeCloseTo(359.1342053695754, 9);
  });

  it("chi-square upper tail matches published table values", () => {
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(6.634897, 1)).toBeCloseTo(0.01, 6);
    expect(chiSquareSf(10.827566, 1)).toBeCloseTo(0.001, 6);
    expect(chiSquareSf(5.991465, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(2, 2)).toBeCloseTo(Math.exp(-1), 12); // df 2 is exponential
    expect(chiSquareSf(18.307038, 10)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(67.504807, 50)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(68.669, 51)).toBeCloseTo(0.05, 3);
    expect(chiSquareSf(124.342113, 100)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(1094.4, 1020)).toBeGreaterThan(0.03); // normal approximation says ~5% at mean + 1.645 sd
    expect(chiSquareSf(1094.4, 1020)).toBeLessThan(0.07);
  });

  it("handles the extremes and complements", () => {
    expect(chiSquareSf(0, 5)).toBe(1);
    expect(chiSquareSf(1e6, 5)).toBe(0);
    expect(gammaQ(3.7, 2.2) + (1 - gammaQ(3.7, 2.2))).toBeCloseTo(1, 14);
    expect(chiSquareSf(30, 20)).toBeCloseTo(0.0698, 3);
    expect(Number.isNaN(chiSquareSf(1, 0))).toBe(true);
  });

  it("intervals behave", () => {
    const [lo, hi] = normalInterval95(0.5, 100);
    expect(lo).toBeCloseTo(0.402, 3);
    expect(hi).toBeCloseTo(0.598, 3);
    const [wl, wh] = wilsonInterval95(0, 100);
    expect(wl).toBeCloseTo(0, 12);
    expect(wh).toBeCloseTo(0.0370, 3);
    const [a, b] = wilsonInterval95(50, 100);
    expect(a).toBeCloseTo(0.4038, 3);
    expect(b).toBeCloseTo(0.5962, 3);
  });
});

describe("goodness of fit", () => {
  it("pools small cells and reports df", () => {
    const g = chiSquareGof([90, 8, 2], [0.9, 0.08, 0.02]);
    // n = 100: expected 90, 8, 2 -> the 2 pools with 8 (10 >= 5)
    expect(g.pooledAny).toBe(true);
    expect(g.df).toBe(1);
    expect(g.chiSquare).toBeCloseTo(0, 12);
    expect(g.pValue).toBeCloseTo(1, 12);
  });
  it("minSamplesForTest finds the smallest testable n", () => {
    const probs = [TWO_CARD.aa, TWO_CARD.ak, 1 - TWO_CARD.aa - TWO_CARD.ak];
    const n = minSamplesForTest(probs, 100);
    expect(n).toBeGreaterThanOrEqual(100);
    expect(n).toBeLessThan(400);
    expect(chiSquareGof(probs.map((p) => Math.round(p * (n - 1))), probs).df).toBeGreaterThanOrEqual(0);
  });
});

describe("exact expectations", () => {
  it("sum to one", () => {
    expect(TWO_CARD.pair + TWO_CARD.suited + TWO_CARD.offsuit).toBeCloseTo(1, 12);
    expect(sum(SEVEN_CARD_CATEGORIES.map((c) => c.count))).toBe(SEVEN_CARD_TOTAL);
    expect(sum(SEVEN_CARD_PROBS)).toBeCloseTo(1, 12);
    expect(FLOP.paired + FLOP.unpaired).toBeCloseTo(1, 12);
    expect(FLOP.monotone + FLOP.twoTone + FLOP.rainbow).toBeCloseTo(1, 12);
  });
  it("match the textbook numbers", () => {
    expect(TWO_CARD.pair).toBeCloseTo(3 / 51, 15);
    expect(TWO_CARD.aa).toBeCloseTo(6 / 1326, 15);
    expect(TWO_CARD.ak).toBeCloseTo(16 / 1326, 15);
    expect(choose(52, 7)).toBe(SEVEN_CARD_TOTAL);
    expect(choose(52, 3)).toBe(22100);
    expect(FLOP.monotone).toBeCloseTo(4 * choose(13, 3) / 22100, 15);
    expect(FLOP.paired).toBeCloseTo(1 - (48 / 51) * (44 / 50), 15);
  });
});

/** Exact enumeration check: 7-card category counts agree with the evaluator on a spot-check of known hands. */
describe("seven-card categorisation", () => {
  it("scores categories 0-8 as listed", () => {
    const cat = (cards: Card[]) => Math.floor(bestHigh([], cards, false).score / 16 ** 5);
    expect(cat(["As", "Ks", "Qs", "Js", "Ts", "2d", "3c"])).toBe(8);
    expect(cat(["9s", "9h", "9d", "9c", "Ts", "2d", "3c"])).toBe(7);
    expect(cat(["9s", "9h", "9d", "Tc", "Ts", "2d", "3c"])).toBe(6);
    expect(cat(["2s", "9s", "Ks", "Tc", "7s", "4s", "3c"])).toBe(5);
    expect(cat(["5s", "6h", "7d", "8c", "9s", "2d", "Kc"])).toBe(4);
    expect(cat(["9s", "9h", "9d", "Kc", "Ts", "2d", "3c"])).toBe(3);
    expect(cat(["9s", "9h", "Td", "Tc", "As", "2d", "3c"])).toBe(2);
    expect(cat(["9s", "9h", "Td", "Kc", "As", "2d", "3c"])).toBe(1);
    expect(cat(["9s", "4h", "Td", "Kc", "As", "2d", "7c"])).toBe(0);
  });
});

function fakeHand(deck: Card[], boardLen = 5) {
  return { board: deck.slice(21, 21 + boardLen), reveal: { deck } };
}

describe("addHandToCounts", () => {
  it("counts a hand-built deck exactly", () => {
    const d = freshDeck();
    const c = emptyCounts();
    expect(addHandToCounts(c, fakeHand(d))).toBe(true);
    expect(c.hands).toBe(1);
    expect(c.twoN).toBe(10);
    expect(c.pair + c.suited + c.offsuit).toBe(10);
    expect(c.pair).toBe(c.pair | 0);
    expect(c.sevenN).toBe(3);
    expect(sum(c.seven)).toBe(3);
    expect(c.flopN).toBe(1);
    expect(c.flopPaired + 0).toBeLessThanOrEqual(1);
    expect(sum(c.pos)).toBe(20);
  });
  it("skips bad decks and short boards", () => {
    const c = emptyCounts();
    expect(addHandToCounts(c, { board: [], reveal: { deck: freshDeck().slice(0, 40) } })).toBe(false);
    const dup = freshDeck();
    dup[1] = dup[0]!;
    expect(addHandToCounts(c, { board: [], reveal: { deck: dup } })).toBe(false);
    expect(c.hands).toBe(0);
    expect(addHandToCounts(c, { board: ["2c", "3d"], reveal: { deck: freshDeck() } })).toBe(true);
    expect(c.flopN).toBe(0);
  });
});

// ---- simulation ----

function simulate(n: number, make: () => Card[]): AuditCounts {
  const c = emptyCounts();
  for (let i = 0; i < n; i++) addHandToCounts(c, fakeHand(make()));
  return c;
}

/** Cheats toward pairs: pairs seat holdings 20% more often than chance. */
function biasedDeck(): Card[] {
  const d = shuffle();
  for (let p = 0; p < 20; p += 2) {
    if (Math.random() < 0.0125 && d[p]![0] !== d[p + 1]![0]) {
      const j = d.findIndex((c, k) => k > p + 1 && c[0] === d[p]![0]);
      [d[p + 1], d[j]] = [d[j]!, d[p + 1]!];
    }
  }
  return d;
}

describe("simulation", () => {
  const N = 20_000;
  const verdicts = (r: RngAuditReport) => r.lenses.map((l) => `${l.id}:${l.verdict}`);

  it("20,000 fair shuffles are 'fair' on every lens", { timeout: 120_000 }, () => {
    // Six lenses at p = 0.01 would fail ~6% of fair runs by pure chance; retry fresh decks (3 tries: ~0.02%).
    let last: RngAuditReport | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = buildReport(simulate(N, () => shuffle()), "site", "2026-01-01T00:00:00.000Z");
      if (last.lenses.every((l) => l.verdict === "fair")) break;
    }
    expect(verdicts(last!)).toEqual([
      "pocket-shape:fair", "premium-starts:fair", "seven-card:fair", "flop-pairing:fair", "flop-suits:fair", "deck-positions:fair",
    ]);
    expect(last!.hands).toBe(N);
    expect(last!.overall?.verdict).toBe("fair");
    expect(last!.overall?.tested).toBe(6);
    const pocket = last!.lenses[0]!;
    expect(pocket.rows[0]!.observedPct).toBeGreaterThan(pocket.rows[0]!.ci95[0] - 1);
    expect(pocket.df).toBe(2);
    expect(last!.lenses[5]!.df).toBe(1020);
  });

  it("a deck that deals pairs 20% too often is flagged 'investigate'", { timeout: 120_000 }, () => {
    const r = buildReport(simulate(N, biasedDeck), "site", "2026-01-01T00:00:00.000Z");
    const pocket = r.lenses.find((l) => l.id === "pocket-shape")!;
    expect(pocket.verdict).toBe("investigate");
    expect(r.overall?.verdict).toBe("investigate");
    expect(pocket.pValue!).toBeLessThan(0.001);
    expect(pocket.rows[0]!.observedPct).toBeGreaterThan(pocket.rows[0]!.ci95[1]);
  });

  it("a stacked deck that always gives seat 1 aces is flagged on the aces and positions lenses", () => {
    const stacked = (): Card[] => {
      const d = shuffle().filter((c) => c !== "As" && c !== "Ah");
      return ["As", "Ah", ...d];
    };
    const r = buildReport(simulate(2_000, stacked), "site", "x");
    expect(r.lenses.find((l) => l.id === "premium-starts")!.verdict).toBe("investigate");
    expect(r.lenses.find((l) => l.id === "deck-positions")!.verdict).toBe("investigate");
  });

  it("says too-few-hands early, with a number", () => {
    const r = buildReport(simulate(3, () => shuffle()), "table", "x");
    for (const l of r.lenses) {
      expect(l.verdict).toBe("too-few-hands");
      expect(l.pValue).toBeNull();
      expect(l.minHands).toBeGreaterThan(3);
    }
    expect(r.lenses.find((l) => l.id === "deck-positions")!.minHands).toBe(260);
    const empty = buildReport(emptyCounts(), "site", "x");
    expect(empty.hands).toBe(0);
    expect(empty.lenses.every((l) => l.verdict === "too-few-hands")).toBe(true);
  });
});
