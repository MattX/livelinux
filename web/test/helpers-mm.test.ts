import { describe, expect, it } from "vitest";
import { formatMaps, kernelRegion, mmPgdPhys, vmas, vmFlagsStr } from "../src/debug/helpers";
import { allocObj, buildKernel, buildMapleTree, type Kernel, type MapleRange } from "./util/helperFakes";

function mkDentry(k: Kernel, name: string, parent: number | null, inlineName = false): number {
  const p = k.prog;
  const d = allocObj(k, "struct dentry");
  p.set(d, "struct dentry", "d_parent", parent ?? d);
  if (inlineName) {
    p.set(d, "struct dentry", "d_iname", name);
    // d_name.name left NULL to exercise the d_iname fallback
  } else {
    const s = k.mem.alloc(name.length + 1);
    k.mem.writeBytes(s, [...name].map((c) => c.charCodeAt(0)));
    p.set(d, "struct dentry", "d_name.name", s);
  }
  return d;
}

function mkFile(k: Kernel, dentry: number, ino: number, dev: number): number {
  const p = k.prog;
  const f = allocObj(k, "struct file");
  p.set(f, "struct file", "f_path.dentry", dentry);
  const sb = allocObj(k, "struct super_block");
  p.set(sb, "struct super_block", "s_dev", dev);
  const inode = allocObj(k, "struct inode");
  p.set(inode, "struct inode", "i_sb", sb);
  p.set(inode, "struct inode", "i_ino", ino);
  p.set(f, "struct file", "f_inode", inode);
  return f;
}

function mkVma(k: Kernel, start: number, end: number, flags: number, pgoff: number, file = 0): number {
  const p = k.prog;
  const v = allocObj(k, "struct vm_area_struct");
  p.set(v, "struct vm_area_struct", "vm_start", start);
  p.set(v, "struct vm_area_struct", "vm_end", end);
  p.set(v, "struct vm_area_struct", "vm_flags", flags);
  p.set(v, "struct vm_area_struct", "vm_pgoff", pgoff);
  p.set(v, "struct vm_area_struct", "vm_file", file);
  return v;
}

function world() {
  const k = buildKernel();
  const p = k.prog;
  const root = mkDentry(k, "/", null);
  const bin = mkDentry(k, "bin", root);
  const busybox = mkDentry(k, "busybox", bin);
  const lib = mkDentry(k, "libc.so", root, true);
  const fBusybox = mkFile(k, busybox, 1234, (8 << 20) | 1);
  const fLib = mkFile(k, lib, 77, 0);

  const mm = allocObj(k, "struct mm_struct");
  const vm = [
    mkVma(k, 0x08048000, 0x08060000, 0x1 | 0x4 | 0x10, 0, fBusybox),     // r-xp
    mkVma(k, 0x08060000, 0x08062000, 0x1 | 0x2, 0x18, fBusybox),         // rw-p
    mkVma(k, 0x09000000, 0x09021000, 0x1 | 0x2, 0),                      // heap
    mkVma(k, 0xb7e00000, 0xb7e20000, 0x1 | 0x8, 0x2, fLib),              // r--s
    mkVma(k, 0xb7fe0000, 0xb7fe4000, 0x1 | 0x2 | 0x4, 0),               // anonymous, no name
    mkVma(k, 0xbffdf000, 0xc0000000, 0x1 | 0x2, 0),                      // stack
  ];
  const ranges: MapleRange[] = vm.map((v) => ({
    first: p.value(v, "struct vm_area_struct").member("vm_start").num(),
    last: p.value(v, "struct vm_area_struct").member("vm_end").num() - 1,
    entry: v,
  }));
  buildMapleTree(k, mm + p.offsetOf("struct mm_struct", "mm_mt"), ranges, { alloc: true, fanout: 3 });
  p.set(mm, "struct mm_struct", "start_brk", 0x09000000);
  p.set(mm, "struct mm_struct", "brk", 0x09021000);
  p.set(mm, "struct mm_struct", "start_stack", 0xbfffe000);
  p.set(mm, "struct mm_struct", "pgd", 0xc1234000);
  return { k, mm, vm };
}

describe("vmFlagsStr", () => {
  it("decodes rwxp/rwxs", () => {
    expect(vmFlagsStr(0)).toBe("---p");
    expect(vmFlagsStr(1 | 2 | 4)).toBe("rwxp");
    expect(vmFlagsStr(1 | 8)).toBe("r--s");
  });
});

describe("vmas / formatMaps", () => {
  it("lists VMAs with files, special names and flags", () => {
    const { k, mm } = world();
    const list = vmas(k.prog, k.prog.value(mm, "struct mm_struct"));
    expect(list.map((v) => [v.start, v.end, v.flagsStr, v.name])).toEqual([
      [0x08048000, 0x08060000, "r-xp", "/bin/busybox"],
      [0x08060000, 0x08062000, "rw-p", "/bin/busybox"],
      [0x09000000, 0x09021000, "rw-p", "[heap]"],
      [0xb7e00000, 0xb7e20000, "r--s", "/libc.so"],
      [0xb7fe0000, 0xb7fe4000, "rwxp", undefined],
      [0xbffdf000, 0xc0000000, "rw-p", "[stack]"],
    ]);
    expect(list[1].pgoff).toBe(0x18);
    expect(list[0].fileBase).toBe("busybox");
    expect(list[0].ino).toBe(1234);
    expect(list[0].dev).toBe((8 << 20) | 1);
    expect(list[3].file).toBe("/libc.so"); // d_iname fallback
    expect(list[2].addr).toBeGreaterThan(0);
  });

  it("accepts an mm pointer", () => {
    const { k, mm } = world();
    const holder = k.mem.alloc(4);
    k.mem.writeUint(holder, 4, mm);
    expect(vmas(k.prog, k.prog.value(holder, "struct mm_struct *")).length).toBe(6);
  });

  it("labels [vdso] and [vvar]", () => {
    const { k, mm } = world();
    k.prog.set(mm, "struct mm_struct", "context.vdso", 0xb7fe2000);
    const list = vmas(k.prog, k.prog.value(mm, "struct mm_struct"));
    // the unnamed rwxp VMA ends at 0xb7fe4000 and starts at 0xb7fe0000: neither equals vdso, so make it so
    expect(list[4].anonName).toBeUndefined();
    k.prog.set(mm, "struct mm_struct", "context.vdso", 0xb7fe0000);
    expect(vmas(k.prog, k.prog.value(mm, "struct mm_struct"))[4].anonName).toBe("[vdso]");
    k.prog.set(mm, "struct mm_struct", "context.vdso", 0xb7fe4000);
    expect(vmas(k.prog, k.prog.value(mm, "struct mm_struct"))[4].anonName).toBe("[vvar]");
  });

  it("formats /proc/pid/maps-like text", () => {
    const { k, mm } = world();
    const text = formatMaps(vmas(k.prog, k.prog.value(mm, "struct mm_struct")));
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^08048000-08060000 r-xp 00000000 08:01 1234 +\/bin\/busybox$/);
    expect(lines[1]).toMatch(/^08060000-08062000 rw-p 00018000 08:01 1234 +\/bin\/busybox$/);
    expect(lines[2]).toMatch(/^09000000-09021000 rw-p 00000000 00:00 0 +\[heap\]$/);
    expect(lines[4]).toBe("b7fe0000-b7fe4000 rwxp 00000000 00:00 0");
    expect(lines[5]).toMatch(/\[stack\]$/);
    // name column aligned
    expect(lines[0].indexOf("/bin/busybox")).toBe(lines[2].indexOf("[heap]"));
    expect(formatMaps([])).toBe("");
  });

  it("mmPgdPhys", () => {
    const { k, mm } = world();
    expect(mmPgdPhys(k.prog.value(mm, "struct mm_struct"))).toBe(0x01234000);
  });
});

describe("kernelRegion", () => {
  it("splits the direct map around the kernel image, from symbols and high_memory", () => {
    const k = buildKernel();
    k.prog.defineSymbol("_text", 0xc1000000);
    k.prog.defineSymbol("_etext", 0xc1600000);
    k.prog.defineSymbol("__bss_start", 0xc1900000);
    k.prog.defineSymbol("__bss_stop", 0xc1a00000);
    k.prog.defineSymbol("_end", 0xc1b00000);
    const hm = k.prog.defineVar("high_memory", "ptr:void");
    k.mem.writeUint(hm, 4, 0xc8000000);
    const kr = kernelRegion(k.prog);
    expect(kr.children!.map((c) => [c.id, c.start, c.end])).toEqual([
      ["k.dm", 0xc0000000, 0xc8000000],
      ["k.vmoff", 0xc8000000, 0xc8800000],
    ]);
    const dm = kr.children![0];
    expect(dm.children!.map((c) => c.label)).toEqual(["low memory below the kernel", "kernel image", "lowmem (page allocator)"]);
    const img = dm.children![1];
    // holes between the sections are filled
    expect(img.children!.map((c) => [c.label, c.start, c.end])).toEqual([
      [".text", 0xc1000000, 0xc1600000],
      ["other sections / padding", 0xc1600000, 0xc1900000],
      [".bss", 0xc1900000, 0xc1a00000],
      ["other sections / padding", 0xc1a00000, 0xc1b00000],
    ]);
    expect(dm.detail).toBe("phys 0x00000000–0x08000000");
  });

  it("is best-effort without high_memory", () => {
    const k = buildKernel();
    const kr = kernelRegion(k.prog);
    expect([kr.start, kr.end, kr.children]).toEqual([0xc0000000, 0x100000000, []]);
  });
});
