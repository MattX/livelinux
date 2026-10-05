import { useEffect, useState } from "preact/hooks";
import type { Program, Value } from "../../debug/api";
import type { InspectorProps } from "../../app/types";
import {
  addMapped, clipRanges, currentTask, findTask, kernelRegion, mmPgdPhys, PAGE_OFFSET, taskInfo, THREAD_SIZE, tryGet, userRegion, userRegs, vmas,
  ADDR_TOP, type VaMarker, type VaRegion,
} from "../../debug/helpers";
import { kernelAddressSpace } from "../../app/session";
import type { Machine } from "../../vm/machine";
import { taskColor } from "../../live/cpuStats";
import { useSelection } from "../selection";
import { Async, Section } from "../common";
import { useCompute } from "../hooks";
import { HexViewer } from "../HexViewer";
import { RangesTable } from "../RangesTable";
import { fmtHex } from "../util";
import type { MappedRange } from "../../vm/types";
import type { AddressSpace } from "../../vm/mmu";
import { VaMap, rowKey } from "../VaMap";

interface MapData {
  title: string;
  pid: number | null;
  roots: VaRegion[];
  markers: VaMarker[];
  /** Present page-table runs of the whole 4 GiB, ascending. */
  ranges: MappedRange[];
  /** Address space for reading virtual memory: the process's, or the kernel's. */
  space: AddressSpace;
  physTop: number;
  note?: string;
}

/** Kernel-side markers for a task: its task_struct and kernel stack. */
function taskMarkers(task: Value, who: string): VaMarker[] {
  const out: VaMarker[] = [{ addr: task.addr, label: `${who}task_struct`, note: "the task's struct task_struct (slab, in the direct map)" }];
  const stack = tryGet(() => task.member("stack").ptr());
  if (stack) out.push({ addr: stack + THREAD_SIZE - 1, label: `${who}kstack`, note: `top of the task's ${THREAD_SIZE / 1024} KiB kernel stack (grows down)` });
  return out;
}

function buildMap(prog: Program, machine: Machine, pid: number | null): MapData {
  const kspace = kernelAddressSpace(machine, prog);
  const kranges = kspace.walkRanges(PAGE_OFFSET, ADDR_TOP);
  const kernel = kernelRegion(prog, kranges);
  addMapped(kernel, kranges);
  const regs = machine.regs();
  const maxPfn = tryGet(() => prog.var("max_pfn").num()) ?? 0;
  const physTop = Math.min(machine.phys.size, maxPfn ? maxPfn * 4096 : machine.phys.size);
  const cur = tryGet(() => currentTask(prog));
  const markers: VaMarker[] = [];
  if (regs.cpl === 0) markers.push({ addr: regs.eip, label: "eip", note: `CPU instruction pointer (kernel mode): ${prog.symbols.format(regs.eip)}` });

  const task = pid !== null ? findTask(prog, pid) : undefined;
  const mmPtr = task ? (tryGet(() => task.member("mm").ptr()) ?? 0) : 0;
  if (task && mmPtr) {
    const info = taskInfo(task);
    const mm = task.member("mm").deref();
    const pgdPhys = mmPgdPhys(mm);
    const list = vmas(prog, mm);
    const user = userRegion(list);
    const space = machine.addressSpace(pgdPhys);
    const uranges = space.walkRanges(0, PAGE_OFFSET);
    addMapped(user, uranges);
    kernel.open = false;

    const isCurrent = cur?.addr === task.addr;
    if (isCurrent && regs.cpl === 3) {
      markers.push({ addr: regs.eip, label: "eip", note: "CPU instruction pointer (running in user mode now)" });
      markers.push({ addr: regs.esp, label: "esp", note: "CPU stack pointer (running in user mode now)" });
    } else {
      const ur = userRegs(prog, task);
      if (ur) {
        markers.push({ addr: ur.ip, label: "ip", note: "user ip saved on the last kernel entry (pt_regs at the top of the kernel stack)" });
        markers.push({ addr: ur.sp, label: "sp", note: "user sp saved on the last kernel entry (pt_regs at the top of the kernel stack)" });
      }
    }
    const brk = tryGet(() => mm.member("brk").num());
    if (brk) markers.push({ addr: brk, label: "brk", note: "program break: the end of the heap (sbrk(0))" });
    const mmapBase = tryGet(() => mm.member("mmap_base").num());
    if (mmapBase) markers.push({ addr: mmapBase - 1, label: "mmap_base", note: "mmap() places new mappings below this, top-down" });
    markers.push(...taskMarkers(task, ""));
    const pgd = tryGet(() => mm.member("pgd").ptr());
    if (pgd) markers.push({ addr: pgd, label: "pgd", note: "the process's page directory (what CR3 points to while it runs)" });
    return {
      title: `${info.comm} (pid ${info.pid})`, pid: info.pid, roots: [user, kernel], markers, ranges: [...uranges, ...kranges], space, physTop,
    };
  }

  // Kernel view: no process selected, or a kernel thread.
  const placeholder: VaRegion = {
    id: "user", start: 0, end: PAGE_OFFSET, label: "user space", kind: "user",
    detail: task ? "none: kernel threads have no user address space" : "differs per process: select one (Tasks, CPU, RAM, ...)",
    note: "the lower 3 GiB belong to the current process; kernel threads borrow the previous process's (active_mm) without using it",
  };
  if (task) {
    const info = taskInfo(task);
    markers.push(...taskMarkers(task, ""));
    return { title: `${info.comm} (pid ${info.pid}, kernel thread)`, pid: info.pid, roots: [placeholder, kernel], markers, ranges: kranges, space: kspace, physTop };
  }
  if (cur) markers.push(...taskMarkers(cur, "cur. "));
  const swapper = prog.symbols.addr("swapper_pg_dir");
  if (swapper !== undefined) markers.push({ addr: swapper, label: "swapper_pg_dir", note: "the kernel's own page directory, template for every process's kernel half" });
  const init = prog.symbols.addr("init_task");
  if (init !== undefined) markers.push({ addr: init, label: "init_task", note: "pid 0's task_struct, statically allocated in .data" });
  const note = pid !== null ? `no task with pid ${pid} (it may have exited)` : undefined;
  return { title: "kernel", pid: null, roots: [placeholder, kernel], markers, ranges: kranges, space: kspace, physTop, note };
}

interface Pinned {
  key: string;
  label: string;
  start: number;
  end: number;
}

/** Where the hex viewer points: bumping `n` re-opens it at `addr`. */
interface HexTarget {
  mode: "virt" | "phys";
  addr: number | undefined;
  n: number;
}

export function VaMapTab({ prog, machine }: InspectorProps) {
  const sel = useSelection();
  const c = useCompute(() => buildMap(prog, machine, sel.pid), [prog, machine, sel.pid]);
  const [showPhys, setShowPhys] = useState(true);
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [hex, setHex] = useState<HexTarget>({ mode: "virt", addr: prog.symbols.addr("init_task"), n: 0 });
  const [showPt, setShowPt] = useState(false);
  useEffect(() => setPinned(null), [sel.pid]);
  const jump = (mode: HexTarget["mode"], addr: number) => {
    setHex({ mode, addr, n: hex.n + 1 });
    requestAnimationFrame(() => document.getElementById("vam-hex")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  // Switching between virtual and physical keeps pointing at the same bytes when it can.
  const switchMode = (mode: HexTarget["mode"], space: AddressSpace) => {
    if (mode === hex.mode) return;
    let addr = hex.addr;
    if (addr !== undefined) addr = mode === "phys" ? space.translate(addr)?.pa : (addr + PAGE_OFFSET) >>> 0;
    setHex({ mode, addr, n: hex.n + 1 });
  };
  return (
    <Async c={c}>
      {(d) => (
        <>
          <Section
            title={`Virtual address space · ${d.title}`}
            right={
              <span class="muted vam-head">
                {d.pid !== null && <span class="sel-dot" style={{ background: taskColor(d.pid), display: "inline-block" }} />}
                <span>not to scale: gaps squeezed, sizes on a log scale</span>
                <label title="Draw guest RAM to scale next to the map, with each frame coloured by the region that maps it">
                  <input type="checkbox" checked={showPhys} onChange={(e) => setShowPhys((e.target as HTMLInputElement).checked)} /> physical
                </label>
              </span>
            }
          >
            {d.note && <div class="muted">{d.note}</div>}
            <VaMap
              key={d.pid ?? "kernel"}
              roots={d.roots}
              markers={d.markers}
              ranges={d.ranges}
              physTop={showPhys ? d.physTop : 0}
              pinned={pinned?.key ?? null}
              onPin={(row) => setPinned(row ? { key: rowKey(row), label: row.type === "region" ? row.r.label : row.label, start: row.start, end: row.end } : null)}
              onPickPfn={(pfn) => jump("phys", pfn * 4096)}
              footer={
                <span class="muted">
                  Virtual addresses on the left, 0 at the bottom{showPhys && "; physical RAM to scale on the right"}. Click a region to expand or
                  collapse it, or to pin it (then dump it below). The bar in a region is how much of it has present page-table entries; dashed
                  lines are pointers ({d.pid !== null ? "saved user ip / sp, brk, the task's kernel objects" : "current task, kernel page directory"}).
                  {showPhys && " Ribbons join the kernel's direct map to the frames it maps linearly; hover any other region to draw lines to its scattered frames, or hover a frame to see every virtual address mapping it."}
                  {d.pid === null && " Select a process anywhere to see its user half."}
                </span>
              }
            />
          </Section>
          {pinned && (
            <Section
              title={`Pinned · ${pinned.label}`}
              right={
                <span class="toolbar" style={{ margin: 0 }}>
                  <button onClick={() => jump("virt", pinned.start)}>hex dump</button>
                  <button class={showPt ? "primary" : ""} onClick={() => setShowPt(!showPt)}>page tables</button>
                  <button onClick={() => setPinned(null)}>unpin</button>
                </span>
              }
            >
              <div class="muted">
                {fmtHex(pinned.start)}–{fmtHex(pinned.end >= ADDR_TOP ? ADDR_TOP : pinned.end, 8)}
              </div>
              {showPt && (
                <RangesTable
                  ranges={clipRanges(d.ranges, pinned.start, pinned.end).map((pc) => {
                    const r = d.ranges.find((x) => x.va <= pc.va && pc.va < x.va + x.size)!;
                    return { ...r, va: pc.va, pa: pc.pa, size: pc.size };
                  })}
                  symbols={pinned.start >= PAGE_OFFSET ? prog.symbols : undefined}
                  onPick={(va) => jump("virt", Math.max(va, pinned.start))}
                />
              )}
            </Section>
          )}
          <Section
            title="Hex viewer"
            right={
              <span class="toolbar" style={{ margin: 0 }}>
                <button class={hex.mode === "virt" ? "primary" : ""} onClick={() => switchMode("virt", d.space)}>
                  virtual{d.pid !== null ? ` (pid ${d.pid})` : ""}
                </button>
                <button class={hex.mode === "phys" ? "primary" : ""} onClick={() => switchMode("phys", d.space)}>physical</button>
              </span>
            }
          >
            <div id="vam-hex">
              {hex.mode === "virt" ? (
                <HexViewer key={`v${hex.n}`} mem={d.space} label="VA" symbols={prog.symbols} allowSymbols initial={hex.addr} autoRead />
              ) : (
                <HexViewer key={`p${hex.n}`} mem={machine.phys} label="PA" initial={hex.addr ?? 0x1000} autoRead />
              )}
            </div>
          </Section>
        </>
      )}
    </Async>
  );
}
