// End-to-end: boot the real guest, start the demo programs, pause, and check the
// debug layer + helpers against what the guest itself reports over serial.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import { currentTask, findTask, forEachTask, mmPgdPhys, runqueue, taskInfo, vmas } from "../src/debug/helpers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = ["bzImage", "initramfs.cpio.gz", "System.map", "vmlinux.btf"].every((f) => existsSync(guest(f)));

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!have)("end-to-end against the live guest", () => {
  it(
    "tasks, VMAs, page tables and the CFS runqueue match the guest's view",
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
        let mark = serial.length;
        m.serialSend("/demo/forker 3 & /demo/spin 600 & /demo/mapper &\n");
        const hdr = await waitFor(/mapper: pid (\d+) anon=0x([0-9a-f]+)/, mark);
        const mapperPid = Number(hdr[1]);
        const anonAddr = parseInt(hdr[2], 16);
        // /proc/self/maps lines printed by mapper, ending with [stack] (or [vdso] on some kernels).
        await waitFor(/\[stack\][^\n]*\n/, mark);
        const guestMaps = serial
          .slice(mark)
          .split(/\r?\n/)
          .filter((l) => /^[0-9a-f]{8}-[0-9a-f]{8} /.test(l))
          .map((l) => l.split(/\s+/));
        expect(guestMaps.length).toBeGreaterThan(5);

        await new Promise((r) => setTimeout(r, 1000)); // let spin get going
        await m.pause();

        const symbols = parseSystemMap(readFileSync(guest("System.map"), "utf8"));
        const btf = parseBtf(ab(guest("vmlinux.btf")));
        const swapper = symbols.addr("swapper_pg_dir")!;
        const prog = new KernelProgram(btf, symbols, m.kernelSpace((swapper - 0xc0000000) >>> 0));

        expect(prog.var("linux_banner").cstr()).toMatch(/^Linux version 6\.12/);

        // --- tasks
        const tasks = [...forEachTask(prog)].map(taskInfo);
        const byComm = (c: string) => tasks.filter((t) => t.comm === c);
        expect(tasks[0].pid).toBe(0);
        expect(tasks.find((t) => t.pid === 1)).toBeDefined();
        expect(byComm("forker").length).toBe(4); // parent + 3 children
        expect(byComm("spin").length).toBe(1);
        expect(tasks.some((t) => t.isKthread && t.comm.startsWith("kworker"))).toBe(true);
        const forkerParent = byComm("forker").find((t) => byComm("forker").some((c) => c.ppid === t.pid))!;
        expect(byComm("forker").filter((t) => t.ppid === forkerParent.pid).length).toBe(3);
        const cur = taskInfo(currentTask(prog));
        expect(tasks.some((t) => t.addr === cur.addr)).toBe(true);

        // --- VMAs of mapper vs. its own /proc/self/maps
        const mapper = findTask(prog, mapperPid)!;
        expect(taskInfo(mapper).comm).toBe("mapper");
        const mm = mapper.member("mm").deref();
        const ours = vmas(prog, mm);
        const fmt = (n: number) => n.toString(16).padStart(8, "0");
        expect(ours.map((v) => `${fmt(v.start)}-${fmt(v.end)} ${v.flagsStr}`)).toEqual(
          guestMaps.map((f) => `${f[0]} ${f[1]}`),
        );
        for (const [i, f] of guestMaps.entries()) {
          const name = f.slice(5).join(" ").trim();
          if (name.startsWith("/")) expect(ours[i].file).toBe(name);
          else if (name) expect(ours[i].name).toBe(name);
        }

        // --- user page tables: the anon region mapper memset to 0xAA
        const uspace = m.addressSpace(mmPgdPhys(mm));
        const bytes = uspace.read(anonAddr, 16);
        expect([...bytes].every((b) => b === 0xaa)).toBe(true);
        const userRanges = uspace.walkRanges(0, 0xc0000000);
        expect(userRanges.some((r) => r.user && r.va <= anonAddr && anonAddr < r.va + r.size)).toBe(true);

        // --- scheduler: spin is runnable, so it's either curr or in the CFS tree
        const rq = runqueue(prog);
        const spin = byComm("spin")[0];
        expect(rq.cfs.tasks.some((t) => t.addr === spin.addr)).toBe(true);
        expect(rq.nrRunning).toBeGreaterThanOrEqual(1);
        expect(rq.cfs.tasks.every((t) => t.vruntime > 0n)).toBe(true);

        // --- resume/pause cycle keeps working
        await m.resume();
        mark = serial.length;
        m.serialSend("echo still-alive\n");
        await waitFor(/still-alive\r?\n/, mark, 30_000);
      } finally {
        await m.destroy();
      }
    },
    180_000,
  );
});
