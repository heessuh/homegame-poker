import {
  handLuckGen, peekHandLuck, reviewHand, reviewMatches, setHandLuckBad,
  type HandRecord, type ReviewFilter, type SessionReview,
} from "@homegame/engine";

/** The server is single-threaded: no luck work may hold the event loop longer than about this many milliseconds. */
export const SLICE_MS = 5;
export const REVIEW_PAGE_SIZE = 10;

const now = (): number => performance.now();
const nextTurn = (): Promise<void> => new Promise((res) => setImmediate(res));

/** Works out HandLuck for hand records in the background, a few milliseconds at a time, between other events. */
export class LuckQueue {
  private readonly queue: HandRecord[] = [];
  private readonly queued = new WeakSet<object>();
  private current: { rec: HandRecord; gen: ReturnType<typeof handLuckGen> } | null = null;
  private scheduled = false;
  private waiters: Array<() => void> = [];
  /** Longest single slice of work so far (ms), for tests and diagnostics. */
  maxSliceMs = 0;

  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  enqueue(rec: HandRecord): void {
    if (peekHandLuck(rec) !== undefined || this.queued.has(rec)) return;
    this.queued.add(rec);
    this.queue.push(rec);
    this.schedule();
  }

  /** Resolves when the queue is empty. */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.tick());
  }

  private tick(): void {
    this.scheduled = false;
    const t0 = now();
    while (now() - t0 < SLICE_MS) {
      if (!this.current) {
        const rec = this.queue.shift();
        if (!rec) break;
        this.current = { rec, gen: handLuckGen(rec) };
      }
      const cur = this.current;
      try {
        if (cur.gen.next().done) this.current = null;
      } catch (e) {
        console.error("luck precompute failed", e);
        setHandLuckBad(cur.rec);
        this.current = null;
      }
    }
    this.maxSliceMs = Math.max(this.maxSliceMs, now() - t0);
    if (this.pending > 0) this.schedule();
    else {
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }
}

/** One page of the session review, newest hand first. Filtering scans the history in short slices so the server stays responsive. */
export async function buildSessionReview(history: readonly HandRecord[], filter: ReviewFilter, page: number): Promise<SessionReview> {
  const newest = [...history].reverse();
  let t0 = now();
  const tick = async (): Promise<void> => {
    if (now() - t0 > SLICE_MS) {
      await nextTurn();
      t0 = now();
    }
  };
  let matches = newest;
  if (filter !== "all") {
    matches = [];
    for (const rec of newest) {
      if (reviewMatches(reviewHand(rec), filter)) matches.push(rec);
      await tick();
    }
  }
  const pages = Math.max(1, Math.ceil(matches.length / REVIEW_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const hands = [];
  for (const rec of matches.slice(p * REVIEW_PAGE_SIZE, (p + 1) * REVIEW_PAGE_SIZE)) {
    hands.push(reviewHand(rec));
    await tick();
  }
  return { filter, page: p, pageSize: REVIEW_PAGE_SIZE, total: matches.length, totalHands: history.length, hands };
}
