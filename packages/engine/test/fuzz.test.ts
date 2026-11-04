import { describe, expect, it } from "vitest";
import {
  applyAction,
  legalActions,
  potsView,
  shuffle,
  startHand,
  timeoutAction,
  VARIANTS,
  DEFAULT_STUD,
  type Card,
  type HandState,
  type HouseLimit,
  type StudStakes,
  type PlayerAction,
  type VariantId,
} from "../src/index.js";

// Random legal play across every variant; checks invariants the unit tests can miss.
const variants = Object.keys(VARIANTS) as VariantId[];
const rnd = (n: number) => Math.floor(Math.random() * n);

function randomAction(state: HandState): { id: string; action: PlayerAction } | null {
  const p = state.players.find((x) => x.seat === state.toActSeat);
  if (!p) return null;
  const legal = legalActions(state, p.playerId);
  expect(legal).not.toBeNull();
  const l = legal!;
  if (l.exchange) {
    const ex = l.exchange;
    const options: Array<Card | null> = [null, ...ex.upCards, ...(ex.canAffordDown ? ex.downCards : [])];
    return { id: p.playerId, action: { type: "exchange", card: options[rnd(options.length)]! } };
  }
  if (l.declare) return { id: p.playerId, action: { type: "declare", choice: (["high", "low", "both"] as const)[rnd(3)]! } };
  const roll = rnd(10);
  if (roll === 0 && l.canFold) return { id: p.playerId, action: { type: "fold" } };
  if (l.minRaiseTo !== null || l.maxRaiseTo !== null) {
    expect(l.minRaiseTo).not.toBeNull();
    expect(l.maxRaiseTo).not.toBeNull();
    expect(l.maxRaiseTo!).toBeGreaterThanOrEqual(l.minRaiseTo!);
    if (state.limits) expect(l.maxRaiseTo! - state.currentBet).toBeLessThanOrEqual(state.limits.maxBet);
  }
  if (roll < 4 && l.minRaiseTo !== null && l.maxRaiseTo !== null) {
    const amount = rnd(3) === 0 ? l.maxRaiseTo : l.minRaiseTo + rnd(l.maxRaiseTo - l.minRaiseTo + 1);
    return { id: p.playerId, action: { type: "raise", amount } };
  }
  return { id: p.playerId, action: l.canCheck ? { type: "check" } : { type: "call" } };
}

function randomStakes(): StudStakes {
  const minBet = 1 + rnd(4);
  const maxBet = minBet + rnd(10);
  return {
    ...DEFAULT_STUD,
    declare: rnd(4) !== 0,
    downExchangeCost: rnd(3),
    ante: 1 + rnd(3),
    minBet,
    maxBet,
    maxBetLastRound: maxBet + rnd(10),
    maxRaises: rnd(5),
    raiseMustExceed: rnd(4) !== 0,
  };
}

// Board games: no limit object, a disabled one, or a random enabled spread limit.
function randomLimits(): HouseLimit | undefined {
  const roll = rnd(3);
  if (roll === 0) return undefined;
  const minBet = 1 + rnd(6);
  return { enabled: roll === 1 ? false : true, minBet, maxBet: minBet + rnd(30), maxRaises: rnd(5), raiseMustExceed: rnd(4) !== 0 };
}

describe("fuzz", () => {
  it("random hands always terminate and conserve chips", () => {
    for (let h = 0; h < 4000; h++) {
      const variant = variants[h % variants.length]!;
      const n = 2 + rnd(VARIANTS[variant].maxPlayers - 1);
      const seatNums = [...Array(10).keys()].sort(() => Math.random() - 0.5).slice(0, n).sort((a, b) => a - b);
      const seats = seatNums.map((seat, i) => ({ seat, playerId: `p${i}`, stack: 1 + rnd(rnd(4) === 0 ? 5 : 400) }));
      const stud = VARIANTS[variant].kind === "stud";
      const start = seats.reduce((s, x) => s + x.stack, 0);
      let state = startHand({
        handNumber: h,
        variant,
        seats,
        buttonSeat: seatNums[rnd(n)]!,
        smallBlind: 1,
        bigBlind: 2,
        deck: shuffle(),
        stakes: stud ? randomStakes() : undefined,
        limits: stud ? undefined : randomLimits(),
      });

      // Every card dealt is unique.
      const dealt = [...state.players.flatMap((p) => [...p.holeCards, ...(p.upCards ?? [])])];
      expect(new Set(dealt).size).toBe(dealt.length);

      let steps = 0;
      while (state.phase !== "complete") {
        expect(++steps).toBeLessThan(500);
        // Live chip count: stacks + everything committed = starting total.
        const live = state.players.reduce((s, p) => s + p.stack + p.totalCommitted, 0) + (state.deadMoney ?? 0);
        expect(live).toBe(start);
        const pick = rnd(20) === 0 ? null : randomAction(state);
        state = pick ? applyAction(state, pick.id, pick.action) : timeoutAction(state);
        for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
        if (stud) {
          // Every card is somewhere exactly once: deck, discards or a live hand.
          const all = [...state.deck, ...(state.discards ?? []), ...state.players.flatMap((p) => [...p.holeCards, ...(p.upCards ?? [])])];
          expect(all.length).toBe(52);
          expect(new Set(all).size).toBe(52);
        }
      }

      const out = state.outcome!;
      const total = Object.values(out.finalStacks).reduce((a, b) => a + b, 0);
      expect(total).toBe(start);
      expect(stud || state.board.length === 5 || Object.keys(out.shown).length === 0).toBe(true);
      if (stud) for (const cards of Object.values(out.shown)) expect(cards.length).toBe(5);
      const won = out.winners.reduce((s, w) => s + w.amount, 0);
      const pots = potsView(state).reduce((s, p) => s + p.amount, 0);
      expect(won).toBe(pots);
      const allCards = [...state.board, ...state.players.flatMap((p) => [...p.holeCards, ...(p.upCards ?? [])])];
      expect(new Set(allCards).size).toBe(allCards.length);
    }
  }, 120_000);
});
