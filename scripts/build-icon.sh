#!/bin/sh
# 由 build/icon.svg 生成 macOS 图标 build/icon.icns，需要 rsvg-convert（brew install librsvg）
set -e
cd "$(dirname "$0")/.."
iconset="$(mktemp -d)/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" build/icon.svg -o "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  rsvg-convert -w "$double" -h "$double" build/icon.svg -o "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o build/icon.icns
rm -rf "$(dirname "$iconset")"
