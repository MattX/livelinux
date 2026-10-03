import { describe, expect, it } from "vitest";
import { eevdf, runqueue, type CfsInfo, type CfsTask } from "../src/debug/helpers";
import { allocObj, buildKernel, buildRbTree, type Kernel } from "./util/helperFakes";

const T = "struct task_struct";
const SE = "struct sched_entity";

function mk(k: Kernel, pid: number, comm: string, se: { vruntime: bigint; deadline: bigint; vlag: bigint; slice: bigint; onRq?: number; weight?: number }) {
  const p = k.prog;
  const t = allocObj(k, T);
  p.set(t, T, "pid", pid);
  p.set(t, T, "comm", comm);
  p.set(t, T, "se.vruntime", se.vruntime);
  p.set(t, T, "se.deadline", se.deadline);
  p.set(t, T, "se.vlag", se.vlag);
  p.set(t, T, "se.slice", se.slice);
  p.set(t, T, "se.on_rq", se.onRq ?? 1);
  p.set(t, T, "se.load.weight", se.weight ?? 1024);
  return t;
}

describe("runqueue", () => {
  it("summarizes the rq and the CFS tree, with curr appended", () => {
    const k = buildKernel();
    const p = k.prog;
    const rq = p.defineVar("runqueues", "struct rq");
    const a = mk(k, 10, "a", { vruntime: 1000n, deadline: 4000n, vlag: -5n, slice: 3000000n });
    const b = mk(k, 11, "b", { vruntime: 2000n, deadline: 5000n, vlag: 7n, slice: 3000000n });
    const c = mk(k, 12, "c", { vruntime: 3000n, deadline: 6000n, vlag: 0n, slice: 3000000n });
    const idle = mk(k, 0, "swapper", { vruntime: 0n, deadline: 0n, vlag: 0n, slice: 0n, onRq: 0 });
    const seOff = p.offsetOf(T, "se");
    const rnOff = p.offsetOf(SE, "run_node");
    const nodes = [a, b].map((t) => t + seOff + rnOff);
    const timeline = rq + p.offsetOf("struct rq", "cfs.tasks_timeline");
    buildRbTree(k, timeline, nodes);
    p.set(rq, "struct rq", "nr_running", 3);
    p.set(rq, "struct rq", "cfs.nr_running", 3);
    p.set(rq, "struct rq", "cfs.min_vruntime", 900n);
    p.set(rq, "struct rq", "cfs.curr", c + seOff);
    p.set(rq, "struct rq", "curr", c);
    p.set(rq, "struct rq", "idle", idle);
    p.set(rq, "struct rq", "clock", 0x1_2345_6789n);
    // avg_vruntime = sum((v - min) * w) = (100 + 1100) * 1024 ; avg_load = 2048
    p.set(rq, "struct rq", "cfs.avg_vruntime", BigInt(1200 * 1024));
    p.set(rq, "struct rq", "cfs.avg_load", 2048n);

    const r = runqueue(p);
    expect(r).toMatchObject({ addr: rq, nrRunning: 3, cfsNrRunning: 3, clock: 0x1_2345_6789n, currAddr: c, idleAddr: idle });
    expect(r.cfs.minVruntime).toBe(900n);
    expect(r.cfs.currAddr).toBe(c);
    expect(r.cfs.tasks.map((t) => [t.pid, t.comm, t.isCurr])).toEqual([[10, "a", false], [11, "b", false], [12, "c", true]]);
    expect(r.cfs.tasks[0]).toMatchObject({ addr: a, vruntime: 1000n, deadline: 4000n, vlag: -5n, slice: 3000000n, onRq: true, weight: 1024 });
    expect(r.cfs.tasks[1].vlag).toBe(7n);
    // curr (vruntime 3000, key 2100, w 1024) is included: (1228800 + 2150400) / 3072 = 1100
    expect(r.cfs.avgVruntimeRaw).toBe(BigInt(1200 * 1024));
    expect(r.cfs.avgVruntime).toBe(900n + 1100n);
  });

  it("empty runqueue with no curr", () => {
    const k = buildKernel();
    const rq = k.prog.defineVar("runqueues", "struct rq");
    const r = runqueue(k.prog);
    expect(r.addr).toBe(rq);
    expect(r.cfs.tasks).toEqual([]);
    expect(r.cfs.currAddr).toBe(0);
    expect(r.cfs.avgVruntime).toBe(0n);
  });

  it("marks curr in place when it is also in the tree, and tolerates missing fields", () => {
    const k = buildKernel();
    const p = k.prog;
    // strip optional fields from the BTF to emulate a different kernel
    const se = k.btf.find(SE)!;
    se.members = se.members!.filter((m) => !["deadline", "vlag", "slice", "sched_delayed"].includes(m.name));
    const cfs = k.btf.find("struct cfs_rq")!;
    cfs.members = cfs.members!.filter((m) => m.name !== "avg_vruntime" && m.name !== "avg_load");
    const rq = p.defineVar("runqueues", "struct rq");
    const t = allocObj(k, T);
    p.set(t, T, "pid", 3);
    p.set(t, T, "se.vruntime", 50n);
    p.set(t, T, "se.on_rq", 1);
    const node = t + p.offsetOf(T, "se") + p.offsetOf(SE, "run_node");
    buildRbTree(k, rq + p.offsetOf("struct rq", "cfs.tasks_timeline"), [node]);
    p.set(rq, "struct rq", "cfs.curr", t + p.offsetOf(T, "se"));
    const r = runqueue(p);
    expect(r.cfs.tasks).toHaveLength(1);
    expect(r.cfs.tasks[0]).toMatchObject({ pid: 3, vruntime: 50n, isCurr: true, deadline: undefined, vlag: undefined, slice: undefined });
    expect(r.cfs.avgVruntime).toBeUndefined();
  });
});

describe("eevdf", () => {
  const task = (pid: number, vruntime: bigint, deadline: bigint, o: Partial<CfsTask> = {}): CfsTask => ({
    addr: 0x1000 * pid, pid, comm: `t${pid}`, vruntime, deadline, vlag: 0n, slice: 3_000_000n, weight: 1024, onRq: true, isCurr: false, ...o,
  });
  // avg_vruntime raw sums (v - min) * w over queued entities (curr excluded).
  const cfs = (tasks: CfsTask[], min = 0n): CfsInfo => {
    const queued = tasks.filter((t) => !t.isCurr);
    const raw = queued.reduce((a, t) => a + (t.vruntime - min) * BigInt(t.weight!), 0n);
    const load = queued.reduce((a, t) => a + BigInt(t.weight!), 0n);
    const all = tasks.filter((t) => t.onRq);
    const avg = min + all.reduce((a, t) => a + (t.vruntime - min) * BigInt(t.weight!), 0n) / all.reduce((a, t) => a + BigInt(t.weight!), 0n);
    return {
      nrRunning: all.length, minVruntime: min, minVruntimeField: "min_vruntime", avgVruntimeRaw: raw, avgLoad: load,
      avgVruntime: avg, currAddr: tasks.find((t) => t.isCurr)?.addr ?? 0, tasks,
    };
  };

  it("picks the eligible task with the earliest deadline", () => {
    // V = 2000: t1 (v 1000) and t2 (v 2000) eligible, t3 (v 3000) not, despite the earliest deadline.
    const s = eevdf(cfs([task(1, 1000n, 9000n), task(2, 2000n, 5000n), task(3, 3000n, 4000n)]));
    expect(s.avg).toBe(2000n);
    expect(s.tasks.map((t) => [t.pid, t.lag, t.eligible])).toEqual([[1, 1000n, true], [2, 0n, true], [3, -1000n, false]]);
    expect(s.pick).toBe(0x2000);
  });

  it("keeps curr while its slice is protected (vlag == deadline), else compares it like the others", () => {
    const curr = task(1, 1500n, 8000n, { isCurr: true, vlag: 8000n });
    const s = eevdf(cfs([curr, task(2, 1000n, 4000n), task(3, 3500n, 5000n)]));
    expect(s.pick).toBe(0x1000);
    expect(s.reason).toMatch(/RUN_TO_PARITY/);
    const s2 = eevdf(cfs([{ ...curr, vlag: 0n }, task(2, 1000n, 4000n), task(3, 3500n, 5000n)]));
    expect(s2.pick).toBe(0x2000);
  });

  it("drops an ineligible curr and handles a single runnable task", () => {
    const s = eevdf(cfs([task(1, 5000n, 6000n, { isCurr: true }), task(2, 1000n, 9000n)]));
    expect(s.tasks.find((t) => t.pid === 1)!.eligible).toBe(false);
    expect(s.pick).toBe(0x2000);
    const one = eevdf(cfs([task(7, 5000n, 6000n, { isCurr: true })]));
    expect(one.pick).toBe(0x7000);
    expect(one.reason).toMatch(/only/);
  });
});
