import { describe, expect, it } from "vitest";
import { hlistForEachEntry, listForEach, listForEachEntry } from "../src/debug/helpers";
import { allocObj, buildKernel } from "./util/helperFakes";

function makeList(n: number) {
  const k = buildKernel();
  const { prog } = k;
  const head = allocObj(k, "struct list_head");
  const tasks: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = allocObj(k, "struct task_struct");
    prog.set(t, "struct task_struct", "pid", 100 + i);
    tasks.push(t);
  }
  // link head -> t0.tasks -> t1.tasks ... -> head
  const nodes = tasks.map((t) => t + prog.offsetOf("struct task_struct", "tasks"));
  const chain = [head, ...nodes, head];
  for (let i = 0; i < chain.length - 1; i++) {
    prog.set(chain[i], "struct list_head", "next", chain[i + 1]);
    prog.set(chain[i + 1], "struct list_head", "prev", chain[i]);
  }
  if (n === 0) prog.set(head, "struct list_head", "next", head);
  return { k, head, tasks, nodes };
}

describe("list helpers", () => {
  it("walks an empty list", () => {
    const { k, head } = makeList(0);
    expect([...listForEach(k.prog.value(head, "struct list_head"))]).toEqual([]);
  });

  it("yields node addresses and entries in order", () => {
    const { k, head, tasks, nodes } = makeList(5);
    const h = k.prog.value(head, "struct list_head");
    expect([...listForEach(h)]).toEqual(nodes);
    const entries = [...listForEachEntry(h, "struct task_struct", "tasks")];
    expect(entries.map((e) => e.addr)).toEqual(tasks);
    expect(entries.map((e) => e.member("pid").num())).toEqual([100, 101, 102, 103, 104]);
  });

  it("accepts a pointer to a list head", () => {
    const { k, head, nodes } = makeList(2);
    const holder = k.mem.alloc(4);
    k.prog.set(holder, "struct hlist_head", "first", head); // reuse a ptr-sized slot
    const ptrToHead = k.prog.value(holder, "struct list_head *");
    expect([...listForEach(ptrToHead)]).toEqual(nodes);
  });

  it("stops at a cycle that does not include the head", () => {
    const { k, head, nodes } = makeList(3);
    k.prog.set(nodes[2], "struct list_head", "next", nodes[1]);
    const errs: string[] = [];
    const out = [...listForEach(k.prog.value(head, "struct list_head"), { onError: (r) => errs.push(r) })];
    expect(out).toEqual(nodes);
    expect(errs).toEqual(["list cycle"]);
  });

  it("stops at NULL pointers and unmapped nodes", () => {
    const a = makeList(3);
    a.k.prog.set(a.nodes[1], "struct list_head", "next", 0);
    const errs: string[] = [];
    expect([...listForEach(a.k.prog.value(a.head, "struct list_head"), { onError: (r) => errs.push(r) })]).toEqual(a.nodes.slice(0, 2));
    expect(errs).toEqual(["null list pointer"]);

    const b = makeList(3);
    b.k.prog.set(b.nodes[0], "struct list_head", "next", 0x10000000);
    const errs2: string[] = [];
    // the unmapped node is yielded (its address is known) but cannot be followed
    expect([...listForEach(b.k.prog.value(b.head, "struct list_head"), { onError: (r) => errs2.push(r) })]).toEqual([b.nodes[0], 0x10000000]);
    expect(errs2).toEqual(["unreadable list node"]);
  });

  it("honors the max count", () => {
    const { k, head } = makeList(10);
    const errs: string[] = [];
    const out = [...listForEach(k.prog.value(head, "struct list_head"), { max: 4, onError: (r) => errs.push(r) })];
    expect(out.length).toBe(4);
    expect(errs).toEqual(["list too long"]);
  });

  it("walks hlists", () => {
    const k = buildKernel();
    const { prog } = k;
    const head = allocObj(k, "struct hlist_head");
    const tasks = [0, 1, 2].map(() => allocObj(k, "struct task_struct"));
    const off = prog.offsetOf("struct task_struct", "tasks"); // use list_head as a stand-in node (next at 0)
    prog.set(head, "struct hlist_head", "first", tasks[0] + off);
    prog.set(tasks[0] + off, "struct hlist_node", "next", tasks[1] + off);
    prog.set(tasks[1] + off, "struct hlist_node", "next", tasks[2] + off);
    tasks.forEach((t, i) => prog.set(t, "struct task_struct", "pid", i + 1));
    const out = [...hlistForEachEntry(prog.value(head, "struct hlist_head"), "struct task_struct", "tasks")];
    expect(out.map((v) => v.member("pid").num())).toEqual([1, 2, 3]);
  });
});
