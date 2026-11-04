// Wire contract between server and web client. Server is authoritative; the
// client only ever receives a TableView tailored to the viewing player.
// All chip amounts are integers.
import type { Card } from "./cards.js";
import type { VariantId } from "./variants.js";

export interface TableConfig {
  variant: VariantId;
  smallBlind: number;
  bigBlind: number;
  maxSeats: number; // 2..10 (capped by the variant's maxPlayers)
  actionTimeoutSec: number; // 0 = no timer
  minBuyIn: number;
  maxBuyIn: number;
  /** "auto": pots go to the best hands. "host": the hand ends with the pot held until the host awards it. */
  awardMode: "auto" | "host";
  mode: "cash" | "tournament";
  tournament: TournamentConfig;
}

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
  smallBlind: 1,
  bigBlind: 2,
  maxSeats: 9,
  actionTimeoutSec: 30,
  minBuyIn: 40,
  maxBuyIn: 400,
  awardMode: "auto",
  mode: "cash",
  tournament: TOURNAMENT_PRESETS.standard.config,
};

/** "raise" covers both bet and raise; amount is the player's TOTAL contribution on this street after the action. */
export type PlayerAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; amount: number };

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (0 when checking is possible). Capped at the player's stack. */
  callAmount: number;
  /** Null when raising is not allowed (e.g. facing an incomplete all-in, or not enough chips). */
  minRaiseTo: number | null;
  /** All-in amount for no-limit; pot-size raise (capped at stack) for pot-limit. */
  maxRaiseTo: number | null;
}

export type Phase = "preflop" | "flop" | "turn" | "river" | "showdown" | "complete";

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
  /** Own cards always; others only when revealed at showdown. Null = hidden or no cards. */
  holeCards: Card[] | null;
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

export interface HandRecord {
  handNumber: number;
  variant: VariantId;
  deckHash: string;
  reveal: { deck: Card[]; salt: string };
  board: Card[];
  winners: WinnerView[];
  summary: string[];
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
  /** Set while awardMode is "host" and a finished hand's pot is waiting to be awarded. Next hand waits for it. */
  pendingAward: PendingAward | null;
  tournament: TournamentView | null; // null in cash mode
}

// ---- Socket.IO events ----
export interface ClientToServerEvents {
  join: (p: { tableId: string; name: string; playerToken: string; avatar?: string | null }) => void;
  setAvatar: (p: { avatar: string | null }) => void;
  sit: (p: { seat: number; buyIn: number }) => void;
  stand: () => void; // cash out at end of current hand
  sitOut: (p: { sittingOut: boolean }) => void;
  rebuy: (p: { amount: number }) => void; // applied between hands
  action: (p: PlayerAction) => void;
  "host:start": () => void;
  "host:pause": (p: { paused: boolean }) => void;
  "host:config": (p: Partial<TableConfig>) => void;
  "host:kick": (p: { playerId: string }) => void;
  "host:sitOut": (p: { playerId: string; sittingOut: boolean }) => void; // dealer marks a player away / back
  "host:adjustStack": (p: { playerId: string; delta: number }) => void; // between hands, recorded in ledger
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
}

export interface ServerToClientEvents {
  state: (view: TableView) => void;
  error: (p: { message: string }) => void;
}
