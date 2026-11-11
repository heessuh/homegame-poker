// End-to-end game QA for Mocha Poker.
//   node apps/server/test/games-e2e.mjs [--url <baseUrl>] [--hands N] [--json <path>]
// Without --url it starts the built server in-process (apps/server/dist) on a free port with a temp DATA_DIR,
// which also enables the restart/persistence test. With --url it runs against that server (tables are "qa-..." ids).
// Everything is driven over real Socket.IO connections, exactly like the web client.
import { io } from "socket.io-client";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const { VARIANTS, bestHigh, bestLowAny, tkoPoints, deriveDeck, seedHash, buildMaterial } = await import(pathToFileURL(join(root, "packages/engine/dist/index.js")).href);

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const REMOTE = arg("--url");
const HANDS = Number(arg("--hands") ?? 6);
const JSON_PATH = arg("--json");
if (!Number.isInteger(HANDS) || HANDS < 1) { console.error("--hands must be a positive integer"); process.exit(2); }

// ------------------------------------------------------------------ small utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 8) {
  const t = Date.now();
  for (;;) {
    let r; try { r = fn(); } catch { r = false; }
    if (r) return r;
    if (Date.now() - t > ms) return false;
    await sleep(step);
  }
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const rnd = (n) => Math.floor(Math.random() * n);
const pickOf = (a) => a[rnd(a.length)];
const money = (n) => `$${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
const MONEY_RE = /\$\d+\.\d{2}/;
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** Provably fair data of a HandRecord must re-derive the revealed deck. Skipped for servers that predate it (record has no `fair`). */
function fairOk(g, rec, label) {
  const f = rec.fair;
  if (!f) return;
  g.ok(f.algorithm === "mochapoker-v1", `${label}: unknown fairness algorithm ${f.algorithm}`);
  g.ok(seedHash(f.serverSeed) === f.serverSeedHash, `${label}: sha256(serverSeed) != published serverSeedHash`);
  g.ok(f.material === buildMaterial(rec.tableId ?? f.material.split("|")[1], rec.handNumber, f.clientSeeds), `${label}: fair.material does not match the client seeds`);
  g.ok(deriveDeck(f.serverSeed, f.material).join(",") === rec.reveal.deck.join(","), `${label}: revealed deck != deck derived from the fair data`);
}
const tag = () => Date.now().toString(36).slice(-6) + randomBytes(2).toString("hex");

// ------------------------------------------------------------------ results
class Group {
  constructor(name) { this.name = name; this.checks = 0; this.failMap = new Map(); this.notes = []; this.clients = []; this.t0 = Date.now(); }
  ok(cond, msg) {
    this.checks++;
    if (!cond) this.failMap.set(msg, (this.failMap.get(msg) ?? 0) + 1);
    return !!cond;
  }
  fail(msg) { this.ok(false, msg); }
  note(msg) { this.notes.push(msg); }
  get failures() { return [...this.failMap].map(([m, n]) => (n > 1 ? `${m} (x${n})` : m)); }
  cleanup() { for (const c of this.clients) try { c.s.disconnect(); } catch { /* ignore */ } }
}
const results = [];
async function runGroup(name, fn, timeoutMs = 200000) {
  const g = new Group(name);
  let timer;
  try {
    await Promise.race([fn(g), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`group timed out after ${timeoutMs / 1000}s`)), timeoutMs); })]);
  } catch (e) {
    g.fail(`exception: ${e?.stack?.split("\n").slice(0, 3).join(" | ") ?? e}`);
  } finally { clearTimeout(timer); g.cleanup(); }
  const ms = Date.now() - g.t0;
  const failures = g.failures;
  const res = { name, ok: failures.length === 0, details: { checks: g.checks, failures, notes: g.notes, ms } };
  results.push(res);
  const head = `${res.ok ? "PASS" : "FAIL"}  ${name}  (${g.checks} checks, ${(ms / 1000).toFixed(1)}s)`;
  console.log(head + (res.ok ? "" : `  -- ${failures[0]}`));
  for (const n of g.notes) console.log(`        note: ${n}`);
  if (!res.ok) for (const f of failures.slice(1, 8)) console.log(`        - ${f}`);
  return res;
}

// ------------------------------------------------------------------ view inspection
const totalPot = (v) => sum(v.hand.pots.map((p) => p.amount)) + sum(v.seats.filter(Boolean).map((s) => s.bet));
const seatOf = (v, pid) => v.seats.find((s) => s && s.playerId === pid);
function sigOf(v) {
  const h = v?.hand;
  if (!h) return "nohand";
  return JSON.stringify([h.handNumber, h.phase, h.stage, h.toActSeat, h.board.length, h.pots.map((p) => p.amount), v.seats.map((s) => s && [s.bet, s.stack, s.lastAction, s.upCards.length]), h.legal, v.pendingAward?.amount ?? null]);
}

// Same ordering the engine uses for "lowest showing hand acts first" (ace low, pairs worse).
function lowKey(cards) {
  const counts = new Map();
  for (const c of cards) { const r = "23456789TJQKA".indexOf(c[0]) + 2; const v = r === 14 ? 1 : r; counts.set(v, (counts.get(v) ?? 0) + 1); }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return [...groups.map((x) => x[1]), ...groups.map((x) => x[0])];
}
const cmpKey = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };
function expectedOpener(v, includeAllIn = false) {
  const btn = v.seats.find((s) => s && s.isButton)?.seat ?? 0;
  const n = v.seats.length;
  const cand = v.seats.filter((s) => s && s.inHand && (includeAllIn || !s.allIn));
  cand.sort((a, b) => cmpKey(lowKey(a.upCards), lowKey(b.upCards)) || ((a.seat - btn - 1 + 2 * n) % n) - ((b.seat - btn - 1 + 2 * n) % n));
  return cand[0]?.seat;
}

function leakCheck(c, v, g) {
  const h = v.hand;
  if (!h) return;
  const me = v.you.playerId;
  const finished = h.winners !== null;
  const stud = VARIANTS[v.config.variant]?.kind === "stud";
  const live = v.seats.filter((s) => s && s.inHand).length;
  const foldEnd = finished && live <= 1;
  const seen = [...h.board];
  for (const s of v.seats) {
    if (!s) continue;
    if (s.playerId !== me && s.holeCards !== null) {
      if (!finished) g.fail(`LEAK: ${c.name} sees ${s.name}'s face-down cards before showdown (hand ${h.handNumber}, ${h.phase})`);
      else if (foldEnd) g.fail(`LEAK: ${c.name} sees ${s.name}'s cards although everyone folded (hand ${h.handNumber})`);
      else if (s.folded) g.fail(`LEAK: ${c.name} sees folded ${s.name}'s cards (hand ${h.handNumber})`);
    }
    if (s.holeCards) seen.push(...s.holeCards);
    if (stud) {
      if (!finished && h.phase !== "showdown" && s.declared !== null) g.fail(`LEAK: declaration of ${s.name} visible before all declared (hand ${h.handNumber}, ${h.phase})`);
      if (s.inHand) {
        const expUp = { "2nd": 1, "3rd": 2, "4th": 3 }[h.phase] ?? 3;
        if (s.upCards.length !== expUp) g.fail(`stud ${s.name} shows ${s.upCards.length} up cards in ${h.phase}, expected ${expUp}`);
        const expDown = ["2nd", "3rd", "4th"].includes(h.phase) ? 1 : 2;
        if (s.holeCount !== expDown) g.fail(`stud ${s.name} holeCount ${s.holeCount} in ${h.phase}, expected ${expDown}`);
      }
      seen.push(...s.upCards);
    }
  }
  if (new Set(seen).size !== seen.length) g.fail(`duplicate card visible in one view (hand ${h.handNumber}, ${h.phase})`);
}

// ------------------------------------------------------------------ bots
const POLICY = { fold: 0.1, raise: 0.28, swap: 0.65 };
function chooseAction(l, p) {
  if (l.exchange) {
    const ex = l.exchange;
    if (Math.random() > p.swap) return { type: "exchange", card: null };
    const opts = [];
    if (ex.upCards.length) opts.push("up");
    if (ex.canAffordDown && ex.downCards.length) opts.push("down");
    if (!opts.length) return { type: "exchange", card: null };
    return { type: "exchange", card: pickOf(pickOf(opts) === "up" ? ex.upCards : ex.downCards) };
  }
  if (l.declare) return { type: "declare", choice: pickOf(["high", "low", "both"]) };
  const canRaise = l.minRaiseTo !== null && l.maxRaiseTo !== null;
  const raise = () => {
    const m = Math.random();
    const amount = m < 0.3 ? l.minRaiseTo : m < 0.5 ? l.maxRaiseTo : l.minRaiseTo + rnd(l.maxRaiseTo - l.minRaiseTo + 1);
    return { type: "raise", amount };
  };
  if (l.canCheck) return canRaise && Math.random() < p.raise ? raise() : { type: "check" };
  const x = Math.random();
  if (x < p.fold) return { type: "fold" };
  if (canRaise && x < p.fold + p.raise) return raise();
  return { type: "call" };
}
const safeAction = (l) => (l.exchange ? { type: "exchange", card: null } : l.declare ? { type: "declare", choice: "high" } : l.canCheck ? { type: "check" } : { type: "call" });

function connect(ctx, g, tableId, name, token, opts = {}) {
  const s = io(ctx.url, { reconnection: false, transports: ["websocket"], forceNew: true });
  const c = { s, name, token, v: null, n: 0, errors: [], pid: null, auto: null, strict: false, lastSig: null, extra: null };
  g.clients.push(c);
  s.on("connect", () => s.emit("join", { tableId, name, playerToken: token }));
  s.on("state", (v) => {
    c.v = v; c.n++; c.pid = v.you.playerId;
    if (v.fairness) {
      const key = `${v.fairness.nextHandNumber}|${v.fairness.serverSeedHash}`;
      if (c.fairKey !== key) { c.fairKey = key; s.emit("seed", { handNumber: v.fairness.nextHandNumber, clientSeed: randomBytes(16).toString("hex") }); }
    }
    leakCheck(c, v, g);
    if (c.auto) {
      const l = v.hand?.legal;
      if (!l || v.hand.phase === "complete") return;
      const sig = sigOf(v);
      if (sig === c.lastSig) return;
      c.lastSig = sig;
      s.emit("action", chooseAction(l, c.auto));
    }
  });
  s.on("error", (e) => {
    c.errors.push(e.message);
    if (c.strict) {
      g.fail(`${c.name}: unexpected server error during play: ${e.message}`);
      const l = c.v?.hand?.legal;
      if (l) s.emit("action", safeAction(l));
    }
  });
  s.on("connect_error", (e) => g.fail(`${name}: connect_error ${e.message}`));
  return c;
}

async function makeTable(g, ctx, variant, n, patch = {}, opts = {}) {
  const tid = `qa-${tag()}`;
  const names = ["Host", "Ana", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"];
  const buyIn = opts.buyIn ?? 2000;
  const clients = [];
  for (let i = 0; i < n; i++) {
    const c = connect(ctx, g, tid, names[i], `qa-tok-${tid}-${i}`);
    if (!(await until(() => c.v, 15000))) throw new Error(`${names[i]} could not join ${tid}`);
    clients.push(c);
  }
  const H = clients[0];
  H.s.emit("host:config", { variant, maxSeats: 8, awardMode: "host", ...patch });
  const cfgOk = await until(() => H.v.config.variant === variant && !H.v.pendingConfig, 5000);
  if (!cfgOk) throw new Error(`config not applied: ${H.errors.join("; ")}`);
  clients.forEach((c, i) => c.s.emit("sit", { seat: i, buyIn }));
  if (!(await until(() => H.v.seats.filter(Boolean).length === n, 10000))) throw new Error(`not all seated: ${H.errors.join("; ")}`);
  const T = {
    tid, clients, host: H, g, ctx, buyIns: n * buyIn, buyIn, n,
    async act(c, a) {
      const e0 = c.errors.length, sig0 = sigOf(c.v);
      c.s.emit("action", a);
      await until(() => c.errors.length > e0 || sigOf(c.v) !== sig0, 5000);
      return c.errors.length > e0 ? c.errors[c.errors.length - 1] : null;
    },
    async actor(ms = 20000, hand) {
      return until(() => clients.find((c) => c.v?.hand?.legal && c.v.hand.phase !== "complete" && (hand === undefined || c.v.hand.handNumber === hand)), ms);
    },
    /** Plays hand `n` with decide(client, legal, view) until the hand is complete and its pot waits for the host. */
    async playHand(num, decide, observe, stallMs = 25000) {
      let last = Date.now(), lastSig = "";
      for (let i = 0; i < 2000; i++) {
        const v = H.v;
        if (v.hand?.handNumber === num && v.hand.phase === "complete") break;
        const a = clients.find((c) => c.v?.hand?.legal && c.v.hand.handNumber === num && c.v.hand.phase !== "complete");
        if (!a) {
          if (Date.now() - last > stallMs) return { stalled: true };
          await sleep(8);
          continue;
        }
        const sg = sigOf(a.v);
        if (sg !== lastSig) { lastSig = sg; last = Date.now(); }
        observe?.(a, a.v);
        const err = await this.act(a, decide(a, a.v.hand.legal, a.v));
        if (err) return { err };
      }
      const done = await until(() => H.v.hand?.handNumber === num && H.v.hand.phase === "complete" && H.v.pendingAward, 8000);
      return done ? { ok: true } : { stalled: true };
    },
    async award(extra) {
      const pa = H.v.pendingAward;
      H.s.emit("host:award", { awards: pa.suggested });
      await until(() => !H.v.pendingAward, 5000);
      return pa;
    },
    getHand(c, n) { return new Promise((res) => { const t = setTimeout(() => res(undefined), 5000); c.s.emit("getHand", { handNumber: n }, (r) => { clearTimeout(t); res(r); }); }); },
  };
  if (opts.bots) for (const c of clients) { c.auto = opts.bots; c.strict = true; }
  return T;
}

function conserve(g, T, withheld, label) {
  const v = T.host.v;
  const stacks = sum(v.seats.filter(Boolean).map((s) => s.stack));
  const bi = sum(v.ledger.map((l) => l.buyIns)), co = sum(v.ledger.map((l) => l.cashOuts));
  g.ok(bi === T.buyIns, `${label}: ledger buy-ins ${bi} != expected ${T.buyIns}`);
  g.ok(stacks + co + withheld === bi, `${label}: chips not conserved: stacks ${stacks} + cash-outs ${co} + pot ${withheld} != buy-ins ${bi}`);
}

// ------------------------------------------------------------------ per-variant showdown hooks
/** FYST / Double FYST (second-best high hand wins) and Dumb & Dumber (lowest best hand wins). */
function highRuleHook(g, variant, hv, rec, stats) {
  const shown = rec.shown;
  if (Object.keys(shown).length < 2) return;
  stats.showdowns++;
  const v = VARIANTS[variant];
  hv.pots.forEach((pot, pi) => {
    const el = pot.eligiblePlayerIds.filter((id) => shown[id]);
    if (el.length === 0) return;
    for (const id of el) g.ok(shown[id].length === v.holeCards, `${variant} hand ${rec.handNumber}: ${shown[id].length} hole cards shown, want ${v.holeCards}`);
    const highs = new Map(el.map((id) => [id, bestHigh(shown[id], rec.board, v.mustUseTwoHole)]));
    const sc = (id) => highs.get(id).score;
    const top = Math.max(...el.map(sc)), bottom = Math.min(...el.map(sc));
    let exp;
    if (v.highWinner === "worst") exp = el.filter((id) => sc(id) === bottom);
    else {
      const rest = el.filter((id) => sc(id) !== top);
      if (rest.length === 0) exp = el;
      else { const nx = Math.max(...rest.map(sc)); exp = rest.filter((id) => sc(id) === nx); }
      if (el.length >= 3 && rest.length > 0) stats.fyst3++;
      if (rest.length > 0) g.ok(!hv.winners.some((w) => w.potIndex === pi && sc(w.playerId) === top), `${variant} hand ${rec.handNumber}: the BEST hand won (should be second best)`);
    }
    const winners = hv.winners.filter((w) => w.potIndex === pi);
    const winIds = new Set(winners.map((w) => w.playerId));
    for (const w of winners) {
      g.ok(w.half === "whole", `${variant} hand ${rec.handNumber}: pot should pay "whole", got ${w.half}`);
      g.ok(w.handName === highs.get(w.playerId)?.name, `${variant} hand ${rec.handNumber}: handName "${w.handName}" != computed best hand "${highs.get(w.playerId)?.name}"`);
    }
    g.ok(exp.length === winIds.size && exp.every((id) => winIds.has(id)), `${variant} hand ${rec.handNumber}: expected winners ${exp.map((id) => rec.names[id])}, got ${[...winIds].map((id) => rec.names[id])}`);
  });
}
const LOW_NAME_RE = /^([A2-9TJQK]-){4}[A2-9TJQK]$/;
function lowHook(g, variant, hv, rec, stats) {
  const shown = rec.shown;
  if (Object.keys(shown).length < 2) return;
  stats.showdowns++;
  hv.pots.forEach((pot, pi) => {
    const el = pot.eligiblePlayerIds.filter((id) => shown[id]);
    if (el.length === 0) return;
    const lows = new Map(el.map((id) => [id, bestLowAny(shown[id], rec.board, true)]));
    const best = Math.min(...[...lows.values()].map((l) => l.score));
    const bestGroup = el.filter((id) => lows.get(id).score === best);
    const winners = hv.winners.filter((w) => w.potIndex === pi);
    const winIds = new Set(winners.map((w) => w.playerId));
    for (const w of winners) {
      g.ok(w.half === "whole", `${variant} hand ${rec.handNumber}: low-only pot should pay "whole", got ${w.half}`);
      g.ok(!!w.handName && LOW_NAME_RE.test(w.handName), `${variant} hand ${rec.handNumber}: winning handName "${w.handName}" is not a low hand`);
      g.ok(w.handName === lows.get(w.playerId)?.name, `${variant} hand ${rec.handNumber}: handName "${w.handName}" != computed low "${lows.get(w.playerId)?.name}"`);
    }
    const allTied = bestGroup.length === el.length;
    if (variant === "fyst") {
      if (el.length >= 2) stats.fystSecond += allTied ? 0 : 1;
      if (allTied) g.ok(el.every((id) => winIds.has(id)), `fyst hand ${rec.handNumber}: everyone tied but not all split the pot`);
      else {
        g.ok(!bestGroup.some((id) => winIds.has(id)), `fyst hand ${rec.handNumber}: the BEST low won (should be second best). winners=${[...winIds].map((id) => rec.names[id])} best=${bestGroup.map((id) => rec.names[id])}`);
        const rest = el.filter((id) => lows.get(id).score !== best);
        const nx = Math.min(...rest.map((id) => lows.get(id).score));
        const exp = rest.filter((id) => lows.get(id).score === nx);
        g.ok(exp.length === winIds.size && exp.every((id) => winIds.has(id)), `fyst hand ${rec.handNumber}: expected second-best low group ${exp.map((id) => rec.names[id])}, got ${[...winIds].map((id) => rec.names[id])}`);
        if (el.length >= 3) stats.fyst3++;
      }
    } else {
      g.ok(bestGroup.length === winIds.size && bestGroup.every((id) => winIds.has(id)), `${variant} hand ${rec.handNumber}: expected best low ${bestGroup.map((id) => rec.names[id])}, got ${[...winIds].map((id) => rec.names[id])}`);
    }
  });
}
// SMD: each half is won by the best high (or best low) hand that uses two or three hole cards.
function smdHook(g, variant, hv, rec, stats) {
  if (Object.keys(rec.shown).length < 2) return;
  stats.showdowns++;
  hv.pots.forEach((pot, pi) => {
    const el = pot.eligiblePlayerIds.filter((id) => rec.shown[id]);
    if (el.length === 0) return;
    const highs = new Map(el.map((id) => [id, bestHigh(rec.shown[id], rec.board, "2or3")]));
    const lows = new Map(el.map((id) => [id, bestLowAny(rec.shown[id], rec.board, "2or3")]));
    const bestHi = Math.max(...[...highs.values()].map((h) => h.score));
    const bestLo = Math.min(...[...lows.values()].map((l) => l.score));
    const hiGroup = el.filter((id) => highs.get(id).score === bestHi).sort();
    const loGroup = el.filter((id) => lows.get(id).score === bestLo).sort();
    const winners = hv.winners.filter((w) => w.potIndex === pi);
    const ids = (half) => winners.filter((w) => w.half === half).map((w) => w.playerId).sort();
    const total = sum(winners.map((w) => w.amount));
    g.ok(winners.every((w) => w.half === "high" || w.half === "low"), `${variant} hand ${rec.handNumber}: SMD pot ${pi + 1} paid a "${winners.find((w) => w.half !== "high" && w.half !== "low")?.half}" half`);
    if (pot.amount >= 2) {
      g.ok(JSON.stringify(ids("high")) === JSON.stringify(hiGroup), `${variant} hand ${rec.handNumber}: high winners ${ids("high")} != expected ${hiGroup}`);
      g.ok(JSON.stringify(ids("low")) === JSON.stringify(loGroup), `${variant} hand ${rec.handNumber}: low winners ${ids("low")} != expected ${loGroup}`);
      g.ok(sum(winners.filter((w) => w.half === "high").map((w) => w.amount)) === Math.ceil(pot.amount / 2), `${variant} hand ${rec.handNumber}: high half should be ceil(${pot.amount}/2)`);
    }
    for (const w of winners) {
      const expected = (w.half === "high" ? highs : lows).get(w.playerId);
      g.ok(!!expected && w.handName === expected.name, `${variant} hand ${rec.handNumber}: handName "${w.handName}" != computed "${expected?.name}"`);
    }
    g.ok(total === pot.amount, `${variant} hand ${rec.handNumber}: pot ${pi + 1} paid ${total} of ${pot.amount}`);
    stats.smdChecked++;
  });
}

// TKO: points decide each half. Nobody left in the pot wins the pot; a player with both the most and the fewest
// points (or several players sharing both) takes the whole pot as one entry.
function tkoHook(g, variant, hv, rec, stats) {
  if (Object.keys(rec.shown).length < 2) return;
  stats.showdowns++;
  hv.pots.forEach((pot, pi) => {
    const el = pot.eligiblePlayerIds.filter((id) => rec.shown[id]);
    if (el.length === 0) return;
    const pts = new Map(el.map((id) => [id, tkoPoints(rec.shown[id], rec.board)]));
    const winners = hv.winners.filter((w) => w.potIndex === pi);
    const ids = (half) => winners.filter((w) => w.half === half).map((w) => w.playerId).sort();
    const total = sum(winners.map((w) => w.amount));
    g.ok(total === pot.amount, `${variant} hand ${rec.handNumber}: TKO pot ${pi + 1} paid ${total} of ${pot.amount}`);
    const empty = el.filter((id) => pts.get(id).remaining.length === 0).sort();
    if (empty.length > 0) {
      g.ok(JSON.stringify(winners.map((w) => w.playerId).sort()) === JSON.stringify(empty), `${variant} hand ${rec.handNumber}: no-cards-left winners ${winners.map((w) => w.playerId)} != ${empty}`);
      g.ok(winners.every((w) => w.half === "whole"), `${variant} hand ${rec.handNumber}: no-cards-left pot should pay "whole"`);
      stats.tkoEmpty++;
      return;
    }
    const most = Math.max(...el.map((id) => pts.get(id).high));
    const fewest = Math.min(...el.map((id) => pts.get(id).low));
    const hiGroup = el.filter((id) => pts.get(id).high === most).sort();
    const loGroup = el.filter((id) => pts.get(id).low === fewest).sort();
    const same = JSON.stringify(hiGroup) === JSON.stringify(loGroup);
    if (same) {
      g.ok(JSON.stringify(winners.map((w) => w.playerId).sort()) === JSON.stringify(hiGroup), `${variant} hand ${rec.handNumber}: whole-pot winners ${winners.map((w) => w.playerId)} != ${hiGroup}`);
      g.ok(winners.every((w) => w.half === "whole"), `${variant} hand ${rec.handNumber}: a player with both the most and fewest points should get a "whole" entry`);
      stats.tkoWhole++;
    } else {
      g.ok(JSON.stringify(ids("high")) === JSON.stringify(hiGroup), `${variant} hand ${rec.handNumber}: most-points winners ${ids("high")} != expected ${hiGroup}`);
      if (pot.amount >= 2) {
        g.ok(JSON.stringify(ids("low")) === JSON.stringify(loGroup), `${variant} hand ${rec.handNumber}: fewest-points winners ${ids("low")} != expected ${loGroup}`);
        g.ok(sum(winners.filter((w) => w.half === "high").map((w) => w.amount)) === Math.ceil(pot.amount / 2), `${variant} hand ${rec.handNumber}: high half should be ceil(${pot.amount}/2)`);
      }
      stats.tkoSplit++;
    }
  });
}

function hiloHook(g, hv, rec, stats) {
  if (Object.keys(rec.shown).length < 2) return;
  const pots = new Map();
  for (const w of hv.winners) { const a = pots.get(w.potIndex) ?? []; a.push(w); pots.set(w.potIndex, a); }
  for (const [pi, ws] of pots) {
    const total = sum(ws.map((w) => w.amount));
    if (total < 2) continue;
    stats.hilo++;
    const hi = sum(ws.filter((w) => w.half === "high").map((w) => w.amount));
    const lo = sum(ws.filter((w) => w.half === "low").map((w) => w.amount));
    g.ok(hi > 0 && lo > 0, `hand ${rec.handNumber} pot ${pi + 1}: showdown pot ${total} not split high/low (high ${hi}, low ${lo})`);
    g.ok(hi === Math.ceil(total / 2), `hand ${rec.handNumber} pot ${pi + 1}: high half ${hi} should be ceil(${total}/2)`);
    g.ok(ws.every((w) => w.half !== "whole"), `hand ${rec.handNumber} pot ${pi + 1}: has a "whole" winner in a Hi/Lo pot`);
  }
}

// ------------------------------------------------------------------ game runs (random legal actions)
async function playGame(g, ctx, variant, n, hands, policy = POLICY) {
  const T = await makeTable(g, ctx, variant, n, {}, { bots: policy });
  const H = T.host;
  const v0 = VARIANTS[variant];
  const stud = v0.kind === "stud";
  const stats = { showdowns: 0, fystSecond: 0, fyst3: 0, hilo: 0, reshuffles: 0, foldEnds: 0, rebuys: 0, smdChecked: 0, tkoEmpty: 0, tkoWhole: 0, tkoSplit: 0 };
  const hiRule = !!v0.highWinner && v0.highWinner !== "best";
  const wantMore = () => (variant.startsWith("fyst") ? stats.fyst3 < 2 : variant === "dumb" ? stats.showdowns < 2 : variant === "nlhe-hilo" ? stats.hilo < 2 : variant === "plo4-lo" ? stats.showdowns < 2 : false);
  H.s.emit("host:start");
  let i = 0;
  while (i < hands || (wantMore() && i < hands + 8)) {
    i++;
    const done = await until(() => H.v.hand?.handNumber === i && H.v.hand.phase === "complete" && H.v.pendingAward && T.clients.every((c) => c.v?.hand?.handNumber === i && c.v.hand.phase === "complete" && c.v.pendingAward), 60000, 15);
    if (!done) {
      const stuck = T.clients.find((c) => c.v?.hand?.legal);
      g.fail(`hand ${i} never completed (phase ${H.v.hand?.phase}, toAct ${H.v.hand?.toActSeat}, status ${H.v.status}, legal on ${stuck?.name ?? "nobody"})`);
      break;
    }
    const v = H.v, hv = v.hand, pa = v.pendingAward;
    const last = i >= hands && !wantMore();
    // pot / award bookkeeping before the award
    const potSum = sum(hv.pots.map((p) => p.amount));
    g.ok(pa.amount === potSum, `hand ${i}: pendingAward ${pa.amount} != pot shown at showdown ${potSum}`);
    g.ok(sum(hv.winners.map((w) => w.amount)) === pa.amount, `hand ${i}: winners total ${sum(hv.winners.map((w) => w.amount))} != pendingAward ${pa.amount}`);
    g.ok(sum(pa.suggested.map((s) => s.amount)) === pa.amount, `hand ${i}: suggested awards do not add up to pendingAward`);
    g.ok(pa.handNumber === i, `hand ${i}: pendingAward.handNumber ${pa.handNumber}`);
    conserve(g, T, pa.amount, `hand ${i} (before award)`);
    // all viewers agree on public info (up cards for stud)
    const ref = JSON.stringify(v.seats.map((s) => s && s.upCards));
    g.ok(T.clients.every((c) => JSON.stringify(c.v.seats.map((s) => s && s.upCards)) === ref), `hand ${i}: viewers disagree about face-up cards`);
    const liveCount = v.seats.filter((s) => s && s.inHand).length;
    if (stud && v0.kind === "stud" && liveCount >= 2 && v.config.stud.declare) {
      g.ok(v.seats.filter((s) => s && s.inHand).every((s) => s.declared !== null), `hand ${i}: declarations not revealed at showdown`);
    }
    if (liveCount <= 1) stats.foldEnds++;
    // deck commitment
    const rec = await T.getHand(H, i);
    if (!g.ok(!!rec, `hand ${i}: getHand returned nothing`)) break;
    g.ok(rec.handNumber === i && rec.variant === variant, `hand ${i}: record has wrong hand/variant`);
    g.ok(rec.reveal.deck.length === 52, `hand ${i}: revealed deck has ${rec.reveal.deck.length} cards`);
    g.ok(sha(`${rec.reveal.salt}:${rec.reveal.deck.join(",")}`) === rec.deckHash, `hand ${i}: deckHash != sha256(salt:deck)`);
    g.ok(rec.deckHash === hv.deckHash, `hand ${i}: record deckHash differs from the one shown during the hand`);
    fairOk(g, rec, `hand ${i}`);
    if (rec.summary.some((l) => /Discards reshuffled/.test(l))) stats.reshuffles++;
    if (variant === "plo4-lo" || variant === "fyst") lowHook(g, variant, hv, rec, stats);
    if (hiRule) highRuleHook(g, variant, hv, rec, stats);
    if (variant === "nlhe-hilo") hiloHook(g, hv, rec, stats);
    if (variant.startsWith("smd")) smdHook(g, variant, hv, rec, stats);
    if (variant.startsWith("tko")) tkoHook(g, variant, hv, rec, stats);
    // award exactly what the engine suggests (the normal "Next hand" path)
    const before = new Map(v.seats.filter(Boolean).map((s) => [s.playerId, s.stack]));
    if (last) H.s.emit("host:pause", { paused: true });
    H.s.emit("host:award", { awards: pa.suggested });
    if (!(await until(() => !H.v.pendingAward, 5000))) { g.fail(`hand ${i}: award was not accepted: ${H.errors.slice(-1)}`); break; }
    await sleep(30);
    const after = H.v;
    const gained = sum(after.seats.filter(Boolean).map((s) => s.stack - (before.get(s.playerId) ?? 0)));
    g.ok(gained === pa.amount, `hand ${i}: stacks grew by ${gained} but pot was ${pa.amount}`);
    g.ok(sum(after.hand.winners.map((w) => w.amount)) === pa.amount, `hand ${i}: awarded winners total != pendingAward`);
    conserve(g, T, 0, `hand ${i} (after award)`);
    g.ok(after.handList.length === i && after.handList[0]?.handNumber === i, `hand ${i}: handList has ${after.handList.length} entries (newest ${after.handList[0]?.handNumber})`);
    g.ok(after.handList[0]?.pot === pa.amount, `hand ${i}: handList pot ${after.handList[0]?.pot} != ${pa.amount}`);
    const rec2 = await T.getHand(H, i);
    g.ok(!!rec2 && sum(rec2.winners.map((w) => w.amount)) === pa.amount, `hand ${i}: stored record winners != pendingAward`);
    // dealer re-buys anyone who busted so the table keeps going
    for (const s of after.seats.filter(Boolean)) {
      if (s.stack === 0) { H.s.emit("host:adjustStack", { playerId: s.playerId, delta: T.buyIn }); T.buyIns += T.buyIn; stats.rebuys++; await until(() => seatOf(H.v, s.playerId)?.stack > 0, 3000); }
    }
    if (last) break;
  }
  const played = H.v.handList.length;
  g.ok(played >= Math.min(hands, 1), `only ${played} hands finished`);
  if (variant === "murder5") {
    g.note(`${stats.reshuffles} of ${played} hands reshuffled the discards`);
    if (n >= 8 && stats.reshuffles === 0) g.note("WARNING: no discard reshuffle was exercised in this run");
  }
  if (variant.startsWith("fyst")) g.note(`${stats.showdowns} showdowns, ${stats.fyst3} with a 3+ player second-best check`);
  if (variant === "dumb") g.note(`${stats.showdowns} lowest-best-hand showdowns verified`);
  if (variant === "nlhe-hilo") g.note(`${stats.hilo} hi/lo split pots verified`);
  if (variant === "plo4-lo") g.note(`${stats.showdowns} low showdowns verified`);
  if (variant.startsWith("smd")) g.note(`${stats.showdowns} showdowns verified (2or3 high and low)`);
  if (variant.startsWith("tko")) g.note(`${stats.showdowns} showdowns: ${stats.tkoSplit} split, ${stats.tkoWhole} whole-pot, ${stats.tkoEmpty} no-cards-left`);
  g.note(`${n} players, ${played} hands, ${stats.foldEnds} won by fold-out, ${stats.rebuys} dealer re-buys after busts`);
}

// ------------------------------------------------------------------ rule scenarios
async function scenHouseBoard(g, ctx, variant, n, label) {
  const T = await makeTable(g, ctx, variant, n);
  const H = T.host;
  const pot = VARIANTS[variant].betting === "pot-limit";
  const expMaxPre = 220; // house rule: in cash games the house limit replaces pot-limit sizing
  H.s.emit("host:start");
  if (!(await T.actor())) throw new Error("hand never started");
  const phase = () => H.v.hand.phase;
  const rangeIs = (l, min, max, what) => g.ok(l.minRaiseTo === min && l.maxRaiseTo === max, `${label} ${what}: raise range ${l.minRaiseTo}..${l.maxRaiseTo}, expected ${min}..${max}`);
  const callAround = async (ph) => {
    for (let k = 0; k < 20 && phase() === ph; k++) {
      const a = await T.actor(8000); if (!a) break;
      const l = a.v.hand.legal;
      await T.act(a, l.canCheck ? { type: "check" } : { type: "call" });
    }
  };
  // ---- preflop
  let a = await T.actor();
  let l = a.v.hand.legal;
  // The first raise is by the big blind: 20 + 20 = 40 minimum (a raise is at least as big as the last one).
  rangeIs(l, 40, expMaxPre, "preflop first raise");
  let err = await T.act(a, { type: "raise", amount: 39 });
  g.ok(!!err && MONEY_RE.test(err), `${label}: raise below minimum should be rejected with a dollar-formatted error, got ${JSON.stringify(err)}`);
  err = await T.act(a, { type: "raise", amount: expMaxPre + 1 });
  g.ok(!!err && MONEY_RE.test(err), `${label}: raise above maximum should be rejected with a dollar-formatted error, got ${JSON.stringify(err)}`);
  err = await T.act(a, { type: "raise", amount: 2500 });
  g.ok(!!err && MONEY_RE.test(err), `${label}: huge raise should be rejected with a dollar-formatted error, got ${JSON.stringify(err)}`);
  let hi = 20, amt = Math.min(l.maxRaiseTo, 120), inc = amt - hi; // raise by 100 (house limit applies to Omaha too)
  g.ok(!(await T.act(a, { type: "raise", amount: amt })), `${label}: legal raise to ${amt} was rejected`);
  a = await T.actor(); l = a.v.hand.legal;
  g.ok(l.minRaiseTo === amt + inc, `${label}: after a raise by ${inc} the next min should be ${amt + inc}, got ${l.minRaiseTo}`);
  rangeIs(l, 220, 320, "after raise by 100");
  for (let r = 2; r <= 3; r++) {
    const to = l.minRaiseTo, i2 = to - amt;
    g.ok(!(await T.act(a, { type: "raise", amount: to })), `${label}: raise #${r} to ${to} was rejected`);
    amt = to; inc = i2;
    a = await T.actor(); l = a.v.hand.legal;
    if (r < 3) g.ok(l.minRaiseTo === amt + inc, `${label}: raise #${r + 1} min should be ${amt + inc}, got ${l.minRaiseTo}`);
  }
  g.ok(l.minRaiseTo === null && l.maxRaiseTo === null && l.callAmount > 0, `${label}: 4th preflop raise must not be offered, legal=${l.minRaiseTo}..${l.maxRaiseTo}`);
  err = await T.act(a, { type: "raise", amount: amt + 150 });
  g.ok(!!err, `${label}: a 4th raise was accepted`);
  await callAround("preflop");
  // ---- flop: a 200 bet can be raised by exactly 200 (to 400), not 401; the next raise is offered at exactly 600
  if (phase() !== "flop") throw new Error(`expected flop, got ${phase()}`);
  a = await T.actor(); l = a.v.hand.legal;
  rangeIs(l, 20, 200, "flop opening bet");
  g.ok(!(await T.act(a, { type: "raise", amount: 200 })), `${label}: opening bet of 200 rejected`);
  const b = await T.actor(); const lb = b.v.hand.legal;
  g.ok(lb.callAmount === 200 && lb.minRaiseTo === 400 && lb.maxRaiseTo === 400, `${label}: after a 200 bet the raise must be offered at exactly 400, got ${lb.minRaiseTo}..${lb.maxRaiseTo} (call ${lb.callAmount})`);
  err = await T.act(b, { type: "raise", amount: 401 });
  g.ok(!!err && MONEY_RE.test(err), `${label}: a raise to 401 over a 200 bet must be rejected, got ${JSON.stringify(err)}`);
  g.ok(!(await T.act(b, { type: "raise", amount: 400 })), `${label}: a raise to exactly 400 over a 200 bet was rejected`);
  const c = await T.actor(); const lc = c.v.hand.legal;
  rangeIs(lc, 600, 600, "after a raise to 400");
  await callAround("flop");
  // ---- turn: bet 20 then 3 raises
  if (phase() !== "turn") throw new Error(`expected turn, got ${phase()}`);
  a = await T.actor(); l = a.v.hand.legal;
  rangeIs(l, 20, 200, "turn opening bet");
  await T.act(a, { type: "raise", amount: 20 });
  a = await T.actor(); l = a.v.hand.legal;
  rangeIs(l, 40, 220, "turn raise after a bet of 20");
  amt = 20; inc = 20;
  for (let r = 1; r <= 3; r++) {
    const to = l.minRaiseTo;
    g.ok(!(await T.act(a, { type: "raise", amount: to })), `${label}: turn raise #${r} to ${to} rejected`);
    inc = to - amt; amt = to;
    a = await T.actor(); l = a.v.hand.legal;
    if (r < 3) g.ok(l.minRaiseTo === amt + inc, `${label}: turn raise #${r + 1} min should be ${amt + inc}, got ${l.minRaiseTo}`);
  }
  g.ok(l.minRaiseTo === null, `${label}: 4th raise on the turn must not be offered (bet + 3 raises)`);
  await callAround("turn");
  // ---- river: check it down, finish
  for (let k = 0; k < 20 && H.v.hand.phase !== "complete"; k++) {
    const x = await T.actor(8000); if (!x) break;
    await T.act(x, x.v.hand.legal.canCheck ? { type: "check" } : { type: "call" });
  }
  g.ok(!!(await until(() => H.v.pendingAward, 5000)), `${label}: hand did not finish`);
  if (H.v.pendingAward) { const pa = H.v.pendingAward; await T.award(); conserve(g, T, 0, label); g.ok(pa.amount > 0, `${label}: empty pot`); }
  g.note(`${n} players${pot ? ", house limit replaces the pot limit (first raise up to 220)" : ""}`);
}

async function scenMurder3(g, ctx) {
  const T = await makeTable(g, ctx, "murder5", 3);
  const H = T.host;
  H.s.emit("host:start");
  const seen = { key: "", raises5: 0, anteChecked: false };
  const expect = (cond, msg) => g.ok(cond, `5-Murder: ${msg}`);
  const observe = (a, v) => {
    const h = v.hand, key = `${h.phase}/${h.stage}`, first = key !== seen.key;
    seen.key = key; seen.first = first;
    if (first) {
      if (h.stage === "bet") {
        const exp = expectedOpener(v);
        expect(h.toActSeat === exp, `${h.phase} bet round opened by seat ${h.toActSeat}, lowest up cards are seat ${exp}`);
      } else if (h.stage === "exchange" || h.stage === "declare") {
        const exp = expectedOpener(v, true);
        expect(h.toActSeat === exp, `${h.phase} ${h.stage} round started with seat ${h.toActSeat}, lowest up cards are seat ${exp}`);
      }
    }
    if (!seen.anteChecked) {
      seen.anteChecked = true;
      expect(totalPot(v) === 60, `ante pot should be 3 x 20 = 60, is ${totalPot(v)}`);
      expect(v.seats.filter(Boolean).every((s) => s.stack + s.bet === T.buyIn - 20), `every stack should be buy-in minus the 20 ante`);
    }
  };
  const decide = (a, l, v) => {
    const h = v.hand, first = seen.first;
    if (h.stage === "exchange") return { type: "exchange", card: null };
    if (h.stage === "declare") return { type: "declare", choice: "high" };
    const callOrCheck = l.canCheck ? { type: "check" } : { type: "call" };
    const last = h.phase === "draw2";
    if (first) expect(l.minRaiseTo === 20 && l.maxRaiseTo === (last ? 200 : 100), `${h.phase} opening bet range ${l.minRaiseTo}..${l.maxRaiseTo}, expected 20..${last ? 200 : 100}`);
    if (h.phase === "2nd") {
      if (first) return { type: "raise", amount: 100 };
      expect(l.minRaiseTo === 200 && l.maxRaiseTo === 200, `a bet of the 100 maximum can be raised by exactly 100 (to 200) before the last round (min ${l.minRaiseTo}..${l.maxRaiseTo})`);
      return callOrCheck;
    }
    if (h.phase === "3rd") {
      if (first) return { type: "raise", amount: 50 };
      if (!seen.p3) { seen.p3 = true; expect(l.minRaiseTo === 100 && l.maxRaiseTo === 150, `after a bet of 50 the raise range should be 100..150, is ${l.minRaiseTo}..${l.maxRaiseTo}`); }
      return callOrCheck;
    }
    if (h.phase === "5th") {
      if (first) { seen.raises5 = 0; return { type: "raise", amount: 20 }; }
      if (seen.raises5 < 3) { expect(l.minRaiseTo !== null, `raise #${seen.raises5 + 1} should be offered`); if (l.minRaiseTo === null) return callOrCheck; seen.raises5++; return { type: "raise", amount: l.minRaiseTo }; }
      if (!seen.cap5) { seen.cap5 = true; expect(l.minRaiseTo === null, `the 4th raise in a round must not be offered (min ${l.minRaiseTo})`); }
      return callOrCheck;
    }
    if (last) {
      if (first) return { type: "raise", amount: 200 };
      expect(l.minRaiseTo === 400 && l.maxRaiseTo === 400, `a last-round bet of 200 can be raised by exactly 200 (to 400) (min ${l.minRaiseTo}..${l.maxRaiseTo})`);
      return callOrCheck;
    }
    return callOrCheck;
  };
  const r = await T.playHand(1, decide, observe, 30000);
  expect(r.ok, `hand did not finish (${JSON.stringify(r)})`);
  expect(seen.p3 && seen.cap5, "not every round of the raise-limit script was exercised");
  if (H.v.pendingAward) await T.award();
  conserve(g, T, 0, "5-Murder 3 players");
}

async function scenMurderSwaps(g, ctx) {
  const T = await makeTable(g, ctx, "murder5", 2);
  const H = T.host;
  const expect = (cond, msg) => g.ok(cond, `5-Murder swaps: ${msg}`);
  H.s.emit("host:start");
  // ---- hand 1: face-down swap costs exactly 50, stays in the pot even though the swapper's own bet is returned
  const s1 = { swapper: null, round: 0 };
  const decide1 = (a, l, v) => {
    const h = v.hand;
    if (h.stage === "exchange") {
      if (h.phase === "draw1" && !s1.swapper) {
        s1.swapper = a.pid; s1.potBefore = totalPot(v); s1.stackBefore = seatOf(v, a.pid).stack;
        return { type: "exchange", card: l.exchange.downCards[0] };
      }
      if (h.phase === "draw1" && !s1.checked) {
        s1.checked = true;
        expect(totalPot(v) === s1.potBefore + 50, `face-down swap should add exactly 50 to the pot (${s1.potBefore} -> ${totalPot(v)})`);
        expect(seatOf(v, s1.swapper).stack === s1.stackBefore - 50, `swapper stack should drop by 50 (${s1.stackBefore} -> ${seatOf(v, s1.swapper).stack})`);
      }
      return { type: "exchange", card: null };
    }
    if (h.stage === "declare") return { type: "declare", choice: "high" };
    if (h.phase === "draw1") {
      if (l.canCheck && a.pid === s1.swapper) return { type: "raise", amount: l.minRaiseTo };
      if (!l.canCheck && a.pid !== s1.swapper) return { type: "fold" };
    }
    return l.canCheck ? { type: "check" } : { type: "call" };
  };
  let r = await T.playHand(1, decide1, null, 30000);
  expect(r.ok, `hand 1 did not finish (${JSON.stringify(r)})`);
  let pa = H.v.pendingAward;
  expect(pa?.amount === 90, `pot should be 2 antes (40) + one 50 swap fee = 90 and never refunded, is ${pa?.amount}`);
  expect(pa?.suggested?.length === 1 && pa.suggested[0].playerId === s1.swapper, "the bettor who won by fold-out should be the only winner");
  if (pa) { await T.award(); const sw = seatOf(H.v, s1.swapper); expect(sw?.stack === T.buyIn - 20 - 50 + 90, `swapper should end with ${T.buyIn + 20}, has ${sw?.stack}`); }
  conserve(g, T, 0, "murder swaps hand 1");
  // ---- hand 2: face-up swaps are free
  const s2 = { first: null };
  const decide2 = (a, l, v) => {
    const h = v.hand;
    if (h.stage === "exchange") {
      if (h.phase === "draw1" && !s2.first) {
        s2.first = { pid: a.pid, up: [...l.exchange.upCards], stack: seatOf(v, a.pid).stack, pot: totalPot(v), old: l.exchange.upCards[0] };
        return { type: "exchange", card: l.exchange.upCards[0] };
      }
      if (h.phase === "draw1" && !s2.checked) {
        s2.checked = true;
        const now = seatOf(v, s2.first.pid);
        expect(totalPot(v) === s2.first.pot, `face-up swap must be free (pot ${s2.first.pot} -> ${totalPot(v)})`);
        expect(now.stack === s2.first.stack, `face-up swap must not cost the swapper (stack ${s2.first.stack} -> ${now.stack})`);
        expect(now.upCards.length === 3 && now.upCards[0] !== s2.first.old && now.upCards.slice(1).join() === s2.first.up.slice(1).join(), `face-up swap should replace exactly that card in place (${s2.first.up} -> ${now.upCards})`);
      }
      return { type: "exchange", card: null };
    }
    if (h.stage === "declare") return { type: "declare", choice: "high" };
    return l.canCheck ? { type: "check" } : { type: "call" };
  };
  r = await T.playHand(2, decide2, null, 30000);
  expect(r.ok, `hand 2 did not finish (${JSON.stringify(r)})`);
  pa = H.v.pendingAward;
  expect(pa?.amount === 40, `with only a free face-up swap the pot is just the antes (40), is ${pa?.amount}`);
  if (pa) await T.award();
  conserve(g, T, 0, "murder swaps hand 2");
}

async function scenDealer(g, ctx) {
  const T = await makeTable(g, ctx, "nlhe", 3);
  const [H, A, B] = T.clients;
  const expect = (cond, msg) => g.ok(cond, `dealer: ${msg}`);
  const callDec = (a, l) => (l.canCheck ? { type: "check" } : { type: "call" });
  H.s.emit("host:start");
  let r = await T.playHand(1, callDec, null);
  expect(r.ok, `hand 1 did not finish (${JSON.stringify(r)})`);
  const pa = H.v.pendingAward;
  await sleep(1700);
  expect(H.v.hand.handNumber === 1 && H.v.hand.phase === "complete" && !!H.v.pendingAward && H.v.status === "playing", "the next hand must not start before host:award");
  const eA = A.errors.length;
  A.s.emit("host:award", { awards: pa.suggested });
  expect(!!(await until(() => A.errors.length > eA, 3000)), "a non-host award should be rejected");
  const eH = H.errors.length;
  H.s.emit("host:award", { awards: [{ playerId: pa.suggested[0].playerId, amount: pa.amount - 1 }] });
  await until(() => H.errors.length > eH, 3000);
  expect(H.errors.length > eH && /add up/i.test(H.errors.at(-1)) && !!H.v.pendingAward, `a wrong total must be rejected and leave the pot waiting (${H.errors.at(-1)})`);
  expect(MONEY_RE.test(H.errors.at(-1) ?? ""), "the wrong-total error should show dollars");
  const e2 = H.errors.length;
  H.s.emit("host:award", { awards: [{ playerId: "not-a-player", amount: pa.amount }] });
  await until(() => H.errors.length > e2, 3000);
  expect(H.errors.length > e2 && !!H.v.pendingAward, "awarding to a stranger must be rejected");
  // pause so the follow-up money moves happen between hands
  H.s.emit("host:pause", { paused: true });
  await until(() => H.v.status === "paused", 3000);
  await T.award();
  expect(!H.v.pendingAward, "valid award should be accepted");
  conserve(g, T, 0, "after hand 1 award");
  await sleep(1500);
  expect(H.v.hand.handNumber === 1, "no new hand while the game is paused");
  // transfer
  const sa = seatOf(H.v, A.pid).stack, sb = seatOf(H.v, B.pid).stack;
  H.s.emit("host:transfer", { fromPlayerId: A.pid, toPlayerId: B.pid, amount: 25 });
  await until(() => seatOf(H.v, B.pid).stack === sb + 25, 3000);
  expect(seatOf(H.v, A.pid).stack === sa - 25 && seatOf(H.v, B.pid).stack === sb + 25, `host:transfer should move exactly 25 (A ${sa}->${seatOf(H.v, A.pid).stack}, B ${sb}->${seatOf(H.v, B.pid).stack})`);
  const e3 = H.errors.length;
  H.s.emit("host:transfer", { fromPlayerId: A.pid, toPlayerId: B.pid, amount: 99999999 });
  await until(() => H.errors.length > e3, 3000);
  expect(H.errors.length > e3, "transferring more than the stack should be rejected");
  // sit out / back in
  H.s.emit("host:sitOut", { playerId: B.pid, sittingOut: true });
  await until(() => seatOf(H.v, B.pid).sittingOut, 3000);
  expect(seatOf(H.v, B.pid).sittingOut === true, "host:sitOut should mark the player away");
  H.s.emit("host:sitOut", { playerId: B.pid, sittingOut: false });
  await until(() => !seatOf(H.v, B.pid).sittingOut, 3000);
  expect(seatOf(H.v, B.pid).sittingOut === false, "host:sitOut false should bring the player back");
  // players cannot rebuy
  const e4 = A.errors.length;
  A.s.emit("rebuy");
  await until(() => A.errors.length > e4, 3000);
  expect(A.errors.length > e4 && /dealer/i.test(A.errors.at(-1)), `player rebuy must be rejected with a note about the dealer (${A.errors.at(-1)})`);
  const e5 = A.errors.length;
  A.s.emit("host:adjustStack", { playerId: A.pid, delta: 500 });
  await until(() => A.errors.length > e5, 3000);
  expect(A.errors.length > e5, "a non-host cannot adjust stacks");
  // bust A by moving everything away, then re-seat with a positive adjustment
  const all = seatOf(H.v, A.pid).stack;
  H.s.emit("host:transfer", { fromPlayerId: A.pid, toPlayerId: B.pid, amount: all });
  await until(() => seatOf(H.v, A.pid).stack === 0, 3000);
  expect(seatOf(H.v, A.pid).stack === 0 && seatOf(H.v, A.pid).sittingOut, "emptied player should be busted and sitting out");
  H.s.emit("host:adjustStack", { playerId: A.pid, delta: 500 });
  await until(() => seatOf(H.v, A.pid).stack === 500, 3000);
  expect(seatOf(H.v, A.pid).stack === 500 && !seatOf(H.v, A.pid).sittingOut, `positive host:adjustStack should re-seat the busted player (stack ${seatOf(H.v, A.pid).stack}, out ${seatOf(H.v, A.pid).sittingOut})`);
  T.buyIns += 500;
  conserve(g, T, 0, "after dealer moves");
  expect(H.v.ledger.find((l) => l.playerId === A.pid)?.buyIns === T.buyIn + 500, "ledger should record the 500 re-buy");
  // resume and test extendTime on a live hand
  H.s.emit("host:pause", { paused: false });
  const started = await until(() => H.v.hand?.handNumber === 2 && H.v.hand.phase !== "complete", 8000);
  expect(!!started, "game should resume with a new hand after un-pausing");
  const a1 = await T.actor(8000, 2);
  if (a1) {
    expect(H.v.seats.filter(Boolean).every((s) => s.holeCount > 0), "the re-seated player should be dealt in");
    const other = T.clients.find((c) => c !== a1);
    const eo = other.errors.length;
    other.s.emit("extendTime");
    await until(() => other.errors.length > eo, 3000);
    expect(other.errors.length > eo, "extendTime by a player who is not to act should be rejected");
    const dl0 = a1.v.hand.actionDeadline;
    expect(a1.v.canExtend === true, "canExtend should be true on your turn");
    a1.s.emit("extendTime");
    await until(() => a1.v.hand?.actionDeadline > dl0, 3000);
    const diff = a1.v.hand.actionDeadline - dl0;
    expect(diff >= 14000 && diff <= 16000, `extendTime should add about 15s, added ${diff}ms`);
    expect(a1.v.canExtend === false, "canExtend should be false after using it");
    const e6 = a1.errors.length;
    a1.s.emit("extendTime");
    await until(() => a1.errors.length > e6, 3000);
    expect(a1.errors.length > e6, "a second extendTime in the same turn must be rejected");
    await T.act(a1, callDec(a1, a1.v.hand.legal));
    const a2 = await T.actor(8000, 2);
    if (a2 && a2 !== a1 || a2) {
      expect(a2.v.canExtend === true, "extension should be available again on a new turn");
      const d2 = a2.v.hand.actionDeadline;
      a2.s.emit("extendTime");
      await until(() => a2.v.hand?.actionDeadline > d2, 3000);
      expect(a2.v.hand.actionDeadline > d2, "extendTime should work again on the next turn");
    }
  } else g.fail("dealer: nobody to act in hand 2");
  r = await T.playHand(2, callDec, null);
  expect(r.ok, `hand 2 did not finish (${JSON.stringify(r)})`);
  if (H.v.pendingAward) await T.award();
  conserve(g, T, 0, "end of dealer flow");
}

// ------------------------------------------------------------------ persistence (local only)
async function scenPersistence(g, ctx) {
  const T = await makeTable(g, ctx, "plo4", 3);
  const H = T.host;
  const expect = (cond, msg) => g.ok(cond, `persistence: ${msg}`);
  H.s.emit("host:start");
  const a = await T.actor();
  if (!a) throw new Error("hand never started");
  await T.act(a, { type: "raise", amount: 41 });
  for (let k = 0; k < 8 && H.v.hand.phase === "preflop"; k++) { const x = await T.actor(5000); if (!x) break; await T.act(x, x.v.hand.legal.canCheck ? { type: "check" } : { type: "call" }); }
  const x = await T.actor(5000);
  if (x) await T.act(x, { type: "raise", amount: 20 }); // a bet on the flop
  await T.actor(5000);
  await sleep(200);
  const snap = (c) => {
    const v = c.v, h = v.hand, me = v.seats[v.you.seat];
    return JSON.stringify({ host: v.hostPlayerId, hn: h.handNumber, phase: h.phase, board: h.board, hole: me.holeCards, stacks: v.seats.map((s) => s && [s.playerId, s.stack, s.bet, s.folded, s.sittingOut]), toAct: h.toActSeat, pots: h.pots, hash: h.deckHash, led: v.ledger, cfg: v.config });
  };
  const before = T.clients.map(snap);
  expect(JSON.parse(before[0]).phase !== "preflop", "test setup should be past the preflop");
  const pids = T.clients.map((c) => c.pid);
  // stop the server hard, start another on the same data directory
  for (const c of T.clients) c.s.disconnect();
  await ctx.restart();
  const names = T.clients.map((c) => c.name);
  const fresh = [];
  for (let i = 0; i < T.clients.length; i++) {
    const c = connect(ctx, g, T.tid, names[i], T.clients[i].token);
    fresh.push(c);
    if (!(await until(() => c.v, 10000))) { g.fail("persistence: could not rejoin after restart"); return; }
  }
  expect(fresh.every((c, i) => c.pid === pids[i]), "player ids changed after restart");
  expect(!!(await until(() => fresh.every((c) => c.v.hand), 5000)), "hand missing after restart");
  const after = fresh.map(snap);
  for (let i = 0; i < fresh.length; i++) expect(after[i] === before[i], `${names[i]} sees a different table after restart:\n  before ${before[i].slice(0, 300)}\n  after  ${after[i].slice(0, 300)}`);
  const T2 = { ...T, clients: fresh, host: fresh[0] };
  Object.assign(T2, { act: T.act, actor: async (ms = 20000, hand) => until(() => fresh.find((c) => c.v?.hand?.legal && c.v.hand.phase !== "complete" && (hand === undefined || c.v.hand.handNumber === hand)), ms), award: T.award });
  // continue to the end
  let guard = 0;
  while (fresh[0].v.hand.phase !== "complete" && guard++ < 400) {
    const y = fresh.find((c) => c.v?.hand?.legal);
    if (!y) { await sleep(10); continue; }
    const l = y.v.hand.legal;
    const err = await T.act(y, l.canCheck ? { type: "check" } : { type: "call" });
    if (err) { g.fail(`persistence: action rejected after restart: ${err}`); break; }
  }
  const fin = await until(() => fresh[0].v.pendingAward, 8000);
  expect(!!fin, "hand did not finish after restart");
  if (fin) {
    const pa = fresh[0].v.pendingAward;
    fresh[0].s.emit("host:award", { awards: pa.suggested });
    expect(!!(await until(() => !fresh[0].v.pendingAward, 5000)), "award after restart was not accepted");
    const v = fresh[0].v;
    expect(sum(v.seats.filter(Boolean).map((s) => s.stack)) + sum(v.ledger.map((l) => l.cashOuts)) === sum(v.ledger.map((l) => l.buyIns)), "chips not conserved after restart");
    expect(v.handList.length === 1, `handList after restart has ${v.handList.length} entries`);
    const rec = await new Promise((res) => fresh[0].s.emit("getHand", { handNumber: 1 }, res));
    expect(!!rec && sha(`${rec.reveal.salt}:${rec.reveal.deck.join(",")}`) === rec.deckHash, "deck commitment of the resumed hand does not verify");
    if (rec) fairOk(g, rec, "resumed hand");
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const startedAt = new Date().toISOString();
  const ctx = { url: REMOTE, local: !REMOTE };
  let tmp = null, srv = null;
  if (!REMOTE) {
    process.env.HOMEGAME_NO_LISTEN = "1";
    const mod = await import(pathToFileURL(join(root, "apps/server/dist/index.js")).href);
    tmp = mkdtempSync(join(tmpdir(), "mocha-poker-qa-"));
    srv = await mod.startServer(0, { dataDir: tmp });
    ctx.url = `http://localhost:${srv.port}`;
    ctx.restart = async () => {
      await srv.close();
      srv = await mod.startServer(0, { dataDir: tmp });
      ctx.url = `http://localhost:${srv.port}`;
    };
  }
  console.log(`Mocha Poker game QA against ${ctx.url} (${HANDS} hands per game${REMOTE ? ", live" : ", local with persistence test"})\n`);

  const jobs = [];
  const games = [
    ["nlhe", 6], ["nlhe-hilo", 3], ["plo4", 4], ["plo5", 5], ["plo4-8", 2],
    ["plo5-8", 6], ["plo4-lo8", 3], ["plo4-lo", 4], ["fyst-he", 5], ["fyst-o", 5], ["dumb", 4], ["murder5", 8],
    ["smd4", 4], ["smd5", 5], ["tko4", 6], ["tko5", 4],
  ];
  const showdownish = { fold: 0.04, raise: 0.2, swap: 0.65 };
  for (const [variant, n] of games) {
    const policy = variant.startsWith("fyst") || variant === "dumb" || variant === "plo4-lo" || variant === "nlhe-hilo" || variant.startsWith("smd") || variant.startsWith("tko") ? showdownish : variant === "murder5" ? { fold: 0.03, raise: 0.2, swap: 1 } : POLICY;
    jobs.push([`game ${variant} (${n} players, ${HANDS} hands)`, (g) => playGame(g, ctx, variant, n, HANDS, policy)]);
  }
  jobs.push(["rules: house limit, Hold'em 3-handed", (g) => scenHouseBoard(g, ctx, "nlhe", 3, "nlhe 3p")]);
  jobs.push(["rules: house limit, Hold'em heads-up", (g) => scenHouseBoard(g, ctx, "nlhe", 2, "nlhe HU")]);
  jobs.push(["rules: house limit, pot-limit Omaha", (g) => scenHouseBoard(g, ctx, "plo4", 3, "plo4 3p")]);
  jobs.push(["rules: 5-Murder stakes, opener, raise caps", (g) => scenMurder3(g, ctx)]);
  jobs.push(["rules: 5-Murder swaps (50 face-down, free face-up)", (g) => scenMurderSwaps(g, ctx)]);
  jobs.push(["rules: dealer flow", (g) => scenDealer(g, ctx)]);

  const conc = REMOTE ? 4 : 8;
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const [name, fn] = jobs[next++]; await runGroup(name, fn); } };
  await Promise.all(Array.from({ length: conc }, worker));

  if (!REMOTE) await runGroup("persistence: restart mid-hand", (g) => scenPersistence(g, ctx));
  else console.log("SKIP  persistence: restart mid-hand (live server)");

  if (srv) await srv.close().catch(() => {});
  if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter((r) => !r.ok);
  const totalChecks = sum(results.map((r) => r.details.checks));
  console.log(`\n${results.length - failed.length}/${results.length} groups passed, ${totalChecks} checks, ${((Date.now() - Date.parse(startedAt)) / 1000).toFixed(0)}s`);
  if (JSON_PATH) {
    mkdirSync(dirname(resolve(JSON_PATH)), { recursive: true });
    writeFileSync(resolve(JSON_PATH), JSON.stringify({ startedAt, url: ctx.url, results }, null, 2));
    console.log(`report written to ${JSON_PATH}`);
  }
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
