# 第三方素材与依赖

这个项目分发的东西里，有一部分不是我写的。列清楚。

## 字体

| 文件 | 字体 | 授权 |
| --- | --- | --- |
| `src/assets/fonts/inter.woff2` | Inter | SIL Open Font License 1.1 |
| `src/assets/fonts/plex-mono-400.woff2` | IBM Plex Mono | SIL Open Font License 1.1 |
| `src/assets/fonts/plex-mono-500.woff2` | IBM Plex Mono | SIL Open Font License 1.1 |

OFL 允许随软件分发（含商用），条件是**保留版权声明**（上面这张表就是）。
字体本身的完整授权文本见各自官网：https://rsms.me/inter/ · https://www.ibm.com/plex/

## 依赖

运行时依赖都是宽松许可（MIT / ISC / Apache-2.0 / BSD），没有 GPL 系。
完整清单见 `package-lock.json`；照常 `npm install` 即可。

## 图形素材

- `src/assets/banner/*`、`src/assets/aperture.txt` —— 见
  `src/assets/banner/README.md` 的说明（来源与重建方式都写在那边）
- `build/icon*.png`、`src/assets/icon*.png` —— 应用图标
- 界面图标来自 [Lucide](https://lucide.dev)（ISC 许可）

> ⚠️ 上面「图形素材」里，横幅（ASCII 艺术）与图标的**原始来源需要在公开前确认**
> —— 见 `docs/发布清单.md` 里那条待办。
