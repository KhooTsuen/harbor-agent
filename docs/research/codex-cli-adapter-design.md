# Codex CLI 模型适配器 · 设计与边界（2026-10-17）

> **这份文件是什么**：codex-cli 后端的**唯一规格** —— 它有什么、没有什么、做不到什么（以及为什么）。
> 改行为先改这里。
> 依据分三类，别混：**[实测]**（本机真跑过）· **[代码]**（指得住源码行）· **[判断]**（我的推断，会被推翻）。
> 用户 2026-10-17 定的边界：内核完整不变 · 旧配置向后兼容 · **不宣称支持 Harbor 原生工具调用** ·
> 能力独立声明 · 不因 CLI 的限制削弱 Harbor 的工具/审批/审计。

---

## 0. 一句话

`codex-cli` 是 Harbor 的**第二种后端种类**：模型推理走**本机已登录的 ChatGPT Codex CLI**
（`codex exec --json`），**不是** HTTP API。本批只做**纯文本对话**；Harbor 的工具/审批/审计/任务恢复**一行不改**。

---

## 1. 定位：与 DeepSeek 并列，不是替换

| | openai（现状） | codex-cli（本批新增） |
|---|---|---|
| 传输 | HTTP / SSE（`llm.cjs`） | 子进程 + JSONL（`codex-cli.cjs`） |
| 凭据 | 凭证库（`credentials.cjs`） | **CLI 自己的登录态**（`~/.codex/`）——Harbor 一个字节都不碰 |
| 工具调用 | 有（`delta.tool_calls`） | **无**（见 §2 事实 2） |
| 默认状态 | `enabled: true` | **`enabled: false`**（不启用就不影响任何人） |
| 选择方式 | `provider.kind` 缺省即 `'openai'` | `provider.kind === 'codex-cli'` |

**最终目标**（用户原话）：DeepSeek 与 ChatGPT 在**同一个 Harbor 内核**里切换，
最大限度保持工具调用与任务执行能力一致 —— 本批**只完成文本层**，工具层见 §6。

---

## 2. 实测事实（本机 codex-cli 0.163.0，2026-10-17 真跑）

`codex exec --json "Reply with exactly one word: OK"` 的真实 JSONL（13 行）：

```jsonl
{"type":"thread.started","thread_id":"01a14606-…"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 2 unrecognized configuration settings…"}}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":14894,"cached_input_tokens":12544,"output_tokens":5,"reasoning_output_tokens":0}}
```

**六条硬事实**（每一条都影响设计，不是细节）：

| # | 事实 | 影响 |
|---|---|---|
| 1 | 正文是 **`item.completed`（整条）**，不是 token delta | 打字机**降级**成「整段一次出现」 |
| 2 | **没有 `tool_call` / `function_call` 事件** | ★★ **拿不到 Harbor 要的 `toolCalls`** —— 这是本批最大的能力限制 |
| 3 | **没有取消 flag** | 取消只能**杀进程树**（Windows 无进程组信号） |
| 4 | **不关 stdin 会挂死**（`Reading additional input from stdin...`） | 必须显式关 stdin，否则永久卡住 |
| 5 | **必须走代理**（本机 `chatgpt.com` 直连不通；`codex-run.cmd` 写明 `127.0.0.1:10808`） | 适配器要带 env，但**不硬编码**代理端口（见 §5.4） |
| 6 | 网络不稳：5 次重连 + WS→HTTPS 回退，**首次响应 >180 秒** | ★ 默认 idle 45s **必超时** → codex 路径单独放宽 |

---

## 3. 契约：与 `llm.chatStream` 同形（这是「复用 Provider 抽象」的落点）

适配器导出 `chatStream(options)`，**签名与返回值与 `electron/core/llm.cjs` 完全一致** [代码]：

```
入参：{ baseUrl, apiKey, chatPath, model, messages, tools, temperature, topP, maxTokens,
        signal, provider, onContent, onReasoning, onToolCalls, onUsage, idleTimeoutMs, … }
返回：{ content, reasoning, toolCalls, usage, finishReason, ttftMs, latencyMs }
```

- `onContent(delta)` —— codex 路径下按 **item 粒度**调（一次一整段）；
- `toolCalls` —— **恒为 `[]`**（不伪装成有工具）；
- `usage` —— 由 `turn.completed.usage` 映射（`input_tokens`→prompt、`output_tokens`→completion）；
- `signal` —— 触发即杀进程树，抛 `AbortError`（与 HTTP 路径同一形状）。

**分流点只有一处** [代码]：`loop-model.cjs` 调 `llm.chatStream({…})` 之前一行 `if`。
`loop.cjs` / 工具系统 / 审批 / 预算 / 恢复**完全不感知**这次分流。

---

## 4. 能力声明：按 `provider.kind` 声明，**不混进模型能力**

用户第 5 条：**传输方式与模型能力必须分开**。落法：

- `provider.kind` = **传输方式**（`'openai'` / `'codex-cli'`）；
- 模型能力仍走既有的 `provider-capabilities.cjs`，但 `forProviders` 对
  `kind === 'codex-cli'` 的供应商**按 kind 覆盖**成一组固定声明（与「按模型名」的预设表分开）。

codex-cli 的声明（[实测] 支撑）：

| 维度 | 值 | 依据 |
|---|---|---|
| `chat` | `true` | 实测拿到 `agent_message.text` |
| `streaming` | **`false`** | 只有 item 级，无 token 级（事实 1） |
| `tool_call` | **`false`** | 无 `tool_call` 事件（事实 2） |
| `vision` / `structured_output` / `search` | `false` | codex CLI 这套 `exec --json` 不提供 |

**三态原则照旧**：说不准的一律 `null`，**不猜**（见 `provider-capabilities.cjs` 文件头）。

---

## 5. 三个技术难点与对策

### 5.1 codex-cli 没有 Key、没有 baseUrl → 会被现有筛选**静默丢掉**

三处筛选都要求「有 Key / 有 baseUrl」[代码]：

- `config.cjs:234` `activeProvider`：`enabled.filter(p => p.enabled && p.baseUrl)` → `find(hasKey)`
- `config.cjs:246` `providerForModel`：`pool = enabled.filter(hasKey)`，pool 空才回落 `enabled`
- `loop-route.cjs:38` `providerForRun`：`if (!configCore.hasKey(provider)) throw`

**后果（必须记住，是个真陷阱）**：DeepSeek 有 Key 时 `pool` 非空 → **用户选了 codex-cli 的模型也找不到它**
→ 落到 `candidates[0]` = DeepSeek —— 表面能用，实际**悄悄换成了另一个模型**
（正是 `config-model.cjs` 文件头记的那个老病）。

**对策**：「需不需要 Key」抽成一个概念（`kind === 'codex-cli'` 不需要），三处**同一口径**放行。
**只加判据，不动原有分支**；不选 codex-cli 时行为逐字段不变。

### 5.2 超时：首次可能 >180 秒

`llm-idle.cjs` 默认 45s 是**给 HTTP 路径**的；codex 路径**不复用它**，自己管
（默认 10 分钟，可配）。**不修改 `llm-idle.cjs`**。

### 5.3 没有 tool_call → 工具怎么办（**诚实处理**）

- **不传 `tools`** 给 codex（它不认）；
- 在 prompt 里**明说**「本次没有 Harbor 工具可用，只能文字回答」——
  让模型**知道**自己没有工具，而不是以为有却调不出来；
- 返回 `toolCalls: []`；
- **Harbor 侧零改动**：模型不产 `toolCalls` → 循环自然不调工具 →
  审批/审计体系照常在（只是这一轮没被触发）。**绝不**因为 CLI 的限制去削弱它们（用户第 4 条）。

### 5.4 代理与 launcher：**不硬编码路径与端口**

`codex` 的绝对路径与代理端口都是**本机特有**的（`E:\SunoTools\npm-global\codex`、
`127.0.0.1:10808`）—— 写死进产品代码等于「只在某台机器上能跑」。

落法：
- `provider.codexPath`（可选）—— 用户可指定自己的 launcher；
- 缺省：按 `codex.cmd` → `codex.exe` → `codex` 顺序在 `PATH` 里解析；
- 代理：**继承父进程环境**（用户自己在 shell 里配的 `HTTPS_PROXY` 生效），
  不进配置文件、不落盘（密钥与代理都可能含机密，硬约束 #4）。

### 5.5 ★ prompt 走 **stdin**，不进命令行（安全与健壮性双赢）

Windows 上没有「把参数数组安全交给 .cmd」的干净方式：`shell: true` 会让
**用户消息里的 `&` `|` `%` 被 cmd 解释**（命令注入面）；不用 shell 又起不了 `.cmd`。

落法（`--help` 支持）：`codex exec <flags> -` —— **`-` 表示 prompt 从 stdin 读**。
于是命令行里**只有常量**（`exec --json -s read-only --skip-git-repo-check -`），
prompt 由我们写进 stdin 并**立即关闭**：

- **零注入面**：用户内容永远不进命令行；
- 顺带解决事实 4（不关 stdin 会挂死）—— 我们主动写完就 EOF。

启动方式：`spawn(ComSpec, ['/d', '/c', '<launcher> <常量参数>'])`，
`stdio: ['pipe','pipe','pipe']`，`cwd` = Harbor 工作目录。

**取消**：Windows 无进程组信号 → `taskkill /pid <pid> /T /F` 杀**整棵树**
（只按我们刚起的那个 pid，**绝不**按映像名 —— 见项目记忆里那条铁律）。

---

## 6. 本批**不做**的事（如实列出，避免下一轮误以为已支持）

| 不做 | 为什么 |
|---|---|
| **Harbor 原生工具调用** | codex CLI 不产 `tool_call`（事实 2）。**不伪装** |
| token 级流式 | codex 只给 item（事实 1）。UI 上如实说明 |
| 多轮 thread 续接 | 每次 `exec` 是新 thread；续接要 `resume <thread_id>`，本批不做 |
| `README`/文档里宣称「完整兼容 OpenAI」 | 会误导 |
| 改工具 / MCP / 审批 / 审计 / 任务恢复 | **用户第 4 条明令** |

**下一阶段的研究项**（用户第 6 条，**本批不实施**）：

| 候选 | 思路 | 我的判断 |
|---|---|---|
| ① ChatGPT 官方 **API** 的 function calling | 走**现有** `llm.cjs`（它就是 OpenAI 兼容的），工具调用天然可用 | **优先** —— 代价小、能力完整、「同一内核切换」最正的路 |
| ② Harbor 做成 **MCP server** 挂给 codex | Harbor 现为 MCP client；做成 server 后 codex 经 MCP 调 Harbor 工具 → 工具执行**回到 Harbor**，审批/审计在里面生效 | 工作量**大**（server + 审批卡接线 + 验证沙箱交互）——先做可行性验证再定 |

---

## 7. 测试标准

| 层 | 覆盖 | 进 CI |
|---|---|---|
| 自检组 **165**（新，纯 Node 不联网） | JSONL 分块（半行/多行/`\r\n`/坏行/超长）· 事件映射 · prompt 拍平 · 取消 · 超时 · 空输出校验 · **Windows launcher 解析** · 配置向后兼容 · 选择链路（DeepSeek 有 Key 时仍选得中 codex-cli） | ✅ |
| 集成（**慢，手动**） | 真跑 `codex exec --json` 一次纯文本（需登录 + 代理） | ❌ 不进 CI |
| 回归 | `npm run verify` —— 现有 provider 与全部既有自检零退步 | ✅ |

**判据口径**（照项目规矩）：不许拿固定毫秒等待当判据；不许把「我读了一遍」当验证。

---

## 8. 涉及文件一览

| 阶段 | 文件 | 动作 |
|---|---|---|
| A | `electron/core/config-normalize-parts.cjs` | 加 `kind`（缺省 `'openai'`）+ `codexPath` |
| A | `electron/core/config-defaults.cjs` | 加 `codex-cli` 预设（`enabled: false`） |
| B | `electron/core/config.cjs` · `electron/core/loop-route.cjs` | 「不需要 Key 的后端也算可用」 |
| C | `electron/core/codex-jsonl.cjs` · `codex-msg.cjs` · `codex-run.cjs` · `codex-cli.cjs` | **新建**（4 个） |
| D | `electron/core/loop-model.cjs` | 分流一行 `if` |
| D | `electron/core/provider-capabilities.cjs` | `forProviders` 按 kind 覆盖 |
| E | `src/types/models.ts` · `src/components/settings/providers/ProviderCard.tsx` | 类型 + 隐藏 Key 字段 |
| F | `scripts/selftest/groups/165-codex-adapter.mjs` + `groups.mjs` | 新自检组 |
