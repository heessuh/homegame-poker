import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents, TableView } from "@homegame/engine";
import { startServer } from "../src/index.js";
import { UserError } from "../src/table.js";
import { checkDown, rig, seatAll } from "./helpers.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView; errors: string[] };

function client(port: number, tableId: string, name: string, token: string, headers?: Record<string, string>): Client {
  const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true, extraHeaders: headers, reconnection: false }) as Client;
  s.errors = [];
  s.on("error", (e) => s.errors.push(e.message));
  s.on("state", (view) => { s.view = view; });
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  return s;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("table rules: host and awards", () => {
  it("never hands host to someone who is not seated", () => {
    const r = rig(3);
    const [host, , spectator] = r.ids as [string, string, string];
    r.table.sit(host, 0, 100);
    r.table.disconnect(host);
    r.clock.advance(61_000);
    expect(r.table.viewFor(spectator).you.isHost).toBe(false);
    expect(r.table.viewFor(host).you.isHost).toBe(true);
  });

  it("locks a table so new identities cannot join, while seated players can come back", () => {
    const r = rig(2);
    const [host] = r.ids as [string, string];
    r.table.hostSetLocked(host, true);
    expect(r.table.viewFor(host).locked).toBe(true);
    expect(() => r.table.join("a-brand-new-token", "Stranger")).toThrow(UserError);
    expect(() => r.table.join("token-1", "P1")).not.toThrow(); // an existing token (rig uses token-<n>)
    r.table.hostSetLocked(host, false);
    expect(() => r.table.join("a-brand-new-token", "Stranger")).not.toThrow();
  });

  it("requires a reason when the dealer changes the suggested payout, and records it", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const [host, other] = r.ids as [string, string];
    r.table.hostStart(host);
    r.clock.advance(1000);
    checkDown(r);
    const pa = r.table.viewFor(host).pendingAward!;
    const suggestedId = pa.suggested[0]!.playerId;
    const wrong = suggestedId === host ? other : host;
    expect(() => r.table.hostAward(host, [{ playerId: wrong, amount: pa.amount }])).toThrow(/reason/);
    expect(() => r.table.hostAward(host, [{ playerId: wrong, amount: pa.amount }], "ok")).toThrow(/reason/);
    r.table.hostAward(host, [{ playerId: wrong, amount: pa.amount }], "agreed to chop the rule");
    const entry = r.table.getDealerLog().find((e) => e.action === "award")!;
    expect(entry.details).toMatchObject({ matchedSuggestion: false, reason: "agreed to chop the rule" });
  });

  it("accepts the suggested payout without a reason", () => {
    const r = rig(2, { awardMode: "host" });
    seatAll(r);
    const host = r.ids[0]!;
    r.table.hostStart(host);
    r.clock.advance(1000);
    checkDown(r);
    const pa = r.table.viewFor(host).pendingAward!;
    expect(() => r.table.hostAward(host, pa.suggested.map((s) => ({ playerId: s.playerId, amount: s.amount })))).not.toThrow();
  });
});

describe("server hardening", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(0, { dataDir: mkdtempSync(join(tmpdir(), "hg-hard-")), usageToken: "secret-token", joinLimitPerMinute: 12 });
  });
  afterAll(async () => {
    await server.close();
  });

  it("sends security headers", async () => {
    const res = await fetch(`http://localhost:${server.port}/healthz`);
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("takes the usage token from an Authorization header", async () => {
    const url = `http://localhost:${server.port}/admin/usage`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer secret-token" } })).status).toBe(200);
  });

  it("refuses a browser page from another origin but allows same-origin and scripts", async () => {
    const evil = client(server.port, "origin-test", "Eve", "tok-eve-1234567", { Origin: "https://evil.example" });
    await new Promise<void>((res) => {
      evil.on("connect_error", () => res());
      evil.on("connect", () => res());
    });
    expect(evil.connected).toBe(false);
    evil.close();

    const same = client(server.port, "origin-test", "Sam", "tok-sam-1234567", { Origin: `http://localhost:${server.port}` });
    await until(() => !!same.view);
    same.close();

    const script = client(server.port, "origin-test", "Bot", "tok-bot-1234567");
    await until(() => !!script.view);
    script.close();
  });

  it("slows down someone who joins tables too fast", async () => {
    const errors: string[] = [];
    const sockets: Client[] = [];
    for (let i = 0; i < 16; i++) {
      const c = client(server.port, `rate-${i}`, "Spam", `tok-spam-${i}-123456`);
      c.on("error", (e) => errors.push(e.message));
      sockets.push(c);
    }
    await until(() => errors.some((m) => /Too many join attempts/.test(m)), 15_000);
    for (const c of sockets) c.close();
  });
});
