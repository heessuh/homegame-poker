import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { DEFAULT_CONFIG } from "@homegame/engine";
import type { ClientToServerEvents, ServerToClientEvents, TableView } from "@homegame/engine";
import { Table } from "./Table";
import { ActionBar } from "./ActionBar";
import { SidePanel } from "./SidePanel";
import type { Tab } from "./SidePanel";
import { FIXTURE_LABELS, makeFixtures } from "./mock";
import type { FixtureId } from "./mock";
import { fmt, getPlayerToken, randomId, storeGet, storeSet } from "./util";

export type Send = <E extends keyof ClientToServerEvents>(ev: E, ...args: Parameters<ClientToServerEvents[E]>) => void;

const MOCK = new URLSearchParams(location.search).has("mock");

function useHash(): string {
  const [h, setH] = useState(() => decodeURIComponent(location.hash.slice(1)));
  useEffect(() => {
    const on = () => setH(decodeURIComponent(location.hash.slice(1)));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

export function App() {
  const tableId = useHash();
  const [name, setName] = useState(() => storeGet("hg.name") ?? "");
  const [joined, setJoined] = useState(() => !!storeGet("hg.name"));
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4500);
  }, []);

  let body: React.ReactNode;
  if (MOCK) body = <MockRoom showToast={showToast} />;
  else if (!tableId) body = <Landing />;
  else if (!joined || !name.trim()) {
    body = (
      <JoinForm
        tableId={tableId}
        initial={name}
        onJoin={(n) => { storeSet("hg.name", n); setName(n); setJoined(true); }}
      />
    );
  } else body = <LiveRoom tableId={tableId} name={name.trim()} showToast={showToast} />;

  return (
    <>
      {body}
      {toast && <div className="toast" role="alert" onClick={() => setToast(null)}>{toast}</div>}
    </>
  );
}

function Landing() {
  const [code, setCode] = useState("");
  const create = () => { location.hash = randomId(6); };
  const join = () => { const c = code.trim().replace(/^.*#/, ""); if (c) location.hash = c; };
  return (
    <main className="landing">
      <h1>Home Game Poker</h1>
      <p className="muted">A private table for friends. Hold’em and Omaha, no accounts.</p>
      <button className="btn call big" onClick={create}>Create a table</button>
      <div className="or">or</div>
      <form className="joinrow" onSubmit={(e) => { e.preventDefault(); join(); }}>
        <input placeholder="Table code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" />
        <button className="btn" type="submit" disabled={!code.trim()}>Join table</button>
      </form>
    </main>
  );
}

function JoinForm({ tableId, initial, onJoin }: { tableId: string; initial: string; onJoin: (n: string) => void }) {
  const [n, setN] = useState(initial);
  return (
    <main className="landing">
      <h1>Join table <code>{tableId}</code></h1>
      <form className="joinrow" onSubmit={(e) => { e.preventDefault(); if (n.trim()) onJoin(n.trim()); }}>
        <input placeholder="Your name" value={n} maxLength={20} autoFocus onChange={(e) => setN(e.target.value)} />
        <button className="btn call" type="submit" disabled={!n.trim()}>Join</button>
      </form>
      <a href="#" className="muted" onClick={(e) => { e.preventDefault(); location.hash = ""; }}>Back</a>
    </main>
  );
}

function LiveRoom({ tableId, name, showToast }: { tableId: string; name: string; showToast: (m: string) => void }) {
  const [view, setView] = useState<TableView | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  useEffect(() => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();
    socketRef.current = socket;
    const token = getPlayerToken();
    const doJoin = () => { setConnected(true); socket.emit("join", { tableId, name, playerToken: token }); };
    socket.on("connect", doJoin);
    socket.on("disconnect", () => setConnected(false));
    socket.on("state", setView);
    socket.on("error", (p) => showToast(p.message));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [tableId, name, showToast]);

  const send = useMemo<Send>(() => (ev, ...args) => {
    (socketRef.current?.emit as unknown as (e: string, ...a: unknown[]) => void)?.(ev, ...args);
  }, []);

  if (!view) return <main className="landing"><p className="muted">{connected ? "Joining table…" : "Connecting…"}</p></main>;
  return <Room view={view} send={send} connected={connected} />;
}

function MockRoom({ showToast }: { showToast: (m: string) => void }) {
  const [fixtures, setFixtures] = useState<Record<FixtureId, TableView> | null>(null);
  const [id, setId] = useState<FixtureId>("plo5-turn");
  useEffect(() => { void makeFixtures().then(setFixtures); }, []);
  const send = useMemo<Send>(() => (ev, ...args) => showToast(`[mock] ${ev} ${JSON.stringify(args[0] ?? {})}`), [showToast]);
  if (!fixtures) return <main className="landing"><p className="muted">Loading fixtures…</p></main>;
  return (
    <>
      <Room view={fixtures[id]} send={send} connected />
      <select className="mockpick" value={id} onChange={(e) => setId(e.target.value as FixtureId)} aria-label="Mock fixture">
        {(Object.keys(FIXTURE_LABELS) as FixtureId[]).map((k) => <option key={k} value={k}>{FIXTURE_LABELS[k]}</option>)}
      </select>
    </>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function AmountPrompt(props: { title: string; min: number; max: number; cta: string; onConfirm: (n: number) => void; onClose: () => void }) {
  const [v, setV] = useState(Math.min(props.max, Math.max(props.min, Math.round((props.min + props.max) / 2))));
  const ok = v >= props.min && v <= props.max;
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p className="muted">Between {fmt(props.min)} and {fmt(props.max)}</p>
      <input type="range" min={props.min} max={props.max} value={Math.min(props.max, Math.max(props.min, v))} onChange={(e) => setV(Number(e.target.value))} />
      <input className="amt wide" type="number" inputMode="numeric" value={v} min={props.min} max={props.max} onChange={(e) => setV(Number(e.target.value))} autoFocus />
      <div className="btn-row">
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn call" disabled={!ok} onClick={() => { props.onConfirm(v); props.onClose(); }}>{props.cta}</button>
      </div>
    </Modal>
  );
}

function Room({ view, send, connected }: { view: TableView; send: Send; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("log");
  const [sitSeat, setSitSeat] = useState<number | null>(null);
  const [rebuy, setRebuy] = useState(false);
  const me = view.you.seat !== null ? view.seats[view.you.seat] : null;
  const cfg = view.config ?? DEFAULT_CONFIG;
  const copy = () => {
    const url = location.origin + location.pathname + "#" + view.tableId;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <div className={`room ${open ? "panel-open" : ""}`}>
      <header className="top">
        <div className="title">
          <b>Table</b> <code>{view.tableId}</code>
          <span className={`pill ${view.status}`}>{view.status}</span>
          {!connected && <span className="pill warn">reconnecting…</span>}
        </div>
        <div className="top-actions">
          <button className="btn small" onClick={copy}>Copy link</button>
          <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Close" : "Menu"}</button>
        </div>
      </header>

      <div className="main">
        <section className="stage">
          <Table view={view} onSit={setSitSeat} />
          <ActionBar view={view} onAction={(a) => send("action", a)} />
          {me && (
            <div className="controls">
              <button className="btn small" onClick={() => send("stand")}>Stand up</button>
              <button className="btn small" onClick={() => send("sitOut", { sittingOut: !me.sittingOut })}>{me.sittingOut ? "Sit in" : "Sit out"}</button>
              <button className="btn small" onClick={() => setRebuy(true)}>Rebuy</button>
            </div>
          )}
        </section>
        <aside className="side">
          <SidePanel view={view} send={send} tab={tab} setTab={setTab} />
        </aside>
      </div>

      {sitSeat !== null && (
        <AmountPrompt title={`Sit at seat ${sitSeat + 1}`} min={cfg.minBuyIn} max={cfg.maxBuyIn} cta="Sit down"
          onConfirm={(n) => send("sit", { seat: sitSeat, buyIn: n })} onClose={() => setSitSeat(null)} />
      )}
      {rebuy && (
        <AmountPrompt title="Rebuy" min={cfg.minBuyIn} max={cfg.maxBuyIn} cta="Rebuy"
          onConfirm={(n) => send("rebuy", { amount: n })} onClose={() => setRebuy(false)} />
      )}
    </div>
  );
}
