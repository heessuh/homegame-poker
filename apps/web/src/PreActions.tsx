import { useEffect, useRef, useState } from "react";
import type { PlayerAction, TableView } from "@homegame/engine";
import { fmtBet } from "./util";
import { setPreActionArmed } from "./sound";

/**
 * Pre-action buttons: pick your move while others act, and it is sent the moment your turn comes.
 * - Check/Fold: check if you can, else fold. Used once.
 * - Call X (or Check): only if the price is still X when your turn comes; cleared when the price changes.
 * - Fold to any bet: for the rest of the hand, check when free and fold to any bet.
 * Nothing new goes to the server: these send the same actions as the normal buttons.
 */
type Pre = { kind: "checkfold" } | { kind: "call"; amount: number } | { kind: "foldany" } | null;

export function PreActions({ view, onAction }: { view: TableView; onAction: (a: PlayerAction) => void }) {
  const [pre, setPre] = useState<Pre>(null);
  const h = view.hand;
  const mySeat = view.you.seat;
  const me = mySeat !== null ? view.seats[mySeat] : null;
  const handNo = h?.handNumber ?? null;
  const highBet = Math.max(0, ...view.seats.map((s) => s?.bet ?? 0));
  const toCall = me ? Math.max(0, Math.min(highBet - me.bet, me.stack)) : 0;
  const myTurn = !!h && mySeat !== null && h.toActSeat === mySeat && !!h.legal && h.stage === "bet" && !h.legal.exchange && !h.legal.declare;
  const live = !!h && !!me && me.inHand && !me.folded && !me.allIn && !h.winners;
  const show = live && me!.stack > 0 && h!.toActSeat !== null;

  // A new hand starts clean.
  useEffect(() => { setPre(null); }, [handNo]);
  // "Call X" only holds while the price is X.
  useEffect(() => {
    if (pre?.kind === "call" && !myTurn && pre.amount !== toCall) setPre(null);
  }, [toCall, pre, myTurn]);
  // Leaving the hand (fold, all-in, showdown) clears everything.
  useEffect(() => { if (!live && pre && !myTurn) setPre(null); }, [live, pre, myTurn]);
  useEffect(() => { setPreActionArmed(!!pre); }, [pre]);
  useEffect(() => () => setPreActionArmed(false), []);

  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!myTurn || !pre || !h?.legal) return;
    const L = h.legal;
    const key = `${h.handNumber}|${h.phase}|${h.toActSeat}|${L.callAmount}|${L.minRaiseTo}`;
    if (fired.current === key) return;
    fired.current = key;
    let act: PlayerAction | null = null;
    if (pre.kind === "checkfold" || pre.kind === "foldany") act = L.canCheck ? { type: "check" } : L.canFold ? { type: "fold" } : null;
    else if (pre.amount === 0 ? L.canCheck : !L.canCheck && L.callAmount === pre.amount) act = L.canCheck ? { type: "check" } : { type: "call" };
    if (pre.kind !== "foldany") setPre(null);
    if (act) onAction(act);
  });

  if (!show || myTurn) return null;
  const toggle = (p: NonNullable<Pre>) => setPre(pre && pre.kind === p.kind ? null : p);
  const on = (k: NonNullable<Pre>["kind"]) => pre?.kind === k;
  const callLabel = toCall > 0 ? `Call ${fmtBet(toCall)}` : "Check";
  return (
    <div className="preactions" role="group" aria-label="Pre-select your next action">
      <button type="button" className={on("checkfold") ? "on" : ""} aria-pressed={on("checkfold")} onClick={() => toggle({ kind: "checkfold" })}>
        <span className="box" aria-hidden="true" />Check/Fold
      </button>
      <button type="button" className={on("call") ? "on" : ""} aria-pressed={on("call")} onClick={() => toggle({ kind: "call", amount: toCall })}>
        <span className="box" aria-hidden="true" />{callLabel}
      </button>
      <button type="button" className={on("foldany") ? "on" : ""} aria-pressed={on("foldany")} onClick={() => toggle({ kind: "foldany" })}>
        <span className="box" aria-hidden="true" />Fold to any bet
      </button>
    </div>
  );
}
