import { fmtHex } from "./util";

/** Classic hexdump: offset | 16 bytes hex | ascii. */
export function Hex({ bytes, base = 0 }: { bytes: Uint8Array; base?: number }) {
  const rows: preact.JSX.Element[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const n = Math.min(16, bytes.length - off);
    let hex = "";
    let asc = "";
    for (let i = 0; i < 16; i++) {
      if (i < n) {
        const b = bytes[off + i];
        hex += b.toString(16).padStart(2, "0") + (i === 7 ? "  " : " ");
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex += i === 7 ? "    " : "   ";
      }
    }
    rows.push(
      <div class="hex-row" key={off}>
        <span class="hex-off">{fmtHex(base + off, 8, false)}</span>
        <span class="hex-bytes">{hex}</span>
        <span class="hex-ascii">{asc}</span>
      </div>,
    );
  }
  return <div class="hex">{rows}</div>;
}
