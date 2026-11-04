// 5-Murder: house stud game with antes, spread-limit betting, two exchange rounds and a high/low/both declaration.
// Pure functions over the same JSON-serializable HandState as game.ts (stud fields are optional there).
// game.ts dispatches here for variants with kind "stud"; callers keep using startHand/legalActions/applyAction.
import type { Card } from "./cards.js";
import { shuffle } from "./shuffle.js";
import { bestHigh, bestLowAny, type HighResult, type LowResult } from "./evaluate.js";
import { DEFAULT_STUD, type Declaration, type LegalActions, type PlayerAction, type StudStakes, type WinnerView } from "./protocol.js";
import { houseLimitSizing, requiredIncrement, validateSpreadRules, type SpreadRules } from "./limits.js";
import {
  btnIndex,
  buildPots,
  withDeadMoney,
  clone,
  complete,
  distribute,
  finishFoldOut,
  findNeedsAction,
  findPlayer,
  fmtCards,
  name,
  orderFromButton,
  playerAt,
  post,
  returnUncalled,
  type HandPlayer,
  type HandState,
  type StartHandInput,
} from "./game.js";

// ---------- helpers ----------

const RANK: Record<string, number> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function ups(p: HandPlayer): Card[] {
  if (!p.upCards) p.upCards = [];
  return p.upCards;
}

function stakesOf(s: HandState): StudStakes {
  return s.stakes ?? DEFAULT_STUD;
}

/**
 * Sort key for the LOWEST showing hand (ace-to-five low on face-up cards only).
 * Group sizes first (any pair is worse than no pair; two pair worse than one pair...), then ranks high to low
 * with the ace low. Lexicographically smaller = lower hand = acts first.
 */
function lowKey(cards: Card[]): number[] {
  const counts = new Map<number, number>();
  for (const c of cards) {
    const r = RANK[c[0] as string] as number;
    const v = r === 14 ? 1 : r;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return [...groups.map((g) => g[1]), ...groups.map((g) => g[0])];
}

function cmpKey(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Players matching `pred`, lowest showing hand first; ties go to whoever is closest to the left of the button. */
function lowOrder(s: HandState, pred: (p: HandPlayer) => boolean): HandPlayer[] {
  const pos = new Map(orderFromButton(s).map((p, i) => [p.playerId, i]));
  return s.players
    .filter(pred)
    .sort((a, b) => cmpKey(lowKey(ups(a)), lowKey(ups(b))) || (pos.get(a.playerId) as number) - (pos.get(b.playerId) as number));
}

function discardsOf(s: HandState): Card[] {
  if (!s.discards) s.discards = [];
  return s.discards;
}

function draw(s: HandState): Card {
  if (s.deck.length === 0) {
    const d = discardsOf(s);
    if (d.length === 0) throw new Error("deck exhausted");
    s.deck = shuffle(d);
    s.discards = [];
    s.log.push("Discards reshuffled");
  }
  return s.deck.shift() as Card;
}

function dealRound(s: HandState, kind: "up" | "down"): void {
  for (const p of orderFromButton(s)) {
    if (p.folded) continue;
    const c = draw(s);
    if (kind === "up") ups(p).push(c);
    else p.holeCards.push(c);
  }
}

function resetRound(s: HandState): void {
  for (const p of s.players) {
    p.bet = 0;
    p.hasActed = false;
    if (!p.folded && !p.allIn) p.lastAction = null;
  }
  s.currentBet = 0;
  s.raises = 0;
  s.lastRaiseSize = 0;
}

// ---------- start ----------

export function startStudHand(input: StartHandInput): HandState {
  const stakes = input.stakes ?? DEFAULT_STUD;
  for (const k of ["ante", "downExchangeCost", "maxRaises"] as const) {
    if (!Number.isInteger(stakes[k]) || stakes[k] < 0) throw new Error(`invalid stud ${k}`);
  }
  validateSpreadRules(stakes, "stud");
  if (!Number.isInteger(stakes.maxBetLastRound) || stakes.maxBetLastRound < stakes.minBet) throw new Error("invalid stud maxBetLastRound");
  const players: HandPlayer[] = [...input.seats]
    .sort((a, b) => a.seat - b.seat)
    .map((x) => ({
      seat: x.seat,
      playerId: x.playerId,
      stack: x.stack,
      bet: 0,
      totalCommitted: 0,
      holeCards: [],
      upCards: [],
      declared: null,
      folded: false,
      allIn: false,
      lastAction: null,
      hasActed: false,
    }));
  const s: HandState = {
    handNumber: input.handNumber,
    variant: input.variant,
    phase: "2nd",
    board: [],
    buttonSeat: input.buttonSeat,
    smallBlind: input.smallBlind,
    bigBlind: input.bigBlind,
    players,
    toActSeat: null,
    currentBet: 0,
    lastRaiseSize: 0,
    deck: [...input.deck],
    burned: [],
    startingTotal: players.reduce((t, p) => t + p.stack, 0),
    pots: null,
    outcome: null,
    log: [],
    stakes,
    stage: null,
    raises: 0,
    queue: [],
    discards: [],
    declarationsRevealed: false,
  };
  s.log.push(`Hand #${s.handNumber} (5-Murder), button: seat ${s.buttonSeat}`);
  // Antes: a short stack posts what it has and is all-in. Antes are completed-pot chips (not street bets).
  for (const p of players) {
    const paid = Math.min(stakes.ante, p.stack);
    p.stack -= paid;
    p.totalCommitted += paid;
    if (p.stack === 0) p.allIn = true;
    p.lastAction = `Ante ${paid}`;
    s.log.push(`${name(p)} antes ${paid}${p.allIn ? " (all-in)" : ""}`);
  }
  // One card at a time starting left of the button: a face-down round, then a face-up round.
  dealRound(s, "down");
  dealRound(s, "up");
  s.log.push(`2nd: ${upSummary(s)}`);
  advance(s, beginBetRound(s));
  return s;
}

function upSummary(s: HandState): string {
  return orderFromButton(s)
    .filter((p) => !p.folded)
    .map((p) => `${p.playerId} ${fmtCards(ups(p))}`)
    .join(", ");
}

// ---------- flow ----------

/** Start a betting round; returns the index "before" the opener so findNeedsAction picks the opener first. */
function beginBetRound(s: HandState): number {
  s.stage = "bet";
  s.currentBet = 0;
  s.raises = 0;
  s.lastRaiseSize = 0;
  const n = s.players.length;
  const opener = lowOrder(s, (p) => !p.folded && !p.allIn)[0];
  if (!opener) return btnIndex(s);
  return (s.players.indexOf(opener) - 1 + n) % n;
}

function beginExchange(s: HandState, phase: "draw1" | "draw2"): void {
  s.phase = phase;
  s.stage = "exchange";
  s.queue = lowOrder(s, (p) => !p.folded).map((p) => p.playerId);
  s.log.push(`Exchange round ${phase === "draw1" ? 1 : 2}`);
}

function beginDeclare(s: HandState): void {
  s.phase = "declare";
  s.stage = "declare";
  s.queue = lowOrder(s, (p) => !p.folded).map((p) => p.playerId);
  s.log.push("Declare: High, Low or Both");
}

/** Betting round finished: deal / exchange / declare / showdown. Returns the from-index for the next betting round. */
function endBetRound(s: HandState): void {
  resetRound(s);
  switch (s.phase) {
    case "2nd":
      s.phase = "3rd";
      dealRound(s, "up");
      s.log.push(`3rd: ${upSummary(s)}`);
      s.stage = "bet";
      break;
    case "3rd":
      s.phase = "4th";
      dealRound(s, "up");
      s.log.push(`4th: ${upSummary(s)}`);
      s.stage = "bet";
      break;
    case "4th":
      s.phase = "5th";
      dealRound(s, "down");
      s.log.push("5th: a face-down card is dealt to each player");
      s.stage = "bet";
      break;
    case "5th":
      beginExchange(s, "draw1");
      break;
    case "draw1":
      beginExchange(s, "draw2");
      break;
    default:
      // Final betting round (after the second exchange) is over.
      if (stakesOf(s).declare) beginDeclare(s);
      else {
        s.phase = "showdown";
        s.stage = null;
        resolveStud(s);
      }
  }
}

/** Drive the hand forward after an action or a stage change until someone must act or the hand ends. */
function advance(s: HandState, fromIdx: number): void {
  for (;;) {
    const live = s.players.filter((p) => !p.folded);
    if (live.length === 1) {
      s.stage = null;
      finishFoldOut(s, live[0] as HandPlayer);
      return;
    }
    if (s.stage === "bet") {
      const idx = findNeedsAction(s, fromIdx);
      if (idx !== -1) {
        s.toActSeat = playerAt(s, idx).seat;
        return;
      }
      s.toActSeat = null;
      endBetRound(s);
      if (s.outcome) return;
      // Betting rounds begin at their opener; exchange/declare stages ignore fromIdx.
      if (s.stage === "bet") fromIdx = beginBetRound(s);
      continue;
    }
    // exchange or declare stage
    const next = (s.queue ?? [])[0];
    if (next !== undefined) {
      s.toActSeat = (findPlayer(s, next) as HandPlayer).seat;
      return;
    }
    s.toActSeat = null;
    if (s.stage === "exchange") {
      resetRound(s);
      fromIdx = beginBetRound(s);
    } else {
      revealAndResolve(s);
      return;
    }
  }
}

// ---------- legal actions ----------

function rulesOf(s: HandState): SpreadRules {
  const st = stakesOf(s);
  return {
    minBet: st.minBet,
    maxBet: s.phase === "draw2" ? st.maxBetLastRound : st.maxBet,
    maxRaises: st.maxRaises,
    raiseMustExceed: st.raiseMustExceed,
  };
}

export function studLegal(s: HandState, p: HandPlayer): LegalActions {
  const st = stakesOf(s);
  if (s.stage === "exchange") {
    return {
      canFold: false,
      canCheck: false,
      callAmount: 0,
      minRaiseTo: null,
      maxRaiseTo: null,
      exchange: {
        downCards: [...p.holeCards],
        upCards: [...ups(p)],
        downCost: st.downExchangeCost,
        canAffordDown: !p.allIn && p.stack >= st.downExchangeCost,
      },
    };
  }
  if (s.stage === "declare") {
    return { canFold: false, canCheck: false, callAmount: 0, minRaiseTo: null, maxRaiseTo: null, declare: true };
  }
  const toCall = s.currentBet - p.bet;
  const callAmount = Math.min(Math.max(toCall, 0), p.stack);
  const allInTo = p.stack + p.bet;
  const othersCanRespond = s.players.some((o) => o !== p && !o.folded && !o.allIn);
  let minRaiseTo: number | null = null;
  let maxRaiseTo: number | null = null;
  if (!p.hasActed && othersCanRespond) {
    const z = houseLimitSizing({
      rules: rulesOf(s),
      currentBet: s.currentBet,
      playerBet: p.bet,
      stack: p.stack,
      prevIncrement: s.lastRaiseSize,
      raises: s.raises ?? 0,
    });
    minRaiseTo = z.minRaiseTo;
    maxRaiseTo = z.maxRaiseTo;
  }
  return { canFold: true, canCheck: toCall <= 0, callAmount, minRaiseTo, maxRaiseTo };
}

// ---------- actions ----------

export function applyStudAction(state: HandState, playerId: string, action: PlayerAction): HandState {
  const s = clone(state);
  const p = findPlayer(s, playerId);
  if (!p) throw new Error(`unknown player ${playerId}`);
  if (p.seat !== s.toActSeat) throw new Error(`it is not ${playerId}'s turn to act`);
  const idx = s.players.indexOf(p);
  const st = stakesOf(s);

  if (s.stage === "exchange") {
    if (action.type !== "exchange") throw new Error("this is an exchange round: swap a card or keep");
    const old = action.card;
    if (old === null) {
      p.lastAction = "Keep";
      s.log.push(`${name(p)} keeps`);
    } else if (p.holeCards.includes(old)) {
      if (p.allIn || p.stack < st.downExchangeCost) throw new Error("you cannot afford to swap a face-down card");
      const at = p.holeCards.indexOf(old);
      const fresh = draw(s);
      p.holeCards[at] = fresh;
      discardsOf(s).push(old);
      p.stack -= st.downExchangeCost;
      // Swap fees are dead money in the main pot: not a bet, so never refunded as uncalled.
      s.deadMoney = (s.deadMoney ?? 0) + st.downExchangeCost;
      if (p.stack === 0) p.allIn = true;
      p.lastAction = `Swap down (−${st.downExchangeCost})`;
      s.log.push(`${name(p)} swaps a face-down card (−${st.downExchangeCost})`);
    } else if (ups(p).includes(old)) {
      const at = ups(p).indexOf(old);
      const fresh = draw(s);
      ups(p)[at] = fresh;
      discardsOf(s).push(old);
      p.lastAction = "Swap up";
      s.log.push(`${name(p)} swaps ${old} for ${fresh}`);
    } else {
      throw new Error("that card is not in your hand");
    }
    s.queue = (s.queue ?? []).slice(1);
    advance(s, idx);
    return s;
  }

  if (s.stage === "declare") {
    if (action.type !== "declare") throw new Error("declare high, low or both");
    if (action.choice !== "high" && action.choice !== "low" && action.choice !== "both") throw new Error("invalid declaration");
    p.declared = action.choice;
    p.lastAction = "Declared"; // never leak the choice before the reveal
    s.log.push(`${name(p)} has declared`);
    s.queue = (s.queue ?? []).slice(1);
    advance(s, idx);
    return s;
  }

  const legal = studLegal(s, p);
  switch (action.type) {
    case "fold": {
      p.folded = true;
      p.hasActed = true;
      p.lastAction = "Fold";
      const d = discardsOf(s);
      d.push(...p.holeCards, ...ups(p));
      p.holeCards = [];
      p.upCards = [];
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
      if (legal.minRaiseTo === null || legal.maxRaiseTo === null) throw new Error("raising is not allowed here");
      if (amount > legal.maxRaiseTo) throw new Error(`raise to ${amount} exceeds the maximum of ${legal.maxRaiseTo}`);
      if (amount < legal.minRaiseTo) throw new Error(`raise to ${amount} is below the minimum of ${legal.minRaiseTo}`);
      const wasBet = s.currentBet === 0;
      const opening = s.lastRaiseSize <= 0;
      const increment = amount - s.currentBet;
      post(p, amount - p.bet);
      const full = increment >= requiredIncrement(rulesOf(s), s.lastRaiseSize);
      s.currentBet = amount;
      p.hasActed = true;
      if (full) {
        if (!opening) s.raises = (s.raises ?? 0) + 1;
        s.lastRaiseSize = increment;
        for (const o of s.players) if (o !== p && !o.folded && !o.allIn) o.hasActed = false;
      }
      p.lastAction = p.allIn ? `All-in ${amount}` : wasBet ? `Bet ${amount}` : `Raise to ${amount}`;
      s.log.push(`${name(p)} ${wasBet ? "bets" : "raises to"} ${amount}${p.allIn ? " (all-in)" : ""}${full ? "" : " (incomplete raise)"}`);
      break;
    }
    case "exchange":
      throw new Error("no exchange is open right now");
    case "declare":
      throw new Error("no declaration is open right now");
    default:
      throw new Error("unknown action");
  }
  advance(s, idx);
  return s;
}

export function studTimeoutAction(state: HandState, playerId: string): HandState {
  const p = findPlayer(state, playerId) as HandPlayer;
  if (state.stage === "exchange") return applyStudAction(state, playerId, { type: "exchange", card: null });
  if (state.stage === "declare") return applyStudAction(state, playerId, { type: "declare", choice: "high" });
  return applyStudAction(state, playerId, state.currentBet - p.bet <= 0 ? { type: "check" } : { type: "fold" });
}

// ---------- showdown ----------

function revealAndResolve(s: HandState): void {
  s.declarationsRevealed = true;
  s.stage = null;
  s.toActSeat = null;
  const label: Record<Declaration, string> = { high: "High", low: "Low", both: "Both" };
  for (const p of s.players) {
    if (p.folded) continue;
    const d = p.declared ?? "high";
    p.lastAction = label[d];
    s.log.push(`${name(p)} declares ${label[d]}`);
  }
  s.phase = "showdown";
  resolveStud(s);
}

function resolveStud(s: HandState): void {
  returnUncalled(s);
  const st = stakesOf(s);
  const live = s.players.filter((p) => !p.folded);
  const shown: Record<string, Card[]> = {};
  const highs = new Map<string, HighResult>();
  const lows = new Map<string, LowResult>();
  for (const p of live) {
    const cards = [...p.holeCards, ...ups(p)];
    shown[p.playerId] = cards;
    const h = bestHigh(cards, [], false);
    const l = bestLowAny(cards, [], false) as LowResult;
    highs.set(p.playerId, h);
    lows.set(p.playerId, l);
    s.log.push(`${name(p)} shows ${fmtCards(cards)}: ${h.name} / low ${l.name}`);
  }
  const pots = withDeadMoney(buildPots(s.players), s);
  s.pots = pots;
  const order = orderFromButton(s);
  const winners: WinnerView[] = [];
  const declOf = (p: HandPlayer): Declaration => (st.declare ? (p.declared ?? "high") : "both");

  const bestOf = (cands: HandPlayer[], side: "high" | "low"): HandPlayer[] => {
    let best: number | null = null;
    let group: HandPlayer[] = [];
    for (const p of cands) {
      const score = side === "high" ? (highs.get(p.playerId) as HighResult).score : (lows.get(p.playerId) as LowResult).score;
      const better = best === null || (side === "high" ? score > best : score < best);
      if (better) {
        best = score;
        group = [p];
      } else if (score === best) group.push(p);
    }
    return group;
  };
  const award = (amount: number, group: HandPlayer[], potIndex: number, half: WinnerView["half"], side: "high" | "low"): void => {
    for (const [id, amt] of distribute(amount, group, order)) {
      if (amt <= 0) continue;
      const handName = side === "high" ? (highs.get(id) as HighResult).name : (lows.get(id) as LowResult).name;
      winners.push({ playerId: id, amount: amt, potIndex, half, handName });
    }
  };

  pots.forEach((pot, potIndex) => {
    const eligible = live.filter((p) => pot.eligiblePlayerIds.includes(p.playerId));
    if (eligible.length === 0) return;
    let hi = eligible.filter((p) => declOf(p) !== "low");
    let lo = eligible.filter((p) => declOf(p) !== "high");
    if (st.declare) {
      // A "both" player must win or tie BOTH sides; otherwise they are out of the pot entirely.
      // Remove all failures at once and re-check until stable.
      for (;;) {
        const bestHi = bestOf(hi, "high")[0];
        const bestLo = bestOf(lo, "low")[0];
        const out = eligible.filter((p) => {
          if (declOf(p) !== "both" || !hi.includes(p)) return false;
          const hiOk = !bestHi || (highs.get(p.playerId) as HighResult).score >= (highs.get(bestHi.playerId) as HighResult).score;
          const loOk = !bestLo || (lows.get(p.playerId) as LowResult).score <= (lows.get(bestLo.playerId) as LowResult).score;
          return !(hiOk && loOk);
        });
        if (out.length === 0) break;
        hi = hi.filter((p) => !out.includes(p));
        lo = lo.filter((p) => !out.includes(p));
        for (const p of out) s.log.push(`${name(p)} declared Both but did not win or tie both sides of pot ${potIndex + 1}`);
      }
    }
    if (hi.length === 0 && lo.length === 0) {
      // Everyone left in this pot was a failed "both". Rule choice: the pot goes whole to the best high hand
      // among ALL eligible players (declarations ignored), and the log says so.
      s.log.push(`Pot ${potIndex + 1}: no valid declarations; the best high hand takes it`);
      award(pot.amount, bestOf(eligible, "high"), potIndex, "whole", "high");
    } else if (lo.length === 0) {
      award(pot.amount, bestOf(hi, "high"), potIndex, "whole", "high");
    } else if (hi.length === 0) {
      award(pot.amount, bestOf(lo, "low"), potIndex, "whole", "low");
    } else {
      const highAmount = Math.ceil(pot.amount / 2); // the odd chip goes to high
      award(highAmount, bestOf(hi, "high"), potIndex, "high", "high");
      award(pot.amount - highAmount, bestOf(lo, "low"), potIndex, "low", "low");
    }
  });
  complete(s, winners, shown);
}
