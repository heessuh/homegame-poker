import { useEffect, useRef, useState } from "react";
import { VARIANTS } from "@homegame/engine";
import type { ReviewFilter, ReviewHand, ReviewPlayer, SessionReview as SessionReviewData } from "@homegame/engine";
import { CardRow } from "./CardView";
import type { Send } from "./App";
import { fmt } from "./util";

const FILTERS: [ReviewFilter, string][] = [
  ["all", "All hands"],
  ["folded-best", "Hands where someone folded the best hand"],
  ["won-without-best", "Hands won without the best hand"],
];

const STREET: Record<string, string> = { preflop: "before the flop", flop: "on the flop", turn: "on the turn", river: "on the river" };

function outcomeText(p: ReviewPlayer): string {
  switch (p.outcome) {
    case "folded": return `Folded ${p.foldStreet ? STREET[p.foldStreet] : ""}`.trim();
    case "showdown": return "Went to showdown";
    case "won-uncontested": return "Won with everyone else folded";
    default: return "Result not recorded";
  }
}

/** Every dealt hand with all hole cards (the deck is public once a hand ends), for friends to review play. */
export function SessionReview({ send, handCount }: { send: Send; handCount: number }) {
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<SessionReviewData | null>(null);
  const [failed, setFailed] = useState(false);
  const want = useRef(0);

  useEffect(() => {
    const id = ++want.current;
    setFailed(false);
    const timer = setTimeout(() => { if (want.current === id) setFailed(true); }, 15000);
    send("getSessionReview", { filter, page }, (r) => {
      if (want.current !== id) return;
      clearTimeout(timer);
      setData(r);
    });
    return () => clearTimeout(timer);
  }, [filter, page, handCount, send]);

  const shown = data && data.filter === filter ? data : null;
  const pages = shown ? Math.max(1, Math.ceil(shown.total / shown.pageSize)) : 1;
  return (
    <div className="review">
      <p className="muted small">
        Once a hand ends, its whole deck is revealed to everyone, so every player’s cards can be shown here, including hands that were folded.
        “Best hand” means the best hand at the river if nobody had folded. Folding a hand that would have become the best is common and usually innocent,
        and winning without the best hand is what every bluff does, so treat these filters as a place to look, not as proof of anything.
      </p>
      <div className="btn-row review-filters" role="group" aria-label="Filter">
        {FILTERS.map(([id, label]) => (
          <button key={id} className={`btn small${filter === id ? " on" : ""}`} aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(0); }}>{label}</button>
        ))}
      </div>
      {!shown && <p className="muted">{failed ? "Could not load the review. Try again in a moment." : "Loading…"}</p>}
      {shown && shown.total === 0 && <p className="muted">{shown.totalHands === 0 ? "No finished hands yet." : "No hands match this filter yet."}</p>}
      {shown && shown.hands.map((h) => <ReviewCard key={h.handNumber} h={h} />)}
      {shown && shown.total > 0 && (
        <div className="btn-row review-pager">
          <button className="btn small" disabled={shown.page <= 0} onClick={() => setPage(shown.page - 1)}>← Newer</button>
          <span className="muted small">Page {shown.page + 1} of {pages} · {shown.total} {shown.total === 1 ? "hand" : "hands"}</span>
          <button className="btn small" disabled={shown.page + 1 >= pages} onClick={() => setPage(shown.page + 1)}>Older →</button>
        </div>
      )}
    </div>
  );
}

function ReviewCard({ h }: { h: ReviewHand }) {
  const title = `Hand #${h.handNumber} · ${VARIANTS[h.variant]?.name ?? h.variant}`;
  if (!h.available) {
    return (
      <section className="lens review-hand">
        <h4>{title}</h4>
        <p className="muted small">{h.reason === "stud" ? "Not available for stud." : h.reason === "old" ? "Not available: this hand was played before the review existed." : "Not available for this hand."}</p>
      </section>
    );
  }
  const notDealt = h.fullBoard.slice(h.board.length);
  const flagged = h.foldedBest.length > 0 || h.winnerNotBest;
  return (
    <section className={`lens review-hand${flagged ? " unusual" : ""}`}>
      <h4>{title}</h4>
      {h.endedAt > 0 && <p className="muted small">{new Date(h.endedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>}
      <div className="review-board">
        {h.board.length > 0 ? <CardRow cards={h.board} size="sm" className="flat" /> : <span className="muted small">No board (hand ended before the flop)</span>}
        {notDealt.length > 0 && (
          <span className="muted small review-undealt">
            Cards that would have come: <CardRow cards={notDealt} size="sm" className="flat" />
          </span>
        )}
      </div>
      <ul className="review-players">
        {h.players.map((p) => (
          <li key={p.playerId} className={p.won > 0 ? "won" : ""}>
            <span className="rp-name">{p.name}{p.won > 0 ? " ★" : ""}</span>
            <CardRow cards={p.hole} size="sm" className="flat" />
            <span className="rp-out">{outcomeText(p)}{p.won > 0 ? ` · won ${fmt(p.won)}` : ""}</span>
            {p.best && <span className="vbadge fair" title="Held the best hand at the river had nobody folded">Best hand</span>}
          </li>
        ))}
      </ul>
      {h.foldedBest.length > 0 && (
        <p className="small review-note">
          Folded the best hand: {h.players.filter((p) => h.foldedBest.includes(p.playerId)).map((p) => `${p.name} (${p.foldStreet ? STREET[p.foldStreet] : ""})`).join(", ")}.
        </p>
      )}
      {h.winnerNotBest && <p className="small review-note">Won without the best hand.</p>}
    </section>
  );
}
