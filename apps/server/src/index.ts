import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { commitDeck, shuffle, VARIANTS, type Card, type VariantId } from "@homegame/engine";

const PORT = Number(process.env.PORT ?? 3000);
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "../../web/dist");

const app = express();
app.get("/healthz", (_req, res) => res.json({ ok: true }));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
}

const http = createServer(app);
const io = new Server(http, { cors: { origin: process.env.CORS_ORIGIN ?? "http://localhost:5173" } });

// POC: tables live in memory. A redeploy or machine stop clears them.
interface Table {
  variant: VariantId;
  players: Map<string, string>; // socket id -> display name
  lastReveal?: { deck: Card[]; salt: string };
}
const tables = new Map<string, Table>();

io.on("connection", (socket) => {
  socket.on("join", ({ tableId, name, variant }: { tableId: string; name: string; variant?: VariantId }) => {
    let t = tables.get(tableId);
    if (!t) tables.set(tableId, (t = { variant: variant ?? "nlhe", players: new Map() }));
    t.players.set(socket.id, name);
    socket.data.tableId = tableId;
    void socket.join(tableId);
    io.to(tableId).emit("table", { variant: VARIANTS[t.variant], players: [...t.players.values()] });
  });

  // Smoke test for the dealing pipeline: shuffle, publish the commitment, deal hole cards privately.
  socket.on("deal", () => {
    const t = tables.get(socket.data.tableId);
    if (!t) return;
    const deck = shuffle();
    const { hash, reveal } = commitDeck(deck);
    t.lastReveal = reveal;
    io.to(socket.data.tableId).emit("handStart", { hash });
    const n = VARIANTS[t.variant].holeCards;
    let i = 0;
    for (const id of t.players.keys()) io.to(id).emit("holeCards", deck.slice(i * n, ++i * n));
  });

  socket.on("reveal", () => {
    const t = tables.get(socket.data.tableId);
    if (t?.lastReveal) io.to(socket.data.tableId).emit("reveal", t.lastReveal);
  });

  socket.on("disconnect", () => {
    const t = tables.get(socket.data.tableId);
    if (!t) return;
    t.players.delete(socket.id);
    if (t.players.size === 0) tables.delete(socket.data.tableId);
    else io.to(socket.data.tableId).emit("table", { variant: VARIANTS[t.variant], players: [...t.players.values()] });
  });
});

http.listen(PORT, () => console.log(`homegame-poker listening on :${PORT}`));
