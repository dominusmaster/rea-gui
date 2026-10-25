"""Generates the REA GUI brand SVGs ("Scan": an app tile x-rayed by a scan beam).

Run: python3 brand/src/gen.py   (writes into brand/)
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent

INK = "#0b0b0f"
CYAN = "#22d3ee"
CYAN_LIGHT = "#a5f3fc"
X, Y, W, H, R = 104, 104, 304, 304, 76  # the app tile on the 512 grid
BAND_TOP, BAND_BOTTOM = 210, 302          # the x-rayed band

DEFS = f'''<defs>
<linearGradient id="shell" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d4d4d8"/></linearGradient>
<linearGradient id="ray" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{CYAN}" stop-opacity="0"/><stop offset=".5" stop-color="#67e8f9"/><stop offset="1" stop-color="{CYAN}" stop-opacity="0"/></linearGradient>
<filter id="blur" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="9"/></filter>
<clipPath id="band"><rect x="0" y="{BAND_TOP}" width="512" height="{BAND_BOTTOM - BAND_TOP}"/></clipPath>
<clipPath id="notband"><path d="M0 0H512V{BAND_TOP}H0Z M0 {BAND_BOTTOM}H512V512H0Z"/></clipPath>
</defs>'''

# Three rows of "code" seen through the beam: (indent, [bar widths]).
ROWS = [(0, [92, 64]), (30, [56, 104]), (0, [128])]


def glyph():
    bars = ""
    for i, (indent, widths) in enumerate(ROWS):
        bx = 150 + indent
        for j, bw in enumerate(widths):
            fill, op = (CYAN, 1) if j == 0 else (CYAN_LIGHT, 0.55)
            bars += f'<rect x="{bx}" y="{226 + i * 22}" width="{bw}" height="12" rx="6" fill="{fill}" opacity="{op}"/>'
            bx += bw + 12
    g = f'<g clip-path="url(#band)"><rect x="{X}" y="{Y}" width="{W}" height="{H}" rx="{R}" fill="#0f172a"/>{bars}</g>'
    g += f'<g clip-path="url(#notband)"><rect x="{X}" y="{Y}" width="{W}" height="{H}" rx="{R}" fill="url(#shell)"/></g>'
    for ly in (BAND_TOP - 3, BAND_BOTTOM - 3):
        g += f'<rect x="56" y="{ly - 4}" width="400" height="14" rx="7" fill="{CYAN}" opacity=".55" filter="url(#blur)"/>'
        g += f'<rect x="56" y="{ly}" width="400" height="6" rx="3" fill="url(#ray)"/>'
    return g


def svg(view_box, body, extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}"{extra}>{DEFS}{body}</svg>\n'


ICON_BG = f'<rect width="512" height="512" rx="114" fill="{INK}"/>'
FONT = "Inter, -apple-system, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif"


def wordmark(x, y, size, fg, muted):
    return (f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" font-weight="700" '
            f'letter-spacing="{-size * 0.03:.1f}" fill="{fg}">REA <tspan fill="{muted}" font-weight="500">GUI</tspan></text>')


def icon_at(x, y, size):
    return f'<g transform="translate({x} {y}) scale({size / 512})">{ICON_BG}{glyph()}</g>'


files = {
    # App icon (full bleed) and the bare mark (tile + beam, no background).
    "icon.svg": svg("0 0 512 512", ICON_BG + glyph()),
    "mark.svg": svg("48 88 416 336", glyph()),
    # macOS icon: Apple's grid keeps the shape at 824/1024 with transparent margin.
    "icon-macos.svg": svg("0 0 512 512", f'<g transform="translate(50 50) scale({412 / 512})">{ICON_BG}{glyph()}</g>'),
    "logo-dark.svg": svg("0 0 1200 320", f'<rect width="1200" height="320" fill="{INK}"/>' + icon_at(64, 64, 192) + wordmark(296, 200, 120, "#fafafa", "#a1a1aa")),
    "logo-light.svg": svg("0 0 1200 320", f'<rect width="1200" height="320" fill="#ffffff"/>' + icon_at(64, 64, 192) + wordmark(296, 200, 120, "#09090b", "#71717a")),
    "social.svg": svg("0 0 1280 640",
        f'<rect width="1280" height="640" fill="{INK}"/>' + icon_at(120, 170, 300) + wordmark(500, 300, 112, "#fafafa", "#a1a1aa")
        + f'<text x="504" y="372" font-family="{FONT}" font-size="34" fill="#a1a1aa">The open-source GUI for REA.</text>'
        + f'<text x="504" y="416" font-family="{FONT}" font-size="34" fill="#a1a1aa">Self-host it in one command.</text>'
        + f'<text x="504" y="482" font-family="ui-monospace, \'SF Mono\', Menlo, monospace" font-size="28" fill="{CYAN}">github.com/dominusmaster/rea-gui</text>'),
}
for name, text in files.items():
    (OUT / name).write_text(text)
    print("wrote", name)
