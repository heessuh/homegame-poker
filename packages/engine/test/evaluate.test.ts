import { describe, expect, it } from "vitest";
import type { Card } from "../src/cards.js";
import { bestHigh, bestLow8, evaluate5 , bestLowAny } from "../src/evaluate.js";

const c = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];
const e = (s: string): number => evaluate5(c(s));
const H = (hole: string, board: string, omaha = false) => bestHigh(c(hole), c(board), omaha);
const L = (hole: string, board: string, omaha = false) => bestLow8(c(hole), c(board), omaha);

describe("evaluate5 categories and names", () => {
  const names: [string, string][] = [
    ["As Ks Qs Js Ts", "Royal Flush"],
    ["9h 8h 7h 6h 5h", "Straight Flush, Nine high"],
    ["Ac 2c 3c 4c 5c", "Straight Flush, Five high"],
    ["Ks Kh Kd Kc 2s", "Four of a Kind, Kings"],
    ["Ks Kh Kd Tc Ts", "Full House, Kings full of Tens"],
    ["As 9s 7s 4s 2s", "Flush, Ace high"],
    ["5s 4h 3d 2c Ah", "Straight, Five high"],
    ["Ts 9h 8d 7c 6h", "Straight, Ten high"],
    ["7s 7h 7d Kc 2s", "Three of a Kind, Sevens"],
    ["As Ah 4d 4c 9s", "Two Pair, Aces and Fours"],
    ["Js Jh 4d 6c 9s", "Pair of Jacks"],
    ["As Kh 4d 6c 9s", "High Card, Ace"],
  ];
  for (const [hand, name] of names) {
    it(`names ${name}`, () => {
      expect(bestHigh(c(hand), [], false).name).toBe(name);
    });
  }

  it("category ordering is strictly increasing", () => {
    const ladder = [
      "As Kh 4d 6c 9s", "Js Jh 4d 6c 9s", "As Ah 4d 4c 9s", "7s 7h 7d Kc 2s", "Ts 9h 8d 7c 6h",
      "As 9s 7s 4s 2s", "Ks Kh Kd Tc Ts", "Ks Kh Kd Kc 2s", "9h 8h 7h 6h 5h", "As Ks Qs Js Ts",
    ].map(e);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeGreaterThan(ladder[i - 1]!);
  });

  it("wheel is lower than six-high straight", () => {
    expect(e("5s 4h 3d 2c Ah")).toBeLessThan(e("6s 5h 4d 3c 2h"));
  });
  it("wheel beats trips and loses to broadway", () => {
    expect(e("5s 4h 3d 2c Ah")).toBeGreaterThan(e("Ks Kh Kd 3c 2s"));
    expect(e("5s 4h 3d 2c Ah")).toBeLessThan(e("As Kh Qd Jc Th"));
  });
  it("no wraparound straight", () => {
    expect(bestHigh(c("Qs Kh As 2d 3c"), [], false).name).toBe("High Card, Ace");
  });
  it("steel wheel loses to six-high straight flush", () => {
    expect(e("Ac 2c 3c 4c 5c")).toBeLessThan(e("2d 3d 4d 5d 6d"));
  });
  it("quads kicker and rank", () => {
    expect(e("9s 9h 9d 9c Ks")).toBeGreaterThan(e("9s 9h 9d 9c Qs"));
    expect(e("9s 9h 9d 9c As")).toBeLessThan(e("Ts Th Td Tc 2s"));
  });
  it("full house compares trips first, then pair", () => {
    expect(e("3s 3h 3d 2c 2s")).toBeGreaterThan(e("2s 2h 2d Ac As"));
    expect(e("5s 5h 5d 4c 4s")).toBeGreaterThan(e("5s 5h 5d 3c 3s"));
  });
  it("flush kickers all five count", () => {
    expect(e("As Ks 9s 5s 3s")).toBeGreaterThan(e("As Ks 9s 5s 2s"));
    expect(e("As Ks 9s 6s 2s")).toBeGreaterThan(e("As Ks 9s 5s 4s"));
  });
  it("trips kickers", () => {
    expect(e("7s 7h 7d Ac 2s")).toBeGreaterThan(e("7s 7h 7d Kc Qs"));
    expect(e("8s 8h 8d 3c 2s")).toBeGreaterThan(e("7s 7h 7d Ac Ks"));
  });
  it("two pair: high pair, low pair, kicker", () => {
    expect(e("Ks Kh 2d 2c 3s")).toBeGreaterThan(e("Qs Qh Jd Jc As"));
    expect(e("Ks Kh 3d 3c 2s")).toBeGreaterThan(e("Ks Kh 2d 2c As"));
    expect(e("Ks Kh 3d 3c As")).toBeGreaterThan(e("Ks Kh 3d 3c Qs"));
  });
  it("pair kickers", () => {
    expect(e("8s 8h Ad 3c 2s")).toBeGreaterThan(e("8s 8h Kd Qc Js"));
    expect(e("8s 8h Ad Kc 3s")).toBeGreaterThan(e("8s 8h Ad Kc 2s"));
  });
  it("high card kickers", () => {
    expect(e("As Kh Qd Jc 9s")).toBeGreaterThan(e("As Kh Qd Jc 8s"));
    expect(e("7s 5h 4d 3c 2s")).toBeLessThan(e("7s 6h 4d 3c 2s"));
  });
  it("same hand different suits ties exactly", () => {
    expect(e("As Kh Qd Jc 9s")).toBe(e("Ad Kc Qh Js 9d"));
    expect(e("Ks Kh 3d 3c As")).toBe(e("Kd Kc 3h 3s Ad"));
  });
  it("rejects non-5-card input", () => {
    expect(() => evaluate5(c("As Kh Qd"))).toThrow();
  });
  it("straight flush beats quads", () => {
    expect(e("6h 5h 4h 3h 2h")).toBeGreaterThan(e("As Ah Ad Ac Ks"));
  });
});

describe("bestHigh Hold'em", () => {
  it("picks best 5 of 7", () => {
    const r = H("As Ad", "Ah 2c 2d Kc 9s");
    expect(r.name).toBe("Full House, Aces full of Twos");
    expect(r.cards).toHaveLength(5);
  });
  it("board plays gives tie", () => {
    const board = "As Ks Qs Js Ts";
    expect(H("2c 3d", board).score).toBe(H("4c 5d", board).score);
    expect(H("2c 3d", board).name).toBe("Royal Flush");
  });
  it("works with 3 and 4 board cards", () => {
    expect(H("As Ad", "Ah Kc 2d").name).toBe("Three of a Kind, Aces");
    expect(H("As Ad", "Ah Kc 2d Ac").name).toBe("Four of a Kind, Aces");
  });
  it("kicker decides win vs split", () => {
    const board = "Ah 7c 7d 3s 2h";
    expect(H("Ks Qd", board).score).toBeGreaterThan(H("Js Td", board).score);
    expect(H("Ks 2d", board).score).toBe(H("Kd 2c", board).score);
  });
  it("finds the wheel in 7 cards", () => {
    expect(H("Ah 2d", "3c 4s 5h Kd Kc").name).toBe("Straight, Five high");
  });
  it("picks the higher of two straights", () => {
    expect(H("9h 8d", "7c 6s 5h 4d Kc").name).toBe("Straight, Nine high");
  });
  it("flush from 7 cards uses highest five", () => {
    const r = H("Ah 2h", "Kh 9h 5h 3h 3c");
    expect(r.name).toBe("Flush, Ace high");
    expect(r.cards).not.toContain("2h");
  });
  it("throws when fewer than five cards", () => {
    expect(() => H("As Ad", "Ah Kc")).toThrow();
  });
});

describe("bestHigh Omaha", () => {
  it("four hearts in hand plus one on board is not a flush", () => {
    expect(H("Ah Kh Qh Jh", "2h 7c 8d 3s 4c", true).name).not.toMatch(/Flush/);
  });
  it("two hearts in hand and three on board is a flush", () => {
    expect(H("Ah Kh 2c 3d", "7h 8h 9h Qc Qd", true).name).toBe("Flush, Ace high");
  });
  it("board flush cannot be played with one suited hole card", () => {
    expect(H("Ah 2c 3d 4s", "Kh Qh Jh 9h 5h", true).name).not.toMatch(/Flush/);
  });
  it("board quads are not playable", () => {
    expect(H("2c 3d 4s 5h", "9s 9h 9d 9c Kc", true).name).not.toMatch(/Four of a Kind/);
  });
  it("single ace in hand with AAA on board IS quads (1 hole + 3 board, plus a second hole card)", () => {
    expect(H("Ad Kc 7s 2h", "As Ah Ac 5d 9c", true).name).toBe("Four of a Kind, Aces");
  });
  it("two aces in hand with AA on board makes quads", () => {
    expect(H("Ad Ac 7s 2h", "As Ah 5d 9c Kc", true).name).toBe("Four of a Kind, Aces");
  });
  it("board straight cannot be played", () => {
    expect(H("Ac Ad 2s 2h", "5s 6d 7c 8h 9s", true).name).not.toMatch(/Straight/);
  });
  it("straight needs exactly two hole cards", () => {
    expect(H("9s 8d Kc Kh", "7c 6s 5h 2d 2c", true).name).toBe("Straight, Nine high");
    expect(H("9s 2h Kc Kh", "8c 7c 6s 5h 3d", true).name).not.toMatch(/Straight/);
  });
  it("5-card Omaha considers all 2-card hole combos", () => {
    expect(H("Ah Kh 2c 3d 4s", "Qh Jh Th 9c 8d", true).name).toBe("Royal Flush");
  });
  it("5-card Omaha with full 5-card board", () => {
    expect(H("As Ad Kc Kd 2h", "Ah Kh 7s 7d 2c", true).name).toBe("Full House, Aces full of Sevens");
  });
  it("Omaha with 3 board cards only", () => {
    expect(H("As Ad 2c 3d", "Ah 9c 9d", true).name).toBe("Full House, Aces full of Nines");
  });
  it("Omaha full house from hole pair and board", () => {
    expect(H("Ks Kd 2c 3d", "Kh 5s 5d 9c 9h", true).name).toBe("Full House, Kings full of Nines");
  });
  it("Omaha equal hands with different suits tie", () => {
    expect(H("Ks Qd 2c 3d", "Ah 9c 9d 4s 5h", true).score).toBe(
      H("Kc Qh 2s 3h", "Ah 9c 9d 4s 5h", true).score,
    );
  });
});

describe("bestLow8 Hold'em", () => {
  it("wheel is the best low", () => {
    expect(L("Ah 2d", "3c 4s 5h Kd Kc")?.name).toBe("5-4-3-2-A");
  });
  it("straights and flushes do not hurt a low", () => {
    expect(L("Ah 2h", "3h 4h 5h Kd Kc")?.name).toBe("5-4-3-2-A");
  });
  it("no low when only four distinct low ranks", () => {
    expect(L("Ah 2d", "3c 3s Kh Kd Qc")).toBeNull();
  });
  it("no low with a nine in the way", () => {
    expect(L("Ah 2d", "3c 4s 9h Kd Kc")).toBeNull();
  });
  it("picks best five of seven", () => {
    expect(L("8h 7d", "6c 4s 2h Ad 3c")?.name).toBe("6-4-3-2-A");
  });
  it("name is highest card first", () => {
    expect(L("8h 6d", "4c 2s Ah Kd Kc")?.name).toBe("8-6-4-2-A");
  });
  it("pairs in the hand are skipped for distinct ranks", () => {
    expect(L("8h 8d", "6c 4s 2h Ad Kc")?.name).toBe("8-6-4-2-A");
  });
  it("lower low scores lower", () => {
    const a = L("7h 6d", "5c 4s 3h Kd Kc")!;
    const b = L("8h 5d", "4c 3s 2h Kd Kc")!;
    expect(a.score).toBeLessThan(b.score);
  });
  it("8-5-4-3-2 beats 8-6-3-2-A", () => {
    const a = L("8h 5d", "4c 3s 2h Kd Kc")!;
    const b = L("8h 6d", "3c 2s Ah Kd Kc")!;
    expect(a.score).toBeLessThan(b.score);
  });
  it("7-high beats 8-high", () => {
    const a = L("7h 6d", "5c 4s 3h Kd Kc")!;
    const b = L("8h 4d", "3c 2s Ah Kd Kc")!;
    expect(a.score).toBeLessThan(b.score);
  });
  it("equal lows tie across suits", () => {
    const a = L("Ah 2d", "3c 4s 6h Kd Kc")!;
    const b = L("Ac 2s", "3c 4s 6h Kd Kc")!;
    expect(a.score).toBe(b.score);
  });
  it("counterfeited low", () => {
    expect(L("Ah 2d", "2c 3s 4h 8d Kc")?.name).toBe("8-4-3-2-A");
    expect(L("Ah 2d", "Ac 2s 3h Kd Qc")).toBeNull();
  });
});

describe("bestLow8 Omaha", () => {
  it("needs exactly two hole cards", () => {
    expect(L("Ah Kd Qc Js", "2c 3s 4h 5d 6c", true)).toBeNull();
  });
  it("two low hole cards and three low board cards", () => {
    expect(L("Ah 2d Kc Qs", "3c 4s 6h Kd Kh", true)?.name).toBe("6-4-3-2-A");
  });
  it("no low if board has fewer than three distinct qualifying ranks", () => {
    expect(L("Ah 2d 3c 4s", "5c Kd Qh Jc Jd", true)).toBeNull();
    expect(L("Ah 2d 3c 4s", "5c 5d Qh Jc Jd", true)).toBeNull();
  });
  it("board with three distinct lows is enough", () => {
    expect(L("Ah 2d Kc Qs", "5c 6d 7h Kd Kh", true)?.name).toBe("7-6-5-2-A");
  });
  it("pair in hand still yields a low with other hole cards", () => {
    expect(L("Ah Ad 2c Ks", "3c 4s 6h Kd Kh", true)?.name).toBe("6-4-3-2-A");
  });
  it("counterfeiting: board duplicates a hole low", () => {
    expect(L("Ah 2d Kc Qs", "2c 3s 8h Kd Kh", true)).toBeNull();
    expect(L("Ah 2d Kc Qs", "2c 3s 4h 5d 8c", true)?.name).toBe("5-4-3-2-A");
  });
  it("5-card Omaha finds the best low from hole pairs", () => {
    expect(L("Ah 2d 3c Ks Qd", "4s 5h 8d Jc Jd", true)?.name).toBe("8-5-4-2-A");
  });
  it("5-card Omaha picks the lowest combo", () => {
    expect(L("Ah 7d 8c Ks Qd", "2s 3h 4d Jc Jd", true)?.name).toBe("7-4-3-2-A");
  });
});

describe("bestLowAny (no qualifier, ace-to-five)", () => {
  const low = (hole: string[], board: string[]) => bestLowAny(hole as never, board as never, false)!;
  it("ignores straights and flushes", () => {
    expect(low(["Ah", "2h"], ["3h", "4h", "5h", "Kc", "Kd"]).name).toBe("5-4-3-2-A");
  });
  it("plays high cards when it must, with no 8 qualifier", () => {
    expect(low(["Kh", "Qd"], ["Jc", "9s", "Th", "Kc", "Qs"]).name).toBe("K-Q-J-T-9");
  });
  it("ranks any no-pair hand below any pair", () => {
    const noPair = low(["Kh", "Qd"], ["Jc", "9s", "Th", "2c", "2d"]);
    const pair = low(["2h", "3d"], ["2c", "3s", "4h", "3c", "2s"]);
    expect(noPair.score).toBeLessThan(pair.score);
  });
  it("compares pairs by the pair first, then kickers", () => {
    const a = low(["2h", "2d"], ["9c", "8s", "7h", "9d", "8d"]); // pair of 2s: 9-8-7-2-2
    const b = low(["3h", "3d"], ["4c", "5s", "6h", "3c", "4d"]); // pair of 3s: 6-5-4-3-3
    expect(a.score).toBeLessThan(b.score);
  });
  it("uses the Omaha 2+3 rule when asked", () => {
    const r = bestLowAny(["Ah", "2d", "Kc", "Kd"] as never, ["3c", "4s", "5h", "Qd", "Js"] as never, true)!;
    expect(r.name).toBe("5-4-3-2-A");
  });
});
