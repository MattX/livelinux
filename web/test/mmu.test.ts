import { describe, expect, it } from "vitest";
import { AddressSpace, PAGE_OFFSET, PhysView, pa, va } from "../src/vm/mmu";
import { PageFault } from "../src/vm/types";
import type { PhysMem } from "../src/vm/types";

const MB = 1024 * 1024;

class SynthPhys implements PhysMem {
  readonly mem: Uint8Array;
  readonly dv: DataView;
  constructor(readonly size = 16 * MB) {
    this.mem = new Uint8Array(size);
    this.dv = new DataView(this.mem.buffer);
  }
  read(paddr: number, len: number): Uint8Array {
    if (paddr < 0 || len < 0 || paddr + len > this.size) throw new RangeError("oob");
    return this.mem.subarray(paddr, paddr + len);
  }
  u32(paddr: number, v: number) {
    this.dv.setUint32(paddr, v >>> 0, true);
  }
}

const PD = 0x1000;
const PT0 = 0x2000;
const PT1 = 0x3000;
const P = 1, RW = 2, US = 4, PS = 0x80;

function pde(m: SynthPhys, va_: number, val: number) {
  m.u32(PD + (va_ >>> 22) * 4, val);
}
function pte(m: SynthPhys, ptBase: number, va_: number, val: number) {
  m.u32(ptBase + ((va_ >>> 12) & 0x3ff) * 4, val);
}

describe("helpers", () => {
  it("pa/va are unsigned", () => {
    expect(pa(0xc0100000)).toBe(0x100000);
    expect(va(0x100000)).toBe(0xc0100000);
    expect(va(0x3fffffff)).toBe(0xffffffff);
    expect(PAGE_OFFSET).toBe(0xc0000000);
  });
  it("PhysView reads raw memory", () => {
    const m = new SynthPhys(0x2000);
    m.mem[0x10] = 0x42;
    const v = new PhysView(m);
    expect(v.read(0x10, 1)[0]).toBe(0x42);
    expect(() => v.read(0x2000, 1)).toThrow(RangeError);
  });
});

describe("AddressSpace", () => {
  it("translates 4K pages with flag ANDing", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P | RW | US);
    pte(m, PT0, 0x00400000, 0x500000 | P | RW | US); // rw user
    pte(m, PT0, 0x00401000, 0x501000 | P | US); // ro user
    pte(m, PT0, 0x00402000, 0x502000 | P | RW); // rw kernel
    const as = new AddressSpace(m, PD);
    expect(as.translate(0x00400123)).toEqual({ pa: 0x500123, writable: true, user: true, large: false });
    expect(as.translate(0x00401fff)).toEqual({ pa: 0x501fff, writable: false, user: true, large: false });
    expect(as.translate(0x00402000)).toEqual({ pa: 0x502000, writable: true, user: false, large: false });
    expect(as.translate(0x00403000)).toBeNull(); // PTE not present
    expect(as.translate(0x00800000)).toBeNull(); // PDE not present
  });

  it("ANDs PDE flags into the effective flags", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P); // kernel, read-only at PDE level
    pte(m, PT0, 0x00400000, 0x500000 | P | RW | US);
    const t = new AddressSpace(m, PD).translate(0x00400000)!;
    expect(t.writable).toBe(false);
    expect(t.user).toBe(false);
  });

  it("handles 4 MiB PSE pages and honors pse:false", () => {
    const m = new SynthPhys();
    pde(m, 0xc0000000, 0x000000 | P | RW | PS);
    const as = new AddressSpace(m, PD);
    expect(as.translate(0xc0123456)).toEqual({ pa: 0x123456, writable: true, user: false, large: true });
    expect(as.translate(0xc03fffff)!.pa).toBe(0x3fffff);
    // With PSE disabled the PDE is a pointer to a page table (address 0 -> page 0, all zero => not present).
    const nopse = new AddressSpace(m, PD, { pse: false });
    expect(nopse.translate(0xc0123456)).toBeNull();
  });

  it("uses unsigned addresses for kernel VAs >= 0xC0000000", () => {
    const m = new SynthPhys();
    pde(m, 0xffc00000, PT1 | P | RW);
    pte(m, PT1, 0xfffff000, 0x600000 | P | RW);
    const as = new AddressSpace(m, PD);
    expect(as.translate(0xfffff010)!.pa).toBe(0x600010);
    expect(as.translate(-0x1000 >>> 0)!.pa).toBe(0x600000);
    // negative (signed) input is normalised too
    expect(as.translate(-0xff0)!.pa).toBe(0x600010);
  });

  it("reads within a page (view) and across pages (copy, non-contiguous frames)", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P | RW);
    pte(m, PT0, 0x00400000, 0x500000 | P | RW);
    pte(m, PT0, 0x00401000, 0x700000 | P | RW); // not physically contiguous
    for (let i = 0; i < 0x1000; i++) {
      m.mem[0x500000 + i] = 0xa0 + (i & 0xf);
      m.mem[0x700000 + i] = 0xb0 + (i & 0xf);
    }
    const as = new AddressSpace(m, PD);
    const within = as.read(0x00400010, 8);
    expect(Array.from(within)).toEqual(Array.from(m.mem.subarray(0x500010, 0x500018)));
    const cross = as.read(0x00400ffc, 8);
    expect(Array.from(cross)).toEqual([...m.mem.subarray(0x500ffc, 0x501000), ...m.mem.subarray(0x700000, 0x700004)]);
    expect(as.read(0x00400000, 0).length).toBe(0);
  });

  it("reads across large pages and across large/small boundaries", () => {
    const m = new SynthPhys();
    pde(m, 0xc0000000, 0 | P | RW | PS);
    pde(m, 0xc0400000, 0x400000 | P | RW | PS);
    for (let i = 0; i < 16; i++) m.mem[0x3ffff8 + i] = i + 1;
    const as = new AddressSpace(m, PD);
    expect(Array.from(as.read(0xc03ffff8, 16))).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("throws PageFault with the faulting level and address", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P | RW);
    pte(m, PT0, 0x00400000, 0x500000 | P | RW);
    const as = new AddressSpace(m, PD);
    let e: unknown;
    try {
      as.read(0x00800000, 4);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(PageFault);
    expect((e as PageFault).level).toBe("pde");
    expect((e as PageFault).va).toBe(0x00800000);
    // second page not present -> fault reports the VA of the second page
    try {
      as.read(0x00400ffe, 8);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(PageFault);
    expect((e as PageFault).level).toBe("pte");
    expect((e as PageFault).va).toBe(0x00401000);
    expect((e as PageFault).message).toContain("0x00401000");
  });

  it("caches table reads until clearCache()", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P | RW);
    pte(m, PT0, 0x00400000, 0x500000 | P | RW);
    const as = new AddressSpace(m, PD);
    expect(as.translate(0x00400000)!.pa).toBe(0x500000);
    pte(m, PT0, 0x00400000, 0x510000 | P | RW);
    expect(as.translate(0x00400000)!.pa).toBe(0x500000); // stale (cached)
    as.clearCache();
    expect(as.translate(0x00400000)!.pa).toBe(0x510000);
  });

  it("walkRanges merges contiguous runs with identical attributes", () => {
    const m = new SynthPhys();
    pde(m, 0x00400000, PT0 | P | RW | US);
    // 3 contiguous pages rw/user, then a page with different attrs, then a gap, then a non-phys-contiguous page
    pte(m, PT0, 0x00400000, 0x500000 | P | RW | US);
    pte(m, PT0, 0x00401000, 0x501000 | P | RW | US);
    pte(m, PT0, 0x00402000, 0x502000 | P | RW | US);
    pte(m, PT0, 0x00403000, 0x503000 | P | US); // ro
    pte(m, PT0, 0x00405000, 0x505000 | P | US); // gap before (va gap)
    pte(m, PT0, 0x00406000, 0x900000 | P | US); // phys discontiguous
    const r = new AddressSpace(m, PD).walkRanges();
    expect(r).toEqual([
      { va: 0x00400000, pa: 0x500000, size: 0x3000, writable: true, user: true, large: false },
      { va: 0x00403000, pa: 0x503000, size: 0x1000, writable: false, user: true, large: false },
      { va: 0x00405000, pa: 0x505000, size: 0x1000, writable: false, user: true, large: false },
      { va: 0x00406000, pa: 0x900000, size: 0x1000, writable: false, user: true, large: false },
    ]);
  });

  it("walkRanges merges adjacent PSE pages and separates them from 4K pages", () => {
    const m = new SynthPhys();
    pde(m, 0xc0000000, 0x000000 | P | RW | PS);
    pde(m, 0xc0400000, 0x400000 | P | RW | PS);
    pde(m, 0xc0800000, 0x800000 | P | RW | PS);
    pde(m, 0xc0c00000, PT1 | P | RW);
    pte(m, PT1, 0xc0c00000, 0xc00000 | P | RW);
    pde(m, 0xffc00000, 0x400000 | P | PS); // ro large, kernel, phys not contiguous with prior
    const r = new AddressSpace(m, PD).walkRanges(0xc0000000);
    expect(r).toEqual([
      { va: 0xc0000000, pa: 0, size: 0xc00000, writable: true, user: false, large: true },
      { va: 0xc0c00000, pa: 0xc00000, size: 0x1000, writable: true, user: false, large: false },
      { va: 0xffc00000, pa: 0x400000, size: 0x400000, writable: false, user: false, large: true },
    ]);
  });

  it("walkRanges clips to [lo, hi)", () => {
    const m = new SynthPhys();
    pde(m, 0x00000000, 0 | P | RW | PS);
    pde(m, 0x00400000, PT0 | P | RW);
    for (let i = 0; i < 8; i++) pte(m, PT0, 0x00400000 + i * 0x1000, 0x500000 + i * 0x1000 | P | RW);
    const as = new AddressSpace(m, PD);
    expect(as.walkRanges(0x200000, 0x300000)).toEqual([
      { va: 0x200000, pa: 0x200000, size: 0x100000, writable: true, user: false, large: true },
    ]);
    expect(as.walkRanges(0x00402000, 0x00405000)).toEqual([
      { va: 0x402000, pa: 0x502000, size: 0x3000, writable: true, user: false, large: false },
    ]);
    expect(as.walkRanges(0x00402800, 0x00404800)).toEqual([
      { va: 0x402800, pa: 0x502800, size: 0x2000, writable: true, user: false, large: false },
    ]);
    expect(as.walkRanges(5, 5)).toEqual([]);
  });

  it("walkRanges skips non-present PDEs quickly (full 4G space)", () => {
    const m = new SynthPhys();
    pde(m, 0xc0000000, 0 | P | RW | PS);
    const as = new AddressSpace(m, PD);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      as.clearCache();
      as.walkRanges();
    }
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(as.walkRanges()).toHaveLength(1);
  });

  it("treats page tables outside RAM as not present", () => {
    const m = new SynthPhys(0x10000);
    pde(m, 0x00400000, 0x800000 | P | RW); // PT beyond RAM
    const as = new AddressSpace(m, PD);
    expect(as.translate(0x00400000)).toBeNull();
    expect(() => as.read(0x00400000, 4)).toThrow(PageFault);
    expect(as.walkRanges()).toEqual([]);
  });
});
