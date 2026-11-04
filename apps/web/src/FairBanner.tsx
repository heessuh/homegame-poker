import { useEffect, useRef, useState } from "react";
import type { TableView } from "@homegame/engine";
import { autoCheck, type AutoCheck } from "./fairness";
import { VERIFIER_URL } from "@homegame/engine";

/**
 * Background fairness watch: re-derives every finished hand this browser was dealt into and shows a persistent
 * banner for failures (until dismissed) and a small check mark for passes.
 */
export function FairWatch({ view }: { view: TableView }) {
  const done = useRef(new Set<string>());
  const [alerts, setAlerts] = useState<AutoCheck[]>([]);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const rec = view.lastHand;
  const me = view.you.playerId;
  const tableId = view.tableId;

  useEffect(() => {
    if (!rec) return;
    const key = `${tableId}|${rec.handNumber}`;
    if (done.current.has(key)) return;
    done.current.add(key);
    void autoCheck(rec, tableId, me).then((r) => {
      if (r.level === "skip") return;
      if (r.level === "ok") setLastOk(r.handNumber);
      else setAlerts((a) => [...a.filter((x) => x.handNumber !== r.handNumber), r].sort((x, y) => x.handNumber - y.handNumber));
    });
  }, [rec?.handNumber, tableId, me]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = (n: number) => setAlerts((a) => a.filter((x) => x.handNumber !== n));
  return (
    <>
      {alerts.length > 0 && (
        <div className="fairalerts" role="alert" aria-live="assertive">
          {alerts.map((a) => (
            <div key={a.handNumber} className={`fairalert ${a.level}`}>
              <div className="fa-head">
                <b>{a.level === "fail" ? "Hand #" + a.handNumber + " failed the fairness check" : "Hand #" + a.handNumber + ": check the shuffle"}</b>
                <button type="button" className="btn small" onClick={() => setOpen(open === a.handNumber ? null : a.handNumber)}>{open === a.handNumber ? "Hide details" : "Details"}</button>
                <button type="button" className="btn small" onClick={() => dismiss(a.handNumber)}>Dismiss</button>
              </div>
              {open === a.handNumber && (
                <div className="fa-body">
                  <ul>
                    {a.checks.filter((c) => c.ok === false).map((c, i) => <li key={i}><b>✗ {c.label}.</b> {c.detail}</li>)}
                  </ul>
                  <p>Don’t keep playing on trust: copy the fairness data from History and run it through <a href={VERIFIER_URL} target="_blank" rel="noreferrer">the independent verifier</a>.</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {lastOk !== null && alerts.length === 0 && (
        <span className="fairok" title={`Hand #${lastOk}: your browser re-derived the deck from the committed seed and it matches.`}>✓ Hand #{lastOk} verified</span>
      )}
    </>
  );
}
