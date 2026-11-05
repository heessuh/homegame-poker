// Wire contract between server and web client. Server is authoritative; the
// client only ever receives a TableView tailored to the viewing player.
// All chip amounts are integers.
import type { Card } from "./cards.js";
import type { VariantId } from "./variants.js";
import type { DealerEntry } from "./ledger.js";

export interface TableConfig {
  variant: VariantId;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number; // 2..10 (capped by the variant's maxPlayers)
  actionTimeoutSec: number; // 0 = no timer, else 5..300
  /** Seconds a player may add to their own clock once per turn ("+15s"); 0 = off. */
  extensionSec: number;
  minBuyIn: number;
  maxBuyIn: number;
  /** "auto": pots go to the best hands. "host": the hand ends with the pot held until the host awards it. */
  awardMode: "auto" | "host";
  mode: "cash" | "tournament";
  tournament: TournamentConfig;
  /** Stakes for stud games (5-Murder). */
  stud: StudStakes;
  /** House betting limit for board games (Hold'em/Omaha). When enabled it replaces no-limit/pot-limit sizing. */
  houseLimit: HouseLimit;
  /** "cents": 1 chip = 1 cent, shown as dollars ($1.25). "chips": plain numbers (tournaments always show chips). */
  money: "cents" | "chips";
}

/**
 * Spread-limit betting used by the house games. A bet or raise INCREMENT must be between minBet and maxBet;
 * with raiseMustExceed, each raise increment must be at least the previous bet/raise increment
 * on that street (preflop, the big blind counts as the opening bet). At most maxRaises raises per round,
 * heads-up included. All-in for less is always allowed and does not reopen betting if incomplete.
 */
export interface HouseLimit {
  enabled: boolean;
  minBet: number;
  maxBet: number;
  maxRaises: number;
  raiseMustExceed: boolean;
}

export const DEFAULT_HOUSE_LIMIT: HouseLimit = { enabled: true, minBet: 20, maxBet: 200, maxRaises: 3, raiseMustExceed: true };

/** 5-Murder uses the same spread-limit rules as HouseLimit, with a bigger cap in the final round. */
export interface StudStakes {
  ante: number; // every dealt player posts this before the deal
  minBet: number; // smallest bet or raise increment
  maxBet: number; // largest bet or raise increment in every round except the last
  maxBetLastRound: number; // largest bet or raise increment in the final round (after the second exchange)
  downExchangeCost: number; // paid into the pot to swap a face-down card (face-up swaps are free)
  maxRaises: number; // raises allowed per round after the opening bet, heads-up included
  raiseMustExceed: boolean; // each raise increment must be at least the previous one
  /** true: players secretly declare High, Low or Both before the showdown. false: cards speak. */
  declare: boolean;
}

export const DEFAULT_STUD: StudStakes = {
  ante: 20,
  minBet: 20,
  maxBet: 100,
  maxBetLastRound: 200,
  downExchangeCost: 50,
  maxRaises: 3,
  raiseMustExceed: true,
  declare: true,
};

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
  minutes: number; // 1..120
}

export interface TournamentConfig {
  startingStack: number;
  levels: BlindLevel[]; // 1..40; after the last level, the last level repeats
  /** Players may still sit down until this many levels have finished (0 = only before the start). */
  lateRegLevels: number;
}

export const TOURNAMENT_PRESETS: Record<"turbo" | "standard" | "deep", { name: string; config: TournamentConfig }> = {
  turbo: { name: "Turbo (8-minute levels)", config: { startingStack: 3000, lateRegLevels: 2, levels: blindLadder(8) } },
  standard: { name: "Standard (15-minute levels)", config: { startingStack: 5000, lateRegLevels: 3, levels: blindLadder(15) } },
  deep: { name: "Deep stack (20-minute levels)", config: { startingStack: 10000, lateRegLevels: 4, levels: blindLadder(20) } },
};

function blindLadder(minutes: number): BlindLevel[] {
  const bb = [50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 15000, 20000];
  return bb.map((b) => ({ smallBlind: b / 2, bigBlind: b, minutes }));
}

/** Picture badges a player can show next to their name. Numbers "1".."99" are also allowed. */
export const AVATAR_EMOJIS = [
  "🐼", "🐴", "🦁", "🐯", "🐻", "🐨", "🦊", "🐺", "🐸", "🐵", "🐧", "🦉", "🦅", "🐬", "🦈", "🐙",
  "🐢", "🐍", "🐉", "🦄", "🐮", "🐷", "🐔", "🐰", "🐱", "🐶", "🦓", "🦒", "🐘", "🦘",
  "♠️", "♥️", "♦️", "♣️", "🃏", "🎲", "🎯", "🏆", "👑", "💎", "🔥", "⚡", "🌙", "⭐", "🍀", "🌵",
  "🍺", "🍷", "☕", "🍕", "🌮", "🎸", "⚽", "🏀", "🎱", "🚀", "😎", "🤠", "🥷", "🤖", "👻", "💀",
] as const;

export function isValidAvatar(a: string): boolean {
  return (AVATAR_EMOJIS as readonly string[]).includes(a) || /^[1-9][0-9]?$/.test(a);
}

export const DEFAULT_CONFIG: TableConfig = {
  variant: "nlhe",
  smallBlind: 10,
  bigBlind: 20,
  maxSeats: 9,
  actionTimeoutSec: 30,
  extensionSec: 15,
  minBuyIn: 500,
  maxBuyIn: 5000,
  awardMode: "host",
  mode: "cash",
  tournament: TOURNAMENT_PRESETS.standard.config,
  stud: DEFAULT_STUD,
  houseLimit: DEFAULT_HOUSE_LIMIT,
  money: "cents",
};

/** "raise" covers both bet and raise; amount is the player's TOTAL contribution on this street after the action. */
export type PlayerAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; amount: number }
  /** Stud exchange rounds: keep everything, or swap one card. A face-down swap costs StudStakes.downExchangeCost. */
  | { type: "exchange"; card: Card | null }
  /** Stud declare round. Declaring "both" means you must win or tie BOTH sides, or you get nothing. */
  | { type: "declare"; choice: Declaration };

export type Declaration = "high" | "low" | "both";

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (0 when checking is possible). Capped at the player's stack. */
  callAmount: number;
  /** Null when raising is not allowed (e.g. facing an incomplete all-in, or not enough chips). */
  minRaiseTo: number | null;
  /** All-in amount for no-limit; pot-size raise (capped at stack) for pot-limit. */
  maxRaiseTo: number | null;
  /** Stud only, during an exchange stage (betting fields are then all off). */
  exchange?: { downCards: Card[]; upCards: Card[]; downCost: number; canAffordDown: boolean };
  /** Stud only, during the declare stage. */
  declare?: boolean;
}

export type Phase =
  | "preflop" | "flop" | "turn" | "river"
  // Stud (5-Murder): 2nd..5th = number of cards dealt; draw1/draw2 = exchange rounds; declare = secret declarations.
  | "2nd" | "3rd" | "4th" | "5th" | "draw1" | "draw2" | "declare"
  | "showdown" | "complete";

export interface SeatView {
  seat: number;
  playerId: string;
  name: string;
  stack: number;
  /** Chips committed on the current street. */
  bet: number;
  inHand: boolean; // dealt into the current hand and not folded
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  connected: boolean;
  isButton: boolean;
  avatar: string | null; // an AVATAR_EMOJIS entry or "1".."99"
  /** Host override of the action timer for this player: null = table default, 0 = no limit. */
  timeLimitSec: number | null;
  /** Face-down cards: own always; others only when revealed at showdown. Null = hidden or no cards. */
  holeCards: Card[] | null;
  /** Number of face-down cards this player holds (so others can draw card backs). */
  holeCount: number;
  /** Stud: face-up cards, visible to everyone. Empty for board games. */
  upCards: Card[];
  /** Stud declare: null until everyone has declared, then each live player's choice. */
  declared: Declaration | null;
  hasDeclared: boolean;
  lastAction: string | null; // e.g. "Raise to 12", "Check", "Fold"
}

export interface PotView {
  /** Chips from completed streets only; current-street bets are in SeatView.bet. */
  amount: number;
  eligiblePlayerIds: string[];
}

export interface WinnerView {
  playerId: string;
  amount: number;
  potIndex: number;
  half: "high" | "low" | "whole";
  handName: string | null; // null when everyone else folded
}

export interface HandView {
  handNumber: number;
  phase: Phase;
  board: Card[];
  pots: PotView[];
  toActSeat: number | null;
  /** What the player to act is doing: betting, exchanging (stud) or declaring (stud). */
  stage: "bet" | "exchange" | "declare" | null;
  actionDeadline: number | null; // epoch ms
  /** Present only for the viewer, only when it is the viewer's turn. */
  legal: LegalActions | null;
  deckHash: string;
  winners: WinnerView[] | null;
}

export interface LedgerEntry {
  playerId: string;
  name: string;
  buyIns: number;
  cashOuts: number;
  stack: number; // current chips at the table (0 if not seated)
  net: number; // stack + cashOuts - buyIns
}

/** Revealed after a hand completes so anyone can recompute the deck. See docs/FAIRNESS.md. */
export interface HandFair {
  algorithm: "mochapoker-v1";
  serverSeed: string; // 64 hex chars
  serverSeedHash: string; // sha256 of the seed bytes, published before the deal
  clientSeeds: Record<string, string>; // playerId -> 32 hex chars, only players who contributed
  material: string;
}

/** The all-in moment of a board-game hand: betting closed with cards to come and no further decisions possible. */
export interface RunoutSnapshot {
  /** Community cards showing at that moment (0 = preflop, 3 = flop, 4 = turn). */
  boardLen: number;
  /** Players still in the hand (all of them show down). */
  live: string[];
  /** The pots the showdown will use; uncalled chips already returned. */
  pots: PotView[];
}

/**
 * What the luck report needs to rebuild a board-game deal exactly from `reveal.deck`.
 * Deal: one card at a time to each player in `dealOrder` (starting left of the button), repeated `holeCards` times;
 * then burn 1 + flop 3, burn 1 + turn, burn 1 + river. Absent on records made before it existed.
 */
export type FoldStreet = "preflop" | "flop" | "turn" | "river";

export interface HandLuckData {
  v: 1;
  /** The street each player folded on. Players not listed never folded (showdown, or everyone else folded). */
  foldStreet?: Record<string, FoldStreet>;
  /** Everyone dealt in, in the order they received cards. */
  dealOrder: string[];
  runout?: RunoutSnapshot;
}

export interface HandRecord {
  handNumber: number;
  variant: VariantId;
  deckHash: string;
  reveal: { deck: Card[]; salt: string };
  /** Provably fair shuffle data ("mochapoker-v1"); absent on records made before it existed. */
  fair?: HandFair;
  board: Card[];
  winners: WinnerView[];
  summary: string[];
  /** Cards revealed at showdown (all of each player's cards), and player names at the time of the hand. */
  shown: Record<string, Card[]>;
  names: Record<string, string>;
  endedAt: number;
  /** Data for the luck report (board games only); older records lack it and are skipped there. */
  luck?: HandLuckData;
}

export interface PendingAward {
  handNumber: number;
  /** Total chips waiting for the host to hand out. */
  amount: number;
  /** Everyone dealt into the hand; the host may award to any of them. */
  candidatePlayerIds: string[];
  /** What automatic awarding would have paid, shown as a starting point. */
  suggested: { playerId: string; amount: number }[];
}

export interface TournamentStanding {
  playerId: string;
  name: string;
  stack: number;
  place: number | null; // finishing place once eliminated (1 = winner)
}

export interface TournamentView {
  status: "registering" | "running" | "finished";
  levelIndex: number; // 0-based
  level: BlindLevel;
  nextLevel: BlindLevel | null;
  /** Epoch ms when the current level ends; null while paused or not running. */
  levelEndsAt: number | null;
  /** Remaining ms in the level, kept current while paused. */
  levelRemainingMs: number;
  startingStack: number;
  lateRegOpen: boolean;
  playersLeft: number;
  standings: TournamentStanding[]; // live players by stack, then eliminated by place
}

/** One line per finished hand for the history list; full detail comes from getHand. */
export interface HandListItem {
  handNumber: number;
  variant: VariantId;
  endedAt: number; // epoch ms
  pot: number;
  /** e.g. "Ana $3.20 (High), Bo $3.20 (Low)" — names and money already formatted. */
  result: string;
}

export interface TableView {
  tableId: string;
  hostPlayerId: string | null;
  you: { playerId: string; seat: number | null; isHost: boolean };
  config: TableConfig;
  /** Applies at the start of the next hand. */
  pendingConfig: TableConfig | null;
  status: "waiting" | "playing" | "paused";
  seats: (SeatView | null)[]; // length = config.maxSeats
  hand: HandView | null;
  lastHand: HandRecord | null;
  ledger: LedgerEntry[];
  log: string[]; // most recent last, capped
  /** Tamper-evident record of host (dealer) actions: newest entries only; fetch the rest with getDealerLog. */
  dealerLog: { count: number; headHash: string; tail: DealerEntry[] };
  /** Set while awardMode is "host" and a finished hand's pot is waiting to be awarded. Next hand waits for it. */
  pendingAward: PendingAward | null;
  /** Every finished hand this session, newest first (light entries). */
  handList: HandListItem[];
  /** True when the viewer is to act, has a running timer, and hasn't used this turn's extension. */
  canExtend: boolean;
  /** The dealer asked to shuffle the seats; it happens when the current hand ends. */
  seatShufflePending: boolean;
  tournament: TournamentView | null; // null in cash mode
  /** Site-wide message (e.g. the monthly budget has been reached); null normally. */
  siteNotice: string | null;
  /** Commitment to the server seed for the NEXT hand; clients answer with a "seed" event. Null when fair shuffling is off (test decks). */
  fairness: { nextHandNumber: number; serverSeedHash: string } | null;
}

// ---- Socket.IO events ----
export interface ClientToServerEvents {
  join: (p: { tableId: string; name: string; playerToken: string; avatar?: string | null }) => void;
  setAvatar: (p: { avatar: string | null }) => void;
  sit: (p: { seat: number; buyIn: number }) => void;
  stand: () => void; // cash out at end of current hand
  sitOut: (p: { sittingOut: boolean }) => void;
  /** Ask for extensionSec more seconds on your own clock (once per turn). */
  extendTime: () => void;
  /** Full detail of a finished hand (deck reveal, summary lines, shown cards). */
  getHand: (p: { handNumber: number }, ack: (rec: HandRecord | null) => void) => void;
  /** The whole session log (view.log only carries the latest lines). */
  getLog: (ack: (lines: string[]) => void) => void;
  /** The complete dealer ledger, oldest first. */
  getDealerLog: (ack: (entries: DealerEntry[]) => void) => void;
  action: (p: PlayerAction) => void;
  "host:start": () => void;
  "host:pause": (p: { paused: boolean }) => void;
  "host:config": (p: Partial<TableConfig>) => void;
  "host:kick": (p: { playerId: string }) => void;
  "host:shuffleSeats": () => void;
  "host:sitOut": (p: { playerId: string; sittingOut: boolean }) => void; // dealer marks a player away / back
  /** Rebuys are dealer-only: a positive delta is recorded as a buy-in (and sits a busted player back in), negative as a cash-out. Between hands; queued during a hand. */
  "host:adjustStack": (p: { playerId: string; delta: number }) => void;
  /** Save this table's settings as the house defaults every NEW table starts with. */
  "host:saveDefaults": () => void;
  /** Hand out a pending pot. Amounts are non-negative integers that must sum to pendingAward.amount. */
  "host:award": (p: { awards: { playerId: string; amount: number }[] }) => void;
  /** Move chips from one player's stack to another's. Applied at once between hands, queued during a hand. */
  "host:transfer": (p: { fromPlayerId: string; toPlayerId: string; amount: number }) => void;
  "host:playerTimer": (p: { playerId: string; seconds: number | null }) => void; // null = table default, 0 = no limit, else 10..300
  "host:addTime": (p: { playerId: string; seconds: number }) => void; // extends the current deadline if that player is to act
  "host:forceTimeout": (p: { playerId: string }) => void; // act for them now (check, else fold) if they are to act
  /** Tournament clock controls while running. */
  "host:tournamentLevel": (p: { delta: 1 | -1 }) => void; // jump a level forward/back; new blinds apply next hand
  "host:tournamentClock": (p: { addMs: number }) => void; // add/remove time on the current level
  /** Session review: every dealt hand with all hole cards revealed after the hand (the deck is public by then). Newest first, paged. */
  getSessionReview: (p: { filter: ReviewFilter; page: number }, ack: (r: SessionReview) => void) => void;
  /** RNG audit: observed deal statistics against exact poker math, for this table or the whole site. */
  getRngAudit: (p: { scope: RngAuditScope }, ack: (report: RngAuditReport) => void) => void;
  /** Contribute a random client seed (32 hex chars) to the shuffle of hand nextHandNumber. One per player; later ones replace earlier ones until the deal. */
  seed: (p: { handNumber: number; clientSeed: string }) => void;
}

export interface ServerToClientEvents {
  state: (view: TableView) => void;
  error: (p: { message: string }) => void;
}

// ---- Session review ----
export type ReviewFilter = "all" | "folded-best" | "won-without-best";

export interface ReviewPlayer {
  playerId: string;
  name: string;
  hole: Card[];
  /** "unknown" for records made before fold streets were recorded. */
  outcome: "folded" | "showdown" | "won-uncontested" | "unknown";
  foldStreet: FoldStreet | null;
  /** Held the best hand at a river showdown had nobody folded (ties count). */
  best: boolean;
  /** Chips won in the hand. */
  won: number;
}

export type ReviewHand =
  | { available: false; handNumber: number; variant: VariantId; endedAt: number; reason: "stud" | "old" | "bad" }
  | {
      available: true;
      handNumber: number;
      variant: VariantId;
      endedAt: number;
      /** The board that was actually dealt. */
      board: Card[];
      /** The complete five-card board, including cards never dealt because the hand ended early. */
      fullBoard: Card[];
      players: ReviewPlayer[];
      /** Players who folded a hand that would have been best at the river. */
      foldedBest: string[];
      /** Everyone who won chips lacked the best hand. */
      winnerNotBest: boolean;
    };

export interface SessionReview {
  filter: ReviewFilter;
  page: number;
  pageSize: number;
  /** Hands matching the filter. */
  total: number;
  /** All hands in the history. */
  totalHands: number;
  hands: ReviewHand[];
}

// ---- RNG audit ----
export type RngAuditScope = "site" | "table";
export type RngAuditVerdict = "fair" | "unusual" | "investigate" | "too-few-hands";

export interface RngAuditRow {
  label: string;
  /** How many samples fell in this row. */
  observed: number;
  /** What a fair, uniformly shuffled deck gives (exact poker math), in percent. */
  expectedPct: number;
  observedPct: number;
  /** The range (percent) the observed share should land in 95% of the time for a fair deck. */
  ci95: [number, number];
  /** Per-row detail, e.g. the p-value of one deck position. */
  note?: string;
}

export interface RngAuditLens {
  id: string;
  title: string;
  plainEnglish: string;
  /** Number of samples this lens drew (not hands). */
  samples: number;
  rows: RngAuditRow[];
  chiSquare: number;
  df: number;
  /** NaN is sent as null by JSON; clients treat a missing p-value as "not enough data". */
  pValue: number | null;
  verdict: RngAuditVerdict;
  /** Hands needed before this lens can be tested at all. */
  minHands: number;
}

export interface RngAuditReport {
  scope: RngAuditScope;
  hands: number;
  /** ISO time the counting began. */
  since: string;
  lenses: RngAuditLens[];
  /**
   * All testable lenses combined (Bonferroni: smallest p-value × number of lenses tested), so that running
   * several checks at once doesn't make a fair deck look "unusual" by chance. Null until any lens is testable.
   */
  overall: { verdict: RngAuditVerdict; pValue: number; tested: number } | null;
  /** Per-player luck (table scope only): who was dealt the best hands, and all-in luck. */
  luck?: LuckReport;
}

/** One row of the luck report. Money is in cents. Only aggregates: no cards of any hand. */
export interface LuckPlayerRow {
  playerId: string;
  name: string;
  handsDealt: number;
  /** Hands in which this player held the best river hand (a tie counts as a share). */
  timesBest: number;
  /** Sum of 1/n over the hands dealt: what a fair shuffle gives. */
  expectedBest: number;
  bestZ: number | null;
  bestP: number | null;
  bestVerdict: RngAuditVerdict;
  /** Hands where money went in with cards still to come and at least two players contested a pot. */
  allInHands: number;
  allInExpected: number;
  allInActual: number;
  allInZ: number | null;
  allInP: number | null;
  allInVerdict: RngAuditVerdict;
  /** The worse of the two verdicts, adjusted for the number of checks run. */
  verdict: RngAuditVerdict;
}

export interface LuckReport {
  /** Board-game hands that were usable. */
  hands: number;
  /** Hands still being worked out in the background; the numbers cover only the finished ones. */
  pending: number;
  /** Hands left out: 5-Murder (stud), records made before the luck data existed, unusable records. */
  skipped: { stud: number; old: number; bad: number };
  allInHands: number;
  minDealt: number;
  minAllInHands: number;
  players: LuckPlayerRow[];
  /** Chi-square across players of the best-hand counts. */
  table: { chiSquare: number; df: number; pValue: number; verdict: RngAuditVerdict } | null;
  /** All checks together, Bonferroni-adjusted like the main audit. */
  overall: { verdict: RngAuditVerdict; pValue: number; tested: number } | null;
}
