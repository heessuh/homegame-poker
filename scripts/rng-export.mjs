#!/usr/bin/env node
// Raw random bytes from the PRODUCTION "mochapoker-v1" stream, for external test suites
// (dieharder, PractRand, NIST STS). See docs/RNG_TESTING.md and docs/FAIRNESS.md.
//
//   node scripts/rng-export.mjs [--mode=stream|decks] [--bytes N] [--out FILE]
//
// stream (default): per simulated hand, a fresh random 32-byte server seed and realistic material
//   `mochapoker-v1|<table>|<hand>|<p:seed,...>`; emits the first 8 HMAC-SHA256 blocks (256 bytes = 64
//   big-endian uint32 words; a shuffle consumes ~51), i.e. the exact bytes the shuffle reads, then the
//   next hand. Tests the HMAC stream across many seeds/materials.
// decks: per derived deck, the Fisher-Yates swap indices j_51..j_1 (j_i uniform on [0,i], rejection-sampled
//   exactly as production) are combined into the permutation's mixed-radix (Lehmer) rank in [0, 52!) and
//   the LOW 200 BITS are emitted (25 bytes, big-endian). 52! ~ 2^225.6, so the low 200 bits have a
//   relative bias of ~2^-25 per value: negligible for these tests. Tests the shuffle layer (rejection
//   sampling + Fisher-Yates), not just the HMAC.
//
// Provenance: the engine does not export its words() generator, so the stream is re-implemented here
// exactly per docs/FAIRNESS.md and, at startup, asserted to reproduce the 3 published test vectors AND
// 300 random hands against the engine's deriveDeck (fairshuffle.ts). Exit code 3 if it ever disagrees.
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createWriteStream } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { buildMaterial, deriveDeck, freshDeck, hexToBytes, rejectionLimit } from "../packages/engine/dist/index.js";

/** Endless stream of big-endian uint32 words: HMAC-SHA256(key, `${prefix}|${i}`), eight words per block. */
export function* words(key, prefix) {
  for (let i = 0; ; i++) {
    const block = createHmac("sha256", key).update(`${prefix}|${i}`).digest();
    for (let o = 0; o < 32; o += 4) yield block.readUInt32BE(o);
  }
}

/** Fisher-Yates per the spec; returns { deck, js } where js[k] is the swap index for i = 51 - k. */
export function shuffleWithJ(serverSeedHex, material) {
  const stream = words(hexToBytes(serverSeedHex), material);
  const deck = freshDeck();
  const js = [];
  for (let i = 51; i >= 1; i--) {
    const n = i + 1;
    const limit = rejectionLimit(n);
    let u = stream.next().value;
    while (u >= limit) u = stream.next().value;
    const j = u % n;
    js.push(j);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { deck, js };
}

// Pooled CSPRNG bytes (one randomBytes syscall per 64 KiB). Server seeds and client seeds come straight from
// here; the tested output is HMAC output keyed by those seeds.
let pool = Buffer.alloc(0), pos = 0;
function take(n) {
  if (pos + n > pool.length) { pool = randomBytes(65536); pos = 0; }
  const out = pool.subarray(pos, pos + n);
  pos += n;
  return out;
}
// Only used to choose hand shapes (table id, player count, hand number), never as tested output.
const rnd = (n) => take(4).readUInt32LE() % n;
const ALPH = "abcdefghijklmnopqrstuvwxyz0123456789";
const rid = (len) => { let s = ""; for (const b of take(len)) s += ALPH[b % ALPH.length]; return s; };

/** A realistic hand: fresh server seed, material with 0-9 players' client seeds. */
export function randomHand() {
  const seed = take(32).toString("hex");
  const seeds = {};
  const players = rnd(10);
  for (let p = 0; p < players; p++) seeds[`p${rid(6)}`] = take(16).toString("hex");
  const material = buildMaterial(`t${rid(5)}`, 1 + rnd(5000), seeds);
  return { seed, material };
}

const VECTORS = [
  ["000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "mochapoker-v1|tbl|1|",
    "Kc 5d Jd 5c Qc 9s 3h Ah Ad 8s 7d 5s Jh Kd 4c Th Ks Qh 8d Ac 3c 7s As Kh Jc 2h Ts 2c 6s 4h 4s 7h Qs 6d 9c 3d 8c 9d Qd 9h 4d Js 2d 7c 6h 2s Tc 6c 3s 8h 5h Td"],
  ["ff".repeat(32), "mochapoker-v1|room7|12|p1:fedcba9876543210fedcba9876543210,p2:0123456789abcdef0123456789abcdef",
    "8c Ad 5h 9s Qc Jd Td 9c 7h 8h Qs 9h Jc 7d 2c 3c 4c 2d Jh 4h 4s Ks 2h 2s 4d 8s As Th Qh 6c Kc 5s Tc 6h 5d 3s Ac 7c 8d 5c 6s 3d Kh 7s Ah Ts Js 6d 9d 3h Kd Qd"],
  ["a5".repeat(32), "mochapoker-v1|abc123|42|amy:22222222222222222222222222222222,bob:33333333333333333333333333333333,zed:11111111111111111111111111111111",
    "9s Qs Qc Jc Kc Jd 4d As Tc Qh 4s 6h 6c 8c Td 5s Th 4c Qd 9c 5h Ac 3h Jh 7s 6d 3d Ad 7c Ks 2c 9d Kd Js 9h 8d 3c Ts 4h Ah 2d 2s 5d 7d 7h 6s 8h Kh 8s 3s 5c 2h"],
];

/** Proves this file's stream is the production stream: published vectors + random hands vs engine deriveDeck. */
export function assertProduction(randomHands = 300) {
  for (const [seed, material, expected] of VECTORS) {
    const mine = shuffleWithJ(seed, material).deck.join(" ");
    if (mine !== expected || deriveDeck(seed, material).join(" ") !== expected) throw new Error(`test vector mismatch for ${material}`);
  }
  for (let k = 0; k < randomHands; k++) {
    const { seed, material } = randomHand();
    if (shuffleWithJ(seed, material).deck.join(" ") !== deriveDeck(seed, material).join(" ")) throw new Error("deriveDeck mismatch on a random hand");
  }
}

const BLOCKS_PER_HAND = 8;

export function streamChunk(hands) {
  const out = Buffer.allocUnsafe(hands * BLOCKS_PER_HAND * 32);
  let o = 0;
  for (let h = 0; h < hands; h++) {
    const { seed, material } = randomHand();
    const key = Buffer.from(seed, "hex");
    for (let i = 0; i < BLOCKS_PER_HAND; i++) o += createHmac("sha256", key).update(`${material}|${i}`).digest().copy(out, o);
  }
  return out;
}

const MASK200 = (1n << 200n) - 1n;
export function decksChunk(decks) {
  const out = Buffer.allocUnsafe(decks * 25);
  for (let d = 0; d < decks; d++) {
    const { seed, material } = randomHand();
    const { js } = shuffleWithJ(seed, material);
    let r = 0n;
    for (let k = 0; k < js.length; k++) r = r * BigInt(52 - k) + BigInt(js[k]); // radices 52, 51, ..., 2
    let v = r & MASK200;
    for (let b = 24; b >= 0; b--) { out[d * 25 + b] = Number(v & 0xffn); v >>= 8n; }
  }
  return out;
}

function parseArgs(argv) {
  const a = { mode: "stream", bytes: null, out: null, workers: null };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith("--mode=")) a.mode = s.slice(7);
    else if (s === "--mode") a.mode = argv[++i];
    else if (s === "--bytes") a.bytes = Number(argv[++i]);
    else if (s.startsWith("--bytes=")) a.bytes = Number(s.slice(8));
    else if (s === "--out") a.out = argv[++i];
    else if (s.startsWith("--out=")) a.out = s.slice(6);
    else if (s.startsWith("--workers=")) a.workers = Number(s.slice(10));
    else throw new Error(`unknown argument ${s}`);
  }
  if (!["stream", "decks"].includes(a.mode)) throw new Error("--mode must be stream or decks");
  if (a.bytes !== null && !(a.bytes > 0)) throw new Error("--bytes must be positive");
  if (a.out && a.bytes === null) a.bytes = 64 * 1024 * 1024;
  return a;
}

const makeGen = (mode) => (mode === "stream" ? () => streamChunk(4096) : () => decksChunk(20000));

/** Worker: produces one independent chunk (fresh seeds each hand) per "next" message. Chunk order is irrelevant. */
function workerMain() {
  const gen = makeGen(workerData.mode);
  parentPort.on("message", () => {
    const b = gen();
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    parentPort.postMessage(ab, [ab]);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertProduction();
  const nWorkers = args.workers ?? Math.max(1, Math.min(8, availableParallelism()));
  process.stderr.write(`rng-export: production stream verified (3 vectors + 300 random hands); mode=${args.mode}, workers=${nWorkers}
`);
  const sink = args.out ? createWriteStream(args.out) : process.stdout;
  sink.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(0); // reader (dieharder/PractRand) finished and closed the pipe
    throw e;
  });
  let left = args.bytes ?? Infinity;
  const workers = [];
  await new Promise((resolve, reject) => {
    let done = false;
    for (let k = 0; k < nWorkers; k++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { mode: args.mode } });
      workers.push(w);
      w.on("error", reject);
      w.on("message", async (ab) => {
        if (done) return;
        let buf = Buffer.from(ab);
        if (buf.length > left) buf = buf.subarray(0, left);
        left -= buf.length;
        if (!sink.write(buf)) await new Promise((r) => sink.once("drain", r));
        if (left <= 0) { done = true; return resolve(); }
        w.postMessage("next"); // one chunk in flight per worker; the next is requested only after this one is written
      });
      w.postMessage("next");
    }
  });
  for (const w of workers) w.terminate();
  if (args.out) await new Promise((r) => sink.end(r));
}

if (!isMainThread) {
  workerMain();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(e.message.includes("mismatch") ? 3 : 1);
  });
}
