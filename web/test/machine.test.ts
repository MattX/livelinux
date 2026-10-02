import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = existsSync(guest("bzImage")) && existsSync(guest("initramfs.cpio.gz")) && existsSync(guest("System.map"));

function symbol(name: string): number {
  for (const line of readFileSync(guest("System.map"), "utf8").split("\n")) {
    const [addr, , sym] = line.split(" ");
    if (sym === name) return parseInt(addr, 16) >>> 0;
  }
  throw new Error(`symbol ${name} not in System.map`);
}

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!have)("Machine (real guest)", () => {
  it(
    "boots, pauses, exposes memory, and cycles pause/resume",
    async () => {
      const m = await Machine.create({
        wasm: ab(resolve(root, "node_modules/v86/build/v86.wasm")),
        bios: ab(resolve(root, "public/bios/seabios.bin")),
        vgaBios: ab(resolve(root, "public/bios/vgabios.bin")),
        bzimage: ab(guest("bzImage")),
        initrd: ab(guest("initramfs.cpio.gz")),
      });
      try {
        const states: string[] = [];
        m.onStateChange((s) => states.push(s));

        let serial = "";
        await new Promise<void>((res, rej) => {
          const t = setTimeout(() => rej(new Error("boot timeout; serial so far:\n" + serial.slice(-2000))), 120_000);
          m.onSerialByte((b) => {
            serial += String.fromCharCode(b);
            if (/(^|\n)[^\n]*# $/.test(serial) || serial.includes("livelinux")) {
              clearTimeout(t);
              res();
            }
          });
        });
        expect(serial).toContain("Linux version 6.12");

        await m.pause();
        expect(m.running).toBe(false);
        expect(states).toContain("paused");

        const r = m.regs();
        expect(r.cr3).not.toBe(0);
        expect(r.cr0 & 0x80000000).not.toBe(0); // paging on
        expect(r.cs & 3).toBe(r.cpl);
        expect(r.eflags & 2).toBe(2); // reserved bit 1 always set

        const ks = m.kernelSpace();
        const banner = new TextDecoder().decode(ks.read(symbol("linux_banner"), 20));
        expect(banner.startsWith("Linux version 6.12")).toBe(true);

        const ranges = ks.walkRanges(0xc0000000);
        expect(ranges.length).toBeGreaterThan(0);
        const lowmem = ranges.find((x) => x.va <= 0xc0000000 && x.va + x.size > 0xc0000000);
        expect(lowmem).toBeDefined();
        expect(lowmem!.pa).toBe(0);

        const ic1 = m.getInstructionCounter();
        await m.resume();
        expect(m.running).toBe(true);
        await new Promise((r) => setTimeout(r, 500));
        await m.pause();
        expect(m.running).toBe(false);
        expect(m.getInstructionCounter()).not.toBe(ic1);
        expect(m.regs().cr3).not.toBe(0);
        expect(new TextDecoder().decode(m.kernelSpace().read(symbol("linux_banner"), 13))).toBe("Linux version");
      } finally {
        await m.pause();
        await m.destroy().catch(() => {});
      }
    },
    180_000,
  );
});

describe("Machine module", () => {
  it("exports Machine", () => {
    expect(typeof Machine.create).toBe("function");
  });
});
