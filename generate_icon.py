"""
Vaulty – V icon generator
Produces icon-16.png, icon-32.png, icon-48.png, icon-128.png
in extension/icons/ using an indigo brand palette.
"""

import math
from PIL import Image, ImageDraw

# ── Brand colours ─────────────────────────────────────────────────────────────
INDIGO_TOP    = (99,  102, 241)   # indigo-500
INDIGO_BOTTOM = (67,  56,  202)   # indigo-700
WHITE         = (255, 255, 255)
SIZES         = [16, 32, 48, 128]
OUT_DIR       = "extension/icons"

# ── Helpers ───────────────────────────────────────────────────────────────────

def rounded_rect_mask(size, radius_frac=0.22):
    """Return an L-mode mask for a rounded square."""
    mask = Image.new("L", (size, size), 0)
    d    = ImageDraw.Draw(mask)
    r    = max(1, int(size * radius_frac))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return mask


def vertical_gradient(size, top_rgb, bot_rgb):
    """Return an RGB image filled with a vertical linear gradient."""
    img = Image.new("RGB", (size, size))
    px  = img.load()
    for y in range(size):
        t  = y / (size - 1)
        r  = int(top_rgb[0] + (bot_rgb[0] - top_rgb[0]) * t)
        g  = int(top_rgb[1] + (bot_rgb[1] - top_rgb[1]) * t)
        b  = int(top_rgb[2] + (bot_rgb[2] - top_rgb[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def draw_v(draw, size, color):
    """
    Draw a bold geometric 'V' centred in the canvas.
    The V is built from two filled polygons (left arm, right arm).
    """
    s   = size
    pad = s * 0.16          # outer padding
    tip_x = s * 0.50        # horizontal centre
    tip_y = s * 0.74        # bottom apex

    # arm thickness scales with icon size
    thick = s * 0.175

    # ── left arm (top-left → apex) ─────────────────────────────────────────
    lx0, ly0 = pad,              pad               # outer top-left
    lx1, ly1 = pad + thick,      pad               # inner top-left
    apex_out  = (tip_x - thick * 0.38, tip_y)      # apex outer
    apex_in   = (tip_x,               tip_y - thick * 0.55)  # apex inner

    left_arm = [
        (lx0, ly0),
        (lx1, ly1),
        apex_in,
        apex_out,
    ]

    # ── right arm (top-right → apex) ───────────────────────────────────────
    rx0, ry0 = s - pad,          pad               # outer top-right
    rx1, ry1 = s - pad - thick,  pad               # inner top-right

    right_arm = [
        (rx0, ry0),
        (rx1, ry1),
        apex_in,
        apex_out,
    ]

    # mirror right arm through the centre x
    right_arm = [(2 * tip_x - x, y) for (x, y) in left_arm]

    draw.polygon(left_arm,  fill=color)
    draw.polygon(right_arm, fill=color)


def make_icon(size):
    SCALE = 4   # super-sample for anti-aliasing
    S     = size * SCALE

    # gradient background
    bg   = vertical_gradient(S, INDIGO_TOP, INDIGO_BOTTOM)
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    base.paste(bg, mask=rounded_rect_mask(S, radius_frac=0.22))

    # white V
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw  = ImageDraw.Draw(layer)
    draw_v(draw, S, WHITE)

    base = Image.alpha_composite(base, layer)

    # down-sample with LANCZOS for smooth edges
    icon = base.resize((size, size), Image.LANCZOS)
    return icon


# ── Main ──────────────────────────────────────────────────────────────────────
import os
os.makedirs(OUT_DIR, exist_ok=True)

for sz in SIZES:
    icon = make_icon(sz)
    path = f"{OUT_DIR}/icon-{sz}.png"
    icon.save(path, "PNG")
    print(f"  ✓  {path}  ({sz}×{sz})")

print("\nDone. All icons written to", OUT_DIR)
