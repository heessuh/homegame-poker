import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freshDeck, type Card } from "../src/cards.js";
import { buildMaterial, reshufflePrefix } from "../src/fair.js";
import { deriveDeck, derivedShuffle, seedHash } from "../src/fairshuffle.js";
import * as web from "../src/fairshuffle-web.js";
import { applyAction, legalActions, startHand, type HandState } from "../src/game.js";

const S1 = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const S2 = "ff".repeat(32);
const S3 = "a5".repeat(32);
const M1 = buildMaterial("tbl", 1, {});
const M2 = buildMaterial("room7", 12, { p2: "0123456789abcdef0123456789abcdef", p1: "fedcba9876543210fedcba9876543210" });
const M3 = buildMaterial("abc123", 42, {
  zed: "11111111111111111111111111111111", amy: "22222222222222222222222222222222", bob: "33333333333333333333333333333333",
});

// Fixed vectors (also listed in docs/FAIRNESS.md).
const VECTORS = [
  {
    seed: S1, material: "mochapoker-v1|tbl|1|",
    hash: "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
    deck: "Kc 5d Jd 5c Qc 9s 3h Ah Ad 8s 7d 5s Jh Kd 4c Th Ks Qh 8d Ac 3c 7s As Kh Jc 2h Ts 2c 6s 4h 4s 7h Qs 6d 9c 3d 8c 9d Qd 9h 4d Js 2d 7c 6h 2s Tc 6c 3s 8h 5h Td",
  },
  {
    seed: S2, material: "mochapoker-v1|room7|12|p1:fedcba9876543210fedcba9876543210,p2:0123456789abcdef0123456789abcdef",
    hash: "af9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051",
    deck: "8c Ad 5h 9s Qc Jd Td 9c 7h 8h Qs 9h Jc 7d 2c 3c 4c 2d Jh 4h 4s Ks 2h 2s 4d 8s As Th Qh 6c Kc 5s Tc 6h 5d 3s Ac 7c 8d 5c 6s 3d Kh 7s Ah Ts Js 6d 9d 3h Kd Qd",
  },
  {
    seed: S3, material: "mochapoker-v1|abc123|42|amy:22222222222222222222222222222222,bob:33333333333333333333333333333333,zed:11111111111111111111111111111111",
    hash: "fc8b64001c5fdd0f2f40fb67dae4a865a2c5bd17836676d6d5b58b7917e33717",
    deck: "9s Qs Qc Jc Kc Jd 4d As Tc Qh 4s 6h 6c 8c Td 5s Th 4c Qd 9c 5h Ac 3h Jh 7s 6d 3d Ad 7c Ks 2c 9d Kd Js 9h 8d 3c Ts 4h Ah 2d 2s 5d 7d 7h 6s 8h Kh 8s 3s 5c 2h",
  },
];

describe("mochapoker-v1 fixed vectors", () => {
  it("material strings sort seeds by player id", () => {
    expect([M1, M2, M3]).toEqual(VECTORS.map((v) => v.material));
  });
  for (const [i, v] of VECTORS.entries()) {
    it(`vector ${i + 1}: Node and WebCrypto agree with the published deck and hash`, async () => {
      expect(seedHash(v.seed)).toBe(v.hash);
      expect(await web.seedHash(v.seed)).toBe(v.hash);
      expect(deriveDeck(v.seed, v.material).join(" ")).toBe(v.deck);
      expect((await web.deriveDeck(v.seed, v.material)).join(" ")).toBe(v.deck);
    });
  }
});

describe("derived shuffle", () => {
  it("Node and WebCrypto produce identical decks for random inputs", async () => {
    for (let n = 0; n < 200; n++) {
      const seed = randomBytes(32).toString("hex");
      const material = buildMaterial(`t${n}`, n + 1, { a: randomBytes(16).toString("hex"), b: randomBytes(16).toString("hex") });
      const d = deriveDeck(seed, material);
      expect(new Set(d).size).toBe(52);
      expect(await web.deriveDeck(seed, material)).toEqual(d);
      expect(await web.seedHash(seed)).toBe(seedHash(seed));
    }
  });

  it("different material or seed changes the deck", () => {
    expect(deriveDeck(S1, M1)).not.toEqual(deriveDeck(S1, M2));
    expect(deriveDeck(S1, M1)).not.toEqual(deriveDeck(S2, M1));
  });

  it("places a given card in a given slot uniformly (chi-square over 20k derived decks)", () => {
    const N = 20_000;
    const seed = randomBytes(32).toString("hex");
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const top = deriveDeck(seed, `mochapoker-v1|chi|${i}|`)[0]!;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const expected = N / 52;
    let chi2 = 0;
    for (const c of freshDeck()) chi2 += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    expect(chi2).toBeLessThan(87); // 51 d.f., p = 0.001
  });

  it("position of one card is uniform too (card As, 52 slots)", () => {
    const N = 20_000;
    const seed = randomBytes(32).toString("hex");
    const counts = new Array<number>(52).fill(0);
    for (let i = 0; i < N; i++) counts[deriveDeck(seed, `mochapoker-v1|pos|${i}|`).indexOf("As")]!++;
    const expected = N / 52;
    const chi2 = counts.reduce((t, c) => t + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(87);
  });
});

function playOut(fair: boolean): HandState {
  let s = startHand({
    handNumber: 1, variant: "murder5", smallBlind: 1, bigBlind: 2, buttonSeat: 0,
    deck: deriveDeck(S1, M1),
    ...(fair ? { fair: { key: S1, material: M1 } } : {}),
    seats: [...Array(8).keys()].map((i) => ({ seat: i, playerId: `p${i}`, stack: 100 })),
  });
  while (!s.outcome) {
    const id = s.players.find((p) => p.seat === s.toActSeat)!.playerId;
    const l = legalActions(s, id)!;
    const up = s.players.find((p) => p.playerId === id)!.upCards![0] as Card;
    s = applyAction(s, id, l.exchange ? { type: "exchange", card: up } : l.declare ? { type: "declare", choice: "high" } : l.canCheck ? { type: "check" } : { type: "call" });
  }
  return s;
}

describe("stud reshuffle", () => {
  it("is derived from the hand material and fully deterministic", () => {
    const a = playOut(true);
    const b = playOut(true);
    expect(a.fair!.reshuffles).toBeGreaterThanOrEqual(1);
    expect(a.log).toEqual(b.log);
    expect(a.outcome!.shown).toEqual(b.outcome!.shown);
    expect(a.outcome!.winners).toEqual(b.outcome!.winners);
  });

  it("the k-th reshuffle uses the reshuffle<k> stream", () => {
    const pile = freshDeck().slice(0, 20);
    const one = derivedShuffle(pile, S1, reshufflePrefix(M1, 1));
    expect(one).toEqual(derivedShuffle(pile, S1, `${M1}|reshuffle1`));
    expect(one).not.toEqual(derivedShuffle(pile, S1, reshufflePrefix(M1, 2)));
    expect([...one].sort()).toEqual([...pile].sort());
  });

  it("without fair state it falls back to the CSPRNG shuffle and still conserves cards", () => {
    const s = playOut(false);
    expect(s.fair).toBeUndefined();
    expect(s.log).toContain("Discards reshuffled");
  });
});
