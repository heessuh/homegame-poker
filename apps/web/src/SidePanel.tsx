import { useEffect, useRef, useState } from "react";
import { DEFAULT_HOUSE_LIMIT, DEFAULT_STUD, VARIANTS, VERIFIER_URL } from "@homegame/engine";
import type { HouseLimit, SeatView, StudStakes, TableConfig, TableView, VariantId } from "@homegame/engine";
import { CardRow } from "./CardView";
import type { Send } from "./App";
import { fmt, fmtWith, isStud, sha256Hex, shortGame } from "./util";
import type { Card, HandRecord } from "@homegame/engine";
import { MoneyInput, Who, avatarOf } from "./ui";
import { fairnessExport, verifyFairness, type FairCheck } from "./fairness";
import { RngAudit } from "./RngAudit";
import { Standings, TournamentEditor, tournamentValid } from "./Tournament";

export type Tab = "log" | "ledger" | "last" | "history" | "standings" | "host" | "fairness";

export function SidePanel({ view, send, tab, setTab }: { view: TableView; send: Send; tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: [Tab, string][] = [["log", "Log"], ["ledger", "Ledger"], ["history", "History"], ["last", "Last hand"], ["fairness", "Fairness"]];
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
        {tab === "log" && <Log lines={view.log} send={send} tableId={view.tableId} />}
        {tab === "history" && <History view={view} send={send} />}
        {tab === "ledger" && <Ledger view={view} />}
        {tab === "standings" && <Standings view={view} />}
        {tab === "last" && <LastHand view={view} />}
        {tab === "fairness" && <RngAudit send={send} handCount={view.handList.length} />}
        {tab === "host" && view.you.isHost && <HostPanel view={view} send={send} />}
      </div>
    </div>
  );
}

function Log({ lines, send, tableId }: { lines: string[]; send: Send; tableId: string }) {
  const end = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!full) end.current?.scrollIntoView({ block: "nearest" }); }, [lines.length, full]);
  const load = () => {
    setBusy(true);
    send("getLog", (l) => { setFull(l); setBusy(false); });
  };
  const download = () => {
    const text = (full ?? lines).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mochapoker-${tableId}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const shown = full ?? lines;
  return (
    <div>
      <div className="btn-row wrap logbtns">
        {!full
          ? <button className="btn small" disabled={busy} onClick={load}>{busy ? "Loading…" : "Full session log"}</button>
          : <button className="btn small" onClick={() => setFull(null)}>Back to recent</button>}
        <button className="btn small" onClick={download}>Download log</button>
      </div>
      {full && <p className="muted small">Whole session · {full.length} lines</p>}
      {shown.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <div className="log">
          {shown.map((l, i) => <div key={i}>{l}</div>)}
          <div ref={end} />
        </div>
      )}
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
  if (!h) return <p className="muted">No completed hands yet.</p>;
  return <HandDetail h={h} view={view} />;
}

function History({ view, send }: { view: TableView; send: Send }) {
  const [sel, setSel] = useState<number | null>(null);
  const [rec, setRec] = useState<HandRecord | null | undefined>(undefined); // undefined = loading
  const open = (n: number) => {
    setSel(n);
    setRec(undefined);
    send("getHand", { handNumber: n }, (r) => setRec(r));
  };
  const [busy, setBusy] = useState(false);
  // Session download: every hand's fairness data in the format the standalone verifier accepts.
  const downloadAll = async () => {
    setBusy(true);
    const recs = await Promise.all(view.handList.map((h) => new Promise<HandRecord | null>((res) => send("getHand", { handNumber: h.handNumber }, res))));
    const data = fairnessExport(recs.filter((r): r is HandRecord => !!r), view.tableId, view.you.playerId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mochapoker-fairness-${view.tableId}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBusy(false);
  };
  if (sel !== null) {
    return (
      <div>
        <button className="btn small" onClick={() => setSel(null)}>← All hands</button>
        {rec === undefined && <p className="muted">Loading hand #{sel}…</p>}
        {rec === null && <p className="muted">Hand #{sel} is no longer available.</p>}
        {rec && <HandDetail h={rec} view={view} />}
      </div>
    );
  }
  if (view.handList.length === 0) return <p className="muted">No finished hands yet.</p>;
  return (
    <>
    <div className="btn-row wrap logbtns">
      <button className="btn small" disabled={busy} onClick={downloadAll}>{busy ? "Collecting…" : "Download all hands (fairness data)"}</button>
      <a className="btn small" href={VERIFIER_URL} target="_blank" rel="noreferrer">Check it yourself</a>
    </div>
    <ul className="hlist">
      {view.handList.map((h) => (
        <li key={h.handNumber}>
          <button type="button" className="hitem" onClick={() => open(h.handNumber)}>
            <span className="hn">#{h.handNumber}</span>
            <span className="hg">{shortGame(VARIANTS[h.variant]?.name ?? h.variant)}</span>
            <span className="ht">{new Date(h.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            <span className="hp">Pot {fmt(h.pot)}</span>
            <span className="hr">{h.result}</span>
          </button>
        </li>
      ))}
    </ul>
    </>
  );
}

function HandDetail({ h, view }: { h: HandRecord; view: TableView }) {
  const [result, setResult] = useState<null | { ok: boolean; computed?: string; error?: string }>(null);
  const [fair, setFair] = useState<FairCheck[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { setResult(null); setFair(null); setCopied(null); }, [h.handNumber]);
  const copyFair = async () => {
    const text = JSON.stringify(fairnessExport([h], view.tableId, view.you.playerId), null, 2);
    try { await navigator.clipboard.writeText(text); setCopied("Copied. Paste it into the verifier."); }
    catch { setCopied("Could not copy; use “Download all hands” in History instead."); }
  };
  const verifyFair = async () => setFair(await verifyFairness(h, view.tableId, view.you.playerId));
  const verify = async () => {
    try {
      const computed = await sha256Hex(`${h.reveal.salt}:${h.reveal.deck.join(",")}`);
      setResult({ ok: computed.toLowerCase() === h.deckHash.toLowerCase(), computed });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const name = (id: string) => h.names?.[id] ?? view.ledger.find((l) => l.playerId === id)?.name ?? id;
  const shown = Object.entries(h.shown ?? {}) as [string, Card[]][];
  const winIds = new Set(h.winners.map((w) => w.playerId));
  return (
    <div className="lasthand">
      <h4>Hand #{h.handNumber} · {VARIANTS[h.variant]?.name ?? h.variant}</h4>
      {h.endedAt > 0 && <p className="muted small">{new Date(h.endedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>}
      {h.board.length > 0 && <CardRow cards={h.board} size="sm" className="flat" />}
      {shown.length > 0 && (
        <>
          <h4>{h.board.length > 0 ? "Shown hands" : "Cards"}</h4>
          {shown.map(([id, cards]) => (
            <div key={id} className="shownrow">
              <span className={winIds.has(id) ? "pos" : ""}>{name(id)}{winIds.has(id) ? " ★" : ""}</span>
              <CardRow cards={cards} size="sm" className="flat" />
            </div>
          ))}
        </>
      )}
      <h4>Winners</h4>
      <ul className="summary">
        {h.winners.map((w, i) => (
          <li key={i}>
            <b>{name(w.playerId)}</b> won {fmt(w.amount)}
            {w.half !== "whole" ? ` (${w.half})` : ""}{w.handName ? ` with ${w.handName}` : ""}
          </li>
        ))}
      </ul>
      <h4>Summary</h4>
      <ul className="summary">{h.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
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
      {h.fair && (
        <>
          <div className="kv"><span>Server seed (revealed)</span><code>{h.fair.serverSeed}</code></div>
          <div className="kv"><span>Seed commitment</span><code>{h.fair.serverSeedHash}</code></div>
          <div className="kv"><span>Player seeds ({Object.keys(h.fair.clientSeeds).length})</span></div>
          {Object.entries(h.fair.clientSeeds).map(([id, sd]) => <div key={id} className="kv"><span>{name(id)}</span><code>{sd}</code></div>)}
        </>
      )}
      <div className="btn-row wrap">
        <button className="btn small" onClick={verifyFair}>Verify fairness</button>
        {h.fair && <button className="btn small" onClick={copyFair}>Copy fairness data</button>}
        {h.fair && <a className="btn small" href={VERIFIER_URL} target="_blank" rel="noreferrer">Check it yourself</a>}
      </div>
      {copied && <p className="muted small" role="status">{copied}</p>}
      {fair && (
        <ul className="fairchecks">
          {fair.map((c, i) => (
            <li key={i} className={c.ok === null ? "" : c.ok ? "ok" : "bad"}>
              <b>{c.ok === null ? "–" : c.ok ? "✓" : "✗"} {c.label}</b>
              <span className="muted small">{c.detail}</span>
            </li>
          ))}
        </ul>
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
  const stud = isStud(draft);
  const studCfg: StudStakes = draft.stud ?? DEFAULT_STUD;
  const dol = draft.money === "cents" && draft.mode !== "tournament";
  const setStudN = (k: keyof StudStakes) => (n: number) => setDraft({ ...draft, stud: { ...studCfg, [k]: n } });
  const setStudInt = (k: keyof StudStakes) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, stud: { ...studCfg, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) } });
  const hl: HouseLimit = draft.houseLimit ?? DEFAULT_HOUSE_LIMIT;
  const setHl = (patch: Partial<HouseLimit>) => setDraft({ ...draft, houseLimit: { ...hl, ...patch } });
  const money = (k: "smallBlind" | "bigBlind" | "minBuyIn" | "maxBuyIn") => (n: number) => setDraft({ ...draft, [k]: n });
  const problems: string[] = [];
  if (!stud && draft.smallBlind > draft.bigBlind) problems.push("Small blind can’t be bigger than the big blind.");
  if (draft.minBuyIn > draft.maxBuyIn) problems.push("Min buy-in can’t be bigger than the max buy-in.");
  if (stud && (studCfg.minBet < 1 || studCfg.minBet > studCfg.maxBet || studCfg.maxBet > studCfg.maxBetLastRound)) problems.push("Bets need min ≤ max ≤ last-round max, and min at least one cent.");
  if (!stud && hl.enabled && (hl.minBet < 1 || hl.minBet > hl.maxBet)) problems.push("House limit: min bet must be at least one cent and no more than the max.");
  const t = draft.actionTimeoutSec;
  if (!Number.isInteger(t) || (t !== 0 && (t < 5 || t > 300))) problems.push("Action timer must be 0 (off) or 5 to 300 seconds.");
  const ex = draft.extensionSec;
  if (!Number.isInteger(ex) || ex < 0 || ex > 300) problems.push("Player extension must be 0 (off) to 300 seconds.");
  const maxPlayers = VARIANTS[draft.variant].maxPlayers;
  const players = view.seats.filter((s): s is SeatView => s !== null);
  const [rebuyAmt, setRebuyAmt] = useState<Record<string, number>>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [moveAmt, setMoveAmt] = useState(1000);
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
        <label className="full">Money display
          <select value={draft.money} onChange={(e) => setDraft({ ...draft, money: e.target.value as TableConfig["money"] })}>
            <option value="cents">Dollars &amp; cents (1 chip = 1¢)</option>
            <option value="chips">Plain chips</option>
          </select>
        </label>
        {!stud && <label>Small blind<MoneyInput dollars={dol} value={draft.smallBlind} min={1} onChange={money("smallBlind")} label="Small blind" /></label>}
        {!stud && <label>Big blind<MoneyInput dollars={dol} value={draft.bigBlind} min={1} onChange={money("bigBlind")} label="Big blind" /></label>}
        <label>Max seats (2–{maxPlayers})<input type="number" min={2} max={maxPlayers} value={draft.maxSeats} onChange={num("maxSeats")} /></label>
        <label>Action timer (seconds, 0 = off, else 5–300)<input type="number" min={0} max={300} value={draft.actionTimeoutSec} onChange={num("actionTimeoutSec")} /></label>
        <label>Player extension (seconds, 0 = off)<input type="number" min={0} max={300} value={draft.extensionSec} onChange={num("extensionSec")} /></label>
        <label>Min buy-in<MoneyInput dollars={dol} value={draft.minBuyIn} min={1} onChange={money("minBuyIn")} label="Min buy-in" /></label>
        <label>Max buy-in<MoneyInput dollars={dol} value={draft.maxBuyIn} min={1} onChange={money("maxBuyIn")} label="Max buy-in" /></label>
        {!stud && (
          <div className="houseblock">
            <h5>House limit</h5>
            <label className="check full"><input type="checkbox" checked={hl.enabled} onChange={(e) => setHl({ enabled: e.target.checked })} />House limit on</label>
            {hl.enabled && (
              <>
                <label>Min bet<MoneyInput dollars={dol} value={hl.minBet} min={1} onChange={(n) => setHl({ minBet: n })} label="House limit min bet" /></label>
                <label>Max bet per bet/raise<MoneyInput dollars={dol} value={hl.maxBet} min={1} onChange={(n) => setHl({ maxBet: n })} label="House limit max bet" /></label>
                <label>Max raises per round<input type="number" min={0} value={hl.maxRaises} onChange={(e) => setHl({ maxRaises: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
                <label className="check"><input type="checkbox" checked={hl.raiseMustExceed} onChange={(e) => setHl({ raiseMustExceed: e.target.checked })} />Each raise must be bigger than the last</label>
                <p className="muted small">Each bet or raise can be up to {fmtWith(hl.maxBet, dol, true)}; at most {hl.maxRaises} raises per round{hl.raiseMustExceed ? "; each raise must be more than the previous bet or raise" : ""}.</p>
              </>
            )}
          </div>
        )}
        {stud && (
          <div className="studbox">
            <h5>5-Murder stakes</h5>
            <label>Ante<MoneyInput dollars={dol} value={studCfg.ante} onChange={setStudN("ante")} label="Ante" /></label>
            <label>Min bet<MoneyInput dollars={dol} value={studCfg.minBet} min={1} onChange={setStudN("minBet")} label="Min bet" /></label>
            <label>Max bet (rounds 1–5, exchange 1)<MoneyInput dollars={dol} value={studCfg.maxBet} min={1} onChange={setStudN("maxBet")} label="Max bet" /></label>
            <label>Max bet, last round<MoneyInput dollars={dol} value={studCfg.maxBetLastRound} min={1} onChange={setStudN("maxBetLastRound")} label="Max bet in the last round" /></label>
            <label>Face-down exchange cost<MoneyInput dollars={dol} value={studCfg.downExchangeCost} onChange={setStudN("downExchangeCost")} label="Face-down exchange cost" /></label>
            <label>Max raises per round<input type="number" min={0} value={studCfg.maxRaises} onChange={setStudInt("maxRaises")} /></label>
            <label className="check full"><input type="checkbox" checked={studCfg.raiseMustExceed} onChange={(e) => setDraft({ ...draft, stud: { ...studCfg, raiseMustExceed: e.target.checked } })} />Each raise must be bigger than the last</label>
            <label>Showdown
              <select value={studCfg.declare ? "declare" : "speak"} onChange={(e) => setDraft({ ...draft, stud: { ...studCfg, declare: e.target.value === "declare" } })}>
                <option value="declare">Declare (High/Low/Both)</option>
                <option value="speak">Cards speak</option>
              </select>
            </label>
          </div>
        )}
        <label className="full">Pot awarding
          <select value={draft.awardMode} onChange={(e) => setDraft({ ...draft, awardMode: e.target.value as TableConfig["awardMode"] })}>
            <option value="host">Dealer decides (default)</option>
            <option value="auto">Automatic</option>
          </select>
        </label>
      </div>
      {problems.map((p) => <p key={p} className="note">{p}</p>)}
      <button className="btn small" disabled={problems.length > 0 || JSON.stringify(cashPart(draft)) === JSON.stringify(cashPart(source))} onClick={apply}>Apply settings</button>
      <p className="muted small">Applies next hand if one is in progress.</p>
      <div className="defaults">
        <button className="btn small" onClick={() => send("host:saveDefaults")}>Save as house defaults</button>
        <p className="muted small">New tables will start with these settings.</p>
      </div>

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
        <label>Amount<MoneyInput value={moveAmt} min={1} onChange={setMoveAmt} label="Amount to move" /></label>
        <label className="end"><button className="btn small" disabled={!canMove}
          onClick={() => send("host:transfer", { fromPlayerId: fromId, toPlayerId: toId, amount: moveAmt })}>Move chips</button></label>
      </div>

      <h4>Players</h4>
      <p className="muted small">Rebuys and cash-outs are dealer-only and go into the ledger. They apply between hands (queued during a hand).</p>
      {players.length === 0 && <p className="muted">Nobody is seated.</p>}
      {players.map((s) => (
        <div key={s.playerId} className="prow">
          <span className="pname"><Who avatar={s.avatar} name={s.name} /> <span className="muted">{fmt(s.stack)}</span>{s.stack === 0 && !s.inHand && <span className="muted"> · out of chips</span>}</span>
          <div className="pmoney">
            <MoneyInput value={rebuyAmt[s.playerId] ?? view.config.minBuyIn} min={1} onChange={(n) => setRebuyAmt((m) => ({ ...m, [s.playerId]: n }))} label={`Rebuy or cash-out amount for ${s.name}`} />
            <button className="btn tiny call" title="Record a buy-in and add these chips to the stack"
              onClick={() => send("host:adjustStack", { playerId: s.playerId, delta: rebuyAmt[s.playerId] ?? view.config.minBuyIn })}>Rebuy</button>
            <button className="btn tiny" title="Record a cash-out and remove these chips from the stack"
              onClick={() => send("host:adjustStack", { playerId: s.playerId, delta: -(rebuyAmt[s.playerId] ?? view.config.minBuyIn) })}>Cash out</button>
          </div>
          <button
            className="btn tiny"
            title={s.sittingOut ? "Deal this player back in" : "Mark this player as away"}
            onClick={() => send("host:sitOut", { playerId: s.playerId, sittingOut: !s.sittingOut })}
          >
            {s.sittingOut ? "Sit in" : "Sit out"}
          </button>
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
