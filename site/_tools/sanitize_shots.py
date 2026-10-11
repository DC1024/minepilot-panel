# -*- coding: utf-8 -*-
"""
Redact sensitive pixels from the panel screenshots before publishing them.

Masked content:
  1. shots/security.png  -- a real 48-char PANEL_TOKEN was sitting in the
     "新令牌" input as the random-generate example.
  2. shots/server.png    -- the internal NAS LAN IP shown in the MOTD input.

Strategy: cover the sensitive value with an opaque rounded rectangle in the
panel's own input-field colour, then stamp a neutral placeholder so the
screenshot still reads as a real product UI.
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SHOTS = os.path.join(ROOT, "shots")
OUT = os.path.join(ROOT, "site", "assets")
os.makedirs(OUT, exist_ok=True)

FG = (143, 163, 192)        # --dim, the panel's secondary text colour
FIELD_BG = (9, 17, 32)      # #0a1120, the panel input background
FIELD_LINE = (34, 48, 74)   # --line


def load_font(size):
    for name in ("consola.ttf", "cour.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def stamp(draw, box, text, size, fill=FG):
    """Draw text centred inside box."""
    x0, y0, x1, y1 = box
    font = load_font(size)
    b = draw.textbbox((0, 0), text, font=font)
    w, h = b[2] - b[0], b[3] - b[1]
    draw.text((x0 + (x1 - x0 - w) / 2 - b[0], y0 + (y1 - y0 - h) / 2 - b[1]),
              text, font=font, fill=fill)


def redact_security():
    """Mask the real panel token shown in the '新令牌' input."""
    im = Image.open(os.path.join(SHOTS, "security.png")).convert("RGB")
    d = ImageDraw.Draw(im)
    # input box measured from the source: x ~10..990, y 258..309
    box = (10, 258, 990, 309)
    d.rounded_rectangle(box, radius=9, fill=FIELD_BG, outline=FIELD_LINE, width=1)
    stamp(d, box, "\u2022" * 30, 19)
    dst = os.path.join(OUT, "panel-security.png")
    im.save(dst, optimize=True)
    return dst


def redact_server():
    """Mask the internal LAN IP shown in the MOTD input."""
    im = Image.open(os.path.join(SHOTS, "server.png")).convert("RGB")
    d = ImageDraw.Draw(im)
    # input box measured from the source: x 167..360, y 635..668
    box = (167, 635, 360, 668)
    d.rounded_rectangle(box, radius=9, fill=FIELD_BG, outline=FIELD_LINE, width=1)
    stamp(d, box, "Minecraft AI Server", 13)
    dst = os.path.join(OUT, "panel-server.png")
    im.save(dst, optimize=True)
    return dst


def passthrough(name, out_name):
    im = Image.open(os.path.join(SHOTS, name)).convert("RGB")
    dst = os.path.join(OUT, out_name)
    im.save(dst, optimize=True)
    return dst


if __name__ == "__main__":
    for p in (redact_security(), redact_server(),
              passthrough("players.png", "panel-players.png"),
              passthrough("runtime.png", "panel-runtime.png")):
        print(p)
