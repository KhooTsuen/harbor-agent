# Phase 6 批次 1-2 阶段总结

> 状态：**已实施并提交**（2026-10-13）。本文是**阶段总结**，不是设计稿、也不是现状清单。
> 前置调研见 [`phase6-governance-routing-design.md`](phase6-governance-routing-design.md)（那份保持调研原样）。
> 逐条改动与验证见 `CHANGELOG.md` 的 `[未发布]`。

## 0. 一句话

参考项目 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的三件套里，
**前两件（任务感知 persona 路由、脑暴对齐 + 北极星）已按「加法」落地** ——
只新增分类映射、新增一个台账字段、新增提示层，**没动任何既有状态机 / IPC / 权限模型 / 数据结构形状**；
第三件（打卡制 / 红队门）与 `strictMode` **仍留待批次 3，本阶段未实施**。

| 批次 | 方向 | 提交 | 一句话 |
|---|---|---|---|
| 批次 1 | 任务感知路由与 persona 注入 | `0b63bc6` + 修 `c729cd7` | 首轮分类决定「强档 / 快档」，整场锁定，注入稳定区吃缓存 |
| 批次 2 | 脑暴对齐与北极星锚定 | `d76e543` | 新增 `task.star`，复杂任务先对齐、定一句目的宣言、每轮回显防跑题 |

## 1. 批次 1 —— 任务感知 persona（强档 / 快档）

### 改了什么

| 文件 | 改动 |
|---|---|
| `electron/core/mode-router.cjs` | 新增 `personaFor()`：**纯正则、零 LLM 调用**，复用既有 `resolve()` 的结果做 `mode → persona` 映射（think/research/agent/code → `strong`；creative/chat → `fast`） |
| `electron/core/loop-route.cjs` | 新增 `firstUserText()` / `personaOf()`：persona 由**第一条真实用户消息**决定（跳过 system 与带图数组内容） |
| `electron/core/prompt-stack.cjs` | 新增 `personaGuide` 层（`conversationPolicy` **之后**，稳定区）；`VERSION` `/5 → /6` |
| `electron/core/prompt-rules.cjs` | `workRules()` 新增 `strictMode` 参数（默认关，**刻意不读**）—— 批次 3 预留 |
| `electron/core/loop-prompt.cjs` | 接线 persona 层 |
| `electron/handlers/chat.cjs` | 额外把**完整** payload 当 `fullHistory` 传给循环（只给 persona 用） |
| `electron/core/context-diag.cjs` | `STABLE` 清单同步加 `personaGuide` |
| 自检 | 新增组 `142-persona-routing.mjs`；同步 `06` / `93`（版本断言 `/5 → /6`） |

### 关键设计决策

1. **不新造分类器**：`mode-router` 已有「零 LLM 调用的轻量分类器」（纯正则，5 条规则→6 种 mode）。
   只加一层 `mode → persona` 映射，一份 RULES、一处真相源（另写一套正则迟早漂）。
2. **「首轮锁定」不落盘**：分类是**纯函数**，同一句话永远同一结果 ⇒ 锁定不需要任何状态、
   不写盘、不改任务台账结构。中途想换只能靠 `spawn_subagent` 另起一条会话（项目记忆里定的路子）。
3. **persona 放稳定区**：首轮之后逐轮不变 ⇒ 整段落在前缀缓存里（参考项目踩过的坑正是
   「中途换 persona = 缓存全废、费用翻倍」）。
4. **两级而非三带**：先做「强档 / 快档」，不照搬参考项目的 spec/react/weak 三带相变（要更多实测才敢上）。

### ★ 实施中发现并修掉的一个真 bug（`c729cd7`）

`chat.cjs` 传给循环的 `history` 是 `rawHistory.slice(-historyLimit)`（默认只留最近 20 条）。
**长会话里第一条用户消息会被滑走** → `firstUserText(窗口)` 每轮都在变 → persona **中途翻档**：
既违背「首轮锁定」，又把稳定前缀缓存打掉（正好废掉这一层放稳定区的全部意义）。

- **修法**：`chat.cjs` 另外把**完整** payload 当 `fullHistory` 传给循环，**只给 persona 用**
  （模型上下文仍只用窗口 `history`）；`loop-prompt` 优先取 `fullHistory`、没有才退回窗口。
  子代理只传自己那一条 history、不带 `fullHistory` ⇒ persona **天然隔离、不继承父会话**。
- **回归测试**：造一条 25 条的会话（第一条强档信号 + 末尾问候），断言「带完整 payload → 强档」
  「只给窗口 → 不是强档」；两条负向实验分别令 1 条 / 2 条断言变红并字节还原。

## 2. 批次 2 —— 脑暴对齐与北极星锚定

### 改了什么

| 文件 | 改动 |
|---|---|
| `electron/core/task-create.cjs` | 初始对象新增 `star: ''`（**唯一数据结构变更**，带注释说明与 `goal` 分开的理由） |
| `electron/core/task-plan.cjs` | 新增 `STAR_LINE` 正则 + `normalizeStar()`；`parsePlanBlock` 抠出 `star`；`recordVersion` 首次定格 + 返回 `star/starChanged`；`migrate` 内存补 `star: ''` |
| `electron/core/task.cjs` | `update()` 白名单加 `'star'`；`setPlan` 在 `starChanged` 时也写盘 |
| `electron/core/task-context.cjs` | `capturePlan` 把 `block.star` 交给 `setPlan`、把 `star` 带回来；`buildTaskState` 每轮注入 `北极星：…` |
| `electron/core/prompt-rules.cjs` | `PLAN_RULE` 加一行可选的 `北极星：…`；`CLARIFY_RULE` 补「多步的大活 → 先对齐」触发条件 |
| `electron/core/task-hint.cjs` | `PLAN_FORMAT` 加北极星那一行（台账与首轮共用同一份措辞） |
| `electron/core/prompt-stack.cjs` | `VERSION` `/6 → /7` + 变动史 |
| 自检 | 新增组 `143-north-star.mjs`；同步 `93` / `142`（版本断言 `/6 → /7`） |

### 关键设计决策

1. **只认显式写的那一行**：`北极星：…` / `star: …`。**不去正则解析模型自然语言**
   （那正是本项目反复警惕的「用正则猜模型意图」）。模型主动声明，内核只搬运。
2. **首次定格**：`(!task.star && star)` 才写入 —— 模型每轮重发计划块、措辞会飘，
   漂了就失去锚点意义（与任务名「只采纳一次」同一个道理）。
3. **`star` 与 `goal` 分开存**：保护「用户原话」的纯净语义（不复用 `goal`）。
4. **落定走既有链路，零新工具**：`ask_user` 负责对齐（不新增工具），
   计划块解析 → `setPlan` → `task-io.write`（`safe-write.writeAtomic`）负责落盘。
5. **回显在易变区**：`star` 只进 `taskState` 层（`context-diag` 归为 low tier），
   **不动稳定区**、**不动批次 1 的 persona 逻辑**。

### ★ 老数据迁移安全（本批次重中之重）

`task-plan.migrate` 在**内存里**把老任务缺的 `star` 补成 `''`（沿用既有 `parentTaskId` 的迁就规矩，
**不落盘、不改老文件**）。实测：升级前建的台账（无 `star`、无 `planVersions`）——

```
✅ 读得出来、不报错
✅ star === ''（不是 undefined）
✅ goal 原样保留（没被拿去当 star）
✅ 迁移只在内存补；磁盘文件一个字节没动
```

## 3. 验证证据（数字）

| 命令 | 批次 1 后 | 批次 2 后 |
|---|---|---|
| `npm run verify` | 退出码 0 | 退出码 0 |
| 内核自检 | 4127 → 4162（+35） | 4162 → **4200**（+38，新组 143） |
| 单测（vitest） | 185 文件 / 1649 用例 | 185 文件 / 1649 用例 |
| 安全套件 | 83 PASS / 0 FAIL | 83 PASS / 0 FAIL |
| 行数红线 | 1127 文件全 ≤300 | 1128 文件全 ≤300 |
| `typecheck:kernel` | 基线 187 条无新增 | 基线 187 条无新增（JSDoc 同步修过） |

**负向实验**（真做，不是声称；每条都精确打中对应断言且不多不少，文件均字节还原）：

| 实验 | 结果 |
|---|---|
| 批次 1：接线退回 bug 版（传决策对象而非 `.persona`） | 3 条端到端断言当场变红 |
| 批次 1：拆掉 `chat.cjs` 的 `fullHistory` / 拆掉 `loop-prompt` 的优先取用 | 1 条 / 2 条变红 |
| 批次 2：`migrate` 不补 `star` | 「老任务读出 star=空串」等 2 条变红 |
| 批次 2：`update` 白名单去掉 `star` | 「白名单放行 star」等 2 条变红 |
| 批次 2：去掉 `taskState` 回显 | 「`taskState` 里出现北极星」等 2 条变红 |

**测试怎么钉的**（不是「各自能跑」）：端到端真调 `buildPromptContext` / `parsePlanBlock` / `setPlan` /
`buildTaskState`，从**最终产物**里找文案 —— 吸取 CE-001「每块单独测都绿、就是没人传下去」的教训。

## 4. 成本（i5-6400 / 16GB / HDD，实测非估）

| 项 | 数字 |
|---|---|
| persona 文案 | `strong` 122 字 / `fast` 110 字（整层含标题 133 字） |
| 静态提示合计 | 4240 → **4362 字**（批次 1 +122 字，+2.9%） |
| persona 层位置 | `ORDER[4]`，**稳定区**（易变区从 `relevantMemory` 起） |
| 北极星回显 | 每轮约 50 token，在 **`taskState`（易变区）**，不动稳定前缀 |
| 新增依赖 / LLM 调用 / 新写盘路径 | **0 / 0 / 0** |
| 首 Token 时间影响 | ≈ 0（不增调用次数；persona 第 2 轮起随稳定前缀缓存命中） |
| HDD | 瓶颈只在落盘；星标回显**只读**已落盘的 `task`，无新增 I/O |

## 5. 边界核对（AGENT.md 第 2 节）

| # | 约束 | 结论 |
|---|---|---|
| 1 | 类型零容忍 | ✓ typecheck / lint / lint:kernel / **typecheck:kernel 基线无新增** |
| 2 | 单文件 ≤300 行 | ✓ 1128 文件全 ≤300（`chat.cjs` / `selftest.mjs` 贴线，已压注释留余量） |
| 3 | 数据只落 `data/` | ✓ `star` 随台账落 `data/tasks/`，无新路径 |
| 4 | 密钥不写 config / 外发过 redact | ✓ 未涉及凭证与外发 |
| 5 | 改数据结构必须写迁移 + 保旧数据 | ✓ `migrate` 内存补 `star`，**不落盘、不改老文件** |
| 6 | 不引入新原生依赖 | ✓ package.json / lock 未动 |
| 7 | 不输出未验证的「已完成」 | ✓ 每条给命令 / 数字 |
| 8 | 会涨的数字不写死 | ✓ 文档未写死计数 |
| 9 | 跨模块单一真相源 | ✓ mode→persona 映射一处；北极星解析一处（`STAR_LINE`）；格式说明一处（`PLAN_FORMAT` ↔ `PLAN_RULE`） |
| 10 | 改了代码必须写 CHANGELOG | ✓ `[未发布]` 已记 |

**未碰**：Runtime / IPC 通道 / 权限模型 / 防闪烁三件套（`useSmoothText` / `useAutoScroll` / `scrollGuard`）。

## 6. 已知遗留（诚实写）

1. **未做真机验证（两批次均是）**：验证靠内核自检 + 端到端断言 + 写盘往返，**没在打包版真机跑过**。
   要真机看，需 `npm run package` + 更新三处副本（打包第 0 步会 `taskkill` 掉当前窗口）。
2. **两批次都只做「Prompt 软约束 + 数据层」**：是否先 `ask_user`、是否写北极星、是否守计划，
   **取决于模型遵守规则**，**没有内核硬门禁** —— 那是批次 3（打卡制 / 红队门）的事。
3. **两级边界是启发式、无真机标定**：如「帮我优化一下启动速度」判**快档**。分类错不造成损坏
   （只是一段提示的措辞），但强档任务被判快档会少一句「先规划」的提醒。
4. **模型行为层面的效果未验证**：只验证了「注入的 persona / 北极星正确」，没验证
   「模型因此变得更守规划 / 更少跑题」（那要真模型 + 多轮对照）。
5. **北极星只在内核层**：台账 + 提示 + `plan` 事件里带上 `star`，**界面上暂时看不到**（未要求，且碰 UI 会牵动防闪烁边界）。
6. **`strictMode` 是纯预留**：开关在、默认关、**不读它**；批次 3 才接内核门禁。
7. **模型自动切换（flash vs pro）未做**：本阶段只做 persona 注入，沿用既有 `router.cjs`（默认关）。

## 7. 下一步（批次 3，待确认）

**打卡制 + 红队门 + `strictMode`**。调研（方向 ③）已指出：Harbor 的验证门禁**已经从内核结构化事实
（`task.steps`）判断**，不需要新造解析器；严格模式 = 复用该判据、把验证从「收尾一次」加强为
「每勾一条计划 / 每 N 次写」。**红队门建议后置或不做**（要新增工具 → 撞工具注册表与风险分类）。
