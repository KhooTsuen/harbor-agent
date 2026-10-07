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

## 3. 基线（B 部分）：动态基线 —— **2026-10-08 测得（v1）**

> **怎么测的**：复制一份便携版到 `E:\harbor-golden\Harbor`（**完全独立**，不指向
> `E:\CodexWorkbench` 或 `E:\Harbor-Dev`），工作目录 `E:\harbor-golden\workspaces`，
> 真实模型 `deepseek-flash`，权限档 **标准（ask）**。每条任务开新会话跑，
> 驱动脚本 `tmp/golden-driver.mjs`（CDP 连接走 `tools/shot/cdp.mjs` 那套唯一实现）。
>
> **规模**：10 条任务共 **27 次运行**（G1–G3 / G5–G6 / G8–G10 各 3 次 = 24；G4 1 次；G7 两个项目各 1 次 = 2）。
> G6 每次运行含「记住 + 新会话召回」两条记录，所以 `tmp/golden-runs/` 里是 **29 份记录文件**（不是 29 次运行）；
> G4 的跨进程恢复没有独立记录文件，证据落在实例的 `data/tasks/*.json`（`resumeCount=1`）。

| 任务 | 成功率 | 耗时(秒·中位) | 工具调用(中位) | 重试 | 失败步数 | 恢复 | 输入 token(中位) | 输出 token(中位) | 确认卡 |
|---|---|---|---|---|---|---|---|---|---|
| G1 文件理解 | **3/3** | 6 | 8 | 0 | 0 | n/a | 20,880 | 1,224 | 0 |
| G2 文件修改 | **3/3** | 13 | 9 | 0 | 0 | n/a | 44,368 | 1,852 | 1 |
| G3 多步骤 | **3/3** | 57 | 18 | 0 | 0 | n/a | 118,787 | 12,021 | 1 |
| G4 长任务恢复 | **1/1** | 跨两次进程 | 24 | 0 | 0 | ✅ `resumeCount=1` | — | — | 1 |
| G5 错误恢复 | **3/3** | 16 | 10 | 0 | 0–1 | n/a | 36,201 | 2,520 | 1 |
| G6 Memory | **3/3** | 1 | 0 | 0 | 0 | n/a | 6,098 | 226 | 0 |
| G7 项目隔离 | **2/2** | 3 | 3 | 0 | 0 | n/a | 13,073 | 508 | 0 |
| G8 非 Coding | **3/3** | 19 | 15 | 0 | 0 | n/a | 72,372 | 3,120 | 1 |
| G9 长上下文 | **3/3** | 3 | 0 | 0 | 0 | n/a | 7,228 | 556 | 0 |
| G10 Subagent | **3/3** | 15 | 2（主 Agent） | 0 | 0–1 | n/a | 21,001 | 1,916 | 0 |

**总成功率：27/27 = 100%** —— 27 次运行全部到达 `completed`，没有 `failed` / `cancelled`。

### 3.1 这一轮测出来的四件事

1. **耗时方差极大，比中位数更有信息量。** 同一条任务三次跑：G3 是 32 / 57 / 320 秒，
   G8 是 16 / 19 / 33 秒。原因不是模型慢，而是**模型自己决定要不要建一个验证脚本**并多轮迭代
   —— G3 最慢那次跑了 27 步（自建 `check-split.js` 反复跑）。这是 `TEST_RULE` 的直接副作用，
   改提示词前先拿它当基线。
2. **确认卡只在真写文件时弹**：G2 / G3 / G5 / G8 / G4 各弹 1–2 次；G1 / G6 / G7 / G9 / G10 一次没弹。
   G5 那次是因为模型**自己决定**跑 `npm install`。
3. **记忆命中时上下文明显更小**：G6 召回那轮 `tokensIn` 6,098，而带项目上下文的 G1 是 20,880。
4. **子代理确实省了上层步数**：G10 主 Agent 只 2 步（`list_dir` + `spawn_subagent`），
   真正的读取在子任务里（6–8 步），并落了 `parentTaskId`。

### 3.2 这一轮**没测到**的（诚实清单）

- **图片 / 多模态**：G9 只用了纯文本，没用图片。
- **真正的上下文裁剪**：G9 那条消息只有 674 字符，**没触发裁剪**，所以 `droppedMessages` 判据没验到。
- **工具 schema token**：§1 的 GAP 还在，没补统计。
- **≥3 次**：G4 只 1 次、G7 每项目各 1 次 —— 这两条的数字**不算稳定基线**。
- **G7 有一次失败记录**（2026-10-08）：重启后立刻跑，`新建对话` 的点击落在还没挂好的界面上，
  消息发进了上一个会话，答案串了项目。已给驱动脚本加「复用了已存在会话」的断言；重跑后干净。
  这暴露的是**驱动脚本的坑，不是产品的 bug** —— 但也说明「切项目后必须先确认新会话」。

**填表口径**（冻结，别改）：

- **成功率**：跑的那几次里，几次满足该任务的**全部判据**（含「不许出现」的反向用例）。
- **耗时**：`task.finishedAt − task.createdAt`；跨进程的（G4）不适用，记「跨两次进程」。
- **工具调用**：`task.steps[]` 的长度（**不是** `run-stats.cjs` 的「二选一」口径 ——
  这里要的是「这一步花了多少动作」，不是「有多少次真实调用」）。
- **输入 / 输出 token**：`task.tokensIn` / `task.tokensOut`（供应商口径）。
- **上下文大小 / 提示大小 / 记忆注入**：单位统一**字符**（本项目 `context-builder.cjs` 就是字符制，
  不换算 token —— 换算反而引入第二个口径）。

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

- **B 部分（动态基线）已填**（2026-10-08 首轮，见 §3）—— 哪些**没测到**如实列在 §3.2。
  静态值仍可用 `文件:行号` 或 `npm test` 复核；跑新一轮要真实模型调用（花钱）。
- **不做 70 条测试矩阵**（任务书 §五）。v1 就 10 条，手工跑，人工判。
- **不引入新依赖**（`AGENT.md` 硬约束 6）。指标优先复用现有 `run-stats.cjs` / `metrics.cjs` / `token-metrics.cjs`。
