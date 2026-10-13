# 工具箱地图（Toolbox Map）设计与实施方案

> **定位：只读调研 + 方案设计 · 2026-10-13 · 阶段已实施（B 方案）。**
> §1~§4 是**方案**的原文（写完时未实施）；**实际落地**见文末 §6「落地记录」。
> 本轮先只做设计，用户拍板后才实施 —— 拍板结果与实施报告见 §6。
> 依据：`tools/registry.cjs`、`loop-prompt.cjs`、`prompt-stack.cjs`、`context-diag.cjs`、
> `loop.cjs`、`context-builder.cjs` 的**实际代码与实测输出**（数字见正文），不是推测。
> 本轮实测用的脚本都在 `tmp/`（**未提交**）—— 本文所有数字都已写进正文，图自己重跑一遍就照各节标注的命令做。
> 边界（用户本轮明确红线）：不改工具 schema / 不碰 Runtime / IPC / 数据结构 / 权限模型 /
> 不破坏 Phase 6 的 Persona 路由与打卡机制。

---

## 0. 一页速览

| 项 | 结论 |
|---|---|
| **现状** | 已经有「工具清单」层：`## Tools`，由 `toolsSection()` 生成，**只取每个描述的第一句**，实测 **893 字 / 298 token**，位于**稳定区**。 |
| **最关键的事实** | 它**已经**是一份「一行一个工具」的清单 —— 所以「新增一层地图」= **同一个清单写两份**，会漂（硬约束 9）。 |
| **实测发现的真问题** | `t.description.split('。')[0]` 把 **14/19** 个工具的「**何时该用**」那半句切掉了（例：`list_dir` 丢了「不确定项目结构时先看这里」；`memory_search` 丢了「想确认某约定是否被记过，用它按关键词搜」）。清单还**没有分组**，`browse_*` 独占 6/19（32%）。 |
| **所以推荐** | **方案 B：把现有 `tools` 层改造成「按场景分组的地图」**（同 19 个工具、同每工具一行，但补回导向 + 分组）。**不新增层**。 |
| **改动面** | B：**3 个代码文件** + CHANGELOG。A（真新增一层）：**5 个代码文件**，且要写一条「两份清单不许漂」的自检。 |
| **token** | B：**净增约 0**（新写法 ≈ 现在这 893 字）。A：**净增 ≈ +900 字 ≈ +300 token**（占稳定区 6.6%）。 |
| **缓存** | 稳定区内容变了 → **一次性**前缀失效（每个会话首轮一次），之后照旧命中；`promptVersion` 必须 `/7 → /8`。 |
| **回滚** | B：还原 `toolsSection()` 一个函数 + 版本号。A：删一层 + 5 处同步点。 |

---

## 1. 现状核对

### 1.1 完整工具清单（`registry.ALL`，实测 19 个）

`node tmp/_dump_tools.mjs` 的真实输出（`WRITE` = 在 `WRITE_TOOLS` 里，只读档会被拦）：

| # | 工具 | 参数（`*` = 必填） | 档位 |
|---|---|---|---|
| 1 | `read_file` | `*path` `offset` `limit` | read |
| 2 | `write_file` | `*path` `*content` | WRITE·FILEW |
| 3 | `edit_file` | `*path` `*oldText` `*newText` | WRITE·FILEW |
| 4 | `list_dir` | `path` `depth` `all` | read |
| 5 | `run_shell` | `*command` `cwd` `timeout` | WRITE |
| 6 | `search_web` | `*query` `maxResults` `fresh` | read |
| 7 | `browse` | `*url` `sameTab` | WRITE |
| 8 | `browse_elements` | （无） | WRITE |
| 9 | `browse_click` | `*index` `force` | WRITE |
| 10 | `browse_type` | `*index` `*text` `pressEnter` | WRITE |
| 11 | `browse_nav` | `*direction` | WRITE |
| 12 | `browse_ax` | （无） | WRITE |
| 13 | `generate_image` | `prompt` `size` `taskId` `wait` | WRITE |
| 14 | `remember` | `*content` `type` `scope` | WRITE |
| 15 | `memory_search` | `*query` `limit` | read |
| 16 | `ask_user` | `questions` `gate` `question` | read |
| 17 | `download` | `*url` `*path` | WRITE·FILEW |
| 18 | `spawn_subagent` | `*task` | read |
| 19 | `mark_step_done` | `*step_index` `summary` | read |

**体积实测**：描述合计 **2552 字**；参数 JSON 合计 **5024 字**；
`toApiSchema()` 整体 **9188 字**（19 个工具，形状 `{type, function:{name, description, parameters}}`）。
完整描述原文见 §5 附录（本文定稿时由 `tmp/_dump_tools.mjs` 生成，不手抄）。

### 1.2 已经有「工具清单」层 —— 它长什么样

**生成处**：`electron/core/loop-prompt.cjs:84-100`

```js
function toolsSection() {
  const builtin = tools.ALL.map((t) => `- \`${t.name}\`：${t.description.split('。')[0]}。`)
  /* + 本地插件段（plugins.pluginList()）+ MCP 服务器段（mcpHint.live()） */
}
```

**长什么样**（实测渲染，893 字）：

```
## Tools
- `read_file`：读一个文本文件的内容，返回带行号的结果。
- `write_file`：写入整个文件（存在就覆盖，不存在就新建，父目录会自动建）。
- `edit_file`：把文件里的一小段文本替换成另一段。
- `list_dir`：列出目录内容。
…
- `mark_step_done`：声明「计划里的第 N 步做完了」，让计划卡上那一步亮起勾选。
```

**由谁生成**：`loop-prompt.cjs` 的 `buildPromptContext()` 把 `tools: toolsSection()` 交给
`prompt-stack.build()`（`loop-prompt.cjs:230`），`toSystemMessage()` 拼成 `## Tools` 那一层。

**模型真读到没有 —— 是，有两条独立证据**：
1. 自检 `scripts/selftest/groups/93-machine-prompt.mjs:122` 从**真实装配结果**（调真的
   `buildPromptContext`）里断言 `` `read_file` `` 与 `` `run_shell` `` 出现在最终系统提示里。
2. **另一条通道**：`electron/core/loop.cjs:177` 每轮把 `tools.toApiSchema()`（9188 字 JSON）
   作为 API 的 `tools` 参数发出去 —— 也就是说，模型手里**同时**有「一行式清单」和
   「完整描述 + 参数 schema」。

### 1.3 工具层在 ORDER 里的位置：**稳定区**

`prompt-stack.cjs:164-205` 的 ORDER 共 18 层，`tools` 在**第 9 位**（下标 8）：

```
稳定区：coreIdentity · environment · machineEnv · conversationPolicy · personaGuide ·
        userPreferences · projectInstructions · skills · **tools** · toolPolicy ·
        browserGuide · workRules · safety
易变区：relevantMemory · taskState · conversationState · retrievedContext · currentTime
```

`context-diag.cjs:22-39` 的 `STABLE` 清单里也有 `tools` —— **两处必须一致**，且自检
`93-machine-prompt.mjs:97-100` 钉着「STABLE ⊆ ORDER」。

### 1.4 实测：这份清单**丢了什么**（`node tmp/_analyze_tools_text.mjs`）

判据：完整描述里有「何时该用」的线索词（适合/当…时/先/不确定/不要/优先…），而第一句里没有。

```
工具总数 19；browse_* 占 6 行（32%）
「完整描述里有何时该用、第一句里没有」的工具数：14 / 19
```

被切掉的具体导向（举例，原文）：

| 工具 | 丢掉的这半句 |
|---|---|
| `list_dir` | 不确定项目结构时先看这里。 |
| `read_file` | 读之前不确定路径时先用 list_dir。 |
| `write_file` | 小改动请优先用 edit_file，只有新建文件或整体重写时才用这个。 |
| `search_web` | 当用户问到你的知识里没有、或可能已经变了的东西时**先用它**。 |
| `memory_search` | 系统提示里只注入了最相关的那几条；**想确认某约定/偏好是否被记录过**时用它搜。 |
| `remember` | 适合记：用户习惯、项目约定、明确说过的偏好。不适合记：临时细节。 |
| `browse_ax` | 比 browse_elements 更懂语义，适合读菜单、表单、表格。 |
| `spawn_subagent` | 适合「要读很多份东西、但父任务只需要结论」的活。 |

**这就是「模型被动」的一个可解释机制假设**：提示里的清单只说了**每个工具是什么**，
没说**什么时候该掏它**；而 19 行平铺、其中 6 行是浏览类，也没有「先看哪一组」的层次。
（★ 这是**假设**，不是结论 —— 它未经真机对照实验验证，验收方式见 §4。）

### 1.5 token 与预算（实测，本仓库真实 AGENT.md）

`node tmp/_measure_real.mjs`（token 用 `context-diag.estTokens` 同口径 = chars/3）：

| 层 | 区 | chars | ~token |
|---|---|---|---|
| coreIdentity | stable | 41 | 14 |
| environment | stable | 71 | 24 |
| machineEnv | stable | 328 | 110 |
| conversationPolicy | stable | 170 | 57 |
| personaGuide | stable | 122 | 41 |
| userPreferences | stable | 29 | 10 |
| **projectInstructions** | stable | **7705** | **2569** |
| skills | stable | 17 | 6 |
| **tools** | stable | **893** | **298** |
| toolPolicy | stable | 93 | 31 |
| browserGuide | stable | 1240 | 414 |
| workRules | stable | 2613 | 871 |
| safety | stable | 252 | 84 |
| **稳定区合计** | | **13574** | **≈4525** |
| 低频区（记忆/任务/会话状态） | low | 64 | 22 |
| 动态区（检索/当前时间） | dynamic | 26 | 9 |
| **系统提示合计** | | **13664** | **≈4555** |

**关键预算事实**：`context-builder.cjs:157-166` 的 `assemble()` 只裁
`memory / project / task / conversation` 四层 —— **系统提示不参与裁剪、没有预算上限兜底**。
所以往稳定区加进去的每一个字，是**每一轮都付的固定成本**，且不会有任何机制替你裁掉它。
「越短越好」在这里不是风格偏好，是账。

---

## 2. 方案设计

### 2.1 三个方案

| | 做法 | 改动面 | 常驻 token | 漂移风险 |
|---|---|---|---|---|
| **A** | **新增**独立层 `toolboxMap`（放在 `tools` 旁，稳定区） | `prompt-stack.cjs`(ORDER+buildLayers+VERSION) · `loop-prompt.cjs`(接线) · `context-diag.cjs`(STABLE) · `06-prompt-state.mjs`(WIRED_LAYERS) · `93-machine-prompt.mjs`(版本断言) · CHANGELOG = **6 处** | **+900 字 ≈ +300 token** | **有**：与 `tools` 层两份清单，需额外自检防漂 |
| **B**（推荐） | **改造现有 `tools` 层**：同样的 19 个工具、同样每工具一行，但**按场景分组 + 补回「何时该用」** | `loop-prompt.cjs`(toolsSection) · `prompt-stack.cjs`(VERSION) · `93-machine-prompt.mjs`(版本断言) · CHANGELOG = **4 处** | **≈ 0**（新写法 500~900 字，与现状相当） | **无**（只有一份清单） |
| **C** | A + 把 `tools` 层瘦身为「只有名字」，地图负责用途 | 同 A（6 处） | ≈ +300 字 | 有（两份，需自检） |

### 2.2 推荐方案 B 的具体形态

把 `toolsSection()` 的内置部分从「平铺 19 行」改成「分组地图」：

```
## Tools
**先看这张图再动手；每个工具的完整参数在 function calling 的 schema 里。**

- **摸清现状**（动手前）：`list_dir`（不确定结构先看这儿）、`read_file`（不确定路径先列目录）
- **改文件**：`edit_file`（小改动优先用它）、`write_file`（新建/整体重写才用）、`download`
- **跑命令**：`run_shell`（交互式命令别用它，会卡住）
- **上网**：`search_web`（知道关键词就用它）→ `browse`（要读整页/JS 渲染的页面）→
  `browse_elements` → `browse_click` / `browse_type`（要操作页面）· `browse_nav`（回上一步）·
  `browse_ax`（读菜单/表单/表格的语义）
- **长期记忆**：`memory_search`（**想确认「他以前说过吗」先搜它，别猜**）、
  `remember`（记用户习惯/项目约定/明确偏好）
- **协作与治理**：`ask_user`（要用户拍板先问）、`mark_step_done`（做完一步打卡）、
  `spawn_subagent`（要读很多份、只要结论）、`generate_image`
```

实测这版草稿 **≈ 620 字**（vs 现状 893 字）——**比现在还短**，因为分组后不必每个工具都写完整第一句。

### 2.3 「地图」这层怎么自我约束（硬禁区 12 要求：预算 / 截断 / 多模态）

- **预算**：跟着 `tools` 层，**不新增层**；不参与 `context-builder` 裁剪（系统提示不裁）。
- **超限怎么截断**：系统提示没有自动裁剪兜底，所以**必须自己设上限**。建议两条硬编码规则：
  1. 工具数 ≤ 24 → 正常输出分组地图；
  2. 工具数 > 24 → 只输出**分组名 + 计数**（「改文件（3 个）：见 schema」），把用途交给 schema；
  3. 任何单组超过 8 个工具 → 该组折叠成一行名字，不再逐条写用途。
- **多模态**：本层是**纯文本**，不含图片、不经 `JSON.stringify` 切分 → 不涉及
  `context-builder` 那次「图片被切坏」的坑。
- **形状只有一处**：分组是**渲染层**的展示规则，**不落任何字段**（不是数据结构变更）——
  分组表可以内联在 `toolsSection()` 里，收益不大就先不抽文件。

### 2.4 明确不做

- **不改任何工具的 schema / 描述 / 行为**（红线）。
- **不动 `WRITE_TOOLS` / `FILE_WRITERS` / 风险分级 / 权限**（红线）。
- **不做「按需注入 schema」**（两段式的第二阶段）—— 那是插件多到一定量之后的事，
  `Architecture Reality Audit.md:332` 已把它记为**有意**的后续，不在本轮。
- **不碰 `task.cjs` / 打卡机制**：地图里 `mark_step_done` 只是清单里的一行文字。

---

## 3. 边界与风险

### 3.1 和现有 `toolsSection` 重复吗？—— **重复，所以选「合并」而不是「分工」**

这是本方案最要紧的一条结论：

> 现有 `tools` 层**本来就已经是**「一行一个工具」的清单。再新增一层地图 =
> **同一个事实在两处定义**，正是 AGENT.md 硬约束 9 要防的（键名/约定只有一处真相源），
> 而且两份清单会**各自漂**（新加工具时改了一处漏一处，没有任何测试会报）。

所以：**方案 B = 合并**（把组织方式从「平铺」换成「按场景分组 + 补回导向」，仍然**只有一份**）。
若用户坚持要「独立一层」（A/C），则**必须**配一条自检：「地图里的工具名集合 === `registry.ALL` 的名字集合」
—— 否则就是明知会漂还加。

### 3.2 缓存影响（诚实说清）

- 稳定区内容变了 → **该会话的前缀缓存前缀整体失效一次**。因为改的是稳定区**中段**
  （第 9 层），其后所有层也一起重算 —— 但这是**一次性**的：改完发布后，
  每个会话的首轮付一次，之后照旧命中。
- 所以 `promptVersion` **必须**从 `prompt-stack/7` 升到 `/8`（`prompt-stack.cjs:150`
  的规矩：「加/删/改某一层的文案」就算），并在 `prompt-stack.cjs` 的变动史里补一行。
- `context-diag.diagnose` 会因此报一次 `稳定前缀发生变化` 的 warn —— 属**预期**，不是故障。

### 3.3 改一处要同步的地方（硬约束 9 的检查点）

**方案 B 需要同步**（4 处）：
1. `electron/core/loop-prompt.cjs` —— `toolsSection()` 的分组渲染
2. `electron/core/prompt-stack.cjs` —— `VERSION` `/7 → /8` + 变动史注释
3. `scripts/selftest/groups/93-machine-prompt.mjs:107` —— 版本断言（钉死 `/7`，必须改）
4. `CHANGELOG.md` —— 硬约束 10

**方案 A 额外还要**（+2 处，且都在「多处定义」的雷区）：
5. `prompt-stack.cjs` 的 `ORDER` + `buildLayers`（加层）
6. `electron/core/context-diag.cjs` 的 `STABLE`（自检 `93:97-100` 钉着两处要一致）
7. `06-prompt-state.mjs` 的 `WIRED_LAYERS`（接线守卫，防「文案写好了没人传下去」）

### 3.4 红线核对

| 红线 | 结论 |
|---|---|
| 不改工具 schema / 行为 | ✓ 只改提示里的**渲染文本** |
| 不碰 Runtime / IPC / 数据结构 / 权限模型 | ✓ 不新增字段、不新增通道；分组是渲染规则 |
| 不破坏 Phase 6 Persona 路由 | ✓ 新内容留在**稳定区**（与 `personaGuide` 同区），不动 `personaGuide` 及其取词 |
| 不破坏 Phase 6 打卡机制 | ✓ `mark_step_done` 只是清单一行；不碰 `task-plan.cjs` / `task-io.cjs` |
| 一处真相源 | ✓ 方案 B 保持单份清单；A/C 必须配防漂自检 |

---

## 4. 验收方式

### 4.1 静态（可自动断言，写进自检组）

1. `地图里的工具名集合 === registry.ALL 的名字集合`（**防漂**：以后加工具漏进地图就报红）；
2. 每个工具名**恰好出现一次**（防重复/漏写）；
3. 分组标题存在且分组数 ≥ 4；
4. `toApiSchema()` 的 19 个工具名与地图**完全一致**（跨通道形状对齐，硬约束 9）；
5. 版本号 `prompt-stack/8`（既有断言改值）。

### 4.2 行为（人工真机，模型有随机性，不能自动断言）

- **主测（问「何时该用哪个」，而不是「有哪些」）**：
  「我要查很久以前你跟我说过的一件事，你会用哪个工具？」→ 期望答 **`memory_search`**（不是 `read_file`）。
  > ⚠️ **不要问「你有哪些工具」**——那个从 schema 里就能背出来，**区分度低**，测不出地图有没有用。
- **次测**：「要读很多份文档、但我只要结论」→ 期望 **`spawn_subagent`**。
- **对照法（有说服力）**：同一个多步任务（例如「先看项目结构，再改一个文件，最后跑测试」），
  **改前 / 改后各跑一次**，看是否更早掏出 `list_dir` / `edit_file`（而不是拿 `run_shell` 凑）。
- **观察点**：`thinking` 里是否出现「按地图，这属于…组」这类选择过程；工具序列是否更短。

---

## 5. 附录：19 个工具的完整描述（实测导出，非手抄）

生成方式：`node tmp/_gen_appendix.mjs`（读 `registry.ALL`，打印到 `tmp/_appendix.md`）。
实施时重跑一次以对齐最新 registry —— **别手抄**（抄了就漂，硬约束 9）。

#### 1. `read_file`　`read`

- **描述**（65 字）：读一个文本文件的内容，返回带行号的结果。可以只读一部分（给 offset/limit）。读之前不确定路径时先用 list_dir。
- **参数**：`*path`(string) 相对工作目录的路径，或绝对路径 · `offset`(integer) 从第几行开始（1 开始），默认 1 · `limit`(integer) 最多读多少行，默认 400

#### 2. `write_file`　`WRITE·FILEW`

- **描述**（64 字）：写入整个文件（存在就覆盖，不存在就新建，父目录会自动建）。小改动请优先用 edit_file，只有新建文件或整体重写时才用这个。
- **参数**：`*path`(string) 相对工作目录的路径，或绝对路径 · `*content`(string) 文件的完整内容

#### 3. `edit_file`　`WRITE·FILEW`

- **描述**（75 字）：把文件里的一小段文本替换成另一段。oldText 必须在文件里唯一出现（否则会报错让你改得更精确）。改少量内容用这个，比 write_file 安全。
- **参数**：`*path`(string) 要改的文件路径 · `*oldText`(string) 要被替换的原文（必须唯一且逐字匹配，包括缩进） · `*newText`(string) 替换成什么（留空表示删除这段）

#### 4. `list_dir`　`read`

- **描述**（81 字）：列出目录内容。默认只看一层，可以用 depth 递归（最多 4 层）。node_modules/.git/dist 这类目录会自动跳过。不确定项目结构时先看这里。
- **参数**：`path`(string) 目录路径，默认工作目录 · `depth`(integer) 递归层数，1 = 只看当前层（默认 1，最多 4） · `all`(boolean) 是否包含被忽略的目录（默认 false）

#### 5. `run_shell`　`WRITE`

- **描述**（70 字）：在系统 shell 里跑一条命令并返回输出。工作目录默认是项目工作目录，可以用 cwd 指定别处。超时会自动杀掉。不要用它跑需要交互的命令。
- **参数**：`*command`(string) 要执行的命令 · `cwd`(string) 在哪个目录下执行，默认工作目录 · `timeout`(integer) 超时秒数，默认取设置里的值（一般 60）

#### 6. `search_web`　`read`

- **描述**（157 字）：联网搜索（轻量 HTTP，快但拿不到 JavaScript 渲染出来的内容）。当用户问到你的知识里没有、或者可能已经变了的东西（库的新版本、报错信息、别人的做法、商品价格）时**先用它**。搜完把 URL 一起给出来，方便用户自己核对。如果某个结果看起来是关键但搜到的摘要不够，用 browse 打开那一页读正文。
- **参数**：`*query`(string) 搜索词。用关键词，别写整句话 · `maxResults`(integer) 要几条结果，默认按设置（一般 5） · `fresh`(boolean) 强制重新联网搜，不用缓存。默认 false。搜**时效敏感**的东西（最新版本、当前价格、今天发生了什么）时设 true；查稳定的知识（历史、语法、某个库的基本用法）不用设。缓存结果会在开头标明是多久以前的。

#### 7. `browse`　`WRITE`

- **描述**（156 字）：用内置浏览器打开一个网页，把正文读回来（能执行 JavaScript，所以那些纯抓取打不开的页面也能读）。适合：看某个搜索结果的具体内容、查商品页面、读文档站点。只读，不会点击或提交任何东西。默认新地址开一个新标签页；只是中转、读一眼就走的页面，传 sameTab:true 在当前标签里打开（别一个劲堆标签）。
- **参数**：`*url`(string) 完整地址，要带 http:// 或 https:// · `sameTab`(boolean) 在当前那个标签里打开，不开新标签（保留它的历史，之后能用 browse_nav 退回来）。用于「这个页面只是中转、读一眼就走」——从搜索结果点进详情、顺着同一站点的链接连读几页。默认 false：新地址开一个新标签页，用户看得见你开过哪些页面。

#### 8. `browse_elements`　`WRITE`

- **描述**（166 字）：读**实时**当前页面上现在可交互的元素（按钮、输入框、链接、下拉框等），每个带索引、文本、角色和中心坐标。读之前会先等页面加载稳定（网络慢时可能要等几秒）。这是当前这一刻的真实页面，不是存档快照。先 browse 打开网页，再用这个看「页面上现在有什么、能点什么」，之后用 browse_click 按索引点。只读，不会改变页面。
- **参数**：（无参数）

#### 9. `browse_click`　`WRITE`

- **描述**（133 字）：点击当前浏览器页面上的某个元素。index 来自 browse_elements 返回的索引（比如 [3] 就用 index=3）。先 browse_elements 看页面上有什么，再按索引点。点击后页面可能变化，应该再 browse_elements 看新状态。
- **参数**：`*index`(integer) 要点的元素索引，来自 browse_elements 返回的 [N] · `force`(boolean) 落点被别的元素挡住时是否强制点击。默认否（拒绝并告诉你被谁挡住了）。只有确认遮挡可忽略时才带 true。落点在视口外时 force 也不放行。

#### 10. `browse_type`　`WRITE`

- **描述**（175 字）：往当前浏览器页面的输入框里打字。index 来自 browse_elements 返回的索引（那个元素必须是输入框/文本域）。可选 pressEnter 在输入后回车（搜索、登录常用）。密码框会弹确认框让用户授权（用户明确说了可以填密码时才该调用；内容不会显示、也不进对话记录）。输入后页面可能变化，应该再 browse_elements 看新状态。
- **参数**：`*index`(integer) 输入框的索引，来自 browse_elements 返回的 [N] · `*text`(string) 要输入的文字 · `pressEnter`(boolean) 输入后要不要按回车（搜索/登录常用），默认否

#### 11. `browse_nav`　`WRITE`

- **描述**（112 字）：在当前浏览器标签里后退或前进一页（用浏览器的历史记录，不会新开标签）。用它回到刚才那个页面 —— 比如点进详情看完了要回列表、翻到下一页后想回上一页。只能 back / forward，不能去任意地址（那用 browse）。
- **参数**：`*direction`(string) back = 上一页，forward = 下一页

#### 12. `browse_ax`　`WRITE`

- **描述**（159 字）：读当前浏览器页面的**无障碍树**（页面自己声明的角色/名称/状态，比如 textbox "邮箱" [required]、button "提交"）。比 browse_elements 更懂语义，适合读菜单、表单、表格这类结构。只读，不改页面。仅供理解页面用；要点击/输入仍然先 browse_elements 拿索引。
- **参数**：（无参数）

#### 13. `generate_image`　`WRITE`

- **描述**（215 字）：生成图片（文生图）。用「设置 → 场景 → 画图」里配的那个生图模型。prompt 要具体：主体、动作、环境、光线、风格。可选 size 指定比例（如 "16:9"、"1:1"）。★ 这个工具**只负责提交**，立刻返回任务号，不等待出图（上游要排队好几分钟）—— 出图后图片会自动出现在这条对话里。所以提交完**不要说「画好了」**，说「已提交，稍后出图」。要查进度时传 taskId + wait:false 看一眼上游状态。
- **参数**：`prompt`(string) 画面描述，中英文都行。写具体：主体 / 动作 / 环境 / 光线 / 风格 · `size`(string) 比例或像素，如 "16:9"、"1:1"、"1024x1024"。不填用服务端默认 · `taskId`(string) 查已有任务、不重新生成（上一次提交拿到的那串 task_id） · `wait`(boolean) 配合 taskId 用：传 false 就只查一眼上游状态、立即返回（不等出图）。用户问「那个任务怎么样了」时用

#### 14. `remember`　`WRITE`

- **描述**（81 字）：把一条关于用户的事实或偏好记到长期记忆里，之后的对话都会看到。适合记：用户的习惯、项目约定、明确说过的偏好。不适合记：当前任务的临时细节、能从代码里读出来的东西。
- **参数**：`*content`(string) 要记的内容，一句话，比如「打包产物不要超过 500KB」 · `type`(string) 这条记忆属于哪一类（不填按 fact）。约束/要求/项目规则这类「必须遵守」的别记成 fact，否则检索时不会被优先遵守。 · `scope`(string) 这条记忆管到哪（不填按 global = 所有对话）。只跟**这一次对话**有关的，填 session —— 它只在当前这条对话里被想起，换一条对话就不出现（避免串台）。

#### 15. `memory_search`　`read`

- **描述**（136 字）：搜索长期记忆，拿回匹配条目的**完整内容**（只读）。系统提示里只注入了每轮最相关的那几条；当你想确认某个约定 / 偏好 / 事实是否被记录过，或需要记忆条目的更多细节时，用它按关键词搜。query 必填（关键词，中英文都行）；limit 可选（默认 10，最大 20）。
- **参数**：`*query`(string) 搜索关键词，比如「下载目录」「严格模式」「打包」。匹配记忆的内容 / 类型 / 范围。 · `limit`(integer) 最多返回几条（默认 10，最大 20）。

#### 16. `ask_user`　`read`

- **描述**（365 字）：在动手之前，把「需要用户拿主意」的地方摆出来问他。每个问题给 2–4 个选项，每个选项都要写清「因为 X，所以会有 Y 效果」——X/Y 要是**具体数字或事实**（比如「多花 30 秒」「会新增 3 个文件」），不要写「更好」「更稳妥」这种主观判断。还要给每个问题标一个默认选项，默认必须是改动最小、最容易回滚、风险最低的那个：如果没有收到答复（用户离场），会按它继续。适合问：需求含糊有多种合理解法、做法不可逆、影响范围说不清。不适合问：能从代码或文件里查出来的事、纯风格偏好、一句话就能答完的活。一次最多问 3 个问题，用户答完才开工。※ 用户说了「先别动 / 等我确认 / 先分析再决定」这类话时，改用 `gate: true` 做**执行前复核**：把计划摆出来后单问一次「就按这个动手吗」，只有他明确点「执行」才动手。
- **参数**：`questions`(array) 要问的问题（最多 3 个） · `gate`(boolean) 执行前的计划复核（不是澄清）：用户说过「先别动、等我确认」时用。传 true 就不必给 questions，工具会拿 question 当摘要、用固定选项问一次「就按这个动手吗」；只有他明确点「执行」才放行，其余（自由回答 / 跳过 / 离开）一律按「没批准」停手。 · `question`(string) gate 模式的摘要（一句话），显示在确认卡上；详细计划写在回复正文里。

#### 17. `download`　`WRITE·FILEW`

- **描述**（80 字）：把 http/https 上的文件下载到工作目录（图片、压缩包、数据集等）。支持并行分段与断点续传；单个文件上限 2GB。网页正文用 browse，不要用这个。
- **参数**：`*url`(string) 下载地址（必须 http/https） · `*path`(string) 保存到哪：相对工作目录的路径，或绝对路径

#### 18. `spawn_subagent`　`read`

- **描述**（134 字）：派一个只读的「侦察兵」子代理去读一批文件 / 查资料，只把它整理好的结论带回来。适合「要读很多份东西才知道答案、但父任务读完只需要记住结论」的活 —— 它读过的原文**不会占用父任务的上下文**。它只能读：不能改文件、不能跑命令、不能再派子代理；它跑完不会再回来问你。
- **参数**：`*task`(string) 让子代理去做的**一件事**：写清要它回答什么、去哪找（例如「读 docs/ 下这三份，总结安全边界有哪几条，一条一行」）

#### 19. `mark_step_done`　`read`

- **描述**（128 字）：声明「计划里的第 N 步做完了」，让计划卡上那一步亮起勾选。★ 它只更新计划进度：不跑命令、不验证、不改用户文件。做完一步就调它打卡；验证请照常跑命令 —— 严格模式下只打卡不验证会被拦。step_index 是计划数组下标（0 起），必须落在合法范围内。
- **参数**：`*step_index`(integer) 计划数组下标，0 起（第 1 步是 0）。必须落在 [0, 计划步数) 内。 · `summary`(string) 可选：一句话说明这一步做了什么（会记进台账，便于回看）。

---

## 6. 落地记录（用户拍板 → 实施完成）

三个分叉用户都按推荐选了，**按下述执行**：

| 分叉 | 决定 |
|---|---|
| 走哪条路 | **B：改造现有 `tools` 层**（不新增层，避免两份清单漂） |
| 分组怎么划 | **6 组草稿**：摸清现状（动手前）/ 改文件 / 跑命令 / 上网查 / 长期记忆 / 协作与治理 |
| 超过 24 个工具怎么退化 | **折叠成「分组名 + 计数」** |

**实际落地**（与 §2.3 的方案一致）：

| 文件 | 改动 |
|---|---|
| `electron/core/tool-map.cjs` | **新增**（139 行）：6 组分组表 + 19 条手写导向 + `buildToolMap()` + `MAX_DETAILED=24` 退化分支 + `toolsSection()`（组装内置地图 / 插件 / MCP） |
| `electron/core/loop-prompt.cjs` | 删掉内联的 `toolsSection()`（27 行 → 8 行注释），改为 `toolMap.toolsSection({ pluginList, remote })`；`require('./tools/index.cjs')` → `require('./tool-map.cjs')`（299 → **280 行**） |
| `electron/core/prompt-stack.cjs` | `VERSION` `/7 → /8` + 变动史一行 |
| `scripts/selftest/groups/93-machine-prompt.mjs` | 版本断言改 `/8`；**新增 7 条**地图断言（含防漂 + 退化分支 + 跨通道一致） |
| `scripts/selftest/groups/142-persona-routing.mjs` | 同一处版本断言同步 `/8`（升版本时漏改会红） |
| `CHANGELOG.md` | 记这一笔 |

**实施后的实测**：

- 地图渲染 **856 字**（旧的 893 字）→ 常驻 token **净增 ≈ 0**；
- 分组表 ∪ 导向表的工具名集合 === `registry.ALL`（**19/19**，自检钉住）；
- 内核自检 **4290 项 / 0 失败**（改前 4282，**+8**）；`npm run verify` 全绿；
- 工具名集合与 `toApiSchema()` 完全一致（提示层 ↔ schema 层没有两样）。

**与原方案的两处差异（说明清楚）**：

1. §2.3 原写「分组表可以内联在 `toolsSection()` 里」—— **没这么做**。因为
   `loop-prompt.cjs` 当时是 **299 行**（贴顶），把分组表放进去必破 300 红线 →
   整个 `toolsSection` + 地图搬进新文件 `tool-map.cjs`（顺带把 `loop-prompt.cjs`
   降到 280 行，给以后的改动腾出空间）。
2. §4.1 原定「新增自检组 148」—— **改成挂进已有的** `93-machine-prompt.mjs`（它本来就是
   「环境与工具清单」那组，地图是它的自然延伸）。原因：`scripts/selftest.mjs` 当时已 **300 行**，
   再加一个 import + GROUPS 行会破红线。

**仍未做的（如实留）**：§4.2 的**真机行为验收**没做 —— dev 副本当前没开 CDP，
`shot:electron` 连不上；而且「模型会不会更主动」这类结论**必须人看**（有随机性，不能自动断言）。
建议重启后问一句「我要查很久以前你跟我说过的一件事，你会用哪个工具？」——期望答 `memory_search`。
