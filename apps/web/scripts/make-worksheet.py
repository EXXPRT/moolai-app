#!/usr/bin/env python3
"""Reproduce the web demo's sample worksheet (apps/web/public/sample-worksheet.png). Pillow 12.0.0, macOS Arial fonts.

Plain ASCII headers (c1, not c with a subscript) and units inside the cells, so screen reading can match the trial B
values a doubt names. The gateway pins the PNG's SHA-256 (WORKSHEET_SHA256 in backend/moolai_backend/demo_gateway.py),
so a new revision needs a new pin and a new seed.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / 'public' / 'sample-worksheet.png'
REG, BOLD = '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
W, H = 1280, 900
INK, MUTED, LINE, HEAD = (24, 36, 56), (86, 99, 120), (110, 122, 140), (235, 242, 255)
img = Image.new('RGB', (W, H), (243, 246, 250))
d = ImageDraw.Draw(img)
f = lambda size, bold=False: ImageFont.truetype(BOLD if bold else REG, size)
d.rounded_rectangle((36, 36, W - 36, H - 36), radius=22, fill=(255, 255, 255), outline=(200, 209, 222), width=2)
d.text((76, 74), 'Dilution worksheet', font=f(42, True), fill=INK)
d.text((76, 136), 'Use c1 V1 = c2 V2 to find the final volume V2 for each trial.', font=f(24), fill=MUTED)
d.line((76, 186, W - 76, 186), fill=(214, 221, 232), width=2)
d.text((90, 228), 'c1 V1 = c2 V2', font=f(58, True), fill=INK)
d.text((90, 322), 'c1, V1: stock solution.   c2, V2: diluted solution.', font=f(28), fill=MUTED)
cols, top, row_h = [90, 290, 590, 890, 1190], 420, 86
d.rectangle((cols[0], top, cols[-1], top + row_h), fill=HEAD)
for x in cols: d.line((x, top, x, top + 3 * row_h), fill=LINE, width=2)
for i in range(4): d.line((cols[0], top + i * row_h, cols[-1], top + i * row_h), fill=LINE, width=2)
for i, text in enumerate(['Trial', 'c1', 'V1', 'c2']): d.text((cols[i] + 24, top + 24), text, font=f(30, True), fill=INK)
for r, row in enumerate([['A', '2.50 mol/L', '40.0 mL', '0.50 mol/L'], ['B', '1.20 mol/L', '25.0 mL', '0.50 mol/L']], start=1):
    for i, text in enumerate(row): d.text((cols[i] + 24 + (6 if i else 0), top + r * row_h + 24), text, font=f(32), fill=INK)
d.text((90, 712), 'Water to add = V2 - V1. Show your working for trial A and trial B.', font=f(27), fill=INK)
d.text((76, 820), 'MOOLAI SAMPLE WORKSHEET  |  Synthetic content only', font=f(17), fill=MUTED)
img.save(OUT, optimize=True)
