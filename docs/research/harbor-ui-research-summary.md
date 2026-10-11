# Harbor UI 信息架构与工作台体验 · 调研总结

> 规范：《Harbor Agent UI 信息架构与工作台体验现状调研规范》v1.0
> 性质：**只读调研**。本轮**未修改**任何产品源码 / 样式 / Token / 文案 / Prompt / 配置 / Runtime / IPC / 数据结构 / 测试断言。
> 基线：HEAD `847cfc34ca62a74513a63c797822e6bedb9ae2f3`（main，工作区干净），v1.30.0-beta.16。
> 明细见同目录：`ui-baseline.md` / `ui-component-map.md` / `ui-event-trace.md` / `ui-noise-audit.md` / `ui-safety-visibility.md` / `ui-ux-golden-tasks.md` / `ui-design-system-audit.md` / `ui-questions-for-owner.md`。

---

## 1. 执行摘要（最关键的事实）

1. **三栏结构本身没问题**，问题在**同屏密度与主次**：默认界面 **57 个可见按钮 / 69 个图标**，右栏 8 个标签同层同权重（`ui-noise-audit.md` §1/§3）。
2. **字号体系与设计声明不符**：`design.ts` 声明三层（14/16/24）+ dense 例外，**实际用了 10 种**（12px×43、15px×39、13px×21、10/11/18/20px…），根因是 `tailwind.config.js` 两套 scale 并存（`ui-noise-audit.md` N-VS-01）。
3. **内部术语泄漏**：状态栏显示内核字段原值 `pair` / `high`（英文 key），而 UI 另有中文标签「标准」「高」（`StatusBar.tsx:74,76` vs `constants/index.ts:30-75`）。
4. **状态色与颜色 Token 做得好**：508 处 token 引用，硬编码集中在定义层；语义色唯一来源、有测试盯（`ui-design-system-audit.md` §2/§3）。
5. **事件链路统一且有防护**：单一 `chat:event` 通道 + 唯一事件契约 + 批处理保证顺序（`ui-event-trace.md` §1/§8）。
6. **任务「进度」没有百分比依据**：任务「步骤」来自**模型的 plan 块**，不是执行步骤（`task.cjs:153`）；展示的是相位 + 计数 + 真实耗时。
7. **「执行停止」与「完成」有区分，但「验证通过 / 交付可用」没有独立态**（`ui-event-trace.md` §6）。
8. **安全可见性总体到位**：授权不被遮罩、失败单独计数、部分完成有提示、全局脱敏；**唯一缺口**是右栏「错误」标签**无角标**（`ui-safety-visibility.md` §3）。
9. **滚动不会被新事件抢走**：显式 FOLLOW/FREE 状态机，FREE 用锚点位移补偿，末尾长高不推用户（`useAutoScroll.ts:20-27`）——**设计层已证，行为层未真机验证**。
10. **6/10 个 Golden Task 未观察**（`NOT_OBSERVED`）：预览版无真实后台任务，需真实版 + 隔离数据目录补测（`ui-ux-golden-tasks.md`）。

## 2. 当前界面架构与主要数据链路

架构图与逐区域明细见 `ui-component-map.md` §1/§2。要点：

- 顶栏（`AppTitleBar`）**横跨全窗**，不是分栏顶栏；左右下三区各包 `ErrorBoundary`（`App.tsx:211-291`）。
- 右栏八标签（`RightTabs.tsx:31-41`），只有当前标签显示文字。
- 数据链路：`loop.emit` → `chat-emit.cjs`（总线+指标+批处理）→ `chat:event` → `preload.onEvent` → `subscriptions.subscribeChatEvents` → `turns.ts`（按 requestId 过滤）→ `streamEvents.handleStreamEvent` → store → 组件（详见 `ui-event-trace.md` §2/§3）。

## 3. 已确认问题清单（按严重度）

| ID | 问题 | 严重度 | 类别 | 证据 | 状态 |
|---|---|---|---|---|---|
| I-01 | 右栏「错误」标签无角标（内核错误/安全阻断不易发现） | **P1** | 安全可见性 | `RightTabs.tsx:89-102` | Code-confirmed |
| I-02 | 任务「步骤数」来自模型计划而非执行 → 可能被误当进度 | **P1** | 信息架构/模型 | `task.cjs:153`；`task-context.cjs:247` | Code-confirmed |
| I-03 | 字号实际 10 种，与设计声明不符 | P2 | 视觉系统 | `ui-noise-audit.md` N-VS-01 | Observed |
| I-04 | 同屏 57 按钮无主次 | P2 | 信息架构 | 计数（`tmp/count-noise.mjs`） | Observed |
| I-05 | 内部术语泄漏（状态栏英文 key） | P2 | 信息架构 | `StatusBar.tsx:74,76` | Observed |
| I-06 | 19 处截断无 `title`（含顶栏标题） | P2 | 视觉系统 | 计数；`AppTitleBar.tsx:121-123` | Observed |
| I-07 | 缺「验证通过 / 交付可用」独立态 | P2 | 信息架构 | `ui-event-trace.md` §6 | Code-confirmed |
| I-08 | 「策略拒绝」与「普通故障」在 UI 上无区分 | P2 | 安全可见性 | `ui-safety-visibility.md` §4 | **Inferred（待验证）** |
| I-09 | 顶栏与右栏重复显示「+N −M」 | P3 | 信息架构 | `AppTitleBar.tsx:137-145`；`RightPanel.tsx:184-187` | Code-confirmed |
| I-10 | 模型/推理两处显示 | P3 | 信息架构 | `StatusBar.tsx:74-76`；`Composer.tsx:215-224` | Code-confirmed |
| I-11 | 右栏 8 标签同权重（高频/低频混排） | P2 | 信息架构 | `RightTabs.tsx:31-41` | Code-confirmed |

> 无 **P0**：授权、危险操作、失败、部分完成、脱敏均已有对应机制（见 `ui-safety-visibility.md` §1）。

## 4.「AI 风味」的成因（不做无依据量化）

| 归属 | 具体表现 | 证据 |
|---|---|---|
| **视觉** | 玻璃拟态（默认关）、启动页 ASCII 动画、脉冲圆点、闪烁光标、胶囊按钮（仅主 CTA） | `ui-design-system-audit.md` §8 |
| **信息架构** | 同屏按钮平铺、8 标签同权、过程信息入口多 | `ui-noise-audit.md` §1/§3 |
| **文案/拟人化** | 品牌「Harbor / 灯塔 / 夜航 / 航道畅通」彩蛋、启动页性格层、Toast 措辞 | `AppTitleBar.tsx:60-81`；`GlobalLayers.tsx:55-56` |
| **模型输出** | 回复夹带过程旁白（非 UI 可控） | `ui-noise-audit.md` N-MO-01 |

## 5. 现有能力可复用清单

| 能力 | 源文件 | 限制 |
|---|---|---|
| 事件契约 | `src/types/chat-events.ts` | 已是唯一真相源，扩展需同步内核 |
| 状态语言（唯一色/词表） | `src/lib/statusLanguage.ts` | 有测试盯，组件禁止自写语义色 |
| 设计 Token 三层 | `design.ts` → `index.css` → `tailwind.config.js` | **字号 scale 需先收敛** |
| 滚动状态机 | `src/hooks/useAutoScroll.ts` | 已足够稳定，行为层待验 |
| 任务台账 / 改动事务 / 成果 | `electron/core/task.cjs`；`TaskCenter.tsx`；`ArtifactsPanel` | 无「验证通过」态 |
| 授权两通道（内联/模态） | `PermissionBar.tsx`；`PermissionDialog.tsx` | 分工清晰，勿合并 |
| 全局脱敏 | `electron/core/redact.cjs` | 已修过一处破坏 JSON 的问题 |

## 6. 候选改进方向对照表（**仅比较，不实施**）

| 方向 | 收益 | 成本 | 风险 / 回归面 | 依赖 | 是否仅展示层 |
|---|---|---|---|---|---|
| **A. 状态栏术语本地化**（I-05） | 消除英文 key 与中文标签两套写法 | 低（1–2 文件） | 低（纯展示） | 无 | ✅ |
| **B. 右栏「错误」补角标**（I-01） | 补上安全可见性缺口 | 低（1 文件） | 低（纯展示） | 需要「未读错误数」来源（ErrorsPanel 已有数据） | ✅ |
| **C. 字号体系收敛**（I-03） | 统一层级、直接改善观感 | 中（跨多组件） | 中（视觉回归面广，需逐屏核对） | 先定夺用哪套 scale | ✅ |
| **D. 顶栏/右栏去重**（I-09） | 减重复 | 低 | 低 | 无 | ✅ |
| **E. 右栏标签分组/降权**（I-11） | 降噪、提主次 | 中 | 中（需保证授权/失败仍可见） | 无 | ✅ |
| **F. 新增「验证通过/交付完成」态**（I-07） | 完成度更可信 | **高** | **高（触内核台账）** | 需数据结构 + 迁移 | ❌ 触核心 |
| **G. 「策略拒绝」独立事件**（I-08） | 区分策略与故障 | **高** | 高（触内核/事件契约） | 需内核改动 | ❌ 触核心 |

## 7. 风险与回归影响

- **展示层改动（A/B/D/E）**：回归面小，但 E 必须复核**授权、危险操作、失败、阻断、恢复**仍可见（规范第 0 节第 6 条）。
- **字号收敛（C）**：跨组件视觉回归，需逐屏核对（登录/对话/设置/窄窗/亮色/150%）。
- **F/G**：触碰内核任务台账/事件契约 → 硬禁区（AGENT.md #11），**必须先回答「状态属于哪个实体」并同步迁移与测试**，本轮不提议实施。
- 任何改动都不得让**授权、失败、部分完成、安全阻断**降噪消失。

## 8. 未验证事项与阻塞原因

| 项 | 状态 | 原因 |
|---|---|---|
| UX-02/04/05/06/08/09 | `NOT_OBSERVED` | 预览版无真实后台任务；真实版含隐私且为本对话宿主 |
| 滚动不被抢占（行为层） | `NOT_TESTED` | 需真实流式工具事件 |
| 键盘 / 屏幕阅读器 / 对比度 / 150% 缩放 | `NOT_TESTED` | 未做无障碍实测 |
| 「策略拒绝」是否存在独立内核路径（I-08） | `Inferred` | 只读未跑内核；未确认 `risk.cjs`/`capability.cjs` 的拒绝返回形状 |
| 15px 字号来源 | `待验证` | 未定位到 token（可能在主题变量或组件硬编码） |

## 9. 推荐优先讨论的三个决策问题

1. **字号要不要收敛到一套（C）？** —— 收益最直接（观感），但需先定「用哪套 scale」。证据：实测 10 种字号 vs 声明 3 种。
2. **右栏信息架构要不要动（E + B）？** —— 8 标签同权 + 「错误」无角标是两个独立可小改的点；E 动阈值需用户拍板。
3. **要不要为「验证通过/交付可用」建独立状态（F）？** —— 收益大但**触内核**，需先定义实体与迁移；本轮不实施，列为决策项。

## 10. 附录

### 源码路径 / 行号索引
- 布局：`src/App.tsx:205-297`；顶栏 `src/components/layout/AppTitleBar.tsx`；左栏 `Sidebar.tsx`；右栏 `RightPanel.tsx` / `RightTabs.tsx:31-41`；底栏 `StatusBar.tsx`
- 消息：`MessageList.tsx`；`MessageItem.tsx:66-254`；`message/MessageRounds.tsx:56-116`；`ProcessBlocks.tsx:18-65`；`message/ToolLine.tsx:59-141`
- 输入：`Composer.tsx:65-259`；`composer/PlanBar.tsx`；`chat/AboveInputCards.tsx:25-59`
- 事件链路：`types/chat-events.ts:16-178`；`electron/core/chat-emit.cjs:23-47`；`electron/preload.cjs:6,243`；`src/lib/subscriptions.ts:12-15`；`src/stores/thread/turns.ts:246-259`；`streamEvents.ts:79-...`
- 状态语言：`src/lib/statusLanguage.ts:61-128`；相位 `src/lib/agentPhase.ts`
- 滚动：`src/hooks/useAutoScroll.ts:5-49`（状态机规则）
- 任务：`electron/core/task.cjs:153`（setPlan）；`chat/TaskCenter.tsx`；`electron/core/loop-result.cjs:21-65`
- 设计：`src/constants/design.ts`；`src/index.css:50-...`；`tailwind.config.js:106-119`

### 截图索引
- `shots/01..19-*.png`（常规场景，25 张）
- `shots/research-01..08-*.png`（任务/状态/错误面板、右栏关、窄窗口、等效 150%、侧栏折叠）
- 详见 `ui-baseline.md` §5

### 运行命令
```bash
npm run shot                  # → shots/01..19
node tmp/boot-shot.mjs        # 起 preview(4273) + chrome 再跑 shot
node tmp/shot-extra.mjs       # → shots/research-01..08
node tmp/count-noise.mjs      # 噪声指标计数
node tmp/audit-styles.mjs     # 硬编码样式统计
```

### 环境 / HEAD
- OS Windows 10.0.19045 x64 · i5-6400 4 核 · 16GB · 100% 缩放 · zh-CN
- HEAD `847cfc34ca62a74513a63c797822e6bedb9ae2f3` · main · 工作区干净 · v1.30.0-beta.16

### 文件变化 / 工作区状态
- **新增**：`docs/research/**`（9 份 Markdown）、`tmp/*.mjs`（4 个只读探针）、`shots/*.png`（截图）。
- **未修改**：任何 `src/**`、`electron/**`、测试、配置、Token（`git status` 中仅上述新增，产品代码零改动）。
- 未提交、未推送。
