# 静态资源

- `fonts/` —— Inter 与 IBM Plex Mono（SIL OFL 1.1，授权见根目录 `THIRD-PARTY.md`）
- `icon*.png` —— 应用图标（**未纳入版本库**，打包时用 `scripts/set-icon.py` 写进 exe）

以前这里还有一套 ASCII 横幅（`aperture.txt` / `banner/`），
启动画面会用它做「重建 logo」的动画。公开前移除了 —— 那是《Portal》里 Aperture 的图形，
属于别人的美术，不适合放进仓库。

现在的启动标识是**自己算的**：`src/components/boot/bootFrames.ts` 里用 5×7 点阵拼出
`HARBOR`，不依赖任何现成艺术字库。
