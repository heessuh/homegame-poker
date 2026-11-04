import { dealInfo, type LuckableHand } from "./luck.js";
import type { ReviewFilter, ReviewHand, ReviewPlayer } from "./protocol.js";

/**
 * Session review (pure): one finished board-game hand with every dealt player's hole cards. The deck is revealed
 * to everyone when a hand ends, so this shows nothing the hand record does not already contain.
 */
export function reviewHand(rec: LuckableHand): ReviewHand {
  const base = { handNumber: rec.handNumber, variant: rec.variant, endedAt: rec.endedAt ?? 0 };
  const d = dealInfo(rec);
  if (typeof d === "string") return { available: false, ...base, reason: d };
  const fold = rec.luck?.foldStreet;
  const won = new Map<string, number>();
  for (const w of rec.winners ?? []) won.set(w.playerId, (won.get(w.playerId) ?? 0) + w.amount);
  const players: ReviewPlayer[] = d.ids.map((id, i) => {
    const street = fold?.[id] ?? null;
    let outcome: ReviewPlayer["outcome"];
    if (street) outcome = "folded";
    else if (rec.shown?.[id]) outcome = "showdown";
    else outcome = fold ? "won-uncontested" : "unknown";
    return {
      playerId: id,
      name: rec.names?.[id] ?? "Someone",
      hole: d.holes[i]!,
      outcome,
      foldStreet: street,
      best: d.credit[i]! > 0,
      won: won.get(id) ?? 0,
    };
  });
  const paid = players.filter((p) => p.won > 0);
  return {
    available: true,
    ...base,
    board: [...rec.board],
    fullBoard: d.board,
    players,
    foldedBest: players.filter((p) => p.best && p.foldStreet).map((p) => p.playerId),
    winnerNotBest: paid.length > 0 && paid.every((p) => !p.best),
  };
}

export function reviewMatches(h: ReviewHand, filter: ReviewFilter): boolean {
  if (filter === "all") return true;
  if (!h.available) return false;
  return filter === "folded-best" ? h.foldedBest.length > 0 : h.winnerNotBest;
}
