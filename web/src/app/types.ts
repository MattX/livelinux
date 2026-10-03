import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import type { LiveSampler } from "../live/sampler";

/** Props for each inspector tab. */
export interface InspectorProps {
  prog: Program;
  machine: Machine;
}

/** Props for live tabs, which keep working while the VM runs. */
export interface LiveTabProps {
  live: LiveSampler;
  machine: Machine;
  running: boolean;
}
