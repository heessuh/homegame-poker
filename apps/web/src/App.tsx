import { useDealerWatch } from "./DealerLog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { DEFAULT_CONFIG, VARIANTS } from "@homegame/engine";
import type { VariantId } from "@homegame/engine";
import type { ClientToServerEvents, ServerToClientEvents, TableView } from "@homegame/engine";
import { Table } from "./Table";
import { ActionBar } from "./ActionBar";
import { SidePanel } from "./SidePanel";
import type { Tab } from "./SidePanel";
import { FIXTURE_LABELS, makeFixtures } from "./mock";
import type { FixtureId } from "./mock";
import { AwardPanel } from "./Award";
import { TournamentHud } from "./Tournament";
import { Avatar, AvatarPicker, Modal, MoneyInput, Wordmark, loadAvatar, saveAvatar } from "./ui";
import { newClientSeed, rememberSeed } from "./fairness";
import { FairWatch } from "./FairBanner";
import { fmt, getPlayerToken, setMoneyMode, randomId, storeGet, storeSet } from "./util";

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
  const [avatar, setAvatar] = useState<string | null>(() => loadAvatar());
  const changeAvatar = useCallback((a: string | null) => { saveAvatar(a); setAvatar(a); }, []);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), m.length > 60 ? 12000 : 4500);
  }, []);

  let body: React.ReactNode;
  if (MOCK) body = <MockRoom showToast={showToast} avatar={avatar} onAvatar={changeAvatar} />;
  else if (!tableId) body = <Landing />;
  else if (!joined || !name.trim()) {
    body = (
      <JoinForm
        tableId={tableId}
        initial={name}
        avatar={avatar}
        onAvatar={changeAvatar}
        onJoin={(n) => { storeSet("hg.name", n); setName(n); setJoined(true); }}
      />
    );
  } else body = <LiveRoom tableId={tableId} name={name.trim()} avatar={avatar} onAvatar={changeAvatar} showToast={showToast} />;

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
      <h1><Wordmark size="lg" /></h1>
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

function JoinForm({ tableId, initial, avatar, onAvatar, onJoin }: { tableId: string; initial: string; avatar: string | null; onAvatar: (a: string | null) => void; onJoin: (n: string) => void }) {
  const [n, setN] = useState(initial);
  const [picking, setPicking] = useState(false);
  return (
    <main className="landing">
      <h1>Join table <code>{tableId}</code></h1>
      <form className="joinrow" onSubmit={(e) => { e.preventDefault(); if (n.trim()) onJoin(n.trim()); }}>
        <input placeholder="Your name" value={n} maxLength={20} autoFocus onChange={(e) => setN(e.target.value)} />
        <button className="btn call" type="submit" disabled={!n.trim()}>Join</button>
      </form>
      <button type="button" className="btn avbtn" onClick={() => setPicking(true)}>
        {avatar ? <><Avatar a={avatar} /> Change avatar</> : "Pick an avatar (optional)"}
      </button>
      {picking && <AvatarPicker current={avatar} onPick={onAvatar} onClose={() => setPicking(false)} />}
      <a href="#" className="muted" onClick={(e) => { e.preventDefault(); location.hash = ""; }}>Back</a>
    </main>
  );
}

function LiveRoom({ tableId, name, avatar, onAvatar, showToast }: { tableId: string; name: string; avatar: string | null; onAvatar: (a: string | null) => void; showToast: (m: string) => void }) {
  const avatarRef = useRef(avatar);
  avatarRef.current = avatar;
  const [view, setView] = useState<TableView | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  useEffect(() => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();
    socketRef.current = socket;
    const token = getPlayerToken();
    const doJoin = () => { setConnected(true); socket.emit("join", { tableId, name, playerToken: token, avatar: avatarRef.current }); };
    socket.on("connect", doJoin);
    socket.on("disconnect", () => setConnected(false));
    socket.on("state", setView);
    socket.on("error", (p) => showToast(p.message));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [tableId, name, showToast]);

  const send = useMemo<Send>(() => (ev, ...args) => {
    (socketRef.current?.emit as unknown as (e: string, ...a: unknown[]) => void)?.(ev, ...args);
  }, []);

  // Provably fair shuffle: every new server-seed commitment is answered once with a fresh random client seed.
  const fairSeen = useRef<string | null>(null);
  const fair = view?.fairness ?? null;
  useEffect(() => {
    if (!fair) return;
    const key = `${tableId}|${fair.nextHandNumber}|${fair.serverSeedHash}`;
    if (fairSeen.current === key) return;
    fairSeen.current = key;
    const clientSeed = newClientSeed();
    rememberSeed({ tableId: view!.tableId, handNumber: fair.nextHandNumber, serverSeedHash: fair.serverSeedHash, clientSeed });
    send("seed", { handNumber: fair.nextHandNumber, clientSeed });
  }, [fair?.nextHandNumber, fair?.serverSeedHash, send, tableId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return <main className="landing"><p className="muted">{connected ? "Joining table…" : "Connecting…"}</p></main>;
  return <><FairWatch view={view} /><Room view={view} send={send} connected={connected} avatar={avatar} onAvatar={onAvatar} /></>;
}

function MockRoom({ showToast, avatar, onAvatar }: { showToast: (m: string) => void; avatar: string | null; onAvatar: (a: string | null) => void }) {
  const [fixtures, setFixtures] = useState<Record<FixtureId, TableView> | null>(null);
  const [id, setId] = useState<FixtureId>("plo5-turn");
  const fixturesRef = useRef<Record<FixtureId, TableView> | null>(null);
  const idRef = useRef<FixtureId>(id);
  idRef.current = id;
  fixturesRef.current = fixtures;
  useEffect(() => { void makeFixtures().then(setFixtures); }, []);
  const send = useMemo<Send>(() => (ev, ...args) => {
    // Mock acks so History and the full log work without a server.
    if (ev === "getHand") {
      const f = fixturesRef.current?.[idRef.current];
      const num = (args[0] as { handNumber: number }).handNumber;
      const base = f?.lastHand ?? null;
      (args[1] as (r: unknown) => void)(base ? { ...base, handNumber: num } : null);
      return;
    }
    if (ev === "getDealerLog") {
      (args[0] as (l: unknown[]) => void)([]);
      return;
    }
    if (ev === "getLog") {
      const f = fixturesRef.current?.[idRef.current];
      const lines = f ? [...f.log, ...f.log, ...f.log].map((l, i) => `[${String(i + 1).padStart(3, "0")}] ${l}`) : [];
      (args[0] as (l: string[]) => void)(lines);
      return;
    }
    showToast(`[mock] ${ev} ${JSON.stringify(args[0] ?? {})}`);
  }, [showToast]);
  if (!fixtures) return <main className="landing"><p className="muted">Loading fixtures…</p></main>;
  return (
    <>
      <Room view={fixtures[id]} send={send} connected avatar={avatar} onAvatar={onAvatar} />
      <select className="mockpick" value={id} onChange={(e) => setId(e.target.value as FixtureId)} aria-label="Mock fixture">
        {(Object.keys(FIXTURE_LABELS) as FixtureId[]).map((k) => <option key={k} value={k}>{FIXTURE_LABELS[k]}</option>)}
      </select>
    </>
  );
}

function FixedStack(props: { title: string; stack: number; cta: string; blocked?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p className="startstack">Starting stack: <b>{fmt(props.stack)}</b></p>
      {props.blocked && <p className="note">{props.blocked}</p>}
      <div className="btn-row">
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn call" disabled={!!props.blocked} onClick={() => { props.onConfirm(); props.onClose(); }}>{props.cta}</button>
      </div>
    </Modal>
  );
}

function AmountPrompt(props: { title: string; min: number; max: number; cta: string; onConfirm: (n: number) => void; onClose: () => void }) {
  const [v, setV] = useState(Math.min(props.max, Math.max(props.min, Math.round((props.min + props.max) / 2))));
  const ok = v >= props.min && v <= props.max;
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p className="muted">Between {fmt(props.min)} and {fmt(props.max)}</p>
      <input type="range" min={props.min} max={props.max} value={Math.min(props.max, Math.max(props.min, v))} style={{ ["--pct" as string]: `${props.max > props.min ? ((Math.min(props.max, Math.max(props.min, v)) - props.min) / (props.max - props.min)) * 100 : 100}%` }} onChange={(e) => setV(Number(e.target.value))} />
      <MoneyInput className="amt wide" value={v} min={props.min} max={props.max} onChange={setV} label="Amount" autoFocus />
      <div className="btn-row">
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn call" disabled={!ok} onClick={() => { props.onConfirm(v); props.onClose(); }}>{props.cta}</button>
      </div>
    </Modal>
  );
}

function Room({ view, send, connected, avatar, onAvatar }: { view: TableView; send: Send; connected: boolean; avatar: string | null; onAvatar: (a: string | null) => void }) {
  setMoneyMode(view.config);
  const dealerWatch = useDealerWatch(view, send);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("log");
  const [sitSeat, setSitSeat] = useState<number | null>(null);
  const [pickAvatar, setPickAvatar] = useState(false);
  const me = view.you.seat !== null ? view.seats[view.you.seat] : null;
  const cfg = view.config ?? DEFAULT_CONFIG;
  const isTourney = cfg.mode === "tournament";
  const startStack = view.tournament?.startingStack ?? cfg.tournament.startingStack;
  const lateClosed = view.tournament ? view.tournament.status === "finished" || (view.tournament.status === "running" && !view.tournament.lateRegOpen) : false;
  const changeAvatar = (a: string | null) => { onAvatar(a); send("setAvatar", { avatar: a }); };
  const pendingVariant = view.pendingConfig && view.pendingConfig.variant !== cfg.variant ? view.pendingConfig.variant : null;
  const copy = () => {
    const url = location.origin + location.pathname + "#" + view.tableId;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <div className={`room ${open ? "panel-open" : ""}`}>
      {dealerWatch.alert && (
        <div className="ledger-banner" role="alert">
          <span><b>Dealer log warning:</b> {dealerWatch.alert} The host’s record of actions may have been altered.</span>
          <button className="btn small" onClick={dealerWatch.dismiss}>Dismiss</button>
        </div>
      )}
      {view.siteNotice && <div className="site-notice" role="status">{view.siteNotice}</div>}
      <header className="top">
        <div className="title">
          <Wordmark /> <code>{view.tableId}</code>
          <span className={`pill ${view.status}`}>{view.status}</span>
          {!connected && <span className="pill warn">reconnecting…</span>}
          {view.you.isHost ? (
            <select className="gamepick" value={cfg.variant} aria-label="Game"
              onChange={(e) => send("host:config", { variant: e.target.value as VariantId })}>
              {Object.values(VARIANTS).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          ) : <span className="gamename">{VARIANTS[cfg.variant]?.name ?? cfg.variant}</span>}
          {pendingVariant && <span className="pill warn">Next hand: {VARIANTS[pendingVariant]?.name ?? pendingVariant}</span>}
        </div>
        <div className="top-actions">
          <button className="btn small" onClick={copy}>Copy link</button>
          <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Close" : "Menu"}</button>
        </div>
      </header>

      <div className="main">
        <section className="stage">
          <TournamentHud view={view} send={send} />
          <Table view={view} onSit={setSitSeat} onMe={() => setPickAvatar(true)} send={send} />
          {view.you.isHost && view.pendingAward && <AwardPanel view={view} pa={view.pendingAward} send={send} />}
          <ActionBar view={view} onAction={(a) => send("action", a)} onExtend={() => send("extendTime")} />
          {me && !isTourney && me.stack === 0 && !me.inHand && (
            <p className="note busted" role="status">Out of chips — ask the dealer for a rebuy.</p>
          )}
          {me && (
            <div className="controls">
              <button className="btn small" onClick={() => send("stand")}>Stand up</button>
              <button className="btn small" onClick={() => send("sitOut", { sittingOut: !me.sittingOut })}>{me.sittingOut ? "Sit in" : "Sit out"}</button>
              <button className="btn small" onClick={() => setPickAvatar(true)}>Avatar</button>
            </div>
          )}
        </section>
        <aside className="side">
          <SidePanel view={view} send={send} tab={tab} setTab={setTab} />
        </aside>
      </div>

      {sitSeat !== null && isTourney && (
        <FixedStack title={`Sit at seat ${sitSeat + 1}`} stack={startStack} cta="Sit down"
          blocked={lateClosed ? "Registration is closed." : undefined}
          onConfirm={() => send("sit", { seat: sitSeat, buyIn: startStack })} onClose={() => setSitSeat(null)} />
      )}
      {sitSeat !== null && !isTourney && (
        <AmountPrompt title={`Sit at seat ${sitSeat + 1}`} min={cfg.minBuyIn} max={cfg.maxBuyIn} cta="Sit down"
          onConfirm={(n) => send("sit", { seat: sitSeat, buyIn: n })} onClose={() => setSitSeat(null)} />
      )}
      {pickAvatar && <AvatarPicker current={me?.avatar ?? avatar} onPick={changeAvatar} onClose={() => setPickAvatar(false)} />}
    </div>
  );
}
