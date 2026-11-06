# Roadmap

Last updated November 5, 2026. The site is live at https://mochapoker.fly.dev. So far it has been played only by the owner and test bots; the next step is a real game night with friends.

## Done

### Playing
- [x] Hold’em and Omaha evaluators, high and low, with split and quartered pots
- [x] Betting: no-limit, pot-limit, the $2 house limit in cash games, all-ins and side pots
- [x] Games: NLHE, NLHE Hi/Lo, PLO4/5, PLO4-8/5-8, Omaha Low 8, Omaha Low (no qualifier), FYST, SMD (4- and 5-card), TKO (4- and 5-card), 5-Murder
- [x] Hand flow: button, blinds, streets, showdown, muck
- [x] Missed-blind rule for players who sit mid-game (wait for the big blind, or post one)
- [x] Raise rule from friends’ feedback: each raise at least the last, never more than $2 per raise
- [x] Dealer can shuffle seats (queued until the hand ends if one is running)
- [x] Table fits one screen on phones and desktops
- [x] Host controls, action timers, reconnecting, host handoff
- [x] Tournaments
- [x] Chip ledger (buy-ins, rebuys, cash-outs) and hand history
- [x] Table UI for phones and desktops
- [x] Tables saved on a Fly volume, so games survive restarts

### Fairness
- [x] Provably fair shuffle with player seeds ([FAIRNESS.md](FAIRNESS.md))
- [x] Automatic checks of every hand in every player’s browser
- [x] Outside verifier: https://heessuh.github.io/mochapoker-verify/
- [x] Dealer log with a tamper-evident hash chain
- [x] Luck report and session review
- [x] Deploys only from GitHub, and an app code check ([PROVENANCE.md](PROVENANCE.md))
- [x] Independent RNG test suites: dieharder, PractRand, NIST, permutation tests ([RNG_TESTING.md](RNG_TESTING.md))

### Running the site
- [x] Fly.io scale-to-zero hosting, CI, and post-deploy QA ([TEST_PLAN.md](TEST_PLAN.md))
- [x] $5 monthly budget guardrail with email alerts ([BUDGET.md](BUDGET.md))

## Not built yet
- [ ] Dealer’s-choice or mixed-game rotation (today the host changes the game by hand)
- [ ] Custom domain (Fred would buy it; mochapoker.com was unregistered on November 4, 2026)
- [ ] Stronger Fly.io hosting, only if the friends like the beta

## On hold
- [ ] Dealing cards the server can’t read (“mental poker”). Fred asked not to build this for now.
