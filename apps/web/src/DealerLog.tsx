import { useEffect, useRef, useState } from "react";
import { verifyLedger } from "@homegame/engine";
import type { DealerEntry, TableView } from "@homegame/engine";
import type { Send } from "./App";
import { sha256Hex } from "./util";

type Check = { state: "checking" } | { state: "ok"; count: number } | { state: "broken"; at: number; reason: string } | { state: "unavailable"; reason: string };
type Pin = { seq: number; hash: string };

const pinKey = (tableId: string) => `mochapoker-ledger-head:${tableId}`;
function readPin(tableId: string): Pin | null {
  try {
    const raw = localStorage.getItem(pinKey(tableId));
    const p = raw ? (JSON.parse(raw) as Pin) : null;
    return p && Number.isInteger(p.seq) && typeof p.hash === "string" ? p : null;
  } catch {
    return null;
  }
}
function writePin(tableId: string, p: Pin): void {
  try {
    localStorage.setItem(pinKey(tableId), JSON.stringify(p));
  } catch {
    /* private mode or blocked storage: the check just has nothing to compare next time */
  }
}

/** Compares what this browser saw last time with the ledger the server serves now. Returns a warning or null. */
export function pinWarning(pin: Pin | null, entries: readonly DealerEntry[]): string | null {
  if (!pin) return null;
  if (pin.seq > entries.length) return `This browser saw ${pin.seq} entries earlier, but the server now has only ${entries.length}. Entries were removed.`;
  if (pin.seq >= 1 && entries[pin.seq - 1]!.hash !== pin.hash) return `Entry #${pin.seq} is different from what this browser saw earlier. History was rewritten.`;
  return null;
}

/** Plain-text rendering used by the session download. */
export function ledgerText(entries: readonly DealerEntry[]): string {
  if (entries.length === 0) return "(no dealer actions)";
  return entries.map((e) => `#${e.seq} ${new Date(e.at).toISOString()} ${e.hostName}: ${e.summary}`).join("\n");
}

export function fetchDealerLog(send: Send): Promise<DealerEntry[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 5000);
    send("getDealerLog", (entries) => {
      clearTimeout(timer);
      resolve(entries);
    });
  });
}

export function saveFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function when(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The “Dealer log” tab: every host action, newest first, with a browser-side check of the hash chain. */
export function DealerLog({ view, send }: { view: TableView; send: Send }) {
  const { count, headHash, tail } = view.dealerLog;
  const [full, setFull] = useState<DealerEntry[] | null>(null);
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const [pinWarn, setPinWarn] = useState<string | null>(null);
  const want = useRef(0);

  useEffect(() => {
    const id = ++want.current;
    setCheck({ state: "checking" });
    void (async () => {
      const entries = await fetchDealerLog(send);
      if (id !== want.current) return;
      setFull(entries);
      try {
        const verdict = await verifyLedger(entries, view.tableId, sha256Hex);
        if (id !== want.current) return;
        const pin = readPin(view.tableId);
        const warn = pinWarning(pin, entries);
        setPinWarn(warn);
        if (!verdict.ok) {
          setCheck({ state: "broken", at: verdict.brokenAt, reason: verdict.reason });
        } else {
          setCheck({ state: "ok", count: verdict.count });
          if (!warn && entries.length > 0 && (!pin || entries.length >= pin.seq)) {
            writePin(view.tableId, { seq: entries.length, hash: entries[entries.length - 1]!.hash });
          }
        }
      } catch (e) {
        if (id === want.current) setCheck({ state: "unavailable", reason: e instanceof Error ? e.message : "could not verify" });
      }
    })();
  }, [count, headHash, view.tableId, send]);

  const shown = [...(full ?? tail)].reverse();
  const download = () => {
    const doc = {
      tableId: view.tableId,
      exportedAt: new Date().toISOString(),
      how: "Each entry hash is the SHA-256 of its canonical JSON (keys sorted, no spaces) without the hash field. The first prevHash is the SHA-256 of the text mochapoker-ledger-v1| followed by the table id.",
      entries: full ?? tail,
    };
    saveFile(`mochapoker-${view.tableId}-dealer-log-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2) + "\n", "application/json");
  };

  return (
    <div>
      <div className="btn-row wrap logbtns">
        <button className="btn small" onClick={download}>Download</button>
      </div>
      {check.state === "checking" && <p className="muted small">Checking the chain…</p>}
      {check.state === "ok" && !pinWarn && <p className="ledger-ok">Chain intact ✓ ({check.count} {check.count === 1 ? "entry" : "entries"})</p>}
      {check.state === "broken" && <p className="ledger-bad" role="alert">Chain broken at #{check.at}: {check.reason}. The dealer log may have been tampered with.</p>}
      {check.state === "unavailable" && <p className="muted small">Could not check the chain here ({check.reason}).</p>}
      {pinWarn && <p className="ledger-bad" role="alert">Warning: {pinWarn}</p>}
      {shown.length === 0 ? <p className="muted">The dealer has not done anything yet.</p> : (
        <div className="log dealerlog">
          {shown.map((e) => (
            <div key={e.seq}>
              <span className="muted small">#{e.seq} · {when(e.at)} · {e.hostName}</span>
              <br />
              {e.summary}
              <details className="ledger-details">
                <summary className="muted small">Details</summary>
                <pre className="small">{JSON.stringify(e.details, null, 2)}</pre>
                <div className="muted small ledger-hash">hash {e.hash}</div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
