# livelinux

Linux running in your browser (v86, i386) with a side-panel kernel inspector: pause the VM and
look at tasks, the CFS runqueue, process VMAs and page tables, kernel memory, and any global
variable via a generic BTF type explorer. Fully static; no server.

## How it works

- **Emulator:** [v86](https://github.com/copy/v86). Guest RAM is read directly from the WASM
  memory (`cpu.mem8`); registers from v86's typed-array views. `web/src/vm/`
- **Type info:** the kernel is built with DWARF, then `pahole --btf_features=global_var` emits a
  detached `vmlinux.btf` (~2 MB) that is parsed in the browser. `web/src/debug/btf.ts`
- **drgn-style API:** `prog.var("init_task").member("se.vruntime").read()`, `containerOf`, etc.
  `web/src/debug/program.ts`
- **Helpers:** list/rbtree/maple-tree walkers, tasks, CFS runqueue, VMAs. `web/src/debug/helpers/`
- **Page tables:** our own i386 2-level walker over guest physical memory. `web/src/vm/mmu.ts`

## Build & run

```sh
guest/build.sh          # Docker: kernel 6.12 LTS (i386) + busybox initramfs + BTF -> web/public/guest/
cd web && npm ci
npm run dev             # http://localhost:5173
npm test                # unit tests + real-guest boot / end-to-end tests (if guest built)
node scripts/smoke-boot.mjs
```

CI (`.github/workflows/site.yml`) builds the guest, runs the tests, and deploys to GitHub Pages.

Inside the guest: `/demo/forker N`, `/demo/spin SECS`, `/demo/mapper` create interesting state to inspect.

See `docs/PLAN.md` for the design.
