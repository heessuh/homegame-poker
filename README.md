# Home Game Poker

**Live beta:** https://mochapoker.fly.dev · [House Rules](docs/HOUSE_RULES.md)

A private, browser-based poker room for a group of friends. No downloads, no accounts: the host opens a table and shares the link.

**Games:** No-Limit Hold’em and Hold’em Hi/Lo; Pot-Limit Omaha High and Hi/Lo 8-or-better (4- and 5-card); Omaha Low (8-or-better and no qualifier); FYST, Double FYST and Dumb & Dumber; SMD and TKO (4- and 5-card); and 5-Murder. Betting rules are in the [House Rules](docs/HOUSE_RULES.md).

**Fair dealing:** every hand is a uniform Fisher–Yates shuffle. The server commits to a secret seed before the deal, each player’s browser adds its own seed, and the deck is revealed after the hand so anyone can recompute it. Every browser checks this automatically, and an [outside verifier](https://heessuh.github.io/mochapoker-verify/) does it independently. See [`docs/FAIRNESS.md`](docs/FAIRNESS.md) and [`docs/PROVENANCE.md`](docs/PROVENANCE.md).

## Layout

```
packages/engine   Pure game logic: cards, shuffle, fairness, betting, variants (tested with Vitest)
apps/server       Node + Express + Socket.IO; authoritative game state; serves the built web app
apps/web          React + Vite client
```

## Run locally

```bash
npm install
npm run build -w @homegame/engine
npm run dev:server   # http://localhost:3000
npm run dev:web      # http://localhost:5173/#my-table
```

Open the web URL, create a table, and start the game. To test alone, run bots against your table from another terminal, using the table code shown in the table header:

```bash
node apps/server/test/bots.mjs <tableId> 2
```

The bots sit down and call or check every hand, so you can watch a full game.

For players, see [`docs/PLAYING.md`](docs/PLAYING.md). For hosts, see [`docs/HOSTING.md`](docs/HOSTING.md).

## Test

```bash
npm test           # engine
npm run test:all   # engine, server, scripts, and full game runs
```

## Deploy (Fly.io)

Every push to `main` deploys through GitHub Actions. To start a deploy and run the QA plan afterward:

```bash
npm run deploy
```

Deploying straight from a laptop takes `--from-laptop` and is for emergencies only (see [`docs/PROVENANCE.md`](docs/PROVENANCE.md)).

`fly.toml` runs one `shared-cpu-1x` / 256 MB machine that stops when no one is connected, so cost is close to zero between game nights. Tables are saved on a Fly volume, so a restart doesn’t lose them. Spending is capped by the [budget guardrail](docs/BUDGET.md).

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what’s next.
