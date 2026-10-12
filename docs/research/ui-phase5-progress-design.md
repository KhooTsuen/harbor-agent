# UI Phase 5 · 任务动态进度追踪 —— 只读调研与方案

> **状态**：**方案已拍板并在第一批实施**（2026-10-13，提交见 `CHANGELOG.md` 的 `[未发布]`）：
> 动态进度按 **A+B** 做（并列显示真实执行进展 + 口径说明）；备份扩容**只加 `tasks` +
> `changesets`**，**不带 credentials**（理由见 §5）。方案 C（plan↔step 映射）**不做**。
> **基线**：调研基线 `HEAD = a8510d0`（E2 四项已收口）。
> **日期**：2026-10-13。证据规矩同其它文档：每条指得住 `文件:行号`。
> **用户 symptom**：「实际工作已全部完成，UI 进度却卡死在 0/5」。

---

## 0. 一句话结论

**不是「计划块只绑定了首次发布」那么简单** —— 实际是**三段脱节**：

1. **数据面**：计划条目的勾选 `[x]` **只能由模型重发计划块产生**，而模型（按本项目自己的规矩）
   只在**每次用户发送的第 1 个 LLM 轮次**输出正文（含计划块），后续工具轮**没有正文** →
   勾选永远停在 0。
2. **展示面**：UI 上**唯一**带「N/M」形状的进度就是 `计划 N/M 步`，它**只读 `task.plan`**；
   真实执行事实（`task.steps`）在任务行上**一个字都不显示**。
3. **映射面**：内核**没有**「第 N 条计划 ↔ 哪些 step」的归属事实，而项目自己已定过
   **「不猜哪个工具对应哪条计划」**（`ProgressTimeline.tsx:27-28`）——
   所以「计划自动打勾」这条路**结构性走不通**，本阶段也不该走。

**结论**：能修，但修法不是「让计划自动打勾」（底层不足 + 撞边界），
而是**让 UI 进度吸收真实执行事实**（数据早就在台账里，且前端已经在刷新）。

---

## 1. 现状：三条数据链

| 链 | 数据 | 从哪来 | 谁在写 | UI 载体 |
|---|---|---|---|---|
| **计划** | `task.plan[]` / `task.planVersions[]` | 模型输出的 ` ```plan ` 块 | `loop.cjs:206-212` → `capturePlan` → `setPlan` | `PlanCard`、`TaskRow` 的 `计划 N/M 步` |
| **执行** | `task.steps[]`（工具调用）| 内核真实执行 | `task-notes.cjs:65 addStep`（每次工具一次）| `ProgressTimeline`（**详情折叠区内**）|
| **相位** | `AgentPhase` | 主进程状态机 | `phase` 事件 | `ProgressTimeline` 阶段行；`useAgentActive` |

**三条都是「结构化事实」**，没有任何一条来自自然语言解析 —— 这是本项目的好底子。

---

## 2. 精确断点（带证据）

### 断点 ①（主因·数据面）：勾选依赖「模型重发」，而模型不会重发

```
loop.cjs:205-212   每轮都给 capturePlan 看，变了才发事件
task-context.cjs:233  capturePlan → parsePlanBlock(content) → setPlan
task-plan.cjs:156     recordVersion：与上一版比，变了才写
```

- `capturePlan` **每轮都会跑**（`loop.cjs:206`），但输入是**那一轮的正文**。
- 一次用户发送在内核是**多个 LLM 轮次**；模型只在**第 1 轮**输出正文（计划块），
  之后是工具轮（无正文）→ 内核**再没看到过新的计划块** → `task.plan` 的 `[x]` 永不变。
- 实测：本会话连续三轮任务，`TaskRow` 都显示 `计划 0/5 步`（第 4、5 轮的任务）。
- 另有一个**干扰项**：模型每次重发计划块时**任务名/步骤文字都不同** → 会被当成
  **新的一版计划**（`planVersions` 增长），而新版的勾仍是 0 —— 所以看起来像
  「卡死」，其实是「每版都是 0」。

> ⚠️ 这条**不是模型不听话**：要求「每完成一步就重发完整计划块」在架构上就是
> **每一次工具调用后都要重发一遍**（内核每轮都看），代价极大且不可靠。
> **不该把进度可靠性押在模型的输出习惯上。**

### 断点 ②（展示面）：任务行只显示「计划的勾」，不显示「真做了什么」

- `taskCenterModel.ts:52` `planProgressLabel(done,total)` → `计划 N/M 步`
- 用在 `TaskRow.tsx:130`（任务行状态区）与 `PlanCard.tsx:120`（计划卡标题）
- `taskProgress(task)`（`taskCenterModel.ts:36-39`）**只读 `task.plan`**
- 任务行上**真实执行**没有任何展示：`TaskRow.tsx:143-159` 只显示「改了 N 个文件 / N 次失败 / 预算 / 循环」，
  **没有**「已执行 N 步」。

### 断点 ③（映射面）：「计划 ↔ step」的归属事实**不存在**，且不该猜

- 内核 `task.steps` 记的是工具调用（tool / ok / summary / ms），**不带计划步骤号**。
- 项目已定原则（`ProgressTimeline.tsx:23-31`）：
  > 「**不猜「哪个工具对应哪条计划」**。内核里没有这个映射，按顺序硬配就是编。」

### 已有的部分（别重复造）

`ProgressTimeline`（任务详情折叠区内）**已经**把两类事实分开展示：
- 阶段行 + 动作行 = **真实执行**（`ProgressTimeline.tsx:104`「执行进度」）
- 待办行 = **计划**，标题明写「计划（模型给的 · 未执行）」（`ProgressTimeline.tsx:176-177`）

**缺的只是**：它藏在「详情」里、默认只显示最近 5 步（`VISIBLE_STEPS = 5`），
而任务行/计划卡**只有**那个卡死的 `0/5`。

---

## 3. 底层够不够直接改造？—— **部分不足，但目标可达**

| 想做的 | 底层够吗 | 说明 |
|---|---|---|
| 让进度**不再卡死**在静态计划上 | ✅ **够** | `task.steps` / `checkpoints` / `changedFiles` 全在台账里，且前端已在刷新 |
| 让「计划第 N 步」**自动打勾** | ❌ **不够** | 缺 plan↔step 归属；只能靠猜（正则/序号）→ **违反本阶段边界** |

**不新增任何持久化字段**即可实现前者。

**刷新时机已覆盖**（无需新增机制）：
- 工具跑完 → `streamEvents.ts:170` `useTaskStore.refresh()`（AG-005 已做）
- 计划变更 → `streamEvents.ts:291` refresh
- 窗口可见 → `useBackendSubscriptions.ts:59-63`
- 一轮开始后补一发 → `useBackendSubscriptions.ts:64-79`

---

## 4. 候选方案（**待你拍板**）

### 方案 A（推荐 · 本阶段做）：把「执行进展」并列显示，数据全取自已有字段

- 新增**纯函数** `execSummary(task)`（`taskCenterModel.ts`）：
  `{ steps: task.steps.length, ok: 成功数, checkpoints: task.checkpoints.length, files: task.changedFiles.length, commands: task.commands.length }`
  —— **零新字段**，只读已有台账。
- `TaskRow` 状态区：`计划 1/5 步` → `计划 1/5 步 · 已执行 12 步`
- `PlanCard` 标题行同口径补一句
- **不做**任何 plan↔step 映射；不解析任何自然语言；不动事件契约、不动 IPC、不动数据结构。

**代价**：改 2–3 个 `src/**` 文件 + 1–2 个测试。可单独提交、可单独回滚。

### 方案 B（措辞对齐 · 可并入 A）

把 `计划 N/M 步` 明确标成「计划（勾选由模型维护）」，免得被读成执行进度。
（Phase 1 · B1 已做过一轮措辞统一，这里只是把它做得更显眼。）

### 方案 C（**不做** · 需另立项）：真正的 plan↔step 映射

让计划步骤随执行自动打勾 → 需要**模型显式声明步骤归属**（改提示词 + 事件契约），
撞硬禁区 11/12。**本阶段不做，仅登记。**

---

## 5. 前置遗留项：备份范围扩容（顺路做）

**改点**：`backup-scan.cjs:20-27` 的 `ITEMS` 加 3 项 —— `tasks`（目录）、`changesets`（目录）、
`credentials.json`（文件）。`backup.cjs` 的 `create` / `restore` 都遍历 `ITEMS`，**自动跟随**。

**但发现一处需求冲突（必须先定）**：

- `privacy.mjs:113`：`sec('SEC-070', !items.some((n) => /credential/i.test(n)), '备份项里不含凭证库')`
  → **语义与「把 credentials 纳入备份」直接冲突**。
- ⚠️ **附带发现（既有测试缺陷）**：`(backup.ITEMS ?? []).map(String)` 对对象数组得到
  `['[object Object]', …]`，所以这条断言**恒真（空跑）** —— 就算把凭证加进去也不会红。
  但它表达的设计意图是真的。
- ⚠️ **另一条会真红**：`privacy.mjs:115`「备份产物里没有密钥」是**真扫描**。
  security 套件跑在**纯 Node**（无 Electron `safeStorage`）→ `credentials` 退化为 **`plain` 明文** →
  备份会把**明文哨兵**复制进 `backups/` → **这条会变红**。

**含义**：生产环境（Electron，DPAPI 密文）备份凭证是安全的；但**明文降级场景**下
备份 = 多一份明文密钥副本。所以「credentials 是否纳入备份」需要你定口径。

---

## 6. 边界核对（逐条对照你的约束）

| 约束 | 本方案 |
|---|---|
| 不改任务台账持久化结构 | ✅ 零字段变更（只读已有字段）|
| 不用正则解析自然语言推断进度 | ✅ 只读结构化字段（`steps` / `checkpoints` / `changedFiles`）|
| 只用已有结构化事件（toolRun / phaseChange 等）| ✅ 复用现有 refresh 时机，不新增事件 |
| 不动 IPC | ✅（若后续要做 UI 恢复入口才涉及，本阶段不做）|

---

## 7. 拍板结果（2026-10-13）

1. **动态进度** → **A+B 一起做**：`taskCenterModel` 新增 `execSummary` / `execProgressLabel`
   （纯函数，只读已有字段）；`TaskRow` 并列显示 `计划 N/M 步 · 已执行 K 步`，两段各带
   `title` 口径说明；`PlanCard` 标题行挂同一份说明。**`ResumeCard` 未动**（不在本轮诉求内）。
2. **备份扩容** → **只加 `tasks` + `changesets`**，**不带 credentials**。理由（用户定的三条）：
   ① `privacy.mjs` 的「备份产物里没有密钥」是**真扫描**，纯 Node 无 `safeStorage` 时凭证是
   **明文**，备份它测试必红 —— 这其实是在保护用户；② SEC-070 明确表达了「备份项里不含
   凭证库」的设计意图，不该轻易破坏；③ E2 已用 `writeAtomic` + `keepCorruptCopy` 给凭证
   建了强兜底，备份的风险大于收益。

**方案 C（plan↔step 映射）不做** —— 缺归属事实，只能靠猜，撞本阶段边界。

### 实施落点（已做）

| 文件 | 改了什么 |
|---|---|
| `src/components/chat/taskCenterModel.ts` | +`ExecSummary` / `execSummary()` / `execProgressLabel()` / `PROGRESS_TITLE` |
| `src/components/chat/TaskRow.tsx` | 状态区并列显示执行进展 + 口径 title |
| `src/components/chat/PlanCard.tsx` | 标题行挂口径 title |
| `electron/core/backup-scan.cjs` | `ITEMS` +`tasks` +`changesets`（凭证有意不备，注释写明理由） |
| `scripts/selftest/groups/04-reliability.mjs` | ITEMS 白名单断言同步扩容 |
| 测试 | `taskCenter.test.ts` +6、`taskRow.test.tsx` +4（含真渲染 + 接线守卫） |

### 验证

- 单测 185 文件 / **1648 用例**（1638 → +10）；内核自检 **4127/0**；安全 83 PASS / 漏洞 0；
  `npm run verify` 退出码 0；行数全 ≤ 300。
- **负向实验**：摘掉 `TaskRow` 里那段执行进度后，核心断言「计划一条没勾时，任务行仍显示
  真实执行步数」**当场变红**（脚本自动还原并校验字节一致）。
- **未做真机截图**：`tools/shot-electron.mjs` 的前置是「先 `npm run package`」，而打包输出
  正是 `dist-portable/Harbor` —— 它同时是**当前正在运行**的那个 exe（本会话就跑在里面）。
  在 Windows 上替换正在运行的 exe 有留下半损坏应用的风险，**没做**。替代证据是 jsdom
  **真挂载** `TaskRow` 并读回 DOM 文本（渲染结果，不是源码守卫）。

