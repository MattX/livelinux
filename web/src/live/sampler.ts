// Live sampling without pausing the VM. v86 runs the guest on the JS thread in ~1 ms slices; the
// sampler hooks the end of each slice (Machine.onSlice), when guest memory is quiescent:
//  - CPU trace: a few register/memory reads every slice (see cputrace.ts).
//  - Physical memory snapshots: a full struct-page scan every `ramIntervalMs` (see physmap.ts).
//  - Inspector ticks: every `tickIntervalMs`, callbacks that re-read whatever the inspector tabs
//    show (tasks, runqueue, a struct, ...) run synchronously inside the slice hook.
//
// A slice can end at any instruction, including in the middle of a kernel list or tree update, so
// snapshots prefer slice boundaries where no kernel data structure can be mid-update on this UP
// kernel: the CPU is halted in the idle loop, or in user mode. If no such boundary arrives within
// `maxDeferMs` of the due time, the snapshot is taken anyway and marked `torn`. Inspector ticks
// follow the same rule.

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
  /** Period of inspector ticks; 0 = only on request (a new subscription). */
  tickIntervalMs = 500;
  /** Increments on every inspector tick. */
  tickVersion = 0;
  /** Whether the latest inspector tick had to be taken at a non-quiet boundary. */
  tickTorn = false;
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
  private readonly tickSubs = new Set<TickSub>();
  private nextTickDue = 0;
  private tickPendingSince = Infinity;

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
   * Run `cb` on inspector ticks: at the first quiet slice boundary after subscribing, then every
   * `tickIntervalMs`. `cb` runs inside the slice hook, so everything it reads (and anything rendered
   * from microtasks it queues, e.g. Preact state updates) sees one consistent guest state. The
   * kernel address space's page-table cache is cleared before each tick. Returns an unsubscribe
   * function. Ticks only happen while the VM runs.
   */
  subscribeTick(cb: (torn: boolean) => void): () => void {
    const sub: TickSub = { cb, pending: true };
    this.tickSubs.add(sub);
    this.updateHook();
    return once(() => {
      this.tickSubs.delete(sub);
      this.updateHook();
    });
  }

  /** Run every tick subscriber at the next quiet boundary (a manual refresh). */
  requestTick(): void {
    for (const s of this.tickSubs) s.pending = true;
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
    const want = this.cpuSubs > 0 || this.ramSubs > 0 || this.tickSubs.size > 0;
    if (want && !this.offSlice) this.offSlice = this.machine.onSlice((start) => this.onSlice(start));
    else if (!want && this.offSlice) {
      this.offSlice();
      this.offSlice = null;
    }
  }

  private onSlice(start: number): void {
    if (this.cpuSubs > 0) this.recorder?.record(start);
    if (this.ramSubs > 0) this.ramSlice();
    if (this.tickSubs.size > 0) this.tickSlice();
  }

  /** At a quiet boundary (idle or user mode) no kernel data structure can be mid-update on UP. */
  private get quiet(): boolean {
    const m = this.machine;
    return m.halted || m.cpl === 3;
  }

  private ramSlice(): void {
    const now = performance.now();
    if (now < this.nextRamDue) return;
    if (!this.mapper) {
      this.nextRamDue = now + this.ramIntervalMs;
      for (const cb of this.ramListeners) cb();
      return;
    }
    const quiet = this.quiet;
    if (!quiet && now < this.nextRamDue + this.maxDeferMs) return;
    this.collectRam(!quiet);
    // Schedule from the end of collection so a slow scan cannot eat the whole budget.
    this.nextRamDue = performance.now() + this.ramIntervalMs;
  }

  private tickSlice(): void {
    const now = performance.now();
    const periodic = this.tickIntervalMs > 0 && now >= this.nextTickDue;
    let pending = periodic;
    for (const s of this.tickSubs) pending ||= s.pending;
    if (!pending) return;
    if (this.tickPendingSince === Infinity) this.tickPendingSince = now;
    const quiet = this.quiet;
    if (!quiet && now < this.tickPendingSince + this.maxDeferMs) return;
    this.tickPendingSince = Infinity;
    this.space.clearCache();
    this.tickVersion++;
    this.tickTorn = !quiet;
    // Copy: callbacks may unsubscribe (or subscribe) while we iterate.
    for (const s of [...this.tickSubs]) {
      if (!periodic && !s.pending) continue;
      s.pending = false;
      try {
        s.cb(!quiet);
      } catch (e) {
        console.error("inspector tick failed", e);
      }
    }
    if (periodic) this.nextTickDue = performance.now() + this.tickIntervalMs;
  }
}

interface TickSub {
  cb: (torn: boolean) => void;
  pending: boolean;
}

function once(f: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    f();
  };
}
