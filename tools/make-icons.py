#!/usr/bin/env python3
"""Draws the PNG icons from the same shapes as icons/icon.svg (needs Pillow, not part of the app).

iOS ignores the manifest and wants a 180 px PNG (apple-touch-icon); Chrome wants PNGs of 192 and
512 px to offer an install. Run from the repository root: python3 tools/make-icons.py
"""
from PIL import Image, ImageDraw

GREEN, PAPER = (11, 110, 92, 255), (241, 243, 239, 255)
SCALE = 8  # drawn this much larger, then reduced: smooth edges


def bezier(p0, p1, p2, p3, steps=200):
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        yield tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * d
                    for a, b, c, d in zip(p0, p1, p2, p3))


def draw(size, rounded, glyph):
    """`rounded`: transparent corners (the SVG); else full-bleed. `glyph`: share of the size."""
    big = size * SCALE
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 14 // 64 if rounded else 0, fill=GREEN)
    k = big / 64 * glyph  # SVG units -> pixels, shrunk around the centre
    off = big * (1 - glyph) / 2
    pt = lambda x, y: (off + x * k, off + y * k)
    path = list(bezier(pt(14, 40), pt(24, 40), pt(24, 24), pt(34, 24)))
    path += list(bezier(pt(34, 24), pt(44, 24), pt(42, 40), pt(52, 40)))
    r = 2.5 * k
    for x, y in path:
        d.ellipse((x - r, y - r, x + r, y + r), fill=PAPER)
    for x, y in (pt(14, 40), pt(52, 40)):
        d.ellipse((x - 5 * k, y - 5 * k, x + 5 * k, y + 5 * k), fill=PAPER)
    return img.resize((size, size), Image.LANCZOS)


for name, size, rounded, glyph in [
    ('icon-192.png', 192, True, 1.0),
    ('icon-512.png', 512, True, 1.0),
    ('icon-maskable-512.png', 512, False, 0.66),  # content inside the safe zone
    ('apple-touch-icon.png', 180, False, 0.82),  # iOS rounds the corners itself
]:
    draw(size, rounded, glyph).save(f'icons/{name}', optimize=True)
    print('icons/' + name)
