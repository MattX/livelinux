import { useState } from "preact/hooks";
import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import { OverviewTab } from "./tabs/OverviewTab";
import { TasksTab } from "./tabs/TasksTab";
import { SchedulerTab } from "./tabs/SchedulerTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { TypesTab } from "./tabs/TypesTab";
import { ErrorBox } from "./common";

const TABS = [
  { id: "overview", label: "Overview", C: OverviewTab },
  { id: "tasks", label: "Tasks", C: TasksTab },
  { id: "sched", label: "Scheduler", C: SchedulerTab },
  { id: "memory", label: "Memory", C: MemoryTab },
  { id: "types", label: "Types", C: TypesTab },
] as const;

interface Props {
  machine: Machine;
  running: boolean;
  /** Program built for the current pause (null while running or if construction failed). */
  prog: Program | null;
  progError: string | null;
  /** Increments on every pause so tabs recompute. */
  generation: number;
}

export function Inspector({ machine, running, prog, progError, generation }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const disabled = running || !prog;
  const Active = TABS.find((t) => t.id === tab)!.C;
  return (
    <div class={"inspector" + (disabled ? " disabled" : "")}>
      {running && (
        <div class="disabled-note">
          <span>Pause the VM to inspect</span>
        </div>
      )}
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
      </div>
      <div class="tab-body" data-testid="tab-body">
        {!running && progError && <ErrorBox error={`Could not build kernel program: ${progError}`} />}
        {prog && !running && <Active key={`${tab}-${generation}`} prog={prog} machine={machine} />}
      </div>
    </div>
  );
}
