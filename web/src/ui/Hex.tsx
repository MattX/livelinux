import { fmtHex } from "./util";

/** Classic hexdump: offset | 16 bytes hex | ascii. Bytes that differ from `prev` are highlighted. */
export function Hex({ bytes, base = 0, prev }: { bytes: Uint8Array; base?: number; prev?: Uint8Array }) {
  const rows: preact.JSX.Element[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const n = Math.min(16, bytes.length - off);
    const hex: preact.ComponentChild[] = [""];
    let asc = "";
    for (let i = 0; i < 16; i++) {
      if (i < n) {
        const b = bytes[off + i];
        const h = b.toString(16).padStart(2, "0");
        if (prev && prev[off + i] !== b) hex.push(<span class="hex-changed">{h}</span>, "");
        else hex[hex.length - 1] += h;
        hex[hex.length - 1] += i === 7 ? "  " : " ";
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex[hex.length - 1] += i === 7 ? "    " : "   ";
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
