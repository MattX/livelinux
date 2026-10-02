import { describe, expect, it } from "vitest";
import { parseSystemMap } from "../src/debug/symbols";
import { SYSTEM_MAP } from "./util/fixture";

describe("parseSystemMap", () => {
  const s = parseSystemMap(SYSTEM_MAP);

  it("parses and sorts symbols, skipping absolute ones", () => {
    expect(s.all.length).toBe(9);
    for (let i = 1; i < s.all.length; i++) expect(s.all[i].addr).toBeGreaterThanOrEqual(s.all[i - 1].addr);
    expect(s.addr("some_abs")).toBeUndefined();
    expect(s.all[0]).toEqual({ name: "_text", addr: 0xc1000000, type: "T" });
  });

  it("looks up addresses by name", () => {
    expect(s.addr("schedule")).toBe(0xc1000200);
    expect(s.addr("jiffies")).toBe(0xc1800000);
    expect(s.addr("nope")).toBeUndefined();
  });

  it("returns addresses as unsigned numbers", () => {
    expect(s.addr("_text")).toBeGreaterThan(0x7fffffff);
  });

  it("finds the nearest symbol at or below an address", () => {
    expect(s.lookup(0xc1000200)).toMatchObject({ sym: { name: "schedule" }, offset: 0 });
    expect(s.lookup(0xc100021a)).toMatchObject({ sym: { name: "schedule" }, offset: 0x1a });
    expect(s.lookup(0xc10000ff)).toMatchObject({ sym: { name: "startup_32" }, offset: 0xbf });
    expect(s.lookup(0xc1000000)!.sym.name).toBe("_text");
  });

  it("prefers global symbols over locals at the same address", () => {
    expect(s.lookup(0xc1000100)!.sym.name).toBe("global_fn");
    expect(s.lookup(0xc1000110)!.sym.name).toBe("global_fn");
  });

  it("returns undefined below the first symbol and far past the last", () => {
    expect(s.lookup(0x1000)).toBeUndefined();
    expect(s.lookup(0xbfffffff)).toBeUndefined();
    expect(s.lookup(0xfffff000)).toBeUndefined();
  });

  it("formats symbol+offset or hex", () => {
    expect(s.format(0xc100021a)).toBe("schedule+0x1a");
    expect(s.format(0xc1000200)).toBe("schedule");
    expect(s.format(0x1234)).toBe("0x1234");
    expect(s.format(0xfffff000)).toBe("0xfffff000");
  });

  it("tolerates blank lines, CRLF, junk and module-style lines", () => {
    const m = parseSystemMap("\r\nc0100000 T a\r\n\r\nnot a line\nzzzz T b\nc0100010 t c [mod]\n");
    expect(m.all.map((x) => x.name)).toEqual(["a", "c"]);
  });

  it("keeps low per-cpu symbols out of address lookup but resolvable by name", () => {
    const m = parseSystemMap("00000000 D __per_cpu_start\n0000a000 D this_cpu_off\nc0100000 T _text\nc0100100 T foo\n");
    expect(m.addr("this_cpu_off")).toBe(0xa000);
    expect(m.lookup(0xa010)).toBeUndefined();
    expect(m.format(0xc0100104)).toBe("foo+0x4");
  });

  it("prefers a global definition for duplicate names", () => {
    const m = parseSystemMap("c0000010 t dup\nc0000020 T dup\n");
    expect(m.addr("dup")).toBe(0xc0000020);
  });
});
