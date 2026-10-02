#!/usr/bin/env python3
"""Sanity-check vmlinux.btf: it must contain VARs for the globals the web app needs.

Uses `bpftool btf dump file X format raw` (installed in the build image).
Usage: check-btf.py vmlinux.btf
"""
import re
import subprocess
import sys

REQUIRED_VARS = ["init_task", "runqueues", "swapper_pg_dir", "linux_banner", "jiffies_64", "pcpu_hot"]
REQUIRED_STRUCTS = ["task_struct", "mm_struct", "vm_area_struct", "rq", "cfs_rq", "sched_entity", "maple_range_64"]


def main(path):
    raw = subprocess.run(["bpftool", "btf", "dump", "file", path, "format", "raw"],
                         check=True, capture_output=True, text=True).stdout
    var_names = set(re.findall(r"^\[\d+\] VAR '([^']+)'", raw, re.M))
    struct_names = set(re.findall(r"^\[\d+\] STRUCT '([^']+)'", raw, re.M))
    print(f"btf: {len(raw.splitlines())} lines, {len(var_names)} VARs, {len(struct_names)} named structs")
    missing = [v for v in REQUIRED_VARS if v not in var_names]
    missing += ["struct " + s for s in REQUIRED_STRUCTS if s not in struct_names]
    if missing:
        sys.exit("btf is missing: " + ", ".join(missing))
    for v in REQUIRED_VARS:
        m = re.search(r"^\[\d+\] VAR '%s' type_id=(\d+) linkage=(\S+)" % re.escape(v), raw, re.M)
        print(f"  VAR {v}: type_id={m[1]} linkage={m[2]}")
    # 'jiffies' is a linker alias of jiffies_64 and has no C declaration; report only.
    print("  VAR jiffies present:", "jiffies" in var_names)


if __name__ == "__main__":
    main(sys.argv[1])
