import { describe, expect, it } from "vitest";
import {
  currentTask, decodeTaskState, findTask, forEachAllThreads, forEachTask, forEachThread, taskInfo,
} from "../src/debug/helpers";
import { allocObj, buildKernel, linkList, type Kernel } from "./util/helperFakes";

const T = "struct task_struct";

function mkTask(k: Kernel, f: { pid: number; tgid?: number; comm: string; state?: number; flags?: number; prio?: number; exit?: number; mm?: number; parent?: number }) {
  const t = allocObj(k, T);
  const p = k.prog;
  p.set(t, T, "pid", f.pid);
  p.set(t, T, "tgid", f.tgid ?? f.pid);
  p.set(t, T, "comm", f.comm);
  p.set(t, T, "__state", f.state ?? 0);
  p.set(t, T, "exit_state", f.exit ?? 0);
  p.set(t, T, "flags", f.flags ?? 0);
  p.set(t, T, "prio", f.prio ?? 120);
  p.set(t, T, "mm", f.mm ?? 0);
  p.set(t, T, "real_parent", f.parent ?? 0);
  return t;
}

function world() {
  const k = buildKernel();
  const p = k.prog;
  const initAddr = p.defineVar("init_task", T);
  p.set(initAddr, T, "pid", 0); p.set(initAddr, T, "tgid", 0); p.set(initAddr, T, "comm", "swapper");
  p.set(initAddr, T, "real_parent", initAddr);
  const initSig = allocObj(k, "struct signal_struct");
  p.set(initAddr, T, "signal", initSig);
  const off = (m: string) => p.offsetOf(T, m);
  linkList(k, initSig + p.offsetOf("struct signal_struct", "thread_head"), [initAddr + off("thread_node")]);

  const mm = 0xc3000000;
  const init1 = mkTask(k, { pid: 1, comm: "init", state: 1, mm, parent: initAddr });
  const t5 = mkTask(k, { pid: 5, tgid: 1, comm: "init-thr", state: 0, mm, parent: initAddr });
  const sig1 = allocObj(k, "struct signal_struct");
  p.set(init1, T, "signal", sig1); p.set(t5, T, "signal", sig1);
  linkList(k, sig1 + p.offsetOf("struct signal_struct", "thread_head"), [init1 + off("thread_node"), t5 + off("thread_node")]);

  const kt = mkTask(k, { pid: 2, comm: "kthreadd", state: 1, flags: 0x00200000, parent: initAddr });
  const sig2 = allocObj(k, "struct signal_struct");
  p.set(kt, T, "signal", sig2);
  linkList(k, sig2 + p.offsetOf("struct signal_struct", "thread_head"), [kt + off("thread_node")]);

  linkList(k, initAddr + off("tasks"), [init1 + off("tasks"), kt + off("tasks")]);
  const cur = p.defineVar("pcpu_hot", "struct pcpu_hot");
  p.set(cur, "struct pcpu_hot", "current_task", t5);
  return { k, initAddr, init1, t5, kt, cur, mm };
}

describe("task state decoding", () => {
  it("matches fs/proc/array.c", () => {
    expect(decodeTaskState(0).letter).toBe("R");
    expect(decodeTaskState(1).letter).toBe("S");
    expect(decodeTaskState(2).letter).toBe("D");
    expect(decodeTaskState(4).letter).toBe("T");
    expect(decodeTaskState(8).letter).toBe("t");
    expect(decodeTaskState(0x402).letter).toBe("I"); // TASK_IDLE
    expect(decodeTaskState(0x102).letter).toBe("D"); // TASK_KILLABLE (UNINTERRUPTIBLE|WAKEKILL)
    expect(decodeTaskState(0x1).name).toBe("sleeping");
    expect(decodeTaskState(0, 0x20).letter).toBe("Z");
    expect(decodeTaskState(0x40).letter).toBe("P");
    expect(decodeTaskState(0, 0x10).letter).toBe("X");
    expect(decodeTaskState(0x1002).letter).toBe("D"); // RTLOCK_WAIT treated as D
    expect(decodeTaskState(0x402 | 0x100).letter).toBe("I");
  });
});

describe("task helpers", () => {
  it("forEachTask yields init_task first, then the task list", () => {
    const w = world();
    const all = [...forEachTask(w.k.prog)].map((t) => t.addr);
    expect(all).toEqual([w.initAddr, w.init1, w.kt]);
  });

  it("forEachThread walks signal->thread_head including the leader", () => {
    const w = world();
    const threads = [...forEachThread(w.k.prog.value(w.init1, T))].map((t) => t.member("pid").num());
    expect(threads).toEqual([1, 5]);
    expect([...forEachAllThreads(w.k.prog)].map((t) => t.member("pid").num())).toEqual([0, 1, 5, 2]);
  });

  it("forEachThread falls back to the task when signal is NULL", () => {
    const w = world();
    w.k.prog.set(w.kt, T, "signal", 0);
    expect([...forEachThread(w.k.prog.value(w.kt, T))].map((t) => t.addr)).toEqual([w.kt]);
  });

  it("taskInfo", () => {
    const w = world();
    const i = taskInfo(w.k.prog.value(w.init1, T));
    expect(i).toMatchObject({
      addr: w.init1, pid: 1, tgid: 1, comm: "init", state: "S", stateName: "sleeping", stateRaw: 1,
      prio: 120, isKthread: false, mm: w.mm, ppid: 0,
    });
    const th = taskInfo(w.k.prog.value(w.t5, T));
    expect(th.pid).toBe(5);
    expect(th.tgid).toBe(1);
    expect(th.state).toBe("R");
    const kt = taskInfo(w.k.prog.value(w.kt, T));
    expect(kt.isKthread).toBe(true);
    expect(kt.mm).toBe(0);
    expect(kt.ppid).toBe(0);
  });

  it("taskInfo ppid via real_parent->tgid", () => {
    const w = world();
    const child = mkTask(w.k, { pid: 9, comm: "child", parent: w.init1 });
    expect(taskInfo(w.k.prog.value(child, T)).ppid).toBe(1);
  });

  it("currentTask uses pcpu_hot, falling back to runqueues.curr", () => {
    const w = world();
    expect(currentTask(w.k.prog).addr).toBe(w.t5);
    w.k.prog.set(w.cur, "struct pcpu_hot", "current_task", 0);
    const rq = w.k.prog.defineVar("runqueues", "struct rq");
    w.k.prog.set(rq, "struct rq", "curr", w.kt);
    expect(currentTask(w.k.prog).addr).toBe(w.kt);
  });

  it("findTask finds leaders and non-leader threads", () => {
    const w = world();
    expect(findTask(w.k.prog, 0)!.addr).toBe(w.initAddr);
    expect(findTask(w.k.prog, 2)!.addr).toBe(w.kt);
    expect(findTask(w.k.prog, 5)!.addr).toBe(w.t5);
    expect(findTask(w.k.prog, 999)).toBeUndefined();
  });
});
