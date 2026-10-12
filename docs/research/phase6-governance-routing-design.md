# Phase 6 前置调研与方案说明 —— 任务治理与模型路由

> 状态：**只读调研，未写任何实施代码**（2026-10-13）。
> 参考项目：[`yjh051108/dsh-routing-suite`](https://github.com/yjh051108/dsh-routing-suite)（MIT，7.0k★）。
> 本轮只做「摸清现状 + 出方案 + 标风险」，等确认后再进实施。

---

## 0. 结论摘要（先读这一节）

**一句话**：参考项目的三件套里，**两件的「地基」Harbor 已经有了**，第三件（红队门）成本高、且与 Harbor 现状冲突 —— 建议只做前两件，且都做「加法」（新增层/新增判定），不动任何既有状态机与数据结构。

| 方向 | Harbor 现状 | 结论 | 主要风险 |
|---|---|---|---|
| ① 任务感知路由 + persona | **已有**纯正则意图分类（`mode-router`）+ 角色路由（`router`，默认关） | ✅ **可做**，但分类器**必须零 LLM 调用**、persona **必须首轮锁定** | 中途换 persona = 前缀缓存全废、成本暴涨 |
| ② 脑暴对齐 + 北极星 | **已有** `ask_user`（≤3 题、带默认值）+ 任务台账 | ✅ **可做**，但「北极星」是**新语义** | 塞进现有字段 = 语义污染（撞硬约束 11） |
| ③ 打卡制 + 红队门 | **已有** `completionGate`（计划门禁 + 验证门禁，**已基于内核结构化事实**） | ⚠️ **部分可做**；红队门**建议后置或不做** | 红队门要新增工具 → 撞工具注册表 / 风险分类 |

### 需要你拍板的 3 个点（见 §7）

1. **分类器的触发时机**：只在首轮判一次（省、可缓存）？还是每轮都判（灵活、但可能要改提示词前缀 → 废缓存）？
2. **「北极星」往哪存**：复用现有字段（`goal`）、还是**单独批准加一个字段 `star`（走迁移）**？我倾向后者 —— 前者是语义污染。
3. **persona 的粒度**：只做「弱档 / 强档」两级（改动最小）？还是照参考项目做 spec/react/weak 三带（更细、但要更多实测才敢上）？

---

## 1. 参考项目读到了什么（设计思想摘要）

读了：根 `README.md`、`preset/README.md`、`graded/README.md`、`graded/docs/ARCHITECTURE.md`、`graded/docs/STUDY.md`。
（`graded/docs/THEORY.md`、`preset/docs/paper.md` 已下载未细读 —— 需要理论细节再补。）

### 1.1 preset（思维模式路由）—— 核心是「一条实测出来的相变」

- 实测发现：**同一个模型**在 persona 轴上**不是连续可调**的，而是塌缩成**三段稳定区**：
  `spec`(0–0.19) / `mixed`(0.2–0.49，**过渡陷阱，永不自动选**) / `react`(0.5–1.0)。所以路由是**量化到稳定区**，不是假装能连续调。
- **按模型选 persona**：Pro → spec 句 + 分类指令；Flash → neutral + 锚点。**模型在首个请求锁定（path commitment）**。
- **三条硬事实（对我们最有用）**：
  1. **首轮就要分类**（读第一条真实用户消息），否则会无条件落到 weak；
  2. **中途换 persona = 整个前缀缓存作废**，尾部 persona 也无效 —— 只能靠「隔离子代理」换模式；
  3. **近距离引导必须与用户消息同请求注入**，否则每轮多一次 API 调用 = **费用 2×**（v0.3.0 专门修掉了这个 2× 尖峰）。
- 三锚：回顾 + 收敛 + 反跑题（开放任务完成率 0% → 100%）。

### 1.2 graded（分级任务协议）—— 「脑暴 → 定稿 → 规格化 → 打卡 → 红队 → 终验」

- 全链 7 步（`README` 原文）：脑暴选择题对齐 → `commit_star` 北极星定稿 → L1/L2 规格化（全必填门控）→ 审核 → 执行 + 打卡 → 组收官 → 终验。
- **状态磁盘单轨**：唯一权威 = `$DSH_HOME/graded-state/<sid>.json`，**无内存副本**；阶段推进靠**工具调用成功**（零字符串解析）。
- **打卡硬门**：`mark_task` = 唯一前进许可；`verify=redteam` 的项**未裁决通过不得打卡**。
- **实测对抗**（`STUDY.md`）：无协议长程任务末段验证**几乎消失**（「1 工具 / 0 读图」）；协议链均匀（24/24 打卡）。
- ⚠️ 诚实标注：这套是**DSH 宿主插件**（依赖 `agent/pre-step`、`agent/inbox/claimed` 等宿主事件）。Harbor 是另一套架构，**只能借思想，不能照搬机制**。

---

## 2. 方向一：任务感知的路由与模型选择

### 2.1 Harbor 现状（有证据）

**System Prompt 组装链**（`electron/core/prompt-stack.cjs`）：

- 分层装配，`ORDER` 17 层（`prompt-stack.cjs:126-161`），**显式按前缀缓存设计**：
  - **稳定区**（前 12 层）：`coreIdentity … workRules, safety`
  - **易变区**（后 5 层）：`relevantMemory, taskState, conversationState, retrievedContext, currentTime`
  - 注释原文（`:152-156`）：「易变区一律放后面；缓存前缀到这儿就断了」「currentTime 必须在最后 —— 它是唯一每轮都变的」。
- `VERSION = 'prompt-stack/5'`（`:112`），每轮记进台账（`task.promptVersion`）。
- 实测静态规则文本（本机跑 `tmp/_p6_measure.cjs`）：**SAFETY 252 + BROWSER 1240 + workRules 2353 + MODE 196 + PERMISSION 199 ≈ 4240 字 ≈ 2650 token**（**不含** AGENT.md、工具 schema、记忆、环境）。

**意图分类**（`electron/core/mode-router.cjs`）：**纯正则、零 LLM 调用**，5 条规则 → `research/creative/agent/code/think/chat`（`:2-8`），带 confidence。已 emit `mode` 事件（`loop-route.cjs:62-68`）—— 但目前**只用来告诉界面**。

**模型路由**（`electron/core/router.cjs`）：按角色 `fast/reasoning/coding/vision/cheap` 选模型，关键词 + 场景（`:40-48`）。**默认关闭**（`:87` `if (!config.router?.enabled) return fallback`），默认 roles 全空（`config-defaults.cjs:206-208`）。注释原话：「自动换模型不透明，用户会觉得『回答风格怎么变了』」。

**会话级模型**（`model-select.cjs`）：`thread.model` → 注入 `config.assistant.model`（唯一落点）。

默认供应商（`config-defaults.cjs:58-66`）：`deepseek`，`models: ['deepseek-chat','deepseek-reasoner']`（**没有** flash/V4-pro 的内置概念，全是用户可配）。

### 2.2 方案：**扩展**而不是**新建**

> ⚠️ 关键判断：**不要从零造分类器** —— `mode-router` 就是那个「轻量级、不调 LLM 的分类器」。要做的是**把它从「只告诉界面」升级为「可参与 persona 选择」**。

- **分类器**：复用 `mode-router.resolve()`（正则）。**严禁**改成调 LLM —— 参考项目的 2× 费用尖峰就是这么来的。
- **persona 层**：作为**稳定区的一层**（放在 `conversationPolicy` 之后、易变区之前）。因为它在会话/任务开始时定一次就不再变 → 前缀缓存**照样命中**。
- **首轮锁定**：persona 由**第一条真实用户消息**分类决定，之后**整个会话/任务不再变**（对齐参考项目的 `path commitment`）。中途想换 → 只能靠「隔离上下文」（Harbor 已有 `spawn_subagent` 的隔离先例）。
- **两级就够**（先做）：`强档`（plan/reasoning 类任务：读得细、先规划后动手）/ `快档`（问答/小改动：直接做、少废话）。三带（spec/react/weak）留作后续（需要更多真机实测才敢上）。

### 2.3 对「首 Token / 成本 / 前缀缓存」的影响（**实测口径**）

| 项 | 影响 | 说明 |
|---|---|---|
| 首 Token 时间 | **≈ 0** | 分类是纯正则（微秒级），**不增加任何 API 往返** |
| 输入成本（第 2 轮起） | **≈ 0** | persona 放稳定区 → 命中的 token 约 **1/10 价**（`prompt-stack.cjs:129-130` 原文口径） |
| 输入成本（首轮） | **+一次** | persona 文本（估计 200–400 token）首轮要付全价 —— 与现状「首轮建前缀」同类 |
| **前缀缓存命中率** | **保持不变** | 只有当 persona **每轮变**时才会全废 —— 所以**必须锁定** |
| 内存 | **< 1 MB** | 纯字符串/小对象 |

**唯一会炸的写法**：让 persona 随每一轮的用户消息变（= 把 persona 放进易变区或每轮重算）→ 前缀缓存全废，成本直接翻几倍。**方案里写死：persona 首轮锁定。**

---

## 3. 方向二：脑暴对齐与北极星锚定

### 3.1 Harbor 现状

**任务诞生**：`loop-run.run`（`loop-run.cjs:25-132`）→ `taskResume.openForRun`（`task-resume.cjs:120-162`）→ `taskCore.create`（`task-create.cjs:20-107`）。`goal` = 用户原话（`chat.cjs:214`）。

**台账字段全表**（`task-create.cjs:35-104`）：`id/title/goal/status/mode/sessionId/projectId/workdir/parentTaskId/plan/planVersions/steps/checkpoints/changedFiles/commands/changeSetId/errors/result/budget/preset/pauseReason/…/nextAction/permissions/model/models/promptVersion(s)/regeneratedFrom/budgetCarry/supersededBy/turns/pausedAt/resumeCount/createdAt/updatedAt/finishedAt`。

**澄清机制**：`ask_user` 工具（`tools/ask_user.cjs`）——**≤3 题、每项 2–4 选项、必带 `defaultValue`**，走 `clarify` 往返卡片。提示侧 `CLARIFY_RULE`（`prompt-rules.cjs:40-56`）已定义「什么时候该问 / 不许在正文里问」。

**PlanCard**（`src/components/chat/PlanCard.tsx`）：渲染 `plan` + `planVersions`（版本历史），勾选来自模型写的 `[x]`。

**没有**任何「对齐结果 / 北极星 / 目的宣言」概念（全仓库 grep `persona`/`北极星`/`north` 无命中）。

### 3.2 方案

- **脑暴对齐**：**复用 `ask_user`**（不要新造）。复杂任务首轮先问 ≤3 题；`CLARIFY_RULE` 已经规定了「什么问题该问」。参考项目的「≤5 题/轮」与 Harbor 的「≤3 题」不同 —— **保持 3 题**（已有的卡位与文案都按 3 做的）。
- **北极星宣言**：用户确认后，生成一句「目的宣言」（不照抄原话、≥12 字，照参考项目 `commit_star` 的约束）。
- **锚点回显**：每轮把北极星注入 `taskState` 层（**易变区**，零缓存风险）——这一层本来就是「任务进行到哪了」的注入点（`task-context.cjs:buildTaskState`）。
- **持久化（关键）**：⚠️ **这是与你的约束冲突的点**。

| 选项 | 落点 | 代价 |
|---|---|---|
| A. 复用 `goal` | 把宣言写进 `task.goal` | **语义污染**：`goal` 是「用户原话」，被覆盖后「这条任务当初要什么」就查不到了；且 `goal` 参与标题提炼（`fallbackTitle`） |
| B. 复用 `checkpoints` | 记一条 `{label:'北极星', note:宣言}` | 污染「检查点」语义（那是**可回滚**的东西），撞「重复状态比缺状态更难收」（硬约束 11） |
| C. **加一个字段 `star`** | `task-create.cjs` 的初值 + `task.cjs` 的 `update` 白名单 + 迁移 | 动**数据结构** → 按你的约束**必须单独批准**（硬约束 5 要求写迁移、保留旧数据） |

**我的建议：C**。理由：北极星是一个**新的、独立的**语义（不是 goal、不是 checkpoint、不是 nextAction），硬塞进现有字段只会制造第二个真相源。C 的成本是「一个字段 + 一次迁移（老任务读出来 `star` 为空即可，与 `planVersions` 的兼容方式一致）」——**这是本项目已经做过很多次的迁移**（如 `planVersions`、`steps[].action`）。

> 若你坚持「绝不动结构」，那就只能选 A，并接受语义折衷 —— 但我会在 CHANGELOG 里把这个折衷写清楚。

---

## 4. 方向三：打卡制与红队门

### 4.1 Harbor 现状（**重要：地基比想象的厚**）

- **没有** `mark_task` 工具。Harbor 的「打卡」= 模型在 ```plan 块里标 `[x]`，`capturePlan` 解析（`task-context.cjs:233-255`）。
- **执行治理已在**（`task-steering.cjs`）：
  - **计划门禁** `shouldContinue`（`:58-94`）：计划没勾完就想收工 → 顶回去；`MAX_BLOCKS=3` + **停滞检测**刹车。
  - **验证门禁** `shouldVerify`（`:112-163`）：改了文件但**改完之后一条命令都没跑** → 顶回去验证。判据**只认台账结构化事实**：`steps` 里有没有 `write_file/edit_file`、其后有没有 `run_shell`（`WRITE_TOOLS`，`:97`）。注释原文：「**不去猜『跑的是不是测试』**」。
  - `completionGate`（`:176-187`）= 两道门禁合成一次调用。
- **结构化的执行事件已在**：`task.steps[]`（`task-notes.cjs:65 addStep`：`{at,tool,ok,ms,summary,args,action}`）、`checkpoints`、`changedFiles`、`commands`。UI Phase 5 的 `execSummary` 就是读它们。

> ★ **这正是你要的「严格区分内核真实执行事件 vs Prompt 软约束」** —— Harbor 的验证门禁**已经是**「从内核结构化事实判断」，**不是**正则解析自然语言。Phase 6 的严格模式**沿用这个判据**即可，**不需要新造解析器**。

### 4.2 方案（严格模式）

- **开关**：新增 `assistant.strictMode`（默认关）—— 与现有 `planFirst / clarifyFirst / verifyAfterEdit / scaleFirst` 同一类「软约束开关」（`prompt-rules.cjs:175-190` 的收口处）。
- **「子任务完成后强制验证」怎么落**：⚠️ **做不到「第 N 条计划必须跑测试」** —— 因为「计划第 N 条 ↔ 哪个工具」的**归属事实不存在**（Phase 5 已确认，`ProgressTimeline.tsx:27-28` 明写「不猜对应关系」）。硬配就是编。
  - **能做的**：把验证门禁从「**收尾时一次**」加强为「**每勾掉一条计划 / 每累计 N 次写操作，就要求一次验证**」——判据仍是 `steps` 的结构化事实。
  - 这样既满足「未验证不得进入下一步」，又**不编**归属关系。
- **红队门**（`verify=redteam 未裁决不得打卡`）：**建议后置或不做**。
  - 代价：要新增 `redteam_verdict` / `mark_task` 之类的**内核工具** → 触及 `tools/registry.cjs` 的 `ALL`（`:37-55`）与 `WRITE_TOOLS`（`:71-84`），可能还要动 `risk.cjs` 分类（**撞硬禁区 10：权限/安全模型**）。
  - 收益：对**个人单机 Agent** 而言，「另一个模型当红队」的收益不确定（参考项目是多人/长程场景）。
  - 若要试，**最小形态**：不加工具，只在严格模式下把「验证门禁」的**判据收紧**（要求跑过至少一次命令 + 回读改动文件），不引入「裁决」这个新实体。

---

## 5. 老机器成本评估（i5-6400 / 16GB / HDD）

| 机制 | CPU | 内存 | 磁盘 I/O | 网络/API |
|---|---|---|---|---|
| 分类器（正则） | 微秒级 | ~0 | 0 | **0**（不调 LLM） |
| persona 层（稳定区文本） | < 1ms（拼接） | < 1MB | 0 | 首轮 +200–400 token 输入 |
| 脑暴对齐（复用 ask_user） | ~0 | ~0 | 0 | 0（走已有澄清往返） |
| 北极星回显（taskState 层） | ~0 | ~0 | 0 | 每轮 +约 50 token（易变区，**不**命中缓存） |
| 严格模式（读 steps 判断） | ~0（纯内存遍历 ≤200 条） | ~0 | 0（**不新增写盘频次**） | 0 |

**结论**：三项机制**都不增加 LLM 调用次数、不新增依赖、不显著增加 I/O**。
HDD 是这台机器唯一的硬瓶颈，但严格模式**只读**已落盘的 `steps`，**不增加写盘次数**（Harbor 本来就每步写一次台账）。
**净新增成本**：每轮约 **50 token**（北极星回显），首轮约 **200–400 token**（persona）。**可忽略**。

---

## 6. 边界与风险清单

### 6.1 必须守住的（你的约束）

- ❌ 不改 **Runtime / IPC / 任务台账结构 / 权限模型** —— 本方案除「北极星字段」（§3.2-C，待批）外，**零结构变更**。
- ✅ 建立在 **E2 原子写**之上（新写的任何落盘都走 `safe-write.writeAtomic`）。
- ✅ 建立在 **UI Phase 5 动态进度**之上（严格模式的验证判据复用 `steps`，与 `execSummary` 同源）。
- ✅ **不碰防闪烁三件套**：`useSmoothText`（流式摊平）/ `useAutoScroll`（滚动状态机）/ `scrollGuard`（滚动意图通道）—— 全在**渲染层**，Phase 6 是**提示层 + 内核判定层**，**结构上不相交**。

### 6.2 会牵动的既有测试 / 闸门（提前知道）

- `scripts/selftest/groups/06-prompt-state.mjs`：断言 `ORDER` 层数与顺序（`:55`）、`VERSION` 形如 `prompt-stack/N`（`:114`）—— **加 persona 层必须同步改这里 + 升 VERSION**（`prompt-stack.cjs:92-111` 的规矩）。
- `prompt-rules.cjs` 的开关收口（`:175-190`）：新增 `strictMode` 要在这里落一条（和 `verifyAfterEdit` 并列）。
- 工具注册表（若走红队门）：`tools/registry.cjs:37-84` + `scripts/selftest` 的「工具清单」组。

### 6.3 已知的「不该做」

- ❌ **不要**用 LLM 做分类器（参考项目的 2× 费用尖峰）。
- ❌ **不要**正则解析模型自然语言判断「打没打卡」（你点名禁止的）。
- ❌ **不要**中途切 persona（前缀缓存全废）。
- ❌ **不要**照搬 DSH 的宿主事件（`agent/pre-step` 等）—— Harbor 没有那套，强搬 = 造第二套事件系统。

---

## 7. 建议的实施顺序（分三批，各自可回滚）

1. **批次 1（最小、最安全）**：persona 层 + 两级分类 —— 只加**一层稳定区文本** + 复用 `mode-router`，升 `prompt-stack` 版本 + 同步 `06-prompt-state` 自检。**不碰任何状态机、不碰台账。**
2. **批次 2**：脑暴对齐 + 北极星回显 —— 复用 `ask_user`；北极星**落点待你拍板**（§3.2）；回显注入 `taskState`。
3. **批次 3（可选）**：严格模式 —— 加 `assistant.strictMode` 开关 + 加强验证门禁的**频率**（不加新工具、不加新实体）。**红队门不做。**

---

## 8. 明确不做 / 待批（本轮）

- 本轮**未写任何实施代码**；唯一产出是这份文档。
- **红队门 / `mark_task` / `commit_star` 等新工具**：**不做**（成本 + 撞硬禁区）。
- **北极星字段（§3.2-C）**：**待你批准**（动结构 = 要迁移）。
- **`graded/docs/THEORY.md`、`preset/docs/paper.md`**：已下载未细读 —— 需要理论细节再补。

---

## 9. 参考项目原文索引（可自己核对）

- 根 `README.md`：三件套入口、v0.3.0 变更（首轮分类 / 引导的 2× 调用修复）。
- `preset/README.md`：三条行为带（实测相变）、按模型选 persona、path commitment、near-field guidance。
- `graded/README.md`：全链 7 步、6 工具、打卡制 + 红队门。
- `graded/docs/ARCHITECTURE.md`：磁盘单轨状态机、三注入通道、门控总则（拒绝不落盘）。
- `graded/docs/STUDY.md`：注意力懈怠实测（无协议 vs 协议链）。
