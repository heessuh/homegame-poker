import { useState } from "react";
import { TOURNAMENT_PRESETS } from "@homegame/engine";
import type { BlindLevel, TableView, TournamentConfig } from "@homegame/engine";
import type { Send } from "./App";
import { Who, avatarOf, mmss, ordinal, useNow } from "./ui";
import { fmt } from "./util";

export function TournamentHud({ view, send }: { view: TableView; send: Send }) {
  const t = view.tournament;
  const running = t?.status === "running";
  const ticking = !!(running && t.levelEndsAt);
  const now = useNow(ticking, 500);
  if (!t) return null;
  if (t.status === "finished") {
    const w = t.standings.find((s) => s.place === 1) ?? t.standings[0];
    return (
      <div className="thud winner" role="status">
        <div className="trophy">🏆</div>
        <div><b><Who avatar={w ? avatarOf(view, w.playerId) : null} name={w?.name ?? "Nobody"} /></b> wins the tournament!</div>
      </div>
    );
  }
  const remaining = t.levelEndsAt ? t.levelEndsAt - now : t.levelRemainingMs;
  const paused = !t.levelEndsAt;
  const host = view.you.isHost;
  return (
    <div className="thud">
      <div className="trow">
        <div className="tlevel">{t.level.isBreak ? `Break · no hands for ${t.level.minutes} min` : `Level ${t.levelIndex + 1} · ${fmt(t.level.smallBlind)}/${fmt(t.level.bigBlind)}`}</div>
        <div className="tleft">{t.playersLeft} left</div>
      </div>
      <div className={`tclock ${paused ? "paused" : ""} ${!paused && remaining < 60000 ? "low" : ""}`}>
        {t.status === "registering" ? "Not started" : mmss(remaining)}
        {paused && t.status === "running" && <span className="tpaused">Paused</span>}
      </div>
      <div className="trow muted small">
        <span>{t.nextLevel ? (t.nextLevel.isBreak ? `Next: break (${t.nextLevel.minutes} min)` : `Next: ${fmt(t.nextLevel.smallBlind)}/${fmt(t.nextLevel.bigBlind)}`) : "Final level"}</span>
        <span>{t.lateRegOpen ? "Late reg open" : "Late reg closed"}</span>
      </div>
      {host && running && (
        <div className="tctl">
          <button className="btn tiny" onClick={() => send("host:tournamentLevel", { delta: -1 })}>Level −</button>
          <button className="btn tiny" onClick={() => send("host:tournamentLevel", { delta: 1 })}>Level +</button>
          <button className="btn tiny" onClick={() => send("host:tournamentClock", { addMs: -60000 })}>Clock −1 min</button>
          <button className="btn tiny" onClick={() => send("host:tournamentClock", { addMs: 60000 })}>Clock +1 min</button>
        </div>
      )}
    </div>
  );
}

export function Standings({ view }: { view: TableView }) {
  const t = view.tournament;
  if (!t) return <p className="muted">Not a tournament.</p>;
  if (t.standings.length === 0) return <p className="muted">No players yet.</p>;
  return (
    <table className="ledger standings">
      <thead><tr><th>Place</th><th>Player</th><th>Stack</th></tr></thead>
      <tbody>
        {t.standings.map((s, i) => {
          const out = s.place !== null && s.stack === 0;
          return (
            <tr key={s.playerId} className={out ? "elim" : ""}>
              <td>{out ? ordinal(s.place!) : s.place === 1 ? "1st" : i + 1}</td>
              <td><Who avatar={avatarOf(view, s.playerId)} name={s.name} /></td>
              <td>{out ? "Out" : fmt(s.stack)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** lockedBefore: rows before this index are read-only (levels already played or being played). levelsOnly hides the stack, late-registration and preset fields. */
export function TournamentEditor({ value, onChange, lockedBefore = 0, levelsOnly = false }: { value: TournamentConfig; onChange: (t: TournamentConfig) => void; lockedBefore?: number; levelsOnly?: boolean }) {
  const [allMin, setAllMin] = useState(15);
  const presetKey = (Object.keys(TOURNAMENT_PRESETS) as (keyof typeof TOURNAMENT_PRESETS)[])
    .find((k) => JSON.stringify(TOURNAMENT_PRESETS[k].config) === JSON.stringify(value)) ?? "custom";
  const setLevel = (i: number, patch: Partial<BlindLevel>) =>
    onChange({ ...value, levels: value.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  const addRow = () => {
    const last = [...value.levels].reverse().find((l) => !l.isBreak) ?? { smallBlind: 25, bigBlind: 50, minutes: 15 };
    onChange({ ...value, levels: [...value.levels, { smallBlind: last.smallBlind * 2, bigBlind: last.bigBlind * 2, minutes: last.minutes }] });
  };
  const setAll = () => onChange({ ...value, levels: value.levels.map((l, j) => (j < lockedBefore || l.isBreak ? l : { ...l, minutes: Math.max(1, Math.min(120, allMin)) })) });
  const addBreakAfter = (i: number) => {
    const cur = value.levels[i]!;
    const levels = [...value.levels];
    levels.splice(i + 1, 0, { smallBlind: cur.smallBlind, bigBlind: cur.bigBlind, minutes: 10, isBreak: true });
    onChange({ ...value, levels });
  };
  const doubleFrom = (i: number) => {
    const levels = value.levels.map((l) => ({ ...l }));
    for (let j = i + 1; j < levels.length; j++) {
      if (levels[j].isBreak) { levels[j].smallBlind = levels[j - 1].smallBlind; levels[j].bigBlind = levels[j - 1].bigBlind; continue; }
      levels[j].smallBlind = levels[j - 1].smallBlind * 2;
      levels[j].bigBlind = levels[j - 1].bigBlind * 2;
    }
    onChange({ ...value, levels });
  };
  return (
    <div className="teditor">
      {!levelsOnly && <div className="form">
        <label>Preset
          <select value={presetKey} onChange={(e) => {
            const k = e.target.value as keyof typeof TOURNAMENT_PRESETS;
            if (TOURNAMENT_PRESETS[k]) onChange(structuredClone(TOURNAMENT_PRESETS[k].config));
          }}>
            <option value="custom">Custom</option>
            {(Object.keys(TOURNAMENT_PRESETS) as (keyof typeof TOURNAMENT_PRESETS)[]).map((k) => <option key={k} value={k}>{TOURNAMENT_PRESETS[k].name}</option>)}
          </select>
        </label>
        <label>Starting stack<input type="number" min={1} value={value.startingStack} onChange={(e) => onChange({ ...value, startingStack: num(e.target.value) })} /></label>
        <label>Late registration (levels)<input type="number" min={0} value={value.lateRegLevels} onChange={(e) => onChange({ ...value, lateRegLevels: num(e.target.value) })} /></label>
      </div>}
      <div className="form">
        <label>Set every level to (minutes)<input type="number" min={1} max={120} value={allMin} onChange={(e) => setAllMin(num(e.target.value))} /></label>
        <label className="end"><button className="btn small" onClick={setAll}>Apply to all levels</button></label>
      </div>
      <table className="levels">
        <thead><tr><th>#</th><th>SB</th><th>BB</th><th>Min</th><th /></tr></thead>
        <tbody>
          {value.levels.map((l, i) => {
            const locked = i < lockedBefore;
            return (
              <tr key={i} className={l.isBreak ? "brk" : ""}>
                <td>{i + 1}</td>
                {l.isBreak ? (
                  <td colSpan={2}><b>Break</b> <span className="muted small">no hands</span></td>
                ) : (
                  <>
                    <td><input type="number" min={1} value={l.smallBlind} disabled={locked} onChange={(e) => setLevel(i, { smallBlind: num(e.target.value) })} /></td>
                    <td><input type="number" min={1} value={l.bigBlind} disabled={locked} onChange={(e) => setLevel(i, { bigBlind: num(e.target.value) })} /></td>
                  </>
                )}
                <td><input type="number" min={1} max={120} value={l.minutes} disabled={locked} onChange={(e) => setLevel(i, { minutes: num(e.target.value) })} /></td>
                <td className="lvact">
                  <button className="btn tiny" title="Double blinds on each row after this one" onClick={() => doubleFrom(i)} disabled={locked || i >= value.levels.length - 1}>×2↓</button>
                  <button className="btn tiny" title="Insert a break after this level" aria-label="Insert a break after this level" onClick={() => addBreakAfter(i)} disabled={i >= value.levels.length - 1 || value.levels.length >= 40 || !!l.isBreak}>☕</button>
                  <button className="btn tiny danger" title="Remove level" onClick={() => onChange({ ...value, levels: value.levels.filter((_, j) => j !== i) })} disabled={locked || value.levels.length <= 1 || (levelsOnly && i <= lockedBefore)}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="btn small" onClick={addRow} disabled={value.levels.length >= 40}>Add level</button>
      <p className="muted small">After the last level, it repeats. A break stops dealing for its length; the first and last level cannot be breaks.</p>
    </div>
  );
}

export function tournamentValid(t: TournamentConfig): boolean {
  return t.startingStack >= 1 && t.levels.length >= 1 && t.levels.length <= 40
    && !t.levels[0]?.isBreak && !t.levels[t.levels.length - 1]?.isBreak
    && t.levels.every((l) => l.smallBlind >= 1 && l.bigBlind >= l.smallBlind && l.minutes >= 1 && l.minutes <= 120);
}

