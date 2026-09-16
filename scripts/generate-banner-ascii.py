"""Animate the user-provided solid Aperture mark; Pillow is build-time only."""
from pathlib import Path
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src/assets/banner'
original = (ROOT / 'src/assets/aperture.txt').read_text().splitlines()
original = [line.ljust(498) for line in original]
# The left half is unobstructed. The eight-blade mark has half-turn symmetry:
# recover the part hidden by A from the opposite half before rotation.
ring = Image.new('L', (122, 62))
for y in range(62):
    for x in range(122):
        sx, sy = (x, y) if x < 61 else (121-x, 61-y)
        ring.putpixel((x, y), {'@': 255, '.': 85, ' ': 0}[original[sy][sx]])
# Correct the non-square text cells before rotating, then sample back to ASCII.
ring = ring.resize((496, 496), Image.Resampling.BICUBIC)
frames = []
for index in range(96):
    rotated = ring.rotate(-index * 360 / 96, Image.Resampling.BICUBIC)
    rotated = rotated.resize((122, 62), Image.Resampling.LANCZOS)
    rows = []
    for y in range(62):
        row = [' '] * 498
        for x in range(122):
            value = rotated.getpixel((x, y))
            row[x] = '@' if value > 160 else '.' if value > 45 else ' '
        # Lettering stays in the original position and masks the ring behind A.
        if 17 <= y <= 39:
            boundary = round(121 - (y - 17) * 24 / 22) - 3
            row[boundary:] = original[y][boundary:]
        elif 44 <= y <= 51:
            row[155:] = original[y][155:]
        rows.append(''.join(row))
    frames.append('\n'.join(rows))
(OUT / 'aperture-frames.json').write_text(json.dumps(frames), encoding='utf-8')
print('Generated 96 clockwise frames: 498 x 62; original lettering in foreground')
