// Fetches guest assets (kernel, initramfs, BTF, System.map, manifest) and BIOS images, with progress.

import wasmUrl from "v86/build/v86.wasm?url";

export interface AssetProgress {
  name: string;
  loaded: number;
  total: number; // 0 if unknown
  done: boolean;
}

export interface GuestAssets {
  bzimage: ArrayBuffer;
  initrd: ArrayBuffer;
  btf: ArrayBuffer;
  systemMap: string;
  manifest: Record<string, unknown> | null;
  bios: ArrayBuffer;
  vgaBios: ArrayBuffer;
  wasmUrl: string;
}

interface AssetSpec {
  key: string;
  name: string;
  url: string;
  optional?: boolean;
}

const SPECS: AssetSpec[] = [
  { key: "bzimage", name: "bzImage", url: "./guest/bzImage" },
  { key: "initrd", name: "initramfs.cpio.gz", url: "./guest/initramfs.cpio.gz" },
  { key: "btf", name: "vmlinux.btf", url: "./guest/vmlinux.btf" },
  { key: "systemMap", name: "System.map", url: "./guest/System.map" },
  { key: "manifest", name: "manifest.json", url: "./guest/manifest.json", optional: true },
  { key: "bios", name: "seabios.bin", url: "./bios/seabios.bin" },
  { key: "vgaBios", name: "vgabios.bin", url: "./bios/vgabios.bin" },
];

async function fetchWithProgress(spec: AssetSpec, report: (p: AssetProgress) => void): Promise<ArrayBuffer> {
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`${spec.name}: HTTP ${res.status} for ${spec.url}`);
  // Vite's dev server answers unknown paths with index.html (200); detect that.
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("text/html") && !spec.name.endsWith(".html")) {
    throw new Error(`${spec.name}: not found at ${spec.url} (got HTML). Has guest/build.sh been run and copied to web/public/guest/?`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  report({ name: spec.name, loaded: 0, total, done: false });
  if (!res.body) {
    const buf = await res.arrayBuffer();
    report({ name: spec.name, loaded: buf.byteLength, total: buf.byteLength, done: true });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    report({ name: spec.name, loaded, total: Math.max(total, loaded), done: false });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  report({ name: spec.name, loaded, total: loaded, done: true });
  return out.buffer;
}

export async function loadAssets(onProgress: (all: AssetProgress[]) => void): Promise<GuestAssets> {
  const state = new Map<string, AssetProgress>(SPECS.map((s) => [s.name, { name: s.name, loaded: 0, total: 0, done: false }]));
  const emit = () => onProgress([...state.values()]);
  emit();
  const results: Record<string, ArrayBuffer | null> = {};
  await Promise.all(
    SPECS.map(async (spec) => {
      try {
        results[spec.key] = await fetchWithProgress(spec, (p) => {
          state.set(spec.name, p);
          emit();
        });
      } catch (e) {
        if (!spec.optional) throw e;
        results[spec.key] = null;
        state.set(spec.name, { name: spec.name, loaded: 0, total: 0, done: true });
        emit();
      }
    }),
  );
  let manifest: Record<string, unknown> | null = null;
  if (results.manifest) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(results.manifest));
    } catch {
      manifest = null;
    }
  }
  return {
    bzimage: results.bzimage!,
    initrd: results.initrd!,
    btf: results.btf!,
    systemMap: new TextDecoder().decode(results.systemMap!),
    manifest,
    bios: results.bios!,
    vgaBios: results.vgaBios!,
    wasmUrl,
  };
}
