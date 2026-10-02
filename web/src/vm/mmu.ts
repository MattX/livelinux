// i386 non-PAE (2-level) address translation over a PhysMem.
// All address arithmetic is unsigned 32-bit: kernel addresses are >= 0xC0000000.

import { PageFault } from "./types";
import type { MappedRange, Memory, PhysMem } from "./types";

export const PAGE_OFFSET = 0xc0000000;
const PAGE_SIZE = 0x1000;
const LARGE_SIZE = 0x400000;
const ADDR_SPACE = 0x1_0000_0000;

const P = 1; // present
const RW = 2;
const US = 4;
const PS = 0x80;

/** Direct-map (lowmem) virtual address -> physical address. */
export function pa(vaddr: number): number {
  return (vaddr - PAGE_OFFSET) >>> 0;
}
/** Physical address -> direct-map (lowmem) virtual address. */
export function va(paddr: number): number {
  return (paddr + PAGE_OFFSET) >>> 0;
}

/** Raw physical memory as a `Memory`. */
export class PhysView implements Memory {
  constructor(readonly phys: PhysMem) {}
  get size(): number {
    return this.phys.size;
  }
  read(addr: number, len: number): Uint8Array {
    return this.phys.read(addr >>> 0, len);
  }
}

export interface Translation {
  pa: number;
  writable: boolean;
  user: boolean;
  large: boolean;
}

type WalkResult = Translation | { fault: "pde" | "pte" };

export class AddressSpace implements Memory {
  readonly cr3: number;
  private readonly psePred: () => boolean;
  private pd: Uint32Array | null | undefined; // undefined = not loaded, null = unreadable
  private pts = new Map<number, Uint32Array | null>(); // keyed by page frame number of the PT

  /** `pse` may be a function, re-evaluated on every walk (CR4.PSE can change after construction). */
  constructor(private readonly phys: PhysMem, cr3: number, opts?: { pse?: boolean | (() => boolean) }) {
    this.cr3 = (cr3 & 0xfffff000) >>> 0;
    const pse = opts?.pse ?? true;
    this.psePred = typeof pse === "function" ? pse : () => pse;
  }

  get pse(): boolean {
    return this.psePred();
  }

  clearCache(): void {
    this.pd = undefined;
    this.pts.clear();
  }

  private loadTable(base: number): Uint32Array | null {
    if (base + PAGE_SIZE > this.phys.size) return null;
    try {
      const src = this.phys.read(base, PAGE_SIZE);
      const out = new Uint32Array(PAGE_SIZE / 4);
      new Uint8Array(out.buffer).set(src);
      return out;
    } catch {
      return null;
    }
  }

  private getPd(): Uint32Array | null {
    if (this.pd === undefined) this.pd = this.loadTable(this.cr3);
    return this.pd;
  }

  private getPt(pde: number): Uint32Array | null {
    const base = (pde & 0xfffff000) >>> 0;
    const key = base >>> 12;
    let t = this.pts.get(key);
    if (t === undefined) {
      t = this.loadTable(base);
      this.pts.set(key, t);
    }
    return t;
  }

  private walk(vaddr: number): WalkResult {
    vaddr = vaddr >>> 0;
    const pd = this.getPd();
    if (!pd) return { fault: "pde" };
    const pde = pd[vaddr >>> 22];
    if (!(pde & P)) return { fault: "pde" };
    if (this.pse && pde & PS) {
      return {
        pa: (((pde & 0xffc00000) >>> 0) + (vaddr & 0x3fffff)) >>> 0,
        writable: !!(pde & RW),
        user: !!(pde & US),
        large: true,
      };
    }
    const pt = this.getPt(pde);
    if (!pt) return { fault: "pte" };
    const pte = pt[(vaddr >>> 12) & 0x3ff];
    if (!(pte & P)) return { fault: "pte" };
    return {
      pa: (((pte & 0xfffff000) >>> 0) + (vaddr & 0xfff)) >>> 0,
      writable: !!(pde & pte & RW),
      user: !!(pde & pte & US),
      large: false,
    };
  }

  translate(vaddr: number): Translation | null {
    const r = this.walk(vaddr);
    return "fault" in r ? null : r;
  }

  read(vaddr: number, len: number): Uint8Array {
    vaddr = vaddr >>> 0;
    if (len <= 0) return new Uint8Array(0);
    // First chunk: usually the only one.
    let t = this.walk(vaddr);
    if ("fault" in t) throw new PageFault(vaddr, t.fault);
    const span = t.large ? LARGE_SIZE - (vaddr & (LARGE_SIZE - 1)) : PAGE_SIZE - (vaddr & (PAGE_SIZE - 1));
    if (len <= span) return this.phys.read(t.pa, len);

    const out = new Uint8Array(len);
    let done = 0;
    let cur = vaddr;
    for (;;) {
      const chunkSpan = t.large ? LARGE_SIZE - (cur & (LARGE_SIZE - 1)) : PAGE_SIZE - (cur & (PAGE_SIZE - 1));
      const n = Math.min(chunkSpan, len - done);
      out.set(this.phys.read(t.pa, n), done);
      done += n;
      if (done >= len) break;
      cur = (cur + n) >>> 0;
      t = this.walk(cur);
      if ("fault" in t) throw new PageFault(cur, t.fault);
    }
    return out;
  }

  /**
   * Enumerate present mappings in [lo, hi), merging virtually and physically contiguous runs
   * with identical writable/user/large attributes. Runs are clipped to [lo, hi).
   */
  walkRanges(lo = 0, hi = ADDR_SPACE): MappedRange[] {
    lo = Math.max(0, lo);
    hi = Math.min(ADDR_SPACE, hi);
    const out: MappedRange[] = [];
    if (lo >= hi) return out;
    const pd = this.getPd();
    if (!pd) return out;

    let cur: MappedRange | null = null;
    const emit = (start: number, end: number, paStart: number, writable: boolean, user: boolean, large: boolean) => {
      if (start < lo) {
        paStart += lo - start;
        start = lo;
      }
      if (end > hi) end = hi;
      if (start >= end) return;
      const size = end - start;
      if (
        cur &&
        cur.va + cur.size === start &&
        cur.pa + cur.size === paStart &&
        cur.writable === writable &&
        cur.user === user &&
        cur.large === large
      ) {
        cur.size += size;
        return;
      }
      cur = { va: start, pa: paStart, size, writable, user, large };
      out.push(cur);
    };

    const firstPde = Math.floor(lo / LARGE_SIZE);
    const lastPde = Math.floor((hi - 1) / LARGE_SIZE);
    for (let i = firstPde; i <= lastPde; i++) {
      const pde = pd[i];
      if (!(pde & P)) continue;
      const base = i * LARGE_SIZE;
      if (this.pse && pde & PS) {
        emit(base, base + LARGE_SIZE, (pde & 0xffc00000) >>> 0, !!(pde & RW), !!(pde & US), true);
        continue;
      }
      const pt = this.getPt(pde);
      if (!pt) continue;
      const pw = !!(pde & RW);
      const pu = !!(pde & US);
      let j0 = 0;
      let j1 = 1023;
      if (base < lo) j0 = Math.floor((lo - base) / PAGE_SIZE);
      if (base + LARGE_SIZE > hi) j1 = Math.floor((hi - 1 - base) / PAGE_SIZE);
      for (let j = j0; j <= j1; j++) {
        const pte = pt[j];
        if (!(pte & P)) continue;
        const v = base + j * PAGE_SIZE;
        emit(v, v + PAGE_SIZE, (pte & 0xfffff000) >>> 0, pw && !!(pte & RW), pu && !!(pte & US), false);
      }
    }
    return out;
  }
}
