// The 4 GiB virtual address space as a tree of named regions, for a "memory map" diagram: the user
// half from a process's VMAs (grouped per mapped file), the kernel half (i386, 3G/1G split) from
// linker symbols, kernel variables and the arch/x86/include/asm/pgtable_32_areas.h formulas.
// Rows for display are produced by vaRows(), which fills the space between regions with gaps.

import type { Program, Value } from "../api";
import type { MappedRange } from "../../vm/types";
import { PAGE_OFFSET, VMALLOC_OFFSET, type VmaInfo } from "./mm";
import { tryGet } from "./util";

export const ADDR_TOP = 0x1_0000_0000;
const PAGE = 4096;
/** i386 non-PAE: a PMD (= PGD entry) maps 4 MiB. */
const PMD_SIZE = 0x400000;
/** i386: THREAD_SIZE = 2 pages. */
export const THREAD_SIZE = 2 * PAGE;

export type RegionKind =
  | "user" | "kernel"
  // user
  | "code" | "rodata" | "data" | "bss" | "heap" | "stack" | "anon" | "file" | "vdso" | "guard"
  // kernel
  | "directmap" | "image" | "lowmem" | "struct-page" | "vmalloc" | "vmap" | "fixmap" | "cea" | "pad";

export interface VaRegion {
  /** Stable key (UI expand state). */
  id: string;
  start: number;
  /** Exclusive; up to ADDR_TOP. */
  end: number;
  label: string;
  kind: RegionKind;
  /** Short secondary text: permissions, path, physical range. */
  detail?: string;
  /** Longer explanation (tooltip). */
  note?: string;
  /** Sub-regions, ascending and non-overlapping, inside [start, end). */
  children?: VaRegion[];
  /** Whether the children are shown initially. */
  open?: boolean;
  /** Bytes of the region with a present page-table entry (see addMapped). */
  mapped?: number;
}

export interface VaMarker {
  addr: number;
  label: string;
  note?: string;
}

const hex = (n: number) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

// ---------------------------------------------------------------------------------------------
// user half

/** What a VMA is, from its flags, file and special name. */
function vmaRole(v: VmaInfo): { label: string; kind: RegionKind; note?: string } {
  const p = v.flagsStr;
  if (v.anonName === "[heap]") return { label: "[heap]", kind: "heap", note: "brk() heap: malloc's arena grows it upwards" };
  if (v.anonName === "[stack]") return { label: "[stack]", kind: "stack", note: "main thread stack: grows down on page faults below it" };
  if (v.anonName === "[vdso]") return { label: "[vdso]", kind: "vdso", note: "kernel-provided code for fast system calls (gettimeofday, ...)" };
  if (v.anonName === "[vvar]") return { label: "[vvar]", kind: "vdso", note: "kernel data read by the vDSO (clock state)" };
  if (p.startsWith("---")) return { label: v.file ? "guard" : "PROT_NONE", kind: "guard", note: "mapped but inaccessible: any access faults" };
  if (v.file) {
    if (p[3] === "s") return { label: "shared mapping", kind: "file", note: "MAP_SHARED: writes go to the file / are seen by other mappers" };
    if (p[2] === "x") return { label: "text", kind: "code", note: "executable code" };
    if (p[1] === "w") return { label: "data", kind: "data", note: "initialized writable data (private: copied on first write)" };
    return { label: "read-only", kind: "rodata", note: "headers, constants, or data made read-only after relocation (RELRO)" };
  }
  if (p[2] === "x") return { label: "anon, executable", kind: "anon" };
  return { label: "anonymous", kind: "anon", note: "private anonymous memory (mmap MAP_ANONYMOUS): zero-filled on first touch" };
}

function vmaDetail(v: VmaInfo): string {
  return v.file ? `${v.flagsStr} · ${v.file} @ +${hex(v.pgoff * PAGE)}` : v.flagsStr;
}

function vmaLeaf(v: VmaInfo, role = vmaRole(v)): VaRegion {
  return { id: `vma:${v.start.toString(16)}`, start: v.start, end: v.end, label: role.label, kind: role.kind, detail: vmaDetail(v), note: role.note };
}

/**
 * The user half [0, PAGE_OFFSET) of a process: its VMAs, with runs of adjacent VMAs of the same
 * file grouped under the file (text / read-only / data, plus the anonymous .bss right after a
 * writable file mapping).
 */
export function userRegion(list: VmaInfo[]): VaRegion {
  const children: VaRegion[] = [];
  let i = 0;
  while (i < list.length) {
    const v = list[i];
    if (!v.file) {
      children.push(vmaLeaf(v));
      i++;
      continue;
    }
    const run: VmaInfo[] = [v];
    while (i + run.length < list.length) {
      const n = list[i + run.length];
      if (n.file !== v.file || n.start !== run[run.length - 1].end) break;
      run.push(n);
    }
    i += run.length;
    const parts = run.map((x) => vmaLeaf(x));
    // .bss: anonymous, writable, private, directly after the file's writable data.
    const last = run[run.length - 1];
    const next = list[i];
    if (next && !next.file && !next.anonName && next.start === last.end && last.flagsStr === "rw-p" && next.flagsStr === "rw-p") {
      parts.push({ ...vmaLeaf(next), label: ".bss", kind: "bss", note: "zero-initialized data: anonymous memory right after the file's data" });
      i++;
    }
    if (parts.length === 1) {
      children.push({ ...parts[0], label: v.fileBase ?? baseName(v.file), detail: `${parts[0].label} · ${parts[0].detail}` });
    } else {
      children.push({
        id: `file:${v.start.toString(16)}`,
        start: run[0].start,
        end: parts[parts.length - 1].end,
        label: v.fileBase ?? baseName(v.file),
        kind: "file",
        detail: v.file,
        note: `${parts.length} mappings of ${v.file}`,
        children: parts,
        open: true,
      });
    }
  }
  return {
    id: "user",
    start: 0,
    end: PAGE_OFFSET,
    label: "user space",
    kind: "user",
    detail: `${list.length} VMAs`,
    note: "the process's own mappings; switched on every context switch (CR3)",
    children,
    open: true,
  };
}

// ---------------------------------------------------------------------------------------------
// kernel half

/** Fill the holes between ascending, non-overlapping `kids` inside [start, end) with `mk(start, end)`. */
function fillHoles(start: number, end: number, kids: VaRegion[], mk: (s: number, e: number) => VaRegion): VaRegion[] {
  const out: VaRegion[] = [];
  let cur = start;
  for (const k of kids) {
    if (k.start > cur) out.push(mk(cur, k.start));
    out.push(k);
    cur = Math.max(cur, k.end);
  }
  if (cur < end) out.push(mk(cur, end));
  return out;
}

/** Keep regions that are non-empty and fit in [lo, hi) after the previous one; sort ascending. */
function sane(list: (VaRegion | undefined)[], lo: number, hi: number): VaRegion[] {
  const out: VaRegion[] = [];
  let cur = lo;
  for (const r of list.filter((r): r is VaRegion => !!r).sort((a, b) => a.start - b.start)) {
    if (r.start < cur || r.end > hi || r.end <= r.start) continue;
    out.push(r);
    cur = r.end;
  }
  return out;
}

const physOf = (s: number, e: number) => `phys ${hex(s - PAGE_OFFSET)}–${hex(e - PAGE_OFFSET)}`;

/** The kernel image, from linker symbols. */
function kernelImage(prog: Program): VaRegion | undefined {
  const sym = (n: string) => prog.symbols.addr(n);
  const text = sym("_text");
  const end = sym("_end");
  if (text === undefined || end === undefined || end <= text) return undefined;
  const sec = (id: string, a: string, b: string, label: string, kind: RegionKind, note: string): VaRegion | undefined => {
    const s = sym(a);
    const e = sym(b);
    return s !== undefined && e !== undefined && e > s ? { id: `k.img.${id}`, start: s, end: e, label, kind, detail: `${a} – ${b}`, note } : undefined;
  };
  const kids = sane([
    sec("text", "_text", "_etext", ".text", "code", "kernel code"),
    sec("rodata", "__start_rodata", "__end_rodata", ".rodata", "rodata", "read-only data: constants, syscall table, ..."),
    sec("data", "_sdata", "_edata", ".data", "data", "initialized kernel variables (init_task, ...)"),
    sec("init", "__init_begin", "__init_end", ".init", "pad", "__init code and data, and the per-CPU template: freed after boot"),
    sec("bss", "__bss_start", "__bss_stop", ".bss", "bss", "zero-initialized kernel variables (swapper_pg_dir, ...)"),
    sec("brk", "__brk_base", "__brk_limit", ".brk", "data", "early boot allocations (initial page tables)"),
  ], text, end);
  return {
    id: "k.img",
    start: text,
    end,
    label: "kernel image",
    kind: "image",
    detail: physOf(text, end),
    note: "vmlinux, loaded at physical 16 MiB (CONFIG_PHYSICAL_START)",
    children: fillHoles(text, end, kids, (s, e) => ({ id: `k.img.pad.${s.toString(16)}`, start: s, end: e, label: "other sections / padding", kind: "pad" })),
    open: true,
  };
}

/** The kernel half [PAGE_OFFSET, 4 GiB). `vmapRanges` (mapped page-table runs) fill the vmalloc area. */
export function kernelRegion(prog: Program, vmapRanges: MappedRange[] = []): VaRegion {
  const kids: (VaRegion | undefined)[] = [];
  const highMemory = tryGet(() => prog.var("high_memory").ptr());

  // Direct map of low physical memory.
  if (highMemory !== undefined && highMemory > PAGE_OFFSET) {
    const img = kernelImage(prog);
    const memMap = tryGet(() => prog.var("mem_map").ptr());
    const nPages = tryGet(() => prog.var("max_mapnr").num()) ?? 0;
    const pageSize = tryGet(() => prog.sizeOf("struct page")) ?? 0;
    const dm: (VaRegion | undefined)[] = [img];
    if (img && img.start > PAGE_OFFSET) {
      dm.push({
        id: "k.dm.low", start: PAGE_OFFSET, end: img.start, label: "low memory below the kernel", kind: "lowmem", detail: physOf(PAGE_OFFSET, img.start),
        note: "physical 0 – 16 MiB: BIOS data and the ISA hole, the rest is ordinary free / allocated pages (ZONE_DMA)",
      });
    }
    if (memMap && nPages && pageSize) {
      const e = memMap + nPages * pageSize;
      dm.push({
        id: "k.dm.memmap", start: memMap, end: Math.min(highMemory, Math.ceil(e / PAGE) * PAGE), label: "mem_map", kind: "struct-page",
        detail: `struct page[${nPages}] · ${physOf(memMap, e)}`, note: "one struct page per physical page frame, allocated by memblock at boot",
      });
    }
    const dmKids = sane(dm, PAGE_OFFSET, highMemory);
    kids.push({
      id: "k.dm",
      start: PAGE_OFFSET,
      end: highMemory,
      label: "direct map (lowmem)",
      kind: "directmap",
      detail: physOf(PAGE_OFFSET, highMemory),
      note: "all of low physical memory mapped linearly: va = pa + PAGE_OFFSET. Slab objects, page tables, kernel stacks and page cache pages are all reached through it",
      children: fillHoles(PAGE_OFFSET, highMemory, dmKids, (s, e) => ({
        id: `k.dm.free.${s.toString(16)}`, start: s, end: e, label: "lowmem (page allocator)", kind: "lowmem", detail: physOf(s, e),
        note: "pages handed out by the buddy allocator: slab, page tables, kernel stacks, page cache, user memory, free pages",
      })),
      open: true,
    });
    kids.push({
      id: "k.vmoff", start: highMemory, end: highMemory + VMALLOC_OFFSET, label: "guard hole", kind: "guard",
      detail: "VMALLOC_OFFSET", note: "8 MiB left unmapped between the direct map and vmalloc to catch overruns",
    });
  }

  // Top of the address space: fixmap, cpu_entry_area, (pkmap), LDT remap; vmalloc below them.
  const fixTop = tryGet(() => prog.var("__FIXADDR_TOP").num()) ?? 0xfffff000;
  const endFixed = prog.enumValue("__end_of_fixed_addresses");
  const endPerm = prog.enumValue("__end_of_permanent_fixed_addresses");
  let vmallocEnd: number | undefined;
  if (endFixed !== undefined) {
    const totStart = fixTop - Number(endFixed) * PAGE;
    const fixKids: VaRegion[] = [];
    if (endPerm !== undefined) {
      const permStart = fixTop - Number(endPerm) * PAGE;
      fixKids.push({ id: "k.fix.boot", start: totStart, end: permStart, label: "boot-time slots", kind: "fixmap", note: "FIX_BTMAP: early_ioremap() windows used before vmalloc works" });
      fixKids.push({ id: "k.fix.perm", start: permStart, end: fixTop, label: "permanent slots", kind: "fixmap", note: "fixed-address pages: local APIC, kmap_local slots, ..." });
    }
    kids.push({
      id: "k.fix", start: totStart, end: fixTop, label: "fixmap", kind: "fixmap", detail: `${Number(endFixed)} slots`,
      note: "compile-time fixed virtual addresses (enum fixed_addresses), mapped on demand", children: fixKids, open: false,
    });
    const ceaSize = tryGet(() => prog.sizeOf("struct cpu_entry_area"));
    if (ceaSize) {
      const ncpu = tryGet(() => prog.var("nr_cpu_ids").num()) ?? 1;
      const ceaPages = ncpu * Math.ceil(ceaSize / PAGE);
      const ceaBase = ((totStart - PAGE * (ceaPages + 1)) & ~(PMD_SIZE - 1)) >>> 0;
      kids.push({
        id: "k.cea", start: ceaBase, end: Math.min(totStart, ceaBase + PAGE * (ceaPages + 1)), label: "cpu_entry_area", kind: "cea",
        detail: `${ncpu} CPU${ncpu === 1 ? "" : "s"}`, note: "read-only IDT page, then per CPU: GDT, TSS, entry stack, exception stacks",
      });
      const ldtBase = ((ceaBase - PAGE) & ~(PMD_SIZE - 1)) >>> 0;
      vmallocEnd = ldtBase - 2 * PAGE;
      if (prog.symbols.addr("kmap_high") !== undefined) {
        const pkmapBase = ((ldtBase - PAGE) & ~(PMD_SIZE - 1)) >>> 0;
        kids.push({ id: "k.pkmap", start: pkmapBase, end: pkmapBase + PMD_SIZE, label: "pkmap", kind: "fixmap", note: "persistent kmap() windows onto highmem pages" });
        vmallocEnd = pkmapBase - 2 * PAGE;
      }
    }
  }

  if (highMemory !== undefined && vmallocEnd !== undefined && vmallocEnd > highMemory + VMALLOC_OFFSET) {
    const start = highMemory + VMALLOC_OFFSET;
    // Merge virtually contiguous runs: one per vmalloc / ioremap area (each is followed by a guard page).
    const runs: VaRegion[] = [];
    for (const r of vmapRanges) {
      const s = Math.max(start, r.va);
      const e = Math.min(vmallocEnd, r.va + r.size);
      if (e <= s) continue;
      const last = runs[runs.length - 1];
      if (last && last.end === s) last.end = e;
      else runs.push({ id: `k.vmap.${s.toString(16)}`, start: s, end: e, label: "vmap area", kind: "vmap" });
    }
    for (const r of runs) {
      const n = (r.end - r.start) / PAGE;
      r.detail = `${n} page${n === 1 ? "" : "s"}`;
      r.note = "vmalloc(), ioremap() or vmap(): pages that need not be physically contiguous";
    }
    kids.push({
      id: "k.vmalloc", start, end: vmallocEnd, label: "vmalloc area", kind: "vmalloc", detail: `${runs.length} mapped area${runs.length === 1 ? "" : "s"}`,
      note: "VMALLOC_START – VMALLOC_END: virtually contiguous kernel allocations, mapped page by page",
      children: runs.length <= 64 ? runs : undefined, open: runs.length <= 12,
    });
  }

  return {
    id: "kernel",
    start: PAGE_OFFSET,
    end: ADDR_TOP,
    label: "kernel space",
    kind: "kernel",
    detail: "same in every process",
    note: "PAGE_OFFSET and up: shared by all processes (copied into every page directory), only accessible in kernel mode",
    children: sane(kids, PAGE_OFFSET, ADDR_TOP),
    open: true,
  };
}

// ---------------------------------------------------------------------------------------------
// page-table occupancy, markers, rows

/** Set `mapped` (bytes with a present PTE) on every region, from ascending `ranges`. */
export function addMapped(r: VaRegion, ranges: MappedRange[]): void {
  // first range ending after r.start
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid].va + ranges[mid].size <= r.start) lo = mid + 1;
    else hi = mid;
  }
  let n = 0;
  for (let i = lo; i < ranges.length && ranges[i].va < r.end; i++) {
    n += Math.min(r.end, ranges[i].va + ranges[i].size) - Math.max(r.start, ranges[i].va);
  }
  r.mapped = n;
  for (const c of r.children ?? []) addMapped(c, ranges);
}

/** Saved user-mode registers (struct pt_regs at the top of the kernel stack) of a task, or undefined. */
export function userRegs(prog: Program, task: Value): { ip: number; sp: number } | undefined {
  const stack = tryGet(() => task.member("stack").ptr());
  if (!stack) return undefined;
  const size = tryGet(() => prog.sizeOf("struct pt_regs"));
  if (!size) return undefined;
  // TOP_OF_KERNEL_STACK_PADDING is 8 on i386 without VM86 (16 with), 0 in some kernels.
  for (const pad of [8, 16, 0]) {
    const r = tryGet(() => {
      const regs = prog.value(stack + THREAD_SIZE - pad - size, "struct pt_regs");
      const cs = regs.member("cs").num() & 0xffff;
      return (cs & 3) === 3 ? { ip: regs.member("ip").num() >>> 0, sp: regs.member("sp").num() >>> 0 } : undefined;
    });
    if (r) return r;
  }
  return undefined;
}

export type VaRow =
  | { type: "region"; r: VaRegion; depth: number; open: boolean; expandable: boolean; start: number; end: number }
  | { type: "gap"; depth: number; label: string; start: number; end: number };

function gapLabel(start: number, below: VaRegion | undefined, above: VaRegion | undefined): string {
  if (below?.kind === "heap" && above?.kind === "stack") return "free: heap grows up, stack grows down";
  if (below?.kind === "heap") return "free: the heap grows up into this (brk)";
  if (above?.kind === "stack") return "free: the stack grows down into this";
  if (start === 0) return "unmapped (NULL pointers fault here)";
  return "unmapped";
}

/**
 * Display rows, highest address first: regions (descending into open ones) and the gaps between
 * siblings. Rows that are not open parents (leaves, collapsed regions, gaps) tile [lo, hi) exactly.
 */
export function vaRows(roots: VaRegion[], isOpen: (r: VaRegion) => boolean, lo = 0, hi = ADDR_TOP, depth = 0): VaRow[] {
  const out: VaRow[] = [];
  const sorted = [...roots].sort((a, b) => a.start - b.start);
  let cur = hi;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    if (r.end < cur) out.push({ type: "gap", depth, label: gapLabel(r.end, r, sorted[i + 1]), start: r.end, end: cur });
    const expandable = !!r.children?.length;
    const open = expandable && isOpen(r);
    out.push({ type: "region", r, depth, open, expandable, start: r.start, end: r.end });
    if (open) out.push(...vaRows(r.children!, isOpen, r.start, r.end, depth + 1));
    cur = r.start;
  }
  if (cur > lo) out.push({ type: "gap", depth, label: gapLabel(lo, undefined, sorted[0]), start: lo, end: cur });
  return out;
}

// ---------------------------------------------------------------------------------------------
// virtual -> physical

export interface PhysPiece {
  va: number;
  pa: number;
  size: number;
}

/** The parts of ascending page-table `ranges` that fall in [lo, hi), with their physical addresses. */
export function clipRanges(ranges: MappedRange[], lo: number, hi: number): PhysPiece[] {
  let a = 0;
  let b = ranges.length;
  while (a < b) {
    const mid = (a + b) >>> 1;
    if (ranges[mid].va + ranges[mid].size <= lo) a = mid + 1;
    else b = mid;
  }
  const out: PhysPiece[] = [];
  for (let i = a; i < ranges.length && ranges[i].va < hi; i++) {
    const r = ranges[i];
    const s = Math.max(lo, r.va);
    const e = Math.min(hi, r.va + r.size);
    if (e > s) out.push({ va: s, pa: r.pa + (s - r.va), size: e - s });
  }
  return out;
}

/** True if (almost) all of the mapped bytes are the kernel's linear direct map, va = pa + PAGE_OFFSET. */
export function isDirectMapped(pieces: PhysPiece[]): boolean {
  let lin = 0;
  let all = 0;
  for (const p of pieces) {
    all += p.size;
    if (p.va - p.pa === PAGE_OFFSET) lin += p.size;
  }
  return all > 0 && lin >= 0.9 * all;
}

/** Every virtual address at which physical address `pa` is mapped. */
export function virtualAliases(ranges: MappedRange[], pa: number): number[] {
  const out: number[] = [];
  for (const r of ranges) if (pa >= r.pa && pa < r.pa + r.size) out.push(r.va + (pa - r.pa));
  return out;
}
