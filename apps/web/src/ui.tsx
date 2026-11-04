import { useEffect, useState } from "react";
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
