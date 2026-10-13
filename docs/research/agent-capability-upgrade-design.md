# Harbor 智能体能力升级：调研与方案说明

> 状态：**只读调研 + 方案设计**（2026-10-14）。**未实施任何代码**。产出后停下，等确认再分批实施。
>
> 三个方向：① 主动记忆检索（参考 Active Memory）② 长程任务自我纠错（参考 Active Focus）③ 工具搜索与 Token 优化（参考 Tool Search）。
>
> 本文件里的每一处「现状」都标了**文件 + 行号**，可逐条回原码核对；体量数字都是**真跑出来**的（脚本在 `tmp/`，未提交）。

---

## 0. 外部趋势核验结果（2026-10-14 补齐：四个主题都找到了权威出处）

第一轮我只开了你给的链接（大多打不开）；**第二轮我自己用搜索引擎重找了一遍**（`search_web` 工具坏了，见文末；靠 `browse` 开搜索页）。结论：**四个趋势全部找到了可打开的原始出处。**

**四份权威出处（均已读正文）**

| 主题 | 出处 | 关键结论 |
|---|---|---|
| Meta Muse Wonder | `research.meta.ai/blog/muse-wonder`（Meta 官方博客 · 2026-10-12） | **Active Memory** = 跨对话携带你的重要上下文，并**主动取回与当前任务相关的细节**；**Active Focus** = 遇阻时**尝试替代方案、攻克阻塞、适应新信息**，并在需要时请求澄清、在重要动作前先确认。评测含 FocusBench / SWE-Marathon。 |
| GPT-6 Astra · Tool Search | `developers.openai.com/api/docs/guides/tools-tool-search`（OpenAI 官方） | 模型可**延迟加载工具定义**（`defer_loading: true`）；**仅 gpt-5.4 及以上**支持；Astra 模型页确认 `Tool search: Supported`。 |
| 提示缓存 | `developers.openai.com/api/docs/guides/prompt-caching`（OpenAI 官方） | **缓存包含「工具定义」**；「缓存复用要求**整个渲染前缀**匹配」；官方明确建议「**工具定义保持稳定 / 只做追加更新（append-only）**」。 |
| Claude Opus 5.5 | `arena.ai/leaderboard/agent`（Agent Arena · 2026-10-13 · 250 万会话） | **Opus 5.5 (Max) 总榜第一**（17.89%）；且「用户确认任务完成」（20.48%）、「好评率」（38.37%）**两项信号均第一**。 |
| DeepSeek V4.1 Flash | `api-docs.deepseek.com/news/news260910`（官方） | 2026-09-10 发布；552B MoE（8B/16B 激活）；模型名 `deepseek-flash`；KV cache 仅前代 1/4 HBM、1/8 SSD。 |

**你给的那批链接为什么大多打不开**（保留记录）：`ifeng` 那条 404、`benchlm.ai` 的两个**具体榜单页**不存在（站点本身真实）、`orcarouter.ai` 那篇 `post_not_found`、`learn.microsoft.com` 404、`research.meta.ai` 你给的 slug（`muse-wonder-frontier-model`）是空的（正确是 `muse-wonder`）、`code.claude.com` 无正文、`androidauthority` 撞 Cloudflare 验证。**即：链接多半写错或过期了，但趋势本身是真的。**

**对三个方案的影响**

- **方向一** 与 Meta **Active Memory** 的官方定义**逐字对上** —— 它说的正是「**主动取回**与当前任务相关的细节」，不只是「存着」。
- **方向二** 与 **Active Focus** 的官方定义**逐字对上** —— 「尝试替代方案、攻克阻塞」；官方还额外点了「需要时请求澄清、重要动作前先确认」（Harbor 已有 `ask_user` + 确认机制，**已覆盖**）。
- **方向三**：⚠️ **官方缓存文档把上一版那条「未知风险」坐实成了结论** —— 见 §3.3 方案 B 的更新。

> 附带一句：`search_web` 工具当前**有个 bug**（URL 拼成 `www.bing.com<query>`，缺 `?q=`）→ 每次调用必失败。所以本轮靠 `browse` 开搜索页才搜到东西。这个 bug 记在 §8 遗留里。

---

## 1. 方向一：主动记忆检索（参考 Active Memory）

### 1.1 现状核对（文件 + 行号）

**记忆的「注入」链路**（每轮发生）：

| 环节 | 位置 | 逻辑 |
|---|---|---|
| 组装 | `electron/core/loop-prompt.cjs:121-136` | 取**最后一条用户消息**当查询词，调 `memory.buildPromptSection({ query, projectId, sessionId })` |
| 检索 | `electron/core/memory-recall.cjs:58-100` `retrieve()` | 不走向量：**关键词重合 + 范围 + 类型 + 重要度 + 新鲜度**打分（权重表唯一源在 `memory-explain.cjs`） |
| 预算 | `memory-recall.cjs:27-33, 78` | 每轮最多注入 `config.memory.injectLimit`（默认 **12**）条 |
| 渲染 | `memory-recall.cjs:110-165` `buildPromptSection()` | 产出 `## 关于用户和这个项目（长期记忆）` + 逐条 `- [类型] 内容`；条数超预算时尾部加一句「另外还有 N 条没进上下文。需要更多细节时，调 `memory_search` 搜关键词取全文。」（`:156-159`） |
| 放进哪一层 | `prompt-stack.cjs:168-209` `ORDER` | `relevantMemory` 层 —— 在**易变区**（稳定区止于 `safety`；`relevantMemory` 是易变区第一条） |

**记忆的「按需取全文」链路**（模型主动触发）：

- 工具 `electron/core/tools/memory_search.cjs`（83 行，只读）；注册于 `tools/registry.cjs:20, 54`。
- 触发权**完全在模型手里**：系统提示只给了一句「需要更多细节时调它」（`memory-recall.cjs:158`）。

**关键判断：注入本身已经是「自动」的（每轮按查询词挑 ≤12 条注入）。** 缺的不是「自动注入」，而是**「当用户这句话是在回忆时，鼓励模型去搜更全的那部分」**。这正好对上你说的「模型本应检索却凭印象回答」。

### 1.2 触发时机：现在有没有「自动判断」？

**没有。** 现有最近的邻居是：

- `memory-recall.cjs:87` —— 条数 ≤ 预算时直接全给，只有超预算才打分排序；
- `loop-prompt.cjs:124` —— 用最后一条用户消息当查询词（这是唯一的「自动」，但只是选记忆，不决定「要不要提示去搜」）。

### 1.3 方案

**方案 A（推荐）：易变区追加「极短提示」+ 纯函数判定**

- 在**已有**的 `relevantMemory` 层内容尾部（易变区）追加一行，例如：
  > `（这条像是在回忆之前的事 —— 如果不确定，先调 memory_search 搜关键词确认，别凭印象答。）`
- 触发条件由一个**纯函数**判定（新文件 `electron/core/memory-trigger.cjs`，纯正则/词表，**不调 LLM**）：
  - **回溯词**：`之前 / 上次 / 上次说 / 记得 / 说过 / 约定 / 我们说好 / 以前 / 早先 / 上次那个 / 你还记得`；
  - **保守起见**：句子长度、是否疑问句等再加一道过滤，避免每轮都注入。
- **位置**：留在 `relevantMemory`（易变区）→ **不打掉稳定前缀缓存**；不需要新增层、不动 `ORDER`、不动 `context-diag.STABLE`。

**方案 B：新增一层 `recallHint`（易变区）**

- 好处：语义独立、好开关；
- 代价：要动 `ORDER` + `buildLayers` + `loop-prompt` 接线 + `context-diag` + 提示内容回归自检（`06-prompt-state.mjs` 的 `WIRED_LAYERS`）+ 提示词版本 —— **6 处**，且和方案 A 的最终效果几乎一样。

### 1.4 纯函数 vs 模型自己决定？

**推荐纯函数**，三条理由（都能指到本仓库的既有约定）：

1. 本仓库的提示装配路径**从不额外调 LLM**（除了收尾复核 `reviewWithEvents`，它不参与装配）；
2. 已有同类先例：`task-steering.isContinueIntent`（正则认「继续」）、`mode-router`（分类 persona 档）、`clarify-turn`（认「你先问我」）—— 全是**纯函数 + 单测钉住**；
3. 模型「自己决定要不要搜」正是当前的失效点（凭印象答）—— 让同一个判断再回到模型，等于没改。

**风险**：正则词表**必然有漏判/误判**。误判（多搜一次）= 一次只读工具调用，便宜；漏判 = 维持现状。可接受。

### 1.5 体量评估

- 追加一行 ≈ **30–45 字符 ≈ 10–15 token**，且**只在命中触发词那轮**注入。占稳定区比例 ≈ 0（它在易变区）。
- 相对参考：整段系统提示稳定区实测 **13574 字 ≈ 4525 token**（见 §3.4）。这条提示是**零头的零头**。

---

## 2. 方向二：长程任务自我纠错（参考 Active Focus）

### 2.1 现状核对（文件 + 行号）

Harbor 现在有**四套**「顶回 / 重规划」机制，分别盯不同的事：

| 机制 | 文件 | 判据（结构化事实） | 动作 |
|---|---|---|---|
| **重复执行检测**（AG-041） | `loop-guard.cjs:70-102` `detect()` | 最近 12 次调用的**签名**（工具名 + 归一化参数）：同一调用连续 ≥3 次，或周期 2/3 重复 ≥3 遍 | `nudgeMessage` 让模型换法子；`loop.cjs:139-150` 顶 `LOOP_NUDGE_LIMIT=2` 次后**交给用户**（`paused`） |
| **完成门禁**（计划） | `task-steering.cjs:81-118` `shouldContinue()` | `task.plan` 勾选进度 + 停滞快照 | `MAX_BLOCKS=3` 次内顶回继续 |
| **验证门禁** | `task-steering.cjs:138-204` `shouldVerify()` | `task.steps` 里「最后一次写之后有没有 `run_shell`」 | 顶回验证一次 |
| **严格模式**（CE-008） | `task-strict.cjs:112-151` `strictGate()` / `:65-72` `strictBacklog()` | `task.steps` 结构化事件：「最后一次 `run_shell` 之后累计几次写」、计划勾选数 | 每累计 **3** 次写、或勾了计划没验证 → 顶回验证 |

**结构性事实落在哪**（方向二的原料）：

- `electron/core/task-notes.cjs:65-85` `addStep()` → `task.steps[]`，每条 `{ at, tool, ok, ms, summary, args, action }`，**`ok` 是布尔**（`ok:false` = 这次工具失败）；**只留最近 200 步**（`:81`）。
- `electron/core/loop-tools.cjs:107-128` —— 每次工具跑完记 `addStep({tool, ok, ...})`；失败还过 `errors.classifyToolOutput` 得到 `{kind, hint, strategy}`（`:157`）。
- `electron/core/loop-tools.cjs:191-196` —— 一轮里有失败时，追加 `buildFailureNote`（「已成功 X 步、失败 Y 步」）。
- `electron/core/task-outcome.cjs` —— 从 `task.commands` 读测试命令的退出码。

**关键缺口**：**没有任何机制在「同一任务连续失败 N 次」时触发。**
- `loop-guard` 盯的是「**一模一样的调用**」，不是「失败」—— 模型用 5 种**不同**办法各失败一次，它**完全不动**；
- `loop-tools.cjs:91-105` 的自动重试**只对只读工具**（`errors.canAutoRecover`），且是「同一调用重试」，也不是「连续失败就换方案」。

→ 所以你说的「连续失败时只会被反复顶回 / 陷入死循环」，**方向对**，且**落点清楚**。

### 2.2 方案

**方案 A（推荐）：内核「连续失败」门禁 + Prompt 软约束（不新增工具）**

- 新增纯函数（新文件 `electron/core/failure-streak.cjs`）：
  ```
  consecutiveFailures(task) → { count, lastTool, lastHint }
  ```
  只读 `task.steps`，数**尾部连续的 `ok:false`**（可按「同一 task」计；跨工具也算 —— 「连续失败」本身就是信号）。
- 在 `loop.cjs` 的**轮次边界**（`:138-150`，紧挨 `loopGuard.detect`）接入：连续失败达到阈值（建议 **2**）→ 往 `messages` 推一条：
  > 「这个任务已经连续失败 N 次了。别再照原路子试。**给出 2–3 个替代方案**（换工具 / 换顺序 / 缩小范围 / 直接问用户），用 ```plan 块写清楚，再问我或自己挑一个试。」
- **刹车**（照抄现有先例）：同一条失败期只推一次（快照去重）、每条失败期最多推 N 次（对照 `MAX_BLOCKS`/`MAX_PUSHES`）、非 `running` 不推。
- **和现有机制的分工**（必须说清，否则会互相打架）：
  - `loop-guard`：**相同的调用**在转圈 → 换法子；
  - `failure-streak`：**不同的尝试**在失败 → 生成替代方案；
  - 两者**判据不同、可共存**，但要保证**同一轮不重复推**（用一个共用的「本轮已推」标志）。

**方案 B：新增 `alternative_plan` 工具**

- 不推荐。理由：① 新增工具 → `toApiSchema` 体量再涨（见 §3），且要走「新工具要不要进 `WRITE_TOOLS`/审计/权限」一套；② 它要做的（让模型给出 2–3 个替代方案）用**现有 ```plan 块**就能表达，不需要新工具；③ 硬约束 9「一处真相源」——计划格式已经有唯一落点（`task-hint.PLAN_FORMAT`），再加一个 `alternative_plan` 会分裂。

**推荐：方案 A。** Prompt 层只加一句软约束（说明「连续失败要换方案」），**硬判据全在内核结构化事实上**（`task.steps[].ok`），**绝不解析模型自然语言** —— 与 `task-strict.cjs` 的口径一致。

### 2.3 体量评估

- 内核侧：判据是纯函数，零额外 token（除非触发，触发时推一条 ~120 字 ≈ 40 token）。
- Prompt 侧软约束：一行 ≈ 40 字 ≈ 13 token，放稳定区（`workRules` 或 `toolPolicy` 内），每个会话一次性。

---

## 3. 方向三：工具搜索与 Token 优化（参考 Tool Search）

### 3.1 现状核对（文件 + 行号）

| 环节 | 位置 | 逻辑 |
|---|---|---|
| 组装 schema | `electron/core/tools/registry.cjs:159-176` `toApiSchema()` | 返回 `[...本地工具, ...MCP 工具]`，每个 `{type:'function', function:{name, description, parameters}}` |
| 本地工具集 | `registry.cjs:39-59` `ALL`（19 个）+ `registry.cjs:99-104` `allTools()`（含本地插件） | 动态：插件是启动时扫一次 |
| MCP 工具 | `registry.cjs:166-173` | `mcp.listTools()` —— 运行时才连上，数量可变 |
| **发送** | `electron/core/loop.cjs:177` | **每次调模型都发全量** `tools: tools.toApiSchema()` |
| 提示里的摘要 | `electron/core/tool-map.cjs`（139 行，上一轮新增） | 稳定区 `tools` 层：按场景分组的「工具箱地图」 |

### 3.2 实测体量（真跑）

```
工具数 19   总 JSON 字符 8579（≈ 2860 token，按 3 字/token 粗估）
逐个体量（JSON 字符 / 描述字符）：
 1312 / 365  ask_user
  660 /  81  remember
  651 / 215  generate_image
  533 / 157  search_web
  490 / 156  browse
  484 / 175  browse_type
  433 / 133  browse_click
  402 / 128  mark_step_done
  394 / 136  memory_search
  375 /  75  edit_file
  361 /  81  list_dir
  349 /  70  run_shell
  345 / 134  spawn_subagent
  344 /  65  read_file
  318 / 112  browse_nav
  310 /  80  download
  287 /  64  write_file
  270 / 166  browse_elements
  261 / 159  browse_ax
```

**两个一眼可见的事实**：
1. **`ask_user` 一个就占 1312 字（总量 15%）** —— 它的描述（365 字）+ 参数说明最长。
2. **`browse_*` 家族 6 个合计 ≈ 2100 字**（占 24%），且功能高度相关。
3. 整个请求体 ≈ 系统提示（稳定区 13574 字）+ tools（8579 字）≈ **22k 字 ≈ 7.4k token**；**tools 占约 39%**。

### 3.3 方案

**方案 A（推荐，低风险）：先「瘦身 schema」，不改集合**

- 把 **描述冗长的少数工具**（`ask_user` / `generate_image` / `search_web` / `browse_*`）的 `description` 压到「一句话用途 + 一句关键约束」，详细用法**移进工具箱地图**（已经在提示里了）。
- **不改工具集合、不改参数** → **缓存前缀不变**（集合与顺序都不动），只是每个工具的文本变短。
- 预期收益：8579 → 估 **5000~6000 字**（省 ~1000–1200 token/轮，约 tools 的 25–30%）。
- 风险：**低**（纯文案）；但描述是模型选工具的依据，压太狠会掉选对率——需要真机 A/B（见 §6 验收）。

**方案 B（不推荐现在做）：客户端「工具按需加载」**

- 形态：默认只发「工具箱地图 + 一个 `load_tools` 元工具」，模型要用某类工具时先调 `load_tools` 拿 schema，之后那类工具的 schema 才进 `tools`。
- **三个硬伤**：
  1. ⚠️ **必须改请求的 `tools` 数组**（每轮不同）→ **打掉前缀缓存 —— 已由官方文档坐实，不再是猜测**。OpenAI 官方 `prompt-caching` 页写明：**缓存包含「工具定义」**，且「**缓存复用要求整个渲染前缀（rendered prefix）匹配**」，并明确建议「**工具定义保持稳定 / 只做追加更新（append-only）**」。也就是说，**每轮发不同的 `tools` = 每轮前缀不匹配 = 缓存全废**（命中价约为未命中的 1/10）。Harbor 走的又是**任意 OpenAI 兼容端点**（DeepSeek 等），各家策略不同，只会更差。这正是你要求「不许打掉前缀缓存」的红线方向。
  2. **鸡生蛋**：模型不能调用「不在列表里的工具」。要它调 `load_tools`，这个工具就得**永远在列表里** —— 于是每轮仍要发一份「加载器」schema，机制复杂度上去了。
  3. **官方 `tool_search` 是服务端原生能力**（需 **gpt-5.4+**）。它能「省 token 又不打缓存」的诀窍是：**新加载的工具由服务端注入到「上下文末尾」**（官方原文：`they are injected at the end of the context window`），从而**让前缀保持不动**。这个「在末尾追加」的动作在客户端**做不到** —— 客户端只能改请求开头的 `tools` 数组，而那正好是前缀。Harbor 用的是用户自选模型（很可能是 DeepSeek 等），**也拿不到原生 tool_search**。
- 结论：**B 建议「记录为候选，暂不做」**，除非将来 Harbor 锁定到支持原生 tool_search 的端点。

**方案 C（可选，折中）**：**只在 MCP 工具很多时**做懒加载 —— 内置 19 个不动（缓存稳定），只对「运行时才连上、数量不定的 MCP 工具」按需注入。这条**不碰内置工具的缓存前缀**，风险比 B 小；但收益取决于用户装了多少 MCP。

### 3.4 token 与预算对照（引用 §3.2 + 上一轮实测）

- 稳定区 **13574 字 ≈ 4525 token**（其中 `projectInstructions`=AGENT.md+rules 就 7705 字）；易变区 64 字；动态 26 字。
- **系统提示不参与 `context-builder` 裁剪**（只裁 memory/project/task/conversation）→ 加进稳定区的每个字都是**每轮固定成本，无兜底**。
- tools schema（8579 字）**同样每轮全量**。

---

## 4. 优先级排序（收益 / 成本）

| 排序 | 方向 | 收益 | 成本（改动面） | 风险 | 建议 |
|---|---|---|---|---|---|
| **P1** | **方向一 · 记忆检索提示** | 治「凭印象答」（可观测：该搜不搜） | **1 新文件 + 2 处接线**（`memory-recall` 拼一行、提示词版本 +1） | **低**（易变区，缓存无影响；正则可回退） | **先做** |
| **P2** | **方向二 · 连续失败→替代方案** | 治「死循环 / 反复顶回」 | **1 新文件 + 2 处接线**（`loop.cjs` 轮次边界、workRules 一句） | **中**（新门禁，要和 loop-guard / strict 分工清楚，刹车要齐） | **其次** |
| **P3** | **方向三 · schema 瘦身（方案 A）** | 省 ~1000–1200 token/轮 | 改若干工具的 `description`（**源码文案**，不是结构） | **低–中**（可能掉选对率，要真机对照） | **第三** |
| **❌** | 方向三 · 客户端按需加载（方案 B） | 理论省更多 | 大 + **缓存红线未知** | **高** | **暂不做** |

**推荐实施顺序：P1 → P2 → P3（方案 A）；方向三方案 B 只记录、不实施。**

理由：P1/P2 都是**内核结构化/纯函数**改动、零点额外依赖、且解决的是**当前可观测的真实痛点**；P3 是纯文案优化、需要真机 A/B 才能确认「省 token 但没掉准确率」；方案 B 撞缓存红线且拿不到原生能力，收益/风险比最差。

---

## 5. 边界红线逐条核对

| 红线 | 方向一 | 方向二 | 方向三(A) | 方向三(B) |
|---|---|---|---|---|
| 不引入 npm 依赖 / 向量库 | ✅ 纯正则 | ✅ 纯函数 | ✅ 纯文案 | ✅ 无依赖，但**复杂度高** |
| 不改 Runtime / IPC / 权限 / 事件契约 / 数据结构 | ✅ 只拼提示文本 | ✅ **只读** `task.steps`，不新增字段、不落盘 | ✅ 只改描述字符串 | ⚠️ 改请求 `tools` 数组（协议层） |
| 不破坏 Phase 6（persona / 严格模式 / 打卡） | ✅ 新增内容在易变区，与 persona 同区不同层 | ✅ 与 strict 门禁**并列**、判据不同、共用刹车思路 | ✅ 无关 | ✅ 无关 |
| 不破坏 Phase 7（useSmoothText / StableBlocks / useAutoScroll） | ✅ 纯内核 | ✅ 纯内核 | ✅ 纯内核 | ✅ 无关 |
| 不破坏 E2（`safe-write.writeAtomic` / `keepCorruptCopy`） | ✅ 不写盘 | ✅ **不写盘**（判据只读台账，不新增落盘） | ✅ 无关 | ✅ 无关 |
| Prompt 改动放稳定区或与 Persona 同层、不打缓存 | ✅ **明确放易变区**（`relevantMemory`）更安全 | ⚠️ 软约束那行放稳定区（`workRules`/`toolPolicy`）→ **会改稳定前缀一次**（一次性，见下） | ✅ 稳定区文案变短 → 同样一次性失效 | ❌ **每轮都可能变 `tools`**，撞红线 |

**两条必须提前讲清的「一次性缓存代价」**（不是违反红线，是诚实预告）：
- 方向二/三只要改了**稳定区文本**（`workRules` 加一句、工具描述变短），**第一个会话的首轮前缀缓存会失效一次**（之后重新稳定）。这是「改提示文案」的固有代价，`promptVersion` 会从 `/8` 升到 `/9`（`prompt-stack.cjs:150`）。
- 方向一若把提示放**易变区**，则**完全不碰**稳定前缀 → 连这一次失效都没有。

---

## 6. 验收方式（怎么证明生效）

**方向一**
- 主测：问「**我们之前是不是约定过 X？**」（含回溯词）→ 期望模型**先调 `memory_search`** 再答，而不是直接凭印象。
- 负向：问一个**没有回溯词**的新问题（如「写个快排」）→ 期望**不**注入那条提示、**不**多搜。
- 可自动断言：`memory-trigger.cjs` 的纯函数单测（词表命中/不命中）+ 一句「提示只在命中时出现在最终系统提示里」（挂在 `93-machine-prompt.mjs` 或 `06-prompt-state.mjs`）。

**方向二**
- 可自动断言：`failure-streak.cjs` 纯函数单测 —— 构造 `task.steps`（连续 `ok:false` × N）→ 断言计数与触发阈值；断言**不解析自然语言**（只读 `steps[].ok`）。
- 行为：造一个必然连续失败的场景（如让模型改一个不存在的文件多次）→ 期望第 2 次失败后出现「给出 2–3 个替代方案」的提示，且**不被 loop-guard 重复推**。

**方向三（A）**
- 断言：`toApiSchema()` 的**工具名集合与顺序不变**（只有文本变短）—— 这条是防「瘦身时误删工具」的保险；
- **改前/改后 token 数字**（跑 §3.2 那段脚本，对比 8579 → 目标值）；
- **真机 A/B**：一组「选工具」用例（该用 browse 还是 search_web、该不该用 ask_user），改前改后各跑一遍，确认**选对率不掉**。没这个对照，不能算「优化成功」。

---

## 7. 待你拍板的决策点

1. **方向一提示放哪？** —— A：追加进现有 `relevantMemory` 层（易变区、不碰缓存，改动最小）；B：新增 `recallHint` 层（语义清晰但要动 ORDER 等 6 处）。
2. **方向一触发词表**：用我给的一版（`之前/上次/记得/说过/约定/以前/早先/你还记得`…）够不够？要不要加「实体词」（如命中记忆里的项目名/用户名）？后者更准但更复杂。
3. **方向二阈值**：连续失败 **2** 次就提示替代方案，还是 **3** 次？（2 更早止损、3 更少打扰）
4. **方向二要不要落到工具**：我推荐**不新增工具**（用现有 ```plan 块表达替代方案）。你若有别的想法（比如希望替代方案能一键「试试方案 B」），说一声。
5. **方向三做到哪一步**：只做 A（瘦身 schema）？还是把 B（按需加载）也列为「将来锁定原生 tool_search 时再说」的候选？
6. **实施粒度**：三项分开提交（每项一个 commit + 各自 verify），还是一次做完再提交？

---

## 8. 本轮产出与遗留

**产出**：本文件（`docs/research/agent-capability-upgrade-design.md`）。

**遗留（诚实列出）**：
- **外部趋势**：✅ **已补齐** —— 四个主题都找到了权威出处并读了正文（Meta 官方博客 / OpenAI 两份官方文档 / Agent Arena 榜 / DeepSeek 官方）。见 §0。
- **缓存行为**：✅ **已坐实** —— OpenAI 官方 `prompt-caching` 页写明「工具定义在缓存前缀里，且缓存复用要求整个渲染前缀匹配」→ 方案 B 不再是「待验证的假设」，而是**确定的**（见 §3.3）。
- **`search_web` 工具有 bug**（URL 缺 `?q=`，必失败）—— 本轮只能改用 `browse` 开搜索页才搜到东西；建议单独修（**它是内核工具，改它要按硬禁区走一遍**）。
- **未实施任何代码**；未改 `promptVersion`；未动 `tmp/` 之外的任何文件。
