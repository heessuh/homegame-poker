import { describe, expect, it } from "vitest";
import { freshDeck, shuffle, type Card, type HandRecord } from "@homegame/engine";
import { RngAudit } from "../src/rngAudit.js";
import { buildSessionReview } from "../src/luckWork.js";
import { realScheduler } from "../src/table.js";

const IDS = ["a", "b", "c", "d", "e", "f"];

function rec(n: number, over: Partial<HandRecord> = {}): HandRecord {
  const deck = shuffle();
  const p = IDS.length * 2;
  return {
    handNumber: n, variant: "nlhe", deckHash: `h${n}`, reveal: { deck, salt: "s" }, board: [deck[p + 1]!, deck[p + 2]!, deck[p + 3]!, deck[p + 5]!, deck[p + 7]!],
    winners: [{ playerId: "a", amount: 100, potIndex: 0, half: "whole", handName: null }], summary: [], shown: {},
    names: Object.fromEntries(IDS.map((i) => [i, i.toUpperCase()])), endedAt: 1_000 + n,
    luck: { v: 1, dealOrder: IDS, foldStreet: {} },
    ...over,
  } as HandRecord;
}

function audit(): RngAudit {
  return new RngAudit({ dir: null, scheduler: realScheduler, now: () => 5_000 });
}

describe("luck background work", () => {
  it("returns promptly with many unprocessed hands, then fills in", async () => {
    const a = audit();
    const hist = Array.from({ length: 800 }, (_, i) => rec(i + 1));
    for (const r of hist) a.record("t", r);
    const t0 = performance.now();
    const early = a.tableReport(hist);
    const ms = performance.now() - t0;
    expect(early.luck!.pending).toBeGreaterThan(700); // nothing has run yet
    expect(early.luck!.hands + early.luck!.pending).toBe(800);
    // The existing deck audit is in the same call; allow a generous bound for slow machines.
    expect(ms).toBeLessThan(1500);
    await a.luck.idle();
    const done = a.tableReport(hist);
    expect(done.luck!.pending).toBe(0);
    expect(done.luck!.hands).toBe(800);
    expect(a.luck.maxSliceMs).toBeLessThan(20);
  }, 60_000);

  it("does not compute luck inside the report call itself", () => {
    const a = audit();
    const hist = Array.from({ length: 300 }, (_, i) => rec(i + 1));
    const rep = a.tableReport(hist);
    expect(rep.luck!.hands).toBe(0);
    expect(rep.luck!.pending).toBe(300);
  });
});

describe("session review", () => {
  const deckFor = (hole: Record<string, string>, board: string): Card[] => {
    const per = IDS.map((id) => (hole[id] ?? "").split(" ").filter(Boolean) as Card[]);
    const used = new Set<string>([...per.flat(), ...board.split(" ")]);
    const fill = freshDeck().filter((c) => !used.has(c));
    for (const h of per) while (h.length < 2) { const c = fill.shift()!; h.push(c); used.add(c); }
    const b = board.split(" ") as Card[];
    const rest = freshDeck().filter((c) => !used.has(c));
    const deck: Card[] = [];
    for (let r = 0; r < 2; r++) for (const h of per) deck.push(h[r]!);
    deck.push(rest.pop()!, b[0]!, b[1]!, b[2]!, rest.pop()!, b[3]!, rest.pop()!, b[4]!);
    return [...deck, ...rest];
  };

  // a holds the best hand (aces); c has kings.
  const holders = { a: "Ah Ad", b: "7c 2d", c: "Kh Kd" };
  const board = "2c 5d 9h Js 3s";
  const boardCards = board.split(" ") as Card[];

  it("lists hole cards and how far each player went, newest first", async () => {
    const deck = deckFor(holders, board);
    const hist: HandRecord[] = [
      rec(1),
      rec(2, {
        reveal: { deck, salt: "s" }, board: boardCards,
        luck: { v: 1, dealOrder: IDS, foldStreet: { a: "flop", b: "preflop", d: "turn", e: "river", f: "preflop" } },
        winners: [{ playerId: "c", amount: 300, potIndex: 0, half: "whole", handName: null }], shown: { c: ["Kh", "Kd"] },
      }),
    ];
    const r = await buildSessionReview(hist, "all", 0);
    expect(r.totalHands).toBe(2);
    expect(r.hands[0]!.handNumber).toBe(2);
    const h = r.hands[0]!;
    if (!h.available) throw new Error("expected available");
    const by = Object.fromEntries(h.players.map((p) => [p.playerId, p]));
    expect(by.a!.hole).toEqual(["Ah", "Ad"]);
    expect(by.a).toMatchObject({ outcome: "folded", foldStreet: "flop", best: true, won: 0 });
    expect(by.b).toMatchObject({ outcome: "folded", foldStreet: "preflop", best: false });
    expect(by.c).toMatchObject({ outcome: "showdown", foldStreet: null, won: 300, best: false });
    expect(by.e!.foldStreet).toBe("river");
    expect(h.foldedBest).toEqual(["a"]);
    expect(h.winnerNotBest).toBe(true);
  });

  it("filters hands where someone folded the best hand, and hands won without the best hand", async () => {
    const deck = deckFor(holders, board);
    const folded = rec(2, {
      reveal: { deck, salt: "s" }, board: boardCards, luck: { v: 1, dealOrder: IDS, foldStreet: { a: "turn" } },
      winners: [{ playerId: "c", amount: 300, potIndex: 0, half: "whole", handName: null }],
    });
    const bestWon = rec(3, {
      reveal: { deck, salt: "s" }, board: boardCards, luck: { v: 1, dealOrder: IDS, foldStreet: { b: "preflop" } },
      winners: [{ playerId: "a", amount: 300, potIndex: 0, half: "whole", handName: null }], shown: { a: ["Ah", "Ad"] },
    });
    const hist = [rec(1, { winners: [] }), folded, bestWon];
    const fb = await buildSessionReview(hist, "folded-best", 0);
    expect(fb.hands.map((h) => h.handNumber)).toEqual([2]);
    expect(fb.total).toBe(1);
    const wb = await buildSessionReview(hist, "won-without-best", 0);
    expect(wb.hands.map((h) => h.handNumber)).toEqual([2]);
    const all = await buildSessionReview(hist, "all", 0);
    expect(all.total).toBe(3);
  });

  it("says not available for stud and for old records, and paginates", async () => {
    const hist = [rec(1, { variant: "murder5" }), rec(2, { luck: undefined }), ...Array.from({ length: 25 }, (_, i) => rec(i + 3))];
    const p0 = await buildSessionReview(hist, "all", 0);
    expect(p0.hands).toHaveLength(10);
    expect(p0.total).toBe(27);
    const last = await buildSessionReview(hist, "all", 99);
    expect(last.page).toBe(2);
    expect(last.hands.map((h) => (h.available ? "ok" : h.reason))).toEqual(["ok", "ok", "ok", "ok", "ok", "old", "stud"]);
  });
});
