# Testing the shuffle’s randomness

Mocha Poker shuffles with the “mochapoker-v1” scheme described in [FAIRNESS.md](FAIRNESS.md). That document proves *who controls* the shuffle (the server commits first, every player adds their own seed). This one answers a different question: **does the stream of random numbers behind the shuffle look random to the standard tools that statisticians and cryptographers use?**

We did not write any of the main test suites. We only feed them the exact bytes the production code produces.

## What the suites are

| Suite | Written by | What it does |
|---|---|---|
| **dieharder** | Robert G. Brown (Duke University), building on George Marsaglia’s “Diehard” battery | About 114 statistical tests (birthday spacings, binary matrix ranks, runs, bit-pattern counts, and more). Each gives a p-value; the verdict is PASSED, WEAK or FAILED. |
| **PractRand** 0.95 | Chris Doty-Humphrey | Feeds an ever longer stream (megabytes, then gigabytes) through hundreds of tests and reports any “anomaly”, ranked from *unusual* through *suspicious* to *FAIL*. Very good at catching subtle patterns that only show up in long streams. |
| **NIST SP 800-22** (STS 2.1.2) | US National Institute of Standards and Technology | The reference battery used to evaluate random number generators in cryptography: 15 tests (frequency, runs, spectral, linear complexity, and so on). We run 100 sequences of 1,000,000 bits and check how many sequences pass each test. |
| **Permutation tests** | us (`scripts/rng-permutation-tests.mjs`) | Look at finished *decks* rather than raw bytes: is every card equally likely in every position, are neighbouring cards independent, are the shuffle’s swap choices uniform, and do 7-card poker hands come up at exactly the textbook frequencies? Standard chi-square tests with the exact expected values. |

The first three are independent, third-party tools. The permutation tests are ours, but they only compare against exact combinatorial answers (for example, 41,584 straight flushes among the 133,784,560 possible 7-card hands), so there is nothing to tune.

## What we feed them

`scripts/rng-export.mjs` produces the bytes. The engine does not publish its internal random stream, so the script re-implements it exactly as written in FAIRNESS.md. **At every start it proves that the copy is the real thing**: it must reproduce the three published test-vector decks and 300 random hands, card for card, through the engine’s own `deriveDeck`. If any deck differs, it stops with an error.

It then simulates hands: a brand-new random 32-byte server seed, a table id, a hand number and 0 to 9 players’ client seeds for each hand, exactly like a real table. There are two modes:

* **`stream` (default)** emits the first 256 bytes of each hand’s HMAC-SHA256 stream, which is what the shuffle reads (it uses about 204 of those bytes). This tests the random stream across many different seeds and materials. Used for dieharder and PractRand (large), and NIST.
* **`decks`** runs the full shuffle, then emits 200 bits of each deck’s *Lehmer rank* (a number that identifies the exact permutation, built from the Fisher–Yates swap choices). This tests the shuffle layer too: the rejection sampling and the Fisher–Yates swaps. It is slower to generate, so the suites run on smaller amounts (PractRand 512 MB, NIST 12.5 MB). 52! is not a power of two, so only the low 200 bits are used; the leftover bias is about one part in 30 million per value, far below anything these tools can detect.

## What passing means, and what it doesn’t

* **It cannot prove randomness.** No test can. Passing means “these tools, looking for these kinds of patterns in this much data, found none.” A good generator passes. A broken one usually fails quickly. That is the evidence we are after.
* **Together with the commitment scheme it shows the deck can’t be steered.** The tests show the output has no detectable bias or structure. The commit-then-reveal protocol shows nobody can choose the seed after seeing the others. Both are needed: a perfectly random generator would still be unfair if the server could pick the seed afterwards, and a perfect protocol would still be unfair if the numbers were biased.
* **It does not test the running server.** It tests the code path. A server that quietly swapped in different code would be caught by the “Verify fairness” button, which recomputes your hand from the revealed seed.
* **A few WEAK results are normal.** dieharder runs about 114 tests, and each one has a small chance of flagging a perfectly random stream as WEAK. Over a whole run a WEAK or two is expected, and a second run will show different ones. The same goes for a couple of PractRand “unusual” notes, and for NIST rows landing just under the 96% line. That is why the workflow **fails only on clear failures** (dieharder FAILED, PractRand FAIL, a NIST test far below the acceptance proportion, or a permutation FAIL) and merely reports WEAK results. A real defect shows up as the same test failing hard, over and over, at ever larger sample sizes.
* In the permutation tests a **p-value below 0.001** is a FAIL. For families of many sub-tests (for example “each of the 52 cards”) the worst one is shown with a Bonferroni adjustment (its p-value times the number of sub-tests), so the whole family still has about a 0.1% false-alarm rate.

### Exact gating rules

* **dieharder:** the job fails on any FAILED line, except `diehard_sums`, which dieharder’s own documentation describes as unreliable (it is still listed in the summary).
* **PractRand:** fails on any anomaly graded FAIL. Lower grades are listed in the summary and not fatal.
* **NIST:** a row is “below acceptance” under 0.9602 (99 − 3 standard deviations for 100 sequences). The job fails if any row is under 90%, any uniformity p-value is under 1e-5, or more than 5% of rows are below acceptance.
* **Permutation:** any row with p < 0.001.

## How to run it

1. On GitHub open **Actions → RNG certify → Run workflow** (branch `main`).
2. It also runs by itself on the 1st of each month (06:00 UTC) and whenever `packages/engine/src/fair*.ts` or `shuffle.ts` changes on `main`.
3. When it finishes, open each job and read the summary at the top of the run page. Full logs are attached as artifacts (`dieharder-logs`, `practrand-logs-stream`, `practrand-logs-decks`, `nist-logs-stream`, `nist-logs-decks`, `permutation-logs`).

Expected time: permutation tests a few minutes, NIST about 10 to 20 minutes, PractRand (16 GB) 30 to 60 minutes, dieharder about 75 minutes (8 jobs in parallel; the full `-a` would take about 8 hours in one job). The big runs are limited by how fast Node can compute HMACs (roughly 10 MB/s on a 4-core runner), not by the test tools.

On your own computer (after `npm ci && npm run build`):

```
node scripts/rng-permutation-tests.mjs --n 200000     # permutation tests, writes test-reports/rng-permutation.json
node scripts/rng-export.mjs --bytes 1000000 --out x.bin
node scripts/rng-export.mjs --mode=decks | dieharder -a -g 200   # if dieharder is installed
```

The workflow needs the internet at run time for the PractRand source (SourceForge) and the NIST STS source (csrc.nist.gov). If the NIST download or build fails, the NIST job falls back to the Python package `nistrng` and says so in its summary. If the PractRand download or build fails, that job fails loudly, so a missing result is never mistaken for a pass.

## Results

Fill in a row after each run (copy the numbers from the job summaries).

| Date | Commit | dieharder (PASSED / WEAK / FAILED) | PractRand size reached (stream / decks) | NIST pass proportions (stream / decks) | Permutation (N) |
|---|---|---|---|---|---|
| 2026-11-04 | f64e334 + working-tree changes | not run yet | not run yet | not run yet | All 9 tests PASS, N = 200,000 (local run; the workflow uses 1,000,000) |
| 2026-11-04 | 83025d8 ([run 41893755190](https://github.com/heessuh/homegame-poker/actions/runs/41893755190)) | not completed here (one job cannot finish `-a` in time; see the next row) | stream: 16 GB, no FAIL, 1 “unusual” (FPF-14+6/16:all, p = 6.8e-4); decks: 512 MB, no FAIL, 1 “unusual” ([Low8/32]BCFN, p = 1 − 1.1e-4) | stream: 1 of 188 rows below the acceptance proportion; decks: 3 of 188 (10 allowed); no row below 90%; no uniformity p < 1e-4 | All tests PASS, N = 1,000,000 |
| 2026-11-04 | 377a34a ([run 41898548152](https://github.com/heessuh/homegame-poker/actions/runs/41898548152)) | 114 / 0 / 0 (`-a` split into 8 parallel jobs) | both jobs passed (no FAIL) | both jobs passed | All tests PASS, N = 1,000,000 |
| _next run_ | | | | | |

The first workflow run (41866825867) never tested the data: SourceForge refused the PractRand download (HTTP 403), and NIST STS 2.1.2’s `assess` exits with status 1 even on success, which stopped the job before the report was saved. Both are fixed in the workflow; the shuffle itself was not changed. A single “unusual” among PractRand’s hundreds of test results is expected by chance; PractRand treats only “FAIL” (or a run of growing anomalies at longer lengths) as evidence of a problem. dieharder `-a` needs more data than one 3-hour job can stream at about 9 MB/s, so the workflow now splits it into 8 parallel jobs (one per group of tests) and a combined gate that applies the same rules to all of their logs together. The first split run passed all 114 tests with no WEAK results.

Local permutation run, 2026-11-04, N = 200,000 decks (all PASS, threshold p ≥ 0.001): position × card 52×52 (df 2601), each card’s and each position’s distribution (worst of 52), adjacent equal-rank pairs vs 3/51, adjacent equal-suit pairs vs 12/51, suit-run lengths, pooled and worst-single Fisher–Yates swap index distributions (df 1326), and the 7-card hand-category distribution vs the exact counts (df 8). The raw numbers are in `test-reports/rng-permutation.json`.
