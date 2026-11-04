import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type TableConfig } from "@homegame/engine";
import type { Scheduler, TableSnapshot } from "./table.js";

/** The slice of node:fs/promises the store uses (injectable for tests). */
export interface FsLike {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string, enc: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
}

export const SNAPSHOT_VERSION = 1;
export const IDLE_DELETE_MS = 14 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 500;
const ID_RE = /^[a-z0-9-]{3,32}$/i;

export interface StoreOptions {
  dir: string;
  scheduler: Scheduler;
  now: () => number;
  fs?: FsLike;
  debounceMs?: number;
}

/** Debounced, atomic JSON snapshots of tables under <dir>/tables, plus <dir>/house-defaults.json. */
export class Store {
  private readonly dir: string;
  private readonly sched: Scheduler;
  private readonly now: () => number;
  private readonly fs: FsLike;
  private readonly debounceMs: number;
  private readonly pending = new Map<string, { handle: unknown; get: () => TableSnapshot | null }>();
  private readonly chains = new Map<string, Promise<void>>();
  private ready: Promise<unknown> | null = null;

  constructor(o: StoreOptions) {
    this.dir = o.dir;
    this.sched = o.scheduler;
    this.now = o.now;
    this.fs = o.fs ?? (nodeFs as unknown as FsLike);
    this.debounceMs = o.debounceMs ?? DEBOUNCE_MS;
  }

  private get tablesDir(): string {
    return join(this.dir, "tables");
  }

  private file(id: string): string {
    return join(this.tablesDir, `${id}.json`);
  }

  private ensureDir(): Promise<unknown> {
    return (this.ready ??= this.fs.mkdir(this.tablesDir, { recursive: true }).catch((e) => {
      this.ready = null;
      throw e;
    }));
  }

  /** Schedules a write ~500 ms out; further changes inside the window share that one write. */
  markDirty(id: string, get: () => TableSnapshot | null): void {
    const cur = this.pending.get(id);
    if (cur) {
      cur.get = get;
      return;
    }
    const entry = { handle: null as unknown, get };
    entry.handle = this.sched.setTimeout(() => {
      this.pending.delete(id);
      this.enqueue(id, entry.get);
    }, this.debounceMs);
    this.pending.set(id, entry);
  }

  private enqueue(id: string, get: () => TableSnapshot | null): void {
    let text: string | null = null;
    try {
      const snap = get();
      if (snap) text = JSON.stringify(snap);
    } catch (e) {
      console.error(`snapshot of ${id} failed`, e);
    }
    if (text === null) return;
    const body = text;
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.writeAtomic(id, body)).catch((e) => console.error(`saving table ${id} failed`, e));
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
  }

  private async writeAtomic(id: string, body: string): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.file(id)}.tmp`;
    await this.fs.writeFile(tmp, body);
    await this.fs.rename(tmp, this.file(id));
  }

  /** Writes every table with a pending change right now and waits for all writes to finish. */
  async flush(): Promise<void> {
    for (const [id, e] of [...this.pending]) {
      this.sched.clearTimeout(e.handle);
      this.pending.delete(id);
      this.enqueue(id, e.get);
    }
    await this.idle();
  }

  /** Resolves when no write is in flight. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Forgets a table's pending write and deletes its file. */
  async remove(id: string): Promise<void> {
    const e = this.pending.get(id);
    if (e) {
      this.sched.clearTimeout(e.handle);
      this.pending.delete(id);
    }
    await (this.chains.get(id) ?? Promise.resolve());
    try {
      await this.fs.unlink(this.file(id));
    } catch {
      // already gone
    }
  }

  /**
   * Reads every snapshot. Unreadable or incompatible files are renamed to *.bad (with a warning);
   * snapshots untouched for more than 14 days are deleted.
   */
  async loadAll(): Promise<TableSnapshot[]> {
    let names: string[];
    try {
      names = await this.fs.readdir(this.tablesDir);
    } catch {
      return [];
    }
    const out: TableSnapshot[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const path = join(this.tablesDir, name);
      try {
        const snap = JSON.parse(await this.fs.readFile(path, "utf8")) as TableSnapshot;
        if (!snap || typeof snap !== "object" || snap.version !== SNAPSHOT_VERSION || snap.tableId !== id || !ID_RE.test(id)
          || !Array.isArray(snap.players) || !snap.config) {
          throw new Error("unsupported snapshot");
        }
        if (this.now() - snap.savedAt > IDLE_DELETE_MS) {
          await this.fs.unlink(path).catch(() => undefined);
          console.warn(`Deleted idle table snapshot ${name}`);
          continue;
        }
        out.push(snap);
      } catch (e) {
        console.warn(`Skipping unreadable table snapshot ${name}:`, e instanceof Error ? e.message : e);
        await this.fs.rename(path, `${path}.bad`).catch(() => undefined);
      }
    }
    return out;
  }

  async loadDefaults(): Promise<Partial<TableConfig> | undefined> {
    try {
      const v = JSON.parse(await this.fs.readFile(join(this.dir, "house-defaults.json"), "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Partial<TableConfig>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("Ignoring unreadable house-defaults.json");
    }
    return undefined;
  }

  async saveDefaults(config: TableConfig): Promise<void> {
    await this.ensureDir();
    const path = join(this.dir, "house-defaults.json");
    const tmp = `${path}.tmp`;
    await this.fs.writeFile(tmp, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2));
    await this.fs.rename(tmp, path);
  }
}
