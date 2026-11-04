import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents, TableView } from "@homegame/engine";
import { startServer } from "../src/index.js";
import {
  budgetNotice, estimateUsd, GB, loadUsageConfig, monthKey, statusFor, UsageMeter, type UsageConfig, type UsageFile,
} from "../src/usage.js";
import { FakeClock } from "./helpers.js";

const DEFAULTS = loadUsageConfig({});
const cfg = (over: Partial<UsageConfig> = {}): UsageConfig => ({ ...DEFAULTS, ...over });
const tmp = (): string => mkdtempSync(join(tmpdir(), "hg-usage-"));
const read = (dir: string): UsageFile => JSON.parse(readFileSync(join(dir, "usage.json"), "utf8")) as UsageFile;

class FakeSocket extends EventEmitter {
  bytesWritten = 0;
}

function meterAt(t: number, over: Partial<UsageConfig> = {}, dir: string | null = tmp()): { clock: FakeClock; meter: UsageMeter; dir: string | null } {
  const clock = new FakeClock();
  clock.t = t;
  const meter = new UsageMeter({ dir, now: clock.now, scheduler: clock, config: cfg(over) });
  return { clock, meter, dir };
}

describe("usage config and cost formula", () => {
  it("has the documented defaults and honors env overrides", () => {
    expect(DEFAULTS).toMatchObject({
      cpuUsdPerHour: 0.0035, egressUsdPerGb: 0.04, volumeGb: 1, volumeUsdPerGbMonth: 0.15, fixedUsdPerMonth: 0.1, limitUsd: 5, warnRatio: 0.8,
    });
    expect(loadUsageConfig({ BUDGET_LIMIT_USD: "7.5", CPU_RATE_USD_PER_HOUR: "x" })).toMatchObject({ limitUsd: 7.5, cpuUsdPerHour: 0.0035 });
  });

  it("estimates runtime + egress + prorated volume and fixed charges", () => {
    const start = Date.UTC(2026, 10, 1);
    const half = start + 15 * 86_400_000; // Nov has 30 days
    const usd = estimateUsd(DEFAULTS, "2026-11", { runtimeSeconds: 10 * 3600, egressBytes: 2 * GB }, half);
    expect(usd).toBeCloseTo(10 * 0.0035 + 2 * 0.04 + 0.15 * 0.5 + 0.1 * 0.5, 10);
    // A finished month is charged in full, a future month not at all.
    expect(estimateUsd(DEFAULTS, "2026-11", { runtimeSeconds: 0, egressBytes: 0 }, Date.UTC(2027, 0, 1))).toBeCloseTo(0.25, 10);
    expect(estimateUsd(DEFAULTS, "2026-11", { runtimeSeconds: 0, egressBytes: 0 }, start - 1000)).toBe(0);
  });

  it("maps cost to ok / warn / limit", () => {
    const c = cfg();
    expect(statusFor(c, 3.99)).toBe("ok");
    expect(statusFor(c, 4)).toBe("warn");
    expect(statusFor(c, 4.99)).toBe("warn");
    expect(statusFor(c, 5)).toBe("limit");
  });

  it("formats the notice with the limit and the first of next month", () => {
    expect(budgetNotice(cfg(), Date.UTC(2026, 10, 12))).toBe("Mocha Poker has reached its $5 budget for this month. Games resume on December 1. — Fred");
    expect(budgetNotice(cfg({ limitUsd: 7.5 }), Date.UTC(2026, 11, 31))).toContain("$7.50 budget");
    expect(budgetNotice(cfg(), Date.UTC(2026, 11, 31))).toContain("January 1.");
  });
});

describe("UsageMeter", () => {
  it("accrues runtime over fake time and persists it", async () => {
    const { clock, meter, dir } = meterAt(Date.UTC(2026, 10, 3, 12));
    await meter.start();
    clock.t += 60_000;
    await meter.tick();
    clock.t += 3_540_000;
    await meter.tick();
    const snap = meter.snapshot();
    expect(snap.month).toBe("2026-11");
    expect(snap.runtimeHours).toBeCloseTo(1, 10);
    expect(read(dir!).months["2026-11"]!.runtimeSeconds).toBeCloseTo(3600, 5);
    await meter.stop();
  });

  it("ticks itself every 60 seconds on the scheduler", async () => {
    const { clock, meter, dir } = meterAt(Date.UTC(2026, 10, 3, 12));
    await meter.start();
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(read(dir!).months["2026-11"]!.runtimeSeconds).toBeCloseTo(60, 5);
    await meter.stop();
    expect(read(dir!).months["2026-11"]!.runtimeSeconds).toBeCloseTo(60, 5);
  });

  it("resumes from usage.json after a restart", async () => {
    const dir = tmp();
    const a = meterAt(Date.UTC(2026, 10, 3, 12), {}, dir);
    await a.meter.start();
    a.clock.t += 7200_000;
    await a.meter.stop();
    const b = meterAt(Date.UTC(2026, 10, 3, 15), {}, dir);
    await b.meter.start();
    expect(b.meter.snapshot().runtimeHours).toBeCloseTo(2, 8);
    await b.meter.stop();
  });

  it("counts bytes written to tracked sockets, on ticks and on close", async () => {
    const { meter } = meterAt(Date.UTC(2026, 10, 3, 12), {}, null);
    await meter.start();
    const a = new FakeSocket();
    const b = new FakeSocket();
    meter.track(a);
    meter.track(b);
    a.bytesWritten = 1000;
    await meter.tick();
    expect(meter.snapshot().egressGB * GB).toBeCloseTo(1000, 3);
    a.bytesWritten = 2500;
    b.bytesWritten = 400;
    await meter.tick();
    expect(meter.snapshot().egressGB * GB).toBeCloseTo(2900, 3);
    a.bytesWritten = 3000;
    a.emit("close"); // the last delta is picked up on close
    await meter.tick();
    expect(meter.snapshot().egressGB * GB).toBeCloseTo(3400, 3);
    await meter.stop();
  });

  it("starts a fresh bucket on a new month and keeps only the last three", async () => {
    const { clock, meter } = meterAt(Date.UTC(2026, 10, 30, 23, 59), {}, null);
    await meter.start();
    clock.t = Date.UTC(2026, 11, 1, 0, 1); // 60 s in November, 60 s in December
    await meter.tick();
    let snap = meter.snapshot();
    expect(snap.month).toBe("2026-12");
    expect(snap.runtimeHours * 3600).toBeCloseTo(60, 5);
    expect(snap.lastMonths.map((m) => [m.month, Math.round(m.runtimeHours * 3600)])).toEqual([["2026-11", 60]]);
    for (const [y, m] of [[2027, 0], [2027, 1], [2027, 2]] as const) {
      clock.t = Date.UTC(y, m, 2);
      await meter.tick();
    }
    snap = meter.snapshot();
    expect(snap.month).toBe("2027-03");
    expect(snap.lastMonths.map((m) => m.month)).toEqual(["2027-02", "2027-01"]);
    await meter.stop();
  });

  it("guard transitions ok -> warn -> limit, and back to ok in a new month", async () => {
    // $0.01 per second of runtime, limit $100, no other charges
    const { clock, meter } = meterAt(Date.UTC(2026, 10, 30, 12), {
      cpuUsdPerHour: 36, egressUsdPerGb: 0, volumeGb: 0, fixedUsdPerMonth: 0, limitUsd: 100,
    }, null);
    const seen: Array<[string, string | null]> = [];
    meter.onChange((s, n) => seen.push([s, n]));
    await meter.start();
    expect(meter.status()).toBe("ok");
    clock.t += 8100_000; // $81
    await meter.tick();
    expect(meter.status()).toBe("warn");
    expect(meter.notice()).toBeNull();
    clock.t += 2000_000; // $101
    await meter.tick();
    expect(meter.status()).toBe("limit");
    expect(meter.notice()).toContain("$100 budget");
    clock.t = Date.UTC(2026, 11, 1, 0, 10);
    await meter.tick();
    expect(meter.status()).toBe("ok");
    expect(seen.map((x) => x[0])).toEqual(["warn", "limit", "ok"]);
    expect(seen[1]![1]).toContain("December 1.");
    expect(seen[2]![1]).toBeNull();
    await meter.stop();
  });

  it("records notifications once per level per month", async () => {
    const { clock, meter, dir } = meterAt(Date.UTC(2026, 10, 3, 12));
    await meter.start();
    const first = await meter.markNotified("warn");
    expect(first.warn).toBe("2026-11-03T12:00:00.000Z");
    expect(first.limit).toBeNull();
    clock.t += 3600_000;
    expect((await meter.markNotified("warn")).warn).toBe("2026-11-03T12:00:00.000Z");
    expect(meter.snapshot().notified.warn).toBe("2026-11-03T12:00:00.000Z");
    expect(read(dir!).notified["2026-11"]!.warn).toBe("2026-11-03T12:00:00.000Z");
    clock.t = Date.UTC(2026, 11, 2);
    expect(meter.snapshot().notified).toEqual({ warn: null, limit: null });
    await meter.stop();
  });

  it("monthKey is UTC", () => {
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
    expect(monthKey(Date.UTC(2027, 0, 1))).toBe("2027-01");
  });
});

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView; errors: string[] };

function client(port: number, tableId: string, name: string, token: string): Client {
  const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true }) as Client;
  s.errors = [];
  s.on("error", (e) => s.errors.push(e.message));
  s.on("state", (v) => { s.view = v; });
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  return s;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("budget guard on the server", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const c of open.splice(0).reverse()) await c.close();
  });

  const RATES = { cpuUsdPerHour: 36, egressUsdPerGb: 0, volumeGb: 0, fixedUsdPerMonth: 0, limitUsd: 100 };

  it("lets the current hand finish, then deals nothing, refuses new tables, and resumes next month", async () => {
    const clock = new FakeClock();
    clock.t = Date.UTC(2026, 10, 30, 12);
    const server = await startServer(0, { dataDir: tmp(), now: clock.now, scheduler: clock, budget: RATES });
    open.push({ close: () => server.close() });

    const a = client(server.port, "budget-1", "Ana", "tok-a-budget1");
    const b = client(server.port, "budget-1", "Bo", "tok-b-budget1");
    await until(() => !!a.view && !!b.view);
    expect(a.view!.siteNotice).toBeNull();
    a.emit("host:config", { awardMode: "auto" });
    a.emit("sit", { seat: 0, buyIn: 1000 });
    b.emit("sit", { seat: 1, buyIn: 1000 });
    await until(() => a.view!.seats.filter(Boolean).length === 2);
    a.emit("host:start");
    await until(() => a.view!.status === "playing");
    clock.advance(1500);
    await until(() => !!a.view!.hand && a.view!.hand.winners === null);
    const firstHand = a.view!.hand!.handNumber;

    // Cross into "warn": nothing visible to players.
    clock.t += 8100_000;
    await server.usage.tick();
    expect(server.usage.status()).toBe("warn");
    expect(a.view!.siteNotice).toBeNull();

    // Cross the limit mid-hand: everyone sees the notice, the hand is still live.
    clock.t += 2000_000;
    await server.usage.tick();
    expect(server.usage.status()).toBe("limit");
    await until(() => a.view!.siteNotice !== null && b.view!.siteNotice !== null);
    expect(a.view!.siteNotice).toBe("Mocha Poker has reached its $100 budget for this month. Games resume on December 1. — Fred");
    expect(a.view!.hand!.winners).toBeNull();
    expect(a.view!.status).toBe("paused");

    // The host cannot lift it.
    a.emit("host:pause", { paused: false });
    await until(() => a.errors.length > 0);
    expect(a.errors[0]).toContain("budget");

    // Finish the hand.
    const finish = (): void => {
      for (const c of [a, b]) {
        const legal = c.view!.hand?.legal;
        if (legal && c.view!.hand!.winners === null) c.emit("action", legal.canFold ? { type: "fold" } : { type: "check" });
      }
    };
    await until(() => { finish(); return a.view!.hand?.winners != null; });
    expect(a.view!.lastHand!.handNumber).toBe(firstHand);

    // No new hand starts, however long we wait.
    clock.advance(30_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.view!.hand!.handNumber).toBe(firstHand);
    expect(a.view!.hand!.winners).not.toBeNull();

    // A brand-new table is refused with the notice; the existing one is still joinable (view/ledger).
    const c = client(server.port, "budget-2", "Cy", "tok-c-budget2");
    await until(() => c.errors.length > 0);
    expect(c.errors[0]).toContain("Games resume on December 1.");
    expect(c.view).toBeUndefined();
    const d = client(server.port, "budget-1", "Bo", "tok-b-budget1");
    await until(() => !!d.view);
    expect(d.view!.siteNotice).not.toBeNull();
    expect(d.view!.ledger.length).toBe(2);

    // New month: the guard lifts by itself and the table picks its previous status back up.
    clock.t = Date.UTC(2026, 11, 1, 0, 10);
    await server.usage.tick();
    expect(server.usage.status()).toBe("ok");
    await until(() => a.view!.siteNotice === null);
    expect(a.view!.status).toBe("playing");
    clock.advance(1500);
    await until(() => a.view!.hand!.handNumber === firstHand + 1);
    const e = client(server.port, "budget-3", "Di", "tok-d-budget3");
    await until(() => !!e.view);
    for (const x of [a, b, c, d, e]) x.close();
  }, 30_000);

  it("a restart with a raised limit lifts the guard", async () => {
    const dir = tmp();
    const clock = new FakeClock();
    clock.t = Date.UTC(2026, 10, 30, 12);
    const s1 = await startServer(0, { dataDir: dir, now: clock.now, scheduler: clock, budget: RATES });
    clock.t += 10_100_000;
    await s1.usage.tick();
    expect(s1.usage.status()).toBe("limit");
    await s1.close();
    const s2 = await startServer(0, { dataDir: dir, now: clock.now, scheduler: clock, budget: { ...RATES, limitUsd: 500 } });
    open.push({ close: () => s2.close() });
    expect(s2.usage.status()).toBe("ok");
    const x = client(s2.port, "budget-up", "Ed", "tok-e-budgetup");
    await until(() => !!x.view);
    expect(x.view!.siteNotice).toBeNull();
    x.close();
  });

  it("uses a temp data dir, and starts at ok by default", async () => {
    const dir = tmp();
    const server = await startServer(0, { dataDir: dir });
    expect(server.usage.status()).toBe("ok");
    await server.close();
    expect(read(dir).months[monthKey(Date.now())]).toBeDefined();
  });
});

describe("/admin/usage", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const c of open.splice(0).reverse()) await c.close();
  });

  it("is a 404 when USAGE_TOKEN is unset", async () => {
    const prev = process.env.USAGE_TOKEN;
    delete process.env.USAGE_TOKEN;
    try {
      const s = await startServer(0, { dataDir: tmp() });
      open.push(s);
      expect((await fetch(`http://localhost:${s.port}/admin/usage?token=anything`)).status).toBe(404);
      expect((await fetch(`http://localhost:${s.port}/admin/usage/notified?token=x&level=warn`, { method: "POST" })).status).toBe(404);
    } finally {
      if (prev !== undefined) process.env.USAGE_TOKEN = prev;
    }
  });

  it("is a 401 on a wrong or missing token, and 200 with the report on the right one", async () => {
    const s = await startServer(0, { dataDir: tmp(), usageToken: "s3cret-token" });
    open.push(s);
    const base = `http://localhost:${s.port}/admin/usage`;
    expect((await fetch(`${base}?token=nope`)).status).toBe(401);
    expect((await fetch(`${base}?token=s3cret-token-longer`)).status).toBe(401);
    expect((await fetch(base)).status).toBe(401);
    const res = await fetch(`${base}?token=s3cret-token`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      month: monthKey(Date.now()), status: "ok", limitUsd: 5, warnUsd: 4, lastMonths: [], notified: { warn: null, limit: null },
      rates: { cpuUsdPerHour: 0.0035, egressUsdPerGb: 0.04, volumeGb: 1, volumeUsdPerGbMonth: 0.15, fixedUsdPerMonth: 0.1 },
    });
    expect(typeof body.runtimeHours).toBe("number");
    expect(typeof body.egressGB).toBe("number");
    expect(typeof body.estimatedUsd).toBe("number");
  });

  it("counts real HTTP egress", async () => {
    const s = await startServer(0, { dataDir: tmp(), usageToken: "t" });
    open.push(s);
    for (let i = 0; i < 3; i++) await (await fetch(`http://localhost:${s.port}/admin/usage?token=t`)).text();
    await s.usage.tick();
    expect(s.usage.snapshot().egressGB).toBeGreaterThan(0);
  });

  it("POST /admin/usage/notified records the level once and validates it", async () => {
    const s = await startServer(0, { dataDir: tmp(), usageToken: "tok" });
    open.push(s);
    const url = (q: string): string => `http://localhost:${s.port}/admin/usage/notified?${q}`;
    expect((await fetch(url("token=bad&level=warn"), { method: "POST" })).status).toBe(401);
    expect((await fetch(url("token=tok&level=bogus"), { method: "POST" })).status).toBe(400);
    const r = await fetch(url("token=tok&level=warn"), { method: "POST" });
    expect(r.status).toBe(200);
    const first = ((await r.json()) as { notified: { warn: string | null; limit: string | null } }).notified;
    expect(first.warn).not.toBeNull();
    expect(first.limit).toBeNull();
    await fetch(url("token=tok&level=limit"), { method: "POST" });
    const got = (await (await fetch(`http://localhost:${s.port}/admin/usage?token=tok`)).json()) as { notified: { warn: string; limit: string } };
    expect(got.notified.warn).toBe(first.warn);
    expect(got.notified.limit).not.toBeNull();
  });
});
