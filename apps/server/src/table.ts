import { randomBytes } from "node:crypto";
import {
  DEFAULT_CONFIG,
  VARIANTS,
  applyAction,
  commitDeck,
  legalActions,
  potsView,
  startHand,
  timeoutAction,
  type Card,
  type HandRecord,
  type HandState,
  type HandView,
  type LedgerEntry,
  type PlayerAction,
  type SeatView,
  type TableConfig,
  type TableView,
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
}

interface HandCtx {
  state: HandState;
  deckHash: string;
  reveal: { deck: Card[]; salt: string };
  participants: Set<string>;
  actionDeadline: number | null;
}

const LOG_CAP = 200;
const FIRST_HAND_DELAY = 1000;
const SHOWDOWN_DELAY = 4000;
const FOLD_DELAY = 2500;
const MIN_DELAY = 1000;
const HOST_HANDOFF_MS = 60_000;

const CONFIG_KEYS = ["variant", "smallBlind", "bigBlind", "maxSeats", "actionTimeoutSec", "minBuyIn", "maxBuyIn"] as const;

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

  constructor(opts: TableOptions) {
    this.tableId = opts.tableId;
    this.now = opts.now;
    this.sched = opts.scheduler;
    this.deckSource = opts.deckSource;
    this.onChange = opts.onChange;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.idleSince = this.now();
  }

  // ------------------------------------------------------------------ identity

  /** Registers one connection for the token's player (creating the player if new) and returns the public playerId. */
  join(token: string, rawName: string): string {
    if (typeof token !== "string" || token.length < 1 || token.length > 200) throw new UserError("Invalid player token.");
    const name = this.cleanName(rawName);
    let p = this.byToken.has(token) ? this.players.get(this.byToken.get(token)!) : undefined;
    if (p) {
      p.name = this.uniqueName(name, p.id);
    } else {
      const id = randomBytes(8).toString("hex");
      p = {
        id, token, name: this.uniqueName(name, id), connections: 0, seat: null, stack: 0, sittingOut: false,
        timeouts: 0, buyIns: 0, cashOuts: 0, banned: false, standQueued: false, kickQueued: false, rebuyQueued: 0, adjustQueued: 0,
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
    this.clearStartTimer();
    this.clearActionTimer();
    this.clearHostTimer();
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
    if (!isInt(buyIn) || buyIn < this.config.minBuyIn || buyIn > this.config.maxBuyIn) {
      throw new UserError(`Buy-in must be a whole number from ${this.config.minBuyIn} to ${this.config.maxBuyIn}.`);
    }
    p.seat = seat;
    p.stack = buyIn;
    p.buyIns += buyIn;
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
    p.buyIns += amount;
    if (wasEmpty) {
      p.sittingOut = false;
      p.timeouts = 0;
    }
    this.addLog(`${p.name} ${verb} ${amount} more chips`);
  }

  private removeFromSeat(p: Player, why: string): void {
    if (p.stack > 0) p.cashOuts += p.stack;
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
    return this.seated().filter((p) => p.stack > 0 && !p.sittingOut);
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
    this.status = "playing";
    this.addLog("The host started the game");
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
    this.changed();
  }

  hostConfig(playerId: string, patch: Partial<TableConfig>): void {
    this.requireHost(playerId);
    if (!patch || typeof patch !== "object") throw new UserError("Invalid settings.");
    const next: TableConfig = { ...(this.pendingConfig ?? this.config) };
    for (const key of Object.keys(patch)) {
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new UserError(`Unknown setting: ${key}`);
      (next as unknown as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
    this.validateConfig(next);
    if (!this.live()) {
      this.config = next;
      this.pendingConfig = null;
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
    }
    this.changed();
  }

  private applyAdjust(t: Player, delta: number): void {
    if (delta > 0) {
      this.credit(t, delta, "was given");
    } else {
      const take = Math.min(t.stack, -delta);
      t.stack -= take;
      t.cashOuts += take;
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

  private inLiveHand(p: Player): boolean {
    return this.live() && this.hand!.participants.has(p.id);
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
    if (h.state.outcome || h.state.toActSeat === null || this.config.actionTimeoutSec <= 0) {
      h.actionDeadline = null;
      return;
    }
    const ms = this.config.actionTimeoutSec * 1000;
    h.actionDeadline = this.now() + ms;
    this.actionTimer = this.sched.setTimeout(() => {
      this.actionTimer = null;
      this.onActionTimeout();
    }, ms);
  }

  private onActionTimeout(): void {
    const h = this.hand;
    if (!h || h.state.outcome || h.state.toActSeat === null) return;
    const p = this.seatOwner(h.state.toActSeat);
    if (!p) return;
    const next = timeoutAction(h.state);
    const folded = next.players.find((q) => q.playerId === p.id)?.folded;
    p.timeouts++;
    this.commit(next, `${p.name} timed out and ${folded ? "folds" : "checks"}`);
    if (p.timeouts >= 2 && !p.sittingOut) {
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
    if (this.status !== "playing" || this.live() || this.startTimer !== null) return;
    if (this.eligible().length < 2) return;
    const delay = this.endedAt === null ? FIRST_HAND_DELAY : Math.max(MIN_DELAY, this.nextDelay - (this.now() - this.endedAt));
    this.startTimer = this.sched.setTimeout(() => {
      this.startTimer = null;
      this.beginHand();
      this.changed();
    }, delay);
  }

  private beginHand(): void {
    if (this.status !== "playing" || this.live()) return;
    const el = this.eligible();
    if (el.length < 2) return;
    this.applyPending();
    const seatsAsc = el.map((p) => p.seat!);
    const button = seatsAsc.find((s) => s > this.buttonSeat) ?? seatsAsc[0]!;
    this.buttonSeat = button;
    const deck = this.deckSource();
    const { hash, reveal } = commitDeck(deck);
    this.handCounter++;
    const state = startHand({
      handNumber: this.handCounter,
      variant: this.config.variant,
      seats: el.map((p) => ({ seat: p.seat!, playerId: p.id, stack: p.stack })),
      buttonSeat: button,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      deck,
    });
    this.hand = { state, deckHash: hash, reveal, participants: new Set(el.map((p) => p.id)), actionDeadline: null };
    const btn = this.seatOwner(button);
    this.addLog(`Hand #${this.handCounter} (${VARIANTS[this.config.variant].name}), button: ${btn?.name ?? "?"}`);
    this.settle();
  }

  private finishHand(): void {
    const h = this.hand!;
    const o = h.state.outcome!;
    this.clearActionTimer();
    h.actionDeadline = null;
    for (const id of h.participants) {
      const p = this.players.get(id);
      const fin = o.finalStacks[id];
      if (p && fin !== undefined) p.stack = fin;
    }
    // Log winners, grouped per player and hand.
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

    // Queued requests.
    for (const p of this.seated()) {
      if (p.kickQueued || p.standQueued) {
        this.removeFromSeat(p, p.kickQueued ? "was removed" : "cashed out");
        continue;
      }
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
      if (p.stack <= 0) {
        p.sittingOut = true;
        this.addLog(`${p.name} is out of chips`);
      }
    }
    this.applyPending();
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
        winners: h.state.outcome ? (h.state.outcome.winners as WinnerView[]) : null,
      };
    }
    const ledger: LedgerEntry[] = [];
    for (const p of this.players.values()) {
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
    };
  }
}
