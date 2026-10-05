// A "memory map" diagram of a 4 GiB virtual address space, highest address at the top. Regions are
// not to scale (height grows with the log of the size) and the gaps between them are squeezed to
// a fixed height, so a 4 KiB vDSO and a 1 GiB hole are both readable. Open regions show their
// sub-regions, indented under a coloured rail; click a region to expand / collapse or pin it.

import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  ADDR_TOP, clipRanges, isDirectMapped, vaRows, virtualAliases, type PhysPiece, type RegionKind, type VaMarker, type VaRegion, type VaRow,
} from "../debug/helpers";
import type { MappedRange } from "../vm/types";
import { PhysColumn } from "./PhysColumn";
import { fmtHex, fmtSize } from "./util";
import "./vamap.css";

const KIND_COLOR: Record<RegionKind, string> = {
  user: "var(--user)",
  kernel: "var(--kernel)",
  code: "rgb(139, 92, 246)",
  rodata: "rgb(100, 116, 139)",
  data: "rgb(245, 158, 11)",
  bss: "rgb(234, 179, 8)",
  heap: "rgb(16, 185, 129)",
  stack: "rgb(244, 63, 94)",
  anon: "rgb(20, 184, 166)",
  file: "rgb(59, 130, 246)",
  vdso: "rgb(236, 72, 153)",
  guard: "rgb(148, 163, 184)",
  directmap: "rgb(14, 165, 233)",
  image: "rgb(139, 92, 246)",
  lowmem: "rgb(56, 189, 248)",
  "struct-page": "rgb(249, 115, 22)",
  vmalloc: "rgb(132, 204, 22)",
  vmap: "rgb(101, 163, 13)",
  fixmap: "rgb(234, 179, 8)",
  cea: "rgb(239, 68, 68)",
  pad: "rgb(148, 163, 184)",
};

const fmtAddr = (a: number) => (a >= ADDR_TOP ? "0x100000000" : fmtHex(a));

function rowHeight(row: VaRow): number {
  if (row.type === "gap") return row.end - row.start >= 1 << 20 ? 26 : 14;
  if (row.open) return 24;
  const pages = Math.max(1, (row.end - row.start) / 4096);
  return Math.round(Math.min(72, Math.max(22, 16 + 3.2 * Math.log2(pages))));
}

/** Leaf rows and gaps that contain `addr` get the marker; returns the row index and offset from the top in px. */
function placeMarkers(rows: VaRow[], heights: number[], markers: VaMarker[]): Map<number, { m: VaMarker; y: number }[]> {
  const out = new Map<number, { m: VaMarker; y: number }[]>();
  for (const m of markers) {
    const i = rows.findIndex((r) => !(r.type === "region" && r.open) && r.start <= m.addr && m.addr < r.end);
    if (i < 0) continue;
    const r = rows[i];
    const h = heights[i];
    const y = ((r.end - m.addr) / (r.end - r.start)) * h;
    const list = out.get(i) ?? [];
    list.push({ m, y });
    out.set(i, list);
  }
  // keep tags in a row from overlapping
  for (const [i, list] of out) {
    list.sort((a, b) => a.y - b.y);
    const h = heights[i];
    let prev = -Infinity;
    for (const t of list) {
      t.y = Math.max(t.y, prev + 11);
      prev = t.y;
    }
    const over = prev - (h - 4);
    if (over > 0) for (const t of list) t.y = Math.max(4, t.y - over);
  }
  return out;
}

export const rowKey = (r: VaRow) => (r.type === "region" ? r.r.id : `gap:${r.start}`);

export interface VaMapProps {
  roots: VaRegion[];
  markers: VaMarker[];
  /** Present page-table runs of the whole space (user and kernel), ascending. */
  ranges: MappedRange[];
  /** Bytes of physical RAM; 0 hides the physical column. */
  physTop: number;
  /** Key (rowKey) of the pinned row, controlled by the parent. */
  pinned: string | null;
  onPin: (row: VaRow | null) => void;
  onPickPfn?: (pfn: number) => void;
  footer?: ComponentChildren;
}

export function VaMap({ roots, markers, ranges, physTop, pinned, onPin, onPickPfn, footer }: VaMapProps) {
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [hoverPfn, setHoverPfn] = useState<number | null>(null);
  const setPinned = (key: string | null, row: VaRow) => onPin(key === null ? null : row);

  const rows = useMemo(() => vaRows(roots, (r) => openState[r.id] ?? r.open ?? false), [roots, openState]);
  const heights = useMemo(() => rows.map(rowHeight), [rows]);
  const marks = useMemo(() => placeMarkers(rows, heights, markers), [rows, heights, markers]);
  const { tops, H } = useMemo(() => {
    const t: number[] = [];
    let y = 0;
    for (const h of heights) {
      t.push(y);
      y += h;
    }
    return { tops: t, H: y };
  }, [heights]);
  // Physical pieces of the rows that tile the space (leaves, collapsed regions).
  const { pieces, linear, colors } = useMemo(() => {
    const pieces: PhysPiece[][] = rows.map((r) => (r.type === "region" && !r.open ? clipRanges(ranges, r.start, r.end) : []));
    return {
      pieces,
      linear: pieces.map(isDirectMapped),
      colors: rows.map((r) => (r.type === "region" ? KIND_COLOR[r.r.kind] : "transparent")),
    };
  }, [rows, ranges]);
  const hoverVas = useMemo(() => {
    if (hoverPfn === null) return [];
    return virtualAliases(ranges, hoverPfn * 4096).flatMap((va) => {
      const row = rows.findIndex((r) => !(r.type === "region" && r.open) && r.start <= va && va < r.end);
      return row >= 0 ? [{ va, row }] : [];
    });
  }, [hoverPfn, ranges, rows]);

  // Colour of each open ancestor, for the rails on the left of nested rows.
  const rails: string[][] = [];
  const stack: string[] = [];
  for (const r of rows) {
    stack.length = r.depth;
    rails.push(stack.slice());
    if (r.type === "region" && r.open) stack.push(KIND_COLOR[r.r.kind]);
  }

  const focusKey = pinned ?? hover;
  const focusIdx = rows.findIndex((r) => rowKey(r) === focusKey);
  const focus = focusIdx >= 0 ? rows[focusIdx] : undefined;

  let lastLabel = -1;
  return (
    <div class="vam">
      <div class="vam-main">
      <div class="vam-rows" onMouseLeave={() => setHover(null)}>
        {rows.map((row, i) => {
          const key = rowKey(row);
          const h = heights[i];
          const showTop = row.end !== lastLabel;
          lastLabel = row.end;
          const isLast = i === rows.length - 1;
          const color = row.type === "region" ? KIND_COLOR[row.r.kind] : "transparent";
          const size = row.end - row.start;
          const onClick = () => {
            if (row.type !== "region") return setPinned(pinned === key ? null : key, row);
            if (row.expandable && !row.open) setOpenState({ ...openState, [row.r.id]: true });
            else if (row.expandable && row.open) setOpenState({ ...openState, [row.r.id]: false });
            else setPinned(pinned === key ? null : key, row);
          };
          return (
            <div key={key} class="vam-row" style={{ height: `${h}px` }} onMouseEnter={() => setHover(key)}>
              <div class="vam-gutter">
                {showTop && <span class="vam-addr top">{fmtAddr(row.end)}</span>}
                {isLast && <span class="vam-addr bottom">{fmtAddr(row.start)}</span>}
              </div>
              <div class="vam-body">
                {rails[i].map((c, d) => <span key={d} class="vam-rail" style={{ left: `${d * 12}px`, background: c }} />)}
                {row.type === "gap" ? (
                  <div
                    class={"vam-gap" + (size >= 1 << 20 ? " big" : "") + (pinned === key ? " pinned" : "")}
                    style={{ marginLeft: `${row.depth * 12}px` }}
                    onClick={onClick}
                    title={`${fmtAddr(row.start)}–${fmtAddr(row.end)}`}
                  >
                    {size >= 1 << 20 ? <span>≈ {fmtSize(size)} · {row.label}</span> : <span>{fmtSize(size)}</span>}
                  </div>
                ) : (
                  <Block row={row} color={color} h={h} pinned={pinned === key} onClick={onClick} />
                )}
                {marks.get(i)?.map(({ m, y }) => <span key={m.label} class="vam-mline" style={{ top: `${y}px` }} />)}
              </div>
              <div class="vam-marks">
                {marks.get(i)?.map(({ m, y }) => (
                  <span key={m.label} class="vam-mark" style={{ top: `${y}px` }} title={`${m.label} = ${fmtHex(m.addr)}${m.note ? `\n${m.note}` : ""}`}>
                    ◂ {m.label}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {physTop > 0 && (
        <PhysColumn
          rows={rows}
          tops={tops}
          heights={heights}
          H={H}
          pieces={pieces}
          linear={linear}
          colors={colors}
          physTop={physTop}
          focus={hoverPfn === null ? focusIdx : -1}
          hoverPfn={hoverPfn}
          hoverVas={hoverVas}
          onHoverPfn={setHoverPfn}
          onPickPfn={(f) => onPickPfn?.(f)}
        />
      )}
      </div>
      <div class="vam-card">
        {hoverPfn !== null ? (
          <PfnCard pfn={hoverPfn} vas={hoverVas} rows={rows} />
        ) : focus ? (
          <Card row={focus} markers={markers} pinned={pinned !== null} pieces={pieces[focusIdx]} linear={linear[focusIdx]} />
        ) : (
          footer
        )}
      </div>
    </div>
  );
}

function Block({ row, color, h, pinned, onClick }: { row: Extract<VaRow, { type: "region" }>; color: string; h: number; pinned: boolean; onClick: () => void }) {
  const r = row.r;
  const size = r.end - r.start;
  const frac = r.mapped !== undefined && size > 0 ? r.mapped / size : undefined;
  const twoLines = h >= 36 && !row.open;
  return (
    <div
      class={"vam-block" + (row.open ? " open" : "") + (r.kind === "guard" || r.kind === "pad" ? " dim" : "") + (pinned ? " pinned" : "")}
      style={{ marginLeft: `${row.depth * 12}px`, "--c": color }}
      onClick={onClick}
      title={r.note}
    >
      <div class="vam-line">
        {row.expandable && <span class="vam-caret">{row.open ? "▾" : "▸"}</span>}
        <span class="vam-label">{r.label}</span>
        <span class="vam-size">{fmtSize(size)}</span>
        {!twoLines && r.detail && <span class="vam-detail">{r.detail}</span>}
        {frac !== undefined && (
          <span class="vam-mapped" title={`${Math.round(r.mapped! / 4096)} of ${Math.round(size / 4096)} pages have a present page-table entry`}>
            <span style={{ width: `${Math.max(frac > 0 ? 2 : 0, frac * 100)}%` }} />
          </span>
        )}
      </div>
      {twoLines && r.detail && <div class="vam-detail">{r.detail}</div>}
    </div>
  );
}

function PfnCard({ pfn, vas, rows }: { pfn: number; vas: { va: number; row: number }[]; rows: VaRow[] }) {
  return (
    <>
      <div>
        <b>page frame {pfn}</b> <span class="muted">phys {fmtHex(pfn * 4096)} · click to dump it in the hex viewer</span>
      </div>
      {vas.length ? (
        <div>
          mapped at{" "}
          {vas.map(({ va, row }) => {
            const r = rows[row];
            return (
              <span key={va} class="vam-alias">
                {fmtHex(va)} <span class="muted">({r.type === "region" ? r.r.label : r.label})</span>
              </span>
            );
          })}
        </div>
      ) : (
        <div class="muted">not mapped in this address space</div>
      )}
      {vas.length > 1 && <div class="muted">One frame, several virtual addresses: every lowmem frame is also reachable through the kernel's direct map.</div>}
    </>
  );
}

function Card({ row, markers, pinned, pieces, linear }: { row: VaRow; markers: VaMarker[]; pinned: boolean; pieces?: PhysPiece[]; linear?: boolean }) {
  const size = row.end - row.start;
  const inside = markers.filter((m) => row.start <= m.addr && m.addr < row.end);
  const r = row.type === "region" ? row.r : undefined;
  return (
    <>
      <div>
        <b>{row.type === "region" ? row.r.label : row.label}</b> <span class="muted">{fmtAddr(row.start)}–{fmtAddr(row.end)} · {fmtSize(size)}</span>
        {pinned && <span class="muted"> · pinned (click again to unpin)</span>}
      </div>
      {r?.detail && <div class="muted">{r.detail}</div>}
      {r?.note && <div>{r.note}</div>}
      {r?.mapped !== undefined && (
        <div class="muted">
          {Math.round(r.mapped / 4096)} of {Math.round(size / 4096)} pages present in the page tables ({fmtSize(r.mapped)})
        </div>
      )}
      {pieces && pieces.length > 0 && (
        <div class="muted">
          {linear
            ? `direct map: phys ${fmtHex(pieces[0].pa)}–${fmtHex(pieces[pieces.length - 1].pa + pieces[pieces.length - 1].size)} (va − PAGE_OFFSET)`
            : `${pieces.length} physical run${pieces.length === 1 ? "" : "s"}, lines show where each lands in RAM`}
        </div>
      )}
      {inside.length > 0 && (
        <div class="muted">
          {inside.map((m) => (
            <span key={m.label} title={m.note}>
              {m.label} = {fmtHex(m.addr)}{"  "}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
