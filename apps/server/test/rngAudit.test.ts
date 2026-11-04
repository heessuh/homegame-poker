import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { shuffle, type ClientToServerEvents, type HandRecord, type RngAuditReport, type ServerToClientEvents, type TableView } from "@homegame/engine";
import { startServer } from "../src/index.js";
import { RngAudit } from "../src/rngAudit.js";
import type { FsLike } from "../src/persist.js";
import { FakeClock } from "./helpers.js";

function fakeRec(handNumber: number, endedAt = 1_000 + handNumber): HandRecord {
  const deck = shuffle();
  return {
    handNumber, variant: "holdem", deckHash: "h", reveal: { deck, salt: "s" }, board: deck.slice(21, 26),
    winners: [], summary: [], shown: {}, names: {}, endedAt,
  } as HandRecord;
}

function memFs() {
  const files = new Map<string, string>();
  const ops: string[] = [];
  const fs: FsLike = {
    mkdir: async () => undefined,
    writeFile: async (p, d) => { ops.push(`write ${p}`); files.set(p, d); },
    rename: async (a, b) => {
      ops.push(`rename ${a} ${b}`);
      const v = files.get(a);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      files.set(b, v);
      files.delete(a);
    },
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    readdir: async () => [],
    unlink: async (p) => { files.delete(p); },
  };
  return { files, ops, fs };
}

const FILE = join("d", "rng-audit.json");

describe("RngAudit accumulation", () => {
  it("counts each hand once (dedupe by table + hand number) and reports the site total", () => {
    const clock = new FakeClock();
    const a = new RngAudit({ dir: null, scheduler: clock, now: clock.now });
    const r1 = fakeRec(1);
    expect(a.record("t-one", r1)).toBe(true);
    expect(a.record("t-one", r1)).toBe(false);
    expect(a.record("t-one", { ...r1, summary: ["edited by an award"] })).toBe(false);
    expect(a.record("t-two", fakeRec(1))).toBe(true);
    expect(a.hands).toBe(2);
    const rep = a.siteReport();
    expect(rep.scope).toBe("site");
    expect(rep.hands).toBe(2);
    expect(rep.lenses.map((l) => l.id)).toEqual(["pocket-shape", "premium-starts", "seven-card", "flop-pairing", "flop-suits", "deck-positions"]);
    expect(rep.lenses.find((l) => l.id === "pocket-shape")!.samples).toBe(20);
  });

  it("ignores hands without a full revealed deck", () => {
    const clock = new FakeClock();
    const a = new RngAudit({ dir: null, scheduler: clock, now: clock.now });
    const bad = fakeRec(1);
    bad.reveal.deck = bad.reveal.deck.slice(0, 30);
    expect(a.record("t", bad)).toBe(false);
    expect(a.hands).toBe(0);
  });

  it("backfills from restored history without double counting", () => {
    const clock = new FakeClock();
    const a = new RngAudit({ dir: null, scheduler: clock, now: clock.now });
    const hist = [fakeRec(1), fakeRec(2), fakeRec(3)];
    a.record("t", hist[1]!); // already seen live
    expect(a.backfill("t", hist)).toBe(2);
    expect(a.backfill("t", hist)).toBe(0);
    expect(a.hands).toBe(3);
  });

  it("builds a per-table report from that table's history only", () => {
    const clock = new FakeClock();
    clock.t = 9_000_000;
    const a = new RngAudit({ dir: null, scheduler: clock, now: clock.now });
    a.record("other", fakeRec(1));
    const rep = a.tableReport([fakeRec(1), fakeRec(2)]);
    expect(rep.scope).toBe("table");
    expect(rep.hands).toBe(2);
    expect(rep.since).toBe(new Date(1_001).toISOString());
    expect(a.tableReport([]).hands).toBe(0);
  });
});

describe("RngAudit persistence", () => {
  it("writes atomically, debounced, and reloads the totals and the dedupe list", async () => {
    const clock = new FakeClock();
    const m = memFs();
    const a = new RngAudit({ dir: "d", scheduler: clock, now: clock.now, fs: m.fs });
    await a.load();
    a.record("t", fakeRec(1));
    a.record("t", fakeRec(2));
    clock.advance(500);
    expect(m.ops).toEqual([]); // still inside the debounce window
    clock.advance(5_000);
    await a.flush();
    expect(m.ops).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`]);
    expect(JSON.parse(m.files.get(FILE)!)).toMatchObject({ version: 1, counts: { hands: 2 } });

    const b = new RngAudit({ dir: "d", scheduler: clock, now: () => clock.t + 10_000_000, fs: m.fs });
    await b.load();
    expect(b.hands).toBe(2);
    expect(b.siteReport().since).toBe(a.siteReport().since);
    expect(b.record("t", fakeRec(2))).toBe(false); // deduped across restarts
    expect(b.record("t", fakeRec(3))).toBe(true);
    expect(b.hands).toBe(3);
  });

  it("flush writes pending changes at once and unreadable files are set aside", async () => {
    const clock = new FakeClock();
    const m = memFs();
    m.files.set(FILE, "not json");
    const warn = console.warn;
    console.warn = () => undefined;
    const a = new RngAudit({ dir: "d", scheduler: clock, now: clock.now, fs: m.fs });
    try { await a.load(); } finally { console.warn = warn; }
    expect(a.hands).toBe(0);
    expect(m.files.has(`${FILE}.bad`)).toBe(true);
    a.record("t", fakeRec(1));
    await a.flush();
    expect(JSON.parse(m.files.get(FILE)!).counts.hands).toBe(1);
  });
});

// ------------------------------------------------------------------ over sockets

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView };
function client(port: number, tableId: string, name: string, token: string): Client {
  const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true }) as Client;
  s.on("state", (v) => {
    s.view = v;
    const legal = v.hand?.legal;
    if (legal && v.hand!.winners === null) s.emit("action", legal.canCheck ? { type: "check" } : { type: "call" });
  });
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  return s;
}
async function until(cond: () => boolean, ms = 25_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((res) => setTimeout(res, 20));
  }
}
const audit = (c: Client, scope: "site" | "table") => new Promise<RngAuditReport>((res) => c.emit("getRngAudit", { scope }, res));

const dirs: string[] = [];
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("getRngAudit over sockets", () => {
  it("serves site and table reports, persists them, and does not double count after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-audit-"));
    dirs.push(dir);
    let server = await startServer(0, { dataDir: dir });
    open.push(server);
    const a = client(server.port, "audit-one", "Ana", "tok-ana-audit-1");
    const b = client(server.port, "audit-one", "Bo", "tok-bo-audit-12");
    await until(() => !!a.view && !!b.view);
    a.emit("host:config", { awardMode: "auto" });
    a.emit("sit", { seat: 0, buyIn: 1000 });
    b.emit("sit", { seat: 1, buyIn: 1000 });
    await until(() => a.view!.seats.filter(Boolean).length === 2);
    a.emit("host:start");
    // Don't wait for the 30 s action timer: whoever is to act folds, so the hand finishes at once.
    await until(() => !!(a.view?.hand?.legal || b.view?.hand?.legal));
    (a.view?.hand?.legal ? a : b).emit("action", { type: "fold" });
    await until(() => a.view!.handList.length >= 1);

    const site = await audit(a, "site");
    const table = await audit(b, "table");
    expect(site.scope).toBe("site");
    expect(site.hands).toBeGreaterThanOrEqual(1);
    expect(table.scope).toBe("table");
    expect(table.hands).toBeGreaterThanOrEqual(1);
    expect(site.lenses).toHaveLength(6);
    expect(site.lenses.every((l) => l.verdict === "too-few-hands")).toBe(true);
    // A bad scope is rejected without an ack.
    const outcome = await new Promise((res) => {
      (a as unknown as Socket).emit("getRngAudit", { scope: "nope" }, () => res("acked"));
      setTimeout(() => res("no ack"), 300);
    });
    expect(outcome).toBe("no ack");

    a.close();
    b.close();
    await server.close();
    open.length = 0;
    const file = join(dir, "rng-audit.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8")) as { counts: { hands: number } };
    expect(saved.counts.hands).toBeGreaterThanOrEqual(site.hands);

    // Restart: the table is restored, backfill sees the same hands, nothing is counted twice.
    server = await startServer(0, { dataDir: dir });
    open.push(server);
    const c = client(server.port, "audit-one", "Ana", "tok-ana-audit-1");
    await until(() => !!c.view);
    const after = await audit(c, "site");
    const tableAfter = await audit(c, "table");
    expect(after.hands).toBe(saved.counts.hands);
    expect(after.since).toBe(site.since);
    expect(tableAfter.hands).toBeLessThanOrEqual(after.hands);
    c.close();
    await server.close();
    open.length = 0;

    // Lose the audit file: startup backfill rebuilds it from the restored table's history.
    rmSync(file);
    server = await startServer(0, { dataDir: dir });
    open.push(server);
    const d = client(server.port, "audit-one", "Ana", "tok-ana-audit-1");
    await until(() => !!d.view);
    const rebuilt = await audit(d, "site");
    const rebuiltTable = await audit(d, "table");
    expect(rebuilt.hands).toBe(rebuiltTable.hands);
    expect(rebuilt.hands).toBeGreaterThanOrEqual(1);
    d.close();
  }, 60_000);
});
