# Home Game Poker

A private, browser-based poker room for a group of friends. No downloads, no accounts: the host opens a table and shares the link.

**Games:** No-Limit Texas Hold’em, Pot-Limit Omaha High (4- and 5-card), and Pot-Limit Omaha Hi/Lo 8-or-better (4- and 5-card).

**Fair dealing:** every hand is a uniform Fisher–Yates shuffle driven by Node’s cryptographically secure RNG (`crypto.randomInt`, no modulo bias). Before the first card, the server publishes a SHA-256 commitment of the deck; after the hand it reveals the deck and salt so anyone can verify nothing was changed. See [`packages/engine/src/shuffle.ts`](packages/engine/src/shuffle.ts).

## Layout

```
packages/engine   Pure game logic: cards, shuffle, commit/reveal, variants (tested with Vitest)
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
npm test
```

## Deploy (Fly.io)

```bash
fly launch --no-deploy --copy-config   # first time only; pick a unique app name
fly deploy
```

The POC config in `fly.toml` runs one `shared-cpu-1x` / 256 MB machine that stops when no one is connected, so cost is close to zero between game nights. Tables are kept in memory for now, so a restart clears them.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what’s next.
