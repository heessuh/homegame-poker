import type { Card } from "@homegame/engine";

const SUIT_SYMBOL: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

export type CardSize = "sm" | "md" | "lg";

export function CardFace({ card, size = "md", className = "" }: { card: Card; size?: CardSize; className?: string }) {
  const rank = card[0] === "T" ? "10" : card[0];
  const suit = card[1] ?? "s";
  return (
    <div className={`card suit-${suit} ${size} ${className}`} aria-label={`${rank} of ${suit}`}>
      <span className="r">{rank}</span>
      <span className="s">{SUIT_SYMBOL[suit]}</span>
    </div>
  );
}

export function CardBack({ size = "sm", className = "" }: { size?: CardSize; className?: string }) {
  return <div className={`card back ${size} ${className}`} aria-hidden="true" />;
}

export function CardRow({ cards, size, className = "" }: { cards: Card[]; size: CardSize; className?: string }) {
  return (
    <div className={`cardrow ${className}`}>
      {cards.map((c, i) => <CardFace key={i + c} card={c} size={size} />)}
    </div>
  );
}
