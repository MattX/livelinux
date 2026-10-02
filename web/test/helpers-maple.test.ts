import { describe, expect, it } from "vitest";
import { mtForEach, xaIsNode } from "../src/debug/helpers";
import { allocObj, buildKernel, buildMapleTree, type Kernel, type MapleRange } from "./util/helperFakes";

const U = 0xffffffff;
const collect = (k: Kernel, mt: number) => [...mtForEach(k.prog.value(mt, "struct maple_tree"))];

/** Page-aligned VMA-like ranges at user addresses, with an entry pointer each. */
function vmaRanges(n: number, base = 0x08048000): MapleRange[] {
  return Array.from({ length: n }, (_, i) => ({
    first: base + i * 0x3000,
    last: base + i * 0x3000 + 0x1fff,
    entry: 0xc2000000 + i * 0x100,
  }));
}

/** n contiguous 4K ranges starting at index 0 (+1 trailing NULL gap added by the builder => n+1 slots). */
const contig = (n: number): MapleRange[] =>
  Array.from({ length: n }, (_, i) => ({ first: i * 0x1000, last: i * 0x1000 + 0xfff, entry: 0xc2000000 + i * 0x100 }));

describe("xaIsNode", () => {
  it("matches (e & 3) == 2 && e > 4096", () => {
    expect(xaIsNode(0)).toBe(false);
    expect(xaIsNode(0xc2000000)).toBe(false); // plain pointer
    expect(xaIsNode(0xc2000102)).toBe(true);
    expect(xaIsNode(2)).toBe(false);
    expect(xaIsNode(4098)).toBe(true);
    expect(xaIsNode(4096 + 2 - 4096)).toBe(false);
  });
});

describe("mtForEach", () => {
  it("empty tree yields nothing", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    expect(collect(k, mt)).toEqual([]);
  });

  it("non-node root entry is a single entry at index 0", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    k.prog.set(mt, "struct maple_tree", "ma_root", 0xc2001000);
    expect(collect(k, mt)).toEqual([{ first: 0, last: 0, entry: 0xc2001000 }]);
  });

  it("accepts a pointer to the maple_tree", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    k.prog.set(mt, "struct maple_tree", "ma_root", 0xc2001000);
    const holder = k.mem.alloc(4);
    k.mem.writeUint(holder, 4, mt);
    expect([...mtForEach(k.prog.value(holder, "struct maple_tree *"))]).toEqual([{ first: 0, last: 0, entry: 0xc2001000 }]);
  });

  it("single leaf node: skips NULL gaps, implied last pivot is node max", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = vmaRanges(3);
    buildMapleTree(k, mt, ranges);
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("a range reaching ULONG_MAX (last pivot == node max)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges: MapleRange[] = [
      { first: 0x1000, last: 0x1fff, entry: 0xc2000100 },
      { first: 0xbfff0000, last: U, entry: 0xc2000200 },
    ];
    buildMapleTree(k, mt, ranges);
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("a full leaf (all slots used, no stored max pivot)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    // 31 real ranges + trailing NULL gap fills all 32 slots of one leaf
    const ranges = contig(k.rangeSlots - 1);
    buildMapleTree(k, mt, ranges);
    const root = k.prog.value(mt, "struct maple_tree").member("ma_root").ptr();
    expect(((root >> 3) & 15)).toBe(1); // a single leaf_64 node
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("leaf with exactly slots-1 used (pivot[last] == max case)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = contig(k.rangeSlots - 2);
    buildMapleTree(k, mt, ranges);
    const root = k.prog.value(mt, "struct maple_tree").member("ma_root").ptr();
    expect(((root >> 3) & 15)).toBe(1);
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("multi-level tree with range_64 internal nodes", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = vmaRanges(300);
    buildMapleTree(k, mt, ranges);
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("multi-level tree, tiny fanout (4 levels)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = vmaRanges(40);
    buildMapleTree(k, mt, ranges, { fanout: 2 });
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("ALLOC_RANGE tree with maple_arange_64 internal nodes (mm_mt)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = vmaRanges(150);
    buildMapleTree(k, mt, ranges, { alloc: true });
    expect(collect(k, mt)).toEqual(ranges);
    const small = allocObj(k, "struct maple_tree");
    buildMapleTree(k, small, vmaRanges(25), { alloc: true, fanout: 3 });
    expect(collect(k, small)).toEqual(vmaRanges(25));
  });

  it("arange node with all slots used (end == nslots-1)", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges = contig(k.arangeSlots * k.arangeSlots + 5);
    buildMapleTree(k, mt, ranges, { alloc: true });
    expect(collect(k, mt)).toEqual(ranges);
    const root = k.prog.value(mt, "struct maple_tree").member("ma_root").ptr();
    expect(((root >> 3) & 15)).toBe(3); // arange_64 root over arange_64 internals
  });

  it("slot/pivot counts come from BTF, not hard-coded (64-bit-like 16/10 counts)", () => {
    const k = buildKernel({ rangeSlots: 16, arangeSlots: 10 });
    const mt = allocObj(k, "struct maple_tree");
    const ranges = vmaRanges(200);
    buildMapleTree(k, mt, ranges, { alloc: true });
    expect(collect(k, mt)).toEqual(ranges);
    const mt2 = allocObj(k, "struct maple_tree");
    buildMapleTree(k, mt2, ranges);
    expect(collect(k, mt2)).toEqual(ranges);
    // and an odd size
    const k2 = buildKernel({ rangeSlots: 7, arangeSlots: 5 });
    const mt3 = allocObj(k2, "struct maple_tree");
    buildMapleTree(k2, mt3, ranges, { alloc: true });
    expect(collect(k2, mt3)).toEqual(ranges);
  });

  it("skips XA_ZERO_ENTRY slots", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges: MapleRange[] = [
      { first: 0x1000, last: 0x1fff, entry: 0xc2000100 },
      { first: 0x2000, last: 0x2fff, entry: 1030 },
      { first: 0x3000, last: 0x3fff, entry: 0xc2000200 },
    ];
    buildMapleTree(k, mt, ranges);
    expect(collect(k, mt)).toEqual([ranges[0], ranges[2]]);
  });

  it("entries starting at index 0 and adjacent ranges", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const ranges: MapleRange[] = [
      { first: 0, last: 0xfff, entry: 0xc2000100 },
      { first: 0x1000, last: 0x1fff, entry: 0xc2000200 },
      { first: 0x2000, last: 0x2000, entry: 0xc2000300 },
    ];
    buildMapleTree(k, mt, ranges);
    expect(collect(k, mt)).toEqual(ranges);
  });

  it("reads a hand-encoded dense node", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const node = k.mem.alloc(256, 256);
    k.prog.set(node, "struct maple_node", "slot[0]", 0xc2000100);
    k.prog.set(node, "struct maple_node", "slot[1]", 0);
    k.prog.set(node, "struct maple_node", "slot[2]", 0xc2000200);
    k.prog.set(mt, "struct maple_tree", "ma_root", (node | (0 << 3) | 2) >>> 0);
    // dense node covers [0, U]; entries per index, limited by BTF slot count (63)
    expect(collect(k, mt)).toEqual([
      { first: 0, last: 0, entry: 0xc2000100 },
      { first: 2, last: 2, entry: 0xc2000200 },
    ]);
  });

  it("reports unreadable nodes and unknown node types via onError, without throwing", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    const errs: string[] = [];
    k.prog.set(mt, "struct maple_tree", "ma_root", (0x30000000 | (2 << 3) | 2) >>> 0);
    expect([...mtForEach(k.prog.value(mt, "struct maple_tree"), { onError: (r) => errs.push(r) })]).toEqual([]);
    expect(errs).toEqual(["unreadable maple node"]);

    const node = k.mem.alloc(256, 256);
    k.prog.set(mt, "struct maple_tree", "ma_root", (node | (9 << 3) | 2) >>> 0);
    const errs2: string[] = [];
    expect([...mtForEach(k.prog.value(mt, "struct maple_tree"), { onError: (r) => errs2.push(r) })]).toEqual([]);
    expect(errs2[0]).toMatch(/unknown maple_type 9/);
  });

  it("guards against node cycles", () => {
    const k = buildKernel();
    const mt = allocObj(k, "struct maple_tree");
    buildMapleTree(k, mt, vmaRanges(10), { fanout: 2 });
    // point an internal node's slot at the root again
    const root = k.prog.value(mt, "struct maple_tree").member("ma_root").ptr();
    const rootAddr = (root & ~255) >>> 0;
    k.prog.set(rootAddr, "struct maple_node", "mr64.slot[0]", root);
    const errs: string[] = [];
    [...mtForEach(k.prog.value(mt, "struct maple_tree"), { onError: (r) => errs.push(r) })];
    expect(errs.some((e) => /cycle/.test(e))).toBe(true);
  });
});
