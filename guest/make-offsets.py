#!/usr/bin/env python3
"""Generate offsets.json: ground-truth struct member offsets taken from DWARF.

This is deliberately independent of the BTF parser in the web app: offsets come
from `pahole -F dwarf -E` (expanded nested types) run against vmlinux, and are
parsed here. Members of anonymous unions/structs are reported at their
effective offset within the top-level struct.

Usage: make-offsets.py VMLINUX SYSTEM_MAP OUT_JSON
"""
import json
import re
import subprocess
import sys

# struct name -> members to report (effective byte offsets)
SPEC = {
    "task_struct": ["thread_info", "__state", "stack", "flags", "on_rq", "prio", "static_prio", "se", "rt",
                    "policy", "tasks", "mm", "active_mm", "exit_state", "pid", "tgid", "real_parent",
                    "parent", "children", "sibling", "group_leader", "thread_node", "comm", "fs",
                    "files", "signal", "start_time", "start_boottime", "thread"],
    "thread_info": ["flags"],
    "mm_struct": ["pgd", "mm_mt", "mmap_base", "task_size", "map_count", "total_vm", "start_code",
                  "end_code", "start_data", "end_data", "start_brk", "brk", "start_stack",
                  "mm_users", "mm_count"],
    "vm_area_struct": ["vm_start", "vm_end", "vm_mm", "vm_page_prot", "vm_flags", "vm_pgoff", "vm_file"],
    "maple_tree": ["ma_flags", "ma_root"],
    "maple_range_64": ["parent", "pivot", "slot"],
    "maple_arange_64": ["parent", "pivot", "slot", "gap", "meta"],
    "maple_node": ["parent", "slot", "mr64", "ma64"],
    "rq": ["nr_running", "cfs", "curr", "idle", "clock", "clock_task"],
    "cfs_rq": ["load", "nr_running", "h_nr_queued", "zero_vruntime", "avg_vruntime", "avg_load", "tasks_timeline", "curr", "next"],
    "sched_entity": ["load", "run_node", "deadline", "min_vruntime", "on_rq", "vruntime", "vlag", "slice",
                     "sum_exec_runtime"],
    "rb_node": ["__rb_parent_color", "rb_right", "rb_left"],
    "rb_root": ["rb_node"],
    "rb_root_cached": ["rb_root", "rb_leftmost"],
    "list_head": ["next", "prev"],
    "pcpu_hot": ["current_task"],
    "signal_struct": ["thread_head", "nr_threads"],
    "file": ["f_path", "f_inode"],
    "path": ["mnt", "dentry"],
    "dentry": ["d_name", "d_parent", "d_inode"],
    "qstr": ["name", "len"],
}
SYMBOLS = ["init_task", "runqueues", "swapper_pg_dir", "linux_banner"]
OPTIONAL_SYMBOLS = ["_text", "_etext", "_end", "init_mm", "jiffies_64", "pcpu_hot", "high_memory",
                    "__per_cpu_offset", "max_pfn", "init_pg_dir"]


def strip_attrs(s):
    """Remove __attribute__((...)) with balanced parens."""
    while True:
        i = s.find("__attribute__")
        if i < 0:
            return s
        j = s.find("(", i)
        depth = 0
        k = j
        while k < len(s):
            if s[k] == "(":
                depth += 1
            elif s[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        s = s[:i] + s[k + 1:]


OFFSET_RE = re.compile(r"/\*\s*(\d+)(?::\s*\d+)?\s+(\d+)\s*\*/\s*$")
SIZE_RE = re.compile(r"/\*\s*size:\s*(\d+)")


class Frame:
    def __init__(self, parent):
        self.parent = parent
        self.anonymous = None  # decided on close


def member_name(decl):
    decl = decl.strip().rstrip(";").strip()
    decl = re.sub(r":\s*\d+\s*$", "", decl)  # bitfield width
    decl = re.sub(r"\[[^\]]*\]", "", decl).strip()
    m = re.search(r"\(\s*\*\s*(\w+)\s*\)", decl)  # function pointer
    if m:
        return m.group(1)
    m = re.search(r"(\w+)\s*$", decl)
    return m.group(1) if m else None


def parse_chunk(lines):
    """Return (size, {member: (offset, arraylen|None)}) for one struct dump."""
    size = None
    root = Frame(None)
    stack = [root]
    members = []  # (name, offset, frame, arraylen)
    depth0_seen = False
    for raw in lines:
        m = SIZE_RE.search(raw)
        if m and len(stack) == 1:
            size = int(m.group(1))
            continue
        om = OFFSET_RE.search(raw)
        code = re.sub(r"/\*.*?\*/", "", raw).strip()
        if not code:
            continue
        if code.endswith("{"):
            if not depth0_seen:
                depth0_seen = True  # the root "struct X {" line
                continue
            stack.append(Frame(stack[-1]))
            continue
        if code.startswith("}"):
            if len(stack) == 1:
                continue  # root close
            f = stack.pop()
            decl = strip_attrs(code[1:])
            name = member_name(decl) if decl.strip().rstrip(";").strip() else None
            f.anonymous = name is None
            if name and om:
                members.append((name, int(om.group(1)), stack[-1], None))
            continue
        if code.endswith(";") and om:
            name = member_name(strip_attrs(code))
            am = re.findall(r"\[(\d+)\]", code)
            members.append((name, int(om.group(1)), stack[-1], int(am[0]) if am else None))

    def effective(frame):
        while frame is not root:
            if not frame.anonymous:
                return False
            frame = frame.parent
        return True

    result = {}
    for name, off, frame, alen in members:
        if name and effective(frame) and name not in result:
            result[name] = (off, alen)
    return size, result


def pahole_chunk(vmlinux, name):
    """Run pahole for ONE type (a multi-type -C list silently truncates after
    types containing enums in pahole 1.30). Returns the dump lines."""
    p = subprocess.run(["pahole", "-F", "dwarf", "-E", "-C", name, vmlinux],
                       capture_output=True, text=True)
    lines = []
    started = False
    for line in p.stdout.splitlines():
        if re.match(r"^(?:struct|union)\s+%s\s*\{" % re.escape(name), line):
            if started:  # duplicate definition: keep the first
                break
            started = True
        if started:
            lines.append(line)
    if not lines:
        sys.exit(f"pahole: struct {name} not found in DWARF: {p.stderr}")
    return lines


def main(vmlinux, system_map, out):
    res = {}
    arrays = {}
    for sname, wanted in SPEC.items():
        size, members = parse_chunk(pahole_chunk(vmlinux, sname))
        entry = {"__size": size}
        for mname in wanted:
            if mname not in members:
                sys.exit(f"struct {sname}: member {mname} not found (have: {sorted(members)})")
            off, alen = members[mname]
            entry[mname] = off
            if alen is not None:
                arrays.setdefault(f"struct {sname}", {})[mname] = alen
        res[f"struct {sname}"] = entry

    syms = {}
    for line in open(system_map):
        parts = line.split()
        if len(parts) == 3:
            addr, _t, name = parts
            if name in SYMBOLS or name in OPTIONAL_SYMBOLS:
                syms.setdefault(name, int(addr, 16))
    for s in SYMBOLS:
        if s not in syms:
            sys.exit(f"System.map: symbol {s} missing")
    res["symbols"] = dict(sorted(syms.items()))
    res["arrays"] = arrays
    with open(out, "w") as f:
        json.dump(res, f, indent=2)
        f.write("\n")
    print("offsets.json written;", {k: v["__size"] for k, v in res.items() if k.startswith("struct")})


if __name__ == "__main__":
    main(*sys.argv[1:4])
