# livelinux: Linux in the browser with a pausable kernel inspector

## Context

The goal is a static, client-side site that boots a real Linux kernel in a JS/WASM VM. A side panel lets you pause the VM and inspect kernel state: the task list, scheduler run queues, and the memory mappings of the kernel and of processes. The VM and debugger plumbing matter most; only a few inspectors are needed at first. The repo (`mattx/livelinux`, branch `claude/serene-cori-9xpbt7`) is empty, so this is greenfield.

Decisions made with the user:
- **Emulator: v86** (i386). Guest physical RAM is `emulator.v86.cpu.mem8` (a Uint8Array over WASM memory). Registers are typed-array views: `reg32`, `cr` (CR3 included), `instruction_pointer`, `flags`, `sreg`, `segment_offsets`. It also has `stop()`/`run()`/`is_running()`, `save_state()`/`restore_state()` and `read_memory(off,len)`. It is 32-bit only, with no long mode and no SMP. It runs under Node too, which makes headless tests possible.
- **Type info: BTF, parsed in the browser.** At build time, run `pahole --btf_encode_detached=vmlinux.btf --btf_features=default,global_var vmlinux`. `global_var` puts every global variable's type into the BTF. Ship that plus `System.map`. A small TS parser then gives a drgn-like type/value API. DWARF never reaches the browser: there's no mature JS DWARF library, and gimli would need a WASM wrapper.
- **Build: Docker script plus GitHub Actions.** CI builds the guest and deploys the site to GitHub Pages.

## Repo layout

```
guest/                      # everything that produces guest artifacts
  Dockerfile                # debian:trixie + gcc-i686, bc, flex, bison, pahole(>=1.28), busybox src
  build.sh                  # kernel + initramfs + BTF + System.map -> out/
  kernel.config             # fragment merged onto i386_defconfig
  initramfs/init            # busybox init script (mount proc/sys, spawn sh on ttyS0)
  initramfs/demo/*.c        # tiny static demo programs (forker, mmap-er, busy loops)
web/                        # Vite + TypeScript + Preact static site
  public/bios/              # seabios.bin, vgabios.bin (vendored from v86 repo)
  public/guest/             # build output copied here (gitignored)
  src/vm/machine.ts         # v86 wrapper
  src/vm/mmu.ts             # i386 page-table walker
  src/debug/btf.ts          # BTF parser -> type table
  src/debug/symbols.ts      # System.map parser (name <-> address, nearest-symbol lookup)
  src/debug/program.ts      # Program / Value API (drgn-style)
  src/debug/helpers/        # list.ts, rbtree.ts, maple.ts, tasks.ts, sched.ts, mm.ts
  src/ui/                   # Console (xterm.js), Controls, Registers, TaskList, TaskDetail, Sched, TypeExplorer, HexView
  test/                     # vitest unit + node-boot integration tests
.github/workflows/site.yml  # build guest (cached on hash of guest/) -> build web -> deploy Pages
```

## 1. Guest build (`guest/`)

- **Kernel:** pin the 6.12 LTS. It has maple-tree VMAs, the EEVDF scheduler and `pcpu_hot`, and i386 is still supported. Start from `ARCH=i386 i386_defconfig` and merge the fragment with `scripts/kconfig/merge_config.sh`:
  - `DEBUG_INFO_DWARF5=y` (pahole needs the DWARF; we don't ship it), `DEBUG_INFO_BTF` optional
  - `RANDOMIZE_BASE=n` (no KASLR, so System.map addresses match the running kernel)
  - `X86_PAE=n` (2-level 10/10/12 paging), `HIGHMEM4G=n`/`NOHIGHMEM=y`, `VMSPLIT_3G` (PAGE_OFFSET=0xC0000000)
  - `MITIGATION_PAGE_TABLE_ISOLATION=n` (user page tables also map the kernel)
  - `SMP=n` (v86 has one CPU, and per-cpu variables become plain globals). Write the per-cpu helper so it also handles `__per_cpu_offset[]` for later.
  - `CGROUP_SCHED=n`/`FAIR_GROUP_SCHED=n` (every CFS `sched_entity` is a task, so the tree is easy to read)
  - virtio/9p/net off, serial console on, `BLK_DEV_INITRD=y`
- **Initramfs:** a static busybox (i686), the `init` script and the demo programs, all built with `i686-linux-gnu-gcc -static`. Packed as cpio.gz.
- **Outputs to `out/`:** `bzImage`, `initramfs.cpio.gz`, `vmlinux.btf`, `System.map`, and `manifest.json` (kernel version, PAGE_OFFSET, config flags the JS cares about, sha256s). Expected sizes: about 6–8 MB, 1–2 MB, 4–6 MB (around 1.5 MB gzipped), and 2 MB.
- **Fallback:** if the pinned pahole lacks `global_var`, a small `pyelftools` script writes `globals.json` (var name to type name), which the JS resolves against BTF.

## 2. VM layer (`web/src/vm/`)

`machine.ts` is a thin `Machine` wrapper around the `v86` npm package (`libv86.mjs` + `v86.wasm`):
- `boot({bzimage, initrd, cmdline: "console=ttyS0 nokaslr", memory_size: 256MB})`, with serial wired to xterm.js through v86's xterm integration.
- `pause()` calls `emulator.stop()` and resolves on the `emulator-stopped` event. `resume()` calls `run()`. A `paused` signal lets the UI enable the inspectors. Registers live in WASM memory, so they're consistent once stopped.
- `readPhys(pa, len)` returns a `Uint8Array` subarray of a freshly fetched `cpu.mem8` (no copy). Also `u8/u16/u32/u64Phys` helpers via DataView.
- `regs()` returns eax..edi, eip, eflags, cr0/2/3/4, segment selectors and bases, and CPL (from `sreg[CS] & 3`).
- `snapshot()`/`restore()` delegate to `save_state()`/`restore_state()`, which is cheap to add and gives freeze-and-compare later.

`mmu.ts` handles i386 non-PAE translation:
- `translate(cr3, va)` walks PDE (`va>>22`) then PTE (`(va>>12)&0x3ff`). It handles 4 MB PSE pages (PDE bit 7 with CR4.PSE) and returns `{pa, flags}` or a fault.
- `walkRanges(cr3, lo, hi)` enumerates present mappings and merges contiguous ones into `{va, pa, size, rw, user, nx?}`. This backs the page-table view.
- `AddressSpace` = `(machine, cr3)` with `read(va, len)`. It handles page crossings and caches PDE/PTE lookups for the duration of one pause, cleared on resume.
- The kernel address space uses `__pa(swapper_pg_dir)`. A process address space uses `__pa(task->mm->pgd)` (`va - PAGE_OFFSET`, which is valid because pgds are in lowmem).

## 3. Debug layer (`web/src/debug/`)

`btf.ts` parses the BTF header (magic `0xEB9F`), the string section and the type section into an array indexed by type id. It covers every kind: INT, PTR, ARRAY, STRUCT, UNION, ENUM/ENUM64, FWD, TYPEDEF, VOLATILE, CONST, RESTRICT, FUNC, FUNC_PROTO, VAR, DATASEC, FLOAT, DECL_TAG and TYPE_TAG. It handles the kind_flag bitfield encoding of members (bit offset, plus bitfield size in the top 8 bits). It builds indexes from name to struct/union/typedef/enum and from var name to VAR type id. Type size resolution follows typedefs, qualifiers and pointers (4 bytes on i386).

`symbols.ts` parses System.map into a sorted array. It provides `addr(name)` and `lookup(addr)` returning `{name, offset}` for symbolizing EIP and function pointers.

`program.ts` provides a drgn-style API:
- `prog.var("init_task")` returns a `Value {prog, as: AddressSpace, addr, type}`. The address comes from System.map and the type from the BTF VAR.
- On a `Value`:
  - Reading: `.member("se.vruntime")`, `.deref()`, `.index(i)`, `.read()` (number/bigint/bool/enum name), `.cstr(max)`.
  - Pointers and casts: `.addressOf()`, `.cast(typeName)`.
  - Struct navigation: `containerOf(ptr, "struct task_struct", "tasks")`.
- Member lookup recurses into anonymous struct/union members, which `task_struct`, `mm_struct` and `sched_entity` all use.
- Reads go through the kernel `AddressSpace`.

`helpers/` are ports of drgn's Linux helpers, using drgn as the reference implementation:
- `list.ts`: `listForEachEntry(head, type, member)`, guarded against cycles and runaway lengths.
- `rbtree.ts`: in-order walk of `rb_root` / `rb_root_cached`.
- `maple.ts`: `mtForEach(mm.mm_mt)` for VMAs. Entry decoding:
  - A node pointer has `(e & 3) == 2` and `e > 4096`.
  - The node type is `(e >> 3) & 0xF`, one of dense, leaf_64, range_64 or arange_64.
  - The node address is `e & ~0xFF`.
  - Slot and pivot counts come from BTF array lengths of `maple_range_64.slot` / `.pivot` and are never hard-coded, because they differ between 32- and 64-bit kernels.
  - Track min/max per subtree so implied last pivots come out right.
- `tasks.ts`: iterate `init_task.tasks`, plus threads via `signal->thread_head`. Each entry gives pid, tgid, comm, `__state` decoded to R/S/D/T/Z/I, flags, mm and prio.
- `sched.ts`: `runqueues` → `nr_running`, `curr` and `clock`. Walk `cfs.tasks_timeline` with containerOf twice: `rb_node` → `sched_entity.run_node`, then → `task_struct.se`. For each task show vruntime, deadline, vlag, slice and `on_rq`. `cfs_rq->curr` is not in the tree, so list it separately. Also `min_vruntime`/avg_vruntime.
- `mm.ts`:
  - VMAs give `vm_start`, `vm_end`, `vm_flags` (rwxsp decoding), `vm_pgoff`, and the file name from `vm_file->f_path.dentry->d_name.name` or `[heap]`/`[stack]`/anon. The result looks like `/proc/pid/maps`.
  - Per-process page-table ranges come from `mmu.walkRanges`.
  - The kernel memory map shows direct-map, vmalloc and fixmap ranges from swapper_pg_dir, annotated with symbols such as `_text`, `_etext`, `__bss_start` and `high_memory`.
  - Current task is `pcpu_hot.current_task` with a fallback to `runqueues.curr`. CPL from the registers shows whether the VM paused in user or kernel mode.

## 4. UI (`web/src/ui/`), kept minimal

Two-column layout: the serial console (xterm.js) on the left, the inspector on the right with Pause/Resume/Snapshot controls. The inspectors are only enabled while paused:
- **Registers:** symbolized EIP and CR3, plus the current task.
- **Tasks:** a table; clicking a row opens **Task detail** (fields, VMAs, page-table ranges, hex view of a user VA).
- **Scheduler:** the rq summary and the CFS tree sorted by vruntime.
- **Kernel memory map:** the ranges table.
- **Type explorer:** an expandable tree from any global (`init_task`, `runqueues`, `jiffies`, ...) where pointers expand lazily. This generic view comes almost free from the Value API and is the main debugging tool while the other inspectors are built.

## 5. CI / deploy

`.github/workflows/site.yml` has three jobs:
1. **guest:** `docker build guest/` and run `build.sh`, with `actions/cache` keyed on the hash of `guest/**`. Upload `out/` as an artifact.
2. **web:** download the artifact into `web/public/guest/`, then `npm ci && npm run build && npm test`.
3. **deploy-pages.**

`guest/out` and `web/public/guest` are gitignored. For local dev, run `guest/build.sh` in Docker, then `npm run dev`.

## Implementation order

1. Guest build. Boots to a busybox shell in v86 under Node.
2. `Machine` + `mmu` + registers/hex view. Confirm that kernel VA reads of `linux_banner` (System.map) return the expected string.
3. BTF parser + `Program`/`Value` + type explorer.
4. Helpers and inspectors: tasks, then scheduler, then VMAs/page tables.
5. CI and Pages deploy.

## Verification

- **Guest:**
  - `pahole -C task_struct vmlinux` vs. offsets from our BTF parser. A vitest test compares a list of struct.member offsets against a `pahole`-generated JSON fixture written by `build.sh`.
  - `nm`/System.map sanity: `init_task` and `runqueues` are present.
- **Integration (Node, vitest):**
  - Boot `bzImage` + initramfs in v86 headless and wait for the shell prompt on serial.
  - Run `/demo/forker &` (forks N sleeping children).
  - Pause, then assert:
    - The task list includes `init` (pid 1), `sh` and the N children.
    - `linux_banner` reads back as `"Linux version 6.12..."`.
    - The VMAs of the `sh` task include `/bin/busybox` text and `[stack]`, and their ranges agree with `cat /proc/<pid>/maps` captured over serial before pausing.
    - The CFS tree is consistent with `rq.nr_running`.
- **Browser:** `npm run dev`, open with the pre-installed Chromium via Playwright. Boot, pause, click through the panels and screenshot them.
- **Unit:** BTF parser on a tiny hand-built BTF blob (bitfields, anonymous members, ENUM64). Maple-tree walker on a synthetic node layout.

## Known limitations

- Only i386 and a single CPU.
- No breakpoints or single-step yet. v86 has no gdbstub, so pausing happens at an arbitrary point and the VM usually lands in the idle task. The demo busy-loops make pauses more interesting.
- Possible later addition: an IP-polling "pause when EIP in function X" mode using small JIT budgets.
