/**
 * Dealer ledger: an append-only, hash-chained record of everything the host (dealer) does.
 *
 * Entry hash = SHA-256 (lowercase hex) of the UTF-8 bytes of canonicalJson(entry without `hash`).
 * Genesis prevHash = SHA-256 hex of the UTF-8 string "mochapoker-ledger-v1|" + tableId.
 *
 * Canonical JSON: no whitespace; object keys sorted ascending by UTF-16 code unit order (JavaScript's default
 * string sort), recursively; arrays keep their order; object members whose value is undefined are omitted;
 * strings use JSON.stringify escaping; numbers must be finite (the ledger only stores integers and plain
 * JSON values: strings, numbers, booleans, null, arrays, objects).
 */

export interface DealerEntry {
  /** 1-based position in the chain. */
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  hostId: string;
  hostName: string;
  /** Stable machine id: award, transfer, rebuy, takeChips, sitOut, remove, settings, variant, mode, start, pause, resume, ... */
  action: string;
  /** Plain English, names and money already formatted. */
  summary: string;
  /** Structured before/after values. Plain JSON. */
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export const LEDGER_GENESIS_PREFIX = "mochapoker-ledger-v1|";

export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",") + "]";
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

/** The exact string that is hashed for an entry (everything except `hash`). */
export function ledgerHashInput(e: Omit<DealerEntry, "hash">): string {
  const { seq, at, hostId, hostName, action, summary, details, prevHash } = e;
  return canonicalJson({ seq, at, hostId, hostName, action, summary, details, prevHash });
}

export function ledgerGenesisInput(tableId: string): string {
  return LEDGER_GENESIS_PREFIX + tableId;
}

export type Sha256Hex = (text: string) => Promise<string> | string;

export type LedgerVerdict = { ok: true; count: number } | { ok: false; brokenAt: number; reason: string };

/** Checks a complete ledger (starting at seq 1): sequence numbers, prevHash links, and every hash. */
export async function verifyLedger(entries: readonly DealerEntry[], tableId: string, sha256: Sha256Hex): Promise<LedgerVerdict> {
  let prev = await sha256(ledgerGenesisInput(tableId));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e || e.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: "sequence number out of order" };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: "does not follow the previous entry" };
    let h: string;
    try {
      h = await sha256(ledgerHashInput(e));
    } catch {
      return { ok: false, brokenAt: e.seq, reason: "entry is malformed" };
    }
    if (h !== e.hash) return { ok: false, brokenAt: e.seq, reason: "contents were changed" };
    prev = e.hash;
  }
  return { ok: true, count: entries.length };
}

export interface LedgerPin {
  seq: number;
  hash: string;
}

export interface LedgerViewCheck {
  /** Set when something is wrong: the chain is broken or history changed since this browser last looked. */
  problem: string | null;
  /** The pin is older than the tail we were given: fetch the full ledger and verify it (rate limit this). */
  needFull: boolean;
  /** Where to move the pin when there is no problem and no full check is needed; otherwise null. */
  newPin: LedgerPin | null;
}

/**
 * Cheap check run on every table update using only the view's {count, headHash, tail}:
 * the tail must chain and hash correctly and end at headHash; a stored pin must still be in the history.
 */
export async function checkLedgerView(
  dl: { count: number; headHash: string; tail: readonly DealerEntry[] },
  pin: LedgerPin | null,
  tableId: string,
  sha256: Sha256Hex,
): Promise<LedgerViewCheck> {
  const bad = (problem: string): LedgerViewCheck => ({ problem, needFull: false, newPin: null });
  const { count, headHash, tail } = dl;
  if (count === 0) {
    if (tail.length) return bad("The dealer log is inconsistent.");
    return pin && pin.seq > 0 ? bad(`This browser saw ${pin.seq} dealer log entries earlier, but the log is now empty.`) : { problem: null, needFull: false, newPin: null };
  }
  if (tail.length === 0) return bad("The dealer log is missing its latest entries.");
  const first = tail[0]!;
  const lastE = tail[tail.length - 1]!;
  if (lastE.seq !== count || lastE.hash !== headHash) return bad("The dealer log head does not match its entries.");
  let prev = first.seq === 1 ? await sha256(ledgerGenesisInput(tableId)) : first.prevHash;
  for (let i = 0; i < tail.length; i++) {
    const e = tail[i]!;
    if (e.seq !== first.seq + i) return bad(`Dealer log entry #${first.seq + i} is out of order.`);
    if (e.prevHash !== prev) return bad(`Chain broken at #${e.seq}: it does not follow the previous entry.`);
    let h: string;
    try {
      h = await sha256(ledgerHashInput(e));
    } catch {
      return bad(`Chain broken at #${e.seq}: entry is malformed.`);
    }
    if (h !== e.hash) return bad(`Chain broken at #${e.seq}: contents were changed.`);
    prev = e.hash;
  }
  if (pin && pin.seq > 0) {
    if (pin.seq > count) return bad(`This browser saw ${pin.seq} dealer log entries earlier, but the server now has only ${count}. Entries were removed.`);
    if (pin.seq >= first.seq) {
      if (tail[pin.seq - first.seq]!.hash !== pin.hash) return bad(`Dealer log entry #${pin.seq} is different from what this browser saw earlier. History was rewritten.`);
    } else {
      return { problem: null, needFull: true, newPin: null };
    }
  }
  return { problem: null, needFull: false, newPin: { seq: count, hash: headHash } };
}
