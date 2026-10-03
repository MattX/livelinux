// Thin wrapper around the v86 emulator: boot, pause/resume, physical memory + register access.
// Works in the browser and in Node (DOM containers are optional).

import { V86 } from "v86";
import { AddressSpace } from "./mmu";
import type { PhysMem, Regs } from "./types";

/** A file given as a URL (browser) / path (Node), or as raw bytes. */
export type Blob_ = string | ArrayBuffer | ArrayBufferView;

export interface MachineOptions {
  /** URL (browser) or filesystem path (Node) of v86.wasm. Ignored if `wasm` is given. */
  wasmUrl?: string;
  /** v86.wasm bytes (alternative to wasmUrl). */
  wasm?: ArrayBuffer | ArrayBufferView;
  /** BIOS: URL/path or bytes. */
  bios?: Blob_;
  biosUrl?: string;
  vgaBios?: Blob_;
  vgaBiosUrl?: string;
  bzimage?: Blob_;
  initrd?: Blob_;
  cmdline?: string;
  /** Guest RAM in MiB (default 256). */
  memoryMB?: number;
  serialXterm?: HTMLElement;
  /** xterm.js `Terminal` constructor (needed with ESM when window.Terminal is not set). */
  xtermLib?: unknown;
  screenContainer?: HTMLElement;
  /** Start running immediately (default true). */
  autostart?: boolean;
}

export type MachineState = "running" | "paused";

export const DEFAULT_CMDLINE = "console=ttyS0 nokaslr tsc=reliable mitigations=off";

// Internal v86 CPU fields we rely on (verified against v86 0.5.469 build/libv86.mjs).
interface V86Cpu {
  mem8: Uint8Array;
  memory_size: Uint32Array;
  reg32: Int32Array;
  instruction_pointer: Int32Array;
  flags: Int32Array;
  cr: Int32Array;
  sreg: Uint16Array;
  segment_offsets: Int32Array;
  cpl: Uint8Array;
  in_hlt?: Uint8Array;
  main_loop: () => number;
  get_eflags?: () => number;
  get_real_eip?: () => number;
}

interface V86Emu {
  v86: { cpu: V86Cpu };
  run(): Promise<void>;
  stop(): Promise<void>;
  is_running(): boolean;
  add_listener(ev: string, cb: (arg: any) => void): void;
  remove_listener(ev: string, cb: (arg: any) => void): void;
  save_state(): Promise<ArrayBuffer>;
  restore_state(s: ArrayBuffer): Promise<void>;
  get_instruction_counter(): number;
  serial0_send(s: string): void;
  destroy(): Promise<void>;
}

function toImage(x: Blob_): { url: string } | { buffer: ArrayBuffer } {
  if (typeof x === "string") return { url: x };
  if (x instanceof ArrayBuffer) return { buffer: x };
  const v = x as ArrayBufferView;
  return { buffer: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer };
}

export class Machine {
  private readonly stateListeners = new Set<(s: MachineState) => void>();
  private readonly serialListeners = new Set<(b: number) => void>();
  private readonly sliceListeners = new Set<(sliceStart: number) => void>();
  private sliceHooked = false;

  readonly phys: PhysMem;

  private constructor(private readonly emu: V86Emu, readonly memoryBytes: number) {
    const cpu = () => this.emu.v86.cpu;
    // Re-fetch mem8 on every access: v86 may replace the view (e.g. after restore_state).
    this.phys = {
      get size() {
        const c = cpu();
        return Math.min(c.mem8.length, c.memory_size[0] >>> 0);
      },
      read(paddr: number, len: number): Uint8Array {
        const c = cpu();
        const size = Math.min(c.mem8.length, c.memory_size[0] >>> 0);
        if (!Number.isFinite(paddr) || !Number.isFinite(len) || paddr < 0 || len < 0 || paddr + len > size) {
          throw new RangeError(`physical read out of range: 0x${paddr.toString(16)}+${len} (size 0x${size.toString(16)})`);
        }
        return c.mem8.subarray(paddr, paddr + len);
      },
    };
    emu.add_listener("emulator-started", () => this.emitState("running"));
    emu.add_listener("emulator-stopped", () => this.emitState("paused"));
    emu.add_listener("serial0-output-byte", (b: number) => {
      for (const cb of this.serialListeners) cb(b);
    });
  }

  static async create(opts: MachineOptions): Promise<Machine> {
    const memoryBytes = (opts.memoryMB ?? 256) * 1024 * 1024;
    const bios = opts.bios ?? opts.biosUrl;
    const vgaBios = opts.vgaBios ?? opts.vgaBiosUrl;
    if (bios === undefined || vgaBios === undefined) throw new Error("Machine.create: bios and vgaBios are required");

    const options: Record<string, unknown> = {
      memory_size: memoryBytes,
      bios: toImage(bios),
      vga_bios: toImage(vgaBios),
      cmdline: opts.cmdline ?? DEFAULT_CMDLINE,
      autostart: opts.autostart ?? true,
      disable_keyboard: !opts.screenContainer,
      disable_mouse: true,
      disable_speaker: true,
    };
    if (opts.bzimage !== undefined) options.bzimage = toImage(opts.bzimage);
    if (opts.initrd !== undefined) options.initrd = toImage(opts.initrd);
    if (opts.wasm) {
      const bytes = opts.wasm;
      options.wasm_fn = async (imports: WebAssembly.Imports) =>
        (await WebAssembly.instantiate(bytes as BufferSource, imports)).instance.exports;
    } else if (opts.wasmUrl) {
      options.wasm_path = opts.wasmUrl;
    }
    if (opts.serialXterm) {
      options.serial_console = { type: "xtermjs", container: opts.serialXterm, xterm_lib: opts.xtermLib };
    }
    if (opts.screenContainer) options.screen = { container: opts.screenContainer };

    const emu = new (V86 as unknown as new (o: unknown) => V86Emu)(options);
    await new Promise<void>((resolve) => {
      const cb = () => {
        emu.remove_listener("emulator-loaded", cb);
        resolve();
      };
      emu.add_listener("emulator-loaded", cb);
    });
    return new Machine(emu, memoryBytes);
  }

  private get cpu(): V86Cpu {
    return this.emu.v86.cpu;
  }

  private emitState(s: MachineState): void {
    for (const cb of this.stateListeners) cb(s);
  }

  get running(): boolean {
    return this.emu.is_running();
  }

  /** Subscribe to running/paused transitions. Returns an unsubscribe function. */
  onStateChange(cb: (s: MachineState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Subscribe to bytes written by the guest to ttyS0. */
  onSerialByte(cb: (b: number) => void): () => void {
    this.serialListeners.add(cb);
    return () => this.serialListeners.delete(cb);
  }

  /**
   * Run `cb` after every emulator slice. v86 executes the guest on the JS thread in short slices
   * (`main_loop`, ~1 ms of guest time each) and yields in between, so while `cb` runs guest memory
   * and registers are quiescent: reading them is as consistent as reading them while paused (the
   * guest may still be in the middle of updating a data structure). Keep callbacks cheap; time spent
   * here is wall-clock time the guest does not run. Exceptions are caught and logged.
   * `sliceStart` is the performance.now() timestamp at which the slice began executing.
   */
  onSlice(cb: (sliceStart: number) => void): () => void {
    this.hookSlices();
    this.sliceListeners.add(cb);
    return () => this.sliceListeners.delete(cb);
  }

  private hookSlices(): void {
    if (this.sliceHooked) return;
    this.sliceHooked = true;
    const cpu = this.cpu;
    const orig = cpu.main_loop;
    cpu.main_loop = () => {
      const start = performance.now();
      const t = orig();
      for (const cb of this.sliceListeners) {
        try {
          cb(start);
        } catch (e) {
          console.error("slice listener failed", e);
        }
      }
      return t;
    };
  }

  /** True if the CPU is halted (HLT, i.e. the kernel idle loop waiting for an interrupt). */
  get halted(): boolean {
    const h = this.cpu.in_hlt;
    return h ? h[0] !== 0 : false;
  }

  /** Cheap single-register reads for per-slice sampling (no Regs object). */
  get eip(): number {
    const c = this.cpu;
    return (c.get_real_eip ? c.get_real_eip() : c.instruction_pointer[0] - c.segment_offsets[1]) >>> 0;
  }

  get cpl(): number {
    const c = this.cpu;
    return c.cpl ? c.cpl[0] : c.sreg[1] & 3;
  }

  get esp(): number {
    return this.cpu.reg32[4] >>> 0;
  }

  get cr3(): number {
    return this.cpu.cr[3] >>> 0;
  }

  serialSend(s: string): void {
    this.emu.serial0_send(s);
  }

  /** Stop the emulator; resolves once it has actually stopped (v86 stop() awaits "emulator-stopped"). */
  async pause(): Promise<void> {
    if (!this.running) return;
    await this.emu.stop();
  }

  async resume(): Promise<void> {
    await this.emu.run();
  }

  regs(): Regs {
    const c = this.cpu;
    const r = c.reg32;
    const eflags = c.get_eflags ? c.get_eflags() : c.flags[0];
    const eip = c.get_real_eip ? c.get_real_eip() : c.instruction_pointer[0] - c.segment_offsets[1];
    const s = c.sreg;
    return {
      eax: r[0] >>> 0, ecx: r[1] >>> 0, edx: r[2] >>> 0, ebx: r[3] >>> 0,
      esp: r[4] >>> 0, ebp: r[5] >>> 0, esi: r[6] >>> 0, edi: r[7] >>> 0,
      eip: eip >>> 0,
      eflags: eflags >>> 0,
      cr0: c.cr[0] >>> 0, cr2: c.cr[2] >>> 0, cr3: c.cr[3] >>> 0, cr4: c.cr[4] >>> 0,
      es: s[0], cs: s[1], ss: s[2], ds: s[3], fs: s[4], gs: s[5],
      cpl: c.cpl ? c.cpl[0] : s[1] & 3,
    };
  }

  /** Address space of the kernel: the given swapper_pg_dir physical address, or the current CR3. */
  kernelSpace(swapperPgdPhys?: number): AddressSpace {
    return this.addressSpace(swapperPgdPhys ?? this.cpu.cr[3] >>> 0);
  }

  addressSpace(cr3: number): AddressSpace {
    // Read CR4.PSE live: address spaces may outlive the boot (the kernel enables PSE early on).
    return new AddressSpace(this.phys, cr3, { pse: () => (this.cpu.cr[4] & 0x10) !== 0 });
  }

  async snapshot(): Promise<ArrayBuffer> {
    return this.emu.save_state();
  }

  async restore(buf: ArrayBuffer): Promise<void> {
    await this.emu.restore_state(buf);
  }

  getInstructionCounter(): number {
    return this.emu.get_instruction_counter();
  }

  async destroy(): Promise<void> {
    await this.emu.destroy();
  }
}
