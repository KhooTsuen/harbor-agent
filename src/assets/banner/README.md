# Animated ASCII banner

The artwork derives from the user-provided `../aperture.txt`.

Runtime composition, bottom to top:

1. **Ring** — ASCII generated every frame from a stored density grid, so the
   characters stay upright and only the shape turns.
2. **Mask** — a sloped cut along the left edge of the letter A (`clipPath`),
   sized from the real glyph so the rotating blades cannot show through.
3. **Wordmark** — the original fixed lettering.

Assets:

- `aperture-ring.b64`: raw 8-bit density grid, 366 x 186 (3x of the 122 x 62
  output grid), base64 so the trailing spaces of the art survive git and editors.
- `wordmark.txt`: the fixed 498 x 62 foreground lettering.

Why runtime sampling instead of pre-rendered character frames: 60 FPS needs
hundreds of 122 x 62 character frames (megabytes), and any change to the speed
would require regenerating all of them. The grid is ~89 KB and works at any angle.

The grid is deliberately **not blurred**. Blurring widens the edge gradient, and
quantizing a wide gradient is what turns a clean outline into speckle; the
supersampled grid plus bilinear sampling already gives smooth edges.

The ring's right half is hidden by the letter A in the source art; the six-blade
ring is 2-fold symmetric, so the missing half is recovered by point reflection
through the centre.

Rotation runs on `requestAnimationFrame` (display refresh rate, up to 60 FPS),
pauses while the window is hidden, and stops under `prefers-reduced-motion`.
One full turn takes 12 seconds.

Rebuild with `python scripts/generate-banner-ascii.py` (Pillow required, no network).
