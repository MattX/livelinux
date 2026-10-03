// A process's address space drawn page by page: an overview strip of 0..3 GiB, then one grid per
// VMA where every cell is a 4 KiB page, coloured by what backs it (demand paging, page cache,
// anonymous memory, copy-on-write after fork, ...). Cells flash when their frame changes, so
// page faults and COW breaks are visible while the VM runs.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Program } from "../debug/api";
import {
  NUM_PAGE_USES, PAGE_USE_INFO, PageUse, PTE_ACCESSED, PTE_DIRTY, PTE_PRESENT, PTE_RW, PTE_USER,
  whoMaps, type FrameMapping, type VmaPages,
} from "../debug/helpers";
import { taskColor } from "../live/cpuStats";
import { attempt } from "./hooks";
import { useSelection } from "./selection";
import { fmtHex, fmtSize } from "./util";
import "./aspace.css";

type RGB = [number, number, number];

function palette(dark: boolean): RGB[] {
  const p: RGB[] = [];
  p[PageUse.Absent] = dark ? [30, 37, 48] : [228, 232, 238];
  p[PageUse.File] = dark ? [96, 140, 210] : [147, 190, 250];
  p[PageUse.FileShared] = [59, 130, 246];
  p[PageUse.Anon] = [16, 185, 129];
  p[PageUse.Cow] = [249, 115, 22];
  p[PageUse.WriteProtected] = [234, 179, 8];
  p[PageUse.Zero] = dark ? [110, 118, 130] : [160, 168, 180];
  p[PageUse.ProtNone] = [190, 60, 60];
  return p;
}
const css = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Legend / aggregation priority: the most interesting use wins when a cell stands for several pages. */
const PRIORITY: PageUse[] = [
  PageUse.Cow, PageUse.WriteProtected, PageUse.Anon, PageUse.FileShared, PageUse.File, PageUse.Zero, PageUse.ProtNone, PageUse.Absent,
];
const RANK = new Array<number>(NUM_PAGE_USES);
PRIORITY.forEach((u, i) => (RANK[u] = i));

const CELL = 8;
const GAP = 1;
const PITCH = CELL + GAP;
/** Above this many pages a cell stands for several pages. */
const MAX_CELLS = 4096;
const USER_TOP = 0xc0000000;

function vmaLabel(p: VmaPages): string {
  return p.vma.name ?? "[anon]";
}

function pteFlags(e: number): string {
  if (!(e & PTE_PRESENT)) return e ? `not present (${fmtHex(e)})` : "none";
  return [e & PTE_RW ? "RW" : "RO", e & PTE_USER ? "U" : "S", e & PTE_ACCESSED ? "A" : "", e & PTE_DIRTY ? "D" : ""].filter(Boolean).join(" ");
}

interface Pinned {
  vma: number;
  index: number;
  holders: FrameMapping[] | null;
  error?: string;
}

export function AddressSpaceView({ prog, pages }: { prog: Program; pages: VmaPages[] }) {
  const dark = useMemo(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false, []);
  const pal = useMemo(() => palette(dark), [dark]);
  const sel = useSelection();
  const [hover, setHover] = useState<{ vma: number; index: number } | null>(null);
  const [pinned, setPinned] = useState<Pinned | null>(null);
  const [showBits, setShowBits] = useState(false);
  const [cols, setCols] = useState(64);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCols(Math.max(16, Math.floor((el.clientWidth - 2) / PITCH))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totals = useMemo(() => {
    const t = new Array<number>(NUM_PAGE_USES).fill(0);
    for (const p of pages) p.counts.forEach((n, u) => (t[u] += n));
    return t;
  }, [pages]);

  // Re-read who maps the pinned frame whenever the data refreshes.
  const pinnedFrame = pinned ? pages[pinned.vma]?.pte[pinned.index] : undefined;
  useEffect(() => {
    if (!pinned) return;
    const e = pinnedFrame ?? 0;
    if (!(e & PTE_PRESENT)) {
      if (pinned.holders !== null) setPinned({ ...pinned, holders: null });
      return;
    }
    const r = attempt(() => whoMaps(prog, e >>> 12));
    setPinned({ ...pinned, holders: r.ok ? r.value : [], error: r.ok ? undefined : r.error });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned?.vma, pinned?.index, pinnedFrame, pages]);

  const focus = pinned ?? hover;
  const fp = focus ? pages[focus.vma] : undefined;
  const fe = fp ? fp.pte[focus!.index] ?? 0 : 0;

  return (
    <div class="aspace" ref={wrapRef}>
      <Strip pages={pages} pal={pal} />
      <div class="aspace-legend">
        {PRIORITY.filter((u) => totals[u] > 0 || u === PageUse.Cow).map((u) => (
          <span key={u} title={PAGE_USE_INFO[u].desc}>
            <span class={"sw" + (u === PageUse.Absent ? " absent" : "")} style={{ background: css(pal[u]) }} />
            {PAGE_USE_INFO[u].name} <span class="muted">{totals[u]}</span>
          </span>
        ))}
        <label class="aspace-bits" title="Mark pages whose PTE has the dirty bit (written) or no accessed bit">
          <input type="checkbox" checked={showBits} onChange={(e) => setShowBits((e.target as HTMLInputElement).checked)} /> A/D bits
        </label>
      </div>
      {pages.map((p, vi) => (
        <div class="aspace-vma" key={p.vma.addr} id={`vma-${p.vma.start.toString(16)}`}>
          <div class="aspace-head">
            <span class="aspace-name" title={p.vma.file ?? ""}>{vmaLabel(p)}</span>
            <span class="muted">
              {fmtHex(p.vma.start)}–{fmtHex(p.vma.end)} {p.vma.flagsStr} · {fmtSize(p.vma.end - p.vma.start)}
            </span>
            <span class="aspace-res">
              {p.use.length - p.counts[PageUse.Absent] - p.counts[PageUse.ProtNone]}/{p.use.length} present
              {p.counts[PageUse.Cow] > 0 && <span class="cow"> · {p.counts[PageUse.Cow]} COW</span>}
              {p.truncated && <span class="muted"> · first {p.use.length} pages</span>}
              {p.use.length > MAX_CELLS && <span class="muted"> · 1 cell = {Math.ceil(p.use.length / MAX_CELLS)} pages</span>}
            </span>
          </div>
          <PageGrid
            p={p}
            cols={cols}
            pal={pal}
            dark={dark}
            showBits={showBits}
            mark={focus && focus.vma === vi ? focus.index : -1}
            onHover={(i) => setHover(i === null ? null : { vma: vi, index: i })}
            onPick={(i) => setPinned(pinned && pinned.vma === vi && pinned.index === i ? null : { vma: vi, index: i, holders: null })}
          />
        </div>
      ))}
      <div class="aspace-card">
        {fp && focus ? (
          <>
            <div>
              <b>{fmtHex((fp.vma.start + focus.index * 4096) >>> 0)}</b> <span class="muted">in {vmaLabel(fp)}</span>
              {pinned ? <span class="muted"> · pinned (click again to unpin)</span> : <span class="muted"> · click to pin</span>}
            </div>
            <div>
              <span class="sw" style={{ background: css(pal[fp.use[focus.index]]) }} /> <b>{PAGE_USE_INFO[fp.use[focus.index]].name}</b>
              <span class="muted"> — {PAGE_USE_INFO[fp.use[focus.index]].desc}</span>
            </div>
            <div class="muted">
              PTE {pteFlags(fe)}
              {fe & PTE_PRESENT ? ` · frame pfn ${fe >>> 12} (phys ${fmtHex((fe & 0xfffff000) >>> 0)}) · mapcount ${fp.mapcount[focus.index]}` : ""}
            </div>
            {pinned && pinned.holders && (
              <div class="aspace-holders">
                mapped by{" "}
                {pinned.holders.map((h) => (
                  <button
                    class={"chip" + (sel.pid === h.pid ? " active" : "")}
                    onClick={() => sel.select(h.pid, h.comm)}
                    title="select this process"
                  >
                    <span class="sw" style={{ background: taskColor(h.pid) }} /> {h.comm} {h.pid} @ {fmtHex(h.va)} {h.writable ? "RW" : "RO"}
                  </button>
                ))}
                {pinned.error && <span class="error">{pinned.error}</span>}
              </div>
            )}
          </>
        ) : (
          <span class="muted">
            Each cell is a 4 KiB page of a VMA. Hover for its PTE and frame; click to pin and see every process mapping the same frame.
            Run <code>/demo/forker</code> and compare a child's pages with its parent's: written pages turn from copy-on-write to private.
          </span>
        )}
      </div>
    </div>
  );
}

/** 0..3 GiB at a linear scale, VMAs at least a few pixels wide; click one to scroll to its grid. */
function Strip({ pages, pal }: { pages: VmaPages[]; pal: RGB[] }) {
  const scrollTo = (p: VmaPages) =>
    document.getElementById(`vma-${p.vma.start.toString(16)}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return (
    <div class="aspace-strip" title="user address space, 0 – 3 GiB">
      {pages.map((p) => {
        let best = PageUse.Absent;
        for (const u of PRIORITY) if (p.counts[u] > 0) {
          best = u;
          break;
        }
        return (
          <span
            key={p.vma.addr}
            style={{ left: `${(p.vma.start / USER_TOP) * 100}%`, width: `max(3px, ${((p.vma.end - p.vma.start) / USER_TOP) * 100}%)`, background: css(pal[best]) }}
            title={`${vmaLabel(p)} ${fmtHex(p.vma.start)}–${fmtHex(p.vma.end)} ${p.vma.flagsStr}`}
            onClick={() => scrollTo(p)}
          />
        );
      })}
      <i style={{ left: "0%" }}>0</i>
      <i style={{ left: "33.3%" }}>1 GiB</i>
      <i style={{ left: "66.6%" }}>2 GiB</i>
      <i style={{ right: "0" }}>3 GiB</i>
    </div>
  );
}

interface GridProps {
  p: VmaPages;
  cols: number;
  pal: RGB[];
  dark: boolean;
  showBits: boolean;
  /** Page index to outline (hovered or pinned), -1 for none. */
  mark: number;
  onHover: (i: number | null) => void;
  onPick: (i: number) => void;
}

function PageGrid({ p, cols, pal, dark, showBits, mark, onHover, onPick }: GridProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const n = p.use.length;
  const per = Math.max(1, Math.ceil(n / MAX_CELLS));
  const cells = Math.ceil(n / per);
  const rows = Math.max(1, Math.ceil(cells / cols));
  // Frame per page from the previous refresh, and a fading highlight for pages whose frame changed.
  const st = useRef({ prev: null as Uint32Array | null, heat: new Float32Array(0), raf: 0, last: 0 });
  const propsRef = useRef({ p, cols, pal, dark, showBits, mark });
  propsRef.current = { p, cols, pal, dark, showBits, mark };

  useEffect(() => {
    const s = st.current;
    if (s.heat.length !== cells) s.heat = new Float32Array(cells);
    if (s.prev && s.prev.length === n) {
      for (let i = 0; i < n; i++) {
        const a = s.prev[i] & PTE_PRESENT ? s.prev[i] >>> 12 : -1;
        const b = p.pte[i] & PTE_PRESENT ? p.pte[i] >>> 12 : -1;
        if (a !== b && b !== -1) s.heat[Math.floor(i / per)] = 1;
      }
    }
    s.prev = p.pte.slice();
    const draw = (now: number) => {
      s.raf = 0;
      const c = ref.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      const { p, cols, pal, dark, showBits, mark } = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = cols * PITCH;
      const h = rows * PITCH;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const dt = s.last ? Math.min(100, now - s.last) : 16;
      s.last = now;
      const decay = Math.pow(0.5, dt / 500);
      let hot = false;
      const glow = dark ? 255 : 0;
      for (let ci = 0; ci < cells; ci++) {
        // dominant use of the pages behind this cell
        let u = PageUse.Absent as PageUse;
        let dirty = false;
        let accessed = false;
        for (let i = ci * per; i < Math.min(n, (ci + 1) * per); i++) {
          if (RANK[p.use[i]] < RANK[u]) u = p.use[i] as PageUse;
          if (p.pte[i] & PTE_PRESENT) {
            if (p.pte[i] & PTE_DIRTY) dirty = true;
            if (p.pte[i] & PTE_ACCESSED) accessed = true;
          }
        }
        const x = (ci % cols) * PITCH;
        const y = Math.floor(ci / cols) * PITCH;
        let [r, g, b] = pal[u];
        const heat = s.heat[ci];
        if (heat > 0.02) {
          r += (glow - r) * heat * 0.8;
          g += (glow - g) * heat * 0.8;
          b += (glow - b) * heat * 0.8;
          s.heat[ci] = heat * decay;
          hot = true;
        } else s.heat[ci] = 0;
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        if (u === PageUse.ProtNone) {
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = dark ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.55)";
          ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
        } else {
          ctx.fillRect(x, y, CELL, CELL);
        }
        if (showBits && u !== PageUse.Absent && u !== PageUse.ProtNone) {
          if (dirty) {
            ctx.fillStyle = dark ? "#fff" : "#111";
            ctx.fillRect(x + CELL - 3, y, 3, 3);
          } else if (!accessed) {
            ctx.fillStyle = dark ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.6)";
            ctx.fillRect(x, y, CELL, CELL);
          }
        }
      }
      if (mark >= 0) {
        const ci = Math.floor(mark / per);
        ctx.strokeStyle = dark ? "#fff" : "#000";
        ctx.lineWidth = 1.5;
        ctx.strokeRect((ci % cols) * PITCH - 0.75, Math.floor(ci / cols) * PITCH - 0.75, CELL + 1.5, CELL + 1.5);
      }
      if (hot) s.raf = requestAnimationFrame(draw);
    };
    if (!s.raf) s.raf = requestAnimationFrame(draw);
  }, [p, cols, pal, dark, showBits, mark, cells, rows, per, n]);

  useEffect(() => () => {
    if (st.current.raf) cancelAnimationFrame(st.current.raf);
  }, []);

  const indexAt = (e: MouseEvent): number | null => {
    const c = ref.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const cx = Math.floor((e.clientX - r.left) / PITCH);
    const cy = Math.floor((e.clientY - r.top) / PITCH);
    if (cx < 0 || cx >= cols || cy < 0) return null;
    const ci = cy * cols + cx;
    return ci < cells ? Math.min(n - 1, ci * per) : null;
  };

  return (
    <canvas
      ref={ref}
      class="aspace-grid"
      onMouseMove={(e) => onHover(indexAt(e as unknown as MouseEvent))}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        const i = indexAt(e as unknown as MouseEvent);
        if (i !== null) onPick(i);
      }}
    />
  );
}
