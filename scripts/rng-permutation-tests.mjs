#!/usr/bin/env node
// Permutation-level checks on N decks derived by the production mochapoker-v1 shuffle.
//   node scripts/rng-permutation-tests.mjs [--n 1000000]
// Each deck uses a fresh random server seed and realistic material. For every deck the Fisher-Yates swap
// indices are re-derived with rng-export.mjs (itself asserted equal to the engine's deriveDeck at startup)
// and the engine's deriveDeck output is compared with it, so the swap statistics describe the real decks.
// PASS means p >= 0.001. Families of many sub-tests report the WORST sub-test with a Bonferroni-adjusted p.
// Exit code 1 on any FAIL. JSON goes to test-reports/rng-permutation.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { bestHigh, deriveDeck } from "../packages/engine/dist/index.js";
import { assertProduction, randomHand, shuffleWithJ } from "./rng-export.mjs";

const argv = process.argv.slice(2);
const nArg = argv.indexOf("--n");
const N = nArg >= 0 ? Number(argv[nArg + 1]) : argv.find((a) => a.startsWith("--n="))?.slice(4) ? Number(argv.find((a) => a.startsWith("--n=")).slice(4)) : 1_000_000;
if (!(N >= 10000)) throw new Error("--n must be at least 10000");
const ALPHA = 0.001;

// ---- statistics helpers ----
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const cj of c) s += cj / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
/** Upper tail Q(a, x) of the regularized incomplete gamma function. */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 10000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a)));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const chiP = (stat, df) => gammaQ(df / 2, stat / 2);
const erfcP2 = (z) => gammaQ(0.5, (z * z) / 2); // two-sided normal p from z

// ---- exact expectations ----
const CATS = ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush"];
const EXACT7 = [23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584]; // best 5 of 7, total C(52,7)
const TOTAL7 = EXACT7.reduce((a, b) => a + b, 0);
if (TOTAL7 !== 133784560) throw new Error("exact 7-card counts do not sum to C(52,7)");
function catOf(name) {
  if (name.startsWith("Royal Flush") || name.startsWith("Straight Flush")) return 8;
  if (name.startsWith("Four")) return 7;
  if (name.startsWith("Full")) return 6;
  if (name.startsWith("Flush")) return 5;
  if (name.startsWith("Straight")) return 4;
  if (name.startsWith("Three")) return 3;
  if (name.startsWith("Two Pair")) return 2;
  if (name.startsWith("Pair")) return 1;
  if (name.startsWith("High Card")) return 0;
  throw new Error(`unknown hand name ${name}`);
}
/** P(a given block of m consecutive positions is all one suit). */
function pSame(m) {
  if (m <= 1) return 1;
  if (m > 13) return 0;
  let p = 4;
  for (let k = 0; k < m; k++) p *= (13 - k) / (52 - k);
  return p;
}
/** Exact expected number of maximal same-suit runs of length exactly L in a random 52-card sequence. */
function expectedRuns(L) {
  let e = 0;
  for (let a = 0; a + L <= 52; a++) {
    const left = a > 0, right = a + L < 52;
    e += pSame(L) - (left ? pSame(L + 1) : 0) - (right ? pSame(L + 1) : 0) + (left && right ? pSame(L + 2) : 0);
  }
  return e;
}
const RUN_MAX = 6; // lengths 1..6 individually, 7+ lumped
const expRun = Array.from({ length: RUN_MAX + 1 }, (_, i) => (i === 0 ? 0 : expectedRuns(i)));
expRun.push(Array.from({ length: 52 - RUN_MAX }, (_, i) => expectedRuns(RUN_MAX + 1 + i)).reduce((a, b) => a + b, 0));

// ---- accumulate ----
assertProduction();
const RANK = (c) => "23456789TJQKA".indexOf(c[0]);
const SUIT = (c) => "cdhs".indexOf(c[1]);
const cardIdx = (c) => SUIT(c) * 13 + RANK(c); // freshDeck order
const posCard = Array.from({ length: 52 }, () => new Float64Array(52)); // [position][card]
const pairCnt = new Float64Array(51);
const suitCnt = new Float64Array(51);
const swapCnt = Array.from({ length: 52 }, (_, i) => new Float64Array(i + 1)); // swapCnt[i][j]
const catCnt = new Float64Array(9);
const runSum = new Float64Array(RUN_MAX + 2), runSq = new Float64Array(RUN_MAX + 2);
const t0 = Date.now();
for (let d = 0; d < N; d++) {
  const { seed, material } = randomHand();
  const { deck, js } = shuffleWithJ(seed, material);
  if (deriveDeck(seed, material).join(",") !== deck.join(",")) throw new Error("deriveDeck mismatch");
  for (let k = 0; k < 51; k++) swapCnt[51 - k][js[k]]++;
  for (let p = 0; p < 52; p++) posCard[p][cardIdx(deck[p])]++;
  const runs = new Float64Array(RUN_MAX + 2);
  let len = 1;
  for (let p = 0; p < 51; p++) {
    if (RANK(deck[p]) === RANK(deck[p + 1])) pairCnt[p]++;
    if (SUIT(deck[p]) === SUIT(deck[p + 1])) { suitCnt[p]++; len++; } else { runs[Math.min(len, RUN_MAX + 1)]++; len = 1; }
  }
  runs[Math.min(len, RUN_MAX + 1)]++;
  for (let L = 1; L <= RUN_MAX + 1; L++) { runSum[L] += runs[L]; runSq[L] += runs[L] * runs[L]; }
  catCnt[catOf(bestHigh(deck.slice(0, 2), deck.slice(2, 7), false).name)]++;
  if (process.stderr.isTTY && d % 50000 === 0) process.stderr.write(`\r${d}/${N}`);
}

// ---- tests ----
const rows = [];
const add = (name, stat, df, p, note = "") => rows.push({ test: name, statistic: stat, df, p, pass: p >= ALPHA, note });
const bonf = (pmin, m) => Math.min(1, pmin * m);

{ // position x card
  const e = N / 52;
  let s = 0;
  for (let p = 0; p < 52; p++) for (let c = 0; c < 52; c++) s += (posCard[p][c] - e) ** 2 / e;
  const adj = (s * 51) / 52; // permutation matrices: statistic ~ (52/51) * chi2(51^2)
  add("position x card, 52x52 table", adj, 2601, chiP(adj, 2601), "chi-square scaled by 51/52 for the permutation constraint");
  let worstCard = 1, worstPos = 1, wc = 0, wp = 0;
  for (let c = 0; c < 52; c++) { let x = 0; for (let p = 0; p < 52; p++) x += (posCard[p][c] - e) ** 2 / e; const pv = chiP(x, 51); if (pv < worstCard) { worstCard = pv; wc = c; } }
  for (let p = 0; p < 52; p++) { let x = 0; for (let c = 0; c < 52; c++) x += (posCard[p][c] - e) ** 2 / e; const pv = chiP(x, 51); if (pv < worstPos) { worstPos = pv; wp = p; } }
  add("each card's position distribution (worst of 52)", NaN, 51, bonf(worstCard, 52), `worst card index ${wc}, raw p ${worstCard.toExponential(2)}, Bonferroni-adjusted`);
  add("each position's card distribution (worst of 52)", NaN, 51, bonf(worstPos, 52), `worst position ${wp}, raw p ${worstPos.toExponential(2)}, Bonferroni-adjusted`);
}
function binomFamily(name, cnt, pr, note) {
  let s = 0;
  const sd = Math.sqrt(N * pr * (1 - pr));
  for (let k = 0; k < 51; k++) s += ((cnt[k] - N * pr) / sd) ** 2;
  add(name, s, 51, chiP(s, 51), note);
}
binomFamily("adjacent cards of equal rank vs 3/51", pairCnt, 3 / 51, "51 adjacent position pairs, each binomial(N, 3/51); sum of squared z");
binomFamily("adjacent cards of equal suit vs 12/51", suitCnt, 12 / 51, "51 adjacent position pairs, each binomial(N, 12/51); sum of squared z");
{ // suit runs
  let worst = 1, wl = 0;
  const detail = [];
  for (let L = 1; L <= RUN_MAX + 1; L++) {
    const mean = runSum[L] / N, varr = Math.max(1e-300, (runSq[L] / N - mean * mean) * (N / (N - 1)));
    const z = (mean - expRun[L]) / Math.sqrt(varr / N);
    const pv = erfcP2(z);
    detail.push({ length: L === RUN_MAX + 1 ? `${L}+` : L, expectedPerDeck: expRun[L], observedPerDeck: mean, z, p: pv });
    if (pv < worst) { worst = pv; wl = L; }
  }
  add(`suit-run lengths 1..${RUN_MAX}, ${RUN_MAX + 1}+ (worst of ${RUN_MAX + 1})`, NaN, 1, bonf(worst, RUN_MAX + 1), `worst length ${wl}, raw p ${worst.toExponential(2)}, Bonferroni-adjusted; exact expectations`);
  rows.suitRuns = detail;
}
{ // swap indices
  let total = 0, df = 0, worst = 1, wi = 0;
  for (let i = 1; i <= 51; i++) {
    const e = N / (i + 1);
    let x = 0;
    for (let j = 0; j <= i; j++) x += (swapCnt[i][j] - e) ** 2 / e;
    total += x; df += i;
    const pv = chiP(x, i);
    if (pv < worst) { worst = pv; wi = i; }
  }
  add("Fisher-Yates swap indices, all ranges pooled", total, df, chiP(total, df), "j uniform on [0,i] for i = 51..1, chi-square summed");
  add("Fisher-Yates swap index, worst single range (of 51)", NaN, wi, bonf(worst, 51), `worst i = ${wi}, raw p ${worst.toExponential(2)}, Bonferroni-adjusted`);
}
{ // hand categories
  let s = 0;
  const cat = [];
  for (let c = 0; c < 9; c++) { const e = (N * EXACT7[c]) / TOTAL7; s += (catCnt[c] - e) ** 2 / e; cat.push({ category: CATS[c], observed: catCnt[c], expected: e }); }
  add("7-card best-hand category vs exact counts", s, 8, chiP(s, 8), "first 7 cards of each deck, engine bestHigh; exact counts over C(52,7)");
  rows.categories = cat;
}

// ---- report ----
const fmt = (x, w) => (Number.isFinite(x) ? x.toFixed(2) : "-").padStart(w);
console.log(`\nMocha Poker permutation tests, N = ${N} decks (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
console.log("test".padEnd(54) + "chi-square".padStart(12) + "df".padStart(7) + "p-value".padStart(12) + "  result");
for (const r of rows) console.log(r.test.padEnd(54) + fmt(r.statistic, 12) + String(r.df).padStart(7) + r.p.toExponential(3).padStart(12) + "  " + (r.pass ? "PASS" : "FAIL"));
console.log("\nPASS means p >= " + ALPHA + ". Rows marked worst-of-m are Bonferroni-adjusted.");
const failed = rows.filter((r) => !r.pass);
mkdirSync("test-reports", { recursive: true });
writeFileSync("test-reports/rng-permutation.json", JSON.stringify({ n: N, alpha: ALPHA, date: new Date().toISOString(), tests: rows.map(({ test, statistic, df, p, pass, note }) => ({ test, statistic: Number.isFinite(statistic) ? statistic : null, df, p, pass, note })), handCategories: rows.categories, suitRuns: rows.suitRuns, failed: failed.length }, null, 2));
if (failed.length) { console.error(`${failed.length} FAILED`); process.exit(1); }
console.log("All permutation tests PASSED");
