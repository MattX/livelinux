// Runqueue / CFS (EEVDF) helpers for Linux 6.12 UP with CONFIG_CGROUP_SCHED=n
// (every sched_entity on the tree is embedded in a task_struct).

import type { Program, Value } from "../api";
import { rbInorder } from "./rbtree";
import { asObject, big, s64, tryGet, WalkOpts } from "./util";

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
  minVruntime: bigint;
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
  const minVruntime = big(cfs.member("min_vruntime"));
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
