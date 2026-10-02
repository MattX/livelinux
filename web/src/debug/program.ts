// drgn-style Program/Value on top of BTF + System.map + a Memory.

import type { Memory } from "../vm/types";
import {
  BtfKind,
  type Btf,
  type BtfType,
  type Program,
  type Symbols,
  type TypeId,
  type Value,
} from "./api";

const PAGE = 4096;
const textDecoder = new TextDecoder("utf-8");

interface Located {
  /** total bit offset from the start of the starting type */
  bitOffset: number;
  bitSize: number;
  type: TypeId;
}

type PathStep = { name: string } | { index: number };

function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  const re = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|\[\s*(-?\d+)\s*\])\s*(?:\.|(?=\[)|$)/y;
  let pos = 0;
  const p = path.trim();
  if (p === "") return steps;
  while (pos < p.length) {
    re.lastIndex = pos;
    const m = re.exec(p);
    if (!m) throw new Error(`invalid member path "${path}"`);
    if (m[1] !== undefined) steps.push({ name: m[1] });
    else steps.push({ index: parseInt(m[2], 10) });
    pos = re.lastIndex;
  }
  return steps;
}

function isSigned(t: BtfType): boolean {
  if (t.kind === BtfKind.INT) return !!t.intEncoding?.signed;
  if (t.kind === BtfKind.ENUM || t.kind === BtfKind.ENUM64) return !!t.signed;
  return false;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

class ValueImpl implements Value {
  constructor(
    readonly prog: KernelProgram,
    readonly mem: Memory,
    readonly addr: number,
    readonly type: TypeId,
    readonly bitOffset: number = 0,
    readonly bitSize: number = 0,
  ) {}

  private get btf(): Btf {
    return this.prog.btf;
  }

  member(path: string): Value {
    const loc = this.prog.locate(this.type, path);
    const byte = Math.floor(loc.bitOffset / 8);
    const addr = (this.addr + byte) >>> 0;
    if (loc.bitSize > 0) {
      return new ValueImpl(this.prog, this.mem, addr, loc.type, loc.bitOffset - byte * 8, loc.bitSize);
    }
    return new ValueImpl(this.prog, this.mem, addr, loc.type);
  }

  deref(): Value {
    const t = this.btf.resolve(this.type);
    if (t.kind === BtfKind.ARRAY) return this.index(0);
    if (t.kind !== BtfKind.PTR) {
      throw new Error(`cannot dereference non-pointer type '${this.typeName()}'`);
    }
    const p = this.ptr();
    if (p === 0) throw new Error(`null pointer dereference (${this.typeName()})`);
    const target = this.prog.completeType(t.ref ?? 0, `dereferencing '${this.typeName()}'`);
    return new ValueImpl(this.prog, this.mem, p, target);
  }

  index(i: number): Value {
    const t = this.btf.resolve(this.type);
    if (t.kind === BtfKind.ARRAY) {
      const a = t.array!;
      if (a.nelems > 0 && (i < 0 || i >= a.nelems)) {
        throw new RangeError(`index ${i} out of bounds for '${this.typeName()}'`);
      }
      const sz = this.btf.sizeOf(a.elemType);
      return new ValueImpl(this.prog, this.mem, (this.addr + i * sz) >>> 0, a.elemType);
    }
    if (t.kind === BtfKind.PTR) {
      const target = this.prog.completeType(t.ref ?? 0, `indexing '${this.typeName()}'`);
      const sz = this.btf.sizeOf(target);
      if (sz === 0) throw new Error(`cannot index pointer to zero-sized type '${this.btf.typeName(target)}'`);
      return new ValueImpl(this.prog, this.mem, (this.ptr() + i * sz) >>> 0, target);
    }
    throw new Error(`cannot index type '${this.typeName()}'`);
  }

  cast(type: string | TypeId): Value {
    return new ValueImpl(this.prog, this.mem, this.addr, this.prog.resolveSpec(type));
  }

  read(): number | bigint {
    const t = this.btf.resolve(this.type);
    switch (t.kind) {
      case BtfKind.INT:
      case BtfKind.ENUM:
      case BtfKind.ENUM64:
      case BtfKind.PTR:
        break;
      case BtfKind.FLOAT: {
        const sz = t.size ?? 0;
        const b = this.mem.read(this.addr, sz);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (sz === 4) return dv.getFloat32(0, true);
        if (sz === 8) return dv.getFloat64(0, true);
        throw new Error(`unsupported float size ${sz}`);
      }
      default:
        throw new Error(`cannot read value of type '${this.typeName()}' as a scalar`);
    }

    const signed = isSigned(t);
    const size = t.kind === BtfKind.PTR ? this.btf.pointerSize : (t.size ?? 0);

    if (this.bitSize > 0) {
      const nbytes = Math.ceil((this.bitOffset + this.bitSize) / 8);
      const raw = bytesToBigInt(this.mem.read(this.addr, nbytes));
      let v = (raw >> BigInt(this.bitOffset)) & ((1n << BigInt(this.bitSize)) - 1n);
      if (t.kind === BtfKind.INT && t.intEncoding?.bool) return v !== 0n ? 1 : 0;
      if (signed && v >= 1n << BigInt(this.bitSize - 1)) v -= 1n << BigInt(this.bitSize);
      return size > 4 ? v : Number(v);
    }

    if (t.kind === BtfKind.INT && t.intEncoding?.bool) {
      const b = this.mem.read(this.addr, Math.max(size, 1));
      for (let i = 0; i < size; i++) if (b[i] !== 0) return 1;
      return 0;
    }

    const b = this.mem.read(this.addr, size);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (size) {
      case 1:
        return signed ? dv.getInt8(0) : dv.getUint8(0);
      case 2:
        return signed ? dv.getInt16(0, true) : dv.getUint16(0, true);
      case 4:
        return signed ? dv.getInt32(0, true) : dv.getUint32(0, true);
      case 8:
        return signed ? dv.getBigInt64(0, true) : dv.getBigUint64(0, true);
      default: {
        let v = bytesToBigInt(b.subarray(0, size));
        if (signed && size > 0 && v >= 1n << BigInt(size * 8 - 1)) v -= 1n << BigInt(size * 8);
        return v;
      }
    }
  }

  num(): number {
    return Number(this.read());
  }

  ptr(): number {
    const t = this.btf.resolve(this.type);
    if (t.kind === BtfKind.ARRAY) return this.addr; // array decays to pointer
    if (t.kind === BtfKind.PTR) {
      const b = this.mem.read(this.addr, 4);
      return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    }
    if (t.kind === BtfKind.INT || t.kind === BtfKind.ENUM || t.kind === BtfKind.ENUM64) {
      return Number(BigInt.asUintN(32, BigInt(this.read())));
    }
    throw new Error(`type '${this.typeName()}' is not a pointer`);
  }

  isNull(): boolean {
    const t = this.btf.resolve(this.type);
    if (t.kind === BtfKind.PTR) return this.ptr() === 0;
    if (t.kind === BtfKind.STRUCT || t.kind === BtfKind.UNION || t.kind === BtfKind.ARRAY) return false;
    return BigInt(this.read()) === 0n;
  }

  cstr(max?: number): string {
    const t = this.btf.resolve(this.type);
    let start: number;
    let limit: number;
    if (t.kind === BtfKind.ARRAY) {
      const a = t.array!;
      if (this.btf.sizeOf(a.elemType) !== 1) throw new Error(`cstr: '${this.typeName()}' is not a char array`);
      start = this.addr;
      limit = a.nelems > 0 ? a.nelems : 256;
      if (max !== undefined) limit = Math.min(limit, max);
    } else if (t.kind === BtfKind.PTR) {
      const target = this.btf.resolve(t.ref ?? 0);
      if (!(target.kind === BtfKind.INT && target.size === 1)) {
        throw new Error(`cstr: '${this.typeName()}' is not a char pointer`);
      }
      start = this.ptr();
      limit = max ?? 256;
      if (start === 0) return "";
    } else {
      throw new Error(`cstr: '${this.typeName()}' is not a char array or char pointer`);
    }
    return readCString(this.mem, start, limit);
  }

  enumName(): string {
    const t = this.btf.resolve(this.type);
    const v = BigInt(this.read());
    if (t.kind === BtfKind.ENUM || t.kind === BtfKind.ENUM64) {
      for (const e of t.enumValues ?? []) if (e.value === v) return e.name;
    }
    return v.toString();
  }

  typeName(): string {
    return this.btf.typeName(this.type);
  }

  sizeOf(): number {
    return this.btf.sizeOf(this.type);
  }

  bytes(): Uint8Array {
    const n = this.btf.sizeOf(this.type);
    return new Uint8Array(this.mem.read(this.addr, n)); // copy: may alias live RAM
  }
}

/** Read a NUL-terminated string of at most `max` bytes, tolerating faults. */
function readCString(mem: Memory, start: number, max: number): string {
  const out = new Uint8Array(Math.max(max, 0));
  let n = 0;
  let addr = start >>> 0;
  outer: while (n < max) {
    const chunk = Math.min(max - n, PAGE - (addr & (PAGE - 1)));
    let b: Uint8Array;
    try {
      b = mem.read(addr, chunk);
    } catch {
      break;
    }
    for (let i = 0; i < chunk; i++) {
      if (b[i] === 0) break outer;
      out[n++] = b[i];
    }
    addr = (addr + chunk) >>> 0;
  }
  return textDecoder.decode(out.subarray(0, n));
}

export class KernelProgram implements Program {
  private memberCache = new Map<string, Located | null>();
  private ptrIndex?: Map<TypeId, TypeId>;
  private enumIndex?: Map<string, bigint>;

  constructor(
    readonly btf: Btf,
    readonly symbols: Symbols,
    readonly mem: Memory,
  ) {}

  // --- types ---------------------------------------------------------------

  typeId(name: string): TypeId {
    const m = /^(.*?)\s*((?:\*\s*)*)$/.exec(name.trim());
    let base = (m ? m[1] : name).trim();
    const stars = m ? (m[2].match(/\*/g)?.length ?? 0) : 0;
    let t = this.btf.find(base);
    if (!t) {
      // tolerate leading qualifiers
      const stripped = base.replace(/^(?:const|volatile)\s+/, "");
      if (stripped !== base) t = this.btf.find(stripped);
    }
    if (!t) throw new Error(`unknown type '${name}'`);
    let id = t.id;
    for (let i = 0; i < stars; i++) id = this.pointerTo(id);
    return id;
  }

  resolveSpec(type: string | TypeId): TypeId {
    if (typeof type === "string") return this.typeId(type);
    if (!Number.isInteger(type) || type < 0 || type >= this.btf.types.length) {
      throw new RangeError(`invalid type id ${type}`);
    }
    return type;
  }

  private pointerTo(target: TypeId): TypeId {
    if (!this.ptrIndex) {
      const idx = new Map<TypeId, TypeId>();
      for (const t of this.btf.types) {
        if (t.kind === BtfKind.PTR && !idx.has(t.ref ?? 0)) idx.set(t.ref ?? 0, t.id);
      }
      this.ptrIndex = idx;
    }
    let id = this.ptrIndex.get(target);
    if (id === undefined) {
      if (!this.btf.addType) throw new Error("this Btf does not support synthesized types (addType)");
      id = this.btf.addType({ kind: BtfKind.PTR, name: "", ref: target });
      this.ptrIndex.set(target, id);
    }
    return id;
  }

  /** Resolve `id` (keeping typedef/qualifier wrappers) but replace forward declarations with the full definition. */
  completeType(id: TypeId, what: string): TypeId {
    const r = this.btf.resolve(id);
    if (r.kind === BtfKind.UNKN) {
      throw new Error(`${what}: cannot use 'void' (cast to a concrete type first)`);
    }
    if (r.kind === BtfKind.FWD) {
      const full = this.btf.find((r.fwdUnion ? "union " : "struct ") + r.name);
      if (!full || full.kind === BtfKind.FWD) {
        throw new Error(`${what}: incomplete type '${this.btf.typeName(r.id)}' (no definition in BTF)`);
      }
      return full.id;
    }
    return id;
  }

  sizeOf(type: string | TypeId): number {
    return this.btf.sizeOf(this.resolveSpec(type));
  }

  // --- member lookup ---------------------------------------------------------

  private findMember(structId: TypeId, name: string): Located | null {
    const key = structId + ":" + name;
    const cached = this.memberCache.get(key);
    if (cached !== undefined) return cached;
    const res = this.findMemberUncached(structId, name);
    this.memberCache.set(key, res);
    return res;
  }

  private findMemberUncached(structId: TypeId, name: string): Located | null {
    const st = this.btf.resolve(this.completeType(structId, `looking up member '${name}'`));
    if (st.kind !== BtfKind.STRUCT && st.kind !== BtfKind.UNION) return null;
    const members = st.members ?? [];
    for (const m of members) {
      if (m.name === name) return { bitOffset: m.bitOffset, bitSize: m.bitSize, type: m.type };
    }
    for (const m of members) {
      if (m.name !== "") continue;
      const inner = this.btf.resolve(m.type);
      if (inner.kind !== BtfKind.STRUCT && inner.kind !== BtfKind.UNION) continue;
      const r = this.findMember(inner.id, name);
      if (r) return { bitOffset: m.bitOffset + r.bitOffset, bitSize: r.bitSize, type: r.type };
    }
    return null;
  }

  /** Walk a dotted/indexed member path starting at `type`. */
  locate(type: TypeId, path: string): Located {
    const steps = parsePath(path);
    let cur: TypeId = type;
    let bitOffset = 0;
    let bitSize = 0;
    for (const step of steps) {
      if (bitSize > 0) throw new Error(`cannot navigate into bitfield in path "${path}"`);
      if ("name" in step) {
        const t = this.btf.resolve(cur);
        if (t.kind === BtfKind.PTR) {
          throw new Error(`member '${step.name}' of pointer type '${this.btf.typeName(cur)}': use deref() first`);
        }
        if (t.kind !== BtfKind.STRUCT && t.kind !== BtfKind.UNION && t.kind !== BtfKind.FWD) {
          throw new Error(`type '${this.btf.typeName(cur)}' has no member '${step.name}'`);
        }
        const m = this.findMember(t.id, step.name);
        if (!m) throw new Error(`'${this.btf.typeName(cur)}' has no member '${step.name}'`);
        bitOffset += m.bitOffset;
        bitSize = m.bitSize;
        cur = m.type;
      } else {
        const t = this.btf.resolve(cur);
        if (t.kind !== BtfKind.ARRAY) {
          throw new Error(`cannot index type '${this.btf.typeName(cur)}' in path "${path}"`);
        }
        const a = t.array!;
        if (a.nelems > 0 && (step.index < 0 || step.index >= a.nelems)) {
          throw new RangeError(`index ${step.index} out of bounds for '${this.btf.typeName(cur)}'`);
        }
        bitOffset += step.index * this.btf.sizeOf(a.elemType) * 8;
        cur = a.elemType;
      }
    }
    return { bitOffset, bitSize, type: cur };
  }

  offsetOf(type: string | TypeId, path: string): number {
    const loc = this.locate(this.resolveSpec(type), path);
    if (loc.bitSize > 0) throw new Error(`'${path}' is a bitfield; it has no byte offset`);
    return loc.bitOffset / 8;
  }

  containerOf(ptr: number, type: string | TypeId, memberPath: string): Value {
    const id = this.resolveSpec(type);
    const off = this.offsetOf(id, memberPath);
    return this.value((ptr - off) >>> 0, id);
  }

  // --- values ----------------------------------------------------------------

  var(name: string): Value {
    const v = this.btf.findVar(name);
    if (!v) throw new Error(`no type info for var ${name}`);
    const addr = this.symbols.addr(name);
    if (addr === undefined) throw new Error(`unknown symbol ${name}`);
    return new ValueImpl(this, this.mem, addr, v.ref ?? 0);
  }

  value(addr: number, type: string | TypeId, mem?: Memory): Value {
    return new ValueImpl(this, mem ?? this.mem, addr >>> 0, this.resolveSpec(type));
  }

  // --- raw reads -------------------------------------------------------------

  private dv(addr: number, len: number): DataView {
    const b = this.mem.read(addr >>> 0, len);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  readU8(addr: number): number {
    return this.dv(addr, 1).getUint8(0);
  }
  readU16(addr: number): number {
    return this.dv(addr, 2).getUint16(0, true);
  }
  readU32(addr: number): number {
    return this.dv(addr, 4).getUint32(0, true);
  }
  readU64(addr: number): bigint {
    return this.dv(addr, 8).getBigUint64(0, true);
  }

  enumValue(name: string): bigint | undefined {
    if (!this.enumIndex) {
      const idx = new Map<string, bigint>();
      for (const t of this.btf.types) {
        if (t.kind !== BtfKind.ENUM && t.kind !== BtfKind.ENUM64) continue;
        for (const e of t.enumValues ?? []) if (!idx.has(e.name)) idx.set(e.name, e.value);
      }
      this.enumIndex = idx;
    }
    return this.enumIndex.get(name);
  }
}
