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

- `build/icon.png` / `icon-128.png` / `icon.ico` —— 应用图标，由仓库主人用 AI 图像工具生成后
  用 `scripts/make-icon.py` 处理（圆角剪裁 + 多尺寸）。生成脚本在仓库里，可自行替换
- 启动页那个字标（`src/assets/wordmark.txt`）**不是素材** —— 由 `scripts/generate-wordmark.py`
  用系统字体现场渲染成点阵，仓库里那份是它的输出
- 界面图标来自 [Lucide](https://lucide.dev)（ISC 许可）

> 三者都可以自由替换；发布产物里不含任何来源不明的第三方美术。
