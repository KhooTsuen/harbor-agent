# PlanCard 动态更新设计说明

> **状态**：**已实施**（2026-10-13，Commit `0b41401`）—— 本文保留设计原样，实施结果见
> `CHANGELOG.md` 的 `[未发布]`（第 8 行那条）。**真机肉眼确认待做**（人类视觉验收）。
> **基线**：`HEAD = 8eb6a42`（设计时）。
> **用户症结**：真机使用中发现「计划卡始终显示初始状态（0/5），完全跟不上真实进度」。
> **本文只回答**：怎么让计划卡**吸收真实执行事实**、动态展示进度；**不动** Runtime / IPC / 任务台账结构。
> 证据规矩同其它文档：每条指得住 `文件:行号`。

---

## 0. 一句话结论

**能修，而且不用新增任何字段、不用解析任何自然语言。**

内核早就在台账里记着真实执行事实（`task.steps` / `task.checkpoints` / `task.changedFiles`），
前端也**已经在每次工具跑完后重读**（`streamEvents.ts` 的 AG-005），Phase 5 甚至已经写好了一个
**纯函数 `execSummary(task)`**（`taskCenterModel.ts:63-73`）——缺的只是**把它喂进计划卡**。
所以本设计是**加法**：给计划卡加一行「已执行 X 步 · 已修改 Y 个文件」，数据全取自已有字段。

---

## 1. 现状：三个「计划 N/M」分别住在哪

| 位点 | 文件 | 显示什么 | 吃什么数据 | 何时可见 |
|---|---|---|---|---|
| **任务行** | `TaskRow.tsx:143-146` | `计划 N/M 步 · 已执行 K 步` | `task.plan` + `execSummary(task)` | 任务中心列表（**已含执行事实**，Phase 5 做过）|
| **计划卡** | `PlanCard.tsx:117-124` | `计划 N/M 步`＋`· 第 N 版` | `versions` prop（← `task.planVersions`）| 任务**详情折叠区**（默认收起）|
| **计划栏** | `composer/PlanBar.tsx:74-84` | `计划 · N/M`＋`正在做：…` | `useTaskStore` 里的 `task.plan` | 输入框旁（**常显**）|

> ⚠️ 三个位点里，**只有任务行**现在带真实执行步数。计划卡（本次目标）**卡里只有「模型勾的计划条数」**——
> 而那个数字只在**模型重发计划块**时才变（Phase 5 已定位：模型只在每轮的第 1 个 LLM 轮次输出正文，
> 后续工具轮没正文 → 勾选永远停住）。见 `docs/research/ui-phase5-progress-design.md` §2 断点①。

### 1.1 `PlanCard.tsx` 现在的渲染逻辑（逐条）

- **props 只有一个**：`PlanCard({ versions }: { versions: PlanVersion[] })`（`PlanCard.tsx:107`）。
  `PlanVersion = { plan: string[]; at: number; reason: string }`（`PlanCard.tsx:31-35`）。
- **数据来源**：`TaskRowDetails.tsx:89` 传入 `task.planVersions ?? []` —— **完全来自任务台账**，组件自身**不读 store、不读 IPC**。
- **渲染结构**（`PlanCard.tsx:115-160`）：
  1. 标题行：`ListChecks` 图标 + `planProgressLabel(doneCount, current.plan.length)`＋`· 第 N 版`（`title=PROGRESS_TITLE` 悬停说明）；
  2. `PlanSteps`（`markCurrent`）——`●` 标「第一条没勾掉的」；
  3. 若 `older.length > 0`：可折叠的「计划历史（N 版）」。
- **没有执行事实**：整个组件**不引用** `steps` / `changedFiles` / `checkpoints`；`PROGRESS_TITLE` 只在 `title` 上说明「执行要看任务行」。

### 1.2 `TaskRow` / `ProgressTimeline` 怎么用 `task.steps`（这就是要复用的逻辑）

- `taskCenterModel.ts:63-73` **`execSummary(task)`**：纯函数，只读已有字段——
  `{ steps: task.steps.length, ok, failed, checkpoints, files }`。**零新字段、零猜测**。
- `taskCenterModel.ts:81-86` **`execProgressLabel(exec)`**：`已执行 N 步`（有失败补 `（M 次失败）`）；
  **`steps === 0` 返回空串** ——「宁可不显示，也不显示『已执行 0 步』」。
- `TaskRow.tsx:83` `const exec = execProgressLabel(execSummary(task))`，`:146` 并列显示。
- `ProgressTimeline.tsx:93` 收 `steps` prop，画动作行（真实执行）与待办行（计划）**分开**——
  它明确**不猜「哪个工具对应哪条计划」**（`:27-28`）。

**→ 结论：把 `execSummary` 注入 PlanCard 是**纯加法**，与既有原则完全一致。**

---

## 2. 设计：给计划卡加「动态侧边状态」

### 2.1 数据层（零新字段）

**不新增任何台账字段**。复用 `execSummary(task)`（已存在）。新增**一个纯映射函数**：

```
// taskCenterModel.ts（示意，非最终代码）
export function execMetaLabel(exec: ExecSummary): string
// → "已执行 12 步 · 已修改 3 个文件"（files === 0 时省掉后半段；steps === 0 时返回 ""）
```

- 与 `execProgressLabel` **同一数据源**（都吃 `ExecSummary`），措辞只有这一处 → 不违反「单一真相源」。
- `steps === 0` 返回空串：**和既有约定一致**（不显示「已执行 0 步」）。

### 2.2 props 变更（PlanCard 只加一个可选 prop）

```
// 改前
PlanCard({ versions }: { versions: PlanVersion[] })
// 改后
PlanCard({ versions, exec }: { versions: PlanVersion[]; exec?: ExecSummary })
```

- **保持 PlanCard 是展示组件**（不读 store）：`exec` 由调用方算好传进来，
  和现在的 `versions` 一样「数据从上面来」。
- **可选**（`exec?`）：老调用点 / 单测不传也不会炸；不传 = 行为与改前**一字不差**。

### 2.3 布局：上半静态 / 下半动态（严格照用户的形状）

```
┌──────────────────────────────────────────┐
│ ▤ 计划 0/5 步 · 第 2 版                    │   ← 静态（模型勾的条数，现状不动）
│ 已执行 12 步 · 已修改 3 个文件              │   ← 动态（新增，只读 task.steps/changedFiles）
│ ● 1. 读现状                                │
│ ○ 2. 改                                    │   ← 步骤列表（现状不动）
│ …                                          │
│ ▸ 计划历史（1 版）                          │   ← 折叠历史（现状不动）
└──────────────────────────────────────────┘
```

- **动态行紧贴标题行之下、步骤列表之上**：**常显**（不放进折叠的「计划历史」里）。
- 措辞用 `title` 挂在动态行上，沿用 `PROGRESS_TITLE`（不新造第二套口径说明）。

### 2.4 措辞的单一真相源

| 词 | 唯一出处 |
|---|---|
| `计划 N/M 步` | `planProgressLabel`（`taskCenterModel.ts:107`）——不动 |
| `已执行 N 步` | `execProgressLabel`（`taskCenterModel.ts:81`）——不动 |
| `已执行 X 步 · 已修改 Y 个文件`（卡内一行）| **新增** `execMetaLabel`（同上文件）|
| 口径说明 | `PROGRESS_TITLE`（`taskCenterModel.ts:93`）——不动 |

### 2.5 第二个位点：`PlanBar`（建议一并处理）

`PlanBar`（输入框旁、**常显**）是用户**实际盯着「0/5」**的地方（计划卡藏在详情里默认收起）。
同样加一段执行事实（它在 `useTaskStore` 里已经能拿到整条 task）：

```
改前：  计划 · 0/5       正在做：读现状
改后：  计划 · 0/5 · 已执行 12 步 · 已修改 3 个文件     ← 小号 / tertiary / truncate
```

**这是待你拍板的一项**（见 §8）：不做 PlanBar 也能满足字面诉求（PlanCard），
但「用户实际看到的 0/5」多半在 PlanBar。

---

## 3. 平滑过渡 & 防抖动（严格对照防闪烁三件套）

### 3.1 先厘清适用性（重要）

| 三件套 | 管什么 | 与计划卡的关系 |
|---|---|---|
| `useSmoothText`（`hooks/useSmoothText.ts`）| **流式 token** 的「摊平到帧」| **不适用**：计划数据是**结构化离散跳变**，不是 token 流。**套上去 = 数字慢慢爬，反而制造抖动**。**不引入**。 |
| `StableBlocks`（`markdown/StreamingMarkdown.tsx`）| 流式 markdown 的**稳定块 memo** | **不照搬**（计划卡不是 markdown）。但**它的原则适用**：稳定引用 + memo + `contain: layout`。 |
| `scrollGuard` / `useAutoScroll`（`chat/scrollGuard.ts`、`hooks/useAutoScroll.ts`）| **消息列表**的 FOLLOW/FREE 滚动意图 | **无耦合**：`ScrollGuardContext.Provider` **只在 `MessageList.tsx:172`**；计划卡在任务中心（`RightPanel`），PlanBar 在输入框——**都不在消息列表里**。**不要碰它、不要在计划卡里调 `enterFree()`**（现状没调，实施时保持）。 |

> **一句话**：计划卡的「防抖动」**不靠动画**，靠**DOM 稳定**。
> 加淡入淡出 / 高度过渡才是抖动源。

### 3.2 具体做法（每条对应一个真实抖动源）

| 抖动源 | 做法 |
|---|---|
| 计数位数变化（9→10）导致后续文字左右跳 | 动态行用 **`tabular-nums`**（等宽数字）|
| 每次刷新增减节点 → 卡片高度跳 | 动态行**始终是同一个 `<span>`**，只改 `textContent`（节点数恒定）；**不加** `aria-live`（每步播报太吵）|
| 「0 步」时整行消失 / 出现 | 整行在 `steps === 0` 时**不渲染**（与 `execProgressLabel` 空串约定一致）；高度从 0→1 只变**一次**，不是每次刷新都变 |
| 步骤列表每次刷新重挂 | `PlanSteps` 的 key 保持 **`${index}-${step}`**：同一版计划内文本不变 → key 不变 → 不重挂。**跨版本**内容确实变了才重挂（那是真变化）——**不加**过渡动画 |
| 模型重发计划块（新版本）时主区被换掉 | **现状已天然平稳**：旧版自动折进「计划历史」折叠区，主区直接显示新版（`PlanCard.tsx:111-112` 的 `older`/`current` 切分）。**无需额外动画** |
| `PlanCard` 被无谓重渲 | 可选 `memo(PlanCard)`；但 `TaskRowDetails` 每次 refresh 换的是**新的 task 对象**，memo 收益有限——**主手段是「稳定 DOM」，memo 为辅**。注意别在 props 里写 `?? []`（每次 new 引用会破坏 memo）|

### 3.3 明确**不做**的三件事

1. **不解析自然语言**：只读 `task.plan`（已有的 `[x]`）与 `task.steps` 等结构化字段。
2. **不猜「计划第 N 条 ↔ 哪个工具」**：内核没这个归属事实（Phase 5 已定论），**一步不碰**。
3. **不做「计划自动打勾」**：那需要模型显式声明步骤归属（改提示词 + 事件契约），**撞硬禁区 11/12**，本设计不做。

---

## 4. 拟修改文件（**全部在 `src/components/chat/`**）

| 文件 | 改什么 | 为什么 |
|---|---|---|
| `src/components/chat/taskCenterModel.ts` | 新增纯函数 `execMetaLabel(exec): string` | 措辞单一真相源（状态映射层）|
| `src/components/chat/PlanCard.tsx` | 加可选 prop `exec?: ExecSummary`；标题行下渲染动态行（`tabular-nums`）| 本次核心诉求 |
| `src/components/chat/TaskRowDetails.tsx` | 传 `exec={execSummary(task)}`（可 `useMemo`）| 把数据喂进卡 |
| `src/components/chat/composer/PlanBar.tsx` | （**待拍板**）折叠行尾补同一段执行事实 | 用户实际盯的位点 |
| `src/components/chat/__tests__/planCard.test.ts` | +`execMetaLabel` 纯函数断言 + 源码守卫 | 钉接线（防「写好了没人调」）|
| `src/components/chat/composer/__tests__/planBar.test.tsx` | （若做 PlanBar）真渲染断言 | 同上 |

**明确不动**：`electron/**`（Runtime / IPC / 台账结构）、`useSmoothText` / `useAutoScroll` / `scrollGuard`、`ProgressTimeline.tsx`、三个 `[x]` 兼容函数（`isDone` / `textOf` / `isPlanDone`）。

---

## 5. 改前 / 改后 UI 行为对比

| 场景 | 改前 | 改后 |
|---|---|---|
| **任务在跑 · 计划卡（详情内）** | `计划 0/5 步`（悬停才看到口径说明）| `计划 0/5 步` + **`已执行 12 步 · 已修改 3 个文件`** |
| **任务在跑 · 计划栏（输入框旁）** | `计划 · 0/5` ＋「正在做：…」| （若做）`计划 · 0/5 · 已执行 12 步 · 已修改 3 个文件` ＋「正在做：…」|
| **刚动手、还没有执行事实** | `计划 0/5 步` | `计划 0/5 步`（**动态行不出现**，与改前一致）|
| **每次工具跑完（自动刷新）** | 数字**不动**（卡死）| 动态行**跟着变**（12→13…）——**只改文字，不重排列表、不换高度** |
| **模型重发计划块（新版本）** | 主区换新版，旧版进「历史」 | **同左**（本次不动这条链路）+ 动态行**不受影响**（它读的是执行事实，与计划版本无关）|
| **老任务（`planVersions` 缺省）** | 卡不渲染（`versions.length === 0` 早返回）| **同左**（`exec` 可选，缺省 = 不显示）|
| **全键盘 / 屏幕阅读** | — | 动态行**不加 `aria-live`**（避免每步播报），仅普通文本 + `title` 口径 |

---

## 6. 边界核对（逐条对照本次任务约束）

| 约束 | 本设计 |
|---|---|
| 不用正则解析自然语言猜「第几步完成」| ✅ 只读 `task.plan` 的 `[x]` 与 `task.steps` 等结构化字段 |
| 不猜「计划第 N 条 ↔ 哪个工具」| ✅ 完全不建立映射（Phase 5 已定论）|
| 必须基于 `task.steps` 结构化事实 | ✅ 走 `execSummary`（只读 steps/checkpoints/changedFiles）|
| 只动 `src/components/chat/` 展示层 + 必要状态映射 | ✅ 4 个源文件全在 `src/components/chat/`；映射 = `taskCenterModel.ts` |
| 严禁碰 Runtime / IPC / 任务台账结构 | ✅ 零 `electron/**`、零新字段、零 IPC |
| 严格遵守防闪烁三件套 | ✅ 不引入 `useSmoothText`；`scrollGuard` 无耦合不碰；靠 DOM 稳定（§3）|
| 只调研和设计，不写实施代码 | ✅ 本文无实施改动 |

---

## 7. 测试方案（实施阶段用，本阶段不写）

- **纯函数**：`execMetaLabel` 的三种边界（`steps=0` → 空串；`files=0` → 只显示步数；都有 → 拼接）。
- **真渲染**（jsdom，照 `planBar.test.tsx` 的做法）：给 `PlanCard` 传 `exec`，
  断言 DOM 文本含「已执行 12 步 · 已修改 3 个文件」；不传 `exec` 时**不含**该行（保证向后兼容）。
- **接线守卫**（源码断言，照 `planCard.test.ts:59-77`）：`TaskRowDetails.tsx` 真的把 `execSummary(task)` 传给了 `PlanCard`。
- **负向实验**（本项目的规矩）：拆掉 `exec` 接线后，真渲染断言应**当场变红**。

---

## 8. 待你拍板（2 项）

1. **是否一并改 `PlanBar`**：
   - 做 → 用户**实际常显**的「0/5」也能看到执行事实（更贴合症结）；
   - 不做 → 只满足 PlanCard 字面诉求，但「0/5」在常显栏里**仍只有计划条数**。
   - **默认建议：做**（改动小、位点同层）。
2. **动态行的位置**：
   - A（默认）标题行下、步骤列表上（**常显**）；
   - B 放在卡片**底部**（步骤列表后）。
   - **默认建议：A**（一眼可见，且不与「历史」折叠区混）。

> 你确认后，我再单独安排实施（届时会按 AGENT.md 的交付报告模板走，含 `npm run verify` 与负向实验）。
