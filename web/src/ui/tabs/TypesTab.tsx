import { useEffect, useRef, useState } from "preact/hooks";
import type { Btf, BtfMember, BtfType, Program, Value } from "../../debug/api";
import { BtfKind } from "../../debug/api";
import type { InspectorProps } from "../../app/types";
import { fmtHex } from "../util";
import { useInspectTick } from "../hooks";
import { errMsg, parseNum } from "../util";

const SUGGESTIONS = ["init_task", "runqueues", "jiffies", "pcpu_hot", "linux_banner", "init_mm", "swapper_pg_dir"];
const MAX_ELEMS = 64;
const KIND_NAMES = ["unknown", "int", "ptr", "array", "struct", "union", "enum", "fwd", "typedef", "volatile", "const", "restrict", "func", "func_proto", "var", "datasec", "float", "decl_tag", "type_tag", "enum64"];

interface Child {
  name: string;
  value: Value;
}

interface Summary {
  /** Rendered value text (for scalars) or a short hint for aggregates. */
  text: string;
  extra?: string;
  kind: "int" | "ptr" | "struct" | "array" | "enum" | "str" | "other";
  expandable: boolean;
}

function isCharInt(t: BtfType): boolean {
  return t.kind === BtfKind.INT && !!t.intEncoding && t.intEncoding.char && (t.size ?? 1) === 1;
}

function canDeref(btf: Btf, ptrType: BtfType): boolean {
  if (!ptrType.ref) return false;
  const p = btf.resolve(ptrType.ref);
  return p.kind === BtfKind.STRUCT || p.kind === BtfKind.UNION || p.kind === BtfKind.INT ||
    p.kind === BtfKind.PTR || p.kind === BtfKind.ARRAY || p.kind === BtfKind.ENUM || p.kind === BtfKind.ENUM64;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function summarize(prog: Program, v: Value): Summary {
  const btf = prog.btf;
  const t = btf.resolve(v.type);
  switch (t.kind) {
    case BtfKind.INT: {
      const val = v.read();
      if (t.intEncoding?.bool) return { text: val ? "true" : "false", extra: String(val), kind: "int", expandable: false };
      let text = val.toString();
      let extra: string | undefined;
      if (typeof val === "bigint" ? val >= 0n : val >= 0) extra = fmtHex(val, 1);
      else if (typeof val === "number") extra = fmtHex(val, 8); // two's complement
      if (isCharInt(t)) {
        const n = Number(val) & 0xff;
        extra = (extra ?? "") + (n >= 0x20 && n < 0x7f ? ` '${String.fromCharCode(n)}'` : "");
      }
      return { text, extra, kind: "int", expandable: false };
    }
    case BtfKind.ENUM:
    case BtfKind.ENUM64: {
      const val = v.read();
      return { text: v.enumName(), extra: `${val} (${fmtHex(val, 1)})`, kind: "enum", expandable: false };
    }
    case BtfKind.FLOAT: {
      const b = v.bytes();
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const f = b.length === 4 ? dv.getFloat32(0, true) : b.length === 8 ? dv.getFloat64(0, true) : NaN;
      return { text: String(f), kind: "other", expandable: false };
    }
    case BtfKind.PTR: {
      const p = v.ptr() >>> 0;
      if (p === 0) return { text: "NULL", kind: "ptr", expandable: false };
      let extra: string | undefined;
      const target = t.ref ? btf.resolve(t.ref) : undefined;
      if (target && isCharInt(target)) {
        const s = safe(() => v.cstr(80), undefined as string | undefined);
        if (s !== undefined) extra = quote(s);
      }
      const sym = prog.symbols.lookup(p);
      if (!extra && sym && sym.offset < 0x100000) extra = prog.symbols.format(p);
      return { text: fmtHex(p), extra, kind: "ptr", expandable: canDeref(btf, t) && !(target && isCharInt(target)) };
    }
    case BtfKind.STRUCT:
    case BtfKind.UNION:
      return { text: `{ ${t.members?.length ?? 0} members, ${t.size} bytes }`, kind: "struct", expandable: !!t.members?.length };
    case BtfKind.ARRAY: {
      const a = t.array!;
      const et = btf.resolve(a.elemType);
      if (isCharInt(et)) {
        const s = safe(() => v.cstr(a.nelems), "");
        return { text: quote(s), extra: `char[${a.nelems}]`, kind: "str", expandable: a.nelems > 0 };
      }
      return { text: `[${a.nelems}]`, kind: "array", expandable: a.nelems > 0 };
    }
    case BtfKind.FUNC_PROTO:
    case BtfKind.FUNC:
      return { text: prog.symbols.format(v.addr), kind: "other", expandable: false };
    case BtfKind.FWD:
      return { text: "<incomplete type>", kind: "other", expandable: false };
    default:
      return { text: `<${KIND_NAMES[t.kind] ?? t.kind}>`, kind: "other", expandable: false };
  }
}

function memberValue(prog: Program, v: Value, m: BtfMember): Value {
  if (m.name) return v.member(m.name);
  return prog.value(v.addr + (m.bitOffset >>> 3), m.type, v.mem);
}

function children(prog: Program, v: Value): { items: Child[]; more: number } {
  const btf = prog.btf;
  const t = btf.resolve(v.type);
  if (t.kind === BtfKind.STRUCT || t.kind === BtfKind.UNION) {
    return {
      items: (t.members ?? []).map((m) => ({ name: m.name || "<anon>", value: memberValue(prog, v, m) })),
      more: 0,
    };
  }
  if (t.kind === BtfKind.ARRAY) {
    const n = t.array!.nelems;
    const items: Child[] = [];
    for (let i = 0; i < Math.min(n, MAX_ELEMS); i++) items.push({ name: `[${i}]`, value: v.index(i) });
    return { items, more: Math.max(0, n - MAX_ELEMS) };
  }
  if (t.kind === BtfKind.PTR) {
    return { items: [{ name: "*", value: v.deref() }], more: 0 };
  }
  return { items: [], more: 0 };
}

function TreeNode({ prog, name, value, depth }: { prog: Program; name: string; value: Value; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  let sum: Summary;
  let typeName = "";
  let err: string | undefined;
  try {
    typeName = value.typeName();
    sum = summarize(prog, value);
  } catch (e) {
    err = errMsg(e);
    sum = { text: "", kind: "other", expandable: false };
    try {
      const t = prog.btf.resolve(value.type);
      sum.expandable = t.kind === BtfKind.STRUCT || t.kind === BtfKind.UNION; // can still try
    } catch { /* ignore */ }
  }
  let kids: { items: Child[]; more: number } | undefined;
  let kidErr: string | undefined;
  if (open && sum.expandable) {
    try {
      kids = children(prog, value);
    } catch (e) {
      kidErr = errMsg(e);
    }
  }
  return (
    <div class="tnode">
      <div class={"trow" + (sum.expandable ? " expandable" : "")} onClick={() => sum.expandable && setOpen(!open)}>
        <span class="tcaret">{sum.expandable ? (open ? "▾" : "▸") : ""}</span>
        <span class="tname">{name}</span>
        <span class="ttype">{typeName}</span>
        {err ? <span class="terr">{err}</span> : (
          <>
            <span class={"tval tval-" + sum.kind}>{sum.text}</span>
            {sum.extra && <span class="textra">{sum.extra}</span>}
          </>
        )}
        <span class="taddr" title="address of this object">@{fmtHex(value.addr >>> 0)}</span>
      </div>
      {open && (
        <div class="tchildren">
          {kidErr && <div class="terr">{kidErr}</div>}
          {kids?.items.map((c, i) => (
            <TreeNode key={i + c.name} prog={prog} name={c.name} value={c.value} depth={depth + 1} />
          ))}
          {kids && kids.more > 0 && <div class="muted tmore">… {kids.more} more elements</div>}
        </div>
      )}
    </div>
  );
}

/** Build a root Value from user input: "name", or "0xaddr:struct foo", or "name:struct foo" (name is a symbol). */
function resolveRoot(prog: Program, input: string): { name: string; value: Value } {
  input = input.trim();
  const colon = input.indexOf(":");
  if (colon > 0) {
    const a = input.slice(0, colon).trim();
    const type = input.slice(colon + 1).trim();
    let addr = parseNum(a);
    if (addr === undefined) {
      addr = prog.symbols.addr(a);
      if (addr === undefined) throw new Error(`unknown symbol or address '${a}'`);
    }
    return { name: `(${type} *) ${fmtHex(addr)}`, value: prog.value(addr, type) };
  }
  // "name" or "name.member.path" / "name->member" (member path resolved on the global).
  const m = /^([A-Za-z_]\w*)\s*((?:\.|->).+)?$/.exec(input);
  if (m && m[2]) {
    let v = prog.var(m[1]);
    for (const step of m[2].split(/->|\./).filter(Boolean)) {
      const t = prog.btf.resolve(v.type);
      v = (t.kind === BtfKind.PTR ? v.deref() : v).member(step);
    }
    return { name: input, value: v };
  }
  return { name: input, value: prog.var(input) };
}

export function TypesTab({ prog }: InspectorProps) {
  const [input, setInput] = useState("init_task");
  const [root, setRoot] = useState<{ name: string; value: Value } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The input the current root was resolved from. */
  const rootInput = useRef<string | null>(null);

  const go = (text = input) => {
    rootInput.current = text;
    try {
      setRoot(resolveRoot(prog, text));
      setError(null);
    } catch (e) {
      setRoot(null);
      setError(errMsg(e));
    }
  };

  useEffect(() => go(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-resolve the root (it may follow pointers) and re-render on each live tick / new pause; the
  // tree reads values while rendering, which happens in a microtask before the guest runs again.
  // The tree is keyed by the root address, so expanded nodes survive unless that address moves.
  useInspectTick(() => rootInput.current !== null && go(rootInput.current));

  return (
    <div class="tab-types">
      <form
        class="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <input
          list="type-suggestions"
          value={input}
          spellcheck={false}
          placeholder="global (init_task) or addr:type (0xc1234000:struct page)"
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          class="grow"
        />
        <datalist id="type-suggestions">
          {SUGGESTIONS.map((s) => <option value={s} />)}
        </datalist>
        <button type="submit">Explore</button>
      </form>
      <div class="chips">
        {SUGGESTIONS.map((s) => (
          <button type="button" class="chip" onClick={() => { setInput(s); go(s); }}>{s}</button>
        ))}
      </div>
      {error && <div class="error">Error: {error}</div>}
      {root && (
        <div class="tree" key={root.name + root.value.addr}>
          <TreeNode prog={prog} name={root.name} value={root.value} depth={0} />
        </div>
      )}
    </div>
  );
}
