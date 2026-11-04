import { useEffect, useRef, useState } from "react";
import { VARIANTS } from "@homegame/engine";
import type { LegalActions, PlayerAction, TableView } from "@homegame/engine";
import { fmt, totalPot } from "./util";

export function ActionBar({ view, onAction }: { view: TableView; onAction: (a: PlayerAction) => void }) {
  const legal = view.hand?.legal;
  if (!legal) return null;
  return <ActionBarInner view={view} legal={legal} onAction={onAction} />;
}

function ActionBarInner({ view, legal, onAction }: { view: TableView; legal: LegalActions; onAction: (a: PlayerAction) => void }) {
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const canRaise = min !== null && max !== null;
  const [amount, setAmount] = useState<number>(min ?? 0);
  const highBet = Math.max(0, ...view.seats.map((s) => s?.bet ?? 0));
  const pot = totalPot(view);
  const isBet = highBet === 0;
  const noLimit = VARIANTS[view.config.variant].betting === "no-limit";
  const handKey = `${view.hand?.handNumber}-${view.hand?.phase}-${min}-${max}`;

  useEffect(() => { if (min !== null) setAmount(min); }, [handKey, min]);

  const clamp = (v: number) => (canRaise ? Math.max(min!, Math.min(max!, Math.round(v))) : v);
  const frac = (f: number) => clamp(highBet + f * (pot + legal.callAmount));

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
      {canRaise && (
        <div className="raise-row">
          <div className="presets">
            <button onClick={() => setAmount(min!)}>Min</button>
            <button onClick={() => setAmount(frac(0.5))}>½ Pot</button>
            <button onClick={() => setAmount(frac(0.75))}>¾ Pot</button>
            <button onClick={() => setAmount(frac(1))}>Pot</button>
            <button onClick={() => setAmount(max!)}>{noLimit ? "All-in" : "Max"}</button>
          </div>
          <div className="slider-row">
            <input type="range" min={min!} max={max!} step={1} value={Math.min(max!, Math.max(min!, amount))}
              onChange={(e) => setAmount(Number(e.target.value))} aria-label="Raise amount" />
            <input className="amt" type="number" inputMode="numeric" min={min!} max={max!} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              onBlur={() => setAmount(clamp(amount || min!))} aria-label="Raise to amount" />
          </div>
        </div>
      )}
      <div className="btn-row">
        <button className="btn fold" disabled={!legal.canFold} onClick={() => onAction({ type: "fold" })}>
          Fold<kbd>F</kbd>
        </button>
        <button className="btn call" onClick={() => onAction(legal.canCheck ? { type: "check" } : { type: "call" })}>
          {legal.canCheck ? "Check" : `Call ${fmt(legal.callAmount)}`}<kbd>C</kbd>
        </button>
        {canRaise && (
          <button className="btn raise" onClick={() => onAction({ type: "raise", amount: clamp(amount) })}>
            {isBet ? "Bet" : "Raise to"} {fmt(clamp(amount))}<kbd>R</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
