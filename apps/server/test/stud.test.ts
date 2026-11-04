import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_HOUSE_LIMIT, DEFAULT_STUD, freshDeck, type Card, type TableView } from "@homegame/engine";
import { Table, UserError, formatCents } from "../src/table.js";
import { FakeClock, actor, rig, seatAll, type Rig } from "./helpers.js";

/** A 52-card deck that starts with the given cards (in deal order) followed by the rest in fixed order. */
const crafted = (first: Card[]): Card[] => [...first, ...freshDeck().filter((c) => !first.includes(c))];
const view = (r: Rig, i: number): TableView => r.table.viewFor(r.ids[i]!);
const potOf = (v: TableView): number =>
  v.hand!.pots.reduce((t, p) => t + p.amount, 0) + v.seats.reduce((t, s) => t + (s?.bet ?? 0), 0);

// Two players, seats 0 and 1: seat 0 holds the button, so seat 1 (P1) is dealt first.
// Deal order: P1 down, P0 down, P1 up, P0 up, then 3rd (up) and 4th (up), then 5th (down); draws follow.
const DECK = crafted([
  "9c", "2c", // down: P1 9c, P0 2c
  "Kd", "7h", // up: P1 Kd, P0 7h
  "Qd", "8h", // 3rd up
  "Jd", "9h", // 4th up
  "2s", "3s", // 5th down
  "4d", "5d", "6d", "Ad", // replacement draws
]);

function studRig(config = {}): Rig {
  const r = rig(2, { variant: "murder5", money: "cents", minBuyIn: 500, maxBuyIn: 5000, ...config }, () => [...DECK]);
  seatAll(r, undefined, 1000);
  r.table.hostStart(r.ids[0]!);
  r.clock.advance(1000);
  return r;
}

/** Check/call through betting until the predicate holds for the player to act (or the hand ends). */
function playUntil(r: Rig, stop: (v: TableView) => boolean): string | null {
  for (let i = 0; i < 100; i++) {
    const id = actor(r);
    if (!id) return null;
    const v = r.table.viewFor(id);
    if (stop(v)) return id;
    const legal = v.hand!.legal!;
    if (v.hand!.stage !== "bet") throw new Error(`unexpected stage ${v.hand!.stage}`);
    r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
  }
  throw new Error("did not reach the stop condition");
}

describe("5-Murder through the table", () => {
  it("shows up cards to everyone, keeps down cards private, charges 50 for a down swap and hides declarations", () => {
    const r = studRig();
    const [p0, p1] = r.ids as [string, string];
    const seat0 = (v: TableView) => v.seats[0]!;
    const seat1 = (v: TableView) => v.seats[1]!;

    // Antes (20 each) are in the pot; up cards are public, down cards are hidden.
    let v0 = view(r, 0);
    expect(v0.hand!.phase).toBe("2nd");
    expect(v0.hand!.stage).toBe("bet");
    expect(potOf(v0)).toBe(40);
    expect(seat0(v0).upCards).toEqual(["7h"]);
    expect(seat1(v0).upCards).toEqual(["Kd"]);
    expect(seat0(v0).holeCards).toEqual(["2c"]);
    expect(seat1(v0).holeCards).toBeNull();
    expect(seat1(v0).holeCount).toBe(1);
    expect(JSON.stringify(v0)).not.toContain('"9c"');
    const v1 = view(r, 1);
    expect(seat1(v1).holeCards).toEqual(["9c"]);
    expect(JSON.stringify(v1)).not.toContain('"2c"');
    expect(seat0(v1).holeCount).toBe(1);

    // Betting to the first exchange; both now hold 2 down and 3 up cards.
    const first = playUntil(r, (v) => v.hand!.stage === "exchange");
    expect(first).toBe(p0); // lowest showing hand (7-8-9) swaps first
    v0 = view(r, 0);
    expect(v0.hand!.phase).toBe("draw1");
    expect(v0.hand!.legal!.exchange).toMatchObject({ downCards: ["2c", "3s"], upCards: ["7h", "8h", "9h"], downCost: 50 });
    expect(view(r, 1).hand!.legal).toBeNull();
    expect(seat0(v0).holeCount).toBe(2);
    expect(seat1(v0).upCards).toEqual(["Kd", "Qd", "Jd"]);
    expect(seat1(v0).holeCards).toBeNull();

    // P0 swaps a down card: 50 goes into the pot, the replacement is the next deck card.
    const potBefore = potOf(v0);
    r.table.action(p0, { type: "exchange", card: "2c" });
    const after = view(r, 0);
    expect(potOf(after)).toBe(potBefore + 50);
    expect(seat0(after).holeCards).toEqual(["4d", "3s"]);
    expect(after.log.some((l) => l.includes("swaps a face-down card (−$0.50)"))).toBe(true);
    expect(JSON.stringify(view(r, 1))).not.toContain('"4d"');
    expect(JSON.stringify(view(r, 1))).not.toContain('"2c"');
    // The undealt deck never reaches a client.
    expect(JSON.stringify(after)).not.toContain('"6d"');

    // P1 keeps; betting; second exchange (P0 keeps, P1 swaps an up card for free).
    r.table.action(p1, { type: "exchange", card: null });
    playUntil(r, (v) => v.hand!.stage === "exchange");
    expect(view(r, 0).hand!.phase).toBe("draw2");
    r.table.action(actor(r)!, { type: "exchange", card: null });
    const p1Pot = potOf(view(r, 1));
    r.table.action(actor(r)!, { type: "exchange", card: "Kd" });
    expect(potOf(view(r, 1))).toBe(p1Pot); // face-up swaps are free
    expect(view(r, 1).seats[1]!.upCards).toHaveLength(3);

    // Declare: choices stay hidden until both have declared.
    playUntil(r, (v) => v.hand!.stage === "declare");
    let dv = view(r, 0);
    expect(dv.hand!.phase).toBe("declare");
    const firstDeclarer = actor(r)!;
    expect(view(r, r.ids.indexOf(firstDeclarer)).hand!.legal!.declare).toBe(true);
    r.table.action(firstDeclarer, { type: "declare", choice: "low" });
    dv = view(r, 0);
    const declaredSeat = r.ids.indexOf(firstDeclarer);
    expect(dv.seats[declaredSeat]!.hasDeclared).toBe(true);
    expect(dv.seats[1 - declaredSeat]!.hasDeclared).toBe(false);
    expect(dv.seats.every((s) => !s || s.declared === null)).toBe(true);
    expect(JSON.stringify(dv)).not.toContain('"low"');
    expect(dv.log.some((l) => l.includes("has declared"))).toBe(true);
    expect(dv.log.some((l) => /declares (low|high|both)/i.test(l))).toBe(false);

    r.table.action(actor(r)!, { type: "declare", choice: "high" });
    const done = view(r, 0);
    expect(done.hand!.winners).not.toBeNull();
    expect(done.seats.filter(Boolean).map((s) => s!.declared).sort()).toEqual(["high", "low"]);
    // At the showdown the other player's down cards are revealed, but not duplicated with their up cards.
    const other = done.seats[1]!;
    expect(other.holeCards).toHaveLength(2);
    expect(other.holeCards!.every((c) => !other.upCards.includes(c))).toBe(true);
    expect(other.upCards).toHaveLength(3);
    // Chips are conserved and the log uses dollars.
    expect(done.seats.reduce((t, s) => t + (s?.stack ?? 0), 0)).toBe(2000);
    expect(done.lastHand!.summary.some((l) => /antes \$0\.20/.test(l))).toBe(true);
    expect(done.lastHand!.summary.some((l) => /wins \$\d+\.\d\d/.test(l))).toBe(true);
    expect(done.log.some((l) => /wins \$\d+\.\d\d/.test(l))).toBe(true);
  });

  it("auto-acts for a sitting-out player in exchange and declare stages", () => {
    const r = studRig();
    playUntil(r, (v) => v.hand!.stage === "exchange");
    const idle = actor(r)!;
    r.table.sitOut(idle, true);
    // Their exchange was kept automatically, and play moved on.
    expect(view(r, 0).log.some((l) => l.includes("keeps (away)"))).toBe(true);
    for (let i = 0; i < 50 && actor(r); i++) {
      const id = actor(r)!;
      const v = r.table.viewFor(id);
      const st = v.hand!.stage;
      if (st === "exchange") r.table.action(id, { type: "exchange", card: null });
      else if (st === "declare") r.table.action(id, { type: "declare", choice: "high" });
      else r.table.action(id, v.hand!.legal!.canCheck ? { type: "check" } : { type: "call" });
    }
    const done = view(r, 0);
    expect(done.hand!.winners).not.toBeNull();
    expect(done.log.some((l) => l.includes("has declared (away)"))).toBe(true);
  });

  it("validates exchange and declare payloads", () => {
    const r = studRig();
    const id = playUntil(r, (v) => v.hand!.stage === "exchange")!;
    expect(() => r.table.action(id, { type: "exchange", card: "xx" as Card })).toThrow(UserError);
    expect(() => r.table.action(id, { type: "exchange", card: "Ac" })).toThrow(UserError); // not in hand
    expect(() => r.table.action(id, { type: "declare", choice: "high" })).toThrow(UserError);
    expect(() => r.table.action(id, { type: "check" })).toThrow(UserError);
  });

  it("stud in a tournament uses the configured stakes and plain chips", () => {
    const r = rig(2, { variant: "murder5", mode: "tournament", stud: { ...DEFAULT_STUD, ante: 7 } }, () => [...DECK]);
    seatAll(r, undefined, 1);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const v = view(r, 0);
    expect(potOf(v)).toBe(14);
    expect(v.log.some((l) => l.includes("Antes: 7 each"))).toBe(true);
  });
});

describe("money formatting", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(125)).toBe("$1.25");
    expect(formatCents(20)).toBe("$0.20");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(100000)).toBe("$1000.00");
  });

  it("uses dollars in cash logs and plain numbers for chips and tournaments", () => {
    const cash = rig(1, { money: "cents", minBuyIn: 500, maxBuyIn: 5000 });
    cash.table.sit(cash.ids[0]!, 0, 1250);
    expect(view(cash, 0).log).toContain("P0 sat in seat 1 with $12.50");

    const chips = rig(1, { money: "chips" });
    chips.table.sit(chips.ids[0]!, 0, 100);
    expect(view(chips, 0).log).toContain("P0 sat in seat 1 with 100");

    const tour = rig(2, { money: "cents", mode: "tournament" });
    seatAll(tour);
    tour.table.hostStart(tour.ids[0]!);
    tour.clock.advance(1000);
    expect(view(tour, 0).log.every((l) => !l.includes("$"))).toBe(true);
  });

  it("converts engine summary lines to dollars for board games", () => {
    const r = rig(2, { money: "cents", smallBlind: 10, bigBlind: 20, minBuyIn: 500, maxBuyIn: 5000, houseLimit: { ...DEFAULT_HOUSE_LIMIT, enabled: false } });
    seatAll(r, undefined, 1000);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const first = actor(r)!;
    r.table.action(first, { type: "raise", amount: 125 });
    r.table.action(actor(r)!, { type: "fold" });
    const v = view(r, 0);
    expect(v.log.some((l) => l.includes("raises to $1.25"))).toBe(true);
    const sum = v.lastHand!.summary.join("\n");
    expect(sum).toMatch(/posts small blind \$0\.10/);
    expect(sum).toMatch(/posts big blind \$0\.20/);
    expect(sum).toMatch(/raises to \$1\.25/);
    expect(sum).toMatch(/Uncalled bet of \$1\.05 returned/);
    expect(sum).toMatch(/P\d wins \$0\.40/);
  });
});

describe("config: stud, house limit, money", () => {
  const host = (r: Rig) => r.ids[0]!;

  it("gives every table the new defaults", () => {
    const clock = new FakeClock();
    const t = new Table({ tableId: "plain", now: clock.now, scheduler: clock, deckSource: () => freshDeck(), onChange: () => undefined });
    const id = t.join("tok-defaults", "Ann");
    const c = t.viewFor(id).config;
    expect(c).toEqual(DEFAULT_CONFIG);
    expect(c.smallBlind).toBe(10);
    expect(c.bigBlind).toBe(20);
    expect(c.minBuyIn).toBe(500);
    expect(c.maxBuyIn).toBe(5000);
    expect(c.money).toBe("cents");
    expect(c.stud).toEqual(DEFAULT_STUD);
    expect(c.houseLimit).toEqual(DEFAULT_HOUSE_LIMIT);
    // Mutating a view's config never reaches the table.
    c.stud.ante = 999;
    expect(t.viewFor(id).config.stud.ante).toBe(DEFAULT_STUD.ante);
    // A partial constructor config keeps nested defaults.
    const t2 = new Table({ tableId: "p2", now: clock.now, scheduler: clock, deckSource: () => freshDeck(), onChange: () => undefined, config: { stud: { ante: 5 } as never } });
    expect(t2.viewFor(t2.join("tok-2", "Bea")).config.stud).toEqual({ ...DEFAULT_STUD, ante: 5 });
  });

  it("merges partial nested objects", () => {
    const r = rig(1);
    r.table.hostConfig(host(r), { stud: { ante: 25 } as never });
    r.table.hostConfig(host(r), { houseLimit: { maxBet: 400 } as never });
    const c = view(r, 0).config;
    expect(c.stud).toEqual({ ...DEFAULT_STUD, ante: 25 });
    expect(c.houseLimit).toEqual({ ...DEFAULT_HOUSE_LIMIT, enabled: false, maxBet: 400 });
    r.table.hostConfig(host(r), { stud: { maxBet: 150 } as never });
    expect(view(r, 0).config.stud).toEqual({ ...DEFAULT_STUD, ante: 25, maxBet: 150 });
    r.table.hostConfig(host(r), { money: "chips" });
    expect(view(r, 0).config.money).toBe("chips");
  });

  it("rejects invalid stud, house limit and money settings", () => {
    const r = rig(1);
    const bad: Record<string, unknown>[] = [
      { stud: { ante: -1 } }, { stud: { ante: 1.5 } }, { stud: { minBet: 0 } }, { stud: { minBet: 50, maxBet: 40 } },
      { stud: { maxBetLastRound: 10 } }, { stud: { downExchangeCost: -5 } }, { stud: { maxRaises: 11 } }, { stud: { maxRaises: -1 } },
      { stud: { declare: "yes" } }, { stud: { raiseMustExceed: 1 } }, { stud: { bogus: 1 } }, { stud: null }, { stud: "x" },
      { houseLimit: { enabled: "yes" } }, { houseLimit: { minBet: 0 } }, { houseLimit: { minBet: 30, maxBet: 20 } },
      { houseLimit: { maxRaises: 11 } }, { houseLimit: { raiseMustExceed: null } }, { houseLimit: { bogus: 1 } },
      { money: "dollars" }, { money: 5 },
    ];
    for (const patch of bad) expect(() => r.table.hostConfig(host(r), patch as never), JSON.stringify(patch)).toThrow(UserError);
    // Nothing leaked through the failed patches.
    expect(view(r, 0).config.stud).toEqual(DEFAULT_STUD);
    // Boundary values are accepted.
    r.table.hostConfig(host(r), { stud: { ante: 0, minBet: 1, maxBet: 1, maxBetLastRound: 1, downExchangeCost: 0, maxRaises: 10, declare: false, raiseMustExceed: false } });
    r.table.hostConfig(host(r), { houseLimit: { enabled: true, minBet: 1, maxBet: 1, maxRaises: 0, raiseMustExceed: false } });
  });

  it("caps murder5 at 8 seats and switches variants between hands", () => {
    const r = rig(2);
    expect(() => r.table.hostConfig(host(r), { variant: "murder5", maxSeats: 9 })).toThrow(/Seats must be 2 to 8/);
    r.table.hostConfig(host(r), { variant: "murder5", maxSeats: 8 });
    expect(view(r, 0).config.variant).toBe("murder5");
    expect(view(r, 0).seats).toHaveLength(8);
    r.table.hostConfig(host(r), { variant: "nlhe" });
    expect(view(r, 0).config.variant).toBe("nlhe");
  });

  it("passes the house limit to board games (not in tournaments)", () => {
    const base = { smallBlind: 10, bigBlind: 20, minBuyIn: 500, maxBuyIn: 5000, money: "cents" as const };
    const r = rig(2, { ...base, houseLimit: { enabled: true, minBet: 20, maxBet: 200, maxRaises: 3, raiseMustExceed: true } });
    seatAll(r, undefined, 1000);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const v = r.table.viewFor(actor(r)!);
    expect(v.hand!.legal!.minRaiseTo).toBe(41);
    expect(v.hand!.legal!.maxRaiseTo).toBe(220);

    const t = rig(2, { ...base, mode: "tournament", houseLimit: { enabled: true, minBet: 20, maxBet: 200, maxRaises: 3, raiseMustExceed: true } });
    seatAll(t, undefined, 1);
    t.table.hostStart(t.ids[0]!);
    t.clock.advance(1000);
    const tv = t.table.viewFor(actor(t)!);
    // No-limit sizing: the maximum raise is all-in, well above the house-limit cap.
    expect(tv.hand!.legal!.maxRaiseTo).toBeGreaterThan(220);
  });
});

describe("one-step switch to 5-Murder", () => {
  it("shrinks the seat count to 8 when only the variant is sent", () => {
    const r = rig(1, { maxSeats: 9 });
    r.table.hostConfig(r.ids[0]!, { variant: "murder5" });
    expect(r.table.viewFor(r.ids[0]!).config.maxSeats).toBe(8);
  });
});
