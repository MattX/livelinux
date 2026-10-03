// Per-page view of a process's VMAs (i386 2-level paging): for each page, the raw PTE and what the
// page is from the process's point of view, including copy-on-write state after fork().
// Page tables live in lowmem, so everything is read through the kernel direct map.

import type { Program } from "../api";
import { forEachTask } from "./tasks";
import { mmPgdPhys, PAGE_OFFSET, VM_SHARED, VM_WRITE, type VmaInfo } from "./mm";
import { hasMember, tryGet } from "./util";

export const PTE_PRESENT = 0x001;
export const PTE_RW = 0x002;
export const PTE_USER = 0x004;
export const PTE_ACCESSED = 0x020;
export const PTE_DIRTY = 0x040;
/** x86 _PAGE_PROTNONE (reuses the global bit on non-present PTEs). */
export const PTE_PROTNONE = 0x100;

export const enum PageUse {
  /** Not faulted in yet: no PTE (demand paging). */
  Absent = 0,
  /** Page cache page mapped by this process only. */
  File,
  /** Page cache page mapped by several processes (e.g. the same binary's text). */
  FileShared,
  /** Private anonymous page (heap, stack, written data), writable. */
  Anon,
  /** Read-only in a writable private mapping and shared: a write will copy it (copy-on-write). */
  Cow,
  /** Read-only in a writable private mapping but this process is the only user: a write reuses it. */
  WriteProtected,
  /** The shared zero page, mapped for reads of untouched anonymous memory. */
  Zero,
  /** PROT_NONE: the page exists but any access faults. */
  ProtNone,
}
export const NUM_PAGE_USES = PageUse.ProtNone + 1;

export const PAGE_USE_INFO: readonly { name: string; desc: string }[] = [
  { name: "not present", desc: "no page yet: the first access will fault one in (demand paging)" },
  { name: "file", desc: "file contents from the page cache, mapped only here" },
  { name: "file, shared", desc: "page cache page mapped by several processes" },
  { name: "anon", desc: "private anonymous memory, writable" },
  { name: "copy-on-write", desc: "shared after fork (or file-backed) and write-protected: a write copies it" },
  { name: "write-protected", desc: "write-protected but no longer shared: a write just re-enables writing" },
  { name: "zero page", desc: "the shared zero page: read but never written" },
  { name: "PROT_NONE", desc: "inaccessible (mprotect PROT_NONE)" },
];

export interface VmaPages {
  vma: VmaInfo;
  /** Raw PTE per page (0 if no page table or no entry). */
  pte: Uint32Array;
  use: Uint8Array;
  /** Mapcount of the frame (number of PTEs mapping it), 0 if absent. */
  mapcount: Int32Array;
  /** Pages per PageUse. */
  counts: number[];
  /** True if the VMA was longer than the limit and only its start is included. */
  truncated: boolean;
}

/** struct page layout, resolved once per Program. */
interface PageLayout {
  memMap: number;
  maxPfn: number;
  size: number;
  offMapping: number;
  offMapcount: number;
  offCompoundHead: number;
  zeroPfn: number;
}

const layouts = new WeakMap<Program, PageLayout>();

function pageLayout(prog: Program): PageLayout {
  let l = layouts.get(prog);
  if (!l) {
    const zero = prog.symbols.addr("empty_zero_page");
    l = {
      memMap: prog.var("mem_map").ptr(),
      maxPfn: tryGet(() => prog.var("max_mapnr").num()) ?? 0,
      size: prog.sizeOf("struct page"),
      offMapping: prog.offsetOf("struct page", "mapping"),
      offMapcount: prog.offsetOf("struct page", hasMember(prog, "struct page", "_mapcount") ? "_mapcount" : "page_type"),
      offCompoundHead: prog.offsetOf("struct page", "compound_head"),
      zeroPfn: zero !== undefined ? ((zero - PAGE_OFFSET) >>> 0) >>> 12 : -1,
    };
    layouts.set(prog, l);
  }
  return l;
}

/** Read a page table / directory (4 KiB of lowmem at physical `pa`) as 1024 entries, or null. */
function readTable(prog: Program, pa: number): Uint32Array | null {
  try {
    const b = prog.mem.read((pa + PAGE_OFFSET) >>> 0, 4096);
    const out = new Uint32Array(1024);
    new Uint8Array(out.buffer).set(b);
    return out;
  } catch {
    return null;
  }
}

function frameInfo(prog: Program, l: PageLayout, pfn: number): { anon: boolean; mapcount: number } | null {
  if (!l.memMap || (l.maxPfn && pfn >= l.maxPfn)) return null;
  try {
    const page = (l.memMap + pfn * l.size) >>> 0;
    let mapping = prog.readU32(page + l.offMapping);
    const ch = prog.readU32(page + l.offCompoundHead);
    if (ch & 1) mapping = prog.readU32(((ch - 1) >>> 0) + l.offMapping); // tail page: the folio's mapping
    const raw = prog.readU32(page + l.offMapcount) | 0;
    // Typed pages (page_type, top byte 0xf0..0xf7) have no mapcount.
    const mapcount = raw >>> 24 >= 0xf0 && raw >>> 24 <= 0xf7 ? 0 : raw + 1;
    return { anon: (mapping & 1) !== 0, mapcount };
  } catch {
    return null;
  }
}

/**
 * Pages of every VMA of a process with page directory at physical `pgdPhys`. VMAs longer than
 * `maxPages` pages are truncated (only their first `maxPages` pages are read).
 */
export function vmaPages(prog: Program, pgdPhys: number, list: VmaInfo[], maxPages = 16384): VmaPages[] {
  const l = pageLayout(prog);
  const pd = readTable(prog, pgdPhys);
  const pts = new Map<number, Uint32Array | null>();
  const pteAt = (va: number): number => {
    if (!pd) return 0;
    const pde = pd[va >>> 22];
    if (!(pde & PTE_PRESENT) || pde & 0x80) return 0;
    const ptPa = (pde & 0xfffff000) >>> 0;
    let pt = pts.get(ptPa);
    if (pt === undefined) {
      pt = readTable(prog, ptPa);
      pts.set(ptPa, pt);
    }
    return pt ? pt[(va >>> 12) & 0x3ff] : 0;
  };

  return list.map((vma) => {
    const total = Math.max(0, Math.floor((vma.end - vma.start) / 4096));
    const n = Math.min(total, maxPages);
    const pte = new Uint32Array(n);
    const use = new Uint8Array(n);
    const mapcount = new Int32Array(n);
    const counts = new Array<number>(NUM_PAGE_USES).fill(0);
    const cowable = (vma.flags & VM_WRITE) !== 0 && (vma.flags & VM_SHARED) === 0;
    for (let i = 0; i < n; i++) {
      const e = pteAt((vma.start + i * 4096) >>> 0) >>> 0;
      pte[i] = e;
      let u: PageUse;
      if (!(e & PTE_PRESENT)) {
        u = e & PTE_PROTNONE ? PageUse.ProtNone : PageUse.Absent;
      } else {
        const pfn = e >>> 12;
        const fi = pfn === l.zeroPfn ? null : frameInfo(prog, l, pfn);
        mapcount[i] = fi?.mapcount ?? 0;
        if (pfn === l.zeroPfn) u = PageUse.Zero;
        else if (cowable && !(e & PTE_RW)) {
          u = fi && fi.anon && fi.mapcount <= 1 ? PageUse.WriteProtected : PageUse.Cow;
        } else if (fi?.anon) u = PageUse.Anon;
        else u = (fi?.mapcount ?? 0) > 1 ? PageUse.FileShared : PageUse.File;
      }
      use[i] = u;
      counts[u]++;
    }
    return { vma, pte, use, mapcount, counts, truncated: n < total };
  });
}

export interface FrameMapping {
  pid: number;
  comm: string;
  va: number;
  writable: boolean;
}

/** Every user mapping of physical frame `pfn`, found by scanning all processes' page tables. */
export function whoMaps(prog: Program, pfn: number): FrameMapping[] {
  const out: FrameMapping[] = [];
  const seen = new Set<number>();
  for (const t of forEachTask(prog, { max: 4096 })) {
    const mm = tryGet(() => t.member("mm").ptr()) ?? 0;
    if (!mm || seen.has(mm)) continue;
    seen.add(mm);
    const pd = readTable(prog, mmPgdPhys(prog.value(mm, "struct mm_struct")));
    if (!pd) continue;
    for (let i = 0; i < PAGE_OFFSET >>> 22; i++) {
      const pde = pd[i];
      if (!(pde & PTE_PRESENT) || pde & 0x80) continue;
      const pt = readTable(prog, (pde & 0xfffff000) >>> 0);
      if (!pt) continue;
      for (let j = 0; j < 1024; j++) {
        const e = pt[j];
        if (e & PTE_PRESENT && e >>> 12 === pfn) {
          out.push({
            pid: t.member("pid").num() | 0,
            comm: t.member("comm").cstr(16),
            va: ((i << 22) | (j << 12)) >>> 0,
            writable: (e & PTE_RW) !== 0,
          });
        }
      }
    }
  }
  return out;
}
