// Live sampling without pausing the VM. v86 runs the guest on the JS thread in ~1 ms slices; the
// sampler hooks the end of each slice (Machine.onSlice), when guest memory is quiescent:
//  - CPU trace: a few register/memory reads every slice (see cputrace.ts).
//  - Physical memory snapshots: a full struct-page scan every `ramIntervalMs` (see physmap.ts).
//
// A slice can end at any instruction, including in the middle of a kernel list or tree update, so
// snapshots prefer slice boundaries where no kernel data structure can be mid-update on this UP
// kernel: the CPU is halted in the idle loop, or in user mode. If no such boundary arrives within
// `maxDeferMs` of the due time, the snapshot is taken anyway and marked `torn`.

import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import type { AddressSpace } from "../vm/mmu";
import { CpuRecorder, CpuTrace } from "./cputrace";
import { PhysMapper, type PhysSnapshot } from "./physmap";

export class LiveSampler {
  readonly cpu = new CpuTrace();
  /** Latest physical memory snapshot (and the one before it, for change highlighting). */
  ram: PhysSnapshot | null = null;
  prevRam: PhysSnapshot | null = null;
  /** Increments whenever `ram` changes. */
  ramVersion = 0;
  ramError: string | null = null;
  ramIntervalMs = 100;
  maxDeferMs = 25;

  private readonly recorder: CpuRecorder | null;
  readonly cpuError: string | null = null;
  private mapperInst: PhysMapper | null = null;
  private mapperRetryAt = 0;
  private cpuSubs = 0;
  private ramSubs = 0;
  private nextRamDue = 0;
  private offSlice: (() => void) | null = null;
  private readonly ramListeners = new Set<() => void>();

  constructor(readonly machine: Machine, readonly prog: Program, private readonly space: AddressSpace) {
    let rec: CpuRecorder | null = null;
    try {
      rec = new CpuRecorder(machine, prog, this.cpu);
    } catch (e) {
      this.cpuError = e instanceof Error ? e.message : String(e);
    }
    this.recorder = rec;
  }

  /** Start CPU tracing (refcounted). Returns a function that stops this subscription. */
  subscribeCpu(): () => void {
    this.cpuSubs++;
    this.updateHook();
    return once(() => {
      this.cpuSubs--;
      this.updateHook();
    });
  }

  /** Start periodic RAM snapshots (refcounted); `cb` runs after each new snapshot. */
  subscribeRam(cb?: () => void): () => void {
    this.ramSubs++;
    if (cb) this.ramListeners.add(cb);
    this.updateHook();
    if (!this.machine.running) this.collectRam(false);
    return once(() => {
      this.ramSubs--;
      if (cb) this.ramListeners.delete(cb);
      this.updateHook();
    });
  }

  /**
   * The struct-page scanner. Created lazily: the sampler exists from power-on, but the kernel's
   * page tables and mem_map only exist once it has booted far enough, so retry until it works.
   */
  get mapper(): PhysMapper | null {
    if (this.mapperInst) return this.mapperInst;
    const now = performance.now();
    if (now < this.mapperRetryAt) return null;
    try {
      this.space.clearCache();
      this.mapperInst = new PhysMapper(this.machine, this.prog);
      this.ramError = null;
    } catch (e) {
      this.ramError = `kernel not ready (${e instanceof Error ? e.message : String(e)})`;
      this.mapperRetryAt = now + 500;
    }
    return this.mapperInst;
  }

  /** Take a RAM snapshot right now (e.g. when the VM is paused). */
  collectRam(torn = false): void {
    const mapper = this.mapper;
    if (!mapper) {
      for (const cb of this.ramListeners) cb();
      return;
    }
    try {
      this.space.clearCache();
      const snap = mapper.collect(torn);
      this.prevRam = this.ram;
      this.ram = snap;
      this.ramVersion++;
      this.ramError = null;
    } catch (e) {
      console.error(e);
      this.ramError = e instanceof Error ? e.message : String(e);
    }
    for (const cb of this.ramListeners) cb();
  }

  dispose(): void {
    this.offSlice?.();
    this.offSlice = null;
  }

  private updateHook(): void {
    const want = this.cpuSubs > 0 || this.ramSubs > 0;
    if (want && !this.offSlice) this.offSlice = this.machine.onSlice((start) => this.onSlice(start));
    else if (!want && this.offSlice) {
      this.offSlice();
      this.offSlice = null;
    }
  }

  private onSlice(start: number): void {
    if (this.cpuSubs > 0) this.recorder?.record(start);
    if (this.ramSubs > 0) {
      const now = performance.now();
      if (now < this.nextRamDue) return;
      if (!this.mapper) {
        this.nextRamDue = now + this.ramIntervalMs;
        for (const cb of this.ramListeners) cb();
        return;
      }
      const m = this.machine;
      const quiet = m.halted || m.cpl === 3;
      if (!quiet && now < this.nextRamDue + this.maxDeferMs) return;
      this.collectRam(!quiet);
      // Schedule from the end of collection so a slow scan cannot eat the whole budget.
      this.nextRamDue = performance.now() + this.ramIntervalMs;
    }
  }
}

function once(f: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    f();
  };
}
