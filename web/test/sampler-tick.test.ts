// Inspector ticks: fired at quiet slice boundaries (idle / user mode), deferred at most maxDeferMs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSampler } from "../src/live/sampler";
import type { Machine } from "../src/vm/machine";
import type { Program } from "../src/debug/api";
import type { AddressSpace } from "../src/vm/mmu";

class FakeMachine {
  running = true;
  halted = false;
  cpl = 0;
  private cbs = new Set<(start: number) => void>();
  onSlice(cb: (start: number) => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  get hooked() {
    return this.cbs.size;
  }
  slice() {
    for (const cb of this.cbs) cb(performance.now());
  }
}

let now = 0;
beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const m = new FakeMachine();
  const space = { clearCache: vi.fn() };
  // CpuRecorder construction fails on the empty Program; the sampler records that and carries on.
  const live = new LiveSampler(m as unknown as Machine, {} as Program, space as unknown as AddressSpace);
  return { m, space, live };
}

describe("LiveSampler ticks", () => {
  it("fires a new subscriber at the next quiet boundary, then periodically", () => {
    const { m, space, live } = setup();
    live.tickIntervalMs = 500;
    const cb = vi.fn();
    live.subscribeTick(cb);
    m.cpl = 3;
    m.slice();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(false);
    expect(space.clearCache).toHaveBeenCalledTimes(1);
    now += 100;
    m.slice();
    expect(cb).toHaveBeenCalledTimes(1);
    now += 500;
    m.slice();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("waits for a quiet boundary, but no longer than maxDeferMs (torn)", () => {
    const { m, live } = setup();
    live.maxDeferMs = 25;
    const cb = vi.fn();
    live.subscribeTick(cb);
    m.slice(); // kernel mode: defer
    now += 10;
    m.slice();
    expect(cb).not.toHaveBeenCalled();
    now += 20;
    m.slice();
    expect(cb).toHaveBeenCalledWith(true);
    expect(live.tickTorn).toBe(true);
  });

  it("only fires subscribers with pending work between periodic ticks", () => {
    const { m, live } = setup();
    m.halted = true;
    const a = vi.fn();
    const b = vi.fn();
    live.subscribeTick(a);
    m.slice();
    now += 10;
    live.subscribeTick(b);
    m.slice();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("interval 0 means manual: only on subscribe or requestTick", () => {
    const { m, live } = setup();
    live.tickIntervalMs = 0;
    m.halted = true;
    const cb = vi.fn();
    live.subscribeTick(cb);
    m.slice();
    now += 5000;
    m.slice();
    expect(cb).toHaveBeenCalledTimes(1);
    live.requestTick();
    m.slice();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("unhooks from slices when the last subscriber leaves", () => {
    const { m, live } = setup();
    const off = live.subscribeTick(() => {});
    expect(m.hooked).toBe(1);
    off();
    expect(m.hooked).toBe(0);
  });
});
