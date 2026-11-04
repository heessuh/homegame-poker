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
  it("requiredIncrement: opening bet needs minBet; raises must exceed the previous increment", () => {
    expect(requiredIncrement(rules, 0)).toBe(20);
    expect(requiredIncrement(rules, 20)).toBe(21);
    expect(requiredIncrement(rules, 5)).toBe(20);
    expect(requiredIncrement({ ...rules, raiseMustExceed: false }, 50)).toBe(20);
  });
  it("sizing returns null when the minimum exceeds the cap or the raise cap is reached", () => {
    const base = { rules, currentBet: 200, playerBet: 0, stack: 5000, prevIncrement: 200, raises: 0 };
    expect(houseLimitSizing(base)).toEqual({ minRaiseTo: null, maxRaiseTo: null });
    expect(houseLimitSizing({ ...base, prevIncrement: 30, currentBet: 30, raises: 3 })).toEqual({ minRaiseTo: null, maxRaiseTo: null });
    expect(houseLimitSizing({ ...base, prevIncrement: 30, currentBet: 30 })).toEqual({ minRaiseTo: 61, maxRaiseTo: 230 });
  });
});

describe("board games with a house limit", () => {
  it("preflop the big blind is the opening bet: smallest raise to 41, largest to 220", () => {
    const s = hand({});
    expect(to(s)).toBe(0);
    const l = legal(s);
    expect(l.callAmount).toBe(20);
    expect(l.minRaiseTo).toBe(41);
    expect(l.maxRaiseTo).toBe(220);
    expect(() => act(s, raise(40))).toThrow();
    expect(() => act(s, raise(221))).toThrow();
    expect(() => act(s, raise(41))).not.toThrow();
    expect(() => act(s, raise(220))).not.toThrow();
  });

  it("each raise must be strictly larger than the last: 41 (inc 21) then at least 63", () => {
    let s = act(hand({}), raise(41));
    const l = legal(s);
    expect(l.minRaiseTo).toBe(63);
    expect(l.maxRaiseTo).toBe(241);
    s = act(s, raise(63));
    expect(legal(s).minRaiseTo).toBe(63 + 23);
  });

  it("allows only 3 raises per street preflop (big blind is the opening bet)", () => {
    let s = hand({});
    s = act(s, raise(41));
    s = act(s, raise(63));
    s = act(s, raise(86));
    const l = legal(s);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(() => act(s, raise(200))).toThrow();
  });

  it("the raise cap applies heads-up as well", () => {
    let s = hand({ n: 2 });
    expect(to(s)).toBe(0); // button is the small blind and acts first
    s = act(s, raise(41));
    s = act(s, raise(63));
    s = act(s, raise(86));
    expect(legal(s).minRaiseTo).toBeNull();
    s = act(s, CALL);
    expect(s.phase).toBe("flop");
    expect(legal(s).minRaiseTo).toBe(20); // the cap resets on the next street
  });

  it("postflop: opening bet between 20 and 200; a bet of 20 must be raised by 21", () => {
    let s = toFlop(hand({}));
    let l = legal(s);
    expect(l.canCheck).toBe(true);
    expect(l.minRaiseTo).toBe(20);
    expect(l.maxRaiseTo).toBe(200);
    expect(() => act(s, raise(19))).toThrow();
    expect(() => act(s, raise(201))).toThrow();
    s = act(s, raise(20));
    l = legal(s);
    expect(l.minRaiseTo).toBe(41);
    expect(l.maxRaiseTo).toBe(220);
  });

  it("after a bet of the 200 maximum nobody can raise", () => {
    let s = toFlop(hand({}));
    s = act(s, raise(200));
    const l = legal(s);
    expect(l.callAmount).toBe(200);
    expect(l.minRaiseTo).toBeNull();
    expect(l.maxRaiseTo).toBeNull();
    expect(() => act(s, raise(400))).toThrow();
    s = act(s, CALL);
    s = act(s, CALL);
    expect(s.phase).toBe("turn");
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
    // The big blind has not acted since the raise to 100 and may still raise: 110 + (80 + 1).
    expect(to(s)).toBe(2);
    expect(legal(s).minRaiseTo).toBe(191);
    s = act(s, CALL);
    expect(to(s)).toBe(0);
    const l0 = legal(s);
    expect(l0.callAmount).toBe(10);
    expect(l0.minRaiseTo).toBeNull(); // not reopened for the player who already acted
    s = act(s, CALL);
    expect(s.phase).toBe("flop");
  });

  it("the house limit replaces pot-limit sizing in Omaha cash games", () => {
    // Pot-limit omaha, blinds 10/20: a pot-size raise would be 20 + 30 + 20 = 70, but the house rule allows +$2 (to 220).
    const s = hand({ variant: "plo4" });
    expect(legal(s).minRaiseTo).toBe(41);
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
