#!/usr/bin/env bash
# Build the livelinux guest artifacts (kernel, initramfs, BTF, System.map, ...).
#
# Runs on the host; all real work happens inside the Docker image defined by
# guest/Dockerfile. Downloads and build trees live in guest/cache/ so reruns
# are incremental. Results land in guest/out/ and are copied to web/public/guest/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
IMAGE="${LIVELINUX_IMAGE:-livelinux-guest-build}"

# shellcheck source=versions.env
. "$HERE/versions.env"

mkdir -p "$HERE/cache/dl" "$HERE/out" "$REPO/web/public/guest"

# Download pinned sources on the host (honours HTTPS_PROXY / CA env of the host).
fetch() { # url file sha256
    local f="$HERE/cache/dl/$2"
    if [ ! -f "$f" ] || ! echo "$3  $f" | sha256sum -c - >/dev/null 2>&1; then
        echo ">> downloading $2"
        curl -fsSL --retry 3 -o "$f.part" "$1"
        mv "$f.part" "$f"
        echo "$3  $f" | sha256sum -c - >/dev/null || { echo "sha256 mismatch for $2" >&2; rm -f "$f"; exit 1; }
    fi
}
fetch "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" "linux-$KERNEL_VERSION.tar.xz" "$KERNEL_SHA256"
fetch "https://busybox.net/downloads/busybox-$BUSYBOX_VERSION.tar.bz2" "busybox-$BUSYBOX_VERSION.tar.bz2" "$BUSYBOX_SHA256"

echo ">> building docker image $IMAGE"
docker build -t "$IMAGE" "$HERE"

echo ">> running guest build in container"
# Run as the invoking user so cache/ and out/ stay owned by them. HOME is a
# throwaway dir inside the cache; nothing else needs to be writable.
mkdir -p "$HERE/cache/home"
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/guest/cache/home \
    -e JOBS="${JOBS:-$(nproc)}" \
    -v "$HERE:/guest" \
    "$IMAGE" \
    bash /guest/build-inner.sh

echo ">> copying out/ to web/public/guest/"
mkdir -p "$REPO/web/public/guest"
cp -f "$HERE"/out/* "$REPO/web/public/guest/"

echo ">> done"
ls -l "$HERE/out"
