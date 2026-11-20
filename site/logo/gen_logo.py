#!/usr/bin/env python3
"""Generate the Leash logo as SVG (deterministic, no dependencies).

logo.svg   the full mark: a triangular lattice (the post-quantum part) fading out from a gradient leash that runs from the
           agent's node to a guard with a keyhole. Use it large (hero, cover, social).
mark.svg   the same idea without the lattice, tuned to stay legible at 16 to 48 px (nav, footer, favicon).

    python3 site/logo/gen_logo.py        # writes site/assets/logo.svg, mark.svg and favicon.svg
"""
import math, random
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets"
C = ("#50e3c2", "#007cf0", "#7928ca", "#ff0080")  # the gradient: cyan, blue, violet, magenta

def grad(id_, x1, y1, x2, y2, stops=C):
    s = "".join(f'<stop offset="{i/(len(stops)-1):.2f}" stop-color="{c}"/>' for i, c in enumerate(stops))
    return f'<linearGradient id="{id_}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{s}</linearGradient>'

# the leash: an S-curve from the agent (bottom left) to the guard (top right)
AGENT = (150, 340)
GUARD = (352, 170)
LEASH = "M150 340 C150 438 318 450 322 342 C326 268 352 262 352 206"

def keyhole(cx, cy, k=1.0, fill="#000"):
    r = 11 * k
    return (f'<circle cx="{cx}" cy="{cy - 5 * k}" r="{r}" fill="{fill}"/>'
            f'<path d="M{cx - 6.5 * k} {cy + 4 * k} L{cx - 10 * k} {cy + 26 * k} H{cx + 10 * k} L{cx + 6.5 * k} {cy + 4 * k} Z" fill="{fill}"/>')

def glyph(sw=17, halo=36, glow=True, gs=1.0, links=True):
    g = [f'<path d="{LEASH}" fill="none" stroke="#000" stroke-width="{halo}" stroke-linecap="round"/>']
    if glow:
        g.append(f'<path d="{LEASH}" fill="none" stroke="url(#gl)" stroke-width="{sw + 14}" stroke-linecap="round" opacity=".5" filter="url(#blur)"/>')
    g.append(f'<path d="{LEASH}" fill="none" stroke="url(#gl)" stroke-width="{sw}" stroke-linecap="round"/>')
    if links:  # leash links and a highlight
        g.append(f'<path d="{LEASH}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="{sw + 2}" stroke-dasharray="2.2 17" />')
        g.append(f'<path d="{LEASH}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round" transform="translate(-4 -4)"/>')
    ax, ay = AGENT; gx, gy = GUARD
    # agent: a node with a halo ring
    g.append(f'<circle cx="{ax}" cy="{ay}" r="{44*gs:.1f}" fill="none" stroke="#50e3c2" stroke-opacity=".45" stroke-width="2"/>')
    g.append(f'<circle cx="{ax}" cy="{ay}" r="{31*gs:.1f}" fill="#000"/><circle cx="{ax}" cy="{ay}" r="{25*gs:.1f}" fill="url(#gl)"/><circle cx="{ax}" cy="{ay}" r="{9*gs:.1f}" fill="#000"/>')
    # guard: a rounded square with a keyhole, and a corner-bracket frame
    a, b_, c = 58 * gs, 46 * gs, 41 * gs
    g.append(f'<rect x="{gx - a:.1f}" y="{gy - a:.1f}" width="{2*a:.1f}" height="{2*a:.1f}" rx="{30*gs:.1f}" fill="none" stroke="#ff0080" stroke-opacity=".5" stroke-width="2"/>')
    g.append(f'<rect x="{gx - b_:.1f}" y="{gy - b_:.1f}" width="{2*b_:.1f}" height="{2*b_:.1f}" rx="{24*gs:.1f}" fill="#000"/><rect x="{gx - c:.1f}" y="{gy - c:.1f}" width="{2*c:.1f}" height="{2*c:.1f}" rx="{20*gs:.1f}" fill="#fff"/>')
    g.append(keyhole(gx, gy - 1, k=gs))
    return "".join(g)

def defs(with_lattice=True):
    d = [grad("gl", 120, 420, 380, 150), grad("gd", 0, 512, 512, 0),
         '<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>']
    if with_lattice:
        d.append('<radialGradient id="fade" cx="256" cy="256" r="236" gradientUnits="userSpaceOnUse"><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#555"/></radialGradient>')
        d.append('<mask id="m"><rect width="512" height="512" fill="url(#fade)"/></mask>')
    return "<defs>" + "".join(d) + "</defs>"

def lattice(seed=7):
    rnd = random.Random(seed)
    s = 31.0
    pts = []
    for j in range(-9, 10):
        for i in range(-10, 11):
            x = 256 + i * s + (j % 2) * s / 2
            y = 256 + j * s * 0.866
            d = math.hypot(x - 256, y - 256)
            if d <= 232:
                pts.append((x, y, d))
    dots, lines = [], []
    for x, y, d in pts:
        r = max(1.3, 3.8 * (1 - d / 270))
        dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>')
    # a sparse set of lattice edges, so it reads as a lattice and not a dot screen
    idx = {(round(x, 1), round(y, 1)): d for x, y, d in pts}
    for x, y, d in pts:
        for dx, dy in ((s, 0), (s / 2, s * 0.866), (-s / 2, s * 0.866)):
            q = (round(x + dx, 1), round(y + dy, 1))
            if q in idx and rnd.random() < 0.38:
                lines.append(f'M{x:.1f} {y:.1f}L{q[0]} {q[1]}')
    return ('<g mask="url(#m)"><path d="' + "".join(lines) + '" stroke="url(#gd)" stroke-width="1.2" stroke-opacity=".75" fill="none"/>'
            '<g fill="url(#gd)" fill-opacity=".9">' + "".join(dots) + '</g></g>')

def full():
    rings = ('<circle cx="256" cy="256" r="244" fill="none" stroke="url(#gd)" stroke-width="2.5"/>'
             '<circle cx="256" cy="256" r="232" fill="none" stroke="url(#gd)" stroke-width="1.4" stroke-dasharray="1.5 9" stroke-linecap="round" opacity=".7"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Leash">' + defs(True)
            + '<circle cx="256" cy="256" r="250" fill="#000"/>' + lattice() + rings + glyph() + "</svg>")

def mark():
    # legible at small sizes: no lattice, thicker leash, one ring
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Leash">' + defs(False)
            + '<rect width="512" height="512" rx="120" fill="#000"/><rect x="6" y="6" width="500" height="500" rx="114" fill="none" stroke="url(#gd)" stroke-width="10"/>'
            + '<g transform="translate(256 256) scale(1.08) translate(-256 -262)">' + glyph(sw=28, halo=50, glow=False, gs=1.32, links=False) + "</g></svg>")

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "logo.svg").write_text(full())
    m = mark()
    (OUT / "mark.svg").write_text(m)
    (OUT / "favicon.svg").write_text(m)
    print("wrote logo.svg, mark.svg, favicon.svg to", OUT)
