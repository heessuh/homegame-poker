import { createServer } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server, type Socket } from "socket.io";
import {
  shuffle,
  type Card,
  type ClientToServerEvents,
  type PlayerAction,
  type ServerToClientEvents,
  type TableConfig,
} from "@homegame/engine";
import { realScheduler, Table, UserError, type Scheduler } from "./table.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist");

const TABLE_ID_RE = /^[a-z0-9-]{3,32}$/i;
const IDLE_TABLE_MS = 2 * 60 * 60 * 1000;

interface SocketData {
  tableId?: string;
  playerId?: string;
}
type PokerSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface ServerOptions {
  deckSource?: () => Card[];
  scheduler?: Scheduler;
  now?: () => number;
}

export function startServer(port: number, opts: ServerOptions = {}): Promise<{ close: () => Promise<void>; port: number }> {
  const now = opts.now ?? Date.now;
  const scheduler = opts.scheduler ?? realScheduler;
  const deckSource = opts.deckSource ?? (() => shuffle());

  const app = express();
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  const http = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(http, {
    cors: { origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" },
  });

  const tables = new Map<string, Table>();
  // sockets per (tableId, playerId)
  const sockets = new Map<string, Map<string, Set<PokerSocket>>>();

  function broadcast(tableId: string): void {
    const table = tables.get(tableId);
    const byPlayer = sockets.get(tableId);
    if (!table || !byPlayer) return;
    for (const [playerId, set] of byPlayer) {
      if (set.size === 0) continue;
      try {
        const view = table.viewFor(playerId);
        for (const s of set) s.emit("state", view);
      } catch (e) {
        console.error("viewFor failed", e);
      }
    }
  }

  function dropTable(id: string): void {
    tables.get(id)?.dispose();
    tables.delete(id);
    sockets.delete(id);
  }

  function getOrCreateTable(tableId: string): Table {
    let t = tables.get(tableId);
    if (!t) {
      t = new Table({ tableId, now, scheduler, deckSource, onChange: () => broadcast(tableId) });
      tables.set(tableId, t);
      sockets.set(tableId, new Map());
    }
    return t;
  }

  const gc = setInterval(() => {
    for (const [id, t] of tables) {
      if (t.idleSince !== null && now() - t.idleSince > IDLE_TABLE_MS) dropTable(id);
    }
  }, 10 * 60 * 1000);
  gc.unref();

  io.on("connection", (socket: PokerSocket) => {
    const fail = (e: unknown) => {
      if (e instanceof UserError) socket.emit("error", { message: e.message });
      else {
        console.error("Unexpected error", e);
        socket.emit("error", { message: "Something went wrong on the server." });
      }
    };
    /** Wraps a handler: arguments are untrusted, errors are reported to this socket only. */
    const handle = (fn: (raw: unknown) => void) => (raw?: unknown) => {
      try {
        fn(raw);
      } catch (e) {
        fail(e);
      }
    };
    const ctx = (): { table: Table; playerId: string } => {
      const { tableId, playerId } = socket.data;
      const table = tableId ? tables.get(tableId) : undefined;
      if (!table || !playerId) throw new UserError("Join a table first.");
      return { table, playerId };
    };
    const obj = (v: unknown): Record<string, unknown> => {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new UserError("Invalid request.");
      return v as Record<string, unknown>;
    };
    const int = (v: unknown, what: string): number => {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new UserError(`${what} must be a whole number.`);
      return v;
    };
    // Handlers take untrusted input, so they are registered through a loose-typed view of the socket.
    const on = socket.on.bind(socket) as unknown as (ev: string, fn: (raw?: unknown) => void) => void;

    on("join", handle((raw) => {
      const p = obj(raw);
      if (socket.data.playerId) throw new UserError("You already joined a table.");
      if (typeof p.tableId !== "string" || !TABLE_ID_RE.test(p.tableId)) {
        throw new UserError("Table codes are 3 to 32 letters, digits or dashes.");
      }
      if (typeof p.name !== "string") throw new UserError("Enter a name.");
      if (typeof p.playerToken !== "string") throw new UserError("Missing player token.");
      const tableId = p.tableId.toLowerCase();
      const existed = tables.has(tableId);
      const table = getOrCreateTable(tableId);
      let playerId: string;
      try {
        playerId = table.join(p.playerToken, p.name, p.avatar);
      } catch (e) {
        if (!existed) dropTable(tableId);
        throw e;
      }
      socket.data.tableId = tableId;
      socket.data.playerId = playerId;
      const byPlayer = sockets.get(tableId)!;
      let set = byPlayer.get(playerId);
      if (!set) byPlayer.set(playerId, (set = new Set()));
      set.add(socket);
      void socket.join(tableId);
      broadcast(tableId);
    }));

    on("setAvatar", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.setAvatar(playerId, p.avatar);
    }));

    on("sit", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.sit(playerId, int(p.seat, "Seat"), int(p.buyIn, "Buy-in"));
    }));

    on("stand", handle(() => {
      const { table, playerId } = ctx();
      table.stand(playerId);
    }));

    on("sitOut", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      if (typeof p.sittingOut !== "boolean") throw new UserError("Invalid request.");
      table.sitOut(playerId, p.sittingOut);
    }));

    on("host:sitOut", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      if (typeof p.playerId !== "string" || typeof p.sittingOut !== "boolean") throw new UserError("Invalid request.");
      table.hostSitOut(playerId, p.playerId, p.sittingOut);
    }));

    on("rebuy", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.rebuy(playerId, int(p.amount, "Amount"));
    }));

    on("action", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      let act: PlayerAction;
      switch (p.type) {
        case "fold": act = { type: "fold" }; break;
        case "check": act = { type: "check" }; break;
        case "call": act = { type: "call" }; break;
        case "raise": act = { type: "raise", amount: int(p.amount, "Amount") }; break;
        default: throw new UserError("Unknown action.");
      }
      table.action(playerId, act);
    }));

    on("host:start", handle(() => {
      const { table, playerId } = ctx();
      table.hostStart(playerId);
    }));

    on("host:pause", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      if (typeof p.paused !== "boolean") throw new UserError("Invalid request.");
      table.hostPause(playerId, p.paused);
    }));

    on("host:config", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostConfig(playerId, p as Partial<TableConfig>);
    }));

    on("host:kick", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      if (typeof p.playerId !== "string") throw new UserError("Invalid request.");
      table.hostKick(playerId, p.playerId);
    }));

    on("host:adjustStack", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      if (typeof p.playerId !== "string") throw new UserError("Invalid request.");
      table.hostAdjustStack(playerId, p.playerId, int(p.delta, "Adjustment"));
    }));

    on("host:award", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostAward(playerId, p.awards);
    }));

    on("host:transfer", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostTransfer(playerId, p.fromPlayerId, p.toPlayerId, p.amount);
    }));

    on("host:playerTimer", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostPlayerTimer(playerId, p.playerId, p.seconds);
    }));

    on("host:addTime", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostAddTime(playerId, p.playerId, p.seconds);
    }));

    on("host:forceTimeout", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostForceTimeout(playerId, p.playerId);
    }));

    on("host:tournamentLevel", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostTournamentLevel(playerId, p.delta);
    }));

    on("host:tournamentClock", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      table.hostTournamentClock(playerId, p.addMs);
    }));

    socket.on("disconnect", () => {
      const { tableId, playerId } = socket.data;
      if (!tableId || !playerId) return;
      sockets.get(tableId)?.get(playerId)?.delete(socket);
      try {
        tables.get(tableId)?.disconnect(playerId);
      } catch (e) {
        console.error("disconnect failed", e);
      }
    });
  });

  return new Promise((resolvePromise, reject) => {
    http.once("error", reject);
    http.listen(port, () => {
      const actual = (http.address() as AddressInfo).port;
      resolvePromise({
        port: actual,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(gc);
            for (const t of tables.values()) t.dispose();
            void io.close(() => res());
          }),
      });
    });
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.env.HOMEGAME_NO_LISTEN !== "1" && entry === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT ?? 3000);
  void startServer(PORT).then((s) => console.log(`homegame-poker listening on :${s.port}`));
}
