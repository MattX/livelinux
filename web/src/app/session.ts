// Glue between loaded assets, the Machine and the debug layer.

import type { Btf, Program, Symbols } from "../debug/api";
import { parseBtf } from "../debug/btf";
import { parseSystemMap } from "../debug/symbols";
import { KernelProgram } from "../debug/program";
import { Machine } from "../vm/machine";
import { LiveSampler } from "../live/sampler";
import type { GuestAssets } from "./loader";

const PAGE_OFFSET = 0xc0000000;

export interface DebugInfo {
  btf: Btf;
  symbols: Symbols;
}

/** Parse BTF + System.map once (expensive); reused for every pause. */
export function parseDebugInfo(assets: GuestAssets): DebugInfo {
  return { btf: parseBtf(assets.btf), symbols: parseSystemMap(assets.systemMap) };
}

export async function bootMachine(assets: GuestAssets): Promise<Machine> {
  return Machine.create({
    wasmUrl: assets.wasmUrl,
    bios: assets.bios,
    vgaBios: assets.vgaBios,
    bzimage: assets.bzimage,
    initrd: assets.initrd,
  });
}

/**
 * Build a Program for the current pause. The kernel address space is rooted at swapper_pg_dir
 * (physical = symbol - PAGE_OFFSET), so it is valid regardless of which process was current.
 */
export function makeProgram(machine: Machine, info: DebugInfo): Program {
  const swapper = info.symbols.addr("swapper_pg_dir");
  if (swapper === undefined) throw new Error("System.map has no swapper_pg_dir");
  const space = machine.kernelSpace((swapper - PAGE_OFFSET) >>> 0);
  space.clearCache();
  return new KernelProgram(info.btf, info.symbols, space);
}

/** Kernel address space (swapper_pg_dir) for page-table walks. */
export function kernelAddressSpace(machine: Machine, prog: Program) {
  const swapper = prog.symbols.addr("swapper_pg_dir");
  if (swapper === undefined) throw new Error("System.map has no swapper_pg_dir");
  return machine.kernelSpace((swapper - PAGE_OFFSET) >>> 0);
}

/** Live sampler with its own long-lived Program (address-space caches are cleared per snapshot). */
export function makeLiveSampler(machine: Machine, info: DebugInfo): LiveSampler {
  const swapper = info.symbols.addr("swapper_pg_dir");
  if (swapper === undefined) throw new Error("System.map has no swapper_pg_dir");
  const space = machine.kernelSpace((swapper - PAGE_OFFSET) >>> 0);
  return new LiveSampler(machine, new KernelProgram(info.btf, info.symbols, space), space);
}
