import { describe, expect, it } from "vitest";
import { buildLayout, hilbertD2xy } from "../src/live/layout";

describe("page layout", () => {
  it("hilbert curve visits every cell once with unit steps", () => {
    const n = 16;
    const seen = new Set<string>();
    let prev = hilbertD2xy(n, 0);
    seen.add(prev.join());
    for (let d = 1; d < n * n; d++) {
      const p = hilbertD2xy(n, d);
      expect(Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1])).toBe(1);
      seen.add(p.join());
      prev = p;
    }
    expect(seen.size).toBe(n * n);
  });

  it("aligned 2^k blocks are compact", () => {
    const l = buildLayout(65536, "hilbert");
    expect(l.width).toBe(256);
    // a 1024-page (4 MiB) aligned block is a 32x32 square
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (let pfn = 4096; pfn < 4096 + 1024; pfn++) {
      xs.add(l.pixelOf[pfn] % 256);
      ys.add(Math.floor(l.pixelOf[pfn] / 256));
    }
    expect(xs.size).toBe(32);
    expect(ys.size).toBe(32);
  });

  it("inverse map round-trips and pads beyond the last frame", () => {
    for (const mode of ["hilbert", "linear"] as const) {
      const l = buildLayout(61440, mode);
      for (let pfn = 0; pfn < 61440; pfn += 97) expect(l.pfnAt[l.pixelOf[pfn]]).toBe(pfn);
      expect([...l.pfnAt].filter((p) => p === -1).length).toBe(l.width * l.height - 61440);
    }
  });
});
