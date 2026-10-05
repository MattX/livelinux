// A "memory map" diagram of a 4 GiB virtual address space, highest address at the top. Regions are
// not to scale (height grows with the log of the size) and the gaps between them are squeezed to
// a fixed height, so a 4 KiB vDSO and a 1 GiB hole are both readable. Open regions show their
// sub-regions, indented under a coloured rail; click a region to expand / collapse or pin it.

import { useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ADDR_TOP, vaRows, type RegionKind, type VaMarker, type VaRegion, type VaRow } from "../debug/helpers";
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

export function VaMap({ roots, markers, footer }: { roots: VaRegion[]; markers: VaMarker[]; footer?: ComponentChildren }) {
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  const rows = useMemo(() => vaRows(roots, (r) => openState[r.id] ?? r.open ?? false), [roots, openState]);
  const heights = useMemo(() => rows.map(rowHeight), [rows]);
  const marks = useMemo(() => placeMarkers(rows, heights, markers), [rows, heights, markers]);

  // Colour of each open ancestor, for the rails on the left of nested rows.
  const rails: string[][] = [];
  const stack: string[] = [];
  for (const r of rows) {
    stack.length = r.depth;
    rails.push(stack.slice());
    if (r.type === "region" && r.open) stack.push(KIND_COLOR[r.r.kind]);
  }

  const rowKey = (r: VaRow) => (r.type === "region" ? r.r.id : `gap:${r.start}`);
  const focusKey = pinned ?? hover;
  const focus = rows.find((r) => rowKey(r) === focusKey);

  let lastLabel = -1;
  return (
    <div class="vam">
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
            if (row.type !== "region") return setPinned(pinned === key ? null : key);
            if (row.expandable && !row.open) setOpenState({ ...openState, [row.r.id]: true });
            else if (row.expandable && row.open) setOpenState({ ...openState, [row.r.id]: false });
            else setPinned(pinned === key ? null : key);
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
      <div class="vam-card">
        {focus ? <Card row={focus} markers={markers} pinned={pinned !== null} /> : footer}
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

function Card({ row, markers, pinned }: { row: VaRow; markers: VaMarker[]; pinned: boolean }) {
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
