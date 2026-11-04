import type { Card } from "./cards.js";

export interface HighResult {
  score: number;
  name: string;
  cards: Card[];
}
export interface LowResult {
  score: number;
  name: string;
  cards: Card[];
}

const RANK_VALUE: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const SINGULAR: Record<number, string> = {
  2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight",
  9: "Nine", 10: "Ten", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace",
};
const PLURAL: Record<number, string> = {
  2: "Twos", 3: "Threes", 4: "Fours", 5: "Fives", 6: "Sixes", 7: "Sevens", 8: "Eights",
  9: "Nines", 10: "Tens", 11: "Jacks", 12: "Queens", 13: "Kings", 14: "Aces",
};
const LOW_LABEL: Record<number, string> = { 1: "A", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "T", 11: "J", 12: "Q", 13: "K" };

function rankOf(c: Card): number {
  return RANK_VALUE[c[0] as string] as number;
}

const CAT_SHIFT = 16 ** 5;

interface Eval5 {
  score: number;
  name: string;
}

function eval5Full(cards: Card[]): Eval5 {
  if (cards.length !== 5) throw new Error("evaluate5 needs exactly 5 cards");
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0]![1]);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) straightHigh = 5;
  }

  const pack = (cat: number, order: number[]): number => {
    let s = cat * CAT_SHIFT;
    order.forEach((r, i) => {
      s += r * 16 ** (4 - i);
    });
    return s;
  };

  if (straightHigh && flush) {
    return {
      score: pack(8, [straightHigh]),
      name: straightHigh === 14 ? "Royal Flush" : `Straight Flush, ${SINGULAR[straightHigh]} high`,
    };
  }
  const g0 = groups[0]!;
  const g1 = groups[1];
  const order = groups.map((g) => g[0]);
  if (g0[1] === 4) {
    return { score: pack(7, order), name: `Four of a Kind, ${PLURAL[g0[0]]}` };
  }
  if (g0[1] === 3 && g1 && g1[1] === 2) {
    return { score: pack(6, order), name: `Full House, ${PLURAL[g0[0]]} full of ${PLURAL[g1[0]]}` };
  }
  if (flush) {
    return { score: pack(5, ranks), name: `Flush, ${SINGULAR[ranks[0]!]} high` };
  }
  if (straightHigh) {
    return { score: pack(4, [straightHigh]), name: `Straight, ${SINGULAR[straightHigh]} high` };
  }
  if (g0[1] === 3) {
    return { score: pack(3, order), name: `Three of a Kind, ${PLURAL[g0[0]]}` };
  }
  if (g0[1] === 2 && g1 && g1[1] === 2) {
    return { score: pack(2, order), name: `Two Pair, ${PLURAL[g0[0]]} and ${PLURAL[g1[0]]}` };
  }
  if (g0[1] === 2) {
    return { score: pack(1, order), name: `Pair of ${PLURAL[g0[0]]}` };
  }
  return { score: pack(0, ranks), name: `High Card, ${SINGULAR[ranks[0]!]}` };
}

/** High score of exactly 5 cards. Higher is better. */
export function evaluate5(cards: Card[]): number {
  return eval5Full(cards).score;
}

function combos<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const cur: T[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - cur.length); i++) {
      cur.push(items[i] as T);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

/** All 5-card candidate hands under the Hold'em or Omaha rule. */
function candidates(hole: Card[], board: Card[], mustUseTwoHole: boolean): Card[][] {
  if (mustUseTwoHole) {
    if (hole.length < 2 || board.length < 3) return [];
    const res: Card[][] = [];
    const bc = combos(board, 3);
    for (const h of combos(hole, 2)) for (const b of bc) res.push([...h, ...b]);
    return res;
  }
  const all = [...hole, ...board];
  if (all.length < 5) return [];
  return combos(all, 5);
}

export function bestHigh(hole: Card[], board: Card[], mustUseTwoHole: boolean): HighResult {
  let best: (Eval5 & { cards: Card[] }) | null = null;
  for (const c of candidates(hole, board, mustUseTwoHole)) {
    const e = eval5Full(c);
    if (!best || e.score > best.score) best = { ...e, cards: c };
  }
  if (!best) throw new Error("not enough cards to make a five-card hand");
  return { score: best.score, name: best.name, cards: best.cards };
}

/**
 * Ace-to-five low with no qualifier: aces are low, straights and flushes don't count,
 * pairs do (any no-pair hand beats any pair). LOWER score wins. Null only without five cards.
 */
export function bestLowAny(hole: Card[], board: Card[], mustUseTwoHole: boolean): LowResult | null {
  let best: LowResult | null = null;
  for (const c of candidates(hole, board, mustUseTwoHole)) {
    const lows = c.map((x) => {
      const r = rankOf(x);
      return r === 14 ? 1 : r;
    });
    const counts = new Map<number, number>();
    for (const r of lows) counts.set(r, (counts.get(r) ?? 0) + 1);
    // Bigger groups first (they decide how bad the hand is), then higher ranks first.
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const shape = groups.map((g) => g[1]).join("");
    const category = ["11111", "2111", "221", "311", "32", "41"].indexOf(shape);
    let score = category * 16 ** 5;
    groups.forEach(([r], i) => {
      score += r * 16 ** (4 - i);
    });
    if (!best || score < best.score) {
      const sorted = [...lows].sort((a, b) => b - a);
      best = { score, name: sorted.map((r) => LOW_LABEL[r]).join("-"), cards: c };
    }
  }
  return best;
}

export function bestLow8(hole: Card[], board: Card[], mustUseTwoHole: boolean): LowResult | null {
  let best: LowResult | null = null;
  for (const c of candidates(hole, board, mustUseTwoHole)) {
    const lows = c.map((x) => {
      const r = rankOf(x);
      return r === 14 ? 1 : r;
    });
    if (lows.some((r) => r > 8)) continue;
    if (new Set(lows).size !== 5) continue;
    const sorted = [...lows].sort((a, b) => b - a);
    let score = 0;
    sorted.forEach((r, i) => {
      score += r * 16 ** (4 - i);
    });
    if (!best || score < best.score) {
      best = { score, name: sorted.map((r) => LOW_LABEL[r]).join("-"), cards: c };
    }
  }
  return best;
}
