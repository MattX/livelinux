#!/usr/bin/env node
// Headless smoke test: boot the guest kernel + initramfs in v86 under Node,
// wait for the busybox shell prompt on the serial console, run a few
// commands, and verify their output. Exit 0 on success, 1 on failure/timeout.
//
// Usage: node scripts/smoke-boot.mjs [--timeout=SECONDS] [--quiet]
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { V86 } from "v86";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const require = createRequire(import.meta.url);

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const timeoutMs = Number(args.get("timeout") ?? 120) * 1000;
const quiet = args.has("quiet");

const buf = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const wasmPath = resolve(dirname(require.resolve("v86")), "v86.wasm");

const emulator = new V86({
  wasm_path: wasmPath,
  memory_size: 256 * 1024 * 1024,
  vga_memory_size: 2 * 1024 * 1024,
  bios: { buffer: buf(resolve(web, "public/bios/seabios.bin")) },
  vga_bios: { buffer: buf(resolve(web, "public/bios/vgabios.bin")) },
  bzimage: { buffer: buf(resolve(web, "public/guest/bzImage")) },
  initrd: { buffer: buf(resolve(web, "public/guest/initramfs.cpio.gz")) },
  cmdline: "console=ttyS0 nokaslr tsc=reliable mitigations=off",
  autostart: true,
  disable_speaker: true,
  disable_keyboard: true,
  disable_mouse: true,
});

let out = "";
const decoder = new TextDecoder();
let pending = [];
emulator.add_listener("serial0-output-byte", (byte) => {
  pending.push(byte);
  if (byte === 10 || pending.length > 256) flush();
});
function flush() {
  if (!pending.length) return;
  const s = decoder.decode(new Uint8Array(pending));
  pending = [];
  out += s;
  if (!quiet) process.stdout.write(s);
}
setInterval(flush, 200).unref();

const started = Date.now();
function fail(msg) {
  flush();
  console.error(`\n[smoke-boot] FAIL: ${msg} (after ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (quiet) console.error(out.slice(-4000));
  process.exit(1);
}
const timer = setTimeout(() => fail("timeout"), timeoutMs);

async function waitFor(re, from = 0) {
  for (;;) {
    flush();
    const m = re.exec(out.slice(from));
    if (m) return from + m.index + m[0].length;
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  // shell prompt, PS1='livelinux:\w # '
  const promptRe = /livelinux:[^\n]*# $/m;
  let pos = await waitFor(promptRe);
  console.error(`\n[smoke-boot] shell prompt after ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const mark = out.length;
  emulator.serial0_send(
    "uname -a; cat /proc/meminfo | head -3; /demo/forker 3 & sleep 1; ps; echo SMOKE_$((40+2))_DONE\n",
  );
  await waitFor(/^SMOKE_42_DONE$/m, mark);
  await waitFor(promptRe, mark);
  flush();
  const reply = out.slice(mark);

  const checks = [
    [/Linux livelinux 6\.12\.\d+ .* i686/, "uname reports 6.12 i686"],
    [/MemTotal:\s+\d+ kB/, "meminfo readable"],
    [/forker: child 2 pid \d+/, "forker spawned 3 children"],
    [/\d+\s+root\s+\d+:\d+\s+\/demo\/forker 3/, "forker visible in ps"],
  ];
  let ok = true;
  for (const [re, label] of checks) {
    const pass = re.test(reply);
    console.error(`[smoke-boot] ${pass ? "ok  " : "FAIL"} ${label}`);
    ok &&= pass;
  }
  if (!ok) fail("command output checks failed");
  clearTimeout(timer);
  console.error(`[smoke-boot] PASS in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  await emulator.destroy?.();
  process.exit(0);
} catch (e) {
  fail(String(e?.stack ?? e));
}
