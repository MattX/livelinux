import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import type { LiveSampler } from "../live/sampler";
import type { InspectorProps, LiveTabProps } from "../app/types";
import { OverviewTab } from "./tabs/OverviewTab";
import { TasksTab } from "./tabs/TasksTab";
import { SchedulerTab } from "./tabs/SchedulerTab";
import { TypesTab } from "./tabs/TypesTab";
import { RamTab } from "./tabs/RamTab";
import { CpuTab } from "./tabs/CpuTab";
import { FilesTab } from "./tabs/FilesTab";
import { VaMapTab } from "./tabs/VaMapTab";
import { taskColor } from "../live/cpuStats";
import { ErrorBox } from "./common";
import { InspectContext } from "./hooks";
import { SelectionContext, type SelectionApi } from "./selection";

// `live: true` tabs drive the sampler themselves (continuous RAM / CPU sampling). The others read
// kernel state through a Program: per pause, or on the sampler's periodic ticks while running.
type Tab =
  | { id: string; label: string; live: false; C: ComponentType<InspectorProps> }
  | { id: string; label: string; live: true; C: ComponentType<LiveTabProps> };

const REFRESH: { ms: number; label: string }[] = [
  { ms: 250, label: "0.25 s" },
  { ms: 500, label: "0.5 s" },
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 0, label: "manual" },
];

const TABS: Tab[] = [
  { id: "ram", label: "RAM", live: true, C: RamTab },
  { id: "cpu", label: "CPU", live: true, C: CpuTab },
  { id: "overview", label: "Overview", live: false, C: OverviewTab },
  { id: "tasks", label: "Tasks", live: false, C: TasksTab },
  { id: "vamap", label: "Address space", live: false, C: VaMapTab },
  { id: "sched", label: "Scheduler", live: false, C: SchedulerTab },
  { id: "files", label: "Files", live: false, C: FilesTab },
  { id: "types", label: "Types", live: false, C: TypesTab },
];

interface Props {
  machine: Machine;
  running: boolean;
  /** Program built for the current pause (null while running or if construction failed). */
  prog: Program | null;
  progError: string | null;
  /** Increments on every pause so tabs recompute. */
  generation: number;
  /** Live sampler (null if it could not be created). */
  live: LiveSampler | null;
  liveError: string | null;
}

export function Inspector({ machine, running, prog, progError, generation, live, liveError }: Props) {
  const [tab, setTab] = useState<string>("ram");
  const [selPid, setSelPid] = useState<number | null>(null);
  const [selComm, setSelComm] = useState<string | null>(null);
  const active = TABS.find((t) => t.id === tab)!;
  const selection = useMemo<SelectionApi>(() => {
    const select = (pid: number | null, comm?: string) => {
      setSelPid(pid);
      setSelComm(pid === null ? null : (comm ?? null));
    };
    return {
      pid: selPid,
      comm: selComm,
      select,
      toggle: (pid, comm) => select(pid === selPid ? null : pid, comm),
      goto: (id) => TABS.some((t) => t.id === id) && setTab(id),
    };
  }, [selPid, selComm]);
  // While running, inspector tabs read through the sampler's long-lived Program (its page-table
  // cache is cleared on every tick); while paused, through the Program built for this pause.
  const tabProg = running ? (live?.prog ?? null) : prog;
  return (
    <InspectContext.Provider value={{ live, running, generation }}>
      <SelectionContext.Provider value={selection}>
        <div class="inspector">
          <div class="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                class={"tab" + (tab === t.id ? " active" : "")}
                onClick={() => setTab(t.id)}
                data-tab={t.id}
              >
                {t.label}
              </button>
            ))}
            <span class="spacer" />
            {selPid !== null && (
              <span class="sel-chip" data-testid="selection" title="Selected process: highlighted in every tab">
                <span class="sel-dot" style={{ background: taskColor(selPid) }} />
                {selComm ?? "pid"} <b>{selPid}</b>
                <button type="button" onClick={() => selection.select(null)} title="Clear selection">×</button>
              </span>
            )}
            {running && !active.live && live && <RefreshControl live={live} />}
          </div>
          <div class="tab-body" data-testid="tab-body">
            {active.live ? (
              live ? (
                <active.C key={active.id} live={live} machine={machine} running={running} />
              ) : (
                <ErrorBox error={`Live sampler unavailable: ${liveError ?? "VM not ready"}`} />
              )
            ) : running && !live ? (
              <div class="muted">Live sampler unavailable ({liveError ?? "VM not ready"}); pause the VM to inspect.</div>
            ) : (
              <>
                {!running && progError && <ErrorBox error={`Could not build kernel program: ${progError}`} />}
                {/* Keyed by tab only: state such as the selected task survives pause / resume. */}
                {tabProg && <active.C key={active.id} prog={tabProg} machine={machine} />}
              </>
            )}
          </div>
        </div>
      </SelectionContext.Provider>
    </InspectContext.Provider>
  );
}

/** Refresh rate of the inspector tabs while the VM runs. */
function RefreshControl({ live }: { live: LiveSampler }) {
  const [ms, setMs] = useState(live.tickIntervalMs);
  useEffect(() => {
    live.tickIntervalMs = ms;
  }, [ms, live]);
  return (
    <span class="refresh" title="While the VM runs, this tab is re-read at slice boundaries where the guest is idle or in user mode, so kernel data structures are not mid-update.">
      <span class="live-dot" />
      live, every
      <select value={ms} onChange={(e) => setMs(Number((e.target as HTMLSelectElement).value))}>
        {REFRESH.map((r) => <option value={r.ms}>{r.label}</option>)}
      </select>
      <button type="button" onClick={() => live.requestTick()} title="Refresh now">↻</button>
    </span>
  );
}
