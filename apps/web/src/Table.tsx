import { VARIANTS } from "@homegame/engine";
import type { SeatView, TableView, WinnerView } from "@homegame/engine";
import { CardBack, CardRow } from "./CardView";
import { CardFace } from "./CardView";
import { fmt, totalPot } from "./util";
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
  const holeCount = VARIANTS[config.variant].holeCards;
  const winnersByPlayer = new Map<string, WinnerView[]>();
  for (const w of hand?.winners ?? []) {
    winnersByPlayer.set(w.playerId, [...(winnersByPlayer.get(w.playerId) ?? []), w]);
  }
  const pot = totalPot(view);
  const pots = hand?.pots ?? [];

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
            <div className="board">
              {Array.from({ length: 5 }, (_, i) => {
                const c = hand.board[i];
                return c ? <CardFace key={i} card={c} size="md" /> : <div key={i} className="card slot md" />;
              })}
            </div>
            <div className="phase">Hand #{hand.handNumber} · {hand.phase}</div>
            {view.pendingAward && (
              <div className="await">
                {you.isHost ? `Award the pot (${fmt(view.pendingAward.amount)})` : `Waiting for the dealer to award the pot (${fmt(view.pendingAward.amount)})`}
              </div>
            )}
          </>
        ) : (
          <div className="waiting">
            <div className="big">{view.status === "paused" ? "Paused" : "Waiting for the game to start"}</div>
            <div className="muted">{VARIANTS[config.variant].name} · {config.smallBlind}/{config.bigBlind}</div>
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
            holeCount={holeCount}
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
  timeoutSec: number; now: number; holeCount: number; wins?: WinnerView[]; showdownDim: boolean;
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

  let cards: React.ReactNode = null;
  if (s.holeCards && s.holeCards.length > 0) {
    cards = <CardRow cards={s.holeCards} size={size} className="hole" />;
  } else if (s.inHand && !s.folded) {
    cards = (
      <div className="cardrow hole">
        {Array.from({ length: props.holeCount }, (_, i) => <CardBack key={i} size={size} />)}
      </div>
    );
  }

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
            +{fmt(winTotal)}{wins[0]?.handName ? ` · ${wins[0].handName}` : ""}
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
