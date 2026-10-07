# Model Interaction Baseline（模型交互复杂度基线）

> **这份文档是什么**：把任务书里的 **Model Interaction Complexity**（不要再叫主观的
> "Model Cognitive Load"）落成**能测的数字**，并记录**当前基线**。
>
> **两条纪律**：
> 1. **优先复用现有基础设施**，不为指标大改架构（任务书 §六）。
> 2. **会涨的数字不写死**（`AGENT.md` 硬约束 8）—— 工具数、事件 type 数、IPC 通道数
>    只写「怎么取」，不写具体值。
>
> 配套：[`Golden Tasks.md`](Golden%20Tasks.md)（跑什么）、[`Architecture Reality Audit.md`](Architecture%20Reality%20Audit.md)（现状分析）。

---

## 1. 指标集合与「现在能不能拿到」

| 指标 | 定义 | 现有来源 | 现状 |
|---|---|---|---|
| `system_prompt_tokens` | 系统提示 token | `electron/core/context-diag.cjs`（hash + 稳定前缀变化）+ `token-metrics.cjs`（字符/3 估算） | ◐ 有估算，无精确 |
| `tool_schema_tokens` | 工具 schema token | `electron/core/tools/registry.cjs` | ❌ **没有单独统计**（GAP） |
| `context_tokens` | 本轮上下文 token | `context-builder.cjs` 的 `estimates.maxTokens` / `chars` | ✅ 有 |
| `memory_tokens` | 记忆注入 token | `memory.cjs` 的 `buildPromptSection` + memory cap（2457 字符） | ◐ 有字符数 |
| `project_rule_tokens` | 项目规则注入 token | `project.cjs` / `project-rules.cjs` 上限 + `prompt-limits.cjs:PROJECT_FLOOR_CHARS` | ◐ 有上限，无实测 |
| `conversation_tokens` | 对话 token | `context-builder.cjs` 的 `estimates.chars` + `selectedMessages` | ✅ 有 |
| `tool_result_tokens` | 工具结果 token | 工具结果在 `task.steps[]` / 消息里 | ❌ **没有单独统计**（GAP） |
| `tool_count` | 工具总数 | `tools/registry.cjs` | ✅ 看输出（不写死） |
| `tool_call_count` | 工具调用次数 | `task.steps[]` | ✅⚠ 有，但**一次调用两条记录**（`数据模型.md`:73-76），要按 `run-stats.cjs` 的「二选一」口径 |
| `unique_tools_used` | 用过几种工具 | `run-stats.cjs` | ✅ 有 |
| `turn_count` | 调模型次数 | `task.turns`（`task.cjs:71`） | ✅ 有 |
| `retry_count` | 自动重试次数 | `task.retries` | ✅ 有 |
| `failed_tool_calls` | 失败工具数 | `run-stats.cjs` / `audit.cjs` | ✅ 有 |
| `average_context_size` | 平均上下文 | 无历史聚合 | ❌ **GAP**（`metrics.cjs` 只有内存时间线） |
| `maximum_context_size` | 最大上下文 | 无 | ❌ **GAP** |
| `model_output_tokens` | 模型输出 token | `task.tokensOut` | ✅ 有 |
| `task_duration` | 任务耗时 | `task.createdAt` → `task.finishedAt` | ✅ 有 |

**结论**：17 个指标里，**10 个现在就拿得到**，3 个有字符数 / 上限的近似值，
**4 个是缺口**（`tool_schema_tokens` / `tool_result_tokens` / `average_` / `maximum_context_size`）。
缺口**不急着补** —— 先跑 Golden Tasks，看这几个到底影不影响判断。

---

## 2. 基线（A 部分）：静态装配基线 —— **2026-10-08 测得**

这些不依赖真实模型调用，是**读代码 + 一次 `npm test` 就能确认**的。改架构前后可以直接比对。

| 项 | 值 | 来源（可核对） |
|---|---|---|
| 系统提示层数（声明 / 实际进模型） | **17 / 15** | `prompt-stack.cjs:123-158`；`loop-prompt.cjs:239-240`（两层恒空） |
| 恒定注入的 Runtime 内部 ID 个数 | **0** | `Architecture Reality Audit.md` §7.2 |
| 上下文预算基准 | **49152 字符**（= 16384 × 3） | `context-builder.cjs:120,133` |
| 对话层可见上限 | **14745 字符**（≈4.9k token） | `context-builder.cjs:110-112,141` |
| memory 层 cap | **2457 字符** | `context-builder.cjs:136` + `:13-21`（5% × 49152） |
| project 层 cap | `max(7372, PROJECT_FLOOR)` 字符 | `context-builder.cjs:138` |
| ⚠ 声明了但从不使用的预算桶 | `system` / `tools` / `reserve`（**共 40%**） | `context-builder.cjs:13-21` 声明 vs `:134-141` 实际只调 4 档 |
| 图片计入方式 | 每图 **800 字符**（不是 base64 实际长度） | `context-builder.cjs:52` |
| 残片丢弃阈值 | **200 字符** | `context-builder.cjs:65` |
| 首轮同时注入的记忆 | `relevantMemory` 层 + `taskState` 里的 `reflectSection`（**有意重复**） | `task-context.cjs:26-28` |
| 当前仓库是否全绿 | **是**（`npm test` 退出码 0；通过项数见输出末行，不写死） | 2026-10-08 实跑 |
| 工具数 / 事件 type 数 / IPC 通道数 | **看输出**（硬约束 8） | `tools/registry.cjs` · `event-types.cjs` · `ipc-channels.cjs` |

---

## 3. 基线（B 部分）：动态基线 —— **待填（跑完 Golden Tasks 后）**

> 现在**故意留空**。填之前先冻结口径（§1 的指标名与来源文件），否则跑两遍的数字没法比。

**跑的条件**：真实模型（DeepSeek 主力），隔离数据目录（见 `Golden Tasks.md` §3），
每条任务重复 **≥3 次**（单次结果不能当基线）。

| 任务 | 成功率 | 耗时 | 工具调用 | 重试 | 失败数 | 恢复成功 | 上下文大小 | 提示大小 | 记忆注入 | 工具 schema |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 文件理解 | | | | | | n/a | | | | |
| G2 文件修改 | | | | | | n/a | | | | |
| G3 多步骤 | | | | | | n/a | | | | |
| G4 长任务恢复 | | | | | | | | | | |
| G5 错误恢复 | | | | | | | | | | |
| G6 Memory | | | | | n/a | n/a | | | | |
| G7 项目隔离 | | | | | n/a | n/a | | | | |
| G8 非 Coding | | | | | | n/a | | | | |
| G9 长上下文 | | | | | | n/a | | | | |
| G10 Subagent | | | | | n/a | n/a | | | | |

**填表口径**（冻结，别改）：

- **成功率**：3 次里几次满足该任务的**全部判据**（含「不许出现」的反向用例）。
- **耗时**：`task.finishedAt − task.createdAt`。
- **工具调用**：按 `run-stats.cjs` 的「二选一」口径（`数据模型.md`:73-76）。
- **上下文大小 / 提示大小 / 记忆注入**：单位统一**字符**（本项目 `context-builder.cjs` 就是字符制，
  不换算 token —— 换算反而引入第二个口径）。
- **工具 schema**：跑之前先补一个统计（若 §1 的 GAP 证明有必要）。

---

## 4. 怎么取这些数（命令 / 位置）

```text
· 实时统计      →  npm run stats          （口径写在 electron/core/run-stats.cjs 文件头）
· 单任务明细    →  data/tasks/<id>.json   （turns / retries / tokensIn / tokensOut / promptDiag / steps[]）
· 审计流水      →  data/audit/YYYY-MM-DD.jsonl  （每次工具调用一行，含 ok / ms / permission）
· 事件流水      →  data/events/YYYY-MM-DD.jsonl （只落 agent.*，见 Architecture Reality Audit §5.3）
· 性能时间线    →  src/lib/harborStats.ts + core/metrics.cjs（内存里近几次）
· 提示层诊断    →  task.promptDiag（core/context-diag.cjs：hash + 稳定前缀变了没、变在哪层）
· 真机截图/操作 →  npm run shot:electron -- --js="..." --type="..."
```

**注意**：`data/events/*.jsonl` **只有 `agent.*`** —— 想统计「决策卡」相关的就取不到
（`Architecture Reality Audit.md` §5.3 记着这个缺口）。基线阶段**先接受这个限制**，别为此改架构。

---

## 5. 怎么用这份基线（改架构的规矩）

任何架构改动，都按任务书第十一节走：

```text
Observe → Measure → Identify bottleneck → Make smallest change
        → Run Golden Tasks → Compare Baseline → Keep / Revert
```

**判定规则**（先定死，免得事后找理由）：

- 某指标**变好**且**没有别的指标变坏** → `Keep`。
- 某指标变好但**成功率下降** → **Revert**（成功率是一票否决）。
- 指标持平、代码复杂度上升 → **Revert**（任务书 §十三：不要为「优化」而修改合理的架构）。
- 指标持平、代码复杂度下降 → `Keep`（这是唯一「无行为收益」也值得做的情形）。

---

## 6. 这份文档的边界（诚实清单）

- **B 部分（动态基线）是空的** —— 本节所有「静态值」都可用 `文件:行号` 或 `npm test` 复核，
  但**动态数字一条都没有**，因为**还没跑**（跑要真实模型调用 = 花钱，需你点头）。
- **不做 70 条测试矩阵**（任务书 §五）。v1 就 10 条，手工跑，人工判。
- **不引入新依赖**（`AGENT.md` 硬约束 6）。指标优先复用现有 `run-stats.cjs` / `metrics.cjs` / `token-metrics.cjs`。
