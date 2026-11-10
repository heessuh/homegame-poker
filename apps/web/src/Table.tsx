import { useRef } from "react";
import { VARIANTS, tkoPoints } from "@homegame/engine";
import type { SeatView, TableView, WinnerView } from "@homegame/engine";
import { CardBack } from "./CardView";
import { CardFace } from "./CardView";
import { STUD_STREETS, fmt, isStud, rabbitCards, totalPot } from "./util";
import { useNow } from "./ui";
import { ChipStack } from "./Chips";
import { useTableMotion } from "./motion";
import type { Send } from "./App";
import { nameOf } from "./Award";

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
  const points = VARIANTS[config.variant]?.scoring === "points";
  const seatedCount = view.seats.filter(Boolean).length;
  const waitingTitle = view.status === "playing" ? (view.tournament?.level.isBreak ? "Break: play resumes soon" : "Next hand starting…") : seatedCount < 2
    ? `${seatedCount} of 2 seated · ${view.you.seat === null ? "take a seat" : view.you.isHost ? "invite a friend" : "waiting for a player"}`
    : view.you.isHost ? "Host: press Start (Host tab)" : "Waiting for the host to start";
  const board = hand?.board ?? [];
  // Rabbit hunt: once the hand has ended early, show the cards that would have come (dimmed, in the empty board slots).
  const rabbit = hand && view.lastHand && view.lastHand.handNumber === hand.handNumber ? rabbitCards(view.lastHand) : [];
  const wrapRef = useRef<HTMLDivElement>(null);
  const winnersByPlayer = new Map<string, WinnerView[]>();
  // Winners about to be paid: the final result if the server sent one, else the suggested split of the pending award.
  const pa = view.pendingAward;
  const shownWinners: WinnerView[] = hand?.winners ?? (pa
    ? pa.suggested.map((x) => ({ playerId: x.playerId, amount: x.amount, potIndex: 0, half: "whole" as const, handName: null }))
    : []);
  for (const w of shownWinners) {
    winnersByPlayer.set(w.playerId, [...(winnersByPlayer.get(w.playerId) ?? []), w]);
  }
  const winAmts = new Map<string, number>();
  for (const w of shownWinners) winAmts.set(w.playerId, (winAmts.get(w.playerId) ?? 0) + w.amount);
  const winKey = shownWinners.length
    ? `${hand?.handNumber ?? pa?.handNumber}:${shownWinners.map((w) => `${w.playerId}=${w.amount}`).join(",")}`
    : "";
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

  useTableMotion(wrapRef, view, (seat) => pos(seat, 39 * 0.62, 37 * 0.62), winKey, winAmts);

  return (
    <div className="table-wrap" ref={wrapRef}>
      <div className="felt">
        <div className="felt-inner" />
      </div>

      <div className="center">
        {hand ? (
          <>
            <div className="pot" data-pot>
              {pot > 0 && <ChipStack amount={pot} bb={config.bigBlind} />}
              <span className="potlabel">Pot <b>{fmt(pot)}</b></span>
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
                  if (c) return <CardFace key={i} card={c} size="md" />;
                  const rc = rabbit[i - hand.board.length];
                  return rc ? <CardFace key={i} card={rc} size="md" className="rabbit" /> : <div key={i} className="card slot md" />;
                })}
              </div>
            )}
            {!stud && rabbit.length > 0 && <div className="rabbitlabel muted small">Would have come</div>}
            {stud && studStatus && <div className="studstatus">{studStatus}</div>}
            <div className="phase">Hand #{hand.handNumber} · {stud ? (STUD_STREETS[hand.phase] ?? hand.phase) : hand.phase}</div>
            {pa && <AwardAnnounce view={view} winners={shownWinners} />}
          </>
        ) : (
          <div className="waiting">
            <div className="big">{view.status === "paused" ? "Paused" : waitingTitle}</div>
            <div className="muted">
              {VARIANTS[config.variant]?.name ?? config.variant} ·{" "}
              {isStud(config)
                ? `Ante ${fmt(config.stud.ante)} · bets up to ${fmt(config.stud.maxBet)}, last round ${fmt(config.stud.maxBetLastRound)}`
                : `${fmt(config.smallBlind)}/${fmt(config.bigBlind)}`}
            </div>
            {pa && <AwardAnnounce view={view} winners={shownWinners} />}
          </div>
        )}
      </div>

      {view.seats.map((s, i) => {
        const p = pos(i, 39, 37);
        const style = { left: `${p.x}%`, top: `${p.y}%` };
        if (!s) {
          return (
            <div key={i} className="seat empty" style={style} data-seat={i}>
              {you.seat === null ? (
                <button className="sitbtn" onClick={() => onSit(i)}>Sit here</button>
              ) : (
                <span className="openseat">Open</span>
              )}
            </div>
          );
        }
        const isMe = s.playerId === you.playerId;
        const bp = pos(i, 39 * 0.62, 37 * (isMe ? 0.5 : 0.62));
        return (
          <SeatBlock
            key={i}
            idx={i}
            bb={config.bigBlind}
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
            points={points}
            board={board}
            wins={winnersByPlayer.get(s.playerId)}
            showdownDim={shownWinners.length > 0 && !winnersByPlayer.has(s.playerId)}
            betPos={bp}
            canExtend={isMe && view.canExtend && config.extensionSec > 0}
            extensionSec={config.extensionSec}
          />
        );
      })}
    </div>
  );
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "?") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function SeatBlock(props: {
  idx: number; bb: number;
  s: SeatView; isMe: boolean; style: React.CSSProperties; toAct: boolean; deadline: number | null;
  timeoutSec: number; now: number; stud: boolean; points: boolean; board: string[]; wins?: WinnerView[]; showdownDim: boolean;
  betPos: { x: number; y: number }; isHost: boolean; send: Send; onMe: () => void; canExtend: boolean; extensionSec: number;
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
    ? s.holeCards!.map((c, i) => <CardFace key={"h" + i + c} card={c} size={size} className={[props.stud && isMe ? "mark-down" : "", props.points && props.board.some((b) => b[0] === c[0]) ? "cancelled" : ""].filter(Boolean).join(" ")} />)
    : live ? Array.from({ length: s.holeCount }, (_, i) => <CardBack key={"b" + i} size={size} />) : [];
  const upNodes = props.stud && !s.folded
    ? s.upCards.map((c, i) => <CardFace key={"u" + i + c} card={c} size={size} className={isMe ? "mark-up" : "up"} />)
    : [];
  let cards: React.ReactNode = null;
  if (props.stud && (holeNodes.length > 0 || upNodes.length > 0)) {
    cards = (
      <div className="studcards">
        {holeNodes.length > 0 && <div className="cardrow hole grp" data-n={holeNodes.length}>{holeNodes}{isMe && <span className="cap">down</span>}</div>}
        {upNodes.length > 0 && <div className="cardrow hole up grp" data-n={upNodes.length}>{upNodes}{isMe && <span className="cap">up</span>}</div>}
      </div>
    );
  } else if (holeNodes.length > 0) {
    cards = <div className="cardrow hole" data-n={holeNodes.length}>{holeNodes}</div>;
  }
  const declBadge = s.declared ? s.declared.toUpperCase() : null;
  const av = s.avatar;
  const isNum = !!av && /^\d+$/.test(av);
  const avStyle: React.CSSProperties = av && !isNum
    ? {}
    : { background: `radial-gradient(circle at 35% 28%, hsl(${hue(s.name)} 38% 42%), hsl(${hue(s.name)} 40% 22%))` };
  const R = 24;
  const C = 2 * Math.PI * R;
  const low = secs !== null && secs <= 5;

  return (
    <>
      <div className={cls} style={props.style} data-seat={props.idx}>
        {cards}
        <div className="avwrap">
          {frac !== null && (
            <svg className={`ring ${low ? "low" : ""}`} viewBox="0 0 56 56" role="progressbar" aria-valuenow={secs ?? 0} aria-label="Time to act">
              <circle className="ring-track" cx="28" cy="28" r={R} />
              <circle className="ring-fill" cx="28" cy="28" r={R} strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 28 28)" />
            </svg>
          )}
          <div className={`avatar-circle ${av && !isNum ? "emoji" : ""}`} style={avStyle} aria-hidden="true">
            {av ? av : initials(s.name)}
          </div>
          {s.isButton && <span className="dealer" title="Dealer">D</span>}
          {!s.connected && <span className="offdot" role="img" aria-label="Offline" title="Offline" />}
          {secs !== null && <div className={`secs ${low ? "low" : ""}`}>{secs}s</div>}
        </div>
        <div className={`plate ${isMe ? "clickable" : ""}`} onClick={isMe ? props.onMe : undefined} title={isMe ? "Change avatar" : undefined}>
          <div className="name">{s.name}{isMe ? " (you)" : ""}</div>
          <div className="stack">{fmt(s.stack)}</div>
        </div>
        <div className="tags">
          {declBadge && <span className="tag decl">{declBadge}</span>}
          {!declBadge && s.hasDeclared && <span className="tag decl ok" aria-label="Declared">✓</span>}
          {props.points && hasHole && !s.folded && (() => {
            const r = tkoPoints(s.holeCards!, props.board as never[]);
            return <span className="tag pts">{r.remaining.length === 0 ? "No cards left" : r.high === r.low ? `${r.high} pts` : `${r.low}–${r.high} pts`}</span>;
          })()}
          {s.allIn && <span className="tag allin">All-in</span>}
          {s.folded && <span className="tag fold">Fold</span>}
          {s.sittingOut && <span className="tag">Away</span>}
          {s.waitingForBlind && <span className="tag">Waits for BB</span>}
          {s.timeLimitSec !== null && <span className="tag timelim">⏱ {s.timeLimitSec === 0 ? "off" : `${s.timeLimitSec}s`}</span>}
        </div>
        {wins ? (
          <div className="seat-note win">
            +{fmt(winTotal)}{wins.some((w) => w.half !== "whole") ? ` ${wins.map((w) => (w.half === "high" ? "High" : w.half === "low" ? "Low" : "")).filter(Boolean).join("+")}` : ""}{wins[0]?.handName ? ` · ${wins[0].handName}` : ""}
          </div>
        ) : s.lastAction && !(s.folded && /^fold/i.test(s.lastAction)) ? (
          <div className={`seat-note ${hostCtl ? "shift" : ""}`}>{s.lastAction}</div>
        ) : null}
        {wins && <span key={winTotal} className="floatwin" aria-hidden="true">+{fmt(winTotal)}</span>}
        {props.canExtend && (
          <button type="button" className="extendbtn" onClick={() => props.send("extendTime")}>+{props.extensionSec}s</button>
        )}
        {hostCtl && (
          <div className="hostctl">
            {props.deadline !== null && <button onClick={() => props.send("host:addTime", { playerId: s.playerId, seconds: 30 })}>+30s</button>}
            <button className="danger" onClick={() => props.send("host:forceTimeout", { playerId: s.playerId })}>Time out</button>
          </div>
        )}
      </div>
      {s.bet > 0 && (
        <div className="bet" data-bet={props.idx} style={{ left: `${props.betPos.x}%`, top: `${props.betPos.y}%` }}>
          <ChipStack amount={s.bet} bb={props.bb} small />
          <span className="betamt">{fmt(s.bet)}</span>
        </div>
      )}
    </>
  );
}

/** Shown to EVERY player while the dealer finalizes the payout. */
function AwardAnnounce({ view, winners }: { view: TableView; winners: WinnerView[] }) {
  const pa = view.pendingAward!;
  const rows = winners.map((w) => {
    const half = w.half === "high" ? " (High)" : w.half === "low" ? " (Low)" : "";
    return `${nameOf(view, w.playerId)} ${fmt(w.amount)}${half}${w.handName ? ` · ${w.handName}` : ""}`;
  });
  return (
    <div className="await" role="status">
      <div>{view.you.isHost ? "Confirm the award below" : "The dealer is confirming the award"} · {fmt(pa.amount)}</div>
      {rows.length > 0 && <div className="awardlist">{rows.map((r, i) => <div key={i}>{r}</div>)}</div>}
    </div>
  );
}
