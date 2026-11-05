import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { VARIANTS, type VariantId } from "../src/variants.js";
import type { PlayerAction } from "../src/protocol.js";
import { applyAction, legalActions, startHand, type HandState } from "../src/game.js";

// ---------- helpers (same rigging as game.test.ts) ----------

const CHECK: PlayerAction = { type: "check" };
const CALL: PlayerAction = { type: "call" };
const FOLD: PlayerAction = { type: "fold" };
const raise = (amount: number): PlayerAction => ({ type: "raise", amount });

function dealOrder(seats: number[], button: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const i = sorted.indexOf(button);
  return [...sorted.slice(i + 1), ...sorted.slice(0, i + 1)];
}

interface RigOpts {
  variant?: VariantId;
  stacks: Record<number, number>;
  button: number;
  holes?: Record<number, Card[]>;
  board?: Card[];
  sb?: number;
  bb?: number;
}

function rig(o: RigOpts) {
  const variant = o.variant ?? "tko4";
  const hc = VARIANTS[variant].holeCards;
  const seats = Object.keys(o.stacks).map(Number);
  const order = dealOrder(seats, o.button);
  const used = new Set<Card>([...(o.board ?? []), ...Object.values(o.holes ?? {}).flat()]);
  const pool = freshDeck().filter((c) => !used.has(c));
  const holes: Record<number, Card[]> = {};
  for (const seat of order) holes[seat] = o.holes?.[seat] ?? pool.splice(0, hc);
  const dealt: Card[] = [];
  for (let r = 0; r < hc; r++) for (const seat of order) dealt.push((holes[seat] as Card[])[r] as Card);
  const burns = pool.splice(0, 3) as Card[];
  const board = o.board ?? (pool.splice(0, 5) as Card[]);
  const deck = [...dealt, burns[0]!, ...board.slice(0, 3), burns[1]!, board[3]!, burns[2]!, board[4]!, ...pool];
  return { deck, burns, board, holes };
}

function newHand(o: RigOpts): HandState {
  const { deck } = rig(o);
  return startHand({
    handNumber: 1,
    variant: o.variant ?? "tko4",
    seats: Object.entries(o.stacks).map(([seat, stack]) => ({ seat: Number(seat), playerId: `p${seat}`, stack })),
    buttonSeat: o.button,
    smallBlind: o.sb ?? 1,
    bigBlind: o.bb ?? 2,
    deck,
  });
}

const cards = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];
const act = (s: HandState, seat: number, a: PlayerAction) => applyAction(s, `p${seat}`, a);
function seq(s: HandState, steps: Array<[number, PlayerAction]>): HandState {
  for (const [seat, a] of steps) s = act(s, seat, a);
  return s;
}
function checkdown(s: HandState): HandState {
  while (!s.outcome) s = act(s, s.toActSeat as number, CHECK);
  return s;
}
function done(s: HandState) {
  expect(s.phase).toBe("complete");
  expect(s.outcome).not.toBeNull();
  const out = s.outcome!;
  const sum = Object.values(out.finalStacks).reduce((a, b) => a + b, 0);
  expect(sum).toBe(s.startingTotal);
  return out;
}
const player = (s: HandState, seat: number) => s.players.find((p) => p.seat === seat)!;
const legal = (s: HandState, seat: number) => legalActions(s, `p${seat}`);
const limp3 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CALL], [3, CHECK]]));
const limp2 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CHECK]]));

// Board used by most cases: points 2 + 5 + 8 + 10 + 9.
const BOARD = cards("2c 5d 8h Kd 9s");
// Points (high / low): A_HI 42 / 22 (two aces, Q, J); LO 20 / 20 (3 4 6 7); T40 40 / 40 (T T Q Q).
const A_HI = "Ac Ad Qc Jc";
const LO = "3c 4c 6c 7c";
const T40 = "Th Tc Qh Qd";

describe("TKO showdown: halves", () => {
  it("a simple high winner and low winner split the pot", () => {
    const holes = { 1: cards(A_HI), 2: cards(LO), 3: cards(T40) };
    const out = done(limp3(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners).toEqual([
      { playerId: "p1", amount: 3, potIndex: 0, half: "high", handName: "42 points" },
      { playerId: "p2", amount: 3, potIndex: 0, half: "low", handName: "20 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 101, p2: 101, p3: 98 });
  });

  it("a matching board card knocks hole cards out and changes who wins the low half", () => {
    // Kh and Kc are both out on the Kd, leaving 3s 4s (7 points). Counted naively, p1 would total 27 and p3 (11 low) would take the low half.
    const holes = { 1: cards("Kh Kc 3s 4s"), 2: cards("Qs Jd 6c 7h"), 3: cards("Ad Ac 3d 6h") };
    const out = done(limp3(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners).toEqual([
      { playerId: "p2", amount: 3, potIndex: 0, half: "high", handName: "33 points" },
      { playerId: "p1", amount: 3, potIndex: 0, half: "low", handName: "7 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 101, p2: 101, p3: 98 });
  });

  it("a player with no cards left wins the whole pot", () => {
    // 2s 5s 8s Kc: every card matches the board, so nothing is left.
    const holes = { 1: cards("2s 5s 8s Kc"), 2: cards("3h 4h 6d 7d"), 3: cards("Ah Ad 3c 4c") };
    const out = done(limp3(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners).toEqual([{ playerId: "p1", amount: 6, potIndex: 0, half: "whole", handName: "No cards left" }]);
    expect(out.finalStacks).toEqual({ p1: 104, p2: 98, p3: 98 });
  });

  it("two players with no cards left split the pot", () => {
    const holes = { 1: cards("2s 5s 8s Kc"), 2: cards("9c 9h Ks Kh"), 3: cards("3h 4h 6d 7d") };
    const out = done(limp3(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners.map((w) => [w.playerId, w.amount, w.half, w.handName]).sort()).toEqual([
      ["p1", 3, "whole", "No cards left"],
      ["p2", 3, "whole", "No cards left"],
    ]);
    expect(out.finalStacks).toEqual({ p1: 101, p2: 101, p3: 98 });
  });

  it("a tie for most points splits the high half", () => {
    // p1 and p3 both make 42 high. p2 has the fewest low points (20). Pot 8.
    const holes = { 1: cards(A_HI), 2: cards(LO), 3: cards("As Ah Qd Jd"), 4: cards("Th Tc Qh Qs") };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100, 4: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 });
    s = checkdown(seq(s, [[4, CALL], [1, CALL], [2, CALL], [3, CHECK]]));
    const out = done(s);
    expect(out.winners.filter((w) => w.half === "high").map((w) => [w.playerId, w.amount]).sort()).toEqual([["p1", 2], ["p3", 2]]);
    expect(out.winners.filter((w) => w.half === "low")).toEqual([{ playerId: "p2", amount: 4, potIndex: 0, half: "low", handName: "20 points" }]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 102, p3: 100, p4: 98 });
  });

  it("the odd chip goes to the high half", () => {
    // Blinds 1 and 3 with three players in: pot 9 = 5 high + 4 low.
    const holes = { 1: cards(A_HI), 2: cards(LO), 3: cards(T40) };
    const out = done(limp3(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 3 })));
    expect(out.winners).toEqual([
      { playerId: "p1", amount: 5, potIndex: 0, half: "high", handName: "42 points" },
      { playerId: "p2", amount: 4, potIndex: 0, half: "low", handName: "20 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 102, p2: 101, p3: 97 });
  });

  it("a folded player never wins, even with the best hand", () => {
    // p1 holds the best high and low but folds before the flop.
    const holes = { 1: cards(A_HI), 2: cards(LO), 3: cards(T40) };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 });
    s = checkdown(seq(s, [[1, FOLD], [2, CALL], [3, CHECK]]));
    const out = done(s);
    expect(out.winners.some((w) => w.playerId === "p1")).toBe(false);
    expect(out.winners).toEqual([
      { playerId: "p3", amount: 2, potIndex: 0, half: "high", handName: "40 points" },
      { playerId: "p2", amount: 2, potIndex: 0, half: "low", handName: "20 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100, p3: 100 });
  });

  it("heads-up, the two players take one half each", () => {
    const holes = { 1: cards(A_HI), 2: cards(LO) };
    const out = done(limp2(newHand({ stacks: { 1: 100, 2: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners).toEqual([
      { playerId: "p1", amount: 2, potIndex: 0, half: "high", handName: "42 points" },
      { playerId: "p2", amount: 2, potIndex: 0, half: "low", handName: "20 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100 });
  });

  it("a player who has both the most and the fewest points takes the whole pot", () => {
    // p1 folds. Among p2 and p3, p3 has the most (29) and the fewest (9) points, so one whole-pot entry.
    const holes = { 1: cards(A_HI), 2: cards(LO), 3: cards("Ah Ad 3c 4c") };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 });
    s = checkdown(seq(s, [[1, FOLD], [2, CALL], [3, CHECK]]));
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p3", amount: 4, potIndex: 0, half: "whole", handName: "29 points" }]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 98, p3: 102 });
  });
});

describe("TKO showdown: side pots", () => {
  it("a short all-in makes a side pot decided only among the players in it", () => {
    // p3 is all in for 4 with the fewest points (9), but is not eligible for the side pot, so p2 takes that pot's low half.
    const holes = { 1: cards("Qc Qd Jc Th"), 2: cards("3h 6c 7d 6s"), 3: cards("Ah Ad 3c 4c") };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 4 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 });
    s = checkdown(seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]));
    const out = done(s);
    expect(out.winners).toEqual([
      { playerId: "p1", amount: 6, potIndex: 0, half: "high", handName: "40 points" },
      { playerId: "p3", amount: 6, potIndex: 0, half: "low", handName: "9 points" },
      { playerId: "p1", amount: 2, potIndex: 1, half: "high", handName: "40 points" },
      { playerId: "p2", amount: 2, potIndex: 1, half: "low", handName: "22 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 102, p2: 96, p3: 6 });
  });

  it("a side pot with one eligible player goes to that player", () => {
    // p1 raises to 6 and folds to p2's raise to 8. p2 is alone in the top pot.
    const holes = { 1: cards("Qc Qd Jc Th"), 2: cards("3h 6c 7d 6s"), 3: cards("Ah Ad 3c 4c") };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 4 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 });
    s = seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]);
    s = seq(s, [[2, raise(8)], [1, FOLD]]);
    const out = done(checkdown(s));
    expect(out.winners).toEqual([
      { playerId: "p3", amount: 12, potIndex: 0, half: "whole", handName: "29 points" },
      { playerId: "p2", amount: 4, potIndex: 1, half: "whole", handName: "22 points" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 94, p2: 98, p3: 12 });
  });
});

describe("TKO hole cards", () => {
  it("deals four hole cards in tko4 and five in tko5", () => {
    const s4 = newHand({ variant: "tko4", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(player(s4, 1).holeCards).toHaveLength(4);
    expect(player(s4, 3).holeCards).toHaveLength(4);
    const s5 = newHand({ variant: "tko5", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(player(s5, 1).holeCards).toHaveLength(5);
    expect(player(s5, 3).holeCards).toHaveLength(5);
  });

  it("tko5 showdown scores five hole cards", () => {
    // p1: 45 high / 25 low (the 3s counts). p2: 30 / 30. p3: 44 / 44 (the 4h counts).
    const holes = { 1: cards("Ac Ad Qc Jc 3s"), 2: cards("3c 4c 6c 7c Td"), 3: cards("Th Tc Qh Qd 4h") };
    const out = done(limp3(newHand({ variant: "tko5", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 2 })));
    expect(out.winners).toEqual([{ playerId: "p1", amount: 6, potIndex: 0, half: "whole", handName: "45 points" }]);
    expect(out.finalStacks).toEqual({ p1: 104, p2: 98, p3: 98 });
  });
});
