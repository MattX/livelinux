// End-to-end for the /demo programs that feed the fd, slab, buddy, COW and OOM views: run each one
// in the real guest and check that it does what it says, cross-checking against kernel state read
// through the debug layer where one exists.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import { findTask, mmPgdPhys } from "../src/debug/helpers";
import type { Program, Value } from "../src/debug/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = ["bzImage", "initramfs.cpio.gz", "System.map", "vmlinux.btf"].every((f) => existsSync(guest(f)));

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** Inode number of the file open at `fd` in `task`, or null if the fd is not open. */
function fdIno(task: Value, fd: number): number | null {
  const fdt = task.member("files").deref().member("fdt").deref();
  if (fd >= fdt.member("max_fds").num()) return null;
  const file = fdt.member("fd").index(fd);
  if (file.isNull()) return null;
  return file.deref().member("f_inode").deref().member("i_ino").num();
}

/** /proc/buddyinfo "Node 0, zone Normal  a b c ..." -> free block counts per order, summed over zones. */
function buddyOrders(lines: string[]): number[] {
  const sum: number[] = [];
  for (const l of lines) {
    const counts = l.replace(/^.*zone\s+\S+/, "").trim().split(/\s+/).map(Number);
    counts.forEach((c, i) => (sum[i] = (sum[i] ?? 0) + c));
  }
  return sum;
}

describe.skipIf(!have)("demo programs against the live guest", () => {
  it(
    "pipepair, cowtouch, fragmenter, slabchurn and oomer behave as described",
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
              if (Date.now() > deadline) return rej(new Error(`timeout waiting for ${re}; serial:\n${serial.slice(-3000)}`));
              setTimeout(tick, 50);
            };
            tick();
          });
        const run = async (cmd: string, done: RegExp, ms?: number) => {
          const mark = serial.length;
          m.serialSend(cmd + "\n");
          await waitFor(done, mark, ms);
          return serial.slice(mark);
        };
        const linesOf = (out: string, re: RegExp) => out.split(/\r?\n/).filter((l) => re.test(l));

        await waitFor(/# $/m, 0);
        const symbols = parseSystemMap(readFileSync(guest("System.map"), "utf8"));
        const btf = parseBtf(ab(guest("vmlinux.btf")));
        const swapper = symbols.addr("swapper_pg_dir")!;
        const prog: Program = new KernelProgram(btf, symbols, m.kernelSpace((swapper - 0xc0000000) >>> 0));
        const task = (pid: number) => {
          const t = findTask(prog, pid);
          expect(t, `task ${pid}`).toBeDefined();
          return t!;
        };
        /** Physical frame behind `va` in `pid`'s address space. */
        const frame = (pid: number, va: number) => {
          const t = m.addressSpace(mmPgdPhys(task(pid).member("mm").deref())).translate(va);
          expect(t, `pid ${pid} va ${va.toString(16)}`).not.toBeNull();
          return t!.pa >>> 12;
        };
        const userBytes = (pid: number, va: number, len: number) =>
          m.addressSpace(mmPgdPhys(task(pid).member("mm").deref())).read(va, len);

        // --- pipepair: the fds each side reports match the kernel's fd tables
        {
          const out = await run("/demo/pipepair 200 &", /pipepair: pong 0000000001/);
          const fds = new Map<string, number>(); // "child:0" -> pipe inode
          const pids: Record<string, number> = {};
          for (const [, who, pid, fd, ino] of out.matchAll(/pipepair: (child|parent) +pid (\d+) fd (\d+) -> pipe:\[(\d+)\]/g)) {
            fds.set(`${who}:${fd}`, Number(ino));
            pids[who] = Number(pid);
          }
          const ping = fds.get("child:0")!;
          const pong = fds.get("child:1")!;
          expect(ping).toBeDefined();
          expect(pong).toBeDefined();
          expect(ping).not.toBe(pong);
          // parent holds exactly one end of each pipe
          expect([...fds].filter(([k, v]) => k.startsWith("parent:") && v === ping).length).toBe(1);
          expect([...fds].filter(([k, v]) => k.startsWith("parent:") && v === pong).length).toBe(1);

          await m.pause();
          for (const [k, ino] of fds) {
            const [who, fd] = k.split(":");
            expect(fdIno(task(pids[who]), Number(fd)), k).toBe(ino);
          }
          await m.resume();
          await run("kill %1; wait", /# $/m);
        }

        // --- cowtouch: frames are shared until written; the child's writes copy, the parent's reuse
        {
          const out = await run("/demo/cowtouch 8 300 &", /child +pid \d+ wrote page 3 /);
          const [, parent, child, lo] = out.match(/cowtouch: parent pid (\d+), child pid (\d+), 8 pages at 0x([0-9a-f]+)/)!;
          const ppid = Number(parent);
          const cpid = Number(child);
          const base = parseInt(lo, 16);
          const va = (i: number) => base + i * 4096;
          const header = (pid: number, i: number) =>
            new TextDecoder().decode(userBytes(pid, va(i), 64)).replace(/\0.*$/s, "");

          await m.pause();
          const orig: number[] = [];
          let copied = 0;
          for (let i = 0; i < 8; i++) {
            orig.push(frame(ppid, va(i)));
            const byChild = header(cpid, i).includes("written by child");
            if (byChild) copied++;
            // a page the child has written lives in its own frame; any other is still shared
            expect(frame(cpid, va(i)) !== orig[i], `page ${i}`).toBe(byChild);
            expect(header(ppid, i)).toContain(`cowtouch page ${i} written by parent pid ${ppid}`);
          }
          expect(copied).toBeGreaterThanOrEqual(4);
          expect(copied).toBeLessThan(8);
          await m.resume();

          await waitFor(/cowtouch: done/, 0, 60_000);
          await m.pause();
          for (let i = 0; i < 8; i++) {
            expect(frame(ppid, va(i)), `parent page ${i} reused in place`).toBe(orig[i]);
            expect(frame(cpid, va(i))).not.toBe(orig[i]);
            expect(header(cpid, i)).toContain(`written by child pid ${cpid}`);
          }
          await m.resume();
          await run("kill %1; wait", /# $/m);
        }

        // --- fragmenter: punching every other page leaves many order-0 blocks that merge back later
        {
          const out = await run("/demo/fragmenter 8 1 1", /fragmenter: released[\s\S]*# $/m);
          const steps = out.split(/fragmenter: (?=grabbed|punched|released)/);
          const at = (step: string) => buddyOrders(linesOf(steps.find((s) => s.startsWith(step))!, /zone/));
          const grabbed = at("grabbed");
          const punched = at("punched");
          const released = at("released");
          // 8 MB / 2 = 1024 single pages freed; most land on the buddy lists unmerged
          expect(punched[0] - grabbed[0]).toBeGreaterThan(256);
          expect(released[0]).toBeLessThan(punched[0]);
        }

        // --- slabchurn: one full round; filp objects (if not merged) track the open fds
        {
          const out = await run("/demo/slabchurn 500 1 1", /slabchurn: unlinked all[\s\S]*# $/m);
          for (const step of ["opened all", "closed every other fd", "closed all", "unlinked all"])
            expect(out).toContain(`slabchurn: ${step}`);
          const filp = [...out.matchAll(/slabchurn: +filp +(\d+)\//g)].map((x) => Number(x[1]));
          if (filp.length === 5) {
            const [start, opened, , closed] = filp;
            expect(opened - start).toBeGreaterThanOrEqual(450);
            expect(closed).toBeLessThan(opened - 250);
          }
        }

        // --- oomer: the OOM killer takes bait (oom_score_adj 1000) first, then the hog
        {
          const out = await run("/demo/oomer 4 20", /oomer: done/, 300_000);
          const kills = [...out.matchAll(/oomer: (\w+) \(pid \d+\) killed by signal 9/g)].map((x) => x[1]);
          expect(kills).toEqual(["bait", "hog"]);
          const hogPeak = Number(out.match(/oomer: hog \(pid \d+\) killed by signal 9 \(Killed\); peak (\d+) MB/)![1]);
          expect(hogPeak).toBeGreaterThan(100);
          expect(out).toMatch(/Out of memory: Killed process \d+ \(oomer\)/);
          await run("echo still-alive", /still-alive\r?\n/, 60_000);
        }
      } finally {
        await m.destroy();
      }
    },
    600_000,
  );
});
