import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkLedgerView, ledgerGenesisInput, ledgerHashInput, type DealerEntry } from "../src/ledger.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function chain(n: number, tableId = "t"): DealerEntry[] {
  const out: DealerEntry[] = [];
  let prev = sha(ledgerGenesisInput(tableId));
  for (let i = 1; i <= n; i++) {
    const b = { seq: i, at: 1000 + i, hostId: "h", hostName: "Ana", action: "settings", summary: `s${i}`, details: { i }, prevHash: prev };
    const e = { ...b, hash: sha(ledgerHashInput(b)) };
    out.push(e);
    prev = e.hash;
  }
  return out;
}
const view = (all: DealerEntry[], tail = 5) => ({ count: all.length, headHash: all.at(-1)?.hash ?? "", tail: all.slice(-tail) });

describe("checkLedgerView", () => {
  it("accepts a good tail and advances the pin", async () => {
    const all = chain(12);
    const r = await checkLedgerView(view(all), { seq: 10, hash: all[9]!.hash }, "t", sha);
    expect(r).toEqual({ problem: null, needFull: false, newPin: { seq: 12, hash: all[11]!.hash } });
    expect((await checkLedgerView(view(chain(3), 10), null, "t", sha)).problem).toBeNull();
    expect((await checkLedgerView({ count: 0, headHash: "", tail: [] }, null, "t", sha)).problem).toBeNull();
  });
  it("flags a pin that now points at a different entry, or beyond the end", async () => {
    const all = chain(12);
    expect((await checkLedgerView(view(all), { seq: 10, hash: "00" }, "t", sha)).problem).toMatch(/rewritten/);
    expect((await checkLedgerView(view(all), { seq: 20, hash: "00" }, "t", sha)).problem).toMatch(/removed/);
    expect((await checkLedgerView({ count: 0, headHash: "", tail: [] }, { seq: 2, hash: "x" }, "t", sha)).problem).toMatch(/empty/);
  });
  it("asks for a full check when the pin is older than the tail", async () => {
    const all = chain(30);
    const r = await checkLedgerView(view(all), { seq: 3, hash: all[2]!.hash }, "t", sha);
    expect(r).toEqual({ problem: null, needFull: true, newPin: null });
  });
  it("flags tampering inside the tail", async () => {
    const all = chain(12);
    const edited = chain(12);
    edited[10]!.summary = "changed";
    expect((await checkLedgerView(view(edited), null, "t", sha)).problem).toMatch(/#11/);
    const relinked = chain(12);
    relinked[9]!.prevHash = "ff";
    expect((await checkLedgerView(view(relinked), null, "t", sha)).problem).toMatch(/Chain broken/);
    const v = view(all);
    expect((await checkLedgerView({ ...v, headHash: "ab" }, null, "t", sha)).problem).toMatch(/head/);
    expect((await checkLedgerView({ ...v, tail: [] }, null, "t", sha)).problem).toMatch(/missing/);
    // A tail that starts at entry 1 must also start at the genesis hash.
    expect((await checkLedgerView(view(chain(4), 10), null, "other", sha)).problem).toMatch(/#1/);
  });
});
