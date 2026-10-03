import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { LiveTabProps } from "../../app/types";
import { buildLayout, type Layout, type LayoutMode } from "../../live/layout";
import { describePage, type PageDetails } from "../../live/pageinfo";
import { KIND_INFO, PageKind, type PhysSnapshot } from "../../live/physmap";
import { KV, Section } from "../common";
import { useSelection } from "../selection";
import { fmtHex, fmtSize } from "../util";
import "./ram.css";

type RGB = [number, number, number];

/** Per-kind colors; free memory follows the theme so used memory stands out. */
function palette(dark: boolean): RGB[] {
  const p: RGB[] = [];
  p[PageKind.None] = dark ? [11, 14, 19] : [246, 247, 249];
  p[PageKind.Free] = dark ? [30, 37, 48] : [226, 230, 237];
  p[PageKind.FreePcp] = dark ? [44, 56, 74] : [204, 213, 228];
  p[PageKind.KernelText] = [124, 58, 237];
  p[PageKind.KernelRodata] = [157, 108, 240];
  p[PageKind.KernelData] = [186, 145, 245];
  p[PageKind.KernelBss] = [214, 188, 250];
  p[PageKind.Reserved] = dark ? [88, 96, 110] : [140, 148, 162];
  p[PageKind.Slab] = [245, 158, 11];
  p[PageKind.PageTable] = [239, 68, 68];
  p[PageKind.Anon] = [16, 185, 129];
  p[PageKind.File] = [59, 130, 246];
  p[PageKind.KernelStack] = [236, 72, 153];
  p[PageKind.Kernel] = [194, 120, 50];
  p[PageKind.Other] = [100, 116, 139];
  return p;
}

const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

const INTERVALS = [100, 250, 1000];
/** Legend order: used memory first, free last. */
const LEGEND: PageKind[] = [
  PageKind.Anon, PageKind.File, PageKind.Slab, PageKind.PageTable, PageKind.KernelStack, PageKind.Kernel,
  PageKind.KernelText, PageKind.KernelRodata, PageKind.KernelData, PageKind.KernelBss,
  PageKind.Reserved, PageKind.Other, PageKind.FreePcp, PageKind.Free,
];

/** What lights up together with the hovered page: same file / slab cache / anon_vma, or same free block. */
function groupOf(snap: PhysSnapshot, pfn: number): ((p: number) => boolean) | null {
  const k = snap.kind[pfn];
  const aux = snap.aux[pfn];
  if ((k === PageKind.File || k === PageKind.Slab || k === PageKind.Anon) && aux) {
    return (p) => snap.aux[p] === aux && snap.kind[p] === k;
  }
  if (k === PageKind.Free || k === PageKind.FreePcp) {
    const size = 1 << snap.order[pfn];
    const start = pfn - (pfn % size); // buddy blocks are naturally aligned
    return (p) => p >= start && p < start + size;
  }
  return null;
}

export function RamTab({ live, running }: LiveTabProps) {
  const [mode, setMode] = useState<LayoutMode>("hilbert");
  const [interval, setIntervalMs] = useState(live.ramIntervalMs);
  const [focusKind, setFocusKind] = useState<PageKind | null>(null);
  const sel = useSelection();
  const focusPid = sel.pid;
  const [hoverPfn, setHoverPfn] = useState<number | null>(null);
  const [pinnedPfn, setPinnedPfn] = useState<number | null>(null);
  const [snap, setSnap] = useState<PhysSnapshot | null>(live.ram);
  const [error, setError] = useState<string | null>(live.ramError);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dark = useMemo(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false, []);
  const pal = useMemo(() => palette(dark), [dark]);

  // Subscribe to snapshots. UI state updates are throttled to the snapshot rate; the canvas is
  // driven by requestAnimationFrame below.
  useEffect(() => {
    const off = live.subscribeRam(() => {
      setSnap(live.ram);
      setError(live.ramError);
    });
    setSnap(live.ram);
    return off;
  }, [live]);

  // When the VM stops there are no more slices: take one snapshot of the paused state.
  useEffect(() => {
    if (!running) live.collectRam(false);
  }, [running, live]);

  useEffect(() => {
    live.ramIntervalMs = interval;
  }, [interval, live]);

  const layout = useMemo<Layout | null>(() => (snap ? buildLayout(snap.nPages, mode) : null), [snap?.nPages, mode]);

  // Mutable render state shared with the rAF loop.
  const st = useRef({
    heat: new Float32Array(0),
    lastVersion: -1,
    image: null as ImageData | null,
    dirty: true,
  });
  const focusRef = useRef({ focusKind, focusPid, hoverPfn: pinnedPfn ?? hoverPfn });
  focusRef.current = { focusKind, focusPid, hoverPfn: pinnedPfn ?? hoverPfn };
  useEffect(() => {
    st.current.dirty = true;
  }, [focusKind, focusPid, hoverPfn, pinnedPfn, layout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const s = st.current;
    s.image = ctx.createImageData(layout.width, layout.height);
    s.dirty = true;
    let raf = 0;
    let lastFrame = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const cur = live.ram;
      if (!cur || cur.nPages !== layout.pixelOf.length) return;
      const n = cur.nPages;
      if (s.heat.length !== n) s.heat = new Float32Array(n);
      const heat = s.heat;

      // New snapshot: pages whose use changed start glowing.
      if (live.ramVersion !== s.lastVersion) {
        const prev = live.prevRam;
        if (prev && prev.nPages === n && s.lastVersion !== -1) {
          for (let i = 0; i < n; i++) if (prev.kind[i] !== cur.kind[i]) heat[i] = 1;
        }
        s.lastVersion = live.ramVersion;
        s.dirty = true;
      }
      // Exponential fade (~0.6 s half-life).
      const dt = Math.min(100, now - lastFrame);
      lastFrame = now;
      const decay = Math.pow(0.5, dt / 600);
      let anyHeat = false;
      for (let i = 0; i < n; i++) {
        if (heat[i] > 0.01) {
          heat[i] *= decay;
          anyHeat = true;
        } else if (heat[i] !== 0) {
          heat[i] = 0;
          anyHeat = true;
        }
      }
      if (!s.dirty && !anyHeat) return;
      s.dirty = false;

      const { focusKind: fk, focusPid: fp, hoverPfn: hp } = focusRef.current;
      let pidSet: Set<number> | null = null;
      if (fp !== null) {
        pidSet = new Set();
        for (const [pfn, os] of cur.owners) if (os.some((o) => o.pid === fp)) pidSet.add(pfn);
      }
      const inGroup = hp !== null && hp < n ? groupOf(cur, hp) : null;
      const img = s.image!;
      const data = img.data;
      const bg = pal[PageKind.None];
      for (let px = 0; px < layout.pfnAt.length; px++) {
        const o = px * 4;
        const pfn = layout.pfnAt[px];
        if (pfn < 0) {
          data[o] = bg[0];
          data[o + 1] = bg[1];
          data[o + 2] = bg[2];
          data[o + 3] = 255;
          continue;
        }
        const k = cur.kind[pfn];
        let [r, g, b] = pal[k];
        const dim = (fk !== null && k !== fk) || (pidSet !== null && !pidSet.has(pfn));
        if (dim) {
          r = (r + 3 * bg[0]) >> 2;
          g = (g + 3 * bg[1]) >> 2;
          b = (b + 3 * bg[2]) >> 2;
        }
        let w = heat[pfn] * 0.85;
        if (inGroup && inGroup(pfn)) w = Math.max(w, pfn === hp ? 1 : 0.55);
        if (w > 0) {
          const t = dark ? 255 : 20; // glow toward white in dark mode, toward black in light mode
          r += (t - r) * w;
          g += (t - g) * w;
          b += (t - b) * w;
        }
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [layout, live, pal, dark]);

  const pfnFromEvent = (e: MouseEvent): number | null => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return null;
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * layout.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * layout.height);
    if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return null;
    const pfn = layout.pfnAt[y * layout.width + x];
    return pfn >= 0 ? pfn : null;
  };

  const selected = pinnedPfn ?? hoverPfn;
  const details = useMemo<PageDetails | null>(() => {
    if (selected === null || !snap || !live.mapper || selected >= snap.nPages) return null;
    try {
      return describePage(live.prog, live.mapper, snap, selected);
    } catch {
      return null;
    }
  }, [selected, snap, live]);

  const procs = useMemo(() => {
    if (!snap) return [];
    const pages = new Map<number, number>();
    for (const os of snap.owners.values()) {
      for (const pid of new Set(os.filter((o) => o.what === "user").map((o) => o.pid))) pages.set(pid, (pages.get(pid) ?? 0) + 1);
    }
    return [...pages.entries()]
      .map(([pid, n]) => ({ pid, n, comm: snap.tasks.get(pid) ?? "?" }))
      .sort((a, b) => b.n - a.n);
  }, [snap]);

  if (!snap || !layout) {
    return <div class="muted">{error ? `Waiting for the kernel: ${error}` : "Taking first snapshot…"}</div>;
  }

  const total = snap.nPages;
  const used = total - snap.counts[PageKind.Free] - snap.counts[PageKind.FreePcp];
  const age = (performance.now() - snap.time) / 1000;

  return (
    <>
      <Section
        title={`Physical memory · ${fmtSize(total * 4096)} · ${total.toLocaleString("en-US")} page frames`}
        right={
          <span class="ram-controls">
            {(["hilbert", "linear"] as const).map((m) => (
              <button class={"chip" + (mode === m ? " active" : "")} onClick={() => setMode(m)} title={m === "hilbert" ? "Hilbert curve: contiguous memory stays together" : "one row per MiB"}>
                {m}
              </button>
            ))}
          </span>
        }
      >
        <div class="ram-wrap">
          <canvas
            ref={canvasRef}
            class="ram-canvas"
            data-testid="ram-canvas"
            onMouseMove={(e) => setHoverPfn(pfnFromEvent(e as unknown as MouseEvent))}
            onMouseLeave={() => setHoverPfn(null)}
            onClick={(e) => {
              const p = pfnFromEvent(e as unknown as MouseEvent);
              setPinnedPfn(p === pinnedPfn ? null : p);
            }}
          />
          <div class="ram-side">
            <div class="ram-usage">
              <b>{fmtSize(used * 4096)}</b> in use ({((used / total) * 100).toFixed(1)}%)
            </div>
            <div class="ram-bar" title="composition of RAM">
              {LEGEND.map((k) =>
                snap.counts[k] ? (
                  <span style={{ flexGrow: snap.counts[k], background: css(pal[k]) }} title={`${KIND_INFO[k].name}: ${fmtSize(snap.counts[k] * 4096)}`} />
                ) : null,
              )}
            </div>
            <ul class="ram-legend">
              {LEGEND.filter((k) => snap.counts[k] > 0 || k === PageKind.Free).map((k) => (
                <li
                  class={focusKind === k ? "active" : focusKind !== null ? "faded" : ""}
                  onClick={() => setFocusKind(focusKind === k ? null : k)}
                  title={KIND_INFO[k].desc + " — click to highlight"}
                >
                  <span class="sw" style={{ background: css(pal[k]) }} />
                  <span class="nm">{KIND_INFO[k].name}</span>
                  <span class="sz">{fmtSize(snap.counts[k] * 4096)}</span>
                </li>
              ))}
            </ul>
            <label class="ram-proc">
              process{" "}
              <select
                value={focusPid ?? ""}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  const pid = v === "" ? null : Number(v);
                  sel.select(pid, pid === null ? undefined : snap.tasks.get(pid));
                }}
              >
                <option value="">all</option>
                {focusPid !== null && !procs.some((p) => p.pid === focusPid) && (
                  <option value={focusPid}>{snap.tasks.get(focusPid) ?? sel.comm ?? "?"} ({focusPid}) · no user pages</option>
                )}
                {procs.map((p) => (
                  <option value={p.pid}>
                    {p.comm} ({p.pid}) · {fmtSize(p.n * 4096)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div class="ram-status muted">
          {running ? (
            <>
              live · every{" "}
              <select value={interval} onChange={(e) => setIntervalMs(Number((e.target as HTMLSelectElement).value))}>
                {INTERVALS.map((ms) => (
                  <option value={ms}>{ms} ms</option>
                ))}
              </select>{" "}
            </>
          ) : (
            "paused · "
          )}
          scan {snap.durationMs.toFixed(1)} ms · age {age.toFixed(1)} s{snap.torn ? " · taken mid-kernel (may be inconsistent)" : ""}
          {error ? ` · last error: ${error}` : ""}
        </div>
      </Section>
      <Section title={pinnedPfn !== null ? "Page frame (pinned; click again to unpin)" : "Page frame (hover the map, click to pin)"}>
        {details ? <PageCard d={details} color={css(pal[details.kind])} /> : <div class="muted">Hover a pixel: each one is a 4 KiB page frame.</div>}
      </Section>
    </>
  );
}

function PageCard({ d, color }: { d: PageDetails; color: string }) {
  const rows: [string, preact.ComponentChildren][] = [
    ["frame", <>pfn {d.pfn} · phys {fmtHex(d.pa)}</>],
    ["use", <><span class="sw-inline" style={{ background: color }} /> {d.kindName}</>],
  ];
  if (d.what) rows.push(["what", d.what]);
  if (d.owners.length) {
    rows.push([
      "owners",
      <ul class="ram-owners">
        {d.owners.slice(0, 8).map((o) => <li>{o}</li>)}
        {d.owners.length > 8 && <li class="muted">+{d.owners.length - 8} more</li>}
      </ul>,
    ]);
  }
  rows.push(["refcount", `${d.refcount}${d.mapcount > 0 ? ` · mapped ${d.mapcount}×` : ""}${d.order ? ` · order ${d.order}` : ""}`]);
  rows.push(["flags", d.flags.length ? d.flags.join(" ") : <span class="muted">none</span>]);
  return <KV rows={rows} />;
}

