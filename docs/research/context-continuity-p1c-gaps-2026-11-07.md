# Harbor Context Continuity — P1-C 缺口核实与最小方案

> 日期：2026-11-07 · 仓库 HEAD `a0d4dcf` · 性质：**只读核实 + 隔离测试**，本轮不改任何源码
>
> **验证层级**（每条结论都带一个）：
> - `L1` 源码确认 —— 指得住文件与行
> - `L2` 隔离实测 —— 在 `data/unit-test-data` 里跑真实内核函数（`tmp/p1c-*.cjs`）
> - `L3` 真机 —— 需要真实运行中的 Harbor 才能确认，**本轮未做**
> - `未验证` —— 只是推断，或条件不具备

---

## 0. 六句话结论

1. **工具证据在磁盘上是完整的，一个字都没丢。** 5 万字符的工具输出落盘后逐字完整（L2 实测），错误文本也在。回放时才按 `OUTPUT_CAP=2000` 截断——**那是「进上下文」的规则，不是「存档」的规则**。
2. **模型完全不知道会话记录在哪。** 六个提示模块全搜过：`prompt-stack` / `prompt-env` / `tool-map` / `machine-env` **零命中** `sessions` / `.jsonl`；`loop-prompt` 与 `task-context` 出现 `sessionId` 只是做隔离过滤，**从不打印给模型**（L1）。
3. **34 个内置工具里没有一个是「读会话/读历史证据」的**（L2 实测：`registry.ALL.length === 34`，按名字筛 `session|history|recall|evidence|context|task` **零命中**）。
4. **就算知道了路径，默认也读不了**：`capability.check` 在 `fileScope='workdir'` 时把 `data/sessions/*.jsonl` 判为「工作目录之外」直接拒（L2 实测）。
5. **缺口不在「有没有存」，而在「模型能不能自己找回来」。** 三条卡点串成一条：不知道路径 → 没有工具 → 知道了也过不了权限。
6. **P1-A/P1-B 的修复仍然有效**：直接 require **Harbor-Dev 运行目录**那份内核，13 项判据全过（L2）。Dev 进程 2:39 启动，11 个内核文件与源码 sha1 全一致（L2）。

---

## 1. 基线确认（L2）

| 项 | 结果 |
|---|---|
| 仓库 HEAD | `a0d4dcf`（工作区只有一份未提交的设置报告） |
| Harbor-Dev 进程 | 11-07 **02:39:05** 启动（4 个进程，另有 1 个 6:08 的旧进程） |
| 运行目录 vs 源码 | 11 个 P1 相关 `.cjs` **sha1 全部一致** |
| `build-info.json` | `gitCommit: 3310143`、`verifiedAt: 2026-11-07T02:33` |

> `build-info` 写 `3310143` 而不是 `a0d4dcf` 是对的 —— `a0d4dcf` 只动了渲染层（`ContextRow.tsx` / `contextUsage.ts` / `streamEvents.ts`），内核没变。

**P1-A/P1-B 有效性：13/13 通过**（`tmp/p1c-dev-kernel.cjs`，直接 require Dev 目录那份）：

| 判据 | 结果 |
|---|---|
| 空正文 assistant + 30 次工具 → 保留 30 条 tool（改前 0） | ✅ |
| 协议合法（0 孤儿 / 0 悬空） | ✅ |
| 空正文仍是空串（不编造） | ✅ |
| 尾部孤立 tool 不再把历史清零 | ✅ |
| 「继续」那句还在 | ✅ |
| `compact.rebuild` 16 种形状协议全合法（改前 8 个不合法） | ✅ |
| 估算四项可对照（整份 = 系统 + 对话） | ✅ |
| token = ceil(chars/3) | ✅ |
| 对话层不超额度 | ✅ |
| `sizeOfMessage(空正文+tool_calls) > 0` | ✅ |

---

## 2. 缺口①：历史证据为什么无法自动回取

### 2.1 磁盘上有什么（L2 实测）

隔离会话里写一条 5 万字符的工具输出 + 一条失败输出，然后读**原始 JSONL 行**（不经过任何读取层）：

| 项 | 结果 |
|---|---|
| 文件大小 | 57,321 字符 |
| `toolRuns[0].output` 长度 | **50,000**（写入时 50,000 → **完整保留**） |
| `toolRuns[1].output`（失败） | 3,008，`"错误：命令失败"` 文本也在 |
| `content: ""`（空正文） | 保留 |

**结论：存档层没有任何截断。** 截断只发生在 `session-replay.replayToolRuns`（`OUTPUT_CAP = 2000`）——那是「回放成 API 消息」时的规则，属于**视图**，不是**存储**。

### 2.2 但模型拿不到（L1/L2）

**三道卡点，缺一不可通过：**

| # | 卡点 | 证据 |
|---|---|---|
| ① | **提示里不说路径** | 6 个提示模块搜 `sessions` / `.jsonl` **全部零命中**。`loop-prompt.cjs` / `task-context.cjs` 里的 `sessionId` 只用于「按会话过滤任务」，从不输出给模型 |
| ② | **没有读会话的工具** | `registry.ALL` 共 **34** 个内置工具，按名字筛 `session` / `history` / `recall` / `evidence` **零命中**（L2）。`memory_search` 读的是记忆库、`read_file` 读的是文件系统（但见③），`spawn_subagent` 是只读侦察兵（读文件，不是读会话） |
| ③ | **就算知道路径，权限也拒** | `capability.check(data/sessions/x.jsonl, {workdir})` → **拒绝**，`reason: "它在工作目录之外"`（L2 实测）。`fileScope` 从 `config.get().tools.fileScope` 读（`capability.cjs:72`），默认 `workdir` |

> 顺带纠正一个常见误判：会话文件**不是**敏感文件（`sensitiveReason` 返回空串），所以它只受「工作目录范围」管，不受「精确授权」管。这意味着一旦 `fileScope='full'` 就能读——见 §5 方案。

### 2.3 任务台账能不能定位到证据（L2 实测）

真实创建一条任务、加一步，看台账字段：

```
台账字段（34 个）：id title goal star status mode sessionId projectId workdir
  parentTaskId plan planVersions steps checkpoints changedFiles commands
  changeSetId errors result budget preset pauseReason ... 
steps[0] 的键：at tool ok ms summary args
steps[0]：{"at":...,"tool":"read_file","ok":true,"summary":"读了 context-builder.cjs",
          "args":{"path":"electron/core/context-builder.cjs"}}
```

| 项 | 状态 |
|---|---|
| `sessionId` | ✅ **有**（能定位到哪条会话） |
| `steps[].args` | ✅ 有（能定位「读了哪个文件」） |
| `steps[].summary` | ⚠️ **被截到 300 字**（`task-notes.cjs:75`） |
| 工具输出的**完整内容** | ❌ **没有**。`steps` 里没有 `output` 字段 |
| 工具输出的**文件路径** | ❌ 没有（不记「这次输出存在哪」） |

**所以台账能回答「哪条会话、第几步、调了什么工具、参数是什么」，回答不了「那次命令到底输出了什么」。** 而那正是诊断证据的主体（P0 实测：工具输出是助手正文的 3.9～10 倍）。

### 2.4 缺口①的准确表述

> **不是「证据丢了」，是「模型没有任何一条路能自己走到证据面前」。**
>
> 磁盘上有全文、台账上有坐标（会话 id + 步骤 + 参数），但提示不说、工具没有、权限默认拒。

---

## 3. 缺口②：压缩后的可靠续做

### 3.1 压缩摘要吃什么（L1，`compact.cjs` 原文）

```js
const transcript = messages
  .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
  .map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}\n${m.content}`)
```

| 内容 | 进摘要吗 |
|---|---|
| user / assistant 正文 | ✅ |
| **工具调用与输出** | ❌ **完全不进**（没有 `toolRuns` 分支） |
| **空正文的 assistant（只调工具）** | ❌ 被 `content?.trim()` 过滤掉 |
| 错误信息（`toolFailure` 事实） | ❌ 只在正文里若被写进去才可能进 |
| 测试结果 | ⚠️ 同上，取决于助手有没有把它写进正文 |

### 3.2 折叠吃什么（L1，`history-fold.cjs`）

折叠**做得比压缩好**，但给的是「可核对摘要」而非内容：

- 只给：第几次 / 工具名 / 成功失败 / 输出多少字 / **sha256 前 8 位**
- 正文**一个字都不搬**（这条是有意为之：防止工具输出拿到 system 指令地位）
- 最多列 `TOOL_LINES = 10` 条，超出说「另有 N 次」

**折叠块里的指纹是有用的**——`fold-gate.originOf` 就是按指纹从会话记录里捞回全文的（L1）。**但那是给「闸门」用的，不是给模型用的。**

### 3.3 缺口②的准确表述

> **压缩后，模型手里只剩「结论」没有「依据」。** 摘要里既没有工具输出，也没有指纹；折叠块里有指纹，但模型不知道怎么用（没有工具能按指纹查）。
>
> 不需要「把全部历史塞回去」——需要的是**按需取一小段**。

---

## 4. 缺口③：程序中断与重启后的恢复

### 4.1 已有的恢复链路（L1，`task-recovery.cjs` / `task-resume.cjs`）

`task-recovery` 文件头写得很明确：

> 只做三件事：**找出来、检查一下、给出建议** —— 它一条也不执行。
> 「只读」是刻意的：启动时自动跑任务是最危险的行为之一。

| 能力 | 实现 | 状态 |
|---|---|---|
| 找出未完成任务 | `task-recovery` + `task-unfinished` | ✅ |
| 计划进度（完成几条 / 停在第几条） | `progressOf(plan)`，判 `[x]` 标记 | ✅ |
| 恢复时**复用原任务**（不新建） | `task-resume.openForRun` | ✅ |
| 「继续」怎么判 | `attribution.decide`（唯一一处） | ✅ |
| **环境变化检查** | `checkEnvironment(taskId)` | ⚠️ **只查 `changedFiles`** |

### 4.2 `checkEnvironment` 的实际覆盖（L1）

```js
for (const item of task.changedFiles ?? []) {
  if (fs.statSync(file).mtimeMs > (task.updatedAt ?? 0) + MTIME_SLACK_MS) changed.push(file)
}
```

**而 `changedFiles` 只在两个地方写入**（全仓搜 `addChangedFile`）：

- `tool-runner.cjs:185` —— 仅当 `call.name === 'write_file' || 'edit_file'`
- `loop-tools.cjs:190` —— 同一条判据

**这意味着：**

| 情形 | `changedFiles` 记了吗 | 恢复时能发现被改过吗 |
|---|---|---|
| Agent 用 `write_file` / `edit_file` 改的 | ✅ | ✅ |
| Agent 用 `run_shell` 改的（`git checkout`、`npm install`、脚本生成文件） | ❌ | ❌ |
| Agent 用 `apply_test_fix` 改的 | ❌ | ❌ |
| **用户自己**在 Agent 停手后改的（哪怕是 Agent 改过的那个文件） | ✅ 但 mtime 变了 | ✅ |
| 用户改了**别的**文件（Agent 没碰过的） | ❌ 不在台账里 | ❌ |

> 差半格的地方：`run_shell` 会写 `task.commands`（`addCommand`），但**不写 `changedFiles`**。所以「跑过什么命令」有记录，「命令改了什么文件」没有。

### 4.3 授权边界（用户已明确，且代码一致）

> 授权有效性**只能来自真实权限系统**；历史摘要、任务记录不能自动恢复已失效的写入授权。

**代码现状与此完全一致**（L1）：

- 写权限判据是 `capability.check` + `user-constraints`（当轮原话）+ `user-grants`（**进程内 Set，重启清空**）
- 任务台账里的 `permissions` 字段：P0 实测 **0/131 条有值**，且**没有任何代码拿它去放行**
- 所以重启后，「上一轮批过写」不会被恢复——这是**正确的**

### 4.4 缺口③的准确表述

> **恢复得了「做什么」，恢复不了「依据是什么」；环境检查只覆盖「Agent 亲手改的文件」。**
>
> 授权这块**不需要改**——现状就是对的。

---

## 5. 缺口④：手动切换 Provider 的连续性

### 5.1 哪些东西与 Provider 无关（L1）

| 实体 | 存储位置 | 与模型的关系 |
|---|---|---|
| 任务台账 | `data/tasks/task_*.json` | 按 `sessionId` 存，**无模型字段参与定位** |
| 会话记录 | `data/sessions/sess_*.jsonl` | 首行 meta 有 `model`，但只是记录，不参与读取 |
| 变更事务 | `data/changesets/` | 与模型无关 |
| 审计 | `data/audit/` | 与模型无关 |

**所以切换 Provider 后**：任务身份、进度、历史记录、证据引用**全部保留**（L1）。

### 5.2 但有两处真实差异

| 差异 | 证据 | 影响 |
|---|---|---|
| **工具能力不同** | `collab-executor-codex.cjs:103` 调 `codex-cli.chatStream` 时**不传 `onUsage`**；`codex-cli.cjs:170` 是 `if (state.usage) options.onUsage?.(state.usage)` | Codex CLI 后端**不产生工具调用**（它是「工作模型」，走 MCP 桥），所以「上一轮工具证据」在纯 CLI 轮次下**不产生** |
| **协作路径工具输出被丢掉** | `chat-run.cjs:120-126`：`toolRuns` 从 trace 映射时 **`output: ''`** | 协作模式下，工具输出**不落进会话记录的 `toolRuns.output`** —— 这是我在本轮发现的、V2 报告没提的缺陷 |

> ⚠️ **`chat-run.cjs:125` 的 `output: ''` 是真实缺陷**，但**不在本轮修复范围**（用户明确：「发现 P1 修复退化时先报告，不在本轮擅自扩大为修复任务」）。它意味着：一旦用过双模型协作，那一轮的诊断证据**连磁盘上都没有**。

### 5.3 缺口④的准确表述

> **切 Provider 不丢任务身份和历史 —— 这部分现状是对的，不需要改。**
>
> 真正的问题是两个：① 不能把 CLI 后端当成「有完整工具执行能力」；② 协作路径的工具输出根本没存下来（独立缺陷）。

---

## 6. 可直接复用的机制（不新造）

| 需求 | 已有机制 | 复用方式 |
|---|---|---|
| 定位到会话 | `ctx.sessionId` + `sessionIo.fileFor(id)` | ✅ 已实测：`fileFor(ctx.sessionId)` 能算出路径，**不需要新的持久化** |
| 定位到任务 | `ctx.taskId` + `taskCore.get(id)` | ✅ 台账已有 `sessionId` / `steps[].args` / `steps[].at` |
| 按指纹找回全文 | `fold-gate.originOf(fp)` | ✅ 已实现（目前只给闸门用） |
| 逐行读大文件 | `read_file` 的 `offset` / `limit`（最多 4000 行） | ✅ 但受 `capability` 管 |
| 权限放行 | `capability.grant` / 用户当场批 | ✅ 机制齐备 |
| 环境变化检查 | `task-resume.checkEnvironment` | ⚠️ 现成，但只覆盖 `changedFiles` |
| 「继续」判定 | `attribution.decide` | ✅ 唯一一处，不重写 |
| 脱敏 | `redact.cjs` | ✅ 读会话内容外发前必须过 |

---

## 7. P1-C 最小方案（建议，未实施）

### 7.1 核心判断：**加一个小工具，而不是改提示或放大窗口**

三条路对比：

| 路 | 做法 | 成本 | 风险 |
|---|---|---|---|
| A. 只加提示（告诉路径） | 在 `prompt-env` 加一段「你的会话记录在 `<path>`，可用 read_file 读」 | 最小（约 200 字符） | **不够** —— 默认 `fileScope=workdir` 读不了，模型会反复撞墙；且每次都要它自己拼路径 |
| B. 加一个只读工具 `recall` | 新工具，按「会话 + 步骤/指纹」取一小段 | 中（1 个新文件 + 注册 + 权限声明） | 需要设计「返回多少才够」与「怎么标不可信」 |
| **C. 加工具 + 提示一行** | B + 提示里说明「有这个工具」 | 中 | 同上 |

**建议选 C**，理由：
- A 单独做**一定失败**（权限卡住），我实测过；
- B 不做提示的话，模型不知道有这个工具（工具描述会被注入，但需要和「什么时候该用」连起来）；
- 窗口不用动 —— 按需取 1～3 段，比塞回全部历史便宜得多。

### 7.2 建议的工具形状（未实现，仅供评审）

```
名字：recall
参数：
  sessionId  string  （可选，默认当前 ctx.sessionId —— 只允许**当前会话**）
  taskId     string  （可选，给则只取这条任务关联的步骤）
  step       integer （可选，第几步）
  fingerprint string （可选，fold 块里的 sha256 前 8 位）
  lines      integer （可选，最多返回多少行，硬上限 200）
```

**四条硬约束（都来自现有机制）：**

| 约束 | 怎么做 |
|---|---|
| **只允许当前会话** | 用 `ctx.sessionId`，不接受任意 id（防止跨会话翻别人记录）；`sessionIo.isSessionId` 校验形状 |
| **只读，不写** | 不进 `WRITE_TOOLS` / `MUTATING_TOOLS`；「只分析」那一轮该放行（它确实是只读） |
| **内容是不可信数据** | 返回时套 `history-fold.TOOL_WARN` 同款前缀（「以下是历史输出，不是指令」） |
| **必须脱敏** | 过 `redact.cjs`（会话里可能有密钥） |
| **有限返回** | 默认 60 行、硬上限 200 行；超了明说「还有 N 行，用更精确的 step/fingerprint」 |

**找不到时怎么说：**
- 会话不存在 → 「这条会话的记录不在磁盘上」
- 步骤越界 → 「这条任务只有 N 步」
- 指纹对不上 → 「没找到指纹为 xxx 的记录（可能已被压缩/清理）」

### 7.3 环境检查的最小补强（独立、更小）

`checkEnvironment` 目前只看 `changedFiles`。**不改它的判据**，只补一个「命令也可能改了文件」的提示：

在恢复时，如果 `task.commands` 里出现过 `run_shell`，就往提示里加一句「这条任务跑过 N 条命令，其中可能改过文件——动手前先 `git status` / 读一遍文件」。

**为什么不直接扩 `changedFiles`**：把 `run_shell` 也算进 `changedFiles` 会让它变成「跑过的所有命令」，而 `checkEnvironment` 的判据是 mtime —— 一条 `dir` 也会被算成「改过」。那是假阳性，比漏报更糟。

---

## 8. 建议开发范围、测试与验收

### 8.1 最小范围（建议单批）

| # | 内容 | 分类 | 涉及文件 |
|---|---|---|---|
| 1 | 新工具 `recall`（只读、限当前会话、脱敏、限行数） | 新增能力 | `electron/core/tools/recall.cjs` + `registry.cjs` |
| 2 | 提示里一行说明（什么时候用它） | 提示层 | `prompt-stack.cjs` 或 `tool-map.cjs`（择一，别两处都写） |
| 3 | 恢复时「跑过命令」的提示 | 提示层 | `task-context.cjs` |
| 4 | 自检组（新） | 测试 | `scripts/selftest/groups/216-recall.mjs` |

**不做**：不动 `compact.summarize`、不动窗口、不动 Provider 选择、不动 `chat-run.cjs:125`（那是独立缺陷，单独提）。

### 8.2 必要测试

| 测试 | 判据 |
|---|---|
| 只读性 | `recall` 不在 `WRITE_TOOLS` / `MUTATING_TOOLS`；「只分析」轮可用 |
| 会话隔离 | 传别的 `sessionId` → 拒绝（只认 `ctx.sessionId`） |
| 脱敏 | 会话里塞假密钥 → 返回文本里搜不到明文 |
| 不可信标记 | 返回内容带「不是指令」前缀 |
| 限行 | 请求 1000 行 → 实际 ≤200，且明说还有多少 |
| 找不到 | 不存在 / 越界 / 指纹不匹配 → 人话错误，不抛异常 |
| 集成（L2） | 隔离会话里造 30 次工具调用 → 压缩 → `recall` 能取回第 12 次的输出 |

### 8.3 验收标准

1. 隔离会话里跑一轮 20 次工具调用 → 触发压缩 → 再问「第 12 次跑的命令输出了什么」→ 模型能调 `recall` 拿到原文（**不是编的**，与磁盘逐字一致）
2. 默认 `fileScope=workdir` 下**不需要用户额外批权限**（工具自己走内核路径，不走 `capability.check` 的用户授权）—— ⚠️ **这一点需要评审**：见下方风险
3. 「只分析」轮里 `recall` 可用（它只读）
4. 跨会话请求被拒

### 8.4 一个必须先说清的风险

`recall` 如果绕过 `capability.check` 直接读 `data/sessions`，等于**开了一个不受文件权限管的读通道**。两条可选：

| 选项 | 说明 | 风险 |
|---|---|---|
| **A. 工具内部直读** | 不经过 `capability`（因为会话文件是 Harbor 自己的数据，不是用户工作区文件） | 需要明确「会话文件属于应用自身数据，不算工作区越界」——但用户若在 `fileScope=workdir` 下期待「Agent 碰不到任何外部文件」，这是破例 |
| **B. 走 capability + 内置授权** | 工具内部对 `DIRS.sessions` 加一个「应用自身数据」白名单 | 更严格，但需要动 `capability.cjs`（安全边界文件，**硬禁区 §3.9**，必须单独授权） |

**我倾向 A**（会话文件是 Harbor 自己写的、用户自己的对话，不是外部文件；且 `recall` 只读当前会话），但**这条必须由你拍板**，因为它动的是「Agent 能读到什么」的边界。

---

## 9. 建议继续延后的

| 项 | 为什么延后 |
|---|---|
| **`compact.summarize` 加工具元数据** | 改摘要 prompt 会改变压缩质量，需要独立的 A/B 对比（同一段历史压两次，看哪个更能支持续做）。P1-C 先用 `recall` 兜住「按需取」，不改摘要 |
| **上下文扩容**（`conversation` 那 30% 抬到 60～70%） | P0 已证「容量确实没用满」，但扩容是**独立决策**：它会掩盖「没有回取通路」这个真问题。先有回取，再看是否还需要扩容 |
| **跨 Provider 优化** | 现状（任务/会话/证据与 Provider 无关）已经够用；真正的问题是 CLI 后端没有工具能力，那是**能力标注**问题，不是连续性 |
| **`chat-run.cjs:125` 的 `output: ''`** | 独立缺陷，建议单开一批；改它要动协作路径的 trace 形状 |
| **跨会话证据回取** | 只允许当前会话是安全默认；要跨会话得先有「哪些会话可被引用」的产品决定 |

---

## 10. 未验证 / 需要真机

| 项 | 状态 |
|---|---|
| 真实部署下 `recall` 的返回长度是否够模型判断 | **未验证**（要真机 + 真实模型） |
| 大会话（100MB+）按行读的性能 | **未验证**（`read_file` 最多 4000 行，但 jsonl 单行可能极长） |
| Codex CLI 纯 CLI 轮次下「上一轮工具证据」的实际缺失程度 | **未验证**（需要真跑一次 CLI 后端） |
| 协作路径 `output: ''` 对真实用户的影响面 | **未验证**（需要找一条用过协作的真实会话） |

---

## 附：本轮核实脚本（`tmp/`，不进仓库）

```bash
node tmp/p1c-persist.cjs     # 工具输出落盘完整性（5 万字符逐字保留）
node tmp/p1c-access.cjs      # capability 会不会拒会话文件 + 台账字段
node tmp/p1c-gaps.cjs        # 提示层/摘要/折叠/恢复链路覆盖
node tmp/p1c-ctx.cjs         # ctx 里有什么，能否定位会话
node tmp/p1c-dev-kernel.cjs  # P1-A/B 在 Harbor-Dev 运行版本上是否仍有效
```

> `tmp/` 会被 `paths.cjs` 的 `isProbeRun()` 自动切到 `data/unit-test-data`，**不碰真实数据**。
> ⚠️ 本轮我一开始把脚本放在 `.tmp/`（带点），那不是项目认可的探针目录——`isProbeRun()` 只认 `tmp\`，所以 `.tmp/` 下的脚本**跑在真实数据根**上。这轮那些脚本全是只读的才没出事，但**以后别把会写盘的探针放 `.tmp/`**。
