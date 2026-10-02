// Shared small utilities for the helpers. Depends only on the contract interfaces.

import { PageFault } from "../../vm/types";
import type { Memory } from "../../vm/types";
import type { Program, Value } from "../api";
import { BtfKind } from "../api";

/** Default guard against runaway / cyclic kernel data structures. */
export const MAX_ITER = 100_000;

export interface WalkOpts {
  /** Maximum number of nodes yielded (default MAX_ITER). */
  max?: number;
  /** Called when a walk stops early because of unreadable memory, a cycle or the limit. */
  onError?: (reason: string, addr: number) => void;
}

/** True for errors that mean "this memory is not readable". */
export function isMemError(e: unknown): boolean {
  return e instanceof PageFault || e instanceof RangeError;
}

export function readU32(mem: Memory, addr: number): number {
  const b = mem.read(addr >>> 0, 4);
  return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
}

/** If `v` is a pointer, dereference it; otherwise return it unchanged. */
export function asObject(v: Value): Value {
  return v.prog.btf.resolve(v.type).kind === BtfKind.PTR ? v.deref() : v;
}

/** Resolved BTF struct/union name of a value's type ("" if not a struct). */
export function structName(v: Value): string {
  const t = v.prog.btf.resolve(v.type);
  return t.kind === BtfKind.STRUCT || t.kind === BtfKind.UNION ? t.name : "";
}

/** Number of elements of an array-typed value (BTF array length). */
export function arrayLen(v: Value): number {
  const t = v.prog.btf.resolve(v.type);
  if (t.kind !== BtfKind.ARRAY || !t.array) throw new Error(`not an array: ${v.typeName()}`);
  return t.array.nelems;
}

/** Read an integer-ish value as bigint (handles 4- and 8-byte quantities). */
export function big(v: Value): bigint {
  return BigInt(v.read());
}

/** Signed 64-bit read. */
export function s64(v: Value): bigint {
  return BigInt.asIntN(64, big(v));
}

/** Run `f`, returning undefined if it throws (for optional fields). */
export function tryGet<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

export function hasMember(prog: Program, type: string, path: string): boolean {
  try {
    prog.offsetOf(type, path);
    return true;
  } catch {
    return false;
  }
}
