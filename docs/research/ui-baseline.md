# UI 调研基线（ui-baseline）

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0
> 性质：只读调研。本文件记录**可复现的事实基线**，不改任何生产源码。
> 采集时间：2026-10-11（本机）

## 1. 代码与版本

| 项 | 值 | 来源 |
|---|---|---|
| HEAD | `847cfc34ca62a74513a63c797822e6bedb9ae2f3` | `git rev-parse HEAD` |
| 分支 | `main` | `git branch --show-current` |
| 工作区 | 干净（`git status --short` 空） | `git status` |
| 应用版本 | `1.30.0-beta.16` | `package.json` |

调研过程中**未修改**任何产品源码、样式、Token、文案、Prompt、配置默认值、Runtime、IPC、数据结构或测试断言；新增内容仅限 `docs/research/**` 与临时脚本/截图。

## 2. 运行环境

| 项 | 值 | 来源 |
|---|---|---|
| OS | Windows 10.0.19045（Win10 22H2）x64 | `os.type()/release()` |
| CPU / 内存 | Intel i5-6400 4 核 / 16 GB | `os.cpus()/totalmem()` |
| 显示缩放 | 100%（AppliedDPI = 96） | 注册表 `HKCU:\Control Panel\Desktop\WindowMetrics` |
| 语言 | zh-CN | `Get-Culture` |
| 窗口默认尺寸 | 1440 × 900（最小 960 × 600） | `electron/main.cjs:82-85` |
| 标题栏 | `titleBarStyle: 'hidden'`（自绘顶栏） | 见 `AppTitleBar.tsx:20-24` 注释 |

## 3. 默认外观配置（`useSettingsStore.ts` 的 `DEFAULT_SETTINGS`）

| 项 | 默认值 |
|---|---|
| theme | `default`（暗色；GitHub Primer 色板，见 `styles/theme-primer-dark.css`） |
| fontScale | 100（可调 80–150） |
| fontFamily | `system`（系统字体栈，不加载 Web 字体，见 `constants/design.ts:97-98`） |
| glassmorphism | `false`（玻璃拟态默认关） |
| animations | `true` |
| bootAnimation | `true`（完整启动页） |
| sidebarCollapsed | `false` |
| rightPanelVisible | `true`（右栏默认可见） |
| lastBottomPanelOpen | `false`（底部面板默认关） |
| language | `zh` |
| defaultMode | `pair` |
| taskScope | `project`（任务面板默认只看当前项目） |

> 注：Electron 下 `skipHydration=true`，以上默认值在每次启动时生效，不从 localStorage 恢复（见会话/设置恢复逻辑）。

## 4. 本轮采用观察方式（重要）

- **截图来源 = 浏览器预览版**：`vite preview`（`dist/`，headless Chrome 9334/9355，`--window-size=1600,1000`）+ mock 数据目录。
  - 属于**隔离环境**：不碰真实 `data/`（会话、记忆、密钥）。符合规范第 1 节第 2 条。
  - 代价：mock 数据里**没有真实的后台任务/授权/失败态**，因此「长任务执行 / 等待授权 / 失败 / 完成 / 恢复」等场景**无法在预览版复现** → 见第 6 节 `NOT_OBSERVED`。
- **真实打包版（`dist-portable`）未截图**：它加载真实会话内容（含个人路径与会话文本），截图会带出隐私；且调研期间它可能是当前对话的宿主进程，不宜操作。故本轮**不以它作为截图来源**。

## 5. 截图清单

截图分两组，均保存在仓库根的 `shots/`（`npm run shot` 的既有输出目录，非源码）。

### 5.1 常规场景（`npm run shot` / 浏览器预览）

| 文件 | 场景 | 尺寸 |
|---|---|---|
| `01-主界面.png` | 三条对话的标准界面（默认主题） | 1600×1000 |
| `01b-markdown-顶部.png` | Markdown 渲染自检会话（标题/粗体/任务列表） | 1600×1000 |
| `02-空对话.png` | 新建空对话（开屏） | 1600×1000 |
| `03/04/12-设置-外观*.png` | 设置弹窗 · 外观 | 1600×1000 |
| `05-玻璃拟态-开.png` | `data-glass=on` | 1600×1000 |
| `06-命令面板.png` | Ctrl+K 命令面板 | 1600×1000 |
| `07-终端标签.png` | 右栏「终端」 | 1600×1000 |
| `07b-浏览器标签.png` | 右栏「浏览器」 | 1600×1000 |
| `08-文件树.png` | 右栏「文件」 | 1600×1000 |
| `09-亮色主题.png` | `data-theme=light` | 1600×1000 |
| `10-spec主题.png` | `data-theme=spec` | 1600×1000 |
| `11-Composer菜单-玻璃开.png` | 输入区「+」菜单 | 1600×1000 |
| `11b-模型菜单-级联.png` | 模型 / 推理级联菜单 | 1600×1000 |
| `13..18-设置-*.png` | 设置各标签（通用/模型/数据/技能/记忆/扩展/用量） | 1600×1000 |
| `19-首次启动引导.png` | 首次启动 Onboarding | 1600×1000 |

### 5.2 本轮补充场景（`tmp/shot-extra.mjs`）

| 文件 | 场景 | 尺寸 |
|---|---|---|
| `research-01-任务面板.png` | 右栏「任务」标签 | 1600×1000 |
| `research-02-状态面板.png` | 右栏「状态」标签 | 1600×1000 |
| `research-03-错误面板.png` | 右栏「错误」标签 | 1600×1000 |
| `research-04-右栏关闭.png` | 右栏收起后的中栏 | 1600×1000 |
| `research-05-窄窗口-右栏关.png` | 1024×720，右栏关 | 1024×720 |
| `research-06-窄窗口-右栏开.png` | 1024×720，右栏开 | 1024×720 |
| `research-07-等效150%缩放-853宽.png` | 853×600（近似 150% 缩放下的可视宽度） | 853×600 |
| `research-08-侧栏折叠.png` | 侧栏折叠（48px 图标条） | 1600×1000 |

> 截图未包含密钥/会话个人内容（预览版为 mock 数据，个人路径已由 mock 替代）。

## 6. 无法复现的场景（NOT_OBSERVED / NOT_TESTED）

| 场景 | 状态 | 原因 |
|---|---|---|
| 长任务执行中（连续工具事件） | `NOT_OBSERVED`（预览版） | mock 数据无真实后台任务；真实版含隐私且为本对话宿主 |
| 等待授权 / 危险操作确认 | `NOT_OBSERVED` | 同上。授权 UI 代码已读（见 `ui-safety-visibility.md`），但未在真实运行中截图 |
| 工具失败并重试 | `NOT_OBSERVED` | 同上 |
| 任务完成 / 部分完成交付 | `NOT_OBSERVED` | 同上 |
| 应用重启后返回任务 | `NOT_OBSERVED` | 需真实任务数据 |
| 键盘导航 / 屏幕阅读器实测 | `NOT_TESTED` | 本轮未做无障碍实测 |
| 150% 系统缩放实测 | `NOT_TESTED`（仅等效视口近似） | 未改系统缩放设置；用 853px 视口近似 |
| 减少动态效果偏好实测 | `NOT_TESTED` | 未改系统设置 |

## 7. 复现命令

```bash
# 截图（浏览器预览，隔离 mock 数据）
npm run shot                       # → shots/01..19
node tmp/boot-shot.mjs             # 起 preview(4273)+chrome 再跑 shot
node tmp/shot-extra.mjs            # → shots/research-01..08

# 环境
git rev-parse HEAD
node -e "const os=require('os');console.log(os.release())"
```
