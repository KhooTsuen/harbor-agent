# 记忆分层改造方案说明：从「每轮注入全文」到「摘要 + 按需取全文」

> **定位：方案设计 + 阶段 1 已实施 · 2026-10-13。**
> **阶段 1（只读工具 `memory_search` + 指路文案）已落地**，见 §2.2；**阶段 2（摘要注入）未实施、默认关**。
> 阶段 1 改动：新增 `electron/core/tools/memory_search.cjs` + 注册 + 指路文案 + 自检组 146。
> 本条以下的「未实施 / 等用户拍板」措辞指**阶段 2**，不是整篇。
> 依据：`electron/core/memory-*.cjs`、`context-builder.cjs`、`budget.cjs`、`tools/registry.cjs`、
> `handlers/extras.cjs` 的**实际代码**（行号见正文），不是推测。
> 边界（用户本轮明确红线）：不引新 npm 依赖 · 不碰 Runtime / IPC / 权限模型 / 事件契约 · 不破坏 Phase 6 的 Persona 路由与打卡机制。

---

## 0. 一页速览

| 项 | 结论 |
|---|---|
| **现状** | 每轮把最多 **12 条记忆的全文**拼成一段字符串塞进系统提示。打分是纯本地函数（关键词 2-gram Jaccard），取全文 = 直接取 `content` 字段。 |
| **⚠️ 关键冲突** | 用户设想里的「模型可用的 `memory:search` 工具」**不存在** —— `memory:search` 只是**设置页 UI 的 IPC 通道**，模型侧根本没有读记忆的工具（`tools/` 里只有写入的 `remember`）。 |
| **所以方案要做的第一件事** | **新增一个只读工具** `memory_search`（不是改 IPC）。这是本方案唯一「必须新增」的东西。 |
| **改动面** | 最小版 **1 个新文件 + 1 行注册 + 1 处文案**；完整版再 +1 处开关 +1 处注入格式（config 门控，默认关）。 |
| **数据结构** | **零变更**（摘要是 `content` 的派生，不落新字段）。 |
| **IPC** | **零变更**（工具是内核能力，不是 IPC 通道）。 |
| **老机器（i5-6400）** | 摘要 = `.slice()` 派生，**0 额外 CPU / 0 额外 I/O**；工具被调用时一次 `load()`（读一个小 JSON）。无向量库、无模型调用。 |
| **回滚** | 开关默认关 = 逐字回到今天的行为；关掉工具 = 删 1 个文件 + 1 行。 |

**红线核对（用户点名的那几条）**：不引依赖 ✓ · 不碰 Runtime/IPC/权限/事件 ✓ · 不碰 Persona 路由与打卡 ✓（本方案与这两处**无交集**，见 §6）。

---

## 1. 现状核对（只读 · 带行号）

### 1.1 注入路径：谁、在什么时候、拼了什么

```
loop-prompt.cjs:140-155   buildPromptContext()
   └─ 取「最后一条用户消息」当 query
   └─ 调 memory.buildPromptSection({ query, projectId, sessionId })
        └─ memory.cjs:177  透传 → memory-recall.cjs:110  buildPromptSection()
```

`memory-recall.cjs:110-165` 的 `buildPromptSection`：

1. `retrieve({..., explain:true})` 挑出 ≤ `injectLimit()` 条（见 1.2）；
2. 记一本「注入账」`lastInjectionRecord`（给设置页解释「为什么是这几条」）；
3. 生成字符串：
   ```
   ## 关于用户和这个项目（长期记忆）
   - [约束（project）] <content 全文>
   - [偏好] <content 全文>
   …
   （本轮最多注入 12 条，另外还有 N 条没进来 —— 需要哪个就去设置 → 记忆里看看。）

   这些是**你记得的事**，不是本轮的要求。与当前任务无关的就别硬套。
   ```
4. 调 `store.touch(ids)` 记一次「这条用过」（**每轮写一次盘**，见 1.4）。

**关键点**：模型拿到的就是 `content` **全文**（每条 ≤500 字，通常是**一句话**）；**没有任何「取更多」的入口**。底部那行 `另外还有 N 条没进来 —— 需要哪个就去设置 → 记忆里看看` 是**说给人看的**，模型既没有「设置页」也没有对应工具。

### 1.2 打分与「取全文」：全文从哪来

`memory-recall.cjs:58-100` 的 `retrieve`：

- `store.list({status:'active'})` 取全部 active；按 projectId / sessionId 过滤（`project` 只在对应项目注入；`session` fail-closed，只在本会话注入，`memory-recall.cjs:62-75`）；
- **条数 ≤ 预算时不打分**，直接按「最近更新在前」取前 N（`81-90`）—— 保持稳定；
- 超预算才逐条打分排序（`92-99`）。

打分权重**唯一真相源**在 `memory-explain.cjs:22-50`（`WEIGHTS`）：
```
score = 范围权重 + 类型权重 + importance×2 + confidence×1.5 + 新鲜度 + 关键词重合×6
```
重合度用 `memory-similarity.cjs:49` 的 `similarity()`（中文按 2-gram，纯字符串集合运算）。

**「取全文」= 直接读 `item.content`** —— 没有第二个数据源、没有摘要层、没有按需加载。**这就是要改的那一点。**

### 1.3 数据结构 / 生命周期 / 检索通道

- **记录形状**（`memory-schema.cjs` 与 `memory-store.cjs:92-110`）：`id / seq / content / type / scope / source / confidence / importance / createdAt / updatedAt / lastUsedAt / expiresAt / projectId / sessionId / status / supersededBy`。一条记忆 = 一个对象，`content` ≤500 字。
- **状态机（4 态）**：`active / superseded / disabled / expired`（`memory-schema.cjs:38`）。`superseded` 由冲突取代写（`memory-store.cjs:113-118`），`expired` 由 `pruneExpired()` 扫（`250-261`），**都不删**（`Forget ≠ Delete`）。
- **检索通道**：`store.search(query, opts)`（`memory-store.cjs:235-243`）—— 关键词**子串**匹配（`content + type + scope` 里 includes），不是模糊/向量。**已存在，可直接复用**。
- **冲突检测**：`memory-similarity.cjs:98-109`，只对 `preference/decision/project_rule/constraint/habit` 5 类、同 scope、相似≥0.7 或包含≥0.85 才算。

### 1.4 上下文空间：记忆层现在占多少

`context-builder.cjs`：

- `DEFAULT_BUDGET`（`31-41`）：`memory: 5` / `project: 15` / `task: 10` / `conversation: 30`（百分比）；
- `assemble`（`142-206`）里 `cap('memory') = floor(totalChars × 5%)`，`totalChars = maxTokens × 3`（`158-159`）；
- `maxTokens` 默认 `DEFAULT_CONTEXT_TOKENS = 16384`（`140`）→ `totalChars = 49152` → **记忆层上限 ≈ 2457 字符**（≈800 token），超了 `trim()` 截断。
- 记忆层是**独立额度**，不挤占其它层（只有 `conversation` 那条按 remaining 递减，`166-188`）。

**含义**：现在「条数上限 12」与「字符上限 2457」基本**互相卡死** —— 12 条 × 平均 ~200 字 ≈ 2400 字，正好贴线。所以只要记忆里有一两条偏长的，后面的就会被 `trim()` 截掉尾巴（`context-builder.cjs:95` 的裁剪说明会出现在提示里）。**这是「摘要化」真正的价值所在**：不是省很多 token（12 条也就 ~800 token），而是**让「能列出来的条数」不再被单条长度吃掉**，并把「详情」推迟到真正需要时。

### 1.5 ⚠️ 关键冲突：模型侧**没有**读记忆的工具

用户的方案设想是「在 Prompt 中告知模型可以使用**现有的** `memory:search` 工具获取全文」。核对结果：

| 「memory:search」是什么 | 证据 | 谁能用 |
|---|---|---|
| **IPC 通道**（设置页用） | `handlers/extras.cjs:40-46` `ipcMain.handle('memory:search', …)`；`ipc-channels.cjs:102`；`preload.cjs:96` `memorySearch` | **渲染层（人）** |
| 模型侧工具清单 | `tools/registry.cjs:38-57` 的 `ALL`：`read_file / write_file / edit_file / list_dir / run_shell / search_web / browse* / generate_image / remember / ask_user / download / subagent / mark_step_done` | **模型** |

**模型能读的只有文件，不能读记忆库** —— `remember` 只写不读。所以「告知模型去调 `memory:search`」**今天做不到**：那个工具在模型眼里不存在。

> 这不是坏消息，而是**方案的第一块砖**：要落地「按需取全文」，**必须给模型加一个只读的读记忆工具**。它属于**内核工具**，**不是** IPC 通道 —— 所以**不碰 `ipc-channels.cjs` 的 `EXPECTED_CHANNELS`**。

**工具怎么加**（照现有惯例）：`registry.cjs:14-57` 每个工具导出一个 `{ name, description, parameters, run }`；新工具加进 `ALL` 即可。参照最近的先例：打卡工具 `mark_step_done` 有自己的自检组 `scripts/selftest/groups/145-mark-step-done.mjs`（含「已注册进 ALL」「不在 WRITE_TOOLS」「出现在 toApiSchema」三条断言）。本方案照它做。

---

## 2. 方案设计（极度克制）

### 2.1 设计原则

1. **不落新字段** —— 摘要是 `content` 的**派生**（截断），不是新的存储态。符合《Memory设计.md》§5.2「新增字段四条件」（现有字段能表达 → 不加）。
2. **默认行为不变** —— 详情化/摘要化放进一个 config 开关，**默认 = 今天的「注入全文」**。开关是逃生舱，也是回滚键。
3. **必须遵守的照旧给全文** —— `constraint / instruction / project_rule` 是「必须遵守」的，**摘要化会丢语义**；这几类**始终注入全文**，其余（`fact / decision / preference / workflow / habit / temporary`）才走摘要。
4. **一件事只在一个地方变** —— 注入格式只在 `memory-recall.cjs` 的 `buildPromptSection` 里改；工具只有一处实现。

### 2.2 两个阶段（建议分两步走）

#### 阶段 1：先给模型「读」的能力（近零风险）

**目标**：把「模型够不着记忆库」这个**真实缺口**补上，**先不改注入形状**。

- **新增** `electron/core/tools/memory_search.cjs`（只读工具）：
  - `name: 'memory_search'`，`description`：说明「搜长期记忆，拿到匹配条目的完整内容；只读」。
  - `parameters`：`{ query: string (必填), limit?: integer }`。
  - `run(args, ctx)`：调 `memory.search(query, { projectId: ctx.projectId })`——**复用已存在的 `store.search`**（`memory-store.cjs:235`），按 `ctx.projectId` 过滤，返回 `- [类型] content` 列表（含 `id` 便于引用）。
  - **不进 `WRITE_TOOLS`** —— 它只读，`readonly` 档也要能用；进了的话 ask 档每次搜索都弹确认框（同 `mark_step_done` 的教训，`registry.cjs:73-75`）。
- **registry.cjs**：`require` + 加进 `ALL`（各 1 行）。**不进 `WRITE_TOOLS` / `FILE_WRITERS`**。
- **memory-recall.cjs**：把底部那行「需要哪个就去设置 → 记忆里看看」改成对新工具说的话（**这是模型现在唯一会读到的指路**）：
  ```
  （本轮最多注入 N 条，另外还有 M 条没进上下文。需要更多细节时，调 memory_search 搜关键词取全文。）
  ```
- **新自检组** `scripts/selftest/groups/1xx-memory-search.mjs`（照 `145-mark-step-done.mjs`）：断言「已注册进 ALL」「不在 WRITE_TOOLS」「出现在 toApiSchema」「只读：能搜到、能过滤 projectId、空查询不炸」。

**阶段 1 的行为变化**：注入内容**逐字不变**；模型提示里多一个工具 schema（tool calling 的 `tools` 数组 +1，`toolsSection` 里多一行）。**成本增量：可忽略**。

#### 阶段 2（可选，config 门控，**默认关**）：注入改「摘要 + 高价值全文」

- **config-defaults.cjs**（`memory` 段，`157-166`）：加 `summaryMode: 'full' | 'digest'`，**默认 `'full'`（= 今天行为）**。
  - ⚠️ 这是**配置键**（不是记忆数据结构）。`config-normalize` 会补默认，老盘不受影响。
- **memory-recall.cjs** 的 `buildPromptSection`：`summaryMode==='digest'` 时：
  - 「必须遵守」的三类（constraint/instruction/project_rule）→ 照旧全文；
  - 其余 → `- [标签（范围）] <content 截断到 ~60 字>…（id: xxx）`；
  - 因为省下的字符，可把**候选池**从 `injectLimit` 适当放宽（例如展示更多条摘要），让「列出来的东西」变多而不超预算。
- **摘要的生成**：`content.slice(0, 60)`（必要时在句读处切）。**纯函数、0 额外 I/O、0 模型调用。**

**为什么建议分两步**：阶段 1 就把「按需取全文」的**能力**建起来了，而且是**只增不改**；阶段 2 才动注入形状。用户若只想要「能力」，做完阶段 1 就能停。

### 2.3 改动面清单（阶段 1 已实施 · 实际落点）

> **阶段 1 已实施（2026-10-13）** —— 下表「实况」列是真实改过的文件。实际比预想多 2 处
> （`src/lib/agentActivity.ts` 被单测守卫要求补人话/图标；`71-memory-explain.mjs` 钉着旧文案）。

| # | 文件 | 改动 | 阶段 | 实况 |
|---|---|---|---|---|
| 1 | `electron/core/tools/memory_search.cjs` | **新增**，只读工具 | 1 | ✅ 83 行 |
| 2 | `electron/core/tools/registry.cjs` | `require` + 加进 `ALL` | 1 | ✅ |
| 3 | `electron/core/memory-recall.cjs` | 底部指路文案（阶段 2 再加注入格式） | 1（文案）/ 2 | ✅ 文案已改 |
| 4 | `scripts/selftest/groups/146-memory-search.mjs` | **新增**自检组 | 1 | ✅ 19 条断言 |
| 5 | `src/lib/agentActivity.ts` | 三张表（动作/人话/图标）补 `memory_search` | 1 | ✅ **预想漏了**：单测 `uiPolish.test.ts` 钉着「内核注册的工具人话表里都得有」 |
| 6 | `scripts/selftest/groups/71-memory-explain.mjs` | 对齐指路文案（`条没进来` → `条没进上下文`） | 1 | ✅ **预想漏了**：它钉着旧文案 |
| 7 | `electron/core/config-defaults.cjs` | 加 `memory.summaryMode`（默认 full） | 2 | ⏸ 未做（阶段 2） |
| 8 | `docs/README.md` · `CHANGELOG.md` | 登记 + 记账 | 本文 | ✅ |

**⚠️ 硬禁区 #1（动 3 个以上文件 / 新增工具）**：阶段 1 实际动了 **6 个文件**，**已获用户批准**后实施。

### 2.4 明确不做什么

- **不引向量库 / 不引依赖**（用户红线，且《Memory设计.md》§5.4 已列「当前阶段明确不做」）。
- **不改数据结构**（不加 `summary` 字段 —— 摘要是派生的）。
- **不动 IPC / `EXPECTED_CHANNELS`**（工具是内核能力）。
- **不动 `memory-store` 的读写语义、状态机、冲突逻辑**。
- **不动 `context-builder` 的预算分配**（记忆层额度不变；摘要化只是让同样的额度装下更多条）。
- **不动 Phase 6 的 Persona 路由（`loop-route.cjs` / `prompt-stack.cjs` 的 `personaGuide` 层）与打卡机制（`mark_step_done` / `task-plan.cjs`）** —— 本方案与这两处**无交集**。

---

## 3. 老机器（i5-6400）性能评估

用户点名要评估「每次生成摘要或打分是否引入显著 CPU / I/O」。逐项拆：

### 3.1 摘要生成：0 额外开销

阶段 2 的摘要是 `content.slice(0, 60)` —— **字符串截断**，在已经取到的对象上做。**0 次额外文件读、0 次模型调用、0 次网络**。i5-6400 上 12 条截断是**微秒级**。

> **绝对不做**：用 LLM 生成摘要。那会给每轮/每次写入加一次模型调用（延迟 + 花费），且在 i5-6400 上拖慢。本方案从设计上排除。

### 3.2 打分：无新增（现状已存在）

打分是纯内存计算，`O(n)`（`n = active 条数`，上限 `maxItems=800`，`config-defaults.cjs:163`）。`similarity()` 是 2-gram 集合运算。**本方案不改打分。** 若要抠，可把「query 只 tokenize 一次」当作独立优化（现状每条都 tokenize 一遍 query），**但那不属于本方案，建议单列**。

### 3.3 工具调用：被叫时才花一次小 I/O

`memory_search` 被模型调用时：一次 `store.search()` = 读 `memory.json` + `JSON.parse` + 子串过滤。记忆文件现在 ~46KB（55 条），**毫秒级**。相比一次模型往返（秒级），可忽略。

### 3.4 ⚠️ 现状里**已经存在**的真实 I/O（本方案**不引入、也不修**，只如实记录）

- `buildPromptSection` 一轮里 `load()` 会被调**多次**：`pruneExpired`（`memory-recall.cjs:59`）→ `list`（`61`）→ `stats`（`115`）各一次 `load()`，每次 `readFileSync` + `JSON.parse` 整个文件。800 条时约几百 KB ×3~4 次/轮。
- `store.touch(ids)`（`memory-recall.cjs:151`）**每轮把整个 `memory.json` 重写一遍**（为更新 `lastUsedAt`）。
- 这两条**今天就存在**，与「摘要化」无关。**要不要顺手优化，是独立议题**（涉及 `memory-store` 写路径 / 缓存，属内核改动，需单开）。本方案**不碰**它们 —— 免得把「分层改造」和「写路径优化」两件事混在一轮（本项目忌讳的「顺手一提」）。

**结论**：本方案对 i5-6400 **无显著新增开销**，且有明确降级路径（阶段 2 默认关；工具是惰性按需）。

---

## 4. 负面案例排查：模型**不**去调 `memory_search` 怎么办？

这是本方案最大的行为风险。分三层应对，**从轻到重**：

### 4.1 第一层（必做）：指路文案紧挨着注入内容

现在底部那行 `需要哪个就去设置 → 记忆里看看` 是**对牛弹琴**（模型没有设置页）。改成明确的工具指令，且**放在记忆层内部**（离内容最近，模型最容易读到）。措辞要具体：
> 「需要更多细节 / 上面没提到的记忆时，调 `memory_search` 传入关键词。」

### 4.2 第二层（阶段 2 才需要）：只在「有东西没进来」时才追加一句强约束

若阶段 2 真把内容摘要化了，就存在「模型以为摘要就是全部」的风险。此时**当且仅当** `total > injected`（有条目被挡在外面）时，追加一句强约束：
> 「⚠️ 你不确定某个约定 / 偏好是否已被记录时，**先调 `memory_search` 查，再回答** —— 不要凭印象假设「记忆里没有」。」

**⚠️ 一个必须遵守的实现约束**：这句**不能写进 `workRules`（How To Work 层）**。原因：`prompt-stack.cjs:182-205` 里 `workRules/safety` 属于**稳定前缀**（命中缓存），而这句话会随「有没有条目被挡」每轮变 —— 放进去会**每轮打掉提示前缀缓存**（`context-diag.cjs` 的 `stablePrefixChanged` 会一直报警，且白烧 token）。**正确落点**：记忆层本身（`relevantMemory`，它在**易变区**，`prompt-stack.cjs:200`），紧跟在注入内容之后。

### 4.3 第三层（不做，只提示）：自动兜底

「模型没查 → 系统自动再注入一次全文」这种兜底**不做** —— 它会让「摘要化」名存实亡（等于又注入全文），且引入「什么时候自动升级」的新状态。**宁可接受「偶尔没查」**，也不为它加机制。

### 4.4 与 Phase 6「Persona 强软约束」的关系（用户点名的类比）

用户提到「像 Phase 6 的 Persona 一样给强软约束」。**结论：形似但落点不同**，必须说清：

- Phase 6 的 persona 是**整场不变**的（`loop-route.cjs` 由第一条用户消息锁定），所以它**放稳定区**吃缓存（`loop-prompt.cjs:234-238`）；
- 本方案的「去查记忆」约束，**只在有条目被挡时才出现**，**每轮可能变** → **只能放易变区（记忆层内部）**。
- **两者不冲突、不互相破坏** —— 本方案不读也不写 persona 的任何字段。

---

## 5. 边界红线核对（逐条）

| 红线 | 本方案 | 证据 |
|---|---|---|
| 严禁新 npm 依赖 / 向量库 | ✓ 零依赖 | 摘要=切片；搜索=已有 `store.search` 子串匹配 |
| 严禁碰 Runtime / IPC / 权限 / 事件契约 | ✓ 全不碰 | 工具是内核能力；不改 `ipc-channels.cjs` / `risk.cjs` / `capability.cjs` / `event-types.cjs` |
| 严禁破坏 Persona 路由 | ✓ 无交集 | 不读不写 `personaOf` / `personaGuide` |
| 严禁破坏打卡机制 | ✓ 无交集 | 不碰 `mark_step_done` / `task-plan.cjs`；新工具**不进** `WRITE_TOOLS` |
| 不引新原生依赖 | ✓ | 纯 JS |
| 改了代码必写 CHANGELOG | 落地时补 | 阶段 1/2 动 `electron/**` → 必写（本轮只写文档，不适用） |

---

## 6. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 模型不调 `memory_search` | 中 | §4.1 指路文案（必做）+ §4.2 条件强约束（阶段 2） |
| 摘要丢失语义 → 模型误解 | 中 | 「必须遵守」三类**始终全文**（§2.1-3）；摘要只用于背景类 |
| 摘要化后模型过度调用工具 → 多往返 | 低 | 文案里写清「**需要细节时**才调」，不是每轮都调 |
| 阶段 2 开关被误开、影响体验 | 低 | 默认 `'full'`；文档写清含义 |
| 加工具改变了系统提示 → 撞提示回归自检 | 低 | `06-prompt-state.mjs` 用**手写** tools 文本（`42`），不读真实 registry → 不受影响；但 `toolsSection` 输出会变，需人眼确认一次 |
| 一轮 3+ 文件 → 硬禁区 | — | 本方案**主动停下**等拍板（不在本轮实施） |

---

## 7. 落地顺序（若获批）

1. **阶段 1**（近零风险，建议先做）：
   - 新增 `tools/memory_search.cjs` + registry 注册；
   - 改 `memory-recall.cjs` 底部指路文案；
   - 新增自检组 `1xx-memory-search.mjs`；
   - `npm run verify`（typecheck / lint / lint:kernel / 单测 / 内核自检 / 构建）+ `npm test`（新组绿）；
   - 补 CHANGELOG。
   - **验收**：真机让模型答一个「我之前是不是说过 X？」——看它是否调 `memory_search` 并答对。
2. **阶段 2**（可选，另开一轮）：
   - 加 `memory.summaryMode`（默认 `full`）；
   - `buildPromptSection` 按开关切换注入格式；
   - 改前/改后**对比记忆层字符数**（`context-builder` 的 `estimates` / 设置页「记忆为什么是这样」）。
   - **验收**：开 `digest` 后，同一条提问下「列出的条数」变多、上下文长度下降、且「必须遵守」类仍全文。

---

## 8. 待用户拍板的分叉

1. **做到哪一步**：只做阶段 1（拿到「读」的能力、注入不变）？还是 1+2（注入也摘要化，带开关）？
2. **阶段 2 的默认**：`summaryMode` 默认 `'full'`（今天行为，最稳）还是 `'digest'`（新行为）？—— 建议 `'full'`。
3. **摘要长度 / 候选池**：摘要截断多少字、`digest` 下最多列多少条？（先不定数字，实施时按实测调，避免写死——硬约束 8）

---

## 9. 来源

- 代码：`electron/core/memory-recall.cjs`、`memory-store.cjs`、`memory-explain.cjs`、`memory-similarity.cjs`、`memory-schema.cjs`、`memory.cjs`、`loop-prompt.cjs`、`context-builder.cjs`、`budget.cjs`、`prompt-stack.cjs`、`tools/registry.cjs`、`tools/remember.cjs`、`handlers/extras.cjs`、`preload.cjs`、`ipc-channels.cjs`、`config-defaults.cjs`。
- 自检：`scripts/selftest/groups/02-skills-memory.mjs`、`145-mark-step-done.mjs`、`06-prompt-state.mjs`、`85-token-opt.mjs`。
- 既有设计：《[`Memory设计.md`](../Memory设计.md)》《[`记忆分层调研`]（外部 11 项目深读：claude-mem 3 层渐进披露 / TencentDB 符号化+分层 / hindsight 巩固精炼 / nanobot 两阶段+Git 版本化）》。
