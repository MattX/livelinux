#!/usr/bin/env python3
"""Append VAR entries for globals that pahole cannot encode.

pahole (--btf_features=global_var) only emits variables that have a DWARF
definition. Three symbols the web inspector wants have none:
  * swapper_pg_dir  - defined in assembly (head_32.S), no DWARF at all
  * linux_banner    - DWARF only has an incomplete `extern const char[]` decl
  * jiffies         - a linker alias of jiffies_64
For each, we append a VAR (+ ARRAY where needed) to the BTF type section, using
the symbol's address/size from the ELF symbol table for array lengths. Existing
type ids are untouched (new types are appended), so ids from pahole stay valid.

Usage: btf-inject.py vmlinux.btf vmlinux
"""
import struct
import subprocess
import sys

BTF_KIND = dict(INT=1, PTR=2, ARRAY=3, STRUCT=4, UNION=5, ENUM=6, FWD=7, TYPEDEF=8, VOLATILE=9, CONST=10,
                RESTRICT=11, FUNC=12, FUNC_PROTO=13, VAR=14, DATASEC=15, FLOAT=16, DECL_TAG=17,
                TYPE_TAG=18, ENUM64=19)
KIND_NAME = {v: k for k, v in BTF_KIND.items()}


def parse(data):
    magic, ver, flags, hdr_len, type_off, type_len, str_off, str_len = struct.unpack_from("<HBBIIIII", data, 0)
    assert magic == 0xEB9F, "unexpected BTF magic/endianness"
    types_raw = data[hdr_len + type_off: hdr_len + type_off + type_len]
    strs = data[hdr_len + str_off: hdr_len + str_off + str_len]
    return hdr_len, types_raw, strs


def string_at(strs, off):
    return strs[off: strs.index(b"\0", off)].decode()


def walk(types_raw, strs):
    """Yield (type_id, kind, name, size_or_type, info, extra_len)."""
    pos, tid = 0, 1
    while pos < len(types_raw):
        name_off, info, size_type = struct.unpack_from("<III", types_raw, pos)
        kind, vlen = (info >> 24) & 0x1F, info & 0xFFFF
        extra = {1: 4, 3: 12, 4: vlen * 12, 5: vlen * 12, 6: vlen * 8, 13: vlen * 8, 14: 4,
                 15: vlen * 12, 17: 4, 19: vlen * 12}.get(kind, 0)
        yield tid, kind, string_at(strs, name_off), size_type, info, pos
        pos += 12 + extra
        tid += 1


def main(btf_path, vmlinux):
    data = open(btf_path, "rb").read()
    hdr_len, types_raw, strs = parse(data)
    ids = {}
    count = 0
    existing_vars = set()
    for tid, kind, name, size_type, info, _ in walk(types_raw, strs):
        count = tid
        if kind == BTF_KIND["VAR"]:
            existing_vars.add(name)
        elif kind == BTF_KIND["TYPEDEF"] and name == "pgd_t":
            ids.setdefault("pgd_t", tid)
        elif kind == BTF_KIND["INT"]:
            if name == "char":
                ids.setdefault("char", tid)
            elif name == "long unsigned int":
                ids.setdefault("ulong", tid)

    # symbol sizes: from the ELF size if present, else the distance to the next
    # symbol (asm-defined symbols like swapper_pg_dir carry no size)
    entries = []
    for line in subprocess.check_output(["nm", "-n", "-S", vmlinux], text=True).splitlines():
        p = line.split()
        if len(p) == 4:
            entries.append((p[3], int(p[0], 16), int(p[1], 16)))
        elif len(p) == 3:
            entries.append((p[2], int(p[0], 16), None))
    syms = {}
    for i, (name, addr, size) in enumerate(entries):
        if name in ("swapper_pg_dir", "linux_banner") and name not in syms:
            if size is None:
                size = next(a - addr for _, a, _ in entries[i + 1:] if a > addr)
            syms[name] = size
    assert syms["swapper_pg_dir"] == 4096, syms

    new_types = bytearray()
    new_strs = bytearray()
    next_id = count + 1
    added = []

    def add_str(s):
        off = len(strs) + len(new_strs)
        new_strs.extend(s.encode() + b"\0")
        return off

    def add_array(elem, nelems):
        nonlocal next_id
        new_types.extend(struct.pack("<III", 0, BTF_KIND["ARRAY"] << 24, 0))
        new_types.extend(struct.pack("<III", elem, ids["ulong"], nelems))
        next_id += 1
        return next_id - 1

    def add_var(name, type_id):
        nonlocal next_id
        new_types.extend(struct.pack("<III", add_str(name), BTF_KIND["VAR"] << 24, type_id))
        new_types.extend(struct.pack("<I", 1))  # linkage: global
        next_id += 1
        added.append(name)

    if "swapper_pg_dir" not in existing_vars:
        n = syms["swapper_pg_dir"] // 4
        add_var("swapper_pg_dir", add_array(ids["pgd_t"], n))
    if "linux_banner" not in existing_vars:
        # const char[]: add a CONST wrapper over char
        new_types.extend(struct.pack("<III", 0, BTF_KIND["CONST"] << 24, ids["char"]))
        const_char = next_id
        next_id += 1
        add_var("linux_banner", add_array(const_char, syms["linux_banner"]))
    if "jiffies" not in existing_vars:
        add_var("jiffies", ids["ulong"])

    if not added:
        print("btf-inject: nothing to add")
        return
    hdr = bytearray(data[:hdr_len])
    magic, ver, flags, hlen, type_off, type_len, str_off, str_len = struct.unpack_from("<HBBIIIII", hdr, 0)
    new_type_len = type_len + len(new_types)
    # layout: header | types | strings  (type_off stays 0, strings follow types)
    struct.pack_into("<HBBIIIII", hdr, 0, magic, ver, flags, hlen, 0, new_type_len, new_type_len,
                     str_len + len(new_strs))
    out = bytes(hdr) + types_raw + bytes(new_types) + strs + bytes(new_strs)
    open(btf_path, "wb").write(out)
    print("btf-inject: added", ", ".join(added))


if __name__ == "__main__":
    main(*sys.argv[1:3])
