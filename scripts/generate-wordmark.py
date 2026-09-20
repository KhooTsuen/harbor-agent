# -*- coding: utf-8 -*-
"""把 HARBOR 渲染成高分辨率点阵（启动页那个字标）。

为什么要有这个脚本
------------------
启动页的字标原来是《Portal》里 Aperture 的 ASCII 图（别人的美术，公开前移除了）。
第一版替身我手写了一张 5×7 的点阵表 —— **太小了**，缩到屏幕上就一小坨。

现在的做法：用系统字体把 HARBOR 画出来，再转成灰度点阵。
素材是自己的（字形只是"用系统字体渲染的文字"，不涉及任何现成艺术字库或外部图片），
分辨率也够 —— 输出 490 字符宽，缩放后边缘很干净。

两个坑（都踩过）
----------------
1. **终端字符是宽:高 ≈ 1:2**。想让屏幕上的形状不变形，网格的"字符比例"要按这个换算：
   宽 490 字符、高 N 字符，实际显示出来是 490 : 2N。
2. **行尾空格活不过 git 和编辑器**（会被 trim 掉），所以字标要**填满整个网格宽度**，
   不能靠两侧留白来居中 —— 那是把居中托付给"空格不会被删"，迟早出事。

用法：python scripts/generate-wordmark.py（需要 Pillow，不联网）
产物：`src/assets/wordmark.txt`
"""

import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# Windows 控制台默认 GBK，打不出方块字符 —— 只影响本脚本的预览输出
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "assets", "wordmark.txt")

WORD = "HARBOR"
# Bahnschrift 是 Windows 10+ 自带的几何无衬线体，做字标比 Arial 更像 logo
FONT_CANDIDATES = [
    ("C:/Windows/Fonts/bahnschrift.ttf", "Bahnschrift"),
    ("C:/Windows/Fonts/arialbd.ttf", "Arial Bold"),
    ("C:/Windows/Fonts/segoeuib.ttf", "Segoe UI Bold"),
]

# 目标网格宽度（字符数）。原来那套 ASCII 图是 498 —— 保持同一量级，
# 启动页按容器宽度反推字号，字符越多边缘越干净。
TARGET_COLS = 490
# 终端字符宽:高 ≈ 1:2，换算形状时要用它补偿
CHAR_ASPECT = 2.0
# 字母之间的间距（占字高的比例）
TRACKING = 0.10
# 灰度 → 字符（密到疏）
RAMP = "█▓▒░· "
# 低于这个亮度当背景，避免一片噪点
FLOOR = 0.55


def pick_font(size):
    for path, name in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size), name
    raise SystemExit("没找到可用的系统字体")


def render_bitmap():
    """画字（带字距）→ 裁到内容边界 → 缩到目标网格。"""
    font, font_name = pick_font(360)
    probe = ImageDraw.Draw(Image.new("L", (10, 10)))

    boxes = [probe.textbbox((0, 0), ch, font=font) for ch in WORD]
    widths = [box[2] - box[0] for box in boxes]
    height = max(box[3] - box[1] for box in boxes)
    spacing = int(height * TRACKING)

    text_w = sum(widths) + spacing * (len(WORD) - 1)
    pad = int(height * 0.06)
    big = Image.new("L", (text_w + pad * 2, height + pad * 2), 0)
    draw = ImageDraw.Draw(big)
    x = pad
    for ch, box, width in zip(WORD, boxes, widths):
        draw.text((x - box[0], pad - box[1]), ch, font=font, fill=255)
        x += width + spacing

    # 裁到真正有内容的地方：这样字标会**填满**整个网格宽度，
    # 行尾空格被 trim 也不影响居中。
    content = big.getbbox()
    cropped = big.crop(content)
    cw, chh = cropped.size
    rows = max(1, round(TARGET_COLS * (chh / cw) / CHAR_ASPECT))
    return cropped.resize((TARGET_COLS, rows), Image.LANCZOS), rows, font_name


def main():
    small, rows, font_name = render_bitmap()
    lines = []
    for y in range(rows):
        cells = []
        for x in range(small.width):
            value = small.getpixel((x, y)) / 255.0
            if value < FLOOR:
                cells.append(" ")
            else:
                index = int((1.0 - value) / (1.0 - FLOOR) * (len(RAMP) - 1))
                cells.append(RAMP[min(index, len(RAMP) - 1)])
        lines.append("".join(cells).rstrip())

    text = "\n".join(lines) + "\n"
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(text)
    width = max(len(line) for line in lines)
    print(f"字体 {font_name} · 网格 {width}x{rows} · {len(text)} 字符 → {OUT}")
    for line in lines[:10]:
        print(line[:150].replace("█", "#").replace("▓", "%").replace("▒", "+").replace("░", "."))


if __name__ == "__main__":
    main()
