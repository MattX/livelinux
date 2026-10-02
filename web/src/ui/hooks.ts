import { useEffect, useState } from "preact/hooks";
import { errMsg } from "./util";

export interface Computed<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Run `fn` synchronously-ish on mount / when deps change, catching errors.
 * Computation is deferred one tick so the "loading" state can paint first.
 */
export function useCompute<T>(fn: () => T, deps: unknown[]): Computed<T> {
  const [state, setState] = useState<Computed<T>>({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      if (cancelled) return;
      try {
        const data = fn();
        setState({ data, loading: false });
      } catch (e) {
        console.error(e);
        setState({ error: errMsg(e), loading: false });
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Run a function and return either its value or an error string (for inline use during render). */
export function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
