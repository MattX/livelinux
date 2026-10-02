// Task helpers (drgn.helpers.linux.pid / sched style) for Linux 6.12, i386, UP.

import type { Program, Value } from "../api";
import { listForEachEntry } from "./list";
import { asObject, tryGet, WalkOpts } from "./util";

export const PF_KTHREAD = 0x00200000;

// task->__state / exit_state bits (include/linux/sched.h)
export const TASK_RUNNING = 0x0000;
export const TASK_INTERRUPTIBLE = 0x0001;
export const TASK_UNINTERRUPTIBLE = 0x0002;
export const __TASK_STOPPED = 0x0004;
export const __TASK_TRACED = 0x0008;
export const EXIT_DEAD = 0x0010;
export const EXIT_ZOMBIE = 0x0020;
export const TASK_PARKED = 0x0040;
export const TASK_DEAD = 0x0080;
export const TASK_NOLOAD = 0x0400;
export const TASK_RTLOCK_WAIT = 0x1000;
export const TASK_IDLE = TASK_UNINTERRUPTIBLE | TASK_NOLOAD;
const TASK_REPORT = TASK_RUNNING | TASK_INTERRUPTIBLE | TASK_UNINTERRUPTIBLE | __TASK_STOPPED |
  __TASK_TRACED | EXIT_DEAD | EXIT_ZOMBIE | TASK_PARKED; // 0x7f
const TASK_REPORT_IDLE = TASK_REPORT + 1; // 0x80

/** fs/proc/array.c task_state_array */
const TASK_STATE_ARRAY: ReadonlyArray<readonly [string, string]> = [
  ["R", "running"],
  ["S", "sleeping"],
  ["D", "disk sleep"],
  ["T", "stopped"],
  ["t", "tracing stop"],
  ["X", "dead"],
  ["Z", "zombie"],
  ["P", "parked"],
  ["I", "idle"],
];

function fls(x: number): number {
  return x === 0 ? 0 : 32 - Math.clz32(x);
}

/** __task_state_index() */
export function taskStateIndex(state: number, exitState: number): number {
  let s = ((state | exitState) & TASK_REPORT) >>> 0;
  if ((state & TASK_IDLE) === TASK_IDLE) s = TASK_REPORT_IDLE;
  if (state & TASK_RTLOCK_WAIT) s = TASK_UNINTERRUPTIBLE;
  return fls(s);
}

/** State letter (R, S, D, T, t, X, Z, P, I) and long name for raw __state / exit_state. */
export function decodeTaskState(state: number, exitState = 0): { letter: string; name: string } {
  const e = TASK_STATE_ARRAY[taskStateIndex(state, exitState)] ?? ["?", "unknown"];
  return { letter: e[0], name: e[1] };
}

export interface TaskInfo {
  /** Address of the task_struct. */
  addr: number;
  pid: number;
  tgid: number;
  comm: string;
  /** State letter, e.g. "R". */
  state: string;
  /** Long state name, e.g. "running". */
  stateName: string;
  /** Raw task->__state. */
  stateRaw: number;
  exitState: number;
  flags: number;
  prio: number;
  isKthread: boolean;
  /** task->mm pointer (0 for kernel threads). */
  mm: number;
  /** real_parent->tgid (0 if unavailable). */
  ppid: number;
}

/** Iterate every thread-group leader: init_task (swapper, pid 0) first, then init_task.tasks. */
export function* forEachTask(prog: Program, opts: WalkOpts = {}): Generator<Value> {
  const init = prog.var("init_task");
  yield init;
  yield* listForEachEntry(init.member("tasks"), "struct task_struct", "tasks", opts);
}

/**
 * Iterate the threads of `task`'s thread group (including the leader) through
 * signal->thread_head / task->thread_node. Falls back to just `task` if the
 * thread list is unavailable.
 */
export function* forEachThread(task: Value, opts: WalkOpts = {}): Generator<Value> {
  const t = asObject(task);
  const sig = tryGet(() => t.member("signal"));
  if (!sig || sig.isNull()) {
    yield t;
    return;
  }
  const head = sig.deref().member("thread_head");
  let any = false;
  for (const th of listForEachEntry(head, "struct task_struct", "thread_node", opts)) {
    any = true;
    yield th;
  }
  if (!any) yield t;
}

/** Iterate every thread of every process (leaders then their threads). */
export function* forEachAllThreads(prog: Program, opts: WalkOpts = {}): Generator<Value> {
  for (const leader of forEachTask(prog, opts)) yield* forEachThread(leader, opts);
}

export function taskInfo(task: Value): TaskInfo {
  const t = asObject(task);
  const stateRaw = tryGet(() => t.member("__state").num()) ?? tryGet(() => t.member("state").num()) ?? 0;
  const exitState = tryGet(() => t.member("exit_state").num()) ?? 0;
  const st = decodeTaskState(stateRaw, exitState);
  const flags = t.member("flags").num();
  const ppid = tryGet(() => {
    const p = t.member("real_parent");
    return p.isNull() ? 0 : p.deref().member("tgid").num();
  }) ?? 0;
  return {
    addr: t.addr,
    pid: t.member("pid").num() | 0,
    tgid: t.member("tgid").num() | 0,
    comm: t.member("comm").cstr(16),
    state: st.letter,
    stateName: st.name,
    stateRaw,
    exitState,
    flags,
    prio: t.member("prio").num() | 0,
    isKthread: (flags & PF_KTHREAD) !== 0,
    mm: t.member("mm").ptr(),
    ppid,
  };
}

/**
 * The task running on the (only) CPU. On x86 6.12 UP, `pcpu_hot` is a plain global
 * struct; falls back to `runqueues.curr`.
 */
export function currentTask(prog: Program): Value {
  const viaPcpu = tryGet(() => {
    const p = prog.var("pcpu_hot").member("current_task");
    return p.isNull() ? undefined : p.deref();
  });
  if (viaPcpu) return viaPcpu;
  return prog.var("runqueues").member("curr").deref();
}

/** Find a task by pid (thread id). Searches leaders first, then all threads. Undefined if absent. */
export function findTask(prog: Program, pid: number, opts: WalkOpts = {}): Value | undefined {
  for (const t of forEachTask(prog, opts)) {
    if ((t.member("pid").num() | 0) === pid) return t;
  }
  for (const t of forEachAllThreads(prog, opts)) {
    if ((t.member("pid").num() | 0) === pid) return t;
  }
  return undefined;
}
