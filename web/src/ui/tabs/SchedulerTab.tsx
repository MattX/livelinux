import { useRef } from "preact/hooks";
import type { InspectorProps } from "../../app/types";
import { eevdf, runqueue, type EevdfState, type EevdfTask } from "../../debug/helpers";
import { taskColor } from "../../live/cpuStats";
import { Async, KV, Section } from "../common";
import { useCompute } from "../hooks";
import { useSelection } from "../selection";
import { fmtHex } from "../util";
import "./sched.css";

/** Virtual time (ns) as a short string, e.g. "+1.25 ms". */
function fmtV(ns: number, sign = true): string {
  const a = Math.abs(ns);
  const s = sign ? (ns > 0 ? "+" : ns < 0 ? "−" : "±") : ns < 0 ? "−" : "";
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(2)} s`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)} ms`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)} µs`;
  return `${s}${a} ns`;
}

/** 1, 2, 5 x 10^k at or above x. */
function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

interface Domain {
  lo: number;
  hi: number;
}

/**
 * Axis range in ns relative to V. Sticky between ticks so bars glide instead of the axis rescaling
 * every refresh: only grows when data leaves it, only shrinks when data uses a small part of it.
 */
function useDomain(state: EevdfState | undefined): Domain {
  const ref = useRef<Domain>({ lo: -1e6, hi: 4e6 });
  if (!state || !state.tasks.length) return ref.current;
  let lo = 0;
  let hi = 0;
  for (const t of state.tasks) {
    const v = Number(BigInt.asIntN(64, t.vruntime - state.avg));
    const d = t.deadline !== undefined ? Number(BigInt.asIntN(64, t.deadline - state.avg)) : v;
    lo = Math.min(lo, v, d);
    hi = Math.max(hi, v, d);
  }
  const pad = (hi - lo) * 0.08 + 2e5;
  lo -= pad;
  hi += pad;
  const cur = ref.current;
  const span = cur.hi - cur.lo;
  const fits = lo >= cur.lo && hi <= cur.hi;
  const tooLoose = hi - lo < span * 0.35;
  if (!fits || tooLoose) {
    const step = niceStep((hi - lo) / 6);
    ref.current = { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step };
  }
  return ref.current;
}

export function SchedulerTab({ prog }: InspectorProps) {
  const c = useCompute(() => {
    const rq = runqueue(prog);
    return { rq, ev: eevdf(rq.cfs) };
  }, [prog]);
  const sel = useSelection();
  const dom = useDomain(c.data?.ev);
  return (
    <Async c={c}>
      {({ rq, ev }) => {
        const cfs = rq.cfs;
        const name = (addr: number) => {
          if (!addr) return "none";
          const t = cfs.tasks.find((x) => x.addr === addr);
          return t ? `${t.comm} (pid ${t.pid})` : fmtHex(addr);
        };
        const rows = [...ev.tasks].sort((a, b) => a.pid - b.pid);
        return (
          <>
            <Section
              title="EEVDF · virtual time"
              right={<span class="muted">{ev.pick ? <>next: <b>{name(ev.pick)}</b></> : "idle"}</span>}
            >
              {rows.length ? (
                <NumberLine rows={rows} ev={ev} dom={dom} />
              ) : (
                <div class="muted">No runnable CFS tasks: the CPU is idle. Start something CPU-bound in the console (e.g. <code>/demo/spin 60 &</code> a few times).</div>
              )}
              <div class="muted eevdf-help">
                Each bar spans a task's <b>vruntime</b> → <b>virtual deadline</b> (vruntime + slice × 1024 / weight).
                <b> V</b> is the load-weighted average vruntime: tasks left of it are owed CPU time (lag ≥ 0) and are
                <span class="eevdf-elig-chip"> eligible</span>. EEVDF runs the eligible task with the earliest deadline
                {ev.pick ? <> — now <b>{name(ev.pick)}</b>: {ev.reason}</> : null}.
              </div>
            </Section>
            <Section title="Runqueue (cpu 0)">
              <KV
                rows={[
                  ["rq", fmtHex(rq.addr)],
                  ["nr_running", `${rq.nrRunning} (cfs: ${rq.cfsNrRunning})`],
                  ["clock", `${rq.clock.toString()} ns`],
                  ["curr", `${name(rq.currAddr)} @ ${fmtHex(rq.currAddr)}`],
                  ["idle", fmtHex(rq.idleAddr)],
                  [cfs.minVruntimeField, cfs.minVruntime.toString()],
                  ["avg_vruntime (V)", cfs.avgVruntime !== undefined ? cfs.avgVruntime.toString() : "n/a"],
                ]}
              />
            </Section>
            <Section title={`CFS tree (${ev.tasks.length})`} right="in tree order (by deadline); click a row to select">
              <div class="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th class="num">#</th><th class="num">pid</th><th>comm</th>
                      <th class="num">vruntime</th><th class="num">deadline</th><th class="num">lag</th><th class="num">slice</th>
                      <th class="num">weight</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.tasks.map((t, i) => (
                      <tr
                        key={t.addr}
                        class={"clickable" + (t.isCurr ? " current" : "") + (sel.pid === t.pid ? " selected" : "")}
                        onClick={() => sel.toggle(t.pid, t.comm)}
                      >
                        <td class="num">{i}</td>
                        <td class="num">{t.pid}</td>
                        <td>{t.comm}</td>
                        <td class="num">{t.vruntime.toString()}</td>
                        <td class="num">{t.deadline?.toString() ?? ""}</td>
                        <td class="num" title={`${t.lag} ns`}>{fmtV(Number(t.lag))}</td>
                        <td class="num">{t.slice?.toString() ?? ""}</td>
                        <td class="num">{t.weight ?? ""}</td>
                        <td>
                          {t.isCurr && <span class="tag cur">curr</span>}
                          {t.addr === ev.pick && <span class="tag pick">next</span>}
                          {!t.eligible && <span class="tag">ineligible</span>}
                          {t.schedDelayed && <span class="tag">delayed</span>}
                        </td>
                      </tr>
                    ))}
                    {!ev.tasks.length && <tr><td colSpan={9} class="muted">no runnable CFS tasks</td></tr>}
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

function NumberLine({ rows, ev, dom }: { rows: EevdfTask[]; ev: EevdfState; dom: Domain }) {
  const sel = useSelection();
  const span = dom.hi - dom.lo;
  const x = (ns: number) => ((ns - dom.lo) / span) * 100;
  const rel = (v: bigint) => Number(BigInt.asIntN(64, v - ev.avg));
  const step = niceStep(span / 6);
  const ticks: number[] = [];
  for (let t = Math.ceil(dom.lo / step) * step; t <= dom.hi; t += step) ticks.push(t);
  const xv = x(0);
  return (
    <div class="eevdf" data-testid="eevdf">
      <div class="eevdf-grid">
        <div class="eevdf-overlay">
          <div class="eevdf-elig" style={{ width: `${xv}%` }} />
          {ticks.map((t) => (
            <div key={t} class={"eevdf-tick" + (t === 0 ? " zero" : "")} style={{ left: `${x(t)}%` }} />
          ))}
          <div class="eevdf-v" style={{ left: `${xv}%` }} title={`V = avg_vruntime = ${ev.avg}`} />
        </div>
        {rows.map((t) => {
          const v = rel(t.vruntime);
          const d = t.deadline !== undefined ? rel(t.deadline) : v;
          const isPick = t.addr === ev.pick;
          const cls =
            "eevdf-row" + (t.eligible ? "" : " inelig") + (isPick ? " pick" : "") + (t.isCurr ? " curr" : "") +
            (sel.pid === t.pid ? " selected" : sel.pid !== null ? " dim" : "") + (t.schedDelayed ? " delayed" : "");
          const tip =
            `${t.comm} (pid ${t.pid})\nvruntime ${t.vruntime} (V ${fmtV(v)})\ndeadline ${t.deadline ?? "?"} (V ${fmtV(d)})\n` +
            `lag ${fmtV(Number(t.lag))}${t.eligible ? " · eligible" : " · not eligible"}\nslice ${t.slice ?? "?"} ns · weight ${t.weight ?? "?"}` +
            (t.isCurr ? "\non the CPU" : "") + (t.schedDelayed ? "\ndelayed dequeue (sleeping, lag being burned off)" : "");
          return (
            <div key={t.addr} class={cls} title={tip} onClick={() => sel.toggle(t.pid, t.comm)}>
              <div class="eevdf-label">
                <span class="eevdf-sw" style={{ background: taskColor(t.pid) }} />
                <span class="eevdf-comm">{t.comm}</span> <span class="muted">{t.pid}</span>
              </div>
              <div class="eevdf-track">
                <div
                  class="eevdf-bar"
                  style={{ left: `${x(Math.min(v, d))}%`, width: `${Math.max(0.4, x(Math.max(v, d)) - x(Math.min(v, d)))}%`, background: taskColor(t.pid) }}
                />
                <div class="eevdf-vr" style={{ left: `${x(v)}%` }} />
              </div>
              <div class="eevdf-tags">
                {isPick && <span class="tag pick">next</span>}
                {t.isCurr && <span class="tag cur">running</span>}
                {t.schedDelayed && <span class="tag">delayed</span>}
                <span class={"eevdf-lag" + (t.lag >= 0n ? " pos" : " neg")}>{fmtV(Number(t.lag))}</span>
              </div>
            </div>
          );
        })}
        <div class="eevdf-axis">
          {ticks.map((t) => (
            <span key={t} class={t === 0 ? "zero" : ""} style={{ left: `${x(t)}%` }}>{t === 0 ? "V" : fmtV(t)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
