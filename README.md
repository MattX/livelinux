# livelinux

Linux running in your browser (v86, i386) with a side-panel kernel inspector: a map of every
physical page frame and what it is used for, a CPU timeline with a statistical kernel profiler,
tasks, the EEVDF scheduler on a virtual-time number line, each process's address space page by page
(demand paging, shared page cache, copy-on-write after fork), a graph of open files with pipes drawn
as live ring buffers, kernel memory, and any global variable via a generic BTF type explorer.
Everything updates live while the guest runs; pause it to freeze one exact state. Clicking a process
anywhere selects it in every view. Fully static; no server.

## How it works

- **Emulator:** [v86](https://github.com/copy/v86). Guest RAM is read directly from the WASM
  memory (`cpu.mem8`); registers from v86's typed-array views. `web/src/vm/`
- **Type info:** the kernel is built with DWARF, then `pahole --btf_features=global_var` emits a
  detached `vmlinux.btf` (~2 MB) that is parsed in the browser. `web/src/debug/btf.ts`
- **drgn-style API:** `prog.var("init_task").member("se.vruntime").read()`, `containerOf`, etc.
  `web/src/debug/program.ts`
- **Helpers:** list/rbtree/maple-tree walkers, tasks, CFS runqueue, VMAs. `web/src/debug/helpers/`
- **Page tables:** our own i386 2-level walker over guest physical memory. `web/src/vm/mmu.ts`
- **Live sampling:** v86 runs the guest on the JS thread in ~1 ms slices; `Machine.onSlice` runs
  code between slices, when guest memory is quiescent, so nothing needs pausing. `web/src/live/`
  - CPU: per slice, `current`, user/kernel/halted and EIP into a ring buffer (`cputrace.ts`).
    Slices ending on an IRQ entry stub are attributed to the interrupted context.
  - RAM: ~10x/s, classify all `struct page`s (buddy/per-CPU free, slab, page tables, anon, page
    cache, kernel stacks, kernel image, reserved) and build a frame -> process reverse map from
    page tables, in ~3-6 ms (`physmap.ts`). Drawn one pixel per page along a Hilbert curve.
- **Visual inspectors:** `eevdf()` reproduces `pick_eevdf()`'s eligibility test and pick
  (`helpers/sched.ts`); `vmaPages()` classifies every page of every VMA from its PTE and `struct page`
  (`helpers/pagemap.ts`); `openFiles()` walks fd tables and pipe rings (`helpers/files.ts`). The
  process selection is shared through `ui/selection.ts`.

## Build & run

```sh
guest/build.sh          # Docker: kernel 6.12 LTS (i386) + busybox initramfs + BTF -> web/public/guest/
cd web && npm ci
npm run dev             # http://localhost:5173
npm test                # unit tests + real-guest boot / end-to-end tests (if guest built)
node scripts/smoke-boot.mjs
```

CI (`.github/workflows/site.yml`) builds the guest, runs the tests, and deploys to GitHub Pages.

## Demo programs

Small static programs in `/demo` (on `PATH`) create interesting state to inspect. Sources are in
`guest/initramfs/demo/`; each file's header comment describes what it does step by step.

| Command | What it does | Watch it in |
| --- | --- | --- |
| `forker [N]` | forks N sleeping children | tasks, scheduler |
| `spin [SECS]` | busy loop | CPU timeline, scheduler |
| `mapper` | anon, mprotect-split and file mappings; prints its maps | task VMAs, page tables |
| `pipepair [MS]` / `pipepair -f` | parent and child ping-pong over two pipes (the child's stdin/stdout); `-f` fills the 64 KiB pipe ring until the writer blocks | fd graph, pipe buffer pages in the RAM map |
| `slabchurn [N] [SECS] [ROUNDS]` | in rounds: open N new tmpfs files, close every other fd, close the rest, unlink; prints `/proc/slabinfo` for `filp`, `dentry`, `shmem_inode_cache` | slab view |
| `fragmenter [-d] [MB] [SECS] [ROUNDS]` | in rounds: touch MB of anon memory, munmap every other page (order-0 holes), release the rest (buddies merge); prints `/proc/buddyinfo`. Caps the per-CPU page lists while it runs (`vm.percpu_pagelist_high_fraction`, restored on exit) so frees reach the buddy lists. `-d` punches with `MADV_DONTNEED` instead, keeping one VMA | buddy view, RAM map |
| `cowtouch [PAGES] [MS]` | fills pages, forks; the child writes them one by one (each write copies a frame), then the parent does (frames reused in place) | address-space overlays, RAM map |
| `oomer [STEP_MB] [MS]` | three bystanders (one with `oom_score_adj` 1000) and a hog that grows until the OOM killer acts; prints RSS and `oom_score` per child and who got killed | OOM killer, tasks, RAM map |

See `docs/PLAN.md` for the design.
