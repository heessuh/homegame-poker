import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import {
  canonicalJson, freshDeck, ledgerGenesisInput, ledgerHashInput, verifyLedger,
  type ClientToServerEvents, type DealerEntry, type ServerToClientEvents, type TableView, type TournamentConfig,
} from "@homegame/engine";
import { startServer } from "../src/index.js";
import { Table, type TableSnapshot } from "../src/table.js";
import { FakeClock, rig, seatAll, type Rig } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ledger = (r: Rig) => r.table.getDealerLog();
const last = (r: Rig) => ledger(r).at(-1)!;
const verify = (r: Rig) => verifyLedger(ledger(r), "test-table", sha);

function foldAround(r: Rig): void {
  for (let i = 0; i < 50; i++) {
    const v = r.table.viewFor(r.ids[0]!);
    if (!v.hand || v.hand.winners || v.hand.toActSeat === null || v.pendingAward) return;
    const id = v.seats[v.hand.toActSeat]!.playerId;
    r.table.action(id, { type: "fold" });
  }
}

const TC: TournamentConfig = {
  startingStack: 1000,
  lateRegLevels: 1,
  levels: [
    { smallBlind: 10, bigBlind: 20, minutes: 1 },
    { smallBlind: 20, bigBlind: 40, minutes: 1 },
  ],
};

describe("dealer ledger: format and canonicalization", () => {
  it("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x\n" }], u: undefined })).toBe('{"a":[2,{"c":"x\\n","d":null}],"b":1}');
  });

  it("starts with the host entry on the documented genesis hash, and every hash is reproducible", async () => {
    const r = rig(2);
    const [first] = ledger(r);
    expect(first).toMatchObject({ seq: 1, action: "host", hostName: "P0" });
    expect(first!.prevHash).toBe(sha("mochapoker-ledger-v1|test-table"));
    expect(first!.prevHash).toBe(sha(ledgerGenesisInput("test-table")));
    const { hash, ...rest } = first!;
    expect(hash).toBe(sha(ledgerHashInput(rest)));
    // Independent recomputation of the documented canonical form.
    const manual = `{"action":"host","at":${first!.at},"details":${canonicalJson(first!.details)},"hostId":"${first!.hostId}","hostName":"P0","prevHash":"${first!.prevHash}","seq":1,"summary":${JSON.stringify(first!.summary)}}`;
    expect(hash).toBe(sha(manual));
    expect(await verify(r)).toEqual({ ok: true, count: 1 });
  });
});

describe("dealer ledger: entries per action", () => {
  it("records start, settings, variant, sitOut, rebuy, takeChips, transfer, pause, resume, remove with names and money", async () => {
    const r = rig(3, { money: "cents", smallBlind: 10, bigBlind: 20, minBuyIn: 1000, maxBuyIn: 10_000, actionTimeoutSec: 0 });
    const [h, b, c] = r.ids as [string, string, string];
    seatAll(r, undefined, 2000);
    const n0 = ledger(r).length;

    r.table.hostConfig(h, { bigBlind: 40 });
    let e = last(r);
    expect(e.action).toBe("settings");
    expect(e.hostId).toBe(h);
    expect(e.summary).toBe("P0 changed big blind from $0.20 to $0.40");
    expect(e.details).toMatchObject({ changes: [{ path: "bigBlind", from: 20, to: 40 }], appliesNextHand: false });

    r.table.hostConfig(h, { variant: "plo4" });
    e = last(r);
    expect(e.action).toBe("variant");
    expect(e.details).toMatchObject({ changes: expect.arrayContaining([{ path: "variant", from: "nlhe", to: "plo4" }]) });

    r.table.hostSitOut(h, b, true);
    expect(last(r)).toMatchObject({ action: "sitOut", summary: "P0 marked P1 as sitting out" });
    r.table.hostSitOut(h, b, false);

    r.table.hostAdjustStack(h, c, 500);
    expect(last(r)).toMatchObject({ action: "rebuy", summary: "P0 gave $5.00 to P2’s stack ($20.00 to $25.00)" });
    expect(last(r).details).toMatchObject({ delta: 500, stackBefore: 2000, stackAfter: 2500 });
    r.table.hostAdjustStack(h, c, -300);
    expect(last(r)).toMatchObject({ action: "takeChips" });

    r.table.hostTransfer(h, c, b, 700);
    expect(last(r)).toMatchObject({ action: "transfer" });
    expect(last(r).summary).toContain("moved $7.00 from P2");
    expect(last(r).details).toMatchObject({ amount: 700, queued: false });

    r.table.hostStart(h);
    expect(last(r)).toMatchObject({ action: "start", summary: "P0 started the game" });
    r.table.hostPause(h, true);
    expect(last(r).action).toBe("pause");
    r.table.hostPause(h, false);
    expect(last(r).action).toBe("resume");

    r.table.hostKick(h, c);
    expect(last(r)).toMatchObject({ action: "remove" });
    expect(last(r).summary).toContain("P0 removed P2 from the table");

    expect(ledger(r).length).toBeGreaterThan(n0 + 9);
    expect(await verify(r)).toMatchObject({ ok: true });
    ledger(r).forEach((x, i) => expect(x.seq).toBe(i + 1));
  });

  it("records a settings change that waits for the next hand, and the award with the suggestion", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostConfig(host, { bigBlind: 4 });
    expect(last(r).details).toMatchObject({ appliesNextHand: true });
    expect(last(r).summary).toMatch(/takes effect next hand/);
    foldAround(r);
    const pa = r.table.viewFor(host).pendingAward!;
    r.table.hostAward(host, [{ playerId: other, amount: pa.amount }]);
    const e = last(r);
    expect(e.action).toBe("award");
    expect(e.details).toMatchObject({ handNumber: 1, pot: pa.amount, awards: [{ playerId: other, name: "P1", amount: pa.amount }], matchedSuggestion: true });
    expect(e.summary).toContain("awarded hand #1");
  });

  it("queues a transfer during a hand, then records the application (or skip) after it", () => {
    const r = rig(2, { awardMode: "auto" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    r.table.hostTransfer(host, other, host, 30);
    expect(last(r)).toMatchObject({ action: "transfer" });
    expect(last(r).details).toMatchObject({ queued: true });
    foldAround(r);
    const actions = ledger(r).map((x) => x.action);
    expect(actions.some((a) => a === "transferApplied" || a === "transferSkipped")).toBe(true);
  });

  it("records timers and tournament controls", () => {
    const r = rig(3, { mode: "tournament", tournament: TC, actionTimeoutSec: 30 });
    seatAll(r, undefined, 50);
    const [h, b] = r.ids as [string, string];
    r.table.hostStart(h);
    expect(last(r)).toMatchObject({ action: "start" });
    expect(last(r).summary).toContain("started the tournament with 3 players");
    r.table.hostPlayerTimer(h, b, 60);
    expect(last(r)).toMatchObject({ action: "playerTimer", details: { before: null, after: 60 } });
    r.table.hostTournamentLevel(h, 1);
    expect(last(r)).toMatchObject({ action: "tournamentLevel", details: { fromLevel: 1, toLevel: 2 } });
    r.table.hostTournamentClock(h, 30_000);
    expect(last(r)).toMatchObject({ action: "tournamentClock", details: { addMs: 30_000 } });
    r.clock.advance(1000);
    const v = r.table.viewFor(h);
    const actor = v.seats[v.hand!.toActSeat!]!.playerId;
    r.table.hostAddTime(h, actor, 20);
    expect(last(r)).toMatchObject({ action: "addTime", details: { seconds: 20 } });
    r.table.hostForceTimeout(h, actor);
    expect(last(r)).toMatchObject({ action: "forceTimeout" });
  });

  it("records mode switches and saved defaults", () => {
    const r = rig(2, { mode: "tournament", tournament: TC });
    const h = r.ids[0]!;
    r.table.hostConfig(h, { mode: "cash" });
    expect(last(r).action).toBe("mode");
    r.table.hostSaveDefaults(h);
    expect(last(r).action).toBe("saveDefaults");
  });

  it("records a host handoff and the new host's later actions", () => {
    const r = rig(2);
    const [h, b] = r.ids as [string, string];
    r.table.disconnect(h);
    r.clock.advance(61_000);
    expect(last(r)).toMatchObject({ action: "handoff", hostId: b, details: { fromId: h, toId: b } });
    r.table.hostConfig(b, { bigBlind: 10 });
    expect(last(r)).toMatchObject({ hostId: b, hostName: "P1" });
  });

  it("does not record rejected actions", () => {
    const r = rig(3, { awardMode: "host" });
    seatAll(r);
    const [h, b] = r.ids as [string, string];
    const n = ledger(r).length;
    expect(() => r.table.hostConfig(b, { bigBlind: 10 })).toThrow(/host/);
    expect(() => r.table.hostConfig(h, { bigBlind: 0 })).toThrow();
    expect(() => r.table.hostConfig(h, { nope: 1 } as never)).toThrow();
    expect(() => r.table.hostAward(h, [])).toThrow();
    expect(() => r.table.hostTransfer(h, h, h, 5)).toThrow();
    expect(() => r.table.hostAdjustStack(h, b, 0)).toThrow();
    expect(() => r.table.hostAdjustStack(h, b, -9999)).not.toThrow(); // clamps, so this one is a real action
    expect(() => r.table.hostKick(h, h)).toThrow();
    expect(() => r.table.hostPause(h, false)).toThrow();
    expect(() => r.table.hostStart(b)).toThrow();
    expect(ledger(r).length).toBe(n + 1);
  });
});

describe("dealer ledger: tamper evidence and persistence", () => {
  function busy(): Rig {
    const r = rig(3);
    seatAll(r);
    const [h, b] = r.ids as [string, string];
    r.table.hostConfig(h, { bigBlind: 4 });
    r.table.hostAdjustStack(h, b, 50);
    r.table.hostSitOut(h, b, true);
    return r;
  }

  it("detects an edited entry, a removed entry, a reordered chain and a forged tail", async () => {
    const r = busy();
    const good = ledger(r);
    expect(good.length).toBeGreaterThanOrEqual(4);
    const clone = () => JSON.parse(JSON.stringify(good)) as DealerEntry[];

    let t = clone();
    t[2]!.summary = "P0 gave $0.01 to P1";
    expect(await verifyLedger(t, "test-table", sha)).toMatchObject({ ok: false, brokenAt: 3 });

    t = clone();
    t.splice(2, 1);
    expect(await verifyLedger(t, "test-table", sha)).toMatchObject({ ok: false });

    t = clone();
    [t[1], t[2]] = [t[2]!, t[1]!];
    expect(await verifyLedger(t, "test-table", sha)).toMatchObject({ ok: false });

    t = clone();
    t[1]!.details = { forged: true };
    expect(await verifyLedger(t, "test-table", sha)).toMatchObject({ ok: false, brokenAt: 2 });

    // Re-hashing one edited entry still breaks the link to the next one.
    t = clone();
    t[1]!.summary = "edited";
    const { hash: _h, ...body } = t[1]!;
    t[1]!.hash = sha(ledgerHashInput(body));
    expect(await verifyLedger(t, "test-table", sha)).toMatchObject({ ok: false, brokenAt: 3 });

    // The same entries under a different table id fail at the very first link.
    expect(await verifyLedger(good, "other-table", sha)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("is saved in the snapshot, survives a restart, keeps chaining, and old entries are untouched", async () => {
    const r = busy();
    const before = ledger(r);
    const snap = JSON.parse(JSON.stringify(r.table.snapshot())) as TableSnapshot;
    expect(snap.dealerLog).toEqual(before);

    const clock = new FakeClock();
    clock.t = 9_000_000;
    const t2 = new Table({ tableId: snap.tableId, now: clock.now, scheduler: clock, deckSource: () => freshDeck(), onChange: () => undefined, snapshot: snap });
    t2.resume();
    expect(t2.getDealerLog()).toEqual(before);
    const view = t2.viewFor(r.ids[0]!);
    expect(view.dealerLog).toMatchObject({ count: before.length, headHash: before.at(-1)!.hash });

    t2.hostConfig(r.ids[0]!, { bigBlind: 6 });
    const after = t2.getDealerLog();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)!.prevHash).toBe(before.at(-1)!.hash);
    expect(await verifyLedger(after, "test-table", sha)).toMatchObject({ ok: true });
  });

  it("serves only the tail in views but keeps every entry", () => {
    const r = rig(2);
    const h = r.ids[0]!;
    for (let i = 0; i < 130; i++) r.table.hostConfig(h, { bigBlind: 2 + (i % 2) * 2 });
    const v = r.table.viewFor(r.ids[1]!);
    expect(v.dealerLog.count).toBe(ledger(r).length);
    expect(v.dealerLog.tail.length).toBeLessThan(v.dealerLog.count);
    expect(v.dealerLog.tail.at(-1)).toEqual(last(r));
  });
});

describe("dealer ledger: every host path is logged", () => {
  it("source guard: the host check lives only inside asHost, and every host* method goes through it", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/table.ts"), "utf8");
    expect(src).not.toMatch(/requireHost/);
    expect(src.match(/Only the host can do that/g)).toHaveLength(1);
    const methods = [...src.matchAll(/^ {2}(host[A-Z]\w*)\(/gm)].map((m) => m[1]!);
    expect(methods.length).toBeGreaterThanOrEqual(13);
    for (const name of methods) {
      const start = src.indexOf(`\n  ${name}(`);
      const end = src.indexOf("\n  }\n", start);
      expect(src.slice(start, end), `${name} must call this.asHost`).toMatch(/this\.asHost\(/);
    }
  });

  // Scenario for each host* method: how to prepare a table and what to call. A new host method with no entry here fails.
  const hand = (cfg: object = {}): Rig => {
    const r = rig(3, { actionTimeoutSec: 30, awardMode: "host", ...cfg });
    seatAll(r);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    return r;
  };
  const tour = (): Rig => {
    const r = rig(3, { mode: "tournament", tournament: TC, actionTimeoutSec: 30 });
    seatAll(r, undefined, 50);
    r.table.hostStart(r.ids[0]!);
    r.clock.advance(1000);
    return r;
  };
  const actorOf = (r: Rig): string => {
    const v = r.table.viewFor(r.ids[0]!);
    return v.seats[v.hand!.toActSeat!]!.playerId;
  };
  const scenarios: Record<string, () => { r: Rig; run: (h: string) => void }> = {
    hostStart: () => { const r = rig(2); seatAll(r); return { r, run: (h) => r.table.hostStart(h) }; },
    hostPause: () => { const r = hand(); return { r, run: (h) => r.table.hostPause(h, true) }; },
    hostConfig: () => { const r = hand(); return { r, run: (h) => r.table.hostConfig(h, { bigBlind: 8 }) }; },
    hostSaveDefaults: () => { const r = hand(); return { r, run: (h) => void r.table.hostSaveDefaults(h) }; },
    hostSitOut: () => { const r = hand(); return { r, run: (h) => r.table.hostSitOut(h, r.ids[2]!, true) }; },
    hostKick: () => { const r = hand(); return { r, run: (h) => r.table.hostKick(h, r.ids[2]!) }; },
    hostAdjustStack: () => { const r = hand(); return { r, run: (h) => r.table.hostAdjustStack(h, r.ids[2]!, 10) }; },
    hostAward: () => {
      const r = hand();
      foldAround(r);
      const pa = r.table.viewFor(r.ids[0]!).pendingAward!;
      return { r, run: (h) => r.table.hostAward(h, [{ playerId: r.ids[1]!, amount: pa.amount }]) };
    },
    hostTransfer: () => { const r = hand(); return { r, run: (h) => r.table.hostTransfer(h, r.ids[1]!, r.ids[2]!, 5) }; },
    hostPlayerTimer: () => { const r = hand(); return { r, run: (h) => r.table.hostPlayerTimer(h, r.ids[1]!, 45) }; },
    hostAddTime: () => { const r = hand(); return { r, run: (h) => r.table.hostAddTime(h, actorOf(r), 15) }; },
    hostForceTimeout: () => { const r = hand(); return { r, run: (h) => r.table.hostForceTimeout(h, actorOf(r)) }; },
    hostTournamentLevel: () => { const r = tour(); return { r, run: (h) => r.table.hostTournamentLevel(h, 1) }; },
    hostTournamentClock: () => { const r = tour(); return { r, run: (h) => r.table.hostTournamentClock(h, 5000) }; },
    hostShuffleSeats: () => { const r = rig(2); seatAll(r); return { r, run: (h) => r.table.hostShuffleSeats(h) }; },
  };

  it("every host* method on Table appends to the ledger when it succeeds, and nothing when refused", () => {
    const names = Object.getOwnPropertyNames(Table.prototype).filter((n) => /^host[A-Z]/.test(n));
    expect(names.sort()).toEqual(Object.keys(scenarios).sort());
    for (const name of names) {
      const { r, run } = scenarios[name]!();
      const n = ledger(r).length;
      const stranger = r.ids[1]!;
      expect(() => run(stranger), `${name} as non-host`).toThrow();
      expect(ledger(r).length, `${name} refused`).toBe(n);
      run(r.ids[0]!);
      expect(ledger(r).length, `${name} succeeded`).toBeGreaterThan(n);
      expect(ledger(r)[n]!.hostId).toBe(r.ids[0]);
    }
  });
});

describe("dealer ledger over the socket", () => {
  type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView };
  const client = (port: number, tableId: string, name: string, token: string): Client => {
    const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true }) as Client;
    s.on("state", (v) => { s.view = v; });
    s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
    return s;
  };
  const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("every player sees the ledger, and the full copy verifies", async () => {
    const server = await startServer(0, { dataDir: mkdtempSync(join(tmpdir(), "hg-led-")) });
    try {
      const a = client(server.port, "ledger-1", "Ana", "tok-a-ledger1");
      await until(() => !!a.view); // the host joins and gets a view before the second client connects
      const b = client(server.port, "ledger-1", "Bo", "tok-b-ledger1");
      await until(() => !!b.view);
      a.emit("host:config", { bigBlind: 40 });
      await until(() => b.view!.dealerLog.count >= 2);
      const full = await new Promise<DealerEntry[]>((res) => b.emit("getDealerLog", res));
      expect(full.length).toBe(b.view!.dealerLog.count);
      expect(full.at(-1)!.hash).toBe(b.view!.dealerLog.headHash);
      expect(full.at(-1)).toMatchObject({ action: "settings", hostName: "Ana" });
      expect(await verifyLedger(full, "ledger-1", sha)).toMatchObject({ ok: true });
      a.close();
      b.close();
    } finally {
      await server.close();
    }
  });
});
