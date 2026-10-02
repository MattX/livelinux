// Per-slice CPU trace: after every v86 slice (~1 ms) record which task is current, whether the CPU
// is in user mode / kernel mode / halted, and the EIP. A ring buffer of plain typed arrays, so
// recording costs a few hundred nanoseconds and nothing is allocated per sample.

import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";

const PAGE_OFFSET = 0xc0000000;

export const CPU_USER = 1;
export const CPU_HALTED = 2;
/**
 * The slice ended on an interrupt/exception entry stub. v86 delivers pending IRQs right before it
 * ends a slice, so this is common; eip/CPU_USER then describe the interrupted context, read from
 * the hardware interrupt frame, instead of the stub.
 */
export const CPU_IRQ = 4;

/** Re-read the current task's comm this often, so exec renames show up. */
const NAME_REFRESH_MS = 50;

/** i386 __KERNEL_CS / __USER_CS selectors. */
const KERNEL_CS = 0x60;
const USER_CS = 0x73;

export interface TaskName {
  pid: number;
  comm: string;
  /** task_struct address. */
  addr?: number;
}

export class CpuTrace {
  readonly capacity: number;
  /**
   * performance.now() when the slice started / ended. Between one slice's end and the next one's
   * start the guest does not run: if the earlier slice ended halted that gap is guest idle time
   * (v86 sleeps until the next timer), otherwise it is emulator/browser overhead.
   */
  readonly tStart: Float64Array;
  readonly tEnd: Float64Array;
  /** Guest instructions executed during the slice. */
  readonly instrs: Float64Array;
  /**
   * Opaque key of the task that was `current` at the end of the slice (0 if unreadable). One key
   * per task incarnation: a freed task_struct reused for a new pid gets a new key. Look it up in
   * `tasks`.
   */
  readonly task: Uint32Array;
  readonly eip: Uint32Array;
  /** CPU_USER | CPU_HALTED */
  readonly flags: Uint8Array;
  /** Index the next sample is written to. */
  head = 0;
  /** Number of valid samples (<= capacity). */
  count = 0;
  /** Total samples ever recorded (monotonic; use to detect new data). */
  total = 0;
  /** Task key -> pid/comm (comm refreshed while the task runs, so exec renames show up). */
  readonly tasks = new Map<number, TaskName>();

  constructor(capacity = 1 << 16) {
    this.capacity = capacity;
    this.tStart = new Float64Array(capacity);
    this.tEnd = new Float64Array(capacity);
    this.instrs = new Float64Array(capacity);
    this.task = new Uint32Array(capacity);
    this.eip = new Uint32Array(capacity);
    this.flags = new Uint8Array(capacity);
  }

  push(tStart: number, tEnd: number, instrs: number, task: number, eip: number, flags: number): void {
    const i = this.head;
    this.tStart[i] = tStart;
    this.tEnd[i] = tEnd;
    this.instrs[i] = instrs;
    this.task[i] = task;
    this.eip[i] = eip;
    this.flags[i] = flags;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
  }

  /** Ring index of the k-th oldest valid sample (k in [0, count)). */
  index(k: number): number {
    return (this.head - this.count + k + this.capacity) % this.capacity;
  }

  /** Ring indices of samples whose slice ended at or after `since`, oldest first. */
  *since(since: number): Generator<number> {
    // Binary search on tEnd (monotonic in ring order).
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.tEnd[this.index(mid)] < since) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < this.count; k++) yield this.index(k);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/**
 * Records one sample per slice into a CpuTrace. All struct offsets are resolved once from BTF; per
 * sample it reads `pcpu_hot.current_task` (UP kernel: a plain global) and, when `current` changed
 * (or every NAME_REFRESH_MS), the task's pid and comm, directly from guest physical memory.
 */
export class CpuRecorder {
  private readonly curPa: number;
  private readonly pidOff: number;
  private readonly commOff: number;
  private readonly irqLo: number;
  private readonly irqHi: number;
  private lastTask = -1;
  private lastKey = 0;
  private lastRefresh = 0;
  private nextKey = 1;
  /** "addr:pid" -> task key */
  private readonly keys = new Map<string, number>();
  private lastInstr: number;

  constructor(private readonly machine: Machine, private readonly prog: Program, readonly trace: CpuTrace) {
    const hot = prog.symbols.addr("pcpu_hot");
    if (hot === undefined) throw new Error("System.map has no pcpu_hot");
    this.curPa = (hot + prog.offsetOf("struct pcpu_hot", "current_task") - PAGE_OFFSET) >>> 0;
    this.pidOff = prog.offsetOf("struct task_struct", "pid");
    this.commOff = prog.offsetOf("struct task_struct", "comm");
    this.irqLo = prog.symbols.addr("__irqentry_text_start") ?? 0;
    this.irqHi = prog.symbols.addr("__irqentry_text_end") ?? 0;
    this.lastInstr = machine.getInstructionCounter();
  }

  /** Call after a slice that began executing at `sliceStart` (performance.now()). */
  record(sliceStart: number): void {
    const m = this.machine;
    const now = performance.now();
    const instr = m.getInstructionCounter();
    const phys = m.phys;
    const b = phys.read(this.curPa, 4);
    const task = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    if (task !== this.lastTask || now - this.lastRefresh > NAME_REFRESH_MS) {
      this.lastTask = task;
      this.lastRefresh = now;
      this.lastKey = this.refreshTask(task);
    }
    let flags = (m.cpl === 3 ? CPU_USER : 0) | (m.halted ? CPU_HALTED : 0);
    let eip = m.eip;
    if (eip >= this.irqLo && eip < this.irqHi) {
      const frame = this.interruptFrame();
      if (frame) {
        eip = frame.eip;
        flags = (flags & ~CPU_USER) | (frame.user ? CPU_USER : 0) | CPU_IRQ;
      }
    }
    // The counter is a wrapping u32.
    const delta = (instr - this.lastInstr + 0x1_0000_0000) % 0x1_0000_0000;
    this.trace.push(sliceStart, now, delta, this.lastKey, eip, flags);
    this.lastInstr = instr;
  }

  /**
   * At the first instructions of an entry stub the stack holds the hardware frame:
   * [error code,] EIP, CS, EFLAGS (+ ESP, SS from user mode). The stack may be the entry
   * trampoline stack in the cpu_entry_area fixmap, so read it through the kernel page tables.
   */
  private interruptFrame(): { eip: number; user: boolean } | null {
    try {
      const b = this.prog.mem.read(this.machine.esp, 12);
      const w = (i: number) => (b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24)) >>> 0;
      for (const i of [1, 2]) {
        const cs = w(i) & 0xffff;
        if (cs === KERNEL_CS || cs === USER_CS) return { eip: w(i - 1), user: cs === USER_CS };
      }
    } catch {
      // unmapped stack: keep the stub address
    }
    return null;
  }

  /** Read pid/comm of the task_struct at `task` and return its key (0 if unreadable). */
  private refreshTask(task: number): number {
    const pa = (task - PAGE_OFFSET) >>> 0;
    try {
      const phys = this.machine.phys;
      const p = phys.read(pa + this.pidOff, 4);
      const pid = p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24);
      const c = phys.read(pa + this.commOff, 16);
      let comm = "";
      for (let i = 0; i < 16 && c[i] !== 0; i++) comm += String.fromCharCode(c[i]);
      const id = `${task}:${pid}`;
      let key = this.keys.get(id);
      if (key === undefined) {
        key = this.nextKey++;
        this.keys.set(id, key);
        this.tasks.set(key, { pid, comm, addr: task });
      } else {
        this.tasks.get(key)!.comm = comm;
      }
      return key;
    } catch {
      return 0; // not a lowmem address (garbage while torn)
    }
  }

  private get tasks() {
    return this.trace.tasks;
  }
}
