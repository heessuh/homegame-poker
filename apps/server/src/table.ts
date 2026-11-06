import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEFAULT_CONFIG,
  DEFAULT_HOUSE_LIMIT,
  DEFAULT_STUD,
  VARIANTS,
  applyAction,
  orderFromButton,
  CLIENT_SEED_RE,
  FAIR_ALGORITHM,
  buildMaterial,
  commitDeck,
  deriveDeck,
  ledgerGenesisInput,
  ledgerHashInput,
  seedHash,
  isValidAvatar,
  legalActions,
  potsView,
  startHand,
  timeoutAction,
  type Card,
  type DealerEntry,
  type HandFair,
  type HandListItem,
  type HandRecord,
  type HandState,
  type HandView,
  type HouseLimit,
  type StartHandInput,
  type StudStakes,
  type PendingAward,
  type LedgerEntry,
  type PlayerAction,
  type SeatView,
  type TableConfig,
  type TableView,
  type TournamentConfig,
  type TournamentStanding,
  type TournamentView,
  type WinnerView,
} from "@homegame/engine";

type Rec = (summary: string, details?: Record<string, unknown>) => void;

/** A request the user can fix; the message is shown to them verbatim. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface TableOptions {
  tableId: string;
  now: () => number;
  scheduler: Scheduler;
  /** Test hook: a fixed deck source. Omit in production: decks are then derived (provably fair, see docs/FAIRNESS.md). */
  deckSource?: () => Card[];
  onChange: () => void;
  config?: Partial<TableConfig>;
  /** Resume a table saved earlier (see Table.snapshot). Call resume() once the table is registered. */
  snapshot?: TableSnapshot;
  /** Called once for each finished HandRecord as it is added to the history (used by the RNG audit). */
  onHandRecorded?: (tableId: string, rec: HandRecord) => void;
}

export interface Player {
  id: string;
  token: string;
  name: string;
  connections: number;
  seat: number | null;
  /** Chips at the start of the current hand (authoritative between hands). */
  stack: number;
  sittingOut: boolean;
  timeouts: number;
  buyIns: number;
  cashOuts: number;
  banned: boolean;
  // queued for the end of the current hand
  standQueued: boolean;
  kickQueued: boolean;
  adjustQueued: number;
  /** Sitting out only because the chips ran out (a dealer top-up sits them back in). */
  busted: boolean;
  /** Cash board games: joined mid-game or the big blind passed while away. Not dealt in until it comes around or they post. */
  blindDue: boolean;
  /** Chose to post a big blind and play the next hand. */
  postBlind: boolean;
  avatar: string | null;
  /** Host override of the action timer: null = table default, 0 = no limit. */
  timerSec: number | null;
  /** Tournament finishing place once out (1 = winner); null while alive. */
  place: number | null;
}

export interface Transfer {
  fromId: string;
  toId: string;
  amount: number;
  /** The host who queued it (for the dealer ledger). */
  by?: string;
}

export interface TourneyState {
  status: "registering" | "running" | "finished";
  levelIndex: number;
  levelsCompleted: number;
  levelEndsAt: number | null;
  levelRemainingMs: number;
}

/** Everything needed to resume a table after a restart (JSON-safe). Contains secrets: tokens and the undealt deck. */
export interface TableSnapshot {
  version: number;
  tableId: string;
  savedAt: number;
  config: TableConfig;
  pendingConfig: TableConfig | null;
  status: "waiting" | "playing" | "paused";
  hostId: string | null;
  players: Omit<Player, "connections">[];
  hand: {
    state: HandState;
    deckHash: string;
    reveal: { deck: Card[]; salt: string };
    participants: string[];
    startStacks: [string, number][];
    awarded: WinnerView[] | null;
    extended: boolean;
    /** Revealed with the HandRecord when the hand completes (contains the secret server seed until then). */
    fair?: HandFair | null;
  } | null;
  pendingAward: PendingAward | null;
  /** Secret seed for the next hand and the client seeds collected so far. */
  nextServerSeed?: string;
  seeds?: Record<string, string>;
  lastHand: HandRecord | null;
  history: HandRecord[];
  handCounter: number;
  buttonSeat: number;
  endedAt: number | null;
  nextDelay: number;
  transfers: Transfer[];
  /** Host who asked for a seat shuffle that waits for the current hand to end. */
  seatShuffleBy?: string | null;
  locked?: boolean;
  tournament: { status: TourneyState["status"]; levelIndex: number; levelsCompleted: number; levelRemainingMs: number; clockRunning: boolean } | null;
  log: string[];
  /** Dealer ledger, oldest first. Append-only; never truncated. */
  dealerLog?: DealerEntry[];
}

interface HandCtx {
  state: HandState;
  deckHash: string;
  reveal: { deck: Card[]; salt: string };
  participants: Set<string>;
  actionDeadline: number | null;
  /** The player to act already used this turn's time extension. */
  extended: boolean;
  /** Stack of each participant when the hand began (for tournament ranking). */
  startStacks: Map<string, number>;
  /** What the host actually awarded, once done (host award mode). */
  awarded: WinnerView[] | null;
  /** Provably fair data; null when a test deckSource supplied the deck. Secret until the hand completes. */
  fair: HandFair | null;
}

const LOG_CAP = 20_000;
const VIEW_LOG = 200;
const VIEW_DEALER_LOG = 100;
const HISTORY_CAP = 2000;
const SNAPSHOT_VERSION = 1;
const FIRST_HAND_DELAY = 1000;
const SHOWDOWN_DELAY = 4000;
const FOLD_DELAY = 2500;
const MIN_DELAY = 1000;
const HOST_HANDOFF_MS = 60_000;

const CONFIG_KEYS = [
  "variant", "smallBlind", "bigBlind", "maxSeats", "actionTimeoutSec", "extensionSec", "minBuyIn", "maxBuyIn", "awardMode", "mode", "tournament",
  "stud", "houseLimit", "money",
] as const;

const STUD_KEYS = Object.keys(DEFAULT_STUD);
const HOUSE_KEYS = Object.keys(DEFAULT_HOUSE_LIMIT);
const CARD_RE = /^[2-9TJQKA][cdhs]$/;
const STAGE_LABEL: Partial<Record<string, string>> = {
  "2nd": "Betting: 2nd card", "3rd": "3rd card dealt", "4th": "4th card dealt", "5th": "5th card dealt (face down)",
  draw1: "Exchange round 1", draw2: "Exchange round 2", declare: "Declare: High, Low or Both",
};

/** Plain-object copy of a config with the nested objects detached from the source. */
function cloneConfig(c: TableConfig): TableConfig {
  return { ...c, stud: { ...c.stud }, houseLimit: { ...c.houseLimit }, tournament: JSON.parse(JSON.stringify(c.tournament)) as TournamentConfig };
}

/** Base overlaid with a (possibly partial) config; nested stud/houseLimit objects merge key by key. */
function mergeConfig(base: TableConfig, patch: Partial<TableConfig> | undefined): TableConfig {
  const out = cloneConfig(base);
  if (!patch) return out;
  const { stud, houseLimit, tournament, ...rest } = patch;
  Object.assign(out, rest);
  if (stud && typeof stud === "object") out.stud = { ...out.stud, ...stud };
  if (houseLimit && typeof houseLimit === "object") out.houseLimit = { ...out.houseLimit, ...houseLimit };
  if (tournament && typeof tournament === "object") out.tournament = JSON.parse(JSON.stringify(tournament)) as TournamentConfig;
  return out;
}

/** 125 -> "$1.25". */
export function formatCents(n: number): string {
  const neg = n < 0 ? "-" : "";
  const a = Math.abs(Math.round(n));
  return `${neg}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

const ordinal = (n: number): string => {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const CONFIG_LABELS: Record<string, string> = {
  variant: "game", smallBlind: "small blind", bigBlind: "big blind", maxSeats: "seats", actionTimeoutSec: "action timer (s)",
  extensionSec: "time extension (s)", minBuyIn: "minimum buy-in", maxBuyIn: "maximum buy-in", awardMode: "award mode", mode: "mode",
  money: "money format", tournament: "tournament", stud: "stud stakes", houseLimit: "house limit",
};
const MONEY_KEYS = new Set(["smallBlind", "bigBlind", "minBuyIn", "maxBuyIn", "stud.ante", "stud.minBet", "stud.maxBet", "stud.maxBetLastRound", "stud.downExchangeCost", "houseLimit.minBet", "houseLimit.maxBet"]);

/** Flattens two configs into [{path, from, to}] for every setting that differs (stud/houseLimit/tournament one level deep). */
function diffConfig(a: TableConfig, b: TableConfig): { path: string; from: unknown; to: unknown }[] {
  const out: { path: string; from: unknown; to: unknown }[] = [];
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of Object.keys(rb)) {
    const x = ra[k];
    const y = rb[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if ((k === "stud" || k === "houseLimit" || k === "tournament") && x && y && typeof x === "object" && typeof y === "object") {
      for (const kk of Object.keys(y as object)) {
        const xv = (x as Record<string, unknown>)[kk];
        const yv = (y as Record<string, unknown>)[kk];
        if (JSON.stringify(xv) !== JSON.stringify(yv)) out.push({ path: k + "." + kk, from: xv, to: yv });
      }
    } else out.push({ path: k, from: x, to: y });
  }
  return out;
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export class Table {
  readonly tableId: string;
  private readonly now: () => number;
  private readonly sched: Scheduler;
  private readonly deckSource: (() => Card[]) | undefined;
  /** Secret seed for the NEXT hand; its hash is published in TableView.fairness. */
  private nextServerSeed = randomBytes(32).toString("hex");
  /** Client seeds received for the next hand (playerId -> hex), cleared when the deck is built. */
  private seeds = new Map<string, string>();
  private readonly onChange: () => void;
  private readonly onHandRecorded: ((tableId: string, rec: HandRecord) => void) | undefined;

  private config: TableConfig;
  private pendingConfig: TableConfig | null = null;
  private status: "waiting" | "playing" | "paused" = "waiting";
  private hostId: string | null = null;
  private readonly players = new Map<string, Player>();
  private readonly byToken = new Map<string, string>();
  private hand: HandCtx | null = null;
  private lastHand: HandRecord | null = null;
  private history: HandRecord[] = [];
  private pendingClock = false;
  private handCounter = 0;
  private buttonSeat = -1;
  private log: string[] = [];
  private dealerLog: DealerEntry[] = [];
  private dealerHead = "";
  private startTimer: unknown = null;
  private actionTimer: unknown = null;
  private endedAt: number | null = null;
  private nextDelay = FIRST_HAND_DELAY;
  /** Epoch ms when the last connection dropped; null while anyone is connected. */
  idleSince: number | null;
  /** Epoch ms when the host lost its last connection; null while the host is connected. */
  private hostOfflineSince: number | null = null;
  private hostTimer: unknown = null;
  private pendingAward: PendingAward | null = null;
  /** Site budget guard: while set, no new hand starts (the current hand and any dealer award still finish). */
  private budgetNotice: string | null = null;
  private transfers: Transfer[] = [];
  private seatShuffleBy: string | null = null;
  private locked = false;
  private t: TourneyState | null = null;
  private levelTimer: unknown = null;

  constructor(opts: TableOptions) {
    this.tableId = opts.tableId;
    this.now = opts.now;
    this.sched = opts.scheduler;
    this.deckSource = opts.deckSource;
    this.onChange = opts.onChange;
    this.onHandRecorded = opts.onHandRecorded;
    this.config = mergeConfig(DEFAULT_CONFIG, opts.config);
    if (this.config.mode === "tournament") this.t = this.newTourney();
    this.idleSince = this.now();
    this.dealerHead = sha256Hex(ledgerGenesisInput(this.tableId));
    if (opts.snapshot) this.load(opts.snapshot);
  }

  // ------------------------------------------------------------------ persistence

  /** JSON-safe copy of the whole table. The result shares structure with live state: serialize it at once. */
  snapshot(): TableSnapshot {
    const h = this.hand;
    const t = this.t;
    return {
      version: SNAPSHOT_VERSION,
      tableId: this.tableId,
      savedAt: this.now(),
      config: this.config,
      pendingConfig: this.pendingConfig,
      status: this.status,
      hostId: this.hostId,
      players: [...this.players.values()].map(({ connections: _c, ...rest }) => rest),
      hand: h
        ? {
            state: h.state, deckHash: h.deckHash, reveal: h.reveal, participants: [...h.participants],
            startStacks: [...h.startStacks], awarded: h.awarded, extended: h.extended, fair: h.fair,
          }
        : null,
      pendingAward: this.pendingAward,
      nextServerSeed: this.nextServerSeed,
      seeds: Object.fromEntries(this.seeds),
      lastHand: this.lastHand,
      history: this.history,
      handCounter: this.handCounter,
      buttonSeat: this.buttonSeat,
      endedAt: this.endedAt,
      nextDelay: this.nextDelay,
      transfers: this.transfers,
      seatShuffleBy: this.seatShuffleBy,
      locked: this.locked,
      tournament: t
        ? {
            status: t.status, levelIndex: t.levelIndex, levelsCompleted: t.levelsCompleted,
            levelRemainingMs: t.levelEndsAt !== null ? Math.max(0, t.levelEndsAt - this.now()) : t.levelRemainingMs,
            clockRunning: t.levelEndsAt !== null,
          }
        : null,
      log: this.log,
      dealerLog: this.dealerLog,
    };
  }

  private load(s: TableSnapshot): void {
    this.config = mergeConfig(DEFAULT_CONFIG, s.config);
    this.pendingConfig = s.pendingConfig ? mergeConfig(DEFAULT_CONFIG, s.pendingConfig) : null;
    this.status = s.status;
    this.hostId = s.hostId;
    for (const sp of s.players) {
      const p: Player = { ...sp, connections: 0, busted: sp.busted ?? false };
      this.players.set(p.id, p);
      this.byToken.set(p.token, p.id);
    }
    this.hand = s.hand
      ? {
          state: s.hand.state, deckHash: s.hand.deckHash, reveal: s.hand.reveal, participants: new Set(s.hand.participants),
          actionDeadline: null, extended: s.hand.extended, startStacks: new Map(s.hand.startStacks), awarded: s.hand.awarded, fair: s.hand.fair ?? null,
        }
      : null;
    this.pendingAward = s.pendingAward;
    if (typeof s.nextServerSeed === "string" && /^[0-9a-f]{64}$/.test(s.nextServerSeed)) this.nextServerSeed = s.nextServerSeed;
    this.seeds = new Map(Object.entries(s.seeds ?? {}));
    this.lastHand = s.lastHand;
    this.history = s.history ?? [];
    this.handCounter = s.handCounter;
    this.buttonSeat = s.buttonSeat;
    this.endedAt = s.endedAt;
    this.nextDelay = s.nextDelay;
    this.transfers = s.transfers ?? [];
    this.seatShuffleBy = s.seatShuffleBy ?? null;
    this.locked = s.locked ?? false;
    this.log = s.log ?? [];
    this.dealerLog = s.dealerLog ?? [];
    if (this.dealerLog.length) this.dealerHead = this.dealerLog[this.dealerLog.length - 1]!.hash;
    this.t = s.tournament
      ? { status: s.tournament.status, levelIndex: s.tournament.levelIndex, levelsCompleted: s.tournament.levelsCompleted, levelEndsAt: null, levelRemainingMs: s.tournament.levelRemainingMs }
      : null;
    this.pendingClock = !!s.tournament?.clockRunning;
    // Everyone is offline until they reconnect.
    this.hostOfflineSince = this.hostId ? this.now() : null;
  }

  /** After a restore: restart the level clock, give whoever is to act a fresh full clock, and schedule the next hand. */
  resume(): void {
    if (this.t && this.pendingClock && this.t.status === "running") {
      this.t.levelEndsAt = this.now() + this.t.levelRemainingMs;
      this.armLevelTimer();
    }
    this.pendingClock = false;
    if (this.live()) this.settle();
    this.changed();
  }

  /** Returns the settings every new table should start with (the latest, including a change waiting for the next hand). */
  hostSaveDefaults(playerId: string): TableConfig {
    const saved = cloneConfig(this.pendingConfig ?? this.config);
    this.asHost(playerId, "saveDefaults", (host, rec) => {
      this.addLog("Saved these settings as the house defaults");
      rec(`${host.name} saved the table settings as the house defaults`, { settings: saved });
      this.changed();
    });
    return saved;
  }

  /**
   * A player's random seed for the shuffle of their next hand. Silently ignored unless it is for the upcoming
   * hand and well-formed; a later seed replaces an earlier one until the deck is built.
   */
  submitSeed(playerId: string, handNumber: unknown, clientSeed: unknown): void {
    if (this.deckSource || !this.players.has(playerId)) return;
    if (handNumber !== this.handCounter + 1) return;
    if (typeof clientSeed !== "string" || !CLIENT_SEED_RE.test(clientSeed)) return;
    this.seeds.set(playerId, clientSeed);
    this.onChange();
  }

  getHand(handNumber: unknown): HandRecord | null {
    if (!isInt(handNumber)) return null;
    return this.history.find((r) => r.handNumber === handNumber) ?? null;
  }

  getLog(): string[] {
    return [...this.log];
  }

  private handList(): HandListItem[] {
    const out: HandListItem[] = [];
    const label: Record<string, string> = { high: " (High)", low: " (Low)", whole: "" };
    for (let i = this.history.length - 1; i >= 0; i--) {
      const r = this.history[i]!;
      const groups = new Map<string, { id: string; half: string; amount: number }>();
      for (const w of r.winners) {
        const key = `${w.playerId}|${w.half}`;
        const g = groups.get(key) ?? { id: w.playerId, half: w.half, amount: 0 };
        g.amount += w.amount;
        groups.set(key, g);
      }
      const result = [...groups.values()]
        .map((g) => `${r.names[g.id] ?? this.players.get(g.id)?.name ?? "Someone"} ${this.m(g.amount)}${label[g.half] ?? ""}`)
        .join(", ");
      out.push({ handNumber: r.handNumber, variant: r.variant, endedAt: r.endedAt, pot: r.winners.reduce((n, w) => n + w.amount, 0), result });
    }
    return out;
  }

  // ------------------------------------------------------------------ identity

  /** Registers one connection for the token's player (creating the player if new) and returns the public playerId. */
  join(token: string, rawName: string, rawAvatar?: unknown): string {
    if (typeof token !== "string" || token.length < 1 || token.length > 200) throw new UserError("Invalid player token.");
    const name = this.cleanName(rawName);
    const avatar = rawAvatar === undefined ? undefined : this.cleanAvatar(rawAvatar);
    let p = this.byToken.has(token) ? this.players.get(this.byToken.get(token)!) : undefined;
    if (p) {
      p.name = this.uniqueName(name, p.id);
      if (avatar !== undefined) p.avatar = avatar;
    } else {
      if (this.locked) throw new UserError("This table is locked. Ask the host to unlock it or send you a new invite.");
      const id = randomBytes(8).toString("hex");
      p = {
        id, token, name: this.uniqueName(name, id), connections: 0, seat: null, stack: 0, sittingOut: false, blindDue: false, postBlind: false,
        timeouts: 0, buyIns: 0, cashOuts: 0, banned: false, standQueued: false, kickQueued: false, adjustQueued: 0, busted: false,
        avatar: avatar ?? null, timerSec: null, place: null,
      };
      this.players.set(id, p);
      this.byToken.set(token, id);
      if (!this.hostId) {
        this.hostId = id;
        this.appendDealer(p, "host", `${p.name} became the host`, { reason: "first player at the table", newHostId: id, newHostName: p.name });
      }
      this.addLog(`${p.name} joined the table`);
    }
    p.connections++;
    this.idleSince = null;
    if (p.id === this.hostId) {
      this.hostOfflineSince = null;
      this.clearHostTimer();
    } else {
      this.armHostHandoff();
    }
    this.changed();
    return p.id;
  }

  disconnect(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections = Math.max(0, p.connections - 1);
    if (![...this.players.values()].some((q) => q.connections > 0)) this.idleSince = this.now();
    if (playerId === this.hostId && p.connections === 0 && this.hostOfflineSince === null) {
      this.hostOfflineSince = this.now();
      this.armHostHandoff();
    }
    this.onChange();
  }

  hasConnections(): boolean {
    return this.idleSince === null;
  }

  playerIds(): string[] {
    return [...this.players.keys()];
  }

  dispose(): void {
    this.clearLevelTimer();
    this.clearStartTimer();
    this.clearActionTimer();
    this.clearHostTimer();
  }

  setAvatar(playerId: string, avatar: unknown): void {
    const p = this.get(playerId);
    p.avatar = this.cleanAvatar(avatar);
    this.changed();
  }

  private cleanAvatar(raw: unknown): string | null {
    if (raw === null) return null;
    if (typeof raw !== "string" || !isValidAvatar(raw)) throw new UserError("That avatar is not available.");
    return raw;
  }

  private cleanName(raw: unknown): string {
    const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (name.length < 1 || name.length > 20) throw new UserError("Name must be 1 to 20 characters.");
    return name;
  }

  private uniqueName(name: string, selfId: string): string {
    const taken = (n: string) => [...this.players.values()].some((q) => q.id !== selfId && q.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let i = 2; i < 100; i++) {
      const cand = name.slice(0, 20 - String(i).length) + i;
      if (!taken(cand)) return cand;
    }
    return name.slice(0, 16) + randomBytes(2).toString("hex");
  }

  private get(playerId: string): Player {
    const p = this.players.get(playerId);
    if (!p) throw new UserError("You have not joined this table.");
    return p;
  }

  /**
   * The ONLY caller of the host check. Every host-only action runs through here, so it cannot skip the dealer
   * ledger: the body calls rec(summary, details) at the point it changes something; if it forgets, a generic
   * entry is written anyway. A body that throws (rejected action) writes nothing.
   */
  private asHost(playerId: string, action: string, body: (host: Player, rec: Rec) => void): void {
    const p = this.get(playerId);
    if (this.hostId !== p.id) throw new UserError("Only the host can do that.");
    let recorded = false;
    body(p, (summary, details = {}) => {
      recorded = true;
      this.appendDealer(p, action, summary, details);
    });
    if (!recorded) this.appendDealer(p, action, `${p.name} used the dealer action “${action}”`, {});
  }

  /** Appends one hash-chained entry (see packages/engine/src/ledger.ts for the exact hashing). */
  private appendDealer(host: { id: string; name: string }, action: string, summary: string, details: Record<string, unknown>): void {
    const body = {
      seq: this.dealerLog.length + 1,
      at: this.now(),
      hostId: host.id,
      hostName: host.name,
      action,
      summary,
      details: JSON.parse(JSON.stringify(details)) as Record<string, unknown>,
      prevHash: this.dealerHead,
    };
    const entry: DealerEntry = { ...body, hash: sha256Hex(ledgerHashInput(body)) };
    this.dealerLog.push(entry);
    this.dealerHead = entry.hash;
  }

  /** The complete dealer ledger, oldest first (a copy). */
  getDealerLog(): DealerEntry[] {
    return this.dealerLog.map((e) => ({ ...e }));
  }

  // ------------------------------------------------------------------ seats

  sit(playerId: string, seat: number, buyIn: number): void {
    const p = this.get(playerId);
    if (p.banned) throw new UserError("The host removed you from this table.");
    if (p.seat !== null) throw new UserError("You are already seated.");
    if (!isInt(seat) || seat < 0 || seat >= this.config.maxSeats) throw new UserError("That seat does not exist.");
    if (this.seatOwner(seat)) throw new UserError("That seat is taken.");
    const tour = this.isTourney();
    if (tour) {
      const t = this.tourney();
      if (t.status === "running" && !this.lateRegOpen()) throw new UserError("Late registration is closed.");
      if (t.status === "finished") this.t = this.newTourney();
      buyIn = this.config.tournament.startingStack;
    } else if (!isInt(buyIn) || buyIn < this.config.minBuyIn || buyIn > this.config.maxBuyIn) {
      throw new UserError(`Buy-in must be from ${this.m(this.config.minBuyIn)} to ${this.m(this.config.maxBuyIn)}.`);
    }
    p.seat = seat;
    p.stack = buyIn;
    if (!tour) p.buyIns += buyIn;
    p.place = null;
    p.sittingOut = false;
    p.busted = false;
    p.timeouts = 0;
    p.blindDue = !tour && this.handCounter > 0;
    p.postBlind = false;
    this.clearQueued(p);
    this.addLog(`${p.name} sat in seat ${seat + 1} with ${this.m(buyIn)}`);
    this.changed();
  }

  stand(playerId: string): void {
    const p = this.get(playerId);
    if (p.seat === null) throw new UserError("You are not seated.");
    if (this.inLiveHand(p)) {
      p.standQueued = true;
      this.addLog(`${p.name} will leave after this hand`);
    } else {
      this.removeFromSeat(p, "stood up");
      this.eliminate();
    }
    this.changed();
  }

  sitOut(playerId: string, sittingOut: boolean): void {
    const p = this.get(playerId);
    if (p.seat === null) throw new UserError("You are not seated.");
    if (typeof sittingOut !== "boolean") throw new UserError("Invalid request.");
    if (!sittingOut) {
      if (p.stack <= 0) throw new UserError("Ask the dealer for more chips.");
      p.timeouts = 0;
    }
    p.busted = false;
    if (p.sittingOut !== sittingOut) this.addLog(`${p.name} is ${sittingOut ? "sitting out" : "back in"}`);
    p.sittingOut = sittingOut;
    if (sittingOut) p.postBlind = false;
    this.settleIfActor(p);
    this.changed();
  }

  choosePostBlind(playerId: string, post: boolean): void {
    const p = this.get(playerId);
    if (p.seat === null || !p.blindDue) throw new UserError("You don’t owe a blind.");
    if (post && (p.sittingOut || p.stack <= 0)) throw new UserError("Sit in with chips first.");
    if (p.postBlind !== post) this.addLog(post ? `${p.name} will post ${this.m(this.currentBlinds().bigBlind)} to play the next hand` : `${p.name} will wait for the big blind`);
    p.postBlind = post;
    this.changed();
  }

  private credit(p: Player, amount: number, verb: string): void {
    const wasEmpty = p.stack <= 0;
    p.stack += amount;
    if (!this.isTourney()) p.buyIns += amount;
    if (wasEmpty && p.busted) {
      p.sittingOut = false;
      p.busted = false;
      p.timeouts = 0;
    }
    this.addLog(`${p.name} ${verb} ${this.m(amount)} more${this.m(0) === "0" ? " chips" : ""}`);
  }

  private removeFromSeat(p: Player, why: string): void {
    if (this.isTourney() && this.t?.status === "running") {
      this.bustOut(p);
      return;
    }
    if (p.stack > 0 && !this.isTourney()) p.cashOuts += p.stack;
    this.addLog(`${p.name} ${why} with ${this.m(p.stack)}`);
    p.seat = null;
    p.stack = 0;
    p.sittingOut = false;
    p.busted = false;
    p.timeouts = 0;
    p.blindDue = false;
    p.postBlind = false;
    this.clearQueued(p);
  }

  private clearQueued(p: Player): void {
    p.standQueued = false;
    p.kickQueued = false;
    p.adjustQueued = 0;
  }

  private seatOwner(seat: number): Player | undefined {
    for (const p of this.players.values()) if (p.seat === seat) return p;
    return undefined;
  }

  private seated(): Player[] {
    return [...this.players.values()].filter((p) => p.seat !== null).sort((a, b) => a.seat! - b.seat!);
  }

  private eligible(): Player[] {
    const dealtAnyway = this.isTourney() && this.t?.status === "running"; // sitting-out players blind off
    return this.seated().filter((p) => p.stack > 0 && (dealtAnyway || !p.sittingOut));
  }

  // ------------------------------------------------------------------ host

  /** Schedules a host handoff for when the offline host reaches the 60-second mark. */
  private armHostHandoff(): void {
    if (this.hostOfflineSince === null || this.hostTimer !== null || !this.hostId) return;
    const host = this.players.get(this.hostId);
    if (!host || host.connections > 0) return;
    const remaining = this.hostOfflineSince + HOST_HANDOFF_MS - this.now();
    if (remaining <= 0) {
      this.handOffHost();
      return;
    }
    this.hostTimer = this.sched.setTimeout(() => {
      this.hostTimer = null;
      this.handOffHost();
      this.changed();
    }, remaining);
  }

  /** Moves host to a connected, seated player (lowest seat first). Spectators never inherit host; with nobody seated and online the table keeps its absent host. */
  private handOffHost(): void {
    if (!this.hostId) return;
    const host = this.players.get(this.hostId);
    if (!host || host.connections > 0) return;
    const candidates = [...this.players.values()].filter((p) => p.id !== host.id && p.connections > 0 && !p.banned);
    const next = candidates.filter((p) => p.seat !== null).sort((a, b) => a.seat! - b.seat!)[0];
    if (!next) return;
    this.hostId = next.id;
    this.hostOfflineSince = null;
    this.addLog(`${next.name} is now the host`);
    this.appendDealer(next, "handoff", `Host passed from ${host.name} to ${next.name} (${host.name} was offline for a minute)`, {
      reason: "host offline", fromId: host.id, fromName: host.name, toId: next.id, toName: next.name,
    });
  }

  private clearHostTimer(): void {
    if (this.hostTimer !== null) this.sched.clearTimeout(this.hostTimer);
    this.hostTimer = null;
  }

  /** Budget guard on/off. A notice holds the table (no new hands); null lifts it and play resumes as before. */
  setBudgetNotice(notice: string | null): void {
    if (notice === this.budgetNotice) return;
    this.budgetNotice = notice;
    if (notice !== null) this.clearStartTimer();
    this.changed();
  }

  hostStart(playerId: string): void {
    this.asHost(playerId, "start", (host, rec) => this.doStart(host, rec));
  }

  private doStart(host: Player, rec: Rec): void {
    if (this.budgetNotice !== null) throw new UserError(this.budgetNotice);
    if (this.status === "playing") throw new UserError("The game is already running.");
    if (this.isTourney() && this.tourney().status !== "running") {
      if (this.seated().length < 2) throw new UserError("At least 2 players must be seated to start a tournament.");
      this.status = "playing";
      rec(`${host.name} started the tournament with ${this.seated().length} players`, { mode: "tournament", players: this.seated().map((p) => p.name) });
      this.startTournament();
    } else {
      this.status = "playing";
      this.addLog("The host started the game");
      rec(`${host.name} started the game`, { mode: this.config.mode, players: this.seated().map((p) => p.name) });
    }
    this.syncClock();
    this.changed();
  }

  hostPause(playerId: string, paused: boolean): void {
    this.asHost(playerId, paused === false ? "resume" : "pause", (host, rec) => this.doPause(host, rec, paused));
  }

  private doPause(host: Player, rec: Rec, paused: boolean): void {
    if (typeof paused !== "boolean") throw new UserError("Invalid request.");
    if (paused) {
      if (this.status === "waiting") throw new UserError("The game has not started yet.");
      this.status = "paused";
      this.clearStartTimer();
      this.addLog("The host paused the game (the current hand will finish)");
      rec(`${host.name} paused the game (the current hand finishes first)`, { before: "playing", after: "paused" });
    } else {
      if (this.budgetNotice !== null) throw new UserError(this.budgetNotice);
      if (this.status !== "paused") throw new UserError("The game is not paused.");
      this.status = "playing";
      this.addLog("The host resumed the game");
      rec(`${host.name} resumed the game`, { before: "paused", after: "playing" });
    }
    this.syncClock();
    this.changed();
  }

  hostConfig(playerId: string, patch: Partial<TableConfig>): void {
    const p = patch as Partial<TableConfig> | null | undefined;
    const cur = this.pendingConfig ?? this.config;
    // The action id depends on what changes: switching the mode or the game gets its own id.
    const action = p && typeof p === "object" && "mode" in p && p.mode !== cur.mode ? "mode"
      : p && typeof p === "object" && "variant" in p && p.variant !== cur.variant ? "variant" : "settings";
    this.asHost(playerId, action, (host, rec) => this.doConfig(host, rec, patch));
  }

  private doConfig(host: Player, rec: Rec, patch: Partial<TableConfig>): void {
    if (!patch || typeof patch !== "object") throw new UserError("Invalid settings.");
    const base = this.pendingConfig ?? this.config;
    const next: TableConfig = { ...base };
    for (const key of Object.keys(patch)) {
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new UserError(`Unknown setting: ${key}`);
      const val = (patch as Record<string, unknown>)[key];
      const rec = next as unknown as Record<string, unknown>;
      if (key === "tournament" && val && typeof val === "object") rec[key] = JSON.parse(JSON.stringify(val));
      else if (key === "stud" || key === "houseLimit") {
        if (!val || typeof val !== "object" || Array.isArray(val)) throw new UserError(`Invalid ${key === "stud" ? "stud" : "house limit"} settings.`);
        const known = key === "stud" ? STUD_KEYS : HOUSE_KEYS;
        for (const k of Object.keys(val)) if (!known.includes(k)) throw new UserError(`Unknown setting: ${key}.${k}`);
        rec[key] = { ...(rec[key] as object), ...(val as object) };
      } else rec[key] = val;
    }
    // A one-step game switch sends only the variant: shrink the seat count to fit the new game.
    if (patch.variant !== undefined && patch.maxSeats === undefined && VARIANTS[next.variant]) {
      next.maxSeats = Math.min(next.maxSeats, VARIANTS[next.variant].maxPlayers, 10);
    }
    this.validateConfig(next);
    const tourneyChange = next.mode !== this.config.mode || JSON.stringify(next.tournament) !== JSON.stringify(this.config.tournament);
    if (tourneyChange && (this.handOpen() || this.t?.status === "running")) {
      throw new UserError("Tournament settings can only change when no tournament is running and no hand is in progress.");
    }
    const changes = diffConfig(base, next);
    const money = (path: string, v: unknown): string => {
      if (typeof v === "number" && MONEY_KEYS.has(path) && next.money === "cents" && next.mode === "cash") return formatCents(v);
      if (path === "variant" && typeof v === "string") return VARIANTS[v as keyof typeof VARIANTS]?.name ?? v;
      if (path === "tournament.levels" && Array.isArray(v)) return v.length + " levels";
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    };
    const label = (path: string): string => CONFIG_LABELS[path] ?? path.replace(/^(stud|houseLimit|tournament)\./, (_m, g: string) => (CONFIG_LABELS[g] ?? g) + " ");
    const what = changes.length === 0 ? "re-saved the same settings"
      : "changed " + changes.map((c) => label(c.path) + " from " + money(c.path, c.from) + " to " + money(c.path, c.to)).join("; ");
    const recChanges = (appliesNextHand: boolean): void => rec(host.name + " " + what + (appliesNextHand ? " (takes effect next hand)" : ""), { changes, appliesNextHand });
    if (!this.handOpen()) {
      if (next.mode !== this.config.mode) {
        // Keep the cash ledger honest across mode switches: cash chips are cashed out before a
        // tournament, and tournament chips are worthless afterwards (players rebuy for cash).
        for (const p of this.seated()) {
          if (next.mode === "tournament") p.cashOuts += p.stack;
          else {
            p.sittingOut = true;
            p.busted = true;
          }
          p.stack = 0;
        }
      }
      this.config = next;
      this.pendingConfig = null;
      this.syncMode();
      this.addLog("Table settings updated");
      recChanges(false);
    } else if (JSON.stringify(next) === JSON.stringify(this.config)) {
      this.pendingConfig = null;
      recChanges(false);
    } else {
      this.pendingConfig = next;
      this.addLog("Table settings will change next hand");
      recChanges(true);
    }
    this.changed();
  }

  private validateConfig(c: TableConfig): void {
    const v = VARIANTS[c.variant];
    if (!v) throw new UserError("Unknown game variant.");
    if (!isInt(c.smallBlind) || c.smallBlind <= 0 || !isInt(c.bigBlind) || c.bigBlind <= 0) throw new UserError("Blinds must be positive whole numbers.");
    if (c.bigBlind < c.smallBlind) throw new UserError("The big blind cannot be smaller than the small blind.");
    const maxCap = Math.min(10, v.maxPlayers);
    if (!isInt(c.maxSeats) || c.maxSeats < 2 || c.maxSeats > maxCap) throw new UserError(`Seats must be 2 to ${maxCap} for ${v.name}.`);
    const highest = this.seated().reduce((m, p) => Math.max(m, p.seat!), -1);
    if (c.maxSeats < highest + 1) throw new UserError(`Seat ${highest + 1} is occupied; have that player stand first.`);
    if (!isInt(c.actionTimeoutSec) || !(c.actionTimeoutSec === 0 || (c.actionTimeoutSec >= 5 && c.actionTimeoutSec <= 300))) {
      throw new UserError("The action timer must be 0 (off) or 5 to 300 seconds.");
    }
    if (!isInt(c.extensionSec) || c.extensionSec < 0 || c.extensionSec > 120) throw new UserError("The time extension must be 0 (off) to 120 seconds.");
    if (!isInt(c.minBuyIn) || c.minBuyIn <= 0 || !isInt(c.maxBuyIn) || c.maxBuyIn <= 0) throw new UserError("Buy-ins must be positive whole numbers.");
    if (c.minBuyIn > c.maxBuyIn) throw new UserError("The minimum buy-in cannot exceed the maximum.");
    if (c.awardMode !== "auto" && c.awardMode !== "host") throw new UserError("Unknown award mode.");
    if (c.mode !== "cash" && c.mode !== "tournament") throw new UserError("Unknown game mode.");
    if (c.money !== "cents" && c.money !== "chips") throw new UserError("Unknown money format.");
    this.validateStud(c.stud);
    this.validateHouse(c.houseLimit);
    this.validateTournament(c.tournament);
  }

  private validateStud(s: StudStakes): void {
    if (!s || typeof s !== "object") throw new UserError("Invalid stud settings.");
    const ints: [keyof StudStakes, number][] = [["ante", 0], ["minBet", 1], ["maxBet", 1], ["maxBetLastRound", 1], ["downExchangeCost", 0], ["maxRaises", 0]];
    for (const [k, min] of ints) {
      const v = s[k];
      if (!isInt(v) || v < min) throw new UserError(`Stud ${k} must be a whole number, ${min} or more.`);
    }
    if (s.maxBet < s.minBet) throw new UserError("The stud maximum bet cannot be below the minimum bet.");
    if (s.maxBetLastRound < s.minBet) throw new UserError("The stud last-round maximum cannot be below the minimum bet.");
    if (s.maxRaises > 10) throw new UserError("Stud raises per round must be 0 to 10.");
    if (typeof s.raiseMustExceed !== "boolean" || typeof s.declare !== "boolean") throw new UserError("Invalid stud settings.");
  }

  private validateHouse(h: HouseLimit): void {
    if (!h || typeof h !== "object") throw new UserError("Invalid house limit settings.");
    if (typeof h.enabled !== "boolean" || typeof h.raiseMustExceed !== "boolean") throw new UserError("Invalid house limit settings.");
    if (!isInt(h.minBet) || h.minBet < 1 || !isInt(h.maxBet) || h.maxBet < 1) throw new UserError("House limit bets must be positive whole numbers.");
    if (h.maxBet < h.minBet) throw new UserError("The house limit maximum cannot be below the minimum.");
    if (!isInt(h.maxRaises) || h.maxRaises < 0 || h.maxRaises > 10) throw new UserError("House limit raises per round must be 0 to 10.");
  }

  private validateTournament(tc: TournamentConfig): void {
    if (!tc || typeof tc !== "object" || !Array.isArray(tc.levels)) throw new UserError("Invalid tournament settings.");
    if (!isInt(tc.startingStack) || tc.startingStack < 100 || tc.startingStack > 10_000_000) {
      throw new UserError("The starting stack must be a whole number from 100 to 10,000,000.");
    }
    if (tc.levels.length < 1 || tc.levels.length > 40) throw new UserError("A tournament needs 1 to 40 blind levels.");
    for (const [i, l] of tc.levels.entries()) {
      if (!l || typeof l !== "object" || !isInt(l.smallBlind) || l.smallBlind < 1 || !isInt(l.bigBlind) || l.bigBlind < l.smallBlind) {
        throw new UserError(`Level ${i + 1}: blinds must be whole numbers, big blind at least the small blind.`);
      }
      if (!isInt(l.minutes) || l.minutes < 1 || l.minutes > 120) throw new UserError(`Level ${i + 1}: minutes must be 1 to 120.`);
    }
    if (!isInt(tc.lateRegLevels) || tc.lateRegLevels < 0 || tc.lateRegLevels > tc.levels.length) {
      throw new UserError("Late registration levels must be from 0 to the number of levels.");
    }
  }

  private applyPending(): void {
    if (!this.pendingConfig) return;
    const c = this.pendingConfig;
    const highest = this.seated().reduce((m, p) => Math.max(m, p.seat!), -1);
    if (c.maxSeats < highest + 1) c.maxSeats = highest + 1;
    this.config = c;
    this.pendingConfig = null;
    this.addLog("Table settings updated");
  }

  hostSitOut(playerId: string, targetId: string, sittingOut: boolean): void {
    this.asHost(playerId, "sitOut", (host, rec) => this.doSitOut(host, rec, targetId, sittingOut));
  }

  private doSitOut(host: Player, rec: Rec, targetId: string, sittingOut: boolean): void {
    const p = this.get(targetId);
    if (p.seat === null) throw new UserError(`${p.name} is not seated.`);
    if (typeof sittingOut !== "boolean") throw new UserError("Invalid request.");
    if (!sittingOut && p.stack <= 0) throw new UserError(`${p.name} needs chips before sitting back in.`);
    p.busted = false;
    rec(`${host.name} marked ${p.name} as ${sittingOut ? "sitting out" : "back in"}`, { playerId: p.id, playerName: p.name, before: p.sittingOut, after: sittingOut, stack: p.stack });
    if (p.sittingOut !== sittingOut) this.addLog(`The dealer marked ${p.name} as ${sittingOut ? "sitting out" : "back in"}`);
    if (!sittingOut) p.timeouts = 0;
    p.sittingOut = sittingOut;
    if (sittingOut) p.postBlind = false;
    this.settleIfActor(p);
    this.changed();
  }

  hostKick(playerId: string, targetId: string): void {
    this.asHost(playerId, "remove", (host, rec) => this.doKick(host, rec, playerId, targetId));
  }

  private doKick(host: Player, rec: Rec, playerId: string, targetId: string): void {
    const t = this.players.get(targetId);
    if (!t) throw new UserError("That player is not at this table.");
    if (t.id === playerId) throw new UserError("You cannot kick yourself.");
    const queued = t.seat !== null && this.inLiveHand(t);
    rec(`${host.name} removed ${t.name} from the table${t.seat !== null ? ` (stack ${this.m(t.stack)})` : ""}${queued ? ", effective after this hand" : ""}`, {
      playerId: t.id, playerName: t.name, seated: t.seat !== null, stack: t.stack, afterHand: queued,
    });
    t.banned = true;
    if (t.seat !== null) {
      if (this.inLiveHand(t)) {
        t.kickQueued = true;
        this.addLog(`${t.name} was removed by the host (after this hand)`);
        this.settleIfActor(t);
      } else {
        this.removeFromSeat(t, "was removed by the host");
        this.eliminate();
      }
    }
    this.changed();
  }

  hostAdjustStack(playerId: string, targetId: string, delta: number): void {
    this.asHost(playerId, isInt(delta) && delta < 0 ? "takeChips" : "rebuy", (host, rec) => this.doAdjust(host, rec, targetId, delta));
  }

  private doAdjust(host: Player, rec: Rec, targetId: string, delta: number): void {
    const t = this.players.get(targetId);
    if (!t || t.seat === null) throw new UserError("That player is not seated.");
    if (!isInt(delta) || delta === 0) throw new UserError("Enter a non-zero whole number.");
    const stackBefore = t.stack;
    const verb = delta > 0 ? "gave" : "took";
    const prep = delta > 0 ? "to" : "from";
    if (this.inLiveHand(t)) {
      if (t.stack + t.adjustQueued + delta < 0) throw new UserError("That would take the stack below zero.");
      rec(`${host.name} ${verb} ${this.m(Math.abs(delta))} ${prep} ${t.name}’s stack, applied after this hand`, {
        playerId: t.id, playerName: t.name, delta, stackBefore, queued: true, tournament: this.isTourney(),
      });
      t.adjustQueued += delta;
      this.addLog(`The host will adjust ${t.name}'s stack by ${delta > 0 ? "+" : ""}${this.m(delta)} after this hand`);
    } else {
      this.applyAdjust(t, delta);
      rec(`${host.name} ${verb} ${this.m(Math.abs(delta))} ${prep} ${t.name}’s stack (${this.m(stackBefore)} to ${this.m(t.stack)})`, {
        playerId: t.id, playerName: t.name, delta, stackBefore, stackAfter: t.stack, queued: false, tournament: this.isTourney(),
      });
      this.eliminate();
    }
    this.changed();
  }

  private applyAdjust(t: Player, delta: number): void {
    if (delta > 0) {
      this.credit(t, delta, "was given");
    } else {
      const take = Math.min(t.stack, -delta);
      t.stack -= take;
      if (!this.isTourney()) t.cashOuts += take;
      this.addLog(`The host removed ${this.m(take)}${this.m(0) === "0" ? " chips" : ""} from ${t.name}`);
      if (t.stack === 0 && !t.sittingOut) {
        t.sittingOut = true;
        t.busted = true;
      }
    }
  }

  // ------------------------------------------------------------------ hands

  action(playerId: string, act: PlayerAction): void {
    const p = this.get(playerId);
    const h = this.hand;
    if (!h || h.state.outcome) throw new UserError("No hand is in progress.");
    if (p.seat === null || h.state.toActSeat !== p.seat) throw new UserError("It is not your turn.");
    if (!act || typeof act !== "object") throw new UserError("Invalid action.");
    if (act.type === "raise" && !isInt(act.amount)) throw new UserError("Enter a whole number of chips.");
    if (act.type === "exchange" && act.card !== null && (typeof act.card !== "string" || !CARD_RE.test(act.card))) throw new UserError("Pick one of your cards.");
    if (act.type === "declare" && act.choice !== "high" && act.choice !== "low" && act.choice !== "both") throw new UserError("Declare high, low or both.");
    const before = h.state;
    const legal = legalActions(before, p.id);
    let after: HandState;
    try {
      after = applyAction(before, p.id, act);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "That action is not allowed.";
      // Engine messages carry raw chip counts ("raise to 221 exceeds the maximum of 220"); show them as money.
      throw new UserError(msg.replace(/\b(raise to|maximum of|minimum of|bet of|at least) (\d+)\b/g, (_m, w: string, n: string) => `${w} ${this.m(Number(n))}`));
    }
    const hadBet = before.players.some((q) => q.bet > 0 && q.playerId !== p.id) || (before.players.find((q) => q.playerId === p.id)?.bet ?? 0) > 0;
    let text: string;
    switch (act.type) {
      case "fold": text = "folds"; break;
      case "check": text = "checks"; break;
      case "call": text = legal ? `calls ${this.m(legal.callAmount)}` : "calls"; break;
      case "raise": text = `${hadBet ? "raises" : "bets"} to ${this.m(act.amount)}`; break;
      case "exchange": {
        const mine = before.players.find((q) => q.playerId === p.id);
        if (act.card === null) text = "keeps";
        else if (mine?.holeCards.includes(act.card)) text = `swaps a face-down card (−${this.m(before.stakes?.downExchangeCost ?? DEFAULT_STUD.downExchangeCost)})`;
        else text = `swaps up card ${act.card}`;
        break;
      }
      case "declare": text = "has declared"; break; // never reveal the choice before everyone has declared
      default: text = "acts";
    }
    if ((act.type === "call" || act.type === "raise") && after.players.find((q) => q.playerId === p.id)?.allIn) text += " (all in)";
    p.timeouts = 0;
    this.commit(after, `${p.name} ${text}`);
    this.settle();
    this.changed();
  }

  private live(): boolean {
    return !!this.hand && !this.hand.state.outcome;
  }

  /** A hand is running, or it has finished but its pot still waits for the host. */
  private handOpen(): boolean {
    return this.live() || this.pendingAward !== null;
  }

  private inLiveHand(p: Player): boolean {
    return this.handOpen() && !!this.hand && this.hand.participants.has(p.id);
  }

  private commit(after: HandState, line: string | null): void {
    const h = this.hand!;
    if (line) this.addLog(line);
    const prevLen = h.state.board.length;
    if (after.board.length > prevLen) {
      for (const [from, to, label] of [[0, 3, "Flop"], [3, 4, "Turn"], [4, 5, "River"]] as const) {
        if (prevLen <= from && after.board.length >= to) this.addLog(`${label}: ${after.board.slice(from, to).join(" ")}`);
      }
    }
    if (after.phase !== h.state.phase && VARIANTS[after.variant].kind === "stud") {
      const label = STAGE_LABEL[after.phase];
      if (label) this.addLog(label);
    }
    // Everyone has declared: now (and only now) the choices can be shown.
    if (after.declarationsRevealed && !h.state.declarationsRevealed) {
      const word = { high: "High", low: "Low", both: "Both" } as const;
      for (const hp of after.players) {
        if (hp.folded || !hp.declared) continue;
        this.addLog(`${this.players.get(hp.playerId)?.name ?? "Someone"} declares ${word[hp.declared]}`);
      }
    }
    h.state = after;
  }

  /** Verb for an automatic action (away or timeout) given the state before it. */
  private autoVerb(prev: HandState, next: HandState, playerId: string): string {
    if (prev.stage === "exchange") return "keeps";
    if (prev.stage === "declare") return "has declared";
    return next.players.find((q) => q.playerId === playerId)?.folded ? "folds" : "checks";
  }

  private settleIfActor(p: Player): void {
    const h = this.hand;
    if (h && !h.state.outcome && h.state.toActSeat !== null && h.state.toActSeat === p.seat) this.settle();
  }

  /** After any state transition: auto-act for absent players, finish the hand, or arm the action timer. */
  private settle(): void {
    const h = this.hand;
    if (!h) return;
    for (let guard = 0; guard < 200 && !h.state.outcome; guard++) {
      const seat = h.state.toActSeat;
      if (seat === null) break;
      const p = this.seatOwner(seat);
      if (!p || !(p.sittingOut || p.kickQueued)) break;
      let next: HandState;
      if (p.kickQueued && legalActions(h.state, p.id)?.canFold) next = applyAction(h.state, p.id, { type: "fold" });
      else next = timeoutAction(h.state);
      this.commit(next, `${p.name} ${this.autoVerb(h.state, next, p.id)} (away)`);
    }
    if (h.state.outcome) this.finishHand();
    else this.armActionTimer();
  }

  private armActionTimer(newTurn = true): void {
    this.clearActionTimer();
    const h = this.hand;
    if (!h) return;
    if (newTurn) h.extended = false;
    const actor = h.state.toActSeat === null ? undefined : this.seatOwner(h.state.toActSeat);
    const sec = actor?.timerSec ?? this.config.actionTimeoutSec;
    if (h.state.outcome || h.state.toActSeat === null || sec <= 0) {
      h.actionDeadline = null;
      return;
    }
    const ms = sec * 1000;
    h.actionDeadline = this.now() + ms;
    this.scheduleActionTimer(ms);
  }

  private scheduleActionTimer(ms: number): void {
    this.clearActionTimer();
    this.actionTimer = this.sched.setTimeout(() => {
      this.actionTimer = null;
      this.onActionTimeout(true);
    }, ms);
  }

  private canExtendNow(p: Player): boolean {
    const h = this.hand;
    return !!h && !h.state.outcome && h.state.toActSeat !== null && p.seat === h.state.toActSeat
      && h.actionDeadline !== null && !h.extended && this.config.extensionSec > 0;
  }

  /** The player to act adds extensionSec to their own clock, once per turn. */
  extendTime(playerId: string): void {
    const p = this.get(playerId);
    const h = this.hand;
    if (!h || h.state.outcome || h.state.toActSeat === null || p.seat !== h.state.toActSeat) throw new UserError("It is not your turn.");
    if (h.actionDeadline === null || this.config.extensionSec <= 0) throw new UserError("There is no time limit to extend.");
    if (h.extended) throw new UserError("You already used your extra time this turn.");
    h.extended = true;
    h.actionDeadline += this.config.extensionSec * 1000;
    this.scheduleActionTimer(Math.max(0, h.actionDeadline - this.now()));
    this.addLog(`${p.name} asks for ${this.config.extensionSec} more seconds`);
    this.changed();
  }

  private onActionTimeout(counted: boolean): void {
    const h = this.hand;
    if (!h || h.state.outcome || h.state.toActSeat === null) return;
    const p = this.seatOwner(h.state.toActSeat);
    if (!p) return;
    this.clearActionTimer();
    const next = timeoutAction(h.state);
    if (counted) p.timeouts++;
    this.commit(next, `${p.name} ${counted ? "timed out and" : "was timed out by the host and"} ${this.autoVerb(h.state, next, p.id)}`);
    if (counted && p.timeouts >= 2 && !p.sittingOut) {
      p.sittingOut = true;
      this.addLog(`${p.name} is sitting out after two timeouts`);
    }
    this.settle();
    this.changed();
  }

  private clearActionTimer(): void {
    if (this.actionTimer !== null) this.sched.clearTimeout(this.actionTimer);
    this.actionTimer = null;
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) this.sched.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private changed(): void {
    this.maybeSchedule();
    this.onChange();
  }

  private maybeSchedule(): void {
    if (this.budgetNotice !== null) return;
    if (this.status !== "playing" || this.handOpen() || this.startTimer !== null) return;
    if (this.isTourney() && this.t?.status !== "running") return;
    if (this.eligible().length < 2) return;
    const delay = this.endedAt === null ? FIRST_HAND_DELAY : Math.max(MIN_DELAY, this.nextDelay - (this.now() - this.endedAt));
    this.startTimer = this.sched.setTimeout(() => {
      this.startTimer = null;
      this.beginHand();
      this.changed();
    }, delay);
  }

  private beginHand(): void {
    if (this.budgetNotice !== null) return;
    if (this.status !== "playing" || this.handOpen()) return;
    if (this.isTourney() && this.t?.status !== "running") return;
    if (this.eligible().length < 2) return;
    this.applyPending();
    const { el, button, posts } = this.pickDealt(this.eligible());
    this.buttonSeat = button;
    const blinds = this.currentBlinds();
    const handNumber = this.handCounter + 1;
    // Provably fair deal: the server seed was committed (hash published) before any client seed arrived.
    const serverSeed = this.nextServerSeed;
    const clientSeeds: Record<string, string> = {};
    for (const p of el) {
      const cs = this.seeds.get(p.id);
      if (cs !== undefined) clientSeeds[p.id] = cs;
    }
    const material = buildMaterial(this.tableId, handNumber, clientSeeds);
    const deck = this.deckSource ? this.deckSource() : deriveDeck(serverSeed, material);
    const fair: HandFair | null = this.deckSource
      ? null
      : { algorithm: FAIR_ALGORITHM, serverSeed, serverSeedHash: seedHash(serverSeed), clientSeeds, material };
    this.nextServerSeed = randomBytes(32).toString("hex");
    this.seeds.clear();
    const { hash, reveal } = commitDeck(deck);
    this.handCounter++;
    const isStud = VARIANTS[this.config.variant].kind === "stud";
    // House limit never applies in tournaments; stud stakes always come from the table config.
    const extra: Record<string, unknown> = isStud
      ? { stakes: { ...this.config.stud } }
      : { limits: this.isTourney() ? undefined : { ...this.config.houseLimit } };
    const state = startHand({
      handNumber: this.handCounter,
      variant: this.config.variant,
      seats: el.map((p) => ({ seat: p.seat!, playerId: p.id, stack: p.stack })),
      buttonSeat: button,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      deck,
      ...(fair ? { fair: { key: serverSeed, material } } : {}),
      ...(posts.length ? { extraPosts: posts } : {}),
      ...extra,
    } as StartHandInput);
    this.hand = {
      state, deckHash: hash, reveal, participants: new Set(el.map((p) => p.id)), actionDeadline: null, extended: false,
      startStacks: new Map(el.map((p) => [p.id, p.stack])), awarded: null, fair,
    };
    const btn = this.seatOwner(button);
    this.addLog(`Hand #${this.handCounter} (${VARIANTS[this.config.variant].name}), button: ${btn?.name ?? "?"}`);
    if (fair) this.addLog(`Shuffle seeds: ${Object.keys(clientSeeds).length} of ${el.length} players`);
    if (isStud) this.addLog(`Antes: ${this.m(this.config.stud.ante)} each`);
    this.settle();
  }

  /**
   * Who gets dealt in. In cash board games a player with blindDue waits until the big blind reaches them, unless
   * they chose to post one. The button and small blind only land on players already in; the big blind goes to the
   * first waiting player after the small blind, if one comes before the next player who is in.
   */
  private pickDealt(candidates: Player[]): { el: Player[]; button: number; posts: string[] } {
    const next = (from: Player[]) => from.map((p) => p.seat!).find((s) => s > this.buttonSeat) ?? from[0]!.seat!;
    const cash = !this.isTourney() && VARIANTS[this.config.variant].kind !== "stud";
    const active = candidates.filter((p) => !p.blindDue || p.postBlind);
    if (!cash || active.length < 2) {
      // Nobody owes anything when there is no game for the blind to have passed.
      for (const p of candidates) { p.blindDue = false; p.postBlind = false; }
      return { el: candidates, button: next(candidates), posts: [] };
    }
    // Only players who owe nothing can hold the button; a player posting to come in is dealt in around it.
    const established = active.filter((p) => !p.blindDue);
    const button = next(established.length ? established : active);
    const b = active.findIndex((p) => p.seat === button);
    const sb = active[(b + 1) % active.length]!;
    const end = active[(b + 2) % active.length]!;
    const clockwise = (seat: number, from: number) => (seat - from + this.config.maxSeats) % this.config.maxSeats;
    const waiter = candidates
      .filter((p) => !active.includes(p) && clockwise(p.seat!, sb.seat!) < clockwise(end.seat!, sb.seat!))
      .sort((x, y) => clockwise(x.seat!, sb.seat!) - clockwise(y.seat!, sb.seat!))[0];
    const el = candidates.filter((p) => active.includes(p) || p === waiter);
    const posts = active.filter((p) => p.postBlind).map((p) => p.id);
    for (const p of el) { p.blindDue = false; p.postBlind = false; }
    // Anyone away between this hand's blinds has now missed the big blind.
    const i = el.findIndex((p) => p.seat === button);
    const realSb = el.length === 2 ? button : el[(i + 1) % el.length]!.seat!;
    const realBb = el[(i + (el.length === 2 ? 1 : 2)) % el.length]!.seat!;
    for (const p of this.seated()) {
      if (p.sittingOut && clockwise(p.seat!, realSb) < clockwise(realBb, realSb)) p.blindDue = true;
    }
    return { el, button, posts };
  }

  private finishHand(): void {
    const h = this.hand!;
    const o = h.state.outcome!;
    this.clearActionTimer();
    h.actionDeadline = null;
    const hostMode = this.config.awardMode === "host";
    const won = new Map<string, number>();
    for (const w of o.winners) won.set(w.playerId, (won.get(w.playerId) ?? 0) + w.amount);
    let withheld = 0;
    for (const id of h.participants) {
      const p = this.players.get(id);
      const fin = o.finalStacks[id];
      if (!p || fin === undefined) continue;
      const w = hostMode ? (won.get(id) ?? 0) : 0;
      p.stack = fin - w;
      withheld += w;
    }
    // Log winners, grouped per player and hand (automatic mode only; the host announces awards otherwise).
    if (!hostMode) {
      const groups = new Map<string, { id: string; amount: number; name: string | null; low: boolean }>();
      for (const w of o.winners) {
        const key = `${w.playerId}|${w.handName ?? ""}|${w.half}`;
        const g = groups.get(key) ?? { id: w.playerId, amount: 0, name: w.handName, low: w.half === "low" };
        g.amount += w.amount;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const nm = this.players.get(g.id)?.name ?? "Someone";
        this.addLog(`${nm} wins ${this.m(g.amount)}${g.name ? ` with ${g.name}${g.low ? " (low)" : ""}` : ""}`);
      }
    }
    const names: Record<string, string> = {};
    for (const id of h.participants) names[id] = this.players.get(id)?.name ?? "Someone";
    this.lastHand = {
      handNumber: h.state.handNumber,
      variant: h.state.variant,
      deckHash: h.deckHash,
      reveal: h.reveal,
      ...(h.fair ? { fair: h.fair } : {}),
      board: [...h.state.board],
      winners: o.winners,
      // The engine logs "<playerId> (seat N)" with 0-based seats; show names instead.
      summary: o.summary.map((line) =>
        this.moneyLine(line)
          .replace(/([0-9a-f]{8,}) \(seat \d+\)/g, (_m, id: string) => this.players.get(id)?.name ?? "Someone")
          .replace(/([0-9a-f]{8,})(?= wins)/g, (_m, id: string) => this.players.get(id)?.name ?? "Someone")
          .replace(/button: seat (\d+)/, (_m, seat: string) => {
            const p = h.state.players.find((x) => x.seat === Number(seat));
            return `button: ${(p && this.players.get(p.playerId)?.name) ?? `seat ${Number(seat) + 1}`}`;
          }),
      ),
      shown: o.shown,
      names,
      endedAt: this.now(),
      // Lets the luck report rebuild the deal exactly (board games only).
      ...(VARIANTS[h.state.variant].kind === "stud" ? {} : {
        luck: { v: 1 as const, dealOrder: orderFromButton(h.state).map((p) => p.playerId), foldStreet: { ...(h.state.foldedOn ?? {}) }, ...(h.state.runout ? { runout: h.state.runout } : {}) },
      }),
    };
    this.history.push(this.lastHand);
    try { this.onHandRecorded?.(this.tableId, this.lastHand); } catch (e) { console.error("onHandRecorded failed", e); }
    if (this.history.length > HISTORY_CAP) this.history.splice(0, this.history.length - HISTORY_CAP);
    const foldEnd = o.winners.length > 0 && o.winners.every((w) => w.handName === null);
    this.nextDelay = foldEnd ? FOLD_DELAY : SHOWDOWN_DELAY;
    this.endedAt = this.now();

    if (hostMode && withheld > 0) {
      this.pendingAward = {
        handNumber: h.state.handNumber,
        amount: withheld,
        candidatePlayerIds: [...h.participants],
        suggested: [...won].filter(([, amt]) => amt > 0).map(([playerId, amount]) => ({ playerId, amount })),
      };
      this.addLog(`Hand #${h.state.handNumber}: ${this.m(withheld)} is waiting for the dealer to award`);
      return;
    }
    this.completeHand();
  }

  /** Everything that follows a hand once its chips are settled (after any dealer award). */
  private completeHand(): void {
    const h = this.hand!;
    this.endedAt = this.now();
    this.applyTransfers();
    // Players who stay: queued rebuys and adjustments.
    for (const p of this.seated()) {
      if (p.kickQueued || p.standQueued) continue;
      if (p.adjustQueued !== 0) {
        const d = p.adjustQueued;
        p.adjustQueued = 0;
        this.applyAdjust(p, d);
      }
      if (p.stack <= 0 && !this.isTourney()) {
        if (!p.sittingOut) p.busted = true;
        p.sittingOut = true;
        this.addLog(`${p.name} is out of chips`);
      }
    }
    // Busts are ranked before voluntary leavers are removed.
    this.eliminate(h.startStacks);
    for (const p of this.seated()) {
      if (p.kickQueued || p.standQueued) this.removeFromSeat(p, p.kickQueued ? "was removed" : "cashed out");
    }
    this.eliminate(h.startStacks);
    this.applyPending();
    this.applySeatShuffle();
  }

  hostShuffleSeats(playerId: string): void {
    this.asHost(playerId, "shuffleSeats", (host, rec) => this.doShuffleSeats(host, rec));
  }

  private doShuffleSeats(host: Player, rec: Rec): void {
    if (this.seated().length < 2) throw new UserError("Seat at least two players first.");
    if (this.handOpen()) {
      if (this.seatShuffleBy !== null) throw new UserError("The seats are already set to shuffle after this hand.");
      this.seatShuffleBy = host.id;
      rec(`${host.name} asked to shuffle the seats after this hand`, { queued: true });
      this.addLog("Dealer will shuffle the seats after this hand");
    } else {
      const seats = this.shuffleSeats();
      rec(`${host.name} shuffled the seats: ${this.seatList(seats)}`, { queued: false, seats });
      this.addLog(`Dealer shuffled the seats: ${this.seatList(seats)}`);
    }
    this.changed();
  }

  private applySeatShuffle(): void {
    const by = this.seatShuffleBy;
    if (by === null) return;
    this.seatShuffleBy = null;
    if (this.seated().length < 2) return;
    const seats = this.shuffleSeats();
    const who = this.players.get(by) ?? this.players.get(this.hostId ?? "");
    if (who) this.appendDealer(who, "seatShuffleApplied", `The queued seat shuffle was applied: ${this.seatList(seats)}`, { queued: true, seats });
    this.addLog(`Dealer shuffled the seats: ${this.seatList(seats)}`);
  }

  /** Uniform random reseating among the occupied seats, redrawn if nobody would move. The button stays with its seat. */
  private shuffleSeats(): { playerId: string; name: string; from: number; to: number }[] {
    const players = this.seated();
    const open = players.map((p) => p.seat!);
    const to = open.slice();
    do {
      for (let i = to.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [to[i], to[j]] = [to[j]!, to[i]!];
      }
    } while (to.every((s, i) => s === open[i]));
    return players.map((p, i) => {
      p.seat = to[i]!;
      return { playerId: p.id, name: p.name, from: open[i]!, to: to[i]! };
    });
  }

  private seatList(seats: { name: string; to: number }[]): string {
    return seats.slice().sort((a, b) => a.to - b.to).map((s) => `seat ${s.to + 1} ${s.name}`).join(", ");
  }

  private applyTransfers(): void {
    const queued = this.transfers;
    this.transfers = [];
    for (const tr of queued) {
      const from = this.players.get(tr.fromId);
      const to = this.players.get(tr.toId);
      if (!from || !to) continue;
      if (from.seat === null || to.seat === null || from.stack < tr.amount) {
        this.addLog(`Dealer's move of ${this.m(tr.amount)} from ${from.name} to ${to.name} was skipped (not enough chips)`);
        this.appendDealer(this.players.get(tr.by ?? "") ?? this.players.get(this.hostId ?? "") ?? from, "transferSkipped",
          `The queued move of ${this.m(tr.amount)} from ${from.name} to ${to.name} was skipped (not enough chips)`,
          { fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, amount: tr.amount, fromStack: from.stack });
        continue;
      }
      const fromBefore = from.stack;
      const toBefore = to.stack;
      this.moveChips(from, to, tr.amount);
      this.appendDealer(this.players.get(tr.by ?? "") ?? this.players.get(this.hostId ?? "") ?? from, "transferApplied",
        `The queued move of ${this.m(tr.amount)} from ${from.name} to ${to.name} was applied`,
        { fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, amount: tr.amount, fromBefore, fromAfter: from.stack, toBefore, toAfter: to.stack });
    }
  }

  private moveChips(from: Player, to: Player, amount: number): void {
    const wasEmpty = to.stack <= 0;
    from.stack -= amount;
    to.stack += amount;
    this.addLog(`Dealer moves ${this.m(amount)} from ${from.name} to ${to.name}`);
    if (!this.isTourney()) {
      if (wasEmpty && to.busted) {
        to.sittingOut = false;
        to.busted = false;
        to.timeouts = 0;
      }
      if (from.stack === 0 && !from.sittingOut) {
        from.sittingOut = true;
        from.busted = true;
      }
    }
  }

  hostAward(playerId: string, awards: unknown, reason?: unknown): void {
    this.asHost(playerId, "award", (host, rec) => this.doAward(host, rec, awards, reason));
  }

  /** Host locks the table so only players who already sat here can reconnect. */
  hostSetLocked(playerId: string, locked: unknown): void {
    if (typeof locked !== "boolean") throw new UserError("Invalid request.");
    this.asHost(playerId, "lock", (host, rec) => {
      this.locked = locked;
      this.addLog(locked ? "The host locked the table" : "The host unlocked the table");
      rec(`${host.name} ${locked ? "locked" : "unlocked"} the table`, { locked });
      this.changed();
    });
  }

  private doAward(host: Player, rec: Rec, awards: unknown, rawReason?: unknown): void {
    const pa = this.pendingAward;
    if (!pa) throw new UserError("There is no pot waiting to be awarded.");
    if (!Array.isArray(awards)) throw new UserError("Invalid request.");
    const totals = new Map<string, number>();
    for (const a of awards as unknown[]) {
      if (!a || typeof a !== "object") throw new UserError("Invalid request.");
      const { playerId: id, amount } = a as { playerId?: unknown; amount?: unknown };
      if (typeof id !== "string" || !pa.candidatePlayerIds.includes(id)) throw new UserError("Chips can only go to players dealt into this hand.");
      if (!isInt(amount) || amount < 0) throw new UserError("Award amounts must be whole numbers, zero or more.");
      totals.set(id, (totals.get(id) ?? 0) + amount);
    }
    const sum = [...totals.values()].reduce((x, y) => x + y, 0);
    if (sum !== pa.amount) throw new UserError(`Awards must add up to exactly ${this.m(pa.amount)} (you entered ${this.m(sum)}).`);
    const matches = pa.suggested.length === [...totals].filter(([, a]) => a > 0).length && pa.suggested.every((x) => totals.get(x.playerId) === x.amount);
    const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 200) : "";
    if (!matches && reason.length < 3) throw new UserError("This differs from the suggested payout. Write a short reason (a few words) so everyone can see why.");
    const h = this.hand!;
    const byHand = new Map<string, string>();
    for (const w of h.state.outcome!.winners) if (w.handName && !byHand.has(w.playerId)) byHand.set(w.playerId, w.handName);
    const winners: WinnerView[] = [];
    const parts: string[] = [];
    for (const [id, amount] of totals) {
      if (amount <= 0) continue;
      const p = this.players.get(id)!;
      p.stack += amount;
      winners.push({ playerId: id, amount, potIndex: 0, half: "whole", handName: byHand.get(id) ?? null });
      parts.push(`${this.m(amount)} to ${p.name}`);
    }
    this.addLog(`Dealer awards ${parts.join(", ")}`);
    rec(`${host.name} awarded hand #${pa.handNumber}’s pot of ${this.m(pa.amount)}: ${parts.join(", ")}`, {
      handNumber: pa.handNumber,
      pot: pa.amount,
      awards: winners.map((w) => ({ playerId: w.playerId, name: this.players.get(w.playerId)?.name ?? "?", amount: w.amount })),
      suggested: pa.suggested.map((x) => ({ playerId: x.playerId, name: this.players.get(x.playerId)?.name ?? "?", amount: x.amount })),
      matchedSuggestion: matches,
      ...(matches ? {} : { reason }),
    });
    h.awarded = winners;
    if (this.lastHand) {
      this.lastHand = { ...this.lastHand, winners };
      this.history[this.history.length - 1] = this.lastHand;
    }
    this.pendingAward = null;
    this.nextDelay = MIN_DELAY; // the dealer already paused the game; do not wait again
    this.completeHand();
    this.changed();
  }

  hostTransfer(playerId: string, fromId: unknown, toId: unknown, amount: unknown): void {
    this.asHost(playerId, "transfer", (host, rec) => this.doTransfer(host, rec, fromId, toId, amount));
  }

  private doTransfer(host: Player, rec: Rec, fromId: unknown, toId: unknown, amount: unknown): void {
    const from = typeof fromId === "string" ? this.players.get(fromId) : undefined;
    const to = typeof toId === "string" ? this.players.get(toId) : undefined;
    if (!from || !to || from.seat === null || to.seat === null) throw new UserError("Both players must be seated.");
    if (from.id === to.id) throw new UserError("Pick two different players.");
    if (!isInt(amount) || amount <= 0) throw new UserError("Enter a positive whole number of chips.");
    if (this.handOpen()) {
      rec(`${host.name} moved ${this.m(amount)} from ${from.name} to ${to.name}, applied after this hand`, {
        fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, amount, queued: true, fromStack: from.stack, toStack: to.stack,
      });
      this.transfers.push({ fromId: from.id, toId: to.id, amount, by: host.id });
      this.addLog(`Dealer will move ${this.m(amount)} from ${from.name} to ${to.name} after this hand`);
    } else {
      if (from.stack < amount) throw new UserError(`${from.name} only has ${this.m(from.stack)}.`);
      const fromBefore = from.stack;
      const toBefore = to.stack;
      this.moveChips(from, to, amount);
      rec(`${host.name} moved ${this.m(amount)} from ${from.name} (${this.m(fromBefore)} to ${this.m(from.stack)}) to ${to.name} (${this.m(toBefore)} to ${this.m(to.stack)})`, {
        fromId: from.id, fromName: from.name, toId: to.id, toName: to.name, amount, queued: false,
        fromBefore, fromAfter: from.stack, toBefore, toAfter: to.stack,
      });
      this.eliminate();
    }
    this.changed();
  }

  // ------------------------------------------------------------------ timers (host)

  hostPlayerTimer(playerId: string, targetId: unknown, seconds: unknown): void {
    this.asHost(playerId, "playerTimer", (host, rec) => this.doPlayerTimer(host, rec, targetId, seconds));
  }

  private doPlayerTimer(host: Player, rec: Rec, targetId: unknown, seconds: unknown): void {
    const t = typeof targetId === "string" ? this.players.get(targetId) : undefined;
    if (!t) throw new UserError("That player is not at this table.");
    if (seconds !== null && !(isInt(seconds) && (seconds === 0 || (seconds >= 10 && seconds <= 300)))) {
      throw new UserError("A player timer must be off (0), the table default, or 10 to 300 seconds.");
    }
    const desc = (v: number | null): string => (v === null ? "the table default" : v === 0 ? "no limit" : v + "s");
    rec(`${host.name} set ${t.name}’s timer from ${desc(t.timerSec)} to ${desc(seconds as number | null)}`, { playerId: t.id, playerName: t.name, before: t.timerSec, after: seconds });
    t.timerSec = seconds as number | null;
    this.addLog(`Dealer set ${t.name}'s timer to ${seconds === null ? "the table default" : seconds === 0 ? "no limit" : `${seconds}s`}`);
    const h = this.hand;
    if (h && !h.state.outcome && h.state.toActSeat !== null && h.state.toActSeat === t.seat) this.armActionTimer(false);
    this.changed();
  }

  private onClock(targetId: unknown): Player {
    const t = typeof targetId === "string" ? this.players.get(targetId) : undefined;
    const h = this.hand;
    if (!t || !h || h.state.outcome || h.state.toActSeat === null || t.seat !== h.state.toActSeat) {
      throw new UserError("That player is not on the clock.");
    }
    return t;
  }

  hostAddTime(playerId: string, targetId: unknown, seconds: unknown): void {
    this.asHost(playerId, "addTime", (host, rec) => this.doAddTime(host, rec, targetId, seconds));
  }

  private doAddTime(host: Player, rec: Rec, targetId: unknown, seconds: unknown): void {
    if (!isInt(seconds) || seconds < 10 || seconds > 300) throw new UserError("Add 10 to 300 seconds.");
    const t = this.onClock(targetId);
    const h = this.hand!;
    if (h.actionDeadline === null) throw new UserError(`${t.name} has no time limit right now.`);
    h.actionDeadline += seconds * 1000;
    this.scheduleActionTimer(Math.max(0, h.actionDeadline - this.now()));
    this.addLog(`Dealer gave ${t.name} ${seconds} more seconds`);
    rec(`${host.name} gave ${t.name} ${seconds} more seconds on the clock`, { playerId: t.id, playerName: t.name, seconds });
    this.changed();
  }

  hostForceTimeout(playerId: string, targetId: unknown): void {
    this.asHost(playerId, "forceTimeout", (host, rec) => {
      const t = this.onClock(targetId);
      rec(`${host.name} timed out ${t.name} immediately`, { playerId: t.id, playerName: t.name });
      this.onActionTimeout(false);
      this.changed();
    });
  }

  // ------------------------------------------------------------------ tournament

  private isTourney(): boolean {
    return this.config.mode === "tournament";
  }

  private newTourney(): TourneyState {
    return { status: "registering", levelIndex: 0, levelsCompleted: 0, levelEndsAt: null, levelRemainingMs: this.config.tournament.levels[0]!.minutes * 60_000 };
  }

  private tourney(): TourneyState {
    return (this.t ??= this.newTourney());
  }

  private levelAt(i: number): { smallBlind: number; bigBlind: number; minutes: number } {
    const lv = this.config.tournament.levels;
    return lv[Math.max(0, Math.min(i, lv.length - 1))]!;
  }

  private lateRegOpen(): boolean {
    const t = this.t;
    if (!t || t.status === "finished") return false;
    if (t.status === "registering") return true;
    return t.levelsCompleted < this.config.tournament.lateRegLevels;
  }

  private currentBlinds(): { smallBlind: number; bigBlind: number } {
    if (this.isTourney() && this.t?.status === "running") return this.levelAt(this.t.levelIndex);
    return { smallBlind: this.config.smallBlind, bigBlind: this.config.bigBlind };
  }

  /** Called after mode/tournament settings were applied. */
  private syncMode(): void {
    if (this.isTourney()) {
      const t = this.tourney();
      if (t.status === "registering") t.levelRemainingMs = this.levelAt(0).minutes * 60_000;
      if (t.status !== "running") {
        this.status = "waiting";
        this.clearStartTimer();
      }
    } else {
      this.t = null;
      this.clearLevelTimer();
      for (const p of this.players.values()) p.place = null;
    }
  }

  private startTournament(): void {
    const tc = this.config.tournament;
    for (const p of this.players.values()) {
      p.place = null;
      if (p.seat === null) continue;
      p.stack = tc.startingStack;
      p.sittingOut = false;
      p.timeouts = 0;
      this.clearQueued(p);
    }
    this.transfers = [];
    this.clearLevelTimer();
    this.t = { status: "running", levelIndex: 0, levelsCompleted: 0, levelEndsAt: null, levelRemainingMs: this.levelAt(0).minutes * 60_000 };
    const l = this.levelAt(0);
    this.addLog(`The tournament started: ${this.seated().length} players, ${tc.startingStack} chips each`);
    this.addLog(`Level 1: ${l.smallBlind}/${l.bigBlind}`);
  }

  /** Runs the level clock only while the table is playing; freezes it otherwise. */
  private syncClock(): void {
    const t = this.t;
    if (!t || t.status !== "running") return;
    if (this.status === "playing") {
      if (t.levelEndsAt === null) {
        t.levelEndsAt = this.now() + t.levelRemainingMs;
        this.armLevelTimer();
      }
    } else if (t.levelEndsAt !== null) {
      t.levelRemainingMs = Math.max(0, t.levelEndsAt - this.now());
      t.levelEndsAt = null;
      this.clearLevelTimer();
    }
  }

  private armLevelTimer(): void {
    this.clearLevelTimer();
    const t = this.t;
    if (!t || t.levelEndsAt === null) return;
    this.levelTimer = this.sched.setTimeout(() => {
      this.levelTimer = null;
      this.onLevelEnd();
    }, Math.max(0, t.levelEndsAt - this.now()));
  }

  private clearLevelTimer(): void {
    if (this.levelTimer !== null) this.sched.clearTimeout(this.levelTimer);
    this.levelTimer = null;
  }

  private onLevelEnd(): void {
    const t = this.t;
    if (!t || t.status !== "running" || t.levelEndsAt === null) return;
    const last = this.config.tournament.levels.length - 1;
    const idx = Math.min(t.levelIndex + 1, last);
    t.levelsCompleted++;
    if (idx !== t.levelIndex) {
      t.levelIndex = idx;
      const l = this.levelAt(idx);
      this.addLog(`Level ${idx + 1}: ${l.smallBlind}/${l.bigBlind}`);
    }
    t.levelRemainingMs = this.levelAt(idx).minutes * 60_000;
    t.levelEndsAt = this.now() + t.levelRemainingMs;
    this.armLevelTimer();
    this.changed();
  }

  private runningTourney(): TourneyState {
    const t = this.t;
    if (!t || t.status !== "running") throw new UserError("The tournament is not running.");
    return t;
  }

  hostTournamentLevel(playerId: string, delta: unknown): void {
    this.asHost(playerId, "tournamentLevel", (host, rec) => this.doTournamentLevel(host, rec, delta));
  }

  private doTournamentLevel(host: Player, rec: Rec, delta: unknown): void {
    const t = this.runningTourney();
    if (delta !== 1 && delta !== -1) throw new UserError("Invalid request.");
    const idx = Math.max(0, Math.min(t.levelIndex + delta, this.config.tournament.levels.length - 1));
    if (idx === t.levelIndex) throw new UserError(delta > 0 ? "Already at the last level." : "Already at the first level.");
    const fromLevel = t.levelIndex;
    t.levelIndex = idx;
    t.levelsCompleted = Math.max(0, t.levelsCompleted + delta);
    t.levelRemainingMs = this.levelAt(idx).minutes * 60_000;
    if (t.levelEndsAt !== null) {
      t.levelEndsAt = this.now() + t.levelRemainingMs;
      this.armLevelTimer();
    }
    const l = this.levelAt(idx);
    rec(`${host.name} moved the blinds from level ${fromLevel + 1} to level ${idx + 1} (${l.smallBlind}/${l.bigBlind}, applies next hand)`, {
      fromLevel: fromLevel + 1, toLevel: idx + 1, smallBlind: l.smallBlind, bigBlind: l.bigBlind,
    });
    this.addLog(`The host moved to level ${idx + 1}: ${l.smallBlind}/${l.bigBlind} (applies next hand)`);
    this.changed();
  }

  hostTournamentClock(playerId: string, addMs: unknown): void {
    this.asHost(playerId, "tournamentClock", (host, rec) => this.doTournamentClock(host, rec, addMs));
  }

  private doTournamentClock(host: Player, rec: Rec, addMs: unknown): void {
    const t = this.runningTourney();
    if (!isInt(addMs) || Math.abs(addMs) > 86_400_000) throw new UserError("Invalid time change.");
    const cur = t.levelEndsAt !== null ? t.levelEndsAt - this.now() : t.levelRemainingMs;
    const rem = Math.max(1000, cur + addMs);
    rec(`${host.name} ${addMs >= 0 ? "added" : "removed"} ${Math.round(Math.abs(addMs) / 1000)}s ${addMs >= 0 ? "to" : "from"} the level clock`, {
      addMs, remainingBeforeMs: Math.max(0, cur), remainingAfterMs: rem,
    });
    if (t.levelEndsAt !== null) {
      t.levelEndsAt = this.now() + rem;
      this.armLevelTimer();
    } else {
      t.levelRemainingMs = rem;
    }
    this.addLog(`The host ${addMs >= 0 ? "added" : "removed"} ${Math.round(Math.abs(addMs) / 1000)}s ${addMs >= 0 ? "to" : "from"} the level clock`);
    this.changed();
  }

  /** Frees the seat of a tournament player who is out and records the finishing place. */
  private bustOut(p: Player): void {
    const place = this.seated().length;
    p.place = place;
    this.addLog(`${p.name} finishes ${ordinal(place)}`);
    p.seat = null;
    p.stack = 0;
    p.sittingOut = false;
    p.timeouts = 0;
    this.clearQueued(p);
  }

  /** Eliminates players at zero (best start-of-hand stack = better place) and ends the tournament at one survivor. */
  private eliminate(startStacks?: Map<string, number>): void {
    const t = this.t;
    if (!this.isTourney() || !t || t.status !== "running" || this.handOpen()) return;
    const busts = this.seated().filter((p) => p.stack <= 0);
    // Smallest starting stack finishes last (worst place), so assign places from the bottom up.
    busts.sort((a, b) => (startStacks?.get(a.id) ?? 0) - (startStacks?.get(b.id) ?? 0) || b.seat! - a.seat!);
    for (const p of busts) this.bustOut(p);
    const alive = this.seated();
    if (alive.length <= 1) {
      const w = alive[0];
      if (w) {
        w.place = 1;
        this.addLog(`${w.name} wins the tournament!`);
      }
      t.status = "finished";
      t.levelEndsAt = null;
      this.clearLevelTimer();
      this.clearStartTimer();
      this.status = "waiting";
    }
  }

  private tournamentView(): TournamentView | null {
    if (!this.isTourney()) return null;
    const t = this.tourney();
    const tc = this.config.tournament;
    const idx = Math.min(t.levelIndex, tc.levels.length - 1);
    const standings: TournamentStanding[] = [...this.players.values()]
      .filter((p) => p.seat !== null || p.place !== null)
      .map((p) => ({ playerId: p.id, name: p.name, stack: p.seat !== null ? p.stack : 0, place: p.place }));
    standings.sort((a, b) => {
      if ((a.place === null) !== (b.place === null)) return a.place === null ? -1 : 1;
      if (a.place === null) return b.stack - a.stack;
      return a.place! - b.place!;
    });
    return {
      status: t.status,
      levelIndex: idx,
      level: { ...tc.levels[idx]! },
      nextLevel: tc.levels[idx + 1] ? { ...tc.levels[idx + 1]! } : null,
      levelEndsAt: t.levelEndsAt,
      levelRemainingMs: t.levelEndsAt !== null ? Math.max(0, t.levelEndsAt - this.now()) : t.levelRemainingMs,
      startingStack: tc.startingStack,
      lateRegOpen: this.lateRegOpen(),
      playersLeft: this.seated().length,
      standings,
    };
  }

  // ------------------------------------------------------------------ views

  /** Chip amount for log lines and messages: dollars when the table plays in cents (never in tournaments). */
  private m(n: number): string {
    return this.config.money === "cents" && !this.isTourney() ? formatCents(n) : String(n);
  }

  /** Converts the raw numbers in an engine-produced summary line to dollars (best effort). */
  private moneyLine(line: string): string {
    if (this.config.money !== "cents" || this.isTourney()) return line;
    return line
      .replace(/\b(posts small blind|posts big blind|posts|antes|bets|raises to|calls|wins|pays|returned|All-in|Ante) (\d+)\b/g, (_m, w: string, n: string) => `${w} ${formatCents(Number(n))}`)
      .replace(/Uncalled bet of (\d+)/g, (_m, n: string) => `Uncalled bet of ${formatCents(Number(n))}`)
      .replace(/\(−(\d+)\)/g, (_m, n: string) => `(−${formatCents(Number(n))})`);
  }

  private addLog(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  viewFor(playerId: string): TableView {
    const me = this.get(playerId);
    const h = this.hand;
    const done = !!h?.state.outcome;
    const seats: (SeatView | null)[] = Array.from({ length: this.config.maxSeats }, () => null);
    for (const p of this.seated()) {
      if (p.seat! >= seats.length) continue;
      const hp = h?.state.players.find((q) => q.playerId === p.id);
      const shown = h?.state.outcome?.shown[p.id];
      let holeCards: Card[] | null = null;
      const ups = hp?.upCards ?? [];
      if (hp) {
        if (p.id === me.id) holeCards = hp.holeCards.length ? [...hp.holeCards] : null;
        else if (shown && shown.length) {
          // Stud showdown reveals all five cards; the up cards are already public, so keep only the down ones.
          const down = shown.filter((c) => !ups.includes(c));
          holeCards = down.length ? down : null;
        }
      }
      const revealed = !!h?.state.declarationsRevealed;
      seats[p.seat!] = {
        seat: p.seat!,
        waitingForBlind: p.blindDue && !p.postBlind && !p.sittingOut,
        playerId: p.id,
        name: p.name,
        stack: hp && !done ? hp.stack : p.stack,
        bet: hp && !done ? hp.bet : 0,
        inHand: !!hp && !hp.folded,
        folded: !!hp && hp.folded,
        allIn: !!hp && hp.allIn,
        sittingOut: p.sittingOut,
        connected: p.connections > 0,
        isButton: !!h && h.state.buttonSeat === p.seat,
        avatar: p.avatar,
        timeLimitSec: p.timerSec,
        holeCards,
        holeCount: hp && !hp.folded ? hp.holeCards.length : 0,
        upCards: hp && !hp.folded ? [...ups] : [],
        declared: revealed && hp && !hp.folded ? (hp.declared ?? null) : null,
        hasDeclared: !!hp && !hp.folded && hp.declared != null,
        lastAction: hp ? hp.lastAction : null,
      };
    }
    let hand: HandView | null = null;
    if (h) {
      const toAct = done ? null : h.state.toActSeat;
      const actor = toAct === null ? undefined : this.seatOwner(toAct);
      hand = {
        handNumber: h.state.handNumber,
        phase: h.state.phase,
        board: [...h.state.board],
        pots: potsView(h.state),
        toActSeat: toAct,
        stage: h.state.stage ?? (toAct !== null ? "bet" : null),
        actionDeadline: done ? null : h.actionDeadline,
        legal: actor && actor.id === me.id ? legalActions(h.state, me.id) : null,
        deckHash: h.deckHash,
        winners: h.state.outcome ? (h.awarded ?? (h.state.outcome.winners as WinnerView[])) : null,
      };
    }
    const ledger: LedgerEntry[] = [];
    for (const p of this.isTourney() ? [] : this.players.values()) {
      if (p.buyIns === 0 && p.cashOuts === 0) continue;
      const stack = p.seat !== null ? p.stack : 0;
      ledger.push({ playerId: p.id, name: p.name, buyIns: p.buyIns, cashOuts: p.cashOuts, stack, net: stack + p.cashOuts - p.buyIns });
    }
    return {
      tableId: this.tableId,
      hostPlayerId: this.hostId,
      you: { playerId: me.id, seat: me.seat, isHost: this.hostId === me.id, blindDue: me.blindDue, postBlind: me.postBlind },
      config: cloneConfig(this.config),
      pendingConfig: this.pendingConfig ? cloneConfig(this.pendingConfig) : null,
      status: this.budgetNotice !== null && this.status === "playing" ? "paused" : this.status,
      seats,
      hand,
      lastHand: this.lastHand,
      ledger,
      log: this.log.slice(-VIEW_LOG),
      dealerLog: { count: this.dealerLog.length, headHash: this.dealerHead, tail: this.dealerLog.slice(-VIEW_DEALER_LOG) },
      pendingAward: this.pendingAward ? { ...this.pendingAward, candidatePlayerIds: [...this.pendingAward.candidatePlayerIds], suggested: this.pendingAward.suggested.map((x) => ({ ...x })) } : null,
      handList: this.handList(),
      canExtend: this.canExtendNow(me),
      seatShufflePending: this.seatShuffleBy !== null,
      locked: this.locked,
      tournament: this.tournamentView(),
      siteNotice: this.budgetNotice,
      fairness: this.deckSource ? null : { nextHandNumber: this.handCounter + 1, serverSeedHash: seedHash(this.nextServerSeed) },
    };
  }
}
