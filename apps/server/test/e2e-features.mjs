// Dev check: node apps/server/test/e2e-features.mjs [url] — drives the new host features over real sockets.
import { io } from "socket.io-client";
const url = process.argv[2] ?? "http://localhost:3100";
const tableId = "e2e" + Math.random().toString(36).slice(2, 7);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name, token, avatar) {
  const s = io(url); const c = { s, v: null, errors: [] };
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token, avatar }));
  s.on("state", (v) => { c.v = v; const l = v.hand?.legal; if (l && c.auto) setTimeout(() => s.emit("action", l.exchange ? { type: "exchange", card: null } : l.declare ? { type: "declare", choice: "high" } : l.canCheck ? { type: "check" } : { type: "call" }), 50); });
  s.on("error", (e) => c.errors.push(e.message));
  return c;
}
const until = async (fn, ms = 15000) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) await wait(100); };
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
const H = client("Host", "tok-h-" + tableId, "🐼"); await until(() => H.v);
const A = client("Ana", "tok-a-" + tableId, "7"); const B = client("Bo", "tok-b-" + tableId, null); await until(() => A.v && B.v);
H.s.emit("sit", { seat: 0, buyIn: 1000 }); A.s.emit("sit", { seat: 1, buyIn: 1000 }); B.s.emit("sit", { seat: 2, buyIn: 1000 }); await until(() => H.v.seats[2]);
ok(H.v.seats[0]?.avatar === "🐼" && H.v.seats[1].avatar === "7", "avatars shown");
B.s.emit("setAvatar", { avatar: "🐴" }); await wait(200); ok(H.v.seats[2].avatar === "🐴", "setAvatar");
H.s.emit("host:config", { variant: "plo4-8" }); await wait(200); ok(H.v.config.variant === "plo4-8", "one-step variant switch");
H.s.emit("host:transfer", { fromPlayerId: H.v.seats[1].playerId, toPlayerId: H.v.seats[2].playerId, amount: 25 }); await wait(200);
ok(H.v.seats[1].stack === 975 && H.v.seats[2].stack === 1025, "transfer between hands");
H.s.emit("host:config", { awardMode: "host" }); await wait(200);
H.s.emit("host:playerTimer", { playerId: H.v.seats[1].playerId, seconds: 60 }); await wait(200); ok(H.v.seats[1].timeLimitSec === 60, "per-player timer");
H.auto = A.auto = B.auto = true; H.s.emit("host:start"); await wait(2500);
for (let i = 0; i < 40 && !H.v.pendingAward; i++) await wait(250);
const pa = H.v.pendingAward; ok(!!pa, "pot held for dealer"); const pot = pa?.amount ?? 0;
H.s.emit("host:award", { awards: [{ playerId: pa.candidatePlayerIds[0], amount: pot - 1 }] }); await wait(200); ok(H.errors.length > 0 && !!H.v.pendingAward, "wrong sum rejected");
const before = H.v.seats.map((s) => s?.stack ?? 0);
H.s.emit("host:award", { awards: [{ playerId: H.v.seats[2].playerId, amount: pot }] }); await wait(300);
ok(!H.v.pendingAward && H.v.seats[2].stack === before[2] + pot, "award paid to chosen player");
ok(A.v.pendingAward === null, "others see award cleared");
H.s.emit("host:pause", { paused: true }); H.auto = A.auto = B.auto = false;
for (let i = 0; i < 40 && (H.v.hand && H.v.hand.phase !== "complete" || H.v.pendingAward); i++) { const l = [H, A, B].find((c) => c.v.hand?.legal); if (l) l.s.emit("action", { type: "call" }); if (H.v.pendingAward) H.s.emit("host:award", { awards: H.v.pendingAward.suggested }); await wait(300); }
H.s.emit("host:config", { awardMode: "auto", mode: "tournament", tournament: { startingStack: 500, lateRegLevels: 0, levels: [{ smallBlind: 10, bigBlind: 20, minutes: 1 }, { smallBlind: 50, bigBlind: 100, minutes: 1 }, { smallBlind: 200, bigBlind: 400, minutes: 1 }] } });
await wait(300); ok(H.v.config.mode === "tournament" && H.v.tournament?.status === "registering", "tournament set up: " + H.errors.slice(-1));
H.s.emit("host:pause", { paused: false }); H.s.emit("host:start"); await wait(500);
ok(H.v.tournament?.status === "running" && H.v.seats[0].stack <= 500, "tournament running");
H.s.emit("host:tournamentLevel", { delta: 1 }); await wait(200); ok(H.v.tournament.levelIndex === 1, "level jump");
H.s.emit("host:tournamentClock", { addMs: 60000 }); await wait(200); ok(H.v.tournament.levelRemainingMs > 60000 || H.v.tournament.levelEndsAt - Date.now() > 60000, "clock +1 min");
H.s.emit("host:tournamentLevel", { delta: 1 }); H.auto = A.auto = B.auto = true;
// timer controls on whoever is to act
for (let i = 0; i < 20 && !H.v.hand?.toActSeat && H.v.hand?.toActSeat !== 0; i++) await wait(200);
H.auto = false; await wait(300);
for (let i = 0; i < 200 && H.v.tournament?.status !== "finished"; i++) { if (H.v.hand?.legal) H.s.emit("action", { type: "raise", amount: H.v.hand.legal.maxRaiseTo ?? 0 }); await wait(150); }
ok(H.v.tournament?.status === "finished", "tournament finished");
const places = H.v.tournament.standings.map((s) => `${s.name}:${s.place}`).join(" "); ok(H.v.tournament.standings.every((s) => s.place), "places " + places);
console.log("host errors:", H.errors.join(" | "));
process.exit();
