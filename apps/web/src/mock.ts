import { DEFAULT_CONFIG, DEFAULT_STUD, TOURNAMENT_PRESETS } from "@homegame/engine";
import type { Card, Declaration, HandView, SeatView, TableConfig, TableView, VariantId } from "@homegame/engine";
import { cardsOf, sha256Hex } from "./util";

export type FixtureId = "plo5-turn" | "nlhe-showdown" | "waiting-host" | "tournament-plo4" | "award-pending" | "award-viewer" | "history-long"
  | "murder5-bet" | "murder5-exchange" | "murder5-declare" | "murder5-showdown";
export const FIXTURE_LABELS: Record<FixtureId, string> = {
  "plo5-turn": "PLO5 turn, your action",
  "nlhe-showdown": "Hold'em showdown",
  "waiting-host": "Waiting (you host)",
  "tournament-plo4": "Tournament PLO4, level 5 (you host)",
  "award-pending": "Dealer awards pot (you host)",
  "award-viewer": "Award pending (you are not the host)",
  "history-long": "Long session history (60 hands)",
  "murder5-bet": "5-Murder 4th card, your bet",
  "murder5-exchange": "5-Murder Exchange 1, your swap",
  "murder5-declare": "5-Murder Declare",
  "murder5-showdown": "5-Murder showdown (hi/lo split)",
};

function seat(i: number, name: string, stack: number, extra: Partial<SeatView> = {}): SeatView {
  const holeCount = extra.holeCards ? extra.holeCards.length : extra.inHand === false ? 0 : 2;
  return {
    seat: i, playerId: `p${i}`, name, stack, bet: 0, inHand: true, folded: false, allIn: false,
    sittingOut: false, connected: true, isButton: false, avatar: null, timeLimitSec: null, holeCards: null, holeCount, upCards: [], declared: null, hasDeclared: false, lastAction: null, ...extra,
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
    ...DEFAULT_CONFIG, variant: "plo5", smallBlind: 10, bigBlind: 20, maxSeats: 6, actionTimeoutSec: 30, minBuyIn: 500, maxBuyIn: 5000,
  };
  const plo: TableView = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true },
    config: ploCfg, pendingConfig: null, status: "playing",
    seats: [
      seat(0, "You", 2450, { avatar: "🐼", holeCards: cardsOf("As Ks Qd Jd Th"), bet: 0 }),
      seat(1, "Marta", 0, { avatar: "7", holeCount: 5, allIn: true, bet: 0, lastAction: "All-in $8" }),
      seat(2, "Dev", 5400, { avatar: "🦊", holeCount: 5, timeLimitSec: 60, bet: 240, lastAction: "Raise to $2.40" }),
      seat(3, "Okonkwo", 2150, { folded: true, inHand: false, lastAction: "Fold" }),
      seat(4, "Priya", 4800, { avatar: "🔥", holeCount: 5, isButton: true, lastAction: "Call $2.40" }),
      seat(5, "Sam", 1200, { sittingOut: true, inHand: false, connected: false }),
    ],
    hand: {
      handNumber: 12, phase: "turn", board: cardsOf("Js 7d 2c 9h"),
      pots: [{ amount: 2400, eligiblePlayerIds: ["p0", "p1", "p2", "p4"] }, { amount: 960, eligiblePlayerIds: ["p0", "p2", "p4"] }],
      stage: "bet", toActSeat: 0, actionDeadline: now + 22000,
      legal: { canFold: true, canCheck: false, callAmount: 240, minRaiseTo: 480, maxRaiseTo: 1920 },
      deckHash, winners: null,
    },
    lastHand: null,
    ledger: [
      { playerId: "p0", name: "You", buyIns: 5000, cashOuts: 0, stack: 2450, net: -2550 },
      { playerId: "p1", name: "Marta", buyIns: 3000, cashOuts: 0, stack: 0, net: -3000 },
      { playerId: "p2", name: "Dev", buyIns: 4000, cashOuts: 0, stack: 5400, net: 1400 },
      { playerId: "p3", name: "Okonkwo", buyIns: 2000, cashOuts: 0, stack: 2150, net: 150 },
      { playerId: "p4", name: "Priya", buyIns: 4000, cashOuts: 0, stack: 4800, net: 800 },
    ],
    pendingAward: null, siteNotice: null, fairness: null, handList: [], canExtend: false, tournament: null,
    log: [
      "Hand #12 started (5-Card Pot-Limit Omaha High)",
      "Priya posts the small blind $0.10",
      "You post the big blind $0.20",
      "Marta goes all-in for $8",
      "Dev raises to $2.40",
      "Okonkwo folds",
      "Priya calls $2.40",
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
      seat(1, "Alice", 2120, { avatar: "♠️", holeCards: cardsOf("Ah Ad"), isButton: true }),
      seat(2, "You", 980, { avatar: "12", holeCards: cardsOf("Kc Qc"), lastAction: "Call $0.40" }),
      seat(3, "Bo", 0, { folded: true, inHand: false, lastAction: "Fold" }),
      seat(4, "Chen", 1500, { avatar: "🤠", holeCards: cardsOf("9s 9h") }),
      null,
    ],
    hand: {
      handNumber: 31, phase: "showdown", board: cardsOf("Qs 9d 4c Kh 2s"),
      pots: [{ amount: 2460, eligiblePlayerIds: ["p1", "p2", "p4"] }],
      stage: null, toActSeat: null, actionDeadline: null, legal: null, deckHash,
      winners: [{ playerId: "p4", amount: 2460, potIndex: 0, half: "whole", handName: "Three of a kind, Nines" }],
    },
    lastHand: {
      handNumber: 30, variant: "nlhe", deckHash, reveal: { deck, salt }, board: cardsOf("Td 5s 5h 8c Jd"),
      winners: [{ playerId: "p1", amount: 640, potIndex: 0, half: "whole", handName: "Pair of Fives" }],
      summary: ["Alice wins $6.40 with Pair of Fives", "Chen folded on the turn"],
      shown: { p1: cardsOf("5c Ac"), p2: cardsOf("Kd Qd") }, names: { p1: "Alice", p2: "You", p4: "Chen" }, endedAt: now - 120000,
    },
    handList: [
      { handNumber: 30, variant: "nlhe", endedAt: now - 120000, pot: 640, result: "Alice $6.40" },
      { handNumber: 29, variant: "nlhe", endedAt: now - 300000, pot: 180, result: "Chen $1.80" },
    ],
    canExtend: true,
    ledger: [
      { playerId: "p1", name: "Alice", buyIns: 2000, cashOuts: 0, stack: 2120, net: 120 },
      { playerId: "p2", name: "You", buyIns: 1000, cashOuts: 0, stack: 980, net: -20 },
      { playerId: "p3", name: "Bo", buyIns: 1000, cashOuts: 0, stack: 0, net: -1000 },
      { playerId: "p4", name: "Chen", buyIns: 1000, cashOuts: 0, stack: 1500, net: 500 },
    ],
    pendingAward: null, siteNotice: null, fairness: null, tournament: null,
    log: ["Hand #31 started", "Alice raises to $0.40", "You call $0.40", "Chen calls $0.40", "Bo folds", "Showdown", "Chen wins $24.60 with Three of a kind, Nines"],
  };

  const waiting: TableView = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true },
    config: { ...DEFAULT_CONFIG, maxSeats: 9 },
    pendingConfig: { ...DEFAULT_CONFIG, maxSeats: 9, variant: "plo4", bigBlind: 40, smallBlind: 20 },
    status: "waiting",
    seats: [
      seat(0, "You", 2000, { inHand: false, isButton: true }),
      null,
      seat(2, "Dana", 2000, { avatar: "🦄", inHand: false }),
      null, null,
      seat(5, "Eli", 1000, { inHand: false, connected: false }),
      null, null, null,
    ],
    hand: null, lastHand: null,
    ledger: [
      { playerId: "p0", name: "You", buyIns: 2000, cashOuts: 0, stack: 2000, net: 0 },
      { playerId: "p2", name: "Dana", buyIns: 2000, cashOuts: 0, stack: 2000, net: 0 },
      { playerId: "p5", name: "Eli", buyIns: 1000, cashOuts: 0, stack: 1000, net: 0 },
    ],
    pendingAward: null, siteNotice: null, fairness: null, handList: [], canExtend: false, tournament: null,
    log: ["Table created", "Dana sat at seat 3 with $20", "Eli sat at seat 6 with $10"],
  };

  // Tournament: PLO4, level 5, 6 entrants, 2 eliminated, host to act.
  const levels = TOURNAMENT_PRESETS.standard.config.levels;
  const tCfg: TableConfig = {
    ...DEFAULT_CONFIG, variant: "plo4", mode: "tournament", maxSeats: 6, smallBlind: levels[4].smallBlind, bigBlind: levels[4].bigBlind,
    actionTimeoutSec: 30, tournament: TOURNAMENT_PRESETS.standard.config, money: "chips",
  };
  const tourney: TableView = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true },
    config: tCfg, pendingConfig: null, status: "playing",
    seats: [
      seat(0, "You", 6200, { avatar: "🏆", holeCards: cardsOf("Ah Kh Qs Jd"), bet: 0 }),
      seat(1, "Marta", 4100, { avatar: "7", holeCount: 4, bet: 400, lastAction: "Raise to 400", timeLimitSec: 60 }),
      null,
      seat(3, "Dev", 5300, { avatar: "🦊", holeCount: 4, isButton: true }),
      seat(4, "Priya", 4400, { avatar: "🔥", folded: true, inHand: false, lastAction: "Fold" }),
      null,
    ],
    hand: {
      handNumber: 58, phase: "flop", board: cardsOf("Ks 8d 3c"),
      pots: [{ amount: 1100, eligiblePlayerIds: ["p0", "p1", "p3"] }],
      stage: "bet", toActSeat: 0, actionDeadline: now + 19000,
      legal: { canFold: true, canCheck: false, callAmount: 400, minRaiseTo: 800, maxRaiseTo: 3100 },
      deckHash, winners: null,
    },
    lastHand: null,
    ledger: [
      { playerId: "p0", name: "You", buyIns: 5000, cashOuts: 0, stack: 6200, net: 1200 },
      { playerId: "p1", name: "Marta", buyIns: 5000, cashOuts: 0, stack: 4100, net: -900 },
      { playerId: "p3", name: "Dev", buyIns: 5000, cashOuts: 0, stack: 5300, net: 300 },
      { playerId: "p4", name: "Priya", buyIns: 5000, cashOuts: 0, stack: 4400, net: -600 },
    ],
    log: ["Level 5 started: 300/600", "Okonkwo is eliminated in 6th place", "Sam is eliminated in 5th place", "Hand #58 started", "Marta raises to 400"],
    pendingAward: null, siteNotice: null, fairness: null, handList: [], canExtend: false,
    tournament: {
      status: "running", levelIndex: 4, level: levels[4], nextLevel: levels[5], levelEndsAt: now + 7 * 60000 + 23000,
      levelRemainingMs: 7 * 60000 + 23000, startingStack: 5000, lateRegOpen: false, playersLeft: 4,
      standings: [
        { playerId: "p0", name: "You", stack: 6200, place: null },
        { playerId: "p3", name: "Dev", stack: 5300, place: null },
        { playerId: "p4", name: "Priya", stack: 4400, place: null },
        { playerId: "p1", name: "Marta", stack: 4100, place: null },
        { playerId: "p6", name: "Sam", stack: 0, place: 5 },
        { playerId: "p5", name: "Okonkwo", stack: 0, place: 6 },
      ],
    },
  };

  // Dealer decides: hand over, pot waiting for the host (viewer).
  const award: TableView = {
    ...nlhe,
    tableId: "demo", hostPlayerId: "p2", you: { playerId: "p2", seat: 2, isHost: true },
    config: { ...nlheCfg, awardMode: "host" },
    hand: {
      handNumber: 31, phase: "showdown", board: cardsOf("Qs 9d 4c Kh 2s"),
      pots: [{ amount: 2460, eligiblePlayerIds: ["p1", "p2", "p4"] }],
      stage: null, toActSeat: null, actionDeadline: null, legal: null, deckHash, winners: null,
    },
    pendingAward: {
      handNumber: 31, amount: 2460, candidatePlayerIds: ["p1", "p2", "p4"],
      suggested: [{ playerId: "p4", amount: 2460 }],
    },
  };

  // Same pending award, but the viewer (Bo's seat 2 -> "You") is a plain player; the dealer is Alice.
  const awardViewer: TableView = {
    ...award,
    hostPlayerId: "p1", you: { playerId: "p2", seat: 2, isHost: false },
    hand: { ...award.hand!, winners: [{ playerId: "p4", amount: 2460, potIndex: 0, half: "whole", handName: "Three of a kind, Nines" }] },
  };

  // Long session history.
  const variants: VariantId[] = ["nlhe", "plo4", "plo5", "nlhe-hilo", "plo4-8"];
  const histRecords = Array.from({ length: 60 }, (_, i) => {
    const n = 60 - i;
    return { handNumber: n, variant: variants[n % variants.length], endedAt: now - i * 4 * 60000, pot: 200 + ((n * 137) % 4000) };
  });
  const histList = histRecords.map((r) => ({ ...r, result: r.handNumber % 3 === 0 ? "Ana $" + (r.pot / 200).toFixed(2) + " (High), Bo $" + (r.pot / 200).toFixed(2) + " (Low)" : "Chen $" + (r.pot / 100).toFixed(2) }));
  const history: TableView = { ...nlhe, handList: histList };

  // ---- 5-Murder (stud) ----
  const m5Cfg: TableConfig = {
    ...DEFAULT_CONFIG, variant: "murder5" as unknown as VariantId, maxSeats: 8, actionTimeoutSec: 30, minBuyIn: 500, maxBuyIn: 5000,
    stud: { ...DEFAULT_STUD },
  };
  const m5Names = ["You", "Marta", "Dev", "Okonkwo", "Priya", "Sam", "Lena"];
  const m5Avatars = ["🐼", "7", "🦊", "🐯", "🔥", "🎸", "🦄"];
  const m5Ups = ["Ks 9d 4h", "As Ac 7c", "Qd Jd 2s", "8h 8c 3d", "Th 6s 5c", "Ad 4d 9s", "Kc Qh Jc"];
  const m5Ids = m5Names.map((_, i) => `p${i}`);
  const m5Ledger = m5Names.map((n, i) => ({ playerId: `p${i}`, name: n, buyIns: 1000, cashOuts: 0, stack: 1000, net: 0 }));
  const m5Fold: Partial<SeatView> = { folded: true, inHand: false, holeCount: 0, lastAction: "Fold" };
  /** nUp = face-up cards shown by each player; hole = face-down count; mine = your face-down cards. */
  const m5Seats = (nUp: number, hole: number, mine: string, extra: (i: number) => Partial<SeatView> = () => ({})): (SeatView | null)[] =>
    Array.from({ length: 8 }, (_, i) => i === 7 ? null : seat(i, m5Names[i], 900 - i * 70, {
      avatar: m5Avatars[i], holeCount: hole, upCards: cardsOf(m5Ups[i]).slice(0, nUp),
      holeCards: i === 0 ? cardsOf(mine) : null, isButton: i === 6, ...extra(i),
    }));
  const m5Hand = (over: Partial<HandView>): HandView => ({
    handNumber: 7, phase: "4th", board: [], pots: [{ amount: 280, eligiblePlayerIds: m5Ids }],
    stage: "bet", toActSeat: 0, actionDeadline: now + 20000, legal: null, deckHash, winners: null, ...over,
  });
  const m5Base = {
    tableId: "demo", hostPlayerId: "p0", you: { playerId: "p0", seat: 0, isHost: true }, config: m5Cfg, pendingConfig: null,
    status: "playing" as const, lastHand: null, ledger: m5Ledger, pendingAward: null, siteNotice: null, fairness: null, handList: [], canExtend: false, tournament: null,
  };
  const noBet = { canFold: false, canCheck: false, callAmount: 0, minRaiseTo: null, maxRaiseTo: null };

  const m5Bet: TableView = {
    ...m5Base,
    seats: m5Seats(2, 2, "Qh 7s", (i) => i === 2 ? { bet: 20, lastAction: "Bet $0.20" } : i === 3 ? m5Fold : {}),
    hand: m5Hand({ legal: { canFold: true, canCheck: false, callAmount: 20, minRaiseTo: 40, maxRaiseTo: 120 } }),
    log: ["Hand #7 started (5-Murder)", "Everyone antes $0.20", "Dev bets $0.20", "Okonkwo folds"],
  };
  const m5Ex: TableView = {
    ...m5Base,
    seats: m5Seats(3, 2, "Qh 7s", (i) => i === 1 ? { lastAction: "Swap up" } : i === 2 ? { lastAction: "Swap down (−$0.50)" } : i === 3 ? { lastAction: "Keep" } : {}),
    hand: m5Hand({
      phase: "draw1", stage: "exchange", pots: [{ amount: 620, eligiblePlayerIds: m5Ids }],
      legal: { ...noBet, exchange: { downCards: cardsOf("Qh 7s"), upCards: cardsOf("Ks 9d 4h"), downCost: 50, canAffordDown: true } },
    }),
    log: ["Betting round complete", "Exchange 1 begins", "Marta swaps a face-up card", "Dev swaps a face-down card ($0.50)", "Okonkwo keeps all"],
  };
  const m5Decl: TableView = {
    ...m5Base,
    seats: m5Seats(3, 2, "Qh 7s", (i) => i === 1 || i === 4 || i === 6 ? { hasDeclared: true } : i === 5 ? m5Fold : {}),
    hand: m5Hand({
      phase: "declare", stage: "declare", pots: [{ amount: 1480, eligiblePlayerIds: m5Ids }],
      legal: { ...noBet, declare: true },
    }),
    log: ["Betting round complete", "Declare: choose High, Low or Both", "Marta has declared", "Priya has declared", "Lena has declared"],
  };
  const m5Dec: Record<number, Declaration> = { 0: "low", 1: "high", 2: "both", 4: "high", 6: "low" };
  const m5Hole: Record<number, string> = { 0: "2c 3h", 1: "Ah Kd", 2: "Qs Jh", 4: "9c 8s", 6: "Ac 5d" };
  const m5Show: TableView = {
    ...m5Base,
    seats: m5Seats(3, 2, "2c 3h", (i) => i === 3 || i === 5 ? m5Fold : { holeCards: cardsOf(m5Hole[i]), declared: m5Dec[i], hasDeclared: true }),
    hand: m5Hand({
      phase: "showdown", stage: null, toActSeat: null, actionDeadline: null, pots: [{ amount: 1480, eligiblePlayerIds: ["p0", "p1", "p2", "p4", "p6"] }],
      winners: [
        { playerId: "p1", amount: 740, potIndex: 0, half: "high", handName: "Two pair, Aces and Kings" },
        { playerId: "p0", amount: 740, potIndex: 0, half: "low", handName: "Seven-low" },
      ],
    }),
    log: ["Declare: choose High, Low or Both", "Showdown", "Marta wins $7.40 (high) with Two pair, Aces and Kings", "You win $7.40 (low) with Seven-low", "Dev declared both and won neither side"],
  };

  return {
    "murder5-bet": m5Bet, "murder5-exchange": m5Ex, "murder5-declare": m5Decl, "murder5-showdown": m5Show,
    "plo5-turn": plo, "nlhe-showdown": nlhe, "waiting-host": waiting, "tournament-plo4": tourney, "award-pending": award, "award-viewer": awardViewer, "history-long": history,
  };
}
