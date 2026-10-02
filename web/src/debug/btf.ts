// BTF (BPF Type Format) parser. See Documentation/bpf/btf.rst in the Linux tree.
//
// vmlinux BTF has 100k+ types, so parsing is two-level: one pass over the type
// section records (kind, name offset, size/type, data offset) per type; names,
// members, enum values, params etc. are decoded lazily through getters.

import {
  BtfKind,
  type Btf,
  type BtfEnumValue,
  type BtfMember,
  type BtfParam,
  type BtfSecInfo,
  type BtfType,
  type TypeId,
} from "./api";

const BTF_MAGIC = 0xeb9f;

interface Ctx {
  dv: DataView;
  bytes: Uint8Array; // whole blob
  strBase: number; // absolute offset of string section
  strLen: number;
  strCache: Map<number, string>;
  str(off: number): string;
}

const utf8 = new TextDecoder("utf-8");

function makeCtx(bytes: Uint8Array, strBase: number, strLen: number): Ctx {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cache = new Map<number, string>();
  return {
    dv,
    bytes,
    strBase,
    strLen,
    strCache: cache,
    str(off: number): string {
      if (off === 0) return "";
      const hit = cache.get(off);
      if (hit !== undefined) return hit;
      if (off >= strLen) {
        cache.set(off, "");
        return "";
      }
      const start = strBase + off;
      const limit = strBase + strLen;
      let end = start;
      let ascii = true;
      while (end < limit) {
        const c = bytes[end];
        if (c === 0) break;
        if (c > 0x7f) ascii = false;
        end++;
      }
      let s: string;
      if (ascii) {
        if (end - start <= 64) {
          s = "";
          // small strings: avoid TextDecoder call overhead
          for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
        } else {
          s = utf8.decode(bytes.subarray(start, end));
        }
      } else {
        s = utf8.decode(bytes.subarray(start, end));
      }
      cache.set(off, s);
      return s;
    },
  };
}

class TypeImpl implements BtfType {
  size?: number;
  ref?: TypeId;
  intEncoding?: BtfType["intEncoding"];
  signed?: boolean;
  linkage?: number;
  fwdUnion?: boolean;

  private _name: string | undefined;
  private _members: BtfMember[] | undefined;
  private _enumValues: BtfEnumValue[] | undefined;
  private _params: BtfParam[] | undefined;
  private _secinfo: BtfSecInfo[] | undefined;
  private _array: BtfType["array"] | undefined;

  constructor(
    private readonly ctx: Ctx,
    readonly id: TypeId,
    readonly kind: BtfKind,
    private readonly nameOff: number,
    private readonly vlen: number,
    private readonly kindFlag: boolean,
    /** absolute offset of trailing data */
    private readonly dataOff: number,
  ) {}

  get name(): string {
    let n = this._name;
    if (n === undefined) {
      n = this.nameOff === 0 ? "" : this.ctx.str(this.nameOff);
      this._name = n;
    }
    return n;
  }

  get array(): BtfType["array"] | undefined {
    if (this.kind !== BtfKind.ARRAY) return undefined;
    let a = this._array;
    if (!a) {
      const dv = this.ctx.dv;
      a = {
        elemType: dv.getUint32(this.dataOff, true),
        indexType: dv.getUint32(this.dataOff + 4, true),
        nelems: dv.getUint32(this.dataOff + 8, true),
      };
      this._array = a;
    }
    return a;
  }

  get members(): BtfMember[] | undefined {
    if (this.kind !== BtfKind.STRUCT && this.kind !== BtfKind.UNION) return undefined;
    let m = this._members;
    if (!m) {
      const dv = this.ctx.dv;
      m = new Array(this.vlen);
      let o = this.dataOff;
      for (let i = 0; i < this.vlen; i++, o += 12) {
        const off = dv.getUint32(o + 8, true);
        let bitOffset = off;
        let bitSize = 0;
        if (this.kindFlag) {
          bitSize = off >>> 24;
          bitOffset = off & 0xffffff;
        }
        m[i] = { name: this.ctx.str(dv.getUint32(o, true)), type: dv.getUint32(o + 4, true), bitOffset, bitSize };
      }
      this._members = m;
    }
    return m;
  }

  get enumValues(): BtfEnumValue[] | undefined {
    if (this.kind !== BtfKind.ENUM && this.kind !== BtfKind.ENUM64) return undefined;
    let e = this._enumValues;
    if (!e) {
      const dv = this.ctx.dv;
      e = new Array(this.vlen);
      let o = this.dataOff;
      if (this.kind === BtfKind.ENUM) {
        for (let i = 0; i < this.vlen; i++, o += 8) {
          const v = this.kindFlag ? dv.getInt32(o + 4, true) : dv.getUint32(o + 4, true);
          e[i] = { name: this.ctx.str(dv.getUint32(o, true)), value: BigInt(v) };
        }
      } else {
        for (let i = 0; i < this.vlen; i++, o += 12) {
          const lo = BigInt(dv.getUint32(o + 4, true));
          const hi = this.kindFlag ? BigInt(dv.getInt32(o + 8, true)) : BigInt(dv.getUint32(o + 8, true));
          e[i] = { name: this.ctx.str(dv.getUint32(o, true)), value: (hi << 32n) | lo };
        }
      }
      this._enumValues = e;
    }
    return e;
  }

  get params(): BtfParam[] | undefined {
    if (this.kind !== BtfKind.FUNC_PROTO) return undefined;
    let p = this._params;
    if (!p) {
      const dv = this.ctx.dv;
      p = new Array(this.vlen);
      let o = this.dataOff;
      for (let i = 0; i < this.vlen; i++, o += 8) {
        p[i] = { name: this.ctx.str(dv.getUint32(o, true)), type: dv.getUint32(o + 4, true) };
      }
      this._params = p;
    }
    return p;
  }

  get secinfo(): BtfSecInfo[] | undefined {
    if (this.kind !== BtfKind.DATASEC) return undefined;
    let s = this._secinfo;
    if (!s) {
      const dv = this.ctx.dv;
      s = new Array(this.vlen);
      let o = this.dataOff;
      for (let i = 0; i < this.vlen; i++, o += 12) {
        s[i] = {
          type: dv.getUint32(o, true),
          offset: dv.getUint32(o + 4, true),
          size: dv.getUint32(o + 8, true),
        };
      }
      this._secinfo = s;
    }
    return s;
  }
}

// Common C spellings -> names pahole/gcc use in BTF.
const INT_ALIASES: Record<string, string> = {
  "unsigned long": "long unsigned int",
  "unsigned long int": "long unsigned int",
  "long unsigned": "long unsigned int",
  long: "long int",
  "signed long": "long int",
  "unsigned short": "short unsigned int",
  "unsigned short int": "short unsigned int",
  short: "short int",
  "signed short": "short int",
  "unsigned long long": "long long unsigned int",
  "unsigned long long int": "long long unsigned int",
  "long long": "long long int",
  "signed long long": "long long int",
  unsigned: "unsigned int",
  signed: "int",
  "signed int": "int",
};

class BtfImpl implements Btf {
  readonly types: BtfType[];
  readonly pointerSize = 4;

  private structs?: Map<string, BtfType>;
  private unions?: Map<string, BtfType>;
  private enums?: Map<string, BtfType>;
  private plain?: Map<string, BtfType>;
  private fwds?: Map<string, BtfType>;
  private vars?: Map<string, BtfType>;

  constructor(types: BtfType[]) {
    this.types = types;
  }

  addType(t: Omit<BtfType, "id">): TypeId {
    const id = this.types.length;
    this.types.push({ ...t, id });
    return id;
  }

  private buildIndex(): void {
    const structs = new Map<string, BtfType>();
    const unions = new Map<string, BtfType>();
    const enums = new Map<string, BtfType>();
    const plain = new Map<string, BtfType>();
    const fwds = new Map<string, BtfType>();
    const types = this.types;
    for (let i = 1; i < types.length; i++) {
      const t = types[i];
      switch (t.kind) {
        case BtfKind.STRUCT: {
          const n = t.name;
          if (n && !structs.has(n)) structs.set(n, t);
          break;
        }
        case BtfKind.UNION: {
          const n = t.name;
          if (n && !unions.has(n)) unions.set(n, t);
          break;
        }
        case BtfKind.ENUM:
        case BtfKind.ENUM64: {
          const n = t.name;
          if (n && !enums.has(n)) enums.set(n, t);
          break;
        }
        case BtfKind.FWD: {
          const n = t.name;
          if (n) {
            const k = (t.fwdUnion ? "union " : "struct ") + n;
            if (!fwds.has(k)) fwds.set(k, t);
          }
          break;
        }
        case BtfKind.TYPEDEF:
        case BtfKind.INT:
        case BtfKind.FLOAT: {
          const n = t.name;
          if (n && !plain.has(n)) plain.set(n, t);
          break;
        }
        default:
          break;
      }
    }
    this.structs = structs;
    this.unions = unions;
    this.enums = enums;
    this.plain = plain;
    this.fwds = fwds;
  }

  private buildVars(): Map<string, BtfType> {
    const vars = new Map<string, BtfType>();
    const types = this.types;
    for (let i = 1; i < types.length; i++) {
      const t = types[i];
      if (t.kind === BtfKind.VAR) {
        const n = t.name;
        if (n && !vars.has(n)) vars.set(n, t);
      }
    }
    this.vars = vars;
    return vars;
  }

  find(name: string): BtfType | undefined {
    if (!this.plain) this.buildIndex();
    const n = name.trim().replace(/\s+/g, " ");
    if (n === "void") return this.types[0];
    if (n.startsWith("struct ")) {
      const b = n.slice(7);
      return this.structs!.get(b) ?? this.fwds!.get("struct " + b);
    }
    if (n.startsWith("union ")) {
      const b = n.slice(6);
      return this.unions!.get(b) ?? this.fwds!.get("union " + b);
    }
    if (n.startsWith("enum ")) return this.enums!.get(n.slice(5));
    if (n.startsWith("typedef ")) return this.plain!.get(n.slice(8));
    const hit = this.plain!.get(n);
    if (hit) return hit;
    const alias = INT_ALIASES[n];
    if (alias) return this.plain!.get(alias);
    return undefined;
  }

  findVar(name: string): BtfType | undefined {
    return (this.vars ?? this.buildVars()).get(name);
  }

  resolve(id: TypeId): BtfType {
    const types = this.types;
    let t = types[id];
    if (!t) throw new RangeError(`invalid BTF type id ${id}`);
    for (let guard = 0; guard < 128; guard++) {
      switch (t.kind) {
        case BtfKind.TYPEDEF:
        case BtfKind.VOLATILE:
        case BtfKind.CONST:
        case BtfKind.RESTRICT:
        case BtfKind.TYPE_TAG:
          t = types[t.ref ?? 0];
          if (!t) throw new RangeError(`dangling BTF reference from type ${id}`);
          continue;
        default:
          return t;
      }
    }
    throw new Error(`BTF type chain too deep at id ${id}`);
  }

  sizeOf(id: TypeId): number {
    let t = this.resolve(id);
    switch (t.kind) {
      case BtfKind.INT:
      case BtfKind.STRUCT:
      case BtfKind.UNION:
      case BtfKind.ENUM:
      case BtfKind.ENUM64:
      case BtfKind.FLOAT:
      case BtfKind.DATASEC:
        return t.size ?? 0;
      case BtfKind.PTR:
        return this.pointerSize;
      case BtfKind.ARRAY: {
        const a = t.array!;
        return a.nelems * this.sizeOf(a.elemType);
      }
      case BtfKind.VAR:
        return this.sizeOf(t.ref ?? 0);
      case BtfKind.FWD: {
        const full = this.find((t.fwdUnion ? "union " : "struct ") + t.name);
        return full && full.kind !== BtfKind.FWD ? (full.size ?? 0) : 0;
      }
      default:
        // void, FUNC, FUNC_PROTO, DECL_TAG
        return 0;
    }
  }

  typeName(id: TypeId): string {
    return this.decl(id, "", "", 0);
  }

  /** Build a C declaration for type `id` around declarator `inner` (e.g. "*", "[4]"). */
  private decl(id: TypeId, inner: string, pre: string, depth: number): string {
    const join = (base: string) => pre + base + (inner ? " " + inner : "");
    const t = this.types[id];
    if (!t || depth > 64) return join("?");
    switch (t.kind) {
      case BtfKind.UNKN:
        return join("void");
      case BtfKind.INT:
      case BtfKind.FLOAT:
      case BtfKind.TYPEDEF:
        return join(t.name || "?");
      case BtfKind.STRUCT:
        return join("struct " + (t.name || "{...}"));
      case BtfKind.UNION:
        return join("union " + (t.name || "{...}"));
      case BtfKind.ENUM:
      case BtfKind.ENUM64:
        return join("enum " + (t.name || "{...}"));
      case BtfKind.FWD:
        return join((t.fwdUnion ? "union " : "struct ") + (t.name || "?"));
      case BtfKind.PTR: {
        const target = this.types[t.ref ?? 0];
        const next = target && this.stripQuals(target);
        if (next && (next.kind === BtfKind.ARRAY || next.kind === BtfKind.FUNC_PROTO)) {
          return this.decl(t.ref ?? 0, "(*" + inner + ")", pre, depth + 1);
        }
        return this.decl(t.ref ?? 0, "*" + inner, pre, depth + 1);
      }
      case BtfKind.ARRAY: {
        const a = t.array!;
        return this.decl(a.elemType, inner + "[" + a.nelems + "]", pre, depth + 1);
      }
      case BtfKind.CONST:
      case BtfKind.VOLATILE:
      case BtfKind.RESTRICT: {
        const q = t.kind === BtfKind.CONST ? "const" : t.kind === BtfKind.VOLATILE ? "volatile" : "restrict";
        const target = this.types[t.ref ?? 0];
        if (target && target.kind === BtfKind.PTR) {
          // qualifier applies to the pointer itself: "char *const"
          return this.decl(t.ref ?? 0, q + (inner ? " " + inner : ""), pre, depth + 1);
        }
        return this.decl(t.ref ?? 0, inner, q + " " + pre, depth + 1);
      }
      case BtfKind.TYPE_TAG:
        return this.decl(t.ref ?? 0, inner, pre, depth + 1);
      case BtfKind.FUNC_PROTO: {
        const ps = t.params ?? [];
        const parts = ps.map((p) => (p.type === 0 && p.name === "" ? "..." : this.typeName(p.type)));
        const list = parts.length === 0 ? "void" : parts.join(", ");
        return this.decl(t.ref ?? 0, inner + "(" + list + ")", pre, depth + 1);
      }
      case BtfKind.FUNC:
        return this.decl(t.ref ?? 0, t.name ? t.name : inner, pre, depth + 1);
      case BtfKind.VAR:
        return this.decl(t.ref ?? 0, inner, pre, depth + 1);
      case BtfKind.DATASEC:
        return join("datasec " + t.name);
      default:
        return join("?");
    }
  }

  private stripQuals(t: BtfType): BtfType {
    for (let g = 0; g < 64; g++) {
      if (
        t.kind === BtfKind.CONST ||
        t.kind === BtfKind.VOLATILE ||
        t.kind === BtfKind.RESTRICT ||
        t.kind === BtfKind.TYPE_TAG
      ) {
        t = this.types[t.ref ?? 0] ?? t;
      } else break;
    }
    return t;
  }
}

export function parseBtf(buf: ArrayBuffer | Uint8Array): Btf {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength < 24) throw new Error("BTF: blob too small for header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(0, true);
  if (magic !== BTF_MAGIC) {
    throw new Error(
      magic === 0x9feb ? "BTF: big-endian BTF is not supported" : `BTF: bad magic 0x${magic.toString(16)}`,
    );
  }
  const version = dv.getUint8(2);
  if (version !== 1) throw new Error(`BTF: unsupported version ${version}`);
  const hdrLen = dv.getUint32(4, true);
  const typeOff = dv.getUint32(8, true);
  const typeLen = dv.getUint32(12, true);
  const strOff = dv.getUint32(16, true);
  const strLen = dv.getUint32(20, true);
  const typeBase = hdrLen + typeOff;
  const strBase = hdrLen + strOff;
  if (typeBase + typeLen > bytes.byteLength || strBase + strLen > bytes.byteLength) {
    throw new Error("BTF: sections extend beyond blob");
  }

  const ctx = makeCtx(bytes, strBase, strLen);
  const types: BtfType[] = [];
  types.push(new TypeImpl(ctx, 0, BtfKind.UNKN, 0, 0, false, 0));
  (types[0] as TypeImpl).size = 0;

  const end = typeBase + typeLen;
  let o = typeBase;
  let id = 1;
  while (o < end) {
    if (o + 12 > end) throw new Error("BTF: truncated type record");
    const nameOff = dv.getUint32(o, true);
    const info = dv.getUint32(o + 4, true);
    const sizeType = dv.getUint32(o + 8, true);
    const vlen = info & 0xffff;
    const kind = ((info >>> 24) & 0x1f) as BtfKind;
    const kindFlag = (info >>> 31) !== 0;
    const dataOff = o + 12;
    const t = new TypeImpl(ctx, id, kind, nameOff, vlen, kindFlag, dataOff);
    let extra = 0;
    switch (kind) {
      case BtfKind.INT: {
        t.size = sizeType;
        const v = dv.getUint32(dataOff, true);
        const enc = (v >>> 24) & 0xf;
        t.intEncoding = {
          signed: (enc & 1) !== 0,
          char: (enc & 2) !== 0,
          bool: (enc & 4) !== 0,
          bitOffset: (v >>> 16) & 0xff,
          bits: v & 0xff,
        };
        extra = 4;
        break;
      }
      case BtfKind.PTR:
      case BtfKind.TYPEDEF:
      case BtfKind.VOLATILE:
      case BtfKind.CONST:
      case BtfKind.RESTRICT:
      case BtfKind.TYPE_TAG:
        t.ref = sizeType;
        break;
      case BtfKind.FUNC:
        t.ref = sizeType;
        t.linkage = vlen;
        break;
      case BtfKind.FUNC_PROTO:
        t.ref = sizeType;
        extra = vlen * 8;
        break;
      case BtfKind.ARRAY:
        extra = 12;
        break;
      case BtfKind.STRUCT:
      case BtfKind.UNION:
        t.size = sizeType;
        extra = vlen * 12;
        break;
      case BtfKind.ENUM:
        t.size = sizeType;
        t.signed = kindFlag;
        extra = vlen * 8;
        break;
      case BtfKind.ENUM64:
        t.size = sizeType;
        t.signed = kindFlag;
        extra = vlen * 12;
        break;
      case BtfKind.FWD:
        t.fwdUnion = kindFlag;
        break;
      case BtfKind.VAR:
        t.ref = sizeType;
        t.linkage = dv.getUint32(dataOff, true);
        extra = 4;
        break;
      case BtfKind.DATASEC:
        t.size = sizeType;
        extra = vlen * 12;
        break;
      case BtfKind.FLOAT:
        t.size = sizeType;
        break;
      case BtfKind.DECL_TAG:
        t.ref = sizeType;
        extra = 4;
        break;
      default:
        throw new Error(`BTF: unknown kind ${kind} at type id ${id}`);
    }
    o = dataOff + extra;
    if (o > end) throw new Error(`BTF: type ${id} extends beyond type section`);
    types.push(t);
    id++;
  }
  return new BtfImpl(types);
}
