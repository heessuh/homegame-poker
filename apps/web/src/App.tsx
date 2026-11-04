import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

// Placeholder table: proves join, private dealing, and the commit/reveal flow end to end.
export function App() {
  const socket = useMemo(() => io(), []);
  const tableId = location.hash.slice(1) || "lobby";
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [players, setPlayers] = useState<string[]>([]);
  const [variant, setVariant] = useState("");
  const [hole, setHole] = useState<string[]>([]);
  const [hash, setHash] = useState("");
  const [revealed, setRevealed] = useState<{ deck: string[]; salt: string } | null>(null);

  useEffect(() => {
    socket.on("table", (t) => { setPlayers(t.players); setVariant(t.variant.name); });
    socket.on("handStart", ({ hash }) => { setHash(hash); setRevealed(null); });
    socket.on("holeCards", setHole);
    socket.on("reveal", setRevealed);
    return () => { socket.disconnect(); };
  }, [socket]);

  if (!joined) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 16 }}>
        <h1>Home Game Poker</h1>
        <p>Table: <code>{tableId}</code></p>
        <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name} onClick={() => { socket.emit("join", { tableId, name }); setJoined(true); }}>
          Sit down
        </button>
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 16 }}>
      <h1>{variant}</h1>
      <p>Players: {players.join(", ")}</p>
      <button onClick={() => socket.emit("deal")}>Deal test hand</button>{" "}
      <button onClick={() => socket.emit("reveal")} disabled={!hash}>Reveal deck</button>
      <p>Your cards: <strong>{hole.join(" ") || "—"}</strong></p>
      {hash && <p>Deck commitment: <code style={{ wordBreak: "break-all" }}>{hash}</code></p>}
      {revealed && <p>Revealed deck: <code style={{ wordBreak: "break-all" }}>{revealed.deck.join(" ")}</code></p>}
    </main>
  );
}
