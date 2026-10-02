// Shared contracts for the VM layer. Implementations live in machine.ts / mmu.ts.

/** Guest physical memory. */
export interface PhysMem {
  /** Size of guest RAM in bytes. */
  readonly size: number;
  /** Returns a view (may alias live guest RAM — copy if you keep it across resumes). Throws RangeError if out of bounds. */
  read(pa: number, len: number): Uint8Array;
}

/** Any byte-addressable memory (physical or a virtual address space). */
export interface Memory {
  /** Throws PageFault (virtual) or RangeError (physical) on unmapped / out-of-range addresses. */
  read(addr: number, len: number): Uint8Array;
}

export class PageFault extends Error {
  constructor(public readonly va: number, public readonly level: "pde" | "pte") {
    super(`page fault at 0x${(va >>> 0).toString(16).padStart(8, "0")} (${level} not present)`);
  }
}

export interface Regs {
  eax: number; ecx: number; edx: number; ebx: number;
  esp: number; ebp: number; esi: number; edi: number;
  eip: number; eflags: number;
  cr0: number; cr2: number; cr3: number; cr4: number;
  cs: number; ss: number; ds: number; es: number; fs: number; gs: number;
  /** Current privilege level (0 = kernel, 3 = user). */
  cpl: number;
}

/** One contiguous run of mapped virtual memory, as produced by AddressSpace.walkRanges. */
export interface MappedRange {
  va: number;
  pa: number;
  size: number;
  writable: boolean;
  user: boolean;
  /** True if built from 4 MiB PSE pages. */
  large: boolean;
}
