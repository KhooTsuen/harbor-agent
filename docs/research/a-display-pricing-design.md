# A-展示设计方案：花费构成 + 单价配置

> 只读设计（2026-10-15）。**本轮不写实施代码。** 等确认后分批实施。
>
> 上游：`docs/research/usage-stats-enhancement-design.md`（数据源调查）· CE-019（A-采集，已落地）

---

## 0. 一句话

在「设置 → 数据与用量」里加一节「花费构成」，把已有的四个数（输入未命中 / 输入命中 / 输出 / 其中推理）
换成 token + 金额两列；单价走 `config.json` 的 `pricing` 段，内置 DeepSeek 官方价，老配置零迁移。

---

## 1. 现状核对（本轮实测，不是回忆）

### 1.1 数据已经齐了 —— 零新 IPC

CE-019 落地后，`stats.summary()` 的每个桶都带这 7 个键：

```
total   = {prompt, completion, total, calls, cached, cacheMiss, reasoning}
days[]  = {day, ...同上}
models[]= {model, ...同上}
```

实测（`E:\Harbor\data\stats.json`）：

```
total = {"prompt":421891447,"completion":6085534,"total":427976981,
         "calls":5452,"cached":405843072,"cacheMiss":15355432,"reasoning":0}
```

> `reasoning:0` 是**老桶经 `load()` 补键**的结果（A-采集的三层防护），不是没采到。

**「输入未命中」该用哪个数 —— 实测结论**：

| 口径 | 值 | 说明 |
|---|---|---|
| `prompt − cached` | **16048375** | 恒等式，任何来源都能算 |
| `cacheMiss` | 15355432 | **显式给的**，但只有 hit/miss 都返回的调用才算 |

逐行复核 `token-metrics.jsonl`（5702 行）：
```
hit+miss 都有 = 5638 行 → 这些行里 prompt−hit 完全等于 miss（16040193 = 16040193）
只 hit 无 miss = 60 行（openai-style）· unavailable = 4 行
```
**结论：`cacheMiss` 会漏掉那 64 行 → 显示「输入未命中」必须用 `prompt − cached`**，
`cacheMiss` 保留作对账用（不进 UI 主口径）。

### 1.2 现有 UI 可直接复用

`src/components/settings/tabs/UsageTab.tsx`（204 行）里已有：
- `StatCard({label,value,hint})` —— 本地组件，格子
- `Bar({bucket,max})` —— 本地组件，条形
- `SectionTitle` / `Row` —— 来自 `../parts`

**不新增页面、不新增组件文件**（花费构成这一节直接写在 `UsageTab.tsx` 里，它还没贴线）。

### 1.3 金额格式化：现成的，零新依赖

`src/lib/format.ts`（19 行）目前只有 `formatCount` / `formatTokens`，**没有金额函数**。
→ 加一个 `formatMoney(value, currency)`，用 `Intl.NumberFormat`（**内置，不是新依赖**）。

### 1.4 「防闪烁三件套」与本节无关（已核实）

它指 `useSmoothText` / `useAutoScroll` / `scrollGuard`，全在 `src/components/chat/`。
用量页在 `src/components/settings/`，**不碰、也不会被碰**。

### 1.5 `limits.cjs` 不会被波及

`limits.cjs:70` 读的是 `Number(bucket?.total) || 0` —— 只认 `total` 一个键。
往桶里加字段**不影响用量闸**。方案里也不改它。

---

## 2. 单价配置形态

### 2.1 结构（按你拍板：`providerId → model → {inMiss,inHit,out}`，双档 `{peak,offPeak}`）

`config.json` 顶层新增 `pricing` 段：

```json
"pricing": {
  "currency": "CNY",
  "unit": "perMillionTokens",
  "peakMode": "auto",
  "providers": {
    "deepseek": {
      "deepseek-flash": {
        "inMiss": { "peak": 2.0,  "offPeak": 1.0  },
        "inHit":  { "peak": 0.04, "offPeak": 0.02 },
        "out":    { "peak": 8.0,  "offPeak": 4.0  }
      },
      "deepseek-v4-pro": {
        "inMiss": { "peak": 9.0,  "offPeak": 4.5  },
        "inHit":  { "peak": 0.30, "offPeak": 0.15 },
        "out":    { "peak": 27.0, "offPeak": 13.5 }
      }
    }
  }
}
```

| 键 | 含义 |
|---|---|
| `currency` | 货币代码，喂 `Intl.NumberFormat`。默认 `CNY` |
| `unit` | 单价单位。固定 `perMillionTokens`（DeepSeek 官方口径就是「元/百万 tokens」） |
| `peakMode` | **双档怎么取**：`auto`（按当前时刻判档）/ `peak` / `offPeak`。默认 `auto` |
| `providers.<providerId>.<model>` | 三档价，每项 `{peak, offPeak}`；也可写**单个数**（= 不分档，如 `"out": 8`） |

**默认值（内置 DeepSeek 官方价，来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）**：

| 模型 | 入·命中 | 入·未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 空闲 0.02 / 高峰 0.04 | 空闲 1 / 高峰 2 | 空闲 4 / 高峰 8 |
| `deepseek-v4-pro` | 空闲 0.15 / 高峰 0.30 | 空闲 4.5 / 高峰 9.0 | 空闲 13.5 / 高峰 27.0 |

规律（官方原文）：**空闲价 = 高峰价 ÷ 2**；高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00。

### 2.2 查价规则（**必须只有一处**）

新增纯函数模块 `src/lib/pricing.ts`：

```
priceOf(pricing, providerId, model) → { inMiss, inHit, out, currency } | null
```

三级匹配（第一级命中就返回）：
1. `providers[providerId][model]` —— 精确
2. **遍历所有 provider** 找同名 model；**只有唯一命中**才用（两个 provider 都有同名模型 → 返回 `null`，绝不猜）
3. 都没有 → `null`

**为什么需要第 2 级**：`stats.byModel` 只有**模型名**、没有 providerId（实测桶键就是 `deepseek-flash` / `gpt-5.6-sol` / `deepseek-v4-pro`）。
而 `token-metrics.jsonl` 里 `providerId` 有 **433 行是空的**（占 7.6%）。所以按模型视图折算时，拿不到 provider 是常态。

**返回 `null` 的行为（你拍板过）**：**只显示 token 数，不显示金额**，并给一句「未配置单价」。
**绝不拿别的模型的价来猜。**

### 2.3 双档折算 —— 这里有个必须说清的限制

`peakMode: "auto"` 要判「这条调用发生在高峰还是空闲」，需要**每条调用的时刻**。实测：

| 数据源 | 有时刻吗 | 覆盖 |
|---|---|---|
| `stats.json` 聚合桶（total/byDay/byModel） | **没有** | 全部历史 |
| `token-metrics.jsonl`（有 `at` 毫秒戳） | **有** | **只 6MB**（已滚动，最早 2026-09-27） |

**所以「按天/按模型的历史桶」做不到逐条分档**（一天跨高峰和空闲）。
`auto` 的实际行为是：**按查询的那一刻判档，然后对全部历史用同一档折算** —— 这会产生
「看起来精确、实际可能错」的数字。

**三个选项（要你拍板）**：

| 选项 | 做法 | 代价 |
|---|---|---|
| **① 按当前档估算 + 明确标注**（推荐） | 用当前时刻判档，UI 上写「按当前时段价估算」 | 数字是估算，但标注清楚、零额外读取 |
| ② 用 token-metrics 精确分档 | 读 `at` 逐条分档 | 只覆盖最近 6MB；与 stats 的全量口径**对不上** |
| ③ 单档 | 配置里写死一档（不分 peak/offPeak） | 最简单，但半年数据会有偏差 |

> 我建议 **①**：配置结构保留双档（你拍的），折算用「当前档 + 标注」。
> 另：**法定节假日判不了**（要日历表），`auto` 在法定节假日会把空闲当高峰 —— 这条要在 UI 文案里认账。

### 2.4 老配置兼容（三层，一处都不能少）

老用户的 `config.json` **没有 `pricing` 段**，读回来要自动补全：

| 层 | 文件 | 做什么 |
|---|---|---|
| **默认值** | `electron/core/config-defaults.cjs` | `DEFAULTS` 加 `pricing`（内置 DeepSeek 官方价） |
| **归一化（关键）** | `electron/core/config-normalize.cjs` | `normalize()` 加 `pricing: {...}` 分支 |
| 写入合并 | `electron/core/config.cjs` 的 `patch()` | 加 `pricing` 合并分支（语义清晰） |

⚠️ **`normalize` 是必须改的那一处**：`save()` → `normalize()` 会**丢掉没在白名单里的字段**。
这正是 2026-10-11 `image.dir` 踩过的坑（`config-normalize.cjs:205-215` 的注释）——
`config-defaults` 有、界面也能改，但读回来过 normalize 时被丢掉 → 「改了不生效」。

⚠️ 顺序坑：老配置里 `pricing` 缺失 → `normalize` 用 `DEFAULTS.pricing` 兜底；
用户改过一部分（比如只填了 `out`）→ **深合并**（缺失的键回落到默认值），不能整段替换。

### 2.5 后端出网？**不需要**

`pricing` 不含密钥 → `stripInternal`（`config.cjs:64`，只摘 `_loadWarning` / `_legacyApiKey`）不会碰它
→ 现有 **`config:get` 通道**就能把它送到渲染层。**零新 IPC。**

---

## 3. UI 展示设计

### 3.1 落点

`UsageTab.tsx` 里，插在「用量」节之后、`按模型` 之前：

```
用量闸（预算）
用量            ← 现有 5 个 StatCard + BalanceCard
花费构成        ← 【新增】这一节
按模型          ← 现有
最近 30 天      ← 现有
清空统计
```

### 3.2 展示形式（复用 StatCard + Bar + SectionTitle）

```
花费构成                              [按当前时段价估算]
┌──────────────────┬──────────────────┐
│ 输入未命中        │ 输入命中（缓存）   │
│ 16,048,375        │ 405,843,072       │
│ ¥24.69            │ ¥8.12             │
│ 全价计费          │ 占输入 96.2%      │
└──────────────────┴──────────────────┘
┌──────────────────┬──────────────────┐
│ 输出（含推理）     │ 其中推理          │
│ 6,085,534         │ 0                 │
│ ¥24.34            │ 已在输出中计费     │
│ 推理占 0%         │ 不单独计价         │
└──────────────────┴──────────────────┘
────────────────────────────────────────
合计 ¥57.15
```

金额列**只在单价配好时出现**；没配 → 只显示 token + 「未配置单价」。

### 3.3 ★ 必须说清的口径（写进 UI 文案，不只是注释）

| 说法 | 实际含义 |
|---|---|
| **「输出 = 推理 + 非推理输出」** | `reasoning` 是 `completion` 的**子集**。DeepSeek 定价里**没有单独的推理价**，推理按输出价计费 |
| **「其中推理」不单独计价** | 它已经在「输出」那一格里算过钱了 —— 再算一次就是**重复计费** |
| **「缓存」=「输入命中」** | 同一数据的**两种呈现**（多少 token / 省了多少钱）。DeepSeek 没有 cache write 计费项，**不是两个桶**（你拍板过） |
| 「省了多少钱」 | `cached × (inMiss − inHit)`，相对「假设没命中」的差额；**是估算，不是账单** |

**所以三个计费桶 = 输入未命中 / 输入命中 / 输出**，`推理` 是展示项、不进合计。
合计 = 三项之和（**不重复计费**）。

### 3.4 按模型 / 按天也带金额

`models[]` / `days[]` 每个桶同样四个数 → 用同一个 `priceOf` 折算，在现有 `Bar` 那行右侧补一句金额。
按模型视图用 `priceOf(pricing, '', model)`（空 providerId 走第 2 级匹配）。

---

## 4. 改动文件清单 / 硬禁区 / 风险

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `electron/core/config-defaults.cjs` | `+ DEFAULTS.pricing`（内置官方价） | 低 |
| 2 | `electron/core/config-normalize.cjs` | `+ pricing` 归一化（深合并补键） | **中**（老配置兼容的命门） |
| 3 | `electron/core/config.cjs` | `patch()` 加 `pricing` 合并分支 | 低 |
| 4 | `src/types/models.ts` | `+ AppConfig.pricing` 类型 | 低 |
| 5 | `src/lib/pricing.ts` | **新增**：`priceOf` / `estimateCost`（唯一真相源） | 中 |
| 6 | `src/lib/format.ts` | `+ formatMoney`（Intl.NumberFormat） | 低 |
| 7 | `src/components/settings/tabs/UsageTab.tsx` | `+ 花费构成` 节 | 低 |
| 8 | `scripts/selftest/groups/151-pricing.mjs` | **新增**断言 | 低 |
| 9 | `scripts/selftest.mjs` | 注册新组 | **低但卡**（已 300 行满，**要先拆**） |
| 10 | `CHANGELOG.md` | 记账 | — |

### 命中硬禁区

- **#1 改动 ≥3 个文件** ✅ 命中（10 个）
- **#3 改数据结构** ✅ 命中（`config.json` 新增 `pricing` 段 + `normalize` 白名单）
- **#9 新增 IPC** ❌ **未命中**（复用 `config:get`）
- **#11 给实体加字段/状态** ❌ 未命中（加的是**配置项**，不是 Runtime 实体）
- **#8 动内核关键文件** ❌ 未命中（不碰 `loop/task/session/changeset`）

**风险等级：中**（新增配置段 + 老配置兼容 + 金额口径容易搞错；无 Runtime / IPC / 安全影响）

### 零新依赖确认

- 金额格式：`Intl.NumberFormat`（JS 内置）
- 无新包、无原生依赖

---

## 5. 要你拍板的 3 件事

1. **双档怎么折**（§2.3）：① 当前档估算 + 标注（推荐）／ ② token-metrics 精确分档（只覆盖 6MB）／ ③ 干脆单档
2. **「按模型」同名模型冲突时**（§2.2 第 2 级）：两个 provider 有同名 model → 我打算**返回 null 不猜**，你认可吗？
3. **`selftest.mjs` 已 300 行满**：加断言组前**必须先拆它**（抽出 import 块或 GROUPS 数组）。
   这是**额外的一刀**，要不要本轮一起做？

---

## 6. 建议实施顺序（确认后）

1. **配置层**（#1/#2/#3/#4）—— 加字段 + 兼容，不动 UI，可单独验
2. **折算层**（#5/#6）—— 纯函数，单测直接钉
3. **展示层**（#7）—— 最后接线，真机走一遍

---

## 7. 本轮边界

- **零实施代码**：产物只有本文件
- 未改任何内核 / 渲染层 / 配置
- 未新增 IPC、未新增凭证存储、未引入新依赖
- 不碰 `limits.cjs` / `compact` / 安全层 / 严格模式 / 防闪烁三件套
