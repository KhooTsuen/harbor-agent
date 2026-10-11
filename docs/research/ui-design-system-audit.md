# 设计系统与视觉一致性调查（ui-design-system-audit）

> 只读调研。行号来自 HEAD `847cfc3`。只输出可核实的视觉问题与设计原则，**不产出视觉稿、不改 CSS**。

## 1. Token 体系（三层）

```
值（唯一事实来源）          输出                  消费
constants/design.ts   →   index.css 的 CSS 变量 →  组件 utility / var()
                     →   tailwind.config.js 映射
```

- 值层：`src/constants/design.ts`（颜色/字号/间距/圆角/动效/层级/布局）。
- 变量层：`src/index.css`（**71 个 CSS 变量**，四套主题：default / chatgpt / spec / light）。
- 映射层：`tailwind.config.js`（`bg-canvas` / `text-primary` …）。
- 四套主题：default 基准；`styles/theme-primer-dark.css`（GitHub Primer 映射，2026-09-25 起 default 采用）。

## 2. 覆盖率（客观计数）

在 `src/**`（不含 `__tests__`）统计：

| 指标 | 计数 | 说明 |
|---|---|---|
| Tailwind token 类引用（`bg-*`/`text-*`/`border-*`） | **508** | 组件主要走 utility |
| `var(--…)` 直接引用 | **245** | 语义色/尺寸 |
| hex 颜色字面量 | 272 | **集中在定义层**：`index.css`(126)、`theme-primer-dark.css`(75)、`design.ts`(31) |
| `rgb()/rgba()` | 66 | 多为透明遮罩 |
| `text-[Npx]` 硬编码字号 | **8** | 唯一的字号硬编码口子 |

组件层硬编码 hex 只有：`XtermTerminal.tsx`(21，终端配色需具体色值，合理)、`BootSequence.tsx`(7)、`glass.ts`(2)。

**结论**：**颜色 token 化做得好**——硬编码集中在定义层，不是散落在组件里。这与「AI 味」无关；视觉不一致主要出在**字号**（见 §3）。

## 3. 已知不一致

| ID | 问题 | 严重度 | 证据 |
|---|---|---|---|
| N-VS-01 | 字号实际 10 种（12/13/13.5/14/15/16/18/20 + 10/11 硬编码），与 `design.ts:102-114` 声明的「三层 + dense 例外」不符；根因是 `tailwind.config.js:106-119` **两套 scale 并存**（meta/body/title 与旧的 2xs/xs/sm/dense） | P2 | `ui-noise-audit.md` §1 |

其余（颜色语义、圆角、间距、动效）**一致**：语义色唯一来源 `statusLanguage.ts:26-30`（有测试）；间距 4px 网格（`design.ts:124-133`）；圆角 base 10 / small 6 / pill 仅主 CTA（:137-144）；动效 fast/base/slow（:148-152）。

## 4. 重复组件（视觉相同、实现不同）？

- 基础控件已收口在 `src/components/ui/`：`Button` / `IconButton` / `Modal` / `Popover` / `Tooltip` / `Field` / `Skeleton` / `StatusDot` / `Toast` / `ResizeHandle`。
- 状态文字与色收口在 `lib/statusLanguage.ts`（组件自写语义色会被测试判红）。
- **未见**「视觉相同、实现不同」的重复组件证据。此项**无问题**。

## 5. 排版规则（中文/英文/路径/代码/数字）

| 内容 | 规则 | 证据 |
|---|---|---|
| 字体栈 | 系统栈，**不加载 Web 字体**（`@font-face` 已注释） | `index.css:8-34`；`design.ts:97-98` |
| 等宽（路径/命令/数字） | `--font-mono`，多处 `font-mono` | `StatusBar.tsx:74-76,104`；`ToolLine.tsx:101` |
| 长中文换行 | `break-words`（思考块/确认摘要等） | `ProcessBlocks.tsx:57`；`PermissionBar.tsx:56` |
| 段落宽度 | 内容列 `max-w-3xl`（`MessageList.tsx:161`）+ 助手消息 `max-w-[86ch]`（`MessageItem.tsx:96`） | — |
| 代码块 | 独立组件 + 等宽字体 | `chat/CodeBlock.tsx` |

**未发现**中英文混排规则缺失的硬证据（需要人工细看英文单词换行——本轮未逐字检查）。

## 6. Comfortable / Compact 密度模式

- 现状：`design.ts:180-193` 的 `LAYOUT_TOKENS` 里**已预留** `controlHeight: 28` 与 `compactControlHeight: 24`。
- 但 `constants/index.ts:140-145` 的注释明确说 `LAYOUT_TOKENS` 「还是一张**待接线的注册表**」，真正生效的是 `LAYOUT`（`constants/index.ts:133-151`）。
- 结论：**密度模式尚未实现**，但 token 已预留 → 属「能用现有 token 低成本实现」的候选（把 `LAYOUT_TOKENS` 接线 + 让组件读 `controlHeight`）。**本轮只是判断可行性，不实施**。

## 7. 主题与外观开关

| 项 | 实现 | 证据 |
|---|---|---|
| 主题 | `data-theme` 属性 + 四套变量 | `index.css:50-...`；截图 `09-亮色`/`10-spec主题` |
| 玻璃拟态 | `data-glass` 属性，默认关 | `useSettingsStore.ts`（`glassmorphism:false`） |
| 字号缩放 | `fontScale`（80–150） | `useSettingsStore.ts` normalize |
| 字体族 | `fontFamily`（system/yahei/pingfang/noto/harmony/custom） | 同上 |
| 减少动效 | `animations` + `asciiReducedMotion` 设置；**未见**读系统 `prefers-reduced-motion` | 同上 |

## 8. 「AI 味」的来源（按证据分类，不做无依据量化）

| 来源类别 | 具体表现 | 证据 |
|---|---|---|
| **视觉** | 玻璃拟态（`glass`，默认关）、启动页 ASCII 动画（`boot/oceanAnimator.ts`）、发光/动画（`animate-pulse` 圆点、`caret` 闪烁）、胶囊按钮（`rounded-pill` 仅主 CTA） | `index.css:--glass-*`；`StatusBar.tsx:53`；`MessageRounds.tsx:113` |
| **信息架构** | 同屏 57 个按钮平铺、8 个右栏标签同权重、过程信息（工具/思考）默认折叠但**入口很多** | `ui-noise-audit.md` §1/§3 |
| **文案/拟人化** | 品牌「Harbor/灯塔/夜航/航道畅通」彩蛋（`nightVoyage`、`HarborEggs`）、启动页性格层、Toast 措辞 | `AppTitleBar.tsx:60-81`；`GlobalLayers.tsx:55-56` |
| **模型输出** | 过程旁白（N-MO-01），非 UI 可控 | `ui-noise-audit.md` §5 |

> 规范第 10 节问「哪些 AI 味来自发光/胶囊/状态动画/拟人化/过度卡片化」——按上表：**发光/动画**（玻璃、脉冲点、光标）与**拟人化文案**（彩蛋/性格层）有确凿来源；**过度卡片化**无证据（工具已做成一行文本）。
