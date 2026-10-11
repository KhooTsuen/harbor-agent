# Harbor Agent UI Phase 3 · 设计说明（中央对话降噪）

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0 + Phase 3 任务书。
> 性质：**只读设计说明**。本轮**未修改任何代码**（含三个前置微任务）。
> 基线：HEAD `847cfc3`（main）。前序：`harbor-ui-research-summary.md`、`phase0-real-task-report.md`、`phase1-implementation-report.md`、`phase2-improvement-plan.md`、`phase2-implementation-report.md`。
> 怎么用：第一节是**选型结论**（需你拍板），二~四节是三个子系统的设计，第五节是三个前置微任务，第六节是红线与回滚。

---

## 〇、先说三件必须先讲清的事

1. **这个项目已经有自研的 Markdown 渲染器与自研语法高亮**，不是白纸：
   - 解析：`src/lib/markdown/`（`types` / `inline` / `table` / `blocks` / `blocks-special` / `incremental` / `pending` / `index`，8 个文件）
   - 渲染：`src/components/chat/markdown/`（`Blocks` / `Inline` / `Table` / `MathNode` / `MermaidBlock` / `RawHtml` / `StreamingMarkdown`，7 个文件）
   - 高亮：`src/lib/highlight/`（`tokenizer` / `keywords` / `specs` / `specs-extra` / `markup` / `styles` / `data` / `resolve` / `types` / `index`，10 个文件）
   所以任务书里「评估并选型 react-markdown + remark-gfm」这一项，实际是在问：**要不要用第三方库替换/并存于这套已有实现**。
2. **引入新依赖是本仓库的硬禁区**（`AGENT.md` §3 第 2 条：「需要引入新依赖（含 devDependency）」→ 必须先停下来问）。
   因此无论结论如何，只要方向是「引库」，就**不能直接实施**，必须先拿到你的批准。
3. **「只有正文走 Markdown」这条现状已经成立**，且不是靠约定、是靠**组件边界**实现的（见 §1.3）。Phase 3 要做的是**守住**它，而不是新建它。

---

## 一、Markdown 混合渲染架构（重点）

### 1.1 现状：三类内容，三条不同的渲染路径

| 内容 | 渲染组件 | 是否走 Markdown | 证据 |
|---|---|---|---|
| **模型正文叙述** | `StreamingMarkdown`（流式中）/ `Markdown`（写完后） | **是** | `MessageRounds.tsx:87-91` |
| **工具调用 / 文件读取 / 命令执行** | `ToolLine`（一行摘要）+ `ToolRuns.ToolRunRow`（展开明细，`<pre>` 纯文本） | **否** | `ToolLine.tsx`、`ToolRuns.tsx:133-137` |
| **思考链（reasoning）** | `ProcessBlocks.ThinkBlock`（`whitespace-pre-wrap` 纯文本） | **否** | `ProcessBlocks.tsx:55-62` |
| **计划** | `PlanCard`（结构化，读任务台账） | **否**（正文里的 ```` ```plan ```` 块被**显式丢弃**） | `Blocks.tsx:95` |

**结论**：任务书要求的「工具日志不得 Markdown 化」在当前代码里是**既成事实**，由四个独立组件边界保证。Phase 3 的对应动作是**加一条回归守卫把它钉死**（见 §1.4），而不是改动渲染路径。

### 1.2 选型评估：三个选项

> 说明：体积/依赖数一律**不写具体数字**——需实测后填（本项目硬约束 §2.8：会涨的数字不写死）。

#### 选项 A：react-markdown + remark-gfm + 第三方高亮库（任务书原方向）

| 维度 | 评估 |
|---|---|
| 能力 | ✅ 规范一致性最好（CommonMark + GFM 全量），长期不用自己维护边界用例 |
| 依赖 | ❌ **引入 3+ 个直接依赖 + 一串传递依赖**（remark/micromark/unified 全家桶 + 高亮库）→ 撞硬禁区 §3.2 |
| 与现有流式机制的关系 | ❌ **这是最大风险**：现有的「不闪」靠三件套（`useSmoothText` 帧摊平 / `StableBlocks` 引用不变 + memo / `TailBlock` 的 `contain:layout`），它们是**围绕自研块模型**建的。react-markdown 每次把 text → AST → React 元素**整体重算**，要重建「稳定块引用不变」这条才能不退化成 Phase 0 观测到的「不闪」；否则 0.84.0 那个「写完一段被覆盖重写」的老坑会**复发** |
| CodeBlock 既有能力 | ❌ 行号开关 / 行强调（```` ```ts {1,3-5} ````）/ diff 行底色 / 超 40 行折叠 / 下载 / 语言显示名（`CodeBlock.tsx`）——引库后要么重接，要么丢 |
| 既有扩展 | ❌ KaTeX 公式（`MathNode`）/ Mermaid（`MermaidBlock`）/ 原始 HTML 口子（`RawHtml`，用户 2026-10-08 明确要求开）/ 图片灯箱（`openImageFromDom`）都要重新接线 |
| XSS 面 | ⚠️ react-markdown 默认不渲染原始 HTML（要 `rehype-raw`），与现有的 `RawHtml` 口子语义**不一致**，需要额外对齐 |
| 可回滚性 | ⚠️ 一旦替换，回滚 = 恢复整套自研渲染链 |

#### 选项 B：保留自研渲染器，只补它的**实际**缺口（推荐）

| 维度 | 评估 |
|---|---|
| 能力 | 需先**量化缺口**（见 1.3），但已确认覆盖：表格（含对齐）/ 任务列表 / 删除线 / 粗斜体 / 链接 / 图片 / 行内代码 / 围栏代码 / 标题 / 有序无序列表 / 引用 / 分隔线 / `$$` 数学 / Mermaid / 原始 HTML |
| 依赖 | ✅ **0 新增**（不撞硬禁区） |
| 流式 | ✅ 与现有三件套**天然一体**，无需重建 |
| CodeBlock / 扩展 | ✅ 全部保留 |
| 风险 | 规范一致性靠自己维护 → 用**对拍测试**兜（拿 CommonMark/GFM 官方样例跑自研解析器，差异处逐条决定补不补） |
| 可回滚性 | ✅ 每条缺口改动都是小范围、单文件 |

#### 选项 C：混合（自研为主，只对少数长表格/复杂嵌套引库）

- 评价：**不推荐**。两套解析器并存会出现「同一份对话里表格长得不一样」的接缝 —— 这正是 2026-09-30 拆掉「两套工具卡片」时用户明确反对的情况（`ToolRuns.tsx` 文件头）。

### 1.3 选项 B 的第一步：量化缺口（不猜）

**做法**：新增一个**一次性只读脚本**（`tmp/` 下，不进正式代码），把 CommonMark 0.31 与 GFM 的官方样例逐条喂给 `parseBlocks`，对比期望 AST 形态，输出「通过 / 失败」清单。

- 得到的东西：**缺口清单**（例如「列表松散/紧凑判定」「嵌套强调边界」「自动链接（裸域名）」这类）。
- 然后**逐条决定**：补（小范围、单文件、带单测）还是**明确接受**（写进「已知差异」）。
- 这一步**不改渲染路径**，低风险；跑完才有资格谈「补哪些」。

**建议**：先做这一步（约 1 次会话），拿到数字再决定 B 的后续工作量。**不建议**在没拿到缺口清单前就动解析器。

### 1.4 「不得 Markdown 化」的守卫（无论选哪个选项都要做）

现状靠组件边界，**没有测试钉住**。建议新增回归断言（源码级，同 `phase1Display.test.ts` 的路子）：

- `ToolRuns.tsx` 里工具输出仍是 `<pre>`，**不得**出现 `<Markdown` / `StreamingMarkdown`；
- `ProcessBlocks.tsx`（思考链）同上；
- `Blocks.tsx` 里 `language === 'plan'` 仍然 `return null`（计划不进正文）。

这三条一钉，**「严禁把工具日志 Markdown 化」就从一个约定变成一道闸门**。

---

## 二、流式传输防闪烁与容错

### 2.1 现状：已经是三层缓冲（不是没有）

| 层 | 位置 | 干什么 |
|---|---|---|
| ① 网络层 | 内核 `stream-batch.cjs` | 把上游不均匀的 chunk 批量推给渲染层（治「1.2 秒突然刷一大块」的一半，真 bug 已修） |
| ② 文本层 | `useSmoothText.ts` | **每帧最多前进 `gap/10`**（至少 1 字）——把不均匀的批次摊到帧上；`swapped` 前缀判定处理「换了一段」（P0-1/P0-3 的真根因） |
| ③ 解析层 | `StreamingMarkdown.tsx` + `incremental.ts` | 稳定块 push 进 ref 数组（**引用不变**）→ memo 跳过；尾巴单独重渲 + `contain:layout` |

### 2.2 关于「Buffer」的设计结论

**任务书问「给出流式 chunk 的缓冲策略」——现状已覆盖，且我建议不新增人为 debounce。**

理由（三条，都指向同一个判断）：

1. **再叠一层 debounce 会伤实时感**。上游已经被 `stream-batch` 批过一次、前端已经被 `useSmoothText` 摊平一次；再来一道「攒 100ms 再渲染」只会让文字**更晚到**，而它想解决的「不均匀」已经由 ② 处理了。
2. **真正要防的不是「快」，是「块类型横跳」**（先像段落、写完变表格/列表）。这个已经由 ③ 的 `pending.ts` 处理。
3. **`useSmoothText` 的纪律不能破**：① 写完（`active=false`）立刻给全；② `target` 变化不重启 rAF；④ 换段必须重置。任何缓冲改动都必须通过这四条。

**所以第二节的产出不是「加 buffer」，而是「补齐未闭合结构的降级规则」。**

### 2.3 未闭合语法的优雅降级：现状 + 缺口

`pending.ts` 的 `isIncompleteLine` 已覆盖**单行**残缺：光杆列表标记、光杆标题、未闭合围栏开头、不成形的表格行、光杆 `>`、光杆 `$$`。

**缺口在「跨行未闭合结构」**，两个已知边界：

| 场景 | 现状行为 | 问题 |
|---|---|---|
| `$$` 开了没闭合（`blocks-special.ts:116-117`） | 「吃到末尾，先当公式块渲染」 | 流式中一个 `$$` 之后的**所有内容**会进公式块，直到闭合才修正 → 视觉上是「整段被吞进公式再吐出来」 |
| 表格只写了第一行（`\| A \|` 不完整） | 由 `isIncompleteLine` 判为残缺 → 纯文本 | ✅ 已处理 |

**建议改动（候选，需你确认）**：把「未闭合的跨行块」在**流式期间**降级为纯文本，直到闭合标记出现再升级为块。理由：降级的代价是「短暂显示成原文」，而现状的代价是「整段显示成公式 / 代码块」——前者更接近「还没写完」，后者是**错误的内容**。

- 落点：`blocks-special.ts`（`$$` / HTML 块）与 `blocks.ts`（围栏）。
- 风险：要保证「闭合那一刻的 DOM 与整篇解析一致」（验收 e，现有 `StreamingMarkdown` 注释里明确承诺过），否则收尾会重排。**这条必须在真机上量**。
- 可回滚：单文件。

### 2.4 崩溃防护（现状，保持不动）

三栏各自包了 `ErrorBoundary`（`App.tsx:211-291`），渲染层抛异常不会白屏。**Phase 3 不新增机制**，只是把上面的降级改动放进这个已有的兜底里。

---

## 三、跨轮同类聚合（展示层派生）

### 3.1 现状：同轮内已聚合，跨轮没有

- `ToolLine.tsx` 的 `describeRuns`：**同一轮内**按动作归类计数（「读取 2 个文件、运行 1 条命令」）。
- **跨轮不聚合**：Phase 0 实测（UX-02）—— 6 轮各调一次 `read_file`，界面上是 **6 行独立摘要**，不是一张卡。
- 数据已经够用：`rounds: MessageRound[]`（每轮 `tools: number[]` 是 `toolRuns` 的下标）+ `toolRuns: ToolRunRecord[]`。

### 3.2 设计：在 `MessageRounds` 这一层做「派生聚合」

**核心思路：不改事件契约、不改台账、不动内核 —— 全部在渲染层把相邻同类轮合并成一张卡，复用现有 `ToolLine` 渲染。**

```
输入：rounds[] + toolRuns[]（都已存在）
      ↓  纯函数 groupRounds(rounds, toolRuns) —— 新增，可单测
输出：Group[]，其中每组 { kind: 'tools', runs } 或 { kind: 'turn', round }
      ↓  渲染：'tools' 组 → 复用 <ToolLine runs={...} />（不新增卡片样式）
```

**「连续同类」的判据**（建议，待你确认）：

- 相邻的**轮**之间，只有工具、没有正文（`round.content.trim() === ''`）；
- 同属「同类」（用现有 `AGENT_ACTIONS` 的动作词归类，不新造分类）；
- **全部成功**（见下面的强制打断）。

**强制打断聚合的条件（必须立刻断开，逐条）**：

| 打断原因 | 判据（现有数据） |
|---|---|
| **工具失败** | `run.ok === false`（含 `ms` 已定的） |
| **权限请求 / 授权等待** | 该轮出现 `confirm` 相关记录，或 `message` 上有等确认标记 |
| **安全拦截 / 策略拒绝** | 工具结果带拦截标记（现状：**无独立事件**，见 §3.4） |
| **计划变更** | `task.planVersions` 版本数变化（本消息范围内） |
| **正文出现** | `round.content.trim() !== ''` |
| **澄清卡 / 用户交互** | `message.clarify` 存在的那一轮 |
| **子代理卡** | `run.subagent` 存在（**必须单独显示**，不并入聚合） |

> 上面这张表就是「失败、权限请求、安全拦截必须强制打断聚合」的落地形式 —— 每一条都有**现有字段**可判，不需要新事件。

### 3.3 卡片形态与「诊断层保留」

- **折叠态**：一行，复用 `describeRuns`（它本来就能跨类计数）+ 「· N 步 · 总耗时」。
- **展开态**：复用 `ToolLine` 现有的展开逻辑 —— 里面是 `ToolRunRow` 逐条原始明细（含输出 `<pre>`），**上限 100 条**（`MAX_VISIBLE_RUNS`，AG-038 定的，别动）。
- **诊断不丢**：聚合只影响**折叠时**的样子；展开后每一条原始调用、参数、耗时、输出、失败都在。

### 3.4 两个必须写清的边界

1. **「策略拒绝」目前无法从数据里区分**。
   `error-rules.cjs` 里 `denied → P3`，但**工具结果本身没有「这是策略拒绝」的独立标记**（Phase 0 已记，`ui-safety-visibility.md` §4）。
   所以强制打断里那条「安全拦截」**现在只能靠间接信号**（该轮有失败 + 消息里有策略文案）。要真正做到「识别策略拒绝」，需要**改事件契约** —— 那是禁改项，**本设计不含它**，标为待批项 4（见 §5）。
2. **跨轮 ≠ 跨消息**。聚合只在**一条助手消息内部**的轮次之间做。跨消息不聚合（那会打乱对话的因果顺序）。

---

## 四、Prompt 配合调整

### 4.1 落点：`electron/core/prompt-rules.cjs`

现状已经有半条：`prompt-stack.cjs` 的 `conversationPolicy` 层写着「不重复用户问题，**不使用无意义套话**」。但**没有针对「过渡语」的具体约束** —— 而任务书要治的正是「让我来看看」「好的，我先读一下」这类。

**建议新增一条 `NO_FILLER_RULE`**（内容草案，措辞待你定）：

```
- **别写没有信息量的话**：「让我来看看」「好的，我先读一下」「接下来我将…」
  「首先，我需要…」这类过渡句，只增加长度、不增加信息。
  直接给动作或结论 —— 要读文件就直接调工具，要说结论就直接说。
  但**该解释的要解释**：复杂的取舍、为什么这么改、影响什么 —— 这些是你该说的话，不算过渡语。
```

- 位置：并入 `REST_RULES`（`prompt-rules.cjs:124-131`）或单列一条，与 `TEST_RULE` 同级。
- **不跟开关**（和 `TEST_RULE` / `PLAN_GATE_RULE` 一样）—— 它是通用做派，不跟 `planFirst` / `clarifyFirst`。

### 4.2 必须同步的两处（改了 Prompt 就得跟）

1. **`prompt-stack.cjs` 的 `VERSION` +1**（现值 `prompt-stack/4` → `/5`），并在「变动史」注释里补一行。
   理由写在那个文件里：**任何可能改变模型行为的改动都要 +1**（提示词就是代码），台账靠它追「同一任务为什么前后表现不一样」。
2. **`scripts/selftest.mjs` 的「系统提示内容回归」**：如果只是改 `REST_RULES` 文案，断言可能要跟着更新；如果新增一层，`ORDER` 数组要同步加（那个文件明确写了「删层会让测试红」）。

### 4.3 风险与边界

- **约束过头 → 模型省掉必要的确认**。所以草案里必须保留「该解释的要解释」那半句。
- 这条**不保证**模型一定遵守（提示词是软的）；真正的降噪靠 §三 的展示层聚合 —— **两者是互补的，不是替代**。这条也别指望它解决工具日志刷屏（那是展示层的事）。

---

## 五、Phase 3 前置微任务（三个待批项）

> 这三个都是之前批准列入的，**但每一个都要先确认落点是否触红线**。逐一说明。

### M1 · 内核在一轮结束时 `observer.flush()`

- **目的**：Phase 1 的真机发现 ——「错误角标」要等观察哨 **15 秒定时**或退出才亮，不是「当下」就亮。
- **现状**：`observer.flush()` **已导出**（`error-observer.cjs:297`），只是**没人按轮调用**。
- **落点决定红线归属**：
  - 落 `electron/core/loop.cjs`（`runLoop` 每轮末尾，`for` 循环体第 130 行那一带）→ **触硬禁区 §3.8**（`loop.cjs` 在关键文件名单里）→ 必须先单独报批。
  - 落 `electron/handlers/chat.cjs`（整个会话结束时 flush）→ **不在名单**，但仍属内核改动，需报批。
- **建议**：**先定位**「一轮结束」在现有代码里的确切位置和它的语义（是每 turn 还是整个会话），再决定落点。**本设计不预设落点**。
- **风险**：`flush()` 会写盘（追加 jsonl）。若一轮里被调用过密（每 turn 都调），写盘次数上升 —— 需要确认「一轮」的粒度不会导致每几秒写一次。

### M2 · `firstSeen` / `lastSeen` 类型对齐

- **问题（Phase 1 真机抓到）**：`src/types/errors.ts:27-29` 声明 `number`，但 `error-reader.cjs:150` 把记录的 `ts` **原样透传**（实际是 ISO 字符串）。字符串与数字比较恒 `false`。
- **缓解**：Phase 1 已在 `lib/errorSignal.ts` 兼容两种形状（并加了回归用例），所以现在**功能上不阻塞**。这条是**收尾清理**。
- **两个方向，需你定「哪个是标准」**：
  - (a) 让 `error-reader.cjs` 统一输出**毫秒数**（改内核输出，会同时影响 CLI `scripts/errors.mjs` 的显示）；
  - (b) 只把 `src/types/errors.ts` 的类型改成 `number | string`（**只改类型**，不动数据）。
- **建议 (a)**：单一形状更干净，`error-reader.cjs` 不在硬禁区名单；但要同步检查 CLI 侧的显示与 `formatEntryForCopy`（`errorsApi.ts:41` 现在按 number 处理）。

### M3 · 一轮开始时补台账刷新（**诊断需修正**）

- **Phase 2 的原始结论**：「运行中任务数落后一拍」。
- **本轮复核发现更准确的诊断**：刷新**其实已经被触发**了 —— `useBackendSubscriptions.ts:41-50` 的 effect 依赖 `runningCount`，一轮开始（0→1）就会 `refresh()`。
  所以滞后**更可能**是：**刷新发生在内核把任务记录写进台账之前**（任务记录通常在首轮 plan 之后才落）。
- **所以 M3 的正确形态是「先定位，再改」**：
  1. 在真机上打时间戳，确认是「没触发刷新」还是「触发了但台账还没写」；
  2. 若是后者，改前端刷新时机是**无效**的 —— 要内核在任务状态跃迁时推事件（**改 IPC 契约 → 报批**），或前端改成「一轮结束时再补一次刷新」。
- **本设计不预设方案**，先做定位实测。

---

## 六、红线、回滚与验收

### 6.1 红线核对（本设计本身）

| 约束 | 本设计 |
|---|---|
| 不改 Runtime / IPC / 事件契约 / 台账 / 数据结构 | ✅ 主体（§一~§四）全是展示层派生 |
| 不引入新依赖 | ✅ 结论倾向**不引**（选项 B）；**引库一律先报批** |
| 不通过正则解析模型自然语言伪造 Runtime 状态 | ✅ §三 全部由**结构化字段**（rounds / toolRuns / ok / subagent）派生 |
| 不增加虚假动画 / 百分比 / 无依据的完成声明 | ✅ 本设计不含任何进度百分比 |
| 保留诊断入口 | ✅ §3.3 明确「折叠变简、展开不变」 |
| 触内核 / 契约的必须停 | ✅ M1/M2/M3 均标注「需先报批」，§3.4 标注待批项 4 |

### 6.2 回滚方式（每项都单文件可回滚）

| 改动 | 回滚 |
|---|---|
| 一致性对拍脚本（§1.3） | 删 `tmp/` 脚本 |
| Markdown 化守卫测试（§1.4） | 删测试文件 |
| 未闭合块降级（§2.3） | `git checkout` 对应解析器文件 |
| 跨轮聚合（§三） | 删 `groupRounds` + `MessageRounds` 一行改动 |
| Prompt 规则（§四） | 删 `NO_FILLER_RULE` + `VERSION` 回退 |

### 6.3 验收方式（沿用 Phase 0/1/2 的真机法）

- **真机 + 隔离假上游**（`dist-portable` 副本 + `tmp/` 假模型 + CDP）：不碰你的真实会话与密钥。
- **长任务场景**：假上游造 6+ 轮同类工具 → 看聚合卡（改前 6 行 / 改后 1 卡 + 可展开）。
- **流式场景**：造未闭合表格、未闭合 `$$`、未闭合围栏 → 量「是否横跳 / 是否崩溃 / 收尾是否重排」。
- **快照对照**：改前 / 改后各一张 `Page.captureScreenshot`（我看不到图，结论以 DOM 文本探针与数值为准）。
- **回归**：`npm run verify`（含内核自检 + 安全套件）+ 新增单测。

### 6.4 本设计**没有**验证的东西（如实标注）

- CommonMark / GFM 的**实际缺口清单** —— `NOT_TESTED`（要跑 §1.3 的对拍才知道）。
- 未闭合跨行块降级后的**收尾重排** —— `NOT_TESTED`（要真机量）。
- 跨轮聚合在**极长任务**（几百轮）下的性能 —— `NOT_TESTED`。
- 「策略拒绝」的可判别性 —— 现状**做不到**（需改契约）。

---

## 七、需要你拍板的问题

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| 1 | **Markdown 渲染路径怎么走** | (A) 引 react-markdown+remark-gfm+高亮库 / (B) 保留自研、只补缺口 / (C) 混合 | **(B)**，且第一步先做 §1.3 的缺口对拍 |
| 2 | 若选 B，**缺口补不补** | 全补 / 只补高频 / 只记录差异 | 拿到清单再定 |
| 3 | **未闭合跨行块**是否改为「流式中降级为纯文本」 | 改 / 不改（保持「吃到末尾」） | 建议改，但要真机验证收尾不重排 |
| 4 | **跨轮聚合的粒度** | 一条消息内 / 整个对话 | **一条消息内**（跨消息会乱因果） |
| 5 | **`NO_FILLER_RULE` 措辞** | 用草案 / 你给一版 / 不做 | 用草案（含「该解释的要解释」那半句） |
| 6 | **M2 的「标准」** | (a) reader 输出毫秒 / (b) 只改类型 | (a) |
| 7 | **M1 / M3 是否授权动内核** | 授权 / 先只做定位 / 暂不做 | 先只做**定位实测**，拿到结论再报批 |

---

## 八、文件索引

**本设计的证据来源（均在 `E:\CodexWorkbench\`）**

- 渲染链：`src\components\chat\Markdown.tsx`、`src\components\chat\markdown\{StreamingMarkdown,Blocks,Inline,Table}.tsx`
- 解析：`src\lib\markdown\{index,pending,blocks-special}.ts`
- 平滑：`src\hooks\useSmoothText.ts`
- 工具：`src\components\chat\message\ToolLine.tsx`、`src\components\chat\ToolRuns.tsx`、`src\components\chat\ProcessBlocks.tsx`
- 轮次：`src\components\chat\message\{MessageRounds.tsx,roundsOf.ts}`
- 归类：`src\lib\agentActivity.ts`
- 高亮：`src\lib\highlight\*`、`src\components\chat\codeblock\lines.ts`
- Prompt：`electron\core\prompt-stack.cjs`、`electron\core\prompt-rules.cjs`
- 待批项：`electron\core\error-observer.cjs`、`electron\core\error-reader.cjs`、`src\types\errors.ts`、`src\stores\useTaskStore.ts`、`src\hooks\useBackendSubscriptions.ts`
- 约束：`AGENT.md`（§3 硬禁区）

**同目录前序报告**

- `harbor-ui-research-summary.md`（现状调研）
- `phase0-real-task-report.md`（真机补测）
- `phase1-implementation-report.md` / `phase1-stage-summary.md`（安全可见性等四组）
- `phase2-improvement-plan.md` / `phase2-implementation-report.md`（右栏信息层级）
