// Map page frame numbers to pixels. The Hilbert curve keeps physically contiguous ranges together
// as compact blobs (a 2^k-page block is a square or 2:1 rectangle); "linear" is row-major with one
// row per MiB (256 pages of 4 KiB).

export type LayoutMode = "hilbert" | "linear";

export interface Layout {
  mode: LayoutMode;
  width: number;
  height: number;
  /** pfn -> pixel index (y * width + x). */
  pixelOf: Uint32Array;
  /** pixel index -> pfn, or -1 for cells beyond the last frame. */
  pfnAt: Int32Array;
}

/** Hilbert curve index d -> (x, y) on an n x n grid (n a power of two). */
export function hilbertD2xy(n: number, d: number): [number, number] {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & (t >>> 1);
    const ry = 1 & (t ^ rx);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

export function buildLayout(nPages: number, mode: LayoutMode): Layout {
  let width: number;
  let height: number;
  if (mode === "hilbert") {
    width = 1;
    while (width * width < nPages) width *= 2;
    height = width;
  } else {
    width = 256;
    height = Math.ceil(nPages / width);
  }
  const pixelOf = new Uint32Array(nPages);
  const pfnAt = new Int32Array(width * height).fill(-1);
  for (let pfn = 0; pfn < nPages; pfn++) {
    let px: number;
    if (mode === "hilbert") {
      const [x, y] = hilbertD2xy(width, pfn);
      px = y * width + x;
    } else {
      px = pfn;
    }
    pixelOf[pfn] = px;
    pfnAt[px] = pfn;
  }
  return { mode, width, height, pixelOf, pfnAt };
}
