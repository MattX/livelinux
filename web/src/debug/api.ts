// Shared contracts for the debug layer (drgn-style). Implementations:
//   btf.ts      -> parseBtf(): Btf
//   symbols.ts  -> parseSystemMap(): Symbols
//   program.ts  -> class KernelProgram implements Program, Value implementation
// Helpers in helpers/*.ts must only depend on these interfaces.

import type { Memory } from "../vm/types";

export type TypeId = number; // BTF type id; 0 = void

export const enum BtfKind {
  UNKN = 0, INT = 1, PTR = 2, ARRAY = 3, STRUCT = 4, UNION = 5, ENUM = 6, FWD = 7,
  TYPEDEF = 8, VOLATILE = 9, CONST = 10, RESTRICT = 11, FUNC = 12, FUNC_PROTO = 13,
  VAR = 14, DATASEC = 15, FLOAT = 16, DECL_TAG = 17, TYPE_TAG = 18, ENUM64 = 19,
}

export interface BtfMember { name: string; type: TypeId; /** bit offset from start of struct */ bitOffset: number; /** 0 unless bitfield */ bitSize: number; }
export interface BtfEnumValue { name: string; value: bigint; }
export interface BtfParam { name: string; type: TypeId; }
export interface BtfSecInfo { type: TypeId; offset: number; size: number; }

export interface BtfType {
  id: TypeId;
  kind: BtfKind;
  name: string; // "" if anonymous
  /** byte size for INT/STRUCT/UNION/ENUM/ENUM64/FLOAT/DATASEC; undefined otherwise */
  size?: number;
  /** referenced type for PTR/TYPEDEF/VOLATILE/CONST/RESTRICT/FUNC/VAR/TYPE_TAG/DECL_TAG, return type for FUNC_PROTO */
  ref?: TypeId;
  // INT
  intEncoding?: { signed: boolean; char: boolean; bool: boolean; bitOffset: number; bits: number };
  // ARRAY
  array?: { elemType: TypeId; indexType: TypeId; nelems: number };
  // STRUCT / UNION
  members?: BtfMember[];
  // ENUM / ENUM64
  enumValues?: BtfEnumValue[];
  signed?: boolean; // ENUM/ENUM64 kind_flag
  // FUNC_PROTO
  params?: BtfParam[];
  // VAR
  linkage?: number;
  // DATASEC
  secinfo?: BtfSecInfo[];
  // FWD: true if union
  fwdUnion?: boolean;
}

export interface Btf {
  readonly types: BtfType[]; // index == id, types[0] is void
  /** Look up a named type. Accepts "struct foo", "union foo", "enum foo", typedef names, base type names ("unsigned int"). */
  find(name: string): BtfType | undefined;
  /** BTF VAR for a global variable, if encoded. */
  findVar(name: string): BtfType | undefined;
  /** Strip typedef / const / volatile / restrict / type_tag. */
  resolve(id: TypeId): BtfType;
  /** Byte size of a type (pointers = pointerSize). */
  sizeOf(id: TypeId): number;
  /** Human-readable C-ish name, e.g. "struct task_struct *", "char [16]". */
  typeName(id: TypeId): string;
  readonly pointerSize: number; // 4 on i386
}

export interface Sym { name: string; addr: number; type: string /* System.map type letter */; }
export interface Symbols {
  /** Address of a symbol, or undefined. */
  addr(name: string): number | undefined;
  /** Nearest symbol at or below addr (text/data). */
  lookup(addr: number): { sym: Sym; offset: number } | undefined;
  /** "func+0x1a" or hex fallback. */
  format(addr: number): string;
  readonly all: readonly Sym[]; // sorted by addr
}

export interface Program {
  readonly btf: Btf;
  readonly symbols: Symbols;
  /** Kernel virtual address space. */
  readonly mem: Memory;
  /** Global variable (address from System.map, type from BTF VAR). Throws if unknown. */
  var(name: string): Value;
  /** Construct a value of the given type at addr. `type` is a type name ("struct task_struct") or TypeId. Optional memory overrides kernel mem (e.g. user address space). */
  value(addr: number, type: string | TypeId, mem?: Memory): Value;
  /** Resolve a type name to a TypeId (throws if unknown). Accepts trailing " *" for pointer types (synthesized if needed). */
  typeId(name: string): TypeId;
  /** Byte offset of a (possibly nested, dotted) member path within a struct/union type, descending into anonymous members. */
  offsetOf(type: string | TypeId, path: string): number;
  sizeOf(type: string | TypeId): number;
  /** container_of(ptr, type, member) -> Value of `type` at ptr - offsetOf(type, member). */
  containerOf(ptr: number, type: string | TypeId, memberPath: string): Value;
  /** Raw reads from kernel memory (little-endian). */
  readU8(addr: number): number;
  readU16(addr: number): number;
  readU32(addr: number): number;
  readU64(addr: number): bigint;
  /** Decode an enum constant by name (searching all enums), e.g. constant("TASK_RUNNING")-style use for helpers. */
  enumValue(name: string): bigint | undefined;
}

export interface Value {
  readonly prog: Program;
  readonly mem: Memory;
  /** Address of the object in `mem`. */
  readonly addr: number;
  /** Declared type (may be typedef/qualified). */
  readonly type: TypeId;
  /** Dotted member path, descending into anonymous struct/union members automatically. "se.vruntime". */
  member(path: string): Value;
  /** For pointers: value of pointee type at the pointer's target. Throws on void* / null. */
  deref(): Value;
  /** Array element i, or for pointers *(p + i). */
  index(i: number): Value;
  /** Same address, different type. */
  cast(type: string | TypeId): Value;
  /** Integer / enum / pointer / bool / bitfield read. 8-byte quantities return bigint, everything else number (unsigned unless type is signed). */
  read(): number | bigint;
  /** Number(read()). */
  num(): number;
  /** For pointer types: the pointer value as number. */
  ptr(): number;
  isNull(): boolean;
  /** For char arrays: NUL-terminated contents. For char*: reads the pointed-to string. */
  cstr(max?: number): string;
  /** For enums: constant name if it matches, else numeric string. */
  enumName(): string;
  typeName(): string;
  sizeOf(): number;
  /** Raw bytes of the object. */
  bytes(): Uint8Array;
}
