import { randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  VARIANTS,
  applyAction,
  commitDeck,
  isValidAvatar,
  legalActions,
  potsView,
  startHand,
  timeoutAction,
  type Card,
  type HandRecord,
  type HandState,
  type HandView,
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
  deckSource: () => Card[];
  onChange: () => void;
  config?: Partial<TableConfig>;
}

interface Player {
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
  rebuyQueued: number;
  adjustQueued: number;
  avatar: string | null;
  /** Host override of the action timer: null = table default, 0 = no limit. */
  timerSec: number | null;
  /** Tournament finishing place once out (1 = winner); null while alive. */
  place: number | null;
}

interface Transfer {
  fromId: string;
  toId: string;
  amount: number;
}

interface TourneyState {
  status: "registering" | "running" | "finished";
  levelIndex: number;
  levelsCompleted: number;
  levelEndsAt: number | null;
  levelRemainingMs: number;
}

interface HandCtx {
  state: HandState;
  deckHash: string;
  reveal: { deck: Card[]; salt: string };
  participants: Set<string>;
  actionDeadline: number | null;
  /** Stack of each participant when the hand began (for tournament ranking). */
  startStacks: Map<string, number>;
  /** What the host actually awarded, once done (host award mode). */
  awarded: WinnerView[] | null;
}

const LOG_CAP = 200;
const FIRST_HAND_DELAY = 1000;
const SHOWDOWN_DELAY = 4000;
const FOLD_DELAY = 2500;
const MIN_DELAY = 1000;
const HOST_HANDOFF_MS = 60_000;

const CONFIG_KEYS = ["variant", "smallBlind", "bigBlind", "maxSeats", "actionTimeoutSec", "minBuyIn", "maxBuyIn", "awardMode", "mode", "tournament"] as const;

const ordinal = (n: number): string => {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export class Table {
  readonly tableId: string;
  private readonly now: () => number;
  private readonly sched: Scheduler;
  private readonly deckSource: () => Card[];
  private readonly onChange: () => void;

  private config: TableConfig;
  private pendingConfig: TableConfig | null = null;
  private status: "waiting" | "playing" | "paused" = "waiting";
  private hostId: string | null = null;
  private readonly players = new Map<string, Player>();
  private readonly byToken = new Map<string, string>();
  private hand: HandCtx | null = null;
  private lastHand: HandRecord | null = null;
  private handCounter = 0;
  private buttonSeat = -1;
  private log: string[] = [];
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
  private transfers: Transfer[] = [];
  private t: TourneyState | null = null;
  private levelTimer: unknown = null;

  constructor(opts: TableOptions) {
    this.tableId = opts.tableId;
    this.now = opts.now;
    this.sched = opts.scheduler;
    this.deckSource = opts.deckSource;
    this.onChange = opts.onChange;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    if (this.config.mode === "tournament") this.t = this.newTourney();
    this.idleSince = this.now();
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
      const id = randomBytes(8).toString("hex");
      p = {
        id, token, name: this.uniqueName(name, id), connections: 0, seat: null, stack: 0, sittingOut: false,
        timeouts: 0, buyIns: 0, cashOuts: 0, banned: false, standQueued: false, kickQueued: false, rebuyQueued: 0, adjustQueued: 0,
        avatar: avatar ?? null, timerSec: null, place: null,
      };
      this.players.set(id, p);
      this.byToken.set(token, id);
      if (!this.hostId) this.hostId = id;
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

  private requireHost(playerId: string): Player {
    const p = this.get(playerId);
    if (this.hostId !== p.id) throw new UserError("Only the host can do that.");
    return p;
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
      throw new UserError(`Buy-in must be a whole number from ${this.config.minBuyIn} to ${this.config.maxBuyIn}.`);
    }
    p.seat = seat;
    p.stack = buyIn;
    if (!tour) p.buyIns += buyIn;
    p.place = null;
    p.sittingOut = false;
    p.timeouts = 0;
    this.clearQueued(p);
    this.addLog(`${p.name} sat in seat ${seat + 1} with ${buyIn}`);
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
      if (p.stack <= 0) throw new UserError("Rebuy before sitting back in.");
      p.timeouts = 0;
    }
    if (p.sittingOut !== sittingOut) this.addLog(`${p.name} is ${sittingOut ? "sitting out" : "back in"}`);
    p.sittingOut = sittingOut;
    this.settleIfActor(p);
    this.changed();
  }

  rebuy(playerId: string, amount: number): void {
    const p = this.get(playerId);
    if (this.isTourney()) throw new UserError("Rebuys are off in this tournament.");
    if (p.seat === null) throw new UserError("Sit down before buying more chips.");
    if (!isInt(amount) || amount <= 0) throw new UserError("Enter a whole number of chips.");
    if (this.inLiveHand(p)) {
      if (p.stack + p.rebuyQueued + amount > this.config.maxBuyIn) throw new UserError(`Your stack cannot exceed ${this.config.maxBuyIn}.`);
      p.rebuyQueued += amount;
      this.addLog(`${p.name} will add ${amount} after this hand`);
    } else {
      const total = p.stack + amount;
      if (total > this.config.maxBuyIn) throw new UserError(`Your stack cannot exceed ${this.config.maxBuyIn}.`);
      this.credit(p, amount, "bought");
    }
    this.changed();
  }

  private credit(p: Player, amount: number, verb: string): void {
    const wasEmpty = p.stack <= 0;
    p.stack += amount;
    if (!this.isTourney()) p.buyIns += amount;
    if (wasEmpty) {
      p.sittingOut = false;
      p.timeouts = 0;
    }
    this.addLog(`${p.name} ${verb} ${amount} more chips`);
  }

  private removeFromSeat(p: Player, why: string): void {
    if (this.isTourney() && this.t?.status === "running") {
      this.bustOut(p);
      return;
    }
    if (p.stack > 0 && !this.isTourney()) p.cashOuts += p.stack;
    this.addLog(`${p.name} ${why} with ${p.stack}`);
    p.seat = null;
    p.stack = 0;
    p.sittingOut = false;
    p.timeouts = 0;
    this.clearQueued(p);
  }

  private clearQueued(p: Player): void {
    p.standQueued = false;
    p.kickQueued = false;
    p.rebuyQueued = 0;
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

  /** Moves host to a connected player: seated players by seat order first, then anyone connected. */
  private handOffHost(): void {
    if (!this.hostId) return;
    const host = this.players.get(this.hostId);
    if (!host || host.connections > 0) return;
    const candidates = [...this.players.values()].filter((p) => p.id !== host.id && p.connections > 0 && !p.banned);
    const next = candidates.filter((p) => p.seat !== null).sort((a, b) => a.seat! - b.seat!)[0] ?? candidates[0];
    if (!next) return;
    this.hostId = next.id;
    this.hostOfflineSince = null;
    this.addLog(`${next.name} is now the host`);
  }

  private clearHostTimer(): void {
    if (this.hostTimer !== null) this.sched.clearTimeout(this.hostTimer);
    this.hostTimer = null;
  }

  hostStart(playerId: string): void {
    this.requireHost(playerId);
    if (this.status === "playing") throw new UserError("The game is already running.");
    if (this.isTourney() && this.tourney().status !== "running") {
      if (this.seated().length < 2) throw new UserError("At least 2 players must be seated to start a tournament.");
      this.status = "playing";
      this.startTournament();
    } else {
      this.status = "playing";
      this.addLog("The host started the game");
    }
    this.syncClock();
    this.changed();
  }

  hostPause(playerId: string, paused: boolean): void {
    this.requireHost(playerId);
    if (typeof paused !== "boolean") throw new UserError("Invalid request.");
    if (paused) {
      if (this.status === "waiting") throw new UserError("The game has not started yet.");
      this.status = "paused";
      this.clearStartTimer();
      this.addLog("The host paused the game (the current hand will finish)");
    } else {
      if (this.status !== "paused") throw new UserError("The game is not paused.");
      this.status = "playing";
      this.addLog("The host resumed the game");
    }
    this.syncClock();
    this.changed();
  }

  hostConfig(playerId: string, patch: Partial<TableConfig>): void {
    this.requireHost(playerId);
    if (!patch || typeof patch !== "object") throw new UserError("Invalid settings.");
    const next: TableConfig = { ...(this.pendingConfig ?? this.config) };
    for (const key of Object.keys(patch)) {
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new UserError(`Unknown setting: ${key}`);
      const val = (patch as Record<string, unknown>)[key];
      (next as unknown as Record<string, unknown>)[key] = key === "tournament" && val && typeof val === "object" ? JSON.parse(JSON.stringify(val)) : val;
    }
    this.validateConfig(next);
    const tourneyChange = next.mode !== this.config.mode || JSON.stringify(next.tournament) !== JSON.stringify(this.config.tournament);
    if (tourneyChange && (this.handOpen() || this.t?.status === "running")) {
      throw new UserError("Tournament settings can only change when no tournament is running and no hand is in progress.");
    }
    if (!this.handOpen()) {
      if (next.mode !== this.config.mode) {
        // Keep the cash ledger honest across mode switches: cash chips are cashed out before a
        // tournament, and tournament chips are worthless afterwards (players rebuy for cash).
        for (const p of this.seated()) {
          if (next.mode === "tournament") p.cashOuts += p.stack;
          else p.sittingOut = true;
          p.stack = 0;
        }
      }
      this.config = next;
      this.pendingConfig = null;
      this.syncMode();
      this.addLog("Table settings updated");
    } else if (JSON.stringify(next) === JSON.stringify(this.config)) {
      this.pendingConfig = null;
    } else {
      this.pendingConfig = next;
      this.addLog("Table settings will change next hand");
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
    if (!isInt(c.actionTimeoutSec) || !(c.actionTimeoutSec === 0 || (c.actionTimeoutSec >= 10 && c.actionTimeoutSec <= 120))) {
      throw new UserError("The action timer must be 0 (off) or 10 to 120 seconds.");
    }
    if (!isInt(c.minBuyIn) || c.minBuyIn <= 0 || !isInt(c.maxBuyIn) || c.maxBuyIn <= 0) throw new UserError("Buy-ins must be positive whole numbers.");
    if (c.minBuyIn > c.maxBuyIn) throw new UserError("The minimum buy-in cannot exceed the maximum.");
    if (c.awardMode !== "auto" && c.awardMode !== "host") throw new UserError("Unknown award mode.");
    if (c.mode !== "cash" && c.mode !== "tournament") throw new UserError("Unknown game mode.");
    this.validateTournament(c.tournament);
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
    this.requireHost(playerId);
    const p = this.get(targetId);
    if (p.seat === null) throw new UserError(`${p.name} is not seated.`);
    if (typeof sittingOut !== "boolean") throw new UserError("Invalid request.");
    if (!sittingOut && p.stack <= 0) throw new UserError(`${p.name} needs chips before sitting back in.`);
    if (p.sittingOut !== sittingOut) this.addLog(`The dealer marked ${p.name} as ${sittingOut ? "sitting out" : "back in"}`);
    if (!sittingOut) p.timeouts = 0;
    p.sittingOut = sittingOut;
    this.settleIfActor(p);
    this.changed();
  }

  hostKick(playerId: string, targetId: string): void {
    this.requireHost(playerId);
    const t = this.players.get(targetId);
    if (!t) throw new UserError("That player is not at this table.");
    if (t.id === playerId) throw new UserError("You cannot kick yourself.");
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
    this.requireHost(playerId);
    const t = this.players.get(targetId);
    if (!t || t.seat === null) throw new UserError("That player is not seated.");
    if (!isInt(delta) || delta === 0) throw new UserError("Enter a non-zero whole number.");
    if (this.inLiveHand(t)) {
      if (t.stack + t.adjustQueued + delta < 0) throw new UserError("That would take the stack below zero.");
      t.adjustQueued += delta;
      this.addLog(`The host will adjust ${t.name}'s stack by ${delta > 0 ? "+" : ""}${delta} after this hand`);
    } else {
      this.applyAdjust(t, delta);
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
      this.addLog(`The host removed ${take} chips from ${t.name}`);
      if (t.stack === 0) t.sittingOut = true;
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
    const before = h.state;
    const legal = legalActions(before, p.id);
    let after: HandState;
    try {
      after = applyAction(before, p.id, act);
    } catch (e) {
      throw new UserError(e instanceof Error ? e.message : "That action is not allowed.");
    }
    const hadBet = before.players.some((q) => q.bet > 0 && q.playerId !== p.id) || (before.players.find((q) => q.playerId === p.id)?.bet ?? 0) > 0;
    let text: string;
    switch (act.type) {
      case "fold": text = "folds"; break;
      case "check": text = "checks"; break;
      case "call": text = `calls ${legal?.callAmount ?? ""}`.trim(); break;
      default: text = `${hadBet ? "raises" : "bets"} to ${act.amount}`;
    }
    if (after.players.find((q) => q.playerId === p.id)?.allIn) text += " (all in)";
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
    h.state = after;
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
      const folded = next.players.find((q) => q.playerId === p.id)?.folded;
      this.commit(next, `${p.name} ${folded ? "folds" : "checks"} (away)`);
    }
    if (h.state.outcome) this.finishHand();
    else this.armActionTimer();
  }

  private armActionTimer(): void {
    this.clearActionTimer();
    const h = this.hand;
    if (!h) return;
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

  private onActionTimeout(counted: boolean): void {
    const h = this.hand;
    if (!h || h.state.outcome || h.state.toActSeat === null) return;
    const p = this.seatOwner(h.state.toActSeat);
    if (!p) return;
    this.clearActionTimer();
    const next = timeoutAction(h.state);
    const folded = next.players.find((q) => q.playerId === p.id)?.folded;
    if (counted) p.timeouts++;
    this.commit(next, `${p.name} ${counted ? "timed out and" : "was timed out by the host and"} ${folded ? "folds" : "checks"}`);
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
    if (this.status !== "playing" || this.handOpen()) return;
    if (this.isTourney() && this.t?.status !== "running") return;
    const el = this.eligible();
    if (el.length < 2) return;
    this.applyPending();
    const seatsAsc = el.map((p) => p.seat!);
    const button = seatsAsc.find((s) => s > this.buttonSeat) ?? seatsAsc[0]!;
    this.buttonSeat = button;
    const blinds = this.currentBlinds();
    const deck = this.deckSource();
    const { hash, reveal } = commitDeck(deck);
    this.handCounter++;
    const state = startHand({
      handNumber: this.handCounter,
      variant: this.config.variant,
      seats: el.map((p) => ({ seat: p.seat!, playerId: p.id, stack: p.stack })),
      buttonSeat: button,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      deck,
    });
    this.hand = {
      state, deckHash: hash, reveal, participants: new Set(el.map((p) => p.id)), actionDeadline: null,
      startStacks: new Map(el.map((p) => [p.id, p.stack])), awarded: null,
    };
    const btn = this.seatOwner(button);
    this.addLog(`Hand #${this.handCounter} (${VARIANTS[this.config.variant].name}), button: ${btn?.name ?? "?"}`);
    this.settle();
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
        this.addLog(`${nm} wins ${g.amount}${g.name ? ` with ${g.name}${g.low ? " (low)" : ""}` : ""}`);
      }
    }
    this.lastHand = {
      handNumber: h.state.handNumber,
      variant: h.state.variant,
      deckHash: h.deckHash,
      reveal: h.reveal,
      board: [...h.state.board],
      winners: o.winners,
      // The engine logs "<playerId> (seat N)" with 0-based seats; show names instead.
      summary: o.summary.map((line) =>
        line
          .replace(/([0-9a-f]{8,}) \(seat \d+\)/g, (_m, id: string) => this.players.get(id)?.name ?? "Someone")
          .replace(/([0-9a-f]{8,})(?= wins)/g, (_m, id: string) => this.players.get(id)?.name ?? "Someone")
          .replace(/button: seat (\d+)/, (_m, seat: string) => {
            const p = h.state.players.find((x) => x.seat === Number(seat));
            return `button: ${(p && this.players.get(p.playerId)?.name) ?? `seat ${Number(seat) + 1}`}`;
          }),
      ),
    };
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
      this.addLog(`Hand #${h.state.handNumber}: ${withheld} is waiting for the dealer to award`);
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
      if (p.rebuyQueued > 0) {
        const room = this.config.maxBuyIn - p.stack;
        const amt = Math.min(p.rebuyQueued, room);
        p.rebuyQueued = 0;
        if (amt > 0) this.credit(p, amt, "bought");
      }
      if (p.adjustQueued !== 0) {
        const d = p.adjustQueued;
        p.adjustQueued = 0;
        this.applyAdjust(p, d);
      }
      if (p.stack <= 0 && !this.isTourney()) {
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
  }

  private applyTransfers(): void {
    const queued = this.transfers;
    this.transfers = [];
    for (const tr of queued) {
      const from = this.players.get(tr.fromId);
      const to = this.players.get(tr.toId);
      if (!from || !to) continue;
      if (from.seat === null || to.seat === null || from.stack < tr.amount) {
        this.addLog(`Dealer's move of ${tr.amount} from ${from.name} to ${to.name} was skipped (not enough chips)`);
        continue;
      }
      this.moveChips(from, to, tr.amount);
    }
  }

  private moveChips(from: Player, to: Player, amount: number): void {
    const wasEmpty = to.stack <= 0;
    from.stack -= amount;
    to.stack += amount;
    this.addLog(`Dealer moves ${amount} from ${from.name} to ${to.name}`);
    if (!this.isTourney()) {
      if (wasEmpty) {
        to.sittingOut = false;
        to.timeouts = 0;
      }
      if (from.stack === 0) from.sittingOut = true;
    }
  }

  hostAward(playerId: string, awards: unknown): void {
    this.requireHost(playerId);
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
    if (sum !== pa.amount) throw new UserError(`Awards must add up to exactly ${pa.amount} (you entered ${sum}).`);
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
      parts.push(`${amount} to ${p.name}`);
    }
    this.addLog(`Dealer awards ${parts.join(", ")}`);
    h.awarded = winners;
    if (this.lastHand) this.lastHand = { ...this.lastHand, winners };
    this.pendingAward = null;
    this.nextDelay = MIN_DELAY; // the dealer already paused the game; do not wait again
    this.completeHand();
    this.changed();
  }

  hostTransfer(playerId: string, fromId: unknown, toId: unknown, amount: unknown): void {
    this.requireHost(playerId);
    const from = typeof fromId === "string" ? this.players.get(fromId) : undefined;
    const to = typeof toId === "string" ? this.players.get(toId) : undefined;
    if (!from || !to || from.seat === null || to.seat === null) throw new UserError("Both players must be seated.");
    if (from.id === to.id) throw new UserError("Pick two different players.");
    if (!isInt(amount) || amount <= 0) throw new UserError("Enter a positive whole number of chips.");
    if (this.handOpen()) {
      this.transfers.push({ fromId: from.id, toId: to.id, amount });
      this.addLog(`Dealer will move ${amount} from ${from.name} to ${to.name} after this hand`);
    } else {
      if (from.stack < amount) throw new UserError(`${from.name} only has ${from.stack}.`);
      this.moveChips(from, to, amount);
      this.eliminate();
    }
    this.changed();
  }

  // ------------------------------------------------------------------ timers (host)

  hostPlayerTimer(playerId: string, targetId: unknown, seconds: unknown): void {
    this.requireHost(playerId);
    const t = typeof targetId === "string" ? this.players.get(targetId) : undefined;
    if (!t) throw new UserError("That player is not at this table.");
    if (seconds !== null && !(isInt(seconds) && (seconds === 0 || (seconds >= 10 && seconds <= 300)))) {
      throw new UserError("A player timer must be off (0), the table default, or 10 to 300 seconds.");
    }
    t.timerSec = seconds as number | null;
    this.addLog(`Dealer set ${t.name}'s timer to ${seconds === null ? "the table default" : seconds === 0 ? "no limit" : `${seconds}s`}`);
    const h = this.hand;
    if (h && !h.state.outcome && h.state.toActSeat !== null && h.state.toActSeat === t.seat) this.armActionTimer();
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
    this.requireHost(playerId);
    if (!isInt(seconds) || seconds < 10 || seconds > 300) throw new UserError("Add 10 to 300 seconds.");
    const t = this.onClock(targetId);
    const h = this.hand!;
    if (h.actionDeadline === null) throw new UserError(`${t.name} has no time limit right now.`);
    h.actionDeadline += seconds * 1000;
    this.scheduleActionTimer(Math.max(0, h.actionDeadline - this.now()));
    this.addLog(`Dealer gave ${t.name} ${seconds} more seconds`);
    this.changed();
  }

  hostForceTimeout(playerId: string, targetId: unknown): void {
    this.requireHost(playerId);
    this.onClock(targetId);
    this.onActionTimeout(false);
    this.changed();
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
    this.requireHost(playerId);
    const t = this.runningTourney();
    if (delta !== 1 && delta !== -1) throw new UserError("Invalid request.");
    const idx = Math.max(0, Math.min(t.levelIndex + delta, this.config.tournament.levels.length - 1));
    if (idx === t.levelIndex) throw new UserError(delta > 0 ? "Already at the last level." : "Already at the first level.");
    t.levelIndex = idx;
    t.levelsCompleted = Math.max(0, t.levelsCompleted + delta);
    t.levelRemainingMs = this.levelAt(idx).minutes * 60_000;
    if (t.levelEndsAt !== null) {
      t.levelEndsAt = this.now() + t.levelRemainingMs;
      this.armLevelTimer();
    }
    const l = this.levelAt(idx);
    this.addLog(`The host moved to level ${idx + 1}: ${l.smallBlind}/${l.bigBlind} (applies next hand)`);
    this.changed();
  }

  hostTournamentClock(playerId: string, addMs: unknown): void {
    this.requireHost(playerId);
    const t = this.runningTourney();
    if (!isInt(addMs) || Math.abs(addMs) > 86_400_000) throw new UserError("Invalid time change.");
    const cur = t.levelEndsAt !== null ? t.levelEndsAt - this.now() : t.levelRemainingMs;
    const rem = Math.max(1000, cur + addMs);
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
      if (hp) {
        if (p.id === me.id) holeCards = hp.holeCards.length ? [...hp.holeCards] : null;
        else if (shown && shown.length) holeCards = [...shown];
      }
      seats[p.seat!] = {
        seat: p.seat!,
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
      you: { playerId: me.id, seat: me.seat, isHost: this.hostId === me.id },
      config: { ...this.config },
      pendingConfig: this.pendingConfig ? { ...this.pendingConfig } : null,
      status: this.status,
      seats,
      hand,
      lastHand: this.lastHand,
      ledger,
      log: [...this.log],
      pendingAward: this.pendingAward ? { ...this.pendingAward, candidatePlayerIds: [...this.pendingAward.candidatePlayerIds], suggested: this.pendingAward.suggested.map((x) => ({ ...x })) } : null,
      tournament: this.tournamentView(),
    };
  }
}
