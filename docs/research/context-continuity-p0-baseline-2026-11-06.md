# Harbor Context Continuity — P0 现状与基线报告

> 日期：2026-11-06 · 仓库 HEAD `6a9ae72` · 性质：只读调查 + 隔离实测，**本轮不改任何正式运行机制**
> 探针全部在 `tmp/p0-*.cjs`（`tmp/` 会被 `paths.cjs` 自动切到 `data/unit-test-data`，不碰真实数据）
>
> **验证层级标记**（每个结论后面都带一个）：
> - `L1` 源码确认（读代码，指得住文件与行）
> - `L2` 纯函数实测（require 真实内核模块，构造输入跑）
> - `L3` 真实数据回放（读 `E:\Harbor-Dev\dist-portable\Harbor\data` 的真实会话/任务文件，只读）
> - `L4` 真实调用（联网模型 / 真机界面）—— **本轮仅读了 DeepSeek 官方文档**，没发过一次真实推理请求

---

## 0. 八句话结论

1. **丢信息的不是「压缩」，是每轮都在跑的两层静默裁剪**：先按**消息条数**（`historyLimit=20`）切，再按**字符额度**（对话层 30%）裁。两层都不看语义，也不落日志到用户看得见的地方。
2. **原始历史保存是完整的**；丢的只有「这一轮发出去的视图」。但**诊断证据（工具输出）几乎全部落在视图之外** —— 真实会话里 836 次工具调用，最终进上下文的 **0 条**。
3. **容量确实严重没用满**：DeepSeek 声明窗口 65,536，四层预算加总只占 60%，真正给历史的只有 **24%**（0.8 × 0.3）。而界面那个用量圈**只算助手正文、不算工具输出**，实测低估 **2.3～6.3 倍** —— 用户看到「55%」，实际已是 128%。
4. **摘要机制存在但看不见诊断证据**：`compact.summarize` 只收 `user`/`assistant` 的非空正文，工具输出、工具名、空正文 assistant **全部不进摘要**（实测 1,649 字符上下文中只喂了 47 字符 = 2.9%）。
5. **已有可复用的恢复机制比预想的强**：任务台账（目标 / 北极星 / 计划进度 / 最近一步 / 改过哪些文件）+ `attribution.decide` 的「继续」判定 + `resume` 复用同一条任务，实测都工作正常。
6. **「继续」目前恢复得了「做什么」，恢复不了「依据是什么」** —— 台账只存工具输出的**前 300 字**（`slice(0,300)`），且只留最近 200 步。
7. **重启与切 Provider 都不丢任务身份**：任务按 `sessionId` 存、与模型无关；`pauseRunning('startup')` 会把卡在 `running` 的任务改成 `paused` 让「继续」亮起来（实测）。**跨轮授权记录丢失**（进程内 Set，重启清空）是符合预期的设计，不是缺陷。
8. **两个可以立刻做、几乎零风险的修复**（P1）：① 用量圈改为算「真实请求体」；② `assemble` 不再把「取到一串孤立 tool」当成「历史为空」。

---

## 1. 一条完整调用链（L1）

```
用户按下发送
  src/stores/thread/turns.ts
    → turnPayload → history.ts: buildHistory()        ← 第 1 次拼形状：展开 toolRuns
  IPC chat:send
  electron/handlers/chat.cjs
    → chat-parts.windowHistory(limit=20)              ← 【裁剪 1】按消息条数、轮次边界
    → chat-run.cjs: attribution.decide()              ← 归属判定（只判一次）
    → loop.run()
  electron/core/loop-run.cjs → loop.cjs
    → loop-prompt.buildPromptContext()
        → conversation-state.update()                 ← 启发式状态（只取最后一条 user）
        → task-context.buildTaskState()               ← 任务台账注入
        → context-builder.assemble(baseTokens)        ← 【裁剪 2】按字符、静默丢 + 工具组配对
        → prompt-stack.build()                        ← 系统提示分层
    → loop-model.callModel()
        → llm.cjs / codex-cli.cjs
        → 失败且 kind=context_overflow
            → compact.compactMessages()               ← 【压缩 B】不落盘，只救本轮
  响应 → renderer → replyPersistence.persistReply()   ← 全量落盘（含 toolRuns.output）
                 → session-write.append()
```

**两个数据源，别混**：
- **磁盘**（`data/sessions/<id>.jsonl`）：只追加，每行一条 message / meta / compact / conversation_state。
- **视图**（这一轮发给模型的 messages）：由上面前后两层裁剪产生，**两份都不是对方**。

---

## 2. 三层裁剪 + 两种压缩，各自的判据（L1）

### 2.1 裁剪 1：按消息条数（`history-window.takeTurns`）

| 项 | 值 | 位置 |
|---|---|---|
| 预算 | `assistant.historyLimit = 20` **条消息**（不是轮） | `config-defaults.cjs:89` |
| 切点 | 只落在 `user` 消息边界（轮次） | `history-window.cjs:104` |
| 折叠 | 装不下整轮时，把最近 `foldTurns=2` 轮折成三条（用户原话 / 低信任数据 / 助手结论） | `history-window.cjs:148` |
| 钉住 | 开头连续 `system` 消息（压缩摘要）不参与预算 | `history-window.cjs:110` |

**折叠块是什么**（`history-fold.cjs`）：
- 用户原话：**整段原样进，永不截断**（第七轮改的，`wholeOf`）
- 工具：**只有元数据** —— 第几次 / 工具名 / 成功失败 / 输出多少字 / sha256 前 8 位。正文一个字都不搬
- 助手结论：`quoteOf` 按句挑（第一句 / 最后一句 / 含约束词的句子），其余写「N 句 / M 字没有进入本次请求」

### 2.2 裁剪 2：按字符（`context-builder.assemble`）

| 层 | 额度 | DeepSeek-chat 实际（字符） |
|---|---|---|
| memory | 5% | 7,864 |
| project | 15%（有下限 21,024） | 23,592 → 抬到下限 |
| task / conversationState | 10% | 15,728 |
| **conversation（历史）** | **30%** | **47,185** |
| 未分配 | **40%** | 62,913 |

`assemble` 的选取方式是**从最新往前**、逐条 `trim` 到剩余额度，然后 `completeToolGroups()` 丢掉配对不成立的工具组。

### 2.3 压缩 A：渲染层 `maybeAutoCompact`（用户视角「它自己压了」）

- 触发：`adviseCompact().auto` = `used / limit >= autoCompactAt (0.6)`
- `limit = min(窗口 × 0.8, config.context.baseTokens)`
- `used = estimateMessages(contextMessages(messages))` —— **只累加 `message.content`，完全不含 `toolRuns`**
- 执行：`runCompact` → 保留最近 `KEEP_RECENT = 6` 条，其余 `{role, content}` 发给 `chat:compact`
- 落盘：`session:appendCompact(id, summary, upTo)` → 一行 `{type:'compact', upTo, summary}`

### 2.4 压缩 B：内核 `compactMessages`（上游 400 之后）

- 触发：`errors.classify` → `context_overflow`（正则认得 `context length|maximum context|too many tokens|reduce the length`）+ `messages.length > 4` + **只压一次**
- 执行：`compact.rebuild(messages, summary, keepTail=6)` → `[system…, 摘要(user), …最近 6 条]`
- **不落盘**：只在 `options.messages` 上就地改写，下一轮从界面历史重新组装。所以这条压缩只救当前这一轮的后续回合。

---

## 3. 为什么会丢 —— 五个独立病灶（每条都有实测）

### 病灶 1：按条数切，一轮工具调用就把预算吃光（L3，实测）

真实会话 `sess_mw16gqqesenmq.jsonl`（2.2 MB，29 条 message，**836 次工具调用**）：

```
渲染层 rawHistory：866 条 / 199,922 字符   ← 磁盘 29 条，展开成 29.9 倍
【裁剪 1】windowHistory(20)：866 → 4 条 / 3,252 字符
        （折叠 1 轮、省略 0 轮、有损 0 字）
【裁剪 2】assemble：4 → 4 条 / 3,252 字符
最终模型收到：user 3 条（折叠块 + 低信任数据块 + 「继续」）+ assistant 1 条（折叠块）
             工 具 结 果：0 条
```

一句话：**836 次工具调用的全部结果 → 0 条进上下文**。不是压缩干的，是第一层按 20 条切出来的必然结果 —— 一轮 836 次工具调用展开后是上千条消息，`minTurns: 1` 保证最后一轮整轮留下，于是 866 条全部通过第一层，然后被第二层的字符额度从头裁到尾。

第二份 `sess_mw2ab99yxg2l3.jsonl`（11.9 MB，267 条，**3,101 次工具调用**）：

```
rawHistory 3,369 条 / 1,434,720 字符
【裁剪 1】→ 18 条 / 4,148 字符（省略 74 轮、折叠 2 轮）
最终：user 7 / assistant 6 / tool 2
最初那条用户诉求：「不在」—— 只剩摘要
```

### 病灶 2：`assemble` 会把「一串孤立 tool」判成「历史为空」（L2/L3，最严重）

复刻 `assemble` 的选取过程（同一份源码逻辑，只加观察），直接喂真实会话：

```
展开后 863 条 / 199,920 字符（对话层额度 47,185）
选取阶段：selected 26 条，全部是 tool
        角色序列：tttttttttttttttttttttttttt
配对阶段：safe 0 条 —— 26 条全部「孤立 tool（它的 assistant 没进来）」
★ 最终进上下文的非系统消息：0 条
```

原因：`assemble` 从**尾部往前**取，取到的是尾部连续的 `tool` 消息；它们的 `assistant(tool_calls)` 在同一组的开头、早被额度挡在外面 → `completeToolGroups` 判「不完整」→ 整组丢掉 → 全部丢光。

断言只有一句后果说明（`（更早的 863 条对话因预算没进上下文）`），**没有任何地方报错、没有任何测试会红**。

同样的问题在「assistant 正文为空」时更隐蔽（L2）：

| 场景 | 输入 | 输出 | 工具结果 |
|---|---|---|---|
| 30 次工具 · assistant 都带一句短话 | 62 条 / 26,263 字符 | 62 条 / 26,263 字符（用掉额度 55.7%） | 30 条全在 |
| 30 次工具 · assistant **正文为空** | 62 条 / 26,033 字符 | **2 条 / 13 字符** | **30 条全丢** |

`loop.cjs:252` 写的是 `content: result.content \|\| ''` —— 模型只调工具不说话时，那条 assistant 的 content 就是空串，`assemble` 里 `size > 0` 不成立 → 它不进 `selected` → 顺带把它的 tool 全变成孤儿。

> 真实数据里「正文为空且带工具」的比例：`sess_mw16` 0/28 条，`sess_mw2ab` **18/189 条**（L3）。后者足以让某几轮的诊断证据整段消失。

### 病灶 3：用量圈算的是另一份东西（L3，实测数字）

`ContextGauge` 用 `adviseCompact` → `estimateMessages(contextMessages(...))`，只累加 `message.content`。而真实请求体要展开 `toolRuns`、每条 output 截到 2,000 字符。

| 会话 | 界面圈 | 实际请求体 | 低估 |
|---|---|---|---|
| `sess_mw16gqqesenmq` | 29,047 token（55.4%） | 66,899 token（**127.6%**） | **2.3 倍** |
| `sess_mw2ab99yxg2l3` | 76,502 token（145.9%） | 478,604 token（**912.9%**） | **6.3 倍** |

自动压缩线 = 0.6 × 52,428 = **31,457 token**。

- 第一份会话：界面说「差 2,410 token 才过线 → **不压**」，实际早已 128%。
- 用户看到的就是「圈才 55%，它却把历史裁没了」—— 因为裁历史的那一层（`assemble`）用的又是第三个口径（字符 30%）。

**三套口径，互不相认**：界面（content token）/ 实际请求体（展开+截断后的 token）/ `assemble`（字符）。

### 病灶 4：摘要拿不到诊断证据（L2，实测）

`compact.summarize` 的 transcript 构造（`compact.cjs:71`）：

```js
messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
```

实测（构造一段 1,649 字符、含一次 800 字符工具输出的上下文）：

```
喂给摘要的 transcript：47 字符（2.9%）
★ tool 消息进了摘要吗：没进
★ tool_calls（调了什么工具）进了摘要吗：没进
★ 正文为空的 assistant 进了摘要吗：没进
```

**而工具输出正是诊断证据的主体**：真实会话里工具输出是助手正文的 **3.9 倍**（`sess_mw16`）和 **10.0 倍**（`sess_mw2ab`）。

所以「压缩之后的摘要」结构上不可能包含「我查到 X 文件第 12 行有个问题」这类结论 —— 除非助手当时把它写进了正文。

### 病灶 5：`rebuild` 的 `slice(-6)` 会切出孤儿 tool（L2，实测）

`compact.rebuild(history, summary, keepTail=6)` 用 `rest.slice(-6)` 收尾。用真实形状（成组的 `assistant(tool_calls)` + N 条 `tool`）测 16 个用例：

```
✓ 1 组工具（末条是 tool）：3 → 4 条，协议问题 0
✗ 3 组工具（末条是 tool）：10 → 7 条，协议问题 2（孤儿 tool g1_0 / g1_1）
✗ 4 组工具（末条是正文）：13 → 7 条，协议问题 3
…
★ 16 个用例里，rebuild 之后协议不合法的：8 个
```

协议检查按上游要求做：每个 `tool` 必须有前面的 `assistant(tool_calls)` 带对应 id，每个 `tool_calls` 的 id 必须有对应 `tool`。

后果：自动压缩把历史就地换成 `rebuilt`，下一轮直接拿它去请求上游 → 这些用例里会 **400 tool_call_id 无对应**。而这条路径**不落盘**，用户看到的是「压缩后立刻又报错」。

---

## 4. 原始历史与诊断证据到底存了什么（L1/L3）

### 4.1 存得完整的部分

| 数据 | 位置 | 保留策略 |
|---|---|---|
| 会话消息（含 `toolRuns[].output` 全量） | `data/sessions/<id>.jsonl` | **不被清理**（`data-retention` 只管 logs / events / crash / tool-output） |
| 压缩点（每次一条，保留历史） | 同上，`{type:'compact', upTo, summary}` | 不清理 |
| conversation_state（每轮一条） | 同上 | 不清理 |
| 任务台账（目标 / 北极星 / 计划 / 变更文件 / 检查点） | `data/tasks/<id>.json` | 不清理 |
| 命令完整输出（> 8,000 字符时） | `data/logs/tool-output-<ms>.log` | 30 天 / 256 MB / 至少留 5 份（实测现存 **929 个**） |

`session-compact.cjs` 会压实同 key 的分段快照，但**不改读出来的结果**（规则与 `collapseByKey` 逐条对齐）。

### 4.2 存得不完整 / 存不到的部分

| 缺口 | 具体 | 证据 |
|---|---|---|
| 单条工具输出有上限 | `read_file`/`browse` 走 `truncateMiddle(12000)`；`run_shell` 走 `truncateWithLog(8000)` | `_shared.cjs:109/128`；真实会话里最大一条工具输出 **12,189 字符**（正好 12000 + 头部） |
| 工具输出 > 8,000 且不是 run_shell 时**不落盘** | read_file 的 12,000 上限之外的内容永久丢失 | `read_file.cjs:51` 用 `truncateMiddle`，没写文件 |
| 任务台账的「这一步干了什么」只有 300 字 | `addStep` 里 `summary: String(summary ?? '').slice(0, 300)` | `task-notes.cjs`；实测 9,750 条 steps，summary 中位数 **296**、最大 **300** |
| 任务台账只留最近 **200 步** | `if (task.steps.length > 200) task.steps = task.steps.slice(-200)` | 实测 6 个任务正好卡在 200 |
| `commands` 只留 100 条、`steering` 只留 20 条、`checkpoints` 只留 50 条 | `task-notes.cjs` 各处 slice | L1 |
| **模型不知道自己的会话文件在哪** | `prompt-env` / `prompt-stack` / `tool-map` / `machine-env` 全文搜 `sessionId` / `sessions` → **零命中**；也没有「读会话」的工具（`session:toApiMessages` 是 IPC 通道） | L1 |

最后一条是本轮最重要的结构性发现：

> **原始历史完整地躺在磁盘上，但模型没有任何办法自己回去读它。**
> 用户说的「Agent 无法准确找回之前的诊断、执行进度」—— 根因在这里，不在摘要质量。

---

## 5. 上下文容量：真实用了多少（L2/L3）

### 5.1 各 Provider 的窗口从哪来

- 唯一来源：`provider-presets.cjs` 的**声明表**（按模型名正则匹配）+ 用户覆盖（`provider.modelCapabilities`）
- `provider-capabilities.cjs` 文件头明写：**全部是「声明」，不是「探测」**
- `context-window.effectiveBaseTokens = min(窗口 × 0.8, 用户上限)`；窗口未知 → `DEFAULT_CONTEXT_TOKENS = 16384`

| 模型 | 声明窗口 | 输入基准 | 对话层（30%） | 真正给历史的 token ÷ 窗口 |
|---|---|---|---|---|
| deepseek-chat | 65,536 | 52,428 | 47,185 字符 | **24.0%** |
| deepseek-flash | 1,000,000 | 800,000 | 720,000 字符 | **24.0%** |
| deepseek-v4-pro | 1,000,000 | 800,000 | 720,000 字符 | **24.0%** |
| gpt-4o | 128,000 | 102,400 | 92,160 字符 | 24.0% |
| gpt-4.1 | 1,047,576 | 838,060 | 754,254 字符 | 24.0% |
| claude-sonnet-4 | 200,000 | 160,000 | 144,000 字符 | 24.0% |

**结论：无论换哪个模型，历史只能用掉声明窗口的 24%。** 剩下的 76%：20% 是输出预留（0.8 的余量），**40% 是预算表里根本没分配的**（`memory 5 + project 15 + task 10 + conversation 30 = 60%`）。

### 5.2 系统提示占多少（L2）

实测装配（不含记忆与项目说明的真实内容）：

```
工具清单：1,687 字符（≈563 token，11 行，7 个条目）
系统提示骨架合计：2,906 字符 ≈ 969 token = 输入预算的 1.8%
```

**没有发现重复系统提示或重复工具描述。** 系统提示拆成「稳定 / 易变」两条 system message，稳定前缀吃缓存（`prompt-stack.splitMessages`）。这一项是健康的。

### 5.3 有没有过早压缩

| 判断维度 | 结论 |
|---|---|
| 界面口径 | 第一份会话「55.4%，不压」→ 看起来没早压 |
| 实际请求体 | 128%，早已超过对话层额度 → **实际上是在「超额状态下继续裁」** |
| 内核口径 | 上游 400 之前**不会**主动压（`COMPACT_RATIO=0.6` 的 `shouldCompact` 全仓库**没有调用点**，只有定义） |

所以准确说法是：**不是「过早压缩」，而是「压缩阈值看错了对象，同时每轮都在静默裁」。**

比例设成 0.4/0.6 本身不算保守 —— 保守的是 `conversation` 那 30%，和「按条数 20 条」这道与容量无关的闸。

### 5.4 待验证（必须与结论分开）

| 项 | 为什么待验证 |
|---|---|
| **`deepseek-chat` 这个名字现在还能不能用** | 官方文档（2026-11-06 读）只列 `deepseek-flash` 与 `deepseek-v4-pro`；2026-04-24 变更日志写「`deepseek-chat` / `deepseek-reasoner` 将于 **2026-07-24** 停用」。而 Harbor 的**默认模型就是 `deepseek-chat`**，预设写 65,536。本轮**没有发真实请求**验证它今天是否仍被路由到某个 1M 窗口的模型。→ 若仍可用，Harbor 按 65,536 算是**严重的容量低估**；若已停用，默认配置会 400。 |
| 各家中转站的真实窗口 | 声明值来自公开文档；中转站可能裁剪或放大，Harbor 无探测 |
| 上游对「孤儿 tool」的实际反应 | 按 OpenAI 兼容协议它应当 400；本轮没发请求验证具体家数的行为 |
| `chars/3` 估算系数的真实误差 | 纯中文 300 字估 100 token、纯英文 300 字符估 100 token、代码 300 字符估 109 token（L2）—— 三种内容被估成同一个数，说明这个系数**对中文偏乐观**（真实约 1.5 字/token，300 字≈200 token） |

---

## 6. 已有的任务恢复机制（L1/L2/L3）

### 6.1 台账里存了什么（真实数据实盘，131 条任务）

| 字段 | 覆盖 |
|---|---|
| `sessionId` | **131 / 131** |
| `promptVersion` | 130 / 131 |
| `checkpoints` | 126 / 131 |
| `result` | 118 / 131 |
| `plan` | 89 / 131 |
| `changedFiles` | 81 / 131 |
| `star`（北极星） | 73 / 131 |
| `nextAction` | **12 / 131** |
| `permissions` | **0 / 131** |
| `errors` | 0 / 131 |

状态分布：`completed 118 / paused 11 / running 1`。

### 6.2 「继续」怎么判断上一轮该做什么（L2，实跑真实内核函数）

```
attribution.decide({ sessionId, goal: '继续' })
  → kind=resume, reason=continue-intent

isContinueIntent 判据（全仓库唯一一处正则，task-steering.cjs:34）
  「继续」                    → 算继续
  「接着做」                  → 算继续
  「go on」                   → 算继续
  「继续优化 Agent 执行系统」  → 不算（15 字内但后面接了宾语）
  「把刚才那个模块重构一下，另外加上日志」→ 不算
```

注入给模型的 `taskState`（实测 24 行 / 1,348 字符）：

```
以下是**还没做完**的任务台账（来自磁盘，不是你说过的话）。
继续干活时以它为准：接着计划里**第一条没有 [x] 的**往下做，别重复已经完成的步骤。
（用户这句「继续」是在说**接着做** —— 目标是上面那条任务，不是新任务。
 先看计划进度和最近一步，从停住的地方往下走；缺上下文就查最近工具结果，别从头再问一遍。）
▶ [paused] 上下文诊断报告
  目标：给 Harbor 加一个只读的上下文诊断报告
  北极星：交出一份能重跑的诊断脚本，不引入新依赖
  计划（1/3 完成）：
    [x] 1. 读 context-builder
    [ ] 2. 写诊断脚本
    [ ] 3. 跑测试
  最近一步：read_file 成功 — 读完 context-builder.cjs，确认对话层额度 = baseTokens×3×30%
  已改文件：1 个
## 这个项目的现状（每轮从磁盘重扫……）
```

**五项都在**：目标 ✓ 北极星 ✓ 计划进度 ✓ 最近一步 ✓ 改过哪些文件 ✓

### 6.3 重启能恢复到什么程度（L2，隔离目录实跑）

```
重启前：t2.status = waiting_user
pauseRunning('startup')  → t2.status = paused, pauseReason = interrupted
recovery.scan()          → 扫出 2 条未完成
  t2: canResume=true, progress=1/2, 停在第 1 步, envChanged=0, replay={count:0}
openForRun({resumeTaskId: t2.id})
  → 复用同一条 = true, status=running, resumeCount=1
★ 有没有新建第二条？2 条任务（应为 2）—— 没有重复建
checkEnvironment（文件 mtime 晚于 updatedAt+2000ms）→ changed=1 条（期望 1）
```

**不重复执行**的机制：`task-intent` 先落意图再执行（`markIntent → completed:false` → 执行 → `markCompleted`），`isPending` 判「结果不明」，`replayRisk` 按 `REPLAY_UNSAFE` 白名单判「重跑会不会做两份」。

### 6.4 切换 Provider（L2）

```
全局 deepseek-chat + 会话里选 gpt-4o → effective.model = gpt-4o（scoped=true）
切回 → deepseek-chat
任务按 sessionId 存，与模型无关：t1.sessionId 不变
```

**共用**：会话消息、任务台账、记忆、变更集（全是自家中立格式）。
**不共用**：`provider-capabilities.CODEX_CLI_CAPS`（codex CLI 后端没有 `tool_call`、没有 token 级流）—— 切到 codex CLI 会**丢掉整个工具循环**。这是「工具能力」而不是「上下文格式」的差异，但会直接让「继续做」变成「只能聊」。

### 6.5 授权记录的现状（L2）

```
noteGrant(SID, { granted: true })  → sessionGranted(SID) = true（跨轮仍算数）
noteGrant(SID, { stopped: true })  → sessionGranted(SID) = false（撤销生效）
★ 记录只在进程内存里：重启后必为 false（代码里没有任何落盘调用）
```

这符合设计（`user-grants.cjs` 文件头：重启之后是新的一次对话，本来就该重新问）。
**P0 的边界**：任务现场恢复可以**引用**授权记录（「他在这条会话里说过可以改源码」），但**不能**据此重新授予写入权限 —— 恢复时必须重新问。

---

## 7. 场景 A–E 基线（本轮实跑的部分）

| 场景 | 验证层级 | 做法 | 结果 |
|---|---|---|---|
| **A 长对话压缩** | L3（真实会话回放）+ L2（受控模拟摘要） | 真实会话 267 条走完整裁剪链；压缩点分别设在 50% / 80% / 94% | 三种比例下最终请求都是 **103 条 / 11,762 字符**，其中 **tool 90 条**、user 1 条、assistant 11 条；**最初那条用户诉求都不在**（只剩摘要） |
| **B 丢失上文后继续** | L2（真实内核函数 + 隔离台账） | 造 paused 任务（3 步做完 1 步）+ 北极星 + 已改文件；发「继续」 | `decide → resume`；`taskState` 24 行，目标/北极星/计划/最近一步/改过文件**五项都在** |
| **C 中断/重启** | L2（隔离目录，真实 `pauseRunning` / `scan` / `openForRun`） | `waiting_user` → 模拟启动 → 恢复 | 状态正确改成 `paused`；`canResume=true`；**复用同一条任务、不新建**；`envChanged` 能识别「停手后被改过」的文件 |
| **D 手动切 Provider** | L2（`withRequestedModel` 实跑）+ L1（能力表） | 全局 deepseek-chat ↔ 会话级 gpt-4o | 会话级覆盖生效；任务/消息与模型无关。**codex CLI 后端会丢工具循环** → 这一档本轮**无法端到端测「继续做」**（缺 codex CLI 凭据环境） |
| **E 上下文容量** | L2 + L3 | 同一份真实会话算三种口径 | 界面 55.4% vs 实际 127.6%（低估 2.3 倍）；第二份 145.9% vs 912.9%（低估 6.3 倍）；历史只能用掉声明窗口的 24% |

### 本轮**没有**做（如实说明）

- **没有发过任何真实模型请求**（除读官方文档）。所以「DeepSeek 实际接受多大的请求体」仍是**声明值**，不是实测值。用户明确要求不必为此烧钱。
- **没有做真机 UI 验收**（`npm run shot:electron`）。本轮不改运行机制，且界面行为已由源码 + 纯函数确定。
- **场景 D 的 codex CLI 分支**没有端到端跑（缺环境），只做了能力表与分流的源码确认。

---

## 8. 对照成熟方案：哪些已有、哪些能借、哪些不该引（L1）

已有的评估（`docs/research/成熟方案复用评估-2026-11-02.md`）已判定：Temporal / LangGraph-sqlite / DBOS / Inngest / Mem0 / Letta / Zep **全部撞硬约束**（原生依赖 / 外部服务 / 数据出 `data/` / 模型调用不确定 → 确定性重放无意义）。本节只补充与**上下文**直接相关的五项。

| 方案 | 核心思想 | Harbor 现状 | 判断 |
|---|---|---|---|
| **OpenHands** | 原始事件历史与「模型当前上下文视图」**彻底分离**：事件流是唯一真相，视图是每轮现算的投影 | **已具备雏形**：磁盘 jsonl 是事件流，`assemble` 是视图。但**视图不可回读**（模型拿不到事件流），且视图计算有病灶 2 | **借思想，补缺口**：给模型一条「回读原始记录」的路，而不是把事件流塞进上下文 |
| **Gemini CLI** | 动态上下文预算 + 压缩阈值 + 历史保留策略三者**同一套算法** | **没做到**：三套口径（界面 token / 请求体 token / assemble 字符）互不相认，实测差 2.3～6.3 倍 | **必须借**：把「用量」收敛成一个数（见 P1-1） |
| **LangGraph** | checkpointer 持久化任务状态 + `interrupt` 断点 + 恢复时跳过已完成 | **80% 已有**：台账 + `task-intent` 意图账 + `openForRun` 复用同一条 | **借机制，不引运行时**（已有评估结论） |
| **Claude Code / Codex** | 压缩时把「目标 / 决定 / 文件 / 下一步」结构化保留，且**摘要落盘可复用** | **半有**：`SUMMARY_SYSTEM` 已经是 7 段结构化模板（Goal / Decisions / Constraints / Files Changed / Tests / Unresolved / Next Step）；但**内核路径的摘要不落盘**，也不含工具证据 | **借「摘要要含证据 + 要落盘」** |
| **Cline** | 按任务保存/恢复工作记录 | **已有**：`data/tasks/<id>.json` 一个任务一个文件，含计划版本、检查点、变更文件 | **无需引入** |

**共同结论：不需要新记忆系统 / 新数据库 / 新 Agent 框架。** 缺的是三件小事：口径统一、视图可回读、证据进台账。

---

## 9. 建议：按「证据强度 × 改动面」排序（P1/P2/P3）

### P1（先做这三件，都在现有模块内，不动数据结构）

| # | 改什么 | 为什么（证据） | 改动面 | 怎么验 |
|---|---|---|---|---|
| **P1-1** | 用量圈与自动压缩阈值改用**真实请求体**口径（展开 `toolRuns` + 单条截断规则与 `history.ts`/`session-replay` 同形） | 实测低估 2.3～6.3 倍；第一份会话说「55% 不压」而实际 128% | `src/stores/thread/compact.ts` 的 `estimateMessages`（1 处口径），`ContextRow` 自动跟随 | 同一份真实会话回放：新的 used 应 ≈ 66,899 而非 29,047；≥2 倍即通过 |
| **P1-2** | `assemble` 在「取到的第一条是 tool」时，**把它的 assistant(tool_calls) 一起拉进来**（或直接把这一组整体丢弃后继续往前取，而不是整份清零） | 实测真实会话 863 条 → **0 条**；30 次工具 + 空正文 → 62 条 → **13 字符** | `context-builder.cjs` 的 `assemble` 选取循环（约 20 行） | 上面两个用例：修复后不得出现「输出 0 条」或「只剩 13 字符」；且 `completeToolGroups` 的丢弃数应为 0 |
| **P1-3** | 让模型能**自己回读本会话的原始记录**：给系统提示加一小段（会话 id + `data/sessions/<id>.jsonl` 路径 + 「用 read_file 按行读」的说明），或加一个只读工具 | 模型现在**完全不知道**会话文件在哪（四个提示模块零命中）；这是「找不回诊断证据」的根因 | 提示层 1 处（预算要算：约 200 字符）+ 可选 1 个只读工具 | 隔离会话里问「我们第三步查到了什么」，看它是否去读 jsonl 而不是重跑工具 |

> P1-2 与 P1-3 是**互补**的两条路：前者让「进上下文的更完整」，后者让「没进上下文的也能查回来」。

### P2（口径与证据链，动到内核行为，需要单独评审）

| # | 改什么 | 为什么 |
|---|---|---|
| P2-1 | `conversation` 那 30% 单独抬到 60～70%，或把「未分配的 40%」显式分给历史 | 历史只能用掉声明窗口 24%（实测）。扩大有效上文是**最直接**改善「丢任务信息」的手段 |
| P2-2 | 压缩摘要的 transcript 加上**工具元数据**（工具名 / 参数摘要 / 成功失败 / 输出前 N 字 / 完整输出文件路径） | 实测摘要只看到 2.9% 的上下文；而工具输出是正文的 3.9～10 倍 |
| P2-3 | `compact.rebuild` 的 `keepTail` 改成「按工具组对齐」（同 `completeToolGroups` 的判据） | 16 个用例里 8 个切出孤儿 tool → 上游 400 |
| P2-4 | 任务台账 `steps[].summary` 从 300 字改成「前 300 字 + 完整输出所在文件/行号」，并把 `nextAction` 的写入从「只在 setPlan 时」扩展到「每步之后」 | summary 中位数 296（贴死上限）、`nextAction` 只有 12/131 条。这是「诊断结论可回取」唯一的落点 |
| P2-5 | 内核 `compactMessages` 的摘要**落盘**（复用 `session:appendCompact` 那条路） | 现在不落盘，下一轮从界面历史重新组装 → 同一段历史会被反复压 |

### P3（需要设计，不是修 bug）

| # | 内容 | 为什么放最后 |
|---|---|---|
| P3-1 | 「任务现场快照」：任务暂停/重启时，把「目标 / 北极星 / 计划 / 最近 N 步的证据摘要 / 改过哪些文件 / 未验证的写操作」写成一份可注入的现场包 | 现在这些数据**分散在**台账 + `conversation_state` + 会话文件三处，注入时各取一段（`taskState` 已做了一半）。要先确认「这个状态属于哪个实体」（AGENT.md 硬禁区 10） |
| P3-2 | 跨 Provider 的「上下文可移植性」检查：切到 codex CLI 前提示「这个后端没有工具循环」 | 属产品行为决策，不是 bug |
| P3-3 | 摘要质量（结构化模板已有，要不要加「证据锚点」字段） | 依赖 P2-2 先落地才有素材评估 |

---

## 10. 直接回答用户提的八个问题

1. **为什么会在压缩/折叠后丢任务信息？**
   不是压缩干的。每轮都在跑两层静默裁剪：① 按**条数** 20 条切（与容量无关，一轮工具调用就能吃光）；② 按**字符** 30% 裁，且取到孤立 tool 时会把整份历史清零。压缩只是第三层，且它的摘要看不到工具证据。

2. **原始历史和诊断证据保存得是否完整？**
   原始历史**完整**（会话 jsonl 不被清理，`toolRuns.output` 全量落盘）。但：单条工具输出上限 12,000/8,000 字符；台账只存前 300 字、只留最近 200 步；**模型没有任何办法自己回去读**。所以「存着」但「拿不到」。

3. **DeepSeek 容量使用是否合理，有没有过早压缩？**
   不合理，但不是「过早压缩」，是「阈值看错对象 + 40% 额度没分配」。历史只能用掉声明窗口的 **24%**；用量圈低估实际 **2.3～6.3 倍**。另外**必须核实 `deepseek-chat` 这个名字今天是否还有效**（官方 2026-04-24 公告说 2026-07-24 停用）。

4. **已有哪些可复用的恢复机制？**
   任务台账（目标/北极星/计划/最近一步/改过文件）、`attribution.decide` 唯一归属判定、`task-resume.openForRun` 复用同一条任务、`task-intent` 意图账防重复执行、`recovery.scan` 纯读恢复清单、`checkEnvironment` 环境变化检测、`SUMMARY_SYSTEM` 七段摘要模板。**都不需要重写。**

5. **「继续」/重启/切模型分别能恢复到什么程度？**
   - 「继续」：恢复到「做什么、做到哪、改了哪些文件」（实测五项都在）；**恢复不到「依据是什么」**（工具证据不在）。
   - 重启：任务身份与进度**完整恢复**，不重复建任务，能识别「停手后文件被改过」；授权记录清空（设计如此）。
   - 切模型：消息/任务/记忆全部共用；**切到 codex CLI 会丢工具循环**，那时「继续做」退化成「只能聊」。

6. **哪些可以通过配置或小范围修改解决？**
   配置即可：`assistant.historyLimit`（20 → 更大，直接缓解病灶 1）、`context.budget.conversation`（30 → 更大）、`context.baseTokens`（0 = 跟随窗口，已是默认）。
   小范围改：P1-1（用量口径）、P1-2（孤立 tool）、P1-3（回读原文）—— 三处都在现有模块内，不动数据结构。

7. **哪些需要补充任务现场恢复能力？**
   ① 「证据可回取」：工具输出的完整件与台账 300 字之间要有一条可判定的关联（P2-4 + P1-3）；② 「现场包」：暂停/重启时把分散三处的现场合成一份可注入的结构（P3-1，需先定实体归属）；③ 摘要要含证据锚点（P2-2）。

8. **P1/P2/P3 顺序**
   **P1 先做 P1-1 和 P1-2**（纯 bug、无歧义、当天可验），**P1-3 紧随**（它治的是根因）。P2 按上表顺序，其中 P2-1（扩额度）收益最大但影响面最广，建议在 P1-1 把口径统一之后再做 —— 否则「扩了多少」没法度量。P3 等 P2 落地后再定。

---

## 11. 本轮约束核对

| 约束 | 结果 |
|---|---|
| 未修改任何正式运行机制 | ✓ 只新增 `tmp/p0-*.cjs` 探针与本报告 |
| 未动真实用户数据 | ✓ 真实会话/任务**只读**；恢复实验全部在 `data/unit-test-data`（`paths.cjs` 对 `tmp/` 探针的自动隔离），实验结束已清理自造的 2 条任务 |
| 未使用真实工作区做破坏性操作 | ✓ `checkEnvironment` 用的探针文件写在 `tmp/`，用完删除 |
| 未产生真实 API 费用 | ✓ 零次模型调用 |
| 未引入新依赖 | ✓ 只用 node 内置模块与项目已有内核模块 |
| 未改数据结构 / 未新增 IPC 通道 | ✓ |
| 未改权限/安全模型 | ✓ |
| 数据只落 `data/` | ✓ 探针不写盘（除 `tmp/` 下的探针文件与隔离目录） |
| 单文件 ≤ 300 行 | ✓ 探针最大 136 行；`.md` 不在该约束内 |
| 未报未验证的「已完成」 | ✓ 每个结论带 L1/L2/L3 标记，L4 未做已单列 |

### 探针清单（**不入库**，本机有效）

⚠️ 这些脚本在 `tmp/p0-*.cjs`，而 `.gitignore` 里有 `tmp/*`（只放行 `tmp/README.md`）——
**它们不进仓库，换台机器就没有了。** 所以下面只能算「本轮复跑记录」，不是长期设施。

```bash
# 本轮跑过的（参数都是真实会话路径，只读）
node tmp/p0-budget-probe.cjs      # 各模型预算、四层额度、两套阈值
node tmp/p0-fold-probe.cjs        # 按条数切 + 折叠的真实产物
node tmp/p0-assemble-probe.cjs    # content 空 / 非空 对工具组的影响
node tmp/p0-assemble-internal.cjs "…\sess_xxx.jsonl"    # assemble 归零的完整归因
node tmp/p0-assemble-verify.cjs   # estimates 与实际输出的偏差
node tmp/p0-real-window.cjs "…\sess_xxx.jsonl"          # 真实会话逐层数字
node tmp/p0-final-request.cjs "…\sess_xxx.jsonl" "继续"  # 最终请求里模型看到什么
node tmp/p0-path-baseline.cjs "…\sess_xxx.jsonl"        # 场景 A 完整基线
node tmp/p0-session-stats.cjs "…\sess_xxx.jsonl"        # 会话结构统计（不打印正文）
node tmp/p0-gap-probe.cjs "…\sess_xxx.jsonl"            # 界面圈 vs 实际请求体
node tmp/p0-capacity.cjs "…\sess_xxx.jsonl"             # 容量利用率
node tmp/p0-compact-probe.cjs     # 摘要看不到什么
node tmp/p0-rebuild-probe.cjs     # rebuild 切出孤儿 tool 的比例
node tmp/p0-prompt-size.cjs       # 系统提示各层字符
node tmp/p0-recovery-probe.cjs    # 场景 B/C/D（自动走隔离目录）
node tmp/p0-simulate-compact.cjs "…\sess_xxx.jsonl"     # 场景 A 受控模拟
```

**P1 实施时要「改前 / 改后对比」，只需要两个**，建议按 `tmp/README.md` 第 1 节的规矩挪进 `tools/dev/`（那里是「可复用的一次性脚本」的归属，进仓库）并登记：

| 探针 | 干什么 | 用于验收 |
|---|---|---|
| `p0-path-baseline.cjs` | 真实会话 → 两层裁剪 → `assemble` → 打印「模型最终看到什么」 | P1-2、P2-1 |
| `p0-gap-probe.cjs` | 同一份会话的「界面圈 / 实际请求体」两个数 + 低估倍数 | P1-1 |

挪的时候要注意 `tools/dev/` 比 `tmp/` 深一级：脚本里的仓库根要改成 `path.resolve(__dirname, '..', '..')`（那边现有脚本用 `import.meta.dirname, '..'`，正是这个原因）。

