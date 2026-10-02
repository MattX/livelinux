import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBtf } from "../src/debug/btf";
import { parseSystemMap } from "../src/debug/symbols";
import { KernelProgram } from "../src/debug/program";
import type { Memory } from "../src/vm/types";

const btfPath = fileURLToPath(new URL("../public/guest/vmlinux.btf", import.meta.url));
const offsetsPath = fileURLToPath(new URL("../public/guest/offsets.json", import.meta.url));
const mapPath = fileURLToPath(new URL("../public/guest/System.map", import.meta.url));
const have = existsSync(btfPath) && existsSync(offsetsPath);

const nullMem: Memory = {
  read() {
    throw new Error("no memory in this test");
  },
};

describe.skipIf(!have)("real vmlinux BTF", () => {
  const raw = have ? readFileSync(btfPath) : new Uint8Array();
  const offsets: Record<string, any> = have ? JSON.parse(readFileSync(offsetsPath, "utf8")) : {};
  const symbols = parseSystemMap(existsSync(mapPath) ? readFileSync(mapPath, "utf8") : "");

  it("parses in a reasonable time", () => {
    const t0 = performance.now();
    const btf = parseBtf(raw);
    const dt = performance.now() - t0;
    console.log(`parseBtf: ${raw.length} bytes, ${btf.types.length} types in ${dt.toFixed(1)} ms`);
    expect(btf.types.length).toBeGreaterThan(1000);
    expect(dt).toBeLessThan(1500);
    const t1 = performance.now();
    expect(btf.find("struct task_struct")).toBeDefined();
    console.log(`first find (index build): ${(performance.now() - t1).toFixed(1)} ms`);
  });

  const btf = have ? parseBtf(raw) : (undefined as never);
  const prog = have ? new KernelProgram(btf, symbols, nullMem) : (undefined as never);

  it("finds core types and vars", () => {
    expect(btf.find("struct task_struct")!.size).toBeGreaterThan(500);
    expect(btf.find("struct list_head")!.size).toBe(8);
    expect(btf.find("unsigned long")).toBeDefined();
    expect(prog.typeId("struct task_struct *")).toBeGreaterThan(0);
    expect(prog.enumValue("TASK_RUNNING")).toBe(0n);
    expect(btf.findVar("init_task")).toBeDefined();
    expect(prog.offsetOf("struct task_struct", "tasks")).toBeGreaterThan(0);
    // anonymous-member descent
    expect(prog.offsetOf("struct task_struct", "se.vruntime")).toBeGreaterThan(0);
  });

  it("matches offsets.json (member offsets and sizes)", () => {
    let checked = 0;
    const problems: string[] = [];
    for (const [key, val] of Object.entries(offsets)) {
      if (key === "symbols" || key.startsWith("__")) continue;
      if (!key.startsWith("struct ") && !key.startsWith("union ")) continue;
      if (typeof val !== "object" || val === null) continue;
      for (const [member, off] of Object.entries(val as Record<string, number>)) {
        if (member === "__size") {
          const got = prog.sizeOf(key);
          if (got !== off) problems.push(`${key} size: got ${got}, want ${off}`);
          checked++;
        } else if (member.startsWith("__")) {
          continue;
        } else {
          try {
            const got = prog.offsetOf(key, member);
            if (got !== off) problems.push(`${key}.${member}: got ${got}, want ${off}`);
          } catch (e) {
            problems.push(`${key}.${member}: ${(e as Error).message}`);
          }
          checked++;
        }
      }
    }
    console.log(`offsets.json: checked ${checked} entries, ${problems.length} problems`);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
