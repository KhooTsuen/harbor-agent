# 打卡工具 `mark_step_done` —— 设计说明

> **状态**：**已实施**（2026-10-13，HEAD 提交见 `CHANGELOG.md` 的 `[未发布]` 那条「打卡工具」）。
> 落点：`task-plan.cjs`（指纹 + `markStepDone`）· `task-plan-mark.cjs`（打卡逻辑）·
> `tools/mark_step_done.cjs` · `tools/registry.cjs`（注册，**不进 WRITE_TOOLS**）。
> **本文保留设计原样**（实施与验证见 CHANGELOG / 自检组 `145-mark-step-done`）。
> **基线**：`HEAD = bdc06e5`（设计时）。
> **用户症结**：计划卡上的 `[ ]` 由模型维护，而模型只在每轮第 1 个 LLM 轮次输出正文
> （计划块在里面），后续工具轮没有正文 → `[x]` 永远不亮，计划卡看着像「没动」。
> 用户要一个「打卡」工具，让模型**显式声明**某一步做完了。
> **本文只回答**：工具怎么定义、完成状态存哪、怎么和 `strictMode` / `capturePlan` / UI
> 协同；**不动** Runtime / IPC / 防闪烁三件套。
> 证据规矩同其它文档：每条指得住 `文件:行号`。

---

## 0. 一句话结论

**能做，而且最省事、最不易漂的落点是「打卡时由内核把 `plan` 里那条 `[ ]` 改成 `[x]`」**：

- **不新增字段、不改存储格式、零迁移**（老任务原样可读）；
- **strictMode 的「勾了没验证」门禁自动覆盖它**——因为那条门禁数的就是 `plan` 里的 `[x]`
  （`task-strict.cjs:81` 的 `anchorOf` → `progressOf`），打卡一改，门禁就看见；
- **UI 自动亮**——`PlanCard` / `PlanBar` / `TaskRow` 本就在解析 `[x]`，一个渲染改都不用改。

用户提的**方案 A（新增 `completedSteps`）会撞硬禁区 11（加字段）且制造两处真相**；
**方案 B（改对象数组）是破坏性数据结构变更**。两者都不如「复用既有约定」——
详见 §2。

---

## 1. 工具定义与边界

### 1.1 Schema（形状照 `remember.cjs` 那种写法）

```
name: mark_step_done
description: 声明「计划里的第 N 步做完了」。它只更新计划进度，不跑命令、不验证、
             不改用户文件。验证请照常跑命令（strictMode 会检查）。
parameters:
  step_index: integer  (必填)  计划数组下标，0 起；必须落在 [0, plan.length)
  summary:    string   (可选)  一句话说明这一步干了什么
```

### 1.2 边界（用户点名的红线）

- **打卡 ≠ 验证，绝不能代替验证。** 打卡**不跑** `run_shell`、**不读** `run_shell` 的结果、
  **不写** `steps` 里的任何命令记录。
- **打卡不清写欠账。** 严格模式的 `strictBacklog` 只数 `write_file` / `edit_file`
  （`task-strict.cjs:65-72`，`WRITE_TOOLS` 只有这两个）→ 打卡**不可能**把「改了文件没验证」
  的欠账抹掉。
- **打卡反而会触发门禁**（这正是「不许拿打卡骗门禁」的机制保证，不是靠自觉）：
  打卡让 `progressOf(plan).done` +1 → 严格模式两道门禁都会看见「计划勾了、但勾后没跑命令」：
  - **中途门禁**：`task-strict.cjs:135` 判 `anchor.done > st.doneAtRun`；
  - **收尾门禁**：`task-strict.cjs:158` 的 `strictPlanPending`。
  > 即：**只打卡、不跑验证命令 → 会被拦住**。这是设计要保住的原则底线（见 §3.3）。

### 1.3 校验与返回

- `step_index` 必须为**整数**且在 `[0, plan.length)` 内。越界**不抛异常**（抛了会炸循环），
  而是返回错误文本让模型自己纠正 —— 同 registry 里 `validateArgs` 的口径
  （`registry.cjs:121-146`）。
- **幂等**：目标步已 `[x]` → 返回「这一步已经打过卡了」，**不重复写盘**（避免刷盘）。
- `plan` 为空 → 返回「这条任务还没有计划，先用 plan 块给一份」。

---

## 2. 数据结构与落点

### 2.1 现状（先钉事实）

- `task.plan` 是**字符串数组**，完成标记写在字符串里：`[x] 读配置`；
- `progressOf(plan)` 数 `[x]`（`task-plan.cjs:258-262`）；
- UI 用同一口口径解析：`PlanCard.tsx:38-44`（`isDone` / `textOf`）、
  `taskCenterModel.ts:25-34`（`isPlanDone` / `cleanPlanLine`）；
- 落盘走 `task-io.write` → 内部就是 `safe-write.writeAtomic`（`task-io.cjs:58-65`）。
- `task.plan` 与 `task.planVersions[last].plan` 是**两份独立拷贝**
  （`task-plan.cjs:205-207` 各自 `.slice()`）。

### 2.2 方案 A：新增 `completedSteps: number[]`

**优点**：不动字符串格式；老任务读不到当空数组（可照 `star` / `parentTaskId` 那样在
`migrate` 里**内存补、不落盘**，`task-plan.cjs:218-236`）。

**缺点（四条，逐条都要紧）**：

1. **两处真相**：完成态变成「字符串 `[x]` ∪ `index ∈ completedSteps`」→ 违反硬约束 9
   （跨模块约定只有一处真相）。UI 与内核算的口径只要有一点不一致就漂。
2. **撞硬禁区 11**（给某实体加字段 / 加状态）。
3. **`index` 型标识脆弱**：`plan` 一旦重排 / 重发，下标可能指到**别的**步骤。限制
   `step_index` 在合法范围内**只解决越界，不解决「指向对不对」**。
4. **不覆盖门禁就是漏洞**：`anchorOf` 数的是 `plan` 里的 `[x]`。若打卡只写 `completedSteps`、
   不改字符串，则 `progressOf` 看不出变化 → **打卡就能绕过 strictMode 门禁**。要堵住，
   必须改 `task-strict.cjs` 的口径（去读合并结果）—— 那就**动了内核关键文件**（`task.cjs` 系）。

### 2.3 方案 B：`plan` 换成 `{ text, done }[]`

**优点**：结构最清晰，打卡 = 置 `done=true`。

**缺点**：**破坏性数据结构变更**。按字符串解析 `plan` 的地方遍布全项目 ——
`PlanCard.tsx`、`taskCenterModel.ts`、`task-plan.cjs`（`isDone`/`progressOf`/`stripMarks`/
`nextActionOf`）、`task-context.cjs` 注入、`planVersions` 里的**每一版**历史计划、前端类型
`TaskRecord.plan`。改格式 → 撞**硬禁区 3（改数据结构）**且**远超 3 个文件**；老数据
（含历史版本）全要迁移。**收益只是「记录完成态」，而这件事本来就有一个约定**。

### 2.4 ★ 推荐方案 C：打卡 = 内核改写 `plan` 里的 `[x]`（复用既有约定）

**做法**：`mark_step_done(i)` → 内核把 `plan[i]` 从 `[ ]` 改成 `[x]`（原条目没带标记就前置补
`[x] `）→ 落盘。

**为什么它最好**：

1. **单一真相源**：完成状态就在 `plan` 字符串里 —— 与 `PlanCard.tsx` 文件头的原话一致
   （「勾选状态来自计划条目自身的 `[x]` / `[ ]` 标记」）。
2. **零迁移、零新字段** → 不撞硬禁区 11（加字段）与 3（改结构）。
3. **strictMode 自动覆盖**：`progressOf` 读的就是 `plan` → 门禁自然触发（§3.3）。
4. **UI 自动亮**：三个位点本就在读 `[x]`，**渲染逻辑零改动**。
5. **打卡留痕免费**：`tool-runner` 给每次工具调用 `addStep`（`tool-runner.cjs:180`）→
   `steps` 里自动多一条 `tool='mark_step_done'`，审计可查。

**落盘**：走 `task-io.write`（`writeAtomic` + 索引同步）→ 满足「任何落盘必须走
`safe-write.writeAtomic`」。✓

**⚠️ 两个必须处理的坑（都要写进实施）**：

- **`task.plan` 与 `planVersions[last].plan` 要同步**。`PlanCard` 读的是
  `planVersions` 最后一版（`TaskRowDetails.tsx:89`），`PlanBar` / `TaskRow` 读 `task.plan`。
  只改一处 → 另一处不亮。→ 内核提供**一个** `markStepDone(id, index)` 统一改两处。
- **指纹会误报**。`planHash` 由 `fingerprint(plan)` 算（`task-plan.cjs:168-171`），打卡改了
  `plan` 会让注入层的「计划正文与批准时不一致」告警（`task-context.cjs:186-188`）**误触发**。
  处理：让指纹**忽略勾选标记**（改用已存在的 `stripMarks`，`task-plan.cjs:265-269`）——
  勾选变化本就不该算「计划正文变了」。**推荐改指纹口径**（而不是打卡后重算 hash，
  否则注入层仍会在「换版」与「打卡」之间分不清）。

**迁移**：方案 C **不需要迁移**（改的是既有字符串）。老任务原样可读。

---

## 3. 与现有机制协同

### 3.1 与 `capturePlan` 协同（模型重发计划块）

- 现状：`capturePlan` → `setPlan` → `recordVersion` **整体替换** `plan` 并追加一版
  （`task-context.cjs:237-265`、`task-plan.cjs:188-212`）。
- 打卡状态怎么办？两条路：
  - **（推荐，一期）默认重置**：新版是模型给的，模型按现行收尾话术
    （`task-steering.cjs:111` 要求「完成的步骤标 `[x]`」）自己会带标记。简单、不猜。
  - **（可选，二期）按文本继承**：`capturePlan` 时把旧版**已完成**条目的**文本**匹配到新版，
    同文本 → 保持 `[x]`。
    > **澄清**：这**不是** Phase 5 禁的「`plan` 第 N 条 ↔ 哪个工具」映射 —— 那是跨实体猜归属；
    > 这里是 **plan 版本之间的文本对齐**（同一句话在两版里都出现 → 完成态延续），性质不同。
    > 判据要**保守**：只在文本逐字一致时继承，对不上就不继承（宁可丢勾，不猜）。

### 3.2 与 UI 协同

- `PlanCard`：本就在渲染 `[x]`（`PlanCard.tsx:38-44, 121-129`），**无需改渲染逻辑**；
  只要 `planVersions[last].plan` 同步（§2.4 的坑）。
- `PlanBar` / `TaskRow`：读 `task.plan`，同步即可。
- 刷新链：工具跑完 → `streamEvents` 让 `useTaskStore.refresh` → 三个位点重读 → 亮。
  **不需要新 IPC、不需要新事件**。

### 3.3 与 `strictMode` 协同（原则底线）

- **只打卡、不跑验证命令 → 会被拦**：
  - 中途：`strictGate`（`task-strict.cjs:135`）判「计划勾了但勾后没跑命令」；
  - 收尾：`strictPlanPending`（`task-strict.cjs:158`）在 `shouldVerify` 里顶回
    （`task-steering.cjs:152-162`）。
- 打卡**不清**写欠账（`strictBacklog` 只认 `write_file`/`edit_file`）→「改了文件 + 想拿打卡蒙混」
  也拦得住。
- 打卡本身那条 `step`（`tool='mark_step_done'`）**不进** `WRITE_TOOLS`（见 §4），
  故不参与 `strictBacklog`、不制造虚假「验证」。

---

## 4. 实施边界与硬禁区判定

拟改文件（方案 C）：

| 文件 | 改什么 | 硬禁区？ |
|---|---|---|
| `electron/core/tools/mark_step_done.cjs`（**新**） | 工具定义 + 校验 + 调内核 | 新文件，不撞 |
| `electron/core/tools/registry.cjs` | `require` + 加进 `ALL` | 见下（权限归类） |
| `electron/core/task-plan.cjs` | 加 `markStepDone(task,i)`；指纹改用 `stripMarks` | 不在硬禁区列表 |
| （可选）`electron/core/task.cjs` | 加门面 `setStepDone` | ⚠️ **撞硬禁区 8** |

**逐条判定**：

- **硬禁区 8（内核关键文件含 `task.cjs`）**：若在 `task.cjs` 加门面 → **撞**。
  **避免办法**：逻辑放 `task-plan.cjs`（不在列表），工具里用 `task-io.cjs` 读写。
  → **需用户拍板**：是否接受动 `task.cjs`（为风格统一加门面），还是走「不动 task.cjs」的写法。
- **硬禁区 9（新增 / 改 IPC 通道）**：**不碰**。工具不走 IPC；`catalog` 未经 IPC 暴露
  （`EXPECTED_CHANNELS` 无 `tools` 项，`ipc-channels.cjs:20-185`）→ **不用动 `ipc-channels.cjs`**。
- **硬禁区 10（权限 / 安全模型）**：**取决于是否把 `mark_step_done` 放进 `WRITE_TOOLS`**
  （`registry.cjs:71-84`）：
  - 放进 → `readonly` 档直接拦、`ask` 档**每次打卡都弹确认框** → 每步都弹，功能没法用；
  - 不放 → 打卡不弹确认（它不改文件、不联网、不跑命令），但「只分析」轮次里它也会执行
    （`ctx.allowWrite === false` 也拦不住）；
  - **推荐不放**，理由如上。**但这是需要用户拍板的点。**
- **硬禁区 11（加字段 / 加状态）**：方案 C 不加字段 → **不撞**（方案 A 会撞）。
- **硬禁区 3（改数据结构）**：方案 C 不改结构 → **不撞**（方案 B 会撞）。
- **硬禁区 1（动 3+ 文件）**：方案 C 约 **3 个**（新工具 + registry + task-plan），**贴线**；
  若再动 `task.cjs` 就是 **4 个** → 按硬禁区 1 也要**先报告再动**。

**不受影响的守卫**：自检那条「本地工具」断言是 `schema.length >= 5`
（`01-basics.mjs:276-280`）→ **新增工具不会让它变红**，无需同步。

---

## 5. 待用户拍板（实施前定这 4 条）

1. **状态存哪**：推荐 **C（改写 `plan` 的 `[x]`）**；若要 A / B，请说明（代价见 §2.2 / §2.3）。
2. **落点**：内核逻辑放 `task-plan.cjs`（**不撞硬禁区 8**）还是 `task.cjs` 加门面（**撞 #8**）？
   推荐前者。
3. **打卡算不算「写操作」**：推荐**不算**（进 `WRITE_TOOLS` 会让每步弹确认框，功能没法用）。
4. **模型重发计划块时**：一期**默认重置**（推荐）还是**按文本继承**（二期，判据保守）？

---

## 附：证据（`文件:行号`）

- **工具 schema / 执行咽喉**：`tools/registry.cjs:37-55`（`ALL`）、`:71-84`（`WRITE_TOOLS`）、
  `:121-146`（`validateArgs`）；`tools/index.cjs:176-235`（权限三档 + 执行）。
- **计划结构 / 落盘**：`task-plan.cjs:188-236`（`recordVersion`/`migrate`）、`:258-269`
  （`progressOf`/`stripMarks`）；`task-io.cjs:58-65`（`write` → `writeAtomic`）；
  `task.cjs:155-168`（`setPlan`）。
- **strictMode**：`task-strict.cjs:65-72`（`strictBacklog`）、`:112-151`（中途门禁）、
  `:158-164`（`strictPlanPending`）；`task-steering.cjs:59-69`、`:138-204`（收尾门禁）。
- **注入 / 指纹**：`task-context.cjs:166-189`（计划注入 + 指纹校验）、`:237-265`（`capturePlan`）。
- **UI**：`PlanCard.tsx:38-44, 121-129`；`TaskRowDetails.tsx:89`；`PlanBar.tsx:59-71`；
  `taskCenterModel.ts:25-34`。
- **守卫**：`scripts/selftest/groups/01-basics.mjs:274-286`（工具清单 `>= 5`）。
