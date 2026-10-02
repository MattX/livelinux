import { useEffect, useRef } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Machine } from "../vm/machine";

const COLS = 80;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Serial console (ttyS0), wired manually: machine.onSerialByte -> term.write, term.onData -> machine.serialSend. */
export function Console({ machine }: { machine: Machine }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      cols: COLS,
      rows: 24,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: { background: cssVar("--term-bg", "#0d1117"), foreground: cssVar("--term-fg", "#d6dde6") },
    });
    termRef.current = term;
    term.open(el);

    // Batch serial bytes per animation frame.
    let pending: number[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (pending.length) {
        term.write(new Uint8Array(pending));
        pending = [];
      }
    };
    const offSerial = machine.onSerialByte((b) => {
      pending.push(b & 0xff);
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    });
    const dataSub = term.onData((d) => machine.serialSend(d));

    // Fit rows to the container height; keep 80 columns (the guest tty assumes 80).
    const fitRows = () => {
      const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen || !term.rows) return;
      const cellH = screen.clientHeight / term.rows;
      if (!cellH) return;
      const rows = Math.max(8, Math.floor((el.clientHeight - 12) / cellH));
      if (rows !== term.rows) term.resize(COLS, rows);
    };
    const ro = new ResizeObserver(fitRows);
    ro.observe(el);
    const t = setTimeout(fitRows, 50);

    return () => {
      clearTimeout(t);
      ro.disconnect();
      offSerial();
      dataSub.dispose();
      term.dispose();
    };
  }, [machine]);

  return <div class="console-wrap" ref={host} onClick={() => termRef.current?.focus()} />;
}
