import { useEffect, useState } from "react";
import type { PendingAward, TableView } from "@homegame/engine";
import type { Send } from "./App";
import { Who, avatarOf } from "./ui";
import { fmt } from "./util";

function nameOf(view: TableView, id: string): string {
  return view.seats.find((s) => s?.playerId === id)?.name ?? view.ledger.find((l) => l.playerId === id)?.name ?? id;
}

export function AwardPanel({ view, pa, send }: { view: TableView; pa: PendingAward; send: Send }) {
  const suggestedMap = () => {
    const m: Record<string, string> = {};
    for (const id of pa.candidatePlayerIds) m[id] = "0";
    for (const s of pa.suggested) m[s.playerId] = String((Number(m[s.playerId]) || 0) + s.amount);
    return m;
  };
  const [vals, setVals] = useState<Record<string, string>>(suggestedMap);
  const key = `${pa.handNumber}:${pa.amount}:${pa.candidatePlayerIds.join(",")}`;
  useEffect(() => setVals(suggestedMap()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const int = (v: string | undefined) => Math.max(0, Math.floor(Number(v) || 0));
  const sum = pa.candidatePlayerIds.reduce((a, id) => a + int(vals[id]), 0);
  const remaining = pa.amount - sum;
  const set = (id: string, v: string) => setVals({ ...vals, [id]: v });
  const allTo = (id: string) => {
    const m: Record<string, string> = {};
    for (const c of pa.candidatePlayerIds) m[c] = c === id ? String(pa.amount) : "0";
    setVals(m);
  };
  const award = () => send("host:award", {
    awards: pa.candidatePlayerIds.map((id) => ({ playerId: id, amount: int(vals[id]) })).filter((a) => a.amount > 0),
  });
  return (
    <>
      <div className="award-bg" />
      <div className="award" role="dialog" aria-label="Award the pot">
        <h3>Award the pot · {fmt(pa.amount)}</h3>
        <p className="muted small">Hand #{pa.handNumber}. Split the chips between the players below.</p>
        {pa.candidatePlayerIds.map((id) => (
          <div key={id} className="arow">
            <span className="aname"><Who avatar={avatarOf(view, id)} name={nameOf(view, id)} /></span>
            <input type="number" inputMode="numeric" min={0} value={vals[id] ?? "0"} onChange={(e) => set(id, e.target.value)} aria-label={`Amount for ${nameOf(view, id)}`} />
            <button className="btn tiny" onClick={() => allTo(id)} title={`All to ${nameOf(view, id)}`}>All to {nameOf(view, id)}</button>
          </div>
        ))}
        <div className={`remaining ${remaining === 0 ? "ok" : "bad"}`}>Remaining: {fmt(remaining)}</div>
        <div className="btn-row">
          <button className="btn" onClick={() => setVals(suggestedMap())}>Use suggested</button>
          <button className="btn call" disabled={remaining !== 0} onClick={award}>Award</button>
        </div>
      </div>
    </>
  );
}
