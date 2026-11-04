import { useEffect, useRef, useState } from "react";
import { VARIANTS } from "@homegame/engine";
import type { Card, Declaration, LegalActions, PlayerAction, TableView } from "@homegame/engine";
import { CardFace } from "./CardView";
import { fmt, fmtBet, isStud, totalPot } from "./util";
import { MoneyInput } from "./ui";

export function ActionBar({ view, onAction }: { view: TableView; onAction: (a: PlayerAction) => void }) {
  const legal = view.hand?.legal;
  if (!legal) return null;
  if (legal.exchange && view.hand?.stage !== "bet") {
    return <ExchangePanel key={`${view.hand?.handNumber}-${view.hand?.phase}`} ex={legal.exchange} onAction={onAction} />;
  }
  if (legal.declare) return <DeclarePanel onAction={onAction} />;
  return <ActionBarInner view={view} legal={legal} onAction={onAction} />;
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
    <div className="actionbar stud-panel">
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
    <div className="actionbar stud-panel">
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
  const noLimit = !hl && VARIANTS[view.config.variant]?.betting === "no-limit";
  const handKey = `${view.hand?.handNumber}-${view.hand?.phase}-${min}-${max}`;

  useEffect(() => { if (min !== null) setAmount(min); }, [handKey, min]);

  const clamp = (v: number) => (canRaise ? Math.max(min!, Math.min(max!, Math.round(v))) : v);
  const frac = (f: number) => clamp(highBet + f * (pot + legal.callAmount));
  // Presets clamp to the legal range; drop ones that collapse onto another value (Max wins the label).
  const presets: [string, number][] = [];
  if (canRaise) {
    const all: [string, number][] = [["Min", min!], ["½ Pot", frac(0.5)], ["¾ Pot", frac(0.75)], ["Pot", frac(1)], [noLimit ? "All-in" : "Max", max!]];
    for (const [label, v] of all) {
      const i = presets.findIndex((p) => p[1] === v);
      if (i < 0) presets.push([label, v]);
      else if (label === "Max" || label === "All-in") presets[i] = [label, v];
    }
  }
  const spread = canRaise && (hl || isStud(view.config));

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
    <div className="actionbar">
      {canRaise && !fixed && (
        <div className="raise-row">
          {presets.length > 1 && (
            <div className="presets">
              {presets.map(([label, v]) => <button key={label} onClick={() => setAmount(v)}>{label}</button>)}
            </div>
          )}
          <div className="slider-row">
            <input type="range" min={min!} max={max!} step={1} value={Math.min(max!, Math.max(min!, amount))}
              onChange={(e) => setAmount(Number(e.target.value))} aria-label="Raise amount" />
            <MoneyInput className="amt" value={amount} min={min!} max={max!} onChange={setAmount} onBlurFix label="Raise to amount" />
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
          <button className="btn raise" onClick={() => onAction({ type: "raise", amount: clamp(amount) })}>
            {isBet ? "Bet" : "Raise to"} {fmtBet(clamp(amount))}<kbd>R</kbd>
          </button>
        )}
      </div>
      {spread && max! > 0 && (
        <p className="hint">Max {isBet ? "bet" : "raise"} +{fmtBet(max! - highBet)}</p>
      )}
    </div>
  );
}
