import { freshDeck, type Card } from "./cards.js";
import { bestHigh } from "./evaluate.js";
import type { RngAuditLens, RngAuditReport, RngAuditRow, RngAuditScope, RngAuditVerdict } from "./protocol.js";
import {
  AUDIT_POSITIONS,
  DECK_SIZE,
  FLOP,
  SEVEN_CARD_CATEGORIES,
  SEVEN_CARD_PROBS,
  TWO_CARD,
  chiSquareGof,
  chiSquareSf,
  minSamplesForTest,
  normalInterval95,
} from "./stats.js";

/**
 * RNG audit core (pure). Why sampling fixed deck positions is the same as auditing "the cards players were dealt":
 * the dealer takes cards from fixed positions of the shuffled deck (seat k always gets a fixed set of positions),
 * and a uniformly shuffled deck makes ANY fixed set of positions a uniform random sample of cards. So if the deck
 * is fair, positions (0,1), (2,3), ... behave exactly like random two-card holdings, and positions 0-6, 7-13, ...
 * like random seven-card hands. If the shuffle were rigged toward big hands, those same positions would show it,
 * whatever the game or the number of players. The revealed deck is therefore tested for every finished hand,
 * including hands that ended before a showdown. Samples from the same deck are disjoint but not perfectly
 * independent (cards are dealt without replacement); the effect is far below anything the tests can detect.
 */

export const TWO_CARD_SAMPLES_PER_HAND = AUDIT_POSITIONS / 2; // positions (0,1) ... (18,19)
export const SEVEN_CARD_SAMPLES_PER_HAND = 3; // positions 0-6, 7-13, 14-20

/** A minimal view of a finished hand (HandRecord satisfies it). */
export interface AuditableHand {
  board: readonly Card[];
  reveal: { deck: readonly Card[] };
}

/** JSON-friendly running totals. */
export interface AuditCounts {
  hands: number;
  twoN: number;
  pair: number;
  suited: number;
  offsuit: number;
  aa: number;
  ak: number;
  sevenN: number;
  /** Indexed by evaluate.ts hand category: 0 high card ... 8 straight flush. */
  seven: number[];
  flopN: number;
  flopPaired: number;
  flopMono: number;
  flopTwoTone: number;
  flopRainbow: number;
  /** pos[p * 52 + cardIndex]: how often each card sat at deck position p (p < 20). */
  pos: number[];
}

export function emptyCounts(): AuditCounts {
  return {
    hands: 0, twoN: 0, pair: 0, suited: 0, offsuit: 0, aa: 0, ak: 0,
    sevenN: 0, seven: new Array(9).fill(0) as number[],
    flopN: 0, flopPaired: 0, flopMono: 0, flopTwoTone: 0, flopRainbow: 0,
    pos: new Array(AUDIT_POSITIONS * DECK_SIZE).fill(0) as number[],
  };
}

/** True when a counts object read back from disk has the right shape. */
export function isAuditCounts(v: unknown): v is AuditCounts {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  const nums = ["hands", "twoN", "pair", "suited", "offsuit", "aa", "ak", "sevenN", "flopN", "flopPaired", "flopMono", "flopTwoTone", "flopRainbow"];
  return nums.every((k) => typeof c[k] === "number" && Number.isFinite(c[k] as number))
    && Array.isArray(c.seven) && c.seven.length === 9 && c.seven.every((x) => typeof x === "number")
    && Array.isArray(c.pos) && c.pos.length === AUDIT_POSITIONS * DECK_SIZE && c.pos.every((x) => typeof x === "number");
}

const CARD_INDEX: ReadonlyMap<string, number> = new Map(freshDeck().map((c, i) => [c, i]));
const RANK_OF = (c: Card): number => "23456789TJQKA".indexOf(c[0]!);

/** A usable deck is all 52 distinct, known cards. Anything else (short decks, corrupt files) is skipped. */
export function isFullDeck(deck: readonly Card[]): boolean {
  if (deck.length !== DECK_SIZE) return false;
  const seen = new Set<string>();
  for (const c of deck) {
    if (!CARD_INDEX.has(c) || seen.has(c)) return false;
    seen.add(c);
  }
  return true;
}

/** Adds one finished hand to the totals. Returns false (and changes nothing) when the revealed deck is unusable. */
export function addHandToCounts(counts: AuditCounts, hand: AuditableHand): boolean {
  const deck = hand.reveal?.deck;
  if (!Array.isArray(deck) || !isFullDeck(deck)) return false;
  counts.hands++;

  // Deck position uniformity.
  for (let p = 0; p < AUDIT_POSITIONS; p++) counts.pos[p * DECK_SIZE + CARD_INDEX.get(deck[p]!)!]!++;

  // Two-card lens: (0,1), (2,3), ... (18,19).
  for (let p = 0; p < AUDIT_POSITIONS; p += 2) {
    const a = deck[p]!;
    const b = deck[p + 1]!;
    const ra = RANK_OF(a);
    const rb = RANK_OF(b);
    counts.twoN++;
    if (ra === rb) {
      counts.pair++;
      if (ra === 12) counts.aa++;
    } else if (a[1] === b[1]) counts.suited++;
    else counts.offsuit++;
    if ((ra === 12 && rb === 11) || (ra === 11 && rb === 12)) counts.ak++;
  }

  // Seven-card lens: 0-6, 7-13, 14-20, best five of seven.
  for (let s = 0; s < SEVEN_CARD_SAMPLES_PER_HAND; s++) {
    const seven = deck.slice(s * 7, s * 7 + 7) as Card[];
    const cat = Math.floor(bestHigh([], seven, false).score / 16 ** 5);
    counts.sevenN++;
    counts.seven[cat]!++;
  }

  // Flop lens: the board actually dealt, when it has at least three cards.
  const board = hand.board;
  if (board && board.length >= 3 && board.slice(0, 3).every((c) => CARD_INDEX.has(c))) {
    const f = board.slice(0, 3);
    const ranks = f.map(RANK_OF);
    const suits = new Set(f.map((c) => c[1]));
    counts.flopN++;
    if (new Set(ranks).size < 3) counts.flopPaired++;
    if (suits.size === 1) counts.flopMono++;
    else if (suits.size === 2) counts.flopTwoTone++;
    else counts.flopRainbow++;
  }
  return true;
}

// ---------------------------------------------------------------- report

const pct = (x: number): number => x * 100;
const f2 = (x: number): string => (x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3));
const MIN_SAMPLES = 100;
const POSITION_MIN_SAMPLES = DECK_SIZE * 5;

function row(label: string, observed: number, n: number, p: number): RngAuditRow {
  const [lo, hi] = normalInterval95(p, n);
  return { label, observed, expectedPct: pct(p), observedPct: n > 0 ? pct(observed / n) : 0, ci95: [pct(lo), pct(hi)] };
}

export function verdictFor(p: number): RngAuditVerdict {
  if (p >= 0.01) return "fair";
  if (p >= 0.001) return "unusual";
  return "investigate";
}

interface LensInput {
  id: string;
  title: string;
  plainEnglish: string;
  n: number;
  perHand: number;
  labels: string[];
  observed: number[];
  probs: number[];
  /** Rows to show (may differ from the tested categories). */
  rows?: RngAuditRow[];
  minSamples?: number;
}

function finishLens(i: LensInput): RngAuditLens {
  const gof = chiSquareGof(i.observed, i.probs);
  const floor = i.minSamples ?? MIN_SAMPLES;
  const needSamples = Math.max(floor, minSamplesForTest(i.probs, floor));
  const minHands = Math.ceil(needSamples / i.perHand);
  const testable = i.n >= floor && gof.df >= 1 && Number.isFinite(gof.pValue);
  const rows = i.rows ?? i.labels.map((l, k) => row(l, i.observed[k]!, i.n, i.probs[k]!));
  return {
    id: i.id,
    title: i.title,
    plainEnglish: i.plainEnglish,
    samples: i.n,
    rows,
    chiSquare: gof.chiSquare,
    df: Math.max(0, gof.df),
    pValue: testable ? gof.pValue : null,
    verdict: testable ? verdictFor(gof.pValue) : "too-few-hands",
    minHands,
  };
}

/** Builds the full report from running totals. */
export function buildReport(counts: AuditCounts, scope: RngAuditScope, sinceIso: string): RngAuditReport {
  const c = counts;
  const lenses: RngAuditLens[] = [];

  lenses.push(finishLens({
    id: "pocket-shape", title: "Two-card holdings: pairs and suited cards",
    plainEnglish: `Pocket pairs: ${c.pair.toLocaleString("en-US")} of ${c.twoN.toLocaleString("en-US")} two-card samples (${f2(c.twoN ? pct(c.pair / c.twoN) : 0)}%). A fair deck gives ${f2(pct(TWO_CARD.pair))}%.`,
    n: c.twoN, perHand: TWO_CARD_SAMPLES_PER_HAND,
    labels: ["Pocket pair", "Suited (not a pair)", "Offsuit (not a pair)"],
    observed: [c.pair, c.suited, c.offsuit], probs: [TWO_CARD.pair, TWO_CARD.suited, TWO_CARD.offsuit],
  }));

  lenses.push(finishLens({
    id: "premium-starts", title: "Two-card holdings: aces and ace-king",
    plainEnglish: `Pocket aces: ${c.aa.toLocaleString("en-US")} of ${c.twoN.toLocaleString("en-US")} two-card samples (${f2(c.twoN ? pct(c.aa / c.twoN) : 0)}%). A fair deck gives ${f2(pct(TWO_CARD.aa))}%.`,
    n: c.twoN, perHand: TWO_CARD_SAMPLES_PER_HAND,
    labels: ["Pocket aces (AA)", "Ace-king, any suits (AK)", "Everything else"],
    observed: [c.aa, c.ak, c.twoN - c.aa - c.ak], probs: [TWO_CARD.aa, TWO_CARD.ak, 1 - TWO_CARD.aa - TWO_CARD.ak],
  }));

  const sevenLabels = SEVEN_CARD_CATEGORIES.map((x) => x.label);
  const strong = c.seven[8]! + c.seven[7]! + c.seven[6]!;
  lenses.push(finishLens({
    id: "seven-card", title: "Seven-card hands: best five of seven",
    plainEnglish: `Full house or better: ${strong.toLocaleString("en-US")} of ${c.sevenN.toLocaleString("en-US")} seven-card samples (${f2(c.sevenN ? pct(strong / c.sevenN) : 0)}%). A fair deck gives ${f2(pct(SEVEN_CARD_PROBS[8]! + SEVEN_CARD_PROBS[7]! + SEVEN_CARD_PROBS[6]!))}%.`,
    n: c.sevenN, perHand: SEVEN_CARD_SAMPLES_PER_HAND,
    labels: sevenLabels, observed: c.seven, probs: [...SEVEN_CARD_PROBS],
  }));

  lenses.push(finishLens({
    id: "flop-pairing", title: "Flops: paired or not",
    plainEnglish: `Paired flops: ${c.flopPaired.toLocaleString("en-US")} of ${c.flopN.toLocaleString("en-US")} flops (${f2(c.flopN ? pct(c.flopPaired / c.flopN) : 0)}%). A fair deck gives ${f2(pct(FLOP.paired))}%.`,
    n: c.flopN, perHand: 1,
    labels: ["Paired or trips flop", "Three different ranks"],
    observed: [c.flopPaired, c.flopN - c.flopPaired], probs: [FLOP.paired, FLOP.unpaired],
  }));

  lenses.push(finishLens({
    id: "flop-suits", title: "Flops: suit texture",
    plainEnglish: `One-suit flops: ${c.flopMono.toLocaleString("en-US")} of ${c.flopN.toLocaleString("en-US")} flops (${f2(c.flopN ? pct(c.flopMono / c.flopN) : 0)}%). A fair deck gives ${f2(pct(FLOP.monotone))}%.`,
    n: c.flopN, perHand: 1,
    labels: ["One suit (monotone)", "Two suits", "Three suits (rainbow)"],
    observed: [c.flopMono, c.flopTwoTone, c.flopRainbow], probs: [FLOP.monotone, FLOP.twoTone, FLOP.rainbow],
  }));

  lenses.push(positionLens(c));
  const ps = lenses.map((l) => l.pValue).filter((p): p is number => p !== null);
  const overall = ps.length
    ? (() => {
        const pValue = Math.min(1, Math.min(...ps) * ps.length);
        return { verdict: verdictFor(pValue), pValue, tested: ps.length };
      })()
    : null;
  return { scope, hands: c.hands, since: sinceIso, lenses, overall };
}

function positionLens(c: AuditCounts): RngAuditLens {
  const n = c.hands;
  const p = 1 / DECK_SIZE;
  const expected = n * p;
  const [lo, hi] = normalInterval95(p, n);
  const rows: RngAuditRow[] = [];
  let total = 0;
  for (let pos = 0; pos < AUDIT_POSITIONS; pos++) {
    let chi = 0;
    let inRange = 0;
    for (let k = 0; k < DECK_SIZE; k++) {
      const o = c.pos[pos * DECK_SIZE + k]!;
      if (n > 0 && o >= n * lo && o <= n * hi) inRange++;
      if (expected > 0) chi += (o - expected) ** 2 / expected;
    }
    total += chi;
    // Row: how many of the 52 cards landed within their own 95% range here (about 49 of 52 for a fair deck).
    const [rlo, rhi] = normalInterval95(0.95, DECK_SIZE);
    const r: RngAuditRow = {
      label: `Card ${pos + 1}`, observed: inRange, expectedPct: 95, observedPct: pct(inRange / DECK_SIZE), ci95: [pct(rlo), pct(rhi)],
    };
    r.note = n >= POSITION_MIN_SAMPLES ? `chi-square ${chi.toFixed(1)} on 51 df, p = ${fmtP(chiSquareSf(chi, DECK_SIZE - 1))}` : undefined;
    rows.push(r);
  }
  const df = AUDIT_POSITIONS * (DECK_SIZE - 1);
  const pValue = chiSquareSf(total, df);
  const testable = n >= POSITION_MIN_SAMPLES;
  return {
    id: "deck-positions", title: "Deck positions: does every card land everywhere equally?",
    plainEnglish: `Each of the 52 cards should sit in each of the first 20 deck positions about 1 time in 52 (${f2(pct(p))}%). Over ${n.toLocaleString("en-US")} decks that is about ${f2(expected)} times per card and position.`,
    samples: n, rows, chiSquare: total, df,
    pValue: testable ? pValue : null,
    verdict: testable ? verdictFor(pValue) : "too-few-hands",
    minHands: POSITION_MIN_SAMPLES,
  };
}

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p >= 0.001) return p.toFixed(3);
  if (p === 0) return "< 1e-300";
  return p.toExponential(1);
}
