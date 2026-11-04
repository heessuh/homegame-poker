import { describe, expect, it } from "vitest";
import { commitDeck, freshDeck, shuffle, verifyDeck } from "../src/index.js";

describe("shuffle", () => {
  it("returns a permutation of the full deck", () => {
    const d = shuffle();
    expect(d).toHaveLength(52);
    expect(new Set(d).size).toBe(52);
    expect([...d].sort()).toEqual(freshDeck().sort());
  });

  it("puts each card in the top slot uniformly (chi-square)", () => {
    const N = 52_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const top = shuffle()[0]!;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const expected = N / 52;
    let chi2 = 0;
    for (const c of freshDeck()) chi2 += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    // 51 degrees of freedom; p = 0.001 critical value is about 87.0.
    expect(chi2).toBeLessThan(87);
  });

  it("deals pocket pairs at the textbook rate (~5.88%)", () => {
    const N = 100_000;
    let pairs = 0;
    for (let i = 0; i < N; i++) {
      const d = shuffle();
      if (d[0]![0] === d[1]![0]) pairs++;
    }
    expect(pairs / N).toBeGreaterThan(0.054);
    expect(pairs / N).toBeLessThan(0.064);
  });
});

describe("commit/reveal", () => {
  it("verifies the original deck and rejects a swapped one", () => {
    const { hash, reveal } = commitDeck(shuffle());
    expect(verifyDeck(hash, reveal.deck, reveal.salt)).toBe(true);
    const tampered = [...reveal.deck];
    [tampered[0], tampered[1]] = [tampered[1]!, tampered[0]!];
    expect(verifyDeck(hash, tampered, reveal.salt)).toBe(false);
  });
});
