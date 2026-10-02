// Port of drgn.helpers.linux.rbtree (in-order iteration), with guards.

import type { Program, Value } from "../api";
import { asObject, isMemError, MAX_ITER, readU32, structName, WalkOpts } from "./util";

/** The struct rb_root of `root` (struct rb_root, struct rb_root_cached, or a pointer to either). */
function rbRootOf(root: Value): Value {
  const r = asObject(root);
  return structName(r) === "rb_root_cached" ? r.member("rb_root") : r;
}

interface RbOffsets { parentColor: number; right: number; left: number; }

function rbOffsets(prog: Program): RbOffsets {
  return {
    parentColor: prog.offsetOf("struct rb_node", "__rb_parent_color"),
    right: prog.offsetOf("struct rb_node", "rb_right"),
    left: prog.offsetOf("struct rb_node", "rb_left"),
  };
}

/** rb_parent(): strip the color bits from __rb_parent_color. `node` is a struct rb_node (or pointer) Value or address. */
export function rbParent(node: Value | number, prog?: Program): number {
  let addr: number;
  let p: Program;
  let mem;
  if (typeof node === "number") {
    if (!prog) throw new Error("rbParent(addr) needs prog");
    p = prog;
    addr = node;
    mem = prog.mem;
  } else {
    const n = asObject(node);
    p = n.prog;
    addr = n.addr;
    mem = n.mem;
  }
  return (readU32(mem, addr + p.offsetOf("struct rb_node", "__rb_parent_color")) & ~3) >>> 0;
}

/** Address of the root rb_node of an rb_root / rb_root_cached (0 if empty). */
export function rbRootNode(root: Value): number {
  return rbRootOf(root).member("rb_node").ptr();
}

/** Leftmost node address (0 if the tree is empty). */
export function rbFirst(root: Value): number {
  const r = rbRootOf(root);
  const off = rbOffsets(r.prog);
  let n = r.member("rb_node").ptr();
  if (n === 0) return 0;
  const seen = new Set<number>();
  for (;;) {
    let l: number;
    try {
      l = readU32(r.mem, n + off.left);
    } catch (e) {
      if (!isMemError(e)) throw e;
      return n;
    }
    if (l === 0 || seen.has(l)) return n;
    seen.add(n);
    n = l;
  }
}

/** Leftmost node of an rb_root_cached via its cached pointer (falls back to rbFirst for rb_root). */
export function rbFirstCached(root: Value): number {
  const r = asObject(root);
  if (structName(r) === "rb_root_cached") return r.member("rb_leftmost").ptr();
  return rbFirst(root);
}

/** rb_next(): in-order successor of the node at `addr` (0 if last). */
export function rbNext(prog: Program, addr: number, mem = prog.mem): number {
  const off = rbOffsets(prog);
  const right = readU32(mem, addr + off.right);
  if (right !== 0) {
    let n = right;
    for (let i = 0; i < 4096; i++) {
      const l = readU32(mem, n + off.left);
      if (l === 0) return n;
      n = l;
    }
    return n;
  }
  let node = addr;
  let parent = (readU32(mem, node + off.parentColor) & ~3) >>> 0;
  for (let i = 0; parent !== 0 && i < 4096; i++) {
    if (readU32(mem, parent + off.right) !== node) return parent;
    node = parent;
    parent = (readU32(mem, node + off.parentColor) & ~3) >>> 0;
  }
  return 0;
}

/**
 * In-order (ascending) traversal of an rb_root / rb_root_cached (or pointer to one),
 * yielding rb_node addresses. Uses an explicit stack over left/right links so it
 * does not depend on parent pointers; cycle and size guarded.
 */
export function* rbInorder(root: Value, opts: WalkOpts = {}): Generator<number> {
  const r = rbRootOf(root);
  const off = rbOffsets(r.prog);
  const mem = r.mem;
  const max = opts.max ?? MAX_ITER;
  const seen = new Set<number>();
  const stack: number[] = [];
  let cur = r.member("rb_node").ptr();
  let count = 0;
  const fail = (reason: string, addr: number) => opts.onError?.(reason, addr);
  for (;;) {
    while (cur !== 0) {
      if (seen.has(cur)) {
        fail("rbtree cycle", cur);
        return;
      }
      seen.add(cur);
      stack.push(cur);
      try {
        cur = readU32(mem, cur + off.left);
      } catch (e) {
        if (!isMemError(e)) throw e;
        fail("unreadable rb_node", cur);
        cur = 0;
      }
    }
    const n = stack.pop();
    if (n === undefined) return;
    if (count >= max) {
      fail("rbtree too large", n);
      return;
    }
    count++;
    yield n;
    try {
      cur = readU32(mem, n + off.right);
    } catch (e) {
      if (!isMemError(e)) throw e;
      fail("unreadable rb_node", n);
      cur = 0;
    }
  }
}

/** rbtree_inorder_for_each_entry(): yield `type` values containing each node via `member`. */
export function* rbInorderEntries(
  root: Value,
  type: string,
  member: string,
  opts: WalkOpts = {},
): Generator<Value> {
  const prog = root.prog;
  for (const n of rbInorder(root, opts)) yield prog.containerOf(n, type, member);
}
