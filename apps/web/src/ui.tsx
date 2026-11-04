import { useEffect, useRef, useState } from "react";
import { fmtWith, isDollars, moneyText, parseMoney } from "./util";
import { AVATAR_EMOJIS, isValidAvatar } from "@homegame/engine";
import type { TableView } from "@homegame/engine";

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function useNow(active: boolean, every = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(id);
  }, [active, every]);
  return now;
}

export function mmss(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Emoji, or a small round numbered badge for "1".."99". Renders nothing for null. */
export function Avatar({ a }: { a: string | null | undefined }) {
  if (!a) return null;
  if (/^\d+$/.test(a)) return <span className="avatar num" aria-label={`Number ${a}`}>{a}</span>;
  return <span className="avatar" aria-hidden="true">{a}</span>;
}

export function Who({ avatar, name }: { avatar?: string | null; name: string }) {
  return <span className="who"><Avatar a={avatar} />{avatar ? " " : ""}{name}</span>;
}

export function avatarOf(view: TableView, playerId: string): string | null {
  for (const s of view.seats) if (s && s.playerId === playerId) return s.avatar;
  return null;
}

export function AvatarPicker({ current, onPick, onClose }: { current: string | null; onPick: (a: string | null) => void; onClose: () => void }) {
  const [num, setNum] = useState(current && /^\d+$/.test(current) ? current : "");
  const numOk = isValidAvatar(num) && /^\d+$/.test(num);
  const pick = (a: string | null) => { onPick(a); onClose(); };
  return (
    <Modal title="Choose your avatar" onClose={onClose}>
      <div className="avgrid">
        {AVATAR_EMOJIS.map((e) => (
          <button key={e} type="button" className={e === current ? "on" : ""} onClick={() => pick(e)} aria-label={`Avatar ${e}`}>{e}</button>
        ))}
      </div>
      <div className="avnum">
        <label>Or a number (1–99)
          <input type="number" inputMode="numeric" min={1} max={99} value={num} onChange={(e) => setNum(e.target.value)} />
        </label>
        <button type="button" className="btn small" disabled={!numOk} onClick={() => pick(String(Number(num)))}>Use number</button>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => pick(null)}>None</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export function loadAvatar(): string | null {
  try {
    const a = localStorage.getItem("hg.avatar");
    return a && isValidAvatar(a) ? a : null;
  } catch { return null; }
}
export function saveAvatar(a: string | null): void {
  try { localStorage.setItem("hg.avatar", a ?? ""); } catch { /* ignore */ }
}

/** Amount input. `value` is integer chips; the box shows dollars when dollars mode is on. Emits integer chips only when valid. */
export function MoneyInput({ value, onChange, dollars, min, max, label, className, autoFocus, onBlurFix }: {
  value: number; onChange: (n: number) => void; dollars?: boolean; min?: number; max?: number;
  label: string; className?: string; autoFocus?: boolean; onBlurFix?: boolean;
}) {
  const d = dollars ?? isDollars();
  const [text, setText] = useState(() => moneyText(value, d));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(value);
  useEffect(() => {
    if (parseMoney(text, d) !== value) setText(moneyText(value, d));
    last.current = value;
    setErr(null);
  }, [value, d]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = (t: string): number | null => {
    const n = parseMoney(t, d);
    if (n === null) { setErr(d ? "Enter dollars like 1.25" : "Enter a whole number"); return null; }
    if (min !== undefined && n < min) { setErr(`At least ${fmtWith(min, d, true)}`); return null; }
    if (max !== undefined && n > max) { setErr(`At most ${fmtWith(max, d, true)}`); return null; }
    setErr(null);
    return n;
  };
  const change = (t: string) => {
    setText(t);
    const n = check(t);
    if (n !== null) { last.current = n; onChange(n); }
  };
  const blur = () => {
    if (!onBlurFix) return;
    const n = parseMoney(text, d);
    if (n === null) { setText(moneyText(value, d)); setErr(null); return; }
    const c = Math.max(min ?? 0, Math.min(max ?? n, n));
    last.current = c; setText(moneyText(c, d)); setErr(null); onChange(c);
  };
  return (
    <span className="moneyin">
      <input className={className} type="text" inputMode={d ? "decimal" : "numeric"} value={text} aria-label={label}
        aria-invalid={!!err} autoFocus={autoFocus} onChange={(e) => change(e.target.value)} onBlur={blur} />
      {d && <span className="unit" aria-hidden="true">$</span>}
      {err && <span className="note small" role="alert">{err}</span>}
    </span>
  );
}
