import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import type { FsLike } from "./persist.js";
import type { Scheduler } from "./table.js";

/** Cost meter and budget guard. Fly.io has no spending caps, so the app meters itself (UTC calendar months). */

export interface UsageConfig {
  cpuUsdPerHour: number;
  egressUsdPerGb: number;
  volumeGb: number;
  volumeUsdPerGbMonth: number;
  fixedUsdPerMonth: number;
  limitUsd: number;
  warnRatio: number;
}

export type BudgetStatus = "ok" | "warn" | "limit";
export type NotifyLevel = "warn" | "limit";

export interface MonthRecord {
  runtimeSeconds: number;
  egressBytes: number;
}

export interface UsageFile {
  version: 1;
  months: Record<string, MonthRecord>;
  notified: Record<string, { warn: string | null; limit: string | null }>;
}

export interface MonthReport {
  month: string;
  runtimeHours: number;
  egressGB: number;
  estimatedUsd: number;
}

export interface UsageReport extends MonthReport {
  limitUsd: number;
  warnUsd: number;
  status: BudgetStatus;
  rates: Omit<UsageConfig, "limitUsd" | "warnRatio">;
  lastMonths: MonthReport[];
  notified: { warn: string | null; limit: string | null };
}

/** The slice of net.Socket the meter needs. */
export interface CountedSocket {
  bytesWritten: number;
  once(event: "close", fn: () => void): unknown;
}

export const GB = 1_000_000_000;
export const USAGE_TICK_MS = 60_000;
const KEEP_MONTHS = 3;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function loadUsageConfig(env: NodeJS.ProcessEnv = process.env): UsageConfig {
  return {
    cpuUsdPerHour: num(env.CPU_RATE_USD_PER_HOUR, 0.0035),
    egressUsdPerGb: num(env.EGRESS_USD_PER_GB, 0.04),
    volumeGb: num(env.VOLUME_GB, 1),
    volumeUsdPerGbMonth: num(env.VOLUME_USD_PER_GB_MONTH, 0.15),
    fixedUsdPerMonth: num(env.FIXED_USD_PER_MONTH, 0.1),
    limitUsd: num(env.BUDGET_LIMIT_USD, 5),
    warnRatio: num(env.BUDGET_WARN_RATIO, 0.8),
  };
}

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function keyStart(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, 1);
}

/** The estimate for one month. `at` decides how much of the month the time-based charges cover. */
export function estimateUsd(cfg: UsageConfig, key: string, rec: MonthRecord, at: number): number {
  const start = keyStart(key);
  const end = nextMonthStart(start);
  const frac = Math.min(1, Math.max(0, (at - start) / (end - start)));
  return (rec.runtimeSeconds / 3600) * cfg.cpuUsdPerHour
    + (rec.egressBytes / GB) * cfg.egressUsdPerGb
    + cfg.volumeGb * cfg.volumeUsdPerGbMonth * frac
    + cfg.fixedUsdPerMonth * frac;
}

export function statusFor(cfg: UsageConfig, usd: number): BudgetStatus {
  if (usd >= cfg.limitUsd) return "limit";
  if (usd >= cfg.limitUsd * cfg.warnRatio) return "warn";
  return "ok";
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function budgetNotice(cfg: UsageConfig, at: number): string {
  const next = new Date(nextMonthStart(at));
  return `Mocha Poker has reached its ${money(cfg.limitUsd)} budget for this month. Games resume on ${MONTH_NAMES[next.getUTCMonth()]} 1. — Fred`;
}

export interface MeterOptions {
  /** Directory for usage.json; null keeps everything in memory. */
  dir: string | null;
  now: () => number;
  scheduler: Scheduler;
  config?: UsageConfig;
  fs?: FsLike;
  tickMs?: number;
}

export class UsageMeter {
  readonly config: UsageConfig;
  private readonly dir: string | null;
  private readonly now: () => number;
  private readonly sched: Scheduler;
  private readonly fs: FsLike;
  private readonly tickMs: number;
  private data: UsageFile = { version: 1, months: {}, notified: {} };
  private lastAt = 0;
  private timer: unknown = null;
  private running = false;
  private readonly sockets = new Map<CountedSocket, number>();
  private writing: Promise<void> = Promise.resolve();
  private lastStatus: BudgetStatus = "ok";
  private lastMonth = "";
  private readonly listeners: Array<(status: BudgetStatus, notice: string | null) => void> = [];

  constructor(o: MeterOptions) {
    this.config = o.config ?? loadUsageConfig();
    this.dir = o.dir;
    this.now = o.now;
    this.sched = o.scheduler;
    this.fs = o.fs ?? (nodeFs as unknown as FsLike);
    this.tickMs = o.tickMs ?? USAGE_TICK_MS;
  }

  private get file(): string {
    return join(this.dir!, "usage.json");
  }

  /** Loads usage.json and begins accruing runtime. */
  async start(): Promise<void> {
    if (this.dir !== null) {
      try {
        const v = JSON.parse(await this.fs.readFile(this.file, "utf8")) as Partial<UsageFile>;
        if (v && typeof v === "object" && v.months && typeof v.months === "object") {
          this.data = { version: 1, months: v.months, notified: v.notified ?? {} };
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("Ignoring unreadable usage.json");
      }
    }
    this.lastAt = this.now();
    this.lastMonth = monthKey(this.lastAt);
    this.lastStatus = this.status();
    this.running = true;
    this.arm();
  }

  private arm(): void {
    this.timer = this.sched.setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.running) this.arm();
      });
    }, this.tickMs);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private rec(key: string): MonthRecord {
    return (this.data.months[key] ??= { runtimeSeconds: 0, egressBytes: 0 });
  }

  /** Adds runtime since the last accrual, splitting at UTC month boundaries. */
  private accrueRuntime(): void {
    const to = this.now();
    let from = this.lastAt;
    while (from < to) {
      const end = Math.min(to, nextMonthStart(from));
      this.rec(monthKey(from)).runtimeSeconds += (end - from) / 1000;
      from = end;
    }
    this.lastAt = Math.max(this.lastAt, to);
  }

  /** Registers a connection; bytes written to it count toward the current month. */
  track(socket: CountedSocket): void {
    this.sockets.set(socket, 0);
    socket.once("close", () => {
      this.collectSocket(socket);
      this.sockets.delete(socket);
    });
  }

  private collectSocket(s: CountedSocket): void {
    const seen = this.sockets.get(s) ?? 0;
    const cur = s.bytesWritten ?? 0;
    if (cur > seen) {
      this.rec(monthKey(this.now())).egressBytes += cur - seen;
      this.sockets.set(s, cur);
    }
  }

  /** Accrues runtime and egress, prunes old months, saves, and reports guard transitions. */
  async tick(): Promise<void> {
    this.accrueRuntime();
    for (const s of this.sockets.keys()) this.collectSocket(s);
    this.prune();
    this.checkStatus();
    await this.save();
  }

  /** Final accrual and write (shutdown). */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) this.sched.clearTimeout(this.timer);
    this.timer = null;
    await this.tick();
  }

  private prune(): void {
    const keep = (rec: Record<string, unknown>): void => {
      const keys = Object.keys(rec).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_MONTHS))) delete rec[k];
    };
    this.rec(monthKey(this.now()));
    keep(this.data.months);
    keep(this.data.notified);
  }

  private async save(): Promise<void> {
    if (this.dir === null) return;
    const body = JSON.stringify(this.data, null, 2);
    const run = async (): Promise<void> => {
      await this.fs.mkdir(this.dir!, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await this.fs.writeFile(tmp, body);
      await this.fs.rename(tmp, this.file);
    };
    this.writing = this.writing.then(run).catch((e) => console.error("saving usage.json failed", e));
    await this.writing;
  }

  /** Stored month plus whatever has accrued since the last tick (read-only). */
  private pendingRecord(key: string): MonthRecord {
    const base = this.data.months[key] ?? { runtimeSeconds: 0, egressBytes: 0 };
    let runtime = base.runtimeSeconds;
    if (this.running) {
      const from = Math.max(this.lastAt, keyStart(key));
      const to = Math.min(this.now(), nextMonthStart(keyStart(key)));
      if (to > from) runtime += (to - from) / 1000;
    }
    let egress = base.egressBytes;
    for (const [s, seen] of this.sockets) egress += Math.max(0, (s.bytesWritten ?? 0) - seen);
    return { runtimeSeconds: runtime, egressBytes: egress };
  }

  /** Current month's estimate, including what has accrued since the last tick. */
  estimatedUsd(): number {
    const at = this.now();
    const key = monthKey(at);
    return estimateUsd(this.config, key, this.pendingRecord(key), at);
  }

  status(): BudgetStatus {
    return statusFor(this.config, this.estimatedUsd());
  }

  /** Message shown to everyone at "limit"; null otherwise. */
  notice(): string | null {
    return this.status() === "limit" ? budgetNotice(this.config, this.now()) : null;
  }

  /** Called whenever the status or the month changes (checked on every tick). */
  onChange(fn: (status: BudgetStatus, notice: string | null) => void): void {
    this.listeners.push(fn);
  }

  private checkStatus(): void {
    const status = this.status();
    const month = monthKey(this.now());
    if (status !== this.lastStatus || month !== this.lastMonth) {
      this.lastStatus = status;
      this.lastMonth = month;
      const notice = status === "limit" ? budgetNotice(this.config, this.now()) : null;
      for (const fn of this.listeners) fn(status, notice);
    }
  }

  private report(key: string, at: number): MonthReport {
    const rec = key === monthKey(at) ? this.pendingRecord(key) : (this.data.months[key] ?? { runtimeSeconds: 0, egressBytes: 0 });
    return {
      month: key,
      runtimeHours: rec.runtimeSeconds / 3600,
      egressGB: rec.egressBytes / GB,
      estimatedUsd: estimateUsd(this.config, key, rec, at),
    };
  }

  snapshot(): UsageReport {
    const at = this.now();
    const key = monthKey(at);
    const cur = this.report(key, at);
    const { limitUsd, warnRatio, ...rates } = this.config;
    return {
      ...cur,
      limitUsd,
      warnUsd: limitUsd * warnRatio,
      status: statusFor(this.config, cur.estimatedUsd),
      rates,
      lastMonths: Object.keys(this.data.months).sort().reverse().filter((k) => k !== key).slice(0, KEEP_MONTHS).map((k) => this.report(k, at)),
      notified: { ...(this.data.notified[key] ?? { warn: null, limit: null }) },
    };
  }

  /** Records that the owner was emailed at this level this month (first call wins). */
  async markNotified(level: NotifyLevel): Promise<{ warn: string | null; limit: string | null }> {
    const key = monthKey(this.now());
    const n = (this.data.notified[key] ??= { warn: null, limit: null });
    n[level] ??= new Date(this.now()).toISOString();
    await this.save();
    return { ...n };
  }
}
