import { useState } from "preact/hooks";
import type { Program, Value } from "../../debug/api";
import type { InspectorProps } from "../../app/types";
import {
  currentTask, forEachTask, forEachThread, formatMaps, mmPgdPhys, taskInfo, vmas,
  type TaskInfo, type VmaInfo,
} from "../../debug/helpers";
import { Async, ErrorBox, KV, Section } from "../common";
import { attempt, useCompute } from "../hooks";
import { HexViewer } from "../HexViewer";
import { RangesTable } from "../RangesTable";
import { fmtHex } from "../util";

export function TasksTab(props: InspectorProps) {
  const [sel, setSel] = useState<number | null>(null);
  if (sel !== null) return <TaskDetail {...props} addr={sel} onBack={() => setSel(null)} />;
  return <TaskList {...props} onSelect={setSel} />;
}

function TaskList({ prog, onSelect }: InspectorProps & { onSelect: (addr: number) => void }) {
  const c = useCompute(() => {
    const cur = attempt(() => currentTask(prog).addr);
    const rows: TaskInfo[] = [];
    for (const t of forEachTask(prog)) rows.push(taskInfo(t));
    return { rows, cur: cur.ok ? cur.value : -1 };
  }, [prog]);
  return (
    <Async c={c}>
      {({ rows, cur }) => (
        <Section title={`Tasks (${rows.length})`} right="thread-group leaders; click a row for details">
          <div class="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th class="num">pid</th><th class="num">ppid</th><th>state</th><th>comm</th><th>kthread</th><th>task_struct</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.addr} class={"clickable" + (t.addr === cur ? " current" : "")} onClick={() => onSelect(t.addr)}>
                    <td class="num">{t.pid}</td>
                    <td class="num">{t.ppid}</td>
                    <td title={t.stateName}>{t.state}</td>
                    <td>{t.comm} {t.addr === cur && <span class="tag cur">current</span>}</td>
                    <td>{t.isKthread ? <span class="tag k">kthread</span> : ""}</td>
                    <td>{fmtHex(t.addr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </Async>
  );
}

interface Detail {
  info: TaskInfo;
  threads: TaskInfo[];
  prio: { prio: number; static?: number };
  hasMm: boolean;
  mmAddr: number;
  pgdPhys: number;
  vmas: { ok: true; value: VmaInfo[] } | { ok: false; error: string };
}

function loadDetail(prog: Program, task: Value): Detail {
  const info = taskInfo(task);
  const threads: TaskInfo[] = [];
  const th = attempt(() => {
    for (const t of forEachThread(task)) threads.push(taskInfo(t));
  });
  if (!th.ok) console.warn(th.error);
  const mmPtr = task.member("mm").ptr();
  let pgdPhys = 0;
  let vmaRes: Detail["vmas"] = { ok: true, value: [] };
  if (mmPtr !== 0) {
    const mm = task.member("mm").deref();
    pgdPhys = mmPgdPhys(mm);
    vmaRes = attempt(() => vmas(prog, mm));
  }
  return { info, threads, prio: { prio: info.prio }, hasMm: mmPtr !== 0, mmAddr: mmPtr, pgdPhys, vmas: vmaRes };
}

function TaskDetail({ prog, machine, addr, onBack }: InspectorProps & { addr: number; onBack: () => void }) {
  const c = useCompute(() => loadDetail(prog, prog.value(addr, "struct task_struct")), [prog, addr]);
  const [showMaps, setShowMaps] = useState(false);
  return (
    <>
      <div class="crumbs">
        <a onClick={onBack}>← Tasks</a>
      </div>
      <Async c={c}>
        {(d) => {
          const i = d.info;
          return (
            <>
              <Section title={`${i.comm} (pid ${i.pid})`}>
                <KV
                  rows={[
                    ["task_struct", fmtHex(i.addr)],
                    ["pid / tgid / ppid", `${i.pid} / ${i.tgid} / ${i.ppid}`],
                    ["state", `${i.state} (${i.stateName}), raw ${fmtHex(i.stateRaw, 1)}`],
                    ["flags", <>{fmtHex(i.flags)} {i.isKthread && <span class="tag k">PF_KTHREAD</span>}</>],
                    ["prio", String(i.prio)],
                    ["mm", d.hasMm ? `${fmtHex(d.mmAddr)}, pgd phys ${fmtHex(d.pgdPhys)}` : "none (kernel thread)"],
                  ]}
                />
              </Section>
              <Section title={`Threads (${d.threads.length})`}>
                <div class="tbl-wrap">
                  <table>
                    <thead><tr><th class="num">pid</th><th>comm</th><th>state</th><th>task_struct</th></tr></thead>
                    <tbody>
                      {d.threads.map((t) => (
                        <tr key={t.addr}><td class="num">{t.pid}</td><td>{t.comm}</td><td title={t.stateName}>{t.state}</td><td>{fmtHex(t.addr)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
              {d.hasMm ? (
                <UserSpace machine={machine} prog={prog} d={d} showMaps={showMaps} setShowMaps={setShowMaps} />
              ) : (
                <div class="muted">No user address space (kernel thread).</div>
              )}
            </>
          );
        }}
      </Async>
    </>
  );
}

function UserSpace({ prog, machine, d, showMaps, setShowMaps }: InspectorProps & { d: Detail; showMaps: boolean; setShowMaps: (b: boolean) => void }) {
  const space = useCompute(() => machine.addressSpace(d.pgdPhys), [machine, d.pgdPhys]);
  const ranges = useCompute(() => machine.addressSpace(d.pgdPhys).walkRanges(0, 0xc0000000), [machine, d.pgdPhys]);
  const vm = d.vmas;
  return (
    <>
      <Section
        title={`VMAs${vm.ok ? ` (${vm.value.length})` : ""}`}
        right={vm.ok && <a style={{ cursor: "pointer", color: "var(--accent)" }} onClick={() => setShowMaps(!showMaps)}>{showMaps ? "table" : "/proc/pid/maps"}</a>}
      >
        {!vm.ok ? (
          <ErrorBox error={vm.error} />
        ) : showMaps ? (
          <pre class="maps">{formatMaps(vm.value)}</pre>
        ) : (
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>start</th><th>end</th><th>perms</th><th class="num">pgoff</th><th>name</th></tr></thead>
              <tbody>
                {vm.value.map((v) => (
                  <tr key={v.addr}>
                    <td>{fmtHex(v.start)}</td>
                    <td>{fmtHex(v.end)}</td>
                    <td>{v.flagsStr}</td>
                    <td class="num">{fmtHex(v.pgoff, 1)}</td>
                    <td>{v.name ?? <span class="muted">[anon]</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Page tables (user half, 0 .. 0xc0000000)">
        <Async c={ranges}>{(r) => <RangesTable ranges={r} />}</Async>
      </Section>
      <Section title="Read user memory">
        <Async c={space}>
          {(as) => (
            <HexViewer
              mem={as}
              label="VA"
              symbols={prog.symbols}
              initial={vm.ok && vm.value.length ? vm.value[0].start : 0x08048000}
              autoRead={false}
            />
          )}
        </Async>
      </Section>
    </>
  );
}
