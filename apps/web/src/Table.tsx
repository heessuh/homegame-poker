import { VARIANTS } from "@homegame/engine";
import type { SeatView, TableView, WinnerView } from "@homegame/engine";
import { CardBack } from "./CardView";
import { CardFace } from "./CardView";
import { STUD_STREETS, fmt, isStud, totalPot } from "./util";
import { Avatar, useNow } from "./ui";
import type { Send } from "./App";

interface Props {
  view: TableView;
  onSit: (seat: number) => void;
  onMe: () => void;
  send: Send;
}

export function Table({ view, onSit, onMe, send }: Props) {
  const { config, hand, you } = view;
  const n = config.maxSeats;
  const anchor = you.seat ?? 0;
  const hasTimer = !!(hand?.actionDeadline && hand.toActSeat !== null);
  const now = useNow(hasTimer);
  const stud = isStud(config);
  const winnersByPlayer = new Map<string, WinnerView[]>();
  for (const w of hand?.winners ?? []) {
    winnersByPlayer.set(w.playerId, [...(winnersByPlayer.get(w.playerId) ?? []), w]);
  }
  const pot = totalPot(view);
  const pots = hand?.pots ?? [];

  let studStatus: string | null = null;
  if (stud && hand) {
    if (hand.stage === "exchange" && hand.toActSeat !== null) {
      const a = view.seats[hand.toActSeat];
      studStatus = a ? (a.playerId === you.playerId ? "You are exchanging…" : `${a.name} is exchanging…`) : null;
    } else if (hand.stage === "declare" || hand.phase === "declare") {
      const live = view.seats.filter((x): x is SeatView => !!x && x.inHand && !x.folded);
      const done = live.filter((x) => x.hasDeclared || x.declared !== null).length;
      studStatus = hand.winners ? null : `Declaring… ${done}/${live.length}`;
    }
  }

  const pos = (seat: number, rx: number, ry: number) => {
    const rel = (seat - anchor + n) % n;
    const theta = Math.PI / 2 + (rel * 2 * Math.PI) / n;
    return { x: 50 + rx * Math.cos(theta), y: 50 + ry * Math.sin(theta) };
  };

  return (
    <div className="table-wrap">
      <div className="felt">
        <div className="felt-inner" />
      </div>

      <div className="center">
        {hand ? (
          <>
            <div className="pot">
              Pot <b>{fmt(pot)}</b>
              {pots.length > 1 && (
                <span className="pots">
                  {pots.map((p, i) => (
                    <span key={i} className="potchip">{i === 0 ? "Main" : `Side ${i}`} {fmt(p.amount)}</span>
                  ))}
                </span>
              )}
            </div>
            {!stud && (
              <div className="board">
                {Array.from({ length: 5 }, (_, i) => {
                  const c = hand.board[i];
                  return c ? <CardFace key={i} card={c} size="md" /> : <div key={i} className="card slot md" />;
                })}
              </div>
            )}
            {stud && studStatus && <div className="studstatus">{studStatus}</div>}
            <div className="phase">Hand #{hand.handNumber} · {stud ? (STUD_STREETS[hand.phase] ?? hand.phase) : hand.phase}</div>
            {view.pendingAward && (
              <div className="await">
                {you.isHost ? `Award the pot (${fmt(view.pendingAward.amount)})` : `Waiting for the dealer to award the pot (${fmt(view.pendingAward.amount)})`}
              </div>
            )}
          </>
        ) : (
          <div className="waiting">
            <div className="big">{view.status === "paused" ? "Paused" : "Waiting for the game to start"}</div>
            <div className="muted">
              {VARIANTS[config.variant]?.name ?? config.variant} ·{" "}
              {isStud(config)
                ? `Ante ${fmt(config.stud.ante)} · bets up to ${fmt(config.stud.maxBet)}, last round ${fmt(config.stud.maxBetLastRound)}`
                : `${fmt(config.smallBlind)}/${fmt(config.bigBlind)}`}
            </div>
            {view.pendingAward && (
              <div className="await">
                {you.isHost ? `Award the pot (${fmt(view.pendingAward.amount)})` : `Waiting for the dealer to award the pot (${fmt(view.pendingAward.amount)})`}
              </div>
            )}
          </div>
        )}
      </div>

      {view.seats.map((s, i) => {
        const p = pos(i, 39, 37);
        const style = { left: `${p.x}%`, top: `${p.y}%` };
        if (!s) {
          return (
            <div key={i} className="seat empty" style={style}>
              {you.seat === null ? (
                <button className="sitbtn" onClick={() => onSit(i)}>Sit here</button>
              ) : (
                <span className="muted small">Open</span>
              )}
            </div>
          );
        }
        const isMe = s.playerId === you.playerId;
        const bp = pos(i, 39 * 0.62, 37 * 0.62);
        return (
          <SeatBlock
            key={i}
            s={s}
            isMe={isMe}
            style={style}
            toAct={hand?.toActSeat === i}
            deadline={hand?.actionDeadline ?? null}
            timeoutSec={s.timeLimitSec ?? config.actionTimeoutSec}
            isHost={you.isHost}
            send={send}
            onMe={onMe}
            now={now}
            stud={stud}
            wins={winnersByPlayer.get(s.playerId)}
            showdownDim={!!hand?.winners && !winnersByPlayer.has(s.playerId)}
            betPos={bp}
          />
        );
      })}
    </div>
  );
}

function SeatBlock(props: {
  s: SeatView; isMe: boolean; style: React.CSSProperties; toAct: boolean; deadline: number | null;
  timeoutSec: number; now: number; stud: boolean; wins?: WinnerView[]; showdownDim: boolean;
  betPos: { x: number; y: number }; isHost: boolean; send: Send; onMe: () => void;
}) {
  const { s, isMe, toAct, wins } = props;
  const size = isMe ? "lg" : "sm";
  const frac = toAct && props.deadline && props.timeoutSec > 0
    ? Math.max(0, Math.min(1, (props.deadline - props.now) / (props.timeoutSec * 1000)))
    : null;
  const secs = frac !== null && props.deadline ? Math.max(0, Math.ceil((props.deadline - props.now) / 1000)) : null;
  const hostCtl = props.isHost && toAct;
  const winTotal = wins?.reduce((a, w) => a + w.amount, 0) ?? 0;
  const cls = ["seat", isMe ? "me" : "", toAct ? "toact" : "", s.folded ? "folded" : "", s.sittingOut ? "out" : "",
    !s.connected ? "offline" : "", wins ? "winner" : "", props.showdownDim && !wins ? "loser" : ""].filter(Boolean).join(" ");

  const hasHole = !!s.holeCards && s.holeCards.length > 0;
  const live = s.inHand && !s.folded;
  const holeNodes: React.ReactNode[] = hasHole
    ? s.holeCards!.map((c, i) => <CardFace key={"h" + i + c} card={c} size={size} className={props.stud && isMe ? "mark-down" : ""} />)
    : live ? Array.from({ length: s.holeCount }, (_, i) => <CardBack key={"b" + i} size={size} />) : [];
  const upNodes = props.stud && !s.folded
    ? s.upCards.map((c, i) => <CardFace key={"u" + i + c} card={c} size={size} className={isMe ? "mark-up" : "up"} />)
    : [];
  let cards: React.ReactNode = null;
  if (props.stud && (holeNodes.length > 0 || upNodes.length > 0)) {
    cards = (
      <div className="studcards">
        {holeNodes.length > 0 && <div className="cardrow hole grp">{holeNodes}{isMe && <span className="cap">down</span>}</div>}
        {upNodes.length > 0 && <div className="cardrow hole up grp">{upNodes}{isMe && <span className="cap">up</span>}</div>}
      </div>
    );
  } else if (holeNodes.length > 0) {
    cards = <div className="cardrow hole">{holeNodes}</div>;
  }
  const declBadge = s.declared ? s.declared.toUpperCase() : null;

  return (
    <>
      <div className={cls} style={props.style}>
        {cards}
        <div className={`plate ${isMe ? "clickable" : ""}`} onClick={isMe ? props.onMe : undefined} title={isMe ? "Change avatar" : undefined}>
          <div className="name"><Avatar a={s.avatar} />{s.avatar ? " " : ""}{s.name}{isMe ? " (you)" : ""}</div>
          <div className="stack">{fmt(s.stack)}</div>
          {frac !== null && (
            <div className="timer" role="progressbar" aria-valuenow={secs ?? 0}>
              <i className={frac < 0.25 ? "low" : ""} style={{ width: `${frac * 100}%` }} />
            </div>
          )}
          <div className="tags">
            {declBadge && <span className="tag decl">{declBadge}</span>}
            {!declBadge && s.hasDeclared && <span className="tag decl ok" aria-label="Declared">✓</span>}
            {s.allIn && <span className="tag allin">All-in</span>}
            {s.folded && <span className="tag">Folded</span>}
            {s.sittingOut && <span className="tag">Sitting out</span>}
            {!s.connected && <span className="tag warn">Offline</span>}
            {s.timeLimitSec !== null && <span className="tag timelim">⏱ {s.timeLimitSec === 0 ? "off" : `${s.timeLimitSec}s`}</span>}
          </div>
        </div>
        {s.isButton && <span className="dealer" title="Dealer">D</span>}
        {wins ? (
          <div className="seat-note win">
            +{fmt(winTotal)}{wins.some((w) => w.half !== "whole") ? ` ${wins.map((w) => (w.half === "high" ? "High" : w.half === "low" ? "Low" : "")).filter(Boolean).join("+")}` : ""}{wins[0]?.handName ? ` · ${wins[0].handName}` : ""}
          </div>
        ) : s.lastAction ? (
          <div className={`seat-note ${hostCtl ? "shift" : ""}`}>{s.lastAction}</div>
        ) : null}
        {secs !== null && <div className="secs">{secs}s</div>}
        {hostCtl && (
          <div className="hostctl">
            {props.deadline !== null && <button onClick={() => props.send("host:addTime", { playerId: s.playerId, seconds: 30 })}>+30s</button>}
            <button className="danger" onClick={() => props.send("host:forceTimeout", { playerId: s.playerId })}>Time out</button>
          </div>
        )}
      </div>
      {s.bet > 0 && (
        <div className="bet" style={{ left: `${props.betPos.x}%`, top: `${props.betPos.y}%` }}>
          <span className="chip" />{fmt(s.bet)}
        </div>
      )}
    </>
  );
}
