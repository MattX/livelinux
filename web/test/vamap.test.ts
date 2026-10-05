import { describe, expect, it } from "vitest";
import { addMapped, ADDR_TOP, userRegion, vaRows, vmFlagsStr, type VaRegion, type VmaInfo } from "../src/debug/helpers";
import type { MappedRange } from "../src/vm/types";

function vma(start: number, end: number, flags: number, file?: string, anonName?: string): VmaInfo {
  return { addr: start, start, end, flags, flagsStr: vmFlagsStr(flags), pgoff: 0, file, fileBase: file?.split("/").pop(), anonName, name: file ?? anonName };
}
const R = 1, W = 2, X = 4;

const list = [
  vma(0x08048000, 0x08049000, R, "/bin/prog"),
  vma(0x08049000, 0x08060000, R | X, "/bin/prog"),
  vma(0x08060000, 0x08061000, R | W, "/bin/prog"),
  vma(0x08061000, 0x08063000, R | W), // .bss
  vma(0x09000000, 0x09021000, R | W, undefined, "[heap]"),
  vma(0xb7f00000, 0xb7f01000, R | W, "/lib/other"), // single-VMA file
  vma(0xb7f10000, 0xb7f11000, 0), // PROT_NONE
  vma(0xbff00000, 0xbff21000, R | W, undefined, "[stack]"),
];

describe("userRegion", () => {
  it("groups adjacent mappings of a file, with its .bss", () => {
    const u = userRegion(list);
    expect(u.children!.map((c) => c.label)).toEqual(["prog", "[heap]", "other", "PROT_NONE", "[stack]"]);
    const prog = u.children![0];
    expect(prog.start).toBe(0x08048000);
    expect(prog.end).toBe(0x08063000);
    expect(prog.children!.map((c) => [c.label, c.kind])).toEqual([
      ["read-only", "rodata"], ["text", "code"], ["data", "data"], [".bss", "bss"],
    ]);
    // a lone file mapping is a leaf named after the file
    expect(u.children![2].children).toBeUndefined();
    expect(u.children![2].detail).toContain("data");
    expect(u.children![3].kind).toBe("guard");
  });

  it("does not take an anonymous mapping after read-only file data as .bss", () => {
    const u = userRegion([vma(0x1000, 0x2000, R | X, "/f"), vma(0x2000, 0x3000, R | W)]);
    expect(u.children!.map((c) => c.kind)).toEqual(["code", "anon"]);
  });
});

describe("vaRows", () => {
  const roots: VaRegion[] = [
    userRegion(list),
    { id: "kernel", start: 0xc0000000, end: ADDR_TOP, label: "kernel space", kind: "kernel", children: [
      { id: "k.a", start: 0xc0000000, end: 0xc1000000, label: "a", kind: "lowmem" },
    ] },
  ];

  it("lists rows top-down; leaves and gaps tile the address space", () => {
    const rows = vaRows(roots, (r) => r.open ?? false);
    for (let i = 1; i < rows.length; i++) expect(rows[i].end).toBeLessThanOrEqual(rows[i - 1].end);
    const tiles = rows.filter((r) => !(r.type === "region" && r.open));
    expect(tiles[0].end).toBe(ADDR_TOP);
    expect(tiles[tiles.length - 1].start).toBe(0);
    for (let i = 1; i < tiles.length; i++) expect(tiles[i].end).toBe(tiles[i - 1].start);
    // kernel is collapsed (open undefined): a single tile
    expect(tiles[0]).toMatchObject({ type: "region", r: { id: "kernel" }, open: false, expandable: true });
  });

  it("labels the gaps the heap and stack grow into", () => {
    const rows = vaRows(roots, () => true);
    const gaps = rows.filter((r) => r.type === "gap").map((r) => (r.type === "gap" ? r.label : ""));
    expect(gaps).toContain("free: the stack grows down into this");
    expect(gaps).toContain("free: the heap grows up into this (brk)");
    expect(gaps[gaps.length - 1]).toMatch(/NULL/);
    const k = rows.filter((r) => r.type === "region" && r.r.id === "k.a");
    expect(k).toHaveLength(1);
    expect(k[0].depth).toBe(1);
  });
});

describe("addMapped", () => {
  it("sums the overlap of page-table ranges with each region", () => {
    const u = userRegion(list);
    const ranges: MappedRange[] = [
      { va: 0x08048000, pa: 0, size: 0x2000, writable: false, user: true, large: false },
      { va: 0x08062000, pa: 0, size: 0x1000, writable: true, user: true, large: false },
      { va: 0xbff20000, pa: 0, size: 0x1000, writable: true, user: true, large: false },
    ];
    addMapped(u, ranges);
    const prog = u.children![0];
    expect(prog.mapped).toBe(0x3000);
    expect(prog.children!.map((c) => c.mapped)).toEqual([0x1000, 0x1000, 0, 0x1000]);
    expect(u.children![4].mapped).toBe(0x1000);
    expect(u.mapped).toBe(0x4000);
  });
});
