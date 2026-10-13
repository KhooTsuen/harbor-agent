# Phase 7 二期 调研与方案说明：对话渲染的体验提升

> 只读调研 + 方案设计 · 2026-10-13 · **批次 A 已实施（Commit 9fb23af）· 批次 B/C 待定**
> 范围：除「静态 Markdown 样式」（一期已做）之外的对话渲染体验
> 边界：严禁新依赖 · 严禁碰 Runtime / IPC / 数据结构 · 防闪烁三件套的改动必须单列风险评估

---

## 0. 一页速览

| # | 方向 | 现状（源码事实） | 可行性判断 | 建议 |
|---|---|---|---|---|
| 1a | 流式闪烁光标 | **已经存在**：`MessageRounds.tsx:142` + `.caret`（`index.css:900`） | 已满足；**改它反而有风险** | **不改** |
| 1b | 悬浮「回到底部」 | **已经存在**：`MessageList.tsx:194`（`mode==='free'` 即出） | 补「距离阈值」可行 | 批次 B（**待定**：先真机观察灵敏度） |
| 2a | 思考块折叠卡样式 | 现在是「按钮 + 左竖线缩进块」（`ProcessBlocks.tsx:38-63`） | 纯 CSS 可行 | 批次 A（**已实施** 9fb23af） |
| 2b | 工具图标差异化 | 现在恒用 `Terminal` 图标（`ToolRuns.tsx:77`）；`ToolLine` 只用状态图标 | 可行（图标为主、颜色仍走状态语义） | 批次 A（**已实施** 9fb23af） |
| 3 | Mermaid 点击放大 | SVG 走 `innerHTML`，**不是** `<img data-chat-image>` | 不能直接复用；有一处需先验证 | 批次 C（**待定**：等明确需求） |
| 4 | 上下文可视化 | **已经存在**：`ContextRow.tsx` 的 `ContextGauge`（百分比圈 + 明细） | 已满足；增强需碰内核 | **不改 / 只做 tooltip 增强** |

**两条最重要的结论（与预期不同）**：**流式光标**和**上下文圈**都已经实现了 —— 你问的两个「想新增」的能力，代码里已经有了。下面逐个说清现状、能怎么改、以及为什么有些建议是「不改」。

---

## 1. 流式体验

### 1.1 流式闪烁光标 —— ★ 已经存在，且是「踩过坑之后」的形态

**现状**（`src/components/chat/message/MessageRounds.tsx:128-144`）：

```tsx
{/* 打字光标：整条消息只挂一个，位置钉在尾巴上（2026-10-06 第二次调整） */}
{streaming && everHadContent ? (
  <span className={lastHasContent ? 'caret' : 'caret invisible'} aria-hidden="true" />
) : null}
```

CSS 在 `src/index.css:899-921`：`.caret::after` 是一个 7px 宽、`1.05em` 高、用 `caret-blink 1.1s step-end infinite` 闪烁的方块，颜色 `var(--text-primary)`。

**关键设计（别推翻）**：它**不在任何一轮里**，挂在整条消息的末尾。文件里写明了原因 —— 2026-10-06 上一版挂在「有正文的那一轮」内部，**换轮时元素卸载再挂载**，那一行的出现/消失让下面所有东西上下跳一格（真机反馈的「对话抽搐」），并重置 CSS 闪烁动画。改成「钉在消息尾巴上、只在有正文时可见」之后就不跳了。

**评估结论**：

- **「加入流式闪烁光标」这件事本身没有再做的空间** —— 它已经在工作，且是防跳动的形态。
- **能不能把它改成「跟在最后一个字后面」（行内光标）？** —— **不建议**。那正是 2026-10-06 修掉的形态：行内光标必须挂在正文元素内部，换轮/换块时卸载重挂 → 重新引入跳动与动画重置。这是**用防抖动换观感**，与「不得破坏防闪烁」冲突。
- **可选的低风险微调**：光标颜色（`--text-primary` → 想低调可换 `--text-secondary`）或尺寸。纯 CSS（改 `index.css` 那个类），不动 DOM、不动 `MessageRounds`。**收益很小，可做可不做。**

> 防闪烁影响：**无**（不引入新元素、不改挂载点）。

### 1.2 悬浮「回到底部」按钮 —— ★ 已经存在，待补「距离阈值」

**现状**（`src/components/chat/MessageList.tsx:187-202`）：`mode === 'free'` 时，底部中间出现一个 `↓ 回到底部` 按钮，点它 = 迁移规则 5（`enterFollow`）。

**「只在 FREE 且偏离底部超过一定距离时出现」—— 前半条已经满足**：按状态机迁移规则 3，**「离底 ≤ 4px」就等于 FOLLOW**（`useAutoScroll.ts:52` 的 `BOTTOM_EPSILON`）。所以 `mode==='free'` 本身就等价于「偏离底部 > 4px」。**缺的只是「阈值 > 4px」那一档**（比如滚了 5px 就弹按钮，有点敏感）。

**接口设计（推荐方案 A：在 hook 里加一个只读派生值）**：

- `useAutoScroll` 现在的返回是 `{ mode, attachScroller, attachContent, enterFollow, enterFree }` —— 没有「离底多远」。
- 而 `onScroll` **本来就已经算出了那个值**（`useAutoScroll.ts:172`：`const distance = el.scrollHeight - el.scrollTop - el.clientHeight`）—— 只是没往外给。
- 方案：新增一个派生布尔（如 `awayFromBottom`：`distance > 阈值`），**只在跨过阈值那一刻 `setState`**（不是每次滚动都更新），`MessageList` 拿它当按钮的显示条件。

```ts
// 接线示意（不进本次实施，仅说明形状）
const showBack = mode === 'free' && awayFromBottom   // 阈值如 240px
```

**为什么放 hook 里、不在 MessageList 自己再挂一个 scroll 监听**：那就成了**第二份滚动真相**（项目最忌这个，见 AGENT.md 硬约束 #9）。滚动位置只该有一个来源。

**风险评估（触及防闪烁三件套之一 `useAutoScroll`）**：

| 项 | 评估 |
|---|---|
| 改了它的**状态机**吗 | **不改**：迁移规则 1-5、FOLLOW/FREE 语义、锚点补偿全部不动 |
| 新增的是什么 | 一个**只读**派生值 + 条件 `setState`（仅在跨阈值时） |
| 会否破坏防抖动 | 不改 `writeTop` / `onResize` / 锚点逻辑 → 不会 |
| i5-6400 代价 | 若「每次 scroll 都 setState」→ 每帧一次 React 提交，**必须避免**；按阈值跨变才更新 → 代价≈0 |
| 兜底 | 加单测钉「滚 5px 不出、滚 300px 出、回到 ≤4px 出→消失」 |

> **纯 CSS 替代（方案 B，零风险）**：不碰 hook，按钮**维持「FREE 即显示」**。代价：滚 5px 也会弹。若你更在意「零风险」而非那点观感，可选 B。

---

## 2. 思考过程与工具调用渲染

### 2.1 思考块折叠卡样式

**现状**（`ProcessBlocks.tsx:38-63`）：一个 `<button>`（`ChevronRight/Down` + 「思考过程 / 正在思考…」+ `N 字`） + 展开后的 `<div className="... border-l-2 pl-3 text-xs text-fg-tertiary">`（左竖线缩进块）。用 `useSmoothText` 做平滑。

**方案（纯 CSS + 极小 DOM 包装）**：把展开区从「左竖线缩进块」升级成**淡底卡**：

- 现状 `border-l-2 pl-3 text-fg-tertiary`
- 建议：`rounded-sm border border-line-subtle bg-bg-raised/40 px-3 py-2 text-xs leading-relaxed text-fg-secondary`
- 即：复用一期已在 `ToolRunRow` 用过的卡样式（`ToolRuns.tsx:45`：`rounded-sm border border-line-subtle bg-bg-base/40`）—— **同一份观感，不新增 Token**。

**防闪烁对等评估**：`ThinkBlock` **不在** `StreamingMarkdown` 的稳定块体系里（它由 `MessageRounds` 直接渲染，吃的是 `useSmoothText` 的输出），所以：
- `streamingMarkdown.test.tsx` 的「流式 DOM === 整篇 DOM」**覆盖不到它**（那段测的是 Markdown 解析块）；
- 但它**仍在流式时每帧重渲**（`smooth` 在变）→ 所以这条改动**只准改 className**，**禁止增删节点**（增删会让每帧的 DOM 结构变，React 重建子树）。「极小 DOM 包装」在这个块上是**不必要**的 —— 现有 `<div>` 直接换 class 即可。

> 防闪烁影响：**无**（只改 className）。i5-6400：**无**（不改渲染次数）。

### 2.2 工具差异化图标与色彩

**现状**：
- 概览行 `ToolLine`（`ToolLine.tsx:86-94`）：图标只表达**状态**（转圈=进行中 / 红叉=有失败 / 箭头=可展开），**不表达工具类型**。
- 明细行 `ToolRunRow`（`ToolRuns.tsx:69-77`）：状态图标 + **恒定的 `Terminal` 图标** + 工具名。
- 现有映射：`lib/agentActivity.ts` 的 `AGENT_ACTIONS`（名→[动词,量词]）、`TOOL_LABELS`（名→人话）。色彩：`lib/statusLanguage.ts` 的 `colorOf(status)`。

**方案（图标为主，颜色仍走状态语义）**：

1. **新增一张「工具名 → lucide 图标」映射**，落在 `lib/agentActivity.ts`（和 `AGENT_ACTIONS` / `TOOL_LABELS` 同住 —— 工具的人类可读信息的**唯一住处**，别再开第二个文件）。
   - 例：`read_file → FileText`、`write_file/edit_file → FilePen`、`list_dir → FolderTree`、`run_shell → Terminal`、`search_web → Search`、`browse* → Globe`、`generate_image → Image`、`download → Download`、`spawn_subagent → Bot`、`ask_user → HelpCircle`、`mark_step_done → Check`（具体图标实施时定，**全部用现有 lucide 包**，不引新依赖）。
2. `ToolLine` / `ToolRunRow` 用 `toolIconOf(name)` 替换恒定图标。

**色彩处理（关键取舍）**：

- **不要**按「读/写/运行」上不同颜色 —— 那会和 `statusLanguage` 的**状态语义色**打架（`statusLanguage.test.ts` 明令「语义色只有这里能写」）。
- **颜色继续只表达状态**（进行中蓝 / 完成 / 失败红），**类型靠图标区分**。这样既有「一眼分辨读还是写」，又不制造第二套颜色语言。
- 若确实想给类型一点色彩，**只能用 `--accent-*`（blue/green/yellow/purple）**（它们是既有的「非状态」强调色，`highlight` 已在用），且要克制（建议**不启用**，先把图标做出来看效果）。

**防闪烁评估**：`ToolLine`/`ToolRunRow` 在 `groupRounds` 之后渲染，**不在** `StreamingMarkdown` 的稳定块体系内；同样是「只改 className / 换图标组件」。图标是**固定尺寸的 lucide SVG**，换图标不改变行高等 → 无跳动。

> 防闪烁影响：**无**。i5-6400：**无**（图标是静态 SVG，无运行时计算）。

---

## 3. 富媒体交互：Mermaid 点击放大

**现状**：
- `MermaidBlock.tsx:52-57`：mermaid 渲染出的 **SVG 字符串**，用 `dangerouslySetInnerHTML` 塞进一个 `<div>`。
- `ImageLightbox` 的收集机制（`useImageLightbox.ts:79-87`）：`openImageFromDom(src)` 扫 **`[data-chat-image]`** 元素取 `src`，开 lightbox。
- `ImageStage.tsx:101`：lightbox 本体渲染的是 **`<img src={src}>`**（缩放/拖动/旋转都作用于 img）。

**核心障碍**：mermaid 产出的是 **`<svg>`（内联 DOM）**，**不是 `<img data-chat-image>`** —— 所以 `openImageFromDom` 扫不到它，`ImageStage` 也吃不了它。**「直接复用」不成立。**

**三条可能路径**：

| 路径 | 做法 | 风险 |
|---|---|---|
| **A（推荐先评估）** 转 data URL 后复用 | 把 SVG 序列化成 `data:image/svg+xml;utf8,...` 塞进 `<img data-chat-image>`，直接复用**整套** lightbox | ① **`imageSaveAs` 是否接受 data URL 需先验证**（走 `handlers/image-file.cjs`，本轮未验证）；② 大图 data URL 很长；③ lightbox 的「对话内图片切换」会把 SVG 与普通图片混进一个列表 |
| **B** 复用状态机、扩展 ImageStage | 保留 `useImageLightbox`（open/close/zoom 那套 store 不变），让 `ImageStage` 支持渲染 svg | 要**改 ImageStage 的渲染逻辑**（不只是样式）→ 属「碰逻辑」，且要保证 img/svg 两态都不破缩放拖动 |
| **C** 独立放大层 | 给 Mermaid 单做一个只读放大层（点开看大图） | 新建组件、与 lightbox **观感两套**（项目忌「两套并存」）|

**安全提示（正向）**：若走路径 A，SVG 变成 `<img>` 之后，**脚本在 img 上下文里不执行** —— 比现在 `innerHTML` 内联 SVG **更安全**（现在靠 mermaid `securityLevel:'strict'` 兜底）。这是路径 A 的一个额外好处。

**结论**：**可行，但属批次 C，且实施前必须先验证 `imageSaveAs` 对 data URL 的行为**（那是主进程通道，本轮只读探索不动它）。若验证不通，退路径 B 或不做。

> 防闪烁影响：`MermaidBlock` 在**稳定块**里（闭合的 ` ```mermaid ` 围栏）→ 改动只应加 `onClick` + `cursor-zoom-in`（className 层），**不得改变其 DOM 位置/结构**。

---

## 4. 上下文可视化 —— ★ 已经存在

**你问「有没有现成的 API 或 Store 提供 Token 消耗统计数据」—— 有，而且不止一处：**

| 来源 | 内容 | 位置 |
|---|---|---|
| **每条消息** | `usage?: UsageBucket`（`prompt / completion / total / calls / cached`） | `types/conversation.ts:59`、`types/stats.ts:10` |
| **当前会话合计** | 把每条消息的 usage 相加，状态栏右下角显示 `↑入 ↓出` | `layout/StatusBar.tsx:23-32, 112-119` |
| **全局统计** | `stats:summary` IPC → `StatsSummary`（按天 / 按模型 / 含 `cached`） | `electron/ipc-channels.cjs:168`、`lib/extrasApi.ts:130` |
| **任务累计** | 台账 `tokens / tokensIn / tokensOut` | `TaskTokenBadge.tsx`、`types/task.ts:100-104` |
| **★ 上下文用量圈** | **百分比环 + 明细 tooltip**（`估算 used / limit token`、分母口径、是否将自动压缩） | **`composer/ContextRow.tsx:33-95`** |

**即：你想做的「上下文可视化」已经有了一版** —— 输入框下方的 `ContextGauge` 圈，口径与自动压缩**同一份**（`stores/thread/compact.ts` 的 `adviseCompact`），颜色走 `statusLanguage`（快到线黄、过线红）。文件头专门写了「如果这里和压缩各算各的，用户会看到『圈才到 50% 它却自己压了』」。

**「在核心里增加这个信息是否属于禁区？」** —— 如果指的是**让内核多吐一份「上下文分项构成」**（各 budget 段占多少 token），那要碰 `context-builder.cjs` / `session-read.cjs` 等内核文件 → **属禁区**（本轮不碰，也不建议）。

**现状已够，建议做的事（都不碰内核、不碰数据结构）**：

- **只做「tooltip 增强」**：把现有的 `ContextGauge` tooltip 补上 `usage.cached`（缓存命中 token，便宜很多）和「距自动压缩线还差多少」—— 数据现成（`message.usage.cached`、`advice`）。
- **不做**：新建仪表盘 / 改数据结构 / 让内核多算。

---

## 5. 边界核对与风险评估

### 5.1 防闪烁三件套（逐个）

| 件 | 本方案是否碰 | 说明 |
|---|---|---|
| `useSmoothText` | **不碰** | 1.1 不改光标挂载；2.x 只改 className |
| `StableBlocks`（`StreamingMarkdown.tsx`） | **不碰** | 无一处改它的数组引用 / `key` / `Block` 位置 |
| `useAutoScroll` | **仅 1.2 方案 A** 加一个只读派生值（不改状态机） | 风险见 §1.2 表；方案 B 则完全不碰 |
| `scrollGuard` | **不碰** | — |

**「流式 DOM === 整篇 DOM」的守护**：`streamingMarkdown.test.tsx:78-99`（6 样本）。本方案全部落在「Markdown 解析块之外」（思考块 / 工具行 / 光标）或「className 层」→ 该断言不受影响；实施时仍**必须跑绿**。

### 5.2 i5-6400（老机）性能预算

原则：**不增加「每帧」的工作量**。

| 方向 | 每帧成本 | 结论 |
|---|---|---|
| 1.1 光标（不改） | 0 | 安全 |
| 1.2 按钮阈值 | 若「跨阈值才 setState」→ ≈0；若「每次 scroll setState」→ **禁止** | 按跨阈值实现 |
| 2.1 思考卡样式 | 0（只换 class） | 安全 |
| 2.2 工具图标 | 0（静态 SVG） | 安全 |
| 3 Mermaid 放大 | 点击时才发生（不在流式路径） | 安全（但大 SVG 转 data URL 有一次性成本，需实测） |
| 4 上下文圈 | **已存在**，本就每次消息增长重算一次纯长度估算 | 现状；增强若加计算需实测 |

> **性能改动必须「改前 vs 改后」有数字**（AGENT.md）：本方案里唯一可能动性能的是 1.2 与 3，实施时都要给实测。

### 5.3 红线核对

- **严禁新依赖** ✓（图标用现有 `lucide-react`；无新包）
- **严禁碰 Runtime / IPC / 数据结构** ✓（改动只在 `src/components/chat/**`、`src/hooks/useAutoScroll.ts`、`src/index.css`；不动 `electron/`、不加字段）
- **不得破坏流式对等** ✓（无一处增删稳定块体系里的节点）

---

## 6. 拟改文件清单与分批建议

> 全部在 `src/`，无 `electron/`、无新 IPC、无数据结构变更。

**批次 A —— 零风险（纯样式 / 换图标）· ✅ 已实施（Commit 9fb23af）**
- `src/lib/agentActivity.ts`（加 `TOOL_ICONS` 映射 + `toolIconOf()` + `homogeneousIconOf()`）
- `src/components/chat/message/ToolLine.tsx`（概览行用工具图标）
- `src/components/chat/ToolRuns.tsx`（明细行换掉恒定 `Terminal`）
- `src/components/chat/ProcessBlocks.tsx`（思考块展开区换淡底卡 class）
- 新增守卫断言 `lib/__tests__/toolIcons.test.ts`(9 条) + `chat/__tests__/processStyling.test.tsx`(8 条)
- 实际改动还含：`chat/composer/ContextRow.tsx`（tooltip 补 `cached` + 距自动线，**纯展示层**）；
  另修一条既有守卫 `lib/__tests__/agentActivity.test.ts`（它钉着 ToolLine 的 import 原文）

**批次 B —— 低风险（触及 `useAutoScroll`，需风险评估）· ⏸ 待定**
- 触发条件：**用户真机观察「回到底部」按钮灵敏度** —— 若觉得太敏感（滚 5px 就弹）再做，否则维持现状。
- 届时改：`src/hooks/useAutoScroll.ts`（加只读派生值 `awayFromBottom`，跨阈值 240px 才 setState）
  + `src/components/chat/MessageList.tsx`（按钮条件改 `mode==='free' && awayFromBottom`）
- 届时补断言（滚 5px 不出 / 滚 300px 出 / 回到底消失）
- ⚠️ 若实施后发现对 i5-6400 老机器有卡顿感 → **立刻退回方案 B**（维持 `free` 即显示）

**批次 C —— 中风险（需先验证）· ⏸ 待定（等明确需求）**
- `src/components/chat/markdown/MermaidBlock.tsx`（点击放大入口）
- 实施前**必须先只读验证** `handlers/image-file.cjs` 对 data URL 的行为：
  通过 → 路径 A；不通过 → **放弃该功能**（不动 Runtime、不引新 Lightbox）

**明确不做**
- 1.1 光标：**已存在，不改**（改成行内光标会重新引入跳动）
- 4 上下文：**已存在**；最多做 tooltip 增强（`ContextRow.tsx`），不碰内核

---

## 7. 拍板结果与实施状态（2026-10-13）

1. **1.2 回底按钮** → 用户拍板**方案 A**；但**批次 B 暂缓**，先真机观察灵敏度再定是否实施。
2. **2.2 工具差异化** → **只做图标区分**，禁止类型颜色（颜色仍只表状态语义）· **批次 A 已实施**。
3. **3 Mermaid 放大** → **批次 C 暂缓**，等未来有明确需求再提（未做只读验证，未动代码）。
4. **批次顺序** → 先做 A（零风险）· **A 已实施并验收通过**；B/C 待定。
5. **4 上下文** → 保持现状、**零内核改动**；仅做 tooltip 增强（`ContextRow.tsx`）· **已随批次 A 实施**。

**当前状态：批次 A 已实施（Commit 9fb23af）· 批次 B/C 待定 · 进入真机观察期。**
