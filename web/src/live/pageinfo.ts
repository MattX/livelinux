// Details for one page frame of a PhysSnapshot, resolved lazily (on hover) from live guest memory:
// file names for page-cache pages, slab cache names, owning processes, kernel symbols.

import type { Program } from "../debug/api";
import { dentryPath, PAGE_OFFSET, tryGet } from "../debug/helpers";
import { KIND_INFO, PageKind, PAGE_SHIFT, type PhysMapper, type PhysSnapshot } from "./physmap";

export interface PageDetails {
  pfn: number;
  pa: number;
  kind: PageKind;
  kindName: string;
  flags: string[];
  refcount: number;
  mapcount: number;
  order: number;
  /** Human-readable "what is this" line, e.g. "/bin/busybox +0x3000" or "slab: task_struct". */
  what?: string;
  /** Owning processes, e.g. "sh (pid 42) @ 0x0804a000". */
  owners: string[];
}

const nameCache = new Map<string, string | undefined>();

function cached(key: string, f: () => string | undefined): string | undefined {
  if (nameCache.has(key)) return nameCache.get(key);
  const v = tryGet(f);
  // Only cache successes: a failed read may be a torn moment.
  if (v !== undefined) {
    if (nameCache.size > 4096) nameCache.clear();
    nameCache.set(key, v);
  }
  return v;
}

/** Path of the file an address_space belongs to (via host inode -> first dentry alias). */
export function mappingFileName(prog: Program, mapping: number): string | undefined {
  return cached(`as:${mapping}`, () => {
    const as = prog.value(mapping, "struct address_space");
    const host = as.member("host").ptr();
    if (!host) return undefined;
    const first = prog.value(host, "struct inode").member("i_dentry.first").ptr();
    if (!first) {
      const ino = prog.value(host, "struct inode").member("i_ino").num();
      return `inode ${ino}`;
    }
    const dentry = prog.containerOf(first, "struct dentry", "d_u.d_alias");
    return dentryPath(prog, dentry.addr).path;
  });
}

export function slabCacheName(prog: Program, cache: number): string | undefined {
  return cached(`kc:${cache}`, () => prog.value(cache, "struct kmem_cache").member("name").cstr(64));
}

export function describePage(prog: Program, mapper: PhysMapper, snap: PhysSnapshot, pfn: number): PageDetails {
  const kind = snap.kind[pfn] as PageKind;
  const d: PageDetails = {
    pfn,
    pa: pfn << PAGE_SHIFT,
    kind,
    kindName: KIND_INFO[kind]?.name ?? "?",
    flags: mapper.flagNames(snap.flags[pfn]),
    refcount: snap.refcount[pfn],
    mapcount: snap.mapcount[pfn],
    order: snap.order[pfn],
    owners: [],
  };
  const aux = snap.aux[pfn];
  switch (kind) {
    case PageKind.File: {
      const name = mappingFileName(prog, aux);
      const index = tryGet(() => prog.value(mapper.pageAddr(pfn), "struct page").member("index").num());
      d.what = (name ?? `address_space 0x${aux.toString(16)}`) + (index !== undefined ? ` +0x${(index << PAGE_SHIFT).toString(16)}` : "");
      break;
    }
    case PageKind.Slab: {
      const name = aux ? slabCacheName(prog, aux) : undefined;
      d.what = `slab cache: ${name ?? "?"}`;
      break;
    }
    case PageKind.Free:
      d.what = `free block of ${1 << d.order} page${d.order ? "s" : ""} (order ${d.order})`;
      break;
    case PageKind.KernelText:
    case PageKind.KernelRodata:
    case PageKind.KernelData:
    case PageKind.KernelBss: {
      const va = (d.pa + PAGE_OFFSET) >>> 0;
      const sym = prog.symbols.lookup(va);
      d.what = sym ? `starts in ${sym.sym.name}+0x${sym.offset.toString(16)}` : undefined;
      break;
    }
  }
  for (const o of snap.owners.get(pfn) ?? []) {
    const comm = snap.tasks.get(o.pid) ?? "?";
    const who = `${comm} (pid ${o.pid})`;
    switch (o.what) {
      case "user":
        d.owners.push(`${who} maps it at 0x${(o.va! >>> 0).toString(16).padStart(8, "0")}`);
        break;
      case "stack":
        d.owners.push(`kernel stack of ${who}`);
        break;
      case "pgd":
        d.owners.push(`page directory of ${who}`);
        break;
      case "pt":
        d.owners.push(`page table of ${who}`);
        break;
    }
  }
  return d;
}
