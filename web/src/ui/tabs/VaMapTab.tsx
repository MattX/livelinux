import type { Program, Value } from "../../debug/api";
import type { InspectorProps } from "../../app/types";
import {
  addMapped, currentTask, findTask, kernelRegion, mmPgdPhys, PAGE_OFFSET, taskInfo, THREAD_SIZE, tryGet, userRegion, userRegs, vmas,
  ADDR_TOP, type VaMarker, type VaRegion,
} from "../../debug/helpers";
import { kernelAddressSpace } from "../../app/session";
import type { Machine } from "../../vm/machine";
import { taskColor } from "../../live/cpuStats";
import { useSelection } from "../selection";
import { Async, Section } from "../common";
import { useCompute } from "../hooks";
import { VaMap } from "../VaMap";

interface MapData {
  title: string;
  pid: number | null;
  roots: VaRegion[];
  markers: VaMarker[];
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
    addMapped(user, machine.addressSpace(pgdPhys).walkRanges(0, PAGE_OFFSET));
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
    return { title: `${info.comm} (pid ${info.pid})`, pid: info.pid, roots: [user, kernel], markers };
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
    return { title: `${info.comm} (pid ${info.pid}, kernel thread)`, pid: info.pid, roots: [placeholder, kernel], markers };
  }
  if (cur) markers.push(...taskMarkers(cur, "cur. "));
  const swapper = prog.symbols.addr("swapper_pg_dir");
  if (swapper !== undefined) markers.push({ addr: swapper, label: "swapper_pg_dir", note: "the kernel's own page directory, template for every process's kernel half" });
  const init = prog.symbols.addr("init_task");
  if (init !== undefined) markers.push({ addr: init, label: "init_task", note: "pid 0's task_struct, statically allocated in .data" });
  const note = pid !== null ? `no task with pid ${pid} (it may have exited)` : undefined;
  return { title: "kernel", pid: null, roots: [placeholder, kernel], markers, note };
}

export function VaMapTab({ prog, machine }: InspectorProps) {
  const sel = useSelection();
  const c = useCompute(() => buildMap(prog, machine, sel.pid), [prog, machine, sel.pid]);
  return (
    <Async c={c}>
      {(d) => (
        <Section
          title={`Virtual address space · ${d.title}`}
          right={
            <span class="muted">
              {d.pid !== null && <span class="sel-dot" style={{ background: taskColor(d.pid), display: "inline-block", marginRight: "6px" }} />}
              not to scale: gaps squeezed, sizes on a log scale
            </span>
          }
        >
          {d.note && <div class="muted">{d.note}</div>}
          <VaMap
            key={d.pid ?? "kernel"}
            roots={d.roots}
            markers={d.markers}
            footer={
              <span class="muted">
                0 at the bottom, 4 GiB at the top. Click a region to expand or collapse it, or to pin its details. The bar on the right of a
                region is how much of it has present page-table entries; dashed lines are pointers ({d.pid !== null ? "saved user ip / sp, brk, the task's kernel objects" : "current task, kernel page directory"}).
                {d.pid === null && " Select a process anywhere to see its user half."}
              </span>
            }
          />
        </Section>
      )}
    </Async>
  );
}
