import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";

/** Props for each inspector tab. */
export interface InspectorProps {
  prog: Program;
  machine: Machine;
}
