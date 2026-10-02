// Tiny BTF encoder for tests. Each declaring method returns the new type id.

export interface MemberSpec {
  name: string;
  type: number;
  /** byte offset (ignored if bitOffset given) */
  offset?: number;
  /** bit offset from start of struct */
  bitOffset?: number;
  /** bitfield width; if any member sets it the struct uses kind_flag=1 */
  bitSize?: number;
}

const K = {
  INT: 1, PTR: 2, ARRAY: 3, STRUCT: 4, UNION: 5, ENUM: 6, FWD: 7, TYPEDEF: 8, VOLATILE: 9, CONST: 10,
  RESTRICT: 11, FUNC: 12, FUNC_PROTO: 13, VAR: 14, DATASEC: 15, FLOAT: 16, DECL_TAG: 17, TYPE_TAG: 18, ENUM64: 19,
};

export class BtfBuilder {
  private words: number[] = [];
  private strBytes: number[] = [0];
  private strMap = new Map<string, number>();
  private nextId = 1;
  /** Id the next declared type will receive (for forward references). */
  get peekId(): number { return this.nextId; }

  private str(s: string): number {
    if (s === "") return 0;
    const hit = this.strMap.get(s);
    if (hit !== undefined) return hit;
    const off = this.strBytes.length;
    for (const b of new TextEncoder().encode(s)) this.strBytes.push(b);
    this.strBytes.push(0);
    this.strMap.set(s, off);
    return off;
  }

  private emit(name: string, kind: number, vlen: number, flag: boolean, sizeType: number, extra: number[] = []): number {
    this.words.push(this.str(name), ((flag ? 1 : 0) << 31) | (kind << 24) | vlen, sizeType >>> 0, ...extra);
    return this.nextId++;
  }

  int(name: string, size: number, o: { signed?: boolean; char?: boolean; bool?: boolean; offset?: number; bits?: number } = {}): number {
    const enc = (o.signed ? 1 : 0) | (o.char ? 2 : 0) | (o.bool ? 4 : 0);
    const v = (enc << 24) | ((o.offset ?? 0) << 16) | (o.bits ?? size * 8);
    return this.emit(name, K.INT, 0, false, size, [v >>> 0]);
  }
  float(name: string, size: number): number { return this.emit(name, K.FLOAT, 0, false, size); }
  ptr(ref: number): number { return this.emit("", K.PTR, 0, false, ref); }
  typedef(name: string, ref: number): number { return this.emit(name, K.TYPEDEF, 0, false, ref); }
  const(ref: number): number { return this.emit("", K.CONST, 0, false, ref); }
  volatile(ref: number): number { return this.emit("", K.VOLATILE, 0, false, ref); }
  restrict(ref: number): number { return this.emit("", K.RESTRICT, 0, false, ref); }
  typeTag(name: string, ref: number): number { return this.emit(name, K.TYPE_TAG, 0, false, ref); }
  declTag(name: string, ref: number, idx = -1): number { return this.emit(name, K.DECL_TAG, 0, false, ref, [idx >>> 0]); }
  array(elem: number, nelems: number, indexType = 0): number {
    return this.emit("", K.ARRAY, 0, false, 0, [elem, indexType, nelems]);
  }
  fwd(name: string, union = false): number { return this.emit(name, K.FWD, 0, union, 0); }

  private agg(kind: number, name: string, size: number, members: MemberSpec[]): number {
    const flag = members.some((m) => (m.bitSize ?? 0) > 0);
    const extra: number[] = [];
    for (const m of members) {
      const bo = m.bitOffset ?? (m.offset ?? 0) * 8;
      const off = flag ? (((m.bitSize ?? 0) << 24) | bo) >>> 0 : bo;
      extra.push(this.str(m.name), m.type, off);
    }
    return this.emit(name, kind, members.length, flag, size, extra);
  }
  struct(name: string, size: number, members: MemberSpec[]): number { return this.agg(K.STRUCT, name, size, members); }
  union(name: string, size: number, members: MemberSpec[]): number { return this.agg(K.UNION, name, size, members); }

  enum(name: string, size: number, values: [string, number][], signed = false): number {
    const extra: number[] = [];
    for (const [n, v] of values) extra.push(this.str(n), v >>> 0);
    return this.emit(name, K.ENUM, values.length, signed, size, extra);
  }
  enum64(name: string, size: number, values: [string, bigint][], signed = false): number {
    const extra: number[] = [];
    for (const [n, v] of values) {
      const u = BigInt.asUintN(64, v);
      extra.push(this.str(n), Number(u & 0xffffffffn), Number(u >> 32n));
    }
    return this.emit(name, K.ENUM64, values.length, signed, size, extra);
  }

  funcProto(ret: number, params: { name?: string; type: number }[] = []): number {
    const extra: number[] = [];
    for (const p of params) extra.push(this.str(p.name ?? ""), p.type);
    return this.emit("", K.FUNC_PROTO, params.length, false, ret, extra);
  }
  func(name: string, proto: number, linkage = 1): number { return this.emit(name, K.FUNC, linkage, false, proto); }
  var(name: string, type: number, linkage = 1): number { return this.emit(name, K.VAR, 0, false, type, [linkage]); }
  datasec(name: string, size: number, secs: { type: number; offset: number; size: number }[]): number {
    const extra: number[] = [];
    for (const s of secs) extra.push(s.type, s.offset, s.size);
    return this.emit(name, K.DATASEC, secs.length, false, size, extra);
  }

  build(): Uint8Array {
    const typeLen = this.words.length * 4;
    const out = new Uint8Array(24 + typeLen + this.strBytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 0xeb9f, true);
    dv.setUint8(2, 1);
    dv.setUint8(3, 0);
    dv.setUint32(4, 24, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, typeLen, true);
    dv.setUint32(16, typeLen, true);
    dv.setUint32(20, this.strBytes.length, true);
    this.words.forEach((w, i) => dv.setUint32(24 + i * 4, w >>> 0, true));
    out.set(this.strBytes, 24 + typeLen);
    return out;
  }
}
