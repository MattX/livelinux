// Physical memory next to the virtual map: guest RAM drawn to scale, 0 at the bottom, one small
// cell per page frame (several frames per row, so a single 4 KiB page stays visible). Frames are
// coloured by the virtual region that maps them. Regions that are part of the kernel's linear
// direct map are joined to their frames by a ribbon; for everything else (user pages, vmalloc,
// fixmap) the frames are scattered, so lines are only drawn for the hovered / pinned region.

import { useEffect, useMemo, useRef } from "preact/hooks";
import type { VaRow, PhysPiece } from "../debug/helpers";
import { fmtHex } from "./util";

export const CONNECT_W = 48;
/** Width of the pointer-label column between the map and this one (--marks-w in vamap.css). */
const MARKS_W = 112;
export const PHYS_W = 100;
const MAX_LINES = 400;

export interface PhysProps {
  rows: VaRow[];
  /** Top of each row and its height, px from the top of the map. */
  tops: number[];
  heights: number[];
  /** Total height of the map. */
  H: number;
  /** Mapped pieces of each row that tiles the space (empty for open parents and unmapped rows). */
  pieces: PhysPiece[][];
  /** Rows whose pieces are the linear direct map. */
  linear: boolean[];
  colors: string[];
  /** Bytes of physical RAM. */
  physTop: number;
  focus: number;
  hoverPfn: number | null;
  /** Virtual addresses mapping the hovered frame, with the row each is drawn in. */
  hoverVas: { va: number; row: number }[];
  onHoverPfn: (pfn: number | null) => void;
  onPickPfn: (pfn: number) => void;
}

/** Frames per row and row height so that the column is exactly H tall. */
function geometry(physTop: number, H: number) {
  const nFrames = Math.max(1, Math.floor(physTop / 4096));
  const cols = Math.max(4, Math.ceil(nFrames / Math.max(1, H)));
  const nRows = Math.ceil(nFrames / cols);
  return { nFrames, cols, nRows, rowH: H / nRows, cellW: PHYS_W / cols };
}

const rgbCache = new Map<string, [number, number, number]>();
function toRgb(el: Element, c: string): [number, number, number] {
  let s = c;
  const v = /^var\((--[\w-]+)\)$/.exec(c);
  if (v) s = getComputedStyle(el).getPropertyValue(v[1]).trim();
  const hit = rgbCache.get(s);
  if (hit) return hit;
  const ctx = document.createElement("canvas").getContext("2d");
  let rgb: [number, number, number] = [128, 128, 128];
  if (ctx) {
    ctx.fillStyle = s;
    const n = ctx.fillStyle; // normalized: "#rrggbb" or "rgba(r, g, b, a)"
    if (n.startsWith("#")) rgb = [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)];
    else {
      const m = n.match(/\d+/g);
      if (m) rgb = [+m[0], +m[1], +m[2]];
    }
  }
  rgbCache.set(s, rgb);
  return rgb;
}

/** A virtual -> physical line: straight out of the region through the pointer-label column, then across. */
function Link({ y1, y2, cls, style }: { y1: number; y2: number; cls?: string; style?: Record<string, string> }) {
  return <polyline class={cls} points={`${-MARKS_W},${y1} 0,${y1} ${CONNECT_W},${y2}`} style={style} />;
}

export function PhysColumn(p: PhysProps) {
  const { rows, tops, heights, H, pieces, linear, colors, physTop, focus } = p;
  const g = useMemo(() => geometry(physTop, H), [physTop, H]);
  const physY = (pa: number) => H - (pa / 4096 / g.cols) * g.rowH;
  const vaY = (i: number, va: number) => tops[i] + ((rows[i].end - va) / (rows[i].end - rows[i].start)) * heights[i];

  // Owner row of every frame: direct-map rows first, so a frame that is also mapped elsewhere
  // (a user page, a vmalloc page) shows that more specific use.
  const owner = useMemo(() => {
    const o = new Int32Array(g.nFrames).fill(-1);
    for (const pass of [true, false]) {
      pieces.forEach((list, i) => {
        if (linear[i] !== pass) return;
        for (const pc of list) {
          const f0 = Math.floor(pc.pa / 4096);
          const f1 = Math.min(g.nFrames, Math.ceil((pc.pa + pc.size) / 4096));
          for (let f = f0; f < f1; f++) o[f] = i;
        }
      });
    }
    return o;
  }, [pieces, linear, g]);

  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(PHYS_W * dpr);
    const Hp = Math.max(1, Math.round(H * dpr));
    if (c.width !== W || c.height !== Hp) {
      c.width = W;
      c.height = Hp;
      c.style.width = `${PHYS_W}px`;
      c.style.height = `${H}px`;
    }
    const bg = toRgb(c, "var(--panel)");
    const ram = toRgb(c, "var(--panel-2)");
    const rgb = colors.map((col) => toRgb(c, col));
    const img = ctx.createImageData(W, Hp);
    const d = img.data;
    const rowHp = g.rowH * dpr;
    const cellWp = g.cellW * dpr;
    const colOf = new Int32Array(W);
    for (let x = 0; x < W; x++) colOf[x] = Math.min(g.cols - 1, Math.floor(x / cellWp));
    for (let y = 0; y < Hp; y++) {
      const row = Math.floor((Hp - 1 - y) / rowHp);
      // 1-device-pixel gap between frame rows when they are tall enough
      const edge = rowHp >= 3 && Math.floor((Hp - y) % rowHp) === 0;
      for (let x = 0; x < W; x++) {
        const f = row * g.cols + colOf[x];
        const k = (y * W + x) * 4;
        let r = bg[0], gg = bg[1], b = bg[2];
        if (f < g.nFrames) {
          [r, gg, b] = ram;
          const o = owner[f];
          if (o >= 0 && !edge) {
            // scattered frames are drawn below, enlarged
            let a = linear[o] ? 0.22 : 0;
            if (focus >= 0 && o !== focus) a *= 0.5;
            if (o === focus) a = 0.6;
            const oc = rgb[o];
            r += (oc[0] - r) * a;
            gg += (oc[1] - gg) * a;
            b += (oc[2] - b) * a;
          }
        }
        d[k] = r;
        d[k + 1] = gg;
        d[k + 2] = b;
        d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Frames mapped outside the direct map (user pages, vmalloc, ...): at least 3x3 px so a single
    // page stays visible, one rect per run of consecutive frames in a row.
    const minW = 3 * dpr;
    const minH = 3 * dpr;
    for (let f = 0; f < g.nFrames; ) {
      const o = owner[f];
      if (o < 0 || linear[o]) {
        f++;
        continue;
      }
      const row = Math.floor(f / g.cols);
      let e = f + 1;
      while (e < g.nFrames && owner[e] === o && Math.floor(e / g.cols) === row) e++;
      const x = (f % g.cols) * cellWp;
      const w = Math.max(minW, (e - f) * cellWp);
      const h = Math.max(minH, rowHp);
      const yc = Hp - (row + 0.5) * rowHp;
      const oc = rgb[o];
      ctx.globalAlpha = focus >= 0 && o !== focus ? 0.25 : 1;
      ctx.fillStyle = `rgb(${oc[0]},${oc[1]},${oc[2]})`;
      ctx.fillRect(Math.min(x, W - w), Math.max(0, yc - h / 2), w, h);
      f = e;
    }
    ctx.globalAlpha = 1;
    if (p.hoverPfn !== null) {
      const row = Math.floor(p.hoverPfn / g.cols);
      const col = p.hoverPfn % g.cols;
      ctx.strokeStyle = getComputedStyle(c).getPropertyValue("--accent").trim() || "#2563eb";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeRect(col * cellWp - 1, Hp - (row + 1) * rowHp - 1, cellWp + 2, rowHp + 2);
    }
  }, [owner, colors, linear, focus, g, H, p.hoverPfn]);

  // Ribbons for direct-mapped rows; lines for the focused scattered row.
  const ribbons = [];
  for (let i = 0; i < rows.length; i++) {
    if (!linear[i]) continue;
    let vlo = Infinity, vhi = -Infinity, plo = Infinity, phi = -Infinity;
    for (const pc of pieces[i]) {
      vlo = Math.min(vlo, pc.va);
      vhi = Math.max(vhi, pc.va + pc.size);
      plo = Math.min(plo, pc.pa);
      phi = Math.max(phi, pc.pa + pc.size);
    }
    const pts = `0,${vaY(i, vhi)} ${CONNECT_W},${physY(phi)} ${CONNECT_W},${physY(plo)} 0,${vaY(i, vlo)}`;
    ribbons.push(<polygon key={i} points={pts} style={{ fill: colors[i], opacity: i === focus ? 0.4 : focus >= 0 && !linear[focus] ? 0.05 : 0.14 }} />);
  }
  const lines = [];
  if (focus >= 0 && !linear[focus] && pieces[focus]?.length) {
    const list = pieces[focus];
    const step = Math.max(1, Math.ceil(list.length / MAX_LINES));
    for (let j = 0; j < list.length; j += step) {
      const pc = list[j];
      lines.push(
        <Link key={j} y1={vaY(focus, pc.va + pc.size / 2)} y2={physY(pc.pa + pc.size / 2)} style={{ stroke: colors[focus] }} />,
      );
    }
  }
  if (p.hoverPfn !== null) {
    const y2 = physY(p.hoverPfn * 4096 + 2048);
    p.hoverVas.forEach(({ va, row }, j) => {
      lines.push(<Link key={`h${j}`} cls="hover" y1={vaY(row, va)} y2={y2} />);
    });
  }

  // Address ticks on a power-of-two step, about every 48 px.
  const ticks: number[] = [];
  let step = 1 << 20;
  while ((physTop / step) * 48 > H) step *= 2;
  for (let a = 0; a <= physTop; a += step) ticks.push(a);
  if (ticks[ticks.length - 1] !== physTop) ticks.push(physTop);

  const pfnAt = (e: MouseEvent): number | null => {
    const r = ref.current!.getBoundingClientRect();
    const row = Math.floor((H - (e.clientY - r.top)) / g.rowH);
    const col = Math.floor((e.clientX - r.left) / g.cellW);
    if (row < 0 || col < 0 || col >= g.cols) return null;
    const f = row * g.cols + col;
    return f < g.nFrames ? f : null;
  };

  return (
    <div class="vam-phys" style={{ height: `${H}px` }}>
      <svg class="vam-connect" width={CONNECT_W} height={H}>
        {ribbons}
        {lines}
      </svg>
      <canvas
        ref={ref}
        class="vam-physmap"
        onMouseMove={(e) => p.onHoverPfn(pfnAt(e as unknown as MouseEvent))}
        onMouseLeave={() => p.onHoverPfn(null)}
        onClick={(e) => {
          const f = pfnAt(e as unknown as MouseEvent);
          if (f !== null) p.onPickPfn(f);
        }}
      />
      <div class="vam-physlabels">
        {ticks.map((a, j) => {
          const y = physY(a);
          // drop a tick that would collide with the top label
          if (j < ticks.length - 1 && j > 0 && Math.abs(y - physY(physTop)) < 12) return null;
          return (
            <span key={a} style={{ top: `${y}px` }}>
              {fmtHex(a)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
