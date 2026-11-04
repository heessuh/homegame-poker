import { useEffect, useRef, useState } from "react";
import { VARIANTS } from "@homegame/engine";
import type { SeatView, TableConfig, TableView, VariantId } from "@homegame/engine";
import { CardRow } from "./CardView";
import type { Send } from "./App";
import { fmt, sha256Hex } from "./util";
import { Who, avatarOf } from "./ui";
import { Standings, TournamentEditor, tournamentValid } from "./Tournament";

export type Tab = "log" | "ledger" | "last" | "standings" | "host";

export function SidePanel({ view, send, tab, setTab }: { view: TableView; send: Send; tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: [Tab, string][] = [["log", "Log"], ["ledger", "Ledger"], ["last", "Last hand"]];
  if (view.tournament) tabs.splice(1, 0, ["standings", "Standings"]);
  if (view.you.isHost) tabs.push(["host", "Host"]);
  return (
    <div className="panel">
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="tabbody">
        {tab === "log" && <Log lines={view.log} />}
        {tab === "ledger" && <Ledger view={view} />}
        {tab === "standings" && <Standings view={view} />}
        {tab === "last" && <LastHand view={view} />}
        {tab === "host" && view.you.isHost && <HostPanel view={view} send={send} />}
      </div>
    </div>
  );
}

function Log({ lines }: { lines: string[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [lines.length]);
  if (lines.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <div className="log">
      {lines.map((l, i) => <div key={i}>{l}</div>)}
      <div ref={end} />
    </div>
  );
}

function Ledger({ view }: { view: TableView }) {
  if (view.ledger.length === 0) return <p className="muted">No buy-ins yet.</p>;
  return (
    <table className="ledger">
      <thead><tr><th>Player</th><th>In</th><th>Out</th><th>Stack</th><th>Net</th></tr></thead>
      <tbody>
        {view.ledger.map((e) => (
          <tr key={e.playerId}>
            <td><Who avatar={avatarOf(view, e.playerId)} name={e.name} /></td><td>{fmt(e.buyIns)}</td><td>{fmt(e.cashOuts)}</td><td>{fmt(e.stack)}</td>
            <td className={e.net > 0 ? "pos" : e.net < 0 ? "neg" : ""}>{e.net > 0 ? "+" : ""}{fmt(e.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LastHand({ view }: { view: TableView }) {
  const h = view.lastHand;
  const [result, setResult] = useState<null | { ok: boolean; computed?: string; error?: string }>(null);
  useEffect(() => setResult(null), [h?.handNumber]);
  if (!h) return <p className="muted">No completed hands yet.</p>;
  const verify = async () => {
    try {
      const computed = await sha256Hex(`${h.reveal.salt}:${h.reveal.deck.join(",")}`);
      setResult({ ok: computed.toLowerCase() === h.deckHash.toLowerCase(), computed });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="lasthand">
      <h4>Hand #{h.handNumber} · {VARIANTS[h.variant].name}</h4>
      {h.board.length > 0 && <CardRow cards={h.board} size="sm" className="flat" />}
      <ul className="summary">{h.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <ul className="summary">
        {h.winners.map((w, i) => (
          <li key={i}>
            <b>{view.ledger.find((l) => l.playerId === w.playerId)?.name ?? w.playerId}</b> won {fmt(w.amount)}
            {w.half !== "whole" ? ` (${w.half})` : ""}{w.handName ? ` with ${w.handName}` : ""}
          </li>
        ))}
      </ul>
      <h4>Shuffle proof</h4>
      <div className="kv"><span>Committed hash</span><code>{h.deckHash}</code></div>
      <div className="kv"><span>Salt</span><code>{h.reveal.salt}</code></div>
      <button className="btn small" onClick={verify}>Verify shuffle</button>
      {result && (
        <div className={`verify ${result.ok ? "ok" : "bad"}`}>
          {result.error ? `Could not verify: ${result.error}` : result.ok ? "✓ Hash matches the revealed deck" : "✗ Hash does NOT match"}
          {result.computed && !result.ok && <code>{result.computed}</code>}
        </div>
      )}
      <div className="kv"><span>Revealed deck order ({h.reveal.deck.length})</span></div>
      <CardRow cards={h.reveal.deck} size="sm" className="deck" />
    </div>
  );
}

const TIMER_OPTIONS = [15, 30, 45, 60, 90, 120, 180];

function cashPart(c: TableConfig) {
  const { mode: _m, tournament: _t, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

function HostPanel({ view, send }: { view: TableView; send: Send }) {
  const source = view.pendingConfig ?? view.config;
  const [draft, setDraft] = useState<TableConfig>(source);
  const key = JSON.stringify(source);
  useEffect(() => setDraft(source), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (k: keyof TableConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [k]: Number(e.target.value) });
  const maxPlayers = VARIANTS[draft.variant].maxPlayers;
  const players = view.seats.filter((s): s is SeatView => s !== null);
  const [delta, setDelta] = useState(100);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [moveAmt, setMoveAmt] = useState(10);
  const apply = () => {
    const cfg = { ...cashPart(draft), maxSeats: Math.max(2, Math.min(maxPlayers, draft.maxSeats)) };
    send("host:config", cfg);
  };
  const running = view.tournament?.status === "running";
  const modeSame = draft.mode === source.mode && (draft.mode === "cash" || JSON.stringify(draft.tournament) === JSON.stringify(source.tournament));
  const actingId = view.hand?.toActSeat != null ? view.seats[view.hand.toActSeat]?.playerId : null;
  const fromId = players.some((p) => p.playerId === from) ? from : "";
  const toId = players.some((p) => p.playerId === to) ? to : "";
  const canMove = fromId && toId && fromId !== toId && Number.isInteger(moveAmt) && moveAmt > 0;
  return (
    <div className="host">
      <div className="btn-row wrap">
        {view.status === "waiting" && <button className="btn call" onClick={() => send("host:start")}>Start game</button>}
        {view.status === "playing" && <button className="btn" onClick={() => send("host:pause", { paused: true })}>Pause</button>}
        {view.status === "paused" && <button className="btn call" onClick={() => send("host:pause", { paused: false })}>Resume</button>}
      </div>

      <h4>Settings</h4>
      {view.pendingConfig && <p className="note">Pending changes apply next hand.</p>}
      <div className="form">
        <label>Variant
          <select value={draft.variant} onChange={(e) => setDraft({ ...draft, variant: e.target.value as VariantId })}>
            {Object.values(VARIANTS).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label>Small blind<input type="number" min={1} value={draft.smallBlind} onChange={num("smallBlind")} /></label>
        <label>Big blind<input type="number" min={1} value={draft.bigBlind} onChange={num("bigBlind")} /></label>
        <label>Max seats (2–{maxPlayers})<input type="number" min={2} max={maxPlayers} value={draft.maxSeats} onChange={num("maxSeats")} /></label>
        <label>Action timer (sec, 0 = off)<input type="number" min={0} value={draft.actionTimeoutSec} onChange={num("actionTimeoutSec")} /></label>
        <label>Min buy-in<input type="number" min={1} value={draft.minBuyIn} onChange={num("minBuyIn")} /></label>
        <label>Max buy-in<input type="number" min={1} value={draft.maxBuyIn} onChange={num("maxBuyIn")} /></label>
        <label className="full">Pot awarding
          <select value={draft.awardMode} onChange={(e) => setDraft({ ...draft, awardMode: e.target.value as TableConfig["awardMode"] })}>
            <option value="auto">Automatic</option>
            <option value="host">Dealer decides</option>
          </select>
        </label>
      </div>
      <button className="btn small" disabled={JSON.stringify(cashPart(draft)) === JSON.stringify(cashPart(source))} onClick={apply}>Apply settings</button>
      <p className="muted small">Applies next hand if one is in progress.</p>

      <h4>Mode</h4>
      <div className="form">
        <label className="full">Game mode
          <select value={draft.mode} disabled={running} onChange={(e) => setDraft({ ...draft, mode: e.target.value as TableConfig["mode"] })}>
            <option value="cash">Cash</option>
            <option value="tournament">Tournament</option>
          </select>
        </label>
      </div>
      {draft.mode === "tournament" && (running
        ? <p className="muted small">The tournament is running; settings are locked.</p>
        : <TournamentEditor value={draft.tournament} onChange={(t) => setDraft({ ...draft, tournament: t })} />)}
      {!running && (
        <button className="btn small" disabled={modeSame || (draft.mode === "tournament" && !tournamentValid(draft.tournament))}
          onClick={() => send("host:config", draft.mode === "tournament" ? { mode: "tournament", tournament: draft.tournament } : { mode: "cash" })}>
          Apply
        </button>
      )}

      <h4>Move chips</h4>
      <div className="form">
        <label>From
          <select value={fromId} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Choose…</option>
            {players.map((p) => <option key={p.playerId} value={p.playerId}>{p.name} ({fmt(p.stack)})</option>)}
          </select>
        </label>
        <label>To
          <select value={toId} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose…</option>
            {players.map((p) => <option key={p.playerId} value={p.playerId}>{p.name} ({fmt(p.stack)})</option>)}
          </select>
        </label>
        <label>Amount<input type="number" min={1} value={moveAmt} onChange={(e) => setMoveAmt(Math.floor(Number(e.target.value)))} /></label>
        <label className="end"><button className="btn small" disabled={!canMove}
          onClick={() => send("host:transfer", { fromPlayerId: fromId, toPlayerId: toId, amount: moveAmt })}>Move chips</button></label>
      </div>

      <h4>Players</h4>
      <div className="adjust">
        <span>Stack adjust amount</span>
        <input type="number" min={1} value={delta} onChange={(e) => setDelta(Math.max(1, Number(e.target.value)))} />
      </div>
      {players.length === 0 && <p className="muted">Nobody is seated.</p>}
      {players.map((s) => (
        <div key={s.playerId} className="prow">
          <span className="pname"><Who avatar={s.avatar} name={s.name} /> <span className="muted">{fmt(s.stack)}</span></span>
          <button className="btn tiny" title="Remove chips" onClick={() => send("host:adjustStack", { playerId: s.playerId, delta: -delta })}>−</button>
          <button className="btn tiny" title="Add chips" onClick={() => send("host:adjustStack", { playerId: s.playerId, delta })}>+</button>
          {s.playerId !== view.you.playerId && (
            <button className="btn tiny danger" onClick={() => { if (confirm(`Kick ${s.name}?`)) send("host:kick", { playerId: s.playerId }); }}>Kick</button>
          )}
          <div className="psub">
            <label>⏱
              <select value={s.timeLimitSec === null ? "" : String(s.timeLimitSec)} aria-label={`Timer for ${s.name}`}
                onChange={(e) => send("host:playerTimer", { playerId: s.playerId, seconds: e.target.value === "" ? null : Number(e.target.value) })}>
                <option value="">Table default</option>
                <option value="0">No limit</option>
                {TIMER_OPTIONS.map((t) => <option key={t} value={t}>{t} s</option>)}
              </select>
            </label>
            {actingId === s.playerId && (
              <>
                {view.hand?.actionDeadline != null && <button className="btn tiny" onClick={() => send("host:addTime", { playerId: s.playerId, seconds: 30 })}>+30s</button>}
                <button className="btn tiny danger" onClick={() => send("host:forceTimeout", { playerId: s.playerId })}>Time out now</button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
