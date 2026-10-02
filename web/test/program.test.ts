import { beforeEach, describe, expect, it } from "vitest";
import { BtfKind } from "../src/debug/api";
import { PageFault } from "../src/vm/types";
import { BASE, makeProgram } from "./util/fixture";
import { FakeMemory } from "./util/fakeMem";

const T0 = BASE + 0x1000;
const T1 = BASE + 0x1100;
const T2 = BASE + 0x1200;
const HEAD = BASE + 0xf00;

function setup() {
  const ctx = makeProgram();
  const { mem } = ctx;
  const tasks = [T0, T1, T2];
  tasks.forEach((t, i) => {
    mem.w32(t + 0, 100 + i); // pid
    mem.w32(t + 4, 0xdeadbeef - i); // anon union x
    mem.w32(t + 8, 0x11111111 * (i + 1)); // anon struct z (y overlaps x)
    mem.wstr(t + 16, "task" + i);
    mem.w64(t + 32, 0x1_0000_0000n + BigInt(i)); // se.vruntime
    mem.w32(t + 40, 1024); // se.weight
    const next = tasks[(i + 1) % 3] + 52;
    const prev = tasks[(i + 2) % 3] + 52;
    mem.w32(t + 52, next);
    mem.w32(t + 56, prev);
    mem.w32(t + 60, i === 0 ? 0 : T0); // parent
    mem.w32(t + 64, BASE + 0x1800 + i * 0x20); // name
    mem.wstr(BASE + 0x1800 + i * 0x20, "name" + i);
    mem.w64(t + 72, -7n);
    for (let k = 0; k < 4; k++) mem.w32(t + 80 + k * 4, (k + 1) * (i + 1));
    mem.w32(t + 96, i === 2 ? 0xffffffff : i); // state
    mem.w32(t + 100, BASE + 0x1000);
  });
  // task_list head -> T0.tasks -> T1.tasks -> T2.tasks -> head
  mem.w32(HEAD, T0 + 52);
  mem.w32(HEAD + 4, T2 + 52);
  mem.w32(T0 + 56, HEAD);
  mem.w32(T2 + 52, HEAD);
  mem.w32(T1 + 56, T0 + 52);
  mem.w32(BASE + 0xf80, 0xfffffff0); // jiffies
  return ctx;
}

describe("KernelProgram", () => {
  let c: ReturnType<typeof setup>;
  beforeEach(() => {
    c = setup();
  });

  describe("var / value / typeId", () => {
    it("var() uses System.map address and BTF type", () => {
      const v = c.prog.var("init_task");
      expect(v.addr).toBe(T0);
      expect(v.typeName()).toBe("struct task_struct");
      expect(v.sizeOf()).toBe(104);
      expect(v.member("pid").num()).toBe(100);
    });
    it("var() of a typedef'd scalar", () => {
      const j = c.prog.var("jiffies");
      expect(j.typeName()).toBe("u32");
      expect(j.read()).toBe(0xfffffff0);
    });
    it("var() errors", () => {
      expect(() => c.prog.var("no_such")).toThrow("no type info for var no_such");
    });
    it("var() with BTF VAR but no symbol", () => {
      const { btf, mem } = c;
      const p = new (c.prog.constructor as any)(btf, { addr: () => undefined, lookup: () => undefined, format: String, all: [] }, mem);
      expect(() => p.var("init_task")).toThrow(/unknown symbol/);
    });
    it("value() by name, by id, with alternate memory", () => {
      expect(c.prog.value(T1, "struct task_struct").member("pid").num()).toBe(101);
      expect(c.prog.value(T1, c.ids.task_struct).member("pid").num()).toBe(101);
      const other = new FakeMemory(0x1000, 64);
      other.w32(0x1000, 77);
      const v = c.prog.value(0x1000, "int", other);
      expect(v.read()).toBe(77);
      expect(v.mem).toBe(other);
      expect(() => c.prog.value(0x1000, "int").read()).toThrow(PageFault);
    });
    it("typeId() resolves names and synthesizes pointers", () => {
      const { prog, btf, ids } = c;
      expect(prog.typeId("struct task_struct")).toBe(ids.task_struct);
      expect(prog.typeId("u64")).toBe(ids.u64);
      expect(prog.typeId("void")).toBe(0);
      // existing pointer type is reused
      expect(prog.typeId("struct task_struct *")).toBe(ids.tsPtr);
      expect(prog.typeId("struct task_struct*")).toBe(ids.tsPtr);
      expect(prog.typeId("char *")).not.toBe(ids.namePtr); // that one is `const char *`
      // synthesized
      const before = btf.types.length;
      const p = prog.typeId("struct sched_entity *");
      expect(p).toBeGreaterThanOrEqual(before);
      expect(btf.types[p].kind).toBe(BtfKind.PTR);
      expect(btf.typeName(p)).toBe("struct sched_entity *");
      expect(btf.sizeOf(p)).toBe(4);
      expect(prog.typeId("struct sched_entity *")).toBe(p); // cached
      expect(btf.types.length).toBe(before + 1);
      // double pointers
      const pp = prog.typeId("struct sched_entity **");
      expect(btf.typeName(pp)).toBe("struct sched_entity **");
      expect(prog.typeId("unsigned int *")).toBeGreaterThan(0);
      expect(prog.typeId("void *")).toBe(ids.ptrVoid);
    });
    it("typeId() throws on unknown types", () => {
      expect(() => c.prog.typeId("struct nope")).toThrow(/unknown type/);
      expect(() => c.prog.typeId("struct nope *")).toThrow(/unknown type/);
      expect(() => c.prog.value(0, 99999)).toThrow();
    });
    it("sizeOf accepts names and ids", () => {
      expect(c.prog.sizeOf("struct task_struct")).toBe(104);
      expect(c.prog.sizeOf(c.ids.commArr)).toBe(16);
      expect(c.prog.sizeOf("struct task_struct *")).toBe(4);
    });
  });

  describe("member paths", () => {
    it("reads nested members", () => {
      const t = c.prog.value(T1, "struct task_struct");
      expect(t.member("se.vruntime").read()).toBe(0x1_0000_0001n);
      expect(t.member("se.weight").read()).toBe(1024);
      expect(t.member("se.run_node").addr).toBe(T1 + 32 + 12);
      expect(t.member("se").member("weight").num()).toBe(1024);
    });
    it("descends into anonymous members", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(t.member("x").addr).toBe(T0 + 4);
      expect(t.member("x").read()).toBe(0xdeadbeef);
      expect(t.member("y").addr).toBe(T0 + 4);
      expect(t.member("z").addr).toBe(T0 + 8);
      expect(t.member("z").read()).toBe(0x11111111);
    });
    it("supports array indexing inside paths", () => {
      const t = c.prog.value(T1, "struct task_struct");
      expect(t.member("vals[2]").read()).toBe(6);
      expect(t.member("vals[0]").addr).toBe(T1 + 80);
      expect(t.member("comm[1]").read()).toBe("a".charCodeAt(0));
      expect(() => t.member("vals[4]")).toThrow(RangeError);
    });
    it("errors helpfully", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(() => t.member("nope")).toThrow(/no member 'nope'/);
      expect(() => t.member("pid.x")).toThrow(/no member/);
      expect(() => t.member("parent.pid")).toThrow(/deref/);
      expect(() => t.member("se..x")).toThrow(/invalid/);
    });
    it("works through typedefs and on the result of deref/cast", () => {
      const sp = c.prog.var("init_task").member("parent").cast("struct task_struct *");
      expect(sp.typeName()).toBe("struct task_struct *");
      const td = c.prog.value(T0, c.prog.typeId("struct task_struct"));
      expect(td.cast("struct task_struct").member("pid").num()).toBe(100);
    });
  });

  describe("read()", () => {
    it("reads signed/unsigned integers of each size", () => {
      const { prog, mem } = c;
      const a = BASE + 0x1400;
      mem.w8(a, 0xfe);
      mem.w8(a + 1, 0xfe);
      mem.w16(a + 2, 0xfffe);
      mem.w16(a + 4, 0xfffe);
      mem.w64(a + 8, 0x3ff0000000000000n); // 1.0
      const s = prog.value(a, "struct smalls");
      expect(s.member("s8").read()).toBe(-2);
      expect(s.member("u8").read()).toBe(254);
      expect(s.member("s16").read()).toBe(-2);
      expect(s.member("u16").read()).toBe(65534);
      expect(s.member("d").read()).toBe(1);
    });
    it("reads u64 as bigint (unsigned) and s64 as bigint (signed)", () => {
      const t = c.prog.value(T0, "struct task_struct");
      const v = t.member("se.vruntime").read();
      expect(typeof v).toBe("bigint");
      expect(v).toBe(0x1_0000_0000n);
      expect(t.member("delta").read()).toBe(-7n);
      expect(t.member("delta").num()).toBe(-7);
      c.mem.w64(T0 + 32, 0xffffffffffffffffn);
      expect(t.member("se.vruntime").read()).toBe(0xffffffffffffffffn);
    });
    it("reads signed int and unsigned long", () => {
      c.mem.w32(T0, 0xffffffff);
      const t = c.prog.value(T0, "struct task_struct");
      expect(t.member("pid").read()).toBe(-1);
      c.mem.w32(T0 + 40, 0xffffffff);
      expect(t.member("se.weight").read()).toBe(0xffffffff);
    });
    it("reads pointers as unsigned numbers", () => {
      const t = c.prog.value(T1, "struct task_struct");
      expect(t.member("parent").read()).toBe(T0);
      expect(t.member("parent").ptr()).toBe(T0);
      expect(t.member("parent").ptr()).toBeGreaterThan(0x7fffffff);
      expect(t.member("parent").isNull()).toBe(false);
      expect(c.prog.value(T0, "struct task_struct").member("parent").isNull()).toBe(true);
    });
    it("reads enums with signedness", () => {
      const e0 = c.prog.value(T1, "struct task_struct").member("state");
      expect(e0.read()).toBe(1);
      expect(e0.enumName()).toBe("TASK_SLEEPING");
      const eneg = c.prog.value(T2, "struct task_struct").member("state");
      expect(eneg.read()).toBe(-1);
      expect(eneg.enumName()).toBe("TASK_NEG");
      c.mem.w32(T2 + 96, 42);
      expect(c.prog.value(T2, "struct task_struct").member("state").enumName()).toBe("42");
    });
    it("reads unsigned 32-bit enums as unsigned and enum64", () => {
      const a = BASE + 0x1500;
      c.mem.w32(a, 0xffffffff);
      const ue = c.prog.value(a, "enum uenum");
      expect(ue.read()).toBe(0xffffffff);
      expect(ue.enumName()).toBe("UE_MAX");
      c.mem.w64(a, 0x1_0000_0001n);
      const be = c.prog.value(a, "enum big_enum");
      expect(be.read()).toBe(0x1_0000_0001n);
      expect(be.enumName()).toBe("BIG_HUGE");
      c.mem.w64(a, -5n);
      expect(c.prog.value(a, "enum sbig_enum").read()).toBe(-5n);
      expect(c.prog.value(a, "enum sbig_enum").enumName()).toBe("SBIG_NEG");
    });
    it("rejects reading aggregates", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(() => t.read()).toThrow(/scalar/);
      expect(() => t.member("comm").read()).toThrow(/scalar/);
    });
  });

  describe("bitfields", () => {
    it("extracts bits and remembers offsets", () => {
      // bits 96..99 = bf_a, 100..102 = bf_b (signed), 103..114 = bf_c, 115 = bf_bool
      const a = 0b1010; // 10
      const b = 0b101; // -3
      const cval = 0xabc; // 12 bits
      const word = BigInt(a) | (BigInt(b) << 4n) | (BigInt(cval) << 7n) | (1n << 19n);
      // bit 96 -> byte 12, bit0.  Compose 4 bytes at offset 12.
      c.mem.w32(T0 + 12, Number(word & 0xffffffffn));
      const t = c.prog.value(T0, "struct task_struct");
      expect(t.member("bf_a").read()).toBe(10);
      expect(t.member("bf_b").read()).toBe(-3);
      expect(t.member("bf_c").read()).toBe(0xabc);
      expect(t.member("bf_bool").read()).toBe(1);
      const bc = t.member("bf_c");
      expect(bc.bitSize).toBe(12);
      expect(bc.bitOffset).toBe(7);
      expect(bc.addr).toBe(T0 + 12);
      const bb = t.member("bf_bool");
      expect(bb.bitSize).toBe(1);
      expect(bb.bitOffset).toBe(3);
      expect(bb.addr).toBe(T0 + 14);
      expect(t.member("pid").bitSize).toBe(0);
      c.mem.w32(T0 + 12, 0);
      expect(t.member("bf_c").read()).toBe(0);
      expect(t.member("bf_bool").read()).toBe(0);
    });
    it("offsetOf rejects bitfields", () => {
      expect(() => c.prog.offsetOf("struct task_struct", "bf_a")).toThrow(/bitfield/);
    });
  });

  describe("deref / index / cast", () => {
    it("derefs pointers to structs", () => {
      const p = c.prog.value(T1, "struct task_struct").member("parent").deref();
      expect(p.addr).toBe(T0);
      expect(p.typeName()).toBe("struct task_struct");
      expect(p.member("pid").num()).toBe(100);
    });
    it("throws on null pointer and on non-pointers", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(() => t.member("parent").deref()).toThrow(/null/);
      expect(() => t.member("pid").deref()).toThrow(/non-pointer/);
    });
    it("throws helpful error on void*", () => {
      c.mem.w32(BASE + 0xe00 + 8, 0x1234);
      const h = c.prog.var("the_holder");
      expect(() => h.member("vp").deref()).toThrow(/void/);
    });
    it("derefs pointer to FWD via complete type, errors if none", () => {
      const h = c.prog.var("the_holder");
      c.mem.w32(BASE + 0xe00, BASE + 0x1600);
      c.mem.w32(BASE + 0x1600, 11);
      c.mem.w32(BASE + 0x1604, 22);
      const inc = h.member("inc").deref();
      expect(inc.typeName()).toBe("struct incomplete");
      expect(inc.member("b").read()).toBe(22);
      c.mem.w32(BASE + 0xe00 + 4, BASE + 0x1600);
      expect(() => h.member("nodef").deref()).toThrow(/incomplete type 'struct nodef'/);
    });
    it("indexes arrays and enforces bounds", () => {
      const t = c.prog.value(T2, "struct task_struct");
      const vals = t.member("vals");
      expect(vals.index(0).read()).toBe(3);
      expect(vals.index(3).read()).toBe(12);
      expect(vals.index(3).addr).toBe(T2 + 80 + 12);
      expect(() => vals.index(4)).toThrow(RangeError);
      expect(() => vals.index(-1)).toThrow(RangeError);
      expect(vals.index(1).typeName()).toBe("int");
    });
    it("does not enforce bounds for flexible arrays", () => {
      const a = BASE + 0x1700;
      c.mem.w8(a + 4 + 9, 0x55);
      const f = c.prog.value(a, "struct flex");
      expect(f.member("data").index(9).read()).toBe(0x55);
    });
    it("indexes through pointers (including negative)", () => {
      const a = BASE + 0x1710;
      c.mem.w32(a, 1);
      c.mem.w32(a + 4, 2);
      c.mem.w32(a + 8, 3);
      const holder = BASE + 0x1720;
      c.mem.w32(holder, a + 4);
      const p = c.prog.value(holder, "int *");
      expect(p.index(0).read()).toBe(2);
      expect(p.index(1).read()).toBe(3);
      expect(p.index(-1).read()).toBe(1);
      expect(p.index(1).addr).toBe(a + 8);
      const sp = c.prog.value(holder, "struct sched_entity *");
      expect(sp.index(2).addr).toBe(a + 4 + 40);
      expect(() => c.prog.value(holder, "void *").index(1)).toThrow();
      expect(() => c.prog.value(holder, "int").index(1)).toThrow(/cannot index/);
    });
    it("cast changes the type, keeping the address", () => {
      const v = c.prog.value(T0, "struct task_struct").cast("struct list_head");
      expect(v.addr).toBe(T0);
      expect(v.typeName()).toBe("struct list_head");
      expect(v.member("next").read()).toBe(100);
      const raw = c.prog.value(T0 + 52, "unsigned int").cast("struct list_head *");
      expect(raw.typeName()).toBe("struct list_head *");
      expect(raw.deref().addr).toBe(T1 + 52);
    });
    it("casting to a synthesized pointer then dereferencing works", () => {
      const v = c.prog.value(HEAD, "unsigned long").cast("struct task_struct *");
      expect(v.ptr()).toBe(T0 + 52);
      const se = c.prog.value(T0 + 32, "unsigned long");
      c.mem.w32(T0 + 32, T1 + 32);
      expect(se.cast("struct sched_entity *").deref().member("weight").read()).toBe(1024);
    });
  });

  describe("offsetOf / containerOf", () => {
    it("computes (nested, anonymous) offsets", () => {
      const { prog } = c;
      expect(prog.offsetOf("struct task_struct", "pid")).toBe(0);
      expect(prog.offsetOf("struct task_struct", "x")).toBe(4);
      expect(prog.offsetOf("struct task_struct", "z")).toBe(8);
      expect(prog.offsetOf("struct task_struct", "se.run_node.prev")).toBe(32 + 12 + 4);
      expect(prog.offsetOf("struct task_struct", "tasks")).toBe(52);
      expect(prog.offsetOf(c.ids.task_struct, "vals[3]")).toBe(92);
      expect(prog.offsetOf("struct sched_entity", "run_node")).toBe(12);
      expect(() => prog.offsetOf("struct task_struct", "zzz")).toThrow();
      expect(() => prog.offsetOf("struct task_struct", "pid.foo")).toThrow();
    });
    it("works via typedef'd struct (no-op) and unions", () => {
      expect(c.prog.offsetOf(c.ids.anonUnion, "z")).toBe(4);
    });
    it("containerOf walks a circular list_head", () => {
      const { prog } = c;
      const head = prog.var("task_list");
      expect(head.typeName()).toBe("struct list_head");
      const pids: number[] = [];
      let node = head.member("next");
      let guard = 0;
      while (node.ptr() !== HEAD && guard++ < 10) {
        const t = prog.containerOf(node.ptr(), "struct task_struct", "tasks");
        pids.push(t.member("pid").num());
        expect(t.addr).toBe(node.ptr() - 52);
        node = node.deref().member("next");
      }
      expect(pids).toEqual([100, 101, 102]);
      expect(node.ptr()).toBe(HEAD);
      // and backwards
      const last = prog.containerOf(head.member("prev").ptr(), "struct task_struct", "tasks");
      expect(last.member("pid").num()).toBe(102);
      expect(last.member("comm").cstr()).toBe("task2");
    });
    it("containerOf with nested path and numeric wrap", () => {
      const v = c.prog.containerOf(T1 + 32 + 12, "struct task_struct", "se.run_node");
      expect(v.addr).toBe(T1);
      expect(c.prog.containerOf(0x10, "struct task_struct", "tasks").addr).toBe((0x10 - 52) >>> 0);
    });
  });

  describe("cstr", () => {
    it("reads char arrays up to NUL and length", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(t.member("comm").cstr()).toBe("task0");
      c.mem.data.fill(0x41, T0 + 16 - BASE, T0 + 32 - BASE); // no NUL in comm[16]
      expect(t.member("comm").cstr()).toBe("A".repeat(16));
      expect(t.member("comm").cstr(4)).toBe("AAAA");
    });
    it("reads char pointers (const char *)", () => {
      const t = c.prog.value(T1, "struct task_struct");
      expect(t.member("name").cstr()).toBe("name1");
      expect(t.member("name").cstr(3)).toBe("nam");
    });
    it("respects default max of 256 for pointers", () => {
      const big = BASE + 0x1900;
      c.mem.data.fill(0x42, big - BASE, big - BASE + 0x300);
      c.mem.w32(T0 + 64, big);
      expect(c.prog.value(T0, "struct task_struct").member("name").cstr().length).toBe(256);
      expect(c.prog.value(T0, "struct task_struct").member("name").cstr(300).length).toBe(300);
    });
    it("returns '' for NULL char* and tolerates page faults mid-string", () => {
      const t = c.prog.value(T0, "struct task_struct");
      c.mem.w32(T0 + 64, 0);
      expect(t.member("name").cstr()).toBe("");
      // string runs off the end of mapped memory
      const end = BASE + 0x2000 - 5;
      c.mem.data.fill(0x43, end - BASE, end - BASE + 5);
      c.mem.w32(T0 + 64, end);
      expect(t.member("name").cstr()).toBe("CCCCC");
      // entirely unmapped
      c.mem.w32(T0 + 64, 0x1000);
      expect(t.member("name").cstr()).toBe("");
    });
    it("rejects non-string types", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(() => t.member("vals").cstr()).toThrow();
      expect(() => t.member("pid").cstr()).toThrow();
      expect(() => t.member("parent").cstr()).toThrow();
    });
  });

  describe("misc", () => {
    it("bytes() copies raw object bytes", () => {
      const v = c.prog.value(T0, "struct list_head");
      const b = v.bytes();
      expect(b.length).toBe(8);
      const before = b[0];
      c.mem.w8(T0, before ^ 0xff);
      expect(b[0]).toBe(before); // snapshot, not alias
    });
    it("raw reads", () => {
      c.mem.w64(BASE + 0x1a00, 0x0102030405060708n);
      expect(c.prog.readU8(BASE + 0x1a00)).toBe(8);
      expect(c.prog.readU16(BASE + 0x1a00)).toBe(0x0708);
      expect(c.prog.readU32(BASE + 0x1a00)).toBe(0x05060708);
      expect(c.prog.readU64(BASE + 0x1a00)).toBe(0x0102030405060708n);
      expect(() => c.prog.readU32(0x10)).toThrow(PageFault);
    });
    it("enumValue searches all enums", () => {
      expect(c.prog.enumValue("TASK_SLEEPING")).toBe(1n);
      expect(c.prog.enumValue("TASK_NEG")).toBe(-1n);
      expect(c.prog.enumValue("BIG_HUGE")).toBe(0x1_0000_0001n);
      expect(c.prog.enumValue("SBIG_NEG")).toBe(-5n);
      expect(c.prog.enumValue("NOPE")).toBeUndefined();
    });
    it("typeName/sizeOf/isNull on scalars", () => {
      const t = c.prog.value(T0, "struct task_struct");
      expect(t.member("comm").typeName()).toBe("char [16]");
      expect(t.member("parent").typeName()).toBe("struct task_struct *");
      expect(t.member("fn").typeName()).toBe("int (*)(struct task_struct *, ...)");
      expect(t.member("comm").sizeOf()).toBe(16);
      expect(t.member("pid").isNull()).toBe(false);
      expect(t.member("comm").ptr()).toBe(T0 + 16); // array decays
      expect(t.member("pid").prog).toBe(c.prog);
    });
    it("bool values read as 0/1", () => {
      const a = BASE + 0x1b00;
      c.mem.w8(a, 7);
      expect(c.prog.value(a, "_Bool").read()).toBe(1);
      c.mem.w8(a, 0);
      expect(c.prog.value(a, "_Bool").read()).toBe(0);
    });
    it("typedef chains resolve for reads and size", () => {
      const v = c.prog.value(T0, "pid_t");
      expect(v.read()).toBe(100);
      expect(v.sizeOf()).toBe(4);
      expect(v.typeName()).toBe("pid_t");
      expect(c.prog.value(T0, c.ids.cpid).read()).toBe(100);
    });
  });
});
