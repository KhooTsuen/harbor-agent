# -*- coding: utf-8 -*-
"""验证 exe 里的图标到底是什么（直接读 PE 资源，不经过 Windows 图标缓存）。

踩过的坑：一开始用 shell32 的 ExtractIconEx 提取 —— 那个**会命中系统图标缓存**，
所以 exe 已经换了图标它还是给你看旧的，白高兴一场。读 PE 资源没有这个问题。

用法：python scripts/check-exe-icon.py [exe路径]
产物：把 exe 里最大那张图标导到 tmp/exe-icon.png
"""

import os
import sys

import pefile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist-portable", "Harbor", "Harbor.exe")
OUT = os.path.join(ROOT, "tmp", "exe-icon.png")


def main():
    if not os.path.exists(EXE):
        raise SystemExit(f"找不到 {EXE}（先 npm run package）")

    pe = pefile.PE(EXE, fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]]
    )

    icons = []
    for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        if entry.id != 3:  # RT_ICON
            continue
        for sub in entry.directory.entries:
            data_entry = sub.directory.entries[0].data
            data = pe.get_data(data_entry.struct.OffsetToData, data_entry.struct.Size)
            icons.append((len(data), data))

    if not icons:
        raise SystemExit("exe 里没有图标资源（set-icon.py 可能没生效）")

    icons.sort(reverse=True)
    biggest = icons[0][1]
    print(f"{os.path.basename(EXE)} 里有 {len(icons)} 张图标，最大 {len(biggest) // 1024} KB")
    kind = "PNG" if biggest[:8] == b"\x89PNG\r\n\x1a\n" else "DIB/BMP"
    print("格式:", kind, "（PNG 是 Vista 以后的写法，说明是重新生成的）")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if kind == "PNG":
        open(OUT, "wb").write(biggest)
        print("已导出 →", OUT, "（打开看一眼，确认是新图标）")
    else:
        print("是 DIB 格式，没直接导出（需要额外转码）")


if __name__ == "__main__":
    main()
