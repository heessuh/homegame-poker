import { DEFAULT_CONFIG } from "@homegame/engine";
import type { Card, SeatView, TableConfig, TableView } from "@homegame/engine";
import { cardsOf, sha256Hex } from "./util";

export type FixtureId = "plo5-turn" | "nlhe-showdown" | "waiting-host";
export const FIXTURE_LABELS: Record<FixtureId, string> = {
  "plo5-turn": "PLO5 turn, your action",
  "nlhe-showdown": "Hold'em showdown",
  "waiting-host": "Waiting (you host)",
};

function seat(i: number, name: string, stack: number, extra: Partial<SeatView> = {}): SeatView {
  return {
    seat: i, playerId: `p${i}`, name, stack, bet: 0, inHand: true, folded: false, allIn: false,
    sittingOut: false, connected: true, isButton: false, holeCards: null, lastAction: null, ...extra,
  };
}

function fullDeck(): Card[] {
  const out: Card[] = [];
  for (const s of ["c", "d", "h", "s"]) for (const r of "23456789TJQKA") out.push(`${r}${s}` as Card);
  return out.reverse();
}

export async function makeFixtures(): Promise<Record<FixtureId, TableView>> {
  const deck = fullDeck();
  const salt = "9f2c1d7a5b3e48f0";
  const deckHash = await sha256Hex(`${salt}:${deck.join(",")}`);
  const now = Date.now();

  const ploCfg: TableConfig = {
    ...DEFAULT_CONFIG, variant: "plo5", smallBlind: 1, bigBlind: 2, maxSeats: 6, actionTimeoutSec: 30, minBuyIn: 100, maxBuyIn: 1000,
  };
  const plo: TableView = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true },
    config: ploCfg, pendingConfig: null, status: "playing",
    seats: [
      seat(0, "You", 310, { holeCards: cardsOf("As Ks Qd Jd Th"), bet: 0 }),
      seat(1, "Marta", 0, { allIn: true, bet: 0, lastAction: "All-in 80" }),
      seat(2, "Dev", 540, { bet: 24, lastAction: "Raise to 24" }),
      seat(3, "Okonkwo", 215, { folded: true, inHand: false, lastAction: "Fold" }),
      seat(4, "Priya", 480, { isButton: true, lastAction: "Call 8" }),
      seat(5, "Sam", 120, { sittingOut: true, inHand: false, connected: false }),
    ],
    hand: {
      handNumber: 12, phase: "turn", board: cardsOf("Js 7d 2c 9h"),
      pots: [{ amount: 240, eligiblePlayerIds: ["p0", "p1", "p2", "p4"] }, { amount: 96, eligiblePlayerIds: ["p0", "p2", "p4"] }],
      toActSeat: 0, actionDeadline: now + 22000,
      legal: { canFold: true, canCheck: false, callAmount: 24, minRaiseTo: 48, maxRaiseTo: 192 },
      deckHash, winners: null,
    },
    lastHand: null,
    ledger: [
      { playerId: "p0", name: "You", buyIns: 400, cashOuts: 0, stack: 310, net: -90 },
      { playerId: "p1", name: "Marta", buyIns: 300, cashOuts: 0, stack: 0, net: -300 },
      { playerId: "p2", name: "Dev", buyIns: 400, cashOuts: 0, stack: 540, net: 140 },
      { playerId: "p3", name: "Okonkwo", buyIns: 200, cashOuts: 0, stack: 215, net: 15 },
      { playerId: "p4", name: "Priya", buyIns: 400, cashOuts: 0, stack: 480, net: 80 },
    ],
    log: [
      "Hand #12 started (5-Card Pot-Limit Omaha High)",
      "Priya posts the small blind 1",
      "You post the big blind 2",
      "Marta goes all-in for 80",
      "Dev raises to 24",
      "Okonkwo folds",
      "Priya calls 24",
      "Flop: Js 7d 2c",
      "Turn: 9h",
    ],
  };

  const nlheCfg: TableConfig = { ...DEFAULT_CONFIG, maxSeats: 6 };
  const nlhe: TableView = {
    tableId: "demo", hostPlayerId: "p1", you: { playerId: "p2", seat: 2, isHost: false },
    config: nlheCfg, pendingConfig: null, status: "playing",
    seats: [
      null,
      seat(1, "Alice", 212, { holeCards: cardsOf("Ah Ad"), isButton: true }),
      seat(2, "You", 98, { holeCards: cardsOf("Kc Qc"), lastAction: "Call 40" }),
      seat(3, "Bo", 0, { folded: true, inHand: false, lastAction: "Fold" }),
      seat(4, "Chen", 150, { holeCards: cardsOf("9s 9h") }),
      null,
    ],
    hand: {
      handNumber: 31, phase: "showdown", board: cardsOf("Qs 9d 4c Kh 2s"),
      pots: [{ amount: 246, eligiblePlayerIds: ["p1", "p2", "p4"] }],
      toActSeat: null, actionDeadline: null, legal: null, deckHash,
      winners: [{ playerId: "p4", amount: 246, potIndex: 0, half: "whole", handName: "Three of a kind, Nines" }],
    },
    lastHand: {
      handNumber: 30, variant: "nlhe", deckHash, reveal: { deck, salt }, board: cardsOf("Td 5s 5h 8c Jd"),
      winners: [{ playerId: "p1", amount: 64, potIndex: 0, half: "whole", handName: "Pair of Fives" }],
      summary: ["Alice wins 64 with Pair of Fives", "Chen folded on the turn"],
    },
    ledger: [
      { playerId: "p1", name: "Alice", buyIns: 200, cashOuts: 0, stack: 212, net: 12 },
      { playerId: "p2", name: "You", buyIns: 100, cashOuts: 0, stack: 98, net: -2 },
      { playerId: "p3", name: "Bo", buyIns: 100, cashOuts: 0, stack: 0, net: -100 },
      { playerId: "p4", name: "Chen", buyIns: 100, cashOuts: 0, stack: 150, net: 50 },
    ],
    log: ["Hand #31 started", "Alice raises to 40", "You call 40", "Chen calls 40", "Bo folds", "Showdown", "Chen wins 246 with Three of a kind, Nines"],
  };

  const waiting: TableView = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true },
    config: { ...DEFAULT_CONFIG, maxSeats: 9 },
    pendingConfig: { ...DEFAULT_CONFIG, maxSeats: 9, variant: "plo4", bigBlind: 4, smallBlind: 2 },
    status: "waiting",
    seats: [
      seat(0, "You", 200, { inHand: false, isButton: true }),
      null,
      seat(2, "Dana", 200, { inHand: false }),
      null, null,
      seat(5, "Eli", 100, { inHand: false, connected: false }),
      null, null, null,
    ],
    hand: null, lastHand: null,
    ledger: [
      { playerId: "p0", name: "You", buyIns: 200, cashOuts: 0, stack: 200, net: 0 },
      { playerId: "p2", name: "Dana", buyIns: 200, cashOuts: 0, stack: 200, net: 0 },
      { playerId: "p5", name: "Eli", buyIns: 100, cashOuts: 0, stack: 100, net: 0 },
    ],
    log: ["Table created", "Dana sat at seat 3 with 200", "Eli sat at seat 6 with 100"],
  };

  return { "plo5-turn": plo, "nlhe-showdown": nlhe, "waiting-host": waiting };
}
