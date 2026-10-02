#!/usr/bin/env python3
"""Write manifest.json: kernel version, PAGE_OFFSET, relevant config flags, file hashes.

Usage: make-manifest.py KERNEL/.config KERNEL_VERSION OUT_DIR
"""
import hashlib
import json
import os
import re
import sys

config_path, version, out = sys.argv[1:4]

cfg = {}
for line in open(config_path):
    m = re.match(r"CONFIG_(\w+)=(.*)", line.strip())
    if m:
        cfg[m[1]] = m[2]

FLAGS = [
    "SMP", "X86_PAE", "X86_32", "HIGHMEM", "NOHIGHMEM", "VMSPLIT_3G", "RANDOMIZE_BASE",
    "MITIGATION_PAGE_TABLE_ISOLATION", "CGROUP_SCHED", "FAIR_GROUP_SCHED", "SCHED_DEBUG",
    "PREEMPT_VOLUNTARY", "PREEMPT_COUNT", "DEBUG_INFO_DWARF5", "STACKPROTECTOR", "MODULES",
    "HZ", "PAGE_OFFSET", "X86_CMOV", "M686",
]


def val(name):
    v = cfg.get(name)
    if v is None:
        return False
    if v == "y":
        return True
    if v.startswith('"'):
        return v.strip('"')
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    if v.startswith("0x"):
        return int(v, 16)
    return v


config = {n: val(n) for n in FLAGS}
files = {}
for name in sorted(os.listdir(out)):
    if name == "manifest.json":
        continue
    p = os.path.join(out, name)
    if os.path.isfile(p):
        files[name] = hashlib.sha256(open(p, "rb").read()).hexdigest()

page_offset = cfg.get("PAGE_OFFSET", "0xC0000000")
manifest = {
    "kernelVersion": version,
    "arch": "i386",
    "pageOffset": int(page_offset, 16),
    "config": config,
    # VARs appended to vmlinux.btf by btf-inject.py because pahole cannot encode them
    "btfSynthesizedVars": ["swapper_pg_dir", "linux_banner", "jiffies"],
    "files": files,
}
with open(os.path.join(out, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print("manifest.json written:", json.dumps(config))
