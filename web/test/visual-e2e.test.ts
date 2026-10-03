// End-to-end checks for the data behind the visual views (address-space pages / copy-on-write and
// the EEVDF number line) against the real guest.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import { eevdf, findTask, forEachTask, mmPgdPhys, PageUse, runqueue, taskInfo, vmaPages, vmas, whoMaps } from "../src/debug/helpers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = ["bzImage", "initramfs.cpio.gz", "System.map", "vmlinux.btf"].every((f) => existsSync(guest(f)));

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!have)("visual views against the live guest", () => {
  it(
    "classifies copy-on-write pages after fork and computes the EEVDF pick",
    async () => {
      const m = await Machine.create({
        wasm: ab(resolve(root, "node_modules/v86/build/v86.wasm")),
        bios: ab(resolve(root, "public/bios/seabios.bin")),
        vgaBios: ab(resolve(root, "public/bios/vgabios.bin")),
        bzimage: ab(guest("bzImage")),
        initrd: ab(guest("initramfs.cpio.gz")),
      });
      try {
        let serial = "";
        m.onSerialByte((b) => (serial += String.fromCharCode(b)));
        const waitFor = (re: RegExp, from: number, ms = 120_000) =>
          new Promise<RegExpMatchArray>((res, rej) => {
            const deadline = Date.now() + ms;
            const tick = () => {
              const match = serial.slice(from).match(re);
              if (match) return res(match);
              if (Date.now() > deadline) return rej(new Error(`timeout waiting for ${re}; serial:\n${serial.slice(-2000)}`));
              setTimeout(tick, 50);
            };
            tick();
          });

        await waitFor(/# $/m, 0);
        const mark = serial.length;
        m.serialSend("/demo/forker 2 & /demo/mapper & /demo/spin 600 & /demo/spin 600 & /demo/spin 600 &\n");
        const hdr = await waitFor(/mapper: pid (\d+) anon=0x([0-9a-f]+) ro=0x([0-9a-f]+)/, mark);
        await waitFor(/forker: child 1 pid \d+/, mark);
        await new Promise((r) => setTimeout(r, 1500));
        await m.pause();

        const symbols = parseSystemMap(readFileSync(guest("System.map"), "utf8"));
        const btf = parseBtf(ab(guest("vmlinux.btf")));
        const swapper = symbols.addr("swapper_pg_dir")!;
        const prog = new KernelProgram(btf, symbols, m.kernelSpace((swapper - 0xc0000000) >>> 0));
        const tasks = [...forEachTask(prog)].map(taskInfo);
        const forkers = tasks.filter((t) => t.comm === "forker");
        const parent = forkers.find((t) => forkers.some((c) => c.ppid === t.pid))!;
        const child = forkers.find((t) => t.ppid === parent.pid)!;

        const pagesOf = (pid: number) => {
          const mm = findTask(prog, pid)!.member("mm").deref();
          return vmaPages(prog, mmPgdPhys(mm), vmas(prog, mm));
        };

        // The child shares written data pages with its parent until one of them writes.
        const cp = pagesOf(child.pid);
        let cow: { va: number; pfn: number } | undefined;
        for (const v of cp) {
          for (let i = 0; i < v.use.length && !cow; i++) {
            if (v.use[i] === PageUse.Cow && v.mapcount[i] >= 2) cow = { va: v.vma.start + i * 4096, pfn: v.pte[i] >>> 12 };
          }
        }
        expect(cow).toBeDefined();
        const holders = whoMaps(prog, cow!.pfn);
        // Shared read-only at the same address with another forker (the parent, or a sibling forked
        // before the parent wrote its own copy).
        const forkerPids = new Set(forkers.map((t) => t.pid));
        expect(holders.some((h) => h.pid === child.pid && h.va === cow!.va && !h.writable)).toBe(true);
        expect(holders.some((h) => h.pid !== child.pid && forkerPids.has(h.pid) && h.va === cow!.va && !h.writable)).toBe(true);
        // The binary's text is the same page cache pages in all three forkers.
        const text = cp.find((v) => v.vma.flagsStr.startsWith("r-x") && v.vma.file)!;
        expect(text.counts[PageUse.FileShared]).toBeGreaterThan(0);
        expect(Math.max(...text.mapcount)).toBeGreaterThanOrEqual(3);
        // The child has written its stack since fork(), so it has private anon pages there.
        const stack = cp.find((v) => v.vma.name === "[stack]")!;
        expect(stack.counts[PageUse.Anon]).toBeGreaterThan(0);

        // mapper: 16 touched anon pages; the PROT_NONE page of the second region.
        const mp = pagesOf(Number(hdr[1]));
        // Adjacent anonymous VMAs may have been merged, so look pages up by address.
        const useAt = (va: number) => {
          const v = mp.find((x) => x.vma.start <= va && va < x.vma.end)!;
          return { use: v.use[(va - v.vma.start) / 4096] as PageUse, flags: v.vma.flagsStr };
        };
        const anon = parseInt(hdr[2], 16);
        for (let i = 0; i < 16; i++) expect(useAt(anon + i * 4096).use).toBe(PageUse.Anon);
        const none = useAt(parseInt(hdr[3], 16) + 5 * 4096);
        expect(none).toEqual({ use: PageUse.ProtNone, flags: "---p" });

        // EEVDF: three spinners are runnable; the pick is an eligible on-rq task.
        const ev = eevdf(runqueue(prog).cfs);
        const spins = ev.tasks.filter((t) => t.comm === "spin");
        expect(spins.length).toBe(3);
        expect(ev.tasks.some((t) => t.eligible)).toBe(true);
        const pick = ev.tasks.find((t) => t.addr === ev.pick)!;
        expect(pick).toBeDefined();
        expect(pick.onRq).toBe(true);
        expect(pick.eligible || pick.isCurr).toBe(true);
        const vs = ev.tasks.filter((t) => t.onRq).map((t) => t.vruntime);
        const lo = vs.reduce((a, b) => (a < b ? a : b));
        const hi = vs.reduce((a, b) => (a > b ? a : b));
        expect(ev.avg >= lo && ev.avg <= hi).toBe(true);
      } finally {
        await m.destroy();
      }
    },
    180_000,
  );
});
