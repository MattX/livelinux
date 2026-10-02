import { describe, expect, it } from "vitest";
import { parseBtf } from "../src/debug/btf";
import { BtfKind } from "../src/debug/api";
import { BtfBuilder } from "./util/btfBuilder";
import { buildFixture } from "./util/fixture";

describe("parseBtf", () => {
  const { blob, ids } = buildFixture();
  const btf = parseBtf(blob);

  it("rejects bad magic / truncated blobs", () => {
    expect(() => parseBtf(new Uint8Array(4))).toThrow();
    const bad = blob.slice();
    bad[0] = 0;
    expect(() => parseBtf(bad)).toThrow(/magic/);
  });

  it("accepts ArrayBuffer and offset Uint8Array views", () => {
    const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
    expect(parseBtf(ab).types.length).toBe(btf.types.length);
    const padded = new Uint8Array(blob.length + 3);
    padded.set(blob, 3);
    expect(parseBtf(padded.subarray(3)).types.length).toBe(btf.types.length);
  });

  it("has void at id 0 and sequential ids", () => {
    expect(btf.types[0].kind).toBe(BtfKind.UNKN);
    btf.types.forEach((t, i) => expect(t.id).toBe(i));
    expect(btf.pointerSize).toBe(4);
  });

  it("parses INT encodings", () => {
    const c = btf.types[ids.char];
    expect(c.name).toBe("char");
    expect(c.size).toBe(1);
    expect(c.intEncoding).toEqual({ signed: true, char: true, bool: false, bitOffset: 0, bits: 8 });
    expect(btf.types[ids.bool].intEncoding!.bool).toBe(true);
    expect(btf.types[ids.uint].intEncoding!.signed).toBe(false);
  });

  it("parses struct members including bitfields (kind_flag)", () => {
    const t = btf.find("struct task_struct")!;
    expect(t.id).toBe(ids.task_struct);
    expect(t.kind).toBe(BtfKind.STRUCT);
    expect(t.size).toBe(104);
    const m = Object.fromEntries(t.members!.map((x) => [x.name, x]));
    expect(m.pid.bitOffset).toBe(0);
    expect(m.pid.bitSize).toBe(0);
    expect(m.bf_a).toMatchObject({ bitOffset: 96, bitSize: 4 });
    expect(m.bf_b).toMatchObject({ bitOffset: 100, bitSize: 3 });
    expect(m.bf_c).toMatchObject({ bitOffset: 103, bitSize: 12 });
    expect(m.comm.bitOffset).toBe(16 * 8);
    expect(t.members!.some((x) => x.name === "")).toBe(true); // anonymous union
  });

  it("parses arrays, pointers, qualifiers, typedefs", () => {
    expect(btf.types[ids.commArr].array).toEqual({ elemType: ids.char, indexType: ids.int, nelems: 16 });
    expect(btf.types[ids.namePtr].ref).toBe(ids.cchar);
    expect(btf.types[ids.cchar].kind).toBe(BtfKind.CONST);
    expect(btf.types[ids.pid_t].ref).toBe(ids.kpid);
  });

  it("parses ENUM and ENUM64 with signedness", () => {
    const e = btf.find("enum task_state")!;
    expect(e.signed).toBe(true);
    expect(e.size).toBe(4);
    expect(e.enumValues).toEqual([
      { name: "TASK_RUNNING", value: 0n },
      { name: "TASK_SLEEPING", value: 1n },
      { name: "TASK_NEG", value: -1n },
    ]);
    expect(btf.find("uenum")).toBeUndefined();
    expect(btf.find("enum uenum")!.enumValues![0].value).toBe(0xffffffffn);
    const b = btf.find("enum big_enum")!;
    expect(b.kind).toBe(BtfKind.ENUM64);
    expect(b.signed).toBe(false);
    expect(b.enumValues![1].value).toBe(0x1_0000_0001n);
    expect(btf.find("enum sbig_enum")!.enumValues![0].value).toBe(-5n);
  });

  it("parses FWD (struct and union), FUNC_PROTO, VAR, DATASEC", () => {
    expect(btf.types[ids.fwdNodef]).toMatchObject({ kind: BtfKind.FWD, name: "nodef", fwdUnion: false });
    expect(btf.types[ids.fwdU]).toMatchObject({ kind: BtfKind.FWD, name: "fwdunion", fwdUnion: true });
    const fp = btf.types[ids.fnProto];
    expect(fp.kind).toBe(BtfKind.FUNC_PROTO);
    expect(fp.ref).toBe(ids.int);
    expect(fp.params).toEqual([{ name: "t", type: ids.tsPtr }, { name: "", type: 0 }]);
    const v = btf.findVar("init_task")!;
    expect(v.kind).toBe(BtfKind.VAR);
    expect(v.ref).toBe(ids.task_struct);
    expect(v.linkage).toBe(1);
    expect(btf.findVar("nope")).toBeUndefined();
    const ds = btf.types[ids.datasec];
    expect(ds.kind).toBe(BtfKind.DATASEC);
    expect(ds.name).toBe(".data");
    expect(ds.size).toBe(0x100);
    expect(ds.secinfo).toEqual([
      { type: ids.vInit, offset: 0x1000, size: 104 },
      { type: ids.vJiffies, offset: 0xf80, size: 4 },
    ]);
  });

  it("parses FUNC, TYPE_TAG, DECL_TAG, FLOAT, RESTRICT, VOLATILE", () => {
    const b = new BtfBuilder();
    const int = b.int("int", 4, { signed: true });
    const proto = b.funcProto(int, [{ name: "a", type: int }]);
    const fn = b.func("do_it", proto, 2);
    const tag = b.typeTag("user", int);
    const dt = b.declTag("note", int, 0);
    const fl = b.float("float", 4);
    const r = b.restrict(int);
    const vo = b.volatile(int);
    const t = parseBtf(b.build());
    expect(t.types[fn]).toMatchObject({ kind: BtfKind.FUNC, name: "do_it", ref: proto, linkage: 2 });
    expect(t.types[tag]).toMatchObject({ kind: BtfKind.TYPE_TAG, name: "user", ref: int });
    expect(t.types[dt]).toMatchObject({ kind: BtfKind.DECL_TAG, name: "note", ref: int });
    expect(t.types[fl]).toMatchObject({ kind: BtfKind.FLOAT, size: 4 });
    expect(t.resolve(tag).id).toBe(int);
    expect(t.resolve(r).id).toBe(int);
    expect(t.resolve(vo).id).toBe(int);
  });

  describe("find()", () => {
    it("handles struct/union/enum/typedef/base spellings", () => {
      expect(btf.find("struct list_head")!.id).toBe(ids.list_head);
      expect(btf.find("list_head")).toBeUndefined();
      expect(btf.find("u64")!.id).toBe(ids.u64);
      expect(btf.find("typedef u64")!.id).toBe(ids.u64);
      expect(btf.find("unsigned int")!.id).toBe(ids.uint);
      expect(btf.find("  struct   list_head ")!.id).toBe(ids.list_head);
      expect(btf.find("void")!.id).toBe(0);
      expect(btf.find("struct nonexistent")).toBeUndefined();
      expect(btf.find("union task_struct")).toBeUndefined();
    });
    it("accepts C spellings of kernel integer names", () => {
      expect(btf.find("unsigned long")!.id).toBe(ids.ulong);
      expect(btf.find("unsigned short")!.id).toBe(btf.find("short unsigned int")!.id);
      expect(btf.find("unsigned long long")!.id).toBe(ids.ull);
    });
    it("prefers a complete struct over a forward declaration", () => {
      expect(btf.find("struct incomplete")!.kind).toBe(BtfKind.STRUCT);
      expect(btf.find("struct nodef")!.kind).toBe(BtfKind.FWD);
      expect(btf.find("union fwdunion")!.kind).toBe(BtfKind.FWD);
    });
  });

  describe("resolve()", () => {
    it("strips typedef and qualifier chains", () => {
      expect(btf.resolve(ids.pid_t).id).toBe(ids.int);
      expect(btf.resolve(ids.cpid).id).toBe(ids.int);
      expect(btf.resolve(ids.cchar).id).toBe(ids.char);
      expect(btf.resolve(ids.u64).id).toBe(ids.ull);
      expect(btf.resolve(ids.namePtr).kind).toBe(BtfKind.PTR);
    });
    it("throws on invalid ids", () => {
      expect(() => btf.resolve(99999)).toThrow();
    });
  });

  describe("sizeOf()", () => {
    it("handles scalar, pointer, array, struct, enum, typedef chains", () => {
      expect(btf.sizeOf(ids.int)).toBe(4);
      expect(btf.sizeOf(ids.char)).toBe(1);
      expect(btf.sizeOf(ids.u64)).toBe(8);
      expect(btf.sizeOf(ids.pid_t)).toBe(4);
      expect(btf.sizeOf(ids.cpid)).toBe(4);
      expect(btf.sizeOf(ids.tsPtr)).toBe(4);
      expect(btf.sizeOf(ids.fnPtr)).toBe(4);
      expect(btf.sizeOf(ids.commArr)).toBe(16);
      expect(btf.sizeOf(ids.valsArr)).toBe(16);
      expect(btf.sizeOf(ids.task_struct)).toBe(104);
      expect(btf.sizeOf(ids.task_state)).toBe(4);
      expect(btf.sizeOf(ids.big_enum)).toBe(8);
      expect(btf.sizeOf(ids.dbl)).toBe(8);
      expect(btf.sizeOf(0)).toBe(0);
      expect(btf.sizeOf(btf.findVar("init_task")!.id)).toBe(104);
    });
    it("sizes arrays of structs and 2-D arrays", () => {
      const b = new BtfBuilder();
      const int = b.int("int", 4, { signed: true });
      const row = b.array(int, 3);
      const grid = b.array(row, 5);
      const s = b.struct("s", 6, [{ name: "a", type: int }]);
      const arr = b.array(s, 7);
      const t = parseBtf(b.build());
      expect(t.sizeOf(grid)).toBe(60);
      expect(t.sizeOf(arr)).toBe(42);
    });
    it("sizes a FWD via its full definition, else 0", () => {
      expect(btf.sizeOf(ids.fwdInc)).toBe(8);
      expect(btf.sizeOf(ids.fwdNodef)).toBe(0);
    });
  });

  describe("typeName()", () => {
    const tn = (id: number) => btf.typeName(id);
    it("names scalars, typedefs, aggregates, enums", () => {
      expect(tn(0)).toBe("void");
      expect(tn(ids.ulong)).toBe("long unsigned int");
      expect(tn(ids.u64)).toBe("u64");
      expect(tn(ids.task_struct)).toBe("struct task_struct");
      expect(tn(ids.task_state)).toBe("enum task_state");
      expect(tn(ids.anonUnion)).toBe("union {...}");
      expect(tn(ids.fwdU)).toBe("union fwdunion");
    });
    it("names pointers, arrays, qualifiers", () => {
      expect(tn(ids.tsPtr)).toBe("struct task_struct *");
      expect(tn(ids.commArr)).toBe("char [16]");
      expect(tn(ids.namePtr)).toBe("const char *");
      expect(tn(ids.cpid)).toBe("const pid_t");
      expect(tn(ids.ptrVoid)).toBe("void *");
    });
    it("names function pointers approximately", () => {
      expect(tn(ids.fnPtr)).toBe("int (*)(struct task_struct *, ...)");
    });
    it("names compound declarators", () => {
      const b = new BtfBuilder();
      const ch = b.int("char", 1, { signed: true, char: true });
      const int = b.int("int", 4, { signed: true });
      const pp = b.ptr(b.ptr(ch));
      const arrOfPtr = b.array(b.ptr(ch), 4);
      const ptrToArr = b.ptr(b.array(int, 4));
      const constPtr = b.const(b.ptr(ch));
      const vol = b.volatile(int);
      const noargs = b.ptr(b.funcProto(0, []));
      const t = parseBtf(b.build());
      expect(t.typeName(pp)).toBe("char **");
      expect(t.typeName(arrOfPtr)).toBe("char *[4]");
      expect(t.typeName(ptrToArr)).toBe("int (*)[4]");
      expect(t.typeName(constPtr)).toBe("char *const");
      expect(t.typeName(vol)).toBe("volatile int");
      expect(t.typeName(noargs)).toBe("void (*)(void)");
    });
  });

  describe("addType()", () => {
    it("appends types with fresh ids usable by sizeOf/typeName", () => {
      const b2 = parseBtf(blob);
      const n = b2.types.length;
      const id = b2.addType!({ kind: BtfKind.PTR, name: "", ref: ids.list_head });
      expect(id).toBe(n);
      expect(b2.types[id].id).toBe(id);
      expect(b2.sizeOf(id)).toBe(4);
      expect(b2.typeName(id)).toBe("struct list_head *");
    });
  });

  it("decodes UTF-8 and long names", () => {
    const b = new BtfBuilder();
    const int = b.int("int", 4, { signed: true });
    const longName = "x".repeat(200);
    const s = b.struct("café", 4, [{ name: longName, type: int, offset: 0 }]);
    const t = parseBtf(b.build());
    expect(t.types[s].name).toBe("café");
    expect(t.types[s].members![0].name).toBe(longName);
    expect(t.find("struct café")!.id).toBe(s);
  });

  it("parses a large synthetic BTF quickly", () => {
    const b = new BtfBuilder();
    const int = b.int("int", 4, { signed: true });
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      b.struct("s" + i, 12, [
        { name: "a", type: int, offset: 0 },
        { name: "b", type: int, offset: 4 },
        { name: "c", type: int, offset: 8 },
      ]);
    }
    const blobBig = b.build();
    const t0 = performance.now();
    const t = parseBtf(blobBig);
    const found = t.find("struct s99999")!;
    const dt = performance.now() - t0;
    console.log(`synthetic parse: ${blobBig.length} bytes, ${N} structs, parse+find ${dt.toFixed(1)} ms`);
    expect(t.types.length).toBe(N + 2);
    expect(found.members!.length).toBe(3);
    expect(dt).toBeLessThan(1500);
  });
});
