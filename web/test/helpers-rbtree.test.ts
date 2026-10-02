import { describe, expect, it } from "vitest";
import { rbFirst, rbFirstCached, rbInorder, rbNext, rbParent, rbRootNode } from "../src/debug/helpers";
import { allocObj, buildKernel, buildRbTree } from "./util/helperFakes";

function setup(n: number, cached = false) {
  const k = buildKernel();
  const root = allocObj(k, cached ? "struct rb_root_cached" : "struct rb_root");
  const nodes = Array.from({ length: n }, () => allocObj(k, "struct rb_node"));
  const rootNode = buildRbTree(k, root, nodes);
  if (cached && n) k.prog.set(root, "struct rb_root_cached", "rb_leftmost", nodes[0]);
  const rootV = k.prog.value(root, cached ? "struct rb_root_cached" : "struct rb_root");
  return { k, root, nodes, rootNode, rootV };
}

describe("rbtree helpers", () => {
  for (const n of [0, 1, 2, 3, 7, 50, 333]) {
    it(`in-order traversal of ${n} nodes (rb_root)`, () => {
      const { nodes, rootV } = setup(n);
      expect([...rbInorder(rootV)]).toEqual(nodes);
    });
  }

  it("accepts rb_root_cached and pointers", () => {
    const { k, root, nodes, rootV } = setup(9, true);
    expect([...rbInorder(rootV)]).toEqual(nodes);
    expect(rbFirst(rootV)).toBe(nodes[0]);
    expect(rbFirstCached(rootV)).toBe(nodes[0]);
    const holder = k.mem.alloc(4);
    k.mem.writeUint(holder, 4, root);
    expect([...rbInorder(k.prog.value(holder, "struct rb_root_cached *"))]).toEqual(nodes);
  });

  it("rbFirst on empty tree is 0; rbRootNode", () => {
    const e = setup(0);
    expect(rbFirst(e.rootV)).toBe(0);
    expect(rbRootNode(e.rootV)).toBe(0);
    const t = setup(5);
    expect(rbRootNode(t.rootV)).toBe(t.rootNode);
  });

  it("rbParent strips color bits", () => {
    const { k, nodes, rootNode } = setup(5);
    const child = nodes.find((x) => x !== rootNode)!;
    const parentOff = k.prog.offsetOf("struct rb_node", "__rb_parent_color");
    const parent = (k.prog.value(child, "struct rb_node").member("__rb_parent_color").num() & ~3) >>> 0;
    k.mem.writeUint(child + parentOff, 4, parent | 1); // red/black bit
    expect(rbParent(k.prog.value(child, "struct rb_node"))).toBe(parent);
    expect(rbParent(child, k.prog)).toBe(parent);
    expect(rbParent(k.prog.value(rootNode, "struct rb_node"))).toBe(0);
  });

  it("rbNext follows parent pointers in order", () => {
    const { k, nodes } = setup(40);
    const seq: number[] = [nodes[0]];
    for (;;) {
      const nx = rbNext(k.prog, seq[seq.length - 1]);
      if (!nx) break;
      seq.push(nx);
    }
    expect(seq).toEqual(nodes);
  });

  it("guards against cycles and size limits", () => {
    const { k, nodes, rootV } = setup(7);
    // make the leftmost-descendant point back to the root
    const rootNode = rbRootNode(rootV);
    const leaf = nodes[0];
    k.prog.set(leaf, "struct rb_node", "rb_left", rootNode);
    const errs: string[] = [];
    const out = [...rbInorder(rootV, { onError: (r) => errs.push(r) })];
    expect(errs).toEqual(["rbtree cycle"]);
    expect(out.length).toBeLessThan(8);

    const t = setup(20);
    const errs2: string[] = [];
    expect([...rbInorder(t.rootV, { max: 5, onError: (r) => errs2.push(r) })]).toEqual(t.nodes.slice(0, 5));
    expect(errs2).toEqual(["rbtree too large"]);
  });

  it("stops on unreadable nodes", () => {
    const { k, nodes, rootV } = setup(3);
    k.prog.set(nodes[0], "struct rb_node", "rb_right", 0x20000000);
    const errs: string[] = [];
    const out = [...rbInorder(rootV, { onError: (r) => errs.push(r) })];
    expect(errs.length).toBeGreaterThan(0);
    expect(out).toContain(nodes[0]);
  });
});
