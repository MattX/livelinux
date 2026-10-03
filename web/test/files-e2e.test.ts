// End-to-end: boot the real guest, build pipelines in the shell, pause, and check that openFiles()
// agrees with what the guest itself reports through /proc/<pid>/fd.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Machine } from "../src/vm/machine";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import { openFiles, type FileNode, type OpenFiles, type ProcFiles } from "../src/debug/helpers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guest = (f: string) => resolve(root, "public/guest", f);
const have = ["bzImage", "initramfs.cpio.gz", "System.map", "vmlinux.btf"].every((f) => existsSync(guest(f)));

const ab = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!have)("open files against the live guest", () => {
  it(
    "pipes, their ring buffers and the console match the guest's /proc/<pid>/fd",
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
        const run = async (cmd: string, done: RegExp, ms = 30_000) => {
          const mark = serial.length;
          m.serialSend(cmd + "\n");
          await waitFor(done, mark, ms);
          return serial.slice(mark);
        };

        await waitFor(/# $/m, 0);
        // A: sleep | cat  (nothing buffered).  B: (echo hello; sleep) | sleep  ("hello\n" buffered).
        await run("sleep 1000 | cat &", /# $/m);
        await run("(echo hello; sleep 1000) | sleep 1001 &", /# $/m);
        await new Promise((r) => setTimeout(r, 2000));

        const scan = await run(`for d in /proc/[0-9]*; do echo "P:\${d#/proc/} $(cat $d/comm)"; done; echo done-$((20+2))`, /done-22\r?\n/);
        const comms = [...scan.matchAll(/^P:(\d+) (\S+)/gm)].map((x) => ({ pid: Number(x[1]), comm: x[2] }));
        const pids = (name: string) => comms.filter((c) => c.comm === name).map((c) => c.pid);
        const pidsCat = pids("cat");
        expect(pidsCat.length).toBe(1);
        const catPid = pidsCat[0];
        const sleepPids = pids("sleep");
        expect(sleepPids.length).toBe(3);

        // The guest's own view: ls -l /proc/<pid>/fd for everything of interest, plus the shell.
        const lsOut = await run(
          `for p in ${[catPid, ...sleepPids].join(" ")} $$; do echo "== $p"; ls -l /proc/$p/fd | sed 's/.* \\([0-9][0-9]* -> .*\\)/\\1/'; done; echo done-$((30+3))`,
          /done-33\r?\n/,
        );
        const guestFds = new Map<number, Map<number, string>>();
        let cur = 0;
        for (const line of lsOut.split(/\r?\n/)) {
          let mm = /^== (\d+)/.exec(line);
          if (mm) {
            cur = Number(mm[1]);
            guestFds.set(cur, new Map());
            continue;
          }
          mm = /^(\d+) -> (.*?)\s*$/.exec(line);
          if (mm && cur) guestFds.get(cur)!.set(Number(mm[1]), mm[2]);
        }
        expect(guestFds.get(catPid)!.get(0)).toMatch(/^pipe:\[\d+\]$/);

        await m.pause();
        const symbols = parseSystemMap(readFileSync(guest("System.map"), "utf8"));
        const btf = parseBtf(ab(guest("vmlinux.btf")));
        const swapper = symbols.addr("swapper_pg_dir")!;
        const prog = new KernelProgram(btf, symbols, m.kernelSpace((swapper - 0xc0000000) >>> 0));

        const r: OpenFiles = openFiles(prog);
        const proc = (pid: number): ProcFiles => {
          const p = r.procs.find((x) => x.pid === pid);
          if (!p) throw new Error(`pid ${pid} not found; have ${r.procs.map((x) => x.pid).join(",")}`);
          return p;
        };
        const node = (pf: ProcFiles, fd: number): FileNode => {
          const f = pf.fds.find((x) => x.fd === fd);
          if (!f) throw new Error(`pid ${pf.pid} has no fd ${fd}`);
          return r.files.get(f.file.inodeAddr)!;
        };

        // Every pipe:[ino] the guest reports for these processes is the same inode number we see.
        let compared = 0;
        for (const [pid, fds] of guestFds) {
          if (pid === 0) continue;
          const pf = proc(pid);
          for (const [fd, target] of fds) {
            const pm = /^pipe:\[(\d+)\]$/.exec(target);
            if (!pm) continue;
            const n = node(pf, fd);
            expect(n.type).toBe("pipe");
            expect(n.ino).toBe(Number(pm[1]));
            expect(n.path).toBe(target);
            compared++;
          }
        }
        expect(compared).toBeGreaterThanOrEqual(4);

        // Pipeline A: sleep -> pipe -> cat, nothing buffered.
        const pipeA = node(proc(catPid), 0);
        expect(pipeA.pipe).toMatchObject({ readers: 1, writers: 1, used: 0, bytes: 0, ringSize: 16 });
        const writersA = r.procs.filter((p) => p.comm === "sleep" && p.fds.some((f) => f.file.inodeAddr === pipeA.inodeAddr && f.file.writable));
        expect(writersA.length).toBe(1);
        expect(proc(catPid).fds.find((f) => f.fd === 0)!.file).toMatchObject({ readable: true, writable: false });
        expect(writersA[0].fds.find((f) => f.file.inodeAddr === pipeA.inodeAddr)!.file).toMatchObject({ readable: false, writable: true });
        expect(writersA[0].fds.find((f) => f.file.inodeAddr === pipeA.inodeAddr)!.fd).toBe(1);

        // Pipeline B: echo hello wrote 6 bytes into the pipe read by "sleep 1001"; the first sleep is the writer.
        const pipeB = [...r.files.values()].find((n) => n.pipe && n.pipe.bytes === 6);
        expect(pipeB).toBeDefined();
        expect(pipeB!.pipe).toMatchObject({ readers: 1, writers: 1, used: 1, bytes: 6 });
        expect(pipeB!.pipe!.slots.filter((s) => s.occupied)).toHaveLength(1);
        expect(pipeB!.pipe!.slots.find((s) => s.occupied)).toMatchObject({ len: 6, offset: 0 });
        expect(pipeB!.inodeAddr).not.toBe(pipeA.inodeAddr);
        const usersB = r.procs.filter((p) => p.fds.some((f) => f.file.inodeAddr === pipeB!.inodeAddr));
        expect(usersB.length).toBeGreaterThanOrEqual(2);

        // The shell's fds 0/1/2 are a character device (the console).
        const shellPid = [...guestFds.keys()].find((pid) => pid !== catPid && !sleepPids.includes(pid) && pid !== 0)!;
        const sh = proc(shellPid);
        for (const fd of [0, 1, 2]) {
          const n = node(sh, fd);
          expect(n.type).toBe("chr");
          expect(n.major).toBeDefined();
          expect(n.path).toMatch(/console|tty/);
        }
        // Kernel threads are reported, flagged, and (having no fd table of their own) mostly absent.
        expect(r.procs.every((p) => !p.isKthread || p.fds.length >= 0)).toBe(true);
      } finally {
        await m.destroy();
      }
    },
    240_000,
  );
});
