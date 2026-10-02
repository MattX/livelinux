// Physical memory map: classify every page frame of guest RAM by scanning the kernel's struct page
// array (FLATMEM `mem_map`, Linux 6.12 i386), plus a reverse map from frames to the processes
// that map them, built from each process's page tables.
//
// The scan reads guest memory directly with offsets resolved once from BTF: 65536 struct pages
// (256 MiB) is ~2 MiB of memory and a few milliseconds of work, cheap enough to repeat ~10x/s.

import type { Program } from "../debug/api";
import { arrayLen, forEachTask, mmPgdPhys, PAGE_OFFSET } from "../debug/helpers";
import type { Machine } from "../vm/machine";

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
/** i386: THREAD_SIZE = PAGE_SIZE << THREAD_SIZE_ORDER (1). */
const THREAD_PAGES = 2;

/** What a page frame is used for. Order matters only for display. */
export const enum PageKind {
  /** Not RAM / not covered by mem_map. */
  None = 0,
  /** Free, in the buddy allocator. */
  Free,
  /** Free, cached on a per-CPU page list (zone->per_cpu_pageset). */
  FreePcp,
  KernelText,
  KernelRodata,
  KernelData,
  KernelBss,
  /** PG_reserved outside the kernel image: firmware, memblock allocations (mem_map itself, ...). */
  Reserved,
  Slab,
  PageTable,
  /** Anonymous user memory (heap, stack, private writable). */
  Anon,
  /** Page cache (file contents, including tmpfs/ramfs files such as the initramfs). */
  File,
  /** Kernel stack of a task. */
  KernelStack,
  /** Allocated by the kernel with no further identity (vmalloc, pipe buffers, ...). */
  Kernel,
  /** Other typed pages (offline, guard, zsmalloc, ...). */
  Other,
}
export const NUM_KINDS = PageKind.Other + 1;

export interface KindInfo {
  name: string;
  /** Short description for legends / tooltips. */
  desc: string;
}

export const KIND_INFO: readonly KindInfo[] = [
  { name: "none", desc: "not RAM" },
  { name: "free", desc: "free (buddy allocator)" },
  { name: "free (pcp)", desc: "free, on a per-CPU page list" },
  { name: "kernel code", desc: "kernel image .text" },
  { name: "kernel rodata", desc: "kernel image read-only data" },
  { name: "kernel data", desc: "kernel image .data" },
  { name: "kernel bss", desc: "kernel image .bss" },
  { name: "reserved", desc: "reserved: firmware, early boot allocations (incl. struct page array)" },
  { name: "slab", desc: "slab allocator (kmalloc, kmem_cache objects)" },
  { name: "page tables", desc: "page directories and page tables" },
  { name: "anon", desc: "anonymous user memory (heap, stack, private data)" },
  { name: "page cache", desc: "file contents cached in RAM" },
  { name: "kernel stack", desc: "task kernel stacks" },
  { name: "kernel other", desc: "other kernel allocations (vmalloc, buffers, ...)" },
  { name: "other", desc: "other typed pages" },
];

/** A process mapping (or otherwise owning) a frame. */
export interface PageOwner {
  pid: number;
  /** "user": mapped at `va` in the process's address space; "stack": kernel stack; "pgd"/"pt": its page directory / a page table. */
  what: "user" | "stack" | "pgd" | "pt";
  va?: number;
}

export interface PhysSnapshot {
  /** performance.now() when taken. */
  time: number;
  /** True if taken at a point where kernel data structures might have been mid-update. */
  torn: boolean;
  /** Milliseconds spent collecting. */
  durationMs: number;
  nPages: number;
  kind: Uint8Array;
  /** Raw page->flags. */
  flags: Uint32Array;
  /** Raw page->mapping (anon_vma | 1 for anon, address_space for page cache), or slab_cache for slab pages (head page's, for tails). */
  aux: Uint32Array;
  /** Buddy order of the free block a free page belongs to; compound order for compound pages; else 0. */
  order: Uint8Array;
  refcount: Int32Array;
  /** _mapcount + 1 (number of user mappings) for untyped pages, else 0. */
  mapcount: Int32Array;
  /** Pages per kind. */
  counts: number[];
  /** Frame -> processes mapping/owning it. Only frames with owners are present. */
  owners: Map<number, PageOwner[]>;
  /** pid -> comm for every task seen. */
  tasks: Map<number, string>;
}

/** Kernel image section boundaries as physical frame numbers (half-open). */
interface ImageLayout {
  text: [number, number];
  rodata: [number, number];
  data: [number, number];
  bss: [number, number];
}

const PGTY_BUDDY = 0xf0;
const PGTY_OFFLINE = 0xf1;
const PGTY_TABLE = 0xf2;
const PGTY_GUARD = 0xf3;
const PGTY_SLAB = 0xf5;

export class PhysMapper {
  readonly nPages: number;
  private readonly memMapPa: number;
  private readonly memMapVa: number;
  private readonly pageSize: number;
  private readonly offFlags: number;
  private readonly offMapping: number;
  private readonly offPrivate: number;
  private readonly offCompoundHead: number;
  private readonly offPageType: number;
  private readonly offRefcount: number;
  private readonly offSlabCache: number;
  private readonly offPcpList: number;
  private readonly migratePcpTypes: number;
  /** Physical addresses of each zone's per_cpu_pageset pointer, and per_cpu_pages layout. */
  private readonly pcpPtrPas: number[];
  private readonly offPcpLists: number;
  private readonly nPcpLists: number;
  private readonly pgReserved: number;
  private readonly pgHead: number;
  private readonly image: ImageLayout;
  /** Bit numbers of `enum pageflags` (deduplicated aliases), for display. */
  readonly pageFlagNames: readonly [number, string][];

  constructor(private readonly machine: Machine, private readonly prog: Program) {
    const memMapVa = prog.var("mem_map").ptr();
    if (!memMapVa) throw new Error("mem_map is NULL (not a FLATMEM kernel?)");
    this.memMapVa = memMapVa;
    this.memMapPa = (memMapVa - PAGE_OFFSET) >>> 0;
    const maxMapnr = prog.var("max_mapnr").num();
    this.nPages = Math.min(maxMapnr, Math.floor(machine.phys.size / PAGE_SIZE));
    this.pageSize = prog.sizeOf("struct page");
    this.offFlags = prog.offsetOf("struct page", "flags");
    this.offMapping = prog.offsetOf("struct page", "mapping");
    this.offPrivate = prog.offsetOf("struct page", "private");
    this.offCompoundHead = prog.offsetOf("struct page", "compound_head");
    this.offPageType = prog.offsetOf("struct page", "page_type");
    this.offRefcount = prog.offsetOf("struct page", "_refcount");
    this.offSlabCache = prog.offsetOf("struct slab", "slab_cache");
    this.offPcpList = prog.offsetOf("struct page", "pcp_list");
    this.migratePcpTypes = Number(prog.enumValue("MIGRATE_PCPTYPES") ?? 3n);
    const zones = prog.var("contig_page_data").member("node_zones");
    this.pcpPtrPas = [];
    for (let z = 0; z < arrayLen(zones); z++) {
      this.pcpPtrPas.push((zones.index(z).member("per_cpu_pageset").addr - PAGE_OFFSET) >>> 0);
    }
    this.offPcpLists = prog.offsetOf("struct per_cpu_pages", "lists");
    this.nPcpLists = arrayLen(prog.value(0, "struct per_cpu_pages").member("lists"));
    if (prog.enumValue("PGTY_buddy") !== BigInt(PGTY_BUDDY)) {
      throw new Error("unsupported page_type encoding (expected Linux 6.12 PGTY_* page types)");
    }
    const bit = (n: string) => {
      const v = prog.enumValue(n);
      if (v === undefined) throw new Error(`enum pageflags has no ${n}`);
      return Number(v);
    };
    this.pgReserved = bit("PG_reserved");
    this.pgHead = bit("PG_head");

    const pfnOf = (sym: string) => {
      const a = prog.symbols.addr(sym);
      if (a === undefined) throw new Error(`System.map has no ${sym}`);
      return ((a - PAGE_OFFSET) >>> 0) >>> PAGE_SHIFT;
    };
    const pfnEnd = (sym: string) => {
      const a = prog.symbols.addr(sym)!;
      return (((a - PAGE_OFFSET) >>> 0) + PAGE_SIZE - 1) >>> PAGE_SHIFT;
    };
    this.image = {
      text: [pfnOf("_text"), pfnEnd("_etext")],
      rodata: [pfnEnd("_etext"), pfnOf("_sdata")],
      data: [pfnOf("_sdata"), pfnEnd("_edata")],
      bss: [pfnOf("__bss_start"), pfnEnd("__bss_stop")],
    };

    const names: [number, string][] = [];
    const seen = new Set<number>();
    const nr = prog.enumValue("__NR_PAGEFLAGS");
    const pf = prog.btf.find("enum pageflags");
    for (const e of pf?.enumValues ?? []) {
      const v = Number(e.value);
      if (nr !== undefined && v >= Number(nr)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      names.push([v, e.name.replace(/^PG_/, "")]);
    }
    this.pageFlagNames = names;
  }

  /** DataView over all of guest RAM (refetched per use: v86 may replace its memory on restore). */
  private ramView(): DataView {
    const phys = this.machine.phys;
    const all = phys.read(0, phys.size);
    return new DataView(all.buffer, all.byteOffset, all.byteLength);
  }

  /** Physical frame number of the struct page at kernel virtual address `pageVa`. */
  pfnOfPage(pageVa: number): number {
    return Math.floor((((pageVa - this.memMapVa) >>> 0)) / this.pageSize);
  }

  /** Kernel virtual address of the struct page for `pfn`. */
  pageAddr(pfn: number): number {
    return (this.memMapVa + pfn * this.pageSize) >>> 0;
  }

  flagNames(flags: number): string[] {
    const out: string[] = [];
    for (const [b, n] of this.pageFlagNames) if (b < 32 && (flags >>> b) & 1) out.push(n);
    return out;
  }

  collect(torn: boolean): PhysSnapshot {
    const t0 = performance.now();
    const n = this.nPages;
    const kind = new Uint8Array(n);
    const flagsArr = new Uint32Array(n);
    const aux = new Uint32Array(n);
    const order = new Uint8Array(n);
    const refcount = new Int32Array(n);
    const mapcount = new Int32Array(n);

    const pcpOrder = this.pcpPages();
    const bytes = this.machine.phys.read(this.memMapPa, n * this.pageSize);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ps = this.pageSize;
    const { offFlags, offMapping, offPrivate, offCompoundHead, offPageType, offRefcount, offSlabCache } = this;
    const reservedBit = 1 << this.pgReserved;
    const headBit = 1 << this.pgHead;
    const img = this.image;
    const memMapVa = this.memMapVa;

    let freeUntil = 0; // pages [pfn, freeUntil) belong to the current free block
    let freeOrder = 0;
    let freeKind = PageKind.Free;
    for (let pfn = 0; pfn < n; pfn++) {
      const o = pfn * ps;
      const flags = dv.getUint32(o + offFlags, true);
      const mapping = dv.getUint32(o + offMapping, true);
      const pageType = dv.getUint32(o + offPageType, true);
      const ref = dv.getInt32(o + offRefcount, true);
      flagsArr[pfn] = flags;
      refcount[pfn] = ref;

      if (pfn < freeUntil) {
        kind[pfn] = freeKind;
        order[pfn] = freeOrder;
        continue;
      }
      const pcp = pcpOrder.get(pfn);
      if (pcp !== undefined) {
        kind[pfn] = freeKind = PageKind.FreePcp;
        order[pfn] = freeOrder = pcp;
        freeUntil = pfn + (1 << pcp);
        continue;
      }

      // Tail page of a compound page: same kind as its head.
      const ch = dv.getUint32(o + offCompoundHead, true);
      if (ch & 1) {
        const head = Math.floor((((ch - 1 - memMapVa) >>> 0)) / ps);
        if (head < pfn) {
          kind[pfn] = kind[head];
          aux[pfn] = aux[head];
          order[pfn] = order[head];
          continue;
        }
      }

      const type = pageType >>> 24;
      let k: PageKind;
      if (type >= 0xf0 && type <= 0xf7) {
        switch (type) {
          case PGTY_BUDDY: {
            const ord = dv.getUint32(o + offPrivate, true);
            if (ord <= 11) {
              freeOrder = ord;
              freeUntil = pfn + (1 << ord);
              freeKind = PageKind.Free;
              order[pfn] = ord;
            }
            k = PageKind.Free;
            break;
          }
          case PGTY_TABLE:
            k = PageKind.PageTable;
            break;
          case PGTY_SLAB:
            k = PageKind.Slab;
            aux[pfn] = dv.getUint32(o + offSlabCache, true);
            break;
          case PGTY_OFFLINE:
          case PGTY_GUARD:
          default:
            k = PageKind.Other;
        }
      } else {
        mapcount[pfn] = (pageType | 0) + 1;
        if (flags & reservedBit) {
          if (pfn >= img.text[0] && pfn < img.text[1]) k = PageKind.KernelText;
          else if (pfn >= img.rodata[0] && pfn < img.rodata[1]) k = PageKind.KernelRodata;
          else if (pfn >= img.data[0] && pfn < img.data[1]) k = PageKind.KernelData;
          else if (pfn >= img.bss[0] && pfn < img.bss[1]) k = PageKind.KernelBss;
          else k = PageKind.Reserved;
        } else if (mapping & 1) {
          k = PageKind.Anon;
          aux[pfn] = mapping;
        } else if (mapping !== 0 && (mapping & 2) === 0) {
          k = PageKind.File;
          aux[pfn] = mapping;
        } else if (mapping & 2) {
          k = PageKind.Other;
        } else {
          // Includes refcount-0 pages: the tails of non-compound high-order allocations.
          k = PageKind.Kernel;
        }
      }
      if (flags & headBit && pfn + 1 < n) {
        // Compound order lives in the first tail page (folio->_flags_1 & 0xff).
        const ord = dv.getUint32(o + ps + offFlags, true) & 0xff;
        if (k !== PageKind.Free && ord <= 11) order[pfn] = ord;
      }
      kind[pfn] = k;
    }

    const tasks = new Map<number, string>();
    const owners = this.collectOwners(kind, tasks);

    const counts = new Array<number>(NUM_KINDS).fill(0);
    for (let i = 0; i < n; i++) counts[kind[i]]++;

    return {
      time: t0,
      torn,
      durationMs: performance.now() - t0,
      nPages: n,
      kind,
      flags: flagsArr,
      aux,
      order,
      refcount,
      mapcount,
      counts,
      owners,
      tasks,
    };
  }

  /**
   * Pages on the per-CPU free lists of every zone: pfn -> order of the free block. Walked with raw
   * reads (all of this lives in the direct map) since it runs on every snapshot.
   */
  private pcpPages(): Map<number, number> {
    const out = new Map<number, number>();
    const ram = this.ramView();
    const u32 = (pa: number) => ram.getUint32(pa, true); // throws RangeError if out of RAM
    const lowOrder = this.migratePcpTypes * 4; // PAGE_ALLOC_COSTLY_ORDER + 1 orders
    try {
      for (const ptrPa of this.pcpPtrPas) {
        // !SMP: the __percpu pointer is the object itself.
        const pcp = u32(ptrPa);
        if (pcp < PAGE_OFFSET) continue;
        for (let i = 0; i < this.nPcpLists; i++) {
          const ord = i < lowOrder ? Math.floor(i / this.migratePcpTypes) : 0;
          const head = (pcp + this.offPcpLists + i * 8) >>> 0;
          let node = u32((head - PAGE_OFFSET) >>> 0);
          for (let guard = 0; node !== head && guard < 1 << 16; guard++) {
            if (node < PAGE_OFFSET) break; // torn
            out.set(this.pfnOfPage(node - this.offPcpList), ord);
            node = u32((node - PAGE_OFFSET) >>> 0);
          }
        }
      }
    } catch {
      // torn list: keep what we gathered
    }
    return out;
  }

  /**
   * Reverse map from page tables: user pages of every process, plus each task's kernel stack and
   * each process's page directory / page tables. Kernel stacks and page directories are untyped
   * page allocations, so this also refines their kind.
   */
  private collectOwners(kind: Uint8Array, tasks: Map<number, string>): Map<number, PageOwner[]> {
    const prog = this.prog;
    const ram = this.ramView();
    const n = this.nPages;
    const owners = new Map<number, PageOwner[]>();
    const add = (pfn: number, o: PageOwner) => {
      if (pfn >= n) return;
      const l = owners.get(pfn);
      if (l) l.push(o);
      else owners.set(pfn, [o]);
    };
    const seenMm = new Set<number>();
    try {
      for (const t of forEachTask(prog, { max: 4096 })) {
        let pid: number;
        try {
          pid = t.member("pid").num() | 0;
          tasks.set(pid, t.member("comm").cstr(16));
          const stack = t.member("stack").ptr();
          if (stack >= PAGE_OFFSET) {
            const sp = ((stack - PAGE_OFFSET) >>> 0) >>> PAGE_SHIFT;
            for (let i = 0; i < THREAD_PAGES; i++) {
              if (sp + i < n && kind[sp + i] === PageKind.Kernel) kind[sp + i] = PageKind.KernelStack;
              add(sp + i, { pid, what: "stack" });
            }
          }
        } catch {
          continue; // torn task list entry
        }
        const mmPtr = t.member("mm").ptr();
        if (!mmPtr || seenMm.has(mmPtr)) continue;
        seenMm.add(mmPtr);
        try {
          const pgdPa = mmPgdPhys(prog.value(mmPtr, "struct mm_struct"));
          const pgdPfn = pgdPa >>> PAGE_SHIFT;
          if (pgdPfn >= n) continue;
          if (kind[pgdPfn] === PageKind.Kernel) kind[pgdPfn] = PageKind.PageTable;
          add(pgdPfn, { pid, what: "pgd" });
          const userPdes = PAGE_OFFSET >>> 22;
          for (let i = 0; i < userPdes; i++) {
            const pde = ram.getUint32(pgdPa + i * 4, true);
            if (!(pde & 1)) continue;
            if (pde & 0x80) {
              // 4 MiB page (not used for user memory on this kernel, but be safe)
              const base = pde >>> PAGE_SHIFT;
              for (let j = 0; j < 1024; j++) add(base + j, { pid, what: "user", va: (i << 22) + (j << 12) });
              continue;
            }
            const ptPa = (pde & 0xfffff000) >>> 0;
            add(ptPa >>> PAGE_SHIFT, { pid, what: "pt" });
            if (ptPa + PAGE_SIZE > ram.byteLength) continue;
            for (let j = 0; j < 1024; j++) {
              const pte = ram.getUint32(ptPa + j * 4, true);
              if (!(pte & 1)) continue;
              add(pte >>> PAGE_SHIFT, { pid, what: "user", va: ((i << 22) | (j << 12)) >>> 0 });
            }
          }
        } catch {
          // torn mm; skip this process this time
        }
      }
    } catch {
      // torn task list; keep what we have
    }
    return owners;
  }
}
