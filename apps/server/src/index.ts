import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server, type Socket } from "socket.io";
import {
  type Card,
  type ClientToServerEvents,
  type PlayerAction,
  type ServerToClientEvents,
  type TableConfig,
  type HandRecord,
  type RngAuditReport,
  type SessionReview,
} from "@homegame/engine";
import { IDLE_DELETE_MS, Store, type FsLike } from "./persist.js";
import { RngAudit } from "./rngAudit.js";
import { buildSessionReview } from "./luckWork.js";
import { loadUsageConfig, UsageMeter, type UsageConfig } from "./usage.js";
import { realScheduler, Table, UserError, type Scheduler, type TableSnapshot } from "./table.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist");

const TABLE_ID_RE = /^[a-z0-9-]{3,32}$/i;
const IDLE_MEMORY_MS = 2 * 60 * 60 * 1000; // without persistence, empty tables are forgotten after 2 hours
const GC_EVERY_MS = 60 * 60 * 1000;

interface SocketData {
  tableId?: string;
  playerId?: string;
}
type PokerSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface ServerOptions {
  deckSource?: () => Card[];
  scheduler?: Scheduler;
  now?: () => number;
  /** Where snapshots and house defaults live. Default: $DATA_DIR or ./data. null turns persistence off. */
  dataDir?: string | null;
  fs?: FsLike;
  /** Budget limits and cost rates. Default: read from the environment (BUDGET_LIMIT_USD etc.). */
  budget?: Partial<UsageConfig>;
  /** Token for /admin/usage. Default: $USAGE_TOKEN (the endpoints answer 404 when it is unset). */
  usageToken?: string;
}

export async function startServer(port: number, opts: ServerOptions = {}): Promise<{ close: () => Promise<void>; port: number; usage: UsageMeter }> {
  const now = opts.now ?? Date.now;
  const scheduler = opts.scheduler ?? realScheduler;
  // No deckSource in production: every deck is derived from the committed server seed plus the players' seeds (docs/FAIRNESS.md).
  const deckSource = opts.deckSource;
  const dataDir = opts.dataDir === undefined ? (process.env.DATA_DIR ?? "./data") : opts.dataDir;
  const store = dataDir === null ? null : new Store({ dir: dataDir, scheduler, now, fs: opts.fs });
  let houseDefaults: Partial<TableConfig> | undefined = store ? await store.loadDefaults() : undefined;

  const meter = new UsageMeter({
    dir: dataDir, now, scheduler, fs: opts.fs,
    config: { ...loadUsageConfig(), ...opts.budget },
  });
  await meter.start();
  const audit = new RngAudit({ dir: dataDir, scheduler, now, fs: opts.fs });
  await audit.load();
  let budgetNote: string | null = meter.notice();

  const app = express();
  const tokenOk = (given: unknown): boolean => {
    const want = opts.usageToken ?? process.env.USAGE_TOKEN;
    if (!want || typeof given !== "string") return false;
    const h = (v: string) => createHash("sha256").update(v).digest();
    return timingSafeEqual(h(given), h(want));
  };
  /** 404 when no token is configured, 401 on a wrong one. */
  const adminAuth = (req: express.Request, res: express.Response): boolean => {
    if (!(opts.usageToken ?? process.env.USAGE_TOKEN)) {
      res.status(404).json({ error: "Not found" });
      return false;
    }
    if (!tokenOk(req.query.token)) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  };
  app.get("/admin/usage", (req, res) => {
    if (adminAuth(req, res)) res.json(meter.snapshot());
  });
  app.post("/admin/usage/notified", (req, res) => {
    if (!adminAuth(req, res)) return;
    const level = req.query.level;
    if (level !== "warn" && level !== "limit") {
      res.status(400).json({ error: "level must be warn or limit" });
      return;
    }
    meter.markNotified(level).then((notified) => res.json({ ok: true, notified }), () => res.status(500).json({ error: "save failed" }));
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
  }

  const http = createServer(app);
  http.on("connection", (s: NetSocket) => meter.track(s));
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
    if (store) void store.remove(id);
  }

  function makeTable(tableId: string, snapshot?: TableSnapshot): Table {
    const t: Table = new Table({
      tableId, now, scheduler, deckSource, onHandRecorded: (id, rec) => audit.record(id, rec), config: houseDefaults, snapshot,
      onChange: () => {
        broadcast(tableId);
        if (store) store.markDirty(tableId, () => (tables.get(tableId) === t ? t.snapshot() : null));
      },
    });
    tables.set(tableId, t);
    sockets.set(tableId, new Map());
    if (budgetNote) t.setBudgetNotice(budgetNote);
    return t;
  }

  function getOrCreateTable(tableId: string): Table {
    let t = tables.get(tableId);
    return t ?? makeTable(tableId);
  }

  if (store) {
    for (const snap of await store.loadAll()) {
      try {
        makeTable(snap.tableId, snap).resume();
      } catch (e) {
        console.error(`Could not restore table ${snap.tableId}`, e);
        tables.delete(snap.tableId);
        sockets.delete(snap.tableId);
      }
    }
    for (const [id, t] of tables) audit.backfill(id, t.snapshot().history);
    if (tables.size > 0) console.log(`Restored ${tables.size} table(s) from ${dataDir}`);
  }

  meter.onChange((_status, notice) => {
    budgetNote = notice;
    if (notice) console.warn(`Budget limit reached: ${notice}`);
    for (const t of tables.values()) t.setBudgetNotice(notice);
  });

  const gc = setInterval(() => {
    const limit = store ? IDLE_DELETE_MS : IDLE_MEMORY_MS;
    for (const [id, t] of tables) {
      if (t.idleSince !== null && now() - t.idleSince > limit) dropTable(id);
    }
  }, GC_EVERY_MS);
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
      if (!existed && budgetNote) throw new UserError(budgetNote);
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

    // Older clients still send this; rebuys are dealer-only now.
    on("rebuy", handle(() => {
      throw new UserError("Ask the dealer for more chips");
    }));

    // Client seed for the next hand's shuffle. Bad or late seeds are ignored without an error.
    on("seed", handle((raw) => {
      const { table, playerId } = ctx();
      const p = obj(raw);
      table.submitSeed(playerId, p.handNumber, p.clientSeed);
    }));

    on("extendTime", handle(() => {
      const { table, playerId } = ctx();
      table.extendTime(playerId);
    }));

    const onAck = socket.on.bind(socket) as unknown as (ev: string, fn: (raw: unknown, ack?: unknown) => void) => void;
    onAck("getHand", (raw, ack) => {
      if (typeof ack !== "function") return;
      try {
        const { table } = ctx();
        const n = raw && typeof raw === "object" ? (raw as Record<string, unknown>).handNumber : undefined;
        (ack as (r: HandRecord | null) => void)(table.getHand(n));
      } catch (e) {
        (ack as (r: null) => void)(null);
        fail(e);
      }
    });
    onAck("getRngAudit", (raw, ack) => {
      if (typeof ack !== "function") return;
      try {
        const scope = raw && typeof raw === "object" ? (raw as Record<string, unknown>).scope : undefined;
        if (scope !== "site" && scope !== "table") throw new UserError("Invalid request.");
        const { table } = ctx();
        (ack as (r: RngAuditReport) => void)(scope === "site" ? audit.siteReport() : audit.tableReport(table.snapshot().history));
      } catch (e) {
        fail(e);
      }
    });
    onAck("getDealerLog", (first, second) => {
      const reply = (typeof first === "function" ? first : second) as unknown;
      if (typeof reply !== "function") return;
      try {
        (reply as (l: unknown[]) => void)(ctx().table.getDealerLog());
      } catch (e) {
        (reply as (l: unknown[]) => void)([]);
      }
    });
    onAck("getSessionReview", (raw, ack) => {
      if (typeof ack !== "function") return;
      try {
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const filter = o.filter;
        const page = o.page;
        if (filter !== "all" && filter !== "folded-best" && filter !== "won-without-best") throw new UserError("Invalid request.");
        if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page > 100000) throw new UserError("Invalid request.");
        const { table } = ctx();
        const history = table.snapshot().history;
        void buildSessionReview(history, filter, page).then((r) => (ack as (r: SessionReview) => void)(r)).catch((e) => console.error("session review failed", e));
      } catch (e) {
        fail(e);
      }
    });
    onAck("getLog", (first, second) => {
      const reply = (typeof first === "function" ? first : second) as unknown;
      if (typeof reply !== "function") return;
      try {
        (reply as (l: string[]) => void)(ctx().table.getLog());
      } catch (e) {
        (reply as (l: string[]) => void)([]);
        fail(e);
      }
    });

    on("action", handle((raw) => {
      const p = obj(raw);
      const { table, playerId } = ctx();
      let act: PlayerAction;
      switch (p.type) {
        case "fold": act = { type: "fold" }; break;
        case "check": act = { type: "check" }; break;
        case "call": act = { type: "call" }; break;
        case "raise": act = { type: "raise", amount: int(p.amount, "Amount") }; break;
        case "exchange": {
          if (p.card !== null && (typeof p.card !== "string" || !/^[2-9TJQKA][cdhs]$/.test(p.card))) throw new UserError("Pick one of your cards.");
          act = { type: "exchange", card: p.card as Card | null };
          break;
        }
        case "declare": {
          if (p.choice !== "high" && p.choice !== "low" && p.choice !== "both") throw new UserError("Declare high, low or both.");
          act = { type: "declare", choice: p.choice };
          break;
        }
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

    on("host:saveDefaults", handle(() => {
      const { table, playerId } = ctx();
      const cfg = table.hostSaveDefaults(playerId);
      houseDefaults = cfg;
      if (store) store.saveDefaults(cfg).catch((e) => console.error("saving house defaults failed", e));
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
        usage: meter,
        close: async () => {
          clearInterval(gc);
          await audit.flush();
          if (store) await store.flush(); // before dispose: timers are cleared, state stays
          for (const t of tables.values()) t.dispose();
          await new Promise<void>((res) => void io.close(() => res()));
          await meter.stop(); // after sockets close, so their last bytes are counted
        },
      });
    });
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.env.HOMEGAME_NO_LISTEN !== "1" && entry === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT ?? 3000);
  void startServer(PORT).then((s) => {
    console.log(`homegame-poker listening on :${s.port}`);
    let stopping = false;
    const stop = (sig: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`${sig}: saving tables and shutting down`);
      s.close().catch((e) => console.error("shutdown failed", e)).finally(() => process.exit(0));
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  });
}
