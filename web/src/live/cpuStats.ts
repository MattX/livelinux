// Pure aggregation helpers over a CpuTrace (no DOM): time accounting for a window, per-task shares,
// a statistical kernel profile, and per-pixel-column reduction for the timeline.
//
// Time model: sample i covers [tStart, tEnd] (the guest ran). The gap between sample i's tEnd and
// sample i+1's tStart is guest idle time when sample i ended halted (v86 sleeps until the next
// timer), otherwise emulator overhead (nobody is accounted for it).

import { CPU_HALTED, CPU_USER, type CpuTrace } from "./cputrace";

/** What the symbolizer must offer (structurally satisfied by Program["symbols"]). */
export interface SymbolLookup {
  lookup(addr: number): { sym: { name: string }; offset: number } | undefined;
}

/** Segment kinds produced by forEachSegment. */
export const SEG_BUSY = 0; // a slice that ended not-halted
export const SEG_HALT = 1; // a slice that ended halted
export const SEG_GAP = 2; // idle gap after a halted slice

export type SegKind = typeof SEG_BUSY | typeof SEG_HALT | typeof SEG_GAP;

/** Column sentinels in buildColumns().task. */
export const COL_NONE = -2;
export const COL_IDLE = -1;
/** Mode codes in buildColumns().mode. */
export const MODE_NONE = 0;
export const MODE_USER = 1;
export const MODE_KERNEL = 2;
export const MODE_IDLE = 3;

export interface TaskLabel {
  pid: number;
  comm: string;
}

export function taskLabel(trace: CpuTrace, addr: number): TaskLabel {
  const t = trace.tasks.get(addr);
  if (t) return t;
  return { pid: -1, comm: addr ? `task@${addr.toString(16)}` : "?" }; // unknown key (hand-filled traces)
}

/** Stable per-pid colour that reads on both light and dark backgrounds. */
export function taskColor(pid: number): string {
  if (pid < 0) return "hsl(220 8% 55%)";
  if (pid === 0) return "hsl(220 10% 46%)";
  const hue = Math.round((pid * 137.508) % 360);
  return `hsl(${hue} 62% 54%)`;
}

/** Logical index (0 = oldest) of the first sample with tEnd >= t; `count` if none. */
export function lowerBound(trace: CpuTrace, t: number): number {
  let lo = 0;
  let hi = trace.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trace.tEnd[trace.index(mid)] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** tEnd of the newest sample (0 if empty). */
export function latestTime(trace: CpuTrace): number {
  return trace.count ? trace.tEnd[trace.index(trace.count - 1)] : 0;
}

/** Start of the usable window ending at `to`: never earlier than the oldest recorded sample. */
export function windowStart(trace: CpuTrace, to: number, windowMs: number): number {
  const from = to - windowMs;
  return trace.count ? Math.max(from, trace.tStart[trace.index(0)]) : from;
}

/**
 * Calls cb for each accounted time segment within [from, to], oldest first, clipped to the window.
 * `i` is the ring index of the sample the segment belongs to. Emulator-overhead gaps are not emitted.
 */
export function forEachSegment(
  trace: CpuTrace,
  from: number,
  to: number,
  cb: (start: number, end: number, kind: SegKind, i: number) => void,
): void {
  const n = trace.count;
  if (!n || to <= from) return;
  // start one sample early: its trailing idle gap may reach into the window
  for (let k = Math.max(0, lowerBound(trace, from) - 1); k < n; k++) {
    const i = trace.index(k);
    const ts = trace.tStart[i];
    const te = trace.tEnd[i];
    if (ts >= to) break;
    const halted = (trace.flags[i] & CPU_HALTED) !== 0;
    const s = Math.max(ts, from);
    const e = Math.min(te, to);
    if (e > s) cb(s, e, halted ? SEG_HALT : SEG_BUSY, i);
    if (halted) {
      const gs = Math.max(te, from);
      const gNext = k + 1 < n ? trace.tStart[trace.index(k + 1)] : to;
      const ge = Math.min(gNext, to);
      if (ge > gs) cb(gs, ge, SEG_GAP, i);
    }
  }
}

export interface TaskShare {
  addr: number;
  pid: number;
  comm: string;
  ms: number;
  /** fraction of the window's wall time */
  share: number;
}

export interface FuncShare {
  name: string;
  ms: number;
  samples: number;
  /** fraction of non-halted kernel time */
  share: number;
}

export interface CpuStats {
  from: number;
  to: number;
  /** Effective window length (clamped to the data actually recorded). */
  spanMs: number;
  userMs: number;
  kernelMs: number;
  /** Halted slices + idle gaps after them. */
  idleMs: number;
  /** Wall time in which the guest was neither running nor idle (emulator work). */
  overheadMs: number;
  user: number;
  kernel: number;
  idle: number;
  overhead: number;
  slices: number;
  instrs: number;
  slicesPerSec: number;
  /** Guest millions of instructions per wall-clock second (idle time included in the divisor). */
  mips: number;
  /** Top tasks by on-CPU time (not halted), descending. */
  tasks: TaskShare[];
  /** Number of distinct tasks that ran in the window. */
  taskCount: number;
  /** Top kernel functions by time, from the EIP at the end of non-halted kernel-mode slices. */
  funcs: FuncShare[];
  kernelBusyMs: number;
  kernelSamples: number;
}

export interface StatsOptions {
  topTasks?: number;
  topFuncs?: number;
}

export function computeStats(
  trace: CpuTrace,
  to: number,
  windowMs: number,
  symbols?: SymbolLookup,
  opts: StatsOptions = {},
): CpuStats {
  const topTasks = opts.topTasks ?? 10;
  const topFuncs = opts.topFuncs ?? 15;
  const from = windowStart(trace, to, windowMs);
  const span = trace.count ? Math.max(0, to - from) : 0;

  let userMs = 0;
  let kernelMs = 0;
  let idleMs = 0;
  let slices = 0;
  let instrs = 0;
  let kernelBusyMs = 0;
  let kernelSamples = 0;
  const perTask = new Map<number, number>();
  const perFunc = new Map<string, { ms: number; n: number }>();

  forEachSegment(trace, from, to, (s, e, kind, i) => {
    const dur = e - s;
    if (kind === SEG_GAP) {
      idleMs += dur;
      return;
    }
    slices++;
    const full = trace.tEnd[i] - trace.tStart[i];
    instrs += full > 0 ? trace.instrs[i] * (dur / full) : trace.instrs[i];
    if (kind === SEG_HALT) {
      idleMs += dur;
      return;
    }
    const user = (trace.flags[i] & CPU_USER) !== 0;
    const task = trace.task[i];
    perTask.set(task, (perTask.get(task) ?? 0) + dur);
    if (user) {
      userMs += dur;
    } else {
      kernelMs += dur;
      kernelBusyMs += dur;
      kernelSamples++;
      const name = symbols?.lookup(trace.eip[i])?.sym.name ?? "(unknown)";
      const f = perFunc.get(name);
      if (f) {
        f.ms += dur;
        f.n++;
      } else {
        perFunc.set(name, { ms: dur, n: 1 });
      }
    }
  });

  const frac = (ms: number) => (span > 0 ? ms / span : 0);
  const overheadMs = Math.max(0, span - userMs - kernelMs - idleMs);

  const tasks: TaskShare[] = [];
  for (const [addr, ms] of perTask) {
    const l = taskLabel(trace, addr);
    tasks.push({ addr, pid: l.pid, comm: l.comm, ms, share: frac(ms) });
  }
  tasks.sort((a, b) => b.ms - a.ms || a.pid - b.pid);

  const funcs: FuncShare[] = [];
  for (const [name, f] of perFunc) {
    funcs.push({ name, ms: f.ms, samples: f.n, share: kernelBusyMs > 0 ? f.ms / kernelBusyMs : 0 });
  }
  funcs.sort((a, b) => b.ms - a.ms || (a.name < b.name ? -1 : 1));

  const sec = span / 1000;
  return {
    from,
    to,
    spanMs: span,
    userMs,
    kernelMs,
    idleMs,
    overheadMs,
    user: frac(userMs),
    kernel: frac(kernelMs),
    idle: frac(idleMs),
    overhead: frac(overheadMs),
    slices,
    instrs,
    slicesPerSec: sec > 0 ? slices / sec : 0,
    mips: sec > 0 ? instrs / sec / 1e6 : 0,
    tasks: tasks.slice(0, topTasks),
    taskCount: tasks.length,
    funcs: funcs.slice(0, topFuncs),
    kernelBusyMs,
    kernelSamples,
  };
}

export interface Columns {
  /** Per column: task_struct address of the task with most time, COL_IDLE, or COL_NONE (no data). */
  task: Float64Array;
  /** Per column: MODE_* with most time. */
  mode: Uint8Array;
}

/**
 * Reduce [from, to] to `cols` equal-width columns. Each column takes the task / mode that held the
 * CPU longest within it (emulator-overhead gaps are ignored, so a column is only COL_NONE when
 * nothing at all was recorded in it).
 */
export function buildColumns(trace: CpuTrace, from: number, to: number, cols: number): Columns {
  const task = new Float64Array(cols).fill(COL_NONE);
  const mode = new Uint8Array(cols);
  if (cols <= 0 || to <= from) return { task, mode };
  const colDur = (to - from) / cols;
  const acc = new Map<number, number>();
  const m = [0, 0, 0, 0];
  let cur = -1;

  const flush = () => {
    if (cur < 0) return;
    let bestKey = COL_NONE;
    let best = 0;
    for (const [k, v] of acc) {
      if (v > best || (v === best && k < bestKey)) {
        best = v;
        bestKey = k;
      }
    }
    task[cur] = bestKey;
    let bm = MODE_NONE;
    let bt = 0;
    for (let j = 1; j <= 3; j++) {
      if (m[j] > bt) {
        bt = m[j];
        bm = j;
      }
    }
    mode[cur] = bm;
    acc.clear();
    m[1] = m[2] = m[3] = 0;
  };

  forEachSegment(trace, from, to, (s, e, kind, i) => {
    let key: number;
    let md: number;
    if (kind === SEG_BUSY) {
      key = trace.task[i];
      md = trace.flags[i] & CPU_USER ? MODE_USER : MODE_KERNEL;
    } else {
      key = COL_IDLE;
      md = MODE_IDLE;
    }
    const c0 = Math.min(cols - 1, Math.max(0, Math.floor((s - from) / colDur)));
    const c1 = Math.min(cols - 1, Math.max(0, Math.floor((e - from) / colDur - 1e-9)));
    for (let c = c0; c <= c1; c++) {
      if (c !== cur) {
        flush();
        cur = c;
      }
      const cs = from + c * colDur;
      const ov = Math.min(e, cs + colDur) - Math.max(s, cs);
      if (ov <= 0) continue;
      acc.set(key, (acc.get(key) ?? 0) + ov);
      m[md] += ov;
    }
  });
  flush();
  return { task, mode };
}

export type PointInfo =
  | { kind: "none" }
  | { kind: "overhead" }
  | { kind: "idle-gap" }
  | {
      kind: "slice";
      i: number;
      task: number;
      halted: boolean;
      user: boolean;
      eip: number;
      instrs: number;
      durMs: number;
    };

/** What was happening at time `t`. */
export function findAt(trace: CpuTrace, t: number): PointInfo {
  const n = trace.count;
  if (!n) return { kind: "none" };
  const k = lowerBound(trace, t);
  if (k < n) {
    const i = trace.index(k);
    if (trace.tStart[i] <= t) {
      const flags = trace.flags[i];
      return {
        kind: "slice",
        i,
        task: trace.task[i],
        halted: (flags & CPU_HALTED) !== 0,
        user: (flags & CPU_USER) !== 0,
        eip: trace.eip[i],
        instrs: trace.instrs[i],
        durMs: trace.tEnd[i] - trace.tStart[i],
      };
    }
    if (k === 0) return { kind: "none" };
  }
  const prev = trace.index(k - 1);
  return (trace.flags[prev] & CPU_HALTED) !== 0 ? { kind: "idle-gap" } : { kind: "overhead" };
}
