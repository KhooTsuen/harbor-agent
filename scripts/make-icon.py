# -*- coding: utf-8 -*-
"""把一张方形插画做成应用图标集（多尺寸 PNG + 多分辨率 ICO）。

为什么要圆角：原图是**方形 JPG**，不剪裁的话在浅色任务栏/桌面上会是个深色方块；
圆角之后它在任何底色上都像个图标，而且不会把画的内容裁掉多少（比圆形遮罩温和）。

产物：
    build/icon.png        512（打包用，electron-builder 自己会再缩）
    build/icon-128.png    128（托盘用）
    build/icon.ico        16/24/32/48/64/128/256 多分辨率（写进 exe）

用法：python scripts/make-icon.py <源图>
"""

import io
import os
import sys

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 圆角半径占边长的比例（Windows 11 风格大约 22%，这里取更圆一点的 24%）
RADIUS_RATIO = 0.24
# 超采样倍数：先在 4 倍画布上画圆角再缩小，边缘才不会有锯齿
SUPERSAMPLE = 4


def rounded(image: Image.Image) -> Image.Image:
    """给方形图加圆角 + 透明背景。"""
    size = image.size[0]
    big = size * SUPERSAMPLE
    src = image.convert("RGBA").resize((big, big), Image.LANCZOS)

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (big - 1, big - 1)], radius=int(big * RADIUS_RATIO), fill=255
    )

    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(src, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else ""
    if not source or not os.path.exists(source):
        raise SystemExit("用法：python scripts/make-icon.py <源图>")

    raw = Image.open(source)
    # 非正方形先居中裁成正方形（图标必须是方的）
    if raw.size[0] != raw.size[1]:
        side = min(raw.size)
        left = (raw.size[0] - side) // 2
        top = (raw.size[1] - side) // 2
        raw = raw.crop((left, top, left + side, top + side))

    base = rounded(raw)
    build = os.path.join(ROOT, "build")
    os.makedirs(build, exist_ok=True)

    base.resize((512, 512), Image.LANCZOS).save(os.path.join(build, "icon.png"))
    base.resize((128, 128), Image.LANCZOS).save(os.path.join(build, "icon-128.png"))

    # ICO：Windows 会在不同位置（任务栏 / 桌面 / 资源管理器）各取一个尺寸，
    # 所以必须打包多分辨率，不然小尺寸会是缩放糊的。
    base.resize((256, 256), Image.LANCZOS).save(
        os.path.join(build, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("图标集已生成（源图", raw.size, "→ 圆角", f"{RADIUS_RATIO:.0%}", "）：")
    for name in ["icon.png", "icon-128.png", "icon.ico"]:
        path = os.path.join(build, name)
        print(f"  build/{name:16s} {os.path.getsize(path) // 1024:4d} KB")


if __name__ == "__main__":
    main()
