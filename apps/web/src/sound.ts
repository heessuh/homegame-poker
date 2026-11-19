// Table sounds, made in the browser with Web Audio: no audio files, nothing downloaded or copied.
// The mute choice is remembered per device (localStorage "hg.sound").
import { useEffect, useRef, useState } from "react";
import type { TableView } from "@homegame/engine";
import { storeGet, storeSet, totalPot } from "./util";

export type SoundName = "turn" | "chips" | "check" | "deal" | "win";

const KEY = "hg.sound";
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    try { ctx = new C(); } catch { return null; }
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

/** Browsers only allow sound after the player has touched the page once, so the first tap or key press unlocks it. */
function unlockOnce(): void {
  if (typeof window === "undefined") return;
  const go = () => {
    audio();
    window.removeEventListener("pointerdown", go);
    window.removeEventListener("keydown", go);
  };
  window.addEventListener("pointerdown", go);
  window.addEventListener("keydown", go);
}
unlockOnce();

function noise(a: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(a.sampleRate * 0.4);
  noiseBuf = a.createBuffer(1, len, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** One tone with a quick attack and an exponential fade. */
function tone(a: AudioContext, freq: number, at: number, dur: number, vol: number, type: OscillatorType = "sine"): void {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master!);
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** A short burst of filtered noise: chip clicks and card swishes. */
function burst(a: AudioContext, at: number, dur: number, vol: number, filter: BiquadFilterType, freq: number, toFreq?: number, q = 1): void {
  const src = a.createBufferSource();
  src.buffer = noise(a);
  const f = a.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, at);
  if (toFreq) f.frequency.exponentialRampToValueAtTime(toFreq, at + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(at, Math.random() * 0.2);
  src.stop(at + dur + 0.02);
}

export function playSound(name: SoundName, count = 1): void {
  const a = audio();
  if (!a || !master || a.state !== "running") return;
  const t = a.currentTime + 0.01;
  switch (name) {
    case "turn": // a soft two-note bell: your turn
      tone(a, 784, t, 0.55, 0.32);
      tone(a, 1568, t, 0.3, 0.06);
      tone(a, 1175, t + 0.16, 0.7, 0.3);
      tone(a, 2350, t + 0.16, 0.35, 0.05);
      break;
    case "chips": // a few clay chips landing
      for (let i = 0; i < 4; i++) {
        const at = t + i * 0.035 + Math.random() * 0.012;
        burst(a, at, 0.05, 0.38 - i * 0.06, "bandpass", 3200 + Math.random() * 1600, undefined, 6);
        tone(a, 2400 + Math.random() * 900, at, 0.04, 0.05, "triangle");
      }
      break;
    case "check": // two knuckle taps on the felt
      for (let i = 0; i < 2; i++) {
        const at = t + i * 0.11;
        tone(a, 140, at, 0.09, 0.4);
        burst(a, at, 0.04, 0.2, "lowpass", 900);
      }
      break;
    case "deal": // a card sliding across the felt, once per card
      for (let i = 0; i < Math.min(count, 5); i++) burst(a, t + i * 0.09, 0.12, 0.22, "bandpass", 5200, 1600, 1.4);
      break;
    case "win": // a rising chime
      [523, 659, 784, 1047].forEach((f, i) => tone(a, f, t + i * 0.09, 0.5, 0.18, "triangle"));
      break;
  }
}

// ---- Mute toggle (per device) ----
const listeners = new Set<(on: boolean) => void>();
export function soundOn(): boolean {
  return storeGet(KEY) !== "off";
}
export function setSoundOn(on: boolean): void {
  storeSet(KEY, on ? "on" : "off");
  if (on) audio();
  for (const l of listeners) l(on);
}
export function useSoundOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(soundOn);
  useEffect(() => {
    listeners.add(setOn);
    return () => { listeners.delete(setOn); };
  }, []);
  return [on, setSoundOn];
}

/** Set by the pre-action buttons: when one is armed, your turn is answered at once, so the turn bell stays quiet. */
let preActionArmed = false;
export function setPreActionArmed(on: boolean): void { preActionArmed = on; }

interface Snap { hand: number | null; board: number; pot: number; myTurn: string | null; won: boolean; acts: Map<string, string | null> }

function snap(v: TableView): Snap {
  const h = v.hand;
  const me = v.you.seat;
  const acts = new Map<string, string | null>();
  for (const s of v.seats) if (s) acts.set(s.playerId, s.lastAction);
  return {
    hand: h?.handNumber ?? null,
    board: h?.board.length ?? 0,
    pot: totalPot(v),
    // A key per turn, so a new street or a re-raise back to you rings again.
    myTurn: h && me !== null && h.toActSeat === me && h.legal ? `${h.handNumber}|${h.phase}|${h.legal.callAmount}|${h.stage}` : null,
    won: !!h?.winners?.length,
    acts,
  };
}

/** Plays sounds for what changed between two views of the table. Nothing plays for the first view after joining. */
export function useTableSounds(view: TableView): void {
  const prev = useRef<Snap | null>(null);
  useEffect(() => {
    const cur = snap(view);
    const p = prev.current;
    prev.current = cur;
    if (!p || !soundOn()) return;
    const sameHand = cur.hand !== null && cur.hand === p.hand;
    if (cur.hand !== null && cur.hand !== p.hand) playSound("deal", 2);
    else if (sameHand && cur.board > p.board) playSound("deal", cur.board - p.board);
    if (sameHand && cur.pot > p.pot) playSound("chips");
    else if (sameHand) {
      for (const [id, a] of cur.acts) if (a === "Check" && p.acts.get(id) !== "Check") { playSound("check"); break; }
    }
    if (sameHand && cur.won && !p.won) playSound("win");
    if (cur.myTurn && cur.myTurn !== p.myTurn && !preActionArmed) playSound("turn");
  }, [view]);
}
