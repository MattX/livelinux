// Open-file helpers (drgn.helpers.linux.fs style) for Linux 6.12 i386: which process has which
// file open, with pipes decoded down to their ring buffer. Everything is read by member name via
// BTF; optional fields are tolerated so a slightly different kernel degrades instead of failing.

import type { Program, Value } from "../api";
import { forEachTask, taskInfo } from "./tasks";
import { dentryPath } from "./mm";
import { tryGet, type WalkOpts } from "./util";

export const FMODE_READ = 0x1;
export const FMODE_WRITE = 0x2;

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

/** Max fd table entries examined per files_struct. */
export const MAX_FDS = 1024;

export type FileType = "pipe" | "chr" | "blk" | "reg" | "dir" | "lnk" | "sock" | "other";

export function fileTypeOf(imode: number): FileType {
  switch (imode & S_IFMT) {
    case S_IFIFO: return "pipe";
    case S_IFCHR: return "chr";
    case S_IFBLK: return "blk";
    case S_IFREG: return "reg";
    case S_IFDIR: return "dir";
    case S_IFLNK: return "lnk";
    case S_IFSOCK: return "sock";
    default: return "other";
  }
}

export interface PipeSlot {
  /** Index into bufs[] (index & (ringSize - 1)). */
  slot: number;
  occupied: boolean;
  /** pipe_buffer.len / .offset (0 for free slots). */
  len: number;
  offset: number;
}

export interface PipeInfo {
  /** Address of the pipe_inode_info. */
  addr: number;
  head: number;
  tail: number;
  /** Number of slots in the ring (16 by default). */
  ringSize: number;
  maxUsage: number;
  readers: number;
  writers: number;
  /** Occupied slots, (head - tail) clamped to ringSize. */
  used: number;
  /** Bytes buffered: sum of len over occupied slots. */
  bytes: number;
  /** One entry per ring slot, in slot order. */
  slots: PipeSlot[];
  /** Slot at which the next write goes / the next read comes from (head & mask, tail & mask). */
  headSlot: number;
  tailSlot: number;
  /** rd_wait has waiters: some reader is blocked on an empty pipe. */
  readerWaiting: boolean;
  /** wr_wait has waiters: some writer is blocked on a full pipe. */
  writerBlocked: boolean;
}

export interface OpenFile {
  /** Address of the struct file. */
  addr: number;
  mode: number;
  flags: number;
  pos: number;
  readable: boolean;
  writable: boolean;
  /** Address of the inode (graph node identity). */
  inodeAddr: number;
}

/** What a file is, shared by every struct file (and process) that reaches the same inode. */
export interface FileNode {
  inodeAddr: number;
  ino: number;
  /** i_mode */
  imode: number;
  type: FileType;
  /** Best-effort path; "pipe:[ino]" / "socket:[ino]" for pseudo files. */
  path: string;
  /** Last path component. */
  base: string;
  /** Filesystem type name of the inode's superblock, if readable ("devtmpfs", "rootfs", ...). */
  fstype?: string;
  /** Device numbers of a char/block special file. */
  major?: number;
  minor?: number;
  size: number;
  pipe?: PipeInfo;
}

export interface FdEntry {
  fd: number;
  file: OpenFile;
}

export interface ProcFiles {
  pid: number;
  tgid: number;
  comm: string;
  ppid: number;
  isKthread: boolean;
  taskAddr: number;
  /** files_struct address (shared via CLONE_FILES). */
  filesAddr: number;
  /** Other thread-group leaders sharing the same files_struct (deduped away). */
  sharers: number[];
  fds: FdEntry[];
}

export interface OpenFiles {
  /** Per-process open files, in task-list order (one per distinct files_struct). */
  procs: ProcFiles[];
  /** All distinct inodes reached, keyed by inode address. */
  files: Map<number, FileNode>;
}

function wqNonEmpty(pipe: Value, member: string): boolean {
  return tryGet(() => {
    const head = pipe.member(`${member}.head`);
    return head.member("next").ptr() !== head.addr;
  }) ?? false;
}

/** Decode a `struct pipe_inode_info` (or pointer to one). */
export function pipeInfo(prog: Program, pipePtr: number): PipeInfo {
  const p = prog.value(pipePtr, "struct pipe_inode_info");
  const headV = p.member("head");
  const idxMask = headV.sizeOf() >= 4 ? 0xffffffff : (1 << (headV.sizeOf() * 8)) - 1;
  const head = headV.num() & idxMask;
  const tail = p.member("tail").num() & idxMask;
  const maxUsage = tryGet(() => p.member("max_usage").num()) ?? 0;
  const ringSize = tryGet(() => p.member("ring_size").num()) || maxUsage || 16;
  const used = Math.min(((head - tail) & idxMask) >>> 0, ringSize);
  const bufsPtr = tryGet(() => p.member("bufs").ptr()) ?? 0;
  const mask = ringSize - 1;
  const slots: PipeSlot[] = [];
  for (let s = 0; s < ringSize; s++) slots.push({ slot: s, occupied: false, len: 0, offset: 0 });
  let bytes = 0;
  if (bufsPtr !== 0) {
    const bufSize = prog.sizeOf("struct pipe_buffer");
    for (let k = 0; k < used; k++) {
      const slot = (tail + k) & mask;
      const b = tryGet(() => {
        const base = prog.value(bufsPtr + slot * bufSize, "struct pipe_buffer");
        return { len: base.member("len").num(), offset: base.member("offset").num() };
      });
      if (!b) continue;
      slots[slot] = { slot, occupied: true, len: b.len, offset: b.offset };
      bytes += b.len;
    }
  }
  return {
    addr: pipePtr,
    head,
    tail,
    ringSize,
    maxUsage,
    readers: tryGet(() => p.member("readers").num()) ?? 0,
    writers: tryGet(() => p.member("writers").num()) ?? 0,
    used,
    bytes,
    slots,
    headSlot: head & mask,
    tailSlot: tail & mask,
    readerWaiting: wqNonEmpty(p, "rd_wait"),
    writerBlocked: wqNonEmpty(p, "wr_wait"),
  };
}

const FS_MOUNT_PREFIX: Record<string, string> = {
  devtmpfs: "/dev",
  proc: "/proc",
  sysfs: "/sys",
  devpts: "/dev/pts",
};

function ownName(prog: Program, dentryPtr: number): string {
  return tryGet(() => {
    const d = prog.value(dentryPtr, "struct dentry");
    const n = tryGet(() => d.member("d_name.name").cstr(256));
    return n !== undefined && n !== "" ? n : (tryGet(() => d.member("d_iname").cstr(64)) ?? "");
  }) ?? "";
}

function readNode(prog: Program, inodeAddr: number, dentryPtr: number): FileNode {
  const inode = prog.value(inodeAddr, "struct inode");
  const ino = tryGet(() => inode.member("i_ino").num()) ?? 0;
  const imode = tryGet(() => inode.member("i_mode").num()) ?? 0;
  const type = fileTypeOf(imode);
  const size = tryGet(() => Number(inode.member("i_size").read())) ?? 0;
  const fstype = tryGet(() => {
    const sb = inode.member("i_sb").deref();
    return sb.member("s_type").deref().member("name").cstr(32);
  });
  let path = "";
  let base = "";
  if (dentryPtr !== 0) {
    const p = tryGet(() => dentryPath(prog, dentryPtr));
    if (p) {
      path = p.path;
      base = p.base;
    }
  }
  const pseudo = path === "" || path === "/";
  if (type === "pipe" && pseudo) {
    path = base = `pipe:[${ino}]`;
  } else if (type === "sock" && pseudo) {
    path = base = `socket:[${ino}]`;
  } else if (pseudo && type !== "dir") {
    // anon inodes (eventfd, epoll, ...): the name lives in the dentry itself
    const n = ownName(prog, dentryPtr);
    if (n && n !== "/") path = base = n;
  } else if (fstype && FS_MOUNT_PREFIX[fstype] && !path.startsWith(FS_MOUNT_PREFIX[fstype] + "/") && path !== FS_MOUNT_PREFIX[fstype]) {
    // dentryPath() does not cross mounts; put well-known pseudo filesystems at their usual place.
    path = FS_MOUNT_PREFIX[fstype] + (path === "/" ? "" : path);
  }
  const node: FileNode = { inodeAddr, ino, imode, type, path, base, fstype, size };
  if (type === "chr" || type === "blk") {
    const rdev = tryGet(() => inode.member("i_rdev").num());
    if (rdev !== undefined) {
      node.major = rdev >>> 20;
      node.minor = rdev & 0xfffff;
    }
  }
  if (type === "pipe") {
    const pp = tryGet(() => inode.member("i_pipe").ptr()) ?? 0;
    if (pp !== 0) node.pipe = tryGet(() => pipeInfo(prog, pp));
  }
  return node;
}

/** Read the fd table of a `struct files_struct`, yielding [fd, struct file *] for non-NULL slots. */
function fdTable(prog: Program, files: Value, cap: number): Array<[number, number]> {
  let fdt = tryGet(() => {
    const p = files.member("fdt");
    return p.isNull() ? undefined : p.deref();
  });
  fdt ??= tryGet(() => files.member("fdtab"));
  if (!fdt) return [];
  const max = Math.min(fdt.member("max_fds").num(), cap);
  const arr = fdt.member("fd").ptr();
  if (arr === 0 || max <= 0) return [];
  const out: Array<[number, number]> = [];
  const raw = tryGet(() => prog.mem.read(arr, max * 4));
  for (let i = 0; i < max; i++) {
    let f: number;
    if (raw) f = (raw[i * 4] | (raw[i * 4 + 1] << 8) | (raw[i * 4 + 2] << 16) | (raw[i * 4 + 3] << 24)) >>> 0;
    else f = tryGet(() => prog.readU32(arr + i * 4)) ?? 0;
    if (f !== 0) out.push([i, f]);
  }
  return out;
}

/**
 * Every thread-group leader's open files (struct files_struct deduped by address), with the
 * distinct inodes they reach. Per-file failures are skipped so one torn read cannot lose the rest.
 */
export function openFiles(prog: Program, opts: WalkOpts & { maxFds?: number } = {}): OpenFiles {
  const cap = opts.maxFds ?? MAX_FDS;
  const procs: ProcFiles[] = [];
  const files = new Map<number, FileNode>();
  const byFiles = new Map<number, ProcFiles>();
  const fileCache = new Map<number, OpenFile | null>();

  const loadFile = (fptr: number): OpenFile | null => {
    if (fileCache.has(fptr)) return fileCache.get(fptr)!;
    let res: OpenFile | null = null;
    const r = tryGet(() => {
      const f = prog.value(fptr, "struct file");
      const mode = f.member("f_mode").num();
      const flags = tryGet(() => f.member("f_flags").num()) ?? 0;
      const pos = tryGet(() => Number(f.member("f_pos").read())) ?? 0;
      const inodeAddr = f.member("f_inode").ptr();
      if (inodeAddr === 0) return null;
      if (!files.has(inodeAddr)) {
        const dentry = tryGet(() => f.member("f_path.dentry").ptr()) ?? 0;
        files.set(inodeAddr, readNode(prog, inodeAddr, dentry));
      }
      return {
        addr: fptr, mode, flags, pos, inodeAddr,
        readable: (mode & FMODE_READ) !== 0, writable: (mode & FMODE_WRITE) !== 0,
      } as OpenFile;
    });
    res = r ?? null;
    fileCache.set(fptr, res);
    return res;
  };

  for (const task of forEachTask(prog, opts)) {
    const filesPtr = tryGet(() => task.member("files").ptr()) ?? 0;
    if (filesPtr === 0) continue;
    const info = tryGet(() => taskInfo(task));
    if (!info) continue;
    const prev = byFiles.get(filesPtr);
    if (prev) {
      prev.sharers.push(info.pid);
      continue;
    }
    const fds: FdEntry[] = [];
    const table = tryGet(() => fdTable(prog, prog.value(filesPtr, "struct files_struct"), cap)) ?? [];
    for (const [fd, fptr] of table) {
      const file = loadFile(fptr);
      if (file) fds.push({ fd, file });
    }
    const pf: ProcFiles = {
      pid: info.pid, tgid: info.tgid, comm: info.comm, ppid: info.ppid, isKthread: info.isKthread,
      taskAddr: info.addr, filesAddr: filesPtr, sharers: [], fds,
    };
    byFiles.set(filesPtr, pf);
    procs.push(pf);
  }
  return { procs, files };
}
