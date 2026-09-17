"""Build the assets for the animated Aperture banner.

Produces:
  aperture-ring.b64  raw 8-bit density grid (244 x 124), base64
  wordmark.txt       the fixed 498 x 62 foreground lettering

The ring grid is the source art at twice the output resolution. The renderer
rotates it in memory and re-quantizes to ASCII every frame, so the characters
always stay upright while only the shape turns.
"""
from pathlib import Path
import base64

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'src/assets/banner'
OUT.mkdir(parents=True, exist_ok=True)

original = (ROOT / 'src/assets/aperture.txt').read_text().splitlines()
original = [line.ljust(498) for line in original]

# The letter A covers the ring's right half. The six-blade ring has 2-fold
# symmetry, so the hidden half is recovered by point reflection through the
# ring centre (this is what keeps the ring complete while it turns).
base = Image.new('L', (122, 62))
for y in range(62):
    for x in range(122):
        sx, sy = (x, y) if x < 61 else (121 - x, 61 - y)
        base.putpixel((x, y), {'@': 255, '.': 96, ' ': 0}[original[sy][sx]])

# 3x supersample. No blur on purpose: blurring widens the edge gradient, and
# quantizing a wide gradient is what turns a clean outline into speckle.
SCALE = 3
source = base.resize((122 * SCALE, 62 * SCALE), Image.Resampling.BICUBIC)

(OUT / 'aperture-ring.b64').write_text(
    base64.b64encode(source.tobytes()).decode('ascii'),
    encoding='ascii',
)


def write_lf(path: Path, content: str) -> None:
    """Force LF: the default newline on Windows would slip a CR into the art."""
    with path.open('w', encoding='utf-8', newline='\n') as file:
        file.write(content)


# Keep only the fixed original lettering; it is composited above the ring.
wordmark = []
for y in range(62):
    row = [' '] * 498
    if 17 <= y <= 39:
        boundary = round(121 - (y - 17) * 24 / 22) - 3
        row[boundary:] = original[y][boundary:]
    elif 44 <= y <= 51:
        row[155:] = original[y][155:]
    wordmark.append(''.join(row).rstrip())

write_lf(OUT / 'wordmark.txt', '\n'.join(wordmark))
print(f'Generated ring grid {source.size[0]} x {source.size[1]} + foreground wordmark')
