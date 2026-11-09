import { describe, expect, it } from "vitest";
import type { TableConfig, TournamentConfig } from "@homegame/engine";
import { UserError } from "../src/table.js";
import { foldAround, rig, seatAll, type Rig } from "./helpers.js";

const TC: TournamentConfig = {
  startingStack: 1000,
  lateRegLevels: 2,
  levels: [
    { smallBlind: 10, bigBlind: 20, minutes: 1 },
    { smallBlind: 10, bigBlind: 20, minutes: 1, isBreak: true },
    { smallBlind: 30, bigBlind: 60, minutes: 1 },
    { smallBlind: 50, bigBlind: 100, minutes: 1 },
  ],
};
const cfg = (t: TournamentConfig): Partial<TableConfig> => ({ mode: "tournament", tournament: t, actionTimeoutSec: 0 });
const view = (r: Rig) => r.table.viewFor(r.ids[0]!);

function running(t: TournamentConfig = TC): Rig {
  const r = rig(3, cfg(t));
  seatAll(r, undefined, 50);
  r.table.hostStart(r.ids[0]!);
  r.clock.advance(1000);
  return r;
}

describe("tournament breaks", () => {
  it("rejects a break as the first or last level", () => {
    const first = { ...TC, levels: [{ smallBlind: 10, bigBlind: 20, minutes: 5, isBreak: true }, ...TC.levels.slice(2)] };
    const last = { ...TC, lateRegLevels: 0, levels: [TC.levels[0]!, { smallBlind: 10, bigBlind: 20, minutes: 5, isBreak: true }] };
    const r = rig(2, cfg(TC));
    expect(() => r.table.hostConfig(r.ids[0]!, { tournament: first })).toThrow(/first level/);
    expect(() => r.table.hostConfig(r.ids[0]!, { tournament: last })).toThrow(/last level/);
  });

  it("deals no hands during a break, then resumes, and a break does not use up late registration", () => {
    const r = running();
    expect(view(r).hand!.handNumber).toBe(1);
    foldAround(r); // hand 1 ends
    r.clock.advance(59_000); // level 1 ends at 60s: the break starts
    expect(view(r).tournament).toMatchObject({ levelIndex: 1, lateRegOpen: true });
    expect(view(r).tournament!.level.isBreak).toBe(true);
    expect(r.table.getLog().some((l) => /Break: 1 minutes/.test(l))).toBe(true);
    foldAround(r); // the hand already in progress may finish
    const during = view(r).hand?.handNumber ?? 1;
    r.clock.advance(45_000); // well inside the break
    expect(view(r).hand?.handNumber ?? 1).toBe(during); // nothing new dealt
    r.clock.advance(20_000); // break over
    r.clock.advance(5_000);
    expect(view(r).tournament).toMatchObject({ levelIndex: 2 });
    expect(view(r).hand!.handNumber).toBeGreaterThan(during);
  });
});

describe("changing levels while the tournament runs", () => {
  const edited = (r: Rig) => r.table.viewFor(r.ids[0]!).tournament!;

  it("lets the host change future levels and keeps the current clock", () => {
    const r = running();
    const before = edited(r).levelRemainingMs;
    r.clock.advance(10_000);
    const levels = [
      TC.levels[0]!,
      { smallBlind: 10, bigBlind: 20, minutes: 5, isBreak: true },
      { smallBlind: 40, bigBlind: 80, minutes: 20 },
      { smallBlind: 80, bigBlind: 160, minutes: 20 },
      { smallBlind: 150, bigBlind: 300, minutes: 20 },
    ];
    r.table.hostTournamentLevels(r.ids[0]!, levels);
    const t = edited(r);
    expect(t.nextLevel).toMatchObject({ minutes: 5, isBreak: true });
    expect(r.table.viewFor(r.ids[0]!).config.tournament.levels).toHaveLength(5);
    expect(t.levelRemainingMs).toBeLessThan(before - 5_000); // the clock kept running, not reset
    expect(r.table.getDealerLog().some((e) => e.action === "tournamentLevels")).toBe(true);
  });

  it("refuses bad changes", () => {
    const r = running();
    const [host, other] = r.ids as [string, string, string];
    const ok = TC.levels.map((l) => ({ ...l }));
    expect(() => r.table.hostTournamentLevels(other, ok)).toThrow(/host/);
    expect(() => r.table.hostTournamentLevels(host, [])).toThrow(UserError);
    expect(() => r.table.hostTournamentLevels(host, "nope")).toThrow(UserError);
    // cannot turn the level being played into a break
    expect(() => r.table.hostTournamentLevels(host, [{ ...ok[0]!, isBreak: true }, ...ok.slice(1)])).toThrow(/break/);
    // cannot end with a break
    expect(() => r.table.hostTournamentLevels(host, [ok[0]!, { ...ok[1]!, isBreak: true }])).toThrow(/last level/);
    // cannot drop the current level
    r.clock.advance(90_000);
    expect(() => r.table.hostTournamentLevels(host, [ok[0]!])).toThrow(/Keep the level/);
  });

  it("is refused when no tournament is running", () => {
    const r = rig(2, cfg(TC));
    expect(() => r.table.hostTournamentLevels(r.ids[0]!, TC.levels)).toThrow(/not running/);
  });
});
