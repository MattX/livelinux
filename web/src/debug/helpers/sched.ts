// Runqueue / CFS (EEVDF) helpers for Linux 6.12 UP with CONFIG_CGROUP_SCHED=n
// (every sched_entity on the tree is embedded in a task_struct).

import type { Program, Value } from "../api";
import { rbInorder } from "./rbtree";
import { asObject, big, s64, tryGet, WalkOpts, hasMember } from "./util";

export interface CfsTask {
  /** task_struct address. */
  addr: number;
  pid: number;
  comm: string;
  vruntime: bigint;
  deadline?: bigint;
  vlag?: bigint;
  slice?: bigint;
  /** se.load.weight */
  weight?: number;
  /** sched_entity.on_rq */
  onRq: boolean;
  /** sched_entity.sched_delayed (6.12 delayed dequeue) */
  schedDelayed?: boolean;
  /** True for cfs_rq->curr (not in the rb tree while running). */
  isCurr: boolean;
}

export interface CfsInfo {
  nrRunning: number;
  /** cfs_rq->min_vruntime, or cfs_rq->zero_vruntime on kernels that renamed it (see minVruntimeField). */
  minVruntime: bigint;
  minVruntimeField: "min_vruntime" | "zero_vruntime";
  /** Raw cfs_rq->avg_vruntime (sum of key*weight), if present. */
  avgVruntimeRaw?: bigint;
  avgLoad?: bigint;
  /** Weighted average vruntime as the kernel computes it (avg_vruntime()), if fields present. */
  avgVruntime?: bigint;
  currAddr: number;
  /** Tree entries in in-order (ascending vruntime key / deadline tree order); curr appended last if not in the tree. */
  tasks: CfsTask[];
}

export interface RunqueueInfo {
  addr: number;
  nrRunning: number;
  cfsNrRunning: number;
  clock: bigint;
  currAddr: number;
  idleAddr: number;
  cfs: CfsInfo;
}

function cfsTask(prog: Program, se: Value, isCurr: boolean): CfsTask {
  const task = prog.containerOf(se.addr, "struct task_struct", "se");
  return {
    addr: task.addr,
    pid: task.member("pid").num() | 0,
    comm: tryGet(() => task.member("comm").cstr(16)) ?? "",
    vruntime: big(se.member("vruntime")),
    deadline: tryGet(() => big(se.member("deadline"))),
    vlag: tryGet(() => s64(se.member("vlag"))),
    slice: tryGet(() => big(se.member("slice"))),
    weight: tryGet(() => se.member("load.weight").num()),
    onRq: se.member("on_rq").num() !== 0,
    schedDelayed: tryGet(() => se.member("sched_delayed").num() !== 0),
    isCurr,
  };
}

/** Kernel's avg_vruntime(): min_vruntime + weighted average key (including curr if on_rq). */
function computeAvgVruntime(
  min: bigint,
  rawAvg: bigint,
  rawLoad: bigint,
  curr: { vruntime: bigint; weight: number } | undefined,
): bigint {
  let avg = rawAvg;
  let load = rawLoad;
  if (curr) {
    const w = BigInt(curr.weight);
    const key = BigInt.asIntN(64, curr.vruntime - min);
    avg += key * w;
    load += w;
  }
  if (load > 0n) {
    if (avg < 0n) avg -= load - 1n;
    avg = avg / load; // BigInt division truncates toward zero, like div_s64
  }
  return BigInt.asUintN(64, min + avg);
}

/** Describe a cfs_rq (struct cfs_rq or pointer to one). */
export function cfsRq(cfsRqV: Value, opts: WalkOpts = {}): CfsInfo {
  const cfs = asObject(cfsRqV);
  const prog = cfs.prog;
  const minVruntimeField = hasMember(prog, "struct cfs_rq", "zero_vruntime") ? "zero_vruntime" : "min_vruntime";
  const minVruntime = big(cfs.member(minVruntimeField));
  const tasks: CfsTask[] = [];
  for (const node of rbInorder(cfs.member("tasks_timeline"), opts)) {
    const se = prog.containerOf(node, "struct sched_entity", "run_node");
    tasks.push(cfsTask(prog, se, false));
  }
  const currPtr = cfs.member("curr").ptr();
  let currTask: CfsTask | undefined;
  if (currPtr !== 0) {
    const se = prog.value(currPtr, "struct sched_entity");
    const existing = tasks.find((t) => t.addr === prog.containerOf(se.addr, "struct task_struct", "se").addr);
    if (existing) existing.isCurr = true;
    else {
      currTask = cfsTask(prog, se, true);
      tasks.push(currTask);
    }
  }
  const rawAvg = tryGet(() => s64(cfs.member("avg_vruntime")));
  const avgLoad = tryGet(() => big(cfs.member("avg_load")));
  let avgVruntime: bigint | undefined;
  if (rawAvg !== undefined && avgLoad !== undefined) {
    const c = tasks.find((t) => t.isCurr && t.onRq && t.weight !== undefined);
    avgVruntime = computeAvgVruntime(
      minVruntime,
      rawAvg,
      avgLoad,
      c ? { vruntime: c.vruntime, weight: c.weight as number } : undefined,
    );
  }
  return {
    nrRunning: cfs.member("nr_running").num(),
    minVruntime,
    minVruntimeField,
    avgVruntimeRaw: rawAvg,
    avgLoad,
    avgVruntime,
    currAddr: currPtr === 0 ? 0 : prog.containerOf(currPtr, "struct task_struct", "se").addr,
    tasks,
  };
}

/** Summarize the (single, UP) runqueue: `runqueues` is a plain global struct rq. */
export function runqueue(prog: Program, opts: WalkOpts = {}): RunqueueInfo {
  const rq = prog.var("runqueues");
  const cfs = cfsRq(rq.member("cfs"), opts);
  return {
    addr: rq.addr,
    nrRunning: rq.member("nr_running").num(),
    cfsNrRunning: cfs.nrRunning,
    clock: big(rq.member("clock")),
    currAddr: rq.member("curr").ptr(),
    idleAddr: rq.member("idle").ptr(),
    cfs,
  };
}

export interface EevdfTask extends CfsTask {
  /** Lag in virtual time: avg_vruntime - vruntime (positive = owed CPU time). */
  lag: bigint;
  /** entity_eligible(): the kernel's exact weighted test, lag >= 0 up to rounding. */
  eligible: boolean;
}

export interface EevdfState {
  /** avg_vruntime(cfs_rq), the zero-lag point V. Falls back to min_vruntime if unavailable. */
  avg: bigint;
  tasks: EevdfTask[];
  /** task_struct address pick_eevdf() would return now (0 if none). */
  pick: number;
  /** Why that task: shown to the user. */
  reason: string;
}

/**
 * Lag, eligibility and the next pick, following pick_eevdf() in kernel/sched/fair.c (6.12): the
 * eligible entity with the earliest virtual deadline, except that curr keeps the CPU while its
 * slice is protected (RUN_TO_PARITY, on by default: set_next_entity() stores deadline in vlag).
 */
export function eevdf(cfs: CfsInfo): EevdfState {
  const min = cfs.minVruntime;
  const curr = cfs.tasks.find((t) => t.isCurr);
  // vruntime_eligible(): avg >= (v - min) * load, with curr's contribution added when on_rq.
  let avgRaw = cfs.avgVruntimeRaw;
  let load = cfs.avgLoad;
  if (avgRaw !== undefined && load !== undefined && curr?.onRq && curr.weight !== undefined) {
    const w = BigInt(curr.weight);
    avgRaw += BigInt.asIntN(64, curr.vruntime - min) * w;
    load += w;
  }
  const avg = cfs.avgVruntime ?? min;
  const eligible = (v: bigint): boolean => {
    if (avgRaw === undefined || load === undefined || load === 0n) return BigInt.asIntN(64, v - avg) <= 0n;
    return avgRaw >= BigInt.asIntN(64, v - min) * load;
  };
  const tasks: EevdfTask[] = cfs.tasks.map((t) => ({
    ...t,
    lag: BigInt.asIntN(64, avg - t.vruntime),
    eligible: t.onRq && eligible(t.vruntime),
  }));
  const before = (a: EevdfTask, b: EevdfTask) => BigInt.asIntN(64, (a.deadline ?? a.vruntime) - (b.deadline ?? b.vruntime)) < 0n;
  const queued = tasks.filter((t) => !t.isCurr && t.onRq);
  const cur = tasks.find((t) => t.isCurr);

  const done = (t: EevdfTask | undefined, reason: string): EevdfState => ({ avg, tasks, pick: t?.addr ?? 0, reason });
  if (cfs.nrRunning === 1) {
    return cur?.onRq ? done(cur, "only runnable task") : done(queued[0], "only runnable task");
  }
  const c = cur && cur.onRq && cur.eligible ? cur : undefined;
  if (c && c.vlag !== undefined && c.deadline !== undefined && BigInt.asUintN(64, c.vlag) === c.deadline) {
    return done(c, "running task keeps the CPU until its slice ends (RUN_TO_PARITY)");
  }
  let best: EevdfTask | undefined;
  for (const t of queued) if (t.eligible && (!best || before(t, best))) best = t;
  if (!best || (c && before(c, best))) best = c;
  if (!best) return done(undefined, "no eligible task");
  return done(best, best.schedDelayed
    ? "earliest eligible deadline, but delayed-dequeue: it will be dequeued instead of run"
    : "eligible (lag ≥ 0) with the earliest virtual deadline");
}
