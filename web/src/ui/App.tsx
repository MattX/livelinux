import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Program } from "../debug/api";
import type { Machine } from "../vm/machine";
import { loadAssets, type AssetProgress, type GuestAssets } from "../app/loader";
import { bootMachine, makeProgram, parseDebugInfo, type DebugInfo } from "../app/session";
import { Console } from "./Console";
import { Inspector } from "./Inspector";
import { fmtCount, errMsg } from "./util";

type Phase =
  | { kind: "loading"; progress: AssetProgress[] }
  | { kind: "booting"; what: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function Loading({ phase }: { phase: Phase }) {
  if (phase.kind === "error") {
    return (
      <div class="loading">
        <h2>Failed to start</h2>
        <div class="error">{phase.message}</div>
      </div>
    );
  }
  let frac = 0;
  let rows: AssetProgress[] = [];
  let title = "Booting…";
  if (phase.kind === "loading") {
    rows = phase.progress;
    title = "Loading guest assets…";
    const done = rows.filter((r) => r.done).length;
    const partial = rows.filter((r) => !r.done && r.total > 0).reduce((a, r) => a + r.loaded / r.total, 0);
    frac = rows.length ? (done + partial) / rows.length : 0;
  } else if (phase.kind === "booting") {
    title = phase.what;
    frac = 1;
  }
  return (
    <div class="loading">
      <h2>{title}</h2>
      <div class="progress"><div style={{ width: `${Math.round(frac * 100)}%` }} /></div>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            <span>{r.name}</span>
            <span>
              {r.done ? "done" : r.total ? `${(r.loaded / 1048576).toFixed(1)} / ${(r.total / 1048576).toFixed(1)} MiB` : `${(r.loaded / 1048576).toFixed(1)} MiB`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading", progress: [] });
  const [machine, setMachine] = useState<Machine | null>(null);
  const [running, setRunning] = useState(true);
  const [prog, setProg] = useState<Program | null>(null);
  const [progError, setProgError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [instrs, setInstrs] = useState(0);
  const [ips, setIps] = useState(0);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const snapshotRef = useRef<ArrayBuffer | null>(null);
  const assetsRef = useRef<{ assets: GuestAssets; info: DebugInfo } | null>(null);

  // Boot sequence.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const assets = await loadAssets((progress) => !cancelled && setPhase({ kind: "loading", progress }));
        if (cancelled) return;
        setPhase({ kind: "booting", what: "Parsing BTF and System.map…" });
        await new Promise((r) => setTimeout(r, 10));
        const info = parseDebugInfo(assets);
        assetsRef.current = { assets, info };
        setPhase({ kind: "booting", what: "Starting VM…" });
        await new Promise((r) => setTimeout(r, 10));
        const m = await bootMachine(assets);
        if (cancelled) return;
        (window as any).__machine = m; // handy for debugging in devtools
        setMachine(m);
        setRunning(m.running);
        setPhase({ kind: "ready" });
      } catch (e) {
        console.error(e);
        if (!cancelled) setPhase({ kind: "error", message: errMsg(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Track machine state; build the KernelProgram lazily on each pause.
  const onPaused = useCallback((m: Machine) => {
    const ctx = assetsRef.current;
    if (!ctx) return;
    try {
      const p = makeProgram(m, ctx.info);
      (window as any).__prog = p;
      setProg(p);
      setProgError(null);
    } catch (e) {
      console.error(e);
      setProg(null);
      setProgError(errMsg(e));
    }
    setInstrs(m.getInstructionCounter());
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    if (!machine) return;
    const off = machine.onStateChange((s) => {
      if (s === "running") {
        setRunning(true);
        setProg(null); // memory contents change: drop everything derived from the old pause
        setProgError(null);
      } else {
        setRunning(false);
        onPaused(machine);
      }
    });
    if (!machine.running) {
      setRunning(false);
      onPaused(machine);
    }
    return off;
  }, [machine, onPaused]);

  // Instruction counter / rate while running.
  useEffect(() => {
    if (!machine || !running) {
      setIps(0);
      return;
    }
    let last = machine.getInstructionCounter();
    let lastT = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const cur = machine.getInstructionCounter();
      setIps(((cur - last) / (now - lastT)) * 1000);
      setInstrs(cur);
      last = cur;
      lastT = now;
    }, 500);
    return () => clearInterval(id);
  }, [machine, running]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const guarded = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      setToast(`${label} failed: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const toggle = () =>
    machine &&
    guarded(running ? "Pause" : "Resume", async () => {
      if (machine.running) await machine.pause();
      else await machine.resume();
    });

  const snapshot = () =>
    machine &&
    guarded("Snapshot", async () => {
      const wasRunning = machine.running;
      if (wasRunning) await machine.pause();
      snapshotRef.current = await machine.snapshot();
      setHasSnapshot(true);
      setToast(`Snapshot saved (${(snapshotRef.current.byteLength / 1048576).toFixed(1)} MiB)`);
      if (wasRunning) await machine.resume();
    });

  const restore = () =>
    machine &&
    guarded("Restore", async () => {
      if (!snapshotRef.current) return;
      if (machine.running) await machine.pause();
      await machine.restore(snapshotRef.current);
      setToast("Snapshot restored (VM paused)");
      if (!machine.running) onPaused(machine);
    });

  const ready = phase.kind === "ready" && machine;
  const status = !ready ? "loading" : running ? "running" : "paused";

  return (
    <>
      <header class="header">
        <h1>livelinux<small>Linux i386 in v86</small></h1>
        <div class="controls">
          <button class="primary" disabled={!ready || !!busy} onClick={toggle}>
            {running ? "Pause" : "Run"}
          </button>
          <button disabled={!ready || !!busy} onClick={snapshot}>Snapshot</button>
          <button disabled={!ready || !!busy || !hasSnapshot} onClick={restore}>Restore</button>
        </div>
        <span class={"badge " + status}>{status}</span>
        <span class="spacer" />
        {toast && <span class="stat">{toast}</span>}
        {ready && (
          <>
            <span class="stat" title="instructions executed by the emulated CPU">
              instructions: <b data-testid="instr-count">{instrs.toLocaleString("en-US")}</b>
            </span>
            {running && (
              <span class="stat" data-testid="ips">
                <b>{fmtCount(ips)}</b> instr/s
              </span>
            )}
          </>
        )}
      </header>
      {ready ? (
        <main class="main">
          <div class="pane">
            <div class="pane-title">Serial console (ttyS0)</div>
            <Console machine={machine} />
          </div>
          <div class="pane">
            <div class="pane-title">Inspector</div>
            <Inspector machine={machine} running={running} prog={prog} progError={progError} generation={generation} />
          </div>
        </main>
      ) : (
        <main class="main" style={{ display: "flex" }}>
          <Loading phase={phase} />
        </main>
      )}
    </>
  );
}
