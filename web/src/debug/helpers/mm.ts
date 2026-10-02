// Memory-management helpers (drgn.helpers.linux.mm style) for Linux 6.12 i386.

import type { Program, Value } from "../api";
import { mtForEach } from "./maple";
import { asObject, tryGet, WalkOpts } from "./util";

export const PAGE_OFFSET = 0xc0000000;
export const VM_READ = 0x1;
export const VM_WRITE = 0x2;
export const VM_EXEC = 0x4;
export const VM_SHARED = 0x8;
/** x86 VMALLOC_OFFSET gap after high_memory. */
export const VMALLOC_OFFSET = 8 * 1024 * 1024;

export interface VmaInfo {
  /** Address of the vm_area_struct. */
  addr: number;
  start: number;
  end: number;
  flags: number;
  /** "rwxp" / "rwxs" as in /proc/pid/maps. */
  flagsStr: string;
  /** vm_pgoff, in pages. */
  pgoff: number;
  /** Full path of the mapped file (dentry chain walk, mount points not crossed), or the bare name as fallback. */
  file?: string;
  /** Last path component of the mapped file. */
  fileBase?: string;
  /** Inode number / device of the mapped file (best effort). */
  ino?: number;
  dev?: number;
  /** "[heap]", "[stack]", "[vdso]", "[vvar]" for anonymous special mappings (best effort). */
  anonName?: string;
  /** file ?? anonName */
  name?: string;
}

export function vmFlagsStr(flags: number): string {
  return (flags & VM_READ ? "r" : "-") + (flags & VM_WRITE ? "w" : "-") +
    (flags & VM_EXEC ? "x" : "-") + (flags & VM_SHARED ? "s" : "p");
}

function dentryName(d: Value): string {
  const n = tryGet(() => d.member("d_name.name").cstr(256));
  if (n !== undefined && n !== "") return n;
  return tryGet(() => d.member("d_iname").cstr(64)) ?? "";
}

/** Best-effort full path of a `struct dentry *` by walking d_parent. */
function dentryPath(prog: Program, dentryPtr: number): { path: string; base: string } {
  const parts: string[] = [];
  let cur = dentryPtr;
  for (let i = 0; i < 64 && cur !== 0; i++) {
    const d = prog.value(cur, "struct dentry");
    const name = dentryName(d);
    const parent = d.member("d_parent").ptr();
    if (parent === cur || parent === 0) break; // root
    parts.push(name);
    cur = parent;
  }
  const base = parts[0] ?? "/";
  return { path: "/" + parts.reverse().join("/"), base };
}

function fileInfo(prog: Program, filePtr: number) {
  const f = prog.value(filePtr, "struct file");
  const dentry = f.member("f_path.dentry").ptr();
  let path: string | undefined;
  let base: string | undefined;
  if (dentry !== 0) {
    const p = tryGet(() => dentryPath(prog, dentry));
    if (p) {
      path = p.path;
      base = p.base;
    }
    if (path === undefined) {
      const n = tryGet(() => dentryName(prog.value(dentry, "struct dentry")));
      if (n) path = base = n;
    }
  }
  let ino: number | undefined;
  let dev: number | undefined;
  const inodePtr = tryGet(() => f.member("f_inode").ptr());
  if (inodePtr) {
    const inode = prog.value(inodePtr, "struct inode");
    ino = tryGet(() => inode.member("i_ino").num());
    dev = tryGet(() => {
      const sb = inode.member("i_sb").ptr();
      return sb ? prog.value(sb, "struct super_block").member("s_dev").num() : undefined;
    });
  }
  return { path, base, ino, dev };
}

/** VMAs of an mm (`struct mm_struct` or pointer), ascending, from mm.mm_mt. */
export function vmas(prog: Program, mm: Value, opts: WalkOpts = {}): VmaInfo[] {
  const m = asObject(mm);
  const brk = tryGet(() => m.member("brk").num());
  const startBrk = tryGet(() => m.member("start_brk").num());
  const startStack = tryGet(() => m.member("start_stack").num());
  const vdso = tryGet(() => m.member("context.vdso").ptr());
  const out: VmaInfo[] = [];
  for (const { entry } of mtForEach(m.member("mm_mt"), opts)) {
    const vma = prog.value(entry, "struct vm_area_struct");
    const start = vma.member("vm_start").num();
    const end = vma.member("vm_end").num();
    const flags = vma.member("vm_flags").num();
    const info: VmaInfo = {
      addr: entry,
      start,
      end,
      flags,
      flagsStr: vmFlagsStr(flags),
      pgoff: vma.member("vm_pgoff").num(),
    };
    const filePtr = tryGet(() => vma.member("vm_file").ptr()) ?? 0;
    if (filePtr !== 0) {
      const fi = tryGet(() => fileInfo(prog, filePtr));
      if (fi) {
        info.file = fi.path;
        info.fileBase = fi.base;
        info.ino = fi.ino;
        info.dev = fi.dev;
      }
    } else {
      if (startStack !== undefined && start <= startStack && startStack <= end) info.anonName = "[stack]";
      else if (brk !== undefined && startBrk !== undefined && start <= brk && end >= startBrk) info.anonName = "[heap]";
      else if (vdso && start === vdso) info.anonName = "[vdso]";
      else if (vdso && end === vdso) info.anonName = "[vvar]";
    }
    info.name = info.file ?? info.anonName;
    out.push(info);
  }
  return out;
}

/** Physical address of the mm's page directory (pgd lives in lowmem). Null/absent pgd -> 0. */
export function mmPgdPhys(mm: Value): number {
  const m = asObject(mm);
  return (m.member("pgd").ptr() - PAGE_OFFSET) >>> 0;
}

export interface KernelLayoutEntry {
  name: string;
  addr: number;
  /** symbol: System.map address; variable: value of a kernel variable; derived: computed. */
  kind: "symbol" | "variable" | "derived";
  note?: string;
}

/** Notable kernel virtual addresses (best effort; entries whose symbol is missing are skipped), sorted by address. */
export function kernelLayout(prog: Program): KernelLayoutEntry[] {
  const out: KernelLayoutEntry[] = [{ name: "PAGE_OFFSET", addr: PAGE_OFFSET, kind: "derived", note: "start of kernel direct map" }];
  for (const name of ["_text", "_etext", "_sdata", "_edata", "__init_begin", "__init_end", "__bss_start", "__bss_stop", "_end"]) {
    const addr = prog.symbols.addr(name);
    if (addr !== undefined) out.push({ name, addr, kind: "symbol" });
  }
  const hm = tryGet(() => prog.var("high_memory").ptr());
  if (hm !== undefined) {
    out.push({ name: "high_memory", addr: hm, kind: "variable", note: "end of direct-mapped lowmem" });
    out.push({
      name: "VMALLOC_START", addr: (hm + VMALLOC_OFFSET) >>> 0, kind: "derived",
      note: "high_memory + 8 MiB (VMALLOC_OFFSET)",
    });
  }
  return out.sort((a, b) => a.addr - b.addr);
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

/** /proc/pid/maps-like text (32-bit layout; path column padded as in seq_pad). */
export function formatMaps(list: VmaInfo[]): string {
  const lines = list.map((v) => {
    const dev = v.dev ?? 0;
    const prefix = `${hex8(v.start)}-${hex8(v.end)} ${v.flagsStr} ${(BigInt(v.pgoff) << 12n).toString(16).padStart(8, "0")} ` +
      `${(dev >>> 20).toString(16).padStart(2, "0")}:${(dev & 0xfffff).toString(16).padStart(2, "0")} ${v.ino ?? 0} `;
    const name = v.name;
    return name ? prefix.padEnd(48, " ") + " " + name : prefix.trimEnd();
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}
