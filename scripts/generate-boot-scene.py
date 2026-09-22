# -*- coding: utf-8 -*-
"""把参考底图变成启动页的 ASCII 场景（生成 `src/assets/boot-scene/scene.b64`）。

产物是「每格一个字符 + 一个颜色 + 一个层」的网格，另有字符集、字形墨量表、
调色板、统一底色、灯室坐标。**不是** PNG —— 运行时逐格画到 canvas 上，
所以动画可以直接改字符（见 `src/ambient/`）。

挑字不是「亮度映射成字符」，而是**逐格按形状挑**：把 95 个可打印 ASCII
按同一字体渲染成掩膜，每格和原图那块像素做最小二乘（同时解出该染什么色），
取残差最小的字符。

两条踩过的坑，别再踩：
1. **ASCII 字符最多只覆盖约 46% 的格子**（18px 粗体 Consolas 的 `@`）。
   只给字符着色、不填格子，画面天生比底图暗一档 —— 所以用粗体 + 亮度补偿，
   并且强制「墨量跟着亮度走」，否则所有格子都会收敛到最密的那个字符。
2. **平坦区域里同墨量的字形残差几乎完全相等**，算法永远取第一个最优解 →
   全片一个字符。解法是在档内「残差并列」的一批字形里按格散列轮换：
   明暗不变，字形变丰富。

区域分析（每格归哪一层）在 `boot_scene_layers.py` 里做，而且用**底图**做 ——
字符网格的边界早被量化抹掉了，底图的颜色与梯度分得准得多。

用法
----
    python scripts/generate-boot-scene.py                     # 生成
    python scripts/generate-boot-scene.py --check             # 只打印诊断
    python scripts/generate-boot-scene.py --layers tmp/l.png  # 额外输出分层诊断图
    python scripts/generate-boot-scene.py --preview tmp/p.png # 生成 + 回渲染一张 PNG

需要 Pillow + numpy，不联网。字格依赖 Windows 自带的 Consolas（粗体）——
换机器复跑会略有差异，所以**产物入库**，脚本是为了以后想调参数能复跑。
"""

import base64
import io
import os
import struct
import string
import sys
import zlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import boot_scene_layers as layers  # noqa: E402  （同目录助手模块，见它的文件头）

SRC = os.path.join(ROOT, "src", "assets", "boot-scene", "source.png")
OUT = os.path.join(ROOT, "src", "assets", "boot-scene", "scene.b64")

# ── 网格 ──
# 4K（384x120 格 x 10x18px = 3840x2160）。运行时会按窗口尺寸隔点取样降到 1080p。
COLS, ROWS = 384, 120
CELL_W, CELL_H, FONT_PX = 10, 18, 18
FONT_PATH = "C:/Windows/Fonts/consolab.ttf"      # 粗体：覆盖率上限 33.7% -> 46.2%

# ── 色调 ──
BG = (8, 16, 30)          # 统一底色（比画面最暗处更暗，否则暗部画不出来）
LIFT = 0.72               # 底图先提亮：夜景太暗，不提亮暗部全糊

# ── 挑字 ──
BAND = 0.045              # 墨量档半宽
RMSE_SLACK = 6.0          # 「残差并列」判定（单位：灰度级）
TOPK = 6                  # 每格只在最优 K 个字形里轮换（K6 = 受控的丰富）
COV_FLOOR = 0.12          # 墨量下限，避免暗部整片退成空格
INK_GAIN = 1.22           # 补回「不填格子」损失的亮度
PALETTE_N = 224           # 颜色数（每格存 1 字节索引，所以到 255 为止都不涨体积）

CHARSET = " " + "".join(c for c in string.printable if 32 < ord(c) < 127)
MAGIC = b"HBS1"
VERSION = 3
# ★ 打包和解包必须共用同一个格式串。
#   第一版两边各写了一遍，一边 5 个 B、一边 7 个 —— 差两个字节，解出来全是错的。
#   字段依次：magic · 版本 · 列 · 行 · 格宽 · 格高 · 字号 · 调色板数 · 字符集长度 · 灯室列 · 灯室行 · 底色 RGB
HEAD_FMT = "<4sBHHBBBBBHHBBB"
# 版本 2 起，跟在字符集后面的是「每个字形的墨量」（动画要把「想多亮」换算成
# 「用哪个字符」）；版本 3 再跟一段「每格属于哪一层」。都放资源里，
# 不让前端算 —— 生成脚本本来就有一份字形掩膜与底图。

def load_masks():
    font = ImageFont.truetype(FONT_PATH, FONT_PX)
    masks = []
    for ch in CHARSET:
        tile = Image.new("L", (CELL_W, CELL_H), 0)
        if ch != " ":
            ImageDraw.Draw(tile).text((-1, -1), ch, font=font, fill=255)
        masks.append(np.asarray(tile, dtype=np.float32).reshape(-1) / 255.0)
    return np.array(masks)

def prepare_source():
    """按目标宽高比居中裁剪 → 提亮 → 缩放到像素网格。"""
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    want = (COLS * CELL_W) / (ROWS * CELL_H)
    if w / h > want:
        nw = int(h * want)
        im = im.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / want)
        im = im.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    arr = np.asarray(im, dtype=np.float32) / 255.0
    im = Image.fromarray((np.clip(arr, 0, 1) ** LIFT * 255).astype(np.uint8))
    return im.resize((COLS * CELL_W, ROWS * CELL_H), Image.LANCZOS)

def fit(im, masks):
    rgb = np.asarray(im, dtype=np.float32)
    mu = masks.sum(axis=1) / (CELL_W * CELL_H)
    mu_max = mu.max()
    patch = CELL_H * CELL_W
    P = rgb.reshape(ROWS, CELL_H, COLS, CELL_W, 3).transpose(0, 2, 1, 3, 4) \
           .reshape(ROWS * COLS, patch, 3).astype(np.float32)
    n = P.shape[0]
    bg = np.asarray(BG, dtype=np.float32)
    m_sum = masks.sum(axis=1)
    m_sq = (masks ** 2).sum(axis=1)
    m_rest = ((1 - masks) ** 2).sum(axis=1)

    a1 = np.empty((n, len(CHARSET), 3), dtype=np.float32)
    for c in range(3):
        a1[..., c] = P[:, :, c] @ masks.T
    # 只有字符着色（底色固定），按最小二乘解出墨色
    head = ((P ** 2).sum(axis=1).sum(axis=1)
            - 2 * (bg * P.sum(axis=1)).sum(axis=1))[:, None] \
        + 2 * (a1 * bg[None, None, :]).sum(axis=2) + (bg ** 2).sum() * m_rest[None, :]
    dot = a1 - bg[None, None, :] * (m_sum - m_sq)[None, :, None]
    resid = head - np.where(m_sq[None, :] > 1e-6,
                            (dot ** 2).sum(axis=2) / np.maximum(m_sq[None, :], 1e-9), 0)
    rmse = np.sqrt(np.maximum(resid, 0) / (patch * 3))

    # 目标墨量：亮度按 p2–p98 归一化后映射进实际可达的墨量区间
    lum = P.mean(axis=(1, 2)) / 255.0
    lo, hi = np.percentile(lum, 2), np.percentile(lum, 98)
    level = np.clip((lum - lo) / max(1e-6, hi - lo), 0, 1)
    target = mu_max * (COV_FLOOR + (1 - COV_FLOOR) * level)
    band = np.abs(mu[None, :] - target[:, None]) <= BAND

    # 档内取最优 K 个，再在「残差并列」的那几个里轮换
    masked = np.where(band, rmse, np.inf)
    keep = np.zeros_like(band)
    part = np.argpartition(masked, TOPK, axis=1)[:, :TOPK]
    np.put_along_axis(keep, part, True, axis=1)
    best = masked.min(axis=1)
    keep &= masked <= best[:, None] + RMSE_SLACK
    cnt = keep.sum(axis=1)

    xs = np.tile(np.arange(COLS), ROWS).astype(np.int64)
    ys = np.repeat(np.arange(ROWS), COLS).astype(np.int64)
    h = (xs * 73856093) ^ (ys * 19349663)
    h = (h ^ (h >> 13)) & 0x7FFFFFFFFFFFFFFF
    want = (h % np.maximum(cnt, 1)) + 1
    pick = np.argmax(np.cumsum(keep, axis=1) == want[:, None], axis=1)

    flat = pick.reshape(-1)
    sel = m_sq[flat]
    ink = np.zeros((n, 3), dtype=np.float32)
    good = sel > 1e-6
    ink[good] = dot[np.arange(n)[good], flat[good]] / sel[good, None] * INK_GAIN
    return pick.reshape(ROWS, COLS), np.clip(ink, 0, 255).reshape(ROWS, COLS, 3), \
        mu, cnt, mu_max

def find_lamp(im):
    """灯室位置：整幅最亮的那一点（灯塔的灯），光束要从这里射出去。"""
    small = im.resize((COLS, ROWS), Image.LANCZOS)
    lum = np.asarray(small.convert("L"), dtype=np.float32)
    lum[: int(ROWS * 0.10), :] = 0          # 排除最上面那几行天空
    row, col = np.unravel_index(int(np.argmax(lum)), lum.shape)
    peak = float(lum[row, col])
    # 落日带很亮但不是灯：真灯是接近白的，亮度要显著高于周围一圈
    around = lum[max(0, row - 6):row + 7, max(0, col - 6):col + 7]
    if peak - float(np.median(around)) < 30:
        print("⚠ 找不到足够突出的灯室（峰值 %.0f，周围中位 %.0f），用最亮列代替"
              % (peak, float(np.median(around))))
    return int(col), int(row)

def quantize(ink):
    """墨色量化到调色板（每格 1 字节索引）。"""
    small = Image.fromarray(np.clip(ink, 0, 255).astype(np.uint8), "RGB")
    q = small.quantize(colors=PALETTE_N, method=Image.FASTOCTREE, dither=Image.NONE)
    pal = q.getpalette()[: PALETTE_N * 3]
    table = [(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]) for i in range(PALETTE_N)]
    used = np.asarray(q, dtype=np.uint8)
    # ★ 必须 convert('RGB')：np.asarray(q) 拿到的是调色板**索引**，
    #   当成灰度读会算出一个完全错的误差（第一版就是 58 灰阶）
    back = np.asarray(q.convert("RGB"), dtype=np.float32)
    err = np.abs(back - np.clip(ink, 0, 255)).mean()
    return np.asarray(table, dtype=np.uint8), used, err

def pack(palette, coverage, layer, records, lamp):
    """records：每格 2 字节 [字符索引, 调色板索引]，按行优先排好。"""
    head = struct.pack(
        HEAD_FMT,
        MAGIC, VERSION, COLS, ROWS, CELL_W, CELL_H, FONT_PX,
        len(palette), len(CHARSET), lamp[0], lamp[1], *BG,
    )
    raw = head + CHARSET.encode("ascii") + coverage.tobytes() \
        + layer.astype(np.uint8).tobytes() + palette.tobytes() \
        + records.astype(np.uint8).tobytes()
    return zlib.compress(raw, 9)

def unpack_like_app(blob):
    """照 TS 侧的解码顺序走一遍 —— 保证「打包→解包」能原样还原。"""
    raw = zlib.decompress(blob)
    head = struct.calcsize(HEAD_FMT)
    magic, ver, cols, rows, cw, chh, fpx, pal_n, cs_n, lc, lr, br, bgc, bb = \
        struct.unpack(HEAD_FMT, raw[:head])
    assert magic == MAGIC and ver == VERSION, "头不对"
    assert (cols, rows) == (COLS, ROWS), "行列对不上"
    off = head
    charset = raw[off:off + cs_n].decode("ascii")
    off += cs_n
    coverage = np.frombuffer(raw[off:off + cs_n], dtype=np.uint8)
    off += cs_n
    layer = np.frombuffer(raw[off:off + cols * rows], dtype=np.uint8).reshape(rows, cols)
    off += cols * rows
    pal = np.frombuffer(raw[off:off + pal_n * 3], dtype=np.uint8).reshape(pal_n, 3)
    off += pal_n * 3
    grid = np.frombuffer(raw[off:off + cols * rows * 2], dtype=np.uint8).reshape(rows, cols, 2)
    assert grid[:, :, 1].max() < pal_n, "颜色索引越界"
    assert grid[:, :, 0].max() < cs_n, "字符索引越界"
    assert layer.max() <= 7, "层号越界"
    return dict(cols=cols, rows=rows, cw=cw, ch=chh, fpx=fpx, charset=charset,
                coverage=coverage, layer=layer, pal=pal,
                glyph=grid[:, :, 0], color=grid[:, :, 1],
                lamp=(lc, lr), bg=(br, bgc, bb))

def rust_render(scene, path, masks):
    """用解码出来的数据重新画一张图（= 应用里会看到的样子）。"""
    rgb = np.empty((scene["rows"], scene["cols"], CELL_H, CELL_W, 3), dtype=np.float32)
    rgb[:] = np.asarray(scene["bg"], dtype=np.float32)
    M = masks.reshape(len(CHARSET), CELL_H, CELL_W)
    for i in range(len(CHARSET)):
        sel = scene["glyph"] == i
        if not sel.any():
            continue
        m = M[i][None, None, :, :, None]
        ink = scene["pal"][scene["color"]][sel].astype(np.float32)[:, None, None, :]
        rgb[sel] = np.asarray(scene["bg"], dtype=np.float32) * (1 - m) + ink * m
    img = rgb.transpose(0, 2, 1, 3, 4).reshape(
        scene["rows"] * CELL_H, scene["cols"] * CELL_W, 3)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(path)
    return path

def main():
    check = "--check" in sys.argv
    preview = None
    lay_path = None
    for i, a in enumerate(sys.argv):
        if a == "--preview" and i + 1 < len(sys.argv):
            preview = sys.argv[i + 1]
        if a == "--layers" and i + 1 < len(sys.argv):
            lay_path = sys.argv[i + 1]
    masks = load_masks()
    im = prepare_source()
    pick, ink, mu, cnt, mu_max = fit(im, masks)
    palette, cells, err = quantize(ink)
    lamp = find_lamp(im)
    coverage = np.clip(np.round(masks.sum(axis=1) / (CELL_W * CELL_H) * 255), 0, 255) \
        .astype(np.uint8)
    layer, info = layers.analyze(im, COLS, ROWS, lamp)

    print("网格 %d x %d = %d 字符（%dx%d px/格）" % (COLS, ROWS, COLS * ROWS, CELL_W, CELL_H))
    print("字形覆盖率上限 %.3f（粗体）" % mu_max)
    print("用到 %d / %d 种字符，平均候选 %.1f" % (len(np.unique(pick)), len(CHARSET), cnt.mean()))
    got = mu[pick]
    print("实际墨量 p10=%.3f p50=%.3f p90=%.3f" % tuple(np.percentile(got, [10, 50, 90])))
    print("调色板 %d 色，量化平均误差 %.2f 灰阶" % (len(palette), err))
    print("灯室位置 列%d 行%d" % lamp)
    print("区域：地平线行 %d · 日落带 %d · 岛 %d 格 · 灯塔 %d 格 · 船 %d 格 · 窗 %d 格"
          % (info["horizon"], info["sunset"], info.get("island_cells", 0),
             info.get("lighthouse_cells", 0), info.get("boat_cells", 0),
             info.get("window_cells", 0)))
    if lay_path:
        counts = layers.diagnostics(layer, lay_path)
        print("分层诊断图已写入 %s" % lay_path)
        print("  各层格数：" + " · ".join("%s %d" % (k, v) for k, v in counts.items()))
    if check:
        return

    # ★ 每格两个字节：字符索引 + 颜色索引（第一版只打包了颜色索引，字符全丢了）
    records = np.stack([pick.astype(np.uint8), cells.astype(np.uint8)], axis=-1)
    blob = pack(palette, coverage, layer, records, lamp)
    b64 = base64.b64encode(blob).decode("ascii")
    io.open(OUT, "w", encoding="ascii", newline="\n").write(b64 + "\n")
    raw_len = struct.calcsize(HEAD_FMT) + len(CHARSET) * 2 + COLS * ROWS \
        + len(palette) * 3 + COLS * ROWS * 2
    print("原始 %d 字节 → 压缩 %d 字节 → base64 %d 字节" % (raw_len, len(blob), len(b64)))
    print("已写入 " + OUT)
    if preview:
        scene = unpack_like_app(blob)
        rust_render(scene, preview, masks)
        print("预览已写入 " + preview)
        print("解码核对：%dx%d 格 · 字符集 %d · 调色板 %d · 灯室 %s"
              % (scene["cols"], scene["rows"], len(scene["charset"]),
                 len(scene["pal"]), scene["lamp"]))

if __name__ == "__main__":
    main()
