import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { freshDeck, type ClientToServerEvents, type HandRecord, type ServerToClientEvents, type TableView, type TournamentConfig } from "@homegame/engine";
import { startServer } from "../src/index.js";
import { IDLE_DELETE_MS, Store, type FsLike } from "../src/persist.js";
import { Table, UserError, type TableSnapshot } from "../src/table.js";
import { actor, checkDown, FakeClock, LEGACY, rig, seatAll, type Rig } from "./helpers.js";

const view = (r: Rig, i = 0) => r.table.viewFor(r.ids[i]!);
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Restores a table from a snapshot onto a brand-new clock (a "restarted server"). */
function restore(snap: TableSnapshot, ids: string[], startAt = 5_000_000): Rig {
  const clock = new FakeClock();
  clock.t = startAt;
  const table = new Table({
    tableId: snap.tableId, now: clock.now, scheduler: clock, deckSource: () => freshDeck(), onChange: () => undefined,
    snapshot: roundTrip(snap),
  });
  table.resume();
  return { clock, table, ids };
}

const total = (v: TableView) =>
  v.seats.reduce((n, s) => n + (s?.stack ?? 0) + (s?.bet ?? 0), 0) + (v.hand && !v.hand.winners ? v.hand.pots.reduce((n, p) => n + p.amount, 0) : 0) + (v.pendingAward?.amount ?? 0);

describe("persistence: table snapshots", () => {
  it("restores a hand mid-street with identical cards and carries on to showdown", () => {
    const r = rig(3, { actionTimeoutSec: 30 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    // Play to the flop: everyone calls/checks until the board has 3 cards.
    for (let i = 0; i < 20 && view(r).hand!.board.length < 3; i++) {
      const id = actor(r)!;
      const legal = r.table.viewFor(id).hand!.legal!;
      r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
    }
    expect(view(r).hand!.board).toHaveLength(3);
    r.clock.advance(12_000); // part of the clock has run down

    const snap = r.table.snapshot();
    const r2 = restore(snap, r.ids);
    const a = view(r);
    const b = view(r2);
    expect(b.hand!.board).toEqual(a.hand!.board);
    expect(b.hand!.deckHash).toBe(a.hand!.deckHash);
    expect(b.hand!.pots).toEqual(a.hand!.pots);
    expect(b.hand!.toActSeat).toBe(a.hand!.toActSeat);
    expect(b.log).toEqual(a.log);
    expect(b.ledger).toEqual(a.ledger);
    for (let i = 0; i < 3; i++) {
      expect(r2.table.viewFor(r.ids[i]!).seats[i]!.holeCards).toEqual(r.table.viewFor(r.ids[i]!).seats[i]!.holeCards);
      expect(r2.table.viewFor(r.ids[i]!).seats[i]!.connected).toBe(false);
    }
    // The action clock restarts in full for whoever is to act.
    expect(b.hand!.actionDeadline).toBe(r2.clock.now() + 30_000);
    expect(total(b)).toBe(300);

    // Both copies finish the hand and agree on everything, including the cards still in the deck.
    checkDown(r);
    checkDown(r2);
    const fa = view(r);
    const fb = view(r2);
    expect(fb.hand!.board).toEqual(fa.hand!.board);
    expect(fb.hand!.winners).toEqual(fa.hand!.winners);
    expect(fb.seats.map((s) => s?.stack)).toEqual(fa.seats.map((s) => s?.stack));
    expect(fb.lastHand!.reveal).toEqual(fa.lastHand!.reveal);
    expect(total(fb)).toBe(300);
    // The next hand is scheduled by the restored table.
    r2.clock.advance(10_000);
    expect(view(r2).hand!.handNumber).toBe(2);
  });

  it("times out the actor after a restore and keeps the sit-out bookkeeping", () => {
    const r = rig(2, { actionTimeoutSec: 10 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const act = actor(r)!;
    const r2 = restore(r.table.snapshot(), r.ids);
    r2.clock.advance(9_000);
    expect(actor(r2)).toBe(act);
    r2.clock.advance(1_001);
    expect(r2.table.viewFor(act).log.some((l) => l.includes("timed out"))).toBe(true);
  });

  it("restores a pending award and pays it out", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    checkDown(r);
    const pa = view(r).pendingAward!;
    const suggestedWinners = view(r).hand!.winners;
    expect(suggestedWinners!.reduce((n, w) => n + w.amount, 0)).toBe(pa.amount); // everyone sees the suggestion
    const r2 = restore(r.table.snapshot(), r.ids);
    expect(view(r2).pendingAward).toEqual(pa);
    expect(view(r2).hand!.winners).toEqual(suggestedWinners);
    r2.clock.advance(30_000);
    expect(view(r2).hand!.handNumber).toBe(1); // still waiting for the dealer
    const other2 = r2.ids.find((i) => i !== host)!;
    r2.table.hostAward(host, [{ playerId: other2, amount: pa.amount }]);
    expect(view(r2).hand!.winners).toEqual([{ playerId: other2, amount: pa.amount, potIndex: 0, half: "whole", handName: view(r2).hand!.winners![0]!.handName }]);
    expect(view(r2).pendingAward).toBeNull();
    expect(total(view(r2))).toBe(200);
    r2.clock.advance(1000);
    expect(view(r2).hand!.handNumber).toBe(2);
    expect(other).toBeDefined();
  });

  it("keeps reconnecting players on their seats via the same token", () => {
    const r = rig(2);
    seatAll(r);
    const r2 = restore(r.table.snapshot(), r.ids);
    expect(r2.table.join("token-1", "P1")).toBe(r.ids[1]);
    expect(view(r2, 1).you.seat).toBe(1);
    expect(view(r2, 1).you.isHost).toBe(false);
    expect(view(r2, 0).hostPlayerId).toBe(r.ids[0]);
  });
});

const TC: TournamentConfig = {
  startingStack: 1000,
  lateRegLevels: 1,
  levels: [
    { smallBlind: 10, bigBlind: 20, minutes: 1 },
    { smallBlind: 20, bigBlind: 40, minutes: 1 },
  ],
};

describe("persistence: tournament clock", () => {
  it("resumes a running clock with the remaining time", () => {
    const r = rig(2, { mode: "tournament", tournament: TC, actionTimeoutSec: 0 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(20_000);
    const r2 = restore(r.table.snapshot(), r.ids);
    const tv = view(r2).tournament!;
    expect(tv.levelRemainingMs).toBe(40_000);
    expect(tv.levelEndsAt).toBe(r2.clock.now() + 40_000);
    r2.clock.advance(40_001);
    expect(view(r2).tournament!.levelIndex).toBe(1);
  });

  it("keeps a paused clock paused", () => {
    const r = rig(2, { mode: "tournament", tournament: TC, actionTimeoutSec: 0 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(20_000);
    r.table.hostPause(r.ids[0]!, true);
    const r2 = restore(r.table.snapshot(), r.ids);
    expect(view(r2).tournament!.levelEndsAt).toBeNull();
    expect(view(r2).tournament!.levelRemainingMs).toBe(40_000);
    r2.clock.advance(120_000);
    expect(view(r2).tournament!.levelIndex).toBe(0);
    expect(view(r2).tournament!.levelRemainingMs).toBe(40_000);
  });
});

// ------------------------------------------------------------------ store

function memFs() {
  const files = new Map<string, string>();
  const ops: string[] = [];
  const fs: FsLike = {
    mkdir: async () => undefined,
    writeFile: async (p, d) => { ops.push(`write ${p}`); files.set(p, d); },
    rename: async (a, b) => {
      ops.push(`rename ${a} ${b}`);
      const d = files.get(a);
      if (d === undefined) throw new Error("ENOENT");
      files.delete(a);
      files.set(b, d);
    },
    readFile: async (p) => {
      const d = files.get(p);
      if (d === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return d;
    },
    readdir: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length + 1)),
    unlink: async (p) => { ops.push(`unlink ${p}`); files.delete(p); },
  };
  return { fs, files, ops };
}

describe("persistence: store", () => {
  it("debounces writes and replaces the file atomically", async () => {
    const clock = new FakeClock();
    const m = memFs();
    const store = new Store({ dir: "d", scheduler: clock, now: clock.now, fs: m.fs });
    const r = rig(1);
    let reads = 0;
    const get = () => { reads++; return r.table.snapshot(); };
    store.markDirty("test-table", get);
    clock.advance(200);
    store.markDirty("test-table", get);
    clock.advance(200);
    store.markDirty("test-table", get);
    await store.idle();
    expect(m.ops).toEqual([]);
    clock.advance(100);
    await store.idle();
    expect(reads).toBe(1);
    expect(m.ops).toEqual([`write ${join("d", "tables", "test-table.json.tmp")}`, `rename ${join("d", "tables", "test-table.json.tmp")} ${join("d", "tables", "test-table.json")}`]);
    expect([...m.files.keys()]).toEqual([join("d", "tables", "test-table.json")]);
    expect(JSON.parse(m.files.get(join("d", "tables", "test-table.json"))!).version).toBe(1);
  });

  it("flush writes pending changes immediately (shutdown)", async () => {
    const clock = new FakeClock();
    const m = memFs();
    const store = new Store({ dir: "d", scheduler: clock, now: clock.now, fs: m.fs });
    const r = rig(1);
    store.markDirty("test-table", () => r.table.snapshot());
    await store.flush();
    expect(m.files.has(join("d", "tables", "test-table.json"))).toBe(true);
    clock.advance(5000);
    await store.idle();
    expect(m.ops.filter((o) => o.startsWith("write"))).toHaveLength(1);
  });

  it("loads snapshots, sets aside unreadable files and deletes tables idle for 14 days", async () => {
    const clock = new FakeClock();
    const m = memFs();
    const store = new Store({ dir: "d", scheduler: clock, now: clock.now, fs: m.fs });
    const r = rig(1);
    const good = r.table.snapshot();
    const dir = join("d", "tables");
    m.files.set(join(dir, "test-table.json"), JSON.stringify({ ...good, savedAt: clock.now() - 1000 }));
    m.files.set(join(dir, "old-table.json"), JSON.stringify({ ...good, tableId: "old-table", savedAt: clock.now() - IDLE_DELETE_MS - 1 }));
    m.files.set(join(dir, "broken.json"), "{not json");
    m.files.set(join(dir, "future-one.json"), JSON.stringify({ ...good, tableId: "future-one", version: 99 }));
    const origWarn = console.warn;
    console.warn = () => undefined;
    try {
      const snaps = await store.loadAll();
      expect(snaps.map((s) => s.tableId)).toEqual(["test-table"]);
    } finally {
      console.warn = origWarn;
    }
    expect(m.files.has(join(dir, "old-table.json"))).toBe(false);
    expect(m.files.has(join(dir, "broken.json.bad"))).toBe(true);
    expect(m.files.has(join(dir, "future-one.json.bad"))).toBe(true);
  });
});

// ------------------------------------------------------------------ server

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView; errors: string[] };

function client(port: number, tableId: string, name: string, token: string, autoplay = false): Client {
  const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true }) as Client;
  s.errors = [];
  s.on("error", (e) => s.errors.push(e.message));
  s.on("state", (v) => {
    s.view = v;
    const legal = v.hand?.legal;
    if (autoplay && legal && v.hand!.winners === null) s.emit("action", legal.canCheck ? { type: "check" } : { type: "call" });
  });
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  return s;
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((res) => setTimeout(res, 20));
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "hg-test-"));
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});

describe("persistence: server", () => {
  it("applies house defaults to new tables and survives a restart", async () => {
    const dir = tmp();
    let server = await startServer(0, { dataDir: dir });
    open.push(server);
    const a = client(server.port, "defaults-one", "Ana", "tok-ana-123456");
    await until(() => !!a.view);
    expect(a.view!.config.awardMode).toBe("host");
    expect(a.view!.config.extensionSec).toBe(15);
    a.emit("host:config", { smallBlind: 5, bigBlind: 10, extensionSec: 20 });
    await until(() => a.view!.config.bigBlind === 10);
    a.emit("sit", { seat: 2, buyIn: 1000 });
    await until(() => a.view!.you.seat === 2);
    a.emit("host:saveDefaults");
    await until(() => a.view!.log.includes("Saved these settings as the house defaults"));
    await until(() => existsSync(join(dir, "house-defaults.json")));
    expect(JSON.parse(readFileSync(join(dir, "house-defaults.json"), "utf8"))).toMatchObject({ bigBlind: 10, extensionSec: 20, awardMode: "host" });
    const b = client(server.port, "defaults-two", "Bo", "tok-bo-1234567");
    await until(() => !!b.view);
    expect(b.view!.config).toMatchObject({ smallBlind: 5, bigBlind: 10, extensionSec: 20 });
    a.close();
    b.close();

    // Restart on the same data dir (close flushes pending writes).
    await server.close();
    open.length = 0;
    expect(readdirSync(join(dir, "tables")).sort()).toEqual(["defaults-one.json", "defaults-two.json"]);
    server = await startServer(0, { dataDir: dir });
    open.push(server);
    const a2 = client(server.port, "defaults-one", "Ana", "tok-ana-123456");
    await until(() => !!a2.view);
    expect(a2.view!.you.seat).toBe(2);
    expect(a2.view!.you.isHost).toBe(true);
    expect(a2.view!.config.bigBlind).toBe(10);
    expect(a2.view!.seats[2]!.stack).toBe(1000);
    const c = client(server.port, "defaults-three", "Cy", "tok-cy-1234567");
    await until(() => !!c.view);
    expect(c.view!.config.bigBlind).toBe(10);
    a2.close();
    c.close();
  }, 30_000);

  it("skips a corrupt snapshot on start", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "tables"));
    writeFileSync(join(dir, "tables", "bad-table.json"), "garbage");
    const origWarn = console.warn;
    console.warn = () => undefined;
    try {
      const server = await startServer(0, { dataDir: dir });
      open.push(server);
    } finally {
      console.warn = origWarn;
    }
    expect(existsSync(join(dir, "tables", "bad-table.json.bad"))).toBe(true);
  });

  it("lists finished hands and serves getHand / getLog; old rebuy events are rejected", async () => {
    const server = await startServer(0, { dataDir: tmp() });
    open.push(server);
    const a = client(server.port, "history-1", "Ana", "tok-a-hist-12", true);
    await until(() => !!a.view); // Ana joins first so she is the host (racing joins made this flaky)
    const b = client(server.port, "history-1", "Bo", "tok-b-hist-12", true);
    await until(() => !!a.view && !!b.view);
    a.emit("host:config", { awardMode: "auto" });
    a.emit("sit", { seat: 0, buyIn: 1000 });
    b.emit("sit", { seat: 1, buyIn: 1000 });
    await until(() => a.view!.seats.filter(Boolean).length === 2);
    a.emit("host:start");
    await until(() => a.view!.handList.length >= 1, 20_000);
    const item = a.view!.handList[0]!;
    expect(item.result).toMatch(/(Ana|Bo) \$\d+\.\d\d/);
    expect(item.pot).toBeGreaterThan(0);
    const rec = await new Promise<HandRecord | null>((res) => b.emit("getHand", { handNumber: item.handNumber }, res));
    expect(rec).not.toBeNull();
    expect(rec!.handNumber).toBe(item.handNumber);
    expect(rec!.names).toMatchObject({ [a.view!.you.playerId]: "Ana" });
    expect(rec!.endedAt).toBe(item.endedAt);
    expect(rec!.reveal.deck.length).toBeGreaterThan(40);
    expect(await new Promise<HandRecord | null>((res) => a.emit("getHand", { handNumber: 999 }, res))).toBeNull();
    const lines = await new Promise<string[]>((res) => a.emit("getLog", res));
    expect(lines).toEqual(expect.arrayContaining(a.view!.log.slice(0, 5)));
    expect(lines.some((l) => l.startsWith("Hand #1"))).toBe(true);
    (a as unknown as Socket).emit("rebuy", { amount: 100 });
    await until(() => a.errors.length > 0);
    expect(a.errors[0]).toBe("Ask the dealer for more chips");
    a.close();
    b.close();
  }, 30_000);
});

// ------------------------------------------------------------------ rules

describe("time extension", () => {
  it("lets only the player to act add time, once per turn", () => {
    const r = rig(2, { actionTimeoutSec: 30, extensionSec: 15 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const act = actor(r)!;
    const other = r.ids.find((i) => i !== act)!;
    const deadline = r.table.viewFor(act).hand!.actionDeadline!;
    expect(r.table.viewFor(act).canExtend).toBe(true);
    expect(r.table.viewFor(other).canExtend).toBe(false);
    expect(() => r.table.extendTime(other)).toThrow(UserError);
    r.table.extendTime(act);
    expect(r.table.viewFor(act).hand!.actionDeadline).toBe(deadline + 15_000);
    expect(r.table.viewFor(act).canExtend).toBe(false);
    expect(r.table.viewFor(act).log).toContain(`${act === r.ids[0] ? "P0" : "P1"} asks for 15 more seconds`);
    expect(() => r.table.extendTime(act)).toThrow(/already/);
    r.clock.advance(44_000);
    expect(actor(r)).toBe(act);
    r.clock.advance(2_000);
    expect(actor(r)).not.toBe(act);
  });

  it("gives the next player a fresh extension", () => {
    const r = rig(3, { actionTimeoutSec: 30, extensionSec: 15 });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    const first = actor(r)!;
    r.table.extendTime(first);
    r.table.action(first, { type: "call" });
    const next = actor(r)!;
    expect(next).not.toBe(first);
    expect(r.table.viewFor(next).canExtend).toBe(true);
    r.table.extendTime(next);
    expect(r.table.viewFor(next).canExtend).toBe(false);
  });

  it("is off without a timer or with extensionSec 0, and validates settings", () => {
    const none = rig(2, { actionTimeoutSec: 0, extensionSec: 15 });
    seatAll(none);
    none.table.hostStart(none.ids[0]!);
    none.clock.advance(1000);
    expect(none.table.viewFor(actor(none)!).canExtend).toBe(false);
    expect(() => none.table.extendTime(actor(none)!)).toThrow(UserError);
    // A per-player limit makes extending possible even with no table timer.
    none.table.hostPlayerTimer(none.ids[0]!, actor(none)!, 20);
    expect(none.table.viewFor(actor(none)!).canExtend).toBe(true);

    const off = rig(2, { actionTimeoutSec: 30, extensionSec: 0 });
    seatAll(off);
    off.table.hostStart(off.ids[0]!);
    off.clock.advance(1000);
    expect(off.table.viewFor(actor(off)!).canExtend).toBe(false);

    const host = off.ids[0]!;
    expect(() => off.table.hostConfig(host, { extensionSec: 121 })).toThrow(UserError);
    expect(() => off.table.hostConfig(host, { extensionSec: -1 })).toThrow(UserError);
    expect(() => off.table.hostConfig(host, { actionTimeoutSec: 4 })).toThrow(UserError);
    expect(() => off.table.hostConfig(host, { actionTimeoutSec: 301 })).toThrow(UserError);
    off.table.hostConfig(host, { extensionSec: 120, actionTimeoutSec: 300 });
    off.table.hostConfig(host, { extensionSec: 0, actionTimeoutSec: 5 });
    expect(LEGACY.awardMode).toBe("auto");
  });
});

describe("dealer-only rebuys", () => {
  it("sits a busted player back in on a top-up, but not one who chose to sit out", () => {
    const r = rig(3);
    seatAll(r);
    const [host, a, b] = r.ids as [string, string, string];
    r.table.hostAdjustStack(host, a, -100); // cashed all the way out: busted
    expect(view(r).seats[1]!.sittingOut).toBe(true);
    expect(() => r.table.sitOut(a, false)).toThrow(/dealer/);
    r.table.hostAdjustStack(host, a, 80);
    expect(view(r).seats[1]).toMatchObject({ sittingOut: false, stack: 80 });
    const led = view(r).ledger.find((l) => l.playerId === a)!;
    expect(led).toMatchObject({ buyIns: 180, cashOuts: 100, stack: 80 });

    r.table.sitOut(b, true);
    r.table.hostAdjustStack(host, b, -100);
    r.table.hostAdjustStack(host, b, 50);
    expect(view(r).seats[2]).toMatchObject({ sittingOut: true, stack: 50 });
  });

  it("applies a queued top-up after the hand and re-seats a bust", () => {
    const r = rig(2);
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostAdjustStack(host, other, -100); // queued during the hand
    r.table.hostAdjustStack(host, other, 60); // queued too
    checkDown(r);
    expect(view(r).seats[1]!.stack).toBe(60);
    expect(view(r).seats[1]!.sittingOut).toBe(false);
  });
});
