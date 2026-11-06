import { useEffect, useState } from "react";
import type { PendingAward, TableView } from "@homegame/engine";
import type { Send } from "./App";
import { MoneyInput, Who, avatarOf } from "./ui";
import { fmt } from "./util";

export function nameOf(view: TableView, id: string): string {
  return view.seats.find((s) => s?.playerId === id)?.name ?? view.ledger.find((l) => l.playerId === id)?.name ?? id;
}

const narrow = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 699px)").matches;

/** Host-only award panel. Prefilled with the suggested split; "Next hand" finalizes the payout and the server deals on. */
export function AwardPanel({ view, pa, send }: { view: TableView; pa: PendingAward; send: Send }) {
  const suggestedMap = () => {
    const m: Record<string, number> = {};
    for (const id of pa.candidatePlayerIds) m[id] = 0;
    for (const s of pa.suggested) m[s.playerId] = (m[s.playerId] || 0) + s.amount;
    return m;
  };
  const [vals, setVals] = useState<Record<string, number>>(suggestedMap);
  const [open, setOpen] = useState(() => !narrow());
  const [reason, setReason] = useState("");
  const key = `${pa.handNumber}:${pa.amount}:${pa.candidatePlayerIds.join(",")}:${pa.suggested.map((s) => s.playerId + s.amount).join(",")}`;
  useEffect(() => { setVals(suggestedMap()); setReason(""); setOpen(!narrow()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const int = (v: number | undefined) => Math.max(0, Math.floor(v || 0));
  const sum = pa.candidatePlayerIds.reduce((a, id) => a + int(vals[id]), 0);
  const remaining = pa.amount - sum;
  const set = (id: string, v: number) => setVals({ ...vals, [id]: v });
  const allTo = (id: string) => {
    const m: Record<string, number> = {};
    for (const c of pa.candidatePlayerIds) m[c] = c === id ? pa.amount : 0;
    setVals(m);
  };
  const sug = suggestedMap();
  const changed = pa.candidatePlayerIds.some((id) => int(vals[id]) !== (sug[id] ?? 0));
  const next = () => send("host:award", {
    awards: pa.candidatePlayerIds.map((id) => ({ playerId: id, amount: int(vals[id]) })).filter((a) => a.amount > 0),
    ...(changed ? { reason: reason.trim() } : {}),
  });
  const status = remaining === 0 ? "ok" : "bad";
  return (
    <div className={`award ${open ? "open" : "closed"}`} role="region" aria-label="Award the pot">
      <div className="ahead">
        <div className="atitle">
          <b>Award the pot · {fmt(pa.amount)}</b>
          <span className="muted small"> Hand #{pa.handNumber}</span>
        </div>
        <button type="button" className="btn tiny" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Edit split"}</button>
      </div>
      {open && (
        <div className="abody">
          <p className="muted small">Prefilled with the suggested payout. Change it if the house rules say otherwise.</p>
          {pa.candidatePlayerIds.map((id) => (
            <div key={id} className="arow">
              <span className="aname"><Who avatar={avatarOf(view, id)} name={nameOf(view, id)} /></span>
              <MoneyInput key={id} value={vals[id] ?? 0} onChange={(n) => set(id, n)} label={`Amount for ${nameOf(view, id)}`} />
              <button className="btn tiny" onClick={() => allTo(id)} title={`Everything to ${nameOf(view, id)}`}>All</button>
            </div>
          ))}
        </div>
      )}
      {changed && (
        <label className="areason">Reason for changing the suggested payout (shown in the dealer log)
          <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. chopped by agreement" />
        </label>
      )}
      <div className={`remaining ${status}`}>{remaining === 0 ? "Split matches the pot" : remaining > 0 ? `Remaining to assign: ${fmt(remaining)}` : `Over by ${fmt(-remaining)}`}</div>
      <div className="btn-row">
        <button className="btn" onClick={() => setVals(suggestedMap())}>Reset to suggested</button>
        <button className="btn call" disabled={remaining !== 0 || (changed && reason.trim().length < 3)} onClick={next}>Next hand</button>
      </div>
    </div>
  );
}
