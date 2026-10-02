// System.map parser + address lookup.

import type { Sym, Symbols } from "./api";

// Types skipped entirely: absolute (a/A), undefined (U), stabs/debug (-, N).
const SKIP = new Set(["a", "A", "U", "-", "N"]);
const TEXTISH = new Set(["T", "t", "W", "w"]);

function rank(type: string): number {
  // Prefer global over local; among those code/data/bss/rodata over weak/other.
  const upper = type === type.toUpperCase();
  let r = upper ? 4 : 0;
  if ("TDBR".includes(type.toUpperCase())) r += 2;
  return r;
}

class SymbolsImpl implements Symbols {
  readonly all: readonly Sym[];
  private byName = new Map<string, Sym>();
  /** one best symbol per distinct address, sorted */
  private lk: Sym[] = [];
  private lastAddr = 0;

  constructor(syms: Sym[]) {
    syms.sort((a, b) => a.addr - b.addr); // stable
    this.all = syms;

    for (const s of syms) {
      const prev = this.byName.get(s.name);
      if (!prev || rank(s.type) > rank(prev.type)) this.byName.set(s.name, s);
    }

    // Per-cpu symbols on i386 live at tiny offsets below the kernel image; keep
    // them out of address lookup so unrelated small numbers don't symbolize.
    let textStart = Infinity;
    for (const s of syms) if (TEXTISH.has(s.type) && s.addr < textStart) textStart = s.addr;
    if (textStart === Infinity) textStart = 0;

    let best: Sym | undefined;
    for (const s of syms) {
      if (s.addr < textStart) continue;
      if (best && best.addr === s.addr) {
        if (rank(s.type) > rank(best.type)) best = s;
        this.lk[this.lk.length - 1] = best;
      } else {
        best = s;
        this.lk.push(s);
      }
    }
    this.lastAddr = this.lk.length ? this.lk[this.lk.length - 1].addr : 0;
  }

  addr(name: string): number | undefined {
    return this.byName.get(name)?.addr;
  }

  lookup(addr: number): { sym: Sym; offset: number } | undefined {
    addr = addr >>> 0;
    const lk = this.lk;
    let lo = 0;
    let hi = lk.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lk[mid].addr <= addr) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return undefined;
    const sym = lk[found];
    const offset = addr - sym.addr;
    // Past the final symbol (_end etc.) there is nothing meaningful to name.
    if (sym.addr === this.lastAddr && offset > 0x1000) return undefined;
    return { sym, offset };
  }

  format(addr: number): string {
    const r = this.lookup(addr);
    if (!r) return "0x" + (addr >>> 0).toString(16);
    return r.offset === 0 ? r.sym.name : `${r.sym.name}+0x${r.offset.toString(16)}`;
  }
}

export function parseSystemMap(text: string): Symbols {
  const syms: Sym[] = [];
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const parts = l.split(/\s+/);
    if (parts.length < 3) continue;
    const [a, type, name] = parts;
    if (type.length !== 1 || SKIP.has(type)) continue;
    if (!/^[0-9a-fA-F]+$/.test(a)) continue;
    // i386: 32-bit addresses; tolerate 64-bit-width columns by taking the low 32 bits.
    const addr = parseInt(a.length > 8 ? a.slice(-8) : a, 16) >>> 0;
    syms.push({ name, addr, type });
  }
  return new SymbolsImpl(syms);
}
