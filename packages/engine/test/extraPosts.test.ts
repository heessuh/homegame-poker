import { describe, expect, it } from "vitest";
import { applyAction, legalActions, shuffle, startHand, DEFAULT_HOUSE_LIMIT, type HandState } from "../src/index.js";

function hand(extraPosts: string[], stacks = [5000, 5000, 5000, 5000]): HandState {
  return startHand({
    handNumber: 1,
    variant: "nlhe",
    seats: stacks.map((stack, i) => ({ seat: i, playerId: `p${i}`, stack })),
    buttonSeat: 0, // small blind seat 1, big blind seat 2, seat 3 first to act
    smallBlind: 10,
    bigBlind: 20,
    deck: shuffle(),
    limits: DEFAULT_HOUSE_LIMIT,
    extraPosts,
  });
}
const bets = (s: HandState) => s.players.map((p) => p.bet);

describe("posting a big blind to come in", () => {
  it("a post is a live big blind: first to act can check it", () => {
    const s = hand(["p3"]);
    expect(bets(s)).toEqual([0, 10, 20, 20]);
    expect(s.toActSeat).toBe(3);
    const l = legalActions(s, "p3")!;
    expect(l.canCheck).toBe(true);
    expect(l.callAmount).toBe(0);
    expect(l.minRaiseTo).toBe(40); // the raise rule is unchanged by the post
  });

  it("a post from the button counts toward the call", () => {
    const s = hand(["p0"]);
    expect(bets(s)).toEqual([20, 10, 20, 0]);
    const next = applyAction(s, "p3", { type: "call" });
    expect(legalActions(next, "p0")!.canCheck).toBe(true);
  });

  it("someone in the blinds pays only that blind", () => {
    expect(bets(hand(["p1"]))).toEqual([0, 10, 20, 0]);
    expect(bets(hand(["p2"]))).toEqual([0, 10, 20, 0]);
  });

  it("a short stack posts all-in", () => {
    const s = hand(["p3"], [5000, 5000, 5000, 15]);
    expect(s.players[3]!.bet).toBe(15);
    expect(s.players[3]!.allIn).toBe(true);
    expect(s.toActSeat).toBe(0);
  });

  it("the chips stay in play through the end of the hand", () => {
    let s = hand(["p3"]);
    const total = s.players.reduce((t, p) => t + p.stack + p.totalCommitted, 0);
    for (let i = 0; i < 12 && !s.outcome; i++) {
      s = applyAction(s, `p${s.toActSeat}`, { type: "fold" });
    }
    expect(s.outcome).toBeTruthy();
    expect(Object.values(s.outcome!.finalStacks).reduce((a, b) => a + b, 0)).toBe(total);
    expect(s.outcome!.finalStacks.p2).toBe(5000 + 10 + 20); // the walk wins the small blind and the post
  });
});
