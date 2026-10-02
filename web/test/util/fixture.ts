import { BtfBuilder } from "./btfBuilder";
import { FakeMemory } from "./fakeMem";
import { parseBtf } from "../../src/debug/btf";
import { parseSystemMap } from "../../src/debug/symbols";
import { KernelProgram } from "../../src/debug/program";

export const BASE = 0xc0000000;

/** Layout of the synthetic task_struct: see comments. */
export function buildFixture() {
  const b = new BtfBuilder();
  const int = b.int("int", 4, { signed: true });
  const uint = b.int("unsigned int", 4);
  const ulong = b.int("long unsigned int", 4);
  const char = b.int("char", 1, { signed: true, char: true });
  const uchar = b.int("unsigned char", 1, { char: true });
  const sshort = b.int("short int", 2, { signed: true });
  const ushort = b.int("short unsigned int", 2);
  const bool = b.int("_Bool", 1, { bool: true });
  const ull = b.int("long long unsigned int", 8);
  const sll = b.int("long long int", 8, { signed: true });
  const dbl = b.float("double", 8);
  const u64 = b.typedef("u64", ull);
  const s64 = b.typedef("s64", sll);
  const u32 = b.typedef("u32", uint);
  const kpid = b.typedef("__kernel_pid_t", int);
  const pid_t = b.typedef("pid_t", kpid);
  const cchar = b.const(char);
  const cpid = b.const(pid_t);

  // struct list_head { next*, prev* }
  const lhPtr = b.ptr(b.peekId + 1);
  const list_head = b.struct("list_head", 8, [
    { name: "next", type: lhPtr, offset: 0 },
    { name: "prev", type: lhPtr, offset: 4 },
  ]);

  const sched_entity = b.struct("sched_entity", 20, [
    { name: "vruntime", type: u64, offset: 0 },
    { name: "weight", type: ulong, offset: 8 },
    { name: "run_node", type: list_head, offset: 12 },
  ]);

  const task_state = b.enum("task_state", 4, [["TASK_RUNNING", 0], ["TASK_SLEEPING", 1], ["TASK_NEG", -1]], true);
  const big_enum = b.enum64("big_enum", 8, [["BIG_ONE", 1n], ["BIG_HUGE", 0x1_0000_0001n]]);
  const sbig_enum = b.enum64("sbig_enum", 8, [["SBIG_NEG", -5n]], true);
  const uenum = b.enum("uenum", 4, [["UE_MAX", 0xffffffff]]);

  // forward decl'd struct which has a full definition later
  const fwdInc = b.fwd("incomplete");
  const fwdNodef = b.fwd("nodef");
  const fwdU = b.fwd("fwdunion", true);

  const anonInner = b.struct("", 8, [
    { name: "y", type: uint, offset: 0 },
    { name: "z", type: uint, offset: 4 },
  ]);
  const anonUnion = b.union("", 8, [
    { name: "x", type: uint, offset: 0 },
    { name: "", type: anonInner, offset: 0 },
  ]);

  const commArr = b.array(char, 16, int);
  const valsArr = b.array(int, 4, int);
  const tsPtr = b.ptr(b.peekId + 4); // task_struct is declared 4 types later
  const namePtr = b.ptr(cchar);
  const fnProto = b.funcProto(int, [{ name: "t", type: tsPtr }, { type: 0 }]);
  const fnPtr = b.ptr(fnProto);
  const task_struct = b.struct("task_struct", 104, [
    { name: "pid", type: pid_t, offset: 0 },
    { name: "", type: anonUnion, offset: 4 },
    { name: "bf_a", type: uint, bitOffset: 96, bitSize: 4 },
    { name: "bf_b", type: int, bitOffset: 100, bitSize: 3 },
    { name: "bf_c", type: uint, bitOffset: 103, bitSize: 12 },
    { name: "bf_bool", type: bool, bitOffset: 115, bitSize: 1 },
    { name: "comm", type: commArr, offset: 16 },
    { name: "se", type: sched_entity, offset: 32 },
    { name: "tasks", type: list_head, offset: 52 },
    { name: "parent", type: tsPtr, offset: 60 },
    { name: "name", type: namePtr, offset: 64 },
    { name: "delta", type: s64, offset: 72 },
    { name: "vals", type: valsArr, offset: 80 },
    { name: "state", type: task_state, offset: 96 },
    { name: "fn", type: fnPtr, offset: 100 },
  ]);
  if (task_struct !== tsPtr + 4) throw new Error("fixture: task_struct forward ref mismatch");

  const incomplete = b.struct("incomplete", 8, [
    { name: "a", type: int, offset: 0 },
    { name: "b", type: int, offset: 4 },
  ]);
  const ptrInc = b.ptr(fwdInc);
  const ptrNodef = b.ptr(fwdNodef);
  const ptrVoid = b.ptr(0);
  const holder = b.struct("holder", 12, [
    { name: "inc", type: ptrInc, offset: 0 },
    { name: "nodef", type: ptrNodef, offset: 4 },
    { name: "vp", type: ptrVoid, offset: 8 },
  ]);
  const smalls = b.struct("smalls", 12, [
    { name: "s8", type: b.typedef("s8", b.int("signed char", 1, { signed: true, char: true })), offset: 0 },
    { name: "u8", type: uchar, offset: 1 },
    { name: "s16", type: sshort, offset: 2 },
    { name: "u16", type: ushort, offset: 4 },
    { name: "d", type: dbl, offset: 8 },
  ]);
  const flexHdr = b.struct("flex", 4, [
    { name: "n", type: int, offset: 0 },
    { name: "data", type: b.array(uchar, 0, int), offset: 4 },
  ]);

  const vInit = b.var("init_task", task_struct);
  const vJiffies = b.var("jiffies", u32);
  const vTaskList = b.var("task_list", list_head);
  const vHolder = b.var("the_holder", holder);
  const datasec = b.datasec(".data", 0x100, [
    { type: vInit, offset: 0x1000, size: 104 },
    { type: vJiffies, offset: 0xf80, size: 4 },
  ]);

  const ids = {
    int, uint, ulong, char, uchar, sshort, ushort, bool, ull, sll, dbl, u64, s64, u32, kpid, pid_t, cchar, cpid,
    list_head, lhPtr, sched_entity, task_state, big_enum, sbig_enum, uenum, fwdInc, fwdNodef, fwdU, anonInner,
    anonUnion, commArr, valsArr, tsPtr, namePtr, fnProto, fnPtr, task_struct, incomplete, ptrInc, ptrNodef,
    ptrVoid, holder, smalls, flexHdr, vInit, vJiffies, vTaskList, vHolder, datasec,
  };
  return { blob: b.build(), ids };
}

export const SYSTEM_MAP = `
c1000000 T _text
c1000040 T startup_32
c1000100 t local_fn
c1000100 T global_fn
c1000200 T schedule
c1000300 A some_abs
c1000300 t __sched_text_end
c1800000 D jiffies
c1800010 b init_task
c1800100 B _end
`;

export function makeProgram() {
  const { blob, ids } = buildFixture();
  const btf = parseBtf(blob);
  const mem = new FakeMemory(BASE, 0x2000);
  // Symbols pointing at our fake memory.
  const symbols = parseSystemMap(
    `c0001000 D init_task\nc0000f80 D jiffies\nc0000f00 D task_list\nc0000e00 D the_holder\nc0000100 T _text\n`,
  );
  const prog = new KernelProgram(btf, symbols, mem);
  return { btf, mem, symbols, prog, ids };
}
