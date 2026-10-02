# Build environment for the livelinux guest (kernel, busybox, demo programs, BTF).
FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential gcc-i686-linux-gnu libc6-dev-i386-cross \
        bc flex bison libelf-dev libssl-dev cpio xz-utils python3 curl \
        ca-certificates bzip2 file dwarves bpftool \
    && rm -rf /var/lib/apt/lists/*

# trixie ships dwarves/pahole 1.30, which is >= 1.28 and supports the
# `global_var` BTF feature (needed to get init_task, runqueues, ... into BTF).
# Fail the image build if that ever regresses (e.g. base image change).
RUN pahole --version \
    && pahole --supported_btf_features | tr ',' '\n' | grep -qx global_var \
    && python3 - <<'PY'
import subprocess, re
v = subprocess.check_output(["pahole", "--version"], text=True).strip()
m = re.match(r"v?(\d+)\.(\d+)", v)
assert (int(m[1]), int(m[2])) >= (1, 28), "pahole too old: " + v
PY

WORKDIR /guest
