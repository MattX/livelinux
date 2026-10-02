import type { InspectorProps } from "../../app/types";
import { runqueue } from "../../debug/helpers";
import { Async, KV, Section } from "../common";
import { useCompute } from "../hooks";
import { fmtHex } from "../util";

export function SchedulerTab({ prog }: InspectorProps) {
  const c = useCompute(() => runqueue(prog), [prog]);
  return (
    <Async c={c}>
      {(rq) => {
        const cfs = rq.cfs;
        const tasks = cfs.tasks;
        const min = tasks.length ? tasks.reduce((a, t) => (t.vruntime < a ? t.vruntime : a), tasks[0].vruntime) : 0n;
        const max = tasks.length ? tasks.reduce((a, t) => (t.vruntime > a ? t.vruntime : a), tasks[0].vruntime) : 0n;
        const span = Number(max - min) || 1;
        const name = (addr: number) => {
          if (!addr) return "none";
          const t = tasks.find((x) => x.addr === addr);
          return t ? `${t.comm} (pid ${t.pid})` : fmtHex(addr);
        };
        return (
          <>
            <Section title="Runqueue (cpu 0)">
              <KV
                rows={[
                  ["rq", fmtHex(rq.addr)],
                  ["nr_running", `${rq.nrRunning} (cfs: ${rq.cfsNrRunning})`],
                  ["clock", `${rq.clock.toString()} ns`],
                  ["curr", `${name(rq.currAddr)} @ ${fmtHex(rq.currAddr)}`],
                  ["idle", fmtHex(rq.idleAddr)],
                  ["min_vruntime", cfs.minVruntime.toString()],
                  ["avg_vruntime", cfs.avgVruntime !== undefined ? cfs.avgVruntime.toString() : "n/a"],
                ]}
              />
            </Section>
            <Section title={`CFS tree (${tasks.length})`} right="in-order; bar = vruntime relative to the smallest">
              <div class="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th class="num">#</th><th class="num">pid</th><th>comm</th>
                      <th class="num">vruntime</th><th class="num">deadline</th><th class="num">vlag</th><th class="num">slice</th>
                      <th class="num">weight</th><th></th><th>rel. vruntime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t, i) => {
                      const rel = Number(t.vruntime - min);
                      return (
                        <tr key={t.addr} class={t.isCurr ? "current" : ""}>
                          <td class="num">{i}</td>
                          <td class="num">{t.pid}</td>
                          <td>{t.comm}</td>
                          <td class="num">{t.vruntime.toString()}</td>
                          <td class="num">{t.deadline?.toString() ?? ""}</td>
                          <td class="num">{t.vlag?.toString() ?? ""}</td>
                          <td class="num">{t.slice?.toString() ?? ""}</td>
                          <td class="num">{t.weight ?? ""}</td>
                          <td>
                            {t.isCurr && <span class="tag cur">curr</span>}
                            {t.schedDelayed && <span class="tag">delayed</span>}
                          </td>
                          <td class="bar-cell" title={`+${rel} ns`}>
                            <div class={"bar" + (t.isCurr ? " cur" : "")}>
                              <div style={{ width: `${Math.max(2, Math.round((rel / span) * 100))}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!tasks.length && <tr><td colSpan={10} class="muted">no runnable CFS tasks</td></tr>}
                  </tbody>
                </table>
              </div>
            </Section>
          </>
        );
      }}
    </Async>
  );
}
