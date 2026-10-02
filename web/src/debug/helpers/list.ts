// Port of drgn.helpers.linux.list (list_head / hlist_head iteration), with guards.

import type { Value } from "../api";
import { asObject, isMemError, MAX_ITER, readU32, WalkOpts } from "./util";

/**
 * Yield the addresses of every node on the circular list rooted at `head`
 * (a `struct list_head` or pointer to one), excluding `head` itself.
 * Stops on NULL/unreadable pointers, on a cycle that does not return to head,
 * or after `opts.max` nodes.
 */
export function* listForEach(head: Value, opts: WalkOpts = {}): Generator<number> {
  const h = asObject(head);
  const headAddr = h.addr;
  const mem = h.mem;
  const max = opts.max ?? MAX_ITER;
  const seen = new Set<number>();
  let cur: number;
  try {
    cur = readU32(mem, headAddr); // list_head.next is at offset 0
  } catch (e) {
    if (!isMemError(e)) throw e;
    opts.onError?.("unreadable list head", headAddr);
    return;
  }
  while (cur !== headAddr) {
    if (cur === 0) {
      opts.onError?.("null list pointer", cur);
      return;
    }
    if (seen.size >= max) {
      opts.onError?.("list too long", cur);
      return;
    }
    if (seen.has(cur)) {
      opts.onError?.("list cycle", cur);
      return;
    }
    seen.add(cur);
    yield cur;
    try {
      cur = readU32(mem, cur);
    } catch (e) {
      if (!isMemError(e)) throw e;
      opts.onError?.("unreadable list node", cur);
      return;
    }
  }
}

/** list_for_each_entry(): yield `type` values containing each node via `member`. */
export function* listForEachEntry(
  head: Value,
  type: string,
  member: string,
  opts: WalkOpts = {},
): Generator<Value> {
  const prog = head.prog;
  for (const node of listForEach(head, opts)) yield prog.containerOf(node, type, member);
}

/** Yield the addresses of the nodes of an hlist rooted at `head` (struct hlist_head or pointer). */
export function* hlistForEach(head: Value, opts: WalkOpts = {}): Generator<number> {
  const h = asObject(head);
  const mem = h.mem;
  const max = opts.max ?? MAX_ITER;
  const seen = new Set<number>();
  let cur: number;
  try {
    cur = readU32(mem, h.addr); // hlist_head.first at offset 0
  } catch (e) {
    if (!isMemError(e)) throw e;
    opts.onError?.("unreadable hlist head", h.addr);
    return;
  }
  while (cur !== 0) {
    if (seen.size >= max) {
      opts.onError?.("hlist too long", cur);
      return;
    }
    if (seen.has(cur)) {
      opts.onError?.("hlist cycle", cur);
      return;
    }
    seen.add(cur);
    yield cur;
    try {
      cur = readU32(mem, cur); // hlist_node.next at offset 0
    } catch (e) {
      if (!isMemError(e)) throw e;
      opts.onError?.("unreadable hlist node", cur);
      return;
    }
  }
}

/** hlist_for_each_entry() */
export function* hlistForEachEntry(
  head: Value,
  type: string,
  member: string,
  opts: WalkOpts = {},
): Generator<Value> {
  const prog = head.prog;
  for (const node of hlistForEach(head, opts)) yield prog.containerOf(node, type, member);
}
