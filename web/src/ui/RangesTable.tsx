import type { MappedRange } from "../vm/types";
import type { Symbols } from "../debug/api";
import { fmtHex, fmtSize } from "./util";

const MAX_ROWS = 1500;

/** Table of merged page-table ranges: va, end, pa, size, flags. */
export function RangesTable({ ranges, symbols, onPick }: { ranges: MappedRange[]; symbols?: Symbols; onPick?: (va: number) => void }) {
  const shown = ranges.slice(0, MAX_ROWS);
  const total = ranges.reduce((a, r) => a + r.size, 0);
  return (
    <div>
      <div class="muted" style={{ marginBottom: "4px" }}>
        {ranges.length} ranges, {fmtSize(total)} mapped
        {ranges.length > MAX_ROWS ? ` (showing first ${MAX_ROWS})` : ""}
      </div>
      <div class="tbl-wrap scroll">
        <table>
          <thead>
            <tr>
              <th>va</th>
              <th>va end</th>
              <th>pa</th>
              <th class="num">size</th>
              <th>flags</th>
              {symbols && <th>symbol</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.va} class={onPick ? "clickable" : ""} onClick={() => onPick?.(r.va)}>
                <td>{fmtHex(r.va)}</td>
                <td>{fmtHex((r.va + r.size) >>> 0 || 0x100000000, 8)}</td>
                <td>{fmtHex(r.pa)}</td>
                <td class="num">{fmtSize(r.size)}</td>
                <td>
                  {r.writable ? "rw" : "ro"} <span class={r.user ? "user" : "kernel"}>{r.user ? "user" : "kern"}</span>
                  {r.large && " 4M"}
                </td>
                {symbols && <td class="muted">{symbols.lookup(r.va)?.offset === 0 ? symbols.format(r.va) : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
