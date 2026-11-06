# Provably fair shuffling: "mochapoker-v1"

Every deck at a Mocha Poker table is a uniform Fisher–Yates shuffle of the 52 cards whose randomness is fixed by two things:

* a secret **server seed**, committed to (by hash) *before* anyone could know the hand, and
* a **client seed** from each player, chosen in the player's browser *after* seeing that commitment.

**What the proof reveals.** The check needs the whole shuffled deck, so once a hand is over the record shows every card in the deck, including the cards of players who folded and, in board games, the order cards were dealt. Players are told this on the waiting screen and in the player guide. A mode that withholds the deck would give up independent full-deck verification, so it is not built (see the roadmap).

The server cannot pick a convenient seed after seeing the players' seeds (the hash is already public), and no player can steer the result alone (the server seed is secret until the hand ends). After each hand the server reveals its seed, and anyone can recompute the deck. The "Verify fairness" button in Last hand and History does exactly that in your browser.

## Protocol

1. **Commitment.** A table always holds a secret `nextServerSeed` (32 random bytes) for the next hand. It publishes `serverSeedHash = hex(sha256(seedBytes))` (hash of the 32 decoded bytes, not of the hex text) in `TableView.fairness = { nextHandNumber, serverSeedHash }`. The first seed is created with the table; the next one is created right after a hand's deck is built, so the commitment for hand N+1 is visible during hand N.
2. **Client seeds.** When a client sees a commitment it has not answered yet, it generates 16 random bytes (`crypto.getRandomValues`), encodes them as 32 lowercase hex characters, and sends `seed { handNumber, clientSeed }`. It also stores `{ tableId, handNumber, serverSeedHash, clientSeed }` in `localStorage` (last 300) so it can later prove which commitment it saw before the deal. The server keeps one seed per player for `nextHandNumber` (a later one replaces an earlier one until the deal) and silently ignores anything else (wrong hand number, not `/^[0-9a-f]{32}$/`).
3. **Deal.** The seeds of the players dealt into the hand are used; players who sent none simply do not contribute (the table log says e.g. `Shuffle seeds: 4 of 5 players`).
   * `material = "mochapoker-v1|" + tableId + "|" + handNumber + "|" + pairs.join(",")` where `pairs` is every contributing `playerId + ":" + clientSeed`, sorted by `playerId` (plain string order, UTF-16 code units).
   * Random stream: for `i = 0, 1, 2, ...`, `block_i = HMAC-SHA256(key = serverSeedBytes, message = UTF-8(material + "|" + i))`. Each block is read as eight big-endian uint32 values, in order; blocks are consumed one after another.
   * `randInt(n)`: `limit = floor(2^32 / n) * n`; draw the next uint32 `u` until `u < limit`; return `u % n` (rejection sampling, no modulo bias).
   * `deck = freshDeck()` (clubs, diamonds, hearts, spades, each 2 3 4 5 6 7 8 9 T J Q K A; cards written like `Kc`, `Td`). Then for `i = 51` down to `1`: `j = randInt(i + 1)`; swap `deck[i]` and `deck[j]`. The first card dealt is `deck[0]`.
4. **5-Murder reshuffles.** When the draw pile runs out in the middle of a hand, the discard pile (in its current order) is shuffled with the same algorithm. The k-th reshuffle of the hand (k = 1, 2, ...) uses the message prefix `material + "|reshuffle" + k` in place of `material` (so block i uses `material + "|reshuffle" + k + "|" + i`), with the same server seed as key.
5. **Reveal.** When the hand completes, the hand record gains `fair = { algorithm: "mochapoker-v1", serverSeed, serverSeedHash, clientSeeds, material }` next to the existing `reveal.deck`. The legacy deck fingerprint (`deckHash = sha256(salt + ":" + deck.join(","))`) is still published during the hand and revealed afterwards.

## What to check

1. `sha256(hex-decoded serverSeed) == serverSeedHash`, and that hash equals the commitment you saw *before* the deal.
2. Your own seed appears in `clientSeeds` under your player id.
3. `material` rebuilt from `tableId`, `handNumber` and `clientSeeds` equals `fair.material`, and the deck derived from `serverSeed` and `material` equals `reveal.deck`.
4. The deck fingerprint matches.

## Test vectors

`seed` and `material` as below; `hash = sha256(hex-decoded seed)`.

Vector 1
```
seed     000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
material mochapoker-v1|tbl|1|
hash     630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd
deck     Kc 5d Jd 5c Qc 9s 3h Ah Ad 8s 7d 5s Jh Kd 4c Th Ks Qh 8d Ac 3c 7s As Kh Jc 2h Ts 2c 6s 4h 4s 7h Qs 6d 9c 3d 8c 9d Qd 9h 4d Js 2d 7c 6h 2s Tc 6c 3s 8h 5h Td
```

Vector 2
```
seed     ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
material mochapoker-v1|room7|12|p1:fedcba9876543210fedcba9876543210,p2:0123456789abcdef0123456789abcdef
hash     af9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051
deck     8c Ad 5h 9s Qc Jd Td 9c 7h 8h Qs 9h Jc 7d 2c 3c 4c 2d Jh 4h 4s Ks 2h 2s 4d 8s As Th Qh 6c Kc 5s Tc 6h 5d 3s Ac 7c 8d 5c 6s 3d Kh 7s Ah Ts Js 6d 9d 3h Kd Qd
```

Vector 3
```
seed     a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5
material mochapoker-v1|abc123|42|amy:22222222222222222222222222222222,bob:33333333333333333333333333333333,zed:11111111111111111111111111111111
hash     fc8b64001c5fdd0f2f40fb67dae4a865a2c5bd17836676d6d5b58b7917e33717
deck     9s Qs Qc Jc Kc Jd 4d As Tc Qh 4s 6h 6c 8c Td 5s Th 4c Qd 9c 5h Ac 3h Jh 7s 6d 3d Ad 7c Ks 2c 9d Kd Js 9h 8d 3c Ts 4h Ah 2d 2s 5d 7d 7h 6s 8h Kh 8s 3s 5c 2h
```

## Reference implementation (Node)

```js
import { createHmac } from "node:crypto";
function derive(seedHex, material) {
  const key = Buffer.from(seedHex, "hex");
  let block = 0, words = [];
  const next = () => {
    if (!words.length) {
      const d = createHmac("sha256", key).update(material + "|" + block++).digest();
      for (let o = 0; o < 32; o += 4) words.push(d.readUInt32BE(o));
    }
    return words.shift();
  };
  const deck = [];
  for (const s of "cdhs") for (const r of "23456789TJQKA") deck.push(r + s);
  for (let i = 51; i >= 1; i--) {
    const n = i + 1, limit = Math.floor(2 ** 32 / n) * n;
    let u; do u = next(); while (u >= limit);
    const j = u % n;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
```

Code: `packages/engine/src/fair.ts` (shared rules), `fairshuffle.ts` (Node), `fairshuffle-web.ts` (WebCrypto, used by the browser).

## Limits of the guarantee

* A player who never sends a seed gets no say in the shuffle, but the server still cannot change its committed seed, and the others' seeds still count. Checking that your own seed is included is what proves the server did not drop it.
* The server could in theory refuse to deal a hand it dislikes, but it cannot choose the cards.
* Table tests and tools can inject fixed decks; such hands carry no `fair` data and the table publishes no commitment.
