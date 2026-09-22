# -*- coding: utf-8 -*-
"""启动页场景的**区域分析**（给 `generate-boot-scene.py` 用）。

文档要的是「Scene Layer」。我们只有一张烘焙好的底图，分不出真图层，
所以按文档允许的兜底做法：从底图里**分析出区域**，把每格归到一个层，
把层号一起写进资源 —— 运行时不做任何分割，读表就行。

为什么用底图分析而不是字符网格：字符网格是「墨量 + 颜色」的量化结果，
边界早被抹掉了；底图（2048×1152）里有真正的颜色与梯度，分得准得多。

三条踩出来的经验（别再改回去）：
1. **地平线要用颜色判据，不是亮度**。日落带很亮、海面也亮，
   亮度阈值切不准；而「暖色（r>b）→ 冷色（b>r）」的切换点非常干净。
2. **岛不能用「比本行暗」来判**。岛上有草、有亮石，暗的只是岩石，
   按亮度切出来是一堆散块；改成「偏蓝程度远低于本行中位数」= 陆地，
   再**膨胀合并**附近碎块，最大连通块就是岛。
3. **`ImageDraw.floodfill` 在 'L' 图上不生效**（实测填完一个像素都没变），
   所以这里自己写四连通填充。

层号与 `src/ambient/layers.ts` 的常量一一对应，改一边要改另一边。
"""

import numpy as np
from PIL import Image

SKY, OCEAN, ISLAND, LIGHTHOUSE, BOAT, REFLECTION, WINDOW = 1, 2, 3, 4, 5, 6, 7

NAMES = {SKY: "sky", OCEAN: "ocean", ISLAND: "island", LIGHTHOUSE: "lighthouse",
         BOAT: "boat", REFLECTION: "reflection", WINDOW: "window"}

COLORS = {SKY: (30, 40, 80), OCEAN: (20, 70, 110), ISLAND: (40, 110, 60),
          LIGHTHOUSE: (230, 230, 120), BOAT: (220, 60, 60),
          REFLECTION: (200, 120, 220), WINDOW: (255, 160, 40)}


def _flood(mask, seed):
    """从 seed 四连通填充（自己写：PIL 的 floodfill 在 L 图上不生效）。"""
    h, w = mask.shape
    out = np.zeros_like(mask)
    sx, sy = seed
    if not (0 <= sx < w and 0 <= sy < h) or not mask[sy, sx]:
        return out
    out[sy, sx] = True
    stack = [(sx, sy)]
    while stack:
        x, y = stack.pop()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                stack.append((nx, ny))
    return out


def _grow(mask, rounds=2):
    """把相邻一两格的碎块并起来（岛上有草有亮石，实测会裂成好几块）。"""
    out = mask.copy()
    for _ in range(rounds):
        shift = out.copy()
        shift[1:, :] |= out[:-1, :]
        shift[:-1, :] |= out[1:, :]
        shift[:, 1:] |= out[:, :-1]
        shift[:, :-1] |= out[:, 1:]
        out = shift
    return out


def _horizon(rgb, lum):
    """地平线 = 日照带往下、「暖色→冷色」的切换点。"""
    rows = lum.mean(axis=1)
    peak = int(np.argmax(rows[: int(len(rows) * 0.7)]))
    warm = np.median(rgb[:, :, 0] - rgb[:, :, 2], axis=1)
    for y in range(peak + 1, int(len(rows) * 0.8)):
        if warm[y] < 0 and rows[y] < rows[peak] * 0.72:
            return y, peak
    return int(len(rows) * 0.5), peak


def analyze(im, gw, gh, lamp):
    """返回 (layer, info)。im 是已按目标宽高比裁剪过的底图。"""
    small = im.resize((gw, gh), Image.BOX).convert("RGB")
    rgb = np.asarray(small, dtype=np.float32)
    lum = (0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]) / 255.0

    hy, peak = _horizon(rgb, lum)
    layer = np.full((gh, gw), SKY, np.uint8)
    layer[hy:, :] = OCEAN
    info = {"horizon": int(hy), "sunset": int(peak)}

    # ── 岛：偏蓝程度远低于本行中位数 = 陆地；膨胀合并后取最大连通块 ──
    blue = rgb[:, :, 2] - rgb[:, :, 0]
    med_blue = np.median(blue, axis=1, keepdims=True)
    med_lum = np.median(lum, axis=1, keepdims=True)
    top, bottom = max(0, hy - 2), min(gh, hy + 32)
    land = np.zeros((gh, gw), bool)
    land[top:bottom] = (blue[top:bottom] < 0.5 * med_blue[top:bottom]) \
        & (lum[top:bottom] < 0.95 * med_lum[top:bottom])
    if land.any():
        grown = _grow(land, 2)
        seed = np.unravel_index(int(np.argmin(np.where(land, lum, 9))), lum.shape)
        core = _flood(grown, (int(seed[1]), int(seed[0]))) & land
        # 再长一圈：岛上有草、有亮石，只标黑岩石的话海水会从缝里动起来
        island = _grow(core, 2) & grown
        layer[island] = ISLAND
        info["island_cells"] = int(island.sum())

    # ── 灯塔：灯室周围那根比周边亮的柱子（塔身是白的，本来就比天空亮） ──
    lc, lr = lamp
    y0, y1 = max(0, lr - 10), min(gh, hy + 4)
    x0, x1 = max(0, lc - 10), min(gw, lc + 10)
    patch = lum[y0:y1, x0:x1]
    bright = np.zeros((gh, gw), bool)
    bright[y0:y1, x0:x1] = patch > np.median(patch) * 1.1
    tower = _flood(bright, (lc, lr))
    tower[:y0] = False
    tower[y1:] = False
    tower[:, :x0] = False
    tower[:, x1:] = False
    layer[tower] = LIGHTHOUSE
    info["lighthouse_cells"] = int(tower.sum())

    # ── 渔船：下半屏里「紧致的亮块」才是船（灯窗 + 白船体）──
    # 不能直接取最亮的格子 —— 实测取到的是灯塔倒影那一列里最亮的一点。
    y0, y1 = hy + 10, min(gh, gh - 3)
    water_bright = np.zeros((gh, gw), bool)
    water_bright[y0:y1] = lum[y0:y1] > 0.3
    blue = rgb[:, :, 2] - rgb[:, :, 0]
    cand = []
    seen = np.zeros((gh, gw), bool)
    for yy in range(y0, y1):
        for xx in range(gw):
            if not water_bright[yy, xx] or seen[yy, xx]:
                continue
            blob = _flood(water_bright, (xx, yy))
            seen |= blob
            n = int(blob.sum())
            ys, xs = np.where(blob)
            wide, tall = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
            # 船是一个小方块；倒影是一条竖带（又高又窄），这里排掉
            if n < 12 or wide > 40 or tall > 20:
                continue
            cand.append((float(lum[blob].max()), int(xs.mean()), int(ys.mean())))
    if cand:
        _, bx, by = max(cand)
        box = np.zeros((gh, gw), bool)
        ry0, ry1 = max(0, by - 9), min(gh, by + 9)
        rx0, rx1 = max(0, bx - 14), min(gw, bx + 14)
        # 船体是暗的（不蓝）而水是蓝的 —— 拿偏蓝度把暗船体一起拉进来
        med_blue = np.median(blue, axis=1, keepdims=True)
        body = (blue < 0.55 * med_blue) | water_bright
        box[ry0:ry1, rx0:rx1] = body[ry0:ry1, rx0:rx1]
        boat = _flood(box, (bx, by)) & box
        boat = _grow(boat, 1)
        layer[boat] = BOAT
        info["boat_cells"] = int(boat.sum())
        info["boat_at"] = (int(bx), int(by))

    # ── 倒影：水面上那一条被照亮的竖带（实测不在灯室正下方，相机有透视偏移）──
    # 用「水平地平线往下那一带的列均值最亮处」找它，而不是用灯室列。
    band = lum[hy + 1:min(gh, hy + 35)]
    if band.size:
        col = int(np.argmax(band.mean(axis=0)))
    else:
        col = lc
    info["reflection_col"] = col
    reflect = np.zeros((gh, gw), bool)
    for cx, half in ((col, 7), (info.get("boat_at", (lc, 0))[0], 5)):
        reflect[hy:, max(0, cx - half):min(gw, cx + half)] = True
    reflect &= layer == OCEAN
    layer[reflect] = REFLECTION

    # ── 窗：岛上几处亮点（房子亮着的窗） ──
    if (layer == ISLAND).any():
        isl = layer == ISLAND
        win = isl & (lum > float(np.median(lum[isl])) * 1.9 + 0.04)
        layer[win] = WINDOW
        info["window_cells"] = int(win.sum())

    return layer, info


def diagnostics(layer, path, scale=3):
    """把层画成一张彩色图（自己看分层对不对，比数字直观）。"""
    gh, gw = layer.shape
    img = Image.new("RGB", (gw, gh), (0, 0, 0))
    px = img.load()
    for y in range(gh):
        for x in range(gw):
            px[x, y] = COLORS[int(layer[y, x])]
    img.resize((gw * scale, gh * scale), Image.NEAREST).save(path)
    return {NAMES[k]: int((layer == k).sum()) for k in NAMES}
