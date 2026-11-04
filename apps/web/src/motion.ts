import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { TableView } from "@homegame/engine";

export const reducedMotion = (): boolean =>
  typeof window === "undefined" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type Pt = { x: number; y: number };
const RED = "#c9453b";
const GOLD = "#d9a441";
const center = (r: DOMRect): Pt => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const canAnimate = (): boolean => typeof Element !== "undefined" && typeof Element.prototype.animate === "function";

/** Slide an existing element in from a viewport point to where it already sits (WAAPI: no layout shift, never blocks input). */
function animateFrom(el: Element, from: Pt, o: { delay?: number; dur?: number; flip?: boolean; scale?: number }): void {
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  const c = center(r);
  const dx = from.x - c.x, dy = from.y - c.y;
  const s = o.scale ?? 0.55;
  const frames: Keyframe[] = o.flip
    ? [
      { transform: `translate(${dx}px, ${dy}px) perspective(500px) rotateY(90deg) scale(${s})`, opacity: 0 },
      { transform: "translate(0,0) perspective(500px) rotateY(0deg) scale(1)", opacity: 1 },
    ]
    : [
      { transform: `translate(${dx}px, ${dy}px) rotate(-18deg) scale(${s})`, opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { transform: "translate(0,0) rotate(0deg) scale(1)", opacity: 1 },
    ];
  try { el.animate(frames, { duration: o.dur ?? 420, delay: o.delay ?? 0, easing: "cubic-bezier(.2,.8,.25,1)", fill: "backwards" }); } catch { /* ignore */ }
}

function flipIn(el: Element, delay: number): void {
  try {
    el.animate([
      { transform: "perspective(500px) rotateY(88deg)", filter: "brightness(.7)" },
      { transform: "perspective(500px) rotateY(0deg)", filter: "brightness(1)" },
    ], { duration: 380, delay, easing: "cubic-bezier(.3,.7,.3,1)", fill: "backwards" });
  } catch { /* ignore */ }
}

let layer: HTMLElement | null = null;
function getLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement("div");
  layer.className = "fly-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  return layer;
}

/** Small chips that glide between two viewport points, then remove themselves. */
function flyChips(from: Pt, to: Pt, n: number, delay: number, color = RED): void {
  const host = getLayer();
  for (let k = 0; k < n; k++) {
    const el = document.createElement("i");
    el.className = "flychip";
    el.style.left = `${from.x}px`;
    el.style.top = `${from.y}px`;
    el.style.setProperty("--c", color);
    host.appendChild(el);
    const dx = to.x - from.x + (Math.random() - 0.5) * 14;
    const dy = to.y - from.y + (Math.random() - 0.5) * 10;
    try {
      const a = el.animate([
        { transform: "translate(-50%,-50%) scale(.6)", opacity: 0 },
        { opacity: 1, offset: 0.12 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 18}px)) scale(1)`, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9)`, opacity: 1, offset: 0.92 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9)`, opacity: 0 },
      ], { duration: 620 + k * 40, delay: delay + k * 55, easing: "cubic-bezier(.3,.6,.3,1)", fill: "both" });
      a.onfinish = () => el.remove();
      a.oncancel = () => el.remove();
    } catch { el.remove(); }
  }
}

const chipCount = (amount: number, bb: number) => Math.max(1, Math.min(5, Math.ceil(Math.log2(1 + amount / Math.max(1, bb)))));

interface Snap {
  handNo: number | null;
  total: number[];
  faceUp: number[];
  bets: number[];
  board: number;
  winKey: string;
}

/**
 * Deal / reveal / chip motion for the table. Diff-based and DOM-driven: after each commit it compares counts
 * with the previous commit and animates only what changed. Does nothing under prefers-reduced-motion or when
 * positions are unavailable.
 */
export function useTableMotion(
  wrapRef: RefObject<HTMLElement>, view: TableView,
  betPct: (seat: number) => Pt, winKey: string, winnerAmounts: Map<string, number>,
): void {
  const prev = useRef<Snap | null>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const hand = view.hand;
    const n = view.seats.length;
    const snap: Snap = { handNo: hand?.handNumber ?? null, total: [], faceUp: [], bets: [], board: hand?.board.length ?? 0, winKey };
    const seatEls: (Element | null)[] = [];
    for (let i = 0; i < n; i++) {
      const el = wrap?.querySelector(`[data-seat="${i}"]`) ?? null;
      seatEls.push(el);
      snap.total.push(el ? el.querySelectorAll(".card").length : 0);
      snap.faceUp.push(el ? el.querySelectorAll(".card:not(.back)").length : 0);
      snap.bets.push(view.seats[i]?.bet ?? 0);
    }
    const p = prev.current;
    prev.current = snap;
    if (!p || !wrap || !hand || reducedMotion() || !canAnimate()) return;
    const wr = wrap.getBoundingClientRect();
    if (!wr.width || !wr.height) return;
    const bb = view.config.bigBlind || 1;
    const potEl = wrap.querySelector("[data-pot]");
    const potPt: Pt = potEl ? center(potEl.getBoundingClientRect()) : { x: wr.left + wr.width / 2, y: wr.top + wr.height / 2 };
    const seatPt = (i: number): Pt | null => {
      const a = seatEls[i]?.querySelector(".avwrap") ?? seatEls[i];
      return a ? center(a.getBoundingClientRect()) : null;
    };
    const betPt = (i: number): Pt => {
      const q = wrap.querySelector(`[data-bet="${i}"]`);
      if (q) return center(q.getBoundingClientRect());
      const g = betPct(i);
      return { x: wr.left + (g.x / 100) * wr.width, y: wr.top + (g.y / 100) * wr.height };
    };
    const newHand = p.handNo !== null && snap.handNo !== p.handNo;
    const dealerEl = wrap.querySelector(".dealer");
    const origin: Pt = dealerEl ? center(dealerEl.getBoundingClientRect()) : potPt;

    // Hole and stud cards
    let dealtMs = 0;
    if (newHand) {
      let order = 0;
      const maxCards = Math.max(0, ...snap.total);
      for (let k = 0; k < maxCards; k++) {
        for (let i = 0; i < n; i++) {
          const c = seatEls[i]?.querySelectorAll(".card")[k];
          if (c) { animateFrom(c, origin, { delay: order * 70, dur: 440 }); order++; }
        }
      }
      dealtMs = order * 70 + 300;
    } else {
      for (let i = 0; i < n; i++) {
        const el = seatEls[i];
        if (!el) continue;
        const cards = el.querySelectorAll(".card");
        if (snap.total[i] > p.total[i]) {
          for (let k = p.total[i]; k < cards.length; k++) animateFrom(cards[k], potPt, { delay: (k - p.total[i]) * 90, dur: 420 });
        } else if (snap.total[i] === p.total[i] && snap.faceUp[i] > p.faceUp[i]) {
          let d = 0;
          el.querySelectorAll(".cardrow.hole:not(.up) .card:not(.back)").forEach((c) => { flipIn(c, d); d += 120; });
        }
      }
    }

    // Community cards
    const boardEls = wrap.querySelectorAll(".board .card:not(.slot)");
    const fromB = newHand ? 0 : p.board;
    if (snap.board > fromB) {
      for (let k = fromB; k < boardEls.length; k++) {
        animateFrom(boardEls[k], { x: potPt.x, y: potPt.y - 50 }, { delay: (k - fromB) * 110, dur: 460, flip: true, scale: 0.8 });
      }
    }

    // Chips: bet out, street collected, pot to winners
    let collected = false;
    for (let i = 0; i < n; i++) {
      const was = p.bets[i] ?? 0, now = snap.bets[i];
      const sp = seatPt(i);
      if (now > was && sp) flyChips(sp, betPt(i), chipCount(now - was, bb), newHand ? dealtMs : 0);
      else if (was > 0 && now === 0 && !newHand && sp) { flyChips(betPt(i), potPt, chipCount(was, bb), 0, GOLD); collected = true; }
    }
    if (snap.winKey && snap.winKey !== p.winKey && !newHand) {
      const base = collected ? 520 : 150;
      view.seats.forEach((s, i) => {
        const amt = s ? winnerAmounts.get(s.playerId) : 0;
        const sp = seatPt(i);
        if (amt && sp) flyChips(potPt, sp, chipCount(amt, bb) + 1, base, GOLD);
      });
    }
  });
}
