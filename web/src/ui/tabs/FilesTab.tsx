import { useState } from "preact/hooks";
import type { InspectorProps } from "../../app/types";
import { openFiles, type FileNode, type FileType, type OpenFile, type OpenFiles, type PipeInfo, type ProcFiles } from "../../debug/helpers";
import { taskColor } from "../../live/cpuStats";
import { Async, Section } from "../common";
import { useCompute } from "../hooks";
import { useSelection } from "../selection";
import { fmtHex, fmtSize } from "../util";
import "./files.css";

// ---------------------------------------------------------------- layout

const W = 600;
const PROC_W = 124;
const PROC_H = 26;
const PROC_PITCH = 36;
const FILE_X = 296;
const FILE_W = W - FILE_X;
const FILE_H = 38;
const PIPE_H = 80;
const FILE_GAP = 10;
const PAD = 4;

interface Edge {
  pid: number;
  inode: number;
  fds: number[];
  /** Some fd reads / writes. */
  read: boolean;
  write: boolean;
}

interface ProcBox { p: ProcFiles; y: number }
interface FileBox { n: FileNode; y: number; h: number }
interface Graph { procs: ProcBox[]; files: FileBox[]; edges: Edge[]; height: number }

const CONSOLE_RE = /console|tty/;

function isConsole(n: FileNode): boolean {
  return n.type === "chr" && CONSOLE_RE.test(n.path);
}

function buildGraph(data: OpenFiles, hideKthreads: boolean, hideConsole: boolean): Graph {
  const edges: Edge[] = [];
  const procs = data.procs.filter((p) => !(hideKthreads && p.isKthread)).sort((a, b) => a.pid - b.pid);
  for (const p of procs) {
    const byInode = new Map<number, Edge>();
    for (const { fd, file } of p.fds) {
      const n = data.files.get(file.inodeAddr);
      if (!n || (hideConsole && isConsole(n))) continue;
      let e = byInode.get(file.inodeAddr);
      if (!e) byInode.set(file.inodeAddr, (e = { pid: p.pid, inode: file.inodeAddr, fds: [], read: false, write: false }));
      e.fds.push(fd);
      e.read ||= file.readable;
      e.write ||= file.writable;
    }
    edges.push(...byInode.values());
  }
  const connected = new Set(edges.map((e) => e.pid));
  const procBoxes: ProcBox[] = procs.filter((p) => connected.has(p.pid)).map((p, i) => ({ p, y: PAD + i * PROC_PITCH }));
  const py = new Map(procBoxes.map((b) => [b.p.pid, b.y + PROC_H / 2]));
  // file column ordered by the barycenter of its processes, then stacked without overlap
  const bary = new Map<number, { sum: number; n: number }>();
  for (const e of edges) {
    const b = bary.get(e.inode) ?? { sum: 0, n: 0 };
    b.sum += py.get(e.pid) ?? 0;
    b.n++;
    bary.set(e.inode, b);
  }
  const nodes = [...bary.keys()].map((k) => data.files.get(k)!);
  const ideal = (n: FileNode) => {
    const b = bary.get(n.inodeAddr)!;
    return b.sum / b.n;
  };
  nodes.sort((a, b) => ideal(a) - ideal(b) || a.ino - b.ino);
  let cursor = PAD;
  const files: FileBox[] = nodes.map((n) => {
    const h = n.type === "pipe" && n.pipe ? PIPE_H : FILE_H;
    const y = Math.max(cursor, ideal(n) - h / 2);
    cursor = y + h + FILE_GAP;
    return { n, y, h };
  });
  const height = Math.max(PAD + procBoxes.length * PROC_PITCH, cursor - FILE_GAP + PAD, 40);
  return { procs: procBoxes, files, edges, height };
}

// ---------------------------------------------------------------- pieces

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const pt = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${pt(r1, a0)} A${r1} ${r1} 0 0 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
}

function PipeRing({ pipe, cx, cy }: { pipe: PipeInfo; cx: number; cy: number }) {
  const n = pipe.ringSize;
  const r0 = 16;
  const r1 = 29;
  const step = (2 * Math.PI) / n;
  const gap = Math.min(0.05, step / 4);
  const ang = (slot: number) => -Math.PI / 2 + slot * step;
  const mark = (slot: number, outer: boolean) => {
    const a = ang(slot);
    const r = outer ? r1 + 1.5 : r0 - 1.5;
    const dir = outer ? 1 : -1; // tip points at the ring
    const len = outer ? 7 : 4.5;
    const tip = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const base = (d: number) => [cx + (r + dir * len) * Math.cos(a + d), cy + (r + dir * len) * Math.sin(a + d)];
    const [b1, b2] = [base(-0.17), base(0.17)];
    return `${tip[0].toFixed(1)},${tip[1].toFixed(1)} ${b1[0].toFixed(1)},${b1[1].toFixed(1)} ${b2[0].toFixed(1)},${b2[1].toFixed(1)}`;
  };
  return (
    <g class="ring">
      {pipe.slots.map((s) => (
        <path
          key={s.slot}
          class={"seg" + (s.occupied ? " full" : "")}
          d={arcPath(cx, cy, r0, r1, ang(s.slot) + gap, ang(s.slot + 1) - gap)}
          style={s.occupied ? { fillOpacity: 0.25 + 0.75 * Math.min(1, s.len / 4096) } : undefined}
        >
          <title>{`slot ${s.slot}: ${s.occupied ? `${s.len} bytes at offset ${s.offset}` : "free"}`}</title>
        </path>
      ))}
      <polygon class="mark head" points={mark(pipe.headSlot, true)}><title>{`head ${pipe.head}: next write goes to slot ${pipe.headSlot}`}</title></polygon>
      <polygon class="mark tail" points={mark(pipe.tailSlot, false)}><title>{`tail ${pipe.tail}: next read comes from slot ${pipe.tailSlot}`}</title></polygon>
      <text class="ring-n" x={cx} y={cy + 3.5} text-anchor="middle">{pipe.used}/{n}</text>
    </g>
  );
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}

function typeLabel(n: FileNode): string {
  switch (n.type) {
    case "chr": return n.major !== undefined ? `chr ${n.major}:${n.minor}` : "chr";
    case "blk": return n.major !== undefined ? `blk ${n.major}:${n.minor}` : "blk";
    case "reg": return `file ${fmtSize(n.size)}`;
    case "dir": return "dir";
    case "pipe": return "pipe";
    case "sock": return "socket";
    case "lnk": return "symlink";
    default: return "other";
  }
}

function FileBoxView(props: {
  box: FileBox;
  state: "" | "hl" | "dim";
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { box, state } = props;
  const { n } = box;
  const pipe = n.type === "pipe" ? n.pipe : undefined;
  return (
    <g
      class={`fnode t-${n.type} ${state}`}
      transform={`translate(${FILE_X} ${box.y})`}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
    >
      <title>{`${n.path}\ninode ${n.ino} @ ${fmtHex(n.inodeAddr)}${n.fstype ? `\nfs ${n.fstype}` : ""}`}</title>
      <rect class="fbox" width={FILE_W} height={box.h} rx="7" />
      {pipe ? (
        <>
          <PipeRing pipe={pipe} cx={38} cy={box.h / 2} />
          <text class="fname" x={84} y={20}>{n.path}</text>
          <text class="fsub" x={84} y={36}>
            {fmtBytes(pipe.bytes)} buffered · {pipe.used}/{pipe.ringSize} slots
          </text>
          <text class="fsub" x={84} y={51}>
            {pipe.readers} reader{pipe.readers === 1 ? "" : "s"} · {pipe.writers} writer{pipe.writers === 1 ? "" : "s"}
          </text>
          {(pipe.writerBlocked || pipe.readerWaiting) && (
            <g transform={`translate(84 58)`}>
              {pipe.writerBlocked && (
                <>
                  <rect class="badge warn" width="86" height="15" rx="7.5" />
                  <text class="badge-t warn" x="43" y="11" text-anchor="middle">writer blocked</text>
                </>
              )}
              {pipe.readerWaiting && (
                <g transform={`translate(${pipe.writerBlocked ? 92 : 0} 0)`}>
                  <rect class="badge ok" width="86" height="15" rx="7.5" />
                  <text class="badge-t ok" x="43" y="11" text-anchor="middle">reader waiting</text>
                </g>
              )}
            </g>
          )}
        </>
      ) : (
        <>
          <text class="fname" x="10" y="16">{trunc(n.path || n.base || `inode ${n.ino}`, 40)}</text>
          <text class="fsub" x="10" y="30">{typeLabel(n)} · ino {n.ino}</text>
        </>
      )}
    </g>
  );
}

function EdgeView({ e, y1, y2, color, state, rank }: { e: Edge; y1: number; y2: number; color: string; state: "" | "hl" | "dim"; rank: number }) {
  const x1 = PROC_W;
  const x2 = FILE_X;
  const A = 7;
  // arrow at the file end if the process writes, at the process end if it reads
  const sx = x1 + (e.read ? A : 0);
  const ex = x2 - (e.write ? A : 0);
  const mx = (sx + ex) / 2;
  const d = `M${sx} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}`;
  const label = e.fds.join(",");
  // Label a point of the curve; staggered per edge so labels of one process do not pile up.
  const t = 0.14 + 0.11 * (rank % 5);
  const u = 1 - t;
  const lx = u * u * u * sx + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * ex;
  const ly = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
  return (
    <g class={`edge ${state}`} style={{ "--ec": color } as Record<string, string>}>
      <path class="e-line" d={d} />
      {e.write && <polygon class="e-arrow" points={`${x2},${y2} ${x2 - A},${y2 - 3.5} ${x2 - A},${y2 + 3.5}`} />}
      {e.read && <polygon class="e-arrow" points={`${x1},${y1} ${x1 + A},${y1 - 3.5} ${x1 + A},${y1 + 3.5}`} />}
      <text class="e-label" x={lx} y={ly - 4} text-anchor="middle">{trunc(label, 12)}</text>
    </g>
  );
}

// ---------------------------------------------------------------- tab

export function FilesTab({ prog }: InspectorProps) {
  const c = useCompute(() => openFiles(prog), [prog]);
  const sel = useSelection();
  const [hideK, setHideK] = useState(true);
  const [hideCon, setHideCon] = useState(false);
  const [hoverPid, setHoverPid] = useState<number | null>(null);
  const [hoverFile, setHoverFile] = useState<number | null>(null);

  return (
    <Async c={c}>
      {(data) => {
        const g = buildGraph(data, hideK, hideCon);
        // Hover takes precedence over the shared selection.
        const fPid = hoverPid ?? (hoverFile === null ? sel.pid : null);
        const fFile = hoverPid === null ? hoverFile : null;
        const focused = fPid !== null || fFile !== null;
        const edgeHl = (e: Edge) => (fPid !== null && e.pid === fPid) || (fFile !== null && e.inode === fFile);
        const procHl = new Set<number>();
        const fileHl = new Set<number>();
        for (const e of g.edges) {
          if (edgeHl(e)) {
            procHl.add(e.pid);
            fileHl.add(e.inode);
          }
        }
        const st = (hl: boolean): "" | "hl" | "dim" => (!focused ? "" : hl ? "hl" : "dim");
        const seen = new Map<number, number>();
        const rankOf = g.edges.map((e) => {
          const r = seen.get(e.pid) ?? 0;
          seen.set(e.pid, r + 1);
          return r;
        });
        const py = new Map(g.procs.map((b) => [b.p.pid, b.y + PROC_H / 2]));
        const fy = new Map(g.files.map((b) => [b.n.inodeAddr, b.y + b.h / 2]));
        // the edge-table process: hovered, else selected
        const tablePid = hoverPid ?? sel.pid;
        const tableProc = tablePid === null ? undefined : data.procs.find((p) => p.pid === tablePid || p.sharers.includes(tablePid));
        const nProcs = data.procs.filter((p) => !p.isKthread).length;
        return (
          <>
            <div class="chips files-chips">
              <button type="button" class={"chip" + (hideK ? " active" : "")} aria-pressed={hideK} onClick={() => setHideK(!hideK)}>
                hide kernel threads
              </button>
              <button type="button" class={"chip" + (hideCon ? " active" : "")} aria-pressed={hideCon} onClick={() => setHideCon(!hideCon)}>
                hide console tty
              </button>
            </div>
            <Section title={`Open files (${g.procs.length} processes, ${g.files.length} files)`} right="click a process to select; hover to highlight">
              {g.procs.length === 0 ? (
                <div class="muted">No open files{nProcs === 0 && hideK ? " in user processes" : ""} to show.</div>
              ) : (
                <svg class="files-graph" viewBox={`0 0 ${W} ${g.height}`} role="img" aria-label="Processes and their open files" data-testid="files-graph">
                  <g class="edges">
                    {g.edges.map((e, i) => (
                      <EdgeView
                        rank={rankOf[i]}
                        key={`${e.pid}:${e.inode}`}
                        e={e}
                        y1={py.get(e.pid)!}
                        y2={fy.get(e.inode)!}
                        color={taskColor(e.pid)}
                        state={st(edgeHl(e))}
                      />
                    ))}
                  </g>
                  {g.procs.map((b) => {
                    const selected = sel.pid === b.p.pid;
                    return (
                      <g
                        key={b.p.pid}
                        class={`pnode ${st(procHl.has(b.p.pid))}${selected ? " selected" : ""}`}
                        transform={`translate(0 ${b.y})`}
                        data-pid={b.p.pid}
                        onMouseEnter={() => setHoverPid(b.p.pid)}
                        onMouseLeave={() => setHoverPid(null)}
                        onClick={() => sel.toggle(b.p.pid, b.p.comm)}
                      >
                        <title>{`${b.p.comm} pid ${b.p.pid} (ppid ${b.p.ppid})${b.p.sharers.length ? `\nshares its fd table with pid ${b.p.sharers.join(", ")}` : ""}`}</title>
                        <rect class="pbox" width={PROC_W} height={PROC_H} rx="13" />
                        <circle cx="13" cy={PROC_H / 2} r="6" fill={taskColor(b.p.pid)} />
                        <text class="pname" x="25" y="17">{trunc(b.p.comm, 9)}</text>
                        <text class="ppid" x={PROC_W - 9} y="17" text-anchor="end">{b.p.pid}</text>
                      </g>
                    );
                  })}
                  {g.files.map((b) => (
                    <FileBoxView
                      key={b.n.inodeAddr}
                      box={b}
                      state={st(fileHl.has(b.n.inodeAddr))}
                      onEnter={() => setHoverFile(b.n.inodeAddr)}
                      onLeave={() => setHoverFile(null)}
                    />
                  ))}
                </svg>
              )}
              <div class="files-legend muted">
                <span class="lg lg-head" /> head: next write
                <span class="lg lg-tail" /> tail: next read
                <span class="lg lg-seg" /> buffered page (opacity = bytes / 4096)
              </div>
            </Section>
            <Section title={tableProc ? `File descriptors of ${tableProc.comm} (pid ${tableProc.pid})` : "File descriptors"}>
              {tableProc ? <FdTable proc={tableProc} files={data.files} /> : (
                <div class="muted">Click (or hover) a process in the graph to list its file descriptors.</div>
              )}
            </Section>
          </>
        );
      }}
    </Async>
  );
}

function modeStr(f: OpenFile): string {
  return (f.readable ? "r" : "") + (f.writable ? "w" : "") || "-";
}

function FdTable({ proc, files }: { proc: ProcFiles; files: Map<number, FileNode> }) {
  if (!proc.fds.length) return <div class="muted">No open file descriptors.</div>;
  return (
    <div class="tbl-wrap">
      <table class="fd-table">
        <thead>
          <tr><th class="num">fd</th><th>mode</th><th>type</th><th>path</th><th class="num">pos</th><th class="num">inode</th></tr>
        </thead>
        <tbody>
          {proc.fds.map(({ fd, file }) => {
            const n = files.get(file.inodeAddr);
            const type: FileType | "?" = n?.type ?? "?";
            return (
              <tr key={fd}>
                <td class="num">{fd}</td>
                <td>{modeStr(file)}</td>
                <td><span class={`ftype t-${type}`}>{n ? typeLabel(n).split(" ")[0] : "?"}</span></td>
                <td class="fd-path" title={n?.path}>{n?.path ?? "?"}</td>
                <td class="num">{file.pos}</td>
                <td class="num">{n?.ino ?? "?"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
