# Animated ASCII banner

Current artwork derives from the user-provided `../aperture.txt`.
The solid eight-blade ring rotates clockwise behind the original fixed lettering.
The unobstructed left half supplies the hidden half using half-turn symmetry.
Text-cell aspect ratio is corrected before raster rotation; the lettering and
its clearance region are composited in front, including the overlapping A.
96 frames, 498 columns × 62 rows, 8 FPS, one full rotation in 12 seconds.

Rebuild: `python scripts/generate-banner-ascii.py` (Pillow required, no network).
Runtime is local ASCII text; hidden documents pause; reduced motion is respected.

Earlier unused reference: Lucide aperture SVG, downloaded 2026-09-17 from
https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/aperture.svg
(https://lucide.dev/icons/aperture). `aperture.svg` and `LICENSE` retain the
original ISC/Feather notices. This line icon is no longer used by the animation.
The user-provided brand artwork is not covered by Lucide's license.
