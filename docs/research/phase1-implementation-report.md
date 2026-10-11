# Harbor Agent UI Phase 1 · 实施与验收报告

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0 + 本轮任务书（Phase 1）
> 性质：**展示层改动**。未触碰 Runtime / IPC / 权限 / 事件契约 / 任务持久化 / 数据结构。
> 基线：HEAD `847cfc3`（main）。本轮改动**未提交**（见「六、交付状态」）。
> 前序：`harbor-ui-research-summary.md`（现状调研）、`phase0-real-task-report.md`（真机补测）。

---

## 一、问题清单与证据

| # | 问题 | 证据（源码 / 真机） |
|---|---|---|
| A1 | 右栏「错误」标签**没有任何未读提示**，内核记了严重错误也不点出来 | `RightTabs.tsx` 只有 `diff`/`browser` 两种角标；`ErrorsPanel` 只在打开时拉一次 |
| A2 | 右栏**折叠 / 窄窗口**时，严重错误彻底不可见 | 折叠后只剩 `RightPanelHost` 一个 `‹` 按钮；标签栏无溢出滚动（窄时被裁） |
| A3 | 「打开错误面板」容易被理解成「问题已处理」 | 面板原文没有任何「只读 / 不置为已处理」的说明 |
| B3 | 「Agent 写成功文件，成果面板却显示 0」 | Phase 0 UX-09 实测：`write_file` 成功 → 「成果 · 0」；文件其实进了「审查」（`useTaskStore.diff`），与 `artifact:list` 是两条数据源 |
| B1 | 任务「步骤数」来自**模型写的计划**，读着像执行进度 | `taskCenterModel.ts` 的 `taskProgress` 数的是 `plan` 里 `[x]` 勾选；三处显示为「N/M 步」「已完成 N/M 步」「执行计划 · N/M 步」 |
| B2 | 同上，且**分母不可信** | 分母 = 模型给的计划条数，不是内核记的执行步数 |
| D | 状态栏直接显示内核字段原值 | `StatusBar.tsx` 渲染 `thread.mode`（`pair`）/ `thread.reasoning`（`high`），而界面别处是中文 |

**先核实的口径**（任务书要求）：
- `error:list` → 内核 `error-reader.cjs`，读 `data/errors/*.jsonl`，**只读**、按 `days`/`limit` 收敛；
  内核**没有**「有新错误」的推送事件（加推送 = 改 IPC 契约，本轮不做）。
- 成本：一天一个 jsonl、一天几行，读一次很轻 —— 但**不能轮询**，只能按事件触发（见三、）。
- `artifact:list`（正式成果）与 `useTaskStore.diff`（工作区改动）**是两条数据源**，本轮不合并。

---

## 二、修改文件及具体原因

### 新增（6）

| 文件 | 作用 |
|---|---|
| `src/lib/errorSignal.ts` | **纯函数**：什么算「严重」（P0/P1）、什么算「未读」（`lastSeen` 晚于已读线）、最严重一级。「严重/未读」的判据只有这一份，角标与面板共用 |
| `src/stores/useErrorsStore.ts` | 「错误」清单的**唯一**抓取入口 + 未读状态（`ackAt` / `unreadSevere` / `worstUnread`）。读失败不假装没有错误 |
| `src/hooks/useErrorSignal.ts` | 触发抓取：挂载 / `visibilitychange` / `focus` / 一轮跑完。**无定时器** |
| `src/lib/__tests__/errorSignal.test.ts` | 判据单测（含真机形状：ISO 字符串的时间戳） |
| `src/stores/__tests__/useErrorsStore.test.ts` | store 单测（首次不算未读 / 之后算 / acknowledge 只清未读 / 读失败不清） |
| `src/components/layout/__tests__/phase1Display.test.ts` | **接线守卫**（组件表、store 订阅、数据源只有一处、措辞不回流、无定时器、全部无百分比） |

### 修改（13）

| 文件 | 改了什么 |
|---|---|
| `layout/RightTabs.tsx` | 新增 `errorUnread` / `errorWorst` 两个 props；「错误」标签加未读点（颜色走 `colorOf`），数字进 `title`/`aria-label` |
| `layout/RightPanel.tsx` | 订阅 `useErrorsStore` 并把未读传给 `RightTabs`；**点开「错误」标签时 `acknowledge()`** |
| `layout/AppTitleBar.tsx` | 「切换右侧面板」按钮带**同一个**未读信号（右栏折叠/标签被裁时仍能发现）→ A2 |
| `layout/ErrorsPanel.tsx` | 抓取收敛到 store（不再自己 `listErrors`）；打开只 `acknowledge()`；面板里**写明「只清未读、不声称已处理」** |
| `hooks/useBackendSubscriptions.ts` | 调 `useErrorSignal()`（这里已是「按事件刷新」的集合点，且 `App.tsx` 贴着 300 行不再加东西） |
| `chat/ArtifactsPanel.tsx` | 空态改说「成果只放正式产出」；有改动时给「去『审查』看本次修改的 N 个文件」按钮；标题加说明 → B3 |
| `chat/taskCenterModel.ts` | 新增 `planProgressLabel()` —— 「计划 N/M 步」的**唯一**措辞 |
| `chat/TaskRow.tsx` | ` · 1/2 步` → ` · 计划 1/2 步` |
| `chat/PlanCard.tsx` | `执行计划 · 1/2 步` → `计划 1/2 步` |
| `chat/launch/ResumeCard.tsx` | `已完成 1/2 步` → `计划 1/2 步` |
| `chat/ProgressTimeline.tsx` | 模型计划那一段单独标 **「计划（模型给的 · 未执行）」**，与「执行进度」（真实相位 + 工具行）分开 → B1 |
| `layout/StatusBar.tsx` | `pair`/`high` → `modeMeta(mode).label` / `REASONING_LABEL[...]`（复用已有常量，不新建映射）→ D |
| `CHANGELOG.md` | `[未发布]` 段记账 |

**设计决策（3–5 句）**
1. **未读 ≠ 未解决**：角标只表达「自你上次看过之后新出现的严重错误」；`acknowledge()` 只推进「已读线」，
   不动错误数据、不做任何「已处理」标记 —— 面板只读且面板里把这句话写出来。
2. **数据只有一处**：角标和面板共用 `useErrorsStore`。面板原来自己抓一份，等于两套数据、两次读盘，
   迟早对不上（跨模块约定一处真相源）。
3. **判据只有一处**：`errorSignal.ts` 是「严重 / 未读」的唯一定义，三处显示（标签 / 顶栏 / 面板）都读它。
4. **不引入轮询**：没有推送事件可用，就按语义事件触发（挂载 / 窗口可见 / 获得焦点 / 一轮跑完）。
5. **不改台账、不猜进度**：`planProgressLabel` 只改措辞与位置，不碰 `task.plan` 与协议；
   全仓库**没有任何任务百分比**（新增测试守着）。

---

## 三、改动前后对照（真机 · 隔离假模型 + CDP）

方法：Phase 0 同一套隔离（`dist-portable/Harbor` + 独立 `data/`，跑完还原 config/credentials；
假上游 `tmp/p0-upstream.mjs`；驱动 `tmp/p1-run.mjs`；截图在 `tmp/p0-shots/`）。
**界面产物**用 `tmp/p1-sync-portable.mjs` 覆盖进副本 —— **没有**跑 `npm run package`
（它的 `killRunning()` 会 `taskkill /F /IM Harbor.exe`，会杀掉用户正在用的实例）。

### D 状态栏术语

| | 值 |
|---|---|
| 改前（Phase 0 记录） | `… pair deepseek-flash high …` |
| 改后（真机实测） | footer 文本 = `就绪标准deepseek-flash高我`；`含「标准」=真`、`仍显示 pair=假`、`含「高」=真`、`仍显示 high=假` |
| 截图 | `statusbar-artifacts.png` |

### B3 成果与文件修改

| | 值 |
|---|---|
| 改前（Phase 0 UX-09） | `成果 · 0` + 「完成带文件名的代码块后，成果会出现在这里。」（用户以为文件丢了） |
| 改后（真机实测） | 「「成果」只放正式产出：带文件名的代码块、内核登记的产物。普通的文件修改不算成果。」+「Agent 改过工作区文件的话，去「审查」标签看这次的改动。」（有改动时直接给按钮「去『审查』看本次修改的 N 个文件」） |
| 截图 | `statusbar-artifacts.png` |

### A1 / A2 错误未读角标（真实 401 → 内核记 P0 auth 错误）

| 步骤 | 观察 |
|---|---|
| 基线 | 「错误」标签 = `错误`；顶栏 = `切换右侧面板`；顶栏点 = `0` |
| 触发两轮真实失败（假上游返回 401，内核记 auth 错误） | 「错误」标签 = **`错误（1 条未读的严重错误）`**；顶栏 = **`切换右侧面板（1 条未读的严重错误）`**；顶栏点 = **`1`** |
| 点开「错误」标签 | 标签回到 `错误`（未读清零）；面板里**仍然列着** `P0 阻塞（必须人处理） 15 次 auth 上游返回 401…`；面板写明「打开这一页只清掉「未读」提示 —— 错误本身不会消失，也不会被标记为已处理」 |
| 截图 | `errors-before.png` / `errors-after.png` / `errors-opened.png` |

### B1 计划 vs 执行

| | 值 |
|---|---|
| 改后（真机实测，任务行） | `已完成 · 计划 1/2 步` |
| 改后（真机实测，计划卡） | `计划 1/2 步` |
| 改后（真机实测，时间线） | `执行进度` → `准备任务 / 分析任务 / 整理回答`（真实相位）；另起一段 **`计划（模型给的 · 未执行）` → `汇总成文`** |
| 改前 | `1/2 步` / `执行计划 · 1/2 步`；计划待办与执行行混在同一段里 |
| 任务行内百分比 | **无**（真机断言通过；全仓库任务组件断言无 `%`） |
| 截图 | `plan-plan.png` |

---

## 四、测试命令与真实结果

| 命令 | 结果 |
|---|---|
| `npm run verify`（链：typecheck → lint → lint:kernel → typecheck:kernel → check:format → check:lines → check:rules → test:rules → test:unit → npm test → security → build） | **真实退出码 0**（`VERIFY_OK`） |
| `npm run lint` | 0 error / 1 warning（`useBootGate.ts` 的**既有** warning，非本轮引入） |
| `npm run lint:kernel` | ✓ 268 个 `.cjs` 无未定义标识符 |
| `npm run typecheck:kernel` | ✓ 与基线一致（187 条，只许下调） |
| `npm run check:lines` | ✓ 1100 个文件无一超 300 行 |
| `npm run test:rules` | pass 56 · fail 0 |
| `npm run test:unit` | **178 文件 / 1587 用例全绿**（新增 3 个文件、+19 用例） |
| `npm test`（内核自检） | **通过 4108 项，失败 0 项** |
| `npm run security` | **PASS 83 · FAIL 0 · BLOCKED 0 · N/A 1 · NOT_RUN 0** |
| `npm run build` | ✓ built in 4.24s |

真机脚本：`tmp/p1-run.mjs --scenario=statusbar|errors|plan`（都跑通）。

---

## 五、未解决问题及风险

1. **`lastSeen` 类型与真实数据不符（真机抓到）** —— 类型声明 `number`，真实是 **ISO 字符串**。
   `errorSignal.ts` 已对两种形状兼容（并加了回归用例），但**类型/内核侧没动**
   （`src/types/errors.ts` 与 `error-reader.cjs` 的对齐属内核/类型侧改动 → 见待批项）。
   风险：其它按「数字」使用 `firstSeen/lastSeen` 的地方（如 `ErrorsPanel.fmtTime`、`formatEntryForCopy`
   里 `new Date(ts)`）**恰好都能吃字符串**，所以没暴露；但这是个真实的口径裂缝。
2. **角标有可感知时延** —— 错误观察哨**攒着 + 15 秒定时 flush**（`error-observer.cjs`），
   刚发生的错误十几秒后才落盘。角标会在**下一个触发点**（再跑一轮 / 切回窗口 / 重开应用）亮，
   不是「瞬间」亮。这**不是**本轮能在展示层解决的（要内核在一轮结束时 flush）。
3. **未验证场景明确标注**：
   - **策略拒绝 vs 普通故障的区分**：`NOT_TESTED`（需要内核在事件里带可判别标记 → 改事件契约，属禁改项）。
   - **暂停 / 继续（pause/resume）**：本轮**未单独复测**（Phase 0 验过「崩溃后恢复 / 任务切换」；
     本轮的四组改动与它无交集）。标 `NOT_TESTED`。
   - **窄窗口 / 极窄下的标签栏裁切行为**：只做了推理（A2 的动机），**未单独截图实测**，标 `NOT_TESTED`。
   - 真机对照用的是**假上游**（401 / plan 模式）：它证明的是「内核记录 → error:list → store → 角标」
     与「计划块 → 台账 → 展示」这两条**真实链路**，不是「真实上游的行为」。
4. **`tmp/` 下的调研/测试工具**（`p0-*`、`p1-*`）不进正式代码，可能被卫生清理回收。
5. **本轮未提交**：改动停在 working tree（见六）。

---

## 六、交付状态

- `git status`：13 个 M（12 个 `src/**` + `CHANGELOG.md`）+ 6 个新文件（5 个 `src/**` + `docs/research/` 目录）。
- HEAD 未变（`847cfc3`）；**未 commit、未 push**（等审阅）。
- 用户实例未受影响：4 个 `Harbor.exe` 全程存活；未执行任何 `taskkill /IM`；
  隔离副本的 `config.json` / `credentials.json` 已还原。

---

## 七、下一阶段建议

**Phase 2（建议：右侧工作区信息层级，C 方向）**
- 先出**两种轻量方案对照**（不改功能、不删入口），并说明现有操作路径受影响处。
- 可考虑：把「错误 / 任务」这类「需要注意」的入口给更高权重；「任务 / 文件 / 成果」的关系理清。

**Phase 3（中央对话降噪，D 方向）**
- 连续同类工具事件的聚合（Phase 0 实测：6 轮 → 6 行独立摘要，**跨轮不聚合**）——需先用真实长任务量化。

**沿路带上的两件（都要你点头，因为触内核 / 类型）**
- **待批项 1（小、收益直接）**：内核在**一轮结束时 `observer.flush()`** —— 让角标「及时」亮，
  而不是等 15 秒定时或退出。改动点在 `loop.cjs` / `chat.cjs` 一侧，属 **Runtime**。
- **待批项 2**：把 `ErrorEntry.firstSeen/lastSeen` 的类型与真实数据对齐
  （`src/types/errors.ts` → `number | string`，或让 `error-reader.cjs` 统一输出毫秒数）。
  涉及类型/内核，需先确认「哪个是标准」。

**Phase 4（视觉一致性与完整体验回归）**
- 字号收敛（Phase 0 实测 5+ 种未收敛）；长任务真机回归（含窄窗口截图）。

---

## 八、验收重点对照

| 验收点 | 本轮结果 |
|---|---|
| 用户能否迅速理解当前任务状态 | 任务行/计划卡/时间线分清「计划」与「执行」；状态栏不再露内部字段 |
| 是否更容易发现错误和授权请求 | 右栏「错误」有未读角标，**折叠/窄窗时顶栏也有同一信号**；授权条未被改动（仍不可遮） |
| 是否减少无意义的日志阅读 | 本轮未动对话区（属 Phase 3）；任务区把「计划」与「执行」分开，减少误读 |
| 是否更容易找到工作结果与产物 | 「成果」空态说清它是正式产出，并直接给「去审查看本次改动」的入口 |
| 是否保持安全性 / 功能完整性 / 可恢复性 | 未删任何功能与诊断入口；未触碰 Runtime/IPC/权限/台账；`verify` + 安全套件 + 内核自检全绿 |
