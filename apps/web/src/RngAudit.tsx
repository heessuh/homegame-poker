import { useEffect, useRef, useState } from "react";
import type { RngAuditLens, RngAuditReport, RngAuditRow, RngAuditScope, RngAuditVerdict } from "@homegame/engine";
import type { Send } from "./App";

const VERDICT_TEXT: Record<RngAuditVerdict, { badge: string; sentence: string }> = {
  fair: { badge: "Fair", sentence: "consistent with a fair shuffle." },
  unusual: { badge: "Unusual", sentence: "a little unusual. This happens by chance about 1 time in 100, so keep watching." },
  investigate: { badge: "Investigate", sentence: "very unlikely by chance (less than 1 in 1,000). This is worth a closer look." },
  "too-few-hands": { badge: "Too few hands", sentence: "not enough hands yet to say anything." },
};

const nf = new Intl.NumberFormat("en-US");
const num = (n: number) => nf.format(n);
const pct = (x: number) => `${x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toFixed(3)}%`;

export function formatP(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "n/a";
  if (p >= 0.001) return p.toFixed(3);
  if (p === 0) return "< 1e-300";
  return p.toExponential(1);
}

/** The "Fairness" tab: observed deals against exact poker math, for this table or the whole site. */
export function RngAudit({ send, handCount }: { send: Send; handCount: number }) {
  const [scope, setScope] = useState<RngAuditScope>("table");
  const [report, setReport] = useState<RngAuditReport | null>(null);
  const [failed, setFailed] = useState(false);
  const want = useRef(0);

  useEffect(() => {
    const id = ++want.current;
    setFailed(false);
    const timer = setTimeout(() => { if (want.current === id) setFailed(true); }, 8000);
    send("getRngAudit", { scope }, (r) => {
      if (want.current !== id) return;
      clearTimeout(timer);
      setReport(r);
    });
    return () => clearTimeout(timer);
    // Refresh when the scope changes or another hand finishes at this table.
  }, [scope, handCount, send]);

  const shown = report && report.scope === scope ? report : null;
  return (
    <div className="fair">
      <p className="muted small fair-intro">
        Every finished hand reveals its whole shuffled deck. Because a fair shuffle makes any fixed set of deck positions a random sample,
        the cards at those positions are the same as the cards players were dealt, in any game. They are counted here and compared
        with exact poker math: pocket pairs, aces, seven-card hands (best five of seven), flops and every card in every one of the first 20
        positions. If the deck were tilted toward big hands, it would show up as results outside the 95% range. About 1 lens in 20
        will wander outside it by chance alone, so one stray “Unusual” is normal. Several “Investigate” in a row would not be.
      </p>
      <div className="btn-row fair-scope" role="group" aria-label="Scope">
        <button className={`btn small${scope === "table" ? " on" : ""}`} aria-pressed={scope === "table"} onClick={() => setScope("table")}>This table</button>
        <button className={`btn small${scope === "site" ? " on" : ""}`} aria-pressed={scope === "site"} onClick={() => setScope("site")}>All games since launch</button>
      </div>
      {!shown && <p className="muted">{failed ? "Could not load the audit. Try again in a moment." : "Loading…"}</p>}
      {shown && (
        <>
          <p className="muted small">
            {num(shown.hands)} {shown.hands === 1 ? "hand" : "hands"} counted since {new Date(shown.since).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}.
          </p>
          {shown.overall ? (
            <section className={`lens overall ${shown.overall.verdict}`} aria-label="Overall verdict">
              <h4>
                Overall: <span className={`vbadge ${shown.overall.verdict}`}>{VERDICT_TEXT[shown.overall.verdict].badge}</span>
              </h4>
              <p>
                All {shown.overall.tested} checks together are {VERDICT_TEXT[shown.overall.verdict].sentence}
              </p>
              <p className="muted small">Combined p = {shown.overall.pValue.toPrecision(3)} (adjusted for running {shown.overall.tested} checks at once).</p>
            </section>
          ) : (
            <section className="lens overall too-few-hands" aria-label="Overall verdict">
              <h4>Overall: <span className="vbadge too-few-hands">Too few hands</span></h4>
              <p>Not enough hands yet to say anything. Keep playing; the audit fills in as hands are dealt.</p>
            </section>
          )}
          {shown.lenses.map((l) => <Lens key={l.id} lens={l} hands={shown.hands} />)}
        </>
      )}
    </div>
  );
}

function Lens({ lens, hands }: { lens: RngAuditLens; hands: number }) {
  const v = VERDICT_TEXT[lens.verdict];
  const many = lens.rows.length > 8;
  const rows = lens.rows.map((r) => <Bar key={r.label} row={r} />);
  return (
    <section className={`lens ${lens.verdict}`} aria-label={lens.title}>
      <div className="lens-head">
        <h4>{lens.title}</h4>
        <span className={`vbadge ${lens.verdict}`}>{v.badge}</span>
      </div>
      <p className="lens-says">
        {lens.plainEnglish}{" "}
        {lens.verdict === "too-few-hands"
          ? `Verdict: ${v.sentence} About ${num(lens.minHands)} hands are needed (${num(hands)} so far).`
          : `Verdict: ${v.sentence}`}
      </p>
      {many ? (
        <details className="lens-more">
          <summary>Show all {lens.rows.length} positions</summary>
          <div className="bars">{rows}</div>
        </details>
      ) : (
        <div className="bars">{rows}</div>
      )}
      <p className="muted small lens-fine">
        {lens.pValue === null
          ? `${num(lens.samples)} samples so far; no p-value yet.`
          : `${num(lens.samples)} samples · chi-square ${lens.chiSquare.toFixed(1)} on ${num(lens.df)} df · p = ${formatP(lens.pValue)}`}
      </p>
    </section>
  );
}

function Bar({ row }: { row: RngAuditRow }) {
  const [lo, hi] = row.ci95;
  const max = Math.max(hi, row.observedPct, row.expectedPct) * 1.08 || 1;
  const at = (x: number) => `${Math.min(100, Math.max(0, (x / max) * 100))}%`;
  const out = row.observedPct < lo || row.observedPct > hi;
  return (
    <div className={`bar${out ? " out" : ""}`}>
      <div className="bar-top">
        <span className="bar-label">{row.label}</span>
        <span className="bar-nums">
          <b>{num(row.observed)}</b> · {pct(row.observedPct)} <span className="muted">vs {pct(row.expectedPct)} fair</span>
        </span>
      </div>
      <div className="bar-track" role="img" aria-label={`${row.label}: ${pct(row.observedPct)} observed, fair range ${pct(lo)} to ${pct(hi)}`}>
        <span className="bar-ci" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <span className="bar-exp" style={{ left: at(row.expectedPct) }} />
        <span className="bar-obs" style={{ left: at(row.observedPct) }} />
      </div>
      <div className="bar-fine muted small">
        95% range {pct(lo)} to {pct(hi)}{row.note ? ` · ${row.note}` : ""}
      </div>
    </div>
  );
}
