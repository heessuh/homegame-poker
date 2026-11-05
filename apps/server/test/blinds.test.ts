import { describe, expect, it } from "vitest";
import { UserError } from "../src/table.js";
import { foldAround, rig, type Rig } from "./helpers.js";

const seatOf = (r: Rig, seat: number) => r.table.viewFor(r.ids[0]!).seats[seat]!;
const nextHand = (r: Rig) => { foldAround(r); r.clock.advance(20_000); };
const start = (r: Rig) => { r.table.hostStart(r.ids[0]!); r.clock.advance(1000); };

/** P0, P1, P2 in seats 0, 2, 4 with hand 1 running (button 0, small blind seat 2, big blind seat 4). */
function running(n: number): Rig {
  const r = rig(n);
  [0, 2, 4].forEach((seat, i) => r.table.sit(r.ids[i]!, seat, 100));
  start(r);
  return r;
}

describe("missed blinds: joining mid-game", () => {
  it("nobody owes anything before the first hand", () => {
    const r = rig(3);
    r.ids.forEach((id, i) => r.table.sit(id, i, 100));
    expect(r.table.viewFor(r.ids[2]!).you.blindDue).toBe(false);
    start(r);
    expect(r.ids.every((_id, i) => seatOf(r, i).inHand)).toBe(true);
  });

  it("a new player waits, then is dealt in on the big blind and pays it", () => {
    const r = running(4);
    const late = r.ids[3]!;
    r.table.sit(late, 1, 100);
    expect(r.table.viewFor(late).you.blindDue).toBe(true);
    expect(seatOf(r, 1).waitingForBlind).toBe(true);

    nextHand(r); // button 2, small blind 4, big blind 0: the big blind hasn't reached seat 1
    expect(seatOf(r, 1).inHand).toBe(false);
    expect(seatOf(r, 1).stack).toBe(100);

    nextHand(r); // button 4, small blind 0, and seat 1 is next: the big blind
    expect(seatOf(r, 1).inHand).toBe(true);
    expect(seatOf(r, 1).bet).toBe(2);
    expect(seatOf(r, 0).bet).toBe(1);
    expect(seatOf(r, 4).isButton).toBe(true);
    expect(r.table.viewFor(late).you.blindDue).toBe(false);
    expect(seatOf(r, 1).waitingForBlind).toBe(false);
  });

  it("posting plays the next hand with a live big blind", () => {
    const r = running(4);
    const late = r.ids[3]!;
    r.table.sit(late, 1, 100);
    r.table.choosePostBlind(late, true);
    expect(r.table.viewFor(late).you.postBlind).toBe(true);
    expect(seatOf(r, 1).waitingForBlind).toBe(false);

    nextHand(r); // button 2, small blind 4, big blind 0, then seat 1 acts first
    const me = r.table.viewFor(late);
    expect(seatOf(r, 1).bet).toBe(2);
    expect(seatOf(r, 1).stack).toBe(98);
    expect(me.hand!.toActSeat).toBe(1);
    expect(me.hand!.legal!.callAmount).toBe(0); // the post counts toward the call
    expect(me.hand!.legal!.canCheck).toBe(true);
    expect(me.you.blindDue).toBe(false);
    expect(me.you.postBlind).toBe(false);
  });

  it("the choice can be undone, and only someone who owes a blind can make it", () => {
    const r = running(4);
    expect(() => r.table.choosePostBlind(r.ids[1]!, true)).toThrow(UserError);
    const late = r.ids[3]!;
    r.table.sit(late, 1, 100);
    r.table.choosePostBlind(late, true);
    r.table.choosePostBlind(late, false);
    nextHand(r);
    expect(seatOf(r, 1).inHand).toBe(false);
  });

  it("sitting out cancels a planned post", () => {
    const r = running(4);
    const late = r.ids[3]!;
    r.table.sit(late, 1, 100);
    r.table.choosePostBlind(late, true);
    r.table.sitOut(late, true);
    expect(r.table.viewFor(late).you.postBlind).toBe(false);
    expect(() => r.table.choosePostBlind(late, true)).toThrow(UserError);
  });

  it("with two players in, the waiting player still gets the big blind", () => {
    const r = rig(3);
    r.table.sit(r.ids[0]!, 0, 100);
    r.table.sit(r.ids[1]!, 2, 100);
    start(r);
    r.table.sit(r.ids[2]!, 1, 100);
    nextHand(r); // button 2, small blind 0, big blind 1
    expect(seatOf(r, 2).isButton).toBe(true);
    expect(seatOf(r, 0).bet).toBe(1);
    expect(seatOf(r, 1).bet).toBe(2);
  });

  it("nobody waits when there is no game to join", () => {
    const r = rig(3);
    r.table.sit(r.ids[0]!, 0, 100);
    r.table.sit(r.ids[1]!, 1, 100);
    start(r);
    r.table.stand(r.ids[1]!);
    r.table.sit(r.ids[2]!, 4, 100);
    expect(r.table.viewFor(r.ids[2]!).you.blindDue).toBe(true);
    nextHand(r);
    expect(seatOf(r, 4).inHand).toBe(true);
    expect(seatOf(r, 0).inHand).toBe(true);
    expect(r.table.viewFor(r.ids[2]!).you.blindDue).toBe(false);
  });

  it("standing up and sitting back down does not clear a debt by itself, but leaving a seat resets it for a fresh sit", () => {
    const r = running(4);
    r.table.sit(r.ids[3]!, 1, 100);
    r.table.stand(r.ids[3]!);
    expect(r.table.viewFor(r.ids[3]!).you.blindDue).toBe(false);
    r.table.sit(r.ids[3]!, 1, 100);
    expect(r.table.viewFor(r.ids[3]!).you.blindDue).toBe(true);
  });

  it("does not apply to 5-Murder, which has antes", () => {
    const r = rig(3, { variant: "murder5" });
    r.table.sit(r.ids[0]!, 0, 100);
    r.table.sit(r.ids[1]!, 1, 100);
    start(r);
    r.table.sit(r.ids[2]!, 2, 100);
    nextHand(r);
    expect(seatOf(r, 2).inHand).toBe(true);
    expect(r.table.viewFor(r.ids[2]!).you.blindDue).toBe(false);
  });
});

describe("missed blinds: sitting out", () => {
  /** Four players in seats 0-3; hand 1 running (button 0, small blind 1, big blind 2). */
  function four(): Rig {
    const r = rig(4);
    r.ids.forEach((id, i) => r.table.sit(id, i, 100));
    start(r);
    return r;
  }

  it("a player who misses the big blind waits for it after coming back", () => {
    const r = four();
    r.table.sitOut(r.ids[3]!, true);
    nextHand(r); // button 1, small blind 2, big blind 0: seat 3 was skipped between them
    expect(r.table.viewFor(r.ids[3]!).you.blindDue).toBe(true);
    r.table.sitOut(r.ids[3]!, false);
    expect(seatOf(r, 3).waitingForBlind).toBe(true);

    nextHand(r); // button 2, small blind 0, big blind 1
    expect(seatOf(r, 3).inHand).toBe(false);
    nextHand(r); // button 0, small blind 1, big blind 2
    expect(seatOf(r, 3).inHand).toBe(false);
    nextHand(r); // button 1, small blind 2, then seat 3: the big blind
    expect(seatOf(r, 3).inHand).toBe(true);
    expect(seatOf(r, 3).bet).toBe(2);
  });

  it("a player who comes back before the big blind passes owes nothing", () => {
    const r = four();
    r.table.sitOut(r.ids[0]!, true);
    nextHand(r); // button 1, small blind 2, big blind 3: seat 0 wasn't between them
    expect(r.table.viewFor(r.ids[0]!).you.blindDue).toBe(false);
    r.table.sitOut(r.ids[0]!, false);
    nextHand(r);
    expect(seatOf(r, 0).inHand).toBe(true);
  });

  it("the debt is saved with the table", () => {
    const r = running(4);
    r.table.sit(r.ids[3]!, 1, 100);
    r.table.choosePostBlind(r.ids[3]!, true);
    const saved = JSON.parse(JSON.stringify(r.table.snapshot())) as { players: { id: string; blindDue: boolean; postBlind: boolean }[] };
    const p = saved.players.find((x) => x.id === r.ids[3])!;
    expect(p.blindDue).toBe(true);
    expect(p.postBlind).toBe(true);
  });
});
