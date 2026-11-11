import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { VARIANTS, type VariantId } from "../src/variants.js";
import type { PlayerAction } from "../src/protocol.js";
import { applyAction, legalActions, potsView, startHand, timeoutAction, type HandState } from "../src/game.js";

// ---------- helpers ----------

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
  const variant = o.variant ?? "nlhe";
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
    variant: o.variant ?? "nlhe",
    seats: Object.entries(o.stacks).map(([seat, stack]) => ({ seat: Number(seat), playerId: `p${seat}`, stack })),
    buttonSeat: o.button,
    smallBlind: o.sb ?? 1,
    bigBlind: o.bb ?? 2,
    deck,
  });
}

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

// ---------- positions & blinds ----------

describe("positions and blinds", () => {
  it("heads-up: button posts SB and acts first preflop; BB acts first postflop", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1 });
    expect(player(s, 1).bet).toBe(1);
    expect(player(s, 2).bet).toBe(2);
    expect(s.toActSeat).toBe(1);
    s = act(s, 1, CALL);
    expect(s.toActSeat).toBe(2); // BB option
    expect(legal(s, 2)!.canCheck).toBe(true);
    s = act(s, 2, CHECK);
    expect(s.phase).toBe("flop");
    expect(s.toActSeat).toBe(2);
  });

  it("heads-up with the button on the other seat", () => {
    let s = newHand({ stacks: { 4: 100, 9: 100 }, button: 9 });
    expect(player(s, 9).bet).toBe(1);
    expect(player(s, 4).bet).toBe(2);
    expect(s.toActSeat).toBe(9);
    s = seq(s, [[9, CALL], [4, CHECK]]);
    expect(s.toActSeat).toBe(4);
  });

  it("heads-up deals the first hole card to the BB (left of button)", () => {
    const r = rig({ stacks: { 1: 100, 2: 100 }, button: 1, holes: { 1: ["As", "Ks"], 2: ["Qs", "Js"] } });
    expect(r.deck.slice(0, 4)).toEqual(["Qs", "As", "Js", "Ks"]);
    const s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1, holes: { 1: ["As", "Ks"], 2: ["Qs", "Js"] } });
    expect(player(s, 1).holeCards).toEqual(["As", "Ks"]);
    expect(player(s, 2).holeCards).toEqual(["Qs", "Js"]);
  });

  it("3-handed: button acts first preflop, SB then BB", () => {
    const s = newHand({ stacks: { 2: 100, 5: 100, 7: 100 }, button: 2 });
    expect(player(s, 5).bet).toBe(1);
    expect(player(s, 7).bet).toBe(2);
    expect(s.toActSeat).toBe(2);
  });

  it("3-handed: blinds wrap around the end of the table", () => {
    const s = newHand({ stacks: { 2: 100, 5: 100, 7: 100 }, button: 7 });
    expect(player(s, 2).bet).toBe(1);
    expect(player(s, 5).bet).toBe(2);
    expect(s.toActSeat).toBe(7);
  });

  it("6-handed with non-contiguous seats: UTG is left of BB", () => {
    const stacks = { 1: 100, 3: 100, 4: 100, 6: 100, 8: 100, 9: 100 };
    let s = newHand({ stacks, button: 4 });
    expect(player(s, 6).bet).toBe(1);
    expect(player(s, 8).bet).toBe(2);
    expect(s.toActSeat).toBe(9);
    s = seq(s, [[9, CALL], [1, CALL], [3, CALL], [4, CALL], [6, CALL]]);
    expect(s.toActSeat).toBe(8); // BB option
    s = act(s, 8, CHECK);
    expect(s.phase).toBe("flop");
    expect(s.toActSeat).toBe(6); // first active left of button
    s = newHand({ stacks, button: 9 });
    expect(player(s, 1).bet).toBe(1);
    expect(player(s, 3).bet).toBe(2);
    expect(s.toActSeat).toBe(4);
  });

  it("postflop action starts at the first active player left of the button", () => {
    // seat 6 (SB) folds preflop; flop starts at seat 8
    let s = newHand({ stacks: { 1: 100, 3: 100, 4: 100, 6: 100, 8: 100 }, button: 4 });
    s = seq(s, [[1, CALL], [3, CALL], [4, CALL], [6, FOLD], [8, CHECK]]);
    expect(s.phase).toBe("flop");
    expect(s.toActSeat).toBe(8);
  });

  it("a player who cannot cover the BB posts what they have and is all-in", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 1 }, button: 1 });
    const bb = player(s, 3);
    expect(bb.bet).toBe(1);
    expect(bb.stack).toBe(0);
    expect(bb.allIn).toBe(true);
    expect(legal(s, 1)!.callAmount).toBe(2); // must still call the full BB
    s = seq(s, [[1, CALL], [2, CALL]]);
    expect(s.phase).toBe("flop"); // BB has no option; it is all-in
    expect(potsView(s)).toEqual([
      { amount: 3, eligiblePlayerIds: ["p1", "p2", "p3"] },
      { amount: 2, eligiblePlayerIds: ["p1", "p2"] },
    ]);
    done(checkdown(s));
  });

  it("a short SB posts all-in", () => {
    const s = newHand({ stacks: { 1: 100, 2: 1, 3: 100 }, button: 1 });
    expect(player(s, 2).bet).toBe(1);
    expect(player(s, 2).allIn).toBe(true);
  });

  it("rejects bad input", () => {
    const base = { handNumber: 1, variant: "nlhe" as const, smallBlind: 1, bigBlind: 2, deck: freshDeck() };
    expect(() => startHand({ ...base, seats: [{ seat: 1, playerId: "a", stack: 10 }], buttonSeat: 1 })).toThrow();
    expect(() =>
      startHand({ ...base, seats: [{ seat: 1, playerId: "a", stack: 10 }, { seat: 2, playerId: "b", stack: 10 }], buttonSeat: 5 }),
    ).toThrow(/button/);
  });
});

// ---------- dealing ----------

describe("dealing", () => {
  it("deals hole cards round-robin starting left of the button, burns before each street", () => {
    const stacks = { 1: 100, 2: 100, 3: 100 };
    const holes = { 2: ["Ah", "Kh"] as Card[], 3: ["Ad", "Kd"] as Card[], 1: ["Ac", "Kc"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    const r = rig({ stacks, button: 1, holes, board });
    // order: seat 2, 3, 1 -> first card each, then second card each
    expect(r.deck.slice(0, 6)).toEqual(["Ah", "Ad", "Ac", "Kh", "Kd", "Kc"]);
    let s = newHand({ stacks, button: 1, holes, board });
    expect(player(s, 2).holeCards).toEqual(["Ah", "Kh"]);
    expect(s.deck.length).toBe(46);
    s = seq(s, [[1, CALL], [2, CALL], [3, CHECK]]);
    expect(s.board).toEqual(board.slice(0, 3));
    expect(s.burned).toEqual([r.burns[0]]);
    s = seq(s, [[2, CHECK], [3, CHECK], [1, CHECK]]);
    expect(s.board).toEqual(board.slice(0, 4));
    expect(s.burned).toEqual([r.burns[0], r.burns[1]]);
    s = seq(s, [[2, CHECK], [3, CHECK], [1, CHECK]]);
    expect(s.board).toEqual(board);
    expect(s.burned).toEqual(r.burns);
    expect(s.burned.some((b) => s.board.includes(b))).toBe(false);
  });

  it("deals 4 cards for Omaha and 5 for 5-card Omaha, one at a time", () => {
    const holes = { 2: ["Ah", "Kh", "Qh", "Jh"] as Card[], 1: ["Ac", "Kc", "Qc", "Jc"] as Card[] };
    const s = newHand({ variant: "plo4", stacks: { 1: 100, 2: 100 }, button: 1, holes });
    expect(player(s, 2).holeCards).toEqual(["Ah", "Kh", "Qh", "Jh"]);
    expect(player(s, 1).holeCards).toEqual(["Ac", "Kc", "Qc", "Jc"]);
    expect(s.deck.length).toBe(44);
    const s5 = newHand({ variant: "plo5", stacks: { 1: 100, 2: 100, 3: 100 }, button: 3 });
    for (const p of s5.players) expect(p.holeCards.length).toBe(5);
    expect(s5.deck.length).toBe(37);
  });

  it("is deterministic given the deck and does not mutate its input state", () => {
    const o: RigOpts = { stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 };
    const a = newHand(o);
    const b = newHand(o);
    expect(a).toEqual(b);
    const before = JSON.stringify(a);
    const next = act(a, 1, raise(6));
    expect(JSON.stringify(a)).toBe(before);
    expect(next).not.toBe(a);
    expect(act(a, 1, raise(6))).toEqual(next);
  });
});

// ---------- raise math ----------

describe("min raise and re-raise", () => {
  const stacks = { 1: 100, 2: 100, 3: 100 }; // button 1: SB 2, BB 3, UTG 1

  it("preflop min raise is BB + BB", () => {
    const s = newHand({ stacks, button: 1 });
    const l = legal(s, 1)!;
    expect(l).toEqual({ canFold: true, canCheck: false, callAmount: 2, minRaiseTo: 4, maxRaiseTo: 100 });
    expect(() => act(s, 1, raise(3))).toThrow(/below the minimum/);
    expect(act(s, 1, raise(4)).currentBet).toBe(4);
  });

  it("a re-raise must be at least the size of the last raise", () => {
    let s = newHand({ stacks, button: 1 });
    s = act(s, 1, raise(4));
    expect(legal(s, 2)!.minRaiseTo).toBe(6);
    s = act(s, 2, raise(10)); // raise of 6
    expect(legal(s, 3)!.minRaiseTo).toBe(16);
    expect(() => act(s, 3, raise(15))).toThrow(/below the minimum/);
    s = act(s, 3, raise(16));
    expect(legal(s, 1)!.minRaiseTo).toBe(22);
    expect(legal(s, 1)!.callAmount).toBe(12);
  });

  it("postflop min bet is the BB and the last-raise size resets each street", () => {
    let s = newHand({ stacks, button: 1 });
    s = seq(s, [[1, raise(10)], [2, CALL], [3, CALL]]);
    expect(s.phase).toBe("flop");
    expect(legal(s, 2)!.minRaiseTo).toBe(2);
    expect(() => act(s, 2, raise(1))).toThrow();
    s = act(s, 2, raise(5));
    expect(legal(s, 3)!.minRaiseTo).toBe(10);
    expect(legal(s, 3)!.callAmount).toBe(5);
  });

  it("min raise is capped at all-in when the stack cannot reach it", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = act(s, 1, raise(50));
    const s2 = newHand({ stacks: { 1: 100, 2: 100, 3: 52 }, button: 1 });
    const l = legal(act(s2, 1, raise(50)), 2)!;
    expect(l.minRaiseTo).toBe(98);
    expect(s.currentBet).toBe(50);
  });

  it("a short stack facing a raise can only call all-in or fold (no raise)", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 20 }, button: 1 });
    s = seq(s, [[1, raise(20)], [2, FOLD]]);
    const l = legal(s, 3)!;
    expect(l.callAmount).toBe(18);
    expect(l.minRaiseTo).toBeNull();
  });
});

describe("incomplete all-in raises", () => {
  // After a limped preflop pot of 6 (stacks 98/98/p3), flop action: p2, p3, p1.
  function flopWith(p3stack: number): HandState {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: p3stack }, button: 1 });
    s = seq(s, [[1, CALL], [2, CALL], [3, CHECK]]);
    expect(s.phase).toBe("flop");
    return s;
  }

  it("does not reopen betting for players who already acted", () => {
    let s = flopWith(17); // p3 has 15 left
    s = act(s, 2, raise(10));
    s = act(s, 3, raise(15)); // all-in, raise of only 5 < 10
    expect(player(s, 3).allIn).toBe(true);
    expect(legal(s, 1)!.minRaiseTo).toBe(25); // p1 has not acted yet: may raise
    s = act(s, 1, CALL);
    const l = legal(s, 2)!; // p2 already acted, faces only an incomplete raise
    expect(l.callAmount).toBe(5);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(() => act(s, 2, raise(40))).toThrow();
    s = act(s, 2, CALL);
    expect(s.phase).toBe("turn");
  });

  it("a full all-in raise does reopen betting", () => {
    let s = flopWith(40); // p3 has 38 left
    s = act(s, 2, raise(10));
    s = act(s, 3, raise(38)); // raise of 28 >= 10: full
    expect(legal(s, 1)!.minRaiseTo).toBe(66);
    s = act(s, 1, CALL);
    const l = legal(s, 2)!;
    expect(l.callAmount).toBe(28);
    expect(l.minRaiseTo).toBe(66);
  });

  it("incomplete raise does not change the min-raise size for later raisers", () => {
    let s = flopWith(17);
    s = act(s, 2, raise(10));
    s = act(s, 3, raise(15));
    s = act(s, 1, raise(25)); // raise of 10 over 15: full
    expect(legal(s, 2)!.minRaiseTo).toBe(35);
  });
});

// ---------- pot limit ----------

describe("pot-limit", () => {
  it("preflop max raise counts the blinds (UTG with 1/2 can raise to 7)", () => {
    let s = newHand({ variant: "plo4", stacks: { 1: 200, 2: 200, 3: 200 }, button: 1 });
    const l = legal(s, 1)!;
    expect(l.minRaiseTo).toBe(4);
    expect(l.maxRaiseTo).toBe(7);
    expect(() => act(s, 1, raise(8))).toThrow(/exceeds the maximum/);
    s = act(s, 1, raise(7));
    // SB: pot 1+2+7 = 10, call 6, so max = 7 + 10 + 6 = 23
    expect(legal(s, 2)!.maxRaiseTo).toBe(23);
  });

  it("postflop max across multiple bets, capped at all-in", () => {
    let s = newHand({ variant: "plo4", stacks: { 1: 200, 2: 200, 3: 200 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CALL], [3, CHECK]]); // pot 6
    expect(legal(s, 2)!.maxRaiseTo).toBe(6);
    s = act(s, 2, raise(6)); // pot 12
    expect(legal(s, 3)!.maxRaiseTo).toBe(24); // 6 + 12 + 6
    s = act(s, 3, raise(24)); // pot 36
    expect(legal(s, 1)!.maxRaiseTo).toBe(84); // 24 + 36 + 24
    expect(() => act(s, 1, raise(85))).toThrow();
    s = act(s, 1, raise(84)); // pot 120
    const l = legal(s, 2)!; // 84 + 120 + 78 = 282, capped at p2's all-in (198)
    expect(l.maxRaiseTo).toBe(198);
    expect(l.callAmount).toBe(78);
  });

  it("no-limit max raise is always all-in", () => {
    const s = newHand({ stacks: { 1: 150, 2: 100, 3: 100 }, button: 1 });
    expect(legal(s, 1)!.maxRaiseTo).toBe(150);
  });
});

// ---------- streets & options ----------

describe("street flow", () => {
  it("BB gets the option after limps and can raise, which reopens action", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CALL]]);
    expect(s.phase).toBe("preflop");
    expect(s.toActSeat).toBe(3);
    expect(legal(s, 3)).toMatchObject({ canCheck: true, minRaiseTo: 4 });
    s = act(s, 3, raise(6));
    expect(s.phase).toBe("preflop");
    expect(s.toActSeat).toBe(1);
  });

  it("a street ends when everyone has checked", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CALL], [3, CHECK], [2, CHECK], [3, CHECK]]);
    expect(s.phase).toBe("flop");
    s = act(s, 1, CHECK);
    expect(s.phase).toBe("turn");
  });

  it("last-action labels and per-street bet reset", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = act(s, 1, raise(6));
    expect(player(s, 1).lastAction).toBe("Raise to 6");
    s = seq(s, [[2, FOLD], [3, CALL]]);
    expect(player(s, 2).lastAction).toBe("Fold");
    expect(s.phase).toBe("flop");
    expect(s.players.every((p) => p.bet === 0)).toBe(true);
    expect(player(s, 1).totalCommitted).toBe(6);
    s = act(s, 3, raise(4));
    expect(player(s, 3).lastAction).toBe("Bet 4");
  });

  it("potsView excludes current-street bets", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(potsView(s)).toEqual([]);
    s = seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]);
    s = act(s, 2, raise(10));
    expect(potsView(s)).toEqual([{ amount: 18, eligiblePlayerIds: ["p1", "p2", "p3"] }]);
    expect(player(s, 2).bet).toBe(10);
  });

  it("potsView reflects live chips mid-hand", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]);
    expect(potsView(s)).toEqual([{ amount: 18, eligiblePlayerIds: ["p1", "p2", "p3"] }]);
  });
});

// ---------- endings ----------

describe("fold-outs and uncalled bets", () => {
  it("everyone folds: last player wins, no cards shown, uncalled bet returned", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = seq(s, [[1, raise(6)], [2, FOLD], [3, FOLD]]);
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p1", amount: 5, potIndex: 0, half: "whole", handName: null }]);
    expect(out.shown).toEqual({});
    expect(out.finalStacks).toEqual({ p1: 103, p2: 99, p3: 98 });
    expect(s.toActSeat).toBeNull();
    expect(legal(s, 1)).toBeNull();
    expect(() => act(s, 1, CHECK)).toThrow();
  });

  it("a bet on the flop that is folded to wins the pot", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CHECK], [2, raise(10)], [1, FOLD]]);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 98, p2: 102 });
    expect(out.winners[0]!.amount).toBe(4);
  });

  it("all-in called for less returns the uncalled part (caller loses)", () => {
    const holes = { 1: ["Ah", "Ad"] as Card[], 2: ["Kh", "Kd"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 100, 2: 40 }, button: 1, holes, board });
    expect(legal(s, 1)!.maxRaiseTo).toBe(100);
    s = seq(s, [[1, raise(100)]]);
    expect(legal(s, 2)!.callAmount).toBe(38);
    s = act(s, 2, CALL);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 140, p2: 0 });
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p1", amount: 80, half: "whole" });
    expect(out.shown).toEqual({ p1: ["Ah", "Ad"], p2: ["Kh", "Kd"] });
    expect(out.winners[0]!.handName).toMatch(/Pair|Aces/i);
  });

  it("short caller wins: bettor still gets the uncalled part back", () => {
    const holes = { 1: ["Kh", "Kd"] as Card[], 2: ["Ah", "Ad"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 100, 2: 40 }, button: 1, holes, board });
    s = seq(s, [[1, raise(100)], [2, CALL]]);
    expect(done(s).finalStacks).toEqual({ p1: 60, p2: 80 });
  });

  it("folded players' chips stay in the pot but they are not eligible", () => {
    const holes = { 1: ["Kh", "Kd"] as Card[], 2: ["3h", "4d"] as Card[], 3: ["Ah", "Ad"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "6c"];
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 6 }, button: 1, holes, board });
    s = seq(s, [[1, raise(10)], [2, FOLD], [3, CALL]]);
    expect(potsView(s)).toEqual([{ amount: 13, eligiblePlayerIds: ["p1", "p3"] }]);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 94, p2: 99, p3: 13 });
  });
});

describe("run-outs", () => {
  it("all-in preflop runs out the whole board", () => {
    const holes = { 1: ["Ah", "Ad"] as Card[], 2: ["Kh", "Kd"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1, holes, board });
    s = seq(s, [[1, raise(100)], [2, CALL]]);
    expect(s.board).toEqual(board);
    expect(s.burned).toHaveLength(3);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 200, p2: 0 });
  });

  it("all-in on the flop runs the turn and river", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CHECK]]);
    expect(s.board).toHaveLength(3);
    s = act(s, 2, raise(98));
    s = act(s, 1, CALL);
    expect(s.board).toHaveLength(5);
    done(s);
  });

  it("when only one player can still act and bets are matched, no more betting", () => {
    // p1 and p2 deep, p3 short and all-in preflop: p1/p2 still bet postflop
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 10 }, button: 1 });
    s = seq(s, [[1, CALL], [2, CALL]]); // p3 BB option
    s = act(s, 3, raise(10));
    s = seq(s, [[1, CALL], [2, CALL]]);
    expect(s.phase).toBe("flop");
    expect(s.toActSeat).toBe(2);
    s = seq(s, [[2, raise(20)], [1, FOLD]]);
    // p2 is the only one who can act, nobody to bet against: run out
    expect(s.phase).toBe("complete");
    done(s);
  });
});

describe("side pots", () => {
  it("builds main and side pots for three all-ins of different sizes", () => {
    const holes = {
      1: ["As", "Ah"] as Card[],
      2: ["Ks", "Kh"] as Card[],
      3: ["Qs", "Qh"] as Card[],
      4: ["Js", "Jh"] as Card[],
    };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 50, 2: 120, 3: 300, 4: 300 }, button: 4, holes, board });
    expect(s.toActSeat).toBe(3);
    s = seq(s, [[3, raise(300)], [4, CALL], [1, CALL], [2, CALL]]);
    expect(s.pots).toEqual([
      { amount: 200, eligiblePlayerIds: ["p1", "p2", "p3", "p4"] },
      { amount: 210, eligiblePlayerIds: ["p2", "p3", "p4"] },
      { amount: 360, eligiblePlayerIds: ["p3", "p4"] },
    ]);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 200, p2: 210, p3: 360, p4: 0 });
    expect(out.winners.map((w) => [w.playerId, w.amount, w.potIndex])).toEqual([
      ["p1", 200, 0],
      ["p2", 210, 1],
      ["p3", 360, 2],
    ]);
  });

  it("the short stack can win only the main pot", () => {
    const holes = { 1: ["As", "Ah"] as Card[], 2: ["Ks", "Kh"] as Card[], 3: ["Qs", "Qh"] as Card[] };
    const board: Card[] = ["2c", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 60, 2: 200, 3: 200 }, button: 3, holes, board });
    // button 3: SB p1, BB p2, UTG p3
    s = seq(s, [[3, raise(200)], [1, CALL], [2, CALL]]);
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 180, p2: 280, p3: 0 });
  });
});

// ---------- illegal actions & timeouts ----------

describe("illegal actions", () => {
  it("rejects action out of turn", () => {
    const s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(() => act(s, 3, CALL)).toThrow(/not .*turn/);
    expect(() => act(s, 2, FOLD)).toThrow(/not .*turn/);
  });

  it("rejects an unknown player", () => {
    const s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1 });
    expect(() => applyAction(s, "ghost", CHECK)).toThrow(/unknown player/);
  });

  it("rejects a check when facing a bet", () => {
    const s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(() => act(s, 1, CHECK)).toThrow(/cannot check/);
  });

  it("rejects raises below the minimum and above the pot-limit max", () => {
    const nl = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(() => act(nl, 1, raise(3))).toThrow(/below the minimum/);
    expect(() => act(nl, 1, raise(101))).toThrow(/exceeds/);
    const pl = newHand({ variant: "plo4", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(() => act(pl, 1, raise(8))).toThrow(/exceeds/);
    expect(() => act(pl, 1, raise(2.5))).toThrow(/integer/);
  });

  it("legalActions is null for everyone except the player to act", () => {
    const s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    expect(legal(s, 1)).not.toBeNull();
    expect(legal(s, 2)).toBeNull();
    expect(legal(s, 3)).toBeNull();
    expect(legalActions(s, "nobody")).toBeNull();
  });
});

describe("timeoutAction", () => {
  it("checks when it is free", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100 }, button: 1 });
    s = act(s, 1, CALL);
    s = timeoutAction(s); // BB option
    expect(s.phase).toBe("flop");
    expect(player(s, 2).lastAction).toBeNull(); // reset on new street
  });

  it("folds when facing a bet", () => {
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = timeoutAction(s);
    expect(player(s, 1).folded).toBe(true);
    expect(s.toActSeat).toBe(2);
  });

  it("folding out heads-up on timeout ends the hand", () => {
    const s = timeoutAction(newHand({ stacks: { 1: 100, 2: 100 }, button: 1 }));
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 99, p2: 101 });
  });
});

// ---------- showdown: hold'em ----------

describe("hold'em showdown", () => {
  it("reveals non-folded hands and names the winning hand", () => {
    const holes = { 1: ["Ah", "Ad"] as Card[], 2: ["Kh", "Kd"] as Card[], 3: ["7h", "2d"] as Card[] };
    const board: Card[] = ["As", "7d", "9h", "Ts", "4c"];
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board });
    s = seq(s, [[1, CALL], [2, CALL], [3, CHECK]]);
    s = seq(s, [[2, CHECK], [3, CHECK], [1, CHECK], [2, CHECK], [3, CHECK], [1, CHECK], [2, CHECK], [3, CHECK]]);
    s = act(s, 1, CHECK);
    const out = done(s);
    expect(Object.keys(out.shown).sort()).toEqual(["p1", "p2", "p3"]);
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p1", amount: 6, half: "whole" });
    expect(out.winners[0]!.handName).toMatch(/Three of a Kind|Trip/i);
    expect(out.finalStacks).toEqual({ p1: 104, p2: 98, p3: 98 });
  });

  it("folded hands are not shown", () => {
    const s = checkdown(seq(newHand({ stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 }), [[1, CALL], [2, FOLD], [3, CHECK]]));
    const out = done(s);
    expect(Object.keys(out.shown).sort()).toEqual(["p1", "p3"]);
  });

  it("odd chips in a tied pot go to the first tied winner left of the button", () => {
    const board: Card[] = ["Ah", "Kh", "Qh", "Jh", "Th"];
    const holes = { 1: ["2c", "3c"] as Card[], 3: ["2d", "3d"] as Card[], 4: ["2s", "3s"] as Card[], 2: ["5c", "6d"] as Card[] };
    let s = newHand({ stacks: { 1: 100, 2: 100, 3: 100, 4: 100 }, button: 1, bb: 3, holes, board });
    s = seq(s, [[4, CALL], [1, CALL], [2, FOLD], [3, CHECK]]);
    s = checkdown(s);
    const out = done(s);
    // pot 10 split three ways: 4/3/3 with the extra chip to seat 3 (first left of button)
    expect(out.winners.map((w) => [w.playerId, w.amount])).toEqual([
      ["p3", 4],
      ["p4", 3],
      ["p1", 3],
    ]);
  });

  it("even tie splits evenly", () => {
    const board: Card[] = ["Ah", "Kh", "Qh", "Jh", "Th"];
    const holes = { 1: ["2c", "3c"] as Card[], 2: ["2d", "3d"] as Card[] };
    const s = checkdown(seq(newHand({ stacks: { 1: 100, 2: 100 }, button: 1, holes, board }), [[1, CALL], [2, CHECK]]));
    const out = done(s);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100 });
    expect(out.winners).toHaveLength(2);
  });
});

// ---------- showdown: Omaha ----------

describe("omaha showdown", () => {
  it("must use exactly two hole cards", () => {
    // p1 holds 4 hearts + board has 3 hearts (needs two hole: has flush); p2 has a pair
    const board: Card[] = ["2h", "5h", "9h", "Kc", "Kd"];
    const holes = { 1: ["Ah", "3h", "7s", "8c"] as Card[], 2: ["Ks", "Kh", "Qc", "Jc"] as Card[] };
    const s = checkdown(seq(newHand({ variant: "plo4", stacks: { 1: 100, 2: 100 }, button: 1, holes, board }), [[1, CALL], [2, CHECK]]));
    const out = done(s);
    expect(out.winners[0]).toMatchObject({ playerId: "p2", half: "whole" }); // quad? kings full house beats flush
    expect(out.winners[0]!.handName).toMatch(/Four|Full House/);
  });

  it("a single suited hole card does not make a flush in Omaha", () => {
    const board: Card[] = ["2h", "5h", "9h", "Kc", "Qd"];
    const holes = { 1: ["Ah", "3s", "7s", "8c"] as Card[], 2: ["Ks", "4d", "Jc", "Td"] as Card[] };
    const s = checkdown(seq(newHand({ variant: "plo4", stacks: { 1: 100, 2: 100 }, button: 1, holes, board }), [[1, CALL], [2, CHECK]]));
    const out = done(s);
    expect(out.winners[0]).toMatchObject({ playerId: "p2" }); // pair of kings beats ace high
  });
});

// ---------- hi/lo ----------

describe("hi/lo splits (plo4-8)", () => {
  // Board 2c 5d 8h Kd 9s: low cards on board are exactly 2,5,8.
  const board: Card[] = ["2c", "5d", "8h", "Kd", "9s"];
  const H: Card[] = ["Kh", "Ks", "Qs", "Jh"]; // trip kings, no low
  const L1: Card[] = ["As", "3d", "Tc", "Td"]; // A-3 low
  const L2: Card[] = ["Ah", "3h", "Jc", "Js"]; // tied A-3 low
  const P: Card[] = ["As", "3d", "Kh", "Ks"]; // trip kings and A-3 low
  const NOLOW: Card[] = ["Qd", "Jd", "Tc", "Td"];
  const base = { variant: "plo4-8" as const, sb: 1, bb: 3 };

  it("splits half high / half low, odd chip to the high half", () => {
    // dead SB chip + two live players of 3 each = 7
    let s = newHand({ ...base, stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, board, holes: { 1: H, 3: L1 } });
    s = seq(s, [[1, CALL], [2, FOLD], [3, CHECK]]);
    s = checkdown(s);
    const out = done(s);
    expect(out.winners).toEqual([
      { playerId: "p1", amount: 4, potIndex: 0, half: "high", handName: expect.stringMatching(/Three of a Kind/) },
      { playerId: "p3", amount: 3, potIndex: 0, half: "low", handName: expect.any(String) },
    ]);
  });

  it("high scoops when nobody has a qualifying low", () => {
    let s = newHand({ ...base, stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, board, holes: { 1: H, 3: NOLOW } });
    s = seq(s, [[1, CALL], [2, FOLD], [3, CHECK]]);
    s = checkdown(s);
    const out = done(s);
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p1", amount: 7, half: "whole" });
  });

  it("quarters: one player scoops high and ties for low", () => {
    const holes = { 1: P, 2: L2, 3: ["Qd", "Tc", "Td", "4c"] as Card[] };
    let s = newHand({ ...base, stacks: { 1: 100, 2: 100, 3: 100 }, button: 3, board, holes });
    // button 3: SB p1, BB p2, UTG p3
    s = seq(s, [[3, CALL], [1, CALL], [2, CHECK]]);
    s = checkdown(s);
    const out = done(s);
    // pot 9: high 5 -> p1; low 4 split p1/p2 2 each
    const sum = (id: string) => out.winners.filter((w) => w.playerId === id).reduce((t, w) => t + w.amount, 0);
    expect(sum("p1")).toBe(7);
    expect(sum("p2")).toBe(2);
    expect(sum("p3")).toBe(0);
    expect(out.winners.map((w) => [w.playerId, w.half, w.amount])).toEqual([
      ["p1", "high", 5],
      ["p1", "low", 2],
      ["p2", "low", 2],
    ]);
  });

  it("two players tying low while a third wins high", () => {
    // dead SB chip (seat 2) + live p1 (H), p3 (L2), p4 (L1): pot 10
    const holes = { 1: H, 2: ["5c", "6d", "7h", "7d"] as Card[], 3: L2, 4: L1 };
    let s = newHand({ ...base, stacks: { 1: 100, 2: 100, 3: 100, 4: 100 }, button: 1, board, holes });
    s = seq(s, [[4, CALL], [1, CALL], [2, FOLD], [3, CHECK]]);
    s = checkdown(s);
    const out = done(s);
    // high 5 -> p1; low 5 split between p3 and p4: odd chip to p3 (first left of button)
    expect(out.winners.map((w) => [w.playerId, w.half, w.amount])).toEqual([
      ["p1", "high", 5],
      ["p3", "low", 3],
      ["p4", "low", 2],
    ]);
  });

  it("side pots are split hi/lo independently", () => {
    // p1 (short, low) all-in; p2 (high) and p3 (no low) fight for the side pot
    const holes = { 1: L1, 2: H, 3: NOLOW };
    let s = newHand({ ...base, stacks: { 1: 20, 2: 100, 3: 100 }, button: 3, board, holes });
    // button 3: SB p1, BB p2, UTG p3. PL max for UTG = 3 + 4 + 3 = 10... call-around instead
    s = seq(s, [[3, raise(10)], [1, CALL], [2, CALL]]);
    s = checkdown(s);
    const out = done(s);
    // everyone put in 10: single pot of 30, high 15 to p2, low 15 to p1
    expect(out.winners.map((w) => [w.playerId, w.half, w.amount])).toEqual([
      ["p2", "high", 15],
      ["p1", "low", 15],
    ]);
  });

  it("5-card Omaha hi/lo deals five and scoops without a low", () => {
    const holes = {
      1: ["Kh", "Ks", "Qs", "Jh", "9c"] as Card[],
      3: ["Qd", "Jd", "Tc", "Td", "Tg" as Card].slice(0, 4).concat(["9d"]) as Card[],
    };
    const s0 = newHand({ variant: "plo5-8", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, board, holes });
    for (const p of s0.players) expect(p.holeCards).toHaveLength(5);
  });
});

// ---------- Hold'em Hi/Lo ----------

describe("Hold'em Hi/Lo (no qualifier)", () => {
  it("splits high and low using any five of seven cards", () => {
    let s = newHand({
      variant: "nlhe-hilo",
      stacks: { 0: 100, 1: 100 },
      button: 0,
      holes: { 0: ["Ah", "2c"], 1: ["Kd", "Ks"] },
      board: ["3d", "4s", "9h", "Kc", "8d"],
    });
    s = seq(s, [[0, CALL], [1, CHECK]]);
    const out = done(checkdown(s));
    const high = out.winners.find((w) => w.half === "high")!;
    const low = out.winners.find((w) => w.half === "low")!;
    expect(high).toMatchObject({ playerId: "p1", amount: 2 });
    expect(low).toMatchObject({ playerId: "p0", amount: 2, handName: "8-4-3-2-A" });
  });

  it("always splits: a queen-high low still wins the low half", () => {
    let s = newHand({
      variant: "nlhe-hilo",
      stacks: { 0: 100, 1: 100 },
      button: 0,
      holes: { 0: ["Ah", "2c"], 1: ["Kd", "Ks"] },
      board: ["Kh", "Qd", "Jc", "9s", "9h"],
    });
    s = seq(s, [[0, CALL], [1, CHECK]]);
    const out = done(checkdown(s));
    expect(out.winners.find((w) => w.half === "high")).toMatchObject({ playerId: "p1", amount: 2 });
    // p1 holds KK on a K-Q-J-9-9 board and can't avoid a pair; p0's Q-J-9-2-A is lower.
    expect(out.winners.find((w) => w.half === "low")).toMatchObject({ playerId: "p0", amount: 2, handName: "Q-J-9-2-A" });
  });
});

// ---------- low-only Omaha games ----------

describe("low-only Omaha games", () => {
  const LOWBOARD: Card[] = ["2c", "4d", "7h", "Ks", "Js"];
  // 7-4-3-2-A (best), 7-6-5-4-2 (second), 9-8-7-4-2 (worst) on LOWBOARD
  const A1: Card[] = ["Ah", "3h", "Kh", "Kc"];
  const A2: Card[] = ["As", "3s", "Qh", "Qc"];
  const A3: Card[] = ["Ad", "3d", "Th", "Td"];
  const B1: Card[] = ["5d", "6d", "Jh", "Jc"];
  const C1: Card[] = ["8c", "9s", "Tc", "Ts"];
  const limp3 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CALL], [3, CHECK]]));
  const limp2 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CHECK]]));

  it("plo4-lo8: the best qualifying low takes the whole pot", () => {
    const holes = { 1: A1, 2: B1, 3: ["9h", "9d", "Qd", "Qs"] as Card[] };
    const out = done(limp3(newHand({ variant: "plo4-lo8", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: LOWBOARD })));
    expect(out.winners).toEqual([{ playerId: "p1", amount: 6, potIndex: 0, half: "whole", handName: "7-4-3-2-A" }]);
    expect(out.finalStacks).toEqual({ p1: 104, p2: 98, p3: 98 });
  });

  it("plo4-lo8: with no qualifying low the best high hand wins", () => {
    const board: Card[] = ["Kc", "Qd", "Jh", "9s", "9c"];
    const holes = { 1: ["Ah", "8d", "2h", "3h"] as Card[], 2: ["Th", "Td", "5d", "6d"] as Card[], 3: ["2s", "3s", "4h", "5h"] as Card[] };
    const out = done(limp3(newHand({ variant: "plo4-lo8", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board })));
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p2", amount: 6, half: "whole" });
    expect(out.winners[0]!.handName).toMatch(/two pair/i);
  });

  it("plo4-lo8: short stack with the best low wins the main pot, the side pot goes to the other low", () => {
    const holes = { 3: A1, 1: B1, 2: ["9h", "9d", "Qd", "Qs"] as Card[] };
    let s = newHand({ variant: "plo4-lo8", stacks: { 1: 100, 2: 100, 3: 4 }, button: 1, holes, board: LOWBOARD });
    s = checkdown(seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]));
    const out = done(s);
    expect(out.winners).toHaveLength(2);
    expect(out.winners[0]).toMatchObject({ playerId: "p3", amount: 12, potIndex: 0, half: "whole", handName: "7-4-3-2-A" });
    expect(out.winners[1]).toMatchObject({ playerId: "p1", amount: 4, potIndex: 1, half: "whole", handName: "7-6-5-4-2" });
  });

  it("plo4-lo: a K-high low beats a pair", () => {
    const board: Card[] = ["2c", "3d", "Kh", "Ks", "Kd"];
    const holes = { 1: ["Jh", "Jc", "Js", "Jd"] as Card[], 2: ["Ah", "4h", "9c", "8c"] as Card[] };
    const out = done(limp2(newHand({ variant: "plo4-lo", stacks: { 1: 100, 2: 100 }, button: 1, holes, board })));
    expect(out.winners).toEqual([{ playerId: "p2", amount: 4, potIndex: 0, half: "whole", handName: "K-4-3-2-A" }]);
  });

  it("fyst: second-best low wins with three players", () => {
    const holes = { 1: A1, 2: B1, 3: C1 };
    const out = done(limp3(newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: LOWBOARD })));
    expect(out.winners).toEqual([{ playerId: "p2", amount: 6, potIndex: 0, half: "whole", handName: "7-6-5-4-2" }]);
  });

  it("fyst: all tied splits the pot", () => {
    const holes = { 1: A1, 2: A2, 3: A3 };
    const out = done(limp3(newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: LOWBOARD })));
    expect(out.winners.map((w) => [w.playerId, w.amount]).sort()).toEqual([["p1", 2], ["p2", 2], ["p3", 2]]);
    expect(out.finalStacks).toEqual({ p1: 100, p2: 100, p3: 100 });
  });

  it("fyst: a tie for best skips the whole tied group", () => {
    const holes = { 1: A1, 2: A2, 3: B1, 4: C1 };
    const s = newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 100, 4: 100 }, button: 1, holes, board: LOWBOARD });
    const out = done(checkdown(seq(s, [[4, CALL], [1, CALL], [2, CALL], [3, CHECK]])));
    expect(out.winners).toEqual([{ playerId: "p3", amount: 8, potIndex: 0, half: "whole", handName: "7-6-5-4-2" }]);
  });

  it("fyst: a tied second group splits", () => {
    const B2: Card[] = ["5h", "6h", "Qd", "Qs"];
    const holes = { 1: A1, 2: B1, 3: B2 };
    const out = done(limp3(newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1, holes, board: LOWBOARD })));
    expect(out.winners.map((w) => [w.playerId, w.amount]).sort()).toEqual([["p2", 3], ["p3", 3]]);
  });

  it("fyst: heads-up the worse low wins", () => {
    const out = done(limp2(newHand({ variant: "fyst", stacks: { 1: 100, 2: 100 }, button: 1, holes: { 1: A1, 2: B1 }, board: LOWBOARD })));
    expect(out.winners).toEqual([{ playerId: "p2", amount: 4, potIndex: 0, half: "whole", handName: "7-6-5-4-2" }]);
  });

  it("fyst: a side pot with a single eligible player goes to that player", () => {
    const holes = { 1: C1, 2: A1, 3: B1 };
    let s = newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 4 }, button: 1, holes, board: LOWBOARD });
    s = seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]);
    s = seq(s, [[2, raise(8)], [1, FOLD]]);
    const out = done(checkdown(s));
    expect(out.winners).toHaveLength(2);
    // main pot (p2, p3): second-best of two is the worse low, p3
    expect(out.winners[0]).toMatchObject({ playerId: "p3", amount: 12, potIndex: 0 });
    // dead money above the all-in: only p2 is eligible
    expect(out.winners[1]).toMatchObject({ playerId: "p2", amount: 4, potIndex: 1 });
  });

  it("fyst: a fold-out wins as usual", () => {
    let s = newHand({ variant: "fyst", stacks: { 1: 100, 2: 100, 3: 100 }, button: 1 });
    s = seq(s, [[1, raise(6)], [2, FOLD], [3, FOLD]]);
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p1", amount: 5, potIndex: 0, half: "whole", handName: null }]);
  });
});

// ---------- FYST, Double FYST, Dumb & Dumber ----------

describe("second-best and lowest-best high games", () => {
  const BOARD: Card[] = ["2c", "7d", "9h", "Js", "Kd"];
  const limp2 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CHECK]]));
  const limp3 = (s: HandState) => checkdown(seq(s, [[1, CALL], [2, CALL], [3, CHECK]]));
  const limp4 = (s: HandState) => checkdown(seq(s, [[4, CALL], [1, CALL], [2, CALL], [3, CHECK]]));
  const s3 = { 1: 100, 2: 100, 3: 100 };
  const pay = (out: { winners: { playerId: string; amount: number }[] }) => out.winners.map((w) => [w.playerId, w.amount]).sort();

  // Hold'em: three kings (best), three jacks (second), ace high (worst)
  const HK: Card[] = ["Kh", "Kc"], HJ: Card[] = ["Jh", "Jc"], HA: Card[] = ["Ah", "Qc"];
  // Omaha (exactly two hole cards): the same three hands
  const OK: Card[] = ["Kh", "Kc", "3s", "4s"], OJ: Card[] = ["Jh", "Jc", "3d", "4d"], OA: Card[] = ["Ah", "Qc", "5s", "6s"];

  it("the new games deal the right number of cards", () => {
    expect(VARIANTS["fyst-he"]).toMatchObject({ holeCards: 2, mustUseTwoHole: false, highWinner: "second" });
    expect(VARIANTS["fyst-o"]).toMatchObject({ holeCards: 4, mustUseTwoHole: true, highWinner: "second" });
    expect(VARIANTS.dumb).toMatchObject({ holeCards: 4, mustUseTwoHole: true, highWinner: "worst" });
    expect(VARIANTS.fyst.retired).toBe(true);
  });

  it("FYST: the second-best Hold'em hand wins", () => {
    const out = done(limp3(newHand({ variant: "fyst-he", stacks: s3, button: 1, holes: { 1: HK, 2: HJ, 3: HA }, board: BOARD })));
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p2", amount: 6, half: "whole" });
    expect(out.winners[0]!.handName).toMatch(/three/i);
  });

  it("FYST: heads-up the worse hand wins", () => {
    const out = done(limp2(newHand({ variant: "fyst-he", stacks: { 1: 100, 2: 100 }, button: 1, holes: { 1: HK, 2: HA }, board: BOARD })));
    expect(pay(out)).toEqual([["p2", 4]]);
  });

  it("FYST: a tie for best skips the whole tied group", () => {
    const holes = { 1: ["Kh", "Qh"] as Card[], 2: ["Kc", "Qd"] as Card[], 3: ["Jh", "Tc"] as Card[], 4: ["3h", "4h"] as Card[] };
    const out = done(limp4(newHand({ variant: "fyst-he", stacks: { 1: 100, 2: 100, 3: 100, 4: 100 }, button: 1, holes, board: BOARD })));
    expect(pay(out)).toEqual([["p3", 8]]);
  });

  it("FYST: a tied second group splits", () => {
    const holes = { 1: HK, 2: ["Ah", "Qc"] as Card[], 3: ["As", "Qd"] as Card[] };
    const out = done(limp3(newHand({ variant: "fyst-he", stacks: s3, button: 1, holes, board: BOARD })));
    expect(pay(out)).toEqual([["p2", 3], ["p3", 3]]);
  });

  it("FYST: when everyone ties, they split", () => {
    const board: Card[] = ["Ac", "Kd", "Qh", "Js", "Td"];
    const holes = { 1: ["2h", "3h"] as Card[], 2: ["2s", "3s"] as Card[], 3: ["4h", "5c"] as Card[] };
    const out = done(limp3(newHand({ variant: "fyst-he", stacks: s3, button: 1, holes, board })));
    expect(pay(out)).toEqual([["p1", 2], ["p2", 2], ["p3", 2]]);
  });

  it("FYST: a side pot with one eligible player goes to that player", () => {
    let s = newHand({ variant: "fyst-he", stacks: { 1: 100, 2: 100, 3: 4 }, button: 1, holes: { 1: HA, 2: HK, 3: HJ }, board: BOARD });
    s = seq(s, [[1, raise(6)], [2, CALL], [3, CALL]]);
    s = seq(s, [[2, raise(8)], [1, FOLD]]);
    const out = done(checkdown(s));
    expect(out.winners[0]).toMatchObject({ playerId: "p3", amount: 12, potIndex: 0 }); // kings vs jacks: the worse of two wins
    expect(out.winners[1]).toMatchObject({ playerId: "p2", amount: 4, potIndex: 1 });
  });

  it("FYST: a fold-out wins as usual", () => {
    let s = newHand({ variant: "fyst-he", stacks: s3, button: 1 });
    s = seq(s, [[1, raise(6)], [2, FOLD], [3, FOLD]]);
    const out = done(s);
    expect(out.winners).toHaveLength(1);
    expect(out.winners[0]).toMatchObject({ playerId: "p1", half: "whole", handName: null });
  });

  it("Double FYST: the second-best Omaha hand wins", () => {
    const out = done(limp3(newHand({ variant: "fyst-o", stacks: s3, button: 1, holes: { 1: OK, 2: OJ, 3: OA }, board: BOARD })));
    expect(pay(out)).toEqual([["p2", 6]]);
    expect(out.winners[0]!.handName).toMatch(/three/i);
  });

  it("Double FYST: hands use exactly two hole cards", () => {
    // Four hearts on the board. One heart in the hole is not a flush in Omaha, so p1 has only a pair of aces.
    // p2 (Q-T of hearts) has a flush, p3 three kings. Order: p2, p3, p1. Second best: p3.
    const board: Card[] = ["2h", "7h", "9h", "Jh", "Kd"];
    const holes = { 1: ["Ah", "Ac", "3s", "4s"] as Card[], 2: ["Qh", "Th", "3d", "4d"] as Card[], 3: ["Kc", "Ks", "5s", "6c"] as Card[] };
    const out = done(limp3(newHand({ variant: "fyst-o", stacks: s3, button: 1, holes, board })));
    expect(pay(out)).toEqual([["p3", 6]]);
  });

  it("Dumb & Dumber: the lowest best hand wins", () => {
    const out = done(limp3(newHand({ variant: "dumb", stacks: s3, button: 1, holes: { 1: OK, 2: OJ, 3: OA }, board: BOARD })));
    expect(pay(out)).toEqual([["p3", 6]]);
    expect(out.winners[0]!.handName).toMatch(/high/i);
  });

  it("Dumb & Dumber: a player cannot play a worse hand than their best one", () => {
    // p1 could show 3-4 for king high, but must play the three kings. p2's best is a pair of jacks, so p2 wins.
    const holes = { 1: OK, 2: ["Jh", "Qc", "5s", "6s"] as Card[] };
    const out = done(limp2(newHand({ variant: "dumb", stacks: { 1: 100, 2: 100 }, button: 1, holes, board: BOARD })));
    expect(pay(out)).toEqual([["p2", 4]]);
    expect(out.winners[0]!.handName).toMatch(/pair/i);
  });

  it("Dumb & Dumber: tied lowest hands split", () => {
    const holes = { 1: OK, 2: OA, 3: ["As", "Qd", "5h", "6h"] as Card[] };
    const out = done(limp3(newHand({ variant: "dumb", stacks: s3, button: 1, holes, board: BOARD })));
    expect(pay(out)).toEqual([["p2", 3], ["p3", 3]]);
  });
});
