import { useEffect, useRef, useState } from "react";
import type { Card, Declaration, LegalActions, PlayerAction, TableView } from "@homegame/engine";
import { CardFace } from "./CardView";
import { fmt, fmtBet, isStud, totalPot } from "./util";
import { MoneyInput } from "./ui";

export function ActionBar({ view, onAction, onExtend }: { view: TableView; onAction: (a: PlayerAction) => void; onExtend: () => void }) {
  const legal = view.hand?.legal;
  if (!legal) return null;
  const ext = view.canExtend && view.config.extensionSec > 0 ? (
    <button type="button" className="btn small extend" onClick={onExtend}>+{view.config.extensionSec}s</button>
  ) : null;
  let panel: React.ReactNode;
  if (legal.exchange && view.hand?.stage !== "bet") {
    panel = <ExchangePanel key={`${view.hand?.handNumber}-${view.hand?.phase}`} ex={legal.exchange} onAction={onAction} />;
  } else if (legal.declare) panel = <DeclarePanel onAction={onAction} />;
  else panel = <ActionBarInner view={view} legal={legal} onAction={onAction} />;
  return <>{panel}{ext && <div className="extend-row">{ext}<span className="muted small">More time on your clock (once per turn)</span></div>}</>;
}

function ExchangePanel({ ex, onAction }: { ex: NonNullable<LegalActions["exchange"]>; onAction: (a: PlayerAction) => void }) {
  const [sel, setSel] = useState<{ card: Card; down: boolean } | null>(null);
  const tile = (c: Card, down: boolean) => (
    <button key={(down ? "d" : "u") + c} type="button" className={`tile ${down ? "down" : "up"} ${sel?.card === c ? "on" : ""}`}
      aria-pressed={sel?.card === c} aria-label={`${down ? "Face-down" : "Face-up"} card ${c}`}
      onClick={() => setSel(sel?.card === c ? null : { card: c, down })}>
      <CardFace card={c} size="lg" />
    </button>
  );
  const blocked = !!sel && sel.down && !ex.canAffordDown;
  return (
    <div className="actionbar stud-panel turn-in">
      <h4>Exchange: swap one card, or keep all</h4>
      <div className="tiles">
        <div className="tilegrp"><div className="row">{ex.downCards.map((c) => tile(c, true))}</div><span className="lbl">Face-down (private)</span></div>
        <div className="tilegrp"><div className="row">{ex.upCards.map((c) => tile(c, false))}</div><span className="lbl">Face-up (public)</span></div>
      </div>
      <div className="offer">
        {!sel && <span className="muted">Tap a card to swap it.</span>}
        {sel && sel.down && <>Swap this face-down card (costs {fmt(ex.downCost)}){blocked && <span className="note">You can’t afford a face-down swap.</span>}</>}
        {sel && !sel.down && <>Swap this face-up card (free)</>}
      </div>
      <div className="btn-row">
        <button className="btn fold" onClick={() => onAction({ type: "exchange", card: null })}>Keep all</button>
        <button className="btn raise" disabled={!sel || blocked} onClick={() => sel && onAction({ type: "exchange", card: sel.card })}>
          {sel ? "Swap" : "Swap…"}
        </button>
      </div>
    </div>
  );
}

function DeclarePanel({ onAction }: { onAction: (a: PlayerAction) => void }) {
  const opts: [Declaration, string][] = [["high", "High"], ["low", "Low"], ["both", "Both"]];
  return (
    <div className="actionbar stud-panel turn-in">
      <h4>Declare</h4>
      <div className="btn-row declare-btns">
        {opts.map(([c, label]) => (
          <button key={c} className={`btn ${c === "both" ? "raise" : "call"}`} onClick={() => onAction({ type: "declare", choice: c })}>{label}</button>
        ))}
      </div>
      <p className="reminder">Both: you must win or tie both sides, or you get nothing.</p>
    </div>
  );
}

function ActionBarInner({ view, legal, onAction }: { view: TableView; legal: LegalActions; onAction: (a: PlayerAction) => void }) {
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const canRaise = min !== null && max !== null;
  const fixed = canRaise && min === max;
  const [amount, setAmount] = useState<number>(min ?? 0);
  const highBet = Math.max(0, ...view.seats.map((s) => s?.bet ?? 0));
  const pot = totalPot(view);
  const isBet = highBet === 0;
  const hl = view.config.houseLimit?.enabled && !isStud(view.config);
  const handKey = `${view.hand?.handNumber}-${view.hand?.phase}-${min}-${max}`;

  useEffect(() => { if (min !== null) setAmount(min); }, [handKey, min]);

  const inRange = (v: number) => canRaise && v >= min! && v <= max!;
  // Pot-fraction presets: raise-to = high bet + fraction x (pot incl. street bets + call). Out-of-range presets are hidden, never clamped.
  const presets: [string, number][] = [];
  if (canRaise && !fixed) {
    for (const [label, f] of [["33%", 0.33], ["50%", 0.5], ["75%", 0.75], ["Pot", 1]] as const) {
      const v = Math.round(highBet + f * (pot + legal.callAmount));
      if (inRange(v) && v < max! && !presets.some((p) => p[1] === v)) presets.push([label, v]);
    }
    presets.push(["Max", max!]);
  }
  const spread = canRaise && (hl || isStud(view.config));
  const cur = canRaise ? Math.max(min!, Math.min(max!, amount)) : amount;

  const ref = useRef({ legal, amount, onAction, canRaise });
  ref.current = { legal, amount, onAction, canRaise };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const r = ref.current;
      if (e.key === "f" && r.legal.canFold) r.onAction({ type: "fold" });
      else if (e.key === "c") r.onAction(r.legal.canCheck ? { type: "check" } : { type: "call" });
      else if (e.key === "r" && r.canRaise) r.onAction({ type: "raise", amount: r.amount });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="actionbar turn-in">
      {canRaise && !fixed && (
        <div className="raise-row">
          <div className="presets">
            {presets.map(([label, v]) => (
              <button key={label} type="button" className={v === cur ? "on" : ""} onClick={() => setAmount(v)} title={fmtBet(v)}>{label}</button>
            ))}
          </div>
          <div className="slider-row">
            <input type="range" min={min!} max={max!} step={1} value={cur}
              style={{ ["--pct" as string]: `${max! > min! ? ((cur - min!) / (max! - min!)) * 100 : 100}%` }}
              onChange={(e) => setAmount(Number(e.target.value))} aria-label="Raise amount" />
            <MoneyInput className="amt" value={amount} min={min!} max={max!} onChange={setAmount} label="Raise to amount" />
          </div>
        </div>
      )}
      <div className="btn-row">
        <button className="btn fold" disabled={!legal.canFold} onClick={() => onAction({ type: "fold" })}>
          Fold<kbd>F</kbd>
        </button>
        <button className="btn call" onClick={() => onAction(legal.canCheck ? { type: "check" } : { type: "call" })}>
          {legal.canCheck ? "Check" : `Call ${fmtBet(legal.callAmount)}`}<kbd>C</kbd>
        </button>
        {canRaise && (
          <button className="btn raise" onClick={() => onAction({ type: "raise", amount: cur })}>
            {isBet ? "Bet" : "Raise to"} {fmtBet(cur)}<kbd>R</kbd>
          </button>
        )}
      </div>
      {spread && max! > 0 && (
        <p className="hint">Max {isBet ? "bet" : "raise"} +{fmtBet(max! - highBet)}</p>
      )}
    </div>
  );
}
