<p align="center"><img src="logo-dark.png" alt="REA GUI" width="480"></p>

# REA GUI brand

**The mark: Scan.** An app tile with a scan beam passing through it. Inside the beam,
the app's code shows through. It says what REA GUI does: see inside any app without
running it.

## Files

| File | Use |
|---|---|
| `icon.svg` | App icon, the master. Also served as the GUI's favicon. |
| `png/icon-{16…1024}.png` | App icon at fixed sizes |
| `favicon.ico` | Browser favicon (16, 32, 48) |
| `apple-touch-icon.png` | iOS home screen (180) |
| `icon.icns`, `icon-macos.svg` | macOS app icon, on Apple's 824/1024 grid |
| `mark.svg` | The tile and beam without the dark background, for placing on dark surfaces |
| `logo-dark.*`, `logo-light.*` | Icon + wordmark lockups |
| `social-preview.png` | GitHub social preview / Open Graph (1280×640) |
| `explorations/` | Ideogram V3 reference images the mark was developed from (not for use) |

Everything except `explorations/` is generated. Edit `src/gen.py`, then run
`src/build.sh` (macOS with Google Chrome).

## Colour

| Name | Hex | Use |
|---|---|---|
| Ink | `#0B0B0F` | Icon background, dark surfaces |
| Deep | `#0F172A` | The x-rayed interior |
| Paper | `#FFFFFF` → `#D4D4D8` | The app tile (top-to-bottom gradient) |
| Signal cyan | `#22D3EE` | The beam, code and links. The only accent colour. |
| Cyan light | `#A5F3FC` | Secondary code bars, highlights |
| Steel | `#A1A1AA` / `#71717A` | "GUI" in the wordmark on dark / light |

## Type

- **Wordmark and headings:** Inter, 700 for "REA", 500 for "GUI", tracking −3%.
- **Code and commands:** a monospace such as JetBrains Mono or SF Mono.

The SVG lockups use live text with a system-font fallback. For print or other
places where the font must not change, use the PNGs or outline the text first.

## Rules

- Keep clear space around the icon equal to its corner radius (about 22% of its width).
- The icon is at least 16 px; the lockup is at least 120 px wide.
- Don't recolour the beam, add effects, rotate the mark, or place the bare `mark.svg`
  on a light background (the tile disappears; use `icon.svg` instead).
