# Roadmap

## POC (current)
- [x] Monorepo scaffold: engine, server, web
- [x] CSPRNG Fisher–Yates shuffle with statistical tests
- [x] Deck commit/reveal (provably fair)
- [x] Variant definitions: NLHE, PLO4, PLO5, PLO4-8, PLO5-8
- [x] Fly.io scale-to-zero config, CI
- [x] First deploy to Fly.io (https://mochapoker.fly.dev)

## Beta: playable game
- [x] Hand evaluator: high hands (Hold’em any-5-of-7; Omaha exactly 2 hole + 3 board)
- [x] Low evaluator: 8-or-better, Omaha 2+3 rule, split and quartered pots
- [x] Betting engine: no-limit and pot-limit, min-raise rules, all-in, side pots
- [ ] Hand flow: button, blinds, streets, showdown, muck
- [x] Host controls: blinds, stacks, seat/kick players, pause, change game between hands
- [x] Action timer, reconnect after a dropped connection
- [ ] Chip ledger (buy-ins, cash-outs) and per-table hand history
- [x] Table UI for phones and desktops

## After the beta
- [ ] Persist tables and history (SQLite on a Fly volume, or Postgres)
- [ ] Public “verify this hand” page using the revealed deck
- [ ] Dealer’s-choice / mixed-game rotation
- [ ] Custom domain
