import { describe, expect, it } from "vitest";
import { freshDeck, verifyDeck } from "@homegame/engine";
import { Table, UserError, type TableSnapshot } from "../src/table.js";
import { actor, checkDown, FakeClock, foldAround, rig, seatAll, type Rig } from "./helpers.js";

describe("identity", () => {
  it("makes the first joiner host and never exposes tokens", () => {
    const r = rig(2);
    const v0 = r.table.viewFor(r.ids[0]!);
    const v1 = r.table.viewFor(r.ids[1]!);
    expect(v0.you.isHost).toBe(true);
    expect(v1.you.isHost).toBe(false);
    expect(v1.hostPlayerId).toBe(r.ids[0]);
    expect(JSON.stringify(v0)).not.toContain("token-0");
  });

  it("trims names, enforces 1-20 chars and de-duplicates", () => {
    const r = rig(0);
    expect(() => r.table.join("a-token", "   ")).toThrow(UserError);
    expect(() => r.table.join("a-token", "x".repeat(21))).toThrow(UserError);
    const a = r.table.join("tok-a", "  Ana ");
    const b = r.table.join("tok-b", "Ana");
    r.table.sit(a, 0, 100);
    r.table.sit(b, 1, 100);
    const names = r.table.viewFor(a).seats.filter(Boolean).map((s) => s!.name);
    expect(names).toEqual(["Ana", "Ana2"]);
  });

  it("keeps seat and state when the same token reconnects", () => {
    const r = rig(2);
    r.table.sit(r.ids[1]!, 3, 100);
    r.table.disconnect(r.ids[1]!);
    expect(r.table.viewFor(r.ids[0]!).seats[3]!.connected).toBe(false);
    const again = r.table.join("token-1", "P1");
    expect(again).toBe(r.ids[1]);
    const v = r.table.viewFor(again);
    expect(v.you.seat).toBe(3);
    expect(v.seats[3]!.connected).toBe(true);
  });
});

describe("seating", () => {
  it("validates seat and buy-in", () => {
    const r = rig(2);
    const t = r.table;
    expect(() => t.sit(r.ids[0]!, 9, 100)).toThrow(UserError);
    expect(() => t.sit(r.ids[0]!, -1, 100)).toThrow(UserError);
    expect(() => t.sit(r.ids[0]!, 0, 39)).toThrow(UserError);
    expect(() => t.sit(r.ids[0]!, 0, 401)).toThrow(UserError);
    expect(() => t.sit(r.ids[0]!, 0, 50.5)).toThrow(UserError);
    t.sit(r.ids[0]!, 0, 100);
    expect(() => t.sit(r.ids[1]!, 0, 100)).toThrow(/taken/);
    expect(() => t.sit(r.ids[0]!, 1, 100)).toThrow(/already seated/);
    const v = t.viewFor(r.ids[0]!);
    expect(v.seats).toHaveLength(9);
    expect(v.ledger[0]).toMatchObject({ buyIns: 100, cashOuts: 0, stack: 100, net: 0 });
  });

  it("stand outside a hand cashes out immediately", () => {
    const r = rig(1);
    r.table.sit(r.ids[0]!, 2, 100);
    r.table.stand(r.ids[0]!);
    const v = r.table.viewFor(r.ids[0]!);
    expect(v.you.seat).toBeNull();
    expect(v.ledger[0]).toMatchObject({ buyIns: 100, cashOuts: 100, stack: 0, net: 0 });
  });
});

describe("hands", () => {
  it("only the host can start, and nothing starts before hostStart", () => {
    const r = rig(2);
    seatAll(r);
    expect(() => r.table.hostStart(r.ids[1]!)).toThrow(/host/);
    r.clock.advance(10_000);
    expect(r.table.viewFor(r.ids[0]!).hand).toBeNull();
    r.table.hostStart(r.ids[0]!);
    expect(r.table.viewFor(r.ids[0]!).status).toBe("playing");
    r.clock.advance(999);
    expect(r.table.viewFor(r.ids[0]!).hand).toBeNull();
    r.clock.advance(1);
    expect(r.table.viewFor(r.ids[0]!).hand?.handNumber).toBe(1);
  });

  it("plays a full hand; stacks and ledger stay consistent", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    checkDown(r);
    const v = r.table.viewFor(r.ids[0]!);
    expect(v.hand!.winners!.length).toBeGreaterThan(0);
    expect(v.hand!.board).toHaveLength(5);
    const stacks = v.seats.filter(Boolean).map((s) => s!.stack);
    expect(stacks.reduce((a, b) => a + b, 0)).toBe(200);
    expect(v.ledger.map((l) => l.net).reduce((a, b) => a + b, 0)).toBe(0);
    expect(v.log.some((l) => /wins \d+/.test(l))).toBe(true);
    expect(v.log.some((l) => l.startsWith("Flop: "))).toBe(true);
    r.clock.advance(3000);
    expect(r.table.viewFor(r.ids[0]!).hand!.handNumber).toBe(1);
    expect(r.table.viewFor(r.ids[0]!).hand!.winners).not.toBeNull();
    r.clock.advance(1000);
    expect(r.table.viewFor(r.ids[0]!).hand!.handNumber).toBe(2);
    expect(r.table.viewFor(r.ids[0]!).hand!.winners).toBeNull();
  });

  it("uses a shorter pause after a fold", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    foldAround(r);
    r.clock.advance(2499);
    expect(r.table.viewFor(r.ids[0]!).hand!.handNumber).toBe(1);
    r.clock.advance(1);
    expect(r.table.viewFor(r.ids[0]!).hand!.handNumber).toBe(2);
  });

  it("rotates the button over hands, skipping empty seats", () => {
    const r = rig(3);
    seatAll(r, [0, 2, 5]);
    r.table.hostStart(r.ids[0]!);
    const buttons: number[] = [];
    for (let i = 0; i < 4; i++) {
      r.clock.advance(5000);
      const v = r.table.viewFor(r.ids[0]!);
      buttons.push(v.seats.find((s) => s?.isButton)!.seat);
      foldAround(r);
    }
    expect(buttons).toEqual([0, 2, 5, 0]);
  });

  it("queues stand until the hand ends", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    r.table.stand(r.ids[1]!);
    expect(r.table.viewFor(r.ids[1]!).you.seat).toBe(1);
    foldAround(r);
    const v = r.table.viewFor(r.ids[0]!);
    expect(v.you.seat).toBe(0);
    expect(r.table.viewFor(r.ids[1]!).you.seat).toBeNull();
    const l = v.ledger.find((e) => e.playerId === r.ids[1])!;
    expect(l.cashOuts).toBeGreaterThan(0);
    expect(l.stack).toBe(0);
    expect(v.ledger.map((e) => e.net).reduce((a, b) => a + b, 0)).toBe(0);
    r.clock.advance(10_000);
    expect(r.table.viewFor(r.ids[0]!).hand!.handNumber).toBe(1);
  });

  it("queues rebuy and host adjustments during a hand", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    r.table.hostAdjustStack(r.ids[0]!, r.ids[0]!, 50);
    r.table.hostAdjustStack(r.ids[0]!, r.ids[1]!, -20);
    const mid = r.table.viewFor(r.ids[0]!);
    expect(mid.ledger.find((e) => e.playerId === r.ids[0])!.buyIns).toBe(100);
    foldAround(r);
    const v = r.table.viewFor(r.ids[0]!);
    const total = v.seats.filter(Boolean).reduce((a, s) => a + s!.stack, 0);
    expect(total).toBe(200 + 50 - 20);
    expect(v.ledger.find((e) => e.playerId === r.ids[0])!.buyIns).toBe(150);
    expect(v.ledger.find((e) => e.playerId === r.ids[1])!.cashOuts).toBe(20);
  });
});

describe("timers", () => {
  it("times out the player to act and sits them out after two timeouts", () => {
    const r = rig(2, { actionTimeoutSec: 10 });
    seatAll(r);
    const [a, b] = r.ids as [string, string];
    r.table.hostStart(a);
    let hands = 0;
    while (!r.table.viewFor(a).seats[1]!.sittingOut && hands < 8) {
      r.clock.advance(5000);
      hands++;
      expect(r.table.viewFor(a).hand!.actionDeadline).toBeGreaterThan(r.clock.now());
      for (let i = 0; i < 100; i++) {
        const id = actor(r);
        if (!id) break;
        if (id === a) {
          const legal = r.table.viewFor(a).hand!.legal!;
          r.table.action(a, legal.canCheck ? { type: "check" } : { type: "call" });
        } else {
          r.clock.advance(10_000); // b never acts
        }
      }
    }
    const v = r.table.viewFor(a);
    expect(v.seats[1]!.sittingOut).toBe(true);
    expect(v.seats[1]!.playerId).toBe(b);
    expect(v.log.filter((l) => l.includes("P1 timed out")).length).toBe(2);
  });

  it("acts immediately for a player who sits out mid-hand", () => {
    const r = rig(3);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const first = actor(r)!;
    const other = r.ids.find((id) => id !== first)!;
    r.table.sitOut(other, true);
    for (let i = 0; i < 100; i++) {
      const id = actor(r);
      if (!id) break;
      expect(id).not.toBe(other);
      const legal = r.table.viewFor(id).hand!.legal!;
      r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
    }
    expect(r.table.viewFor(r.ids[0]!).hand!.winners).not.toBeNull();
  });
});

describe("config and host", () => {
  it("applies pending config at the next hand and validates input", () => {
    const r = rig(2);
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(1000);
    expect(() => r.table.hostConfig(r.ids[1]!, { bigBlind: 4 })).toThrow(/host/);
    expect(() => r.table.hostConfig(host, { smallBlind: 5, bigBlind: 2 })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { maxSeats: 1 })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { maxSeats: 11 })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { actionTimeoutSec: 4 })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { minBuyIn: 500 })).toThrow(UserError);
    expect(() => r.table.hostConfig(host, { smallBlind: 1.5 })).toThrow(UserError);
    r.table.hostConfig(host, { smallBlind: 2, bigBlind: 4 });
    let v = r.table.viewFor(host);
    expect(v.config.bigBlind).toBe(2);
    expect(v.pendingConfig?.bigBlind).toBe(4);
    foldAround(r);
    r.clock.advance(4000);
    v = r.table.viewFor(host);
    expect(v.config.bigBlind).toBe(4);
    expect(v.pendingConfig).toBeNull();
    expect(v.hand!.handNumber).toBe(2);
  });

  it("applies immediately when no hand is running and protects occupied seats", () => {
    const r = rig(1);
    r.table.sit(r.ids[0]!, 6, 100);
    expect(() => r.table.hostConfig(r.ids[0]!, { maxSeats: 6 })).toThrow(UserError);
    r.table.hostConfig(r.ids[0]!, { maxSeats: 7, variant: "plo4" });
    const v = r.table.viewFor(r.ids[0]!);
    expect(v.config.maxSeats).toBe(7);
    expect(v.config.variant).toBe("plo4");
    expect(v.seats).toHaveLength(7);
  });

  it("pause stops new hands; resume continues", () => {
    const r = rig(2);
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostPause(host, true);
    foldAround(r);
    r.clock.advance(20_000);
    expect(r.table.viewFor(host).status).toBe("paused");
    expect(r.table.viewFor(host).hand!.handNumber).toBe(1);
    r.table.hostPause(host, false);
    r.clock.advance(1000);
    expect(r.table.viewFor(host).hand!.handNumber).toBe(2);
  });

  it("kick removes a player after the hand and blocks re-sitting", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    r.table.hostKick(r.ids[0]!, r.ids[1]!);
    for (let i = 0; i < 50 && actor(r); i++) {
      const id = actor(r)!;
      const legal = r.table.viewFor(id).hand!.legal!;
      r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
    }
    expect(r.table.viewFor(r.ids[0]!).hand!.winners).not.toBeNull();
    expect(r.table.viewFor(r.ids[1]!).you.seat).toBeNull();
    expect(() => r.table.sit(r.ids[1]!, 1, 100)).toThrow(UserError);
  });
});

describe("privacy and fairness", () => {
  it("never leaks hole cards or the deck before showdown", () => {
    const r = rig(3);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const own = r.ids.map((id) => r.table.viewFor(id).seats.find((s) => s?.playerId === id)!.holeCards);
    for (const c of own) expect(c).toHaveLength(2);
    r.ids.forEach((id, i) => {
      const v = r.table.viewFor(id);
      for (const s of v.seats) {
        if (!s) continue;
        if (s.playerId === id) expect(s.holeCards).toEqual(own[i]);
        else expect(s.holeCards).toBeNull();
      }
      expect(v.lastHand).toBeNull();
      const json = JSON.stringify(v);
      r.ids.forEach((_o, j) => {
        if (j !== i) for (const card of own[j]!) expect(json.includes(`"${card}"`)).toBe(false);
      });
      expect(v.hand!.legal === null || v.hand!.toActSeat === v.you.seat).toBe(true);
    });
    expect(r.table.viewFor(r.ids[0]!).hand!.deckHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows hands at showdown and reveals a verifiable deck only after completion", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const hash = r.table.viewFor(r.ids[0]!).hand!.deckHash;
    checkDown(r);
    const v = r.table.viewFor(r.ids[0]!);
    const other = v.seats.find((s) => s && s.playerId !== r.ids[0])!;
    expect(other.holeCards).toHaveLength(2);
    expect(v.lastHand!.deckHash).toBe(hash);
    expect(verifyDeck(hash, v.lastHand!.reveal.deck, v.lastHand!.reveal.salt)).toBe(true);
    expect(v.lastHand!.winners.length).toBeGreaterThan(0);
    r.clock.advance(4000);
    const v2 = r.table.viewFor(r.ids[0]!);
    expect(v2.seats.find((s) => s && s.playerId !== r.ids[0])!.holeCards).toBeNull();
    expect(v2.lastHand!.handNumber).toBe(1);
  });

  it("caps the log at 200 lines", () => {
    const r = rig(2);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    for (let i = 0; i < 40; i++) {
      r.clock.advance(5000);
      foldAround(r);
    }
    expect(r.table.viewFor(r.ids[0]!).log.length).toBeLessThanOrEqual(200);
  });
});

describe("host handoff", () => {
  it("moves host to a connected seated player after 60s offline", () => {
    const r = rig(3);
    r.table.sit(r.ids[2]!, 4, 100);
    r.table.sit(r.ids[1]!, 1, 100);
    r.table.disconnect(r.ids[0]!);
    r.clock.advance(59_999);
    expect(r.table.viewFor(r.ids[1]!).hostPlayerId).toBe(r.ids[0]);
    r.clock.advance(1);
    const v = r.table.viewFor(r.ids[1]!);
    expect(v.hostPlayerId).toBe(r.ids[1]);
    expect(v.you.isHost).toBe(true);
    expect(v.log).toContain("P1 is now the host");
    // The old host does not get it back automatically when they reconnect.
    r.table.join("token-0", "P0");
    expect(r.table.viewFor(r.ids[0]!).hostPlayerId).toBe(r.ids[1]);
  });

  it("keeps host when the host reconnects within 60s", () => {
    const r = rig(2);
    r.table.disconnect(r.ids[0]!);
    r.clock.advance(30_000);
    r.table.join("token-0", "P0");
    r.clock.advance(60_000);
    const v = r.table.viewFor(r.ids[1]!);
    expect(v.hostPlayerId).toBe(r.ids[0]);
    expect(v.log.some((l) => l.includes("is now the host"))).toBe(false);
  });
});

describe("dealer shuffles seats", () => {
  /** playerId -> seat index, for everyone seated. */
  const seatMap = (r: Rig): Map<string, number> => {
    const m = new Map<string, number>();
    r.table.viewFor(r.ids[0]!).seats.forEach((s, i) => { if (s) m.set(s.playerId, i); });
    return m;
  };
  /** playerId -> stack, for everyone seated. */
  const stackMap = (r: Rig): Map<string, number> => {
    const m = new Map<string, number>();
    r.table.viewFor(r.ids[0]!).seats.forEach((s) => { if (s) m.set(s.playerId, s.stack); });
    return m;
  };
  const shuffleEntries = (r: Rig) => r.table.getDealerLog().filter((e) => e.action === "shuffleSeats");

  it("between hands: reseats everyone into the same seats, keeps stacks, and logs each move", () => {
    const r = rig(4);
    seatAll(r, undefined, 100);
    const before = seatMap(r);
    const stacks = stackMap(r);
    r.table.hostShuffleSeats(r.ids[0]!);
    const after = seatMap(r);
    expect([...after.values()].sort()).toEqual([0, 1, 2, 3]);
    expect(after.size).toBe(4);
    expect(stackMap(r)).toEqual(stacks);
    expect([...after.keys()].some((id) => after.get(id) !== before.get(id))).toBe(true);
    const entries = shuffleEntries(r);
    expect(entries).toHaveLength(1);
    const moves = entries[0]!.details.seats as Array<{ playerId: string; from: number; to: number }>;
    expect(moves).toHaveLength(4);
    for (const m of moves) {
      expect(m.from).toBe(before.get(m.playerId));
      expect(m.to).toBe(after.get(m.playerId));
    }
  });

  it("a non-host is refused and nothing changes", () => {
    const r = rig(3);
    seatAll(r);
    const before = seatMap(r);
    expect(() => r.table.hostShuffleSeats(r.ids[1]!)).toThrow(UserError);
    expect(seatMap(r)).toEqual(before);
    expect(shuffleEntries(r)).toHaveLength(0);
    expect(r.table.viewFor(r.ids[0]!).seatShufflePending).toBe(false);
  });

  it("refuses unless at least two players are seated", () => {
    const r = rig(2);
    expect(() => r.table.hostShuffleSeats(r.ids[0]!)).toThrow(UserError);
    r.table.sit(r.ids[0]!, 0, 100);
    expect(() => r.table.hostShuffleSeats(r.ids[0]!)).toThrow(UserError);
    expect(seatMap(r)).toEqual(new Map([[r.ids[0]!, 0]]));
    expect(shuffleEntries(r)).toHaveLength(0);
  });

  it("during a hand: keeps seats, queues the shuffle, refuses a second request, and applies it when the hand ends", () => {
    const r = rig(3);
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(1000);
    const before = seatMap(r);
    r.table.hostShuffleSeats(host);
    expect(seatMap(r)).toEqual(before);
    expect(r.table.viewFor(host).seatShufflePending).toBe(true);
    expect(() => r.table.hostShuffleSeats(host)).toThrow(UserError);
    expect(shuffleEntries(r)).toHaveLength(1); // the queued request only
    foldAround(r);
    const after = seatMap(r);
    expect(after).not.toEqual(before);
    expect([...after.values()].sort()).toEqual([0, 1, 2]);
    expect(r.table.viewFor(host).seatShufflePending).toBe(false);
    expect(r.table.getDealerLog().some((e) => e.action === "seatShuffleApplied")).toBe(true);
  });

  it("a queued shuffle survives a snapshot and restore, and is applied when the restored hand ends", () => {
    const r = rig(3);
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const before = seatMap(r);
    r.table.hostShuffleSeats(r.ids[0]!);
    const snap = JSON.parse(JSON.stringify(r.table.snapshot())) as TableSnapshot;
    expect(snap.seatShuffleBy).toBe(r.ids[0]);

    const clock = new FakeClock();
    clock.t = 5_000_000;
    const table = new Table({
      tableId: snap.tableId, now: clock.now, scheduler: clock, deckSource: () => freshDeck(), onChange: () => undefined, snapshot: snap,
    });
    table.resume();
    const restored: Rig = { clock, table, ids: r.ids };
    expect(table.viewFor(r.ids[0]!).seatShufflePending).toBe(true);
    expect(seatMap(restored)).toEqual(before);
    foldAround(restored);
    expect(seatMap(restored)).not.toEqual(before);
    expect(table.viewFor(r.ids[0]!).seatShufflePending).toBe(false);
    expect(table.getDealerLog().some((e) => e.action === "seatShuffleApplied")).toBe(true);
  });
});
