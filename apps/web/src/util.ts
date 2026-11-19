import { VARIANTS, bestHigh, bestLow8, bestLowAny, holeRule, splitOf } from "@homegame/engine";
import type { Card, Phase, TableConfig, TableView, WinnerView } from "@homegame/engine";

// ---- Money ----
// Cash games store chips as cents. When config.money is "cents" (and it is not a tournament) amounts show as dollars.
let dollarMode = false;
export function setMoneyMode(config: Pick<TableConfig, "money" | "mode"> | null | undefined): void {
  dollarMode = !!config && config.money === "cents" && config.mode !== "tournament";
}
export const isDollars = (): boolean => dollarMode;

/** Format an amount. Dollars mode always shows cents: "$40.00", "$0.20", "$1,250.00". Chips mode: "1,250". */
export function fmtWith(n: number, dollars: boolean, _keepCents = false): string { // eslint-disable-line @typescript-eslint/no-unused-vars
  if (!dollars) return Math.round(n).toLocaleString("en-US");
  const neg = n < 0;
  const c = Math.abs(Math.round(n));
  const d = Math.floor(c / 100);
  const r = c % 100;
  const body = "$" + d.toLocaleString("en-US") + "." + String(r).padStart(2, "0");
  return neg ? "-" + body : body;
}
export const fmt = (n: number): string => fmtWith(n, dollarMode);
/** Same as fmt (cents are always shown); kept for bet and call buttons. */
export const fmtBet = (n: number): string => fmtWith(n, dollarMode, true);

/** Parse typed text to integer chips. Dollars mode accepts "1.25", "$3", ".5"; chips mode whole numbers. Null = invalid. */
export function parseMoney(text: string, dollars: boolean): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return null;
  if (dollars) {
    if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
    return Math.round(parseFloat(t) * 100);
  }
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}
/** Integer chips to the text shown in an input. */
export function moneyText(n: number, dollars: boolean): string {
  if (!dollars) return String(n);
  return (n / 100).toFixed(2);
}


export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable (needs HTTPS or localhost)");
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(len = 6): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function storeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storeSet(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}
export function getPlayerToken(): string {
  let t = storeGet("hg.token");
  if (!t) {
    t = crypto.randomUUID();
    storeSet("hg.token", t);
  }
  return t;
}

export const cardsOf = (s: string): Card[] => s.split(" ").filter(Boolean) as Card[];

export function totalPot(view: TableView): number {
  const h = view.hand;
  if (!h) return 0;
  return h.pots.reduce((a, p) => a + p.amount, 0) + view.seats.reduce((a, s) => a + (s?.bet ?? 0), 0);
}

/** Stud games (5-Murder). Defensive: works before the engine build knows the variant. */
/**
 * Rabbit hunt: the board cards that never came because the hand ended early. The deck is revealed to everyone when a
 * hand ends, so this shows nothing the hand record does not already hold. Same deal layout as the engine's luck report.
 */
export function rabbitCards(rec: TableView["lastHand"]): Card[] {
  if (!rec) return [];
  const v = VARIANTS[rec.variant];
  const order = rec.luck?.dealOrder;
  const deck = rec.reveal?.deck;
  if (!v || v.kind === "stud" || v.scoring === "points" || rec.luck?.v !== 1 || !Array.isArray(order) || !Array.isArray(deck)) return [];
  const p = order.length * v.holeCards;
  if (deck.length < p + 8) return [];
  const full = [deck[p + 1]!, deck[p + 2]!, deck[p + 3]!, deck[p + 5]!, deck[p + 7]!];
  const dealt = rec.board ?? [];
  if (dealt.length >= 5 || dealt.some((c, i) => c !== full[i])) return []; // any mismatch: show nothing rather than guess
  return full.slice(dealt.length);
}

/** Plain-language rules for the table, shown before anyone sits down. */
export function rulesLines(config: TableConfig, dollars: boolean): string[] {
  const m = (n: number) => fmtWith(n, dollars);
  const out: string[] = [];
  if (isStud(config)) {
    out.push(`Ante ${m(config.stud.ante)}; bets up to ${m(config.stud.maxBet)}, last round ${m(config.stud.maxBetLastRound)}; up to ${config.stud.maxRaises} raises a round.`);
  } else {
    out.push(`Blinds ${m(config.smallBlind)}/${m(config.bigBlind)}.`);
    const hl = config.houseLimit;
    if (config.mode === "cash" && hl.enabled) {
      out.push(`House limit: each bet or raise ${m(hl.minBet)} to ${m(hl.maxBet)}${hl.raiseMustExceed ? ", and each raise at least the last one" : ""}; at most ${hl.maxRaises} raises a round.`);
    } else out.push(config.mode === "tournament" ? "Tournament: pot-limit or no-limit by game." : "No house limit: standard betting for this game.");
  }
  if (config.mode === "cash") out.push(`Buy-in ${m(config.minBuyIn)} to ${m(config.maxBuyIn)}.`);
  out.push(config.awardMode === "auto" ? "Pots are paid out automatically." : "The dealer awards each pot by hand; every change from the suggested payout needs a reason.");
  out.push("After each hand the shuffle is published, so players can check it. That includes the cards of players who folded.");
  return out;
}

export function isStud(config: Pick<TableConfig, "variant">): boolean {
  const v = VARIANTS[config.variant] as { kind?: string } | undefined;
  return v?.kind === "stud" || (config.variant as string) === "murder5";
}

/**
 * Game name as shown to players. In a cash game with the house limit on, "No-Limit" or "Pot-Limit" would be wrong,
 * so the label shows the limit instead. In tournaments (and cash with the house limit off) Hold'em reads "No-Limit".
 */
export function gameLabel(v: { name: string; openName?: string; kind?: string }, config: Pick<TableConfig, "mode" | "money" | "houseLimit">): string {
  if (v.kind === "stud") return v.name;
  if (config.mode !== "cash" || !config.houseLimit?.enabled) return v.openName ?? v.name;
  return `${v.name.replace(/(No-Limit|Pot-Limit) /, "")} · ${fmtWith(config.houseLimit.maxBet, config.money === "cents").replace(/\.00$/, "")} limit`;
}

export const STUD_STREETS: Partial<Record<Phase, string>> = {
  "2nd": "2nd card", "3rd": "3rd card", "4th": "4th card", "5th": "5th card",
  draw1: "Exchange 1", draw2: "Exchange 2", declare: "Declare",
};

/** "Pot-Limit Omaha Hi/Lo (8 or better)" -> "Pot-Limit Omaha Hi/Lo". */
export function shortGame(name: string): string {
  return name.replace(/\s*\(.*?\)/g, "").trim();
}

// ---- Showdown display ----
/** One shown hand at showdown: its rank label(s) and, for a winner, the cards that made the winning hand. */
export interface ShownHand { labels: string[]; used: Set<Card> | null }
export interface ShowdownInfo { board: Set<Card>; seats: Map<string, ShownHand> }

/**
 * What the table shows when a board game reaches showdown: a rank under every shown hand, and the cards that made
 * each winning hand (raised; the rest fade). Display only: the server alone decides who wins. The winner's cards
 * are matched by the hand name the server sent, so the cards shown are always the ones that hand was named for.
 * Null when there is nothing to show (no showdown, a fold win, stud or points games).
 */
export function showdownInfo(view: TableView, winners: WinnerView[]): ShowdownInfo | null {
  const hand = view.hand;
  const v = VARIANTS[view.config.variant];
  if (!hand || !v || v.kind === "stud" || v.scoring === "points") return null;
  if (!winners.some((w) => w.handName)) return null;
  const board = hand.board;
  if (board.length < 3) return null;
  const rule = holeRule(v);
  const mode = splitOf(v);
  const lowFn = v.lowRule === "any" ? bestLowAny : bestLow8;
  const seats = new Map<string, ShownHand>();
  const usedBoard = new Set<Card>();
  for (const s of view.seats) {
    if (!s || !s.inHand || s.folded || !s.holeCards || s.holeCards.length === 0) continue;
    let high: { name: string; cards: Card[] } | null = null;
    let low: { name: string; cards: Card[] } | null = null;
    try {
      high = bestHigh(s.holeCards, board, rule);
      if (mode !== "high") low = lowFn(s.holeCards, board, rule);
    } catch {
      continue; // not enough cards for a five-card hand
    }
    const mine = winners.filter((w) => w.playerId === s.playerId && w.handName);
    let used: Set<Card> | null = null;
    for (const w of mine) {
      const name = w.handName!.toLowerCase();
      const pick = low && name === low.name.toLowerCase() ? low : high && name === high.name.toLowerCase() ? high : null;
      if (!pick) continue;
      used ??= new Set<Card>();
      for (const c of pick.cards) {
        used.add(c);
        if (board.includes(c)) usedBoard.add(c);
      }
    }
    const labels: string[] = [];
    if (mode !== "low" && high) labels.push(high.name);
    if (mode !== "high") labels.push(low ? `${mode === "hilo" ? "Low " : ""}${low.name}` : mode === "hilo" ? "No low" : "No qualifying low");
    seats.set(s.playerId, { labels, used });
  }
  // If no winning hand could be matched, fade nothing rather than fade the whole board.
  if (![...seats.values()].some((x) => x.used)) for (const c of board) usedBoard.add(c);
  return { board: usedBoard, seats };
}

// ---- Your hand, in words ----
/**
 * Your own best hand as the board comes, e.g. "Two Pair, Kings and Nines" (hi/lo games add the low, e.g.
 * "Low 8-6-4-2-A"). Board games only, from the flop on; null for stud, points games or too few cards.
 * Display only: it uses the same evaluator the server uses at showdown.
 */
export function liveHandLabel(variant: TableConfig["variant"], hole: Card[] | null, board: Card[]): string | null {
  const v = VARIANTS[variant];
  if (!v || v.kind === "stud" || v.scoring === "points" || !hole || hole.length === 0 || board.length < 3) return null;
  const rule = holeRule(v);
  const mode = splitOf(v);
  const lowFn = v.lowRule === "any" ? bestLowAny : bestLow8;
  try {
    const parts: string[] = [];
    if (mode !== "low") parts.push(bestHigh(hole, board, rule).name);
    if (mode !== "high") {
      const low = lowFn(hole, board, rule);
      if (low) parts.push(`Low ${low.name}`);
      else if (mode === "low") parts.push("No low yet");
    }
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}

// ---- Settle up ----
export interface Payment { from: string; to: string; amount: number }

/**
 * Who pays whom at the end of the night, from each player's net (stack + cash-outs - buy-ins).
 * Biggest loser pays biggest winner first, which keeps the number of payments small (at most players - 1).
 * `off` is what does not balance (chips still in a pot, for example); 0 when everything adds up.
 */
export function settleUp(nets: { name: string; net: number }[]): { payments: Payment[]; off: number } {
  const off = nets.reduce((a, e) => a + e.net, 0);
  const win = nets.filter((e) => e.net > 0).map((e) => ({ name: e.name, left: e.net })).sort((a, b) => b.left - a.left);
  const lose = nets.filter((e) => e.net < 0).map((e) => ({ name: e.name, left: -e.net })).sort((a, b) => b.left - a.left);
  const payments: Payment[] = [];
  let i = 0;
  let j = 0;
  while (i < lose.length && j < win.length) {
    const amt = Math.min(lose[i]!.left, win[j]!.left);
    if (amt > 0) payments.push({ from: lose[i]!.name, to: win[j]!.name, amount: amt });
    lose[i]!.left -= amt;
    win[j]!.left -= amt;
    if (lose[i]!.left === 0) i++;
    if (win[j]!.left === 0) j++;
  }
  return { payments, off };
}
