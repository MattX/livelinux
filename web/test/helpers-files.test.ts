import { describe, expect, it } from "vitest";
import { openFiles, pipeInfo, S_IFCHR, S_IFIFO, S_IFREG } from "../src/debug/helpers";
import { allocObj, buildKernel, linkList, type Kernel } from "./util/helperFakes";

const T = "struct task_struct";

/** Append members to an existing fake struct (no instances exist yet, so growing it is safe). */
function addMembers(k: Kernel, name: string, fields: Array<[string, string]>): void {
  const t = k.btf.find(name)!;
  let off = t.size!;
  for (const [n, spec] of fields) {
    const ty = k.btf.spec(spec);
    const sz = k.btf.sizeOf(ty);
    const al = Math.min(4, sz);
    off = Math.ceil(off / al) * al;
    t.members!.push({ name: n, type: ty, bitOffset: off * 8, bitSize: 0 });
    off += sz;
  }
  t.size = Math.ceil(off / 8) * 8;
}

function build(): Kernel {
  const k = buildKernel();
  const b = k.btf;
  const S = (n: string, f: Array<[string, string]>) => b.struct(n, f);
  // task_struct.files, file / inode extras, super_block.s_type
  S("file_system_type", [["name", "ptr:char"]]);
  addMembers(k, "struct super_block", [["s_type", "ptr:struct file_system_type"]]);
  S("wait_queue_head", [["lock", "u32"], ["head", "struct list_head"]]);
  S("pipe_buffer", [["page", "ptr:void"], ["offset", "u32"], ["len", "u32"], ["ops", "ptr:void"], ["flags", "u32"], ["private", "u32"]]);
  S("pipe_inode_info", [["mutex", "u32[8]"], ["rd_wait", "struct wait_queue_head"], ["wr_wait", "struct wait_queue_head"],
    ["head", "u32"], ["tail", "u32"], ["max_usage", "u32"], ["ring_size", "u32"], ["readers", "u32"], ["writers", "u32"],
    ["bufs", "ptr:struct pipe_buffer"]]);
  addMembers(k, "struct inode", [["i_mode", "u16"], ["i_rdev", "u32"], ["i_size", "s64"], ["i_pipe", "ptr:struct pipe_inode_info"]]);
  addMembers(k, "struct file", [["f_flags", "u32"], ["f_mode", "u32"], ["f_pos", "s64"]]);
  S("fdtable", [["max_fds", "u32"], ["fd", "ptr:ptr:struct file"]]);
  S("files_struct", [["fdt", "ptr:struct fdtable"]]);
  addMembers(k, "struct task_struct", [["files", "ptr:struct files_struct"]]);
  return k;
}

interface Env {
  k: Kernel;
  init: number;
  rootDentry: number;
  mkDentry(parent: number, name: string): number;
  mkInode(mode: number, ino: number, extra?: { rdev?: number; size?: number; fstype?: string }): number;
  mkFile(inode: number, dentry: number, mode: number, pos?: number): number;
  mkFiles(fds: Record<number, number>, maxFds?: number): number;
  mkTask(pid: number, comm: string, files: number, flags?: number): number;
  mkPipe(o: { head: number; tail: number; ring?: number; readers: number; writers: number; lens?: Record<number, number>; rdWaiting?: boolean; wrWaiting?: boolean }): number;
}

function env(): Env {
  const k = build();
  const p = k.prog;
  const cstr = (s: string) => {
    const a = k.mem.alloc(s.length + 1);
    k.mem.writeBytes(a, [...s].map((c) => c.charCodeAt(0)));
    return a;
  };
  const fsTypes = new Map<string, number>();
  const sbFor = (fstype: string) => {
    let sb = fsTypes.get(fstype);
    if (!sb) {
      sb = allocObj(k, "struct super_block");
      const ft = allocObj(k, "struct file_system_type");
      p.set(ft, "struct file_system_type", "name", cstr(fstype));
      p.set(sb, "struct super_block", "s_type", ft);
      fsTypes.set(fstype, sb);
    }
    return sb;
  };
  const rootDentry = allocObj(k, "struct dentry");
  p.set(rootDentry, "struct dentry", "d_parent", rootDentry);
  const mkDentry = (parent: number, name: string) => {
    const d = allocObj(k, "struct dentry");
    p.set(d, "struct dentry", "d_parent", parent);
    p.set(d, "struct dentry", "d_iname", name);
    p.set(d, "struct dentry", "d_name.name", d + p.offsetOf("struct dentry", "d_iname"));
    return d;
  };
  const mkInode = (mode: number, ino: number, extra: { rdev?: number; size?: number; fstype?: string } = {}) => {
    const i = allocObj(k, "struct inode");
    p.set(i, "struct inode", "i_ino", ino);
    p.set(i, "struct inode", "i_mode", mode);
    p.set(i, "struct inode", "i_rdev", extra.rdev ?? 0);
    p.set(i, "struct inode", "i_size", extra.size ?? 0);
    p.set(i, "struct inode", "i_sb", sbFor(extra.fstype ?? "rootfs"));
    return i;
  };
  const mkFile = (inode: number, dentry: number, mode: number, pos = 0) => {
    const f = allocObj(k, "struct file");
    p.set(f, "struct file", "f_inode", inode);
    p.set(f, "struct file", "f_path.dentry", dentry);
    p.set(f, "struct file", "f_mode", mode);
    p.set(f, "struct file", "f_flags", 0o2);
    p.set(f, "struct file", "f_pos", pos);
    return f;
  };
  const mkFiles = (fds: Record<number, number>, maxFds = 64) => {
    const arr = k.mem.alloc(maxFds * 4);
    for (const [fd, f] of Object.entries(fds)) k.mem.writeUint(arr + Number(fd) * 4, 4, f);
    const fdt = allocObj(k, "struct fdtable");
    p.set(fdt, "struct fdtable", "max_fds", maxFds);
    p.set(fdt, "struct fdtable", "fd", arr);
    const fs = allocObj(k, "struct files_struct");
    p.set(fs, "struct files_struct", "fdt", fdt);
    return fs;
  };
  const init = p.defineVar("init_task", T);
  const tasks: number[] = [];
  const relink = () => linkList(k, init + p.offsetOf(T, "tasks"), tasks.map((t) => t + p.offsetOf(T, "tasks")));
  p.set(init, T, "comm", "swapper");
  p.set(init, T, "real_parent", init);
  const mkTask = (pid: number, comm: string, files: number, flags = 0) => {
    const t = allocObj(k, T);
    p.set(t, T, "pid", pid);
    p.set(t, T, "tgid", pid);
    p.set(t, T, "comm", comm);
    p.set(t, T, "flags", flags);
    p.set(t, T, "files", files);
    p.set(t, T, "real_parent", init);
    tasks.push(t);
    relink();
    return t;
  };
  const mkPipe = (o: { head: number; tail: number; ring?: number; readers: number; writers: number; lens?: Record<number, number>; rdWaiting?: boolean; wrWaiting?: boolean }) => {
    const ring = o.ring ?? 16;
    const pi = allocObj(k, "struct pipe_inode_info");
    const bufs = k.mem.alloc(ring * p.sizeOf("struct pipe_buffer"));
    const PI = "struct pipe_inode_info";
    p.set(pi, PI, "head", o.head);
    p.set(pi, PI, "tail", o.tail);
    p.set(pi, PI, "ring_size", ring);
    p.set(pi, PI, "max_usage", ring);
    p.set(pi, PI, "readers", o.readers);
    p.set(pi, PI, "writers", o.writers);
    p.set(pi, PI, "bufs", bufs);
    for (const wq of ["rd_wait", "wr_wait"]) {
      const h = pi + p.offsetOf(PI, `${wq}.head`);
      linkList(k, h, wq === "rd_wait" ? (o.rdWaiting ? [k.mem.alloc(8)] : []) : o.wrWaiting ? [k.mem.alloc(8)] : []);
    }
    for (const [slot, len] of Object.entries(o.lens ?? {})) {
      const b = bufs + Number(slot) * p.sizeOf("struct pipe_buffer");
      p.set(b, "struct pipe_buffer", "len", len);
      p.set(b, "struct pipe_buffer", "offset", 0);
    }
    return pi;
  };
  return { k, init, rootDentry, mkDentry, mkInode, mkFile, mkFiles, mkTask, mkPipe };
}

describe("openFiles", () => {
  it("decodes a shell pipeline: yes | cat > /dev/null, with the console and devtmpfs", () => {
    const e = env();
    const { k } = e;
    const dev = e.mkDentry(e.rootDentry, "dev"); // devtmpfs root: parent is self, names relative to mount
    void dev;
    const devRoot = e.rootDentry; // devtmpfs mount root dentry (own sb)
    const console_ = e.mkDentry(devRoot, "console");
    const nullD = e.mkDentry(devRoot, "null");
    const consoleIno = e.mkInode(S_IFCHR | 0o600, 7, { rdev: (5 << 20) | 1, fstype: "devtmpfs" });
    const nullIno = e.mkInode(S_IFCHR | 0o666, 8, { rdev: (1 << 20) | 3, fstype: "devtmpfs" });
    // pipe: 2 occupied slots (tail=14, head=18 wraps over a 16-slot ring => slots 14,15,0,1)
    const pipeIno = e.mkInode(S_IFIFO | 0o600, 1234, { fstype: "pipefs" });
    const pi = e.mkPipe({ head: 18, tail: 14, readers: 1, writers: 1, lens: { 14: 4096, 15: 100, 0: 4096, 1: 1 }, wrWaiting: true });
    k.prog.set(pipeIno, "struct inode", "i_pipe", pi);
    const pipeDentry = e.mkDentry(e.mkDentry(e.rootDentry, "x"), ""); // pseudo: empty name
    k.prog.set(pipeDentry, "struct dentry", "d_parent", pipeDentry);

    const con = (m: number) => e.mkFile(consoleIno, console_, m);
    const wr = e.mkFile(pipeIno, pipeDentry, 0x2);
    const rd = e.mkFile(pipeIno, pipeDentry, 0x1);
    const nul = e.mkFile(nullIno, nullD, 0x2, 77);
    e.mkTask(10, "yes", e.mkFiles({ 0: con(3), 1: wr, 2: con(3) }));
    const catFiles = e.mkFiles({ 0: rd, 1: nul, 2: con(3) });
    e.mkTask(11, "cat", catFiles);
    e.mkTask(12, "cat-thread-group-sibling", catFiles); // CLONE_FILES sharer, deduped
    e.mkTask(2, "kthreadd", 0, 0x00200000); // files == NULL: skipped

    const r = openFiles(k.prog);
    expect(r.procs.map((p) => [p.pid, p.comm])).toEqual([[10, "yes"], [11, "cat"]]);
    expect(r.procs[1].sharers).toEqual([12]);
    const yes = r.procs[0];
    expect(yes.fds.map((f) => f.fd)).toEqual([0, 1, 2]);
    expect(yes.ppid).toBe(0);
    expect(yes.fds[1].file).toMatchObject({ writable: true, readable: false, inodeAddr: pipeIno });
    expect(yes.fds[0].file).toMatchObject({ writable: true, readable: true, inodeAddr: consoleIno });

    const cat = r.procs[1];
    expect(cat.fds[0].file).toMatchObject({ readable: true, writable: false, inodeAddr: pipeIno });
    expect(cat.fds[1].file).toMatchObject({ pos: 77, inodeAddr: nullIno });

    expect(r.files.size).toBe(3);
    const pn = r.files.get(pipeIno)!;
    expect(pn).toMatchObject({ type: "pipe", ino: 1234, path: "pipe:[1234]" });
    expect(pn.pipe).toMatchObject({ head: 18, tail: 14, ringSize: 16, readers: 1, writers: 1, used: 4, bytes: 4096 + 100 + 4096 + 1, headSlot: 2, tailSlot: 14, writerBlocked: true, readerWaiting: false });
    expect(pn.pipe!.slots.filter((s) => s.occupied).map((s) => [s.slot, s.len])).toEqual([[0, 4096], [1, 1], [14, 4096], [15, 100]]);
    const cn = r.files.get(consoleIno)!;
    expect(cn).toMatchObject({ type: "chr", path: "/dev/console", major: 5, minor: 1, fstype: "devtmpfs" });
    expect(r.files.get(nullIno)).toMatchObject({ type: "chr", path: "/dev/null", major: 1, minor: 3 });
  });

  it("regular files, sizes, directories, reader waiting, 32-bit index wraparound", () => {
    const e = env();
    const { k } = e;
    const d = e.mkDentry(e.mkDentry(e.rootDentry, "etc"), "passwd");
    const reg = e.mkInode(S_IFREG | 0o644, 99, { size: 1234 });
    const dirIno = e.mkInode(0o040755, 2);
    const root = e.mkFile(dirIno, e.rootDentry, 1);
    const f = e.mkFile(reg, d, 1, 12);
    // head wrapped past 2^32: head=1, tail=0xfffffffe => 3 used (slots 14, 15, 0)
    const pipeIno = e.mkInode(S_IFIFO | 0o600, 5, { fstype: "pipefs" });
    const pd = e.mkDentry(e.rootDentry, "");
    k.prog.set(pd, "struct dentry", "d_parent", pd);
    const pi = e.mkPipe({ head: 1, tail: 0xfffffffe, readers: 1, writers: 0, lens: { 14: 5, 15: 6, 0: 7 }, rdWaiting: true });
    k.prog.set(pipeIno, "struct inode", "i_pipe", pi);
    const pf = e.mkFile(pipeIno, pd, 1);
    e.mkTask(5, "reader", e.mkFiles({ 3: f, 4: root, 9: pf }));
    const r = openFiles(k.prog);
    expect(r.procs[0].fds.map((x) => x.fd)).toEqual([3, 4, 9]);
    expect(r.files.get(reg)).toMatchObject({ type: "reg", path: "/etc/passwd", size: 1234, ino: 99 });
    expect(r.files.get(dirIno)).toMatchObject({ type: "dir", path: "/" });
    const pipe = r.files.get(pipeIno)!.pipe!;
    expect(pipe).toMatchObject({ used: 3, bytes: 18, readerWaiting: true, writerBlocked: false, writers: 0 });
    expect(pipe.slots.filter((s) => s.occupied).map((s) => s.slot)).toEqual([0, 14, 15]);
    expect(pipeInfo(k.prog, pipe.addr).used).toBe(3);
  });

  it("caps the number of fds examined and tolerates unreadable files", () => {
    const e = env();
    const reg = e.mkInode(S_IFREG, 1);
    const d = e.mkDentry(e.rootDentry, "f");
    const good = e.mkFile(reg, d, 1);
    // slot 1 holds a wild pointer -> that fd is dropped, the rest survive
    e.mkTask(7, "t", e.mkFiles({ 0: good, 1: 0xdead0000, 100: good }, 128));
    const r = openFiles(e.k.prog, { maxFds: 64 });
    expect(r.procs[0].fds.map((x) => x.fd)).toEqual([0]);
    expect(openFiles(e.k.prog).procs[0].fds.map((x) => x.fd)).toEqual([0, 100]);
  });
});
