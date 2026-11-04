import { describe, expect, it } from "vitest";
import type { TableConfig, TournamentConfig } from "@homegame/engine";
import { UserError } from "../src/table.js";
import { actor, checkDown, foldAround, rig, seatAll, type Rig } from "./helpers.js";

const view = (r: Rig, i = 0) => r.table.viewFor(r.ids[i]!);
const seatOf = (r: Rig, i: number) => view(r).seats.find((s) => s?.playerId === r.ids[i])!;

describe("avatars", () => {
  it("validates, shows and keeps avatars", () => {
    const r = rig(0);
    expect(() => r.table.join("t-bad", "Bad", "not-an-avatar")).toThrow(UserError);
    expect(() => r.table.join("t-bad", "Bad", "100")).toThrow(UserError);
    expect(() => r.table.join("t-bad", "Bad", 5)).toThrow(UserError);
    const a = r.table.join("t-a", "Ana", "🐼");
    const b = r.table.join("t-b", "Bo", "42");
    const c = r.table.join("t-c", "Cy");
    r.table.sit(a, 0, 100);
    r.table.sit(b, 1, 100);
    r.table.sit(c, 2, 100);
    const v = r.table.viewFor(a);
    expect(v.seats[0]!.avatar).toBe("🐼");
    expect(v.seats[1]!.avatar).toBe("42");
    expect(v.seats[2]!.avatar).toBeNull();
  });

  it("setAvatar changes, clears and survives a reconnect without avatar", () => {
    const r = rig(1);
    const id = r.ids[0]!;
    r.table.sit(id, 0, 100);
    r.table.setAvatar(id, "🦊");
    expect(r.table.viewFor(id).seats[0]!.avatar).toBe("🦊");
    expect(() => r.table.setAvatar(id, "🧌")).toThrow(UserError);
    expect(() => r.table.setAvatar(id, "0")).toThrow(UserError);
    expect(r.table.viewFor(id).seats[0]!.avatar).toBe("🦊");
    r.table.join("token-0", "P0");
    expect(r.table.viewFor(id).seats[0]!.avatar).toBe("🦊");
    r.table.join("token-0", "P0", "99");
    expect(r.table.viewFor(id).seats[0]!.avatar).toBe("99");
    r.table.setAvatar(id, null);
    expect(r.table.viewFor(id).seats[0]!.avatar).toBeNull();
  });
});

describe("dealer-awarded pots", () => {
  it("holds the pot, blocks the next hand and pays on award", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    foldAround(r);
    const v = view(r);
    const pa = v.pendingAward!;
    expect(pa.handNumber).toBe(1);
    expect(pa.candidatePlayerIds.sort()).toEqual([...r.ids].sort());
    expect(pa.suggested).toHaveLength(1);
    expect(pa.suggested[0]!.amount).toBe(pa.amount);
    const stacks = v.seats.filter(Boolean).reduce((n, s) => n + s!.stack, 0);
    expect(stacks + pa.amount).toBe(200);

    r.clock.advance(30_000);
    expect(view(r).hand!.handNumber).toBe(1);

    expect(() => r.table.hostAward(other, [{ playerId: other, amount: pa.amount }])).toThrow(/host/);
    expect(() => r.table.hostAward(host, [{ playerId: other, amount: pa.amount + 1 }])).toThrow(/exactly/);
    expect(() => r.table.hostAward(host, [{ playerId: other, amount: pa.amount - 1 }])).toThrow(/exactly/);
    expect(() => r.table.hostAward(host, [{ playerId: "nobody", amount: pa.amount }])).toThrow(UserError);
    expect(() => r.table.hostAward(host, [{ playerId: other, amount: -1 }, { playerId: host, amount: pa.amount + 1 }])).toThrow(UserError);
    expect(() => r.table.hostAward(host, [{ playerId: other, amount: 1.5 }, { playerId: host, amount: pa.amount - 1.5 }])).toThrow(UserError);
    expect(view(r).pendingAward).not.toBeNull();

    r.table.hostAward(host, [{ playerId: other, amount: pa.amount }]);
    const after = view(r);
    expect(after.pendingAward).toBeNull();
    expect(after.seats.filter(Boolean).reduce((n, s) => n + s!.stack, 0)).toBe(200);
    expect(after.log.some((l) => l === `Dealer awards ${pa.amount} to P1`)).toBe(true);
    expect(after.lastHand!.winners).toEqual([{ playerId: other, amount: pa.amount, potIndex: 0, half: "whole", handName: null }]);
    expect(after.hand!.winners).toEqual(after.lastHand!.winners);
    expect(() => r.table.hostAward(host, [])).toThrow(/no pot/);

    r.clock.advance(1000);
    expect(view(r).hand!.handNumber).toBe(2);
  });

  it("splits a showdown pot between players and keeps hand names for hand winners", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    checkDown(r);
    const v = view(r);
    const pa = v.pendingAward!;
    expect(pa.amount).toBe(4);
    expect(v.hand!.board).toHaveLength(5);
    expect(v.seats.find((s) => s && s.playerId !== host)!.holeCards).toHaveLength(2); // showdown cards still shown
    expect(v.log.some((l) => /wins \d+/.test(l))).toBe(false);
    r.table.hostAward(host, [{ playerId: host, amount: 1 }, { playerId: other, amount: 3 }]);
    const after = view(r);
    expect(after.log.some((l) => l === "Dealer awards 1 to P0, 3 to P1")).toBe(true);
    expect(after.lastHand!.winners.map((w) => w.amount).sort()).toEqual([1, 3]);
    expect(after.lastHand!.winners.every((w) => w.half === "whole")).toBe(true);
    const engineWinner = pa.suggested[0]!.playerId;
    expect(after.lastHand!.winners.find((w) => w.playerId === engineWinner)!.handName).not.toBeNull();
    expect(after.seats.filter(Boolean).reduce((n, s) => n + s!.stack, 0)).toBe(200);
  });

  it("applies queued operations after the award, and defers awardMode changes", () => {
    const r = rig(2);
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostConfig(host, { awardMode: "host" });
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostConfig(host, { awardMode: "auto" });
    expect(view(r).pendingConfig?.awardMode).toBe("auto");
    r.table.stand(other);
    foldAround(r);
    expect(view(r).seats[1]).not.toBeNull();
    const amount = view(r).pendingAward!.amount;
    r.table.hostAward(host, [{ playerId: other, amount }]);
    expect(view(r).seats[1]).toBeNull();
    expect(view(r).config.awardMode).toBe("auto");
    const l = view(r).ledger.find((e) => e.playerId === other)!;
    expect(l.cashOuts).toBeGreaterThan(0);
  });
});

describe("dealer transfers", () => {
  it("moves chips at once between hands without touching the ledger", () => {
    const r = rig(3);
    seatAll(r, [0, 1, 2]);
    const [host, a, b] = r.ids as [string, string, string];
    r.table.hostTransfer(host, a, b, 30);
    const v = view(r);
    expect(v.seats[1]!.stack).toBe(70);
    expect(v.seats[2]!.stack).toBe(130);
    expect(v.log).toContain("Dealer moves 30 from P1 to P2");
    expect(v.ledger.find((e) => e.playerId === a)).toMatchObject({ buyIns: 100, cashOuts: 0, stack: 70, net: -30 });
    expect(() => r.table.hostTransfer(host, a, b, 71)).toThrow(UserError);
    expect(() => r.table.hostTransfer(host, a, a, 5)).toThrow(UserError);
    expect(() => r.table.hostTransfer(host, a, b, 0)).toThrow(UserError);
    expect(() => r.table.hostTransfer(host, a, b, 2.5)).toThrow(UserError);
    expect(() => r.table.hostTransfer(a, b, a, 5)).toThrow(/host/);
    expect(() => r.table.hostTransfer(host, a, "ghost", 5)).toThrow(UserError);
  });

  it("queues a transfer during a hand and applies it after the hand", () => {
    const r = rig(2);
    seatAll(r);
    const [a, b] = r.ids as [string, string];
    r.table.hostStart(a);
    r.clock.advance(1000);
    r.table.hostTransfer(a, a, b, 25);
    expect(view(r).log.some((l) => l.startsWith("Dealer moves"))).toBe(false);
    foldAround(r);
    const v = view(r);
    expect(v.log).toContain("Dealer moves 25 from P0 to P1");
    const s0 = v.seats[0]!.stack;
    const s1 = v.seats[1]!.stack;
    expect(s0 + s1).toBe(200);
    expect(s0).toBeGreaterThanOrEqual(73);
    expect(s0).toBeLessThanOrEqual(77);
  });

  it("skips a queued transfer the payer can no longer cover (after the award)", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [a, b] = r.ids as [string, string];
    r.table.hostStart(a);
    r.clock.advance(1000);
    r.table.hostTransfer(a, a, b, 100);
    foldAround(r);
    r.table.hostAward(a, [{ playerId: b, amount: view(r).pendingAward!.amount }]);
    const v = view(r);
    expect(v.log.some((l) => l.includes("was skipped"))).toBe(true);
    expect(v.seats.filter(Boolean).reduce((n, s) => n + s!.stack, 0)).toBe(200);
    expect(v.seats[0]!.stack).toBeGreaterThan(90);
  });
});

describe("host timer controls", () => {
  it("applies a per-player override to the deadline", () => {
    const r = rig(2, { actionTimeoutSec: 30 });
    seatAll(r);
    const host = r.ids[0]!;
    expect(() => r.table.hostPlayerTimer(host, r.ids[1]!, 5)).toThrow(UserError);
    expect(() => r.table.hostPlayerTimer(host, r.ids[1]!, 301)).toThrow(UserError);
    expect(() => r.table.hostPlayerTimer(host, r.ids[1]!, 12.5)).toThrow(UserError);
    expect(() => r.table.hostPlayerTimer(r.ids[1]!, r.ids[1]!, 20)).toThrow(/host/);
    r.table.hostPlayerTimer(host, r.ids[0]!, 20);
    r.table.hostPlayerTimer(host, r.ids[1]!, 20);
    expect(seatOf(r, 0).timeLimitSec).toBe(20);
    r.table.hostStart(host);
    r.clock.advance(1000);
    expect(view(r).hand!.actionDeadline).toBe(r.clock.now() + 20_000);
    // Switching the actor to "no limit" clears the deadline; null returns to the table default.
    const act = actor(r)!;
    r.table.hostPlayerTimer(host, act, 0);
    expect(view(r).hand!.actionDeadline).toBeNull();
    r.table.hostPlayerTimer(host, act, null);
    expect(view(r).hand!.actionDeadline).toBe(r.clock.now() + 30_000);
    expect(seatOf(r, r.ids.indexOf(act)).timeLimitSec).toBeNull();
  });

  it("addTime extends the current deadline", () => {
    const r = rig(2, { actionTimeoutSec: 30 });
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(1000);
    const act = actor(r)!;
    const other = r.ids.find((i) => i !== act)!;
    const deadline = view(r).hand!.actionDeadline!;
    expect(() => r.table.hostAddTime(host, other, 30)).toThrow(UserError);
    expect(() => r.table.hostAddTime(host, act, 5)).toThrow(UserError);
    expect(() => r.table.hostAddTime(act === host ? other : act, act, 30)).toThrow(/host/);
    r.table.hostAddTime(host, act, 45);
    expect(view(r).hand!.actionDeadline).toBe(deadline + 45_000);
    r.clock.advance(30_000);
    expect(actor(r)).toBe(act);
    r.clock.advance(45_000);
    expect(actor(r)).not.toBe(act);
  });

  it("forceTimeout acts for the player without counting toward auto sit-out", () => {
    const r = rig(2, { actionTimeoutSec: 30 });
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    for (let i = 0; i < 3; i++) {
      r.clock.advance(5000);
      const act = actor(r)!;
      const other = r.ids.find((x) => x !== act)!;
      expect(() => r.table.hostForceTimeout(host, other)).toThrow(UserError);
      expect(() => r.table.hostForceTimeout(other === host ? act : other, act)).toThrow(/host/);
      r.table.hostForceTimeout(host, act);
    }
    const v = view(r);
    expect(v.log.filter((l) => l.includes("timed out by the host")).length).toBe(3);
    expect(v.log.some((l) => l.includes("two timeouts"))).toBe(false);
    expect(v.seats.filter(Boolean).every((s) => !s!.sittingOut)).toBe(true);
  });
});

// ------------------------------------------------------------------ tournaments

const TC: TournamentConfig = {
  startingStack: 1000,
  lateRegLevels: 1,
  levels: [
    { smallBlind: 10, bigBlind: 20, minutes: 1 },
    { smallBlind: 20, bigBlind: 40, minutes: 1 },
    { smallBlind: 30, bigBlind: 60, minutes: 1 },
  ],
};
const tcfg = (extra: Partial<TableConfig> = {}): Partial<TableConfig> => ({ mode: "tournament", tournament: TC, actionTimeoutSec: 0, ...extra });
const betSum = (r: Rig) => view(r).seats.reduce((n, s) => n + (s?.bet ?? 0), 0);

describe("tournament", () => {
  it("registers at the starting stack, then starts level 1", () => {
    const r = rig(3, tcfg());
    seatAll(r, undefined, 50); // buy-in ignored
    let v = view(r);
    expect(v.tournament).toMatchObject({ status: "registering", levelIndex: 0, levelEndsAt: null, levelRemainingMs: 60_000, startingStack: 1000, lateRegOpen: true, playersLeft: 3 });
    expect(v.seats[0]!.stack).toBe(1000);
    expect(v.ledger).toEqual([]);
    r.clock.advance(10_000);
    expect(view(r).hand).toBeNull();
    r.table.hostStart(r.ids[0]!);
    v = view(r);
    expect(v.tournament!.status).toBe("running");
    expect(v.tournament!.levelEndsAt).toBe(r.clock.now() + 60_000);
    expect(v.tournament!.nextLevel).toEqual({ smallBlind: 20, bigBlind: 40, minutes: 1 });
    r.clock.advance(1000);
    expect(betSum(r)).toBe(30);
  });

  it("needs two seated players to start", () => {
    const r = rig(2, tcfg());
    r.table.sit(r.ids[0]!, 0, 1);
    expect(() => r.table.hostStart(r.ids[0]!)).toThrow(UserError);
  });

  it("raises blinds when a level expires, for the next hand only", () => {
    const r = rig(3, tcfg());
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    expect(betSum(r)).toBe(30);
    r.clock.advance(59_000);
    let v = view(r);
    expect(v.tournament!.levelIndex).toBe(1);
    expect(v.tournament!.level.bigBlind).toBe(40);
    expect(v.tournament!.levelEndsAt).toBe(r.clock.now() + 60_000);
    expect(v.log).toContain("Level 2: 20/40");
    expect(betSum(r)).toBe(30); // current hand keeps its blinds
    foldAround(r);
    r.clock.advance(5000);
    expect(view(r).hand!.handNumber).toBe(2);
    expect(betSum(r)).toBe(60);
    r.clock.advance(120_000);
    v = view(r);
    expect(v.tournament!.levelIndex).toBe(2); // the last level repeats
    expect(v.tournament!.nextLevel).toBeNull();
    expect(v.log.filter((l) => l.startsWith("Level 3")).length).toBe(1);
  });

  it("pause freezes the clock and resume restarts it", () => {
    const r = rig(3, tcfg());
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(10_000);
    r.table.hostPause(host, true);
    let t = view(r).tournament!;
    expect(t.levelEndsAt).toBeNull();
    expect(t.levelRemainingMs).toBe(50_000);
    r.clock.advance(300_000);
    expect(view(r).tournament!.levelIndex).toBe(0);
    expect(view(r).tournament!.levelRemainingMs).toBe(50_000);
    r.table.hostPause(host, false);
    t = view(r).tournament!;
    expect(t.levelEndsAt).toBe(r.clock.now() + 50_000);
    r.clock.advance(50_000);
    expect(view(r).tournament!.levelIndex).toBe(1);
  });

  it("host can jump levels and adjust the clock", () => {
    const r = rig(3, tcfg());
    seatAll(r);
    const host = r.ids[0]!;
    expect(() => r.table.hostTournamentLevel(host, 1)).toThrow(/not running/);
    r.table.hostStart(host);
    r.clock.advance(20_000);
    r.table.hostTournamentClock(host, 30_000);
    expect(view(r).tournament!.levelRemainingMs).toBe(70_000);
    r.table.hostTournamentClock(host, -10_000_000);
    expect(view(r).tournament!.levelRemainingMs).toBe(1000);
    r.table.hostTournamentLevel(host, 1);
    let t = view(r).tournament!;
    expect(t.levelIndex).toBe(1);
    expect(t.levelRemainingMs).toBe(60_000);
    r.table.hostTournamentLevel(host, 1);
    expect(() => r.table.hostTournamentLevel(host, 1)).toThrow(UserError);
    r.table.hostTournamentLevel(host, -1);
    t = view(r).tournament!;
    expect(t.levelIndex).toBe(1);
    expect(() => r.table.hostTournamentLevel(r.ids[1]!, 1)).toThrow(/host/);
    r.table.hostPause(host, true);
    r.table.hostTournamentClock(host, 5000);
    expect(view(r).tournament!.levelRemainingMs).toBe(65_000);
  });

  it("closes late registration after the configured number of levels", () => {
    const r = rig(5, tcfg());
    r.ids.slice(0, 3).forEach((id, i) => r.table.sit(id, i, 1));
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    r.table.sit(r.ids[3]!, 3, 1);
    expect(view(r).seats[3]!.stack).toBe(1000);
    expect(view(r).tournament!.lateRegOpen).toBe(true);
    r.clock.advance(59_000);
    expect(view(r).tournament!.lateRegOpen).toBe(false);
    expect(() => r.table.sit(r.ids[4]!, 4, 1)).toThrow(/Late registration/);
  });

  it("only allows tournament settings to change outside a running tournament or hand", () => {
    const r = rig(2);
    seatAll(r);
    const host = r.ids[0]!;
    const bad: Partial<TournamentConfig>[] = [
      { startingStack: 99 }, { startingStack: 10_000_001 }, { startingStack: 500.5 }, { levels: [] },
      { levels: Array.from({ length: 41 }, () => ({ smallBlind: 1, bigBlind: 2, minutes: 5 })) },
      { levels: [{ smallBlind: 0, bigBlind: 2, minutes: 5 }] }, { levels: [{ smallBlind: 5, bigBlind: 2, minutes: 5 }] },
      { levels: [{ smallBlind: 1, bigBlind: 2, minutes: 0 }] }, { levels: [{ smallBlind: 1, bigBlind: 2, minutes: 121 }] },
      { lateRegLevels: 4 }, { lateRegLevels: -1 },
    ];
    for (const b of bad) expect(() => r.table.hostConfig(host, { tournament: { ...TC, ...b } })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { mode: "league" as never })).toThrow(UserError);
    r.table.hostStart(host);
    r.clock.advance(1000);
    expect(() => r.table.hostConfig(host, { mode: "tournament", tournament: TC })).toThrow(/no hand is in progress/);
    foldAround(r);
    r.table.hostConfig(host, { mode: "tournament", tournament: TC });
    expect(view(r).tournament!.status).toBe("registering");
    expect(view(r).status).toBe("waiting");
  });

  it("allows variant, award and timer changes while a tournament runs but not mode/tournament", () => {
    const r = rig(3, tcfg());
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    expect(() => r.table.hostConfig(host, { mode: "cash" })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { tournament: { ...TC, startingStack: 2000 } })).toThrow(UserError);
    r.table.hostConfig(host, { variant: "plo4", awardMode: "host", actionTimeoutSec: 20 });
    expect(view(r).config).toMatchObject({ variant: "plo4", awardMode: "host", actionTimeoutSec: 20 });
  });

  it("deals in sitting-out players, who auto-act", () => {
    const r = rig(3, tcfg());
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.table.sitOut(r.ids[2]!, true);
    r.clock.advance(1000);
    expect(r.table.viewFor(r.ids[2]!).seats[2]!.holeCards).toHaveLength(2);
    for (let i = 0; i < 20; i++) {
      const id = actor(r);
      if (!id) break;
      expect(id).not.toBe(r.ids[2]);
      r.table.action(id, { type: "fold" });
    }
    expect(view(r).hand!.winners).not.toBeNull();
  });

  it("ranks simultaneous busts by starting stack and crowns the winner", () => {
    const r = rig(5, tcfg({ awardMode: "host" }));
    seatAll(r, [0, 1, 2, 3, 4]);
    const [host, b, c, d, e] = r.ids as [string, string, string, string, string];
    r.table.hostStart(host);
    // Make the stacks unequal: host holds 1000+300+...; e=100, d=400, c=800, b=1200 -> host takes the remainder.
    r.table.hostTransfer(host, e, host, 900);
    r.table.hostTransfer(host, d, host, 600);
    r.table.hostTransfer(host, c, host, 200);
    r.table.hostTransfer(host, host, b, 200);
    const st = view(r).tournament!.standings;
    expect(st.map((x) => x.stack)).toEqual([2500, 1200, 800, 400, 100]);
    r.clock.advance(1000);
    // e (100) busts alone first: queue adjusts so b..e all bust, host wins the pot.
    for (const [id, amt] of [[b, 1200], [c, 800], [d, 400], [e, 100]] as const) r.table.hostAdjustStack(host, id, -amt);
    foldAround(r);
    const amount = view(r).pendingAward!.amount;
    expect(view(r).tournament!.status).toBe("running");
    r.table.hostAward(host, [{ playerId: host, amount }]);
    const v = view(r);
    expect(v.tournament).toMatchObject({ status: "finished", playersLeft: 1, levelEndsAt: null });
    expect(v.tournament!.standings.map((x) => [x.name, x.place])).toEqual([["P0", 1], ["P1", 2], ["P2", 3], ["P3", 4], ["P4", 5]]);
    expect(v.log).toContain("P4 finishes 5th");
    expect(v.log).toContain("P3 finishes 4th");
    expect(v.log).toContain("P2 finishes 3rd");
    expect(v.log).toContain("P1 finishes 2nd");
    expect(v.log).toContain("P0 wins the tournament!");
    expect(v.status).toBe("waiting");
    expect(v.you.seat).toBe(0);
    expect(v.seats.filter(Boolean)).toHaveLength(1);
    r.clock.advance(60_000);
    expect(view(r).hand!.handNumber).toBe(1); // no further hands

    // A fresh tournament: others sit again (this resets to registering), everyone gets the starting stack.
    r.table.sit(b, 3, 1);
    expect(view(r).tournament!.status).toBe("registering");
    r.table.hostStart(host);
    const v2 = view(r);
    expect(v2.tournament!.status).toBe("running");
    expect(v2.seats.filter(Boolean).map((s) => s!.stack)).toEqual([1000, 1000]);
    expect(v2.tournament!.standings.every((x) => x.place === null)).toBe(true);

  });

  it("eliminates a single bust and keeps playing; mode can return to cash after the end", () => {
    const r = rig(3, tcfg({ awardMode: "host" }));
    seatAll(r);
    const [host, b, c] = r.ids as [string, string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostAdjustStack(host, c, -1000);
    foldAround(r);
    r.table.hostAward(host, [{ playerId: host, amount: view(r).pendingAward!.amount }]);
    let v = view(r);
    expect(v.log).toContain("P2 finishes 3rd");
    expect(v.tournament!.playersLeft).toBe(2);
    expect(v.tournament!.status).toBe("running");
    expect(v.seats[2]).toBeNull();
    expect(v.tournament!.standings.at(-1)).toMatchObject({ name: "P2", place: 3, stack: 0 });
    r.table.hostAdjustStack(host, b, -1000); // between hands: applies at once and ends the tournament
    v = view(r);
    expect(v.tournament!.status).toBe("finished");
    expect(v.log).toContain("P0 wins the tournament!");
    r.table.hostConfig(host, { mode: "cash" });
    expect(view(r).tournament).toBeNull();
    r.table.hostConfig(host, { mode: "tournament" });
    expect(view(r).tournament!.status).toBe("registering");
  });

  it("handles a bust by chips lost: the loser of an all-in finishes behind the winner", () => {
    const r = rig(2, tcfg({ awardMode: "host" }));
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    // Everyone all-in, then the dealer awards the pot to `other`: the host busts.
    for (let i = 0; i < 20; i++) {
      const id = actor(r);
      if (!id) break;
      const legal = r.table.viewFor(id).hand!.legal!;
      if (legal.maxRaiseTo && legal.maxRaiseTo > 0 && i === 0) r.table.action(id, { type: "raise", amount: legal.maxRaiseTo });
      else r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
    }
    const pa = view(r).pendingAward!;
    expect(pa.amount).toBe(2000);
    r.table.hostAward(host, [{ playerId: other, amount: 2000 }]);
    const v = view(r);
    expect(v.log).toContain("P0 finishes 2nd");
    expect(v.log).toContain("P1 wins the tournament!");
    expect(v.tournament!.standings.map((x) => x.name)).toEqual(["P1", "P0"]);
  });
});

describe("mode switches keep the cash ledger honest", () => {
  it("cashes out before a tournament and zeroes tournament chips after", () => {
    const r = rig(2);
    r.table.sit(r.ids[0]!, 0, 150);
    r.table.sit(r.ids[1]!, 1, 100);
    r.table.hostConfig(r.ids[0]!, { mode: "tournament" });
    r.table.hostConfig(r.ids[0]!, { mode: "cash" });
    const v = view(r);
    const me = v.ledger.find((l) => l.playerId === r.ids[0])!;
    expect(me.buyIns).toBe(150);
    expect(me.cashOuts).toBe(150);
    expect(me.net).toBe(0);
    expect(seatOf(r, 0).stack).toBe(0);
    expect(seatOf(r, 0).sittingOut).toBe(true);
    r.table.hostAdjustStack(r.ids[0]!, r.ids[0]!, 200);
    expect(view(r).ledger.find((l) => l.playerId === r.ids[0])!.buyIns).toBe(350);
  });
});

describe("dealer sit-out", () => {
  it("lets only the host mark a player away and back", () => {
    const r = rig(2);
    r.table.sit(r.ids[0]!, 0, 100);
    r.table.sit(r.ids[1]!, 1, 100);
    expect(() => r.table.hostSitOut(r.ids[1]!, r.ids[0]!, true)).toThrow(UserError);
    r.table.hostSitOut(r.ids[0]!, r.ids[1]!, true);
    expect(seatOf(r, 1).sittingOut).toBe(true);
    r.table.hostSitOut(r.ids[0]!, r.ids[1]!, false);
    expect(seatOf(r, 1).sittingOut).toBe(false);
  });
});
