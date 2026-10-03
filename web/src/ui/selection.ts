// One process selection shared by every inspector tab: click a pid anywhere (a task row, a CPU
// slice, a scheduler bar, a node in the files graph) and every other view highlights it.

import { createContext } from "preact";
import { useContext } from "preact/hooks";

export interface SelectionApi {
  /** Selected pid (a thread-group leader's pid for most views), or null. */
  pid: number | null;
  /** comm of the selected task, for display only. */
  comm: string | null;
  /** Select a pid; selecting the already-selected pid again clears the selection. */
  toggle(pid: number, comm?: string): void;
  /** Select a pid (null clears). */
  select(pid: number | null, comm?: string): void;
  /** Switch the inspector to another tab ("tasks", "ram", ...). */
  goto(tab: string): void;
}

export const SelectionContext = createContext<SelectionApi>({
  pid: null,
  comm: null,
  toggle: () => {},
  select: () => {},
  goto: () => {},
});

export function useSelection(): SelectionApi {
  return useContext(SelectionContext);
}
