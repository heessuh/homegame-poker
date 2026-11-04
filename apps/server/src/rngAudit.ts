import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import {
  addHandToCounts, buildLuckReport, buildReport, emptyCounts, isAuditCounts,
  type AuditCounts, type HandRecord, type LuckReport, type RngAuditReport,
} from "@homegame/engine";
import type { FsLike } from "./persist.js";
import type { Scheduler } from "./table.js";
import { LuckQueue } from "./luckWork.js";

const FILE_VERSION = 1;
const DEBOUNCE_MS = 2000;

interface AuditFile {
  version: number;
  since: string;
  counts: AuditCounts;
  /** Hands already counted: tableId -> flat [handNumber, endedAt, handNumber, endedAt, ...]. */
  seen: Record<string, number[]>;
}

export interface RngAuditOptions {
  /** Directory for rng-audit.json; null keeps everything in memory. */
  dir: string | null;
  scheduler: Scheduler;
  now: () => number;
  fs?: FsLike;
  debounceMs?: number;
}

/** A hand is the same hand when table, number and end time agree (a recycled table id restarts at hand 1). */
const keyOf = (n: number, endedAt: number): string => `${n}@${endedAt}`;

/**
 * Site-wide running totals for the RNG audit: every hand since launch, deduplicated by table + hand number,
 * saved atomically (temp file + rename) and debounced. Per-table reports are computed from a table's own history.
 */
export class RngAudit {
  private readonly o: RngAuditOptions;
  private readonly fs: FsLike;
  /** Background worker for the per-player luck numbers. */
  readonly luck = new LuckQueue();
  private counts: AuditCounts = emptyCounts();
  private since: string;
  private readonly seen = new Map<string, Set<string>>();
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(o: RngAuditOptions) {
    this.o = o;
    this.fs = o.fs ?? (nodeFs as unknown as FsLike);
    this.since = new Date(o.now()).toISOString();
  }

  private get path(): string {
    return join(this.o.dir!, "rng-audit.json");
  }

  /** Reads the saved totals (if any). Unreadable files are set aside as *.bad and counting starts fresh. */
  async load(): Promise<void> {
    if (this.o.dir === null) return;
    let text: string;
    try {
      text = await this.fs.readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("Could not read rng-audit.json; starting fresh");
      return;
    }
    try {
      const f = JSON.parse(text) as AuditFile;
      if (!f || f.version !== FILE_VERSION || !isAuditCounts(f.counts) || typeof f.since !== "string" || !f.seen || typeof f.seen !== "object") {
        throw new Error("unsupported file");
      }
      this.counts = f.counts;
      this.since = f.since;
      for (const [id, flat] of Object.entries(f.seen)) {
        const set = new Set<string>();
        for (let i = 0; i + 1 < flat.length; i += 2) set.add(keyOf(flat[i]!, flat[i + 1]!));
        this.seen.set(id, set);
      }
    } catch (e) {
      console.warn(`Ignoring unreadable rng-audit.json: ${e instanceof Error ? e.message : e}`);
      await this.fs.rename(this.path, `${this.path}.bad`).catch(() => undefined);
    }
  }

  get hands(): number {
    return this.counts.hands;
  }

  /** Counts one finished hand unless it was counted before. Returns true when it was new. */
  record(tableId: string, rec: HandRecord): boolean {
    const key = keyOf(rec.handNumber, rec.endedAt);
    let set = this.seen.get(tableId);
    if (set?.has(key)) return false;
    if (!addHandToCounts(this.counts, rec)) return false;
    if (!set) this.seen.set(tableId, (set = new Set()));
    set.add(key);
    // The luck math runs in the background, a few milliseconds at a time (see LuckQueue).
    this.luck.enqueue(rec);
    this.markDirty();
    return true;
  }

  /** Counts every not-yet-counted hand in a restored table's history. Returns how many were new. */
  backfill(tableId: string, history: readonly HandRecord[]): number {
    let added = 0;
    for (const rec of history) if (this.record(tableId, rec)) added++;
    return added;
  }

  siteReport(): RngAuditReport {
    return buildReport(this.counts, "site", this.since);
  }

  /** Report computed from one table's own history, independent of the site totals. */
  tableReport(history: readonly HandRecord[]): RngAuditReport {
    const c = emptyCounts();
    const seen = new Set<string>();
    let first = Infinity;
    for (const rec of history) {
      const k = keyOf(rec.handNumber, rec.endedAt);
      if (seen.has(k)) continue;
      if (addHandToCounts(c, rec)) {
        seen.add(k);
        if (rec.endedAt < first) first = rec.endedAt;
      }
    }
    return { ...buildReport(c, "table", new Date(Number.isFinite(first) ? first : this.o.now()).toISOString()), luck: this.luckReport(history) };
  }

  /** Whatever luck numbers are ready now (never computes); hands not done yet are queued and counted in `pending`. */
  private luckReport(history: readonly HandRecord[]): LuckReport {
    for (const rec of history) this.luck.enqueue(rec);
    return buildLuckReport(history, {}, true);
  }

  private markDirty(): void {
    if (this.o.dir === null || this.timer !== null) return;
    this.timer = this.o.scheduler.setTimeout(() => {
      this.timer = null;
      this.enqueue();
    }, this.o.debounceMs ?? DEBOUNCE_MS);
  }

  private enqueue(): void {
    let body: string;
    try {
      const seen: Record<string, number[]> = {};
      for (const [id, set] of this.seen) {
        const flat: number[] = [];
        for (const k of set) {
          const [n, t] = k.split("@");
          flat.push(Number(n), Number(t));
        }
        seen[id] = flat;
      }
      body = JSON.stringify({ version: FILE_VERSION, since: this.since, counts: this.counts, seen } satisfies AuditFile);
    } catch (e) {
      console.error("rng-audit snapshot failed", e);
      return;
    }
    this.chain = this.chain
      .then(async () => {
        await this.fs.mkdir(this.o.dir!, { recursive: true });
        const tmp = `${this.path}.tmp`;
        await this.fs.writeFile(tmp, body);
        await this.fs.rename(tmp, this.path);
      })
      .catch((e) => console.error("saving rng-audit.json failed", e));
  }

  /** Writes any pending change now and waits for writes to finish. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.o.scheduler.clearTimeout(this.timer);
      this.timer = null;
      this.enqueue();
    }
    await this.chain;
  }
}
