// Port of drgn.helpers.linux.mapletree (mt_for_each) for the kernel's maple tree.
//
// Slot/pivot counts are derived from BTF array lengths (they differ between 32- and
// 64-bit kernels), never hard-coded. Node layout offsets come from prog.offsetOf.

import type { Btf, BtfType, Program, Value } from "../api";
import { BtfKind } from "../api";
import { asObject, isMemError, MAX_ITER, readU32, WalkOpts } from "./util";

export interface MapleEntry {
  /** First index covered by the entry (inclusive). */
  first: number;
  /** Last index covered by the entry (inclusive). */
  last: number;
  /** The stored entry (e.g. a struct vm_area_struct pointer). */
  entry: number;
}

const MAPLE_NODE_MASK = 255;
const MAPLE_NODE_TYPE_MASK = 0xf;
const MAPLE_NODE_TYPE_SHIFT = 3;
const enum MapleType { Dense = 0, Leaf64 = 1, Range64 = 2, Arange64 = 3 }
/** xa_mk_internal(257) */
const XA_ZERO_ENTRY = 1030;

export function xaIsNode(e: number): boolean {
  return (e & 3) === 2 && e > 4096;
}

export function xaIsZero(e: number): boolean {
  return e === XA_ZERO_ENTRY;
}

/** Find a member by name in a struct/union type, descending into anonymous members. */
function findMemberType(btf: Btf, t: BtfType, name: string): BtfType | undefined {
  const st = btf.resolve(t.id);
  for (const m of st.members ?? []) {
    if (m.name === name) return btf.resolve(m.type);
    if (m.name === "") {
      const inner = btf.resolve(m.type);
      if (inner.kind === BtfKind.STRUCT || inner.kind === BtfKind.UNION) {
        const r = findMemberType(btf, inner, name);
        if (r) return r;
      }
    }
  }
  return undefined;
}

function nelems(btf: Btf, structName: string, member: string): number {
  const st = btf.find(structName);
  if (!st) throw new Error(`BTF type ${structName} not found`);
  const m = findMemberType(btf, st, member);
  if (!m || m.kind !== BtfKind.ARRAY || !m.array) throw new Error(`${structName}.${member} is not an array`);
  return m.array.nelems;
}

interface NodeLayout {
  r64: { pivotOff: number; slotOff: number; metaEndOff: number; npivot: number; nslot: number };
  a64: { pivotOff: number; slotOff: number; metaEndOff: number; npivot: number; nslot: number };
  denseSlotOff: number;
  denseNslot: number;
  ptr: number;
}

function layout(prog: Program): NodeLayout {
  const btf = prog.btf;
  return {
    r64: {
      pivotOff: prog.offsetOf("struct maple_node", "mr64.pivot"),
      slotOff: prog.offsetOf("struct maple_node", "mr64.slot"),
      metaEndOff: prog.offsetOf("struct maple_node", "mr64.meta.end"),
      npivot: nelems(btf, "struct maple_range_64", "pivot"),
      nslot: nelems(btf, "struct maple_range_64", "slot"),
    },
    a64: {
      pivotOff: prog.offsetOf("struct maple_node", "ma64.pivot"),
      slotOff: prog.offsetOf("struct maple_node", "ma64.slot"),
      metaEndOff: prog.offsetOf("struct maple_node", "ma64.meta.end"),
      npivot: nelems(btf, "struct maple_arange_64", "pivot"),
      nslot: nelems(btf, "struct maple_arange_64", "slot"),
    },
    denseSlotOff: prog.offsetOf("struct maple_node", "slot"),
    denseNslot: nelems(btf, "struct maple_node", "slot"),
    ptr: btf.pointerSize,
  };
}

/**
 * Iterate over all entries (and their inclusive index ranges) of a maple tree
 * (`struct maple_tree` or pointer to one), in ascending index order. NULL and
 * XA_ZERO_ENTRY slots are skipped.
 *
 * A non-node root entry is a single entry at index 0 (as in drgn).
 * Note: node types are encoded in the entries themselves, so ma_flags
 * (MT_FLAGS_ALLOC_RANGE) does not need to be consulted: allocation-range trees
 * simply use maple_arange_64 for internal nodes, which is detected per node.
 */
export function* mtForEach(mt: Value, opts: WalkOpts = {}): Generator<MapleEntry> {
  const m = asObject(mt);
  const prog = m.prog;
  const mem = m.mem;
  const root = m.member("ma_root").ptr();
  if (xaIsNode(root)) {
    const L = layout(prog);
    const ulongMax = L.ptr >= 4 ? 0xffffffff : 2 ** (8 * L.ptr) - 1;
    const maxCount = opts.max ?? MAX_ITER;
    const seen = new Set<number>();
    let yielded = 0;
    let aborted = false;

    const fail = (reason: string, addr: number) => {
      opts.onError?.(reason, addr);
    };

    function* walk(entry: number, min: number, max: number, depth: number): Generator<MapleEntry> {
      if (aborted) return;
      const nodeAddr = (entry & ~MAPLE_NODE_MASK) >>> 0;
      const type = (entry >>> MAPLE_NODE_TYPE_SHIFT) & MAPLE_NODE_TYPE_MASK;
      if (depth > 64 || seen.has(nodeAddr)) {
        fail("maple tree cycle or too deep", nodeAddr);
        aborted = true;
        return;
      }
      seen.add(nodeAddr);
      try {
        const u32 = (a: number) => readU32(mem, a);
        const u8 = (a: number) => mem.read(a, 1)[0];

        if (type === MapleType.Dense) {
          for (let i = 0; i < L.denseNslot; i++) {
            const idx = min + i;
            if (idx > max) break;
            const slot = u32(nodeAddr + L.denseSlotOff + i * L.ptr);
            if (slot !== 0 && !xaIsZero(slot)) {
              if (yielded++ >= maxCount) { aborted = true; fail("maple tree too large", nodeAddr); return; }
              yield { first: idx, last: idx, entry: slot };
            }
          }
          return;
        }

        let pivotOff: number, slotOff: number, end: number, npivot: number;
        if (type === MapleType.Arange64) {
          pivotOff = nodeAddr + L.a64.pivotOff;
          slotOff = nodeAddr + L.a64.slotOff;
          npivot = L.a64.npivot;
          end = u8(nodeAddr + L.a64.metaEndOff);
        } else if (type === MapleType.Range64 || type === MapleType.Leaf64) {
          pivotOff = nodeAddr + L.r64.pivotOff;
          slotOff = nodeAddr + L.r64.slotOff;
          npivot = L.r64.npivot;
          const last = u32(pivotOff + (npivot - 1) * L.ptr);
          if (last === 0) end = u8(nodeAddr + L.r64.metaEndOff);
          else if (last === max) end = npivot - 1;
          else end = npivot;
        } else {
          fail(`unknown maple_type ${type}`, nodeAddr);
          return;
        }
        if (end > npivot) {
          fail(`corrupt maple node end ${end}`, nodeAddr);
          return;
        }
        const leaf = type < MapleType.Range64;
        let prev = min;
        for (let i = 0; i <= end; i++) {
          const pivot = i < end ? u32(pivotOff + i * L.ptr) : max;
          const slot = u32(slotOff + i * L.ptr);
          if (leaf) {
            if (slot !== 0 && !xaIsZero(slot)) {
              if (yielded++ >= maxCount) { aborted = true; fail("maple tree too large", nodeAddr); return; }
              yield { first: prev, last: pivot, entry: slot };
            }
          } else if (xaIsNode(slot)) {
            yield* walk(slot, prev, pivot, depth + 1);
            if (aborted) return;
          } else if (slot !== 0) {
            fail("non-node entry in internal maple node", nodeAddr);
          }
          prev = (pivot + 1) >>> 0;
        }
      } catch (e) {
        if (!isMemError(e)) throw e;
        fail("unreadable maple node", nodeAddr);
      }
    }

    yield* walk(root, 0, ulongMax, 0);
  } else if (root !== 0) {
    yield { first: 0, last: 0, entry: root };
  }
}
