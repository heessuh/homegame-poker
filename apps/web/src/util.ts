import type { Card, TableView } from "@homegame/engine";

export const fmt = (n: number): string => n.toLocaleString("en-US");

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
