# Memory 设计（目标态）

> **定位：设计稿 · 目标态，不是现状。**
> 想知道记忆**现在**怎么跑 → 看 `electron/core/memory-*.cjs` 和 [`数据模型.md`](数据模型.md)。
> 想知道记忆**要收敛成什么样** → 看本文。
>
> 本文是外部设计稿《Harbor Agent Memory 记忆功能设计与未来规划 V1.1》的**取舍版**：
> 只保留与本项目现状对得上、能直接指导改动的部分；去掉实现细节、未来路线，以及
> **所有具体数值**（权重 / 阈值 / half-life 等只在代码一处定义 —— 见 [`../AGENT.md`](../AGENT.md) 硬约束 8）。

## 1. 什么是 Memory

> **经过判断、被认为对未来任务有持续价值、并且未来能被重新使用的长期状态信息。**

它不是这些东西（别因为「都属于长期信息」就合并数据模型）：

```text
Conversation ≠ Memory      History       ≠ Memory
Context      ≠ Memory      Knowledge     ≠ Memory
Project Rules≠ Memory      Artifact      ≠ Memory
```

### 与相邻系统的边界

| 系统 | 回答的问题 | 例子 |
|---|---|---|
| History | 发生过什么？ | 「昨天改过 README」「某任务昨天失败」 |
| Memory | 未来应该记住什么？ | 「用户偏好中文」「某项目长期用某方案」 |
| Knowledge | 我们知道什么？（不一定关于用户） | PDF / API 文档 / 资料 |
| Project Rules | 这个项目必须遵守什么？ | 「禁止改 migrations」 |
| Context | 当前任务需要知道什么？（动态组合） | 上面几样 + 会话 + 文件 + 任务状态 |

**Project Rule 是约束，不是 Preference**；Context 是**组合结果**，不该成为新的永久事实源。

## 2. 五条最高原则

1. **Correctness > Quantity**：宁可少记，不要错误地长期记住。
2. **来源可信阶梯**：`Explicit > Confirmed > Observed > Inferred > Single`（越靠下越不该直接变 Active）。
3. **必须能解释**：重要记忆要能回答「为什么 Harbor 认为这是真的」—— 至少带 Source / Evidence / Confidence / Scope / Lifecycle。
4. **必须能推翻**：没有永久真理，要支持 `Updated / Superseded / Expired`。
5. **Store ≠ Model Context**：`保存过 ≠ 现在应该告诉模型`。存 → 召回 → 排序 → 策略 → 才进上下文。

## 3. Scope：有效性语境，不是排序加分

- Scope **不代表「越具体越重要」**，它表示**这条记忆在什么上下文中有效**。
- 默认解析优先级：`Task > Session > Resource > Project > User > Global`。
  这是 **Context Resolution Priority**，不是「真理优先级」—— 必须先判断它**是否适用**，再谈覆盖。
- **Override ≠ Conflict**：
  - Override = 不同 Scope 的**合法差异**（User 用 pnpm、Project A 用 npm）—— **不是冲突**。
  - Conflict = **同一语义上下文**下无法同时成立（同一个 Project A 既说 npm 又说 pnpm）。

> ⚠️ **现状与本节相反**：代码把 scope 当**排序权重**，而且方向倒过来（`session` 分高于 `task`）。
> 见 §6 第 1、2 行。改 Recall 前必须先在这节拍板：Scope 是「有效性」还是「加分」。

## 4. 生命周期（目标态）

```text
Observation → Candidate → Active → Updated / Superseded / Expired → Archived
```

- **Candidate**：模型认为可能值得长期记住、但证据不足。**不进上下文、不自动晋升**。
- **Forget ≠ Delete** —— 五个动作分开：
  - `Delete` 物理删除（几乎不用）
  - `Forget` 停止主动使用
  - `Supersede` 被新记忆替代（**旧的不是删，是标 superseded**）
  - `Expire` 自然失效
  - `Archive` 留历史、不参与正常 Recall

## 5. 治理：改记忆相关代码前先过一遍

### 5.1 架构十二问（答不上来就别加）

是不是 Memory？不属于则属什么 Domain？Source of Truth？为什么值得长期保存？Evidence？Scope？Lifecycle？如何 Correction？如何 Supersede？如何 Expire？如何防止错误 Injection？如何测试？

### 5.2 新增字段的四条件（全满足才加）

`现有字段无法表达` + `存在独立生命周期` + `存在真实消费者` + `能通过测试验证`。
否则优先用 **Evidence / Metadata / Derived State**，别「一个需求加一个字段」。

### 5.3 禁止事项（原 20 条，压缩成组）

- **别什么都存**：不自动存全部聊天 / 全部 Tool Result；History、Knowledge 不当 Memory。
- **别过度推断**：一次行为 ≠ 长期 Preference；用户没纠正 ≠ Confirmed；低可信 Inference 不许直接触发高风险行为。
- **别偷懒判定**：不用简单字符串匹配解决**所有** Conflict（相似 ≠ 冲突）；不同 Scope 不靠优先级直接判 Truth。
- **别自欺**：Utility 不能当删除的唯一依据；使用次数不能直接刷新 Freshness；Evidence Count 不重复计同一来源。
- **别失控增长**：不因为「越多越智能」无限长；Candidate 未经验证不许晋升；Constraint 不无条件当永久；Phase 没到退出条件不进下一阶段。
- **别泄露**：Evidence 不保存完整 Conversation。

### 5.4 当前阶段明确不做

`Vector Database` / `Memory Graph` / `Knowledge Graph` / `Automatic Dreaming` / 复杂 Ontology / 大规模 Rewrite / 自动重建全部历史。
要做得先有 `真实问题 + Benchmark + 明确收益`。（与 [`../AGENT.md`](../AGENT.md) 硬禁区 2「不引新原生依赖」一致。）

## 6. 与现状的差距（以代码为准，不凭推测）

| # | 目标口径 | 代码现状 | 证据 | 性质 |
|---|---|---|---|---|
| 1 | Scope = 有效性，不排序 | 当排序权重，且 `session` > `task`（与 §3 反向） | `memory-explain.cjs:23-24,67` | **语义相反** |
| 2 | Scope 6 种，含 User/Resource | 5 种：global/project/**workspace**/task/session | `memory-schema.cjs:36` | 集合不一致 |
| 3 | 类型 8 种 | 9 种：多 project_rule/habit/instruction，无 Relationship/Project State | `memory-schema.cjs:24-34` | 需映射迁移 |
| 4 | 生命周期 6 态 | 4 态：active/superseded/disabled/**expired**（P0-3 已加） | `memory-schema.cjs` STATUSES | 仍缺 Candidate/Archived |
| 5 | Expire 是一条链 | 过期现在**标记不删**（P0-3 已修）；但 `expiresAt` 仍**没有生产方** | `memory-store.cjs` pruneExpired | 半悬空 |
| 6 | 按类型/来源分开记 | `remember` 能带类型了（P0-2 已修）；**scope 仍写死 global** | `memory.cjs` append · `tools/remember.cjs` | 部分修复 |
| 7 | 按 source 档位给基础可信度 | 打分只读 `confidence`，**不读 source** | `memory-explain.cjs` signals | 阶梯未落地 |
| 8 | 冲突 = 语义互斥 | 2-gram 相似/包含；**只对 5 类生效**；`fact` 不进是**刻意的**（2-gram 分不清「第 0 条 / 第 1 条」，放进去会让一批独立事实互取代） | `memory-similarity.cjs` CONFLICT_TYPES | 有意取舍 |
| 9 | 每条带 Evidence | 无此字段 | `memory-store.cjs:97-114` | 无承载体 |
| 10 | Utility 四层 + 滑动窗口 | 无；`lastUsedAt` 记了但**不参与打分** | `memory-recall.cjs:144`；`memory-explain.cjs` signals | 记而不消费 |
| 11 | 不存凭据（§5.3） | **已实现**：统一走 `redact.looksSecret()` | `memory-schema.cjs:64` | ✅ 对齐 |
| 12 | 跨项目不泄漏（必须为 0） | projectId 过滤有；但「还有 N 条没进来」用的是**全局** active 计数 | `memory-recall.cjs:108,149-152` | 计数口径偏大 |
| 13 | Forget ≠ Delete | 冲突标 `superseded`、过期标 `expired`，都不删（P0-3 已修） | `memory-store.cjs` | ✅ 对齐 |
| 14 | 可解释：解释分 = 排序分 | **已实现**：权重表只有一份 | `memory-explain.cjs:15,22` | ✅ 对齐 |

### 另有一条本次新发现（**2026-10-08 已修**）

`memory-similarity.cjs` 的 `findConflicts`：
`(A && B && C && D) || containment >= 0.85` —— **`||` 后半段逃出了「同类型 + 同 scope + active」的约束**（JS 优先级），与文件头「只在同一类型 + 同一 scope + 高度相似时才算冲突」的注释不符，会把不同类 / 不同 scope 的条目误判成冲突并 `supersede`。
**已修**（把 containment 收回括号内），并由自检 `133-memory-conflict-expire` 钉住「跨类型 / 跨范围 / 已退场不许互相取代」。

## 7. 落地顺序建议

**Phase 0（前提 —— 原文档没写、但代码卡着全局）**：先打通**写入路径**。
2026-10-08 起 `remember` 能带 `type` 了（P0-2），所以「类型阈值」有了输入；但 **Scope 仍写死 `global`**，
于是 §3 的 Scope、§6 的 Evidence/Utility **依旧没有输入** —— 先做它们等于在「一个全是 global 的库」上盖楼。

之后按原文档顺序：稳定 → Evidence → Candidate → Recall → Utility。
其中 Recall 前必须先拍两个**设计分叉**（便宜，但不先定就白干）：

1. Scope 是「有效性」还是「排序加分」（决定 `WEIGHTS.scope` 是留还是重做）；
2. 类型 / Scope 表是**原地改名**还是**加映射迁移**（3 类 + 1 Scope 要消失，且库里已有真实数据）。

## 8. 来源

外部文档《Harbor Agent Memory 记忆功能设计与未来规划 V1.1》（2026-10，共 2820 行）。
本文只取其「概念边界 / Scope 语义 / 治理 / 与现状的差距」；**未采纳**其具体阈值数字
与 Vector/Graph 等未来项（原因见 §5.4 与 [`../AGENT.md`](../AGENT.md) 硬约束 8）。
