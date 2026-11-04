import { describe, expect, it } from "vitest";
import {
  VARIANTS, applyAction, bestHandCredits, fastHighScore, bestHigh, bestLow8, buildLuckReport, freshDeck, handLuck, legalActions,
  orderFromButton, reconstructDeal, runoutEquity, startHand,
  type Card, type HandState, type LuckableHand, type PlayerAction, type VariantId,
} from "../src/index.js";

// ------------------------------------------------------------- helpers

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(r: () => number): Card[] {
  const d = freshDeck();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [d[i], d[j]] = [d[j]!, d[i]!];
  }
  return d;
}

const cards = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];

/** Plays one hand with random bots (about one in seven raises is all-in) and returns the state and a record. */
function playHand(variant: VariantId, ids: string[], handNumber: number, deck: Card[], r: () => number, button = handNumber % ids.length): { state: HandState; rec: LuckableHand } {
  let s = startHand({
    handNumber, variant, buttonSeat: button, smallBlind: 10, bigBlind: 20, deck,
    seats: ids.map((playerId, seat) => ({ seat, playerId, stack: 2000 })),
  });
  for (let guard = 0; guard < 400 && !s.outcome; guard++) {
    const p = s.players.find((x) => x.seat === s.toActSeat)!;
    const l = legalActions(s, p.playerId)!;
    let act: PlayerAction;
    const roll = r();
    if (l.minRaiseTo !== null && roll < 0.14) act = { type: "raise", amount: l.maxRaiseTo! };
    else if (l.minRaiseTo !== null && roll < 0.3) act = { type: "raise", amount: l.minRaiseTo };
    else if (l.canFold && roll < 0.45 && l.callAmount > 0) act = { type: "fold" };
    else act = l.canCheck ? { type: "check" } : { type: "call" };
    s = applyAction(s, p.playerId, act);
  }
  expect(s.outcome).not.toBeNull();
  const names: Record<string, string> = {};
  for (const id of ids) names[id] = id.toUpperCase();
  const rec: LuckableHand = {
    handNumber, variant, deckHash: `hash${handNumber}`, reveal: { deck }, board: [...s.board], endedAt: 1_000 + handNumber,
    shown: s.outcome!.shown, winners: s.outcome!.winners, names,
    luck: { v: 1, dealOrder: orderFromButton(s).map((p) => p.playerId), ...(s.runout ? { runout: s.runout } : {}) },
  };
  return { state: s, rec };
}

const IDS = ["p0", "p1", "p2", "p3", "p4", "p5"];

// ------------------------------------------------------------- reconstruction

describe("luck: reconstructing the deal", () => {
  for (const variant of ["nlhe", "plo4", "plo5", "plo4-8", "nlhe-hilo", "fyst"] as VariantId[]) {
    it(`matches the cards actually dealt (${variant})`, () => {
      const r = rng(7);
      const ids = IDS.slice(0, VARIANTS[variant].maxPlayers >= 6 ? 6 : 4);
      for (let h = 1; h <= 40; h++) {
        const { state, rec } = playHand(variant, ids, h, shuffled(r), r);
        const d = reconstructDeal(rec);
        expect(typeof d).toBe("object");
        if (typeof d === "string") return;
        expect(d.ids.length).toBe(ids.length);
        for (const p of state.players) expect(d.holes[d.ids.indexOf(p.playerId)]).toEqual(p.holeCards);
        expect(d.board.slice(0, state.board.length)).toEqual(state.board);
        expect(d.board.length).toBe(5);
      }
    });
  }

  it("skips stud, old records and corrupt ones", () => {
    const r = rng(3);
    const { rec } = playHand("nlhe", IDS, 1, shuffled(r), r);
    expect(reconstructDeal({ ...rec, variant: "murder5" })).toBe("stud");
    const { luck: _l, ...old } = rec;
    expect(reconstructDeal(old)).toBe("old");
    expect(reconstructDeal({ ...rec, reveal: { deck: rec.reveal.deck.slice(1) } })).toBe("bad");
    const swapped = [...rec.reveal.deck];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(reconstructDeal({ ...rec, reveal: { deck: swapped } })).toBe("bad"); // contradicts the cards shown or the board
  });
});

// ------------------------------------------------------------- best hand

describe("luck: fast high scoring", () => {
  it("gives the same score as the engine evaluator (Hold'em and Omaha)", () => {
    const r = rng(5);
    for (let i = 0; i < 3000; i++) {
      const d = shuffled(r);
      for (const [h, b, two] of [[2, 5, false], [2, 4, false], [4, 5, true], [5, 5, true], [2, 3, false]] as const) {
        const hole = d.slice(0, h);
        const board = d.slice(h, h + b);
        expect(fastHighScore(hole, board, two)).toBe(bestHigh(hole, board, two).score);
      }
    }
  });
  it("covers every category", () => {
    for (const [hole, board] of [["Ah Kh", "Qh Jh Th"], ["9c 9d", "9h 9s 2d"], ["9c 9d", "9h 2s 2d"], ["Ah 3h", "9h 2h 7h"], ["5c 4d", "3h 2s Ad"], ["8c 8d", "8h 2s Kd"], ["8c Kd", "8h 2s Kh"], ["8c Qd", "8h 2s Kh"], ["2c 5d", "9h Js Kh"]]) {
      expect(fastHighScore(cards(hole!), cards(board!), false)).toBe(bestHigh(cards(hole!), cards(board!), false).score);
    }
  });
});

/** Builds a deck that deals exactly the given hole cards (in deal order) and board, rest arbitrary. */
function stackedDeck(holes: string[], board: string, holeCards: number): Card[] {
  const n = holes.length;
  const perPlayer = holes.map((h) => cards(h));
  const deck: Card[] = [];
  for (let r = 0; r < holeCards; r++) for (let k = 0; k < n; k++) deck.push(perPlayer[k]![r]!);
  const b = cards(board);
  const rest = freshDeck().filter((c) => !deck.includes(c) && !b.includes(c));
  deck.push(rest.pop()!, b[0]!, b[1]!, b[2]!, rest.pop()!, b[3]!, rest.pop()!, b[4]!);
  return [...deck, ...rest];
}

describe("luck: who was dealt the best hand", () => {
  const rec = (variant: VariantId, holes: string[], board: string): LuckableHand => ({
    handNumber: 1, variant, deckHash: "h", endedAt: 1, board: [], reveal: { deck: stackedDeck(holes, board, VARIANTS[variant].holeCards) },
    luck: { v: 1, dealOrder: holes.map((_, i) => `p${i}`) },
  });
  const credits = (variant: VariantId, holes: string[], board: string): number[] => {
    const hl = handLuck(rec(variant, holes, board));
    if (typeof hl === "string") throw new Error(hl);
    return hl.credit;
  };

  it("gives the whole credit to the best hand", () => {
    expect(credits("nlhe", ["Ah Ad", "Kh Kd", "7c 2d"], "2c 5d 9h Js 3c")).toEqual([1, 0, 0]);
    expect(credits("nlhe", ["Ah Ad", "Kh Kd", "9c 2d"], "9s 5d 9h Js 3c")).toEqual([0, 0, 1]); // trips nines beat two pair
  });

  it("splits the credit on a tie", () => {
    expect(credits("nlhe", ["2h 3d", "4h 5d", "6c 7d"], "Ah Kd Qh Jc Ts")).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(credits("nlhe", ["Ah 3d", "Ad 5d", "6c 7d"], "Ks Kd Qh Jc Ts")).toEqual([0.5, 0.5, 0]);
  });

  it("uses the Omaha two-hole-card rule", () => {
    // p0 has four spades in hand but may use only two, and the board has three spades: royal flush with As Ks.
    expect(credits("plo4", ["As Ks 2d 3d", "9h 9d 2c 3c"], "Qs Js Ts 5c 6c")).toEqual([1, 0]);
    // p1 makes a flush from exactly two spades in hand plus three on the board; p0 only has a pair.
    expect(credits("plo4", ["Ad Ac 2d 3d", "Ks 9s 2c 3c"], "Qs Js 5s 8c 6c")).toEqual([0, 1]);
  });

  it("counts every credit once per hand and the shares sum to one", () => {
    const r = rng(11);
    for (let i = 0; i < 50; i++) {
      const deck = shuffled(r);
      const hl = handLuck({ handNumber: i, variant: "plo4-8", deckHash: `x${i}`, endedAt: i, board: [], reveal: { deck }, luck: { v: 1, dealOrder: ["a", "b", "c", "d", "e"] } });
      if (typeof hl === "string") throw new Error(hl);
      expect(hl.credit.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    expect(bestHandCredits("nlhe", [cards("Ah Ad"), cards("Kh Kd")], cards("2c 5d 9h Js 3c"))).toEqual([1, 0]);
  });
});

// ------------------------------------------------------------- equity

describe("luck: equity", () => {
  const two = (a: string, b: string) => [{ id: "a", hole: cards(a) }, { id: "b", hole: cards(b) }];
  const pot = [{ amount: 1, eligiblePlayerIds: ["a", "b"] }];

  it("AA against KK before the flop is about 81 to 82 percent", () => {
    const eq = runoutEquity("nlhe", [], two("Ah Ad", "Kc Ks"), pot, { samples: 30000, seed: "aa-kk" });
    expect(eq.exact).toBe(false);
    expect(eq.mean[0]!).toBeGreaterThan(0.805);
    expect(eq.mean[0]!).toBeLessThan(0.825);
    expect(eq.mean[0]! + eq.mean[1]!).toBeCloseTo(1, 9);
  });

  it("is deterministic for a given seed", () => {
    const a = runoutEquity("nlhe", [], two("Ah Ad", "Kc Ks"), pot, { seed: "x" });
    const b = runoutEquity("nlhe", [], two("Ah Ad", "Kc Ks"), pot, { seed: "x" });
    expect(a).toEqual(b);
  });

  it("enumerates exactly when there are few runouts", () => {
    // Turn dealt, one card to come: 44 runouts. KK wins only when one of the two remaining kings comes.
    const eq = runoutEquity("nlhe", cards("2c 7d 9h Ts"), two("Ac Ad", "Kh Ks"), pot);
    expect(eq.exact).toBe(true);
    expect(eq.runouts).toBe(44);
    expect(eq.mean[1]!).toBeCloseTo(2 / 44, 12);
    expect(eq.mean[0]!).toBeCloseTo(42 / 44, 12);
  });

  it("splits hi/lo pots: the low half and the high half go to different players", () => {
    const board = cards("Ah 2d 3c Kd");
    const hands = two("4s 6s Qh Qd", "Ks Kh 7c 8c");
    const eq = runoutEquity("plo4-8", board, hands, [{ amount: 100, eligiblePlayerIds: ["a", "b"] }]);
    expect(eq.exact).toBe(true);
    // Independent count straight from the evaluators.
    const v = VARIANTS["plo4-8"];
    const pool = freshDeck().filter((c) => !board.includes(c) && !hands.some((h) => h.hole.includes(c)));
    let a = 0;
    for (const river of pool) {
      const b5 = [...board, river];
      const hi = hands.map((h) => bestHigh(h.hole, b5, v.mustUseTwoHole).score);
      const lo = hands.map((h) => bestLow8(h.hole, b5, v.mustUseTwoHole)?.score ?? null);
      const loWin = lo.some((x) => x !== null)
        ? (() => { const m = Math.min(...lo.filter((x): x is number => x !== null)); return lo.map((x) => (x === m ? 1 : 0)); })()
        : null;
      const hiWin = hi.map((x) => (x === Math.max(...hi) ? 1 : 0));
      const hc = hiWin.reduce((p: number, q: number) => p + q, 0);
      const lc = loWin ? loWin.reduce((p: number, q: number) => p + q, 0) : 0;
      a += loWin ? 50 * (hiWin[0]! / hc) + 50 * (loWin[0]! / lc) : 100 * (hiWin[0]! / hc);
    }
    expect(eq.mean[0]!).toBeCloseTo(a / pool.length, 9);
    expect(eq.mean[0]! + eq.mean[1]!).toBeCloseTo(100, 9);
    expect(eq.mean[0]!).toBeGreaterThan(20);
    expect(eq.mean[0]!).toBeLessThan(80);
  });

  it("handles side pots: only eligible players share each pot", () => {
    const hands = [{ id: "a", hole: cards("Ac Ad") }, { id: "b", hole: cards("Kh Ks") }, { id: "c", hole: cards("Qh Qs") }];
    const eq = runoutEquity("nlhe", cards("2c 7d 9h Ts"), hands, [
      { amount: 300, eligiblePlayerIds: ["a", "b", "c"] },
      { amount: 200, eligiblePlayerIds: ["b", "c"] },
    ]);
    expect(eq.mean[0]! + eq.mean[1]! + eq.mean[2]!).toBeCloseTo(500, 9);
    expect(eq.mean[0]!).toBeLessThanOrEqual(300);
  });

  it("matches what the engine paid in simulated all-in hands (expected and actual both sum to the contested pots)", () => {
    const r = rng(21);
    let allIns = 0;
    for (let h = 1; h <= 150; h++) {
      const { rec } = playHand("nlhe", IDS.slice(0, 3), h, shuffled(r), r);
      const hl = handLuck(rec);
      if (typeof hl === "string") throw new Error(hl);
      if (!hl.allIn) continue;
      allIns++;
      const exp = hl.allIn.expected.reduce((a, b) => a + b, 0);
      const act = hl.allIn.actual.reduce((a, b) => a + b, 0);
      expect(exp).toBeCloseTo(act, 6);
      for (const v of hl.allIn.variance) expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(allIns).toBeGreaterThan(10);
  });
});

// ------------------------------------------------------------- report

function simulate(count: number, variant: VariantId, seed: number, rig: boolean): LuckableHand[] {
  const r = rng(seed);
  const out: LuckableHand[] = [];
  for (let h = 1; h <= count; h++) {
    let deck = shuffled(r);
    const ids = IDS;
    const button = h % ids.length;
    if (rig) {
      // Whoever would win at a river showdown swaps hole cards with p0 (p0 is always dealt the best hand).
      const v = VARIANTS[variant];
      const n = ids.length;
      const order = Array.from({ length: n }, (_, k) => (button + 1 + k) % n); // seat indices in deal order
      const k0 = order.indexOf(0);
      const holes = order.map((_, k) => Array.from({ length: v.holeCards }, (_, rr) => deck[rr * n + k]!));
      const p = n * v.holeCards;
      const board = [deck[p + 1]!, deck[p + 2]!, deck[p + 3]!, deck[p + 5]!, deck[p + 7]!];
      const cr = bestHandCredits(variant, holes, board);
      const bk = cr.indexOf(Math.max(...cr));
      deck = [...deck];
      for (let rr = 0; rr < v.holeCards; rr++) [deck[rr * n + k0], deck[rr * n + bk]] = [deck[rr * n + bk]!, deck[rr * n + k0]!];
    }
    out.push(playHand(variant, ids, h, deck, r, button).rec);
  }
  return out;
}

describe("luck: the report", () => {
  it("a fair simulated run gives no unfair verdicts", () => {
    const hist = simulate(2500, "nlhe", 20240501, false);
    const rep = buildLuckReport(hist);
    expect(rep.hands).toBe(2500);
    expect(rep.players).toHaveLength(6);
    expect(rep.allInHands).toBeGreaterThan(100);
    for (const p of rep.players) {
      expect(p.bestVerdict).toBe("fair");
      expect(p.allInVerdict).toBe("fair");
      expect(p.verdict).toBe("fair");
      expect(p.handsDealt).toBe(2500);
      expect(p.expectedBest).toBeCloseTo(2500 / 6, 6);
    }
    expect(rep.table?.verdict).toBe("fair");
    expect(rep.overall?.verdict).toBe("fair");
    // Everybody's best-hand credits sum to the number of hands.
    expect(rep.players.reduce((t, p) => t + p.timesBest, 0)).toBeCloseTo(2500, 6);
    // All-in money is zero-sum per hand, so total expected equals total actual.
    expect(rep.players.reduce((t, p) => t + p.allInExpected, 0)).toBeCloseTo(rep.players.reduce((t, p) => t + p.allInActual, 0), 4);
  }, 120_000);

  it("flags a rigged table where one player is always dealt the best hand", () => {
    const hist = simulate(600, "nlhe", 99, true);
    const rep = buildLuckReport(hist);
    const p0 = rep.players.find((p) => p.playerId === "p0")!;
    expect(p0.timesBest).toBeGreaterThan(560);
    expect(p0.bestVerdict).toBe("investigate");
    expect(p0.bestZ!).toBeGreaterThan(10);
    expect(rep.table?.verdict).toBe("investigate");
    expect(rep.overall?.verdict).toBe("investigate");
    // Everyone else is, correspondingly, far below their share.
    for (const p of rep.players.filter((q) => q.playerId !== "p0")) expect(p.bestZ!).toBeLessThan(0);
  }, 120_000);

  it("says too few hands early and ignores unusable records", () => {
    const hist = simulate(12, "nlhe", 5, false);
    const rep = buildLuckReport([...hist, { ...hist[0]!, handNumber: 900, luck: undefined }, { ...hist[0]!, handNumber: 901, variant: "murder5" }, hist[0]!]);
    expect(rep.hands).toBe(12); // the duplicate is not counted twice
    expect(rep.skipped).toEqual({ stud: 1, old: 1, bad: 0 });
    expect(rep.overall).toBeNull();
    expect(rep.table).toBeNull();
    for (const p of rep.players) expect(p.verdict).toBe("too-few-hands");
  });

  it("works for Omaha hi/lo (a hi/lo table with side pots) without errors", () => {
    const rep = buildLuckReport(simulate(60, "plo4-8", 8, false));
    expect(rep.hands).toBe(60);
    expect(rep.players.reduce((t, p) => t + p.timesBest, 0)).toBeCloseTo(60, 6);
  }, 120_000);

  it("never exposes cards", () => {
    const rep = buildLuckReport(simulate(20, "nlhe", 4, false));
    expect(JSON.stringify(rep)).not.toMatch(/"[2-9TJQKA][shdc]"/);
  });
});
