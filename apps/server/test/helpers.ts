import { DEFAULT_HOUSE_LIMIT, freshDeck, type Card, type TableConfig } from "@homegame/engine";
import { Table, type Scheduler } from "../src/table.js";

/** The pre-cents defaults most tests were written against: 1/2 blinds, 40-400 buy-ins, plain chips, no house limit. */
export const LEGACY: Partial<TableConfig> = {
  smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 400, money: "chips", awardMode: "auto", houseLimit: { ...DEFAULT_HOUSE_LIMIT, enabled: false },
};

export class FakeClock implements Scheduler {
  t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { due: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].due <= target && (!next || e[1].due < next[1].due)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].due);
      next[1].fn();
    }
    this.t = target;
  }
}

export interface Rig {
  clock: FakeClock;
  table: Table;
  ids: string[];
}

/** Table with n players joined (tokens token-0.., names P0..), none seated. */
export function rig(n: number, config: Partial<TableConfig> = {}, deck: () => Card[] = () => freshDeck()): Rig {
  const clock = new FakeClock();
  const table = new Table({
    tableId: "test-table",
    now: clock.now,
    scheduler: clock,
    deckSource: deck,
    onChange: () => undefined,
    config: { ...LEGACY, ...config },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(table.join(`token-${i}`, `P${i}`));
  return { clock, table, ids };
}

export function seatAll(r: Rig, seats?: number[], buyIn = 100): void {
  r.ids.forEach((id, i) => r.table.sit(id, seats?.[i] ?? i, buyIn));
}

/** Player id whose turn it is, or null. */
export function actor(r: Rig): string | null {
  const v = r.table.viewFor(r.ids[0]!);
  if (!v.hand || v.hand.winners || v.hand.toActSeat === null) return null;
  const s = v.seats[v.hand.toActSeat];
  return s ? s.playerId : null;
}

/** Everyone checks/calls until the hand is over. */
export function checkDown(r: Rig): void {
  for (let i = 0; i < 200; i++) {
    const id = actor(r);
    if (!id) return;
    const legal = r.table.viewFor(id).hand!.legal!;
    r.table.action(id, legal.canCheck ? { type: "check" } : { type: "call" });
  }
  throw new Error("hand did not finish");
}

/** The player to act folds until the hand is over. */
export function foldAround(r: Rig): void {
  for (let i = 0; i < 200; i++) {
    const id = actor(r);
    if (!id) return;
    r.table.action(id, { type: "fold" });
  }
  throw new Error("hand did not finish");
}
