import { describe, expect, it } from "vitest";
import { checkDown, foldAround, rig, seatAll } from "./helpers.js";

function started() {
  const r = rig(3);
  seatAll(r);
  r.table.hostStart(r.ids[0]!);
  r.clock.advance(1000);
  return r;
}
const handNo = (r: ReturnType<typeof rig>) => r.table.viewFor(r.ids[0]!).hand?.handNumber ?? 0;

describe("break between hands", () => {
  it("waits 9 s after a showdown and reports the countdown", () => {
    const r = started();
    checkDown(r);
    expect(r.table.viewFor(r.ids[1]!).nextHandInMs).toBe(9000);
    r.clock.advance(8900);
    expect(handNo(r)).toBe(1);
    expect(r.table.viewFor(r.ids[1]!).nextHandInMs).toBe(100);
    r.clock.advance(100);
    expect(handNo(r)).toBe(2);
    expect(r.table.viewFor(r.ids[1]!).nextHandInMs).toBeNull();
  });

  it("waits 8.5 s after everyone folds", () => {
    const r = started();
    foldAround(r);
    r.clock.advance(8400);
    expect(handNo(r)).toBe(1);
    r.clock.advance(100);
    expect(handNo(r)).toBe(2);
  });

  it("a game the host picks during the break is the next hand's game", () => {
    const r = started();
    checkDown(r);
    r.clock.advance(6000);
    r.table.hostConfig(r.ids[0]!, { variant: "plo4" });
    expect(r.table.viewFor(r.ids[0]!).config.variant).toBe("plo4");
    r.clock.advance(3000);
    expect(handNo(r)).toBe(2);
    expect(r.table.viewFor(r.ids[0]!).seats.find((s) => s?.playerId === r.ids[0])!.holeCards?.length).toBe(4);
  });
});
