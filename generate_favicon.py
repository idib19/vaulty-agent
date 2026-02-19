#!/usr/bin/env python3
"""Generate a Vaulty branded favicon and save to web/app/favicon.ico"""

try:
    from PIL import Image, ImageDraw
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "Pillow"])
    import importlib
    importlib.invalidate_caches()
    from PIL import Image, ImageDraw

import math
import os

def make_vaulty_favicon(size=64):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- Background: rounded square with deep navy/slate gradient simulation ---
    bg_color = (15, 23, 42)       # slate-900
    accent    = (99, 102, 241)    # indigo-500
    highlight = (139, 92, 246)    # violet-500

    radius = size // 5

    # Rounded rectangle background
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=bg_color)

    # Subtle top-left highlight arc to simulate gradient
    for i in range(4):
        alpha = max(0, 60 - i * 15)
        overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rounded_rectangle([(i, i), (size - 1 - i, size - 1 - i)],
                              radius=radius, outline=(*highlight, alpha), width=1)
        img = Image.alpha_composite(img, overlay)

    draw = ImageDraw.Draw(img)

    # --- Draw a bold "V" using polygon geometry ---
    margin = size * 0.18
    top_y   = size * 0.22
    bot_y   = size * 0.78
    mid_x   = size / 2
    thick   = size * 0.13   # half-width of each arm

    # Left arm of V (outer, inner)
    left_outer_x  = margin
    left_inner_x  = margin + thick * 1.6
    right_outer_x = size - margin
    right_inner_x = size - margin - thick * 1.6

    v_poly = [
        (left_outer_x,  top_y),          # top-left outer
        (left_inner_x,  top_y),          # top-left inner
        (mid_x,          bot_y - thick * 0.9),  # bottom inner
        (right_inner_x, top_y),          # top-right inner
        (right_outer_x, top_y),          # top-right outer
        (mid_x,          bot_y),         # bottom tip
    ]

    # Fill with indigo→violet gradient simulation via two overlapping fills
    draw.polygon(v_poly, fill=accent)

    # Overlay right half slightly lighter (violet) for a two-tone effect
    right_half = [
        (mid_x,          top_y),
        (right_inner_x, top_y),
        (right_outer_x, top_y),
        (mid_x,          bot_y),
    ]
    overlay2 = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od2 = ImageDraw.Draw(overlay2)
    od2.polygon(right_half, fill=(*highlight, 200))
    img = Image.alpha_composite(img, overlay2)

    return img


def save_favicon(path):
    sizes = [16, 32, 48, 64]

    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Pillow's ICO saver needs the largest image passed with explicit size list
    largest = make_vaulty_favicon(sizes[-1])
    largest.save(
        path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
    )
    print(f"✓ Favicon saved → {path}")
    print(f"  Sizes embedded: {sizes}")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "web", "app", "favicon.ico")
    save_favicon(out)
