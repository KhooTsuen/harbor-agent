# Phase 7 调研与方案说明：正文对话流排版质感（ChatGPT 级）

> **状态**：**只读调研 + 方案，未写任何实施代码**（2026-10-13）。
> **基线**：`HEAD = 305e274`。
> **目标**：在**不引入任何第三方库**的前提下，让自研 Markdown 渲染器
> （`src/components/chat/markdown/`）产出的正文，在**排版质感**上接近 ChatGPT。
> **纪律**：复用现有 Design Token，**禁止引入新的颜色或字号体系**；
> 不碰 Runtime / IPC / 事件契约 / 任务台账；
> 不碰 `useSmoothText` / `StableBlocks` / `useAutoScroll` / `scrollGuard` 的底层逻辑。
> 证据规矩同其它文档：每条指得住 `文件:行号`。

---

## 0. 一句话结论

**能提升，且大部分是「纯 CSS 层」的安全改动**——因为渲染器的 DOM 结构已经很干净，
差距主要在**数值**（字号 / 间距 / 底色），不在结构。

**差距最大的是「标题层级」**（现最大 20px，ChatGPT ≈ 30px/600，且全部画成 `<p>`）；
**其次是「表格」**（无表头底色、无外框圆角、单元格太挤）；
**再次是「列表与段落的竖向节奏」**（段间距 6px、列表项间距 4px，偏紧）。

**唯一的红线**是「标题字号」：设计 Token 明写 `title = 24px` 是**上限、禁止更大**
（`design.ts:119`）——所以「接近 ChatGPT」在标题上**最多到 24px**，不能再大。

---

## 1. 渲染层现状盘点

### 1.1 文件与职责

| 文件 | 职责 | 行数 |
|---|---|---|
| `markdown/StreamingMarkdown.tsx` | 流式正文：`StableBlocks`（稳定块，memo）+ `TailBlock`（尾巴） | 118 |
| `markdown/Blocks.tsx` | 块 → 元素（段落/标题/列表/引用/表格/hr/公式/HTML + 代码块分发）；`Block` 是 memo | 180 |
| `markdown/Inline.tsx` | 行内节点（文本/代码/粗斜删/链接/图片/公式/HTML/换行） | 98 |
| `markdown/Table.tsx` | GFM 表格 | 58 |
| `markdown/MathNode.tsx` | KaTeX（行内 `MathSpan` / 块级 `MathBlock`） | 52 |
| `markdown/MermaidBlock.tsx` | ```mermaid → SVG（动态 import + 异步两态） | 59 |
| `markdown/RawHtml.tsx` | 原始 HTML 直通（**默认关**，opt-in） | 51 |
| `chat/Markdown.tsx` | 写完的消息：整篇解析 + `BlockList`（流式的收尾对偶） | 33 |
| `chat/CodeBlock.tsx` + `codeblock/{Header,Body,lines}.ts` | 代码块（折叠 / 行号 / 高亮 / diff / 复制下载） | 125 / 82 / 94 |

> 两个入口共用同一批 `Block` / `Inline` 组件，所以**改样式两边同时生效**——
> 这也是「流式收尾不重排」能成立的前提（`streamingMarkdown.test.tsx:78-99`
> 断言同一份文本走两条路的 `innerHTML` **逐字相同**）。

### 1.2 每个组件的现有样式（class 原样 + Token 标注）

「Token ✓」= 用的是 `design.ts` / `index.css` 定义的语义类；「写死」= 任意值或无 Token 对应。

| 元素 | 位置 | 现有 class（关键部分） | Token |
|---|---|---|---|
| 正文容器 | `Markdown.tsx:28`、`StreamingMarkdown.tsx:112` | `break-words text-base leading-relaxed text-fg-primary` | `text-fg-primary` ✓；**`text-base` = 15px**（`tailwind.config.js:128`，标注 `[过渡]`）；`leading-relaxed` = 1.625 |
| 段落 | `Blocks.tsx:164` | `my-1.5 whitespace-pre-wrap break-words` | `my-*` ✓（6px） |
| 标题 | `Blocks.tsx:26-31,114-122` | `mt-4 mb-1.5 font-semibold text-fg-primary` + `text-xl/lg/md/base` | ✓；**全部渲染成 `<p>`**；h1=第1行 20px |
| 列表 | `Blocks.tsx:127` | `my-1.5 flex flex-col gap-1 pl-5` | ✓（项间距 4px、缩进 20px） |
| 列表项标记 | `Blocks.tsx:47-49` | `shrink-0 select-none pt-px text-fg-tertiary` + `•` / `N.` | ✓ |
| 任务勾选框 | `Blocks.tsx:51-62` | `size-[0.95em] rounded-sm border` + `bg: var(--accent-blue)` | `var(--accent-blue)`（**直接写 var**，未走 `text-accent`） |
| 引用块 | `Blocks.tsx:142-147` | `my-2 border-l-2 pl-3 text-fg-secondary` + `borderColor: var(--border-strong)` | ✓ |
| 表格 | `Table.tsx:24-46` | 外层 `my-3 overflow-x-auto`；`table w-full border-collapse text-base`；`th` `border-b border-line-strong px-2.5 py-1.5 font-semibold text-fg-primary`；`td` `break-words px-2.5 py-1.5 align-top text-fg-secondary` | ✓；**表头无底色、无外框圆角** |
| 行内代码 | `Inline.tsx:24-29` | `rounded-sm bg-bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-fg-primary` | ✓；`text-[0.9em]` 是**任意值** |
| 粗体 | `Inline.tsx:34` | `font-semibold text-fg-primary` | ✓ |
| 斜体 / 删除线 | `Inline.tsx:41,48` | `italic` / `opacity-60` | ✓ |
| 链接 | `Inline.tsx:61-62` | `underline decoration-line-strong underline-offset-2 hover:opacity-80` + `color: var(--accent-blue)` | ✓ |
| 图片 | `Inline.tsx:76` | `my-2 block max-h-80 max-w-full cursor-zoom-in rounded border border-line-subtle` | ✓ |
| hr | `Blocks.tsx:154` | `my-4 border-line-hairline` | ✓ |
| 代码块 | `CodeBlock.tsx:78-81` | `group overflow-hidden rounded border border-line-subtle bg-bg-surface` + `my-3` | ✓（`rounded` = 10px） |
| 代码块头 | `Header.tsx:37-49` | `flex items-center gap-2 border-b border-line-subtle px-2 py-1`；标签 `font-mono text-2xs uppercase tracking-wide text-fg-tertiary` | ✓ |
| 代码正文 | `Body.tsx:30-37` | `py-2 font-mono leading-[1.6] text-xs`（= **13px**） | `text-xs` ✓；`leading-[1.6]` 任意值 |
| 公式块 | `MathNode.tsx:49` | `my-3 overflow-x-auto text-center` | ✓ |
| Mermaid | `MermaidBlock.tsx:53` | `my-3 flex justify-center overflow-x-auto` | ✓ |
| RawHtml（关时） | `RawHtml.tsx:44` | `my-2 ... rounded border border-line-subtle bg-bg-surface p-2 font-mono text-xs` | ✓ |
| 尾巴纯文本 | `StreamingMarkdown.tsx:87-90` | `style={{contain:'layout'}}` + `<p className="my-1.5 whitespace-pre-wrap break-words">` | ⚠️ **与段落 class 必须逐字一致**（见 §3） |

**盘点结论**：Token 覆盖率**很高**——几乎所有颜色 / 字号 / 间距都走语义类。
两处「写死」：`text-[0.9em]`（行内代码）、`leading-[1.6]`（代码正文），都不是颜色 / 字号体系，
不违反「禁止新体系」。

**一处待核实的口径**：容器同时写了 `text-base`（自带 `lineHeight: 1.55`）和 `leading-relaxed`
（1.625）——两者谁的 `line-height` 生效取决于 Tailwind 的产出顺序。实施时应**实测一次**
再决定写哪个（本阶段只标出来，不断言）。

---

## 2. 与 ChatGPT 的差异点（按差距从大到小）

> 下面的 ChatGPT 值是**观感量级参照**，不是逐像素对标；本项目所有落值**必须**落到现有 Token。

### 差异 1：标题层级（差距最大）

- **现状**：h1 = `text-xl` = **20px**、h2 = 18px、h3 = 16px、h4 = 15px；上下间距
  `mt-4 mb-1.5`（16px / 6px）；全部是 `<p>`。
- **ChatGPT 量级**：h1 ≈ 30px / h2 ≈ 24px / h3 ≈ 20px，600 字重，上间距明显更大。
- **本项目的硬约束**：`title = 24px` 是**上限、禁止更大**（`design.ts:119`
  原文「**上限**，禁止更大」）。
- **方案**（全部用现有 Token）：
  | 级别 | 现 | 建议 | Token |
  |---|---|---|---|
  | 1 | `text-xl` 20px | `text-title` **24px** | ✓（上限，不再大） |
  | 2 | `text-lg` 18px | `text-xl` 20px | ✓ |
  | 3 | `text-md` 16px | `text-lg` 18px | ✓ |
  | 4 | `text-base` 15px | `text-md` 16px | ✓ |
  | ≥5 | `text-base` | `text-base` | ✓（不动） |
  - 间距：`mt-4 mb-1.5` → **`mt-6 mb-2`**（首行标题 `first:mt-0` 免得顶部空一块）。
  - 可选（**中风险，需单独评估**）：把 `<p>` 换成真 `<h1>…<h4>`（语义 / 无障碍更好，
    但属 DOM 结构变更，见 §3）。

### 差异 2：表格（第二差距）

- **现状**：表头**无底色**、表格**无外框 / 圆角**、单元格 `px-2.5 py-1.5`（10px / 6px）、
  无行悬停。
- **ChatGPT 量级**：表头淡底色、外框 + 圆角、单元格 ≈ `px-3 py-2`、行悬停微亮。
- **方案**（全 Token，**不加新节点**——把外框/圆角加在**已有的** `overflow-x-auto` 外层 div 上）：
  - 外层 div：`my-3 overflow-x-auto` → 加 **`rounded border border-line-subtle`**（`rounded` = 10px）。
  - 表头 `th`：加 **`bg-bg-raised`**（或 `bg-bg-hover`），`pb-2`。
  - 单元格：`px-2.5 py-1.5` → **`px-3 py-2`**。
  - 行：加 **`hover:bg-bg-hover/50`**（纯 CSS 伪类，无新节点）。

### 差异 3：列表与段落的竖向节奏（偏紧）

- **现状**：段落 `my-1.5`（6px）；列表项 `gap-1`（4px）；列表缩进 `pl-5`（20px）。
- **ChatGPT 量级**：段落间距 ≈ 1em（≈16px）；列表项间距 ≈ 0.5em（≈8px）。
- **方案**（Token）：
  - 段落 `my-1.5` → **`my-2.5`**（10px；比 16px 保守，避免消息显得松散）。
  - 列表项 `gap-1` → **`gap-1.5`**（6px）；列表 `pl-5` → **`pl-6`**（24px，嵌套层次更清楚）。
  - ⚠️ **段落 class 必须与 `StreamingMarkdown.tsx:89` 的尾巴纯文本同步改**（见 §3）。

### 差异 4：引用块（可读性偏低）

- **现状**：`border-l-2 pl-3 text-fg-secondary`，`my-2`。
- **ChatGPT 量级**：左侧竖线（≈2-4px）+ 正文色（不致太灰），上下间距更大。
- **方案**（Token）：`pl-3` → **`pl-4`**、`my-2` → **`my-3`**、竖线 `border-l-2` → **`border-l-[3px]`**
  （可选，或保持 2px）；文字色**建议保持 `text-fg-secondary`**（它是既有的「弱化」层），
  若要更接近 ChatGPT 可改 `text-fg-primary`——**两者都是既有 Token，属纯 CSS**。

### 差异 5：行内代码 / 代码块（差距最小）

- **现状**：行内代码 `bg-bg-raised`、无边框、`rounded-sm`；代码块已有头 / 圆角 / 边框，
  正文 13px / `leading-[1.6]`。
- **方案**：**建议基本不动**。可选微调：行内代码加 `border border-line-hairline`
  （让它在段落里更「跳」出来）；代码块正文 `text-xs`(13px) 保持。
  → 这块**投入产出比最低**，列入「可选」。

### （附）正文基准字号 15px vs Token 的 16px —— 需你拍板

- `design.ts:117` 声明 **body = 16px**（`--text-body`，tailwind `text-body` / `text-md`），
  但渲染容器用的是 **`text-base` = 15px**（`tailwind.config.js:128`，自身标注 `[过渡]`，
  且注释明写「新代码请直接用 `dense` / `meta`，别再新增 `sm` / `base`」）。
- **即：正文实际 15px，与规范的 16px 差 1px。**
- **改法**：`text-base` → **`text-body`**（16px / 1.5）——**用的是既有 Token，不是新体系**。
- **代价**：影响**每一条消息**的排版（整屏变大约 6.7%），且有行高口径差
  （`text-base` 1.55 vs `text-body` 1.5）——`tailwind.config.js:106-112` 已把这列为**技术债**，
  并注明「归并会让每行少 1~1.8px」。
- **建议**：**单独拍板**。本方案默认**不动**（改动面最大、最不可控），列为「待定项 A」。

---

## 3. 防闪烁约束核对（安全 vs 高风险）

### 3.1 不受影响的（澄清）

- `useSmoothText`（`hooks/useSmoothText.ts`）：它管的是**文本切片的长度**（按帧追 `target`），
  与 CSS 无关 → **任何样式改动都不碰它**。
- `StableBlocks`（`StreamingMarkdown.tsx:39-56`）：它的 memo 依据是 `blocks` **数组引用**
  （push 追加）+ `version`。样式改动不产生新数组、不改 `node` 引用 → **安全**。
- 唯一会动它的是**改 `Block` 的 `key`**（现为 `${index}-${node.type}`，`StreamingMarkdown.tsx:52`）
  或**把 `Block` 换位置**——本方案**不碰**。
- `useAutoScroll` / `scrollGuard`：本方案**零改动**。

### 3.2 纯 CSS 层（安全 —— 只改 className / 任意值）

以下改动**不增删 DOM 节点、不改标签名**，流式与收尾的 `innerHTML` 对等性自动成立：

- 段落 / 标题 / 列表 / 引用 / hr 的 **margin、gap、padding、font-size、font-weight、color**；
- 表格：外层 div 加 `rounded border`、`th` 加 `bg-*`、单元格 padding、行 `hover:bg-*`；
- 行内代码：`rounded / px / py / border`；
- （待定项 A）容器 `text-base → text-body`。

> **等价性由现有测试守住**：`streamingMarkdown.test.tsx:78-99` 对 6 个样本断言
> 「流式 DOM === 整篇 DOM」——纯 CSS 改动两边同源，断言仍绿。

### 3.3 DOM 结构变更（高风险 —— 需单独评估）

- **标题改真标签**（`<p>` → `<h1>…<h4>`）：语义/无障碍更好，但属结构变更；
  需确认 `index.css:496-501` 的 `h1,h2,h3{margin:0;font-weight:600}` 不产生意外
  （目前的标题用 `mt-4` 自己控制间距，换成 h 标签要与全局 reset 叠加验证）。
  **建议：一期不做，二期单独评估。**
- **给表格加一层包裹 div**（而非复用现有外层）：会新增节点 → 属结构变更；
  **本方案不采用**（改为在已有外层 div 上加边框，§2 差异 2）。
- **任何**新增 / 删除 / 重排现有元素、改 `key`、改 `Block` 位置 —— **一律不做**。

### 3.4 必须「成对修改」的一处（易漏）

`Blocks.tsx:164` 的段落 `<p className="my-1.5 whitespace-pre-wrap break-words">` 与
`StreamingMarkdown.tsx:89` 的尾巴纯文本 `<p className="my-1.5 whitespace-pre-wrap break-words">`
**class 必须逐字一致** —— 否则「流式最后一屏」与「写完整篇解析」会长得不一样，
`streamingMarkdown.test.tsx:78-99` 会**当场变红**。（改段落间距时**两处一起改**。）

---

## 4. Prompt 层配合（可选，需评估）

### 4.1 现状

- `REST_RULES`（`prompt-rules.cjs:159-167`）：回答用简体中文 / 别用 write_file 整篇覆盖 /
  别写过渡语…等——**通用，不跟开关**。
- `PLAN_RULE`（`prompt-rules.cjs:22-28`）：`planFirst` 开关管；计划块格式。
- `workRules()`（`prompt-rules.cjs:197-213`）把它们拼成 `workRules` 层。

### 4.2 能否加一条「最终汇报优先用表格 / 引用 / 列表」？

**可以，且位置天然正确**：`workRules` 层在 `ORDER` 的**稳定区**
（`prompt-stack.cjs:187`，在 `safety` 之前、易变区之前）——
**加进 `REST_RULES` 即落在稳定区，不会破坏前缀缓存**
（DeepSeek 前缀匹配只在意「开头不变」；这条文案**运行期恒定**）。

**但有三处成本必须说清**：

1. **要升提示词版本**：`prompt-stack.cjs:150` 的 `VERSION = 'prompt-stack/7'` →
   `/8`（文件头 `:124-148` 明确要求「加/改某层文案」就 +1，并写进变动史）。
2. **两处自检硬钉着版本号** —— 升版就得同步改：
   `142-persona-routing.mjs:45` 与 `93-machine-prompt.mjs:107` 都断言 `=== 'prompt-stack/7'`。
3. **「表格 / 引用」不适合当硬要求**：很多结论用列表 + 粗体更清楚，
   逼表格会产出空壳表格。**建议写成「优先用结构化排版（列表 / 粗体 / 必要时表格），别堆长段落」**，
   而不是「必须用表格」。

**改动面**：`prompt-rules.cjs`（+1 条）+ `prompt-stack.cjs`（版本号 + 变动史）+
`142` / `93` 两个自检组 = **4 个文件**，且**碰 `electron/core/`**。
本阶段（Phase 7 是**前端排版**）里，这条**属可选、可延后**——建议**先不动**，
等排版落地、真机看过效果再决定要不要模型配合。

---

## 5. 边界红线核对

| 红线 | 本方案 |
|---|---|
| 严禁引入新 npm 依赖 | ✓ 零依赖（纯 Tailwind 类 + 现有 CSS 变量） |
| 严禁碰 Runtime / IPC / 事件契约 / 任务台账 | ✓ 全不碰（只动 `src/components/chat/` 下的 className） |
| 严禁碰 `useSmoothText` / `StableBlocks` / `useAutoScroll` / `scrollGuard` 底层逻辑 | ✓ 一行不改（只改它们**引用的样式**，§3.1） |
| 禁止引入新的颜色 / 字号体系 | ✓ 全部落 `text-*` / `my-*` / `gap-*` / `bg-*` / `border-*` / `fg-*` / `radius-*` 既有 Token |
| 标题字号上限 | ✓ **最大 24px**（`text-title`，`design.ts:119` 明写禁止更大） |
| 单文件 ≤ 300 行 | ✓ 只改 className，不改行数（`Blocks.tsx` 180、`Table.tsx` 58…） |

**硬禁区判定**：#1 动 3+ 文件 → 若含可选 Prompt 项则 **约 6 个**（届时**先报告**）；
#8 内核关键文件 → **不碰**（Prompt 项若要动也只碰 `prompt-rules.cjs` / `prompt-stack.cjs`，
不在 #8 名单）；#9 IPC / #10 权限安全 / #11 加字段 / #3 改结构 → **全不碰**。

---

## 6. 拟修改文件列表

**一期（纯 CSS，建议先做）—— 5 个文件**

| 文件 | 改什么 |
|---|---|
| `src/components/chat/markdown/Blocks.tsx` | `HEADING_SIZE` 映射 + 标题间距；段落 `my-*`；列表 `gap`/`pl`；引用 `pl`/`my`/竖线 |
| `src/components/chat/markdown/StreamingMarkdown.tsx` | **尾巴纯文本的段落 class 同步**（与 `Blocks` 段落的 `my-*` 一致） |
| `src/components/chat/markdown/Table.tsx` | 外层 `rounded border`；`th` 底色；单元格 padding；行 `hover:` |
| `src/components/chat/markdown/Inline.tsx` | （可选）行内代码加 hairline 边框 |
| `CHANGELOG.md` | 硬约束 #10（碰了 `src/**` 必写） |

**待定项 A**（正文 15px → 16px）：同上，额外动 `Markdown.tsx` / `StreamingMarkdown.tsx` 容器
——**需你单独拍板**。

**可选 · 二期**：标题改真 `<h*>`（结构变更，需单独评估）；
Prompt 软约束（`prompt-rules.cjs` + `prompt-stack.cjs` + `142`/`93` 自检，4 文件）。

**验证方式（实施时）**：
- `npm run verify` 全绿；**特别关注** `streamingMarkdown.test.tsx`（流式↔整篇 `innerHTML` 对等）
  与 `Markdown.test.tsx`、`rendererPerf.test.tsx`（节点数上界）。
- 新增/改一组**样式守卫断言**（断言关键 class 还在，防「改回去了」）。
- 真机走查（你来做）：长回答里的 h1/h2、宽表格、引用、嵌套列表各看一眼。

---

## 7. 待你拍板

1. **一期范围**：只做 §2 的差异 1–4（纯 CSS，5 文件）？还是连差异 5（行内代码边框）一起？
2. **待定项 A**：正文 `text-base`(15px) → `text-body`(16px) 改不改？（差距最大、也最不可控）
3. **标题**：只调字号 / 间距（纯 CSS）？还是同时改真 `<h*>` 标签（结构变更，二期）？
4. **Prompt 软约束**：本轮做，还是等排版落地后再定？

**调研与方案完成，停下等你确认。**

---

## 8. 三期技术债归档

> **状态**：一期（差异 1–5 · 纯 CSS）**已实施**，提交 `3473866`。
> 以下三项**本轮不做**，留作未来专项；各自的原因与「动手前必须先评估什么」记在这里，
> 免得将来重新翻一遍才想起当初为什么停下。

### 债 1：正文 15px → 16px（待定项 A）

- **现状**：渲染容器用 `text-base`（**15px** / 行高 1.55），而 `design.ts:117` 声明的
  正文是 `text-body`（**16px** / 1.5）——差 1px，且行高口径不同。
- **为什么暂缓**：这会改**每一条消息**的排版（整屏约 +6.7%），且有行高口径差
  （`tailwind.config.js:106-112` 已把它列为技术债：归并会让每行少 1~1.8px）。
  改它等于动全局正文基准，**风险面最大、最不可控**。
- **将来动手前**：作为**独立专项**做——先量「改前 vs 改后」的整屏高度 / 滚动行为，
  确认 `--leading-meta` 口径要不要一起统一（那要动 `index.css`，属单独报批项）。
  不是「顺手改个类名」。

### 债 2：标题 `<p>` → 真 `<h1>…<h4>` 标签

- **现状**：标题是 `<p>` + `HEADING_SIZE` 映射字号（语义/无障碍上不是标题）。
- **为什么暂缓**：属 **DOM 结构变更**（换标签名），要单独评估**防闪烁**
  ——`streamingMarkdown.test.tsx` 的「流式 DOM === 整篇 DOM」断言对标签名敏感；
  且 `index.css:496-501` 有 `h1,h2,h3{margin:0;font-weight:600}` 的全局 reset，
  换成 h 标签后要与它叠加验证（现在的间距是靠 `mt-6 mb-2` 自己控制的）。
- **将来动手前**：二期单独评估；改完必须重跑流式对等测试 + `rendererPerf`。

### 债 3：Prompt 层软约束（引导模型多用结构化排版）

- **现状**：`prompt-rules.cjs` 的 `REST_RULES` / `PLAN_RULE` 里没有「优先用表格 / 引用 /
  列表组织结论」这类排版引导。
- **为什么暂缓**：`workRules` 层虽在**稳定区**（加进去不破坏前缀缓存），但改它要
  ① 升 `prompt-stack.cjs` 的 `VERSION`（`/7 → /8`）；② 同步两处**硬钉着 `/7`** 的自检
  （`142-persona-routing.mjs`、`93-machine-prompt.mjs`）。共 **4 文件、且碰 `electron/core/`**
  ——与「Phase 7 是前端排版」不是一件事。
- **将来动手前**：等**排版落地并稳定**之后再评估；且**不写「必须用表格」**（会逼出空壳
  表格），只写「优先结构化排版」这类软约束。

---

**Phase 7 一期收口**：一期范围（差异 1–5）已实施并提交 `3473866`；
以上三项技术债按用户 2026-10-13 拍板**暂缓**，进入真机验证与日常观察期。
