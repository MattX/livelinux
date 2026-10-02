import { useState } from "preact/hooks";
import type { InspectorProps } from "../../app/types";
import { kernelLayout } from "../../debug/helpers";
import { kernelAddressSpace } from "../../app/session";
import { Async, Section } from "../common";
import { useCompute } from "../hooks";
import { HexViewer } from "../HexViewer";
import { RangesTable } from "../RangesTable";
import { fmtHex } from "../util";

export function MemoryTab({ prog, machine }: InspectorProps) {
  const [mode, setMode] = useState<"virt" | "phys">("virt");
  const layout = useCompute(() => kernelLayout(prog), [prog]);
  const ranges = useCompute(() => kernelAddressSpace(machine, prog).walkRanges(0xc0000000, 0x100000000), [prog, machine]);
  return (
    <>
      <Section title="Kernel layout">
        <Async c={layout}>
          {(entries) => (
            <div class="tbl-wrap">
              <table>
                <thead><tr><th>address</th><th>name</th><th>kind</th><th>note</th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.name}>
                      <td>{fmtHex(e.addr)}</td><td>{e.name}</td><td class="muted">{e.kind}</td><td class="muted">{e.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Section>
      <Section title="Kernel page tables (0xc0000000 .. 0xffffffff)">
        <Async c={ranges}>{(r) => <RangesTable ranges={r} symbols={prog.symbols} />}</Async>
      </Section>
      <Section
        title="Hex viewer"
        right={
          <span class="toolbar" style={{ margin: 0 }}>
            <button class={mode === "virt" ? "primary" : ""} onClick={() => setMode("virt")}>virtual</button>
            <button class={mode === "phys" ? "primary" : ""} onClick={() => setMode("phys")}>physical</button>
          </span>
        }
      >
        {mode === "virt" ? (
          <VirtViewer key="v" prog={prog} machine={machine} />
        ) : (
          <HexViewer key="p" mem={machine.phys} label="PA" initial={0x1000} />
        )}
      </Section>
    </>
  );
}

function VirtViewer({ prog, machine }: InspectorProps) {
  const space = useCompute(() => kernelAddressSpace(machine, prog), [prog, machine]);
  return (
    <Async c={space}>
      {(as) => <HexViewer mem={as} label="VA" symbols={prog.symbols} allowSymbols initial={prog.symbols.addr("init_task")} autoRead />}
    </Async>
  );
}
