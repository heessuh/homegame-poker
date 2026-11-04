/**
 * Pure statistics and exact poker expectations used by the RNG audit.
 * No I/O, no randomness: everything here is a function of its arguments.
 */

// ---------------------------------------------------------------- special functions

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos approximation, g = 7, ~15 digits). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-15;
const TINY = 1e-300;
const MAX_ITER = 100_000;

/** Regularized lower incomplete gamma P(a, x) by its power series (good for x < a + 1). */
function gammaPSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < MAX_ITER; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Regularized upper incomplete gamma Q(a, x) by a continued fraction (modified Lentz, good for x >= a + 1). */
function gammaQContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized upper incomplete gamma function Q(a, x) = Γ(a, x) / Γ(a), a > 0, x >= 0. */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return 1;
  if (!Number.isFinite(x)) return 0;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}

/** Regularized lower incomplete gamma P(a, x) = 1 - Q(a, x). */
export function gammaP(a: number, x: number): number {
  if (!(a > 0) || Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return 0;
  if (!Number.isFinite(x)) return 1;
  return x < a + 1 ? gammaPSeries(a, x) : 1 - gammaQContinuedFraction(a, x);
}

/** P(X >= x) for X ~ chi-square with df degrees of freedom (the p-value of a chi-square statistic). */
export function chiSquareSf(x: number, df: number): number {
  if (!(df > 0)) return NaN;
  if (x <= 0) return 1;
  return gammaQ(df / 2, x / 2);
}

// ---------------------------------------------------------------- goodness of fit

export interface GofCell {
  observed: number;
  expected: number;
}

export interface GofResult {
  chiSquare: number;
  df: number;
  /** NaN when df < 1 (nothing left to test after pooling). */
  pValue: number;
  n: number;
  /** The cells actually tested (after pooling those with expected < minExpected). */
  cells: GofCell[];
  pooledAny: boolean;
}

function poolCells(cellsIn: GofCell[], minExpected: number): { cells: GofCell[]; pooledAny: boolean } {
  const sorted = cellsIn.map((c) => ({ ...c })).sort((a, b) => a.expected - b.expected);
  const cells: GofCell[] = [];
  let pool: GofCell | null = null;
  let pooledCount = 0;
  for (const cell of sorted) {
    if (pool && pool.expected < minExpected) {
      pool.observed += cell.observed;
      pool.expected += cell.expected;
      pooledCount++;
    } else if (!pool && cell.expected < minExpected) {
      pool = cell;
      pooledCount = 1;
    } else {
      cells.push(cell);
    }
  }
  if (pool) {
    // A pool still under the minimum swallows the smallest remaining cell(s).
    while (pool.expected < minExpected && cells.length > 0) {
      const c = cells.shift()!;
      pool.observed += c.observed;
      pool.expected += c.expected;
      pooledCount++;
    }
    cells.push(pool);
  }
  return { cells, pooledAny: pooledCount > 1 };
}

/**
 * Pearson chi-square goodness of fit of observed counts against exact probabilities.
 * Cells whose expected count is below `minExpected` are pooled together (smallest first) until the pool
 * reaches it, the usual rule that keeps the chi-square approximation honest.
 */
export function chiSquareGof(observed: readonly number[], probs: readonly number[], minExpected = 5): GofResult {
  if (observed.length !== probs.length) throw new Error("observed and probs must have the same length");
  const n = observed.reduce((a, b) => a + b, 0);
  const { cells, pooledAny } = poolCells(probs.map((p, i) => ({ observed: observed[i]!, expected: p * n })), minExpected);
  let chi = 0;
  for (const c of cells) if (c.expected > 0) chi += (c.observed - c.expected) ** 2 / c.expected;
  const df = cells.length - 1;
  return { chiSquare: chi, df, pValue: df >= 1 ? chiSquareSf(chi, df) : NaN, n, cells, pooledAny };
}

/** Degrees of freedom the pooled test would have with n samples. */
export function pooledDf(probs: readonly number[], n: number, minExpected = 5): number {
  return poolCells(probs.map((p) => ({ observed: 0, expected: p * n })), minExpected).cells.length - 1;
}

/** Smallest sample size >= floor at which the pooled test has at least one degree of freedom. */
export function minSamplesForTest(probs: readonly number[], floor = 1, minExpected = 5): number {
  const lo0 = Math.max(1, Math.ceil(floor));
  if (pooledDf(probs, lo0, minExpected) >= 1) return lo0;
  let lo = lo0;
  let hi = lo0;
  while (pooledDf(probs, hi, minExpected) < 1) {
    lo = hi;
    hi *= 2;
    if (hi > 1e12) return Infinity;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pooledDf(probs, mid, minExpected) >= 1) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------- intervals

/** Standard normal two-sided 95% critical value. */
export const Z95 = 1.959963984540054;

/**
 * Where a fair deck's share should land 95% of the time: p ± 1.96·sqrt(p(1-p)/n), as proportions clipped to [0, 1].
 * Normal approximation; n is the number of samples.
 */
export function normalInterval95(p: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const se = Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, p - Z95 * se), Math.min(1, p + Z95 * se)];
}

/** Wilson score 95% interval for a binomial proportion k/n (good for small counts). */
export function wilsonInterval95(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const ph = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (ph + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((ph * (1 - ph)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Two-sided normal-approximation p-value for k successes in n trials with true probability p. */
export function binomialZ(k: number, n: number, p: number): number {
  const sd = Math.sqrt(n * p * (1 - p));
  return sd === 0 ? 0 : (k - n * p) / sd;
}

// ---------------------------------------------------------------- exact expectations

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Two cards from a full deck. */
export const TWO_CARD = {
  pair: 3 / 51,
  suited: 12 / 51,
  offsuit: 36 / 51, // unpaired and unsuited
  aa: 1 / 221,
  ak: 16 / 1326,
} as const;

/** Seven-card hands, best five of seven. Counts out of C(52,7) = 133,784,560. */
export const SEVEN_CARD_TOTAL = 133_784_560;
export const SEVEN_CARD_CATEGORIES = [
  { id: "high", label: "High card", count: 23_294_460 },
  { id: "pair", label: "One pair", count: 58_627_800 },
  { id: "twopair", label: "Two pair", count: 31_433_400 },
  { id: "trips", label: "Three of a kind", count: 6_461_620 },
  { id: "straight", label: "Straight", count: 6_180_020 },
  { id: "flush", label: "Flush", count: 4_047_644 },
  { id: "boat", label: "Full house", count: 3_473_184 },
  { id: "quads", label: "Four of a kind", count: 224_848 },
  { id: "sf", label: "Straight flush (incl. royal)", count: 41_584 },
] as const;
/** Index = hand category as scored by evaluate.ts (0 high card ... 8 straight flush). */
export const SEVEN_CARD_PROBS: readonly number[] = SEVEN_CARD_CATEGORIES.map((c) => c.count / SEVEN_CARD_TOTAL);

/** Three flop cards: pairing and suit texture. */
export const FLOP = {
  /** Paired or trips: 1 - (48/51)(44/50). */
  paired: 1 - (48 / 51) * (44 / 50),
  unpaired: (48 / 51) * (44 / 50),
  monotone: 1144 / 22100,
  twoTone: 12168 / 22100,
  rainbow: 8788 / 22100,
} as const;

export const DECK_SIZE = 52;
/** Deck positions audited for uniformity (the first 20 cards: every seat's hole cards in any game). */
export const AUDIT_POSITIONS = 20;
