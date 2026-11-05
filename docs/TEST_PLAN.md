# Test Plan

This plan is run after every deploy of Mocha Poker. It is written so a Claude Haiku agent can follow it exactly, step by step. Haiku **runs** the checks and **records** what happened. Haiku does not decide what a failure means and does not fix anything: any failure is handed to a Sonnet reviewer (see “If something fails”).

`npm run deploy` runs this plan automatically after deploying (and GitHub runs the automated parts on every push). The QA runner needs the `claude` command-line tool signed in on the deploying computer: run `claude` in a terminal once and type `/login`. To run the plan by hand:

```bash
npm run qa
```

## Rules for the agent running this plan

- Work in the repository root, `D:\projects\homegame-poker`.
- Only run the commands listed in this plan. Do not edit, create or delete any file except your report in `test-reports/`.
- Do not commit, push, deploy, or change any setting on Fly.io or GitHub.
- Copy failure messages exactly. Don’t summarize them away, and don’t guess at causes.
- Run the commands **one at a time**, never two at once. Several of the tests use real timers and can run out of time if the computer is busy.
- If a test command reports failures, run that same command **once more**. If it passes the second time, record the step as **FLAKY**, list the test names that failed the first time, and copy their messages under Failures. FLAKY counts as passing for the Result. A test that fails both times is a real failure.
- If a command fails to run at all (not a test failure but an error such as “command not found” or a crash), record the exact error and continue with the next step.
- Never stop partway without writing the report.

## Steps

### 1. Record the version under test

```bash
git rev-parse --short HEAD
```

```bash
git log -1 --format=%s
```

Record the short commit ID and the commit message.

### 2. Engine and server tests

```bash
npm test
```

```bash
npm run test:server
```

For each, record the “Tests … passed” line. If any test failed, copy the names of the failing tests.

### 3. All games, local server

If `test-reports/games-local.json` exists and was written in the last 30 minutes (the deploy gate writes it), read it. Otherwise run:

```bash
npm run test:games
```

The suite starts its own server and plays every game with bots. Record PASS or FAIL for every game and every rule scenario in the table below, using the `results` list in `test-reports/games-local.json`.

### 4. Live site health

```bash
curl -s https://mochapoker.fly.dev/healthz
```

The answer must be `{"ok":true}`. The first request after an idle period can take a few seconds while the server wakes up; if it fails, wait 10 seconds and try once more.

### 5. All games, live site

```bash
npm run test:live
```

Record PASS or FAIL for every game from `test-reports/games-live.json`. The live run skips the restart test, which only runs locally.

### 6. Live feature check

```bash
node apps/server/test/e2e-features.mjs https://mochapoker.fly.dev
```

There must be 15 lines starting with `PASS` and none starting with `FAIL`. Record the count and copy any `FAIL` lines.

## What must pass

### Every game, local and live

| Game | Variant ID | Must pass |
|---|---|---|
| No-Limit Hold’em | `nlhe` | All hands finish, chips add up, cards stay hidden, house limit enforced |
| Hold’em Hi/Lo (no qualifier) | `nlhe-hilo` | The above, plus every pot with 2+ players at showdown is split High/Low |
| Pot-Limit Omaha High | `plo4` | All hands finish, chips add up, cards stay hidden |
| 5-Card PLO High | `plo5` | Same |
| PLO Hi/Lo 8 or better | `plo4-8` | Same |
| 5-Card PLO Hi/Lo 8 or better | `plo5-8` | Same |
| Omaha Low 8 or better | `plo4-lo8` | Same; low or fallback-high winners |
| Omaha Low (no qualifier) | `plo4-lo` | Same; winners hold low hands |
| FYST | `fyst` | Same; with 3+ players at showdown the best low does **not** win (unless all tie) |
| 5-Murder | `murder5` | Same, plus up cards visible to all, declarations hidden until everyone declares, discard reshuffle with 8 players |

### Rule scenarios

| Scenario | Must pass |
|---|---|
| House limit | Cash games only, Hold’em and Omaha alike (it replaces the Omaha pot limit): first raise 40¢–$2.20 preflop; each raise at least the last; a $2 bet can be raised by exactly $2; at most 3 raises, heads-up too; out-of-range raises rejected with a dollar amount |
| 5-Murder stakes | 20¢ ante; raises up to $1, or $2 in the last round; face-down swap adds exactly 50¢ and is never refunded; face-up swap free; lowest up cards act first |
| Dealer flow | Next hand waits for the award; wrong totals rejected; chip moves; sit-out; player rebuy rejected; dealer rebuy re-seats; +15s once per turn |
| Shuffle proof | Every hand’s revealed deck matches its fingerprint |
| Session history | One history entry per hand; every hand can be opened |
| Restart (local only) | After a server restart mid-hand, the hand, cards, stacks and turn are identical and play continues |

## The report

Write `test-reports/YYYY-MM-DD-HHMM-<commit>.md` (local time), using this template:

```markdown
# Test run YYYY-MM-DD HH:MM — <commit> “<commit message>”

**Result:** ALL PASS | NEEDS REVIEW

| Step | Result | Notes |
|---|---|---|
| Engine tests | 228 passed | |
| Server tests | 79 passed | |
| All games (local) | 10/10 games, 6/6 scenarios | |
| Live health | ok | |
| All games (live) | 10/10 games | |
| Live feature check | 15/15 | |

## Games

| Game | Local | Live |
|---|---|---|
| nlhe | PASS | PASS |
| … | | |

## Failures

(None, or each failure copied exactly with the step it came from.)
```

Set **Result** to `ALL PASS` if every step passed or was FLAKY (and list any FLAKY steps under Failures so they can be fixed later). Otherwise set it to `NEEDS REVIEW`.

## If something fails

Don’t try to fix it. Finish the report with **Result: NEEDS REVIEW**. The QA runner (`scripts/qa.mjs`) then gives the report to a Sonnet reviewer, who reads the failures and the code and adds a **Review** section: real bug or flaky test, the likely cause, and what to do next. Nothing is redeployed or rolled back automatically.

## Visual check (people, before a big release)

The automated checks don’t look at the screen. Before inviting the group to a new release, someone opens the site on a phone and on a computer and checks:

- Cards deal out and flip, chips slide to the pot and to the winner.
- Your own cards never cover the board, including 5-card Omaha and 5-Murder.
- Only legal bet buttons appear (33% / 50% / 75% / Pot / Max).
- The dealer’s award panel, History tab and Download log work.
