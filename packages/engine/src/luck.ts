import { freshDeck, type Card } from "./cards.js";
import { bestLow8, bestLowAny } from "./evaluate.js";
import { isFullDeck } from "./audit.js";
import type { HandRecord, LuckPlayerRow, LuckReport, PotView, RngAuditVerdict } from "./protocol.js";
import { chiSquareGof, chiSquareSf, choose } from "./stats.js";
import { VARIANTS, holeRule, splitOf, type HoleRule, type Variant, type VariantId } from "./variants.js";

/**
 * Luck report (pure). Two views of "is anyone getting better cards?", both per player and both from the revealed decks:
 *
 * 1. Best dealt hand. Rebuild every dealt player's hole cards and the full five-card board from the revealed deck and
 *    the deal order, and ask whose hand would have won at a river showdown had nobody folded. With n players dealt in
 *    and a fair shuffle, each has chance 1/n (ties split the credit), whatever the cards. Expected = sum of 1/n.
 * 2. All-in luck. When the money went in with cards still to come, each player's equity (their share of the pots on a
 *    random runout) times the pots, against what they actually won from those pots. Enumerated exactly when there are
 *    at most EXACT_LIMIT runouts, otherwise a fixed-seed Monte Carlo sample (same answer every time).
 *
 * Only aggregates leave this module: nothing here returns the hole cards of any hand.
 */

export const EXACT_LIMIT = 2000;
export const MC_SAMPLES = 800;
/** A per-player best-hand verdict needs at least this many hands dealt, and this many expected "best" hands. */
export const MIN_DEALT = 30;
export const MIN_EXPECTED_BEST = 10;
/** A per-player all-in verdict needs at least this many contested all-in hands. */
export const MIN_ALLIN_HANDS = 25;

// ------------------------------------------------------------------ reconstruction

export interface LuckableHand {
  handNumber: number;
  variant: VariantId;
  deckHash: string;
  reveal: { deck: readonly Card[] };
  board: readonly Card[];
  endedAt?: number;
  shown?: Record<string, readonly Card[]>;
  winners?: readonly { playerId: string; amount: number; potIndex: number }[];
  names?: Record<string, string>;
  luck?: HandRecord["luck"];
}

export interface DealtHand {
  ids: string[];
  holes: Card[][];
  /** The complete five-card board (including cards that were never dealt because the hand ended early). */
  board: Card[];
}

export type SkipReason = "stud" | "old" | "bad";

/**
 * Rebuilds the deal from the revealed deck: `holeCards` rounds of one card per player in deal order, then
 * burn + 3, burn + 1, burn + 1. Returns a reason string when the record cannot be used. Cross-checks everything
 * the record independently shows (the board that was dealt and the cards shown at showdown).
 */
export function reconstructDeal(rec: LuckableHand): DealtHand | SkipReason {
  const v: Variant | undefined = VARIANTS[rec.variant];
  if (!v) return "bad";
  if (v.kind === "stud" || v.scoring === "points") return "stud";
  const order = rec.luck?.dealOrder;
  if (!rec.luck || rec.luck.v !== 1 || !Array.isArray(order)) return "old";
  const n = order.length;
  const deck = rec.reveal?.deck;
  if (n < 2 || new Set(order).size !== n || !Array.isArray(deck) || !isFullDeck(deck as Card[])) return "bad";
  if (n * v.holeCards + 8 > deck.length) return "bad";
  const holes: Card[][] = order.map(() => []);
  for (let r = 0; r < v.holeCards; r++) for (let k = 0; k < n; k++) holes[k]!.push(deck[r * n + k]!);
  const p = n * v.holeCards;
  const board = [deck[p + 1]!, deck[p + 2]!, deck[p + 3]!, deck[p + 5]!, deck[p + 7]!];
  const dealt = rec.board ?? [];
  for (let i = 0; i < dealt.length; i++) if (dealt[i] !== board[i]) return "bad";
  for (const [id, cards] of Object.entries(rec.shown ?? {})) {
    const k = order.indexOf(id);
    if (k < 0 || cards.length !== holes[k]!.length || cards.some((c, i) => c !== holes[k]![i])) return "bad";
  }
  return { ids: [...order], holes, board };
}

// ------------------------------------------------------------------ scoring

interface Scored {
  high: number;
  low: number | null;
}

// ---- fast high-hand scoring (same scores as evaluate.ts bestHigh, without allocation; verified in tests) ----

const RANK_CODE: Record<string, number> = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
const sr = new Int32Array(5);
const gRank = new Int32Array(5);
const gCnt = new Int32Array(5);
const SHIFT = [65536, 4096, 256, 16, 1];
const CAT = 16 ** 5;

/** Score of the five ranks in sr (any order). Same numbers as evaluate5. */
function score5(flush: boolean): number {
  for (let i = 1; i < 5; i++) {
    const v = sr[i]!;
    let j = i - 1;
    while (j >= 0 && sr[j]! < v) {
      sr[j + 1] = sr[j]!;
      j--;
    }
    sr[j + 1] = v;
  }
  let ng = 0;
  for (let i = 0; i < 5; i++) {
    if (i > 0 && sr[i] === sr[i - 1]) gCnt[ng - 1]!++;
    else {
      gRank[ng] = sr[i]!;
      gCnt[ng] = 1;
      ng++;
    }
  }
  for (let i = 1; i < ng; i++) {
    const cr = gRank[i]!;
    const cc = gCnt[i]!;
    let j = i - 1;
    while (j >= 0 && gCnt[j]! < cc) {
      gRank[j + 1] = gRank[j]!;
      gCnt[j + 1] = gCnt[j]!;
      j--;
    }
    gRank[j + 1] = cr;
    gCnt[j + 1] = cc;
  }
  let straightHigh = 0;
  if (ng === 5) {
    if (sr[0]! - sr[4]! === 4) straightHigh = sr[0]!;
    else if (sr[0] === 14 && sr[1] === 5 && sr[2] === 4 && sr[3] === 3 && sr[4] === 2) straightHigh = 5;
  }
  if (straightHigh && flush) return 8 * CAT + straightHigh * SHIFT[0]!;
  let cat: number;
  if (gCnt[0] === 4) cat = 7;
  else if (gCnt[0] === 3 && ng > 1 && gCnt[1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straightHigh) return 4 * CAT + straightHigh * SHIFT[0]!;
  else if (gCnt[0] === 3) cat = 3;
  else if (gCnt[0] === 2 && ng > 1 && gCnt[1] === 2) cat = 2;
  else if (gCnt[0] === 2) cat = 1;
  else cat = 0;
  let out = cat * CAT;
  for (let i = 0; i < ng; i++) out += gRank[i]! * SHIFT[i]!;
  return out;
}

const comboCache = new Map<string, number[][]>();
/** Index lists of every legal five-card hand: any 5 of m cards, or exactly 2 of h hole cards + 3 of the board. */
function handIndexes(h: number, b: number, mustTwo: HoleRule): number[][] {
  const key = `${h}/${b}/${mustTwo}`;
  let r = comboCache.get(key);
  if (r) return r;
  r = [];
  const pick = (n: number, k: number, from = 0, cur: number[] = [], out: number[][] = []): number[][] => {
    if (cur.length === k) {
      out.push(cur.slice());
      return out;
    }
    for (let i = from; i <= n - (k - cur.length); i++) {
      cur.push(i);
      pick(n, k, i + 1, cur, out);
      cur.pop();
    }
    return out;
  };
  if (mustTwo === "2or3") {
    for (const [hk, bk] of [[2, 3], [3, 2]] as const) {
      if (h < hk || b < bk) continue;
      for (const hp of pick(h, hk)) for (const bp of pick(b, bk)) r.push([...hp, ...bp.map((x) => x + h)]);
    }
  } else if (mustTwo) {
    for (const hp of pick(h, 2)) for (const bp of pick(b, 3)) r.push([...hp, ...bp.map((x) => x + h)]);
  } else r = pick(h + b, 5);
  comboCache.set(key, r);
  return r;
}

/** Best high score for the variant's rule; equals bestHigh(...).score. */
export function fastHighScore(hole: readonly Card[], board: readonly Card[], mustTwo: HoleRule): number {
  const all = [...hole, ...board];
  const m = all.length;
  const rk = new Array<number>(m);
  const su = new Array<string>(m);
  for (let i = 0; i < m; i++) {
    rk[i] = RANK_CODE[all[i]![0]!]!;
    su[i] = all[i]![1]!;
  }
  let best = -1;
  for (const ix of handIndexes(hole.length, board.length, mustTwo)) {
    for (let i = 0; i < 5; i++) sr[i] = rk[ix[i]!]!;
    const s0 = su[ix[0]!];
    const sc = score5(su[ix[1]!] === s0 && su[ix[2]!] === s0 && su[ix[3]!] === s0 && su[ix[4]!] === s0);
    if (sc > best) best = sc;
  }
  if (best < 0) throw new Error("not enough cards to make a five-card hand");
  return best;
}

function scorePlayer(v: Variant, hole: readonly Card[], board: Card[], needLow: boolean): Scored {
  const high = fastHighScore(hole, board, holeRule(v));
  if (!needLow) return { high, low: null };
  const lowFn = v.lowRule === "any" ? bestLowAny : bestLow8;
  return { high, low: lowFn(hole as Card[], board, holeRule(v))?.score ?? null };
}

/** Indices of everyone sharing the best score (highest when `higher`, else lowest); null scores are ignored. */
function bestGroup(idx: readonly number[], get: (i: number) => number | null, higher: boolean): number[] {
  let best: number | null = null;
  let group: number[] = [];
  for (const i of idx) {
    const s = get(i);
    if (s === null) continue;
    if (best === null || (higher ? s > best : s < best)) {
      best = s;
      group = [i];
    } else if (s === best) group.push(i);
  }
  return group;
}

/**
 * Adds `amount`, split the way showdown splits one pot (the same rules as resolveShowdown, without rounding odd
 * chips), among the eligible indices.
 */
function addPotShares(v: Variant, elig: readonly number[], sc: readonly Scored[], amount: number, pay: number[]): void {
  const mode = splitOf(v);
  const high = (i: number): number => sc[i]!.high;
  const low = (i: number): number | null => sc[i]!.low;
  const give = (group: readonly number[], amt: number): void => {
    for (const i of group) pay[i] = pay[i]! + amt / group.length;
  };
  if (mode === "low") {
    let lowGroup = bestGroup(elig, low, false);
    if (v.lowWinner === "second" && lowGroup.length > 0 && lowGroup.length < elig.length) {
      const bestScore = low(lowGroup[0]!)!;
      const rest = elig.filter((i) => low(i) !== bestScore);
      let next = Infinity;
      for (const i of rest) next = Math.min(next, low(i) ?? Infinity);
      lowGroup = rest.filter((i) => low(i) === next);
    }
    if (lowGroup.length > 0) give(lowGroup, amount);
    else give(bestGroup(elig, high, true), amount);
    return;
  }
  let hi = bestGroup(elig, high, v.highWinner !== "worst");
  if (v.highWinner === "second" && hi.length < elig.length) {
    const top = high(hi[0]!);
    const rest = elig.filter((i) => high(i) !== top);
    const next = Math.max(...rest.map(high));
    hi = rest.filter((i) => high(i) === next);
  }
  const lo = mode === "hilo" ? bestGroup(elig, low, false) : [];
  if (mode === "hilo" && lo.length > 0) {
    give(hi, amount / 2);
    give(lo, amount / 2);
  } else give(hi, amount);
}

// ------------------------------------------------------------------ best dealt hand

/** Credit (summing to 1) for who held the best hand at a river showdown. Low-only games use the variant's low rule. */
export function bestHandCredits(variantId: VariantId, holes: readonly (readonly Card[])[], board: Card[]): number[] {
  const v = VARIANTS[variantId];
  const mode = splitOf(v);
  const sc = holes.map((h) => scorePlayer(v, h, board, mode === "low"));
  const all = holes.map((_, i) => i);
  let group: number[];
  if (mode === "low") {
    group = bestGroup(all, (i) => sc[i]!.low, false);
    if (group.length === 0) group = bestGroup(all, (i) => sc[i]!.high, true);
  } else group = bestGroup(all, (i) => sc[i]!.high, v.highWinner !== "worst"); // Dumb & Dumber: the lowest hand is the best one to hold
  const out = holes.map(() => 0);
  for (const i of group) out[i] = 1 / group.length;
  return out;
}

// ------------------------------------------------------------------ equity

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EquityOptions {
  /** Seed text for the Monte Carlo sample; the same text always gives the same sample. */
  seed?: string;
  exactLimit?: number;
  samples?: number;
}

export interface EquityResult {
  /** Per player (same order as `hands`): expected chips won from the contested pots, and the variance of that. */
  mean: number[];
  variance: number[];
  runouts: number;
  exact: boolean;
}

/**
 * Expected payout of each player from the given pots when the rest of the board is dealt at random from the
 * cards nobody holds. `board` is what is showing now (0, 3 or 4 cards). Pots with fewer than two eligible
 * players are ignored. Handles hi/lo splits and the variant's low rule.
 */
export function runoutEquity(variantId: VariantId, board: readonly Card[], hands: readonly { id: string; hole: readonly Card[] }[], pots: readonly PotView[], opt: EquityOptions = {}): EquityResult {
  return drive(runoutEquityGen(variantId, board, hands, pots, opt));
}

/** Runs a generator to the end. */
function drive<T>(g: Generator<void, T>): T {
  for (;;) {
    const n = g.next();
    if (n.done) return n.value;
  }
}

/** Same as runoutEquity, but yields after every single runout so a caller can spread the work over time. */
export function* runoutEquityGen(
  variantId: VariantId,
  board: readonly Card[],
  hands: readonly { id: string; hole: readonly Card[] }[],
  pots: readonly PotView[],
  opt: EquityOptions = {},
): Generator<void, EquityResult> {
  const v = VARIANTS[variantId];
  const needLow = splitOf(v) !== "high";
  const need = 5 - board.length;
  const idIndex = new Map(hands.map((h, i) => [h.id, i]));
  const contested = pots
    .map((p) => ({ amount: p.amount, elig: p.eligiblePlayerIds.map((id) => idIndex.get(id)).filter((i): i is number => i !== undefined) }))
    .filter((p) => p.elig.length >= 2 && p.amount > 0);
  const k = hands.length;
  const sum = new Array<number>(k).fill(0);
  const sumSq = new Array<number>(k).fill(0);
  if (contested.length === 0 || need < 0) return { mean: sum, variance: sumSq.slice(), runouts: 0, exact: true };

  const exactLimit = opt.exactLimit ?? EXACT_LIMIT;
  const taken = new Set<string>([...board, ...hands.flatMap((h) => h.hole)]);
  const pool = freshDeck().filter((c) => !taken.has(c));
  const exact = choose(pool.length, need) <= exactLimit;
  const involved = [...new Set(contested.flatMap((p) => p.elig))];
  const full: Card[] = [...board];

  const one = (): void => {
    const sc = new Array<Scored>(k);
    for (const i of involved) sc[i] = scorePlayer(v, hands[i]!.hole, full, needLow);
    const pay = new Array<number>(k).fill(0);
    for (const p of contested) addPotShares(v, p.elig, sc, p.amount, pay);
    for (let i = 0; i < k; i++) {
      sum[i] = sum[i]! + pay[i]!;
      sumSq[i] = sumSq[i]! + pay[i]! * pay[i]!;
    }
  };

  let runouts = 0;
  if (exact) {
    // Every combination of `need` cards from the pool, in order.
    const idx = Array.from({ length: need }, (_, i) => i);
    for (;;) {
      for (let j = 0; j < need; j++) full.push(pool[idx[j]!]!);
      one();
      for (let j = 0; j < need; j++) full.pop();
      runouts++;
      yield;
      let i = need - 1;
      while (i >= 0 && idx[i] === pool.length - need + i) i--;
      if (i < 0) break;
      idx[i] = idx[i]! + 1;
      for (let j = i + 1; j < need; j++) idx[j] = idx[j - 1]! + 1;
    }
  } else {
    const rnd = mulberry32(hashSeed(opt.seed ?? "luck"));
    const samples = opt.samples ?? MC_SAMPLES;
    const work = pool.slice();
    for (let s = 0; s < samples; s++) {
      for (let j = 0; j < need; j++) {
        const r = j + Math.floor(rnd() * (work.length - j));
        const t = work[j]!;
        work[j] = work[r]!;
        work[r] = t;
        full.push(work[j]!);
      }
      one();
      for (let j = 0; j < need; j++) full.pop();
      yield;
    }
    runouts = samples;
  }
  const mean = sum.map((x) => x / runouts);
  const variance = sumSq.map((x, i) => Math.max(0, x / runouts - mean[i]! ** 2));
  return { mean, variance, runouts, exact };
}

// ------------------------------------------------------------------ per hand

/** The cheap part of a hand: who was dealt what, and who held the best river hand. Cached per record object. */
export interface DealInfo {
  ids: string[];
  holes: Card[][];
  board: Card[];
  /** Credit for holding the best river hand, per id (sums to 1). */
  credit: number[];
}

export interface HandLuck {
  ids: string[];
  credit: number[];
  allIn?: {
    ids: string[];
    expected: number[];
    variance: number[];
    /** What the showdown rules pay on the actual runout (not the dealer's manual award). */
    actual: number[];
    exact: boolean;
  };
}

const dealCache = new WeakMap<object, DealInfo | SkipReason>();
const luckCache = new WeakMap<object, HandLuck | SkipReason>();

/** Reconstructs the deal and the best-hand credits (a millisecond or so); cached on the record object. */
export function dealInfo(rec: LuckableHand): DealInfo | SkipReason {
  const hit = dealCache.get(rec);
  if (hit !== undefined) return hit;
  const deal = reconstructDeal(rec);
  const res: DealInfo | SkipReason = typeof deal === "string" ? deal : { ...deal, credit: bestHandCredits(rec.variant, deal.holes, deal.board) };
  dealCache.set(rec, res);
  return res;
}

/** The finished result for a record if it has been computed, else undefined. Never computes. */
export function peekHandLuck(rec: LuckableHand): HandLuck | SkipReason | undefined {
  return luckCache.get(rec);
}

/** Everything the report needs from one hand; computed once per record object. */
export function handLuck(rec: LuckableHand, opt: EquityOptions = {}): HandLuck | SkipReason {
  const hit = luckCache.get(rec);
  if (hit !== undefined) return hit;
  return drive(handLuckGen(rec, opt));
}

/** handLuck as a generator that yields between small units of work (one runout at a time). Stores its result in the cache. */
export function* handLuckGen(rec: LuckableHand, opt: EquityOptions = {}): Generator<void, HandLuck | SkipReason> {
  const hit = luckCache.get(rec);
  if (hit !== undefined) return hit;
  const deal = dealInfo(rec);
  if (typeof deal === "string") {
    luckCache.set(rec, deal);
    return deal;
  }
  yield;
  const out: HandLuck = { ids: deal.ids, credit: deal.credit };
  const ro = rec.luck?.runout;
  if (ro && ro.live.length >= 2 && ro.boardLen < 5) {
    const idx = new Map(deal.ids.map((id, i) => [id, i]));
    if (ro.live.every((id) => idx.has(id))) {
      const hands = ro.live.map((id) => ({ id, hole: deal.holes[idx.get(id)!]! }));
      const eq = yield* runoutEquityGen(rec.variant, deal.board.slice(0, ro.boardLen), hands, ro.pots, { seed: `${rec.deckHash}|${rec.handNumber}`, ...opt });
      if (eq.runouts > 0) {
        // Actual: pay the contested pots by the showdown rules on the board that really came.
        const v = VARIANTS[rec.variant];
        const needLow = splitOf(v) !== "high";
        const k = hands.length;
        const sc = hands.map((h) => scorePlayer(v, h.hole, deal.board, needLow));
        const pay = new Array<number>(k).fill(0);
        for (const pot of ro.pots) {
          const elig = pot.eligiblePlayerIds.map((id) => ro.live.indexOf(id)).filter((i) => i >= 0);
          if (elig.length >= 2 && pot.amount > 0) addPotShares(v, elig, sc, pot.amount, pay);
        }
        out.allIn = { ids: [...ro.live], expected: eq.mean, variance: eq.variance, actual: pay, exact: eq.exact };
      }
    }
  }
  luckCache.set(rec, out);
  return out;
}

// ------------------------------------------------------------------ report

function verdictFor(p: number): RngAuditVerdict {
  if (p >= 0.01) return "fair";
  if (p >= 0.001) return "unusual";
  return "investigate";
}

const RANK: Record<RngAuditVerdict, number> = { "too-few-hands": 0, fair: 1, unusual: 2, investigate: 3 };

interface Acc {
  id: string;
  dealt: number;
  best: number;
  expBest: number;
  varBest: number;
  aiHands: number;
  aiExp: number;
  aiAct: number;
  aiVar: number;
}

/** Two-sided normal p-value for a z-score. */
const pOfZ = (z: number): number => chiSquareSf(z * z, 1);

/**
 * Builds the per-player luck report from a table's hand history (deduplicated by hand number + end time).
 *
 * Multiple testing: every per-player test that is actually run, plus the table-wide chi-square, counts toward
 * `tested`; verdicts use p x tested (Bonferroni), exactly like the main audit's `overall`.
 */
export function buildLuckReport(history: readonly LuckableHand[], opt: EquityOptions = {}, cachedOnly = false): LuckReport {
  const accs = new Map<string, Acc>();
  const seen = new Set<string>();
  const skipped = { stud: 0, old: 0, bad: 0 };
  const names: Record<string, string> = {};
  let hands = 0;
  let pending = 0;
  let allInTotal = 0;
  const get = (id: string): Acc => {
    let a = accs.get(id);
    if (!a) accs.set(id, (a = { id, dealt: 0, best: 0, expBest: 0, varBest: 0, aiHands: 0, aiExp: 0, aiAct: 0, aiVar: 0 }));
    return a;
  };
  for (const rec of history) {
    const key = `${rec.handNumber}@${rec.endedAt ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hl = cachedOnly ? peekHandLuck(rec) : handLuck(rec, opt);
    if (hl === undefined) {
      pending++;
      continue;
    }
    if (typeof hl === "string") {
      skipped[hl]++;
      continue;
    }
    hands++;
    const n = hl.ids.length;
    hl.ids.forEach((id, i) => {
      const a = get(id);
      a.dealt++;
      a.best += hl.credit[i]!;
      a.expBest += 1 / n;
      a.varBest += (1 / n) * (1 - 1 / n);
    });
    if (rec.names) Object.assign(names, rec.names);
    if (hl.allIn) {
      allInTotal++;
      const ai = hl.allIn;
      ai.ids.forEach((id, j) => {
        const a = get(id);
        a.aiHands++;
        a.aiExp += ai.expected[j]!;
        a.aiAct += ai.actual[j]!;
        a.aiVar += ai.variance[j]!;
      });
    }
  }

  const rows = [...accs.values()];
  const bestTestable = (a: Acc): boolean => a.dealt >= MIN_DEALT && a.expBest >= MIN_EXPECTED_BEST && a.dealt - a.expBest >= MIN_EXPECTED_BEST && a.varBest > 0;
  const aiTestable = (a: Acc): boolean => a.aiHands >= MIN_ALLIN_HANDS && a.aiVar > 0;
  const bestP = new Map<string, { z: number; p: number }>();
  const aiP = new Map<string, { z: number; p: number }>();
  for (const a of rows) {
    if (bestTestable(a)) {
      const z = (a.best - a.expBest) / Math.sqrt(a.varBest);
      bestP.set(a.id, { z, p: pOfZ(z) });
    }
    if (aiTestable(a)) {
      const z = (a.aiAct - a.aiExp) / Math.sqrt(a.aiVar);
      aiP.set(a.id, { z, p: pOfZ(z) });
    }
  }
  // Table-wide: do the best-hand counts differ from the 1/n shares across all players (chi-square)?
  let table: LuckReport["table"] = null;
  if (hands >= MIN_DEALT && rows.length >= 2) {
    const total = rows.reduce((t, a) => t + a.expBest, 0);
    const g = chiSquareGof(rows.map((a) => a.best), rows.map((a) => a.expBest / total));
    if (g.df >= 1 && Number.isFinite(g.pValue)) table = { chiSquare: g.chiSquare, df: g.df, pValue: g.pValue, verdict: "fair" };
  }
  const tested = bestP.size + aiP.size + (table ? 1 : 0);
  const adj = (p: number): number => Math.min(1, p * tested);
  if (table) table.verdict = verdictFor(adj(table.pValue));
  const allP = [...bestP.values(), ...aiP.values()].map((x) => x.p);
  if (table) allP.push(table.pValue);
  let overall: LuckReport["overall"] = null;
  if (tested > 0) {
    const pValue = Math.min(1, Math.min(...allP) * tested);
    overall = { verdict: verdictFor(pValue), pValue, tested };
  }

  const out: LuckPlayerRow[] = rows.map((a) => {
    const b = bestP.get(a.id);
    const w = aiP.get(a.id);
    const bestVerdict: RngAuditVerdict = b ? verdictFor(adj(b.p)) : "too-few-hands";
    const allInVerdict: RngAuditVerdict = w ? verdictFor(adj(w.p)) : "too-few-hands";
    return {
      playerId: a.id,
      name: names[a.id] ?? "Someone",
      handsDealt: a.dealt,
      timesBest: a.best,
      expectedBest: a.expBest,
      bestZ: b ? b.z : null,
      bestP: b ? b.p : null,
      bestVerdict,
      allInHands: a.aiHands,
      allInExpected: a.aiExp,
      allInActual: a.aiAct,
      allInZ: w ? w.z : null,
      allInP: w ? w.p : null,
      allInVerdict,
      verdict: RANK[bestVerdict] >= RANK[allInVerdict] ? bestVerdict : allInVerdict,
    };
  }).sort((x, y) => y.handsDealt - x.handsDealt || x.name.localeCompare(y.name));

  return { hands, pending, skipped, allInHands: allInTotal, minDealt: MIN_DEALT, minAllInHands: MIN_ALLIN_HANDS, players: out, table, overall };
}

/** Marks a record as unusable (e.g. after an unexpected error) so callers stop waiting for it. */
export function setHandLuckBad(rec: LuckableHand): void {
  luckCache.set(rec, "bad");
}
