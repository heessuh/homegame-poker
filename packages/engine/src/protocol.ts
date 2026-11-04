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
}

export const DEFAULT_CONFIG: TableConfig = {
  variant: "nlhe",
  smallBlind: 1,
  bigBlind: 2,
  maxSeats: 9,
  actionTimeoutSec: 30,
  minBuyIn: 40,
  maxBuyIn: 400,
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
}

// ---- Socket.IO events ----
export interface ClientToServerEvents {
  join: (p: { tableId: string; name: string; playerToken: string }) => void;
  sit: (p: { seat: number; buyIn: number }) => void;
  stand: () => void; // cash out at end of current hand
  sitOut: (p: { sittingOut: boolean }) => void;
  rebuy: (p: { amount: number }) => void; // applied between hands
  action: (p: PlayerAction) => void;
  "host:start": () => void;
  "host:pause": (p: { paused: boolean }) => void;
  "host:config": (p: Partial<TableConfig>) => void;
  "host:kick": (p: { playerId: string }) => void;
  "host:adjustStack": (p: { playerId: string; delta: number }) => void; // between hands, recorded in ledger
}

export interface ServerToClientEvents {
  state: (view: TableView) => void;
  error: (p: { message: string }) => void;
}
