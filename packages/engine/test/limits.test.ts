import { describe, expect, it } from "vitest";
import {
  applyAction,
  DEFAULT_HOUSE_LIMIT,
  houseLimitSizing,
  legalActions,
  requiredIncrement,
  shuffle,
  startHand,
  type HandState,
  type HouseLimit,
  type PlayerAction,
  type VariantId,
} from "../src/index.js";

const CHECK: PlayerAction = { type: "check" };
const CALL: PlayerAction = { type: "call" };
const FOLD: PlayerAction = { type: "fold" };
const raise = (amount: number): PlayerAction => ({ type: "raise", amount });

function hand(o: { n?: number; stacks?: number[]; variant?: VariantId; limits?: HouseLimit | undefined }): HandState {
  const stacks = o.stacks ?? Array<number>(o.n ?? 3).fill(5000);
  return startHand({
    handNumber: 1,
    variant: o.variant ?? "nlhe",
    seats: stacks.map((stack, i) => ({ seat: i, playerId: `p${i}`, stack })),
    buttonSeat: 0,
    smallBlind: 10,
    bigBlind: 20,
    deck: shuffle(),
    limits: "limits" in o ? o.limits : DEFAULT_HOUSE_LIMIT,
  });
}
const to = (s: HandState) => s.toActSeat as number;
const act = (s: HandState, a: PlayerAction) => applyAction(s, `p${to(s)}`, a);
const legal = (s: HandState) => legalActions(s, `p${to(s)}`)!;
/** Everyone checks/calls until the flop is dealt. */
function toFlop(s: HandState): HandState {
  while (s.phase === "preflop") s = act(s, legal(s).canCheck ? CHECK : CALL);
  return s;
}

describe("limits helper", () => {
  const rules = { minBet: 20, maxBet: 200, maxRaises: 3, raiseMustExceed: true };
  it("requiredIncrement: opening bet needs minBet; raises must be at least the previous increment", () => {
    expect(requiredIncrement(rules, 0)).toBe(20);
    expect(requiredIncrement(rules, 20)).toBe(20); // a raise by the same amount is a full raise
    expect(requiredIncrement(rules, 5)).toBe(20);
    expect(requiredIncrement(rules, 50)).toBe(50);
    expect(requiredIncrement({ ...rules, raiseMustExceed: false }, 50)).toBe(20);
  });
  it("sizing: a 200 opening bet can be raised to exactly 400 (min = max); null when the minimum exceeds the cap or the raise cap is reached", () => {
    const base = { rules, currentBet: 200, playerBet: 0, stack: 5000, prevIncrement: 200, raises: 0 };
    expect(houseLimitSizing(base)).toEqual({ minRaiseTo: 400, maxRaiseTo: 400 });
    expect(houseLimitSizing({ ...base, prevIncrement: 201 })).toEqual({ minRaiseTo: null, maxRaiseTo: null });
    expect(houseLimitSizing({ ...base, prevIncrement: 30, currentBet: 30, raises: 3 })).toEqual({ minRaiseTo: null, maxRaiseTo: null });
    expect(houseLimitSizing({ ...base, prevIncrement: 30, currentBet: 30 })).toEqual({ minRaiseTo: 60, maxRaiseTo: 230 });
  });
});

describe("board games with a house limit", () => {
  it("preflop the big blind is the opening bet: smallest raise to 40 (by 20), largest to 220", () => {
    const s = hand({});
    expect(to(s)).toBe(0);
    const l = legal(s);
    expect(l.callAmount).toBe(20);
    expect(l.minRaiseTo).toBe(40);
    expect(l.maxRaiseTo).toBe(220);
    expect(() => act(s, raise(39))).toThrow();
    expect(() => act(s, raise(221))).toThrow();
    expect(() => act(s, raise(40))).not.toThrow();
    expect(() => act(s, raise(220))).not.toThrow();
  });

  it("each raise must be at least as big as the last: 40 (by 20), then at least 60", () => {
    let s = act(hand({}), raise(40));
    const l = legal(s);
    expect(l.minRaiseTo).toBe(60);
    expect(l.maxRaiseTo).toBe(240);
    s = act(s, raise(60));
    expect(legal(s).minRaiseTo).toBe(80);
  });

  it("allows only 3 raises per street preflop (big blind is the opening bet), raising by 20 each time", () => {
    let s = hand({});
    s = act(s, raise(40));
    s = act(s, raise(60));
    s = act(s, raise(80));
    const l = legal(s);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(() => act(s, raise(200))).toThrow();
  });

  it("the raise cap applies heads-up as well", () => {
    let s = hand({ n: 2 });
    expect(to(s)).toBe(0); // button is the small blind and acts first
    s = act(s, raise(40));
    s = act(s, raise(60));
    s = act(s, raise(80));
    expect(legal(s).minRaiseTo).toBeNull();
    s = act(s, CALL);
    expect(s.phase).toBe("flop");
    expect(legal(s).minRaiseTo).toBe(20); // the cap resets on the next street
  });

  it("postflop: opening bet between 20 and 200; a bet of 20 can be raised by 20 (to 40)", () => {
    let s = toFlop(hand({}));
    let l = legal(s);
    expect(l.canCheck).toBe(true);
    expect(l.minRaiseTo).toBe(20);
    expect(l.maxRaiseTo).toBe(200);
    expect(() => act(s, raise(19))).toThrow();
    expect(() => act(s, raise(201))).toThrow();
    s = act(s, raise(20));
    l = legal(s);
    expect(l.minRaiseTo).toBe(40);
    expect(l.maxRaiseTo).toBe(220);
  });

  it("after a bet of the 200 maximum, a raise is offered at exactly 400 (min = max) and nothing above it", () => {
    let s = toFlop(hand({}));
    s = act(s, raise(200));
    const l = legal(s);
    expect(l.callAmount).toBe(200);
    expect(l.minRaiseTo).toBe(400);
    expect(l.maxRaiseTo).toBe(400);
    expect(() => act(s, raise(399))).toThrow();
    expect(() => act(s, raise(401))).toThrow();
    expect(() => act(s, raise(400))).not.toThrow();
  });

  it("a 200 bet can be raised to 400, 600 and 800, and the raise cap then stops it", () => {
    let s = toFlop(hand({}));
    s = act(s, raise(200)); // opening bet
    s = act(s, raise(400)); // raise 1
    expect(legal(s).minRaiseTo).toBe(600);
    expect(legal(s).maxRaiseTo).toBe(600);
    s = act(s, raise(600)); // raise 2
    s = act(s, raise(800)); // raise 3
    const l = legal(s);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(() => act(s, raise(1000))).toThrow();
    while (s.phase === "flop") s = act(s, CALL);
    expect(s.phase).toBe("turn");
  });

  it("the $2 cash-game report: a 200 bet, then a raise offered at exactly 400, then exactly 600", () => {
    let s = toFlop(hand({}));
    const bettor = to(s);
    s = act(s, raise(200)); // player 1 bets the $2.00 max on the flop
    const second = to(s);
    expect(second).not.toBe(bettor);
    let l = legal(s);
    expect(l.callAmount).toBe(200);
    expect(l.minRaiseTo).toBe(400);
    expect(l.maxRaiseTo).toBe(400);
    s = act(s, raise(400)); // player 2 raises to exactly $4.00
    const third = to(s);
    expect(third).not.toBe(second);
    l = legal(s);
    expect(l.minRaiseTo).toBe(600);
    expect(l.maxRaiseTo).toBe(600);
    expect(() => act(s, raise(601))).toThrow();
    s = act(s, raise(600)); // player 3 raises to exactly $6.00
    expect(legal(s).minRaiseTo).toBe(800);
  });

  it("raising by the same amount as the previous raise is accepted", () => {
    const s = act(hand({}), raise(40)); // raise of 20 over the big blind
    expect(legal(s).minRaiseTo).toBe(60);
    expect(() => act(s, raise(59))).toThrow();
    expect(() => act(s, raise(60))).not.toThrow(); // another raise of exactly 20
    const t = act(act(s, raise(60)), raise(80)); // a chain of 40, 60, 80
    expect(t.raises).toBe(3);
  });

  it("an all-in for less than the minimum is allowed, does not count as a raise and does not reopen", () => {
    // Seat 0 raises to 100 (inc 80). Seat 1 (small blind) has 110 in total: all-in to 110 is an incomplete raise.
    let s = hand({ stacks: [5000, 110, 5000] });
    s = act(s, raise(100));
    expect(to(s)).toBe(1);
    const l = legal(s);
    expect(l.minRaiseTo).toBe(110);
    expect(l.maxRaiseTo).toBe(110);
    s = act(s, raise(110));
    expect(s.players[1]!.allIn).toBe(true);
    expect(s.raises).toBe(1);
    expect(s.lastRaiseSize).toBe(80);
    // The big blind has not acted since the raise to 100 and may still raise: 110 + 80.
    expect(to(s)).toBe(2);
    expect(legal(s).minRaiseTo).toBe(190);
    s = act(s, CALL);
    expect(to(s)).toBe(0);
    const l0 = legal(s);
    expect(l0.callAmount).toBe(10);
    expect(l0.minRaiseTo).toBeNull(); // not reopened for the player who already acted
    s = act(s, CALL);
    expect(s.phase).toBe("flop");
  });

  it("an all-in exactly equal to the required increment is a full raise and reopens the betting", () => {
    // Seat 0 raises to 100 (inc 80). Seat 1 has 180 in total: an all-in to 180 is exactly 80 over 100, a full raise.
    let s = hand({ stacks: [5000, 180, 5000] });
    s = act(s, raise(100));
    expect(legal(s).minRaiseTo).toBe(180);
    expect(legal(s).maxRaiseTo).toBe(180);
    s = act(s, raise(180));
    expect(s.players[1]!.allIn).toBe(true);
    expect(s.raises).toBe(2);
    expect(s.lastRaiseSize).toBe(80);
    expect(legal(s).minRaiseTo).toBe(260); // the big blind may raise by 80 over 180
    s = act(s, CALL);
    expect(to(s)).toBe(0);
    expect(legal(s).callAmount).toBe(80);
    expect(legal(s).minRaiseTo).toBe(260); // reopened for the player who already acted
  });

  it("the house limit replaces pot-limit sizing in Omaha cash games", () => {
    // Pot-limit omaha, blinds 10/20: a pot-size raise would be 20 + 30 + 20 = 70, but the house rule allows +$2 (to 220).
    const s = hand({ variant: "plo4" });
    expect(legal(s).minRaiseTo).toBe(40);
    expect(legal(s).maxRaiseTo).toBe(220);
    // A tight house maximum of 30 caps the raise at 20 + 30.
    const t = hand({ variant: "plo4", limits: { ...DEFAULT_HOUSE_LIMIT, maxBet: 30 } });
    expect(legal(t).maxRaiseTo).toBe(50);
    // With the house limit off (and in tournaments, which pass no limits), plain pot-limit sizing applies.
    const off = hand({ variant: "plo4", limits: { ...DEFAULT_HOUSE_LIMIT, enabled: false } });
    expect(legal(off).minRaiseTo).toBe(40);
    expect(legal(off).maxRaiseTo).toBe(70);
  });

  it("without limits (absent or disabled) betting is exactly as before", () => {
    for (const limits of [undefined, { ...DEFAULT_HOUSE_LIMIT, enabled: false }]) {
      const s = hand({ limits });
      expect(s.limits).toBeUndefined();
      expect(legal(s).minRaiseTo).toBe(40);
      expect(legal(s).maxRaiseTo).toBe(5000);
    }
  });

  it("conserves chips when limit hands run to showdown", () => {
    let s = hand({ n: 4 });
    s = act(s, raise(100));
    s = act(s, CALL);
    s = act(s, CALL);
    s = act(s, FOLD);
    while (!s.outcome) {
      const l = legal(s);
      if (l.minRaiseTo !== null && s.phase !== "river") s = act(s, raise(l.maxRaiseTo!));
      else s = act(s, l.canCheck ? CHECK : CALL);
    }
    expect(Object.values(s.outcome.finalStacks).reduce((a, b) => a + b, 0)).toBe(s.startingTotal);
  });
});
