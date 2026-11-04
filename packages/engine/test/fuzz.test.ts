import { describe, expect, it } from "vitest";
import {
  applyAction,
  legalActions,
  potsView,
  shuffle,
  startHand,
  timeoutAction,
  VARIANTS,
  type HandState,
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
  const roll = rnd(10);
  if (roll === 0 && l.canFold) return { id: p.playerId, action: { type: "fold" } };
  if (roll < 4 && l.minRaiseTo !== null && l.maxRaiseTo !== null) {
    const amount = rnd(3) === 0 ? l.maxRaiseTo : l.minRaiseTo + rnd(l.maxRaiseTo - l.minRaiseTo + 1);
    return { id: p.playerId, action: { type: "raise", amount } };
  }
  return { id: p.playerId, action: l.canCheck ? { type: "check" } : { type: "call" } };
}

describe("fuzz", () => {
  it("random hands always terminate and conserve chips", () => {
    for (let h = 0; h < 4000; h++) {
      const variant = variants[h % variants.length]!;
      const n = 2 + rnd(VARIANTS[variant].maxPlayers - 1);
      const seatNums = [...Array(10).keys()].sort(() => Math.random() - 0.5).slice(0, n).sort((a, b) => a - b);
      const seats = seatNums.map((seat, i) => ({ seat, playerId: `p${i}`, stack: 1 + rnd(rnd(4) === 0 ? 5 : 400) }));
      const start = seats.reduce((s, x) => s + x.stack, 0);
      let state = startHand({
        handNumber: h,
        variant,
        seats,
        buttonSeat: seatNums[rnd(n)]!,
        smallBlind: 1,
        bigBlind: 2,
        deck: shuffle(),
      });

      // Every card dealt is unique.
      const dealt = [...state.players.flatMap((p) => p.holeCards)];
      expect(new Set(dealt).size).toBe(dealt.length);

      let steps = 0;
      while (state.phase !== "complete") {
        expect(++steps).toBeLessThan(500);
        // Live chip count: stacks + everything committed = starting total.
        const live = state.players.reduce((s, p) => s + p.stack + p.totalCommitted, 0);
        expect(live).toBe(start);
        const pick = rnd(20) === 0 ? null : randomAction(state);
        state = pick ? applyAction(state, pick.id, pick.action) : timeoutAction(state);
        for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }

      const out = state.outcome!;
      const total = Object.values(out.finalStacks).reduce((a, b) => a + b, 0);
      expect(total).toBe(start);
      expect(state.board.length === 5 || Object.keys(out.shown).length === 0).toBe(true);
      const won = out.winners.reduce((s, w) => s + w.amount, 0);
      const pots = potsView(state).reduce((s, p) => s + p.amount, 0);
      expect(won).toBe(pots);
      const allCards = [...state.board, ...state.players.flatMap((p) => p.holeCards)];
      expect(new Set(allCards).size).toBe(allCards.length);
    }
  }, 120_000);
});
