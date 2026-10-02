// Self-contained fakes for testing debug helpers: a tiny BTF, sparse fake memory,
// and Program/Value implementations behind the contract interfaces in src/debug/api.ts.
// Also builds the (reduced) Linux 6.12 i386 structs the helpers need, plus
// builders for rb-trees, maple trees, tasks and VMAs.

import type { Btf, BtfMember, BtfType, Program, Symbols, TypeId, Value } from "../../src/debug/api";
import { BtfKind } from "../../src/debug/api";
import { PageFault } from "../../src/vm/types";
import type { Memory } from "../../src/vm/types";

// ---------------------------------------------------------------- memory

export class FakeMem implements Memory {
  pages = new Map<number, Uint8Array>();
  private bump = 0xc1000000;

  mapRange(addr: number, len: number): void {
    for (let p = addr >>> 12; p <= ((addr + len - 1) >>> 12); p++) {
      if (!this.pages.has(p)) this.pages.set(p, new Uint8Array(4096));
    }
  }
  read(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const a = (addr + i) >>> 0;
      const pg = this.pages.get(a >>> 12);
      if (!pg) throw new PageFault(a, "pte");
      out[i] = pg[a & 0xfff];
    }
    return out;
  }
  writeBytes(addr: number, bytes: ArrayLike<number>): void {
    this.mapRange(addr, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const a = (addr + i) >>> 0;
      this.pages.get(a >>> 12)![a & 0xfff] = bytes[i];
    }
  }
  writeUint(addr: number, size: number, v: number | bigint): void {
    let x = BigInt.asUintN(size * 8, BigInt(v));
    const b: number[] = [];
    for (let i = 0; i < size; i++) { b.push(Number(x & 0xffn)); x >>= 8n; }
    this.writeBytes(addr, b);
  }
  /** Allocate zeroed, mapped memory. */
  alloc(size: number, align = 4): number {
    this.bump = Math.ceil(this.bump / align) * align;
    const a = this.bump;
    this.bump += size;
    this.mapRange(a, size);
    return a;
  }
}

// ---------------------------------------------------------------- BTF

export type Spec = string | number;

export class FakeBtf implements Btf {
  types: BtfType[] = [{ id: 0, kind: BtfKind.UNKN, name: "" }];
  readonly pointerSize = 4;
  private names = new Map<string, TypeId>();
  private vars = new Map<string, TypeId>();
  private ptrs = new Map<TypeId, TypeId>();

  constructor() {
    this.int("u8", 1, false); this.int("u16", 2, false); this.int("u32", 4, false);
    this.int("u64", 8, false); this.int("s32", 4, true); this.int("s64", 8, true);
    this.int("char", 1, true);
  }
  private add(t: Omit<BtfType, "id">, key?: string): TypeId {
    const id = this.types.length;
    this.types.push({ ...t, id });
    if (key) this.names.set(key, id);
    return id;
  }
  int(name: string, size: number, signed: boolean): TypeId {
    return this.add({ kind: BtfKind.INT, name, size, intEncoding: { signed, char: false, bool: false, bitOffset: 0, bits: size * 8 } }, name);
  }
  ptr(ref: TypeId): TypeId {
    let id = this.ptrs.get(ref);
    if (id === undefined) { id = this.add({ kind: BtfKind.PTR, name: "", ref }); this.ptrs.set(ref, id); }
    return id;
  }
  array(elem: TypeId, n: number): TypeId {
    return this.add({ kind: BtfKind.ARRAY, name: "", array: { elemType: elem, indexType: this.names.get("u32")!, nelems: n } });
  }
  typedef(name: string, ref: TypeId): TypeId {
    return this.add({ kind: BtfKind.TYPEDEF, name, ref }, name);
  }
  spec(s: Spec): TypeId {
    if (typeof s === "number") return s;
    const arr = /^(.*)\[(\d+)\]$/.exec(s);
    if (arr) return this.array(this.spec(arr[1]), Number(arr[2]));
    if (s.startsWith("ptr:")) { const r = s.slice(4); return this.ptr(r === "void" ? 0 : this.spec(r)); }
    const id = this.names.get(s);
    if (id === undefined) throw new Error(`fake btf: unknown type spec '${s}'`);
    return id;
  }
  private align(id: TypeId): number {
    const t = this.resolve(id);
    switch (t.kind) {
      case BtfKind.ARRAY: return this.align(t.array!.elemType);
      case BtfKind.STRUCT: case BtfKind.UNION:
        return Math.max(1, ...(t.members ?? []).map((m) => this.align(m.type)));
      default: return Math.min(4, Math.max(1, this.sizeOf(id)));
    }
  }
  /**
   * Define a struct/union with natural layout (i386: 8-byte ints align to 4).
   * Member name "" = anonymous member. `size` forces the total size (padding).
   */
  struct(name: string | null, fields: Array<[string, Spec]>, opts: { union?: boolean; size?: number } = {}): TypeId {
    const members: BtfMember[] = [];
    let off = 0, maxsz = 0, maxal = 1;
    for (const [n, s] of fields) {
      const ty = this.spec(s);
      const al = this.align(ty), sz = this.sizeOf(ty);
      maxal = Math.max(maxal, al);
      if (!opts.union) off = Math.ceil(off / al) * al;
      members.push({ name: n, type: ty, bitOffset: (opts.union ? 0 : off) * 8, bitSize: 0 });
      if (opts.union) maxsz = Math.max(maxsz, sz); else off += sz;
    }
    let size = Math.ceil((opts.union ? maxsz : off) / maxal) * maxal;
    if (opts.size !== undefined) { if (opts.size < size) throw new Error(`${name}: size too small`); size = opts.size; }
    const kind = opts.union ? BtfKind.UNION : BtfKind.STRUCT;
    const prefix = opts.union ? "union " : "struct ";
    return this.add({ kind, name: name ?? "", size, members }, name ? prefix + name : undefined);
  }
  declareVar(name: string, type: TypeId): void { this.vars.set(name, type); }

  find(name: string): BtfType | undefined { const id = this.names.get(name); return id === undefined ? undefined : this.types[id]; }
  findVar(name: string): BtfType | undefined {
    const id = this.vars.get(name);
    return id === undefined ? undefined : { id: -1, kind: BtfKind.VAR, name, ref: id };
  }
  varType(name: string): TypeId | undefined { return this.vars.get(name); }
  resolve(id: TypeId): BtfType {
    let t = this.types[id];
    while (t.kind === BtfKind.TYPEDEF || t.kind === BtfKind.CONST || t.kind === BtfKind.VOLATILE ||
      t.kind === BtfKind.RESTRICT || t.kind === BtfKind.TYPE_TAG) t = this.types[t.ref!];
    return t;
  }
  sizeOf(id: TypeId): number {
    const t = this.resolve(id);
    if (t.kind === BtfKind.PTR) return this.pointerSize;
    if (t.kind === BtfKind.ARRAY) return t.array!.nelems * this.sizeOf(t.array!.elemType);
    return t.size ?? 0;
  }
  typeName(id: TypeId): string {
    const t = this.types[id];
    if (id === 0) return "void";
    if (t.kind === BtfKind.PTR) return this.typeName(t.ref!) + " *";
    if (t.kind === BtfKind.ARRAY) return `${this.typeName(t.array!.elemType)} [${t.array!.nelems}]`;
    if (t.kind === BtfKind.STRUCT) return "struct " + t.name;
    if (t.kind === BtfKind.UNION) return "union " + t.name;
    return t.name;
  }
}

// ---------------------------------------------------------------- Program / Value

function findMember(btf: FakeBtf, type: TypeId, name: string): { off: number; type: TypeId } | undefined {
  const t = btf.resolve(type);
  if (t.kind !== BtfKind.STRUCT && t.kind !== BtfKind.UNION) throw new Error(`member '${name}' of non-struct ${btf.typeName(type)}`);
  for (const m of t.members!) {
    if (m.name === name) return { off: m.bitOffset / 8, type: m.type };
    if (m.name === "") {
      const r = findMember(btf, m.type, name);
      if (r) return { off: m.bitOffset / 8 + r.off, type: r.type };
    }
  }
  return undefined;
}

export class FakeValue implements Value {
  constructor(readonly prog: FakeProgram, readonly mem: Memory, readonly addr: number, readonly type: TypeId) {}
  private get btf() { return this.prog.fbtf; }
  member(path: string): Value {
    let addr = this.addr, type = this.type;
    for (const seg of path.split(".")) {
      const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(seg);
      if (!m) throw new Error(`bad path ${path}`);
      const r = findMember(this.btf, type, m[1]);
      if (!r) throw new Error(`no member '${m[1]}' in ${this.btf.typeName(type)} (path ${path})`);
      addr = (addr + r.off) >>> 0; type = r.type;
      if (m[2] !== undefined) {
        const at = this.btf.resolve(type);
        if (at.kind !== BtfKind.ARRAY) throw new Error(`${seg} not an array`);
        addr = (addr + Number(m[2]) * this.btf.sizeOf(at.array!.elemType)) >>> 0;
        type = at.array!.elemType;
      }
    }
    return new FakeValue(this.prog, this.mem, addr, type);
  }
  deref(): Value {
    const t = this.btf.resolve(this.type);
    if (t.kind !== BtfKind.PTR) throw new Error("deref of non-pointer");
    if (!t.ref) throw new Error("deref of void *");
    const p = this.ptr();
    if (p === 0) throw new Error("NULL pointer dereference");
    return new FakeValue(this.prog, this.mem, p, t.ref);
  }
  index(i: number): Value {
    const t = this.btf.resolve(this.type);
    if (t.kind === BtfKind.ARRAY) {
      return new FakeValue(this.prog, this.mem, (this.addr + i * this.btf.sizeOf(t.array!.elemType)) >>> 0, t.array!.elemType);
    }
    if (t.kind === BtfKind.PTR && t.ref) {
      return new FakeValue(this.prog, this.mem, (this.ptr() + i * this.btf.sizeOf(t.ref)) >>> 0, t.ref);
    }
    throw new Error("index of non-array");
  }
  cast(type: string | TypeId): Value { return new FakeValue(this.prog, this.mem, this.addr, this.prog.resolveSpec(type)); }
  read(): number | bigint {
    const t = this.btf.resolve(this.type);
    const size = t.kind === BtfKind.PTR ? 4 : this.btf.sizeOf(this.type);
    if (t.kind !== BtfKind.INT && t.kind !== BtfKind.PTR && t.kind !== BtfKind.ENUM) throw new Error(`cannot read ${this.btf.typeName(this.type)}`);
    const b = this.mem.read(this.addr, size);
    let x = 0n;
    for (let i = size - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
    if (t.kind === BtfKind.INT && t.intEncoding!.signed) x = BigInt.asIntN(size * 8, x);
    return size === 8 ? x : Number(x);
  }
  num(): number { return Number(this.read()); }
  ptr(): number { return Number(this.read()) >>> 0; }
  isNull(): boolean { return this.ptr() === 0; }
  cstr(max = 4096): string {
    const t = this.btf.resolve(this.type);
    let addr = this.addr, limit = max;
    if (t.kind === BtfKind.ARRAY) limit = Math.min(max, this.btf.sizeOf(this.type));
    else if (t.kind === BtfKind.PTR) addr = this.ptr();
    const out: number[] = [];
    for (let i = 0; i < limit; i++) {
      const c = this.mem.read((addr + i) >>> 0, 1)[0];
      if (c === 0) break;
      out.push(c);
    }
    return String.fromCharCode(...out);
  }
  enumName(): string { return String(this.read()); }
  typeName(): string { return this.btf.typeName(this.type); }
  sizeOf(): number { return this.btf.sizeOf(this.type); }
  bytes(): Uint8Array { return this.mem.read(this.addr, this.sizeOf()); }
}

export class FakeProgram implements Program {
  readonly symbols: Symbols;
  private syms = new Map<string, number>();
  private varAddr = new Map<string, number>();
  constructor(readonly fbtf: FakeBtf, readonly fmem: FakeMem) {
    const syms = this.syms;
    this.symbols = {
      addr: (n) => syms.get(n),
      lookup: () => undefined,
      format: (a) => "0x" + a.toString(16),
      all: [],
    };
  }
  get btf(): Btf { return this.fbtf; }
  get mem(): Memory { return this.fmem; }
  resolveSpec(t: string | TypeId): TypeId { return typeof t === "number" ? t : this.typeId(t); }
  defineSymbol(name: string, addr: number): void { this.syms.set(name, addr); }
  /** Declare a global variable of `type` (allocating storage unless addr is given). */
  defineVar(name: string, type: string | TypeId, addr?: number): number {
    const id = this.resolveSpec(type);
    const a = addr ?? this.fmem.alloc(Math.max(4, this.fbtf.sizeOf(id)), 8);
    this.fbtf.declareVar(name, id);
    this.varAddr.set(name, a);
    this.syms.set(name, a);
    return a;
  }
  var(name: string): Value {
    const t = this.fbtf.varType(name), a = this.varAddr.get(name);
    if (t === undefined || a === undefined) throw new Error(`unknown variable ${name}`);
    return new FakeValue(this, this.fmem, a, t);
  }
  value(addr: number, type: string | TypeId, mem?: Memory): Value {
    return new FakeValue(this, mem ?? this.fmem, addr >>> 0, this.resolveSpec(type));
  }
  typeId(name: string): TypeId {
    const m = /^(.*\S)\s*\*$/.exec(name);
    if (m) return this.fbtf.ptr(m[1].trim() === "void" ? 0 : this.typeId(m[1]));
    return this.fbtf.spec(name);
  }
  offsetOf(type: string | TypeId, path: string): number {
    return this.value(0, type).member(path).addr;
  }
  sizeOf(type: string | TypeId): number { return this.fbtf.sizeOf(this.resolveSpec(type)); }
  containerOf(ptr: number, type: string | TypeId, memberPath: string): Value {
    return this.value((ptr - this.offsetOf(type, memberPath)) >>> 0, type);
  }
  readU8(a: number): number { return this.fmem.read(a, 1)[0]; }
  readU16(a: number): number { const b = this.fmem.read(a, 2); return b[0] | (b[1] << 8); }
  readU32(a: number): number { const b = this.fmem.read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  readU64(a: number): bigint { return BigInt(this.readU32(a)) | (BigInt(this.readU32(a + 4)) << 32n); }
  enumValue(): bigint | undefined { return undefined; }

  /** Write an integer/pointer/string into `addr`+path of `type` (path may contain [i]). */
  set(addr: number, type: string | TypeId, path: string, val: number | bigint | string): void {
    const v = this.value(addr, type).member(path) as FakeValue;
    const t = this.fbtf.resolve(v.type);
    if (typeof val === "string") {
      const max = this.fbtf.sizeOf(v.type);
      const b = new Uint8Array(max);
      for (let i = 0; i < Math.min(val.length, max - 1); i++) b[i] = val.charCodeAt(i);
      this.fmem.writeBytes(v.addr, b);
    } else {
      this.fmem.writeUint(v.addr, t.kind === BtfKind.PTR ? 4 : this.fbtf.sizeOf(v.type), val);
    }
  }
}

// ---------------------------------------------------------------- 6.12 i386 struct subset

export interface KernelOpts {
  /** MAPLE_RANGE64_SLOTS (default 32, the 32-bit value). */
  rangeSlots?: number;
  /** MAPLE_ARANGE64_SLOTS (default 21). */
  arangeSlots?: number;
}

export interface Kernel {
  prog: FakeProgram;
  mem: FakeMem;
  btf: FakeBtf;
  rangeSlots: number;
  arangeSlots: number;
}

export function buildKernel(opts: KernelOpts = {}): Kernel {
  const R = opts.rangeSlots ?? 32, A = opts.arangeSlots ?? 21;
  const N = 2 * R - 1; // MAPLE_NODE_SLOTS
  const btf = new FakeBtf();
  const mem = new FakeMem();
  const S = (n: string | null, f: Array<[string, Spec]>, o?: { union?: boolean; size?: number }) => btf.struct(n, f, o);

  // list / hlist / rbtree (self-referential pointers are patched after definition)
  S("list_head", [["next", "ptr:void"], ["prev", "ptr:void"]]);
  const lh = btf.find("struct list_head")!;
  lh.members![0].type = btf.ptr(lh.id); lh.members![1].type = btf.ptr(lh.id);
  S("hlist_node", [["next", "ptr:void"], ["pprev", "ptr:void"]]);
  S("hlist_head", [["first", "ptr:struct hlist_node"]]);
  S("rb_node", [["__rb_parent_color", "u32"], ["rb_right", "ptr:void"], ["rb_left", "ptr:void"]]);
  const rbn = btf.find("struct rb_node")!;
  rbn.members![1].type = btf.ptr(rbn.id); rbn.members![2].type = btf.ptr(rbn.id);
  S("rb_root", [["rb_node", "ptr:struct rb_node"]]);
  S("rb_root_cached", [["rb_root", "struct rb_root"], ["rb_leftmost", "ptr:struct rb_node"]]);

  // maple tree
  S("maple_metadata", [["end", "u8"], ["gap", "u8"]]);
  const rmeta = S(null, [["pad", `ptr:void[${R - 1}]`], ["meta", "struct maple_metadata"]]);
  const rslots = S(null, [["slot", `ptr:void[${R}]`], ["", rmeta]], { union: true });
  S("maple_range_64", [["parent", "ptr:void"], ["pivot", `u32[${R - 1}]`], ["", rslots]]);
  S("maple_arange_64", [["parent", "ptr:void"], ["pivot", `u32[${A - 1}]`], ["slot", `ptr:void[${A}]`],
    ["gap", `u32[${A}]`], ["meta", "struct maple_metadata"]]);
  const dense = S(null, [["parent", "ptr:void"], ["slot", `ptr:void[${N}]`]]);
  S("maple_node", [["", S(null, [["", dense], ["mr64", "struct maple_range_64"], ["ma64", "struct maple_arange_64"]], { union: true })]],
    { size: 256 });
  S("maple_tree", [["", S(null, [["ma_lock", "u32"], ["ma_external_lock", "ptr:void"]], { union: true })],
    ["ma_flags", "u32"], ["ma_root", "ptr:void"]]);

  // dentry / file / inode
  S("qstr", [["", S(null, [["", S(null, [["hash", "u32"], ["len", "u32"]])], ["hash_len", "u64"]], { union: true })],
    ["name", "ptr:char"]]);
  S("dentry", [["d_parent", "ptr:void"], ["d_name", "struct qstr"], ["d_iname", "char[40]"]]);
  const de = btf.find("struct dentry")!;
  de.members![0].type = btf.ptr(de.id);
  S("super_block", [["s_dev", "u32"]]);
  S("inode", [["i_sb", "ptr:struct super_block"], ["i_ino", "u32"]]);
  S("path", [["mnt", "ptr:void"], ["dentry", "ptr:struct dentry"]]);
  S("file", [["f_path", "struct path"], ["f_inode", "ptr:struct inode"]]);

  // mm
  S("vm_area_struct", [
    ["", S(null, [["", S(null, [["vm_start", "u32"], ["vm_end", "u32"]])]], { union: true })],
    ["vm_mm", "ptr:void"], ["vm_flags", "u32"], ["vm_pgoff", "u32"], ["vm_file", "ptr:struct file"],
  ]);
  S("mm_context_t", [["vdso", "ptr:void"]]);
  S("mm_struct", [["mm_mt", "struct maple_tree"], ["pgd", "ptr:void"], ["start_brk", "u32"], ["brk", "u32"],
    ["start_stack", "u32"], ["context", "struct mm_context_t"]]);

  // sched
  S("load_weight", [["weight", "u32"], ["inv_weight", "u32"]]);
  S("sched_entity", [["load", "struct load_weight"], ["run_node", "struct rb_node"], ["deadline", "u64"],
    ["min_vruntime", "u64"], ["min_slice", "u64"], ["on_rq", "u8"], ["sched_delayed", "u8"],
    ["vruntime", "u64"], ["vlag", "s64"], ["slice", "u64"]]);
  S("signal_struct", [["thread_head", "struct list_head"]]);
  S("task_struct", [["__state", "u32"], ["flags", "u32"], ["prio", "s32"], ["se", "struct sched_entity"],
    ["mm", "ptr:struct mm_struct"], ["exit_state", "s32"], ["pid", "s32"], ["tgid", "s32"],
    ["real_parent", "ptr:void"], ["tasks", "struct list_head"], ["thread_node", "struct list_head"],
    ["signal", "ptr:struct signal_struct"], ["comm", "char[16]"]]);
  const ts = btf.find("struct task_struct")!;
  ts.members!.find((m) => m.name === "real_parent")!.type = btf.ptr(ts.id);
  S("cfs_rq", [["load", "struct load_weight"], ["nr_running", "u32"], ["avg_vruntime", "s64"],
    ["avg_load", "u64"], ["min_vruntime", "u64"], ["tasks_timeline", "struct rb_root_cached"],
    ["curr", "ptr:struct sched_entity"], ["next", "ptr:struct sched_entity"]]);
  S("rq", [["nr_running", "u32"], ["cfs", "struct cfs_rq"], ["curr", "ptr:struct task_struct"],
    ["idle", "ptr:struct task_struct"], ["clock", "u64"]]);
  S("pcpu_hot", [["current_task", "ptr:struct task_struct"], ["preempt_count", "s32"]]);

  const prog = new FakeProgram(btf, mem);
  return { prog, mem, btf, rangeSlots: R, arangeSlots: A };
}

// ---------------------------------------------------------------- builders

/** Allocate a zeroed object of `type`; returns its address. */
export function allocObj(k: Kernel, type: string): number {
  return k.mem.alloc(k.prog.sizeOf(type), 8);
}

/**
 * Build an rb-tree (any valid binary-tree shape; colors all black) over `nodes`
 * (rb_node addresses in ascending order) at the rb_node pointer stored at `rootPtrAddr`.
 * Sets parent pointers (with color bit 0). Returns the root node address.
 */
export function buildRbTree(k: Kernel, rootPtrAddr: number, nodes: number[]): number {
  const p = k.prog;
  const offs = { pc: p.offsetOf("struct rb_node", "__rb_parent_color"), r: p.offsetOf("struct rb_node", "rb_right"), l: p.offsetOf("struct rb_node", "rb_left") };
  const build = (lo: number, hi: number, parent: number): number => {
    if (lo > hi) return 0;
    const mid = (lo + hi) >> 1, n = nodes[mid];
    k.mem.writeUint(n + offs.pc, 4, parent);
    k.mem.writeUint(n + offs.l, 4, build(lo, mid - 1, n));
    k.mem.writeUint(n + offs.r, 4, build(mid + 1, hi, n));
    return n;
  };
  const root = build(0, nodes.length - 1, 0);
  k.mem.writeUint(rootPtrAddr, 4, root);
  return root;
}

export interface MapleRange { first: number; last: number; entry: number; }

/**
 * Build a maple tree at `mtAddr` (struct maple_tree) holding `ranges` (sorted,
 * non-overlapping, inclusive). Gaps become NULL entries. `fanout` caps slots per
 * node (to force multiple levels with few entries). `alloc` makes internal nodes
 * maple_arange_64 (MT_FLAGS_ALLOC_RANGE trees).
 */
export function buildMapleTree(
  k: Kernel, mtAddr: number, ranges: MapleRange[],
  opts: { fanout?: number; alloc?: boolean } = {},
): void {
  const { prog, mem } = k;
  const ULONG_MAX = 0xffffffff;
  const alloc = opts.alloc ?? false;
  const fan = opts.fanout ?? 1000;
  // fill gaps so that slots cover [0, ULONG_MAX]
  const cover: MapleRange[] = [];
  let next = 0;
  for (const r of ranges) {
    if (r.first > next) cover.push({ first: next, last: r.first - 1, entry: 0 });
    cover.push(r);
    next = r.last + 1;
    if (r.last === ULONG_MAX) next = -1;
  }
  if (next !== -1 && next <= ULONG_MAX) cover.push({ first: next, last: ULONG_MAX, entry: 0 });

  const writeNode = (items: MapleRange[], leaf: boolean): MapleRange => {
    const arange = !leaf && alloc;
    const type = leaf ? 1 : arange ? 3 : 2;
    const f = arange ? "ma64" : "mr64";
    const nslots = arange ? k.arangeSlots : k.rangeSlots;
    const npivot = nslots - 1;
    const addr = mem.alloc(256, 256);
    const max = items[items.length - 1].last;
    const cnt = items.length;
    if (cnt > nslots) throw new Error("too many items for node");
    items.forEach((it, i) => {
      prog.set(addr, "struct maple_node", `${f}.slot[${i}]`, it.entry);
      if (i < cnt - 1) prog.set(addr, "struct maple_node", `${f}.pivot[${i}]`, it.last);
    });
    if (cnt - 1 < npivot) prog.set(addr, "struct maple_node", `${f}.pivot[${cnt - 1}]`, max);
    // metadata: only meaningful when the last pivot slot is unused (0)
    if (arange) prog.set(addr, "struct maple_node", "ma64.meta.end", cnt - 1);
    else if (cnt < nslots) prog.set(addr, "struct maple_node", "mr64.meta.end", cnt - 1);
    return { first: items[0].first, last: max, entry: (addr | (type << 3) | 2) >>> 0 };
  };
  const pack = (items: MapleRange[], leaf: boolean): MapleRange[] => {
    const nslots = !leaf && alloc ? k.arangeSlots : k.rangeSlots;
    const per = Math.max(leaf ? 1 : 2, Math.min(fan, nslots));
    const out: MapleRange[] = [];
    for (let i = 0; i < items.length; i += per) out.push(writeNode(items.slice(i, i + per), leaf));
    return out;
  };
  let level = pack(cover, true);
  while (level.length > 1) level = pack(level, false);
  prog.set(mtAddr, "struct maple_tree", "ma_root", level[0].entry);
  prog.set(mtAddr, "struct maple_tree", "ma_flags", alloc ? 1 : 0);
}

/** Link `nodes` (list_head addresses) into a circular list rooted at `head`. */
export function linkList(k: Kernel, head: number, nodes: number[]): void {
  const chain = [head, ...nodes, head];
  for (let i = 0; i < chain.length - 1; i++) {
    k.prog.set(chain[i], "struct list_head", "next", chain[i + 1]);
    k.prog.set(chain[i + 1], "struct list_head", "prev", chain[i]);
  }
}
