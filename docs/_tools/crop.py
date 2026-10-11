# -*- coding: utf-8 -*-
"""Crop a region of a screenshot so mask coordinates can be confirmed by eye."""
import sys
from PIL import Image

im = Image.open(sys.argv[1])
x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
out = sys.argv[6]
crop = im.crop((x0, y0, x1, y1))
print("crop size:", crop.size)
crop.save(out)
