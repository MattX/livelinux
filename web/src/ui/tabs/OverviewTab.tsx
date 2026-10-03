import type { InspectorProps } from "../../app/types";
import { currentTask, taskInfo } from "../../debug/helpers";
import { Async, ErrorBox, KV, Section } from "../common";
import { useContext } from "preact/hooks";
import { attempt, InspectContext, useCompute } from "../hooks";
import { fmtHex } from "../util";

const FLAGS: [number, string][] = [
  [0, "CF"], [2, "PF"], [4, "AF"], [6, "ZF"], [7, "SF"], [8, "TF"], [9, "IF"], [10, "DF"], [11, "OF"], [14, "NT"], [16, "RF"], [17, "VM"],
];

function eflagsStr(v: number): string {
  const set = FLAGS.filter(([b]) => (v >>> b) & 1).map(([, n]) => n);
  const iopl = (v >>> 12) & 3;
  return set.join(" ") + (iopl ? ` IOPL=${iopl}` : "");
}

export function OverviewTab({ prog, machine }: InspectorProps) {
  const { running } = useContext(InspectContext);
  const c = useCompute(() => {
    const regs = machine.regs();
    const banner = attempt(() => prog.var("linux_banner").cstr(256).trim());
    const jiffies = attempt(() => {
      const v = (() => {
        try {
          return prog.var("jiffies_64");
        } catch {
          return prog.var("jiffies");
        }
      })();
      return v.read();
    });
    const cur = attempt(() => taskInfo(currentTask(prog)));
    const swapper = prog.symbols.addr("swapper_pg_dir");
    return { regs, banner, jiffies, cur, swapperPhys: swapper !== undefined ? (swapper - 0xc0000000) >>> 0 : undefined };
  }, [prog]);

  return (
    <Async c={c}>
      {({ regs, banner, jiffies, cur, swapperPhys }) => {
        const gp: [string, number][] = [
          ["eax", regs.eax], ["ebx", regs.ebx], ["ecx", regs.ecx], ["edx", regs.edx],
          ["esi", regs.esi], ["edi", regs.edi], ["ebp", regs.ebp], ["esp", regs.esp],
        ];
        const seg: [string, number][] = [
          ["cs", regs.cs], ["ss", regs.ss], ["ds", regs.ds], ["es", regs.es], ["fs", regs.fs], ["gs", regs.gs],
        ];
        const ctl: [string, number][] = [["cr0", regs.cr0], ["cr2", regs.cr2], ["cr3", regs.cr3], ["cr4", regs.cr4]];
        const user = regs.cpl === 3;
        return (
          <>
            <Section
              title="Execution state"
              right={running && <span class="muted" title="Kernel data is only read where it cannot be mid-update; see the CPU tab for where time is spent">sampled when idle or in user mode</span>}
            >
              <KV
                rows={[
                  ["eip", <><b>{fmtHex(regs.eip)}</b> <span class={user ? "user" : "kernel"}>{user ? "(user mode)" : prog.symbols.format(regs.eip)}</span></>],
                  ["CPL", <span class={user ? "user" : "kernel"}>{regs.cpl} ({user ? "user" : "kernel"})</span>],
                  ["eflags", <>{fmtHex(regs.eflags)} <span class="muted">[{eflagsStr(regs.eflags)}]</span></>],
                  [
                    "cr3",
                    <>
                      {fmtHex(regs.cr3)}{" "}
                      <span class="muted">
                        {swapperPhys !== undefined && (regs.cr3 & 0xfffff000) >>> 0 === swapperPhys ? "(swapper_pg_dir)" : "(process page directory)"}
                      </span>
                    </>,
                  ],
                  [
                    "current task",
                    cur.ok ? (
                      <>
                        <b>{cur.value.comm}</b> pid {cur.value.pid} <span class="muted">task @ {fmtHex(cur.value.addr)}, state {cur.value.state}</span>
                      </>
                    ) : (
                      <ErrorBox error={cur.error} />
                    ),
                  ],
                  ["jiffies", jiffies.ok ? jiffies.value.toString() : <ErrorBox error={jiffies.error} />],
                ]}
              />
            </Section>
            <Section title="Banner">
              {banner.ok ? <pre class="banner">{banner.value}</pre> : <ErrorBox error={banner.error} />}
            </Section>
            <Section title="General registers">
              <div class="regs">
                {gp.map(([n, v]) => (
                  <div class="reg"><span>{n}</span><span>{fmtHex(v)}</span></div>
                ))}
              </div>
            </Section>
            <Section title="Segment selectors">
              <div class="regs">
                {seg.map(([n, v]) => (
                  <div class="reg"><span>{n}</span><span>{fmtHex(v, 4)}</span></div>
                ))}
              </div>
            </Section>
            <Section title="Control registers">
              <div class="regs">
                {ctl.map(([n, v]) => (
                  <div class="reg"><span>{n}</span><span>{fmtHex(v)}</span></div>
                ))}
              </div>
            </Section>
          </>
        );
      }}
    </Async>
  );
}
