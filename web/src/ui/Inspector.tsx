import { useState } from "preact/hooks";
import type { ComponentType } from "preact";
import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import type { LiveSampler } from "../live/sampler";
import type { InspectorProps, LiveTabProps } from "../app/types";
import { OverviewTab } from "./tabs/OverviewTab";
import { TasksTab } from "./tabs/TasksTab";
import { SchedulerTab } from "./tabs/SchedulerTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { TypesTab } from "./tabs/TypesTab";
import { RamTab } from "./tabs/RamTab";
import { CpuTab } from "./tabs/CpuTab";
import { ErrorBox } from "./common";

type Tab =
  | { id: string; label: string; live: false; C: ComponentType<InspectorProps> }
  | { id: string; label: string; live: true; C: ComponentType<LiveTabProps> };

const TABS: Tab[] = [
  { id: "ram", label: "RAM", live: true, C: RamTab },
  { id: "cpu", label: "CPU", live: true, C: CpuTab },
  { id: "overview", label: "Overview", live: false, C: OverviewTab },
  { id: "tasks", label: "Tasks", live: false, C: TasksTab },
  { id: "sched", label: "Scheduler", live: false, C: SchedulerTab },
  { id: "memory", label: "Memory", live: false, C: MemoryTab },
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
  const active = TABS.find((t) => t.id === tab)!;
  const disabled = !active.live && (running || !prog);
  return (
    <div class={"inspector" + (disabled ? " disabled" : "")}>
      {running && !active.live && (
        <div class="disabled-note">
          <span>Pause the VM to inspect (RAM and CPU are live)</span>
        </div>
      )}
      <div class="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            class={"tab" + (tab === t.id ? " active" : "") + (t.live ? " live" : "")}
            onClick={() => setTab(t.id)}
            data-tab={t.id}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div class="tab-body" data-testid="tab-body">
        {active.live ? (
          live ? (
            <active.C key={active.id} live={live} machine={machine} running={running} />
          ) : (
            <ErrorBox error={`Live sampler unavailable: ${liveError ?? "VM not ready"}`} />
          )
        ) : (
          <>
            {!running && progError && <ErrorBox error={`Could not build kernel program: ${progError}`} />}
            {prog && !running && <active.C key={`${tab}-${generation}`} prog={prog} machine={machine} />}
          </>
        )}
      </div>
    </div>
  );
}
