#!/usr/bin/env bash
# Renders the brand PNGs, favicon.ico and icon.icns from the SVGs (macOS + Google Chrome).
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

python3 src/gen.py >/dev/null

# render <svg> <width> <height> <out.png>
render() {
  printf '<html><body style="margin:0"><img src="%s" width="%s" height="%s" style="display:block"></body></html>' \
    "file://$PWD/$1" "$2" "$3" > "$TMP/page.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$3" \
    --screenshot="$PWD/$4" "file://$TMP/page.html" >/dev/null 2>&1
}

mkdir -p png
for s in 16 32 48 64 128 180 192 256 512 1024; do render icon.svg $s $s "png/icon-$s.png"; done
cp png/icon-180.png apple-touch-icon.png
render logo-dark.svg 1200 320 logo-dark.png
render logo-light.svg 1200 320 logo-light.png
render social.svg 1280 640 social-preview.png

# favicon.ico with embedded 16/32/48 PNGs.
python3 - <<'PY'
import struct
sizes = [16, 32, 48]
data = [open(f"png/icon-{s}.png", "rb").read() for s in sizes]
out = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
for s, d in zip(sizes, data):
    out += struct.pack("<BBBBHHII", s, s, 0, 0, 1, 32, len(d), offset)
    offset += len(d)
open("favicon.ico", "wb").write(out + b"".join(data))
PY

# icon.icns from the macOS-grid variant.
set=$TMP/icon.iconset; mkdir -p "$set"
for s in 16 32 128 256 512; do
  render icon-macos.svg $s $s ".tmp-$s.png"; mv ".tmp-$s.png" "$set/icon_${s}x${s}.png"
  d=$((s * 2)); render icon-macos.svg $d $d ".tmp-$d.png"; mv ".tmp-$d.png" "$set/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set" -o icon.icns
echo "built brand assets"
