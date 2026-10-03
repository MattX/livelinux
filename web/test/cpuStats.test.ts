import { describe, expect, it } from "vitest";
import { CPU_HALTED, CPU_USER, CpuTrace } from "../src/live/cputrace";
import {
  COL_IDLE,
  COL_NONE,
  MODE_IDLE,
  MODE_KERNEL,
  MODE_NONE,
  MODE_USER,
  buildColumns,
  computeStats,
  findAt,
  latestTime,
  lowerBound,
  taskColor,
  windowStart,
  type SymbolLookup,
} from "../src/live/cpuStats";

const A = 0xc0001000;
const B = 0xc0002000;
const IDLE = 0xc0003000;

const symbols: SymbolLookup = {
  lookup(addr) {
    if (addr < 0x100) return undefined;
    if (addr < 0x200) return { sym: { name: "alpha" }, offset: addr - 0x100 };
    if (addr < 0x300) return { sym: { name: "beta" }, offset: addr - 0x200 };
    return undefined;
  },
};

function mkTrace(capacity = 64): CpuTrace {
  const t = new CpuTrace(capacity);
  t.tasks.set(A, { pid: 10, comm: "A" });
  t.tasks.set(B, { pid: 11, comm: "B" });
  t.tasks.set(IDLE, { pid: 0, comm: "swapper" });
  return t;
}

/** The scenario used by most tests (times in ms):
 *  [0,1] A user | [1,2] A kernel@alpha | [2,3] swapper halted | gap 3-5 idle | [5,6] B user |
 *  gap 6-7 overhead | [7,8] B kernel@beta */
function scenario(): CpuTrace {
  const t = mkTrace();
  t.push(0, 1, 1000, A, 0x1000, CPU_USER);
  t.push(1, 2, 500, A, 0x110, 0);
  t.push(2, 3, 10, IDLE, 0x50, CPU_HALTED);
  t.push(5, 6, 2000, B, 0x1000, CPU_USER);
  t.push(7, 8, 1000, B, 0x210, 0);
  return t;
}

describe("trace helpers", () => {
  it("lowerBound / latestTime / windowStart", () => {
    const t = scenario();
    expect(lowerBound(t, -5)).toBe(0);
    expect(lowerBound(t, 3)).toBe(2);
    expect(lowerBound(t, 3.5)).toBe(3);
    expect(lowerBound(t, 100)).toBe(5);
    expect(latestTime(t)).toBe(8);
    expect(latestTime(mkTrace())).toBe(0);
    expect(windowStart(t, 8, 1000)).toBe(0);
    expect(windowStart(t, 8, 4)).toBe(4);
  });

  it("taskColor is stable and distinguishes pids", () => {
    expect(taskColor(42)).toBe(taskColor(42));
    expect(taskColor(42)).not.toBe(taskColor(43));
    expect(taskColor(5)).toMatch(/^hsl\(/);
  });
});

describe("computeStats", () => {
  it("accounts user / kernel / idle / overhead over the whole trace", () => {
    const s = computeStats(scenario(), 8, 1000, symbols);
    expect(s.from).toBe(0);
    expect(s.spanMs).toBe(8);
    expect(s.userMs).toBeCloseTo(2);
    expect(s.kernelMs).toBeCloseTo(2);
    expect(s.idleMs).toBeCloseTo(3); // 1 halted slice + 2 ms gap
    expect(s.overheadMs).toBeCloseTo(1);
    expect(s.user).toBeCloseTo(0.25);
    expect(s.kernel).toBeCloseTo(0.25);
    expect(s.idle).toBeCloseTo(0.375);
    expect(s.overhead).toBeCloseTo(0.125);
    expect(s.user + s.kernel + s.idle + s.overhead).toBeCloseTo(1);
    expect(s.slices).toBe(5);
    expect(s.instrs).toBeCloseTo(4510);
    expect(s.slicesPerSec).toBeCloseTo(5 / 0.008);
    expect(s.mips).toBeCloseTo(4510 / 0.008 / 1e6);
  });

  it("ranks tasks by on-CPU time excluding halted slices", () => {
    const s = computeStats(scenario(), 8, 1000, symbols);
    expect(s.taskCount).toBe(2);
    expect(s.tasks.map((t) => [t.comm, t.pid])).toEqual([["A", 10], ["B", 11]]);
    expect(s.tasks[0].ms).toBeCloseTo(2);
    expect(s.tasks[0].share).toBeCloseTo(0.25);
  });

  it("builds a kernel profile from non-halted kernel slices only", () => {
    const s = computeStats(scenario(), 8, 1000, symbols);
    expect(s.kernelSamples).toBe(2); // the halted swapper slice is excluded
    expect(s.kernelBusyMs).toBeCloseTo(2);
    expect(s.funcs.map((f) => f.name)).toEqual(["alpha", "beta"]);
    expect(s.funcs[0].share).toBeCloseTo(0.5);
  });

  it("labels unsymbolized kernel EIPs and unnamed tasks", () => {
    const t = mkTrace();
    t.push(0, 2, 10, 0xdead0000, 0x10, 0);
    const s = computeStats(t, 2, 1000, symbols);
    expect(s.funcs[0].name).toBe("(unknown)");
    expect(s.tasks[0].pid).toBe(-1);
    expect(s.tasks[0].comm).toContain("dead0000");
    const s2 = computeStats(t, 2, 1000);
    expect(s2.funcs[0].name).toBe("(unknown)");
  });

  it("clips to a shorter window, including a gap that straddles its start", () => {
    const s = computeStats(scenario(), 8, 4, symbols); // [4, 8]
    expect(s.from).toBe(4);
    expect(s.spanMs).toBe(4);
    expect(s.idleMs).toBeCloseTo(1); // gap 4-5
    expect(s.userMs).toBeCloseTo(1);
    expect(s.kernelMs).toBeCloseTo(1);
    expect(s.overheadMs).toBeCloseTo(1);
    expect(s.slices).toBe(2);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].comm).toBe("B");
  });

  it("clips a slice that straddles the window start and prorates instructions", () => {
    const t = mkTrace();
    t.push(0, 10, 1000, A, 0x1000, CPU_USER);
    const s = computeStats(t, 10, 5);
    expect(s.userMs).toBeCloseTo(5);
    expect(s.instrs).toBeCloseTo(500);
    expect(s.overhead).toBeCloseTo(0);
  });

  it("extends a trailing halted slice with idle time up to `to`", () => {
    const t = mkTrace();
    t.push(0, 1, 10, A, 0x1000, CPU_USER);
    t.push(1, 2, 1, IDLE, 0x50, CPU_HALTED);
    const s = computeStats(t, 6, 1000);
    expect(s.spanMs).toBe(6);
    expect(s.idleMs).toBeCloseTo(5);
    expect(s.overheadMs).toBeCloseTo(0);
  });

  it("handles an empty trace", () => {
    const s = computeStats(mkTrace(), 100, 1000, symbols);
    expect(s.spanMs).toBe(0);
    expect(s.slices).toBe(0);
    expect(s.mips).toBe(0);
    expect(s.tasks).toEqual([]);
    expect(s.funcs).toEqual([]);
  });

  it("works across a wrapped ring and limits the window to the oldest sample", () => {
    const t = mkTrace(4);
    for (let i = 0; i < 6; i++) t.push(i, i + 1, 100, A, 0x1000, CPU_USER);
    expect(t.count).toBe(4);
    const s = computeStats(t, 6, 60000);
    expect(s.from).toBe(2);
    expect(s.spanMs).toBe(4);
    expect(s.slices).toBe(4);
    expect(s.user).toBeCloseTo(1);
    expect(s.instrs).toBeCloseTo(400);
  });

  it("honours topTasks / topFuncs", () => {
    const t = mkTrace();
    for (let i = 0; i < 5; i++) {
      t.tasks.set(0xc0100000 + i, { pid: 100 + i, comm: `t${i}` });
      t.push(i, i + 1, 1, 0xc0100000 + i, 0x110 + i * 0x100, 0);
    }
    const s = computeStats(t, 5, 1000, symbols, { topTasks: 2, topFuncs: 1 });
    expect(s.tasks).toHaveLength(2);
    expect(s.taskCount).toBe(5);
    expect(s.funcs).toHaveLength(1);
  });
});

describe("buildColumns", () => {
  it("reduces slices, idle and gaps to per-column task and mode", () => {
    const t = mkTrace();
    t.push(0, 3, 1, A, 0x1000, CPU_USER);
    t.push(3, 4, 1, IDLE, 0x50, CPU_HALTED); // gap 4-6 idle
    t.push(6, 10, 1, B, 0x110, 0);
    const c = buildColumns(t, 0, 10, 10);
    expect(Array.from(c.task)).toEqual([A, A, A, COL_IDLE, COL_IDLE, COL_IDLE, B, B, B, B]);
    expect(Array.from(c.mode)).toEqual([
      MODE_USER, MODE_USER, MODE_USER, MODE_IDLE, MODE_IDLE, MODE_IDLE,
      MODE_KERNEL, MODE_KERNEL, MODE_KERNEL, MODE_KERNEL,
    ]);
  });

  it("picks the task with the most time in a column and ignores overhead gaps", () => {
    const t = mkTrace();
    t.push(0, 1, 1, A, 0x1000, CPU_USER);
    t.push(2, 5, 1, B, 0x1000, CPU_USER); // gap 1-2 is overhead
    const c = buildColumns(t, 0, 10, 2); // columns [0,5) and [5,10)
    expect(c.task[0]).toBe(B);
    expect(c.task[1]).toBe(COL_NONE);
    expect(c.mode[1]).toBe(MODE_NONE);
  });

  it("marks columns outside the recorded data as empty", () => {
    const t = mkTrace();
    t.push(5, 10, 1, A, 0x1000, CPU_USER);
    const c = buildColumns(t, 0, 10, 10);
    expect(Array.from(c.task.slice(0, 5))).toEqual([COL_NONE, COL_NONE, COL_NONE, COL_NONE, COL_NONE]);
    expect(Array.from(c.task.slice(5))).toEqual([A, A, A, A, A]);
  });

  it("handles degenerate input", () => {
    expect(buildColumns(mkTrace(), 0, 10, 0).task.length).toBe(0);
    expect(buildColumns(mkTrace(), 0, 10, 4).task[0]).toBe(COL_NONE);
    expect(buildColumns(scenario(), 5, 5, 4).task[0]).toBe(COL_NONE);
  });
});

describe("findAt", () => {
  it("finds slices, idle gaps and overhead gaps", () => {
    const t = scenario();
    const s = findAt(t, 1.5);
    expect(s.kind).toBe("slice");
    if (s.kind === "slice") {
      expect(s.task).toBe(A);
      expect(s.user).toBe(false);
      expect(s.halted).toBe(false);
      expect(s.eip).toBe(0x110);
      expect(s.durMs).toBe(1);
    }
    const h = findAt(t, 2.5);
    expect(h.kind === "slice" && h.halted).toBe(true);
    expect(findAt(t, 4).kind).toBe("idle-gap");
    expect(findAt(t, 6.5).kind).toBe("overhead");
  });

  it("handles times before the data, after it, and an empty trace", () => {
    const t = scenario();
    expect(findAt(t, -1).kind).toBe("none");
    expect(findAt(mkTrace(), 1).kind).toBe("none");
    expect(findAt(t, 100).kind).toBe("overhead"); // last sample ended running
    const h = mkTrace();
    h.push(0, 1, 1, IDLE, 0x50, CPU_HALTED);
    expect(findAt(h, 50).kind).toBe("idle-gap");
  });
});
