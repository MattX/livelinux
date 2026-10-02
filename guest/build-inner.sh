#!/usr/bin/env bash
# Runs INSIDE the build container (see build.sh). /guest is the guest/ dir.
set -euo pipefail

G=/guest
. "$G/versions.env"
CACHE=$G/cache
OUT=$G/out
JOBS=${JOBS:-$(nproc)}
CROSS=i686-linux-gnu-
mkdir -p "$CACHE/dl" "$OUT"

# Tarballs are downloaded by build.sh on the host (the container has no
# network access requirements); just verify them here.
fetch() { # url file sha256
    [ -f "$CACHE/dl/$2" ] || { echo "missing $CACHE/dl/$2 (build.sh downloads it)" >&2; exit 1; }
    echo "$3  $CACHE/dl/$2" | sha256sum -c - >/dev/null || { echo "sha256 mismatch for $2" >&2; exit 1; }
}

echo "== pahole: $(pahole --version)"
pahole --supported_btf_features | tr ',' '\n' | grep -qx global_var || { echo "pahole lacks global_var" >&2; exit 1; }

# ============================ kernel =========================================
KDIR=$CACHE/linux-$KERNEL_VERSION
fetch "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" \
      "linux-$KERNEL_VERSION.tar.xz" "$KERNEL_SHA256"
if [ ! -f "$KDIR/.extracted" ]; then
    rm -rf "$KDIR"
    tar -C "$CACHE" -xf "$CACHE/dl/linux-$KERNEL_VERSION.tar.xz"
    touch "$KDIR/.extracted"
fi

KMAKE="make -C $KDIR ARCH=i386 CROSS_COMPILE=$CROSS HOSTCC=gcc -j$JOBS"

# Regenerate .config only when the fragment (or the pinned kernel) changed.
CFG_STAMP="$(sha256sum "$G/kernel.config" | cut -d' ' -f1)"
if [ ! -f "$KDIR/.config" ] || [ "$(cat "$KDIR/.livelinux-cfg" 2>/dev/null)" != "$CFG_STAMP" ]; then
    echo "== configuring kernel"
    $KMAKE i386_defconfig
    (cd "$KDIR" && ARCH=i386 CROSS_COMPILE=$CROSS scripts/kconfig/merge_config.sh -m .config "$G/kernel.config") >/dev/null
    $KMAKE olddefconfig
    echo "$CFG_STAMP" > "$KDIR/.livelinux-cfg"
fi

# merge_config.sh silently drops options with unmet dependencies, so check
# every option we depend on in the final .config. "n" means "# ... is not set"
# or absent.
check_config() {
    local bad=0 spec name want have
    for spec in "$@"; do
        name=${spec%%=*}; want=${spec#*=}
        have=$(sed -n "s/^CONFIG_${name}=\(.*\)/\1/p" "$KDIR/.config")
        [ -n "$have" ] || have=n
        if [ "$have" != "$want" ]; then
            echo "CONFIG CHECK FAILED: CONFIG_$name wanted '$want' got '$have'" >&2
            bad=1
        fi
    done
    return $bad
}
check_config \
    DEBUG_INFO=y DEBUG_INFO_DWARF5=y DEBUG_INFO_REDUCED=n DEBUG_INFO_SPLIT=n DEBUG_INFO_BTF=n \
    RANDOMIZE_BASE=n X86_PAE=n NOHIGHMEM=y HIGHMEM=n VMSPLIT_3G=y PAGE_OFFSET=0xC0000000 \
    SMP=n MITIGATION_PAGE_TABLE_ISOLATION=n CGROUP_SCHED=n FAIR_GROUP_SCHED=n \
    X86_32=y MODULES=n KALLSYMS=y HZ=100 \
    SERIAL_8250=y SERIAL_8250_CONSOLE=y BLK_DEV_INITRD=y RD_GZIP=y \
    DEVTMPFS=y DEVTMPFS_MOUNT=y PROC_FS=y SYSFS=y TMPFS=y BINFMT_ELF=y PRINTK=y \
    DRM=n SOUND=n USB=n NETFILTER=n NET=n \
    || { echo "kernel .config verification failed" >&2; exit 1; }
echo "== kernel .config verified"

echo "== building kernel $KERNEL_VERSION"
$KMAKE bzImage

# ============================ busybox ========================================
BBDIR=$CACHE/busybox-$BUSYBOX_VERSION
fetch "https://busybox.net/downloads/busybox-$BUSYBOX_VERSION.tar.bz2" \
      "busybox-$BUSYBOX_VERSION.tar.bz2" "$BUSYBOX_SHA256"
if [ ! -f "$BBDIR/.extracted" ]; then
    rm -rf "$BBDIR"
    tar -C "$CACHE" -xjf "$CACHE/dl/busybox-$BUSYBOX_VERSION.tar.bz2"
    touch "$BBDIR/.extracted"
fi
BBMAKE="make -C $BBDIR CROSS_COMPILE=$CROSS HOSTCC=gcc -j$JOBS"
if [ ! -f "$BBDIR/.livelinux-built" ]; then
    echo "== building busybox $BUSYBOX_VERSION (static, i686)"
    $BBMAKE defconfig
    # static link; drop things that fail to build against current headers or
    # need unavailable asm/libs.
    sed -i \
        -e 's/^# CONFIG_STATIC is not set/CONFIG_STATIC=y/' \
        -e 's/^CONFIG_TC=y/# CONFIG_TC is not set/' \
        -e 's/^CONFIG_SHA1_HWACCEL=y/# CONFIG_SHA1_HWACCEL is not set/' \
        -e 's/^CONFIG_SHA256_HWACCEL=y/# CONFIG_SHA256_HWACCEL is not set/' \
        -e 's/^CONFIG_FEATURE_HAVE_RPC=y/# CONFIG_FEATURE_HAVE_RPC is not set/' \
        "$BBDIR/.config"
    echo 'CONFIG_EXTRA_CFLAGS="-m32 -O2"' >> "$BBDIR/.config"
    sed -i '/^CONFIG_EXTRA_CFLAGS=""$/d' "$BBDIR/.config"
    yes "" | $BBMAKE oldconfig >/dev/null
    $BBMAKE busybox
    touch "$BBDIR/.livelinux-built"
fi
file "$BBDIR/busybox" | grep -q 'Intel 80386.*statically linked' || { echo "busybox is not a static i386 binary" >&2; exit 1; }

# ============================ initramfs ======================================
echo "== assembling initramfs"
ROOT=$CACHE/rootfs
rm -rf "$ROOT"
mkdir -p "$ROOT"/{bin,sbin,usr/bin,usr/sbin,proc,sys,dev,tmp,root,etc,demo}
cp "$BBDIR/busybox" "$ROOT/bin/busybox"
# applet symlinks without executing the (i386) binary
(cd "$BBDIR" && while read -r link; do
    case "$link" in
        /*) d="$ROOT$(dirname "$link")"; mkdir -p "$d"
            # relative symlink to busybox
            rel=$(python3 -c 'import os,sys;print(os.path.relpath("/bin/busybox", sys.argv[1]))' "$(dirname "$link")")
            ln -sf "$rel" "$ROOT$link" ;;
    esac
done < busybox.links)
# busybox.links lists applets as e.g. /bin/ls; busybox itself is not listed for /bin
for src in "$G"/initramfs/demo/*.c; do
    n=$(basename "$src" .c)
    ${CROSS}gcc -m32 -O2 -static -Wall -o "$ROOT/demo/$n" "$src"
    ${CROSS}strip "$ROOT/demo/$n"
done
install -m 755 "$G/initramfs/init" "$ROOT/init"
echo "root:x:0:0:root:/root:/bin/sh" > "$ROOT/etc/passwd"
echo "root:x:0:" > "$ROOT/etc/group"
(cd "$ROOT" && find . -print0 | sort -z | cpio --null -o -H newc --owner 0:0 --quiet | gzip -9n) > "$OUT/initramfs.cpio.gz"

# ============================ kernel outputs =================================
cp "$KDIR/arch/x86/boot/bzImage" "$OUT/bzImage"
cp "$KDIR/System.map" "$OUT/System.map"

echo "== generating BTF"
rm -f "$OUT/vmlinux.btf"
(cd "$KDIR" && pahole --btf_encode_detached="$OUT/vmlinux.btf" --btf_features=default,global_var vmlinux)
python3 "$G/check-btf.py" "$OUT/vmlinux.btf"

echo "== generating offsets.json and manifest.json"
python3 "$G/make-offsets.py" "$KDIR/vmlinux" "$OUT/System.map" "$OUT/offsets.json"
python3 "$G/make-manifest.py" "$KDIR/.config" "$KERNEL_VERSION" "$OUT"

echo "== outputs"
ls -l "$OUT"
