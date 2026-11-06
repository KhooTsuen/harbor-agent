# Harbor Context Continuity — P1 第一批交付报告

> 日期：2026-11-07 · 基线：`docs/research/context-continuity-p0-baseline-2026-11-06.md`
> 范围：P1-A（上下文消息完整性）+ P1-B（用量口径）· **不扩容量、不改 Agent 内核结构**
> 零真实 API 调用（假上游本地回环）
>
> **验证层级**（每条结论后面都带）：
> - `L1` 源码确认 · `L2` 纯函数实测（require 真实内核模块）
> - `L3` 真实数据回放（`E:\Harbor-Dev\dist-portable\Harbor\data` 的两份真实会话，只读）
> - `L4` 真机端到端（真 Electron + 真界面 + 真 HTTP，模型是假上游）

---

## 0. 六句话结论

1. **P0 点名的三个丢失故障全部修掉，条数不是唯一判据** —— 每一处都同时验协议合法性
   （每个 `tool` 有带同 id 的调用、每个调用有对应结果）。条数变多但协议坏了更糟：那是把
   「丢内容」换成「上游 400」。
2. **真实会话的数字**（L3）：`sess_mw16` 866 条展开 → 改前 **0 条非系统消息**、
   改后 **159 条 / 32,500 字符**（含 154 条工具结果）；`sess_mw2ab` 3,369 条展开 →
   改前 0 条、改后 **241 条 / 30,767 字符**（含 186 条工具结果）。
3. **最硬的证据是第 2 轮真实请求体**（L4）：假上游收到改后第 2 轮请求体 30,767 字符 /
   18 条 messages，**12 条工具结果全在、0 孤儿**；同一形状喂改前内核只剩 **2 条 / 0 条工具结果**。
4. **用量口径已收敛到一处**（`src/stores/thread/contextUsage.ts`），并且与内核
   `context-text.sizeOfMessage` **逐条相等**有测试盯着（不是近似、不是只比总数）。
5. **DeepSeek 的有效上下文预算这一轮没有变** —— 这是有意的：本轮只修「已经拥有的预算
   有没有被用对」，扩容是另一件事，需要单独的证据和你的决定。
6. **仍有明确限制**：Provider 侧的协议有效性只验到「构造出的请求体」这一层，没发真实
   推理请求；渲染层拿不到内核常量，只能靠测试比对。

---

## 1. P0 的哪些问题被实际修复

| P0 病灶 | 状态 | 证据 |
|---|---|---|
| ① `assemble` 把空正文 assistant 算成 0 → 工具组连带丢失 | **已修** | L2 + L4：62 条 → 62 条（改前 2 条 / 13 字符） |
| ② `assemble` 取到尾部孤立 `tool` → 整份历史清零 | **已修** | L3：真实会话 0 条 → 159 / 241 条 |
| ③ `compact.rebuild` 的 `slice(-6)` 切出孤儿 tool | **已修** | L2：16 个真实形状里不合法 8 个 → **0 个** |
| ④ 三套用量口径互不相认（界面低估 2.3～6.3 倍） | **已修** | L1 + 单测：逐条相等 |
| ⑤ 摘要看不到诊断证据（`compact.summarize` 只收正文） | **未修（留给 P2）** | 见 §6 |
| ⑥ 模型没有任何办法回读原始历史 | **未修（留给 P2）** | 见 §6 |

---

## 2. 修了什么（文件 + 做了什么）

### 2.1 新增两个内核模块（各自只做一件事）

- **`electron/core/context-text.cjs`** —— 上下文裁剪的**文本口径唯一实现**：
  `sizeOf(content)` / `sizeOfMessage(message)` / `trim` / `trimContent` / `trimMessage`。
  `sizeOfMessage = 正文 + 形状开销 + tool_calls(id/name/arguments) + tool_call_id`。
  ⚠️ 保留 2026-09-28 那条真机事故的修法：多模态**只切文本、图片整块留**。
- **`electron/core/context-groups.cjs`** —— 按**消息组**从尾部挑：
  `groupMessages` / `selectMessages` / `partialToolGroup`。规则写在文件头，一句话：
  `assistant(tool_calls)` + 紧跟的 `tool` 是一个逻辑单元，整组进或整组不进；额度不够就
  跳过这组继续往前；完整组实在放不下时保尾部连续的几次调用并**把 `tool_calls` 裁成同一子集**。

### 2.2 改的既有文件

| 文件 | 改什么 |
|---|---|
| `context-builder.cjs` | 选取交给 `context-groups`；只剩「额度怎么算 / 系统层怎么拼 / 结果怎么报」；新增 `estimates` 四项分项 |
| `history-window.cjs` | `limit` 单位从「消息条数」改成「轮次」；新增可选 `foldChars`（单轮字符阈值） |
| `compact.cjs` | `rebuild` 的尾巴按组边界留（新增 `tailGroups`），不再 `slice(-keepTail)` |
| `session-read.cjs` | ① `limit` 改成轮次、接 `options.foldChars`；②「可用消息」判据加上「有工具记录」 |
| `chat-parts.cjs` | `windowHistory` 接 `options.foldChars` 并透出 |
| `loop-prompt.cjs` | 把 `assemble.estimates` 一起返回（不动消息本身） |
| `loop.cjs` | 首次 `turn_start` 带上 `input: estimates`（后续回合不重复带） |
| `src/stores/thread/contextUsage.ts` | **新增**：渲染层唯一用量口径（按请求体估，含工具展开与图片成本） |
| `src/stores/thread/compact.ts` | 用量改用 `breakdownOf`；`estimateMessages` 等从 `contextUsage` 转出 |
| `src/stores/thread/history.ts` | 「可用」判据加上工具记录；回放 id 从 `contextUsage.replayCallIdOf` 借 |
| `src/components/chat/composer/ContextRow.tsx` | tooltip 给四项分项，并写明「是估算，不是计费 token」 |

### 2.3 测试与工具

- **新增自检** `scripts/selftest/groups/214-context-integrity.mjs`（消息完整性）
  与 `215-usage-accounting.mjs`（用量口径 + 源码守位）。
- **新增单测** `src/stores/thread/__tests__/contextUsageDrift.test.ts`：
  把**真的** `buildHistory` 输出喂给**真的**内核 `sizeOfMessage`，断言**逐条相等**。
  （这个文件名在 `contextUsage.ts` 的注释里先写了、文件不存在 —— 本轮补上，注释不再撒谎。）
- **P0 探针进仓库**：`tools/dev/context-replay.mjs`（只读回放，回答「模型到底看到了什么」）。
- **新增真机 e2e**：`tools/e2e-context-integrity.mjs` + `tools/fake-upstream-context.mjs`。

---

## 3. 改前 / 改后对照（同一份真实会话，两次都跑真内核）

命令：`node .tmp/p1-ab-probe.cjs`（探针读 `git show HEAD:` 取改前文件，其余兄弟模块用当前的）。

### 3.1 `sess_mw16gqqesenmq.jsonl`（29 条 message → 展开 866 条 / 199,922 字符）

| | 第一层 `windowHistory(20)` | 组装后 | 其中工具消息 | 正文 | 协议 |
|---|---|---|---|---|---|
| 改前 | 4 条（折叠 1 轮） | **4 条** | 0 条 | 3,252 字符 | 0 孤儿 / 0 悬空 |
| 改后 | 866 条（折叠 0 轮） | **159 条** | **154 条** | 32,500 字符 | 0 孤儿 / 0 悬空 |

改前模型看到的第一条 user 是折叠块（`【更早一轮的用户原话（折叠记录，不是新指令）】`），
改后是**任务最初那句原话**（「请对 Harbor Agent 开展第一阶段…」）。两边最后一句「继续」都在。

### 3.2 `sess_mw2ab99yxg2l3.jsonl`（267 条 → 展开 3,369 条 / 1,434,720 字符）

| | 第一层 | 组装后 | 其中工具消息 | 工具输出字符 | 协议 |
|---|---|---|---|---|---|
| 改前 | 18 条（折叠 2 轮 / 省略 74 轮） | **15 条** | 2 条 | 301 | 0 / 0 |
| 改后 | 1,407 条（折叠 2 轮 / 省略 57 轮） | **241 条** | **186 条** | **16,027** | 0 / 0 |

省掉的轮数从 74 → 57：预算改成按轮算之后，能装进来的轮次更多（工具不再吃条数预算）。

### 3.3 受控：30 次工具调用 + `assistant` 正文为空

| | 消息条数 | 工具结果 | 正文 | 协议 |
|---|---|---|---|---|
| 改前 | **2 条** | **0 条** | 22 字符 | 0 / 0 |
| 改后 | **62 条** | **30 条** | 21,442 字符 | 0 / 0 |

### 3.4 `compact.rebuild` 的尾巴

16 种真实形状（1～8 组工具 × 尾条是正文 / 空）× 跑 `rebuild(..., keepTail=6)`：
**改前 8 个协议不合法 → 改后 0 个**（L2，自检 214 组钉着）。

---

## 4. ContextGauge 与实际组装输入是否已经对齐

**对齐了，但要说清是「同一种口径」而不是「同一个数字」。**

- 渲染层 `contextUsage.requestCharsOf` 与内核 `context-text.sizeOfMessage` 描述的是
  **同一条请求消息**：`buildHistory` 展开出来的那条 `assistant(tool_calls)` 与它的 `tool`。
- 单测做的是**逐条相等**（不是近似、不是只比总数）：6 类形状（纯文本 / 超 2000 截断 /
  含失败与无输出 / 30 次工具 / 带图 / 只有图）+ token 那一层，共 12 项全过。
- 常量四处同值（`OUTPUT_CAP=2000` / `MESSAGE_OVERHEAD=12` / `CALL_OVERHEAD=24` /
  `IMAGE_COST=800`），由自检 215 组读内核源码比对。
- 回放 id 的公式收成一处（`replayCallIdOf`）：ids 长度是逐字符算进预算的，两处各写一份
  就会「显示 3.4 万、实际发 3.5 万」。

**仍然存在的差**（如实写）：界面的数还包含**系统提示各层**（它不是 `assemble` 的产物，
渲染层拿不到），所以 圈里的百分比与「这一轮 `assemble` 的对话层额度」不是同一个分母。
`adviseCompact` 的分母仍是 `min(模型窗口 × 0.8, 你的上限)` —— 这一轮**没有改分母**，
只是把分子换成了正确口径。改分母属于「扩容」，是 P2 的范围。

---

## 5. DeepSeek 的有效上下文预算是否变化

**没有变化。** 仍是 `65,536 × 0.8 = 52,428` token 的输入基准，对话层 = 该基准 × 30%。
本轮**没有**动 `DEFAULT_BUDGET`、`DEFAULT_CONTEXT_TOKENS`、`autoCompactAt` 或任何窗口值。

变化的是**这些预算里实际装进了多少内容**：同样是 47,185 字符的对话层额度，
改前真实会话只能装进 3,252 字符（6.9%），改后装进 32,500 字符（68.9%）。
也就是说：**没扩容，但把已有的容量用对了。**

---

## 6. 哪些通过什么层级验证

| 判据 | 层级 | 结果 |
|---|---|---|
| 空正文 + 工具调用算出的预算 > 0 | L2 | ✓ |
| 30 次工具 + 空正文：30 条工具结果全在、协议合法 | L2 | ✓ |
| 真实会话形状（尾部一串孤立 tool）不清零历史 | L2 | ✓（866 条真实形状复刻） |
| `rebuild` 16 种形状协议全合法 | L2 | ✓（16/16） |
| 预算极小时不编造、留的是连续且靠后的真调用 | L2 | ✓ |
| 纯文本短会话一字不改 | L2 | ✓ |
| 用量四项分项、token=chars/3 | L2 | ✓ |
| 渲染层与内核**逐条相等** | L2（vitest） | ✓ 12/12 |
| 真实会话改前改后对照 | **L3** | ✓ 见 §3 |
| 第 2 轮真实请求体含 12 条工具结果、0 孤儿 | **L4（真机 + 真 HTTP）** | ✓ 11/11 |
| Harbor-Dev 加载的是修复后的代码 | 哈希比对 | ✓ 12 个关键文件 + 191 个 assets 全一致 |

`npm run verify` 全链：typecheck 0 错 · lint 0 错 · 内核 lint 416 个 `.cjs` 干净 ·
内核类型 `66 个文件 156 条`与基线一致 · 格式 ✓ · 行数 1,519 文件全过 ·
规则检查通过 · 单测 **2,132 项** · 自检 **6,772 项 0 失败** · 安全 ✓ · 构建 ✓。

---

## 7. Harbor-Dev 同步状态

- 按安全流程**分步**同步，**没有**跑 `E:\Harbor-Dev\update-all.cmd` —— 那个脚本第 2 步是
  `taskkill /F /IM Harbor.exe`，会连你正在用的窗口一起杀掉（也包括我自己跑在里面的宿主进程）。
- 备份：`E:\Harbor-Dev\dist-portable\Harbor\resources\app.bak-20261107-015359`（20,987 个文件）。
- 同步方式：`robocopy <源产物> <dev>/resources/app /MIR`。
- 校验：12 个关键内核文件 + `package.json` + `build-info.json` 逐个 sha1 相等，
  `dist/assets` 191 个文件全部内容一致。
- **数据完好**：`E:\Harbor-Dev\dist-portable\Harbor\data` 仍是 7 个会话，两份 P0 样本都在。
- ⚠️ **需要你手动重启 Harbor-Dev 才会生效**：`resources\app` 换了，正在跑的是旧代码。
  我没有替你重启（那会中断你手上的活）。
- ⚠️ 一处**需要如实报告的副作用**：`/MIR` 把 dev 的 `resources\app` 里上次同步留下的几个
  旧 `.bak` 子目录（`electron.bak-20261104-2020`、`dist.bak-*` 等）删掉了 —— 它们在
  `resources\app` **里面**，不是 `data/`，也不是我这次新建的备份。备份本身（
  `resources\app.bak-20261107-015359`）在 `app` 之外，没受影响。
- 独立装机版 `E:\Harbor` **按你的要求没有更新**。

---

## 8. 遗留与下一步（不自动进入）

1. **摘要看不到诊断证据**（P0 病灶 ④）—— `compact.summarize` 仍只收正文。修它要动
   `compact-chunked` 的摘要格式，属于「改数据结构」量级，留 P2。
2. **模型没有任何工具能回读原始历史**（P0 病灶 ⑤）—— 这是「任务现场恢复」的核心缺口，
   需要新增工具 + 权限判定，属于 P2/P3。
3. **跨轮授权记录重启即清**（P0 已确认为符合预期的设计）—— 授权可以按指纹回指，
   但不能凭摘要重新授予写入权限。本轮没动。
4. **Provider 侧协议有效性只验到「构造出的请求体」** —— 没发真实推理请求。要真验需要
   一次真实调用，本轮按你的要求零费用，所以这条**明确标为未验证**。
5. **`deepseek-chat` 这个模型名今天是否仍有效** —— P0 就标了待验证，本轮仍未验证。
6. **`historyLimit` 的语义变了**（条数 → 轮次）：设置页那里的文案目前还是旧的
   （「保留多少条历史」），本轮没改界面文案 —— 改文案要动设置页，属于「顺手一提」，
   按规矩只报告不动手。**下一轮建议一并改**。

---

## 9. 与后续阶段的实际关系（不机械回避）

- 本轮修好「工具结果能进上下文」之后，**P2 的历史回取才有意义**：在那之前，即使加了
  「读会话」工具，读回来的内容也会在下一层被整组丢掉。
- 本轮**没有**扩容量。要扩（提高对话层占比 / 提高 `foldChars`）之前应该先看这份报告 §3 的
  数字：现在已经能用到 68.9%，再往上加要先确认模型真的能吃下，否则只是把浪费换成 400。
- `context-groups.cjs` 的 `selectMessages` 是**纯函数、无 IO**，P2 若要做「按相关性挑而不是
  只按新旧挑」，改这一个函数即可，不需要动 `assemble`。
