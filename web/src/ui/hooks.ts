import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { LiveSampler } from "../live/sampler";
import { errMsg } from "./util";

export interface Computed<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/** How inspector tabs get fresh data: from the live sampler's ticks while running, per pause otherwise. */
export interface InspectState {
  live: LiveSampler | null;
  running: boolean;
  /** Increments on every pause. */
  generation: number;
}

export const InspectContext = createContext<InspectState>({ live: null, running: false, generation: 0 });

/** True when tabs should refresh from live sampler ticks (VM running and sampler available). */
function useLiveMode(): { live: LiveSampler | null; liveMode: boolean; generation: number } {
  const { live, running, generation } = useContext(InspectContext);
  return { live, liveMode: running && !!live, generation };
}

/**
 * Compute `fn`, catching errors. While the VM is paused: once on mount / when deps change (deferred
 * one tick so the "loading" state can paint first). While it runs: on every live sampler tick, i.e.
 * at a slice boundary where guest memory is quiescent (see LiveSampler.subscribeTick).
 */
export function useCompute<T>(fn: () => T, deps: unknown[]): Computed<T> {
  const [state, setState] = useState<Computed<T>>({ loading: true });
  const { live, liveMode, generation } = useLiveMode();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const run = (torn: boolean) => {
      if (cancelled) return;
      try {
        const data = fnRef.current();
        setState({ data, loading: false });
      } catch (e) {
        // A walk that raced a kernel update can fail; keep the last good data rather than flicker.
        if (torn) setState((s) => (s.data !== undefined ? { ...s, loading: false } : { error: errMsg(e), loading: false }));
        else {
          console.error(e);
          setState({ error: errMsg(e), loading: false });
        }
      }
    };
    if (liveMode) {
      const off = live!.subscribeTick(run);
      return () => {
        cancelled = true;
        off();
      };
    }
    const t = setTimeout(() => run(false), 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, live, liveMode, liveMode ? -1 : generation]);
  return state;
}

/**
 * Run `cb` whenever displayed guest state should be re-read: on every live sampler tick while the
 * VM runs, and once on each new pause (not on mount). For components that read memory on demand.
 */
export function useInspectTick(cb: () => void): void {
  const { live, liveMode, generation } = useLiveMode();
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (liveMode) return live!.subscribeTick(() => cbRef.current());
    if (!first) cbRef.current();
  }, [live, liveMode, generation]);
}

/** Run a function and return either its value or an error string (for inline use during render). */
export function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
