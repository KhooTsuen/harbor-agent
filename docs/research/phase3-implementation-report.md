# Harbor Agent UI Phase 3 · 实施与验收报告

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0 + Phase 3 设计说明（`phase3-design.md`）+ 本轮任务书
> 性质：**展示层改动 + 一处 Prompt 文案**。未触碰 Runtime / IPC / 权限 / 事件契约 / 任务持久化 / 数据结构。
> 基线：HEAD `847cfc3`（main）。本轮改动**未提交**。
> 前序：`phase0-real-task-report.md`、`phase1-implementation-report.md`、`phase2-implementation-report.md`、`phase3-design.md`。

---

## 一、核心结论落实（逐条对账）

| 批准项 | 落实 |
|---|---|
| **Q1 选 B**：不引第三方库，先跑对拍量化缺口 | ✅ 新增 `gfm-cases.ts`（35 条样例）+ `gfm-gap.test.ts`；**未引任何依赖** |
| **Q3** 未闭合跨行块降级（流式纯文本，闭合升级） | ✅ `unclosed.ts` + `TailBlock`；真机验「收尾位移 0px」 |
| **Q4** `groupRounds()` 限一条消息内聚合，强制打断单测钉死 | ✅ `groupRounds.ts` + 11 条单测（含打断逐条） |
| **Q5** `NO_FILLER_RULE` + VERSION +1，保留「该解释的要解释」 | ✅ `prompt-rules.cjs` + `prompt-stack/4→/5` + 自检同步 |
| **M1 / M3** 只批准定位实测 | ✅ 已定位（下文 §5）；**未改内核** |
| **M2** 方向 (a)：error-reader 统一输出毫秒 + 查 CLI 兼容 | ✅ **实测发现方向已满足**（见 §5「更正」）；CLI 兼容已验 |

---

## 二、问题清单与证据

| # | 问题 | 证据 |
|---|---|---|
| P3-1 | 连续多轮同类工具各占一行摘要，把正文挤下去 | Phase 0 真机：6 轮 `read_file` → **6 行独立摘要**（本轮真机复现：改前 6 行） |
| P3-2 | 未闭合 `$$` 被「吃到末尾当公式块」，闭合时整段再吐一遍 | `blocks-special.ts:116-117` 的 `trySpecialBlock` 未闭合分支 |
| P3-3 | 自研 Markdown 与 CommonMark/GFM 的差距没有量化 | 无对拍脚本 |
| P3-4 | 模型爱写没价值的过渡语（「让我来看看」） | `conversationPolicy` 只有泛泛的「不使用无意义套话」，无针对**过渡语**的约束 |
| P3-5 | `&amp;` 这类实体原样露出（像 bug） | 对拍实测：`a&amp;b` → 文本 `a&amp;b`（未解码） |

**先核实的事实**（任务书要求「改动前先核实源码与状态来源」）：
- 流式链是**自研**的（`src/lib/markdown/*` 8 文件 + `src/lib/highlight/*` 10 文件），不是 react-markdown —— 这决定了 Q1 选 B。
- 未闭合块**永远留在尾巴**：`incremental.ts` 的 `findStablePoint` 在围栏内不产生切点 → 降级只影响尾巴，稳定块的引用不变策略天然不受影响。
- `ToolRunRecord` 的成败是**结构化字段**（`ok`），不是从自然语言猜的。

---

## 三、修改文件及具体原因

### 新增（6）

| 文件 | 作用 |
|---|---|
| `src/components/chat/message/groupRounds.ts` | 跨轮聚合**纯函数**：`groupRounds()` / `isFoldableRound()`。只吃单条消息的 `rounds` + `toolRuns`，不碰 Runtime |
| `src/lib/markdown/unclosed.ts` | `splitUnclosedBlock()`：找出尾巴里最后一个未闭合跨行块（围栏 / `$$`） |
| `src/lib/markdown/entities.ts` | `decodeEntities()`：HTML 实体解码（只解一次） |
| `src/components/chat/message/__tests__/groupRounds.test.ts` | 聚合 + **强制打断** 单测（11） |
| `src/lib/markdown/__tests__/unclosed.test.ts` | 未闭合降级单测（8） |
| `src/lib/markdown/__tests__/gfm-cases.ts` + `gfm-gap.test.ts` | 缺口对拍样例集 + 对拍（35 样例） |

### 修改（5，本轮相关）

| 文件 | 改了什么 |
|---|---|
| `src/components/chat/message/MessageRounds.tsx` | 渲染改为按 `groupRounds` 的结果；新增 `clarify` 入参 |
| `src/components/chat/MessageItem.tsx` | 透传 `clarify={Boolean(message.clarify)}` |
| `src/components/chat/markdown/StreamingMarkdown.tsx` | `TailBlock` 先过 `splitUnclosedBlock` 再渲染 |
| `src/lib/markdown/inline.ts` | text 节点生成处套 `decodeEntities`（**并因行数红线把实体表拆去 `entities.ts`**） |
| `electron/core/prompt-rules.cjs` / `prompt-stack.cjs` / `scripts/selftest/groups/93-machine-prompt.mjs` | `NO_FILLER_RULE` + VERSION `/5` + 自检断言同步 |

**行数红线**：`inline.ts` 加实体逻辑后一度到 **342 行**，随即拆出 `entities.ts`（`inline.ts` 回落到 276）。`unclosed.ts` 61 行、`groupRounds.ts` 123 行、`MessageRounds.tsx` 148 行 —— 全部 < 300。

---

## 四、改动前后对照（**真机**，隔离假模型 + CDP）

### P3-1 跨轮聚合（场景 `group`：6 轮 read_file，**第 3 轮故意失败**）

| | 改前（Phase 0 实测） | 改后（本轮实测） |
|---|---|---|
| 工具行数 | **6 行**独立摘要 | **3 行**：2 个聚合组 + 1 个失败轮 |
| 形态 | 每轮一行「读取 note-N.md」 | `r=0 span=2`「读取 2 个文件 · 2 步」；`r=2 span=null`「读取 missing-mix-3.md · **1 个失败**」；`r=3 span=3`「读取 3 个文件 · 3 步」 |

**关键**：失败那一轮（`r=2`）**没有被折进任何组**，单独成项 —— 强制打断生效（用户点名要求）。

### P3-2 未闭合跨行块（场景 `unclosed`）

| 时点 | katex | 上方锚点 offsetTop | 位移 |
|---|---|---|---|
| 未闭合 | **false**（纯文本，公式文字可见） | 2897 | — |
| 闭合后 | **true**（升级为 KaTeX） | 2897 | **0px** |
| 收尾后（切整篇解析） | true | 2897 | **0px（硬指标）** |

**防闪烁红线核对**：全程未动 `useSmoothText`（未被触碰）、`StableBlocks`（引用不变策略原样）、`parseIncremental`（未改）—— 降级只在 `TailBlock` 这一层做，稳定块数组的引用与 memo 行为完全不变。

### P3-3 缺口对拍

| 结论 | 内容 |
|---|---|
| 通过 | 34 / 35 样例符合规格（含表格、任务列表、嵌套列表、引用、围栏、行内各式、转义、裸 URL） |
| **补了 1 条** | `entity`（HTML 实体）—— 唯一「显示错误」类高频缺口 |
| **已知差异（5）** | `setext-h1`、`setext-h2`、`indented-code`、`link-relative`（**有意的安全策略**）、`autolink`（`<url>` 形式；裸 URL 已支持） |

对拍**把缺口钉成稳定集合**：补了要删、没补别悄悄多出来（测试会红）。

---

## 五、前置微任务定位实测（**只定位，未改内核**）

### M1 · `observer.flush()` 落点

- `error-observer.cjs` 的 `flush()` **已导出**（`module.exports = { record, flush, install, dispose, stats, recent }`），只是没人按轮调。
- 「一轮结束」的可挂点在 `electron/core/loop.cjs`：第 **241 / 274 / 290** 行的三处 `emit({type:'turn_end'})`，以及两处 `return`。
- ⚠️ **`loop.cjs` 在硬禁区 §3.8 名单里** → 落这里**触禁区**；`electron/handlers/chat.cjs:230` 的对话级 `type:'done'` **不在**名单 → 落那里不触。
- **结论**：落点未定，**不动**。等您拍板「落 `chat.cjs`（不触禁区）还是落 `loop.cjs`（触禁区、需另行报批）」。

### M2 · `firstSeen/lastSeen` 类型（**更正 Phase 1 报告**）

- **实测**（`tmp/p3-m2probe.cjs`）：`error-reader.cjs.read({dir})` 返回的 `ts / firstSeen / lastSeen / windowFrom` **全是 `number`（毫秒）**。
- 根因：`error-reader.cjs:59` 的 `parseLine` 里 `const ts = Date.parse(String(o.ts ?? ''))` —— 输出**一直是毫秒**。
- ⚠️ **Phase 1 报告里「真机数据里 `lastSeen` 是 ISO 字符串」这一条是错的**：当时看到的 ISO 串是 `data/errors/*.jsonl` **磁盘原始记录**的 `ts`，被我误当成 reader 的输出。**不偷偷改，在此更正。**
- CLI 兼容：`scripts/errors.mjs:74-75` 用 `new Date(e.firstSeen).toISOString()` —— 对毫秒与 ISO 串**都能吃**，无需改。
- **结论**：方向 (a) 的**目标已满足，无需改内核**；前端 `errorSignal.ts` 的兼容层保留为防御，注释已更正。

### M3 · 台账刷新滞后

- Phase 2 真机已证：**流式中**顶栏「运行中任务」不亮，**打开「任务」面板（手动 refresh）后立刻亮**。
- **结论**：台账**已写好**，是前端**「没触发」**（刷新只在运行时状态变化 / 窗口可见时跑），**不是内核写入滞后**。
- 补「一轮开始时补一次台账刷新」属**刷新策略**（非纯展示层），**未做**，列为待批项。

---

## 六、测试命令与真实结果

```
npm run verify           # 退出码 0
npx vitest run src/lib/markdown src/components/chat/... # 对拍 + 聚合 + 未闭合
node tmp/p3-run.mjs --scenario=group      # 真机：聚合
node tmp/p3-run.mjs --scenario=unclosed   # 真机：未闭合 + 收尾重排
```

| 项 | 结果 |
|---|---|
| `npm run verify` | **退出码 0**（typecheck / lint / lint:kernel / format / 行数 / rules / 单测 / 内核自检 / 安全 / 构建 全过） |
| 单测 | **182 文件 / 1625 用例全绿**（本轮 +3 文件 / +38 用例） |
| 内核自检 | **通过 4108 项，失败 0 项** |
| **提示词版本回归** | ✅「提示词版本已升到 /5（NO_FILLER_RULE）」、「工具清单还在（没被新层挤掉）」、「工具清单传下去了」——**11 项全绿** |
| 安全套件 | **PASS 83 · FAIL 0 · BLOCKED 0 · N/A 1 · NOT_RUN 0** |
| 行数红线 | **1110 个文件，无超 300 行** |
| lint | 1 warning（既有的 `useBootGate`，非本轮） |
| 构建 | `built in 4.98s` |

---

## 七、未解决问题与风险

1. **`autolink`（`<url>`）仍是缺口**：裸 URL（`https://x`）已自动链接，只有尖括号形式不支持。低频，记为已知差异。
2. **setext 标题 / 缩进代码块**：降级为段落，不显眼。低频，记为已知差异。
3. **收尾的「整篇解析」与流式渲染在「模型真的没闭合」时不一致**：闭合的情况下两者一致（实测位移 0px）；若模型从头到尾不闭合，收尾会按 CommonMark 渲染成块（一次性）。属病态输入，已记入设计说明。
4. **M1 / M3 待批**：均为刷新/落点策略，涉内核或刷新时机，**未做**。
5. **本轮未提交**：改动停在 working tree（见 §八）。
6. **真机用假上游**：证明的是「聚合 / 未闭合降级 / 角标」这些**真实链路**，不是真实上游行为。

---

## 八、交付状态

- `git status`：Phase 1/2/3 的改动**累积**在 working tree（`src/**` + `electron/core/prompt-rules.cjs` + `prompt-stack.cjs` + `scripts/selftest/groups/93-*.mjs` + `CHANGELOG.md` + 多个新文件）。HEAD 未变（`847cfc3`），**未 commit、未 push**。
- 用户实例未受影响：4 个 `Harbor.exe`（PID 12836/13360/6484/2472）全程存活；**未执行任何 `taskkill /IM`**；隔离副本 `config.json` / 空 `credentials.json` 已还原。
- 本轮真机截图：`tmp/p0-shots/group-*.png`、`unclosed-before/closed/after.png`（我看不到图，结论不依赖它）。

---

## 九、验收重点对照

| 验收点 | 本轮结果 |
|---|---|
| 是否减少无意义的日志阅读和滚动 | 连续工具轮**折成一行**（真机 6 行 → 3 行，失败单独）；展开仍是完整明细 |
| 是否保持安全性 / 功能完整性 / 任务可恢复性 | 未删任何功能与诊断入口；未触 Runtime/IPC/权限/台账；`verify` + 安全 + 自检全绿 |
| 不伪造 Runtime 状态 | 聚合只认 `ToolRunRecord.ok`（结构化），**不解析模型自然语言**；不新增百分比 / 完成声明 |
| 防闪烁（绝对红线） | `useSmoothText` / `StableBlocks` / `parseIncremental` **一字未动**；真机收尾位移 **0px** |

---

## 十、下一阶段建议（Phase 4）

- **视觉一致性**：字号收敛（Phase 0 实测 5+ 种未收敛）；窄窗口回归截图。
- **M1 / M3 若获批**：给「一轮开始」补台账刷新（属刷新策略）；`observer.flush()` 落 `chat.cjs`（不触禁区）。
- **其余 Markdown 缺口**：如遇真实反馈再评估是否补 autolink。
