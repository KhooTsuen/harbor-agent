# 用量统计增强方案说明（功能 A · Token 花费分类 / 功能 B · DeepSeek 余额查询）

> **状态：只读调研产出，未实施任何代码。** 本轮零改动（`git status` 只有一张不属于本次工作的
> `generated/` 图片）。所有结论都指得住一次实测或一处代码位置。
>
> 调研日期：2026-10-15 · 数据来源：`E:\Harbor\data`（装机版真数据）+ 源码树 + DeepSeek 官方文档。

---

## 0. 先说三个"卡点"（它们决定方案形状）

| # | 卡点 | 事实 | 影响 |
|---|---|---|---|
| **①** | **推理 token 完全没采集** | `reasoning_tokens` / `completion_tokens_details` 在 `llm.cjs` / `token-metrics.cjs` / `stats.cjs` / `budget.cjs` 里**一处都没读** | 功能 A 的「推理」维度**不是"显示出来"，是"先采集"** |
| **②** | **「按任务」缺关联键** | `token-metrics.trace` = `req_*`（请求级），任务台账 `id` = `task_*`；实测 **0 / 294 个 trace 能对上 task.id**；`label` 里也匹配不到 `shortId(taskId)`（0 / 298） | 「按任务」要**先加关联键**，属数据结构改动 |
| **③** | **会话落盘的 message 不带 usage** | `E:\Harbor\data\sessions` 实测 **306 行 message，带 usage 的 = 0** | 会话文件这条路**不可用**，只能靠 `token-metrics.jsonl` / `stats.json` |

> 卡点 ① 的证据补充：A/B 探针真实拿到的 DeepSeek usage 是
> `{prompt_tokens:38, completion_tokens:4, total_tokens:42, prompt_tokens_details:{cached_tokens:0},
> completion_tokens_details:{reasoning_tokens:4}, prompt_cache_hit_tokens:0, prompt_cache_miss_tokens:38}`
> —— **字段在 API 返回里，只是我们没读**。这和「供应商没给」是两回事。

---

## 1. 现有统计模块的完整数据源地图

### 1.1 四个数据源

| 数据源 | 位置 | 粒度 | 字段 | 谁写 | 谁读 |
|---|---|---|---|---|---|
| **`token-metrics.jsonl`** | `data/logs/` | **每请求一行** | `at, kind, ok, label, model, providerId, trace, retryIndex, prompt, completion, total, cacheHit, cacheMiss, cacheSource, hitRate, ttftMs, latencyMs` | `llm.cjs:273` → `token-metrics.logLlm()`（**无条件**，含子代理） | 目前**只有报告脚本**读（`scripts/`），UI **不读** |
| **`stats.json`** | `data/` | **聚合桶** | `total` / `byDay`（90 天）/ `byModel`，每个桶 `{prompt, completion, total, calls, cached, cacheMiss}` | `loop.cjs:191` → `stats.record()`（**只在主循环**） | `stats:summary` IPC → `UsageTab.tsx` |
| **会话 `message.usage`** | `data/sessions/*.jsonl` | 每条回答 | `message.usage`（`answers.ts:34` 落了） | `answers.ts` → `session:append` | 界面 `StatusBar`（本会话 ↑↓）**但实测 0 行带 usage** |
| **任务台账 `tokens`** | `data/tasks/*.json` | **每任务一个聚合数** | `tokens` / `tokensIn` / `tokensOut`（`loop-run.cjs` 每轮覆盖写） | `loop-run.cjs:212-213` | 任务卡片；**UI 统计页不读** |

### 1.2 数据流（一图）

```
llm.chatStream(usage)
   ├─→ token-metrics.logLlm()   → token-metrics.jsonl   [逐请求，6MB 滚动，UI 不读]
   └─→ onUsage → loop.cjs:191 → stats.record() → stats.json  [聚合，90天，UI 读]
                                                    ↑
                                      stats:summary IPC → UsageTab.tsx
```

### 1.3 三层数据的**覆盖范围不一致**（容易踩的坑）

- `token-metrics.jsonl` 记**每一次** LLM 调用（含 `场景 title` / `场景 suggest` 这类辅助调用、含子代理）；
- `stats.json` 只记**主循环**的 `stats.record()`（`loop.cjs:191`），**场景调用与子代理不进**；
- 所以两边的"总量"**天生不等**。任何"分类"口径必须**明确说清用哪一层**，否则会出现"按模型加起来 ≠ 总量"。

### 1.4 保留期与易失性

- `token-metrics.jsonl`：**超 6MB 轮转**，只留一份 `.1`（`data-retention.cjs:47`）→ **老数据会被盖掉**，不适合做长期统计底座；
- `stats.json`：`byDay` 保留 90 天（`stats.cjs:19`），`total` / `byModel` **永久**。

---

## 2. 功能 A：Token 花费分类

### 2.1 维度设计（逐维判定"能不能做、要改什么"）

| 维度 | 现状 | 结论 |
|---|---|---|
| **输入未命中（全价）** | `stats.cacheMiss`（DeepSeek 显式给）/ `token-metrics.cacheMiss` | ✅ **可做**，零新 IPC |
| **输入命中（折扣）** | `stats.cached` / `token-metrics.cacheHit` | ✅ **可做**，零新 IPC |
| **输出** | `stats.completion` | ✅ **可做**，零新 IPC |
| **推理** | **完全没采集**（卡点 ①） | ⚠️ **要先加采集**（见 2.2） |
| **缓存** | 与「输入命中」**是同一个数**（`cached` / `cacheHit`） | ⚠️ **口径重叠，需你定**（见下） |
| **按模型** | `stats.byModel` / `token-metrics.model` | ✅ **可做**，零新 IPC（`StatsSummary.models` 已有） |
| **按时间段** | `stats.byDay` 只到**天**；按小时要读 `token-metrics.at` | ⚠️ 天粒度可做（零新 IPC）；小时粒度要扩通道（见 2.5） |
| **按任务** | **无关联键**（卡点 ②） | ❌ **本轮做不了**（要改数据结构） |

### 2.2 「推理」维度：必须先补采集（这是本功能真正的新增成本）

**改三处，字段名只定义一处**（遵守"跨模块约定只有一处真相源"）：

1. `budget.cjs` 的 `usageParts()` —— 它是"usage → 三个数"的**唯一形状定义处**（注释明写"形状知识只留一份"）。
   扩展成四元组：`{ total, input, output, reasoning }`，读 `usage.completion_tokens_details?.reasoning_tokens`。
2. `token-metrics.cjs` 的 `logLlm()` —— 加 `reasoning` 字段（**供应商没给记 `null`**，与现有 `cacheHit/cacheMiss` 同一纪律，绝不填 0 冒充）。
3. `stats.cjs` 的 `addInto()` / `emptyBucket()` —— 桶里加 `reasoning`。

> ⚠️ **注意语义**：DeepSeek 的 `reasoning_tokens` **是 `completion_tokens` 的一部分**（推理也按输出计费）。
> 所以「输出」和「推理」**不是并列的两个桶**，而是"输出 = 推理 + 非推理输出"。
> UI 上必须说清楚，否则用户会以为两者相加才是总数。

### 2.3 「缓存」与「输入命中」口径重叠 —— 需要你定（本方案唯一的口径决策）

你在需求里同时列了「输入命中（缓存折扣价）」和「缓存」。这两个在数据上是**同一个数**：

- 若你的意思是**两种看法**：一个是"命中多少 token"，一个是"命中省了多少钱" → 建议显示为
  `输入命中 1.2M tok（按全价算是 ¥X，实际 ¥Y，省 ¥Z）`；
- 若你以为是**两个不同的桶** → 那需要新增"缓存写入"采集，但 **DeepSeek 没有单独的 cache write 计费项**
  （官方定价页只有"输入（缓存命中）/ 输入（缓存未命中）"两档）→ **做不出来**。

**建议按第一种理解做**（同一数据、两种呈现），并在文档里写明。

### 2.4 单价配置方式：**必须可配置，不能硬编码**（三条硬理由）

官方定价（2026-10-15 实测，来源见 §3.1 同站）**每一档都不一样**：

| 模型 | 输入·命中 | 输入·未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 空闲 **0.02** / 高峰 **0.04** 元 | 空闲 **1** / 高峰 **2** 元 | 空闲 **4** / 高峰 **8** 元 |
| `deepseek-v4-pro` | 空闲 **0.15** / 高峰 **0.30** 元 | 空闲 **4.5** / 高峰 **9.0** 元 | 空闲 **13.5** / 高峰 **27.0** 元 |

（单位：元 / 百万 token。高峰 = 北京时间周一至周五 9:00–12:00 与 14:00–18:00，不含法定节假日；其余为空闲。）

**三条理由**：
1. **双档定价**（高峰 / 空闲）—— 硬编码一个数必然错一半；
2. **官方明说会变**（"DeepSeek 保留修改价格的权利"）—— 硬编码 = 每次调价都要发版；
3. **供应商变化**（你的要求）—— 换 provider 时单价完全不同，硬编码的旧价会给出**看起来精确的错数字**。

**落点建议**：`config.json` 新增 `pricing` 段（`providerId → model → { inMiss, inHit, out }`，
值可为 `{ peak, offPeak }` 双档）。这**是数据结构改动**（见 §4）。老配置没有该段时，
`load()` 要按现有兼容模式补默认（`stats.cjs:43` 那种 `{...empty, ...raw}` 写法）。

**"没配单价"时怎么办**：显示 token 数 + **不显示金额**，并给一行"未配置单价，无法折算金额"的提示。
**绝不猜、绝不用别的模型的价**（"看着精确的错数字"比"没有数字"更糟 —— 这条是本项目反复踩过的）。

### 2.5 UI 落点：**设置 →「数据与用量」→ `UsageTab`**（不新增页面）

现状：`SettingsModal.tsx:140` 的 `datausage` tab → `DataUsagePanel` → 内嵌 `tabs/UsageTab.tsx`（198 行）。

**可以零新增组件地扩展**：现有 `StatCard`（卡片）/ `Bar`（条形）/ `SectionTitle`（小节标题）
三个本地组件直接复用，加一节「花费构成」即可。

**按时间段（若要做小时粒度）**：`stats.json` 只有天。要做小时/自定义区间，有两条路：
- **A（推荐，零新 IPC）**：扩展 `stats:summary` 的返回，加一个 `hourly` 数组（内核读 `token-metrics.jsonl` 聚合）；
- **B（新增 IPC）**：另开 `stats:byRange`。**不推荐** —— 同一个消费场景没必要开两条通道。

### 2.6 功能 A：改动文件清单 / 硬禁区 / 风险

| 文件 | 改什么 | 硬禁区 |
|---|---|---|
| `electron/core/budget.cjs` | `usageParts()` 加 `reasoning`（形状唯一来源） | 否 |
| `electron/core/token-metrics.cjs` | `logLlm()` 落 `reasoning`（没给记 null） | 否 |
| `electron/core/stats.cjs` | 桶加 `reasoning`（`emptyBucket` + `addInto`） | 否 |
| `electron/core/config-defaults.cjs` | 加 `pricing` 默认段 | ⚠️ **是**（数据结构） |
| `electron/core/config.cjs` | `load()` 兼容老配置（补默认） | ⚠️ **是**（迁移） |
| `electron/core/llm.cjs` | 透传 usage（若 `onUsage` 已原样给，则**可能不用改** —— 实施时先确认） | 否 |
| `src/types/stats.ts` | `UsageBucket` 加 `reasoning` | 否 |
| `src/components/settings/tabs/UsageTab.tsx` | 加「花费构成」小节 | 否 |
| `src/lib/…` + 设置页 | 单价配置入口 | ⚠️ 视落点（可能涉设置页结构） |

**风险等级：中低**
- 采集侧（budget / token-metrics / stats）是**纯新增字段**，不动既有语义 → 低；
- `pricing` 配置段是**数据结构改动 + 迁移** → **中**（要拿老 `config.json` 实测）；
- UI 是既有组件复用 → 低。
- **最大风险点**：新增的 `reasoning` 字段在**老数据里是缺失的** —— 读侧必须按"老记录按 0 或不显示"
  处理，不能 `undefined + number = NaN`（本项目在 `tokensIn/tokensOut` 上踩过同类：`loop-run.cjs:191`
  就有"老任务没有 tokensIn / tokensOut → 当 0 看"的处理，照它做）。

---

## 3. 功能 B：DeepSeek 余额查询

### 3.1 官方端点（**引用官方文档，非记忆**）

> 来源：[DeepSeek API Docs · 查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)（2026-10-15 读取）

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <API Key>
```

**返回**（官方 Schema）：

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00",
      "granted_balance": "10.00", "topped_up_balance": "100.00" }
  ]
}
```

- `is_available`：当前账户**是否有余额可供调用**；
- `balance_infos[]`：每币种一条，`currency` 取值 `CNY` / `USD`；
- `total_balance` = `granted_balance`（未过期赠金）+ `topped_up_balance`（充值余额），**都是字符串**（别当数字算）。

> ⚠️ **关键实现细节**：端点**不在 `/v1` 下**。供应商配置里 `baseUrl = https://api.deepseek.com/v1`，
> 而余额是 `https://api.deepseek.com/user/balance` —— **不能直接 `buildUrl(baseUrl, '/user/balance')`**
> （那会拼成 `.../v1/user/balance`，404）。要取 host 再拼。

### 3.2 调用时机：**只由用户点击触发**（严守红线）

- 在 `UsageTab` 加一个「查询余额」按钮（`variant="ghost"` 之类），**点一次查一次**；
- **严禁** `useEffect` 自动拉、`setInterval` 轮询、启动时预取；
- 按钮旁**常驻显示「上次查询时间」**（无记录显示"从未查询"）；
- 上次查询时间**存哪**：建议只存**内存**（`useState`）。理由：它是个一次性的界面提示，
  落盘要动 `config` / `stats.json` 结构（硬禁区），**不值得**。若你要求跨会话保留，则必须走配置（属改动）。
- 请求自带 `AbortSignal.timeout(10_000)`（复用 `llm-probe.cjs:23` 的 `withTimeout` 模式）。

### 3.3 失败处理：**一律显示"查询失败"，绝不崩**

三条失败路径，逐条给出 UI 行为：

| 情况 | 判据 | UI |
|---|---|---|
| **网络不通** | `fetch` 抛错 / 超时 | `查询失败：网络不通（已重试）` + 保留上次成功值（若有，标"旧"） |
| **Key 无效 / 无权限** | HTTP 401 / 403 | `查询失败：API Key 无效或无权限` |
| **接口变更 / 不支持** | HTTP 404 / 非 JSON / Schema 不符 | `查询失败：该供应商不支持余额查询` |

**硬纪律**：
- 返回值**必须过 zod 校验**（`shapes` 里加一个 schema），外部数据不进未校验；
- **任何失败都不能抛到渲染层**（handler 用 `try/catch` 包住，返回 `{ ok: false, error }`，照
  `provider.cjs` 三个 handler 的现有写法）；
- 错误信息**必须过 `redact.cjs`**（不能把 Key 漏进错误串）。

### 3.4 凭证读取：**复用现有路径，零新增存储**

复用 `config.cjs` 的既有三件套（`provider.cjs` 就是这么写的）：

```js
config.get().providers → 找 target
config.hasKey(target)  → 有没有 Key
config.providerKey(target) → 解密取 Key（内部走 credentials.cjs / safeStorage）
```

**不新增任何凭证存储位置**，不碰 `credentials.cjs`。

### 3.5 IPC 评估：**必须新增通道，且不能复用现有任何一个**

**为什么不能复用**（逐个排除）：

| 现有通道 | 为什么不行 |
|---|---|
| `provider:ping` | **POST** 到 `chatPath`，带 `model` + `messages`，语义是"测对话连通"；余额是 **GET** 另一个端点。方法/端点/参数/语义全不同 |
| `provider:listModels` | **GET `/models`**，读"供应商有哪些模型"；端点不同 |
| `provider:probe` | POST 做**能力探测**（工具/图片/流式）；不同 |
| `stats:summary` | 纯**本地**读 `stats.json`，**不出网、不碰凭证**；混进去会让"本地统计"这条通道变成"会出网的通道"，违背它的职责边界 |

**建议新增一条**：

| 项 | 值 |
|---|---|
| **通道名** | `provider:balance`（与 `provider:ping` / `provider:listModels` 同族 —— 都是"向供应商问一件事"） |
| **参数** | `(providerId?: string)` —— 省略时用 `activeProvider()`（与 `provider:ping` 一致） |
| **返回** | `{ ok: true, at: number, available: boolean, infos: [{currency, total, granted, toppedUp}] }` 或 `{ ok: false, error: string }` |
| **实现落点** | `electron/handlers/provider.cjs`（现有 handler，加一个）；core 加 `llm-probe.cjs` 的 `getBalance()`（与 `ping` / `listModels` 同居一处，注释里已写明"这几个地方要跟着鉴权一起改"） |
| **同步改动** | `electron/ipc-channels.cjs` 的 `EXPECTED_CHANNELS` **必须同步**（否则打包后 `channelsOk` 会红 —— 这条被真实踩过）；`electron/preload.cjs` 加一行；`src/lib/appApi.ts` 或 `extrasApi.ts` 加一个包装 |

**通道数的具体值见 `node -e "require('./electron/ipc-channels.cjs').EXPECTED_CHANNELS.length"` 的输出** —— 本文件不写死（会涨的数字不写死）。

**注**：这条通道只对 **`api.deepseek.com`** 有效。对第三方中转（如 APIMart），余额端点是否存在**未知**。
建议：内置一个"已知支持余额的 host"判据（`api.deepseek.com`），不匹配时**直接返回
`该供应商不支持余额查询`**，而不是发一个必然 404 的请求。**不做成配置项**（那会让用户填一个错的路径然后困惑）。

### 3.6 功能 B：改动文件清单 / 硬禁区 / 风险

| 文件 | 改什么 | 硬禁区 |
|---|---|---|
| `electron/core/llm-probe.cjs` | 加 `getBalance({ baseUrl, apiKey, signal })` | 否 |
| `electron/handlers/provider.cjs` | 加 `provider:balance` handler | ⚠️ **是**（新增 IPC 通道） |
| `electron/ipc-channels.cjs` | `EXPECTED_CHANNELS` 同步 | ⚠️ **是**（同上） |
| `electron/preload.cjs` | 暴露 `providerBalance` | 否 |
| `src/lib/*.ts` | 包装 + zod 校验 | 否 |
| `src/components/settings/tabs/UsageTab.tsx` | 「查询余额」按钮 + 结果区 | 否 |
| `src/components/settings/parts.tsx` 或同目录 | 余额展示组件（若放得下就别新建文件） | 否 |

**风险等级：低**
- 只读查询、用户手动触发、有超时、有兜底、复用凭证路径；
- **唯一要留意**：新增 IPC 通道必须同步 `EXPECTED_CHANNELS` + `preload`，**三处少一处就静默失效**
  （项目里踩过：handler 注册块中间抛错 → 后面的通道静默不注册，窗口照开）。

---

## 4. 汇总：改动清单 + 硬禁区 + 风险等级

| 功能 | 授权内可直接做 | 触及硬禁区（**必须先报告/批准**） | 风险 |
|---|---|---|---|
| **A** | 推理采集（budget / token-metrics / stats）+ UI 分类展示 | **`pricing` 配置段**（数据结构 + 迁移） | 中低 |
| **B** | core 查询函数 + preload + 渲染层 | **新增 IPC 通道 `provider:balance`**（须同步 `EXPECTED_CHANNELS`） | 低 |

**按 AGENT.md 第 3 节，以下命中"硬禁区"，必须先确认**：
1. **需要动 3 个以上文件** —— A 与 B 都命中（但都是同一条功能线，按"一次功能 = 一次授权"看）；
2. **需要改数据结构** —— A 的 `pricing` 段 + `UsageBucket.reasoning`；
3. **需要新增 IPC 通道** —— B 的 `provider:balance`（须同步 `EXPECTED_CHANNELS`）；
4. **不给某个实体加状态** —— 两个功能都不给任务/回合/工具调用加状态 ✅（不命中）。

**明确不动**（红线）：
- 不引入新依赖（单价折算用现有 `Intl.NumberFormat` 即可；余额查询用现有 `http.cjs`）；
- 不自动轮询；
- 不新增凭证存储位置；
- 不改 `limits.cjs` 的闸门口径（它和统计共用 `stats.cjs`，动它会波及用量闸 —— **本轮不碰**）。

---

## 5. 建议的分批实施顺序（等你确认后再动）

1. **B 先行**（独立、低风险、无迁移）—— 一条通道 + 一个按钮，能最快看到东西；
2. **A-采集**（推理字段三处 + 老数据兼容）—— 先只把数据采上，UI 不动，攒一天数据；
3. **A-展示**（UI 分类 + 单价配置）—— 依赖 2 的数据；
4. **A-按任务** —— **本轮明确不做**，需要先在 `token-metrics` 里加 `taskId` 关联键（数据结构改动），单独评估。

---

## 6. 未决问题（要你拍板，我不替你定）

1. **「缓存」和「输入命中」是不是同一个东西？** 若是（我判断是），按"同一数据、两种呈现"做；
   若你以为它们是两个桶，请说明你想区分的到底是什么（DeepSeek 没有 cache write 计费项）。
2. **单价配置的形态**：`config.json` 加 `pricing` 段（我建议），还是**只读官方价、不提供配置入口**
   （简单，但换 provider 就废）？前者要改数据结构。
3. **上次查询时间要不要跨会话保留？** 只存内存（零改动）还是落盘（要走配置，属改动）？
4. **「按任务」维度要不要做？** 做的话要先改 `token-metrics` 的数据结构加关联键，属另一轮。

---

## 7. 本轮边界（如实）

- **未写任何实施代码**（`git status` 只有不属于本次工作的 `generated/`）；
- **未新增任何 IPC 通道**（B 的通道只做了设计，未实施）；
- **未改任何凭证存储**；
- 未碰 `limits.cjs` / `compact` / 安全层 / 严格模式。
- 本文件是**调研产出**（文档），按 AGENT.md 第 10 条，只动文档不要求写 CHANGELOG。
