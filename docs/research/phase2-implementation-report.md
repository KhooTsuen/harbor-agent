# Harbor Agent UI Phase 2 · 实施与验收报告（右栏信息层级 · 方案甲）

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0 + Phase 2 任务书（批准方案甲 + 四条补充约束）
> 性质：**展示层改动**。未触碰 Runtime / IPC / 权限 / 事件契约 / 任务持久化 / 数据结构。
> 基线：HEAD `847cfc3`（main）。本轮改动**未提交**（见「六、交付状态」）。
> 前序：`harbor-ui-research-summary.md`（调研）、`phase0-real-task-report.md`（真机补测）、
> `phase1-implementation-report.md`（Phase 1）、`phase2-improvement-plan.md`（本阶段的设计说明）。

---

## 一、问题清单与证据

| # | 问题 | 证据（源码 / 真机） |
|---|---|---|
| C-1 | 右栏八个标签**同层同权重**，找高频入口与低频入口花的力气一样 | `RightTabs.tsx` 仅活动态加底色，非活动态一律等宽 |
| C-2 | 「需要注意 / 有内容」的状态散落在标签里、**不成体系** | Phase 1 前只有 `diff`/`browser`/`errors` 三种角标；任务 / 下载 / 成果**无任何提示** |
| C-3 | 三类「有内容」提示若与「未读错误」长得像，会把「有成果」误读成「出错了」 | 错误角标是**实心红/橙点**；若「有内容」也用实心/暖色系，语义混淆 |
| C-4 | 右栏**折叠 / 窄窗**时，除错误外的关键工作状态（在跑的任务、未提交改动）会丢 | 折叠后仅剩 `RightPanelHost` 一个 `‹` 按钮 |
| C-5 | 成果(artifact) 与 工作区改动(diff) 两条数据源，用户容易混 | Phase 0 UX-09：`write_file` 成功 → 「成果 · 0」，文件实际进了「审查」 |

**先核实的口径**（任务书要求「每项改动前先核实源码与状态来源」）：
- 角标数据全部来自**既有 store 的只读订阅**，不新增 IPC、不新增轮询（`useRightTabBadges` 无 `setInterval/setTimeout`，测试钉住）。
- 「成果」的「有内容」判断取自**当前会话内存里的产物**（零 IPC）；内核 `artifact:list` 仍是面板的真相源 —— 点只表达「可能有东西」，不作计数依据。

---

## 二、修改文件及具体原因

### 新增（3）

| 文件（完整路径） | 作用 |
|---|---|
| `E:\CodexWorkbench\src\components\layout\TabBadge.tsx` | **两类点的唯一真相源**：`ContentDot`（空心环 + 中性色）/ `UnreadDot`（实心 + 状态色）。形状与颜色都不同 |
| `E:\CodexWorkbench\src\hooks\useRightTabBadges.ts` | 角标数据（含顶栏兜底要的 `runningTasks`）——四个 store 的只读订阅，**无请求、无定时器**。右栏与顶栏**同源** |
| `E:\CodexWorkbench\src\components\layout\__tests__\phase2Display.test.ts` | 14 项接线守卫（分组顺序 / 形状分离 / 数据同源 / 兜底 / 互指落点） |

### 修改（4）

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `src\components\layout\RightTabs.tsx` | `TABS` 加 `group`；高频前置 + 分组发丝线；三类「有内容」用 `ContentDot`；未读错误用 `UnreadDot` | C-1 / C-2 / C-3 |
| `src\components\layout\RightPanel.tsx` | 角标统一从 `useRightTabBadges` 取（替换散落订阅）；透传三个新 props；「审查」区写互指文案 | C-2 / C-4 / C-5，并给贴线文件减负 |
| `src\components\layout\AppTitleBar.tsx` | 复用同一 hook；未读错误点**旁边**加「运行中任务数」「未提交改动数」；三项并进右栏按钮提示 | C-4（右栏折叠兜底） |
| `src\components\layout\__tests__\phase1Display.test.ts` | 两处断言**跟着代码搬到了 `TabBadge.tsx`** | 代码搬家，不是放松断言（详见 §四） |

### 未改（红线内）

`src/stores/**`（除只读订阅外无改动）、`electron/**`、`src/types/**`、任何 IPC / 事件契约 / 任务台账 / 权限模型 —— **一行未动**。

---

## 三、改动前后对照（真机 · 隔离假模型 + CDP）

> 命令：`node E:\CodexWorkbench\tmp\p2-run.mjs --scenario=tabs`（和 `=running`）。
> 环境：`dist-portable\Harbor` 隔离副本 + `tmp/p0-upstream.mjs` 假上游；跑完还原 config/credentials。
> 截图：`E:\CodexWorkbench\tmp\p0-shots\tabs-baseline.png` / `tabs-after.png` / `running-mid.png`。

| 项 | 改前（Phase 1 末） | 改后（本轮实测） |
|---|---|---|
| **C-1 标签顺序** | 审查·文件·浏览器·成果·任务·下载·状态·错误（功能序） | **`["审查","文件","任务","成果","浏览器","下载","状态","错误"]`**（高频前置，实测 DOM 顺序） |
| **C-1 分组线** | 无 | 标签栏内 **1 条**发丝分隔线（实测；其余 `w-px` 在别处，已把探针限定在标签栏内） |
| **C-2/C-3 任务角标** | 无 | 「任务」= **空心环**（`ring:true, solid:false`）—— 有未完成 / 在跑任务；不是错误色 |
| **C-3 形状分离** | —— | 空心环用 `border`（`--text-tertiary`）／未读错误用 `background`（P0/P1 色）；DOM 探针可判别 |
| **C-4 顶栏兜底** | 只有「未读严重错误」一个信号 | 写入文件后 → 顶栏按钮 = **`切换右侧面板（1 个文件未提交改动）`**；跑任务时 → **`切换右侧面板（1 个后台任务在运行 · 1 个文件未提交改动）`** |
| **C-5 互指** | 成果空态有「去审查」（Phase 1） | 「审查」区新增 **「这里列的是工作区里被改动的文件；Agent 的正式产出（artifact）在「成果」标签。」**（实测正文命中）；空态同句 |

---

## 四、测试命令与真实结果

| 命令 | 结果 |
|---|---|
| `npm run verify`（全链） | 退出码 **0** |
| `npm run test:unit` | **179 文件全绿**（Phase 1 是 178，+1 = `phase2Display.test.ts`） |
| `npm test`（内核自检） | **通过 4108 项 / 失败 0 项** |
| `npm run security` | **PASS 83 · FAIL 0 · BLOCKED 0 · N/A 1** |
| `node tools/line-limit.mjs --all` | **1103 文件全 ≤ 300 行** |
| `npm run check:rules` | **规范检查通过**（改了代码已写 CHANGELOG） |
| 真机 | `tmp/p2-run.mjs` 两个场景（`tabs` / `running`）跑通，数据见 §三 |

**行数自查（补充约束①：超 300 必须先拆）**：
| 文件 | 总行 | 代码行（去注释） |
|---|---|---|
| `RightPanel.tsx` | 287 | 198 |
| `RightTabs.tsx` | 183 | 113 |
| `AppTitleBar.tsx` | 250 | 166 |

均 < 300，**未触发强制拆分**；且 `RightPanel` 的代码行只有 198（注释占大头），未贴线。为防它继续涨，本轮把角标订阅**抽成了 hook**，净减少主文件职责。

**关于改动 Phase 1 测试（不是弱化断言）**：
Phase 2 把「两类点」的形状/颜色定义搬到了 `TabBadge.tsx`，于是 Phase 1 里「颜色表达式写在 `RightTabs.tsx`」这条**位置断言**失效。改法是**跟着代码走**：改钉 `TabBadge.tsx` 里的颜色表达式 + `RightTabs` 确实用了 `UnreadDot`，并**新增**「形状必须不同（`border` 空心环 vs 实心）」一条 —— 断言强度只增不减。

---

## 五、未解决问题及风险

1. **「运行中任务数」在一次对话进行中可能落后一拍**（**已实测，如实报告**）。
   台账刷新是**事件驱动**（`useBackendSubscriptions` 在「在跑计数变化 / 窗口可见」时刷，`TaskCenter` 挂载时刷）——遵守项目「空闲不轮询」原则。
   实测：流式中顶栏该计数**未亮**；但**流式中打开「任务」面板**（触发台账 refresh）后，顶栏**立即**变为「1 个后台任务在运行」。
   → 机制正确（数据 → badge → 顶栏已通）；差的是**触发时机**。
   **是否补一个「一轮开始时补一次台账刷新」的触发点**，属于刷新策略（非纯展示层），**待你批准**。
   注：当前这条对话**本身**「在跑」是由顶栏既有的活动指示（转圈 + 动作文案）实时表达的，不受此影响。
2. **错误未读点（实心）与「有内容」点（空心）未在同一张截图里同时出现**。分别各自实测到（实心点见 Phase 1 的 `errors` 场景，空心环见本轮 `tabs` 场景）；两者的形状/颜色差异由源码与 DOM 探针双重确认。
3. **窄窗口下标签栏裁切**：`RightTabs` 有横向滚动兜底，但**本轮未单独截图实测极窄宽度**，标 `NOT_TESTED`。
4. **Phase 0 遗留未测项照旧**：策略拒绝 vs 普通故障的区分（需改事件契约，禁改）、暂停/继续 —— 均与本轮改动无交集，仍 `NOT_TESTED`。
5. 真机用的是**假上游**：证明的是「store → badge → 角标/顶栏」这条真实链路，不是真实上游行为。

---

## 六、交付状态

- `git status`：13 个 M（12 `src/**` + `CHANGELOG.md`）+ 8 个新文件（`docs/research/` 目录 + 3 个 Phase 2 新文件 + Phase 1 的新文件）。
- HEAD 未变（`847cfc3`）；**未 commit、未 push**。
- **未执行 `npm run package`**：`scripts/build-portable.mjs` 会**无条件** `taskkill /F /IM Harbor.exe`，会杀掉你正在用的实例（含本对话宿主）。改用「只覆盖 `resources/app/dist`」的方式刷新便携副本。
- 用户实例未受影响：4 个 `Harbor.exe`（PID 12836 / 13360 / 6484 / 2472）全程存活；隔离副本 config 已还原、误建的空 `credentials.json` 已清理；无我的残留进程。

---

## 七、红线核对（任务书六 · 禁改项逐条）

| 禁改项 | 本轮 |
|---|---|
| Runtime / IPC / 权限模型 | 未动 |
| 事件契约 | 未动 |
| 任务持久化 / 数据库结构 | 未动 |
| 删除功能 / 诊断入口 | 未删（八个标签 + 全部面板挂载点在测试里钉住） |
| 弱化断言 | 未做（见 §四） |
| 二级菜单 / 隐藏必要操作 | 未用（八标签全在标签栏） |
| 没证据就宣称「验证通过」 | 未做（局限标 `NOT_TESTED` / 如实写刷新时机） |

---

## 八、下一阶段建议

**Phase 3（中央对话降噪，D 方向）** —— 本轮未动对话区。
Phase 0 已量化一条硬事实：**6 轮工具调用 = 6 行独立摘要，跨轮不聚合**。建议先：
1. 用假上游造「同类连续工具事件」的真实长任务，量化「工具行数 / 占屏比例 / 需要滚动多少才能找到结果」；
2. 再做**跨轮同类聚合**（纯展示层派生，不解析模型自然语言）；
3. 保留失败 / 权限 / 安全拦截的显著可见性（不因降噪被藏）。

**沿路可带的两个待批项**（都要你点头，因为触内核 / 类型 / 刷新策略）：
- **待批项 1**：内核在一轮结束时 `observer.flush()` —— 让 Phase 1 的错误角标「及时」亮（现状要等 15 秒定时或下一轮）。
- **待批项 2**：`ErrorEntry.firstSeen/lastSeen` 类型与真实数据对齐（现类型是 `number`，真实是 ISO 字符串）。
- **本报告新增待批项 3**：Phase 2 §五.1 的「一轮开始时补一次台账刷新」（让运行中任务数在轮内就准确）。
