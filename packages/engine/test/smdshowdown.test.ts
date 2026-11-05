import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { VARIANTS, type VariantId } from "../src/variants.js";
import type { PlayerAction } from "../src/protocol.js";
import { applyAction, legalActions, startHand, type HandState } from "../src/game.js";

// ---------- helpers (same rigging as game.test.ts) ----------

const CHECK: PlayerAction = { type: "check" };
const CALL: PlayerAction = { type: "call" };
const FOLD: PlayerAction = { type: "fold" };

function dealOrder(seats: number[], button: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const i = sorted.indexOf(button);
  return [...sorted.slice(i + 1), ...sorted.slice(0, i + 1)];
}

interface RigOpts {
  variant: VariantId;
  stacks: Record<number, number>;
  button: number;
  holes: Record<number, Card[]>;
  board: Card[];
  sb?: number;
  bb?: number;
}

function rig(o: RigOpts) {
  const hc = VARIANTS[o.variant].holeCards;
  const seats = Object.keys(o.stacks).map(Number);
  const order = dealOrder(seats, o.button);
  const used = new Set<Card>([...o.board, ...Object.values(o.holes).flat()]);
  const pool = freshDeck().filter((c) => !used.has(c));
  const holes: Record<number, Card[]> = {};
  for (const seat of order) holes[seat] = o.holes[seat] ?? pool.splice(0, hc);
  const dealt: Card[] = [];
  for (let r = 0; r < hc; r++) for (const seat of order) dealt.push((holes[seat] as Card[])[r] as Card);
  const burns = pool.splice(0, 3) as Card[];
  const board = o.board;
  const deck = [...dealt, burns[0]!, ...board.slice(0, 3), burns[1]!, board[3]!, burns[2]!, board[4]!, ...pool];
  return { deck };
}

function newHand(o: RigOpts): HandState {
  const { deck } = rig(o);
  return startHand({
    handNumber: 1,
    variant: o.variant,
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
const limp3 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CALL], [3, CHECK]]));
const limp2 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CHECK]]));

// Board used by the first cases: the wheel for p1 uses three hole cards; p2 makes a queen-high straight.
const BOARD = cards("4h 5s Qd Jc 9c");

describe("SMD showdown", () => {
  it("a low made with three hole cards wins the low half; a queen-high straight wins the high half", () => {
    // p1 As 2c 3d (three hole cards) + 4h 5s = 5-4-3-2-A. p2 Th 8c + Jc 9c Qd = queen-high straight.
    const holes = { 1: cards("As 2c 3d Kh"), 2: cards("Th 8c 6d 7s") };
    const out = done(limp2(newHand({ variant: "smd4", stacks: { 1: 100, 2: 100 }, button: 1, holes, board: BOARD })));
    expect(out.winners).toEqual([
      { playerId: "p2", amount: 2, potIndex: 0, half: "high", handName: "Straight, Queen high" },
      { playerId: "p1", amount: 2, potIndex: 0, half: "low", handName: "5-4-3-2-A" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100 });
  });

  it("high/low split with the odd chip going to the high half", () => {
    // Blinds 1 and 3, three players: pot 9. p2 takes the high half (5), p1 the low half (4).
    const holes = { 1: cards("As 2c 3d Kh"), 2: cards("Th 8c 6d 7s"), 3: cards("2s 7h 8d Ks") };
    const out = done(limp3(newHand({ variant: "smd4", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: BOARD, sb: 1, bb: 3 })));
    expect(out.winners).toEqual([
      { playerId: "p2", amount: 5, potIndex: 0, half: "high", handName: "Straight, Queen high" },
      { playerId: "p1", amount: 4, potIndex: 0, half: "low", handName: "5-4-3-2-A" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 101, p2: 102, p3: 97 });
  });

  it("no qualifier: a king-high low wins the low half", () => {
    // Board Kh Qd Jc 9s 9h. p1 Js 7d 7s Kc makes K-Q-J-9-7 (no pair). p2 Jd Jh Qh Kd is stuck with a pair of nines
    // in the low, so p1's king-high low wins it. p2's full house wins the high half.
    const holes = { 1: cards("Js 7d 7s Kc"), 2: cards("Jd Jh Qh Kd") };
    const out = done(limp2(newHand({ variant: "smd4", stacks: { 1: 100, 2: 100 }, button: 1, holes, board: cards("Kh Qd Jc 9s 9h") })));
    expect(out.winners).toEqual([
      { playerId: "p2", amount: 2, potIndex: 0, half: "high", handName: "Full House, Jacks full of Kings" },
      { playerId: "p1", amount: 2, potIndex: 0, half: "low", handName: "K-Q-J-9-7" },
    ]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100 });
  });

  it("5-card SMD: five hole cards, the low still uses three of them", () => {
    const holes = { 1: cards("As 2c 3d Kh 9h"), 2: cards("Th 8c 6d 7s 2h") };
    const s = newHand({ variant: "smd5", stacks: { 1: 100, 2: 100 }, button: 1, holes, board: BOARD });
    expect(player(s, 1).holeCards).toHaveLength(5);
    const out = done(limp2(s));
    expect(out.winners).toEqual([
      { playerId: "p2", amount: 2, potIndex: 0, half: "high", handName: "Straight, Queen high" },
      { playerId: "p1", amount: 2, potIndex: 0, half: "low", handName: "5-4-3-2-A" },
    ]);
  });
});
