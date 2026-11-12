import { describe, expect, it } from "vitest";
import { VARIANTS, holeRule, splitOf, type VariantId } from "../src/variants.js";

describe("new variants: SMD and TKO", () => {
  it("defines the four new variants with names, hole counts and table sizes", () => {
    expect(VARIANTS.smd4).toMatchObject({ id: "smd4", name: "SMD 4-Card (Omaha Hi/Lo, no qualifier, use 2 or 3 cards)", holeCards: 4, maxPlayers: 10 });
    expect(VARIANTS.smd5).toMatchObject({ id: "smd5", name: "SMD 5-Card (Omaha Hi/Lo, no qualifier, use 2 or 3 cards)", holeCards: 5, maxPlayers: 8 });
    expect(VARIANTS.tko4).toMatchObject({ id: "tko4", name: "TKO 4-Card (points, high and low)", holeCards: 4, maxPlayers: 10 });
    expect(VARIANTS.tko5).toMatchObject({ id: "tko5", name: "TKO 5-Card (points, high and low)", holeCards: 5, maxPlayers: 8 });
  });

  it("all four are pot-limit Hi/Lo splits", () => {
    for (const id of ["smd4", "smd5", "tko4", "tko5"] as VariantId[]) {
      expect(VARIANTS[id].betting).toBe("pot-limit");
      expect(VARIANTS[id].hiLo).toBe(true);
      expect(splitOf(VARIANTS[id])).toBe("hilo");
    }
  });

  it("only TKO scores by points", () => {
    const points = Object.values(VARIANTS).filter((v) => v.scoring === "points").map((v) => v.id);
    expect(points.sort()).toEqual(["tko4", "tko5"]);
    expect(VARIANTS.plo4.scoring).toBeUndefined();
  });

  it("only SMD uses the 2or3 hole rule", () => {
    const rules = Object.values(VARIANTS).filter((v) => v.holeUse === "2or3").map((v) => v.id);
    expect(rules.sort()).toEqual(["smd4", "smd5"]);
    expect(holeRule(VARIANTS.smd4)).toBe("2or3");
    expect(holeRule(VARIANTS.smd5)).toBe("2or3");
  });

  it("the other Omaha games keep the exactly-two rule, TKO uses no hand rule", () => {
    expect(holeRule(VARIANTS.plo4)).toBe(true);
    expect(holeRule(VARIANTS.plo5)).toBe(true);
    expect(holeRule(VARIANTS.tko4)).toBe(false);
    expect(holeRule(VARIANTS.tko5)).toBe(false);
  });

  it("SMD uses any-low (no qualifier)", () => {
    expect(VARIANTS.smd4.lowRule).toBe("any");
    expect(VARIANTS.smd5.lowRule).toBe("any");
  });
});
