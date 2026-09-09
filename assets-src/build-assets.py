"""Compose every Renki icon variant from the one mark in mark.svg.

Kept as a script because the same shape has to land in six places at different
scales, and because two of them have hard geometric constraints worth being
able to re-check: an Android adaptive foreground must stay inside the system's
circular mask, and a favicon has to survive 16px.

Sizes follow the design canvas, which grows the mark as the tile shrinks —
58% at icon size up to 64% at 24px — so it doesn't turn into a dot in a tab.
"""
import pathlib, re

SRC = pathlib.Path(__file__).parent
MARK = (SRC / "mark.svg").read_text()
PATH = re.search(r"<path[^>]*/>", MARK, re.S).group(0)

# The mark's own ink bounds. Each arc is a semicircle on the vertical axis, so
# the centreline spans x 22..88 (radii 28 left, 38 right) and y 12..88; the
# 13-wide round stroke adds 6.5 on every side. Its centre is therefore x=55,
# NOT the viewBox's 50 — placing it by viewBox would sit it visibly right of
# centre in a tile.
INK_X, INK_Y, INK_W, INK_H = 15.5, 5.5, 79.0, 89.0

AMBER = "#ec9d53"      # --renki-accent (dark theme)
DARK = "#2f1000"       # --renki-accent-fg: dark ink on the amber tile
GROUND = "#16100b"     # --renki-bg

def compose(scale: float, size: int = 512, radius_pct: float | None = None,
            bg: str = AMBER, fg: str = DARK) -> str:
    """The mark at `scale` of the tile's larger dimension, optically centred."""
    h = size * scale
    w = h * (INK_W / INK_H)
    x, y = (size - w) / 2, (size - h) / 2
    tile = "" if radius_pct is None else (
        f'<rect width="{size}" height="{size}" rx="{radius_pct * size:.1f}" fill="{bg}"/>\n  ')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  {tile}<svg x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" viewBox="{INK_X} {INK_Y} {INK_W} {INK_H}">
    <g color="{fg}">{PATH}</g>
  </svg>
</svg>
'''

ROOT = SRC.parent
OUTPUTS = {
    # Full-bleed square: iOS and legacy Android apply their own mask.
    SRC / "icon-square.svg": compose(0.58, radius_pct=0.0),
    # Android adaptive foreground: transparent, well inside the circular mask.
    SRC / "adaptive-foreground.svg": compose(0.50, radius_pct=None),
    # Rounded tile, as the sidebar header and README show it.
    ROOT / "docs/logo.svg": compose(0.60, radius_pct=0.22),
    # Favicon: the mark grows, because 16px is where a small mark disappears.
    ROOT / "apps/web/public/favicon.svg": compose(0.64, radius_pct=0.20),
}
for path, svg in OUTPUTS.items():
    path.write_text(svg)
    print("wrote", path.relative_to(ROOT))
