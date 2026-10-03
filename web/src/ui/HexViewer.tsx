import { useRef, useState } from "preact/hooks";
import type { Memory } from "../vm/types";
import type { Symbols } from "../debug/api";
import { Hex } from "./Hex";
import { useInspectTick } from "./hooks";
import { errMsg, fmtHex, parseNum } from "./util";

interface Props {
  mem: Memory;
  /** Label for the address input, e.g. "VA" or "PA". */
  label: string;
  initial?: number;
  symbols?: Symbols;
  /** Allow typing a symbol name instead of a number. */
  allowSymbols?: boolean;
  /** Auto-read on mount if initial is set. */
  autoRead?: boolean;
}

const LENGTHS = [64, 128, 256, 512, 1024, 4096];

/** Address input + length + hexdump of `mem`. */
export function HexViewer({ mem, label, initial, symbols, allowSymbols, autoRead }: Props) {
  const [text, setText] = useState(initial !== undefined ? fmtHex(initial) : "");
  const [len, setLen] = useState(256);
  const [result, setResult] = useState<{ addr: number; bytes: Uint8Array; prev?: Uint8Array } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [didAuto, setDidAuto] = useState(false);

  const read = (t = text, l = len, step = 0) => {
    try {
      let addr = parseNum(t);
      if (addr === undefined && allowSymbols && symbols) {
        // "symbol" or "symbol+0x10"
        const m = /^([A-Za-z_.$][\w.$]*)\s*(?:\+\s*(\S+))?$/.exec(t.trim());
        const base = m ? symbols.addr(m[1]) : undefined;
        if (base === undefined) throw new Error(`cannot resolve '${t}'`);
        addr = base + (m![2] ? parseNum(m![2]) ?? 0 : 0);
      }
      if (addr === undefined) throw new Error(`not a number: '${t}'`);
      addr = (addr + step) >>> 0;
      setText(fmtHex(addr));
      const b = mem.read(addr, l);
      setResult({ addr, bytes: new Uint8Array(b) }); // copy: guest RAM views are live
      setError(null);
    } catch (e) {
      setResult(null);
      setError(errMsg(e));
    }
  };
  // Re-read the shown range on every live tick / new pause, highlighting bytes that changed.
  const memRef = useRef(mem);
  memRef.current = mem;
  const resultRef = useRef(result);
  resultRef.current = result;
  useInspectTick(() => {
    const r = resultRef.current;
    if (!r) return;
    const m = memRef.current as Memory & { clearCache?: () => void };
    try {
      m.clearCache?.(); // virtual address spaces cache page tables
      const bytes = new Uint8Array(m.read(r.addr, r.bytes.length));
      if (bytes.some((b, i) => b !== r.bytes[i])) setResult({ addr: r.addr, bytes, prev: r.bytes });
      else if (r.prev) setResult({ addr: r.addr, bytes }); // the highlight lasts one refresh
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  });
  if (autoRead && !didAuto && initial !== undefined) {
    setDidAuto(true);
    queueMicrotask(() => read(fmtHex(initial)));
  }

  return (
    <div class="hexviewer">
      <form class="toolbar" onSubmit={(e) => { e.preventDefault(); read(); }}>
        <label class="muted">{label}</label>
        <input
          class="grow"
          value={text}
          spellcheck={false}
          placeholder={allowSymbols ? "0xc0100000 or symbol[+off]" : "0x1000"}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <select value={len} onChange={(e) => { const l = Number((e.target as HTMLSelectElement).value); setLen(l); if (result) read(text, l); }}>
          {LENGTHS.map((l) => <option value={l}>{l} B</option>)}
        </select>
        <button type="submit">Read</button>
        <button type="button" disabled={!result} onClick={() => read(text, len, -len)}>◀</button>
        <button type="button" disabled={!result} onClick={() => read(text, len, len)}>▶</button>
      </form>
      {error && <div class="error">{error}</div>}
      {result && (
        <>
          {symbols && label.startsWith("V") && (
            <div class="muted" style={{ marginBottom: "4px" }}>{symbols.format(result.addr)}</div>
          )}
          <Hex bytes={result.bytes} base={result.addr} prev={result.prev} />
        </>
      )}
    </div>
  );
}
