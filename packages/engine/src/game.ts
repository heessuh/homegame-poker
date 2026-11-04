// Poker hand state machine. Pure functions over a JSON-serializable HandState.
import type { Card } from "./cards.js";
import { VARIANTS, splitOf, type VariantId } from "./variants.js";
import type { LegalActions, Phase, PlayerAction, PotView, WinnerView } from "./protocol.js";
import { bestHigh, bestLow8, bestLowAny, type HighResult, type LowResult } from "./evaluate.js";

export interface HandSeatInput {
  seat: number;
  playerId: string;
  stack: number;
}

export interface StartHandInput {
  handNumber: number;
  variant: VariantId;
  seats: HandSeatInput[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  /** Already shuffled, 52 cards. */
  deck: Card[];
}

export interface HandPlayer {
  seat: number;
  playerId: string;
  stack: number;
  /** Chips committed on the current street. */
  bet: number;
  totalCommitted: number;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  lastAction: string | null;
  /** Has acted since the last full raise (internal bookkeeping). */
  hasActed: boolean;
}

export interface HandOutcome {
  winners: WinnerView[];
  finalStacks: Record<string, number>;
  /** Hands revealed at showdown (empty when everyone else folded). */
  shown: Record<string, Card[]>;
  summary: string[];
}

export interface HandState {
  handNumber: number;
  variant: VariantId;
  phase: Phase;
  board: Card[];
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  /** Sorted by ascending seat number. */
  players: HandPlayer[];
  toActSeat: number | null;
  /** Highest total bet on the current street. */
  currentBet: number;
  /** Size of the last full raise on this street (starts at the big blind). */
  lastRaiseSize: number;
  /** Undealt cards (server-secret; never send to clients). */
  deck: Card[];
  burned: Card[];
  startingTotal: number;
  /** Final pots, set when the hand completes. */
  pots: PotView[] | null;
  outcome: HandOutcome | null;
  log: string[];
}

// ---------- helpers ----------

function clone(s: HandState): HandState {
  return JSON.parse(JSON.stringify(s)) as HandState;
}

function playerAt(s: HandState, idx: number): HandPlayer {
  const p = s.players[idx];
  if (!p) throw new Error("internal: bad player index");
  return p;
}

function findPlayer(s: HandState, playerId: string): HandPlayer | undefined {
  return s.players.find((p) => p.playerId === playerId);
}

function btnIndex(s: HandState): number {
  return s.players.findIndex((p) => p.seat === s.buttonSeat);
}

/** Players ordered clockwise starting left of the button. */
function orderFromButton(s: HandState): HandPlayer[] {
  const n = s.players.length;
  const b = btnIndex(s);
  const out: HandPlayer[] = [];
  for (let k = 1; k <= n; k++) out.push(playerAt(s, (b + k) % n));
  return out;
}

function fmtCards(cs: Card[]): string {
  return cs.join(" ");
}

function name(p: HandPlayer): string {
  return `${p.playerId} (seat ${p.seat})`;
}

function post(p: HandPlayer, amount: number): number {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.bet += a;
  p.totalCommitted += a;
  if (p.stack === 0) p.allIn = true;
  return a;
}

// ---------- start ----------

export function startHand(input: StartHandInput): HandState {
  const { seats } = input;
  if (seats.length < 2) throw new Error("need at least 2 players to start a hand");
  const v = VARIANTS[input.variant];
  if (!v) throw new Error(`unknown variant ${String(input.variant)}`);
  if (seats.length > v.maxPlayers) throw new Error(`too many players for ${v.name}`);
  const seatNums = new Set(seats.map((x) => x.seat));
  if (seatNums.size !== seats.length) throw new Error("duplicate seat numbers");
  if (!seatNums.has(input.buttonSeat)) throw new Error("button seat must be one of the seats");
  if (new Set(seats.map((x) => x.playerId)).size !== seats.length) throw new Error("duplicate player ids");
  for (const x of seats) {
    if (!Number.isInteger(x.stack) || x.stack <= 0) throw new Error(`invalid stack for ${x.playerId}`);
  }
  if (input.deck.length < 52) throw new Error("deck must have 52 cards");
  if (!Number.isInteger(input.bigBlind) || input.bigBlind <= 0) throw new Error("invalid big blind");
  if (!Number.isInteger(input.smallBlind) || input.smallBlind < 0) throw new Error("invalid small blind");

  const players: HandPlayer[] = [...seats]
    .sort((a, b) => a.seat - b.seat)
    .map((x) => ({
      seat: x.seat,
      playerId: x.playerId,
      stack: x.stack,
      bet: 0,
      totalCommitted: 0,
      holeCards: [],
      folded: false,
      allIn: false,
      lastAction: null,
      hasActed: false,
    }));

  const s: HandState = {
    handNumber: input.handNumber,
    variant: input.variant,
    phase: "preflop",
    board: [],
    buttonSeat: input.buttonSeat,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    players,
    toActSeat: null,
    currentBet: input.bigBlind,
    lastRaiseSize: input.bigBlind,
    deck: [...input.deck],
    burned: [],
    startingTotal: players.reduce((t, p) => t + p.stack, 0),
    pots: null,
    outcome: null,
    log: [],
  };

  const n = players.length;
  const b = btnIndex(s);
  // Deal hole cards one at a time starting left of the button.
  for (let r = 0; r < v.holeCards; r++) {
    for (let k = 1; k <= n; k++) {
      const c = s.deck.shift();
      if (!c) throw new Error("deck exhausted");
      playerAt(s, (b + k) % n).holeCards.push(c);
    }
  }

  const headsUp = n === 2;
  const sbIdx = headsUp ? b : (b + 1) % n;
  const bbIdx = headsUp ? (b + 1) % n : (b + 2) % n;
  const sb = playerAt(s, sbIdx);
  const bb = playerAt(s, bbIdx);
  const sbPaid = post(sb, input.smallBlind);
  const bbPaid = post(bb, input.bigBlind);
  s.log.push(`Hand #${s.handNumber} (${v.name}), button: seat ${s.buttonSeat}`);
  s.log.push(`${name(sb)} posts small blind ${sbPaid}${sb.allIn ? " (all-in)" : ""}`);
  s.log.push(`${name(bb)} posts big blind ${bbPaid}${bb.allIn ? " (all-in)" : ""}`);

  proceed(s, bbIdx);
  return s;
}

// ---------- flow ----------

function activeCount(s: HandState): number {
  return s.players.filter((p) => !p.folded && !p.allIn).length;
}

function findNeedsAction(s: HandState, lastIdx: number): number {
  const n = s.players.length;
  const act = activeCount(s);
  for (let k = 1; k <= n; k++) {
    const idx = (lastIdx + k) % n;
    const p = playerAt(s, idx);
    if (p.folded || p.allIn) continue;
    if (p.bet < s.currentBet || (!p.hasActed && act >= 2)) return idx;
  }
  return -1;
}

function dealNextStreet(s: HandState): void {
  const burn = s.deck.shift();
  if (!burn) throw new Error("deck exhausted");
  s.burned.push(burn);
  const count = s.phase === "preflop" ? 3 : 1;
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    const c = s.deck.shift();
    if (!c) throw new Error("deck exhausted");
    cards.push(c);
  }
  s.board.push(...cards);
  s.phase = s.phase === "preflop" ? "flop" : s.phase === "flop" ? "turn" : "river";
  const label = s.phase === "flop" ? "Flop" : s.phase === "turn" ? "Turn" : "River";
  s.log.push(`${label}: ${fmtCards(s.board)}`);
}

/** After an action (or a deal), decide who acts next or advance the hand. lastIdx = index of the last actor. */
function proceed(s: HandState, lastIdx: number): void {
  let from = lastIdx;
  for (;;) {
    const live = s.players.filter((p) => !p.folded);
    if (live.length === 1) {
      finishFoldOut(s, live[0] as HandPlayer);
      return;
    }
    const idx = findNeedsAction(s, from);
    if (idx !== -1) {
      s.toActSeat = playerAt(s, idx).seat;
      return;
    }
    // Street is over.
    s.toActSeat = null;
    if (s.phase === "river") {
      s.phase = "showdown";
      resolveShowdown(s);
      return;
    }
    for (const p of s.players) {
      p.bet = 0;
      p.hasActed = false;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    s.currentBet = 0;
    s.lastRaiseSize = s.bigBlind;
    dealNextStreet(s);
    from = btnIndex(s);
  }
}

// ---------- legal actions ----------

function potTotal(s: HandState): number {
  return s.players.reduce((t, p) => t + p.totalCommitted, 0);
}

function computeLegal(s: HandState, p: HandPlayer): LegalActions {
  const toCall = s.currentBet - p.bet;
  const callAmount = Math.min(Math.max(toCall, 0), p.stack);
  const allInTo = p.stack + p.bet;
  const othersCanRespond = s.players.some((o) => o !== p && !o.folded && !o.allIn);
  let minRaiseTo: number | null = null;
  let maxRaiseTo: number | null = null;
  if (p.stack > toCall && !p.hasActed && othersCanRespond) {
    minRaiseTo = Math.min(allInTo, s.currentBet + Math.max(s.lastRaiseSize, s.bigBlind));
    if (VARIANTS[s.variant].betting === "pot-limit") {
      maxRaiseTo = Math.min(allInTo, s.currentBet + potTotal(s) + toCall);
      maxRaiseTo = Math.max(maxRaiseTo, minRaiseTo);
    } else {
      maxRaiseTo = allInTo;
    }
  }
  return { canFold: true, canCheck: toCall <= 0, callAmount, minRaiseTo, maxRaiseTo };
}

export function legalActions(state: HandState, playerId: string): LegalActions | null {
  if (state.outcome || state.toActSeat === null) return null;
  const p = findPlayer(state, playerId);
  if (!p || p.seat !== state.toActSeat) return null;
  return computeLegal(state, p);
}

// ---------- actions ----------

export function applyAction(state: HandState, playerId: string, action: PlayerAction): HandState {
  if (state.outcome || state.toActSeat === null) throw new Error("the hand is over; no actions are allowed");
  const s = clone(state);
  const p = findPlayer(s, playerId);
  if (!p) throw new Error(`unknown player ${playerId}`);
  if (p.seat !== s.toActSeat) throw new Error(`it is not ${playerId}'s turn to act`);
  const legal = computeLegal(s, p);
  const idx = s.players.indexOf(p);

  switch (action.type) {
    case "fold": {
      p.folded = true;
      p.hasActed = true;
      p.lastAction = "Fold";
      s.log.push(`${name(p)} folds`);
      break;
    }
    case "check": {
      if (!legal.canCheck) throw new Error("cannot check while facing a bet; call or fold");
      p.hasActed = true;
      p.lastAction = "Check";
      s.log.push(`${name(p)} checks`);
      break;
    }
    case "call": {
      if (legal.canCheck) {
        p.hasActed = true;
        p.lastAction = "Check";
        s.log.push(`${name(p)} checks`);
        break;
      }
      const paid = post(p, legal.callAmount);
      p.hasActed = true;
      p.lastAction = p.allIn ? `All-in ${p.bet}` : `Call ${p.bet}`;
      s.log.push(`${name(p)} calls ${paid}${p.allIn ? " (all-in)" : ""}`);
      break;
    }
    case "raise": {
      const amount = action.amount;
      if (!Number.isInteger(amount)) throw new Error("raise amount must be an integer");
      if (legal.minRaiseTo === null || legal.maxRaiseTo === null) {
        throw new Error("raising is not allowed here");
      }
      if (amount > legal.maxRaiseTo) throw new Error(`raise to ${amount} exceeds the maximum of ${legal.maxRaiseTo}`);
      if (amount < legal.minRaiseTo) throw new Error(`raise to ${amount} is below the minimum of ${legal.minRaiseTo}`);
      const wasBet = s.currentBet === 0;
      const increment = amount - s.currentBet;
      post(p, amount - p.bet);
      const full = increment >= Math.max(s.lastRaiseSize, s.bigBlind);
      s.currentBet = amount;
      p.hasActed = true;
      if (full) {
        s.lastRaiseSize = increment;
        for (const o of s.players) if (o !== p && !o.folded && !o.allIn) o.hasActed = false;
      }
      p.lastAction = p.allIn ? `All-in ${amount}` : wasBet ? `Bet ${amount}` : `Raise to ${amount}`;
      s.log.push(`${name(p)} ${wasBet ? "bets" : "raises to"} ${amount}${p.allIn ? " (all-in)" : ""}${full ? "" : " (incomplete raise)"}`);
      break;
    }
    default:
      throw new Error("unknown action");
  }

  proceed(s, idx);
  return s;
}

export function timeoutAction(state: HandState): HandState {
  if (state.outcome || state.toActSeat === null) throw new Error("no player to act");
  const p = state.players.find((x) => x.seat === state.toActSeat);
  if (!p) throw new Error("internal: acting player missing");
  return applyAction(state, p.playerId, state.currentBet - p.bet <= 0 ? { type: "check" } : { type: "fold" });
}

// ---------- pots ----------

function buildPots(players: HandPlayer[]): PotView[] {
  const live = players.filter((p) => !p.folded && p.totalCommitted > 0);
  const levels = [...new Set(live.map((p) => p.totalCommitted))].sort((a, b) => a - b);
  const pots: PotView[] = [];
  let prev = 0;
  let allocated = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) amount += Math.min(p.totalCommitted, level) - Math.min(p.totalCommitted, prev);
    allocated += amount;
    pots.push({ amount, eligiblePlayerIds: live.filter((p) => p.totalCommitted >= level).map((p) => p.playerId) });
    prev = level;
  }
  const total = players.reduce((t, p) => t + p.totalCommitted, 0);
  const rest = total - allocated;
  const lastPot = pots[pots.length - 1];
  if (rest > 0 && lastPot) lastPot.amount += rest;
  // Merge adjacent pots with identical eligibility.
  const merged: PotView[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && last.eligiblePlayerIds.join("|") === pot.eligiblePlayerIds.join("|")) last.amount += pot.amount;
    else merged.push({ amount: pot.amount, eligiblePlayerIds: [...pot.eligiblePlayerIds] });
  }
  return merged;
}

export function potsView(state: HandState): PotView[] {
  if (state.pots) return state.pots.map((p) => ({ amount: p.amount, eligiblePlayerIds: [...p.eligiblePlayerIds] }));
  // Only chips from completed streets; current-street bets stay in players[].bet.
  return buildPots(state.players.map((p) => ({ ...p, totalCommitted: p.totalCommitted - p.bet })));
}

/** Return the portion of the largest commitment nobody matched. */
function returnUncalled(s: HandState): void {
  const sorted = [...s.players].sort((a, b) => b.totalCommitted - a.totalCommitted);
  const top = sorted[0];
  const second = sorted[1];
  if (!top || !second) return;
  const refund = top.totalCommitted - second.totalCommitted;
  if (refund > 0) {
    top.totalCommitted -= refund;
    top.stack += refund;
    s.log.push(`Uncalled bet of ${refund} returned to ${name(top)}`);
  }
}

function distribute(amount: number, winners: HandPlayer[], order: HandPlayer[]): Map<string, number> {
  const ordered = order.filter((o) => winners.includes(o));
  const base = Math.floor(amount / ordered.length);
  let rem = amount - base * ordered.length;
  const out = new Map<string, number>();
  for (const w of ordered) {
    let amt = base;
    if (rem > 0) {
      amt += 1;
      rem -= 1;
    }
    out.set(w.playerId, amt);
  }
  return out;
}

function complete(s: HandState, winners: WinnerView[], shown: Record<string, Card[]>): void {
  for (const w of winners) {
    const p = findPlayer(s, w.playerId);
    if (p) p.stack += w.amount;
    s.log.push(`${w.playerId} wins ${w.amount}${w.half === "whole" ? "" : ` (${w.half})`} from pot ${w.potIndex + 1}${w.handName ? ` with ${w.handName}` : ""}`);
  }
  const finalStacks: Record<string, number> = {};
  for (const p of s.players) {
    finalStacks[p.playerId] = p.stack;
    p.bet = 0;
  }
  const total = Object.values(finalStacks).reduce((a, b) => a + b, 0);
  if (total !== s.startingTotal) throw new Error(`internal: chip conservation violated (${total} vs ${s.startingTotal})`);
  s.phase = "complete";
  s.toActSeat = null;
  s.outcome = { winners, finalStacks, shown, summary: [...s.log] };
}

function finishFoldOut(s: HandState, winner: HandPlayer): void {
  s.toActSeat = null;
  returnUncalled(s);
  const amount = potTotal(s);
  s.pots = [{ amount, eligiblePlayerIds: [winner.playerId] }];
  const winners: WinnerView[] = [];
  if (amount > 0) winners.push({ playerId: winner.playerId, amount, potIndex: 0, half: "whole", handName: null });
  complete(s, winners, {});
}

function resolveShowdown(s: HandState): void {
  returnUncalled(s);
  const v = VARIANTS[s.variant];
  const live = s.players.filter((p) => !p.folded);
  const shown: Record<string, Card[]> = {};
  const highs = new Map<string, HighResult>();
  const lows = new Map<string, LowResult | null>();
  for (const p of live) {
    shown[p.playerId] = [...p.holeCards];
    highs.set(p.playerId, bestHigh(p.holeCards, s.board, v.mustUseTwoHole));
    const lowFn = v.lowRule === "any" ? bestLowAny : bestLow8;
    lows.set(p.playerId, splitOf(v) !== "high" ? lowFn(p.holeCards, s.board, v.mustUseTwoHole) : null);
    s.log.push(`${name(p)} shows ${fmtCards(p.holeCards)}: ${(highs.get(p.playerId) as HighResult).name}`);
  }

  const pots = buildPots(s.players);
  s.pots = pots;
  const order = orderFromButton(s);
  const winners: WinnerView[] = [];

  pots.forEach((pot, potIndex) => {
    const eligible = live.filter((p) => pot.eligiblePlayerIds.includes(p.playerId));
    if (eligible.length === 0) return;
    const bestOf = <T extends { score: number }>(get: (p: HandPlayer) => T | null | undefined, higher: boolean): HandPlayer[] => {
      let best: number | null = null;
      let group: HandPlayer[] = [];
      for (const p of eligible) {
        const r = get(p);
        if (!r) continue;
        if (best === null || (higher ? r.score > best : r.score < best)) {
          best = r.score;
          group = [p];
        } else if (r.score === best) group.push(p);
      }
      return group;
    };
    const mode = splitOf(v);
    if (mode === "low") {
      let lowGroup = bestOf((p) => lows.get(p.playerId), false);
      if (v.lowWinner === "second" && lowGroup.length > 0 && lowGroup.length < eligible.length) {
        // FYST: skip the best group; the next-best group (by exact score) wins.
        const bestScore = (lows.get(lowGroup[0]!.playerId) as LowResult).score;
        const rest = eligible.filter((p) => (lows.get(p.playerId) as LowResult).score !== bestScore);
        let next = Infinity;
        for (const p of rest) next = Math.min(next, (lows.get(p.playerId) as LowResult).score);
        lowGroup = rest.filter((p) => (lows.get(p.playerId) as LowResult).score === next);
      }
      if (lowGroup.length > 0) {
        for (const [id, amt] of distribute(pot.amount, lowGroup, order)) {
          if (amt > 0) winners.push({ playerId: id, amount: amt, potIndex, half: "whole", handName: (lows.get(id) as LowResult).name });
        }
      } else {
        // No qualifying low in this pot: best high hand takes it.
        for (const [id, amt] of distribute(pot.amount, bestOf((p) => highs.get(p.playerId), true), order)) {
          if (amt > 0) winners.push({ playerId: id, amount: amt, potIndex, half: "whole", handName: (highs.get(id) as HighResult).name });
        }
      }
      return;
    }
    const highWinners = bestOf((p) => highs.get(p.playerId), true);
    const lowWinners = mode === "hilo" ? bestOf((p) => lows.get(p.playerId), false) : [];
    const split = mode === "hilo" && lowWinners.length > 0;
    const highAmount = split ? Math.ceil(pot.amount / 2) : pot.amount;
    const lowAmount = split ? pot.amount - highAmount : 0;

    for (const [id, amt] of distribute(highAmount, highWinners, order)) {
      if (amt > 0) winners.push({ playerId: id, amount: amt, potIndex, half: split ? "high" : "whole", handName: (highs.get(id) as HighResult).name });
    }
    if (split && lowAmount > 0) {
      for (const [id, amt] of distribute(lowAmount, lowWinners, order)) {
        if (amt > 0) winners.push({ playerId: id, amount: amt, potIndex, half: "low", handName: (lows.get(id) as LowResult).name });
      }
    }
  });

  complete(s, winners, shown);
}
