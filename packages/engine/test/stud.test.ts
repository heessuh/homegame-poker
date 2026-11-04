import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { VARIANTS } from "../src/variants.js";
import { DEFAULT_STUD, type Declaration, type PlayerAction, type StudStakes } from "../src/protocol.js";
import { applyAction, legalActions, potsView, startHand, timeoutAction, type HandState } from "../src/game.js";
import { shuffle } from "../src/shuffle.js";

// ---------- helpers ----------

// Scaled-down stakes keep the scenario tests readable; the cent defaults have their own describe block.
const TEST_STAKES: StudStakes = { ...DEFAULT_STUD, ante: 1, minBet: 2, maxBet: 4, maxBetLastRound: 8, downExchangeCost: 1 };

const CHECK: PlayerAction = { type: "check" };
const CALL: PlayerAction = { type: "call" };
const FOLD: PlayerAction = { type: "fold" };
const raise = (amount: number): PlayerAction => ({ type: "raise", amount });
const keep: PlayerAction = { type: "exchange", card: null };
const swap = (card: Card): PlayerAction => ({ type: "exchange", card });
const declare = (choice: Declaration): PlayerAction => ({ type: "declare", choice });
const cs = (s: string) => s.split(" ") as Card[];

function dealOrder(seats: number[], button: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const i = sorted.indexOf(button);
  return [...sorted.slice(i + 1), ...sorted.slice(0, i + 1)];
}

// A hand is [down1, up(2nd), up(3rd), up(4th), down2], i.e. the deal order. Missing slots are filled from the deck.
interface Rig {
  stacks: Record<number, number>;
  button: number;
  cards?: Record<number, Array<Card | undefined>>;
  extra?: Card[];
  stakes?: Partial<StudStakes>;
}

function rigDeck(o: Rig): { deck: Card[]; hands: Record<number, Card[]> } {
  const seats = Object.keys(o.stacks).map(Number);
  const order = dealOrder(seats, o.button);
  const used = new Set<Card>([...(Object.values(o.cards ?? {}).flat().filter(Boolean) as Card[]), ...(o.extra ?? [])]);
  const pool = freshDeck().filter((c) => !used.has(c));
  const hands: Record<number, Card[]> = {};
  for (const seat of order) {
    const spec = o.cards?.[seat] ?? [];
    hands[seat] = [0, 1, 2, 3, 4].map((i) => spec[i] ?? (pool.shift() as Card));
  }
  const deck: Card[] = [];
  for (let r = 0; r < 5; r++) for (const seat of order) deck.push((hands[seat] as Card[])[r] as Card);
  deck.push(...(o.extra ?? []), ...pool);
  return { deck, hands };
}

function newStud(o: Rig): HandState {
  return startHand({
    handNumber: 1,
    variant: "murder5",
    seats: Object.entries(o.stacks).map(([seat, stack]) => ({ seat: Number(seat), playerId: `p${seat}`, stack })),
    buttonSeat: o.button,
    smallBlind: 1,
    bigBlind: 2,
    deck: rigDeck(o).deck,
    stakes: { ...TEST_STAKES, ...o.stakes },
  });
}

const act = (s: HandState, seat: number, a: PlayerAction) => applyAction(s, `p${seat}`, a);
const player = (s: HandState, seat: number) => s.players.find((p) => p.seat === seat)!;
const legal = (s: HandState, seat: number) => legalActions(s, `p${seat}`);
const to = (s: HandState) => s.toActSeat as number;

function autoStep(s: HandState, decl: Record<number, Declaration> = {}): HandState {
  const seat = to(s);
  const l = legal(s, seat)!;
  if (l.exchange) return act(s, seat, keep);
  if (l.declare) return act(s, seat, declare(decl[seat] ?? "high"));
  return act(s, seat, l.canCheck ? CHECK : CALL);
}
function runTo(s: HandState, phase: string, stage: string, decl: Record<number, Declaration> = {}): HandState {
  for (let n = 0; !s.outcome && !(s.phase === phase && s.stage === stage); n++) {
    if (n > 300) throw new Error("runTo did not converge");
    s = autoStep(s, decl);
  }
  return s;
}
function playOut(s: HandState, decl: Record<number, Declaration> = {}): HandState {
  for (let n = 0; !s.outcome; n++) {
    if (n > 300) throw new Error("playOut did not converge");
    s = autoStep(s, decl);
  }
  return s;
}
function done(s: HandState) {
  expect(s.phase).toBe("complete");
  expect(s.outcome).not.toBeNull();
  const out = s.outcome!;
  expect(Object.values(out.finalStacks).reduce((a, b) => a + b, 0)).toBe(s.startingTotal);
  return out;
}
const won = (s: HandState, seat: number) => s.outcome!.winners.filter((w) => w.playerId === `p${seat}`).reduce((t, w) => t + w.amount, 0);
const potSum = (s: HandState) => potsView(s).reduce((t, p) => t + p.amount, 0);

const FH = cs("Kc Kd Kh 9s 9d"); // full house; terrible low
const LOW = cs("As 2d 3c 4h 6s"); // 6-4-3-2-A, ace-high on the high side
const JUNK = cs("Qc Jd 8h 7s 2c");
const KHIGH_X = cs("Kc Qd Jh 9s 8d");
const KHIGH_Y = cs("Kd Qh Td 9c 7s");
const THREE = { 0: 100, 1: 100, 2: 100 };
const FH_NAME = "Full House, Kings full of Nines";

// ---------- variant ----------

describe("5-Murder variant", () => {
  it("is registered as a spread-limit stud game for up to 8 players", () => {
    const v = VARIANTS.murder5;
    expect(v.name).toBe("5-Murder");
    expect(v.kind).toBe("stud");
    expect(v.betting).toBe("spread-limit");
    expect(v.maxPlayers).toBe(8);
    expect(v.holeCards).toBe(5);
  });

  it("rejects nine players and a single player", () => {
    const seats = (n: number) => [...Array(n).keys()].map((i) => ({ seat: i, playerId: `p${i}`, stack: 50 }));
    const mk = (n: number) => () => startHand({ handNumber: 1, variant: "murder5", seats: seats(n), buttonSeat: 0, smallBlind: 1, bigBlind: 2, deck: shuffle() });
    expect(mk(9)).toThrow();
    expect(mk(1)).toThrow();
    expect(mk(8)).not.toThrow();
  });

  it("uses DEFAULT_STUD when no stakes are given", () => {
    const s = startHand({ handNumber: 1, variant: "murder5", seats: [{ seat: 0, playerId: "p0", stack: 50 }, { seat: 1, playerId: "p1", stack: 50 }], buttonSeat: 0, smallBlind: 1, bigBlind: 2, deck: shuffle() });
    expect(s.stakes).toEqual(DEFAULT_STUD);
    expect(player(s, 0).stack).toBe(50 - DEFAULT_STUD.ante);
  });
});

// ---------- antes & deal ----------

describe("antes and dealing", () => {
  it("every player antes, there are no blinds, and antes are completed-pot chips", () => {
    const s = newStud({ stacks: THREE, button: 2, stakes: { ante: 3 } });
    for (const p of s.players) {
      expect(p.stack).toBe(97);
      expect(p.totalCommitted).toBe(3);
      expect(p.bet).toBe(0);
      expect(p.allIn).toBe(false);
    }
    expect(s.currentBet).toBe(0);
    expect(potSum(s)).toBe(9);
    expect(potsView(s)).toEqual([{ amount: 9, eligiblePlayerIds: ["p0", "p1", "p2"] }]);
    expect(player(s, 0).lastAction).toBe("Ante 3");
  });

  it("a short stack antes what it has and is all-in; side pot is built from antes", () => {
    const s = newStud({ stacks: { 0: 2, 1: 100, 2: 100 }, button: 2, stakes: { ante: 3 } });
    const p0 = player(s, 0);
    expect(p0.stack).toBe(0);
    expect(p0.allIn).toBe(true);
    expect(p0.totalCommitted).toBe(2);
    expect(p0.lastAction).toBe("Ante 2");
    expect(p0.upCards).toHaveLength(1);
    expect(potsView(s)).toEqual([
      { amount: 6, eligiblePlayerIds: ["p0", "p1", "p2"] },
      { amount: 2, eligiblePlayerIds: ["p1", "p2"] },
    ]);
    expect(s.toActSeat).not.toBe(0);
  });

  it("deals one down then one up to each player, starting left of the button", () => {
    const deck = freshDeck();
    const s = startHand({ handNumber: 1, variant: "murder5", seats: [0, 1, 2].map((i) => ({ seat: i, playerId: `p${i}`, stack: 50 })), buttonSeat: 1, smallBlind: 1, bigBlind: 2, deck });
    // Order left of the button 1: seats 2, 0, 1. Down round first, then the up round.
    expect(player(s, 2).holeCards).toEqual([deck[0]]);
    expect(player(s, 0).holeCards).toEqual([deck[1]]);
    expect(player(s, 1).holeCards).toEqual([deck[2]]);
    expect(player(s, 2).upCards).toEqual([deck[3]]);
    expect(player(s, 0).upCards).toEqual([deck[4]]);
    expect(player(s, 1).upCards).toEqual([deck[5]]);
    expect(s.deck).toHaveLength(52 - 6);
    expect(s.phase).toBe("2nd");
    expect(s.stage).toBe("bet");
  });

  it("goes through every phase in order and ends with 2 down + 3 up cards each", () => {
    let s = newStud({ stacks: THREE, button: 2 });
    const seen: string[] = [];
    while (!s.outcome) {
      const key = `${s.phase}/${s.stage}`;
      if (seen[seen.length - 1] !== key) seen.push(key);
      s = autoStep(s);
    }
    expect(seen).toEqual(["2nd/bet", "3rd/bet", "4th/bet", "5th/bet", "draw1/exchange", "draw1/bet", "draw2/exchange", "draw2/bet", "declare/declare"]);
    for (const p of s.players) {
      expect(p.holeCards).toHaveLength(2);
      expect(p.upCards).toHaveLength(3);
    }
    done(s);
  });

  it("deals the 3rd and 4th cards up and the 5th card down, in dealt order", () => {
    const cards = { 0: ["2c", "3c", "4c", "5c", "6c"], 1: ["2d", "3d", "4d", "5d", "6d"] } as Rig["cards"];
    const s = runTo(newStud({ stacks: { 0: 100, 1: 100 }, button: 1, cards }), "draw1", "exchange");
    expect(player(s, 0).upCards).toEqual(["3c", "4c", "5c"]);
    expect(player(s, 0).holeCards).toEqual(["2c", "6c"]);
    expect(player(s, 1).upCards).toEqual(["3d", "4d", "5d"]);
    expect(player(s, 1).holeCards).toEqual(["2d", "6d"]);
  });
});

// ---------- betting order ----------

describe("who opens", () => {
  it("lowest single up card opens and play goes clockwise", () => {
    let s = newStud({ stacks: THREE, button: 2, cards: { 0: [undefined, "9c"], 1: [undefined, "4d"], 2: [undefined, "Kh"] } });
    expect(s.toActSeat).toBe(1);
    s = act(s, 1, CHECK);
    expect(s.toActSeat).toBe(2);
    s = act(s, 2, CHECK);
    expect(s.toActSeat).toBe(0);
  });

  it("the ace is low", () => {
    const s = newStud({ stacks: THREE, button: 2, cards: { 0: [undefined, "Ac"], 1: [undefined, "2d"], 2: [undefined, "Kh"] } });
    expect(s.toActSeat).toBe(0);
  });

  it("ties go to the tied player closest to the left of the button", () => {
    const cards = { 0: [undefined, "5c"], 1: [undefined, "5d"], 2: [undefined, "5h"] } as Rig["cards"];
    expect(newStud({ stacks: THREE, button: 1, cards }).toActSeat).toBe(2);
    expect(newStud({ stacks: THREE, button: 2, cards }).toActSeat).toBe(0);
    expect(newStud({ stacks: THREE, button: 0, cards }).toActSeat).toBe(1);
  });

  it("a pair showing is worse than any unpaired hand of the same size", () => {
    const cards = { 0: [undefined, "5c", "5d"], 1: [undefined, "Kc", "Qd"], 2: [undefined, "Jc", "Td"] } as Rig["cards"];
    const s = runTo(newStud({ stacks: THREE, button: 2, cards }), "3rd", "bet");
    expect(s.toActSeat).toBe(2); // J-T lowest unpaired; K-Q next; the pair is last
    const s2 = act(s, 2, CHECK);
    expect(s2.toActSeat).toBe(0); // clockwise from the opener
  });

  it("compares the highest card first: 9-4 beats 9-5 beats K-2", () => {
    const cards = { 0: [undefined, "9c", "4d"], 1: [undefined, "Kc", "2d"], 2: [undefined, "9d", "5c"] } as Rig["cards"];
    const s = runTo(newStud({ stacks: THREE, button: 2, cards }), "3rd", "bet");
    expect(s.toActSeat).toBe(0);
  });

  it("the ace is low in a two-card showing hand: A-3 beats 4-2", () => {
    const cards = { 0: [undefined, "Ac", "3d"], 1: [undefined, "4c", "2d"], 2: [undefined, "5c", "6d"] } as Rig["cards"];
    const s = runTo(newStud({ stacks: THREE, button: 2, cards }), "3rd", "bet");
    expect(s.toActSeat).toBe(0);
  });

  it("all-in players are skipped when finding the opener", () => {
    const s = newStud({ stacks: { 0: 100, 1: 1, 2: 100 }, button: 2, cards: { 0: [undefined, "9c"], 1: [undefined, "2d"], 2: [undefined, "Kh"] } });
    expect(player(s, 1).allIn).toBe(true);
    expect(s.toActSeat).toBe(0);
  });
});

// ---------- spread limit ----------

describe("spread-limit betting", () => {
  it("bets are minBet..maxBet in every round but the last, which allows up to maxBetLastRound", () => {
    let s = newStud({ stacks: THREE, button: 2 });
    const rounds: Array<[string, string, number]> = [
      ["2nd", "bet", 4], ["3rd", "bet", 4], ["4th", "bet", 4], ["5th", "bet", 4], ["draw1", "bet", 4], ["draw2", "bet", 8],
    ];
    for (const [phase, stage, cap] of rounds) {
      s = runTo(s, phase, stage);
      const l = legal(s, to(s))!;
      expect(l.minRaiseTo).toBe(2);
      expect(l.maxRaiseTo).toBe(cap);
      s = act(s, to(s), raise(cap));
      const l2 = legal(s, to(s))!;
      expect(l2.callAmount).toBe(cap);
      // A maximum bet cannot be raised: the next raise would have to exceed it.
      expect(l2.minRaiseTo).toBeNull();
      expect(l2.maxRaiseTo).toBeNull();
      while (s.phase === phase && s.stage === stage && !s.outcome) s = act(s, to(s), CALL);
    }
    s = playOut(s);
    done(s);
  });

  it("rejects bets below the minimum and above the maximum", () => {
    const s = newStud({ stacks: THREE, button: 2 });
    expect(() => act(s, to(s), raise(1))).toThrow();
    expect(() => act(s, to(s), raise(5))).toThrow();
    expect(() => act(s, to(s), raise(100))).toThrow();
    expect(() => act(s, to(s), raise(2))).not.toThrow();
    expect(() => act(s, to(s), raise(3))).not.toThrow();
    expect(() => act(s, to(s), raise(4))).not.toThrow();
  });

  it("each raise must exceed the previous increment: after a bet of 2 the smallest raise is by 3", () => {
    let s = newStud({ stacks: THREE, button: 2, stakes: { maxBet: 6 } });
    s = act(s, to(s), raise(2));
    const b = to(s);
    const l = legal(s, b)!;
    expect(l.minRaiseTo).toBe(5);
    expect(l.maxRaiseTo).toBe(8);
    expect(() => act(s, b, raise(4))).toThrow();
    s = act(s, b, raise(5));
    expect(legal(s, to(s))!.minRaiseTo).toBe(9); // previous increment 3 -> at least 4
    expect(legal(s, to(s))!.maxRaiseTo).toBe(11);
  });

  it("lastAction strings read Bet, Raise to, Call, Check, Fold", () => {
    let s = newStud({ stacks: THREE, button: 2, stakes: { maxBet: 6 } });
    const a = to(s);
    s = act(s, a, raise(2));
    expect(player(s, a).lastAction).toBe("Bet 2");
    const b = to(s);
    s = act(s, b, raise(5));
    expect(player(s, b).lastAction).toBe("Raise to 5");
    const c = to(s);
    s = act(s, c, CALL);
    expect(player(s, c).lastAction).toBe("Call 5");
    s = act(s, a, FOLD);
    expect(player(s, a).lastAction).toBe("Fold");
    s = runTo(s, "3rd", "bet");
    const d = to(s);
    s = act(s, d, CHECK);
    expect(player(s, d).lastAction).toBe("Check");
  });

  const wide = { maxBet: 100, maxBetLastRound: 100 };

  it("caps raises at maxRaises after the opening bet with three or more players", () => {
    let s = newStud({ stacks: { 0: 1000, 1: 1000, 2: 1000 }, button: 2, stakes: { ...wide, maxRaises: 3 } });
    const a = to(s);
    s = act(s, a, raise(2)); // bet
    const second = to(s);
    s = act(s, second, raise(5)); // raise 1 (inc 3)
    const third = to(s);
    s = act(s, third, raise(9)); // raise 2 (inc 4)
    s = act(s, a, raise(14)); // raise 3 (inc 5)
    const l = legal(s, second)!;
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(l.callAmount).toBe(9);
    expect(() => act(s, second, raise(20))).toThrow();
    s = act(s, second, CALL);
    s = act(s, third, CALL);
    expect(s.phase).toBe("3rd");
    expect(legal(s, to(s))!.minRaiseTo).toBe(2); // the cap resets next round
  });

  it("heads-up the raise cap applies too", () => {
    let s = newStud({ stacks: { 0: 1000, 1: 1000 }, button: 1, stakes: { ...wide, maxRaises: 2 } });
    s = act(s, to(s), raise(2));
    s = act(s, to(s), raise(5)); // raise 1
    s = act(s, to(s), raise(9)); // raise 2
    const l = legal(s, to(s))!;
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    s = act(s, to(s), CALL);
    expect(s.phase).toBe("3rd");
  });

  it("without raiseMustExceed a raise only needs minBet", () => {
    let s = newStud({ stacks: THREE, button: 2, stakes: { raiseMustExceed: false } });
    s = act(s, to(s), raise(3));
    expect(legal(s, to(s))!.minRaiseTo).toBe(5);
  });

  it("an all-in for less is allowed, and an incomplete raise does not reopen the betting", () => {
    const cards = { 0: [undefined, "3c"], 1: [undefined, "9c"], 2: [undefined, "Kc"] } as Rig["cards"];
    let s = newStud({ stacks: { 0: 100, 1: 4, 2: 100 }, button: 2, cards }); // seat 1 has 3 left after the ante
    expect(s.toActSeat).toBe(0);
    s = act(s, 0, raise(2));
    const l1 = legal(s, 1)!;
    expect(l1.minRaiseTo).toBe(3); // below the full minimum of 5: all-in only
    expect(l1.maxRaiseTo).toBe(3);
    s = act(s, 1, raise(3)); // +1 only: incomplete
    expect(player(s, 1).allIn).toBe(true);
    expect(player(s, 1).lastAction).toBe("All-in 3");
    expect(s.raises).toBe(0); // not counted as a raise
    expect(s.lastRaiseSize).toBe(2); // previous increment unchanged
    expect(legal(s, 2)!.minRaiseTo).toBe(6); // 3 + (2+1)
    s = act(s, 2, CALL);
    expect(s.toActSeat).toBe(0);
    const l0 = legal(s, 0)!;
    expect(l0.callAmount).toBe(1);
    expect(l0.minRaiseTo).toBeNull(); // already acted: not reopened
    s = act(s, 0, CALL);
    expect(s.phase).toBe("3rd");
    s = playOut(s);
    done(s);
  });

  it("only the player to act can act, and wrong action types are rejected", () => {
    const s = newStud({ stacks: THREE, button: 2 });
    const other = s.players.find((p) => p.seat !== to(s))!;
    expect(() => applyAction(s, other.playerId, CHECK)).toThrow();
    expect(() => act(s, to(s), keep)).toThrow();
    expect(() => act(s, to(s), declare("high"))).toThrow();
    expect(legal(s, other.seat)).toBeNull();
  });
});

describe("5-Murder with the real cent stakes (DEFAULT_STUD)", () => {
  const cents = () =>
    startHand({
      handNumber: 1, variant: "murder5", smallBlind: 10, bigBlind: 20, buttonSeat: 2, deck: shuffle(),
      seats: [0, 1, 2].map((i) => ({ seat: i, playerId: `p${i}`, stack: 5000 })),
    });

  it("antes 20 each; early rounds allow bets of 20..100", () => {
    const s = cents();
    for (const p of s.players) expect(p.totalCommitted).toBe(20);
    expect(potSum(s)).toBe(60);
    const l = legal(s, to(s))!;
    expect(l.minRaiseTo).toBe(20);
    expect(l.maxRaiseTo).toBe(100);
    expect(() => act(s, to(s), raise(19))).toThrow();
    expect(() => act(s, to(s), raise(101))).toThrow();
    expect(() => act(s, to(s), raise(100))).not.toThrow();
  });

  it("a bet of 20 must be raised by at least 21", () => {
    let s = cents();
    s = act(s, to(s), raise(20));
    const l = legal(s, to(s))!;
    expect(l.minRaiseTo).toBe(41);
    expect(l.maxRaiseTo).toBe(120);
  });

  it("the final round allows up to 200 and nobody can raise a 200 bet; a down swap costs 50", () => {
    let s = runTo(cents(), "draw1", "exchange");
    expect(legal(s, to(s))!.exchange!.downCost).toBe(50);
    const who = to(s);
    const before = player(s, who).stack;
    s = act(s, who, swap(player(s, who).holeCards[0] as Card));
    expect(player(s, who).stack).toBe(before - 50);
    s = runTo(s, "draw2", "bet");
    const l = legal(s, to(s))!;
    expect(l.minRaiseTo).toBe(20);
    expect(l.maxRaiseTo).toBe(200);
    s = act(s, to(s), raise(200));
    const r = legal(s, to(s))!;
    expect(r.minRaiseTo).toBeNull();
    expect(r.maxRaiseTo).toBeNull();
    s = playOut(s);
    done(s);
  });
});

// ---------- exchange ----------

describe("exchange rounds", () => {
  const cards: Rig["cards"] = {
    0: [undefined, "2c", "3d", "4h"],
    1: [undefined, "5c", "6d", "7h"],
    2: [undefined, "8c", "9d", "Tc"],
  };
  const extra = ["Kh", "Ks"] as Card[];

  it("legalActions in the exchange stage lists the cards and the cost", () => {
    const s = runTo(newStud({ stacks: THREE, button: 2, cards, extra }), "draw1", "exchange");
    expect(s.toActSeat).toBe(0); // lowest showing hand first
    const l = legal(s, 0)!;
    expect(l.canFold).toBe(false);
    expect(l.canCheck).toBe(false);
    expect(l.callAmount).toBe(0);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(l.exchange!.downCards).toEqual(player(s, 0).holeCards);
    expect(l.exchange!.upCards).toEqual(["2c", "3d", "4h"]);
    expect(l.exchange!.downCost).toBe(TEST_STAKES.downExchangeCost);
    expect(l.exchange!.canAffordDown).toBe(true);
    expect(l.declare).toBeUndefined();
    expect(() => act(s, 0, CHECK)).toThrow();
    expect(() => act(s, 0, swap("As"))).toThrow();
  });

  it("swapping a face-down card costs chips that land in the pot; the new card is face down in the same slot", () => {
    const base = runTo(newStud({ stacks: THREE, button: 2, cards, extra, stakes: { downExchangeCost: 2 } }), "draw1", "exchange");
    const p0 = player(base, 0);
    const oldDown = p0.holeCards[1] as Card;
    const potBefore = potSum(base);
    const s = act(base, 0, swap(oldDown));
    const after = player(s, 0);
    expect(after.holeCards).toEqual([p0.holeCards[0], "Kh"]);
    expect(after.upCards).toEqual(p0.upCards);
    expect(after.stack).toBe(p0.stack - 2);
    expect(after.totalCommitted).toBe(p0.totalCommitted);
    expect(s.deadMoney).toBe(2);
    expect(potSum(s)).toBe(potBefore + 2);
    expect(after.lastAction).toBe("Swap down (−2)");
    expect(s.discards).toContain(oldDown);
    expect(s.toActSeat).toBe(1);
    // Nothing face-down leaks into the log.
    const text = s.log.join("\n");
    for (const c of [oldDown, "Kh"]) expect(text).not.toContain(c);
  });

  it("swapping a face-up card is free and the new card takes the same position face up", () => {
    const base = runTo(newStud({ stacks: THREE, button: 2, cards, extra }), "draw1", "exchange");
    const p0 = player(base, 0);
    const s = act(base, 0, swap("3d"));
    const after = player(s, 0);
    expect(after.upCards).toEqual(["2c", "Kh", "4h"]);
    expect(after.holeCards).toEqual(p0.holeCards);
    expect(after.stack).toBe(p0.stack);
    expect(potSum(s)).toBe(potSum(base));
    expect(after.lastAction).toBe("Swap up");
  });

  it("keep leaves everything alone and passes the turn", () => {
    const base = runTo(newStud({ stacks: THREE, button: 2, cards, extra }), "draw1", "exchange");
    const s = act(base, 0, keep);
    expect(player(s, 0).holeCards).toEqual(player(base, 0).holeCards);
    expect(player(s, 0).upCards).toEqual(player(base, 0).upCards);
    expect(player(s, 0).lastAction).toBe("Keep");
    expect(s.deck).toHaveLength(base.deck.length);
    expect(s.toActSeat).toBe(1);
  });

  it("a player who cannot afford the swap is told so and rejected, but may swap up", () => {
    let s = runTo(newStud({ stacks: { 0: 4, 1: 100, 2: 100 }, button: 2, cards, extra, stakes: { downExchangeCost: 5 } }), "draw1", "exchange");
    expect(s.toActSeat).toBe(0);
    expect(legal(s, 0)!.exchange!.canAffordDown).toBe(false);
    expect(player(s, 0).allIn).toBe(false);
    expect(() => act(s, 0, swap(player(s, 0).holeCards[0] as Card))).toThrow();
    s = act(s, 0, swap("2c"));
    expect(legal(s, 1)!.exchange!.canAffordDown).toBe(true);
  });

  it("the betting order is recomputed from the new up cards after the exchange", () => {
    let s = runTo(newStud({ stacks: THREE, button: 2, cards, extra }), "draw1", "exchange");
    s = act(s, 0, swap("4h")); // seat 0 now shows K-3-2
    s = act(s, 1, keep);
    s = act(s, 2, keep);
    expect(s.phase).toBe("draw1");
    expect(s.stage).toBe("bet");
    expect(s.toActSeat).toBe(1); // 7-6-5 is now the lowest showing hand
    expect(player(s, 0).lastAction).toBeNull();
  });

  it("the second exchange round runs, then a final round with a bigger cap", () => {
    let s = runTo(newStud({ stacks: THREE, button: 2, stakes: { maxBetLastRound: 9 } }), "draw2", "exchange");
    s = autoStep(s);
    s = autoStep(s);
    s = autoStep(s);
    expect(s.phase).toBe("draw2");
    expect(s.stage).toBe("bet");
    expect(legal(s, to(s))!.maxRaiseTo).toBe(9);
  });

  it("reshuffles the discards when the deck runs out (8 players exchanging every round)", () => {
    let s = startHand({
      handNumber: 1, variant: "murder5", smallBlind: 1, bigBlind: 2, buttonSeat: 0, deck: shuffle(),
      seats: [...Array(8).keys()].map((i) => ({ seat: i, playerId: `p${i}`, stack: 100 })),
    });
    const everyCardOnce = () => {
      const all = [...s.deck, ...(s.discards ?? []), ...s.players.flatMap((p) => [...p.holeCards, ...(p.upCards ?? [])])];
      expect(all).toHaveLength(52);
      expect(new Set(all).size).toBe(52);
    };
    while (!s.outcome) {
      const seat = to(s);
      const l = legal(s, seat)!;
      s = l.exchange ? act(s, seat, swap(player(s, seat).upCards![0] as Card)) : autoStep(s);
      everyCardOnce();
    }
    expect(s.log.filter((x) => x === "Discards reshuffled").length).toBeGreaterThanOrEqual(1);
    done(s);
  });

  it("folded players' cards go to the discards and leave their hand", () => {
    let s = newStud({ stacks: THREE, button: 2 });
    const a = to(s);
    s = act(s, a, FOLD);
    expect(player(s, a).holeCards).toEqual([]);
    expect(player(s, a).upCards).toEqual([]);
    expect(s.discards).toHaveLength(2);
  });
});

// ---------- fold-out and all-in run-outs ----------

describe("fold-outs and all-ins", () => {
  it("the last player standing wins everything and the uncalled bet is returned", () => {
    let s = newStud({ stacks: THREE, button: 2 });
    const a = to(s);
    s = act(s, a, raise(2));
    s = act(s, to(s), FOLD);
    s = act(s, to(s), FOLD);
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: `p${a}`, amount: 3, potIndex: 0, half: "whole", handName: null }]);
    expect(out.finalStacks[`p${a}`]).toBe(102);
    expect(out.shown).toEqual({});
  });

  it("everyone folding to one player after the exchange also ends the hand", () => {
    let s = runTo(newStud({ stacks: THREE, button: 2 }), "draw1", "bet");
    s = act(s, to(s), raise(2));
    s = act(s, to(s), FOLD);
    s = act(s, to(s), FOLD);
    done(s);
  });

  it("all-in on the first round runs out the hand: exchanges still happen, betting rounds are skipped", () => {
    let s = newStud({ stacks: { 0: 3, 1: 3 }, button: 1 });
    s = act(s, to(s), raise(2));
    s = act(s, to(s), CALL);
    expect(player(s, 0).allIn && player(s, 1).allIn).toBe(true);
    expect(s.phase).toBe("draw1");
    expect(s.stage).toBe("exchange");
    for (const p of s.players) {
      expect(p.holeCards).toHaveLength(2);
      expect(p.upCards).toHaveLength(3);
    }
    expect(legal(s, to(s))!.exchange!.canAffordDown).toBe(false);
    expect(() => act(s, to(s), swap(player(s, to(s)).holeCards[0] as Card))).toThrow();
    s = act(s, to(s), swap(player(s, to(s)).upCards![0] as Card)); // free
    s = act(s, to(s), keep);
    expect(s.phase).toBe("draw2");
    expect(s.stage).toBe("exchange");
    while (s.stage === "exchange") s = act(s, to(s), keep);
    expect(s.stage).toBe("declare");
    while (!s.outcome) {
      expect(s.stage).toBe("declare");
      s = act(s, to(s), declare("both"));
    }
    done(s);
  });

  it("with one player still holding chips, he exchanges (and may pay) while betting is skipped", () => {
    let s = newStud({ stacks: { 0: 3, 1: 100 }, button: 1, cards: { 0: [undefined, "2c"], 1: [undefined, "9c"] } });
    expect(s.toActSeat).toBe(0);
    s = act(s, 0, raise(2));
    s = act(s, 1, CALL);
    expect(s.stage).toBe("exchange");
    while (to(s) !== 1) s = act(s, to(s), keep);
    expect(legal(s, 1)!.exchange!.canAffordDown).toBe(true);
    const before = player(s, 1).stack;
    s = act(s, 1, swap(player(s, 1).holeCards[0] as Card));
    expect(player(s, 1).stack).toBe(before - 1);
    while (s.stage === "exchange") s = act(s, to(s), keep);
    while (!s.outcome) s = autoStep(s);
    // The swap fee is dead money: it stays in the pot rather than coming back as an "uncalled bet".
    expect(s.log.some((x) => x.startsWith("Uncalled bet"))).toBe(false);
    done(s);
  });
});

// ---------- declarations ----------

describe("declare and showdown", () => {
  const antes = { ante: 4 };
  const rigThree = (cards: Rig["cards"]) => newStud({ stacks: THREE, button: 2, cards, stakes: antes });

  it("declarations stay hidden until everyone has declared", () => {
    let s = runTo(rigThree({ 0: FH, 1: LOW, 2: JUNK }), "declare", "declare");
    expect(s.declarationsRevealed).toBe(false);
    const l = legal(s, to(s))!;
    expect(l.declare).toBe(true);
    expect(l.canFold).toBe(false);
    expect(l.canCheck).toBe(false);
    expect(l.exchange).toBeUndefined();
    const first = to(s);
    s = act(s, first, declare("both"));
    expect(s.declarationsRevealed).toBe(false);
    expect(s.outcome).toBeNull();
    expect(player(s, first).lastAction).toBe("Declared");
    expect(s.log.join("\n")).not.toMatch(/declares (High|Low|Both)/);
    s = act(s, to(s), declare("high"));
    expect(s.declarationsRevealed).toBe(false);
    s = act(s, to(s), declare("low"));
    expect(s.declarationsRevealed).toBe(true);
    expect(s.outcome).not.toBeNull();
    expect(s.log.join("\n")).toMatch(/declares Both/);
    expect(player(s, first).lastAction).toBe("Both");
    done(s);
  });

  it("everyone declaring high: the best high hand scoops", () => {
    const s = playOut(rigThree({ 0: FH, 1: LOW, 2: JUNK }), { 0: "high", 1: "high", 2: "high" });
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p0", amount: 12, potIndex: 0, half: "whole", handName: FH_NAME }]);
    expect(out.finalStacks.p0).toBe(108);
  });

  it("everyone declaring low: the best ace-to-five low scoops", () => {
    const s = playOut(rigThree({ 0: FH, 1: LOW, 2: JUNK }), { 0: "low", 1: "low", 2: "low" });
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p1", amount: 12, potIndex: 0, half: "whole", handName: "6-4-3-2-A" }]);
  });

  it("high and low declarers split the pot in halves", () => {
    const s = playOut(rigThree({ 0: FH, 1: LOW, 2: JUNK }), { 0: "high", 1: "low", 2: "high" });
    const out = done(s);
    expect(out.winners).toEqual([
      { playerId: "p0", amount: 6, potIndex: 0, half: "high", handName: FH_NAME },
      { playerId: "p1", amount: 6, potIndex: 0, half: "low", handName: "6-4-3-2-A" },
    ]);
  });

  it("the odd chip of a split goes to the high half", () => {
    const s = playOut(newStud({ stacks: THREE, button: 2, cards: { 0: FH, 1: LOW, 2: JUNK } }), { 0: "high", 1: "low", 2: "high" });
    done(s);
    expect(won(s, 0)).toBe(2);
    expect(won(s, 1)).toBe(1);
    expect(won(s, 2)).toBe(0);
  });

  it("tied lows split their half; the odd chip goes to the tied player closest left of the button", () => {
    const low2 = cs("Ah 2c 3s 4d 6d");
    const s = playOut(newStud({ stacks: THREE, button: 2, cards: { 0: FH, 1: LOW, 2: low2 } }), { 0: "high", 1: "low", 2: "low" });
    done(s);
    expect(won(s, 0)).toBe(2);
    expect(won(s, 1)).toBe(1); // seat 1 comes before seat 2 clockwise from the button (seat 2)
    expect(won(s, 2)).toBe(0);
  });

  it("a Both player who wins both sides takes the whole pot", () => {
    const s = playOut(rigThree({ 0: LOW, 1: KHIGH_X, 2: KHIGH_Y }), { 0: "both", 1: "high", 2: "low" });
    const out = done(s);
    expect(won(s, 0)).toBe(12);
    expect(out.winners.map((w) => w.half).sort()).toEqual(["high", "low"]);
    expect(out.finalStacks.p0).toBe(108);
  });

  it("a Both player who wins high and TIES low gets the high half plus a share of the low half", () => {
    const flush = cs("Ah 2h 3h 4h 6h");
    const tieLow = cs("Ad 2s 3c 4d 6c");
    const s = playOut(rigThree({ 0: flush, 1: tieLow, 2: KHIGH_X }), { 0: "both", 1: "low", 2: "high" });
    done(s);
    expect(won(s, 0)).toBe(6 + 3);
    expect(won(s, 1)).toBe(3);
    expect(won(s, 2)).toBe(0);
  });

  it("a Both player who loses one side gets nothing; the others split", () => {
    const s = playOut(rigThree({ 0: FH, 1: LOW, 2: JUNK }), { 0: "both", 1: "low", 2: "high" });
    done(s);
    expect(won(s, 0)).toBe(0); // best high, but loses low to seat 1
    expect(won(s, 1)).toBe(6);
    expect(won(s, 2)).toBe(6);
  });

  it("a disqualified Both player leaves the other side to take the whole pot", () => {
    const s = playOut(rigThree({ 0: LOW, 1: FH, 2: JUNK }), { 0: "both", 1: "high", 2: "high" });
    const out = done(s);
    // Seat 0 has the best low but loses high to the full house, so it is out; no low contenders remain.
    expect(out.winners).toEqual([{ playerId: "p1", amount: 12, potIndex: 0, half: "whole", handName: FH_NAME }]);
  });

  it("when every contender is a failed Both, the best high hand among all eligible takes the pot", () => {
    const s = playOut(newStud({ stacks: { 0: 100, 1: 100 }, button: 1, cards: { 0: FH, 1: LOW }, stakes: antes }), { 0: "both", 1: "both" });
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p0", amount: 8, potIndex: 0, half: "whole", handName: FH_NAME }]);
    expect(s.log.some((x) => x.includes("no valid declarations"))).toBe(true);
  });

  it("side pots are decided separately among their eligible players", () => {
    // Seat 0 is all-in from the ante (main pot only); seats 1 and 2 add a 2+2 side pot.
    let s = newStud({ stacks: { 0: 4, 1: 100, 2: 100 }, button: 2, cards: { 0: LOW, 1: FH, 2: JUNK }, stakes: antes });
    s = act(s, to(s), raise(2));
    s = act(s, to(s), CALL);
    s = playOut(s, { 0: "low", 1: "high", 2: "low" });
    const out = done(s);
    expect(s.pots).toEqual([
      { amount: 12, eligiblePlayerIds: ["p0", "p1", "p2"] },
      { amount: 4, eligiblePlayerIds: ["p1", "p2"] },
    ]);
    const pick = (i: number) => out.winners.filter((w) => w.potIndex === i).map((w) => [w.playerId, w.amount, w.half]);
    expect(pick(0)).toEqual([["p1", 6, "high"], ["p0", 6, "low"]]);
    expect(pick(1)).toEqual([["p1", 2, "high"], ["p2", 2, "low"]]);
    expect(out.finalStacks).toEqual({ p0: 6, p1: 102, p2: 96 });
  });

  it("outcome.shown has the full five cards (down + up) of every live player", () => {
    const s = playOut(rigThree({ 0: FH, 1: LOW, 2: JUNK }));
    const out = done(s);
    expect(Object.keys(out.shown).sort()).toEqual(["p0", "p1", "p2"]);
    for (const p of s.players) {
      expect(out.shown[p.playerId]).toEqual([...p.holeCards, ...p.upCards!]);
      expect(out.shown[p.playerId]).toHaveLength(5);
    }
    expect([...out.shown.p0!].sort()).toEqual([...FH].sort());
  });

  it("chips bet during the hand are in the pot being split", () => {
    let s = rigThree({ 0: FH, 1: LOW, 2: JUNK });
    s = act(s, to(s), raise(2));
    s = act(s, to(s), CALL);
    s = act(s, to(s), CALL);
    expect(potSum(s)).toBe(18);
    s = playOut(s, { 0: "high", 1: "low", 2: "high" });
    done(s);
    expect(won(s, 0)).toBe(9);
    expect(won(s, 1)).toBe(9);
  });
});

// ---------- cards speak ----------

describe("cards-speak mode (declare off)", () => {
  const stakes = { ante: 4, declare: false };

  it("goes straight to the showdown after the final bet and splits high/low", () => {
    const s = playOut(newStud({ stacks: { 0: 100, 1: 100 }, button: 1, cards: { 0: FH, 1: LOW }, stakes }));
    const out = done(s);
    expect(s.declarationsRevealed).toBe(false);
    expect(out.winners.map((w) => [w.playerId, w.amount, w.half])).toEqual([["p0", 4, "high"], ["p1", 4, "low"]]);
  });

  it("one hand can scoop both halves", () => {
    const s = playOut(newStud({ stacks: { 0: 100, 1: 100 }, button: 1, cards: { 0: LOW, 1: KHIGH_X }, stakes }));
    done(s);
    expect(won(s, 0)).toBe(8);
  });

  it("never asks for declarations", () => {
    let s = newStud({ stacks: THREE, button: 2, stakes });
    const phases = new Set<string>();
    while (!s.outcome) {
      phases.add(`${s.phase}/${s.stage}`);
      s = autoStep(s);
    }
    expect([...phases].some((p) => p.includes("declare"))).toBe(false);
    done(s);
  });

  it("side pots work in cards-speak too", () => {
    let s = newStud({ stacks: { 0: 4, 1: 100, 2: 100 }, button: 2, cards: { 0: LOW, 1: FH, 2: JUNK }, stakes });
    s = act(s, to(s), raise(2));
    s = act(s, to(s), CALL);
    s = playOut(s);
    const out = done(s);
    // Main 12: FH high 6, LOW low 6. Side 4: FH high 2, JUNK low 2.
    expect(out.finalStacks).toEqual({ p0: 6, p1: 102, p2: 96 });
  });
});

// ---------- timeouts and state ----------

describe("timeouts", () => {
  it("betting: check when free, fold when facing a bet", () => {
    let s = newStud({ stacks: THREE, button: 2 });
    const a = to(s);
    s = timeoutAction(s);
    expect(player(s, a).lastAction).toBe("Check");
    s = act(s, to(s), raise(2));
    const b = to(s);
    s = timeoutAction(s);
    expect(player(s, b).folded).toBe(true);
  });

  it("exchange: keep", () => {
    let s = runTo(newStud({ stacks: THREE, button: 2 }), "draw1", "exchange");
    const a = to(s);
    const before = JSON.stringify([player(s, a).holeCards, player(s, a).upCards]);
    s = timeoutAction(s);
    expect(JSON.stringify([player(s, a).holeCards, player(s, a).upCards])).toBe(before);
    expect(player(s, a).lastAction).toBe("Keep");
  });

  it("declare: high", () => {
    let s = runTo(newStud({ stacks: { 0: 100, 1: 100 }, button: 1, cards: { 0: FH, 1: LOW }, stakes: { ante: 4 } }), "declare", "declare");
    s = timeoutAction(s);
    s = timeoutAction(s);
    const out = done(s);
    expect(out.winners).toEqual([{ playerId: "p0", amount: 8, potIndex: 0, half: "whole", handName: FH_NAME }]);
    expect(s.players.map((p) => p.declared)).toEqual(["high", "high"]);
  });

  it("no actions after the hand is over", () => {
    const s = playOut(newStud({ stacks: THREE, button: 2 }));
    expect(() => act(s, 0, CHECK)).toThrow();
    expect(() => timeoutAction(s)).toThrow();
    expect(legal(s, 0)).toBeNull();
  });
});

describe("state hygiene", () => {
  it("applyAction does not mutate the input state", () => {
    const s = newStud({ stacks: THREE, button: 2 });
    const snap = JSON.stringify(s);
    act(s, to(s), raise(2));
    expect(JSON.stringify(s)).toBe(snap);
  });

  it("chips are conserved at every step of a mixed hand with a short stack", () => {
    let s = newStud({ stacks: { 0: 40, 1: 25, 2: 60, 3: 7 }, button: 1, stakes: { ante: 2 } });
    let i = 0;
    while (!s.outcome) {
      expect(s.players.reduce((t, p) => t + p.stack + p.totalCommitted, 0) + (s.deadMoney ?? 0)).toBe(s.startingTotal);
      const l = legal(s, to(s))!;
      const id = `p${to(s)}`;
      if (l.exchange) s = applyAction(s, id, i % 2 ? swap(l.exchange.upCards[0] as Card) : l.exchange.canAffordDown ? swap(l.exchange.downCards[0] as Card) : keep);
      else if (l.declare) s = applyAction(s, id, declare((["high", "low", "both"] as const)[i % 3] as Declaration));
      else if (l.minRaiseTo !== null && i % 3 === 0) s = applyAction(s, id, raise(l.minRaiseTo));
      else s = applyAction(s, id, l.canCheck ? CHECK : CALL);
      i++;
    }
    done(s);
  });
});

describe("swap fees are dead money", () => {
  it("keeps a face-down swap fee in the pot when nobody bets afterwards", () => {
    let s = newStud({ stacks: { 0: 100, 1: 100 }, button: 0 });
    s = runTo(s, "draw1", "exchange");
    const seat = to(s);
    const down = player(s, seat).holeCards[0]!;
    s = act(s, seat, swap(down));
    const before = potSum(s);
    const out = done(playOut(s));
    const totalWon = out.winners.reduce((t, w) => t + w.amount, 0);
    expect(totalWon).toBe(before);
    expect(totalWon).toBe(2 * (TEST_STAKES.ante ?? 0) + TEST_STAKES.downExchangeCost!);
    expect(out.summary.some((l) => /Uncalled/.test(l))).toBe(false);
  });

  it("gives the fee to the winner of a fold-out", () => {
    let s = newStud({ stacks: { 0: 100, 1: 100 }, button: 0 });
    s = runTo(s, "draw1", "exchange");
    const seat = to(s);
    s = act(s, seat, swap(player(s, seat).holeCards[0]!));
    s = runTo(s, "draw1", "bet");
    const bettor = to(s);
    s = act(s, bettor, raise(legal(s, bettor)!.minRaiseTo!));
    s = act(s, to(s), { type: "fold" });
    const out = done(s);
    expect(out.winners[0]!.amount).toBe(2 * (TEST_STAKES.ante ?? 0) + TEST_STAKES.downExchangeCost!);
  });
});
