// End-to-end for live sampling: boot the real guest and, WITHOUT pausing it, check the per-slice
// CPU trace and the physical memory map against what the guest reports (/proc/meminfo, mapper).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import { LiveSampler } from "../src/live/sampler";
import { PageKind, PhysMapper } from "../src/live/physmap";
import { describePage } from "../src/live/pageinfo";
import { CPU_HALTED, CPU_IRQ, CPU_USER } from "../src/live/cputrace";
import { forEachTask, runqueue, taskInfo } from "../src/debug/helpers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = ["bzImage", "initramfs.cpio.gz", "System.map", "vmlinux.btf"].every((f) => existsSync(guest(f)));

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!have)("live sampling against the running guest", () => {
  it(
    "CPU trace and physical memory map track the guest while it runs",
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

        const symbols = parseSystemMap(readFileSync(guest("System.map"), "utf8"));
        const btf = parseBtf(ab(guest("vmlinux.btf")));
        const swapper = symbols.addr("swapper_pg_dir")!;
        const space = m.kernelSpace((swapper - 0xc0000000) >>> 0);
        const prog = new KernelProgram(btf, symbols, space);
        const live = new LiveSampler(m, prog, space);
        expect(live.cpuError).toBeNull();
        expect(live.ramError).toBeNull();

        let mark = serial.length;
        m.serialSend("/demo/spin 600 & /demo/mapper &\n");
        const hdr = await waitFor(/mapper: pid (\d+) anon=0x([0-9a-f]+)/, mark);
        const mapperPid = Number(hdr[1]);
        const anonVa = parseInt(hdr[2], 16);
        await waitFor(/\[stack\][^\n]*\n/, mark);

        // --- CPU trace while running
        const offCpu = live.subscribeCpu();
        await sleep(1500);
        offCpu();
        const tr = live.cpu;
        expect(tr.count).toBeGreaterThan(100);
        const names = new Map<string, number>();
        for (let k = 0; k < tr.count; k++) {
          const i = tr.index(k);
          expect(tr.tEnd[i]).toBeGreaterThanOrEqual(tr.tStart[i]);
          const t = tr.tasks.get(tr.task[i]);
          if (t && !(tr.flags[i] & CPU_HALTED)) names.set(t.comm, (names.get(t.comm) ?? 0) + (tr.tEnd[i] - tr.tStart[i]));
        }
        // Slices ending on an interrupt entry stub are attributed to the interrupted context.
        const irqLo = symbols.addr("__irqentry_text_start")!;
        const irqHi = symbols.addr("__irqentry_text_end")!;
        let irq = 0;
        let irqUser = 0;
        for (let k = 0; k < tr.count; k++) {
          const i = tr.index(k);
          if (!(tr.flags[i] & CPU_IRQ)) continue;
          irq++;
          if (tr.flags[i] & CPU_USER) irqUser++;
          expect(tr.eip[i] >= irqLo && tr.eip[i] < irqHi).toBe(false);
        }
        expect(irq).toBeGreaterThan(0);
        expect(irqUser).toBeGreaterThan(0); // spin gets interrupted in user mode
        // spin is a busy loop: it should dominate non-idle CPU time.
        const top = [...names.entries()].sort((a, b) => b[1] - a[1])[0];
        expect(top[0]).toBe("spin");

        // --- physical memory: snapshot while running, compare to /proc/meminfo taken right after
        const mapper = new PhysMapper(m, prog);
        const snap = mapper.collect(false);
        mark = serial.length;
        m.serialSend("cat /proc/meminfo\n");
        await waitFor(/VmallocTotal[^\n]*\n/, mark);
        const meminfo = new Map<string, number>();
        for (const l of serial.slice(mark).split(/\r?\n/)) {
          const mm = l.match(/^(\w+(?:\(\w+\))?):\s+(\d+) kB/);
          if (mm) meminfo.set(mm[1], Number(mm[2]));
        }
        const kb = (k: PageKind) => snap.counts[k] * 4;
        const near = (ours: number, theirs: number, tol: number) => {
          expect(Math.abs(ours - theirs), `ours ${ours} kB vs guest ${theirs} kB`).toBeLessThanOrEqual(Math.max(tol, theirs * 0.1));
        };
        expect(snap.nPages).toBe(prog.var("max_mapnr").num());
        near(kb(PageKind.Free), meminfo.get("MemFree")!, 1024);
        near(kb(PageKind.Slab), meminfo.get("Slab")!, 256);
        near(kb(PageKind.Anon), meminfo.get("AnonPages")!, 256);
        near(kb(PageKind.File), meminfo.get("Cached")!, 1024);
        near(kb(PageKind.KernelStack), meminfo.get("KernelStack")!, 64);
        expect(snap.counts[PageKind.KernelText]).toBeGreaterThan(100);

        // mapper's memset 0xAA anon region: anonymous, owned by mapper at that address.
        const mapperOwned = [...snap.owners].filter(([, os]) => os.some((o) => o.pid === mapperPid && o.what === "user"));
        const anonPfn = mapperOwned.find(([, os]) => os.some((o) => o.pid === mapperPid && o.va === anonVa))?.[0];
        expect(anonPfn).toBeDefined();
        expect(snap.kind[anonPfn!]).toBe(PageKind.Anon);
        expect(describePage(prog, mapper, snap, anonPfn!).owners.join()).toContain(`mapper (pid ${mapperPid})`);
        // its busybox mapping is page cache with a file name
        const fileDescs = mapperOwned
          .filter(([pfn]) => snap.kind[pfn] === PageKind.File)
          .map(([pfn]) => describePage(prog, mapper, snap, pfn).what ?? "");
        expect(fileDescs.some((w) => w.startsWith("/bin/busybox"))).toBe(true);
        // a slab page names its cache
        const slabPfn = snap.kind.findIndex((k) => k === PageKind.Slab);
        expect(describePage(prog, mapper, snap, slabPfn).what).toMatch(/^slab cache: \S+/);

        // --- periodic snapshots via the sampler while running
        let n = 0;
        const offRam = live.subscribeRam(() => n++);
        await sleep(1500);
        offRam();
        expect(n).toBeGreaterThanOrEqual(5);
        expect(live.ram!.counts[PageKind.Free]).toBeGreaterThan(0);

        // --- inspector ticks: kernel helpers walked inside the slice hook while running
        live.tickIntervalMs = 200;
        const ticks: { comms: string[]; rqCurr: number; torn: boolean }[] = [];
        const tickErrors: unknown[] = [];
        const offTick = live.subscribeTick((torn) => {
          try {
            const comms = [...forEachTask(prog)].map((t) => taskInfo(t).comm);
            ticks.push({ comms, rqCurr: runqueue(prog).currAddr, torn });
          } catch (e) {
            tickErrors.push(e);
          }
        });
        await sleep(1500);
        offTick();
        expect(tickErrors).toEqual([]);
        expect(ticks.length).toBeGreaterThanOrEqual(4);
        expect(ticks.some((t) => !t.torn)).toBe(true); // spin / idle give plenty of quiet boundaries
        for (const t of ticks) {
          expect(t.comms).toContain("spin");
          expect(t.comms).toContain("mapper");
          expect(t.rqCurr).not.toBe(0);
        }

        // the guest is still alive and responsive
        mark = serial.length;
        m.serialSend("echo still-alive\n");
        await waitFor(/still-alive\r?\n/, mark, 30_000);
      } finally {
        await m.destroy();
      }
    },
    240_000,
  );
});
