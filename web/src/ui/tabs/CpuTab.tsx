import { useEffect, useRef, useState } from "preact/hooks";
import type { LiveTabProps } from "../../app/types";
import {
  COL_IDLE,
  COL_NONE,
  MODE_IDLE,
  MODE_KERNEL,
  MODE_USER,
  buildColumns,
  computeStats,
  findAt,
  latestTime,
  taskColor,
  taskLabel,
  type CpuStats,
} from "../../live/cpuStats";
import { ErrorBox, Section } from "../common";
import { useSelection } from "../selection";
import "./cpu.css";

interface WindowOpt {
  ms: number;
  label: string;
  /** axis tick spacing */
  tick: number;
}

const WINDOWS: WindowOpt[] = [
  { ms: 1000, label: "1 s", tick: 200 },
  { ms: 10000, label: "10 s", tick: 1000 },
  { ms: 60000, label: "60 s", tick: 10000 },
];

const LANE_TASK = 48;
const LANE_GAP = 4;
const LANE_MODE = 10;
const AXIS_H = 16;
const CANVAS_H = LANE_TASK + LANE_GAP + LANE_MODE + AXIS_H;
const STATS_INTERVAL_MS = 250;

interface Theme {
  panel: string;
  idle: string;
  muted: string;
  user: string;
  kernel: string;
  text: string;
  mono: string;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    panel: v("--panel", "#ffffff"),
    idle: v("--border", "#d5d9e0"),
    muted: v("--muted", "#667085"),
    user: v("--user", "#0e7490"),
    kernel: v("--kernel", "#7c3aed"),
    text: v("--text", "#1c2128"),
    mono: v("--mono", "monospace"),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.001 ? 2 : 1)}%`;

function fmtAxis(ms: number): string {
  return `-${Number((ms / 1000).toFixed(1))}s`;
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function CpuTab({ live, running }: LiveTabProps) {
  const [windowMs, setWindowMs] = useState(10000);
  const [stats, setStats] = useState<CpuStats | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const winRef = useRef(windowMs);
  const runRef = useRef(running);
  const hoverRef = useRef<number | null>(null);
  const forceRef = useRef(true);
  const sel = useSelection();
  const selRef = useRef(sel);
  selRef.current = sel;
  winRef.current = windowMs;
  runRef.current = running;

  // Recording only happens while subscribed.
  useEffect(() => live.subscribeCpu(), [live]);

  // Timeline: redraw on animation frames, but only when something visible would change.
  useEffect(() => {
    forceRef.current = true;
  }, [windowMs, running, sel.pid]);

  useEffect(() => {
    const trace = live.cpu;
    const symbols = live.prog.symbols;
    let raf = 0;
    let lastTo = -Infinity;
    let lastTotal = -1;
    let lastWin = 0;
    let lastW = 0;
    let theme: Theme | null = null;
    let themeAt = -Infinity;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cssW = Math.floor(canvas.clientWidth);
      if (cssW <= 0) return;
      const win = winRef.current;
      const run = runRef.current;
      const now = performance.now();
      const to = run ? now : latestTime(trace);
      const msPerPx = win / cssW;
      if (!forceRef.current) {
        const same = win === lastWin && cssW === lastW;
        if (run) {
          if (same && to - lastTo < msPerPx) return;
        } else if (same && trace.total === lastTotal) {
          return;
        }
      }
      forceRef.current = false;
      lastTo = to;
      lastTotal = trace.total;
      lastWin = win;
      lastW = cssW;

      if (!theme || now - themeAt > 500) {
        theme = readTheme();
        themeAt = now;
      }
      const th = theme;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(cssW * dpr);
      const ph = Math.round(CANVAS_H * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, CANVAS_H);

      const from = to - win;
      const yMode = LANE_TASK + LANE_GAP;
      const yAxis = yMode + LANE_MODE;
      ctx.fillStyle = th.panel;
      ctx.fillRect(0, 0, cssW, LANE_TASK);
      ctx.fillRect(0, yMode, cssW, LANE_MODE);

      if (trace.count > 0) {
        const cols = buildColumns(trace, from, to, cssW);
        const colorCache = new Map<number, string>();
        const selPid = selRef.current.pid;
        const runs = (arr: ArrayLike<number>, y: number, h: number, fill: (v: number) => boolean) => {
          let c = 0;
          while (c < cssW) {
            const v = arr[c];
            let e = c + 1;
            while (e < cssW && arr[e] === v) e++;
            if (fill(v)) ctx.fillRect(c, y, e - c, h);
            c = e;
          }
          ctx.globalAlpha = 1;
        };
        runs(cols.task, 0, LANE_TASK, (v) => {
          if (v === COL_NONE) return false;
          if (v === COL_IDLE) {
            ctx.globalAlpha = selPid === null ? 1 : 0.5;
            ctx.fillStyle = th.idle;
            return true;
          }
          // With a process selected, everything else fades so its slices stand out.
          ctx.globalAlpha = selPid === null || trace.tasks.get(v)?.pid === selPid ? 1 : 0.18;
          let col = colorCache.get(v);
          if (!col) {
            col = taskColor(trace.tasks.get(v)?.pid ?? -1);
            colorCache.set(v, col);
          }
          ctx.fillStyle = col;
          return true;
        });
        runs(cols.mode, yMode, LANE_MODE, (v) => {
          ctx.globalAlpha = 1;
          if (v === MODE_USER) ctx.fillStyle = th.user;
          else if (v === MODE_KERNEL) ctx.fillStyle = th.kernel;
          else if (v === MODE_IDLE) {
            ctx.fillStyle = th.muted;
            ctx.globalAlpha = 0.3;
          } else return false;
          return true;
        });
      } else {
        ctx.fillStyle = th.muted;
        ctx.font = `11px ${th.mono}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("no samples yet", cssW / 2, LANE_TASK / 2);
      }

      // time axis, relative to "now"
      const opt = WINDOWS.find((w) => w.ms === win);
      const step = opt?.tick ?? win / 10;
      const n = Math.round(win / step);
      ctx.strokeStyle = th.muted;
      ctx.fillStyle = th.muted;
      ctx.lineWidth = 1;
      ctx.font = `10px ${th.mono}`;
      ctx.textBaseline = "top";
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const x = Math.round(cssW - (k * step * cssW) / win);
        const xl = Math.min(cssW - 0.5, Math.max(0.5, x - 0.5));
        ctx.moveTo(xl, yAxis);
        ctx.lineTo(xl, yAxis + 3);
        ctx.textAlign = k === 0 ? "right" : k === n ? "left" : "center";
        ctx.fillText(k === 0 ? "now" : fmtAxis(k * step), k === 0 ? cssW : k === n ? 0 : x, yAxis + 4);
      }
      ctx.stroke();

      // hover cursor + tooltip
      const tip = tipRef.current;
      const hx = hoverRef.current;
      if (hx !== null && tip) {
        const t = from + (hx / cssW) * win;
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = th.text;
        ctx.beginPath();
        ctx.moveTo(Math.round(hx) + 0.5, 0);
        ctx.lineTo(Math.round(hx) + 0.5, yAxis);
        ctx.stroke();
        ctx.globalAlpha = 1;
        tip.textContent = describe(t, to);
        tip.style.display = "block";
        if (hx > cssW * 0.55) {
          tip.style.left = `${hx - 12}px`;
          tip.style.transform = "translateX(-100%)";
        } else {
          tip.style.left = `${hx + 12}px`;
          tip.style.transform = "none";
        }
      } else if (tip) {
        tip.style.display = "none";
      }
    };

    const describe = (t: number, to: number): string => {
      const rel = `${((t - to) / 1000).toFixed(3)} s`;
      const p = findAt(trace, t);
      switch (p.kind) {
        case "none":
          return `${rel}\nno data`;
        case "overhead":
          return `${rel}\nemulator overhead (guest not running)`;
        case "idle-gap":
          return `${rel}\nidle (guest halted, waiting for an event)`;
        case "slice": {
          const l = taskLabel(trace, p.task);
          if (p.halted) return `${rel}\nidle (halted) after ${l.comm} (pid ${l.pid})`;
          const where = p.user ? `user, eip ${(p.eip >>> 0).toString(16)}` : `kernel, ${symbols.format(p.eip)}`;
          return `${rel}\n${l.comm} (pid ${l.pid})\n${where}\n${p.durMs.toFixed(2)} ms, ${fmtCount(p.instrs)} instr`;
        }
      }
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw();
    };
    raf = requestAnimationFrame(frame);

    const canvas = canvasRef.current;
    const onMove = (e: MouseEvent) => {
      if (!canvas) return;
      hoverRef.current = e.clientX - canvas.getBoundingClientRect().left;
      forceRef.current = true;
      if (!runRef.current) draw();
    };
    // Click a slice to select its task everywhere.
    const onClick = (e: MouseEvent) => {
      if (!canvas) return;
      const cssW = canvas.clientWidth;
      const to = runRef.current ? performance.now() : latestTime(trace);
      const t = to - winRef.current + ((e.clientX - canvas.getBoundingClientRect().left) / cssW) * winRef.current;
      const p = findAt(trace, t);
      if (p.kind !== "slice" || p.halted) return;
      const l = taskLabel(trace, p.task);
      if (l.pid >= 0) selRef.current.toggle(l.pid, l.comm);
    };
    const onLeave = () => {
      hoverRef.current = null;
      forceRef.current = true;
      if (!runRef.current) draw();
    };
    canvas?.addEventListener("mousemove", onMove);
    canvas?.addEventListener("mouseleave", onLeave);
    canvas?.addEventListener("click", onClick);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => (forceRef.current = true)) : null;
    if (canvas) ro?.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      canvas?.removeEventListener("mousemove", onMove);
      canvas?.removeEventListener("mouseleave", onLeave);
      canvas?.removeEventListener("click", onClick);
      ro?.disconnect();
    };
  }, [live]);

  // Stats: a few times per second, not per frame.
  useEffect(() => {
    const trace = live.cpu;
    let lastTotal = -1;
    const tick = () => {
      if (!runRef.current && trace.total === lastTotal) return;
      lastTotal = trace.total;
      const to = runRef.current ? performance.now() : latestTime(trace);
      setStats(computeStats(trace, to, winRef.current, live.prog.symbols));
    };
    lastTotal = -1;
    tick();
    const id = setInterval(tick, STATS_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live, windowMs, running]);

  const winLabel = WINDOWS.find((w) => w.ms === windowMs)?.label ?? `${windowMs / 1000} s`;

  return (
    <>
      {live.cpuError && <ErrorBox error={live.cpuError} />}
      <Section
        title="CPU timeline"
        right={
          <span class="cpu-windows">
            {WINDOWS.map((w) => (
              <button
                key={w.ms}
                class={"chip" + (w.ms === windowMs ? " primary" : "")}
                onClick={() => setWindowMs(w.ms)}
              >
                {w.label}
              </button>
            ))}
          </span>
        }
      >
        <div class="cpu-canvas-wrap">
          <canvas ref={canvasRef} class="cpu-canvas" style={{ height: `${CANVAS_H}px` }} />
          <div ref={tipRef} class="cpu-tip" />
        </div>
        <div class="cpu-legend muted">
          top: task on the CPU (colour per pid; click to select), blank = emulator overhead; bottom:{" "}
          <span class="user">user</span> / <span class="kernel">kernel</span> / idle
          {!running && " · paused"}
        </div>
      </Section>

      {stats && <Summary s={stats} win={winLabel} windowMs={windowMs} />}
      {stats && <TaskShares s={stats} />}
      {stats && <HotSpots s={stats} />}
    </>
  );
}

function Summary({ s, win, windowMs }: { s: CpuStats; win: string; windowMs: number }) {
  const tiles: [string, string, string?][] = [
    ["user", pct(s.user), "user"],
    ["kernel", pct(s.kernel), "kernel"],
    ["idle", pct(s.idle)],
    ["overhead", pct(s.overhead)],
    ["slices/s", s.slicesPerSec.toFixed(0)],
    ["guest MIPS", s.mips.toFixed(1)],
  ];
  return (
    <Section title="Summary" right={`last ${win}${s.spanMs < 0.95 * windowMs ? ` (${(s.spanMs / 1000).toFixed(1)} s recorded)` : ""}`}>
      <div class="cpu-stack" title="user / kernel / idle / emulator overhead">
        <div style={{ width: `${s.user * 100}%`, background: "var(--user)" }} />
        <div style={{ width: `${s.kernel * 100}%`, background: "var(--kernel)" }} />
        <div style={{ width: `${s.idle * 100}%`, background: "var(--muted)", opacity: 0.35 }} />
      </div>
      <div class="cpu-tiles">
        {tiles.map(([k, v, cls]) => (
          <div class="cpu-tile" key={k}>
            <div class={"cpu-tile-v" + (cls ? ` ${cls}` : "")}>{v}</div>
            <div class="muted">{k}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TaskShares({ s }: { s: CpuStats }) {
  const sel = useSelection();
  interface Row {
    key: string;
    pid: number;
    color: string;
    label: string;
    sub: string;
    share: number;
    muted?: boolean;
  }
  const rows: Row[] = s.tasks.map((t) => ({
    key: String(t.addr),
    pid: t.pid,
    color: taskColor(t.pid),
    label: t.comm,
    sub: t.pid >= 0 ? `pid ${t.pid}` : "",
    share: t.share,
  }));
  rows.push({ key: "idle", pid: -1, color: "var(--border)", label: "idle", sub: "halted", share: s.idle, muted: true });
  rows.sort((a, b) => b.share - a.share);
  const max = Math.max(...rows.map((r) => r.share), 0.0001);
  const more = s.taskCount - s.tasks.length;
  return (
    <Section title="Task share" right="fraction of wall time on the CPU">
      <div class="cpu-rows">
        {rows.map((r) => (
          <div
            class={"cpu-row" + (r.muted ? " muted" : "") + (r.pid >= 0 ? " clickable" : "") + (r.pid >= 0 && r.pid === sel.pid ? " selected" : "")}
            key={r.key}
            onClick={() => r.pid >= 0 && sel.toggle(r.pid, r.label)}
          >
            <span class="cpu-swatch" style={{ background: r.color }} />
            <span class="cpu-name" title={`${r.label} ${r.sub}`}>
              {r.label} <span class="muted">{r.sub}</span>
            </span>
            <span class="cpu-bar">
              <span style={{ width: `${(r.share / max) * 100}%`, background: r.color }} />
            </span>
            <span class="cpu-val">{pct(r.share)}</span>
          </div>
        ))}
        {!s.tasks.length && <div class="muted">no task ran in this window</div>}
        {more > 0 && <div class="muted">+{more} more task{more === 1 ? "" : "s"}</div>}
      </div>
    </Section>
  );
}

function HotSpots({ s }: { s: CpuStats }) {
  const max = s.funcs.length ? s.funcs[0].share : 1;
  return (
    <Section title="Kernel hot spots" right="kernel EIP samples at slice end">
      <div class="cpu-rows">
        {s.funcs.map((f) => (
          <div class="cpu-row cpu-row-fn" key={f.name}>
            <span class="cpu-name kernel" title={f.name}>{f.name}</span>
            <span class="cpu-bar">
              <span style={{ width: `${(f.share / max) * 100}%`, background: "var(--kernel)" }} />
            </span>
            <span class="cpu-val">{pct(f.share)}</span>
            <span class="cpu-val muted">{f.ms.toFixed(0)} ms</span>
          </div>
        ))}
        {!s.funcs.length && <div class="muted">no kernel-mode samples in this window</div>}
      </div>
      <div class="muted cpu-note">
        {s.kernelSamples} samples ({s.kernelBusyMs.toFixed(0)} ms of non-halted kernel time). Samples are taken at slice
        boundaries (~1 ms) and weighted by slice duration, so this is a statistical profile, not a trace.
      </div>
    </Section>
  );
}
