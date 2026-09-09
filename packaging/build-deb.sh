#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${1:-$(node -p "require('$ROOT/package.json').version")}
ARCH=${2:-amd64}
STAGE="$ROOT/packaging/.stage"
OUTPUT="$ROOT/dist/family-music-server_${VERSION}_${ARCH}.deb"
NODE_VERSION=24.20.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
NODE_CACHE="$ROOT/packaging/.cache/$NODE_ARCHIVE"

case "$VERSION" in *[!0-9A-Za-z.+:~-]*|'') echo "Некорректная версия пакета: $VERSION" >&2; exit 1;; esac
test -d "$ROOT/node_modules/pg" || { echo "Сначала выполните npm ci --omit=dev" >&2; exit 1; }
[ "$ARCH" = amd64 ] || { echo "Встроенный Node.js пока подготовлен только для amd64" >&2; exit 1; }
if [ ! -f "$NODE_CACHE" ]; then
  mkdir -p "$(dirname "$NODE_CACHE")"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o "$NODE_CACHE"
fi
printf '%s  %s\n' "$NODE_SHA256" "$NODE_CACHE" | sha256sum -c - >/dev/null

rm -rf "$STAGE"
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/family-music" "$STAGE/lib/systemd/system" "$STAGE/usr/share/doc/family-music-server/examples" "$ROOT/dist"

cp -R "$ROOT/src" "$ROOT/public" "$ROOT/federation" "$ROOT/node_modules" "$STAGE/opt/family-music/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$STAGE/opt/family-music/"
cp "$ROOT/.env.example" "$STAGE/usr/share/doc/family-music-server/examples/family-music.env"
cp "$ROOT/deploy/family-music.nginx" "$STAGE/usr/share/doc/family-music-server/examples/family-music.nginx"
cp "$ROOT/deploy/family-music.service" "$ROOT/deploy/family-music-worker.service" "$STAGE/lib/systemd/system/"
sed -i 's|=/usr/bin/node |=/opt/family-music/runtime/bin/node |' "$STAGE/lib/systemd/system/family-music.service" "$STAGE/lib/systemd/system/family-music-worker.service"
cp "$ROOT/packaging/postinst" "$ROOT/packaging/prerm" "$ROOT/packaging/postrm" "$STAGE/DEBIAN/"
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/prerm" "$STAGE/DEBIAN/postrm"
mkdir -p "$STAGE/opt/family-music/runtime/bin"
tar --no-same-owner -xJf "$NODE_CACHE" --strip-components=1 -C "$STAGE/opt/family-music/runtime" "node-v${NODE_VERSION}-linux-x64/bin/node" "node-v${NODE_VERSION}-linux-x64/LICENSE"

find "$STAGE/opt/family-music" -type d -exec chmod 0755 {} +
find "$STAGE/opt/family-music" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE/opt/family-music/src/server.js"
chmod 0755 "$STAGE/opt/family-music/runtime/bin/node"
INSTALLED_SIZE=$(du -sk "$STAGE" | cut -f1)
sed "s/@VERSION@/$VERSION/g;s/@ARCH@/$ARCH/g;s/@INSTALLED_SIZE@/$INSTALLED_SIZE/g" "$ROOT/packaging/control.in" > "$STAGE/DEBIAN/control"
dpkg-deb --root-owner-group --build "$STAGE" "$OUTPUT"
echo "$OUTPUT"
