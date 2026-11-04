import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents, TableView } from "@homegame/engine";
import { startServer } from "../src/index.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents> & { view?: TableView; errors: string[] };

function client(port: number, tableId: string, name: string, token: string, autoplay: boolean): Client {
  const s = connect(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true }) as Client;
  s.errors = [];
  s.on("error", (e) => s.errors.push(e.message));
  s.on("state", (view) => {
    s.view = view;
    const legal = view.hand?.legal;
    if (autoplay && legal && view.hand!.winners === null) {
      s.emit("action", legal.canCheck ? { type: "check" } : { type: "call" });
    }
  });
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  return s;
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("socket server", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(0);
  });
  afterAll(async () => {
    await server.close();
  });

  it("reports user errors for a bad table code", async () => {
    const a = client(server.port, "bad input!", "Ana", "tok-err-12345", false);
    await until(() => a.errors.length > 0);
    expect(a.errors[0]).toMatch(/Table codes/);
    a.close();
  });

  it("drives two clients through a complete hand", async () => {
    const tableId = "integration-1";
    const a = client(server.port, tableId, "Ana", "tok-a-123456", true);
    const b = client(server.port, tableId, "Bo", "tok-b-123456", true);
    await until(() => !!a.view && !!b.view);
    expect(a.view!.you.isHost).toBe(true);
    expect(b.view!.you.isHost).toBe(false);
    a.emit("sit", { seat: 0, buyIn: 1000 });
    b.emit("sit", { seat: 1, buyIn: 1000 });
    await until(() => a.view!.seats.filter(Boolean).length === 2);
    b.emit("host:start");
    await until(() => b.errors.length > 0);
    a.emit("host:start");
    await until(() => a.view!.hand?.winners != null && b.view!.hand?.winners != null, 20_000);
    expect(a.view!.lastHand).not.toBeNull();
    expect(a.view!.seats.reduce((n, s) => n + (s?.stack ?? 0), 0)).toBe(2000);
    expect(a.view!.you.seat).toBe(0);
    expect(b.view!.you.seat).toBe(1);
    a.close();
    b.close();
  }, 30_000);
});
