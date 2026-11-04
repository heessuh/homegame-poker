// Dev helper: node apps/server/test/bots.mjs <tableId> [count] — bots sit and call/check every hand.
import { io } from "socket.io-client";
const [tableId = "e2etest", count = "2", url = "http://localhost:3000"] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  const name = ["Ana", "Bo", "Cy", "Di", "Ed"][i];
  const s = io(url);
  let sat = false;
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: `bot-${tableId}-${i}` }));
  s.on("error", (e) => console.log(name, "error:", e.message));
  s.on("state", (v) => {
    if (!sat && v.you.seat === null) {
      const free = v.seats.map((x, n) => (x === null ? n : -1)).filter((n) => n >= 0);
      sat = true;
      // Stagger so bots don't race for the same seat.
      setTimeout(() => s.emit("sit", { seat: free[(i * 3) % free.length], buyIn: v.config.maxBuyIn / 2 }), i * 300);
    }
    const l = v.hand?.legal;
    if (l) setTimeout(() => s.emit("action", l.canCheck ? { type: "check" } : { type: "call" }), 400);
  });
}
